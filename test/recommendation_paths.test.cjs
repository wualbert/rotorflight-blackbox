'use strict';

// Recommendation-path audit: branch contracts missing from the generator tests,
// plus regressions for causal wording and the two filter-export entry points.
// These fixtures make no claim about a helicopter response after a gain change.
const test = require('node:test');
const assert = require('node:assert/strict');
const advice = require('../tools/autotune/advice.cjs');
const setup = require('../tools/autotune/health_setup.cjs');
const filter = require('../tools/autotune/filter_autotune.cjs');
const control = require('../tools/autotune/control_tune.cjs');

const pad = values => values.concat(Array(16 - values.length).fill(0));
const HEADER = {
    looptime:250, pid_process_denom:2, frameIntervalPNum:1, frameIntervalPDenom:2,
    features:(1 << 29) | (1 << 30), rates_type:6,
    rollPID:[50,100,0,100,0], pitchPID:[50,100,40,100,0], yawPID:[80,120,14,20,0], govPID:[40,50,0,10,40],
    yaw_stop_gain:[120,80], yaw_precomp:[5,10,60], yaw_inertia_precomp:[0,25], yaw_tta:[0,20], pitch_compensation:50,
    gyro_soft_type:1, gyro_lowpass_hz:100, gyro_soft2_type:0, gyro_lowpass2_hz:50, gyro_lowpass_dyn_hz:[0,0],
    dyn_notch_count:6, dyn_notch_q:25, dyn_notch_min_hz:20, dyn_notch_max_hz:240, gyro_rpm_notch_preset:0
};
for (const axis of ['roll','pitch','yaw']) {
    HEADER[`gyro_rpm_notch_source_${axis}`] = pad([11,12]);
    HEADER[`gyro_rpm_notch_q_${axis}`] = pad([80,40]);
    HEADER[`gyro_rpm_notch_center_${axis}`] = pad([]);
}
let fid = 0;
const finding = (id, over = {}) => ({fid:`audit-${++fid}`,id,module:'loop',severity:'flag',log:0,profile:1,
    value:null,se:null,n:10,source:'pipeline, unvalidated',text:'',times:[],...over});
const run = (findings = [], over = {}) => advice.advise({findings,header:HEADER,headerProfile:1,headerLog:0,
    logs:[{log:0,flown:true,flyingS:120,profileSeconds:{1:100,2:20},targetOf:{1:2300,2:2500}}],...over});
function only(out, id) {
    const list = out.recommendations.filter(r => r.id === id || r.id.startsWith(`${id}:`));
    assert.equal(list.length,1,`${id}: ${out.recommendations.map(r => r.id).join(', ')}`);
    return list[0];
}
const noCommands = recs => {
    assert.ok(recs.every(r => r.cli.length === 0));
    assert.deepEqual(advice.defaultPicks(recs),[]);
    assert.doesNotMatch(advice.exportScript(recs,null,{}),/^(?:set |feature |profile |rateprofile |save$)/m);
};

test('audit D9: known rescue OFF is a manual scoped action; an absent profile stays unknown', () => {
    const cli = setup.parseCli('profile 0\nset rescue_mode = OFF\n');
    const off = finding('D9',{module:'config',profile:1,basis:'cli',flown:true,flightS:100});
    const r = only(run([off],{cli,cliName:'capture.txt'}),'D9');
    assert.equal(r.severity,'action');
    assert.equal(r.profile,1);
    assert.match(r.text,/rescue_mode.*OFF/);
    assert.match(r.text,/CLIMB or ALT_HOLD/);
    assert.match(r.text,/motor off/);
    noCommands([r]); // The switch and chosen mode cannot be inferred from a log.
    const ground = only(run([{...off,flown:false,flightS:0}],{cli}),'D9');
    assert.match(ground.text,/no flight in this PID profile/);
    const unknown = finding('D9',{module:'config',severity:'note',thin:true,profile:null,unknownProfiles:[2,3]});
    assert.equal(run([unknown]).recommendations.length,0,'optional CLI is not a prerequisite');
    const u = only(run([unknown],{cli}),'D9');
    assert.equal(u.severity,'info');
    assert.match(u.text,/PID profiles 2 and 3/);
    noCommands([u]);
});

test('audit P1: severe loaded-cell voltage is a battery check; warning-only data is a watch', () => {
    const f = finding('P1',{module:'power',profile:null,severe:2,minCell:3.15,beforeCell:3.8,limits:{min:3.3,warning:3.5}});
    const bad = only(run([f]),'P1');
    assert.equal(bad.severity,'check');
    assert.match(bad.text,/2 load steps/);
    assert.match(bad.text,/3\.15 V/);
    assert.match(bad.text,/different battery/);
    noCommands([bad]);
    const low = only(run([{...f,severity:'note',severe:0,minCell:3.4}]),'P1');
    assert.equal(low.severity,'watch');
    assert.match(low.text,/warning level of 3\.5 V/);
    noCommands([low]);
    for (const over of [{severity:'ok'},{severity:'note',thin:true},{severity:'note',text:'no finding: no load steps'}])
        assert.equal(run([{...f,...over}]).recommendations.length,0);
});

test('audit P2: only a measured higher battery slope yields a watch; no arbitrary gain remedy', () => {
    const f = finding('P2',{module:'power',profile:null,severity:'note',higher:true,value:15,se:1,othersMedian:7});
    const r = only(run([f]),'P2');
    assert.equal(r.severity,'watch');
    assert.match(r.text,/15 ± 1/);
    assert.match(r.text,/7 mΩ/);
    assert.match(r.text,/charger/);
    noCommands([r]);
    for (const over of [{higher:false},{thin:true},{severity:'ok'},{text:'no finding: Ibat absent'}])
        assert.equal(run([{...f,...over}]).recommendations.length,0);
});

