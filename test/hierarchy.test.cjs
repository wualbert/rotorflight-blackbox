'use strict';

// tools/autotune/hierarchy.cjs: the prerequisites and the tuning blocks (SPEC3 A, B, K1), the K rules and the status of every item.
//   node --test test/hierarchy.test.cjs
// The status fixtures are the flags and the recommendation severities of two real results of the integration run
// (Gaui X4 #58 and Fireball 2026-09-29 #3, impl/INT/out g58.json and fb3.json), cut to what the status reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../tools/autotune/hierarchy.cjs');
const C = require('../tools/autotune/catalog.cjs');

const ids = (list) => list.map(n => n.id);
const byId = new Map(H.NODES.map(n => [n.id, n]));
const before = (a, b) => H.bySequence(a, b) < 0;
const PREREQ = ['logging', 'rpm', 'power', 'mechanics', 'rescue', 'controller'], BLOCKS = ['filters', 'governor', 'cyclic', 'tail', 'cycomp', 'tailcomp'];

// a simple local STE check: no semicolons, no Latin abbreviations, no contractions, no math in running text, and a
// sentence length of 25 words or fewer (20 for an instruction: a sentence that starts with a verb of this list)
const VERBS = new Set(['add', 'adjust', 'balance', 'calibrate', 'correct', 'decrease', 'do', 'examine', 'find', 'fly', 'increase', 'install', 'keep', 'load', 'make', 'measure', 'prepare',
    'read', 'record', 'remove', 'repair', 'set', 'tune', 'try', 'turn', 'use', 'then', 'for']);
