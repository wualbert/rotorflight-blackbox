'use strict';

/**
 * Governor twin identification and validation (docs/GOVERNOR_AUTOTUNE.md section 4). The plant is gov_twin.cjs; the runs are
 * the flight runs of gov_data.cjs (bench runs are not used: CLAUDE.md).
 *
 *   identify(runs, opts)            qualification, split, initial values (the ESC soft start measured), output-error LM on 5-s windows, kappa, LM again,
 *                                   block bootstrap and leave-one-flight-out refits -> model { status, reasons, Href, has, split, params (a
 *                                   gov_twin parameter set), initial, free, uncertainty { name: { value, unit, informed, p5, p50, p95, bootstrap
 *                                   { p5, p95 }, flights { lo, hi, n, values }, source } }, samples (bootstrap parameter sets and the jackknife
 *                                   pseudo-sets), kappa { value, se, restOffset }, softStart, physical { value, range } (current only),
 *                                   regression (the static values), fit, bootstrap { n, flights, ... }, timing }; status 'failed' with a reason
 *                                   when there is too little data or the cost is not finite.
 *                                   opts: { rules, Href, split, bootstrap, iterations, fixed, free, zero (ablation: held at 0), progress(f, text) }
 *   validate(model, runs, opts)     async. Open loop, horizon curve, closed loop (and unforced, tmScan), events, status 'validated' | 'partial'
 *                                   | 'rejected' with STE reasons and the checks { rule, value, limit, pass, text }. opts: { sim (default
 *                                   require('./gov_sim.cjs'); null: no closed loop), configs (gov_sim.configOf) | configOf(run) | cfg,
 *                                   scenario }. The open-loop starts are causal (stateAt).
 *   openLoop, horizonCurve, closedLoop, events   the parts of validate (the test data of model.split). events: the spool-up exits (exit
 *                                   throttle, overshoot), the saturated time, and the FALLBACK droop and recovery, the log against the twin
 *   stateAt(model, run, i, {causal})            the twin state at frame i as the validation estimates it (for gov_twin.simulate x0)
 *   plotData(model, runs, validation)            the traces of each test run (<= RULES.plotPoints points, time in frame seconds:
 *                                                fromS + time, the clock of the log viewer), the logged governor states as bands, the horizon curve and
 *                                                the steady-state map (steadyMap)
 *   fitCost(p, P, W)                the fit cost of a parameter set on prepared windows (prepare(runs))
 *   lm(f, z0, o), nnls(X, y)        a small bounded Levenberg-Marquardt (pseudo-Huber, box with an active set, forward differences,
 *                                   a residual vector of constant length) and non-negative least squares
 *
 * Data. Each run is decimated to the fit grid (RULES.fitHz): inputs are block means over the frames of a grid step (u, the signed coll,
 * the cyclic magnitude, |yaw|, as gov_twin.simulate), outputs are the frame values at the grid points. Motor running: u >
 * runningU or hs > runningHs·Href, with the rotor turning (RULES.restHs: both ESCs start the motor at u 0.10-0.12). A window holds
 * windowS of motor-running data and starts from the measured state (startState): centred means of hs and Vbat (errors in the
 * variables), H and V0 read th and tv later (the sensor lags), the ESC duty = u filtered with te. The ESC soft start (gov_twin: a
 * rotor speed ramp lim at ass from the motor start) is armed in the data as in gov_twin (throttle under dOff with the rotor under
 * softHs·Href, or for softOffS); the motor start is the first frame with the throttle on and the rotor turning (the ESC start
 * throttle u0 is measured there), and the ramp starts at the rotor speed of that frame. A window inside a soft start starts with
 * lim = that speed + ass·(t − t_on); where the rotor is at the ramp, the duty comes from the measured acceleration
 * (gov_twin.initState stopped, accel): a window that starts in a soft start with the steady duty is wrong by up to 72 % (Fireball
 * log 10). A step in which the duty crosses dOff outside a soft start is split at the crossing (stepSplit): else the coast switch
 * of gov_twin sits on the grid and the cost jumps with te.
 *
 * Residuals: (hsLog − hs)/(sigma.hs·Href), (vLog − vbat)/sigma.v, (iLog − ibat)/sigma.i for the recorded channels, at every grid
 * point of every window (a constant length). Open-loop points (governor state other than ACTIVE, u >= openLoopU, u < dOff,
 * and openLoopTailS after them) have the weight openLoopWeight on the squared residual: they carry the authority information
 * that closed-loop ACTIVE data does not give (critique C13). kappa comes from the OCV regression; th, u0 and ass are held
 * (RULES.fixed).
 *
 * Without current, kv, the loads and beta trade off with each other: kv from the low-load ratio is a lower bound (critique C2),
 * and beta from a static regression is low by 20-50 % (models 4.2). The output-error fit and the bootstrap give the values and
 * their spread; regression holds the static values for the comparison. kappa.restOffset: the rest voltage before a flight less
 * the regression OCV at the start, the polarization that an R0-only battery does not model (Gaui and Fireball logs: 0.3-0.4 V).
 */

const GT = require('./gov_twin.cjs');

const RULES = {
    fitHz: 100,             // grid rate of the fit (Hz)
    windowS: 5,             // window length (s)
    minWindowS: 1,          // a shorter rest of a motor-running stretch is joined to the window before it, or dropped
    minDataS: 30,           // the least motor-running training data for a fit (s)
    runningU: 0.02, runningHs: 0.1,   // motor running: u > runningU or hs > runningHs·Href, and the rotor not at rest:
    restHs: 0.01,           // hs < restHs·Href is a rotor at rest. The ESC starts the motor above a start throttle (gov_twin u0; Fireball:
                            // u 0.08-0.12 with hs 0 for 1 s), and its soft-start ramp starts then
    softBind: 0.02,         // a rotor within this share of Href under the soft-start ramp is at the ramp (startState, dutyOf)
    testEvery: 3,           // with >= testEvery flight logs, the logs with index % testEvery == testEvery − 1 are the test logs
    testShare: 0.4,         // else the last testShare of the motor-running data of each flight log
    sigma: { hs: 0.01, v: 0.05, i: 2 },   // residual scales: hs as a fraction of Href, V, A
    huber: 2,               // pseudo-Huber width in sigma units
    openLoopU: 0.995, openLoopWeight: 3, openLoopTailS: 0.3,
    // the throttle ceiling of a log flown with gov_max_throttle under 100 % (ceilingOf, without a configuration): the highest logged u in
    // ACTIVE, held for satHoldS or more; saturated: u >= the ceiling − satEps (gov_sim RULES.satEps)
    satHoldS: 0.25, satEps: 0.005,
    activeHs: 0.8,          // ACTIVE without the governor states: hs > activeHs·Href and dOff < u < openLoopU
    startS: 0.01,           // the window start values of hs and Vbat are centred means over ± startS
    // the OCV at a window start: the mean of vbat + beta·d·s over the ocvS before it (a single point is wrong by beta·Δ(d·s) after a
    // fast load change: synthetic Gaui-like plant, the window after a collective pump has 6 times the cost at the true values)
    ocvS: 0.5,
    kv: { blockS: 1, q: 0.995, factor: 1.02, vLagS: 0.06, iLagS: 0.09, minBlocks: 10 },
    init: { te: 0.1, tm: 0.4, beta: 0.1, tv: 0.06, ti: 0.09, th: 0.01, pc: [1, 1.5, 2, 2.5, 3], c0: [-0.3, -0.2, -0.1, 0, 0.1], hpS: 2, ass: 500, u0: 0.1 },
    // parameters held at their start values: kappa and vp (the rest offset) come from the OCV regression; th (the headspeed sensor lag, 2-10 ms: the firmware
    // RPM filter) is under the 10-ms grid step and not identifiable (synthetic tests: 25-55 % error), and on the Fireball logs a free
    // th goes to 0.45 s to smooth the output, which would put a false lag in the closed loop (the governor reads hsLog). The ESC soft
    // start is measured at the motor starts from rest (softRamp): u0 the median throttle at the start (the windows start with the
    // rotor turning, so they cannot show it), the ramp as0, asr, ass from the speed against the time since the start. A window fit of
    // the ramp depends on where the windows cut it (Fireball, constant rate: 477 rpm/s against 550 measured, and the closed-loop
    // spool-up exit then saturates for 2 s)
    fixed: ['kappa', 'vp', 'th', 'u0', 'ass', 'asr', 'as0', 'as1'],
    // softRamp (start values): samples every everyS while the soft start lasts (gov_twin softEnd: after it the RF throttle ramp limits,
    // Gaui logs 38-45 from 6 s), hs under top·Href; minSamples per start; sigma: the residual scale (share of Href). softFit (the values):
    // output error of the twin on each motor start from rest, from preS before the start to exitS after the SPOOLUP exit (else
    // horizonS), iterations of the LM. The kinematic fit alone is biased where the duty limits the rotor (the first second after the
    // start, and the RF ramp after it): synthetic Fireball-like plant, as0 0 and asr −61 % against the truth, with 23 times the fit cost
    soft: { everyS: 0.1, top: 0.9, minSamples: 20, sigma: 0.01, preS: 0.5, exitS: 2, horizonS: 20, iterations: 30, skipS: 0.5 },
    lm: { iterations: 60, tolerance: 1e-5, lambda: 1e-2, step: 1e-3,   // stop after two iterations with a relative decrease under tolerance
        informed: 1e-9 },  // a parameter with a J'J diagonal under informed x the largest one has no effect on the residuals (uncertainty.informed)
    bootstrap: 12, blockS: 20, bootIterations: 8, seed: 12345,
    // leave-one-flight-out refits (with >= minLogs training flight logs and a bootstrap): LM iterations from the main fit, and z90 of the
    // 90 % interval (p5-p95) of the jackknife standard error
    jackknife: { iterations: 20, minLogs: 3, z90: 1.645 },
    horizons: [0.1, 0.25, 0.5, 1, 2, 5], horizonEveryS: 0.5,
    // status checks: open-loop HS median |e| (% of target), Vbat RMS (V); closed-loop HS RMS (% of target, pooled over the test logs) and of
    // each test log (perLog × clHsRms); clSkill: the closed-loop HS RMS divided by the logged tracking error (hs − govTarget: a model that
    // always has the target), at most 3/4; clBand: the same for the fast part (band: the means over 0.1 s less the means over 1 s, about
    // 1-10 Hz, where the speed dynamics act): the twin must give at least half of its variance (0.7² < 0.5); tmBand: no time constant tm ×
    // tmScan gives a fast error under tmMargin × that of the model (else the test flights do not confirm tm); clURms (0..1); stateAgree (share)
    status: { hsMedian: 1.5, vbatRms: 0.15, clHsRms: 1.5, perLog: 1.5, clSkill: 0.75, clBand: 0.7, band: [0.1, 1], tmScan: [0.5, 0.7, 1.4, 2], tmMargin: 0.95, clURms: 0.03, stateAgree: 0.98 },
    // events: exit throttle 0..1, overshoot % points, saturated time (share, of >= 1 s), the FALLBACK droop (% points of the request: the
    // lowest headspeed in gov_sim RULES.eventS after the entry) and its recovery time (share, of >= 1 s)
    events: { exitThrottle: 0.05, overshoot: 2, satRel: 0.3, overshootS: 5, fallbackDroop: 5, recoveryRel: 0.3 },
    profileMinS: 10,        // a governed headspeed with this much ACTIVE time gets a curve in the steady-state map
    plotPoints: 2000,
    // the governor states that the plots of the test flights show as bands (OFF, ACTIVE and BYPASS are not shaded), at most plotBands
    bandStates: { 1: 'IDLE', 2: 'SPOOLUP', 3: 'RECOVERY', 5: 'HOLD', 6: 'FALLBACK', 7: 'AUTOROTATION', 8: 'BAILOUT' }, plotBands: 400,
};

const pct = (x, d = 1) => (x * 100).toFixed(d);
const TEXT = {
    bench: (n) => `The governor model uses only the flight logs. It does not use ${n} bench runs.`,
    noPhase: (log) => `Log ${log}: the analysis cannot find the flight phases. Thus, the governor model does not use this log.`,
    noHsU: (log) => `Log ${log}: the log does not record the headspeed or the motor output. Thus, the governor model does not use this log.`,
    mixedV: 'Some flight logs do not record the battery voltage. Thus, the governor model does not use the battery voltage.',
    mixedI: 'Some flight logs do not record the battery current. Thus, the governor model does not use the battery current.',
    noData: (s, min) => `The flight logs have ${s.toFixed(0)} s of fit data with the motor on. The governor model must have a minimum of ${min} s.`,
    noTest: 'The flight logs have no test data with the motor on. Thus, the app cannot compare the governor model with a test flight.',
    noSim: 'The app cannot calculate the closed loop of the governor and the model. Thus, it does not compare them with the test flights.',
    noConfig: (log) => `Log ${log}: the governor values are unknown. Thus, the app does not calculate the closed loop for this log.`,
    simFail: (log, why) => `Log ${log}: the app cannot calculate the closed loop. ${why}`.trim(),
    noCurrent: 'The log does not record the battery current. Thus, the model cannot calculate the motor resistance, the battery resistance and the rotor inertia.',
    noVoltage: 'The log does not record the battery voltage. Thus, the model uses a constant voltage, and the battery results are not available. ' +
        'The battery voltage decreases during a flight, and the headspeed errors of the model are larger.',
    noChannelV: 'Some logs do not record the battery voltage. Thus, the app does not compare the battery voltage of the model with the test flights.',
    noChannelI: 'Some logs do not record the battery current. Thus, the app does not compare the battery current of the model with the test flights.',
    fitFail: 'The app cannot calculate the governor model from these logs. The result is not a number.',
    hsMedian: (v, l) => `The open-loop headspeed error is ${v.toFixed(2)} % (median in ACTIVE). The limit is ${l} %.`,
    vbatRms: (v, l) => `The open-loop battery voltage error is ${v.toFixed(3)} V (RMS). The limit is ${l} V.`,
    clHsRms: (v, l) => `The closed-loop headspeed error is ${v.toFixed(2)} % (RMS in ACTIVE). The limit is ${l} %.`,
    clURms: (v, l) => `The closed-loop throttle error is ${pct(v, 2)} % (RMS in ACTIVE). The limit is ${pct(l, 0)} %.`,
    stateAgree: (v, l) => `In the closed loop, the governor condition agrees with the log in ${pct(v, 2)} % of the samples. The minimum is ${pct(l, 0)} %.`,
    clHsRmsLog: (v, l, log) => `In log ${log}, the closed-loop headspeed error is ${v.toFixed(2)} % (RMS in ACTIVE). The limit for one log is ${l.toFixed(2)} %.`,
    clSkill: (v, l) => `The closed-loop headspeed error is ${pct(v, 0)} % of the error of a model that always has the target headspeed of the log. The maximum is ${pct(l, 0)} %.`,
    clBand: (v, l) => `The fast part (1 Hz to 10 Hz) of the closed-loop headspeed error is ${pct(v, 0)} % of the fast part of the headspeed error in the log. The maximum is ${pct(l, 0)} %.`,
    tmBand: (v, l, f) => `With ${f} times the rotor time constant ("tm"), the fast closed-loop headspeed error is ${pct(v, 0)} % of the error of the model. ` +
        'Thus, the test flights do not show the correct value of "tm".',
    validated: 'The governor model agrees with the test flights in all checks.',
    partial: 'The governor model agrees with the test flights in some checks only. Examine the results before you use them.',
    rejected: 'The governor model does not agree with the test flights. The app does not use it for the governor tuning.',
};

