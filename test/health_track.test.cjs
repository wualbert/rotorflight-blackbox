// Ground-truth check for tools/autotune/health_track.cjs: simulate sticks, the rate shaping between stick and setpoint,
// an airframe that follows the setpoint with a known delay, gain and disturbance, and injected oscillations; log it the
// way the flight controller does (integers, RC frames held), and require the checks to recover what was put in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const lib = require('../tools/autotune/lib.cjs');
const H = require('../tools/autotune/health_track.cjs');

const RATE = 1000;
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function gauss(rand) { return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand()); }
const pt1k = (fc) => 1 / (RATE / (2 * Math.PI * fc) + 1);
// the app's FFT in this realm, as the worker has it (a vm context makes its globals slow)
const APP = { FFT: new Function(fs.readFileSync(path.join(__dirname, '../js/complex.js'), 'utf8') + '\nreturn FFT;')() };

// Rotorflight rates (rates_type 6, TUNING_KNOWLEDGE 2.12): rate = 5 rc_rate (|x| (1 - e) + |x|^(srate/16 + 2) e)
const RATES = { rc: [50, 50, 80], expo: [0.4, 0.4, 0.5], srate: 12 };
const curve = (x, a) => Math.sign(x) * 5 * RATES.rc[a] * (Math.abs(x) * (1 - RATES.expo[a]) + Math.abs(x) ** (RATES.srate / 16 + 2) * RATES.expo[a]);

// the clean helicopter; a scenario overrides parts of it
const BASE = () => ({
    seconds: 120, switchS: 60,       // profile 1, then profile 2
    hold: 4,                         // RC frames every 4 samples
    stick: [300, 300, 400],          // largest stick target, rcCommand units (500 = full)
    responseTime: [50, 0, 100],      // ms; the firmware smooths the stick by a PT1 at 500 / response_time Hz (setpoint.c)
    // gyro(t) = gain x response(setpoint)(t - tau) + gusts (PT1 at 2 Hz) of rho x the setpoint rms; response second order if fn is set
    axes: [{ tau: 0.025, gain: 1, rho: 0.15 }, { tau: 0.060, gain: 1, rho: 0.15 }, { tau: 0.040, gain: 1, rho: 0.10 }],
    events: [],                      // oscillations and jolts, added to the gyro (or to the setpoint: inSetpoint)
    vib: null,                       // [[hz, deg/s]]: sines added to the gyro of every axis (rotor vibration no loop follows)
});

function addEvent(x, e) {
    const n = x.length, i0 = Math.round(e.t0 * RATE), w = 2 * Math.PI * e.hz;
    if (e.jolt) { const wd = w * Math.sqrt(1 - e.zeta ** 2); for (let i = i0; i < Math.min(n, i0 + 2 * RATE); i++) { const t = (i - i0) / RATE; x[i] += e.jolt * Math.exp(-e.zeta * w * t) * Math.sin(wd * t); } return; }
    if (e.every) { for (let i = 0; i < n; i++) { const t = i / RATE, c = t % e.every, ramp = Math.max(0, Math.min(1, (c - e.on[0]) / 0.05, (e.on[1] - c) / 0.05)); x[i] += e.amp * ramp * Math.sin(w * t); } return; }
    const len = e.riseS + e.holdS + 0.1;  // grows exponentially from `from` to `to`, holds, fades out
    for (let i = i0; i < Math.min(n, i0 + len * RATE); i++) { const t = (i - i0) / RATE;
        const env = t < e.riseS ? e.from * (e.to / e.from) ** (t / e.riseS) : t < e.riseS + e.holdS ? e.to : e.to * Math.max(0, 1 - (t - e.riseS - e.holdS) / 0.1);
        x[i] += env * Math.sin(w * t); }
}

function simulate(seed, cfg) {
    const rand = rng(seed), n = Math.round(cfg.seconds * RATE), col = () => new Float64Array(n);
    const rc = [col(), col(), col()], raw = [col(), col(), col()], sp = [col(), col(), col()], gyro = [col(), col(), col()];
    // sticks: a new target every 0.4 s on average, smoothed the way a thumb moves (autotune.test.cjs)
    const target = [0, 0, 0], s1 = [0, 0, 0], s2 = [0, 0, 0], lp = [0, 0, 0], k1 = 2 * Math.PI * 4 / RATE, k2 = 2 * Math.PI * 6 / RATE, kr = cfg.responseTime.map(rt => rt ? pt1k(500 / rt) : 1);
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) {
        if (rand() < 1 / (0.4 * RATE)) target[a] = (rand() * 2 - 1) * cfg.stick[a];
        s1[a] += (target[a] - s1[a]) * k1; s2[a] += (s1[a] - s2[a]) * k2;
        rc[a][i] = i % cfg.hold ? rc[a][i - 1] : Math.round(s2[a]);
        lp[a] += kr[a] * (rc[a][i] / 500 - lp[a]);
        raw[a][i] = (a === 2 ? -1 : 1) * curve(lp[a], a);   // yaw setpoint has the sign opposite to rcCommand[2] (setpoint.c:291-292)
    }
    for (const e of cfg.events) if (e.inSetpoint) addEvent(raw[e.axis], e);
    for (let a = 0; a < 3; a++) for (let i = 0; i < n; i++) sp[a][i] = Math.round(raw[a][i]);
    const prof = new Uint8Array(n).fill(1); if (cfg.switchS) prof.fill(2, Math.round(cfg.switchS * RATE));
    for (let a = 0; a < 3; a++) {
        const A = cfg.axes[a], d = col(), kd = pt1k(2), h = col(), lag = Math.round(A.tau * RATE);
        let x = 0; for (let i = 0; i < n; i++) { x += kd * (gauss(rand) - x); d[i] = x; }
        // disturbance rms = rho x setpoint rms on each profile, so that every profile has the error ratio simulated
        const pw = (v, p) => { let s = 0, c = 0; for (let i = 0; i < n; i++) if (prof[i] === p) { s += v[i] * v[i]; c++; } return Math.sqrt(s / c); }, scale = { 1: pw(sp[a], 1) / pw(d, 1), 2: cfg.switchS ? pw(sp[a], 2) / pw(d, 2) : 0 };
        if (A.fn) { const wn = 2 * Math.PI * A.fn, SUB = 8, dt = 1 / (RATE * SUB); let y = 0, v = 0;
            for (let i = 0; i < n; i++) { for (let k = 0; k < SUB; k++) { v += (wn * wn * (sp[a][i] - y) - 2 * A.zeta * wn * v) * dt; y += v * dt; } h[i] = y; } }
        else h.set(sp[a]);
        for (let i = 0; i < n; i++) gyro[a][i] = A.gain * (i >= lag ? h[i - lag] : 0) + A.rho * scale[prof[i]] * d[i] + 0.5 * gauss(rand);
        if (cfg.vib) for (const [hz, am] of cfg.vib) for (let i = 0; i < n; i++) gyro[a][i] += am * Math.sin(2 * Math.PI * hz * i / RATE + a);
    }
    for (const e of cfg.events) if (!e.inSetpoint) addEvent(gyro[e.axis], e);
    for (let a = 0; a < 3; a++) for (let i = 0; i < n; i++) gyro[a][i] = Math.round(gyro[a][i]);
    const header = { rollBW: [50, 15, 15], pitchBW: [50, 15, 15], yawBW: [100, 20, 20], response_time: cfg.responseTime.slice(), accel_limit: [0, 0, 0] };
    const w = { flight: { log: 0, id: 'sim' + seed, actualRate: RATE, header }, whole: true, n, rate: RATE, fromS: 0, sp, gyro, hs: new Float64Array(n).fill(2500), coll: null,
        profileAt: prof, airborneAt: new Uint8Array(n).fill(1), govStateAt: null, extra: { 'rcCommand[0]': rc[0], 'rcCommand[1]': rc[1], 'rcCommand[2]': rc[2] } };
    return { w, ctx: { flying: new Uint8Array(n).fill(1), profile: prof, govState: new Uint8Array(n).fill(4), rate: RATE, header, app: APP } };
}

