'use strict';
// Executes the pinned C controller and mixer in a no-import WebAssembly module.
// Sensor filters and RC shaping are external. Governor execution is optional.
const schemaModule = require('./firmware/schema.cjs');
const SCHEMA = schemaModule.fields;
const COMMIT = '118e9120260bb33f46df4f92052fb0e9fd4e9ebc';
const AXES = ['roll','pitch','yaw'];
const ARTIFACT = 'd1aa792dad08bb1ae68fd8128f4493667dcd4ea97db758570fcaec6d3091022e';
const CAPABILITIES = Object.freeze({engine:'upstream-c-wasm',version:'4.6.0',commit:COMMIT,pidModes:[0,3,4],
    direct:['rate PID','PID filters','I-term relax','HSI offset','error decay','yaw stop gains','cross coupling','collective and inertia compensation','mixer limits','swash mixer','governor PID','governor state machine','torque assist'],
    external:['gyro sensor filter','rate shaping','actuator dynamics'],
    servos:{available:true,enable:'config.servos',input:'normalized swash mixer',output:'logged PWM in microseconds',direct:['geometry correction','speed limiting','direction','piecewise scale','travel limit','center','saturation feedback']},
    governor:{available:true,enable:'config.executeGovernor',rpmInput:'raw mechanical motor RPM',default:'recorded boundary'},
    unsupported:['rescue','level modes','acro trainer','failsafe','mixer rules','motorized tail']});