// ---- small numerics ----
const finite = Number.isFinite;
function quantile(a, q) { // a: numbers (not sorted); linear interpolation
    const s = Float64Array.from(a.filter(finite)).sort();
    if (!s.length) return null;
    const x = q * (s.length - 1), i = Math.floor(x), f = x - i;
    return i + 1 < s.length ? s[i] + f * (s[i + 1] - s[i]) : s[i];
}
const median = (a) => quantile(a, 0.5);
// Cholesky solve of the symmetric P x P system A x = b (A flat, row-major). null when A is not positive definite.
function solveSym(A, b, P) {
    const L = new Float64Array(P * P);
    for (let i = 0; i < P; i++) for (let j = 0; j <= i; j++) {
        let s = A[i * P + j]; for (let k = 0; k < j; k++) s -= L[i * P + k] * L[j * P + k];
        if (i === j) { if (!(s > 0)) return null; L[i * P + i] = Math.sqrt(s); } else L[i * P + j] = s / L[j * P + j];
    }
    const y = new Float64Array(P), x = new Float64Array(P);
    for (let i = 0; i < P; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * P + k] * y[k]; y[i] = s / L[i * P + i]; }
    for (let i = P - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < P; k++) s -= L[k * P + i] * x[k]; x[i] = s / L[i * P + i]; }
    return x;
}
// least squares of y on the columns X[j] (arrays of the same length), on the column set `set`; tiny ridge for stability
function lsq(X, y, set) {
    const P = set.length, A = new Float64Array(P * P), b = new Float64Array(P);
    for (let a = 0; a < P; a++) {
        const xa = X[set[a]];
        for (let i = 0; i < y.length; i++) b[a] += xa[i] * y[i];
        for (let c = 0; c <= a; c++) { const xc = X[set[c]]; let s = 0; for (let i = 0; i < y.length; i++) s += xa[i] * xc[i]; A[a * P + c] = A[c * P + a] = s; }
    }
    for (let a = 0; a < P; a++) A[a * P + a] += 1e-12 * (A[a * P + a] + 1e-30);
    return solveSym(A, b, P);
}
// non-negative least squares (Lawson-Hanson active set) of y on the columns X: coefficients >= 0
function nnls(X, y) {
    const K = X.length, x = new Float64Array(K), free = new Set();
    const grad = () => { const r = y.map((v, i) => v - X.reduce((s, col, j) => s + col[i] * x[j], 0)); return X.map(col => col.reduce((s, c, i) => s + c * r[i], 0)); };
    for (let outer = 0; outer < 3 * K; outer++) {
        const w = grad();
        let jm = -1; for (let j = 0; j < K; j++) if (!free.has(j) && w[j] > 1e-12 * (1 + Math.abs(w[j])) && (jm < 0 || w[j] > w[jm])) jm = j;
        if (jm < 0) break;
        free.add(jm);
        for (let inner = 0; inner < 3 * K; inner++) {
            const set = [...free], z = lsq(X, y, set);
            if (!z) { free.delete(jm); return x; }
            if (z.every(v => v > 0)) { set.forEach((j, a) => { x[j] = z[a]; }); break; }
            let alpha = 1; set.forEach((j, a) => { if (z[a] <= 0) alpha = Math.min(alpha, x[j] / (x[j] - z[a])); });
            set.forEach((j, a) => { x[j] += alpha * (z[a] - x[j]); if (x[j] <= 1e-15) { x[j] = 0; free.delete(j); } });
        }
    }
    return x;
}
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// pseudo-Huber cost of one residual (delta 0: the square)
const huberSq = (r, delta) => { if (!(delta > 0)) return r * r; const q = r / delta; return 2 * delta * delta * (Math.sqrt(1 + q * q) - 1); };

// ---- generic bounded Levenberg-Marquardt ----
// f(z, out) fills `out` (length o.n) with residuals. Cost = sum psi(r)^2 with the pseudo-Huber psi(r) = r·sqrt(2/(1 + sqrt(1 +
// (r/delta)^2))) (cost 2·delta²·(sqrt(1 + (r/delta)²) − 1), quadratic near 0, linear for large r). Forward differences with the
// steps o.steps (backward at the upper bound). Marquardt damping on the diagonal. Stop: two iterations in a row with a relative
// cost decrease under o.tolerance, no decrease, or o.iterations. A parameter at a bound whose descent points
// out of the box stays fixed in that step (active set); a step is clipped to the box. A non-finite residual makes a trial
// fail and a Jacobian column 0.
function lm(f, z0, o) {
    const P = z0.length, N = o.n, lo = o.lo, hi = o.hi, delta = o.huber > 0 ? o.huber : 0, tol = o.tolerance != null ? o.tolerance : 1e-4;
    const iters = o.iterations != null ? o.iterations : 30, steps = o.steps, progress = o.progress || null;
    const clip = (z) => { for (let j = 0; j < P; j++) z[j] = Math.min(hi[j], Math.max(lo[j], z[j])); return z; };
    let r0 = new Float64Array(N), rt = new Float64Array(N);
    const J = new Float32Array(N * P), A = new Float64Array(P * P), D = new Float64Array(P * P), g = new Float64Array(P), rhs = new Float64Array(P);
    let evals = 0;
    const evalInto = (z, out) => {
        evals++; f(z, out);
        let c = 0;
        for (let i = 0; i < N; i++) {
            let v = out[i];
            if (!finite(v)) return Infinity;
            if (delta) { const q = v / delta; v *= Math.sqrt(2 / (1 + Math.sqrt(1 + q * q))); out[i] = v; }
            c += v * v;
        }
        return c;
    };
    let z = clip(Float64Array.from(z0)), cost = evalInto(z, r0), lambda = o.lambda != null ? o.lambda : 1e-2, it = 0, stop = 'iterations', small = 0;
    const history = [cost];
    if (!finite(cost)) return { z, cost, iterations: 0, evaluations: evals, history, stop: 'not finite', info: new Array(P).fill(0) };
    for (it = 1; it <= iters; it++) {
        for (let j = 0; j < P; j++) {
            const h = z[j] + steps[j] > hi[j] ? -steps[j] : steps[j], zt = Float64Array.from(z); zt[j] += h;
            const c = evalInto(zt, rt), col = j * N;
            if (finite(c)) for (let i = 0; i < N; i++) J[col + i] = (rt[i] - r0[i]) / h; else J.fill(0, col, col + N);
        }
        for (let a = 0; a < P; a++) {
            let s = 0; const ca = a * N;
            for (let i = 0; i < N; i++) s += J[ca + i] * r0[i];
            g[a] = s;
            for (let b = 0; b <= a; b++) { let t = 0; const cb = b * N; for (let i = 0; i < N; i++) t += J[ca + i] * J[cb + i]; A[a * P + b] = A[b * P + a] = t; }
        }
        let dmax = 0; for (let a = 0; a < P; a++) dmax = Math.max(dmax, A[a * P + a]);
        const fixed = new Uint8Array(P);
        for (let j = 0; j < P; j++) {
            const eps = 1e-9 * Math.max(1, Math.abs(hi[j] - lo[j]));
            if ((z[j] <= lo[j] + eps && g[j] > 0) || (z[j] >= hi[j] - eps && g[j] < 0)) fixed[j] = 1;
        }
        let accepted = false, rel = 0;
        for (let t = 0; t < 10 && !accepted; t++) {
            for (let a = 0; a < P; a++) {
                rhs[a] = fixed[a] ? 0 : -g[a];
                for (let b = 0; b < P; b++) D[a * P + b] = fixed[a] || fixed[b] ? (a === b ? 1 : 0) : A[a * P + b] + (a === b ? lambda * (A[a * P + a] + 1e-9 * dmax + 1e-300) : 0);
            }
            const d = solveSym(D, rhs, P);
            if (!d) { lambda *= 10; continue; }
            const zt = clip(Float64Array.from(z, (v, j) => v + d[j])), c = evalInto(zt, rt);
            if (c < cost) {
                rel = (cost - c) / cost; z = zt; cost = c; const sw = r0; r0 = rt; rt = sw;
                lambda = Math.max(1e-9, lambda / 3); accepted = true;
            } else lambda *= 4;
        }
        history.push(cost);
        if (progress) progress(it, cost);
        if (!accepted) { stop = 'no decrease'; break; }
        small = rel < tol ? small + 1 : 0;
        if (small >= 2) { stop = 'converged'; break; }
    }
    // info: the diagonal of J'J of the last Jacobian (0: the residuals do not depend on the parameter)
    return { z, cost, iterations: Math.min(it, iters), evaluations: evals, history, stop, info: Array.from({ length: P }, (_, a) => A[a * P + a]) };
}

