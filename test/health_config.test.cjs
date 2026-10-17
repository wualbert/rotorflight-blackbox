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
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
// check D9 alone: health_config judge also gives D12 (the failsafe throttle, IMP-11), whose tests are at the end of this file
const judge9 = (...a) => C.judge(...a).filter(f => f.id === 'D9');
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
    const F = judge9([], C.DEFAULT_RULES, { cli });
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
    const F = judge9([], C.DEFAULT_RULES, { cli: one });
    assert.equal(only(F, 3).severity, 'ok');
    const note = only(F, null); assert.equal(note.severity, 'note'); assert.equal(note.thin, true); assert.deepEqual(note.unknownProfiles, [1, 2, 4, 5, 6]);
    assert.match(note.text, /does not have PID profiles 1, 2, 4, 5 and 6/);
    // no instruction to load a CLI dump (user rule 2026-10-06): what the log records instead
    assert.doesNotMatch(note.text, /`diff all`|Load a CLI dump/); assert.match(note.text, /The log records a rescue only when it occurs\./);
    // a dump: a section with no rescue_mode line is not the default, it is unknown
    const dump = S.parseCli(['# dump', 'set name = Test', 'profile 0', 'set rescue_mode = OFF', 'profile 1', 'set rescue_climb_time = 10'].join('\n'));
    assert.equal(dump.kind, 'dump');
    const G = judge9([], C.DEFAULT_RULES, { cli: dump });
    assert.equal(only(G, 1).severity, 'flag'); assert.match(only(G, 1).text, /`set rescue_mode = OFF` in `profile 0`/);
    assert.equal(only(G, 2).severity, 'note'); assert.equal(only(G, 2).thin, true); assert.equal(only(G, 2).value, null);
    assert.deepEqual(only(G, null).unknownProfiles, [3, 4, 5, 6]);
    // a CLI text is parsed too; numbers are the lookup index
    assert.equal(C.rescueOfCli(DIFF_ALL).profiles[3].mode, 'ALT_HOLD'); assert.equal(C.modeName(1), 'CLIMB'); assert.equal(C.modeName('climb'), 'CLIMB'); assert.equal(C.modeName(7), null);
});

test('CLI with logs: flight time and rescues of each PID profile; a rescue in a PID profile that the dump has OFF is a conflict', () => {
    const flights = [{ log: 3, metrics: seg({ seconds: 60, profiles: [{ label: 1, from: 0, to: 30 }, { label: 2, from: 30 }], rescues: [[40, 42]], flight: [5, 55] }) }];
    const F = judge9(flights, C.DEFAULT_RULES, { cli: S.parseCli(DIFF_ALL), arming: {} });
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
    const U = judge9(flights, C.DEFAULT_RULES, { arming: { 0: { profile: 1, confirmed: false } } });
    const p2 = only(U, 2); assert.equal(p2.severity, 'ok'); assert.equal(p2.basis, 'log'); assert.deepEqual(p2.log, [0]); assert.equal(p2.n, 1);
    assert.match(p2.text, /^In PID profile 2, the logs show 1 rescue\. The firmware starts a rescue only if `rescue_mode` is not OFF\./);
    const note = only(U, null); assert.equal(note.thin, true); assert.deepEqual(note.unknownProfiles, [1, 3, 4, 5, 6]); assert.equal(note.unknownRescues, 1);
    assert.match(note.text, /does not record `rescue_mode`/); assert.match(note.text, /1 rescue in a part of the log with an unknown PID profile/);
    // the same log with the arming profile confirmed: the rescue at 12 s is in PID profile 1
    const K = judge9(flights, C.DEFAULT_RULES, { arming: new Map([[0, { profile: 1, confirmed: true }]]) });
    assert.equal(only(K, 1).severity, 'ok'); assert.equal(only(K, 1).n, 1); assert.deepEqual(only(K, null).unknownProfiles, [3, 4, 5, 6]); assert.equal(only(K, null).unknownRescues, 0);
});

