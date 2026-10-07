'use strict';

/**
 * Tracking, lag and fast oscillation of the cyclic and tail loops from one whole log, and the error curves the app
 * plots. Check numbers continue docs/TUNING_KNOWLEDGE.md section 10 (C5 and T1 are catalogued there; the rest are new):
 *
 *   C12 roll, pitch / T11 yaw   tracking error: rms(gyro(t + tau) - setpoint(t)) / rms(setpoint(t)) over the samples with
 *                               |setpoint| > 5 deg/s, tau the delay in [0, 150] ms that minimises it: the formula of the
 *                               PID lab (js/flight_analysis.js delayCompensatedTracking), except that gyro and setpoint
 *                               are both low-passed at RULE.track.lpHz first (zero phase). This leaves the full-band
 *                               definition of the PID lab on purpose: rotor vibration in the gyro is no
 *                               tracking error, no loop can follow it, and the F checks report it. On a clean gyro the
 *                               low-pass changes little (Gaui X4 #58 roll p1 0.348 -> 0.345), on one without a gyro
 *                               low-pass it is most of the full-band number (Fireball 20260929 log 1 roll p2 1.93 ->
 *                               0.36), so the gyro above lpHz is reported next to it as a share of the setpoint rms. The
 *                               gate leaves out stick-free samples, whose error would count without their setpoint
 *                               (#58 roll p1 0.345 -> 0.289). Also the error at tau = 0, and the error power in bands at
 *                               the same tau (differences of the same low-pass at the band edges: the bands add up to it)
 *   C13 roll, pitch / T12 yaw   that tau: the lag from setpoint to gyro. The PID gyro low-pass (header <axis>BW[0]) is named
 *                               with its group delay as a setting only: it filters the feedback (TUNING_KNOWLEDGE 2.6) and
 *                               the logged gyro is taken before it (2.4), so it is not part of this lag
 *   R1                          lag from stick (rcCommand) to setpoint: rate shaping (response time, accel limit, RC smoothing)
 *   C5 roll, pitch / T1 yaw     fast oscillation of gyro - setpoint in the wag bands of wag.cjs: shares of stick-free
 *                               time at 10 / 20 / 40 deg/s of band-passed amplitude, bursts that grow by themselves
 *                               (wag_report.cjs onset rule), and the peak of the stick-free error spectrum when one
 *                               stands out of its neighbourhood (RULE.osc.peakMinDb, peakZ)
 *
 * Module contract as health_loop.cjs: EXTRA, RULE (measurement parameters), analyse(w, ctx) (measurements only),
 * DEFAULT_RULES and judge(flights, RULES) (every threshold, with its source); plus curves(w, ctx, metrics): series for
 * the app's plots, typed arrays, NaN where a bin has no samples.
 *
 * Usable samples are those of health_loop: in flight, governor ACTIVE when GOVSTATE is logged, RULE.guardS away from
 * profile switches and governor state changes; and out of rescue (w.rescueAt, widened by RULE.guardS: rescue flies its
 * own setpoint while the log keeps the pilot's, lib.cjs segments), so that this holds without health_more.normalMask too.
 * They are cut into blocks of RULE.blockS of usable time of one profile, in time order; a profile's last block shorter
 * than RULE.minBlockS joins the block before it, or is left out when it is the only one. Standard errors are
 * leave-one-block-out jackknife over RULE.minJack blocks or more, with the delay fitted again in every replicate of C12 and C13 (the bands and the
 * vibration share keep the fitted delay). Rates in deg/s, lags in ms, times in s from log start (w.fromS + i / ctx.rate).
 * Frequencies use ctx.rate.
 *
 * Evidence for the app (the spans behind a finding, index time): track[axis].byProfile[p].worst, the RULE.worst blocks with the
 * largest error at the fitted delay (C12, C13); stick[axis].blocksAt, the blocks of the R1 fit, the largest share of the
 * stick-rate power first; each block { t0, t1, seconds, runs, value }. Finding texts are ASD-STE100 (docs/STE_GLOSSARY.md),
 * a note on thin data has thin: true, and every finding has phase 'flight' (the engine ANDs the flight phase of
 * health_phase.cjs into ctx.flying, SPEC2 D13).
 */

const lib = require('./lib.cjs');
const { cx, AXES } = lib;

const RULE = {
    guardS: 1,                     // s left out either side of a profile switch, governor state change or rescue (health_loop RULE.guardS)
    blockS: 10, minBlockS: 5,      // jackknife blocks of usable time, s
    minJack: 3,                    // fewest jackknife replicates for a standard error, as health_more's jackknife: from 2 the SE has one degree of freedom, too few for a 2-SE test
    // C12, C13: gyro and setpoint low-passed alike at lpHz (above it: vibration, reported apart; 30 Hz is the control /
    // noise split of F7 and F10, and at 20 Hz the -6 dB of the low-pass would eat into the 8-20 Hz band); only samples with
    // |setpoint| > minAbsSetpoint deg/s count (js/flight_analysis.js:676); blocks with less stick (deg/s rms over all their
    // samples) are left out; the error is split into bands at bandEdges: 0 to the first edge, ..., the last edge to lpHz
    track: { lpHz: 30, minAbsSetpoint: 5, maxS: 0.15, stepS: 0.001, minSetpointRms: { roll: 20, pitch: 20, yaw: 30 }, bandEdges: [0.5, 3, 8, 20] },
    lpfAtHz: 10,                   // C13: group delay of the first-order PID gyro low-pass (header <axis>BW[0]) at this frequency, named as a setting
    stick: { maxS: 0.2, stepS: 0.001, band: [0.1, 3], moving: 25, minMovingS: 1, everyS: 0.005 }, // R1: Hz of the zero-phase band-pass on both before d/dt; moving = |d rcCommand/dt| >= this many units/s; a block needs this many s of it; sums over samples this far apart (the band ends far below their rate)
    osc: {
        bands: { roll: [10, 20], pitch: [8, 16], yaw: [5, 16] }, // Hz, wag.cjs RULE.bands
        // amplitudes are of the band-passed error, sqrt(2) rms after lib.bandpass as wag.cjs has them: that passes bandGain(f)
        // of a sine, 0.47-0.64 inside the roll and pitch bands and 0.50-0.83 inside the yaw band; the thresholds are on this scale
        windowS: 0.5, thresholds: [10, 20, 40], stickDriven: 0.5, // wag.cjs RULE.windowS; wag_report.cjs RULES.thresholds and RULES.stickDriven
        onset: { small: 30, high: 150, minHalfCycles: 6 }, cycleBand: [5, 25], preS: 0.3, // wag_report.cjs RULES.onset on half cycles of the error in wag.cjs RULE.cycleBand, from this long before a burst
        // stick-free error spectrum: Hann windows of psdS, hop half of it, kept over psdFit Hz. A peak is a local maximum in
        // psd at least peakMinDb above the straight line through 10 log10 PSD against log10 f of the bins peakFlankHz away on
        // both sides, by peakZ of its standard error (prominentPeak). Pipeline, unvalidated; set on the simulator of
        // test/health_track.test.cjs: 360 clean profile spectra reach z 4.8 at most, a sustained 2 deg/s sine at 12 Hz on
        // pitch z 6.5 and 4.0 dB at least. Flanks 2-4 Hz away keep a hump 3 Hz wide (the Fireball 6 Hz, the Gaui 10 Hz roll) out of its baseline
        psdS: 2, psd: [4, 30], psdFit: [1, 34], peakFlankHz: [2, 4], peakMinDb: 3, peakZ: 5.5,
    },
    curve: { stepS: 0.1, specS: 2, hopS: 1, maxHz: 60, edges: [0, 25, 50, 100, 150, 200, 300, 400, 600] },
    maxEvents: 200,
    worst: 3,                      // C12, C13 (T11, T12): blocks kept per profile as evidence, the largest error first
};

