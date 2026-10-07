// Ground-truth checks for tools/autotune/health_gov.cjs: a first-order rotor driven by throttle against a load torque
// that grows with collective, governed by the Rotorflight 4.6 ELECTRIC control law (governor.c, TUNING_KNOWLEDGE
// section 3.3), logged the way the flight controller logs it (integers, 0.1 % throttle steps, filtered headspeed).
// Known defects are injected and the module must find them; a clean baseline must produce no flag.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const hg = require('../tools/autotune/health_gov.cjs');

const RATE = 1000, ACTIVE = 4, FALLBACK = 6, RECOVERY = 3;

function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function gauss(rand) { return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand()); }
const pt1k = (fc) => 1 / (RATE / (2 * Math.PI * fc) + 1);
function pt2State(fc) { const k = pt1k(fc * 1.553773974); let a = null, b = null; return (x) => { if (a === null) a = b = x; a += k * (x - a); b += k * (a - b); return b; }; }
function difState(fc) { const W = Math.tan(Math.PI * fc / RATE), a = (W - 1) / (W + 1), b = 2 * RATE * W / (W + 1); let x1 = null, y1 = 0; return (x) => { if (x1 === null) x1 = x; const y = b * (x - x1) - a * y1; x1 = x; y1 = y; return y; }; }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const BASE = {
    seconds: 120, seed: 7, full: 4500,
    gain: 100, p: 10, i: 30, d: 0, f: 23, pLimit: 0.2, iLimit: 0.95, dLimit: 0.2, fLimit: 1, collW: 0.5, curve: 2, minThrottle: 0.1, maxThrottle: 1, drop: 0.1,
    tau: 0.5, Gm: 7000, L0: 500, L1: 800, delayS: 0.015, gust: 30,                      // rotor: tau dhs/dt = Gm thr V/25 - hs - L0 - L1 c^2
    vStart: 25.0, vEnd: 24.5, cells: 6, vcomp: false, vbatGlitch: null,
    pumps: [0.95, 1.1, 1.25], periodS: 5, holdS: 1.2, hover: 0.1,                     // collective, 1.0 = 1000 mixer units = 12 deg
    glitches: [], poleScale: 1, frameSign: -1, wagHz: 8, wagAmp: 15, tailLoad: 0,
};

