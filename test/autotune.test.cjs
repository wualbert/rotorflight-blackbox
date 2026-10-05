// Ground-truth check for tools/autotune/lib.cjs: simulate the firmware control law around a known plant,
// log it the way the flight controller does (rounded integers), and require the analysis to recover
// the gains, the plant and the closed loop.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../tools/autotune/lib.cjs');

const RATE = 1000, AXIS = 0;
const TRUE_PLANT = { kind: 'second', K: 400, fn: 15, zeta: 0.25, tau: 0.012 };
const TRUE_GAINS = { P: 50, I: 100, D: 15, F: 100, B: 25, gyroCutoff: 80, dCutoff: 35, bCutoff: 35, decayPerS: 0.5, relaxLevel: 35, relaxCutoff: 18 };

function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function gauss(rand) { return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand()); }

// step: amplitude of a clean setpoint step at t = 0 (no noise, no rounding) instead of stick input
function simulate(seed, seconds, step, g = TRUE_GAINS, plantGain = 1) {
    const rand = rng(seed), n = seconds * RATE, S = lib.SCALE, p = Object.assign({}, TRUE_PLANT, { K: TRUE_PLANT.K * plantGain });
    const Kp = S.P[AXIS] * g.P, Ki = S.I[AXIS] * g.I, Kd = S.D[AXIS] * g.D, Kf = S.F[AXIS] * g.F, Kb = S.B[AXIS] * g.B;
    const lp = (fc) => { const W = Math.tan(Math.PI * fc / RATE); return { a1: (W - 1) / (W + 1), b0: W / (W + 1), x1: 0, y1: 0 }; };
    const df = (fc) => { const W = Math.tan(Math.PI * fc / RATE); return { a: (W - 1) / (W + 1), b: 2 * RATE * W / (W + 1), x1: 0, y1: 0 }; };
    const runLp = (f, x) => { const y = f.b0 * x + f.b0 * f.x1 - f.a1 * f.y1; f.x1 = x; f.y1 = y; return y; };
    const runDf = (f, x) => { const y = f.b * (x - f.x1) - f.a * f.y1; f.x1 = x; f.y1 = y; return y; };
    const gyroLp = lp(g.gyroCutoff), dFilt = df(g.dCutoff), bFilt = df(g.bCutoff);

    const col = () => new Float64Array(n);
    const seg = { rate: RATE, n, sp: [col()], gyro: [col()], u: [col()], P: [col()], I: [col()], D: [col()], F: [col()], B: [col()] };
    const delay = Math.round(p.tau * RATE), uHist = new Float64Array(delay + 1), wn = 2 * Math.PI * p.fn, SUB = 8, dt = 1 / (RATE * SUB);
    const relaxK = 1 / (RATE / (2 * Math.PI * g.relaxCutoff) + 1);
    let y = 0, v = 0, iTerm = 0, target = 0, s1 = 0, s2 = 0, dist = 0, spLp = 0;
    for (let i = 0; i < n; i++) {
        // stick: a new target every 0.2-0.8 s, smoothed like a thumb would
        if (rand() < 1 / (0.5 * RATE)) target = (rand() - 0.5) * 500;
        s1 += (target - s1) * (2 * Math.PI * 4 / RATE); s2 += (s1 - s2) * (2 * Math.PI * 6 / RATE);
        const sp = step ? step : Math.round(s2 + gauss(rand) * 0.4);
        dist += (-dist * 2 * Math.PI * 3 + gauss(rand) * 900) / RATE;      // slow gusts and coupling
        const gyro = step ? y : Math.round(y + dist + gauss(rand) * 1.5);

        const gf = runLp(gyroLp, gyro), err = sp - gf;
        const P = Kp * err, D = Kd * runDf(dFilt, -gf), F = Kf * sp, B = Kb * runDf(bFilt, sp);
        spLp += relaxK * (sp - spLp);
        const relax = step ? 1 : Math.max(0, 1 - Math.abs(sp - spLp) / g.relaxLevel);   // the step check is about the linear loop
        iTerm += (Ki * relax * err - g.decayPerS * iTerm) / RATE;
        const u = Math.max(-1, Math.min(1, P + iTerm + D + F + B));

        const q = (x) => Math.round(x * 1000) / 1000;
        seg.sp[0][i] = sp; seg.gyro[0][i] = gyro; seg.u[0][i] = q(u);
        seg.P[0][i] = q(P); seg.I[0][i] = q(iTerm); seg.D[0][i] = q(D); seg.F[0][i] = q(F); seg.B[0][i] = q(B);

        uHist.copyWithin(1, 0); uHist[0] = u;
        const applied = uHist[delay];
        for (let k = 0; k < SUB; k++) { v += (wn * wn * (p.K * applied - y) - 2 * p.zeta * wn * v) * dt; y += v * dt; }
    }
    return seg;
}