test('no CLI dump: a flown PID profile with no rescue is not known; a header with rescue_mode (not 4.6.0) gives the arming profile', () => {
    const flights = [{ log: 1, metrics: seg({ seconds: 40, profiles: [{ label: 3, from: 0 }] }) }, { log: 2, metrics: seg({ seconds: 40, profiles: [{ label: 0, from: 0 }], header: { rescue_mode: 0 } }) }];
    const F = judge9(flights, C.DEFAULT_RULES, { arming: { 2: { profile: 5, confirmed: true } } });
    const p3 = only(F, 3); assert.equal(p3.severity, 'note'); assert.equal(p3.thin, true); assert.equal(p3.value, null); assert.deepEqual(p3.log, [1]);
    const p5 = only(F, 5); assert.equal(p5.severity, 'flag'); assert.equal(p5.basis, 'header'); assert.equal(p5.log, 2);
    assert.deepEqual(only(F, null).unknownProfiles, [1, 2, 3, 4, 6]);
    // the log is the only necessary input (user rule 2026-10-06): no text asks for a CLI dump
    assert.match(only(F, null).text, /The log records a rescue only when it occurs, and the logs show no rescue in these PID profiles\./);
    assert.ok(F.every(f => !/CLI dump|diff all/.test(f.text)), F.map(f => f.text).join(' | '));
    // a PID profile with less than RULE.minFlightS of flight is not flown
    const short = judge9([{ log: 0, metrics: seg({ seconds: 10, profiles: [{ label: 4, from: 0 }], flight: [0, 0.5] }) }], C.DEFAULT_RULES, {});
    assert.equal(short.filter(f => f.profile === 4).length, 0);
});

// review IMP-05: a log with a parameter snapshot (blackbox_params FULL) gives rescue_mode and the other rescue values of every PID
// profile at its start. They rank above a CLI dump (the dump can be of a different time)
test('a parameter snapshot in the log header: D9 for every PID profile from the snapshot, above a CLI dump', () => {
    const PL = require('../tools/autotune/param_log.cjs');
    const body = [['Param log', '1'], ['param_mode', 'FULL'], ['param_loop', '1,1,1,128'], ['param_phase', 'pos=0,sp=0,pid=0,mix=0,mot=0,fupd=0,bb=0,flush=0'], ['param_pgs', '14.0/936'],
        ['param_fixes', '-'], ['param_rt', 'gov_mode=3,features=0,pid_denom=1,filter_denom=1,looptime=250,debug_mode=0,motors=1,servos=4'], ['param_pid_profile', '0'], ['param_rate_profile', '0'],
        ['set@p.rescue_mode', 'CLIMB|CLIMB|OFF|OFF|OFF|OFF'], ['set@p.rescue_climb_collective', '450|450|450|450|450|450']];
    let hash = 2166136261; for (const [k, v] of body) hash = PL.fnv1(`H ${k}:${v}\n`, hash);
    body.push(['param_end', `${body.length},${(hash >>> 0).toString(16)}`]);
    const header = { 'Firmware revision': 'Rotorflight 4.7.0-bbp-pr (85d7049a9) STM32G47X', paramHeader: body };
    assert.ok(PL.snapshotOf(header));
    const flights = [{ log: 0, header, metrics: seg({ seconds: 40, profiles: [{ label: 0, from: 0 }, { label: 3, from: 20 }] }) }];
    const cli = S.parseCli('# diff all\nprofile 0\nset rescue_mode = OFF\nprofile 2\nset rescue_mode = CLIMB\n');
    for (const extra of [{ arming: { 0: { profile: 1, confirmed: true } } }, { cli, arming: { 0: { profile: 1, confirmed: true } } }]) {
        const F = judge9(flights, C.DEFAULT_RULES, extra);
        assert.deepEqual([1, 2, 3, 4, 5, 6].map(p => only(F, p).severity), ['ok', 'ok', 'flag', 'flag', 'flag', 'flag'], JSON.stringify(F.map(f => [f.profile, f.severity])));
        assert.ok(F.filter(f => f.profile).every(f => f.basis === 'snapshot' && f.log === 0));
        assert.match(only(F, 3).text, /The log header of log 0 gives `rescue_mode = OFF` for this PID profile\./, 'a log number from 0, as every toolkit text (the app shows log 1)');
        assert.ok(!F.some(f => f.profile === null), 'no PID profile is unknown');
    }
    // the snapshot that the worker gives (extra.snapshots, with the records before the log start) wins over the header
    const none = judge9(flights, C.DEFAULT_RULES, { snapshots: { 0: null }, arming: { 0: { profile: 1, confirmed: true } } });
    assert.ok(!none.some(f => f.basis === 'snapshot'));
});

