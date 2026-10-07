'use strict';

// tools/autotune/catalog.cjs: one entry for each check id, its STE summary of a finding and its status.
//   node --test test/catalog.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const C = require('../tools/autotune/catalog.cjs');
const H = require('../tools/autotune/hierarchy.cjs');

const NEW = ['D7', 'G15', 'G16', 'G17', 'G18', 'C15'];   // health_phase.cjs (SPEC2 D13, section 6)
const RESCUE = ['G19', 'T15', 'D8', 'G20'];                     // health_rescue.cjs
const LIMITS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']; // health_limits.cjs (CLAUDE.md "Control limits")
const ROUND2 = ['D9', 'P1', 'P2'];                          // health_config.cjs and health_power.cjs (SPEC3 A, I)
const IDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'H', 'SETUP', 'R1', 'C7'].concat(Array.from({ length: 11 }, (_, i) => `F${i + 1}`), Array.from({ length: 15 }, (_, i) => `G${i}`),
    Array.from({ length: 14 }, (_, i) => `C${i + 1}`).filter(id => id !== 'C7'), Array.from({ length: 14 }, (_, i) => `T${i + 1}`), NEW, RESCUE, LIMITS, ROUND2);
const SOURCES = ['events', 'blocks', 'windows', 'runs', 'header', 'flight'];
const KINDS = ['time', 'spectrum', 'transmission', 'phase', 'governor', 'events', 'scatter', 'table'];