const app = lib.loadApp();
const flights = [11, 22, 33, 44, 55, 66].map((seed, i) => ({ id: 'sim' + i, seg: simulate(seed, 120) }));
const pool = (list) => lib.pool(list.map(f => ({ flight: f.id, spectra: lib.segmentSpectra(app, f.seg, AXIS, lib.recoverGains(f.seg, AXIS).integratorInput) })));
const withRelax = (gains, pooled) => Object.assign({}, gains, { relax: lib.relaxResponse(pooled.rows) });
const within = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);

test('gains are recovered from the logged PID terms', () => {
    const g = lib.recoverGains(flights[0].seg, AXIS);
    within(g.F.gain, TRUE_GAINS.F, 0.5, 'F');
    within(g.P.gain, TRUE_GAINS.P, 1, 'P');
    within(g.P.gyroCutoff, TRUE_GAINS.gyroCutoff, 5, 'gyro cutoff');
    within(g.D.gain, TRUE_GAINS.D, 1, 'D');
    within(g.D.cutoff, TRUE_GAINS.dCutoff, 3, 'D cutoff');
    within(g.B.gain, TRUE_GAINS.B, 3, 'B');
    within(g.I.gain, TRUE_GAINS.I, 5, 'I');
    within(g.I.relaxLevel, TRUE_GAINS.relaxLevel, 5, 'I-term relax level');
    within(g.I.relaxCutoff, TRUE_GAINS.relaxCutoff, 4, 'I-term relax cutoff');
    assert.ok(g.I.r2 > 0.95, `I explained, R2 ${g.I.r2}`);
    assert.ok(g.P.r2 > 0.98 && g.D.r2 > 0.95 && g.F.r2 > 0.99);
});

test('plant and closed loop are recovered with honest uncertainty', () => {
    const pooled = pool(flights), model = withRelax(TRUE_GAINS, pooled);
    assert.equal(pooled.flights, flights.length);

    const fit = lib.fitPlant(pooled, 1, 25), best = fit.models[0];
    assert.equal(best.kind, 'second', 'the resonant model must win over the lag model');
    within(best.K, TRUE_PLANT.K, 20, 'plant gain');
    within(best.fn, TRUE_PLANT.fn, 0.6, 'natural frequency');
    within(best.zeta, TRUE_PLANT.zeta, 0.05, 'damping');
    within(best.tau * 1000, TRUE_PLANT.tau * 1000, 2, 'delay ms');
    assert.ok(best.chi2red < 3, `model should fit to within measurement error, chi2red ${best.chi2red}`);
    assert.ok(best.se.K > 0 && best.se.fn > 0, 'parameter standard errors are reported');

    // the true value must lie inside the reported uncertainty for most well-measured bins
    const truth = (f) => lib.plantResponse(TRUE_PLANT, f);
    let inside = 0, total = 0, errT = 0, nT = 0;
    for (const r of pooled.rows) {
        if (r.f < 1 || r.f > 25 || !r.Gse || r.Gse.sigma > 0.35) continue;
        const rel = lib.cx.abs(lib.cx.sub(r.G, truth(r.f))) / lib.cx.abs(truth(r.f));
        if (rel <= 2.5 * Math.max(0.03, r.Gse.sigma)) inside++;
        total++;
        const Tm = lib.loop(AXIS, model, truth, r.f).T;
        errT += (lib.cx.abs(lib.cx.sub(r.T, Tm)) / lib.cx.abs(Tm)) ** 2; nT++;
    }
    assert.ok(total >= 20, 'enough well-measured bins');
    assert.ok(inside / total > 0.85, `truth inside the error bars for ${inside}/${total} bins`);
    assert.ok(Math.sqrt(errT / nT) < 0.08, `closed loop matches the model, rms error ${Math.sqrt(errT / nT)}`);
});

