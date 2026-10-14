'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const CT = require('../tools/autotune/control_tune.cjs');
const advice = require('../tools/autotune/advice.cjs');

function recommendation(over = {}) {
    const name = over.parameter || 'roll_p_gain', from = over.from === undefined ? 50 : over.from, to = over.to === undefined ? 55 : over.to;
    return Object.assign({ id: name, node: 'cyclic', area: 'cyclic', dataset: 'A', scope: 'profile', profile: 1, cliProfile: 0,
        axis: 'roll', severity: 'action', parameter: name, from, to, fromSource: 'log header', title: 'Increase the roll P gain',
        cli: ['profile 0', `set ${name} = ${to}`], rule: 'The change is less than the step limit.', blockedBy: [], causes: [],
        evidence: [{id:'C6',fid:'c6',value:30,se:2,unit:'deg/s',profile:1}], confidence: 'measured' },over);
}
function input(recs = [recommendation()]) {
    return { configuration: 'A', step: 'cyclic', analysis: { datasets: { datasets: [
        { id:'A',pidProfile:1,analysed:true,analysedFlightSeconds:120,values:Object.fromEntries(recs.map(r=>[r.parameter,r.from])),sources:{} },
        { id:'B',pidProfile:2,analysed:true,analysedFlightSeconds:120,values:{roll_p_gain:100},sources:{} }
    ] }, advice: {byDataset:{A:recs,B:[]}},decisions:[] } };
}
test('control autotune selects one atomic change in rule order and never clears a measured problem', () => {
    const i = input([recommendation(),recommendation({id:'d',parameter:'roll_d_gain',from:20,to:22})]), before=JSON.stringify(i);
    const out=CT.tune(i);
    assert.equal(JSON.stringify(i),before,'pure input');
    assert.equal(out.recommendations.length,1);
    assert.equal(out.rows[0].name,'roll_p_gain');
    assert.equal(out.rows[0].delta,5);
    assert.equal(out.status,'flight-test-required');
    assert.equal(out.verifiedInFlight,false);
    assert.equal(out.prediction,null,'no invented after-response for a rule-based change');
    assert.match(out.deferred[0].reason,/Test the selected change/);
    assert.match(out.recommendations[0].rule,/actuator/);
    assert.equal(out.flightPlan.maneuvers[0].profile,1);
    assert.match(out.flightPlan.maneuvers[0].instructions.join(' '),/roll stick/);
});
test('profile, flight, source, gate, cause, evidence, range and CLI checks fail closed', () => {
    const edits = [
        i=>{i.configuration='unknown';}, i=>{i.analysis.datasets.datasets[0].pidProfile=0;},
        i=>{i.analysis.datasets.datasets[0].analysedFlightSeconds=0;}, i=>{i.analysis.datasets.datasets[0].analysed=false;},
        i=>{delete i.analysis.advice.byDataset.A;}, i=>{i.analysis.datasets.datasets[0].values.roll_p_gain=100;},
        i=>{i.analysis.advice.byDataset.A[0].profile=2;}, i=>{i.analysis.advice.byDataset.A[0].dataset='B';},
        i=>{i.analysis.advice.byDataset.A[0].blockedBy=['Correct the filters first.'];}, i=>{i.analysis.advice.byDataset.A[0].causes=[{holds:true}];},
        i=>{i.analysis.advice.byDataset.A[0].evidence=[];}, i=>{i.analysis.advice.byDataset.A[0].rule='';},
        i=>{i.analysis.advice.byDataset.A[0].to=1001;}, i=>{i.analysis.advice.byDataset.A[0].to=55.5;},
        i=>{i.analysis.advice.byDataset.A[0].to=70;}, i=>{i.analysis.advice.byDataset.A[0].cli=[];},
        i=>{i.analysis.advice.byDataset.A[0].cli.push('set yaw_p_gain = 1');}, i=>{i.analysis.advice.byDataset.A[0].severity='watch';}
    ];
    for(const edit of edits){const i=input();edit(i);const out=CT.tune(i);assert.deepEqual(out.recommendations,[],String(edit));assert.equal(out.verifiedInFlight,false);}
});
test('joint gain candidates are indivisible and predictions require the exact evaluated values', () => {
    const recs=[recommendation({group:'g',groupSize:2}),recommendation({parameter:'roll_d_gain',from:20,to:22,group:'g',groupSize:2})];
    for(const r of recs){r.confidence='predicted';r.evidence=[{id:'C7',fid:'model',value:5,se:1}];}
    const i=input(recs), d={fid:'model',dataset:'A',axis:'roll',change:true,gates:{V1:{pass:true},V2a:{pass:true},V2b:{pass:true},V3:{pass:true}},
        changes:[{gain:'P',from:50,to:55},{gain:'D',from:20,to:22}],tracking:[20,15],dTrack:5,seTrack:1,validBand:[1,15],flights:3};
    i.analysis.decisions=[d];
    let out=CT.tune(i);assert.equal(out.recommendations.length,2);assert.deepEqual(out.prediction.tracking,[20,15]);
    d.gates.V3.pass=false;assert.equal(CT.tune(i).prediction,null,'failed model gate');
    d.gates.V3.pass=true;
    d.changes[1].to=21.8;assert.equal(CT.tune(i).prediction,null,'rounded values are not the exact modeled candidate');
    d.changes[1].to=22;d.dataset='B';assert.equal(CT.tune(i).prediction,null,'other configuration');
    recs[1].blockedBy=['Correct the filters first.'];assert.equal(CT.tune(i).recommendations.length,0);
    recs.pop();assert.equal(CT.tune(i).recommendations.length,0,'missing group member');
});
test('repeated autotune retains the recorded base and current-value caveats reach the CLI', () => {
    const i=input([recommendation({stale:{text:'The values come from the log header.',source:'Log header',reasons:['rearm']}})]);
    const first=CT.tune(i), second=CT.tune(i);assert.deepEqual(first,second);
    assert.equal(first.rows[0].from,50);assert.ok(first.rows[0].stale);
    const bundle=advice.exportScript(first.recommendations,null,{},true);
    assert.match(bundle.text,/set roll_p_gain = 55/);assert.match(bundle.text,/Values possibly different/);
    assert.match(bundle.text,/Next flight: flight test necessary/);assert.match(bundle.text,/roll stick/);
    assert.equal(bundle.flightPlan.maneuvers.length,1);
});
test('maneuvers match selected parameters, deduplicate by profile and stay out of unselected exports', () => {
    const gov=recommendation({id:'gov',node:'governor',parameter:'gov_f_gain',from:10,to:20}),
        coll=recommendation({id:'coll',node:'tailcomp',axis:'yaw',parameter:'yaw_collective_ff_gain',from:50,to:55}),
        roll=recommendation({id:'roll',parameter:'roll_f_gain',from:100,to:110}),
        stop=recommendation({id:'stop',node:'tailcomp',axis:'yaw',parameter:'yaw_cw_stop_gain',from:120,to:132});
    const plan=CT.flightPlan([gov,coll,roll,stop]);
    assert.equal(plan.maneuvers.length,3);
    assert.equal(plan.maneuvers.find(q=>q.key==='1:collective').parameters.length,2);
    assert.match(plan.maneuvers[0].instructions.join(' '),/full positive collective/);
    assert.match(plan.maneuvers.find(q=>q.key==='1:roll-rate').instructions.join(' '),/70 % roll stick/);
    assert.match(plan.maneuvers.find(q=>q.key==='1:yaw-steps').instructions.join(' '),/each direction/);
    const exported=advice.exportScript([gov,coll,roll,stop],['stop'],{},true);
    assert.equal(exported.flightPlan.maneuvers.length,1);assert.equal(exported.flightPlan.maneuvers[0].key,'1:yaw-steps');
    assert.doesNotMatch(exported.text,/full positive collective/);
    assert.deepEqual(advice.exportScript([gov],[],{},true).flightPlan.maneuvers,[]);
    const p2={...stop,id:'p2',profile:2,cliProfile:1,cli:['profile 1','set yaw_cw_stop_gain = 132']};
    assert.equal(CT.flightPlan([stop,p2]).maneuvers.length,2);
});
test('flight plan covers each supported control parameter family and refuses blocked or incomplete export groups', () => {
    for(const [node,parameter,axis] of [['cycomp','pitch_collective_ff_gain','pitch'],['cycomp','cyclic_cross_coupling_gain','roll'],
        ['tailcomp','yaw_cyclic_ff_gain','yaw'],['tailcomp','yaw_inertia_precomp_gain','yaw'],['tailcomp','gov_tta_gain','yaw'],
        ['tail','yaw_f_gain','yaw'],['cyclic','pitch_f_gain','pitch']]) {
        const r=recommendation({node,parameter,axis});const plan=CT.flightPlan([r]);assert.ok(plan.maneuvers.length,parameter);
        assert.ok(plan.preparation.length && plan.followup.length);
    }
    const r=recommendation({group:'joint',groupSize:2});
    assert.equal(advice.exportScript([r],null,{},true).flightPlan.maneuvers.length,0);
    assert.equal(CT.flightPlan([recommendation({blockedBy:['Correct the filters first.']})]).maneuvers.length,0);
});

