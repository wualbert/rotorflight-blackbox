'use strict';

// Identification and prediction checks of the six-degree-of-freedom twin (heli_twin.cjs).
//
// A run is one continuous airborne period at one sample rate:
//   { id, flight, rate, n, u: [roll, pitch, yaw] (mixer/1000), coll (mixer[3]/1000), thr (0..1), vbat (V),
//     gyro: [3] deg/s, att: [3] decidegrees, alt m, vario m/s, hs RPM, target: { gyro: [3] } }
// target.gyro is the gyro after a zero-phase low-pass filter. It is used only to score predictions.
//
// The observer runs through each run with the measurements. At each origin the observer state is copied and
// the model runs free for the horizon with the recorded inputs only. No measurement after the origin enters a
// prediction. The fit minimizes these prediction errors (prediction-error method with multiple shooting).

const T = require('./heli_twin.cjs');

const RULES = Object.freeze({
    fitRate: 500, warmupS: 2, originEveryS: 0.5, horizonS: 1,
    points: [0.01, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1],
    scoreLowpassHz: 20,
    // error scale of each output channel (deg/s, deg, deg, deg, deg, deg, m, m/s, RPM)
    scale: [20, 20, 20, 4, 4, 8, 1, 0.5, 80],
    minRunS: 4, robust: 3,
    // the observer disturbances should stay small: a model that needs a large moment or force disturbance to hold
    // trim has a wrong trim (it then fails in closed loop when the flight condition changes)
    disturbanceScale: [3, 3, 3, 1],
});
const CHANNELS = T.OUTPUTS;

// Second-order Butterworth low-pass, forward and backward (zero phase).
function lowpass(x, fc, rate) {
    const k = Math.tan(Math.PI * fc / rate), q = Math.SQRT2, norm = 1 / (1 + k * q + k * k);
    const b0 = k * k * norm, b1 = 2 * b0, a1 = 2 * (k * k - 1) * norm, a2 = (1 - k * q + k * k) * norm;
    const pass = (src, dst, reverse) => {
        const n = src.length; let x1 = src[reverse ? n - 1 : 0], x2 = x1, y1 = x1, y2 = x1;
        for (let j = 0; j < n; j++) {
            const i = reverse ? n - 1 - j : j, v = src[i], y = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
            x2 = x1; x1 = v; y2 = y1; y1 = y; dst[i] = y;
        }
    };
    const a = new Float64Array(x.length), b = new Float64Array(x.length);
    pass(x, a, false); pass(a, b, true); return b;
}

// Resample a run to a lower rate by averaging (inputs and gyro) or picking (attitude, barometer, RPM).
function decimate(run, factor) {
    if (factor === 1) return run;
    const n = Math.floor(run.n / factor), avg = x => { const o = new Float64Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < factor; k++) s += x[i * factor + k]; o[i] = s / factor; } return o; };
    // a measurement at sample i * factor starts the interval whose inputs are averaged into input i
    const pick = x => { const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = x[i * factor]; return o; };
    return Object.assign({}, run, { rate: run.rate / factor, n, u: run.u.map(avg), coll: avg(run.coll), thr: avg(run.thr), vbat: avg(run.vbat),
        gyro: run.gyro.map(pick), att: run.att.map(pick), alt: pick(run.alt), vario: pick(run.vario), hs: pick(run.hs),
        target: { gyro: run.target.gyro.map(pick) }, sp: run.sp ? run.sp.map(avg) : undefined, decimation: factor, fromIndex: run.fromIndex });
}

function prepareRun(run, rules = RULES) {
    const r = Object.assign({}, run, { target: { gyro: run.gyro.map(g => lowpass(g, rules.scoreLowpassHz, run.rate)) } });
    // A battery voltage the log does not record (missing, or zero as some ESC setups log it) becomes a constant 1:
    // the motor torque gain then is per throttle unit instead of per volt.
    const v = Array.from(run.vbat || []).filter(Number.isFinite).sort((a, b) => a - b);
    if (!(v.length && v[v.length >> 1] > 1)) { r.vbat = new Float64Array(run.n).fill(1); r.vbatRecorded = false; } else r.vbatRecorded = true;
    const factor = Math.max(1, Math.round(run.rate / rules.fitRate));
    return decimate(r, factor);
}

function measurement(run, i, m) {
    m.thr = run.thr[i];
    m.gyro[0] = run.gyro[0][i]; m.gyro[1] = run.gyro[1][i]; m.gyro[2] = run.gyro[2][i];
    m.att[0] = run.att[0][i]; m.att[1] = run.att[1][i]; m.att[2] = run.att[2][i];
    m.alt = run.alt[i]; m.vario = run.vario[i]; m.hs = run.hs[i];
    return m;
}
function inputAt(run, i, u) {
    u.u[0] = run.u[0][i]; u.u[1] = run.u[1][i]; u.u[2] = run.u[2][i]; u.coll = run.coll[i]; u.thr = run.thr[i]; u.vbat = run.vbat[i];
    return u;
}
function targetAt(run, i, out) {
    out[0] = run.target.gyro[0][i]; out[1] = run.target.gyro[1][i]; out[2] = run.target.gyro[2][i];
    out[3] = run.att[0][i] / 10; out[4] = run.att[1][i] / 10; out[5] = run.att[2][i] / 10;
    out[6] = run.alt[i]; out[7] = run.vario[i]; out[8] = run.hs[i];
    return out;
}
const wrap = d => d - 360 * Math.round(d / 360);