// ---- data on the fit grid ----
const STATE_ACTIVE = 4;
// the reference of the % errors: govTarget in ACTIVE, else govRequest (govTarget follows the headspeed in IDLE and SPOOLUP), at least
// half of Href
function targetAt(run, i, active, Href) {
    const t = active && run.target && run.target[i] > 0 ? run.target[i] : run.request && run.request[i] > 0 ? run.request[i] : Href;
    return t > 0.5 * Href ? t : 0.5 * Href;
}
// the median governed request (else the median target, else the p75 headspeed with the motor on) of the samples under lim(run) of each run
function hrefOf(runs, lim) {
    const req = [], tgt = [], hs = [];
    for (const r of runs) for (let i = 0, n = lim ? Math.min(r.n, lim(r)) : r.n; i < n; i += 50) {
        const act = r.state ? r.state[i] === STATE_ACTIVE : r.u[i] > RULES.runningU;
        if (act && r.request && r.request[i] > 0) req.push(r.request[i]);
        if (act && r.target && r.target[i] > 0) tgt.push(r.target[i]);
        if (r.u[i] > RULES.runningU && r.hs[i] > 0) hs.push(r.hs[i]);
    }
    return req.length ? median(req) : tgt.length ? median(tgt) : hs.length ? quantile(hs, 0.75) : null;
}
// the qualified runs and the channel set. o.has: the channel set of a model (validation), with the channels that every run records
function qualify(runs, o = {}) {
    const reasons = [], use = [];
    let bench = 0;
    for (const r of runs) {
        if (r.class === 'bench') { bench++; continue; }
        if (r.class !== 'flight') { reasons.push(TEXT.noPhase(r.log + 1)); continue; }
        if (!r.hs || !r.u) { reasons.push(TEXT.noHsU(r.log + 1)); continue; }
        use.push(r);
    }
    if (bench) reasons.push(TEXT.bench(bench));
    const has = { voltage: use.length > 0 && use.every(r => !!r.vbat), current: use.length > 0 && use.every(r => !!r.vbat && !!r.ibat) };
    if (o.has) {
        // the channels of a model (validation) that the runs record: a channel that one run does not record gives no residuals and no check
        if (o.has.voltage && !has.voltage) reasons.push(TEXT.noChannelV);
        else if (o.has.current && !has.current) reasons.push(TEXT.noChannelI);
        has.voltage = has.voltage && !!o.has.voltage; has.current = has.voltage && has.current && !!o.has.current;
    } else {
        if (!has.voltage && use.some(r => r.vbat)) reasons.push(TEXT.mixedV);
        if (has.voltage && !has.current && use.some(r => r.ibat)) reasons.push(TEXT.mixedI);
    }
    return { use, has, reasons };
}
// the throttle at which the governor output stops (gov_max_throttle under 100 %): the highest logged u in ACTIVE (with the motor on
// without governor states), if the log holds it for RULES.satHoldS or more, less RULES.satEps; else RULES.openLoopU
function ceilingOf(run, R) {
    const u = run.u, st = run.state, n = run.n, on = (i) => st ? st[i] === STATE_ACTIVE : u[i] > R.runningU;
    let mx = 0; for (let i = 0; i < n; i++) if (on(i) && u[i] > mx) mx = u[i];
    if (!(mx > R.runningU && mx < R.openLoopU)) return R.openLoopU;
    let m = 0; for (let i = 0; i < n; i++) if (on(i) && u[i] >= mx - 5e-4) m++;
    return m >= R.satHoldS * run.rate ? mx - R.satEps : R.openLoopU;
}
// one run on the fit grid (see the header). causal: the start estimates of the validation (no sample after the start point)
function gridOf(run, Href, has, R, causal) {
    const stride = Math.max(1, Math.round(run.rate / R.fitHz)), ng = Math.floor(run.n / stride), dt = stride / run.rate;
    const U = new Float32Array(ng), C = new Float32Array(ng), X = new Float32Array(ng), Y = new Float32Array(ng), HS = new Float32Array(ng);
    const V = has.voltage ? new Float32Array(ng) : null, I = has.current ? new Float32Array(ng) : null, T = new Float32Array(ng);
    const RUN = new Uint8Array(ng), ACT = new Uint8Array(ng), W = new Float32Array(ng), G = new Float32Array(ng), ST = run.state ? new Uint8Array(ng) : null;
    const u = run.u, hs = run.hs, co = run.coll, ro = run.roll, pi = run.pitch, ya = run.yaw, st = run.state, dOff = GT.RULES.dOff;
    for (let k = 0; k < ng; k++) {
        const i0 = k * stride;
        let su = 0, sc = 0, sx = 0, sy = 0;
        for (let i = i0; i < i0 + stride; i++) {
            su += u[i];
            if (co) sc += co[i];
            if (ro || pi) { const a = ro ? ro[i] : 0, b = pi ? pi[i] : 0; sx += Math.sqrt(a * a + b * b); }
            if (ya) sy += Math.abs(ya[i]);
        }
        U[k] = su / stride; C[k] = sc / stride; X[k] = sx / stride; Y[k] = sy / stride; HS[k] = hs[i0];
        if (V) V[k] = run.vbat[i0];
        if (I) I[k] = run.ibat[i0];
        if (ST) ST[k] = st[i0];
        RUN[k] = (u[i0] > R.runningU || hs[i0] > R.runningHs * Href) && hs[i0] >= R.restHs * Href ? 1 : 0;
        ACT[k] = RUN[k] && (st ? st[i0] === STATE_ACTIVE : hs[i0] > R.activeHs * Href && u[i0] > dOff && u[i0] < R.openLoopU) ? 1 : 0;
        T[k] = targetAt(run, i0, ACT[k], Href);
    }
    // a sample that is not finite (a decode error): the grid point is not fit data (an input or hs), or has no residual of its channel
    // (VM, IM: Vbat, Ibat); the arrays hold the last finite value, so that the start values and the static analyses stay finite
    const VM = V ? new Uint8Array(ng).fill(1) : null, IM = I ? new Uint8Array(ng).fill(1) : null;
    const hold = (a, k, m) => { if (finite(a[k])) return; a[k] = k > 0 ? a[k - 1] : 0; if (m) m[k] = 0; };
    for (let k = 0; k < ng; k++) {
        if (!(finite(U[k]) && finite(C[k]) && finite(X[k]) && finite(Y[k]) && finite(HS[k]))) { RUN[k] = ACT[k] = 0; for (const a of [U, C, X, Y, HS]) hold(a, k); }
        if (V) hold(V, k, VM); if (I) hold(I, k, IM);
    }
    // start values of the windows: centred means of hs and Vbat over ± startS (the noise of one sample at a window start would
    // bias the fit: errors in the variables). causal (validation): the end point and the slope of the least-squares lines of hs and Vbat
    // over the startS·2 before the grid point (HSS, VS at the grid point, DH, DV per s): no sample after the start point
    const HSS = new Float32Array(ng), VS = V ? new Float32Array(ng) : null, h = Math.max(1, Math.round(R.startS * run.rate));
    const DH = causal ? new Float32Array(ng) : null, DV = causal && V ? new Float32Array(ng) : null, vb = run.vbat;
    const line = (a, i0, out, dout, k) => {   // trailing least-squares line of a over [i0 − 2h, i0] (finite samples): the end point and the slope
        let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (let i = Math.max(0, i0 - 2 * h); i <= i0; i++) { const y = a[i]; if (!finite(y)) continue; const x = i - i0; n++; sx += x; sy += y; sxx += x * x; sxy += x * y; }
        const d = n * sxx - sx * sx, b = n > 2 && d > 0 ? (n * sxy - sx * sy) / d : 0;
        out[k] = n ? sy / n - b * sx / n : out[k - 1] || 0; dout[k] = b * run.rate;
    };
    for (let k = 0; k < ng; k++) {
        const i0 = k * stride;
        if (causal) {
            if (hs[i0] > 0) line(hs, i0, HSS, DH, k); else HSS[k] = DH[k] = 0;
            if (VS) line(vb, i0, VS, DV, k);
            continue;
        }
        const a = Math.max(0, i0 - h), b = Math.min(run.n - 1, i0 + h);
        let sh = 0, nh = 0, sv = 0, nv = 0; for (let i = a; i <= b; i++) { if (finite(hs[i])) { sh += hs[i]; nh++; } if (VS && finite(vb[i])) { sv += vb[i]; nv++; } }
        HSS[k] = hs[i0] > 0 && nh ? sh / nh : 0; if (VS) VS[k] = nv ? sv / nv : V[k];
    }
    // open-loop weights, with a tail after each open-loop period (the throttle at its ceiling: ceilingOf)
    const ow = Math.sqrt(R.openLoopWeight), tail = Math.round(R.openLoopTailS / dt), satU = ceilingOf(run, R);
    let last = -Infinity;
    for (let k = 0; k < ng; k++) {
        const ol = RUN[k] && ((ST && ST[k] !== STATE_ACTIVE) || U[k] >= satU || U[k] < dOff);
        if (ol) last = k;
        W[k] = k - last <= tail ? ow : 1;
    }
    // soft start per grid point on the frames, as gov_twin (RULES dOff, softHs, softOffS): an arm (throttle under dOff with the rotor
    // under softHs·Href, or for softOffS) waits for the motor start, the first frame with the throttle on and the rotor turning (hs > 0:
    // the ESC start throttle u0); the ramp starts there at the rotor speed HON (0 from rest). AGE: s since the start, −1 armed and not
    // started, −2 no soft start since the log start. OFF: the time under dOff so far. UON: the throttle at each start from rest (u0).
    // The end of a soft start (the ramp above kv·V) and the ramp itself depend on the parameters (startState, dutyOf).
    const softH = GT.RULES.softHs * Href, offS = GT.RULES.softOffS, OFF = new Float32Array(ng), AGE = new Float32Array(ng), HON = new Float32Array(ng), UON = [];
    let armed = hs[0] < softH, on = -1, hon = 0, off = 0;
    for (let i = 0, k = 0; i < ng * stride; i++) {
        const x = u[i];
        if (x < dOff) { off += 1 / run.rate; if (hs[i] < softH || off >= offS) { armed = true; on = -1; } } else off = 0;
        if (armed && on < 0 && x >= dOff && hs[i] > 0) { on = i; hon = i > 0 && hs[i - 1] > 0 ? hs[i] : 0; if (!hon) UON.push({ k: Math.floor(i / stride), u: x }); }
        if (i === k * stride) { AGE[k] = on >= 0 ? (i - on) / run.rate : armed ? -1 : -2; HON[k] = hon; OFF[k] = off; k++; }
    }
    // the first soft.skipS after a motor start from rest are not fit data: the start is seen only when hs passes the sensor floor (tens of
    // ms late), so the duty at a window start there is wrong until the rotor is at the ramp (synthetic Fireball-like plant: qf +13 %)
    for (let k = 0; k < ng; k++) if (AGE[k] >= 0 && AGE[k] < R.soft.skipS && HON[k] === 0) RUN[k] = ACT[k] = 0;
    // STEADY: the static analyses (initial values, steady-state map points) use only the grid points that are not in a possible soft
    // start, soft.horizonS after a motor start: there the ESC duty is not u (synthetic Gaui-like plant: ACTIVE right after a spool-up
    // exit at 95 % throttle is still on the ESC ramp, u·V − H/kv − R_m·I_m = 12 V, and the regression gives kv −7 %, R_m −63 %)
    const STEADY = new Uint8Array(ng); for (let k = 0; k < ng; k++) STEADY[k] = ACT[k] && !(AGE[k] >= 0 && AGE[k] < R.soft.horizonS) ? 1 : 0;
    return { run, R, key: run.log + ':' + (run.segment || 0), causal: !!causal, stride, dt, ng, U, C, X, Y, HS, V, I, VM, IM, T, RUN, ACT, STEADY, W, OFF, AGE, HON, UON, ST, HSS, VS, DH, DV,
        satU, ACC: new Float32Array(ng).fill(NaN), testFrom: ng };
}
// split (header): test logs, or the last testShare of the motor-running grid points of each run
function splitOf(runs, R, split) {
    const logs = [...new Set(runs.map(r => r.log))];
    const mode = split ? split.mode : logs.length >= R.testEvery ? 'logs' : 'tail';
    return { mode, testLogs: split ? split.testLogs || [] : mode === 'logs' ? logs.filter((l, j) => j % R.testEvery === R.testEvery - 1) : [] };
}
function applySplit(grids, R, sp) {
    const { mode, testLogs } = sp;
    for (const c of grids) {
        if (mode === 'logs') { c.testFrom = testLogs.includes(c.run.log) ? 0 : c.ng; continue; }
        let total = 0; for (let k = 0; k < c.ng; k++) total += c.RUN[k];
        let seen = 0, k = 0; for (; k < c.ng && seen < (1 - R.testShare) * total; k++) seen += c.RUN[k];
        c.testFrom = k;
    }
    return { mode, testLogs, testShare: mode === 'tail' ? R.testShare : null };
}
// motor-running stretches [k0, k1) of a grid inside [a, b)
function stretches(c, a, b) {
    const out = [];
    for (let k = a; k < b;) {
        while (k < b && !c.RUN[k]) k++;
        const k0 = k; while (k < b && c.RUN[k]) k++;
        if (k > k0) out.push([k0, k]);
    }
    return out;
}
// windows of windowS in the stretches of [a, b)
function windowsOf(c, a, b, R, test) {
    const len = Math.round(R.windowS / c.dt), min = Math.round(R.minWindowS / c.dt), out = [];
    for (const [k0, k1] of stretches(c, a, b)) {
        let k = k0;
        for (; k + len <= k1; k += len) out.push({ c, k0: k, m: len, test });
        const rest = k1 - k;
        if (rest >= min) out.push({ c, k0: k, m: rest, test });
        else if (rest > 0 && out.length && out[out.length - 1].c === c && out[out.length - 1].k0 + out[out.length - 1].m === k) out[out.length - 1].m += rest;
    }
    return out;
}
// o: { rules, Href, split, has, causal (the start estimates of the validation) }. Href (without o.Href): from the training data only
function prepare(runs, o = {}) {
    const R = o.rules || RULES, q = qualify(runs, o), sp = splitOf(q.use, R, o.split), build = (H) => H > 0 ? q.use.map(r => gridOf(r, H, q.has, R, o.causal)) : [];
    let Href = o.Href || hrefOf(q.use.filter(r => !sp.testLogs.includes(r.log))) || hrefOf(q.use), grids = build(Href), split = applySplit(grids, R, sp);
    if (!o.Href && sp.mode === 'tail' && grids.length) {
        const lim = new Map(grids.map(c => [c.run, c.testFrom * c.stride])), H = hrefOf(q.use, r => lim.get(r));
        if (H > 0 && H !== Href) { Href = H; grids = build(Href); split = applySplit(grids, R, sp); }
    }
    const train = [], test = [];
    for (const c of grids) { train.push(...windowsOf(c, 0, c.testFrom, R, false)); test.push(...windowsOf(c, c.testFrom, c.ng, R, true)); }
    const secs = (W) => W.reduce((s, w) => s + w.m * w.c.dt, 0);
    return { R, Href, has: q.has, reasons: q.reasons, grids, split, train, test, trainS: secs(train), testS: secs(test) };
}