test('audit D1/D3: unavailable input is distinguished from a correct selected configuration', () => {
    const slow = finding('D1',{module:'setup',profile:null,value:500});
    const missing = only(run([slow],{header:{}}),'D1');
    assert.equal(missing.severity,'check');
    assert.match(missing.text,/header.*not available/);
    noCommands([missing]);
    const impossible = only(run([slow],{header:{...HEADER,looptime:2000,pid_process_denom:1}}),'D1');
    assert.equal(impossible.severity,'check');
    assert.match(impossible.text,/no value of blackbox_rate_denom/);
    noCommands([impossible]);
    const current = only(run([slow]),'D1');
    assert.equal(current.severity,'info');
    noCommands([current]);
    const d3 = finding('D3',{module:'setup',profile:null,severity:'note',text:'checks that cannot run: R1 (rcCommand[0] absent)'});
    assert.equal(only(run([d3]),'D3').severity,'info');
    assert.equal(only(run([{...d3,text:'checks that cannot run: G2 (govTarget absent)'}]),'D3').severity,'check');
    assert.equal(run([{...d3,text:'checks that cannot run: no parseable field list'}]).recommendations.length,0);
});

test('audit F1: enable the recorded LPF type without claiming a different type was tested', () => {
    const f = finding('F1',{module:'setup',profile:null,value:0});
    const r = only(run([f],{header:{...HEADER,gyro_soft_type:2,gyro_lowpass_hz:0}}),'F1');
    assert.equal(r.severity,'action');
    assert.deepEqual(r.cli,['set gyro_lpf1_static_hz = 100']);
    assert.match(r.text,/SECOND_ORDER/);
    assert.doesNotMatch(r.text,/FIRST_ORDER/);
    assert.match(r.text,/next flight must measure/i);
    const off = only(run([{...f,severity:'note'}],{header:{...HEADER,features:0,gyro_soft_type:0,gyro_lowpass_hz:0}}),'F1');
    assert.equal(off.severity,'check');
    noCommands([off]);
});

test('audit F2/F3: old limits do not cause another change; incomplete or preset banks cannot export', () => {
    const f2 = finding('F2',{module:'setup',profile:null,value:40});
    const old = only(run([f2]),'F2');
    assert.equal(old.severity,'info');
    noCommands([old]);
    const stage2 = only(run([f2],{header:{...HEADER,gyro_soft2_type:1,gyro_lowpass2_hz:40}}),'F2');
    assert.deepEqual(stage2.cli,['set gyro_lpf2_static_hz = 60']);
    const f3 = finding('F3',{module:'setup',profile:null,value:1.5});
    const preset = only(run([f3],{header:{...HEADER,gyro_rpm_notch_preset:1,gyro_rpm_notch_q_roll:pad([15,40])}}),'F3');
    assert.equal(preset.severity,'check');
    assert.match(preset.text,/preset 0/);
    noCommands([preset]);
    const short = only(run([f3],{header:{...HEADER,gyro_rpm_notch_source_roll:[11],gyro_rpm_notch_q_roll:[15]}}),'F3');
    assert.match(short.caveats.join(' '),/16/);
    noCommands([short]);
    const fixed = only(run([f3]),'F3');
    assert.equal(fixed.severity,'info');
    noCommands([fixed]);
});

test('audit F5/C3/T9 diagnostics: a missing line fit or rate mismatch cannot invent a corrective parameter', () => {
    const missing=only(run([finding('F5',{module:'setup',value:null,se:null})]),'F5');
    assert.equal(missing.severity,'check');
    assert.equal(missing.parameter,null);
    noCommands([missing]);
    for(const [id,axis] of [['C3','roll'],['T9','yaw']]) {
        const rate=only(run([finding(id,{axis,value:0,se:0.01,gyroRatio:{mean:0.7,se:0.01}})]),id);
        assert.equal(rate.parameter,null);
        assert.match(rate.text,/0\.7 ± 0\.01/);
        assert.match(rate.text,/I-term near 0/);
        assert.doesNotMatch(rate.text,/I-term must supply a part/);
        noCommands([rate]);
    }
});

test('audit T3/T10: diagnostic-only comparison and phase-margin paths never manufacture a gain', () => {
    for (const [id,value,pattern] of [['T3',2.4,/headspeed/],['T10',25,/35 deg/]]) {
        const r = only(run([finding(id,{axis:'yaw',value,se:0.1})]),id);
        assert.equal(r.severity,'check');
        assert.match(r.text+' '+r.rule,pattern);
        assert.equal(r.parameter,null);
        noCommands([r]);
        assert.equal(run([finding(id,{axis:'yaw',severity:'ok',value})]).recommendations.length,0);
    }
});

test('audit R1/C13/T12: command shaping and setpoint-to-gyro lag retain different causes', () => {
    const r = only(run([finding('R1',{module:'track',axis:'roll',profile:null,value:80,se:2,rateProfile:2})]),'R1');
    assert.match(r.text,/larger acceleration limit.*(?:setpoint change faster|faster setpoint changes)/i);
    assert.match(r.text,/smaller response time decreases/i);
    assert.equal(r.rateProfile,2);
    noCommands([r]);
    for (const [id,axis] of [['C13','pitch'],['T12','yaw']]) {
        const lag = only(run([finding(id,{module:'track',axis,value:160,se:5})]),id);
        assert.match(lag.text,/setpoint/);
        assert.doesNotMatch(lag.text,/rate profile|response_time|accel_limit/);
        assert.match(lag.text,/does not measure the time delay from the stick to the setpoint/);
        noCommands([lag]);
    }
});

test('audit T13/G10: offset and coherence diagnoses do not identify a measured corrective effect', () => {
    const trim = only(run([finding('T13',{module:'more',axis:'yaw',value:0.3,se:0.02})]),'T13');
    assert.match(trim.text,/constant torque offset/);
    assert.match(trim.text,/If the I-term changes with collective/);
    assert.doesNotMatch(trim.text,/collective precompensation is too (?:large|small)/);
    noCommands([trim]);
    const coupled = only(run([finding('G10',{module:'gov',axis:'yaw',value:0.85,se:0.03})]),'G10');
    assert.match(coupled.text,/coherence/);
    assert.match(coupled.text,/does not measure the effect/);
    assert.match(coupled.text,/next flight must measure/i);
    assert.deepEqual(coupled.cli,['profile 0','set gov_gain = 36']);
});