const own=(o,k)=>o!=null&&Object.prototype.hasOwnProperty.call(o,k);
const numeric=x=>typeof x==='number'&&Number.isFinite(x);
function defaults() {return Object.fromEntries(SCHEMA.map(f=>[f.name,f.default]));}
const SERVO_FIELDS=['mid','min','max','rneg','rpos','rate','speed','flags'];
function servoConfig(values={},sources={}) {
    const indexes=[...new Set(Object.keys(values).map(k=>/^servo (\d+) /.exec(k)).filter(Boolean).map(m=>+m[1]))].sort((a,b)=>a-b);
    if(!indexes.length)return null;
    const count=Math.max(...indexes),parameters=[],unknown=[],provenance=[];
    for(let i=1;i<=count;i++){parameters.push(SERVO_FIELDS.map(f=>values['servo '+i+' '+f]));provenance.push(SERVO_FIELDS.map(f=>sources['servo '+i+' '+f]||'unverified configuration'));
        SERVO_FIELDS.forEach((f,j)=>{if(!numeric(parameters[i-1][j]))unknown.push('servo '+i+' '+f);});}
    return {count,parameters,sources:provenance,unknown,verified:false};
}
function fromHeader(header={}, values={}, context={}) {
    const v={},sources={},put=(name,value,source)=>{if(numeric(value)){v[name]=value;sources[name]=source;}};
    const logged=Array.isArray(header.loggedHeaderFields)?new Set(header.loggedHeaderFields):null;
    const hasHeader=name=>own(header,name)&&(!logged||logged.has(name));
    const arr=(name,fields)=>{if(hasHeader(name)) {const x=Array.isArray(header[name])?header[name]:[header[name]];fields.forEach((f,i)=>put(f,x[i],'log header'));}};
    if(hasHeader('looptime')&&hasHeader('pid_process_denom')) put('pid_looptime',header.looptime*header.pid_process_denom,'log header');
    AXES.forEach((axis,a)=>{
        arr(axis+'PID',['p','i','d','f','b'].map(t=>axis+'_'+t+'_gain'));
        arr(axis+'BW',['gyro_cutoff','d_cutoff','b_cutoff'].map(t=>axis+'_'+t));
    });
    arr('hsi_gain',['roll_o_gain','pitch_o_gain']);
    arr('hsi_limit',['offset_limit[0]','offset_limit[1]']);
    arr('error_limit',AXES.map((_,a)=>'error_limit['+a+']'));
    arr('iterm_relax_cutoff',AXES.map((_,a)=>'iterm_relax_cutoff['+a+']'));
    arr('iterm_relax_level',AXES.map((_,a)=>'iterm_relax_level['+a+']'));
    arr('yaw_stop_gain',['yaw_cw_stop_gain','yaw_ccw_stop_gain']);
    arr('yaw_precomp',['yaw_precomp_cutoff','yaw_cyclic_ff_gain','yaw_collective_ff_gain']);
    arr('yaw_inertia_precomp',['yaw_inertia_precomp_gain','yaw_inertia_precomp_cutoff']);
    arr('cyclic_coupling',['cyclic_cross_coupling_gain','cyclic_cross_coupling_ratio','cyclic_cross_coupling_cutoff']);
    arr('error_decay',['error_decay_time_cyclic','error_decay_limit_cyclic']);
    arr('error_decay_ground',['error_decay_time_ground']);
    arr('collectiveRange',['mixer_sc_min','mixer_sc_max']);
    arr('pitch_compensation',['pitch_collective_ff_gain']);
    arr('govPID',['gov_p_gain','gov_i_gain','gov_d_gain','gov_f_gain','gov_gain']);
    arr('yaw_tta',['gov_tta_gain','gov_tta_limit']);
    for(const f of SCHEMA) if(hasHeader(f.name)) put(f.name,header[f.name],'log header');
    // The yaw O term does not exist in the pinned controller.
    put('yaw_o_gain',0,'firmware source');
    const enums={pid_mode:{PASSTHROUGH:0},iterm_relax_type:{OFF:0,RP:1,RPY:2},main_rotor_dir:{CW:0,CCW:1},tail_rotor_mode:{VARIABLE:0,MOTORIZED:1,BIDIRECTIONAL:2},swash_type:{NONE:0,PASSTHROUGH:1,THRU:1,CPPM:1,'120':2,CP120:2,'135':3,CP135:3,'140':4,CP140:4,'90L':5,CP90L:5,FP90L:5,'90V':6,CP90V:6,FP90V:6},gov_mode:{NONE:0,LIMIT:1,DIRECT:2,ELECTRIC:3,NITRO:4},gov_throttle_type:{NORMAL:0,SWITCH:1,FUNCTION:2},voltage_meter:{NONE:0,ADC:1,ESC:2}};
    function getValue(name) {
        let x=values[name];
        const ma=/^(\w+)\[(\d+)\]$/.exec(name);
        if(x==null&&ma&&own(values,ma[1])) {const q=values[ma[1]];x=(Array.isArray(q)?q:String(q).split(/[,\s]+/))[+ma[2]];}
        const mi=/^mixer_(\w+)_(min|max|rate)$/.exec(name);
        if(x==null&&mi) x=values['mixer input '+mi[1].toUpperCase()+' '+mi[2]];
        if(x==null&&/^swash_trim/.test(name)) x=values[['swash_roll_trim','swash_pitch_trim','swash_collective_trim'][+ma[2]]];
        if(x==null&&/^gov_(yaw|cyclic|collective)_weight$/.test(name)) x=values[name.replace('_weight','_ff_weight')];
        if(x!=null&&enums[name]&&own(enums[name],String(x).toUpperCase())) x=enums[name][String(x).toUpperCase()];
        return x==null?null:Number(x);
    }
    function sourceOf(name) {
        const s=context.valueSources||{},array=/^(\w+)\[(\d+)\]$/.exec(name),mixer=/^mixer_(\w+)_(min|max|rate)$/.exec(name);
        return s[name]||(array&&s[array[1]])||(mixer&&s['mixer input '+mixer[1].toUpperCase()+' '+mixer[2]])||'recorded configuration';
    }
    const loggedParameters=new Set(Object.keys(v));
    for(const f of SCHEMA) {
        const x=getValue(f.name),source=sourceOf(f.name);
        // Configuration materialization must not turn a copied parser default
        // back into an observed value after the raw header check above.
        if(logged&&/^(?:log )?header$/.test(source)&&!loggedParameters.has(f.name))continue;
        if(numeric(x))put(f.name,x,source);
    }
    const flagFields={gov_use_fallback_precomp:2,gov_use_voltage_comp:3,gov_use_pid_spoolup:4,gov_use_dyn_min_throttle:6};
    if(Object.keys(flagFields).every(k=>own(values,k))) {let flags=0;for(const [name,bit] of Object.entries(flagFields))if(values[name]===true||values[name]===1||values[name]==='ON')flags|=1<<bit;put('gov_flags',flags,'recorded configuration');}
    const unknown=SCHEMA.filter(f=>!own(v,f.name)).map(f=>f.name);
    const revision=context.firmwareRevision||(hasHeader('firmwareRevision')?header.firmwareRevision:hasHeader('Firmware revision')?header['Firmware revision']:hasHeader('firmwareHash')?header.firmwareHash:'');
    return {firmwareVersion:context.firmwareVersion||header.firmwareVersion||'',firmwareRevision:revision,
        values:v,unknown,sources,servos:servoConfig(values,context.valueSources),executeGovernor:context.executeGovernor===true,profile:context.profile||null,stale:context.stale||null,
        modes:context.modes||[],mixerRules:context.mixerRules||Object.keys(values).filter(k=>/^mixer rule /.test(k)&&!/^0\s/.test(String(values[k]))),boundary:'filtered-gyro to stabilized-mixer',
        assumptions:unknown.map(name=>({name,value:defaults()[name],source:'unverified release default'}))};
}
function pitchLimits(config={}) {
    const v=config.values||{},unknown=new Set(config.unknown||[]),known=name=>numeric(v[name])&&!unknown.has(name);
    const range=(axis,degreesPerUnit)=>{
        const names=['min','max'].map(end=>'mixer_'+axis+'_'+end);
        return {degrees:names.every(known)?names.map(name=>v[name]*degreesPerUnit):null,
            parameters:names,sources:names.map(name=>known(name)?config.sources&&config.sources[name]||'recorded configuration':'unknown')};
    };
    return {roll:range('sr',.012),pitch:range('sp',.012),collective:range('sc',.012),tail:range('sy',.024),
        totalMainPitch:{degrees:known('swash_pitch_limit')&&v.swash_pitch_limit>0?v.swash_pitch_limit*.012:null,
            enabled:known('swash_pitch_limit')?v.swash_pitch_limit>0:null,parameter:'swash_pitch_limit',source:known('swash_pitch_limit')?config.sources&&config.sources.swash_pitch_limit||'recorded configuration':'unknown'},
        swashRing:{percent:known('swash_ring')?v.swash_ring:null,parameter:'swash_ring',source:known('swash_ring')?config.sources&&config.sources.swash_ring||'recorded configuration':'unknown'},
        convention:'FBL command angle from calibrated neutral; tail trim is not an absolute blade angle',
        assumptions:['FBL pitch calibration is correct'],measured:false,firmwareSource:COMMIT};
}
function requiredFields(config={},context={}) {
    const v=config.values||{},inactive=new Set(['yaw_o_gain']);
    // The identified plant is driven at stabilized mixer inputs. These fields
    // affect servo pulse outputs only and cannot affect that model boundary.
    if(context.output!=='servo'&&!config.servos) for(const f of SCHEMA) if(/^swash_trim\[|^swash_type$|^swash_geo_correction$|^collective_tilt_correction_|^mixer_\w+_rate$/.test(f.name))inactive.add(f.name);
    if(v.tail_rotor_mode===0){inactive.add('tail_motor_idle');if(context.output!=='servo'&&!config.servos)inactive.add('tail_center_trim');}
    if(!config.executeGovernor) SCHEMA.slice(schemaModule.governorStart).forEach(f=>inactive.add(f.name));
    if(v.iterm_relax_type===0) for(const f of SCHEMA) if(/^iterm_relax_(level|cutoff)\[/.test(f.name))inactive.add(f.name);
    if(v.yaw_cyclic_ff_gain===0&&v.yaw_collective_ff_gain===0)inactive.add('yaw_precomp_cutoff');
    if(v.yaw_inertia_precomp_gain===0)inactive.add('yaw_inertia_precomp_cutoff');
    if(v.cyclic_cross_coupling_gain===0){inactive.add('cyclic_cross_coupling_ratio');inactive.add('cyclic_cross_coupling_cutoff');}
    if(v.roll_o_gain===0&&v.pitch_o_gain===0){inactive.add('offset_flood_relax_cutoff');inactive.add('offset_flood_relax_level');}
    for(let a=0;a<2;a++)if(v[AXES[a]+'_o_gain']===0)inactive.add('offset_limit['+a+']');
    if(config.executeGovernor&&v.gov_tta_gain===0){inactive.add('gov_tta_filter');inactive.add('gov_tta_limit');}
    return {required:SCHEMA.filter(f=>!inactive.has(f.name)).map(f=>f.name),inactive:[...inactive]};
}
function compatibility(config={}, context={}) {
    const reasons=[],v=config.values||{},scope=requiredFields(config,context),missing=scope.required.filter(name=>!numeric(v[name]));
    if(String(config.firmwareVersion)!=='4.6.0') reasons.push('The app cannot use this firmware version.');
    const revision=String(config.firmwareRevision||'');
    if(!revision.includes(COMMIT.slice(0,7))) reasons.push('The log does not identify the firmware source version.');
    if(![0,3,4].includes(v.pid_mode)) reasons.push('The app cannot use this PID mode, or the mode is unknown.');
    if(missing.length) reasons.push('The flight controller configuration has unknown values.');
    if(config.unknown&&config.unknown.some(name=>scope.required.includes(name))) reasons.push('The flight controller configuration has values that are not examined.');
    if(config.servos&&(!config.servos.verified||(config.servos.unknown||[]).length))reasons.push('The servo configuration has values that are not examined.');
    if(config.stale) reasons.push('The flight controller values can be different from the values in the log.');
    if((config.modes||[]).some(m=>m!=='acro'&&m!=='rate')) reasons.push('The app cannot use this flight mode.');
    if((config.mixerRules||[]).length) reasons.push('The app cannot use mixer rules that you set.');
    if(v.tail_rotor_mode!==0) reasons.push('The app cannot use a motorized tail.');
    if((context.step==='gov'||context.step==='governor')&&!config.executeGovernor) reasons.push('The governor control loop is not active.');
    if(config.executeGovernor&&![0,1,2,3,4].includes(v.gov_mode)) reasons.push('The app cannot use this governor mode.');
    // Header loop time remains the C PID timebase. Logged timestamps measure
    // the physical clock and can differ by up to 1%; this never permits omitted
    // PID updates. The pipeline independently verifies loopsPerFrame from the
    // native logging configuration before checking measured timestamp rates.
    const nominalPidHz=numeric(v.pid_looptime)?1e6/v.pid_looptime:null;
    if(context.nativeRate!=null&&nominalPidHz&&(!numeric(context.nativeRate)||Math.abs(context.nativeRate/nominalPidHz-1)>0.01+1e-12)) reasons.push('The samples do not use the PID loop rate.');
    if(context.loopsPerFrame!=null&&context.loopsPerFrame!==1) reasons.push('The log does not record all control updates.');
    for(const f of SCHEMA) if(numeric(v[f.name])&&(!Number.isInteger(v[f.name])||v[f.name]<f.min||v[f.name]>f.max)) reasons.push('The flight controller value is out of its range: '+f.name+'.');
    return {supported:reasons.length===0,reasons:[...new Set(reasons)],missing,inactive:scope.inactive,capabilities:CAPABILITIES,sourceRevision:COMMIT};
}
async function bytesOf(options) {
    if(options.bytes) return options.bytes;
    if(typeof process!=='undefined'&&process.versions&&process.versions.node) return require('node:fs').readFileSync(require('node:path').join(__dirname,'firmware/controller.wasm'));
    const response=await fetch(options.url||'../tools/autotune/firmware/controller.wasm');
    if(!response.ok) throw Error('The app cannot load the flight controller.');
    return new Uint8Array(await response.arrayBuffer());
}
async function checkArtifact(bytes) {
    let hash;
    if(typeof process!=='undefined'&&process.versions&&process.versions.node) hash=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    else {const result=await crypto.subtle.digest('SHA-256',bytes);hash=Array.from(new Uint8Array(result),x=>x.toString(16).padStart(2,'0')).join('');}
    if(hash!==ARTIFACT) throw Error('The flight controller file does not agree with the source file.');
}
async function create(options={}) {
    const config=options.servos?{...(options.config||{}),servos:options.servos}:options.config||{},status=compatibility(config,options),v={...defaults(),...(config.values||{})};
    // Unknown parameters permit diagnostic replay only; support status is immutable.
    const bytes=await bytesOf(options); await checkArtifact(bytes);
    const {instance}=await WebAssembly.instantiate(bytes,{}),e=instance.exports;
    if(e._initialize)e._initialize();
    const cv=new Float32Array(e.memory.buffer,e.rf_config(),256),iv=new Float32Array(e.memory.buffer,e.rf_input(),64),ov=new Float32Array(e.memory.buffer,e.rf_output(),80);
    const servo=options.servos||config.servos,sv=new Float32Array(e.memory.buffer,e.rf_servo_config(),65);
    if(servo){
        if(!Number.isInteger(servo.count)||servo.count<1||servo.count>8||!Array.isArray(servo.parameters)||servo.parameters.length!==servo.count)throw Error('Invalid servo configuration.');
        const bounds=[[0,3000],[-1000,0],[0,1000],[50,1000],[50,1000],[25,5000],[0,60000],[0,3]];
        servo.parameters.forEach((row,a)=>{if(!row||row.length!==8||row.some((x,j)=>!Number.isInteger(x)||x<bounds[j][0]||x>bounds[j][1]))throw Error('Invalid servo configuration.');sv.set(row,a*8);});
        sv[64]=servo.count;
    }
    SCHEMA.forEach((f,i)=>{if(!numeric(v[f.name])||!Number.isInteger(v[f.name])||v[f.name]<f.min||v[f.name]>f.max)throw Error('Invalid controller parameter: '+f.name);cv[i]=v[f.name];});
    cv[255]=config.executeGovernor?1:0;e.rf_reset();
    function vector(x,name,size) {if(!x||x.length!==size||Array.from(x).some(y=>!numeric(y)))throw Error('Invalid controller input: '+name);return x;}
    function step(sample) {
        if(sample.mode&&sample.mode!=='acro'&&sample.mode!=='rate')throw Error('Unsupported flight mode.');
        iv.fill(0);iv[34]=-1;iv.set(vector(sample.setpoint,'setpoint',3),0);iv.set(vector(sample.gyro,'gyro',3),3);
        for(const [name,index] of [['collective',6],['headspeed',7],['spoolUpRatio',8],['throttle',11],['ttaIncrease',12]]) {
            if(!numeric(sample[name]))throw Error('Missing controller input: '+name);iv[index]=sample[name];
        }
        if(typeof sample.airborne!=='boolean'||typeof sample.spooledUp!=='boolean')throw Error('The flight controller condition is missing.');
        iv[9]=sample.airborne?1:0;iv[10]=sample.spooledUp?1:0;iv[13]=sample.gyroOverflow?1:0;
        if(sample.previousMixer){iv[14]=1;iv.set(vector(sample.previousMixer,'previousMixer',4),15);iv.set(vector(sample.saturation,'saturation',3),19);}
        if(sample.rcDeflection)iv.set(vector(sample.rcDeflection,'rcDeflection',4),24);
        if(numeric(sample.timeS))iv[34]=sample.timeS;
        iv[35]=sample.armed===false?1:0;
        if(config.executeGovernor) {
            for(const [name,index] of [['rawMotorRpm',36],['batteryVoltage',37],['throttleCommand',38]]){if(!numeric(sample[name]))throw Error('Missing governor input: '+name);iv[index]=sample[name];}
            if(typeof sample.throttleOff!=='boolean'||typeof sample.armed!=='boolean'||!sample.rcDeflection)throw Error('The governor condition is missing.');
            iv[39]=sample.throttleOff?1:0;iv[40]=sample.govBypass?1:0;iv[41]=sample.govSuspend?1:0;iv[42]=sample.govFallback?1:0;
        }
        e.rf_step();
        const terms={}; ['P','I','D','F','B','O','sum','gyro','axisError','axisOffset','saturation'].forEach((name,k)=>terms[name]=[ov[5+k],ov[16+k],ov[27+k]]);
        const governor={};['P','I','D','F','sum','targetHS','requestHS','currentHeadSpeed','state','ttaIncrease','spoolUpRatio','spooledUp','throttle'].forEach((name,k)=>governor[name]=ov[46+k]);
        return {u:[ov[0],ov[1],ov[2]],collective:ov[3],throttle:ov[4],terms,saturation:terms.saturation,servo:Array.from(ov.slice(38,46)),servoPwm:servo?Array.from(ov.slice(64,64+servo.count)):null,governor:config.executeGovernor?governor:null};
    }
    function seed(state) {iv.set(vector(state.axisError,'axisError',3),28);iv.set(vector(state.axisOffset,'axisOffset',3),31);e.rf_seed();}
    function mapMixer(sample){
        iv.set(vector(sample.u,'mixer',3),15);
        if(!numeric(sample.collective))throw Error('Missing collective mixer input.');
        if(sample.throttle!==undefined&&!numeric(sample.throttle))throw Error('The throttle mixer input is not correct.');
        iv[18]=sample.collective;iv[19]=sample.throttle||0;iv[35]=0;e.rf_map_mixer();
        return {servo:Array.from(ov.slice(38,46)),servoPwm:servo?Array.from(ov.slice(64,64+servo.count)):null};
    }
    return {step,seed,mapMixer,reset:()=>e.rf_reset(),status,capabilities:CAPABILITIES,config,artifactSha256:ARTIFACT};
}
async function replay(options) {const runtime=await create(options);if(options.initialState)runtime.seed(options.initialState);return {status:runtime.status,outputs:options.samples.map(s=>runtime.step(s)),capabilities:CAPABILITIES};}
// Finite-grid identification of unrecorded controller settings. Every candidate
// executes the same firmware artifact. All objective channels stay separate.
// Result uncertainty is conditional on the other supplied controller settings.
async function calibrate(options={}) {
    const config=options.config||{},samples=options.samples||[],observations=options.observations||[];
    if(samples.length!==observations.length)throw Error('The flight controller inputs and recorded outputs have different sample counts.');
    const count=samples.length,trainEnd=options.trainEnd==null?Math.floor(count*.6):options.trainEnd,
        selectionEnd=options.selectionEnd==null?Math.floor(count*.8):options.selectionEnd;
    const rate=1e6/((config.values||{}).pid_looptime||defaults().pid_looptime);
    const warmup=options.warmupSamples==null?Math.ceil(rate*.5):options.warmupSamples;
    const empty={config,estimates:[],resolved:[],unresolved:config.unknown||[],evaluated:0,
        provenance:{engine:CAPABILITIES.engine,artifactSha256:ARTIFACT,train:[warmup,trainEnd],selection:[trainEnd,selectionEnd],test:[selectionEnd,count]},
        limitations:['The estimates use the other flight controller values.','Flight controller values that give the same output stay unknown.']};
    if(!(warmup>=0&&warmup<trainEnd&&trainEnd<selectionEnd&&selectionEnd<count&&count-selectionEnd>=20))return {...empty,status:'insufficient',reason:'The flight controller replay does not have sufficient samples in different periods.'};
    const bytes=await bytesOf(options),unknown=new Set(config.unknown||SCHEMA.filter(f=>!own(config.values||{},f.name)).map(f=>f.name));
    const termNames=['P','I','D','F','B','O'];
    const observed=(n,t,a)=>{const row=observations[n];return row&&row.terms&&row.terms[t]?row.terms[t][a]:null;};
    const channels=[];
    for(const term of termNames)for(let a=0;a<3;a++) {
        let sum=0,n=0;for(let i=warmup;i<trainEnd;i++){const y=observed(i,term,a);if(numeric(y)){sum+=y*y;n++;}}
        if(n>=20)channels.push({term,axis:a,scale:Math.max(.001,Math.sqrt(sum/n)),trainingSamples:n});
    }
    if(!channels.length)return {...empty,status:'insufficient',reason:'The log does not record each PID term for flight controller replay.'};
    const base={...defaults(),...(config.values||{})},grids={};
    if(unknown.has('pid_mode'))grids.pid_mode=[3,4];
    if(base.iterm_relax_type!==0)for(let a=0;a<3;a++) {
        const name='iterm_relax_level['+a+']';
        if(unknown.has(name)&&(a<2||base.iterm_relax_type===2))grids[name]=[10,20,30,35,40,50,60,80,120,180,250];
    }
    // A caller can constrain the finite candidate values before seeing test data.
    if(options.grids)for(const [name,grid] of Object.entries(options.grids))if(unknown.has(name)&&SCHEMA.some(f=>f.name===name))grids[name]=Array.from(new Set(grid));
    const cache=new Map();let evaluated=0;
    const key=v=>Object.keys(grids).map(name=>v[name]).join('|');
    function initialState(values) {
        if(options.initialState)return options.initialState;
        const error=[0,0,0],offset=[0,0,0],collective=samples[0].previousMixer?samples[0].previousMixer[3]:samples[0].collective;
        for(let a=0;a<3;a++) {
            const gain=values[AXES[a]+'_i_gain']*(a===2?.0005:.0002),ival=observed(0,'I',a),oval=observed(0,'O',a);
            if(numeric(ival)&&gain>0)error[a]=values.pid_mode===4?ival:ival/gain;
            const ogain=values[AXES[a]+'_o_gain']*.0002;
            if(a<2&&numeric(oval)&&ogain>0&&Math.abs(collective)>.05)offset[a]=values.pid_mode===4?oval/collective:oval/(ogain*collective);
        }
        return {axisError:error,axisOffset:offset};
    }
    async function evaluate(values,full=false) {
        const k=key(values);if(!full&&cache.has(k))return cache.get(k);
        const runtime=await create({config:{...config,values},bytes});runtime.seed(initialState(values));
        const intervals=[[warmup,trainEnd],[trainEnd,selectionEnd],[selectionEnd,count]],stats=intervals.map(()=>channels.map(()=>({sum:0,n:0,blocks:new Array(4).fill(0),counts:new Array(4).fill(0)})));
        for(let i=0;i<(full?count:selectionEnd);i++) {
            const out=runtime.step(samples[i]);if(i<warmup)continue;
            const p=i<trainEnd?0:i<selectionEnd?1:2,[lo,hi]=intervals[p],block=Math.min(3,Math.floor((i-lo)*4/(hi-lo)));
            channels.forEach((c,j)=>{const y=observed(i,c.term,c.axis);if(!numeric(y))return;const d=out.terms[c.term][c.axis]-y,s=stats[p][j];s.sum+=d*d;s.n++;s.blocks[block]+=d*d;s.counts[block]++;});
        }
        const result={values:{...values},parts:stats.map((rows,p)=>{
            const details=rows.map((s,j)=>({term:channels[j].term,axis:channels[j].axis,n:s.n,rmse:s.n?Math.sqrt(s.sum/s.n):null,scale:channels[j].scale,blocks:s.blocks.map((x,b)=>s.counts[b]?x/s.counts[b]/(channels[j].scale**2):null)}));
            const valid=details.filter(x=>x.n>0);return {range:intervals[p],score:valid.length?valid.reduce((sum,x)=>sum+(x.rmse/x.scale)**2,0)/valid.length:Infinity,channels:details};
        })};evaluated++;if(!full)cache.set(k,result);return result;
    }
    const modeValues=grids.pid_mode||[base.pid_mode],finalists=[];
    for(const mode of modeValues) {
        let values={...base,pid_mode:mode},best=await evaluate(values);
        for(let pass=0;pass<2;pass++)for(const [name,grid] of Object.entries(grids)) {
            if(name==='pid_mode')continue;
            for(const value of grid) {const trial=await evaluate({...values,[name]:value});if(trial.parts[0].score<best.parts[0].score-1e-14){best=trial;}}
            values={...best.values};
        }
        finalists.push(best);
    }
    finalists.sort((a,b)=>a.parts[1].score-b.parts[1].score);
    const chosen=finalists[0]||await evaluate(base),estimates=[];
    const pairedGap=(first,second)=>{
        const deltas=[];for(let b=0;b<4;b++) {
            let sum=0,n=0;first.channels.forEach((c,i)=>{const x=c.blocks[b],y=second.channels[i].blocks[b];if(numeric(x)&&numeric(y)){sum+=y-x;n++;}});if(n)deltas.push(sum/n);
        }
        const mean=deltas.reduce((s,x)=>s+x,0)/Math.max(1,deltas.length),se=deltas.length>1?Math.sqrt(deltas.reduce((s,x)=>s+(x-mean)**2,0)/(deltas.length*(deltas.length-1))):Infinity;
        return {mean,se,blocks:deltas.length};
    };
    for(const [name,grid] of Object.entries(grids)) {
        const alternatives=[];
        for(const value of grid)if(value!==chosen.values[name])alternatives.push(await evaluate({...chosen.values,[name]:value}));
        alternatives.sort((a,b)=>a.parts[1].score-b.parts[1].score);
        const other=alternatives[0],gap=other?pairedGap(chosen.parts[1],other.parts[1]):{mean:0,se:Infinity,blocks:0};
        const allGaps=alternatives.map(other=>pairedGap(chosen.parts[1],other.parts[1]));
        const identified=allGaps.length>0&&allGaps.every(g=>g.blocks===4&&g.mean>Math.max(1e-7,2*g.se));
        estimates.push({name,value:chosen.values[name],candidates:grid,alternative:other?other.values[name]:null,
            selectionGap:gap,identified,source:'identified from separate logged PID terms',scope:'conditional on the other supplied controller values'});
    }
    // The frozen choice sees the final contiguous test interval once. No value
    // is selected or changed using that interval.
    const tested=await evaluate(chosen.values,true),test=tested.parts[2];
    const testPassed=test.channels.every(c=>c.n>=20&&c.rmse<=Math.max(.0015,.05*c.scale));
    const resolved=estimates.filter(e=>e.identified&&testPassed).map(e=>e.name);
    const remaining=[...unknown].filter(name=>!resolved.includes(name));
    const calibrated={...config,values:{...(config.values||{})},sources:{...(config.sources||{})},unknown:remaining,
        assumptions:(config.assumptions||[]).filter(a=>!resolved.includes(a.name)),
        controllerCalibration:{artifactSha256:ARTIFACT,testPassed,resolved,conditional:true}};
    for(const e of estimates){calibrated.values[e.name]=e.value;calibrated.sources[e.name]=resolved.includes(e.name)?e.source:'unresolved controller estimate';}
    return {...empty,config:calibrated,status:resolved.length?'identified':'unresolved',estimates,resolved,unresolved:remaining,evaluated,
        channels,training:tested.parts[0],selection:tested.parts[1],test:{...test,passed:testPassed},
        rule:'The selected value must give an error change of more than two standard errors between periods. All PID term checks on the last period must agree.'};
}
module.exports={SCHEMA,COMMIT,ARTIFACT,CAPABILITIES,defaults,servoConfig,SERVO_FIELDS,fromHeader,pitchLimits,requiredFields,compatibility,create,replay,calibrate};
if(require.main!==module)return;
