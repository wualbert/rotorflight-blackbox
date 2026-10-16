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
    assert.match(g3.text, /higher F gain is a possible test after its prerequisite checks/);
    assert.doesNotMatch(g3.text, /F too low/);
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
    assert.match(g6.text, /no reserve during these periods/);
    assert.doesNotMatch(g6.text, /not a gain problem/);
    assert.deepEqual(g6.throttleLimit, { value: 800, source: 'CLI gov_max_throttle', estimated: false });
    const inferred = run({ maxThrottle: 0.8 }).of('G6')[0];
    assert.equal(inferred.throttleLimit.estimated, true);
    assert.match(inferred.text, /These periods do not show that the throttle was at its maximum/);
    assert.doesNotMatch(inferred.text, /no reserve during these periods/);
    const runs = r.metrics.G6.byProfile[1].runs.filter(q => q.value >= 0.1 && q.deficit > 0.02);
    assert.ok(runs.length >= 8, `saturated runs ${runs.length}: every pump needs more than 80 %`);
    assert.ok(g7 && g7.value > 0, 'the governor asks for more than the output at the ceiling');
    const g3 = r.of('G3')[0];
    if (g3.severity !== 'ok') assert.match(g3.text, /throttle limit/);
});

test('RPM dropouts: every FALLBACK found at its time, with glitch evidence', () => {
    const at = [30.3, 61.7, 95.2], r = run({ glitches: at.map(t => ({ t, ms: 30, kind: 'drop' })).concat([{ t: 80.4, ms: 3, kind: 'spike' }]) });
    const g1 = r.of('G1').find(f => f.severity === 'flag');
    assert.ok(g1, show(r.of('G1')));
    const fb = r.metrics.G1.fallbackEntries;
    assert.equal(fb.length, 4, JSON.stringify(fb));
    // Worker/report time links retain the lowercase legacy "at N s" anchor.
    assert.deepEqual([...g1.text.matchAll(/\bat (\d+(?:\.\d+)?) s\b/g)].map(m => +m[1]), fb.map(e => e.t));
    assert.match(g1.text, /FALLBACK does not show that the RPM source is incorrect/);
    assert.match(g1.text, /FALLBACK mode switch that is on/);
    assert.doesNotMatch(g1.text, /The RPM signal is not available or has errors/);
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
    assert.match(r.of('G8')[0].text, /voltage compensation is on/);
    assert.match(clean.of('G8')[0].text, /voltage compensation is off/);
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
    assert.match(g3.text, /No result: \d+ collective increases/);
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
    assert.match(clean.of('G3')[0].text, /of travel from center to maximum/);
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


test('governor gain diagnosis separates unsaturated response from severe output limits', () => {
    const event = (i, saturated, droop, share = 0.2) => ({ t: 5 + i * 3, dir: 'rise', profile: 1, size: 0.4,
        saturated, droop, overshoot: 0.005, recoveryS: saturated ? 2.5 : 0.2, censored: false,
        delta: {sum: 0.2, F: share * 0.2}, share: {F: share} });
    const events = Array.from({length:20}, (_,i)=>event(i,false,0.02)).concat(Array.from({length:5},(_,i)=>event(i+20,true,0.12)));
    const judge = list => hg.judge([{ log: 1, metrics: {...clean.metrics, G3: {...clean.metrics.G3, events:list}} }]);
    const findings = judge(events), g3 = findings.find(f=>f.id==='G3'), g5 = findings.find(f=>f.id==='G5');
    assert.equal(g3.governorResponse.unsaturated.n,20);
    assert.ok(Math.abs(g3.governorResponse.unsaturated.mean-0.02)<1e-12);
    assert.ok(Math.abs(g3.governorResponse.saturated.mean-0.12)<1e-12);
    assert.equal(g3.governorResponse.lowF,false,'good response below the limit does not authorize extra F');
    assert.equal(g5.value,0.2); assert.equal(g5.severity,'ok','saturated recovery does not size P');
    assert.equal(g5.governorResponse.saturatedExcluded,5);
    for(const shares of [[0,0.3,0.6],[-0.1,-0.1,-0.1],[3,4,5]]) {
        const g=judge(shares.map((s,i)=>event(i,false,0.08,s))).find(f=>f.id==='G3');
        assert.equal(g.governorResponse.lowF,false,'invalid or uncertain shares cannot justify F');
    }
    const low = judge([0.10,0.11,0.12].map((s,i)=>event(i,false,0.08,s))).find(f=>f.id==='G3');
    assert.equal(low.governorResponse.lowF,true,'repeated droop and a clearly small F share justify a trial');
    const negative = [0,1,2].map(i=>({...event(i,false,0.08),delta:{sum:-0.1,F:-0.02}}));
    assert.equal(judge(negative).find(f=>f.id==='G3').governorResponse.lowF,false,'negative output differences cannot identify an added-throttle fraction');
});

test('governor event evidence preserves when the throttle first reaches its limit', () => {
    const events = run({maxThrottle:0.8}).metrics.G3.events;
    assert.ok(events.some(e=>e.saturated));
    for(const e of events) {
        if(e.saturated) {
            assert.equal(typeof e.firstCeilingT,'number');
            assert.ok(e.firstCeilingT < e.t+1.001);
            if(e.firstCeilingT>e.t) assert.ok(e.droopBeforeCeiling>=0);
        } else assert.equal(e.firstCeilingT,null);
        if(e.delta.sum<=0.001) assert.equal(e.share,null);
    }
});

test('raw G9 text preserves the frequency classification without making it a causal diagnosis', () => {
    const peak = { hz:3, hzSe:0.1, band:[2,10], prominence:8, prominenceSe:0.2, amplitude:0.01, collectiveCoherence:0.1, n:10 };
    const judge = (band, over={}) => hg.judge([{log:0,metrics:{...clean.metrics,G9:{windowS:2,byProfile:{1:{windows:10,[band]:{...peak,...over}}}}}}])
        .find(f=>f.id==='G9'&&f.text.includes(`(${band}-type)`));
    for (const band of ['P','I']) {
        const f=judge(band);
        assert.equal(f.severity,'flag');
        assert.equal(f.value,8); assert.equal(f.se,0.2);
        assert.match(f.text,new RegExp(`lower governor ${band} gain is a possible test after its prerequisite checks`));
        assert.match(f.text,/does not identify the cause/);
        assert.doesNotMatch(f.text,/gain too high|governor [PI] too high/);
    }
    const forced=judge('P',{collectiveCoherence:0.9});
    assert.equal(forced.severity,'note');
    assert.match(forced.text,/collective can cause this response/);
    assert.doesNotMatch(forced.text,/gain is a possible test/);
});

test('raw G1 without a glitch proxy requires cause inspection instead of a sensor-failure claim', () => {
    const metrics={...clean.metrics,G1:{...clean.metrics.G1,glitchInFlight:0,fallbackEntries:[{
        t:10,value:0.25,headspeedAt:2200,headspeedMax:2200,glitchSamplesNear:0,profile:1}]}};
    const finding=hg.judge([{log:0,metrics}]).find(f=>f.id==='G1'&&f.severity==='flag');
    assert.equal(finding.value,1,'The FALLBACK prerequisite remains open even without detected proxy glitches.');
    assert.match(finding.text,/at 10 s \(0\.25 s long\)/);
    assert.match(finding.text,/"glitch-proxy" has 0 samples/);
    assert.match(finding.text,/FALLBACK does not show that the RPM source is incorrect/);
    assert.match(finding.text,/low RPM, sudden RPM changes, or a FALLBACK mode switch that is on/);
    assert.match(finding.text,/Examine the mode switch and the RPM signal at each entry/);
    assert.doesNotMatch(finding.text,/The RPM signal is not available or has errors/);
});

test('raw G10 text reports association or weak evidence without implicating or ruling out the governor', () => {
    const judge = (coherence,heads=20) => hg.judge([{log:0,metrics:{...clean.metrics,G10:{byProfile:{1:{
        windows:10,coherence,coherenceSe:0.01,headspeedAmplitude:heads,frameSign:-1,coherenceRaw:0.9,
        wagHz:8,maxCoherence:coherence,maxCoherenceHz:8,yawAmplitude:30}}}}}]).find(f=>f.id==='G10');
    const high=judge(0.8), low=judge(0.05,5), middle=judge(0.3);
    assert.equal(high.severity,'flag'); assert.equal(low.severity,'ok'); assert.equal(middle.severity,'note');
    assert.match(high.text,/does not show which loop causes/);
    assert.match(low.text,/small in these windows/);
    for (const f of [high,low,middle]) assert.doesNotMatch(f.text,/governor implicated|governor ruled out/);
});

test('raw G12 text directs the RPM check to motor poles and sensor while accepting the configured ratios', () => {
    const f=hg.judge([{log:0,metrics:{...clean.metrics,G12:{...clean.metrics.G12,mainOrder:0.8,mainOrderSe:0.001,mainProminence:10}}}])
        .find(f=>f.id==='G12');
    assert.equal(f.severity,'flag'); assert.equal(f.value,0.8);
    assert.match(f.text,/Check motor_poles and the RPM sensor/);
    assert.match(f.text,/gear ratios in the configuration are correct/);
    assert.doesNotMatch(f.text,/check motor_poles and gear ratio/i);
    assert.doesNotMatch(clean.of('G12')[0].text,/Check motor_poles/);
});

test('raw G3 and G5 text distinguishes a conditional gain test from unobserved recovery', () => {
    const event=i=>({t:i*4,dir:'rise',profile:1,size:0.4,saturated:false,droop:0.08,overshoot:0.005,
        recoveryS:1+i*0.1,censored:false,delta:{sum:0.2},share:{F:0.1}});
    const judge=events=>hg.judge([{log:0,metrics:{...clean.metrics,G3:{events}}}]);
    const events=[0,1,2].map(event), observed=judge(events), censored=judge(events.map((e,i)=>({...e,censored:i===1})));
    const g3=observed.find(f=>f.id==='G3');
    assert.equal(g3.governorResponse.lowF,true);
    assert.match(g3.text,/possible test after its prerequisite checks/);
    const measured=observed.find(f=>f.id==='G5'), lower=censored.find(f=>f.id==='G5');
    assert.equal(lower.value,measured.value,'the wording does not change the measured lower bounds');
    assert.equal(lower.se,measured.se);
    assert.match(lower.text,/is a minimum of 1\.1 s/);
    assert.match(lower.text,/1 responses did not get to the band/);
    assert.match(lower.text,/minimum times have an SE/);
    assert.doesNotMatch(measured.text,/minimum|did not get to the band|minimum times/);
    assert.match(measured.text,/1\.1 ± 0\.058 s/);
    const held=judge(events.map(e=>({...e,share:{F:0.8}}))).find(f=>f.id==='G3');
    assert.equal(held.governorResponse.lowF,false);
    assert.match(held.text,/does not identify an F gain change/);
});

// ---------------------------------------------------------------------------------------------
// G21: the sudden changes of the headspeed signal against the time at the throttle maximum (analysis/rpm-spikes)
// ---------------------------------------------------------------------------------------------

// the clean simulation with the throttle at its maximum (motor[0] 100 %, the governor command 110 %: the pile of motor[0] gives the
// maximum) in the windows atMax [[t0, t1]], and a sudden change of the headspeed signal (one sample, +400 rpm: 8.9 % of 4500 rpm
// in 3 ms) at each time of spikes
function g21Run({ atMax = [], spikes = [], fallbackAfter = null } = {}, extraCtx) {
    const s = simulate({}), x = s.w.extra, at = (t) => Math.round(t * RATE);
    for (const [a, b] of atMax) for (let i = at(a); i < at(b); i++) { x['motor[0]'][i] = 1000; x.govSum[i] = 1100; }
    for (const t of spikes) s.w.hs[at(t)] += 400;
    if (fallbackAfter !== null) for (let i = at(fallbackAfter + 0.01); i < at(fallbackAfter + 0.3); i++) s.ctx.govState[i] = FALLBACK;
    const metrics = hg.analyse(s.w, Object.assign(s.ctx, extraCtx || {}));
    const findings = hg.judge([{ log: 0, start: 'sim', header: s.w.flight.header, metrics: JSON.parse(JSON.stringify(metrics)) }], hg.DEFAULT_RULES);
    return { metrics, findings, G21: findings.filter(f => f.id === 'G21') };
}

test('G21: sudden changes only at the throttle maximum are a problem; the detector, the bands, the pile and the test', () => {
    const r = g21Run({ atMax: [[30, 32], [60, 62], [90, 92]], spikes: [30.5, 31.5, 60.7, 91.2], fallbackAfter: 91.2 }), m = r.metrics.G21, q = m.byProfile[1];
    assert.equal(m.samples, 3); assert.equal(m.thresholdRpmMs, 40, `the rate limit is the floor: the fastest rotor acceleration is ${m.accelRpmMs} rpm/ms`);
    assert.ok(m.accelRpmMs > 0 && m.accelRpmMs < 4, `rotor acceleration ${m.accelRpmMs} rpm/ms`);
    assert.deepEqual([q.ceiling, q.ceilingKind], [1000, 'pile'], q.ceilingSource);
    assert.deepEqual([m.spikesTotal, q.spikes, q.atMax, q.max.up, q.max.down], [4, 4, 4, 4, 0], 'one up change for each sample (the step down 3 ms later is the same change)');
    assert.ok(Math.abs(q.atMaxS - 6) < 0.01, `time at the maximum ${q.atMaxS}`);
    assert.ok(q.bands.every(b => b.up + b.down === 0) && q.bands.map(b => b.to).join() === '80,90,95,99.5', JSON.stringify(q.bands));
    assert.ok(m.spikes.every(s => s.atMax && s.throttle === 100 && s.up && s.rate > 100), JSON.stringify(m.spikes));
    // the change at 91.2 s: the increase and the decrease 3 ms later are one episode; the FALLBACK at 91.21 s is 10 ms after its start
    assert.deepEqual(m.fallbacks.map(f => [f.atMax, f.spike && f.spike.dtS, f.spike && f.spike.t]), [[true, 0.01, 91.2]], 'the FALLBACK 10 ms after a sudden change at the maximum');
    // review 2026-10-15: the start and the end of the episode against the entry (s before it; negative after it): it starts 10 ms and
    // ends 7 ms before the FALLBACK (its last fast sample is the step down 3 ms after the start)
    assert.deepEqual(m.fallbacks.map(f => [f.spike.startS, f.spike.endS]), [[0.01, 0.007]]);
    assert.ok(m.spikes.every(s => s.pulses === 1 && Math.abs(s.t1 - s.t - 0.003) < 1e-9), JSON.stringify(m.spikes.map(s => [s.t, s.t1, s.pulses])));
    const f = r.G21[0];
    assert.deepEqual([r.G21.length, f.severity, f.basis, f.value, f.n, f.unit], [1, 'flag', 'profile', 4, 4, 'count']);
    const share = f.atMaxS / f.governedS; assert.ok(Math.abs(f.share - share) < 1e-4);
    assert.ok(Math.abs(f.p - share ** 4) / share ** 4 < 0.01, `binomial P(X >= 4 | 4, ${share}) = ${f.p}`);
    assert.equal(f.rateBelow, 0); assert.ok(Math.abs(f.rateAtMax - 40) < 0.1, `4 in 6 s: 40 in each minute, ${f.rateAtMax}`);
    assert.deepEqual(f.fallbacks, { n: 1, atMax: 1, afterSpike: 1 });
    assert.ok(f.events.filter(e => e.kind === 'spike').length === 4 && f.events.some(e => e.kind === 'FALLBACK' && e.spike) && f.events.every(e => e.log === 0), 'each sudden change and FALLBACK is evidence with its log and time');
    assert.ok(f.demand && f.demand.s.length > 10 && f.demand.from === 85, 'the histogram of the governor command for the cost of a lower maximum');
    assert.match(f.text, /^At the throttle maximum \(100 %\), the headspeed signal has 4 sudden changes in 6 s\. With the throttle less than the maximum, it has 0 sudden changes in [\d.]+ s\./);
    assert.match(f.text, /The test value is `P\(X >= 4\) = [\d.e-]+` for `X ~ Binomial\(4, 0\.05\d*\)`\./);
    assert.match(f.text, /Thus, the errors of the RPM signal are related to the throttle maximum\./);
    assert.match(f.text, /The logs have 1 FALLBACK entry\. Of these, 1 starts with the throttle at its maximum, and 1 starts during a sudden change or 30 ms or less after its end\./);
    assert.match(f.text, /If the time between two changes is 300 ms or less, the analysis counts them as one sudden change\. In 99\.9 % of the 100 ms periods in ACTIVE, the rotor acceleration is \d+ rpm\/s or less\./);
    // the pile: the samples at the maximum in ACTIVE (the FALLBACK of 0.29 s is not ACTIVE)
    assert.match(f.text, /Throttle maximum source: "calculated from the log: motor\[0\] stays at 100 % in 5710 of 5710 samples while the governor command is more\."\.$/);
    // the CLI gov_max_throttle that the log does not contradict is the maximum; a CLI value under the recorded throttle is not used
    assert.deepEqual([g21Run({ atMax: [[30, 32]] }, { maxThrottle: { 1: 100 }, maxThrottleSource: 'CLI gov_max_throttle (diff)' }).metrics.G21.byProfile[1].ceilingKind], ['cli']);
    assert.equal(g21Run({ atMax: [[30, 32]] }, { maxThrottle: { 1: 90 } }).metrics.G21.byProfile[1].ceilingKind, 'pile');
});

test('G21: sudden changes in every band are a value to monitor; no time at the maximum is "not measured"; no sudden change is satisfactory', () => {
    const every = g21Run({ atMax: [[30, 32], [60, 62], [90, 92]], spikes: [30.5, 31.5, 60.7, 91.2, 10, 20, 40, 50, 70, 80, 100, 110] }).G21[0];
    assert.deepEqual([every.severity, every.value, every.n], ['note', 4, 12]); assert.ok(every.p > 1e-3, `p ${every.p}`);
    assert.match(every.text, /This test does not show that the sudden changes are related to the throttle maximum\./);
    // no sudden change at the maximum (k = 0): a plain sentence, no test value (review 2026-10-15: "P(X >= 0) = 1" and "0 % of the
    // sudden changes occur in 6.95 % of the time"), and the time at the maximum against minOkS
    const below = g21Run({ atMax: [[30, 32]], spikes: [10] }).G21[0];
    assert.deepEqual([below.severity, below.value, below.n], ['note', 0, 1]);
    assert.doesNotMatch(below.text, /P\(X >= 0\)|0 % of the sudden changes/);
    assert.match(below.text, /\nThe throttle is at its maximum for [\d.]+ % of the time, and no sudden change occurs at the maximum\. In each minute at less than the maximum, the signal has [\d.]+ sudden changes\.\n/);
    assert.match(below.text, /\nThe sudden changes occur only at less than the throttle maximum\. Examine the RPM signal\. The time at the throttle maximum is less than 12 s\. Thus, the logs cannot show that the headspeed signal has no errors at the maximum\.\n/);
    const none = g21Run({ spikes: [10, 20] }).G21[0];
    assert.deepEqual([none.severity, none.atMaxS, none.n], ['note', 0, 2]); assert.match(none.text, /Thus, the logs cannot show that the sudden changes are related to the throttle maximum\./);
    const notMeasured = g21Run({}).G21[0];
    assert.deepEqual([notMeasured.severity, notMeasured.atMaxS, notMeasured.n], ['skipped', 0, 0]); assert.match(notMeasured.text, /Thus, the logs cannot show this check\.$/m);
    // no sudden change: satisfactory with minOkS (12 s) or more at the maximum; with less, not measured (review 2026-10-15: 0.8 s at the
    // maximum cannot show a signal with no errors there)
    const ok = g21Run({ atMax: [[30, 43]] }).G21[0]; assert.equal(ok.severity, 'ok', ok.text);
    const short = g21Run({ atMax: [[30, 30.8]] }).G21[0];
    assert.deepEqual([short.severity, short.value, short.n, short.minAtMaxS], ['skipped', 0, 0, 12]);
    assert.match(short.text, /The time at the throttle maximum is less than 12 s\. Thus, the logs cannot show that the headspeed signal has no errors at the maximum\./);
    assert.equal(clean.of('G21')[0].severity, 'skipped', 'the clean baseline never gets to the throttle maximum');
    // a PID profile with fewer than 3 sudden changes at its maximum: the test of all PID profiles together (basis pooled)
    const sim = (spikes, p) => { const r = g21Run({ atMax: [[30, 32], [60, 62]], spikes }); r.metrics.G21.byProfile = { [p]: r.metrics.G21.byProfile[1] }; for (const s of r.metrics.G21.spikes) s.profile = p; return r.metrics; };
    const pooled = hg.judge([{ log: 0, metrics: sim([30.5, 31.5], 1) }, { log: 1, metrics: sim([60.5, 61.5], 2) }]).filter(f => f.id === 'G21');
    assert.deepEqual(pooled.map(f => [f.profile, f.severity, f.basis, f.value]), [[1, 'flag', 'pooled', 2], [2, 'flag', 'pooled', 2]]);
    assert.match(pooled[0].text, /This PID profile has only 2 sudden changes at its maximum\. Thus, the test uses all PID profiles together: `P\(X >= 4\)/);
    // a PID profile with 3 sudden changes at its maximum and 5 under it fails its own test (p): it has enough changes for its own test,
    // thus it does not take the pooled test and stays a value to monitor, also when the pooled test passes
    const mixed = hg.judge([{ log: 0, metrics: sim([30.5, 31.5, 60.5, 10, 20, 40, 50, 70], 1) }, { log: 1, metrics: sim([30.5, 31.5, 60.5, 61.5], 2) }]).filter(f => f.id === 'G21');
    assert.deepEqual(mixed.map(f => [f.profile, f.severity, f.basis, f.value, f.n]), [[1, 'note', null, 3, 8], [2, 'flag', 'profile', 4, 4]]);
    assert.ok(mixed[0].p >= 1e-3 && mixed[0].pooled.pass, `own p ${mixed[0].p}, pooled ${JSON.stringify(mixed[0].pooled)}`);
    // no sample with the governor in RECOVERY, ACTIVE or FALLBACK: not measured, with the cause
    const idle = simulate({}); idle.ctx.govState.fill(1);
    const sk0 = hg.judge([{ log: 0, metrics: hg.analyse(idle.w, idle.ctx) }]).filter(f => f.id === 'G21');
    assert.deepEqual(sk0.map(f => [f.severity, f.text]), [['skipped', 'The logs have no samples with the governor in RECOVERY, ACTIVE or FALLBACK and the motor on. Thus, the logs cannot show this check.']]);
    // a log that does not record motor[0]
    const s = simulate({}); s.w.extra['motor[0]'] = null;
    const sk = hg.judge([{ log: 0, metrics: hg.analyse(s.w, s.ctx) }]).filter(f => f.id === 'G21');
    assert.deepEqual(sk.map(f => [f.severity, f.text]), [['skipped', 'The log does not record motor[0].']]);
});

// the whole path on the synthetic flight: health_gov analyse and judge, then advice.cjs (the recommendation, its CLI text, the CLI file)
test('G21 to advice: sudden changes only at the maximum give gov_max_throttle 97 with CLI text; sudden changes everywhere give no recommendation', () => {
    const advice = require('../tools/autotune/advice.cjs');
    const recsOf = (r) => { let k = 0; const F = r.findings.map(q => Object.assign({ module: 'gov', fid: `f${k++}` }, q));
        return advice.advise({ findings: F, decisions: null, header: {}, cli: null, logs: [{ log: 0, flown: true }], fields: null, headerProfile: 0, headerLog: 0 }).recommendations; };
    const at = recsOf(g21Run({ atMax: [[30, 32], [60, 62], [90, 92]], spikes: [30.5, 31.5, 60.7, 91.2] })), r = at.find(x => x.id === 'G21:gov_max_throttle:p1');
    assert.deepEqual([r.node, r.severity, r.from, r.to, r.cli, r.blockedBy], ['rpm', 'action', 100, 97, ['profile 0', 'set gov_max_throttle = 97'], []]);
    assert.deepEqual(at.filter(x => /^G21/.test(x.id)).map(x => [x.id, x.severity]), [['G21:gov_max_throttle:p1', 'action'], ['G21:signal', 'check']]);
    const cmds = advice.exportScript(at, advice.defaultPicks(at), { date: '2026-10-15' }).split('\n').filter(l => l && !l.startsWith('#'));
    assert.deepEqual(cmds, ['batch start', 'profile 0', 'set gov_max_throttle = 97', 'save']);
    const every = recsOf(g21Run({ atMax: [[30, 32], [60, 62], [90, 92]], spikes: [30.5, 31.5, 60.7, 91.2, 10, 20, 40, 50, 70, 80, 100, 110] }));
    assert.deepEqual(every.filter(x => /^G21/.test(x.id)), [], 'a value to monitor: no recommendation');
});

// review 2026-10-15: one sudden change is one episode of the signal, the throttle of a change is the throttle before it starts, and a
// PID profile takes the pooled test only when its own rates agree with the association
test('G21 review: a glitch burst is one change; the throttle before the start; the pooled basis needs the rate rule of the PID profile', () => {
    // one burst at 100 % throttle: 7 pulses 60 ms apart (log 17 of 2026-09-26, the synthetic burst of the review). The binomial test
    // counts independent trials: one burst is one change, with its 7 pulses, and one change cannot pass the test
    const burst = Array.from({ length: 7 }, (_, j) => 30.5 + 0.06 * j);
    const b = g21Run({ atMax: [[30, 33]], spikes: burst }), mb = b.metrics.G21;
    assert.deepEqual(mb.spikes.map(x => [x.t, x.pulses, x.atMax, x.up]), [[30.5, 7, true, true]]);
    assert.ok(Math.abs(mb.spikes[0].t1 - 30.863) < 1e-6, `the burst ends at its last fast sample: ${mb.spikes[0].t1}`);
    assert.deepEqual([b.G21[0].value, b.G21[0].n, b.G21[0].severity], [1, 1, 'note']);
    assert.match(b.G21[0].text, /If the time between two changes is 300 ms or less, the analysis counts them as one sudden change\./);
    // two bursts 1 s apart are two changes; three bursts in 3 windows at the maximum pass the test
    assert.equal(g21Run({ atMax: [[30, 33]], spikes: [30.5, 30.56, 31.5, 31.56] }).metrics.G21.spikesTotal, 2);
    const three = g21Run({ atMax: [[30, 32], [60, 62], [90, 92]], spikes: [30.5, 30.56, 30.62, 60.5, 60.56, 90.5] }).G21[0];
    assert.deepEqual([three.value, three.n, three.severity], [3, 3, 'flag']);
    // a slow start under the minStep (129 rpm in 3 ms, 43 rpm/ms) at 100 % throttle, the governor cuts the throttle to 97.9 %, and the
    // fast return: one increase at the maximum (log 12 of 2026-09-26: the earlier detector gave a decrease at 97.9 %)
    const s = simulate({}), x = s.w.extra, at = (t) => Math.round(t * RATE), i0 = at(40.5);
    for (let i = at(40); i < at(42); i++) { x['motor[0]'][i] = 1000; x.govSum[i] = 1100; }
    for (let j = 0; j < 10; j++) s.w.hs[i0 + j] += 43 * j;
    for (let j = 10; j < 15; j++) s.w.hs[i0 + j] += 387;
    for (let i = i0 + 8; i < i0 + 100; i++) x['motor[0]'][i] = 979;
    const m = hg.analyse(s.w, s.ctx).G21;
    assert.deepEqual(m.spikes.map(q => [q.up, q.throttle, q.atMax, q.t]), [[true, 100, true, 40.503]], JSON.stringify(m.spikes));
    // the pooled basis: PID profile 1 has 6 changes at its maximum; PID profile 2 has 1 at its maximum and 9 under it (the rate under the
    // maximum is 18 % of the rate at the maximum, more than 10 %): a value to monitor, not a problem, and no recommendation
    const sim = (spikes, p) => { const r = g21Run({ atMax: [[30, 32], [60, 62]], spikes }); r.metrics.G21.byProfile = { [p]: r.metrics.G21.byProfile[1] }; for (const q of r.metrics.G21.spikes) q.profile = p; return r.metrics; };
    const pool = hg.judge([{ log: 0, metrics: sim([30.5, 31.5, 60.5, 61.5], 1) }, { log: 1, metrics: sim([30.5, 10, 15, 20, 40, 50, 70, 80, 100, 110], 2) }]);
    const g = pool.filter(q => q.id === 'G21');
    assert.deepEqual(g.map(q => [q.profile, q.severity, q.basis, q.value, q.n]), [[1, 'flag', 'profile', 4, 4], [2, 'note', null, 1, 10]]);
    assert.ok(g[1].pooled.pass && g[1].rateBelow * 10 > g[1].rateAtMax, JSON.stringify([g[1].rateBelow, g[1].rateAtMax]));
    const advice = require('../tools/autotune/advice.cjs'); let k = 0;
    const out = advice.advise({ findings: pool.map(q => Object.assign({ module: 'gov', fid: `f${k++}` }, q)), decisions: null, header: {}, cli: null, logs: [{ log: 0, flown: true }, { log: 1, flown: true }], fields: null, headerProfile: 0, headerLog: 0 });
    assert.deepEqual(out.recommendations.filter(r => /^G21:gov_max_throttle/.test(r.id)).map(r => r.id), ['G21:gov_max_throttle:p1']);
});

test('G21: binomTail and g21Test against closed forms', () => {
    assert.ok(Math.abs(hg.binomTail(19, 21, 0.0121) - 7e-35) / 7e-35 < 0.2, `${hg.binomTail(19, 21, 0.0121)}: the Fireball dumps (analysis/rpm-spikes)`);
    assert.equal(hg.binomTail(0, 5, 0.3), 1); assert.equal(hg.binomTail(6, 5, 0.3), 0);
    assert.ok(Math.abs(hg.binomTail(1, 2, 0.5) - 0.75) < 1e-12 && Math.abs(hg.binomTail(2, 3, 0.5) - 0.5) < 1e-12);
    const t = hg.g21Test(6, 7, 23.4, 1496); assert.equal(t.pass, true); assert.ok(t.p < 1e-9);
    assert.equal(hg.g21Test(2, 2, 10, 1000).pass, false, 'fewer than 3 sudden changes');
    const fast = hg.g21Test(10, 30, 50, 1000); assert.ok(fast.p < 1e-3 && !fast.pass, `the rate at less than the maximum is more than 10 % of the rate at the maximum: ${JSON.stringify(fast)}`);
});

// The Fireball dump of 2026-10-05 (AUTOTUNE_RESCUE_LOG) and the Gaui X4 II dump of 2026-10-04 (AUTOTUNE_REAL_LOG): check G21 over the
// flight logs as health.cjs gives them (analysis/rpm-spikes: on the Fireball 6 of 7 sudden changes at 100 % throttle; the Gaui never gets
// to more than 95 %)
const HC = require('../tools/autotune/health.cjs'), fs = require('node:fs');
// the flight rpm: health.cjs RULE.flight (3000 rpm), 2000 rpm for the Gaui X4 II (2300 to 2700 rpm)
function realG21(file, rpm = HC.RULE.flight.headspeed) {
    const app = lib.loadApp(), flights = [], EXTRA = [...new Set(hg.EXTRA.concat(['govTarget']))], rule = Object.assign({}, HC.RULE.flight, { headspeed: rpm });
    for (const w of lib.segments(app, file, { whole: true, extra: EXTRA })) {
        if (w.skipped) continue;
        const fl = w.flight, { p: profile } = lib.profilesOf(w, w.extra.govTarget || w.hs, rpm), { flying, flown } = HC.flightMask(w, fl.actualRate, rule);
        if (flown) flights.push({ log: fl.log, metrics: JSON.parse(JSON.stringify(hg.analyse(w, HC.buildCtx(w, fl, { flying, profile, cli: null, cliParsed: null, app })))) });
    }
    return hg.judge(flights).filter(f => f.id === 'G21');
}
const RESCUE_LOG = process.env.AUTOTUNE_RESCUE_LOG, REAL_LOG = process.env.AUTOTUNE_REAL_LOG;
test('real: G21 on the Fireball dump 2026-10-05 is a problem of PID profile 2', { skip: !RESCUE_LOG || !fs.existsSync(RESCUE_LOG) ? 'set AUTOTUNE_RESCUE_LOG to the Fireball dump of 2026-10-05' : false }, () => {
    const F = realG21(RESCUE_LOG), p2 = F.find(f => f.profile === 2);
    // one sudden change is one episode (review 2026-10-15): the burst of log 14 at 205.81 s to 205.97 s (pulses at .807 and .965) counts once
    assert.deepEqual([p2.severity, p2.basis, p2.value, p2.n], ['flag', 'profile', 5, 5]); assert.ok(p2.p < 1e-9, `p ${p2.p}`);
    assert.deepEqual([p2.pooled.k, p2.pooled.N], [5, 6]); assert.ok(p2.pooled.p < 1e-8 && p2.pooled.pass, JSON.stringify(p2.pooled));
    assert.deepEqual(p2.fallbacks, { n: 3, atMax: 3, afterSpike: 3 }, 'the 3 FALLBACK entries of logs 12 and 15 come at 100 % throttle, 1 ms to 22 ms after a sudden change');
    const sp = p2.events.filter(e => e.kind === 'spike');
    assert.deepEqual(sp.map(e => `${e.log}@${e.t.toFixed(2)}`), ['11@54.62', '11@94.67', '11@159.54', '13@205.81', '14@193.66']);
    assert.ok(sp.every(e => e.up && e.atMax && e.throttle === 100), JSON.stringify(sp)); assert.deepEqual(sp.map(e => e.pulses), [1, 1, 1, 2, 1]);
    assert.ok(sp[3].t1 > 205.96 && sp[3].t1 - sp[3].t < 0.3, `the burst (pulses at 205.81 s and 205.97 s) ends at ${sp[3].t1} s`);
    // PID profiles 1 and 3: no sudden change in less than 12 s at the maximum: not measured, not satisfactory
    assert.ok(F.filter(f => f.profile === 1 || f.profile === 3).every(f => f.severity === 'skipped' && f.atMaxS > 0 && f.atMaxS < 12), F.map(f => `${f.profile} ${f.severity} ${f.atMaxS}`).join());
    assert.ok(p2.ceilings.every(c => c.value === 100 && c.kind === 'pile'), JSON.stringify(p2.ceilings));
    assert.ok(F.filter(f => f.profile !== 2).every(f => f.severity !== 'flag'), F.map(f => `${f.profile} ${f.severity}`).join());
});
test('real: G21 on the Gaui X4 II dump 2026-10-04 is not a problem', { skip: !REAL_LOG || !fs.existsSync(REAL_LOG) ? 'set AUTOTUNE_REAL_LOG to the Gaui X4 II dump RTFL_BLACKBOX_LOG_20261004_113720.BBL' : false }, () => {
    const F = realG21(REAL_LOG, 2000);
    assert.ok(F.length > 0 && F.every(f => f.severity !== 'flag'), F.map(f => `${f.profile} ${f.severity} ${f.value}/${f.n}`).join());
    assert.ok(F.every(f => !(f.atMaxS > 0)), 'the Gaui never gets to its throttle maximum: the logs cannot show check G21');
});
