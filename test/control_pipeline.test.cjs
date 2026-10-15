'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const pipeline=require('../tools/autotune/control_pipeline.cjs');
const T=require('../tools/autotune/heli_twin.cjs');
const firmware=require('../tools/autotune/firmware_controller.cjs');
const ID=require('../tools/autotune/system_id.cjs');
const X=require('./twin_fixture.cjs');

// The six-degree-of-freedom twin (heli_twin.cjs) flown by the native Rotorflight controller with band-limited pilot
// inputs (test/twin_fixture.cjs). From the end of the recorded prefix of the period (RULES.warmupS), the rotor speed is
// set to the headspeed sensor state at each sample, as the closed loop of control_pipeline.simulate does. Thus the
// closed loop of the same twin and the same controller agrees with the recorded flight.
const RATE=500;
async function fixture(options={}){
    const rate=options.rate||RATE,seconds=options.seconds||12,values=firmware.defaults();
    for(const axis of ['roll','pitch','yaw'])for(const term of ['i','d','b','o'])values[axis+'_'+term+'_gain']=0;
    Object.assign(values,{pid_looptime:1e6/rate,pid_mode:3,cyclic_cross_coupling_gain:0,yaw_collective_ff_gain:0,yaw_cyclic_ff_gain:0,
        pitch_collective_ff_gain:0,yaw_inertia_precomp_gain:0,swash_ring:0});
    for(const axis of ['roll','pitch','yaw']){values[axis+'_p_gain']=axis==='yaw'?200:20;values[axis+'_f_gain']=100;values[axis+'_gyro_cutoff']=0;}
    Object.assign(values,options.values||{});
    // options.governor: the native governor (executeGovernor) sets the throttle from the start of the flight, the rotor
    // speed is free (no clamp) and the log records the stick positions (rcCommand[0..3] 0, rcCommand[4] 1000)
    const governed=!!options.governor;
    const config={firmwareVersion:'4.6.0',firmwareRevision:firmware.COMMIT,values,unknown:[]},runtime=await firmware.create({config:governed?{...config,executeGovernor:true}:config});
    const start=Math.ceil(pipeline.RULES.warmupS*rate);
    const m=options.model||X.truthModel(options.params);
    const f=X.fly({model:m,rate,seconds,seed:options.seed||1,amplitude:options.amplitude||1,yawAmplitude:options.yawAmplitude,bandHz:options.bandHz,quietS:options.quietS,
        clampFrom:governed?undefined:options.clampFrom===undefined?start:options.clampFrom,governed,
        controller:sample=>{
            // simulate() gives the controller the recorded throttle at each sample
            const r=runtime.step({setpoint:sample.setpoint,gyro:sample.gyro,collective:sample.collective,headspeed:sample.headspeed,spoolUpRatio:1,
                airborne:true,spooledUp:true,throttle:sample.throttle,ttaIncrease:0,
                ...(governed?{rawMotorRpm:sample.headspeed,batteryVoltage:X.VBAT,throttleCommand:1,throttleOff:false,armed:true,rcDeflection:[0,0,0,0]}:{})});
            return {u:r.u,collective:r.collective,terms:r.terms,throttle:governed?r.throttle:undefined};}});
    const n=f.n,header={...values,rollPID:['p','i','d','f','b'].map(t=>values['roll_'+t+'_gain']),
        pitchPID:['p','i','d','f','b'].map(t=>values['pitch_'+t+'_gain']),yawPID:['p','i','d','f','b'].map(t=>values['yaw_'+t+'_gain']),
        hsi_gain:[values.roll_o_gain,values.pitch_o_gain],looptime:1e6/rate,pid_process_denom:1,filter_process_denom:1,frameIntervalPNum:1,frameIntervalPDenom:1,
        gyro_soft_type:0,gyro_lowpass_hz:0,gyro_soft2_type:0,gyro_lowpass2_hz:0,gyro_lowpass_dyn_hz:[0,0],
        gyro_notch_hz:[0,0],gyro_notch_cutoff:[0,0],features:0,dyn_notch_count:0,
        firmwareVersion:'4.6.0','Firmware revision':'Rotorflight 4.6.0 (118e912)',rollBW:[0,0,0],pitchBW:[0,0,0],yawBW:[0,0,0]};
    const w=X.segment(f,{flight:options.flight||'flight1'});
    Object.assign(w.flight,{header,craft:'Fireball'});
    for(let a=0;a<3;a++)w.extra[`gyroRAW[${a}]`]=Float64Array.from(w.gyro[a]);
    if(governed){for(let a=0;a<4;a++)w.extra[`rcCommand[${a}]`]=new Float64Array(n);w.extra['rcCommand[4]']=new Float64Array(n).fill(1000);}
    const d={id:options.configuration||'A',pidProfile:1,values,sources:{},analysed:true,analysedFlightSeconds:n/rate};
    w.originalHeader=header;
    w.recordedConfiguration={id:d.id,profile:1,values,sources:{},assumed:false,
        interval:{log:0,t0:0,t1:n/rate,source:{profile:'header',rate:'header'},assumed:false}};
    const input={items:[{w,configuration:d.id,ctx:{flying:new Uint8Array(n).fill(1)},
        epochs:[{t0:0,t1:n/rate,reasons:[],source:{pid:'header',rate:'header'}}]}],configuration:d,configurationId:d.id,step:'cyclic',
        source:{configuration:d.id},analysis:{datasets:{datasets:[d]},advice:{byDataset:{[d.id]:[]}}}};
    const segment={id:'x',configuration:d.id,flight:w.flight.id,source:{item:0,start:0,end:n},n,rate,u:w.u,y:w.gyro,hs:w.hs,coll:w.extra['mixer[3]']};
    // the same period in the twin run format of twin_fit.cjs and replayTwin
    const run={id:'x',flight:w.flight.id,fromS:0,rate,n,u:w.u,coll:Float64Array.from(f.mix,v=>v/1000),thr:Float64Array.from(f.thr,v=>v/1000),
        vbat:Float64Array.from(f.vbat,v=>v/100),gyro:w.gyro,att:f.att,alt:Float64Array.from(f.alt,v=>v/100),vario:Float64Array.from(f.vario,v=>v/100),hs:f.hs,sp:w.sp};
    return {input,segment,model:m,config,run,start};
}
const maxAbs=c=>c.reduce((x,v)=>Math.max(x,Math.abs(v)),0);
test('closed-loop simulation runs native firmware against the twin and changes the twin response',async()=>{
    const f=await fixture(),before=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    assert.ok(before.baseline.every(x=>x.rmse<.002),JSON.stringify(before.baseline));
    assert.ok(before.actuatorBaseline.mixer.every(x=>x.rmse<1e-5),JSON.stringify(before.actuatorBaseline.mixer));
    assert.equal(before.actuatorBaseline.mixer.length,4);assert.equal(pipeline.closedLoopAgreement(before).pass,true);
    assert.equal(before.initialization.hiddenPlantState,'observer estimate from the recorded prefix measurements');
    const after=await pipeline.simulate(f.input,f.segment,f.model,{...f.config,values:{...f.config.values,roll_f_gain:80}});
    assert.ok(after.y[0].some((x,i)=>Math.abs(x-before.y[0][i])>2));
    assert.ok(after.u[0].some((x,i)=>Math.abs(x-before.u[0][i])>.01));
    // the prefix is recorded data: it does not change with the gains
    assert.deepEqual(after.y[0].subarray(0,f.start),before.y[0].subarray(0,f.start));
});

