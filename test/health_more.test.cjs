// Ground-truth checks for tools/autotune/health_more.cjs: synthetic whole-log segments with known abnormal spans, D-term
// and mixer noise, gyro filters, hover trims, a collective-to-pitch coupling, headspeed ramps against a yaw loop, and
// governor state sequences, logged the way the flight controller does (rounded integers), and the checks must find what
// was put in and nothing on the clean variants.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../tools/autotune/lib.cjs');
const M = require('../tools/autotune/health_more.cjs');

const RATE = 1000, app = lib.loadApp(), FLIGHT = { headspeed: 2000, rate: 10, minS: 5 };
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function gauss(rand) { return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand()); }
const q = (x) => Math.round(x * 1000) / 1000; // control and PID terms as logged: integer permille
const at = (s) => Math.round(s * RATE);
const noise = (n, rand, lo, hi) => { const x = lib.bandpass(Float64Array.from({ length: n }, () => gauss(rand)), lo, hi, RATE); let s = 0; for (const v of x) s += v * v; const k = 1 / Math.sqrt(s / n); return x.map(v => v * k); }; // unit rms
// the roll movement of a helicopter in the air (0.2-1.5 Hz, rms deg/s) in t0-t1 s: health_phase.cjs calls only such time a
// flight (the ground contact of normalMask is the time out of its flight phase)
function sway(w, t0, t1, seed, rms = 8) { const x = noise(w.n, rng(seed), 0.2, 1.5); for (let i = at(t0); i < Math.min(w.n, at(t1)); i++) w.gyro[0][i] = Math.round(w.gyro[0][i] + rms * x[i]); return w; }

// firmware filters, sample by sample (filter.c), as health_loop.test.cjs
const lp = (fc) => { const W = Math.tan(Math.PI * fc / RATE); return { a1: (W - 1) / (W + 1), b0: W / (W + 1), x1: 0, y1: 0, run(x) { const y = this.b0 * x + this.b0 * this.x1 - this.a1 * this.y1; this.x1 = x; this.y1 = y; return y; } }; };
const df = (fc) => { const W = Math.tan(Math.PI * fc / RATE); return { a: (W - 1) / (W + 1), b: 2 * RATE * W / (W + 1), x1: 0, y1: 0, run(x) { const y = this.b * (x - this.x1) - this.a * this.y1; this.x1 = x; this.y1 = y; return y; } }; };

// a whole-log segment as lib.segments yields it (whole: true): hovering at 2500 rpm, governor ACTIVE, profile 1, zero sticks
function makeW(seconds, header = {}) {
    const n = at(seconds), col = () => new Float64Array(n), three = () => [col(), col(), col()];
    return { flight: { log: 0, id: 'sim', actualRate: RATE, rate: RATE, header: Object.assign({ firmwareVersion: '4.6.0', collectiveRange: [-1250, 1250], yaw_inertia_precomp: [0, 25], pitch_compensation: 0 }, header) },
        whole: true, n, rate: RATE, fromS: 0, seconds, sp: three(), gyro: three(), u: three(), P: three(), I: three(), D: three(), F: three(), B: [null, null, null],
        hs: col().fill(2500), coll: col().fill(400), profileAt: new Uint8Array(n).fill(1), airborneAt: new Uint8Array(n).fill(1), govStateAt: new Uint8Array(n).fill(4),
        extra: Object.fromEntries(M.EXTRA.map(k => [k, null])) };
}
// ctx as health.cjs buildCtx; in flight = airborne and headspeed >= 2000 rpm
function ctxOf(w, over = {}) {
    const flying = Uint8Array.from(w.airborneAt, (a, i) => a && w.hs[i] >= FLIGHT.headspeed ? 1 : 0);
    return Object.assign({ flying, profile: Uint8Array.from(w.profileAt), govState: w.govStateAt, rate: RATE, header: w.flight.header, app, flightRule: FLIGHT }, over);
}
function run(w, ctx = ctxOf(w)) {
    const metrics = M.analyse(w, ctx); JSON.stringify(metrics); // must serialise
    const findings = M.judge([{ log: 0, start: 'sim', header: w.flight.header, metrics }], M.DEFAULT_RULES);
    // every finding: a unit, thin data as a field (the text is for the reader), no semicolon, "+-" or ">=" in the text
    for (const f of findings) { assert.ok(f.unit && typeof f.text === 'string', JSON.stringify(f)); assert.equal(!!f.thin, /^The data is not sufficient for a result\./.test(f.text), f.text);
        if (f.thin) assert.equal(f.severity, 'note'); assert.doesNotMatch(f.text, /;|\+-|>=|<=|no finding/, `${f.id}: ${f.text}`);
        assert.equal(f.axis, { T13: 'yaw', C14: 'pitch', T14: 'yaw', D6: undefined, G14: undefined }[f.id] ?? f.axis, `${f.id} axis`); assert.ok(f.id === 'D6' || f.id === 'G14' || typeof f.axis === 'string' || f.severity === 'skipped' && f.id !== 'T13' && f.id !== 'C14' && f.id !== 'T14' || f.id === 'F10' || f.id === 'F11', `${f.id}: an axis`); }
    return { metrics, findings };
}
const within = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);
const find = (F, id, o = {}) => F.filter(f => f.id === id && Object.entries(o).every(([k, v]) => f[k] === v));

// ---------------------------------------------------------------------------------------------
// normalMask and D6
// ---------------------------------------------------------------------------------------------

// spool-up 5-15 s, airborne 20-105 s with a 1 s drop-out at 70 s, rescue 40-45 s, ANGLE 60-63 s, failsafe switch 80-81 s,
// failsafePhase 90-90.5 s; collective -200 on the ground, through 300 at 22.667 s, back down at 103 s; roll movement from
// 21 s to 103 s. health_phase: liftoff at 22.467 s (the collective at 0.6 x the hover 400), touchdown at 103 s (the
// collective decrease, no touchdown movement)
function abnormalW(header) {
    const w = makeW(120, header), n = w.n;
    for (let i = 0; i < n; i++) { const t = i / RATE; w.hs[i] = t < 5 ? 0 : t < 15 ? 250 * (t - 5) : t < 110 ? 2500 : t < 118 ? 2500 * (118 - t) / 8 : 0;
        w.coll[i] = t < 21 ? -200 : t < 23 ? -200 + 300 * (t - 21) : t < 103 ? 400 : -200; }
    w.airborneAt.fill(0); w.airborneAt.fill(1, at(20), at(105)); w.airborneAt.fill(0, at(70), at(71));
    const fm = new Float64Array(n).fill(1);
    for (let i = at(40); i < at(45); i++) fm[i] += 32; for (let i = at(60); i < at(63); i++) fm[i] += 2; for (let i = at(80); i < at(81); i++) fm[i] += 128;
    const fp = new Float64Array(n); fp.fill(1, at(90), at(90.5));
    Object.assign(w.extra, { flightModeFlags: fm, failsafePhase: fp, 'mixer[3]': w.coll });
    return sway(w, 21, 103, 9);
}

test('normalMask excludes rescue with its exit blend, level mode, failsafe and ground contact, each widened by 1 s', () => {
    const w = abnormalW(), ctx = ctxOf(w), nm = M.normalMask(w, ctx), x = nm.excluded;
    within(x.rescueS, 5.5, 0.006, 'rescue 40-45 s plus the 0.5 s exit blend');
    within(x.levelModeS, 3, 0.006, 'ANGLE 60-63 s');
    within(x.failsafeS, 1.5, 0.006, 'failsafe switch 1 s and failsafePhase 0.5 s');
    within(x.groundS, (22467 - 20000 + 2000) / RATE, 0.006, 'out of the flight phase of health_phase: the airborne flag from 20 s to the liftoff at 22.467 s, and from the touchdown at 103 s to 105 s; the drop-out at 70 s is flight');
    within(x.guardS, 10, 0.006, '1 s either side of four spans in flight, one side of the two ground spans');
    let flying = 0, normal = 0; for (let i = 0; i < w.n; i++) { flying += ctx.flying[i]; normal += nm.mask[i]; }
    within((flying - normal) / RATE, 5.5 + 3 + 1.5 + 4.467 + 10, 0.002, 'every excluded sample counted once');
    assert.equal(nm.mask[at(50)], 1); assert.equal(nm.mask[at(45.9)], 0); assert.equal(nm.mask[at(46.6)], 1);
    assert.deepEqual(nm.notes, []); assert.equal(nm.groundSource, 'phases');
    // the phases of the engine (ctx.phases) give the same mask; without health_phase (ctx.phases false) the rule it replaces:
    // take-off until |collective| > 300 plus 0.5 s, and the last 2 s before landing
    const P = require('../tools/autotune/health_phase.cjs'), ph = P.phases(w, ctx);
    assert.deepEqual([ph.class, ph.liftoffs, ph.touchdowns], ['flight', [22467], [103000]]);
    assert.deepEqual(M.normalMask(w, Object.assign({}, ctx, { phases: ph })).excluded, x);
    const old = M.normalMask(w, Object.assign({}, ctx, { phases: false }));
    within(old.excluded.groundS, (23167 - 20000 + 2000) / RATE, 0.006, 'the airborne-flag rule'); assert.equal(old.groundSource, 'airborne');
});