test('audit finish: blocked and unknown-base proposals contain no direct set instruction or promised result', () => {
    const c14 = finding('C14',{module:'more',axis:'pitch',value:100,se:5,gainChange:100,gainChangeSe:10});
    const f1 = finding('F1',{module:'setup',profile:null,value:0});
    const held = only(run([c14,f1],{header:{...HEADER,gyro_soft_type:0,gyro_lowpass_hz:0}}),'C14');
    assert.match(held.text,/This change must wait|conditional proposal/i);
    assert.doesNotMatch(held.text,/(?:^|[.\n] )Set pitch_collective_ff_gain/);
    assert.doesNotMatch(held.text,/Then the helicopter pitches less/);
    noCommands([held]);
    const unknown = only(run([{...c14,profile:2}]),'C14');
    assert.equal(unknown.from,null);
    assert.match(unknown.text,/This change must wait|conditional proposal|unknown/i);
    assert.doesNotMatch(unknown.title,/^(?:Increase|Raise|Decrease|Lower|Reduce|Set|Add|Use|Make)\b/);
    assert.doesNotMatch(unknown.text,/(?:^|[.\n] )Set pitch_collective_ff_gain/);
    noCommands([unknown]);
    const accepted = only(run([c14]),'C14');
    assert.ok(accepted.cli.length);
    assert.match(accepted.text,/can decrease/);
    assert.match(accepted.text,/next flight must measure/i);
});

test('audit finish missing base: held F10 and sibling actions have descriptive titles without export authority', () => {
    const cases = [
        finding('F10',{module:'more',axis:'yaw',profile:3,value:0.85,se:0.01}),
        finding('C14',{module:'more',axis:'pitch',profile:3,value:100,se:5,gainChange:100,gainChangeSe:10}),
        finding('C3',{axis:'roll',profile:3,value:0.3,se:0.02,gyroRatio:{mean:1,se:0.01}}),
        finding('T5',{axis:'yaw',profile:3,value:2,se:0.1,larger:'ccw'}),
        finding('G9',{module:'gov',profile:3,value:9,se:1,text:'(P-type)'})
    ];
    const imperative = /^(?:Increase|Raise|Decrease|Lower|Reduce|Set|Add|Use|Make)\b/;
    for (const f of cases) for (const held of [false,true]) {
        const out = run(held ? [f,finding('F1',{module:'setup',profile:null,value:0})] : [f],
            held ? {header:{...HEADER,gyro_soft_type:0,gyro_lowpass_hz:0}} : {});
        const r = f.id === 'F10' ? out.recommendations.find(q=>q.parameter==='yaw_d_gain') : only(out,f.id);
        assert.ok(r,`${f.id}: proposal exists`);
        assert.equal(r.severity,'action',`${f.id}: underlying action remains visible`);
        assert.equal(r.from,null,`${f.id}: profile 3 base is unrecorded`);
        assert.equal(r.to,null,`${f.id}: no numerical target can be built`);
        assert.doesNotMatch(r.title,imperative,`${f.id}: ${held ? 'held' : 'unknown'} action is descriptive`);
        assert.match(r.title,/to examine/);
        assert.match(r.text,/This change must wait/);
        noCommands([r]);
    }
});

const filterRow = (over = {}) => ({name:'gyro_lpf1_static_hz',from:140,to:140,source:'header',scope:'global',...over});
const filterResult = (over = {}) => ({version:2,mode:'simulation',model:{passed:true},limits:{maxAddMs:0.1},bootProfile:1,
    recommended:{status:'recommended',reasons:[],params:{gyro_lpf1_static_hz:140},rows:[],fullRows:[filterRow()],predicted:{totalDb:0}},...over});
function filterOut(result, meta = {}) { return advice.filterRecommendations(result,{texts:filter.texts(result),...meta}); }

test('audit filter baseline: empty params never export a flattened reference profile, even if replay passes', () => {
    for (const passed of [true,false]) {
        const result = filterResult();
        result.model.passed = passed;
        result.recommended.params = {};
        const recs = filterOut(result);
        noCommands(recs);
        assert.equal(filter.cliFile(result),'');
        assert.doesNotMatch(recs.map(r => r.text).join(' '),/changed values/i);
    }
});

test('audit filter common target: an explicit target equal to the reference still exports the replayed full target', () => {
    const result = filterResult(); // Other recorded intervals may have different cutoffs.
    const recs = filterOut(result);
    assert.equal(recs.length,1);
    assert.equal(recs[0].severity,'action');
    assert.deepEqual(recs[0].cli,['set gyro_lpf1_static_hz = 140']);
    assert.match(filter.cliFile(result),/^set gyro_lpf1_static_hz = 140$/m);
    assert.match(advice.exportScript(recs,null,{}),/^set gyro_lpf1_static_hz = 140$/m);
    assert.match(recs[0].text,/replay estimates/);
    assert.match(recs[0].text,/new flight must measure/i);
});

test('audit filter acceptance: status, model and upstream prerequisites agree in both CLI entry points', () => {
    for (const kind of ['not-recommended','model','upstream']) {
        const result = filterResult(), meta = {};
        if (kind === 'not-recommended') result.recommended.status = 'not recommended';
        if (kind === 'model') result.model.passed = false;
        if (kind === 'upstream') meta.blockedBy = ['Correct the RPM signal first.'];
        const recs = filterOut(result,meta);
        noCommands(recs);
        assert.equal(filter.cliFile(result,{recommendations:recs}), '',kind);
    }
});

test('audit filter rows: invalid feature values, unknown bases and unknown profiles are not exported', () => {
    const bad = [
        {name:'feature RPM_FILTER',from:true,to:'yes'},
        {name:'feature RPM_FILTER',from:null,to:true},
        {name:'feature RPM_FILTER',from:false,to:true,source:'default'},
        {name:'feature RPM_FILTER',from:false,to:true,scope:'profile',profile:1},
        {name:'yaw_d_cutoff',from:20,to:15,scope:'profile',profile:0},
        {name:'yaw_d_cutoff',from:20,to:15,scope:'profile',profile:7},
        {name:'yaw_d_cutoff',from:20,to:15,scope:'profile',profile:1.5},
        {name:'gyro_lpf1_type',from:'FIRST_ORDER',to:'NONE',scope:'profile',profile:7},
        {name:'gyro_lpf1_static_hz',from:null,to:100}
    ];
    for (const row of bad) {
        const result = filterResult();
        result.recommended.rows = result.recommended.fullRows = [filterRow(row)];
        noCommands(filterOut(result));
        assert.equal(filter.cliFile(result),'',JSON.stringify(row));
    }
    const valid = filterResult();
    valid.recommended.fullRows = [filterRow({name:'feature RPM_FILTER',from:false,to:true})];
    assert.deepEqual(filterOut(valid)[0].cli,['feature RPM_FILTER']);
    assert.match(filter.cliFile(valid),/^feature RPM_FILTER$/m);
});