// Observer pass through one run. visit(i, sim) at each origin i (the state at sample i, before input i).
function observerPass(model, run, rules, visit) {
    const sim = T.createSim(model, run.rate), m = { gyro: [0, 0, 0], att: [0, 0, 0] }, u = { u: [0, 0, 0] };
    T.initState(sim, measurement(run, 0, m));
    for (let k = 0; k < sim.maxDelay; k++) T.push(sim, inputAt(run, 0, u));
    sim.count = 0;
    const warm = Math.round(rules.warmupS * run.rate), every = Math.max(1, Math.round(rules.originEveryS * run.rate));
    const horizon = Math.round(rules.horizonS * run.rate);
    for (let i = 0; i < run.n - 1; i++) {
        if (visit && i >= warm && (i - warm) % every === 0 && i + horizon < run.n) visit(i, sim);
        T.push(sim, inputAt(run, i, u)); T.step(sim); T.observe(sim, measurement(run, i + 1, m));
    }
    return sim;
}

// Free prediction from the observer state at origin i. Returns outputs at the requested sample offsets.
function rollout(sim, run, i, offsets, scratch) {
    const c = T.clone(sim, scratch && scratch.sim), u = scratch ? scratch.u : { u: [0, 0, 0] }, out = [];
    const last = offsets[offsets.length - 1];
    let next = 0;
    for (let j = 0; j < last; j++) {
        T.push(c, inputAt(run, i + j, u)); T.step(c);
        if (j + 1 === offsets[next]) { out.push(T.outputs(c.x)); next++; }
    }
    if (scratch) scratch.sim = c;
    return out;
}

// Prediction errors of all origins. With residuals, returns the scaled residual vector for the fit.
function predictionErrors(model, runs, options = {}) {
    const rules = Object.assign({}, RULES, options.rules), weights = options.weights || rules.scale.map(() => 1);
    const res = [], nc = CHANNELS.length, np = rules.points.length;
    const sum = Array.from({ length: nc }, () => new Float64Array(np)), base = Array.from({ length: nc }, () => new Float64Array(np));
    let origins = 0; const target = new Float64Array(nc), count = Array.from({ length: nc }, () => new Float64Array(np));
    const traces = options.traces ? [] : null;
    for (const run of runs) {
        const offsets = rules.points.map(t => Math.max(1, Math.round(t * run.rate))), scratch = { u: { u: [0, 0, 0] }, sim: null };
        try {
            observerPass(model, run, rules, (i, sim) => {
                const pred = rollout(sim, run, i, offsets, scratch), start = T.outputs(sim.x);
                if (options.residuals && options.disturbanceWeight) [21, 22, 23, 26].forEach((k, j) => res.push(options.disturbanceWeight * sim.x[k] / rules.disturbanceScale[j]));
                // persistence: the observer outputs at the origin
                origins++;
                for (let k = 0; k < np; k++) {
                    targetAt(run, i + offsets[k], target);
                    for (let ch = 0; ch < nc; ch++) {
                        // a channel the log does not record gives no error (and a zero residual, so the vector keeps its length)
                        if (!Number.isFinite(target[ch])) { if (options.residuals) res.push(0); continue; }
                        let e = pred[k][ch] - target[ch], b = start[ch] - target[ch];
                        count[ch][k]++;
                        if (ch === 3 || ch === 5) { e = wrap(e); b = wrap(b); }
                        sum[ch][k] += e * e; base[ch][k] += b * b;
                        if (options.residuals) { const r = weights[ch] * e / rules.scale[ch], c = rules.robust;
                            // pseudo-Huber: quadratic below c scale units, linear above (one diverging origin cannot dominate)
                            res.push(c ? Math.sign(r) * Math.sqrt(2 * c * c * (Math.sqrt(1 + (r / c) ** 2) - 1)) : r); }
                    }
                }
            });
        } catch (error) {
            if (!options.residuals) throw error;
            return { failed: true, reason: error.message };
        }
        if (traces) traces.push(trace(model, run, rules, options.traces));
    }
    const rms = (a, n) => Array.from(a, (v, k) => n[k] ? Math.sqrt(v / n[k]) : null);
    const out = { origins, points: rules.points, channels: CHANNELS, units: ['deg/s', 'deg/s', 'deg/s', 'deg', 'deg', 'deg', 'm', 'm/s', 'RPM'],
        rmse: sum.map((a, ch) => rms(a, count[ch])), persistence: base.map((a, ch) => rms(a, count[ch])), samples: count.map(c => Array.from(c)) };
    if (options.residuals) out.residuals = Float64Array.from(res);
    if (traces) out.traces = traces;
    return out;
}