function run(seed, change = () => {}) {
    const cfg = BASE(); change(cfg);
    const { w, ctx } = simulate(seed, cfg), metrics = H.analyse(w, ctx);
    return { cfg, w, ctx, metrics, findings: H.judge([{ log: 0, start: 'sim', header: ctx.header, metrics }], H.DEFAULT_RULES) };
}
const within = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);
const find = (F, id, axis, profile) => F.filter(f => f.id === id && (axis === undefined || f.axis === axis) && (profile === undefined || f.profile === profile));
const flagged = (F) => F.filter(f => f.severity === 'flag');
const show = (F) => flagged(F).map(f => `${f.id} ${f.axis || ''} p${f.profile}: ${f.text}`).join('\n');
const replacer = (k, v) => ArrayBuffer.isView(v) ? Array.from(v) : v;
const finite = (o, where = '') => { if (typeof o === 'number') assert.ok(isFinite(o), `non-finite number at ${where}`); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) finite(v, where + '.' + k); };
const AX = ['roll', 'pitch', 'yaw'];

// What C12 counts of the simulated error, for its truth. (1) Only samples with |setpoint| > 5 deg/s (the PID lab's gate):
// the gusts are rho x the setpoint rms over all samples of the profile, so over the gated ones they are rho x gate of the
// setpoint rms there. (2) Gyro and setpoint low-passed at 30 Hz (zero phase, 1 / (1 + (f / fc)^4) of a sine): of the gust
// power (a PT1 at 2 Hz on white noise) the share LOW is left.
const gate = (w, a, p) => { let A = 0, nA = 0, G = 0, nG = 0; for (let i = 0; i < w.n; i++) if (w.profileAt[i] === p) { const v = w.sp[a][i]; A += v * v; nA++; if (Math.abs(v) > 5) { G += v * v; nG++; } } return Math.sqrt((A / nA) / (G / nG)); };
const LOW = (() => { const k = pt1k(2), t = (f) => Math.tan(Math.PI * f / RATE); let all = 0, low = 0;
    for (let f = 0.005; f < RATE / 2; f += 0.01) { const w = 2 * Math.PI * f / RATE, p = k * k / (1 - 2 * (1 - k) * Math.cos(w) + (1 - k) ** 2); all += p; low += p / (1 + (t(f) / t(30)) ** 4) ** 2; }
    return low / all; })();
const truthOf = (R, a, p, gain = R.cfg.axes[a].gain) => Math.hypot(1 - gain, R.cfg.axes[a].rho * gate(R.w, a, p) * Math.sqrt(LOW));
const bandOf = (s, lo, hi) => s.bands.find(q => q.hz[0] === lo && q.hz[1] === hi);

// one self-excited roll oscillation (profile 1), the same error amplitude driven by the stick (profile 2, the gyro
// follows a setpoint that oscillates: error = (1 - e^-j w tau) x setpoint, 1.62 x at 12 Hz and 25 ms), and jolts
const DRIVEN = 1 / (2 * Math.sin(Math.PI * 12 * 0.025));
const clean = run(1);
const track = run(2, (c) => { c.axes[0] = { tau: 0.025, gain: 0.8, rho: 0.3 }; c.axes[1] = { tau: 0.060, gain: 0.5, rho: 0.3 }; c.axes[2] = { tau: 0.030, gain: 1, rho: 0.15, fn: 20, zeta: 0.7 }; c.responseTime = [250, 0, 0]; });
const osc = run(3, (c) => { c.events = [
    { axis: 0, t0: 30, hz: 12, from: 3, to: 220, riseS: 1.2, holdS: 0.3 },
    { axis: 0, t0: 90, hz: 12, from: 3 * DRIVEN, to: 220 * DRIVEN, riseS: 1.2, holdS: 0.3, inSetpoint: true },
    { axis: 0, t0: 75, hz: 10.5, jolt: 200, zeta: 0.2 }, { axis: 2, t0: 30, hz: 10, jolt: 250, zeta: 0.1 }]; }); // roll: touchdown ring of the Gaui (zeta 0.2); yaw: a long ring that starts large
// sustained oscillations 3 s of every 10 s, sized so that the wag band-pass (which passes only part of a sine even
// inside its band) reads 15 deg/s on roll at 14 Hz and 30 deg/s on pitch at 12 Hz
const bandGain = (hz, band) => { const x = Float64Array.from({ length: 20 * RATE }, (_, i) => Math.sin(2 * Math.PI * hz * i / RATE)), y = lib.bandpass(x, band[0], band[1], RATE);
    let s = 0; for (let i = 5 * RATE; i < 15 * RATE; i++) s += y[i] * y[i]; return Math.sqrt(2 * s / (10 * RATE)); };
const GAIN = [bandGain(14, H.RULE.osc.bands.roll), bandGain(12, H.RULE.osc.bands.pitch)];
const shares = run(4, (c) => { c.events = [{ axis: 0, hz: 14, amp: 15 / GAIN[0], every: 10, on: [2, 5] }, { axis: 1, hz: 12, amp: 30 / GAIN[1], every: 10, on: [2, 5] }]; });
// the clean flight with rotor vibration on the gyro: a 40 deg/s sine at 150 Hz on every axis
const vib = run(1, (c) => { c.vib = [[150, 40]]; });