test('audit filter recorded bases: malformed known-source values cannot authorize direct or shared CLI', () => {
    const bad = [
        {name:'feature RPM_FILTER',from:'not recorded',to:true},
        {name:'feature RPM_FILTER',from:2,to:true},
        {from:'unknown',to:90},{from:NaN,to:90},{from:Infinity,to:90},
        {name:'gyro_lpf1_type',from:'unavailable',to:'FIRST_ORDER'},
        {name:'gyro_rpm_notch_source_roll',from:'11,12',to:pad([11,12]).join(',')},
        {name:'motor_rpm_lpf',from:'1,2,3',to:'20,20,20,20'},
        {name:'yaw_d_cutoff',from:-1,to:20,scope:'profile',profile:1}
    ];
    for (const row of bad) {
        const result = filterResult();
        result.recommended.rows = result.recommended.fullRows = [filterRow(row)];
        noCommands(filterOut(result));
        assert.equal(filter.cliFile(result),'',JSON.stringify(row));
    }
});

test('audit filter duplicate rows: conflicting target or recorded base invalidates the complete proposal', () => {
    const conflicts = [
        [filterRow({to:90}),filterRow({to:80})],
        [filterRow({to:90}),filterRow({from:120,to:90})],
        [filterRow({name:'feature RPM_FILTER',from:false,to:true}),filterRow({name:'feature RPM_FILTER',from:false,to:false})],
        [filterRow({name:'yaw_d_cutoff',from:20,to:30,scope:'profile',profile:1}),filterRow({name:'yaw_d_cutoff',from:20,to:40,scope:'profile',profile:1})]
    ];
    for (const rows of conflicts) {
        const result = filterResult();
        result.recommended.rows = result.recommended.fullRows = rows;
        noCommands(filterOut(result));
        assert.equal(filter.cliFile(result),'',JSON.stringify(rows));
    }
    // The same parameter on two different PID profiles is not a conflict.
    const distinct = filterResult();
    distinct.recommended.rows = distinct.recommended.fullRows = [1,2].map(p=>filterRow({name:'yaw_d_cutoff',from:20,to:20+10*p,scope:'profile',profile:p}));
    const recs = filterOut(distinct);
    assert.ok(recs.every(r=>r.severity==='action' && r.cli.length));
    for (const text of [filter.cliFile(distinct),advice.exportScript(recs,null,{})]) {
        assert.match(text,/profile 0[\s\S]*set yaw_d_cutoff = 30/);
        assert.match(text,/profile 1[\s\S]*set yaw_d_cutoff = 40/);
    }
});

test('audit dispatch envelope: errors are diagnostic, unimplemented IDs remain report-only, inputs remain unchanged', () => {
    const input = [finding('G3',{module:'gov',severity:'error',text:'missing governor samples'}),
        finding('C14',{module:'more',severity:'error',text:'missing compensation samples'}),
        finding('UNKNOWN',{value:10}),finding('C8',{value:10}),finding('C9',{value:10}),finding('G7',{value:10}),finding('G20',{value:10})];
    const before = JSON.stringify(input), out = run(input);
    assert.equal(JSON.stringify(input),before);
    const error = only(out,'ERROR');
    assert.equal(error.severity,'check');
    assert.equal(error.evidence.length,2);
    assert.match(error.text,/Module `gov`/);
    assert.match(error.text,/Module `more`/);
    noCommands(out.recommendations);
    assert.match(out.notes.join(' '),/UNKNOWN/);
    assert.doesNotMatch(out.notes.join(' '),/C8.*no recommendation|C9.*no recommendation|G20.*no recommendation/);
});

const controlRec = (over = {}) => ({id:'trial',node:'cyclic',area:'cyclic',dataset:'A',profile:1,scope:'profile',cliProfile:0,
    severity:'action',axis:'roll',parameter:'roll_p_gain',from:50,to:55,fromSource:'log header',
    title:'Roll P gain test',cli:['profile 0','set roll_p_gain = 55'],blockedBy:[],causes:[],rule:'Test one gain change.',
    evidence:[{id:'C7',fid:'model',value:10,se:1}],...over});
const controlInput = (recs, step = 'cyclic') => ({configuration:'A',step,analysis:{datasets:{datasets:[
    {id:'A',pidProfile:1,analysed:true,analysedFlightSeconds:100,values:{roll_p_gain:50,roll_d_gain:20,gov_f_gain:10}}]},
    advice:{byDataset:{A:recs}},decisions:[]}});

test('audit control diagnoses: output limits remain unresolved diagnoses for every affected procedure', () => {
    for (const [step,id] of [['governor','G6'],['cyclic','C2'],['tail','T8'],['tailcomp','T8']]) {
        const r = controlRec({id,node:step,severity:'check',parameter:null,cli:[],
            evidence:[{id,value:2.5,unit:'s'}],text:'Examine the output limit and its cause.'});
        const out = control.tune(controlInput([r],step));
        assert.equal(out.status,'diagnosis-required',step);
        assert.deepEqual(out.experiments,[]);
        assert.deepEqual(out.recommendations,[]);
        assert.equal(out.guidance[0].id,id);
        assert.match(out.reason,/not corrected/);
        assert.equal(out.verifiedInFlight,false);
        assert.equal(out.prediction,null);
        noCommands(out.recommendations);
        const watch = control.tune(controlInput([{...r,severity:'watch'}],step));
        assert.equal(watch.status,'no-change');
        assert.equal(watch.guidance.length,1);
        assert.match(watch.reason,/monitor/);
    }
});