// Consecutive predictions over a run: each horizon-long segment starts from the observer state at its start.
// Gives a continuous trace to plot against the measurements.
function trace(model, run, rules, opts = {}) {
    const horizon = Math.max(1, Math.round((opts.horizonS || 1) * run.rate)), stride = Math.max(1, Math.round((opts.decimateTo ? run.rate / opts.decimateTo : 1)));
    const n = run.n, pred = CHANNELS.map(() => new Float64Array(n).fill(NaN)), segStart = [];
    const sim = T.createSim(model, run.rate), m = { gyro: [0, 0, 0], att: [0, 0, 0] }, u = { u: [0, 0, 0] };
    T.initState(sim, measurement(run, 0, m));
    for (let k = 0; k < sim.maxDelay; k++) T.push(sim, inputAt(run, 0, u));
    const warm = Math.round(rules.warmupS * run.rate);
    for (let i = 0; i < n - 1; i++) {
        if (i >= warm && (i - warm) % horizon === 0) {
            segStart.push(i);
            const c = T.clone(sim), uu = { u: [0, 0, 0] };
            for (let j = 0; j < horizon && i + j < n - 1; j++) {
                T.push(c, inputAt(run, i + j, uu)); T.step(c);
                const o = T.outputs(c.x); for (let ch = 0; ch < CHANNELS.length; ch++) pred[ch][i + j + 1] = o[ch];
            }
        }
        T.push(sim, inputAt(run, i, u)); T.step(sim); T.observe(sim, measurement(run, i + 1, m));
    }
    const measured = CHANNELS.map((_, ch) => { const o = new Float64Array(n), t = new Float64Array(CHANNELS.length); for (let i = 0; i < n; i++) o[i] = targetAt(run, i, t)[ch]; return o; });
    const pick = a => { const o = []; for (let i = 0; i < n; i += stride) o.push(Number.isFinite(a[i]) ? +a[i].toFixed(3) : null); return o; };
    return { id: run.id, flight: run.flight, rate: run.rate / stride, horizonS: horizon / run.rate, segmentStarts: segStart.map(i => i / run.rate),
        measured: measured.map(pick), predicted: pred.map(pick), raw: { gyro: run.gyro.map(pick) }, inputs: { u: run.u.map(pick), coll: pick(run.coll), thr: pick(run.thr) } };
}

// ---- frequency responses with the pilot setpoint as instrument ----
// With feedback, the actuator command correlates with disturbances, and a plain fit lowers the control power.
// The pilot setpoint does not depend on the disturbances, so H = S(sp, rate) / S(sp, u) is the plant response
// u -> rate without that bias (indirect closed-loop identification, as in CIFER).
function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
        const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
        for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) { const ur = re[i + k], ui = im[i + k], j = i + k + len / 2, vr = re[j] * cr - im[j] * ci, vi = re[j] * ci + im[j] * cr;
                re[i + k] = ur + vr; im[i + k] = ui + vi; re[j] = ur - vr; im[j] = ui - vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
    }
}
const FRF = Object.freeze({ segmentS: 4, fMin: 0.5, fMax: 15, bins: 18, minCoherence: 0.3 });
// runs: runs with sp (setpoint deg/s), u and gyro. Returns the 3 x 3 response matrix per log-spaced bin:
// H = S_yx S_ux^-1 (rows: rate axis, columns: actuator axis), with the setpoints of all three axes as instruments.
// Coherence: of each setpoint with its own actuator (cohU) and its own rate (cohY).
const cx = { mul: (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]], sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
    div: (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; } };