function simulate(options = {}) {
    const o = Object.assign({}, BASE, options), rand = rng(o.seed), n = o.seconds * RATE, dt = 1 / RATE;
    const K = o.gain / 100, Kp = o.p / 10, Ki = o.i / 10, Kd = o.d / 1000, Kf = o.f / 100;
    const I16 = () => new Float64Array(n), cols = {};
    for (const k of ['hs', 'coll', 'govTarget', 'govRequest', 'govSum', 'govP', 'govI', 'govD', 'govF', 'motor[0]', 'Vbat', 'gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]', 'yaw', 'vc']) cols[k] = I16();
    const govState = new Uint8Array(n);
    const rpmF = pt2State(10), ffF = pt2State(5), vF = pt2State(5), logF = pt2State(100), dErr = difState(5);
    const delay = Math.round(o.delayS * RATE), thrHist = new Float64Array(delay + 1);
    // narrowband yaw wag: a lightly damped resonator driven by noise, scaled to wagAmp rms
    const yawWag = new Float64Array(n); { const wn = 2 * Math.PI * o.wagHz, zeta = 0.03; let y1 = 0, y2 = 0, ss = 0;
        for (let i = 0; i < n; i++) { const acc = wn * wn * (gauss(rand) - y1) - 2 * zeta * wn * y2; y2 += acc * dt; y1 += y2 * dt; yawWag[i] = y1; ss += y1 * y1; }
        const k = o.wagAmp / Math.sqrt(ss / n); for (let i = 0; i < n; i++) yawWag[i] *= k; }
    let hs = o.full, out = (o.full + o.L0 + o.L1 * o.hover ** 2) / o.Gm, I = out - K * Kf * o.collW * o.hover ** 2, state = ACTIVE, detect = -10, target = o.full, gust = 0, angle = 0, c = o.hover, cTarget = o.hover;
    thrHist.fill(out);
    let nextPump = 1, pumpAt = -1, pumpK = -1; // a pump every 0.7 to 1.3 periods: a regular rhythm would show as lines in every spectrum
    for (let i = 0; i < n; i++) {
        const t = i * dt;
        // collective: hover, a pump every periodS
        if (t >= nextPump) { pumpAt = t; pumpK++; nextPump = t + o.periodS * (0.7 + 0.6 * rand()); }
        cTarget = pumpK >= 0 && t - pumpAt < o.holdS ? o.pumps[pumpK % o.pumps.length] : o.hover;
        c += (cTarget - c) * pt1k(4) + gauss(rand) * 0.001;
        // yaw
        const yaw = yawWag[i] + gauss(rand) * 1.5;
        // battery
        const V = o.vStart + (o.vEnd - o.vStart) * t / o.seconds + (o.vbatGlitch && t >= o.vbatGlitch.t && t < o.vbatGlitch.t + o.vbatGlitch.ms / 1000 ? o.vbatGlitch.dv : 0);
        // rotor, driven by the delayed throttle
        const applied = thrHist[delay];
        gust += (-gust * 2 * Math.PI * 1 + gauss(rand) * o.gust * 10) * dt;
        hs += (o.Gm * applied * V / 25 - hs - o.L0 - o.L1 * c * c - o.tailLoad * yaw + gust) / o.tau * dt;
        angle += hs / o.poleScale / 60 * dt; // true rotor turns; the logged headspeed is poleScale x the truth
        // what the ESC reports: motor against the frame, with dropouts and spikes
        let raw = hs - o.frameSign * yaw / 6 + gauss(rand) * 2;
        for (const g of o.glitches) if (t >= g.t && t < g.t + g.ms / 1000) raw = g.kind === 'spike' ? 2.5 * o.full : 0;
        // governor (governor.c govUpdateData, govPIDControl, govFallbackControl)
        const filt = rpmF(raw), err = (target - filt) / o.full;
        const glitch = Math.abs(raw - filt) > 0.25 * o.full || raw > 2 * o.full, rpmError = (filt / o.full < 0.01 || raw < 10) && out > 0.1;
        if (!glitch && !rpmError && raw > 0 && filt / o.full > 0.05) { if (detect === null) detect = t; } else detect = null;
        const good = detect !== null && t - detect > 0.2;
        const P = clamp(K * Kp * err, -o.pLimit, o.pLimit), C = K * Ki * err * dt, D = clamp(K * Kd * dErr(err), -o.dLimit, o.dLimit);
        let F = clamp(ffF(K * Kf * o.collW * Math.pow(Math.abs(c), o.curve)), 0, o.fLimit);
        const vc = o.vcomp ? clamp(o.cells * 3.7 / vF(V), 0.8, 1.2) : (vF(V), 1);
        let sum;
        if (state === ACTIVE && !good) state = FALLBACK;
        else if (state === FALLBACK && good) { state = RECOVERY; target = filt; }
        if (state === ACTIVE) {
            I = clamp(I, -o.iLimit, o.iLimit);
            sum = P + I + C + D + F; const thr = sum * vc;
            if ((thr > o.minThrottle || C > 0) && (thr < o.maxThrottle || C < 0)) I += C;
            out = clamp(thr, o.minThrottle, o.maxThrottle);
        } else if (state === FALLBACK) {
            F = 0; sum = I; out = clamp(sum * vc * (1 - o.drop), o.minThrottle, o.maxThrottle);
        } else { // RECOVERY: spoolup-style ramp toward full throttle, then back to ACTIVE with a bumpless I
            F = 0; out = Math.min(o.maxThrottle, out + dt / 3); sum = out / vc; target = filt;
            if (filt > 0.99 * o.full || out > 0.95 * o.maxThrottle) { state = ACTIVE; target = o.full; F = clamp(ffF(K * Kf * o.collW * Math.pow(Math.abs(c), o.curve)), 0, o.fLimit); I = out / vc - (P + D + F); }
        }
        thrHist.copyWithin(1, 0); thrHist[0] = out;
        // log, as integers
        cols.hs[i] = Math.max(0, Math.round(logF(raw)));
        cols.coll[i] = Math.round(c * 1000); cols.govTarget[i] = Math.round(target); cols.govRequest[i] = o.full;
        cols.govSum[i] = Math.round(sum * 1000); cols.govP[i] = Math.round(P * 1000); cols.govI[i] = Math.round(I * 1000); cols.govD[i] = Math.round(D * 1000); cols.govF[i] = Math.round(F * 1000);
        cols.vc[i] = vc; cols['motor[0]'][i] = Math.round(out * 1000); cols.Vbat[i] = Math.round(V * 100 + gauss(rand) * 2); govState[i] = state; cols.yaw[i] = Math.round(yaw);
        const th = 2 * Math.PI * angle, tail = 2 * Math.PI * angle * 72 / 19;
        for (let a = 0; a < 3; a++) cols[`gyroRAW[${a}]`][i] = Math.round(20 * Math.sin(th + a) + 5 * Math.sin(2 * th + 1 + a) + 3 * Math.sin(3 * th + 2) + 15 * Math.sin(tail + a) + gauss(rand) * 3 + (a === 2 ? yaw : 0));
    }
    const zeros = () => new Float64Array(n), extra = {};
    for (const k of hg.EXTRA) extra[k] = cols[k] || null;
    extra['mixer[3]'] = cols.coll;
    const header = { collectiveRange: [-1250, 1250], govPID: [o.p, o.i, o.d, o.f, o.gain] };
    const w = { flight: { header, log: 0, id: 'sim', actualRate: RATE }, n, rate: RATE, fromS: 0, sp: [zeros(), zeros(), zeros()], gyro: [zeros(), zeros(), cols.yaw], u: [zeros(), zeros(), zeros()],
        hs: cols.hs, coll: cols.coll, extra, profileAt: new Uint8Array(n).fill(1), airborneAt: new Uint8Array(n).fill(1) };
    const ctx = { flying: new Uint8Array(n).fill(1), profile: new Uint8Array(n).fill(1), govState, rate: RATE, header };
    return { w, ctx, o, truth: { vc: cols.vc } };
}

