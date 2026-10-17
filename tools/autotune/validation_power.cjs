'use strict';

/**
 * Can flights show a recommended change, and how many flights (IMP-07)? A simulated or modelled change of a few percent
 * is often smaller than the flight-to-flight spread of every measurement of it: the field-trip changes of 2026-10-15
 * predicted -0.57 deg/s of cyclic tracking error against a flight-to-flight SD of about 1 deg/s (44 to 64 flights for each
 * set of values), and the |1 - T| changes needed 150 to 14,000 (analysis/fireball-crash-20261015/verify/twin-validation-F6-0,
 * tuning-content-F4-0). This module gives that number. It never changes the selection or the CLI text of a change.
 *
 * For each candidate measurement of a change, from the pilot's own logs with the flight as the unit:
 *   tracking      the tracking error rms (deg/s) of windows of RULES.windowS (setpoint and gyro after a zero-phase low-pass
 *                 filter of RULES.lowpassHz, mean of the step axes), minus a straight line of the setpoint rms of the window
 *                 (regression over all windows). The value of a flight is the mean residual of its windows. Its change is the
 *                 same window measurement on the model gyro of the test flights with the recorded and with the selected values
 *                 (paired, mean over the test flights, SE over the test flights: deltaSource 'windows'), else the change of the
 *                 frozen test (o.change: deltaSource 'frozen test').
 *   transfer      |1 - T| over a band of the centre frequency plus or minus RULES.halfBandHz (from RULES.activityLowHz), weighted
 *                 with the recorded setpoint spectrum (bandOneMinusT, as verify/tuning-content-F4-0/matched.py), T = S_ry / S_rr
 *                 from Hann windows of RULES.spectrumS (50 % overlap) summed over the windows of a flight. The centre is the
 *                 frequency of RULES.band with the largest calculated change of that band value, on a band with a recorded
 *                 coherence of RULES.minCoherence or more. The change, the flight values, the pooled value and the null use the
 *                 same statistic.
 *   uncommanded   the gyro rms in RULES.uncommandedBand that the setpoint does not explain (S_yy - |S_ry|^2 / S_rr), mean of
 *                 the step axes. Its calculated change is the relative change of the model times the recorded value. The
 *                 setpoint power subtracts the commanded part: this measurement also needs stick input.
 * Each measurement gives the flight-to-flight SD, pooled inside each configuration, with df = flights - configurations degrees
 * of freedom (spread). With fewer than RULES.minFlights - 1 degrees of freedom, the tracking error gets the window SD /
 * sqrt(windows of a flight): a lower bound (lowerBound true), because it does not have the flight-to-flight variance. The
 * spectral measurements then get no SD: the window value of a ratio is not a bound of its flight value. Also: the
 * input-matched null (matchedNull: the value of one flight of the planned window count with no change, from sets of windows
 * with the input power of a usual flight; its mean minus the pooled value is the small-sample bias that made one-flight
 * comparisons misleading), n = 2 (z SD / delta)^2 flights for each set of values (flightsPerArm), its range with the SE of the
 * change and the RULES.sdLevel interval of the SD (flightRange), and the smallest change that RULES.maxFlights flights can show
 * (detectable). plan() takes the measurement with the smallest n of those with a measured SD, else the smallest lower-bound
 * n, the stick activity that it needs for each axis (the median setpoint rms in its band of the flights whose coherence is
 * RULES.minCoherence or more), the periods that the app uses (o.selection) and the STE text. A lower bound never makes a
 * plan that flights can show. Above RULES.maxFlights the text says that flights cannot show the change. The flights with the
 * previous values are flown in the same period: a comparison against a different session or firmware version is not a
 * baseline (verify/tuning-content-F6-0/by_date.txt: PID profile 1 roll 1.37-1.42 against a pool that is 95 % one day, 1.10
 * against the same period; wag_report.cjs flags such a pool).
 *
 * Inputs are plain arrays. A period is { flight, group?, rate, sp: [3 columns], y: [3 columns], from?, n? } (deg/s; group: the
 * configuration). No Node API.
 */