const EXTRA = ['rcCommand[0]', 'rcCommand[1]', 'rcCommand[2]'];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const sum = (v) => v.reduce((s, q) => s + q, 0);
const jackSe = (v) => { const m = v.length; if (m < RULE.minJack) return null; const mu = sum(v) / m; return Math.sqrt((m - 1) / m * sum(v.map(q => (q - mu) ** 2))); };
const vertex = (a, b, c) => { const d = a - 2 * b + c; return d ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d)) : 0; }; // extremum of the parabola through three equally spaced points, in steps from the middle one
const amp = (x, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += x[i] * x[i]; return Math.sqrt(2 * s / Math.max(1, i1 - i0)); }; // sqrt(2) rms: the amplitude of a sinusoid in x (in a band-passed x, bandGain of the sinusoid before it)
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
const largest = (ev) => ev.slice().sort((a, b) => b.value - a.value).slice(0, RULE.maxEvents);
const lagSteps = (S, rate) => { const step = Math.max(1, Math.round(S.stepS * rate)), max = Math.round(S.maxS * rate); return { step, max, K: Math.floor(max / step) + 1 }; };
const lagSe = (ms, step, rate) => ms.length >= RULE.minJack ? Math.hypot(jackSe(ms), step / rate * 1000 / Math.sqrt(12)) : null; // jackknife, with the step of the delay grid in quadrature
const series = (v) => v.length > 1 ? `${v.slice(0, -1).join(', ')} and ${v[v.length - 1]}` : v.join(''); // "a, b and c"
const many = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;                                    // "1 window", "2 windows"
const smooth = (m) => { for (const p of [2, 3]) while (m % p === 0) m /= p; return m === 1; };
const fftSize = (N) => { for (let d = 0; ; d++) { if (N - d > 1 && smooth(N - d)) return N - d; if (smooth(N + d)) return N + d; } }; // the app's FFT (js/complex.js) has fast butterflies for factors 2, 3 and 4 only

// zero-phase second-order Butterworth low-pass run forward and backward, as the low-pass half of lib.bandpass: passes
// 1 / (1 + (f / fc)^4) of a sine (prewarped), 0.5 at fc
function lowpass(x, fc, rate) {
    const k = Math.tan(Math.PI * fc / rate), q = Math.SQRT1_2, m = 1 / (1 + k / q + k * k), b0 = k * k * m, b1 = 2 * b0, a1 = 2 * (k * k - 1) * m, a2 = (1 - k / q + k * k) * m;
    const pass = (u, reverse) => { const L = u.length, y = new Float64Array(L); let x1 = u[reverse ? L - 1 : 0], x2 = x1, y1 = x1, y2 = x1;
        for (let j = 0; j < L; j++) { const i = reverse ? L - 1 - j : j, v = b0 * u[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = u[i]; y2 = y1; y1 = v; y[i] = v; }
        return y; };
    return pass(pass(x, false), true);
}

// what lib.bandpass(x, band[0], band[1], rate) passes of a sine at f: the second-order Butterworth high- and low-pass,
// each run forward and backward (bilinear, so tan-prewarped)
function bandGain(f, band, rate) {
    const t = (v) => Math.tan(Math.PI * Math.min(v, 0.499 * rate) / rate), lo = (t(f) / t(band[0])) ** 4, hi = (t(f) / t(band[1])) ** 4;
    return lo / (1 + lo) / (1 + hi);
}
const gainRange = (band, rate) => { let lo = Infinity, hi = 0; for (let k = 0; k <= 100; k++) { const v = bandGain(band[0] * (band[1] / band[0]) ** (k / 100), band, rate); lo = Math.min(lo, v); hi = Math.max(hi, v); } return [r(lo, 2), r(hi, 2)]; };

// usable samples (health_loop analyse, and out of rescue) and their blocks { profile, n, i0, i1 } (samples i0 to i1 - 1,
// not all of them usable: a block keeps its profile across a switch away and back); id[i] is the block of sample i or -1
function usable(w, ctx) {
    const rate = ctx.rate || w.rate, n = w.n, prof = ctx.profile || w.profileAt, gov = ctx.govState, ok = new Uint8Array(n), guard = Math.max(1, Math.round(RULE.guardS * rate));
    for (let i = 0; i < n; i++) ok[i] = ctx.flying[i] && (!gov || gov[i] === 4) ? 1 : 0;
    for (let i = 1; i < n; i++) if (prof[i] !== prof[i - 1] || (gov && gov[i] !== gov[i - 1])) ok.fill(0, Math.max(0, i - guard), Math.min(n, i + guard));
    // RESCUE_STATE not OFF, its exit blend included (lib.cjs segments), widened by the guard only: the blend is already in it
    const ra = w.rescueAt; if (ra) for (let i = 0; i < n;) { if (!ra[i]) { i++; continue; } let j = i; while (j < n && ra[j]) j++; ok.fill(0, Math.max(0, i - guard), Math.min(n, j + guard)); i = j; }
    const size = Math.round(RULE.blockS * rate), raw = [], open = new Map(), id = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) { if (!ok[i]) continue; const p = prof[i], k = open.get(p);
        if (k === undefined || raw[k].n >= size) { open.set(p, raw.length); raw.push({ profile: p, n: 0, prev: k === undefined ? -1 : k }); }
        const b = open.get(p); raw[b].n++; id[i] = b; }
    const to = raw.map((_, k) => k); for (const k of open.values()) if (raw[k].n < RULE.minBlockS * rate) to[k] = raw[k].prev;
    const blocks = [], at = new Int32Array(raw.length).fill(-1);
    for (let i = 0; i < n; i++) { if (id[i] < 0) continue; const k = to[id[i]]; if (k < 0) { id[i] = -1; continue; }
        if (at[k] < 0) { at[k] = blocks.length; blocks.push({ profile: prof[i], n: 0, i0: i, i1: i }); } id[i] = at[k]; blocks[at[k]].n++; blocks[at[k]].i1 = i + 1; }
    return { rate, ok, id, blocks, prof };
}

// block b in index time (s from log start): t0 its first sample, t1 the sample after its last one, seconds its usable time,
// runs its contiguous runs of samples [t0, t1], the longest first (RULE.worst or fewer): a block of a profile flown again
// after a switch, or with rescue in it, spans more than its seconds
function blockSpan(w, U, b) {
    const { i0, i1, n } = U.blocks[b], t = (i) => r(w.fromS + i / U.rate, 3), runs = [];
    for (let i = i0; i < i1;) { if (U.id[i] !== b) { i++; continue; } let j = i; while (j < i1 && U.id[j] === b) j++; runs.push([i, j]); i = j; }
    return { t0: t(i0), t1: t(i1), seconds: r(n / U.rate, 1), runs: runs.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0])).slice(0, RULE.worst).map(([a, c]) => [t(a), t(c)]) };
}

// statistic of every profile and of all blocks together; list: block indices that qualify
function perProfile(U, list, stat) {
    const byProfile = {};
    for (const p of [...new Set(U.blocks.map(b => b.profile))]) byProfile[p] = stat(list.filter(b => U.blocks[b].profile === p), p);
    return { byProfile, all: stat(list, null) };
}

// ---------------------------------------------------------------------------------------------
// C12, C13 (T11, T12): tracking error and lag
// ---------------------------------------------------------------------------------------------

