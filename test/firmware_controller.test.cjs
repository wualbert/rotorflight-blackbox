'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const F=require('../tools/autotune/firmware_controller.cjs');
const B=require('../tools/autotune/firmware/build.cjs');
const config=(overrides={})=>({firmwareVersion:'4.6.0',firmwareRevision:F.COMMIT,values:{...F.defaults(),...overrides},unknown:[]});
const input=(extra={})=>({setpoint:[0,0,0],gyro:[0,0,0],collective:0.5,headspeed:3000,spoolUpRatio:1,airborne:true,spooledUp:true,throttle:0.5,ttaIncrease:0,...extra});
test('pinned firmware source and portable artifact have exact provenance',()=>{
    const m=B.verifySources(),p=require('../tools/autotune/firmware/controller.json');
    assert.equal(m.commit,F.COMMIT);assert.equal(p.artifactSha256,F.ARTIFACT);
    const bytes=fs.readFileSync(path.join(__dirname,'../tools/autotune/firmware/controller.wasm'));
    assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)),[]);
    const bridge=fs.readFileSync(path.join(__dirname,'../tools/autotune/firmware/bridge.c'),'utf8');
    F.SCHEMA.forEach((field,i)=>assert.ok(bridge.includes(field.member+' = config['+i+'];')));
});
test('header translation does not promote inherited defaults or absent PID modes into known values',()=>{
    const header=Object.assign(Object.create({pid_mode:3}),{firmwareVersion:'4.6.0','Firmware revision':'Rotorflight 4.6.0 (118e912)',rollPID:[50,100,0,100,0],rollBW:[60,20,30],looptime:250,pid_process_denom:4,error_decay_ground:[25]});
    const cfg=F.fromHeader(header,{'iterm_relax_type':'RPY','mixer input SY min':-600,offset_limit:'75, 80'});
    assert.equal(cfg.values.roll_p_gain,50);assert.equal(cfg.values.roll_gyro_cutoff,60);assert.equal(cfg.values.pid_looptime,1000);
    assert.equal(cfg.values.mixer_sy_min,-600);assert.equal(cfg.values['offset_limit[1]'],80);assert.equal(cfg.values.iterm_relax_type,2);
    assert.equal(cfg.values.pid_mode,undefined);assert.ok(cfg.unknown.includes('pid_mode'));assert.equal(F.compatibility(cfg).supported,false);
});
test('decoded raw-header provenance rejects copied pitch defaults and header-labelled configuration aliases',()=>{
    const vm=require('node:vm'),lib=require('../tools/autotune/lib.cjs'),enc=require('./helpers/bbl_encode.cjs'),DS=require('../tools/autotune/datasets.cjs');
    const app=lib.loadApp(),plain=enc.simulateFlight({seconds:1,airborne:null}),recorded=enc.simulateFlight({seconds:1,airborne:null});
    delete plain.header.collectiveRange;recorded.header.collectiveRange=[-1000,1100];
    app.__bytes=enc.encode([plain,recorded]).bytes;
    const log=vm.runInContext('new FlightLog(__bytes)',app);assert.ok(log.openLog(0));
    const copied={...log.getSysConfig(),collectiveRange:[-1250,1250],pid_mode:3};
    assert.ok(!copied.loggedHeaderFields.includes('collectiveRange'));
    const cfg=F.fromHeader(copied,{'mixer input SC min':-1250,'mixer input SC max':1250},{valueSources:{'mixer input SC min':'header','mixer input SC max':'header'}});
    assert.equal(F.pitchLimits(cfg).collective.degrees,null);assert.ok(cfg.unknown.includes('pid_mode'));
    assert.ok(!Object.keys(DS.headerValues(copied).values).some(k=>k.startsWith('loggedHeaderFields')));
    assert.ok(log.openLog(1));const real=F.fromHeader(JSON.parse(JSON.stringify(log.getSysConfig())));
    assert.deepEqual(F.pitchLimits(real).collective.degrees.map(x=>+x.toFixed(6)),[-12,13.2]);
    const cli=F.fromHeader(copied,{'mixer input SC min':-1100,'mixer input SC max':1200},{valueSources:{'mixer input SC min':'cli','mixer input SC max':'cli'}});
    assert.deepEqual(F.pitchLimits(cli).collective.degrees.map(x=>+x.toFixed(6)),[-13.2,14.4]);
});
test('unsupported firmware, flight modes, rules, governor and incomplete rates are refused',()=>{
    assert.equal(F.compatibility(config()).supported,true);
    for(const patch of [{firmwareRevision:'abcdef0'},{firmwareVersion:'4.5.1'},{modes:['rescue']},{mixerRules:['custom']},{stale:{reason:'rearm'}}]) assert.equal(F.compatibility({...config(),...patch}).supported,false);
    assert.equal(F.compatibility(config(),{step:'governor'}).supported,false);
    assert.equal(F.compatibility(config(),{nativeRate:250}).supported,false);
    assert.equal(F.compatibility(config({tail_rotor_mode:1})).supported,false);
});
test('runtime preserves firmware scaling, yaw asymmetry, clipping and anti-windup',async()=>{
    const r=await F.create({config:config({roll_i_gain:100,roll_o_gain:0,roll_f_gain:0,iterm_relax_type:0,error_decay_time_cyclic:0,mixer_sr_max:50,yaw_i_gain:0,yaw_d_gain:0,yaw_cyclic_ff_gain:0,yaw_collective_ff_gain:0,cyclic_cross_coupling_gain:0})});
    const out=r.step(input({setpoint:[100,0,100]}));
    assert.ok(Math.abs(out.terms.P[0]-0.0333333)<1e-6);
    assert.ok(Math.abs(out.terms.P[2]-0.64)<1e-6);
    let last;for(let n=0;n<100;n++)last=r.step(input({setpoint:[100,0,100]}));
    assert.ok(Math.abs(last.u[0]-0.05)<1e-6);assert.equal(last.saturation[0],1);
    const integral=last.terms.I[0];
    for(let n=0;n<100;n++)last=r.step(input({setpoint:[100,0,100]}));
    assert.equal(last.terms.I[0],integral);
    const negative=r.step(input({setpoint:[0,0,-100]}));assert.ok(Math.abs(negative.terms.P[2]+0.4266666)<1e-6);
});
test('mode 4 actually uses upstream equalized cyclic I and F gains',async()=>{
    const c=config({pid_mode:4,roll_i_gain:60,pitch_i_gain:100,roll_f_gain:20,pitch_f_gain:100,roll_o_gain:0,pitch_o_gain:0,iterm_relax_type:0,error_decay_time_cyclic:0,cyclic_cross_coupling_gain:0});
    const runtime=await F.create({config:c});const result=runtime.step(input({setpoint:[10,10,0]}));
    assert.equal(result.terms.I[0],result.terms.I[1]);assert.equal(result.terms.F[0],result.terms.F[1]);
});
test('controller input state and artifact corruption are not silently accepted',async()=>{
    const runtime=await F.create({config:config()});
    assert.throws(()=>runtime.step(input({gyro:[NaN,0,0]})),/Invalid controller input/);
    assert.throws(()=>runtime.step(input({mode:'rescue'})),/Unsupported flight mode/);
    assert.throws(()=>runtime.step(input({spoolUpRatio:undefined})),/Missing controller input/);
    const bytes=fs.readFileSync(path.join(__dirname,'../tools/autotune/firmware/controller.wasm'));bytes[20]^=1;
    await assert.rejects(F.create({config:config(),bytes}),/source file/);
});
test('WASM matches native compiled source across coupled and saturated trajectories',async()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rf-controller-parity-'));
    try {
        const count=F.SCHEMA.length;
        const source=B.source()+`\nint main(void){for(int i=0;i<${count};i++)if(scanf("%f",&config[i])!=1)return 2;if(scanf("%f",&config[255])!=1)return 4;for(int i=0;i<65;i++)if(scanf("%f",&servoConfigValues[i])!=1)return 5;rf_reset();for(;;){for(int i=0;i<64;i++){if(scanf("%f",&input[i])!=1)return i==0?0:3;}rf_step();for(int i=0;i<72;i++)printf("%.9g%c",output[i],i==71?'\\n':' ');}}`;
        const file=path.join(directory,'controller.c'),exe=path.join(directory,'controller');fs.writeFileSync(file,source);
        cp.execFileSync(process.env.CC||'cc',['-std=gnu11','-O2','-ffp-contract=off',file,'-lm','-o',exe],{stdio:'pipe'});
        for(const mode of [3,4,'governor','servo']) {
            const cfg=config({pid_mode:typeof mode==='string'?3:mode,roll_d_gain:20,pitch_b_gain:30,yaw_b_gain:15,cyclic_cross_coupling_gain:70,yaw_inertia_precomp_gain:20,pitch_collective_ff_gain:15,swash_phase:40,swash_pitch_limit:1400,gov_mode:3,gov_headspeed:3000,'main_rotor_gear_ratio[0]':1,'main_rotor_gear_ratio[1]':10});
            cfg.executeGovernor=mode==='governor';
            if(mode==='servo')cfg.servos={count:4,parameters:[[1500,-500,500,400,500,333,60,2],[1510,-450,600,600,500,333,100,3],[1500,-400,500,500,600,333,80,2],[775,-300,300,250,250,560,0,0]],unknown:[],verified:true};
            const servoRow=new Array(65).fill(0);if(cfg.servos){cfg.servos.parameters.forEach((row,a)=>servoRow.splice(a*8,8,...row));servoRow[64]=4;}
            const runtime=await F.create({config:cfg});const samples=[],expected=[];
            for(let n=0;n<2500;n++) {
                const s=input({setpoint:[100*Math.sin(n*.02),80*Math.cos(n*.017),150*Math.sin(n*.005)],gyro:[20*Math.cos(n*.03),15*Math.sin(n*.021),30*Math.sin(n*.01)],collective:.7*Math.cos(n*.003),headspeed:3000+200*Math.sin(n*.001),airborne:n>100,spooledUp:n>200,spoolUpRatio:Math.min(1,n/200),armed:true,throttleOff:false,rawMotorRpm:30000+2000*Math.sin(n*.001),batteryVoltage:22.2,throttleCommand:1,rcDeflection:[0,0,0,.5]});
                const row=new Array(64).fill(0);row.splice(0,6,...s.setpoint,...s.gyro);row[6]=s.collective;row[7]=s.headspeed;row[8]=s.spoolUpRatio;row[9]=+s.airborne;row[10]=+s.spooledUp;row[11]=s.throttle;row[27]=.5;row[34]=-1;
                if(cfg.executeGovernor){row[36]=s.rawMotorRpm;row[37]=s.batteryVoltage;row[38]=s.throttleCommand;}
                samples.push(row.join(' '));expected.push(runtime.step(s));
            }
            const result=cp.execFileSync(exe,{input:F.SCHEMA.map(f=>cfg.values[f.name]).join(' ')+' '+Number(cfg.executeGovernor)+' '+servoRow.join(' ')+'\n'+samples.join('\n')+'\n',encoding:'utf8',maxBuffer:8*1024*1024}).trim().split('\n');
            assert.equal(result.length,expected.length);
            let error=0;
            result.forEach((row,n)=>{const v=row.split(' ').map(Number),out=expected[n];for(let a=0;a<3;a++)error=Math.max(error,Math.abs(v[a]-out.u[a]),Math.abs(v[5+a*11]-out.terms.P[a]),Math.abs(v[6+a*11]-out.terms.I[a]));if(out.servoPwm)out.servoPwm.forEach((p,a)=>assert.equal(v[64+a],p));if(out.governor){assert.equal(v[54],out.governor.state);error=Math.max(error,Math.abs(v[47]-out.governor.I),Math.abs(v[58]-out.governor.throttle));}});
            assert.ok(error<3e-6,'native/WASM maximum mismatch '+error);
        }
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
test('actual governor changes its output with RPM error and respects disarm',async()=>{
    const cfg={...config({gov_mode:3,gov_headspeed:3000,gov_startup_time:10,gov_spoolup_time:10,'main_rotor_gear_ratio[0]':1,'main_rotor_gear_ratio[1]':10}),executeGovernor:true};
    assert.equal(F.compatibility(cfg,{step:'governor'}).supported,true);
    const r=await F.create({config:cfg});
    const s=input({armed:true,throttleOff:false,rawMotorRpm:30000,batteryVoltage:22.2,throttleCommand:1,rcDeflection:[0,0,0,.5]});
    let out;for(let i=0;i<3000;i++)out=r.step(s);
    assert.equal(out.governor.state,4);const baseline=out.throttle;
    for(let i=0;i<500;i++)out=r.step({...s,rawMotorRpm:28500});
    assert.ok(out.throttle>baseline+0.01);
    out=r.step({...s,armed:false,throttleOff:true,throttleCommand:0});
    assert.equal(out.governor.state,0);assert.equal(out.throttle,0);
});
test('inactive governor and servo parameters do not block a mixer-input model',()=>{
    const cfg=config();for(const name of F.requiredFields(cfg).inactive)delete cfg.values[name];
    cfg.unknown=F.requiredFields(config()).inactive;
    assert.equal(F.compatibility(cfg).supported,true);
    assert.equal(F.compatibility(cfg,{output:'servo'}).supported,false);
});
test('FBL pitch limits use recorded mixer limits and CP swash names without substituting defaults',()=>{
    const cfg=F.fromHeader({}, {swash_type:'CP120',swash_pitch_limit:1917,swash_ring:100,mixer_sr_min:-1250,mixer_sr_max:1250,
        mixer_sp_min:-1250,mixer_sp_max:1250,mixer_sc_min:-1250,mixer_sc_max:1250,mixer_sy_min:-1517,mixer_sy_max:1021});
    assert.equal(cfg.values.swash_type,2);
    const p=F.pitchLimits(cfg);assert.deepEqual(p.collective.degrees,[-15,15]);assert.equal(p.totalMainPitch.degrees,23.004);
    assert.deepEqual(p.tail.degrees,[-36.408,24.504]);assert.equal(p.measured,false);
    const unknown=F.pitchLimits({values:{mixer_sr_min:-1250,mixer_sr_max:1250},unknown:['mixer_sr_min']});
    assert.equal(unknown.roll.degrees,null);assert.equal(unknown.collective.degrees,null);assert.equal(unknown.totalMainPitch.enabled,null);
});
test('native controller calibration recovers a sensitive mode and relax level on separate time intervals',async()=>{
    const truth=config({pid_mode:4,roll_d_gain:100,pitch_b_gain:80,roll_o_gain:0,pitch_o_gain:0,'iterm_relax_level[0]':60});
    const runtime=await F.create({config:truth}),samples=[],observations=[];
    for(let n=0;n<3000;n++) {
        const sample=input({setpoint:[140*Math.sin(n*.03),90*Math.sin(n*.02),60*Math.sin(n*.009)],gyro:[50*Math.sin(n*.025),20*Math.sin(n*.017),5*Math.sin(n*.008)]});
        samples.push(sample);observations.push(runtime.step(sample));
    }
    const incomplete={...truth,values:{...truth.values},unknown:['pid_mode','iterm_relax_level[0]']};delete incomplete.values.pid_mode;delete incomplete.values['iterm_relax_level[0]'];
    const result=await F.calibrate({config:incomplete,samples,observations,warmupSamples:200,initialState:{axisError:[0,0,0],axisOffset:[0,0,0]}});
    assert.equal(result.config.values.pid_mode,4);assert.equal(result.config.values['iterm_relax_level[0]'],60);
    assert.equal(result.test.passed,true);assert.ok(result.resolved.includes('pid_mode'));assert.ok(result.resolved.includes('iterm_relax_level[0]'));
    assert.deepEqual(result.provenance.train,[200,1800]);assert.deepEqual(result.provenance.selection,[1800,2400]);assert.deepEqual(result.provenance.test,[2400,3000]);
});
test('equivalent controller modes remain unknown after calibration',async()=>{
    const truth=config({roll_i_gain:0,pitch_i_gain:0,yaw_i_gain:0,roll_o_gain:0,pitch_o_gain:0,roll_d_gain:0,pitch_d_gain:0,yaw_d_gain:0,roll_b_gain:0,pitch_b_gain:0,yaw_b_gain:0,yaw_cyclic_ff_gain:0,yaw_collective_ff_gain:0});
    const runtime=await F.create({config:truth}),samples=[],observations=[];
    for(let n=0;n<1200;n++){const s=input({setpoint:[20*Math.sin(n*.01),10*Math.sin(n*.02),0]});samples.push(s);observations.push(runtime.step(s));}
    const incomplete={...truth,values:{...truth.values},unknown:['pid_mode']};delete incomplete.values.pid_mode;
    const result=await F.calibrate({config:incomplete,samples,observations,warmupSamples:100});
    assert.equal(result.test.passed,true);assert.equal(result.status,'unresolved');assert.ok(result.config.unknown.includes('pid_mode'));
});

test('complete PID updates allow one percent physical clock drift without changing native firmware time',async()=>{
    const cfg=config({roll_i_gain:100,roll_o_gain:0,roll_f_gain:0,iterm_relax_type:0,error_decay_time_cyclic:0}),nominal=1e6/cfg.values.pid_looptime;
    for(const factor of [.99,.99437,.99488,1,1.01])assert.equal(F.compatibility(cfg,{nativeRate:nominal*factor,loopsPerFrame:1}).supported,true,String(factor));
    for(const factor of [.98,.5,.25,1.02])assert.equal(F.compatibility(cfg,{nativeRate:nominal*factor,loopsPerFrame:1}).supported,false,String(factor));
    assert.equal(F.compatibility(cfg,{nativeRate:NaN,loopsPerFrame:1}).supported,false);
    assert.equal(F.compatibility(cfg,{nativeRate:nominal,loopsPerFrame:2}).supported,false,'configured decimation cannot claim a full-rate timestamp');
    const a=await F.create({config:cfg,nativeRate:nominal,loopsPerFrame:1}),b=await F.create({config:cfg,nativeRate:nominal*.99437,loopsPerFrame:1});
    for(let n=0;n<50;n++)assert.deepEqual(a.step(input({setpoint:[100,0,0]})),b.step(input({setpoint:[100,0,0]})));
});

test('upstream servo execution reproduces piecewise PWM scale, reversal, geometry and clipping',async()=>{
    const parameters=[[1500,-300,400,400,500,333,0,0],[1500,-700,700,500,500,333,0,1],
        [1550,-700,700,500,500,333,0,2],[775,-350,350,250,250,560,0,0]];
    const c=config({swash_type:2,swash_geo_correction:0,collective_tilt_correction_pos:0,collective_tilt_correction_neg:0,
        tail_center_trim:0,swash_trim:0,'swash_trim[0]':0,'swash_trim[1]':0,'swash_trim[2]':0,
        mixer_sr_rate:1000,mixer_sp_rate:1000,mixer_sc_rate:1000,mixer_sy_rate:1000});
    c.servos={count:4,parameters,unknown:[],verified:true};const runtime=await F.create({config:c});
    let result=runtime.mapMixer({u:[0,0,0],collective:1});
    assert.deepEqual(result.servo.slice(0,4),[.5,.5,.5,0]);
    assert.equal(result.servoPwm[0],1750);assert.equal(result.servoPwm[1],1250);
    assert.ok(Math.abs(result.servoPwm[2]-(1550+500*Math.asin(.5*.7660444431)*1.14591559026))<1);
    assert.equal(result.servoPwm[3],775);
    result=runtime.mapMixer({u:[0,1,3],collective:0});
    assert.equal(result.servoPwm[0],1200,'negative travel clips before midpoint');
    assert.equal(result.servoPwm[3],1125,'tail PWM travel clips');
    assert.equal(result.servoPwm.length,4);
    const output=runtime.step(input());assert.equal(output.servoPwm.length,4);
});

test('servo speed limits use original shared cyclic limiter and reset restores its state',async()=>{
    const parameters=Array.from({length:4},()=>[1500,-700,700,500,500,333,1000,0]);
    const c=config({swash_type:2,mixer_sc_rate:1000});c.servos={count:4,parameters,unknown:[],verified:true};
    const runtime=await F.create({config:c}),first=runtime.mapMixer({u:[0,0,0],collective:1});
    assert.deepEqual(first.servoPwm,[1501,1501,1501,1500]);
    for(let i=0;i<100;i++)runtime.mapMixer({u:[0,0,0],collective:1});
    runtime.reset();assert.deepEqual(runtime.mapMixer({u:[0,0,0],collective:1}).servoPwm,first.servoPwm);
    await assert.rejects(F.create({config:{...c,servos:{...c.servos,parameters:[[1500]]}}}),/Invalid servo configuration/);
});

test('servo configuration keeps absent values and optional CLI provenance unresolved',()=>{
    const values={'servo 1 mid':1500,'servo 1 flags':2},got=F.servoConfig(values,{'servo 1 mid':'cli'});
    assert.equal(got.verified,false);assert.equal(got.sources[0][0],'cli');assert.equal(got.parameters[0][1],undefined);
    assert.ok(got.unknown.includes('servo 1 min'));assert.equal(F.compatibility({...config(),servos:got}).supported,false);assert.equal(F.servoConfig({}),null);
});

// ---- governor alone: rf_gov_step, rf_gov_profile, govCreate (docs/GOVERNOR_AUTOTUNE.md 6) ----
const GOV={gov_mode:3,gov_throttle_type:0,gov_headspeed:3000,gov_startup_time:10,gov_spoolup_time:10,'main_rotor_gear_ratio[0]':1,'main_rotor_gear_ratio[1]':10,battery_cell_count:6,voltage_meter:2};
// first-order motor and rotor: raw motor rpm from the governor throttle, the battery voltage and a collective load
const plant=(R,u,coll)=>R+0.001/0.3*(u*1800*22.2-R-9000*Math.abs(coll));
test('rf_gov_step gives the governor outputs of the full rf_step path for the same mixer inputs',async()=>{
    const bypass=Array.from({length:9},(_,i)=>'gov_bypass_throttle['+i+']');
    // the values that the firmware does not read here can be unknown: govCreate gives them the release defaults.
    // Second case: TTA on a counter-clockwise rotor (the TTA sign comes from main_rotor_dir, govInitTTA).
    for(const [patch,inactive] of [[{},[...bypass,'gov_pwr_filter','gov_tta_filter','gov_tta_limit']],[{main_rotor_dir:1,gov_tta_gain:50,gov_tta_limit:20,gov_tta_filter:0},[...bypass,'gov_pwr_filter']]]) {
        const values={...F.defaults(),...GOV,...patch};for(const n of inactive)delete values[n];
        const full=await F.create({config:{...config({...GOV,...patch}),executeGovernor:true}}),gov=await F.govCreate({values,pidHz:1000});
        assert.deepEqual(gov.assumed.sort(),inactive.sort());
        let R=0,u=0,tta=0;const seen=new Set();let loadThrottle=null,beforeLoad=null;
        for(let n=0;n<14000;n++) {
            const coll=n<7000?.2:.8,cmd=n<100||n>=12500?0:1,armed=n<13500;
            const s=input({setpoint:[60*Math.sin(n*.013),40*Math.cos(n*.011),90*Math.sin(n*.007)],gyro:[10*Math.sin(n*.02),0,5*Math.cos(n*.03)],collective:coll,headspeed:R/10,
                armed,throttleOff:cmd===0,rawMotorRpm:R,batteryVoltage:22.2,throttleCommand:cmd,rcDeflection:[0,0,0,coll],timeS:20+n*.001,govFallback:n===10000});
            const out=full.step(s),g=gov.step({rawMotorRpm:R,batteryVoltage:22.2,throttleCommand:cmd,throttleOff:cmd===0,armed,timeS:s.timeS,govFallback:s.govFallback,
                mixer:[out.u[0],out.u[1],out.u[2],out.collective],rcDeflection:s.rcDeflection});
            assert.deepEqual(g,out.governor,'step '+n);
            seen.add(g.state);u=g.throttle;R=plant(R,u,coll);tta=Math.max(tta,g.ttaIncrease);
            if(n===6999)beforeLoad=u;if(n===8000)loadThrottle=u;
        }
        for(const state of [0,1,2,3,4,5,6])assert.ok(seen.has(state),'state '+state);
        assert.ok(loadThrottle>beforeLoad+.05,'the load step raises the throttle: '+beforeLoad+' -> '+loadThrottle);
        assert.ok(patch.gov_tta_gain?tta>.05:tta===0,'TTA '+tta);
    }
});
test('a PID profile change keeps ACTIVE and the throttle, and ramps the target to the new headspeed (stateResetReq)',async()=>{
    const values={...F.defaults(),...GOV},gov=await F.govCreate({values,pidHz:1000});
    let R=0,o;const run=(n,coll=.3)=>{for(let i=0;i<n;i++){o=gov.step({rawMotorRpm:R,batteryVoltage:22.2,throttleCommand:1,throttleOff:false,armed:true,mixer:[.05,.02,.1,coll]});R=plant(R,o.throttle,coll);}return o;};
    const o0=run(9000);assert.equal(o0.state,4);assert.ok(Math.abs(o0.currentHeadSpeed-3000)<5);
    // a PID profile has all its governor values: a missing value is unknown, not the value of the previous PID profile
    assert.throws(()=>gov.profile({gov_headspeed:3300}),/unknown: gov_flags, gov_min_throttle/);
    assert.throws(()=>gov.profile({...gov.values,gov_headspeed:3300,battery_cell_count:4}),/global value battery_cell_count/);
    gov.profile({...gov.values,gov_headspeed:3300,gov_collective_weight:60});
    const o1=run(1);
    assert.equal(o1.state,4);assert.equal(o1.requestHS,3300);
    // bumpless: I takes the previous throttle minus the new P, D and F, so the sum moves only by the integrator step C
    assert.ok(Math.abs(o1.P+o1.I+o1.D+o1.F-o0.throttle)<2e-4,'sum '+(o1.P+o1.I+o1.D+o1.F)+' throttle '+o0.throttle);
    assert.ok(Math.abs(o1.throttle-o0.throttle)<2e-4);assert.notEqual(o1.F,o0.F);
    const steps=[o1.targetHS-o0.targetHS];let last=o1;
    for(let i=0;i<50;i++){const x=run(1);steps.push(x.targetHS-last.targetHS);assert.equal(x.state,4);last=x;}
    // the target slews at max(headspeed, Kmot) x 10 dT / gov_tracking_time per loop, from the old target
    assert.ok(steps.every(d=>d>=3300*.0002-1e-3&&Math.abs(d-steps[0])<1e-3),JSON.stringify(steps.slice(0,5)));
    const o2=run(4000);assert.equal(o2.state,4);assert.equal(o2.targetHS,3300);assert.ok(Math.abs(o2.currentHeadSpeed-3300)<10);
    // a profile change while the motor is off sets the request, and reset() returns to the first PID profile
    gov.reset();assert.equal(run(1).requestHS,3000);gov.profile({...gov.values,gov_headspeed:2500});assert.equal(run(1).requestHS,2500);
});
test('configuration mapping: battery_meter, gov_mode OFF, cell count 0 and an unknown gear ratio',async()=>{
    for(const [meter,code] of [['ESC',2],['ADC',1],['NONE',0]])assert.equal(F.fromHeader({},{battery_meter:meter}).values.voltage_meter,code);
    const cli=F.fromHeader({},{battery_meter:'ESC',gov_mode:'OFF',battery_cell_count:0},{valueSources:{battery_meter:'CLI dump'}});
    assert.equal(cli.values.gov_mode,0);assert.equal(cli.sources.voltage_meter,'CLI dump');assert.equal(cli.values.battery_cell_count,0);
    const auto=F.fromHeader({vbatmincellvoltage:330,vbatmaxcellvoltage:430},{battery_cell_count:0},{restVoltage:25.2});
    assert.equal(auto.values.battery_cell_count,6);assert.match(auto.sources.battery_cell_count,/^calculated from the log/);
    // cell levels in 0.1 V (the parser default 33/43) or 0.01 V; a header level that the log did not record does not hide the CLI
    const cells=(header,restVoltage)=>F.fromHeader(header,{battery_cell_count:0,vbat_min_cell_voltage:330,vbat_warning_cell_voltage:350,vbat_max_cell_voltage:430},{restVoltage}).values.battery_cell_count;
    for(const [v,k] of [[25.1,6],[16.6,4],[4.1,1]]){assert.equal(cells({vbatmincellvoltage:33,vbatmaxcellvoltage:43,loggedHeaderFields:['looptime']},v),k,v+' V');assert.equal(cells({vbatmincellvoltage:33,vbatmaxcellvoltage:43},v),k,v+' V');}
    assert.equal(cells({vbatmincellvoltage:20,vbatwarningcellvoltage:25,vbatmaxcellvoltage:30,loggedHeaderFields:['looptime']},25.1),6);
    assert.equal(cells({vbatmincellvoltage:20,vbatwarningcellvoltage:25,vbatmaxcellvoltage:30,loggedHeaderFields:['vbatcellvoltage']},25.1),10);
    assert.equal(F.govCells({cellCount:6}).cells,6);assert.equal(F.govCells({cellCount:0,restVoltage:16.6}).cells,4);
    assert.equal(F.govCells({cellCount:0,restVoltage:25.2,maxCell:4.2}).cells,6);
    const none=F.govCells({cellCount:0});assert.equal(none.cells,0);assert.equal(none.source,'unknown');assert.ok(none.note);
    // gear unknown: 1:1 and the headspeed as the motor speed give the result of the configured ratio with motor rpm
    const v={...F.defaults(),...GOV};delete v['main_rotor_gear_ratio[0]'];delete v['main_rotor_gear_ratio[1]'];
    const a=await F.govCreate({values:{...F.defaults(),...GOV},pidHz:1000}),b=await F.govCreate({values:v,pidHz:1000,voltageSource:'ESC'});
    assert.equal(a.notes.length,0);assert.equal(b.notes.length,1);assert.deepEqual([b.values['main_rotor_gear_ratio[0]'],b.values['main_rotor_gear_ratio[1]']],[1,1]);
    let R=0;for(let n=0;n<4000;n++){const s={batteryVoltage:22.2,throttleCommand:1,throttleOff:false,armed:true,mixer:[0,0,0,.3]};
        const x=a.step({...s,rawMotorRpm:R}),y=b.step({...s,rawMotorRpm:R/10});assert.equal(x.state,y.state);assert.ok(Math.abs(x.throttle-y.throttle)<1e-5,'step '+n);R=plant(R,x.throttle,.3);}
    // voltage compensation needs the flag, the ADC meter and ELECTRIC: then the cell count is required, and 0 (unknown) is refused
    await assert.rejects(F.govCreate({values:{...F.defaults(),...GOV,gov_flags:8,battery_cell_count:0},pidHz:1000,voltageSource:'ADC'}),/unknown: battery_cell_count/);
    const auto6=await F.govCreate({values:{...F.defaults(),...GOV,gov_flags:8,battery_cell_count:0},pidHz:1000,voltageSource:'ADC',restVoltage:25.1});
    assert.equal(auto6.values.battery_cell_count,6);assert.equal(auto6.notes.length,0);assert.ok(auto6.required.includes('battery_cell_count'));
    // the flag with an unknown voltage source: the source is required, not assumed to be ADC
    await assert.rejects(F.govCreate({values:(({voltage_meter,...x})=>x)({...F.defaults(),...GOV,gov_flags:8}),pidHz:1000}),/unknown: voltage_meter/);
    for(const [patch,source] of [[{},'ESC'],[{gov_mode:2},'ADC']]){
        const off=await F.govCreate({values:{...F.defaults(),...GOV,gov_flags:8,battery_cell_count:0,...patch},pidHz:1000,voltageSource:source});
        assert.equal(off.notes.length,0);assert.ok(!off.required.includes('battery_cell_count'));}
    // a later PID profile cannot make an unknown or assumed global value known
    const later=await F.govCreate({values:{...F.defaults(),...GOV,battery_cell_count:0},pidHz:1000,voltageSource:'ADC'});
    assert.throws(()=>later.profile({...later.values,gov_flags:8}),/unknown: battery_cell_count/);
    const assumedMeter=await F.govCreate({values:(({voltage_meter,gov_pwr_filter,...x})=>x)({...F.defaults(),...GOV}),pidHz:1000});
    assert.deepEqual(assumedMeter.assumed.filter(n=>!/bypass|tta/.test(n)).sort(),['gov_pwr_filter','voltage_meter']);
    assert.throws(()=>assumedMeter.profile({...assumedMeter.values,gov_flags:8,voltage_meter:2,gov_pwr_filter:5}),/global value voltage_meter/);
    assert.throws(()=>assumedMeter.profile({...assumedMeter.values,gov_flags:8,voltage_meter:1,gov_pwr_filter:5}),/unknown: gov_pwr_filter, voltage_meter/);
});
test('govCreate refuses a motorized tail when the governor uses the yaw, and needs the rotor direction for TTA',async()=>{
    const v={...F.defaults(),...GOV,tail_rotor_mode:1};
    await assert.rejects(F.govCreate({values:v,pidHz:1000}),/motorized tail/);
    for(const patch of [{gov_yaw_weight:0},{gov_f_gain:0}]){
        const g=await F.govCreate({values:{...v,...patch},pidHz:1000});
        assert.throws(()=>g.profile({...g.values,gov_yaw_weight:10,gov_f_gain:10}),/motorized tail/);
        assert.throws(()=>g.profile({...g.values,gov_tta_gain:50,gov_tta_limit:20}),/motorized tail/);
    }
    // the log header does not record the tail mode or the rotor direction: each is required only when the governor reads it
    const t=(({main_rotor_dir,tail_rotor_mode,...x})=>x)({...F.defaults(),...GOV});
    await assert.rejects(F.govCreate({values:t,pidHz:1000}),/unknown: tail_rotor_mode\./);
    const g=await F.govCreate({values:{...t,gov_yaw_weight:0},pidHz:1000});assert.deepEqual(g.assumed.filter(n=>/rotor/.test(n)).sort(),['main_rotor_dir','tail_rotor_mode']);
    await assert.rejects(F.govCreate({values:{...t,gov_yaw_weight:0,gov_tta_gain:50,gov_tta_limit:20},pidHz:1000}),/unknown: main_rotor_dir, tail_rotor_mode\./);
    assert.throws(()=>g.profile({...g.values,gov_tta_gain:50,gov_tta_limit:20}),/unknown: main_rotor_dir, tail_rotor_mode\./);
    const ccw=await F.govCreate({values:{...t,gov_yaw_weight:0,gov_tta_gain:50,gov_tta_limit:20,main_rotor_dir:1,tail_rotor_mode:0},pidHz:1000});assert.deepEqual(ccw.assumed.filter(n=>/rotor|tta/.test(n)),[]);
    for(const mode of [1,4]){const x=await F.govCreate({values:{...t,gov_yaw_weight:0,gov_mode:mode,gov_tta_gain:50},pidHz:1000});assert.ok(!x.required.includes('main_rotor_dir')&&!x.required.includes('gov_tta_limit'),'mode '+mode);}
});
test('govCreate and profile refuse unknown and out-of-range governor values with a clear error',async()=>{
    const v={...F.defaults(),...GOV};
    for(const [patch,re] of [[{gov_p_gain:300},/gov_p_gain is out of its range \(0 to 250\): 300/],[{gov_collective_curve:50},/gov_collective_curve.*5 to 40/],
        [{gov_headspeed:2.5},/gov_headspeed/],[{gov_mode:7},/gov_mode/],[{voltage_meter:3,gov_flags:8},/voltage_meter.*0 to 2/],[{battery_cell_count:30},/battery_cell_count.*0 to 24/],[{main_rotor_dir:2},/main_rotor_dir.*0 to 1/]])
        await assert.rejects(F.govCreate({values:{...v,...patch},pidHz:1000}),re);
    const missing={...v};delete missing.gov_headspeed;delete missing.gov_i_gain;
    await assert.rejects(F.govCreate({values:missing,pidHz:1000}),/unknown: gov_headspeed, gov_i_gain/);
    await assert.rejects(F.govCreate({values:v,pidHz:3000}),/cannot use this PID loop rate/);
    const g=await F.govCreate({values:v,pidHz:2000});assert.equal(g.values.pid_looptime,500);
    assert.throws(()=>g.profile({...g.values,gov_f_limit:120}),/gov_f_limit is out of its range/);
    assert.throws(()=>g.profile({...g.values,gov_rpm_filter:20}),/global value gov_rpm_filter/);
    const t={...v};for(const n of ['gov_tta_filter','gov_tta_limit','gov_bypass_throttle[0]'])delete t[n];const h=await F.govCreate({values:t,pidHz:1000});
    assert.throws(()=>h.profile({...h.values,gov_tta_gain:20}),/unknown: gov_tta_filter, gov_tta_limit/);
    // a global value given to profile() does not make an assumed value known
    assert.throws(()=>h.profile({...h.values,gov_tta_gain:20,gov_tta_limit:30,gov_tta_filter:0}),/unknown: gov_tta_filter$|unknown: gov_tta_filter\./);
    h.profile({...h.values,gov_tta_gain:20,gov_tta_limit:0});
    const s={rawMotorRpm:1,batteryVoltage:22,throttleCommand:1,throttleOff:false,armed:true,mixer:[0,0,0,0]};
    assert.throws(()=>g.step({...s,mixer:[0,0,0]}),/mixer input/);
    assert.throws(()=>h.step({...s,govBypass:true,rcDeflection:[0,0,0,.8]}),/gov_bypass_throttle" are unknown/);
    // BYPASS maps the collective stick, not the mixer: the stick input is required
    assert.throws(()=>g.step({...s,govBypass:true}),/"rcDeflection" is necessary for "govBypass"/);
    assert.throws(()=>g.step({...s,govBypass:true,rcDeflection:[0,0,.8]}),/stick input of the governor is not correct/);
    assert.equal(g.step({...s,govBypass:true,rcDeflection:[0,0,0,.8]}).state,9);
    const bridge=fs.readFileSync(path.join(__dirname,'../tools/autotune/firmware/bridge.c'),'utf8'),part=bridge.slice(bridge.indexOf('void rf_gov_profile'));
    F.SCHEMA.forEach((f,i)=>{if(f.member.startsWith('profile.governor.'))assert.ok(part.includes(f.member+' = config['+i+'];'),f.member);});
    assert.ok(['rf_gov_step','rf_gov_profile'].every(x=>require('../tools/autotune/firmware/controller.json').exports.includes(x)));
});
test('the firmware time is exact and does not stop or wrap after 2^32 microseconds',async()=>{
    const values={...F.defaults(),...GOV},runs=[];
    for(const t0 of [100,4294,4300,5000]) {
        const g=await F.govCreate({values,pidHz:1000}),out=[];let R=0;
        for(let n=0;n<6000;n++){const o=g.step({rawMotorRpm:R,batteryVoltage:22.2,throttleCommand:1,throttleOff:false,armed:true,mixer:[0,0,0,.3],timeS:t0+n*.001});out.push(o);R=plant(R,o.throttle,.3);}
        assert.equal(out[5999].state,4,'t0 '+t0);runs.push(out);
    }
    for(let k=1;k<runs.length;k++)assert.deepEqual(runs[k],runs[0]);
    const g=await F.govCreate({values,pidHz:1000}),s={rawMotorRpm:0,batteryVoltage:22,throttleCommand:0,throttleOff:true,armed:true,mixer:[0,0,0,0]};
    g.step({...s,timeS:10});assert.throws(()=>g.step({...s,timeS:9.9995}),/before the time of the previous step/);
    assert.throws(()=>g.step({...s,timeS:4400}),/out of the range of the firmware clock/);assert.throws(()=>g.step({...s,timeS:NaN}),/not correct/);
    g.reset();g.step({...s,timeS:5});g.step(s);assert.throws(()=>g.step({...s,timeS:5.0005}),/before/);g.step({...s,timeS:5.001});
});