test('a clean flight raises no flag, and its delays, error and stick lag are the ones simulated', () => {
    assert.equal(flagged(clean.findings).length, 0, show(clean.findings));
    const m = clean.metrics;
    assert.equal(m.blocks.count, 12, 'blocks of 10 s of usable time: per profile 59 s (1 s guard at the switch) = 5 of 10 s and one of 9 s');
    for (const [a, ax] of AX.entries()) for (const p of [1, 2]) {
        const s = m.track[ax].byProfile[p];
        within(s.tauMs, clean.cfg.axes[a].tau * 1000, 3, `${ax} p${p} delay`);
        within(s.value, truthOf(clean, a, p), 0.01, `${ax} p${p} tracking error (gusts over |setpoint| > 5 deg/s, below 30 Hz)`);
        assert.ok(s.raw > s.value + 0.02, `${ax}: without the delay the error is larger (${s.raw} against ${s.value})`);
        // the bands split the error power: they add up to all of it
        within(s.bands.reduce((x, q) => x + q.share, 0), 1, 0.002, `${ax} p${p} band shares add up`);
        assert.deepEqual(s.bands.map(q => q.hz), [[0, 0.5], [0.5, 3], [3, 8], [8, 20], [20, 30]]);
        assert.ok(s.above.hz === 30 && s.above.value < 0.05 && s.above.se > 0, `${ax} p${p}: no vibration, ${JSON.stringify(s.above)}`);
    }
    for (const id of ['C12', 'T11']) assert.ok(find(clean.findings, id).every(f => f.severity === 'ok'), `${id} ok`);
    for (const id of ['C13', 'T12', 'R1']) assert.ok(find(clean.findings, id).every(f => f.severity === 'note' && !f.thin && /This value is for information\./.test(f.text)), `${id} report only`);
    // R1: response_time 50 ms = PT1 at 10 Hz, time constant 15.9 ms; none on pitch; 100 ms on yaw, 31.8 ms
    within(m.stick.roll.delayMs, 50 / Math.PI, 3, 'roll stick to setpoint lag');
    within(m.stick.pitch.delayMs, 0, 3, 'pitch stick to setpoint lag');
    within(m.stick.yaw.delayMs, 100 / Math.PI, 3, 'yaw stick to setpoint lag');
    assert.ok(m.stick.yaw.corr < -0.9 && m.stick.roll.corr > 0.9, 'yaw stick and setpoint have opposite signs');
    assert.equal(m.stick.roll.expectedMs, 15.9);
    // the PID gyro low-pass (first order, 50 Hz) delays 10 Hz by 3.0 ms; named for the start profile only, as a setting of
    // the feedback path: the logged gyro is taken before it, so it is no part of the measured delay
    within(m.track.roll.pidLpf.ms, 1000 / (2 * Math.PI * 50) / (1 + (10 / 50) ** 2), 0.1, 'PID gyro low-pass group delay at 10 Hz');
    const c13 = find(clean.findings, 'C13', 'roll', 1)[0];
    within(c13.pidLpfMs, m.track.roll.pidLpf.ms, 1e-9, 'the PID gyro low-pass named on the start profile');
    assert.match(c13.text, /The gyro low-pass filter of the PID loop \(50 Hz in the header\) causes a time delay of 3\.0 ms at 10 Hz\. This filter is only in the feedback.* the measured time delay does not include it\./);
    assert.equal(find(clean.findings, 'C13', 'roll', 2)[0].pidLpfMs, null); assert.doesNotMatch(find(clean.findings, 'C13', 'roll', 2)[0].text, /low-pass filter of the PID loop/);
    for (const ax of AX) for (const p of [1, 2]) { const s = m.osc[ax].byProfile[p]; assert.ok(s.shares[10] < 0.05 && s.shares[20] < 0.01 && !s.selfExcitedBursts.length, `${ax} p${p} quiet: ${JSON.stringify(s.shares)}`); }
    assert.ok(find(clean.findings, 'C5').concat(find(clean.findings, 'T1')).every(f => f.severity === 'ok'));
});

test('no spectrum peak is claimed on a clean flight; a weak sustained oscillation is found at its frequency', () => {
    // the error spectrum of a clean flight falls with frequency and has local maxima everywhere: none is a peak
    for (const ax of AX) for (const p of [1, 2]) {
        const s = clean.metrics.osc[ax].byProfile[p], f = find(clean.findings, ax === 'yaw' ? 'T1' : 'C5', ax, p)[0];
        assert.ok(s.spectrumWindows > 0 && s.peak && !s.peak.clear && s.peakHz === null && s.peakHzSe === null && s.peakInBand === null, `${ax} p${p}: ${JSON.stringify(s.peak)}`);
        assert.ok(s.peak.excessDb < H.RULE.osc.peakMinDb || s.peak.z < H.RULE.osc.peakZ);
        assert.match(f.text, /The error spectrum of these windows has no clear peak at 4-30 Hz \(\d+ windows\)\. The local maximum nearest to a peak is at [\d.]+ Hz\. It is -?[\d.]+ dB more than a line through the spectrum 2-4 Hz from it on each side \(-?[\d.]+ SE\)\. A local maximum is a peak if it is 3 dB or more and 5\.5 SE or more\./);
    }
    // a sustained 2 deg/s sine at 12 Hz on the pitch gyro: well under the 10 deg/s share level, but a line in the spectrum
    const weak = run(5, (c) => { c.events = [{ axis: 1, every: 1, on: [-1, 2], amp: 2, hz: 12 }]; });
    for (const p of [1, 2]) {
        const s = weak.metrics.osc.pitch.byProfile[p], f = find(weak.findings, 'C5', 'pitch', p)[0];
        within(s.peakHz, 12, 0.5, `pitch p${p} peak`); assert.ok(s.peakInBand && s.peak.clear && s.peakHzSe > 0 && s.peakHzSe < 0.3, JSON.stringify(s.peak));
        assert.ok(s.shares[10] < 0.05, 'below the share levels');
        assert.match(f.text, /The error spectrum of these windows has a peak at 1[12]\.\d ± \d\.\d Hz \(\d+ windows\)\. The peak is [\d.]+ dB more than a line through the spectrum 2-4 Hz from it on each side \([\d.]+ SE\)\. A local maximum is a peak if it is 3 dB or more and 5\.5 SE or more\./);
    }
});