function tracking(w, a, U, H, startProfile) {
    const T = RULE.track, { rate, id, blocks } = U, n = w.n, s = w.sp[a], g = w.gyro[a], B = blocks.length, { step, max, K } = lagSteps(T, rate);
    const lpHz = Math.min(T.lpHz, 0.45 * rate), sl = lowpass(s, lpHz, rate), gl = lowpass(g, lpHz, rate);
    const ss = new Float64Array(B); for (let i = 0; i < n; i++) if (id[i] >= 0) ss[id[i]] += s[i] * s[i];
    const minRms = T.minSetpointRms[AXES[a]], on = Uint8Array.from(ss, (v, b) => Math.sqrt(v / blocks[b].n) >= minRms ? 1 : 0);
    // the samples that count: in a block with enough stick, |setpoint| > minAbsSetpoint (the PID lab's), their delayed gyro logged
    const use = new Uint8Array(n); for (let i = 0; i + max < n; i++) { const b = id[i]; use[i] = b >= 0 && on[b] && Math.abs(s[i]) > T.minAbsSetpoint ? 1 : 0; }
    // squared error of the low-passed signals per block and delay; the setpoint power (as logged) over the same samples
    const E = new Float64Array(B * K), S2 = new Float64Array(B), N2 = new Float64Array(B);
    for (let i = 0; i < n; i++) { if (!use[i]) continue; const b = id[i], v = sl[i], o = b * K; S2[b] += s[i] * s[i]; N2[b]++;
        for (let k = 0, j = i; k < K; k++, j += step) { const d = gl[j] - v; E[o + k] += d * d; } }
    const fit = (sel, skip) => { const e = new Float64Array(K); let p = 0;
        for (const b of sel) if (b !== skip) { p += S2[b]; for (let k = 0; k < K; k++) e[k] += E[b * K + k]; }
        let k0 = 0; for (let k = 1; k < K; k++) if (e[k] < e[k0]) k0 = k;
        const off = k0 > 0 && k0 < K - 1 ? vertex(e[k0 - 1], e[k0], e[k0 + 1]) : 0;
        return { k: k0, ms: (k0 + off) * step / rate * 1000, value: Math.sqrt(e[k0] / p), raw: Math.sqrt(e[0] / p) }; };
    const active = []; for (let b = 0; b < B; b++) if (on[b] && N2[b] > 0) active.push(b);
    const G = perProfile(U, active, (sel) => ({ sel, f: sel.length ? fit(sel, -1) : null }));
    // the error at the fitted delay of each block's profile (P) and of all profiles (A): above lpHz (vibration), and in bands
    // (the low-pass at the upper edge less the one at the lower edge, so that the bands add up to the error below lpHz)
    const kP = new Int32Array(B); for (const q of Object.values(G.byProfile)) if (q.f) for (const b of q.sel) kP[b] = q.f.k;
    const kA = G.all.f ? G.all.f.k : 0, two = () => ({ P: new Float64Array(B), A: new Float64Array(B) }), hf = two(), bands = [];
    if (active.length) {
        for (let i = 0; i < n; i++) { if (!use[i]) continue; const b = id[i], v = s[i] - sl[i], jP = i + kP[b] * step, jA = i + kA * step, dP = g[jP] - gl[jP] - v, dA = g[jA] - gl[jA] - v; hf.P[b] += dP * dP; hf.A[b] += dA * dA; }
        const cuts = T.bandEdges.filter(f => f < lpHz).concat([lpHz]); let lo = null;
        cuts.forEach((c, q) => {
            const hi = q === cuts.length - 1 ? { s: sl, g: gl } : { s: lowpass(s, c, rate), g: lowpass(g, c, rate) }, ee = two(), ex = two(), sp = new Float64Array(B);
            for (let i = 0; i < n; i++) { if (!use[i]) continue; const b = id[i], v = hi.s[i] - (lo ? lo.s[i] : 0), jP = i + kP[b] * step, jA = i + kA * step;
                const dP = hi.g[jP] - (lo ? lo.g[jP] : 0) - v, dA = hi.g[jA] - (lo ? lo.g[jA] : 0) - v; sp[b] += v * v;
                ee.P[b] += dP * dP; ee.A[b] += dA * dA; ex.P[b] += dP * (gl[jP] - sl[i]); ex.A[b] += dA * (gl[jA] - sl[i]); }
            bands.push({ hz: [q ? cuts[q - 1] : 0, c], ee, ex, sp }); lo = hi; });
    }
    const ratio = (x, y, sel, skip) => { let u = 0, v = 0; for (const b of sel) if (b !== skip) { u += x[b]; v += y[b]; } return v > 0 ? u / v : NaN; };
    const jack = (fn, sel) => r(jackSe(sel.length > 1 ? sel.map(fn) : []), 4);
    const bw = Array.isArray(H[AXES[a] + 'BW']) ? H[AXES[a] + 'BW'][0] : null, df = 0.01, f0 = RULE.lpfAtHz;
    const lpfMs = bw ? -(cx.arg(lib.lpf1Response(f0 + df, bw, rate)) - cx.arg(lib.lpf1Response(f0 - df, bw, rate))) / (2 * Math.PI * 2 * df) * 1000 : null;
    const res = perProfile(U, active, (sel, p) => {
        const usableBlocks = p === null ? B : blocks.filter(q => q.profile === p).length, { f } = p === null ? G.all : G.byProfile[p];
        if (!sel.length) return { blocks: 0, usableBlocks };
        const jk = sel.length > 1 ? sel.map(b => fit(sel, b)) : [], X = p === null ? 'A' : 'P', eL = new Float64Array(B); for (const b of sel) eL[b] = E[b * K + f.k];
        const above = (skip) => Math.sqrt(ratio(hf[X], S2, sel, skip));
        // the blocks with the largest error at the fitted delay, as the evidence of C12 and C13
        const worst = sel.map(b => [b, Math.sqrt(eL[b] / S2[b])]).sort((x, y) => y[1] - x[1]).slice(0, RULE.worst)
            .map(([b, v]) => Object.assign(blockSpan(w, U, b), { value: r(v, 4), setpointRms: r(Math.sqrt(S2[b] / N2[b]), 2) }));
        return { blocks: sel.length, usableBlocks, seconds: r(sum(sel.map(b => N2[b])) / rate, 1), setpointRms: r(Math.sqrt(sum(sel.map(b => S2[b])) / sum(sel.map(b => N2[b]))), 2), worst,
            tauMs: r(f.ms, 2), tauSe: r(lagSe(jk.map(q => q.ms), step, rate), 2), atMaxDelay: f.k === K - 1, value: r(f.value, 4), se: r(jackSe(jk.map(q => q.value)), 4),
            raw: r(f.raw, 4), rawSe: r(jackSe(jk.map(q => q.raw)), 4), above: { hz: r(lpHz, 1), value: r(above(-1), 4), se: jack(above, sel) },
            // share: of the error power below lpHz, the bands add up to 1; ratio: in-band error / in-band setpoint, which rises wherever the stick puts little
            bands: bands.map(q => { const share = (skip) => ratio(q.ex[X], eL, sel, skip), inBand = (skip) => Math.sqrt(ratio(q.ee[X], q.sp, sel, skip));
                return { hz: q.hz.map(v => r(v, 1)), share: r(share(-1), 4), shareSe: jack(share, sel), ratio: r(inBand(-1), 4), se: jack(inBand, sel), setpointRms: r(Math.sqrt(sum(sel.map(b => q.sp[b])) / sum(sel.map(b => N2[b]))), 2) }; }) };
    });
    return Object.assign({ minSetpointRms: minRms, minAbsSetpoint: T.minAbsSetpoint, lpHz: r(lpHz, 1), pidLpf: bw ? { hz: bw, ms: r(lpfMs, 2), atHz: f0, profile: startProfile } : null }, res);
}

// ---------------------------------------------------------------------------------------------
// R1: stick to setpoint lag
// ---------------------------------------------------------------------------------------------

