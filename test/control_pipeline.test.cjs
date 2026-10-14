'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const pipeline=require('../tools/autotune/control_pipeline.cjs');
const plant=require('../tools/autotune/helicopter_model.cjs');
const firmware=require('../tools/autotune/firmware_controller.cjs');
const ID=require('../tools/autotune/system_id.cjs');

function model(rate=125){return {version:1,kind:'rotational-rotor-body',rate,output:'gyroRAW',rpmExponent:0,
    rotorCoupling:0,reference:{rpm:4000,collective:200,collectiveAbs:200},validatedBandHz:[0,20],
    axes:[0,1,2].map(a=>({frequencyHz:7,damping:.75,actuatorTauS:.008,delayS:.008,
        gain:[0,1,2].map(b=>a===b?400:0),collectiveGain:0,collectiveAbsGain:0,bias:0}))};}

async function fixture(options={}){
    const rate=125,n=rate*(options.seconds||12),values=firmware.defaults();
    for(const axis of ['roll','pitch','yaw'])for(const term of ['i','d','b','o'])values[axis+'_'+term+'_gain']=0;
    Object.assign(values,{pid_looptime:8000,pid_mode:3,cyclic_cross_coupling_gain:0,yaw_collective_ff_gain:0,yaw_cyclic_ff_gain:0,
        pitch_collective_ff_gain:0,yaw_inertia_precomp_gain:0,swash_ring:0});
    for(const axis of ['roll','pitch','yaw']){values[axis+'_p_gain']=20;values[axis+'_f_gain']=100;values[axis+'_gyro_cutoff']=0;}
    Object.assign(values,options.values||{});
    const config={firmwareVersion:'4.6.0',firmwareRevision:firmware.COMMIT,values,unknown:[]},runtime=await firmware.create({config});
    const m=model(rate),state=plant.createState(m,[0,0,0],{u:[0,0,0],hs:4000,coll:200});
    const tri=()=>[0,1,2].map(()=>new Float64Array(n)),u=tri(),y=tri(),sp=tri(),terms=Object.fromEntries(['P','I','D','F','B'].map(k=>[k,tri()]));
    for(let i=0;i<n;i++){
        const phase=options.phase||0,amplitude=options.amplitude||1;
        const setpoint=[0,1,2].map(a=>amplitude*(50*Math.sin(i/rate*(a+1)+phase) + 15*Math.sin(i/rate*(7+a)-phase)+
            (options.commonExcitation?15*Math.sin(2*Math.PI*.5*i/rate+.8*a+phase)+15*Math.sin(2*Math.PI*i/rate+.3*a-phase):0)));
        const response=runtime.step({setpoint,gyro:state.rate.slice(),collective:.2,headspeed:4000,spoolUpRatio:1,
            airborne:true,spooledUp:true,throttle:.5,ttaIncrease:0});
        for(let a=0;a<3;a++){sp[a][i]=setpoint[a];y[a][i]=state.rate[a];u[a][i]=response.u[a];for(const k of Object.keys(terms))terms[k][a][i]=response.terms[k][a];}
        plant.step(m,state,{u:response.u,hs:4000,coll:response.collective*1000});
    }
    const header={...values,rollPID:['p','i','d','f','b'].map(t=>values['roll_'+t+'_gain']),
        pitchPID:['p','i','d','f','b'].map(t=>values['pitch_'+t+'_gain']),yawPID:['p','i','d','f','b'].map(t=>values['yaw_'+t+'_gain']),
        hsi_gain:[values.roll_o_gain,values.pitch_o_gain],looptime:8000,pid_process_denom:1,filter_process_denom:1,frameIntervalPNum:1,frameIntervalPDenom:1,
        gyro_soft_type:0,gyro_lowpass_hz:0,gyro_soft2_type:0,gyro_lowpass2_hz:0,gyro_lowpass_dyn_hz:[0,0],
        gyro_notch_hz:[0,0],gyro_notch_cutoff:[0,0],features:0,dyn_notch_count:0,
        firmwareVersion:'4.6.0','Firmware revision':'Rotorflight 4.6.0 (118e912)',rollBW:[0,0,0],pitchBW:[0,0,0],yawBW:[0,0,0]};
    const w={rate,n,fromS:0,flight:{id:options.flight||'flight1',file:'synthetic',log:0,actualRate:rate,header,craft:'Fireball'},u,gyro:y,sp,...terms,
        hs:new Float64Array(n).fill(4000),coll:new Float64Array(n).fill(200),profileAt:new Uint8Array(n).fill(1),
        extra:{'gyroRAW[0]':y[0],'gyroRAW[1]':y[1],'gyroRAW[2]':y[2],'motor[0]':new Float64Array(n).fill(500),'mixer[3]':new Float64Array(n).fill(200),
            time:Float64Array.from({length:n},(_,i)=>i/rate*1e6)}};
    const d={id:options.configuration||'A',pidProfile:1,values,sources:{},analysed:true,analysedFlightSeconds:n/rate};
    w.originalHeader=header;
    w.recordedConfiguration={id:d.id,profile:1,values,sources:{},assumed:false,
        interval:{log:0,t0:0,t1:n/rate,source:{profile:'header',rate:'header'},assumed:false}};
    const input={items:[{w,configuration:d.id,ctx:{flying:new Uint8Array(n).fill(1)},
        epochs:[{t0:0,t1:n/rate,reasons:[],source:{pid:'header',rate:'header'}}]}],configuration:d,configurationId:d.id,step:'cyclic',
        source:{configuration:d.id},analysis:{datasets:{datasets:[d]},advice:{byDataset:{[d.id]:[]}}}};
    const segment={id:'x',configuration:d.id,flight:w.flight.id,source:{item:0,start:0,end:n},n,rate,u,y,hs:w.hs,coll:w.coll};
    return {input,segment,model:m,config};
}
test('closed-loop simulation runs native firmware against predicted gyro and changes plant response',async()=>{
    const f=await fixture(),before=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    assert.ok(before.baseline.every(x=>x.rmse<.002),JSON.stringify(before.baseline));
    assert.equal(before.actuatorBaseline.mixer.length,4);assert.equal(pipeline.closedLoopAgreement(before).pass,true);
    const after=await pipeline.simulate(f.input,f.segment,f.model,{...f.config,values:{...f.config.values,roll_f_gain:80}});
    assert.ok(after.y[0].some((x,i)=>Math.abs(x-before.y[0][i])>2));
    assert.ok(after.u[0].some((x,i)=>Math.abs(x-before.u[0][i])>.01));
    assert.deepEqual(after.y[1],before.y[1]);
});

