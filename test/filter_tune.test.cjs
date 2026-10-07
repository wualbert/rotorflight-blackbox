'use strict';

// tools/autotune/filter_tune.cjs: the replica of the Rotorflight 4.6.0 gyro filter chain, parity, search and validation.
// Ground truth: closed-form filter responses, a sine through the time domain, and synthetic flight logs whose gyroADC is
// made by the replica with known settings (so parity must pass) or with other settings than the header (so it must fail).
// AUTOTUNE_FILTER_LOG=<Fireball fireball_0929_3.bbl> [AUTOTUNE_FILTER_CLI=<fireball_cli_dump.txt>] adds a real-log test.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const FT = require('../tools/autotune/filter_tune.cjs');

const mag = (c, fs0, f) => { const re = [1], im = [0]; FT.mulSection(c, fs0, [f], re, im); return Math.hypot(re[0], im[0]); };

test('firmware coefficients: notch, first order, PT1, PT2, biquad LPFs, difFilter, notch Q', () => {
    const fs0 = 1000;
    const n = FT.biquad('notch', 150, fs0, 4);
    assert.ok(mag(n, fs0, 150) < 1e-9, 'a notch is zero at its centre');
    assert.ok(Math.abs(mag(n, fs0, 0.01) - 1) < 1e-6, 'and 1 at DC');
    // -3 dB width of the RBJ notch: alpha = tan(dw / 2); |H| is near 0.707 at the half-width points
    const al = Math.sin(2 * Math.PI * 150 / fs0) / 8, dw = 2 * Math.atan(al), w0 = 2 * Math.PI * 150 / fs0, edges = [w0 - dw / 2, w0 + dw / 2];
    for (const w of edges) { const m = mag(n, fs0, w * fs0 / (2 * Math.PI)); assert.ok(Math.abs(m - Math.SQRT1_2) < 0.03, `|H| at an edge ${m}`); }
    assert.ok(Math.abs(mag(FT.firstOrderLpf(100, fs0), fs0, 100) - Math.SQRT1_2) < 1e-9, 'bilinear first order: -3 dB at the cutoff');
    assert.strictEqual(FT.pt1Gain(100, fs0), 100 / (100 + fs0 / (2 * Math.PI)));
    assert.strictEqual(FT.pt1Gain(900, fs0), FT.pt1Gain(475, fs0), 'limitCutoff at 0.475 fs');
    const pt2 = FT.lowpassSections(4, 50, 8000), m2 = pt2.reduce((p, c) => p * mag(c, 8000, 50), 1);
    assert.ok(Math.abs(m2 - Math.SQRT1_2) < 0.02, `PT2 -3 dB at its cutoff when fc << fs, within the backward-difference error (${m2})`);
    assert.ok(Math.abs(FT.lowpassSections(7, 100, 2000).reduce((p, c) => p * mag(c, 2000, 100), 1) - Math.SQRT1_2) < 1e-6, 'Butterworth biquad: -3 dB at fc');
    assert.strictEqual(FT.lowpassSections(0, 100, 2000).length, 0, 'NONE: no section');
    const d = FT.difSection(35, fs0); assert.ok(Math.abs(mag(d, fs0, 2) / (2 * Math.PI * 2) - 1) < 0.01, 'difFilter is a derivative far below its cutoff');
    assert.deepStrictEqual(FT.difSection(0, fs0), [0, 0, 0, 0, 0], 'd_cutoff 0 gives no D-term (difFilterUpdate a = b = 0)');
    for (const Q of [2, 3, 5, 8]) { const co = FT.notchCutoffFor(240, Q); assert.ok(Math.abs(FT.notchQ(240, co) - Q) / Q < 0.05, `notchQ(notchCutoffFor) for Q ${Q}`); }
});

// a header like the Fireball (1 kHz gyro, PID and filter rate, 1 kHz log: no logging offset), RPM preset 1, no LPF
function header(over = {}) {
    const h = { looptime: 1000, pid_process_denom: 1, filter_process_denom: 1, frameIntervalPNum: 1, frameIntervalPDenom: 1, features: (1 << 30),
        gyro_soft_type: 0, gyro_lowpass_hz: 0, gyro_soft2_type: 0, gyro_lowpass2_hz: 50, gyro_lowpass_dyn_hz: [0, 0], gyro_notch_hz: [0, 0], gyro_notch_cutoff: [0, 0],
        dyn_notch_count: 6, dyn_notch_q: 25, dyn_notch_min_hz: 20, dyn_notch_max_hz: 240, gyro_rpm_notch_preset: 1, gyro_rpm_notch_min_hz: 20,
        rollBW: [80, 35, 35], pitchBW: [80, 35, 35], yawBW: [200, 40, 40], rollPID: [50, 100, 15, 100, 25], pitchPID: [90, 100, 38, 100, 70], yawPID: [45, 105, 10, 10, 10] };
    for (const ax of ['roll', 'pitch', 'yaw']) { const p = FT.PRESETS[1][['roll', 'pitch', 'yaw'].indexOf(ax)], pad = (a) => Array.from({ length: 16 }, (_, i) => a[i] || 0);
        h[`gyro_rpm_notch_source_${ax}`] = pad(p.source); h[`gyro_rpm_notch_q_${ax}`] = pad(p.q); h[`gyro_rpm_notch_center_${ax}`] = pad(p.center); }
    return Object.assign(h, over);
}
const GEAR = { main: [1, 1], tail: [19, 76], motorisedTail: false };

test('configuration: header first, presets overwrite the banks, gear ratios from the CLI, rates and logging offset', () => {
    const cfg = FT.config(header(), { gear: GEAR });
    const banks = FT.effectiveBanks(cfg.s);
    assert.deepStrictEqual(banks[0].map(b => b.source), [11, 12, 14, 21]);
    assert.deepStrictEqual(banks[2].map(b => b.q), [80, 40, 50]);
    const M = FT.compile(cfg);
    assert.strictEqual(M.rpm[0].find(b => b.source === 21).order, 4, 'tail 19,76: 4 x the headspeed');
    assert.strictEqual(M.dyn.on, false, 'feature DYN_NOTCH is off in the header');
    const p3 = FT.effectiveBanks(FT.withSettings(cfg, { gyro_rpm_notch_preset: 3 }).s);
    assert.strictEqual(p3[0].length, 10); assert.deepStrictEqual(p3[0].slice(1, 3).map(b => b.center), [-33, 33], 'LNC2(30) = -1000/30 in integer division');
    const cli = 'diff all\nfeature DYN_NOTCH\nset gyro_lpf1_type = PT1\nset tail_rotor_gear_ratio = 19,76\nprofile 0\nset roll_d_cutoff = 30\n';
    const c2 = FT.config(header(), { cli });
    assert.strictEqual(c2.s.gyro_lpf1_type, 0, 'the header wins over a stale CLI dump');
    assert.strictEqual(c2.from.gyro_lpf1_type, 'header');
    assert.deepStrictEqual(c2.gear.tail, [19, 76]);
    assert.strictEqual(c2.pid.cli[1].roll.d_cutoff, 30, 'CLI profile 0 is PID profile 1');
    const g = FT.config(header({ looptime: 250, pid_process_denom: 2, filter_process_denom: 2, frameIntervalPDenom: 2 }), {});
    assert.strictEqual(g.rates.filterHz, 2000); assert.strictEqual(g.rates.logHz, 1000); assert.strictEqual(g.rates.offsetTicks, 1, 'Gaui X4: the blackbox writes 1 gyro tick after the filter (core.c)');
    const f = FT.config(header({ looptime: 500, pid_process_denom: 2, filter_process_denom: 2 }), {});
    assert.strictEqual(f.rates.offsetTicks / f.rates.gyroHz * 1000, 0.5, 'Fireball: 0.5 ms');
});