// ---- simulation on the grid ----
const P_LOOKBACK = 1;   // s
// linear interpolation of the grid series a at the fractional grid point q (clamped to the series)
const interp = (a, q) => { const n = a.length - 1, j = Math.min(n, Math.max(0, Math.floor(q))), f = Math.min(1, Math.max(0, q - j)); return j < n ? a[j] + f * (a[j + 1] - a[j]) : a[n]; };
// least-squares slope (rpm/s) of the raw hs over ± GT.RULES.accelS around frame i (causal: over the 2·accelS before it), on the frames
// with the rotor turning (hs > 0)
function slopeAt(run, i, causal) {
    const h = Math.round(GT.RULES.accelS * run.rate), j0 = Math.max(0, i - (causal ? 2 * h : h)), j1 = causal ? i : Math.min(run.n - 1, i + h);
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = j0; j <= j1; j++) if (run.hs[j] > 0) { n++; sx += j; sy += run.hs[j]; sxx += j * j; sxy += j * run.hs[j]; }
    const d = n * sxx - sx * sx;
    return n > 2 && d > 0 ? (n * sxy - sx * sy) / d * run.rate : 0;
}
// The soft start at grid point k for parameter set p, as gov_twin: { soft, lim (−1: not started), bind (the rotor at the ramp), below
// (the rotor was under the end speed since the start), js (the grid point of the start) }. A start from rest is the data start (hs > 0,
// age 0, the ramp from 0); a restart with the rotor turning starts at the first grid point with u >= u0, the ramp from hs there. It ended
// when the ramp passed kv·V, or when the rotor reached GT.RULES.softEnd of the no-load speed kv·u·V from under it.
const NO_SOFT = { soft: false, lim: -1, bind: false, below: false, js: -1 }, WAIT = { soft: true, lim: -1, bind: false, below: false, js: -1 };
function softAt(p, c, k, H, V) {
    const age = c.AGE[k];
    if (age < -1) return NO_SOFT;
    if (age < 0) return WAIT;
    const dOff = GT.RULES.dOff, u0 = Math.max(p.u0, dOff), e = GT.RULES.softEnd * p.kv, j0 = Math.max(0, k - Math.round(age / c.dt)), rest = c.HON[k] === 0;
    let js = rest ? j0 : -1, below = false;
    for (let j = j0; j <= k; j++) {
        if (js < 0) { if (c.U[j] >= u0) js = j; else continue; }
        const at = c.U[j] >= dOff && c.HS[j] >= e * c.U[j] * (c.V ? c.V[j] : p.V0);
        if (at && below) return NO_SOFT;
        if (!at) below = true;
    }
    if (js < 0) return WAIT;
    const lim = rest ? GT.ramp(p, age, 0) : GT.ramp(p, (k - js) * c.dt, c.HS[js]);
    if (lim >= p.kv * V) return NO_SOFT;
    return { soft: true, lim, bind: lim <= H + c.R.softBind * p.Href, below, js };
}
// The start state at grid point k. The sensors (hsLog, vLog) are the centred means (HSS, VS) at k, iLog the measured value. H and V
// are the means th and tv later (the lags of the sensors), so that V0 is correct during fast voltage changes. With a causal grid (the
// validation, stateAt), only the samples up to k: the sensors are the end points of the trailing lines (HSS, VS), H and V add th and tv
// times their slopes (the inverse of the first-order sensor lag), and the acceleration and the OCV look back only. The ESC duty: with the
// rotor at a soft-start ramp the duty that gives the measured acceleration (gov_twin.initState with accel: an error in the duty stays
// for the whole soft start), before the motor start 0, else u filtered with te over the last P_LOOKBACK s (a fixed length: a length
// from te would make the cost jump), from 0 at a motor start in that time. off: the time under dOff so far.
function startState(p, c, k) {
    const dt = c.dt, u = c.U[k] > 0 ? Math.min(1, c.U[k]) : 0, H = hAt(p, c, k), V = c.V ? vAt(p, c, k) : null;
    const sf = softAt(p, c, k, H, V || p.V0);
    let d, accel = 0;
    if (sf.bind) { accel = c.ACC[k]; if (!(accel === accel)) accel = c.ACC[k] = slopeAt(c.run, k * c.stride, c.causal); }
    else if (sf.soft && sf.lim < 0) d = 0;
    else {
        // after a motor start inside the look-back, the duty rises from 0 at the start (the ESC waited for u0 with the duty 0)
        const te = p.te > GT.RULES.minTau ? p.te : GT.RULES.minTau, a = 1 - Math.exp(-dt / te), ks = sf.soft ? sf.js : -1;
        let j0 = Math.max(0, k - Math.ceil(P_LOOKBACK / dt));
        d = c.U[j0]; if (ks >= j0) { j0 = ks; d = 0; }
        for (let j = j0; j < k; j++) d += (c.U[j] - d) * a;
    }
    const x = GT.initState(p, { hs: H, u, d, vbat: V, ibat: c.I ? c.I[k] : null, stopped: sf.soft, below: sf.below, lim: sf.lim, accel, coll: c.C[k], cyc: c.X[k], yaw: c.Y[k] });
    x.hsLog = c.HSS[k]; if (c.V) x.vLog = c.VS[k]; x.off = c.OFF[k];
    const kb = Math.max(0, k - Math.round(c.R.ocvS / dt)), v0 = c.V && p.voltage && !sf.soft && !softAt(p, c, kb, c.HS[kb], c.V[kb]).soft ? ocvBefore(p, c, k) : null;
    if (v0 != null) {
        const sl = GT.slip(x.d, v0, x.H / p.kv, p.beta, p.sneg);
        x.V0 = v0; x.s = x.d < GT.RULES.dOff && !(sl > 0) ? 0 : sl; x.V = v0 - p.beta * x.d * x.s; if (p.current) x.I = x.d * x.s / p.rm + p.i0;
    }
    return x;
}
// the rotor speed H and the battery voltage V at grid point k: the start values th and tv later (the sensor lags), or with a causal grid
// the trailing end point plus th (tv) times its slope
const hAt = (p, c, k) => c.causal ? Math.max(0, c.HSS[k] + p.th * c.DH[k]) : interp(c.HSS, k + p.th / c.dt);
const vAt = (p, c, k) => c.causal ? c.VS[k] + p.tv * c.DV[k] : interp(c.VS, k + p.tv / c.dt);
// the OCV at grid point k: the mean of vbat + beta·d·s over the ocvS before k (vbat and hs read tv and th later, the duty u with the lag
// te from P_LOOKBACK earlier). Not used in a soft start (startState): the duty there is not u with a lag. null without data
function ocvBefore(p, c, k) {
    const dt = c.dt, nb = Math.round(c.R.ocvS / dt), lb = Math.ceil(P_LOOKBACK / dt), dOff = GT.RULES.dOff;
    if (!(nb > 0) || c.AGE[k] >= 0 && c.HON[k] === 0 && c.AGE[k] < c.R.ocvS + P_LOOKBACK) return null;
    const a = 1 - Math.exp(-dt / Math.max(p.te, GT.RULES.minTau)), j1 = Math.max(0, k - nb);
    let j = Math.max(0, j1 - lb), d = c.U[j], sum = 0, n = 0;
    for (; j <= k; j++) {
        if (j >= j1) {
            const V = vAt(p, c, j), e = hAt(p, c, j) / p.kv;
            sum += d < dOff ? V : V + p.beta * d * Math.max(d * V - e, -p.sneg); n++;
        }
        d += (c.U[j] - d) * a;
    }
    return n ? sum / n : null;
}
// the ESC duty on the grid points 0..K-1: 0 before a motor start, the duty of the measured acceleration (±0.05 s) with the rotor at a
// soft-start ramp (softAt), else u with the lag te
function dutyOf(p, c, K) {
    const d = new Float32Array(K), a = 1 - Math.exp(-c.dt / Math.max(p.te, GT.RULES.minTau)), h = Math.max(1, Math.round(0.05 / c.dt));
    let x = 0;
    for (let k = 0; k < K; k++) {
        const u = c.U[k] > 0 ? Math.min(1, c.U[k]) : 0, H = c.HS[k], V = c.V ? c.V[k] : p.V0, sf = softAt(p, c, k, H, V);
        if (sf.soft && sf.lim < 0) x = 0;
        else if (sf.bind) {
            const j0 = Math.max(0, k - h), j1 = Math.min(c.ng - 1, k + h), acc = (c.HS[j1] - c.HS[j0]) / ((j1 - j0) * c.dt);
            x = Math.min(u, Math.max(0, (H / p.kv + GT.load(p, H, c.C[k], c.X[k], c.Y[k]) + Math.max(p.tm, GT.RULES.minTau) * acc / p.kv) / V));
        }
        d[k] = x;
        x += (u - x) * a;
    }
    return d;
}
const INP = { u: 0, coll: 0, cyc: 0, yaw: 0 };
// One gov_twin step, split at the time where the ESC duty crosses dOff. The twin switches between coast and drive at dOff (at the
// mid-step duty), so an unsplit step puts the switch on the grid, and the cost jumps when te moves the crossing over a grid point.
// The duty path in a step is exponential (lag te), so the crossing time is exact. Not in a soft start: its ramp sets the duty.
function stepSplit(x, inp, p, dt) {
    const dOff = GT.RULES.dOff, ds = inp.u > 0 ? (inp.u < 1 ? inp.u : 1) : 0, d0 = x.d;
    let t = 0;
    if (!x.soft && (d0 < dOff) !== (ds < dOff) && d0 !== ds) {
        const te = p.te > GT.RULES.minTau ? p.te : GT.RULES.minTau, q = (d0 - ds) / (dOff - ds);
        if (q > 1) { const tc = te * Math.log(q); if (tc < dt) t = tc; }
    }
    if (t > 1e-9 && t < dt - 1e-9) { GT.step(x, inp, p, t); return GT.step(x, inp, p, dt - t); }
    return GT.step(x, inp, p, dt);
}
// m outputs from grid point k0 (output j: the state at k0 + j, before its step) into o.h (and o.v, o.i)
function simGrid(p, c, k0, m, o, x0) {
    const x = x0 || startState(p, c, k0), h = o.h, v = p.voltage ? o.v : null, cur = p.current ? o.i : null, dt = c.dt;
    for (let j = 0; j < m; j++) {
        h[j] = x.hsLog; if (v) v[j] = x.vLog; if (cur) cur[j] = x.iLog;
        if (j === m - 1) break;
        const k = k0 + j; INP.u = c.U[k]; INP.coll = c.C[k]; INP.cyc = c.X[k]; INP.yaw = c.Y[k];
        stepSplit(x, INP, p, dt);
    }
    return x;
}
const buffers = (m) => ({ h: new Float64Array(m), v: new Float64Array(m), i: new Float64Array(m) });
const channels = (has) => 1 + (has.voltage ? 1 : 0) + (has.current ? 1 : 0);
// residual vector of the windows W (weights mult: the bootstrap count) for parameter set p
function residualsInto(p, W, mult, has, Href, R, out, buf) {
    const sh = 1 / (R.sigma.hs * Href), sv = 1 / R.sigma.v, si = 1 / R.sigma.i;
    let o = 0;
    for (let w = 0; w < W.length; w++) {
        const { c, k0, m } = W[w], mw = mult ? Math.sqrt(mult[w]) : 1;
        simGrid(p, c, k0, m, buf);
        for (let j = 0; j < m; j++) {
            const k = k0 + j, wt = c.W[k] * mw;
            out[o++] = wt * (buf.h[j] - c.HS[k]) * sh;
            if (has.voltage) out[o++] = c.VM[k] ? wt * (buf.v[j] - c.V[k]) * sv : 0;
            if (has.current) out[o++] = c.IM[k] ? wt * (buf.i[j] - c.I[k]) * si : 0;
        }
    }
    return out;
}

// ---- initial values (no LM) ----
// 1-s blocks of ACTIVE grid points out of a soft start (all points of the block STEADY), with lag-shifted V and I
function activeBlocks(grids, R, fn) {
    for (const c of grids) {
        const B = Math.round(R.kv.blockS / c.dt), lv = Math.round(R.kv.vLagS / c.dt), li = Math.round(R.kv.iLagS / c.dt);
        for (let k = 0; k + B + Math.max(lv, li) < c.testFrom; k += B) {
            let ok = true; for (let j = k; j < k + B && ok; j++) ok = c.STEADY[j] === 1;
            if (ok) fn(c, k, B, lv, li);
        }
    }
}
// high-pass (minus the centred moving mean of hpS) regression slope of y on x over the motor-running training grid points
function hpSlope(grids, R, yOf, xOf) {
    let sxy = 0, sxx = 0, n = 0;
    for (const c of grids) {
        const h = Math.round(R.init.hpS / c.dt / 2), K = c.testFrom, y = new Float64Array(K), x = new Float64Array(K);
        for (let k = 0; k < K; k++) { y[k] = yOf(c, k); x[k] = xOf(c, k); }
        const cy = new Float64Array(K + 1), cx = new Float64Array(K + 1);
        for (let k = 0; k < K; k++) { cy[k + 1] = cy[k] + y[k]; cx[k + 1] = cx[k] + x[k]; }
        for (let k = h; k + h < K; k++) {
            let ok = true; for (let j = k - h; j <= k + h && ok; j += 10) ok = c.RUN[j] === 1 && c.U[j] >= GT.RULES.dOff && !(c.AGE[j] >= 0 && c.AGE[j] < R.soft.horizonS);
            if (!ok || !finite(y[k]) || !finite(x[k])) continue;
            const a = y[k] - (cy[k + h + 1] - cy[k - h]) / (2 * h + 1), b = x[k] - (cx[k + h + 1] - cx[k - h]) / (2 * h + 1);
            sxy += a * b; sxx += b * b; n++;
        }
    }
    return n > 100 && sxx > 0 ? sxy / sxx : null;
}
function initial(P) {
    const R = P.R, has = P.has, Href = P.Href, grids = P.grids;
    const Vat = (c, k, lv) => has.voltage ? c.V[Math.min(c.ng - 1, k + lv)] : 1, reg = {};
    // kv: 1.02 x p99.5 of the block ratio hs / (u·V(t + lag)) in ACTIVE (critique C2: a lower bound)
    const ratios = [];
    activeBlocks(grids, R, (c, k, B, lv) => {
        let h = 0, uv = 0; for (let j = k; j < k + B; j++) { h += c.HS[j]; uv += c.U[j] * Vat(c, j, lv); }
        if (uv > 0) ratios.push(h / uv);
    });
    reg.kvBlocks = ratios.length;
    reg.kvRatio = ratios.length >= R.kv.minBlocks ? R.kv.factor * quantile(ratios, R.kv.q) : null;
    let kv = reg.kvRatio;
    if (!(kv > 0)) { const all = []; for (const c of grids) for (let k = 0; k < c.testFrom; k += 10) if (c.RUN[k] && c.U[k] > 0.1) all.push(c.HS[k] / (c.U[k] * Vat(c, k, 0))); kv = R.kv.factor * (quantile(all, R.kv.q) || 1000); }
    // i0: the median current with the ESC output off (u < dOff)
    let i0 = null;
    if (has.current) { const off = []; for (const c of grids) for (let k = 0; k < c.testFrom; k++) if (c.U[k] < GT.RULES.dOff && finite(c.I[k])) off.push(c.I[k]); i0 = off.length >= 50 ? median(off) : null; reg.i0 = i0; }
    // with current: u·V = H/kv + R_m·(I − i0)/u, then R0 from the high-pass V on I, beta = R0/R_m
    let rm = null, beta = R.init.beta;
    if (has.current) {
        const y = [], xh = [], xi = [];
        activeBlocks(grids, R, (c, k, B, lv, li) => {
            let a = 0, h = 0, q = 0; for (let j = k; j < k + B; j++) { a += c.U[j] * c.V[j + lv]; h += c.HS[j]; q += (c.I[Math.min(c.ng - 1, j + li)] - (i0 || 0)) / c.U[j]; }
            y.push(a / B); xh.push(h / B); xi.push(q / B);
        });
        const z = y.length >= R.kv.minBlocks ? lsq([xh, xi], y, [0, 1]) : null;
        if (z && z[0] > 0 && z[1] > 0) { reg.kvCurrent = 1 / z[0]; reg.Rm = z[1]; kv = reg.kvCurrent; rm = z[1]; }
        const s = hpSlope(grids, R, (c, k) => c.V[Math.min(c.ng - 1, k + Math.round(R.kv.vLagS / c.dt))], (c, k) => c.I[Math.min(c.ng - 1, k + Math.round(R.kv.iLagS / c.dt))]);
        if (s != null && s < 0) reg.R0 = -s;
        if (reg.R0 > 0 && rm > 0) { reg.betaCurrent = reg.R0 / rm; beta = reg.betaCurrent; }
    }
    // static beta without current (biased low, models 4.2): high-pass V on u·s, s = u·V − H/kv
    if (has.voltage) {
        const lvOf = (c) => Math.round(R.kv.vLagS / c.dt);
        const s = hpSlope(grids, R, (c, k) => c.V[Math.min(c.ng - 1, k + lvOf(c))], (c, k) => { const v = c.V[Math.min(c.ng - 1, k + lvOf(c))]; return c.U[k] * (c.U[k] * v - c.HS[k] / kv); });
        reg.betaStatic = s != null ? -s : null;
    }
    // loads: NNLS of the steady slip on the load features in ACTIVE blocks, for each collective exponent and offset of the grid
    const tm0 = R.init.tm;
    let best = null;
    for (const pc of R.init.pc) for (const c0 of R.init.c0) {
        const y = [], F = [[], [], [], [], [], []];
        activeBlocks(grids, R, (c, k, B, lv) => {
            let s = 0; const f = [0, 0, 0, 0, 0, 0];
            for (let j = k; j < k + B; j++) {
                const n = c.HS[j] / Href, n2 = n * n;
                s += c.U[j] * Vat(c, j, lv) - c.HS[j] / kv;
                f[0] += n2; f[1] += n2 * Math.pow(Math.abs(c.C[j] - c0), pc); f[2] += n2 * c.X[j]; f[3] += n2 * c.Y[j]; f[4] += n; f[5] += 1;
            }
            y.push(s / B - tm0 * (c.HS[k + B - 1] - c.HS[k]) / ((B - 1) * c.dt) / kv); f.forEach((v, j) => F[j].push(v / B));
        });
        if (y.length < R.kv.minBlocks) break;
        const q = nnls(F, y);
        let ss = 0; for (let i = 0; i < y.length; i++) { let e = y[i]; for (let j = 0; j < 6; j++) e -= F[j][i] * q[j]; ss += e * e; }
        if (!best || ss < best.ss) best = { pc, c0, q, ss, n: y.length };
    }
    // ESC soft start (RULES.fixed): u0 the median throttle at the motor starts from rest (the first frame with the rotor turning), the
    // ramp (as0, as1, asr, ass) from softRamp (start values; softFit gives the values)
    const starts = []; for (const c of grids) for (const q of c.UON) if (q.k < c.testFrom) starts.push(q.u);
    const sr = softRamp(P, kv, Vat);
    reg.u0Starts = starts; reg.softStart = sr;
    const V0 = has.voltage ? median(grids.flatMap(c => { const a = []; for (let k = 0; k < c.testFrom; k += 10) if (c.RUN[k]) a.push(c.V[k]); return a; })) : undefined;
    const p = GT.copy(GT.defaults({ kv, Href, V0, current: has.current }), {
        tm: tm0, te: R.init.te, th: R.init.th, tv: R.init.tv, ti: R.init.ti, beta: has.voltage ? beta : 0,
        u0: starts.length ? median(starts) : R.init.u0, ass: sr.fit ? sr.fit.ass : R.init.ass, asr: sr.fit ? sr.fit.asr : 20, as0: sr.fit ? sr.fit.as0 : 0, as1: sr.fit ? sr.fit.as1 : 0,
    });
    if (best) { const q = best.q; Object.assign(reg, { pc: best.pc, c0: best.c0, loadBlocks: best.n }); p.pc = best.pc; p.c0 = best.c0; p.q0 = q[0]; p.qc = q[1]; p.qx = q[2]; p.qy = q[3]; p.qf = q[4]; p.qs = q[5]; }
    if (rm > 0) p.rm = rm;
    if (i0 != null) p.i0 = i0;
    for (const s of GT.PARAMS) if (finite(p[s.name])) p[s.name] = Math.min(s.hi, Math.max(s.lo, p[s.name]));
    if (has.voltage) p.kappa = kappaOf(p, P).value;
    return { p: GT.copy(p), regression: reg };
}