// The words of a sentence as STE counts them (rule 8.6, simplified): a number with its unit, "n ± m unit", a quoted or
// code text, an identifier, a parameter name, a field and a hyphenated word are one word each; text in parentheses is one word
function words(sentence) {
    return sentence.replace(/`[^`]*`|"[^"]*"/g, 'Q').replace(/\([^)]*\)/g, 'P').replace(/[−-]?\d[\d.,]*(\s*±\s*\d[\d.,]*)?\s*(%|‰|Hz|kHz|ms|s|deg\/s²|deg\/s|V|dB|rpm|x)?(?=[\s.,]|$)/g, 'N')
        .split(/\s+/).filter(w => /[A-Za-z0-9±]/.test(w));
}
const sentences = (text) => String(text).replace(/\([^)]*\)/g, 'P').split(/(?<=[.!?])\s+(?=[A-Z0-9"`])/).filter(Boolean);
function steProblems(text) {
    const paras = String(text).split('\n');
    if (paras.length > 2) return [`${paras.length} paragraphs (2 or fewer)`];
    if (paras.length === 2) return [].concat(...paras.map(steProblems));
    const out = [], t = String(text).replace(/`[^`]*`/g, 'Q').replace(/"[^"]*"/g, 'Q');
    if (!/^[A-Z0-9−]/.test(text) || !/\.$/.test(text)) out.push('starts in upper case and ends with a period');
    if (/;/.test(t)) out.push('semicolon');
    if (/\b(e\.g|i\.e|etc|vs)\b\.?/i.test(t)) out.push('Latin abbreviation');
    if (/n't\b|'(re|ve|ll|s)\b/i.test(t)) out.push('contraction');
    if (/\+-|>=|<=|->|!=|\|\w/.test(t)) out.push('math in text');
    if (/\b(above|below|over|under|within|per|exceed\w*)\b/i.test(t)) out.push('a limit word that STE does not approve');
    if (/\b(undefined|null|NaN|Infinity|\[object)\b/.test(t)) out.push('a value leaks');
    if (/\b(finding|findings|lag|log at|need|needs|should|would|may)\b/i.test(t)) out.push('a word of the denylist');
    const s = sentences(text);
    if (s.length < 1 || s.length > 6) out.push(`${s.length} sentences (1 to 6)`);
    for (const x of s) if (words(x).length > 25) out.push(`${words(x).length} words: ${x}`);
    return out;
}

// synthetic findings of a check at each severity, with the fields its module gives (tools/autotune/health_*.cjs judge)
const AXIS = { C1: 'roll', C3: 'pitch', C4: 'roll', C5: 'roll', C6: 'pitch', C10: 'roll', C11: 'pitch', C12: 'roll', C13: 'pitch', R1: 'roll', F10: 'yaw', F11: 'pitch', T1: 'yaw', T2: 'yaw', T9: 'yaw', T11: 'yaw', T12: 'yaw', C15: 'roll' };
// the unit that each new check writes in these fixtures (P3 writes `unit` on every finding; the catalog follows it)
const NEW_UNIT = { D7: 's', G15: 'deg/s', G16: 'fraction', G17: 'count', G18: 'fraction', C15: 'deg/s' };
const VALUE = { '%': 0.348, Hz: 120, dB: 12.3, ms: 32.8, s: 1.33, V: 3.42, 'deg/s': 36.2, x: 4.06 };
function finding(id, severity) {
    const c = C.CHECKS[id], f = { id, severity: severity === 'thin' ? 'note' : severity, log: 57, profile: 1, value: null, se: null, n: 12, threshold: null, source: 'pipeline, unvalidated', text: 'toolkit text' };
    if (AXIS[id]) f.axis = AXIS[id];
    f.value = c.scale === 100 ? 0.348 : VALUE[c.unit] !== undefined ? VALUE[c.unit] : 0.62; f.se = f.value / 10;
    if (severity === 'thin') Object.assign(f, { thin: true, text: 'no finding: 2 blocks', n: 2 });
    if (id === 'F4') Object.assign(f, { profile: 'roll', value: 15, se: null });
    if (id === 'D2') Object.assign(f, { profile: null, value: 0, events: [{ t: 300.1, value: 26, kind: 'loop stall (time jump, iteration contiguous: no frame lost)', unit: 'ms' }, { t: 12, value: 2, kind: 'time jump', unit: 'frames' }] });
    if (id === 'H') Object.assign(f, { profile: 'start profile 1', value: '60,100,0,100,0', text: 'rollPID: 50,100,0,100,0 -> 60,100,0,100,0 (since log 47, start profile 1)' });
    if (id === 'F8') f.value = severity !== 'note';
    if (id === 'C7') Object.assign(f, { axis: 'pitch', bin: 2500, change: severity === 'flag', changes: [{ gain: 'F', from: 100, to: 80 }], dTrack: 1.2, seTrack: 0.4 });
    if (id === 'T4') f.other = { log: 58, profile: 2 };
    if (id === 'T5') f.larger = 'ccw';
    if (id === 'C6' || id === 'T2') f.hz = 1.2;
    if ((id === 'C5' || id === 'T1') && severity === 'flag') Object.assign(f, { value: 2, se: null, unit: 'count', events: [{ t: 30.2, value: 160 }, { t: 51, value: 151 }] });
    if (id === 'F10') f.unit = 'fraction';
    if (id === 'C14') Object.assign(f, { gainChange: 26, from: 0 });
    if (id === 'T14') Object.assign(f, { value: 32, se: 6, from: 0 });
    if (id === 'D4') f.profile = 0;
    if (id === 'G0' && severity === 'note') f.value = 0;
    if (NEW_UNIT[id]) Object.assign(f, { unit: NEW_UNIT[id], phase: { D7: null, G15: 'spoolup', G16: 'spoolup', G17: 'idle', G18: 'idle', C15: 'ground' }[id] });
    if (id === 'D7') Object.assign(f, { profile: null, value: 312.4, se: null, flights: 2 });
    if (id === 'G17') Object.assign(f, { value: 2, se: null });
    if (id === 'C15') f.hz = 8.46;
    return f;
}
const SEVERITIES = ['flag', 'note', 'thin', 'ok', 'skipped', 'error'];
const VARIANTS = [
    Object.assign(finding('F10', 'note'), { axis: 'roll', unit: 'permille', value: 1.23, se: 0.05 }),
    Object.assign(finding('C10', 'flag'), { axis: undefined, profile: null, value: 2.5, n: 3 }),
    Object.assign(finding('D5', 'flag'), { evidence: { facts: { kind: 'low' } }, value: 2.31 }),
    Object.assign(finding('D5', 'flag'), { evidence: { facts: { kind: 'step' } }, value: -1.4 }),
    Object.assign(finding('F6', 'flag'), { evidence: { facts: { axis: 'roll', hz: 130.5 } } }),
    Object.assign(finding('F5', 'flag'), { evidence: { facts: { hz: 155.4 } } }),
    Object.assign(finding('G9', 'flag'), { evidence: { facts: { hz: 0.46, band: 'I' } } }),
    Object.assign(finding('C10', 'note'), { evidence: { facts: { bin: '0-2' } } }),
    Object.assign(finding('G4', 'flag'), { threshold: { minStep: 0.3, flag: 0.03, minEvents: 3, source: 'x' }, log: [12, 13, 15] }),
    Object.assign(finding('G13', 'flag'), { threshold: 3.3 }),
    Object.assign(finding('C12', 'ok'), { profile: 0 }),
    Object.assign(finding('G8', 'note'), { value: 1 }),
    Object.assign(finding('C5', 'flag'), { value: 1, events: [{ t: 30.2, value: 160 }] }),
    Object.assign(finding('G6', 'flag'), { value: 67.7, se: null, evidence: { facts: { runs: 1 } } }),
    { id: 'D9', severity: 'skipped', log: null, profile: null, text: 'The analysis has no flight log. Thus, this check did not operate.' },   // health_setup gives no D4 result without a CLI dump
    { id: 'TRACK', severity: 'error', log: 3, text: 'analyse failed: x is not defined' },
];

test('entries: every check id, with noun, unit, scale, node, tab, evidence spec and template', () => {
    assert.deepEqual(Object.keys(C.CHECKS).sort(), IDS.slice().sort());
    for (const id of IDS) {
        const c = C.CHECKS[id];
        assert.equal(c.id, id);
        assert.ok(typeof c.noun === 'string' && c.noun.split(/\s+/).length <= 3 && /^[a-zA-Z][a-zA-Z -]*$/.test(c.noun), `${id}: noun "${c.noun}", 3 words or fewer`);
        assert.equal(typeof c.unit, 'string'); assert.ok([1, 100].includes(c.scale), id);
        const node = typeof c.node === 'function' ? c.node(id === 'C7' ? 'yaw' : null, {}) : c.node;
        assert.ok(H.NODES.some(n => n.id === node), `${id}: node ${node}`);
        assert.ok(C.TABS.includes(c.tab), `${id}: tab ${c.tab}`);
        const e = c.evidence;
        assert.ok(SOURCES.includes(e.source), `${id}: source ${e.source}`);
        assert.ok(Array.isArray(e.pads) && e.pads.length === 2 && e.pads.every(v => typeof v === 'number' && v >= 0), `${id}: pads`);
        assert.ok(Array.isArray(e.fields) && e.fields.every(g => Array.isArray(g) && g.every(k => typeof k === 'string')), `${id}: fields`);
        assert.equal(e.source === 'header', e.fields.length === 0, `${id}: a header check has no viewer fields`);
        assert.ok(e.analyser === null || typeof e.analyser === 'string', id);
        assert.ok(KINDS.includes(e.plot.kind), `${id}: plot ${e.plot.kind}`);
        assert.equal(typeof e.expected, 'function'); assert.equal(typeof c.template, 'function');
    }
    assert.equal(C.nodeOf({ id: 'C7', axis: 'yaw' }), 'tail'); assert.equal(C.nodeOf({ id: 'C7', axis: 'roll' }), 'cyclic');
    assert.equal(C.nodeOf({ id: 'C12', axis: 'roll' }), 'cyclic'); assert.equal(C.nodeOf({ id: 'SETUP' }), 'controller'); assert.equal(C.nodeOf({ id: 'F4', profile: 'yaw' }), 'filters');
    // K2, K3: the tuner link and the subsystem of every check
    for (const id of IDS) { const f = { id, axis: id === 'C7' ? 'yaw' : undefined }; assert.ok(C.AREAS.includes(C.areaOf(f)), `${id}: area ${C.areaOf(f)}`); assert.equal(typeof C.tunerOf(f), 'boolean', id); }
    assert.deepEqual(['P1', 'D9', 'G17', 'G3', 'G12', 'F5', 'L4', 'T8', 'T6', 'C12', 'R1', 'D1', 'C7'].map(id => C.areaOf({ id, axis: id === 'C7' ? 'yaw' : 'roll' })),
        ['power', 'radio', 'motor', 'governor', 'rpm', 'vibration', 'limits', 'limits', 'tail', 'cyclic', 'radio', 'logging', 'tail']);
    assert.deepEqual(['P1', 'D9', 'G12', 'D1', 'T4', 'G3', 'F5', 'T8', 'C14'].map(id => C.tunerOf({ id })), [false, false, false, false, false, true, true, true, true]);
});

test('summaries: every check at every severity, 2 paragraphs or fewer of 1 to 6 STE sentences of 25 words or fewer (simple local check)', () => {
    const problems = [];
    for (const id of IDS) for (const sev of SEVERITIES) {
        const f = finding(id, sev), s = C.summary(f);
        assert.equal(typeof s, 'string');
        for (const p of steProblems(s)) problems.push(`${id} ${sev}: ${p} -- ${s}`);
    }
    for (const f of VARIANTS) for (const p of steProblems(C.summary(f))) problems.push(`${f.id} variant: ${p} -- ${C.summary(f)}`);
    for (const id of IDS) { const e = C.CHECKS[id].evidence.expected(finding(id, 'flag')); if (e !== null) for (const p of steProblems(e)) problems.push(`${id} expected: ${p} -- ${e}`); }
    assert.deepEqual(problems, []);
});

test('summaries: the number, its uncertainty and the limit; facts from the evidence (the second paragraph)', () => {
    const s = (f) => C.summary(f).split('\n').pop();
    assert.equal(s(Object.assign(finding('C12', 'flag'), { value: 0.524, se: 0.031 })), 'In PID profile 1, the roll tracking error is 52.4 ± 3.1 % of the setpoint. The limit is 45 %. At more than 30 %, the result is "Monitor".');
    assert.equal(s(finding('C13', 'note')), 'In PID profile 1, the pitch gyro follows the setpoint with a time delay of 32.8 ± 3.3 ms. The limit is 120 ms.');
    assert.equal(s(Object.assign(finding('G2', 'flag'), { value: -0.0134, se: 0.0021 })), 'In PID profile 1, the median headspeed error in stable flight is −1.34 ± 0.21 % of the target. The limit is 1 %. Also, 90 % of the samples must be in ±2 % of the target.');
    assert.equal(s(finding('D2', 'flag')), 'The log has 1 sudden time change, 1 loop stall and 0 frames with a time that does not increase. The limit is 1 % of the frames missing. A loop stall is information, and a smaller number of missing frames is a value to monitor. At the time jumps, 2 of 12 frames are missing (16.67 %).');
    // D2 (SPEC3 A): a problem only for a loss of 1 % of the frames or more; a loop stall alone is information, a smaller loss a value to monitor
    const d2 = (events, n) => C.status(Object.assign(finding('D2', 'flag'), { events, n }));
    assert.deepEqual([d2([{ t: 1, value: 26, kind: 'loop stall (time jump, iteration contiguous: no frame lost)' }], 1e5), d2([{ t: 1, value: 20, kind: 'time jump' }], 1e5), d2([{ t: 1, value: 2000, kind: 'time jump' }], 1e5)], ['information', 'monitor', 'problem']);
    assert.equal(s(VARIANTS[4]), 'In PID profile 1, the roll notch filter at 131 Hz decreases its peak by 12.3 ± 1.2 dB. The minimum is 10 dB.');
    assert.equal(s(finding('F6', 'flag')), 'In PID profile 1, an RPM notch filter decreases its peak by 12.3 ± 1.2 dB. The minimum is 10 dB.', 'without the facts of evidence.cjs');
    assert.equal(s(finding('H', 'note')), 'The header value `rollPID` changes from `50,100,0,100,0` to `60,100,0,100,0` after log 48.');
    assert.equal(s(finding('C12', 'thin')), 'In PID profile 1, the log has 2 periods of 10 s with sufficient roll stick movement. A minimum of 4 is necessary.');
    assert.equal(s(finding('G2', 'thin')), 'In PID profile 1, the log has 2 samples of stable governor flight. A minimum of 10 s is necessary.');
    assert.equal(s(VARIANTS[14]), 'The analysis has no flight log. Thus, this check did not operate.');
    // user rule 2026-10-06: the log is the only necessary input. No summary asks for a CLI dump or says that a check needs one
    const d9 = (unknownProfiles) => C.summary({ id: 'D9', severity: 'note', thin: true, unknownProfiles, profile: null, text: 'x' });
    assert.equal(d9([4, 5, 6]), 'The analysis cannot find if the rescue is on in PID profiles 4, 5 and 6. The log header does not record `rescue_mode`. The log records a rescue only when it occurs, and the logs show no rescue in these PID profiles.');
    for (const id of IDS) for (const sev of SEVERITIES) assert.doesNotMatch(C.summary(finding(id, sev)), /Load a CLI dump|did not load|diff all/, `${id} ${sev}`);
    assert.doesNotMatch(d9([4]) + C.summary({ id: 'D4', severity: 'skipped', log: 3, text: 'x' }), /CLI dump|diff all/);
    assert.equal(s(VARIANTS[15]), 'This check did not operate because of an analysis error. The toolkit text gives the cause.');
    assert.equal(s(finding('C7', 'flag')), 'At 2500 rpm, the model calculates that pitch_f_gain 80 decreases the tracking error by 1.2 ± 0.4 deg/s. A change must decrease the tracking error by 10 % or more, and by 2 standard errors (SE) or more.');
    assert.equal(s(VARIANTS[8]), 'In PID profile 1, the headspeed is 34.8 ± 3.5 % more than the target after a collective change. The limit is 3 %.', 'the RULES object of the finding');
    assert.equal(s(VARIANTS[12]), 'In PID profile 1, the roll rate has 1 oscillation that increases with no stick input. Each oscillation of this type is a problem.');
    assert.match(s(VARIANTS[13]), /^In PID profile 1, the median throttle is 67\.7 %, and the throttle stays at its limit in 1 period of 0\.1 s or more\. The limit is 85 %\./);
    assert.equal(s(VARIANTS[10]), 'In an unknown PID profile, the roll tracking error is 34.8 ± 3.5 % of the setpoint. The limit is 45 %. At more than 30 %, the result is "Monitor".');
    // the limit follows the finding's threshold object over the module's DEFAULT_RULES
    assert.match(s(Object.assign(finding('G4', 'flag'), { threshold: { flag: 0.05 } })), /The limit is 5 %\./);
    assert.equal(C.rulesOf({ id: 'G2', threshold: { median: 0.02 } }, C.CHECKS.G2).median, 0.02);
    assert.equal(C.rulesOf({ id: 'G2', threshold: 'text' }, C.CHECKS.G2).band, 0.02, 'a string threshold keeps the module rule');
});

test('status: SPEC2 D9', () => {
    const st = (o) => C.status(Object.assign({ id: 'C12', severity: 'note', text: '' }, o));
    assert.equal(st({ severity: 'flag' }), 'problem');
    assert.equal(st({ severity: 'flag', explained: 'Already filtered' }), 'information');
    assert.equal(st({ severity: 'note' }), 'monitor');
    assert.equal(st({ id: 'C13' }), 'information', 'report-only check');
    assert.equal(st({ id: 'F10', axis: 'roll', unit: 'permille' }), 'information', 'the control noise of roll is report only');
    assert.equal(st({ id: 'F10', axis: 'yaw', se: 0.02 }), 'monitor');
    assert.equal(st({ thin: true }), 'insufficient');
    assert.equal(st({ text: 'no finding: 1 blocks of 10 s' }), 'insufficient', 'the other modules write "no finding"');
    assert.equal(st({ severity: 'ok' }), 'satisfactory');
    assert.equal(st({ severity: 'ok', text: 'no finding: nothing to attenuate' }), 'satisfactory', 'only a note is thin');
    assert.equal(st({ severity: 'skipped' }), 'notMeasured');
    assert.equal(st({ severity: 'error' }), 'error');
    assert.equal(C.status(null), 'notMeasured');
    assert.equal(st({ id: 'UNKNOWN' }), 'monitor');
    for (const k of ['problem', 'monitor', 'information', 'insufficient', 'satisfactory', 'notMeasured', 'error']) assert.ok(C.LABELS[k]);
    assert.deepEqual([C.LABELS.insufficient, C.LABELS.notAccurate, C.LABELS.possible, C.LABELS.startHere], ['Not sufficient data', 'Not accurate (log rate)', 'Possible result', 'Start here']);
});

test('format and units: fractions show as %, the SE keeps one significant digit', () => {
    let v = C.format({ id: 'C12', value: 0.348, se: 0.042, n: 9, profile: 2, axis: 'pitch', log: 4 });
    assert.deepEqual([v.value, v.unit, v.scale, v.profile, v.In, v.axis, v.log, v.n], ['34.8 ± 4.2 %', '%', 100, 'PID profile 2', 'In PID profile 2, ', 'pitch', 'log 5', '9']);
    v = C.format({ id: 'G12', value: 0.99938, se: 0.00004 }); assert.equal(v.value, '0.99938 ± 0.00004 x');
    v = C.format({ id: 'C13', value: 72.4, se: 3.12 }); assert.equal(v.value, '72.4 ± 3.1 ms');
    v = C.format({ id: 'G3', value: -0.0213, se: null, log: [3, 4] }); assert.deepEqual([v.value, v.logs], ['−2.13 %', 'log 4, log 5']);
    assert.equal(C.unitOf({ id: 'C5', severity: 'flag' }), ''); assert.equal(C.unitOf({ id: 'C5', severity: 'note' }), '%');
    assert.equal(C.unitOf({ id: 'F10', axis: 'pitch', unit: 'permille' }), '‰'); assert.equal(C.unitOf({ id: 'NEW', unit: 'deg/s' }), 'deg/s');
    assert.equal(C.pair(1.5, null, 's'), '1.5 s'); assert.equal(C.pair(null, 1, 's'), null); assert.equal(C.fmt(-0.00001, 2), '0');
});

test('new checks (health_phase.cjs, SPEC2 section 6): the unit of the finding chooses the sentence; home steps and phases', () => {
    const f = (id, o) => Object.assign({ id, severity: 'note', log: 50, profile: 1, n: 4, value: null, se: null, threshold: null, text: 'toolkit text' }, o);
    const cases = [
        [f('D7', { profile: null, unit: 's', value: 312.4, flights: 2 }), 'The log has 2 flights. They have a total of 312 s in the air. The attitude checks use only the flight time.'],
        [f('D7', { profile: null, unit: 's', value: 0, flights: 0 }), 'The log has no flight. Thus, the analysis does not use this log.'],
        [f('D7', { profile: null, unit: 's', value: 0, logClass: 'bench' }), 'The log has no flight. Thus, the analysis does not use this log.'],
        [f('D7', { profile: null, unit: 's', value: 77.2, phaseSeconds: { flight: 77.2, ground: 9 } }), 'The log has 77.2 s of flight. The attitude checks use only the flight time.'],
        [f('G15', { unit: 'deg/s', value: 41, se: 3, phase: 'spoolup', threshold: { yawFlag: 150, yawNote: 50, limit: 50 } }),
            'In PID profile 1, during the spool-up, the largest yaw rate on the ground is 41 ± 3 deg/s. The limit is 150 deg/s. At more than 50 deg/s, the result is "Monitor".'],
        [f('G15', { unit: '%/s', value: 3.86, se: 0.16, threshold: 5 }), 'In PID profile 1, during the spool-up, the throttle increases at 3.86 ± 0.16 %/s. The limit is 5 %/s.'],
        [f('G15', { unit: 's', value: 9.55, se: 0.41, profile: null }), 'The spool-up time is 9.55 ± 0.41 s.'],
        [f('G16', { unit: 'fraction', value: 0.0046, se: 0.0006, severity: 'flag', threshold: { flag: 0.002, settleS: 1 }, settleS: 1.6, reference: 'govTarget' }),
            'In PID profile 1, at the change from SPOOLUP to ACTIVE, the headspeed is 0.46 ± 0.06 % more than the target. The limits are 0.2 % and 1 s to become stable. The headspeed becomes stable in 1.6 s.'],
        [f('G16', { unit: 'fraction', value: -0.012, se: 0.001, threshold: { flag: 0.03, settleS: 1 }, settleS: 0, reference: 'settled headspeed' }),
            'In PID profile 1, at the change from SPOOLUP to ACTIVE, the headspeed is 1.2 ± 0.1 % less than the stable headspeed. The limits are 3 % and 1 s to become stable. The headspeed stays stable after the change.'],
        [f('G16', { unit: 's', value: 1.2, threshold: { flag: 0.03, settleS: 1 } }), 'In PID profile 1, after the change from SPOOLUP to ACTIVE, the headspeed becomes stable in 1.2 s. The limit is 1 s.'],
        [f('G17', { unit: 'count', value: 2, phase: 'idle', severity: 'flag', profile: 0, threshold: { flag: 1 } }),
            'In an unknown PID profile, at IDLE, the motor output or the headspeed has 2 sudden steps that the throttle does not command. Each sudden step of this type is a problem.'],
        [f('G17', { unit: 'count', value: 0, severity: 'ok', profile: null }), 'The motor output and the headspeed have no sudden step that the throttle does not command. Each sudden step of this type is a problem.'],
        [f('G17', { unit: 'fraction', value: 0.041 }), 'In PID profile 1, the largest sudden step of the headspeed at a constant throttle is 4.1 %.'],
        [f('G18', { unit: 'fraction', value: 0.013, se: 0.004, phase: 'idle', profile: null, threshold: { flag: 0.05 } }), 'At IDLE, the RMS change of the headspeed is 1.3 ± 0.4 %. The limit is 5 %.'],
        [f('C15', { unit: 'deg/s', value: 9.2, axis: 'roll', hz: 8.46, growth: 3.3, growthSe: 0.7, severity: 'flag', phase: 'ground', threshold: { peak: 5, sig: 2 } }),
            'In PID profile 1, before the helicopter becomes airborne, the roll rate has an oscillation of 9.2 deg/s RMS at 8.46 Hz on the landing gear. The oscillation increases at 3.3 ± 0.7 /s. The limit is 5 deg/s RMS. An oscillation at the limit or more that increases is a problem.'],
        [f('C15', { unit: 'deg/s', value: 6, axis: 'pitch', hz: 10.1, growth: 0.2, growthSe: 0.5, threshold: { peak: 5 } }),
            'In PID profile 1, before the helicopter becomes airborne, the pitch rate has an oscillation of 6 deg/s RMS at 10.1 Hz on the landing gear. The oscillation does not increase. The limit is 5 deg/s RMS. An oscillation at the limit or more that increases is a problem.'],
        [f('C15', { unit: 'deg/s', value: 0, axis: null, severity: 'ok', profile: null, threshold: { peak: 5 } }),
            'Before the helicopter becomes airborne, the roll and pitch rates have no oscillation on the landing gear. The limit is 5 deg/s RMS. An oscillation at the limit or more that increases is a problem.'],
        [f('C15', { unit: '/s', value: 3.3, se: 0.7, axis: 'roll' }), 'In PID profile 1, before the helicopter becomes airborne, the roll oscillation on the landing gear increases at 3.3 ± 0.7 /s.'],
        [f('C15', { unit: 'count', value: 3, axis: 'pitch' }), 'In PID profile 1, the log has 3 pitch oscillations on the landing gear before the helicopter becomes airborne.'],
        [f('G15', { thin: true, n: 1 }), 'In PID profile 1, the log has 1 spool-up. This is not sufficient for a result.'],
        [f('G18', { thin: true, n: 2, profile: null, threshold: { flag: 0.05, minWindows: 3 } }), 'The log has 2 periods of 0.5 s at IDLE with a constant motor output. A minimum of 3 is necessary.'],
        [f('C15', { thin: true, n: 0, profile: null, threshold: { peak: 5, minS: 1 } }), 'Before the helicopter becomes airborne, the log has less than 1 s on the ground with the rotor at the flight headspeed. This is not sufficient for a result.'],
        [f('G18', { unit: 'volts', value: 2 }), 'In PID profile 1, the value of this check is 2 `volts`.'],
    ];
    for (const [x, want] of cases) assert.equal(C.summary(x).split('\n').pop(), want, JSON.stringify(x));
    assert.deepEqual(NEW.map(id => C.nodeOf({ id, axis: id === 'C15' ? 'roll' : undefined })), ['controller', 'governor', 'governor', 'governor', 'governor', 'mechanics']);
    const byId = (id, k = 0) => cases.filter(c => c[0].id === id)[k][0];
    assert.deepEqual([C.unitOf(byId('G15', 1)), C.unitOf(byId('G16')), C.unitOf(byId('G17')), C.unitOf(byId('G18', 2)), C.unitOf({ id: 'G16' })], ['%/s', '%', '', 'volts', '%']);
    assert.equal(C.format(byId('G16')).value, '0.46 ± 0.06 %', 'a fraction shows as %');
    assert.equal(C.status(cases[0][0]), 'information', 'D7 gives information');
    assert.equal(C.status(byId('C15')), 'problem'); assert.equal(C.status(byId('C15', 1)), 'monitor'); assert.equal(C.status(byId('G18', 1)), 'insufficient');
    // the phases each check uses (SPEC2 D13 correction): attitude and filter checks the flight only, governor and power all phases
    const ALL = ['idle', 'spoolup', 'ground', 'flight', 'spooldown'];
    for (const id of IDS) { const p = C.CHECKS[id].phases; assert.ok(p === null || (Array.isArray(p) && p.length && p.every(x => ALL.includes(x))), `${id}: phases ${p}`);
        assert.equal(p === null, C.CHECKS[id].evidence.source === 'header', `${id}: header checks have no phase`); }
    for (const id of ['C12', 'T11', 'C5', 'T1', 'C11', 'F5', 'F10', 'F11', 'R1', 'C7']) assert.deepEqual(C.CHECKS[id].phases, ['flight'], id);
    for (const id of ['G1', 'G6', 'G13', 'D5', 'G14', 'D7']) assert.deepEqual(C.CHECKS[id].phases, ALL, id);
    assert.deepEqual(['G15', 'G16', 'G17', 'G18', 'C15'].map(id => C.CHECKS[id].phases), [['spoolup'], ['spoolup', 'ground', 'flight'], ['idle', 'spoolup', 'ground'], ['idle'], ['ground']], 'G16: a change after the liftoff is in flight');
});

test('G16 after the liftoff (review D-M5c): the summary says that a longer spool-up time does not correct it', () => {
    const f = { id: 'G16', severity: 'flag', log: 0, profile: 1, n: 1, unit: 'fraction', value: 0.0711, se: null, threshold: { flag: 0.03, settleS: 1 }, settleS: 1.0, reference: 'govTarget',
        phase: 'flight', afterLiftoff: true, liftoffT: 7.279, afterLiftoffS: 1.274 };
    assert.equal(C.summary(f).split('\n').pop(), 'In PID profile 1, at the change from SPOOLUP to ACTIVE, the headspeed is 7.11 % more than the target. The limits are 3 % and 1 s to become stable. '
        + 'A longer spool-up time does not correct this error, because the change comes 1.27 s after the liftoff.');
    assert.equal(C.CHECKS.G16.evidence.expected(f), 'The governor is ACTIVE before the liftoff. Then the headspeed goes to the target with no overshoot.');
    assert.match(C.summary(Object.assign({}, f, { afterLiftoffS: null })), /because the change comes in flight\.$/);
    assert.match(C.summary(Object.assign({}, f, { afterLiftoff: false })), /The headspeed becomes stable in 1 s\.$/);
    assert.equal(C.CHECKS.G16.evidence.expected(Object.assign({}, f, { afterLiftoff: false })), 'At the change to ACTIVE, the headspeed goes to the target with no overshoot and no step of the throttle.');
});

test('F5 (review D-M5a): the summary states for each axis if a notch filter is near the peak; the plot shows the peak and the notch filters', () => {
    const f = (axes) => Object.assign(finding('F5', 'flag'), { value: 4.07, se: null, evidence: { facts: { hz: 156.2, axes } } });
    const axes = [{ axis: 'roll', near: true, distance: 0.015, hz: 153.9 }, { axis: 'pitch', near: true, distance: 0.015, hz: 153.9 }, { axis: 'yaw', near: false, distance: 0.082, hz: 169 }];
    assert.equal(C.summary(f(axes)).split('\n').pop(), 'In PID profile 1, the raw gyro has a peak at 4.07 x the rotor frequency (156 Hz). The yaw axis has no notch filter near this peak, but the roll and pitch axes have one. '
        + 'A peak of 5 x the median level or more with no notch filter in ±2 % of its frequency is a problem.');
    assert.match(C.summary(f(axes.map(q => Object.assign({}, q, { near: false })))), / No axis has a notch filter near this peak\. /);
    assert.match(C.summary(f([axes[0], axes[2]])), / The yaw axis has no notch filter near this peak, but the roll axis has one\. /);
    assert.match(C.summary(f(undefined)), / One or more axes have no notch filter near this peak\. /, 'without the facts: true for each flag');
    assert.doesNotMatch(C.summary(f(axes)), /No notch filter is near/);
    const ref = C.CHECKS.F5.evidence.plot.reference(f(axes), C.rulesOf(f(axes), C.CHECKS.F5), { hz: 156.2, axes });
    assert.deepEqual(ref.map(r => [r.kind, r.value, r.unit, r.label]), [['vline', 156.2, 'Hz', 'Peak 156 Hz'], ['vline', 153.9, 'Hz', 'Roll notch filter 154 Hz'], ['vline', 153.9, 'Hz', 'Pitch notch filter 154 Hz'], ['vline', 169, 'Hz', 'Yaw notch filter 169 Hz']]);
});

test('C5 and T1 (review D-M5g): the reference lines are the rule of the check, not the 10, 20 and 40 deg/s levels', () => {
    for (const id of ['C5', 'T1']) {
        const ref = (f) => C.CHECKS[id].evidence.plot.reference(f, C.rulesOf(f, C.CHECKS[id]), {}).filter(Boolean).map(r => [r.value, r.unit, r.label]);
        assert.deepEqual(ref(finding(id, 'flag')), [[30, 'deg/s', 'Start: less than 30 deg/s'], [150, 'deg/s', 'Problem: 150 deg/s or more after 6 half cycles']], `${id} flag: an oscillation that increases from less than 30 to 150 deg/s`);
        assert.deepEqual(ref(finding(id, 'note')), [[20, 'deg/s', 'Limit 20 deg/s for 5 % of the time']], `${id} note: the share at the level`);
        assert.deepEqual(ref(Object.assign(finding(id, 'note'), { threshold: { level: 40, share: 0.1 } })), [[40, 'deg/s', 'Limit 40 deg/s for 10 % of the time']], 'the threshold of the finding');
    }
    const T = require('../tools/autotune/health_track.cjs');
    assert.deepEqual([T.RULE.osc.onset.small, T.RULE.osc.onset.high, T.RULE.osc.onset.minHalfCycles, T.DEFAULT_RULES.C5.level, T.DEFAULT_RULES.C5.share], [30, 150, 6, 20, 0.05], 'the rule that the lines show');
});

test('T8 references: the tail output limits of the log (evidence.cjs facts, permille)', () => {
    const f = finding('T8', 'flag'), ref = C.CHECKS.T8.evidence.plot.reference(f, C.rulesOf(f, C.CHECKS.T8), { tailLimits: { lo: -498, hi: 500 } });
    assert.deepEqual(ref.map(r => [r.value, r.unit, r.label]), [[-498, '‰', 'Tail output limit −498 ‰'], [500, '‰', 'Tail output limit 500 ‰']]);
    assert.deepEqual(C.CHECKS.T8.evidence.plot.reference(f, {}, {}), []);
});

test('profiles (SPEC2 D12): "PID profile 1-6", "PID profile unknown" for 0 or arm; D4, F4 and H have no log profile', () => {
    const p = (o) => C.profileOf(Object.assign({ id: 'C12' }, o));
    assert.deepEqual([p({ profile: 1 }), p({ profile: '3' }), p({ profile: 0 }), p({ profile: 'arm' }), p({ profile: 'unknown' }), p({ profile: null }), p({}), p({ profile: 'global' })], [1, 3, 0, 0, 0, null, null, null]);
    assert.deepEqual([p({ id: 'D4', profile: 0 }), p({ id: 'F4', profile: 'roll' }), p({ id: 'H', profile: 'start profile 1' })], [null, null, null]);
    assert.deepEqual([C.profileLabel(2), C.profileLabel(0), C.profileLabel(null)], ['PID profile 2', 'PID profile unknown', null]);
    const v = (o) => C.format(Object.assign({ id: 'C12', axis: 'roll', value: 0.3 }, o));
    assert.deepEqual([v({ profile: 2 }).In, v({ profile: 0 }).In, v({ profile: 'arm' }).profile, v({}).In, v({ id: 'D4', profile: 0 }).In], ['In PID profile 2, ', 'In an unknown PID profile, ', 'PID profile unknown', '', '']);
    assert.match(C.summary({ id: 'C12', severity: 'note', axis: 'roll', profile: 'arm', value: 0.3, se: 0.02 }).split('\n').pop(), /^In an unknown PID profile, the roll tracking error is 30 ± 2 % of the setpoint\./);
    assert.equal(C.summary({ id: 'D4', severity: 'note', profile: 0, thin: true }), 'The log does not have sufficient data for this check.', 'the CLI index of D4 is not a log profile');
    // the worker's pidProfile (1-6) comes first, as hierarchy.cjs profileKey and js/tuning_dialog.js profileNo: one label for each finding
    assert.deepEqual([p({ profile: 0, pidProfile: 2 }), p({ profile: 'arm', pidProfile: 3 }), p({ profile: 0, pidProfile: null }), p({ profile: 1, pidProfile: 7 }), p({ id: 'D4', profile: 1, pidProfile: 2 })], [2, 3, 0, 1, 2]);
    assert.equal(H.profileKey ? H.profileKey({ id: 'C12', profile: 0, pidProfile: 2 }) : '2', '2', 'the hierarchy agrees');
    assert.match(C.summary({ id: 'C12', severity: 'note', axis: 'roll', profile: 0, pidProfile: 2, value: 0.3, se: 0.02 }).split('\n').pop(), /^In PID profile 2, the roll tracking error is 30 ± 2 % of the setpoint\./);
    assert.equal(C.format({ id: 'C12', profile: 0, pidProfile: 2, value: 0.3 }).profile, 'PID profile 2');
});

test('GEAR RULE (SPEC2 section 6): no text tells that a gear ratio, a pulley or a tooth count can be incorrect; G12 states that the gear ratios are correct', () => {
    const GEAR = { test: (t) => /\b(gears?|pulleys?|tooth|teeth)\b/i.test(String(t).replace(/landing gear/gi, 'skids')) }; // the landing gear is not a gear
    const ALLOWED = new Set(['The gear ratios in the configuration are correct.', 'Because the gear ratios in the configuration are correct, the cause is the motor pole count or the RPM sensor.',
        'The log header does not give the gear ratios.']);
    const texts = [];
    for (const id of IDS) { const c = C.CHECKS[id]; texts.push(c.noun); for (const sev of SEVERITIES) { const f = finding(id, sev); texts.push(C.summary(f), c.evidence.expected(f), c.template(f, C.format(f), {}));
        const ref = c.evidence.plot.reference; if (typeof ref === 'function') for (const r of ref(f, C.rulesOf(f, c), {}).filter(Boolean)) texts.push(r.label); } }
    for (const f of VARIANTS) texts.push(C.summary(f));
    for (const sev of SEVERITIES) texts.push(C.summary(Object.assign(finding('G12', sev), { value: sev === 'flag' ? 1.1 : 1.0004, se: 0.001 })), C.summary(Object.assign(finding('F9', sev), { value: 0 })));
    const bad = [];
    for (const t of texts.filter(x => typeof x === 'string')) for (const s of sentences(t)) if (GEAR.test(s) && !ALLOWED.has(s)) bad.push(s);
    assert.deepEqual(bad, []);
    // G12 states the rule at each severity with a result, and a G12 flag names the motor pole count or the RPM sensor
    for (const sev of ['flag', 'note', 'ok', 'thin']) assert.match(C.summary(finding('G12', sev)), /The gear ratios in the configuration are correct\.|Because the gear ratios in the configuration are correct,/, sev);
    assert.match(C.summary(Object.assign(finding('G12', 'flag'), { value: 1.1 })), /the cause is the motor pole count or the RPM sensor\.$/);
    assert.equal(C.CHECKS.G12.noun, 'headspeed scale');
    // and in the source: every string of catalog.cjs that names a gear is one of the allowed sentences
    const src = fs.readFileSync(path.join(__dirname, '../tools/autotune/catalog.cjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const strings = [...src.matchAll(/'([^'\n]*)'|`([^`\n]*)`/g)].map(m => m[1] !== undefined ? m[1] : m[2]).filter(x => GEAR.test(x));
    for (const x of strings) for (const s of sentences(x)) if (GEAR.test(s)) assert.ok(ALLOWED.has(s), `catalog.cjs: "${s}"`);
});