test('good closed-loop gyro prediction cannot conceal wrong generated mixer commands',async()=>{
    const f=await fixture(),before=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    f.segment.u=f.segment.u.map(c=>Float64Array.from(c));
    for(let i=1;i<f.segment.n;i++)f.segment.u[0][i]+=.25;
    const mismatched=await pipeline.simulate(f.input,f.segment,f.model,f.config),agreement=pipeline.closedLoopAgreement(mismatched);
    assert.deepEqual(mismatched.y,before.y);assert.equal(agreement.gyroPass,true);
    assert.equal(agreement.actuators.mixer[0].pass,false);assert.ok(agreement.actuators.mixer[0].rmse>.24);
    assert.equal(agreement.pass,false);
});

test('wrong plant gain can pass gyro agreement but fails autonomous mixer agreement',async()=>{
    const values={};for(const axis of ['roll','pitch','yaw']){values[axis+'_p_gain']=axis==='yaw'?50:500;values[axis+'_f_gain']=0;}
    const f=await fixture({values});
    f.model.axes.forEach((axis,a)=>{axis.gain[a]*=2;});
    const result=await pipeline.simulate(f.input,f.segment,f.model,f.config),agreement=pipeline.closedLoopAgreement(result);
    assert.equal(agreement.gyroPass,true,JSON.stringify(result.baseline));
    assert.ok(result.actuatorBaseline.mixer.slice(0,3).every(m=>!m.pass),JSON.stringify(result.actuatorBaseline));
    assert.equal(agreement.pass,false);
});