test('time domain against the transfer function: a sine through a fixed RPM notch and the static filters', () => {
    const cfg = FT.config(header({ gyro_soft_type: 3, gyro_lowpass_hz: 150 }), { gear: GEAR }), M = FT.compile(cfg), n = 20000, hs = 3000;
    for (const f0 of [40, 97, 200]) {
        const x = Float64Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * f0 * i / 1000));
        const seg = { n, raw: [x, x, x], hs: new Float64Array(n).fill(hs), tail: null };
        const y = FT.runChain(M, seg, 'all').y[0];
        let sx = 0, sy = 0; for (let i = n / 2; i < n; i++) { sx += x[i] * x[i]; sy += y[i] * y[i]; }
        const h = FT.chainResponse(M, 0, [f0], { hs }), want = Math.hypot(h.re[0], h.im[0]);
        assert.ok(Math.abs(Math.sqrt(sy / sx) - want) < 0.005 + 0.005 * want, `${f0} Hz: time domain ${Math.sqrt(sy / sx)} against |H| ${want}`);
    }
});

test('dynamic notch: the tracker finds a 150 Hz line and removes it', () => {
    const cfg = FT.config(header({ features: (1 << 29), dyn_notch_count: 1, dyn_notch_min_hz: 100, dyn_notch_max_hz: 300 }), {}), M = FT.compile(cfg), n = 6000;
    assert.ok(M.dyn.on);
    let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
    const x = Float64Array.from({ length: n }, (_, i) => 20 * Math.sin(2 * Math.PI * 150 * i / 1000) + rnd());
    const out = FT.runChain(M, { n, raw: [x, x, x], hs: new Float64Array(n), tail: null }, 'all'), tr = out.track[0], c = new Float64Array(1);
    FT.centresAt(tr, n - 1, 1, c);
    assert.ok(Math.abs(c[0] - 150) < 3, `centre ${c[0]}`);
    let sx = 0, sy = 0; for (let i = n - 2000; i < n; i++) { sx += x[i] * x[i]; sy += out.y[0][i] * out.y[0][i]; }
    assert.ok(10 * Math.log10(sy / sx) < -20, `line attenuated by ${10 * Math.log10(sy / sx)} dB`);
});

// ---------------------------------------------------------------------------------------------
// Synthetic flight logs
// ---------------------------------------------------------------------------------------------

// a flight log: rotor harmonics (1x, 2x, 4x: notched by preset 1), a resonance at 3.79 x (no notch), broadband noise; gyroADC
// from the replica with `truth` settings, both rounded to 1 deg/s as the firmware logs them
function flight(log, rpm, truth, seconds = 90, seed0 = 1, gear = GEAR, lines = []) {   // lines: more rotor-locked lines [[order, amplitude]]
    const n = seconds * 1000; let seed = seed0 * 7919 + log;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
    const hs = Float64Array.from({ length: n }, (_, i) => Math.round(rpm + 15 * Math.sin(2 * Math.PI * 0.05 * i / 1000)));
    const raw = [0, 1, 2].map(a => { const x = new Float64Array(n); let ph = 0, lp = 0;
        for (let i = 0; i < n; i++) { const r0 = hs[i] / 60; ph += 2 * Math.PI * r0 / 1000; lp += 0.005 * (rnd() * 1200 - lp);   // body motion: a corner below 1 Hz
            x[i] = 30 * Math.sin(ph) + 8 * Math.sin(2 * ph + a) + 5 * Math.sin(4 * ph) + (a === 1 ? 6 : 10) * Math.sin(3.79 * ph + a) + 3 * Math.sin(3 * ph) + lp + 2 * rnd();
            for (const [o, A] of lines) x[i] += A * Math.sin(o * ph + a); }
        return x; });
    const M = FT.compile(FT.config(truth, { gear })), sim = FT.runChain(M, { n, raw, hs, tail: null }, M.dyn.on ? 'all' : 'rpm');
    const C = (() => { // static filters of the truth replica in the time domain too (mode 'rpm' leaves them out)
        if (M.dyn.on || !M.statics.length) return sim.y;
        return sim.y.map(y => { let st = [0, 0, 0, 0]; const secs = [].concat(...M.statics.map(s0 => M.sectionsOf(s0, M.rates.filterHz))), out = Float64Array.from(y);
            for (const c of secs) { st = [0, 0, 0, 0]; for (let i = 0; i < n; i++) { const u = c[0] * out[i] + c[1] * st[0] + c[2] * st[1] - c[3] * st[2] - c[4] * st[3]; st[1] = st[0]; st[0] = out[i]; st[3] = st[2]; st[2] = u; out[i] = u; } }
            return out; }); })();
    const rr = raw.map(x => Float64Array.from(x, Math.round)), gy = C.map(y => Float64Array.from(y, Math.round));
    return { w: { n, rate: 1000, fromS: 0, profileAt: new Uint8Array(n).fill(1), hs, gyro: gy, extra: { 'gyroRAW[0]': rr[0], 'gyroRAW[1]': rr[1], 'gyroRAW[2]': rr[2] },
        flight: { log, file: 'synthetic', header: null, actualRate: 1000 } }, mask: new Uint8Array(n).fill(1), flight: true };
}
const withHeader = (it, h) => { it.w.flight.header = h; return it; };

let synth = null;
const synthetic = () => synth || (synth = (() => { const h = header(); return [4500, 4520, 4480].map((rpm, k) => withHeader(flight(k + 1, rpm, h, 90, k + 1), h)); })());