// ESC soft start from the motor starts from rest in the training data: the samples (age, hs) at the grid points every soft.everyS
// while the soft start lasts (hs under GT.RULES.softEnd of the no-load speed kv·u·V, as gov_twin) and hs under soft.top·Href, fitted with
// gov_twin.ramp (as0, as1, asr, ass) by lm, on all starts together and on each start alone (the spread). -> { starts, samples, fit, rms,
// each: [{ as0, asr, ass, rms }] }; fit null without starts
function softRamp(P, kv, Vat) {
    const R = P.R, S = R.soft, Href = P.Href, starts = [];
    for (const c of P.grids) {
        const every = Math.max(1, Math.round(S.everyS / c.dt));
        for (let k = 0; k < c.testFrom; k++) {
            if (!(c.AGE[k] >= 0 && (k === 0 || c.AGE[k - 1] < 0) && c.HON[k] === 0)) continue;
            const a = [], h = [];
            for (let j = k; j < c.testFrom && (j === k || c.AGE[j] > c.AGE[j - 1]); j++) {
                const H = c.HS[j];
                if (H >= S.top * Href || GT.RULES.softEnd * kv * c.U[j] * Vat(c, j, 0) <= H) break;
                if ((j - k) % every === 0) { a.push(c.AGE[j]); h.push(H); }
            }
            if (a.length >= S.minSamples) starts.push({ a, h });
        }
    }
    const fitOf = (list) => {
        const a = list.flatMap(q => q.a), h = list.flatMap(q => q.h), sc = 1 / (S.sigma * Href);
        const r0 = Math.max(1, median(list.map(q => (q.h[q.h.length - 1] - q.h[0]) / Math.max(q.a[q.a.length - 1] - q.a[0], 0.1))));
        const z0 = [Math.log(r0), Math.log(0.5), median(list.map(q => q.h[0])), 0.25 * r0];
        const f = (z, out) => { const p = { ass: Math.exp(z[0]), asr: Math.exp(z[1]), as0: z[2], as1: z[3] }; for (let i = 0; i < a.length; i++) out[i] = (GT.ramp(p, a[i], 0) - h[i]) * sc; return out; };
        const res = lm(f, z0, { n: a.length, lo: [Math.log(GT.PARAM.ass.lo), Math.log(GT.PARAM.asr.lo), 0, 0], hi: [Math.log(GT.PARAM.ass.hi), Math.log(GT.PARAM.asr.hi), S.top * Href, GT.PARAM.as1.hi],
            steps: [1e-4, 1e-4, 1e-3 * Href, 1e-3 * r0], iterations: 50, tolerance: 1e-6 });
        return { ass: Math.exp(res.z[0]), asr: Math.exp(res.z[1]), as0: res.z[2], as1: res.z[3], rms: Math.sqrt(res.cost / a.length) / sc };
    };
    if (!starts.length) return { starts: 0, samples: 0, fit: null, each: [] };
    return { starts: starts.length, samples: starts.reduce((s, q) => s + q.a.length, 0), fit: fitOf(starts), each: starts.map(q => fitOf([q])) };
}

// ESC soft start by output error (the values of the model): each motor start from rest in the training data (UON), simulated with the
// twin p on the recorded throttle from soft.preS before the start (the rotor at rest, the ESC waiting for u0) to soft.exitS after the
// SPOOLUP exit (else soft.horizonS), against hs (sigma soft.sigma·Href). Free: ass, asr, as0, as1, from the values of p (softRamp); u0 stays
// the measured start throttle (the start time is on the grid, so the cost is flat in u0). All starts together, and each start alone
// (the spread). -> { starts, samples, fit: { ass, asr, as0, rms (rpm) } | null, each: [{ ass, asr, as0, rms }] }
function softFit(p, P, zero = []) {
    const S = P.R.soft, Href = P.Href, list = [];
    for (const c of P.grids) for (const q of c.UON) {
        if (q.k >= c.testFrom) continue;
        let k0 = q.k; for (const lim = Math.max(0, q.k - Math.round(S.preS / c.dt)); k0 > lim && !(c.HS[k0 - 1] > 0); ) k0--;
        let k1 = q.k, end = Math.min(c.testFrom, c.ng, q.k + Math.round(S.horizonS / c.dt));
        if (c.ST) { while (k1 < end && !(c.ST[k1] === STATE_ACTIVE && k1 > 0 && c.ST[k1 - 1] !== STATE_ACTIVE)) k1++; if (k1 < end) end = Math.min(end, k1 + Math.round(S.exitS / c.dt)); }
        if (end - k0 >= S.minSamples) list.push({ c, k0, m: end - k0 });
    }
    if (!list.length) return { starts: 0, samples: 0, fit: null, each: [] };
    const sc = 1 / (S.sigma * Href), buf = buffers(list.reduce((a, w) => Math.max(a, w.m), 1));
    const sim = (q, w) => {
        const c = w.c, x0 = GT.initState(q, { hs: 0, u: c.U[w.k0], vbat: c.V ? c.VS[w.k0] : null, ibat: c.I ? c.I[w.k0] : null, stopped: true, lim: -1, d: 0 });
        x0.off = c.OFF[w.k0]; return simGrid(q, c, w.k0, w.m, buf, x0);
    };
    // from the start values of p, and from the same values without as1 (as0, as1 and asr trade off: the better of the two fits)
    const fitOf = (W) => { const a = fitFrom(W, p), b = p.as1 > 0 ? fitFrom(W, GT.copy(p, { as1: 0 })) : a; return b.cost < a.cost ? b : a; }, as1Hi = zero.includes('as1') ? 0 : GT.PARAM.as1.hi;
    const fitFrom = (W, p) => {
        const N = W.reduce((a, w) => a + w.m, 0), base = GT.copy(p, { as0: Math.max(p.as0, 0.02 * Href), asr: p.as0 > 0 || p.as1 > 0 ? p.asr : 1 });
        const f = (z, out) => {
            const q = GT.copy(base, { ass: Math.exp(z[0]), asr: Math.exp(z[1]), as0: z[2], as1: z[3] });
            let o = 0; for (const w of W) { sim(q, w); for (let j = 0; j < w.m; j++) out[o++] = (buf.h[j] - w.c.HS[w.k0 + j]) * sc; }
            return out;
        };
        const res = lm(f, [Math.log(base.ass), Math.log(base.asr), base.as0, base.as1], { n: N, lo: [Math.log(GT.PARAM.ass.lo), Math.log(GT.PARAM.asr.lo), 0, 0],
            hi: [Math.log(GT.PARAM.ass.hi), Math.log(GT.PARAM.asr.hi), S.top * Href, as1Hi], steps: [1e-3, 1e-3, 1e-3 * Href, 1e-3 * base.ass], huber: P.R.huber, iterations: S.iterations, tolerance: 1e-6 });
        return { ass: Math.exp(res.z[0]), asr: Math.exp(res.z[1]), as0: res.z[2], as1: res.z[3], rms: Math.sqrt(res.cost / N) / sc, cost: res.cost };
    };
    return { starts: list.length, samples: list.reduce((a, w) => a + w.m, 0), fit: fitOf(list), each: list.map(w => fitOf([w])) };
}

// kappa: OCV = vbat + beta·d·s on Q = ∫ d·s dt, a common slope and an intercept for each run (1-s block means of the
// motor-running training grid points; d from dutyOf, s = d·V − H/kv from the measured values, >= −sneg, 0 under dOff)
function kappaOf(p, P) {
    if (!P.has.voltage) return { value: 0, se: null, blocks: 0 };
    const R = P.R, dOff = GT.RULES.dOff;
    let sxy = 0, sxx = 0, syy = 0, n = 0, groups = 0;
    const means = [];
    for (const c of P.grids) {
        const B = Math.round(R.kv.blockS / c.dt), lv = Math.round(p.tv / c.dt), K = c.testFrom - lv, d = dutyOf(p, c, Math.max(0, K)), qs = [], os = [];
        let Q = 0, bq = 0, bo = 0, bn = 0;
        for (let k = 0; k < K; k++) {
            const v = c.V[k + lv], dk = d[k], s = dk < dOff ? 0 : Math.max(dk * v - c.HS[k] / p.kv, -p.sneg);
            if (c.RUN[k] && dk >= dOff) { bq += Q; bo += v + p.beta * dk * s; bn++; }
            Q += dk * s * c.dt;
            if (bn >= B) { qs.push(bq / bn); os.push(bo / bn); bq = bo = bn = 0; }
        }
        if (qs.length < 3) continue;
        const mq = qs.reduce((a, b) => a + b) / qs.length, mo = os.reduce((a, b) => a + b) / os.length;
        for (let j = 0; j < qs.length; j++) { sxy += (qs[j] - mq) * (os[j] - mo); sxx += (qs[j] - mq) ** 2; syy += (os[j] - mo) ** 2; }
        n += qs.length; groups++;
        const pre = []; for (let k = 0; k < c.testFrom && !c.RUN[k]; k++) pre.push(c.V[k]);
        means.push({ mq, mo, rest: pre.length >= 10 ? median(pre) : null });
    }
    if (!(sxx > 0) || n < groups + 3) return { value: p.kappa, se: null, blocks: n };
    const slope = sxy / sxx, s2 = Math.max(0, syy - slope * sxy) / (n - groups - 1);
    // the rest voltage before each flight less the OCV of the regression at Q = 0: the polarization that an R0-only battery does not
    // model (a whole-flight simulation from the rest voltage is too high by about this voltage)
    const off = means.filter(q => q.rest != null).map(q => q.rest - (q.mo - slope * q.mq));
    return { value: Math.min(GT.PARAM.kappa.hi, Math.max(0, -slope)), se: Math.sqrt(s2 / sxx), blocks: n, flights: groups,
        restOffset: off.length ? { median: median(off), min: Math.min(...off), max: Math.max(...off), each: off } : null };
}
// the rest offset vp of the twin (gov_twin) from kappaOf: the median rest offset, in the bounds of vp (0 without data)
const vpOf = (k) => k && k.restOffset ? Math.min(GT.PARAM.vp.hi, Math.max(0, k.restOffset.median)) : 0;
// the held values of a parameter set from the regressions: kappa and vp (voltage only)
function heldOf(q, P) { const k = kappaOf(q, P); return { kap: k, p: GT.copy(q, P.has.voltage ? { kappa: k.value, vp: vpOf(k) } : {}) }; }

// ---- identification ----
function freeNames(has, o, R) {
    const fixed = new Set(R.fixed.concat(o.fixed || []));
    return (o.free || GT.paramNames(has)).filter(k => !fixed.has(k));
}
function fitWindows(p0, names, W, mult, P, o) {
    const R = P.R, ch = channels(P.has), N = W.reduce((s, w, j) => s + (mult && !mult[j] ? 0 : w.m * ch), 0);
    const use = mult ? W.filter((w, j) => mult[j]) : W, mu = mult ? mult.filter(x => x) : null;
    const maxM = W.reduce((a, w) => Math.max(a, w.m), 1), buf = buffers(maxM);
    const lo = names.map(k => GT.PARAM[k].scale === 'log' ? Math.log(GT.PARAM[k].lo) : GT.PARAM[k].lo);
    const hi = names.map(k => GT.PARAM[k].scale === 'log' ? Math.log(GT.PARAM[k].hi) : GT.PARAM[k].hi);
    const z0 = GT.encode(p0, names), steps = names.map((k, j) => GT.PARAM[k].scale === 'log' ? R.lm.step : R.lm.step * Math.max(Math.abs(z0[j]), 0.01 * (hi[j] - lo[j])));
    const f = (z, out) => residualsInto(GT.decode(z, names, p0), use, mu, P.has, P.Href, R, out, buf);
    const res = lm(f, z0, { n: N, lo, hi, steps, huber: R.huber, iterations: o.iterations, tolerance: R.lm.tolerance, lambda: R.lm.lambda, progress: o.progress });
    return Object.assign(res, { p: GT.decode(res.z, names, p0), n: N });
}
// the fit cost (sum of the pseudo-Huber terms) of parameter set p on the windows W (default: the training windows of P)
function fitCost(p, P, W = P.train) {
    const out = new Float64Array(W.reduce((s, w) => s + w.m * channels(P.has), 0)), buf = buffers(W.reduce((a, w) => Math.max(a, w.m), 1));
    residualsInto(p, W, null, P.has, P.Href, P.R, out, buf);
    let c = 0; for (const r of out) c += huberSq(r, P.R.huber); return c;
}
// bootstrap blocks: consecutive training windows of one run, about blockS each
function blocksOf(W, R) {
    const out = []; let cur = null, s = 0;
    W.forEach((w, j) => {
        if (!cur || w.c !== W[cur[cur.length - 1]].c || s >= R.blockS) { cur = []; out.push(cur); s = 0; }
        cur.push(j); s += w.m * w.c.dt;
    });
    return out;
}
const SUMMARY = (vals) => ({ p5: quantile(vals, 0.05), p50: quantile(vals, 0.5), p95: quantile(vals, 0.95) });

