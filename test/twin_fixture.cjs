'use strict';

// Synthetic flights of the six-degree-of-freedom twin (tools/autotune/heli_twin.cjs) for the system identification and
// closed-loop tests. A controller (the native Rotorflight controller, or a small rate controller in JavaScript) flies
// the twin with band-limited pilot setpoints. A PI governor sets the throttle. The recorded columns use the log units:
// mixer/1000, mixer[3] and setpoint[3] in permille, motor[0] in permille, Vbat in 0.01 V, attitude in decidegrees,
// altitude and vario in cm and cm/s, gyro in deg/s and headspeed in RPM.
//
// The order of each log sample is the order of twin_fit.observerPass and control_pipeline.simulate: the measurement of
// sample i is the state after i steps, the controller output of sample i acts over the step from i to i + 1, and the
// delay history starts with maxDelay copies of the first input.
const T = require('../tools/autotune/heli_twin.cjs');
const { craftPrior } = require('../tools/autotune/helicopter_model.cjs');

const CRAFT = 'SAB Fireball', VBAT = 50, RPM0 = 4000;
function truthModel(params = {}, refRpm = RPM0) {
    const m = T.createModel(craftPrior(CRAFT), { refRpm });
    Object.assign(m.params, params);
    return m;
}
// Collective with zero vertical acceleration at rest and at the reference rotor speed (as in test/heli_twin.test.cjs).
const hoverCache = new Map();
function hoverCollective(m) {
    const key = JSON.stringify([m.params, m.refRpm]);
    if (hoverCache.has(key)) return hoverCache.get(key);
    let lo = -0.5, hi = 1;
    const input = c => ({ u: [0, 0, 0], coll: c, thr: 0.7, vbat: VBAT });
    for (let k = 0; k < 50; k++) {
        const c = (lo + hi) / 2, sim = T.createSim(m, 500);
        T.initState(sim, { gyro: [0, 0, 0], att: [0, 0, 0], hs: m.refRpm, alt: 0, vario: 0 });
        for (let i = 0; i < sim.maxDelay; i++) T.push(sim, input(c));
        for (let j = 17; j <= 20; j++) sim.x[j] = [0, 0, 0, c][j - 17];
        const d = new Float64Array(T.NX);
        for (let it = 0; it < 300; it++) { T.deriv(sim, sim.x, d); sim.x[16] += d[16] * 0.01; }
        T.deriv(sim, sim.x, d); if (d[5] > 0) hi = c; else lo = c;
    }
    hoverCache.set(key, (lo + hi) / 2);
    return (lo + hi) / 2;
}
function random(seed) {
    let s = (Math.imul(seed + 1, 2654435761) >>> 0) || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 - 0.5; };
}
// Band-limited noise: white noise through two first-order low-pass sections, scaled to the standard deviation.
function noise(n, rate, seed, bandHz, std) {
    const rnd = random(seed), a = 1 - Math.exp(-2 * Math.PI * bandHz / rate), out = new Float64Array(n);
    let y1 = 0, y2 = 0, sum = 0;
    for (let i = 0; i < n + rate; i++) { y1 += a * (rnd() - y1); y2 += a * (y1 - y2); if (i >= rate) { out[i - rate] = y2; sum += y2 * y2; } }
    const k = std / Math.sqrt(sum / n || 1);
    for (let i = 0; i < n; i++) out[i] *= k;
    return out;
}
// A small rate controller in JavaScript: feedforward, P and I on each axis (normalized mixer per deg/s).
function rateController(rate, gains = { f: [0.004, 0.004, 0.0006], p: [0.0005, 0.0005, 0.002], i: [0.002, 0.002, 0.01] }) {
    const integral = [0, 0, 0];
    return ({ setpoint, gyro, collective }) => {
        const u = [0, 1, 2].map(a => { const e = setpoint[a] - gyro[a]; integral[a] += e / rate;
            return gains.f[a] * setpoint[a] + gains.p[a] * e + gains.i[a] * integral[a]; });
        return { u, collective };
    };
}
// options: { model, rate, seconds, seed, controller(sample) -> { u, collective, terms, throttle }, amplitude, yawAmplitude, bandHz,
// clampFrom, quietS, governed }. yawAmplitude: the factor of the yaw pilot input (0: no yaw input). governed: the throttle
// of the controller response (a governor in the controller) replaces the PI governor of the fixture.
// quietS: the pilot inputs start after this time (with a 0.5 s ramp), so the horizontal speed is near zero before it.
// clampFrom: from this sample on, the rotor speed is set to the headspeed sensor state before each measurement, as
// control_pipeline.simulate does in its closed loop.
function fly(options = {}) {
    const m = options.model || truthModel(), rate = options.rate || 500, n = Math.round(rate * (options.seconds || 20)), seed = options.seed || 0;
    const amplitude = options.amplitude || 1, bandHz = options.bandHz || 4, hover = hoverCollective(m), quiet = options.quietS || 0;
    const controller = options.controller || rateController(rate);
    const yawAmplitude = options.yawAmplitude === undefined ? 1 : options.yawAmplitude;
    const pilot = [0, 1, 2].map(a => noise(n, rate, 7919 * seed + 31 * a + 1, bandHz, amplitude * [60, 60, 50][a] * (a === 2 ? yawAmplitude : 1)));
    const pilotColl = noise(n, rate, 7919 * seed + 97, 1, 0.03);
    const sim = T.createSim(m, rate), tri = () => [0, 1, 2].map(() => new Float64Array(n));
    const rec = { u: tri(), gyro: tri(), sp: tri(), att: tri(), coll: new Float64Array(n), mix: new Float64Array(n), thr: new Float64Array(n), vbat: new Float64Array(n).fill(VBAT * 100),
        alt: new Float64Array(n), vario: new Float64Array(n), hs: new Float64Array(n), terms: Object.fromEntries(['P', 'I', 'D', 'F', 'B'].map(k => [k, tri()])) };
    // throttle at rest that holds the reference speed: the motor torque balances the profile and induced torque
    let thr = options.throttle || 0.5, govI = 0;
    T.initState(sim, { gyro: [0, 0, 0], att: [0, 0, 0], hs: m.refRpm, alt: 10, vario: 0, thr });
    let first = true;
    for (let i = 0; i < n; i++) {
        if (options.clampFrom !== undefined && i >= options.clampFrom) sim.x[15] = sim.x[30];
        const out = T.outputs(sim.x), gyro = [out[0], out[1], out[2]], hs = out[8];
        // pilot: band-limited rates, levelling of roll and pitch, and a collective that holds the height
        const t = i / rate, on = quiet > 0 ? Math.min(1, Math.max(0, (t - quiet) / 0.5)) : 1;
        const setpoint = [on * pilot[0][i] - 3 * out[3], on * pilot[1][i] - 3 * out[4], on * pilot[2][i]];
        const collective = hover + on * pilotColl[i] - 0.02 * out[7];
        if (i) { const e = (m.refRpm - hs) / m.refRpm; govI += e / rate; thr = Math.max(0.05, (options.throttle || 0.5) + 2 * e + 4 * govI); }
        const response = controller({ i, setpoint, gyro, collective, headspeed: hs, throttle: thr });
        if (options.governed && Number.isFinite(response.throttle)) thr = response.throttle;
        for (let a = 0; a < 3; a++) { rec.u[a][i] = response.u[a]; rec.gyro[a][i] = gyro[a]; rec.sp[a][i] = setpoint[a]; rec.att[a][i] = out[3 + a] * 10;
            if (response.terms) for (const k of Object.keys(rec.terms)) rec.terms[k][a][i] = response.terms[k][a]; }
        rec.coll[i] = collective * 1000; rec.mix[i] = response.collective * 1000; rec.thr[i] = thr * 1000; rec.alt[i] = out[6] * 100; rec.vario[i] = out[7] * 100; rec.hs[i] = hs;
        const input = { u: response.u.slice(), coll: response.collective, thr, vbat: VBAT };
        if (first) { for (let k = 0; k < sim.maxDelay; k++) T.push(sim, input); sim.count = 0; first = false; }
        T.push(sim, input); T.step(sim);
    }
    return { model: m, rate, n, ...rec };
}
// The log segment of one synthetic flight in the form of the worker items (w) of control_pipeline and system_id.
function segment(f, o = {}) {
    const n = f.n, rate = f.rate;
    const w = { n, rate, fromS: 0, flight: { id: o.flight || 'flight', craft: CRAFT, log: o.log || 0, file: 'synthetic', actualRate: rate, start: o.start },
        u: f.u, gyro: f.gyro, sp: f.sp, hs: f.hs, coll: f.coll, rescueAt: new Uint8Array(n), profileAt: new Uint8Array(n).fill(o.profile || 1), ...f.terms,
        extra: { 'mixer[3]': f.mix, 'motor[0]': f.thr, Vbat: f.vbat, 'attitude[0]': f.att[0], 'attitude[1]': f.att[1], 'attitude[2]': f.att[2],
            altitude: f.alt, vario: f.vario, time: Float64Array.from({ length: n }, (_, i) => i / rate * 1e6) } };
    return w;
}
module.exports = { CRAFT, VBAT, RPM0, truthModel, hoverCollective, noise, random, rateController, fly, segment };
