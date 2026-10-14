'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../tools/autotune/filter_reconstruct.cjs'),R=require('../tools/autotune/filter_replay.cjs'),FT=require('../tools/autotune/filter_tune.cjs'),A=require('../tools/autotune/filter_autotune.cjs');
function fixture() {
    const n=15000,rate=2000,logHz=1000;
    const truth={gyro_cutoff:100,d_cutoff:20,Kp:.01,Kd:.00003,stopGain:[.9,1.3],known:true};
    const native=Float64Array.from({length:n*2},(_,i)=>60*Math.sin(2*Math.PI*13*i/rate)+20*Math.sin(2*Math.PI*37*i/rate)+8*Math.sin(2*Math.PI*71*i/rate));
    const gyro=C.filter(native,[FT.firstOrderLpf(truth.gyro_cutoff,rate)]),d=C.filter(gyro,[FT.difSection(truth.d_cutoff,rate).map((v,i)=>i<3?-v*truth.Kd:v)]);
    const sp=Float64Array.from({length:n},(_,i)=>45*Math.sin(2*Math.PI*.7*i/logHz));
    const p=Float64Array.from(sp,(v,i)=>{const e=v-gyro[i*2],t=Math.max(0,Math.min(1,(e+10)/20));return R.quantize(truth.Kp*e*(.9+.4*t)*1000)/1000;});
    const logged=Float64Array.from({length:n},(_,i)=>R.quantize(native[i*2]));
    const seg={n,cfg:{rates:{pidHz:rate,logHz}},filt:[logged,logged,logged],w:{P:[p,p,p],D:[null,null,Float64Array.from({length:n},(_,i)=>R.quantize(d[2*i]*1000)/1000)],sp:[sp,sp,Float64Array.from(sp,R.quantize)]}};
    const windows=Array.from({length:11},(_,i)=>({st:2000+i*1024,N:1024,lead:2000,profile:2,held:i>=9}));
    return {seg,windows,truth};
}
test('stale inherited P/D gains are replaced only by an accepted training fit at the recorded cutoffs',()=>{
    const {seg,windows,truth}=fixture(),wrong={...truth,Kp:truth.Kp/2,Kd:truth.Kd/3,stopGain:[1,1.4]},saved=structuredClone(wrong);
    const {observer,validation}=C.validatePidObserver(seg,windows,2,wrong);
    assert.equal(validation.contradicted,true);assert.equal(validation.channels.P.action,'identified');assert.equal(validation.channels.D.action,'identified');
    assert.ok(Math.abs(observer.Kp-(.9+1.3)*truth.Kp/2)<.0001);
    assert.ok(Math.abs(observer.Kp*observer.stopGain[0]-truth.Kp*.9)<.0001);
    assert.ok(Math.abs(observer.Kp*observer.stopGain[1]-truth.Kp*1.3)<.0001);
    assert.ok(Math.abs(observer.Kd/truth.Kd-1)<.01);
    assert.equal(observer.gyro_cutoff,truth.gyro_cutoff);assert.equal(observer.d_cutoff,truth.d_cutoff);
    assert.deepEqual(wrong,saved,'the recorded values are never overwritten');
    assert.deepEqual(validation.declared,saved);assert.equal(validation.channels.P.fit.accepted,true);
});
test('correct known gains retain their original object and arithmetic even if a new gain fit is available',()=>{
    const {seg,windows,truth}=fixture(),out=C.validatePidObserver(seg,windows,2,truth);
    assert.equal(out.validation.contradicted,false);assert.equal(out.observer,truth);
    assert.deepEqual(out.validation.identified,{});assert.equal(out.validation.channels.D.action,'retained');
});
test('reserved windows and every fifth observation cannot affect detection, fitted gains, or PID filter history',()=>{
    const {seg,windows,truth}=fixture(),wrong={...truth,Kp:truth.Kp/2,Kd:truth.Kd/3};
    const training=C.pidTraining(seg,windows),before=C.validatePidObserver(seg,windows,2,wrong,training);
    for(let i=0;i<seg.n;i++)if(training.skip[i]) {
        seg.filt[2][i]=1e8+i*.123;
        seg.w.P[2][i]=-2e9+i*.321;seg.w.D[2][i]=3e10-i*.456;seg.w.sp[2][i]=-4e11;
    }
    assert.deepEqual(C.validatePidObserver(seg,windows,2,wrong),before);
});
test('a contradicted channel with insufficient training data is omitted without discarding a consistent channel',()=>{
    const {seg,windows,truth}=fixture(),short=windows.slice(0,2),wrong={...truth,Kd:truth.Kd/3};
    const out=C.validatePidObserver(seg,short,2,wrong);
    assert.equal(out.validation.channels.P.action,'retained');assert.equal(out.observer.Kp,truth.Kp);assert.equal(out.observer.stopGain,truth.stopGain);
    assert.equal(out.validation.channels.D.action,'omitted');assert.equal(out.observer.Kd,0);assert.equal(out.observer.known,true);
    assert.equal(out.validation.channels.D.fit.accepted,false);assert.ok(out.validation.channels.D.samples<3000);
});
test('contradicted inherited gains stay unknown for candidate P+D scoring and cannot supply PID cutoff CLI rows',()=>{
    const {seg,windows,truth}=fixture(),header={looptime:250,pid_process_denom:2,filter_process_denom:2,frameIntervalPNum:1,frameIntervalPDenom:2,
        features:0,gyro_soft_type:1,gyro_lowpass_hz:100,gyro_soft2_type:0,gyro_lowpass2_hz:0,gyro_lowpass_dyn_hz:[0,0],
        gyro_notch_hz:[0,0],gyro_notch_cutoff:[0,0],gyro_decimation_hz:0,
        rollBW:[100,20],pitchBW:[100,20],yawBW:[100,20],rollPID:[50,100,0],pitchPID:[50,100,0],yawPID:[75,100,10],yaw_stop_gain:[140,100]};
    const original=structuredClone(header),gyro=seg.filt.map(x=>new Float64Array(x)),n=seg.n;
    const item={w:{n,rate:1000,gyro,hs:new Float64Array(n).fill(3000),profileAt:new Uint8Array(n).fill(2),
        P:[new Float64Array(n),new Float64Array(n),seg.w.P[2]],D:[new Float64Array(n),new Float64Array(n),seg.w.D[2]],sp:[new Float64Array(n),new Float64Array(n),seg.w.sp[2]],
        recordedConfiguration:{id:'inherited',assumed:true},extra:Object.fromEntries(gyro.map((x,a)=>[`gyroRAW[${a}]`,x])),
        flight:{log:0,file:'test',firmware:'Rotorflight 4.6.0',header,actualRate:1000}},mask:new Uint8Array(n).fill(1),armingProfile:2};
    const prepared=A.prepare([item],{logGear:false}),s=prepared.segments[0],w=prepared.windows[0],path=A.paths(w,{})[2];
    assert.equal(s.observerValidation[2][2].contradicted,true);assert.equal(path.known,false);assert.equal(path.contradicted,true);
    assert.ok(prepared.notes.some(note=>note.includes('PID profile 2, yaw: The PID configuration does not agree with the recorded PID signals.')));
    assert.equal(path.Kp,s.observers[2][2].Kp);assert.equal(path.Kd,s.observers[2][2].Kd);
    assert.equal(prepared.targetProfiles['p2:yaw_gyro_cutoff'],undefined);
    assert.equal(A.rowsFor(prepared,{'p2:yaw_gyro_cutoff':180}).length,0);
    assert.deepEqual(header,original);
    item.w.recordedConfiguration.assumed=false;
    const trusted=A.prepare([item],{logGear:false});
    assert.deepEqual(trusted.segments[0].observerValidation,{});assert.equal(A.paths(trusted.windows[0],{})[2].known,true,'direct header provenance retains its established behavior');
});