test('a value that the template cannot show, and the singular of a count of 1', () => {
    const s = C.summary({ id: 'C12', severity: 'flag', axis: 'roll', profile: 1, value: '100,80', se: null, threshold: 0.45 });
    assert.ok(!/\b(null|undefined|NaN)\b/.test(s), s);
    assert.match(s.split('\n').pop(), /^The result has no value\. The toolkit text gives the result\. The limit is 45 %/);
    for (const id of IDS) for (const sev of SEVERITIES) { const t = C.summary(Object.assign(finding(id, sev), { value: '100,80', se: null, n: null })); assert.ok(!/\b(null|undefined|NaN)\b|\[object/.test(t), `${id} ${sev}: ${t}`); }
    assert.equal(C.summary(Object.assign(finding('C12', 'thin'), { n: 1 })), 'In PID profile 1, the log has 1 period of 10 s with sufficient roll stick movement. A minimum of 4 is necessary.');
    assert.equal(C.summary(Object.assign(finding('G3', 'thin'), { n: 1 })), 'In PID profile 1, the log has 1 large collective increase. A minimum of 3 is necessary.');
});

test('loading (catalog, hierarchy, evidence): siblings only, no Node API, Chromium 99 syntax; the catalog and the hierarchy work without their optional modules', () => {
    const ROOT = path.join(__dirname, '..'), src = (f) => fs.readFileSync(path.join(ROOT, 'tools/autotune', f), 'utf8');
    for (const f of ['catalog.cjs', 'hierarchy.cjs', 'evidence.cjs']) {
        const code = src(f).replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of code.matchAll(/require\(([^)]*)\)/g)) assert.match(m[1], /^'\.\/[a-z_]+\.cjs'$|^name$/, `${f}: require(${m[1]})`);
        assert.ok(!/\bprocess\.|\bBuffer\b|__dirname|__filename|['"]node:/.test(code), `${f}: no Node API`);
        assert.ok(/module\.exports = \{[^}]*\};\s*$/.test(code), `${f}: module.exports at the end`);
    }
    let esbuild = null; try { esbuild = require('esbuild'); } catch (e) { /* optional */ }
    if (esbuild) for (const f of ['catalog.cjs', 'hierarchy.cjs', 'evidence.cjs']) { const t = (target) => esbuild.transformSync(src(f), { target, format: 'cjs', loader: 'js' }).code; assert.equal(t('chrome99'), t('esnext'), f); }
    // through a CommonJS shim that has none of the optional modules (js/tuning_worker.js OPTIONAL): what they give is lost, the rest works
    const load = (f, have) => { const m = { exports: {} }; new Function('require', 'module', 'exports', src(f))((n) => { if (!have.includes(n)) throw new Error(`Cannot find module '${n}'`); return require(path.join(ROOT, 'tools/autotune', n)); }, m, m.exports); return m.exports; };
    const bare = load('catalog.cjs', []);
    assert.equal(bare.summary({ id: 'C12', severity: 'flag', axis: 'roll', profile: 1, value: 0.52, se: 0.03 }).split('\n').pop(), 'In PID profile 1, the roll tracking error is 52 ± 3 % of the setpoint.', 'no DEFAULT_RULES: no limit');
    assert.equal(bare.nodeOf({ id: 'C12', axis: 'roll' }), null, 'no hierarchy: no home step');
    const Hb = load('hierarchy.cjs', []), st = Hb.status([{ fid: 'a', id: 'F5', severity: 'flag', log: 1, profile: 1 }, { fid: 'b', id: 'C12', severity: 'note', log: 1, profile: 1, thin: true }], null);
    assert.deepEqual([st.startHere, st.nodes.cyclic.status, st.profiles], [['filters'], 'insufficient', ['1']], 'no catalog: the status of a finding from its severity');
});