test('parity: the replica of the logged settings matches the logged gyroADC', () => {
    const prep = FT.prepare(synthetic(), { gear: GEAR }), par = FT.parity(prep);
    assert.strictEqual(prep.logs.length, 3);
    const res = prep.lines.filter(l => !l.harmonic && !l.tail);
    assert.ok(res.some(l => Math.abs(l.order - 3.79) < 0.01), `the 3.79 x resonance is found (${JSON.stringify(prep.lines.map(l => [l.axis, l.order]))})`);
    for (const p of par) for (const [ax, A] of Object.entries(p.axes)) {
        assert.ok(A.passed, `log ${p.log} ${ax}: ${JSON.stringify({ line: A.medianLineErrorDb, band: A.maxBandErrorDb, delay: A.delayErrorMs })}`);
        assert.ok(A.maxBandErrorDb < 0.3, `${ax} band error ${A.maxBandErrorDb}`);
        assert.ok(Math.abs(A.delayErrorMs) < 0.05, `${ax} delay error ${A.delayErrorMs}`);
    }
});

test('parity: gyroADC made with other filters than the header says fails (the model mismatch is found)', () => {
    const hTrue = header({ gyro_soft_type: 1, gyro_lowpass_hz: 120 }), hSaid = header();   // the log has an LPF that the header does not show
    const items = [1, 2, 3].map(k => withHeader(flight(k, 4500, hTrue, 60, 10 + k), hSaid));
    const par = FT.parity(FT.prepare(items, { gear: GEAR }));
    assert.ok(par.every(p => !p.passed), 'every log fails');
    assert.ok(par.every(p => Object.values(p.axes).some(A => A.maxBandErrorDb > 1)), 'by more than the band limit');
});

test('search: the noise reduction, the delay limit, CLI lines in range, and leave-one-flight-out', () => {
    const res = FT.tune(synthetic(), { gear: GEAR, curves: true });
    assert.strictEqual(res.model.passed, true);
    const R = res.recommended;
    assert.strictEqual(R.status, 'recommended', JSON.stringify(R.reasons));
    assert.ok(R.predicted.totalDb <= -FT.RULES.reduction.minDb, `reduction ${R.predicted.totalDb} dB`);
    assert.ok(R.predicted.totalDb + 2 * R.predicted.se < 0, '2 SE');
    assert.ok(R.delay.maxAddMs <= FT.RULES.delay.maxAddMs, `delay ${R.delay.maxAddMs} ms`);
    const res379 = R.predicted.perLine.filter(l => Math.abs(l.order - 3.79) < 0.01);
    assert.ok(res379.length && res379.every(l => l.db < -10), `the resonance line goes down: ${JSON.stringify(res379)}`);
    assert.ok(R.cli.some(l => /notch/.test(l) || /DYN_NOTCH/.test(l)), `a notch filter for the resonance: ${R.cli}`);
    for (const line of R.cli) {
        const m = /^set (\w+) = (.+)$/.exec(line); if (!m) { assert.ok(/^feature -?\w+$/.test(line) || /^profile \d$/.test(line), line); continue; }
        const [, k, v] = m, lim = FT.FW_RANGE[k];
        if (lim) assert.ok(+v >= lim[0] && +v <= lim[1], `${k} = ${v} in ${lim}`);
        if (/^gyro_rpm_notch_(source|q|center)_/.test(k)) assert.strictEqual(v.split(',').length, 16, 'whole bank arrays');
    }
    assert.strictEqual(R.validation.leaveOneOut.folds.length, 3);
    assert.ok(R.validation.leaveOneOut.folds.every(f => f.heldOutDb < -FT.RULES.reduction.minDb), JSON.stringify(R.validation.leaveOneOut.folds.map(f => f.heldOutDb)));
    assert.ok(res.curves && res.curves.roll.candidate && res.curves.roll.candidate.length === res.curves.f.length);
});

// tailOrder (2026-10-06): the order of the tail rotor notch from the log alone, when no gear ratio and no CLI dump is given. The
// synthetic gyroADC comes from the module's own replica with a known tail order; the fit must find it, refuse a flat transfer,
// and let the search run without a dump
const GEAR61 = { main: [1, 1], tail: [15, 61], motorisedTail: false };   // 61/15 = 4.0667 x the rotor speed
let synth61 = null;
const synthetic61 = () => synth61 || (synth61 = (() => { const h = header(); return [4500, 4520, 4480].map((rpm, k) => withHeader(flight(k + 1, rpm, h, 60, 20 + k, GEAR61), h)); })());

test('tail order from the log: the fit finds the tail rotor notch that made gyroADC, for the replica and health_setup', (t) => {
    const fit = FT.tailOrder(synthetic61()), F = FT.RULES.notchFit;
    t.diagnostic(`61/15: order ${fit.order} ± ${fit.se} (units ${fit.units.map(u => u.order).join(', ')}), dip ${fit.depthDb} dB, phase jump ${fit.pooled.phaseJumpDeg} deg, ${fit.ms} ms`);
    assert.strictEqual(fit.passed, true, JSON.stringify(fit.reasons));
    assert.ok(Math.abs(fit.order - 61 / 15) < 0.003, `order ${fit.order} ± ${fit.se} against ${61 / 15}`);
    // the SE: the scatter of the units, and 0.1 % of the order for the time base of the logs (RULES.notchFit.timeBase) in quadrature
    assert.ok(fit.seUnits !== null && fit.seUnits < 0.003, `SE of the units ${fit.seUnits}`);
    assert.ok(Math.abs(fit.se - Math.hypot(fit.seUnits, FT.RULES.notchFit.timeBase * fit.order)) < 2e-4 && fit.overlap === false, `SE ${fit.se}`);
    assert.deepStrictEqual([fit.axis, fit.sources, fit.unit, fit.n, fit.flights], ['yaw', [21], 'flight', 3, 3], 'yaw has no main rotor notch near 4 x (preset 1: 11, 12, 21)');
    assert.strictEqual(fit.axes.roll.clean, false, 'roll: the main rotor 4x notch (source 14) overlaps the tail rotor notch');
    assert.ok(fit.depthDb <= -F.minDepthDb, `dip ${fit.depthDb} dB`);
    assert.ok(fit.pooled.phaseJumpDeg >= F.minPhaseJumpDeg, `phase jump ${fit.pooled.phaseJumpDeg} deg`);
    assert.ok(fit.maxDevOrder <= fit.limitDevOrder, `${fit.maxDevOrder} <= ${fit.limitDevOrder}`);
    assert.strictEqual(fit.units.length, 3);
    assert.deepStrictEqual(fit.gear, { main: null, tail: [1, fit.order], tailOrder: fit.order, motorOrder: null, motorisedTail: false, source: 'log notch' });
    assert.strictEqual(fit.motor, null, 'preset 1 has no main motor notch (source 10)');
    // the replica with the fitted order (config opts.logGear), and the same order in health_setup (ctx.gear)
    const M = FT.compile(FT.config(header(), { logGear: fit.gear })), tb = M.rpm.map(l => l.find(b => b.source === 21));
    assert.ok(tb.every(b => b && Math.abs(b.order - fit.order) < 1e-9), JSON.stringify(tb.map(b => b && b.order)));
    assert.deepStrictEqual(M.leftOut, []);
    const setup = require('../tools/autotune/health_setup.cjs'), banks = setup.rpmBanks(header(), fit.gear);
    assert.ok(Math.abs(banks.yaw.find(b => b.code === 21).order - fit.order) < 1e-9, 'health_setup decodeNotchSource reads the gear context');
    // a CLI dump or opts.gear wins over the log (the fit is then only on record)
    assert.strictEqual(FT.config(header(), { gear: GEAR, logGear: fit.gear }).gear.tail[1], 76);
    assert.strictEqual(FT.config(header(), { cli: 'diff all\nset tail_rotor_gear_ratio = 19,76\n', logGear: fit.gear }).gear.source, 'cli');
});