function run(options, extraCtx) {
    const s = simulate(options), metrics = hg.analyse(s.w, Object.assign(s.ctx, extraCtx || {}));
    const findings = hg.judge([{ log: 0, start: 'sim', header: s.w.flight.header, metrics }], hg.DEFAULT_RULES);
    return { metrics, findings, s, of: (id) => findings.filter(f => f.id === id), flags: findings.filter(f => f.severity === 'flag') };
}
const show = (f) => f.map(q => `${q.id}[${q.severity}] ${q.text}`).join('\n');

const clean = run({});

test('clean baseline: no flag, and the measurements match the simulated governor', () => {
    assert.equal(clean.flags.length, 0, 'flags on a clean baseline:\n' + show(clean.flags));
    const m = clean.metrics, g = m.gains.byProfile[1];
    assert.ok(Math.abs(g.KKp - 1) < 0.05, `K x Kp ${g.KKp}, truth 1`);
    assert.ok(Math.abs(g.KKfCollW - 0.115) < 0.01, `K x Kf x collective weight ${g.KKfCollW}, truth 0.115`);
    assert.ok(m.units.sumResidualRms < 2, `govSum - (P+I+D+F) rms ${m.units.sumResidualRms} counts`);
    assert.equal(m.G0.mode, 'PID (ELECTRIC/NITRO)');
    assert.equal(m.frameRotation.sign, -1, 'frame-rotation sign');
    assert.ok(Math.abs(m.G12.mainOrder - 1) < 0.002, `main rotor order ${m.G12.mainOrder}`);
    const rise = m.G3.byProfile[1].rise.filter(b => b.n), share = m.authority.byProfile[1].F;
    assert.ok(rise.reduce((s, b) => s + b.n, 0) >= 20, 'collective rises found');
    assert.ok(share.mean > 0.6, `F share of the added govSum ${share.mean}: an ideal feedforward should carry most of it`);
    assert.equal(m.states.entries.length, 0);
    // what remains after removing frame rotation is the governor chasing that measured term, 0.1 to 0.2 at this P
    assert.ok(m.G10.byProfile[1].coherenceRaw > 0.8 && m.G10.byProfile[1].coherence < 0.3, `frame rotation couples logged headspeed to yaw (raw ${m.G10.byProfile[1].coherenceRaw}); removed, ${m.G10.byProfile[1].coherence}`);
    assert.ok(m.G8.unityShare > 0.99, 'voltage compensation off');
});

test('low governor F: droop flagged, F carries little of the load', () => {
    const r = run({ f: 0 }), g3 = r.of('G3')[0];
    assert.equal(g3.severity, 'flag', show(r.of('G3')));
    assert.ok(g3.value > 0.05, `droop ${g3.value}`);
    assert.ok(Math.abs(r.metrics.authority.byProfile[1].F.mean) < 0.05, 'F share with F = 0');
    assert.match(g3.text, /F too low/);
    assert.ok(g3.value > clean.of('G3')[0].value * 2, 'droop grows when F is removed');
});