function steProblems(text, what) {
    const out = [], t = String(text).replace(/`[^`]*`/g, 'Q').replace(/"[^"]*"/g, 'Q');
    if (/;/.test(t)) out.push('semicolon');
    if (/\b(e\.g|i\.e|etc|vs)\b\.?/i.test(t)) out.push('Latin abbreviation');
    if (/n't\b|'(re|ve|ll)\b/i.test(t)) out.push('contraction');
    if (/\+-|>=|<=|->|!=/.test(t)) out.push('math in text');
    if (/\b(above|below|over|under) (\d|the limit)/i.test(t)) out.push('above/below for a limit');
    const body = t.replace(/\([^)]*\)/g, 'P');
    for (const s of body.split(/(?<=[.!?:])\s+(?=[A-Z0-9Q])/)) {
        const words = s.replace(/(\d)\s+(%|Hz|kHz|ms|s|deg\/s|V|dB|rpm|x)\b/g, '$1$2').replace(/\d[\d.]*\s*±\s*\d[\d.]*/g, 'N').split(/\s+/).filter(w => /[A-Za-z0-9±%]/.test(w));
        const first = (s.replace(/^(If|When|Before|After|While|For|At|In)\b[^,]*,\s*/, '').split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z]/g, '');
        const max = VERBS.has(first) ? 20 : 25;
        if (words.length > max) out.push(`${words.length} words (${max} max): ${s}`);
    }
    return out.map(p => `${what}: ${p} -- ${text}`);
}

test('graph (K1): the prerequisite band and the tuning blocks, parameters only; unique ids; known edge kinds', () => {
    assert.deepEqual(ids(H.PREREQ), PREREQ); assert.deepEqual(ids(H.BLOCKS), BLOCKS);
    assert.deepEqual(ids(H.NODES), PREREQ.concat(BLOCKS)); assert.equal(new Set(ids(H.NODES)).size, 12);
    const G = H.graph();
    assert.deepEqual(Object.keys(G).sort(), ['blocks', 'edges', 'nodes', 'prereq', 'rules']);
    for (const p of G.prereq) { for (const k of ['id', 'title', 'about', 'checks', 'params', 'gates']) assert.ok(p[k] !== undefined, `${p.id} ${k}`); assert.equal(p.kind, 'prereq'); }
    for (const b of G.blocks) { for (const k of ['id', 'title', 'about', 'lane', 'order', 'params', 'checks']) assert.ok(b[k] !== undefined, `${b.id} ${k}`); assert.equal(b.kind, 'block'); }
    assert.deepEqual(G.blocks.map(b => [b.id, b.lane, b.order]), [['filters', 'main', 1], ['governor', 'main', 2], ['cyclic', 'cyclic', 3], ['tail', 'tail', 3], ['cycomp', 'cyclic', 4], ['tailcomp', 'tail', 4]]);
    assert.equal(G.rules.length, 27); assert.equal(G.edges.length, H.EDGES.length);
    for (const e of G.edges) { assert.ok(e.text && e.text === e.why && e.source, `${e.from}>${e.to}`); }
    // the titles of SPEC3 B: one governor block, the tail authority written out, no measurement and no rates step
    assert.deepEqual(G.blocks.map(b => b.title), ['Filters', 'Governor', 'Cyclic gains', 'Tail gains', 'Cyclic compensation', 'Tail compensation and authority']);
    assert.deepEqual(G.prereq.map(b => b.title), ['Blackbox log', 'RPM signal and motor poles', 'Battery and power', 'Mechanical parts', 'Rescue', 'Flight controller']);
    for (const n of H.NODES) assert.ok(!/^(Examine|Measure|Calibrate|Set the rates|Set the TTA)/.test(n.title) && !/\bTTA\b/.test(n.title + n.about), n.title);
    // a block is a set of firmware parameters (names of the 4.6 settings), and every block has some
    const blk = (id) => byId.get(id).params;
    for (const b of H.BLOCKS) assert.ok(b.params.length >= 5 && b.params.every(p => typeof p === 'string' && p), b.id);
    for (const p of ['gyro_lpf1_static_hz', 'gyro_rpm_notch_q_roll', 'dyn_notch_count', 'roll_d_cutoff']) assert.ok(blk('filters').includes(p), p);
    for (const p of ['gov_mode', 'gov_headspeed', 'gov_max_throttle', 'gov_handover_throttle', 'gov_spoolup_time', 'gov_use_voltage_comp', 'gov_f_gain', 'gov_i_gain', 'gov_p_gain', 'gov_d_gain', 'gov_gain', 'gov_collective_ff_weight', 'gov_cyclic_ff_weight', 'gov_yaw_ff_weight'])
        assert.ok(blk('governor').includes(p), p);
    assert.ok(!blk('governor').some(p => /tta/.test(p)), 'the tail torque assist is not a governor parameter here');
    assert.deepEqual(blk('cyclic').filter(p => /^pitch_/.test(p)), ['pitch_d_gain', 'pitch_p_gain', 'pitch_i_gain', 'pitch_f_gain', 'pitch_b_gain', 'pitch_o_gain']);
    assert.deepEqual(blk('tail'), ['yaw_d_gain', 'yaw_p_gain', 'yaw_i_gain', 'yaw_f_gain', 'yaw_b_gain']);
    for (const p of ['pitch_collective_ff_gain', 'cyclic_cross_coupling_gain', 'iterm_relax_cutoff', 'swash_phase']) assert.ok(blk('cycomp').includes(p), p);
    for (const p of ['yaw_collective_ff_gain', 'yaw_cyclic_ff_gain', 'yaw_precomp_cutoff', 'yaw_inertia_precomp_gain', 'yaw_cw_stop_gain', 'yaw_ccw_stop_gain', 'mixer input SY', 'gov_tta_gain', 'gov_tta_limit', 'gov_tta_filter', 'swash_tta_precomp'])
        assert.ok(blk('tailcomp').includes(p), p);
    assert.ok(byId.get('tailcomp').chips.some(c => c.label === 'Tail torque assist') && byId.get('tailcomp').chips.some(c => c.label === 'Tail authority'));
    for (const p of ['rescue_mode', 'rescue_pull_up_collective']) assert.ok(byId.get('rescue').params.includes(p), p);
    for (const n of H.NODES) { assert.ok(n.docs.length >= 1, n.id); for (const d of n.docs) { assert.match(d.url, /^https:\/\/rotorflight\.org\/docs\/[\w./-]+$/, d.url); assert.ok(d.title); } }
    // edges
    const kinds = { gate: 0, order: 0, cause: 0, validity: 0 };
    for (const e of H.EDGES) { assert.ok(byId.has(e.from) && byId.has(e.to), `${e.from} -> ${e.to}`); assert.ok(e.kind in kinds, e.kind); kinds[e.kind]++;
        if (e.kind === 'validity') assert.deepEqual(e.when, ['D1']); }
    assert.deepEqual(kinds, { gate: 9, order: 6, cause: 2, validity: 4 });
    assert.equal(new Set(H.EDGES.map(e => `${e.from}>${e.to}`)).size, H.EDGES.length, 'one edge for each pair');
    // the gates of each prerequisite are its gate and validity edges, and no edge goes into a prerequisite
    for (const p of H.PREREQ) assert.deepEqual(H.EDGES.filter(e => e.from === p.id && (e.kind === 'gate' || e.kind === 'validity')).map(e => e.to).sort(), p.gates.slice().sort(), p.id);
    assert.ok(!H.EDGES.some(e => H.isPrereq(e.to)), 'the prerequisites are assumed correct: nothing gates them');
    // the old ids go to a new one
    assert.deepEqual(Object.keys(H.LEGACY).sort(), ['cyclic', 'cycomp', 'dnoise', 'gears', 'govgain', 'govset', 'log', 'lowpass', 'mixer', 'notches', 'rates', 'rescue', 'result', 'rotor', 'rpm', 'servos', 'setup', 'tail', 'tailcomp', 'tailmech', 'tta']);
    for (const v of Object.values(H.LEGACY)) assert.ok(byId.has(v), v);
    assert.deepEqual([H.LEGACY.tailmech, H.LEGACY.govset, H.LEGACY.govgain, H.LEGACY.dnoise, H.LEGACY.tta, H.LEGACY.rates], ['tailcomp', 'governor', 'governor', 'filters', 'tailcomp', 'controller']);
});

test('sequence: the gate, order and validity edges go forward; the one back edge is the tail authority (K rules only); no gate cycle', () => {
    for (const e of H.EDGES.filter(x => x.kind !== 'cause')) assert.ok(before(e.from, e.to), `${e.from} -> ${e.to}`);
    const back = H.EDGES.filter(e => !before(e.from, e.to));
    assert.deepEqual(back.map(e => [e.from, e.to, e.kind, !!e.viaRules]), [['tailcomp', 'tail', 'cause', true]]);
    const out = new Map(H.NODES.map(n => [n.id, []])); for (const e of H.EDGES.filter(x => x.kind === 'gate')) out.get(e.from).push(e.to);
    const state = new Map(), visit = (id, path) => { if (state.get(id) === 1) assert.fail(`cycle: ${path.concat(id).join(' -> ')}`); if (state.get(id) === 2) return;
        state.set(id, 1); for (const v of out.get(id)) visit(v, path.concat(id)); state.set(id, 2); };
    for (const n of H.NODES) visit(n.id, []);
});

test('gateUpstream: the gate edges, transitive, in sequence (the prerequisites first)', () => {
    for (const p of PREREQ) assert.deepEqual(H.gateUpstream(p), [], p);
    assert.deepEqual(H.gateUpstream('filters'), ['rpm']);
    assert.deepEqual(H.gateUpstream('governor'), ['rpm', 'power']);
    assert.deepEqual(H.gateUpstream('cyclic'), ['rpm', 'mechanics', 'controller', 'filters']);
    assert.deepEqual(H.gateUpstream('tail'), ['rpm', 'mechanics', 'controller', 'filters']);
    assert.deepEqual(H.gateUpstream('tailcomp'), []); assert.deepEqual(H.gateUpstream('cycomp'), []);
    for (const n of H.NODES) for (const u of H.gateUpstream(n.id)) assert.ok(before(u, n.id));
});

test('homes: every check id has a prerequisite or a block, and a catalog entry, and back', () => {
    const all = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'H', 'SETUP', 'R1'].concat(Array.from({ length: 11 }, (_, i) => `F${i + 1}`), Array.from({ length: 15 }, (_, i) => `G${i}`),
        Array.from({ length: 14 }, (_, i) => `C${i + 1}`), Array.from({ length: 14 }, (_, i) => `T${i + 1}`), ['D7', 'G15', 'G16', 'G17', 'G18', 'C15'],
        ['G19', 'T15', 'D8', 'G20'], ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'], ['D9', 'P1', 'P2']);
    const home = (id, a) => H.homeOf(id, a === undefined ? null : a);
    // SPEC3 A: the prerequisites
    assert.deepEqual(['D1', 'D2', 'D3', 'D4', 'H'].map(id => home(id)), Array(5).fill('logging'));
    assert.deepEqual(['G1', 'G12', 'G20'].map(id => home(id)), ['rpm', 'rpm', 'rpm']);
    assert.deepEqual(['D5', 'G13', 'G11', 'P1', 'P2'].map(id => home(id)), Array(5).fill('power'));
    assert.deepEqual(['F7', 'C15', 'T4', 'SETUP:roll_i_gain'].map(id => home(id)), Array(4).fill('mechanics'));
    assert.deepEqual(['D9', 'D8', 'D6', 'D6:excluded'].map(id => home(id)), Array(4).fill('rescue'));
    assert.deepEqual(['SETUP', 'SETUP:pid_mode', 'SETUP:rates_type', 'D7', 'R1', 'L7'].map(id => home(id)), Array(6).fill('controller'));
    // SPEC3 B: the blocks and their evidence (the measurements are evidence: D-term noise in the filters, tracking error and time delay in the gains)
    assert.deepEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F8', 'F9', 'F10', 'F11', 'C11'].map(id => home(id)), Array(11).fill('filters'));
    assert.deepEqual(['G0', 'G2', 'G3', 'G9', 'G10', 'G14', 'G15', 'G16', 'G17', 'G18', 'G19', 'L1'].map(id => home(id)), Array(12).fill('governor'));
    assert.deepEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C9', 'C12', 'C13', 'L2', 'L3'].map(id => home(id)), Array(11).fill('cyclic'));
    assert.deepEqual(['C8', 'C10', 'C14'].map(id => home(id)), Array(3).fill('cycomp'));
    assert.deepEqual(['T1', 'T2', 'T3', 'T9', 'T10', 'T11', 'T12'].map(id => home(id)), Array(7).fill('tail'));
    assert.deepEqual(['T5', 'T6', 'T7', 'T8', 'T13', 'T14', 'T15', 'L4'].map(id => home(id)), Array(8).fill('tailcomp'), 'the tail output limits are the tail authority, never a calibration');
    assert.deepEqual([['L5', 'yaw'], ['L5', null], ['L6', 'yaw'], ['L6', 'roll'], ['C7', 'yaw'], ['C7', 'pitch']].map(([id, a]) => home(id, a)), ['tailcomp', 'cyclic', 'tail', 'cyclic', 'tail', 'cyclic']);
    for (const id of all) { assert.ok(C.CHECKS[id], `catalog ${id}`); assert.ok(byId.has(home(id, id === 'C7' ? 'roll' : null)), `home of ${id}`); }
    assert.deepEqual(Object.keys(C.CHECKS).sort(), all.slice().sort(), 'the catalog has these ids and no other');
    for (const n of H.NODES) for (const c of n.checks) { const base = c.split(':')[0]; assert.ok(C.CHECKS[base], `${n.id}: ${c}`); assert.equal(home(c, /:yaw$/.test(c) ? 'yaw' : null), n.id, c); }
    const seen = new Map(); for (const n of H.NODES) for (const c of n.checks) { assert.ok(!seen.has(c), `${c} in ${seen.get(c)} and ${n.id}`); seen.set(c, n.id); }
    const cases = [['C7:yaw_p_gain:p1', null, 'tail'], ['C7:roll_d_gain:p2', null, 'cyclic'], ['T7:yaw_collective_ff_gain:p1', null, 'tailcomp'], ['D4:cli', null, 'logging'],
        ['F5:gyro_rpm_notch_source_roll:p1', null, 'filters'], ['C12:roll#2', null, 'cyclic'], ['D9:p4', null, 'rescue'], ['P1:5', null, 'power'], ['XYZ', null, null], ['ERROR', null, null]];
    for (const [id, axis, want] of cases) assert.equal(H.homeOf(id, axis), want, `${id} ${axis}`);
    for (const id of all) assert.equal(C.nodeOf({ id, axis: id === 'C7' ? 'yaw' : undefined }), home(id, id === 'C7' ? 'yaw' : null), id);
    for (const id of all) assert.equal(C.tunerOf({ id, axis: id === 'C7' ? 'yaw' : undefined }), H.isBlock(home(id, id === 'C7' ? 'yaw' : null)), `tuner ${id}`);
});

test('K rules: K1-K27 with known check ids, documented steps, sources', () => {
    assert.deepEqual(H.RULES.map(k => k.id), Array.from({ length: 27 }, (_, i) => `K${i + 1}`));
    const known = (id) => !!C.CHECKS[id];
    for (const k of H.RULES) {
        assert.ok(k.name && k.symptoms.length, k.id);
        for (const id of k.symptoms.concat(k.upstream, k.validity)) assert.ok(known(id), `${k.id}: ${id}`);
        assert.ok(Array.isArray(k.first) && k.first.length >= 1 && Array.isArray(k.source) && Array.isArray(k.confidence), k.id);
    }
    // K14 is the tail authority (SPEC3 B): the advice of T8, never a calibration and never the gear ratio
    const k14 = H.RULES.find(k => k.id === 'K14');
    assert.equal(k14.name, 'Tail authority'); assert.ok(k14.first.some(s => /tail torque assist/.test(s)) && k14.first.some(s => /larger tail blades or increase the headspeed/.test(s)));
    assert.ok(!H.RULES.some(k => k.first.some(s => /calibrat/i.test(s) && /tail/i.test(s))), 'no tail calibration');
    const f = (fid, id, log, profile, axis) => ({ fid, id, severity: 'flag', log, profile, axis });
    const F = [f('a', 'C11', 3, 1, 'pitch'), f('b', 'F5', 3, 1), f('c', 'F1', 3, null), f('d', 'F5', 4, 1), f('e', 'F5', 3, 2), f('g', 'T8', 3, 2), f('h', 'C5', 3, 2, 'roll')];
    assert.deepEqual(H.causesOf(F[0], F), [{ rule: 'K1', name: 'D-term noise', fids: ['b', 'c'], ids: ['F5', 'F1'], first: H.RULES[0].first }], 'same log, profile 1 or no profile; not log 4, not profile 2');
    assert.deepEqual(H.causesOf(f('t', 'T1', 3, 2, 'yaw'), F).map(c => [c.rule, c.ids]), [['K2', ['T8']]], 'T8 is a yaw upstream of T1');
    assert.deepEqual(H.causesOf(F[6], F).map(c => c.rule), [], 'a roll symptom and a yaw upstream (T8) do not match');
    assert.deepEqual(H.causesOf(F[0], F, (u) => u.id !== 'F1').map(c => c.fids), [['b']], 'only: a filter on the upstream flags');
    const rec = { id: 'C11:pitch', severity: 'check', axis: 'pitch', profile: 1, evidence: [{ fid: 'a', id: 'C11', log: 3, profile: 1 }] };
    assert.deepEqual(H.causesOf(rec, F).map(c => [c.rule, c.fids]), [['K1', ['b', 'c']]]);
});

test('texts: titles, about texts, edge reasons, K rule names and steps, notes are STE (simple local check)', () => {
    const problems = [];
    for (const n of H.NODES) { for (const k of ['title', 'about', 'optional', 'note']) if (n[k]) problems.push(...steProblems(n[k], `${k} ${n.id}`));
        assert.ok(n.title.split(/\s+/).length <= 6, n.title); assert.ok(!/\./.test(n.title), n.title); for (const c of n.chips) assert.ok(c.label.split(/\s+/).length <= 4, c.label); }
    for (const e of H.EDGES) problems.push(...steProblems(e.why, `why ${e.from}>${e.to}`));
    for (const k of H.RULES) { problems.push(...steProblems(k.name, `name ${k.id}`)); for (const s of k.first) { problems.push(...steProblems(s, `first ${k.id}`)); assert.match(s, /^[A-Z].*\.$/, s); } }
    assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------------

// [fid, check, log, profile, axis] of the flags; [recommendation id, severity, fids of its evidence]
const FIXTURES = {
    g58: { flags: [['0', 'D2', 58, null, null], ['1', 'F5', 58, 1, null], ['2', 'F5', 58, 2, null], ['3', 'F5', 58, 3, null], ['4', 'T6', 58, 2, null], ['5', 'T8', 58, 1, null], ['6', 'T8', 58, 2, null], ['7', 'T8', 58, 3, null], ['8', 'T13', 58, 1, null], ['9', 'T14', 58, null, null]],
        recs: [['T8', 'check', ['5', '6', '7']], ['T13', 'check', ['8']], ['D2', 'check', ['0']], ['F5', 'check', ['1', '2', '3']], ['T14', 'check', ['9']], ['T6:yaw:p2', 'watch', ['4']]] },
    fb3: { flags: [['0', 'C11', 3, 1, 'roll'], ['1', 'C11', 3, 1, 'pitch'], ['2', 'C11', 3, 2, 'pitch'], ['3', 'C11', 3, 3, 'pitch'], ['4', 'C12', 3, 2, 'roll'], ['5', 'D2', 3, null, null], ['6', 'D4', 3, 0, null], ['7', 'F1', 3, null, null],
        ['8', 'F5', 3, 2, null], ['9', 'F5', 3, 3, null], ['10', 'F5', 3, 1, null], ['11', 'F10', 3, 1, 'yaw'], ['12', 'F10', 3, 3, 'yaw'], ['13', 'G6', 3, 1, null], ['14', 'G6', 3, 2, null], ['15', 'G11', 3, null, null], ['16', 'T1', 3, 2, 'yaw'],
        ['17', 'T6', 3, 2, null], ['18', 'T8', 3, 2, null]],
        recs: [['D4', 'check', ['6']], ['T8', 'check', ['18']], ['D2', 'check', ['5']], ['F1', 'action', ['7']], ['F5', 'check', ['8', '9', '10']], ['F10', 'check', ['11', '12']], ['C11:pitch', 'check', ['1', '2', '3']],
            ['C11:roll', 'check', ['0']], ['G6', 'check', ['13', '14']], ['G11', 'check', ['15']], ['C12:roll', 'check', ['4']], ['F10:yaw_d_gain:p1', 'action', ['11']], ['F10:yaw_d_gain:p3', 'action', ['12']],
            ['T6:yaw:p2', 'check', ['17']], ['T1:yaw', 'watch', ['16']]] },
};
const load = (fx) => ({ findings: fx.flags.map(([fid, id, log, profile, axis]) => ({ fid, id, severity: 'flag', log, profile, axis: axis || undefined })),
    recs: fx.recs.map(([id, severity, ev]) => ({ id, severity, evidence: ev.map(fid => ({ fid })) })) });

test('status, Gaui X4 #58: start here the filters; the tail authority waits for them; the loop stalls (D2) are no problem of the logging', () => {
    const { findings, recs } = load(FIXTURES.g58), st = H.status(findings, recs, {}), N = st.nodes;
    assert.deepEqual(st.startHere, ['filters']); assert.deepEqual(st.prereqProblems, []);
    assert.deepEqual([N.filters.number, N.tailcomp.status, N.tailcomp.after, N.tailcomp.number], [1, 'problem', ['filters'], null]);
    assert.equal(N.tailcomp.reason, 'This tuning block has a problem. Correct this item before it first: "Filters".');
    assert.equal(N.logging.status, 'ok', 'D2 flags are never a problem: the logging is "No problem found"'); assert.deepEqual(N.logging.checksRun, ['D2']); assert.match(N.logging.reason, /^No problem found\. This check operated: D2\.$/);
    assert.equal(N.tail.status, 'notMeasured', 'T6 is evidence of the tail compensation');
    assert.deepEqual(N.tailcomp.problemFids.sort(), ['5', '6', '7', '8', '9']);
    assert.ok(N.tailcomp.recs.includes('T8') && N.tailcomp.recs.includes('T13'));
    for (const p of ['rpm', 'power', 'mechanics', 'rescue', 'controller']) assert.equal(N[p].status, 'noData', `${p}: the logs cannot show it, never "Start here"`);
    assert.equal(N.rpm.reason, 'The logs cannot show this item. Examine it on the helicopter.');
});

test('status, Fireball #3: G11 (pack sag) is a value to monitor, not a power problem; the governor waits for the filters; the cyclic waits for the filters; the tail authority is a possible result of the throttle reserve', () => {
    const { findings, recs } = load(FIXTURES.fb3), st = H.status(findings, recs, {}), N = st.nodes;
    assert.deepEqual(st.startHere, ['filters']); assert.deepEqual(st.prereqProblems, [], 'G11 is the governor that supplies the normal pack sag: no prerequisite problem');
    assert.equal(N.power.status, 'ok'); assert.match(N.power.reason, /^No problem found\./);
    assert.equal(N.governor.status, 'problem'); assert.deepEqual(N.governor.blockedBy || [], []); assert.match(N.governor.reason, /Correct this item before it first: "Filters"\./);
    assert.equal(N.cyclic.status, 'blocked'); assert.deepEqual(N.cyclic.blockedBy, ['filters']);
    assert.equal(N.tailcomp.status, 'possible');
    assert.ok(N.tailcomp.possible.some(q => q.rule === 'K14' && q.from.includes('governor')) && N.tailcomp.possible.some(q => q.rule === 'cause' && q.from[0] === 'governor'));
    assert.equal(N.tail.problem, false, 'T1 is a watch'); assert.equal(N.logging.status, 'ok', 'D2 and D4 are no problem');
});

test('status rules: prerequisites never blocked or possible; blocks blocked iff a gate upstream has a problem (random problem sets)', () => {
    let seed = 7; const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const flagOf = { logging: 'D1', rpm: 'G1', power: 'D5', mechanics: 'T4', rescue: 'D9', controller: 'R1', filters: 'F5', governor: 'G3', cyclic: 'C1', cycomp: 'C14', tail: 'T2', tailcomp: 'T6' };
    for (let k = 0; k < 200; k++) {
        const P = new Set(Object.keys(flagOf).filter(() => rand() < 0.3));
        // each in a log of its own: no K rule matches, so possible comes from the cause edges (not viaRules) only
        const findings = [...P].map((id, i) => ({ fid: `f${i}`, id: flagOf[id], severity: 'flag', log: 100 + i, profile: 1, axis: flagOf[id] === 'C1' ? 'roll' : undefined }));
        const recs = findings.map(f => ({ id: f.id, severity: 'check', evidence: [{ fid: f.fid }] }));
        const st = H.status(findings, recs, {}), N = st.nodes;
        assert.deepEqual(st.prereqProblems, PREREQ.filter(id => P.has(id)));
        for (const n of H.NODES) {
            // a direct gate with fromChecks holds only for those checks upstream, one with a scope only for those checks of the block
            const holds = (u) => { const fc = H.fromChecksOf(u, n.id), q = H.scopeOf(u, n.id); return (!fc || fc.includes(flagOf[u])) && (!q || q.includes(flagOf[n.id])); };
            const s = N[n.id], up = H.gateUpstream(n.id).filter(u => P.has(u) && holds(u)), cause = H.EDGES.filter(e => e.kind === 'cause' && !e.viaRules && e.to === n.id && P.has(e.from));
            assert.equal(s.problem, P.has(n.id), n.id);
            if (n.kind === 'prereq') { assert.equal(s.status, P.has(n.id) ? 'problem' : 'noData', n.id); continue; }
            if (!P.has(n.id)) { assert.ok(!['blocked', 'possible', 'startHere'].includes(s.status), n.id); continue; }
            assert.equal(s.status === 'blocked', up.length > 0, `${n.id} blocked iff a problem upstream along gates`);
            if (s.status === 'blocked') { assert.ok(s.blockedBy.length && s.blockedBy.every(u => up.includes(u) && !H.gateUpstream(u).some(v => up.includes(v))), `${n.id}: the first problems upstream`); continue; }
            assert.equal(s.status === 'possible', cause.length > 0, `${n.id} possible iff a cause edge from a problem`);
        }
        assert.deepEqual(st.startHere, H.BLOCKS.map(n => n.id).filter(id => N[id].status === 'startHere').sort(H.bySequence), 'start here: blocks only, in sequence');
        // start here only when no block before it (filters, governor, its lane) has a problem or a gate upstream with a problem
        const BEFORE = { filters: [], governor: ['filters'], cyclic: ['filters', 'governor'], tail: ['filters', 'governor'], cycomp: ['filters', 'governor', 'cyclic'], tailcomp: ['filters', 'governor', 'tail'] };
        const waits = (u) => P.has(u) || H.gateUpstream(u).some(v => P.has(v) && (!H.fromChecksOf(v, u) || H.fromChecksOf(v, u).includes(flagOf[v])) && !H.scopeOf(v, u));
        for (const b of BLOCKS) { const s = N[b].status; if (s === 'startHere') assert.ok(!BEFORE[b].some(waits), `${b}: start here with a problem before it`);
            if (s === 'problem') assert.ok(BEFORE[b].some(waits) && N[b].after.length, `${b}: problem waits`); }
        if (st.prereqProblems.includes('rpm')) assert.ok(st.startHere.every(b => b === 'filters' || b === 'governor'), `the RPM signal gates the gains: no later block starts (${st.startHere})`);
        st.startHere.forEach((id, i) => assert.equal(N[id].number, i + 1));
    }
});

test('status rules: watch and info recommendations, D2 and D4, no advice, explained flags, C10 landed', () => {
    const f = (fid, id, extra) => Object.assign({ fid, id, severity: 'flag', log: 1, profile: 1 }, extra);
    const r = (id, severity, fids) => ({ id, severity, evidence: fids.map(x => ({ fid: x })) });
    let st = H.status([f('a', 'F5')], [r('F5', 'watch', ['a'])]);
    assert.deepEqual([st.nodes.filters.status, st.nodes.filters.problem], ['monitor', false], 'a flag with a watch only');
    st = H.status([f('a', 'F5')], [r('F5', 'info', ['a'])]);
    assert.equal(st.nodes.filters.status, 'information', 'a flag that every recommendation makes information');
    st = H.status([f('a', 'F5', { explained: 'Already filtered' })], []);
    assert.equal(st.nodes.filters.status, 'information');
    st = H.status([f('a', 'D2'), f('b', 'D4')], [r('D2', 'action', ['a']), r('D4', 'check', ['b'])]);
    assert.equal(st.nodes.logging.status, 'ok'); assert.deepEqual(st.startHere, []); assert.deepEqual(st.prereqProblems, []);
    st = H.status([f('a', 'F5')], null);
    assert.deepEqual(st.startHere, ['filters'], 'without advice every flag counts');
    assert.deepEqual(H.status([f('a', 'F5')], []).startHere, ['filters'], 'an empty list: advice did not run (the worker gives [] when it fails)');
    st = H.status([{ module: 'setup', id: 'F5', severity: 'flag', log: 2, profile: 1, text: 'line' }], [{ id: 'F5', severity: 'check', evidence: [{ module: 'setup', id: 'F5', log: 2, profile: 1, text: 'line' }] }]);
    assert.deepEqual(st.startHere, ['filters']);
    // header rules and gain decisions count by their recommendation: the cyclic I rule is a mechanics problem (the mixer limit test)
    st = H.status([], [{ id: 'SETUP:roll_i_gain', severity: 'check', axis: 'roll', evidence: [] }, { id: 'C7:pitch_f_gain:p1', severity: 'action', axis: 'pitch', evidence: [{ id: 'C7' }] },
        { id: 'C7:yaw_p_gain:p1', severity: 'action', axis: 'yaw', evidence: [{ id: 'C7' }] }, { id: 'SETUP:rates_type', severity: 'watch', evidence: [] }]);
    assert.deepEqual([st.startHere, st.prereqProblems], [['tail'], ['mechanics']], 'the mixer limit test (SETUP) gates the cyclic gains, not the tail gains');
    assert.equal(st.nodes.cyclic.status, 'blocked'); assert.deepEqual(st.nodes.cyclic.blockedBy, ['mechanics']);
    assert.equal(st.nodes.controller.problem, false, 'a watch on a header rule');
    // C10 "landed" at flight speed: information only (SPEC3 F), never a problem of the cyclic compensation
    const landed = f('l', 'C10', { value: 2, axis: undefined });
    st = H.status([landed], [r('C10:landed', 'info', ['l'])]);
    assert.deepEqual([st.nodes.cycomp.status, st.nodes.cycomp.problem], ['information', false]);
    assert.equal(C.status(landed), 'information');
});

test('status: satisfactory, monitor, information, not sufficient data, not measured; prerequisites ok or no data, with the coverage reason', () => {
    const g = (id, severity, extra) => Object.assign({ fid: `${id}${severity}`, id, severity, log: 1, profile: 1, text: '' }, extra);
    const st = H.status([g('C12', 'ok'), g('C12', 'note'), g('C13', 'note'), g('F5', 'note', { thin: true }), g('G2', 'ok'), g('F6', 'skipped'), g('G8', 'note'), g('D1', 'ok')], [],
        { coverage: [{ checks: ['F3', 'F5', 'F6'], status: 'not-in-log' }, { checks: ['T8'], status: 'needs-fields' }, { checks: ['D9'], status: 'not-in-log' }] }), N = st.nodes;
    assert.equal(N.cyclic.status, 'monitor', 'a C12 note');
    assert.equal(N.filters.status, 'insufficient');
    assert.equal(N.governor.status, 'satisfactory');
    assert.equal(N.tailcomp.status, 'notMeasured'); assert.equal(N.tailcomp.reason, 'The log does not record the fields that these checks use.');
    assert.deepEqual([N.logging.status, N.logging.reason], ['ok', 'No problem found. This check operated: D1.']);
    // user rule 2026-10-06: the log is the only necessary input. The reason says what the log does not record, never "load a CLI dump"
    assert.deepEqual([N.rescue.status, N.rescue.reason], ['noData', 'The log does not record these values. Thus, the analysis cannot examine them.']);
    // a row whose checks ran on the data with too little of it comes first: more flights, not the values that the log does not record
    const more = H.status([], [], { coverage: [{ checks: ['D9'], status: 'not-in-log' }, { checks: ['D8', 'G19'], status: 'needs-flights' }] }).nodes.rescue;
    assert.deepEqual([more.status, more.reason], ['noData', 'The logs do not have sufficient flight data for these checks.']);
    for (const n of H.NODES) assert.doesNotMatch(N[n.id].reason, /CLI dump|diff all/, n.id);
    assert.deepEqual([N.mechanics.status, N.mechanics.reason], ['noData', 'The logs cannot show this item. Examine it on the helicopter.']);
    for (const n of H.NODES) assert.ok(N[n.id].reason && N[n.id].status, n.id);
});

test('status: not applicable (DIRECT governor) and not accurate (log rate)', () => {
    const g = (fid, id, severity, extra) => Object.assign({ fid, id, severity, log: 1, profile: null, text: '' }, extra);
    let st = H.status([g('a', 'G0', 'note', { value: 0 }), g('b', 'G2', 'skipped')], []);
    assert.equal(st.nodes.governor.status, 'notApplicable');
    st = H.status([g('a', 'G0', 'ok', { value: 1000 })], []);
    assert.notEqual(st.nodes.governor.status, 'notApplicable');
    // D1 flags in log 2: the filter results of log 2 are not accurate, those of log 3 count; the logging itself is a problem
    st = H.status([g('d', 'D1', 'flag', { log: 2 }), g('e', 'F5', 'flag', { log: 2, profile: 1 }), g('f', 'F6', 'ok', { log: 2, profile: 1 })], [{ id: 'F5', severity: 'check', evidence: [{ fid: 'e' }] }]);
    assert.equal(st.nodes.filters.status, 'notAccurate'); assert.equal(st.nodes.filters.problem, false);
    st = H.status([g('d', 'D1', 'flag', { log: 2 }), g('e', 'F5', 'flag', { log: 3, profile: 1 })], [{ id: 'F5', severity: 'check', evidence: [{ fid: 'e' }] }, { id: 'D1', severity: 'action', evidence: [{ fid: 'd' }] }]);
    assert.deepEqual([st.startHere, st.prereqProblems], [['filters'], ['logging']], 'D1 makes results not accurate, it gates nothing: the filters of log 3 are a problem');
    assert.equal(st.nodes.logging.status, 'problem');
});

test('status: every reason is STE (simple local check) on the fixtures and on an empty result', () => {
    const problems = [];
    for (const fx of Object.values(FIXTURES)) { const { findings, recs } = load(fx); for (const [id, n] of Object.entries(H.status(findings, recs).nodes)) problems.push(...steProblems(n.reason, `reason ${id}`)); }
    for (const [id, n] of Object.entries(H.status([], []).nodes)) { assert.equal(n.status, H.isPrereq(id) ? 'noData' : 'notMeasured', id); problems.push(...steProblems(n.reason, `reason ${id}`)); }
    assert.deepEqual(problems, []);
    for (const s of ['ok', 'noData', 'startHere', 'blocked', 'possible', 'problem', 'monitor', 'satisfactory', 'information', 'insufficient', 'notMeasured', 'notApplicable', 'notAccurate', 'error']) assert.ok(C.LABELS[s], s);
    assert.deepEqual([C.LABELS.ok, C.LABELS.noData], ['No problem found', 'No data']);
});

// ---------------------------------------------------------------------------------------------
// GEAR RULE, PID profiles, bench runs, the gate table that advice.cjs shares
// ---------------------------------------------------------------------------------------------

test('GEAR RULE: no item, edge, K rule or reason tells that a gear ratio, a pulley or a tooth count can be incorrect', () => {
    const GEAR = (t) => /\b(gears?|pulleys?|tooth|teeth)\b/i.test(String(t).replace(/landing gear/gi, 'skids'));
    const OK = new Set(['The gear ratios in the configuration are correct.']);
    const sentencesOf = (t) => String(t).split(/(?<=[.!?])\s+(?=[A-Z0-9"`(])/);
    const texts = [];
    for (const n of H.NODES) texts.push(n.title, n.about, n.optional, n.note, ...n.chips.map(c => c.label), ...n.docs.map(d => d.title));
    for (const e of H.EDGES) texts.push(e.why);
    for (const k of H.RULES) texts.push(k.name, ...k.first);
    for (const fx of Object.values(FIXTURES)) { const { findings, recs } = load(fx); const st = H.status(findings, recs); for (const n of Object.values(st.nodes)) texts.push(n.reason);
        for (const f of findings) for (const c of H.causesOf(f, findings)) texts.push(c.name, ...c.first); }
    const bad = []; for (const t of texts.filter(x => typeof x === 'string')) for (const s of sentencesOf(t)) if (GEAR(s) && !OK.has(s)) bad.push(s);
    assert.deepEqual(bad, []);
    const g = byId.get('rpm');
    assert.deepEqual([g.title, g.note, g.checks], ['RPM signal and motor poles', 'The gear ratios in the configuration are correct.', ['G1', 'G12', 'G20']]);
    for (const n of H.NODES) { assert.ok(!n.params.some(p => /gear_ratio/.test(p)), `${n.id}: ${n.params}`); for (const d of n.docs) assert.ok(!/gear/i.test(d.url + d.title), d.url); }
    assert.match(H.EDGES.find(e => e.from === 'rpm' && e.to === 'governor').why, /The gear ratios in the configuration are correct\.$/);
    assert.ok(H.RULES.find(k => k.id === 'K11').first.includes('Make sure that the motor pole count and the RPM sensor are correct (G12).'));
    assert.ok(H.RULES[0].first.includes('For a peak that is not a rotor harmonic, use the dynamic notch filter.') && H.RULES[0].first.includes('For a resonance at a constant frequency, use a static notch filter.'));
});