test('step response of the modelled loop matches a direct simulation', () => {
    const plant = (f) => lib.plantResponse(TRUE_PLANT, f);
    const model = lib.stepMetrics(lib.stepResponse((f) => lib.loop(AXIS, TRUE_GAINS, plant, f).T));
    const sim = lib.stepMetrics(simulate(1, 0.5, 100).gyro[0].map(v => v / 100));
    within(model.final, sim.final, 0.03, 'final value');
    within(model.peak, sim.peak, 0.06, 'peak');
    within(model.peakMs, sim.peakMs, 3, 'peak time ms');
    within(model.t50Ms, sim.t50Ms, 3, 'time to 50% ms');
    assert.ok(sim.overshootPct > 20, 'the test plant must actually overshoot');
    const mg = lib.margins(AXIS, TRUE_GAINS, plant);
    assert.ok(mg.peakSensitivity > 1 && mg.gainMargin > 1, JSON.stringify(mg));
});

test('a gain change predicted from the measured plant matches flights flown with that change', () => {
    // fly tune A, measure the plant, predict tune B, then actually fly tune B and compare
    const B = Object.assign({}, TRUE_GAINS, { P: 40, D: 30, F: 90 });
    const flownA = pool(flights), flownB = pool([101, 202, 303, 404, 505, 606].map((seed, i) => ({ id: 'b' + i, seg: simulate(seed, 120, 0, B) })));
    const vb = lib.validBand(flownA.rows, 1, 30, 0.2), table = lib.plantTable(flownA.rows, vb), Bm = withRelax(B, flownA);
    assert.ok(vb.band[1] >= 18, `validated band reaches ${vb.band[1]} Hz`);

    // judged against the measurement uncertainty, and weighted by where the stick input actually is
    let inside = 0, n = 0, num = 0, den = 0;
    for (const r of flownB.rows) {
        if (r.f < vb.band[0] || r.f > vb.band[1]) continue;
        const predicted = lib.loop(AXIS, Bm, (f) => table.get(f), r.f).T, gA = flownA.rows.find(x => x.f === r.f);
        const rel = lib.cx.abs(lib.cx.sub(predicted, r.T)) / lib.cx.abs(r.T);
        if (rel <= 2.5 * Math.hypot(0.03, r.Tse.sigma, gA.Gse.sigma)) inside++;
        n++; num += r.rr * lib.cx.abs(lib.cx.sub(predicted, r.T)) ** 2; den += r.rr * lib.cx.abs(r.T) ** 2;
    }
    assert.ok(inside / n >= 0.9, `prediction inside the error bars for ${inside}/${n} bins`);
    assert.ok(Math.sqrt(num / den) < 0.03, `input-weighted relative error ${Math.sqrt(num / den)}`);
});