const IMP07 = 'analysis/fireball-crash-20261015/improvements.json IMP-07';
const RULES = Object.freeze({
    alpha: 0.05, power: 0.8,
    z: 2.8,                   // z(1 - alpha / 2) + z(power) = 1.95996 + 0.84162 = 2.8016: two-sided alpha 0.05, power 0.8 (test: within 0.01)
    maxFlights: 10,           // flights with each set of values: with more, flights cannot show the change
    minFlights: 3,            // a flight-to-flight SD needs minFlights - 1 degrees of freedom (flights - configurations)
    sdLevel: 0.95,            // the interval of a flight-to-flight SD (chi-square with its degrees of freedom)
    windowS: 6, lowpassHz: 20,// tracking error windows (s) and the zero-phase low-pass filter of setpoint and gyro (Hz)
    spectrumS: 2,             // Hann windows of the spectra (s), 50 % overlap
    band: Object.freeze([1, 10]),             // Hz: the centre frequencies of |1 - T|, and the stick activity of the tracking error
    uncommandedBand: Object.freeze([0.5, 8]), // Hz: gyro movement that the setpoint does not explain
    halfBandHz: 1,            // the band of |1 - T| and of its stick activity: the centre frequency plus or minus this
    activityLowHz: 0.5,       // Hz: the lowest frequency of the band of |1 - T|
    binTolerance: 0.05,       // a band edge within this part of a bin width is in the band (a log rate of 995.3 Hz puts the bin of 1 Hz at 0.9998 Hz)
    minCoherence: 0.5,        // setpoint to gyro, mean over the band of a measurement: the stick activity that it needs
    nullSets: 2000, nullNeighbours: 20, seed: 2, // input-matched null: sets, nearest windows in log input power, random seed
    minNullSets: 200,         // fewer sets: no null
    source: 'toolkit rule, no flight test: the number of flights of a two-sample comparison with a two-sided alpha of 0.05 and a power of 0.8',
    sources: Object.freeze({
        alpha: `${IMP07}: n = 2 (2.8 SD / delta)^2, alpha 0.05, power 0.8`, power: `${IMP07}: n = 2 (2.8 SD / delta)^2, alpha 0.05, power 0.8`,
        z: `${IMP07}: n = 2 (2.8 SD / delta)^2, alpha 0.05, power 0.8`,
        maxFlights: `${IMP07}: RULES.validation.maxFlights 10`,
        minCoherence: `${IMP07}: coherence of 0.5 or more in the band of the measurement`,
        uncommandedBand: `${IMP07}: uncommanded gyro motion at 0.5-8 Hz`,
        windowS: 'analysis/fireball-crash-20261015/verify/twin-validation-F6-0/stats_w6_lp20_start.txt: 6 s windows',
        lowpassHz: 'analysis/fireball-crash-20261015/verify/twin-validation-F6-0/stats_w6_lp20_start.txt: 20 Hz low-pass',
        spectrumS: 'analysis/fireball-crash-20261015/verify/tuning-content-F4-0/matched.py: 2 s Hann windows, bins of 1-10 Hz',
        band: 'analysis/fireball-crash-20261015/verify/tuning-content-F4-0/matched.py: 2 s Hann windows, bins of 1-10 Hz',
        nullNeighbours: 'analysis/fireball-crash-20261015/verify/tuning-content-F4-0/matched.py: 20 nearest windows in log power',
        seed: 'analysis/fireball-crash-20261015/verify/tuning-content-F4-0/matched.py: seed 2',
        nullSets: 'toolkit rule, no flight test', minNullSets: 'toolkit rule, no flight test', minFlights: 'toolkit rule, no flight test',
        sdLevel: 'toolkit rule, no flight test', halfBandHz: 'toolkit rule, no flight test', activityLowHz: 'toolkit rule, no flight test',
        binTolerance: 'toolkit rule: a log rate of 995.3 Hz puts the bin of 1 Hz at 0.9998 Hz',
    }),
});
const AXES = ['roll', 'pitch', 'yaw'];

