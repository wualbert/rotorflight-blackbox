'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const N=require('../tools/autotune/firmware_sensor.cjs'),FT=require('../tools/autotune/filter_tune.cjs'),R=require('../tools/autotune/filter_replay.cjs');
function cfg(type=1){return FT.config({looptime:500,pid_process_denom:2,filter_process_denom:2,frameIntervalPNum:1,frameIntervalPDenom:1,
 gyro_soft_type:type,gyro_lowpass_hz:160,gyro_soft2_type:0,gyro_lowpass2_hz:0,gyro_lowpass_dyn_hz:[0,0],gyro_notch_hz:[237,0],gyro_notch_cutoff:[220,0],
 features:(1<<29)|(1<<30),dyn_notch_count:2,dyn_notch_q:50,dyn_notch_min_hz:80,dyn_notch_max_hz:350,gyro_rpm_notch_preset:1,gyro_rpm_notch_min_hz:20},
 {gear:{main:[2,15],tail:[1,4],motorisedTail:false}});}
test('native gyro sensor code has no host imports and exact source provenance',()=>{
 const bytes=fs.readFileSync(path.join(__dirname,'../tools/autotune/firmware/sensor.wasm')),metadata=require('../tools/autotune/firmware/sensor.json');
 assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),N.ARTIFACT);assert.equal(metadata.artifactSha256,N.ARTIFACT);
 assert.equal(metadata.commit,N.COMMIT);assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)),[]);
 assert.ok(metadata.files['sensors/gyro_filter_impl.c']);assert.ok(metadata.files['flight/rpm_filter.c']);assert.ok(metadata.files['flight/dyn_notch_filter.c']);
});
test('native gyro filter agrees with independently examined filter equations for all filter types',async()=>{
 for(let type=0;type<=9;type++){
  const c=cfg(type),native=await N.create(c),reference=R.engine(c,Array(3).fill({gyro_cutoff:0,d_cutoff:0,Kp:0,Kd:0}));let sum=0,n=0;
  for(let i=0;i<6000;i++){
   const t=i/1000,raw=[0,1,2].map(a=>20*Math.sin(2*Math.PI*155*t+a)+6*Math.sin(2*Math.PI*237*t)+10*Math.sin(2*Math.PI*13*t)),hs=3000+1200*Math.sin(t/2);
   const actual=native.tick(raw,hs,4*hs),expected=reference.tick(raw,hs,4*hs,1);
   if(i>500)for(let a=0;a<3;a++){sum+=(actual[a]-expected[a])**2;n++;}
  }
  assert.ok(Math.sqrt(sum/n)<.03,'type '+type+' RMS '+Math.sqrt(sum/n));
 }
});
test('native gyro sensor path rejects invalid rate boundaries and corrupt source artifact',async()=>{
 const c=cfg();c.rates.pidHz=500;await assert.rejects(N.create(c),/different sample rates/);
 const bytes=fs.readFileSync(path.join(__dirname,'../tools/autotune/firmware/sensor.wasm'));bytes[30]^=1;
 await assert.rejects(N.create(cfg(),{bytes}),/does not agree/);
});
test('native gyro sensor rejects unknown active settings and custom RPM banks',async()=>{
 const c=cfg();c.s.gyro_rpm_notch_preset=0;
 await assert.rejects(N.create(c),/unknown values/);
 c.s.RPM_FILTER=false;await N.create(c);
 c.s.DYN_NOTCH=null;await assert.rejects(N.create(c),/DYN_NOTCH/);
});