test('a known tracking error is measured to 0.02 with an honest standard error', () => {
    // gyro(t + tau) - setpoint(t) = (gain - 1) setpoint + disturbance: error ratio sqrt((1 - gain)^2 + rho'^2), rho' the gusts as C12 counts them
    for (const [a, ax] of ['roll', 'pitch'].entries()) for (const p of [1, 2]) {
        const s = track.metrics.track[ax].byProfile[p];
        within(s.value, truthOf(track, a, p), 0.02, `${ax} p${p} tracking error`);
        within(s.tauMs, track.cfg.axes[a].tau * 1000, Math.max(3, 3 * s.tauSe), `${ax} p${p} delay with a gain deficit, within 3 SE (${s.tauSe} ms)`);
        assert.ok(s.se > 0.003 && s.se < 0.05, `${ax} p${p} SE ${s.se}`);
    }
    assert.equal(find(track.findings, 'C12', 'roll').map(f => f.severity).join(), 'note,note', 'roll 0.35: above the note level, not 2 SE past the flag level');
    assert.equal(find(track.findings, 'C12', 'pitch').map(f => f.severity).join(), 'flag,flag', show(track.findings));
    assert.match(find(track.findings, 'C12', 'pitch')[0].text, /The error is more than 45 % by more than 2 SE\. The gyro does not follow the setpoint at the frequencies of the largest bands\./);
    // a gain deficit shows where the stick is: at 0.5-3 Hz the in-band ratio is at least 1 - gain, against the gusts alone
    // when the gain is 1; and the bands below 3 Hz hold most of the error power
    for (const p of [1, 2]) { const t = track.metrics.track.pitch.byProfile[p], c = clean.metrics.track.pitch.byProfile[p], b = bandOf(t, 0.5, 3).ratio, q = bandOf(c, 0.5, 3).ratio;
        assert.ok(b >= 0.5 && q < 0.3, `pitch p${p} 0.5-3 Hz ratio ${b} with gain 0.5, ${q} with gain 1`);
        const low = (s) => bandOf(s, 0, 0.5).share + bandOf(s, 0.5, 3).share;
        assert.ok(low(t) > 0.85 && low(t) > low(c) + 0.15, `pitch p${p}: error power below 3 Hz ${low(t)} with gain 0.5, ${low(c)} with gain 1`);
        const f = find(track.findings, 'C12', 'pitch', p)[0]; assert.deepEqual(f.bands, t.bands, 'the bands on the finding');
        assert.match(f.text, /The parts of the error power in the frequency bands are \d+ ± \d+ % \(0-0\.5 Hz\), \d+ ± \d+ % \(0\.5-3 Hz\), \d+ ± \d+ % \(3-8 Hz\), \d+ ± \d+ % \(8-20 Hz\) and \d+ ± \d+ % \(20-30 Hz\)\./); }
    // Standard errors against the spread over 30 independent flights of 45 s (5 blocks each). The pitch response time
    // keeps the RC frames from making the setpoint a staircase, which quantises the delay. The bounds catch a halved SE
    // (the dangerous direction: flags are 2-SE tests): over random sets of 30 of 120 flights an honest SE passes 100 %
    // (C12) and 98 % (delay) of the time, a halved one 3 % and 0.2 %
    const vals = [], ses = [], taus = [], tauSes = [], truths = [];
    for (let seed = 11; seed <= 40; seed++) { const R = run(seed, (c) => { c.seconds = 45; c.switchS = null; c.responseTime = [50, 50, 100]; c.axes[1] = { tau: 0.06, gain: 0.5, rho: 0.3 }; }), s = R.metrics.track.pitch.all;
        vals.push(s.value); ses.push(s.se); taus.push(s.tauMs); tauSes.push(s.tauSe); truths.push(truthOf(R, 1, 1)); }
    const sd = (v) => { const m = v.reduce((x, y) => x + y, 0) / v.length; return Math.sqrt(v.reduce((x, y) => x + (y - m) ** 2, 0) / (v.length - 1)); }, mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
    within(mean(vals), mean(truths), 0.01, 'mean over 30 flights');
    const q = sd(vals) / mean(ses), qt = sd(taus) / mean(tauSes);
    assert.ok(q > 0.5 && q < 1.3, `spread of the error ratio over flights ${sd(vals).toFixed(4)} against its mean SE ${mean(ses).toFixed(4)}: ${q.toFixed(2)}`);
    assert.ok(qt > 0.5 && qt < 1.3, `spread of the delay over flights ${sd(taus).toFixed(2)} ms against its mean SE ${mean(tauSes).toFixed(2)} ms: ${qt.toFixed(2)}`);
});

test('gyro vibration above 30 Hz is reported apart, not as tracking error', () => {
    // a 40 deg/s sine at 150 Hz: no loop follows it. Full band it would read 0.5 of the setpoint rms and flag C12
    for (const [a, ax] of AX.entries()) for (const p of [1, 2]) {
        const s = vib.metrics.track[ax].byProfile[p], c = clean.metrics.track[ax].byProfile[p];
        within(s.value, c.value, 0.002, `${ax} p${p} C12 as on the clean flight`); within(s.tauMs, c.tauMs, 0.5, `${ax} p${p} delay`);
        within(s.above.value, Math.hypot(c.above.value, 40 / Math.SQRT2 / s.setpointRms), 0.01, `${ax} p${p} gyro above 30 Hz as a share of the setpoint rms`);
        assert.ok(s.above.value > 0.15 && s.above.se > 0, JSON.stringify(s.above));
        const f = find(vib.findings, ax === 'yaw' ? 'T11' : 'C12', ax, p)[0];
        assert.equal(f.severity, 'ok', f.text);
        assert.deepEqual(f.above, s.above);
        assert.match(f.text, /The gyro at more than 30 Hz is \d+\.\d ± \d+\.\d % of the setpoint rms, and the check does not include this vibration \(F1, F5, F6\)\./);
    }
    // the error curves have it left out too
    const cv = H.curves(vib.w, vib.ctx, vib.metrics), cc = H.curves(clean.w, clean.ctx, clean.metrics), ss = (x) => x.reduce((q, v) => q + (isFinite(v) ? v * v : 0), 0);
    for (const ax of AX) { assert.equal(cv[ax].lpHz, 30); within(ss(cv[ax].time.errComp) / ss(cc[ax].time.errComp), 1, 0.01, `${ax} errComp`); within(ss(cv[ax].time.err) / ss(cc[ax].time.err), 1, 0.01, `${ax} err`); }
    // the low-pass itself: 1 / (1 + (f / fc)^4) of a sine, f and fc prewarped (bilinear), zero phase
    const t = (f) => Math.tan(Math.PI * f / RATE);
    for (const hz of [7.5, 30, 60, 150]) {
        const want = 1 / (1 + (t(hz) / t(30)) ** 4), x = Float64Array.from({ length: 4 * RATE }, (_, i) => Math.sin(2 * Math.PI * hz * i / RATE)), y = H.lowpass(x, 30, RATE);
        let xy = 0, xx = 0; for (let i = RATE; i < 3 * RATE; i++) { xy += x[i] * y[i]; xx += x[i] * x[i]; }
        within(xy / xx, want, 0.01 * want + 2e-4, `low-pass gain at ${hz} Hz`);
    }
});