test('no flight log and no CLI dump: skipped; a segment with no PID profile column is skipped in the judge', () => {
    const F = judge9([], C.DEFAULT_RULES, {});
    assert.equal(F.length, 1); assert.equal(F[0].severity, 'skipped'); assert.equal(F[0].text, 'The analysis has no flight log. Thus, this check did not operate.');
    const m = C.analyse({ n: 100, rate: 100, fromS: 0, extra: {}, flight: { header: {} } }, { rate: 100 });
    assert.ok(m.skipped); assert.equal(judge9([{ log: 0, metrics: m }], C.DEFAULT_RULES, {})[0].severity, 'skipped');
});

const CLI0904 = path.join('/private/tmp/claude-501/-Users-albertwu-exp-rotorflight-blackbox/fe443b68-6b54-474a-8562-5b78c52610ee/scratchpad', 'fb1005/cli0904.txt');
test('real: the CLI dump of the Fireball (diff all of 2026-09-04)', { skip: !fs.existsSync(CLI0904) ? 'the scratchpad CLI dump fb1005/cli0904.txt is not here' : false }, () => {
    const F = judge9([], C.DEFAULT_RULES, { cli: S.parseCli(fs.readFileSync(CLI0904, 'utf8')) });
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
    const F = judge9(flights, C.DEFAULT_RULES, { arming }), ok = F.filter(f => f.severity === 'ok').map(f => f.profile);
    const n = flights.reduce((s, f) => s + f.metrics.rescues.length, 0);
    assert.ok(n >= 5, `the rescues of logs 6, 14, 15 and 16: ${n}`);
    assert.ok(ok.includes(1) && ok.includes(2), `PID profiles with a rescue: ${ok}`);
    assert.deepEqual(only(F, null).unknownProfiles.filter(p => ok.includes(p)), []);
    assert.ok(F.every(f => f.severity !== 'flag'), 'no CLI dump and a 4.6 header: no PID profile is shown OFF');
});

// ---------------------------------------------------------------------------------------------
// D12: the failsafe throttle, the response of the firmware when the receiver signal stops (IMP-11)
// ---------------------------------------------------------------------------------------------

const PLx = require('../tools/autotune/param_log.cjs');
// a log header with a complete FULL parameter snapshot (blackbox_params) with the values that D12 reads; o.set: { name: text } over
// the values of the Fireball (2026-10-15), o.rxfail: the text of el.rxfail.4 (mode,step: 0 AUTO, 1 HOLD, 2 SET; 875 + 5 x step µs)
function snapHeader(o = {}) {
    const set = Object.assign({ rc_center: '1500', rc_deflection: '510', rc_min_throttle: '0', rc_max_throttle: '0', gov_mode: 'ELECTRIC', gov_throttle_type: 'FUNCTION', gov_idle_throttle: '0',
        gov_auto_throttle: '0', gov_handover_throttle: '25', gov_autorotation_timeout: '15', gov_throttle_hold_timeout: '50', gov_spooldown_time: '80' }, o.set || {});
    const body = [['Param log', '1'], ['param_mode', 'FULL'], ['param_loop', '1,1,1,128'], ['param_phase', 'pos=0,sp=0,pid=0,mix=0,mot=0,fupd=0,bb=0,flush=0'], ['param_pgs', '14.0/936'],
        ['param_fixes', '-'], ['param_rt', 'gov_mode=3,features=0,pid_denom=1,filter_denom=1,looptime=250,debug_mode=0,motors=1,servos=4'], ['param_pid_profile', '0'], ['param_rate_profile', '0']]
        .concat(Object.entries(set).map(([k, v]) => [`set.${k}`, v]), [['el.rxfail.4', o.rxfail || '0,2']]);
    let hash = 2166136261; for (const [k, v] of body) hash = PLx.fnv1(`H ${k}:${v}\n`, hash);
    body.push(['param_end', `${body.length},${(hash >>> 0).toString(16)}`]);
    return { 'Firmware revision': 'Rotorflight 4.7.0-bbp-pr (85d7049a9) STM32G47X', firmwareVersion: '4.7.0', paramHeader: body };
}
// one flight log with that header; u: the throttle (0..1) at the last RC frame of a receiver signal loss (health_config analyse), with the
// rotor turning (rotor: false, a loss on the ground with the motor stopped)
const flightOf = (header, u, rotor = true) => ({ log: 0, header, metrics: Object.assign(seg({ seconds: 40, profiles: [{ label: 0, from: 0 }] }), { throttle: { atLoss: u === undefined ? [] : [{ tS: 30, u, rotor }], flight: 0.7, flightSamples: 100 } }) });
const d12 = (F) => { const l = F.filter(f => f.id === 'D12'); assert.equal(l.length, 1, `one D12 result, got ${l.length}`); return l[0]; };

