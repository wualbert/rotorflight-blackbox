'use strict';

// Aircraft-specific identification, firmware parity, and closed-loop search.
// An unvalidated twin is a diagnostic artifact, never an exportable gain set.
const ID = require('./system_id.cjs');
const T = require('./heli_twin.cjs');
const F = require('./twin_fit.cjs');
const { craftPrior } = require('./helicopter_model.cjs');
const firmware = require('./firmware_controller.cjs');
const proposals = require('./control_tune.cjs');
const advice = require('./advice.cjs');
const filters = require('./filter_tune.cjs');
const sensor = require('./filter_replay.cjs');
const nativeSensor = require('./firmware_sensor.cjs');
const datasets = require('./datasets.cjs');
const AXES = ['roll', 'pitch', 'yaw'];
// controller*: native PID replay against the logged terms (no model). baselineRelativeRmse: closed-loop agreement of the
// twin flown by the native controller from the end of the recorded prefix (warmupS) to the end of the period, in the
// 20 Hz analysis band, relative to the recorded gyro and mixer power; a free closed-loop run of 6 to 14 s has no
// measurement correction, so this limit is wider than the 0.1 s prediction check of twin_fit.assess. maxRate: a
// twin body rate above it stops the run (diverged loop). envelopeMargin: the fraction of the fit range (headspeed,
// collective, mixer, gyro) outside of which a value counts as extrapolation. maxAxisRegression: the maximum increase of
// the mean tracking error of each axis over the design (and the test) periods. The fraction of samples at a mixer
// limit has the same rule with an absolute limit of 0.001.
// closedLoopFit: the closed-loop refinement of the twin on the fit flights (tune, after the controller parity). The native
// sensor chain and controller fly the twin over windows of windowS (warmupS of recorded prefix, then the closed loop).
// Residuals: the gyro and mixer[0..2] after a zero-phase lowpassHz filter at sampleHz, divided by gyroScale (deg/s) and
// mixerScale, through a pseudo-Huber function with the corner robust; a window that stops (diverged loop) gives
// failedResidual for each value. The instrumented frequency responses of the fit (twin_fit.frequencyResiduals) have the
// weight frequencyWeight. maxWindows and the iterations of the two stages keep the stage at about 4 min in one thread on
// the Fireball data (analysis/twin6dof/data/fireball). governor*: the native governor in the closed loop (simulate with
// executeGovernor). It has no recorded state: it starts governorWarmupS before each period with the recorded inputs.
// Its throttle must agree with motor[0] in the recorded prefix (governorThrottleRmse, throttle 0 to 1). In the closed
// loop, the twin headspeed and the governor throttle must agree with the log (governorHeadspeedRmse in RPM and
// closedLoopThrottleRmse, or baselineRelativeRmse).
const CLOSED_LOOP_FIT = Object.freeze({ windowS:8, maxWindows:32, sampleHz:50, lowpassHz:20, gyroScale:15, mixerScale:0.05, robust:3,
    failedResidual:50, frequencyWeight:50,
    stages:Object.freeze([
        Object.freeze({ name:'closed-loop yaw', free:Object.freeze(['tht0','nc','ncd','nr','izz','sy','dTail']), iterations:5 }),
        Object.freeze({ name:'closed-loop cyclic and yaw', free:Object.freeze(['lb','mb','gLat','gLon','phiU','phiW','dCyc','tauF','kmu','sx',
            'tht0','nc','ncd','nr','nt','izz','sy','dTail']), iterations:5 })]) });