test('status per PID profile (SPEC2 D12): a profile sees its findings and those with no profile; byProfile, and the chips of "All profiles"', () => {
    const f = (fid, id, profile, extra) => Object.assign({ fid, id, severity: 'flag', log: 1, profile, text: '' }, extra);
    const F = [f('a', 'F5', 1), f('b', 'C1', 2, { axis: 'roll' }), f('c', 'D2', null), f('d', 'C12', 0, { axis: 'roll' }), f('e', 'C3', 'arm', { axis: 'pitch' }), f('g', 'D4', 0), f('h', 'G6', 2),
        f('i', 'C5', 3, { axis: 'roll', severity: 'ok' }), f('j', 'F4', 'roll', { severity: 'ok' })];
    const R = F.filter(x => x.severity === 'flag').map(x => ({ id: x.id + (x.axis ? `:${x.axis}` : ''), severity: 'check', profile: x.id === 'D4' ? null : x.profile, evidence: [{ fid: x.fid }] }));
    const logs = [{ log: 1, profileSeconds: { 1: 30, 2: 40, 4: 0, 5: 12 } }];
    const st = H.status(F, R, { logs }), P = st.byProfile;
    assert.deepEqual(st.profiles, ['1', '2', '3', '5', '0'], 'PID profiles 1 to 6 in sequence, then "PID profile unknown" (0 and arm); a profile with 0 s of flight is not one');
    assert.equal(st.profile, null);
    // all profiles together: the filters of profile 1 hold the cyclic gains of profile 2
    assert.deepEqual(st.startHere, ['filters']); assert.equal(st.nodes.governor.status, 'problem'); assert.equal(st.nodes.cyclic.status, 'blocked'); assert.deepEqual(st.nodes.cyclic.blockedBy, ['filters']);
    assert.deepEqual(P['1'].startHere, ['filters']); assert.equal(P['1'].nodes.cyclic.status, 'notMeasured');
    assert.deepEqual(P['2'].startHere, ['governor']); assert.deepEqual([P['2'].nodes.cyclic.status, P['2'].nodes.cyclic.after], ['problem', ['governor']], 'the cyclic gains wait for the governor'); assert.equal(P['2'].nodes.filters.status, 'satisfactory', 'F4 has an axis, not a PID profile'); assert.deepEqual(P['2'].nodes.cyclic.recs, ['C1:roll']);
    assert.deepEqual(P['0'].startHere, ['cyclic'], 'C3 of the stretch before the first switch (arm) and C12 of profile 0: "PID profile unknown"');
    assert.deepEqual(P['0'].nodes.cyclic.fids, ['d', 'e']);
    assert.equal(P['3'].nodes.cyclic.status, 'satisfactory');
    for (const k of st.profiles) assert.equal(P[k].nodes.logging.status, 'ok', `${k}: D2 and D4 (a CLI index, not a log profile) count in every profile, and they are no problem`);
    assert.deepEqual(st.nodes.cyclic.profiles, { 1: 'notMeasured', 2: 'problem', 3: 'satisfactory', 5: 'notMeasured', 0: 'startHere' });
    for (const n of H.NODES) assert.deepEqual(st.nodes[n.id].profiles, Object.fromEntries(st.profiles.map(k => [k, P[k].nodes[n.id].status])), n.id);
    const two = H.status(F, R, { logs, profile: 2 });
    assert.deepEqual(two, P['2']); assert.equal(two.byProfile, undefined); assert.equal(two.profile, '2');
    assert.deepEqual(H.status(F, R, { logs, profile: '2' }), two);
    assert.deepEqual(H.status(F, R, { logs, profile: 'arm' }), H.status(F, R, { logs, profile: 0 }));
    assert.deepEqual(H.status(F, R, { logs, profile: 'all' }), st);
    const lean = H.status(F, R, { logs, byProfile: false }); assert.equal(lean.byProfile, undefined); assert.equal(lean.nodes.cyclic.profiles, undefined);
    assert.deepEqual([H.profileKey({ id: 'C12', profile: 'arm' }), H.profileKey({ id: 'C12', profile: '4' }), H.profileKey({ id: 'D4', profile: 0 }), H.profileKey({ id: 'H', profile: 'start profile 1' }), H.profileKey({ id: 'F4:roll_d_cutoff', profile: 'roll' })],
        ['0', '4', null, null, null]);
    for (const fx of Object.values(FIXTURES)) { const { findings, recs } = load(fx), s = H.status(findings, recs);
        assert.ok(s.profiles.length >= 3, s.profiles.join());
        for (const k of s.profiles) for (const n of H.NODES) { assert.ok(s.byProfile[k].nodes[n.id].status, `${k} ${n.id}`); assert.deepEqual(steProblems(s.byProfile[k].nodes[n.id].reason, `${k} ${n.id}`), []); } }
});

