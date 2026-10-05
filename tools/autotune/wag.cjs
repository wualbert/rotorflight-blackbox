'use strict';

/**
 * Oscillation evidence from every second of every log.
 *
 *   node tools/autotune/wag.cjs <out dir> <log file> [more log files...]
 *
 * Writes <out dir>/bursts.json, which wag_report.cjs turns into report.md. Nothing is left out for being short, for
 * sitting between two profile switches or for the headspeed being on the move: a log is read from start to end
 * and every sample with the rotor turning in flight counts, under the PID profile that was active at that moment.
 *
 *   windows     half-second windows: oscillation amplitude per axis next to profile, headspeed, tail load, collective
 *   bursts      every burst of sustained oscillation in gyro - setpoint; the large yaw bursts half cycle by half cycle
 *   spectrum    amplitude of gyro - setpoint per 1 Hz band, per log, profile and axis
 *   sticks      cross-spectra between the four sticks (roll, pitch, yaw, collective) and the gyro, per log and
 *               profile, from which the report splits the motion into what the sticks explain and what they do not
 *   lines       what turns with the rotor: the strongest lines of the raw gyro as multiples of the main rotor, and
 *               their size per log and profile in the raw gyro, the filtered gyro, the control and the servo commands
 *   segments    the steady stretches (one profile, 20 s or more), whose spectra give the airframe response
 */

const fs = require('node:fs'), path = require('node:path');
const lib = require('./lib.cjs');
const { cx } = lib;

const RULE = {
    flight: { headspeed: lib.FLIGHT_RPM, rate: 10 }, // in flight: airborne, rotor above this rpm, in a log whose body rate then exceeds this many deg/s rms
    windowS: 0.5,
    bands: { roll: [10, 20], pitch: [8, 16], yaw: [5, 16] }, // Hz, where each axis oscillates
    spectrum: { seconds: 2, from: 4, to: 30 },
    sticks: { seconds: 2, from: 1, to: 40 }, // Hz, bands 1 Hz wide
    loadBins: [0.15, 0.30, 0.45],        // tail load = -mean yaw control over a 2 s window
    big: { amplitude: 30, peak: 80 },    // deg/s: a yaw burst at or above either counts as a large event
    cycleBand: [5, 25],                  // Hz, for the cycle-by-cycle trace of large yaw events
    limitSamples: 20,                    // an extreme of the yaw control reached this often is an output limit
    torqueBand: [2, 15],                 // Hz, band of the yaw acceleration regression
    filterHz: [5, 8, 10, 12, 15, 20, 30],
    gainsFromS: 5,                       // gains are recovered from stretches on one profile at least this long
    order: { perRev: 32, revolutions: 1024, headspeed: lib.FLIGHT_RPM * 1.1, from: 0.5, to: 9, harmonic: 0.01, lines: 12 },
    lineWindowS: 2, lineSteady: 100,     // a line is measured in windows where headspeed stays within this many rpm
};

const [OUT, ...FILES] = process.argv.slice(2);
if (!OUT || !FILES.length) { console.error('usage: node wag.cjs <out dir> <log file> [more log files...]'); process.exit(2); }

const app = lib.loadApp();
const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const mean = (x, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += x[i]; return s / (i1 - i0); };
const rms = (x, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += x[i] * x[i]; return Math.sqrt(s / (i1 - i0)); };
const range = (x, i0, i1) => { let lo = Infinity, hi = -Infinity; for (let i = i0; i < i1; i++) { if (x[i] < lo) lo = x[i]; if (x[i] > hi) hi = x[i]; } return [lo, hi]; };
const swing = (x, i0, i1) => { const [lo, hi] = range(x, i0, i1); return hi - lo; };
const all = (x, i0, i1, v) => { for (let i = i0; i < i1; i++) if (x[i] !== v) return false; return true; };
const pack = (S) => { const p = { windows: S.windows }; for (const k in S) if (k !== 'windows') p[k] = Array.from(S[k], v => +v.toPrecision(7)); return p; };

// complex amplitude of x at frequency hz over [i0, i1), Hann weighted: x(t) ~ Re(A e^{j 2 pi hz t})
function tone(x, i0, i1, hz, rate) {
    let re = 0, im = 0, w = 0; const n = i1 - i0, m = mean(x, i0, i1);
    for (let i = 0; i < n; i++) { const h = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1))), ph = 2 * Math.PI * hz * i / rate; re += h * (x[i0 + i] - m) * Math.cos(ph); im -= h * (x[i0 + i] - m) * Math.sin(ph); w += h; }
    return [2 * re / w, 2 * im / w];
}