test('D12: the default rxfail (AUTO) gives 1031 µs, the band off, THROTTLE_HOLD and the motor stop 0.3 s to 0.4 s after the last frame; no export line', () => {
    const f = d12(C.judge([flightOf(snapHeader(), 0.766)], C.DEFAULT_RULES, {})), A = require('../tools/autotune/advice.cjs');
    for (const k of FIELDS) assert.ok(k in f, k);
    assert.deepEqual([f.value, f.band, f.state, f.stateLog, f.cut, f.motorOffS, f.basis, f.log, f.phase, f.profile, f.severity, f.thin], [1031, 'off', 'THROTTLE_HOLD', 'HOLD', true, 0, 'snapshot', 0, null, null, 'note', false]);
    assert.deepEqual(f.cutDelayS, [0.3, 0.4]); assert.deepEqual(f.recovery, { to: 'RECOVERY', limitS: 5 }); assert.deepEqual(f.throttleRange, [1041, 1959]); assert.equal(f.offThrottle, 1036);
    assert.match(f.text, /^With `rxfail 4 a`, the firmware sets the throttle to 1031 µs at 0\.3 s to 0\.4 s after the last RC frame\. This value is less than the off value of the throttle \(1036 µs\)\. Thus, the governor changes from ACTIVE to HOLD, and the motor stops immediately\./);
    // the stage-2 note: failsafe stage 2 does not operate on 4.3 to 4.7, so its values have no effect
    assert.equal(f.stage2Off, true); assert.match(f.text, /On Rotorflight 4\.7\.0, failsafe "stage 2" does not operate\. Thus, `failsafe_delay`, `failsafe_procedure`, `failsafe_off_delay`, `failsafe_throttle_low_delay` and `failsafe_throttle` have no effect in flight\./);
    // the options and their risks as text, with the CLI commands in code font; no recommendation and no CLI line
    assert.match(f.text, /With `rxfail 4 s 1040` to `rxfail 4 s 1650` \(the IDLE and AUTO bands\), the governor changes to AUTOROTATION, and the motor stops after approximately 6\.1 s\./);
    assert.match(f.text, /With `rxfail 4 s 1655` or more, or with `rxfail 4 h`, the governor stays in ACTIVE\. If the signal does not come back, the motor does not stop until the battery is empty\./);
    assert.match(f.text, /`rxfail 4 s 1036` to `rxfail 4 s 1039` give 1035 µs, which is off\./); assert.doesNotMatch(f.text, /connect|load a (CLI )?dump/i);
    assert.equal(f.export, false);
    const out = A.advise({ findings: [Object.assign({ module: 'config', fid: 'd12' }, f)] });
    assert.ok(!out.recommendations.some(r => (r.evidence || []).some(e => e && (e.id === 'D12' || e.fid === 'd12')) || (r.cli || []).some(l => /rxfail/.test(l))), 'no recommendation for D12');
    assert.doesNotMatch(A.exportScript(out.recommendations, null, {}), /^rxfail\b/m, 'the export has no rxfail line');
});