test('D6 flags failsafe while airborne and reports the excluded seconds; ctx.normal gives the same numbers', () => {
    const w = abnormalW(), { metrics, findings } = run(w), d = find(findings, 'D6');
    assert.equal(d.length, 1); assert.equal(d[0].severity, 'flag'); within(d[0].value, 1.5, 0.002, 'failsafe seconds while airborne');
    assert.equal(metrics.D6.rescueActivations, 1);
    assert.match(d[0].text, /^Failsafe was active for 1\.50 s in flight, first at 80 s\. Examine the receiver link and the failsafe adjustments\. /);
    assert.deepEqual(d[0].events.map(e => e.t), [80, 90], 'the failsafe spans: the switch at 80 s, failsafePhase at 90 s');
    // the engine path: mask ANDed into ctx.flying, ctx.normal set, the health.cjs mask kept as ctx.flyingAll; without
    // flyingAll the health.cjs gate is applied again
    const ctx = ctxOf(w), nm = M.normalMask(w, ctx), masked = Object.assign({}, ctx, { flying: Uint8Array.from(ctx.flying, (v, i) => v & nm.mask[i]), normal: nm.mask, flyingAll: ctx.flying });
    assert.deepEqual(M.analyse(w, masked).D6.excluded, metrics.D6.excluded);
    const { flyingAll, ...noAll } = masked; assert.deepEqual(M.analyse(w, noAll).D6.excluded, metrics.D6.excluded);
    // a clean flight: nothing to exclude, no flag
    const c = sway(makeW(60), 0, 60, 5); c.extra.flightModeFlags = new Float64Array(c.n).fill(1); c.extra.failsafePhase = new Float64Array(c.n);
    const D = find(run(c).findings, 'D6')[0]; assert.equal(D.severity, 'ok', D.text);
});

// lib rescueAt (RESCUE_STATE != 0) runs 40-47 s: the switch drops at 45 s and the firmware's EXIT state lasts 2 s
// (rescue_exit_time 20), past the default 0.5 s that the switch span alone assumes
test('normalMask takes rescue from RESCUE_STATE events: an exit blend of any length, with or without flightModeFlags', () => {
    const w = abnormalW(); w.rescueAt = new Uint8Array(w.n); w.rescueAt.fill(1, at(40), at(47));
    const ctx = ctxOf(w), nm = M.normalMask(w, ctx), x = nm.excluded;
    within(x.rescueS, 7, 0.006, 'rescue 40-47 s as the firmware flew it'); within(x.guardS, 10, 0.006, 'guard unchanged');
    for (let i = 0; i < w.n; i++) if (w.rescueAt[i] && nm.mask[i]) assert.fail(`rescue sample ${i / RATE} s left in the mask`);
    assert.equal(nm.mask[at(47.9)], 0); assert.equal(nm.mask[at(48.1)], 1);
    assert.equal(nm.rescueSource, 'The analysis finds rescue from the RESCUE_STATE log events and the RESCUE switch.');
    const d = find(run(w).findings, 'D6')[0];
    assert.match(d.text, /Of this time, 7\.00 s is rescue, 3\.00 s is a level mode, 1\.50 s is failsafe and 4\.47 s is ground contact\. .* Rescue operated 1 time, and the rescue time includes the exit time\.\nThe analysis finds rescue from the RESCUE_STATE log events and the RESCUE switch\.$/);
    // no flightModeFlags: rescue still comes from the events, level modes and the failsafe switch are not applied
    w.extra.flightModeFlags = null;
    const nf = M.normalMask(w, ctxOf(w)); within(nf.excluded.rescueS, 7, 0.006, 'rescue from the events alone');
    assert.ok(nf.notes.includes('The log does not have flightModeFlags. Thus, the analysis cannot remove the periods with a level mode or with the failsafe switch on. It finds rescue only from the RESCUE_STATE log events.'), nf.notes.join('; '));
    assert.equal(run(w).metrics.D6.rescueActivations, 1);
    // a log without RESCUE_STATE events: the switch plus the default exit, as before
    const o = abnormalW(); o.rescueAt = new Uint8Array(o.n);
    within(M.normalMask(o, ctxOf(o)).excluded.rescueS, 5.5, 0.006, 'switch 40-45 s plus 0.5 s'); assert.match(M.normalMask(o, ctxOf(o)).rescueSource, /RULE\.rescueExitS/);
});

test('normalMask without the fields: reasons not applied are listed; RF 4.2 failsafe bit', () => {
    const w = abnormalW(); w.extra.flightModeFlags = null;
    const nm = M.normalMask(w, ctxOf(w));
    assert.equal(nm.excluded.rescueS, 0); assert.equal(nm.excluded.levelModeS, 0); within(nm.excluded.failsafeS, 0.5, 0.006, 'failsafePhase only');
    assert.ok(nm.notes.some(s => /^The log does not have flightModeFlags\. /.test(s)), nm.notes.join('; '));
    // no AIRBORNE_STATE events: health_phase finds the flight from the headspeed, the collective and the movement (22.467-103 s),
    // and the rest of the time at the flight rpm (13-111.6 s) is ground contact; the airborne-flag rule could not remove any
    const a = abnormalW(); a.airborneAt.fill(1);
    const na = M.normalMask(a, ctxOf(a)); within(na.excluded.groundS, (22467 - 13000 + 111601 - 103000) / RATE, 0.006, 'out of the flight phase at the flight rpm');
    assert.ok(!na.notes.some(s => /AIRBORNE_STATE/.test(s)), na.notes.join('; '));
    const nb = M.normalMask(a, Object.assign(ctxOf(a), { phases: false })); assert.equal(nb.excluded.groundS, 0);
    assert.ok(nb.notes.includes('The log does not record AIRBORNE_STATE. Thus, the analysis cannot remove ground contact.'), nb.notes.join('; '));
    // bit 4 is FAILSAFE in 4.2 and ALTHOLD from 4.3
    for (const [v, want] of [['4.2.10', 2], ['4.6.0', 0]]) { const b = abnormalW({ firmwareVersion: v }); b.extra.failsafePhase = null;
        b.extra.flightModeFlags = new Float64Array(b.n).fill(1); for (let i = at(50); i < at(52); i++) b.extra.flightModeFlags[i] += 16;
        within(M.normalMask(b, ctxOf(b)).excluded.failsafeS, want, 0.006, `failsafe with firmware ${v}`); }
});

// ---------------------------------------------------------------------------------------------
// F10: D-term and mixer noise
// ---------------------------------------------------------------------------------------------

function noiseW(yawHf, seed, seconds = 100) {
    const w = makeW(seconds), n = w.n, rand = rng(seed);
    for (let a = 0; a < 3; a++) { const lf = noise(n, rand, 0.5, 5), hf = noise(n, rand, 80, 160);
        for (let i = 0; i < n; i++) w.D[a][i] = q(0.01 * lf[i] + (a === 2 ? yawHf : 0.002) * hf[i]); }
    const lf = noise(n, rand, 0.5, 5);
    for (let i = 0; i < n; i++) { w.u[0][i] = q(0.003 * Math.sin(2 * Math.PI * 120 * i / RATE) + 0.05 * lf[i]); w.u[2][i] = q(-0.3 + 0.05 * lf[i]); }
    return w;
}