test('blocked control changes keep numeric proposals and concrete prerequisite changes out of Export', () => {
    const r=recommendation({parameter:'pitch_f_gain',from:100,to:90,axis:'pitch',cli:[],
        blockedBy:['The filter change comes first.'],gate:{held:['filters']},
        evidence:[{id:'C4',fid:'stops',value:25.7,se:2.9,unit:'%',threshold:10}]});
    const i=input([r]);
    i.analysis.advice.byDataset.A.push({id:'filter',node:'filters',dataset:'A',severity:'action',scope:'global',
        parameter:'gyro_lpf1_static_hz',from:0,to:100,cli:['set gyro_lpf1_static_hz = 100'],
        evidence:[{id:'F1',value:0}],text:'Set the gyro low-pass filter to 100 Hz.'});
    const out=CT.tune(i);
    assert.equal(out.status,'prerequisites-required');
    assert.equal(out.proposals.length,1);assert.deepEqual([out.proposals[0].row.from,out.proposals[0].row.to],[100,90]);
    assert.equal(out.proposals[0].evidence[0].se,2.9);
    assert.equal(out.prerequisites[0].to,100);
    assert.deepEqual(out.recommendations,[]);assert.deepEqual(out.rows,[]);
    assert.deepEqual(out.proposals[0].cli,[]);assert.equal(out.prediction,null);
    assert.deepEqual(advice.defaultPicks(out.proposals),[]);
    assert.doesNotMatch(advice.exportScript(out.proposals,null,{}),/set pitch_f_gain/);
    r.gate=null;r.holds=['filters'];
    assert.equal(CT.tune(i).prerequisites[0].to,100,'a guard prerequisite remains visible without a direct hierarchy gate');
    const diagnostic=input([{...r,severity:'check',parameter:null,from:null,to:null}]);
    diagnostic.analysis.advice.byDataset.A.push(i.analysis.advice.byDataset.A[1]);
    const next=CT.tune(diagnostic);
    assert.equal(next.status,'prerequisites-required');
    assert.equal(next.prerequisites[0].to,100,'an upstream change is useful even without an identified gain target');
    assert.deepEqual(next.recommendations,[]);assert.deepEqual(next.proposals,[]);
    r.to=80;r.from=200;assert.equal(CT.tune(i).proposals.length,0,'inconsistent base cannot be a proposal');
});