test('D12: a snapshot with el.rxfail.4 = 2,125 (1500 µs) gives the AUTO band, AUTOROTATION, 0.125 for each second and the motor stop after 6.1 s', () => {
    const f = d12(C.judge([flightOf(snapHeader({ rxfail: `2,${(1500 - 875) / 5}` }), 0.766)], C.DEFAULT_RULES, {}));
    assert.deepEqual(f.rxfail, ['s', 1500]); assert.deepEqual([f.value, f.band, f.state, f.cut, f.unbounded], [1500, 'AUTO', 'AUTOROTATION', false, false]);
    assert.equal(f.decayPerS, 0.125); assert.ok(Math.abs(f.motorOffS - 6.1) <= 0.1, `the motor stops after ${f.motorOffS} s`); assert.deepEqual(f.recovery, { to: 'BAILOUT', limitS: 15 });
    assert.match(f.text, /This value is in the AUTO band \(1350 µs to 1650 µs\)\. Thus, the governor changes from ACTIVE to AUTOROTATION\. The throttle decreases by 0\.125 each second, and the motor stops after approximately 6\.1 s\. This time is for the throttle at the last RC frame \(77 %\)\./);
    // with gov_auto_throttle more than gov_idle_throttle the IDLE band holds the throttle, and the AUTO band keeps the motor at the auto throttle
    const g = d12(C.judge([flightOf(snapHeader({ rxfail: '2,125', set: { gov_auto_throttle: '100' } }), 0.766)], C.DEFAULT_RULES, {}));
    assert.deepEqual([g.band, g.state, g.target, g.unbounded, g.motorOffS], ['AUTO', 'AUTOROTATION', 0.1, true, null]);
    assert.deepEqual(g.groups.filter(q => q.band === 'IDLE').map(q => [q.state, q.target]), [['THROTTLE_HOLD', 0]]);
    // rxfail 4 h: the last throttle position, ACTIVE in flight, no motor stop
    const h = d12(C.judge([flightOf(snapHeader({ rxfail: '1,125' }), 0.766)], C.DEFAULT_RULES, {}));
    assert.deepEqual([h.value, h.band, h.state, h.unbounded], [null, 'HOLD', 'ACTIVE', true]);
});

test('D12: a typed value of 1037 is stored as 1035, which is off; the pulses of the bands', () => {
    assert.deepEqual([1037, 1035, 1039, 1040, 1500, 1652, 800, 3000].map(C.rxfailPulse), [1035, 1035, 1035, 1040, 1500, 1650, 875, 2125]);
    const v = C.throttleValues(PLx.snapshotOf(snapHeader()), 'snapshot').values;
    assert.equal(C.rxfailResponse(v, ['s', C.rxfailPulse(1037)]).band, 'off');
    const R = C.rxfailResponse(v, ['a'], 0.5);
    assert.deepEqual(R.groups.map(g => [g.from, g.to, g.band, g.state]), [[875, 1035, 'off', 'THROTTLE_HOLD'], [1040, 1345, 'IDLE', 'AUTOROTATION'], [1350, 1650, 'AUTO', 'AUTOROTATION'], [1655, 2125, 'MAX', 'ACTIVE']]);
    assert.equal(R.groups[1].motorOffS, 4, 'from a throttle of 0.5 at 0.125 for each second');
    // rc_min_throttle moves the off value: 1100 µs gives AUTO = 1090 µs
    assert.equal(C.rxfailResponse(Object.assign({}, v, { rc_min_throttle: 1100 }), ['a']).pulse, 1090);
});