// review V5, V6: what the views show of a finding (display): the quantity that the rule compares, with its unit and meaning,
// and the limit in the unit of that value. Never a bare count, never a toolkit threshold, the same with and without curves
const BARE = /^[−-]?\d[\d.,]*(?: ± [\d.,]+)?$/;
const TOOLKIT = />=|<=|\|\w|\bimplicated\b|\bruledOut\b|\bminWindows\b|\bmaxJumps\b|\bgaps <=|\bI share\b|\bprominence >=/;
const UNIT_TOKEN = /(?:^|\s)(%|‰|Hz|ms|s|V|dB|deg\/s|x)(?=[\s,.)]|$)/;
test('display (review V5, V6): every check at every severity gives a value with its unit or meaning and a limit in the unit of the value', () => {
    for (const id of IDS) for (const sev of SEVERITIES.concat('variant')) {
        const list = sev === 'variant' ? VARIANTS.filter(f => f.id === id) : [finding(id, sev)];
        for (const f of list) {
            const d = C.display(f), what = `${id} ${f.severity}${f.thin ? ' thin' : ''}: ${JSON.stringify(d)}`;
            assert.deepEqual(Object.keys(d).sort(), ['bound', 'limit', 'phase', 'profile', 'scale', 'unit', 'value'], what);
            assert.ok(d.value === null || (typeof d.value === 'string' && !BARE.test(d.value)), `no bare number: ${what}`);
            assert.ok(d.bound === null || (typeof d.bound === 'string' && !TOOLKIT.test(d.bound) && !/\.$/.test(d.bound)), `a bound in STE words: ${what}`);
            assert.ok(d.value === null || !/\b(null|undefined|NaN)\b/.test(d.value), what);
            if (f.severity === 'skipped' || f.severity === 'error') { assert.deepEqual([d.limit, d.bound], [null, null], what); continue; }
            // the unit of the value is in the limit (G12: x, the tolerance in x; C7: a relative decrease, no bound)
            const u = d.value && d.bound ? UNIT_TOKEN.exec(d.value.split(' from ')[0]) : null;   // not the unit of the data that a thin result has
            if (u) assert.ok(new RegExp(`(^|\\s|±)${u[1].replace('/', '\\/')}(?=[\\s,.)]|$)`).test(d.bound) || d.bound.includes(` ${u[1]} `) || d.bound.startsWith(`${u[1]} `), `the limit in the unit of the value (${u[1]}): ${what}`);
        }
    }
});

