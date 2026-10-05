// Ground-truth check for tools/autotune/health_loop.cjs: simulate the firmware control law (PID mode 3) on all three
// axes around known airframes, fly a fixed manoeuvre schedule, inject known defects, log it the way the flight
// controller does (rounded integers), and require the checks to find what was injected and nothing on a clean tune.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../tools/autotune/lib.cjs');
const H = require('../tools/autotune/health_loop.cjs');

const RATE = 1000, SECONDS = 120;
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function gauss(rand) { return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand()); }

// the clean helicopter; a scenario overrides parts of it
const BASE = () => ({
    axes: [
        { plant: { kind: 'second', K: 400, fn: 15, zeta: 0.6, tau: 0.012 }, g: { P: 50, I: 100, D: 15, F: 100, B: 25 }, bw: [80, 35, 35], limit: 1.25, decay: 0.046, errorLimit: 45, trim: 0 },
        { plant: { kind: 'second', K: 400, fn: 15, zeta: 0.6, tau: 0.012 }, g: { P: 50, I: 100, D: 5, F: 100, B: 0 }, bw: [80, 35, 35], limit: 1.25, decay: 0.046, errorLimit: 45, trim: 0 },
        { plant: { kind: 'second', K: 600, fn: 25, zeta: 0.5, tau: 0.004 }, g: { P: 15, I: 120, D: 10, F: 67, B: 0 }, bw: [200, 40, 40], limit: 1.25, decay: 0, errorLimit: 60, trim: 0 },
    ],
    stop: [100, 100],          // yaw stop gains [cw, ccw]
    torque: 0.3,               // main rotor torque on the tail at full collective, control units; pushes positive yaw (CW rotor)
    precompSign: 1,            // 1: yaw precomp cancels the torque exactly; -1: wrong sign
    cross: 0,                  // roll control per deg/s^2 of pitch setpoint rate
    hsi: 0,                    // pitch control added with the sign of collective above 5 deg
    vibration: [0, 0, 0],      // deg/s of an 80 Hz line in each gyro
    landedS: null,             // [from, to] s: firmware says landed while flying (an axis groundDecay, if set, applies only there, as pid.c does)
});

// firmware filters, sample by sample (filter.c)
const lp = (fc) => { const W = Math.tan(Math.PI * fc / RATE); return { a1: (W - 1) / (W + 1), b0: W / (W + 1), x1: 0, y1: 0, run(x) { const y = this.b0 * x + this.b0 * this.x1 - this.a1 * this.y1; this.x1 = x; this.y1 = y; return y; } }; };
const df = (fc) => { const W = Math.tan(Math.PI * fc / RATE); return { a: (W - 1) / (W + 1), b: 2 * RATE * W / (W + 1), x1: 0, y1: 0, run(x) { const y = this.b * (x - this.x1) - this.a * this.y1; this.x1 = x; this.y1 = y; return y; } }; };

// manoeuvre schedule, 12 s cycles: roll flip, pitch flip, piro +, piro -, collective step (sign alternates), quiet in between
function schedule(t, c) {
    const tc = t % 12, s = c % 2 ? -1 : 1;
    const flip = (t0, dur, R) => { const a = tc - t0; if (a < 0 || a > dur + 0.05) return 0; if (a < 0.05) return R * a / 0.05; if (a < dur) return R; return R * (1 - (a - dur) / 0.05); };
    const step = (t0, t1, lo, hi) => { if (tc < t0 || tc > t1 + 0.1) return lo; if (tc < t0 + 0.1) return lo + (hi - lo) * (tc - t0) / 0.1; if (tc < t1) return hi; return hi + (lo - hi) * (tc - t1) / 0.1; };
    return [flip(0.3, 1.0, 360 * s), flip(2.8, 1.0, 360 * s), flip(5.2, 1.0, 400) + flip(7.2, 1.0, -400), step(9.2, 10.4, 200, s > 0 ? 1000 : -800)];
}