test('closed-loop servo agreement keeps trim error and requires recorded PWM',async()=>{
    const f=await fixture(),w=f.input.items[0].w;
    f.config.servos={count:4,parameters:Array.from({length:4},()=>[1500,-700,700,500,500,333,0,0]),unknown:[],verified:true};
    const initial=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    assert.equal(initial.actuatorBaseline.missing.length,4);assert.equal(pipeline.closedLoopAgreement(initial).pass,false);
    initial.servoPwm.forEach((c,a)=>{w.extra['servo['+a+']']=Float64Array.from(c);});
    const matched=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    assert.equal(matched.actuatorBaseline.servos.length,4);assert.ok(matched.actuatorBaseline.servos.every(m=>m.pass));
    // The comparison must retain a 40 microsecond trim mismatch even though
    // both channels have the same 1500 microsecond configured pulse center.
    w.extra['servo[0]'].fill(1540);
    const mismatched=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    assert.equal(mismatched.actuatorBaseline.servos[0].absoluteToleranceUs,1);
    assert.equal(mismatched.actuatorBaseline.servos[0].pass,false);
});
test('control-loop error uses the same analysis filter as system identification',()=>{
    const columns=[0,1,2].map(a=>Float64Array.from({length:1000},(_,i)=>i===0?a:20*Math.sin((a+1)*i*.04)+3*Math.cos(i*.9)));
    const filter=ID.analysisFilter(125,20,columns.map(c=>c[0])),expected=columns.map((c,a)=>Float64Array.from(c,x=>filter(a,x)));
    assert.deepEqual(pipeline.controlBand(columns,125,20),expected);
});
test('sensor attenuation cannot hide raw plant rate or envelope violations',async()=>{
    const f=await fixture({values:{roll_p_gain:0,pitch_p_gain:0,yaw_p_gain:0}}),w=f.input.items[0].w;
    Object.assign(w.flight.header,{gyro_soft_type:1,gyro_lowpass_hz:2});
    w.sp.forEach(column=>column.fill(0));
    for(let i=0;i<w.n;i++)w.sp[0][i]=400*Math.sin(2*Math.PI*10*i/w.rate);
    f.model.envelope={rpm:[4000,4000],collective:[200,200],input:[[-2,2],[-2,2],[-2,2]],bodyRate:[[-50,50],[-50,50],[-50,50]]};
    const result=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    assert.ok(Math.max(...result.y[0].subarray(2*w.rate).map(Math.abs))<50,
        JSON.stringify({filteredPeak:Math.max(...result.y[0].subarray(2*w.rate).map(Math.abs)),rawPeak:result.maxRate}));
    assert.ok(result.maxRate>50);
    assert.ok(result.extrapolation>0);
    f.model.axes[0].gain[0]=10000;
    await assert.rejects(pipeline.simulate(f.input,f.segment,f.model,f.config),/simulated rate is more/);
});
test('recorded-controller and sensor parity cannot be replaced by a good plant fit',async()=>{
    const f=await fixture(),good=await pipeline.controllerReplay(f.input,[f.segment],f.config);
    assert.equal(good.pass,true,JSON.stringify(good));
    const bad=await pipeline.controllerReplay(f.input,[f.segment],{...f.config,values:{...f.config.values,roll_f_gain:200}});
    assert.equal(bad.pass,false);
    assert.equal((await pipeline.sensorReplay(f.input,[f.segment])).pass,true);
    f.input.items[0].w.extra['gyroRAW[0]']=Float64Array.from(f.segment.y[0],x=>x*2);
    assert.equal((await pipeline.sensorReplay(f.input,[f.segment])).pass,false);
});
test('saved twin replays recorded inputs without using later measured outputs and rejects changed model files',()=>{
    const m=model(),n=1000,rate=125,hs=new Float64Array(n).fill(4000),coll=new Float64Array(n).fill(200);
    const s={id:'s',rate,n,hs,coll,u:[0,1,2].map(a=>Float64Array.from({length:n},(_,i)=>.1*Math.sin(i*.01*(a+1)))),
        y:[0,1,2].map(()=>new Float64Array(n))};
    const twin=pipeline.makeTwin({source:{configuration:'A'}},{status:'validated',model:m,validation:{},coverage:{}});
    const restored=JSON.parse(JSON.stringify(twin)),first=pipeline.replayTwin(restored,[s]);
    s.y.forEach(x=>x.fill(900,1));assert.deepEqual(pipeline.replayTwin(restored,[s])[0].predicted,first[0].predicted);
    restored.model.axes[0].gain[0]=500;assert.throws(()=>pipeline.replayTwin(restored,[s]),/changed after its checks/);
});
test('an unvalidated model never falls back to rule-based export',async()=>{
    const input={configuration:{id:'A',pidProfile:1,values:{roll_p_gain:50}},configurationId:'A',step:'cyclic',items:[],
        analysis:{datasets:{datasets:[{id:'A',pidProfile:1,analysedFlightSeconds:60,values:{roll_p_gain:50}}]},
            advice:{byDataset:{A:[{id:'p',node:'cyclic',severity:'action',scope:'profile',profile:1,dataset:'A',parameter:'roll_p_gain',
                from:50,to:55,rule:'measured',evidence:[{value:3}],cli:['profile 0','set roll_p_gain = 55']}]}}}};
    const out=await pipeline.tune(input);assert.equal(out.status,'model-required');assert.deepEqual(out.recommendations,[]);assert.deepEqual(out.rows,[]);
});

test('advice from reserved flight measurements cannot change the gain candidate set',()=>{
    const configuration={id:'A',pidProfile:1,analysedFlightSeconds:60,values:{roll_p_gain:50}};
    const input={configuration,step:'cyclic',analysis:{datasets:{datasets:[configuration]},advice:{byDataset:{A:[]}}}};
    const independent=pipeline.candidates(input);
    input.analysis.advice.byDataset.A=[{id:'all-log-result',node:'cyclic',severity:'action',scope:'profile',profile:1,dataset:'A',
        parameter:'roll_p_gain',from:50,to:47,rule:'Measured on all flights.',evidence:[{value:3}],
        cli:['profile 0','set roll_p_gain = 47']}];
    const legacy=require('../tools/autotune/control_tune.cjs').tune({analysis:input.analysis,configuration:'A',step:'cyclic'});
    assert.equal(legacy.rows[0].to,47);
    assert.deepEqual(pipeline.candidates(input),independent);
    assert.ok(independent.every(changes=>changes.roll_p_gain!==47));
});