test('audit control selection: a supported test cannot hide a separate diagnosis or borrow an unscoped base', () => {
    const diagnostic = controlRec({id:'diagnosis',severity:'check',parameter:null,cli:[],
        evidence:[{id:'C2',value:3,unit:'s'}],text:'Examine the output limit.'});
    const out = control.tune(controlInput([controlRec(),diagnostic]));
    assert.equal(out.status,'flight-test-required');
    assert.equal(out.recommendations.length,1);
    assert.equal(out.guidance[0].id,'diagnosis');
    assert.equal(out.verifiedInFlight,false);
    assert.equal(out.prediction,null);
    const unscoped = control.tune(controlInput([controlRec({dataset:null})]));
    assert.equal(unscoped.recommendations.length,0);
    assert.match(unscoped.deferred[0].reason,/configuration does not agree/);
    const duplicate = control.tune(controlInput([controlRec({group:'joint',groupSize:2}),controlRec({id:'second',group:'joint',groupSize:2})]));
    assert.equal(duplicate.recommendations.length,0);
    assert.match(duplicate.deferred[0].reason,/same parameter/);
    assert.throws(() => control.tune(controlInput([], 'unknown')),/step is unknown/);
});

test('audit control authority: explicit PID identity, parameter family, documented steps and causal prerequisites are checked', () => {
    const wrongPid=control.tune(controlInput([controlRec({pidProfile:2})]));
    assert.equal(wrongPid.recommendations.length,0);
    assert.match(wrongPid.deferred[0].reason,/configuration does not agree/);
    const wrongFamily=control.tune(controlInput([controlRec({parameter:'gov_f_gain',from:10,to:20,cli:['profile 0','set gov_f_gain = 20']})]));
    assert.equal(wrongFamily.recommendations.length,0);
    assert.match(wrongFamily.deferred[0].reason,/different check/);
    const gov=controlRec({node:'governor',parameter:'gov_f_gain',from:10,to:10+advice.RULES.govSteps.F,
        cli:['profile 0',`set gov_f_gain = ${10+advice.RULES.govSteps.F}`]});
    assert.equal(control.tune(controlInput([gov],'governor')).status,'flight-test-required','documented absolute step is permitted');
    const held=controlRec({cli:[],causes:[{holds:true,ids:['F1']}]});
    const prerequisite=controlRec({id:'filter',node:'filters',scope:'global',parameter:'gyro_lpf1_static_hz',from:0,to:100,
        cli:['set gyro_lpf1_static_hz = 100'],evidence:[{id:'F1',value:0}]});
    const result=control.tune(controlInput([held,prerequisite]));
    assert.equal(result.status,'prerequisites-required');
    assert.deepEqual(result.prerequisites.map(r=>r.id),['filter'],'causal evidence finds the prior procedure without a copied node list');
    assert.equal(result.proposals.length,1);
    noCommands(result.recommendations);
    const contextual=control.flightPlan([controlRec({axis:null,causes:[{holds:false}]})]);
    assert.equal(contextual.maneuvers[0].key,'1:roll-steps','a nonholding context does not block the test');
});

test('audit control prediction: absent or invalid model uncertainty cannot become an after-response', () => {
    const r=controlRec({confidence:'predicted'}), input=controlInput([r]);
    const model={fid:'model',dataset:'A',axis:'roll',change:true,gates:Object.fromEntries(['V1','V2a','V2b','V3'].map(k=>[k,{pass:true}])),
        changes:[{gain:'P',from:50,to:55}],tracking:[20,15],dTrack:5,seTrack:1,flights:3};
    input.analysis.decisions=[model];
    assert.deepEqual(control.tune(input).prediction.tracking,[20,15]);
    for(const over of [{tracking:null},{tracking:[20]},{tracking:[20,NaN]},{dTrack:null},{seTrack:null},{seTrack:-1}]) {
        input.analysis.decisions=[{...model,...over}];
        const result=control.tune(input);
        assert.equal(result.prediction,null,JSON.stringify(over));
        assert.equal(result.verifiedInFlight,false);
    }
});

test('audit G3: text-only, saturated and uncertain evidence cannot authorize a feedforward increase', () => {
    const response = () => ({unsaturated:{mean:0.07,se:0.005,n:10},saturated:{mean:null,se:null,n:0},feedforward:{mean:0.3,se:0.01,n:10}});
    const base = finding('G3',{module:'gov',value:0.07,se:0.005,text:'F too low (GOVT)'});
    noCommands([only(run([base]),'G3')]);
    const good = only(run([{...base,governorResponse:response()}]),'G3');
    assert.deepEqual(good.cli,['profile 0','set gov_f_gain = 20']);
    for (const edit of [g=>{g.unsaturated.n=0;},g=>{g.unsaturated.mean=0.02;},g=>{g.unsaturated.se=null;},
        g=>{g.unsaturated.se=-1;},g=>{g.feedforward.n=1;},g=>{g.feedforward.mean=0.49;},
        g=>{g.feedforward.mean=-0.3;},g=>{g.feedforward.mean=1.2;},g=>{g.feedforward.se=null;}]) {
        const g = response(); edit(g);
        const rec = only(run([{...base,governorResponse:g}]),'G3');
        noCommands([rec]);
        assert.notEqual(rec.severity,'action',String(edit));
    }
});

test('audit C7: every model gate and three flights are necessary before a gain target can export', () => {
    const decision = () => ({fid:'decision',axis:'pitch',bin:2250,flights:3,windows:100,change:true,
        gates:{V1:{pass:true},V2a:{pass:true},V2b:{pass:true},V3:{pass:true}},tracking:[20,15],dTrack:5,seTrack:1,
        disturbance:[5,5],total:[21,16],validBand:[1,15],changes:[{gain:'F',multiplier:0.9,from:100,to:90}]});
    assert.deepEqual(only(run([],{decisions:[decision()]}),'C7').cli,['profile 0','set pitch_f_gain = 90']);
    for (const key of ['V1','V2a','V2b','V3']) for (const failure of ['missing','false']) {
        const d = decision();
        if (failure === 'missing') delete d.gates[key]; else d.gates[key].pass = false;
        const r = only(run([],{decisions:[d]}),'C7');
        assert.equal(r.severity,'check'); noCommands([r]);
    }
    const d = decision(); d.flights=2;
    noCommands([only(run([],{decisions:[d]}),'C7')]);
    d.flights=3; d.change=false; d.reason='No measured improvement.';
    assert.equal(only(run([],{decisions:[d]}),'C7').severity,'info');
});