const finite = v => typeof v === 'number' && Number.isFinite(v);
const mean = x => x.length ? x.reduce((a, b) => a + b, 0) / x.length : null;
function stats(x) {
    const v = x.filter(finite), n = v.length, m = mean(v);
    return { n, mean: m, sd: n > 1 ? Math.sqrt(v.reduce((s, q) => s + (q - m) ** 2, 0) / (n - 1)) : null };
}
const quantile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))] : null;
function median(x) { const s = x.filter(finite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; }
// the rows of each flight and configuration (group): the unit of the flight-to-flight spread
function byFlight(rows) { const m = new Map(); for (const r of rows) { const k = `${r.flight}|${r.group}`; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; }
// mulberry32: the same sets for the same input
function random(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// ---- chi-square quantiles (the interval of an SD) -------------------------------------------------------------------------

function lnGamma(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, t = x + 5.5, s = 1.000000000190015;
    t -= (x + 0.5) * Math.log(t);
    for (const q of c) s += q / ++y;
    return -t + Math.log(2.5066282746310005 * s / x);
}
// the regularized lower incomplete gamma function P(a, x): series below a + 1, continued fraction above
function gammaP(a, x) {
    if (!(x > 0)) return 0;
    const lead = -x + a * Math.log(x) - lnGamma(a);
    if (x < a + 1) {
        let ap = a, del = 1 / a, sum = del;
        for (let i = 0; i < 1000 && Math.abs(del) > Math.abs(sum) * 1e-15; i++) { ap++; del *= x / ap; sum += del; }
        return Math.min(1, sum * Math.exp(lead));
    }
    let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
    for (let i = 1; i < 1000; i++) {
        const an = -i * (i - a); b += 2;
        d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
        c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
        d = 1 / d; const del = d * c; h *= del;
        if (Math.abs(del - 1) < 1e-15) break;
    }
    return Math.max(0, 1 - Math.exp(lead) * h);
}
// the p quantile of chi-square with df degrees of freedom (bisection)
function chiSquareQuantile(p, df) {
    if (!(df > 0) || !(p > 0 && p < 1)) return NaN;
    let lo = 0, hi = Math.max(1, 2 * df);
    while (gammaP(df / 2, hi / 2) < p) hi *= 2;
    for (let i = 0; i < 200 && hi - lo > 1e-12 * hi; i++) { const m = (lo + hi) / 2; if (gammaP(df / 2, m / 2) < p) lo = m; else hi = m; }
    return (lo + hi) / 2;
}

// n = 2 (z SD / delta)^2 flights for each set of values, rounded up, and a minimum of RULES.minFlights (one flight has no
// spread); null without a positive SD or a change
function flightsPerArm(sd, delta, R = RULES) {
    return finite(sd) && sd > 0 && finite(delta) && delta !== 0 ? Math.max(R.minFlights, Math.ceil(2 * (R.z * sd / Math.abs(delta)) ** 2 - 1e-9)) : null;
}
// the smallest change that n flights with each set of values can show
const detectable = (sd, n, R = RULES) => finite(sd) && sd > 0 && n > 0 ? R.z * sd * Math.sqrt(2 / n) : null;
// The range of n: change, n with |delta| plus and minus its SE (deltaSe); spread, n at the ends of the RULES.sdLevel interval
// of the SD (chi-square with df); low and high, both together. A high of null: no maximum (the change is not larger than its
// SE, or the SD is a lower bound). null without an SE and without degrees of freedom.
function flightRange(m, R = RULES) {
    if (!m || flightsPerArm(m.sd, m.delta, R) === null) return null;
    const d = Math.abs(m.delta), se = finite(m.deltaSe) && m.deltaSe > 0 ? m.deltaSe : null;
    const df = !m.lowerBound && finite(m.df) && m.df > 0 ? m.df : null, q = (1 - R.sdLevel) / 2;
    const sd = df ? [m.sd * Math.sqrt(df / chiSquareQuantile(1 - q, df)), m.sd * Math.sqrt(df / chiSquareQuantile(q, df))] : null;
    if (!se && !sd) return null;
    const small = se ? d - se : d;
    return { change: se ? [flightsPerArm(m.sd, d + se, R), small > 0 ? flightsPerArm(m.sd, small, R) : null] : null,
        spread: sd ? [flightsPerArm(sd[0], d, R), flightsPerArm(sd[1], d, R)] : null, sd, df, level: R.sdLevel,
        low: flightsPerArm(sd ? sd[0] : m.sd, d + (se || 0), R), high: !m.lowerBound && small > 0 ? flightsPerArm(sd ? sd[1] : m.sd, small, R) : null };
}

// ---- signals ------------------------------------------------------------------------------------------------------

// 2nd-order Butterworth low-pass, forward and backward (zero phase)
function lowpass(x, fc, rate) {
    const y = Float64Array.from(x);
    if (!(fc > 0) || !(fc < rate / 2) || y.length < 2) return y;
    const w = Math.tan(Math.PI * fc / rate), w2 = w * w, r = Math.SQRT2 * w, d = 1 + r + w2, b0 = w2 / d, b1 = 2 * b0, a1 = 2 * (w2 - 1) / d, a2 = (1 - r + w2) / d;
    const pass = () => { let x1 = y[0], x2 = y[0], y1 = y[0], y2 = y[0];
        for (let i = 0; i < y.length; i++) { const v = y[i], o = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; } };
    pass(); y.reverse(); pass(); y.reverse();
    return y;
}
const lengthOf = p => finite(p.n) ? p.n : Math.min(...[0, 1, 2].map(a => p.y && p.y[a] ? p.y[a].length : Infinity));

// tracking error windows: { flight, tracking, setpoint } (deg/s rms, mean of the axes)
function trackingWindows(periods, axes, R = RULES) {
    const rows = [];
    for (const p of periods || []) {
        const from = p.from || 0, n = lengthOf(p), L = Math.round(R.windowS * p.rate);
        if (!(L > 1) || !(n - from >= L)) continue;
        const sp = axes.map(a => lowpass(p.sp[a].subarray ? p.sp[a].subarray(from, n) : p.sp[a].slice(from, n), R.lowpassHz, p.rate));
        const y = axes.map(a => lowpass(p.y[a].subarray ? p.y[a].subarray(from, n) : p.y[a].slice(from, n), R.lowpassHz, p.rate));
        for (let s = 0; s + L <= n - from; s += L) {
            let tr = 0, sr = 0;
            for (let j = 0; j < axes.length; j++) {
                let m = 0, e = 0, v = 0;
                for (let k = s; k < s + L; k++) m += sp[j][k];
                m /= L;
                for (let k = s; k < s + L; k++) { e += (sp[j][k] - y[j][k]) ** 2; v += (sp[j][k] - m) ** 2; }
                tr += Math.sqrt(e / L); sr += Math.sqrt(v / L);
            }
            rows.push({ flight: p.flight, group: p.group === undefined ? null : p.group, tracking: tr / axes.length, setpoint: sr / axes.length });
        }
    }
    return rows;
}
// tracking = a + b setpoint over all windows; each row gets its residual
function regression(rows) {
    const mx = mean(rows.map(r => r.setpoint)), my = mean(rows.map(r => r.tracking));
    let sxx = 0, sxy = 0;
    for (const r of rows) { sxx += (r.setpoint - mx) ** 2; sxy += (r.setpoint - mx) * (r.tracking - my); }
    const b = rows.length > 2 && sxx > 0 ? sxy / sxx : 0, a = my - b * mx;
    return { a, b, rows: rows.map(r => Object.assign({}, r, { residual: r.tracking - a - b * r.setpoint })) };
}
// The calculated change of the tracking error with the window measurement: the windows of trackingWindows on the model gyro
// of each test flight with the recorded values (before) and the selected values (after), from the end of the recorded prefix
// (from). The setpoint is the same, so the regression line cancels. -> { mean, se, flights } (deg/s, after - before) or null
function pairedTracking(predicted, axes, R = RULES) {
    const per = new Map();
    for (const p of predicted || []) {
        const run = y => ({ flight: p.flight, rate: p.rate, sp: p.sp, y, from: p.from, n: p.n });
        const b = trackingWindows([run(p.before)], axes, R), a = trackingWindows([run(p.after)], axes, R);
        for (let i = 0; i < Math.min(a.length, b.length); i++) { if (!per.has(p.flight)) per.set(p.flight, []); per.get(p.flight).push(a[i].tracking - b[i].tracking); }
    }
    const st = stats([...per.values()].map(mean));
    return st.n ? { mean: st.mean, se: st.n > 1 ? st.sd / Math.sqrt(st.n) : null, flights: st.n } : null;
}

// Hann window and DFT tables of N samples up to bin K; the spectra are mean squares (one-sided): sum over a band / count
const TABLES = new Map();
function table(N, K) {
    const key = N + ':' + K;
    if (!TABLES.has(key)) {
        const w = new Float64Array(N), c = new Float64Array((K + 1) * N), s = new Float64Array((K + 1) * N);
        let w2 = 0;
        for (let i = 0; i < N; i++) { w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); w2 += w[i] * w[i]; }
        for (let k = 0; k <= K; k++) for (let i = 0; i < N; i++) { const ph = 2 * Math.PI * k * i / N; c[k * N + i] = Math.cos(ph); s[k * N + i] = -Math.sin(ph); }
        TABLES.set(key, { w, c, s, scale: 2 / (N * w2) });
    }
    return TABLES.get(key);
}
// Welch windows of each period: { flight, rate, N, K, axis: { a: { rr, yy, re, im } } } with S_ry = conj(R) Y
function spectralWindows(periods, axes, R = RULES) {
    const out = [], hiHz = Math.max(R.band[1] + R.halfBandHz, R.uncommandedBand[1]);
    for (const p of periods || []) {
        const from = p.from || 0, n = lengthOf(p), N = Math.round(R.spectrumS * p.rate), hop = Math.max(1, N >> 1);
        if (!(N >= 8) || !(n - from >= N)) continue;
        const K = Math.min(N >> 1, Math.ceil(hiHz * N / p.rate)), T = table(N, K), xs = new Float64Array(N), ys = new Float64Array(N);
        for (let s = from; s + N <= n; s += hop) {
            const axis = {};
            for (const a of axes) {
                const x = p.sp[a], y = p.y[a];
                let mx = 0, my = 0;
                for (let i = 0; i < N; i++) { mx += x[s + i]; my += y[s + i]; }
                mx /= N; my /= N;
                for (let i = 0; i < N; i++) { xs[i] = (x[s + i] - mx) * T.w[i]; ys[i] = (y[s + i] - my) * T.w[i]; }
                const q = { rr: new Float64Array(K + 1), yy: new Float64Array(K + 1), re: new Float64Array(K + 1), im: new Float64Array(K + 1) };
                for (let k = 1; k <= K; k++) {
                    let xr = 0, xi = 0, yr = 0, yi = 0;
                    const o = k * N;
                    for (let i = 0; i < N; i++) { const c = T.c[o + i], si = T.s[o + i]; xr += xs[i] * c; xi += xs[i] * si; yr += ys[i] * c; yi += ys[i] * si; }
                    q.rr[k] = (xr * xr + xi * xi) * T.scale; q.yy[k] = (yr * yr + yi * yi) * T.scale;
                    q.re[k] = (xr * yr + xi * yi) * T.scale; q.im[k] = (xr * yi - xi * yr) * T.scale;
                }
                axis[a] = q;
            }
            out.push({ flight: p.flight, group: p.group === undefined ? null : p.group, rate: p.rate, N, K, axis });
        }
    }
    return out;
}
function sumOf(windows, a) {
    const K = Math.min(...windows.map(w => w.K)), S = { rr: new Float64Array(K + 1), yy: new Float64Array(K + 1), re: new Float64Array(K + 1), im: new Float64Array(K + 1), count: 0, K };
    for (const w of windows) { const q = w.axis[a]; if (!q) continue; for (let k = 0; k <= K; k++) { S.rr[k] += q.rr[k]; S.yy[k] += q.yy[k]; S.re[k] += q.re[k]; S.im[k] += q.im[k]; } S.count++; }
    return S;
}
// the bins of a band [lo, hi] Hz of windows of N samples at a rate; an edge within RULES.binTolerance of a bin width is in the band
function binsOf(w, lo, hi, R = RULES) { const t = R.binTolerance, out = []; for (let k = Math.max(1, Math.ceil(lo * w.N / w.rate - t)); k <= Math.min(w.K, Math.floor(hi * w.N / w.rate + t)); k++) out.push(k); return out; }
const oneMinusT = (S, k) => S.rr[k] > 0 ? Math.hypot(S.rr[k] - S.re[k], S.im[k]) / S.rr[k] : NaN;
// |1 - T| over bins, weighted with weights[k] (default: the setpoint spectrum of S): sqrt(sum W |1 - T|^2 / sum W)
function bandOneMinusT(S, bins, weights) {
    let num = 0, den = 0;
    for (const k of bins) { const v = oneMinusT(S, k), w = weights ? weights[k] : S.rr[k]; if (finite(v) && w > 0) { num += w * v * v; den += w; } }
    return den > 0 ? Math.sqrt(num / den) : NaN;
}
function coherence(S, bins) { const c = bins.filter(k => S.rr[k] > 0 && S.yy[k] > 0).map(k => (S.re[k] ** 2 + S.im[k] ** 2) / (S.rr[k] * S.yy[k])); return c.length ? mean(c) : NaN; }
function uncommanded(S, bins) { let ms = 0; for (const k of bins) if (S.rr[k] > 0) ms += Math.max(0, S.yy[k] - (S.re[k] ** 2 + S.im[k] ** 2) / S.rr[k]); return S.count ? Math.sqrt(ms / S.count) : NaN; }
const setpointRms = (S, bins) => S.count ? Math.sqrt(bins.reduce((s, k) => s + S.rr[k], 0) / S.count) : NaN;
const bandPower = (w, axes, bins) => mean(axes.map(a => bins.reduce((s, k) => s + (w.axis[a] ? w.axis[a].rr[k] : 0), 0)));

// The input-matched null: sets with one window for each target input power, no window twice in a set. Each set takes the
// targets in a random order, and each target takes a random window of its RULES.nullNeighbours nearest windows in log power
// that the set does not use yet (if all of them are used: of the next nearest unused windows). The pool must have 2 windows
// for each target and windows of RULES.minFlights flights or more. value(set) -> number.
// -> { windows, sets, flights, mean, sd, low, high } (low, high: 2.5 % and 97.5 %), or null (also below RULES.minNullSets sets)
function matchedNull(pool, targets, value, R = RULES, rng = random(R.seed)) {
    const T = targets ? targets.length : 0, P = pool ? pool.length : 0, flights = P ? new Set(pool.map(w => w.flight)).size : 0;
    if (!T || P < 2 * T || flights < R.minFlights) return null;
    const lp = pool.map(w => Math.log(Math.max(0, w.power) + 1e-9)), order = pool.map((w, i) => i).sort((i, j) => lp[i] - lp[j]);
    const K = Math.max(1, Math.min(R.nullNeighbours, P));
    // each target: all windows, nearest first
    const near = targets.map(t => {
        const x = Math.log(Math.max(0, t) + 1e-9), out = new Int32Array(P);
        let lo = 0, hi = P;
        while (lo < hi) { const m = (lo + hi) >> 1; if (lp[order[m]] < x) lo = m + 1; else hi = m; }
        let i = lo - 1, j = lo;
        for (let k = 0; k < P; k++) out[k] = j < P && (i < 0 || Math.abs(lp[order[j]] - x) <= Math.abs(lp[order[i]] - x)) ? order[j++] : order[i--];
        return out;
    });
    const usedIn = new Int32Array(P).fill(-1), sequence = Array.from({ length: T }, (_, i) => i), pick = new Array(T), free = [], vals = [];
    for (let s = 0; s < R.nullSets; s++) {
        for (let i = T - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)), t = sequence[i]; sequence[i] = sequence[j]; sequence[j] = t; }
        for (const t of sequence) {
            const c = near[t]; free.length = 0;
            for (let k = 0; k < K; k++) if (usedIn[c[k]] !== s) free.push(c[k]);
            for (let k = K; !free.length && k < P; k += K) for (let q = k; q < Math.min(P, k + K); q++) if (usedIn[c[q]] !== s) free.push(c[q]);
            const w = free[Math.floor(rng() * free.length)];
            usedIn[w] = s; pick[t] = pool[w];
        }
        const v = value(pick.slice());
        if (finite(v)) vals.push(v);
    }
    if (vals.length < Math.max(2, R.minNullSets)) return null;
    const st = stats(vals), sorted = vals.slice().sort((a, b) => a - b);
    return { windows: T, sets: vals.length, flights, mean: st.mean, sd: st.sd, low: quantile(sorted, 0.025), high: quantile(sorted, 0.975) };
}
// the targets of a usual flight: k input powers at the quantiles (i + 0.5) / k of the pool
function usualTargets(pool, k) { const p = pool.map(w => w.power).filter(finite).sort((a, b) => a - b); return p.length ? Array.from({ length: k }, (_, i) => quantile(p, (i + 0.5) / k)) : []; }