function cinv3(m) { // complex 3 x 3 inverse by Gauss-Jordan
    const a = m.map((r, i) => r.map(v => v.slice()).concat([0, 1, 2].map(j => [i === j ? 1 : 0, 0])));
    for (let c = 0; c < 3; c++) {
        let p = c; for (let r = c + 1; r < 3; r++) if (Math.hypot(...a[r][c]) > Math.hypot(...a[p][c])) p = r;
        [a[c], a[p]] = [a[p], a[c]]; const piv = a[c][c]; if (!(Math.hypot(...piv) > 0)) return null;
        for (let j = 0; j < 6; j++) a[c][j] = cx.div(a[c][j], piv);
        for (let r = 0; r < 3; r++) if (r !== c) { const f = a[r][c]; for (let j = 0; j < 6; j++) a[r][j] = cx.sub(a[r][j], cx.mul(f, a[c][j])); }
    }
    return a.map(r => r.slice(3));
}
function instrumentedResponse(runs, opts = FRF) {
    const rate = runs[0].rate, N = 1 << Math.round(Math.log2(opts.segmentS * rate)), hop = N >> 1, df = rate / N;
    const edges = Array.from({ length: opts.bins + 1 }, (_, i) => opts.fMin * (opts.fMax / opts.fMin) ** (i / opts.bins));
    const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    const z = () => [0, 1, 2].map(() => [0, 1, 2].map(() => [0, 0]));
    const acc = edges.slice(1).map(() => ({ yx: z(), ux: z(), xx: [0, 0, 0], uu: [0, 0, 0], yy: [0, 0, 0], segments: 0 }));
    for (const run of runs) for (let s0 = 0; s0 + N <= run.n; s0 += hop) {
        const spec = (src, k = 1) => { const re = new Float64Array(N), im = new Float64Array(N); let mu = 0;
            for (let i = 0; i < N; i++) mu += src[s0 + i]; mu /= N;
            for (let i = 0; i < N; i++) re[i] = (src[s0 + i] - mu) * win[i] * k; fft(re, im); return [re, im]; };
        const X = run.sp.map(c => spec(c)), U = run.u.map(c => spec(c)), Y = run.gyro.map(c => spec(c, Math.PI / 180));
        for (let k = 1; k < N / 2; k++) {
            const f = k * df; if (f < edges[0] || f >= edges[edges.length - 1]) continue;
            let b = 0; while (f >= edges[b + 1]) b++;
            const q = acc[b]; q.segments++;
            for (let i = 0; i < 3; i++) {
                const yi = [Y[i][0][k], Y[i][1][k]], ui = [U[i][0][k], U[i][1][k]], xi = [X[i][0][k], X[i][1][k]];
                q.xx[i] += xi[0] ** 2 + xi[1] ** 2; q.uu[i] += ui[0] ** 2 + ui[1] ** 2; q.yy[i] += yi[0] ** 2 + yi[1] ** 2;
                for (let j = 0; j < 3; j++) {
                    const xj = [X[j][0][k], -X[j][1][k]]; // conj
                    const a = cx.mul(yi, xj), c = cx.mul(ui, xj);
                    q.yx[i][j][0] += a[0]; q.yx[i][j][1] += a[1]; q.ux[i][j][0] += c[0]; q.ux[i][j][1] += c[1];
                }
            }
        }
    }
    const bins = acc.map((q, b) => {
        const inv = q.segments ? cinv3(q.ux) : null;
        const H = inv ? [0, 1, 2].map(i => [0, 1, 2].map(j => [0, 1, 2].reduce((s, k) => { const t = cx.mul(q.yx[i][k], inv[k][j]); return [s[0] + t[0], s[1] + t[1]]; }, [0, 0]))) : null;
        const coh = (S, a, bb, i) => (S[i][i][0] ** 2 + S[i][i][1] ** 2) / (a[i] * bb[i]);
        return { f: Math.sqrt(edges[b] * edges[b + 1]), H, cohU: [0, 1, 2].map(i => coh(q.ux, q.uu, q.xx, i)), cohY: [0, 1, 2].map(i => coh(q.yx, q.yy, q.xx, i)), averages: q.segments };
    });
    return { bins, segmentS: N / rate, rate, method: 'three-input setpoint-instrumented cross-spectral estimate, Hann window, 50% overlap, log bins' };
}
// Instrumented responses of several operating points (for example one per PID profile and its headspeed).
// groups: [{ key, runs }]. Each result has the operating point of its data for the linearization.
function operatingResponses(groups, minSeconds = 60) {
    const out = [];
    for (const g of groups) {
        const seconds = g.runs.reduce((s, r) => s + r.n / r.rate, 0);
        if (seconds < minSeconds) continue;
        let n = 0; const sum = { rpm: [], coll: 0, tail: 0, thr: 0, vbat: 0 };
        for (const r of g.runs) for (let i = 0; i < r.n; i += 10) { sum.rpm.push(r.hs[i]); sum.coll += r.coll[i]; sum.tail += r.u[2][i]; sum.thr += r.thr[i]; sum.vbat += r.vbat[i]; n++; }
        sum.rpm.sort((a, b) => a - b);
        out.push({ key: g.key, seconds, op: { rpm: sum.rpm[sum.rpm.length >> 1], coll: sum.coll / n, tail: sum.tail / n, thr: sum.thr / n, vbat: sum.vbat / n },
            frd: instrumentedResponse(g.runs) });
    }
    return out;
}
// Residuals of the linearized twin against the instrumented responses: log magnitude and phase (rad), weighted by
// the coherence of both cross spectra. weight scales the whole block.
function frequencyResiduals(model, frd, weight = 1, op) {
    if (Array.isArray(frd)) return frd.flatMap(g => frequencyResiduals(model, g.frd, weight * Math.sqrt(g.seconds / frd.reduce((s, q) => s + q.seconds, 0)), g.op));
    const use = frd.bins.filter(b => b.H && b.H.every(r => r.every(z => z.every(Number.isFinite)))), out = [];
    if (!use.length) return out;
    const Hm = T.frequencyResponseMatrix(model, use.map(b => b.f), op);
    use.forEach((b, k) => {
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
            // on-axis entries: coherence of that axis; off-axis: the smaller of the two axes, half weight, and only
            // where the measured coupling is at least 15% of the on-axis response (else only its size is tested)
            const g = i === j ? Math.min(b.cohU[i], b.cohY[i]) : Math.min(b.cohU[i], b.cohY[i], b.cohU[j], b.cohY[j]);
            if (!(g >= FRF.minCoherence)) continue;
            const w = weight * (i === j ? 1 : 0.5) * Math.sqrt(Math.min(20, g / (1 - g))), hd = b.H[i][j], hm = Hm[k][i][j];
            const md = Math.hypot(...hd), on = Math.hypot(...b.H[j][j]);
            // which entries count depends on the data only, so the residual vector keeps its length for every model
            if (!(md > 0 && on > 0)) continue;
            const mm = Math.max(Math.hypot(...hm), 1e-3 * on);
            if (i !== j && md < 0.15 * on) { out.push(w * (mm - md) / on); continue; }
            const ph = Math.atan2(hm[1], hm[0]) - Math.atan2(hd[1], hd[0]);
            out.push(w * Math.log(mm / md), w * Math.atan2(Math.sin(ph), Math.cos(ph)));
        }
    });
    return out;
}