// half cycles of a band-passed signal between two samples: time and size of each peak, frequency from its duration
function halfCycles(y, u, stick, load, rate, i0, i1) {
    const out = []; let last = null, pk = 0, at = 0, upk = 0, spk = 0;
    for (let i = Math.max(1, i0); i < i1; i++) {
        if (Math.abs(y[i]) > Math.abs(pk)) { pk = y[i]; at = i; }
        if (Math.abs(u[i]) > upk) upk = Math.abs(u[i]);
        if (Math.abs(stick[i]) > spk) spk = Math.abs(stick[i]);
        if ((y[i - 1] < 0) !== (y[i] < 0)) {
            if (last !== null) out.push({ at, peak: pk, hz: rate / (2 * (i - last)), control: upk, stick: spk, load: -mean(load, Math.max(0, at - 100), Math.min(load.length, at + 100)) });
            last = i; pk = 0; upk = 0; spk = 0;
        }
    }
    return out;
}

const EXTRA = ['govTarget', 'govSum', 'Vbat', 'gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]', 'servo[0]', 'servo[1]', 'servo[2]', 'servo[3]'];
const seen = new Map(), flights = [], segments = [], windows = [], bursts = [], spectrum = [], sticks = [], torqueData = [], yawExtremes = new Map(), lineWindows = [];
const O = RULE.order, ON = O.perRev * O.revolutions, orderAcc = [0, 1, 2].map(() => new Float64Array(ON / 2)); let orderCount = 0;
const orderCross = [0, 1, 2].map(() => ({ xx: new Float64Array(ON / 2), re: new Float64Array(ON / 2), im: new Float64Array(ON / 2) }));

