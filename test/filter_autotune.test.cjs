'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const FT = require('../tools/autotune/filter_tune.cjs'), A = require('../tools/autotune/filter_autotune.cjs'), R = require('../tools/autotune/filter_replay.cjs');
const gear = {main:[1,1],tail:[1,4],motorisedTail:false};
function fixture(log=0, cutoff=100) {
    const n=96000, h={looptime:1000,pid_process_denom:1,filter_process_denom:1,frameIntervalPNum:1,frameIntervalPDenom:1,
        features:0,gyro_soft_type:1,gyro_lowpass_hz:cutoff,gyro_soft2_type:0,gyro_lowpass2_hz:50,gyro_lowpass_dyn_hz:[0,0],gyro_notch_hz:[0,0],gyro_notch_cutoff:[0,0],
        dyn_notch_count:2,dyn_notch_q:50,dyn_notch_min_hz:80,dyn_notch_max_hz:350,gyro_rpm_notch_preset:1,gyro_rpm_notch_min_hz:20,
        rollBW:[cutoff,35],pitchBW:[cutoff,35],yawBW:[cutoff,35],rollPID:[50,100,15],pitchPID:[50,100,15],yawPID:[50,100,15]};
    for(const ax of ['roll','pitch','yaw']) for(const k of ['source','q','center']) h[`gyro_rpm_notch_${k}_${ax}`]=Array(16).fill(0);
    const raw=[0,1,2].map(a=>Float64Array.from({length:n},(_,i)=>10*Math.sin(2*Math.PI*13*i/1000+a)+8*Math.sin(2*Math.PI*187*i/1000+a)));
    const seg={n,raw,hs:new Float64Array(n).fill(3000)}, cfg=FT.config(h,{gear}), pid=Array(3).fill({gyro_cutoff:cutoff,d_cutoff:35,Kp:1,Kd:1});
    const filtered=R.run(cfg,seg,pid).y;
    return {w:{...seg,rate:1000,profileAt:new Uint8Array(n).fill(2),gyro:filtered,extra:Object.fromEntries(raw.map((x,a)=>[`gyroRAW[${a}]`,x])),
        flight:{file:'fixture',log,firmware:'Rotorflight 4.6.0 (118e912)',craft:'fixture',header:h,actualRate:1000}},mask:new Uint8Array(n).fill(1),flight:true,armingProfile:2};
}
test('training/holdout uses whole blocks; gaps and profile transitions remove warmup windows',()=>{
    const it=fixture(), P=A.prepare([it],{gear});
    assert.ok(P.windows.some(w=>w.held));
    const held=new Set(P.windows.filter(w=>w.held).map(w=>w.unit));
    assert.ok(P.windows.filter(w=>!w.held).every(w=>!held.has(w.unit)));
    it.w.profileAt.fill(3,45000);
    it.w.extra.time=Float64Array.from({length:it.w.n},(_,i)=>i*1000+(i>=20000?100000:0));
    const Q=A.prepare([it],{gear});
    assert.ok(Q.windows.every(w=>!(w.st-w.lead<20000&&w.st+w.N>20000)));
    assert.ok(Q.windows.every(w=>!(w.st-w.lead<45000&&w.st+w.N>45000)));
});
test('missing raw samples, unknown RPM sources and unrecorded dynamic LPF inputs cannot become a recommendation',()=>{
    const raw=fixture(); delete raw.w.extra['gyroRAW[1]'];
    assert.equal(A.tune([raw],{gear}).recommended.status,'no flight log');
    const dyn=fixture(); dyn.w.flight.header.gyro_lowpass_dyn_hz=[60,200];
    assert.match(A.prepare([dyn],{gear}).excluded[0].reason,/headspeed ratio/);
    const rpm=fixture(); rpm.w.flight.header.features=1<<30;
    const ex=A.prepare([rpm],{logGear:false}).excluded[0];
    assert.match(ex.reason,/RPM notch/);
    // no CLI dump: the result names the values that a CLI dump gives and asks for it (user 2026-10-15); with a CLI dump, no call
    assert.deepEqual(ex.cliValues,['tail_rotor_gear_ratio']);
    const needs=A.tune([rpm],{logGear:false}).cliNeeded;
    assert.equal(needs.text,'The log does not record `tail_rotor_gear_ratio`. To calculate the filter values, load a CLI dump of this helicopter.');
    assert.equal(A.tune([rpm],{logGear:false}).recommended.reasons[0],'The log does not record all the values that are necessary for the filter replay.');
    assert.equal(A.prepare([rpm],{logGear:false,cli:'# diff all\nset tail_rotor_gear_ratio = 1,4\n'}).excluded.length,0,'the CLI dump gives the tail notch frequency');
    // 4.7.0 has the gyro filter code of 4.6.0; a later version is not known
    const fw=fixture(); fw.w.flight.firmware='Rotorflight 4.7.0-bbp-pr (85d7049a9) STM32G47X';
    assert.equal(A.prepare([fw],{gear}).segments[0].unsupported,false);
    fw.w.flight.firmware='Rotorflight 4.8.0';
    assert.equal(A.prepare([fw],{gear}).segments[0].unsupported,true);
});
test('the same complete target is replayed across logs with different original LPF and PID cutoffs',()=>{
    const P=A.prepare([fixture(0,80),fixture(1,130)],{gear});
    const wins=P.segments.map(s=>P.windows.find(w=>w.seg===s));
    const recorded=A.evaluate(P,A.manualChanges(P,{}),wins,true);
    assert.notDeepEqual(recorded.results[0].trace.y,recorded.results[1].trace.y,'recorded replay retains each interval\'s different filter values');
    const original=FT.chainResponse; FT.chainResponse=()=>{throw Error('frequency-domain scoring is forbidden');};
    try {
        const ev=A.evaluate(P,{dyn_notch_q:60},wins,true);
        assert.deepEqual(ev.results[0].trace.y,ev.results[1].trace.y);
        assert.deepEqual(ev.results[0].trace.out,ev.results[1].trace.out);
    } finally {FT.chainResponse=original;}
    const rows=A.rowsFor(P,{dyn_notch_q:60},true);
    assert.equal(rows.find(r=>r.name==='roll_gyro_cutoff').to,130);
    assert.equal(rows.find(r=>r.name==='gyro_lpf1_static_hz').to,130);
});
test('proposal coverage includes every LPF type, feature removal, dynamic LPF and PID cutoff choices',()=>{
    const it=fixture(); it.fullHeadSpeedRatio=new Float64Array(it.w.n).fill(1);
    const P=A.prepare([it],{gear}); P.trainingBase=A.evaluate(P,{},P.windows.slice(0,2));
    const C=A.candidates(P);
    for(const slot of [1,2]) assert.equal(new Set(C.map(c=>c.changes[`gyro_lpf${slot}_type`]).filter(x=>x!==undefined)).size,10);
    assert.ok(C.some(c=>c.changes.RPM_FILTER===false)); assert.ok(C.some(c=>c.changes.DYN_NOTCH===false));
    for(const family of ['RPM banks','RPM centers','static notch','dynamic design','combined','dynamic lowpass','PID cutoffs']) assert.ok(C.some(c=>c.family===family),family);
    assert.ok(C.some(c=>c.changes['p2:roll_d_cutoff']===10));
    assert.ok(C.some(c=>c.changes['p2:roll_gyro_cutoff']===0));
    assert.deepEqual(A.invalid(P,{'p2:roll_gyro_cutoff':0}),[]);
    assert.ok(A.invalid(P,{'p2:roll_d_cutoff':0}).length);
});
test('NOMAD domains keep topology fixed, use integer firmware units and retain static-notch ordering',()=>{
    const O=require('../tools/autotune/filter_optimizer.cjs'),P=A.prepare([fixture()],{gear});
    const seed={gyro_notch1_hz:187,gyro_notch1_cutoff:160},d=O.domain(P,seed);
    assert.ok(d.variables.some(v=>v.name==='p2:roll_gyro_cutoff'));
    assert.ok(d.frame.every(Number.isInteger));assert.ok(d.admissible(d.initial));
    const broken=d.initial.slice();broken[d.variables.findIndex(v=>v.name==='gyro_notch1_cutoff')]=200;
    assert.equal(d.admissible(broken),false);
    const before=JSON.stringify(seed),changed=d.initial.slice();changed[0]++;
    assert.equal(O.topology(P,d.decode(changed)),O.topology(P,d.decode(d.initial)));
    assert.equal(JSON.stringify(seed),before,'candidate decoding must not mutate its seed');
    assert.notEqual(O.topology(P,{}),O.topology(P,{'p2:roll_gyro_cutoff':0}),'PID gyro bypass changes topology');
    const off=O.domain(P,{'p2:roll_gyro_cutoff':0});
    assert.ok(!off.variables.some(v=>v.name==='p2:roll_gyro_cutoff'));
});
test('complete CLI keeps all RPM arrays, restores the selected profile, rejects unknown names/ranges and escapes metadata',()=>{
    const P=A.prepare([fixture()],{gear}), B=FT.effectiveBanks(P.ref.s), changes={gyro_rpm_notch_preset:0};
    ['roll','pitch','yaw'].forEach((ax,a)=>['source','q','center'].forEach(k=>{changes[`gyro_rpm_notch_${k}_${ax}`]=Array.from({length:16},(_,i)=>B[a][i]?B[a][i][k]:0);}));
    const rows=A.rowsFor(P,changes,true), res={model:{passed:true},recommended:{status:'recommended',fullRows:rows,predicted:{totalDb:-5}},bootProfile:2};
    assert.ok(rows.every(A.validCliRow));
    rows[0].stale={text:'The values can be different after a later arm.'};
    const cli=A.cliFile(res,{craft:'test\nset motor_pwm_rate = 1',date:'test'});
    assert.equal(cli.split('\n').filter(l=>/^set gyro_rpm_notch_(source|q|center)_/.test(l)).length,9);
    assert.match(cli,/profile 1\nsave\n$/); assert.match(cli,/# Values possibly not current: The values can be different after a later arm\.\nset gyro_lpf1_type/); assert.ok(!cli.split('\n').includes('set motor_pwm_rate = 1'));
    rows[0].stale.text='This recommendation uses a part of the log in which the values are possibly not the values of the log header. The cause is a second arm in the same log. The app uses the values of the log header because the log does not record the new values.';
    const wrapped=A.cliFile(res,{craft:'x'.repeat(220)+'\nsave',date:'test'});
    assert.ok(wrapped.split('\n').filter(l=>l.startsWith('#')).every(l=>l.length<=192));
    assert.ok(wrapped.split('\n').filter(l=>l.startsWith('#')).map(l=>l.slice(2)).join(' ').includes(rows[0].stale.text));
    assert.equal(wrapped.split('\n').filter(l=>l==='save').length,1);
    res.mode='simulation';res.limits={maxAddMs:2};res.configuration={id:'B'};
    const manual=A.cliFile(res);
    assert.match(manual,/# Recorded configurations: B/);assert.match(manual,/# Maximum added time delay: 2 ms/);
    assert.doesNotMatch(manual,/Rule:.*noise reduction/);
    res.selection={text:'Flight data: log 3, flight 2.'};
    res.recordedConfigurations=[{id:'A',log:2,profile:2,t0:10,t1:15},{id:null,log:2,profile:0,t0:15,t1:20},{id:'B',log:2,profile:2,t0:20,t1:30}];
    const flightCli=A.cliFile(res);
    assert.match(flightCli,/# Flight data: log 3, flight 2\./);
    assert.match(flightCli,/# Recorded configurations: A, unknown, B/);
    assert.match(flightCli,/# Log 3, 15\.00 to 20\.00 s: configuration unknown, PID profile unknown\./);
    assert.match(flightCli,/# Log 3, 20\.00 to 30\.00 s: configuration B, PID profile 2\./);
    assert.equal(A.cliFile(res,{recommendations:[{blockedBy:['RPM input']}] }), '');
    res.bootProfile=null; assert.equal(A.cliFile(res),''); res.bootProfile=2;
    rows.push({name:'save\nset foo',to:1,source:'header',scope:'global'}); assert.equal(A.cliFile(res),'');
    assert.equal(A.validCliRow({name:'dyn_notch_q',to:101}),false);
    assert.equal(A.validCliRow({name:'gyro_rpm_notch_source_yaw',to:Array(16).fill(19).join(',')}),false);
});
test('recorded baseline replay cannot export a single reference configuration as its target',()=>{
    const rows=[{name:'gyro_lpf1_static_hz',from:140,to:140,scope:'global',source:'header'}];
    const res={mode:'simulation',model:{passed:true},recommended:{status:'recommended',params:{},rows:[],fullRows:rows,predicted:{totalDb:0}}};
    assert.equal(A.cliFile(res),'','empty params replays each interval independently; the reference is not a tested common target');
    assert.deepEqual(A.cliExportStatus(res),{available:false,reasons:['Recorded filter replay. No filter values changed.']});
    res.recommended.params={gyro_lpf1_static_hz:140};
    assert.match(A.cliFile(res),/set gyro_lpf1_static_hz = 140/,'an explicit common target can match the newest reference while changing older intervals');
    assert.deepEqual(A.cliExportStatus(res),{available:true,reasons:[]});
});
test('accepted filter replay reports the prerequisite that refuses CLI export without discarding its measured improvement',()=>{
    const advice=require('../tools/autotune/advice.cjs'),block='The prerequisite "RPM signal and motor poles" has a problem.';
    const row={name:'dyn_notch_count',from:6,to:2,scope:'global',source:'header'};
    const res={version:2,mode:'autotune',model:{passed:true},recommended:{status:'recommended',params:{dyn_notch_count:2},
        reasons:[],rows:[row],fullRows:[row],predicted:{totalDb:-10.266,se:1.12},delay:{maxAddMs:.3484}}};
    res.recommendations=advice.filterRecommendations(res,{blockedBy:[block],texts:A.texts(res)});
    assert.ok(res.recommendations.every(r=>r.severity==='action'&&!r.cli.length));
    assert.deepEqual(A.cliExportStatus(res),{available:false,reasons:['CLI export must wait for the filter prerequisite checks. Examine the prerequisite checks.',block]});
    assert.equal(A.cliFile(res),'');
    assert.equal(res.recommended.status,'recommended');
    assert.deepEqual(res.recommended.predicted,{totalDb:-10.266,se:1.12});
    // A top-level worker gate remains authoritative if recommendation data is unavailable.
    res.blockedBy=[block];res.recommendations=[];
    assert.deepEqual(A.cliExportStatus(res).reasons,['CLI export must wait for the filter prerequisite checks. Examine the prerequisite checks.',block]);
    assert.equal(A.cliFile(res),'');
    delete res.blockedBy;
    res.recommendations=[{causes:[{holds:true,text:'Examine the RPM signal before filter changes.'}]}];
    assert.match(A.cliExportStatus(res).reasons.join(' '),/RPM signal/);
    assert.equal(A.cliFile(res),'');
    res.recommendations=advice.filterRecommendations(res,{texts:A.texts(res)});
    assert.deepEqual(A.cliExportStatus(res),{available:true,reasons:[]});
    assert.match(A.cliFile(res),/^set dyn_notch_count = 2$/m);
});
test('each filter export refusal identifies the exact guard while valid complete values remain exportable',()=>{
    const row={name:'gyro_lpf1_static_hz',from:100,to:140,scope:'global',source:'header'};
    const result=()=>({model:{passed:true},recommended:{status:'recommended',fullRows:[{...row}],predicted:{totalDb:-5}}});
    const cases=[
        [r=>{r.model.passed=false;r.recommended.reasons=['The selected flight periods have no complete replay.'];},/no complete replay/],
        [r=>{delete r.model;},/no recommended configuration.*Start autotune/],
        [r=>{r.recommended.status='not recommended';},/no recommended configuration/],
        [r=>{r.recommended.fullRows=[];},/no parameter values/],
        [r=>{r.recommended.fullRows=[null];},/empty parameter row/],
        [r=>{r.recommended.fullRows[0].source='default';},/recorded value.*gyro_lpf1_static_hz.*unknown/],
        [r=>{r.recommended.fullRows[0].from=null;},/recorded value.*unknown/],
        [r=>{r.recommended.fullRows[0].from=-1;},/recorded value.*not correct/],
        [r=>{r.recommended.fullRows[0].to=1001;},/new value.*firmware CLI range/],
        [r=>{r.recommended.fullRows[0].scope='profile';},/scope.*firmware scope/],
        [r=>{r.recommended.fullRows=[{...row,name:'roll_gyro_cutoff',scope:'profile',profile:0}];},/PID profile.*unknown/],
        [r=>{r.recommended.fullRows=[{...row,name:'roll_gyro_cutoff',scope:'profile',profile:2}];},/profile to set again.*unknown/],
        [r=>{r.recommended.fullRows.push({...row,to:150});},/different values.*same scope/],
        [r=>{r.recommended.fullRows.push({...row,from:80});},/different values.*same scope/]
    ];
    for(const [change,reason] of cases){const r=result();change(r);const status=A.cliExportStatus(r);assert.equal(status.available,false);assert.match(status.reasons.join(' '),reason);assert.equal(A.cliFile(r),'');}
    assert.equal(A.cliExportStatus(null).available,false);
    const r=result();assert.deepEqual(A.cliExportStatus(r),{available:true,reasons:[]});assert.ok(A.cliFile(r));
    r.recommended.fullRows=[{...row,name:'roll_gyro_cutoff',scope:'profile',profile:2}];
    assert.equal(A.cliExportStatus(r,{bootProfile:1}).available,true);
    assert.match(A.cliFile(r,{bootProfile:1}),/profile 0\nsave\n$/);
});
test('recorded replay text distinguishes the baseline, manual changes and failed coverage',()=>{
    const res={mode:'simulation',model:{passed:true},recommended:{status:'recommended',params:{},rows:[],reasons:[],
        validation:{holdout:{blocks:2}},predicted:{totalDb:0}}};
    let text=A.texts(res);
    assert.match(text.recommendation,/Recorded filter replay\. No filter values changed/);
    assert.match(text.validation,/selected flight periods with their recorded values/);
    assert.doesNotMatch(text.recommendation+text.validation,/changed values are in|before export|after manual changes/);
    res.recommended.params={gyro_lpf1_static_hz:140};text=A.texts(res);
    assert.match(text.recommendation,/changed values are in/);
    assert.match(text.validation,/do not give a different test after changes that you enter/);
    res.recommended.params={};res.recommended.status='not recommended';res.model.passed=false;
    res.recommended.reasons=['Some selected flight periods have no complete replay.'];
    assert.equal(A.texts(res).recommendation,res.recommended.reasons[0],'failed baseline retains the failure reason');
});
test('a delay increase in one profile is not concealed by another profile',()=>{
    function entry(id,profile,delay,power){
        const N=1024, rate=1000, K=N/2+1;
        const S={raw:new Float64Array(K).fill(power),y:new Float64Array(K).fill(power),re:new Float64Array(K),im:new Float64Array(K),Y:{re:new Float64Array(K),im:new Float64Array(K)}};
        for(let k=0;k<K;k++){const ph=-2*Math.PI*k*rate/N*delay;S.re[k]=power*Math.cos(ph);S.im[k]=power*Math.sin(ph);S.Y.re[k]=Math.sqrt(power)*Math.cos(ph);S.Y.im[k]=Math.sqrt(power)*Math.sin(ph);}
        const w={id,profile,unit:String(profile),rate,N,seg:{firstProfile:0,cfg:{pid:{cli:{},header:Object.fromEntries(['roll','pitch','yaw'].map(ax=>[ax,{gyro_cutoff:80,d_cutoff:35,P:50,D:15}]))}}}};
        return {w,m:Array.from({length:3},()=>({power:1,pidPower:1,S,PS:S,DS:S}))};
    }
    const base={results:[entry(0,1,0,100),entry(1,2,0,1)]}, cand={results:[entry(0,1,0,100),entry(1,2,.002,1)]};
    const c=A.compare(cand,base); assert.equal(c.valid,false); assert.equal(c.delay.at.profile,2); assert.ok(c.delay.maxAddMs>1.9);
});

// Synthetic windows for compare(): input X (real, amplitude amp), baseline output Yb = X, candidate output Yc = g X exp(-i 2 pi f d(f))
// plus contamination of relative size noise (a part that is not a linear function of Yb). d: ms, or a function of the frequency (Hz)
function delayWindow(id,{d=0,amp=1,noise=0,g=1,profile=1},cand){
    const N=1024,rate=1000,K=N/2+1;let q=(id+1)*2654435761>>>0;const rnd=()=>((q=(q*1664525+1013904223)>>>0)/4294967296)*2-1;
    const S={raw:new Float64Array(K),y:new Float64Array(K),re:new Float64Array(K),im:new Float64Array(K),Y:{re:new Float64Array(K),im:new Float64Array(K)}};
    for(let k=0;k<K;k++){const f=k*rate/N,ms=typeof d==='function'?d(f):d,ph=cand?-2*Math.PI*f*ms/1000:0,n=cand?(typeof noise==='function'?noise(f):noise):0;
        const yr=(cand?g:1)*amp*Math.cos(ph)+n*amp*rnd(),yi=(cand?g:1)*amp*Math.sin(ph)+n*amp*rnd();
        S.raw[k]=amp*amp;S.y[k]=yr*yr+yi*yi;S.re[k]=amp*yr;S.im[k]=amp*yi;S.Y.re[k]=yr;S.Y.im[k]=yi;}
    const w={id,profile,unit:'u'+(id>>2),rate,N,seg:{firstProfile:0,cfg:{pid:{cli:{},header:Object.fromEntries(['roll','pitch','yaw'].map(ax=>[ax,{gyro_cutoff:80,d_cutoff:35,P:50,D:15}]))}}}};
    return {w,m:Array.from({length:3},()=>({power:1,pidPower:1,S,PS:S,DS:S}))};
}
const delayRun=(wins,limit=.5)=>A.compare({results:wins.map((o,i)=>delayWindow(i,o,true))},{results:wins.map((o,i)=>delayWindow(i,o,false))},{maxAddMs:limit});
test('time delay rule: the mean of the windows, each window the same; no allowance for the spread between windows',()=>{
    // a fixed change: every window gives the same delay, the mean decides
    const fixed=delayRun(Array(6).fill({d:.6}));
    assert.equal(fixed.valid,false);assert.ok(Math.abs(fixed.delay.maxAddMs-.6)<.03&&fixed.constraints[0]>.07,JSON.stringify(fixed.delay));
    assert.deepEqual([fixed.delay.at.windows,fixed.delay.at.rangeMs[0]===fixed.delay.at.rangeMs[1]],[6,true]);
    assert.match(A.limitTexts({...fixed,db:-5},{maxAddMs:.5})[0],/^The set with the lowest vibration \(-5 dB\) adds 0\.6\d* ms of filter time delay at \d+ Hz \(roll, (gyro|P-term|D-term), PID profile 1\)\. It is the mean of 6 periods of 1 s, from 0\.6\d* to 0\.6\d* ms\. The limit is 0\.5 ms\.$/);
    assert.equal(delayRun(Array(6).fill({d:.45})).valid,true);
    // one window with most of the band power does not decide (Fireball 2026-10-05, roll, PID profile 1, 30 Hz): 0.57 ms in the strong
    // window and 0.33 to 0.47 ms in eight weak windows. The mean of the windows is 0.43 ms; a power-weighted mean would be 0.53 ms
    const strong=delayRun([{d:.57,amp:1}].concat([.38,.34,.39,.33,.47,.46,.47,.42].map(d=>({d,amp:.2}))));
    assert.equal(strong.valid,true,JSON.stringify(strong.delay));assert.ok(Math.abs(strong.delay.maxAddMs-.443)<.03,JSON.stringify(strong.delay));
    // a real excess in some windows is not forgiven (2 of 10 windows at 2 ms: mean 0.64 ms)
    assert.equal(delayRun(Array(8).fill({d:.3}).concat([{d:2},{d:2}])).valid,false);
    // monotone: a larger delay in one window, strong or weak, never turns a rejected set into a valid one
    for(const amp of [1,.3,.05])for(const x of [.6,1,2.6,5,10]){const c=delayRun(Array(9).fill({d:.55}).concat([{d:x,amp}]));assert.equal(c.valid,false,`one window (amp ${amp}) at ${x} ms`);}
    let last=-Infinity;for(const x of [0,.5,1,2,4,8]){const c=delayRun([{d:.66},{d:.66},{d:x,amp:.3}]);assert.ok(c.delay.maxAddMs>=last-1e-9,`${x} ms`);last=c.delay.maxAddMs;}
    // contamination does not give an allowance
    assert.equal(delayRun(Array(6).fill({d:.6,noise:.4})).valid,false);
    // gain loss: the mean of the windows (a fixed gain of 0.8 decreases the signal by 1.94 dB)
    const loss=delayRun(Array(6).fill({d:0,g:.8}));
    assert.equal(loss.valid,false);assert.ok(Math.abs(loss.delay.maxLossDb-1.938)<.01&&loss.constraints[1]>1.4&&loss.delay.lossAt.windows===6,JSON.stringify(loss.delay));
    assert.match(A.limitTexts({...loss,db:-5},{maxAddMs:.5}).join(' '),/decreases the (gyro|P-term|D-term) signal by 1\.94 dB at \d+ Hz \(roll, (gyro|P-term|D-term), PID profile 1\)\. It is the mean of 6 periods of 1 s, from 1\.938 to 1\.938 dB\. The limit is 0\.5 dB\./);
    assert.equal(delayRun(Array(6).fill({d:0,g:.97})).valid,true,'0.26 dB');
    assert.equal(delayRun([{d:0,g:.9},{d:0,g:.9},{d:0,g:.2,amp:.3}]).valid,false,'a weak window with a larger gain loss increases the mean');
    // the delay text names the band with the largest delay and its windows
    assert.match(A.texts({recommended:{status:'not recommended',reasons:[],delay:strong.delay,rows:[]},model:{passed:true},limits:{maxAddMs:.5}}).delay,
        /^The largest increase in filter time delay is 0\.4\d+ ms at \d+ Hz \(roll, (gyro|P-term|D-term), PID profile 1\)\. It is the mean of 9 periods of 1 s, from 0\.3\d* to 0\.5\d* ms\. The limit is 0\.5 ms\.$/);
});
test('baseline delay compares recorded and replayed outputs directly, including a rejected phase error',()=>{
    const it=fixture(); it.w.flight.header.gyro_soft_type=0;
    it.w.gyro=[0,1,2].map(a=>Float64Array.from({length:it.w.n},(_,i)=>10*Math.sin(2*Math.PI*17*i/1000+a)));
    // The baseline comparison must not require gyroRAW to be a coherent
    // excitation. Adaptive filtering can destroy that relationship.
    for(let a=0;a<3;a++)it.w.extra[`gyroRAW[${a}]`]=Float64Array.from({length:it.w.n},(_,i)=>20*Math.sin(2*Math.PI*71*i/1000+a));
    const P=A.prepare([it],{gear}),wins=P.windows.slice(0,6);
    const replayWithDelay=delay=>{
        for(const w of wins) w.input={start:w.st-w.lead,end:w.st+w.N,factor:1,raw:[0,1,2].map(a=>Float64Array.from({length:w.lead+w.N},(_,i)=>10*Math.sin(2*Math.PI*17*(w.st-w.lead+i-delay)/1000+a)))};
        return A.parity(A.evaluate(P,{},wins),P)[0];
    };
    const same=replayWithDelay(0);assert.equal(same.passed,true,JSON.stringify(same));
    const shifted=replayWithDelay(1);assert.equal(shifted.passed,false);
    assert.ok(shifted.axes.roll.delayErrorMs>.8);
});

test('a partial CLI profile is not a known PID path; the first profile uses header provenance',()=>{
    const it=fixture();it.w.profileAt.fill(3,45000);
    const P=A.prepare([it],{gear,cli:'profile 1\nset roll_p_gain = 90\nprofile 2\nset roll_d_cutoff = 20\n'});
    const w=P.windows.find(w=>w.profile===3);assert.ok(A.paths(w,{}).every(p=>!p.known));
    assert.equal(Object.keys(P.targetProfiles).filter(k=>k.startsWith('p3:')).length,0);
    assert.ok(A.rowsFor(P,{},true).filter(r=>r.scope==='profile').every(r=>r.profile===2&&r.source==='header'));
});

test('replay acceptance survives advice serialization and export for a cutoff below legacy heuristic floors',()=>{
    const advice=require('../tools/autotune/advice.cjs');
    const res={version:2,model:{passed:true},current:{settings:{gyro_lpf1_type:1,gyro_lpf1_static_hz:100}},recommended:{status:'recommended',
        rows:[{name:'gyro_lpf1_static_hz',from:100,to:40,scope:'global',source:'header'}]}};
    const recs=advice.filterRecommendations(res);
    assert.equal(recs[0].severity,'action');assert.equal(recs[0].replayValidated,true);
    assert.match(advice.exportScript(recs,null,{}),/set gyro_lpf1_static_hz = 40/);
    res.version=1;assert.equal(advice.filterRecommendations(res)[0].severity,'check');
});

test('upstream reconstruction exposes decimation and known motor RPM cutoffs to search and CLI export',()=>{
    const it=fixture();it.w.flight.header.gyro_decimation_hz=250;
    const P=A.prepare([it],{gear,cli:'set motor_rpm_lpf = 100,100,100,100\nset gov_mode = DIRECT\n'});
    P.trainingBase=A.evaluate(P,{},P.windows.slice(0,1));
    assert.ok(P.windows[0].input.sensor);
    const proposals=A.candidates(P);
    assert.ok(proposals.some(p=>p.family==='gyro decimation'&&p.changes.gyro_decimation_hz===250));
    assert.ok(proposals.some(p=>p.family==='motor RPM lowpass'&&p.changes.motor_rpm_lpf[0]===50));
    const rows=A.rowsFor(P,{gyro_decimation_hz:250,motor_rpm_lpf:[50,100,100,100]},true);
    const res={version:2,model:{passed:true},current:{settings:P.ref.s},recommended:{status:'recommended',fullRows:rows,rows:rows.filter(r=>r.name==='gyro_decimation_hz'||r.name==='motor_rpm_lpf'),predicted:{totalDb:-4}},bootProfile:2};
    assert.match(A.cliFile(res),/set gyro_decimation_hz = 250/);
    assert.match(A.cliFile(res),/set motor_rpm_lpf = 50,100,100,100/);
    const advice=require('../tools/autotune/advice.cjs'),recs=advice.filterRecommendations(res);
    assert.ok(recs.every(r=>r.severity==='action'));
    assert.match(advice.exportScript(recs,null,{}),/set motor_rpm_lpf = 50,100,100,100/);
});

test('native-rate scoring detects vibration that cancels when sampled at the Blackbox rate',()=>{
    const it=fixture(),h=it.w.flight.header;h.looptime=250;h.pid_process_denom=2;h.filter_process_denom=2;h.frameIntervalPDenom=2;h.gyro_soft_type=0;
    const P=A.prepare([it],{gear}),w=P.windows[0],n=(w.lead+w.N)*2;
    const raw=Float64Array.from({length:n},(_,k)=>10*(Math.sin(2*Math.PI*300*k/2000)+Math.sin(2*Math.PI*700*k/2000)));
    w.input={start:w.st-w.lead,end:w.st+w.N,factor:2,offset:.25,raw:[raw,raw,raw]};
    const m=A.evaluate(P,{},[w]).results[0].m[0];
    assert.ok(m.S.y.reduce((s,v)=>s+v,0)<1e-12,'the 1 kHz observations hide both tones');
    assert.ok(m.power>90,'the native 2 kHz replay exposes the vibration power');
});

test('decimation proposals retain the value that firmware will use after boot',()=>{
    for(const rate of [1000,2000,4000]) {
        const it=fixture();it.w.flight.header.looptime=1e6/rate;
        const P=A.prepare([it],{gear}),limit=Math.min(1000,Math.round(.3*rate));
        for(const hz of [0,100,limit])assert.deepEqual(A.invalid(P,{gyro_decimation_hz:hz}),[]);
        for(const hz of [99,limit+1])assert.ok(A.invalid(P,{gyro_decimation_hz:hz}).length);
    }
});

test('manual parameter schema rejects illegal settings and preserves a complete target',()=>{
    const P=A.prepare([fixture()],{gear}),table=A.parameterTable(P);
    assert.equal(A.delayLimit(),.5);assert.equal(A.delayLimit(0),0);assert.equal(A.delayLimit(2),2);
    for(const v of [-1,21,NaN,Infinity,'2'])assert.throws(()=>A.delayLimit(v),/delay/);
    assert.equal(table.find(r=>r.key==='gyro_lpf1_type').choices.length,10);
    assert.deepEqual(A.manualChanges(P,{}),{},'recorded replay does not flatten intervals into the last configuration');
    const edited=A.manualChanges(P,{gyro_lpf1_type:'BESSEL','p2:roll_d_cutoff':'20',RPM_FILTER:'false'});
    assert.equal(edited.gyro_lpf1_type,8);assert.equal(edited['p2:roll_d_cutoff'],20);assert.equal(edited.RPM_FILTER,false);assert.equal(edited.dyn_notch_q,P.ref.s.dyn_notch_q);
    for(const value of [{unknown_parameter:3},{gyro_lpf1_type:'UNKNOWN'},{dyn_notch_q:101},{gyro_lpf1_static_hz:''},{gyro_rpm_notch_source_roll:'1,2'},{'p2:roll_d_cutoff':0},{filter_process_denom:2}])assert.throws(()=>A.manualChanges(P,value));
});

test('before/after checklist preserves measurements, reports LPF guidance, and retains unavailable mixer checks',()=>{
    const check=require('../tools/autotune/filter_checklist.cjs'),setup=require('../tools/autotune/health_setup.cjs'),loop=require('../tools/autotune/health_loop.cjs');
    const it=fixture(),w=it.w,n=w.n;
    w.airborneAt=new Uint8Array(n).fill(1);w.govStateAt=new Uint8Array(n).fill(4);w.rescueAt=new Uint8Array(n);
    w.u=Array.from({length:3},()=>new Float64Array(n));w.sp=w.u;w.coll=new Float64Array(n);
    w.P=w.u;w.I=w.u;w.F=w.u;w.B=w.u;
    w.flight.header.gyro_soft_type=0;w.flight.header.features=1<<30;w.flight.header.gyro_rpm_notch_preset=0;
    w.gyro=[0,1,2].map(a=>w.extra['gyroRAW['+a+']']);
    const cfg=FT.config(w.flight.header,{gear}),raw=w.gyro,seg={n,raw,hs:w.hs};
    const pid=['roll','pitch','yaw'].map(ax=>({known:true,gyro_cutoff:100,d_cutoff:35,Kp:50*require('../tools/autotune/lib.cjs').SCALE.P[0],Kd:15*require('../tools/autotune/lib.cjs').SCALE.D[0]}));
    w.D=R.run(cfg,seg,pid).d;
    const P=A.prepare([it],{gear});
    // With native-rate logged samples, use the recorded input directly. This
    // fixture has no lost samples and does not test the inverse solver again.
    for(const q of P.windows)q.input={start:q.st-q.lead,end:q.st+q.N,factor:1,native:raw.map(x=>x.slice(q.st-q.lead,q.st+q.N)),raw:raw.map(x=>x.slice(q.st-q.lead,q.st+q.N))};
    const out=check.compare(P,{gyro_lpf1_type:1,gyro_lpf1_static_hz:100});
    assert.equal(out.sameRules,true);
    assert.ok(out.rows.some(q=>q.id==='F1'&&q.before.status==='Information'&&q.after.status==='Information'&&q.outcome==='Unchanged'));
    assert.equal(out.rows.find(q=>q.id==='F1').before.findings[0].value,0);
    assert.equal(out.rows.find(q=>q.id==='F1').after.findings[0].value,1);
    assert.ok(out.rows.some(q=>q.id==='F10'&&q.axis==='roll'&&q.after.status==='Not evaluated'));
    const ctx={header:w.flight.header,rate:w.rate,flying:it.mask,profile:w.profileAt,govState:w.govStateAt,onlyFilters:true,gear};
    const end=Math.max(...P.windows.map(q=>q.st+q.N));ctx.flying=new Uint8Array(end);for(const q of P.windows)ctx.flying.fill(1,q.st,q.st+q.N);
    const truth=loop.judge([{log:0,metrics:loop.analyse({...w,n:end},ctx)}]).filter(f=>f.id==='C11');
    const before=out.rows.filter(q=>q.id==='C11').flatMap(q=>q.before.findings);
    assert.deepEqual(before.map(f=>[f.axis,f.value,f.threshold,f.severity]),truth.map(f=>[f.axis,f.value,f.threshold,f.severity]));
    assert.equal(out.rows.find(q=>q.id==='F1').before.findings[0].severity,setup.judge([{log:0,metrics:setup.analyse(w,ctx)}]).find(f=>f.id==='F1').severity);
    assert.deepEqual(w.gyro,raw,'before signals are never changed');
    // A configuration can include a short interval or one entirely outside the
    // flight mask. Neither has a spectrum window, even when other intervals do.
    const short=fixture(1), masked=fixture(2);
    short.w.n=500;
    masked.mask.fill(0);
    const mixed=A.prepare([it,short,masked],{gear});
    for(const q of mixed.windows)q.input=P.windows.find(p=>p.st===q.st).input;
    assert.deepEqual(check.compare(mixed,{gyro_lpf1_type:1,gyro_lpf1_static_hz:100}),out);
    assert.equal(mixed.segments.length,1);
    assert.deepEqual(mixed.excluded,[],'valid short periods do not invalidate the measured replay');
    assert.deepEqual(mixed.unmeasured.map(x=>x.log),[1]);
    assert.equal(mixed.unmeasured[0].eligibleS,.5);
    const broken=fixture(3);broken.w.n=500;broken.w.extra['gyroRAW[0]'][20]=NaN;
    assert.equal(A.prepare([broken],{gear}).excluded.length,1,'missing input remains a blocking failure even in a short period');
    assert.match(mixed.notes.join(' '),/Log 3: a period has no flight samples/);
    const empty=A.tune([short,masked],{gear});
    assert.equal(empty.recommended.status,'no flight log');
    assert.deepEqual(empty.recommended.cli,[]);
    assert.match(empty.recommended.reasons.join(' '),/no complete flight windows/);
});

test('correction of recorded filter problems ranks before larger noise reductions and cannot trade for a new failure',()=>{
    const C=require('../tools/autotune/filter_checklist.cjs');
    const f=(id,severity)=>({id,severity,log:0,segment:0,profile:2,text:'Filter check.',replayable:true});
    const before=[f('F6','flag'),f('F11','ok')];
    const candidate=(db,after)=>({score:{db},checks:C.assess(C.compareFindings(before,after,{baseline:before}))});
    const unchanged=candidate(-15,before),corrected=candidate(-5,[f('F6','ok'),f('F11','ok')]);
    const regression=candidate(-20,[f('F6','ok'),f('F11','flag')]);
    assert.equal(unchanged.checks.passed,false);assert.equal(corrected.checks.passed,true);assert.equal(regression.checks.passed,false);
    assert.equal([unchanged,corrected,regression].sort(A.rankCandidates)[0],corrected);
    assert.equal(corrected.checks.corrected,1);
    assert.match(unchanged.checks.reasons.join(' '),/does not correct or decrease a measured filter problem/);
    assert.match(regression.checks.reasons.join(' '),/new filter problems: F11/);
});

test('final selection preserves delay margin when training noise differences are within one SE',()=>{
    const checks={passed:true,newIssues:0,worsened:0,configurationIssues:0,remaining:3,unverified:0,improved:3,corrected:5};
    const q=(hz,db,se,delay)=>({changes:{gyro_lpf1_static_hz:hz},checks,score:{db,se,delay:{maxAddMs:delay}}});
    const best=q(100,-6.6,.2,.48),lowerDelay=q(200,-6.5,.1,.32),weak=q(300,-5.8,.1,.1);
    const missing={...q(400,-7,.2,.2),checks:{...checks,passed:false,unverified:1,remaining:2}};
    for(const list of [[best,lowerDelay,weak,missing],[missing,weak,lowerDelay,best]]) {
        const selected=A.selectFinalist(list);
        assert.equal(selected.candidate,lowerDelay);assert.equal(selected.allowanceDb,.2);assert.equal(selected.candidates,2);
    }
    assert.equal(A.selectFinalist([{...best,score:{...best.score,se:null}},lowerDelay]).candidate.changes.gyro_lpf1_static_hz,100,'unknown uncertainty gives no noise allowance');
    const noCorrection={...checks,corrected:0};
    const enough={...q(100,-3.1,.3,.48),checks:noCorrection},insufficient={...q(200,-2.9,.1,.32),checks:noCorrection};
    assert.equal(A.selectFinalist([insufficient,enough]).candidate,enough,'the delay preference cannot remove the minimum noise benefit');
});

test('baseline mismatch, lost measurements and removed RPM banks cannot count as corrections',()=>{
    const C=require('../tools/autotune/filter_checklist.cjs');
    const f=(id,severity,extra={})=>({id,severity,log:0,segment:0,profile:2,axis:'pitch',text:'Filter check.',replayable:true,...extra});
    const before=[f('F11','flag'),f('F6','flag',{notchSource:14}),f('F6','flag',{notchSource:15})];
    const after=[f('F11','ok'),f('F6','ok',{notchSource:12}),f('F6','skipped',{notchSource:15})];
    const baseline=[f('F11','ok'),before[1],before[2]],check=C.compareFindings(before,after,{baseline});
    assert.equal(check.summary.cleared,0);
    assert.equal(C.assess(check).unverified,3);
    assert.match(check.rows.find(r=>r.id==='F11').detail,/does not show/);
    assert.equal(check.rows.find(r=>r.notchSource===14).outcome,'Not evaluated');
    assert.equal(C.assess(C.compareFindings(before,after,{unchanged:true})).passed,false);
    assert.equal(C.summary([f('F6','ok'),f('F6','skipped',{notchSource:15})]).status,'Not evaluated','a measured bank cannot hide an unavailable bank');
    const unavailable=C.compareFindings([f('F6','flag',{replayable:false})],[f('F6','skipped',{replayable:false})]);
    assert.equal(C.assess(unavailable).unavailable,1);
    assert.equal(unavailable.rows[0].outcome,'Not evaluated','an unknown PID path remains an open recorded problem');
});

test('both export paths reject a noise-only recommendation with unresolved filter checks',()=>{
    const C=require('../tools/autotune/filter_checklist.cjs'),advice=require('../tools/autotune/advice.cjs');
    const failed={id:'F11',severity:'flag',log:0,profile:2,text:'The measured filter delay is too large.',replayable:true};
    const res={version:2,model:{passed:true},recommended:{status:'recommended',rows:[{name:'gyro_lpf1_static_hz',from:100,to:140,scope:'global',source:'header'}],
        predicted:{totalDb:-12,se:.1},validation:{}},checklist:C.compareFindings([failed],[failed])};
    assert.equal(A.cliExportStatus(res).available,false);
    assert.match(A.cliExportStatus(res).reasons.join(' '),/does not correct or decrease a measured filter problem/);
    assert.equal(A.cliFile(res),'');
    const recs=advice.filterRecommendations(res,{texts:A.texts(res)});
    assert.ok(recs.every(r=>r.severity==='check'&&!r.cli.length));
    assert.doesNotMatch(advice.exportScript(recs,null,{}),/^set /m);
});

test('measured attenuation and delay still require verified progress and reject regression',()=>{
    const C=require('../tools/autotune/filter_checklist.cjs');
    const f=(id,severity,value,se,notchSource)=>({id,severity,value,se,notchSource,log:13,segment:1,profile:2,axis:'pitch',replayable:true});
    const before=[f('F11','flag',20,.1),f('F6','flag',1,.1,14),f('F6','flag',2,.1,15)];
    const after=[f('F11','ok',8,.1),f('F6','flag',4,.1,14),before[2]];
    const check=C.compareFindings(before,after,{baseline:before}),partial=C.assess(check);
    assert.equal(partial.passed,true);assert.equal(partial.complete,false);
    assert.equal(partial.corrected,1);assert.equal(partial.improved,1);assert.equal(partial.remaining,2);
    const lost=C.assess(C.compareFindings(before,[after[0],{...after[1],severity:'skipped'},before[2]],{baseline:before}));
    assert.equal(lost.passed,false);
    const verified={score:{db:-5},checks:partial},unverified={score:{db:-15},checks:lost};
    assert.equal([unverified,verified].sort(A.rankCandidates)[0],verified);
    assert.equal(C.assess(C.compareFindings(before,[after[0],f('F6','flag',0,.1,14),before[2]],{baseline:before})).passed,false);
    const noProgress=C.compareFindings([before[2]],[before[2]]);
    assert.equal(C.assess(noProgress).passed,false);
    assert.equal(C.assess(noProgress,{requireProgress:false}).passed,true);
    C.verify(check,{passed:false,supported:true,parity:[{log:13,passed:false,axes:{pitch:{passed:false}}}]});
    assert.ok(check.rows.filter(r=>r.id!=='F7').every(r=>!r.confirmed&&r.outcome==='Not evaluated'));
});

test('measured noise improvement can pass search and export without turning guidance into faults',()=>{
    const it=correctionFixture(187),short=fixture(1);short.w.n=200;
    const P=A.prepare([it,short],{gear}),raw=[0,1,2].map(a=>it.w.extra['gyroRAW['+a+']']);
    for(const w of P.windows)w.input={start:w.st-w.lead,end:w.st+w.N,factor:1,raw:raw.map(x=>x.slice(w.st-w.lead,w.st+w.N)),native:raw.map(x=>x.slice(w.st-w.lead,w.st+w.N))};
    P.reconstructed=true;
    const result=A.tune([],{gear,prepared:P,maxCandidates:36,budgetMs:30000,curves:false});
    assert.equal(result.model.passed,true);
    assert.equal(result.recommended.status,'recommended',JSON.stringify(result.recommended.reasons));
    assert.ok(result.recommended.predicted.totalDb<=-3);
    assert.equal(result.recommended.validation.checks.targets,0);
    assert.ok(result.search.optimizerRuns.length>0);
    assert.ok(result.search.objectiveWindows.every(id=>!P.windows[id].held));
    assert.equal(result.unmeasuredPeriods.length,1);
    assert.equal(result.unmeasuredPeriods[0].eligibleS,.2);
    assert.doesNotMatch(result.cliFile,/Filter problems not corrected: F5/);
    assert.match(result.cliFile,/Signal change not measured: log 2/);
    assert.doesNotMatch(A.texts(result).recommendation,/Some filter problems are not corrected/);
    const advice=require('../tools/autotune/advice.cjs'),recs=advice.filterRecommendations(result,{texts:A.texts(result)});
    assert.ok(recs.some(r=>r.severity==='action'&&r.cli.length),'the combined export accepts the same validated partial correction');
    const script=advice.exportScript(recs,null,{});
    assert.doesNotMatch(script,/These filter problems are not corrected: F5/);
    assert.match(script.replace(/\n# /g,' '),/Log 2, 0 s to 0.2 s/);
    assert.match(script,/signal change is not measured/);
    const excessive=A.tune([],{gear,prepared:P,simulate:{gyro_lpf1_type:1,gyro_lpf1_static_hz:170},maxAddMs:.1,curves:false});
    assert.equal(excessive.recommended.status,'not recommended');
    assert.ok(excessive.recommended.validation.holdout.delay.maxAddMs>.1);
    assert.match(excessive.recommended.reasons.join(' '),/flight periods for the last test, the set adds [\d.]+ (\u00b1 [\d.e-]+ )?ms of filter time delay at \d+ Hz \((roll|pitch|yaw), (gyro|P-term|D-term), PID profile 2\)\. It is the mean of \d+ periods of 1 s, from [\d.]+ to [\d.]+ ms\. The limit is 0\.1 ms\./);
});

test('no finalist in the limits: the reasons give the limit that stopped the set with the lowest vibration',()=>{
    // the constraints of compare(): [largest delay - limit, largest gain loss - limit, roll, pitch, yaw noise change - 0.25 dB], unrounded;
    // delay.at and delay.lossAt: the band of the largest mean, with the number of its windows and their range
    const where={axis:'pitch',profile:1,hz:25,path:'gyro',windows:9,rangeMs:[.35,1.006]};
    const sc={db:-10.2041,delay:{checks:74,maxAddMs:0.593886,maxLossDb:0.149,at:where,lossAt:{...where,rangeDb:[0,.3]}},
        axes:[{axis:'roll',db:-11.6},{axis:'pitch',db:0.31},{axis:'yaw',db:-12.9}],constraints:[0.093886,-0.351,-11.85,0.06,-13.15]};
    assert.deepEqual(A.limitTexts(sc,{maxAddMs:.5}),['The set with the lowest vibration (-10.2 dB) adds 0.594 ms of filter time delay at 25 Hz (pitch, gyro, PID profile 1). It is the mean of 9 periods of 1 s, from 0.35 to 1.006 ms. The limit is 0.5 ms.',
        'The set with the lowest vibration (-10.2 dB) increases the pitch vibration by 0.31 dB. The limit is 0.25 dB.']);
    // just over a limit: the decision from the unrounded constraint, printed with the decimals that show it; one window, no range
    const yaw={axis:'yaw',profile:0,hz:10,path:'D',windows:1,rangeMs:[.5004,.5004],rangeDb:[.5002,.5002]};
    const near={db:0.199,delay:{checks:2,maxAddMs:.5004,maxLossDb:.5002,at:yaw,lossAt:yaw},
        axes:[{axis:'roll',db:.2541},{axis:'pitch',db:-1},{axis:'yaw',db:-1}],constraints:[.0004,.0002,.0041,-1.25,-1.25]};
    assert.deepEqual(A.limitTexts(near,{maxAddMs:.5}),['The set with the lowest vibration (0.2 dB) has less than 3 time delay measurements.',
        'The set with the lowest vibration (0.2 dB) adds 0.5004 ms of filter time delay at 10 Hz (yaw, D-term, PID profile unknown). It is the mean of 1 period of 1 s. The limit is 0.5 ms.',
        'The set with the lowest vibration (0.2 dB) decreases the D-term signal by 0.5002 dB at 10 Hz (yaw, D-term, PID profile unknown). It is the mean of 1 period of 1 s. The limit is 0.5 dB.',
        'The set with the lowest vibration (0.2 dB) increases the roll vibration by 0.254 dB. The limit is 0.25 dB.']);
    // tune(): a 0 ms limit leaves only sets that add no time delay; the selected set changes no value. A finalist passed, so the SE and
    // holdout reasons stay (with several recorded configurations, a set with no rows can still change the older logs). The reasons
    // of the rejected finalists come only when no finalist passes (the Fireball file of 2026-10-05, test/tuning_worker.test.cjs)
    const it=correctionFixture(187);it.w.flight.header.features=0;   // its RPM banks are empty: no RPM filter, only the PID cutoffs to change
    const P=A.prepare([it],{gear}),raw=[0,1,2].map(a=>it.w.extra['gyroRAW['+a+']']);
    for(const w of P.windows)w.input={start:w.st-w.lead,end:w.st+w.N,factor:1,raw:raw.map(x=>x.slice(w.st-w.lead,w.st+w.N)),native:raw.map(x=>x.slice(w.st-w.lead,w.st+w.N))};
    P.reconstructed=true;
    const none=A.tune([],{gear,prepared:P,maxCandidates:24,budgetMs:8000,maxAddMs:0,curves:false,optimizerEvaluations:12}),why=none.recommended.reasons;
    assert.deepEqual([none.recommended.status,none.recommended.rows,none.cliFile],['not recommended',[],'']);
    assert.ok(none.search.finalistCount>0&&why.includes('No filter set in the analysis decreases vibration by 3 dB or more in the replay limits.'),JSON.stringify(why));
    assert.ok(!why.some(t=>/^The set with the lowest vibration/.test(t)),'a finalist passed: no limit text of a rejected finalist');
    const db=none.search.rejected.map(r=>r.db);assert.deepEqual(db,db.slice().sort((x,y)=>x-y),'rejected: lowest vibration first');
    // the RPM-driven values: with the dynamic LPF1 recorded on, its type and base cutoff too
    assert.deepEqual([A.rpmDriven([{name:'gyro_lpf1_static_hz'}]),A.rpmDriven([{name:'gyro_lpf1_static_hz'}],{gyro_lpf1_dyn_min_hz:0}),A.rpmDriven([{name:'gyro_lpf1_static_hz'}],{gyro_lpf1_dyn_min_hz:60}),
        A.rpmDriven([{name:'gyro_lpf1_type'}],{gyro_lpf1_dyn_min_hz:60}),A.rpmDriven([{name:'gyro_lpf2_static_hz'}],{gyro_lpf1_dyn_min_hz:60})],[false,false,true,true,false]);
});
test('repair proposals combine the missing LPF and missing rotor harmonics without assigning resonances to RPM sources',()=>{
    const C=require('../tools/autotune/filter_checklist.cjs'),it=fixture(),h=it.w.flight.header;
    h.gyro_soft_type=0;h.features=1<<30;h.gyro_rpm_notch_preset=0;
    const P=A.prepare([it],{gear});
    const line=order=>({order,rotorLocked:true,axes:['roll','pitch','yaw'].map(axis=>({axis,amplitude:10}))});
    P.trainingChecklistBefore=[{id:'F5',severity:'flag',segment:0,lines:[line(4),line(3.74)]}];
    const repaired=A.repairCandidate(P,{dyn_notch_q:60});
    assert.equal(repaired.gyro_lpf1_type,1);assert.equal(repaired.dyn_notch_q,60);
    assert.equal(repaired.gyro_rpm_notch_preset,0);
    for(const ax of ['roll','pitch','yaw'])assert.deepEqual(repaired['gyro_rpm_notch_source_'+ax].filter(Boolean),[14]);
    assert.deepEqual(C.configurationIssues(P,repaired),[]);
    assert.deepEqual(A.invalid(P,repaired),[]);
    for(const ax of ['roll','pitch','yaw']) {
        h['gyro_rpm_notch_source_'+ax]=[14,...Array(15).fill(0)];
        h['gyro_rpm_notch_q_'+ax]=[60,...Array(15).fill(0)];
    }
    h.features=0;
    const disabled=A.prepare([it],{gear});disabled.trainingChecklistBefore=P.trainingChecklistBefore;
    const enabled=A.repairCandidate(disabled,{});
    assert.equal(enabled.RPM_FILTER,true,'an existing but disabled bank does not provide RPM coverage');
    assert.equal(enabled.gyro_lpf1_type,1);
    for(const ax of ['roll','pitch','yaw'])assert.equal(enabled['gyro_rpm_notch_source_'+ax],undefined,'reuse the recorded bank without adding a duplicate');
});

function correctionFixture(frequency=200) {
    const it=fixture(),w=it.w,h=w.flight.header,n=w.n,lib=require('../tools/autotune/lib.cjs');
    h.features=1<<30;h.gyro_rpm_notch_preset=0;h.gyro_soft_type=0;h.gyro_lowpass_hz=0;
    const raw=[0,1,2].map(a=>Float64Array.from({length:n},(_,i)=>10*Math.sin(2*Math.PI*13*i/1000+a)+8*Math.sin(2*Math.PI*frequency*i/1000+a)));
    w.extra=Object.fromEntries(raw.map((x,a)=>['gyroRAW['+a+']',x]));
    w.airborneAt=new Uint8Array(n).fill(1);w.govStateAt=new Uint8Array(n).fill(4);w.rescueAt=new Uint8Array(n);
    w.u=[0,1,2].map(()=>new Float64Array(n));w.sp=w.u;w.coll=new Float64Array(n);w.P=w.u;w.I=w.u;w.F=w.u;w.B=w.u;
    const cfg=FT.config(h,{gear}),pid=['roll','pitch','yaw'].map((ax,a)=>({known:true,gyro_cutoff:h[ax+'BW'][0],d_cutoff:h[ax+'BW'][1],Kp:50*lib.SCALE.P[a],Kd:15*lib.SCALE.D[a]}));
    const output=R.run(cfg,{n,raw,hs:w.hs},pid);w.gyro=output.y;w.D=output.d;
    return it;
}

test('autotune reduces a rotor line under measured delay and holdout limits with setup guidance retained',()=>{
    const it=correctionFixture(),P=A.prepare([it],{gear}),raw=[0,1,2].map(a=>it.w.extra['gyroRAW['+a+']']);
    // This fixture tests the search and its judges with complete native input.
    // Reconstruction accuracy has separate native-C regression tests.
    for(const w of P.windows)w.input={start:w.st-w.lead,end:w.st+w.N,factor:1,raw:raw.map(x=>x.slice(w.st-w.lead,w.st+w.N)),native:raw.map(x=>x.slice(w.st-w.lead,w.st+w.N))};
    P.reconstructed=true;
    const result=A.tune([],{gear,prepared:P,maxCandidates:36,budgetMs:30000,curves:false});
    assert.equal(result.recommended.status,'recommended',JSON.stringify(result.recommended.reasons));
    assert.ok(result.recommended.predicted.totalDb<=-3);
    assert.ok(result.recommended.delay.maxAddMs<=.5);
    assert.equal(result.recommended.validation.holdout.passed,true);
    assert.equal(result.recommended.validation.checks.remaining,0);
    assert.equal(result.recommended.validation.checks.training.passed,true);
    assert.equal(result.recommended.validation.checks.heldout.passed,true);
    for(const id of ['F1','F5'])assert.ok(result.checklist.rows.some(r=>r.id===id&&r.before.status==='Information'),id);
    assert.ok(result.cliFile);
    assert.match(result.cliFile,/does not predict a new closed-loop flight/);
    const baseline=A.tune([],{gear,prepared:P,simulate:{},curves:false});
    assert.equal(baseline.checklist.summary.cleared,0);
    assert.equal(baseline.checklist.summary.remaining,0);
    assert.ok(baseline.checklist.rows.some(r=>r.id==='F5'&&r.before.findings.some(f=>f.lines&&f.lines.length)),'the raw line measurements remain visible');
    assert.equal(baseline.cliFile,'');
    const noiseOnly=A.tune([],{gear,prepared:P,simulate:{gyro_notch1_hz:200,gyro_notch1_cutoff:190},curves:false});
    assert.equal(noiseOnly.model.passed,true);
    assert.ok(noiseOnly.recommended.predicted.totalDb<-3,'a static notch can supply the measured benefit without adding an LPF');
    assert.equal(noiseOnly.recommended.status,'recommended');
    assert.deepEqual(noiseOnly.recommended.reasons,[]);
    assert.ok(noiseOnly.cliFile);
});