test('F10 flags yaw D driven by noise above 30 Hz; mixer noise in permille rms', () => {
    const N = run(noiseW(0.02, 3)), y = N.metrics.F10.yaw.byProfile[1];
    within(y.share, 0.8, 0.03, 'yaw D share above 30 Hz (power 0.02^2 / (0.01^2 + 0.02^2))');
    const f = find(N.findings, 'F10', { axis: 'yaw' })[0]; assert.equal(f.severity, 'flag', f.text); assert.equal(f.value, y.share);
    assert.match(f.text, /This is more than 50 % by more than 2 SE\. Most of the yaw D-term comes from gyro noise at more than 30 Hz\. Correct the filters first\. Then decrease yaw_d_gain\./);
    within(N.metrics.F10.roll.byProfile[1].controlPermille, 3 / Math.SQRT2, 0.05, 'roll mixer rms above 30 Hz of a 3 permille 120 Hz line');
    // roll and pitch: the mixer noise only, their D share is C11's (health_loop), the same measure
    for (const ax of ['roll', 'pitch']) { const g = find(N.findings, 'F10', { axis: ax })[0], s = N.metrics.F10[ax].byProfile[1];
        assert.equal(g.severity, 'note', `${ax} is report only`); assert.equal(g.unit, 'permille'); assert.equal(g.value, s.controlPermille); assert.equal(g.se, s.controlSe);
        assert.match(g.text, new RegExp(`^The ${ax} mixer output at more than 30 Hz is [\\d.]+ ± [\\d.]+ ‰ rms \\(.*\\)\\. C11 measures the ${ax} D-term at more than 30 Hz\\.$`)); assert.ok(s.share > 0, 'the share stays in the metrics (curves label)'); }
    const C = run(noiseW(0.003, 4)), c = find(C.findings, 'F10', { axis: 'yaw' })[0];
    within(C.metrics.F10.yaw.byProfile[1].share, 0.083, 0.02, 'clean yaw D share'); assert.equal(c.severity, 'ok', c.text);
    // 20 s: 20 windows but 2 blocks of 10 s; the note names the criterion that failed
    // worst windows: a 1 s burst of 0.05 at 80-160 Hz in the yaw D at 50 s (share 0.05^2 / (0.01^2 + 0.05^2 + 0.003^2) there)
    const b = noiseW(0.003, 4), hb = noise(b.n, rng(5), 80, 160); for (let i = at(50); i < at(51); i++) b.D[2][i] = q(b.D[2][i] + 0.05 * hb[i]);
    const W = run(b).metrics.F10, wy = W.yaw.byProfile[1].worst, wr = W.roll.byProfile[1].worst;
    assert.deepEqual([wy.length, wy[0].t0, wy[0].t1], [3, 50, 51], JSON.stringify(wy)); within(wy[0].value, 0.05 ** 2 / (0.01 ** 2 + 0.05 ** 2 + 0.003 ** 2), 0.05, 'yaw D share in the window');
    assert.ok(wy[0].value === wy[0].share && wy[1].value < wy[0].value - 0.3 && wy.every((x, k) => x.t1 - x.t0 === 1 && (k === 0 || x.value <= wy[k - 1].value)), JSON.stringify(wy));
    assert.ok(wr.every((x, k) => x.value === x.controlPermille && Math.abs(x.value - 3 / Math.SQRT2) < 0.3 && (k === 0 || x.value <= wr[k - 1].value)), 'roll: ranked by the mixer noise it judges');
    const t = find(run(noiseW(0.02, 3, 20)).findings, 'F10', { axis: 'yaw' })[0]; assert.ok(t.severity === 'note' && t.thin === true, JSON.stringify(t));
    assert.match(t.text, /^The data is not sufficient for a result\. The number of periods of 10 s is 2\. A minimum of 3 is necessary\.\n/);
});

// ---------------------------------------------------------------------------------------------
// F11: gyro filter delay
// ---------------------------------------------------------------------------------------------

// gyroRAW broadband body motion; gyroADC = first-order LPF (roll 100 Hz, pitch 50 Hz) or a 7-sample delay (yaw)
function filterW(fc) {
    const w = makeW(100), n = w.n, rand = rng(7);
    for (let a = 0; a < 3; a++) {
        const raw = noise(n, rand, 1, 60).map(v => Math.round(100 * v)), filt = a < 2 ? lib.lpf1(raw, fc[a], RATE) : Float64Array.from(raw, (v, i) => raw[Math.max(0, i - 7)]);
        w.extra[`gyroRAW[${a}]`] = raw; w.gyro[a] = filt.map(Math.round);
    }
    return w;
}
// what F11 averages: -arg(H) / (2 pi f) over its bins (about 1 Hz apart, 8-16 Hz)
function analyticDelayMs(fc) {
    const N = 2 ** Math.round(Math.log2(RATE)), df = RATE / N, ks = []; for (let k = Math.ceil(8 / df); k <= Math.floor(16 / df); k++) ks.push(k);
    return 1000 * ks.reduce((s, k) => s - lib.cx.arg(lib.lpf1Response(k * df, fc, RATE)) / (2 * Math.PI * k * df), 0) / ks.length;
}
const groupDelayMs = (fc, f) => -1000 * (lib.cx.arg(lib.lpf1Response(f + 0.01, fc, RATE)) - lib.cx.arg(lib.lpf1Response(f - 0.01, fc, RATE))) / (2 * Math.PI * 0.02);

test('F11 measures the gyro filter delay within 0.3 ms of the analytic value', () => {
    const { metrics, findings } = run(filterW([100, 50]));
    within(metrics.F11.roll.delayMs, analyticDelayMs(100), 0.3, 'roll: first-order 100 Hz');
    within(metrics.F11.pitch.delayMs, analyticDelayMs(50), 0.3, 'pitch: first-order 50 Hz');
    for (const [ax, fc] of [['roll', 100], ['pitch', 50]]) within(metrics.F11[ax].delayMs, groupDelayMs(fc, 12), 0.3, `${ax}: group delay at 12 Hz`);
    within(metrics.F11.yaw.delayMs, 7, 0.3, 'yaw: 7 samples at 1 kHz');
    within(metrics.F11.roll.gain12, lib.cx.abs(lib.lpf1Response(metrics.F11.hz.reduce((b, h) => Math.abs(h - 12) < Math.abs(b - 12) ? h : b), 100, RATE)), 0.01, 'roll gain at 12 Hz');
    assert.ok(metrics.F11.roll.delaySe > 0 && metrics.F11.roll.delaySe < 0.2, `SE ${metrics.F11.roll.delaySe}`);
    for (const f of find(findings, 'F11')) assert.equal(f.severity, 'note', f.text);
    // a slow chain: 12 ms delay flags
    const s = filterW([100, 50]), y = s.extra['gyroRAW[2]']; s.gyro[2] = Float64Array.from(y, (v, i) => y[Math.max(0, i - 12)]);
    const f = find(run(s).findings, 'F11', { axis: 'yaw' })[0]; assert.equal(f.severity, 'flag', f.text); within(f.value, 12, 0.3, 'yaw delay');
    const none = filterW([100, 50]); none.extra['gyroRAW[1]'] = null;
    assert.match(run(none).metrics.F11.skipped, /gyroRAW/);
});

test('F11 subtracts the logging offset of 1 gyro sample (firmware 4.6.0: the log writes gyroRAW 1 gyro sample after the filter input)', () => {
    // a log at 1 kHz with a gyro sample time of 500 us: the yaw chain of 7 samples measures 7 ms, and the filter delay is 6.5 ms
    const w = filterW([100, 50]); w.flight.header.looptime = 500;
    const { metrics, findings } = run(w), M = metrics.F11;
    assert.deepEqual([M.logOffsetMs, M.gyroTickMs], [0.5, 0.5]); assert.match(M.logOffsetSource, /core\.c/);
    within(M.yaw.measuredMs, 7, 0.3, 'measured'); within(M.yaw.delayMs, 6.5, 0.3, 'less 0.5 ms'); within(M.roll.delayMs, analyticDelayMs(100) - 0.5, 0.3, 'roll');
    const f = find(findings, 'F11', { axis: 'yaw' })[0]; assert.equal(f.value, M.yaw.delayMs); assert.match(f.text, /decreases the measured 7(\.\d+)? ms by 0\.50 ms/);
    // no looptime: no offset
    const b = run(filterW([100, 50])).metrics.F11; assert.equal(b.logOffsetMs, 0); assert.equal(b.yaw.delayMs, b.yaw.measuredMs);
});

// ---------------------------------------------------------------------------------------------
// T13: hover tail I trim
// ---------------------------------------------------------------------------------------------