test('status per PID profile (review 2, A1): the worker\'s pidProfile first; the label 0 of a log is its arming profile only when it is confirmed', () => {
    const f = (fid, id, profile, extra) => Object.assign({ fid, id, severity: 'flag', log: 1, profile, text: '' }, extra);
    const F = [f('a', 'C1', 0, { axis: 'roll', pidProfile: 1 }), f('b', 'F5', 0, { pidProfile: 1 })];
    const R = F.map(x => ({ id: x.id, severity: 'check', profile: 1, evidence: [{ fid: x.fid }] }));
    const logs = (o) => [Object.assign({ log: 1, profileSeconds: { 0: 100 }, armingProfile: 1 }, o)];
    assert.deepEqual(H.status(F, R, { logs: logs({ armingBasis: ['cliTarget'] }) }).profiles, ['1']);
    // user decision 2026-10-06: the governor headspeed request at the log start that agrees with one PID profile confirms it
    assert.deepEqual(H.status(F, R, { logs: logs({ armingBasis: ['headspeed'] }) }).profiles, ['1']);
    assert.deepEqual(H.status(F, R, { logs: logs({ armingBasis: ['govTarget'], armingConfirmed: true }) }).profiles, ['1']);
    assert.deepEqual(H.status(F, R, { logs: logs({ armingBasis: ['govTarget'] }) }).profiles, ['1', '0'], 'an estimate is no PID profile: the time before the first change stays "PID profile unknown"');
    const t5 = f('t5', 'T5', 0, { pidProfile: 1 }), t8 = (p) => f('t8', 'T8', 0, { pidProfile: p });
    assert.deepEqual(H.causesOf(t5, [t5, t8(2)]).map(c => c.rule), []);
    assert.deepEqual(H.causesOf(t5, [t5, t8(1)]).map(c => c.rule), ['K6']);
});