// ---- parameter fit (Levenberg-Marquardt, forward-difference Jacobian) ----
function encode(model, names) {
    return names.map(n => { const spec = T.PARAMS[T.PI[n]], v = model.params[n]; return spec[4] ? Math.log(v) : v; });
}
function decode(model, names, theta) {
    const m = JSON.parse(JSON.stringify(model));
    names.forEach((n, j) => { const spec = T.PARAMS[T.PI[n]], [lo, hi] = T.paramBounds(model, n), v = spec[4] ? Math.exp(theta[j]) : theta[j];
        m.params[n] = Math.min(hi, Math.max(lo, v)); });
    return m;
}
function solveSym(A, b) { // Cholesky with a fallback to a small ridge
    const n = b.length, L = A.map(r => r.slice());
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
        let s = L[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) { if (s <= 0) return null; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
    }
    const y = new Float64Array(n); for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
    const x = new Float64Array(n); for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
    return x;
}

// residualsMany(models) -> Promise<array of { residuals } or { failed }>; lets the caller evaluate in parallel.
async function fit(model, runs, options = {}) {
    const names = options.free || T.PARAMS.map(p => p[0]), iterations = options.iterations || 20, log = options.log || (() => {});
    const base = options.residualsMany || (async models => models.map(m => predictionErrors(m, runs, { residuals: true, rules: options.rules, weights: options.weights, disturbanceWeight: options.disturbanceWeight })));
    const many = !options.extraResiduals ? base : async models => (await base(models)).map((r, i) => r.failed ? r :
        { residuals: Float64Array.from([...r.residuals, ...options.extraResiduals(models[i])]) });
    const cost = r => r.failed ? Infinity : r.residuals.reduce((s, v) => s + v * v, 0);
    let theta = encode(model, names), current = (await many([decode(model, names, theta)]))[0], c0 = cost(current), lambda = options.lambda || 1e-2;
    if (!Number.isFinite(c0)) throw new Error('The initial model does not give a finite prediction error.');
    const history = [{ iteration: 0, cost: c0 }];
    log(`fit start cost ${c0.toExponential(4)} (${current.residuals.length} residuals, ${names.length} parameters)`);
    let stepScale = 1;
    for (let it = 1; it <= iterations; it++) {
        const steps = names.map((n, j) => { const spec = T.PARAMS[T.PI[n]]; return stepScale * (spec[4] ? 1e-3 : 1e-3 * (spec[3] - spec[2])); });
        const perturbed = names.map((n, j) => { const t = theta.slice(); t[j] += steps[j]; return decode(model, names, t); });
        const cols = await many(perturbed), r0 = current.residuals, N = r0.length, P = names.length;
        const J = cols.map((c, j) => { if (c.failed || c.residuals.length !== N) return new Float64Array(N); const col = new Float64Array(N); for (let i = 0; i < N; i++) col[i] = (c.residuals[i] - r0[i]) / steps[j]; return col; });
        const A = Array.from({ length: P }, (_, a) => Array.from({ length: P }, (_, b) => { let s = 0; const x = J[a], y = J[b]; for (let i = 0; i < N; i++) s += x[i] * y[i]; return s; }));
        const g = J.map(col => { let s = 0; for (let i = 0; i < N; i++) s += col[i] * r0[i]; return s; });
        // active set: a parameter at a bound whose descent direction points out of the bounds stays fixed this step
        // (a clamped step would change the search direction and the step would not decrease the cost)
        const atBound = names.map((n, j) => { const spec = T.PARAMS[T.PI[n]], [lo, hi] = T.paramBounds(model, n), v = decode(model, names, theta).params[n];
            const tol = 1e-9 * Math.max(1, Math.abs(spec[4] ? Math.log(hi) : hi));
            return (v <= lo + Math.abs(lo) * 1e-9 + tol && g[j] > 0) || (v >= hi - Math.abs(hi) * 1e-9 - tol && g[j] < 0); });
        let accepted = false;
        for (let tries = 0; tries < 8 && !accepted; tries++) {
            const D = A.map((row, a) => row.map((v, b) => atBound[a] || atBound[b] ? (a === b ? 1 : 0) : a === b ? v + lambda * (v + 1e-9) : v));
            const delta = solveSym(D, g.map((v, j) => atBound[j] ? 0 : -v));
            if (!delta) { lambda *= 10; continue; }
            const trial = theta.map((v, j) => v + delta[j]), next = (await many([decode(model, names, trial)]))[0], c1 = cost(next);
            if (c1 < c0) { theta = trial; current = next; const gain = (c0 - c1) / c0; c0 = c1; lambda = Math.max(1e-7, lambda / 3); accepted = true;
                history.push({ iteration: it, cost: c1, lambda }); log(`iteration ${it} cost ${c1.toExponential(4)} (-${(gain * 100).toFixed(2)}%) lambda ${lambda.toExponential(1)}`);
                if (gain < (options.tolerance || 1e-4) && lambda < 1e-2) it = iterations;
            } else lambda *= 4;
        }
        if (!accepted && stepScale < 10) { stepScale = 10; lambda = 1e-2; log(`iteration ${it}: no decrease; larger difference steps`); continue; }
        if (!accepted) { log(`iteration ${it}: no decrease; stop`); break; }
        stepScale = 1;
    }
    // approximate standard errors from the Gauss-Newton matrix at the solution (unit residual variance scaled)
    return { model: decode(model, names, theta), cost: c0, history, free: names };
}