function hoverW(trim, seed) {
    const w = makeW(100), n = w.n, rand = rng(seed);
    for (let i = 0; i < n; i++) { const t = i / RATE; w.I[2][i] = q(trim + 0.01 * Math.sin(2 * Math.PI * t / 37) + 0.002 * gauss(rand)); w.u[2][i] = q(w.I[2][i] - 0.06 + 0.003 * gauss(rand));
        w.coll[i] = 400 + Math.round(5 * Math.sin(2 * Math.PI * t / 13)); }
    w.extra['mixer[3]'] = w.coll;
    return w;
}

test('T13 flags a constant hover yaw I and reports the hover tail pitch', () => {
    const { metrics, findings } = run(hoverW(-0.25, 5)), s = metrics.T13.byProfile[1];
    within(s.iPermille, -250, 3, 'hover yaw I, permille'); within(s.share, -0.2, 0.003, 'share of the 1250 yaw authority'); within(s.uPermille, -310, 3, 'hover mixer[2]');
    const f = find(findings, 'T13')[0]; assert.equal(f.severity, 'flag', f.text); assert.match(f.text, /tail_center_trim/);
    const c = find(run(hoverW(-0.05, 6)).findings, 'T13')[0]; assert.equal(c.severity, 'note', c.text); within(c.value, -0.04, 0.003, 'small trim');
    const y = hoverW(-0.25, 7); for (let i = 0; i < y.n; i++) y.sp[2][i] = 30 * Math.sin(2 * Math.PI * i / RATE); // yaw stick always moving: no hover
    const nh = find(run(y).findings, 'T13')[0]; assert.ok(nh.thin === true && nh.profile === null, JSON.stringify(nh)); assert.match(nh.text, /^The data is not sufficient for a result\. The log has no windows of stable hover\./);
    // a hover tail pitch at 80 % of the authority is not called normal
    const u = hoverW(-0.25, 8), ru = rng(9); for (let i = 0; i < u.n; i++) u.u[2][i] = q(u.I[2][i] - 0.8 + 0.003 * gauss(ru));
    const nu = find(run(u).findings, 'T13')[0]; within(nu.uPermille, -1050, 6, 'hover mixer[2], permille');
    assert.match(nu.text, /In hover, mixer\[2\] is -10\d\d ± \d+ ‰\. This is near the tail output limit of 1250 ‰ \(refer to T8\)\./);
});

// hovers on profile 1 (I -20 permille) and four 5 s punch-outs on profile 2 in separate 10 s blocks: full collective, the
// tail I wound up to -480 and mixer[2] at the default clamp -1250 in two of each three windows. Not a hover trim
test('T13: punch-outs are not hover windows (the tail at its limit, the collective far above the hover)', () => {
    const w = hoverW(-0.02, 11), rand = rng(12);
    for (const a of [22, 42, 62, 82]) for (let i = at(a); i < at(a + 5); i++) { const t = i / RATE;
        w.profileAt[i] = 2; w.coll[i] = 1040 + Math.round(5 * Math.sin(2 * Math.PI * t / 13)); w.I[2][i] = q(-0.48 + 0.002 * gauss(rand));
        w.u[2][i] = (t >= a + 1 && t < a + 1.03) || (t >= a + 2 && t < a + 2.03) ? -1.25 : q(-1.156 + 0.003 * gauss(rand)); }
    const { metrics, findings } = run(w), m = metrics.T13;
    assert.ok(!m.byProfile[2], `profile 2 has hover windows: ${JSON.stringify(m.byProfile[2])}`);
    assert.equal(m.atLimitWindows, 8); assert.equal(m.climbWindows, 4); within(m.collectiveMedian, 400, 6, 'median hover |collective|');
    assert.deepEqual(find(findings, 'T13').map(f => f.profile), [1]); assert.equal(find(findings, 'T13')[0].severity, 'note');
    // profile 1 is usable at 0-21, 28-41, 48-61, 68-81 and 88-100 s (1 s guard at each switch): its 1 s windows in runs of 21, 13, 13, 13 and 12
    const wst = m.byProfile[1].worst; assert.deepEqual(wst.map(x => [x.t0, x.t1, x.windows]), [[0, 21, 21], [28, 41, 13], [48, 61, 13]]);
    assert.ok(wst.every(x => Math.abs(x.value + 20) < 12), `median hover I of each run, permille: ${wst.map(x => x.value)}`);
});

// the share's denominator is the same tail limit for every log of a file: log A piles up at the clamp -1517 (a yaw stick move
// at 50 s), log B never reaches it (down to -847 at 60 s); hover I -250 in both
test('T13: the yaw authority comes from the log, else the file, else the CLI, else 1250 assumed', () => {
    const A = hoverW(-0.25, 5), B = hoverW(-0.25, 6);
    for (let i = at(50); i < at(50.2); i++) { A.sp[2][i] = 100; A.u[2][i] = -1.517; }
    for (let i = at(60); i < at(60.2); i++) { B.sp[2][i] = 100; B.u[2][i] = q(-0.31 - 0.537 * Math.sin(Math.PI * (i / RATE - 60) / 0.2)); }
    const cli = '# diff all\nmixer input SY -1833 1046 570\n', mA = M.analyse(A, ctxOf(A)), mB = M.analyse(B, ctxOf(B)), mBc = M.analyse(B, ctxOf(B, { cli })), mAc = M.analyse(A, ctxOf(A, { cli }));
    const t13 = (...ms) => M.judge(ms.map((metrics, log) => ({ log, start: 'sim', metrics })), M.DEFAULT_RULES).filter(f => f.id === 'T13');
    assert.equal(mA.T13.limit.lo, -1517); assert.equal(mB.T13.limit.lo, null); assert.equal(mB.T13.observed.lo, -847);
    const [fa, fb] = t13(mA, mB);
    assert.equal(fa.authoritySource, 'log'); assert.equal(fb.authoritySource, 'file'); assert.equal(fb.authorityPermille, 1517);
    within(fb.value, -250 / 1517, 0.004, 'B: I over the clamp seen in log A'); assert.match(fb.text, /% of the tail output limit of 1517 ‰ \(the output limit in 1 other log of this file\)\./);
    const [alone] = t13(mB); assert.equal(alone.authoritySource, 'assumed'); within(alone.value, -0.2, 0.004, 'B alone: 1250 assumed');
    assert.match(alone.text, /% of the tail output limit of 1250 ‰ \(the default limit of the mixer input, because no log shows an output limit, and the log does not record the SY limits\)\./);
    const [withCli] = t13(mBc); assert.equal(withCli.authoritySource, 'cli'); within(withCli.value, -250 / 1833, 0.004, 'B with the CLI limit SY -1833');
    const both = t13(mAc, mBc); assert.deepEqual(both.map(f => f.authoritySource), ['log', 'file'], 'a clamp seen in the logs comes before the CLI');
    assert.match(both[1].text, /The CLI dump gives the limits -1833 and 1046 for the SY mixer input, but the logs show an output limit at -1517\. Thus, the CLI dump is not from the time of these flights\.$/);
});

// ---------------------------------------------------------------------------------------------
// C14: pitch against collective, through a simulated pitch loop
// ---------------------------------------------------------------------------------------------

// pitch axis, PID mode 3 (P 50, I 100, D 40, gyro LPF 50 Hz, D cutoff 15 Hz) around a second-order airframe with 12 ms delay;
// the collective puts c x collective / 1000 on the pitch axis, plus a trim and gusts. The I term holds it: I + O moves
// -1000 c per 1000 collective at low frequency.
function pitchW(c, seconds, seed, boost) { // boost [t0, t1, k]: the collective activity k times larger in t0-t1 s, noise without start transients
    const nz = boost ? steadyNoise : noise, w = makeW(seconds), n = w.n, rand = rng(seed), S = lib.SCALE, slow = nz(n, rand, 0.03, 0.3), fast = nz(n, rand, 0.3, 2), gust = nz(n, rand, 0.1, 5);
    const Kp = S.P[1] * 50, Ki = S.I[1] * 100, Kd = S.D[1] * 40, gl = lp(50), dl = df(15), hist = new Float64Array(13), SUB = 8, dt = 1 / (RATE * SUB), wn = 2 * Math.PI * 15;
    let y = 0, v = 0, err = -(c * 0.4 - 0.05) / Ki; // integrator at its trim
    for (let i = 0; i < n; i++) {
        const kb = boost && i >= at(boost[0]) && i < at(boost[1]) ? boost[2] : 1, coll = Math.round(400 + kb * (250 * slow[i] + 100 * fast[i])), gyro = Math.round(y + 0.5 * gauss(rand)), gf = gl.run(gyro), e = -gf;
        err += e / RATE; const P = Kp * e, I = Ki * err, D = Kd * dl.run(-gf);
        w.coll[i] = coll; w.gyro[1][i] = gyro; w.P[1][i] = q(P); w.I[1][i] = q(I); w.D[1][i] = q(D); w.u[1][i] = q(P + I + D);
        hist.copyWithin(1, 0); hist[0] = P + I + D + c * coll / 1000 - 0.05 + 0.01 * gust[i];
        const uin = hist[hist.length - 1]; for (let k = 0; k < SUB; k++) { v += (wn * wn * (400 * uin - y) - 2 * 0.6 * wn * v) * dt; y += v * dt; }
    }
    w.extra['mixer[3]'] = w.coll;
    return w;
}