test('display (review V5): D2, G0, F5, D5, G10, T6 and T13 show the quantities of their rule', () => {
    // D2: the cause of the flag (a loop stall, which the value of check D2 does not count) and the limit of each type
    const d2 = C.display(finding('D2', 'flag'));
    assert.deepEqual([d2.value, d2.bound], ['1 sudden time change and 1 loop stall', '1 % of the frames missing']);
    assert.equal(C.display(Object.assign(finding('D2', 'flag'), { events: [], evidence: { facts: { counts: { jumps: 0, stalls: 0, back: 0, iterations: 0 } } } })).value, '0 frame time errors');
    assert.equal(C.display(Object.assign(finding('D2', 'ok'), { events: [] })).value, '0 sudden time changes', 'without the events: the value of the check, with its meaning');
    // G0: a count with its meaning (the review saw the bare "291028")
    assert.equal(C.display(Object.assign(finding('G0', 'ok'), { value: 291028, n: 291871 })).value, '291028 of 291871 flight samples with a governor output');
    // F5: the prominence and the distance to the nearest notch filter, which the rule compares (the order "3 x" next to "prominence >= 5" read as a pass)
    const axes = [{ axis: 'roll', near: true, distance: 0.015, hz: 153.9 }, { axis: 'pitch', near: true, distance: 0.015, hz: 153.9 }, { axis: 'yaw', near: false, distance: 0.25, hz: 169 }];
    const f5 = Object.assign(finding('F5', 'flag'), { value: 2.9989, se: null, evidence: { facts: { hz: 224.9, prominence: 33.6, axes } } }), d5 = C.display(f5);
    assert.equal(d5.value, '33.6 x the median level at 3 x the rotor frequency, 25 % from the nearest yaw notch filter');
    assert.equal(d5.bound, '5 x the median level or more, with no notch filter in ±2 %');
    assert.equal(d5.limit, 'A peak of 5 x the median level or more with no notch filter in ±2 % of its frequency is a problem.');
    assert.doesNotMatch(C.summary(f5), /must/, 'review V5: no instruction in the limit');
    // F5 that a recommendation explains (Information): the summary says why, and no row says that it must have a notch filter
    const ex = Object.assign({}, f5, { explained: 'The filters remove the vibration line', filterPass: [{ hz: 224.9, roll: 0.0041, pitch: 0.004, yaw: 0.006 }] });
    assert.match(C.summary(ex), /The gyro filters let only 0\.4 %, 0\.4 % and 0\.6 % of this peak through \(roll, pitch and yaw\)\. Thus, the analysis gives no notch filter for it\.$/);
    assert.doesNotMatch(C.summary(ex), /must/);
    // D5: the value and the limit of the kind of the result, in one unit; no limit line of 3 V on the Vbat of the pack
    const step = C.display(Object.assign(finding('D5', 'note'), { value: -0.24 })), low = C.display(Object.assign(finding('D5', 'flag'), { value: 2.31, evidence: { facts: { kind: 'low' } } }));
    assert.deepEqual([step.value, step.bound, step.unit], ['0.24 V in 10 ms', '1 V in 10 ms', 'V']);
    assert.deepEqual([low.value, low.bound, low.unit], ['2.31 s', '0.5 s', 's']);
    assert.deepEqual(C.CHECKS.D5.evidence.plot.reference(finding('D5', 'note'), C.rulesOf(finding('D5', 'note'), C.CHECKS.D5)), []);
    // G10: the coherence and its limit (the review saw "implicated 0.5, ruledOut 0.1, flatRpm 10, minWindows 8")
    const g10 = C.display(Object.assign(finding('G10', 'note'), { value: 0.567, se: 0.205, threshold: { implicated: 0.5, ruledOut: 0.1, flatRpm: 10, minWindows: 8, source: 'pipeline, unvalidated' } }));
    assert.deepEqual([g10.value, g10.bound], ['coherence 0.567 ± 0.205', '0.5 or more']);
    // T6 with not sufficient data: the value, its unit and the data that it comes from (the review saw the bare "55")
    const t6 = C.display(Object.assign(finding('T6', 'thin'), { value: 55, se: null, n: 2 }));
    assert.equal(t6.value, '55 deg/s from 2 collective steps with the yaw stick stable');
    // T13: the same limit with and without the tail output range of the log (file scope had "|I share| - 2 SE > 0.15")
    const t13 = Object.assign(finding('T13', 'flag'), { value: -0.212, se: 0.016, threshold: '|I share| - 2 SE > 0.15' });
    const file = C.display(Object.assign({}, t13, { evidence: { facts: { authorityPermille: 1250, iPermille: -265 } } }));
    assert.deepEqual([C.display(t13).value, C.display(t13).bound], ['−21.2 ± 1.6 %', '±15 %']);
    assert.deepEqual([file.value, file.bound, file.limit], [C.display(t13).value, C.display(t13).bound, C.display(t13).limit]);
});