test('audit uncertainty: missing or negative SE cannot satisfy a numeric gain rule', () => {
    for (const se of [null,-0.01,NaN]) {
        const f = finding('C3',{axis:'roll',value:0.2,se,gyroRatio:{mean:1,se:0.01},text:'FF too low (raise F)'});
        const r = only(run([f]),'C3');
        assert.equal(r.severity,'watch');
        assert.match(r.caveats.join(' '),/no (?:valid )?uncertainty estimate/);
        noCommands([r]);
    }
});

test('audit pooled uncertainty: repeated incomplete estimates cannot create measured confidence', () => {
    for (const ses of [[null,null],[-1,-1],[NaN,NaN],[0.01,null]]) {
        const findings=ses.map((se,log)=>finding('C3',{axis:'roll',log,value:0.3,se}));
        const r=only(run(findings),'C3');
        noCommands([r]);
        assert.match(r.caveats.join(' '),/uncertainty|SE/,JSON.stringify(ses));
        const c14=ses.map((gainChangeSe,log)=>finding('C14',{module:'more',axis:'pitch',log,value:100,se:5,gainChange:40,gainChangeSe}));
        noCommands([only(run(c14),'C14')]);
    }
    const exact=[0,1].map(log=>finding('C3',{axis:'roll',log,value:0.3,se:0}));
    assert.deepEqual(only(run(exact),'C3').cli,['profile 0','set roll_f_gain = 120'],'zero is a valid known SE');
});

test('audit C4: overshoot or settling must pass a known uncertainty test before a gain trial', () => {
    const stop=over=>finding('C4',{axis:'pitch',value:30,se:null,text:'FF too low',...over});
    for (const over of [{},{settleS:{mean:1,se:null}},{se:-1,settleS:{mean:1,se:NaN}},
        {value:12,se:2,settleS:{mean:1,se:null}},{se:null,settleS:{mean:0.2,se:0.02}}]) {
        noCommands([only(run([stop(over)]),'C4')]);
    }
    // Either independently measured symptom can qualify the documented trial.
    for (const over of [{se:1},{value:1,se:null,settleS:{mean:1,se:0.05}}]) {
        const r=only(run([stop(over)]),'C4');
        assert.deepEqual(r.cli,['profile 0','set pitch_f_gain = 110']);
        assert.match(r.text,/next flight must measure/i);
    }
});

test('audit authority: T8, L4 and rescue T15 cannot recommend more headspeed beside a same-profile governor limit', () => {
    const limit = finding('G6',{module:'gov',profile:1,value:90});
    const tail = finding('T8',{axis:'yaw',profile:1,value:2,text:'20 episodes'});
    const servo = finding('L4',{module:'limits',channel:'tail',axis:'yaw',profile:1,value:0.2,n:1,longestS:0.2,
        limits:{lo:-1000,hi:1000,source:'firmware'},events:[{t:10,tS:10,t1S:10.2,seconds:0.2,phase:'flight',with:[]} ]});
    const rescue = finding('T15',{module:'rescue',axis:'yaw',profile:1,value:100,peak:120,base:20,atLimitS:0.2});
    for (const f of [tail,servo,rescue]) {
        const r = only(run([f,limit]),f.id);
        assert.match(r.text,/Do not increase headspeed as a tail (?:change|correction) before you correct that limit/);
        assert.match(r.text,/If oscillation starts first/);
        noCommands([r]);
    }
    assert.doesNotMatch(only(run([tail,{...limit,profile:2}]),'T8').text,/governor also reports an output limit/,
        'one PID profile cannot establish a throttle limit on a different profile');
});

test('audit G4/G9: numeric significance and an identified governor term are necessary for a decrease', () => {
    const onset=finding('G4',{module:'gov',value:0.06,se:0.005,text:'overshoot on collective rises (load onset): F too high (GOVT)'});
    assert.deepEqual(only(run([onset]),'G4').cli,['profile 0','set gov_f_gain = 0']);
    for (const se of [null,-0.01,0.03]) noCommands([only(run([{...onset,se}]),'G4')]);
    for (const [band,parameter,from,to] of [['P-type','gov_p_gain',40,32],['I-type','gov_i_gain',50,40]]) {
        const f=finding('G9',{module:'gov',value:12,se:1,text:`oscillation (${band})`});
        const accepted=only(run([f]),'G9');
        assert.deepEqual([accepted.parameter,accepted.from,accepted.to],[parameter,from,to]);
        assert.deepEqual(accepted.cli,['profile 0',`set ${parameter} = ${to}`]);
        for (const se of [null,-1,5]) noCommands([only(run([{...f,se}]),'G9')]);
    }
    const unknown=only(run([finding('G9',{module:'gov',value:12,se:1,text:'oscillation, band not identified'})]),'G9');
    assert.equal(unknown.parameter,null);
    assert.match(unknown.text,/frequency band is unknown/);
    noCommands([unknown]);
});

test('audit C14: measured tracking evidence does not substitute for a significant compensation-gain estimate', () => {
    const f=finding('C14',{module:'more',axis:'pitch',value:100,se:5,gainChange:30,gainChangeSe:8});
    const good=only(run([f]),'C14');
    assert.deepEqual([good.from,good.to],[50,60]);
    assert.ok(good.cli.length);
    for (const over of [{gainChange:null},{gainChangeSe:null},{gainChange:15,gainChangeSe:3},{gainChange:5,gainChangeSe:1},
        {gainChange:-15,gainChangeSe:3}]) {
        const r=only(run([{...f,...over}]),'C14');
        assert.equal(r.severity,'check');
        assert.match(r.text,/gain change estimate is not sufficient by 2 SE/);
        noCommands([r]);
    }
    const lower=only(run([{...f,gainChange:-30}]),'C14');
    assert.deepEqual([lower.from,lower.to],[50,40]);
    assert.ok(lower.cli.length);
});