test('high governor F: overshoot on load flagged', () => {
    const r = run({ f: 80 }), g4 = r.of('G4').filter(f => f.severity === 'flag' && /load onset/.test(f.text));
    assert.equal(g4.length, 1, show(r.of('G4')));
    assert.ok(g4[0].value > 0.03, `overshoot ${g4[0].value}`);
    assert.ok(r.metrics.authority.byProfile[1].F.mean > 1, 'F carries more than the whole change');
});

// phase crossover of the linear governor loop: plant, transport delay, governor RPM filter, PI, logging filter ignored
function crossover(o) {
    const K = o.gain / 100, kp = K * o.p / 10, ki = K * o.i / 10, fc = 10 * 1.553773974;
    const phase = (f) => { const w = 2 * Math.PI * f, z = Math.atan2(w * o.tau, 1), pt = 2 * Math.atan2(w, 2 * Math.PI * fc), pi = Math.atan2(-ki / w, kp);
        return -z - pt - w * (o.delayS + 1.5 / RATE) + pi; };
    let lo = 1, hi = 30; for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (phase(m) > -Math.PI) lo = m; else hi = m; }
    return lo;
}

test('high governor P: oscillation flagged in the P band at the loop crossover', () => {
    const o = Object.assign({}, BASE, { p: 150, gain: 150 }), r = run(o), fx = crossover(o), g9 = r.of('G9').filter(f => f.severity === 'flag');
    assert.equal(g9.length, 1, show(r.of('G9')));
    const b = r.metrics.G9.byProfile[1].P;
    assert.ok(Math.abs(b.hz - fx) < 0.1 * fx, `oscillation at ${b.hz} Hz, loop crossover ${fx.toFixed(2)} Hz`);
    assert.ok(b.amplitude > 0.005, `amplitude ${b.amplitude}`);
    assert.equal(clean.of('G9').filter(f => f.severity === 'flag').length, 0);
});

test('throttle ceiling: saturation flagged as headroom, not gains', () => {
    const r = run({ maxThrottle: 0.8 }, { maxThrottle: { 1: 80 } }), g6 = r.of('G6')[0], g7 = r.of('G7')[0];
    assert.equal(g6.severity, 'flag', g6.text);
    assert.match(g6.text, /Saturation, not a gain problem/);
    const runs = r.metrics.G6.byProfile[1].runs.filter(q => q.value >= 0.1 && q.deficit > 0.02);
    assert.ok(runs.length >= 8, `saturated runs ${runs.length}: every pump needs more than 80 %`);
    assert.ok(g7 && g7.value > 0, 'the governor asks for more than the output at the ceiling');
    const g3 = r.of('G3')[0];
    if (g3.severity !== 'ok') assert.match(g3.text, /headroom|saturate|ceiling/);
});

test('RPM dropouts: every FALLBACK found at its time, with glitch evidence', () => {
    const at = [30.3, 61.7, 95.2], r = run({ glitches: at.map(t => ({ t, ms: 30, kind: 'drop' })).concat([{ t: 80.4, ms: 3, kind: 'spike' }]) });
    const g1 = r.of('G1').find(f => f.severity === 'flag');
    assert.ok(g1, show(r.of('G1')));
    const fb = r.metrics.G1.fallbackEntries;
    assert.equal(fb.length, 4, JSON.stringify(fb));
    for (const t of at.concat([80.4])) assert.ok(fb.some(e => Math.abs(e.t - t) < 0.02 && e.glitchSamplesNear > 0), `fallback at ${t}`);
    for (const t of at) assert.ok(r.metrics.G1.events.some(e => Math.abs(e.t - t) < 0.05), `glitch proxy near ${t}`);
    assert.ok(r.metrics.states.entries.filter(e => e.state === 'RECOVERY').length === 4, 'each fallback ends in recovery');
    assert.ok(fb.every(e => e.value > 0.2), 'FALLBACK lasts the firmware 200 ms at least');
    assert.equal(clean.metrics.G1.glitchEvents, 0, 'no glitch proxy on the clean baseline');
});

test('battery sag without voltage compensation: throttle trend flagged, of the simulated size', () => {
    const r = run({ vEnd: 21 }), g11 = r.of('G11')[0];
    assert.equal(g11.severity, 'flag', g11.text);
    // truth: hover throttle scales with 25 / V at equal load
    const truth = 100 * (BASE.full + BASE.L0 + BASE.L1 * BASE.hover ** 2) / BASE.Gm * (25 / 21 - 1);
    assert.ok(Math.abs(g11.value - truth) < 0.25 * truth, `trend ${g11.value} % points, truth about ${truth.toFixed(1)}`);
    assert.equal(clean.of('G11')[0].severity, 'ok');
});