test('samples with the stick centred do not count, as in the PID lab', () => {
    // the clean flight with the sticks centred in the first half of every 10 s (setpoint 0, and the stick part of the gyro
    // with it) while the gusts go on. The PID lab's formula scores only samples with |setpoint| > 5 deg/s, so C12 stays the
    // gusts against the setpoint where the stick moves, as on the clean flight; counting the rest too would raise it by
    // sqrt(all samples / those)
    const w = Object.assign({}, clean.w, { sp: clean.w.sp.map(v => Float64Array.from(v)), gyro: clean.w.gyro.map(v => Float64Array.from(v)) });
    for (let a = 0; a < 3; a++) { const lag = Math.round(clean.cfg.axes[a].tau * RATE), s0 = clean.w.sp[a];
        for (let i = 0; i < w.n; i++) if ((i / RATE) % 10 < 5) w.sp[a][i] = 0;
        for (let i = lag; i < w.n; i++) w.gyro[a][i] += w.sp[a][i - lag] - s0[i - lag]; }
    const m = H.analyse(w, clean.ctx), T = H.RULE.track, gate0 = T.minAbsSetpoint; let all;
    T.minAbsSetpoint = -1; try { all = H.analyse(w, clean.ctx); } finally { T.minAbsSetpoint = gate0; }
    for (const ax of AX) for (const p of [1, 2]) {
        const s = m.track[ax].byProfile[p], c = clean.metrics.track[ax].byProfile[p], u = all.track[ax].byProfile[p], q = Math.sqrt(u.seconds / s.seconds);
        // (half of the flight: the gusts there differ from those of all of it by sampling, about 10 %)
        within(s.value, c.value, 0.15 * c.value, `${ax} p${p}: the gusts against the setpoint where the stick moves`);
        within(s.seconds / s.blocks, c.seconds / c.blocks / 2, 0.1 * c.seconds / c.blocks, `${ax} p${p}: half of the samples of a block count`); // a block can drop below 20 deg/s rms
        within(u.value / s.value, q, 0.08 * q, `${ax} p${p}: the stick-free samples counted too`);
        assert.ok(u.value > 1.3 * s.value, `${ax} p${p}: ${u.value} against ${s.value}`);
    }
});

test('rescue is left out, with or without a normal mask from health_more', () => {
    // rescue at 30-40 s flies its own setpoint: the gyro does something else than the logged (pilot's) setpoint
    const w = Object.assign({}, clean.w, { gyro: clean.w.gyro.map(v => Float64Array.from(v)), rescueAt: new Uint8Array(clean.w.n) });
    w.rescueAt.fill(1, 30 * RATE, 40 * RATE); for (let a = 0; a < 3; a++) for (let i = 30 * RATE; i < 40 * RATE; i++) w.gyro[a][i] = Math.round(-0.5 * w.sp[a][i] + 80 * Math.sin(i / 300));
    const U = H.usable(w, clean.ctx);
    assert.ok(U.ok[29 * RATE - 1] === 1 && U.ok[29 * RATE] === 0 && U.ok[41 * RATE - 1] === 0 && U.ok[41 * RATE] === 1, 'rescue widened by the 1 s guard');
    // the same as flying masked over the rescue and its guard, as health_more.normalMask does
    const ctxMasked = Object.assign({}, clean.ctx, { flying: Uint8Array.from(clean.ctx.flying, (v, i) => i >= 29 * RATE && i < 41 * RATE ? 0 : v) });
    const a = H.analyse(w, clean.ctx), b = H.analyse(Object.assign({}, w, { rescueAt: null }), ctxMasked), c = H.analyse(Object.assign({}, w, { rescueAt: null }), clean.ctx);
    assert.deepEqual(a.track, b.track); assert.deepEqual(a.osc, b.osc);
    assert.ok(c.track.roll.byProfile[1].value > a.track.roll.byProfile[1].value + 0.1, `kept in, rescue would read as tracking error: ${c.track.roll.byProfile[1].value} against ${a.track.roll.byProfile[1].value}`);
    within(a.track.roll.byProfile[1].value, clean.metrics.track.roll.byProfile[1].value, 0.02, 'C12 as on the clean flight');
});

test('a second-order response adds its group delay to the transport delay', () => {
    // 20 Hz, zeta 0.7: 2 zeta / wn = 11.1 ms at stick frequencies
    for (const p of [1, 2]) within(track.metrics.track.yaw.byProfile[p].tauMs, 30 + 2 * 0.7 / (2 * Math.PI * 20) * 1000, 3, `yaw p${p} delay`);
});

test('a slow stick to setpoint filter is flagged, a fast one reported', () => {
    // response_time 250 ms: PT1 at 2 Hz, time constant 79.6 ms; the lag during stick motion is shorter but far past 40 ms
    const s = track.metrics.stick.roll, f = find(track.findings, 'R1', 'roll')[0];
    assert.ok(s.delayMs > 55 && s.delayMs < 80, `roll lag ${s.delayMs} ms`);
    assert.equal(f.severity, 'flag', f.text);
    assert.match(f.text, /In the header, response_time is 250 \(a PT1 filter with a time constant of 79\.6 ms\)/);
    assert.equal(find(track.findings, 'R1', 'pitch')[0].severity, 'note');
});

test('a self-excited roll oscillation is flagged; the same amplitude driven by the stick and touchdown jolts are not', () => {
    const p1 = find(osc.findings, 'C5', 'roll', 1)[0], p2 = find(osc.findings, 'C5', 'roll', 2)[0];
    assert.equal(p1.severity, 'flag', p1.text);
    assert.equal(p1.value, 1);
    assert.equal(p1.unit, 'count');
    within(p1.events[0].t, 30, 1.2, 'onset time of the self-excited burst');
    assert.match(p1.text, /^The number of roll oscillations at 10-20 Hz that increase with no stick input is 1 of \d+\. /);
    const ev = osc.metrics.osc.roll.events, self = ev.find(e => e.selfExcited), driven = ev.find(e => e.t > 89 && e.t < 92), jolt = ev.find(e => e.t > 74 && e.t < 76);
    within(self.hz, 12, 0.5, 'burst frequency');
    // its size is band-passed (the 10-20 Hz band passes 0.60 of a 12 Hz sine); as a sine it is the 220 deg/s simulated
    within(self.value, 220 * H.bandGain(12, [10, 20], RATE), 15, 'band-passed peak'); within(self.sine, 220, 15, 'as a sine');
    assert.match(p1.text, /The largest is \d+ deg\/s after the filter \(approximately 2\d\d deg\/s before the filter\), at 12\.0 Hz at 3\d\.\d s\./);
    assert.ok(driven && !driven.selfExcited && driven.stickShare > 0.5, `driven burst ${JSON.stringify(driven)}`);
    within(driven.value / self.value, 1, 0.2, 'the driven burst is as large as the self-excited one');
    assert.ok(!jolt || !jolt.selfExcited, `roll jolt ${JSON.stringify(jolt)}`);
    assert.notEqual(p2.severity, 'flag', p2.text);
    const y = find(osc.findings, 'T1', 'yaw', 1)[0];
    assert.notEqual(y.severity, 'flag', y.text);
    assert.ok(osc.metrics.osc.yaw.events.some(e => e.t > 29.5 && e.t < 30.5 && e.value > 50 && e.seconds > 0.3 && !e.selfExcited), JSON.stringify(osc.metrics.osc.yaw.events.slice(0, 3)));
});