test('D12 with no snapshot and no CLI dump: the values that the log does not record, and the stage-2 note from the firmware of the header', () => {
    const header = { 'Firmware revision': 'Rotorflight 4.6.0 (118e912) STM32G47X', firmwareVersion: '4.6.0' };
    const f = d12(C.judge([flightOf(header)], C.DEFAULT_RULES, {}));
    assert.equal(f.thin, true); assert.equal(f.severity, 'note'); assert.ok(f.missing.includes('rxfail') && f.missing.includes('gov_throttle_type'));
    assert.match(f.text, /^The log header does not record `rxfail`, `rc_center`/); assert.match(f.text, /The log header of a firmware with `blackbox_params` records these values\./);
    assert.match(f.text, /On Rotorflight 4\.6\.0, failsafe "stage 2" does not operate\./);
    // a CLI dump (a diff of 4.6.0-bbp-bench with option B): the values of the dump, the defaults of the build for the rest
    const cli = S.parseCli(['# version', '# Rotorflight / STM32G47X (SG47) 4.6.0-bbp-bench Oct 12 2026 / 23:42:08 (874f369d5) MSP API: 12.9', 'board_name MATEKG474HELI',
        'set gov_mode = ELECTRIC', 'set gov_throttle_type = FUNCTION', 'set gov_spooldown_time = 80', 'rxfail 4 s 1500'].join('\n'));
    const g = d12(C.judge([flightOf(header, 0.766)], C.DEFAULT_RULES, { cli }));
    assert.deepEqual([g.basis, g.value, g.band, g.state, g.thin], ['cli', 1500, 'AUTO', 'AUTOROTATION', false]); assert.ok(g.defaulted.includes('rc_center'));
    assert.match(g.text, /The values come from the CLI dump\. The log header does not record them\./);
    // a snapshot and a CLI dump with another rxfail: the log first, then the response with the values of the dump
    const k = d12(C.judge([flightOf(snapHeader(), 0.766)], C.DEFAULT_RULES, { cli }));
    assert.equal(k.basis, 'snapshot'); assert.equal(k.band, 'off'); assert.ok(k.cliAlt && k.cliAlt.band === 'AUTO' && k.cliAlt.state === 'AUTOROTATION');
    assert.match(k.text, /The CLI dump gives `rxfail 4 s 1500`, and the log header gives `rxfail 4 a`\. Thus, the CLI dump is possibly not of the time of the log\./);
});

// the restore script of the Fireball (4.6.0-bbp-bench, option B: `rxfail 4 s 1500`): health_setup.parseCli calls it a dump
const RESTORE = path.join(__dirname, '../analysis/fireball-46-flash-20261015/RTFL_cli_SAB_Fireball_restore_4.6_20261015.txt');
test('D12: a CLI text with `rxfail 4 s 1037` (not a step) gives the stored 1035 µs, the band off and the motor stop; the typed value stays in the text', { skip: !fs.existsSync(RESTORE) ? 'the restore script of 2026-10-15 is not here' : false }, () => {
    const text = fs.readFileSync(RESTORE, 'utf8'); assert.match(text, /^rxfail 4 s 1500$/m);
    const cli = S.parseCli(text.replace(/^rxfail 4 s 1500$/m, 'rxfail 4 s 1037')), header = { 'Firmware revision': 'Rotorflight 4.6.0-bbp (58a4bd5cc) STM32G47X', firmwareVersion: '4.6.0' };
    const f = d12(C.judge([flightOf(header, 0.766)], C.DEFAULT_RULES, { cli }));
    assert.deepEqual([f.basis, f.value, f.typed, f.band, f.cut, f.state], ['cli', 1035, 1037, 'off', true, 'THROTTLE_HOLD']); assert.deepEqual(f.rxfail, ['s', 1037]);
    assert.match(f.text, /^With `rxfail 4 s 1037`, the firmware sets the throttle to 1035 µs at 0\.3 s to 0\.4 s after the last RC frame\. The CLI text has `rxfail 4 s 1037`\. The firmware keeps 1035 µs\. This value is less than the off value/);
    // the same script with option B: the AUTO band and AUTOROTATION (a value of a dump from the flight controller is a step already)
    const b = d12(C.judge([flightOf(header, 0.766)], C.DEFAULT_RULES, { cli: S.parseCli(text) }));
    assert.deepEqual([b.value, b.typed, b.band, b.state, b.cut], [1500, 1500, 'AUTO', 'AUTOROTATION', false]); assert.doesNotMatch(b.text, /The CLI text has/);
});