// The flight-to-flight SD, the flight as the unit: flightValues [{ value, group }] (or numbers: one group). The SD is pooled
// inside each configuration (group), so that a gain difference between configurations does not count as spread; df = flights
// - configurations. With fewer than RULES.minFlights - 1 degrees of freedom: the window SD / sqrt(windows of a flight), a lower
// bound (lowerBound true), or no SD without window values (the spectral measurements).
function spread(flightValues, windowValues, perFlight, R = RULES) {
    const rows = flightValues.map(v => typeof v === 'number' ? { value: v, group: null } : v).filter(v => v && finite(v.value)), g = new Map();
    for (const r of rows) { if (!g.has(r.group)) g.set(r.group, []); g.get(r.group).push(r.value); }
    let ss = 0; for (const l of g.values()) { const m = mean(l); for (const v of l) ss += (v - m) ** 2; }
    const df = rows.length - g.size, base = { flights: rows.length, configurations: g.size, df };
    if (df >= R.minFlights - 1 && df > 0) return Object.assign({ sd: Math.sqrt(ss / df), lowerBound: false }, base);
    const w = stats(windowValues || []), sd = finite(w.sd) && w.sd > 0 && perFlight > 0 ? w.sd / Math.sqrt(perFlight) : null;
    return Object.assign({ sd, lowerBound: sd !== null }, base);
}
// the stick activity of one axis in a band: the median setpoint rms in the band of the flights with a coherence of minCoherence or more
function activity(groups, a, bins, lo, hi, R = RULES) {
    const rows = groups.map(ws => { const S = sumOf(ws, a); return { coherence: coherence(S, bins), setpoint: setpointRms(S, bins) }; }).filter(r => finite(r.coherence));
    const ok = rows.filter(r => r.coherence >= R.minCoherence);
    return { axis: AXES[a], band: [lo, hi], minCoherence: R.minCoherence, flights: rows.length, coherent: ok.length, setpointRms: ok.length ? median(ok.map(r => r.setpoint)) : null };
}