test('shares of stick-free time at 10, 20 and 40 deg/s match a sustained oscillation, with its frequency', () => {
    assert.ok(GAIN[0] > 0.55 && GAIN[0] < 0.75, `the band-pass passes ${GAIN[0].toFixed(2)} of a 14 Hz sine`);
    within(H.bandGain(14, H.RULE.osc.bands.roll, RATE), GAIN[0], 0.005, 'bandGain of the module, roll 14 Hz'); within(H.bandGain(12, H.RULE.osc.bands.pitch, RATE), GAIN[1], 0.005, 'pitch 12 Hz');
    assert.deepEqual(shares.metrics.osc.roll.gain, [0.47, 0.64]); assert.deepEqual(shares.metrics.osc.yaw.gain, [0.5, 0.83]);
    for (const p of [1, 2]) {
        const r = shares.metrics.osc.roll.byProfile[p], q = shares.metrics.osc.pitch.byProfile[p];
        within(r.shares[10], 0.3, 0.03, `roll p${p} share >= 10`); within(r.shares[20], 0, 0.01, `roll p${p} share >= 20`);
        within(q.shares[20], 0.3, 0.03, `pitch p${p} share >= 20`); within(q.shares[40], 0, 0.01, `pitch p${p} share >= 40`);
        assert.ok(r.sharesSe[10] > 0 && r.sharesSe[10] < 0.08, `roll share SE ${r.sharesSe[10]}`); // small: the on/off period is the block length
        within(r.peakHz, 14, 0.5, `roll p${p} spectrum peak`); within(q.peakHz, 12, 0.5, `pitch p${p} spectrum peak`);
        assert.ok(r.peakInBand && q.peakInBand && r.peakHzSe < 0.3 && q.peakHzSe < 0.3);
        assert.equal(find(shares.findings, 'C5', 'roll', p)[0].severity, 'ok', 'roll: under 20 deg/s');
        const f = find(shares.findings, 'C5', 'pitch', p)[0];
        assert.ok(f.severity === 'note' && !f.thin, JSON.stringify(f)); assert.match(f.text, /^The pitch error has an oscillation at 8-16 Hz\. /);
        assert.match(f.text, /\nThe analysis applies a filter to the pitch error \(the gyro minus the setpoint\) and keeps only the 8-16 Hz band\. The gain of this filter is 0\.47 to 0\.64 in the band\.\n/);
    }
    assert.equal(flagged(shares.findings).filter(f => /C5|T1/.test(f.id)).length, 0, 'sustained but not growing: no flag');
});

test('stick-free windows from a single block are thin: no standard error, no judgement', () => {
    // profile 2 flown for 12 s (one block) with the pitch oscillation of `shares`: 22 stick-free windows, a quarter of them
    // >= 20 deg/s, but all in one block, so the share has no standard error and its rule (share - 2 SE > 0.05) cannot be applied
    const one = run(5, (c) => { c.switchS = 108; c.events = [{ axis: 1, hz: 12, amp: 30 / GAIN[1], every: 10, on: [2, 5] }]; });
    const s = one.metrics.osc.pitch.byProfile[2], f = find(one.findings, 'C5', 'pitch', 2)[0];
    assert.ok(s.blocks === 1 && s.stickFree >= H.DEFAULT_RULES.C5.minWindows && s.shares[20] > 0.2 && s.sharesSe[20] === null, JSON.stringify(s.shares));
    assert.ok(f.severity === 'note' && f.thin === true, JSON.stringify(f));
    assert.match(f.text, new RegExp(`^The data is not sufficient for a result\\. The number of periods of 10 s with windows where the stick does not cause the error is 1\\. A minimum of ${H.DEFAULT_RULES.C5.minBlocks} is necessary for a standard error\\.\n`));
    const q = find(one.findings, 'C5', 'pitch', 1)[0]; assert.ok(q.severity === 'note' && !q.thin && /^The pitch error has an oscillation/.test(q.text), 'profile 1 has the blocks');
});

test('two blocks are thin too: a jackknife over two has one degree of freedom', () => {
    const s = { windows: 40, stickFree: 40, stickDriven: 0, blocks: 2, shares: { 10: 0.5, 20: 0.4, 40: 0.1 }, sharesSe: { 10: 0.01, 20: 0.01, 40: 0.01 }, median: 15, p99: 45,
        spectrumWindows: 0, peak: null, peakHz: null, peakHzSe: null, peakInBand: null, bursts: 0, selfExcitedBursts: [] };
    const F = H.judge([{ log: 0, metrics: { osc: { pitch: { band: [8, 16], gain: [0.47, 0.64], byProfile: { 1: s }, all: s } } } }]), f = find(F, 'C5', 'pitch', 1)[0];
    assert.deepEqual([H.RULE.minJack, H.DEFAULT_RULES.C5.minBlocks, H.DEFAULT_RULES.T1.minBlocks], [3, 3, 3]);
    assert.ok(f.severity === 'note' && f.thin === true); assert.match(f.text, /^The data is not sufficient for a result\. The number of periods of 10 s with windows where the stick does not cause the error is 2\. A minimum of 3 is necessary for a standard error\./);
});

test('thin data and missing fields are said, not judged', () => {
    const cfg = BASE(); cfg.seconds = 25; cfg.switchS = null;
    const { w, ctx } = simulate(7, cfg), F = H.judge([{ log: 0, metrics: H.analyse(w, ctx) }]);
    assert.ok(find(F, 'C12').concat(find(F, 'T11'), find(F, 'C13'), find(F, 'R1')).every(f => f.severity === 'note' && f.thin === true && /^The data is not sufficient for a result\. The number of periods of 10 s with /.test(f.text)), F.map(f => `${f.id} ${f.severity} ${f.text}`).join('\n'));
    assert.match(find(F, 'C12', 'roll')[0].text, /^The data is not sufficient for a result\. The number of periods of 10 s with a roll setpoint of 20 deg\/s rms or more is [0-3] of 3\. A minimum of 4 is necessary\.$/);
    // no rcCommand, no GOVSTATE
    const w2 = Object.assign({}, clean.w, { extra: {} }), ctx2 = Object.assign({}, clean.ctx, { govState: null }), m = H.analyse(w2, ctx2);
    assert.ok(AX.every(ax => m.stick[ax].skipped === `The log does not have rcCommand[${AX.indexOf(ax)}].`));
    assert.ok(m.notes.some(s => /^The log does not record GOVSTATE\./.test(s)) && m.notes.includes('The log does not have rcCommand for roll, pitch and yaw. Thus, the analysis does not do check R1 for these axes.'), m.notes.join('\n'));
    const G = H.judge([{ log: 0, metrics: m }]);
    assert.deepEqual(find(G, 'R1').map(f => [f.severity, f.unit]), [['skipped', 'ms'], ['skipped', 'ms'], ['skipped', 'ms']]);
    assert.ok(find(G, 'C12').length && find(G, 'C12').every(f => f.severity !== 'skipped'), 'the rest still runs');
    // under 5 s usable: every check skipped, with the reason
    const ctx3 = Object.assign({}, clean.ctx, { flying: new Uint8Array(clean.w.n) }); ctx3.flying.fill(1, 0, 3000);
    const S = H.judge([{ log: 0, metrics: H.analyse(clean.w, ctx3) }]);
    assert.deepEqual([...new Set(S.map(f => f.severity))], ['skipped']); assert.deepEqual(S.map(f => f.id).sort(), Object.keys(H.DEFAULT_RULES).sort());
    assert.equal(S[0].text, 'The log has only 3 s of flight data that the checks can use. A minimum of 5 s is necessary.');
    assert.deepEqual(S.map(f => f.unit).sort(), ['fraction', 'fraction', 'fraction', 'fraction', 'ms', 'ms', 'ms'], 'skipped findings carry the unit of their check');
    // a log the module never saw (no metrics) gives nothing
    assert.deepEqual(H.judge([{ log: 1, metrics: null }]), []);
});

