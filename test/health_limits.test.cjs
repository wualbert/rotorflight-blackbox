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
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
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
    set(w.F[2], 30.1, 30.2, 1.0);                                                                  // a clamp: the PID sum more than the limit (the plateau rule, IMP-12)
    for (let i = 0; i < w.n; i++) X['servo[3]'][i] = Math.round(1500 + 500 * w.u[2][i]);
    set(X['servo[0]'], 12.0, 12.05, 2100);                                                         // L5: a cyclic servo for 50 ms
    set(w.I[0], 15.0, 15.2, 0.9);                                                                  // L6: SCALE.I x 100 x 45 = 0.9 (header rollPID I, error_limit)
    // the errors do not decrease at the limit (judge: stuck): the headspeed decreases to 88 % of the target at 20.0-20.35 s, the yaw rate goes
    // from 0 to 120 deg/s at 0 deg/s setpoint in the rescue, the roll gyro stays 70 deg/s under the setpoint of 150 deg/s with the I-term at its limit
    hsDrop(w, 20.0, 20.35, 0.88); ramp(w, 2, 30.1, 30.2, 0, 0, 120); ramp(w, 0, 15.0, 15.2, 150, 80, 80);
    return log;
}
// the setpoint sp of axis a and the gyro from g0 to g1 (deg/s) in [a0, a1) s
function ramp(w, a, a0, a1, sp, g0, g1) { const i0 = at(a0), i1 = at(a1); for (let i = i0; i < i1; i++) { w.sp[a][i] = sp; w.gyro[a][i] = Math.round(g0 + (g1 - g0) * (i - i0) / (i1 - i0)); } }
// the headspeed from the target to k x the target in [a0, a1) s
function hsDrop(w, a0, a1, k) { const i0 = at(a0), i1 = at(a1), T = w.extra.govTarget; for (let i = i0; i < i1; i++) w.hs[i] = Math.round(T[i] * (1 - (1 - k) * (i - i0) / (i1 - i0))); }

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
    assert.equal(ok.throttleLimit.estimated, false);
});

test('a throttle plateau below the firmware maximum is an inferred limit, including a profile missing from the CLI', () => {
    const log = limited();
    log.w.extra['motor[0]'] = Float64Array.from(log.w.extra['motor[0]'], v => Math.round(v * 0.9));
    for (const ctx of [{}, { maxThrottle: { 1: 90 } }]) {
        const f = one(run(log, ctx).F, 'throttle');
        assert.deepEqual(f.throttleLimit, { value: 900, source: 'data', estimated: true });
        assert.match(f.text, /These periods do not show full throttle/);
        assert.equal(f.n, 2);
        within(f.value, 0.28, 0.003, 'unchanged measured plateau duration');
    }
    const known = one(run(log, { maxThrottle: { 0: 90 } }).F, 'throttle');
    assert.deepEqual(known.throttleLimit, { value: 900, source: 'cli', estimated: false });
});