function simulate(seed, cfg) {
    const rand = rng(seed), n = SECONDS * RATE, S = lib.SCALE, col = () => new Float64Array(n);
    const w = { flight: { log: 0, id: 'sim' + seed, actualRate: RATE, header: {} }, n, rate: RATE, fromS: 0,
        sp: [col(), col(), col()], gyro: [col(), col(), col()], u: [col(), col(), col()], P: [col(), col(), col()], I: [col(), col(), col()], D: [col(), col(), col()], F: [col(), col(), col()], B: [col(), col(), col()],
        hs: new Float64Array(n).fill(4500), coll: col(), profileAt: new Uint8Array(n), airborneAt: new Uint8Array(n).fill(1), extra: {} };
    const st = cfg.axes.map((A, a) => ({ A, Kp: S.P[a] * A.g.P, Ki: S.I[a] * A.g.I, Kd: S.D[a] * A.g.D, Kf: S.F[a] * A.g.F, Kb: S.B[a] * A.g.B,
        gl: lp(A.bw[0]), dl: df(A.bw[1]), bl: df(A.bw[2]), spLp: 0, relaxK: 1 / (RATE / (2 * Math.PI * 18) + 1), err: 0, sat: false, y: 0, v: 0, gust: 0,
        hist: new Float64Array(Math.round(A.plant.tau * RATE) + 1) }));
    const torqueLp = lp(5), precompLp = lp(5), wander = [0, 0, 0, 0], q = (x) => Math.round(x * 1000) / 1000, SUB = 8, dt = 1 / (RATE * SUB);
    let prevSp1 = 0;
    for (let i = 0; i < n; i++) {
        const t = i / RATE, base = schedule(t, Math.floor(t / 12)), landed = cfg.landedS && t >= cfg.landedS[0] && t < cfg.landedS[1];
        for (let k = 0; k < 4; k++) wander[k] += (gauss(rand) * [6, 6, 5, 30][k] * 7 - wander[k]) * 0.02;
        const sp = [0, 1, 2].map(a => Math.round(base[a] + wander[a])), coll = Math.round(base[3] + wander[3]);
        const cAbs = Math.abs(coll) / 1000, torque = cfg.torque * torqueLp.run(cAbs), precomp = -cfg.precompSign * cfg.torque * precompLp.run(cAbs);
        const dsp1 = (sp[1] - prevSp1) * RATE; prevSp1 = sp[1];
        for (let a = 0; a < 3; a++) {
            const s = st[a], A = s.A;
            const vib = cfg.vibration[a] ? cfg.vibration[a] * Math.sin(2 * Math.PI * 80 * t) : 0;
            const gyro = Math.round(s.y + vib + gauss(rand) * 0.5);
            const gf = s.gl.run(gyro), err = sp[a] - gf;
            let stop = 1;
            if (a === 2) { const x = Math.max(-1, Math.min(1, err / 10)); stop = (cfg.stop[1] + (x + 1) / 2 * (cfg.stop[0] - cfg.stop[1])) / 100; }
            const P = s.Kp * err * stop, D = s.Kd * s.dl.run(-gf), B = s.Kb * s.bl.run(sp[a]);
            const F = s.Kf * sp[a] + (a === 2 ? precomp : 0);
            s.spLp += s.relaxK * (sp[a] - s.spLp);
            const ie = err * Math.max(0, 1 - Math.abs(sp[a] - s.spLp) / 35);
            if (!(s.sat && Math.sign(ie) === Math.sign(s.err) && ie !== 0)) s.err += ie / RATE;          // frozen while saturated and growing
            s.err = Math.max(-A.errorLimit, Math.min(A.errorLimit, s.err));
            s.err -= (landed && A.groundDecay !== undefined ? A.groundDecay : A.decay) * s.err / RATE;
            const I = s.Ki * s.err, sum = P + I + D + F + B, u = Math.max(-A.limit, Math.min(A.limit, sum));
            s.sat = Math.abs(sum) > A.limit;
            w.sp[a][i] = sp[a]; w.gyro[a][i] = gyro; w.u[a][i] = q(u); w.P[a][i] = q(P); w.I[a][i] = q(I); w.D[a][i] = q(D); w.F[a][i] = q(F); w.B[a][i] = q(B);

            // airframe: control plus disturbances (gusts, trim, torque, cross-coupling, HSI)
            s.gust += (-s.gust * 2 * Math.PI * 2 + gauss(rand) * 1.5) / RATE;
            let d = s.gust + A.trim;
            if (a === 2) d += torque;
            if (a === 0) d += cfg.cross * dsp1;
            if (a === 1 && Math.abs(coll) * 0.012 >= 5) d += cfg.hsi * Math.sign(coll);
            s.hist.copyWithin(1, 0); s.hist[0] = u + d;
            const uin = s.hist[s.hist.length - 1], p = A.plant;
            for (let k = 0; k < SUB; k++) {
                if (p.kind === 'second') { const wn = 2 * Math.PI * p.fn; s.v += (wn * wn * (p.K * uin - s.y) - 2 * p.zeta * wn * s.v) * dt; s.y += s.v * dt; }
                else s.y += (-p.a * s.y + p.a * p.K * uin) * dt;
            }
        }
        w.coll[i] = coll;
    }
    w.extra = Object.fromEntries(H.EXTRA.map(k => [k, null]));
    w.extra['mixer[3]'] = w.coll;
    const flying = new Uint8Array(n).fill(1);
    if (cfg.landedS) for (let i = cfg.landedS[0] * RATE; i < cfg.landedS[1] * RATE; i++) { w.airborneAt[i] = 0; flying[i] = 0; }
    const hdr = (a) => [cfg.axes[a].g.P, cfg.axes[a].g.I, cfg.axes[a].g.D, cfg.axes[a].g.F, cfg.axes[a].g.B];
    const header = { rollPID: hdr(0), pitchPID: hdr(1), yawPID: hdr(2), rollBW: cfg.axes[0].bw, pitchBW: cfg.axes[1].bw, yawBW: cfg.axes[2].bw,
        error_limit: cfg.axes.map(A => A.errorLimit), error_decay: [250, 12], error_decay_ground: 25, yaw_stop_gain: cfg.stop, collectiveRange: [-1250, 1250], cyclic_coupling: [50, 0, 25] };
    w.flight.header = header;
    return { w, ctx: { flying, profile: new Uint8Array(n), govState: new Uint8Array(n).fill(4), rate: RATE, header } };
}

