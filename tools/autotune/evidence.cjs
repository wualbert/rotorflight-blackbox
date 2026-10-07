'use strict';

/**
 * The part of the log that each finding comes from: spans in FRAME seconds (the viewer clock), the fields to show, and
 * what to plot against the limit (SPEC2 D1, 3.3).
 *
 *   timeMap(w)                the frame time of every RULE.every-th sample of a decoded segment (w.extra.time)
 *   toFrame(tm, t)            index time (w.fromS + i / actualRate, as the modules give times) to frame seconds
 *   locate(w, ctx, metrics)   worker side, while w is decoded: the blocks, windows and runs that the modules count but do
 *                             not time (G2, G9, G11, C8, C10, C11, F5, D5), recomputed with their own masks and RULE
 *                             values; counts equal the modules' counts, and a group whose count does not is dropped
 *   forFinding(f, ctx)        Evidence of one finding; ctx = { record | records (the segments of f.log: log, segment,
 *                             fromS, seconds, n?, header, metrics + metrics.locate, timeMap), others: { [log]: records },
 *                             curves, findings (for the fids of context spans) }
 *   forDecision(d, segments)  Evidence of a report.cjs gain decision (C7) from the extract.cjs segments
 *
 * Evidence = { v: 1, fid, id, log, profile, axis, phase, spans: [{ log, t0, t1, value, label, phase, profile }] (3 or
 *   fewer, worst first), view: { log, t0, t1, at, graphs, analyser } | null, plot: { kind, tab, curve, snippet, reference,
 *   rows?, points?, caption (one STE sentence: what the curves are and where the limit is, SPEC3 H) }, expected, summary, facts, context: [{ fid, id, t0, t1, label }] }
 * phase (SPEC2 D13): idle | spoolup | ground | flight | spooldown, from the phase spans of the record (rec.phases in frame
 * seconds, or health_phase.cjs spans in index samples), else the phase of the event or of the finding, else null.
 * profile (SPEC2 D12): the log profile label of the event or block, else of the finding; pidProfile: the PID profile 1-6
 * (the worker's f.pidProfile for the label of the finding, else a label 1-6), null when it is not known.
 * plot.snippet with fallback: true (review D-H3): a plot that draws a curve of the result, for a finding whose log has no
 * curves (ctx.curves null: the worker keeps the curves of the selected log only), also gets the raw fields of its span and
 * what to derive from them: { fields, derive: { kind, params } | null, fallback: true, reference }. plot.reference then has
 * the references in the units of those fields (T8, T13: permille). The UI draws the curve when it has one, else the snippet.
 * Spans of C14 (30 s blocks): the longest part in the flight phase, out of rescue, level modes, failsafe and ground contact.
 *
 * Why frame seconds: the modules time samples as w.fromS + i / actualRate. actualRate is the mean rate of the longest
 * stretch with no gap, and the frame clock drifts from it: about 0.6 ms for each second on the Gaui X4 #58 (196 ms at
 * 320 s), 70 ms at most on the Fireball #3 (critic.md section 3). The viewer seeks on the frame clock.
 */

const lib = require('./lib.cjs');
const C = require('./catalog.cjs');
const H = require('./hierarchy.cjs');
const optional = (name) => { try { return require(name); } catch (err) { return null; } };
const SETUP = optional('./health_setup.cjs'), GOV = optional('./health_gov.cjs'), LOOP = optional('./health_loop.cjs'), MORE = optional('./health_more.cjs');

const RULE = {
    every: 250,          // timeMap: one frame time for each this many samples (about 1300 values for a 330 s log at 1 kHz)
    jumpUs: 1000, maxJumps: 500, // timeMap: a frame interval 1 ms or more over the usual one (or one that does not increase) is a knot; the 500 largest are kept
    maxSpans: 3,         // spans of a finding, worst first
    overlap: 0.5,        // a span that overlaps a kept one by more than this part of the shorter one is dropped
    keep: 6,             // spans kept for each group in locate (profile, axis, band, line)
    maxPoints: 200,      // event points copied into a plot
    maxContext: 10,
    source: 'pipeline, unvalidated: the spans of a result are ranked by the statistic that the rule of its check tests, worst first. Times are frame seconds from the time field.',
};
const AXES = ['roll', 'pitch', 'yaw'];
const r3 = (v) => typeof v === 'number' && isFinite(v) ? +v.toFixed(3) : null;
const num = (v) => typeof v === 'number' && isFinite(v) ? v : null;
const quantile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))] : null; // health_gov.cjs
const top = (list, score, k) => list.map(x => [score(x), x]).filter(([s]) => num(s) !== null).sort((a, b) => b[0] - a[0]).slice(0, k).map(([, x]) => x);

// ---------------------------------------------------------------------------------------------
// Time base
// ---------------------------------------------------------------------------------------------

// Knots: samples 0, every, 2 every, ..., the last sample (endS), and both sides of each frame-time jump (a loop stall, lost
// frames, a time that does not increase) as [i, frame s of sample i - 1, frame s of sample i]: between two knots the frame
// clock is a straight line except at a jump, where a map without the jump is off by half of it (13 ms at the 26 ms stall
// of Gaui X4 #50). The same format as js/tuning_worker.js timeMapOf; Float32 seconds are 30 us or better at 500 s
function timeMap(w) {
    const n = w.n, rate = (w.flight && w.flight.actualRate) || w.rate, t = w.extra && w.extra.time, E = RULE.every, fromS = w.fromS || 0;
    const s = (i) => t ? fromS + (t[i] - t[0]) / 1e6 : fromS + i / rate, frameS = new Float32Array(Math.max(1, Math.ceil(n / E)));
    for (let k = 0; k < frameS.length; k++) frameS[k] = s(Math.min(k * E, Math.max(0, n - 1)));
    let jumps = [];
    if (t) { const dt = 1e6 / rate; for (let i = 1; i < n; i++) { const d = t[i] - t[i - 1]; if (d >= dt + RULE.jumpUs || d <= 0) jumps.push([i, r6(s(i - 1)), r6(s(i)), d]); } }
    if (jumps.length > RULE.maxJumps) jumps = jumps.sort((a, b) => Math.abs(b[3]) - Math.abs(a[3])).slice(0, RULE.maxJumps).sort((a, b) => a[0] - b[0]);
    return { fromS, every: E, actualRate: rate, n, frameS, endS: r6(s(Math.max(0, n - 1))), jumps: jumps.map(j => j.slice(0, 3)) };
}
const r6 = (v) => +v.toFixed(6);

// index time (s from the log start, fromS + i / actualRate) to frame seconds, through the knots of tm. Inside the segment
// the index is the nearest sample: module times are sample times rounded to 1 ms, and at a jump the sample decides the side
function toFrame(tm, t) {
    if (!tm || typeof t !== 'number' || !isFinite(t) || !tm.frameS || !tm.frameS.length) return t;
    const rate = tm.actualRate || tm.rate, E = tm.every, N = tm.frameS.length, last = Math.max(0, tm.n - 1), x = (t - tm.fromS) * rate, i = x > 0 && x < last ? Math.round(x) : x;
    const endS = typeof tm.endS === 'number' ? tm.endS : tm.frameS[N - 1] + (last - (N - 1) * E) / rate;
    if (i <= 0) return tm.frameS[0] + i / rate;
    if (i >= last) return endS + (i - last) / rate;
    const k = Math.min(N - 1, Math.floor(i / E));
    let a = k * E, sa = tm.frameS[k], b = k + 1 < N ? (k + 1) * E : last, sb = k + 1 < N ? tm.frameS[k + 1] : endS;
    for (const [j, s0, s1] of tm.jumps || []) { if (j <= a || j > b) continue; if (i >= j) { a = j; sa = s1; } else { b = j - 1; sb = s0; } }
    return b === a ? sa : sa + (i - a) / (b - a) * (sb - sa);
}

// ---------------------------------------------------------------------------------------------
// locate: the modules' sample sets, with times
// ---------------------------------------------------------------------------------------------

function runs(n, on) { const out = []; for (let i = 0; i < n;) { if (!on(i)) { i++; continue; } let j = i; while (j < n && on(j)) j++; out.push([i, j]); i = j; } return out; }
const hannOf = (() => { const c = new Map(); return (N) => { if (!c.has(N)) c.set(N, Float64Array.from({ length: N }, (_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1))))); return c.get(N); }; })();
// power at bin k of the mean-removed, Hann-windowed x[s .. s+N); the window times the cosine and sine of the bin, cached
const binTables = new Map();
function binPower(x, s, N, k) {
    const key = `${N}:${k}`; let t = binTables.get(key);
    if (!t) { const w = hannOf(N), d = 2 * Math.PI * k / N; t = { c: Float64Array.from(w, (v, i) => v * Math.cos(d * i)), s: Float64Array.from(w, (v, i) => -v * Math.sin(d * i)), w }; if (binTables.size > 64) binTables.clear(); binTables.set(key, t); }
    let m = 0; for (let i = 0; i < N; i++) m += x[s + i]; m /= N;
    let re = 0, im = 0; for (let i = 0; i < N; i++) { const v = x[s + i] - m; re += v * t.c[i]; im += v * t.s[i]; }
    return re * re + im * im;
}
const headerList = (h, k) => { const v = h && h[k]; if (Array.isArray(v)) return v.map(Number); if (typeof v === 'string') return v.split(',').map(Number); return typeof v === 'number' ? [v] : null; }; // health_gov header()