for (const file of FILES) {
    for (const w of lib.segments(app, file, { whole: true, extra: EXTRA })) {
        const fl = w.flight, x = w.extra, rate = fl.actualRate, n = w.n, yawU = w.u[2];
        if (seen.has(fl.id) && seen.get(fl.id) !== file) continue;
        seen.set(fl.id, file);
        const target = x.govTarget || w.hs, { p: profile, targetOf } = lib.profilesOf(w, target, RULE.flight.headspeed);

        // in flight?
        const flying = new Uint8Array(n); let up = 0, turn = 0;
        for (let i = 0; i < n; i++) if (w.airborneAt[i] && w.hs[i] >= RULE.flight.headspeed) { flying[i] = 1; up++; turn += w.gyro[0][i] ** 2 + w.gyro[1][i] ** 2 + w.gyro[2][i] ** 2; }
        const bodyRate = up ? Math.sqrt(turn / up) : 0, flown = up / rate >= 5 && bodyRate >= RULE.flight.rate;
        if (!flown) flying.fill(0);
        let rec = flights.find(f => f.id === fl.id);
        if (!rec) flights.push(rec = { id: fl.id, file: fl.file, log: fl.log, start: fl.start, durationS: r(fl.durationS, 1), rate: fl.rate, actualRate: r(rate, 2), gaps: fl.gaps, flown, flyingS: 0, bodyRate: r(bodyRate, 1), targetOf, seconds: {},
            header: { yawPID: fl.header.yawPID, rollPID: fl.header.rollPID, pitchPID: fl.header.pitchPID, yaw_stop_gain: fl.header.yaw_stop_gain, yawBW: fl.header.yawBW, rollBW: fl.header.rollBW, pitchBW: fl.header.pitchBW, yaw_precomp: fl.header.yaw_precomp,
                govPID: fl.header.govPID, gyro_rpm_notch_source_yaw: fl.header.gyro_rpm_notch_source_yaw, gyro_rpm_notch_q_yaw: fl.header.gyro_rpm_notch_q_yaw, gyro_rpm_notch_source_roll: fl.header.gyro_rpm_notch_source_roll, gyro_rpm_notch_q_roll: fl.header.gyro_rpm_notch_q_roll,
                gyro_lpf1_static_hz: fl.header.gyro_lpf1_static_hz, gyro_lpf2_static_hz: fl.header.gyro_lpf2_static_hz, dyn_notch_count: fl.header.dyn_notch_count, features: fl.header.features } });
        if (flown) rec.flyingS = r(rec.flyingS + up / rate, 1);
        for (let i = 0; i < n; i += 10) if (flying[i]) rec.seconds[profile[i]] = (rec.seconds[profile[i]] || 0) + 10 / rate;
        if (!flown) { console.error(`${fl.file.slice(-19)} #${fl.log}: not a flight (${(up / rate).toFixed(0)} s airborne above ${RULE.flight.headspeed} rpm, body rate ${bodyRate.toFixed(1)} deg/s rms)`); continue; }
        for (let i = 0; i < n; i++) if (flying[i]) { const v = yawU[i]; yawExtremes.set(v, (yawExtremes.get(v) || 0) + 1); }

        const error = [0, 1, 2].map(a => Float64Array.from(w.gyro[a], (v, i) => v - w.sp[a][i]));
        const band = lib.AXES.map((name, a) => lib.bandpass(error[a], RULE.bands[name][0], RULE.bands[name][1], rate));
        const stick = lib.AXES.map((name, a) => lib.bandpass(w.sp[a], RULE.bands[name][0], RULE.bands[name][1], rate));

        // half-second windows
        const W = Math.round(RULE.windowS * rate), amp = (v, s) => rms(v, s, s + W) * Math.SQRT2;
        for (let s = W; s + 2 * W <= n; s += W) {
            if (!all(flying, s, s + W, 1)) continue;
            const [lo, hi] = range(w.hs, s, s + W), [tlo, thi] = range(target, s, s + W), pr = all(profile, s, s + W, profile[s]) ? profile[s] : -1;
            windows.push({ log: fl.log, t: r(w.fromS + s / rate, 2), profile: pr, target: r(mean(target, s, s + W), 0), headspeed: r(mean(w.hs, s, s + W), 0), hsLow: lo, hsHigh: hi, ramp: thi - tlo > 50 || pr < 0,
                roll: r(amp(band[0], s), 1), pitch: r(amp(band[1], s), 1), yaw: r(amp(band[2], s), 1), stick: [0, 1, 2].map(a => r(amp(stick[a], s), 1)),
                load: r(-mean(yawU, s, s + W)), throttle: x.govSum ? r(mean(x.govSum, s, s + W) / 1000) : null, collective: w.coll ? r(Math.abs(mean(w.coll, s, s + W)), 0) : null, collectiveSwing: w.coll ? r(swing(w.coll, s, s + W), 0) : null,
                yawSetpointSwing: r(swing(w.sp[2], s, s + W), 0), volts: x.Vbat ? r(mean(x.Vbat, s, s + W) / 100, 2) : null,
                // how far each stick moved in this window and the half second before it: roll, pitch, yaw (deg/s), collective
                stickSwing: [w.sp[0], w.sp[1], w.sp[2], w.coll].map(v => v ? r(swing(v, s - W, s + W), 0) : null) });
        }

        // bursts
        const cyc = [error[2], yawU, w.sp[2]].map(v => lib.bandpass(v, RULE.cycleBand[0], RULE.cycleBand[1], rate));
        for (let a = 0; a < 3; a++) for (const b of lib.oscillationBursts(error[a], rate).bursts) {
            const i0 = Math.max(0, b.i0), i1 = Math.min(n, b.i1); if (mean(flying, i0, i1) < 0.5) continue;
            const t = (v) => tone(v, i0, i1, b.hz, rate), Y = t(w.gyro[a]), U = t(w.u[a]), UY = cx.div(U, Y), [lo, hi] = range(w.hs, i0, i1);
            const o = { log: fl.log, axis: lib.AXES[a], atS: r(w.fromS + b.start, 2), seconds: r(b.seconds, 2), hz: r(b.hz, 2), cycles: r(b.cycles, 1), amplitude: r(b.amplitude, 1), peak: r(b.peak, 1),
                angleDeg: r(b.amplitude / (2 * Math.PI * b.hz), 2), growthPerCycle: r(b.growthPerCycle), profileStart: profile[i0], profileEnd: profile[i1 - 1], targetStart: r(target[i0], 0), targetEnd: r(target[i1 - 1], 0),
                headspeed: r(mean(w.hs, i0, i1), 0), hsLow: lo, hsHigh: hi, collective: w.coll ? r(mean(w.coll, i0, i1), 0) : null, collectiveSwing: w.coll ? r(swing(w.coll, i0, i1), 0) : null,
                setpoint: r(mean(w.sp[a], i0, i1), 0), stickShare: r(rms(stick[a], i0, i1) / (rms(band[a], i0, i1) || 1), 2),
                stickSwing: [w.sp[0], w.sp[1], w.sp[2], w.coll].map(v => v ? r(swing(v, Math.max(0, i0 - Math.round(0.5 * rate)), i1), 0) : null), // during the burst and the half second before it
                control: r(mean(w.u[a], i0, i1)), controlRange: range(w.u[a], i0, i1).map(v => r(v)), controlPerGyro: r(cx.abs(UY), 5), controlLeadDeg: r(cx.arg(UY) * 180 / Math.PI, 0),
                others: [0, 1, 2].map(k => r(cx.abs(cx.div(t(w.gyro[k]), Y)), 2)) }; // motion of each axis at the burst frequency, relative to this axis
            if (a === 2 && (b.amplitude >= RULE.big.amplitude || b.peak >= RULE.big.peak)) {
                const H = cx.div(t(w.hs), Y), T = x.govSum ? cx.div(t(x.govSum), Y) : null;
                Object.assign(o, { large: true, headspeedPerGyro: r(cx.abs(H), 4), throttlePerGyro: T ? r(cx.abs(T) / 1000, 7) : null, volts: x.Vbat ? r(mean(x.Vbat, i0, i1) / 100, 2) : null,
                    halfCycles: halfCycles(cyc[0], cyc[1], cyc[2], yawU, rate, i0 - Math.round(0.3 * rate), i1).map(h => ({ atS: r(w.fromS + h.at / rate, 3), peak: r(h.peak, 1), hz: r(h.hz, 1), control: r(h.control, 3), stick: r(h.stick, 1), load: r(h.load, 2),
                        headspeed: r(w.hs[h.at], 0), collective: w.coll ? r(w.coll[h.at], 0) : null, profile: profile[h.at] })) });
            }
            bursts.push(o);
        }

        // amplitude spectrum of gyro - setpoint per log and profile
        { const N = Math.round(RULE.spectrum.seconds * fl.rate), { fft, win } = lib.fftFor(app, N), buf = new Float64Array(N), out = new Float64Array(2 * N), S = RULE.spectrum;
            for (let s = 0; s + N <= n; s += N / 2) {
                if (!all(flying, s, s + N, 1) || !all(profile, s, s + N, profile[s])) continue;
                let e = spectrum.find(v => v.log === fl.log && v.profile === profile[s]);
                if (!e) spectrum.push(e = { log: fl.log, profile: profile[s], windows: 0, hz: Array.from({ length: S.to - S.from + 1 }, (_, i) => S.from + i), power: [0, 1, 2].map(() => new Float64Array(S.to - S.from + 1)) });
                for (let a = 0; a < 3; a++) { const m = mean(error[a], s, s + N); for (let i = 0; i < N; i++) buf[i] = (error[a][s + i] - m) * win[i]; fft.simple(out, buf, 'real');
                    // squared amplitude per bin, gathered into bands 1 Hz wide around each whole frequency
                    for (let k = 1; k < N / 2; k++) { const hz = Math.round(k * rate / N) - S.from; if (hz >= 0 && hz <= S.to - S.from) e.power[a][hz] += (out[2 * k] ** 2 + out[2 * k + 1] ** 2) / (N / 4) ** 2 / 1.5; } }
                e.windows++;
            } }

        // the four sticks against the gyro: cross-spectra in bands 1 Hz wide
        if (w.coll) { const K = RULE.sticks, N = Math.round(K.seconds * fl.rate), { fft, win } = lib.fftFor(app, N), buf = new Float64Array(N), nb = K.to - K.from + 1, ins = [w.sp[0], w.sp[1], w.sp[2], w.coll];
            const X = ins.map(() => new Float64Array(2 * N)), Y = [0, 1, 2].map(() => new Float64Array(2 * N));
            const tf = (v, s, out) => { const m = mean(v, s, s + N); for (let i = 0; i < N; i++) buf[i] = (v[s + i] - m) * win[i]; fft.simple(out, buf, 'real'); };
            for (let s = 0; s + N <= n; s += N / 2) {
                if (!all(flying, s, s + N, 1) || !all(profile, s, s + N, profile[s])) continue;
                let e = sticks.find(v => v.log === fl.log && v.profile === profile[s]);
                if (!e) sticks.push(e = { log: fl.log, profile: profile[s], windows: 0, from: K.from, to: K.to, xxRe: new Float64Array(nb * 16), xxIm: new Float64Array(nb * 16), xyRe: new Float64Array(nb * 12), xyIm: new Float64Array(nb * 12), yy: new Float64Array(nb * 3) });
                ins.forEach((v, i) => tf(v, s, X[i])); [0, 1, 2].forEach(a => tf(w.gyro[a], s, Y[a]));
                for (let k = 1; k < N / 2; k++) { const b = Math.round(k * rate / N) - K.from; if (b < 0 || b >= nb) continue;
                    for (let p = 0; p < 4; p++) { const ar = X[p][2 * k], ai = X[p][2 * k + 1];
                        for (let q = 0; q < 4; q++) { const br = X[q][2 * k], bi = X[q][2 * k + 1]; e.xxRe[b * 16 + p * 4 + q] += ar * br + ai * bi; e.xxIm[b * 16 + p * 4 + q] += ar * bi - ai * br; }  // conj(Xp) Xq
                        for (let a = 0; a < 3; a++) { const yr = Y[a][2 * k], yi = Y[a][2 * k + 1]; e.xyRe[b * 12 + a * 4 + p] += ar * yr + ai * yi; e.xyIm[b * 12 + a * 4 + p] += ar * yi - ai * yr; } }     // conj(Xp) Y
                    for (let a = 0; a < 3; a++) e.yy[b * 3 + a] += Y[a][2 * k] ** 2 + Y[a][2 * k + 1] ** 2; }
                e.windows++;
            } }

        // what turns with the rotor: raw gyro against rotor revolutions, and the filtered gyro against the raw one
        { const cols = [0, 1, 2].flatMap(a => [x[`gyroRAW[${a}]`], w.gyro[a]]);
            if (cols.every(Boolean)) { const R = lib.byRevolution(w.hs, rate, cols, O.perRev), { fft, win } = lib.fftFor(app, ON), bx = new Float64Array(ON), by = new Float64Array(ON), X = new Float64Array(2 * ON), Y = new Float64Array(2 * ON);
                for (let s = 0; s + ON <= R.M; s += ON / 2) { let ok = true; for (let i = s; i < s + ON && ok; i += 64) { const j = R.index[i]; if (!flying[j] || w.hs[j] < O.headspeed) ok = false; } if (!ok) continue;
                    for (let a = 0; a < 3; a++) { const xr = R.columns[2 * a], yf = R.columns[2 * a + 1], mx = mean(xr, s, s + ON), my = mean(yf, s, s + ON);
                        for (let i = 0; i < ON; i++) { bx[i] = (xr[s + i] - mx) * win[i]; by[i] = (yf[s + i] - my) * win[i]; }
                        fft.simple(X, bx, 'real'); fft.simple(Y, by, 'real');
                        for (let k = 0; k < ON / 2; k++) { const p = X[2 * k] ** 2 + X[2 * k + 1] ** 2; orderAcc[a][k] += p; orderCross[a].xx[k] += p; orderCross[a].re[k] += X[2 * k] * Y[2 * k] + X[2 * k + 1] * Y[2 * k + 1]; orderCross[a].im[k] += X[2 * k] * Y[2 * k + 1] - X[2 * k + 1] * Y[2 * k]; } }
                    orderCount++; } } }

        // windows in which the lines are measured once their orders are known
        { const N = Math.round(RULE.lineWindowS * fl.rate), { fft, win } = lib.fftFor(app, N), buf = new Float64Array(N), out = new Float64Array(2 * N);
            const sig = { raw: [0, 1, 2].map(a => x[`gyroRAW[${a}]`]), gyro: w.gyro, control: w.u, servo: [0, 1, 2, 3].map(k => x[`servo[${k}]`]) };
            if (sig.raw.every(Boolean)) for (let s = 0; s + N <= n; s += N) {
                if (!all(flying, s, s + N, 1) || !all(profile, s, s + N, profile[s]) || swing(w.hs, s, s + N) > RULE.lineSteady) continue;
                const spec = (v) => { const m = mean(v, s, s + N); for (let i = 0; i < N; i++) buf[i] = (v[s + i] - m) * win[i]; fft.simple(out, buf, 'real'); return Float32Array.from({ length: N / 2 }, (_, k) => Math.sqrt(out[2 * k] ** 2 + out[2 * k + 1] ** 2) / (N / 4)); };
                lineWindows.push({ log: fl.log, profile: profile[s], t: r(w.fromS + s / rate, 1), headspeed: mean(w.hs, s, s + N), binHz: rate / N, load: r(-mean(yawU, s, s + N)), collective: w.coll ? r(Math.abs(mean(w.coll, s, s + N)), 0) : null,
                    osc: [0, 1, 2].map(a => r(rms(band[a], s, s + N) * Math.SQRT2, 1)), spectra: { raw: sig.raw.map(spec), gyro: sig.gyro.map(spec), control: sig.control.map(spec), servo: sig.servo.map(v => v ? spec(v) : null) } });
            } }

        // steady stretches on one profile: airframe response and gains
        w.profileAt = profile;
        for (const seg of lib.steadySegments(w, { minSegmentS: RULE.gainsFromS })) {
            const long = seg.seconds >= 20, N = lib.SPEC.N;
            const out = { flight: fl.id, file: fl.file, log: fl.log, profile: seg.profile, fromS: r(seg.fromS, 1), seconds: r(seg.seconds, 1), rate: seg.rate, headspeed: seg.headspeed, class: lib.headspeedClass(seg.headspeed.median), long, axes: {} };
            for (let a = 0; a < 3; a++) {
                const gains = lib.recoverGains(seg, a), raw = seg.extra[`gyroRAW[${a}]`], F = long && raw ? lib.segmentSpectra(app, { rate: seg.rate, sp: [raw], u: [seg.gyro[a]], gyro: [seg.gyro[a]] }, 0) : null;
                out.axes[lib.AXES[a]] = { gains: JSON.parse(JSON.stringify(gains, (k, v) => typeof v === 'number' ? +v.toPrecision(5) : v)), controlRange: range(seg.u[a], 0, seg.n).map(v => r(v)),
                    spectra: long ? pack(lib.segmentSpectra(app, seg, a, gains.integratorInput)) : null,
                    filter: F ? { windows: F.windows, hz: RULE.filterHz, rr: RULE.filterHz.map(h => F.rr[h * 2]), ryRe: RULE.filterHz.map(h => F.ryRe[h * 2]), ryIm: RULE.filterHz.map(h => F.ryIm[h * 2]) } : null };
            }
            if (long) { // yaw spectra window by window, summed by tail load once the output limits are known
                out.yawWindows = [];
                for (let s = 0; s + N <= seg.n; s += N / 2) { const cut = (v) => v.subarray(s, s + N), [min, max] = range(seg.u[2], s, s + N);
                    out.yawWindows.push({ load: -mean(seg.u[2], s, s + N), min, max, spectra: lib.segmentSpectra(app, { rate: seg.rate, sp: [cut(seg.sp[2])], u: [cut(seg.u[2])], gyro: [cut(seg.gyro[2])] }, 0) }); }
                if (seg.extra.govSum && seg.extra.Vbat) { // regression columns, all with the same zero-phase band-pass so a linear model is unchanged
                    const bp = (v) => lib.bandpass(v, RULE.torqueBand[0], RULE.torqueBand[1], seg.rate), acc = new Float64Array(seg.n), drive = new Float64Array(seg.n);
                    for (let i = 1; i < seg.n - 1; i++) acc[i] = (seg.gyro[2][i + 1] - seg.gyro[2][i - 1]) * seg.rate / 2;
                    for (let i = 0; i < seg.n; i++) drive[i] = seg.extra.govSum[i] / 1000 * seg.extra.Vbat[i] / 100;
                    torqueData.push({ class: out.class, flight: fl.id, n: seg.n, rate: seg.rate, acc: bp(acc), u: bp(seg.u[2]), drive: bp(drive), hs: bp(seg.hs), rate0: bp(seg.gyro[2]), raw: seg.u[2], thr: seg.extra.govSum });
                }
            }
            segments.push(out);
        }
        console.error(`${fl.file.slice(-19)} #${fl.log}: ${(up / rate).toFixed(0)} s in flight, profiles ${Object.entries(rec.seconds).map(([k, v]) => `${k}: ${v.toFixed(0)} s`).join(', ')}`);
    }
}