test('C14 recovers the pitch-collective coupling within 2 SE and the gain that supplies it', () => {
    const { metrics, findings } = run(pitchW(-0.1, 900, 21)), s = metrics.C14.byProfile[1];
    assert.ok(Math.abs(s.slope - 100) <= 2 * s.slopeSe, `slope ${s.slope} +- ${s.slopeSe} per 1000 collective, truth 100`);
    assert.ok(s.slopeSe < 30, `SE ${s.slopeSe}`);
    within(s.gainChange, s.slope / 2, 0.06, 'pitch_collective_ff_gain change = slope / 2 (pid.c:937-942)');
    assert.ok(s.fast.slope < 85, `above 0.2 Hz the loop has not absorbed the moment: ${s.fast.slope}`);
    const f = find(findings, 'C14', { profile: 1 })[0]; assert.equal(f.severity, 'flag', f.text);
    assert.deepEqual([f.from, f.to], [0, Math.round(s.slope / 2)]); assert.match(f.text, new RegExp(`Increase pitch_collective_ff_gain from 0 to ${f.to}\\.`));
    // no coupling: no flag; the wrong sign for the parameter (it cannot go below 0): no flag
    for (const c of [0, 0.1]) { const g = find(run(pitchW(c, 900, 22)).findings, 'C14', { profile: 1 })[0]; assert.equal(g.severity, 'note', g.text); }
    // thin data
    const th = find(run(pitchW(-0.1, 120, 23)).findings, 'C14', { profile: 1 })[0]; assert.ok(th.thin === true && th.n < 8, JSON.stringify(th));
    assert.match(th.text, /^The data is not sufficient for a result\. The number of periods of 30 s is \d\. A minimum of 8 is necessary\.\n/);
});

// unit-rms band-limited noise generated with pad samples either side and cropped: no filter start transient in it
const steadyNoise = (n, rand, lo, hi, pad = at(60)) => { const x = lib.bandpass(Float64Array.from({ length: n + 2 * pad }, () => gauss(rand)), lo, hi, RATE).subarray(pad, pad + n);
    let s = 0; for (const v of x) s += v * v; const k = 1 / Math.sqrt(s / n); return Float64Array.from(x, v => v * k); };
// pitchW with 20 s on the ground at each end (collective -200, frame held, I decaying with tau 2.5 s, not airborne, 1 s
// collective ramps at take-off and landing), the in-flight pitch trim I + O set to `trim` permille by a constant moment,
// and 80 rms of slow collective activity in flight (the Gaui's 43-163). o.switchS: profile 2 on every other segment of that
// length, with the hover collective o.collStep higher, the coupling o.c2 and a trim step o.trimStep permille that is not
// coupling (a headspeed effect)
function groundPitchW(c, trim, seed, o = {}) {
    const g = at(20), w = makeW(340), n = w.n, rand = rng(seed), S = lib.SCALE, slow = steadyNoise(n, rand, 0.03, 0.3), fast = steadyNoise(n, rand, 0.3, 2), gust = steadyNoise(n, rand, 0.1, 5);
    const Kp = S.P[1] * 50, Ki = S.I[1] * 100, Kd = S.D[1] * 40, gl = lp(50), dl = df(15), hist = new Float64Array(13), SUB = 8, dt = 1 / (RATE * SUB), wn = 2 * Math.PI * 15;
    const m0 = -trim / 1000 - 0.4 * c, decay = Math.exp(-1 / (2.5 * RATE)); let y = 0, v = 0, err = 0;
    for (let i = 0; i < n; i++) {
        const p2 = !!o.switchS && Math.floor(i / at(o.switchS)) % 2 === 1, cc = p2 && o.c2 !== undefined ? o.c2 : c; w.profileAt[i] = p2 ? 2 : 1;
        const air = i >= g && i < n - g, k = air ? Math.min(1, (i - g) / RATE, (n - g - i) / RATE) : 0, coll = Math.round(-200 + (600 + (p2 ? o.collStep || 0 : 0) + 80 * slow[i] + 100 * fast[i]) * k);
        const gyro = Math.round(y + 0.5 * gauss(rand)), gf = gl.run(gyro), e = -gf; if (air) err += e / RATE; else err *= decay;
        const P = Kp * e, I = Ki * err, D = Kd * dl.run(-gf);
        w.coll[i] = coll; w.gyro[1][i] = gyro; w.P[1][i] = q(P); w.I[1][i] = q(I); w.D[1][i] = q(D); w.u[1][i] = q(P + I + D); w.airborneAt[i] = air ? 1 : 0;
        hist.copyWithin(1, 0); hist[0] = P + I + D + cc * coll / 1000 + m0 - (p2 ? (o.trimStep || 0) / 1000 + (cc - c) * 0.4 : 0) + 0.01 * gust[i];
        const uin = hist[hist.length - 1];
        if (air) for (let s = 0; s < SUB; s++) { v += (wn * wn * (400 * uin - y) - 2 * 0.6 * wn * v) * dt; y += v * dt; } else { y = 0; v = 0; }
    }
    w.extra['mixer[3]'] = w.coll;
    return sway(w, 20, 320, seed + 100);
}

test('C14 with take-off and landing in the log: the ground steps do not leak into the in-flight regression', () => {
    // the engine path: the normal mask ANDed into ctx.flying (ground contact excluded), as js/tuning_worker.js does
    const engine = (w) => { const ctx = ctxOf(w), nm = M.normalMask(w, ctx); return run(w, Object.assign({}, ctx, { flying: Uint8Array.from(ctx.flying, (v, i) => v & nm.mask[i]), normal: nm.mask, flyingAll: ctx.flying })); };
    for (const [trim, seed] of [[-160, 31], [0, 32], [240, 33]]) {
        const s = engine(groundPitchW(-0.1, trim, seed)).metrics.C14.byProfile[1];
        // a filter over the whole log read 63 +- 27, 89 +- 6 and 128 +- 21 here: the leak moves the slope and inflates its SE
        assert.ok(Math.abs(s.slope - 100) <= 2 * s.slopeSe + 5 && s.slopeSe < 10, `trim ${trim}: slope ${s.slope} +- ${s.slopeSe} per 1000 collective, truth 100`);
    }
    // no coupling: the whole-log filter read -32 +- 25 and +39 +- 27
    for (const [trim, seed] of [[-200, 34], [200, 35]]) { const f = find(engine(groundPitchW(0, trim, seed)).findings, 'C14', { profile: 1 })[0]; assert.equal(f.severity, 'note', `no coupling, trim ${trim}: ${f.text}`); within(f.value, 0, 10, `no coupling, trim ${trim}`); }
    // profile switches every 30 s with the hover collective 100 higher and a 50 permille trim step on profile 2, no coupling:
    // each profile's runs are filtered on their own, joined at their levels (a filter over the whole log read +24 to +84)
    const sw = engine(groundPitchW(0, 240, 36, { switchS: 30, collStep: 100, trimStep: 50 })).metrics.C14.byProfile;
    for (const p of [1, 2]) within(sw[p].slope, 0, 2 * sw[p].slopeSe + 5, `trim step at the switches, profile ${p}`);
    // couplings 300 and 100 on 15 s profile segments: neither profile's coupling crosses into the other's (all runs joined
    // into one filter read +36 on the 100)
    const two = engine(groundPitchW(-0.3, 0, 37, { switchS: 15, collStep: 100, c2: -0.1 })).metrics.C14.byProfile;
    for (const [p, truth] of [[1, 300], [2, 100]]) assert.ok(Math.abs(two[p].slope - truth) <= 2 * two[p].slopeSe + 0.1 * truth, `profile ${p}: slope ${two[p].slope} +- ${two[p].slopeSe}, truth ${truth}`);
});