// Both signals band-passed alike (zero phase) and differentiated; the lag is where their correlation over the usable
// samples with the stick moving peaks. For a PT1 (response time) it is the time constant less about (2 pi f tau)^2 / 3
// of it, f the stick frequencies below RULE.stick.band[1].
function stickLag(w, a, U, H) {
    const R = RULE.stick, rc = (w.extra || {})[`rcCommand[${a}]`];
    const header = { responseTime: Array.isArray(H.response_time) ? H.response_time[a] : null, accelLimit: Array.isArray(H.accel_limit) ? H.accel_limit[a] : null };
    // response time sets a PT1 at 500 / response_time Hz (TUNING_KNOWLEDGE 2.12): time constant response_time / pi ms
    const expectedMs = typeof header.responseTime === 'number' ? r(header.responseTime / Math.PI, 1) : null;
    if (!rc) return { skipped: `The log does not have rcCommand[${a}].`, header, expectedMs };
    const { rate, id, blocks } = U, n = w.n, B = blocks.length, { step, max, K } = lagSteps(R, rate);
    const diff = (v) => { const y = lib.bandpass(v, R.band[0], R.band[1], rate), d = new Float64Array(n); for (let i = 1; i < n - 1; i++) d[i] = (y[i + 1] - y[i - 1]) * rate / 2; return d; };
    const x = diff(rc), y = diff(w.sp[a]), xx = new Float64Array(B), xy = new Float64Array(B * K), yy = new Float64Array(B * K), moving = new Float64Array(B);
    const every = Math.max(1, Math.round(R.everyS * rate));
    for (let i = 1; i + max < n - 1; i += every) { const b = id[i]; if (b < 0 || Math.abs(x[i]) < R.moving) continue; const v = x[i], o = b * K; xx[b] += v * v; moving[b] += every;
        for (let k = 0, j = i; k < K; k++, j += step) { const q = y[j]; xy[o + k] += v * q; yy[o + k] += q * q; } }
    const sel = []; for (let b = 0; b < B; b++) if (moving[b] >= R.minMovingS * rate) sel.push(b);
    const fit = (skip) => { let sx = 0; for (const b of sel) if (b !== skip) sx += xx[b];
        const c = new Float64Array(K); for (let k = 0; k < K; k++) { let sxy = 0, syy = 0; for (const b of sel) if (b !== skip) { sxy += xy[b * K + k]; syy += yy[b * K + k]; } c[k] = sxy / Math.sqrt(sx * syy); }
        let k0 = -1; for (let k = 0; k < K; k++) if (isFinite(c[k]) && (k0 < 0 || Math.abs(c[k]) > Math.abs(c[k0]))) k0 = k;
        if (k0 < 0) return { k: -1, ms: NaN, corr: NaN }; // the setpoint never moves
        const off = k0 > 0 && k0 < K - 1 ? vertex(Math.abs(c[k0 - 1]), Math.abs(c[k0]), Math.abs(c[k0 + 1])) : 0;
        return { k: k0, ms: (k0 + off) * step / rate * 1000, corr: c[k0] }; };
    // blocksAt: the blocks the lag is fitted on, the largest share of the stick-rate power (their weight in the fit) first
    const sx = sum(sel.map(b => xx[b])), blocksAt = sel.map(b => Object.assign(blockSpan(w, U, b), { value: r(xx[b] / sx, 4), movingS: r(moving[b] / rate, 1) })).sort((p, q) => q.value - p.value);
    const out = { blocks: sel.length, movingS: r(sum(Array.from(moving)) / rate, 1), header, expectedMs, blocksAt };
    if (!sel.length) return out;
    const f = fit(-1), jk = sel.length > 1 ? sel.map(fit).filter(q => q.k >= 0) : [];
    // rcCommand[2] and setpoint[2] have opposite signs (setpoint.c:291-292): the sign of the peak is reported, its size used
    return Object.assign(out, { delayMs: r(f.ms, 2), se: r(lagSe(jk.map(q => q.ms), step, rate), 2), corr: r(f.corr, 3), atMaxDelay: f.k === K - 1 });
}

// ---------------------------------------------------------------------------------------------
// C5, T1: fast oscillation
// ---------------------------------------------------------------------------------------------

// half cycles of a band-passed signal between zero crossings: size and sample of each peak (wag.cjs halfCycles)
function halfCycles(y, i0, i1) {
    const out = []; let last = -1, pk = 0, at = i0;
    for (let i = Math.max(1, i0); i < i1; i++) {
        if (Math.abs(y[i]) > pk) { pk = Math.abs(y[i]); at = i; }
        if ((y[i - 1] < 0) !== (y[i] < 0)) { if (last >= 0) out.push({ at, peak: pk }); last = i; pk = 0; }
    }
    return out;
}

// The peak of a summed Welch PSD (bins j of frequency (k0 + j) df, K windows) in RULE.osc.psd. For every local maximum:
// its excess in dB over the least-squares line through 10 log10 PSD against log10 f of the bins RULE.osc.peakFlankHz away
// on both sides (unbiased on a sloping spectrum), and z = excess / its standard error: the spread of a Welch mean (Hann,
// 50 % overlap: nu = 2 K / 1.056) and the standard error of the line there, in quadrature. A peak (clear) is one with
// excess >= peakMinDb and z >= peakZ; of those the largest excess is taken, else the local maximum nearest to the rule
// (largest min(excess / peakMinDb, z / peakZ)). Null without a local maximum that has two flank bins on each side.
function prominentPeak(psd, k0, df, K) {
    const O = RULE.osc, [d0, d1] = O.peakFlankHz, sdW = 10 / Math.LN10 * Math.sqrt(1.056 / Math.max(1, K)); let best = null;
    for (let j = 1; j + 1 < psd.length; j++) {
        const f = (k0 + j) * df; if (f < O.psd[0] || f > O.psd[1] || !(psd[j] > 0 && psd[j] >= psd[j - 1] && psd[j] >= psd[j + 1])) continue;
        const X = [], Y = []; let below = 0, above = 0;
        for (let q = 0; q < psd.length; q++) { const d = (k0 + q) * df - f; if (Math.abs(d) < d0 || Math.abs(d) > d1 || !(psd[q] > 0)) continue; X.push(Math.log10((k0 + q) * df)); Y.push(10 * Math.log10(psd[q])); if (d < 0) below++; else above++; }
        if (below < 2 || above < 2) continue;
        const m = X.length, mx = sum(X) / m, my = sum(Y) / m, x0 = Math.log10(f); let sxx = 0, sxy = 0; for (let q = 0; q < m; q++) { sxx += (X[q] - mx) ** 2; sxy += (X[q] - mx) * (Y[q] - my); }
        const slope = sxy / sxx, line = (x) => my + slope * (x - mx), sdR = Math.sqrt(sum(X.map((x, q) => (Y[q] - line(x)) ** 2)) / (m - 2)), seLine = sdR * Math.sqrt(1 / m + (x0 - mx) ** 2 / sxx);
        const excessDb = 10 * Math.log10(psd[j]) - line(x0), z = excessDb / Math.hypot(sdW, seLine), clear = excessDb >= O.peakMinDb && z >= O.peakZ, near = Math.min(excessDb / O.peakMinDb, z / O.peakZ);
        if (!best || (clear ? !best.clear || excessDb > best.excessDb : !best.clear && near > best.near)) best = { j, excessDb, z, clear, near };
    }
    return best;
}

