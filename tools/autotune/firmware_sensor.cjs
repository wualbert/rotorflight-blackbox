'use strict';
// Exact pinned gyro filter, RPM-filter and SDFT bodies. Raw sample acquisition is external.
const FT=require('./filter_tune.cjs');
const COMMIT='118e9120260bb33f46df4f92052fb0e9fd4e9ebc';
const ARTIFACT='cebd031161d6c1d2d44f876c28e9963fc42a71b512a9eae6a55901db0bfa4668';
function unknownSettings(cfg){
 const s=cfg.s,from=cfg.from||{},unknown=[],need=name=>{if(s[name]==null||from[name]==='default')unknown.push(name);};
 for(const n of [1,2]){need('gyro_lpf'+n+'_type');if(s['gyro_lpf'+n+'_type']>0)need('gyro_lpf'+n+'_static_hz');
  need('gyro_notch'+n+'_hz');if(s['gyro_notch'+n+'_hz']>0)need('gyro_notch'+n+'_cutoff');}
 if(s.gyro_lpf1_type>0&&s.gyro_lpf1_static_hz>0){need('gyro_lpf1_dyn_min_hz');need('gyro_lpf1_dyn_max_hz');}
 need('DYN_NOTCH');need('RPM_FILTER');
 if(s.DYN_NOTCH&&cfg.rates.pidHz>=1000){need('dyn_notch_count');if(s.dyn_notch_count>0)for(const k of ['q','min_hz','max_hz'])need('dyn_notch_'+k);}
 if(s.RPM_FILTER){need('gyro_rpm_notch_preset');need('gyro_rpm_notch_min_hz');
  if(s.gyro_rpm_notch_preset===0)for(const a of ['roll','pitch','yaw'])for(const k of ['source','q','center'])need('gyro_rpm_notch_'+k+'_'+a);}
 return unknown;
}
async function bytesOf(options){
 if(options.bytes)return options.bytes;
 if(typeof process!=='undefined'&&process.versions&&process.versions.node)return require('node:fs').readFileSync(require('node:path').join(__dirname,'firmware/sensor.wasm'));
 const response=await fetch(options.url||'../tools/autotune/firmware/sensor.wasm');if(!response.ok)throw Error('The app cannot load the gyro filter code.');return new Uint8Array(await response.arrayBuffer());
}
async function create(cfg,options={}){
 const unknown=unknownSettings(cfg);if(unknown.length)throw Error('The gyro filter configuration has unknown values: '+unknown.join(', ')+'.');
 const model=FT.compile(cfg),R=cfg.rates,s=cfg.s;
 if(model.leftOut.length)throw Error('The gyro filter has an unknown RPM input.');
 if(model.dynLpf)throw Error('A governor input is necessary for the gyro filter.');
 if(Math.abs(R.filterHz/R.pidHz-1)>1e-9)throw Error('The gyro filter and PID loop have different sample rates.');
 const bytes=await bytesOf(options);let hash;
 if(typeof process!=='undefined'&&process.versions&&process.versions.node)hash=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
 else hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
 if(hash!==ARTIFACT)throw Error('The gyro filter file does not agree with the source file.');
 const {instance}=await WebAssembly.instantiate(bytes,{}),e=instance.exports;if(e._initialize)e._initialize();
 const cv=new Float32Array(e.memory.buffer,e.rs_config(),192),iv=new Float32Array(e.memory.buffer,e.rs_input(),8),ov=new Float32Array(e.memory.buffer,e.rs_output(),3);
 const lpf=name=>model.statics.find(x=>x.name===name)||{type:0,hz:0},notch=name=>model.statics.find(x=>x.name===name)||{hz:0,q:1},one=lpf('LPF1'),two=lpf('LPF2'),n1=notch('notch1'),n2=notch('notch2');
 const gear=cfg.gear||{},ratio=x=>x&&x[0]>0&&x[1]>0?x[0]/x[1]:1,main=gear.motorOrder>0?1/gear.motorOrder:ratio(gear.main),tail=gear.tailOrder>0?1/gear.tailOrder:ratio(gear.tail);
 cv.set([R.filterHz,R.pidHz,R.scale||1,one.type,one.hz,two.type,two.hz,model.dyn.on?s.dyn_notch_count:0,s.dyn_notch_q||25,s.dyn_notch_min_hz||20,s.dyn_notch_max_hz||240,s.RPM_FILTER!==false?1:0,s.gyro_rpm_notch_min_hz||20,n1.hz,n1.q,n2.hz,n2.q,main,gear.motorisedTail?tail:main/tail,gear.motorisedTail?1:0]);
 FT.effectiveBanks(s).forEach((banks,a)=>(banks||[]).slice(0,16).forEach((b,j)=>cv.set([b.source,b.q,b.center],32+3*(a*16+j))));
 e.rs_reset();if(e.rs_errors())throw Error('The gyro RPM filter configuration is not correct.');
 const needsTail=model.rpm.some(banks=>banks.some(b=>b.ref==='tail'));
 function tick(raw,headspeed,tailSpeed){if(!raw||raw.length!==3||Array.from(raw).some(x=>!Number.isFinite(x))||!Number.isFinite(headspeed)||(needsTail&&!Number.isFinite(tailSpeed)))throw Error('The gyro filter input is not correct.');iv.set(raw);iv[3]=headspeed;iv[4]=Number.isFinite(tailSpeed)?tailSpeed:headspeed;e.rs_tick();return ov;}
 return {tick,gyro:ov,model,engine:'upstream-c-wasm',artifactSha256:ARTIFACT,sourceRevision:COMMIT};
}
module.exports={create,unknownSettings,ARTIFACT,COMMIT};if(require.main!==module)return;