// Output limits of the yaw control: its extreme values, if the controller sat on them often enough
const values = [...yawExtremes.keys()].sort((a, b) => a - b), lo = values[0], hi = values[values.length - 1];
const limits = { lo: yawExtremes.get(lo) >= RULE.limitSamples ? lo : null, hi: yawExtremes.get(hi) >= RULE.limitSamples ? hi : null, samplesAtLo: yawExtremes.get(lo), samplesAtHi: yawExtremes.get(hi), min: lo, max: hi };

// Yaw spectra by tail load, from the windows that stay clear of the output limits: the small-signal response
for (const seg of segments) {
    if (!seg.yawWindows) continue;
    const clear = seg.yawWindows.filter(w => (limits.lo === null || w.min > limits.lo) && (limits.hi === null || w.max < limits.hi));
    seg.yawLimited = seg.yawWindows.length - clear.length;
    seg.yawClear = pack(lib.sumSpectra(clear.map(w => w.spectra)));
    seg.yawByLoad = [...RULE.loadBins, Infinity].map((top, b) => { const low = b ? RULE.loadBins[b - 1] : -Infinity, w = clear.filter(v => v.load >= low && v.load < top);
        return Object.assign(pack(lib.sumSpectra(w.map(v => v.spectra))), { loadSum: r(w.reduce((t, v) => t + v.load, 0)) }); });
    delete seg.yawWindows;
}