test('D12: a loss on the ground with the motor stopped does not give the throttle at the motor stop; the median in flight does', () => {
    const cli = S.parseCli(['# version', '# Rotorflight / STM32G47X (SG47) 4.6.0-bbp-bench Oct 12 2026 / 23:42:08 (874f369d5) MSP API: 12.9', 'board_name MATEKG474HELI',
        'set gov_mode = ELECTRIC', 'set gov_throttle_type = FUNCTION', 'set gov_spooldown_time = 80', 'rxfail 4 s 1500'].join('\n'));
    const header = { 'Firmware revision': 'Rotorflight 4.6.0 (118e912) STM32G47X', firmwareVersion: '4.6.0' };
    const f = d12(C.judge([flightOf(header, 0, false)], C.DEFAULT_RULES, { cli }));
    assert.equal(f.throttleBasis, 'flight'); assert.equal(f.throttleAtStop, 0.7); assert.ok(Math.abs(f.motorOffS - 0.7 / 0.125) < 0.01, `the motor stops after ${f.motorOffS} s`);
    assert.match(f.text, /the motor stops after approximately 5\.6 s\. This time is for the median throttle in flight \(70 %\)\./);
    // the analysis: a loss of 0.5 s at 1 s on the ground (motor 0, governor OFF) is not a loss with the rotor turning
    const n = 6000, w = { n, rate: 1000, fromS: 0, hs: new Float64Array(n), extra: { 'motor[0]': new Float64Array(n), time: Float64Array.from({ length: n }, (_, i) => 1e6 + i * 1000) },
        govStateAt: new Uint8Array(n), rxLoss: [{ i0: 1000, i1: 1500, signal: true, cause: 'signal', returned: true, lastFrameUs: 1e6 + 900e3, cut0: 890, cut1: 2500 }] };
    for (let i = 3000; i < n; i++) { w.hs[i] = 2500; w.extra['motor[0]'][i] = 450; w.govStateAt[i] = 4; }
    const m = C.analyse(w, { rate: 1000, flightRule: { headspeed: 2000 }, flying: Uint8Array.from({ length: n }, (_, i) => i >= 3000 ? 1 : 0) });
    assert.deepEqual(m.throttle.atLoss.map(e => [e.u, e.rotor]), [[0, false]]); assert.equal(m.throttle.flight, 0.45);
});

test('D12: the recovery conditions of governor.c; HOLD with an input that is not off changes to IDLE after the time limit', () => {
    const f = d12(C.judge([flightOf(snapHeader(), 0.766)], C.DEFAULT_RULES, {}));
    assert.match(f.text, /If the signal comes back in 5 s, the governor can change to RECOVERY\. For this change, the throttle must be more than the handover value, and the RPM signal must be good\. After this time, it changes to OFF, and the rotor must spool up again\./);
    // FUNCTION, gov_auto_throttle 100 (more than gov_idle_throttle 0): the IDLE band (1100 µs) gives THROTTLE_HOLD with the input not off
    const g = d12(C.judge([flightOf(snapHeader({ rxfail: `2,${(1100 - 875) / 5}`, set: { gov_auto_throttle: '100' } }), 0.766)], C.DEFAULT_RULES, {}));
    assert.deepEqual([g.value, g.band, g.state, g.cut], [1100, 'IDLE', 'THROTTLE_HOLD', false]);
    assert.match(g.text, /the governor can change to RECOVERY\. For this change, the throttle must be more than the handover value, and the RPM signal must be good\. After this time, it changes to IDLE\./); assert.doesNotMatch(g.text.split('\n').slice(0, 2).join(' '), /changes to OFF/);
    // AUTOROTATION: BAILOUT with the same conditions, IDLE after gov_autorotation_timeout
    const a = d12(C.judge([flightOf(snapHeader({ rxfail: '2,125' }), 0.766)], C.DEFAULT_RULES, {}));
    assert.match(a.text, /If the signal comes back in 15 s, the governor can change to BAILOUT\. For this change, the throttle must be more than the handover value, and the RPM signal must be good\. After this time, it changes to IDLE\./);
});

