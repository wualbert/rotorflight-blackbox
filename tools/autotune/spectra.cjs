'use strict';

/**
 * Vibration spectra for plotting and for the vibration tables of the report.
 *
 *   node tools/autotune/spectra.cjs <out dir> <log file> [log numbers for the spectrograms, e.g. 16,24]
 *
 * Writes <out dir>/spectra.json; spectra_plot.py draws it. Frequencies are true hertz: they use the frame rate that
 * the log clock gives, not the nominal one. Everything is from samples in flight, as in wag.cjs.
 *
 *   profiles     per log and PID profile: mean squared amplitude per 1 Hz band of the raw gyro, the filtered gyro
 *                and the control, up to half the frame rate
 *   orders       per log: the same against rotor revolutions, raw and filtered gyro
 *   tracking     per 2 s window: the strongest line of the raw gyro between two multiples of rotor speed, and the
 *                headspeed at that moment; shows whether a line follows the rotor
 *   spectrograms for the chosen logs: raw gyro against time and frequency, from start to end of the log
 */

const fs = require('node:fs'), path = require('node:path');
const lib = require('./lib.cjs');

const RULE = {
    headspeed: lib.FLIGHT_RPM,    // in flight: airborne and rotor above this
    windowS: 2, steady: 100,      // profile spectra: windows in which headspeed stays within this many rpm
    maxHz: 497,
    order: { perRev: 32, revolutions: 256, to: 9 },
    track: { from: 3.5, to: 4.3, minHeadspeed: 1500 }, // multiples of rotor speed between which the strongest line is followed
    spectrogram: { windowS: 1, hopS: 0.25, binHz: 2, maxHz: 450 },
};

const [OUT, FILE, PICK] = process.argv.slice(2);
if (!OUT || !FILE) { console.error('usage: node spectra.cjs <out dir> <log file> [log numbers for spectrograms]'); process.exit(2); }
const pick = PICK ? PICK.split(',').map(Number) : null;

const app = lib.loadApp();
const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const sig = (v) => +v.toPrecision(4);
const mean = (x, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += x[i]; return s / (i1 - i0); };
const range = (x, i0, i1) => { let lo = Infinity, hi = -Infinity; for (let i = i0; i < i1; i++) { if (x[i] < lo) lo = x[i]; if (x[i] > hi) hi = x[i]; } return [lo, hi]; };
const all = (x, i0, i1, v) => { for (let i = i0; i < i1; i++) if (x[i] !== v) return false; return true; };

// squared amplitude per bin of one window: a sinusoid of amplitude A gives A^2 at its bin
function power(fftSet, x, s, N, out, buf) {
    const m = mean(x, s, s + N);
    for (let i = 0; i < N; i++) buf[i] = (x[s + i] - m) * fftSet.win[i];
    fftSet.fft.simple(out, buf, 'real');
    const p = new Float64Array(N / 2); for (let k = 0; k < N / 2; k++) p[k] = (out[2 * k] ** 2 + out[2 * k + 1] ** 2) / (N / 4) ** 2;
    return p;
}