function oscillation(w, a, U, app) {
    const O = RULE.osc, band = O.bands[AXES[a]], { rate, id, ok, blocks, prof } = U, n = w.n;
    if (band[1] >= 0.45 * rate) return { band, skipped: `The log rate (${r(rate, 0)} Hz) is too low for the ${band.join('-')} Hz band.` };
    const e = new Float64Array(n); for (let i = 0; i < n; i++) e[i] = w.gyro[a][i] - w.sp[a][i];
    const bursts = lib.oscillationBursts(e, rate, { band }), be = bursts.filtered, bs = lib.bandpass(w.sp[a], band[0], band[1], rate);
    // half-second windows of usable time on one profile (wag.cjs windows); stick-driven as wag_report.cjs `driven`
    const W = Math.round(O.windowS * rate), win = [], free = new Uint8Array(n);
    for (let s0 = 0; s0 + W <= n; s0 += W) { if (id[s0] < 0) continue; let all = true; for (let i = s0 + 1; i < s0 + W && all; i++) all = id[i] >= 0 && prof[i] === prof[s0]; if (!all) continue;
        const A = amp(be, s0, s0 + W), As = amp(bs, s0, s0 + W), driven = A >= O.thresholds[0] && As > O.stickDriven * A;
        win.push({ b: id[s0], A, driven }); if (!driven) free.fill(1, s0, s0 + W); }
    // stick-free error spectrum: Hann windows of RULE.osc.psdS, hop half of it, inside runs of stick-free windows of one profile
    const N = fftSize(Math.round(O.psdS * rate)), FT = app && app.FFT ? lib.fftFor(app, N) : null, df = rate / N, spec = [];
    const k0 = Math.max(1, Math.ceil(O.psdFit[0] / df)), k1 = Math.min(Math.floor(O.psdFit[1] / df), Math.floor(0.45 * rate / df), (N >> 1) - 1);
    if (FT && k1 > k0) { const buf = new Float64Array(N), out = new Float64Array(2 * N), hop = N >> 1;
        for (let i = 0; i < n;) { if (!free[i]) { i++; continue; } let j = i; while (j < n && free[j] && prof[j] === prof[i]) j++;
            for (let s0 = i; s0 + N <= j; s0 += hop) { let m = 0; for (let q = 0; q < N; q++) m += e[s0 + q]; m /= N;
                for (let q = 0; q < N; q++) buf[q] = (e[s0 + q] - m) * FT.win[q]; FT.fft.simple(out, buf, 'real');
                spec.push({ b: id[s0], p: Float64Array.from({ length: k1 - k0 + 1 }, (_, q) => out[2 * (k0 + q)] ** 2 + out[2 * (k0 + q) + 1] ** 2) }); }
            i = j; } }
    // bursts in the band (lib.oscillationBursts), followed half cycle by half cycle in RULE.osc.cycleBand from RULE.osc.preS before
    const cyc = lib.bandpass(e, O.cycleBand[0], Math.min(O.cycleBand[1], 0.45 * rate), rate), pre = Math.round(O.preS * rate), ev = [];
    for (const b of bursts.bursts) {
        const i0 = Math.max(0, b.i0), i1 = Math.min(n, b.i1); let u = 0; for (let i = i0; i < i1; i++) u += ok[i]; if (u < 0.5 * (i1 - i0)) continue;
        const hc = halfCycles(cyc, i0 - pre, i1), first = hc.findIndex(h => h.peak >= O.onset.high); let start = -1;
        if (first > 0) for (let k = first - 1; k >= 0; k--) if (hc[k].peak < O.onset.small) { start = k; break; }
        const grows = start >= 0 && first - start >= O.onset.minHalfCycles, A = amp(be, i0, i1), As = amp(bs, i0, i1), G = bandGain(b.hz, band, rate);
        ev.push({ t: r(w.fromS + i0 / rate, 3), seconds: r(b.seconds, 2), hz: r(b.hz, 2), value: r(b.peak, 1), amplitude: r(b.amplitude, 1), sine: G >= 0.05 ? r(b.peak / G, 1) : null, growthPerCycle: r(b.growthPerCycle, 3),
            stickShare: r(As / A, 2), profile: prof[i0], selfExcited: grows && As < O.stickDriven * A, onsetT: grows ? r(w.fromS + hc[start].at / rate, 3) : null, halfCyclesToHigh: grows ? first - start : null });
    }
    const all = []; for (let b = 0; b < blocks.length; b++) all.push(b);
    const res = perProfile(U, all, (sel, p) => {
        const inSel = new Uint8Array(blocks.length); for (const b of sel) inSel[b] = 1;
        const list = win.filter(q => inSel[q.b]), fr = list.filter(q => !q.driven), used = [...new Set(fr.map(q => q.b))];
        const share = (thr, skip) => { let c = 0, m = 0; for (const q of fr) if (q.b !== skip) { m++; if (q.A >= thr) c++; } return m ? c / m : null; };
        const A = fr.map(q => q.A).sort((x, y) => x - y), sp = spec.filter(q => inSel[q.b]), L = Math.max(0, k1 - k0 + 1), psd = new Float64Array(L), byBlock = new Map();
        for (const q of sp) { let v = byBlock.get(q.b); if (!v) byBlock.set(q.b, v = new Float64Array(L)); for (let j = 0; j < L; j++) { psd[j] += q.p[j]; v[j] += q.p[j]; } }
        const pk = sp.length ? prominentPeak(psd, k0, df, sp.length) : null, clear = !!pk && pk.clear;
        const at = (P, j) => (k0 + j + vertex(P[j - 1], P[j], P[j + 1])) * df, hz = pk ? at(psd, pk.j) : null, bu = ev.filter(q => p === null || q.profile === p);
        // its frequency with each block's windows left out: the local maximum nearest it (or its bin), refined alike
        const jk = []; if (clear && byBlock.size > 1) for (const v of byBlock.values()) { const P = psd.map((x, j) => x - v[j]);
            jk.push(at(P, [0, -1, 1, -2, 2].map(d => pk.j + d).find(q => q > 0 && q + 1 < L && P[q] >= P[q - 1] && P[q] >= P[q + 1]) ?? pk.j)); }
        return { windows: list.length, stickFree: fr.length, stickDriven: list.length - fr.length, blocks: used.length,
            shares: Object.fromEntries(O.thresholds.map(thr => [thr, r(share(thr, -1), 4)])), sharesSe: Object.fromEntries(O.thresholds.map(thr => [thr, r(jackSe(used.length > 1 ? used.map(b => share(thr, b)) : []), 4)])),
            median: r(quantile(A, 0.5), 1), p99: r(quantile(A, 0.99), 1), spectrumWindows: sp.length,
            peak: pk ? { hz: r(hz, 2), excessDb: r(pk.excessDb, 2), z: r(pk.z, 2), clear } : null, // the peak (clear), else the local maximum nearest to the rule
            peakHz: clear ? r(hz, 2) : null, peakHzSe: clear ? r(jackSe(jk), 2) : null, peakInBand: clear ? hz >= band[0] && hz <= band[1] : null,
            bursts: bu.length, selfExcitedBursts: largest(bu.filter(q => q.selfExcited)) };
    });
    return Object.assign({ band, gain: gainRange(band, rate), events: largest(ev) }, res);
}

// ---------------------------------------------------------------------------------------------
// analyse
// ---------------------------------------------------------------------------------------------

function analyse(w, ctx) {
    const U = usable(w, ctx), rate = U.rate, n = w.n, H = ctx.header || (w.flight && w.flight.header) || {}, notes = [];
    let usableN = 0; for (let i = 0; i < n; i++) usableN += U.ok[i];
    if (!ctx.govState) notes.push('The log does not record GOVSTATE. Thus, the analysis uses all samples in flight, not only the samples with the governor ACTIVE.');
    const byProfile = {}; for (const b of U.blocks) byProfile[b.profile] = (byProfile[b.profile] || 0) + 1;
    const out = { module: 'health_track', rule: RULE, rate: r(rate, 2), fromS: r(w.fromS, 3), seconds: { total: r(n / rate, 1), usable: r(usableN / rate, 1), inBlocks: r(sum(U.blocks.map(b => b.n)) / rate, 1) },
        blocks: { count: U.blocks.length, byProfile }, notes };
    if (usableN < 5 * rate) { out.skipped = `The log has only ${r(usableN / rate, 1)} s of flight data that the checks can use. A minimum of 5 s is necessary.`; return out; }
    if (!U.blocks.length) { out.skipped = `No PID profile has ${RULE.minBlockS} s of flight data that the checks can use.`; return out; }
    out.track = {}; out.stick = {}; out.osc = {};
    AXES.forEach((name, a) => { out.track[name] = tracking(w, a, U, H, U.prof[0]); out.stick[name] = stickLag(w, a, U, H); out.osc[name] = oscillation(w, a, U, ctx.app); });
    if (!(ctx.app && ctx.app.FFT)) notes.push('The FFT is not available (ctx.app). Thus, the analysis does not calculate the error spectra.');
    const noRc = AXES.filter(name => out.stick[name].skipped); if (noRc.length) notes.push(`The log does not have rcCommand for ${series(noRc)}. Thus, the analysis does not do check R1 for ${noRc.length > 1 ? 'these axes' : 'this axis'}.`);
    return out;
}

// ---------------------------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------------------------