test('tail order from the log: a flat transfer (no RPM notch) is refused, and the replica leaves the tail notch out', (t) => {
    const h = header(), items = [1, 2, 3].map(k => { const it = withHeader(flight(k, 4500, h, 40, 40 + k), h); it.w = Object.assign({}, it.w, { gyro: [0, 1, 2].map(a => Float64Array.from(it.w.extra[`gyroRAW[${a}]`])) }); return it; });
    const fit = FT.tailOrder(items);
    t.diagnostic(`flat: ${JSON.stringify(fit.reasons)} axes ${JSON.stringify(fit.axes)}`);
    assert.strictEqual(fit.passed, false);
    assert.strictEqual(fit.gear, null);
    assert.ok(fit.reasons.length && fit.reasons.every(x => typeof x.code === 'string'), JSON.stringify(fit.reasons));
    assert.ok(fit.reasons.some(x => ['not deep', 'no phase jump', 'no dip', 'no clean axis'].includes(x.code)), JSON.stringify(fit.reasons));
    const prep = FT.prepare(items, { tailFit: fit });
    assert.ok(prep.logs.every(L => L.model.leftOut.length === 3 && L.model.leftOut.every(x => x.source === 21)), 'the tail rotor notch of each axis is left out');
    assert.ok(prep.logs[0].model.notes.some(t => /^The app does not know the frequency of the RPM notch filter "tail rotor 1x" on the roll, pitch and yaw axes\. Thus, the model does not have this filter\.$/.test(t)), JSON.stringify(prep.logs[0].model.notes));
    // a header with no tail rotor bank: nothing to fit
    const h0 = header({ gyro_rpm_notch_preset: 0, gyro_rpm_notch_source_roll: [11, 12], gyro_rpm_notch_source_pitch: [11, 12], gyro_rpm_notch_source_yaw: [11, 12], gyro_rpm_notch_q_roll: [80, 40], gyro_rpm_notch_q_pitch: [80, 40], gyro_rpm_notch_q_yaw: [80, 40] });
    const none = FT.tailOrder(items.slice(0, 1).map(it => withHeader(Object.assign({}, it, { w: Object.assign({}, it.w, { flight: Object.assign({}, it.w.flight) }) }), h0)));
    assert.deepStrictEqual([none.passed, none.gear, none.reasons[0].code], [false, null, 'no tail rotor notch']);
});

test('tail order from the log: the main motor notch (source 10) with the tail notches on the same axes (preset 2 and 3 have both)', (t) => {
    // a geared main motor at 20/3 = 6.667 x the rotor speed, tail 61/15 = 4.067 x, both on every axis (custom banks), 40 Hz rotor
    const pad = (a) => Array.from({ length: 16 }, (_, i) => a[i] || 0), gear = { main: [3, 20], tail: [15, 61], motorisedTail: false };
    const h = header({ gyro_rpm_notch_preset: 0, gyro_rpm_notch_source_roll: pad([11, 12, 21, 10]), gyro_rpm_notch_source_pitch: pad([11, 12, 21, 10]), gyro_rpm_notch_source_yaw: pad([11, 12, 21, 10]),
        gyro_rpm_notch_q_roll: pad([80, 40, 50, 80]), gyro_rpm_notch_q_pitch: pad([80, 40, 50, 80]), gyro_rpm_notch_q_yaw: pad([80, 40, 50, 80]),
        gyro_rpm_notch_center_roll: pad([]), gyro_rpm_notch_center_pitch: pad([]), gyro_rpm_notch_center_yaw: pad([]) });
    const items = [2400, 2420, 2380].map((rpm, k) => withHeader(flight(k + 1, rpm, h, 60, 60 + k, gear), h)), fit = FT.tailOrder(items);
    t.diagnostic(`tail ${fit.order} ± ${fit.se} (${fit.axis}), motor ${fit.motor && fit.motor.order} ± ${fit.motor && fit.motor.se} (${fit.motor && fit.motor.axis}), ${fit.ms} ms`);
    assert.strictEqual(fit.passed, true, JSON.stringify(fit.reasons));
    assert.ok(Math.abs(fit.order - 61 / 15) < 0.005, `tail ${fit.order}`);
    assert.ok(fit.motor && fit.motor.passed, JSON.stringify(fit.motor && fit.motor.reasons));
    assert.ok(Math.abs(fit.motor.order - 20 / 3) < 0.01, `motor ${fit.motor.order}`);
    assert.deepStrictEqual([fit.gear.main, fit.gear.motorOrder], [[1, fit.motor.order], fit.motor.order]);
    const M = FT.compile(FT.config(h, { logGear: fit.gear })), mb = M.rpm[2].find(b => b.source === 10);
    assert.ok(mb && Math.abs(mb.order - fit.motor.order) < 1e-9 && M.leftOut.length === 0, JSON.stringify(M.leftOut));
    // direct drive (main ratio 1): the firmware has no main motor notch (rpm_filter.c enable10), and the fit finds none
    const dd = [2400, 2420, 2380].map((rpm, k) => withHeader(flight(k + 1, rpm, h, 60, 60 + k, { main: [1, 1], tail: [15, 61], motorisedTail: false }), h)), f2 = FT.tailOrder(dd);
    assert.ok(f2.passed && f2.motor && !f2.motor.passed && f2.gear.main === null, JSON.stringify(f2.motor && f2.motor.reasons));
});