function run(seed, change) {
    const cfg = BASE(); change(cfg);
    const { w, ctx } = simulate(seed, cfg), metrics = H.analyse(w, ctx);
    JSON.stringify(metrics); // must serialise
    return { metrics, findings: H.judge([{ log: 0, start: 'sim', header: ctx.header, metrics }], H.DEFAULT_RULES) };
}
const within = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);
const find = (F, id, axis) => F.filter(f => f.id === id && (axis === undefined || f.axis === axis));
const flagged = (F, id, axis) => find(F, id, axis).filter(f => f.severity === 'flag');
const show = (F) => F.filter(f => f.severity === 'flag').map(f => `${f.id} ${f.axis || ''}: ${f.text}`).join('\n');

const clean = run(1, () => {});
const A = run(2, (c) => { c.axes[0].g.F = 40;                                                                     // roll FF too low
    c.axes[1].plant = { kind: 'lag', a: 1.5, K: 400, tau: 0.012 }; Object.assign(c.axes[1].g, { P: 5, I: 500, D: 0 }); // pitch I oscillation
    c.stop = [250, 40]; c.axes[2].g.F = 0;                                                                            // CW stop gain too high, stops made by P
    c.precompSign = -1; });                                                                                           // precomp of the wrong sign
const B = run(3, (c) => { c.axes[0].g.F = 130; c.axes[0].decay = 0.4;                                               // roll FF too high, roll I decays fast while airborne
    c.axes[1].limit = 0.6;                                                                                            // pitch saturates in flips
    c.axes[2].g.F = 0;                                                                                                // no yaw FF: I carries piros
    c.landedS = [60, 66]; });                                                                                         // AIRBORNE_STATE events: landed 6 s in flight
const D = run(5, (c) => { c.axes[0].decay = 0.4; });                                                               // ground-rate decay, no AIRBORNE_STATE events
const E = run(6, (c) => { c.axes[0].groundDecay = 0.4; c.landedS = [60, 66]; });                                  // ground decay only where the firmware says landed
const C = run(4, (c) => { c.axes[0].trim = -0.35; c.axes[0].errorLimit = 15;                                       // roll trim beyond the I limit
    c.vibration[1] = 15; c.cross = 2e-5; c.hsi = 0.05; });                                                            // pitch D noise, cross-coupling, HSI