test('saved twin marks inputs outside any identified input envelope',()=>{
    const m=model(),n=20;
    m.envelope={rpm:[3900,4100],collective:[100,300],input:[[-.2,.2],[-.2,.2],[-.2,.2]],bodyRate:[[-100,100],[-100,100],[-100,100]]};
    const twin=pipeline.makeTwin({source:{configuration:'A'}},{status:'validated',model:m,validation:{},coverage:{}});
    const s={id:'s',rate:125,n,hs:Array(n).fill(4000),coll:Array(n).fill(200),u:[0,1,2].map(()=>Array(n).fill(0)),y:[0,1,2].map(()=>Array(n).fill(0))};
    assert.equal(pipeline.replayTwin(twin,[s])[0].extrapolated,false);
    for(const column of [s.hs,s.coll,s.u[0],s.u[1],s.u[2],s.y[0],s.y[1],s.y[2]]) {
        const previous=column[1];column[1]=10000;
        assert.equal(pipeline.replayTwin(twin,[s])[0].extrapolated,true);
        column[1]=previous;
    }
});

test('controller state respects mode 4 and collective O-term scaling, and RC uses recorded commands',async()=>{
    const f=await fixture(),w=f.input.items[0].w;
    w.I[0].fill(.12);w.I[1].fill(-.08);w.I[2].fill(.04);
    w.extra['axisO[0]']=new Float64Array(w.n).fill(30);w.extra['axisO[1]']=new Float64Array(w.n).fill(-20);
    w.extra['mixer[3]']=new Float64Array(w.n).fill(-250);
    for(let a=0;a<4;a++)w.extra[`rcCommand[${a}]`]=new Float64Array(w.n).fill(100*(a-1));
    const values={...f.config.values,pid_mode:4,roll_i_gain:100,pitch_i_gain:80,yaw_i_gain:40,roll_o_gain:50,pitch_o_gain:40};
    const seed=pipeline.seedController({config:{values},seed(){}},f.input,f.segment);
    assert.deepEqual(seed.axisError,[.12,-.08,.04]);assert.deepEqual(seed.axisOffset,[-.12,.08,0]);
    const sample=pipeline.sampleAt(f.input,f.segment,3,[0,0,0],true,{values});
    assert.deepEqual(sample.rcDeflection,[-.2,0,.2,.4]);assert.equal(sample.previousMixer[3],-.25);
    values.pid_mode=3;
    const legacy=pipeline.seedController({config:{values},seed(){}},f.input,f.segment);
    assert.ok(Math.abs(legacy.axisError[0]-6)<1e-12);assert.ok(Math.abs(legacy.axisOffset[0]+12)<1e-12);
});

test('target headers and stale spans cannot inherit a different configuration',async()=>{
    const a=await fixture(),b=await fixture({configuration:'B'});
    b.input.items[0].stale=[{t0:0,t1:12,reasons:['changed']}];b.input.items[0].w.flight.header.rollPID=[900,900,900,900,900];
    a.input.items.unshift(b.input.items[0]);
    const cfg=pipeline.targetConfig(a.input);
    assert.equal(cfg.values.roll_p_gain,20);assert.equal(cfg.stale,null);
    delete a.input.configuration.values.pid_mode;
    a.input.items[1].w.flight.header.pid_mode=4;
    const missing=pipeline.targetConfig(a.input);
    assert.ok(missing.unknown.includes('pid_mode'));
});

test('calibration reserves entire test flights and separate PID terms detect cancellation',async()=>{
    const f=await fixture({values:{pid_mode:4,roll_d_gain:100,pitch_b_gain:80}}),w=f.input.items[0].w;
    const unknown={...f.config,values:{...f.config.values},unknown:['pid_mode']};delete unknown.values.pid_mode;
    const design={...f.segment,id:'design',fromS:0},testPeriod={...design,id:'reserved',flight:'final-test'};
    const result=await pipeline.calibrateController(f.input,{train:[design],selection:[],test:[testPeriod]},unknown);
    assert.equal(result.status,'identified',JSON.stringify(result.estimates));assert.equal(result.config.values.pid_mode,4);
    assert.equal(result.provenance.flight,design.flight);assert.deepEqual(result.provenance.excludedTestFlights,['final-test']);
    const none=await pipeline.calibrateController(f.input,{train:[design],selection:[],test:[{...testPeriod,flight:design.flight}]},unknown);
    assert.equal(none.status,'insufficient');
    for(let i=0;i<w.n;i++){w.P[0][i]+=.04;w.F[0][i]-=.04;}
    const parity=await pipeline.controllerReplay(f.input,[f.segment],f.config);
    assert.equal(parity.pass,false);assert.ok(parity.rows[0].metrics.every(x=>x.rmse<.008));
    assert.ok(parity.rows[0].terms.some(t=>t.term==='P'&&t.axis===0&&!t.pass));
});

