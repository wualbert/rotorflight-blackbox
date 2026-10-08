'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), cp = require('node:child_process');
const C = require('../tools/autotune/filter_reconstruct.cjs'), R = require('../tools/autotune/filter_replay.cjs'), FT = require('../tools/autotune/filter_tune.cjs');
const native = require('./helpers/filter_acquisition.cjs');
test('the reconstruction adjoint includes variable coefficients, fade and inter-stage state', () => {
    const n = 400, x = Float64Array.from({length:n}, (_,i)=>Math.sin(i*1.7)), g=Float64Array.from(x,(_,i)=>Math.cos(i*.3));
    const tape = [1,2,3].map((_,j)=>{const t=new Float64Array(n*6);for(let i=0;i<n;i++){t.set(FT.biquad('notch',100+i*.1,1000,2+j),i*6);t[i*6+5]=.5+.5*Math.sin(i*.001+j);}return t;});
    const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
    assert.ok(Math.abs(dot(C.chain(x,tape),g)-dot(x,C.chain(g,tape,true)))<1e-10);
    const initial={x1:2,x2:-3,y1:4,y2:-5},bias=C.stage(new Float64Array(n),tape[0],false,initial);
    const withState=C.stage(x,tape[0],false,initial),linear=C.stage(x,tape[0]);
    for(let i=0;i<n;i++)assert.ok(Math.abs(withState[i]-linear[i]-bias[i])<1e-12,'the retained-state contribution is affine and independent of the unknown input');
});
test('governor ratio uses the recovered motor input, the governor PT2 and full profile headspeed', () => {
    const n=6000,rate=2000,factor=2,raw=Float64Array.from({length:n*factor},(_,i)=>3000+120*Math.sin(2*Math.PI*3*i/rate));
    const motor=C.filter(raw,FT.lowpassSections(8,100,rate));
    const gov=C.filter(Float64Array.from(raw,(_,i)=>raw[Math.max(0,i-1)]),FT.lowpassSections(4,10,rate));
    const w={n,hs:Float64Array.from({length:n},(_,i)=>Math.round(motor[i*factor])),govStateAt:new Uint8Array(n).fill(4),extra:{govRequest:new Float64Array(n).fill(1800)}};
    const cfg={rates:{pidHz:rate,logHz:1000},s:{motor_rpm_lpf:[100,100,100,100]}};
    const cli={global:{gov_mode:'ELECTRIC',gov_rpm_filter:10},profiles:{0:{gov_headspeed:3000}}},profiles=new Uint8Array(n).fill(1);
    const result=C.governorRatio(cfg,w,profiles,cli);
    let error=0;for(let i=1000;i<n-100;i++)error+=(result.values[i]-gov[i*factor]/3000)**2;
    assert.ok(Math.sqrt(error/(n-1100))<0.0001);
    cli.global.gov_mode='DIRECT';assert.ok(C.governorRatio(cfg,w,profiles,cli).values.every(x=>x===1));
    cli.global.gov_mode='ELECTRIC';delete cli.profiles[0].gov_headspeed;assert.equal(C.governorRatio(cfg,w,profiles,cli),null);
});
test('Blackbox rounding follows lrintf, including negative half-integers', () => {
    assert.deepEqual([-.5,-1.5,-2.5,.5,1.5,2.5].map(R.quantize),[0,-2,-2,0,2,2]);
});
test('the pre-log SDFT phase is identified from independent native C observations without reserved data',t=>{
    const dir=fs.mkdtempSync(os.tmpdir()+'/rf-phase-');
    try {
        const exe=native.build(dir),rate=4000,n=44000,cut=3003;
        // Seven moving lines keep every tracker active. Large signal/rounding
        // separation makes the discrete phase identifiable in this fixture.
        const input=Array.from({length:n},(_,i)=>[0,1,2].map(a=>400*Math.sin(2*Math.PI*13*i/rate+a)+
            [39,67,95,125,158,197,227].reduce((s,f,j)=>s+20*(4+j)*Math.sin(2*Math.PI*(f*i/rate+.03*(j+1)*(i/rate)**2)+a),0)).concat(3000).join(' ')).join('\n')+'\n';
        const logged=cp.execFileSync(exe,['4000','2','2','6','100','500'],{input,maxBuffer:8e6}).toString().trim().split('\n').map(l=>l.split(' ').map(Number)).slice(cut);
        const cfg=FT.config({looptime:250,pid_process_denom:2,filter_process_denom:2,frameIntervalPNum:1,frameIntervalPDenom:2,
            gyro_soft_type:1,gyro_lowpass_hz:100,gyro_soft2_type:0,gyro_lowpass2_hz:0,gyro_lowpass_dyn_hz:[0,0],gyro_notch_hz:[0,0],gyro_notch_cutoff:[0,0],
            features:(1<<30)|(1<<29),gyro_rpm_notch_preset:1,gyro_rpm_notch_min_hz:20,gyro_decimation_hz:500},{gear:{main:[2,15],tail:[1,4],motorisedTail:false}});
        const pid=Array(3).fill({gyro_cutoff:80,d_cutoff:35,Kp:.005,Kd:.00005,known:true});
        const seg={cfg,n:logged.length,hs:new Float64Array(logged.length).fill(3000),raw:[0,1,2].map(a=>Float64Array.from(logged,l=>l[1+a*4])),
            filt:[0,1,2].map(a=>Float64Array.from(logged,l=>l[2+a*4])),observers:{1:pid}};
        seg.w={P:[0,1,2].map(a=>Float64Array.from(logged,l=>R.quantize(-l[3+a*4]*pid[a].Kp*1000)/1000)),
            D:[0,1,2].map(a=>Float64Array.from(logged,l=>R.quantize(l[4+a*4]*pid[a].Kd*1000)/1000)),sp:Array.from({length:3},()=>new Float64Array(logged.length))};
        const windows=Array.from({length:5},(_,i)=>({st:2000+i*1024,N:1024,lead:2000,profile:1,held:i===4}));
        const fit=C.calibrateTiming(seg,windows);
        assert.ok(fit.identified);assert.equal(fit.phase,cut*2%12);assert.equal(fit.period,12);
        t.diagnostic('Recovered pre-log update phase '+fit.phase+'; relative separation '+fit.relativeSeparation.toFixed(3));
        const last=windows[4];
        for(const x of seg.filt)x.fill(1e6,last.st,last.st+last.N);
        for(const x of seg.w.D)x.fill(1e6,last.st,last.st+last.N);
        assert.deepEqual(C.calibrateTiming(seg,windows),fit,'reserved flight outputs do not influence phase calibration');
        for(const x of seg.raw)x.fill(0);for(const x of seg.filt)x.fill(0);
        for(const xs of [seg.w.P,seg.w.D,seg.w.sp])for(const x of xs)x.fill(0);
        const flat=C.calibrateTiming(seg,windows);
        assert.equal(flat.identified,false,'an unexcited recording cannot identify its pre-log phase');
        assert.equal(flat.phase,0);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('scheduler clock reconstruction rejects the bias from delayed Blackbox frames',()=>{
    let now=0;
    const t=Float64Array.from({length:20000},(_,i)=>now+=987+(i%20===0?247:0));
    const average=(t.length-1)*1e6/(t[t.length-1]-t[0])/1000;
    assert.ok(Math.abs(average-1e3/987)>.01);
    assert.equal(C.schedulerScale(t,1000,average),1e3/987);
    assert.equal(C.schedulerScale(null,1000,.997),.997);
});
test('a derivative-only observer can use yaw D without inventing yaw P or a profile configuration', () => {
    const n=16000,rate=2000,gyro=Float64Array.from({length:2*n},(_,i)=>12*Math.sin(2*Math.PI*13*i/rate)+7*Math.sin(2*Math.PI*87*i/rate)+4*Math.sin(2*Math.PI*219*i/rate));
    const output=C.filter(gyro,[FT.firstOrderLpf(100,rate),FT.difSection(20,rate).map((v,i)=>i<3?-v*.000014:v)]);
    const down=x=>Float64Array.from({length:n},(_,i)=>x[2*i]);
    const seg={cfg:{rates:{pidHz:rate,logHz:1000}},filt:[gyro,gyro,down(gyro)],w:{D:[null,null,down(output)]}};
    const windows=Array.from({length:6},(_,i)=>({st:2000+i*2000,lead:2000,N:1024}));
    const observer=C.pidObserver(seg,windows,2);
    assert.ok(observer&&observer.derivativeOnly);
    assert.equal(observer.Kp,0);
    assert.ok(observer.fit.D.r2>.999);
    const response=C.filter(gyro,[FT.firstOrderLpf(observer.gyro_cutoff,rate),FT.difSection(observer.d_cutoff,rate).map((v,i)=>i<3?-v*observer.Kd:v)]);
    let error=0,power=0;for(let i=4000;i<gyro.length-100;i++){error+=(response[i]-output[i])**2;power+=output[i]**2;}
    assert.ok(Math.sqrt(error/power)<.01);
});
test('PID observer calibration accounts for quantized gyro measurements',()=>{
    const n=16000,rate=2000,gyro=Float64Array.from({length:2*n},(_,i)=>12*Math.sin(2*Math.PI*13*i/rate)+7*Math.sin(2*Math.PI*87*i/rate)+4*Math.sin(2*Math.PI*219*i/rate));
    const output=C.filter(gyro,[FT.firstOrderLpf(100,rate),FT.difSection(20,rate).map((v,i)=>i<3?-v*.000014:v)]);
    const down=(x,scale)=>Float64Array.from({length:n},(_,i)=>R.quantize(x[2*i]*scale)/scale);
    const seg={cfg:{rates:{pidHz:rate,logHz:1000}},filt:[null,null,down(gyro,1)],w:{D:[null,null,down(output,1000)]}};
    const observer=C.pidObserver(seg,Array.from({length:6},(_,i)=>({st:2000+i*2000,lead:2000,N:1024})),2);
    assert.ok(observer&&observer.fit.D.noiseVariance>0);
    const response=C.filter(gyro,[FT.firstOrderLpf(observer.gyro_cutoff,rate),FT.difSection(observer.d_cutoff,rate).map((v,i)=>i<3?-v*observer.Kd:v)]);
    let error=0,power=0;for(let i=4000;i<gyro.length;i++){error+=(response[i]-output[i])**2;power+=output[i]**2;}
    assert.ok(Math.sqrt(error/power)<.005,'identified response agrees with the unrounded native reference');
});
test('adaptive-notch linearization includes peak motion and has an exact transpose',()=>{
    const cfg=FT.config({looptime:250,pid_process_denom:2,filter_process_denom:2,frameIntervalPNum:1,frameIntervalPDenom:2,
        gyro_soft_type:1,gyro_lowpass_hz:100,gyro_soft2_type:0,gyro_lowpass_dyn_hz:[0,0],features:1<<29,
        dyn_notch_count:6,dyn_notch_q:25,dyn_notch_min_hz:20,dyn_notch_max_hz:240});
    const n=6000,pid=Array(3).fill({gyro_cutoff:0,d_cutoff:0,Kp:0,Kd:0}),pre=R.engine(cfg,pid);
    const raw=[0,1,2].map(a=>Float64Array.from({length:n},(_,i)=>20*Math.sin(i*.033+a)+6*Math.sin(i*.2+a)+5*Math.sin(i*.53)+2*Math.sin(i*.03*i)+.001*Math.sin(i*.77)));
    for(let i=0;i<1003;i++)pre.tick(raw.map(x=>x[i]),3000,0,1);
    const initial=pre.snapshot(),run=(x,derivatives)=>{
        const e=R.engine(cfg,pid,{capture:derivatives?n:0,derivatives:derivatives?C.recordDynamicJacobian:null,state:initial}),y=raw.map(()=>new Float64Array(n));
        for(let i=0;i<n;i++){e.tick(x.map(a=>a[i]),3000,0,1);for(let a=0;a<3;a++)y[a][i]=e.gyro[a];}return {y,e};
    };
    const base=run(raw,true),dx=Float64Array.from({length:n},(_,i)=>Math.sin(i*.017)+.3*Math.cos(i*.31)),dot=(x,y)=>x.reduce((s,v,i)=>s+v*y[i],0);
    for(let a=0;a<3;a++) {
        const L=C.linearizeDynamic(C,base.e.tape[a],raw[a],initial.stages[a],base.e.dynamic.derivative,a,6),j=L.forward(dx),g=Float64Array.from(dx,(_,i)=>Math.sin(i*.37));
        assert.ok(Math.abs(dot(j,g)-dot(dx,L.transpose(g)))<1e-8);
        const eps=1e-5,x=raw.slice();x[a]=Float64Array.from(raw[a],(v,i)=>v+eps*dx[i]);const f=run(x,false).y[a];
        let error=0,power=0;for(let i=0;i<n;i++){error+=((f[i]-base.y[a][i])/eps-j[i])**2;power+=j[i]**2;}
        assert.ok(Math.sqrt(error/power)<1e-4,'linearization matches finite differences of the complete adaptive algorithm');
    }
});
test('yaw P reconstructs the firmware asymmetric stop-gain response',()=>{
    const pid={known:true,Kp:.005,stopGain:[.8,1.2]};
    for(let e=-40;e<=40;e+=.125) {
        const p=pid.Kp*e*(.8+.4*Math.max(0,Math.min(1,(e+10)/20)));
        const observation=C.pObservation(pid,2,p,17);
        assert.ok(Math.abs(observation.value-(17-e))<1e-12);
        assert.ok(observation.weight>0&&observation.weight<=1);
    }
    assert.equal(C.pObservation({...pid,stopGain:[.25,2.5]},2,0,0),null,'ambiguous nonmonotone stop gains do not become an inverse observation');
    assert.equal(C.pObservation({known:true,Kp:.005},2,0,0),null);
});
test('unknown yaw profiles can identify P stop gains and use both P and D observations',()=>{
    const n=16000,rate=2000,gyro=Float64Array.from({length:2*n},(_,i)=>12*Math.sin(2*Math.PI*13*i/rate)+7*Math.sin(2*Math.PI*87*i/rate));
    const pg=C.filter(gyro,[FT.firstOrderLpf(100,rate)]),d=C.filter(pg,[FT.difSection(20,rate).map((v,i)=>i<3?-v*.00001:v)]);
    const sp=Float64Array.from({length:n},(_,i)=>30*Math.sin(2*Math.PI*.7*i/1000));
    const p=Float64Array.from(sp,(v,i)=>{const e=v-pg[2*i];return R.quantize(.005*e*(.8+.4*Math.max(0,Math.min(1,(e+10)/20)))*1000)/1000;});
    const down=x=>Float64Array.from({length:n},(_,i)=>R.quantize(x[2*i]*1000)/1000);
    const seg={cfg:{rates:{pidHz:rate,logHz:1000}},filt:[null,null,Float64Array.from({length:n},(_,i)=>R.quantize(gyro[2*i]))],
        w:{D:[null,null,down(d)],P:[null,null,p],sp:[null,null,Float64Array.from(sp,R.quantize)]}};
    const observer=C.pidObserver(seg,Array.from({length:6},(_,i)=>({st:2000+i*2000,lead:2000,N:1024})),2);
    assert.ok(observer&&observer.stopGain&&!observer.derivativeOnly);
    assert.ok(Math.abs(observer.gyro_cutoff-100)<=2);
    assert.ok(Math.abs(observer.Kp-.005)<.00005);
    assert.ok(Math.abs(observer.stopGain[0]-.8)<.02&&Math.abs(observer.stopGain[1]-1.2)<.02);
});
test('reconstruction blocks preserve committed samples and the adaptive-notch history of that same trajectory',t=>{
    const n=13000,nf=2,N=1024,lead=2000;
    const cfg=FT.config({looptime:500,pid_process_denom:2,filter_process_denom:2,frameIntervalPNum:1,frameIntervalPDenom:1,
        gyro_soft_type:1,gyro_lowpass_hz:100,gyro_soft2_type:0,gyro_lowpass2_hz:0,gyro_lowpass_dyn_hz:[0,0],gyro_notch_hz:[0,0],gyro_notch_cutoff:[0,0],features:1<<29,
        dyn_notch_count:2,dyn_notch_q:25,dyn_notch_min_hz:20,dyn_notch_max_hz:240,gyro_decimation_hz:0});
    const pid=Array(3).fill({gyro_cutoff:50,d_cutoff:15,Kp:.000333333,Kd:0,known:true}),E=R.engine(cfg,pid);
    const sensor=[0,1,2].map(a=>Float64Array.from({length:n*nf},(_,i)=>8*Math.sin(2*Math.PI*13*i/2000+a)+3*Math.sin(2*Math.PI*67*i/2000)+5*Math.sin(2*Math.PI*(150*i/2000+.7*(i/2000)**2))));
    const raw=sensor.map(x=>Float64Array.from({length:n},(_,i)=>R.quantize(x[i*nf+1]))),filt=raw.map(()=>new Float64Array(n)),P=raw.map(()=>new Float64Array(n));
    for(let i=0;i<n;i++){E.tick(sensor.map(x=>x[i*nf]),3000,0,1);for(let a=0;a<3;a++){filt[a][i]=R.quantize(E.gyro[a]);P[a][i]=R.quantize(-E.pidGyro[a]*pid[a].Kp*1000)/1000;}}
    const seg={n,cfg,raw,filt,hs:new Float64Array(n).fill(3000),observers:{1:pid},w:{P,D:raw.map(()=>new Float64Array(n)),sp:raw.map(()=>new Float64Array(n))}};
    const windows=Array.from({length:9},(_,i)=>({seg,st:lead+i*N,N,lead,profile:1}));
    C.reconstructWindows(seg,windows);
    const prev=windows[7].input,next=windows[8].input,offset=(next.start-prev.start)*nf;
    for(let a=0;a<3;a++)assert.deepEqual(next.native[a].subarray(0,lead*nf),prev.native[a].subarray(offset,offset+lead*nf),'the second block cannot refit its committed prefix');
    assert.equal(next.diagnostics.axes[0].regularization,.015,'weak quantized P without D must not receive the strong-observer regularization');
    const joined=C.join(seg,windows),check=R.engine(cfg,pid),byStart=new Map(windows.map(w=>[w.input.start,w.input]));
    const continuous=raw.map(()=>new Float64Array(joined.raw[0].length));
    for(let i=0;i<joined.raw[0].length;i++){
        const saved=byStart.get(i);
        if(saved)for(let k=0;k<saved.centers.length;k++)assert.ok(Math.abs(saved.centers[k]-check.dynamic.X.cen[k])<1e-8,'all preview windows start from the committed adaptive history');
        check.tick(joined.raw.map(x=>x[i]),3000,0,1);
        for(let a=0;a<3;a++)continuous[a][i]=check.gyro[a];
    }
    let historyError=0,historyCount=0;
    for(const w of windows){const out=R.run(cfg,seg,pid,w.input);for(let i=0;i<N;i++)for(let a=0;a<3;a++){historyError+=(out.y[a][lead+i]-continuous[a][w.st+i])**2;historyCount++;}}
    t.diagnostic('Window vs continuous replay RMS '+Math.sqrt(historyError/historyCount));
    assert.ok(Math.sqrt(historyError/historyCount)<1e-5,'window replay must retain the full filter and SDFT state of uninterrupted replay');
});
test('native firmware acquisition, decimation, scheduler and quantized observations constrain reconstruction and candidate replay', t => {
    const dir=fs.mkdtempSync(os.tmpdir()+'/rf-acquisition-');
    try {
        const exe=native.build(dir);
        for(const [rate,dyn] of [[2000,0],[4000,0],[4000,6]]) {
            const n=rate*(dyn?6:5), divider=rate/2000, hs=3000;
            const input=Array.from({length:n},(_,i)=>[0,1,2].map(a=>35*Math.sin(2*Math.PI*13*i/rate+a)+15*Math.sin(2*Math.PI*237*i/rate)+12*Math.sin(2*Math.PI*713*i/rate+a)+(dyn?4*Math.sin(2*Math.PI*67*i/rate):0)).concat(hs).join(' ')).join('\n')+'\n';
            const run=(hz,dec=500,logDivider=divider)=>cp.execFileSync(exe,[rate,2,logDivider,dyn,hz,dec].map(String),{input,maxBuffer:4e6}).toString().trim().split('\n').map(l=>l.split(' ').map(Number));
            const logged=run(100), truth=run(160), h={looptime:1e6/rate,pid_process_denom:2,filter_process_denom:2,frameIntervalPNum:1,frameIntervalPDenom:divider,
                gyro_soft_type:1,gyro_lowpass_hz:100,gyro_soft2_type:0,gyro_lowpass2_hz:50,gyro_lowpass_dyn_hz:[0,0],gyro_notch_hz:[0,0],gyro_notch_cutoff:[0,0],features:(1<<30)|(dyn?1<<29:0),
                gyro_rpm_notch_preset:1,gyro_rpm_notch_min_hz:20,gyro_decimation_hz:500};
            const cfg=FT.config(h,{gear:{main:[2,15],tail:[1,4],motorisedTail:false}}), pid=Array(3).fill({gyro_cutoff:80,d_cutoff:35,Kp:.005,Kd:.00005,known:true});
            const seg={n:logged.length,hs:new Float64Array(logged.length).fill(hs),raw:[0,1,2].map(a=>Float64Array.from(logged,l=>l[1+a*4])),filt:[0,1,2].map(a=>Float64Array.from(logged,l=>l[2+a*4]))};
            seg.w={P:[0,1,2].map(a=>Float64Array.from(logged,l=>Math.round(-l[3+a*4]*pid[a].Kp*1000)/1000)),D:[0,1,2].map(a=>Float64Array.from(logged,l=>Math.round(l[4+a*4]*pid[a].Kd*1000)/1000)),sp:Array.from({length:3},()=>new Float64Array(logged.length))};
            const inp=C.reconstruct(cfg,seg,0,seg.n,pid), old=R.input(cfg,seg), changed=FT.withSettings(cfg,{gyro_lpf1_static_hz:160});
            const base=R.run(cfg,seg,pid,inp), cand=R.run(changed,seg,pid,inp), naive=R.run(changed,seg,pid,old);
            let before=0,after=0,held=0,count=0,nh=0;
            for(let i=2000;i<seg.n;i++) for(let a=0;a<3;a++){
                before+=(naive.y[a][i]-truth[i][2+a*4])**2;after+=(cand.y[a][i]-truth[i][2+a*4])**2;count++;
                if(i%5===2){held+=(base.y[a][i]-seg.filt[a][i])**2;nh++;}
            }
            t.diagnostic(`${rate} Hz, ${dyn} dynamic notches: candidate RMS ${Math.sqrt(before/count).toFixed(4)} -> ${Math.sqrt(after/count).toFixed(4)} deg/s; withheld baseline RMS ${Math.sqrt(held/nh).toFixed(4)}`);
            assert.ok(after<before*.65,'candidate prediction improves with independently generated C measurements');
            assert.ok(Math.sqrt(held/nh)<(dyn?1.5:1.2),'withheld observations validate reconstruction');
            assert.equal(inp.native[0].length,n);
            const nativeTruth=divider===1?truth:run(160,500,1);
            assert.equal(cand.native.y[0].length,nativeTruth.length);
            let nativeBefore=0,nativeAfter=0,nativeCount=0;
            for(let i=rate;i<nativeTruth.length;i++)for(let a=0;a<3;a++) {
                nativeBefore+=(naive.native.y[a][i]-nativeTruth[i][2+a*4])**2;
                nativeAfter+=(cand.native.y[a][i]-nativeTruth[i][2+a*4])**2;
                nativeCount++;
            }
            t.diagnostic(`${rate} Hz, ${dyn} dynamic notches: every native filter tick RMS ${Math.sqrt(nativeBefore/nativeCount).toFixed(4)} -> ${Math.sqrt(nativeAfter/nativeCount).toFixed(4)} deg/s`);
            assert.ok(nativeAfter<nativeBefore*.65,'counterfactual replay improves on native ticks omitted from the recording too');
            t.diagnostic('Decimator closure: '+JSON.stringify(inp.diagnostics.decimationClosure));
            assert.ok(inp.diagnostics.decimationClosure.every(e=>e<(dyn?.2:.1)),'the inverse closes through the original Bessel decimator');
            if(dyn)continue;
            const decCfg=FT.withSettings(cfg,{gyro_decimation_hz:250}), decTruth=run(100,250), decOut=R.run(decCfg,seg,pid,C.candidateInput(decCfg,inp));
            let decError=0;
            for(let i=2000;i<seg.n;i++)for(let a=0;a<3;a++)decError+=(decOut.y[a][i]-decTruth[i][2+a*4])**2;
            t.diagnostic(`${rate} Hz: new decimator RMS ${Math.sqrt(decError/count).toFixed(4)} deg/s`);
            assert.ok(Math.sqrt(decError/count)<0.65,'candidate decimation is evaluated on the recovered sensor input');
            const decNativeTruth=divider===1?decTruth:run(100,250,1);
            let nativeDecError=0;
            for(let i=rate;i<decNativeTruth.length;i++)for(let a=0;a<3;a++)nativeDecError+=(decOut.native.y[a][i]-decNativeTruth[i][2+a*4])**2;
            t.diagnostic(`${rate} Hz: new decimator, every native filter tick RMS ${Math.sqrt(nativeDecError/nativeCount).toFixed(4)} deg/s`);
            assert.ok(Math.sqrt(nativeDecError/nativeCount)<0.65,'changed decimation agrees with C at every native filter tick');
        }
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