test('voltage compensation on is recognised from motor[0]/govSum', () => {
    const r = run({ vEnd: 21, vcomp: true }), m = r.metrics.G8;
    assert.ok(m.unityShare < 0.1, `unity share ${m.unityShare}`);
    assert.ok(m.corrWithPredicted > 0.9, `correlation with the predicted gain ${m.corrWithPredicted}`);
    assert.ok(Math.abs(m.median - m.predictedMedian) < 0.01);
    assert.match(r.of('G8')[0].text, /voltage compensation on/);
    assert.match(clean.of('G8')[0].text, /voltage compensation off/);
});

test('wrong motor poles: main rotor line off the logged headspeed', () => {
    const r = run({ poleScale: 1.2 }), g12 = r.of('G12')[0];
    assert.equal(g12.severity, 'flag', g12.text);
    assert.ok(Math.abs(r.metrics.G12.mainOrder - 1 / 1.2) < 0.003, `order ${r.metrics.G12.mainOrder}, truth ${(1 / 1.2).toFixed(4)}`);
    assert.ok(r.metrics.G12.lines.some(l => Math.abs(l.order * r.metrics.G12.mainOrder * 1.2 - 72 / 19) < 0.01), 'tail line kept as a non-harmonic line');
});

test('governor-tail coupling: coherence after frame rotation flags only real coupling', () => {
    const r = run({ tailLoad: 20 }), g10 = r.of('G10')[0];
    assert.equal(g10.severity, 'flag', g10.text);
    assert.ok(Math.abs(r.metrics.G10.byProfile[1].wagHz - BASE.wagHz) < 0.6);
    assert.notEqual(clean.of('G10')[0].severity, 'flag', clean.of('G10')[0].text);
    assert.ok(r.metrics.G10.byProfile[1].coherence > 0.8, `coherence with coupling ${r.metrics.G10.byProfile[1].coherence}`);
});

test('voltage: telemetry step and deep discharge', () => {
    const r = run({ vbatGlitch: { t: 50, ms: 5, dv: -3 }, vEnd: 17 }), d5 = r.of('D5')[0], g13 = r.of('G13')[0];
    assert.equal(d5.severity, 'flag');
    assert.ok(r.metrics.D5.steps.some(s => Math.abs(s.t - 50) < 0.02 && Math.abs(s.value) > 2.5), JSON.stringify(r.metrics.D5.steps.slice(0, 3)));
    assert.equal(g13.severity, 'flag');
    assert.ok(Math.abs(r.metrics.G13.minCell - 17 / 6) < 0.05);
    assert.equal(clean.of('D5')[0].severity, 'ok');
});

test('DIRECT mode: governor PID fields zero, PID checks skipped', () => {
    const s = simulate({});
    for (const k of ['govSum', 'govI', 'govP', 'govD', 'govF']) s.w.extra[k].fill(0);
    const m = hg.analyse(s.w, s.ctx), f = hg.judge([{ log: 0, metrics: m }], hg.DEFAULT_RULES);
    assert.equal(m.G0.mode, 'DIRECT/LIMIT');
    for (const id of ['G2', 'G6', 'G9']) assert.ok(f.filter(q => q.id === id).every(q => q.severity === 'skipped'), id);
    assert.equal(m.reference, 'per-profile median headspeed');
});

test('missing fields are skipped with a reason', () => {
    const s = simulate({ seconds: 30 });
    for (const k of ['Vbat', 'motor[0]', 'gyroRAW[0]']) s.w.extra[k] = null;
    const m = hg.analyse(s.w, Object.assign(s.ctx, { govState: null })), f = hg.judge([{ log: 0, metrics: m }], hg.DEFAULT_RULES);
    for (const id of ['D5', 'G6', 'G11', 'G12', 'G13']) assert.ok(f.some(q => q.id === id && q.severity === 'skipped' && q.text), id);
    assert.ok(m.notes.some(t => /GOVSTATE/.test(t)));
    assert.doesNotThrow(() => JSON.stringify(m));
});

test('few events: no finding, with the count', () => {
    const r = run({ seconds: 8 });
    const g3 = r.of('G3')[0];
    assert.equal(g3.severity, 'note');
    assert.match(g3.text, /no finding: \d+ collective rises/);
});