// ---- identification of a new aircraft ----
// Stages: rotor speed, vertical channel, the fast dynamics from the instrumented responses (no feedback bias), the
// torque and trim terms from short predictions with those dynamics held, then all parameters together. The
// instrumented responses stay in every later stage with a high weight so that time-domain errors cannot lower the
// control power (the closed-loop bias of a plain prediction-error fit).
const SHORT = Object.freeze({ horizonS: 0.2, originEveryS: 0.25, points: [0.01, 0.02, 0.05, 0.1, 0.15, 0.2] });
const STAGES = Object.freeze([
    { name: 'rotor speed', free: ['kmV', 'kmW', 'ir', 'cq0', 'tauEsc', 'tauHs'], weights: [0, 0, 0, 0, 0, 0, 0, 0, 1], iterations: 15 },
    { name: 'vertical', free: ['sa', 'th0', 'sz', 'tauB', 'tauV', 'dColl'], weights: [0, 0, 0, 0, 0, 0, 1, 1, 0.5], iterations: 15 },
    { name: 'frequency', free: ['tauF', 'gLat', 'gLon', 'lb', 'mb', 'phiU', 'phiW', 'dCyc', 'tauS', 'nt', 'nr', 'dTail', 'kmu'], frequencyOnly: true, frequencyWeight: 1, iterations: 60 },
    // short horizons only: over longer horizons the open-loop helicopter diverges and the cost is too rough to fit
    { name: 'short-horizon joint', free: T.PARAMS.map(p => p[0]).filter(n => !['nc', 'ncd', 'sa', 'th0', 'sz', 'tauB', 'tauV', 'dColl'].includes(n)),
        weights: [1, 1, 1, 1, 1, 1, 0, 0, 1], frequencyWeight: 200, iterations: 20, rules: SHORT },
    { name: 'rotor speed again', free: ['kmV', 'kmW', 'ir', 'cq0', 'tauEsc', 'tauHs'], weights: [0, 0, 0, 0, 0, 0, 0, 0, 1], iterations: 10 },
    // the yaw trim must come from the model, not from the observer disturbance: else the closed loop runs away when
    // the collective changes (the disturbance is held during a prediction)
    { name: 'yaw trim', free: ['nc', 'ncd', 'tht0', 'izz'], weights: [0, 0, 1, 0, 0, 1, 0, 0, 0], disturbanceWeight: 10, frequencyWeight: 200, iterations: 25, rules: SHORT },
]);