// stuck (user, 2026-10-16): a saturation is a problem only when it is long and the output does not move the gyro rate to the setpoint. Not the
// error alone: a stick that moves to its end increases the setpoint while the gyro accelerates (the error increases, the gyro gets to the setpoint
// after the period: Gaui X4 II 2026-10-04 log 41 at 24.69 s), and a torque change can increase the yaw error and then decrease it with the tail at
// its limit (Fireball 2026-10-05 log 15 at 9.93 s)
test('stuck: a long period at the limit is a problem only when the gyro rate does not move to the setpoint', () => {
    const make = (shape) => { const log = limited(), w = log.w, set = (col, a, b, v) => { for (let i = at(a); i < at(b); i++) col[i] = v; };
        set(w.u[2], 30.1, 30.2, 0.3); set(w.u[2], 45.0, 45.3, 0.8); shape(w);   // only the 0.3 s period at 45 s
        return one(run(log, { tailLimits: { lo: -0.8, hi: 0.8 } }).F, 'tail'); };
    const step = make(w => ramp(w, 2, 45.0, 45.3, 300, 10, 290));   // a constant setpoint, the yaw error decreases from 290 to 10 deg/s
    assert.equal(step.severity, 'note'); within(step.longestS, 0.3, 0.002, 'the period'); assert.equal(step.stuck, null);
    assert.match(step.text, /each period is shorter than 0\.1 s, or the gyro rate moves to the setpoint during the period\. This is a response at the maximum rate, not a problem\./);
    // the stick moves to its end: the setpoint 0 to 400 deg/s in the period, the gyro 0 to 300 deg/s: the error increases, the gyro moves 300 deg/s to the setpoint
    const stick = make(w => { const i0 = at(45.0), i1 = at(45.3); for (let i = i0; i < i1; i++) { const x = (i - i0) / (i1 - i0); w.sp[2][i] = Math.round(400 * x); w.gyro[2][i] = Math.round(300 * x * x); } });
    assert.equal(stick.severity, 'note', 'the error increases, but the gyro moves to the setpoint'); assert.ok(stick.events[0].trend.end > stick.events[0].trend.start);
    const slow = make(w => ramp(w, 2, 45.0, 45.3, 300, 200, 200));  // the gyro stays at 200 deg/s for a setpoint of 300 deg/s
    assert.equal(slow.severity, 'flag'); assert.deepEqual([slow.stuck.kind, slow.stuck.axis, slow.stuck.unreached], ['rate', 'yaw', true]); within(slow.stuck.gyro, 200, 1, 'the rate at the end');
    assert.match(slow.text, /the setpoint is 300 deg\/s, and the gyro rate is 200 deg\/s\. Thus, the helicopter cannot get to the setpoint\./);
    const kick = make(w => ramp(w, 2, 45.0, 45.3, 0, 0, 150));      // the yaw rate increases to 150 deg/s at a setpoint of 0
    assert.equal(kick.severity, 'flag'); assert.equal(kick.stuck.unreached, false); assert.match(kick.text, /Thus, the output cannot hold the setpoint\./);
    assert.match(kick.text, /The gyro rate moves 113 deg\/s away from the setpoint\./, "the quarter means: 19 to 131 deg/s");
    // a torque change: at a setpoint of 0 the yaw rate 130 to 215 and then 112 deg/s, the tail at its limit: the error at the end is less than at its largest
    const load = make(w => { const i0 = at(45.0), i1 = at(45.3); for (let i = i0; i < i1; i++) { const x = (i - i0) / (i1 - i0); w.sp[2][i] = 0; w.gyro[2][i] = Math.round(x < 0.5 ? 130 + 170 * x : 215 - 206 * (x - 0.5)); } });
    assert.equal(load.severity, 'flag', 'the gyro rate does not move to the setpoint'); assert.ok(load.stuck.end < 0.8 * load.stuck.peak, JSON.stringify(load.stuck));
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

// review IMP-05: a log with a parameter snapshot (blackbox_params FULL) records the mixer inputs, the servos and the I-term values of
// every PID profile: the limits come from it ("the parameter values in the log header"), above a CLI dump with other values. The
// throttle maximum of each PID profile comes from the snapshot through the ctx (health.cjs snapshotContext: paramSnapshot)
test('limits from a parameter snapshot: L1, L2, L3, L5 and L6 with the source "snapshot", above a CLI dump', () => {
    const PL = require('../tools/autotune/param_log.cjs');
    const body = [['Param log', '1'], ['param_mode', 'FULL'], ['param_loop', '1,1,1,128'], ['param_phase', 'pos=0,sp=0,pid=0,mix=0,mot=0,fupd=0,bb=0,flush=0'], ['param_pgs', '14.0/936'],
        ['param_fixes', '-'], ['param_rt', 'gov_mode=3,features=0,pid_denom=1,filter_denom=1,looptime=1000,debug_mode=0,motors=1,servos=4'], ['param_pid_profile', '0'], ['param_rate_profile', '0'],
        ['set@p.roll_i_gain', '100|||||'], ['set@p.pitch_i_gain', '100|||||'], ['set@p.yaw_i_gain', '120|||||'], ['set@p.error_limit', '45,45,60|||||'], ['set@p.gov_max_throttle', '100|||||'],
        ['el.mixin.1', '100,-400,400'], ['el.mixin.2', '100,-1250,1250'], ['el.mixin.3', '100,-1250,1250'], ['el.mixin.4', '1070,-1250,1250'],
        ['el.servo.0', '1500,-600,600,500,500,333,0,2'], ['el.servo.1', '1500,-650,650,500,500,333,0,2'], ['el.servo.2', '1500,-650,650,500,500,333,0,2'], ['el.servo.3', '1500,-400,400,500,500,333,0,2']];
    let hash = 2166136261; for (const [k, v] of body) hash = PL.fnv1(`H ${k}:${v}\n`, hash);
    body.push(['param_end', `${body.length},${(hash >>> 0).toString(16)}`]);
    const header = { 'Firmware revision': 'Rotorflight 4.7.0-bbp-pr (85d7049a9) STM32G47X', paramHeader: body };
    const HC = require('../tools/autotune/health.cjs'), sctx = HC.snapshotContext(header);
    assert.deepEqual([sctx.paramSnapshot, sctx.maxThrottle, sctx.maxThrottleSource], [true, { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 }, 'gov_max_throttle (parameter values in the log header)']);
    const cli = ['# diff all', 'mixer input SR -300 300 100', 'servo 0 1500 -500 500 500 500 333 0 2', 'profile 0', 'set roll_i_gain = 50'].join('\n');
    const { F } = run(limited(), { header, cli, maxThrottle: { 0: 100 }, paramSnapshot: true });
    const roll = one(F, 'roll'), col = one(F, 'collective'), sv = one(F, 'servo[0]'), it = one(F, 'iterm roll'), thr = one(F, 'throttle');
    assert.deepEqual([roll.limits.source, roll.limits.lo, roll.limits.hi], ['snapshot', -400, 400]);
    assert.deepEqual([col.limits.source, col.limits.lo, col.limits.hi], ['snapshot', -1250, 1250]);
    assert.deepEqual([sv.limits.source, sv.limits.lo, sv.limits.hi], ['snapshot', 900, 2100]);
    assert.equal(it.limits.source, 'snapshot'); within(it.limits.byProfile[0], 900, 0.5, 'I-term limit of PID profile 1 at the start (param_pid_profile 0)');
    assert.deepEqual([thr.limits.source, thr.limits.byProfile[0]], ['snapshot', 1000]);
    assert.match(thr.text, /The limit comes from the parameter values in the log header\./);
    assert.match(sv.text, /The limit comes from the parameter values in the log header\.|the parameter values in the log header/);
});

// review IMP-05 on the crash log (a 4.7-bbp log with a complete FULL snapshot, no CLI dump): health.cjs buildCtx takes gov_max_throttle of
// each PID profile from the snapshot, and L1 and G6 give that limit (1000 for PID profiles 1 and 2) with the snapshot as the source
const PARAM_LOG = process.env.PARAM_EPOCHS_LOG;
test('real: the crash log with no CLI dump: the throttle maximum of L1 and G6 from the parameter snapshot', { skip: !PARAM_LOG || !fs.existsSync(PARAM_LOG) ? 'set PARAM_EPOCHS_LOG to the crash log (analysis/fireball-crash-20261015/crash.bbl)' : false }, (t) => {
    const HC = require('../tools/autotune/health.cjs'), G = require('../tools/autotune/health_gov.cjs');
    const extra = [...new Set(EXTRA.concat(G.EXTRA, ['govTarget']))];
    for (const w of lib.segments(app, PARAM_LOG, { whole: true, extra })) {
        if (w.skipped) continue;
        if (!HC.snapshotContext(w.flight.header).paramSnapshot) return t.skip('PARAM_EPOCHS_LOG has no parameter snapshot');
        const fl = w.flight, { p: profile } = lib.profilesOf(w, w.extra.govTarget || w.hs, HC.RULE.flight.headspeed), { flying } = HC.flightMask(w, fl.actualRate);
        const ctx = HC.buildCtx(w, fl, { flying, profile, cli: null, cliParsed: null, app });
        assert.equal(ctx.paramSnapshot, true); assert.deepEqual([ctx.maxThrottle[1], ctx.maxThrottle[2]], [100, 100]);
        const g = G.analyse(w, Object.assign({}, ctx)), L1 = one(L.judge([{ log: 0, header: fl.header, metrics: JSON.parse(JSON.stringify(L.analyse(w, Object.assign({}, ctx)))) }]), 'throttle');
        for (const p of [1, 2]) { const c = g.G6.byProfile[p]; assert.ok(c, `G6 of PID profile ${p}`); assert.deepEqual([c.ceiling, c.ceilingSource], [1000, 'gov_max_throttle (parameter values in the log header)'], `PID profile ${p}`); }
        assert.equal(L1.limits.source, 'snapshot'); assert.deepEqual([L1.limits.byProfile[1], L1.limits.byProfile[2]], [1000, 1000]);
        assert.match(L1.text, /the parameter values in the log header/);
        return;
    }
});

// IMP-12: the plateau rule of a limit from the data, the high end of the collective stick in every phase with the rotor turning, and the
// periods with a cause (a receiver signal loss, the fall and the time after the ground contact of an in-flight cut) in a finding of their own
test('IMP-12: a data limit needs the PID sum more than it; L7 high end with the rotor turning; periods with a cause are a value to monitor of their own', () => {
    // the roll output at 450 for 0.2 s with the PID sum less than it: the extreme of the data, not a clamp. At 500 with the sum more than it: a clamp
    const noClamp = limited(), X0 = noClamp.w.extra, set = (col, a, b, v) => { for (let i = at(a); i < at(b); i++) col[i] = v; };
    set(noClamp.w.u[0], 25.0, 25.2, 0.45);
    const roll0 = one(run(noClamp).F, 'roll'); assert.equal(roll0.severity, 'skipped'); assert.equal(roll0.limitUnknown, true, 'no plateau evidence: limit unknown');
    const clamp = limited(); set(clamp.w.u[0], 25.0, 25.2, 0.5); set(clamp.w.P[0], 25.0, 25.2, 0.7);
    const roll1 = one(run(clamp).F, 'roll'); assert.deepEqual([roll1.limits.source, roll1.limits.hi], ['data', 500]); within(roll1.longestS, 0.2, 0.002, 'the clamp period');
    // L7: +500 at 2.0-2.3 s in the spool-up (the rotor turns, armed): counted; -500 at 2.5-2.8 s on the ground: not counted; +500 at 0.2-0.5 s, the rotor stopped: not counted
    const st = limited(); set(st.w.extra['rcCommand[3]'], 2.0, 2.3, 500); set(st.w.extra['rcCommand[3]'], 2.5, 2.8, -500); set(st.w.extra['rcCommand[3]'], 0.2, 0.5, 500);
    const cmd = one(run(st).F, 'collectiveCommand'); assert.deepEqual(cmd.events.map(e => [e.tS, e.side]).sort((x, y) => x[0] - y[0]), [[2, 'hi'], [20.05, 'hi']]);
    // the throttle at 100 % in a receiver signal loss (40.5-41.0 s): a finding of its own, 'receiver loss', a value to monitor; the other periods do not change
    const rx = limited(); set(rx.w.extra['motor[0]'], 40.6, 40.75, 1000);
    rx.slow.rxSignalReceived = Float64Array.from(rx.slow.rxSignalReceived, (v, i) => i >= at(40.5) && i < at(41) ? 0 : v); rx.slow.rxFlightChannelsValid = Float64Array.from(rx.slow.rxSignalReceived);
    const thr = run(rx).F.filter(f => f.channel === 'throttle'), normal = thr.find(f => !f.cause), caused = thr.find(f => f.cause);
    assert.equal(thr.length, 2); assert.deepEqual([normal.severity, normal.n], ['flag', 2], 'the periods with no cause as before');
    assert.deepEqual([caused.severity, caused.cause, caused.n, caused.causeChecks], ['note', 'receiver loss', 1, ['D10']]); within(caused.value, 0.15, 0.002, 'the period in the loss');
    assert.match(caused.text, /These periods come after the receiver signal stops \(check D10\)\. Thus, they do not show a problem of the control or of the tuning\./);
    const C = require('../tools/autotune/catalog.cjs'), Hh = require('../tools/autotune/hierarchy.cjs');
    assert.deepEqual([C.status(caused), C.areaOf(caused), Hh.nodeOfFinding(caused), C.status(normal), C.areaOf(normal), Hh.nodeOfFinding(normal)], ['monitor', 'radio', 'rescue', 'problem', 'limits', 'governor']);
    assert.match(C.summary(caused), /These periods come after the receiver signal stops \(check D10\)\. Thus, they do not show a problem of the tuning\./);
});

// review IMP-12: a period that runs into a receiver signal loss is split where the cut of the loss starts: the part before it keeps its
// severity (no guard time removes it), the part in the loss has the cause
test('IMP-12 review: a period into a receiver signal loss is split at the start of the cut; the part before it stays a problem', () => {
    const rx = limited(), set = (col, a, b, v) => { for (let i = at(a); i < at(b); i++) col[i] = v; }; set(rx.w.extra['motor[0]'], 40.2, 40.75, 1000); hsDrop(rx.w, 40.2, 40.75, 0.85);
    rx.slow.rxSignalReceived = Float64Array.from(rx.slow.rxSignalReceived, (v, i) => i >= at(40.5) && i < at(41) ? 0 : v); rx.slow.rxFlightChannelsValid = Float64Array.from(rx.slow.rxSignalReceived);
    const { w, F } = run(rx), thr = F.filter(f => f.channel === 'throttle'), normal = thr.find(f => !f.cause), caused = thr.find(f => f.cause), cut0 = w.rxLossAt.indexOf(1) / RATE;
    const before = normal.events.find(e => e.tS >= 40.1), inLoss = caused.events[0];
    assert.ok(before, JSON.stringify(normal.events)); within(before.tS, 40.2, 0.002, 'the period starts before the loss'); within(before.t1S, cut0, 0.002, 'it ends where the cut of the loss starts');
    assert.ok(before.seconds >= 0.15 && !before.cause && normal.severity === 'flag', JSON.stringify(before));
    within(inLoss.tS, cut0, 0.002, 'the part in the loss starts at the cut'); within(inLoss.t1S, 40.75, 0.002, 'its end'); assert.equal(inLoss.cause, 'receiver loss');
});

// review IMP-12: a CLI dump can be older than the log. A limit of check T8 that differs from the mixer input SY of the dump wins, with a note
test('IMP-12 review: a CLI limit SY wider than the T8 clamp of this log: the T8 limit, and the conflict in the text', () => {
    const cli = ['# diff all', 'mixer input SY -1250 1250 100'].join('\n');
    const tail = one(run(limited(), { cli, tailLimits: { lo: -0.8, hi: 0.8 } }).F, 'tail');
    assert.deepEqual([tail.limits.source, tail.limits.lo, tail.limits.hi], ['T8', -800, 800]); assert.notEqual(tail.severity, 'ok'); within(tail.longestS, 0.1, 0.002, 'the tail at the T8 clamp in the rescue');
    assert.deepEqual(tail.conflict, { input: 'SY', cli: [-1250, 1250], log: [-800, 800], source: 'T8' });
    assert.match(tail.text, /The CLI dump gives the limits -1250 and 1250 for the mixer input SY, but check T8 shows a limit at -800 and 800\. Thus, the CLI dump is possibly not from the time of this log\. The app uses the limit of this log\./);
    // the same limit in the CLI dump and in this log: the CLI dump, no conflict
    const same = one(run(limited(), { cli: ['# diff all', 'mixer input SY -800 800 100'].join('\n'), tailLimits: { lo: -0.8, hi: 0.8 } }).F, 'tail');
    assert.deepEqual([same.limits.source, same.conflict], ['cli', undefined]);
});

// review IMP-12: with the phases, only the periods in flight or in a rescue decide a problem. A period at IDLE, in the spool-up or the spool-down
// (or with the rotor stopped) is a value to monitor of its own (outOfFlight), and a period on the ground is a value to monitor in its finding
test('IMP-12 review: periods out of flight and on the ground do not make a problem; L7 high end in flight with no RPM signal', () => {
    const log = limited(), w = log.w, set = (col, a, b, v) => { for (let i = at(a); i < at(b); i++) col[i] = v; };
    set(w.u[2], 2.0, 2.3, 0.8); set(w.F[2], 2.0, 2.3, 1.0);   // the spool-up (1-4 s): 0.3 s at the tail limit
    set(w.u[2], 4.5, 4.8, 0.8); set(w.F[2], 4.5, 4.8, 1.0);   // on the ground (ACTIVE, 4-6 s): 0.3 s
    for (let i = 0; i < w.n; i++) log.w.extra['servo[3]'][i] = Math.round(1500 + 500 * w.u[2][i]);
    const n = w.n, code = new Uint8Array(n), fill = (a, b, c) => code.fill(c, at(a), at(b)); fill(0, 1, 0); fill(1, 4, 1); fill(4, 6, 2); fill(6, 54, 3); fill(54, 58, 2); fill(58, 60, 0);
    const profile = new Uint8Array(n).fill(1); profile.fill(2, at(4), at(6));   // the ground period in a PID profile of its own
    const { F } = run(log, { tailLimits: { lo: -0.8, hi: 0.8 }, phases: { code }, profile });
    const tail = F.filter(f => f.channel === 'tail'), still = tail.find(f => f.outOfFlight), ground = tail.find(f => f.profile === 2), air = tail.find(f => f.profile === 1 && !f.outOfFlight);
    assert.deepEqual([still.severity, still.n, still.events[0].phase], ['note', 1, 'spoolup']); within(still.longestS, 0.3, 0.002, 'the spool-up period');
    assert.match(still.text, /These periods come at IDLE, during the spool-up or the spool-down, or with the rotor stopped\. Thus, they do not show a problem of the control\./);
    assert.deepEqual([ground.severity, ground.groundN, ground.outOfFlight], ['note', 1, undefined], 'a 0.3 s period on the ground: a value to monitor');
    assert.match(ground.text, /1 period is on the ground\. A period on the ground is a value to monitor, not a problem\./);
    assert.equal(air.severity, 'flag', 'the rescue period decides'); assert.ok(F.every(f => !(f.n > 0) || f.severity !== 'ok'));
    const C = require('../tools/autotune/catalog.cjs'), Hh = require('../tools/autotune/hierarchy.cjs');
    assert.deepEqual([C.status(still), C.areaOf(still), Hh.nodeOfFinding(still)], ['monitor', 'limits', 'tailcomp'], 'its home item, a value to monitor (no block)');
    // L7: the collective stick at its high end in flight with no RPM signal (the headspeed recorded as 0): counted (the rotor speed is unknown)
    const noRpm = limited(), file = path.join(tmp, `norpm${Math.random().toString(36).slice(2)}.bbl`); fs.writeFileSync(file, bbl.encode([noRpm]).bytes);
    const [v] = [...lib.segments(app, file, { whole: true, extra: EXTRA })].filter(q => !q.skipped); v.hs.fill(0);
    const c7 = L.judge([{ log: 0, header: v.flight.header, metrics: JSON.parse(JSON.stringify(L.analyse(v, { rate: v.flight.actualRate, header: v.flight.header, profile: v.profileAt, govState: v.govStateAt, phases: { code } }))) }]).filter(f => f.channel === 'collectiveCommand');
    assert.ok(c7.some(f => (f.events || []).some(e => Math.abs(e.tS - 20.05) < 0.002 && e.side === 'hi')), JSON.stringify(c7.map(f => f.events)));
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

// IMP-12 on the crash log 2026-10-15 (no CLI dump): the limits of the mixer inputs from the parameter snapshot, the in-flight tail limit, no
// in-flight roll period (+415/-435 is the extreme of the data, not a clamp), L7 after the RX return with its cause
const CRASH = path.join(__dirname, '../analysis/fireball-crash-20261015/crash.bbl');
test('real: the crash log 2026-10-15: snapshot limits, the in-flight tail limit, no roll period in flight, L7 after the RX return with its cause (IMP-12)', { skip: !fs.existsSync(CRASH) ? 'analysis/fireball-crash-20261015/crash.bbl is not here' : false }, () => {
    const P = require('../tools/autotune/health_phase.cjs'), [w] = [...lib.segments(app, CRASH, { whole: true, extra: [...new Set(EXTRA.concat(P.EXTRA))] })].filter(q => !q.skipped), fl = w.flight;
    const ctx = { rate: fl.actualRate, header: fl.header, profile: w.profileAt, govState: w.govStateAt, flightRule: { headspeed: 2900 }, airborneEvents: true };
    ctx.phases = P.phases(w, Object.assign({}, ctx));
    const F = L.judge([{ log: 0, header: fl.header, metrics: JSON.parse(JSON.stringify(L.analyse(w, ctx))) }]), inFlight = (f) => (f.events || []).filter(e => e.phase === 'flight');
    const tail = F.filter(f => f.channel === 'tail'), tailFlight = tail.flatMap(inFlight);
    assert.equal(tailFlight.length, 1); within(tailFlight[0].tS, 32.639, 0.003, 'tail start'); within(tailFlight[0].t1S, 32.677, 0.003, 'tail end');
    assert.equal(tailFlight[0].limit, -1517); assert.equal(tail[0].limits.source, 'snapshot');
    const roll = F.filter(f => f.channel === 'roll'); assert.equal(roll.flatMap(inFlight).length, 0); assert.deepEqual([roll[0].limits.lo, roll[0].limits.hi, roll[0].limits.source], [-1250, 1250, 'snapshot']);
    const cmd = F.filter(f => f.channel === 'collectiveCommand'); assert.equal(cmd.length, 1); const c = cmd[0];
    assert.equal(c.n, 1); within(c.events[0].tS, 70.541, 0.002, 'L7 start: the first frame after the RX return'); within(c.events[0].t1S, 71.69, 0.03, 'L7 end');
    assert.equal(c.cause, 'receiver loss / after contact'); assert.notEqual(c.severity, 'ok');
    // every period after the receiver signal stops has a cause, and every finding with a cause is a value to monitor
    for (const f of F) for (const e of f.events || []) if (e.tS >= 68.334 && e.tS < 72.85) assert.ok(e.cause, `${f.channel} ${e.tS}: a cause`);
    for (const f of F.filter(q => q.cause)) assert.equal(f.severity, 'note', `${f.channel} ${f.cause}`);
    // review IMP-12: the pre-flight stick check at IDLE (L3 pitch 5.07-5.54 s, L4 tail 3.61-4.71 s): a value to monitor out of flight, not a problem
    const out = F.filter(q => q.outOfFlight);
    assert.ok(out.some(q => q.channel === 'pitch') && out.some(q => q.channel === 'tail'), JSON.stringify(out.map(q => q.channel)));
    for (const f of out) { assert.equal(f.severity, 'note'); assert.ok(f.events.every(e => e.phase === 'idle' && e.tS < 6), JSON.stringify(f.events.map(e => [e.tS, e.phase]))); }
    assert.ok(F.filter(q => q.severity === 'flag').every(q => q.events.some(e => e.phase === 'flight' || e.rescue)), 'a problem only from a period in flight or in a rescue');
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
