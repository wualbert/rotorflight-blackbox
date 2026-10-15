'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const T = require('../tools/autotune/heli_twin.cjs'), F = require('../tools/autotune/twin_fit.cjs');
const { craftPrior } = require('../tools/autotune/helicopter_model.cjs');

const model = () => T.createModel(craftPrior('SAB Fireball'), { refRpm: 4500 });
const input = (o = {}) => Object.assign({ u: [0, 0, 0], coll: 0.1, thr: 0.7, vbat: 23 }, o);
function hoverCollective(m) { // collective with vertical acceleration zero at rest, rotor at the reference speed
    let lo = -0.5, hi = 1;
    for (let k = 0; k < 60; k++) {
        const c = (lo + hi) / 2, sim = T.createSim(m, 500);
        T.initState(sim, { gyro: [0, 0, 0], att: [0, 0, 0], hs: m.refRpm, alt: 0, vario: 0 });
        for (let i = 0; i < sim.maxDelay; i++) T.push(sim, input({ coll: c }));
        for (let k2 = 17; k2 <= 20; k2++) sim.x[k2] = [0, 0, 0, c][k2 - 17];
        const d = new Float64Array(T.NX); for (let it = 0; it < 300; it++) { T.deriv(sim, sim.x, d); sim.x[16] += d[16] * 0.01; }
        T.deriv(sim, sim.x, d); if (d[5] > 0) hi = c; else lo = c;
    }
    return (lo + hi) / 2;
}

test('logged attitude convention: ZYX Euler, pitch about +y, yaw = -heading, round trip', () => {
    for (const [r, p, h] of [[100, -200, 450], [-1700, 300, 3500], [0, 850, 1800]]) {
        const q = T.attitudeQuat(r, p, h), e = T.quatToEuler(...q);
        assert.ok(Math.abs(e[0] / T.DEG - r / 10) < 1e-9 && Math.abs(e[1] / T.DEG - p / 10) < 1e-9);
        const heading = ((-e[2] / T.DEG) % 360 + 360) % 360; assert.ok(Math.abs(heading - h / 10) < 1e-9);
    }
    // a positive yaw rate (gyro z, body up) turns the nose left: the heading output decreases
    const m = model(), sim = T.createSim(m, 500);
    T.initState(sim, { gyro: [0, 0, 30], att: [0, 0, 900], hs: 4500, alt: 0, vario: 0 });
    sim.x.fill(0, 21, 27); const h0 = T.outputs(sim.x)[5];
    for (let i = 0; i < 50; i++) { T.push(sim, input()); T.step(sim); }
    assert.ok(T.outputs(sim.x)[5] < h0);
});

test('hover: a collective exists with zero vertical acceleration; more collective climbs; the quaternion stays unit', () => {
    const m = model(), c = hoverCollective(m);
    assert.ok(c > -0.3 && c < 0.8, `hover collective ${c}`);
    const sim = T.createSim(m, 500);
    T.initState(sim, { gyro: [0, 0, 0], att: [0, 0, 0], hs: 4500, alt: 0, vario: 0 });
    for (let i = 0; i < sim.maxDelay; i++) T.push(sim, input({ coll: c + 0.1 }));
    for (let i = 0; i < 500; i++) { T.push(sim, input({ coll: c + 0.1 })); T.step(sim); sim.x[15] = 4500 * T.RPM; sim.x.fill(0, 10, 15); sim.x.set([1, 0, 0, 0], 6); }
    assert.ok(sim.x[5] > 0.5, `climb speed ${sim.x[5]}`);
    assert.ok(Math.abs(Math.hypot(sim.x[6], sim.x[7], sim.x[8], sim.x[9]) - 1) < 1e-12);
});

test('cyclic, tail and collective have the signs of the log: positive command, positive rate', () => {
    const m = model();
    for (const [axis, u] of [[0, [0.1, 0, 0]], [1, [0, 0.1, 0]], [2, [0, 0, 0.1]]]) {
        const base = T.createSim(m, 500), push = T.createSim(m, 500);
        for (const s of [base, push]) T.initState(s, { gyro: [0, 0, 0], att: [0, 0, 0], hs: 4500, alt: 0, vario: 0 });
        for (let i = 0; i < 100; i++) { T.push(base, input()); T.step(base); T.push(push, input({ u })); T.step(push); }
        assert.ok(push.x[10 + axis] - base.x[10 + axis] > 0.05, `axis ${axis}`);
    }
});

test('the linear frequency response agrees with a simulated small sine of the nonlinear model', () => {
    const m = model(); m.params.dCyc = 0.008; m.constants.gyroLowpassHz = 0;
    const f = 4, rate = 1000, amp = 0.01, H = T.frequencyResponse(m, [f], { rpm: 4500, coll: 0.1, tail: 0, thr: 0.7, vbat: 23 })[0][0];
    const sim = T.createSim(m, rate);
    T.initState(sim, { gyro: [0, 0, 0], att: [0, 0, 0], hs: 4500, alt: 0, vario: 0 });
    for (let k = 17; k <= 20; k++) sim.x[k] = [0, 0, 0, 0.1][k - 17];
    let re = 0, im = 0; const n = rate * 6, start = rate * 2;
    for (let i = 0; i < n; i++) {
        const t = i / rate; T.push(sim, input({ u: [amp * Math.sin(2 * Math.PI * f * t), 0, 0] })); T.step(sim);
        // hold rotor speed, attitude, translation: the linearization holds them too
        sim.x[15] = 4500 * T.RPM; sim.x.set([1, 0, 0, 0], 6); sim.x.fill(0, 0, 6); sim.x[11] = sim.x[12] = 0;
        if (i >= start) { const tt = (i + 1) / rate; re += sim.x[10] * Math.sin(2 * Math.PI * f * tt); im += sim.x[10] * Math.cos(2 * Math.PI * f * tt); }
    }
    const k = 2 / (n - start) / amp, mag = Math.hypot(re * k, im * k), magLin = Math.hypot(...H);
    assert.ok(Math.abs(mag / magLin - 1) < 0.08, `sine ${mag} vs linear ${magLin}`);
});