// health_gov.cjs analyse: settled, act, quiet, the error against the reference, then G2 blocks, G9 windows, G11 blocks
// and the in-flight samples below the cell minimum (D5)
function locateGov(w, ctx, M, out) {
    const R = GOV.RULE, n = w.n, rate = ctx.rate || w.rate, x = w.extra || {}, t0 = w.fromS || 0, T = (i) => t0 + i / rate, S = (k) => Math.round(k * rate);
    // the governor module saw ctx.flying, or the flying before the normal mask when the worker found too little normal flight
    // (js/tuning_worker.js passes it as ctx.flyingGov; without it, a loop module that did not run shows that case)
    const flying = ctx.flyingGov || ctx.govFlying || (M.loop === null && ctx.flyingAll ? ctx.flyingAll : ctx.flying), prof = ctx.profile, gs = ctx.govState || null, h = ctx.header || {}, hs = w.hs, tgt = x.govTarget, m = M.gov;
    const settled = new Uint8Array(n).fill(1), guard = S(R.settleS);
    for (let i = 1; i < n; i++) if (prof[i] !== prof[i - 1] || (gs && gs[i] !== gs[i - 1])) for (let j = Math.max(0, i - guard); j < Math.min(n, i + guard); j++) settled[j] = 0;
    const act = new Uint8Array(n); for (let i = 0; i < n; i++) act[i] = flying[i] && settled[i] && (!gs || gs[i] === 4) ? 1 : 0;
    const coll = x['mixer[3]'] || w.coll, cr = headerList(h, 'collectiveRange'), range = cr && cr.length === 2 && cr[1] > cr[0] ? cr[1] - cr[0] : 2500, quiet = new Uint8Array(n);
    if (coll) { const B = S(R.quiet.blockS), nb = Math.ceil(n / B), lo = new Float64Array(nb).fill(Infinity), hi = new Float64Array(nb).fill(-Infinity);
        for (let i = 0; i < n; i++) { const b = (i / B) | 0; if (coll[i] < lo[b]) lo[b] = coll[i]; if (coll[i] > hi[b]) hi[b] = coll[i]; }
        for (let b = 0; b < nb; b++) { const a = Math.max(0, b - 1), c = Math.min(nb - 1, b + 1), sw = Math.max(hi[a], hi[b], hi[c]) - Math.min(lo[a], lo[b], lo[c]);
            if (sw < R.quiet.swing * range) for (let i = b * B; i < Math.min(n, (b + 1) * B); i++) quiet[i] = 1; } }
    const profiles = [...new Set(Array.from(prof).filter((p, i) => flying[i]))].sort((a, b) => a - b), governed = !!(m.G0 && m.G0.mode === 'PID (ELECTRIC/NITRO)');
    const medHs = {}; for (const p of profiles) { const v = []; for (let i = 0; i < n; i += 5) if (act[i] && prof[i] === p) v.push(hs[i]); v.sort((a, b) => a - b); medHs[p] = quantile(v, 0.5); }
    const ref = (i) => governed && tgt ? tgt[i] : medHs[prof[i]];
    const err = new Float64Array(n); for (let i = 0; i < n; i++) { const t = ref(i); err[i] = t > 0 ? (hs[i] - t) / t : 0; }
    // G2: 2 s blocks with half their samples steady on the profile; value = the block median error
    if (m.G2 && m.G2.byProfile) { const B = S(R.g2.blockS), counts = {};
        for (const p of profiles) { const blocks = [];
            for (let b = 0; b + B <= n; b += B) { const bv = []; for (let i = b; i < b + B; i++) if (act[i] && quiet[i] && prof[i] === p) bv.push(err[i]);
                if (bv.length >= B / 2) { bv.sort((a, c) => a - c); blocks.push({ t0: T(b), t1: T(b + B), profile: p, value: quantile(bv, 0.5) }); } }
            counts[p] = blocks.length; out.G2.push(...top(blocks, (q) => Math.abs(q.value), RULE.keep)); }
        out.counts.G2 = counts;
        for (const p of profiles) check(out, 'G2', p, counts[p], m.G2.byProfile[p] ? m.G2.byProfile[p].blocks || 0 : undefined); }
    // G9: decimated error with the frame rotation removed, windows of N decimated samples on one profile; ranked by the
    // power at the peak of each band (I, P) of the profile
    if (m.G9 && m.G9.byProfile) {
        const D = R.g9.decimate, N = R.g9.N, md = Math.floor(n / D), fs = rate / D, df = fs / N, sign = m.frameRotation ? m.frameRotation.sign || 0 : 0;
        const e = new Float64Array(md), okD = new Uint8Array(md), pD = new Uint8Array(md), counts = {};
        for (let k = 0; k < md; k++) { let s = 0, ok = 1; for (let i = k * D; i < (k + 1) * D; i++) { const t = ref(i); s += t > 0 ? (hs[i] + sign * w.gyro[2][i] / 6 - t) / t : 0; if (!act[i] || prof[i] !== prof[k * D]) ok = 0; } e[k] = s / D; okD[k] = ok; pD[k] = prof[k * D]; }
        const wsum = hannOf(N).reduce((a, v) => a + v, 0);
        for (const p of profiles) { const wins = [];
            for (let s = 0; s + N <= md; s += N / 2) { let ok = true; for (let k = s; k < s + N && ok; k++) if (!okD[k] || pD[k] !== p) ok = false; if (ok) wins.push(s); }
            counts[p] = wins.length;
            for (const band of Object.keys(R.g9.bands)) { const b = m.G9.byProfile[p] && m.G9.byProfile[p][band]; if (!b || num(b.hz) === null) continue; const kb = Math.round(b.hz / df);
                out.G9.push(...top(wins.map(s => ({ t0: T(s * D), t1: T((s + N) * D), profile: p, band, hz: b.hz, value: 2 * Math.sqrt(binPower(e, s, N, kb)) / wsum })), (q) => q.value, RULE.keep)); } }
        out.counts.G9 = counts;
        for (const p of profiles) check(out, 'G9', p, counts[p], m.G9.byProfile[p] ? m.G9.byProfile[p].windows : undefined); }
    // G11: 2 s blocks almost all steady; the throttle of each
    const mot = x['motor[0]'];
    if (mot && m.G11 && !m.G11.skipped) { const B = S(R.g11.blockS), blocks = [];
        for (let b = 0; b + B <= n; b += B) { let c = 0, sm = 0; for (let i = b; i < b + B; i++) { if (act[i] && quiet[i] && prof[i] === prof[b]) c++; sm += mot[i]; } if (c < R.g11.cover * B) continue;
            blocks.push({ t0: T(b), t1: T(b + B), profile: prof[b], value: sm / B / 10 }); }
        out.counts.G11 = blocks.length; check(out, 'G11', 'all', blocks.length, m.G11.blocks);
        out.G11 = blocks.length > 3 ? [blocks[0], blocks[blocks.length >> 1], blocks[blocks.length - 1]] : blocks; }
    // D5: in-flight samples in the histogram bins at or below the cell minimum, as runs
    const vb = x.Vbat, d5 = m.D5;
    if (vb && d5 && !d5.skipped && d5.cellHistogram && d5.cells) {
        const Hh = d5.cellHistogram, len = Hh.counts.length, minCell = GOV.DEFAULT_RULES && GOV.DEFAULT_RULES.D5 ? GOV.DEFAULT_RULES.D5.minCell : 3, cells = d5.cells;
        const below = (i) => { if (!flying[i]) return false; const k = Math.min(len - 1, Math.max(0, Math.floor((vb[i] / 100 / cells - Hh.from) / Hh.step + 1e-9))); return Hh.from + (k + 1) * Hh.step <= minCell + 1e-9; };
        let count = 0; for (let i = 0; i < n; i++) if (below(i)) count++;
        const want = Hh.counts.reduce((a, c, k) => a + (Hh.from + (k + 1) * Hh.step <= minCell + 1e-9 ? c : 0), 0);
        out.counts.D5 = count; check(out, 'D5', 'all', count, want);
        out.D5 = top(runs(n, below).map(([a, b]) => ({ t0: T(a), t1: T(b), value: (b - a) / rate, minCell })), (q) => q.value, RULE.keep); }
}
function check(out, id, key, mine, module) { if (module === undefined) return; if (mine !== module) out.mismatch.push({ id, key: String(key), mine, module }); }

// health_loop.cjs limitOf / atLimit
function limitOf(v, ok, tol, band, samples) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < v.length; i++) if (ok[i]) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
    if (!isFinite(lo)) return null;
    let atLo = 0, atHi = 0, nearLo = 0, nearHi = 0;
    for (let i = 0; i < v.length; i++) if (ok[i]) { const x = v[i]; if (x <= lo + tol) atLo++; else if (x <= lo + band) nearLo++; if (x >= hi - tol) atHi++; else if (x >= hi - band) nearHi++; }
    return { min: lo, max: hi, atMax: atHi, lo: atLo >= samples && atLo >= nearLo ? lo : null, hi: atHi >= samples && atHi >= nearHi ? hi : null };
}
const atLimit = (L, v, tol) => L && ((L.lo !== null && v <= L.lo + tol) || (L.hi !== null && v >= L.hi - tol));

