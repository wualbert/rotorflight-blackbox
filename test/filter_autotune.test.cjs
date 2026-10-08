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
    assert.match(A.prepare([rpm],{logGear:false}).excluded[0].reason,/RPM notch/);
    const fw=fixture(); fw.w.flight.firmware='Rotorflight 4.7.0';
    assert.equal(A.prepare([fw],{gear}).segments[0].unsupported,true);
});
test('the same complete target is replayed across logs with different original LPF and PID cutoffs',()=>{
    const P=A.prepare([fixture(0,80),fixture(1,130)],{gear});
    const wins=P.segments.map(s=>P.windows.find(w=>w.seg===s));
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
test('a delay increase in one profile is not concealed by another profile',()=>{
    function entry(id,profile,delay,power){
        const N=1024, rate=1000, K=N/2+1;
        const S={raw:new Float64Array(K).fill(power),y:new Float64Array(K).fill(power),re:new Float64Array(K),im:new Float64Array(K)};
        for(let k=0;k<K;k++){const ph=-2*Math.PI*k*rate/N*delay;S.re[k]=power*Math.cos(ph);S.im[k]=power*Math.sin(ph);}
        const w={id,profile,unit:String(profile),rate,N,seg:{firstProfile:0,cfg:{pid:{cli:{},header:Object.fromEntries(['roll','pitch','yaw'].map(ax=>[ax,{gyro_cutoff:80,d_cutoff:35,P:50,D:15}]))}}}};
        return {w,m:Array.from({length:3},()=>({power:1,pidPower:1,S,PS:S,DS:S}))};
    }
    const base={results:[entry(0,1,0,100),entry(1,2,0,1)]}, cand={results:[entry(0,1,0,100),entry(1,2,.002,1)]};
    const c=A.compare(cand,base); assert.equal(c.valid,false); assert.equal(c.delay.at.profile,2); assert.ok(c.delay.maxAddMs>1.9);
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
    const edited=A.manualChanges(P,{gyro_lpf1_type:'BESSEL','p2:roll_d_cutoff':'20',RPM_FILTER:'false'});
    assert.equal(edited.gyro_lpf1_type,8);assert.equal(edited['p2:roll_d_cutoff'],20);assert.equal(edited.RPM_FILTER,false);assert.equal(edited.dyn_notch_q,P.ref.s.dyn_notch_q);
    for(const value of [{unknown_parameter:3},{gyro_lpf1_type:'UNKNOWN'},{dyn_notch_q:101},{gyro_lpf1_static_hz:''},{gyro_rpm_notch_source_roll:'1,2'},{'p2:roll_d_cutoff':0},{filter_process_denom:2}])assert.throws(()=>A.manualChanges(P,value));
});

test('before/after checklist calls the original rules, clears a repaired LPF issue, and retains unavailable mixer checks',()=>{
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
    assert.ok(out.rows.some(q=>q.id==='F1'&&q.outcome==='Cleared in replay'));
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
    assert.deepEqual(mixed.excluded.map(x=>x.log),[1,2]);
    const empty=A.tune([short,masked],{gear});
    assert.equal(empty.recommended.status,'no flight log');
    assert.deepEqual(empty.recommended.cli,[]);
    assert.match(empty.recommended.reasons.join(' '),/no complete flight windows/);
});