// the pitch I loop of scenario A: s^2 + (a + b Kp) s + b Ki = 0, b = a K
const SLOW_HZ = (() => { const b = 1.5 * 400, Kp = lib.SCALE.P[1] * 5, Ki = lib.SCALE.I[1] * 500, c = 1.5 + b * Kp; return Math.sqrt(b * Ki - c * c / 4) / (2 * Math.PI); })();

test('a clean tune raises no flag', () => {
    assert.equal(clean.findings.filter(f => f.severity === 'flag').length, 0, show(clean.findings));
    const m = clean.metrics;
    assert.equal(m.rotation.mainRotor, 'CW', 'torque pushes positive yaw: CW main rotor');
    assert.equal(m.rotation.precompAgrees, true);
    assert.ok(m.C3.roll.byProfile[0].iShare.n >= 5 && m.T9.byProfile[0].iShare.n >= 5, 'steady manoeuvres found');
    assert.ok(m.C4.roll.byProfile[0].overshootPct.n >= 5 && m.T5.byProfile[0].cw.overshootPct.n >= 3 && m.T5.byProfile[0].ccw.overshootPct.n >= 3, 'stops found');
    assert.ok(m.T6.byProfile[0].absPeak.n >= 10, 'collective steps found');
    for (const id of ['C1', 'C3', 'C4', 'C6', 'C10', 'C11', 'T2', 'T5', 'T6', 'T7', 'T9']) assert.ok(find(clean.findings, id).some(f => f.severity === 'ok'), `${id} passes with evidence`);
    assert.ok(m.C2.limits.pitch.limitHigh === null && m.T8.limits.yaw.limitLow === null, 'no output limit');
    assert.ok(m.C8.byProfile[0].coherence < 0.3, `no cross-coupling, coherence ${m.C8.byProfile[0].coherence}`);
});

test('FF too low: I carries the rolls and is charged with the rotation at stops', () => {
    const f = flagged(A.findings, 'C3', 'roll');
    assert.equal(f.length, 1, show(A.findings));
    // I supplies 60 % of the rate the plant needs; F is 40 % of it, so I/F ~ 1.5
    assert.ok(f[0].value > 1 && f[0].value < 2, `I share ${f[0].value}`);
    assert.match(f[0].text, /FF too low/);
    assert.ok(A.metrics.C4.roll.byProfile[0].iWithRotationShare >= 0.8, 'I with the rotation at the stop');
});

test('FF too high: I works against F and the stop bounces back', () => {
    const f = flagged(B.findings, 'C3', 'roll');
    assert.equal(f.length, 1, show(B.findings));
    assert.ok(f[0].value < -0.2, `I share ${f[0].value}`);
    assert.match(f[0].text, /FF too high/);
    const s = flagged(B.findings, 'C4', 'roll');
    assert.equal(s.length, 1, 'stop flagged');
    assert.match(s[0].text, /FF too high/);
});

test('piros carried by I without yaw FF', () => {
    const f = flagged(B.findings, 'T9');
    assert.equal(f.length, 1, show(B.findings));
    assert.ok(f[0].value > 0.3, `I share of the piro control ${f[0].value}`);
});

test('stop overshoot asymmetric: the side with the high stop gain is named', () => {
    const f = flagged(A.findings, 'T5');
    assert.equal(f.length, 1, show(A.findings));
    assert.equal(f[0].larger, 'cw');
    assert.match(f[0].text, /lower yaw_cw_stop_gain/);
    assert.ok(f[0].value > 3, `overshoot ratio ${f[0].value}`);
    // the CW side is the one stopping negative yaw rate, where the firmware sees errorRate > +10
    for (const e of A.metrics.T5.events) assert.equal(e.side === 'cw', e.dir < 0);
    // measured over the deceleration, where the stop gain acts (pid.c:1277)
    assert.ok(A.metrics.T5.events.every(e => e.errorPositiveShare === (e.side === 'cw' ? 1 : 0)), JSON.stringify(A.metrics.T5.events.map(e => [e.side, e.errorPositiveShare])));
    assert.ok(clean.metrics.T5.events.every(e => e.side === 'cw' ? e.errorPositiveShare > 0.5 : e.errorPositiveShare < 0.5), 'clean tune: the side label and the error sign agree');
    const g = A.metrics.rotation.stopGain;
    assert.ok(Math.abs(g.measuredCW - 250) < 25 && Math.abs(g.measuredCCW - 40) < 8, `stop gains regressed ${g.measuredCW}/${g.measuredCCW}`);
    assert.equal(g.cwSideIsPositiveError, true);
    within(g.byProfile[0].ratio, 250 / 40, 0.6, 'P ratio of the two sides');
});

