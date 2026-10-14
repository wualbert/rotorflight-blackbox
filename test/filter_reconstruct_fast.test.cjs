'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Module}=require('node:module');
const R=require('../tools/autotune/filter_replay.cjs'),FT=require('../tools/autotune/filter_tune.cjs');

function configuration(pidDenom,dynamicLpf=false,numerator=1) {
    return FT.config({looptime:125,pid_process_denom:pidDenom,filter_process_denom:pidDenom%2?1:2,
        frameIntervalPNum:numerator,frameIntervalPDenom:2,gyro_soft_type:1,gyro_lowpass_hz:100,
        gyro_soft2_type:0,gyro_lowpass2_hz:0,gyro_lowpass_dyn_hz:dynamicLpf?[60,180]:[0,0],
        gyro_notch_hz:[0,0],gyro_notch_cutoff:[0,0],features:(1<<29)|(1<<30),gyro_rpm_notch_preset:1,
        gyro_rpm_notch_min_hz:20,dyn_notch_count:6,dyn_notch_q:25,dyn_notch_min_hz:20,dyn_notch_max_hz:240},
        {gear:{main:[2,15],tail:[1,4],motorisedTail:false}});
}

test('selective-axis suffix replay preserves scheduler, RPM and held PID state exactly',()=>{
    for(const pidDenom of [2,3,6,8])for(const dynamicLpf of [false,true]) {
        const cfg=configuration(pidDenom,dynamicLpf);
        const pid=Array.from({length:3},(_,a)=>({gyro_cutoff:80+a*10,d_cutoff:35,Kp:.005,Kd:.00005}));
        const raw=i=>[0,1,2].map(a=>23*Math.sin(i*.023+a)+7*Math.sin(i*.171+a*.4)+3*Math.cos(i*i*.0003+a));
        const drive=i=>[3000+120*Math.sin(i*.07),0,.9+.3*Math.cos(i*.03)];
        const total=193,cache=[],full=R.engine(cfg,pid,{rpmCoefficients:cache,dynamicUpdates:17}),values=[],states=[];
        for(let i=0;i<total;i++) {
            states[i]=full.snapshot(true);full.tick(raw(i),...drive(i));
            values[i]={gyro:[...full.gyro],pidGyro:[...full.pidGyro],dterm:[...full.dterm],out:[...full.out]};
        }
        for(const axes of [[0],[1],[2],[0,2]])for(const prefix of [1,7,16]) {
            const E=R.engine(cfg,pid,{state:states[prefix],axes,rpmCoefficients:cache,coefficientOffset:prefix});
            for(let i=prefix;i<total;i++) {
                E.tick(raw(i).map((x,a)=>axes.includes(a)?x:NaN),...drive(i));
                for(const a of axes)for(const key of ['gyro','pidGyro','dterm','out'])
                    assert.equal(E[key][a],values[i][key][a],`${pidDenom}/${dynamicLpf}, axes ${axes}, prefix ${prefix}, tick ${i}, axis ${a}, ${key}`);
            }
        }
    }
});

test('every streamed and prefix-reused trial score equals the complete nonlinear replay score',()=>{
    // Assert on every actual trial rather than duplicating the private search
    // loop in the test. The complete original merit remains the reference.
    const file=path.resolve(__dirname,'../tools/autotune/filter_reconstruct.cjs');
    let source=fs.readFileSync(file,'utf8');
    const replace=(from,to)=>{assert.ok(source.includes(from),'score-check instrumentation target exists');source=source.replace(from,to);};
    replace('const FT =',"const assert=require('node:assert/strict');const reviewed={line:0,local:0,fractional:0,active:{}};\nconst FT =");
    replace('const score = trialScore(trial);','const score = trialScore(trial);assert.deepStrictEqual(score,merit(trial,forward(cfg,seg,start,trial,pid,false,cache)));reviewed.line++;');
    replace('const score=trialScore(trial,prefix,active);','const score=trialScore(trial,prefix,active);const complete=merit(trial,forward(cfg,seg,start,trial,pid,false,cache));for(const a of active)assert.equal(score[a],complete[a],`suffix score at ${lo}, axis ${a}`);reviewed.local++;reviewed.active[active.join(",")]=(reviewed.active[active.join(",")]||0)+1;');
    replace('if(!aligned)return merit(x,forward(cfg,seg,start,x,pid,false,cache));','if(!aligned){reviewed.fractional++;const score=merit(x,forward(cfg,seg,start,x,pid,false,cache));assert.ok(score.some(Number.isNaN));return score;}');
    source+='\nmodule.exports.reviewed=reviewed;';
    const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(source,file);const C=m.exports;
    for(const pidDenom of [2,3,6])for(const fixedPrefix of [0,128]) {
        const cfg=configuration(pidDenom),frames=384,nativeFactor=cfg.rates.gyroHz/cfg.rates.logHz,filterFactor=cfg.rates.filterHz/cfg.rates.logHz;
        const signal=(i,a)=>a===2?0:14*Math.sin(i*.019+a)+7*Math.cos(i*.113+a)+3*Math.sin(i*i*.000011);
        const pid=Array(3).fill({gyro_cutoff:0,d_cutoff:0,Kp:0,Kd:0,known:false});
        const seg={n:frames,cfg,raw:[0,1,2].map(a=>Float64Array.from({length:frames},(_,i)=>signal(i*nativeFactor+cfg.rates.offsetTicks,a))),
            filt:Array.from({length:3},()=>new Float64Array(frames)),hs:new Float64Array(frames).fill(3000),w:{}};
        const engine=R.engine(cfg,pid);
        for(let k=0;k<frames*filterFactor;k++) {
            engine.tick([0,1,2].map(a=>signal(k*cfg.rates.filtDenom,a)),3000,0,1);
            if(k%filterFactor===0)for(let a=0;a<3;a++)seg.filt[a][k/filterFactor]=engine.gyro[a];
        }
        C.reconstruct(cfg,seg,0,frames,pid,{iterations:8,rounds:9,fixedPrefix});
    }
    assert.ok(C.reviewed.line>0&&C.reviewed.local>0);
    assert.ok(C.reviewed.active['2']>0,'a single stalled axis uses the retained shared scheduler');
    // Fractional rates use the previous complete-merit path, including its
    // unavailable observations. They cannot gain a pass by skipping frames.
    const cfg=configuration(2,false,3),n=384,pid=Array(3).fill({gyro_cutoff:0,d_cutoff:0,Kp:0,Kd:0,known:false});
    const seg={n,cfg,raw:Array.from({length:3},()=>new Float64Array(n)),filt:Array.from({length:3},()=>new Float64Array(n)),hs:new Float64Array(n).fill(3000),w:{}};
    C.reconstruct(cfg,seg,0,n,pid,{iterations:2,rounds:9});
    assert.ok(C.reviewed.fractional>0,'fractional observations use the unchanged complete merit');
});