test('D12: gov_mode LIMIT is not modelled (thin: the stored throttle and if it is off only); a number of gov_mode is its lookup name', () => {
    const f = d12(C.judge([flightOf(snapHeader({ rxfail: '2,125', set: { gov_mode: 'LIMIT' } }), 0.766)], C.DEFAULT_RULES, {}));
    assert.deepEqual([f.thin, f.modelled, f.value, f.band, f.state, f.govMode, f.cut], [true, false, 1500, null, null, 'LIMIT', false]);
    assert.match(f.text, /The app does not calculate the governor response for `gov_mode = LIMIT`\. The governor model of the app is for `gov_mode` OFF, ELECTRIC and NITRO only\./);
    assert.doesNotMatch(f.text, /band/);
    const CAT = require('../tools/autotune/catalog.cjs'), say = CAT.summary(Object.assign({ module: 'config' }, f));
    assert.match(say, /With `rxfail 4 s 1500`, the throttle is 1500 µs\. The app does not calculate the governor response for `gov_mode = LIMIT`\./);
    assert.deepEqual(['3', '1', '0', 3].map(v => C.throttleValues({ global: { rc_center: 1500, rc_deflection: 510, gov_mode: v }, rxfail: { 4: ['a'] } }, 'snapshot').values.gov_mode), ['ELECTRIC', 'LIMIT', 'OFF', 'ELECTRIC']);
    assert.equal(C.throttleValues({ global: { gov_throttle_type: '2' }, rxfail: {} }, 'snapshot').values.gov_throttle_type, 'FUNCTION');
});

const CRASH = path.join(__dirname, '../analysis/fireball-crash-20261015/crash.bbl');
test('real: D12 of the Fireball crash log 2026-10-15 (snapshot of 4.7.0 85d7049a9)', { skip: !fs.existsSync(CRASH) ? 'analysis/fireball-crash-20261015/crash.bbl is not here' : false }, () => {
    const PH = require('../tools/autotune/health_phase.cjs'), flights = [];
    for (const w of lib.segments(app, CRASH, { whole: true, extra: [...new Set(['time'].concat(C.EXTRA, PH.EXTRA))] })) {
        if (w.skipped) continue;
        const ctx = { rate: w.flight.actualRate, header: w.flight.header, govState: w.govStateAt || null, flightRule: { headspeed: 2900 } }, P = PH.phases(w, ctx); ctx.flightMask = PH.flightMask(w, ctx, P);
        flights.push({ log: w.flight.log, header: w.flight.header, metrics: C.analyse(w, ctx) });
    }
    const f = d12(C.judge(flights, C.DEFAULT_RULES, {}));
    assert.deepEqual([f.value, f.band, f.state, f.cut, f.basis, f.stage2Off], [1031, 'off', 'THROTTLE_HOLD', true, 'snapshot', true]); assert.deepEqual(f.cutDelayS, [0.3, 0.4]);
    assert.equal(f.throttleBasis, 'loss'); assert.ok(Math.abs(f.throttleAtStop - 0.766) < 0.002, `the throttle at the last RC frame: ${f.throttleAtStop}`);
    const alt = f.groups.find(g => g.band === 'AUTO'); assert.ok(Math.abs(alt.motorOffS - 6.1) <= 0.1, `AUTO band: the motor stops after ${alt.motorOffS} s`);
    assert.match(f.text, /The values come from the log header of log 0\./, 'a log number from 0 (the app shows log 1)');
    // with the option-B dump of the pilot (after the flight): the summary gives both, and the text gives the dump right after the first paragraph
    if (!fs.existsSync(RESTORE)) return;
    const b = d12(C.judge(flights, C.DEFAULT_RULES, { cli: S.parseCli(fs.readFileSync(RESTORE, 'utf8')) })), CAT = require('../tools/autotune/catalog.cjs');
    assert.equal(b.cliDiffers, true); assert.deepEqual([b.cliAlt.band, b.cliAlt.state, b.cliAlt.cut], ['AUTO', 'AUTOROTATION', false]); assert.ok(Math.abs(b.cliAlt.motorOffS - 6.1) <= 0.1);
    assert.match(b.text.split('\n')[2], /^The CLI dump gives `rxfail 4 s 1500`, and the log header gives `rxfail 4 a`\./);
    assert.match(CAT.summary(Object.assign({ module: 'config' }, b)), /With `rxfail 4 a`, the throttle is 1031 µs, which is off\. The motor stops 0\.3 s to 0\.4 s after the last RC frame\. With `rxfail 4 s 1500` of the CLI dump, the governor changes to AUTOROTATION, and the motor stops after approximately 6\.1 s\./);
});