// ---- the measurements of a model change -------------------------------------------------------------------------------

// o: { recorded: periods of the PID profile (group: the configuration of each period), predicted: [{ flight, rate, sp, before, after, from }] (the gyro of the
// model with the recorded and the selected values), axes: the step axes, change: { mean, se } the calculated decrease of the
// tracking error (deg/s, the fallback of the tracking change), selection: { periodsPerFlight, periodS } the periods of each
// flight that the app uses (system_id.prepareSegments) } -> the plan
function forModel(o, R = RULES) {
    const axes = (o.axes || [0, 1, 2]).slice(), metrics = [], recorded = o.recorded || [], predicted = o.predicted || [];
    const axisNames = axes.map(a => AXES[a]);
    const rec = spectralWindows(recorded, axes, R), groups = [...byFlight(rec).values()];
    // tracking error: the change of the window measurement on the test flights, else the change of the frozen test
    const reg = regression(trackingWindows(recorded, axes, R)), flights = byFlight(reg.rows), paired = predicted.length ? pairedTracking(predicted, axes, R) : null;
    const change = paired && finite(paired.mean) ? { delta: paired.mean, deltaSe: paired.se, deltaSource: 'windows', deltaFlights: paired.flights }
        : o.change && finite(o.change.mean) ? { delta: -o.change.mean, deltaSe: finite(o.change.se) ? o.change.se : null, deltaSource: 'frozen test' } : null;
    if (reg.rows.length > 2 && change) {
        const perFlight = Math.max(1, Math.round(median([...flights.values()].map(l => l.length))));
        const sp = spread([...flights.values()].map(l => ({ value: mean(l.map(r => r.residual)), group: l[0].group })), reg.rows.map(r => r.residual), perFlight, R);
        const pool = reg.rows.map(r => Object.assign({ power: r.setpoint ** 2 }, r));
        metrics.push(Object.assign({ id: 'tracking', axes: axisNames, unit: 'deg/s', windowS: R.windowS, windowsPerFlight: perFlight, pooled: null, fit: { a: reg.a, b: reg.b },
            null: matchedNull(pool, usualTargets(pool, perFlight), set => mean(set.map(r => r.residual)), R) }, change, sp));
    }
    // the spectral measurements
    const perFlight = groups.length ? Math.max(1, Math.round(median(groups.map(g => g.length)))) : 0;
    if (rec.length && perFlight) {
        const w0 = rec[0], band = binsOf(w0, R.band[0], R.band[1], R), ub = binsOf(w0, R.uncommandedBand[0], R.uncommandedBand[1], R), hzOf = k => k * w0.rate / w0.N;
        const sim = key => spectralWindows(predicted.map(p => ({ flight: p.flight, rate: p.rate, sp: p.sp, y: p[key], from: p.from, n: p.n })), axes, R);
        const before = predicted.length ? sim('before') : [], after = predicted.length ? sim('after') : [];
        if (before.length && after.length) {
            // |1 - T| over the band of each centre frequency, weighted with the recorded setpoint spectrum: the centre with the
            // largest calculated change, on a band with a recorded coherence of minCoherence or more
            let best = null;
            for (const a of axes) {
                const Sr = sumOf(rec, a), Sb = sumOf(before, a), Sa = sumOf(after, a), W = Float64Array.from(Sr.rr, v => Sr.count ? v / Sr.count : 0);
                for (const k of band) {
                    const lo = Math.max(R.activityLowHz, hzOf(k) - R.halfBandHz), hi = hzOf(k) + R.halfBandHz, bins = binsOf(w0, lo, hi, R);
                    const c = coherence(Sr, bins), b0 = bandOneMinusT(Sb, bins, W), d = bandOneMinusT(Sa, bins, W) - b0;
                    if (finite(c) && c >= R.minCoherence && finite(d) && (!best || Math.abs(d) > Math.abs(best.d))) best = { a, k, d, before: b0, lo, hi, bins, W };
                }
            }
            if (best) {
                // in % of the setpoint: |1 - T| x 100
                const stat = ws => 100 * bandOneMinusT(sumOf(ws, best.a), best.bins, best.W);
                const values = groups.map(g => ({ value: stat(g), group: g[0].group })), pool = rec.map(w => Object.assign({ power: bandPower(w, [best.a], best.bins) }, w));
                metrics.push(Object.assign({ id: 'transfer', axes: [AXES[best.a]], unit: '%', hz: hzOf(best.k), band: [best.lo, best.hi], statistic: 'bandOneMinusT',
                    delta: 100 * best.d, deltaSe: null, modelBefore: 100 * best.before, windowS: R.spectrumS, windowsPerFlight: perFlight, pooled: stat(rec),
                    activity: [activity(groups, best.a, best.bins, best.lo, best.hi, R)], null: matchedNull(pool, usualTargets(pool, perFlight), stat, R) }, spread(values, [], perFlight, R)));
            }
            // uncommanded gyro movement: the relative change of the model times the recorded value
            const U = ws => mean(axes.map(a => uncommanded(sumOf(ws, a), ub))), ub0 = U(before), ub1 = U(after);
            const values = groups.map(g => ({ value: U(g), group: g[0].group })), level = mean(values.map(v => v.value).filter(finite));
            if (finite(ub0) && ub0 > 0 && finite(ub1) && finite(level)) {
                const pool = rec.map(w => Object.assign({ power: bandPower(w, axes, ub) }, w));
                metrics.push(Object.assign({ id: 'uncommanded', axes: axisNames, unit: 'deg/s', band: R.uncommandedBand.slice(), delta: level * (ub1 / ub0 - 1), deltaSe: null, relative: ub1 / ub0 - 1,
                    windowS: R.spectrumS, windowsPerFlight: perFlight, pooled: U(rec), activity: axes.map(a => activity(groups, a, ub, R.uncommandedBand[0], R.uncommandedBand[1], R)),
                    null: matchedNull(pool, usualTargets(pool, perFlight), U, R) }, spread(values, [], perFlight, R)));
            }
        }
        // the stick activity of the tracking error: its band, on each step axis
        const t = metrics.find(m => m.id === 'tracking');
        if (t) t.activity = axes.map(a => activity(groups, a, band, R.band[0], R.band[1], R));
    }
    return plan(metrics, R, { selection: o.selection || null });
}
// A gain-model decision of report.cjs (advice.cjs C7): its tracking change in the band of the gain model, and the
// flight-to-flight SD of the measured tracking error (its standard error over flights times the square root of the flights,
// flights - 1 degrees of freedom). This is not the 6 s window measurement of forModel: its id is 'decision'.
function forDecision(d, R = RULES) {
    const m = d && d.measured || {}, n = d && finite(d.flights) ? d.flights : null;
    const sd = finite(m.trackRmsSE) && n > 0 ? m.trackRmsSE * Math.sqrt(n) : null;
    return plan(d && finite(d.dTrack) ? [{ id: 'decision', axes: d.axis ? [d.axis] : [], unit: 'deg/s', delta: -d.dTrack, deltaSe: finite(d.seTrack) ? d.seTrack : null,
        sd, flights: n, df: n !== null ? n - 1 : null, lowerBound: false }] : [], R);
}