test('causes (review 2, D-M1): an upstream flag whose times all lie in the times of the symptom is no cause; the tail authority counts for the tail gains through a K rule only', () => {
    const f = (fid, id, spans, extra) => Object.assign({ fid, id, severity: 'flag', log: 3, profile: 2, text: '', evidence: { spans: spans.map(([t0, t1]) => ({ log: 3, t0, t1 })) } }, extra);
    const t1 = f('t1', 'T1', [[330.927, 335.651]], { axis: 'yaw' }), inside = f('t8', 'T8', [[333.031, 334.071], [332.093, 333.129]]), out = f('t8', 'T8', [[333.031, 334.071], [20, 21]]);
    assert.deepEqual(H.causesOf(t1, [t1, inside]), []);
    assert.deepEqual(H.causesOf(t1, [t1, out]).map(c => [c.rule, c.ids]), [['K2', ['T8']]]);
    assert.deepEqual(H.causesOf(t1, [t1, Object.assign({}, inside, { log: 4, evidence: { spans: [{ log: 4, t0: 333, t1: 334 }] } })]), []);
    assert.deepEqual(H.causesOf(t1, [t1, Object.assign({}, inside, { evidence: null })]).map(c => c.rule), ['K2']);
    const e1 = Object.assign({}, t1, { evidence: null, events: [{ t: 331, seconds: 4 }] }), e8 = Object.assign({}, inside, { evidence: null, times: [332.5, 333.9] });
    assert.deepEqual(H.causesOf(e1, [e1, e8]), []);
    const rec = { id: 'T1:yaw', severity: 'check', axis: 'yaw', profile: 2, evidence: [{ fid: 't1', id: 'T1', log: 3, profile: 2 }] };
    assert.deepEqual(H.causesOf(rec, [t1, inside]), []);
    assert.deepEqual(H.causesOf(rec, [t1, out]).map(c => c.rule), ['K2']);
    // the diagram: the tail gains are a "Possible result" of the tail authority (tailcomp, after them in the sequence) only when T8 comes first
    const recs = [rec, { id: 'T8', severity: 'check', profile: 2, evidence: [{ fid: 't8' }] }];
    assert.deepEqual(H.status([t1, inside], recs).nodes.tail.possible, []);
    assert.deepEqual(H.status([t1, inside], recs).nodes.tail.status, 'startHere');
    const p = H.status([t1, out], recs).nodes.tail;
    assert.deepEqual([p.status, p.possible.map(q => [q.rule, q.from])], ['possible', [['K2', ['tailcomp']]]]);
    assert.match(p.reason, /^This problem can be a result of a problem in "Tail compensation and authority"\.$/);
});