// the evidence of C14: the 30 s blocks with the most collective power (their weight in the regression), each with its own slope
test('C14 keeps the blocks that carry its regression, with times: 3 times the collective activity in one block puts it first', () => {
    const C = run(pitchW(-0.1, 600, 24, [300, 330, 3])).metrics.C14.byProfile[1], wb = C.worst;
    assert.deepEqual([wb.length, wb[0].t0, wb[0].t1, wb[0].seconds], [3, 300, 330, 30], JSON.stringify(wb));
    assert.ok(wb[0].share > 0.2 && wb.every((x, k) => k === 0 || x.share <= wb[k - 1].share), JSON.stringify(wb)); // 9 / (9 + 19) of the power with equal blocks
    assert.ok(Math.abs(wb[0].value - 100) <= Math.max(25, 2 * C.slopeSe * Math.sqrt(C.blocks / 9)), `slope of that block ${wb[0].value}, truth 100`);
});

// ---------------------------------------------------------------------------------------------
// T14: yaw at headspeed ramps
// ---------------------------------------------------------------------------------------------

// the firmware inertia precomp signal of pid.c:897-901, difFilter(PT2_20Hz(x), cut) sample by sample, started at the first value
function inertiaFilter(cut) {
    const k = 1 / (RATE / (2 * Math.PI * 20 * 1.553773974) + 1), W = Math.tan(Math.PI * cut / RATE), a = (W - 1) / (W + 1), b = 2 * RATE * W / (W + 1);
    let y1 = null, y2 = null, x1 = null, d = 0;
    return (x) => { if (y1 === null) y1 = y2 = x1 = x; y1 += k * (x - y1); y2 += k * (y1 - y2); d = b * (y2 - x1) - a * d; x1 = y2; return d; };
}

// Profile switches every 15 s between 2300 and 2500 rpm (governor target slewed at o.slew rpm per sample, default 890 rpm/s,
// rotor following it with 0.1 s lag). Yaw loop (P 15, I 120, as health_loop.test.cjs) around a second-order tail; or with
// o.plant 'int' an integrator yaw plant as identified on the Gaui X4 (2526 deg/s^2 per control unit, 20 ms delay) under
// P 120, I 140, D 14. The main rotor torque 0.3 is held by I (CW rotor: anti-torque negative). The rotor's reaction torque
// kd x d(rpm)/dt pushes the nose with the torque (sign +1) or, for signs given per ramp, either way; o.A adds a 1-8 Hz torque
// disturbance (control units rms, a tail that wags). The firmware inertia precomp (pid.c:893-904) at header gain o.g0 is in
// axisF, from the logged headspeed (yaw setpoint 0); the gain that cancels kd x d(rpm)/dt is 200 x 3000 x kd. The logged
// headspeed is relative to the frame (minus rot x yaw / 6). o.ramps: that many switches (15 x (ramps + 1) - 5 s), else 200 s.
function rampW(kd, signs, o = {}) {
    const seconds = o.ramps ? 15 * (o.ramps + 1) - 5 : 200, w = makeW(seconds, { yaw_inertia_precomp: [o.g0 || 0, 25] }), n = w.n, rand = rng(o.seed || 31), S = lib.SCALE;
    const integ = o.plant === 'int', Kp = S.P[2] * (integ ? 120 : 15), Ki = S.I[2] * (integ ? 140 : 120), Kd = integ ? S.D[2] * 14 : 0, gl = lp(integ ? 100 : 200), dl = df(20);
    const hist = new Float64Array(integ ? 21 : 5), SUB = integ ? 4 : 8, dt = 1 / (RATE * SUB), wn = 2 * Math.PI * 25, slew = o.slew || 0.89, prec = inertiaFilter(2.5), dn = o.A ? noise(n, rng(7 * (o.seed || 31) + 3), 1, 8) : null;
    const target = new Float64Array(n), rot = -1; let tg = 2300, om = 2300, y = 0, v = 0, err = integ ? -0.3 / Ki : -0.25 / Ki, ramp = -1;
    for (let i = 0; i < n; i++) {
        const t = i / RATE, p = Math.floor(t / 15) % 2 === 1 ? 2 : 1, want = p === 2 ? 2500 : 2300;
        if (i > 0 && p !== w.profileAt[i - 1]) ramp++;
        w.profileAt[i] = p; tg += Math.max(-slew, Math.min(slew, want - tg)); target[i] = Math.round(tg);
        const dom = (tg - om) / 0.1; om += dom / RATE;
        const s = ramp >= 0 && signs ? signs[ramp % signs.length] : 1, dist = 0.3 + s * kd * dom + (dn ? o.A * dn[i] : 0); // torque on the tail, control units
        const gyro = Math.round((integ ? gl.run(y) : y) + 0.5 * gauss(rand)), gf = integ ? gyro : gl.run(gyro), e = -gf; err += e / RATE;
        const hsLogged = om - rot * gyro / 6, P = Kp * e, I = Ki * err, D = Kd ? Kd * dl.run(-gyro) : 0, F = (integ ? 0 : -0.05) + rot * prec(hsLogged / 3000) * (o.g0 || 0) / 200, u = P + I + D + F;
        w.gyro[2][i] = gyro; w.P[2][i] = q(P); w.I[2][i] = q(I); w.D[2][i] = q(D); w.F[2][i] = q(F); w.u[2][i] = q(u); w.hs[i] = Math.round(hsLogged);
        hist.copyWithin(1, 0); hist[0] = integ ? u : u + dist;
        const uin = hist[hist.length - 1];
        if (integ) for (let k = 0; k < SUB; k++) y += 2526 * (uin + dist) * dt; // the frame torque acts at once, the tail through the delay
        else for (let k = 0; k < SUB; k++) { v += (wn * wn * (600 * uin - y) - 2 * 0.5 * wn * v) * dt; y += v * dt; }
    }
    w.extra.govTarget = target;
    return w;
}

test('T14 flags ramps that push the nose with the reaction torque and reads the inertia precomp gain', () => {
    const kd = 3e-4, truth = 600000 * kd, { metrics, findings } = run(rampW(kd)), m = metrics.T14;
    assert.equal(m.n, 13, `profile switches with a target change: ${m.n} of ${m.rampsInFlight} ramps`);
    assert.equal(m.mainRotor, 'CW'); assert.equal(m.consistency, 1); assert.equal(m.againstAcceleration, m.n); assert.equal(m.antiTorque, m.n); assert.equal(m.fitConsistency, 1);
    assert.ok(m.toward.mean > 25, `peak yaw toward the torque ${m.toward.mean}`);
    within(m.gainChange.value, truth, 0.05 * truth, 'gain whose firmware term (pid.c:893-904) cancels kd x d(rpm)/dt');
    const f = find(findings, 'T14')[0]; assert.equal(f.severity, 'flag', f.text); assert.match(f.text, new RegExp(`\\nIncrease yaw_inertia_precomp_gain from 0 to ${f.to}\\. `));
    assert.equal(f.to, Math.round(m.gainChange.value)); assert.equal(f.value, m.gainChange.value); assert.equal(f.unit, 'gain units');
    assert.equal(f.events.length, m.n);
    // a yaw stick input at one switch: that ramp is left out
    const y = rampW(kd); for (let i = at(45); i < at(45.3); i++) y.sp[2][i] = 120;
    const my = run(y).metrics.T14; assert.equal(my.n, 12); assert.equal(my.stickRamps, 1);
    // the tail at its output limit during one ramp (the clamp piles up in usable flight at 50 s): left out, the yaw there
    // shows the missing authority
    const l = rampW(kd); for (const [a, b] of [[45.1, 45.2], [50, 50.1]]) for (let i = at(a); i < at(b); i++) l.u[2][i] = -1.25;
    const ml = run(l).metrics.T14; assert.equal(ml.n, 12); assert.equal(ml.limitRamps, 1);
});

test('T14: kicks of either sign at the ramps do not flag', () => {
    const { metrics, findings } = run(rampW(3e-4, [1, -1, -1, 1, -1, 1, 1, -1, 1, -1, -1, 1]));
    assert.ok(metrics.T14.consistency <= 0.6, `consistency ${metrics.T14.consistency}`);
    assert.ok(metrics.T14.fitConsistency <= 0.6, `per-event fits of one sign ${metrics.T14.fitConsistency}`);
    const f = find(findings, 'T14')[0]; assert.equal(f.severity, 'note', f.text);
});