// review 2026-10-06 (tail-fit): the default presets 2 and 3 (tail 1x next to main 3x and 4x, the motor notch source 10 on every axis), a
// static notch of the header, the dynamic notch on a rotor-locked line, a header that changes between logs, and the time base of the logs
const presetHeader = (preset, over = {}) => { const h = header(over); h.gyro_rpm_notch_preset = preset;
    for (const ax of ['roll', 'pitch', 'yaw']) { const p = FT.PRESETS[preset][['roll', 'pitch', 'yaw'].indexOf(ax)], pad = (a) => Array.from({ length: 16 }, (_, i) => a[i] || 0);
        h[`gyro_rpm_notch_source_${ax}`] = pad(p.source); h[`gyro_rpm_notch_q_${ax}`] = pad(p.q); h[`gyro_rpm_notch_center_${ax}`] = pad(p.center); }
    return h; };
const three = (h, gear, rpm, seed, lines) => [rpm, rpm + 20, rpm - 20].map((r0, k) => withHeader(flight(k + 1, r0, h, 40, seed + k, gear, lines), h));

test('tail order (review): presets 2 and 3: the motor notch is not taken for the tail notch, and tail 1x next to main 4x gives a fit with its known notch and a wider SE', (t) => {
    const F = FT.RULES.notchFit, T = 61 / 15;
    // preset 2, a geared motor at 7.5 x, 3000 rpm: tail 2x (8.13 x, 406 Hz) is out of view, tail 1x is next to main 4x. The 7.5 x dip has the Q
    // of the motor notch (8), not of tail 1x (6): an alias, not the tail. The tail comes from tail 1x with main 4x in the model
    const m = FT.tailOrder(three(presetHeader(2), { main: [1, 7.5], tail: [15, 61], motorisedTail: false }, 3000, 30));
    t.diagnostic(`M 7.5: tail ${m.order} ± ${m.se} (${m.axis}, overlap ${m.overlap}), motor ${m.motor && m.motor.order}, roll ${JSON.stringify(m.axes.roll)}`);
    assert.ok(m.passed && Math.abs(m.order / T - 1) < 0.005 && m.overlap === true, JSON.stringify([m.order, m.reasons]));
    assert.ok(m.se >= F.overlap * m.order, `the SE of a fit next to a main rotor notch ${m.se}`);
    assert.ok(m.axes.roll.alias && m.axes.roll.alias.other === 'main motor' && Math.abs(m.axes.roll.order - 7.5) < 0.02, JSON.stringify(m.axes.roll));
    assert.ok(m.motor && m.motor.passed && Math.abs(m.motor.order - 7.5) < 0.01, JSON.stringify(m.motor && [m.motor.order, m.motor.reasons]));
    // direct drive (no motor notch in the firmware), tail 76/19 = 4.0 on main 4x: 4.0, not 7.96 (2 x 3.98, the tail 2x dip at the edge of the view)
    const d = FT.tailOrder(three(presetHeader(2), { main: [1, 1], tail: [19, 76], motorisedTail: false }, 3000, 30));
    assert.ok(d.passed && Math.abs(d.order - 4) < 0.03, JSON.stringify([d.order, d.reasons, d.axes]));
    // preset 3, motor 10 x: tail 61/15 from tail 1x
    const p3 = FT.tailOrder(three(presetHeader(3), { main: [1, 10], tail: [15, 61], motorisedTail: false }, 3000, 30));
    assert.ok(p3.passed && Math.abs(p3.order / T - 1) < 0.005, JSON.stringify([p3.order, p3.reasons]));
});

test('tail order (review): a static notch of the header and the dynamic notch on a rotor-locked line are not the tail rotor notch', (t) => {
    const T45 = { main: [1, 1], tail: [2, 9], motorisedTail: false };
    // a static notch at 160 Hz (Q 3) at 3000 rpm is 3.2 x: its band is left out, and the tail notch (4.5 x) is found
    const st = FT.tailOrder(three(header({ gyro_notch_hz: [160, 0], gyro_notch_cutoff: [FT.notchCutoffFor(160, 3), 0] }), T45, 3000, 90));
    t.diagnostic(`static: ${st.order} ± ${st.se} ${JSON.stringify(st.reasons)}`);
    assert.ok(st.passed && Math.abs(st.order - 4.5) < 0.01, JSON.stringify([st.order, st.reasons]));
    // DYN_NOTCH (1 notch, Q 2.5, 100-300 Hz) on a strong 3 x line. At 5400 rpm the tail notch (405 Hz) is out of view: the 3 x dip has the
    // Q of the dynamic notch, an alias. At 4000 rpm the tail notch is in view and found
    const dyn = header({ features: (1 << 30) | (1 << 29), dyn_notch_count: 1, dyn_notch_q: 25, dyn_notch_min_hz: 100, dyn_notch_max_hz: 300 });
    const out = FT.tailOrder(three(dyn, T45, 5400, 50, [[3, 25]])), seen = FT.tailOrder(three(dyn, T45, 4000, 50, [[3, 25]]));
    t.diagnostic(`dyn 5400: ${JSON.stringify(out.reasons)}; 4000: ${seen.order}`);
    assert.ok(!out.passed && out.gear === null && out.reasons[0].code === 'alias' && out.reasons[0].other === 'dynamic notch', JSON.stringify(out.reasons));
    assert.match(FT.fitCauseText(out, 'tail rotor'), /^At the best frequency, the gyro signal decreases as a notch filter with a Q of [\d.]+ decreases it\. The tail rotor notch filter has a Q of 5, and the dynamic notch filter has a Q of 2\.5\. Thus, the decrease can come from the dynamic notch filter\.$/);
    assert.ok(seen.passed && Math.abs(seen.order - 4.5) < 0.01, JSON.stringify([seen.order, seen.reasons]));
});