function identify(runs, opts = {}) {
    const t0 = Date.now(), R = opts.rules || RULES, progress = opts.progress || (() => {});
    const P = prepare(runs, { rules: R, Href: opts.Href, split: opts.split });
    const model = { status: 'failed', reasons: P.reasons.slice(), Href: P.Href, has: P.has, split: P.split, rules: R };
    if (!P.has.voltage) model.reasons.push(TEXT.noVoltage); else if (!P.has.current) model.reasons.push(TEXT.noCurrent);
    if (!(P.Href > 0) || P.trainS < R.minDataS) { model.reasons.push(TEXT.noData(P.trainS || 0, R.minDataS)); return model; }
    if (!P.test.length) model.reasons.push(TEXT.noTest);
    progress(0.02, 'initial values');
    // opts.zero: parameters at 0 and held (an ablation of a model term: qs, as1)
    const zero = opts.zero || [], ini = initial(P), names = freeNames(P.has, opts, R).filter(k => !zero.includes(k)), t1 = Date.now();
    if (zero.length) ini.p = GT.copy(ini.p, Object.fromEntries(zero.map(k => [k, 0])));
    const iters = opts.iterations != null ? opts.iterations : R.lm.iterations, held = new Set(R.fixed.concat(opts.fixed || []));
    // the ESC soft start by output error (softFit) with the start values, again after the first LM pass (the loads and kv of the fit)
    const soft = (q) => { const sf = held.has('ass') ? softFit(q, P, zero) : null; return { sf, p: sf && sf.fit ? GT.copy(q, { ass: sf.fit.ass, asr: sf.fit.asr, as0: sf.fit.as0, as1: sf.fit.as1 }) : q }; };
    let sf = soft(ini.p);
    const failed = () => { model.reasons.push(TEXT.fitFail); return model; };
    let fit = fitWindows(sf.p, names, P.train, null, P, { iterations: iters, progress: (it) => progress(0.05 + 0.3 * it / iters, 'fit') });
    if (!finite(fit.cost)) return failed();
    sf = soft(fit.p);
    // kappa from the fitted beta and kv, then a second LM pass with that kappa (the windows use kappa, the regression uses beta)
    if (P.has.voltage || sf.sf) {
        const first = fit;
        fit = fitWindows(GT.copy(sf.p, { kappa: P.has.voltage ? kappaOf(sf.p, P).value : 0 }), names, P.train, null, P, { iterations: iters, progress: (it) => progress(0.35 + 0.1 * it / iters, 'fit') });
        fit.history = first.history.concat(fit.history.slice(1)); fit.evaluations += first.evaluations; fit.iterations += first.iterations;
        if (!finite(fit.cost)) return failed();
    }
    const fin = heldOf(fit.p, P), kap = fin.kap;
    let p = fin.p;
    const t2 = Date.now();
    // block bootstrap from the main fit (the spread inside the flights), and the leave-one-flight-out refits (the spread between the
    // flights: other training flights move kv, qs, qf and as1 outside the bootstrap range on the Fireball)
    const nb = opts.bootstrap != null ? opts.bootstrap : R.bootstrap, blocks = blocksOf(P.train, R), rand = rng(R.seed), samples = [];
    const trainLogs = [...new Set(P.train.map(w => w.c.run.log))], J = R.jackknife, nj = nb > 0 && trainLogs.length >= J.minLogs ? trainLogs.length : 0, total = nb + nj;
    for (let b = 0; b < nb && blocks.length > 1; b++) {
        const mult = new Float64Array(P.train.length);
        for (let q = 0; q < blocks.length; q++) for (const j of blocks[Math.floor(rand() * blocks.length)]) mult[j]++;
        samples.push(heldOf(fitWindows(p, names, P.train, mult, P, { iterations: R.bootIterations }).p, P).p);
        progress(0.45 + 0.5 * (b + 1) / total, 'bootstrap');
    }
    const jack = [];
    for (let b = 0; b < nj; b++) {
        const mult = Float64Array.from(P.train, w => w.c.run.log === trainLogs[b] ? 0 : 1);
        jack.push(heldOf(fitWindows(p, names, P.train, mult, P, { iterations: J.iterations }).p, P).p);
        progress(0.45 + 0.5 * (nb + b + 1) / total, 'bootstrap');
    }
    // the jackknife spread (fit space): se² = (n − 1)/n·Σ(z_i − z̄)², the interval ± z90·se, and the pseudo-sets ẑ + √(n − 1)·(z_i − z̄)
    // (the jackknife variance) as samples for the robust tuning
    const jn = names.concat(P.has.voltage ? ['kappa', 'vp'] : []), jz = jack.map(q => GT.encode(q, jn)), z0 = GT.encode(p, jn), jstat = {};
    if (jz.length >= J.minLogs) {
        const n = jz.length, mean = z0.map((_, a) => jz.reduce((s, z) => s + z[a], 0) / n), inf = Math.sqrt(n - 1);
        jn.forEach((k, a) => {
            const se = Math.sqrt((n - 1) / n * jz.reduce((s, z) => s + (z[a] - mean[a]) ** 2, 0)), dec = (z) => GT.PARAM[k].scale === 'log' ? Math.exp(z) : z;
            const lo = GT.PARAM[k].scale === 'log' ? Math.log(GT.PARAM[k].lo) : GT.PARAM[k].lo, hi = GT.PARAM[k].scale === 'log' ? Math.log(GT.PARAM[k].hi) : GT.PARAM[k].hi;
            jstat[k] = { lo: dec(Math.max(lo, z0[a] - J.z90 * se)), hi: dec(Math.min(hi, z0[a] + J.z90 * se)), flights: n, values: jz.map(z => dec(z[a])) };
        });
        for (const z of jz) samples.push(GT.decode(z0.map((v, a) => { const q = GT.PARAM[jn[a]], lo = q.scale === 'log' ? Math.log(q.lo) : q.lo, hi = q.scale === 'log' ? Math.log(q.hi) : q.hi;
            return Math.min(hi, Math.max(lo, v + inf * (z[a] - mean[a]))); }), jn, p));
    }
    const t3 = Date.now(), uncertainty = {};
    const imax = Math.max(...fit.info), boots = samples.slice(0, samples.length - (jz.length >= J.minLogs ? jz.length : 0));
    // p5-p95: the wider of the bootstrap quantiles and the jackknife interval (source: which one gives each bound)
    for (const k of names.concat(P.has.voltage ? ['kappa', 'vp'] : [])) {
        const j = names.indexOf(k), b = boots.length ? SUMMARY(boots.map(s => s[k])) : null, q = jstat[k];
        const u = { value: p[k], unit: GT.PARAM[k].unit, informed: k === 'vp' ? !!(kap.restOffset && kap.restOffset.each.length) : j < 0 ? kap.se != null : fit.info[j] > R.lm.informed * imax };
        if (b) Object.assign(u, b, { bootstrap: { p5: b.p5, p95: b.p95 } });
        if (q) Object.assign(u, { flights: { lo: q.lo, hi: q.hi, n: q.flights, values: q.values }, p5: b ? Math.min(b.p5, q.lo) : q.lo, p95: b ? Math.max(b.p95, q.hi) : q.hi,
            source: b && b.p5 <= q.lo && b.p95 >= q.hi ? 'bootstrap' : 'flights' });
        uncertainty[k] = u;
    }
    // the measured ESC soft start: the spread over the motor starts from rest (each start fitted alone)
    const reg = ini.regression, ss = sf.sf && sf.sf.fit ? sf.sf : reg.softStart;
    for (const [k, m] of [['ass', ss.each.map(q => q.ass)], ['asr', ss.each.map(q => q.asr)], ['as0', ss.each.map(q => q.as0)], ['as1', ss.each.map(q => q.as1)], ['u0', reg.u0Starts]])
        uncertainty[k] = Object.assign({ value: p[k], unit: GT.PARAM[k].unit, informed: m.length > 0, starts: m.length }, m.length ? SUMMARY(m) : {});
    const phys = GT.physical(p), physical = phys && { value: phys };
    if (P.has.voltage && kap.restOffset) Object.assign(uncertainty.vp, SUMMARY(kap.restOffset.each), { flights: { n: kap.restOffset.each.length, values: kap.restOffset.each } });
    if (phys && samples.length) { physical.range = {}; for (const k of Object.keys(phys)) physical.range[k] = SUMMARY(samples.map(s => GT.physical(s)[k])); }
    reg.physical = reg.Rm > 0 ? { kv: reg.kvCurrent, Rm: reg.Rm, R0: reg.R0 || null, beta: reg.betaCurrent || null } : null;
    Object.assign(model, {
        status: 'identified', params: p, initial: ini.p, free: names, uncertainty, samples, kappa: kap, physical, regression: reg,
        softStart: { ass: p.ass, asr: p.asr, as0: p.as0, as1: p.as1, u0: p.u0, starts: ss.starts, samples: ss.samples, rms: ss.fit ? ss.fit.rms : null, informed: !!ss.fit,
            method: ss === reg.softStart ? 'ramp' : 'output error', ramp: reg.softStart.fit },
        fit: { cost0: fit.history[0], cost: fit.cost, iterations: fit.iterations, evaluations: fit.evaluations, stop: fit.stop, residuals: fit.n,
            windows: { train: P.train.length, test: P.test.length }, trainS: P.trainS, testS: P.testS, history: fit.history },
        bootstrap: { n: boots.length, blocks: blocks.length, flights: jz.length >= J.minLogs ? jz.length : 0, iterations: R.bootIterations, flightIterations: J.iterations },
        timing: { initS: (t1 - t0) / 1000, fitS: (t2 - t1) / 1000, bootstrapS: (t3 - t2) / 1000, totalS: (t3 - t0) / 1000 },
    });
    progress(1, 'done');
    return model;
}