// Lines of the raw gyro in multiples of the main rotor. The main rotor's own once-per-revolution line sets the scale,
// so neither the headspeed reading nor the clock has to be exact.
const d = O.perRev / ON, total = Float64Array.from(orderAcc[0], (v, k) => v + orderAcc[1][k] + orderAcc[2][k]), lines = { windows: orderCount, revolutions: O.revolutions, resolution: d, list: [] };
if (orderCount) {
    const one = lib.spectralPeak(total, Math.round(0.95 / d), Math.round(1.05 / d)).bin * d, peaks = [];
    for (let k = Math.round(O.from / d); k < Math.round(O.to / d); k++) { let top = true; for (let j = k - 12; j <= k + 12 && top; j++) if (total[j] > total[k]) top = false; if (top) peaks.push(k); }
    peaks.sort((p, q) => total[q] - total[p]);
    lines.mainAt = one; // position of the main rotor line in multiples of the logged headspeed
    for (const k of peaks.slice(0, O.lines)) { const order = lib.spectralPeak(total, k - 2, k + 2).bin * d / one, through = [0, 1, 2].map(a => Math.hypot(orderCross[a].re[k], orderCross[a].im[k]) / orderCross[a].xx[k]);
        lines.list.push({ order: r(order, 4), harmonic: Math.abs(order - Math.round(order)) < O.harmonic ? Math.round(order) : null, raw: [0, 1, 2].map(a => r(Math.sqrt(orderAcc[a][k] / orderCount) / (ON / 4), 1)), filterPasses: through.map(v => r(v)) }); }
    // what the gyro filters let through, order by order: their notches show as dips
    lines.filter = []; for (let o = 0.5; o <= 8.001; o += 0.05) { const k = Math.round(o * one / d); lines.filter.push({ order: r(o, 2), passes: [0, 1, 2].map(a => r(Math.hypot(orderCross[a].re[k], orderCross[a].im[k]) / orderCross[a].xx[k])) }); }
    const foreign = lines.list.filter(l => l.harmonic === null).sort((a, b) => Math.max(...b.raw) - Math.max(...a.raw))[0];
    lines.foreign = foreign ? foreign.order : null;
    // size of the main rotor lines and of the strongest other line, window by window
    const watch = [1, 2, 4].concat(foreign ? [foreign.order] : []);
    lines.watch = watch;
    lines.perWindow = lineWindows.map(w => { const at = (spec, order) => { const k0 = Math.round(order * w.headspeed / 60 / w.binHz); let best = 0; for (let k = k0 - 2; k <= k0 + 2; k++) if (spec[k] > best) best = spec[k]; return best; };
        const pick = (list, scale = 1, d2 = 1) => list.map(spec => spec ? watch.map(o => r(at(spec, o) * scale, d2)) : null);
        return { log: w.log, profile: w.profile, t: w.t, headspeed: r(w.headspeed, 0), load: w.load, collective: w.collective, osc: w.osc, raw: pick(w.spectra.raw), gyro: pick(w.spectra.gyro), control: pick(w.spectra.control, 1000, 2), servo: pick(w.spectra.servo) }; });
}