test('tail order (review): logs with other banks are fitted with their own banks; the revolutions on the logged time; motorisedTail and the texts of the reasons', () => {
    const G61 = { main: [1, 1], tail: [15, 61], motorisedTail: false }, pad = (a) => Array.from({ length: 16 }, (_, i) => a[i] || 0);
    const h1 = header(), h0 = header({ gyro_rpm_notch_preset: 0, gyro_rpm_notch_source_yaw: pad([11, 12, 14, 21]), gyro_rpm_notch_q_yaw: pad([80, 40, 60, 50]), gyro_rpm_notch_center_yaw: pad([]) });
    // the first log has main 4x on yaw too: the logs with preset 1 give the fit, and each log is a unit with its own banks
    const mix = FT.tailOrder([h0, h1, h1, h1].map((h, k) => withHeader(flight(k + 1, 3000 + 20 * k, h, 40, 70 + k, G61), h)));
    assert.ok(mix.passed && Math.abs(mix.order / (61 / 15) - 1) < 0.002 && mix.settings === 2 && mix.axis === 'yaw', JSON.stringify([mix.order, mix.settings, mix.reasons]));
    // the revolutions on the logged time: a frame interval counts as logged (up to RULES.notchFit.gapFrames intervals), a gap as 1 / rate
    const hs = Float64Array.of(3000, 3000, 3000, 3000), tt = Float64Array.of(0, 1000, 2500, 12500), got = Array.from(FT._t.revHeadspeed(hs, tt, 1000));
    assert.deepStrictEqual(got, [3000, 3000, 4500, 3000]);
    assert.strictEqual(FT._t.revHeadspeed(hs, null, 1000), hs, 'no time column: the sample count');
    // motorisedTail: false only when the tail fit passed. A motor fit alone: unknown, and the replica leaves a source 20 bank out with a note
    const hm = header({ gyro_rpm_notch_preset: 0, gyro_rpm_notch_source_roll: pad([11, 12, 10]), gyro_rpm_notch_source_pitch: pad([11, 12, 10]), gyro_rpm_notch_source_yaw: pad([11, 12, 10]),
        gyro_rpm_notch_q_roll: pad([80, 40, 80]), gyro_rpm_notch_q_pitch: pad([80, 40, 80]), gyro_rpm_notch_q_yaw: pad([80, 40, 80]) });
    const mo = FT.tailOrder([2400, 2420, 2380].map((r0, k) => withHeader(flight(k + 1, r0, hm, 40, 80 + k, { main: [3, 20], tail: [15, 61], motorisedTail: false }), hm)));
    assert.ok(mo.motor && mo.motor.passed && mo.gear && mo.gear.motorisedTail === null && mo.gear.tail === null, JSON.stringify([mo.motor && mo.motor.reasons, mo.gear]));
    const h20 = header({ gyro_rpm_notch_preset: 0, gyro_rpm_notch_source_yaw: pad([11, 12, 20]), gyro_rpm_notch_q_yaw: pad([80, 40, 50]) }), M = FT.compile(FT.config(h20, { logGear: mo.gear }));
    assert.ok(M.leftOut.some(x => x.source === 20 && x.axis === 'yaw') && M.notes.some(n => /"tail motor" on the yaw axis/.test(n)), JSON.stringify([M.leftOut, M.notes]));
    // the texts of the reasons (STE, from the log only)
    const why = (r0) => FT.fitCauseText({ order: 4, unit: 'flight', reasons: [r0] }, 'tail rotor');
    assert.strictEqual(why({ code: 'no phase jump', phaseJumpDeg: 40, limit: 90 }), 'At the best frequency, the gyro signal decreases, but its phase does not change as it does at a notch filter.');
    assert.strictEqual(why({ code: 'no clean axis', overlap: 'tail rotor' }), 'On each axis, a tail rotor notch filter is near the tail rotor notch filter.');
    assert.strictEqual(why({ code: 'axes disagree', axis: 'roll', order: 3.4993, yawOrder: 7.0002 }), 'The yaw axis gives 7.0002 x the rotor frequency, and the roll axis gives 3.4993 x the rotor frequency.');
    assert.strictEqual(why({ code: 'error', message: 'x is "y"' }), 'The app cannot calculate this frequency. The error is "x is \'y\'".');
    assert.strictEqual(why({ code: 'no flight data' }), 'The log has no flight with the raw gyro data.');
    // no flight log with gyroRAW: the reason says so (it was 'no tail rotor notch', and the views said nothing)
    const none = FT.tailOrderFit({ entries: [], spectra: [new Map(), new Map(), new Map()], ms: 0 });
    assert.deepStrictEqual([none.reasons[0].code, none.motor, none.gear], ['no flight data', null, null]);
});

test('search without gear ratios: the fitted tail order lets parity and the search run, with log-only texts', (ctx) => {
    const res = FT.tune(synthetic(), { curves: false });   // no gear, no CLI dump (the logs were made with tail 19,76 = 4.0 x)
    ctx.diagnostic(`19/76: order ${res.tailFit.order} ± ${res.tailFit.se}, dip ${res.tailFit.depthDb} dB, phase jump ${res.tailFit.pooled && res.tailFit.pooled.phaseJumpDeg} deg; cli ${res.recommended.cli.join(' | ')}`);
    assert.ok(res.tailFit && res.tailFit.passed && res.tailFit.used, JSON.stringify(res.tailFit && res.tailFit.reasons));
    assert.ok(Math.abs(res.tailFit.order - 4) < 0.003, `order ${res.tailFit.order}`);
    assert.deepStrictEqual([res.model.gear.source, res.model.leftOut], ['log notch', []]);
    assert.strictEqual(res.model.passed, true, JSON.stringify(res.model.parity.map(p => [p.log, Object.values(p.axes).map(A => A.maxBandErrorDb)])));
    assert.strictEqual(res.recommended.status, 'recommended', JSON.stringify(res.recommended.reasons));
    assert.ok(!res.recommended.reasons.some(t => /gear|CLI/.test(t)));
    const t = FT.texts(res, { logBase: 1, cli: false }), [, , notch] = t.parity.split('\n');
    assert.match(t.parity.split('\n')[0], /agrees with the recorded gyroADC in all 3 flight logs/);
    assert.match(notch || t.parity.split('\n')[1], /^In the log, the tail rotor notch filter is at 4\.\d{1,4} ± 0\.\d{1,4} x the rotor frequency \(yaw axis, 3 flight logs\)\. At this frequency, the filters decrease the gyro signal by \d+ dB\. The model uses this value\.$/);
    assert.deepStrictEqual(t.why, []);
    for (const x of [t.summary, t.parity, t.recommendation, t.validation, t.delay]) assert.ok(!/\bCLI dump\b|\bdiff all\b|\bgear\b|\bratios?\b/i.test(x), x);
    // with the gear given, the same recommendation
    const ref = FT.tune(synthetic(), { gear: GEAR, curves: false, loo: false });
    assert.deepStrictEqual(res.recommended.cli, ref.recommended.cli);
});