test('closed-loop rows keep a small trace of the recorded and calculated gyro and mixer',async()=>{
    const f=await fixture(),row=pipeline.closedLoopAgreement(await pipeline.simulate(f.input,f.segment,f.model,f.config)),t=row.trace;
    assert.ok(Math.abs(t.rate-50)<1);assert.equal(t.predictionStartS,f.start/RATE);
    for(const [key,count] of [['setpoint',3],['measuredGyro',3],['predictedGyro',3],['measuredMixer',4],['predictedMixer',4]]){
        assert.equal(t[key].length,count,key);assert.ok(t[key].every(c=>c.length===Math.ceil(f.segment.n/10)),key);
        assert.ok(t[key].every(c=>c.every(v=>v===null||Number.isFinite(v))),key);
    }
    assert.ok(JSON.stringify(t).length<150000);
});

test('good closed-loop gyro prediction cannot conceal wrong generated mixer commands',async()=>{
    const f=await fixture(),before=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    f.segment.u=f.segment.u.map(c=>Float64Array.from(c));
    for(let i=before.initialization.predictionStart;i<f.segment.n;i++)f.segment.u[0][i]+=.25;
    const mismatched=await pipeline.simulate(f.input,f.segment,f.model,f.config),agreement=pipeline.closedLoopAgreement(mismatched);
    assert.deepEqual(mismatched.y,before.y);assert.equal(agreement.gyroPass,true);
    assert.equal(agreement.actuators.mixer[0].pass,false);assert.ok(agreement.actuators.mixer[0].rmse>.24);
    assert.equal(agreement.pass,false);
});