// Yaw acceleration = b_u u(t - tu) + b_d [throttle x volts](t - td) + b_h headspeed + b_r yaw rate, per headspeed class,
// with leave-one-flight-out standard errors. Samples at an output limit or at full throttle are left out.
function regress(sel, tu, td, skip) {
    const k = 4, A = Array.from({ length: k }, () => new Float64Array(k)), b = new Float64Array(k); let syy = 0, N = 0;
    for (const v of sel) { if (v.flight === skip) continue; const iu = Math.round(tu * v.rate / 1000), id = Math.round(td * v.rate / 1000);
        for (let i = 1000; i < v.n - 1000; i += 4) {
            if ((limits.lo !== null && v.raw[i] <= limits.lo) || (limits.hi !== null && v.raw[i] >= limits.hi) || v.thr[i] >= 995) continue;
            const c = [v.u[i - iu], v.drive[i - id], v.hs[i], v.rate0[i]], y = v.acc[i];
            for (let p = 0; p < k; p++) { b[p] += c[p] * y; for (let q = 0; q < k; q++) A[p][q] += c[p] * c[q]; } syy += y * y; N++; } }
    const M = A.map((row, i) => [...row, b[i]]); // normal equations, Gauss-Jordan with pivoting
    for (let c = 0; c < k; c++) { let p = c; for (let q = c + 1; q < k; q++) if (Math.abs(M[q][c]) > Math.abs(M[p][c])) p = q; [M[c], M[p]] = [M[p], M[c]];
        for (let q = 0; q < k; q++) if (q !== c) { const f = M[q][c] / M[c][c]; for (let j = c; j <= k; j++) M[q][j] -= f * M[c][j]; } }
    const beta = M.map((row, i) => row[k] / row[i]); let sse = syy; for (let p = 0; p < k; p++) sse -= beta[p] * b[p];
    return { beta, r2: 1 - sse / syy, N };
}
const torque = {};
for (const c of [...new Set(torqueData.map(v => v.class))]) {
    const sel = torqueData.filter(v => v.class === c), ids = [...new Set(sel.map(v => v.flight))];
    if (ids.length < 3) continue;
    let best = null;
    for (let tu = 0; tu <= 60; tu += 4) for (let td = 0; td <= 60; td += 4) { const f = regress(sel, tu, td); if (!best || f.r2 > best.r2) best = Object.assign(f, { tu, td }); }
    const jk = ids.map(id => regress(sel, best.tu, best.td, id).beta), m = jk.length;
    const se = best.beta.map((v, p) => { const mu = jk.reduce((s, b) => s + b[p], 0) / m; return Math.sqrt((m - 1) / m * jk.reduce((s, b) => s + (b[p] - mu) ** 2, 0)); });
    torque[c] = { flights: m, samples: best.N, r2: r(best.r2), tailDelayMs: best.tu, motorDelayMs: best.td, beta: best.beta.map(v => r(v, 3)), se: se.map(v => r(v, 3)) };
}

for (const e of spectrum) e.power = e.power.map(p => Array.from(p, v => +v.toPrecision(5)));
for (const e of sticks) { e.amplitude = (RULE.sticks.seconds * 1000 / 4) ** 2 * 1.5; for (const k of ['xxRe', 'xxIm', 'xyRe', 'xyIm', 'yy']) e[k] = Array.from(e[k], v => +v.toPrecision(7)); }
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'bursts.json'), JSON.stringify({ files: FILES.map(f => path.basename(f)), burstRule: lib.BURST, rule: RULE, limits, flights, windows, bursts, spectrum, sticks, lines, torque, segments }));
console.error(`${flights.length} logs, ${flights.filter(f => f.flown).length} flown, ${windows.length} windows, ${bursts.length} bursts, ${segments.length} steady stretches -> ${path.join(OUT, 'bursts.json')}`);
