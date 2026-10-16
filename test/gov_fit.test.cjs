'use strict';

// Tests of tools/autotune/gov_fit.cjs (docs/GOVERNOR_AUTOTUNE.md section 4): the bounded LM and NNLS, identification of the governor
// twin from synthetic flights with known parameters (with and without current, without voltage), the split and the qualification,
// validation (open loop, horizon curve, closed loop through a gov_sim stub and through the real gov_sim, events, status), plot data.
// With GOV_FIT_REAL=1 and analysis/governor-20261014/data: the Fireball and Gaui X4 II logs (about 1 min).
//
//   node --test test/gov_fit.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GF = require(path.join(ROOT, 'tools/autotune/gov_fit.cjs'));
const GT = require(path.join(ROOT, 'tools/autotune/gov_twin.cjs'));
const GD = require(path.join(ROOT, 'tools/autotune/gov_data.cjs'));
const SIM = path.join(ROOT, 'tools/autotune/gov_sim.cjs');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (tol ${tol})`);
const rel = (a, b) => Math.abs(a / b - 1);
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(r) { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

// ---- synthetic flights: gov_twin at 1 kHz with a PI governor (collective feedforward) and a state machine ----
// Spool-up (open-loop ramp 0.125/s), ACTIVE with smooth collective, cyclic and yaw, a target change every 25 s through the
// profiles, collective pumps to 1.1 (saturation), a forced FALLBACK (0.9 x I for 0.2 s, then a RECOVERY ramp), a 0.8-s throttle
// cut and a 2.5-s cut (AUTOROTATION, then a BAILOUT ramp of 0.5/s; the long cut arms the soft start again), a spool-down.
// Sensors: hs + white noise (0 under 0.3 % of Href, as an RPM sensor at rest), Vbat + noise in 10-mV steps, Ibat + noise, u in
// 0.001 steps (motor[0] counts).
function flight(p, o = {}) {
    const rate = 1000, T = o.T || 150, n = Math.round(T * rate), dt = 1 / rate, r = rng(o.seed || 1), Href = p.Href;
    const run = { log: o.log || 0, segment: 0, class: 'flight', n, rate, actualRate: rate, pidHz: rate, loopsPerFrame: 1, header: {}, time: new Float64Array(n) };
    for (const k of ['hs', 'u', 'thr', 'coll', 'roll', 'pitch', 'yaw', 'vbat', 'ibat', 'target', 'request']) run[k] = new Float32Array(n);
    run.state = new Uint8Array(n); run.profile = new Uint8Array(n).fill(1); run.armed = new Uint8Array(n).fill(1);
    const prof = o.profiles || [Href], Kp = 1.0, Ki = 3.0, Kf = 0.15, nz = Object.assign({ hs: 0.002, v: 0.01, i: 0.5 }, o.noise || {}), mx = o.maxU || 1;
    const ev = o.events || [{ t: 45, kind: 'pump', dur: 2.5 }, { t: 70, kind: 'fallback' }, { t: 90, kind: 'cut', dur: 0.8 }, { t: 110, kind: 'cut', dur: 2.5 }, { t: 125, kind: 'pump', dur: 2 }];
    const x = GT.initState(p, { hs: 0, u: 0, vbat: p.voltage ? p.V0 : null, stopped: true }), inp = { u: 0, coll: 0, cyc: 0, yaw: 0 };
    const ph = Array.from({ length: 9 }, () => 2 * Math.PI * r()), tEnd = T - 12;
    let st = 1, u = 0, I = 0, tgt = prof[0], hsF = 0, stT = 0, ffF = 0;
    for (let i = 0; i < n; i++) {
        const t = i * dt, flying = [3, 4, 6, 7, 8].includes(st);
        let coll = -0.15, roll = 0, pitch = 0, yaw = 0;
        if (flying && t > 15 && t < tEnd) {
            coll = 0.25 + 0.2 * Math.sin(0.37 * t + ph[0]) + 0.12 * Math.sin(1.9 * t + ph[1]) + 0.05 * Math.sin(5.3 * t + ph[2]);
            roll = 0.12 * Math.sin(0.8 * t + ph[3]) + 0.05 * Math.sin(3.1 * t + ph[4]);
            pitch = 0.1 * Math.sin(0.6 * t + ph[5]) + 0.05 * Math.sin(2.7 * t + ph[6]);
            yaw = 0.2 * Math.sin(1.1 * t + ph[7]) + 0.08 * Math.sin(4.3 * t + ph[8]);
            for (const e of ev) if (e.kind === 'pump' && t >= e.t && t < e.t + e.dur) coll = 1.1;
        }
        const req = prof[Math.floor(t / 25) % prof.length], e0 = ev.find(e => e.kind !== 'pump' && t >= e.t && t < e.t + dt * 1.5);
        if (t < 1) { st = 1; u = 0; }
        else if (t >= tEnd) { st = 1; u = Math.max(0, u - 0.125 * dt); }
        else if (st === 1) { st = 2; u = 0; }
        else if (st === 2 || st === 3 || st === 8) {
            u = Math.min(1, u + (st === 2 ? 0.125 : 0.5) * dt);
            if (hsF >= 0.99 * tgt || u >= 0.95) { st = 4; I = u - Kf * Math.abs(coll); }
        } else if (st === 4 && e0 && e0.kind === 'fallback') { st = 6; stT = t; u = 0.9 * I; }
        else if (st === 6 && t - stT >= 0.2) { st = 3; u = Math.min(u, 0.6); }
        else if (st === 4 && e0 && e0.kind === 'cut') { st = 7; stT = t; u = 0; }
        else if (st === 7) { u = 0; if (t - stT >= ev.find(e => e.kind === 'cut' && Math.abs(e.t - stT) < 0.01).dur) st = 8; }
        else if (st === 4) {
            tgt = tgt < req ? Math.min(req, tgt + 500 * dt) : Math.max(req, tgt - 500 * dt);
            const err = (tgt - hsF) / Href;
            ffF += (Kf * Math.abs(coll) - ffF) * (1 - Math.exp(-dt / 0.03));
            const raw = ffF + Kp * err + I;
            if (!(raw > mx && err > 0) && !(raw < 0 && err < 0)) I += Ki * err * dt;
            u = Math.min(mx, Math.max(0, ffF + Kp * err + I));
        }
        if (st === 2 && u === 0) tgt = req;
        const uq = Math.round(u * 1000) / 1000;
        inp.u = uq; inp.coll = Math.abs(coll); inp.cyc = Math.hypot(roll, pitch); inp.yaw = Math.abs(yaw);
        run.time[i] = t; run.hs[i] = x.hsLog < 0.003 * Href ? 0 : Math.max(0, x.hsLog + nz.hs * Href * gauss(r)); run.u[i] = uq; run.thr[i] = t < tEnd ? 1 : 0;
        run.coll[i] = coll; run.roll[i] = roll; run.pitch[i] = pitch; run.yaw[i] = yaw;
        run.vbat[i] = p.voltage ? Math.round((x.vLog + nz.v * gauss(r)) * 100) / 100 : 0;
        run.ibat[i] = p.current ? x.iLog + nz.i * gauss(r) : 0;
        run.target[i] = st === 4 ? tgt : 0; run.request[i] = req; run.state[i] = st;
        hsF += (run.hs[i] - hsF) * (1 - Math.exp(-dt / 0.016));
        GT.step(x, inp, p, dt);
    }
    if (!p.voltage || o.noVbat) run.vbat = null;
    if (!p.current) run.ibat = null;
    run.hasVoltage = !!run.vbat; run.hasCurrent = !!run.ibat; run.hasGovernor = false;
    return run;
}
const flights = (p, N, o = {}) => Array.from({ length: N }, (_, j) => flight(p, Object.assign({ log: j, seed: 11 + j,
    profiles: (j % 2 ? [1.1, 1, 0.9] : [0.9, 1, 1.1]).map(f => Math.round(f * p.Href)) }, o)));
// Fireball-like (voltage, no current) and Gaui-like (voltage and current) plants
// the ESC soft start of the logs (gov_twin): Fireball 640 rpm/s after an exponential start from 250 rpm, Gaui 300 rpm/s from 130 rpm
const FB = () => GT.copy(GT.defaults({ kv: 290, Href: 4500, V0: 25 }), { tm: 0.3, te: 0.1, ass: 640, asr: 0.6, as0: 250, u0: 0.1, sneg: 2, q0: 0.8, qc: 6, qx: 0.5, qy: 0.3, qf: 0.2, pc: 2, beta: 0.12, kappa: 0.012 });
const GAUI = () => GT.copy(GT.defaults({ kv: 157, Href: 2500, V0: 25, current: true }), { tm: 0.15, te: 0.1, ass: 300, asr: 0.45, as0: 130, u0: 0.116, sneg: 3, q0: 0.6, qc: 3, qx: 0.4, qy: 0.5, qf: 0.15, qs: 0.2, pc: 1.8,
    beta: 0.85, kappa: 0.025, rm: 0.018, i0: 1.2, ti: 0.09 });
const errors = (m, p, names) => Object.fromEntries(names.map(k => [k, +(100 * (m.params[k] / p[k] - 1)).toFixed(2)]));
// q0, qf and qs (n², n and 1 in the load at zero collective) trade off in flight (n 0.9-1.1): the largest error of that load curve
// (% of the truth) at n = 0.5, 0.75, 1 and 1.1
const loadErr = (m, p) => Math.max(...[0.5, 0.75, 1, 1.1].map(n => Math.abs(100 * (GT.load(m.params, n * p.Href, 0, 0, 0) / GT.load(p, n * p.Href, 0, 0, 0) - 1))));
// as0, as1 and asr trade off in the first seconds of the ESC ramp: the largest error of the ramp (% of the truth) 0.5-8 s after the start.
// The data sees a start from rest when hs passes the sensor floor (about 40 ms late): 2-3 % of the ramp at 0.5 s
const rampErr = (m, p) => Math.max(...[0.5, 1, 2, 3, 4, 6, 8].map(a => Math.abs(100 * (GT.ramp(m.params, a, 0) / GT.ramp(p, a, 0) - 1))));

test('lm: bounded, pseudo-Huber, active set at a bound; nnls; quantile', () => {
    // y = a exp(-b t) + c with 5 % outliers: the pseudo-Huber fit recovers (a, b, c), the plain fit does not as well
    const r = rng(3), t = Float64Array.from({ length: 400 }, (_, i) => i / 40), y = t.map(v => 2 * Math.exp(-0.7 * v) + 0.5 + 0.01 * gauss(r) + (r() < 0.05 ? 3 : 0));
    const f = (z, out) => { for (let i = 0; i < t.length; i++) out[i] = (z[0] * Math.exp(-z[1] * t[i]) + z[2] - y[i]) / 0.01; return out; };
    const box = { n: t.length, lo: [0, 0, -5], hi: [10, 5, 5], steps: [1e-6, 1e-6, 1e-6] };
    const hub = GF.lm(f, [1, 0.3, 0], Object.assign({ huber: 2 }, box)), sq = GF.lm(f, [1, 0.3, 0], box);
    near(hub.z[0], 2, 0.01, 'a'); near(hub.z[1], 0.7, 0.005, 'b'); near(hub.z[2], 0.5, 0.005, 'c');
    assert.ok(Math.abs(sq.z[2] - 0.5) > 5 * Math.abs(hub.z[2] - 0.5), `outliers move the squared fit: c ${sq.z[2]} against ${hub.z[2]}`);
    assert.ok(hub.history.every((c, i) => i === 0 || c <= hub.history[i - 1]), 'the cost never rises');
    assert.equal(hub.info.length, 3); assert.ok(hub.info.every(v => v > 0));
    // the optimum of b is out of the box: b stays at its upper bound, a and c fit the rest
    const tight = GF.lm(f, [1, 0.3, 0], Object.assign({ huber: 2 }, box, { hi: [10, 0.5, 5] }));
    assert.equal(tight.z[1], 0.5); assert.ok(tight.cost > hub.cost);
    // a parameter with no effect keeps its value and has no information
    const dead = GF.lm((z, out) => f(z, out), [1, 0.3, 0, 7], { n: t.length, lo: [0, 0, -5, 0], hi: [10, 5, 5, 10], steps: [1e-6, 1e-6, 1e-6, 1e-3], huber: 2 });
    assert.equal(dead.z[3], 7); assert.equal(dead.info[3], 0);
    // NNLS: the unconstrained solution has a negative coefficient
    const X = [[1, 1, 1, 1], [1, 2, 3, 4], [4, 3, 2, 1]], yy = [1, 2.1, 2.9, 4.2], q = GF.nnls(X, yy);
    assert.ok(q.every(v => v >= 0)); assert.equal(q[2], 0);
    near(GF.quantile([3, 1, 2, 4], 0.5), 2.5, 1e-12); assert.equal(GF.quantile([], 0.5), null);
});

test('split and qualification: every third flight log is a test log, else the last 40 %; bench runs and runs without hs are not used', () => {
    const p = FB(), runs = flights(p, 4, { T: 40, events: [] });
    let P = GF.prepare(runs);
    assert.deepEqual(P.split, { mode: 'logs', testLogs: [2], testShare: null });
    assert.ok(P.train.every(w => w.c.run.log !== 2) && P.test.every(w => w.c.run.log === 2) && P.test.length > 0);
    assert.ok(P.train.every(w => w.m <= Math.round(GF.RULES.windowS * 100) + Math.round(GF.RULES.minWindowS * 100)), 'windows of about windowS');
    // two flight logs: the last 40 % of the motor-running grid points of each
    P = GF.prepare(runs.slice(0, 2));
    assert.equal(P.split.mode, 'tail');
    for (const c of P.grids) {
        let on = 0, test = 0; for (let k = 0; k < c.ng; k++) { on += c.RUN[k]; if (k >= c.testFrom) test += c.RUN[k]; }
        near(test / on, 0.4, 0.01, 'test share');
    }
    // motor running needs the rotor turning: no window starts before the first hs > 0
    for (const w of P.train) assert.ok(w.c.HS[w.k0] > 0);
    // bench run, a run without hs, a run without Vbat: the model drops the voltage channel and says why
    const bench = Object.assign({}, runs[0], { class: 'bench', log: 7 }), noHs = Object.assign({}, runs[1], { hs: null, log: 8 }), noV = Object.assign({}, runs[2], { vbat: null, hasVoltage: false });
    P = GF.prepare([runs[0], runs[1], bench, noHs, noV]);
    assert.equal(P.grids.length, 3); assert.equal(P.has.voltage, false);
    assert.ok(P.reasons.includes(GF.TEXT.bench(1)) && P.reasons.includes(GF.TEXT.noHsU(9)) && P.reasons.includes(GF.TEXT.mixedV), P.reasons.join(' | '));
});

test('identification without current (Fireball-like, 20 min): every parameter within 5 % (u0 6 %, qf by the load curve); speed; bootstrap and flights', t => {
    const p = FB(), runs = flights(p, 8), t0 = Date.now(), m = GF.identify(runs), ms = Date.now() - t0;
    const names = ['kv', 'tm', 'te', 'ass', 'asr', 'as0', 'u0', 'sneg', 'q0', 'qc', 'qx', 'qy', 'qf', 'pc', 'beta', 'kappa'], err = errors(m, p, names), le = loadErr(m, p);
    t.diagnostic(`20 min of flight data (${m.fit.trainS.toFixed(0)} s training, ${m.fit.testS.toFixed(0)} s test): identification ${m.timing.fitS.toFixed(1)} s, bootstrap (${m.bootstrap.n}) ${m.timing.bootstrapS.toFixed(1)} s, total ${(ms / 1000).toFixed(1)} s`);
    t.diagnostic(`error % without current: ${JSON.stringify(err)}; ramp ${rampErr(m, p).toFixed(2)} %, load curve ${le.toFixed(2)} %, qs ${m.params.qs.toFixed(3)} V (true 0), as1 ${m.params.as1.toFixed(1)} rpm/s (true 0); th (held) ${m.params.th}, tv ${m.params.tv.toFixed(4)} (true 0.06)`);
    assert.equal(m.status, 'identified'); assert.deepEqual(m.has, { voltage: true, current: false });
    assert.ok(m.reasons.includes(GF.TEXT.noCurrent));
    // SPEC section 4: within 5 %. u0: the data sees a start from rest when hs passes the sensor floor (about 40 ms late on the 0.125/s
    // ramp: +0.005, +5 %). qf (the n term) trades with q0 and qs at n 0.9-1.1: the load curve at zero collective instead (within 2 %)
    for (const k of ['kv', 'tm', 'te', 'ass', 'asr', 'as0', 'sneg', 'q0', 'qc', 'qx', 'qy', 'pc', 'beta', 'kappa']) assert.ok(Math.abs(err[k]) <= 5, `${k} ${err[k]} %`);
    assert.ok(Math.abs(err.u0) <= 6, `u0 ${err.u0} %`);
    assert.ok(rampErr(m, p) <= 5, `ESC ramp ${rampErr(m, p)} %`);
    assert.ok(le <= 2 && m.params.qs < 0.1, `load curve ${le} %, qf ${err.qf} %, qs ${m.params.qs}`);
    assert.ok(m.params.vp < 0.05, `no polarization in the plant: vp ${m.params.vp}`);
    assert.ok(ms < 60000, `identification and bootstrap in ${ms} ms: the in-app budget is 60 s`);
    // the held parameters, the bootstrap, the information flags
    assert.equal(m.params.th, GF.RULES.init.th); assert.ok(!m.free.includes('th') && !m.free.includes('kappa'));
    // the bootstrap samples and the leave-one-flight-out pseudo-sets (6 training flight logs); p5-p95 is the wider of the two
    assert.equal(m.bootstrap.n, GF.RULES.bootstrap); assert.equal(m.bootstrap.flights, 6); assert.equal(m.samples.length, GF.RULES.bootstrap + 6);
    for (const k of ['kv', 'tm', 'qc', 'beta']) {
        const u = m.uncertainty[k]; assert.ok(u.p5 <= u.p95 && u.informed, k); assert.ok(rel(u.p50, u.value) < 0.05, `${k} bootstrap median ${u.p50} near ${u.value}`);
        assert.ok(u.p5 <= u.bootstrap.p5 && u.p95 >= u.bootstrap.p95 && u.p5 <= u.flights.lo && u.p95 >= u.flights.hi && u.flights.n === 6, JSON.stringify(u));
    }
    assert.equal(m.physical, null, 'no physical values without current');
    assert.ok(m.regression.kvRatio > 0 && m.regression.kvRatio < p.kv * 1.03, `kv from the ratio ${m.regression.kvRatio}: a lower bound`);
    // the soft start is measured at the motor starts from rest (held in the LM), with the spread of the single starts
    assert.ok(m.softStart.informed && m.softStart.starts >= 4 && !m.free.includes('ass') && !m.free.includes('u0'), JSON.stringify(m.softStart));
    assert.ok(m.uncertainty.ass.informed && m.uncertainty.ass.p5 <= p.ass * 1.05 && m.uncertainty.ass.p95 >= p.ass * 0.95, JSON.stringify(m.uncertainty.ass));
    assert.ok(m.kappa.restOffset && Math.abs(m.kappa.restOffset.median) < 0.05, `no polarization in the plant: ${JSON.stringify(m.kappa.restOffset)}`);
});

test('identification with current (Gaui-like): every parameter within 5 % (qf and qs by the load curve); physical values', t => {
    const p = GAUI(), runs = flights(p, 4), m = GF.identify(runs, { bootstrap: 4 });
    const names = ['kv', 'tm', 'te', 'ass', 'asr', 'as0', 'u0', 'sneg', 'q0', 'qc', 'qx', 'qy', 'qf', 'qs', 'pc', 'beta', 'kappa', 'rm', 'i0', 'ti', 'tv'], err = errors(m, p, names);
    t.diagnostic(`error % with current: ${JSON.stringify(err)}; ramp ${rampErr(m, p).toFixed(2)} %, load curve ${loadErr(m, p).toFixed(2)} %; ${m.timing.totalS.toFixed(1)} s`);
    assert.deepEqual(m.has, { voltage: true, current: true });
    // qf and qs (the n and constant terms) trade with q0 at n 0.9-1.1: the load curve at zero collective instead (within 2 %)
    for (const k of ['kv', 'tm', 'te', 'ass', 'asr', 'as0', 'u0', 'sneg', 'q0', 'qc', 'qx', 'qy', 'pc', 'beta', 'kappa', 'rm', 'i0', 'ti', 'tv']) assert.ok(Math.abs(err[k]) <= 5, `${k} ${err[k]} %`);
    assert.ok(rampErr(m, p) <= 5, `ESC ramp ${rampErr(m, p)} %`);
    assert.ok(loadErr(m, p) <= 2, `load curve ${loadErr(m, p)} %, qf ${err.qf} %, qs ${err.qs} %`);
    // physical values: R_m, R0 = beta R_m, dOCV/dAh = kappa R_m 3600, and the static regressions for the comparison
    const ph = m.physical.value, tru = GT.physical(p);
    for (const k of ['Rm', 'R0', 'dOcvPerAh', 'J']) assert.ok(rel(ph[k], tru[k]) <= 0.05, `${k} ${ph[k]} against ${tru[k]}`);
    assert.ok(m.physical.range.Rm.p5 <= m.physical.range.Rm.p95);
    const reg = m.regression;
    // the static regression (start values, 1-s blocks of the commanded throttle u, not the ESC duty): R_m within 10 %
    assert.ok(rel(reg.kvCurrent, p.kv) < 0.02 && rel(reg.Rm, p.rm) < 0.1 && rel(reg.R0, p.beta * p.rm) < 0.1, JSON.stringify(reg.physical));
    t.diagnostic(`R0/R_m: output error ${m.params.beta.toFixed(3)}, regression with current ${reg.betaCurrent.toFixed(3)}, static without current ${reg.betaStatic.toFixed(3)} (true ${p.beta}: low by ${(100 * (1 - reg.betaStatic / p.beta)).toFixed(0)} %, models 4.2)`);
    assert.ok(reg.betaStatic < 0.8 * p.beta, 'the static regression without current is biased low (models 4.2)');
    assert.ok(m.softStart.informed);
});

// the samples from..to of a run (a log that starts with the rotor at speed)
const cut = (r, from, to) => { const o = Object.assign({}, r, { n: to - from }); for (const k of Object.keys(r)) if (ArrayBuffer.isView(r[k]) && r[k].length === r.n) o[k] = r[k].slice(from, to); return o; };

test('the soft start without a start from rest in the data: not informed; no voltage: kv per throttle unit', () => {
    const p = GAUI(), quiet = [{ t: 45, kind: 'pump', dur: 2.5 }, { t: 70, kind: 'fallback' }];
    const m = GF.identify(flights(p, 3, { T: 80, events: quiet }), { bootstrap: 0 });
    assert.ok(m.softStart.informed && Math.abs(m.params.ass / p.ass - 1) < 0.1, `ass ${m.params.ass} from the spool-ups (truth ${p.ass})`);
    // the logs start at speed and have no cut: no start from rest, the start values of RULES.init
    const at = flights(p, 3, { T: 80, events: quiet }).map(r => cut(r, 20000, 66000)), a = GF.identify(at, { bootstrap: 0 });
    assert.equal(a.softStart.starts, 0); assert.equal(a.softStart.informed, false); assert.equal(a.uncertainty.ass.informed, false); assert.equal(a.uncertainty.u0.informed, false);
    assert.equal(a.params.ass, GF.RULES.init.ass); assert.equal(a.params.u0, GF.RULES.init.u0);
    // no voltage: the constant-voltage model; the effective kv is kv·V in rpm per throttle unit
    const q = FB(), runs = flights(q, 3, { T: 80, noVbat: true }), n = GF.identify(runs, { bootstrap: 0 });
    assert.deepEqual(n.has, { voltage: false, current: false }); assert.ok(n.reasons.includes(GF.TEXT.noVoltage));
    assert.equal(n.params.voltage, false); assert.equal(n.kappa.value, 0); assert.equal(n.uncertainty.beta, undefined);
    assert.ok(n.params.kv > 0.8 * q.kv * 22 && n.params.kv < 1.2 * q.kv * 25, `kv ${n.params.kv} rpm per throttle unit`);
    // too little data
    const short = GF.identify([flight(q, { T: 20, events: [] })]);
    assert.equal(short.status, 'failed'); assert.ok(short.reasons.some(r => /must have a minimum/.test(r)));
});

// a gov_sim stand-in: returns the recorded data as the trace (all samples), with optional offsets
const stubSim = (o = {}) => ({ keyOf: (r) => String(r.log), calls: [], async run(rec, cfg, opt) {
    this.calls.push({ log: rec.log, cfg, opt });
    if (o.exclude && o.exclude.includes(rec.log)) return { log: rec.log, excluded: 'The log is excluded.' };
    const n = rec.n, i = Int32Array.from({ length: n }, (_, k) => k);
    return { log: rec.log, plant: opt.plant, compare: { stateAgreement: 1 }, trace: { i, hs: Float32Array.from(rec.hs, v => v * (1 + (o.hs || 0))), u: Float32Array.from(rec.u, v => v + (o.u || 0)),
        vbat: rec.vbat, state: Uint8Array.from(rec.state, (s, k) => o.state && k % 40 === 0 ? 0 : s) } };
} });

test('validate: open loop, horizon curve, closed loop (gov_sim API), events, status and STE reasons; plot data', async () => {
    const p = FB(), runs = flights(p, 3), m = GF.identify(runs, { bootstrap: 0 });
    const sim = stubSim(), v = await GF.validate(m, runs, { sim, configs: { 0: 'a', 1: 'b', 2: 'c' } });
    // only the test log (index 2) runs in closed loop, with plant 'twin' and the model parameter set, then the tm scan
    assert.deepEqual(sim.calls.map(c => [c.log, c.cfg, c.opt.plant]), Array(5).fill([2, 'c', 'twin']));
    assert.equal(sim.calls[0].opt.twin, m.params);
    assert.deepEqual(sim.calls.slice(1).map(c => +(c.opt.twin.tm / m.params.tm).toFixed(9)), GF.RULES.status.tmScan);
    assert.equal(v.status, 'validated', v.reasons.join(' | ')); assert.deepEqual(v.reasons, [GF.TEXT.validated]);
    // the stub repeats the log: no fast error at any tm (no tmBand check), and one test log (no check of each log)
    assert.deepEqual(v.checks.map(c => c.rule), ['hsMedian', 'vbatRms', 'clHsRms', 'clSkill', 'clBand', 'clURms', 'stateAgree']);
    assert.equal(v.closedLoop.band, 0); assert.equal(v.closedLoop.skill, 0); assert.ok(v.closedLoop.baseRms > 0.1, `logged tracking error ${v.closedLoop.baseRms}`);
    assert.equal(v.unforced, null, 'the stub has no logMetrics: no FALLBACK entries');
    assert.ok(v.openLoop.window.hs.medianAbs < 0.5 && v.openLoop.window.vbat.rms < 0.05, JSON.stringify(v.openLoop.window));
    assert.ok(v.openLoop.stretch.hs.medianAbs < 0.5);
    near(v.closedLoop.hsRms, 0, 1e-9); near(v.closedLoop.uRms, 0, 1e-9); assert.equal(v.closedLoop.stateAgreement, 1);
    // horizon curve: the model beats "hold the last value" from 0.5 s on, in all groups
    assert.deepEqual(v.horizon.horizons, GF.RULES.horizons);
    for (let j = 2; j < v.horizon.horizons.length; j++) assert.ok(v.horizon.model[j].rms < v.horizon.hold[j].rms && v.horizon.inActive.model[j].rms < v.horizon.inActive.hold[j].rms, `horizon ${v.horizon.horizons[j]} s`);
    const hz = v.horizon, nAll = hz.model[0].n;
    assert.ok(hz.inActive.model[0].n + hz.crossing.model[0].n === nAll && hz.crossing.model[5].n > hz.crossing.model[0].n && hz.inActive.target[0].n === hz.inActive.model[0].n);
    // events: one spool-up in the test log; the stub repeats the log
    assert.equal(v.events.spoolups.length, 1); const e = v.events.spoolups[0];
    near(e.exitThrottle.closed, e.exitThrottle.log, 1e-6); assert.equal(e.pass, true); assert.ok(Math.abs(e.overshoot.open - e.overshoot.log) < 1.5, JSON.stringify(e.overshoot));
    assert.ok(v.events.saturation[0].logS > 1 && v.events.saturation[0].pass);
    // closed-loop errors: 3 % hs, 5 % throttle, 2 % of the states wrong -> partial with the three reasons
    const w = await GF.validate(m, runs, { sim: stubSim({ hs: 0.03, u: 0.05, state: true }), cfg: {} });
    assert.equal(w.status, 'partial');
    near(w.closedLoop.hsRms, 3, 0.05); near(w.closedLoop.uRms, 0.05, 1e-3); near(w.closedLoop.stateAgreement, 0.975, 0.002);
    assert.deepEqual(w.checks.filter(c => !c.pass).map(c => c.rule), ['clHsRms', 'clSkill', 'clURms', 'stateAgree']);
    assert.ok(w.reasons.includes(GF.TEXT.clHsRms(w.closedLoop.hsRms, 1.5)));
    // no simulation, an excluded log, no configuration: partial, with the reason
    for (const [o, why] of [[{ sim: null }, GF.TEXT.noSim], [{ sim: stubSim({ exclude: [2] }), cfg: {} }, GF.TEXT.simFail(3, 'The log is excluded.')], [{ sim: stubSim(), configs: {} }, GF.TEXT.noConfig(3)]]) {
        const x = await GF.validate(m, runs, o);
        assert.equal(x.status, 'partial'); assert.ok(x.reasons.includes(why), x.reasons.join(' | '));
    }
    // a wrong model: rejected
    const bad = Object.assign({}, m, { params: GT.copy(m.params, { kv: m.params.kv * 1.1 }) }), b = await GF.validate(bad, runs, { sim: null });
    assert.equal(b.status, 'rejected'); assert.ok(b.reasons[0] === GF.TEXT.rejected && b.checks.find(c => c.rule === 'hsMedian').pass === false);
    // plot data: <= plotPoints per trace, the closed-loop trace on the same times, the steady-state map
    const pl = GF.plotData(m, runs, v);
    assert.equal(pl.runs.length, 1); const r0 = pl.runs[0];
    assert.ok(r0.time.length <= GF.RULES.plotPoints && r0.time.length > 1000);
    for (const k of ['hs', 'hsOpen', 'hsClosed', 'u', 'uClosed', 'vbat', 'vbatOpen', 'target']) assert.equal(r0[k].length, r0.time.length, k);
    assert.equal(r0.ibat, null); assert.equal(r0.ibatOpen, null);
    assert.ok(pl.horizon === v.horizon);
    const sm = pl.steady;
    assert.deepEqual([...new Set(sm.curves.map(c => c.headspeed))], [4050, 4500, 4950]); assert.deepEqual([...new Set(sm.curves.map(c => c.ocv))], ['full', 'end']);
    for (const c of sm.curves) {
        const d = c.throttle.filter((x, j) => x != null && c.coll[j] >= Math.max(0, m.params.c0));
        assert.ok(d.length > 20 && d.every((x, j) => j === 0 || x >= d[j - 1] - 1e-12), 'required throttle rises with the collective above c0');
    }
    const full = sm.curves.find(c => c.headspeed === 4500 && c.ocv === 'full'), end = sm.curves.find(c => c.headspeed === 4500 && c.ocv === 'end');
    assert.ok(end.voltage < full.voltage && end.throttle[20] > full.throttle[20], 'more throttle at the end of the pack');
    assert.ok(sm.points.length > 50 && sm.points.length <= GF.RULES.plotPoints);
});

test('closed loop with the native governor (gov_sim): data from the governor and a known twin, identify, validate', { skip: !fs.existsSync(SIM) && 'no tools/autotune/gov_sim.cjs' }, async t => {
    const GS = require(SIM), F = require(path.join(ROOT, 'tools/autotune/firmware_controller.cjs'));
    const PF = F.SCHEMA.filter(f => f.member.startsWith('profile.governor.')).map(f => f.name), pick = (o, ns) => Object.fromEntries(ns.filter(k => k in o).map(k => [k, o[k]]));
    const d = F.defaults(), GOV = { gov_mode: 3, gov_throttle_type: 2, gov_startup_time: 100, gov_spoolup_time: 80, gov_tracking_time: 20, gov_recovery_time: 20, gov_spooldown_time: 30,
        gov_handover_throttle: 25, gov_autorotation_timeout: 15, gov_rpm_filter: 10, gov_ff_filter: 5, gov_d_filter: 50, tail_rotor_mode: 0, main_rotor_dir: 0 };
    const PROF = { gov_flags: 0, gov_gain: 55, gov_p_gain: 18, gov_i_gain: 60, gov_d_gain: 2, gov_f_gain: 32, gov_p_limit: 30, gov_i_limit: 95, gov_d_limit: 5, gov_f_limit: 40, gov_yaw_weight: 5,
        gov_cyclic_weight: 35, gov_collective_weight: 100, gov_collective_curve: 20, gov_max_throttle: 100, gov_min_throttle: 10, gov_fallback_drop: 10 };
    const cfg = { global: Object.assign({}, d, GOV), profiles: { 1: Object.assign(pick(d, PF), PROF, { gov_headspeed: 4500 }), 2: Object.assign(pick(d, PF), PROF, { gov_headspeed: 4100 }) },
        gear: null, voltageSource: 'ESC', cells: 6, assumptions: [] };
    const truth = FB();
    // pilot: FUNCTION throttle (0 off, 0.5 auto: an autorotation, 1 run), collective pumps, PID profile 2 in the middle of the flight
    const pilot = (seed) => { const r = rng(seed), ph = Array.from({ length: 6 }, () => 2 * Math.PI * r()); return (tt) => ({ thr: tt < 0.5 || tt > 108 ? 0 : (tt > 92 && tt < 93) || (tt > 98 && tt < 100.5) ? 0.5 : 1, profile: tt > 50 && tt < 75 ? 2 : 1,
        coll: tt < 14 ? -0.15 : (tt > 40 && tt < 42) || (tt > 85 && tt < 86.5) ? 1.0 : 0.25 + 0.2 * Math.sin(0.37 * tt + ph[0]) + 0.1 * Math.sin(1.9 * tt + ph[1]),
        roll: tt < 14 ? 0 : 0.1 * Math.sin(0.8 * tt + ph[2]), pitch: tt < 14 ? 0 : 0.08 * Math.sin(0.6 * tt + ph[3]), yaw: tt < 14 ? 0 : 0.15 * Math.sin(1.1 * tt + ph[4]) }); };
    const make = async (log) => {
        const rate = 1000, n = 115 * rate, f = pilot(7 + log), c = { time: new Float64Array(n), 'rcCommand[4]': new Float32Array(n), profileAt: new Uint8Array(n), Vbat: new Float32Array(n).fill(2500),
            hs: new Float32Array(n), 'motor[0]': new Float32Array(n) };
        for (const k of [0, 1, 2, 3]) c[`mixer[${k}]`] = new Float32Array(n);
        for (let i = 0; i < n; i++) { const v = f(i / rate); c.time[i] = i / rate; c['rcCommand[4]'][i] = v.thr * 1000; c.profileAt[i] = v.profile; ['roll', 'pitch', 'yaw', 'coll'].forEach((k, j) => { c[`mixer[${j}]`][i] = v[k] * 1000; }); }
        const meta = { log, n, rate, actualRate: rate, timeStartUs: 20e6, header: { looptime: 500, pid_process_denom: 2, vbatcellvoltage: [330, 350, 430] } };
        const res = await GS.run(GD.fromColumns(c, meta, { class: 'flight', flights: [] }), cfg, { plant: 'twin', twin: truth, record: { points: 1e9 }, scenario: { twinStart: true, forceFallback: [62] } });
        const r = rng(log + 100), tr = res.trace;
        for (let i = 0; i < n; i++) { c.hs[i] = tr.hs[i] < 13 ? 0 : tr.hs[i] + 9 * gauss(r); c['motor[0]'][i] = Math.round(tr.u[i] * 1000); c.Vbat[i] = Math.round(tr.vbat[i] * 100 + gauss(r)); }
        c.govStateAt = Uint8Array.from(tr.state); c.govTarget = Float32Array.from(tr.target); c.govRequest = Float32Array.from(tr.profile, q => q === 2 ? 4100 : 4500);
        return GD.fromColumns(c, meta, { class: 'flight', flights: [] });
    };
    const runs = []; for (let l = 0; l < 3; l++) runs.push(await make(l));
    const m = GF.identify(runs, { bootstrap: 0 }), err = errors(m, truth, ['kv', 'tm', 'te', 'ass', 'q0', 'qc', 'qx', 'qy', 'qf', 'beta']);
    t.diagnostic(`native-governor data, error %: ${JSON.stringify(err)}; load curve ${loadErr(m, truth).toFixed(2)} %`);
    for (const k of ['kv', 'tm', 'te', 'ass', 'qc', 'qx', 'qy', 'beta']) assert.ok(Math.abs(err[k]) <= 10, `${k} ${err[k]} %`);
    assert.ok(loadErr(m, truth) <= 10, `load curve ${loadErr(m, truth)} %`);
    const v = await GF.validate(m, runs, { sim: GS, configs: { 2: cfg } });
    t.diagnostic(`closed loop: hs RMS ${v.closedLoop.hsRms.toFixed(3)} %, u RMS ${v.closedLoop.uRms.toFixed(4)}, states ${v.closedLoop.stateAgreement.toFixed(4)}, Vbat RMS ${v.closedLoop.vbatRms.toFixed(3)} V; open loop median ${v.openLoop.window.hs.medianAbs.toFixed(3)} %`);
    t.diagnostic(`closed loop against the baselines: HS RMS / logged tracking error ${v.closedLoop.skill.toFixed(3)}, fast part ${v.closedLoop.band.toFixed(3)}; tm scan (fast part): ` +
        v.tmScan.map(q => `x${q.factor} ${q.band.toFixed(3)}`).join(', '));
    assert.equal(v.status, 'validated', v.reasons.join(' | '));
    assert.ok(v.closedLoop.hsRms < 0.5 && v.closedLoop.uRms < 0.01 && v.closedLoop.stateAgreement > 0.995, JSON.stringify(v.closedLoop.runs.map(q => q.compare)));
    // with the true plant structure, the fast part of the closed loop confirms tm: tm x0.5 and x2 are worse by more than the margin
    assert.ok(v.checks.find(c => c.rule === 'tmBand').pass && v.tmScan.filter(q => q.factor === 0.5 || q.factor === 2).every(q => q.band > v.closedLoop.band / GF.RULES.status.tmMargin), JSON.stringify(v.tmScan));
    const e = v.events.spoolups[0];
    assert.ok(e && Math.abs(e.exitThrottle.closed - e.exitThrottle.log) < 0.02 && Math.abs(e.overshoot.closed - e.overshoot.log) < 1, JSON.stringify(v.events));
});

test('robust data handling: a sample that is not finite, a channel that the runs do not record, Href from the training flights only', async () => {
    const quiet = [{ t: 45, kind: 'pump', dur: 2.5 }, { t: 70, kind: 'fallback' }], p = GAUI(), runs = flights(p, 3, { T: 80, events: quiet });
    const clean = GF.identify(runs, { bootstrap: 0 });
    // one sample of Vbat, of hs and of the collective that is not finite, in a training window: no exception, the same fit
    const bad = runs.map(r => Object.assign({}, r)), r0 = bad[0];
    for (const k of ['vbat', 'hs', 'coll', 'ibat']) r0[k] = Float32Array.from(r0[k]);
    r0.vbat[30000] = NaN; r0.hs[31000] = NaN; r0.coll[32000] = Infinity; r0.ibat[33000] = NaN;
    const m = GF.identify(bad, { bootstrap: 0 });
    assert.equal(m.status, 'identified', m.reasons.join(' | ')); assert.ok(Number.isFinite(m.fit.cost));
    for (const k of ['kv', 'tm', 'qc', 'beta', 'rm']) assert.ok(rel(m.params[k], clean.params[k]) < 0.01, `${k} ${m.params[k]} against ${clean.params[k]}`);
    // a model with current, validated on runs without Ibat (and without Vbat): no exception, the channel is not compared, with the reason
    const noI = runs.map(r => Object.assign({}, r, { ibat: null, hasCurrent: false })), vi = await GF.validate(clean, noI, { sim: null });
    assert.ok(vi.reasons.includes(GF.TEXT.noChannelI) && vi.openLoop.window.ibat === null && vi.openLoop.window.vbat.rms < 0.15, vi.reasons.join(' | '));
    const noV = runs.map(r => Object.assign({}, r, { vbat: null, ibat: null })), vv = await GF.validate(clean, noV, { sim: null });
    assert.ok(vv.reasons.includes(GF.TEXT.noChannelV) && !vv.checks.some(c => c.rule === 'vbatRms') && vv.openLoop.window.hs.n > 0, vv.reasons.join(' | '));
    assert.equal(GF.openLoop(clean, noV).window.vbat, null);
    // the test flight log flies another headspeed: Href is the median request of the training flights
    const q = FB(), hr = flights(q, 3, { T: 40, events: [] }); hr[2] = flight(q, { log: 2, seed: 13, T: 40, events: [], profiles: [5850] });
    assert.equal(GF.prepare(hr).Href, 4500);
    assert.equal(GF.identify([flight(q, { T: 20, events: [] })]).status, 'failed');
});

test('closed loop rows, events and plot data of a log with two parts (a logging pause); the saturation level of gov_max_throttle', async () => {
    const quiet = [{ t: 30, kind: 'pump', dur: 3 }], p = FB(), runs = flights(p, 3, { T: 70, events: quiet, maxU: 0.95 }), m = GF.identify(runs, { bootstrap: 0 });
    const r2 = runs[2], k = 35000, a = cut(r2, 0, k), b = Object.assign(cut(r2, k, r2.n), { segment: 1 }), parts = [runs[0], runs[1], a, b];
    // the stub repeats each part, with the part number in the throttle (part 1: + 0.01)
    const stub = { keyOf: (r) => String(r.log), async run(rec) {
        const n = rec.n, i = Int32Array.from({ length: n }, (_, j) => j), s = rec.segment || 0;
        return { log: rec.log, segment: s, compare: {}, trace: { i, hs: Float32Array.from(rec.hs), u: Float32Array.from(rec.u, v => v + 0.01 * s), vbat: rec.vbat, state: Uint8Array.from(rec.state) } };
    } };
    const cfg = { start: 1, changes: [], profiles: { 1: { gov_max_throttle: 95 } } }, v = await GF.validate(m, parts, { sim: stub, configs: { 2: cfg } });
    const rows = v.closedLoop.runs;
    assert.deepEqual(rows.map(q => [q.log, q.segment]), [[2, 0], [2, 1]]);
    near(rows[0].uRms, 0, 1e-6); near(rows[1].uRms, 0.01, 1e-6);
    assert.deepEqual(v.events.saturation.map(q => [q.log, q.segment]), [[2, 0], [2, 1]]);
    for (const [j, q] of v.events.saturation.entries()) assert.equal(q.closedS, rows[j].satS, `the row of part ${j}`);
    // gov_max_throttle 95: saturated at u >= 0.945 (the pump at 30 s is in part 0); part 1 + 0.01 saturates where the log is at 0.935..0.945
    assert.ok(v.events.saturation[0].logS > 1 && v.events.saturation[1].logS === 0, JSON.stringify(v.events.saturation));
    const pl = GF.plotData(m, parts, v);
    assert.deepEqual(pl.runs.map(q => [q.log, q.segment]), [[2, 0], [2, 1]]);
    for (const q of pl.runs) { const d = q.u.map((x, j) => q.uClosed[j] - x).filter(Number.isFinite); near(d.reduce((s, x) => s + x, 0) / d.length, 0.01 * q.segment, 2e-3, `part ${q.segment}`); }
    // without a configuration: the ceiling of the log (the highest u in ACTIVE, held for satHoldS)
    const w = await GF.validate(m, parts, { sim: stub, cfg: {} });
    near(w.events.saturation[0].logS, v.events.saturation[0].logS, 0.05);
    const full = await GF.validate(m, runs, { sim: stub, cfg: {} });
    assert.ok(full.events.saturation[0].logS > 1, 'the ceiling 0.95 of the whole log');
    // frame seconds, the clock of the log viewer (env.seekFrame of js/tuning_dialog.js): a part of the worker has the time from its own
    // start and fromS, its start in the log. The plot time and the event times t are fromS + time (here a pause of 2 s before part 2)
    const t0 = b.time[0], b2 = Object.assign({}, b, { time: Float64Array.from(b.time, (x) => x - t0), fromS: t0 + 2 }), parts2 = [runs[0], runs[1], a, b2];
    const v2 = await GF.validate(m, parts2, { sim: stub, configs: { 2: cfg } }), pl2 = GF.plotData(m, parts2, v2), q1 = pl.runs[1], q2 = pl2.runs[1];
    assert.deepEqual(q2.time.map((x) => +(x - 2).toFixed(3)), q1.time, 'the plot time of part 2 is fromS + time');
    assert.deepEqual(pl.runs.map((q) => q.bands.map((x) => x.state)), [['IDLE', 'SPOOLUP'], ['IDLE']], 'the spool-up of part 1 and the end of part 2');
    assert.deepEqual(q2.bands.map((x) => [+(x.x0 - 2).toFixed(3), +(x.x1 - 2).toFixed(3), x.state]), q1.bands.map((x) => [x.x0, x.x1, x.state]), 'the bands of part 2 in frame seconds');
    assert.equal(v2.events.spoolups.length, 1);
    for (const [j, e] of v2.events.spoolups.concat(v2.events.fallbacks).entries()) {
        const r = e.segment ? b2 : a; near(e.t, (r.fromS || 0) + r.time[Math.min(r.n - 1, Math.round(e.atS * r.rate))], 0.01, `event ${j}: t is fromS + time`);
    }
    // the bands of the logged governor states: each state other than OFF, ACTIVE and BYPASS, to the first frame of the next state
    const sb = GF.stateBands({ n: 7, fromS: 10, time: Float64Array.of(0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6), state: Uint8Array.of(0, 1, 2, 4, 6, 6, 9) });
    assert.deepEqual(sb, [{ x0: 10.1, x1: 10.2, state: 'IDLE' }, { x0: 10.2, x1: 10.3, state: 'SPOOLUP' }, { x0: 10.4, x1: 10.6, state: 'FALLBACK' }]);
    assert.deepEqual(GF.stateBands({ n: 7, fromS: 10, time: Float64Array.of(0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6), state: Uint8Array.of(0, 1, 2, 4, 6, 6, 9) }, 3), [{ x0: 10.4, x1: 10.6, state: 'FALLBACK' }], 'from the start of the test part');
    assert.deepEqual(GF.stateBands({ n: 3, time: Float64Array.of(0, 1, 2), state: null }), [], 'no state field');
    assert.ok(pl.runs[0].bands.every((x) => x.x0 <= x.x1 && Object.values(GF.RULES.bandStates).includes(x.state)), JSON.stringify(pl.runs[0].bands));
});

test('stateAt: the causal start state of the validation; gov_twin.simulate from it gives the open-loop numbers of openLoop()', () => {
    const quiet = [{ t: 45, kind: 'pump', dur: 2.5 }, { t: 60, kind: 'cut', dur: 0.8 }], p = GAUI(), runs = flights(p, 3, { T: 80, events: quiet }), m = GF.identify(runs, { bootstrap: 0 });
    const P = GF.prepare(runs, { Href: m.Href, split: m.split, has: m.has, causal: true }), e = [];
    for (const w of P.test) {
        const c = w.c, s = GF.stateAt(m, c.run, w.k0 * c.stride);
        assert.equal(s.i, w.k0 * c.stride); assert.equal(s.stride, c.stride);
        const o = GT.simulate(m.params, c.run, { from: s.i, to: s.i + w.m * c.stride, stride: c.stride, x0: s.x });
        for (let j = 1; j < w.m; j++) if (c.ACT[w.k0 + j]) e.push(100 * (o.hs[j] - c.HS[w.k0 + j]) / c.T[w.k0 + j]);
    }
    const ol = GF.openLoop(m, runs), rmsE = Math.sqrt(e.reduce((s, x) => s + x * x, 0) / e.length);
    assert.equal(e.length, ol.window.hs.n); near(rmsE, ol.window.hs.rms, 0.01 * ol.window.hs.rms, 'the same windows');
    // the causal start reads no sample after the start point: a change of the data after it does not change the state
    const run = runs[2], i = 40000, x = GF.stateAt(m, run, i).x, alt = Object.assign({}, run, { hs: Float32Array.from(run.hs, (v, j) => j > i ? v * 1.1 : v), vbat: Float32Array.from(run.vbat, (v, j) => j > i ? v - 1 : v) });
    const y = GF.stateAt(m, alt, i).x;
    for (const k of ['H', 'd', 'V0', 'hsLog', 'vLog']) assert.equal(y[k], x[k], k);
    assert.notEqual(GF.stateAt(m, alt, i, { causal: false }).x.H, GF.stateAt(m, run, i, { causal: false }).x.H, 'the fit start reads th later');
});

test('every text of TEXT is a string or a function that gives one', () => {
    for (const [k, v] of Object.entries(GF.TEXT)) {
        const s = typeof v === 'function' ? v(1.234, 1.5) : v;
        assert.equal(typeof s, 'string', k); assert.ok(!/;/.test(s), `${k}: no semicolons (STE)`);
    }
});

// the real logs (GOV_FIT_REAL=1): Fireball (voltage, no current) and Gaui X4 II (voltage and current), the full bootstrap
const DATA = path.join(ROOT, 'analysis/governor-20261014/data');
const real = process.env.GOV_FIT_REAL === '1' && fs.existsSync(path.join(DATA, 'gaui', 'meta.json')) && fs.existsSync(path.join(DATA, 'fireball', 'meta.json'));
test('real logs: identification time, open-loop checks, Gaui physical values', { skip: !real && 'set GOV_FIT_REAL=1 (needs analysis/governor-20261014/data)' }, async t => {
    for (const craft of ['fireball', 'gaui']) {
        const runs = GD.load(path.join(DATA, craft)), t0 = Date.now(), m = GF.identify(runs), ms = Date.now() - t0, v = await GF.validate(m, runs, { sim: null });
        const u = (k) => `${m.params[k].toPrecision(4)} (${m.uncertainty[k].p5.toPrecision(4)}-${m.uncertainty[k].p95.toPrecision(4)})`;
        t.diagnostic(`${craft}: ${(m.fit.trainS / 60).toFixed(1)} min training, ${(ms / 1000).toFixed(1)} s; kv ${u('kv')}, tm ${u('tm')}, te ${u('te')}, ass ${u('ass')}, beta ${u('beta')}; ` +
            `open loop: hs median ${v.openLoop.window.hs.medianAbs.toFixed(2)} %, Vbat RMS ${v.openLoop.window.vbat.rms.toFixed(3)} V; polarization ${m.kappa.restOffset.median.toFixed(2)} V`);
        assert.equal(m.status, 'identified'); assert.ok(ms < 60000, `${craft}: ${ms} ms`);
        assert.ok(v.openLoop.window.hs.medianAbs <= GF.RULES.status.hsMedian && v.openLoop.window.vbat.rms <= GF.RULES.status.vbatRms, JSON.stringify(v.openLoop.window));
        if (craft === 'gaui') {
            const ph = m.physical.value;
            t.diagnostic(`Gaui: kv ${m.params.kv.toFixed(1)} rpm/V (research 154.7-157.8), R_m ${(1000 * ph.Rm).toFixed(1)} mOhm (17-22), R0 ${(1000 * ph.R0).toFixed(1)} mOhm (13-18); ` +
                `regression: kv ${m.regression.kvCurrent.toFixed(1)}, R_m ${(1000 * m.regression.Rm).toFixed(1)}, R0 ${(1000 * m.regression.R0).toFixed(1)}; R0/R_m static ${m.regression.betaStatic.toFixed(2)}, output error ${m.params.beta.toFixed(2)}`);
            assert.ok(m.params.kv > 150 && m.params.kv < 165 && ph.R0 > 0.012 && ph.R0 < 0.019 && ph.Rm > 0.015 && ph.Rm < 0.03);
        }
    }
});