// the sources are shown to the pilot (quoted, review V3): no file name (the PID lab: js/flight_analysis.js; the bands and the
// onset rule: wag.cjs RULE.bands, wag_report.cjs RULES.stickDriven and RULES.onset)
const TRACK_SOURCE = `pipeline, unvalidated; the levels of the PID lab of the Flight analysis dialog (30 % / 45 %) for its formula (samples with |setpoint| > ${RULE.track.minAbsSetpoint} deg/s, best delay 0-${RULE.track.maxS * 1000} ms); ` +
    `here with gyro and setpoint low-passed at ${RULE.track.lpHz} Hz, per profile, on ${RULE.blockS} s blocks with setpoint rms >= ${RULE.track.minSetpointRms.roll} (yaw ${RULE.track.minSetpointRms.yaw}) deg/s, where the PID lab pools its steadiest stable-flight window`;
const LAG_SOURCE = 'pipeline, unvalidated; report only, no documented threshold: the flag is generous and catches broken setups only';
const OSC_SOURCE = 'pipeline, unvalidated; the bands, the stick rule and the onset rule (small 30, high 150, minHalfCycles 6) of the tail oscillation analysis; ' +
    'the limits of the spectrum peak, set on simulated flights';
const DEFAULT_RULES = {
    C12: { note: 0.30, flag: 0.45, minBlocks: 4, source: TRACK_SOURCE },
    T11: { note: 0.30, flag: 0.45, minBlocks: 4, source: TRACK_SOURCE },
    C13: { flag: 120, minBlocks: 4, source: LAG_SOURCE },
    T12: { flag: 120, minBlocks: 4, source: LAG_SOURCE },
    R1: { flag: 40, minBlocks: 4, source: 'pipeline, unvalidated; doc RATES: response time "too high could cause significant input delay"' },
    C5: { level: 20, share: 0.05, minWindows: 20, minBlocks: 3, source: OSC_SOURCE }, // minBlocks: the block jackknife needs RULE.minJack
    T1: { level: 20, share: 0.05, minWindows: 20, minBlocks: 3, source: OSC_SOURCE },
};

// Finding texts follow ASD-STE100 (docs/STE_GLOSSARY.md): sentences of 25 words or less, paragraphs of 6 sentences or
// less, joined by '\n'. A note on thin data has thin: true. Code reads the fields of a finding, never its text.
const UNITS = { C12: 'fraction', T11: 'fraction', C13: 'ms', T12: 'ms', R1: 'ms', C5: 'fraction', T1: 'fraction' };