// These limits are the prediction floors that tools/autotune/report.cjs adds to every predicted change
// (RULES.trackingFloor, RULES.disturbanceFloor). If this test needs looser limits, loosen the rules too.
test('predicted tracking and disturbance stay within the floors used by the report', () => {
    const TRACKING_FLOOR = 0.025, DISTURBANCE_FLOOR = 0.03;
    const flownA = pool(flights), vb = lib.validBand(flownA.rows, 1, 30, 0.2), table = lib.plantTable(flownA.rows, vb), A = withRelax(TRUE_GAINS, flownA);
    const band = (rows, key) => lib.bandRms(rows, key, vb.band[0], vb.band[1]);
    const residual = (rows) => { let t = 0; for (const r of rows) if (r.f >= vb.band[0] && r.f <= vb.band[1]) t += lib.residualPsd(r) * 0.5; return Math.sqrt(t); };
    const flown = lib.predict(AXIS, A, A, table, flownA.rows, vb), measuredA = lib.delayFit(flownA.rows, (f, r) => r.T, vb.band[0], vb.band[1]);
    const stick = band(flownA.rows, 'rr');
    within(flown.track, measuredA.shapeRms, TRACKING_FLOOR * stick, 'tracking, flown tune');
    within(flown.disturb, residual(flownA.rows), 1e-6, 'disturbance, flown tune');

    for (const change of [{ F: 90 }, { F: 80 }, { P: 40 }, { D: 30 }, { I: 120 }, { P: 40, D: 30, F: 90 }]) {
        const B = Object.assign({}, TRUE_GAINS, change), what = JSON.stringify(change);
        const flownB = pool([101, 202, 303, 404, 505, 606].map((seed, i) => ({ id: 'b' + i, seg: simulate(seed, 120, 0, B) })));
        const predicted = lib.predict(AXIS, withRelax(B, flownA), A, table, flownA.rows, vb, flown.delayMs / 1000);
        // stick activity differs a little between the two sets of flights, so scale the measured error to the same stick RMS
        const track = lib.delayFit(flownB.rows, (f, r) => r.T, vb.band[0], vb.band[1], measuredA.delayMs / 1000).shapeRms * stick / band(flownB.rows, 'rr');
        within(predicted.track, track, TRACKING_FLOOR * stick, 'tracking after ' + what);
        assert.equal(predicted.track < flown.track, track < measuredA.shapeRms, 'direction of the tracking change after ' + what);
        // the disturbance floor is claimed only where the report relies on it: when tracking does not get worse
        if (predicted.track <= flown.track * 1.01) within(predicted.disturb, residual(flownB.rows), DISTURBANCE_FLOOR * flown.disturb, 'disturbance after ' + what);
    }
});

test('the strongest narrow line is found at the right frequency and amplitude', () => {
    const rand = rng(7), n = 60 * RATE, x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = 5 * Math.sin(2 * Math.PI * 14.9 * i / RATE) + gauss(rand) * 8;
    const line = lib.spectralLine(app, x, RATE, 8, 30);
    within(line.hz, 14.9, 0.13, 'line frequency');
    within(line.amplitude, 5, 0.5, 'line amplitude');
    assert.ok(line.prominence > 5, `prominence ${line.prominence}`);
});

test('holding the other sticks constant removes a cross-axis bias', () => {
    // pitch gyro follows the pitch stick with gain 1.0 and the collective with gain 0.5; the pilot moves both together
    const rand = rng(3), n = 120 * RATE, col = () => new Float64Array(n), seg = { rate: RATE, n, sp: [col(), col(), col()], gyro: [col(), col(), col()], coll: col() };
    const s = [0, 0, 0, 0]; // slow random stick movements: roll, pitch, yaw, and the part of collective that is its own
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < 4; j++) s[j] += (gauss(rand) * 40 - s[j]) * 0.01;
        seg.sp[0][i] = s[0]; seg.sp[1][i] = s[1]; seg.sp[2][i] = s[2]; seg.coll[i] = 0.8 * s[1] + 0.6 * s[3];
        seg.gyro[0][i] = s[0] + gauss(rand); seg.gyro[1][i] = s[1] + 0.5 * seg.coll[i] + gauss(rand); seg.gyro[2][i] = s[2] + gauss(rand);
    }
    const g = lib.crossAxisGain(lib.sumCross([lib.crossAxisSpectra(app, seg)]), 1);
    within(g.alone, 1.4, 0.08, 'gain from the pitch stick alone is biased by the collective');
    within(g.held, 1.0, 0.05, 'gain with the collective held constant');
    assert.ok(g.cohCollective > 0.3, `coherence with collective ${g.cohCollective}`);
});