// round 3 M3: the Analysis overview counts issues, not findings: one issue for each check and axis over the logs, the PID profiles
// and the configurations, ranked by status and by the size of the result against its limit; a card of small issues is "Monitor"
test('issues: one for each check and axis, the size against the limit, the rank, the 3 most important and the status of each card', () => {
    const F = [
        { fid: 'a', module: 'track', id: 'C12', severity: 'flag', axis: 'roll', log: 1, profile: 1, pidProfile: 1, dataset: 'A', value: 0.6, se: 0.02, n: 10 },
        { fid: 'b', module: 'track', id: 'C12', severity: 'flag', axis: 'roll', log: 2, profile: 2, pidProfile: 2, dataset: 'B', value: 0.5, se: 0.02, n: 10 },
        { fid: 'c', module: 'track', id: 'C12', severity: 'note', axis: 'pitch', log: 1, profile: 1, pidProfile: 1, dataset: 'A', value: 0.35, se: 0.02, n: 10 },
        { fid: 'd', module: 'loop', id: 'T8', severity: 'flag', log: 1, profile: 1, pidProfile: 1, dataset: 'A', value: 0.4, n: 5, threshold: '>= 1 episode' },
        { fid: 'e', module: 'gov', id: 'G2', severity: 'flag', log: 1, profile: 1, pidProfile: 1, value: 0.011, se: 0.0001, n: 100 },
        { fid: 'f', module: 'setup', id: 'D1', severity: 'flag', log: 1, profile: null, value: 500, threshold: 'nominal >= 1000 Hz' },
        { fid: 'g', module: 'limits', id: 'L4', severity: 'flag', axis: 'yaw', log: 2, profile: 2, pidProfile: 2, value: 0.5, n: 3, unit: 's', threshold: { longS: 0.1, combined: 2, error: 30 }, longestS: 0.2, worstError: { kind: 'yaw', value: 60, limit: 30 } },
        { fid: 'h', module: 'power', id: 'P1', severity: 'note', log: 1, profile: null, value: 0.1, se: 0.01, n: 5, unit: 'V', minCell: 3.0, limits: { min: 3.3, warning: 3.5 }, threshold: { min: 3.3, warning: 3.5, minSteps: 3 } },
        { fid: 'i', module: 'track', id: 'C12', severity: 'ok', axis: 'yaw', log: 1, profile: 1, value: 0.1, se: 0.01, n: 10 },
        { fid: 'j', module: 'track', id: 'T11', severity: 'note', thin: true, axis: 'yaw', log: 1, profile: 1, value: 0.3, n: 1 }];
    const out = C.issues(F), by = Object.fromEntries(out.issues.map(x => [x.key, x]));
    assert.deepEqual(Object.keys(by).sort(), ['C12|pitch', 'C12|roll', 'D1|', 'G2|', 'L4|yaw', 'P1|', 'T8|yaw'], 'satisfactory and not sufficient data are no issue');
    const r = by['C12|roll'];
    assert.deepEqual([r.status, r.count, r.logs, r.profiles, r.datasets, r.fids, r.area, r.node, r.tuner, r.small], ['problem', 2, [1, 2], [1, 2], ['A', 'B'], ['a', 'b'], 'cyclic', 'cyclic', true, false]);
    assert.equal(r.size, 1.33, 'value / limit of the largest result: 60 % against 45 %');
    assert.deepEqual([r.range.min, r.range.max, r.range.unit, r.range.text], [50, 60, '%', '50 % to 60 %']);
    assert.equal(r.title, 'Roll tracking error');
    assert.match(r.summary, /^.+\. The largest result is 60 ± 2 %\. The limit is 45 %\. There are 2 results \(logs 2 and 3, PID profiles 1 and 2\)\.$/);
    assert.deepEqual([by['C12|pitch'].status, by['C12|pitch'].small, by['C12|pitch'].size], ['monitor', true, 0.78], 'a value to monitor under its limit is small');
    assert.deepEqual([by['T8|yaw'].size, by['T8|yaw'].small, by['T8|yaw'].title], [null, false, 'Tail output limit'], 'a limit of 0: no size, ranked as 2 x its limit, and the axis is not said twice');
    assert.equal(by['D1|'].size, 2, 'a minimum: 1000 Hz against 500 Hz');
    assert.equal(by['L4|yaw'].size, 2, 'an output limit: the largest of its longest period against 0.1 s (2) and its error against the limit (2)');
    assert.equal(by['P1|'].size, 1.1, 'the battery: the minimum cell voltage against the lowest at a load step');
    assert.deepEqual([by['G2|'].size, by['G2|'].small], [1.1, true]);
    // the rank: the problems first (not small first, then by size; a size of null as 2), then the values to monitor
    assert.deepEqual(out.issues.map(x => x.key), ['D1|', 'L4|yaw', 'T8|yaw', 'C12|roll', 'G2|', 'P1|', 'C12|pitch']);
    assert.deepEqual(out.issues.map(x => x.rank), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(out.top, ['D1|', 'L4|yaw', 'T8|yaw']);
    // the cards: a card with only small issues is "Monitor", not "Problem" (governor: G2 is a small problem)
    assert.deepEqual(Object.fromEntries(Object.entries(out.areas).map(([k, v]) => [k, [v.status, v.problems, v.monitors]])),
        { logging: ['problem', 1, 0], limits: ['problem', 2, 0], cyclic: ['problem', 1, 1], governor: ['monitor', 1, 0], power: ['monitor', 0, 1] });
    assert.deepEqual(C.issues([]), { issues: [], top: [], areas: {}, rules: C.ISSUE_RULES });
    // two values that the views show the same: one value in the range text
    const same = C.issues([F[0], Object.assign({}, F[0], { fid: 'k', log: 3, value: 0.6001 })]).issues[0];
    assert.deepEqual([same.range.text, same.count], ['60 %', 2]);
    for (const x of out.issues) for (const s of x.summary.split(/(?<=\.)\s+(?=[A-Z])/)) assert.ok(words(s).length <= 25, `${x.key}: ${s}`);
});