// ---- the plan and its STE text -------------------------------------------------------------------------------------------

const digits = v => { const a = Math.abs(v); return a >= 10 ? 1 : a >= 1 ? 2 : a >= 0.1 ? 3 : 4; };
// a value to 3 or 4 significant digits, or to the digits of ref (a value ± its SD)
const fmt = (v, unit, ref) => finite(v) ? `${+v.toFixed(finite(ref) && ref > 0 ? digits(ref) : digits(v))}${unit ? ' ' + unit : ''}` : 'unknown';
const and = l => l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
const count = (n, word) => `${n} ${n === 1 ? word : word + 's'}`;
function label(m) {
    const at = Array.isArray(m.band) ? `at ${fmt(m.band[0])} Hz to ${fmt(m.band[1])} Hz` : `at ${fmt(m.hz)} Hz`, axes = m.axes && m.axes.length ? and(m.axes) + ' ' : '';
    if (m.id === 'transfer') return `the ${m.axes[0]} tracking error ${at}, as a percentage of the setpoint`;
    if (m.id === 'uncommanded') return `the ${axes}gyro movement that the stick inputs do not cause, ${at}`;
    if (m.id === 'decision') return `the ${axes}tracking error in the band of the gain model`;
    return `the ${axes}tracking error`;
}
// "Your logs have N flights with this PID profile in M configurations."
const flightsOf = m => !finite(m.flights) ? '' : finite(m.configurations) ?
    `Your logs have ${count(m.flights, 'flight')} with this PID profile in ${count(m.configurations, 'configuration')}.` : `Your logs have ${count(m.flights, 'flight')} for this measurement.`;