test('status: the results of a bench run (D7, SPEC2 D13 correction) do not count', () => {
    const f = (fid, id, log, extra) => Object.assign({ fid, id, severity: 'flag', log, profile: 1, text: '' }, extra);
    const recs = (F) => F.filter(x => x.severity === 'flag').map(x => ({ id: x.id, severity: 'check', profile: 1, evidence: [{ fid: x.fid }] }));
    let F = [f('a', 'G12', 2), f('z', 'D7', 2, { severity: 'note', profile: null, unit: 's', value: 0, flights: 0 }), f('b', 'F5', 3), f('y', 'D7', 3, { severity: 'note', profile: null, unit: 's', value: 120, flights: 1 })];
    let st = H.status(F, recs(F));
    assert.deepEqual(st.bench, [2]); assert.equal(st.nodes.rpm.status, 'noData'); assert.deepEqual(st.startHere, ['filters']); assert.deepEqual(st.prereqProblems, []);
    assert.deepEqual(H.status([f('a', 'G12', 2, { profile: 4 }), F[1], F[2]], recs(F), { logs: [{ log: 2, profileSeconds: { 5: 10 } }] }).profiles, ['1'], 'a bench run gives no PID profile');
    assert.deepEqual(st.nodes.controller.fids.sort(), ['y', 'z'], 'the D7 results stay: they tell that the log is a bench run'); assert.equal(st.nodes.controller.status, 'ok');
    st = H.status(F, recs(F), { logs: [{ log: 3, bench: true }] });
    assert.deepEqual(st.bench, [2, 3]); assert.deepEqual(st.startHere, []);
    F = [f('a', 'G12', 2), f('b', 'F5', [2, 3])];
    assert.deepEqual(H.status(F, recs(F), { logs: [{ log: 2, class: 'bench' }] }).startHere, ['filters'], 'a result that also uses a flight log counts');
});

