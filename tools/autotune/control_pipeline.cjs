'use strict';

// Aircraft-specific identification, firmware parity, and closed-loop search.
// An unvalidated twin is a diagnostic artifact, never an exportable gain set.
const ID = require('./system_id.cjs');
const plant = require('./helicopter_model.cjs');
const firmware = require('./firmware_controller.cjs');
const proposals = require('./control_tune.cjs');
const advice = require('./advice.cjs');
const filters = require('./filter_tune.cjs');
const sensor = require('./filter_replay.cjs');
const nativeSensor = require('./firmware_sensor.cjs');
const datasets = require('./datasets.cjs');
const AXES = ['roll', 'pitch', 'yaw'];
const RULES = Object.freeze({ controllerRelativeRmse:0.12, controllerAbsoluteRmse:0.008,
    baselineRelativeRmse:0.30, minImprovement:0.03, maxAxisRegression:0.02,
    maxRelativeStep:0.20, maxCandidates:60, warmupS:2, maxRate:2000, envelopeMargin:0.05,
    source:'Analysis check limits. These are not helicopter flight limits.' });
const finite = x => typeof x === 'number' && Number.isFinite(x);
const clone = x => JSON.parse(JSON.stringify(x, (k,v)=>ArrayBuffer.isView(v)?Array.from(v):v));
const average = x => x.length ? x.reduce((a,b)=>a+b,0)/x.length : null;
const stats = x => {const mean=average(x);return {mean,se:x.length>1?Math.sqrt(x.reduce((s,v)=>s+(v-mean)**2,0)/(x.length-1)/x.length):null,n:x.length};};
const digest = x => {let h=2166136261;const s=JSON.stringify(x);for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');};
const itemConfiguration = item => item.configuration || item.w&&item.w.recordedConfiguration&&item.w.recordedConfiguration.id;
function recordedStart(value){return typeof value==='string'&&/^(?!0000)\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;}
function mechanicalCohort(input){
    const declared=input.source&&input.source.files||[],groups=new Map(),items=input.items||[],keys=[];
    const add=source=>{const key=source.sha256?'sha256:'+source.sha256:'file:'+source.fileName;
        if(!groups.has(key))groups.set(key,{key,fileName:source.fileName,sha256:source.sha256||null,start:recordedStart(source.lastRecordedStart),items:[],source});return groups.get(key);};
    declared.forEach(add);
    items.forEach((item,index)=>{
        const w=item.w||{},flight=w.flight||{},log=(item.source&&item.source.logIndex)??w.recordedConfiguration?.interval?.log??flight.log;
        const matches=declared.filter(s=>Number.isInteger(log)&&Number.isInteger(s.logOffset)&&Number.isInteger(s.logs)&&log>=s.logOffset&&log<s.logOffset+s.logs);
        const source=item.source&&item.source.file|| (matches.length===1?matches[0]:declared.length===1?declared[0]:declared.length?null:
            {fileName:flight.file||input.fileName||'input',sha256:input.source&&input.source.sha256||null});
        if(!source){keys.push(null);return;}
        const group=add(source),stamp=recordedStart(flight.start);group.items.push(index);if(stamp!==null)group.start=group.start===null?stamp:Math.max(group.start,stamp);keys.push(group.key);
    });
    const explicit=input.options&&input.options.mechanicalCohort||input.options&&input.options.sysid&&input.options.sysid.mechanicalCohort,
        captureOrder=input.options&&input.options.sourceCaptureOrder;
    const list=[...groups.values()],selected=new Set(),reasons=[];let basis='single-source';
    if(explicit){
        basis='explicit-mechanical-cohort';const hashes=Array.isArray(explicit.sourceHashes)?explicit.sourceHashes:[];
        if(!hashes.length||hashes.some(hash=>!list.some(g=>g.sha256===hash)))reasons.push('unknown-explicit-source');
        else list.filter(g=>hashes.includes(g.sha256)).forEach(g=>selected.add(g.key));
    }else if(list.length===1)selected.add(list[0].key);
    else if(list.length>1){
        // Firmware calendar values are descriptive only. Acquisition order
        // must be explicitly supplied, never inferred from a log clock.
        basis='explicit-source-order';
        if(!Array.isArray(captureOrder)||captureOrder.length!==list.length||new Set(captureOrder).size!==list.length||
            captureOrder.some(hash=>!list.some(g=>g.sha256===hash)))reasons.push('source-order-unknown');
        else selected.add(list.find(g=>g.sha256===captureOrder[captureOrder.length-1]).key);
    }
    if(keys.some(k=>k===null))reasons.push('source-membership-unknown');
    if(reasons.length)selected.clear();
    return {basis,id:explicit&&explicit.id||[...selected].join('+'),selectedKeys:[...selected],itemSelected:keys.map(k=>selected.has(k)),reasons,
        sources:list.map(g=>({key:g.key,fileName:g.fileName,sha256:g.sha256,lastRecordedStart:g.start===null?null:new Date(g.start).toISOString(),
            selected:selected.has(g.key),items:g.items})),explicit:explicit?clone(explicit):null,captureOrder:Array.isArray(captureOrder)?captureOrder.slice():null};
}
function targetItems(input) {const id=input.configuration&&input.configuration.id,cohort=mechanicalCohort(input);return (input.items||[]).filter((item,i)=>cohort.itemSelected[i]&&item.w&&!item.w.skipped&&itemConfiguration(item)===id);}
function datasetFor(input,id) {
    return input.configuration&&input.configuration.id===id?input.configuration:
        ((input.analysis&&input.analysis.datasets&&input.analysis.datasets.datasets)||input.source&&input.source.configurations||[]).find(d=>d.id===id);
}
// A merged dataset describes equal values, not where each flight recorded them.
// Preserve the interval-level source before any synthetic header is constructed.
const GAIN_NAMES=AXES.flatMap(axis=>['p','i','d','f','b'].map(term=>axis+'_'+term+'_gain')).concat(['roll_o_gain','pitch_o_gain']);
function sourceIdentity(input,item) {
    const w=item.w||{},files=input.source&&input.source.files||[],log=(item.source&&item.source.logIndex)??w.recordedConfiguration?.interval?.log??w.flight?.log,
        matches=files.filter(file=>Number.isInteger(log)&&Number.isInteger(file.logOffset)&&log>=file.logOffset&&log<file.logOffset+file.logs),
        file=item.source&&item.source.file||(matches.length===1?matches[0]:files.length===1?files[0]:null);
    return {sha256:file&&file.sha256,localLogIndex:(item.source&&item.source.localLogIndex)??(file&&Number.isInteger(file.logOffset)?log-file.logOffset:null)};
}
function continuityAssertion(input,item) {
    if(!input)return null;const identity=sourceIdentity(input,item),assertions=input.options&&input.options.parameterContinuity;
    if(!/^[a-f0-9]{64}$/i.test(identity.sha256||'')||!Number.isInteger(identity.localLogIndex))return null;
    return (Array.isArray(assertions)?assertions:[]).find(a=>a&&a.scope==='parameters'&&a.basis==='user-assertion'&&
        a.sourceSha256===identity.sha256&&typeof a.statement==='string'&&a.statement.trim()&&Array.isArray(a.localLogIndexes)&&
        a.localLogIndexes.every(i=>Number.isInteger(i)&&i>=0)&&a.localLogIndexes.includes(identity.localLogIndex))||null;
}
function recordedGainEvidence(item={},input) {
    const w=item.w||{},record=w.recordedConfiguration||{},interval=record.interval,
        raw=w.originalHeader,header=raw?firmware.fromHeader(raw):null,values={},sources={},reasons=[];
    if(!raw||!interval)reasons.push('The log header or configuration interval is missing.');
    if(!interval||!interval.source||interval.source.profile!=='header'||interval.assumed||record.assumed)
        reasons.push('The log does not record the PID gains for this configuration interval.');
    const missing=GAIN_NAMES.filter(name=>!header||!finite(header.values[name]));
    if(missing.length)reasons.push('The log header does not record all PID gains.');
    const mismatched=[];
    for(const name of GAIN_NAMES)if(header&&finite(header.values[name])) {
        values[name]=header.values[name];sources[name]='original log header';
        if(record.values&&finite(record.values[name])&&record.values[name]!==values[name])mismatched.push(name);
    }
    if(mismatched.length)reasons.push('The configuration gains do not agree with the log header.');
    const result={known:reasons.length===0,values,sources,missing,mismatched,reasons,
        profileSource:interval&&interval.source&&interval.source.profile||'unknown',interval:interval||null,
        scope:'P, I, D, F, B and cyclic O gains only; other flight controller parameters require their own source checks'};
    const assertion=continuityAssertion(input,item);if(!assertion)return result;
    const profile=record.profile||item.profile,donors=[],seen=new Set(),globalHeaders=[];
    for(const candidate of input.items||[]) {
        if(continuityAssertion(input,candidate)!==assertion)continue;
        if(candidate.w&&candidate.w.originalHeader)globalHeaders.push(firmware.fromHeader(candidate.w.originalHeader).values);
        if((candidate.w&&candidate.w.recordedConfiguration||{}).profile!==profile)continue;
        const evidence=recordedGainEvidence(candidate),identity=sourceIdentity(input,candidate);
        if(!evidence.known||seen.has(identity.localLogIndex))continue;
        seen.add(identity.localLogIndex);donors.push({item:candidate,evidence,identity});
    }
    if(!donors.length)return {...result,continuity:{assertion:clone(assertion),donors:[],applied:false}};
    const donor=donors[0],conflicts=GAIN_NAMES.filter(name=>donors.some(d=>d.evidence.values[name]!==donor.evidence.values[name]));
    const provenance={assertion:clone(assertion),donors:donors.map(d=>({sourceSha256:d.identity.sha256,localLogIndex:d.identity.localLogIndex,
        profile,configuration:itemConfiguration(d.item)})),applied:conflicts.length===0,conflicts};
    if(conflicts.length)return {...result,known:false,continuity:provenance,reasons:[...result.reasons,'The recorded gains are different in the selected log group.']};
    const combine=(headers,profileScope)=>{const values={},conflicts=[];
        for(const field of firmware.SCHEMA){if((datasets.classify(field.name).scope==='profile')!==profileScope)continue;
            const observed=headers.map(h=>h[field.name]).filter(finite);if(!observed.length)continue;
            if(observed.some(value=>value!==observed[0]))conflicts.push(field.name);else values[field.name]=observed[0];}
        return {values,conflicts};};
    const profileHeader=combine(donors.map(d=>firmware.fromHeader(d.item.w.originalHeader).values),true),globalHeader=combine(globalHeaders,false);
    return {...result,known:true,values:{...donor.evidence.values},sources:Object.fromEntries(GAIN_NAMES.map(name=>[name,'original log header with user-confirmed parameter continuity'])),
        missing:[],mismatched:[],declaredMismatched:GAIN_NAMES.filter(name=>finite(record.values&&record.values[name])&&record.values[name]!==donor.evidence.values[name]),
        reasons:[],profileSource:'header-with-user-continuity',continuity:provenance,profileValues:profileHeader.values,globalValues:globalHeader.values,
        parameterConflicts:profileHeader.conflicts.concat(globalHeader.conflicts)};
}
function gainEpochReasons(epoch,continuity=false) {
    if(!epoch)return ['missing-parameter-epoch'];
    // A rate-profile switch alone cannot invalidate recorded PID gains; its
    // resulting setpoint is a measured input at this execution boundary.
    return (epoch.reasons||[]).filter(reason=>!(reason==='switched'&&epoch.source&&epoch.source.pid==='header')&&
        !(continuity&&['rearm','resume','switched'].includes(reason)));
}
function recordedGainMask(item,input) {
    const w=item.w||{},evidence=recordedGainEvidence(item,input),n=w.n||0,base=item.mask||item.ctx&&(item.ctx.eligible||item.ctx.flying)||w.filterMask,
        epochs=(item.epochs||[]).slice().sort((a,b)=>a.t0-b.t0),rate=item.ctx&&item.ctx.rate||w.flight&&w.flight.actualRate||w.rate,
        time=w.extra&&w.extra.time,mask=new Uint8Array(n),excluded=[],counts={input:n,flight:0,known:0};
    let epochIndex=0,currentReason=null,from=0;
    const at=i=>(w.fromS||0)+(time&&time.length?((i<n?time[i]:time[n-1]+1e6/rate)-time[0])/1e6:i/rate);
    for(let i=0;i<n;i++) {
        const t=at(i);while(epochIndex<epochs.length&&epochs[epochIndex].t1<=t)epochIndex++;
        const epoch=epochs[epochIndex],epochAt=epoch&&epoch.t0<=t&&epoch.t1>t?epoch:null;
        const stale=gainEpochReasons(epochAt,evidence.continuity&&evidence.continuity.applied),active=!!(base&&base[i]);
        if(active)counts.flight++;
        const reason=!active?'outside-eligible-flight':!evidence.known?'unrecorded-pid-gains':stale.length?'unconfirmed-parameter-epoch':null;
        if(!reason){mask[i]=1;counts.known++;}
        if(reason!==currentReason){if(i>from&&currentReason&&currentReason!=='outside-eligible-flight')excluded.push({fromS:at(from),toS:at(i),samples:i-from,reason:currentReason});from=i;currentReason=reason;}
    }
    if(n>from&&currentReason&&currentReason!=='outside-eligible-flight')excluded.push({fromS:at(from),toS:at(n),samples:n-from,reason:currentReason});
    return {mask,evidence,counts,excluded};
}
function prepareIdentificationInputs(input) {
    const cohort=mechanicalCohort(input),requireKnownGains=!(input.options&&input.options.sysid&&input.options.sysid.requireKnownGains===false),
        reports=[],items=(input.items||[]).map((item,index)=>{
        const check=recordedGainMask(item,input),w=item.w||{};
        const sourceSelected=cohort.itemSelected[index];
        if(!sourceSelected){check.mask.fill(0);check.counts.known=0;check.excluded.push({fromS:w.fromS,toS:(w.fromS||0)+(w.n||0)/(item.ctx&&item.ctx.rate||w.flight&&w.flight.actualRate||w.rate||1),samples:w.n||0,reason:'different-mechanical-cohort'});}
        reports.push({item:index,configuration:itemConfiguration(item),flight:w.flight&&w.flight.id,log:w.flight&&w.flight.log,
            fromS:w.fromS,sourceSelected,...check.counts,evidence:check.evidence,excluded:check.excluded});
        const selectedMask=!requireKnownGains&&sourceSelected?Uint8Array.from(item.mask||item.ctx&&(item.ctx.eligible||item.ctx.flying)||w.filterMask||new Uint8Array(w.n||0)):check.mask;
        const gainEvidence={...check.evidence,headerCandidateKnown:check.evidence.known,strictMaskApplied:requireKnownGains,
            known:check.evidence.known&&(requireKnownGains||check.counts.known===check.counts.flight),epochKnownSamples:check.counts.known,flightSamples:check.counts.flight};
        return {...item,mask:selectedMask,gainEvidence,mechanicalCohort:cohort.id,ctx:{...(item.ctx||{}),eligible:selectedMask}};
    });
    return {items,coverage:{basis:'original-header-gains-and-parameter-epochs',required:GAIN_NAMES.slice(),intervals:reports,
        mechanicalCohort:cohort,requireKnownGains,conditionalPlantOnly:!requireKnownGains,
        selectedSamples:items.reduce((sum,item)=>sum+item.mask.reduce((n,v)=>n+(v?1:0),0),0),
        inputSamples:reports.reduce((s,r)=>s+r.input,0),flightSamples:reports.reduce((s,r)=>s+r.flight,0),knownGainSamples:reports.reduce((s,r)=>s+r.known,0)}};
}
function targetConfig(input,periods,d=input.configuration||{}) {
    const selected=periods&&periods.length?[...new Set(periods.map(s=>contextFor(input,s).item))]:targetItems({...input,configuration:d});
    const first=selected[0];if(!first)return null;
    const original=first.w.originalHeader||first.w.flight.header, recordedHeader={...original};
    for(const name of Object.keys(recordedHeader))if(datasets.classify(name).scope==='profile'&&!Object.prototype.hasOwnProperty.call(d.values||{},name))recordedHeader[name]=null;
    const header=datasets.configurationHeader(recordedHeader,d);
    const stale=selected.flatMap(item=>{const known=recordedGainEvidence(item,input),confirmed=known.continuity&&known.continuity.applied;
        return (item.stale||[]).filter(span=>gainEpochReasons(span,confirmed).length&&(!periods||periods.some(s=>contextFor(input,s).item===item&&
            (!finite(span.t0)||!finite(span.t1)||span.t0<s.fromS+s.n/s.rate&&span.t1>s.fromS))));});
    const result=firmware.fromHeader(header,d.values||{},{profile:d.pidProfile,valueSources:d.sources,stale:stale.length?stale:null});
    if(first.w.originalHeader) {
        const raw=firmware.fromHeader(original),known=recordedGainEvidence(first,input);
        result.intervalProvenance=known;
        const confirmed=known.continuity&&known.continuity.applied,profileRecorded=confirmed||known.profileSource==='header'&&!(known.interval&&known.interval.assumed);
        for(const name of new Set(Object.keys(result.values).concat(confirmed?Object.keys(known.profileValues).concat(Object.keys(known.globalValues)):[]))) {
            const isProfile=datasets.classify(name).scope==='profile',recorded=confirmed?(isProfile?known.profileValues:known.globalValues):raw.values;
            if(finite(recorded[name])&&(!isProfile||profileRecorded)) {
                result.values[name]=recorded[name];result.sources[name]=confirmed?'original log header with user-confirmed parameter continuity':'original log header';
                result.unknown=result.unknown.filter(value=>value!==name);
            } else if(name!=='yaw_o_gain') {
                if(!result.unknown.includes(name))result.unknown.push(name);
                result.sources[name]='unverified historical '+(result.sources[name]||'configuration');
            }
        }
        result.assumptions=result.unknown.map(name=>({name,value:result.values[name]===undefined?firmware.defaults()[name]:result.values[name],source:result.sources[name]||'unverified release default'}));
    }
    return result;
}

function fitInput(input) {
    const first=(input.items||[]).find(i=>i.w&&!i.w.skipped), name=input.options&&input.options.craft || first&&first.w.flight.craft || input.fileName || '';
    return {segments:prepareIdentificationInputs(input).items,craft:name,options:Object.assign({},input.options&&input.options.sysid||{}, {keepSegments:true,predictions:true})};
}
function makeTwin(input, fit) {
    const source=input.source||{}, first=targetItems(input)[0]||(input.items||[]).find(i=>i.w&&!i.w.skipped);
    const controller=targetConfig(input), collectiveField=fit.model&&fit.model.collectiveField||'setpoint[3]',gainCoverage=prepareIdentificationInputs(input).coverage;
    const controlReasons=[...(fit.controlReasons||[]),...(gainCoverage.conditionalPlantOnly?['Recorded PID gains are not necessary for this model fit. Control changes are not available.']:[])];
    const modelCopy=model=>{if(!model)return null;const copy=clone(model);
        if(gainCoverage.conditionalPlantOnly)copy.validation={...(copy.validation||{}),controlEligible:false,
            controlReasons:[...new Set([...(copy.validation&&copy.validation.controlReasons||[]),...controlReasons])]};return copy;};
    const twin={schema:'rotorflight-digital-twin',version:1,status:fit.status,craft:fit.model&&fit.model.prior||plant.craftPrior(fitInput(input).craft),
        model:modelCopy(fit.model),ensemble:(fit.ensemble||[]).map(modelCopy),validation:fit.validation||null,coverage:fit.coverage||null,confidence:fit.confidence||null,
        reasons:fit.reasons||[],source:{...clone(source),mechanicalCohort:mechanicalCohort(input),requireKnownGains:gainCoverage.requireKnownGains,
            parameterContinuity:clone(input.options&&input.options.parameterContinuity||[])},
        mechanicalCohort:mechanicalCohort(input),recordedGains:gainCoverage,firmware:first?first.w.flight.firmware:null,
        channels:{inputs:['mixer[0]','mixer[1]','mixer[2]','headspeed',collectiveField],
            outputs:fit.model?[0,1,2].map(a=>`${fit.model.output}[${a}]`):[],
            exogenous:['headspeed',collectiveField],unmodeled:['translational acceleration','position','motor and battery dynamics','servo motor dynamics']},
        predictions:fit.predictions||[],controlEligible:!!fit.controlEligible&&!gainCoverage.conditionalPlantOnly,
        controlReasons,
        controller,pitchLimits:firmware.pitchLimits(controller||{}),
        controllerRuntime:firmware.CAPABILITIES,sensorRuntime:{engine:'upstream-c-wasm',artifactSha256:nativeSensor.ARTIFACT,sourceRevision:nativeSensor.COMMIT},verifiedInFlight:false};
    twin.id=digest({model:twin.model,source:twin.source,validation:twin.validation});
    return twin;
}
function identify(input, hooks={}) {
    if(hooks.progress)hooks.progress('The app fits the helicopter model to selected flight data.');
    const fit=ID.fit(fitInput(input)), twin=makeTwin(input,fit);
    twin.coverage=twin.coverage||{};
    twin.coverage.decodeExcluded=input.excluded||[];
    return twin;
}
function validateTwin(twin) {
    const errors=[];
    if(!twin||twin.schema!=='rotorflight-digital-twin'||twin.version!==1)return ['The app cannot read this helicopter model file type.'];
    errors.push(...plant.validateModel(twin.model));
    if(!twin.source||!twin.source.configuration)errors.push('The model has no recorded configuration.');
    if(twin.source&&twin.source.requireKnownGains===false&&(twin.controlEligible!==false||
        [twin.model,...(twin.ensemble||[])].some(model=>model&&model.validation&&model.validation.controlEligible!==false)))
        errors.push('This model cannot give control changes without recorded PID gains.');
    if(twin.id!==digest({model:twin.model,source:twin.source,validation:twin.validation}))errors.push('The model data changed after its checks.');
    return errors;
}
function replayTwin(twin, segments) {
    const reasons=validateTwin(twin);if(reasons.length)throw new Error(reasons.join(' '));
    return segments.map(s=>({id:s.id,flight:s.flight,fromS:s.fromS,rate:s.rate,
        predicted:plant.rollout(twin.model,s),recorded:s.y,extrapolated:outside(twin.model,s)}));
}
function outside(model, segment) {
    const env=model.envelope;
    if(!env)return null;
    const beyond=(column,range)=>range&&column&&column.some(x=>!finite(x)||!inRange(x,range));
    return !!(beyond(segment.hs,env.rpm)||beyond(segment.coll,env.collective)||
        (segment.u||[]).some((column,a)=>beyond(column,env.input&&env.input[a]))||
        (segment.y||[]).some((column,a)=>beyond(column,env.bodyRate&&env.bodyRate[a])));
}
function inRange(value,range) {
    // Two float32 rounding units permit constant recorded inputs to round
    // through the C runtime without expanding the physical input range.
    const margin=(range[1]-range[0])*RULES.envelopeMargin+2e-7*Math.max(1,Math.abs(range[0]),Math.abs(range[1]));
    return value>=range[0]-margin&&value<=range[1]+margin;
}

function contextFor(input, segment) {
    const ref=segment.source||{}, item=(input.items||[])[ref.item||0];
    if(!item)throw new Error('The model period has no recorded input.');
    return {w:item.w,offset:ref.start||0,item};
}
function sampleAt(input,segment,i,gyro,previous,config={}) {
    const {w,offset}=contextFor(input,segment), k=offset+i;
    const v=config.values||input.configuration.values||{},x=w.extra||{},state=w.govStateAt?w.govStateAt[k]:null;
    const throttle=x['motor[0]']?x['motor[0]'][k]*.001:0;
    const spoolUpRatio=state===4||state===6||state===9?1:state===0||state===1||state===5||state===7?0:1;
    const spooledUp=state===4||state===7||state===8||state===9?true:state===2||state===3||state===6||state===null&&[0,1].includes(v.gov_mode)?throttle>.333:state===0||state===1||state===5?false:true;
    const rc=[0,1,2,3].map(a=>x[`rcCommand[${a}]`]);
    return {setpoint:w.sp.map(v=>v[k]),gyro,collective:w.coll[k]*0.001,headspeed:w.hs[k],
        throttle,rcDeflection:rc.every(Boolean)?rc.map(column=>column[k]/500):undefined,
        airborne:w.airborneAt?!!w.airborneAt[k]:true,spooledUp,spoolUpRatio,ttaIncrease:0,
        saturation:[0,0,0],
        previousMixer:previous?w.u.map(v=>v[Math.max(0,k-1)]).concat(x['mixer[3]']?x['mixer[3]'][Math.max(0,k-1)]*.001:w.coll[Math.max(0,k-1)]*.001):undefined};
}
function controllerInputs(input,segment,config) {
    const {w,offset,item}=contextFor(input,segment),x=w.extra||{},v=config.values||{},reasons=[],sources={
        setpoint:'setpoint[0..2]',gyro:'gyroADC[0..2]',headspeed:'headspeed',collective:'setpoint[3]',
        previousMixer:'mixer[0..3]',throttle:x['motor[0]']?'motor[0]':'inactive variable-pitch-tail path',
        rcDeflection:[0,1,2,3].every(a=>x[`rcCommand[${a}]`])?'rcCommand[0..3] / 500':'unused: custom mixer rules and governor execution disabled',
        airborne:item.ctx&&item.ctx.airborneEvents?'AIRBORNE_STATE events':'flight-phase estimate',
        spoolState:w.govStateAt?'GOVERNOR_STATE events':'unknown',ttaIncrease:'inactive collective TTA path'};
    const gains=recordedGainMask(item,input);
    if(!gains.evidence.known||gains.mask.subarray(offset,offset+segment.n).some(value=>!value))reasons.push('The recorded PID gains for this flight period are not known.');
    const integral=AXES.some(a=>(v[a+'_i_gain']||0)>0||(v[a+'_o_gain']||0)>0);
    if(integral&&v.error_decay_time_ground!==0&&!(item.ctx&&item.ctx.airborneEvents))reasons.push('The log does not record the airborne condition for the flight controller error decrease.');
    if(!x['mixer[3]']&&(v.roll_o_gain>0||v.pitch_o_gain>0||v.pitch_collective_ff_gain>0||v.yaw_collective_ff_gain>0))reasons.push('The log does not record the collective mixer output necessary for compensation.');
    if(v.swash_tta_precomp!==0&&v.gov_tta_gain!==0)reasons.push('The collective compensation input is unknown.');
    const needsSpool=v.yaw_cyclic_ff_gain>0||v.yaw_collective_ff_gain>0||v.yaw_inertia_precomp_gain>0||v.yaw_i_gain>0;
    if(needsSpool&&!w.govStateAt&&![0,1].includes(v.gov_mode))reasons.push('The log does not record the governor condition necessary for the flight controller.');
    if(needsSpool&&w.govStateAt&&Array.from(w.govStateAt.subarray(offset,offset+segment.n)).some(s=>[2,3,8].includes(s)))reasons.push('The spool-up ratio is necessary when the governor condition changes. The log does not record this ratio.');
    if(integral) {
        let nearLimit=false;
        for(let i=Math.max(0,offset-5);i<offset+segment.n&&!nearLimit;i++) {
            const u=w.u.map(c=>c[i]);
            nearLimit=u.some((value,a)=>{const prefix='mixer_'+['sr','sp','sy'][a]+'_';return finite(v[prefix+'min'])&&value<=v[prefix+'min']*.001+.0015||finite(v[prefix+'max'])&&value>=v[prefix+'max']*.001-.0015;});
            if(!nearLimit&&v.swash_ring>0) {
                const ring=1.4142135623-v.swash_ring*.004142135623;
                const r=u[0]/(Math.max(10,Math.abs(v['mixer_sr_'+(u[0]<0?'min':'max')]))*.001*ring),p=u[1]/(Math.max(10,Math.abs(v['mixer_sp_'+(u[1]<0?'min':'max')]))*.001*ring);
                nearLimit=Math.hypot(r,p)>=.998;
            }
            if(!nearLimit&&v.swash_pitch_limit>0&&x['mixer[3]'])nearLimit=Math.hypot(u[0],u[1])+Math.abs(x['mixer[3]'][i]*.001)>=v.swash_pitch_limit*.001-.0015;
        }
        if(nearLimit)reasons.push('The recorded output limit does not identify the flight controller saturation memory.');
    }
    return {pass:reasons.length===0,reasons,sources,recordedGains:gains.evidence,boundaries:['The gyro sensor filter uses the firmware code.',config.servos?'The flight controller code includes the servo output limits.':'The flight controller code does not include servo saturation.']};
}
function errorsOf(actual,predicted,start=0) {
    return actual.map((column,a)=>{let e=0,y=0,n=0;for(let i=start;i<column.length;i++){
        if(!finite(predicted[a][i]))return {rmse:Infinity,relative:Infinity};
        e+=(actual[a][i]-predicted[a][i])**2;y+=actual[a][i]**2;n++;
    }return {rmse:Math.sqrt(e/Math.max(1,n)),relative:Math.sqrt(e/Math.max(1e-12,y)),n};});
}
function controlBand(columns,rate,hz) {
    const filter=ID.analysisFilter(rate,hz,columns.map(x=>x[0]));
    return columns.map((column,axis)=>Float64Array.from(column,value=>filter(axis,value)));
}
function seedController(runtime,input,segment) {
    const {w,offset}=contextFor(input,segment),v=runtime.config&&runtime.config.values||input.configuration.values||{},scale=[2e-4,2e-4,5e-4];
    const collective=w.extra&&w.extra['mixer[3]']?w.extra['mixer[3]'][Math.max(0,offset-1)]*.001:w.coll[Math.max(0,offset-1)]*.001;
    const error=AXES.map((a,i)=>v[a+'_i_gain']>0&&w.I&&w.I[i]?
        (v.pid_mode===4?w.I[i][offset]:w.I[i][offset]/(v[a+'_i_gain']*scale[i])):0);
    const hsi=AXES.map((a,i)=>i<2&&v[a+'_o_gain']>0&&w.extra&&w.extra[`axisO[${i}]`]&&Math.abs(collective)>.0001?
        w.extra[`axisO[${i}]`][offset]*.001/(collective*(v.pid_mode===4?1:v[a+'_o_gain']*scale[i])):0);
    const state={axisError:error,axisOffset:hsi};runtime.seed(state);return state;
}
function observationAt(w,index) {
    const terms={};for(const term of ['P','I','D','F','B'])terms[term]=[0,1,2].map(a=>w[term]&&w[term][a]?w[term][a][index]:null);
    terms.O=[0,1,2].map(a=>w.extra&&w.extra[`axisO[${a}]`]?w.extra[`axisO[${a}]`][index]*.001:null);
    return {terms};
}
async function calibrateController(input,split,config,runtimeOptions={}) {
    const reservedFlights=new Set((split.test||[]).map(s=>s.flight)),design=[...(split.train||[]),...(split.selection||[])].filter(s=>!reservedFlights.has(s.flight));
    const sorted=design.slice().sort((a,b)=>b.n/b.rate-a.n/a.rate||String(a.id).localeCompare(String(b.id))),chosen=sorted[0];
    if(!chosen)return {config,status:'insufficient',resolved:[],provenance:{excludedTestFlights:[...reservedFlights]},reason:'No different flight is available to fit the flight controller values.'};
    const coverage=controllerInputs(input,chosen,config);
    if(!coverage.pass)return {config,status:'inputs-unavailable',resolved:[],coverage,provenance:{segment:chosen.id,flight:chosen.flight,
        excludedTestFlights:[...reservedFlights]},reason:'The flight controller inputs are not all known.'};
    const {w,offset}=contextFor(input,chosen),samples=[],observations=[];
    for(let i=0;i<chosen.n;i++){samples.push(sampleAt(input,chosen,i,w.gyro.map(c=>c[offset+i]),true,config));observations.push(observationAt(w,offset+i));}
    const result=await firmware.calibrate(Object.assign({},runtimeOptions,{config,samples,observations}));
    result.provenance={...result.provenance,segment:chosen.id,flight:chosen.flight,configuration:chosen.configuration,
        source:chosen.source,fromS:chosen.fromS,toS:chosen.fromS+chosen.n/chosen.rate,
        role:(split.train||[]).includes(chosen)?'SysID training flight':'SysID selection flight',
        excludedTestFlights:[...reservedFlights],partition:'contiguous intervals within one design period'};
    return result;
}
function scenarioPath(input,segment,config,targetSegment,target) {
    if(segment.configuration===targetSegment.configuration)return {pass:true,reasons:[]};
    const reasons=[],structural=firmware.SCHEMA.filter(f=>/^main_rotor_dir$|^tail_|^swash_|^collective_tilt_|^mixer_/.test(f.name)).map(f=>f.name);
    for(const name of structural)if(!finite(config.values[name])||!finite(target.values[name])||config.values[name]!==target.values[name])
        reasons.push('The mixer or servo configuration is different or unknown: '+name+'.');
    const a=datasetFor(input,segment.configuration),b=datasetFor(input,targetSegment.configuration);
    const servoNames=new Set([...Object.keys(a&&a.values||{}),...Object.keys(b&&b.values||{})].filter(k=>/^servo(?: |_|\[)/.test(k)));
    for(const name of servoNames)if(a.values[name]==null||b.values[name]==null||JSON.stringify(a.values[name])!==JSON.stringify(b.values[name]))
        reasons.push('The servo configuration is different or unknown: '+name+'.');
    const x=sensorContext(input,segment).cfg,y=sensorContext(input,targetSegment).cfg;
    if(JSON.stringify(x.s)!==JSON.stringify(y.s)||JSON.stringify(x.gear)!==JSON.stringify(y.gear)||
        ['gyroHz','pidDenom','filtDenom','pidHz','filterHz','loopsPerFrame'].some(k=>x.rates[k]!==y.rates[k]))reasons.push('The gyro sensor filter has different configurations.');
    return {pass:reasons.length===0,reasons};
}
async function controllerReplay(input, segments, config, runtimeOptions={}) {
    const runtime=await firmware.create(Object.assign({config},runtimeOptions)), rows=[];
    for(const s of segments) {
        runtime.reset();const initialState=seedController(runtime,input,s),{w,offset}=contextFor(input,s), output=[0,1,2].map(()=>new Float64Array(s.n));
        const termOutput=Object.fromEntries(['P','I','D','F','B','O'].map(term=>[term,[0,1,2].map(()=>new Float64Array(s.n))]));
        for(let i=0;i<s.n;i++) {
            const o=runtime.step(sampleAt(input,s,i,w.gyro.map(v=>v[offset+i]),true,config));
            for(let a=0;a<3;a++){output[a][i]=o.u[a];for(const term of Object.keys(termOutput))termOutput[term][a][i]=o.terms[term][a];}
        }
        const start=Math.min(s.n-1,Math.ceil(RULES.warmupS*s.rate)),metrics=errorsOf(s.u,output,start),terms=[];
        for(const term of Object.keys(termOutput))for(let axis=0;axis<3;axis++) {
            const measured=term==='O'?w.extra&&w.extra[`axisO[${axis}]`]:w[term]&&w[term][axis];
            if(!measured){const inactive=term==='O'&&(axis===2||config.values[AXES[axis]+'_o_gain']===0)||term==='B'&&config.values[AXES[axis]+'_b_gain']===0;
                terms.push({term,axis,status:inactive?'inactive':'missing',pass:inactive});continue;}
            let sum=0,power=0,n=0;for(let i=start;i<s.n;i++){const actual=measured[offset+i]*(term==='O'?.001:1),d=termOutput[term][axis][i]-actual;sum+=d*d;power+=actual*actual;n++;}
            const rmse=Math.sqrt(sum/Math.max(1,n)),relative=Math.sqrt(sum/Math.max(1e-12,power));
            terms.push({term,axis,rmse,relative,n,pass:rmse<=RULES.controllerAbsoluteRmse||relative<=RULES.controllerRelativeRmse});
        }
        const coverage=controllerInputs(input,s,config);
        rows.push({id:s.id,configuration:s.configuration,flight:s.flight,metrics,terms,coverage,initialState,
            pass:coverage.pass&&terms.every(t=>t.pass)&&metrics.every(m=>m.rmse<=RULES.controllerAbsoluteRmse||m.relative<=RULES.controllerRelativeRmse)});
    }
    return {pass:rows.length>0&&rows.every(r=>r.pass),rows};
}

async function sensorReplay(input,segments) {
    const rows=[];
    for(const s of segments){const context=sensorContext(input,s),{w,offset}=contextFor(input,s);
        if(context.reasons.length){rows.push({id:s.id,pass:false,reasons:context.reasons});continue;}
        const chain=await context.create(),recorded={n:s.n,raw:[0,1,2].map(a=>w.extra[`gyroRAW[${a}]`].subarray(offset,offset+s.n))},
            aligned=sensor.input(context.cfg,recorded),predicted=[0,1,2].map(()=>new Float64Array(s.n));
        for(let i=0;i<s.n;i++){
            const k=offset+i,raw=aligned.raw.map(column=>column[i]);
            const output=chain.tick(raw,w.hs[k],w.extra.tailspeed?w.extra.tailspeed[k]:w.hs[k],1);
            for(let a=0;a<3;a++)predicted[a][i]=output[a];
        }
        const metrics=errorsOf(w.gyro.map(v=>v.subarray(offset,offset+s.n)),predicted,Math.min(s.n-1,Math.ceil(RULES.warmupS*s.rate)));
        rows.push({id:s.id,metrics,engine:chain.engine,artifactSha256:chain.artifactSha256,configuration:context.provenance,
            acquisition:{offsetSamples:aligned.offset,method:aligned.reconstruction?'recorded-band windowed sinc':'direct recorded samples',
                usesFutureRecordedSamples:aligned.reconstruction,scope:'The recorded sensor replay uses recorded gyro. The model uses calculated gyro at the filter update time.'},
            pass:metrics.every(m=>m.relative<=RULES.controllerRelativeRmse)});
    }
    return {pass:rows.length>0&&rows.every(r=>r.pass),rows};
}

// The global sensor chain remains fixed during control tuning. Its timing,
// missing RPM inputs and baseline parity are independent acceptance gates.
function sensorContext(input,segment) {
    const {w}=contextFor(input,segment),original=w.originalHeader||w.flight.header,
        logged=Array.isArray(original.loggedHeaderFields)?new Set(original.loggedHeaderFields):null,
        header=logged?Object.fromEntries(Object.entries(original).filter(([k])=>logged.has(k))):original;
    // P-interval fields are parser translations of the recorded P interval.
    // Filter values come from the original header, not a materialized profile.
    if(logged&&logged.has('P interval'))for(const k of ['frameIntervalPNum','frameIntervalPDenom'])header[k]=original[k];
    if(logged&&Array.isArray(original.unknownHeaders))header.unknownHeaders=original.unknownHeaders.filter(h=>logged.has(h.name));
    const cfg=filters.config(header,{cli:input.cli,actualRate:w.flight.actualRate});
    const reasons=[],compiled=filters.compile(cfg);
    if(['looptime','pid_process_denom','filter_process_denom','frameIntervalPNum','frameIntervalPDenom'].some(k=>!(header[k]>0)))reasons.push('The recorded gyro filter sample rate is unknown.');
    if(nativeSensor.unknownSettings(cfg).length)reasons.push('The gyro filter configuration has unknown values.');
    if(compiled.leftOut.length)reasons.push('An active RPM filter has an unknown input.');
    if(compiled.rpm.some(banks=>banks.some(b=>b.ref==='tail'))&&!(w.extra&&w.extra.tailspeed))reasons.push('Recorded tail speed is necessary for the gyro filter.');
    if(compiled.dynLpf)reasons.push('A governor model is necessary for the gyro filter that changes with headspeed.');
    if(Math.abs(cfg.rates.filterHz/cfg.rates.pidHz-1)>1e-6)reasons.push('The gyro filter and control rates are different.');
    if(Math.abs(cfg.rates.loopsPerFrame-1)>1e-6)reasons.push('The log does not record all control updates.');
    const paths=AXES.map((_,a)=>filters.pidPath(cfg,input.configuration.pidProfile,a));
    const provenance={sources:cfg.from,gear:cfg.gear,cliHypotheses:Object.keys(cfg.from).filter(k=>cfg.from[k]==='cli'),
        recordedHeaderJournal:!!logged};
    return {cfg,paths,reasons,provenance,create:()=>nativeSensor.create(cfg)};
}
async function simulate(input,segment,model,config,runtimeOptions={}) {
    const {w,offset}=contextFor(input,segment), runtime=await firmware.create(Object.assign({config},runtimeOptions));
    seedController(runtime,input,segment);
    const sensors=sensorContext(input,segment);if(sensors.reasons.length)throw new Error(sensors.reasons.join(' '));
    const ticks=sensors.cfg.rates.pidDenom,afterFilter=sensors.cfg.rates.offsetTicks;
    model=plant.atRate(model,segment.rate*ticks);
    const chain=await sensors.create(), state=plant.createState(model,segment.y.map(v=>v[0]),
        {u:segment.u.map(v=>v[0]),hs:segment.hs[0],coll:segment.coll[0]});
    const y=[0,1,2].map(()=>new Float64Array(segment.n)), u=y.map(()=>new Float64Array(segment.n));
    const servoConfig=runtime.config.servos,collective=new Float64Array(segment.n),
        servoPwm=servoConfig?Array.from({length:servoConfig.count},()=>new Float64Array(segment.n)):null;
    let saturation=0, maxRate=0, extrapolation=0,previous={u:segment.u.map(v=>v[0]),hs:segment.hs[0],coll:segment.coll[0]};
    for(let i=0;i<segment.n;i++) {
        const hs=segment.hs[i],tail=w.extra&&w.extra.tailspeed?w.extra.tailspeed[offset+i]:hs;
        // The logged raw sample can occur after the filter/PID phase. Advance
        // the physical model through actual gyro ticks to that phase, execute
        // native sensor/controller code, then advance to the logger phase.
        // No later measured gyro value enters the autonomous simulation.
        if(i)for(let t=0;t<ticks-afterFilter;t++)plant.step(model,state,{...previous,hs});
        const feedback=Array.from(chain.tick(state.rate,hs,tail,1));
        const response=runtime.step(sampleAt(input,segment,i,feedback,false,config));
        if(i)for(let t=0;t<afterFilter;t++)plant.step(model,state,{...previous,hs});
        for(let a=0;a<3;a++){y[a][i]=feedback[a];u[a][i]=response.u[a];maxRate=Math.max(maxRate,Math.abs(state.rate[a]));}
        collective[i]=response.collective;
        if(servoPwm)for(let a=0;a<servoPwm.length;a++)servoPwm[a][i]=response.servoPwm[a];
        if(response.saturation&&response.saturation.some(Boolean))saturation++;
        if(maxRate>RULES.maxRate)throw new Error('The simulated rate is more than the model limit.');
        const envelope=model.envelope;
        if(envelope&&i>=RULES.warmupS*segment.rate&&(!inRange(hs,envelope.rpm)||!inRange(response.collective*1000,envelope.collective)||
            response.u.some((v,a)=>!inRange(v,envelope.input[a]))||state.rate.some((v,a)=>!inRange(v,envelope.bodyRate[a]))))extrapolation++;
        previous={u:response.u,hs,coll:response.collective*1000};
    }
    const start=Math.min(segment.n-1,Math.ceil(RULES.warmupS*segment.rate)), recorded=w.gyro.map(v=>v.subarray(offset,offset+segment.n));
    const reference=w.sp.map(v=>v.subarray(offset,offset+segment.n));
    const hz=model.analysisFilterHz||model.analysisLowpassHz||20,
        measuredBand=controlBand(recorded,segment.rate,hz),predictedBand=controlBand(y,segment.rate,hz),referenceBand=controlBand(reference,segment.rate,hz);
    const measuredMixer=segment.u.concat([Float64Array.from(segment.coll,x=>x/1000)]),predictedMixer=u.concat([collective]),
        mixer=errorsOf(controlBand(measuredMixer,segment.rate,hz),controlBand(predictedMixer,segment.rate,hz),start)
            .map((m,a)=>({...m,channel:'mixer['+a+']',pass:m.rmse<=RULES.controllerAbsoluteRmse||m.relative<=RULES.baselineRelativeRmse}));
    const missing=[],servos=[];
    if(servoPwm)for(let a=0;a<servoPwm.length;a++){
        const name='servo['+a+']',column=w.extra&&w.extra[name];
        if(!column||column.length<offset+segment.n){missing.push(name);continue;}
        // Remove pulse center before computing relative RMS. The constant PWM
        // offset must not conceal a wrong actuator excursion.
        const center=servoConfig.parameters[a][0],observed=Float64Array.from(column.subarray(offset,offset+segment.n),v=>v-center),
            generated=Float64Array.from(servoPwm[a],v=>v-center),m=errorsOf(controlBand([observed],segment.rate,hz),controlBand([generated],segment.rate,hz),start)[0];
        servos.push({...m,channel:name,center,absoluteToleranceUs:1,pass:m.rmse<=1||m.relative<=RULES.baselineRelativeRmse});
    }
    const actuatorBaseline={mixer,servos,missing,bandHz:hz,warmupSamples:start,mixerUnits:'normalized',servoUnits:'microseconds from configured center',
        boundary:servoPwm?'servo PWM and stabilized mixer':'stabilized mixer',pass:!missing.length&&mixer.every(m=>m.pass)&&servos.every(m=>m.pass)};
    return {id:segment.id,tracking:errorsOf(referenceBand,predictedBand,start).map(m=>m.rmse),baseline:errorsOf(measuredBand,predictedBand,start),
        actuatorBaseline,saturation:saturation/segment.n,maxRate,extrapolation,y,u,collective,servoPwm};
}

function closedLoopAgreement(row){
    const gyroPass=row.baseline.every(e=>e.relative<=RULES.baselineRelativeRmse),actuators=row.actuatorBaseline;
    return {id:row.id,metrics:row.baseline,gyroPass,actuators,pass:gyroPass&&!!actuators&&actuators.pass};
}

function candidates(input) {
    const d=input.configuration, values=d.values||{}, patterns={cyclic:/^(roll|pitch)_[pidfbo]_gain$/,tail:/^yaw_[pidfb]_gain$/,
        cycomp:/^(pitch_collective_ff_gain|cyclic_cross_coupling_gain|cyclic_cross_coupling_ratio)$/,
        tailcomp:/^yaw_(cw_stop_gain|ccw_stop_gain|collective_ff_gain|cyclic_ff_gain|inertia_precomp_gain)$/};
    if(!patterns[input.step])return [];
    const out=[],seen=new Set(), add=changes=>{const k=JSON.stringify(changes);if(!seen.has(k)){seen.add(k);out.push(changes);}};
    for(const [name,value] of Object.entries(values))if(patterns[input.step].test(name)&&finite(value)&&advice.RANGE[name]) {
        for(const factor of [.8,.9,1.1,1.2]){const to=Math.round(value*factor),range=advice.RANGE[name];
            if(to!==value&&to>=range[0]&&to<=range[1]&&Math.abs(to-value)<=Math.max(1,Math.abs(value)*RULES.maxRelativeStep))add({[name]:to});}
    }
    // Advice was calculated before the data split and can include reserved
    // flight measurements. It must not change the candidate set.
    return out.slice(0,RULES.maxCandidates);
}
function blocked(input) {
    const h=input.analysis&&input.analysis.hierarchy,scope=h&&h.byDataset&&h.byDataset[input.configuration.id],node=scope&&scope.nodes&&scope.nodes[input.step];
    if(node&&(/blocked|possible|after/.test(String(node.status).toLowerCase())||(node.blockedBy||[]).length||(node.after||[]).length))return true;
    return ((input.analysis.advice||{}).byDataset||{})[input.configuration.id]?.some(r=>(r.node||r.area)===input.step&&
        ((r.blockedBy||[]).length||(r.causes||[]).some(c=>c.holds!==false)))||false;
}
function objective(rows,step) {const axes=step==='tail'||step==='tailcomp'?[2]:[0,1];return average(rows.map(r=>average(axes.map(a=>r.tracking[a]))));}

async function tune(input,hooks={}) {
    const d=input.configuration, base=proposals.tune({analysis:input.analysis||{},configuration:input.configurationId||d&&d.id,step:input.step});
    const out=Object.assign({},base,{version:2,status:'model-required',recommendations:[],rows:[],prediction:null,
        limitation:'The model estimates the response. A new flight must test the selected values.',rules:RULES,
        twin:null,controller:null,search:null,flightPlan:proposals.flightPlan([])});
    if(!d||!(input.items||[]).length){out.reason='No selected flight data is available for the helicopter model.';return out;}
    const spec=fitInput(input);if(hooks.progress)hooks.progress('The app identifies the helicopter response from selected flight periods.');
    const fit=ID.fit(spec);out.twin=makeTwin(input,fit);out.twin.coverage.decodeExcluded=input.excluded||[];
    if(fit.status!=='validated'){out.status='model-rejected';out.reason='The helicopter model does not agree with different flight data. No gain change is available.';return out;}
    if(out.twin.recordedGains.conditionalPlantOnly){out.status='model-required';out.reason='Recorded PID gains are not necessary for this model fit. Control changes are not available.';return out;}
    if(!fit.controlEligible){out.status='model-required';out.reason=(fit.controlReasons||[]).join(' ')||'The model checks are not satisfactory for control changes.';return out;}
    if(input.step==='governor'){out.status='unsupported-loop';out.reason='This model does not calculate motor torque or headspeed. Governor gains cannot be tuned with this model.';return out;}
    if(blocked(input)){out.status='prerequisites-required';out.reason='Complete the prerequisite checks before control tuning.';return out;}
    if(fit.model.output!=='gyroRAW'){out.status='sensor-model-required';out.reason='Raw gyro data is necessary before the model can test control gains.';return out;}
    const runtimeOptions=hooks.runtimeOptions||{};
    const prepared=ID.prepareSegments(spec),allSplit=ID.splitSegments(prepared.segments,spec.options),allPeriods=[...allSplit.train,...allSplit.selection,...allSplit.test];
    const targetPeriods=allPeriods.filter(s=>s.configuration===d.id),targetSegment=targetPeriods[0];
    if(!targetSegment){out.status='model-required';out.reason='The target control configuration has no selected flight period.';return out;}
    const configurations=new Map(),excluded=[];
    for(const id of new Set([d.id,...allPeriods.map(s=>s.configuration)])) {
        const periods=allPeriods.filter(s=>s.configuration===id),dataset=datasetFor(input,id);
        if(!dataset){excluded.push({configuration:id,reasons:['The recorded configuration is missing.']});continue;}
        let config=targetConfig(input,periods,dataset),calibration=null;
        if((config.unknown||[]).some(name=>name==='pid_mode'||/^iterm_relax_level\[/.test(name))) {
            if(hooks.progress)hooks.progress('The app checks unknown flight controller values with different fit data.');
            const designSplit=Object.fromEntries(['train','selection','test'].map(k=>[k,allSplit[k].filter(s=>s.configuration===id)]));
            // The exclusion set includes every final test flight, including a
            // different configuration recorded during that same flight.
            designSplit.test=allSplit.test;
            calibration=await calibrateController(input,designSplit,config,runtimeOptions);config=calibration.config;
        }
        const compatibility=firmware.compatibility(config,{step:input.step});
        configurations.set(id,{configuration:config,compatibility,calibration});
    }
    const target=configurations.get(d.id),config=target.configuration;
    out.controller={...target,configurations:Object.fromEntries(configurations),excluded};out.twin.controller=config;out.twin.pitchLimits=firmware.pitchLimits(config);
    if(!target.compatibility.supported){out.status='firmware-unavailable';out.reason='The log does not identify all firmware inputs for a simulated control loop.';out.controller.reasons=target.compatibility.reasons.slice();return out;}
    const allowed=new Set();
    for(const s of allPeriods) {
        const record=configurations.get(s.configuration);
        if(!record)continue;
        const path=scenarioPath(input,s,record.configuration,targetSegment,config);
        if(!record.compatibility.supported||!path.pass){excluded.push({id:s.id,configuration:s.configuration,reasons:[...record.compatibility.reasons,...path.reasons]});continue;}
        allowed.add(s.id);
    }
    const split=Object.fromEntries(['train','selection','test'].map(k=>[k,allSplit[k].filter(s=>allowed.has(s.id))]));
    const periods=[...split.train,...split.selection,...split.test];
    out.controller.scenarios={partition:allSplit.method,seed:allSplit.seed,train:split.train.map(s=>s.id),selection:split.selection.map(s=>s.id),test:split.test.map(s=>s.id),
        comparison:'The target flight controller and the selected values use the same pilot inputs. First, the app checks the recorded flight controller and control loop for each configuration.'};
    if(!split.test.length||!(split.train.length+split.selection.length)){out.status='model-required';out.reason='Different flights with applicable configurations are necessary to fit and test the control loop.';return out;}
    const problems=[];
    for(const s of periods) {
        problems.push(...sensorContext(input,s).reasons,...controllerInputs(input,s,config).reasons);
        const rate=firmware.compatibility(configurations.get(s.configuration).configuration,{nativeRate:s.rate});problems.push(...rate.reasons);
    }
    if(problems.length){out.status='firmware-unavailable';out.reason='The log does not identify all firmware inputs for a simulated control loop.';out.controller.reasons=[...new Set(problems)];return out;}
    if(hooks.progress)hooks.progress('The app checks the firmware output against the recorded output.');
    const parityRows=[];
    for(const [id,record] of configurations) {
        const ownPeriods=periods.filter(s=>s.configuration===id);if(!ownPeriods.length)continue;
        const parity=await controllerReplay(input,ownPeriods,record.configuration,runtimeOptions);parityRows.push(...parity.rows);
    }
    out.controller.parity={pass:parityRows.length>0&&parityRows.every(r=>r.pass),rows:parityRows};
    if(!out.controller.parity.pass){out.status='controller-rejected';out.reason='The firmware replay does not agree with the recorded control output. No gain change is available.';return out;}
    out.controller.sensorParity=await sensorReplay(input,periods);
    if(!out.controller.sensorParity.pass){out.status='sensor-rejected';out.reason='The sensor replay does not agree with the recorded gyro output. No gain change is available.';return out;}
    const models=[fit.model].concat(fit.ensemble||[]),design=split.train.concat(split.selection);
    let baseline,recordedBaseline;
    try {
        recordedBaseline=await Promise.all(periods.map(s=>simulate(input,s,fit.model,configurations.get(s.configuration).configuration,runtimeOptions)));
        baseline=await Promise.all(design.map(s=>s.configuration===d.id?recordedBaseline[periods.indexOf(s)]:simulate(input,s,fit.model,config,runtimeOptions)));
    }
    catch(e){out.status='loop-rejected';out.reason='The recorded control loop cannot operate in the model limits.';out.controller.simulationError=String(e.message);return out;}
    out.controller.closedLoopParity=recordedBaseline.map((row,i)=>({...closedLoopAgreement(row),configuration:periods[i].configuration}));
    if(out.controller.closedLoopParity.some(r=>!r.pass)){out.status='loop-rejected';out.reason='The closed control loop does not agree with the recorded response. No gain change is available.';return out;}
    if(baseline.some(r=>r.extrapolation>0)){out.status='loop-rejected';out.reason='The target flight controller gives values out of the model range in a fit flight.';return out;}
    // The identified bandwidth is finite. A flight trajectory cannot establish
    // stability at unobserved frequencies, so do not raise feedback gains there.
    const options=candidates({...input,configuration:{...d,values:config.values}}).filter(changes=>Object.entries(changes).every(([name,to])=>
        !/_[pidbo]_gain$/.test(name)||to<=config.values[name])),scored=[];
    for(let k=0;k<options.length;k++) {
        if(hooks.progress)hooks.progress(`The app tests control values ${k+1} of ${options.length} with the helicopter model.`);
        const changes=options[k],cfg=Object.assign({},config,{values:Object.assign({},config.values,changes)});
        try {const rows=await Promise.all(design.map(s=>simulate(input,s,fit.model,cfg,runtimeOptions)));
            if(rows.some((r,i)=>r.extrapolation>0||r.tracking.some((x,a)=>x>baseline[i].tracking[a]*(1+RULES.maxAxisRegression))||r.saturation>baseline[i].saturation+0.001))continue;
            scored.push({changes,score:objective(rows,input.step),rows});
        } catch(e){scored.push({changes,score:Infinity,reason:String(e.message)});}
    }
    scored.sort((a,b)=>a.score-b.score);const best=scored[0];
    out.search={evaluated:options.length,baseline:objective(baseline,input.step),baselineKind:'target-controller counterfactual',
        candidates:scored.map(q=>({changes:q.changes,score:finite(q.score)?q.score:null,reason:q.reason})),selected:best&&best.changes||null};
    if(!best||!(best.score<out.search.baseline*(1-RULES.minImprovement))){out.status='no-change';out.reason='No gain set gives a sufficient error decrease.';return out;}
    // Freeze choice here. Reserved test data may reject it but never select a replacement.
    const validation=[];
    try {for(const m of models)for(const s of split.test){
        const before=await simulate(input,s,m,config,runtimeOptions),after=await simulate(input,s,m,{...config,values:{...config.values,...best.changes}},runtimeOptions);
        const recorded=s.configuration===d.id?before:await simulate(input,s,m,configurations.get(s.configuration).configuration,runtimeOptions);
        validation.push({id:s.id,flight:s.flight,model:models.indexOf(m),before,after,recordedParity:closedLoopAgreement(recorded).pass,recordedActuators:recorded.actuatorBaseline,
            delta:objective([before],input.step)-objective([after],input.step)});
    }} catch(e){out.status='candidate-rejected';out.reason='The selected gains give values out of the model limits in a test flight.';out.search.validationError=String(e.message);return out;}
    // Model variants and nearby intervals are not independent flights.
    // Compute uncertainty from flight means; require every model to improve.
    const flightDeltas=new Map();validation.forEach((q,i)=>{const s=split.test[i%split.test.length];
        if(!flightDeltas.has(s.flight))flightDeltas.set(s.flight,[]);flightDeltas.get(s.flight).push(q.delta);});
    const holdoutRows=validation.map(q=>({id:q.id,flight:q.flight,model:q.model,delta:q.delta,trackingBefore:q.before.tracking,trackingAfter:q.after.tracking,
        extrapolationBefore:q.before.extrapolation,extrapolationAfter:q.after.extrapolation,saturationBefore:q.before.saturation,saturationAfter:q.after.saturation,
        recordedParity:q.recordedParity,recordedActuators:q.recordedActuators,pass:q.recordedParity&&q.delta>0&&q.after.extrapolation===0&&
            q.before.extrapolation===0&&q.after.saturation<=q.before.saturation+0.001&&
            q.after.tracking.every((v,a)=>v<=q.before.tracking[a]*(1+RULES.maxAxisRegression))}));
    const improvement=stats([...flightDeltas.values()].map(average));out.search.holdout={improvement,rows:holdoutRows,
        pass:improvement.n>=3&&improvement.se!==null&&improvement.mean>2*improvement.se&&holdoutRows.every(q=>q.pass)};
    if(!out.search.holdout.pass){out.status='candidate-rejected';out.reason='The selected gains do not agree with the model checks on test flights. No gain change is available.';return out;}
    const group='twin:'+out.twin.id+':'+input.step,names=Object.keys(best.changes);
    out.recommendations=names.map(name=>({id:group+':'+name,group,groupSize:names.length,node:input.step,area:input.step,
        dataset:d.id,profile:d.pidProfile,cliProfile:d.pidProfile-1,scope:'profile',severity:'action',confidence:'predicted',
        parameter:name,from:config.values[name],to:best.changes[name],fromSource:config.sources&&config.sources[name]||'recorded configuration',
        title:'Test the model values',text:'The recorded flight data identifies this helicopter model. The control tests agree with the selected values.',
        rule:`The calculated error decrease is ${improvement.mean.toFixed(3)} deg/s. Its standard error is ${improvement.se.toFixed(3)} deg/s.`,
        evidence:[{id:'SYSID',value:improvement.mean,se:improvement.se,unit:'deg/s',n:improvement.n}],
        cli:[`profile ${d.pidProfile-1}`,`set ${name} = ${best.changes[name]}`],controlTune:true,verifiedInFlight:false,
        caveats:[out.limitation],twinId:out.twin.id}));
    out.rows=out.recommendations.map(r=>({name:r.parameter,from:r.from,to:r.to,delta:r.to-r.from,profile:r.profile,source:r.fromSource}));
    out.status='flight-test-required';out.reason='The model checks agree with the selected gain set. Test these values in a new flight.';
    out.flightPlan=proposals.flightPlan(out.recommendations);return out;
}
module.exports={RULES,GAIN_NAMES,recordedGainEvidence,recordedGainMask,continuityAssertion,mechanicalCohort,prepareIdentificationInputs,identify,makeTwin,validateTwin,replayTwin,tune,candidates,controllerReplay,sensorReplay,simulate,errorsOf,
    sampleAt,seedController,targetConfig,calibrateController,controllerInputs,scenarioPath,controlBand,closedLoopAgreement};
if(require.main!==module)return;