test('audit G5: a censored recovery is a lower bound and cannot authorize a P trial', () => {
    const f=finding('G5',{module:'gov',value:2,se:0.1,governorResponse:{censored:1}});
    const r=only(run([f]),'G5');
    assert.equal(r.parameter,null);
    assert.match(r.text,/mean time to the target is a minimum of/);
    noCommands([r]);
    const observed=only(run([{...f,governorResponse:{censored:0}}]),'G5');
    assert.deepEqual(observed.cli,['profile 0','set gov_p_gain = 50']);
    const mixed=only(run([{...f,value:2,se:0.1,governorResponse:{censored:0}},
        {...f,fid:'censored-note',log:1,severity:'note',value:1.8,se:0.1,governorResponse:{censored:1}}]),'G5');
    assert.equal(mixed.parameter,null,'a censored non-flag result still contributes to the pooled estimate');
    assert.match(mixed.text,/mean time to the target is a minimum of/);
    noCommands([mixed]);
});

test('audit G1 overlap: coincident overload cannot unlock a quantified governor change', () => {
    const rpm=finding('G1',{module:'gov',profile:null,value:1,times:[10],text:'1 FALLBACK entry at 10 s (0.2 s long)'});
    const overload=finding('G20',{module:'rescue',profile:null,severity:'note',value:1,events:[{kind:'overload',start:10}]});
    const governor=finding('G3',{module:'gov',value:0.07,se:0.005,governorResponse:{
        unsaturated:{mean:0.07,se:0.005,n:10},saturated:{mean:null,se:null,n:0},feedforward:{mean:0.3,se:0.01,n:10}}});
    const out=run([rpm,overload,governor]);
    const rec=only(out,'G3');
    assert.ok(out.recommendations.some(r=>r.id==='G1'&&r.severity==='check'));
    assert.ok(out.recommendations.some(r=>r.id==='G1:overload'&&r.severity==='watch'));
    assert.match(rec.blockedBy.join(' '),/G1/);
    noCommands([rec]);
    const rescue=finding('G19',{module:'rescue',value:-0.15,overload:true,leave:'FALLBACK',throttleMax:1000,
        events:[{t:9.8,t1:11,tS:9.8,value:-0.15,bad:true,leaveT:10,overload:{t:9.5,untilT:10.1,fall:0.1}}]});
    const ceiling=finding('L1',{module:'limits',channel:'throttle',value:1,n:1,longestS:1,
        events:[{t:9.5,t1:10.5,tS:9.5,t1S:10.5,seconds:1,phase:'flight',with:[]}]});
    const simultaneous=run([rpm,rescue,ceiling,governor]);
    for (const r of simultaneous.recommendations.filter(r=>/^G1(?::|$)/.test(r.id))) {
        const k22=r.causes.find(c=>c.rule==='K22');
        assert.ok(k22,r.id);
        assert.equal(k22.holds,false,'Coincident governor problems are context, not a prerequisite for examining RPM.');
    }
    const stillBlocked=only(simultaneous,'G3');
    assert.match(stillBlocked.blockedBy.join(' '),/G1/);
    noCommands([stillBlocked]);
});

test('audit T7 and T13 reciprocal evidence holds the numeric change while keeping the trim diagnosis available', () => {
    const output=run([finding('T7',{value:0.8,se:0.05,precompScale:1.44}),
        finding('T13',{module:'more',value:0.25,se:0.02})]);
    const precomp=only(output,'T7'),trim=only(output,'T13');
    assert.equal(precomp.severity,'action');
    assert.equal(trim.severity,'check');
    assert.ok(precomp.causes.some(c=>c.rule==='K8'&&c.ids.includes('T13')&&c.holds));
    assert.ok(trim.causes.some(c=>c.rule==='K9'&&c.ids.includes('T7')));
    assert.match(trim.text,/constant|hover/);
    assert.doesNotMatch(trim.text,/This change must wait/);
    noCommands([precomp,trim]);
});

// A complete numeric fixture exercises tune(), not only a manufactured result.
// The recorded gyro is the known firmware response to the raw samples.
function replayFixture(n=100000) {
    const FT = require('../tools/autotune/filter_tune.cjs'), R = require('../tools/autotune/filter_replay.cjs');
    const gear={main:[1,1],tail:[1,4],motorisedTail:false};
    const h={...HEADER,looptime:1000,pid_process_denom:1,filter_process_denom:1,frameIntervalPNum:1,frameIntervalPDenom:1,
        features:0,gyro_notch_hz:[0,0],gyro_notch_cutoff:[0,0],gyro_rpm_notch_preset:1,gyro_rpm_notch_min_hz:20,
        dyn_notch_count:2,dyn_notch_q:50,dyn_notch_min_hz:80,dyn_notch_max_hz:350,
        rollBW:[100,35],pitchBW:[100,35],yawBW:[100,35],rollPID:[50,100,15],pitchPID:[50,100,15],yawPID:[50,100,15]};
    const zeros=()=>[0,1,2].map(()=>new Float64Array(n));
    const raw=[0,1,2].map(a=>Float64Array.from({length:n},(_,i)=>10*Math.sin(2*Math.PI*13*i/1000+a)+8*Math.sin(2*Math.PI*187*i/1000+a)));
    const seg={n,raw,hs:new Float64Array(n).fill(3000)}, cfg=FT.config(h,{gear});
    const gyro=R.run(cfg,seg,Array(3).fill({gyro_cutoff:100,d_cutoff:35,Kp:1,Kd:1})).y;
    const item={w:{...seg,rate:1000,fromS:0,profileAt:new Uint8Array(n).fill(1),gyro,sp:zeros(),u:zeros(),P:zeros(),I:zeros(),
        D:zeros(),F:zeros(),B:zeros(),O:zeros(),coll:new Float64Array(n),extra:Object.fromEntries(raw.map((x,a)=>[`gyroRAW[${a}]`,x])),
        flight:{file:'audit-fixture',log:0,firmware:'Rotorflight 4.6.0 (118e912)',craft:'audit-fixture',header:h,actualRate:1000,rate:1000}},
        mask:new Uint8Array(n).fill(1),flight:true,armingProfile:1};
    return {item,gear};
}