// health_loop.cjs analyse: the usable mask, then C8 windows, C10 spans (with the cyclic saturation mask) and C11 windows
function locateLoop(w, ctx, M, out) {
    const R = LOOP.RULE, m = M.loop, n = w.n, rate = ctx.rate || w.rate, t0 = w.fromS || 0, T = (i) => t0 + i / rate, S = (sec) => Math.max(1, Math.round(sec * rate));
    const prof = ctx.profile, gov = ctx.govState, X = w.extra || {}, H0 = ctx.header || (w.flight && w.flight.header) || {}, ok = new Uint8Array(n), guard = S(R.guardS);
    for (let i = 0; i < n; i++) ok[i] = ctx.flying[i] && (!gov || gov[i] === 4) ? 1 : 0;
    for (let i = 1; i < n; i++) if (prof[i] !== prof[i - 1] || (gov && gov[i] !== gov[i - 1])) ok.fill(0, Math.max(0, i - guard), Math.min(n, i + guard));
    const all = (i0, i1) => { for (let i = i0; i < i1; i++) if (!ok[i]) return false; return true; }, same = (i0, i1) => { for (let i = i0 + 1; i < i1; i++) if (prof[i] !== prof[i0]) return false; return true; };
    // C8: roll stick quiet, pitch stick moving; ranked by the power of the pitch stick rate
    if (m.C8 && m.C8.byProfile) { const Q = R.cross, N = S(Q.windowS), counts = {}, list = [];
        const dsp = new Float64Array(n); for (let i = 1; i < n - 1; i++) dsp[i] = (w.sp[1][i + 1] - w.sp[1][i - 1]) * rate / 2;
        for (let s = 0; s + N <= n; s += N >> 1) {
            if (!all(s, s + N) || !same(s, s + N)) continue;
            let mx = 0, lo = Infinity, hi = -Infinity, pw = 0; for (let i = s; i < s + N; i++) { mx = Math.max(mx, Math.abs(w.sp[0][i])); const v = w.sp[1][i]; if (v < lo) lo = v; if (v > hi) hi = v; pw += dsp[i] * dsp[i]; }
            if (mx > Q.quiet || hi - lo < Q.quiet) continue;
            counts[prof[s]] = (counts[prof[s]] || 0) + 1; list.push({ t0: T(s), t1: T(s + N), profile: prof[s], value: Math.sqrt(pw / N) }); }
        out.counts.C8 = counts;
        for (const p of new Set(Object.keys(counts).concat(Object.keys(m.C8.byProfile)))) check(out, 'C8', p, counts[p] || 0, m.C8.byProfile[p] ? m.C8.byProfile[p].windows : 0);
        for (const p of Object.keys(counts)) out.C8.push(...top(list.filter(q => String(q.profile) === p), (q) => q.value, RULE.keep)); }
    // C10: stick-quiet 0.1 s spans per axis, profile and collective bin, off the cyclic limits; runs of them
    if (m.C10 && !m.C10.skipped && w.coll) {
        const tolU = R.limitTol, L = (v, okm, tol, band) => limitOf(v, okm, tol, band, R.limitSamples), lim = { roll: L(w.u[0], ok, tolU, R.limitBand), pitch: L(w.u[1], ok, tolU, R.limitBand) };
        const hyp = Float64Array.from(w.u[0], (v, i) => Math.hypot(v, w.u[1][i]));
        { const okR = Uint8Array.from(ok, (v, i) => v && !atLimit(lim.roll, w.u[0][i], tolU) && !atLimit(lim.pitch, w.u[1][i], tolU) ? 1 : 0); const Lr = L(hyp, okR, R.ringTol, R.limitBand); lim.ring = Lr && { hi: Lr.hi }; }
        lim.servo = [0, 1, 2].map(k => X[`servo[${k}]`] ? L(X[`servo[${k}]`], ok, R.servoTol, R.servoBand) : null);
        const m3 = X['mixer[3]'] || w.coll, cr = Array.isArray(H0.collectiveRange) ? H0.collectiveRange : null;
        lim.collective = m3 ? L(m3, ok, 1, R.collBand) : null;
        if (lim.collective && cr) { lim.collective.lo = lim.collective.min <= cr[0] + 1 ? cr[0] : null; lim.collective.hi = lim.collective.max >= cr[1] - 1 ? cr[1] : null; }
        const atCyc = (i) => atLimit(lim.roll, w.u[0][i], tolU) || atLimit(lim.pitch, w.u[1][i], tolU) || (lim.ring && lim.ring.hi !== null && hyp[i] >= lim.ring.hi - R.ringTol)
            || [0, 1, 2].some(k => lim.servo[k] && atLimit(lim.servo[k], X[`servo[${k}]`][i], R.servoTol)) || (lim.collective && atLimit(lim.collective, m3[i], 1));
        const sat = new Uint8Array(n), hold = S(R.satHoldS); for (let i = 0; i < n; i++) if (atCyc(i)) sat.fill(1, i, Math.min(n, i + hold + 1));
        // a span counts for (profile, bin) when every sample of it, both ends included, is usable, off the limits, stick-quiet,
        // in that collective bin and on that profile (health_loop C10 loop); one pass for each axis over a code of each sample
        const D = R.decay, span = S(D.spanS), nb = D.bins.length - 1, counts = {}, profiles = [...new Set(prof)].map(String);
        const binOf = (c) => { for (let b = 0; b < nb; b++) if (c >= D.bins[b] && c < D.bins[b + 1]) return b; return -1; };
        for (const a of [0, 1]) { const ax = AXES[a], byP = counts[ax] = {}, good = {}, code = new Int8Array(n);
            for (let i = 0; i < n; i++) code[i] = ok[i] && !sat[i] && Math.abs(w.sp[a][i]) <= D.quiet ? binOf(Math.abs(w.coll[i]) * R.degPerUnit) : -1;
            for (const p of profiles) good[p] = Array.from({ length: nb }, () => []);
            for (let s = 0; s + span < n; s += span) { const b = code[s], p = prof[s]; if (b < 0) continue; let g = true; for (let i = s + 1; i <= s + span && g; i++) g = code[i] === b && prof[i] === p; if (g) good[String(p)][b].push(s); }
            for (const p of profiles) { byP[p] = good[p].map(l => l.length);
                good[p].forEach((list, b) => { const lo = D.bins[b], hi = D.bins[b + 1], rr = [];
                    for (const s of list) { const last = rr[rr.length - 1]; if (last && last.e === s) last.e = s + span; else rr.push({ s, e: s + span }); }
                    out.C10.push(...top(rr.map(q => ({ t0: T(q.s), t1: T(q.e), axis: ax, profile: +p, bin: [lo, hi], value: (q.e - q.s) / rate })), (q) => q.value, RULE.keep));
                    const mb = m.C10[ax] && m.C10[ax].byProfile[p] && m.C10[ax].byProfile[p].bins[b]; check(out, 'C10', `${ax}:${p}:${lo}-${hi}`, list.length, mb ? mb.spans : undefined); }); } }
        out.counts.C10 = counts; }
    // C11: 1 s windows on one profile; the share of axisD power above the high-pass
    if (m.C11) { const Q = R.dNoise, N = S(Q.windowS), counts = {};
        for (const a of [0, 1, 2]) { const ax = AXES[a], D = w.D[a]; if (!D || !D.some(v => v !== 0) || Q.hz >= 0.45 * rate || !m.C11[ax] || m.C11[ax].skipped) continue;
            const hp = lib.bandpass(D, Q.hz, 0.45 * rate, rate), byP = counts[ax] = {}, list = [];
            for (let s = 0; s + N <= n; s += N) { if (!all(s, s + N) || !same(s, s + N)) continue;
                let mm = 0; for (let i = s; i < s + N; i++) mm += D[i]; mm /= N; let tot = 0, hi = 0; for (let i = s; i < s + N; i++) { tot += (D[i] - mm) ** 2; hi += hp[i] ** 2; }
                if (!tot) continue; byP[prof[s]] = (byP[prof[s]] || 0) + 1; list.push({ t0: T(s), t1: T(s + N), axis: ax, profile: prof[s], value: hi / tot }); }
            for (const p of new Set(Object.keys(byP).concat(Object.keys(m.C11[ax].byProfile || {})))) check(out, 'C11', `${ax}:${p}`, byP[p] || 0, m.C11[ax].byProfile && m.C11[ax].byProfile[p] ? m.C11[ax].byProfile[p].windows : 0);
            for (const p of Object.keys(byP)) out.C11.push(...top(list.filter(q => String(q.profile) === p), (q) => q.value, RULE.keep)); }
        out.counts.C11 = counts; }
}