function judge(flights, RULES = DEFAULT_RULES) {
    const F = [], fmt = (v, d = 2) => typeof v === 'number' && isFinite(v) ? v.toFixed(d) : 'unknown', pct = (v) => typeof v === 'number' ? v * 100 : null;
    const pm = (v, se, d) => typeof se === 'number' && isFinite(se) ? `${fmt(v, d)} ± ${fmt(se, d)}` : fmt(v, d), lv = (x) => `${fmt(x * 100, 0)} %`;
    const rule = (id) => RULES[id] || DEFAULT_RULES[id];
    const add = (id, severity, f, profile, o) => F.push(Object.assign({ id, severity, log: f.log, profile: profile === undefined || profile === null ? null : +profile, value: null, se: null, n: null, threshold: null, source: rule(id).source || null, unit: UNITS[id],
        phase: 'flight' }, o)); // every check of this module uses the flight phase only (SPEC2 D13 correction)
    const thin = (what, n, min, why) => `The data is not sufficient for a result. The number of ${what} is ${n}. A minimum of ${min} is necessary${why ? ` for ${why}` : ''}.`;
    const past = (v, se, t) => typeof v === 'number' && typeof se === 'number' && v - 2 * se > t;
    const para = (...p) => p.map(q => q && q.trim()).filter(Boolean).join('\n'), BL = `periods of ${RULE.blockS} s`, bl = (k) => `${many(k, 'period')} of ${RULE.blockS} s`;
    const info = (t) => `This value is for information. Only a time delay of more than ${t} ms by more than 2 SE is a problem.`;

    for (const f of flights) {
        const M = f.metrics; if (!M) continue;
        if (M.skipped) { for (const id of Object.keys(DEFAULT_RULES)) add(id, 'skipped', f, null, { text: M.skipped }); continue; }
        for (const ax of AXES) {
            const yaw = ax === 'yaw', tr = M.track && M.track[ax], st = M.stick && M.stick[ax], os = M.osc && M.osc[ax];
            // C12 / T11 and C13 / T12
            const [idE, idL] = yaw ? ['T11', 'T12'] : ['C12', 'C13'], RE = rule(idE), RL = rule(idL);
            if (tr) for (const [p, s] of Object.entries(tr.byProfile)) {
                if (s.blocks < RE.minBlocks) { const why = thin(`${BL} with a ${ax} setpoint of ${tr.minSetpointRms} deg/s rms or more`, `${s.blocks} of ${s.usableBlocks}`, RE.minBlocks);
                    add(idE, 'note', f, p, { axis: ax, value: s.value === undefined ? null : s.value, se: s.se === undefined ? null : s.se, n: s.blocks, unit: 'fraction', thin: true, text: why });
                    add(idL, 'note', f, p, { axis: ax, value: s.tauMs === undefined ? null : s.tauMs, se: s.tauSe === undefined ? null : s.tauSe, n: s.blocks, unit: 'ms', thin: true, text: why }); continue; }
                const lp = fmt(tr.lpHz, 0), m = fmt(tr.minAbsSetpoint, 0), bands = series((s.bands || []).map(q => `${pm(pct(q.share), pct(q.shareSe), 0)} % (${q.hz.join('-')} Hz)`));
                const flag = past(s.value, s.se, RE.flag), note = !flag && s.value > RE.note;
                const verdict = flag ? `The error is more than ${lv(RE.flag)} by more than 2 SE. The gyro does not follow the setpoint at the frequencies of the largest bands. Possible causes are an oscillation (C5, T1) or an output limit (C2, T8).`
                    : note ? `The error is more than ${lv(RE.note)}, but it is not more than ${lv(RE.flag)} by more than 2 SE.` : `The error is not more than ${lv(RE.note)}.`;
                add(idE, flag ? 'flag' : note ? 'note' : 'ok', f, p, { axis: ax, value: s.value, se: s.se, n: s.blocks, unit: 'fraction', threshold: `value - 2 SE > ${RE.flag} flag, value > ${RE.note} note`, tauMs: s.tauMs, raw: s.raw, above: s.above || null, bands: s.bands,
                    text: para(`The ${ax} tracking error is ${pm(pct(s.value), pct(s.se), 1)} % of the setpoint (${fmt(s.setpointRms, 1)} deg/s rms), after the analysis removes a time delay of ${fmt(s.tauMs, 1)} ms. ` +
                        `If the analysis does not remove the time delay, the error is ${fmt(pct(s.raw), 1)} %. ${verdict}`,
                        `The analysis applies a low-pass filter of ${lp} Hz to the gyro and the setpoint. It uses ${fmt(s.seconds, 0)} s in ${bl(s.blocks)}, and only the samples where the setpoint is more than ${m} deg/s or less than -${m} deg/s.`,
                        (bands ? `The parts of the error power in the frequency bands are ${bands}. ` : '') + (s.above ? `The gyro at more than ${lp} Hz is ${pm(pct(s.above.value), pct(s.above.se), 1)} % of the setpoint rms, and the check does not include this vibration (F1, F5, F6).` : '')) });
                const lpf = tr.pidLpf && +tr.pidLpf.profile === +p ? `The gyro low-pass filter of the PID loop (${tr.pidLpf.hz} Hz in the header) causes a time delay of ${fmt(tr.pidLpf.ms, 1)} ms at ${tr.pidLpf.atHz} Hz. ` +
                    'This filter is only in the feedback, and the log records the gyro before it. Thus, the measured time delay does not include it.' : '', lag = past(s.tauMs, s.tauSe, RL.flag);
                add(idL, lag ? 'flag' : 'note', f, p, { axis: ax, value: s.tauMs, se: s.tauSe, n: s.blocks, unit: 'ms', threshold: `delay - 2 SE > ${RL.flag} ms flag, else report only`, pidLpfMs: lpf ? tr.pidLpf.ms : null,
                    text: para(`The ${ax} gyro follows the setpoint after a time delay of ${pm(s.tauMs, s.tauSe, 1)} ms (${bl(s.blocks)}).` + (s.atMaxDelay ? ` This is the maximum time delay that the analysis examines (${fmt(RULE.track.maxS * 1000, 0)} ms).` : '') +
                        (lag ? ` The time delay is more than ${RL.flag} ms by more than 2 SE. This is too much for a loop that operates correctly, and the cause is not the loop gains. Examine the gyro filters and the servos.` : ` ${info(RL.flag)}`), lpf) });
            }
            // R1
            if (st) { const R = rule('R1'), h = st.header, how = `The analysis uses ${bl(st.blocks)} with ${fmt(st.movingS, 0)} s of stick movement.`;
                const hdr = `In the header, response_time is ${h.responseTime ?? 'unknown'}` + (typeof st.expectedMs === 'number' ? ` (a PT1 filter with a time constant of ${fmt(st.expectedMs, 1)} ms)` : '') + ` and accel_limit is ${h.accelLimit ?? 'unknown'}.`;
                if (st.skipped) add('R1', 'skipped', f, null, { axis: ax, unit: 'ms', text: st.skipped });
                else if (st.blocks < R.minBlocks) add('R1', 'note', f, null, { axis: ax, value: st.delayMs === undefined ? null : st.delayMs, se: st.se === undefined ? null : st.se, n: st.blocks, unit: 'ms', thin: true,
                    text: para(thin(`${BL} with ${RULE.stick.minMovingS} s of ${ax} stick movement or more`, st.blocks, R.minBlocks), hdr) });
                else { const flag = past(st.delayMs, st.se, R.flag);
                    add('R1', flag ? 'flag' : 'note', f, null, { axis: ax, value: st.delayMs, se: st.se, n: st.blocks, unit: 'ms', threshold: `delay - 2 SE > ${R.flag} ms flag, else report only`, corr: st.corr,
                        text: para(`The ${ax} setpoint follows the stick after a time delay of ${pm(st.delayMs, st.se, 1)} ms (correlation ${fmt(st.corr, 3)}).` +
                            (flag ? ` The time delay is more than ${R.flag} ms by more than 2 SE. The adjustments of the rate profile cause it. Decrease response_time or accel_limit. Examine rc_smoothness.` : ` ${info(R.flag)}`),
                            `${how} ${hdr} The log does not record the rate profile. Thus, the analysis uses all of the log.`) }); } }
            // C5 / T1
            if (os) { const id = yaw ? 'T1' : 'C5', R = rule(id), lvl = R.level, O = RULE.osc;
                if (os.skipped) { add(id, 'skipped', f, null, { axis: ax, text: os.skipped }); continue; }
                const at = `${os.band.join('-')} Hz`, free = 'windows where the stick does not cause the error', flank = `a line through the spectrum ${O.peakFlankHz.join('-')} Hz from it on each side`;
                const filt = `The analysis applies a filter to the ${ax} error (the gyro minus the setpoint) and keeps only the ${at} band.` + (os.gain ? ` The gain of this filter is ${fmt(os.gain[0], 2)} to ${fmt(os.gain[1], 2)} in the band.` : '');
                for (const [p, s] of Object.entries(os.byProfile)) {
                    const pk = s.peak, need = `A local maximum is a peak if it is ${O.peakMinDb} dB or more and ${O.peakZ} SE or more.`, sh = O.thresholds.map((v, k) => `${v} deg/s or more in ${fmt(pct(s.shares[v]), 1)} %${k ? '' : ' of these windows'}`);
                    const win = `The analysis uses ${many(s.stickFree, 'window')} of ${O.windowS} s where the stick does not cause the error.` + (s.stickDriven ? ` It does not use the ${many(s.stickDriven, 'window')} where the stick causes it.` : '') +
                        (s.stickFree ? ` The amplitude is ${series(sh)}. The median amplitude is ${fmt(s.median, 1)} deg/s, and 99 % of the windows have ${fmt(s.p99, 1)} deg/s or less.` : '');
                    const peak = !s.spectrumWindows ? (s.stickFree ? `The analysis cannot calculate an error spectrum for these windows. The log has no period of ${O.psdS} s with only these windows, or the FFT is not available.` : '')
                        : s.peakHz !== null ? `The error spectrum of these windows has a peak at ${pm(s.peakHz, s.peakHzSe, 1)} Hz (${many(s.spectrumWindows, 'window')}). The peak is ${fmt(pk.excessDb, 1)} dB more than ${flank} (${fmt(pk.z, 1)} SE). ${need}` + (s.peakInBand ? '' : ` This peak is not in the ${at} band.`)
                        : `The error spectrum of these windows has no clear peak at ${O.psd.join('-')} Hz (${many(s.spectrumWindows, 'window')}). ` + (pk ? `The local maximum nearest to a peak is at ${fmt(pk.hz, 1)} Hz. It is ${fmt(pk.excessDb, 1)} dB more than ${flank} (${fmt(pk.z, 1)} SE). ` : 'The spectrum has no local maximum with sufficient data on each side. ') + need;
                    if (s.selfExcitedBursts.length) { const list = s.selfExcitedBursts, big = list[0];
                        add(id, 'flag', f, p, { axis: ax, value: list.length, n: s.bursts, unit: 'count', threshold: `any burst growing from < ${O.onset.small} to >= ${O.onset.high} deg/s over >= ${O.onset.minHalfCycles} half cycles (in ${O.cycleBand.join('-')} Hz) with the stick below ${O.stickDriven} of it`,
                            events: list.map(q => ({ t: q.onsetT === null ? q.t : q.onsetT, value: q.value })),
                            text: para(`The number of ${ax} oscillations at ${at} that increase with no stick input is ${list.length} of ${s.bursts}. ` +
                                `The largest is ${fmt(big.value, 0)} deg/s after the filter${typeof big.sine === 'number' ? ` (approximately ${fmt(big.sine, 0)} deg/s before the filter)` : ''}, at ${fmt(big.hz, 1)} Hz at ${fmt(big.onsetT === null ? big.t : big.onsetT, 1)} s. ` +
                                'Possible causes are a loop gain that is too high at this frequency, or a mechanical problem.' +
                                (list.length > 1 ? '' : ' A load or a low battery can also cause 1 oscillation of this type.'), filt, win, peak) }); continue; }
                    // thin: too few stick-free windows, or all of them in one block (no standard error for the share)
                    if (s.stickFree < R.minWindows || s.blocks < R.minBlocks || typeof s.sharesSe[lvl] !== 'number') {
                        const why = s.stickFree < R.minWindows ? thin(free, s.stickFree, R.minWindows) : s.blocks < R.minBlocks ? thin(`${BL} with ${free}`, s.blocks, R.minBlocks, 'a standard error')
                            : 'The data is not sufficient for a result. The analysis cannot calculate a standard error for the time with oscillation.';
                        add(id, 'note', f, p, { axis: ax, value: s.shares[lvl], se: s.sharesSe[lvl], n: s.stickFree, unit: 'fraction', thin: true, text: para(why, filt, win, peak) }); continue; }
                    const present = past(s.shares[lvl], s.sharesSe[lvl], R.share);
                    add(id, present ? 'note' : 'ok', f, p, { axis: ax, value: s.shares[lvl], se: s.sharesSe[lvl], n: s.stickFree, unit: 'fraction', threshold: `share >= ${lvl} deg/s - 2 SE > ${R.share} note`, peakHz: s.peakHz,
                        text: para((present ? `The ${ax} error has an oscillation at ${at}. ` : '') + `The amplitude is ${lvl} deg/s or more in ${pm(pct(s.shares[lvl]), pct(s.sharesSe[lvl]), 1)} % of the ${free} (${bl(s.blocks)}). ` +
                            `This is ${present ? '' : 'not '}more than ${lv(R.share)} by more than 2 SE. ` + (s.bursts ? `The number of oscillations that increase with no stick input is 0 of ${s.bursts}.` : 'The analysis finds no oscillation in the band.'), filt, win, peak) });
                } }
        }
    }
    return F;
}