// round 3 M2: the texts of the views (STE) and the recommendations of advice.cjs from a result of tune()
test('texts: the result in the words of the views, and the recommendations of advice.cjs that the export takes', () => {
    const res = FT.tune(synthetic(), { gear: GEAR, curves: false }), t = FT.texts(res, { logBase: 1, cli: true });
    assert.strictEqual(t.status, 'recommended');
    assert.match(t.summary, /^The app calculated the vibration for \d+ sets of filter values on \d+ s of flight in logs 2, 3 and 4\. The recommended set decreases the vibration that gets to the PID controller by [\d.]+ ± [\d.]+ dB \(\d+ % less vibration power\)\.$/);
    assert.match(t.parity, /^The model of the Rotorflight 4\.6 gyro filters agrees with the recorded gyroADC in all 3 flight logs\. The largest error is [\d.]+ dB in a frequency band and [\d.]+ dB at the vibration lines, and the limit is 1 dB\./);
    assert.ok(!/\n/.test(t.parity), 'one paragraph when every log agrees');
    assert.match(t.validation, /without each flight log \(3 tests\)\. In the flight log that the app did not use, the vibration changed by -[\d.]+ ± [\d.]+ dB\. The app selected the same set in \d of 3 tests\.$/);
    assert.match(t.delay, /^The recommended set adds (no time delay from 10 Hz to 30 Hz\.|[\d.]+ ms of time delay at \d+ Hz)/);
    assert.strictEqual(t.rows.length, res.recommended.rows.length);
    for (const r of t.rows) assert.match(r.text, /^Set `[a-z0-9_ A-Z]+`/, r.text);
    assert.deepStrictEqual(t.why, []);
    const advice = require('../tools/autotune/advice.cjs'), recs = advice.filterRecommendations(res, { texts: t, cli: true });
    assert.ok(recs.length >= 1 && recs.every(r => r.severity === 'action' && r.cli.length), JSON.stringify(recs.map(r => [r.id, r.severity, r.caveats])));
    const cmds = advice.exportScript(recs, null, {}).split('\n').filter(l => l && !l.startsWith('#'));
    assert.deepStrictEqual(cmds.filter(l => !/^(batch start|save|profile \d)$/.test(l)).sort(), [].concat(...recs.map(r => r.cli.filter(l => !/^profile \d$/.test(l)))).sort(), 'every command of the set goes into the file');
});

test('texts: a model that does not agree, the reasons of tune(), no CLI dump, and no flight log', () => {
    const axis = (o) => Object.assign({ passed: true, linesPassed: true, delayPassed: true, maxBandErrorDb: 0.2, medianLineErrorDb: 0.1, delayErrorMs: 0.01 }, o);
    const leftOut = ['roll', 'pitch', 'yaw'].map(axis => ({ log: 49, axis, source: 21, label: 'tail rotor 1x' }));
    const res = { ms: { exactEvaluations: 10, screened: 90 }, units: { kind: 'flight', n: 2 }, tailFit: { passed: false, used: false, order: 4.6, unit: 'flight', n: 2, reasons: [{ code: 'not deep', depthDb: -4.2, limit: 10 }], motor: null },
        model: { passed: false, leftOut, notes: [],
        parity: [{ log: 49, seconds: 100, passed: false, axes: { roll: axis(), pitch: axis({ passed: false, maxBandErrorDb: 1.4 }), yaw: axis({ passed: false, linesPassed: false, medianLineErrorDb: 2.1 }) } },
            { log: 50, seconds: 60, passed: true, axes: { roll: axis(), pitch: axis(), yaw: axis() } }] },
        recommended: { status: 'not recommended', rows: [], reasons: ['The predicted change is -0.64 dB. A reduction of 3 dB or more is necessary.', 'In leave-one-out, 75 % of the held-out units had less noise; 80 % is necessary.', 'There are 2 units: no standard error (3 or more are necessary).', 'A reason that the texts do not know.'],
            delay: { maxAddMs: 0.5, at: { axis: 'pitch', path: 'P', hz: 30 }, f11BaseMs: 7.41, f11MaxMs: 7.77 }, validation: { leaveOneOut: { folds: [], heldOutMeanDb: null, heldOutSe: null, sameAsFull: 0 } } } };
    const t = FT.texts(res, { logBase: 1, cli: false });
    assert.strictEqual(t.status, 'not recommended');
    assert.match(t.summary, /^The app calculated the vibration for 100 sets of filter values on 160 s of flight in logs 50 and 51\. The app does not recommend a filter change\.$/);
    const [agree, axes, gear] = t.parity.split('\n');
    assert.match(agree, /agrees with the recorded gyroADC in 1 of 2 flight logs\. The largest error is 1\.4 dB in a frequency band and 2\.1 dB at the vibration lines/);
    assert.strictEqual(axes, 'In log 50, the pitch axis has an error of 1.4 dB in a frequency band. In log 50, the yaw axis has an error of 2.1 dB at the vibration lines. The app does not use the model for these axes.');
    assert.strictEqual(gear, 'The data in the log is not sufficient to find the tail rotor notch filter. At the best frequency, the filters decrease the gyro signal by only 4.2 dB, and the minimum is 10 dB. Thus, the model does not have the tail rotor notch filters on the roll, pitch and yaw axes.');
    assert.deepStrictEqual(t.why, ['The filter model does not agree with the recorded gyroADC in 1 of 2 flight logs.', 'The best set decreases the vibration by only 0.64 dB. A decrease of 3 dB or more is necessary.',
        'When the app selects the set without one of the flight logs, that part has less vibration in only 75 % of the tests. 80 % is necessary.', 'The data has only 2 flight logs. For an SE, 3 or more are necessary.',
        'The analysis of the filter values gives this cause: "A reason that the texts do not know.".']);
    assert.strictEqual(t.recommendation, t.why.join('\n'));
    assert.match(t.delay, /^The best set of filter values adds 0\.5 ms of time delay at 30 Hz \(pitch axis, the P-term\)\. The limit is 0\.5 ms\./);
    assert.strictEqual(t.validation, 'The data has 2 flight logs, and 3 or more are necessary. Thus, the app cannot test the set on data that it did not use.');
    assert.strictEqual(FT.texts(Object.assign({}, res, { units: { kind: 'flight', n: 4 } })).validation, 'The app did not test the set on data that it did not use.', 'no leave-one-out (option loo false)');
    // the other reasons of tailOrder, and no fit at all (opts.logGear false): the log is the only input, no text asks for a dump
    const why = (r0, extra) => FT.texts(Object.assign({}, res, { tailFit: Object.assign({}, res.tailFit, { reasons: [r0] }, extra || {}) }), { cli: false }).parity.split('\n')[2];
    assert.match(why({ code: 'units disagree', maxDevOrder: 0.092, limit: 0.046 }), /^The data in the log is not sufficient to find the tail rotor notch filter\. The flight logs give frequencies that are different by up to 2 %, and the limit is 1 %\. Thus,/);
    assert.match(why({ code: 'too few units', n: 2, limit: 3 }, { unit: 'block' }), /The log has only 2 periods of 30 s of flight with sufficient data, and 3 or more are necessary\./);
    assert.match(why({ code: 'no clean axis' }), /On each axis, a main rotor notch filter is near the tail rotor notch filter\./);
    assert.match(why({ code: 'not deep', depthDb: 1.5, limit: 10 }), /The gyro signal does not decrease at a frequency that follows the rotor speed\./);
    assert.strictEqual(FT.texts(Object.assign({}, res, { tailFit: null }), { cli: false }).parity.split('\n')[2], 'The app does not know the frequency of the tail rotor notch filters. Thus, the model does not have them on the roll, pitch and yaw axes.');
    for (const v of [t, FT.texts(Object.assign({}, res, { tailFit: null }))]) for (const x of [v.summary, v.parity, v.recommendation, ...v.why]) assert.ok(!/\bCLI dump\b|\bdiff all\b|\bgear\b|\bratios?\b/i.test(x), x);
    const none = FT.texts({ recommended: { status: 'no flight log', reasons: ['No flight log with gyroRAW.'] }, model: { parity: [] } });
    assert.deepStrictEqual([none.status, none.why.length, none.rows], ['no flight log', 1, []]);
    assert.match(none.summary, /no flight log with the raw gyro data \(`gyroRAW`\)/);
});