test('pooled recorded configurations qualify their own loops before a frozen counterfactual gain test',async()=>{
    const flights=[];
    for(let i=0;i<15;i++)flights.push(await fixture({flight:'flight-'+i,configuration:i===14?'B':'A',phase:i*.15,
        amplitude:i===14?1:1.3,commonExcitation:true,values:{roll_f_gain:i===14?80:120,pitch_f_gain:i===14?80:120}}));
    const input=flights[14].input;input.items=flights.map(f=>f.input.items[0]);
    const a=flights[0].input.configuration,b=input.configuration;
    input.analysis.datasets.datasets=[a,b];input.options={sysid:{grid:{frequencyHz:[7],damping:[.75],actuatorTauS:[.008],delayS:[.008]},rotorCouplingGrid:[0],yawDecayGrid:[]}};
    const result=await pipeline.tune(input);
    assert.equal(result.status,'flight-test-required',JSON.stringify({status:result.status,reason:result.reason,
        twinReasons:result.twin.reasons,controlReasons:result.twin.controlReasons,controller:result.controller&&{reasons:result.controller.reasons,loop:result.controller.closedLoopParity},search:result.search}));
    assert.ok(result.controller.parity.pass);assert.ok(result.controller.closedLoopParity.every(r=>r.pass));
    assert.deepEqual(new Set(result.controller.parity.rows.map(r=>r.configuration)),new Set(['A','B']));
    assert.ok(result.controller.closedLoopParity.every(r=>r.pass&&r.actuators.mixer.length===4&&r.actuators.pass));
    assert.ok(result.search.holdout.rows.every(r=>r.recordedActuators.pass));
    assert.equal(result.search.baselineKind,'target-controller counterfactual');assert.equal(result.search.holdout.improvement.n,3);
    assert.equal(result.controller.scenarios.seed,result.twin.validation.split.seed);
    assert.ok(result.rows.length>0);assert.ok(result.rows.every(r=>r.name==='roll_f_gain'||r.name==='pitch_f_gain'));
    assert.ok(result.recommendations.every(r=>r.dataset==='B'&&r.verifiedInFlight===false));
});

test('known PID evidence uses the original interval header rather than pooled or materialized sources',async()=>{
    const f=await fixture(),item=f.input.items[0],record=item.w.recordedConfiguration;
    assert.equal(pipeline.recordedGainEvidence(item).known,true);
    item.w.flight.header={...item.w.originalHeader,rollPID:[999,999,999,999,999]};
    assert.equal(pipeline.recordedGainEvidence(item).values.roll_p_gain,20);
    record.sources=Object.fromEntries(pipeline.GAIN_NAMES.map(name=>[name,'header']));
    for(const profile of ['cli','log 4','estimated']) {
        record.interval.source.profile=profile;
        const evidence=pipeline.recordedGainEvidence(item);
        assert.equal(evidence.known,false,profile);assert.equal(evidence.profileSource,profile);
        assert.equal(pipeline.recordedGainMask(item).counts.known,0);
    }
    record.interval.source.profile='header';record.assumed=true;
    assert.equal(pipeline.recordedGainEvidence(item).known,false);
    record.assumed=false;record.values={...record.values,roll_p_gain:21};
    assert.deepEqual(pipeline.recordedGainEvidence(item).mismatched,['roll_p_gain']);
    record.values=f.config.values;
    item.w.originalHeader={...item.w.originalHeader,loggedHeaderFields:Object.keys(item.w.originalHeader).filter(k=>k!=='rollPID'&&k!=='roll_p_gain')};
    const missing=pipeline.recordedGainEvidence(item);
    assert.equal(missing.known,false);assert.ok(missing.missing.includes('roll_p_gain'));
});

test('known gain masks remove only unconfirmed parameter epochs using native timestamps',async()=>{
    const f=await fixture(),item=f.input.items[0],w=item.w;
    item.epochs=[{t0:0,t1:3,reasons:[],source:{pid:'header'}},
        {t0:3,t1:5,reasons:['rearm'],source:{pid:'header'}},
        {t0:5,t1:8,reasons:['switched'],source:{pid:'header',rate:'cli'}},
        {t0:8,t1:12,reasons:['switched'],source:{pid:'cli',rate:'header'}}];
    const check=pipeline.recordedGainMask(item);
    assert.equal(check.counts.flight,w.n);assert.equal(check.counts.known,6*w.rate);
    assert.deepEqual(check.excluded.map(r=>[r.fromS,r.toS,r.reason]),[[3,5,'unconfirmed-parameter-epoch'],[8,12,'unconfirmed-parameter-epoch']]);
    const prepared=pipeline.prepareIdentificationInputs(f.input);
    assert.equal(prepared.coverage.knownGainSamples,6*w.rate);
    assert.equal(prepared.coverage.flightSamples,w.n);assert.equal(prepared.items[0].gainEvidence.known,true);
    assert.deepEqual(prepared.items[0].ctx.eligible,check.mask);
    assert.equal(item.ctx.flying.every(Boolean),true,'the diagnostic source keeps its original flight mask');
    assert.equal(pipeline.controllerInputs(f.input,{...f.segment,source:{item:0,start:3*w.rate},n:w.rate},f.config).pass,false);
    assert.equal(pipeline.controllerInputs(f.input,{...f.segment,source:{item:0,start:5*w.rate},n:w.rate},f.config).pass,true);
    delete item.epochs;assert.equal(pipeline.recordedGainMask(item).counts.known,0);
});