// ---- validation (test data of model.split) ----
// the prepared test data of a model, with the causal start estimates (startState: no sample after a start point)
const prepOf = (model, runs, o) => o.prepared || prepare(runs, { rules: model.rules || RULES, Href: model.Href, split: model.split, has: model.has, causal: true });
// The twin state at frame i of a run, estimated as in the validation (causal: from the samples up to i): the soft start from the motor
// start, the duty through te over the last second, the OCV from the 0.5 s before, H and V from trailing lines and the sensor lags.
// -> { x (a gov_twin state), i (its frame: the fit grid point at or before i), stride }. gov_twin.simulate(model.params, run, { from: i,
// stride, x0: x }) then gives the open-loop numbers of validate(); the one-sample default start of simulate() does not (gov_twin).
function stateAt(model, run, i, o = {}) {
    const R = model.rules || RULES, has = { voltage: !!(model.has.voltage && run.vbat), current: !!(model.has.current && run.vbat && run.ibat) };
    const c = gridOf(run, model.Href, has, R, o.causal !== false), k = Math.max(0, Math.min(c.ng - 1, Math.floor(i / c.stride)));
    return { x: startState(model.params, c, k), i: k * c.stride, stride: c.stride };
}
function errStats(e) {
    if (!e.length) return { n: 0, medianAbs: null, rms: null, p95Abs: null, bias: null };
    let s = 0, q = 0; for (const v of e) { s += v; q += v * v; }
    return { n: e.length, medianAbs: median(e.map(Math.abs)), rms: Math.sqrt(q / e.length), p95Abs: quantile(e.map(Math.abs), 0.95), bias: s / e.length };
}
const rmsOf = (a) => a.length ? Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) : null;
// Open loop on the recorded u: the test windows (windowS, as the fit) and whole stretches. hs in % of the target, V, A (the channels of
// P.has, without the samples that are not finite).
function openLoop(model, runs, o = {}) {
    const P = prepOf(model, runs, o), p = model.params, has = P.has, out = {};
    for (const mode of ['window', 'stretch']) {
        const W = mode === 'window' ? P.test : P.grids.flatMap(c => stretches(c, c.testFrom, c.ng).map(([k0, k1]) => ({ c, k0, m: k1 - k0 })));
        const eh = [], ehAll = [], ev = [], ei = [], buf = buffers(W.reduce((a, w) => Math.max(a, w.m), 1));
        for (const w of W) {
            const { c, k0, m } = w; simGrid(p, c, k0, m, buf);
            for (let j = 1; j < m; j++) {
                const k = k0 + j, e = 100 * (buf.h[j] - c.HS[k]) / c.T[k];
                ehAll.push(e); if (c.ACT[k]) eh.push(e);
                if (has.voltage && c.VM[k]) ev.push(buf.v[j] - c.V[k]);
                if (has.current && c.IM[k]) ei.push(buf.i[j] - c.I[k]);
            }
        }
        out[mode] = { windows: W.length, seconds: W.reduce((s, w) => s + w.m * w.c.dt, 0), hs: errStats(eh), hsAll: errStats(ehAll),
            vbat: has.voltage ? errStats(ev) : null, ibat: has.current ? errStats(ei) : null };
    }
    return out;
}
// From start points every horizonEveryS in the test stretches, simulate the largest horizon from the estimated state (causal); the HS
// error (% of the target) at each horizon against two baselines: hold (the start value of the headspeed sensor of the twin: the same
// information) and target (the logged target at the horizon: it uses the future target of the governor). Groups: all (model, hold),
// inActive (ACTIVE from the start to the horizon: model, hold, target) and crossing (a state change or a throttle cut in the horizon: the
// twin has the recorded throttle there, hold has not).
function horizonCurve(model, runs, o = {}) {
    const P = prepOf(model, runs, o), R = P.R, p = model.params, H = o.horizons || R.horizons, e = () => H.map(() => []);
    const a = { model: e(), hold: e(), inModel: e(), inHold: e(), inTarget: e(), xModel: e(), xHold: e() };
    let starts = 0;
    for (const c of P.grids) {
        const every = Math.max(1, Math.round(R.horizonEveryS / c.dt)), hk = H.map(h => Math.round(h / c.dt)), mx = hk[hk.length - 1] + 1, buf = buffers(mx);
        for (const [k0, k1] of stretches(c, c.testFrom, c.ng)) for (let k = k0; k + mx <= k1; k += every) {
            const x = startState(p, c, k), h0 = x.hsLog;
            simGrid(p, c, k, mx, buf, x); starts++;
            let inAct = c.ACT[k] === 1, q = k;
            hk.forEach((d, j) => {
                for (; inAct && q <= k + d; q++) inAct = c.ACT[q] === 1;
                const T = c.T[k + d], y = c.HS[k + d], em = 100 * (buf.h[d] - y) / T, eh = 100 * (h0 - y) / T;
                a.model[j].push(em); a.hold[j].push(eh);
                if (inAct) { a.inModel[j].push(em); a.inHold[j].push(eh); a.inTarget[j].push(100 * (T - y) / T); } else { a.xModel[j].push(em); a.xHold[j].push(eh); }
            });
        }
    }
    const st = (v) => v.map(x => ({ rms: rmsOf(x), medianAbs: x.length ? median(x.map(Math.abs)) : null, n: x.length }));
    const res = { horizons: H, starts, model: st(a.model), hold: st(a.hold), inActive: { model: st(a.inModel), hold: st(a.inHold), target: st(a.inTarget) },
        crossing: { model: st(a.xModel), hold: st(a.xHold) } };
    res.skill = H.map((h, j) => res.model[j].rms != null && res.hold[j].rms > 0 ? 1 - res.model[j].rms / res.hold[j].rms : null);
    return res;
}
// the spool-up exits (SPOOLUP -> ACTIVE) at or after frame `from`: { i, u, overshoot (% of the request over overshootS) }
function spoolExits(state, u, hs, idx, run, from, Href, R) {
    const out = [], os = Math.round(R.events.overshootS * run.rate), at = (j) => idx ? idx[j] : j;
    for (let j = 1; j < state.length; j++) {
        if (!(state[j] === STATE_ACTIVE && state[j - 1] === 2) || at(j) < from) continue;
        const i = at(j), tgt = run.request && run.request[i] > 0 ? run.request[i] : Href;
        let mx = 0; for (let q = j; q < state.length && at(q) < i + os; q++) mx = Math.max(mx, hs[q]);
        out.push({ i, u: u[j], overshoot: 100 * (mx / tgt - 1) });
    }
    return out;
}
// the configuration of a run: o.configOf(run), o.configs[keyOf(run)] or o.cfg
const keyOfRun = (sim, r) => sim && sim.keyOf ? sim.keyOf(r) : r.segment ? `${r.log}.${r.segment}` : String(r.log);
const cfgOf = (o, sim, run) => o.configOf ? o.configOf(run) : o.configs ? o.configs[keyOfRun(sim, run)] : o.cfg;
const sameRun = (q, run) => q.log === run.log && (q.segment || 0) === (run.segment || 0);
// The saturation level of each frame: the gov_max_throttle of its PID profile (the configuration: profiles, start, changes) less satEps,
// else the ceiling of the log (ceilingOf). -> level(i)
function satLevel(run, cfg, R) {
    const ceil = ceilingOf(run, R), pr = cfg && cfg.profiles;
    if (!pr || !(cfg.start > 0)) return () => ceil;
    const lev = (q) => pr[q] && pr[q].gov_max_throttle > 0 ? Math.min(R.openLoopU, pr[q].gov_max_throttle / 100 - R.satEps) : ceil, ch = cfg.changes || [];
    const l0 = lev(cfg.start), ls = ch.map(q => lev(q.profile));
    return ch.length ? (i) => { let v = l0; for (let j = 0; j < ch.length && ch[j].k <= i; j++) v = ls[j]; return v; } : () => l0;
}
// centred moving mean over ± w samples
function movMean(a, w) {
    const n = a.length, c = new Float64Array(n + 1), o = new Float64Array(n);
    for (let i = 0; i < n; i++) c[i + 1] = c[i] + a[i];
    for (let i = 0; i < n; i++) { const j0 = Math.max(0, i - w), j1 = Math.min(n - 1, i + w); o[i] = (c[j1 + 1] - c[j0]) / (j1 - j0 + 1); }
    return o;
}
// Closed loop: the native governor and the twin from the log start (gov_sim.run with plant 'twin', every sample recorded). Compared
// on the test part of each run: hs in % of the reference (targetAt) and u in the logged ACTIVE (else the activity rule), Vbat with the
// motor on (twin with voltage only), the governor states (all samples). Baselines on the same samples: base, the RMS of the logged
// tracking error (hs − govTarget: a model whose headspeed is always the logged target), and the fast part (RULES.status.band: the mean
// over band[0] s less the mean over band[1] s, about 1-10 Hz) of the closed-loop HS error and of the logged tracking error, where the
// log and the twin are in ACTIVE under the saturation level for the whole band[1] window. Saturated time: u at or above satLevel. o:
// configs (gov_sim.configOf, key gov_sim.keyOf) | configOf(run) | cfg, scenario (gov_sim; default {}: as recorded), params (another
// parameter set of the twin), light (no traces and no FALLBACK rows: the tm scan of validate).
async function closedLoop(model, runs, o = {}) {
    let sim = o.sim;
    if (sim === undefined) try { sim = require('./gov_sim.cjs'); } catch (e) { sim = null; }
    if (!sim || typeof sim.run !== 'function') return { available: false, reason: TEXT.noSim, runs: [], reasons: [] };
    const P = prepOf(model, runs, o), R = P.R, S = R.status, rows = [], reasons = [], acc = { h: [0, 0], u: [0, 0], v: [0, 0], st: [0, 0], b: [0, 0], bd: [0, 0], bl: [0, 0] };
    const twin = o.params || model.params, wl = (c) => Math.round(S.band[0] / 2 * c.run.rate), wh = (c) => Math.round(S.band[1] / 2 * c.run.rate);
    for (const c of P.grids) {
        if (c.testFrom >= c.ng) continue;
        const run = c.run, log = run.log + 1, seg = run.segment || 0, cfg = cfgOf(o, sim, run);
        const fail = (t, error) => { reasons.push(t); rows.push({ log: run.log, segment: seg, excluded: t, error }); };
        if (cfg == null) { fail(TEXT.noConfig(log)); continue; }
        let res;
        try { res = await sim.run(run, cfg, { plant: 'twin', twin, scenario: o.scenario || {}, record: { points: 1e9 } }); } catch (e) { res = { error: e.message }; }
        const tr = res && res.trace;
        if (!tr || res.excluded || res.error) { fail(TEXT.simFail(log, (res && res.excluded) || ''), res && res.error); continue; }
        const idx = tr.i || framesOf(tr, run, tr.hs.length), hs = tr.hs, u = tr.u, vb = P.has.voltage ? tr.vbat : null, ib = P.has.current ? tr.ibat || null : null, st = tr.state, len = hs.length;
        const from = c.testFrom * c.stride, s = { h: [0, 0], u: [0, 0], v: [0, 0], st: [0, 0], b: [0, 0], bd: [0, 0], bl: [0, 0] }, lev = satLevel(run, cfg, R);
        const full = len === run.n && st && run.state, eD = full ? new Float64Array(run.n) : null, eL = full ? new Float64Array(run.n) : null, ok = full ? new Uint8Array(run.n) : null;
        let sat = 0;
        for (let j = 0; j < len; j++) {
            const i = idx[j]; if (i < from || i >= run.n) continue;
            const act = run.state ? run.state[i] === STATE_ACTIVE : run.hs[i] > R.activeHs * P.Href && run.u[i] > GT.RULES.dOff && run.u[i] < R.openLoopU, T = targetAt(run, i, act, P.Href);
            const okH = act && finite(hs[j]) && finite(run.hs[i]), tg = run.target ? run.target[i] : 0;
            if (okH) { const e = 100 * (hs[j] - run.hs[i]) / T; s.h[0] += e * e; s.h[1]++; if (tg > 0) { const b = 100 * (run.hs[i] - tg) / tg; s.b[0] += b * b; s.b[1]++; } }
            if (act && finite(u[j]) && finite(run.u[i])) { const e = u[j] - run.u[i]; s.u[0] += e * e; s.u[1]++; }
            if (vb && run.vbat && finite(vb[j]) && finite(run.vbat[i]) && run.u[i] > R.runningU) { const e = vb[j] - run.vbat[i]; s.v[0] += e * e; s.v[1]++; }
            if (st && run.state) { s.st[0] += st[j] === run.state[i] ? 1 : 0; s.st[1]++; }
            if (u[j] >= lev(i)) sat++;
            if (full && okH && tg > 0) { eD[i] = 100 * (hs[j] - run.hs[i]) / T; eL[i] = 100 * (run.hs[i] - tg) / tg; ok[i] = st[j] === STATE_ACTIVE && run.u[i] < lev(i) ? 1 : 0; }
        }
        // the fast part of the errors, where the whole window is valid
        if (full) {
            const a = wl(c), b = wh(c), dA = movMean(eD, a), dB = movMean(eD, b), lA = movMean(eL, a), lB = movMean(eL, b), cnt = new Int32Array(run.n + 1);
            for (let i = 0; i < run.n; i++) cnt[i + 1] = cnt[i] + ok[i];
            for (let i = Math.max(from, b); i + b < run.n; i++) if (cnt[i + b + 1] - cnt[i - b] === 2 * b + 1) {
                const d = dA[i] - dB[i], l = lA[i] - lB[i]; s.bd[0] += d * d; s.bd[1]++; s.bl[0] += l * l; s.bl[1]++;
            }
        }
        for (const k of Object.keys(acc)) { acc[k][0] += s[k][0]; acc[k][1] += s[k][1]; }
        const q = (k) => s[k][1] ? Math.sqrt(s[k][0] / s[k][1]) : null, t0 = run.time[Math.min(run.n - 1, from)], inTest = (e) => e.atS >= t0;
        const row = { log: run.log, segment: seg, frames: s.h[1], hsRms: q('h'), uRms: q('u'), vbatRms: q('v'), stateAgreement: s.st[1] ? s.st[0] / s.st[1] : null, baseRms: q('b'),
            band: s.bl[0] > 0 ? Math.sqrt(s.bd[0] / s.bl[0]) : null, bandFrames: s.bd[1], satS: sat * (len > 1 ? (idx[len - 1] - idx[0]) / (len - 1) : 1) / run.rate,
            metrics: res.metrics || null, forced: res.forced || 0, entries: res.metrics ? res.metrics.events.filter(inTest).length : null };
        if (!o.light) {
            const step = Math.max(1, Math.ceil(len / R.plotPoints)), keep = (x) => x ? Array.from({ length: Math.ceil(len / step) }, (_, k) => x[k * step]) : null;
            // the FALLBACK entries of the test part: the log (gov_sim.logMetrics) and the closed loop (forced at the logged times, gov_sim
            // forceFallback 'recorded', unless the scenario says otherwise)
            const lm = sim.logMetrics ? sim.logMetrics(run, cfg) : null;
            Object.assign(row, { spool: st ? spoolExits(st, u, hs, idx, run, from, P.Href, R) : [], fallbacks: { log: lm ? lm.events.filter(inTest) : [], closed: res.metrics ? res.metrics.events.filter(inTest) : [] },
                compare: res.compare || null, trace: { index: keep(idx), hs: keep(hs), u: keep(u), vbat: keep(vb), ibat: keep(ib), state: keep(st) } });
        }
        rows.push(row);
    }
    const r = (k, sq) => acc[k][1] ? (sq ? Math.sqrt(acc[k][0] / acc[k][1]) : acc[k][0] / acc[k][1]) : null;
    const used = rows.filter(q => !q.excluded && q.hsRms != null), worst = used.reduce((a, q) => !a || q.hsRms > a.hsRms ? q : a, null);
    const hsRms = r('h', true), baseRms = r('b', true);
    return { available: true, runs: rows, reasons, hsRms, uRms: r('u', true), vbatRms: r('v', true), stateAgreement: r('st', false), baseRms, skill: hsRms != null && baseRms > 0 ? hsRms / baseRms : null,
        band: acc.bl[0] > 0 ? Math.sqrt(acc.bd[0] / acc.bl[0]) : null, bandS: acc.bd[1] ? acc.bd[1] / (P.grids[0] ? P.grids[0].run.rate : 1) : 0,
        worst: worst ? { log: worst.log, segment: worst.segment, hsRms: worst.hsRms } : null, logs: used.length };
}
// frame indexes of a trace without `i`: tr.stride (with tr.from), every frame (length run.n), or tr.time (s, the clock of run.time)
function framesOf(tr, run, len) {
    if (tr.stride) return Int32Array.from({ length: len }, (_, j) => (tr.from || 0) + j * tr.stride);
    if (len === run.n || !tr.t) return Int32Array.from({ length: len }, (_, j) => j);
    const out = new Int32Array(len); let i = 0;
    for (let j = 0; j < len; j++) { while (i + 1 < run.n && run.time[i + 1] <= tr.t[j]) i++; out[j] = i; }
    return out;
}
// Spool-up exit throttle and overshoot, the saturated time (u at or above satLevel), and the FALLBACK droop and recovery, on the test part
// (atS: s in the run, t: frame seconds, fromS + time, the clock of the log viewer):
// the log, the open-loop twin (recorded u, the stretch from its start) and the closed loop (o.closed: closedLoop(); the closed-loop
// FALLBACK entries are forced at the logged times unless o.scenario.forceFallback is given: forced)
function events(model, runs, o = {}) {
    const P = prepOf(model, runs, o), R = P.R, p = model.params, E = R.events, out = { spoolups: [], saturation: [], fallbacks: [] };
    const cl = o.closed && o.closed.runs ? o.closed.runs : [], sim = o.sim || null, forced = !(o.scenario && o.scenario.forceFallback !== undefined && o.scenario.forceFallback !== 'recorded');
    for (const c of P.grids) {
        if (c.testFrom >= c.ng) continue;
        const run = c.run, seg = run.segment || 0, from = c.testFrom * c.stride, row = cl.find(q => sameRun(q, run) && !q.excluded), lev = satLevel(run, cfgOf(o, sim, run), R);
        let sat = 0; for (let i = from; i < run.n; i++) if (run.u[i] >= lev(i)) sat++;
        const ss = { log: run.log, segment: seg, logS: sat / run.rate, closedS: row ? row.satS : null };
        ss.pass = ss.closedS == null ? null : Math.abs(ss.closedS - ss.logS) <= E.satRel * Math.max(ss.logS, 1);
        out.saturation.push(ss);
        // FALLBACK: the lowest headspeed (% of the request) and the recovery time after each logged entry, the log against the closed loop
        if (row && row.fallbacks) for (const e of row.fallbacks.log) {
            const y = row.fallbacks.closed.find(q => Math.abs(q.atS - e.atS) < 0.05), pc = (q) => q && q.minRatio != null ? 100 * (q.minRatio - 1) : null;
            const ev = { log: run.log, segment: seg, atS: e.atS, t: +((run.fromS || 0) + e.atS).toFixed(3), profile: e.profile, forced, droop: { log: pc(e), closed: pc(y) }, recoveryS: { log: e.recoveryS, closed: y ? y.recoveryS : null } };
            ev.pass = ev.droop.closed == null ? null : Math.abs(ev.droop.closed - ev.droop.log) <= E.fallbackDroop &&
                (ev.recoveryS.log == null ? ev.recoveryS.closed == null : ev.recoveryS.closed != null && Math.abs(ev.recoveryS.closed - ev.recoveryS.log) <= E.recoveryRel * Math.max(ev.recoveryS.log, 1));
            out.fallbacks.push(ev);
        }
        if (!run.state) continue;
        for (const x of spoolExits(run.state, run.u, run.hs, null, run, from, P.Href, R)) {
            const ev = { log: run.log, segment: seg, atS: x.i / run.rate, t: +((run.fromS || 0) + run.time[x.i]).toFixed(3), exitThrottle: { log: x.u, closed: null }, overshoot: { log: x.overshoot, open: null, closed: null } };
            const ki = Math.floor(x.i / c.stride), st = stretches(c, 0, c.ng).find(([a, b]) => a <= ki && ki < b), os = Math.round(E.overshootS / c.dt);
            if (st) {
                const m = Math.min(st[1], ki + os) - st[0], buf = buffers(m); simGrid(p, c, st[0], m, buf);
                let mo = 0; for (let j = ki - st[0]; j < m; j++) mo = Math.max(mo, buf.h[j]);
                ev.overshoot.open = 100 * (mo / (run.request && run.request[x.i] > 0 ? run.request[x.i] : P.Href) - 1);
            }
            const y = row && row.spool.reduce((b, q) => !b || Math.abs(q.i - x.i) < Math.abs(b.i - x.i) ? q : b, null);
            if (y && Math.abs(y.i - x.i) <= os * c.stride) { ev.exitThrottle.closed = y.u; ev.overshoot.closed = y.overshoot; }
            ev.pass = ev.exitThrottle.closed == null ? null : Math.abs(ev.exitThrottle.closed - ev.exitThrottle.log) <= E.exitThrottle && Math.abs(ev.overshoot.closed - ev.overshoot.log) <= E.overshoot;
            ev.passOpen = ev.overshoot.open == null ? null : Math.abs(ev.overshoot.open - ev.overshoot.log) <= E.overshoot;
            out.spoolups.push(ev);
        }
    }
    return out;
}
// Validation on the test data: open loop, horizon curve, closed loop, events, and
//   unforced   the closed loop without the forced FALLBACK entries (when the test part has logged entries): { hsRms, uRms, stateAgreement,
//              vbatRms, band, runs: [{ log, segment, hsRms, uRms, stateAgreement, satS, entries (the twin's own FALLBACK entries) }] }
//   tmScan     the closed loop with tm × RULES.status.tmScan: [{ factor, tm, band, hsRms, uRms, runs: [{ log, segment, band, hsRms }] }] (the speed
//              dynamics: check tmBand)
// The status checks (RULES.status): open loop hsMedian, vbatRms; closed loop clHsRms (pooled), clHsRmsLog (each log: perLog × clHsRms),
// clSkill (clHsRms / the logged tracking error), clBand (the fast part), tmBand (no tm of the scan gives a fast error under tmMargin × that of
// the model), clURms, stateAgree.
async function validate(model, runs, o = {}) {
    if (!model || model.status !== 'identified') return { status: 'rejected', reasons: [TEXT.rejected], checks: [] };
    const P = prepOf(model, runs, o), R = P.R, S = R.status, oo = Object.assign({}, o, { prepared: P });
    if (!P.test.length) return { status: 'partial', reasons: [TEXT.noTest], checks: [], openLoop: null, horizon: null, closedLoop: null, events: null };
    const ol = openLoop(model, runs, oo), hz = horizonCurve(model, runs, oo), cl = await closedLoop(model, runs, oo), ev = events(model, runs, Object.assign({ closed: cl }, oo));
    let unforced = null;
    const tmScan = [];
    if (cl.available) {
        if (!(oo.scenario && oo.scenario.forceFallback !== undefined) && cl.runs.some(q => q.fallbacks && q.fallbacks.log.length)) {
            const u = await closedLoop(model, runs, Object.assign({}, oo, { scenario: Object.assign({}, oo.scenario, { forceFallback: [] }), light: true }));
            unforced = { hsRms: u.hsRms, uRms: u.uRms, vbatRms: u.vbatRms, stateAgreement: u.stateAgreement, band: u.band, runs: u.runs.map(q => ({ log: q.log, segment: q.segment, excluded: q.excluded,
                hsRms: q.hsRms, uRms: q.uRms, stateAgreement: q.stateAgreement, satS: q.satS, entries: q.entries })) };
        }
        if (cl.band != null) for (const f of S.tmScan) {
            const q = await closedLoop(model, runs, Object.assign({}, oo, { params: GT.copy(model.params, { tm: model.params.tm * f }), light: true }));
            tmScan.push({ factor: f, tm: model.params.tm * f, band: q.band, hsRms: q.hsRms, uRms: q.uRms, runs: q.runs.filter(x => !x.excluded).map(x => ({ log: x.log, segment: x.segment, band: x.band, hsRms: x.hsRms })) });
        }
    }
    const checks = [];
    const add = (rule, value, limit, lower, text) => { if (value == null) return; const pass = lower ? value >= limit : value <= limit; checks.push({ rule, value, limit, pass, text: text || TEXT[rule](value, limit) }); };
    add('hsMedian', ol.window.hs.medianAbs, S.hsMedian);
    if (P.has.voltage) add('vbatRms', ol.window.vbat.rms, S.vbatRms);
    if (cl.available) {
        add('clHsRms', cl.hsRms, S.clHsRms);
        if (cl.worst && cl.logs > 1) add('clHsRmsLog', cl.worst.hsRms, S.clHsRms * S.perLog, false, TEXT.clHsRmsLog(cl.worst.hsRms, S.clHsRms * S.perLog, cl.worst.log + 1));
        add('clSkill', cl.skill, S.clSkill);
        add('clBand', cl.band, S.clBand);
        const best = tmScan.filter(q => q.band != null).reduce((a, q) => !a || q.band < a.band ? q : a, null);
        if (best && cl.band > 0) add('tmBand', best.band / cl.band, S.tmMargin, true, TEXT.tmBand(best.band / cl.band, S.tmMargin, best.factor));
        add('clURms', cl.uRms, S.clURms); add('stateAgree', cl.stateAgreement, S.stateAgree, true);
    }
    const olFail = checks.some(q => (q.rule === 'hsMedian' || q.rule === 'vbatRms') && !q.pass), all = checks.every(q => q.pass);
    const complete = cl.available && checks.some(q => q.rule === 'clHsRms') && checks.some(q => q.rule === 'stateAgree');
    const status = olFail ? 'rejected' : all && complete ? 'validated' : 'partial';
    const reasons = [TEXT[status]].concat(checks.filter(q => !q.pass).map(q => q.text), cl.available ? cl.reasons : [cl.reason], P.reasons.filter(t => t === TEXT.noChannelV || t === TEXT.noChannelI));
    return { status, reasons, checks, openLoop: ol, horizon: hz, closedLoop: cl, unforced, tmScan, events: ev };
}