test('guards: floors, ranges and the delay limit', () => {
    const ref = FT.config(header(), { gear: GEAR });
    assert.ok(FT.guards(ref, { gyro_lpf1_type: 3, gyro_lpf1_static_hz: 50 }).some(t => /below 60/.test(t)), 'no gyro LPF below 60 Hz (FILT)');
    assert.ok(FT.guards(ref, { dyn_notch_q: 15 }).some(t => /below Q 2/.test(t)), 'no notch Q below 2.0 (FILT)');
    assert.ok(FT.guards(ref, { dyn_notch_max_hz: 600 }).some(t => /range/.test(t)), 'firmware range');
    assert.ok(FT.guards(ref, { gyro_rpm_notch_source_roll: [11, 19, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }).some(t => /source/.test(t)), 'unknown RPM source');
    assert.ok(FT.guards(ref, {}, { maxAddMs: 0.8, at: { hz: 30, axis: 'pitch', path: 'D' }, f11MaxMs: 2, f11BaseMs: 2 }).some(t => /delay/.test(t)), 'the delay limit');
    assert.deepStrictEqual(FT.guards(ref, { dyn_notch_count: 2, dyn_notch_q: 40, dyn_notch_min_hz: 170, dyn_notch_max_hz: 370, DYN_NOTCH: true }), []);
});

test('firmware ranges and floors agree with advice.cjs where both have them', () => {
    let advice = null; try { advice = require('../tools/autotune/advice.cjs'); } catch (e) { advice = null; }
    if (!advice || !advice.RANGE) return;   // advice is optional for this module
    for (const [k, lim] of Object.entries(FT.FW_RANGE)) if (advice.RANGE[k]) assert.deepStrictEqual(advice.RANGE[k], lim, k);
    if (advice.RULES && advice.RULES.minLpfHz) assert.strictEqual(FT.RULES.floors.minLpfHz, advice.RULES.minLpfHz);
    if (advice.RULES && advice.RULES.minNotchQ) assert.strictEqual(FT.RULES.floors.minNotchQ, advice.RULES.minNotchQ);
});

test('worker shim: no Node API call at module load, module.exports then return', () => {
    const file = path.join(__dirname, '../tools/autotune/filter_tune.cjs'), src = fs.readFileSync(file, 'utf8');
    assert.ok(/module\.exports = \{[\s\S]*?\};\nif \(require\.main !== module\) return;/.test(src), 'module.exports, then the return');
    const trap = new Proxy({}, { get: (t, k) => { throw new Error(`Node API used at load: ${String(k)}`); } });
    const req = (name) => /^node:/.test(name) ? trap : name === './lib.cjs' ? require('../tools/autotune/lib.cjs') : name === './health_setup.cjs' ? require('../tools/autotune/health_setup.cjs') : (() => { throw new Error(`not available in the shim: ${name}`); })();
    const mod = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function('require', 'module', 'exports', 'process', '__dirname', '__filename', src)(Object.assign(req, { main: undefined }), mod, mod.exports, { env: {} }, '', file);
    assert.strictEqual(typeof mod.exports.tune, 'function');
});

const REAL = process.env.AUTOTUNE_FILTER_LOG;
test('real log (AUTOTUNE_FILTER_LOG): parity passes, the tail rotor notch order is found in the log, and the dynamic notch for the 3.79 x resonance is recommended', { skip: !REAL && 'AUTOTUNE_FILTER_LOG is not set' }, () => {
    const lib = require('../tools/autotune/lib.cjs'), phase = require('../tools/autotune/health_phase.cjs'), app = lib.loadApp(), items = [];
    for (const w of lib.segments(app, REAL, { whole: true, extra: [...new Set([...FT.EXTRA, ...phase.EXTRA])] })) {
        const ctx = { rate: w.rate, flightRule: { headspeed: lib.FLIGHT_RPM } }, ph = phase.phases(w, ctx); items.push({ w, mask: phase.flightMask(w, ctx, ph), flight: ph.class === 'flight' }); }
    const cli = process.env.AUTOTUNE_FILTER_CLI ? fs.readFileSync(process.env.AUTOTUNE_FILTER_CLI, 'utf8') : null, res = FT.tune(items, { cli });
    assert.ok(res.model.parity.length >= 1);
    if (cli) assert.ok(res.model.passed, JSON.stringify(res.model.parity.map(p => [p.log, Object.values(p.axes).map(A => A.passed)])));
    assert.ok(res.ms.total < 60000, `${res.ms.total} ms`);
    if (cli) { assert.strictEqual(res.recommended.status, 'recommended', JSON.stringify(res.recommended.reasons)); assert.ok(res.recommended.cli.includes('feature DYN_NOTCH'), res.recommended.cli.join(' | ')); }
    // the tail rotor notch from the log (Fireball: 76/19 = 4.0 x). Without a dump the model uses it and agrees with the log; with a
    // dump the fit is on record and agrees with the dump's order within the rule of the units
    const T = res.tailFit;
    assert.ok(T && T.passed, JSON.stringify(T && T.reasons));
    if (!cli) assert.ok(T.used && res.model.passed, JSON.stringify(res.model.parity.map(p => [p.log, Object.values(p.axes).map(A => A.passed)])));
    if (T.cli && T.cli.tailOrder) assert.ok(Math.abs(T.order - T.cli.tailOrder) <= T.limitDevOrder, `fit ${T.order} ± ${T.se}, dump ${T.cli.tailOrder}`);
});