test('historical CLI fields remain unknown even when a materialized header contains the same field name',async()=>{
    const f=await fixture(),item=f.input.items[0];
    item.w.originalHeader={...item.w.originalHeader};delete item.w.originalHeader.pid_mode;
    item.w.flight.header={...item.w.originalHeader,pid_mode:3};
    const config=pipeline.targetConfig(f.input);
    assert.equal(config.values.pid_mode,3);assert.ok(config.unknown.includes('pid_mode'));
    assert.match(config.sources.pid_mode,/unverified historical/);
    assert.equal(pipeline.recordedGainEvidence(item).known,true,'unknown mode is independent of logged gain evidence');
    item.w.recordedConfiguration.interval.source.profile='cli';
    const inherited=pipeline.targetConfig(f.input);
    assert.ok(inherited.unknown.includes('roll_p_gain'));
    const check=await pipeline.controllerReplay(f.input,[f.segment],f.config);
    assert.equal(check.pass,false,'perfect term parity alone does not turn optional CLI gains into recorded gains');
    assert.ok(check.rows[0].coverage.reasons.some(r=>r.includes('recorded PID gains')));
});

test('sensor replay uses the original scheduler phase rather than the later logged raw sample',async()=>{
    const f=await fixture(),w=f.input.items[0].w,rate=w.rate;
    Object.assign(w.flight.header,{looptime:4000,pid_process_denom:2,filter_process_denom:2});
    for(let a=0;a<3;a++){
        w.extra['gyroRAW['+a+']']=Float64Array.from({length:w.n},(_,i)=>30*Math.sin(2*Math.PI*(7+a)*i/rate));
        w.gyro[a]=Float64Array.from({length:w.n},(_,i)=>30*Math.sin(2*Math.PI*(7+a)*(i-.5)/rate));
    }
    const result=await pipeline.sensorReplay(f.input,[f.segment]);
    assert.equal(result.pass,true,JSON.stringify(result));assert.equal(result.rows[0].engine,'upstream-c-wasm');
    assert.equal(result.rows[0].acquisition.offsetSamples,.5);assert.equal(result.rows[0].acquisition.usesFutureRecordedSamples,true);
    assert.ok(result.rows[0].metrics.every(m=>m.relative<.01));
});

test('closed-loop sensor phase uses only simulated raw gyro after initialization',async()=>{
    const f=await fixture(),w=f.input.items[0].w;
    Object.assign(w.flight.header,{looptime:4000,pid_process_denom:2,filter_process_denom:2});
    const before=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    for(let a=0;a<3;a++){w.gyro[a].fill(999,1);w.extra['gyroRAW['+a+']'].fill(-777,1);}
    const after=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    assert.deepEqual(after.y,before.y);assert.deepEqual(after.u,before.u);
});

test('sensor configuration uses original logged globals and rejects parser defaults',async()=>{
    const f=await fixture(),w=f.input.items[0].w;
    w.originalHeader={...w.flight.header};
    w.originalHeader.loggedHeaderFields=Object.keys(w.originalHeader).filter(k=>!k.startsWith('frameInterval'));
    w.originalHeader.loggedHeaderFields.push('P interval');
    w.flight.header={...w.flight.header,gyro_soft_type:1,gyro_lowpass_hz:2};
    const measured=await pipeline.sensorReplay(f.input,[f.segment]);
    assert.equal(measured.pass,true);assert.equal(measured.rows[0].configuration.recordedHeaderJournal,true);
    w.originalHeader.loggedHeaderFields=w.originalHeader.loggedHeaderFields.filter(k=>k!=='features');
    const unknown=await pipeline.sensorReplay(f.input,[f.segment]);
    assert.equal(unknown.pass,false);assert.ok(unknown.rows[0].reasons.includes('The gyro filter configuration has unknown values.'));
});