test('a 250 Hz log and a missing FFT host', () => {
    // every 4th sample of the oscillation flight: the delay grid is 4 ms, the bands and the onset rule still fit
    const D = 4, n = Math.floor(osc.w.n / D), dec = (x) => x && Float64Array.from({ length: n }, (_, i) => x[i * D]), dec8 = (x) => x && Uint8Array.from({ length: n }, (_, i) => x[i * D]);
    const w = Object.assign({}, osc.w, { n, rate: 250, sp: osc.w.sp.map(dec), gyro: osc.w.gyro.map(dec), hs: dec(osc.w.hs), profileAt: dec8(osc.w.profileAt), airborneAt: dec8(osc.w.airborneAt),
        extra: Object.fromEntries(Object.entries(osc.w.extra).map(([k, v]) => [k, dec(v)])) });
    const ctx = Object.assign({}, osc.ctx, { rate: 250, flying: dec8(osc.ctx.flying), profile: dec8(osc.ctx.profile), govState: dec8(osc.ctx.govState) }), m = H.analyse(w, ctx);
    for (const [a, ax] of AX.entries()) within(m.track[ax].all.tauMs, osc.cfg.axes[a].tau * 1000, 4, `${ax} delay at 250 Hz`);
    within(m.stick.roll.delayMs, 50 / Math.PI, 4, 'roll stick lag at 250 Hz');
    assert.equal(find(H.judge([{ log: 0, metrics: m }]), 'C5', 'roll', 1)[0].severity, 'flag');
    const c = H.curves(w, ctx, m); assert.ok(c.roll.spectrum.f[c.roll.spectrum.f.length - 1] <= 60 && c.roll.time.t.length === 1200);
    // without an FFT host the spectra are left out and said so; the rest stands
    const ctx0 = Object.assign({}, osc.ctx, { app: null }), m0 = H.analyse(osc.w, ctx0);
    assert.ok(m0.notes.some(q => /^The FFT is not available/.test(q)) && m0.osc.roll.all.peakHz === null && m0.osc.roll.all.peak === null && H.curves(osc.w, ctx0, m0).roll.spectrum === null);
    const F0 = H.judge([{ log: 0, metrics: m0 }]);
    assert.equal(find(F0, 'C5', 'roll', 1)[0].severity, 'flag');
    assert.match(find(F0, 'C5', 'roll', 2)[0].text, /\nThe analysis cannot calculate an error spectrum for these windows\. The log has no period of 2 s with only these windows, or the FFT is not available\.$/);
});

test('findings carry number, uncertainty, rule, source and unit; metrics are JSON-safe; inputs are not changed', () => {
    for (const R of [clean, track, osc, shares, vib]) {
        finite(R.metrics); assert.doesNotThrow(() => JSON.parse(JSON.stringify(R.metrics)));
        for (const f of R.findings) {
            assert.ok(f.unit && f.source && typeof f.text === 'string' && 'value' in f && (f.se === null || typeof f.se === 'number') && 'n' in f, JSON.stringify(f));
            if (f.severity === 'flag') assert.ok(f.threshold && typeof f.value === 'number', JSON.stringify(f));
            // a flag on a rule with a level is a 2-SE test that passed
            const lvl = H.DEFAULT_RULES[f.id].flag;
            if (f.severity === 'flag' && typeof lvl === 'number') assert.ok(typeof f.se === 'number' && f.value - 2 * f.se > lvl, JSON.stringify(f));
            if (f.events) assert.ok(f.events.length <= 200 && f.events.every(e => typeof e.t === 'number'));
            assert.equal(!!f.thin, /^The data is not sufficient for a result\./.test(f.text), `thin is a field: ${JSON.stringify(f)}`);
            assert.doesNotMatch(f.text, /;|\+-|>=|<=|no finding/, `${f.id}: ${f.text}`);
        }
    }
    assert.ok(flagged(track.findings).some(f => f.id === 'C12') && flagged(track.findings).some(f => f.id === 'R1'), 'the 2-SE check above saw flags');
    const sumOf = (o) => { let s = 0; for (const v of Object.values(o)) if (ArrayBuffer.isView(v)) for (let i = 0; i < v.length; i += 7) s += v[i] * (i % 13 + 1); else if (Array.isArray(v)) s += sumOf(v); return s; };
    const before = sumOf(clean.w) + sumOf(clean.w.extra) + sumOf(clean.ctx);
    H.analyse(clean.w, clean.ctx); H.curves(clean.w, clean.ctx, clean.metrics);
    assert.equal(sumOf(clean.w) + sumOf(clean.w.extra) + sumOf(clean.ctx), before);
});