test('D9 and P1 (SPEC3 A, I): rescue off in a PID profile and a weak battery are prerequisite problems that gate their blocks', () => {
    const d9 = { fid: 'r', module: 'config', id: 'D9', severity: 'flag', log: null, profile: 4, pidProfile: 4, value: 0 }, p1 = { fid: 'p', module: 'power', id: 'P1', severity: 'flag', log: 1, profile: null, value: 0.2 };
    const g3 = { fid: 'g', module: 'gov', id: 'G3', severity: 'flag', log: 1, profile: 1, value: -0.1 };
    const st = H.status([d9, p1, g3], [{ id: 'D9:p4', severity: 'check', profile: 4, evidence: [{ fid: 'r' }] }, { id: 'P1:1', severity: 'check', evidence: [{ fid: 'p' }] }, { id: 'G3', severity: 'check', profile: 1, evidence: [{ fid: 'g' }] }]);
    assert.deepEqual(st.prereqProblems, ['power', 'rescue']); assert.deepEqual(st.startHere, []);
    assert.deepEqual([st.nodes.governor.status, st.nodes.governor.blockedBy], ['blocked', ['power']], 'a weak battery gates the governor block');
    assert.equal(st.byProfile['4'].nodes.rescue.status, 'problem'); assert.equal(st.byProfile['1'].nodes.rescue.status, 'noData', 'PID profile 1 does not see the D9 of PID profile 4');
});
test('SPEC2 D3: a recommendation of advice.cjs has a gate if and only if hierarchy.cjs calls its node Blocked, with the same steps (one gate table)', (t) => {
    let A = null; try { A = require('../tools/autotune/advice.cjs'); } catch (e) { t.skip(`advice.cjs does not load: ${e.message}`); return; }
    const MOD = { F1: 'setup', F2: 'setup', F5: 'setup', F6: 'setup', G1: 'gov', G12: 'gov', G6: 'gov', G3: 'gov', G9: 'gov', C2: 'loop', C1: 'loop', T8: 'loop', C11: 'loop', C10: 'loop', T2: 'loop', T6: 'loop',
        T13: 'more', C12: 'track', C5: 'track', T1: 'track', F10: 'more', C13: 'track', D6: 'more', R1: 'track' };
    const AX = { C1: 'roll', C11: 'pitch', C10: 'roll', T2: 'yaw', C12: 'roll', C5: 'pitch', T1: 'yaw', F10: 'yaw', C13: 'roll', R1: 'roll', T6: 'yaw', T8: 'yaw' };
    let seed = 11, count = 0; const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, blocked = { yes: 0, no: 0 };
    for (let k = 0; k < 120; k++) {
        const F = Object.keys(MOD).filter(() => rand() < 0.3).map((id, i) => ({ fid: `f${i}`, module: MOD[id], id, severity: 'flag', log: 0, profile: rand() < 0.5 ? 1 : 2, axis: AX[id] || null, value: 0.8, se: 0.05, n: 10,
            threshold: 0.3, unit: 'fraction', text: 'toolkit text', times: [] }));
        const out = A.advise({ findings: F, decisions: [], header: {}, cli: null, fields: {}, headerProfile: 1, headerLog: 0, logBase: 1, logs: [{ log: 0, profileSeconds: { 1: 100, 2: 100 } }] });
        const st = H.status(F, out.recommendations, {});
        for (const r of out.recommendations) {
            if (!r.node) continue; count++;
            const N = st.nodes[r.node], gated = !!(r.gate && Array.isArray(r.gate.by) && r.gate.by.length);
            assert.equal(gated, N.status === 'blocked', `set ${k}, ${r.id} on ${r.node}: gate ${JSON.stringify(r.gate)}, status ${N.status}`);
            if (gated) assert.deepEqual(r.gate.by, N.blockedBy, `${r.id}: the same steps`);
            blocked[gated ? 'yes' : 'no']++;
        }
    }
    assert.ok(count > 500 && blocked.yes > 50 && blocked.no > 50, JSON.stringify({ count, blocked }));
});