// Yaw trim from the moment balance in quasi-steady yaw (rate and its change small): with the tail authority nt
// from the frequency responses, nt n^2 (thetaTail - tht0) + qm / izz + nc n^2 (coll - collRef) = 0 is linear in
// [nt tht0, 1/izz, nc]. qm is the motor torque of the model at the recorded throttle, voltage and rotor speed.
// Least squares cannot wander like an iterative fit, and the closed loop needs this trim when the collective changes.
function yawTrim(model, runs, opts = {}) {
    const p = model.params, ref = model.refRpm * T.RPM, rows = [], maxRate = opts.maxRateDeg || 15, maxAcc = opts.maxAccDeg || 150;
    for (const r of runs) {
        const lag = Math.max(1, Math.round(p.dTail * r.rate)), esc = 1 - Math.exp(-1 / (r.rate * p.tauEsc)); let thr = r.thr[0];
        for (let i = 1; i < r.n - 1; i++) {
            thr += esc * (r.thr[i] - thr);
            const rate = r.target.gyro[2][i], acc = (r.target.gyro[2][i + 1] - r.target.gyro[2][i - 1]) * r.rate / 2;
            if (i < lag || i % 5 || Math.abs(rate) > maxRate || Math.abs(acc) > maxAcc || !(r.hs[i] > 0) || !Number.isFinite(r.vbat[i])) continue;
            const w = r.hs[i] * T.RPM, n2 = (w / ref) ** 2, qm = Math.max(0, p.kmV * thr * r.vbat[i] - p.kmW * w);
            rows.push([n2, -qm, -n2 * (r.coll[i - lag] - (model.collRef || 0)), p.nt * n2 * T.TAIL_PITCH * r.u[2][i - lag]]);
        }
    }
    if (rows.length < 200) return { model, samples: rows.length, solved: false };
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    for (const q of rows) for (let a = 0; a < 3; a++) { b[a] += q[a] * q[3]; for (let c = 0; c < 3; c++) A[a][c] += q[a] * q[c]; }
    const x = solveSym(A.map((row, i) => row.map((v, j) => v + (i === j ? 1e-9 * (1 + v) : 0))), b);
    if (!x) return { model, samples: rows.length, solved: false };
    const m = JSON.parse(JSON.stringify(model)), clamp = (n, v) => { const [lo, hi] = T.paramBounds(m, n); return Math.min(hi, Math.max(lo, v)); };
    m.params.tht0 = clamp('tht0', x[0] / p.nt); m.params.izz = clamp('izz', x[1] > 0 ? 1 / x[1] : T.paramBounds(m, 'izz')[1]); m.params.nc = clamp('nc', x[2]);
    let res = 0, tot = 0; const mean = rows.reduce((s, q) => s + q[3], 0) / rows.length;
    for (const q of rows) { res += (q[3] - q[0] * x[0] - q[1] * x[1] - q[2] * x[2]) ** 2; tot += (q[3] - mean) ** 2; }
    return { model: m, samples: rows.length, solved: true, r2: 1 - res / tot };
}

// Median rotor speed and mean collective of the training data: the reference of the speed scaling and the
// collective torque term.
function operatingPoint(runs) {
    const rpm = [], coll = [];
    for (const r of runs) for (let i = 0; i < r.n; i += 25) { if (r.hs[i] > 0) rpm.push(r.hs[i]); if (Number.isFinite(r.coll[i])) coll.push(r.coll[i]); }
    rpm.sort((a, b) => a - b);
    return { rpm: Math.round(rpm[rpm.length >> 1] || 3000), coll: coll.length ? coll.reduce((a, b) => a + b, 0) / coll.length : 0 };
}

// train/test: prepared runs (prepareRun). groups*: [{ key, runs }] for the instrumented responses.
// residualsMany(models, stage) may evaluate the time residuals in parallel; the default is serial.
async function identify(input) {
    const log = input.log || (() => {}), progress = input.progress || (() => {});
    let model = T.createModel(input.craftPrior || {}, { refRpm: input.refRpm || operatingPoint(input.train).rpm });
    model.collRef = operatingPoint(input.train).coll;
    Object.assign(model.constants, input.constants || {});
    const frdTrain = operatingResponses(input.groupsTrain || [{ key: 'all', runs: input.train }], input.minGroupS);
    if (!frdTrain.length) throw new Error('The flight data is not sufficient for the frequency responses.');
    const stages = input.stages || STAGES, history = [];
    for (const [k, st] of stages.entries()) {
        progress(st.name, k, stages.length);
        if (st.linear === 'yawTrim') { const t = yawTrim(model, input.train); model = t.model; history.push({ stage: st.name, free: ['tht0', 'izz', 'nc'], samples: t.samples, r2: t.r2, solved: t.solved }); log(`${st.name}: ${t.samples} samples, R2 ${t.r2}`); continue; }
        const rules = Object.assign({}, RULES, input.rules, st.rules);
        const time = st.frequencyOnly ? async ms => ms.map(() => ({ residuals: new Float64Array(0) })) :
            input.residualsMany ? ms => input.residualsMany(ms, st, rules) :
            async ms => ms.map(m => predictionErrors(m, input.train, { residuals: true, rules, weights: st.weights, disturbanceWeight: st.disturbanceWeight }));
        // The frequency term anchors the fast dynamics but must not swamp the time residuals: its weight is at most
        // st.frequencyWeight and at most the weight that makes it half the time cost at the stage start (fewer time
        // residuals, as in a short in-app data set, then give a lower weight).
        let fw = st.frequencyWeight || 0;
        if (fw && !st.frequencyOnly) {
            const t0 = (await time([model]))[0], ct = t0.failed ? Infinity : t0.residuals.reduce((a, v) => a + v * v, 0);
            const cf = frequencyResiduals(model, frdTrain, 1).reduce((a, v) => a + v * v, 0);
            if (Number.isFinite(ct) && cf > 0) fw = Math.min(fw, Math.sqrt(0.5 * ct / cf));
        }
        const r = await fit(model, null, { free: st.free, iterations: st.iterations, residualsMany: time,
            extraResiduals: fw ? m => frequencyResiduals(m, frdTrain, fw) : null, log });
        model = r.model; history.push({ stage: st.name, free: st.free, cost: r.cost, iterations: r.history.length - 1, frequencyWeight: fw });
    }
    return { model, history, frdTrain };
}