test('predictions use no measurement after the origin', () => {
    const m = model(), n = 2500, rate = 500, mk = () => ({ rate, n, u: [0, 1, 2].map(a => Float64Array.from({ length: n }, (_, i) => 0.05 * Math.sin(i / 37 + a))),
        coll: new Float64Array(n).fill(0.1), thr: new Float64Array(n).fill(0.7), vbat: new Float64Array(n).fill(23),
        gyro: [0, 1, 2].map(a => Float64Array.from({ length: n }, (_, i) => 20 * Math.sin(i / 41 + a))), att: [0, 1, 2].map(() => new Float64Array(n)),
        alt: new Float64Array(n), vario: new Float64Array(n), hs: new Float64Array(n).fill(4500) });
    const a = mk(), b = mk();
    a.target = { gyro: a.gyro }; b.target = { gyro: b.gyro };
    const origin = 1500; let first = null, second = null;
    F.observerPass(m, a, F.RULES, (i, sim) => { if (i === origin) first = F.rollout(sim, a, i, [50, 250]); });
    for (const c of [...b.gyro, ...b.att, b.alt, b.vario, b.hs]) for (let i = origin + 1; i < n; i++) c[i] = c === b.hs ? 3000 : 999;
    F.observerPass(m, b, F.RULES, (i, sim) => { if (i === origin) second = F.rollout(sim, b, i, [50, 250]); });
    assert.deepEqual(Array.from(second[1]), Array.from(first[1]));
});

test('the steady-state observer gains give a stable error dynamics', () => {
    const m = model(), g = T.observerGains(m, 1 / 500);
    // rate: e+ = (I - K C) A e with A = [[1, dt], [0, 1]]
    const dt = 1 / 500, a = [[1 - g.rate[0], dt * (1 - g.rate[0])], [-g.rate[1], 1 - g.rate[1] * dt]];
    const tr = a[0][0] + a[1][1], det = a[0][0] * a[1][1] - a[0][1] * a[1][0], disc = tr * tr - 4 * det;
    const radius = disc >= 0 ? Math.max(Math.abs((tr + Math.sqrt(disc)) / 2), Math.abs((tr - Math.sqrt(disc)) / 2)) : Math.sqrt(det);
    assert.ok(radius < 1, `rate observer spectral radius ${radius}`);
    assert.ok(g.vertical.every(row => row.every(Number.isFinite)));
});

test('instrumented response recovers known coupled plants under feedback with disturbances', () => {
    // y' = K u - a y + c * u_other + d, u = Kp (sp - y); d is colored noise that the feedback correlates with u
    const rate = 500, n = rate * 600, K = [8, 6, 20], a = [3, 4, 8], c = [[0, 2, 0], [-1.5, 0, 0], [0, 0, 0]], Kp = 0.5;
    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
    const sp = [0, 1, 2].map(() => new Float64Array(n)), u = [0, 1, 2].map(() => new Float64Array(n)), y = [0, 1, 2].map(() => new Float64Array(n));
    const s0 = [0, 0, 0], d = [0, 0, 0];
    for (let i = 1; i < n; i++) {
        for (let k = 0; k < 3; k++) { s0[k] += rnd() * 40 - s0[k] * 0.02; sp[k][i] = s0[k]; d[k] += -d[k] * 0.01 + rnd() * 2; u[k][i] = Kp * (sp[k][i] - y[k][i - 1]); }
        for (let k = 0; k < 3; k++) y[k][i] = y[k][i - 1] + (K[k] * u[k][i] - a[k] * y[k][i - 1] + c[k].reduce((acc, v, j) => acc + v * u[j][i], 0) + d[k]) / rate;
    }
    const deg = y.map(col => Float64Array.from(col, v => v / Math.PI * 180));
    const frd = F.instrumentedResponse([{ rate, n, sp, u, gyro: deg }]);
    for (const b of frd.bins.filter(q => q.H && q.f < 5)) {
        const w = 2 * Math.PI * b.f;
        for (const [i, j, gain] of [[0, 0, K[0]], [1, 1, K[1]], [2, 2, K[2]], [0, 1, c[0][1]]]) {
            const expected = Math.abs(gain) / Math.hypot(w, a[i]);
            assert.ok(Math.abs(Math.hypot(...b.H[i][j]) / expected - 1) < 0.2, `${b.f} Hz H[${i}][${j}]: ${Math.hypot(...b.H[i][j])} vs ${expected}`);
        }
    }
});