test('identification follows explicit capture order without falling back to older known gains',async()=>{
    const old=await fixture(),latest=await fixture(),a=old.input.items[0],b=latest.input.items[0];
    a.w.flight.start='2026-10-01T12:00:00Z';b.w.flight.start='2026-10-05T12:00:00Z';b.w.recordedConfiguration.interval.log=1;
    const files=[{fileName:'old.bbl',sha256:'a',logOffset:0,logs:1},{fileName:'latest.bbl',sha256:'b',logOffset:1,logs:1}],
        input={...old.input,items:[a,b],source:{files},options:{sourceCaptureOrder:['a','b']}},prepared=pipeline.prepareIdentificationInputs(input);
    assert.deepEqual(prepared.coverage.mechanicalCohort.selectedKeys,['sha256:b']);
    assert.ok(prepared.items[0].mask.every(x=>x===0));assert.ok(prepared.items[1].mask.every(x=>x===1));
    b.w.recordedConfiguration.interval.source.profile='cli';
    const unknown=pipeline.prepareIdentificationInputs(input);
    assert.equal(unknown.coverage.knownGainSamples,0);assert.deepEqual(unknown.coverage.mechanicalCohort.selectedKeys,['sha256:b']);
    assert.equal(pipeline.targetConfig(input).intervalProvenance.profileSource,'cli');
    input.options={mechanicalCohort:{id:'user-confirmed-old',sourceHashes:['a']}};
    assert.equal(pipeline.prepareIdentificationInputs(input).coverage.knownGainSamples,a.w.n);
    b.w.recordedConfiguration.interval.source.profile='header';input.options.mechanicalCohort.sourceHashes.push('b');
    assert.equal(pipeline.prepareIdentificationInputs(input).coverage.knownGainSamples,a.w.n+b.w.n);
});

test('ambiguous source ordering cannot silently combine mechanical configurations',async()=>{
    const f=await fixture(),a=f.input.items[0],b=structuredClone(a);b.w.recordedConfiguration.interval.log=1;
    f.input.items=[a,b];f.input.source={files:[{fileName:'a',sha256:'a',logOffset:0,logs:1},{fileName:'b',sha256:'b',logOffset:1,logs:1}]};
    a.w.flight.start='0000-01-01T00:00:00Z';b.w.flight.start='2026-10-05T12:00:00Z';
    assert.deepEqual(pipeline.mechanicalCohort(f.input).reasons,['source-order-unknown']);
    assert.equal(pipeline.prepareIdentificationInputs(f.input).coverage.knownGainSamples,0);
    a.w.flight.start=b.w.flight.start;
    assert.deepEqual(pipeline.mechanicalCohort(f.input).reasons,['source-order-unknown']);
    a.w.flight.start='2026-10-10T12:00:00Z';b.w.flight.start='2026-10-01T12:00:00Z';
    f.input.options={sourceCaptureOrder:['a','b']};
    assert.deepEqual(pipeline.mechanicalCohort(f.input).selectedKeys,['sha256:b'],'firmware dates cannot override explicit capture order');
    f.input.options={mechanicalCohort:{sourceHashes:['missing']}};
    assert.deepEqual(pipeline.mechanicalCohort(f.input).reasons,['unknown-explicit-source']);
});

test('source selection precedes capture deduplication and retains the latest file copy',async()=>{
    const f=await fixture(),old=f.input.items[0],latest=structuredClone(old);
    old.w.flight.start=latest.w.flight.start='2026-10-01T12:00:00Z';latest.w.recordedConfiguration.interval.log=1;
    f.input.items=[old,latest];f.input.source={files:[
        {fileName:'old.bbl',sha256:'a',logOffset:0,logs:1,lastRecordedStart:'2026-10-01T12:00:00Z'},
        {fileName:'latest.bbl',sha256:'b',logOffset:1,logs:1,lastRecordedStart:'2026-10-05T12:00:00Z'}]};
    f.input.options={sourceCaptureOrder:['a','b']};
    const prepared=pipeline.prepareIdentificationInputs(f.input),segments=ID.prepareSegments({segments:prepared.items,craft:'Fireball'}).segments;
    assert.ok(segments.length>0);assert.ok(segments.every(s=>s.source.item===1));
    assert.equal(prepared.coverage.knownGainSamples,latest.w.n);
});

test('explicit conditional plant fitting preserves unknown epochs and cannot qualify control changes',async()=>{
    const f=await fixture(),item=f.input.items[0];item.epochs=[{t0:0,t1:12,reasons:['rearm'],source:{pid:'header'}}];
    assert.equal(pipeline.prepareIdentificationInputs(f.input).coverage.selectedSamples,0);
    f.input.options={sysid:{requireKnownGains:false}};
    const prepared=pipeline.prepareIdentificationInputs(f.input);
    assert.equal(prepared.coverage.selectedSamples,item.w.n);assert.equal(prepared.coverage.knownGainSamples,0);
    assert.equal(prepared.items[0].gainEvidence.headerCandidateKnown,true);assert.equal(prepared.items[0].gainEvidence.known,false);
    f.model.validation={status:'validated',controlEligible:true};
    const twin=pipeline.makeTwin(f.input,{status:'validated',model:f.model,ensemble:[f.model],controlEligible:true,confidence:{status:'estimated'}});
    assert.equal(twin.status,'validated');assert.equal(twin.controlEligible,false);assert.equal(twin.recordedGains.conditionalPlantOnly,true);
    assert.match(twin.controlReasons.join(' '),/PID gains/);assert.equal(twin.source.requireKnownGains,false);
    assert.equal(twin.model.validation.controlEligible,false);assert.equal(twin.ensemble[0].validation.controlEligible,false);
    assert.equal(f.model.validation.controlEligible,true,'artifact restrictions must not mutate identification results');
    assert.deepEqual(pipeline.validateTwin(twin),[]);
    const replay=require('../tools/autotune/twin_replay.cjs').replay(twin,[f.segment]);
    assert.equal(replay.controlEligible,false);assert.equal(replay.requireKnownGains,false);
    twin.controlEligible=true;assert.match(pipeline.validateTwin(twin).join(' '),/cannot give control changes/);
});