const EXTRA = ['govTarget', 'gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]'];
const profiles = [], orders = [], tracking = [], spectrograms = [], logs = [];
for (const w of lib.segments(app, FILE, { whole: true, extra: EXTRA })) {
    const fl = w.flight, rate = fl.actualRate, n = w.n, raw = [0, 1, 2].map(a => w.extra[`gyroRAW[${a}]`]);
    if (!raw.every(Boolean)) continue;
    const target = w.extra.govTarget || w.hs, profile = lib.profilesOf(w, target, RULE.headspeed).p;
    const flying = Uint8Array.from(w.hs, (h, i) => (w.airborneAt[i] && h >= RULE.headspeed) ? 1 : 0);
    let up = 0; for (let i = 0; i < n; i++) up += flying[i];
    logs.push({ log: fl.log, start: fl.start, rate: r(rate, 2), seconds: r(n / rate, 1), flyingS: r(up / rate, 1) });

    // spectra per profile, steady headspeed
    { const N = Math.round(RULE.windowS * fl.rate), set = lib.fftFor(app, N), buf = new Float64Array(N), out = new Float64Array(2 * N), bins = Math.floor(RULE.maxHz), toBand = (k) => Math.round(k * rate / N);
        const sigs = { raw, gyro: w.gyro, control: w.u };
        for (let s = 0; s + N <= n; s += N / 2) {
            if (!all(flying, s, s + N, 1) || !all(profile, s, s + N, profile[s])) continue;
            const [lo, hi] = range(w.hs, s, s + N); if (hi - lo > RULE.steady) continue;
            let e = profiles.find(v => v.log === fl.log && v.profile === profile[s]);
            if (!e) profiles.push(e = { log: fl.log, profile: profile[s], windows: 0, headspeed: 0, raw: [0, 1, 2].map(() => new Float64Array(bins + 1)), gyro: [0, 1, 2].map(() => new Float64Array(bins + 1)), control: [0, 1, 2].map(() => new Float64Array(bins + 1)) });
            for (const key of Object.keys(sigs)) for (let a = 0; a < 3; a++) { const p = power(set, sigs[key][a], s, N, out, buf); for (let k = 1; k < N / 2; k++) { const b = toBand(k); if (b <= bins) e[key][a][b] += p[k] / 1.5; } } // 1.5: width of the Hann window in bins
            e.windows++; e.headspeed += mean(w.hs, s, s + N);
        } }

    // against rotor revolutions
    { const O = RULE.order, N = O.perRev * O.revolutions, set = lib.fftFor(app, N), buf = new Float64Array(N), out = new Float64Array(2 * N), R = lib.byRevolution(w.hs, rate, [...raw, ...w.gyro], O.perRev), top = Math.round(O.to * O.revolutions);
        const e = { log: fl.log, windows: 0, step: 1 / O.revolutions, raw: [0, 1, 2].map(() => new Float64Array(top + 1)), gyro: [0, 1, 2].map(() => new Float64Array(top + 1)) };
        for (let s = 0; s + N <= R.M; s += N / 2) { let ok = true; for (let i = s; i < s + N && ok; i += 16) if (!flying[R.index[i]]) ok = false; if (!ok) continue;
            for (let a = 0; a < 3; a++) { const p = power(set, R.columns[a], s, N, out, buf), q = power(set, R.columns[3 + a], s, N, out, buf); for (let k = 0; k <= top; k++) { e.raw[a][k] += p[k]; e.gyro[a][k] += q[k]; } }
            e.windows++; }
        if (e.windows) orders.push(e); }

    // the strongest line between two multiples of rotor speed, window by window, also while headspeed is on the move
    { const N = Math.round(RULE.windowS * fl.rate), set = lib.fftFor(app, N), buf = new Float64Array(N), out = new Float64Array(2 * N), T = RULE.track;
        for (let s = 0; s + N <= n; s += N / 2) { const hs = mean(w.hs, s, s + N), [lo, hi] = range(w.hs, s, s + N); if (lo < T.minHeadspeed) continue;
            const p = [0, 1, 2].map(a => power(set, raw[a], s, N, out, buf)), tot = Float64Array.from(p[0], (v, k) => v + p[1][k] + p[2][k]);
            const k0 = Math.round(T.from * hs / 60 * N / rate), k1 = Math.min(N / 2 - 2, Math.round(T.to * hs / 60 * N / rate)), pk = lib.spectralPeak(tot, k0, k1), one = lib.spectralPeak(tot, Math.round(0.9 * hs / 60 * N / rate), Math.round(1.1 * hs / 60 * N / rate));
            const band = Array.from(tot.subarray(k0, k1 + 1)).sort((x, y) => x - y);
            tracking.push({ log: fl.log, t: r(w.fromS + s / rate, 1), profile: all(profile, s, s + N, profile[s]) ? profile[s] : -1, flying: all(flying, s, s + N, 1), headspeed: r(hs, 0), swing: r(hi - lo, 0), hz: r(pk.bin * rate / N, 2), amplitude: r(Math.sqrt(pk.power), 1),
                prominence: r(Math.sqrt(pk.power / band[band.length >> 1]), 1), mainHz: r(one.bin * rate / N, 2), mainAmplitude: r(Math.sqrt(one.power), 1) }); } }

    // spectrogram of the whole log
    if (pick ? pick.includes(fl.log) : false) { const S = RULE.spectrogram, N = Math.round(S.windowS * fl.rate), hop = Math.round(S.hopS * fl.rate), set = lib.fftFor(app, N), buf = new Float64Array(N), out = new Float64Array(2 * N), rows = Math.floor(S.maxHz / S.binHz);
        const e = { log: fl.log, binHz: S.binHz, hopS: S.hopS, t: [], headspeed: [], target: [], profile: [], amplitude: [] };
        for (let s = 0; s + N <= n; s += hop) { const tot = new Float64Array(rows);
            for (let a = 0; a < 3; a++) { const p = power(set, raw[a], s, N, out, buf); for (let k = 1; k < N / 2; k++) { const b = Math.floor(k * rate / N / S.binHz); if (b < rows) tot[b] += p[k] / 1.5; } }
            e.t.push(r(w.fromS + (s + N / 2) / rate, 2)); e.headspeed.push(r(mean(w.hs, s, s + N), 0)); e.target.push(r(mean(target, s, s + N), 0)); e.profile.push(profile[s + (N >> 1)]); e.amplitude.push(Array.from(tot, v => sig(Math.sqrt(v)))); }
        spectrograms.push(e); }
    console.error(`#${fl.log}: ${(up / rate).toFixed(0)} s in flight`);
}

for (const e of profiles) { e.headspeed = r(e.headspeed / e.windows, 0); for (const k of ['raw', 'gyro', 'control']) e[k] = e[k].map(p => Array.from(p, v => sig(v / e.windows))); }
for (const e of orders) for (const k of ['raw', 'gyro']) e[k] = e[k].map(p => Array.from(p, v => sig(v / e.windows)));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'spectra.json'), JSON.stringify({ file: path.basename(FILE), rule: RULE, logs, profiles, orders, tracking, spectrograms }));
console.error(`${profiles.length} log-profile spectra, ${orders.length} order spectra, ${tracking.length} tracked windows, ${spectrograms.length} spectrograms -> ${path.join(OUT, 'spectra.json')}`);