// ---- plot data ----
// the steady-state map: required throttle d against the collective (p0.1 to p99.9 of ACTIVE) at each governed headspeed, at the OCV of
// the highest recorded rest voltage before a flight and the lowest after a flight (less vp), the median cyclic and |yaw|, with the
// measured 1-s ACTIVE points
function steadyMap(model, P) {
    const p = model.params, R = P.R, req = new Map(), pts = [], cs = [], xs = [], ys = [], restStart = [], restEnd = [];
    for (const c of P.grids) {
        const run = c.run, B = Math.round(1 / c.dt);
        for (let k = 0; k + B <= c.ng; k += B) {
            let ok = true; for (let j = k; j < k + B && ok; j++) ok = c.STEADY[j] === 1;
            if (!ok) continue;
            const r = run.request ? Math.round(run.request[k * c.stride] / 10) * 10 : Math.round(model.Href);
            req.set(r, (req.get(r) || 0) + 1);
            let a = 0, u = 0, v = 0; for (let j = k; j < k + B; j++) { a += c.C[j]; u += c.U[j]; v += c.V ? c.V[j] : 0; cs.push(c.C[j]); xs.push(c.X[j]); ys.push(c.Y[j]); }
            pts.push({ coll: a / B, u: u / B, hs: r, vbat: c.V ? v / B : null, log: run.log });
        }
        if (c.V) {
            const runK = []; for (let k = 0; k < c.ng; k++) if (c.RUN[k]) runK.push(k);
            if (runK.length) {
                const a = [], b = []; for (let k = 0; k < runK[0]; k++) a.push(c.V[k]); for (let k = runK[runK.length - 1] + Math.round(0.5 / c.dt); k < c.ng; k++) b.push(c.V[k]);
                if (a.length >= 10) restStart.push(median(a)); if (b.length >= 10) restEnd.push(median(b));
            }
        }
    }
    const profiles = [...req].filter(([, n]) => n >= R.profileMinS).map(([h]) => h).sort((a, b) => a - b);
    const cMin = Math.min(0, quantile(cs, 0.001) || 0), cMax = quantile(cs, 0.999) || 1, cyc = median(xs) || 0, yaw = median(ys) || 0;
    const grid = Array.from({ length: 41 }, (_, j) => cMin + (cMax - cMin) * j / 40);
    // the OCV of the twin: the rest voltage less its rest offset vp (gov_twin)
    const vp = p.vp > 0 ? p.vp : 0, ocv = p.voltage ? [{ name: 'full', rest: restStart.length ? Math.max(...restStart) : null }, { name: 'end', rest: restEnd.length ? Math.min(...restEnd) : null }]
        .filter(q => q.rest).map(q => Object.assign(q, { value: q.rest - vp })) : [{ name: 'constant', value: null, rest: null }];
    const curves = [];
    for (const hs of (profiles.length ? profiles : [Math.round(model.Href)])) for (const q of ocv) {
        curves.push({ headspeed: hs, ocv: q.name, voltage: q.value, rest: q.rest, coll: grid, throttle: grid.map(cc => { const d = GT.steady(p, { H: hs, coll: cc, cyc, yaw, ocv: q.value }).d; return finite(d) ? d : null; }) });
    }
    const step = Math.max(1, Math.ceil(pts.length / R.plotPoints));
    return { cyc, yaw, curves, points: pts.filter((q, j) => j % step === 0) };
}
// the logged governor states of a run from frame i0 (the states of RULES.bandStates, at most RULES.plotBands) as bands { x0, x1, state } in
// frame seconds (fromS + time: the clock of the log viewer), each to the first frame of the next state
function stateBands(run, i0 = 0) {
    const st = run.state, out = [], n = run.n, f = run.fromS || 0, B = RULES.bandStates;
    if (!st) return out;
    for (let i = Math.max(0, i0); i < n && out.length < RULES.plotBands;) {
        const s = st[i]; let j = i; while (j + 1 < n && st[j + 1] === s) j++;
        if (B[s]) out.push({ x0: +(f + run.time[i]).toFixed(3), x1: +(f + run.time[Math.min(n - 1, j + 1)]).toFixed(3), state: B[s] });
        i = j + 1;
    }
    return out;
}
// traces of each test run on a common decimated grid: measured and predicted (open loop over whole stretches, closed loop), the time in frame
// seconds (fromS + time) and the logged governor states (stateBands)
function plotData(model, runs, validation, o = {}) {
    const P = prepOf(model, runs, o), R = P.R, p = model.params, out = { runs: [], horizon: validation && validation.horizon || null, steady: steadyMap(model, P) };
    const cl = validation && validation.closedLoop && validation.closedLoop.runs || [];
    for (const c of P.grids) {
        if (c.testFrom >= c.ng) continue;
        const run = c.run, k0 = c.testFrom, n = c.ng - k0, step = Math.max(1, Math.ceil(n / R.plotPoints)), ks = [];
        for (let k = k0; k < c.ng; k += step) ks.push(k);
        const hsOpen = new Float64Array(c.ng).fill(NaN), vOpen = P.has.voltage ? new Float64Array(c.ng).fill(NaN) : null, iOpen = P.has.current ? new Float64Array(c.ng).fill(NaN) : null;
        for (const [a, b] of stretches(c, k0, c.ng)) {
            const buf = buffers(b - a); simGrid(p, c, a, b - a, buf);
            for (let j = 0; j < b - a; j++) { hsOpen[a + j] = buf.h[j]; if (vOpen) vOpen[a + j] = buf.v[j]; if (iOpen) iOpen[a + j] = buf.i[j]; }
        }
        const pick = (a) => a ? ks.map(k => finite(a[k]) ? +a[k].toFixed(4) : null) : null, row = (cl.find(q => sameRun(q, run) && q.trace) || {}).trace;
        const closed = (a) => {
            if (!row || !a) return null;
            const idx = row.index, outA = []; let j = 0;
            for (const k of ks) { const f = k * c.stride; while (j + 1 < idx.length && idx[j + 1] <= f) j++; outA.push(finite(a[j]) ? +a[j].toFixed(4) : null); }
            return outA;
        };
        out.runs.push({ log: run.log, segment: run.segment || 0, time: ks.map(k => +((run.fromS || 0) + run.time[k * c.stride]).toFixed(3)), bands: stateBands(run, k0 * c.stride),
            target: pick(c.T), hs: pick(c.HS), hsOpen: pick(hsOpen), hsClosed: closed(row && row.hs),
            u: pick(c.U), uClosed: closed(row && row.u), vbat: pick(c.V), vbatOpen: pick(vOpen), vbatClosed: closed(row && row.vbat), ibat: pick(c.I), ibatOpen: pick(iOpen),
            ibatClosed: closed(row && row.ibat), coll: pick(c.C), state: c.ST ? ks.map(k => c.ST[k]) : null, stateClosed: closed(row && row.state) });
    }
    return out;
}

module.exports = { RULES, TEXT, lm, nnls, quantile, prepare, initial, kappaOf, fitCost, identify, validate, openLoop, horizonCurve, closedLoop, events, plotData, stateBands, steadyMap, stateAt };
if (require.main !== module) return;

// node tools/autotune/gov_fit.cjs <data dir> [--logs 10,11] [--boot n] [--out file]: identify and validate (no closed loop
// without gov_sim and a configuration) on the dev data (analysis/governor-20261014/data/<craft>)
(async () => {
    const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
    const logs = opt('--logs'), boot = opt('--boot'), file = opt('--out');
    const runs = require('./gov_data.cjs').load(args[0], { logs: logs ? logs.split(',').map(Number) : undefined });
    const model = identify(runs, { bootstrap: boot != null ? +boot : undefined, progress: (f, t) => process.stderr.write(`\r${t} ${(100 * f).toFixed(0)} %   `) });
    process.stderr.write('\n');
    const val = await validate(model, runs, { sim: null });
    const short = { status: model.status, reasons: model.reasons, Href: model.Href, has: model.has, split: model.split, fit: Object.assign({}, model.fit, { history: undefined }), timing: model.timing,
        uncertainty: model.uncertainty, kappa: model.kappa, softStart: model.softStart, physical: model.physical, regression: model.regression, initial: model.initial, validation: { status: val.status, reasons: val.reasons, openLoop: val.openLoop,
            horizon: val.horizon && { horizons: val.horizon.horizons, model: val.horizon.model, hold: val.horizon.hold, skill: val.horizon.skill }, events: val.events } };
    const text = JSON.stringify(short, (k, v) => typeof v === 'number' ? +v.toPrecision(5) : v, 1);
    if (file) require('fs').writeFileSync(file, text); else console.log(text);
})().catch((e) => { console.error(e); process.exit(1); });