test('G7 compares the compensated demand with the output: govSum is logged before vcomp, motor[0] after', () => {
    const r = run({ maxThrottle: 0.8, vStart: 25.2, vEnd: 25.0, vcomp: true }, { maxThrottle: { 1: 80 } }), m = r.metrics, x = r.s.w.extra;
    assert.ok(m.G8.unityShare < 0.1 && /^on/.test(m.G8.vcompUsed), m.G8.vcompUsed);
    // truth over the samples G7 uses: flying, ACTIVE, motor[0] at the ceiling
    let s = 0, k = 0; for (let i = 0; i < r.s.w.n; i++) if (r.s.ctx.govState[i] === ACTIVE && x['motor[0]'][i] >= 0.995 * 800) { s += (x.govSum[i] * r.s.truth.vc[i] - x['motor[0]'][i]) / 1000; k++; }
    const g7 = m.G7.byProfile[1];
    assert.equal(g7.n, k);
    assert.ok(Math.abs(g7.mean - s / k) < 0.005, `G7 mean ${g7.mean}, truth ${(s / k).toFixed(4)} (govSum - motor[0] would read ${(0.19).toFixed(2)})`);
    assert.match(r.of('G7')[0].text, /govSum x vcomp/);
});

test('collective events are measured on the one-sided travel: full pitch is 1, every bin can fill', () => {
    const m = clean.metrics;
    assert.equal(m.collectiveTravel, 1250); assert.match(m.G3.unit, /one-sided travel 1250/);
    const ev = m.G3.events.filter(e => e.dir === 'rise');
    // the pumps go from 0.1 (1.2 deg) to 0.95-1.25 of 1000 units: 0.08 to 0.76-1.0 of the travel
    assert.ok(Math.max(...ev.map(e => e.to)) > 0.9, `largest 'to' ${Math.max(...ev.map(e => e.to))}`);
    assert.ok(ev.some(e => e.bin === 3), 'the >= 0.60 bin is reachable');
    assert.match(clean.of('G3')[0].text, /of one-sided collective travel/);
});

test('cell count: an inferred count that is ambiguous gives no per-cell verdict; the CLI count is used as given', () => {
    // a true 6S pack at 3.62 -> 3.17 V/cell: 21.7 V fits 5 or 6 cells at 3.6-4.35 V/cell
    const r = run({ seconds: 40, vStart: 21.7, vEnd: 19 }), d5 = r.metrics.D5;
    assert.equal(d5.cellsAmbiguous, true, d5.cellsSource); assert.match(d5.cellsSource, /5 or 6/);
    assert.equal(r.of('G13')[0].severity, 'note'); assert.match(r.of('G13')[0].text, /ambiguous/);
    const c = run({ seconds: 40, vStart: 21.7, vEnd: 19 }, { cells: 6, cellsSource: 'CLI battery_cell_count' });
    assert.equal(c.of('G13')[0].severity, 'flag', c.of('G13')[0].text);
    assert.ok(Math.abs(c.metrics.G13.minCell - 19 / 6) < 0.03, `min ${c.metrics.G13.minCell}`);
    // an upward glitch no longer inflates the count
    const g = run({ seconds: 30, vbatGlitch: { t: 10, ms: 5, dv: 6 } });
    assert.equal(g.metrics.D5.cells, 6); assert.equal(g.metrics.D5.cellsAmbiguous, false);
    assert.equal(clean.metrics.D5.cells, 6); assert.equal(clean.metrics.D5.cellsAmbiguous, false);
});

test('cell count: the firmware rule (battery.c, health_power autoCells) with the cell levels of the log header needs no CLI dump', () => {
    // the same 6S pack at 21.7 V: with vbatcellvoltage 330, 350, 430 of the header, the smallest count whose range holds 21.7 V is 6
    // (5 x 3.30-4.30 V = 16.5-21.5 V, 6 x = 19.8-25.8 V); the per-cell verdict is given as with the CLI count
    const header = { collectiveRange: [-1250, 1250], govPID: [10, 30, 0, 23, 100], vbatmincellvoltage: 330, vbatwarningcellvoltage: 350, vbatmaxcellvoltage: 430 };
    const r = run({ seconds: 40, vStart: 21.7, vEnd: 19 }, { header }), d5 = r.metrics.D5;
    assert.deepEqual([d5.cells, d5.cellsAmbiguous], [6, false], d5.cellsSource);
    assert.match(d5.cellsSource, /^firmware rule \(battery\.c\): resting 21\.\d+ V at log start, 3\.3-4\.3 V\/cell \(log header vbatcellvoltage\)$/);
    assert.equal(r.of('G13')[0].severity, 'flag', r.of('G13')[0].text);
    assert.ok(Math.abs(r.metrics.G13.minCell - 19 / 6) < 0.03, `min ${r.metrics.G13.minCell}`);
    // a CLI count comes first; a voltage that no count of the rule holds (13.0 V: 3 x 4.30 = 12.9 V, 4 x 3.30 = 13.2 V) keeps the old inference
    assert.match(run({ seconds: 40, vStart: 21.7, vEnd: 19 }, { header, cells: 6, cellsSource: 'CLI battery_cell_count' }).metrics.D5.cellsSource, /^CLI/);
    const none = run({ seconds: 40, vStart: 13.0, vEnd: 12 }, { header }).metrics.D5;
    assert.match(none.cellsSource, /^inferred/, none.cellsSource);
});