test('a wrong twin with compensating gains can pass gyro agreement but fails autonomous mixer agreement',async()=>{
    // twice the roll flapping gain and half the roll feedforward: about the same roll rate, but half the mixer command
    const f=await fixture({seconds:16}),wrong=JSON.parse(JSON.stringify(f.model));
    wrong.params.gLat*=2;
    const config={...f.config,values:{...f.config.values,roll_f_gain:50,roll_p_gain:10}};
    const result=await pipeline.simulate(f.input,f.segment,wrong,config),agreement=pipeline.closedLoopAgreement(result);
    assert.ok(result.baseline[0].relative<=pipeline.RULES.baselineRelativeRmse,JSON.stringify(result.baseline));
    assert.equal(result.actuatorBaseline.mixer[0].pass,false,JSON.stringify(result.actuatorBaseline.mixer));
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
test('sensor attenuation cannot hide raw twin rate or envelope violations',async()=>{
    const f=await fixture({values:{roll_p_gain:0,pitch_p_gain:0}}),w=f.input.items[0].w;
    Object.assign(w.flight.header,{gyro_soft_type:1,gyro_lowpass_hz:2});
    for(let i=f.start;i<w.n;i++)w.sp[0][i]=400*Math.sin(2*Math.PI*8*i/w.rate);
    const model={...f.model,envelope:{rpm:[3000,5000],collective:[-1,1],input:[[-2,2],[-2,2],[-2,2]],bodyRate:[[-300,300],[-300,300],[-300,300]]}};
    const result=await pipeline.simulate(f.input,f.segment,model,f.config),filtered=maxAbs(result.y[0].subarray(f.start+w.rate));
    assert.ok(filtered<300,JSON.stringify({filteredPeak:filtered,rawPeak:result.maxRate}));
    assert.ok(result.maxRate>300,JSON.stringify({filteredPeak:filtered,rawPeak:result.maxRate}));
    assert.ok(result.extrapolation>0);
    const unstable=JSON.parse(JSON.stringify(model));Object.assign(unstable.params,{gLat:5,tauF:0.005});
    await assert.rejects(pipeline.simulate(f.input,f.segment,unstable,f.config),/simulated rate is more|not finite/);
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
test('controller replay warms filters before initializing I once at the prediction boundary',async()=>{
    const f=await fixture({values:{yaw_i_gain:100,yaw_gyro_cutoff:5,error_decay_time_ground:0,error_decay_time_yaw:0}}),w=f.input.items[0].w;
    const runtime=await firmware.create({config:f.config}),sample={setpoint:[0,0,100],gyro:[0,0,100],collective:.2,headspeed:4000,
        spoolUpRatio:1,airborne:true,spooledUp:true,throttle:.5,ttaIncrease:0};
    for(let i=0;i<4*w.rate;i++)runtime.step(sample);
    runtime.seed({axisError:[0,0,0],axisOffset:[0,0,0]});
    w.govStateAt=new Uint8Array(w.n).fill(4);w.airborneAt=new Uint8Array(w.n).fill(1);
    for(let i=0;i<w.n;i++){
        const out=runtime.step(sample);
        for(let a=0;a<3;a++){
            w.sp[a][i]=sample.setpoint[a];w.gyro[a][i]=sample.gyro[a];w.u[a][i]=out.u[a];
            for(const t of ['P','I','D','F','B'])w[t][a][i]=out.terms[t][a];
        }
    }
    // Seeding before the zero-state filter transient creates a lasting I bias.
    runtime.reset();pipeline.seedController(runtime,f.input,f.segment);let coldError=0,n=0;
    for(let i=0;i<w.n;i++){
        const out=runtime.step(pipeline.sampleAt(f.input,f.segment,i,w.gyro.map(c=>c[i]),true,f.config));
        if(i>=2*w.rate){coldError+=(out.terms.I[2]-w.I[2][i])**2;n++;}
    }
    assert.ok(Math.sqrt(coldError/n)>.02,JSON.stringify({coldRmse:Math.sqrt(coldError/n)}));
    const result=await pipeline.controllerReplay(f.input,[f.segment],f.config),row=result.rows[0];
    assert.equal(result.pass,true,JSON.stringify(row));
    assert.ok(row.terms.find(t=>t.term==='I'&&t.axis===2).rmse<1e-5);
    assert.equal(row.initialization.stateSample,2*w.rate-1);assert.equal(row.initialization.predictionStart,2*w.rate);
    assert.equal(row.initialization.laterRecordedState,false);
    // Later measured I terms are comparison targets, never state corrections.
    w.I[2].fill(.08,2*w.rate+1);
    const changed=await pipeline.controllerReplay(f.input,[f.segment],f.config);
    assert.deepEqual(changed.rows[0].initialState,row.initialState);
    assert.ok(changed.rows[0].terms.find(t=>t.term==='I'&&t.axis===2).rmse>.079);
    assert.equal(changed.pass,false);
});
test('saved twin replays recorded inputs without using later measured outputs and rejects changed model files',async()=>{
    const f=await fixture(),model={...f.model,fit:{rules:{fitRate:500}}};
    const twin=pipeline.makeTwin({source:{configuration:'A'}},{status:'validated',model,validation:{},coverage:{}});
    assert.equal(twin.version,2);assert.equal(twin.model.kind,T.KIND);assert.deepEqual(twin.channels.states,T.STATE);
    assert.deepEqual(twin.channels.outputs,['gyroADC[0]','gyroADC[1]','gyroADC[2]','attitude[0]','attitude[1]','attitude[2]','altitude','vario','headspeed']);
    const restored=JSON.parse(JSON.stringify(twin)),first=pipeline.replayTwin(restored,[f.run])[0];
    assert.ok(first.prediction.rmse[0][first.prediction.points.indexOf(0.1)]<2,JSON.stringify(first.prediction.rmse[0]));
    // measurements after sample k cannot change a prediction that starts at or before k
    const k=Math.round(6*RATE),changed={...f.run,gyro:f.run.gyro.map(c=>Float64Array.from(c,(v,i)=>i>k?v+900:v)),
        att:f.run.att.map(c=>Float64Array.from(c,(v,i)=>i>k?-v:v)),alt:Float64Array.from(f.run.alt,(v,i)=>i>k?v+50:v),hs:Float64Array.from(f.run.hs,(v,i)=>i>k?2000:v)};
    const second=pipeline.replayTwin(restored,[changed])[0],starts=first.trace.segmentStarts.filter(t=>t<=k/RATE);
    assert.ok(starts.length>=3);
    const last=Math.round((starts[starts.length-1]+first.trace.horizonS)*first.trace.rate);
    for(let ch=0;ch<9;ch++)assert.deepEqual(second.trace.predicted[ch].slice(0,last),first.trace.predicted[ch].slice(0,last),T.OUTPUTS[ch]);
    assert.notDeepEqual(second.trace.predicted[0].slice(last),first.trace.predicted[0].slice(last));
    restored.model.params.lb=4000;assert.throws(()=>pipeline.replayTwin(restored,[f.run]),/changed after its checks/);
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

test('saved twin marks inputs outside any identified input envelope',async()=>{
    const f=await fixture({seconds:6}),model={...f.model,envelope:{rpm:[3000,5000],collective:[-1,1],input:[[-2,2],[-2,2],[-2,2]],bodyRate:[[-2000,2000],[-2000,2000],[-2000,2000]]}};
    const twin=pipeline.makeTwin({source:{configuration:'A'}},{status:'validated',model,validation:{},coverage:{}});
    assert.equal(pipeline.replayTwin(twin,[f.run])[0].extrapolated,false);
    for(const key of ['hs','coll','u0','u1','u2','g0','g1','g2']){
        const run={...f.run,u:f.run.u.map(c=>Float64Array.from(c)),gyro:f.run.gyro.map(c=>Float64Array.from(c)),hs:Float64Array.from(f.run.hs),coll:Float64Array.from(f.run.coll)};
        const column=key==='hs'?run.hs:key==='coll'?run.coll:key[0]==='u'?run.u[+key[1]]:run.gyro[+key[1]];
        column[RATE]=column===run.hs?10000:column===run.coll?5:key[0]==='u'?5:5000;
        assert.equal(pipeline.replayTwin(twin,[run])[0].extrapolated,true,key);
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

// Fifteen flights of two recorded configurations (A: 14 flights, B: 1 flight). B is the target configuration.
// The selected periods start after 1 s of settling (system_id RULES.settlingS), so the closed loop starts at 3 s.
// The log does not record the horizontal speed and the observer cannot measure it: the flights start with 1.2 s
// of hover, so that the speed is near zero (the initial speed of the observer) at the start of each period.
let pooledFlights=null;
async function pooled(){
    if(!pooledFlights){pooledFlights=[];
        for(let i=0;i<15;i++)pooledFlights.push(await fixture({flight:'flight-'+i,configuration:i===14?'B':'A',seed:i+1,clampFrom:3*RATE,quietS:1.2,seconds:13,bandHz:1,
            amplitude:i===14?1:1.3,values:{roll_f_gain:i===14?80:120,pitch_f_gain:i===14?80:120}}));}
    const flights=pooledFlights,input={...flights[14].input,configuration:{...flights[14].input.configuration}};
    input.items=flights.map(f=>({...f.input.items[0],w:{...f.input.items[0].w,extra:{...f.input.items[0].w.extra}}}));
    const a=flights[0].input.configuration,b=input.configuration;
    input.analysis={...input.analysis,datasets:{datasets:[a,b]}};input.options={sysid:{stages:[],rules:{minFrequencyGroupS:30}},closedLoopFit:POOLED_CLOSED_LOOP_FIT};
    return input;
}
// The closed-loop refinement of these tests. The pilot inputs of these flights are in a band of 1 Hz: their instrumented
// frequency responses do not agree with the true model (frequency cost 2.7e5, closed-loop cost 3.6e3 for the true model).
// Thus the tests use only the closed-loop residuals (frequency weight 0) and two iterations of each stage.
const POOLED_CLOSED_LOOP_FIT={frequencyWeight:0,stages:pipeline.RULES.closedLoopFit.stages.map(st=>({...st,iterations:2}))};
const tuneReport=result=>JSON.stringify({status:result.status,reason:result.reason,twinReasons:result.twin&&result.twin.reasons,controlReasons:result.twin&&result.twin.controlReasons,
    controller:result.controller&&{reasons:result.controller.reasons,loop:result.controller.closedLoopParity&&result.controller.closedLoopParity.map(r=>({pass:r.pass,metrics:r.metrics}))},search:result.search&&{selected:result.search.selected,holdout:result.search.holdout&&result.search.holdout.pass}});
test('pooled recorded configurations qualify their own loops before a frozen counterfactual gain test',async()=>{
    const input=await pooled(),result=await pipeline.tune(input);
    assert.equal(result.status,'flight-test-required',tuneReport(result));
    assert.ok(result.controller.parity.pass);assert.ok(result.controller.closedLoopParity.every(r=>r.pass));
    assert.deepEqual(new Set(result.controller.parity.rows.map(r=>r.configuration)),new Set(['A','B']));
    assert.ok(result.controller.closedLoopParity.every(r=>r.pass&&r.actuators.mixer.length===4&&r.actuators.pass));
    // each closed-loop row has its period: the start time, the PID profile number and the configuration
    assert.ok(result.controller.closedLoopParity.every(r=>Number.isFinite(r.fromS)&&r.toS>r.fromS&&r.profile===1&&['A','B'].includes(r.configuration)),
        JSON.stringify(result.controller.closedLoopParity.map(r=>[r.fromS,r.profile,r.configuration])));
    // a validated twin keeps the checks of all axes, also for a cyclic step (a partial twin checks only the step axes)
    assert.equal(result.twin.status,'validated');
    assert.ok(result.controller.closedLoopParity.every(r=>JSON.stringify(r.axes)==='[0,1,2]'),'a validated twin checks all axes');
    // the closed-loop refinement uses the design periods only and replaces the model for the closed-loop checks and the search
    const refinement=result.twin.validation.closedLoopFit,design=new Set([...result.controller.scenarios.train,...result.controller.scenarios.selection]);
    assert.equal(refinement.applied,true,JSON.stringify(refinement.design));assert.equal(refinement.testPeriodsUsed,false);
    assert.ok(refinement.windows.count>0&&refinement.windows.ids.every(id=>design.has(id.slice(0,id.lastIndexOf('@')))),JSON.stringify(refinement.windows.ids));
    assert.ok(result.controller.scenarios.test.every(id=>!refinement.windows.ids.some(w=>w.startsWith(id+'@'))));
    assert.ok(refinement.design.after.timeCost<refinement.design.before.timeCost);
    assert.deepEqual(refinement.stages.map(st=>st.stage),['closed-loop yaw','closed-loop cyclic and yaw']);
    assert.ok(Object.keys(refinement.changed).length>0);
    assert.ok(Object.entries(refinement.changed).every(([name,v])=>result.twin.model.params[name]===v.after));
    assert.deepEqual(pipeline.validateTwin(result.twin),[],'the model file includes the refinement and its checks');
    assert.ok(result.twin.model.fit.closedLoop&&result.twin.model.fit.closedLoop.stages.length===2);
    // the governor: the log has no throttle stick, thus the closed loop uses the recorded headspeed
    assert.equal(result.controller.governor.active,false);assert.match(result.controller.governor.reasons.join(' '),/rcCommand\[4\]/);
    assert.equal(result.twin.channels.governor,'recorded headspeed');assert.equal(result.twin.governor.active,false);
    assert.equal(result.controller.sensorParity.available,true);assert.equal(result.controller.sensorParity.pass,true);
    assert.ok(result.search.holdout.rows.every(r=>r.recordedActuators.pass));
    assert.equal(result.search.baselineKind,'target-controller counterfactual');assert.equal(result.search.holdout.improvement.n,3);
    assert.equal(result.controller.scenarios.seed,result.twin.validation.split.seed);
    assert.ok(result.rows.length>0);assert.ok(result.rows.every(r=>r.name==='roll_f_gain'||r.name==='pitch_f_gain'));
    assert.ok(result.recommendations.every(r=>r.dataset==='B'&&r.verifiedInFlight===false));
    assert.ok(result.recommendations.every(r=>r.profile===1&&r.cliProfile===0&&r.cli[0]==='profile 0'&&r.profileLabel==='PID profile 1'));
    assert.equal(result.twin.version,2);assert.equal(result.twin.model.kind,T.KIND);
    assert.deepEqual(result.twin.eligibleSteps,['cyclic','cycomp','tail','tailcomp']);
    assert.ok(result.twin.predictions.every(p=>p.profile===1));
    assert.ok(result.controller.closedLoopParity.every(r=>r.trace&&r.trace.predictedGyro.length===3&&r.trace.measuredMixer.length===4));
});
test('a log without gyroRAW tunes: the gyro filter check is not applicable and its reason stays visible',async()=>{
    const input=await pooled();
    for(const item of input.items)for(let a=0;a<3;a++)delete item.w.extra[`gyroRAW[${a}]`];
    const result=await pipeline.tune(input),sensorParity=result.controller.sensorParity;
    assert.equal(result.status,'flight-test-required',tuneReport(result));
    assert.equal(sensorParity.pass,true);assert.equal(sensorParity.available,false);assert.equal(sensorParity.applicable,false);
    assert.ok(sensorParity.reasons.some(r=>/gyroRAW/.test(r)),JSON.stringify(sensorParity.reasons));
    assert.ok(sensorParity.rows.length>0&&sensorParity.rows.every(r=>r.available===false&&r.reasons.length===1));
    assert.ok(result.controller.closedLoopParity.every(r=>r.pass));
    assert.ok(result.recommendations.length>0);
});
test('an unknown PID profile gives no CLI text for a model recommendation',async()=>{
    const input=await pooled();input.configuration.pidProfile=null;
    input.analysis.datasets.datasets=[input.analysis.datasets.datasets[0],input.configuration];
    const result=await pipeline.tune(input);
    assert.equal(result.status,'flight-test-required',tuneReport(result));
    assert.ok(result.recommendations.length>0);
    assert.ok(result.recommendations.every(r=>r.profile===null&&r.cliProfile===null&&r.profileLabel==='PID profile unknown'&&r.cli.length===0),
        JSON.stringify(result.recommendations.map(r=>[r.profile,r.cliProfile,r.cli])));
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
    Object.assign(w.flight.header,{looptime:1e6/(2*rate),pid_process_denom:2,filter_process_denom:2});
    for(let a=0;a<3;a++){
        w.extra['gyroRAW['+a+']']=Float64Array.from({length:w.n},(_,i)=>30*Math.sin(2*Math.PI*(7+a)*i/rate));
        w.gyro[a]=Float64Array.from({length:w.n},(_,i)=>30*Math.sin(2*Math.PI*(7+a)*(i-.5)/rate));
    }
    const result=await pipeline.sensorReplay(f.input,[f.segment]);
    assert.equal(result.pass,true,JSON.stringify(result));assert.equal(result.rows[0].engine,'upstream-c-wasm');
    assert.equal(result.rows[0].acquisition.offsetSamples,.5);assert.equal(result.rows[0].acquisition.usesFutureRecordedSamples,true);
    assert.ok(result.rows[0].metrics.every(m=>m.relative<.01));
});

test('native closed-loop response follows the firmware servo task before each logger sample',async()=>{
    // Independently schedule task events from fc/core.c (118e912), including
    // denominator 3's early mixer and denominators 6-8's later PID task.
    const taskPhases=[null,[0,0,0,0],[0,1,1,1],[0,0,1,1],[0,1,1,2],
        [0,1,2,3],[1,2,3,4],[1,2,3,5],[2,3,4,6]];
    for(let denom=1;denom<=8;denom++){
        const f=await fixture({seconds:4}),w=f.input.items[0].w,rate=w.rate,start=f.start,
            [,mixerAt,actuatorAt,loggerAt]=taskPhases[denom];
        Object.assign(w.flight.header,{looptime:1e6/(rate*denom),pid_process_denom:denom,filter_process_denom:denom});
        const m=f.model,sim=T.createSim(m,rate*denom),runtime=await firmware.create({config:f.config}),
            thr=i=>w.extra['motor[0]'][i]*.001,vbat=i=>w.extra.Vbat[i]*.01;
        T.initState(sim,{gyro:[0,0,0],att:[0,0,0],hs:m.refRpm,alt:10,vario:0,thr:thr(0)});
        let input=null,feedback,response;
        for(let frame=0;frame<w.n;frame++){
            const setpoint=[0,1,2].map(a=>frame<start?0:70*Math.sin((frame/rate-2)*(9+3*a)));
            for(let tick=0;tick<denom;tick++){
                if(tick===0){
                    // the gyro sample of the frame; the rotor speed follows the recorded headspeed in the closed loop
                    if(frame>=start)sim.x[15]=sim.x[30];
                    const o=T.outputs(sim.x);feedback=[o[0],o[1],o[2]];
                    w.hs[frame]=o[8];w.extra.altitude[frame]=o[6]*100;w.extra.vario[frame]=o[7]*100;
                    for(let a=0;a<3;a++)w.extra[`attitude[${a}]`][frame]=o[3+a]*10;
                    // the PID task uses only this gyro sample, so its tick inside the frame does not change the result
                    response=runtime.step({setpoint,gyro:feedback,collective:w.coll[frame]*.001,headspeed:w.hs[frame],
                        spoolUpRatio:1,airborne:true,spooledUp:true,throttle:thr(frame),ttaIncrease:0});
                    if(!input){input={u:response.u.slice(),coll:response.collective,thr:thr(0),vbat:vbat(0)};for(let k=0;k<sim.maxDelay;k++)T.push(sim,input);sim.count=0;}
                }
                if(tick===actuatorAt)input={u:response.u.slice(),coll:response.collective,thr:thr(frame),vbat:vbat(frame)};
                if(tick===loggerAt){
                    for(let a=0;a<3;a++){
                        w.sp[a][frame]=setpoint[a];w.gyro[a][frame]=feedback[a];w.u[a][frame]=response.u[a];
                        for(const term of ['P','I','D','F','B'])w[term][a][frame]=response.terms[term][a];
                    }
                    w.extra['mixer[3]'][frame]=response.collective*1000;
                    w.extra.time[frame]=(frame*denom+tick)/(rate*denom)*1e6;
                }
                T.push(sim,input);T.step(sim);
            }
        }
        assert.ok(mixerAt<=actuatorAt);
        const result=await pipeline.simulate(f.input,f.segment,f.model,f.config);
        assert.deepEqual(result.scheduler,{gyroTicks:denom,filterTick:0,pidTick:taskPhases[denom][0],mixerTick:mixerAt,
            actuatorTick:actuatorAt,loggerTick:loggerAt,sourceRevision:firmware.COMMIT,commandBoundary:'servo output task'});
        assert.ok(result.baseline.every(m=>m.rmse<.002),JSON.stringify({denom,errors:result.baseline}));
        assert.ok(result.actuatorBaseline.mixer.every(m=>m.rmse<.00001),JSON.stringify({denom,mixer:result.actuatorBaseline.mixer}));
    }
});

test('closed-loop forecast uses no measured future gyro, attitude, barometer, PID states or actuator outputs',async()=>{
    const f=await fixture({values:{roll_i_gain:30,yaw_i_gain:30,roll_gyro_cutoff:30,yaw_gyro_cutoff:30}}),w=f.input.items[0].w;
    Object.assign(w.flight.header,{looptime:1e6/(2*w.rate),pid_process_denom:2,filter_process_denom:2});
    f.config.servos={count:4,parameters:Array.from({length:4},()=>[1500,-700,700,500,500,333,0,0]),unknown:[],verified:true};
    for(let a=0;a<3;a++)w.extra['axisO['+a+']']=new Float64Array(w.n);
    for(let a=0;a<4;a++)w.extra['servo['+a+']']=new Float64Array(w.n).fill(1500);
    const before=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    const start=before.initialization.predictionStart;
    assert.equal(start,2*w.rate);assert.equal(before.initialization.stateSample,start-1);
    assert.equal(before.initialization.sensorPrefixOnly,true);
    assert.equal(before.initialization.laterRecordedState,false);
    for(let a=0;a<3;a++){
        w.gyro[a].fill(999,start);w.extra['gyroRAW['+a+']'].fill(-777,start);w.u[a].fill(5,start);
        for(const t of ['P','I','D','F','B'])w[t][a].fill(99,start);
        w.extra['axisO['+a+']'].fill(999,start);w.extra['attitude['+a+']'].fill(1234,start);
    }
    w.extra.altitude.fill(-5000,start);w.extra.vario.fill(3000,start);
    for(let a=0;a<4;a++)w.extra['servo['+a+']'].fill(5000,start);
    w.extra['mixer[3]'].fill(8000,start);
    const after=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    assert.deepEqual(after.y,before.y);assert.deepEqual(after.u,before.u);assert.deepEqual(after.collective,before.collective);
    assert.deepEqual(after.servoPwm,before.servoPwm);assert.equal(after.maxRate,before.maxRate);
    assert.notDeepEqual(after.baseline,before.baseline,'future measurements are still comparison targets');
    assert.equal(pipeline.closedLoopAgreement(after).pass,false);
    // The preceding frame is an explicitly allowed initial-condition input.
    w.gyro[0][start-1]+=20;
    const changedPrefix=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    assert.notDeepEqual(changedPrefix.y,before.y);
    w.gyro[0][start-1]-=20;
    // The headspeed and the throttle are recorded inputs of the closed loop (the governor is not calculated).
    w.hs.fill(3600,start);
    const slower=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    assert.notDeepEqual(slower.y,before.y);
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

test('identification propagates verified source membership and ignores masked older sources',async()=>{
    const f=await fixture(),first=f.input.items[0],later=structuredClone(first),oldHash='a'.repeat(64),newHash='b'.repeat(64);
    later.w.flight.log=1;later.w.recordedConfiguration.interval.log=1;
    first.w.flight.start=later.w.flight.start='2026-10-05T00:00:00Z';
    f.input.items=[first,later];f.input.source={files:[
        {fileName:'old.bbl',sha256:oldHash,verifiedBytes:true,logOffset:0,logs:1},
        {fileName:'new.bbl',sha256:newHash,verifiedBytes:true,logOffset:1,logs:1}]};
    f.input.options={sourceCaptureOrder:[oldHash,newHash]};
    const prepared=pipeline.prepareIdentificationInputs(f.input),identified=ID.prepareSegments({segments:prepared.items});
    assert.equal(prepared.items[1].source.file.sha256,newHash);assert.equal(prepared.items[1].source.localLogIndex,0);
    assert.ok(identified.segments.length>0);assert.ok(identified.segments.every(s=>s.flight===`source:${newHash}:log:0`));
    assert.equal(identified.coverage.deduplication.sourceGroupingUnresolved,false);
    assert.deepEqual(identified.coverage.deduplication.sourceHashes,[newHash]);
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
    const replay=require('../tools/autotune/twin_replay.cjs').replay(twin,[f.run]);
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

test('a low-rate saved trace replays without a later sample: origins are on recorded samples and inputs are held',async()=>{
    const f=await fixture(),model={...f.model,fit:{rules:{fitRate:500,originEveryS:1}}};
    const twin=pipeline.makeTwin({source:{configuration:'A'}},{status:'validated',model,validation:{},coverage:{}});
    // a saved trace: every fifth sample, at a rate that is not a whole fraction of the fit rate (497.4 Hz / 5)
    const rate=99.48,pick=c=>Float64Array.from({length:Math.floor(f.run.n/5)},(_,i)=>c[5*i]),n=Math.floor(f.run.n/5);
    const low={...f.run,rate,n,u:f.run.u.map(pick),coll:pick(f.run.coll),thr:pick(f.run.thr),vbat:pick(f.run.vbat),gyro:f.run.gyro.map(pick),
        att:f.run.att.map(pick),alt:pick(f.run.alt),vario:pick(f.run.vario),hs:pick(f.run.hs),sp:f.run.sp.map(pick)};
    const run=pipeline.replayRun(low,500),k=run.upsample,rules=pipeline.replayRules(Object.assign({},require('../tools/autotune/twin_fit.cjs').RULES,model.fit.rules),run);
    assert.equal(k,6);
    for(const name of ['warmupS','originEveryS','horizonS']){const steps=rules[name]*run.rate/k;assert.ok(Math.abs(steps-Math.round(steps))<1e-9,name);}
    // the measurements are only at recorded samples, the inputs hold the last recorded value (no interpolation)
    for(let j=0;j<run.n;j++){
        assert.equal(Number.isNaN(run.gyro[0][j]),j%k!==0);
        assert.equal(run.u[0][j],low.u[0][Math.floor(j/k)]);
    }
    const first=pipeline.replayTwin(twin,[low])[0],starts=first.trace.segmentStarts;
    assert.equal(first.upsample,6);assert.equal(first.prediction.points.indexOf(0.1)>=0,true);
    assert.ok(starts.length>=3&&starts.every(t=>Math.abs(t*rate-Math.round(t*rate))<1e-6),JSON.stringify(starts));
    assert.ok(first.prediction.rmse[0][first.prediction.points.indexOf(0.1)]<10,JSON.stringify(first.prediction.rmse[0]));
    // a change of the samples after an origin cannot change the prediction from that origin
    for(const origin of starts.slice(0,3)){
        const after=i=>i>origin*rate+1e-9,change=c=>Float64Array.from(c,(v,i)=>after(i)?v+700:v);
        const changed={...low,gyro:low.gyro.map(change),att:low.att.map(c=>Float64Array.from(c,(v,i)=>after(i)?-v:v)),alt:change(low.alt),vario:change(low.vario),hs:change(low.hs)};
        const second=pipeline.replayTwin(twin,[changed])[0],from=Math.round(origin*first.trace.rate),to=Math.round((origin+first.trace.horizonS)*first.trace.rate);
        for(let ch=0;ch<9;ch++)assert.deepEqual(second.trace.predicted[ch].slice(from+1,to+1),first.trace.predicted[ch].slice(from+1,to+1),`${T.OUTPUTS[ch]} from ${origin} s`);
    }
});
test('a replay does not interpolate the heading or the roll across the wrap',()=>{
    const n=40,att=[0,1,2].map(a=>Float64Array.from({length:n},(_,i)=>a===1?0:(i%2?1795:-1795)));
    const ones=new Float64Array(n).fill(1),run={id:'w',rate:100,n,u:[ones,ones,ones],coll:ones,thr:ones,vbat:ones,gyro:[ones,ones,ones],att,alt:ones,vario:ones,hs:ones};
    const r=pipeline.replayRun(run,500);
    for(const a of [0,2])assert.ok(Array.from(r.att[a]).every(v=>Number.isNaN(v)||Math.abs(v)===1795),'no value between -179.5 and 179.5 deg');
});
test('relative errors remove the mean: a trim offset cannot hide a wrong moving part, and the absolute limit stays',()=>{
    const n=2000,trim=Float64Array.from({length:n},(_,i)=>.3+.01*Math.sin(i/20)),wrong=Float64Array.from({length:n},(_,i)=>.3-.01*Math.sin(i/20));
    const [e]=pipeline.errorsOf([trim],[wrong]);
    assert.ok(e.relative>1.9,JSON.stringify(e),'the opposite moving part is an error of about 2 times its size');
    assert.ok(Math.sqrt(e.rmse**2*n/trim.reduce((s,v)=>s+v*v,0))<.1,'a power about zero would hide it');
    assert.ok(e.rmse<pipeline.RULES.controllerAbsoluteRmse*2);
    const [same]=pipeline.errorsOf([trim],[Float64Array.from(trim)]);assert.equal(same.rmse,0);assert.equal(same.relative,0);
    const flat=new Float64Array(n).fill(.3),[constant]=pipeline.errorsOf([flat],[Float64Array.from(flat,v=>v+.001)]);
    assert.ok(constant.rmse<=pipeline.RULES.controllerAbsoluteRmse,'a constant channel passes on the absolute limit');
});
test('closed-loop agreement of a step uses the body axes of that step',()=>{
    const metric=relative=>({rmse:1,relative,n:10}),mixer=pass=>({rmse:pass?0:1,relative:pass?0:1,pass});
    const row={id:'r',baseline:[metric(.1),metric(.1),metric(.9)],trace:null,
        actuatorBaseline:{mixer:[mixer(true),mixer(true),mixer(false),mixer(true)],servos:[],missing:[],pass:false}};
    assert.equal(pipeline.closedLoopAgreement(row).pass,false);
    const cyclic=pipeline.closedLoopAgreement(row,pipeline.STEP_AXES.cyclic);
    assert.equal(cyclic.pass,true);assert.deepEqual(cyclic.axes,[0,1]);assert.equal(cyclic.actuators.mixer[2].gated,false);
    assert.equal(pipeline.closedLoopAgreement(row,pipeline.STEP_AXES.tail).pass,false);
    row.actuatorBaseline.mixer[3]=mixer(false);
    assert.equal(pipeline.closedLoopAgreement(row,pipeline.STEP_AXES.cyclic).pass,false,'the collective mixer is in each step');
});
test('sensor replay without gyroRAW is not applicable and keeps its reason',async()=>{
    const f=await fixture();for(let a=0;a<3;a++)delete f.input.items[0].w.extra[`gyroRAW[${a}]`];
    const result=await pipeline.sensorReplay(f.input,[f.segment]);
    assert.equal(result.pass,true);assert.equal(result.available,false);assert.equal(result.applicable,false);
    assert.match(result.reasons.join(' '),/gyroRAW/);
});
test('the twin names its collective input field and drops Vbat when the log does not record it',async()=>{
    const f=await fixture(),model={...f.model,collectiveField:'setpoint[3]',vbatRecorded:false};
    const twin=pipeline.makeTwin({source:{configuration:'A'}},{status:'validated',model,validation:{},coverage:{}});
    assert.deepEqual(twin.channels.inputs,['mixer[0]','mixer[1]','mixer[2]','setpoint[3]','motor[0]']);assert.equal(twin.channels.collectiveField,'setpoint[3]');
    const measured=pipeline.makeTwin({source:{configuration:'A'}},{status:'validated',model:{...f.model,collectiveField:'mixer[3]'},validation:{},coverage:{}});
    assert.deepEqual(measured.channels.inputs,['mixer[0]','mixer[1]','mixer[2]','mixer[3]','motor[0]','Vbat']);
    // the closed loop of a twin without the battery voltage uses the constant 1 of twin_fit.prepareRun
    f.input.items[0].w.extra.Vbat=new Float64Array(f.input.items[0].w.n);
    const row=await pipeline.simulate(f.input,f.segment,{...f.model,vbatRecorded:false},f.config);
    assert.ok(row.baseline.every(x=>Number.isFinite(x.rmse)));
});

test('the closed loop gives the controller the recorded throttle at each sample, not a held value',async()=>{
    const f=await fixture(),w=f.input.items[0].w,seen=[],create=firmware.create;
    for(let i=f.start;i<w.n;i++)w.extra['motor[0]'][i]=500+100*Math.sin(i/50);
    firmware.create=async options=>{const runtime=await create(options),step=runtime.step;runtime.step=sample=>{seen.push(sample.throttle);return step(sample);};return runtime;};
    try{await pipeline.simulate(f.input,f.segment,f.model,f.config);}finally{firmware.create=create;}
    const closed=seen.slice(-(w.n-f.start));
    assert.equal(closed.length,w.n-f.start);
    closed.forEach((v,j)=>assert.ok(Math.abs(v-w.extra['motor[0]'][f.start+j]*.001)<1e-12,`sample ${f.start+j}`));
});
test('controller term parity uses the relative error of errorsOf (the power of the recorded term about its mean)',async()=>{
    const f=await fixture(),w=f.input.items[0].w,native=Float64Array.from(w.F[0]);
    for(let i=0;i<w.n;i++)w.F[0][i]+=.5+.02*Math.sin(i/9);
    const row=(await pipeline.controllerReplay(f.input,[f.segment],f.config)).rows[0],term=row.terms.find(t=>t.term==='F'&&t.axis===0);
    const start=row.initialization.predictionStart,actual=Float64Array.from(w.F[0].subarray(start)),predicted=native.subarray(start);
    const [expected]=pipeline.errorsOf([actual],[predicted]),power=actual.reduce((t,v)=>t+v*v,0),error=actual.reduce((t,v,j)=>t+(v-predicted[j])**2,0);
    assert.ok(Math.abs(term.relative/expected.relative-1)<.01,JSON.stringify({term,expected}));
    assert.ok(term.relative>2*Math.sqrt(error/power),'the mean of the recorded term is not in the reference power');
    assert.equal(term.pass,false);
});

// The native governor in the closed loop (simulate with executeGovernor). These flights are flown by the native governor
// from the start of the log, thus a period that starts at the log start has the governor state of the flight.
async function governedFixture(options={}){
    return fixture({governor:true,seconds:8,...options,values:{gov_mode:3,gov_headspeed:X.RPM0,'main_rotor_gear_ratio[0]':1,'main_rotor_gear_ratio[1]':1,
        gov_p_gain:60,gov_i_gain:80,gov_f_gain:0,gov_startup_time:10,gov_spoolup_time:10,...(options.values||{})}});
}
test('the native governor drives the twin rotor speed when the log records its inputs and its parity passes',async()=>{
    const f=await governedFixture(),w=f.input.items[0].w,config={...f.config,executeGovernor:true};
    assert.deepEqual(pipeline.governorInputs(f.input,f.segment,f.config).reasons,[]);
    const parity=await pipeline.governorReplay(f.input,[f.segment],()=>f.config);
    assert.equal(parity.pass,true,JSON.stringify(parity));assert.ok(parity.rows[0].throttle.rmse<1e-6);assert.equal(parity.rows[0].state,4);
    const row=await pipeline.simulate(f.input,f.segment,f.model,config);
    assert.equal(row.initialization.rotorSpeed,'calculated: the native governor throttle drives the twin');
    assert.ok(row.governor.headspeed.rmse<1,JSON.stringify(row.governor.headspeed));assert.ok(row.governor.throttle.rmse<1e-3,JSON.stringify(row.governor.throttle));
    assert.ok(row.baseline.every(m=>m.rmse<.01),JSON.stringify(row.baseline));
    assert.equal(pipeline.closedLoopAgreement(row).pass,true);
    // the rotor speed is not the recorded headspeed: a recorded headspeed change after the prefix does not enter the loop
    const recorded=Float64Array.from(w.hs);w.hs.fill(3000,f.start);
    const same=await pipeline.simulate(f.input,{...f.segment,hs:w.hs},f.model,config);
    assert.deepEqual(same.headspeed.subarray(f.start),row.headspeed.subarray(f.start));
    assert.equal(pipeline.closedLoopAgreement(same).governor.pass,false,'the recorded headspeed stays a comparison target');
    w.hs.set(recorded);
    // a governor gain changes the calculated headspeed
    const softer=await pipeline.simulate(f.input,f.segment,f.model,{...config,values:{...config.values,gov_p_gain:10,gov_i_gain:10}});
    assert.ok(softer.headspeed.some((v,i)=>i>=f.start&&Math.abs(v-row.headspeed[i])>1));
    // a changed recorded throttle in the prefix fails the governor parity
    for(let i=0;i<f.start;i++)w.extra['motor[0]'][i]+=100;
    const wrong=await pipeline.governorReplay(f.input,[f.segment],()=>f.config);
    assert.equal(wrong.pass,false);assert.match(wrong.reasons.join(' '),/does not agree with the recorded throttle/);
});
test('without the throttle stick the governor is not calculated and the closed loop uses the recorded headspeed',async()=>{
    const f=await governedFixture(),w=f.input.items[0].w;delete w.extra['rcCommand[4]'];
    const path=pipeline.governorInputs(f.input,f.segment,f.config);
    assert.equal(path.pass,false);assert.match(path.reasons.join(' '),/"rcCommand\[4\]"/);
    await assert.rejects(pipeline.simulate(f.input,f.segment,f.model,{...f.config,executeGovernor:true}),/rcCommand\[4\]/);
    const row=await pipeline.simulate(f.input,f.segment,f.model,f.config);
    assert.equal(row.governor,null);assert.equal(row.initialization.rotorSpeed,'recorded headspeed at each log sample');
    assert.deepEqual(Array.from(row.headspeed.subarray(f.start)),Array.from(w.hs.subarray(f.start)));
});
test('a governor step without the governor path is not supported and gives its reasons',async()=>{
    const input=await pooled();input.step='governor';input.options.closedLoopFit={stages:[]};
    const result=await pipeline.tune(input);
    assert.equal(result.status,'unsupported-loop',tuneReport(result));
    assert.equal(result.controller.governor.active,false);assert.match(result.controller.governor.reasons.join(' '),/rcCommand\[4\]/);
    assert.equal(result.twin.governor.active,false);assert.deepEqual(result.recommendations,[]);
});

test('a partial twin tunes the cyclic step and refuses the tail step with the yaw reason',async()=>{
    // the reserved test flights have a tail authority 1.5 times that of the fit flights: the yaw response of the twin does not
    // agree with them, thus the twin is partial (cyclic steps only)
    const input=await pooled(),spec=pipeline.fitInput(input),split=ID.splitSegments(ID.prepareSegments(spec).segments,spec.options),
        testFlights=new Set(split.test.map(s=>s.flight));
    assert.ok(testFlights.size>=3);
    for(let i=0;i<input.items.length;i++){const id=input.items[i].w.flight.id;if(!testFlights.has(id))continue;const k=+id.split('-')[1];
        const f=await fixture({flight:id,configuration:k===14?'B':'A',seed:k+1,clampFrom:3*RATE,quietS:1.2,seconds:13,bandHz:1,params:{nt:230},
            amplitude:k===14?1:1.3,values:{roll_f_gain:k===14?80:120,pitch_f_gain:k===14?80:120}});
        input.items[i]={...f.input.items[0],w:{...f.input.items[0].w,extra:{...f.input.items[0].w.extra}}};}
    const tail=await pipeline.tune({...input,step:'tail'});
    assert.equal(tail.status,'model-rejected',tuneReport(tail));assert.equal(tail.twin.status,'partial',tuneReport(tail));
    assert.deepEqual(tail.twin.eligibleSteps,['cyclic','cycomp']);
    assert.match(tail.reason,/yaw response of the helicopter model does not agree with the test flights/);
    assert.ok(!tail.twin.controlReasons.some(r=>/cyclic|cycomp|tail/.test(r)),'no raw step keys in the reasons');
    const cyclic=await pipeline.tune({...input,step:'cyclic'});
    assert.equal(cyclic.status,'flight-test-required',tuneReport(cyclic));assert.ok(cyclic.recommendations.length>0);
    assert.ok(cyclic.controller.closedLoopParity.every(r=>JSON.stringify(r.axes)==='[0,1]'),'a partial twin checks the axes of the step');
    assert.ok(cyclic.controller.closedLoopParity.every(r=>r.pass));
    assert.ok(cyclic.recommendations.every(r=>/^(roll|pitch)_/.test(r.parameter)));
});
test('the tail refusal text tells if the yaw response was not measured or does not agree',()=>{
    const fit=measured=>({validation:{assessment:{frequency:[{},{},{measured,pass:false}]}}});
    assert.match(pipeline.stepRefusal('tail',fit(false)),/do not have sufficient yaw inputs.*Fly yaw inputs/);
    assert.match(pipeline.stepRefusal('tailcomp',fit(true)),/yaw response of the helicopter model does not agree with the test flights/);
    assert.doesNotMatch(pipeline.stepRefusal('tail',fit(true)),/Fly yaw inputs/);
    assert.match(pipeline.stepRefusal('cyclic',fit(true)),/roll and pitch checks/);
});

test('a replay fills a missing barometer with NaN and uses the constant battery voltage of the twin before its check',async()=>{
    const f=await fixture(),twin=pipeline.makeTwin({source:{configuration:'A'}},{status:'validated',model:{...f.model,vbatRecorded:false},validation:{},coverage:{}});
    const run={...f.run};delete run.alt;delete run.vario;delete run.vbat;
    const [result]=pipeline.replayTwin(twin,[run]);
    assert.ok(result.prediction.rmse[0].every(Number.isFinite));
    assert.ok(result.prediction.rmse[6].every(v=>v===null||Number.isNaN(v)),'no altitude score without the barometer');
    const measured=pipeline.makeTwin({source:{configuration:'A'}},{status:'validated',model:f.model,validation:{},coverage:{}});
    assert.throws(()=>pipeline.replayTwin(measured,[run]),/must have the model inputs/,'a twin with the battery voltage needs it');
});
test('replay points below 75 Hz are used once: no duplicate time after the alignment to recorded samples',()=>{
    const F=require('../tools/autotune/twin_fit.cjs'),run=pipeline.replayRun({id:'r',rate:50,n:200,u:[[1],[1],[1]].map(()=>new Array(200).fill(0)),coll:new Array(200).fill(0),
        thr:new Array(200).fill(.5),vbat:new Array(200).fill(22),gyro:[0,1,2].map(()=>new Array(200).fill(0)),att:[0,1,2].map(()=>new Array(200).fill(0)),
        alt:new Array(200).fill(0),vario:new Array(200).fill(0),hs:new Array(200).fill(3000)},500);
    const rules=pipeline.replayRules(F.RULES,run);
    assert.equal(new Set(rules.points.map(t=>t.toFixed(9))).size,rules.points.length);
    assert.equal(rules.points.length,rules.nominalPoints.length);
    assert.ok(rules.nominalPoints.includes(0.1)&&rules.nominalPoints.includes(1));
    assert.ok(rules.points.length<F.RULES.points.length,'0.01 s and 0.02 s are the same recorded sample at 50 Hz');
});
test('the twin lists only the outputs that the log records',async()=>{
    const f=await fixture(),w=f.input.items[0].w;
    assert.deepEqual(pipeline.makeTwin(f.input,{status:'validated',model:f.model,validation:{},coverage:{}}).channels.outputs,pipeline.CHANNELS.outputs);
    delete w.extra.altitude;w.extra.vario=new Float64Array(w.n).fill(NaN);
    const twin=pipeline.makeTwin(f.input,{status:'validated',model:f.model,validation:{},coverage:{}});
    assert.deepEqual(twin.channels.outputs,pipeline.CHANNELS.outputs.filter(n=>n!=='altitude'&&n!=='vario'));
});