test('start here (coordinator, round 2): never a later block while an earlier one waits; a prerequisite problem that gates the blocks leaves no start', () => {
    const f = (fid, id, extra) => Object.assign({ fid, id, severity: 'flag', log: 1, profile: 1 }, extra), r = (x) => ({ id: x.id, severity: 'check', evidence: [{ fid: x.fid }] });
    const run = (F) => H.status(F, F.map(r), {});
    // fb1005: the RPM signal (G1) gates filters and governor; the cyclic gains are blocked; the cyclic compensation (C14) must not start
    let F = [f('g1', 'G1', { profile: null }), f('f5', 'F5'), f('g3', 'G3'), f('c1', 'C1', { axis: 'roll' }), f('c14', 'C14', { axis: 'pitch' })], st = run(F), N = st.nodes;
    assert.deepEqual([st.startHere, st.prereqProblems], [[], ['rpm']]);
    assert.deepEqual([N.filters.status, N.governor.status, N.cyclic.status], ['blocked', 'blocked', 'blocked']);
    assert.deepEqual([N.cycomp.status, N.cycomp.after], ['problem', ['rpm', 'filters', 'governor', 'cyclic']]);
    assert.match(N.cycomp.reason, /^This tuning block has a problem\. Correct these items before it first: "RPM signal and motor poles", "Filters", "Governor", "Cyclic gains"\.$/);
    // a prerequisite problem with no block problem before: C14 alone, the RPM signal still gates the cyclic lane (through the filters)
    st = run([f('g1', 'G1', { profile: null }), f('c14', 'C14', { axis: 'pitch' })]);
    assert.deepEqual([st.startHere, st.nodes.cycomp.status, st.nodes.cycomp.after], [[], 'problem', ['rpm']]);
    // a blocked block upstream in the lane: the tail authority waits for the tail gains that the mechanics block
    st = run([f('t4', 'T4'), f('t2', 'T2'), f('t8', 'T8')]);
    assert.deepEqual([st.startHere, st.nodes.tail.status, st.nodes.tailcomp.status, st.nodes.tailcomp.after], [[], 'blocked', 'problem', ['mechanics', 'tail']]);
    // a lane after a blocked governor (a weak battery): the filters can start, the cyclic and tail lanes wait
    st = run([f('p1', 'P1', { profile: null }), f('g3', 'G3'), f('f1', 'F1', { profile: null }), f('c1', 'C1', { axis: 'roll' }), f('t5', 'T5')]);
    assert.deepEqual([st.startHere, st.prereqProblems, st.nodes.governor.status], [['filters'], ['power'], 'blocked']);
    assert.deepEqual([st.nodes.cyclic.status, st.nodes.cyclic.blockedBy, st.nodes.tailcomp.status], ['blocked', ['filters'], 'possible'], 'the filters gate the cyclic gains; the governor is a cause of the tail compensation');
    st = run([f('p1', 'P1', { profile: null }), f('g3', 'G3'), f('c1', 'C1', { axis: 'roll' }), f('t2', 'T2')]);
    assert.deepEqual([st.startHere, st.nodes.cyclic.status, st.nodes.cyclic.after, st.nodes.tail.status, st.nodes.tail.after], [[], 'problem', ['power', 'governor'], 'problem', ['power', 'governor']]);
    // no problem before: start here in both lanes
    st = run([f('c1', 'C1', { axis: 'roll' }), f('t2', 'T2')]);
    assert.deepEqual(st.startHere, ['cyclic', 'tail']);
});

test('round 2: D2 is a logging problem only for a loss of 1 % of the frames; the RPM signal gates only the RPM notch filters', () => {
    const d2 = (events) => ({ fid: 'd', module: 'setup', id: 'D2', severity: 'flag', log: 1, profile: null, value: 1, n: 1e5, events });
    const st = (F) => H.status(F, F.map(x => ({ id: x.id, severity: 'check', evidence: [{ fid: x.fid }] })), {});
    assert.equal(st([d2([{ t: 1, value: 26, kind: 'loop stall (time jump, iteration contiguous: no frame lost)' }])]).nodes.logging.status, 'ok', 'a loop stall is no clearly measurable issue');
    assert.equal(st([d2([{ t: 1, value: 20, kind: 'time jump' }])]).nodes.logging.status, 'ok', '0.02 % of the frames lost');
    const lost = st([d2([{ t: 1, value: 2000, kind: 'time jump' }])]);
    assert.deepEqual([lost.nodes.logging.status, lost.prereqProblems], ['problem', ['logging']], '2 % of the frames lost');
    // G1 with a low-pass filter problem: the filters start; with an RPM notch problem they are blocked
    const g1 = { fid: 'g', id: 'G1', severity: 'flag', log: 1, profile: null }, f1 = { fid: 'a', id: 'F1', severity: 'flag', log: 1, profile: null }, f5 = { fid: 'b', id: 'F5', severity: 'flag', log: 1, profile: 1 };
    assert.deepEqual(st([g1, f1]).startHere, ['filters']);
    const b = st([g1, f1, f5]); assert.deepEqual([b.nodes.filters.status, b.nodes.filters.blockedBy, b.startHere], ['blocked', ['rpm'], []]);
    assert.deepEqual(H.scopeOf('rpm', 'filters'), ['F3', 'F5', 'F6', 'F9']); assert.equal(H.scopeOf('filters', 'cyclic'), null);
});

test('round 2: a gate of a prerequisite holds only for its checks (fromChecks): a ground resonance holds the cyclic gains, a loose tail linkage the tail gains', () => {
    const f = (fid, id, extra) => Object.assign({ fid, id, severity: 'flag', log: 1, profile: 1 }, extra), st = (F) => H.status(F, F.map(x => ({ id: x.id, severity: 'check', evidence: [{ fid: x.fid }] })), {});
    assert.deepEqual([H.fromChecksOf('mechanics', 'cyclic'), H.fromChecksOf('mechanics', 'tail'), H.fromChecksOf('controller', 'cyclic'), H.fromChecksOf('rpm', 'filters')], [['F7', 'C15', 'SETUP'], ['F7', 'T4'], ['SETUP'], null]);
    let s = st([f('a', 'C15', { axis: 'roll' }), f('b', 'C1', { axis: 'roll' }), f('c', 'T2')]);
    assert.deepEqual([s.nodes.cyclic.status, s.nodes.tail.status, s.startHere], ['blocked', 'startHere', ['tail']]);
    s = st([f('a', 'T4'), f('b', 'C1', { axis: 'roll' }), f('c', 'T2')]);
    assert.deepEqual([s.nodes.cyclic.status, s.nodes.tail.status, s.startHere], ['startHere', 'blocked', ['cyclic']]);
    // L7, the collective stick at its end, is never a problem of the flight controller
    const l7 = f('l', 'L7', { module: 'limits', channel: 'collectiveCommand', value: 0.9, n: 1 });
    s = H.status([l7], [{ id: 'L7:collectiveCommand:p1', severity: 'watch', evidence: [{ fid: 'l' }] }], {});
    assert.deepEqual([s.nodes.controller.status, C.status(l7)], ['ok', 'monitor']);
});

test('round 2: the chips of a block are groups of its parameters with the checks that inform each', () => {
    for (const b of H.BLOCKS) { assert.ok(b.chips.length >= 3, b.id);
        for (const c of b.chips) { assert.ok(c.label && c.params.length >= 1 && c.params.every(p => b.params.includes(p)), `${b.id} ${c.label}: ${c.params}`); assert.ok(c.checks.every(x => b.checks.some(y => y.split(':')[0] === x)), `${b.id} ${c.label}: checks of the block`); }
        const covered = new Set(b.chips.flatMap(c => c.params)); assert.ok(b.params.filter(p => !covered.has(p)).length <= 1, `${b.id}: parameters in no chip ${b.params.filter(p => !covered.has(p))}`); }
});
