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
        i=>{i.analysis.advice.byDataset.A[0].blockedBy=['filters'];}, i=>{i.analysis.advice.byDataset.A[0].causes=[{holds:true}];},
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
    recs[1].blockedBy=['filters'];assert.equal(CT.tune(i).recommendations.length,0);
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
    assert.equal(CT.flightPlan([recommendation({blockedBy:['filters']})]).maneuvers.length,0);
});