const needSd = R => `For a flight-to-flight standard deviation, the number of flights must be a minimum of ${R.minFlights - 1} more than the number of configurations.`;
// the stick activity of each axis of the measurement
function activityText(m) {
    const list = [].concat(m.activity || []).filter(a => a && a.flights), t = [], have = [], none = [];
    list.forEach((a, i) => {
        const axis = a.axis || (m.axes && m.axes.length === list.length ? m.axes[i] : null), name = axis ? axis + ' ' : '', band = `${fmt(a.band[0])} Hz to ${fmt(a.band[1])} Hz`;
        if (a.coherent && finite(a.setpointRms)) { t.push(`Your flights with a ${name}coherence of ${a.minCoherence} or more at ${band} have a median ${name}setpoint of ${fmt(a.setpointRms, 'deg/s')} rms.`); have.push(axis); }
        else { t.push(`No flight of your logs has a ${name}coherence of ${a.minCoherence} or more at ${band}.`); none.push(axis); }
    });
    const names = l => l.filter(Boolean).length ? and(l.filter(Boolean)) + ' ' : '';
    if (have.length) t.push(`In each flight, make ${names(have)}stick inputs of ${have.length > 1 ? 'these amplitudes' : 'this amplitude'} or larger.`);
    if (none.length) t.push(`In each flight, make larger ${names(none)}stick inputs than in these logs.`);
    return t;
}
// the range of the number of flights (flightRange)
function rangeText(m, R) {
    const r = m.range, t = [];
    if (!r) return t;
    if (r.change) t.push(r.change[1] === null ? `The change is not larger than its standard error of ${fmt(m.deltaSe, m.unit)}. Thus, the app cannot calculate a maximum number of flights.` :
        `With the standard error of the change (${fmt(m.deltaSe, m.unit)}), the number of flights is from ${r.change[0]} to ${r.change[1]}.`);
    if (r.spread) t.push(`With the ${r.level * 100} % interval of the standard deviation (${fmt(r.sd[0], '', r.sd[0])} to ${fmt(r.sd[1], m.unit, r.sd[0])}), the number of flights is from ${r.spread[0]} to ${r.spread[1]}.`);
    return t;
}
// metrics: [{ id, axes, unit, delta, deltaSe?, sd, df?, flights, configurations?, lowerBound, hz?, band?, activity?, null?, pooled? }],
// o: { selection } -> { available, confirmable, lowerBound, flightsPerArm, flightsRange: { low, high }, chosen (an index), metrics (with
// label, n, detectable and range), text: [paragraphs, STE], rule (STE), rules, selection }
function plan(metrics, R = RULES, o = {}) {
    const list = (metrics || []).map(m => { const x = Object.assign({}, m, { label: label(m), n: flightsPerArm(m.sd, m.delta, R), detectable: detectable(m.sd, R.maxFlights, R) });
        x.range = flightRange(x, R); return x; });
    // a measured SD before a lower bound, then the smallest n
    const ok = list.map((m, i) => [m, i]).filter(([m]) => m.n !== null).sort((x, y) => (x[0].lowerBound ? 1 : 0) - (y[0].lowerBound ? 1 : 0) || x[0].n - y[0].n);
    const rule = `The number of flights for each set of values is 2 × (${R.z} × standard deviation / change)². With no change, the test gives an incorrect result in ${R.alpha * 100} % of tests. ` +
        `With the change, the test finds it in ${R.power * 100} % of tests.`;
    const out = { available: !!ok.length, confirmable: false, lowerBound: false, flightsPerArm: null, flightsRange: null, chosen: null, metrics: list, rule,
        rules: { z: R.z, alpha: R.alpha, power: R.power, maxFlights: R.maxFlights, minFlights: R.minFlights, sdLevel: R.sdLevel }, selection: o && o.selection || null, text: [] };
    if (!ok.length) {
        const few = list.find(m => !finite(m.sd) && finite(m.flights) && (finite(m.df) ? m.df : m.flights - 1) < R.minFlights - 1);
        out.text.push('The app cannot calculate the number of flights that can show this change.' +
            (few ? ` ${flightsOf(few)} ${needSd(R)}` : list.length ? ' The app cannot find the flight-to-flight standard deviation or the change.' : ' The app did not calculate a change of a measurement.'));
        return out;
    }
    const [m, i] = ok[0], low = !!m.lowerBound, change = `The app calculates a change of ${fmt(m.delta, m.unit)}`;
    Object.assign(out, { confirmable: !low && m.n <= R.maxFlights, lowerBound: low, flightsPerArm: m.n, flightsRange: m.range ? { low: m.range.low, high: m.range.high } : null, chosen: i });
    // the flights to fly: the periods that the app uses and the stick activity
    const fly = () => {
        const s = out.selection, t = [];
        if (s && finite(s.periodsPerFlight) && finite(s.periodS)) t.push(`The app uses the ${count(s.periodsPerFlight, 'period')} of ${fmt(s.periodS)} s with the most stick input in each flight.`);
        t.push(...activityText(m));
        return t.length ? [t.join(' ')] : [];
    };
    if (low) {
        out.text.push(`The app cannot calculate the flight-to-flight standard deviation. The measurement is ${m.label}. ${flightsOf(m)} ` +
            `The windows of your ${m.flights === 1 ? 'flight' : 'flights'} give a minimum standard deviation of ${fmt(m.sd, m.unit)}.`);
        out.text.push(`${m.n > R.maxFlights ? 'Flights cannot show this change. ' : ''}${change}. With the minimum standard deviation, a minimum of ${m.n} flights with each set of values is necessary. ` +
            (m.n > R.maxFlights ? `The limit is ${R.maxFlights} flights.` : 'More flights can be necessary.'));
        out.text.push(needSd(R));
        if (m.n <= R.maxFlights) out.text.push(...fly());
    } else {
        const sdText = `The flight-to-flight standard deviation is ${fmt(m.sd, m.unit)} in ${count(m.flights, 'flight')} of your logs.`, range = rangeText(m, R);
        if (out.confirmable) {
            out.text.push(`Flights can show this change in ${m.label}. ${change}. ${sdText}`);
            out.text.push(`Fly ${count(m.n, 'flight')} with the previous values and ${count(m.n, 'flight')} with the new values. Fly all of these flights in the same period. ` +
                'Do not compare them with flights of a different period or a different firmware.');
            if (m.range && (m.range.high === null || m.range.high > R.maxFlights)) range.push(`Thus, more than ${R.maxFlights} flights with each set of values can be necessary.`);
            if (range.length) out.text.push(range.join(' '));
            out.text.push(...fly());
        } else {
            out.text.push(`Flights cannot show this change in ${m.label}. ${change}. ${sdText}`);
            out.text.push(`Thus, ${m.n} flights with each set of values are necessary. The limit is ${R.maxFlights} flights. With ${R.maxFlights} flights with each set of values, flights can show a change of ${fmt(m.detectable, m.unit)} or more.`);
            if (m.range && finite(m.range.low) && m.range.low <= R.maxFlights) range.push(`Thus, a maximum of ${R.maxFlights} flights with each set of values can be sufficient.`);
            if (range.length) out.text.push(range.join(' '));
        }
    }
    if (m.null && finite(m.null.mean) && finite(m.null.sd) && m.null.sd > 0 && finite(m.pooled)) out.text.push(`With no change, one flight with ${count(m.null.windows, 'window')} of ${m.windowS} s gives ${fmt(m.null.mean, '', m.null.sd)} ± ${fmt(m.null.sd, m.unit)}. ` +
        `All flights together give ${fmt(m.pooled, m.unit)}. Thus, compare sets of flights, not one flight.`);
    return out;
}

module.exports = { RULES, flightsPerArm, detectable, flightRange, chiSquareQuantile, lowpass, trackingWindows, regression, pairedTracking, spectralWindows, sumOf, binsOf, oneMinusT, bandOneMinusT,
    coherence, uncommanded, setpointRms, matchedNull, usualTargets, spread, activity, forModel, forDecision, plan, label };
if (require.main !== module) return;