test('D5 low voltage needs a duration and reports how many samples are below, not one sample', () => {
    const d = run({ vEnd: 17 }).of('D5').find(f => /below 3 V\/cell/.test(f.text));
    assert.ok(d && d.severity === 'flag');
    assert.ok(d.n > 5000 && Math.abs(d.value - d.n / RATE) < 0.01, `n ${d.n}, seconds ${d.value}`);
    const s = simulate({ seconds: 30 }); s.w.extra.Vbat[15000] = 1500; // one sample at 2.5 V/cell
    const m = hg.analyse(s.w, s.ctx), F = hg.judge([{ log: 0, metrics: m }], hg.DEFAULT_RULES).filter(f => f.id === 'D5');
    assert.ok(!F.some(f => /below 3 V\/cell/.test(f.text)), F.map(f => f.text).join('\n'));
    assert.ok(F.every(f => f.n !== null));
});

// ---------------------------------------------------------------------------------------------
// wiring: health.cjs (ctx, flight gate, per-profile seconds), health_report.cjs, lib.profilesOf
// ---------------------------------------------------------------------------------------------
const health = require('../tools/autotune/health.cjs'), hsetup = require('../tools/autotune/health_setup.cjs'), lib = require('../tools/autotune/lib.cjs');

test('health.cjs: flight gate and seconds per profile add up to the flying time', () => {
    const n = 60 * RATE, z = () => new Float64Array(n), w = { n, hs: z().fill(4000), airborneAt: new Uint8Array(n).fill(1), gyro: [z().fill(20), z(), z()] };
    for (let i = 0; i < 5000; i++) w.hs[i] = 0; // on the ground at first
    const profile = Uint8Array.from({ length: n }, (_, i) => 1 + Math.floor(3 * i / n));
    const g = health.flightMask(w, RATE), sec = health.profileSeconds(g.flying, profile, RATE);
    assert.equal(g.flown, true); assert.equal(g.up, n - 5000);
    assert.deepEqual(sec, { 1: 15, 2: 20, 3: 20 });
    assert.ok(Math.abs(Object.values(sec).reduce((a, v) => a + v, 0) - g.up / RATE) < 0.2);
    const slow = health.flightMask(Object.assign({}, w, { gyro: [z().fill(9.9), z(), z()] }), RATE);
    assert.equal(slow.flown, false, 'body rate below the gate'); assert.equal(slow.flying.reduce((a, v) => a + v, 0), 0);
    const short = health.flightMask(Object.assign({}, w, { hs: Float64Array.from(w.hs, (v, i) => i < n - 4999 ? 0 : v) }), RATE);
    assert.equal(short.flown, false, '4.999 s < minS 5');
});

test('health.cjs: CLI governor settings reach the governor module, CLI profile q = log profile q + 1', () => {
    const cli = hsetup.parseCli('# diff all\nset battery_cell_count = 6\nprofile 0\nset gov_headspeed = 4500\nset gov_max_throttle = 80\nprofile 1\nset gov_headspeed = 3000\n');
    const ctx0 = health.cliContext(cli);
    assert.deepEqual(ctx0.govHeadspeed, { 1: 4500, 2: 3000 }); assert.deepEqual(ctx0.maxThrottle, { 1: 80 }); assert.equal(ctx0.cells, 6);
    const s = simulate({ maxThrottle: 0.8 }), ctx = health.buildCtx(s.w, s.w.flight, { flying: s.ctx.flying, profile: s.ctx.profile, cli: 'x', cliParsed: cli });
    ctx.govState = s.ctx.govState; ctx.rate = RATE;
    const m = hg.analyse(s.w, ctx);
    assert.equal(m.fullHeadspeed.value[1], 4500); assert.match(m.fullHeadspeed.source[1], /^CLI gov_headspeed/);
    assert.equal(m.G6.byProfile[1].ceiling, 800); assert.match(m.G6.byProfile[1].ceilingSource, /^CLI gov_max_throttle/);
    assert.equal(m.D5.cells, 6); assert.match(m.D5.cellsSource, /CLI/);
    // a CLI dump the log contradicts is not used, and the report says why
    const stale = health.cliContext(hsetup.parseCli('# diff all\nprofile 0\nset gov_headspeed = 1800\nset gov_max_throttle = 60\n'));
    const m2 = hg.analyse(s.w, Object.assign({}, ctx, stale));
    assert.equal(m2.fullHeadspeed.value[1], 4500); assert.match(m2.fullHeadspeed.source[1], /CLI gov_headspeed 1800 is below the logged request/);
    assert.notEqual(m2.G6.byProfile[1].ceiling, 600); assert.match(m2.G6.byProfile[1].ceilingSource, /CLI gov_max_throttle 60 % not used/);
    assert.match(clean.metrics.G6.byProfile[1].ceilingSource, /no gov_max_throttle from the CLI/);
});

