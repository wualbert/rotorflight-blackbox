// Ground-truth checks for tools/autotune/health_rescue.cjs (G19 headspeed at a rescue, T15 tail at a rescue, D8 PID profile
// change at a rescue): simulated 4.6 flights (test/helpers/bbl_encode.cjs simulateFlight) with a rescue, written as a .bbl
// file and read back by the app's decoder (lib.segments whole), with known injections: a headspeed decrease with the throttle
// at 100 % and the governor in FALLBACK and RECOVERY before the rescue (the Fireball 2026-10-05 log 15), a PID profile change
// 0.3 s before the rescue with a commanded target change and a tail kick with the tail output at its limit (log 14), and a
// rescue with no problem. With AUTOTUNE_RESCUE_LOG (the Fireball dump of 2026-10-05, 16 logs), the five rescues of logs 6, 14,
// 15 and 16 against their frame-time facts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const lib = require('../tools/autotune/lib.cjs');
const R = require('../tools/autotune/health_rescue.cjs');
const bbl = require('./helpers/bbl_encode.cjs');

const app = lib.loadApp(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rescue-')), RATE = 1000;
const EXTRA = [...new Set(R.EXTRA.concat(['servo[3]']))];
const at = (s) => Math.round(s * RATE);
const within = (got, want, tol, what) => assert.ok(typeof got === 'number' && Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);
const only = (F, id, p) => { const l = F.filter(f => f.id === id && (p === undefined || f.profile === p)); assert.equal(l.length, 1, `${id}: one finding, got ${l.length}`); return l[0]; };

// the segment of a simulated log as the decoder gives it, and the module's findings on it
function run(log, ctx = {}) {
    const file = path.join(tmp, `sim${Math.random().toString(36).slice(2)}.bbl`); fs.writeFileSync(file, bbl.encode([log]).bytes);
    const [w] = [...lib.segments(app, file, { whole: true, extra: EXTRA })].filter(q => !q.skipped);
    const m = R.analyse(w, Object.assign({ rate: w.flight.actualRate, header: w.flight.header }, ctx));
    return { w, m, F: R.judge([{ log: 0, header: w.flight.header, metrics: JSON.parse(JSON.stringify(m)) }]) };
}

// Fireball log 15: the collective at its maximum 0.65 s before the rescue at 30 s, the throttle at 100 % from 29.40 s, the
// headspeed 2500 -> 1500 rpm (-40 %) at 30.0 s, back at 31.0 s; FALLBACK at 29.75 s (the throttle 72 %), RECOVERY at 29.90 s
// (the throttle 52 % and up, govTarget from the headspeed), ACTIVE at 30.6 s. govRequest stays 2500 rpm
function bog(o = {}) {
    const log = bbl.simulateFlight(Object.assign({ seed: 3, rescue: [30, 32] }, o)), X = log.w.extra, w = log.w;
    for (let i = at(29.0); i < at(31.5); i++) {
        const t = i / RATE, hs = t < 29.3 ? 2500 : t < 30 ? 2500 - 1000 * (t - 29.3) / 0.7 : t < 31 ? 1500 + 1000 * (t - 30) : 2500;
        w.hs[i] = Math.round(hs); w.coll[i] = X['mixer[3]'][i] = t >= 29.35 && t < 31.5 ? 1000 : w.coll[i];
        const st = t >= 29.75 && t < 29.9 ? 6 : t >= 29.9 && t < 30.6 ? 3 : 4; log.govState[i] = st;
        X['motor[0]'][i] = st === 6 ? 720 : st === 3 ? Math.round(520 + 500 * (t - 29.9)) : t >= 29.4 && t < 29.75 ? 1000 : X['motor[0]'][i];
        X.govTarget[i] = st === 3 ? Math.round(hs) : 2500; X.govRequest[i] = 2500;
    }
    return log;
}

test('G19: a headspeed decrease at full throttle with FALLBACK and RECOVERY before the rescue is a problem, with its overload and governor changes', () => {
    const { m, F } = run(bog());
    assert.equal(m.rescues.length, 1); within(m.rescues[0].tS, 30, 0.002, 'rescue start (frame s)'); within(m.rescues[0].t1S, 32.5, 0.002, 'rescue end: RESCUE_STATE with EXIT');
    const g = only(F, 'G19');
    assert.equal(g.severity, 'flag');
    // the 0.2 s running median of a V-shaped dip to 1500 rpm (-40 %): the median of the window at the bottom is 1559 rpm
    within(g.value, -0.376, 0.005, 'largest decrease under govRequest in RECOVERY (0.2 s median)');
    assert.equal(g.leave, 'FALLBACK'); assert.equal(g.overload, true);
    within(g.events[0].overload.untilT, 29.75, 0.002, 'the overload holds until the change to FALLBACK');
    within(g.events[0].overload.dtS, -0.6, 0.002, 'the throttle at 95 % or more from 0.6 s before the start');
    within(g.throttleHighS, 0.35, 0.01, 'throttle at 95 % or more'); within(g.minThrottleAfter, 520, 1, 'the lowest throttle out of ACTIVE');
    within(g.belowS, 1.275, 0.02, 'time more than 10 % under the target: 2250 rpm at 29.475 s and at 30.75 s');
    assert.deepEqual(g.events[0].states.map(c => `${c.from}>${c.to}`), ['ACTIVE>FALLBACK', 'FALLBACK>RECOVERY', 'RECOVERY>ACTIVE']);
    assert.equal(g.se, null); assert.equal(g.n, 1); assert.match(g.text, /A minimum of 3 is necessary for an SE/);
    assert.ok(g.onsets.length === 1 && g.onsets[0].tS > 29.3 && g.onsets[0].tS < 29.6, `onset of the decrease ${JSON.stringify(g.onsets)}`);
    assert.equal(g.phase, null, 'the phase comes from ctx.phases (none here)');
    assert.equal(only(F, 'D8').severity, 'ok'); assert.equal(only(F, 'T15').axis, 'yaw');
});

test('G19: a commanded target change (a PID profile change) is not a decrease; D8 flags the PID profile change; T15 flags the tail kick at the limit', () => {
    const log = bbl.simulateFlight({ seed: 4, rescue: [30, 32], profiles: [{ from: 0, profile: 1, target: 2500 }, { from: 29.7, profile: 2, target: 2000 }] }), w = log.w;
    // a tail kick: 150 deg/s for 0.2 s from 30.05 s, the tail output at its limit (0.9, the largest value of the log) for 0.1 s
    for (let i = at(30.05); i < at(30.25); i++) w.gyro[2][i] += Math.round(150 * Math.sin(Math.PI * (i - at(30.05)) / at(0.2)));
    for (let i = 0; i < w.n; i++) w.u[2][i] = Math.max(-0.5, Math.min(0.5, w.u[2][i]));
    for (let i = at(30.05); i < at(30.15); i++) w.u[2][i] = 0.9;
    const { F } = run(log), g = only(F, 'G19', 2), d = only(F, 'D8', 2), q = only(F, 'T15', 2);
    // against the old target the headspeed would be 20 % low; against the commanded target it is not more than 5 % low (the
    // simulated governor droops by 60 rpm x |collective| / 1000 and follows its target with a 0.5 Hz lag)
    assert.equal(g.severity, 'ok', `G19 ${g.value}`); assert.ok(g.value > -0.05, `the headspeed follows the new target: ${g.value}`);
    // the PID profile before the first change is the arming profile, which the log does not name: label 0 ("an unknown PID profile")
    assert.equal(d.severity, 'flag'); assert.deepEqual([d.fromProfile, d.toProfile, d.fromTarget, d.toTarget], [0, 2, 2500, 2000]);
    within(d.events[0].changes[0].dtS, -0.3, 0.002, 'the change 0.3 s before the start');
    assert.equal(q.severity, 'flag'); assert.ok(q.peak >= 145, `peak ${q.peak}`); assert.ok(q.value > 30, `increase ${q.value}`);
    within(q.atLimitS, 0.1, 0.002, 'time at the tail output limit (the data: 0.9)');
    assert.equal(q.onsets.length, 1);
});

// round 3 M1: js/tuning_worker.js gives ctx.profile the labels of the configurations and ctx.pidLabels the PID profile labels. D8 is a
// change of the PID profile: a change of configuration (a rate profile change, an in-flight adjustment) at the rescue is not one
test('D8 uses the PID profile labels (ctx.pidLabels) when ctx.profile holds the configurations', () => {
    const log = bbl.simulateFlight({ seed: 6, rescue: [30, 32] }), n = log.w.n, k = at(29.7);
    const labels = Uint8Array.from({ length: n }, (_, i) => i < k ? 1 : 2), pid = new Uint8Array(n).fill(1);
    assert.equal(only(run(log, { profile: labels, pidLabels: pid }).F, 'D8').severity, 'ok', 'a change of configuration only');
    const both = only(run(log, { profile: new Uint8Array(n).fill(3), pidLabels: Uint8Array.from({ length: n }, (_, i) => i < k ? 1 : 2) }).F, 'D8');
    assert.deepEqual([both.severity, both.fromProfile, both.toProfile], ['flag', 1, 2], 'a PID profile change in one configuration label');
});

test('a rescue with no problem, a log with no rescue, and the tail limits of check T8', () => {
    const ok = run(bbl.simulateFlight({ seed: 5, rescue: [30, 32] }));
    for (const id of ['G19', 'T15', 'D8']) assert.equal(only(ok.F, id).severity, 'ok', id);
    const none = run(bbl.simulateFlight({ seed: 6 }));
    for (const id of ['G19', 'T15', 'D8']) { const f = only(none.F, id); assert.equal(f.severity, 'skipped'); assert.match(f.text, /no rescue/); }
    const t8 = run(bbl.simulateFlight({ seed: 5, rescue: [30, 32] }), { tailLimits: { lo: -0.95, hi: 0.95 } });
    assert.deepEqual(t8.m.tailLimits, { lo: -0.95, hi: 0.95, source: 'T8' });
});

test('module contract: EXTRA, RULE, DEFAULT_RULES with a source for each check, no Node API at load', () => {
    for (const id of ['G19', 'T15', 'D8']) assert.ok(typeof R.DEFAULT_RULES[id].source === 'string' && R.DEFAULT_RULES[id].source.length > 20, id);
    assert.equal(R.DEFAULT_RULES.G19.flag, require('../tools/autotune/health_gov.cjs').DEFAULT_RULES.G3.flag, 'the limit of check G3');
    assert.equal(R.DEFAULT_RULES.T15.kick, require('../tools/autotune/health_loop.cjs').DEFAULT_RULES.T6.kick, 'the yaw kick limit of check T6');
    const src = fs.readFileSync(path.join(__dirname, '../tools/autotune/health_rescue.cjs'), 'utf8'), head = src.slice(0, src.indexOf('module.exports'));
    assert.doesNotMatch(head.replace(/require\('node:[a-z]+'\)/g, ''), /\b(fs|process)\.\w+\(/, 'no Node API before the exports');
    assert.match(src, /module\.exports = [^\n]+\nif \(require\.main !== module\) return;/);
});

// The Fireball dump of 2026-10-05 (16 logs; flight logs 6, 11, 12, 14, 15 and 16). Frame-time facts of its rescues (index time
// differs from the frame time by up to 0.1 s at these rescues)
const REAL = process.env.AUTOTUNE_RESCUE_LOG;
test('real: the rescues of the Fireball dump 2026-10-05', { skip: !REAL || !fs.existsSync(REAL) ? 'set AUTOTUNE_RESCUE_LOG to the Fireball dump of 2026-10-05' : false }, () => {
    const flights = [];
    for (const w of lib.segments(app, REAL, { whole: true, extra: EXTRA })) if (!w.skipped && [5, 13, 14, 15].includes(w.flight.log))
        flights.push({ log: w.flight.log, header: w.flight.header, metrics: JSON.parse(JSON.stringify(R.analyse(w, { rate: w.flight.actualRate, header: w.flight.header }))) });
    const F = R.judge(flights), ev = (id, log, s) => { for (const f of F) if (f.id === id && f.log === log) for (const e of f.events || []) if (Math.abs((e.tS) - s) < 0.05) return Object.assign({ f }, e); return null; };
    const starts = flights.flatMap(f => f.metrics.rescues.map(q => [f.log + 1, q.tS]));
    assert.deepEqual(starts.map(([l, s]) => `${l}@${s.toFixed(2)}`), ['6@136.81', '14@105.54', '14@189.18', '15@193.95', '16@151.37']);
    // log 15: the decrease with FALLBACK (the throttle at 100 % before the change), -41 % under govRequest
    const g15 = ev('G19', 14, 193.952); assert.equal(g15.f.severity, 'flag'); assert.equal(g15.leave, 'FALLBACK'); assert.ok(g15.overload && g15.overload.fall > 0.15, JSON.stringify(g15.overload));
    within(g15.value, -0.415, 0.01, 'log 15 decrease'); within(g15.leaveS, 193.583, 0.003, 'log 15 FALLBACK');
    // log 14 105.54: the PID profile 2 -> 1 at -0.354 s (4500 -> 3500 rpm), the tail kick with the tail at its limit
    const d14 = ev('D8', 13, 105.543); assert.equal(d14.f.severity, 'flag'); assert.deepEqual([d14.changes[0].from, d14.changes[0].to, d14.changes[0].fromTarget, d14.changes[0].toTarget], [2, 1, 4500, 3500]);
    within(d14.changes[0].dtS, -0.354, 0.002, 'log 14 change');
    const t14 = ev('T15', 13, 105.543); assert.equal(t14.f.severity, 'flag'); within(t14.peak, 231, 2, 'log 14 yaw error'); assert.ok(t14.atLimitS > 0, 'log 14 tail at its limit');
    // log 16: the PID profile 3 -> 2 at -0.002 s (5000 -> 4500 rpm)
    const d16 = ev('D8', 15, 151.372); assert.equal(d16.f.severity, 'flag'); assert.deepEqual([d16.changes[0].from, d16.changes[0].to], [3, 2]); within(d16.changes[0].dtS, -0.002, 0.002, 'log 16 change');
    // log 6: no flag of any rescue check
    for (const id of ['G19', 'T15', 'D8']) assert.equal(F.find(f => f.id === id && f.log === 5).severity, 'ok', `log 6 ${id}`);
    // log 16 G19: the target change of the PID profile is commanded: -3.4 % against the ramping govTarget, no flag
    const g16 = ev('G19', 15, 151.372); assert.equal(g16.f.severity, 'ok'); within(g16.value, -0.034, 0.005, 'log 16 decrease');
});

// G20 (coordinator, round 2): the cause of every FALLBACK, with or without a rescue. The bog of Fireball log 15 is an overload; the
// same FALLBACK with the throttle at 70 % and a headspeed that reads 0 for 20 ms before the change is an error of the RPM signal;
// with the throttle at 70 % and a smooth headspeed, no overload sign
test('G20: an overload before the FALLBACK, an error of the RPM signal, and no overload sign; also with no rescue', () => {
    const g20 = (log) => { const { m, F } = run(log); return { m, g: F.find(f => f.id === 'G20') }; };
    let { m, g } = g20(bog());
    assert.equal(m.fallbacks.length, 1); within(m.fallbacks[0].tS, 29.75, 0.002, 'the change to FALLBACK');
    assert.equal(m.fallbacks[0].kind, 'overload'); within(m.fallbacks[0].overload.seconds, 0.35, 0.01, 'throttle at 95 % or more'); assert.ok(m.fallbacks[0].overload.fall >= 0.02, JSON.stringify(m.fallbacks[0].overload));
    assert.deepEqual([g.severity, g.value, g.n, g.unit], ['note', 1, 1, 'count']); assert.equal(g.events[0].bad, false);
    assert.match(g.text, /^At the change to FALLBACK at 29\.75 s, the throttle is at 95 % or more for 0\.35 s, and the headspeed decreases by [\d.]+ % before the change\.\n/);
    assert.match(g.text, /possibly a result of the load at the throttle limit\. The RPM signal is possibly correct\.$/);
    // the throttle under its high value, and a headspeed that reads 0 for 20 ms before the change: the RPM signal
    const sig = bog(); for (let i = at(29.0); i < at(29.75); i++) sig.w.extra['motor[0]'][i] = 700; for (let i = at(29.70); i < at(29.72); i++) sig.w.hs[i] = 0;
    ({ m, g } = g20(sig));
    assert.deepEqual([m.fallbacks[0].kind, m.fallbacks[0].signal.kind, g.value, g.signals], ['signal', 'zero', 0, 1]);
    assert.match(g.text, /the headspeed signal reads 0 while the throttle is less than 95 %\.\n1 of 1 FALLBACK comes at a usual load\. It is possibly an error of the RPM signal \(check G1\)\.$/);
    // no overload sign
    const none = bog(); for (let i = at(29.0); i < at(29.75); i++) { none.w.extra['motor[0]'][i] = 700; none.w.hs[i] = 2500; }
    ({ m } = g20(none)); assert.equal(m.fallbacks[0].kind, 'none');
    // a log with no rescue: the FALLBACK has its cause, and the rescue checks have no rescue
    const quiet = bog({ rescue: null }); ({ m, g } = g20(quiet));
    assert.equal(m.rescues.length, 0); assert.equal(m.fallbacks[0].kind, 'overload'); assert.equal(g.value, 1);
});