test('collective kick with a wrong-sign precomp', () => {
    const k = flagged(A.findings, 'T6');
    assert.equal(k.length, 1, show(A.findings));
    assert.ok(k[0].towardTorque.mean > 30, `kick toward the torque change ${k[0].towardTorque.mean}`);
    assert.match(k[0].text, /raise yaw collective FF/);
    const p = flagged(A.findings, 'T7');
    assert.equal(p.length, 1, 'precomp vs I flagged');
    assert.ok(p[0].value < -0.5 && p[0].precompScale < 0, `r ${p[0].value}, scale ${p[0].precompScale}`);
    assert.match(p[0].text, /wrong sign/);
    assert.equal(A.metrics.rotation.mainRotor, 'CW', 'rotation read from the tail control, not the precomp');
    assert.equal(A.metrics.rotation.precompAgrees, false);
});

test('integrator pinned at its limit', () => {
    const f = flagged(C.findings, 'C1', 'roll');
    assert.equal(f.length, 1, show(C.findings));
    assert.ok(f[0].value > 10, `longest pinned run ${f[0].value} s`);
    assert.equal(C.metrics.C1.roll.byProfile[0].limit, 0.3);
    assert.equal(flagged(C.findings, 'C1', 'pitch').length, 0);
});

test('mixer saturation is found at the right limit and kept out of the gain checks', () => {
    const f = flagged(B.findings, 'C2');
    assert.equal(f.length, 1, show(B.findings));
    const L = B.metrics.C2.limits.pitch;
    assert.ok(L.limitHigh === 0.6 && L.limitLow === -0.6, JSON.stringify(L));
    assert.ok(f[0].n >= 8, `episodes ${f[0].n}`);
    assert.equal(B.metrics.C3.pitch.byProfile[0] === undefined || B.metrics.C3.pitch.byProfile[0].iShare.n === 0, true, 'saturated flips are not used for FF');
});

test('slow I oscillation is found at its frequency', () => {
    const f = flagged(A.findings, 'C6', 'pitch');
    assert.equal(f.length, 1, show(A.findings));
    assert.ok(Math.abs(f[0].hz - SLOW_HZ) <= 0.25, `found ${f[0].hz} Hz, truth ${SLOW_HZ.toFixed(3)} Hz`);
    assert.ok(A.metrics.C6.pitch.byProfile[0].iShareOfControl > 0.7, `I drives it: ${A.metrics.C6.pitch.byProfile[0].iShareOfControl}`);
    assert.match(f[0].text, /driven by I/);
    assert.equal(flagged(A.findings, 'C6', 'roll').length, 0);
});

test('ground-rate decay without AIRBORNE_STATE events: possible airborne misdetection', () => {
    assert.equal(D.metrics.C10.airborneStateLogged, false);
    const f = flagged(D.findings, 'C10', 'roll');
    assert.ok(f.length >= 1, show(D.findings));
    assert.ok(Math.abs(f[0].value - 2.5) < 0.5, `tau ${f[0].value} s, truth 2.5 s`);
    assert.match(f[0].text, /airborne misdetection/);
    const tc = clean.metrics.C10.roll.byProfile[0].bins.find(b => b.spans > 200);
    assert.ok(tc.tauS > 8, `clean tau ${tc.tauS} s, truth ${(1 / 0.046).toFixed(1)} s`);
});