// Test of a frozen model on reserved flights: prediction errors at each horizon against holding the last value,
// instrumented responses of the reserved data against the model, and traces for plots.
function validate(model, test, groupsTest, options = {}) {
    const prediction = predictionErrors(model, test, { rules: options.rules, traces: options.traces || { horizonS: 1, decimateTo: 100 } });
    const frd = operatingResponses(groupsTest || [{ key: 'all', runs: test }], options.minGroupS || 30);
    const frequency = frd.map(g => { const bins = g.frd.bins.filter(b => b.H), Hm = T.frequencyResponseMatrix(model, bins.map(b => b.f), g.op);
        return { key: g.key, seconds: g.seconds, op: g.op, bins: bins.map((b, k) => ({ f: b.f, measured: b.H, model: Hm[k], cohU: b.cohU, cohY: b.cohY, averages: b.averages })) }; });
    return { prediction, frequency };
}

// Acceptance of a frozen model on reserved flights. Limits are model-check limits for this app, not flight safety.
const CHECK = Object.freeze({ ratePoint: 0.1, rateSkill: 0.9, attitudePoint: 0.2, minBins: 3, minCoherence: 0.5,
    maxLogMagnitude: 0.35, maxPhaseDeg: 35 });
function assess(validation, check = CHECK) {
    const p = validation.prediction, reasons = [], axes = ['roll', 'pitch', 'yaw'], k = p.points.indexOf(check.ratePoint), ka = p.points.indexOf(check.attitudePoint);
    const prediction = axes.map((axis, a) => {
        const model = p.rmse[a][k], hold = p.persistence[a][k], pass = model !== null && hold !== null && model <= check.rateSkill * hold;
        if (!pass && a < 2) reasons.push(`${axis}: the ${check.ratePoint} s rate prediction error is not less than ${Math.round(check.rateSkill * 100)}% of the hold-last-value error.`);
        return { axis, horizonS: check.ratePoint, rmse: model, persistence: hold, pass };
    });
    for (const [ch, name] of [[3, 'roll'], [4, 'pitch']]) if (!(p.rmse[ch][ka] <= p.persistence[ch][ka]))
        reasons.push(`${name}: the ${check.attitudePoint} s attitude prediction error is more than the hold-last-value error.`);
    const frequency = axes.map((axis, a) => {
        const rows = (validation.frequency || []).flatMap(g => g.bins.filter(b => Math.min(b.cohU[a], b.cohY[a]) >= check.minCoherence).map(b => {
            const hm = b.model[a][a], hd = b.measured[a][a], ph = Math.atan2(hm[1], hm[0]) - Math.atan2(hd[1], hd[0]);
            return { f: b.f, logMagnitude: Math.log(Math.hypot(...hm) / Math.hypot(...hd)), phaseDeg: Math.atan2(Math.sin(ph), Math.cos(ph)) * 180 / Math.PI };
        }));
        const median = x => { const s = x.slice().sort((u, v) => u - v); return s.length ? s[s.length >> 1] : null; };
        const mag = median(rows.map(r => Math.abs(r.logMagnitude))), phase = median(rows.map(r => Math.abs(r.phaseDeg)));
        const measured = rows.length >= check.minBins, pass = measured && mag <= check.maxLogMagnitude && phase <= check.maxPhaseDeg;
        if (!measured) reasons.push(`${axis}: the pilot inputs do not measure the frequency response at ${check.minBins} frequencies.`);
        else if (!pass) reasons.push(`${axis}: the model frequency response does not agree with the reserved flights.`);
        return { axis, bins: rows.length, medianLogMagnitude: mag, medianPhaseDeg: phase, measured, pass, rows };
    });
    // Per axis: roll and pitch need the rate prediction and the frequency response. Yaw needs the frequency response:
    // an open-loop yaw replay integrates every torque disturbance that the recorded tail command cancelled, so its
    // prediction error is shown but is not a gate (the closed control loop checks the yaw in control_pipeline).
    const attitudeOk = [3, 4].map(ch => p.rmse[ch][ka] <= p.persistence[ch][ka]);
    const axisPass = [0, 1, 2].map(a => a < 2 ? prediction[a].pass && attitudeOk[a] && frequency[a].pass : frequency[a].pass);
    prediction[2].gating = false;
    const eligibleSteps = [...(axisPass[0] && axisPass[1] ? ['cyclic', 'cycomp'] : []), ...(axisPass[2] ? ['tail', 'tailcomp'] : [])];
    const status = axisPass.every(Boolean) ? 'validated' : eligibleSteps.length ? 'partial' : 'rejected';
    return { status, reasons, prediction, frequency, check, axes: axes.map((axis, a) => ({ axis, pass: axisPass[a] })), eligibleSteps };
}

module.exports = { RULES, FRF, STAGES, CHECK, identify, validate, assess, operatingPoint, yawTrim, CHANNELS, fft, instrumentedResponse, operatingResponses, frequencyResiduals, lowpass, decimate, prepareRun, observerPass, rollout, predictionErrors, trace, fit, encode, decode };
if (require.main !== module) return;