// the firmware precomp in axisF at header gain g0, truth 600000 kd: the regression gives the change and its direction; the
// peak yaw does not (the precomp lags the torque, so a kick stays at the matching gain and changes sign below it)
test('T14 judges the regression gain change: no flag at the matching gain, raise below it, lower above it', () => {
    for (const [kd, g0, want, o] of [[3e-4, 90, 'raise'], [3e-4, 180, null], [2e-4, 180, 'lower'], [3e-4, 0, 'raise', { slew: 0.4 }]]) {
        const truth = 600000 * kd, { metrics, findings } = run(rampW(kd, null, Object.assign({ g0, ramps: 8 }, o))), m = metrics.T14, f = find(findings, 'T14')[0], what = `header ${g0}, truth ${truth}${o ? ', 400 rpm/s' : ''}`;
        within(m.gainChange.value, truth - g0, 0.1 * truth, `gain change, ${what}`);
        if (!want) { assert.equal(f.severity, 'note', `${what}: ${f.text}`); assert.ok(m.toward.mean < -20, `${what}: the peak (${m.toward.mean} deg/s) has the other sign at the matching gain`); continue; }
        assert.equal(f.severity, 'flag', `${what}: ${f.text}`); assert.equal(Math.sign(f.to - g0), want === 'raise' ? 1 : -1, what);
        assert.match(f.text, new RegExp(`${want === 'raise' ? 'Increase' : 'Decrease'} yaw_inertia_precomp_gain from ${g0} to ${f.to}\\.`)); within(f.to, truth, 0.1 * truth, `target, ${what}`);
        if (o) assert.ok(m.toward.mean < 0, `slow ramps: the peak (${m.toward.mean} deg/s) points the wrong way, the regression does not`);
    }
});

test('T14 on an integrator yaw plant (the Gaui identification): the matching gain does not flag; a need beyond 250 is said', () => {
    const at0 = run(rampW(3e-4, null, { plant: 'int', ramps: 8 })), f0 = find(at0.findings, 'T14')[0];
    assert.equal(f0.severity, 'flag', f0.text); within(f0.to, 180, 0.2 * 180, 'raise from 0, truth 180 (the regression reads up to 14 % high here)');
    const f1 = find(run(rampW(3e-4, null, { plant: 'int', ramps: 8, g0: 180 })).findings, 'T14')[0]; assert.equal(f1.severity, 'note', f1.text);
    const big = find(run(rampW(5.4e-4, null, { plant: 'int', ramps: 8 })).findings, 'T14')[0]; // truth 324
    assert.equal(big.severity, 'flag', big.text); assert.equal(big.to, 250);
    assert.match(big.text, /Increase yaw_inertia_precomp_gain from 0 to 250\. The necessary value \(\d+ ± \d+\) is more than the firmware maximum of 250\. Thus, also make the headspeed changes slower \(gov_tracking_time\)\./);
    const top = find(run(rampW(5.4e-4, null, { plant: 'int', ramps: 8, g0: 250 })).findings, 'T14')[0];
    assert.equal(top.severity, 'note', top.text); assert.match(top.text, /The parameter range \(0 to 250\) cannot supply this change, and the header value is 250\. Make the headspeed changes slower \(gov_tracking_time\)\./);
});

// no inertia torque, a tail that wags (1-8 Hz torque noise, the peak yaw about 26 deg/s as on the Fireball), 3 ramps a log
test('T14 on a wagging tail without inertia torque: at most 2 of 100 logs flag; the peak rule would flag about 1 in 10', () => {
    let flags = 0, peak = 0; const abs = [];
    for (let s = 1; s <= 100; s++) {
        const w = rampW(0, null, { ramps: 3, A: 0.04, seed: 1000 + s }); w.coll = null; w.D = [null, null, null];
        const { metrics, findings } = run(w), m = metrics.T14;
        if (find(findings, 'T14')[0].severity === 'flag') flags++;
        if (m.n >= 3 && m.consistency >= 0.8 && Math.abs(m.toward.mean) - 2 * m.toward.se > 20) peak++; // the rule judged before, on the peak
        for (const e of m.events) abs.push(Math.abs(e.toward));
    }
    abs.sort((a, b) => a - b);
    assert.ok(abs[abs.length >> 1] > 20, `a noisy tail: median |peak| ${abs[abs.length >> 1]} deg/s`);
    assert.ok(flags <= 2, `${flags} of 100 logs without inertia torque flagged`);
    assert.ok(peak >= 5, `the peak rule on the same logs: ${peak} of 100`);
});

// the governor recovering from a collective punch (29.9-30.4 s) at a constant target: the headspeed droops to 2400 and
// overshoots to 2600 by 30.8 s; a profile switch to 2700 rpm follows at 31.1 s, 0.4 s after that ramp ends, inside the
// window where the target level after a ramp is read
test('T14: a recovery ramp before a later target change is not an inertia event', () => {
    const w = makeW(60), n = w.n, tg = new Float64Array(n), rand = rng(41);
    for (let i = 0; i < n; i++) { const t = i / RATE;
        w.hs[i] = t < 30 ? 2500 : t < 30.2 ? 2500 - 500 * (t - 30) : t < 30.8 ? 2400 + 200 / 0.6 * (t - 30.2) : t < 31.15 ? 2600 - 50 / 0.35 * (t - 30.8) : t < 31.6 ? 2550 + 150 / 0.45 * (t - 31.15) : 2700;
        tg[i] = t < 31.1 ? 2500 : Math.min(2700, 2500 + 890 * (t - 31.1)); w.profileAt[i] = t < 31.1 ? 1 : 2;
        w.coll[i] = t >= 29.9 && t < 30.4 ? 1000 : 400; w.u[2][i] = q(-0.3 + 0.005 * gauss(rand)); }
    Object.assign(w.extra, { govTarget: tg, 'mixer[3]': w.coll });
    const m = run(w).metrics.T14;
    assert.ok(!m.events.some(e => e.t < 31), `recovery ramp admitted: ${JSON.stringify(m.events.map(e => [e.t, e.cause]))}`);
    assert.equal(m.unexplainedRamps, 1, 'the recovery ramp: the target had not moved by its end');
    assert.ok(m.events.some(e => e.t > 31 && e.cause === 'profile switch'), `the switch ramp stays: ${JSON.stringify(m.events.map(e => [e.t, e.cause]))}`);
});

// ---------------------------------------------------------------------------------------------
// G14: governor states
// ---------------------------------------------------------------------------------------------

// OFF, IDLE, SPOOLUP 5-15 s (throttle 15 -> 55 % at 4 %/s), ACTIVE, then the given in-flight events, AUTOROTATION at landing
function govW(events = []) {
    const w = makeW(120), n = w.n, g = w.govStateAt, mot = new Float64Array(n);
    const set = (a, b, s) => g.fill(s, at(a), at(b));
    set(0, 3, 0); set(3, 5, 1); set(5, 15, 2); set(15, 104, 4); set(104, 106, 7); set(106, 120, 0);
    for (const [a, b, s] of events) set(a, b, s);
    for (let i = 0; i < n; i++) { const t = i / RATE; mot[i] = t < 5 ? 0 : t < 15 ? 150 + 40 * (t - 5) : t < 104 ? 550 : 0; w.hs[i] = t < 5 ? 0 : t < 15 ? 230 * (t - 5) : t < 104 ? 2500 : 2500 - 300 * (t - 104);
        w.coll[i] = t < 18 ? -200 : t < 103 ? 400 : 100; }
    w.airborneAt.fill(0); w.airborneAt.fill(1, at(17), at(105));
    Object.assign(w.extra, { 'motor[0]': mot, 'mixer[3]': w.coll });
    return sway(w, 17, 105, 7);
}

test('G14: state census, spool-up ramp, landing autorotation not flagged', () => {
    const { metrics, findings } = run(govW()), m = metrics.G14;
    within(m.states.ACTIVE.seconds, 89, 0.002, 'ACTIVE seconds'); within(m.states.SPOOLUP.seconds, 10, 0.002, 'SPOOLUP seconds');
    assert.equal(m.states.AUTOROTATION.entries, 1); assert.equal(m.states.OFF.entries, 1);
    within(m.spoolup.throttlePctPerS.mean, 4, 0.01, 'spool-up throttle ramp, %/s'); assert.equal(m.spoolup.impliedSpoolupTime, 250);
    within(m.spoolup.rpmPerS.mean, 230, 0.5, 'spool-up headspeed ramp');
    assert.equal(m.entries.length, 1); assert.equal(m.entries[0].landing, true);
    const f = find(findings, 'G14')[0]; assert.equal(f.severity, 'note', f.text);
});