test('with AIRBORNE_STATE events, fast decay in flight is not blamed on airborne detection', () => {
    // B: the firmware logged airborne everywhere C10 looks, so pid.c applied the airborne curve; a 2.5 s tau is something else
    assert.equal(B.metrics.C10.airborneStateLogged, true);
    assert.equal(flagged(B.findings, 'C10', 'roll').length, 0, show(B.findings));
    const n = find(B.findings, 'C10', 'roll').filter(q => q.severity === 'note' && /faster than the airborne curve/.test(q.text));
    assert.ok(n.length >= 1 && Math.abs(n[0].value - 2.5) < 0.5, JSON.stringify(n.map(q => q.value)));
    assert.doesNotMatch(n[0].text, /possible airborne misdetection/);
    // E: ground decay where the firmware said landed (as pid.c does) is seen by the landed-while-moving check alone
    for (const R of [B, E]) { const lw = R.findings.find(q => q.id === 'C10' && q.axis === undefined);
        assert.equal(lw.severity, 'flag'); assert.ok(Math.abs(lw.value - 6) <= 1, `landed while moving ${lw.value} s`); }
    assert.ok(!find(E.findings, 'C10', 'roll').some(q => /faster than the airborne|misdetection/.test(q.text)), show(E.findings));
    const te = E.metrics.C10.roll.byProfile[0].bins.find(b => b.spans > 200);
    assert.ok(te.tauS > 8, `airborne tau ${te.tauS} s with ground decay only while landed`);
});

test('D driven by vibration, cross-coupling and HSI are measured', () => {
    assert.equal(flagged(C.findings, 'C11', 'pitch').length, 1, show(C.findings));
    assert.ok(clean.metrics.C11.pitch.byProfile[0].share < 0.5);
    const x = C.metrics.C8.byProfile[0];
    assert.ok(x.coherence > 0.5 && x.gainSigned > 0, `cross-coupling coherence ${x.coherence}, gain ${x.gainSigned}`);
    const h = C.metrics.C9.byProfile[0];
    // pitch pushed positive at positive collective: the error (setpoint - gyro) goes negative there
    assert.ok(h.difference < 0 && Math.abs(h.difference) > 2 * h.differenceSe, `HSI difference ${h.difference} +- ${h.differenceSe}`);
});

test('wag frequency per gain set feeds T4 across logs', () => {
    const flights = [clean, A].map((s, i) => ({ log: i, start: 'sim', metrics: s.metrics }));
    const F = H.judge(flights, H.DEFAULT_RULES).filter(f => f.id === 'T4');
    assert.ok(F.length >= 1);
    for (const f of F) assert.ok(['ok', 'note'].includes(f.severity));
});

test('T4 compares header and recovered yaw P in one unit: the same tune is no gain change', () => {
    // same tune (P 60, stop gains 150/110) as the start profile of log A (header) and another profile of log B (recovered)
    const set = (gains) => ({ T4: { byProfile: { 1: { gains, fast: { hz: { mean: 8, se: 0.05 }, bursts: 20 } } } } });
    const a = set({ header: { P: 60, I: 120, D: 10, stopGain: [150, 110] }, recovered: {} }), b = set({ header: null, recovered: { Pcw: 90, Pccw: 66, I: 120, D: 10 } });
    const F = H.judge([{ log: 'A', metrics: a }, { log: 'B', metrics: b }], H.DEFAULT_RULES).filter(f => f.id === 'T4');
    assert.deepEqual(F.map(f => f.severity), ['note']); assert.match(F[0].text, /no finding/);
    // a real change of base P by 50 % is still seen
    const c = set({ header: null, recovered: { Pcw: 135, Pccw: 99, I: 120, D: 10 } });
    const G = H.judge([{ log: 'A', metrics: a }, { log: 'C', metrics: c }], H.DEFAULT_RULES).filter(f => f.id === 'T4');
    assert.equal(G.length, 1); assert.match(G[0].text, /suspect mechanics/);
});

test('thin evidence and missing fields are said, not judged', () => {
    const R = Object.assign({}, H.DEFAULT_RULES, { C3: Object.assign({}, H.DEFAULT_RULES.C3, { minEvents: 1000 }) });
    const F = H.judge([{ log: 0, metrics: A.metrics }], R).filter(f => f.id === 'C3');
    assert.ok(F.every(f => f.severity === 'note' && /no finding/.test(f.text)));
    const cfg = BASE(), { w, ctx } = simulate(9, cfg);
    w.coll = null; w.extra['mixer[3]'] = null; ctx.govState = null;
    const m = H.analyse(w, ctx);
    assert.ok(m.T6.skipped && m.C9.skipped && m.C10.skipped);
    assert.ok(m.notes.some(s => /GOVSTATE/.test(s)));
    assert.ok(H.judge([{ log: 0, metrics: m }]).some(f => f.id === 'T6' && f.severity === 'skipped'));
});