test('user continuity is source and capture scoped, independent of firmware calendar dates',async()=>{
    const f=await fixture(),first=f.input.items[0],later=structuredClone(first),outside=structuredClone(first),sha='a'.repeat(64);
    [first,later,outside].forEach((item,i)=>{item.w.recordedConfiguration.interval.log=i;item.w.flight.start=i?'0000-01-01T00:00:00Z':'2030-01-01T00:00:00Z';});
    later.epochs=[{t0:0,t1:12,reasons:['rearm','resume'],source:{pid:'header'}}];outside.epochs=structuredClone(later.epochs);
    f.input.items=[first,later,outside];f.input.source={configuration:'A',files:[{fileName:'one',sha256:sha,logOffset:0,logs:3}]};
    f.input.options={parameterContinuity:[{sourceSha256:sha,localLogIndexes:[0,1],scope:'parameters',basis:'user-assertion',statement:'No parameter changes in this capture group.'}]};
    assert.equal(pipeline.recordedGainMask(later,f.input).counts.known,later.w.n);
    assert.equal(pipeline.recordedGainMask(outside,f.input).counts.known,0);
    f.input.options.parameterContinuity[0].sourceSha256='b'.repeat(64);
    assert.equal(pipeline.recordedGainMask(later,f.input).counts.known,0);
    f.input.options.parameterContinuity[0].sourceSha256=sha;
    later.epochs[0].reasons.push('adjusted');assert.equal(pipeline.recordedGainMask(later,f.input).counts.known,0,'recorded adjustments override a continuity assertion');
});

test('confirmed profile continuity uses original header donors and never current CLI gains',async()=>{
    const f=await fixture(),donor=f.input.items[0],switched=structuredClone(donor),sha='c'.repeat(64);
    donor.w.recordedConfiguration.profile=2;donor.w.recordedConfiguration.values={...donor.w.recordedConfiguration.values,yaw_p_gain:45};
    donor.w.originalHeader={...donor.w.originalHeader,yaw_p_gain:45,yawPID:[45,0,0,100,0]};
    switched.w.recordedConfiguration={...switched.w.recordedConfiguration,id:'B',profile:2,values:{...switched.w.recordedConfiguration.values,yaw_p_gain:999},
        interval:{log:1,t0:0,t1:12,source:{profile:'cli',rate:'header'}}};
    switched.configuration='B';switched.epochs=[{t0:0,t1:12,reasons:['switched','rearm'],source:{pid:'cli'}}];switched.stale=switched.epochs;
    f.input.items=[donor,switched];f.input.configuration={...f.input.configuration,id:'B',pidProfile:2,values:switched.w.recordedConfiguration.values};
    f.input.source={configuration:'B',files:[{fileName:'one',sha256:sha,logOffset:0,logs:2}]};
    f.input.options={parameterContinuity:[{sourceSha256:sha,localLogIndexes:[0,1],scope:'parameters',basis:'user-assertion',statement:'No parameter changes in this capture group.'}]};
    const evidence=pipeline.recordedGainEvidence(switched,f.input),config=pipeline.targetConfig(f.input);
    assert.equal(evidence.known,true);assert.equal(evidence.values.yaw_p_gain,45);assert.deepEqual(evidence.declaredMismatched,['yaw_p_gain']);
    assert.equal(pipeline.recordedGainMask(switched,f.input).counts.known,switched.w.n);
    assert.equal(config.values.yaw_p_gain,45);assert.equal(config.stale,null);assert.ok(!config.unknown.includes('yaw_p_gain'));
    assert.match(config.sources.yaw_p_gain,/original log header/);
    switched.w.recordedConfiguration.profile=3;assert.equal(pipeline.recordedGainEvidence(switched,f.input).known,false,'no profile 3 header exists');
    switched.w.recordedConfiguration.profile=2;switched.w.recordedConfiguration.interval.source.profile='header';
    switched.w.originalHeader={...donor.w.originalHeader,yaw_p_gain:46,yawPID:[46,0,0,100,0]};
    switched.w.recordedConfiguration.values={...donor.w.recordedConfiguration.values,yaw_p_gain:46};
    assert.equal(pipeline.recordedGainEvidence(switched,f.input).known,false,'conflicting original headers cannot prove continuity');
    assert.ok(pipeline.recordedGainEvidence(switched,f.input).continuity.conflicts.includes('yaw_p_gain'));
});