test('audit numeric filter path: recorded replay passes without a target; a bounded edited target still needs its delay check', () => {
    const {item,gear}=replayFixture(), prepared=filter.prepare([item],{gear});
    const simulate=(params,maxAddMs=0.5)=>filter.tune([item],{gear,prepared,simulate:params,maxAddMs,curves:false});
    const baseline=simulate({});
    assert.equal(baseline.model.passed,true);
    assert.equal(baseline.recommended.status,'recommended');
    assert.deepEqual(baseline.recommended.params,{});
    assert.equal(baseline.recommended.predicted.totalDb,0);
    assert.equal(filter.cliFile(baseline),'');
    const changed=simulate({gyro_lpf1_static_hz:90});
    assert.equal(changed.recommended.status,'not recommended','noise reduction alone cannot clear the original RPM-coverage problem');
    assert.ok(changed.recommended.predicted.totalDb<0);
    assert.ok(changed.recommended.delay.maxAddMs>0);
    assert.match(changed.recommended.reasons.join(' '),/does not correct or decrease a measured filter problem/);
    assert.equal(filter.cliFile(changed),'');
    const tooSlow=simulate({gyro_lpf1_static_hz:90},0);
    assert.equal(tooSlow.recommended.status,'not recommended');
    assert.ok(tooSlow.recommended.reasons.some(s=>/time delay, control-band or vibration limits/.test(s)));
    assert.equal(filter.cliFile(tooSlow),'');
    const again=simulate({});
    assert.equal(again.recommended.predicted.totalDb,0,'manual targets never alter the recorded base');
    assert.deepEqual(again.recommended.params,{});
});

test('audit numeric filter refusal: search with no improved candidate, unsupported firmware and excluded input stay visible', () => {
    const {item,gear}=replayFixture(), prepared=filter.prepare([item],{gear});
    const search=filter.tune([item],{gear,prepared,maxCandidates:1,budgetMs:10000,curves:false});
    assert.equal(search.model.passed,true);
    assert.equal(search.recommended.status,'not recommended');
    assert.ok(search.recommended.reasons.some(s=>/No filter set in the analysis decreases vibration by 3 dB/.test(s)));
    assert.equal(filter.cliFile(search),'');
    prepared.segments[0].unsupported=true;
    const unknown=filter.tune([item],{gear,prepared,simulate:{},curves:false});
    assert.equal(unknown.model.passed,false);
    assert.ok(unknown.recommended.reasons.some(s=>/firmware version/.test(s)));
    prepared.segments[0].unsupported=false;
    prepared.excluded.push({log:0,reason:'A selected flight period has missing input.'});
    const missing=filter.tune([item],{gear,prepared,simulate:{},curves:false});
    assert.equal(missing.model.passed,false);
    assert.ok(missing.recommended.reasons.some(s=>/flight periods not used/.test(s)));
    assert.equal(filter.cliFile(missing),'');
});

test('audit numeric filter search: noise improvements and a passing holdout cannot bypass an unresolved filter check', () => {
    const {item,gear}=replayFixture(), prepared=filter.prepare([item],{gear}), progress=[];
    const result=filter.tune([item],{gear,prepared,maxAddMs:3,maxCandidates:60,budgetMs:120000,curves:false,
        progress:(text,fraction)=>progress.push({text,fraction})});
    assert.equal(result.model.passed,true);
    assert.equal(result.recommended.status,'not recommended');
    assert.match(result.recommended.reasons.join(' '),/does not correct or decrease a measured filter problem/);
    assert.ok(result.search.tested>60,'the search refines a promoted candidate');
    assert.ok(result.search.finalistCount>0);
    assert.ok(result.recommended.predicted.totalDb<=-3);
    assert.ok(result.recommended.predicted.totalDb+2*result.recommended.predicted.se<0);
    assert.ok(result.recommended.delay.maxAddMs<=3);
    assert.equal(result.recommended.validation.holdout.selectedBeforeHoldout,true);
    assert.equal(result.recommended.validation.holdout.passed,true);
    assert.equal(result.recommended.validation.holdout.withinLimits,true);
    assert.ok(progress.some(p=>/replayed.*filter sets/.test(p.text)));
    assert.ok(progress.every(p=>p.fraction>=0&&p.fraction<=1));
    const recs=filterOut(result), direct=filter.cliFile(result), shared=advice.exportScript(recs,null,{});
    assert.ok(recs.every(r=>r.severity==='check'&&!r.cli.length));
    assert.equal(direct,'');
    assert.doesNotMatch(shared,/^(?:set |feature |profile |rateprofile |save$)/m);
    assert.match(filter.texts(result).validation,/selects the values with the other periods/);
});

test('audit numeric filter refusal: parity, sample coverage, craft identity and recorded-value authority each reject a target', () => {
    const scenarios=[
        ['parity',100000,({item})=>{for(const y of item.w.gyro) for(let i=0;i<y.length;i++)y[i]*=2;},/does not agree with the replay/],
        ['coverage',14000,()=>{},/not sufficient flight periods/],
        ['unrecorded',100000,({item})=>{delete item.w.flight.header.gyro_lowpass2_hz;},/not recorded/],
        ['firmware range',100000,fixture=>{fixture.item.w.flight.header.gyro_lowpass2_hz=1001;fixture.simulate={};},/out of the firmware CLI range/],
        ['mixed craft',100000,fixture=>{const {item}=fixture;fixture.other={...item,w:{...item.w,flight:{...item.w.flight,log:1,craft:'another helicopter'}}};},/more than one helicopter/]
    ];
    for(const [label,n,mutate,reason] of scenarios) {
        const fixture=replayFixture(n);mutate(fixture);
        const {item,gear,other}=fixture;
        const result=filter.tune(other?[item,other]:[item],{gear,simulate:fixture.simulate||{gyro_lpf1_static_hz:90},maxAddMs:0.5,curves:false});
        assert.equal(result.recommended.status,'not recommended',label);
        assert.ok(result.recommended.reasons.some(s=>reason.test(s)),`${label}: ${result.recommended.reasons.join(' ')}`);
        assert.equal(filter.cliFile(result),'',label);
        noCommands(filterOut(result));
    }
});