test('G14 flags a bailout in flight and an autorotation at hover collective; not one with the collective down', () => {
    const b = find(run(govW([[50, 50.8, 7], [50.8, 51.5, 8]])).findings, 'G14')[0];
    assert.equal(b.severity, 'flag', b.text); assert.equal(b.value, 2, 'AUTOROTATION at collective 400 for 0.8 s, then BAILOUT');
    assert.deepEqual(b.events.map(e => e.t).sort((x, y) => x - y), [50, 50.8]);
    const w = govW([[60, 62, 7]]); for (let i = at(59); i < at(62); i++) w.coll[i] = -100; // practice autorotation, collective lowered first
    const a = find(run(w).findings, 'G14')[0]; assert.equal(a.severity, 'note', a.text);
});

// ---------------------------------------------------------------------------------------------
// curves, missing fields, inputs unchanged, cost
// ---------------------------------------------------------------------------------------------

test('curves are JSON-safe and compact; vibration falls back to gyroADC without gyroRAW', () => {
    const w = filterW([100, 50]); w.extra.govTarget = new Float64Array(w.n).fill(2500); w.extra.govSum = new Float64Array(w.n).fill(500); w.extra['motor[0]'] = new Float64Array(w.n).fill(550);
    const ctx = ctxOf(w), m = M.analyse(w, ctx), c = M.curves(w, ctx, m);
    const text = JSON.stringify(c, (k, v) => ArrayBuffer.isView(v) ? Array.from(v, x => Number.isFinite(x) ? x : null) : v);
    assert.ok(text.length < 400e3, `curves of a 100 s log: ${text.length} bytes`); JSON.parse(text);
    assert.equal(c.gov.t.length, 1000); assert.equal(c.gov.state.length, 1000); within(c.gov.errPct[500], 0, 1e-6, 'headspeed on target');
    assert.equal(c.vib.roll.f.length, 513); assert.equal(c.vib.filtOnly, false);
    const k12 = Math.round(12 * 1024 / RATE); within(c.vib.roll.pass[k12], lib.cx.abs(lib.lpf1Response(k12 * RATE / 1024, 100, RATE)), 0.02, 'roll transmission at 12 Hz');
    // phase of gyroRAW -> gyroADC (the F11 plot): the first-order low-passes, and the 7-sample delay of yaw unwrapped past -180 deg
    for (const [ax, fc] of [['roll', 100], ['pitch', 50]]) within(c.vib[ax].phaseDeg[k12], lib.cx.arg(lib.lpf1Response(k12 * RATE / 1024, fc, RATE)) * 180 / Math.PI, 1, `${ax} phase at 12 Hz`);
    for (const k of [12, 100, 200]) within(c.vib.yaw.phaseDeg[k], -360 * (k * RATE / 1024) * 0.007, 3, `yaw phase at bin ${k}`);
    assert.ok(Number.isNaN(c.vib.roll.phaseDeg[0]) && c.vib.byProfile[1].yaw.phaseDeg.length === 513 && Math.abs(c.vib.byProfile[1].yaw.phaseDeg[100] - c.vib.yaw.phaseDeg[100]) < 1e-3, 'per profile too');
    assert.ok(c.vib.lpf.length === 0 && c.vib.notches.roll.length === 0, 'no filters in this header');
    assert.ok(c.tail.u.min.length === 1000 && c.tail.limits, 'tail series');
    for (const ax of ['roll', 'pitch', 'yaw']) { assert.ok(c.control[ax].psd.length === 513); }
    w.extra['gyroRAW[0]'] = null; const d = M.curves(w, ctx, m);
    assert.equal(d.vib.filtOnly, true); assert.equal(d.vib.roll.raw, null); assert.equal(d.vib.roll.pass, null); assert.equal(d.vib.roll.phaseDeg, null); assert.ok(d.vib.yaw.filt.length === 513);
});

// a 4x rotor line of 10 deg/s on roll, 70 s on profile 1 at 2402.3 rpm and 30 s on profile 2 at 2695.3 rpm (the line on the
// 1024-point bins 164 and 184), with a 4x main rotor notch in the header
test('curves vib.byProfile: one spectrum per profile reads the line amplitude; the pooled one reads it x sqrt(share)', () => {
    const w = makeW(100, { gyro_rpm_notch_source_roll: [14], gyro_rpm_notch_q_roll: [80] }), n = w.n, rand = rng(51), hs = [2402.34375, 2695.3125];
    let ph = 0; const raw = [0, 1, 2].map(() => new Float64Array(n));
    for (let i = 0; i < n; i++) { const p = i < at(70) ? 1 : 2; w.profileAt[i] = p; w.hs[i] = hs[p - 1]; ph += 2 * Math.PI * 4 * hs[p - 1] / 60 / RATE;
        for (let a = 0; a < 3; a++) raw[a][i] = (a === 0 ? 10 * Math.sin(ph) : 0) + 0.2 * gauss(rand); }
    for (let a = 0; a < 3; a++) { w.extra[`gyroRAW[${a}]`] = raw[a]; w.gyro[a] = Float64Array.from(raw[a]); }
    const ctx = ctxOf(w), c = M.curves(w, ctx, M.analyse(w, ctx)), v = c.vib, b1 = v.byProfile[1], b2 = v.byProfile[2];
    within(b1.roll.raw[164], 10, 0.2, 'profile 1 line'); within(b2.roll.raw[184], 10, 0.2, 'profile 2 line');
    within(v.roll.raw[164], 10 * Math.sqrt(b1.windows / v.windows), 0.2, 'pooled: x sqrt(share of profile 1)'); within(b1.share, 0.7, 0.02, 'profile 1 share of the windows');
    within(b1.notches.roll[0].hz, 4 * hs[0] / 60, 0.1, 'profile 1 notch'); within(b2.notches.roll[0].hz, 4 * hs[1] / 60, 0.1, 'profile 2 notch'); within(b2.rotorHz, hs[1] / 60, 0.01, 'profile 2 rotor');
    assert.equal(b1.windows + b2.windows + 2, v.windows, 'the two windows (hop 512) across the switch belong to neither'); assert.equal(b1.roll.raw.length, 513);
});

test('missing fields: nothing throws, skipped checks say why', () => {
    const w = makeW(60); w.govStateAt = null; w.coll = null; w.D = [null, null, null];
    const ctx = ctxOf(w), { metrics, findings } = run(w, ctx);
    assert.match(metrics.G14.skipped, /GOVSTATE/); assert.match(metrics.C14.skipped, /collective/); assert.match(metrics.F11.skipped, /gyroRAW/);
    assert.ok(metrics.D6.notes.some(s => /flightModeFlags/.test(s)));
    for (const id of ['G14', 'C14', 'F11']) assert.equal(find(findings, id)[0].severity, 'skipped');
    assert.doesNotThrow(() => JSON.stringify(M.curves(w, ctx, metrics), (k, v) => ArrayBuffer.isView(v) ? Array.from(v) : v));
    const none = makeW(30); none.airborneAt.fill(0);
    assert.equal(run(none).metrics.skipped, 'The log has no samples in flight.');
    assert.equal(find(run(none).findings, 'T14')[0].severity, 'skipped');
});

test('analyse and curves leave w and ctx unchanged and stay within the time budget', () => {
    const w = filterW([100, 50]), ctx = ctxOf(w), sum = (x) => { let s = 0; for (let i = 0; i < x.length; i += 7) s += x[i] * (i % 13 + 1); return s; };
    const before = [sum(w.gyro[0]), sum(w.extra['gyroRAW[0]']), sum(w.u[2]), sum(ctx.flying), sum(ctx.profile), Object.keys(ctx).join(), Object.keys(w).join()];
    const t0 = Date.now(), m = M.analyse(w, ctx); M.curves(w, ctx, m); const ms = Date.now() - t0;
    assert.deepEqual([sum(w.gyro[0]), sum(w.extra['gyroRAW[0]']), sum(w.u[2]), sum(ctx.flying), sum(ctx.profile), Object.keys(ctx).join(), Object.keys(w).join()], before);
    assert.ok(ms < 1000, `analyse + curves of 100 s at 1 kHz: ${ms} ms`);
});