// ---------------------------------------------------------------------------------------------
// curves
// ---------------------------------------------------------------------------------------------

// Per axis: time series per RULE.curve.stepS, the Welch spectra of setpoint, gyro and error with the closed loop
// setpoint -> gyro, and the error by size of the setpoint. err, errComp and errVsSp are of gyro and setpoint low-passed
// at RULE.track.lpHz (lpHz in the output), as C12 has them: the vibration above it is not tracking error. errComp and
// errVsSp use the delay of C13 (all profiles).
function curves(w, ctx, metrics) {
    const U = usable(w, ctx), rate = U.rate, n = w.n, C = RULE.curve, O = RULE.osc, M = metrics && !metrics.skipped ? metrics : null, lpHz = Math.min(RULE.track.lpHz, 0.45 * rate);
    const bin = Math.max(1, Math.round(C.stepS * rate)), nb = Math.ceil(n / bin), half = Math.round(O.windowS * rate / 2), t = new Float32Array(nb);
    for (let k = 0; k < nb; k++) t[k] = w.fromS + (k * bin + (Math.min(n, (k + 1) * bin) - k * bin) / 2) / rate;
    // Welch windows inside runs of usable samples
    const N = fftSize(Math.round(C.specS * rate)), hop = Math.max(1, Math.round(C.hopS * rate)), starts = [];
    for (let i = 0; i < n;) { if (!U.ok[i]) { i++; continue; } let j = i; while (j < n && U.ok[j]) j++; for (let s0 = i; s0 + N <= j; s0 += hop) starts.push(s0); i = j; }
    const FT = ctx.app && ctx.app.FFT ? lib.fftFor(ctx.app, N) : null, K = Math.floor(Math.min(C.maxHz, 0.45 * rate) * N / rate), out = {};
    AXES.forEach((name, a) => {
        const s = w.sp[a], g = w.gyro[a], sl = lowpass(s, lpHz, rate), gl = lowpass(g, lpHz, rate), tr = M && M.track && M.track[name] && M.track[name].all, tauMs = tr && typeof tr.tauMs === 'number' ? tr.tauMs : null, lag = tauMs === null ? 0 : Math.round(tauMs * rate / 1000);
        const sp = new Float32Array(nb), err = new Float32Array(nb), errComp = new Float32Array(nb), osc = new Float32Array(nb).fill(NaN), stickDriven = new Uint8Array(nb), use = new Uint8Array(nb);
        const band = O.bands[name], P = new Float64Array(n + 1), Q = new Float64Array(n + 1), bandOk = band[1] < 0.45 * rate;
        if (bandOk) { const e = new Float64Array(n); for (let i = 0; i < n; i++) e[i] = g[i] - s[i];
            const be = lib.bandpass(e, band[0], band[1], rate), bs = lib.bandpass(s, band[0], band[1], rate); for (let i = 0; i < n; i++) { P[i + 1] = P[i] + be[i] * be[i]; Q[i + 1] = Q[i] + bs[i] * bs[i]; } }
        for (let k = 0; k < nb; k++) {
            const i0 = k * bin, i1 = Math.min(n, i0 + bin); let s2 = 0, e2 = 0, c2 = 0, m = 0, u = 0;
            for (let i = i0; i < i1; i++) { s2 += s[i] * s[i]; const d = sl[i] - gl[i]; e2 += d * d; if (i + lag < n) { const c = sl[i] - gl[i + lag]; c2 += c * c; m++; } u += U.ok[i]; }
            sp[k] = Math.sqrt(s2 / (i1 - i0)); err[k] = Math.sqrt(e2 / (i1 - i0)); errComp[k] = m ? Math.sqrt(c2 / m) : NaN; use[k] = 2 * u >= i1 - i0 ? 1 : 0;
            if (bandOk) { const c = (i0 + i1) >> 1, j0 = Math.max(0, c - half), j1 = Math.min(n, c + half), A = Math.sqrt(2 * (P[j1] - P[j0]) / (j1 - j0)), As = Math.sqrt(2 * (Q[j1] - Q[j0]) / (j1 - j0));
                osc[k] = A; stickDriven[k] = A >= O.thresholds[0] && As > O.stickDriven * A ? 1 : 0; }
        }
        let spectrum = null;
        if (FT) {
            const { fft, win, power } = FT, R = new Float64Array(2 * N), Y = new Float64Array(2 * N), br = new Float64Array(N), by = new Float64Array(N), z = () => new Float64Array(K + 1);
            const rr = z(), yy = z(), ee = z(), re = z(), im = z(), m = starts.length;
            for (const s0 of starts) {
                let mr = 0, my = 0; for (let i = 0; i < N; i++) { mr += s[s0 + i]; my += g[s0 + i]; } mr /= N; my /= N;
                for (let i = 0; i < N; i++) { br[i] = (s[s0 + i] - mr) * win[i]; by[i] = (g[s0 + i] - my) * win[i]; }
                fft.simple(R, br, 'real'); fft.simple(Y, by, 'real');
                for (let k = 1; k <= K; k++) { const ar = R[2 * k], ai = R[2 * k + 1], yr = Y[2 * k], yi = Y[2 * k + 1];
                    rr[k] += ar * ar + ai * ai; yy[k] += yr * yr + yi * yi; ee[k] += (ar - yr) ** 2 + (ai - yi) ** 2; re[k] += ar * yr + ai * yi; im[k] += ar * yi - ai * yr; } // conj(R) Y
            }
            const norm = 2 / (rate * power) / Math.max(1, m), f32 = (fn) => Float32Array.from({ length: K }, (_, j) => m ? fn(j + 1) : NaN), Tdeg = new Float32Array(K).fill(NaN);
            if (m) { let prev = null; for (let k = 1; k <= K; k++) { let p = Math.atan2(im[k], re[k]); if (prev !== null) { while (p - prev > Math.PI) p -= 2 * Math.PI; while (p - prev < -Math.PI) p += 2 * Math.PI; } prev = p; Tdeg[k - 1] = p * 180 / Math.PI; } }
            spectrum = { f: Float32Array.from({ length: K }, (_, j) => (j + 1) * rate / N), rr: f32(k => rr[k] * norm), yy: f32(k => yy[k] * norm), ee: f32(k => ee[k] * norm), ratio: f32(k => Math.sqrt(ee[k] / rr[k])),
                Tmag: f32(k => Math.hypot(re[k], im[k]) / rr[k]), Tdeg, coh: f32(k => (re[k] ** 2 + im[k] ** 2) / (rr[k] * yy[k])), windows: m, band: band.slice() };
        }
        // mean |error| by |setpoint| over usable samples; |setpoint| at or above the last edge is counted in `above`
        const E = C.edges, nE = E.length - 1, sa = new Float64Array(nE), sc = new Float64Array(nE), cn = new Float64Array(nE), cc = new Float64Array(nE); let above = 0;
        for (let i = 0; i < n; i++) { if (!U.ok[i]) continue; const v = Math.abs(s[i]); if (v >= E[nE]) { above++; continue; } let j = 0; while (v >= E[j + 1]) j++;
            sa[j] += Math.abs(sl[i] - gl[i]); cn[j]++; if (i + lag < n) { sc[j] += Math.abs(sl[i] - gl[i + lag]); cc[j]++; } }
        // oscBand, oscGain: the band of time.osc and what its band-pass passes of a sine in it (bandGain), as C5 and T1 have them
        out[name] = { time: { t, sp, err, errComp, osc, stickDriven, usable: use }, tauMs, lpHz: r(lpHz, 1), oscBand: band.slice(), oscGain: bandOk ? gainRange(band, rate) : null, spectrum,
            errVsSp: { edges: E.slice(), meanAbsErr: Array.from(sa, (v, j) => cn[j] ? r(v / cn[j], 2) : null), meanAbsErrComp: Array.from(sc, (v, j) => cc[j] ? r(v / cc[j], 2) : null), n: Array.from(cn), above } };
    });
    return out;
}

module.exports = { EXTRA, RULE, DEFAULT_RULES, analyse, judge, curves, usable, lowpass, bandGain };