// health_setup.cjs orderSpectra: windows of RULE.order.revolutions revolutions in flight at a steady headspeed; ranked for
// each line of the profile (the flagged ones and the strongest) by the raw gyro power at its order
function locateF5(w, ctx, M, out) {
    const O = SETUP.RULE.order, m = M.setup, x = w.extra || {}, raw = [0, 1, 2].map(a => x[`gyroRAW[${a}]`] || null);
    if (!m.F5 || m.F5.skipped || !raw.every(Boolean)) return;
    const n = w.n, rate = (w.flight && w.flight.actualRate) || w.rate, t0 = w.fromS || 0, flying = ctx.flying || new Uint8Array(n), profile = ctx.pidLabels || ctx.profile || w.profileAt, gov = ctx.govState; // F5 of health_setup: the PID profile labels
    const N = O.perRev * O.revolutions, R = lib.byRevolution(w.hs, rate, raw, O.perRev), wins = [], counts = {};
    for (let s = 0; s + N <= R.M; s += N / 2) {
        const i0 = R.index[s], i1 = R.index[s + N - 1], pr = profile[i0]; let ok = true, lo = Infinity, hi = -Infinity;
        for (let j = s; j < s + N && ok; j += 16) { const i = R.index[j]; if (!flying[i] || profile[i] !== pr || (gov && gov[i] !== SETUP.RULE.activeGovState)) ok = false; const v = w.hs[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (!ok || hi - lo > O.steadyRpm) continue;
        counts[pr] = (counts[pr] || 0) + 1; wins.push({ s, t0: t0 + i0 / rate, t1: t0 + i1 / rate, profile: pr });
    }
    out.counts.F5 = counts;
    for (const p of m.F5.profiles || []) check(out, 'F5', p.profile, counts[p.profile] || 0, p.windows);
    const F = SETUP.DEFAULT_RULES.F5;
    for (const p of Object.keys(counts).map(Number)) {
        const lines = (m.F5.lines || []).filter(l => l.profile === p), bad = lines.filter(l => l.prominence >= F.minProminence && l.axes.some(a => a.amplitude > 0 && (!a.nearestNotch || a.nearestNotch.distance > F.maxDistance)));
        const strongest = lines.slice().sort((a, b) => b.prominence - a.prominence)[0], pick = bad.slice(0, 3).concat(strongest && !bad.includes(strongest) ? [strongest] : []);
        for (const l of pick) { const k = Math.round(l.order * O.revolutions);
            out.F5.push(...top(wins.filter(q => q.profile === p).map(q => ({ t0: q.t0, t1: q.t1, profile: p, order: l.order, hz: l.hz, value: Math.sqrt(raw.reduce((a, _, ai) => a + binPower(R.columns[ai], q.s, N, k), 0)) / (N / 4) })), (q) => q.value, RULE.keep)); }
    }
}

const GROUPS = ['G2', 'G9', 'G11', 'D5', 'C8', 'C10', 'C11', 'F5'];
function locate(w, ctx, metrics) {
    const M = metrics || {}, out = { v: 1, n: w.n, fromS: r3(w.fromS || 0), G2: [], G9: [], G11: [], C8: [], C10: [], C11: [], F5: [], D5: [], counts: {}, mismatch: [], errors: [] };
    const parts = [['gov', GOV && M.gov && !M.gov.skipped, locateGov], ['loop', LOOP && M.loop && !M.loop.skipped, locateLoop], ['setup', SETUP && M.setup, locateF5]];
    for (const [name, on, fn] of parts) { if (!on) continue; try { fn(w, ctx, M, out); } catch (err) { out.errors.push(`${name}: ${err && err.message || err}`); } }
    // a group whose count is not the module's would put spans in the wrong place: its spans go
    for (const id of new Set(out.mismatch.map(q => q.id))) if (GROUPS.includes(id)) out[id] = [];
    for (const k of GROUPS) out[k] = out[k].map(q => Object.assign({}, q, { t0: r3(q.t0), t1: r3(q.t1), value: num(q.value) === null ? null : +q.value.toPrecision(5) }));
    return out;
}

// ---------------------------------------------------------------------------------------------
// forFinding
// ---------------------------------------------------------------------------------------------

const logsOf = (f) => Array.isArray(f.log) ? f.log : f.log === null || f.log === undefined ? [] : [f.log];
function recordsOf(ctx, log) {
    const own = ctx.records || (ctx.record ? [ctx.record] : []), other = ctx.others && ctx.others[log];
    const list = own.filter(r => r && (log === undefined || r.log === log || r.log === undefined));
    return list.length ? list : Array.isArray(other) ? other : other ? [other] : [];
}
// the index-time range of a record (a segment): [fromS, fromS + n / actualRate]
const spanOf = (rec) => { const tm = rec.timeMap, n = num(rec.n) !== null ? rec.n : tm ? tm.n : null, rate = tm ? tm.actualRate || tm.rate : num(rec.actualRate), s = num(rec.seconds), a = num(rec.fromS) || 0;
    return [a, a + (n !== null && rate ? n / rate : s !== null ? s : Infinity)]; };
const mt = (rec, mod) => rec && rec.metrics && rec.metrics[mod] ? rec.metrics[mod] : null;
const loc = (rec) => rec && rec.metrics && rec.metrics.locate ? rec.metrics.locate : null;
const sameProfile = (a, b) => b === null || b === undefined || +a === +b;
// A candidate span: its core [c0, c1] in index time (an event from its time to its end, a block, a window), the pads
// [p0, p1] added in frame seconds around it, the record it belongs to, its statistic (value) and the score it is ranked by
// (rank, the value when not given: larger is worse)
const cand = (rec, c0, c1, p0, p1, value, raw, label, rank) => ({ c0, c1: num(c1) !== null && c1 >= c0 ? c1 : c0, p0: p0 || 0, p1: p1 || 0, rec, value: num(value), rank: num(rank === undefined ? value : rank), raw: raw || null, label: label || null });
// a candidate whose times are frame seconds already (flights, phase spans)
const frameCand = (rec, t0, t1, value, raw, label, rank) => Object.assign(cand(rec, t0, t1, 0, 0, value, raw, label, rank), { frame: true });
// events {t, seconds?}: score ranks them, stat (score when not given) is the value shown
const fromEvents = (rec, list, pads, score, label, end, stat) => (Array.isArray(list) ? list : []).filter(e => e && num(e.t) !== null)
    .map(e => cand(rec, e.t, end ? end(e) : e.t + (num(e.seconds) || 0), pads[0], pads[1], stat ? stat(e) : score(e), e, label ? label(e) : null, score(e)));
// blocks and windows {t0, t1, value}; a block with runs (health_track) shows its longest run of usable samples
const fromSpans = (rec, list, keep) => (Array.isArray(list) ? list : []).filter(q => q && num(q.t0) !== null && (!keep || keep(q)))
    .map(q => { const run = Array.isArray(q.runs) && q.runs.length && Array.isArray(q.runs[0]) ? q.runs[0] : null; return cand(rec, run ? run[0] : q.t0, run ? run[1] : num(q.t1) !== null ? q.t1 : q.t0, 0, 0, q.value, q); });
const D2_LABEL = [[/^loop stall/, 'Loop stall'], [/^time jump/, 'Sudden time change'], [/^time not increasing/, 'Time does not increase'], [/^loopIteration jump/, 'Loop count change']];
const d2Label = (e) => (D2_LABEL.find(([re]) => re.test(String(e.kind || ''))) || [null, 'Frame interval'])[1];
const REASON = { failsafe: 'Failsafe', rescue: 'Rescue', levelMode: 'Level mode', ground: 'Ground contact' };

// the facts of a finding that its fields do not hold, from the metrics of its records (no text is read)
function factsOf(f, recs) {
    const x = {}, rec = recs[0], p = f.profile;
    if (f.id === 'D2') x.counts = C.gapCounts(f.events || (mt(rec, 'setup') && mt(rec, 'setup').D2 && mt(rec, 'setup').D2.events));
    // F5: each axis with a peak (amplitude > 0, as the health_setup flag rule): near when its nearest notch filter is in
    // ±maxDistance, with that notch filter's frequency at the line's headspeed (review D-M5a: a statement for each axis)
    if (f.id === 'F5') { const pass = Array.isArray(f.filterPass) && f.filterPass[0], dist = C.rulesOf(f, C.CHECKS.F5).maxDistance, d = num(dist) !== null ? dist : 0.02, line = (mt(rec, 'setup') && mt(rec, 'setup').F5 && mt(rec, 'setup').F5.lines || []).find(l => l.profile === p && l.order === f.value);
        x.hz = pass && num(pass.hz) !== null ? pass.hz : line ? line.hz : null;
        if (line && num(line.prominence) !== null) x.prominence = line.prominence;   // the quantity that the F5 rule compares (review V5)
        if (line) { x.axes = line.axes.filter(q => q && num(q.amplitude) > 0).map(q => { const nn = q.nearestNotch;
                return { axis: q.axis, near: !!nn && num(nn.distance) !== null && nn.distance <= d, distance: nn ? num(nn.distance) : null, code: nn ? nn.code : null,
                    hz: nn && num(nn.order) !== null && num(line.headspeed) !== null ? +(nn.order * line.headspeed / 60).toFixed(1) : null }; });
            const far = x.axes.find(q => !q.near); x.axis = far ? far.axis : null; } }
    if (f.id === 'T8' || f.id === 'T15') for (const rc of recs) { const L = mt(rc, 'loop') && mt(rc, 'loop').T8 && mt(rc, 'loop').T8.limits && mt(rc, 'loop').T8.limits.yaw;
        if (L) { const pm = (v) => num(v) === null ? null : +(v * 1000).toFixed(1); x.tailLimits = { lo: pm(L.limitLow), hi: pm(L.limitHigh) }; break; } } // mixer[2] in permille, as the log records it
    if (f.id === 'T13') for (const rc of recs) { const g = mt(rc, 'more') && mt(rc, 'more').T13 && mt(rc, 'more').T13.byProfile && mt(rc, 'more').T13.byProfile[p];
        if (g && num(g.authorityPermille) !== null) { x.authorityPermille = g.authorityPermille; x.iPermille = num(g.iPermille); break; } }
    if (f.id === 'F6') for (const rc of recs) { const row = (mt(rc, 'setup') && mt(rc, 'setup').F6 && mt(rc, 'setup').F6.rows || []).find(q => q.profile === p && q.db === f.value && q.se === f.se && q.n === f.n);
        if (row) { Object.assign(x, { axis: row.axis, hz: row.hz, code: row.code, q: row.q, kind: row.kind, harmonic: row.harmonic, headspeed: row.headspeed }); x.row = row; break; } }
    if (f.id === 'G9') for (const rc of recs) { const g = mt(rc, 'gov') && mt(rc, 'gov').G9 && mt(rc, 'gov').G9.byProfile && mt(rc, 'gov').G9.byProfile[p];
        if (g) for (const band of ['I', 'P']) if (g[band] && g[band].prominence === f.value && (f.se === null || f.se === undefined || g[band].prominenceSe === f.se)) { x.band = band; x.hz = g[band].hz; } if (x.band) break; }
    if (f.id === 'G6') { const R = C.rulesOf(f, C.CHECKS.G6); for (const rc of recs) { const g = mt(rc, 'gov') && mt(rc, 'gov').G6 && mt(rc, 'gov').G6.byProfile && mt(rc, 'gov').G6.byProfile[p];
        if (g && Array.isArray(g.runs)) { x.runs = g.runs.filter(q => q.value >= R.runS && q.deficit !== null && q.deficit > R.deficit).length; break; } } }
    if (f.id === 'D5' && f.severity === 'flag') { const d = mt(rec, 'gov') && mt(rec, 'gov').D5; x.kind = d && num(d.maxStep) !== null && Math.abs(Math.abs(f.value) - Math.abs(d.maxStep)) < 1e-9 ? 'step' : 'low'; }
    if (f.id === 'C10' && f.axis) for (const rc of recs) { const g = mt(rc, 'loop') && mt(rc, 'loop').C10 && mt(rc, 'loop').C10[f.axis] && mt(rc, 'loop').C10[f.axis].byProfile[p];
        const b = g && g.bins.find(q => q.spans === f.n && (q.tauS === f.value || q.lambdaPerS === f.value)); if (b) { x.bin = b.collectiveDeg.join('-'); x.binRange = b.collectiveDeg; break; } }
    return x;
}

// ---------------------------------------------------------------------------------------------
// Flight phases (SPEC2 D13): the phase of every span when the record has its phase spans
// ---------------------------------------------------------------------------------------------

const PHASES = ['idle', 'spoolup', 'ground', 'flight', 'spooldown'];
const PHASE_LABEL = { idle: 'IDLE', spoolup: 'Spool-up', ground: 'Ground', flight: 'Flight', spooldown: 'Spool-down' };
// The phase spans of a record in frame seconds, from rec.phases (js/tuning_worker.js) or the health_phase metrics
// (rec.metrics.phase.phases, analyse), as a list or as { spans }. A span with samples i0, i1 (health_phase.cjs phases)
// goes through the time map of the record; a span with t0, t1 only is in frame seconds already (the worker's)
const sampleFrame = (rec, i) => { const tm = rec.timeMap, rate = tm ? tm.actualRate || tm.rate : num(rec.actualRate); return rate ? r3(toFrame(tm, (num(rec.fromS) || 0) + i / rate)) : null; };
function phaseSpansOf(rec) {
    if (!rec) return [];
    const m = rec.metrics && rec.metrics.phase, P = rec.phases || (m && (m.phases || m)) || null, list = Array.isArray(P) ? P : P && Array.isArray(P.spans) ? P.spans : [];
    return list.filter(q => q && PHASES.includes(q.phase)).map(q => num(q.i0) !== null && num(q.i1) !== null && sampleFrame(rec, 0) !== null ? { phase: q.phase, t0: sampleFrame(rec, q.i0), t1: sampleFrame(rec, q.i1) }
        : num(q.t0) !== null && num(q.t1) !== null ? { phase: q.phase, t0: q.t0, t1: q.t1 } : null).filter(Boolean);
}
// the phase with the largest overlap of [t0, t1] (frame seconds); a point takes the phase that holds it
function phaseAt(spans, t0, t1) {
    let best = null, most = -1;
    for (const q of spans) { const o = Math.min(q.t1, t1) - Math.max(q.t0, t0); if (o > most && (o > 0 || (t0 === t1 && t0 >= q.t0 && t0 <= q.t1))) { most = o; best = q.phase; } }
    return best;
}
const phaseOfFinding = (f) => typeof f.phase === 'string' && PHASES.includes(f.phase) ? f.phase : null;
// G17 events (health_phase.cjs kicks kind)
const KIND_LABEL = { 'motor step': 'Sudden motor step', 'rotor turns with no motor output': 'Rotor turns with no motor output', 'headspeed step': 'Sudden headspeed step', 'headspeed decrease': 'Sudden headspeed decrease' };

// D7: the flights of the log, longest first: rec.flights of the worker (frame seconds, SPEC2 D13), else the flight phase
// spans of the records, else the flights of the finding (health_phase.cjs: index times, as all module times)
const span2 = (q) => q && num(q.t0) !== null && num(q.t1) !== null;
function flightCands(f, recs) {
    const own = recs.flatMap(rec => (Array.isArray(rec.flights) ? rec.flights : []).filter(span2).map(q => frameCand(rec, q.t0, q.t1, q.t1 - q.t0, q, PHASE_LABEL.flight)));
    if (own.length) return own;
    const ph = recs.flatMap(rec => phaseSpansOf(rec).filter(q => q.phase === 'flight').map(q => frameCand(rec, q.t0, q.t1, q.t1 - q.t0, q, PHASE_LABEL.flight)));
    if (ph.length) return ph;
    const recAt = (t) => recs.find(r => { const [a, b] = spanOf(r); return t >= a - 1e-3 && t <= b + 0.05; }) || recs[0] || null;
    return (Array.isArray(f.flights) ? f.flights : []).filter(span2).map(q => cand(recAt(q.t0), q.t0, q.t1, 0, 0, q.t1 - q.t0, q, PHASE_LABEL.flight));
}
// A check with no entry in CAND (G15-G18, C15 and the checks that come later): the events of the finding, or of its
// metrics (rec.metrics[module][id]), each in the record whose time range holds it; else its blocks or windows
// (worst, spans: { t0, t1, value }); else its times. Ranked by the size of the value
function genericCands(f, recs, c) {
    const pads = c.evidence.pads || [0, 0], out = [], recAt = (t) => recs.find(r => { const [a, b] = spanOf(r); return t >= a - 1e-3 && t <= b + 0.05; }) || recs[0] || null;
    const ownEvents = Array.isArray(f.events) ? f.events.filter(e => e && num(e.t) !== null) : null, ownSpans = Array.isArray(f.worst) ? f.worst : Array.isArray(f.spans) ? f.spans : null;
    const evc = (rec, e) => cand(rec, e.t, num(e.t1) !== null ? e.t1 : e.t + (num(e.seconds) || num(e.settleS) || 0), pads[0], pads[1], e.value, e, KIND_LABEL[e.kind] || null, num(e.rank) !== null ? e.rank : Math.abs(num(e.value) || 0)); // rank: an event that gives its own (T15: the signed increase)
    if (ownEvents) return ownEvents.map(e => evc(recAt(e.t), e));
    if (ownSpans) return fromSpans(null, ownSpans).map(q => Object.assign(q, { rec: recAt(q.c0), rank: Math.abs(q.value || 0) }));
    for (const rec of recs) { const m = mt(rec, c.module), g = m && m[f.id];
        if (!g || g.skipped) continue;
        const p = (q) => sameProfile(q.profile === undefined ? null : q.profile, f.profile) && (!f.axis || !q.axis || q.axis === f.axis);
        if (Array.isArray(g.events)) out.push(...g.events.filter(e => e && num(e.t) !== null && p(e)).map(e => evc(rec, e)));
        const sp = Array.isArray(g.worst) ? g.worst : Array.isArray(g.spans) ? g.spans : null;
        if (sp) out.push(...fromSpans(rec, sp, p).map(q => Object.assign(q, { rank: Math.abs(q.value || 0) }))); }
    if (out.length) return out;
    return (Array.isArray(f.times) ? f.times : []).filter(t => num(t) !== null).map(t => cand(recAt(t), t, t, pads[0], pads[1], f.value, null, null, 0));
}

const minCell = (rec, d) => num(d.minCellT) !== null ? [cand(rec, d.minCellT, d.minCellT, 5, 5, null, null, 'Lowest cell voltage')] : [];
const runEnd = (e) => e.t + (num(e.value) || 0);       // G6 runs, G1 and G14 entries: value is the seconds
// per check: the candidate spans, each with the record it belongs to (evidence.md sections 2-5)
const CAND = {
    D2: (f, recs) => recs.flatMap(rec => fromEvents(rec, f.events || (mt(rec, 'setup') && mt(rec, 'setup').D2 && mt(rec, 'setup').D2.events), [0.25, 0.25], (e) => num(e.dtMs) !== null ? e.dtMs : e.value, d2Label)),
    D5: (f, recs, x) => recs.flatMap(rec => { const d = mt(rec, 'gov') && mt(rec, 'gov').D5; if (!d || d.skipped) return [];
        const low = loc(rec) ? fromSpans(rec, loc(rec).D5) : [], step = fromEvents(rec, d.steps, [1, 1], (e) => Math.abs(e.value)), R = C.rulesOf(f, C.CHECKS.D5);
        return x.kind === 'low' ? low.concat(minCell(rec, d)) : x.kind === 'step' ? step.filter(c => c.value > (R.step || 0)) : step.concat(minCell(rec, d)); }),
    G13: (f, recs) => recs.flatMap(rec => { const d = mt(rec, 'gov') && mt(rec, 'gov').D5; return (loc(rec) ? fromSpans(rec, loc(rec).D5) : []).concat(d && !d.skipped ? minCell(rec, d) : []); }),
    G1: (f, recs) => recs.flatMap(rec => { const g = mt(rec, 'gov') && mt(rec, 'gov').G1; if (!g) return [];
        return f.severity === 'flag' ? fromEvents(rec, g.fallbackEntries, [1, 1], (e) => e.value, () => 'FALLBACK', runEnd) : fromEvents(rec, (g.events || []).filter(e => e.flying), [0.5, 0.5], (e) => e.value, () => 'Signal error'); }),
    G2: (f, recs) => recs.flatMap(rec => loc(rec) ? fromSpans(rec, loc(rec).G2, (q) => sameProfile(q.profile, f.profile)).map(c => Object.assign(c, { rank: Math.abs(c.value) })) : []),
    G3: (f, recs, x, ctx) => govEvents(f, ctx, 'rise', (e) => e.droop, (e) => e.t + 1 + (num(e.recoveryS) || 0), [0.3, 0]),
    G4: (f, recs, x, ctx) => govEvents(f, ctx, g4Dir(f, ctx), (e) => e.overshoot, (e) => e.t + 1.3, [0.3, 0]),
    G5: (f, recs, x, ctx) => govEvents(f, ctx, 'rise', (e) => (e.censored ? 100 : 0) + (num(e.recoveryS) || 0), (e) => (num(e.droopT) !== null ? e.droopT : e.t) + (num(e.recoveryS) || 0), [0.3, 0.5], (e) => e.recoveryS),
    G6: (f, recs) => recs.flatMap(rec => { const g = mt(rec, 'gov') && mt(rec, 'gov').G6 && mt(rec, 'gov').G6.byProfile && mt(rec, 'gov').G6.byProfile[f.profile]; return g ? fromEvents(rec, g.runs, [0.5, 0.5], (e) => (num(e.deficit) || 0) * 100 + e.value, null, runEnd, (e) => e.value) : []; }),
    G7: (f, recs) => recs.flatMap(rec => { const g = mt(rec, 'gov') && mt(rec, 'gov').G6 && mt(rec, 'gov').G6.byProfile && mt(rec, 'gov').G6.byProfile[f.profile]; return g ? fromEvents(rec, g.runs, [0.5, 0.5], (e) => e.value, null, runEnd) : []; }),
    G9: (f, recs, x) => recs.flatMap(rec => loc(rec) ? fromSpans(rec, loc(rec).G9, (q) => sameProfile(q.profile, f.profile) && (!x.band || q.band === x.band)) : []),
    G10: (f, recs) => recs.flatMap(rec => { const t4 = mt(rec, 'loop') && mt(rec, 'loop').T4; return t4 ? fromEvents(rec, (t4.events || []).filter(e => sameProfile(e.profile, f.profile)), [0.5, 0.5], (e) => e.value) : []; }),
    G11: (f, recs) => recs.flatMap(rec => loc(rec) ? fromSpans(rec, loc(rec).G11) : []),
    G14: (f, recs) => recs.flatMap(rec => { if (f.severity === 'flag') return fromEvents(rec, f.events, [1, 1], (e) => e.value, null, runEnd);
        const g = mt(rec, 'more') && mt(rec, 'more').G14; if (!g || g.skipped) return [];
        return fromEvents(rec, g.entries, [1, 1], (e) => (e.landing ? 0 : 100) + (e.seconds || 0), (e) => e.state, null, (e) => e.seconds).concat(fromEvents(rec, g.spoolups, [1, 1], () => 0, () => 'SPOOLUP', null, (e) => e.seconds)); }),
    C1: (f, recs) => loopEvents(f, recs, (m) => m.C1 && m.C1[f.axis], (e) => (e.longestAtLevel && num(e.longestAtLevel['0.95'])) || e.value, [0.5, 0.5]),
    C2: (f, recs) => loopEvents(f, recs, (m) => m.C2, (e) => e.seconds, [0.5, 0.5]),
    T8: (f, recs) => loopEvents(f, recs, (m) => m.T8, (e) => e.seconds, [0.5, 0.5]),
    C3: (f, recs) => loopEvents(f, recs, (m) => m.C3 && m.C3[f.axis], (e) => Math.abs(e.iShare), [0.5, 0.3]),
    T9: (f, recs) => loopEvents(f, recs, (m) => m.T9, (e) => Math.abs(e.iShare), [0.5, 0.3]),
    C4: (f, recs) => loopEvents(f, recs, (m) => m.C4 && m.C4[f.axis], (e) => e.overshootPct, [0.3, 0.6]),
    T5: (f, recs) => loopEvents(f, recs, (m) => m.T5, (e) => (e.side === f.larger ? 1000 : 0) + (num(e.overshootPct) || 0), [0.3, 0.6], (e) => e.overshootPct),
    C6: (f, recs) => loopEvents(f, recs, (m) => m.C6 && m.C6[f.axis], (e) => e.value, [0, 0]),
    T2: (f, recs) => loopEvents(f, recs, (m) => m.T2, (e) => e.value, [0, 0]),
    C8: (f, recs) => recs.flatMap(rec => loc(rec) ? fromSpans(rec, loc(rec).C8, (q) => sameProfile(q.profile, f.profile)) : []),
    C9: (f, recs) => { const ev = loopEvents(f, recs, (m) => m.C9, (e) => Math.abs(e.value), [0, 0], (e) => e.value);
        return ['positive', 'negative'].map(sg => ev.filter(c => c.raw.collective === sg).sort((a, b) => b.rank - a.rank)[0]).filter(Boolean); },
    C10: (f, recs, x) => f.axis ? recs.flatMap(rec => loc(rec) ? fromSpans(rec, loc(rec).C10, (q) => q.axis === f.axis && sameProfile(q.profile, f.profile) && (!x.binRange || (q.bin[0] === x.binRange[0] && q.bin[1] === x.binRange[1]))) : [])
        : recs.flatMap(rec => { const l = mt(rec, 'loop') && mt(rec, 'loop').C10 && mt(rec, 'loop').C10.landedWhileMoving; return l && !l.skipped ? fromEvents(rec, l.events, [0, 0], (e) => e.value) : []; }),
    C11: (f, recs) => recs.flatMap(rec => loc(rec) ? fromSpans(rec, loc(rec).C11, (q) => q.axis === f.axis && sameProfile(q.profile, f.profile)) : []),
    T4: (f, recs, x, ctx) => { const big = (log, p) => recordsOf(ctx, log).flatMap(rec => loopEvents({ profile: p }, [rec], (m) => m.T4, (e) => e.value, [0.5, 0.5])).sort((a, b) => b.value - a.value)[0];
        return [big(f.log, f.profile), f.other ? big(f.other.log, f.other.profile) : null].filter(Boolean).map((c, i) => Object.assign(c, { rank: -i })); }, // this pair in its sequence
    T6: (f, recs) => loopEvents(f, recs, (m) => m.T6, (e) => Math.abs(e.peak), [0.1, 0.5]),
    T7: (f, recs) => loopEvents(f, recs, (m) => m.T7, (e) => Math.abs(e.value), [0, 0]),
    C12: (f, recs) => worstBlocks(f, recs), T11: (f, recs) => worstBlocks(f, recs), C13: (f, recs) => worstBlocks(f, recs), T12: (f, recs) => worstBlocks(f, recs),
    R1: (f, recs) => recs.flatMap(rec => { const s = mt(rec, 'track') && mt(rec, 'track').stick && mt(rec, 'track').stick[f.axis]; return s ? fromSpans(rec, s.blocksAt || s.worst) : []; }),
    C5: (f, recs) => oscEvents(f, recs), T1: (f, recs) => oscEvents(f, recs),
    D6: (f, recs) => recs.flatMap(rec => { const d = mt(rec, 'more') && mt(rec, 'more').D6; return fromEvents(rec, f.events || (d && d.events), [1, 1], (e) => e.value, (e) => REASON[e.reason] || null); }),
    F10: (f, recs) => recs.flatMap(rec => { const g = mt(rec, 'more') && mt(rec, 'more').F10 && mt(rec, 'more').F10[f.axis] && mt(rec, 'more').F10[f.axis].byProfile && mt(rec, 'more').F10[f.axis].byProfile[f.profile];
        if (g && Array.isArray(g.worst)) return fromSpans(rec, g.worst);
        return f.axis === 'yaw' && loc(rec) ? fromSpans(rec, loc(rec).C11, (q) => q.axis === f.axis && sameProfile(q.profile, f.profile)) : []; }), // the same windows and share as C11
    T13: (f, recs) => recs.flatMap(rec => { const g = mt(rec, 'more') && mt(rec, 'more').T13 && mt(rec, 'more').T13.byProfile && mt(rec, 'more').T13.byProfile[f.profile]; return g && Array.isArray(g.worst) ? fromSpans(rec, g.worst).map(c => Object.assign(c, { rank: Math.abs(c.value) })) : []; }),
    C14: (f, recs) => recs.flatMap(rec => { const m = mt(rec, 'more') && mt(rec, 'more').C14; if (!m || m.skipped) return []; const g = m.byProfile && m.byProfile[f.profile];
        return (g && Array.isArray(g.worst) ? fromSpans(rec, g.worst).map(c => Object.assign(c, { rank: Math.abs(c.value) })) : fromEvents(rec, (m.events || []).filter(e => sameProfile(e.profile, f.profile)), [0.3, 0], (e) => Math.abs(e.err), null, (e) => e.t + 1.3))
            .map(c => Object.assign(c, { clip: true })); }), // a 30 s block can hold IDLE, the ground or a rescue: its longest usable part
    T14: (f, recs) => recs.flatMap(rec => { const ev = (mt(rec, 'more') && mt(rec, 'more').T14 && mt(rec, 'more').T14.events) || [];
        return fromEvents(rec, f.events || ev, [1, 1.3], (e) => Math.abs(num(e.toward) !== null ? e.toward : e.value), null, (e) => { const full = ev.find(q => q.t === e.t); return e.t + (full && full.seconds || 0); }); }),
    F5: (f, recs) => recs.flatMap(rec => { if (!loc(rec)) return []; const list = loc(rec).F5.filter(q => sameProfile(q.profile, f.profile)), sel = f.severity === 'flag' ? list.filter(q => q.order === f.value) : [];
        return fromSpans(rec, sel.length ? sel : list); }),
    F6: (f, recs, x) => x.row ? recs.flatMap(rec => fromEvents(rec, x.row.events, [0, 0], (e) => -e.value, null, (e) => e.t + SETUP.RULE.order.revolutions * 60 / (e.headspeed || x.headspeed || 1e9), (e) => e.value)) : [],
    D7: (f, recs) => flightCands(f, recs),
};
function loopEvents(f, recs, pick, score, pads, stat) {
    return recs.flatMap(rec => { const m = mt(rec, 'loop'), g = m ? pick(m) : null; return g ? fromEvents(rec, (g.events || []).filter(e => sameProfile(e.profile, f.profile)), pads, score, null, null, stat) : []; });
}
function worstBlocks(f, recs) {
    return recs.flatMap(rec => { const t = mt(rec, 'track') && mt(rec, 'track').track && mt(rec, 'track').track[f.axis], g = t && t.byProfile && t.byProfile[f.profile]; return g && Array.isArray(g.worst) ? fromSpans(rec, g.worst) : []; });
}
// C5, T1: a flag cites its self-excited bursts (events {t: onset, value}); otherwise the bursts of the profile
function oscEvents(f, recs) {
    return recs.flatMap(rec => { const o = mt(rec, 'track') && mt(rec, 'track').osc && mt(rec, 'track').osc[f.axis], all = (o && o.events) || [];
        const end = (e) => { const b = all.find(q => q.onsetT === e.t || q.t === e.t) || e; return b.t + (num(b.seconds) || 0); };
        if (f.severity === 'flag' && Array.isArray(f.events)) return fromEvents(rec, f.events, [0.3, 0.5], (e) => e.value, null, end);
        return fromEvents(rec, all.filter(e => sameProfile(e.profile, f.profile)), [0.3, 0.5], (e) => e.value, null, end).map(c => Object.assign(c, { c0: num(c.raw.onsetT) !== null ? c.raw.onsetT : c.raw.t })); });
}
// G3-G5 pool the collective events of every log in f.log (health_gov judge): rises or drops of at least minStep
function govEvents(f, ctx, dir, score, end, pads, stat) {
    const R = C.rulesOf(f, C.CHECKS[f.id]), minStep = num(R.minStep) !== null ? R.minStep : 0.3, out = [];
    for (const log of logsOf(f)) for (const rec of recordsOf(ctx, log)) { const g = mt(rec, 'gov') && mt(rec, 'gov').G3;
        for (const e of (g && g.events) || []) if (e.dir === dir && sameProfile(e.profile, f.profile) && e.size >= minStep) out.push(cand(rec, e.t, end(e), pads[0], pads[1], stat ? stat(e) : score(e), e, null, score(e))); }
    return out;
}
// G4 flags on rises (load onset) or on drops: the side whose mean overshoot is the finding's value
function g4Dir(f, ctx) {
    const R = C.rulesOf(f, C.CHECKS.G4), minStep = num(R.minStep) !== null ? R.minStep : 0.3, mean = (dir) => { const v = [];
        for (const log of logsOf(f)) for (const rec of recordsOf(ctx, log)) { const g = mt(rec, 'gov') && mt(rec, 'gov').G3; for (const e of (g && g.events) || []) if (e.dir === dir && sameProfile(e.profile, f.profile) && e.size >= minStep && num(e.overshoot) !== null) v.push(e.overshoot); }
        return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) : null; };
    return f.severity === 'flag' && mean('rise') === f.value && mean('drop') !== f.value ? 'rise' : 'drop';
}

// Each candidate to frame seconds (core through the time map of its record, clipped to the record, then the pads), worst
// first; no span that overlaps a kept one by more than RULE.overlap of the shorter; RULE.maxSpans or fewer
function pickSpans(cands, f, c) {
    const conv = cands.filter(q => q && num(q.c0) !== null).map((q, i) => {
        if (q.frame) return { i, q, t0: q.c0, t1: Math.max(q.c0, q.c1), k0: q.c0, k1: Math.max(q.c0, q.c1) };   // frame seconds already
        const [a, b] = q.rec ? spanOf(q.rec) : [-Infinity, Infinity], tm = q.rec && q.rec.timeMap, lo = toFrame(tm, a), hi = isFinite(b) ? toFrame(tm, b) : Infinity;
        let k0 = toFrame(tm, Math.min(b, Math.max(a, q.c0))), k1 = toFrame(tm, Math.max(a, Math.min(b, q.c1)));
        if (q.clip && q.rec) { const u = usablePart(q.rec, k0, Math.max(k0, k1)); if (!u) return null; [k0, k1] = u; }
        const t0 = Math.max(lo, k0 - q.p0), t1 = Math.min(hi, k1 + q.p1);
        return { i, q, t0, t1: Math.max(t0, t1), k0, k1: Math.max(k0, k1) }; }).filter(Boolean).sort((x, y) => (y.q.rank === null ? -Infinity : y.q.rank) - (x.q.rank === null ? -Infinity : x.q.rank) || x.i - y.i), kept = [];
    for (const s of conv) {
        const len = Math.max(1e-6, s.t1 - s.t0);
        if (kept.some(k => k.q.rec === s.q.rec && Math.min(k.t1, s.t1) - Math.max(k.t0, s.t0) > RULE.overlap * Math.min(len, Math.max(1e-6, k.t1 - k.t0)))) continue;
        kept.push(s); if (kept.length >= ((c && c.evidence && num(c.evidence.maxSpans)) || RULE.maxSpans)) break; // a check can keep more (the periods at a control limit)
    }
    // the phase of a span: the phase spans of its record (the largest overlap with the event or block itself, the pads not
    // included), else the phase of its event or of the finding
    const phases = new Map(), spansOf = (rec) => { if (!phases.has(rec)) phases.set(rec, phaseSpansOf(rec)); return phases.get(rec); };
    return kept.map(({ q, t0, t1, k0, k1 }) => ({ log: q.rec && q.rec.log !== undefined ? q.rec.log : logsOf(f)[0] === undefined ? null : logsOf(f)[0], t0: r3(t0), t1: r3(t1),
        value: num(q.value) === null ? null : +(+q.value).toPrecision(5), label: q.label || labelOf(f, c),
        phase: phaseAt(spansOf(q.rec), r3(k0), r3(k1)) || (q.raw && PHASES.includes(q.raw.phase) ? q.raw.phase : null) || phaseOfFinding(f),
        ...profilesOf(q.raw, f) })); // SPEC2 D12
}
// the profile label of a span (its event or block, else the finding) and its PID profile: the finding's (pidOf) for the
// label of the finding, else a label 1-6, else null (not known)
const pidOf = (f) => { const q = C.profileOf(f); return q !== null && q > 0 ? q : null; };
function profilesOf(raw, f) {
    const own = raw && (typeof raw.profile === 'number' || /^\d+$/.test(String(raw.profile))) ? +raw.profile : null, label = own !== null ? own : f.profile === undefined ? null : f.profile;
    const same = own === null || String(own) === String(f.profile);
    return { profile: label, pidProfile: same ? pidOf(f) : Number.isInteger(own) && own >= 1 && own <= 6 ? own : null };
}
// C14 (review D-LOW): the longest part of [k0, k1] (frame seconds) in the flight phase of the record (all of it when the
// record has no phase spans), out of its rescue, level mode, failsafe and ground spans (health_more D6 events, widened by
// RULE.spanGuardS as normalMask does); null when no part is left
function usablePart(rec, k0, k1) {
    const ph = phaseSpansOf(rec), tm = rec.timeMap, guard = MORE && MORE.RULE && num(MORE.RULE.spanGuardS) !== null ? MORE.RULE.spanGuardS : 0;
    let parts = (ph.length ? ph.filter(q => q.phase === 'flight').map(q => [q.t0, q.t1]) : [[k0, k1]]).map(([a, b]) => [Math.max(a, k0), Math.min(b, k1)]).filter(([a, b]) => b > a);
    const d6 = mt(rec, 'more') && mt(rec, 'more').D6;
    for (const e of (d6 && Array.isArray(d6.events) ? d6.events : [])) { if (num(e.t) === null) continue;
        const a = toFrame(tm, e.t) - guard, b = toFrame(tm, e.t + (num(e.seconds) || 0)) + guard;
        parts = parts.flatMap(([p, q]) => b <= p || a >= q ? [[p, q]] : [[p, a], [b, q]].filter(([u, v]) => v > u)); }
    return parts.sort((u, v) => (v[1] - v[0]) - (u[1] - u[0]))[0] || null;
}
const labelOf = (f, c) => c ? c.noun.charAt(0).toUpperCase() + c.noun.slice(1) : f.id; // the statistic itself is in value

const fill = (s, a, axis, p, f) => String(s).replace(/\{a\}/g, String(a)).replace(/\{axis\}/g, axis || 'roll').replace(/\{p\}/g, p === null || p === undefined ? '' : String(p)).replace(/\{field\}/g, f && f.field ? String(f.field) : 'servo[0]');
function viewOf(f, c, spans, recs, a, axis) {
    const spec = c.evidence;
    if (spec.source === 'header') return null;
    const graphs = (spec.fields || []).map(g => g.map(k => fill(k, a, axis, undefined, f))).filter(g => g.length), analyser = spec.analyser ? fill(spec.analyser, a, axis) : null;
    if (spans.length) { const s = spans[0]; return { log: s.log, t0: s.t0, t1: s.t1, at: r3((s.t0 + s.t1) / 2), graphs, analyser }; }
    const rec = recs[0]; if (!rec) return null;
    const [i0, i1] = spanOf(rec), tm = rec.timeMap, t0 = r3(toFrame(tm, i0)), t1 = r3(toFrame(tm, isFinite(i1) ? i1 : i0));
    return { log: rec.log === undefined ? logsOf(f)[0] : rec.log, t0, t1, at: r3((t0 + t1) / 2), graphs, analyser };
}

// the rows of a table plot: the header keys of the check, and what the metrics hold for D1, D3, D4, F3, F9 and H (values
// from the log, shown as they are)
const str = (v) => Array.isArray(v) ? v.join(',') : String(v);
const ROWS = {
    D1: (f, rec) => { const d = mt(rec, 'setup') && mt(rec, 'setup').D1; return d ? [{ key: 'nominalHz', value: str(d.nominalHz) }, { key: 'measuredHz', value: str(d.measuredHz) }, { key: 'nyquistHz', value: str(d.nyquistHz) }] : []; },
    D3: (f, rec) => { const d = mt(rec, 'setup') && mt(rec, 'setup').D3; return d ? Object.entries(d.fields).filter(([, v]) => v !== 'present').map(([k, v]) => ({ key: k, value: v })) : []; },
    D4: (f, rec) => { const d = mt(rec, 'setup') && mt(rec, 'setup').D4; return d && Array.isArray(d.mismatches) ? d.mismatches.slice(0, 50).map(m => ({ key: m.header, value: str(m.headerValue), cli: `${m.cli} ${str(m.cliValue)}` })) : []; },
    F3: (f, rec) => { const d = mt(rec, 'setup') && mt(rec, 'setup').F3; return d && Array.isArray(d.rpm) ? d.rpm.map(q => ({ key: `${q.axis} ${q.code}`, value: str(q.q) })) : []; },
    F9: (f, rec) => { const d = mt(rec, 'setup') && mt(rec, 'setup').F9; return d && Array.isArray(d.rows) ? d.rows.filter(q => q.aboveNyquist || q.aboveCeiling || q.hz === null).map(q => ({ key: `${q.axis} ${q.code}, ${C.profileLabel(C.profileOf({ id: 'F9', profile: q.profile }))}`, value: q.hz === null ? '?' : `${q.hz} Hz` })) : []; },
    H: (f) => { const h = C.headerChange(f); return h ? [{ key: h.key, value: h.to, from: h.from }] : []; },
    D7: (f, rec, recs) => phaseRows(f, recs),
    // D9 (health_config.cjs): rescue_mode and the other rescue values of the PID profile (CLI dump or defaults), or the PID
    // profiles that the analysis cannot read
    D9: (f) => (f.mode ? [{ key: 'rescue_mode', value: str(f.mode) }] : []).concat(f.params && typeof f.params === 'object' ? Object.entries(f.params).filter(([k]) => k !== 'rescue_mode').map(([k, v]) => ({ key: k, value: str(v), default: Array.isArray(f.defaults) && f.defaults.includes(k) })) : [])
        .concat(Array.isArray(f.unknownProfiles) && f.unknownProfiles.length ? [{ key: 'PID profiles not known', value: f.unknownProfiles.join(', ') }] : []),
};

// The caption of the plot of each check (SPEC3 H, "Show the measurement"): one STE sentence that says what the curves are and
// where the limit is. (f, R the rules, x the facts) -> string. A check with no entry gets the sentence of its plot kind
const lim = (v, unit) => num(v) === null ? null : `${C.fmt(v)}${unit ? ` ${unit}` : ''}`;
const CAPTION = {
    D2: () => 'The points are the frame time errors of the log, at their times.',
    D5: (f, R) => `The curve is the battery voltage, and a step of more than ${lim(R.step, 'V') || 'the limit'} in 10 ms is a problem.`,
    G13: (f, R) => `The curve is the battery voltage, and the limit is ${lim(num(f.threshold) !== null ? f.threshold : R.minCell, 'V') || 'the minimum voltage'} for each cell.`,
    P1: () => 'The curves are the battery voltage, the battery output and the throttle at the load steps, and the lines are the warning and minimum levels.',
    P2: () => 'The points are the voltage decrease against the output increase at the load steps, and their slope is the decrease for each 1 A.',
    G1: () => 'The curves are the headspeed and its target, and each change to FALLBACK is a problem.',
    G2: (f, R) => `The curves are the headspeed and its target, and the lines show the limit of ${lim(num(R.median) === null ? null : R.median * 100, '%') || 'the error'}.`,
    G3: (f, R) => `The curves are the headspeed and its target at the collective increases, and the line is the limit of ${lim(num(R.flag) === null ? null : R.flag * 100, '%') || 'the decrease'}.`,
    G4: (f, R) => `The curves are the headspeed and its target after the collective changes, and the line is the limit of ${lim(num(R.flag) === null ? null : R.flag * 100, '%') || 'the overshoot'}.`,
    G5: () => 'The curves are the headspeed and its target, and the band shows ±1 % of the target.',
    G6: (f, R) => `The curves are the throttle and the headspeed, and the line is the limit of ${lim(R.median, '%') || 'the throttle'}.`,
    G8: () => 'The points are the motor output against the governor output, and the firmware range is 0.8 to 1.2.',
    G9: () => 'The curve is the spectrum of the headspeed error, and the lines mark the peak and its limit.',
    G10: () => 'The curves are the spectra of the headspeed and the yaw rate, and a peak in the two shows a possible governor cause.',
    G11: () => 'The points are the throttle at equal collective during the flight, and the limit is the throttle increase of one battery.',
    G12: () => 'The curves are the spectra of the raw gyro, and the line marks 1 x the rotor frequency from the headspeed.',
    G20: () => 'The curves are the headspeed, its target and the throttle before each FALLBACK, and a throttle at 95 % or more is a large load.',
    G19: (f, R) => `The curves are the headspeed, its target and the throttle at the rescue, and the line is the limit of ${lim(num(R.flag) === null ? null : -R.flag * 100, '%') || 'the decrease'}.`,
    C1: () => 'The curve is the I-term, and the limit is 95 % of its range.',
    C2: () => 'The curves are the cyclic and collective outputs, and each period at the output limit is a problem.',
    C3: () => 'The curves are the setpoint, the gyro rate, the I-term and the feedforward during the turns.',
    C4: () => 'The curves are the setpoint and the gyro rate at the stops, and the limit is an overshoot of 10 %.',
    C5: () => 'The curves are the setpoint, the gyro rate and the error, and the lines show the limit of the oscillation.',
    T1: () => 'The curves are the yaw setpoint, the yaw rate and the error, and the lines show the limit of the oscillation.',
    C6: () => 'The curve is the spectrum of the rate with the sticks stable, and the line marks the peak.',
    T2: () => 'The curve is the spectrum of the yaw rate with the sticks stable, and the line marks the peak.',
    C10: () => 'The curves are the I-term, the setpoint and the collective, and in flight the I-term decreases slowly.',
    C11: () => 'The curve is the spectrum of the D-term, and the line marks 30 Hz: the power above the line is vibration.',
    F10: () => 'The curve is the spectrum of the D-term, and the line marks 30 Hz: the power above the line is vibration.',
    C12: () => 'The curves are the setpoint and the gyro rate, and the lines show the limits of the tracking error.',
    T11: () => 'The curves are the yaw setpoint and the yaw rate, and the lines show the limits of the tracking error.',
    C13: (f, R) => `The curve is the phase from the setpoint to the gyro rate, and the limit is a time delay of ${lim(R.flag, 'ms') || 'the limit'}.`,
    T12: (f, R) => `The curve is the phase from the yaw setpoint to the yaw rate, and the limit is a time delay of ${lim(R.flag, 'ms') || 'the limit'}.`,
    R1: (f, R) => `The curves are the stick command and the setpoint, and the limit is a time delay of ${lim(R.flag, 'ms') || 'the limit'}.`,
    C14: () => 'The points are the pitch I-term against the collective, and the slope is the pitch movement that the feedforward must supply.',
    C15: () => 'The curves are the roll or pitch rate, the collective and the headspeed on the ground, and an oscillation that increases is a problem.',
    D6: () => 'The points are the parts of the log that the analysis does not use.',
    D8: () => 'The points are the PID profile changes at the rescues, and each change is a problem.',
    F5: () => 'The curve is the spectrum of the raw gyro, and the lines mark the peak and the nearest notch filters.',
    F6: (f, R) => `The points are the decrease of each notch filter, and the limit is ${lim(R.minDb, 'dB') || 'the minimum'}.`,
    F7: () => 'The curves are the spectra of the raw gyro.',
    F11: (f, R) => `The curve is the phase from the raw gyro to the filtered gyro, and the limit is a time delay of ${lim(R.flagMs, 'ms') || 'the limit'}.`,
    T4: () => 'The points are the tail oscillations of the logs, with their frequencies.',
    T5: () => 'The curves are the yaw setpoint and the yaw rate at the stops on the two sides.',
    T6: (f, R) => `The curves are the yaw rate and its setpoint at the collective steps, and the lines show the limit of ${lim(R.kick, 'deg/s') || 'the yaw change'}.`,
    T7: () => 'The points are the yaw I-term against the precompensation during the collective movements.',
    T8: () => 'The curve is the tail output, and the lines are the tail output limits: at a line, the tail does not have sufficient authority.',
    T9: () => 'The curves are the yaw setpoint, the yaw rate, the yaw I-term and the feedforward during the pirouettes.',
    T13: () => 'The curve is the yaw I-term in hover, and the lines are the limits of the tail offset.',
    T14: () => 'The curves are the tail output, the feedforward and the headspeed at the headspeed changes.',
    T15: () => 'The curves are the yaw rate, its setpoint and the tail output at the rescue, and the lines are the tail output limits.',
    G14: () => 'The curves are the headspeed and its target, and a change to AUTOROTATION or BAILOUT in flight is a problem.',
    G15: () => 'The curves are the headspeed, the throttle and the yaw rate during the spool-up, and the limit is the yaw rate on the ground.',
    G16: () => 'The curves are the headspeed, its target and the throttle at the change to ACTIVE, and the limit is the headspeed error.',
    G17: () => 'The curves are the motor output and the headspeed, and each sudden step at a constant throttle is a problem.',
    G18: () => 'The curves are the headspeed and the motor output at IDLE, and the limit is the change of the headspeed.',
    G0: () => 'The curves are the governor output, the headspeed and its target.',
    G7: () => 'The curves are the throttle, the governor output and the headspeed at the throttle limit.',
    C7: () => 'The curves are the response from the setpoint to the gyro rate at this headspeed.',
    C9: () => 'The points are the pitch errors at positive and at negative collective.',
};
for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']) CAPTION[id] = (f) => `The curve is the output, and the lines are its limits${id === 'L4' ? ': at a line, the tail does not have sufficient authority' : ''}.`;
const KIND_CAPTION = { table: 'The table gives the values of the log header for this check.', events: 'The points are the results of this check at their times.', spectrum: 'The curves are the spectra of the fields of this check.',
    phase: 'The curve is the phase of the response of this check.', governor: 'The curves are the headspeed and its target.', scatter: 'The points are the values of this check.', time: 'The curves are the fields of this check over time.',
    transmission: 'The curves are the response of this check.' };
function captionOf(f, c, R, x, kind) {
    if (f.id === 'D9') return 'The table gives the rescue values of this PID profile.';
    if (kind === 'table' && c.evidence.source === 'header') return KIND_CAPTION.table;
    try { const t = CAPTION[f.id] ? CAPTION[f.id](f, R || {}, x || {}) : null; if (typeof t === 'string' && t && !/\b(null|undefined|NaN)\b/.test(t)) return t; } catch (e) { /* the sentence of the kind */ }
    return KIND_CAPTION[kind] || KIND_CAPTION.time;
}
// D7: the number of flights and the seconds of each phase (the finding's phaseSeconds or phases, else the phase spans of its records)
function phaseRows(f, recs) {
    const own = f.phaseSeconds || (f.phases && !Array.isArray(f.phases) ? f.phases : null), sec = {};
    if (own) for (const p of PHASES) { if (num(own[p]) !== null) sec[p] = own[p]; }
    else for (const rec of recs) for (const q of phaseSpansOf(rec)) sec[q.phase] = (sec[q.phase] || 0) + Math.max(0, q.t1 - q.t0);
    const k = Array.isArray(f.flights) ? f.flights.length : num(f.flights);
    return (k !== null ? [{ key: 'Flights', value: String(k) }] : []).concat(PHASES.filter(p => sec[p] !== undefined).map(p => ({ key: PHASE_LABEL[p], value: `${C.fmt(sec[p], 1)} s` })));
}

function plotOf(f, c, spans, recs, a, axis, x, ctx) {
    const P = c.evidence.plot || {}, R = C.rulesOf(f, c), p = f.profile;
    let curve = P.curve ? fill(P.curve, a, axis, p) : null;
    if (curve === 'more.vib') curve = num(+p) > 0 ? `more.vib.byProfile.${p}.${axis || x.axis || 'roll'}` : `more.vib.${axis || x.axis || 'roll'}`;
    const out = { kind: P.kind || 'time', tab: c.tab, curve, snippet: P.snippet ? { fields: (P.snippet.fields || []).map(k => fill(k, a, axis, undefined, f)), derive: P.snippet.derive || null } : null,
        reference: (typeof P.reference === 'function' ? P.reference(f, R, x) : []).filter(Boolean) };
    out.caption = captionOf(f, c, R, x, out.kind);   // SPEC3 H: what the curves are and where the limit is
    if (out.kind === 'table') { const h = (recs[0] && recs[0].header) || ctx.header || {};
        out.rows = (P.keys || []).filter(k => h[k] !== undefined).map(k => ({ key: k, value: str(h[k]) })).concat(ROWS[f.id] ? ROWS[f.id](f, recs[0], recs) : []); }
    if (out.kind === 'events') { const ev = (f.events || (x.row && x.row.events) || []).filter(e => e && num(e.t) !== null).slice(0, RULE.maxPoints), rec = recs[0];
        out.points = ev.map(e => ({ t: r3(toFrame(rec && rec.timeMap, e.t)), value: num(e.value) })); }
    if (out.curve && !out.snippet && !(ctx && ctx.curves)) { const fb = fallbackOf(f, c, a, axis, x, R);
        if (fb) { out.snippet = { fields: fb.fields, derive: fb.derive || null, fallback: true, reference: fb.reference ? fb.reference.filter(Boolean) : out.reference };
            out.reference = out.snippet.reference; } }
    return out;
}

// The raw fields of the span of a finding whose log has no curves, and what to derive from them (review D-H3): the first
// viewer graph of the check for its plot kind (a spectrum: Welch of each field; a phase plot: the transmission from the
// first field to the second; a time, governor or scatter plot: the fields of the first two graphs as the log records
// them), else the entry of FALLBACK. reference: in the units of these fields, when the curve units are different
const hlRef = (value, label) => num(value) === null ? null : { kind: 'hline', value, label, unit: '‰' };
const FALLBACK = {
    T8: () => ({ fields: ['mixer[2]', 'servo[3]'], derive: null }),                // mixer[2] against the tail output limits (catalog.cjs REF T8, permille)
    T13: (f, x, R) => { const A = num(x.authorityPermille), lim = num(R.share) !== null && A !== null ? R.share * A : null, s = num(x.iPermille) !== null && x.iPermille < 0 ? -1 : 1;
        return { fields: ['axisI[2]', 'mixer[2]'], derive: null,
            reference: [lim === null ? null : hlRef(s * +lim.toFixed(1), `Limit ${C.fmt(s * lim, 1)} ‰ (${C.fmt(R.share * 100)} % of the tail output range)`), hlRef(x.iPermille, `Hover median ${C.fmt(x.iPermille, 1)} ‰`)] }; },
};
function fallbackOf(f, c, a, axis, x, R) {
    if (FALLBACK[f.id]) return FALLBACK[f.id](f, x, R);
    const P = c.evidence.plot || {}, g = (c.evidence.fields || []).map(q => q.map(k => fill(k, a, axis))).filter(q => q.length), first = g[0] || [];
    if (!first.length) return null;
    if (P.kind === 'spectrum') return { fields: first, derive: { kind: 'spectrum', params: { fields: first } } };
    if (P.kind === 'phase') return first.length >= 2 ? { fields: first.slice(0, 2), derive: { kind: 'transmission', params: { from: first[0], to: first[1] } } } : null;
    if (P.kind === 'time' || P.kind === 'governor' || P.kind === 'scatter') return { fields: [...new Set(g.slice(0, 2).flat())].slice(0, 4), derive: null };
    return null;
}

// spans of other findings in the same log that overlap: what can explain this finding (SPEC2 3.3 context)
const CONTEXT = [
    ['D6', 'more', (m) => (m.D6 && m.D6.events) || [], (e) => [e.t, e.t + (e.seconds || 0)], (e) => REASON[e.reason] || 'Time not used'],
    ['D2', 'setup', (m) => ((m.D2 && m.D2.events) || []).filter(e => /^loop stall|^time jump/.test(String(e.kind || ''))), (e) => [e.t - 0.05, e.t + 0.05], d2Label],
    ['C2', 'loop', (m) => (m.C2 && m.C2.events) || [], (e) => [e.t, e.t + (e.seconds || 0)], () => 'Cyclic output limit'],
    ['T8', 'loop', (m) => (m.T8 && m.T8.events) || [], (e) => [e.t, e.t + (e.seconds || 0)], () => 'Tail output limit'],
    ['C5', 'track', (m) => ['roll', 'pitch'].flatMap(ax => ((m.osc && m.osc[ax] && m.osc[ax].events) || []).filter(e => e.selfExcited)), (e) => [num(e.onsetT) !== null ? e.onsetT : e.t, e.t + (e.seconds || 0)], () => 'Fast oscillation'],
    ['T1', 'track', (m) => ((m.osc && m.osc.yaw && m.osc.yaw.events) || []).filter(e => e.selfExcited), (e) => [num(e.onsetT) !== null ? e.onsetT : e.t, e.t + (e.seconds || 0)], () => 'Fast tail oscillation'],
    ['G1', 'gov', (m) => (m.G1 && m.G1.fallbackEntries) || [], (e) => [e.t, e.t + (e.value || 0)], () => 'FALLBACK'],
    ['G6', 'gov', (m) => m.G6 && m.G6.byProfile ? [].concat(...Object.values(m.G6.byProfile).map(g => g.runs || [])) : [], (e) => [e.t, e.t + (e.value || 0)], () => 'Throttle limit'],
];
// the periods at a control limit (health_limits.cjs, CLAUDE.md "Control limits") and the rescues (health_rescue.cjs) as context
const LIMIT_CONTEXT = { L1: 'Throttle at its limit', L2: 'Collective at its limit', L3: 'Cyclic at its limit', L4: 'Tail at its limit', L5: 'Servo at its limit', L6: 'I-term at its limit', L7: 'Collective stick at its end' };
for (const [id, label] of Object.entries(LIMIT_CONTEXT)) CONTEXT.push([id, 'limits', (m) => (m.channels || []).filter(c => c.id === id).flatMap(c => c.periods || []), (e) => [e.t, e.t1], () => label]);
CONTEXT.push(['G19', 'rescue', (m) => (m.rescues || []).map(q => ({ t: q.t, t1: q.t1 })), (e) => [e.t, e.t1], () => 'Rescue']);
function contextOf(f, spans, recs, ctx) {
    if (!spans.length) return [];
    const out = [], findings = Array.isArray(ctx.findings) ? ctx.findings : [];
    for (const [id, mod, list, span, label] of CONTEXT) { if (id === f.id) continue;
        for (const rec of recs) { const m = mt(rec, mod); if (!m) continue; const tm = rec.timeMap;
            for (const e of list(m)) { if (!e || num(e.t) === null) continue; const [a, b] = span(e), t0 = r3(toFrame(tm, a)), t1 = r3(toFrame(tm, b));
                if (!spans.some(s => s.log === rec.log && Math.min(s.t1, t1) >= Math.max(s.t0, t0))) continue;
                const g = findings.find(q => q.id === id && logsOf(q).includes(rec.log) && q.severity === 'flag');
                out.push({ fid: g && g.fid ? g.fid : null, id, t0, t1, label: label(e) });
                if (out.length >= RULE.maxContext) return out; } } }
    return out;
}

function forFinding(f, ctx) {
    if (!f || typeof f.id !== 'string' || f.severity === 'skipped' || f.severity === 'error') return null;
    const c = C.CHECKS[f.id]; if (!c) return null;
    const cx = ctx || {}, log = logsOf(f)[0], recs = recordsOf(cx, log), axis = H.axisOf(f), x = factsOf(f, recs), a = Math.max(0, AXES.indexOf(axis || x.axis || 'roll'));
    let cand = [];
    try { cand = CAND[f.id] ? CAND[f.id](f, recs, x, cx) : genericCands(f, recs, c); } catch (err) { cand = []; }
    const spans = c.evidence.source === 'header' ? [] : pickSpans(cand, f, c);
    const fx = Object.assign({}, x); delete fx.row; delete fx.binRange;
    const g = Object.assign({}, f, { evidence: { facts: fx } });
    return { v: 1, fid: f.fid || null, id: f.id, log: log === undefined ? null : log, profile: f.profile === undefined ? null : f.profile, pidProfile: pidOf(f), axis: axis || null,
        phase: phaseOfFinding(f) || (spans.length ? spans[0].phase : null),
        spans, view: viewOf(f, c, spans, recs, a, axis || x.axis), plot: plotOf(f, c, spans, recs, a, axis || x.axis, x, cx),
        expected: c.evidence.expected(f) || null, summary: C.summary(g), facts: fx, context: contextOf(f, spans, recs, cx) };
}

// C7: a report.cjs decision; segments: extract.cjs segments (frame time already: lib.segments fromS is the frame clock)
const BIN_RPM = 250; // report.cjs RULES.headspeedBinRpm
function forDecision(d, segments) {
    if (!d) return null;
    const axis = AXES.includes(d.axis) ? d.axis : null, a = Math.max(0, AXES.indexOf(axis)), c = C.CHECKS.C7;
    const segs = (Array.isArray(segments) ? segments : []).filter(s => s && s.headspeed && num(s.headspeed.median) !== null && Math.round(s.headspeed.median / BIN_RPM) * BIN_RPM === d.bin && num(s.fromS) !== null && num(s.seconds) !== null)
        .sort((p, q) => q.seconds - p.seconds).slice(0, RULE.maxSpans);
    const spans = segs.map(s => ({ log: s.log === undefined ? null : s.log, t0: r3(s.fromS), t1: r3(s.fromS + s.seconds), value: r3(s.seconds), label: `Segment ${C.fmt(s.seconds)} s at ${C.fmt(s.headspeed.median)} rpm`, phase: null, profile: null }));
    const graphs = c.evidence.fields.map(g => g.map(k => fill(k, a, axis)));
    const f = Object.assign({ id: 'C7', severity: d.change ? 'flag' : 'note' }, d, { axis });
    const gates = d.gates && typeof d.gates === 'object' ? Object.entries(d.gates).map(([k, v]) => ({ key: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v) })) : [];
    return { v: 1, fid: d.fid || null, id: 'C7', log: spans.length ? spans[0].log : null, profile: null, axis, phase: null, spans,
        view: spans.length ? { log: spans[0].log, t0: spans[0].t0, t1: spans[0].t1, at: r3((spans[0].t0 + spans[0].t1) / 2), graphs, analyser: null } : null,
        plot: { kind: 'transmission', tab: c.tab, curve: null, snippet: { fields: [fill('setpoint[{a}]', a), fill('gyroADC[{a}]', a)], derive: { kind: 'spectrum' } }, reference: [], rows: gates, caption: CAPTION.C7() },
        expected: 'The model calculates the change from the flights at this headspeed.', summary: C.summary(f), facts: { bin: d.bin }, context: [] };
}

module.exports = { RULE, PHASES, PHASE_LABEL, CAPTION, timeMap, toFrame, locate, forFinding, forDecision, phaseSpansOf, phaseAt, captionOf };