test('lib.profilesOf gives the samples before the first profile event the profile flown at their target', () => {
    const n = 20000, w = { n, profileAt: new Uint8Array(n), hs: new Float64Array(n) }, target = new Float64Array(n);
    for (let i = 0; i < n; i++) { const p = i < 5000 ? 0 : i < 12000 ? 2 : 1; w.profileAt[i] = p; target[i] = w.hs[i] = p === 1 ? 3500 : 4500; }
    const { p, targetOf } = lib.profilesOf(w, target, 3000);
    assert.equal(p[0], 2); assert.equal(p[4999], 2); assert.equal(p[15000], 1);
    assert.deepEqual(targetOf, { 1: 3500, 2: 4500 });
});

test('health_report.cjs: every flag row carries threshold, n and source; the gate and measurement parameters are stated', () => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execFileSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-report-'));
    const bad = run({ f: 0, vEnd: 17 }), log = (i, m) => ({ id: 'sim' + i, file: 'sim.bbl', log: i, segment: 0, start: 'sim', seconds: 120, flyingS: 120, flown: true, profileSeconds: { 1: 120 }, govStateLogged: true, header: {}, metrics: { gov: m }, errors: {} });
    fs.writeFileSync(path.join(dir, 'health.json'), JSON.stringify({ files: ['sim.bbl'], cli: null, rule: health.RULE, logs: [log(0, bad.metrics), log(1, clean.metrics)] }, (k, v) => ArrayBuffer.isView(v) ? Array.from(v) : v));
    execFileSync(process.execPath, [path.join(__dirname, '../tools/autotune/health_report.cjs'), dir], { stdio: 'pipe' });
    const res = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')), flags = res.findings.filter(f => f.severity === 'flag');
    assert.ok(flags.length >= 2, 'the low-F and low-voltage flights raise flags');
    for (const f of flags) { assert.ok(f.threshold !== null && f.threshold !== undefined, `${f.id} threshold`); assert.ok(typeof f.n === 'number', `${f.id} n`); assert.ok(f.source, `${f.id} source`); }
    const md = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
    assert.match(md, />= 5 s of that with body rate >= 10 deg\/s/);
    assert.match(md, /## Measurement parameters/); assert.match(md, /ceiling\.fraction \| 0\.995/); assert.match(md, /limitSamples \| 20/);
    assert.match(md, /\| 0 \| sim \| 120 \| 120 \| 1: 120 \|/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('collective events: one event per step, never the same step twice', () => {
    for (const r of [clean, run({ f: 0 })]) { const key = r.metrics.G3.events.map(e => e.dir + e.t);
        assert.equal(new Set(key).size, key.length, 'duplicate events'); }
    // pumps every 3.5-6.5 s over 120 s: about 25 rises and 25 drops, not hundreds
    assert.ok(clean.metrics.G3.eventsTotal < 80, `events ${clean.metrics.G3.eventsTotal}`);
    // a pump with a short dip after its peak (as in the Fireball log 9): the peak lies before the scan position, and the
    // same rise was found again at every sample of the dip
    const s = simulate({ seconds: 60 }), c = s.w.coll;
    for (let i = 0; i < s.w.n; i++) { const t = (i / RATE) % 5; c[i] = t < 2 ? 100 : t < 2.2 ? 1000 : t < 2.25 ? 500 : t < 3.2 ? 990 : 100; }
    s.w.extra['mixer[3]'] = c;
    const ev = hg.analyse(s.w, s.ctx).G3.events, key = ev.map(e => e.dir + e.t);
    assert.equal(new Set(key).size, key.length, `duplicate events: ${key.length} events, ${new Set(key).size} distinct`);
});
