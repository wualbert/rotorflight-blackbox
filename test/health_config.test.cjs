// Ground-truth checks for tools/autotune/health_config.cjs (D9: the rescue is on in every PID profile). CLI dumps with known
// rescue_mode values (a `diff all` with OFF and CLIMB sections, a `diff` with one section, a `dump`), and simulated 4.6 flights
// (test/helpers/bbl_encode.cjs simulateFlight, written as a .bbl and read back by the app's decoder) with a rescue in a PID
// profile that the log names and in the stretch before the first PID profile change (label 0). With the CLI dump of the
// Fireball in the scratchpad (fb1005/cli0904.txt, a `diff all`) when it exists, and with AUTOTUNE_RESCUE_LOG (the Fireball
// dump of 2026-10-05) the PID profiles that show a rescue.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const lib = require('../tools/autotune/lib.cjs');
const C = require('../tools/autotune/health_config.cjs');
const S = require('../tools/autotune/health_setup.cjs');
const bbl = require('./helpers/bbl_encode.cjs');

const app = lib.loadApp(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-'));
const only = (F, p) => { const l = F.filter(f => f.id === 'D9' && f.profile === p); assert.equal(l.length, 1, `D9 p${p}: one finding, got ${l.length}`); return l[0]; };
const FIELDS = ['id', 'severity', 'log', 'profile', 'value', 'se', 'n', 'threshold', 'source', 'unit', 'phase', 'thin', 'text'];

// a synthetic segment: the PID profile labels and the rescue state as lib.segments gives them (profileAt, rescueAt)
function seg(o) {
    const rate = 100, n = o.seconds * rate, profileAt = new Uint8Array(n), rescueAt = new Uint8Array(n), flightMask = new Uint8Array(n);
    for (const q of o.profiles) profileAt.fill(q.label, q.from * rate, (q.to === undefined ? o.seconds : q.to) * rate);
    for (const [a, b] of o.rescues || []) rescueAt.fill(1, a * rate, b * rate);
    flightMask.fill(1, (o.flight || [0, o.seconds])[0] * rate, (o.flight || [0, o.seconds])[1] * rate);
    const w = { n, rate, fromS: 0, profileAt, rescueAt, extra: {}, flight: { header: o.header || {} } };
    return C.analyse(w, { rate, flightMask, header: o.header || {} });
}
const DIFF_ALL = ['diff all', '', '# version', '# Rotorflight / STM32G47X (SG47) 4.6.0 Jun 30 2026 / 07:21:46 (118e912) MSP API: 12.9', 'set name = Test',
    '', 'profile 0', '', '# profile 0', 'set rescue_mode = CLIMB', 'set rescue_pull_up_collective = 700', 'set rescue_flip = OFF',
    '', 'profile 1', '', '# profile 1', 'set gov_headspeed = 2500', '', 'profile 2', '', 'set rescue_mode = ALT_HOLD', '', 'profile 3', '', 'profile 4', '', 'profile 5', '',
    '# restore original profile selection', 'profile 0', '', 'save'].join('\n');

test('module contract: the exports, then the require.main guard; no Node API call at load', () => {
    for (const k of ['EXTRA', 'RULE', 'DEFAULT_RULES', 'RESCUE', 'analyse', 'judge', 'rescueOfCli']) assert.ok(k in C, k);
    const src = fs.readFileSync(path.join(__dirname, '../tools/autotune/health_config.cjs'), 'utf8'), at = src.indexOf('module.exports'), guard = src.indexOf('if (require.main !== module) return;');
    assert.ok(at > 0 && guard > at && src.slice(at, guard).split('\n').length <= 2, 'module.exports, then the guard');
    assert.ok(!/require\('node:/.test(src.slice(0, guard)), 'no node: module before the guard');
    assert.equal(C.RESCUE.length, 18, 'the 18 rescue values of settings.c 4.6.0');
    assert.deepEqual(C.RESCUE.find(q => q.name === 'rescue_mode'), { name: 'rescue_mode', default: 'OFF', range: ['OFF', 'CLIMB', 'ALT_HOLD'] });
    assert.ok(Object.values(C.RULE.source).every(s => typeof s === 'string' && !/\.c\b|\.cjs\b|\//.test(s)), 'sources with no file name');
    assert.ok(/firmware 4\.6\.0/.test(C.DEFAULT_RULES.D9.source));
});

test('CLI diff all: rescue_mode of each PID profile, the default OFF for a section with no rescue_mode line, the other values', () => {
    const cli = S.parseCli(DIFF_ALL), q = C.rescueOfCli(cli);
    assert.equal(q.kind, 'diff'); assert.deepEqual(q.missing, []);
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(p => q.profiles[p].mode), ['CLIMB', 'OFF', 'ALT_HOLD', 'OFF', 'OFF', 'OFF']);
    assert.equal(q.profiles[1].params.rescue_pull_up_collective, 700); assert.equal(q.profiles[1].params.rescue_climb_collective, 450, 'the default of a diff');
    assert.ok(!q.profiles[1].defaults.includes('rescue_flip') && q.profiles[2].defaults.includes('rescue_mode'));
    const F = C.judge([], C.DEFAULT_RULES, { cli });
    assert.equal(F.length, 6, 'one finding for each PID profile, no unknown note');
    for (const f of F) for (const k of FIELDS) assert.ok(k in f, `${k} in D9 p${f.profile}`);
    const p1 = only(F, 1), p2 = only(F, 2), p3 = only(F, 3);
    assert.equal(p1.severity, 'ok'); assert.equal(p1.value, 1); assert.equal(p1.basis, 'cli'); assert.equal(p1.cliProfile, 0); assert.equal(p1.log, null); assert.equal(p1.phase, null); assert.equal(p1.unit, 'state');
    assert.match(p1.text, /`rescue_pull_up_collective = 700`/); assert.match(p1.text, /`rescue_flip = OFF`/);
    assert.equal(p2.severity, 'flag'); assert.equal(p2.value, 0); assert.equal(p2.mode, 'OFF');
    assert.match(p2.text, /^In PID profile 2, the rescue switch does not start a rescue/); assert.match(p2.text, /no `rescue_mode` line in `profile 1`/);
    assert.ok(p2.text.indexOf('rescue switch') < p2.text.indexOf('helicopter does not level') && p2.text.indexOf('helicopter does not level') < p2.text.indexOf('The limit is'), 'what it does, why, then the limit');
    assert.equal(p3.severity, 'ok'); assert.equal(p3.mode, 'ALT_HOLD');
    for (const p of [4, 5, 6]) assert.equal(only(F, p).severity, 'flag');
    assert.ok(F.every(f => !/(?<!PID )\bprofile [0-9]\b/.test(f.text.replace(/`[^`]*`/g, ''))), 'CLI profile numbers only in code font');
    assert.ok(F.every(f => !/PID profile 0\b/.test(f.text)), 'PID profiles 1-6 in the text');
});

test('CLI diff of one PID profile: that profile, and one note with the others unknown; a dump gives every value', () => {
    const one = S.parseCli(['# diff', 'set name = Test', 'profile 2', '', 'set rescue_mode = CLIMB'].join('\n'));
    const F = C.judge([], C.DEFAULT_RULES, { cli: one });
    assert.equal(only(F, 3).severity, 'ok');
    const note = only(F, null); assert.equal(note.severity, 'note'); assert.equal(note.thin, true); assert.deepEqual(note.unknownProfiles, [1, 2, 4, 5, 6]);
    assert.match(note.text, /does not have PID profiles 1, 2, 4, 5 and 6/);
    // no instruction to load a CLI dump (user rule 2026-10-06): what the log records instead
    assert.doesNotMatch(note.text, /`diff all`|Load a CLI dump/); assert.match(note.text, /The log records a rescue only when it occurs\./);
    // a dump: a section with no rescue_mode line is not the default, it is unknown
    const dump = S.parseCli(['# dump', 'set name = Test', 'profile 0', 'set rescue_mode = OFF', 'profile 1', 'set rescue_climb_time = 10'].join('\n'));
    assert.equal(dump.kind, 'dump');
    const G = C.judge([], C.DEFAULT_RULES, { cli: dump });
    assert.equal(only(G, 1).severity, 'flag'); assert.match(only(G, 1).text, /`set rescue_mode = OFF` in `profile 0`/);
    assert.equal(only(G, 2).severity, 'note'); assert.equal(only(G, 2).thin, true); assert.equal(only(G, 2).value, null);
    assert.deepEqual(only(G, null).unknownProfiles, [3, 4, 5, 6]);
    // a CLI text is parsed too; numbers are the lookup index
    assert.equal(C.rescueOfCli(DIFF_ALL).profiles[3].mode, 'ALT_HOLD'); assert.equal(C.modeName(1), 'CLIMB'); assert.equal(C.modeName('climb'), 'CLIMB'); assert.equal(C.modeName(7), null);
});

test('CLI with logs: flight time and rescues of each PID profile; a rescue in a PID profile that the dump has OFF is a conflict', () => {
    const flights = [{ log: 3, metrics: seg({ seconds: 60, profiles: [{ label: 1, from: 0, to: 30 }, { label: 2, from: 30 }], rescues: [[40, 42]], flight: [5, 55] }) }];
    const F = C.judge(flights, C.DEFAULT_RULES, { cli: S.parseCli(DIFF_ALL), arming: {} });
    const p1 = only(F, 1), p2 = only(F, 2);
    assert.equal(p1.flown, true); assert.equal(p1.flightS, 25); assert.equal(p1.rescues, 0); assert.match(p1.text, /25 s of flight/);
    assert.equal(p2.severity, 'flag'); assert.equal(p2.conflict, true); assert.equal(p2.rescues, 1); assert.match(p2.text, /possibly not from the time of these logs/);
    assert.equal(only(F, 4).flown, false); assert.match(only(F, 4).text, /no flight in this PID profile/);
});

test('no CLI dump: a rescue in a named PID profile shows the rescue on; label 0 counts only with a confirmed arming profile', () => {
    // decoder round trip: PID profile 1 at arming (not logged), PID profile 2 from 20 s; rescues at 12 s (label 0) and 30 s (label 2)
    const log = bbl.simulateFlight({ seed: 5, profiles: [{ from: 0, profile: 1, target: 2500 }, { from: 20, profile: 2, target: 2600 }], rescue: [30, 32] });
    for (let i = 12000; i < 12800; i++) log.rescueState[i] = i < 12300 ? 1 : 3;
    const file = path.join(tmp, 'sim.bbl'); fs.writeFileSync(file, bbl.encode([log]).bytes);
    const [w] = [...lib.segments(app, file, { whole: true, extra: ['time'] })].filter(q => !q.skipped);
    const m = C.analyse(w, { rate: w.flight.actualRate, header: w.flight.header });
    assert.deepEqual(m.rescues.map(e => [e.label, Math.round(e.tS)]), [[0, 12], [2, 30]], 'rescue starts with the raw labels');
    assert.ok(m.labels['0'].seconds > 19 && m.labels['2'].seconds > 39, JSON.stringify(m.labels));
    assert.deepEqual(m.header, {}, 'a 4.6 header has no rescue value');
    const flights = [{ log: 0, header: w.flight.header, metrics: JSON.parse(JSON.stringify(m)) }];
    const U = C.judge(flights, C.DEFAULT_RULES, { arming: { 0: { profile: 1, confirmed: false } } });
    const p2 = only(U, 2); assert.equal(p2.severity, 'ok'); assert.equal(p2.basis, 'log'); assert.deepEqual(p2.log, [0]); assert.equal(p2.n, 1);
    assert.match(p2.text, /^In PID profile 2, the logs show 1 rescue\. The firmware starts a rescue only if `rescue_mode` is not OFF\./);
    const note = only(U, null); assert.equal(note.thin, true); assert.deepEqual(note.unknownProfiles, [1, 3, 4, 5, 6]); assert.equal(note.unknownRescues, 1);
    assert.match(note.text, /does not record `rescue_mode`/); assert.match(note.text, /1 rescue in a part of the log with an unknown PID profile/);
    // the same log with the arming profile confirmed: the rescue at 12 s is in PID profile 1
    const K = C.judge(flights, C.DEFAULT_RULES, { arming: new Map([[0, { profile: 1, confirmed: true }]]) });
    assert.equal(only(K, 1).severity, 'ok'); assert.equal(only(K, 1).n, 1); assert.deepEqual(only(K, null).unknownProfiles, [3, 4, 5, 6]); assert.equal(only(K, null).unknownRescues, 0);
});

test('no CLI dump: a flown PID profile with no rescue is not known; a header with rescue_mode (not 4.6.0) gives the arming profile', () => {
    const flights = [{ log: 1, metrics: seg({ seconds: 40, profiles: [{ label: 3, from: 0 }] }) }, { log: 2, metrics: seg({ seconds: 40, profiles: [{ label: 0, from: 0 }], header: { rescue_mode: 0 } }) }];
    const F = C.judge(flights, C.DEFAULT_RULES, { arming: { 2: { profile: 5, confirmed: true } } });
    const p3 = only(F, 3); assert.equal(p3.severity, 'note'); assert.equal(p3.thin, true); assert.equal(p3.value, null); assert.deepEqual(p3.log, [1]);
    const p5 = only(F, 5); assert.equal(p5.severity, 'flag'); assert.equal(p5.basis, 'header'); assert.equal(p5.log, 2);
    assert.deepEqual(only(F, null).unknownProfiles, [1, 2, 3, 4, 6]);
    // the log is the only necessary input (user rule 2026-10-06): no text asks for a CLI dump
    assert.match(only(F, null).text, /The log records a rescue only when it occurs, and the logs show no rescue in these PID profiles\./);
    assert.ok(F.every(f => !/CLI dump|diff all/.test(f.text)), F.map(f => f.text).join(' | '));
    // a PID profile with less than RULE.minFlightS of flight is not flown
    const short = C.judge([{ log: 0, metrics: seg({ seconds: 10, profiles: [{ label: 4, from: 0 }], flight: [0, 0.5] }) }], C.DEFAULT_RULES, {});
    assert.equal(short.filter(f => f.profile === 4).length, 0);
});

test('no flight log and no CLI dump: skipped; a segment with no PID profile column is skipped in the judge', () => {
    const F = C.judge([], C.DEFAULT_RULES, {});
    assert.equal(F.length, 1); assert.equal(F[0].severity, 'skipped'); assert.equal(F[0].text, 'The analysis has no flight log. Thus, this check did not operate.');
    const m = C.analyse({ n: 100, rate: 100, fromS: 0, extra: {}, flight: { header: {} } }, { rate: 100 });
    assert.ok(m.skipped); assert.equal(C.judge([{ log: 0, metrics: m }], C.DEFAULT_RULES, {})[0].severity, 'skipped');
});

const CLI0904 = path.join('/private/tmp/claude-501/-Users-albertwu-exp-rotorflight-blackbox/fe443b68-6b54-474a-8562-5b78c52610ee/scratchpad', 'fb1005/cli0904.txt');
test('real: the CLI dump of the Fireball (diff all of 2026-09-04)', { skip: !fs.existsSync(CLI0904) ? 'the scratchpad CLI dump fb1005/cli0904.txt is not here' : false }, () => {
    const F = C.judge([], C.DEFAULT_RULES, { cli: S.parseCli(fs.readFileSync(CLI0904, 'utf8')) });
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(p => only(F, p).severity), ['ok', 'ok', 'ok', 'flag', 'flag', 'flag']);
    assert.deepEqual([1, 2, 3].map(p => only(F, p).mode), ['CLIMB', 'CLIMB', 'CLIMB']);
    assert.equal(F.filter(f => f.profile === null).length, 0, 'a diff all has all 6 sections');
});

const REAL = process.env.AUTOTUNE_RESCUE_LOG;
test('real: the PID profiles with a rescue in the Fireball dump 2026-10-05 (no CLI dump)', { skip: !REAL || !fs.existsSync(REAL) ? 'set AUTOTUNE_RESCUE_LOG to the Fireball dump of 2026-10-05' : false }, () => {
    const flights = [], arming = {};
    for (const w of lib.segments(app, REAL, { whole: true, extra: ['time'] })) {
        if (w.skipped || ![5, 13, 14, 15].includes(w.flight.log)) continue;   // the logs with the rescues (test/health_rescue.test.cjs)
        if (w.profileAt[0] > 0) arming[w.flight.log] = { profile: w.profileAt[0], confirmed: true };
        flights.push({ log: w.flight.log, header: w.flight.header, metrics: C.analyse(w, { rate: w.flight.actualRate, header: w.flight.header }) });
    }
    const F = C.judge(flights, C.DEFAULT_RULES, { arming }), ok = F.filter(f => f.severity === 'ok').map(f => f.profile);
    const n = flights.reduce((s, f) => s + f.metrics.rescues.length, 0);
    assert.ok(n >= 5, `the rescues of logs 6, 14, 15 and 16: ${n}`);
    assert.ok(ok.includes(1) && ok.includes(2), `PID profiles with a rescue: ${ok}`);
    assert.deepEqual(only(F, null).unknownProfiles.filter(p => ok.includes(p)), []);
    assert.ok(F.every(f => f.severity !== 'flag'), 'no CLI dump and a 4.6 header: no PID profile is shown OFF');
});