test('oscillation bursts are found, and stick movement or noise is not mistaken for one', () => {
    const rand = rng(5), n = 40 * RATE, x = new Float64Array(n);
    // what a tracking error looks like without oscillation: a transient at every stick reversal, plus broadband noise
    let target = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) { if (i % 2500 === 1250) target = (rand() - 0.5) * 600; s1 += (target - s1) * 0.05; s2 += (s1 - s2) * 0.03; x[i] = (s1 - s2) * 0.15 + gauss(rand) * 3; }
    const quiet = lib.oscillationBursts(x, RATE).bursts;
    assert.equal(quiet.filter(b => b.amplitude >= 10).length, 0, 'no burst of 10 deg/s or more without an oscillation: ' + JSON.stringify(quiet.slice(0, 2)));
    // add three bursts between the stick reversals: 8 Hz at 25 deg/s for 1 s, 12 Hz at 40 deg/s for 0.6 s, 5 Hz growing for 1.5 s
    const add = (t0, dur, hz, amp, grow = 0) => { for (let i = 0; i < dur * RATE; i++) x[Math.round(t0 * RATE) + i] += amp * Math.exp(grow * i / RATE) * Math.sin(2 * Math.PI * hz * i / RATE); };
    add(5, 1.0, 8, 25); add(15, 0.6, 12, 40); add(24.4, 1.5, 5, 15, 0.7);
    const found = lib.oscillationBursts(x, RATE).bursts.filter(b => b.amplitude >= 10);
    assert.equal(found.length, 3, 'three bursts: ' + JSON.stringify(found.map(b => [b.start.toFixed(2), b.hz.toFixed(1), b.amplitude.toFixed(0)])));
    [[5, 8, 25, 1.0], [15, 12, 40, 0.6], [24.4, 5, null, 1.5]].forEach(([t0, hz, amp, dur], k) => {
        // burst edges are resolved to about two cycles
        within(found[k].start, t0, 0.2, 'start of burst ' + k); within(found[k].hz, hz, 0.4, 'frequency of burst ' + k);
        within(found[k].seconds, dur, 0.3, 'duration of burst ' + k);
        if (amp) within(found[k].amplitude, amp, 0.15 * amp, 'amplitude of burst ' + k);
    });
    assert.ok(found[2].growthPerCycle > 0.08 && found[2].growthPerCycle < 0.25, `growing burst: ${found[2].growthPerCycle} per cycle, expected about 0.15`);
    assert.ok(Math.abs(found[0].growthPerCycle) < 0.05, `steady burst: ${found[0].growthPerCycle} per cycle`);
});

test('the gain margin says when the loop starts to oscillate by itself, and at what frequency', () => {
    // the rule for the tail rests on this: an airframe that responds more strongly than the model by the gain margin is unstable
    const m = lib.margins(AXIS, TRUE_GAINS, (f) => lib.plantResponse(TRUE_PLANT, f));
    const run = (k) => { const seg = simulate(7, 30, 0, TRUE_GAINS, k), e = Float64Array.from(seg.gyro[0], (v, i) => v - seg.sp[0][i]);
        const b = lib.oscillationBursts(e, RATE).bursts.sort((p, q) => q.seconds * q.amplitude - p.seconds * p.amplitude)[0];
        return { swing: e.reduce((t, v) => Math.max(t, Math.abs(v)), 0), burst: b }; };
    const below = run(0.8 * m.gainMargin), above = run(1.2 * m.gainMargin);
    assert.ok(above.swing > 4 * below.swing, `swing ${below.swing} below the margin, ${above.swing} above`);
    assert.ok(above.burst && above.burst.seconds > 10, 'above the margin the oscillation sustains itself');
    within(above.burst.hz, m.gainMarginHz, 0.15 * m.gainMarginHz, 'frequency of the oscillation');
    assert.ok(!below.burst || below.burst.seconds < 3, 'below the margin no oscillation lasts');
});

test('steady segments leave rescue out', () => {
    const n = 100 * RATE, col = (v) => new Float64Array(n).fill(v), three = () => [col(0), col(0), col(0)];
    const rescueAt = new Uint8Array(n).fill(1, 40 * RATE, 50 * RATE); // rescue from 40 to 50 s
    const w = { flight: {}, n, rate: RATE, fromS: 0, profileAt: new Uint8Array(n).fill(1), airborneAt: new Uint8Array(n).fill(1), rescueAt,
        hs: col(2500), coll: null, extra: {}, sp: three(), gyro: three(), u: three(), P: three(), I: three(), D: three(), F: three(), B: three() };
    const segs = [...lib.steadySegments(w)].map(s => [s.i0, s.i1]);
    assert.deepEqual(segs, [[0, 40 * RATE], [50 * RATE, n]]);
});