test('control accepts a justified zero compensation start but not an oversized one', () => {
    const i=input([recommendation({node:'cycomp',parameter:'pitch_collective_ff_gain',axis:'pitch',from:0,to:10})]);
    i.step='cycomp';
    assert.equal(CT.tune(i).rows[0].to,10);
    const r=i.analysis.advice.byDataset.A[0];r.to=11;r.cli[1]='set pitch_collective_ff_gain = 11';
    assert.deepEqual(CT.tune(i).recommendations,[]);
});

test('output limits retain the diagnosis without inventing a gain or corrective experiment', () => {
    for(const [step,id] of [['governor','G6'],['cyclic','C2'],['tailcomp','T8']]) {
        const r=recommendation({node:step,parameter:null,severity:'check',cli:[],
            evidence:[{id,fid:'limit',value:2.5,unit:'s'}]});
        const i=input([r]);i.step=step;
        const out=CT.tune(i);
        assert.equal(out.status,'diagnosis-required');assert.equal(out.experiments.length,0);
        assert.match(out.reason,/problem is not corrected/);
        assert.equal(out.guidance[0].evidence[0].value,2.5);
        assert.deepEqual(out.recommendations,[]);
        r.severity='watch';assert.equal(CT.tune(i).experiments.length,0);
    }
});