const RULES = Object.freeze({ controllerRelativeRmse:0.12, controllerAbsoluteRmse:0.008,
    baselineRelativeRmse:0.30, minImprovement:0.03, maxAxisRegression:0.02,
    maxRelativeStep:0.20, maxCandidates:60, warmupS:2, maxRate:2000, envelopeMargin:0.05, traceHz:50,
    closedLoopFit:CLOSED_LOOP_FIT, governorWarmupS:20, governorThrottleRmse:0.02, governorHeadspeedRmse:100, closedLoopThrottleRmse:0.04,
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
    return {file,logIndex:log,sha256:file&&file.sha256,localLogIndex:(item.source&&item.source.localLogIndex)??(file&&Number.isInteger(file.logOffset)?log-file.logOffset:null)};
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
        const identity=sourceIdentity(input,item);
        return {...item,source:{...(item.source||{}),file:identity.file,logIndex:identity.logIndex,localLogIndex:identity.localLogIndex},
            mask:selectedMask,gainEvidence,mechanicalCohort:cohort.id,ctx:{...(item.ctx||{}),eligible:selectedMask}};
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

function fitInput(input,hooks={}) {
    const first=(input.items||[]).find(i=>i.w&&!i.w.skipped), name=input.options&&input.options.craft || first&&first.w.flight.craft || input.fileName || '';
    const options=Object.assign({},input.options&&input.options.sysid||{}, {keepSegments:true,predictions:true});
    if(hooks.progress)options.progress=(stage,k,n)=>hooks.progress(k<n?`The app calculates the helicopter model (step ${k+1} of ${n}).`:'The app compares the helicopter model with the test flights.');
    return {segments:prepareIdentificationInputs(input).items,craft:name,options};
}
// Channels of the twin (heli_twin.cjs): its state, the log fields that drive it and the log fields that it calculates.
const CHANNELS=Object.freeze({states:T.STATE.slice(),inputs:['mixer[0]','mixer[1]','mixer[2]','mixer[3]','motor[0]','Vbat'],
    outputs:['gyroADC[0]','gyroADC[1]','gyroADC[2]','attitude[0]','attitude[1]','attitude[2]','altitude','vario','headspeed'],
    unmodeled:['horizontal position and velocity sensors (not recorded; estimated by the model)','servo motor dynamics','wind']});
// The outputs that the log records: the barometer fields (altitude, vario) are optional in a log.
function recordedOutputs(input) {
    const items=(input.items||[]).filter(i=>i.w&&!i.w.skipped);if(!items.length)return CHANNELS.outputs.slice();
    const has=name=>items.some(i=>{const c=i.w.extra&&i.w.extra[name];if(!c)return false;for(let k=0;k<c.length;k++)if(finite(c[k]))return true;return false;});
    return CHANNELS.outputs.filter(name=>!['altitude','vario'].includes(name)||has(name));
}
// extra: { closedLoopFit (the record of closedLoopFit, in validation), governor (tune: the governor path of the closed loop) }
function makeTwin(input, fit, extra={}) {
    const source=input.source||{}, first=targetItems(input)[0]||(input.items||[]).find(i=>i.w&&!i.w.skipped);
    const controller=targetConfig(input), collectiveField=fit.model&&fit.model.collectiveField||'setpoint[3]',gainCoverage=prepareIdentificationInputs(input).coverage,
        vbatRecorded=!(fit.model&&fit.model.vbatRecorded===false);
    const controlReasons=[...(fit.controlReasons||[]),...(gainCoverage.conditionalPlantOnly?['Recorded PID gains are not necessary for this model fit. Control changes are not available.']:[])];
    const modelCopy=model=>{if(!model)return null;const copy=clone(model);
        if(gainCoverage.conditionalPlantOnly)copy.validation={...(copy.validation||{}),controlEligible:false,
            controlReasons:[...new Set([...(copy.validation&&copy.validation.controlReasons||[]),...controlReasons])]};return copy;};
    const model=modelCopy(fit.model);
    const validation=fit.validation&&extra.closedLoopFit?{...fit.validation,closedLoopFit:extra.closedLoopFit}:fit.validation||null,
        governed=!!(extra.governor&&extra.governor.active);
    const twin={schema:'rotorflight-digital-twin',version:2,status:fit.status,eligibleSteps:(fit.eligibleSteps||[]).slice(),craft:craftPrior(fitInput(input).craft),
        model,ensemble:(fit.ensemble||[]).map(m=>m===fit.model?model:modelCopy(m)),validation,coverage:fit.coverage||null,
        confidence:fit.confidence||{level:'unavailable',reasons:['The model has no test flight result.']},
        reasons:fit.reasons||[],limitations:fit.limitations||[],source:{...clone(source),mechanicalCohort:mechanicalCohort(input),requireKnownGains:gainCoverage.requireKnownGains,
            parameterContinuity:clone(input.options&&input.options.parameterContinuity||[])},
        mechanicalCohort:mechanicalCohort(input),recordedGains:gainCoverage,firmware:first?first.w.flight.firmware:null,
        // the log fields that drive this twin: the collective field of the fit (mixer[3] or setpoint[3]), and Vbat only if the log records it
        // outputs: only the outputs that the log records. exogenous: the recorded inputs of the closed loop
        channels:{...clone(CHANNELS),outputs:recordedOutputs(input),collectiveField,inputs:['mixer[0]','mixer[1]','mixer[2]',collectiveField,'motor[0]',...(vbatRecorded?['Vbat']:[])],
            exogenous:governed?['rcCommand[0..4]',...(vbatRecorded?['Vbat']:[])]:['motor[0]',...(vbatRecorded?['Vbat']:[]),'headspeed'],
            governor:governed?'calculated':'recorded headspeed'},
        predictions:fit.predictions||[],controlEligible:!!fit.controlEligible&&!gainCoverage.conditionalPlantOnly,
        controlReasons,
        controller,pitchLimits:firmware.pitchLimits(controller||{}),
        controllerRuntime:firmware.CAPABILITIES,sensorRuntime:{engine:'upstream-c-wasm',artifactSha256:nativeSensor.ARTIFACT,sourceRevision:nativeSensor.COMMIT},verifiedInFlight:false};
    if(extra.governor)twin.governor=clone(extra.governor);
    twin.id=twinDigest(twin);
    return twin;
}
async function identify(input, hooks={}) {
    if(hooks.progress)hooks.progress('The app fits the helicopter model to selected flight data.');
    const fit=await ID.fit(fitInput(input,hooks)), twin=makeTwin(input,fit);
    twin.coverage=twin.coverage||{};
    twin.coverage.decodeExcluded=input.excluded||[];
    return twin;
}
// The id follows the model, its data and its checks, not the compute time of a run.
function twinDigest(twin) {
    return digest({model:twin.model,source:twin.source,validation:JSON.parse(JSON.stringify(twin.validation||null,(k,v)=>k==='runtimeS'||k==='evaluations'?undefined:v))});
}
function validateTwin(twin) {
    const errors=[];
    if(!twin||twin.schema!=='rotorflight-digital-twin'||twin.version!==2)return ['The app cannot read this helicopter model file type.'];
    errors.push(...T.validateModel(twin.model));
    if(!twin.source||!twin.source.configuration)errors.push('The model has no recorded configuration.');
    if(twin.source&&twin.source.requireKnownGains===false&&(twin.controlEligible!==false||
        [twin.model,...(twin.ensemble||[])].some(model=>model&&model.validation&&model.validation.controlEligible!==false)))
        errors.push('This model cannot give control changes without recorded PID gains.');
    if(twin.id!==twinDigest(twin))errors.push('The model data changed after its checks.');
    return errors;
}
// A replay run (twin_fit.cjs run format): { id, rate, n, u[3], coll, thr, vbat, gyro[3], att[3], alt, vario, hs } with
// optional sp[3], flight and fromS. The observer uses the measurements up to each prediction origin. No measurement
// after an origin enters its prediction. A run below 400 Hz (a saved 100 Hz trace) is first brought to about the fit
// rate of the twin (upsample k): each input holds its recorded value until the next recorded sample (no interpolation,
// thus no later sample and no heading or roll wrap enters a value). The measurements and the scored values are only at
// the recorded samples (NaN between them: the observer skips them), and replayRules puts each prediction origin on a
// recorded sample. Thus the result is near, but not equal to, the saved prediction.
const REPLAY_FIELDS=['u','coll','thr','vbat','gyro','att','alt','vario','hs'];
function replayRun(run,fitRate=500) {
    const n=run.n,column=x=>Float64Array.from({length:n},(_,i)=>x&&x[i]!==null&&x[i]!==undefined?+x[i]:NaN);
    // a model input must be finite at each sample: hold the last finite value (the first one before it)
    const input=x=>{const c=column(x);let last=NaN;for(let i=0;i<n&&!finite(last);i++)if(finite(c[i]))last=c[i];
        if(!finite(last))throw new Error('A replay period must have the model inputs and measurements.');
        for(let i=0;i<n;i++){if(finite(c[i]))last=c[i];else c[i]=last;}return c;};
    let r={id:run.id,flight:run.flight,fromS:run.fromS,rate:run.rate,n,u:run.u.map(input),coll:input(run.coll),thr:input(run.thr),vbat:input(run.vbat),
        gyro:run.gyro.map(column),att:run.att.map(column),alt:column(run.alt),vario:column(run.vario),hs:column(run.hs),sp:run.sp?run.sp.map(column):undefined,upsample:1};
    if(r.rate<400) {
        const k=Math.ceil(fitRate/r.rate),m=(n-1)*k+1,
            hold=x=>Float64Array.from({length:m},(_,j)=>x[Math.floor(j/k)]),
            recorded=x=>Float64Array.from({length:m},(_,j)=>j%k?NaN:x[j/k]);
        r=Object.assign({},r,{rate:r.rate*k,n:m,interpolatedFrom:run.rate,upsample:k,recordedGyro:r.gyro,u:r.u.map(hold),coll:hold(r.coll),thr:hold(r.thr),vbat:hold(r.vbat),
            gyro:r.gyro.map(recorded),att:r.att.map(recorded),alt:recorded(r.alt),vario:recorded(r.vario),hs:recorded(r.hs),sp:r.sp&&r.sp.map(hold)});
    }
    return r;
}
// The twin_fit rules of a replay run: the rules of the fit (twin.model.fit.rules, also used by system_id for the
// reserved-flight check). For an upsampled run, each time (warm-up, origin interval, horizon, score points) becomes a
// whole number of recorded samples, so that each origin and each scored value is at a recorded sample.
// Below about 75 Hz, two points of rules.points can fall on the same recorded sample: such a point is used once
// (points: the aligned times, nominalPoints: the first point of rules.points at each of them).
function replayRules(rules,run) {
    const k=run.upsample||1;if(k===1)return rules;
    const align=s=>k*Math.max(1,Math.round(s*run.rate/k))/run.rate,points=[],nominalPoints=[];
    rules.points.forEach(p=>{const t=align(p);if(!points.some(q=>Math.abs(q-t)<1e-12)){points.push(t);nominalPoints.push(p);}});
    return Object.assign({},rules,{fitRate:run.rate,warmupS:align(rules.warmupS),originEveryS:align(rules.originEveryS),horizonS:align(rules.horizonS),
        points,nominalPoints});
}
// twin_fit.prepareRun of a replay run. An upsampled run scores the low-pass gyro of the recorded samples only.
function prepareReplay(run,rules) {
    const prepared=F.prepareRun(run,rules),k=run.upsample||1;
    if(k>1)prepared.target={gyro:run.recordedGyro.map(g=>{const lp=F.lowpass(Float64Array.from(g,v=>finite(v)?v:0),rules.scoreLowpassHz,run.interpolatedFrom);
        return Float64Array.from({length:run.n},(_,j)=>j%k||!finite(g[j/k])?NaN:lp[j/k]);})};
    return prepared;
}
function replayTwin(twin, runs) {
    const reasons=validateTwin(twin);if(reasons.length)throw new Error(reasons.join(' '));
    const rules=Object.assign({},F.RULES,twin.model.fit&&twin.model.fit.rules),constantVbat=twin.model.vbatRecorded===false;
    return runs.map(original=>{
        // The barometer is optional: a run without altitude or vario gets NaN (the observer skips it). A twin without
        // the battery voltage uses the constant 1 of twin_fit.prepareRun for all periods. Then the fields are checked.
        const n=original&&original.n,missing=()=>new Float64Array(Number.isInteger(n)&&n>0?n:0).fill(NaN);
        const run=original&&{...original,alt:original.alt||missing(),vario:original.vario||missing(),
            vbat:constantVbat&&Number.isInteger(n)&&n>0?new Float64Array(n).fill(1):original.vbat};
        if(!run||!(run.rate>0)||!Number.isInteger(run.n)||run.n<2||!REPLAY_FIELDS.every(k=>run[k]))throw new Error('A replay period must have the model inputs and measurements.');
        const r=replayRun(run,rules.fitRate),runRules=replayRules(rules,r),k=r.upsample,
            prepared=prepareReplay(r,runRules),
            result=F.predictionErrors(twin.model,[prepared],{rules:runRules,traces:{horizonS:k>1?runRules.horizonS:1,decimateTo:k>1?r.interpolatedFrom:100}});
        return {id:run.id,flight:run.flight,fromS:run.fromS,rate:prepared.rate,interpolatedFrom:prepared.interpolatedFrom||null,upsample:k,
            prediction:{points:runRules.nominalPoints||rules.points,pointTimesS:runRules.points,channels:result.channels,units:result.units,rmse:result.rmse,persistence:result.persistence,samples:result.samples,origins:result.origins,
                originEveryS:runRules.originEveryS,warmupS:runRules.warmupS},
            trace:result.traces[0],extrapolated:outside(twin.model,prepared)};
    });
}
function outside(model, run) {
    const env=model.envelope;
    if(!env)return null;
    const beyond=(column,range)=>range&&column&&Array.prototype.some.call(column,x=>Number.isNaN(x)?false:!finite(x)||!inRange(x,range));
    return !!(beyond(run.hs,env.rpm)||beyond(run.coll,env.collective)||
        (run.u||[]).some((column,a)=>beyond(column,env.input&&env.input[a]))||
        (run.gyro||[]).some((column,a)=>beyond(column,env.bodyRate&&env.bodyRate[a])));
}
function inRange(value,range) {
    // Two float32 rounding units permit constant recorded inputs to round
    // through the C runtime without expanding the physical input range.
    if(!range)return true;
    const margin=(range[1]-range[0])*RULES.envelopeMargin+2e-7*Math.max(1,Math.abs(range[0]),Math.abs(range[1]));
    return value>=range[0]-margin&&value<=range[1]+margin;
}

function contextFor(input, segment) {
    const ref=segment.source||{}, item=(input.items||[])[ref.item||0];
    if(!item)throw new Error('The model period has no recorded input.');
    return {w:item.w,offset:ref.start||0,item};
}
// The controller input of log sample i of a period (i can be negative: a sample before the period). external: values
// of the closed loop, { headspeed } (the twin headspeed when the governor runs). The throttle is the recorded motor[0].
function sampleAt(input,segment,i,gyro,previous,config={},external={}) {
    const {w,offset}=contextFor(input,segment), k=offset+i;
    const v=config.values||input.configuration.values||{},x=w.extra||{},state=w.govStateAt?w.govStateAt[k]:null;
    const throttle=finite(external.throttle)?external.throttle:x['motor[0]']?x['motor[0]'][k]*.001:0,headspeed=finite(external.headspeed)?external.headspeed:w.hs[k];
    const spoolUpRatio=state===4||state===6||state===9?1:state===0||state===1||state===5||state===7?0:1;
    const spooledUp=state===4||state===7||state===8||state===9?true:state===2||state===3||state===6||state===null&&[0,1].includes(v.gov_mode)?throttle>.333:state===0||state===1||state===5?false:true;
    const rc=[0,1,2,3].map(a=>x[`rcCommand[${a}]`]);
    const sample={setpoint:w.sp.map(v=>v[k]),gyro,collective:w.coll[k]*0.001,headspeed,
        throttle,rcDeflection:rc.every(Boolean)?rc.map(column=>column[k]/500):undefined,
        airborne:w.airborneAt?!!w.airborneAt[k]:true,spooledUp,spoolUpRatio,ttaIncrease:0,
        saturation:[0,0,0],
        previousMixer:previous?w.u.map(v=>v[Math.max(0,k-1)]).concat(x['mixer[3]']?x['mixer[3]'][Math.max(0,k-1)]*.001:w.coll[Math.max(0,k-1)]*.001):undefined};
    if(config.executeGovernor===true)Object.assign(sample,governorSample(w,k,v,headspeed));
    return sample;
}
// Governor inputs (firmware_controller executeGovernor): the motor RPM of the headspeed (the firmware calculates
// headspeed = motor RPM x main_rotor_gear_ratio[0] / main_rotor_gear_ratio[1]), the recorded battery voltage and the
// recorded throttle stick (rcCommand[4], 0 to 1000). A flight period is armed. The throttle is off at a stick of 0.
function governorSample(w,k,v,headspeed) {
    const x=w.extra||{},command=x['rcCommand[4]'][k]*.001;
    return {rawMotorRpm:headspeed*v['main_rotor_gear_ratio[1]']/v['main_rotor_gear_ratio[0]'],batteryVoltage:x.Vbat[k]*.01,
        throttleCommand:command,throttleOff:!(command>0),armed:true};
}
// Can the closed loop calculate the governor for this period? The configuration must have all governor values
// (firmware_controller.compatibility with executeGovernor) and the log must record each governor input.
function governorInputs(input,segment,config) {
    // each input must be finite from the governor warm-up (governorWarmupS before the period) to the end of the period
    const {w,offset}=contextFor(input,segment),x=w.extra||{},reasons=[],end=offset+segment.n,from=Math.max(0,offset-Math.round(RULES.governorWarmupS*segment.rate)),
        recorded=name=>{const c=x[name];if(!c||c.length<end)return false;for(let k=from;k<end;k++)if(!finite(c[k]))return false;return true;};
    const governed={...config,executeGovernor:true},compatibility=firmware.compatibility(governed,{step:'governor'});
    if(!compatibility.supported)reasons.push('The governor code cannot use this configuration: '+compatibility.reasons.join(' '));
    if(!recorded('rcCommand[4]'))reasons.push('The log does not record the throttle stick ("rcCommand[4]"). The governor must have it.');
    if(![0,1,2,3].every(a=>recorded(`rcCommand[${a}]`)))reasons.push('The log does not record all stick positions ("rcCommand[0]" to "rcCommand[3]"). The governor must have them.');
    if(!recorded('Vbat'))reasons.push('The log does not record the battery voltage ("Vbat"). The governor must have it.');
    if(!recorded('motor[0]'))reasons.push('The log does not record the throttle ("motor[0]"). The governor check must have it.');
    return {pass:reasons.length===0,reasons,compatibility:compatibility.reasons};
}
// Governor parity: the native governor with the recorded headspeed, stick positions and battery voltage, from
// governorWarmupS before the period to the end of the recorded prefix. Its throttle must agree with motor[0] in the
// recorded prefix (governorThrottleRmse), and the governor must be active (state 4) at the end of the prefix.
async function governorReplay(input,segments,configOf,runtimeOptions={}) {
    const rows=[];
    for(const s of segments) {
        const config={...configOf(s),executeGovernor:true},path=governorInputs(input,s,config);
        if(!path.pass){rows.push({id:s.id,configuration:s.configuration,pass:false,reasons:path.reasons});continue;}
        const {w,offset}=contextFor(input,s),runtime=await firmware.create(Object.assign({config},runtimeOptions)),
            start=Math.min(s.n-1,Math.ceil(RULES.warmupS*s.rate)),from=Math.max(0,offset-Math.round(RULES.governorWarmupS*s.rate));
        const recorded=new Float64Array(start),output=new Float64Array(start);let state=null;
        try {
            for(let k=from;k<offset+start;k++) {
                const r=runtime.step(sampleAt(input,s,k-offset,w.gyro.map(c=>c[k]),k===from,config));
                if(k>=offset){recorded[k-offset]=w.extra['motor[0]'][k]*.001;output[k-offset]=r.throttle;state=r.governor&&r.governor.state;}
            }
        } catch(e){rows.push({id:s.id,configuration:s.configuration,pass:false,error:String(e.message),reasons:['The governor code cannot use the recorded governor inputs.']});continue;}
        const [m]=errorsOf([recorded],[output]),pass=m.rmse<=RULES.governorThrottleRmse&&state===4;
        rows.push({id:s.id,configuration:s.configuration,throttle:m,state,warmupS:(offset-from)/s.rate,pass,
            reasons:pass?[]:[state!==4?'The calculated governor is not active when the closed loop starts.':
                'The calculated governor throttle does not agree with the recorded throttle before the closed loop starts.']});
    }
    return {pass:rows.length>0&&rows.every(r=>r.pass),rows,reasons:[...new Set(rows.flatMap(r=>r.reasons))]};
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
// rmse: the root mean square error. relative: the error power divided by the power of the recorded value about its mean
// (the mean removed), so that a constant trim cannot hide a wrong moving part. Each check also accepts an absolute rmse limit.
function errorsOf(actual,predicted,start=0) {
    return actual.map((column,a)=>{let e=0,sum=0,sq=0,n=0;for(let i=start;i<column.length;i++){
        if(!finite(predicted[a][i]))return {rmse:Infinity,relative:Infinity};
        e+=(actual[a][i]-predicted[a][i])**2;sum+=actual[a][i];sq+=actual[a][i]**2;n++;
    }const variance=Math.max(0,sq-sum*sum/Math.max(1,n));
    return {rmse:Math.sqrt(e/Math.max(1,n)),relative:Math.sqrt(e/Math.max(1e-12,variance)),n};});
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
        runtime.reset();let initialState=seedController(runtime,input,s);
        const {w,offset}=contextFor(input,s),output=[0,1,2].map(()=>new Float64Array(s.n)),
            start=Math.min(s.n-1,Math.ceil(RULES.warmupS*s.rate));
        const termOutput=Object.fromEntries(['P','I','D','F','B','O'].map(term=>[term,[0,1,2].map(()=>new Float64Array(s.n))]));
        for(let i=0;i<s.n;i++) {
            // The measured prefix warms the native filters. Their zero-state
            // transient otherwise leaves a permanent error in the integral.
            // Initialize I/O once from the last prefix frame, before the first
            // scored update. No scored PID term enters the generated state.
            if(i===start&&start>0)initialState=seedController(runtime,input,{...s,source:{...s.source,start:offset+start-1}});
            const o=runtime.step(sampleAt(input,s,i,w.gyro.map(v=>v[offset+i]),true,config));
            for(let a=0;a<3;a++){output[a][i]=o.u[a];for(const term of Object.keys(termOutput))termOutput[term][a][i]=o.terms[term][a];}
        }
        const metrics=errorsOf(s.u,output,start),terms=[];
        for(const term of Object.keys(termOutput))for(let axis=0;axis<3;axis++) {
            const measured=term==='O'?w.extra&&w.extra[`axisO[${axis}]`]:w[term]&&w[term][axis];
            if(!measured){const inactive=term==='O'&&(axis===2||config.values[AXES[axis]+'_o_gain']===0)||term==='B'&&config.values[AXES[axis]+'_b_gain']===0;
                terms.push({term,axis,status:inactive?'inactive':'missing',pass:inactive});continue;}
            // errorsOf: the relative error uses the power of the recorded term about its mean
            const actual=Float64Array.from({length:s.n-start},(_,j)=>measured[offset+start+j]*(term==='O'?.001:1)),
                [m]=errorsOf([actual],[termOutput[term][axis].subarray(start)]);
            terms.push({term,axis,rmse:m.rmse,relative:m.relative,n:m.n,pass:m.rmse<=RULES.controllerAbsoluteRmse||m.relative<=RULES.controllerRelativeRmse});
        }
        const coverage=controllerInputs(input,s,config);
        rows.push({id:s.id,configuration:s.configuration,flight:s.flight,metrics,terms,coverage,initialState,
            initialization:{prefixSamples:start,stateSample:Math.max(0,start-1),predictionStart:start,
                stateSource:'recorded I and O',laterRecordedState:false,postUpdateStateExact:false},
            pass:coverage.pass&&terms.every(t=>t.pass)&&metrics.every(m=>m.rmse<=RULES.controllerAbsoluteRmse||m.relative<=RULES.controllerRelativeRmse)});
    }
    return {pass:rows.length>0&&rows.every(r=>r.pass),rows};
}

async function sensorReplay(input,segments) {
    const rows=[];
    for(const s of segments){const context=sensorContext(input,s),{w,offset}=contextFor(input,s);
        if(![0,1,2].every(a=>w.extra&&w.extra[`gyroRAW[${a}]`])){rows.push({id:s.id,pass:false,available:false,
            reasons:['The log does not record the raw gyro ("gyroRAW"). The app cannot compare the gyro filter with the log.']});continue;}
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
    // Without gyroRAW the filter replay has no reference: the check is not applicable (pass true, available false) and
    // its reason stays in the result. The closed-loop check still compares the sensor chain output with gyroADC.
    const measured=rows.filter(r=>r.available!==false),missing=rows.filter(r=>r.available===false);
    if(!measured.length)return {pass:true,available:false,applicable:false,reasons:[...new Set(missing.flatMap(r=>r.reasons))],rows};
    return {pass:measured.every(r=>r.pass),available:true,applicable:true,reasons:[...new Set(missing.flatMap(r=>r.reasons))],rows};
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
// Rotorflight 118e912, fc/core.c taskMainPidLoop. The sensor sample is taken
// before this tick's tasks. A servo command starts acting only after its
// output task, which need not coincide with the PID or blackbox task.
function controllerSchedule(pidDenom) {
    if(!Number.isInteger(pidDenom)||pidDenom<1)throw new Error('The control sample interval is not correct.');
    const index=Math.min(8,pidDenom);
    return {gyroTicks:pidDenom,filterTick:0,pidTick:[0,0,0,0,0,0,1,1,2][index],
        mixerTick:[0,0,1,0,1,1,2,2,3][index],actuatorTick:[0,0,1,1,1,2,3,3,4][index],
        loggerTick:[0,0,1,1,2,3,4,5,6][index]};
}
// Closed loop of the native controller and the twin (heli_twin.cjs). The twin runs at the gyro rate (log rate times the
// PID denominator). During the recorded prefix (RULES.warmupS) it gets the recorded inputs and the observer gets the
// recorded measurements once per log sample. After the prefix no measurement enters the twin: the native sensor chain
// filters the twin body rate, the native controller calculates the mixer and the twin gets that mixer with the
// battery voltage of the log. Two paths for the rotor speed:
//  - config.executeGovernor (governorInputs and governorReplay passed): the native governor gets the twin headspeed,
//    the recorded stick positions and the battery voltage, and its throttle drives the twin. The twin rotor speed is free.
//  - else the twin gets the recorded throttle, and the rotor speed is set to the recorded headspeed at each log sample.
// In the two paths the controller gets the recorded throttle (motor[0]) at each sample.
function twinLog(w,offset,model) {
    const x=w.extra||{},held=(name,k)=>{const c=x[name];let last=NaN;return i=>{if(!c)return NaN;const v=c[offset+i];if(finite(v))last=v*k;else if(!finite(last))for(let j=offset+i;j<c.length&&!finite(last);j++)if(finite(c[j]))last=c[j]*k;return last;};},
        value=(name,k)=>i=>x[name]&&finite(x[name][offset+i])?x[name][offset+i]*k:NaN;
    // a twin without the battery voltage (model.vbatRecorded false) uses the constant 1 of twin_fit.prepareRun
    return {throttle:held('motor[0]',.001),vbat:model&&model.vbatRecorded===false?()=>1:held('Vbat',.01),att:[0,1,2].map(a=>value(`attitude[${a}]`,1)),alt:value('altitude',.01),vario:value('vario',.01)};
}
function decimated(columns,stride,digits) {return columns.map(c=>{const o=[];for(let i=0;i<c.length;i+=stride)o.push(finite(c[i])?+c[i].toFixed(digits):null);return o;});}
async function simulate(input,segment,model,config,runtimeOptions={}) {
    const {w,offset}=contextFor(input,segment), runtime=await firmware.create(Object.assign({config},runtimeOptions)),governed=config.executeGovernor===true;
    if(governed) {
        const path=governorInputs(input,segment,config);if(!path.pass)throw new Error(path.reasons.join(' '));
        // the governor has no recorded state: it starts governorWarmupS before the period with the recorded inputs
        const from=Math.max(0,offset-Math.round(RULES.governorWarmupS*segment.rate));
        for(let k=from;k<offset;k++)runtime.step(sampleAt(input,segment,k-offset,w.gyro.map(c=>c[k]),k===from,config));
    }
    seedController(runtime,input,segment);
    const sensors=sensorContext(input,segment);if(sensors.reasons.length)throw new Error(sensors.reasons.join(' '));
    const ticks=sensors.cfg.rates.pidDenom,afterFilter=sensors.cfg.rates.offsetTicks,
        schedule=controllerSchedule(ticks);
    if(afterFilter!==schedule.loggerTick)throw new Error('The control and gyro filter update times do not agree.');
    const log=twinLog(w,offset,model);
    if(!finite(log.throttle(0))||!finite(log.vbat(0)))throw new Error('The model must have the recorded throttle and battery voltage.');
    const sim=T.createSim(model,segment.rate*ticks);
    // the observer corrects once per log sample: its gains are for the log sample interval (heli_twin keeps them)
    sim.gains=T.observerGains(model,1/segment.rate);
    const chain=await sensors.create(),rawRecorded=[0,1,2].every(a=>w.extra&&w.extra[`gyroRAW[${a}]`]);
    const start=Math.min(segment.n-1,Math.ceil(RULES.warmupS*segment.rate)),lastPrefix=Math.max(0,start-1),
        prefix=rawRecorded?sensor.input(sensors.cfg,{n:start,raw:[0,1,2].map(a=>w.extra[`gyroRAW[${a}]`].subarray(offset,offset+start))}):null;
    const y=[0,1,2].map(()=>new Float64Array(segment.n)), u=y.map(()=>new Float64Array(segment.n));
    const servoConfig=runtime.config.servos,collective=new Float64Array(segment.n),
        servoPwm=servoConfig?Array.from({length:servoConfig.count},()=>new Float64Array(segment.n)):null;
    const headspeed=new Float64Array(segment.n),throttle=new Float64Array(segment.n),target=governed?new Float64Array(segment.n).fill(NaN):null;
    const measurement=i=>({gyro:[0,1,2].map(a=>w.gyro[a][offset+i]),att:log.att.map(f=>f(i)),alt:log.alt(i),vario:log.vario(i),hs:segment.hs[i],thr:log.throttle(i)});
    const recordedInput=i=>({u:segment.u.map(column=>column[i]),coll:segment.coll[i]*.001,thr:log.throttle(i),vbat:log.vbat(i)});
    const advance=input=>{T.push(sim,input);T.step(sim);};
    // the tail speed of a calculated headspeed: the recorded tail speed in the ratio of the headspeeds
    // one ratio from the recorded prefix: no recorded tail speed enters after the prediction boundary
    const tailRatio=(()=>{const t=w.extra&&w.extra.tailspeed;if(!t)return 1;const r=[];
        for(let i=0;i<Math.min(segment.n,Math.ceil(RULES.warmupS*segment.rate));i++)if(segment.hs[i]>0&&finite(t[offset+i]))r.push(t[offset+i]/segment.hs[i]);
        r.sort((a,b)=>a-b);return r.length?r[r.length>>1]:1;})();
    const tailOf=(i,hs)=>hs*tailRatio;
    T.initState(sim,measurement(0));
    let previous=recordedInput(0);
    for(let k=0;k<sim.maxDelay;k++)T.push(sim,previous);
    sim.count=0;
    let saturation=0, maxRate=0, extrapolation=0;
    const rateOf=()=>[0,1,2].map(a=>sim.x[10+a]/T.DEG);
    // The measured prefix is initialization, not a forecast. The observer estimates the twin state from the recorded
    // measurements up to the last prefix sample, at the filter tick of each sample (the time of the gyro sample). The
    // phase reconstruction of the raw gyro reads the prefix only. Each sample advances the twin by the gyro ticks
    // before its filter tick (previous command), then by the ticks to its logger tick (the new command from the
    // servo-output tick). The command before the first sample is unknown: the twin uses the first recorded command.
    for(let i=0;i<start;i++) {
        const hs=segment.hs[i],tail=tailOf(i,hs),recorded=recordedInput(i);
        if(i)for(let t=0;t<ticks-afterFilter;t++)advance(previous);
        T.observe(sim,measurement(i));
        chain.tick(prefix?prefix.raw.map(column=>column[i]):rateOf(),hs,tail,1);
        const recordedGyro=w.gyro.map(column=>column[offset+i]);
        const response=runtime.step(sampleAt(input,segment,i,recordedGyro,true,config));
        for(let t=0;t<afterFilter;t++)advance(t<schedule.actuatorTick?previous:recorded);
        for(let a=0;a<3;a++){y[a][i]=recordedGyro[a];u[a][i]=segment.u[a][i];}
        collective[i]=segment.coll[i]*.001;headspeed[i]=hs;throttle[i]=recorded.thr;
        if(target&&response.governor)target[i]=response.governor.targetHS;
        if(servoPwm)for(let a=0;a<servoPwm.length;a++)servoPwm[a][i]=w.extra&&w.extra['servo['+a+']']?w.extra['servo['+a+']'][offset+i]:response.servoPwm[a];
        previous=recorded;
    }
    if(start>0)seedController(runtime,input,{...segment,source:{...segment.source,start:offset+lastPrefix}});
    const envelope=model.envelope;
    for(let i=start;i<segment.n;i++) {
        // The logged sample can occur after the filter/PID phase. Advance the twin through the gyro ticks to that
        // phase, run the native sensor and controller code, then advance to the logger phase. No measured gyro,
        // attitude, barometer, PID state or actuator output of this interval enters the twin. Pilot commands,
        // battery voltage, mode events, and the throttle and headspeed (without the governor) are the recorded inputs.
        if(i)for(let t=0;t<ticks-afterFilter;t++)advance(previous);
        if(!governed)sim.x[15]=sim.x[30]=segment.hs[i]*T.RPM;
        const hs=governed?sim.x[30]/T.RPM:segment.hs[i],tail=tailOf(i,hs);
        const rate=rateOf(),feedback=Array.from(chain.tick(rate,hs,tail,1));
        const response=runtime.step(sampleAt(input,segment,i,feedback,i===start&&start>0,config,{headspeed:hs}));
        const next={u:response.u.slice(),coll:response.collective,thr:governed?response.throttle:log.throttle(i),vbat:log.vbat(i)};
        // Native PID and mixer evaluation is batched, but the physical input changes at the firmware's servo-output
        // tick. Until that tick the twin keeps the previous command, also for denominator 2.
        for(let t=0;t<afterFilter;t++)advance(t<schedule.actuatorTick?previous:next);
        for(let a=0;a<3;a++){y[a][i]=feedback[a];u[a][i]=response.u[a];maxRate=Math.max(maxRate,Math.abs(rate[a]));}
        collective[i]=response.collective;headspeed[i]=hs;throttle[i]=next.thr;
        if(target&&response.governor)target[i]=response.governor.targetHS;
        if(servoPwm)for(let a=0;a<servoPwm.length;a++)servoPwm[a][i]=response.servoPwm[a];
        if(response.saturation&&response.saturation.some(Boolean))saturation++;
        if(maxRate>RULES.maxRate)throw new Error('The simulated rate is more than the model limit.');
        if(envelope&&(!inRange(hs,envelope.rpm)||!inRange(response.collective,envelope.collective)||
            response.u.some((v,a)=>!inRange(v,envelope.input&&envelope.input[a]))||rate.some((v,a)=>!inRange(v,envelope.bodyRate&&envelope.bodyRate[a]))))extrapolation++;
        previous=next;
    }
    const recorded=w.gyro.map(v=>v.subarray(offset,offset+segment.n));
    const reference=w.sp.map(v=>v.subarray(offset,offset+segment.n));
    const hz=model.analysisFilterHz||20,
        measuredBand=controlBand(recorded,segment.rate,hz),predictedBand=controlBand(y,segment.rate,hz),referenceBand=controlBand(reference,segment.rate,hz);
    const measuredMixer=segment.u.concat([Float64Array.from(segment.coll,x=>x/1000)]),predictedMixer=u.concat([collective]),
        measuredMixerBand=controlBand(measuredMixer,segment.rate,hz),predictedMixerBand=controlBand(predictedMixer,segment.rate,hz),
        mixer=errorsOf(measuredMixerBand,predictedMixerBand,start)
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
    // A small trace for the plots: the 20 Hz band signals at about RULES.traceHz.
    const stride=Math.max(1,Math.round(segment.rate/RULES.traceHz)),
        trace={rate:segment.rate/stride,predictionStartS:start/segment.rate,bandHz:hz,setpoint:decimated(referenceBand,stride,1),measuredGyro:decimated(measuredBand,stride,1),
            predictedGyro:decimated(predictedBand,stride,1),measuredMixer:decimated(measuredMixerBand,stride,4),predictedMixer:decimated(predictedMixerBand,stride,4)};
    // the governor path: the twin headspeed and the governor throttle against the log, and the headspeed error from
    // the governor target (the tracking error of the governor)
    let governor=null;
    if(governed) {
        const recordedThrottle=Float64Array.from({length:segment.n},(_,i)=>log.throttle(i)),hsError=errorsOf([target],[headspeed],start)[0];
        const hsCheck=errorsOf([Float64Array.from(segment.hs)],[headspeed],start)[0],thrCheck=errorsOf([recordedThrottle],[throttle],start)[0];
        governor={headspeed:{...hsCheck,pass:hsCheck.rmse<=RULES.governorHeadspeedRmse||hsCheck.relative<=RULES.baselineRelativeRmse},
            throttle:{...thrCheck,pass:thrCheck.rmse<=RULES.closedLoopThrottleRmse||thrCheck.relative<=RULES.baselineRelativeRmse},tracking:hsError.rmse,
            trace:{rate:segment.rate/stride,measuredHeadspeed:decimated([Float64Array.from(segment.hs)],stride,0)[0],predictedHeadspeed:decimated([headspeed],stride,0)[0],
                measuredThrottle:decimated([recordedThrottle],stride,3)[0],predictedThrottle:decimated([throttle],stride,3)[0]}};
        governor.pass=governor.headspeed.pass&&governor.throttle.pass;
    }
    return {id:segment.id,tracking:errorsOf(referenceBand,predictedBand,start).map(m=>m.rmse),baseline:errorsOf(measuredBand,predictedBand,start),
        initialization:{prefixSamples:start,stateSample:lastPrefix,predictionStart:start,predictionTimeS:start/segment.rate,
            recordedPrefix:true,sensorPrefixOnly:true,laterRecordedState:false,postUpdateControllerStateExact:false,
            hiddenPlantState:'observer estimate from the recorded prefix measurements',throttle:'recorded motor[0] at each sample',
            rotorSpeed:governed?'calculated: the native governor throttle drives the twin':'recorded headspeed at each log sample',
            sensorChainPrefix:prefix?'recorded gyroRAW':'twin body rate',
            externalInputs:governed?['pilot setpoint','pilot collective','stick positions','throttle stick','battery voltage','tail speed ratio','flight mode events']:
                ['pilot setpoint','pilot collective','headspeed','throttle','battery voltage','tail speed','flight mode events']},
        scheduler:{...schedule,sourceRevision:firmware.COMMIT,commandBoundary:'servo output task'},
        actuatorBaseline,governor,saturation:saturation/Math.max(1,segment.n-start),maxRate,extrapolation,y,u,collective,headspeed,throttle,servoPwm,trace};
}

// The body axes of a control step: cyclic and cycomp use roll and pitch, tail and tailcomp use yaw (twin_fit.assess
// eligibleSteps). A 'partial' twin can tune only the axes that it passes, so the checks of a step use its own axes.
const STEP_AXES=Object.freeze({cyclic:[0,1],cycomp:[0,1],tail:[2],tailcomp:[2]});
const stepAxes=step=>STEP_AXES[step]||[0,1,2];
// Closed-loop agreement of a row of simulate() on the given body axes: the gyro of these axes, the mixer of these axes
// and the collective mixer (mixer[3]), and the servos (a servo can move for each axis).
// With the governor in the loop, the twin headspeed and the governor throttle must also agree (simulate governor).
function closedLoopAgreement(row,axes=[0,1,2]){
    const gyroPass=axes.every(a=>row.baseline[a].relative<=RULES.baselineRelativeRmse),all=row.actuatorBaseline;
    const actuators=all&&{...all,mixer:all.mixer.map((m,a)=>({...m,gated:a===3||axes.includes(a)}))};
    if(actuators)actuators.pass=!all.missing.length&&actuators.mixer.every(m=>!m.gated||m.pass)&&all.servos.every(m=>m.pass);
    const governor=row.governor?{headspeed:row.governor.headspeed,throttle:row.governor.throttle,trace:row.governor.trace,pass:row.governor.pass}:null;
    return {id:row.id,axes:axes.slice(),metrics:row.baseline,gyroPass,actuators,governor,trace:row.trace,pass:gyroPass&&!!actuators&&actuators.pass&&(!governor||governor.pass)};
}

// ---- closed-loop refinement of the twin (RULES.closedLoopFit) ----
// A window of a period: the same period fields from sample k0 for len samples.
function subPeriod(s,k0,len) {
    const cut=x=>x&&(x.subarray?x.subarray(k0,k0+len):x.slice(k0,k0+len)),from=(s.source&&s.source.start)||0;
    return {...s,id:s.id+'@'+(k0/s.rate).toFixed(2),parent:s.id,fromS:s.fromS+k0/s.rate,n:len,source:{...s.source,start:from+k0,end:from+k0+len},
        u:s.u.map(cut),y:s.y&&s.y.map(cut),sp:s.sp&&s.sp.map(cut),hs:cut(s.hs),coll:cut(s.coll),pilotColl:cut(s.pilotColl)};
}
// The windows of the fit periods: consecutive windows of windowS in each period, then one window of each flight in turn
// (the first windows of all flights first) up to maxWindows. The order of the periods gives the order in a flight.
function fitWindows(periods,rules=RULES.closedLoopFit) {
    const byFlight=new Map();
    for(const s of periods){const len=Math.round(rules.windowS*s.rate);if(!byFlight.has(s.flight))byFlight.set(s.flight,[]);
        for(let k0=0;k0+len<=s.n;k0+=len)byFlight.get(s.flight).push(subPeriod(s,k0,len));}
    const lists=[...byFlight.values()],out=[];
    for(let k=0;out.length<rules.maxWindows&&lists.some(l=>l.length>k);k++)for(const l of lists)if(l[k]&&out.length<rules.maxWindows)out.push(l[k]);
    return out;
}
// Residuals of one window (simulate row, or null for a loop that stopped): after the recorded prefix, the gyro and
// mixer[0..2] after the zero-phase low-pass filter at sampleHz, scaled and through the pseudo-Huber function. sums
// (optional) adds the squared errors in deg/s and mixer units for the summary.
function closedLoopResiduals(input,s,row,out=[],sums=null,rules=RULES.closedLoopFit) {
    const {w,offset}=contextFor(input,s),start=Math.min(s.n-1,Math.ceil(RULES.warmupS*s.rate)),m=s.n-start,step=Math.max(1,Math.round(s.rate/rules.sampleHz));
    const part=(c,a,b)=>Float64Array.from(c.subarray?c.subarray(a,b):c.slice(a,b)),lp=x=>F.lowpass(x,rules.lowpassHz,s.rate);
    const recG=[0,1,2].map(a=>lp(part(w.gyro[a],offset+start,offset+s.n))),recM=[0,1,2].map(a=>lp(part(s.u[a],start,s.n)));
    const pg=row&&[0,1,2].map(a=>lp(part(row.y[a],start,s.n))),pm=row&&[0,1,2].map(a=>lp(part(row.u[a],start,s.n)));
    const c=rules.robust,huber=r=>Math.sign(r)*Math.sqrt(2*c*c*(Math.sqrt(1+(r/c)**2)-1));
    for(let i=step;i<m;i+=step)for(let a=0;a<3;a++) {
        const eg=row?pg[a][i]-recG[a][i]:NaN,em=row?pm[a][i]-recM[a][i]:NaN;
        out.push(huber(row?eg/rules.gyroScale:rules.failedResidual),huber(row?em/rules.mixerScale:rules.failedResidual));
        if(sums&&row){sums.gyro[a]+=eg*eg;sums.mixer[a]+=em*em;if(a===0)sums.n++;}
    }
    if(sums&&!row)sums.failed++;
    return out;
}
// The closed-loop refinement: twin_fit.fit (Levenberg-Marquardt) of the free parameters of each stage of rules.stages. The
// residuals are those of closedLoopResiduals over the windows of the fit periods, with the recorded configuration of each
// period, and the frequency residuals of the instrumented responses of the identification (fit.frdTrain). No test
// period enters this fit. The refined model is used only if the closed-loop part of the cost decreases (record.applied).
// Returns { model, record }: record has the stages, the design cost before and after, and the changed parameters.
async function closedLoopFit(input,periods,configOf,fit,runtimeOptions={},hooks={},rules=RULES.closedLoopFit) {
    const started=Date.now(),windows=fitWindows(periods,rules),frd=fit.frdTrain||[];
    if(!windows.length)return {model:fit.model,record:{applied:false,reason:'The fit periods are too short for a closed-loop window.',windows:{count:0,windowS:rules.windowS}}};
    let evaluations=0;
    const evaluate=async(model,sums)=>{evaluations++;const out=[];
        for(const s of windows){let row=null;try{row=await simulate(input,s,model,configOf(s),runtimeOptions);}catch(e){row=null;}closedLoopResiduals(input,s,row,out,sums,rules);}
        return Float64Array.from(out);};
    const frequency=model=>frd.length&&rules.frequencyWeight>0?F.frequencyResiduals(model,frd,rules.frequencyWeight):[];
    const summary=async model=>{const sums={gyro:[0,0,0],mixer:[0,0,0],n:0,failed:0},time=await evaluate(model,sums),freq=frequency(model),
        sq=x=>Array.prototype.reduce.call(x,(t,v)=>t+v*v,0);
        return {cost:sq(time)+sq(freq),timeCost:sq(time),frequencyCost:sq(freq),failedWindows:sums.failed,
            gyroRmse:sums.gyro.map(v=>sums.n?Math.sqrt(v/sums.n):null),mixerRmse:sums.mixer.map(v=>sums.n?Math.sqrt(v/sums.n):null)};};
    const before=await summary(fit.model),stages=[];let model=fit.model;
    for(const [k,st] of rules.stages.entries()) {
        if(hooks.progress)hooks.progress(`The app fits the helicopter model in the closed control loop (step ${k+1} of ${rules.stages.length}).`);
        const r=await F.fit(model,null,{free:st.free.slice(),iterations:st.iterations,
            residualsMany:async models=>{const res=[];for(const m of models)res.push({residuals:await evaluate(m)});return res;},
            extraResiduals:frequency,log:hooks.log});
        stages.push({stage:st.name,free:st.free.slice(),cost:r.cost,iterations:r.history.length-1,costs:r.history.map(h=>h.cost)});model=r.model;
    }
    const after=await summary(model),changed={};
    for(const st of rules.stages)for(const name of st.free)if(model.params[name]!==fit.model.params[name])changed[name]={before:fit.model.params[name],after:model.params[name]};
    // applied: the refinement must decrease the closed-loop part of the cost on the fit flights, not only the frequency part
    const applied=after.cost<before.cost&&after.timeCost<before.timeCost;
    const record={applied,method:'closed-loop output error: the native sensor chain and flight controller fly the model with the recorded pilot inputs (twin_fit.fit)',
        windows:{count:windows.length,windowS:rules.windowS,prefixS:RULES.warmupS,periods:[...new Set(windows.map(s=>s.parent))].length,
            flights:[...new Set(windows.map(s=>s.flight))].length,ids:windows.map(s=>s.id)},
        residuals:{sampleHz:rules.sampleHz,lowpassHz:rules.lowpassHz,gyroScale:rules.gyroScale,mixerScale:rules.mixerScale,robust:rules.robust,
            failedResidual:rules.failedResidual,frequencyWeight:rules.frequencyWeight,frequencyGroups:frd.length},
        stages,design:{before,after},changed,evaluations,runtimeS:(Date.now()-started)/1000,
        testPeriodsUsed:windows.some(s=>(hooks.testIds||new Set()).has(s.parent))};
    if(record.testPeriodsUsed)throw new Error('A test period entered the closed-loop fit.');
    if(applied){model=clone(model);model.fit={...(model.fit||{}),closedLoop:{stages,design:{before:before.cost,after:after.cost}}};}
    return {model:applied?model:fit.model,record};
}

function candidates(input) {
    const d=input.configuration, values=d.values||{}, patterns={cyclic:/^(roll|pitch)_[pidfbo]_gain$/,tail:/^yaw_[pidfb]_gain$/,governor:/^gov_(?:[pidf]_gain|gain)$/,
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
// The twin couples the axes, and a free closed loop of one period changes by some percent after a small change. Thus
// the regression limit applies to the mean tracking error of each axis over all periods, not to each period.
// axes: the body axes of the step. An axis out of the step gives false (not checked).
function axisRegression(before,after,axes=[0,1,2]) {
    const mean=(rows,a)=>average(rows.map(r=>r.tracking[a]));
    return [0,1,2].map(a=>axes.includes(a)&&mean(after,a)>mean(before,a)*(1+RULES.maxAxisRegression));
}
// The same for the fraction of samples at a mixer limit: its mean over the periods must not increase by more than 0.001.
function moreSaturation(before,after) {return average(after.map(r=>r.saturation))>average(before.map(r=>r.saturation))+0.001;}
function objective(rows,step) {
    if(step==='governor')return average(rows.map(r=>r.governor&&finite(r.governor.tracking)?r.governor.tracking:Infinity));
    const axes=stepAxes(step);return average(rows.map(r=>average(axes.map(a=>r.tracking[a]))));
}
// The text when a partial twin cannot test a step (fit.validation.assessment: the yaw frequency check). measured false: the
// test flights do not have sufficient yaw inputs. measured true: the yaw response was measured but does not agree.
function stepRefusal(step,fit) {
    if(!['tail','tailcomp'].includes(step))return 'The roll and pitch checks of the helicopter model are not satisfactory. No cyclic gain change is available.';
    const yaw=fit&&fit.validation&&fit.validation.assessment&&(fit.validation.assessment.frequency||[])[2];
    return yaw&&yaw.measured===false?'The test flights do not have sufficient yaw inputs to measure the yaw response. No tail gain change is available. Fly yaw inputs (pirouettes and yaw stops) to measure the yaw response.':
        'The yaw response of the helicopter model does not agree with the test flights. No tail gain change is available.';
}

async function tune(input,hooks={}) {
    const d=input.configuration, base=proposals.tune({analysis:input.analysis||{},configuration:input.configurationId||d&&d.id,step:input.step});
    const out=Object.assign({},base,{version:2,status:'model-required',recommendations:[],rows:[],prediction:null,
        limitation:'The model estimates the response. A new flight must test the selected values.',rules:RULES,
        twin:null,controller:null,search:null,flightPlan:proposals.flightPlan([])});
    if(!d||!(input.items||[]).length){out.reason='No selected flight data is available for the helicopter model.';return out;}
    const spec=fitInput(input,hooks);if(hooks.progress)hooks.progress('The app identifies the helicopter response from selected flight periods.');
    let fit=await ID.fit(spec);out.twin=makeTwin(input,fit);out.twin.coverage.decodeExcluded=input.excluded||[];
    if(fit.status==='rejected'){out.status='model-rejected';out.reason='The helicopter model does not agree with different flight data. No gain change is available.';return out;}
    // A partial model agrees on some axes only: cyclic steps need roll and pitch, tail steps need yaw.
    if(input.step!=='governor'&&!(fit.eligibleSteps||[]).includes(input.step)){out.status='model-rejected';out.reason=stepRefusal(input.step,fit);return out;}
    if(out.twin.recordedGains.conditionalPlantOnly){out.status='model-required';out.reason='Recorded PID gains are not necessary for this model fit. Control changes are not available.';return out;}
    if(!fit.controlEligible){out.status='model-required';out.reason=(fit.controlReasons||[]).join(' ')||'The model checks are not satisfactory for control changes.';return out;}
    if(blocked(input)){out.status='prerequisites-required';out.reason='Complete the prerequisite checks before control tuning.';return out;}
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
        const compatibility=firmware.compatibility(config,{step:input.step==='governor'?undefined:input.step});
        configurations.set(id,{configuration:config,compatibility,calibration});
    }
    const target=configurations.get(d.id);
    out.controller={...target,configurations:Object.fromEntries(configurations),excluded};out.twin.controller=target.configuration;out.twin.pitchLimits=firmware.pitchLimits(target.configuration);
    if(!target.compatibility.supported){out.status='firmware-unavailable';out.reason='The log does not identify all firmware inputs for a simulated control loop.';out.controller.reasons=target.compatibility.reasons.slice();return out;}
    const allowed=new Set();
    for(const s of allPeriods) {
        const record=configurations.get(s.configuration);
        if(!record)continue;
        const path=scenarioPath(input,s,record.configuration,targetSegment,target.configuration);
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
        problems.push(...sensorContext(input,s).reasons,...controllerInputs(input,s,configurations.get(s.configuration).configuration).reasons);
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
    if(out.controller.sensorParity.available&&!out.controller.sensorParity.pass){out.status='sensor-rejected';out.reason='The sensor replay does not agree with the recorded gyro output. No gain change is available.';return out;}
    // The governor: the closed loop calculates it only if each period has all governor inputs and the native governor
    // agrees with the recorded throttle in the recorded prefix. Else the closed loop uses the recorded headspeed.
    const recordedConfig=s=>configurations.get(s.configuration).configuration;
    const governorChecks=periods.map(s=>governorInputs(input,s,recordedConfig(s))),inputsKnown=governorChecks.every(g=>g.pass);
    const governorParity=inputsKnown?await governorReplay(input,periods,recordedConfig,runtimeOptions):null;
    const governor={active:!!(governorParity&&governorParity.pass),inputsKnown,parity:governorParity,
        reasons:inputsKnown?governorParity.pass?[]:governorParity.reasons:[...new Set(governorChecks.flatMap(g=>g.reasons))]};
    governor.text=governor.active?'The closed loop calculates the governor. The governor throttle sets the rotor speed of the model.':
        'The closed loop does not calculate the governor. It uses the recorded throttle and the recorded headspeed.';
    out.controller.governor=governor;
    const loopConfig=config=>governor.active?{...config,executeGovernor:true}:config,configOf=s=>loopConfig(recordedConfig(s)),config=loopConfig(target.configuration);
    if(input.step==='governor'&&!governor.active){out.twin=makeTwin(input,fit,{governor});out.twin.coverage.decodeExcluded=input.excluded||[];
        out.status='unsupported-loop';out.reason='The closed loop does not calculate the governor. It uses the recorded headspeed. The app cannot tune the governor gains with this model.';return out;}
    const design=split.train.concat(split.selection);
    // Closed-loop refinement on the design periods only. The refined model replaces the model for the closed-loop checks,
    // the search and the test flights. The reserved test flights decide: the model checks run again on them.
    if(hooks.progress)hooks.progress('The app fits the helicopter model in the closed control loop with the fit flights.');
    let refined;
    // input.options.closedLoopFit: other limits of RULES.closedLoopFit (tests and analysis scripts)
    const fitRules={...RULES.closedLoopFit,...(input.options&&input.options.closedLoopFit||{})};
    try {refined=await closedLoopFit(input,design,configOf,fit,runtimeOptions,{...hooks,testIds:new Set(allSplit.test.map(s=>s.id))},fitRules);}
    catch(e){refined={model:fit.model,record:{applied:false,error:String(e.message)}};}
    if(refined.record.applied) {
        if(hooks.progress)hooks.progress('The app compares the new helicopter model with the test flights.');
        fit=ID.retest(spec,fit,refined.model);
    }
    out.twin=makeTwin(input,fit,{closedLoopFit:refined.record,governor});out.twin.coverage.decodeExcluded=input.excluded||[];
    out.twin.controller=target.configuration;out.twin.pitchLimits=firmware.pitchLimits(target.configuration);
    if(refined.record.applied) {
        if(fit.status==='rejected'){out.status='model-rejected';out.reason='After the closed-loop fit, the helicopter model does not agree with the test flights. No gain change is available.';return out;}
        if(input.step!=='governor'&&!(fit.eligibleSteps||[]).includes(input.step)){out.status='model-rejected';out.reason=stepRefusal(input.step,fit);return out;}
        if(!fit.controlEligible){out.status='model-required';out.reason=(fit.controlReasons||[]).join(' ')||'The model checks are not satisfactory for control changes.';return out;}
    }
    const model=fit.model,models=[model];
    // gate axes: a 'partial' twin checks the axes of the step only, a fully validated twin checks all axes
    const axes=fit.status==='partial'?stepAxes(input.step):[0,1,2];
    let baseline,recordedBaseline;
    try {
        recordedBaseline=await Promise.all(periods.map(s=>simulate(input,s,model,configOf(s),runtimeOptions)));
        baseline=await Promise.all(design.map(s=>s.configuration===d.id?recordedBaseline[periods.indexOf(s)]:simulate(input,s,model,config,runtimeOptions)));
    }
    catch(e){out.status='loop-rejected';out.reason='The recorded control loop cannot operate in the model limits.';out.controller.simulationError=String(e.message);return out;}
    out.controller.closedLoopParity=recordedBaseline.map((row,i)=>({...closedLoopAgreement(row,axes),configuration:periods[i].configuration,
        fromS:periods[i].fromS,toS:periods[i].fromS+periods[i].n/periods[i].rate,profile:ID.profileNumber(periods[i].profile),flight:periods[i].flight,
        role:split.test.includes(periods[i])?'test':'fit'}));
    if(out.controller.closedLoopParity.some(r=>!r.pass)){out.status='loop-rejected';out.reason='The closed control loop does not agree with the recorded response. No gain change is available.';return out;}
    if(baseline.some(r=>r.extrapolation>0)){out.status='loop-rejected';out.reason='The target flight controller gives values out of the model range in a fit flight.';return out;}
    // The identified bandwidth is finite. A flight trajectory cannot establish
    // stability at unobserved frequencies, so do not raise feedback gains there.
    const options=candidates({...input,configuration:{...d,values:config.values}}).filter(changes=>Object.entries(changes).every(([name,to])=>
        !/_[pidbo]_gain$/.test(name)||to<=config.values[name])),scored=[];
    for(let k=0;k<options.length;k++) {
        if(hooks.progress)hooks.progress(`The app tests control values ${k+1} of ${options.length} with the helicopter model.`);
        const changes=options[k],cfg=Object.assign({},config,{values:Object.assign({},config.values,changes)});
        try {const rows=await Promise.all(design.map(s=>simulate(input,s,model,cfg,runtimeOptions)));
            if(rows.some(r=>r.extrapolation>0)||moreSaturation(baseline,rows)||axisRegression(baseline,rows,axes).some(Boolean))continue;
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
        const recorded=s.configuration===d.id?before:await simulate(input,s,m,configOf(s),runtimeOptions);
        validation.push({id:s.id,flight:s.flight,model:models.indexOf(m),before,after,recordedParity:closedLoopAgreement(recorded,axes).pass,recordedActuators:recorded.actuatorBaseline,
            delta:objective([before],input.step)-objective([after],input.step)});
    }} catch(e){out.status='candidate-rejected';out.reason='The selected gains give values out of the model limits in a test flight.';out.search.validationError=String(e.message);return out;}
    // Model variants and nearby intervals are not independent flights.
    // Compute uncertainty from flight means; require every model to improve.
    const flightDeltas=new Map();validation.forEach((q,i)=>{const s=split.test[i%split.test.length];
        if(!flightDeltas.has(s.flight))flightDeltas.set(s.flight,[]);flightDeltas.get(s.flight).push(q.delta);});
    const holdoutRows=validation.map(q=>({id:q.id,flight:q.flight,model:q.model,delta:q.delta,trackingBefore:q.before.tracking,trackingAfter:q.after.tracking,
        governorTrackingBefore:q.before.governor?q.before.governor.tracking:null,governorTrackingAfter:q.after.governor?q.after.governor.tracking:null,
        extrapolationBefore:q.before.extrapolation,extrapolationAfter:q.after.extrapolation,saturationBefore:q.before.saturation,saturationAfter:q.after.saturation,
        recordedParity:q.recordedParity,recordedActuators:q.recordedActuators,pass:q.recordedParity&&q.delta>0&&q.after.extrapolation===0&&
            q.before.extrapolation===0}));
    const byModel=k=>validation.filter(q=>q.model===k),regression=models.map((m,k)=>axisRegression(byModel(k).map(q=>q.before),byModel(k).map(q=>q.after),axes)),
        saturation=models.map((m,k)=>moreSaturation(byModel(k).map(q=>q.before),byModel(k).map(q=>q.after)));
    const improvement=stats([...flightDeltas.values()].map(average));out.search.holdout={improvement,rows:holdoutRows,axisRegression:regression,moreSaturation:saturation,
        pass:improvement.n>=3&&improvement.se!==null&&improvement.mean>2*improvement.se&&holdoutRows.every(q=>q.pass)&&regression.every(r=>!r.some(Boolean))&&!saturation.some(Boolean)};
    if(!out.search.holdout.pass){out.status='candidate-rejected';out.reason='The selected gains do not agree with the model checks on test flights. No gain change is available.';return out;}
    const group='twin:'+out.twin.id+':'+input.step,names=Object.keys(best.changes),unit=input.step==='governor'?'rpm':'deg/s';
    // CLAUDE.md: a PID profile that the app cannot find gives no CLI text and no export ("PID profile unknown")
    const profile=ID.profileNumber(d.pidProfile);
    out.recommendations=names.map(name=>({id:group+':'+name,group,groupSize:names.length,node:input.step,area:input.step,
        dataset:d.id,profile,cliProfile:profile===null?null:profile-1,profileLabel:profile===null?'PID profile unknown':'PID profile '+profile,
        scope:'profile',severity:'action',confidence:'predicted',
        parameter:name,from:config.values[name],to:best.changes[name],fromSource:config.sources&&config.sources[name]||'recorded configuration',
        title:'Test the model values',text:'The recorded flight data identifies this helicopter model. The control tests agree with the selected values.',
        rule:`The calculated error decrease is ${improvement.mean.toFixed(3)} ${unit}. Its standard error is ${improvement.se.toFixed(3)} ${unit}.`,
        evidence:[{id:'SYSID',value:improvement.mean,se:improvement.se,unit,n:improvement.n}],
        cli:profile===null?[]:[`profile ${profile-1}`,`set ${name} = ${best.changes[name]}`],controlTune:true,verifiedInFlight:false,
        caveats:[out.limitation],twinId:out.twin.id}));
    out.rows=out.recommendations.map(r=>({name:r.parameter,from:r.from,to:r.to,delta:r.to-r.from,profile:r.profile,source:r.fromSource}));
    out.status='flight-test-required';out.reason='The model checks agree with the selected gain set. Test these values in a new flight.';
    out.flightPlan=proposals.flightPlan(out.recommendations);return out;
}
module.exports={RULES,GAIN_NAMES,sensorContext,closedLoopFit,fitWindows,subPeriod,closedLoopResiduals,governorInputs,governorReplay,governorSample,recordedGainEvidence,recordedGainMask,continuityAssertion,mechanicalCohort,prepareIdentificationInputs,identify,makeTwin,validateTwin,replayTwin,tune,candidates,controllerReplay,sensorReplay,simulate,errorsOf,
    sampleAt,seedController,targetConfig,calibrateController,controllerInputs,scenarioPath,controlBand,closedLoopAgreement,controllerSchedule,
    CHANNELS,STEP_AXES,stepRefusal,recordedOutputs,replayRun,replayRules,prepareReplay,outside,inRange,fitInput};
if(require.main!==module)return;
