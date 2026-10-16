'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const GT = require('../tools/autotune/gov_twin.cjs');

// Fireball-like (voltage, no current) and Gaui-like (voltage and current) plants
const fb = (o = {}) => GT.copy(GT.copy(GT.defaults({ kv: 290, Href: 4500, V0: 25 }),
    { tm: 0.3, te: 0.1, ass: 640, asr: 0.6, as0: 250, u0: 0.1, sneg: 2, q0: 0.8, qc: 1.5, qx: 0.5, qy: 0.3, qf: 0.2, pc: 2, beta: 0.12, kappa: 0 }), o);
const gaui = (o = {}) => GT.copy(GT.copy(GT.defaults({ kv: 157, Href: 2500, V0: 25, current: true }),
    { tm: 0.15, te: 0.1, ass: 300, asr: 0.45, as0: 130, u0: 0.116, sneg: 3, q0: 0.6, qc: 1.2, qx: 0.4, qy: 0.5, qf: 0.15, pc: 1.8, beta: 0.85, kappa: 0.025, rm: 0.018, i0: 1.2 }), o);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (tol ${tol})`);
function run(n, rate, f) { // f(i, t) -> {u, coll, roll, pitch, yaw, hs, vbat, ibat}
    const r = { n, rate }, keys = ['u', 'coll', 'roll', 'pitch', 'yaw', 'hs', 'vbat', 'ibat'];
    for (const k of keys) r[k] = new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = f(i, i / rate); for (const k of keys) r[k][i] = v[k] != null ? v[k] : 0; }
    return r;
}
const wavy = (i, t) => ({ u: 0.6 + 0.2 * Math.sin(1.3 * t) + 0.05 * Math.sin(17 * t), coll: 0.4 * Math.sin(0.7 * t) + 0.1 * Math.sin(9 * t),
    roll: 0.1 * Math.sin(2.1 * t), pitch: 0.08 * Math.cos(1.7 * t), yaw: 0.15 * Math.sin(5 * t), hs: 4000, vbat: 24, ibat: 30 });

// first, before the other tests make the property loads of step() polymorphic (the app uses one shape per run)
test('benchmark: step cost', t => {
    const p = gaui(), x = GT.initState(p, { hs: 2400, u: 0.7, vbat: 24, ibat: 30 }), inp = { u: 0.7, coll: 0, cyc: 0.1, yaw: 0.1 };
    const N = 2e6, bench = q => {
        for (let i = 0; i < 2e5; i++) { inp.u = 0.7 + 0.1 * ((i & 255) / 255); GT.step(x, inp, q, 0.0005); }
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < N; i++) { inp.u = 0.7 + 0.1 * ((i & 255) / 255); inp.coll = (i & 1023) / 1024 - 0.5; GT.step(x, inp, q, 0.0005); }
        return Number(process.hrtime.bigint() - t0) / N;
    };
    const nsI = bench(p), nsV = bench(GT.copy(p, { current: false }));
    t.diagnostic(`gov_twin.step: ${nsI.toFixed(1)} ns/step with current, ${nsV.toFixed(1)} ns/step without (${N} steps)`);
    assert.ok(Number.isFinite(x.H) && nsI < 2000 && nsV < 2000);
    const r = run(200000, 1000, wavy), t0 = process.hrtime.bigint(); GT.simulate(p, r, { stride: 10 });
    t.diagnostic(`gov_twin.simulate: 200 s of 1-kHz data at 100 Hz in ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)} ms`);
});

test('parameter table, needs filter and fit-space round trip', () => {
    assert.deepEqual(GT.paramNames({}), ['kv', 'tm', 'te', 'ass', 'asr', 'as0', 'as1', 'u0', 'sneg', 'q0', 'qc', 'qx', 'qy', 'qf', 'qs', 'pc', 'c0', 'th']);
    assert.deepEqual(GT.paramNames({ voltage: true }).slice(18), ['beta', 'kappa', 'tv', 'vp']);
    assert.deepEqual(GT.paramNames({ voltage: true, current: true }).slice(18), ['beta', 'kappa', 'tv', 'vp', 'rm', 'i0', 'ti']);
    // current without voltage is not used: with V0 = 1 only R_m/V would be identifiable, not R_m in ohms
    assert.deepEqual(GT.paramNames({ current: true }), GT.paramNames({}));
    assert.equal(GT.defaults({ kv: 7000, Href: 4500, current: true }).current, false);
    assert.equal(GT.copy(GT.defaults({ kv: 7000, Href: 4500 }), { current: true }).current, false);
    for (const q of GT.PARAMS) {
        assert.ok(q.lo < q.hi && ['log', 'lin'].includes(q.scale) && (q.scale === 'lin' || q.lo > 0), q.name);
        if (/^t[mehvi]$/.test(q.name)) assert.equal(q.lo, GT.RULES.minTau, q.name);
    }
    const p = gaui(), names = GT.paramNames({ voltage: true, current: true }), z = GT.encode(p, names), p2 = GT.decode(z, names, p);
    for (const k of names) near(p2[k], p[k], 1e-12 * Math.abs(p[k]), k);
    assert.equal(p2.Href, p.Href); assert.notEqual(p2, p);
    near(z[0], Math.log(157), 1e-12);
    assert.throws(() => GT.defaults({ Href: 2500 }));
    const d = GT.defaults({ kv: 157, Href: 2500, V0: 25 });
    for (const q of GT.PARAMS) assert.ok(d[q.name] >= q.lo && d[q.name] <= q.hi, `default ${q.name} in range`);
});

test('steady state of a long simulation equals steady() and maxHeadspeed()', () => {
    const p = fb(), L = { coll: 0.5, cyc: 0.1, yaw: 0.2 };
    const r = run(30000, 1000, () => ({ u: 0.75, coll: 0.5, roll: 0.06, pitch: 0.08, yaw: -0.2, hs: 4000, vbat: 23.5 }));
    const o = GT.simulate(p, r), x = o.x;
    const st = GT.steady(p, Object.assign({ H: x.H, ocv: x.V0 }, L));
    near(st.d, 0.75, 1e-6, 'duty'); near(st.V, x.V, 1e-5, 'V'); near(st.s, x.s, 1e-5, 's'); near(st.sL, x.sL, 1e-5, 'sL');
    near(x.s, x.sL, 1e-6, 'torque balance'); assert.ok(st.feasible); near(st.headroom, 0.25, 1e-6);
    near(GT.maxHeadspeed(p, L, x.V0, 0.25), x.H, 1e-6 * x.H, 'maxHeadspeed');
    near(o.hs[o.hs.length - 1], x.H, 1e-3, 'sensor at rest');
    // the 100-Hz fit rate gives the same steady state
    const o10 = GT.simulate(p, r, { stride: 10 });
    assert.equal(o10.hs.length, 3000); near(o10.x.H, x.H, 1e-6 * x.H, '100 Hz');
    // above the power limit: virtual duty > 1, negative headroom
    const hi = GT.steady(p, { H: 6500, coll: 1, ocv: 22 });
    assert.ok(!hi.feasible && hi.d > 1 && hi.headroom < 0, JSON.stringify(hi));
    assert.equal(GT.steady(p, { H: 0 }).d, 0);
});

test('battery algebra: V = OCV - beta*d*s and s = d*V - H/kv at the state after every step (with coast and the regenerative limit)', () => {
    const p = gaui(), seen = { coast: 0, regen: 0, drive: 0 };
    const x = GT.initState(p, { hs: 2400, u: 0.7, vbat: 23, ibat: 40 }), inp = { u: 0, coll: 0, cyc: 0, yaw: 0 };
    near(x.V, 23, 1e-9, 'V(t0) = vbat(t0)');
    for (let i = 0; i < 20000; i++) {
        const t = i / 1000;
        inp.u = t < 4 ? 0.7 + 0.25 * Math.sin(3 * t) : t < 6 ? 0.1 : t < 10 ? 0 : t < 12 ? 0.8 : 0.5 + 0.4 * Math.sin(2 * t);
        inp.coll = 0.5 * Math.sin(1.1 * t); inp.cyc = 0.1; inp.yaw = 0.2 * Math.sin(4 * t);
        GT.step(x, inp, p, 0.001);
        const ocv = Math.max(x.V0 - p.kappa * x.Q, 0), e = x.H / p.kv;
        near(x.V, ocv - p.beta * x.d * x.s, 1e-9, `V at ${t}`);
        if (x.d < GT.RULES.dOff) { assert.ok(x.s === 0 || x.soft && x.s > 0, `no brake torque under dOff at ${t}: ${x.s}`); if (x.s === 0) assert.equal(x.V, ocv); seen.coast++; }
        else if (x.s === -p.sneg) { assert.ok(x.d * x.V - e <= -p.sneg + 1e-9); seen.regen++; }
        else { near(x.s, x.d * x.V - e, 1e-9, `s at ${t}`); seen.drive++; }
    }
    assert.ok(seen.coast > 100 && seen.regen > 10 && seen.drive > 1000, JSON.stringify(seen));
});

test('soft start from standstill: the ESC waits for u0, then holds the rotor on the speed ramp of ramp(); it ends at softEnd of the no-load speed', () => {
    const p = fb({ q0: 0.1, qc: 0, qx: 0, qy: 0, qf: 0.05 }), dt = 0.001, inp = { u: 0, coll: 0, cyc: 0, yaw: 0 };
    // ramp(): max(h, as0), exponential at asr up to the rate ass (at ass/asr rpm), then linear at ass
    const lk = p.ass / p.asr, t1 = Math.log(lk / p.as0) / p.asr;
    assert.equal(GT.ramp(p, 0, 0), p.as0); assert.equal(GT.ramp(p, 0, 900), 900);
    near(GT.ramp(p, 1, 0), p.as0 * Math.exp(p.asr), 1e-9); near(GT.ramp(p, t1 + 2, 0), lk + 2 * p.ass, 1e-9);
    near(GT.ramp(p, 2, 3000), 3000 + 2 * p.ass, 1e-9, 'linear above ass/asr');
    near(GT.ramp(GT.copy(p, { as0: 0 }), 2, 0), 2 * p.ass, 1e-9, 'linear from 0 without as0 and as1');
    // the rate as1 + asr·lim (Gaui: 112 + 0.187·H rpm/s): an exponential with the offset as1/asr, up to the rate ass
    const g = GT.copy(p, { as0: 100, as1: 112, asr: 0.187, ass: 450 }), c = 112 / 0.187, gk = (450 - 112) / 0.187, g1 = Math.log((gk + c) / (100 + c)) / 0.187;
    near(GT.ramp(g, 3, 0), (100 + c) * Math.exp(0.187 * 3) - c, 1e-9); near(GT.ramp(g, g1 + 1, 0), gk + 450, 1e-9);
    const rate = (q, a) => (GT.ramp(q, a + 1e-4, 0) - GT.ramp(q, a - 1e-4, 0)) / 2e-4;
    near(rate(g, 2), 112 + 0.187 * GT.ramp(g, 2, 0), 1e-3, 'rate at 2 s'); near(rate(g, g1 + 2), 450, 1e-3, 'rate at the cap');
    near(rate(GT.copy(g, { as0: 0 }), 1), 112 + 0.187 * GT.ramp(GT.copy(g, { as0: 0 }), 1, 0), 1e-3, 'as1 > 0 starts the ramp from 0');
    // step() follows ramp() with as1
    const xg = GT.initState(g, { hs: 0, u: 1, vbat: 25, stopped: true }), ig = { u: 1, coll: 0, cyc: 0, yaw: 0 };
    GT.step(xg, ig, g, dt); for (let i = 1; i < 4000; i++) GT.step(xg, ig, g, dt);
    near(xg.lim, GT.ramp(g, 4, 0), 1e-6 * xg.lim, 'step() with as1');
    // an 8-s RF spool-up (0.125/s) from rest: the motor starts at u0, then the rotor is on the ramp
    const x = GT.initState(p, { hs: 0, u: 0, vbat: 25, stopped: true });
    assert.equal(x.soft, 1); assert.equal(x.lim, -1);
    let iOn = -1, tEnd = null, hEnd = 0;
    for (let i = 1; i <= 15000; i++) {
        const t = i * dt; inp.u = Math.min(1, 0.125 * t); GT.step(x, inp, p, dt);
        if (iOn < 0 && x.lim >= 0) iOn = i;
        if (iOn < 0) { assert.equal(x.H, 0); assert.equal(x.d, 0); continue; }
        if (x.soft) {
            const lim = GT.ramp(p, (i - iOn + 1) * dt, 0);
            near(x.lim, lim, 1e-9 * lim, `the ramp at ${t}`); assert.ok(x.H <= x.lim + 1e-9, `the rotor under the ramp at ${t}`);
            if ([3000, 5000, 7000, 9000].includes(i)) near(x.H / lim, 1, 0.01, `the rotor on the ramp at ${t}`);
        } else if (tEnd === null) { tEnd = t; hEnd = x.H; }
    }
    near(iOn * dt, p.u0 / 0.125, 1.5 * dt, 'motor start at u0');
    // the end: at softEnd of the no-load speed kv·1·OCV (the ramp reaches it at about 10 s)
    const tWant = iOn * dt + t1 + (GT.RULES.softEnd * p.kv * 25 - lk) / p.ass;
    near(tEnd, tWant, 0.02, 'end of the soft start'); assert.ok(hEnd >= GT.RULES.softEnd * p.kv * 25 * 0.999, `${hEnd}`);
    // a fast ESC ramp: the same command gives the speed of the duty (no limit), and the soft start ends early
    const pf = GT.copy(p, { ass: 20000, asr: 20, as0: 0 }), y = GT.initState(pf, { hs: 0, u: 0, vbat: 25, stopped: true });
    let yEnd = null;
    for (let i = 1; i <= 4000; i++) { inp.u = Math.min(1, 0.125 * i * dt); GT.step(y, inp, pf, dt); if (yEnd === null && !y.soft) yEnd = i * dt; }
    assert.ok(yEnd !== null && yEnd < 2, `end ${yEnd}`);
    // at 4 s the rotor follows the duty ramp with the lags te and tm: duty = 0.5 - 0.125·(te + tm)
    const st = GT.steady(pf, { H: y.H, coll: 0, ocv: 25 }); near(st.d, 0.5 - 0.125 * (pf.te + pf.tm), 0.005, 'the rotor follows the duty');
});

test('soft start armed again after a throttle cut of softOffS (Fireball log 10 bailout and log 8 restart), not after a short cut', () => {
    const p = fb(), dt = 0.001, inp = { u: 0, coll: 0, cyc: 0, yaw: 0 }, off = GT.RULES.softOffS;
    assert.ok(off > 0 && off <= 1.83, 'log 8: a 1.83-s cut gave a soft start');
    // log 10: u = 0 for 2.0 s from 559 rpm, then the BAILOUT ramp at 50 %/s to 1
    const x = GT.initState(p, { hs: 559, u: 0.023, vbat: 25, stopped: false });
    let tArm = null, hArm = 0;
    for (let i = 1; i <= 2000; i++) { GT.step(x, inp, p, dt); if (tArm === null && x.soft) { tArm = i * dt; hArm = x.H; } }
    near(tArm, off, 1.5 * dt, 'armed after softOffS'); assert.ok(hArm > 2 * GT.RULES.softHs * p.Href, `rotor at ${hArm} rpm when armed`);
    assert.equal(x.soft, 1, 'armed at the restart'); assert.equal(x.lim, -1);
    let iOn = -1, hOn = 0; const hs = [];
    for (let i = 1; i <= 9000; i++) {
        inp.u = Math.min(0.5 * i * dt, 1); const h0 = x.H; GT.step(x, inp, p, dt);
        if (iOn < 0 && x.lim >= 0) { iOn = i; hOn = h0; }
        if (iOn > 0 && x.soft) near(x.lim, GT.ramp(p, (i - iOn + 1) * dt, hOn), 1e-6 * x.lim, `the ramp from the rotor speed at ${i}`);
        if (i % 1000 === 0) hs.push(x.H);
    }
    near(iOn * dt, p.u0 / 0.5, 1.5 * dt, 'the motor starts at u0');
    const slope = (hs[7] - hs[3]) / 4;
    near(slope / p.ass, 1, 0.02, `restart slope ${slope.toFixed(0)} rpm/s, ass ${p.ass}`);
    assert.ok(hs[3] < hOn + 4 * p.ass, `4 s after the restart the rotor is under the ramp: ${hs[3].toFixed(0)} rpm`);
    // log 8: a 1.83-s cut from 4441 rpm; the ESC starts again with the soft start at a high rotor speed
    const y = GT.initState(p, { hs: 4441, u: 0.79, vbat: 22.1 });
    inp.u = 0; for (let i = 0; i < 1830; i++) GT.step(y, inp, p, dt);
    assert.equal(y.soft, 1); assert.ok(y.H > 0.2 * p.Href, `${y.H}`);
    // the restart: at u0 the rotor is above softEnd of the no-load speed, and the ESC keeps the ramp from the rotor speed (soft 1, then 2
    // when the command passes it); the soft start ends when the rotor reaches the end speed from under it
    let yOn = -1, y2 = -1, yEnd = -1;
    for (let i = 1; i <= 8000; i++) {
        inp.u = Math.min(0.5 * i * dt, 0.8); const h0 = y.H; GT.step(y, inp, p, dt);
        if (yOn < 0 && y.lim >= 0) { yOn = i; assert.ok(h0 >= GT.RULES.softEnd * p.kv * 22.1 * inp.u, `above the end speed at the start: ${h0}`); assert.equal(y.soft, 1); }
        if (y2 < 0 && y.soft === 2) y2 = i;
        if (yEnd < 0 && yOn > 0 && !y.soft) yEnd = i;
    }
    assert.ok(yOn > 0 && y2 > yOn && yEnd > y2, `start ${yOn}, below ${y2}, end ${yEnd}`);
    assert.ok(y.H >= GT.RULES.softEnd * p.kv * 0.8 * 21, `the end at the end speed: ${y.H}`);
    // a cut shorter than softOffS: the duty follows the command again with the lag te
    const z = GT.initState(p, { hs: 4000, u: 0.7, vbat: 24 });
    for (let i = 1; i <= 1500; i++) { inp.u = i * dt < 0.8 * off ? 0 : 0.7; GT.step(z, inp, p, dt); assert.equal(z.soft, 0); }
    assert.ok(z.d > 0.6, `${z.d}`);
    // a second cut after a soft start counts its own off time
    const v = GT.initState(p, { hs: 0, u: 0, vbat: 25, stopped: true });
    for (let i = 1; i <= 15000; i++) { inp.u = i * dt < 12 ? 1 : 0; GT.step(v, inp, p, dt); if (i * dt > 12 && i * dt < 12 + off - 0.01) assert.equal(v.soft, 0, `t ${i * dt}`); }
    assert.equal(v.soft, 1);
});

test('a cut of softOffS inside an unfinished soft start arms it again as from ACTIVE (soft 1): the restart keeps the ramp', () => {
    // an aborted spool-up (6 s at u 0.9 on the ramp, soft 2), a 1.5-s cut, then a governor-like ramp 0.12 -> 0.9 in 4 s (the Fireball twin)
    const p = GT.copy(GT.defaults({ kv: 317, Href: 4500, V0: 23 }), { ass: 676, asr: 0.226, as0: 187, as1: 262, u0: 0.108, tm: 0.38, te: 0.057 }), dt = 0.001, inp = { u: 0.9, coll: 0, cyc: 0, yaw: 0 };
    const x = GT.initState(p, { hs: 0, u: 0, vbat: 23, stopped: true });
    for (let i = 0; i < 6000; i++) GT.step(x, inp, p, dt);
    assert.equal(x.soft, 2, 'under the end speed in the soft start'); assert.ok(x.H > 2000 && x.H < 0.75 * p.kv * 0.9 * 23, `${x.H}`);
    inp.u = 0; for (let i = 0; i < 1500; i++) GT.step(x, inp, p, dt);
    assert.equal(x.soft, 1, 'armed again: soft 1'); assert.equal(x.lim, -1);
    // the same state with the flag of a re-arm from ACTIVE gives the same restart: the ramp from the rotor speed, then the end from under it
    const y = GT.clone(x); y.soft = 1;
    let on = -1, h0 = 0;
    for (let i = 0; i < 8000; i++) {
        inp.u = Math.min(0.9, 0.12 + 0.78 * i / 4000); const h = x.H;
        GT.step(x, inp, p, dt); GT.step(y, inp, p, dt);
        assert.equal(x.H, y.H);
        if (on < 0 && x.lim >= 0) { on = i; h0 = h; }
        if (on >= 0 && i - on < 1000) assert.ok(x.soft > 0 && x.H <= GT.ramp(p, (i - on + 1) * dt, h0) + 1e-6, `on the ramp ${i - on} ms after the restart`);
    }
    assert.ok(on === 0, 'the ESC starts again at once: u 0.12 > u0');
});

test('a start from rest (rest: true) puts the OCV at the rest voltage less vp; vp has no effect in flight', () => {
    const p = fb({ vp: 0.3 }), x = GT.initState(p, { hs: 0, u: 0, vbat: 25, stopped: true, rest: true });
    near(x.V0, 24.7, 1e-12); near(x.V, 24.7, 1e-12); assert.equal(x.vLog, 25, 'the sensor starts at the measured value');
    const y = GT.initState(p, { hs: 4000, u: 0.7, vbat: 23 }), z = GT.initState(fb(), { hs: 4000, u: 0.7, vbat: 23 });
    assert.equal(y.V0, z.V0); assert.equal(GT.defaults({ kv: 290, Href: 4500, V0: 25 }).vp, 0); assert.equal(GT.copy(p).vp, 0.3);
});

test('start inside a soft start: the ramp from rest or from the rotor speed, the duty from the measured acceleration', t => {
    const dt = 0.001, inp = { u: 0.3, coll: 0, cyc: 0, yaw: 0 };
    // from rest with the command already above u0 (the frames after the arm): duty 0, OCV = vbat, the ramp from as0
    for (const p of [fb(), gaui()]) for (const stopped of [true, undefined]) {
        const x = GT.initState(p, { hs: 0, u: 0.3, vbat: 24, stopped });
        assert.equal(x.soft, 1); assert.equal(x.d, 0); assert.equal(x.V0, 24); assert.equal(x.V, 24); assert.equal(x.lim, -1);
        for (let i = 0; i < 1000; i++) GT.step(x, inp, p, dt);
        assert.equal(x.soft, 2, 'in the soft start, under the end speed'); near(x.lim, GT.ramp(p, 1, 0), 1e-9 * x.lim, 'one second of ramp'); near(x.H / x.lim, 1, 0.02, 'the rotor on the ramp');
    }
    // a start with the rotor turning: lim from the rotor speed (or o.lim)
    const p0 = fb(), w = GT.initState(p0, { hs: 1500, u: 1, vbat: 25, stopped: true });
    assert.equal(w.lim, 1500); assert.equal(GT.initState(p0, { hs: 1500, u: 1, vbat: 25, stopped: true, lim: 1800 }).lim, 1800);
    assert.equal(GT.initState(p0, { hs: 1500, u: 1, vbat: 25, stopped: true, lim: -1 }).lim, -1);
    // a window that starts in the middle of a soft start: simulate() takes the hs slope at `from`
    const p = fb({ tm: 0.8 }), N = 15000, rec = { n: N, rate: 1000, u: new Float32Array(N).fill(1), hs: new Float32Array(N), vbat: new Float32Array(N), ibat: null,
        coll: new Float32Array(N).fill(-0.2), roll: null, pitch: null, yaw: null };
    const x = GT.initState(p, { hs: 0, u: 1, vbat: 25, stopped: true });
    for (let i = 0; i < N; i++) { rec.hs[i] = x.hsLog; rec.vbat[i] = x.vLog; GT.step(x, { u: 1, coll: -0.2, cyc: 0, yaw: 0 }, p, dt); }
    const from = 5000, err = o => { let m = 0; for (let k = 0; k < o.hs.length; k++) m = Math.max(m, Math.abs(o.hs[k] - rec.hs[from + 10 * k])); return m / p.Href; };
    const auto = GT.simulate(p, rec, { from, to: from + 5000, stride: 10, stopped: true });
    const flat = GT.simulate(p, rec, { from, to: from + 5000, stride: 10, stopped: true, accel: 0 });
    t.diagnostic(`start at 5 s of a soft start, 5-s window, worst hs error: ${(100 * err(auto)).toFixed(3)} % of Href with the hs slope, ${(100 * err(flat)).toFixed(3)} % with the steady duty`);
    assert.ok(err(auto) < 0.01, `with the acceleration: ${(100 * err(auto)).toFixed(2)} % of Href`);
    // the ramp holds the rotor, so a wrong start duty is corrected within te: both starts agree
    assert.ok(err(flat) < 0.01, `steady duty: ${(100 * err(flat)).toFixed(2)} % of Href`);
    near(auto.vbat[0], rec.vbat[from], 1e-4, 'V(t0) = vbat(t0)');
});

test('coast below dOff has no brake torque; the regenerative limit clamps the slip voltage', () => {
    const dt = 0.001, inp = { u: 0, coll: 0.3, cyc: 0, yaw: 0 };
    // no load and no regeneration: once the duty is under dOff the rotor speed stays constant
    const p0 = fb({ q0: 0, qc: 0, qx: 0, qy: 0, qf: 0, sneg: 0 }), x0 = GT.initState(p0, { hs: 4000, u: 0.7, vbat: 24 });
    let coastSteps = 0, rise = 0;
    for (let i = 0; i < 3000; i++) {
        const H = x0.H, d0 = x0.d; GT.step(x0, inp, p0, dt);
        if (x0.d < GT.RULES.dOff) assert.equal(x0.s, 0);
        if (d0 < GT.RULES.dOff && x0.d < GT.RULES.dOff) { assert.equal(x0.H, H); coastSteps++; }
        assert.ok(x0.H >= H, 'no brake torque with sneg = 0');
        if (x0.H > H) rise++; // only while d·V > H/kv at the start of the cut
    }
    assert.ok(coastSteps > 1000 && rise > 0 && rise < 200, `${coastSteps} ${rise}`);
    // with load: the deceleration in the coast is the load alone (with the constant load qs while the rotor turns)
    const p = fb({ qs: 0.3 }), x = GT.initState(p, { hs: 4000, u: 0.01, vbat: 24, stopped: false });
    const H = x.H; GT.step(x, inp, p, dt);
    near((H - x.H) / dt, p.kv / p.tm * GT.load(p, H, 0.3, 0, 0), 0.002 * (H - x.H) / dt, 'coast deceleration');
    near(GT.load(p, H, 0.3, 0, 0) - GT.load(fb(), H, 0.3, 0, 0), 0.3, 1e-12, 'qs'); assert.equal(GT.load(p, 0, 0.3, 0, 0), 0, 'no load at rest');
    // a coast to rest with qs: the rotor stops and stays at 0
    const xs = GT.initState(p, { hs: 300, u: 0, vbat: 24, stopped: false });
    for (let i = 0; i < 5000; i++) GT.step(xs, { u: 0, coll: 0, cyc: 0, yaw: 0 }, p, dt);
    assert.equal(xs.H, 0); assert.ok(Number.isFinite(xs.hsLog) && xs.hsLog < 1);
    // a throttle cut to 0.3 at 4000 rpm: d*V - e is far under -sneg, so s = -sneg exactly
    const decel = sneg => {
        const q = fb({ sneg }), y = GT.initState(q, { hs: 4000, u: 0.3, vbat: 24, stopped: false }), h = y.H;
        GT.step(y, { u: 0.3, coll: 0.3, cyc: 0, yaw: 0 }, q, dt);
        return { s: y.s, rate: (h - y.H) / dt, sL: y.sL, q };
    };
    const a = decel(0), b = decel(2), c = decel(50);
    assert.equal(a.s, 0); assert.equal(b.s, -2);
    assert.ok(c.s < -2 && c.s > -50, `unclamped ${c.s}`);
    assert.ok(a.rate < b.rate && b.rate < c.rate, `${a.rate} < ${b.rate} < ${c.rate}`);
    near(b.rate, b.q.kv / b.q.tm * (2 + b.sL), 0.002 * b.rate, 'regenerative deceleration');
});

test('no-voltage mode: constant V0 = 1, kv per throttle unit, no battery outputs', () => {
    const p = GT.copy(GT.defaults({ kv: 7000, Href: 4500 }), { q0: 0.03, qc: 0.06, qf: 0.01 });
    assert.equal(p.voltage, false); assert.equal(p.V0, 1); assert.equal(p.beta, 0); assert.equal(p.kappa, 0);
    const o = GT.simulate(p, run(5000, 1000, wavy));
    assert.equal(o.vbat, null); assert.equal(o.ibat, null);
    assert.equal(o.x.V, 1); assert.equal(o.x.V0, 1, 'the logged voltage is not used');
    const out = GT.outputs(o.x, p); assert.equal(out.vbat, null); assert.equal(out.ibat, null); assert.equal(out.I, null);
    // steady: d·1 - H/kv = sL, closed form
    const st = GT.steady(p, { H: 4000, coll: 0.5 });
    near(st.d, 4000 / 7000 + GT.load(p, 4000, 0.5, 0, 0), 1e-12, 'closed-form duty');
    assert.equal(GT.physical(p), null);
    assert.equal(GT.steady(p, { H: 4000, coll: 0.5, ocv: 22 }).d, st.d, 'an OCV has no effect without voltage');
    assert.equal(GT.maxHeadspeed(p, { coll: 0.5 }, 22, 0.2), GT.maxHeadspeed(p, { coll: 0.5 }, undefined, 0.2));
    // a stale beta in a no-voltage parameter set has no effect
    const o2 = GT.simulate(GT.copy(p, { beta: 2, kappa: 0.5 }), run(5000, 1000, wavy));
    assert.deepEqual(o2.hs, o.hs);
});

test('maxHeadspeed rises with OCV and falls with load; steady() at that speed needs 1 - headroom', () => {
    const p = fb(), L = { coll: 0.6, cyc: 0.1, yaw: 0.1 };
    const byOcv = [20, 22, 25].map(v => GT.maxHeadspeed(p, L, v, 0.15));
    assert.ok(byOcv[0] < byOcv[1] && byOcv[1] < byOcv[2], byOcv.join(' '));
    const byLoad = [0, 0.4, 0.8, 1.2].map(c => GT.maxHeadspeed(p, { coll: c, cyc: 0.1, yaw: 0.1 }, 22, 0.15));
    for (let i = 1; i < byLoad.length; i++) assert.ok(byLoad[i] < byLoad[i - 1], byLoad.join(' '));
    assert.ok(GT.maxHeadspeed(p, L, 22, 0) > GT.maxHeadspeed(p, L, 22, 0.15));
    const H = byOcv[1], st = GT.steady(p, Object.assign({ H, ocv: 22 }, L));
    near(st.d, 0.85, 1e-7, 'duty at the maximum'); near(st.headroom, 0.15, 1e-7);
    // the same with a current-recording parameter set
    const g = gaui(); near(GT.steady(g, { H: GT.maxHeadspeed(g, L, 24, 0.2), ocv: 24, coll: 0.6, cyc: 0.1, yaw: 0.1 }).d, 0.8, 1e-7);
    assert.equal(GT.maxHeadspeed(p, L, 22, 0.995), 0);
    // also with large beta, where the largest slip limits the speed (beta 5, collective 3: steady() is Infinity above it)
    for (const [beta, coll] of [[0.12, 0.6], [0.12, 1.6], [0.85, 0.6], [0.85, 1.6], [3, 1.6], [5, 0.6], [5, 3]]) {
        const q = gaui({ beta }), ld = { coll, cyc: 0.1, yaw: 0.1 }, Hm = GT.maxHeadspeed(q, ld, 24, 0.05);
        assert.ok(Hm > 0 && GT.steady(q, Object.assign({ H: Hm, ocv: 24 }, ld)).d <= 0.95 + 1e-6, `beta ${beta} coll ${coll}`);
        assert.ok(GT.steady(q, Object.assign({ H: 1.001 * Hm, ocv: 24 }, ld)).d > 0.95, `beta ${beta} coll ${coll}: ${Hm} is the highest`);
    }
});

test('steady(): the smallest duty that meets the load when the slip falls above its peak (beta*d^2 > 1); Infinity above the peak', () => {
    const scan = (p, o) => { const e = o.H / p.kv, sL = GT.load(p, o.H, o.coll, o.cyc, o.yaw); for (let d = 0; d <= 4; d += 1e-5) if (GT.slip(d, o.ocv, e, p.beta, p.sneg) >= sL) return d; return Infinity; };
    for (const [beta, o, want] of [[0.85, { H: 2500, ocv: 24, coll: 2.2 }, 1.1858], [0.85, { H: 3800, ocv: 24, coll: 1, cyc: 0.2, yaw: 0.3 }, 1.742],
        [0.5, { H: 4050, ocv: 20, coll: 1.15, cyc: 0.1, yaw: 0.1 }, 2.744]]) {
        const p = gaui({ beta }), st = GT.steady(p, o), d = scan(p, o);
        near(d, want, 1e-3, 'the first crossing of the scan'); assert.ok(GT.slip(GT.RULES.dExtend, o.ocv, o.H / p.kv, beta, p.sneg) < st.sL, 'slip(dExtend) is under the load');
        near(st.d, d, 2e-5, `beta ${beta}`); near(st.headroom, 1 - d, 2e-5); assert.equal(st.feasible, false);
        near(GT.slip(st.d, o.ocv, o.H / p.kv, beta, p.sneg), st.sL, 1e-9, 'slip at d = load');
    }
    const p = gaui({ beta: 0.85 }), st = GT.steady(p, { H: 2500, ocv: 24, coll: 4 });
    assert.equal(st.d, Infinity); assert.equal(st.headroom, -Infinity); assert.equal(st.feasible, false);
    near(st.s, GT.slip(1, 24, 2500 / p.kv, 0.85, p.sneg), 1e-12, 's at d = 1');
});

test('simulate() equals a manual step loop (PID rate and fit rate with block means)', () => {
    const p = gaui({ Href: 4500, kv: 290 }), r = run(4000, 1000, wavy);
    const o = GT.simulate(p, r, { from: 100, to: 3900 });
    const x = GT.initState(p, { hs: r.hs[100], u: r.u[100], vbat: r.vbat[100], ibat: r.ibat[100] }), inp = { u: 0, coll: 0, cyc: 0, yaw: 0 };
    for (let i = 100, k = 0; i < 3900; i++, k++) {
        assert.equal(o.hs[k], x.hsLog); assert.equal(o.vbat[k], x.vLog); assert.equal(o.ibat[k], x.iLog); assert.equal(o.d[k], x.d);
        Object.assign(inp, { u: r.u[i], coll: Math.abs(r.coll[i]), cyc: Math.sqrt(r.roll[i] ** 2 + r.pitch[i] ** 2), yaw: Math.abs(r.yaw[i]) });
        GT.step(x, inp, p, 0.001);
    }
    assert.equal(o.hs.length, 3800); assert.equal(o.x.H, x.H);
    // stride 10 with a partial last block and a start state
    const x0 = GT.initState(p, { hs: 3900, u: 0.6, vbat: 24.5, stopped: false });
    const o10 = GT.simulate(p, r, { from: 5, to: 3998, stride: 10, x0 });
    assert.equal(x0.Q, 0, 'x0 is not changed');
    const y = GT.clone(x0), mean = (a, i, j, f) => { let s = 0; for (let k = i; k < j; k++) s += f(a, k); return s / (j - i); };
    for (let i = 5, k = 0; i < 3998; i += 10, k++) {
        near(o10.hs[k], y.hsLog, 1e-9 * y.hsLog);
        const j = Math.min(i + 10, 3998);
        GT.step(y, { u: mean(r.u, i, j, (a, k2) => a[k2]), coll: mean(r.coll, i, j, (a, k2) => Math.abs(a[k2])),
            cyc: mean(r.roll, i, j, (a, k2) => Math.hypot(a[k2], r.pitch[k2])), yaw: mean(r.yaw, i, j, (a, k2) => Math.abs(a[k2])) }, p, (j - i) / 1000);
    }
    assert.equal(o10.hs.length, 400); near(o10.x.H, y.H, 1e-9 * y.H, 'x is the state at `to` (partial last block of 3 samples)');
    // constant inputs: the state at `to` does not depend on the stride
    const flat = run(200, 1000, () => ({ u: 0.8, coll: 0.3, hs: 3000, vbat: 24, ibat: 30 })), xs = s => GT.simulate(p, flat, { to: 101, stride: s }).x.H;
    near(xs(10), xs(1), 1e-3 * xs(1), 'to 101, stride 10 against stride 1'); assert.ok(Math.abs(GT.simulate(p, flat, { to: 110, stride: 10 }).x.H - xs(10)) > 1, 'to 110 is later');
    // fit rate against PID rate on smooth inputs: the same trajectory within 0.05 % of the speed
    const o1 = GT.simulate(p, r, { from: 5, to: 3998, x0 });
    let worst = 0; for (let k = 0; k < 400; k++) worst = Math.max(worst, Math.abs(o10.hs[k] - o1.hs[k * 10]) / o1.hs[k * 10]);
    assert.ok(worst < 0.0005, `100 Hz against 1 kHz: ${(100 * worst).toFixed(4)} %`);
    // missing mixer channels are zero load inputs
    const bare = { n: r.n, rate: r.rate, hs: r.hs, u: r.u, vbat: null, ibat: null, coll: null, roll: null, pitch: null, yaw: null };
    const ob = GT.simulate(fb(), bare, { stride: 10 });
    assert.ok(ob.hs.every(Number.isFinite) && ob.vbat.every(Number.isFinite));
});

test('physical values with current: R0 = beta*rm, dOCV/dQ[Ah] = kappa*rm*3600, J from tm', () => {
    const p = gaui(), ph = GT.physical(p), Ke = 60 / (2 * Math.PI * p.kv);
    near(ph.Rm, 0.018, 1e-15); near(ph.R0, 0.85 * 0.018, 1e-15); near(ph.dOcvPerAh, 0.025 * 0.018 * 3600, 1e-12);
    near(ph.Ke, Ke, 1e-15); near(ph.J, p.tm * Ke * Ke / p.rm, 1e-15);
    near(GT.physical(p, 10).J, ph.J / 100, 1e-15, 'motor-shaft inertia with a 10:1 gear');
    assert.equal(GT.physical(fb()), null, 'no J without current');
    // the twin agrees with the SI equations: sag = R0·(I - i0), OCV drop = dOCV/dAh · Ah, J·dω/dt = Kt·I_m - Q_load
    const x = GT.initState(p, { hs: 2400, u: 0.75, vbat: 24 }), dt = 0.001, inp = { u: 0, coll: 0, cyc: 0.1, yaw: 0.1 };
    let ah = 0, prevI = x.I;
    for (let i = 0; i < 60000; i++) {
        inp.u = 0.75 + 0.15 * Math.sin(i * dt * 2); inp.coll = 0.6 * Math.sin(i * dt * 0.9);
        GT.step(x, inp, p, dt);
        near(x.V0 - p.kappa * x.Q - x.V, ph.R0 * (x.I - p.i0), 1e-9, 'sag');
        ah += (prevI + x.I - 2 * p.i0) / 2 * dt / 3600; prevI = x.I;
    }
    const Im = x.s / p.rm, Qload = ph.Kt * x.sL / p.rm, rpmDot = (Im * ph.Kt - Qload) / ph.J * 30 / Math.PI;
    near(rpmDot, p.kv / p.tm * (x.s - x.sL), 1e-9 * Math.abs(rpmDot), 'torque balance in SI units');
    near(p.kappa * x.Q, ph.dOcvPerAh * ah, 1e-4 * ph.dOcvPerAh * ah, 'OCV drop');
    assert.ok(ah > 0.1 && ah < 2, `Ah ${ah}`);
});

test('numerical guards: finite outputs, H >= 0, d in [0, 1], time constants >= 4 ms, at the bounds and at the fit rate', () => {
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const corner of ['lo', 'hi']) for (const dt of [0.0005, 0.001, 0.01, 0.05]) {
        const p = GT.defaults({ kv: 290, Href: 4500, V0: 25, current: true });
        for (const q of GT.PARAMS) p[q.name] = q[corner];
        const x = GT.initState(p, { hs: 4000, u: 0.5, vbat: 24, ibat: 20 }), inp = { u: 0, coll: 0, cyc: 0, yaw: 0 };
        for (let i = 0; i < 4000; i++) {
            inp.u = rnd() * 1.4 - 0.2; inp.coll = rnd() * 4 - 2; inp.cyc = rnd() * 2; inp.yaw = rnd() * 4 - 2;
            GT.step(x, inp, p, dt);
            for (const k of ['H', 'd', 'Q', 'hsLog', 'vLog', 'iLog', 's', 'V', 'sL', 'I']) assert.ok(Number.isFinite(x[k]), `${corner} ${dt} ${k}`);
            assert.ok(x.H >= 0 && x.d >= 0 && x.d <= 1 && x.V >= 0);
        }
    }
    // a time constant below 4 ms acts as 4 ms
    const r = run(2000, 1000, wavy), a = GT.simulate(fb({ te: 1e-5, tm: 1e-6, th: 0 }), r), b = GT.simulate(fb({ te: 0.004, tm: 0.004, th: 0.004 }), r);
    assert.deepEqual(a.hs, b.hs);
    // tm at its bound, 100-Hz steps (dt/tm = 2.5, where explicit Euler oscillates): a monotone step response
    const p = fb({ tm: 0.004, te: 0.004, th: 0.004 }), x = GT.initState(p, { hs: 2000, u: 0.5, vbat: 25, stopped: false });
    let prev = x.H;
    for (let i = 0; i < 300; i++) { GT.step(x, { u: 0.8, coll: 0.2, cyc: 0, yaw: 0 }, p, 0.01); assert.ok(x.H >= prev - 1e-9, `monotone at ${i}`); prev = x.H; }
    near(x.H, GT.maxHeadspeed(p, { coll: 0.2 }, x.V0, 0.2), 1e-6 * x.H, 'converges to the steady state');
    // dt = 0 changes nothing
    const x2 = GT.clone(x); GT.step(x2, { u: 0.2, coll: 0.5, cyc: 0, yaw: 0 }, p, 0);
    for (const k of ['H', 'd', 'Q', 'hsLog', 'vLog']) near(x2[k], x[k], 1e-9 * Math.abs(x[k]) + 1e-12, `dt = 0: ${k}`);
    // missing or non-finite load inputs are zero
    const y = GT.initState(p, { hs: 4000, u: 0.7, vbat: 24 });
    GT.step(y, { u: NaN, coll: NaN, cyc: NaN, yaw: undefined }, p, 0.001);
    assert.ok(['H', 'd', 's', 'V', 'sL'].every(k => Number.isFinite(y[k])));
});
