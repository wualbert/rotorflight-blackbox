'use strict';
// Checks of the governor equations (tools/autotune/firmware/vendor/flight_governor.c) against logged governor fields,
// and estimates of governor parameters that the log header does not record.
// usage: node verify.cjs <dump.BBL> <params.json> <log indexes comma list> > out.json
// params.json: { profiles: { "<govRequest>": { gain, p_gain, i_gain, d_gain, f_gain, p_limit, i_limit, d_limit, f_limit,
//   yaw_weight, cyclic_weight, collective_weight, collective_curve, min_throttle, max_throttle } }, rpm_filter, ff_filter,
//   d_filter, pidHz, gear: [num, den], fit_ff: bool }
const fs = require('node:fs');
const lib = require('../../../tools/autotune/lib.cjs');
const [file, paramFile, logList] = process.argv.slice(2);
const P = JSON.parse(fs.readFileSync(paramFile, 'utf8'));
const logs = logList.split(',').map(Number);
const app = lib.loadApp();
const extra = ['govP', 'govI', 'govD', 'govF', 'govSum', 'govTarget', 'govRequest', 'motor[0]', 'rcCommand[4]', 'Vbat', 'Ibat', 'mixer[3]'];

// firmware filters (common_filter.c)
function pt2(x, fc, fs) {
    const y = new Float64Array(x.length); if (!(fc > 0)) { y.set(x); return y; }
    const f = Math.min(1.553773974 * fc, 0.475 * fs), g = Math.min(1, f / (f + fs / (2 * Math.PI)));
    let a = 0, b = 0; for (let i = 0; i < x.length; i++) { b += (x[i] - b) * g; a += (b - a) * g; y[i] = a; } return y;
}
function dif(x, fc, fs) {
    const y = new Float64Array(x.length); if (!(fc > 0)) return y;
    const W = Math.tan(Math.PI * Math.min(fc, 0.475 * fs / 2) / fs), A = (W - 1) / (W + 1), B = 2 * fs * W / (W + 1);
    let x1 = 0, y1 = 0; for (let i = 0; i < x.length; i++) { y1 = B * (x[i] - x1) - A * y1; x1 = x[i]; y[i] = y1; } return y;
}
const shift = (x, L) => { const y = new Float64Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[Math.max(0, i - L)]; return y; };
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));
const pct = (a, q) => { const s = Float64Array.from(a).sort(); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
function linfit(X, y) { // least squares, X rows
    const m = X[0].length, A = Array.from({ length: m }, () => new Float64Array(m)), b = new Float64Array(m);
    for (let r = 0; r < X.length; r++) for (let i = 0; i < m; i++) { b[i] += X[r][i] * y[r]; for (let j = 0; j < m; j++) A[i][j] += X[r][i] * X[r][j]; }
    for (let i = 0; i < m; i++) { let p = i; for (let k = i + 1; k < m; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
        [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
        for (let k = i + 1; k < m; k++) { const f = A[k][i] / A[i][i]; for (let j = i; j < m; j++) A[k][j] -= f * A[i][j]; b[k] -= f * b[i]; } }
    const x = new Float64Array(m); for (let i = m - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < m; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; }
    let ss = 0; for (let r = 0; r < X.length; r++) { let e = y[r]; for (let i = 0; i < m; i++) e -= X[r][i] * x[i]; ss += e * e; }
    return { coef: Array.from(x), rms: Math.sqrt(ss / X.length), n: X.length };
}
function ramps(t, v, mask, minS) { // slope (per s) of v in each run of mask, run trimmed by 0.15 s at each end
    const out = []; let i = 0;
    while (i < t.length) { if (!mask[i]) { i++; continue; } let j = i; while (j < t.length && mask[j]) j++;
        const a = i + Math.round(0.15 * 1000), b = j - Math.round(0.15 * 1000);
        if ((t[j - 1] - t[i]) >= minS && b - a > 50) { const X = [], y = []; for (let k = a; k < b; k++) { X.push([1, t[k]]); y.push(v[k]); }
            const f = linfit(X, y); out.push({ fromS: +t[i].toFixed(3), toS: +t[j - 1].toFixed(3), slopePerS: +f.coef[1].toFixed(2), rms: +f.rms.toFixed(2), v0: v[i], v1: v[j - 1] }); }
        i = j; }
    return out;
}

const result = [];
for (const w of lib.segments(app, file, { whole: true, extra, logs })) {
    if (!w.whole || !w.govStateAt) continue;
    const x = w.extra, n = w.n, fsLog = w.rate, s = w.govStateAt, hs = w.hs;
    if (!x.govP || !x.govTarget || !x['motor[0]']) continue;
    const t = new Float64Array(n); for (let i = 0; i < n; i++) t[i] = i / fsLog;
    const req = x.govRequest, prof = (i) => P.profiles[String(req[i])];
    const active = (i) => s[i] === 4 && prof(i);
    const row = { log: w.flight.log, seconds: +w.seconds.toFixed(1), activeS: 0 };
    let nA = 0; for (let i = 0; i < n; i++) if (active(i)) nA++; row.activeS = +(nA / fsLog).toFixed(1);
    if (!nA) { result.push(row); continue; }

    // A1: govSum = govP + govI + govD + govF (each truncated to an integer)
    { const d = []; for (let i = 0; i < n; i++) if (active(i)) d.push(x.govSum[i] - (x.govP[i] + x.govI[i] + x.govD[i] + x.govF[i]));
        row.sumIdentity = { n: d.length, absMax: d.reduce((a, v) => Math.max(a, Math.abs(v)), 0), p99abs: pct(d.map(Math.abs), 0.99), mean: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(3) }; }
    // A2: motor[0] = round(1000 x clamp(govSum/1000 x vcomp, min, max)) with vcomp = 1
    { const d = []; let hi = 0, lo = 0, at95 = 0;
        for (let i = 0; i < n; i++) if (active(i)) { const p = prof(i), mn = p.min_throttle * 10, mx = p.max_throttle * 10;
            const pred = Math.min(mx, Math.max(mn, x.govSum[i])); d.push(x['motor[0]'][i] - pred);
            if (x.govSum[i] >= mx) hi++; if (x.govSum[i] <= mn) lo++; if (x['motor[0]'][i] >= 950) at95++; }
        row.motorIdentity = { n: d.length, absMax: d.reduce((a, v) => Math.max(a, Math.abs(v)), 0), p99abs: pct(d.map(Math.abs), 0.99), p999abs: pct(d.map(Math.abs), 0.999),
            atMaxS: +(hi / fsLog).toFixed(2), atMinS: +(lo / fsLog).toFixed(2), motorAtLeast95S: +(at95 / fsLog).toFixed(2) }; }
    // A3: the governor's own headspeed: hsGov = govTarget - govP x fullHS / (1000 K Kp) (P not at its limit, TTA = 0)
    const hsGov = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (active(i)) { const p = prof(i), KKp = p.gain / 100 * p.p_gain / 10;
        if (Math.abs(x.govP[i]) < p.p_limit * 10 - 1) hsGov[i] = x.govTarget[i] - x.govP[i] * req[i] / (1000 * KKp); }
    { const cand = []; const sel = []; for (let i = 0; i < n; i++) if (Number.isFinite(hsGov[i])) sel.push(i);
        for (const fc of [5, 7.5, 10, 12.5, 15, 20, 30]) { const f = pt2(hs, fc, fsLog);
            for (const L of [0, 1, 2, 3, 4, 6]) { const g = shift(f, L); const e = sel.map(i => hsGov[i] - g[i]); cand.push({ fc, L, rms: +rms(e).toFixed(2), bias: +(e.reduce((a, b) => a + b, 0) / e.length).toFixed(2) }); } }
        cand.sort((a, b) => a.rms - b.rms);
        const cfg = cand.find(c => c.fc === P.rpm_filter && c.L === 1);
        const raw = sel.map(i => hsGov[i] - hs[i]);
        row.headspeedFilter = { n: sel.length, best: cand.slice(0, 3), configured: cfg, unfilteredRms: +rms(raw).toFixed(2), resolutionRpm: +(req[sel[0]] / (1000 * prof(sel[0]).gain / 100 * prof(sel[0]).p_gain / 10)).toFixed(2) }; }
    // A4: integrator: govI[k] - govI[k-1] = (Ki dT / Kp) govP[k] per PID loop; per log frame x loops per frame
    { const blocks = []; let sx = 0, sy = 0, m = 0;
        for (let i = 1; i < n; i++) { const p = prof(i);
            const ok = active(i) && active(i - 1) && Math.abs(x.govP[i]) < p.p_limit * 10 - 1 && Math.abs(x.govI[i]) < p.i_limit * 10 - 2 &&
                x['motor[0]'][i] > p.min_throttle * 10 + 1 && x['motor[0]'][i] < p.max_throttle * 10 - 1 && req[i] === req[i - 1];
            if (!ok) { if (m >= 200) blocks.push([sx, sy]); sx = sy = m = 0; continue; }
            sx += x.govP[i] + (x.govP[i] > 0 ? 0.5 : x.govP[i] < 0 ? -0.5 : 0); sy += x.govI[i] - x.govI[i - 1]; m++; // logged terms are truncated toward zero
            if (m === 500) { blocks.push([sx, sy]); sx = sy = m = 0; } }
        const fit = blocks.length > 3 ? linfit(blocks.map(b => [b[0]]), blocks.map(b => b[1])) : null;
        const p0 = P.profiles[Object.keys(P.profiles)[0]];
        row.integrator = { blocks: blocks.length, slopePerFrame: fit ? +fit.coef[0].toExponential(4) : null,
            expectedPerFrame: +(p0.i_gain / 10 / (p0.p_gain / 10) * (P.pidHz ? 1 / fsLog : 0)).toExponential(4) }; }
    // A5: feedforward: govF = clamp(PT2_ff(1000 K Kf (cw |c|^(curve/10) + cyc |cyclic| + yw |yaw|)), 0, 1000 f_limit)
    { const c = x['mixer[3]'], feat = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
        if (c) {
            const curve = (i) => (prof(i) || P.profiles[Object.keys(P.profiles)[0]]).collective_curve / 10;
            for (let i = 0; i < n; i++) { feat[0][i] = Math.pow(Math.abs(c[i] / 1000), curve(i)); feat[1][i] = Math.hypot(w.u[0][i], w.u[1][i]); feat[2][i] = Math.abs(w.u[2][i]); }
            const predRaw = new Float64Array(n);
            for (let i = 0; i < n; i++) { const p = prof(i) || P.profiles[Object.keys(P.profiles)[0]], KKf = 1000 * p.gain / 100 * p.f_gain / 100;
                predRaw[i] = KKf * (p.collective_weight / 100 * feat[0][i] + p.cyclic_weight / 100 * feat[1][i] + p.yaw_weight / 100 * feat[2][i]); }
            const pred = pt2(predRaw, P.ff_filter, fsLog), e = [];
            for (let i = 0; i < n; i++) if (active(i)) { const p = prof(i); const v = Math.min(p.f_limit * 10, Math.max(0, pred[i])); e.push(x.govF[i] - v); }
            row.feedforward = { n: e.length, rms: +rms(e).toFixed(2), p99abs: pct(e.map(Math.abs), 0.99), govFrms: +rms(Array.from({ length: n }, (_, i) => i).filter(active).map(i => x.govF[i])).toFixed(1) };
            if (P.fit_ff) { // unknown weights: govF = K Kf (sum w_j PT2(feature_j)); scan the curve and the filter
                const scans = [];
                for (const curveX of [1.0, 1.5, 2.0, 2.5, 3.0]) for (const ffc of [2, 3, 5, 8, 12]) {
                    const f0 = new Float64Array(n); for (let i = 0; i < n; i++) f0[i] = Math.pow(Math.abs(c[i] / 1000), curveX);
                    const F = [pt2(f0, ffc, fsLog), pt2(feat[1], ffc, fsLog), pt2(feat[2], ffc, fsLog)], X = [], y = [];
                    for (let i = 0; i < n; i += 2) if (active(i) && x.govF[i] > 0) { const p = prof(i), KKf = 1000 * p.gain / 100 * p.f_gain / 100; X.push([KKf * F[0][i], KKf * F[1][i], KKf * F[2][i]]); y.push(x.govF[i] + 0.5); } // +0.5: govF > 0 is truncated toward zero
                    if (X.length > 100) { const fit = linfit(X, y); scans.push({ curve: curveX, ffHz: ffc, weights: fit.coef.map(v => +(v * 100).toFixed(1)), rms: +fit.rms.toFixed(3), n: fit.n }); } }
                scans.sort((a, b) => a.rms - b.rms); row.feedforwardFit = scans.slice(0, 4);
                // per profile (govRequest), curve and filter of the best pooled fit
                const best = scans[0]; row.feedforwardFitByProfile = {};
                if (best) { const f0 = new Float64Array(n); for (let i = 0; i < n; i++) f0[i] = Math.pow(Math.abs(c[i] / 1000), best.curve);
                    const F = [pt2(f0, best.ffHz, fsLog), pt2(feat[1], best.ffHz, fsLog), pt2(feat[2], best.ffHz, fsLog)];
                    for (const key of Object.keys(P.profiles)) { const X = [], y = [];
                        for (let i = 0; i < n; i += 2) if (active(i) && String(req[i]) === key && x.govF[i] > 0) { const p = prof(i), KKf = 1000 * p.gain / 100 * p.f_gain / 100; X.push([KKf * F[0][i], KKf * F[1][i], KKf * F[2][i]]); y.push(x.govF[i] + 0.5); } // +0.5: govF > 0 is truncated toward zero
                        if (X.length > 2000) { const fit = linfit(X, y); row.feedforwardFitByProfile[key] = { weights: fit.coef.map(v => +(v * 100).toFixed(1)), rms: +fit.rms.toFixed(3), s: +(2 * fit.n / fsLog).toFixed(1) }; } } } } }
    }
    // A6: derivative: govD = (Kd/Kp) dif_{d_filter/10}(P_unclamped) (both x1000)
    { const p0 = P.profiles[Object.keys(P.profiles)[0]];
        if (p0.d_gain > 0) { const Pu = Float64Array.from(x.govP), Dp = dif(Pu, P.d_filter / 10, fsLog), e = [];
            for (let i = 0; i < n; i++) if (active(i)) { const p = prof(i); const v = Math.max(-p.d_limit * 10, Math.min(p.d_limit * 10, p.d_gain / 1000 / (p.p_gain / 10) * Dp[i])); e.push(x.govD[i] - v); }
            row.derivative = { n: e.length, rms: +rms(e).toFixed(3), govDrms: +rms(Array.from({ length: n }, (_, i) => i).filter(active).map(i => x.govD[i])).toFixed(3) }; } }
    // B: throttle ramps by state (motor[0] per s; time parameter = 10000 / slope, in 0.1 s units)
    { const m = x['motor[0]'];
        const up = (st) => Array.from(s, (v, i) => v === st && i > 0 && m[i] >= m[i - 1] - 0.5);
        row.ramps = { idleStartup: ramps(t, m, Array.from(s, (v, i) => v === 1 && m[i] > 0), 0.5).filter(r => r.slopePerS > 0),
            spoolup: ramps(t, m, Array.from(s, v => v === 2), 0.8), recovery: ramps(t, m, Array.from(s, v => v === 3 || v === 8), 0.3),
            autorotationDown: ramps(t, m, Array.from(s, (v, i) => v === 7 && m[i] > 0), 0.3).filter(r => r.slopePerS < 0) };
        for (const k of Object.keys(row.ramps)) for (const r of row.ramps[k]) r.timeParam = +(10000 / Math.abs(r.slopePerS)).toFixed(1);
        // target ramps in ACTIVE (profile changes): slope of govTarget while govTarget != govRequest
        const tg = x.govTarget, ramp = Array.from(s, (v, i) => v === 4 && Math.abs(tg[i] - req[i]) > 20);
        row.targetRamps = ramps(t, tg, ramp, 0.3).map(r => Object.assign(r, { request: req[Math.round(r.toS * fsLog)] })); }
    // C: motor constant K (EWMA of HS / throttle as govMotorConstantUpdate) and the power margin
    { const Wt = (P.pidHz / (2 * Math.PI) + 0.05) / 0.05 / (P.pidHz / fsLog); let y = 0, N = 0; const K = new Float64Array(n);
        for (let i = 0; i < n; i++) { const thr = x['motor[0]'][i] / 1000, p = prof(i);
            if ((s[i] === 2 || s[i] === 4) && thr > 0.2 && p && hs[i] / req[i] > 0.2) { N = Math.min(N + 1, Wt); y += (hs[i] / thr - y) / N; } K[i] = y; }
        const byV = {}; for (let i = 0; i < n; i += 10) if (active(i) && x.Vbat && x.Vbat[i] > 0) { const v = Math.round(x.Vbat[i] / 50) * 0.5, k = (byV[v] = byV[v] || { n: 0, hsPerThr: 0, thr: 0, req: 0 });
            k.n++; k.hsPerThr += hs[i] / (x['motor[0]'][i] / 1000); k.thr += x['motor[0]'][i] / 1000; k.req += req[i]; }
        row.motorConstant = { kEnd: +K[n - 1].toFixed(0), activeByVbat: Object.fromEntries(Object.entries(byV).sort((a, b) => a[0] - b[0]).map(([v, k]) => [v, { s: +(k.n * 10 / fsLog).toFixed(1), meanThrottle: +(k.thr / k.n).toFixed(3), hsPerThrottle: +(k.hsPerThr / k.n).toFixed(0), hsPerThrottlePerVolt: +(k.hsPerThr / k.n / +v).toFixed(1), meanRequest: +(k.req / k.n).toFixed(0) }])) }; }
    // D: fallback events: logged headspeed jumps near each FALLBACK entry
    { const ev = []; for (let i = 1; i < n; i++) if (s[i] === 6 && s[i - 1] !== 6) { const a = Math.max(0, i - 300), b = Math.min(n, i + 300);
            const f = pt2(hs.subarray(Math.max(0, i - 3000), b), P.rpm_filter, fsLog), off = Math.max(0, i - 3000);
            let jump = 0, at = 0; for (let k = a; k < b; k++) { const d = Math.abs(hs[k] - f[k - off]); if (d > jump) { jump = d; at = k; } }
            let minHs = Infinity, j = i; while (j < n && j < i + 5000 && s[j] !== 4) { minHs = Math.min(minHs, hs[j]); j++; }
            let minAfter = Infinity; for (let k = i; k < Math.min(n, j + 2000); k++) minAfter = Math.min(minAfter, hs[k]);
            ev.push({ atS: +t[i].toFixed(3), hs: hs[i], request: req[i], motor: x['motor[0]'][i], maxJumpRpm: +jump.toFixed(0), jumpAtS: +t[at].toFixed(3), backToActiveS: +((j - i) / fsLog).toFixed(3),
                motorBefore: x['motor[0]'][i - 1], govIBefore: x.govI[i - 1], govFBefore: x.govF[i - 1], motorInFallback: x['motor[0]'][i], fallbackS: +(((s.indexOf(3, i) >= 0 ? s.indexOf(3, i) : i) - i) / fsLog).toFixed(3), motorAtRecoveryEntry: x['motor[0]'][Math.min(n - 1, (s.indexOf(3, i) >= 0 ? s.indexOf(3, i) : i))], hsAtRecoveryEntry: hs[Math.min(n - 1, (s.indexOf(3, i) >= 0 ? s.indexOf(3, i) : i))], targetAtRecoveryEntry: x.govTarget[Math.min(n - 1, (s.indexOf(3, i) >= 0 ? s.indexOf(3, i) : i))], minHsUntilActivePlus2s: minAfter, sagRpm: req[i] - minAfter }); }
        row.fallback = ev; }
    result.push(row);
}
console.log(JSON.stringify(result, null, 1));
