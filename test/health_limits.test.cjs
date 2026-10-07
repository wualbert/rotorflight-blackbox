// Ground-truth checks for tools/autotune/health_limits.cjs (L1-L7, CLAUDE.md "Control limits"): a simulated 4.6 flight
// (test/helpers/bbl_encode.cjs simulateFlight, written as a .bbl file and read back by the app's decoder) with each output at
// its limit for a known time: the throttle at 100 % with the collective stick at its end (two outputs at their limits at the
// same time), a short throttle period 1.5 s before the rescue, the tail at its limit in the rescue, the collective at the limit
// of collectiveRange for 30 ms, the roll I-term at Ki x error_limit; the roll output and the servos with no limit in the log
// (with a CLI dump: a cyclic servo at its limit for 50 ms, and the tail servo that follows the tail). With AUTOTUNE_RESCUE_LOG (the Fireball dump of
// 2026-10-05), the periods at the rescues of logs 14, 15 and 16.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const lib = require('../tools/autotune/lib.cjs');
const L = require('../tools/autotune/health_limits.cjs');
const bbl = require('./helpers/bbl_encode.cjs');

const app = lib.loadApp(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-')), RATE = 1000;
const EXTRA = [...new Set(L.EXTRA.concat(require('../tools/autotune/health_rescue.cjs').EXTRA))];
const at = (s) => Math.round(s * RATE);
const within = (got, want, tol, what) => assert.ok(typeof got === 'number' && Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);

function run(log, ctx = {}) {
    const file = path.join(tmp, `sim${Math.random().toString(36).slice(2)}.bbl`); fs.writeFileSync(file, bbl.encode([log]).bytes);
    const [w] = [...lib.segments(app, file, { whole: true, extra: EXTRA })].filter(q => !q.skipped);
    const m = L.analyse(w, Object.assign({ rate: w.flight.actualRate, header: w.flight.header, profile: w.profileAt, govState: w.govStateAt }, ctx));
    return { w, m, F: L.judge([{ log: 0, header: w.flight.header, metrics: JSON.parse(JSON.stringify(m)) }]) };
}
const one = (F, ch) => { const l = F.filter(f => f.channel === ch); assert.equal(l.length, 1, `${ch}: one finding, got ${l.length}`); return l[0]; };

function limited() {
    const log = bbl.simulateFlight({ seed: 8, rescue: [30, 32] }), w = log.w, X = w.extra, set = (col, a, b, v) => { for (let i = at(a); i < at(b); i++) col[i] = v; };
    for (let i = 0; i < w.n; i++) w.u[0][i] = Math.round(500 * w.u[0][i]) / 1000;                  // the roll output: no clamp in the data
    for (let i = 0; i < w.n; i++) w.u[2][i] = Math.round(400 * w.u[2][i]) / 1000;                  // the tail output: scaled, no clamp in the data (a clamp is a limit)
    set(X['motor[0]'], 20.0, 20.25, 1000); set(X['motor[0]'], 28.5, 28.53, 1000);                // L1: 0.25 s and 0.03 s, 1.47 s before the rescue
    set(X['rcCommand[3]'], 20.05, 20.35, 500);                                                     // L7: the collective stick at its end, with the throttle
    set(X['mixer[3]'], 40.0, 40.03, -1250);                                                        // L2: collectiveRange -1250 for 30 ms
    set(w.u[2], 30.1, 30.2, 0.8); set(X['servo[3]'], 30.1, 30.2, 1900);                            // L4: the tail in the rescue; the tail servo follows it
    for (let i = 0; i < w.n; i++) X['servo[3]'][i] = Math.round(1500 + 500 * w.u[2][i]);
    set(X['servo[0]'], 12.0, 12.05, 2100);                                                         // L5: a cyclic servo for 50 ms
    set(w.I[0], 15.0, 15.2, 0.9);                                                                  // L6: SCALE.I x 100 x 45 = 0.9 (header rollPID I, error_limit)
    return log;
}

test('each output at its limit: periods, durations, the other outputs at the same time, the rescue, the status of each channel', () => {
    const { m, F } = run(limited());
    const thr = one(F, 'throttle'), cmd = one(F, 'collectiveCommand'), col = one(F, 'collective'), tail = one(F, 'tail'), sv = one(F, 'servo[0]'), sv3 = one(F, 'servo[3]'), it = one(F, 'iterm roll'), roll = one(F, 'roll');
    // L1 throttle: the firmware maximum, 2 periods, the longest 0.25 s with the collective command at its maximum
    assert.equal(thr.id, 'L1'); assert.equal(thr.severity, 'flag'); assert.equal(thr.limits.source, 'firmware'); assert.equal(thr.n, 2);
    within(thr.longestS, 0.25, 0.002, 'longest throttle period'); within(thr.value, 0.28, 0.003, 'throttle at the limit');
    assert.deepEqual(thr.events.map(e => [e.tS, e.rescue, e.with]), [[20, null, ['collectiveCommand']], [28.5, 'before rescue', []]]);
    assert.equal(thr.combined, true); assert.equal(thr.se, null); assert.match(thr.text, /a count and times\. Thus, they have no SE/);
    // L7 the collective stick: rcCommand[3] at +500 (rc.c: the deflection x 500), with the throttle
    assert.equal(cmd.id, 'L7'); assert.equal(cmd.severity, 'flag'); assert.deepEqual([cmd.limits.lo, cmd.limits.hi, cmd.limits.source], [-500, 500, 'firmware']); within(cmd.longestS, 0.3, 0.002, 'collective stick period'); assert.deepEqual(cmd.with, ['throttle']);
    // L2 collective output: collectiveRange of the header, 30 ms, alone: "Monitor"
    assert.equal(col.id, 'L2'); assert.equal(col.severity, 'note'); assert.equal(col.limits.source, 'header'); assert.deepEqual([col.limits.lo, col.limits.hi], [-1250, 1250]); within(col.value, 0.03, 0.002, 'collective at its limit');
    // L4 tail: in the rescue, alone
    assert.equal(tail.id, 'L4'); assert.equal(tail.severity, 'flag'); within(tail.longestS, 0.1, 0.002, 'tail period'); assert.equal(tail.events[0].rescue, 'rescue');
    assert.deepEqual([tail.events[0].with, tail.events[0].same], [[], []]); assert.equal(sv3.axis, 'yaw', 'the tail servo: the servo that follows mixer[2]');
    // L5 servos: the log header does not give their limits ("limit unknown"); L6 the roll I-term: 0.2 s at Ki x error_limit of the header
    for (const q of [sv, sv3]) { assert.equal(q.id, 'L5'); assert.equal(q.severity, 'skipped'); assert.equal(q.limitUnknown, true); }
    assert.equal(it.id, 'L6'); assert.equal(it.severity, 'flag'); within(it.longestS, 0.2, 0.002, 'I-term period'); assert.equal(it.limits.source, 'header'); within(it.limits.byProfile[0], 900, 0.5, 'I-term limit (permille)');
    // L3 roll: no limit in the header, the data or a CLI dump: "limit unknown", not an assumed value
    assert.equal(roll.id, 'L3'); assert.equal(roll.severity, 'skipped'); assert.equal(roll.limitUnknown, true); assert.match(roll.text, /the limit is unknown/);
    // never "Satisfactory" with a period: every channel with a period is a note or a flag
    for (const f of F) if (f.n > 0) assert.ok(f.severity === 'note' || f.severity === 'flag', `${f.channel} ${f.severity}`);
    assert.deepEqual(m.rescues.map(q => [q.tS, q.t1S]), [[30, 32.5]]);
    assert.deepEqual(Object.keys(L.curves(null, {}, m)), ['channels']);
});

test('limits from a CLI dump: the mixer input SR and SP, the servos (mid + min, mid + max), gov_max_throttle for each PID profile', () => {
    const cli = ['# diff all', 'mixer input SR -400 400 100', 'mixer input SP -1250 1250 100', 'servo 0 1500 -600 600 500 500 333 0 2', 'servo 1 1500 -650 650 500 500 333 0 2', 'servo 3 1500 -400 400 500 500 333 0 2'].join('\n');
    const log = limited(), { F } = run(log, { cli, maxThrottle: { 0: 90 } });
    const roll = one(F, 'roll'), thr = one(F, 'throttle'), sv = one(F, 'servo[0]'), tail = one(F, 'tail'), sv3 = one(F, 'servo[3]');
    // a cyclic servo: 50 ms at mid + max (2100 us), alone: "Monitor"; the tail servo (mid + max 1900 us) follows the tail output
    assert.equal(sv.severity, 'note'); assert.deepEqual([sv.limits.lo, sv.limits.hi, sv.limits.source], [900, 2100, 'cli']); within(sv.value, 0.05, 0.002, 'servo at its limit');
    assert.deepEqual(tail.events.find(e => e.rescue === 'rescue').same, ['servo[3]']); assert.equal(sv3.events.find(e => e.rescue === 'rescue').same[0], 'tail');
    assert.equal(roll.limits.source, 'cli'); assert.deepEqual([roll.limits.lo, roll.limits.hi], [-400, 400]);
    // gov_max_throttle 90 %, but the throttle gets to 100 % in this PID profile: the CLI dump is older than the log, not used
    assert.equal(thr.limits.source, 'firmware'); assert.match(thr.text, /the throttle in this log is more than that value\. Thus, the app does not use it\./);
    const ok = one(run(limited(), { cli, maxThrottle: { 0: 100 } }).F, 'throttle');
    assert.equal(ok.limits.source, 'cli'); assert.equal(ok.limits.byProfile[0], 1000, 'gov_max_throttle 100 %'); assert.ok(ok.events.every(e => e.limit === 1000), 'the limit of the PID profile');
});

// round 3 M1: with the labels of the configurations in ctx.profile (js/tuning_worker.js), the I-term limit (L6) of a label comes from
// the CLI section of its PID profile (ctx.pidProfileOf), not from the section of the label number
test('L6: the CLI section of the PID profile of a configuration label (ctx.pidProfileOf)', () => {
    const cli = ['# diff all', 'profile 0', 'set roll_i_gain = 50', 'set error_limit = 30,30,45', 'profile 0'].join('\n'), n = limited().w.n;
    const iterm = (ctx) => run(limited(), Object.assign({ cli }, ctx)).F.find(f => f.id === 'L6' && f.axis === 'roll');
    const byPid = iterm({ profile: new Uint8Array(n).fill(7), pidProfileOf: (L) => L === 7 ? 1 : 0 });
    assert.deepEqual([byPid.limits.source, Object.keys(byPid.limits.byProfile)], ['cli', ['7']], JSON.stringify(byPid.limits));
    const byLabel = iterm({ profile: new Uint8Array(n).fill(7) });   // without pidProfileOf: no section 6, the header for the label at the start
    assert.equal(byLabel.limits.source, 'header', JSON.stringify(byLabel.limits));
    assert.ok(byPid.limits.byProfile[7] < byLabel.limits.byProfile[7], 'the CLI section (I 50, error_limit 30) gives a lower limit than the header (I 100, 45)');
});

test('module contract: EXTRA, RULE, DEFAULT_RULES with a source for each check, the related limits of G3, T6 and C12, no Node API at load', () => {
    for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']) assert.ok(typeof L.DEFAULT_RULES[id].source === 'string' && L.DEFAULT_RULES[id].source.length > 40, id);
    assert.equal(L.DEFAULT_RULES.L1.limit, require('../tools/autotune/health_gov.cjs').DEFAULT_RULES.G3.flag);
    assert.equal(L.DEFAULT_RULES.L4.limit, require('../tools/autotune/health_loop.cjs').DEFAULT_RULES.T6.kick);
    assert.equal(L.DEFAULT_RULES.L3.limit, require('../tools/autotune/health_track.cjs').DEFAULT_RULES.C12.flag);
    assert.equal(L.RULE.tol, 0.005); assert.equal(L.RULE.joinS, 0.05); assert.equal(L.DEFAULT_RULES.longS, 0.1);
    const src = fs.readFileSync(path.join(__dirname, '../tools/autotune/health_limits.cjs'), 'utf8'), head = src.slice(0, src.indexOf('module.exports'));
    assert.doesNotMatch(head.replace(/require\('node:[a-z]+'\)/g, ''), /\b(fs|process)\.\w+\(/, 'no Node API before the exports');
    assert.match(src, /module\.exports = [^\n]+\nif \(require\.main !== module\) return;/);
});

const REAL = process.env.AUTOTUNE_RESCUE_LOG;
test('real: the periods at a limit at the rescues of the Fireball dump 2026-10-05', { skip: !REAL || !fs.existsSync(REAL) ? 'set AUTOTUNE_RESCUE_LOG to the Fireball dump of 2026-10-05' : false }, () => {
    const flights = [];
    for (const w of lib.segments(app, REAL, { whole: true, extra: EXTRA })) if (!w.skipped && [13, 14, 15].includes(w.flight.log))
        flights.push({ log: w.flight.log, header: w.flight.header, metrics: JSON.parse(JSON.stringify(L.analyse(w, { rate: w.flight.actualRate, header: w.flight.header, profile: w.profileAt, govState: w.govStateAt }))) });
    const F = L.judge(flights), period = (log, ch, t0, t1) => F.filter(f => f.log === log && f.channel === ch).flatMap(f => f.events || []).filter(e => e.tS < t1 && e.t1S > t0);
    // log 15: the throttle at 100 % from 193.32 s to 193.58 s (the FALLBACK), the collective command at its maximum, the tail at -1517 at 193.71 s
    const t15 = period(14, 'throttle', 193.0, 193.95); assert.equal(t15.length, 1); within(t15[0].tS, 193.32, 0.01, 'log 15 throttle start'); within(t15[0].t1S, 193.58, 0.01, 'log 15 throttle end');
    assert.ok(t15[0].with.includes('collectiveCommand') && t15[0].errors.headspeed < -0.3, JSON.stringify(t15[0]));
    const k15 = period(14, 'tail', 193.6, 193.9); assert.equal(k15.length, 1); assert.equal(k15[0].limit, -1517); assert.equal(k15[0].rescue, 'before rescue');
    // log 14 at 105.54 s: the tail at its high limit 1021 in the rescue; log 16 at 151.37 s: the throttle at 100 % in the rescue
    const k14 = period(13, 'tail', 105.5, 106.0); assert.ok(k14.length >= 1 && k14[0].limit === 1021 && k14[0].rescue === 'rescue', JSON.stringify(k14));
    const t16 = period(15, 'throttle', 151.3, 152.9); assert.ok(t16.length >= 1 && t16.some(e => e.rescue === 'rescue'), JSON.stringify(t16.map(e => [e.tS, e.t1S, e.rescue])));
});