test('C12 and C13 keep their worst blocks with times: a gain deficit in one block of 10 s is the first', () => {
    // the clean flight with the roll gyro at half the setpoint in 30-40 s (profile 1): error there (1 - 0.5) x setpoint and the gusts
    const lag = Math.round(clean.cfg.axes[0].tau * RATE), w = Object.assign({}, clean.w, { gyro: clean.w.gyro.map(v => Float64Array.from(v)) });
    for (let i = 30 * RATE + lag; i < 40 * RATE + lag; i++) w.gyro[0][i] = Math.round(w.gyro[0][i] - 0.5 * clean.w.sp[0][i - lag]);
    const m = H.analyse(w, clean.ctx), s = m.track.roll.byProfile[1], c = clean.metrics.track.roll.byProfile[1];
    assert.equal(s.worst.length, H.RULE.worst);
    assert.deepEqual([s.worst[0].t0, s.worst[0].t1], [30, 40], 'the block with the deficit, in index time (fromS 0, 1 kHz)');
    within(s.worst[0].value, Math.hypot(0.5, c.value), 0.04, 'its error: the deficit and the gusts of the clean flight');
    assert.ok(s.worst.every((q, k) => q.t1 > q.t0 && q.t0 >= 0 && q.t1 <= 59 && q.setpointRms > 20 && (k === 0 || q.value <= s.worst[k - 1].value)), JSON.stringify(s.worst));
    assert.ok(s.worst[1].value < 0.25, 'the other blocks have the clean error');
    const all = m.track.roll.all.worst[0]; // at the delay fitted on all profiles
    assert.deepEqual([all.t0, all.t1], [30, 40], 'all profiles: the same block first'); within(all.value, s.worst[0].value, 0.01, 'at the pooled delay');
    // profile 2 (60-120 s, 1 s guard at the switch) and the clean flight: their blocks, the largest error first
    assert.ok(m.track.roll.byProfile[2].worst.every(q => q.t0 >= 61 && q.t1 <= 120), JSON.stringify(m.track.roll.byProfile[2].worst));
    assert.ok(c.worst[0].value < 0.25 && c.worst.every(q => q.value <= c.worst[0].value));
    assert.deepEqual([s.worst[0].seconds, s.worst[0].runs], [10, [[30, 40]]], 'a block of one run');
    // profile 2 flown in 33-37 s (unusable 32-38 s with the guard): the profile 1 block from 30 s continues at 38 s, in two runs
    const prof = Uint8Array.from(clean.ctx.profile); prof.fill(2, 33 * RATE, 37 * RATE);
    const split = H.analyse(w, Object.assign({}, clean.ctx, { profile: prof })).track.roll.byProfile[1].worst[0]; // the deficit (30-40 s) is in it
    assert.ok(split.t0 === 30 && split.t1 === 46 && split.seconds === 10, JSON.stringify(split));
    assert.deepEqual(split.runs, [[38, 46], [30, 32]], 'its runs, the longest first');
    // the blocks of usable(): first and last sample, a block of the profile of the switch ends at the guard
    const U = H.usable(clean.w, clean.ctx);
    assert.deepEqual(U.blocks.map(b => [b.i0, b.i1]).slice(0, 6), [[0, 10000], [10000, 20000], [20000, 30000], [30000, 40000], [40000, 50000], [50000, 59000]]);
});

test('R1 keeps its blocks with times and their share of the stick motion', () => {
    // the roll stick at 3 times its movement in 40-50 s: that block has about 9 times the stick-rate power of another block
    const rc = Float64Array.from(clean.w.extra['rcCommand[0]']); for (let i = 40 * RATE; i < 50 * RATE; i++) rc[i] *= 3;
    const w = Object.assign({}, clean.w, { extra: Object.assign({}, clean.w.extra, { 'rcCommand[0]': rc }) }), st = H.analyse(w, clean.ctx).stick.roll, B = st.blocksAt;
    assert.equal(B.length, st.blocks); within(B.reduce((x, q) => x + q.value, 0), 1, 0.002, 'shares add up');
    assert.deepEqual([B[0].t0, B[0].t1], [40, 50]); assert.ok(B[0].value > 0.3 && B.every((q, k) => k === 0 || q.value <= B[k - 1].value), JSON.stringify(B.slice(0, 3)));
    assert.ok(B.every(q => q.movingS > 1 && q.movingS <= 10.0001 && q.t1 - q.t0 >= 9), JSON.stringify(B));
    within(st.delayMs, 50 / Math.PI, 3, 'the lag is the same');
    assert.ok(clean.metrics.stick.roll.blocksAt.length === clean.metrics.stick.roll.blocks && !clean.metrics.stick.pitch.blocksAt.some(q => q.value > 0.5));
});

test('curves: series, spectra and error by setpoint size, JSON-safe and compact, within the time budget', () => {
    const cfg = BASE(); cfg.seconds = 300; cfg.switchS = 150;
    const { w, ctx } = simulate(21, cfg);
    const t0 = process.hrtime.bigint(), m = H.analyse(w, ctx), t1 = process.hrtime.bigint(), c = H.curves(w, ctx, m), t2 = process.hrtime.bigint();
    const msA = Number(t1 - t0) / 1e6, msC = Number(t2 - t1) / 1e6;
    // half of the budget shared with health_more.cjs: <= 0.5 s per 100 s of 1 kHz log
    assert.ok(msA + msC <= 1500, `analyse ${msA.toFixed(0)} ms + curves ${msC.toFixed(0)} ms for 300 s`);
    const text = JSON.stringify(c, replacer);
    assert.ok(text.length < 1.5e6, `curves ${text.length} bytes`);
    const back = JSON.parse(text);
    for (const [a, ax] of AX.entries()) {
        const k = c[ax], T = k.time;
        assert.ok(T.t instanceof Float32Array && T.stickDriven instanceof Uint8Array && T.usable instanceof Uint8Array);
        assert.equal(T.t.length, 3000); within(T.t[1] - T.t[0], 0.1, 1e-6, 'step');
        assert.equal(k.tauMs, m.track[ax].all.tauMs); assert.equal(k.lpHz, 30);
        assert.equal(T.usable[1500], 0, 'the guard at the profile switch is not usable'); assert.equal(T.usable[100], 1);
        let e2 = 0, c2 = 0; for (let i = 0; i < T.t.length; i++) { e2 += T.err[i] ** 2; c2 += T.errComp[i] ** 2; }
        within(Math.sqrt(c2 / e2), m.track[ax].all.value / m.track[ax].all.raw, 0.05, `${ax}: delay-compensated over plain error in the series and in C12`);
        const S = k.spectrum, f2 = S.f.findIndex(f => f >= 2);
        assert.ok(S.windows > 250 && S.f[S.f.length - 1] <= 60 && S.f[0] > 0, `spectrum: ${S.windows} windows to ${S.f[S.f.length - 1]} Hz`);
        within(S.Tmag[f2], 1, 0.1, `${ax} closed-loop gain at 2 Hz`);
        within(S.Tdeg[f2], -360 * S.f[f2] * cfg.axes[a].tau, 4, `${ax} phase at 2 Hz is the delay`);
        assert.ok(S.coh[f2] > 0.9, `${ax} coherence ${S.coh[f2]}`);
        assert.deepEqual(S.band, H.RULE.osc.bands[ax]);
        const E = k.errVsSp, used = E.n.reduce((s, v) => s + v, 0) + E.above;
        assert.equal(E.edges.length, E.meanAbsErr.length + 1); assert.equal(used, Array.from(H.usable(w, ctx).ok).reduce((s, v) => s + v, 0));
        assert.ok(back[ax].time.t.length === 3000 && Array.isArray(back[ax].spectrum.rr));
    }
});
