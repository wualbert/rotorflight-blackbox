'use strict';

/**
 * Health checks of the cyclic and tail control loops, from one whole log (docs/TUNING_KNOWLEDGE.md sections 10.3, 10.4).
 * wag.cjs / wag_report.cjs / report.cjs already cover C5, C7, T1, T3 and T10; this module does the rest:
 *
 *   C1  integrator pinned at Ki x error_limit          C8   cross-coupling: roll gyro vs d(pitch setpoint)/dt
 *   C2  cyclic output limits, ring, servos, collective C9   HSI: pitch error by sign of collective, axisO share
 *   C3  FF adequacy in steady full-stick rolls/flips   C10  I decay rate in flight at low collective (ground decay?)
 *   C4  stop overshoot and settling, I sign at stop    C11  share of axisD power above 30 Hz
 *   C6  slow (0.5-3 Hz) oscillation, I coherence
 *   T2  slow wag   T4 wag frequency per gain set   T5 stop overshoot per stop gain side   T6 collective kick
 *   T7  precomp vs I in collective pumps           T8 tail authority (output limits)     T9 piro FF
 *
 * Module contract (shared with the other health modules):
 *   EXTRA               extra logged fields for lib.segments(app, file, { whole: true, extra: EXTRA })
 *   analyse(w, ctx)     measurements of one whole-log segment; no good/bad thresholds, only measurement parameters (RULE)
 *   judge(flights, R)   findings from the measurements; every threshold comes from R (DEFAULT_RULES has the section-10 values)
 *
 * Units: rates deg/s, control (mixer, PID terms) as a fraction of full authority (logged value / 1000), time s,
 * collective in logged units (1000 = 12 deg). Event times are seconds from log start, as the viewer shows them.
 *
 * Sign conventions, from the firmware and checked against the data:
 *   - yaw P is multiplied by the CW stop gain when errorRate = setpoint - gyro > +10 deg/s, by the CCW one below -10
 *     (pid.c:1277). Stopping a rotation with negative yaw gyro gives errorRate > 0, so it uses the CW gain; the
 *     firmware says CW yaw is negative gyro (setpoint.c:291-292). T5 reports the P gain regressed on each side
 *     (lib.recoverGains, P_cw for error > +15) against header yaw_stop_gain [cw, ccw], which verifies the split.
 *   - the torque direction is read from the data: the tail holds the torque, so the median yaw control in flight has
 *     the opposite sign of the yaw that torque produces. With the firmware's sign, torque yawing positive (nose left)
 *     means a CW main rotor. T6 and T7 use only the data-derived sign.
 */

const lib = require('./lib.cjs');
const { cx, SCALE, AXES } = lib;

const RULE = {
    guardS: 1,                     // s excluded either side of a PID profile switch or governor state change
    limitSamples: 20,              // an extreme reached this often in flight is an output limit (wag.cjs RULE.limitSamples) ...
    limitBand: 0.02, servoBand: 20, collBand: 20, // ... and at least as often as the values within this band below it: a clamp piles samples up at one value
    limitTol: 0.0015,              // control within this of the limit counts as at it (1 logged unit is 0.001)
    ringTol: 0.003,                // hypot(roll, pitch) within this of its maximum counts as at the ring
    servoTol: 0.5,                 // us
    satHoldS: 0.005,               // saturation flag held after the limit, MIXER_SATURATION_TIME 5 cycles (mixer.h:55)
    pinnedLevels: [0.9, 0.95, 0.98], // |axisI| / (Ki x error_limit): longest run at or above each level is reported
    steady: { fraction: 0.7, minS: 0.5, skipS: 0.15, baselineS: 0.5 }, // C3, T9: |setpoint| >= fraction x max, this long
    stop: { from: 150, zero: 20, withinS: 0.1, holdS: 0.5, preS: 0.1, settle: 10, stayS: 0.1, sideS: 0.1, backS: 10 }, // C4, T5: settled = |gyro - setpoint| < settle for stayS
    blend: 10,                     // deg/s, firmware stop gain blend band (pid.c:1277)
    slow: { band: [0.5, 3], windowS: 4, quiet: 30, events: 10 }, // C6, T2: stick-quiet windows, |setpoint| <= quiet
    fast: { band: [5, 16], events: 200 }, // T4: yaw bursts (wag.cjs RULE.bands.yaw)
    cross: { windowS: 2, band: [0.5, 5], quiet: 30 }, // C8: roll setpoint quiet, pitch stick moving at least `quiet`
    hsi: { collDeg: 5, blockS: 0.5 }, // C9
    decay: { spanS: 0.1, quiet: 20, bins: [0, 2, 5, 8], groups: 10, windowS: 1, relaxLevel: 40 }, // C10, collective bins in deg; relax level is CLI-only, firmware default
    flight: { headspeed: lib.FLIGHT_RPM, rate: 10 }, // C10 landed-while-moving windows; health.cjs passes its flight gate as ctx.flightRule, this is the fallback
    dNoise: { hz: 30, windowS: 1 },  // C11
    kick: { fraction: 0.3, withinS: 0.2, afterS: 0.3, quiet: 30, refractoryS: 0.5, preS: 0.1 }, // T6: step >= fraction of range
    pump: { windowS: 2, fraction: 0.3, quiet: 30 }, // T7
    gainsFromS: 5,                 // gains are recovered from stretches on one profile at least this long
    degPerUnit: 12 / 1000,         // collective: 1000 mixer units = 12 deg (rc_rates.c:417-419)
    maxEvents: 200,
};

const EXTRA = ['mixer[3]', 'servo[0]', 'servo[1]', 'servo[2]', 'servo[3]', 'axisO[0]', 'axisO[1]'];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const mean = (x, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += x[i]; return s / (i1 - i0); };
const all = (m, i0, i1) => { for (let i = i0; i < i1; i++) if (!m[i]) return false; return true; };
const same = (x, i0, i1) => { for (let i = i0 + 1; i < i1; i++) if (x[i] !== x[i0]) return false; return true; };
const maxAbs = (x, i0, i1) => { let m = 0; for (let i = i0; i < i1; i++) m = Math.max(m, Math.abs(x[i])); return m; };
const swing = (x, i0, i1) => { let lo = Infinity, hi = -Infinity; for (let i = i0; i < i1; i++) { if (x[i] < lo) lo = x[i]; if (x[i] > hi) hi = x[i]; } return hi - lo; };

// mean, standard error across items, n
function stat(v) {
    const x = v.filter(q => typeof q === 'number' && isFinite(q)), n = x.length;
    if (!n) return { mean: null, se: null, n: 0 };
    const m = x.reduce((s, q) => s + q, 0) / n, sd = n > 1 ? Math.sqrt(x.reduce((s, q) => s + (q - m) ** 2, 0) / (n - 1)) : null;
    return { mean: r(m, 4), se: sd === null ? null : r(sd / Math.sqrt(n), 4), n };
}

const groupBy = (list, key) => { const g = {}; for (const e of list) (g[e[key]] = g[e[key]] || []).push(e); return g; };
const cap = (events, key = 'value') => events.length <= RULE.maxEvents ? events : events.slice().sort((a, b) => Math.abs(b[key]) - Math.abs(a[key])).slice(0, RULE.maxEvents).sort((a, b) => a.t - b.t);

// contiguous runs of samples for which pred(i) holds
function runs(n, pred) {
    const out = []; let s = -1;
    for (let i = 0; i <= n; i++) { const on = i < n && pred(i); if (on && s < 0) s = i; else if (!on && s >= 0) { out.push([s, i]); s = -1; } }
    return out;
}

// DFT of a window at a set of bins, after removing a straight line and applying a Hann window
function binsFor(N, rate, lo, hi, margin = 0) {
    const df = rate / N, k0 = Math.max(1, Math.ceil(lo / df) - margin), k1 = Math.floor(hi / df) + margin, ks = [];
    for (let k = k0; k <= k1; k++) ks.push(k);
    const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
    return { N, df, ks, hz: ks.map(k => k * df), cos: ks.map(k => Float64Array.from({ length: N }, (_, i) => Math.cos(2 * Math.PI * k * i / N) * win[i])),
        sin: ks.map(k => Float64Array.from({ length: N }, (_, i) => -Math.sin(2 * Math.PI * k * i / N) * win[i])), gain: win.reduce((s, v) => s + v, 0) / 2 };
}
function dft(x, s, B) {
    const N = B.N, c = (N - 1) / 2; let m = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < N; i++) m += x[s + i]; m /= N;
    for (let i = 0; i < N; i++) { sxy += (i - c) * (x[s + i] - m); sxx += (i - c) ** 2; }
    const b = sxy / sxx, out = [];
    for (let j = 0; j < B.ks.length; j++) { let re = 0, im = 0; const C = B.cos[j], S = B.sin[j];
        for (let i = 0; i < N; i++) { const v = x[s + i] - m - b * (i - c); re += v * C[i]; im += v * S[i]; }
        out.push([re, im]); }
    return out;
}

// collective-indexed curve, one point per degree 0..15 (pid.c: curve = |collective| x 0.8)
const curveAt = (curve, deg) => { const x = Math.min(15, Math.max(0, deg)), i = Math.min(14, Math.floor(x)); return curve[i] + (x - i) * (curve[i + 1] - curve[i]); };
const DECAY_CURVE = [12, 13, 14, 15, 17, 20, 23, 28, 36, 49, 78, 187, 250, 250, 250, 250]; // pid.c:65-66

// output limit of a control column: an extreme reached often enough in usable samples, and more often than the values
// just inside it (a steady manoeuvre also repeats its extreme value, but its neighbours are as frequent)
function limitOf(v, ok, tol, band) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < v.length; i++) if (ok[i]) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
    if (!isFinite(lo)) return null;
    let atLo = 0, atHi = 0, nearLo = 0, nearHi = 0;
    for (let i = 0; i < v.length; i++) if (ok[i]) { const x = v[i];
        if (x <= lo + tol) atLo++; else if (x <= lo + band) nearLo++;
        if (x >= hi - tol) atHi++; else if (x >= hi - band) nearHi++; }
    return { min: lo, max: hi, atMin: atLo, atMax: atHi, nearMin: nearLo, nearMax: nearHi,
        lo: atLo >= RULE.limitSamples && atLo >= nearLo ? lo : null, hi: atHi >= RULE.limitSamples && atHi >= nearHi ? hi : null };
}
const atLimit = (L, v, tol) => L && ((L.lo !== null && v <= L.lo + tol) || (L.hi !== null && v >= L.hi - tol));

// ---------------------------------------------------------------------------------------------
// analyse
// ---------------------------------------------------------------------------------------------

function dNoise(w, rate, prof, ok) {
    const n = w.n;
    const R = RULE.dNoise, N = Math.max(1, Math.round(R.windowS * rate)), res = {};
    for (const a of [0, 1, 2]) {
        // no axisD field: not measured. axisD always 0 (the D gain is 0: Gaui X4 II rollPID 50,100,0): there is no D-term noise to measure
        const D = w.D && w.D[a]; if (!D) { res[AXES[a]] = { skipped: `The log does not record axisD[${a}].` }; continue; }
        if (!D.some(v => v !== 0)) { res[AXES[a]] = { zero: true, byProfile: {} }; continue; }
        if (R.hz >= 0.45 * rate) { res[AXES[a]] = { skipped: `The log rate of ${r(rate, 0)} Hz is too low for the check at ${R.hz} Hz.` }; continue; }
        const hp = lib.bandpass(D, R.hz, 0.45 * rate, rate), acc = {};
        for (let s = 0; s + N <= n; s += N) {
            if (!all(ok, s, s + N) || !same(prof, s, s + N)) continue;
            const m = mean(D, s, s + N); let tot = 0, hi = 0; for (let i = s; i < s + N; i++) { tot += (D[i] - m) ** 2; hi += hp[i] ** 2; }
            if (!tot) continue;
            const A = acc[prof[s]] = acc[prof[s]] || { tot: 0, hi: 0, shares: [] }; A.tot += tot; A.hi += hi; A.shares.push(hi / tot);
        }
        const byProfile = {}; for (const p in acc) byProfile[p] = { share: r(acc[p].hi / acc[p].tot, 3), perWindow: stat(acc[p].shares), windows: acc[p].shares.length, dRms: r(Math.sqrt(acc[p].tot / acc[p].shares.length / N), 5) };
        res[AXES[a]] = { byProfile };
    }
    return res;
}

function analyse(w, ctx) {
    const rate = ctx.rate || w.rate, n = w.n, H = ctx.header || (w.flight && w.flight.header) || {}, X = w.extra || {};
    const prof = ctx.profile, gov = ctx.govState, notes = [];
    const t = (i) => r(w.fromS + i / rate, 3), S = (sec) => Math.max(1, Math.round(sec * rate));

    // usable: in flight, governor ACTIVE, away from profile switches and governor state changes
    const ok = new Uint8Array(n), guard = S(RULE.guardS);
    for (let i = 0; i < n; i++) ok[i] = ctx.flying[i] && (!gov || gov[i] === 4) ? 1 : 0;
    for (let i = 1; i < n; i++) if (prof[i] !== prof[i - 1] || (gov && gov[i] !== gov[i - 1])) ok.fill(0, Math.max(0, i - guard), Math.min(n, i + guard));
    if (!gov) notes.push('no GOVSTATE events: all in-flight samples used, not only governor ACTIVE');
    let usable = 0; for (let i = 0; i < n; i++) usable += ok[i];

    const out = { module: 'health_loop', rule: RULE, rate: r(rate, 2), fromS: r(w.fromS, 3), seconds: { total: r(n / rate, 1), usable: r(usable / rate, 1) }, notes };
    if (usable < S(5)) { out.skipped = `only ${r(usable / rate, 1)} s in flight with the governor active`; return out; }

    if (ctx.onlyFilters) { out.C11 = dNoise(w, rate, prof, ok); return out; }

    const collDeg = w.coll ? Float64Array.from(w.coll, v => Math.abs(v) * RULE.degPerUnit) : null;
    const startProfile = prof[0];

    // --- gains per profile: regressed from the logged terms (lib.recoverGains); header for the profile at log start
    const gains = {};
    { const ws = { flight: w.flight, n, rate: w.rate, profileAt: prof, airborneAt: ok, rescueAt: w.rescueAt, hs: w.hs, sp: w.sp, gyro: w.gyro, u: w.u, P: w.P, I: w.I, D: w.D, F: w.F, B: w.B, coll: w.coll, extra: {} };
        const acc = {};
        for (const seg of lib.steadySegments(ws, { minSegmentS: RULE.gainsFromS, minHeadspeed: 0 })) {
            const p = prof[seg.i0], a3 = acc[p] = acc[p] || { seconds: 0, list: [[], [], []] }; acc[p].seconds += seg.seconds;
            for (let a = 0; a < 3; a++) { const g = lib.recoverGains(seg, a);
                a3.list[a].push({ w: seg.seconds, P: g.P && g.P.gain, Pcw: g.P_cw && g.P_cw.gain, Pccw: g.P_ccw && g.P_ccw.gain, I: g.I && g.I.gain, Ir2: g.I && g.I.r2, D: g.D && g.D.gain, F: g.F && g.F.gain, gyroCutoff: g.gyroCutoff }); }
        }
        const wmed = (list, k) => { const v = list.filter(e => typeof e[k] === 'number' && isFinite(e[k])).sort((a, b) => a[k] - b[k]); if (!v.length) return null;
            const tot = v.reduce((s, e) => s + e.w, 0); let c = 0; for (const e of v) { c += e.w; if (c >= tot / 2) return e[k]; } return v[v.length - 1][k]; };
        const profiles = [...new Set(prof)];
        for (const p of profiles) {
            gains[p] = { seconds: acc[p] ? r(acc[p].seconds, 1) : 0 };
            for (let a = 0; a < 3; a++) {
                const L = acc[p] ? acc[p].list[a] : [], rec = {};
                for (const k of ['P', 'Pcw', 'Pccw', 'I', 'D', 'F', 'gyroCutoff']) rec[k] = r(wmed(L, k), 1);
                rec.segments = L.length;
                const hdr = H[AXES[a] + 'PID'];
                gains[p][AXES[a]] = { recovered: rec, header: +p === +startProfile && Array.isArray(hdr) ? { P: hdr[0], I: hdr[1], D: hdr[2], F: hdr[3], B: hdr[4] } : null };
                // yaw: the logged P is base x stop gain on either side, so recovered Pcw/Pccw carry it; the header P does not
                if (a === 2 && gains[p].yaw.header && Array.isArray(H.yaw_stop_gain)) gains[p].yaw.header.stopGain = H.yaw_stop_gain.slice(0, 2);
            }
        }
    }
    const gainOf = (p, a, k, preferHeader) => { const g = gains[p] && gains[p][AXES[a]]; if (!g) return null;
        const h = g.header && typeof g.header[k] === 'number' ? g.header[k] : null, v = typeof g.recovered[k] === 'number' ? g.recovered[k] : null;
        return preferHeader ? (h !== null ? h : v) : (v !== null ? v : h); };
    out.gains = gains;

    // --- output limits (C2, T8) and saturation masks
    const tolU = RULE.limitTol, lim = { roll: limitOf(w.u[0], ok, tolU, RULE.limitBand), pitch: limitOf(w.u[1], ok, tolU, RULE.limitBand), yaw: limitOf(w.u[2], ok, tolU, RULE.limitBand) };
    const hyp = Float64Array.from(w.u[0], (v, i) => Math.hypot(v, w.u[1][i]));
    { const okR = Uint8Array.from(ok, (v, i) => v && !atLimit(lim.roll, w.u[0][i], tolU) && !atLimit(lim.pitch, w.u[1][i], tolU) ? 1 : 0); // a ring not explained by an axis clamp
        const L = limitOf(hyp, okR, RULE.ringTol, RULE.limitBand); lim.ring = L && { max: L.max, atMax: L.atMax, hi: L.hi }; }
    lim.servo = [0, 1, 2, 3].map(k => X[`servo[${k}]`] ? limitOf(X[`servo[${k}]`], ok, RULE.servoTol, RULE.servoBand) : null);
    const m3 = X['mixer[3]'] || w.coll, cr = Array.isArray(H.collectiveRange) ? H.collectiveRange : null;
    lim.collective = m3 ? Object.assign(limitOf(m3, ok, 1, RULE.collBand), cr ? { range: cr } : {}) : null;
    // with the header range known, only that is a limit: a collective stick held at full is not saturation
    if (lim.collective && cr) { lim.collective.lo = lim.collective.min <= cr[0] + 1 ? cr[0] : null; lim.collective.hi = lim.collective.max >= cr[1] - 1 ? cr[1] : null; }
    const atCyc = (i) => atLimit(lim.roll, w.u[0][i], tolU) || atLimit(lim.pitch, w.u[1][i], tolU) || (lim.ring && lim.ring.hi !== null && hyp[i] >= lim.ring.hi - RULE.ringTol)
        || [0, 1, 2].some(k => lim.servo[k] && atLimit(lim.servo[k], X[`servo[${k}]`][i], RULE.servoTol)) || (lim.collective && atLimit(lim.collective, m3[i], 1));
    const atYaw = (i) => atLimit(lim.yaw, w.u[2][i], tolU) || (lim.servo[3] && atLimit(lim.servo[3], X['servo[3]'][i], RULE.servoTol));
    const satC = new Uint8Array(n), satY = new Uint8Array(n), hold = S(RULE.satHoldS);
    for (let i = 0; i < n; i++) { if (atCyc(i)) satC.fill(1, i, Math.min(n, i + hold + 1)); if (atYaw(i)) satY.fill(1, i, Math.min(n, i + hold + 1)); }
    const sat = [satC, satC, satY];
    const episodes = (pred, what) => runs(n, i => ok[i] && pred(i)).map(([a, b]) => ({ t: t(a), seconds: r((b - a) / rate, 3), value: r((b - a) / rate, 3), what, profile: prof[a] }));
    const limitJson = (L) => L && { min: r(L.min, 4), max: r(L.max, 4), samplesAtMin: L.atMin, samplesAtMax: L.atMax, samplesNearMin: L.nearMin, samplesNearMax: L.nearMax, limitLow: L.lo === null ? null : r(L.lo, 4), limitHigh: L.hi === null ? null : r(L.hi, 4) };
    const summarise = (ev) => { const g = groupBy(ev, 'profile'), o = {}; for (const p in g) o[p] = { episodes: g[p].length, seconds: r(g[p].reduce((s, e) => s + e.seconds, 0), 3), longestS: r(Math.max(...g[p].map(e => e.seconds)), 3) }; return o; };
    {
        const ev = [];
        for (const [name, a] of [['roll', 0], ['pitch', 1]]) ev.push(...episodes(i => atLimit(lim[name], w.u[a][i], tolU), 'mixer[' + a + ']'));
        if (lim.ring && lim.ring.hi !== null) ev.push(...episodes(i => hyp[i] >= lim.ring.hi - RULE.ringTol, 'ring'));
        for (let k = 0; k < 3; k++) if (lim.servo[k]) ev.push(...episodes(i => atLimit(lim.servo[k], X[`servo[${k}]`][i], RULE.servoTol), `servo[${k}]`));
        if (lim.collective) ev.push(...episodes(i => atLimit(lim.collective, m3[i], 1), 'collective'));
        ev.sort((a, b) => a.t - b.t);
        out.C2 = { method: 'limits are not in the header: an extreme of the logged value reached at least RULE.limitSamples times in flight, and at least as often as the values within RULE.limitBand inside it, is taken as the limit',
            limits: { roll: limitJson(lim.roll), pitch: limitJson(lim.pitch), ring: lim.ring && { max: r(lim.ring.max, 4), samplesAtMax: lim.ring.atMax, limit: lim.ring.hi === null ? null : r(lim.ring.hi, 4) },
                servo: lim.servo.slice(0, 3).map(limitJson), collective: lim.collective && Object.assign(limitJson(lim.collective), { headerRange: cr }) },
            missing: [0, 1, 2].filter(k => !lim.servo[k]).map(k => `servo[${k}]`).concat(X['mixer[3]'] ? [] : ['mixer[3] (setpoint[3] used)']),
            byProfile: summarise(episodes(atCyc, 'any')), events: cap(ev) };
        const evY = episodes(i => atLimit(lim.yaw, w.u[2][i], tolU), 'mixer[2]').concat(lim.servo[3] ? episodes(i => atLimit(lim.servo[3], X['servo[3]'][i], RULE.servoTol), 'servo[3]') : []).sort((a, b) => a.t - b.t);
        out.T8 = { method: out.C2.method, limits: { yaw: limitJson(lim.yaw), servo3: limitJson(lim.servo[3]) }, missing: lim.servo[3] ? [] : ['servo[3]'], byProfile: summarise(episodes(atYaw, 'any')), events: cap(evY) };
    }

    // --- rotation direction and stop gain side, from the data
    const torqueSign = (() => { const v = []; for (let i = 0; i < n; i += 10) if (ok[i]) v.push(w.u[2][i]); v.sort((a, b) => a - b); const m = v[v.length >> 1] || 0; return { median: m, sign: m > 0 ? -1 : m < 0 ? 1 : 0 }; })();
    {
        let precompSlope = null;
        if (w.coll) { let sxy = 0, sxx = 0, mx = 0, my = 0, k = 0; for (let i = 0; i < n; i += 5) if (ok[i]) { mx += collDeg[i]; my += w.F[2][i] - SCALE.F[2] * (gainOf(prof[i], 2, 'F', true) || 0) * w.sp[2][i]; k++; }
            if (k > 10) { mx /= k; my /= k; for (let i = 0; i < n; i += 5) if (ok[i]) { const dx = collDeg[i] - mx; sxy += dx * (w.F[2][i] - SCALE.F[2] * (gainOf(prof[i], 2, 'F', true) || 0) * w.sp[2][i] - my); sxx += dx * dx; } precompSlope = sxx ? sxy / sxx : null; } }
        const hdr = Array.isArray(H.yaw_stop_gain) ? H.yaw_stop_gain : null, hp = gainOf(startProfile, 2, 'P', true), rec = gains[startProfile] && gains[startProfile].yaw.recovered;
        out.rotation = { yawControlMedian: r(torqueSign.median, 4), torqueSign: torqueSign.sign, precompPerDeg: r(precompSlope, 5),
            precompAgrees: precompSlope === null || !torqueSign.sign ? null : Math.sign(precompSlope) === -torqueSign.sign,
            mainRotor: torqueSign.sign > 0 ? 'CW' : torqueSign.sign < 0 ? 'CCW' : null,
            how: 'torque yaws the body opposite to the median tail control; positive yaw gyro is CCW seen from above (setpoint.c:291-292: CW yaw is negative gyro), so torque yawing positive means a CW main rotor',
            stopGain: { header: hdr, headerOrder: '[cw, ccw]', basePfromHeader: hp,
                measuredCW: rec && hp && typeof rec.Pcw === 'number' ? r(rec.Pcw / hp * 100, 1) : null, measuredCCW: rec && hp && typeof rec.Pccw === 'number' ? r(rec.Pccw / hp * 100, 1) : null,
                byProfile: Object.fromEntries(Object.entries(gains).filter(([, g]) => typeof g.yaw.recovered.Pcw === 'number' && typeof g.yaw.recovered.Pccw === 'number')
                    .map(([p, g]) => [p, { Pcw: g.yaw.recovered.Pcw, Pccw: g.yaw.recovered.Pccw, ratio: r(g.yaw.recovered.Pcw / g.yaw.recovered.Pccw, 3), seconds: g.seconds }])),
                how: 'yaw P regressed separately for errorRate > +15 (lib.recoverGains P_cw) and < -15 deg/s. Their ratio needs no base P, so every profile tests the split: it matches header[0]/header[1] if errorRate > 0 uses header[0], the CW gain' } };
        { const sg = out.rotation.stopGain, best = Object.values(sg.byProfile).sort((a, b) => b.seconds - a.seconds)[0];
            sg.headerRatio = hdr && hdr[1] ? r(hdr[0] / hdr[1], 3) : null;
            sg.cwSideIsPositiveError = best && hdr && hdr[0] !== hdr[1] ? Math.abs(Math.log(best.ratio / (hdr[0] / hdr[1]))) < Math.abs(Math.log(best.ratio / (hdr[1] / hdr[0]))) : null; }
    }

    // --- C1: integrator pinned at Ki x error_limit
    {
        const el = Array.isArray(H.error_limit) ? H.error_limit : null;
        if (!el) out.C1 = { skipped: 'The header does not record error_limit.' };
        else {
            out.C1 = { errorLimit: el, note: 'limit = SCALE.I x I gain x error_limit (pid.c:1156-1166); I gain from the header for the profile at log start, else regressed; error_limit from the header for every profile' };
            for (const a of [0, 1]) {
                const byP = {}, ev = [];
                for (const p of Object.keys(gains)) {
                    const Ig = gainOf(p, a, 'I', true); if (!Ig) { byP[p] = { skipped: 'The I gain is unknown.' }; continue; }
                    const L = SCALE.I[a] * Ig * el[a], lvl = RULE.pinnedLevels, low = Math.min(...lvl);
                    const longest = lvl.map(() => 0); let seconds = 0, peak = 0, count = 0;
                    for (const [s, e] of runs(n, i => ok[i] && +prof[i] === +p && Math.abs(w.I[a][i]) >= low * L)) {
                        const pk = maxAbs(w.I[a], s, e) / L, lg = lvl.map(v => { let best = 0, c = 0; for (let i = s; i < e; i++) { c = Math.abs(w.I[a][i]) >= v * L ? c + 1 : 0; best = Math.max(best, c); } return best / rate; });
                        lg.forEach((v, k) => longest[k] = Math.max(longest[k], v)); seconds += (e - s) / rate; peak = Math.max(peak, pk); count++;
                        ev.push({ t: t(s), seconds: r((e - s) / rate, 3), value: r(pk, 3), longestAtLevel: Object.fromEntries(lvl.map((v, k) => [v, r(lg[k], 3)])), profile: +p, sign: Math.sign(w.I[a][s]) });
                    }
                    let mx = 0, usedN = 0; for (let i = 0; i < n; i++) if (ok[i] && +prof[i] === +p) { usedN++; mx = Math.max(mx, Math.abs(w.I[a][i])); }
                    byP[p] = { iGain: Ig, limit: r(L, 4), maxAbsI: r(mx, 4), maxRatio: r(mx / L, 3), runs: count, secondsAbove: r(seconds, 2), longestAtLevel: Object.fromEntries(lvl.map((v, k) => [v, r(longest[k], 3)])), seconds: r(usedN / rate, 1) };
                }
                out.C1[AXES[a]] = { byProfile: byP, events: cap(ev) };
            }
        }
    }

    // --- C3, T9: steady full-stick rolls, flips, piros
    const steady = (a) => {
        const R = RULE.steady, v = []; for (let i = 0; i < n; i += 5) if (ok[i]) v.push(Math.abs(w.sp[a][i])); v.sort((p, q) => p - q);
        const maxRate = v.length ? v[Math.floor(v.length * 0.999)] : 0, level = R.fraction * maxRate, ev = [];
        if (maxRate < RULE.stop.from) return { maxRate: r(maxRate, 0), level: r(level, 0), byProfile: {}, events: [], note: 'no full-stick manoeuvres' };
        for (const [s0, s1] of runs(n, i => ok[i] && Math.abs(w.sp[a][i]) >= level)) {
            if (s1 - s0 < S(R.minS) || !same(prof, s0, s1) || Math.sign(w.sp[a][s0]) !== Math.sign(w.sp[a][s1 - 1])) continue;
            const a0 = s0 + S(R.skipS), b0 = Math.max(0, s0 - S(R.baselineS)), dir = Math.sign(w.sp[a][s0]);
            let satN = 0; for (let i = s0; i < s1; i++) satN += sat[a][i];
            if (satN) continue;
            const ms = mean(w.sp[a], a0, s1), mg = mean(w.gyro[a], a0, s1), mI = mean(w.I[a], a0, s1), mF = mean(w.F[a], a0, s1), mu = mean(w.u[a], a0, s1);
            const Ib = mean(w.I[a], b0, s0), ub = mean(w.u[a], b0, s0), dI = (mI - Ib) * dir;
            const iShare = a < 2 ? (Math.abs(mF) > 1e-3 ? dI / Math.abs(mF) : null) : (Math.abs(mu - ub) > 1e-3 ? dI / Math.abs(mu - ub) : null);
            ev.push({ t: t(s0), seconds: r((s1 - s0) / rate, 2), profile: prof[s0], dir, value: r(iShare, 3), iShare: r(iShare, 3), iPerControl: r(Math.abs(mu - ub) > 1e-3 ? dI / Math.abs(mu - ub) : null, 3),
                gyroRatio: r(mg / ms, 3), setpoint: r(ms, 0), dI: r(dI, 4), meanF: r(mF, 4) });
        }
        const byProfile = {}; for (const [p, e] of Object.entries(groupBy(ev, 'profile'))) byProfile[p] = { iShare: stat(e.map(q => q.iShare)), gyroRatio: stat(e.map(q => q.gyroRatio)), seconds: r(e.reduce((s, q) => s + q.seconds, 0), 1) };
        return { maxRate: r(maxRate, 0), level: r(level, 0), iShareDefinition: a < 2 ? '(I - I before) x direction / |mean F|' : '(I - I before) x direction / |control - control before|', byProfile, events: cap(ev) };
    };
    out.C3 = { roll: steady(0), pitch: steady(1) };
    out.T9 = steady(2);

    // --- C4, T5: stops
    const stops = (a) => {
        const R = RULE.stop, ev = [], within = S(R.withinS), holdN = S(R.holdS);
        let lastHigh = -1;
        for (let i = 0; i < n; i++) {
            const v = Math.abs(w.sp[a][i]);
            if (v >= R.from) { lastHigh = i; continue; }
            if (lastHigh < 0 || v > R.zero) continue;
            const j = lastHigh; lastHigh = -1;
            if (i - j > within || i + holdN > n) continue;
            const s = i, e = i + holdN, dir = Math.sign(w.sp[a][j]);
            if (!all(ok, Math.max(0, j - S(R.preS)), e) || !same(prof, j, e) || maxAbs(w.sp[a], s, e) > R.zero) continue;
            let satN = 0; for (let k = j; k < e; k++) satN += sat[a][k]; if (satN) continue;
            const pre = mean(w.gyro[a], Math.max(0, j - S(R.preS)), j + 1) * dir;
            if (!(pre > R.from / 2)) continue;
            let over = 0, settled = -1, inside = 0; const stay = S(R.stayS);
            for (let k = s; k < e; k++) { over = Math.max(over, -dir * w.gyro[a][k]); inside = Math.abs(w.gyro[a][k] - w.sp[a][k]) < R.settle ? inside + 1 : 0; if (settled < 0 && inside >= stay) settled = k - stay + 1; }
            let m0 = j; while (m0 > 0 && j - m0 < S(R.backS) && Math.abs(w.sp[a][m0 - 1]) > R.zero) m0--;
            const dI = (w.I[a][s] - w.I[a][Math.max(0, m0 - 1)]) * dir;
            // error sign over the deceleration [j, s], where the stop gain acts; after s the gyro has often stopped or reversed
            let pos = 0, neg = 0; for (let k = j; k <= s; k++) { const er = w.sp[a][k] - w.gyro[a][k]; if (er > RULE.blend) pos++; else if (er < -RULE.blend) neg++; }
            const o = { t: t(s), profile: prof[s], dir, preRate: r(pre, 0), value: r(over / pre * 100, 1), overshootPct: r(over / pre * 100, 1), settleS: r(settled < 0 ? R.holdS : (settled - s) / rate, 3), settleCensored: settled < 0,
                dI: r(dI, 4), iWithRotation: dI > 0 };
            if (a === 2) Object.assign(o, { side: dir < 0 ? 'cw' : 'ccw', errorPositiveShare: r(pos / Math.max(1, pos + neg), 2) });
            ev.push(o); i = e - 1;
        }
        const agg = (e) => ({ overshootPct: stat(e.map(q => q.overshootPct)), settleS: stat(e.map(q => q.settleS)), iWithRotationShare: r(e.filter(q => q.iWithRotation).length / e.length, 2), dI: stat(e.map(q => q.dI)) });
        const byProfile = {};
        for (const [p, e] of Object.entries(groupBy(ev, 'profile'))) {
            byProfile[p] = agg(e);
            if (a === 2) { const sides = groupBy(e, 'side'); byProfile[p].cw = sides.cw ? agg(sides.cw) : null; byProfile[p].ccw = sides.ccw ? agg(sides.ccw) : null; }
        }
        return { byProfile, events: cap(ev) };
    };
    out.C4 = { roll: stops(0), pitch: stops(1) };
    out.T5 = Object.assign(stops(2), { sideDefinition: 'cw = stopping a rotation with negative yaw gyro: errorRate > +10 deg/s, CW stop gain (pid.c:1277); errorPositiveShare is the share of samples with errorRate > +10 (of those beyond +-10) over the deceleration, from the last |setpoint| >= RULE.stop.from to the stop',
        stopGain: out.rotation.stopGain });

    // --- C6, T2: slow oscillation in stick-quiet windows; T4 input: fast wag bursts
    const slow = (a) => {
        const R = RULE.slow, N = S(R.windowS), B = binsFor(N, rate, R.band[0], R.band[1], 1), K = B.ks.length, acc = {}, win = [];
        const e = Float64Array.from(w.gyro[a], (v, i) => v - w.sp[a][i]);
        for (let s = 0; s + N <= n; s += N >> 1) {
            if (!all(ok, s, s + N) || !same(prof, s, s + N) || maxAbs(w.sp[a], s, s + N) > R.quiet) continue;
            const E = dft(e, s, B), Q = dft(w.I[a], s, B), U = dft(w.u[a], s, B), p = prof[s], A = acc[p] = acc[p] || { windows: 0, ee: new Float64Array(K), ii: new Float64Array(K), uu: new Float64Array(K), re: new Float64Array(K), im: new Float64Array(K) };
            for (let k = 0; k < K; k++) { A.ee[k] += E[k][0] ** 2 + E[k][1] ** 2; A.ii[k] += Q[k][0] ** 2 + Q[k][1] ** 2; A.uu[k] += U[k][0] ** 2 + U[k][1] ** 2; A.re[k] += U[k][0] * Q[k][0] + U[k][1] * Q[k][1]; A.im[k] += U[k][0] * Q[k][1] - U[k][1] * Q[k][0]; }
            A.windows++; win.push({ s, p, amp: E.map(z => Math.hypot(z[0], z[1]) / B.gain) });
        }
        const byProfile = {}, ev = [];
        for (const p in acc) {
            const A = acc[p]; let best = -1;
            for (let k = 1; k < K - 1; k++) if (A.ee[k] >= A.ee[k - 1] && A.ee[k] >= A.ee[k + 1] && (best < 0 || A.ee[k] > A.ee[best])) best = k;
            const band = Array.from(A.ee.slice(1, K - 1)).sort((x, y) => x - y), med = band[band.length >> 1];
            if (best < 0) { byProfile[p] = { windows: A.windows, hz: null, prominence: null, note: 'no local maximum inside the band' }; continue; }
            // how much of the control at the peak is the I term: projection of I on the control, over the control's power
            const iShare = A.re[best] / A.uu[best], ph = Math.atan2(A.im[best], A.re[best]) * 180 / Math.PI;
            byProfile[p] = { windows: A.windows, seconds: r(A.windows * R.windowS / 2, 1), hz: r(B.hz[best], 3), binHz: r(B.df, 3), prominence: r(Math.sqrt(A.ee[best] / med), 2),
                amplitude: r(Math.sqrt(A.ee[best] / A.windows) / B.gain, 2), iShareOfControl: r(iShare, 3), iPhaseToControlDeg: r(ph, 0), iAmplitude: r(Math.sqrt(A.ii[best] / A.windows) / B.gain, 4), controlAmplitude: r(Math.sqrt(A.uu[best] / A.windows) / B.gain, 4) };
            for (const q of win.filter(q => q.p == p).sort((x, y) => y.amp[best] - x.amp[best]).slice(0, R.events)) ev.push({ t: t(q.s), seconds: R.windowS, profile: +p, hz: r(B.hz[best], 3), value: r(q.amp[best], 2) });
        }
        return { byProfile, events: ev.sort((x, y) => x.t - y.t) };
    };
    out.C6 = { roll: slow(0), pitch: slow(1) };
    out.T2 = slow(2);
    {
        const e = Float64Array.from(w.gyro[2], (v, i) => v - w.sp[2][i]), F = RULE.fast;
        const ev = lib.oscillationBursts(e, rate, { band: F.band, freq: F.band }).bursts.filter(b => mean(ok, Math.max(0, b.i0), Math.min(n, b.i1)) >= 0.5)
            .map(b => ({ t: t(b.i0), seconds: r(b.seconds, 2), hz: r(b.hz, 2), value: r(b.amplitude, 1), profile: prof[Math.max(0, b.i0)] }));
        const byProfile = {};
        for (const p of Object.keys(gains)) {
            const e2 = ev.filter(q => +q.profile === +p), y = gains[p].yaw;
            byProfile[p] = { gains: { header: y.header, recovered: y.recovered }, fast: { hz: stat(e2.map(q => q.hz)), amplitude: stat(e2.map(q => q.value)), bursts: e2.length },
                slow: out.T2.byProfile[p] ? { hz: out.T2.byProfile[p].hz, prominence: out.T2.byProfile[p].prominence, windows: out.T2.byProfile[p].windows } : null };
        }
        out.T4 = { band: F.band, byProfile, events: cap(ev) };
    }

    // --- C8: roll response to pitch stick rate while the roll stick is quiet
    {
        const R = RULE.cross, N = S(R.windowS), B = binsFor(N, rate, R.band[0], R.band[1]), K = B.ks.length, acc = {};
        const dsp = new Float64Array(n); for (let i = 1; i < n - 1; i++) dsp[i] = (w.sp[1][i + 1] - w.sp[1][i - 1]) * rate / 2;
        for (let s = 0; s + N <= n; s += N >> 1) {
            if (!all(ok, s, s + N) || !same(prof, s, s + N) || maxAbs(w.sp[0], s, s + N) > R.quiet || swing(w.sp[1], s, s + N) < R.quiet) continue;
            const Xf = dft(dsp, s, B), Yf = dft(w.gyro[0], s, B), p = prof[s], A = acc[p] = acc[p] || { windows: 0, xx: new Float64Array(K), yy: new Float64Array(K), re: new Float64Array(K), im: new Float64Array(K) };
            for (let k = 0; k < K; k++) { A.xx[k] += Xf[k][0] ** 2 + Xf[k][1] ** 2; A.yy[k] += Yf[k][0] ** 2 + Yf[k][1] ** 2; A.re[k] += Xf[k][0] * Yf[k][0] + Xf[k][1] * Yf[k][1]; A.im[k] += Xf[k][0] * Yf[k][1] - Xf[k][1] * Yf[k][0]; }
            A.windows++;
        }
        const byProfile = {};
        for (const p in acc) {
            const A = acc[p]; let sx = 0, re = 0, im = 0, sc = 0;
            const bins = B.ks.map((_, k) => { sx += A.xx[k]; re += A.re[k]; im += A.im[k]; const coh = (A.re[k] ** 2 + A.im[k] ** 2) / (A.xx[k] * A.yy[k]); sc += coh * A.xx[k];
                return { hz: r(B.hz[k], 2), coherence: r(coh, 3), gain: r(Math.hypot(A.re[k], A.im[k]) / A.xx[k], 5), phaseDeg: r(Math.atan2(A.im[k], A.re[k]) * 180 / Math.PI, 0) }; });
            byProfile[p] = { windows: A.windows, coherence: r(sc / sx, 3), gain: r(Math.hypot(re, im) / sx, 5), gainSigned: r(re / sx, 5), phaseDeg: r(Math.atan2(im, re) * 180 / Math.PI, 0), units: 'deg/s of roll per deg/s^2 of pitch setpoint rate', bins };
        }
        out.C8 = { headerCyclicCoupling: H.cyclic_coupling || null, byProfile };
    }

    // --- C9: HSI, pitch error by sign of collective at |collective| >= 5 deg
    if (!w.coll) out.C9 = { skipped: 'The log does not record the collective setpoint.' };
    else {
        const R = RULE.hsi, B = S(R.blockS), byProfile = {}, O = [X['axisO[0]'], X['axisO[1]']];
        const blocks = {};
        for (let s = 0; s + B <= n; s += B) {
            if (!all(ok, s, s + B) || !same(prof, s, s + B)) continue;
            let pos = 0, neg = 0; for (let i = s; i < s + B; i++) { if (collDeg[i] >= R.collDeg) { if (w.coll[i] > 0) pos++; else neg++; } }
            if (pos < B && neg < B) continue;
            const p = prof[s], sign = pos === B ? 'positive' : 'negative', bl = blocks[p] = blocks[p] || { positive: [], negative: [], ss: [0, 0], so: [0, 0], si: [0, 0], at: { positive: [], negative: [] } };
            let e = 0; for (let i = s; i < s + B; i++) { e += w.sp[1][i] - w.gyro[1][i]; for (const a of [0, 1]) { bl.si[a] += w.I[a][i] ** 2; if (O[a]) bl.so[a] += (O[a][i] / 1000) ** 2; } }
            bl[sign].push(e / B); bl.at[sign].push(s);
        }
        for (const p in blocks) {
            const b = blocks[p], P = stat(b.positive), Nn = stat(b.negative);
            byProfile[p] = { pitchErrorPositive: P, pitchErrorNegative: Nn, difference: P.n && Nn.n ? r(P.mean - Nn.mean, 3) : null, differenceSe: P.se !== null && Nn.se !== null ? r(Math.hypot(P.se, Nn.se), 3) : null,
                oShare: [0, 1].map(a => O[a] ? r(Math.sqrt(b.so[a]) / (Math.sqrt(b.so[a]) + Math.sqrt(b.si[a]) || 1), 3) : null) };
        }
        const ev = []; for (const p in blocks) for (const sign of ['positive', 'negative']) blocks[p][sign].forEach((v, k) => ev.push({ t: t(blocks[p].at[sign][k]), seconds: R.blockS, profile: +p, collective: sign, value: r(v, 2) }));
        out.C9 = { definition: 'mean pitch error (setpoint - gyro) in 0.5 s blocks with |collective| >= 5 deg, by sign of collective; oShare = rms axisO / (rms axisO + rms axisI) per roll, pitch',
            missing: [0, 1].filter(a => !O[a]).map(a => `axisO[${a}]`), byProfile, events: cap(ev) };
    }

    // --- C10: I decay rate in flight at low collective; spooled up and moving while the firmware says landed
    if (!w.coll) out.C10 = { skipped: 'The log does not record the collective setpoint.' };
    else {
        const R = RULE.decay, span = S(R.spanS), ed = Array.isArray(H.error_decay) ? H.error_decay : null, groundTau = typeof H.error_decay_ground === 'number' && H.error_decay_ground > 0 ? H.error_decay_ground / 10 : null;
        const res = {};
        for (const a of [0, 1]) {
            const byProfile = {};
            for (const p of Object.keys(gains)) {
                const bw = +p === +startProfile && Array.isArray(H[AXES[a] + 'BW']) ? H[AXES[a] + 'BW'][0] : null, gc = bw || gainOf(p, a, 'gyroCutoff') || 50, gf = lib.lpf1(w.gyro[a], gc, rate), bins = [];
                const rc = Array.isArray(H.iterm_relax_cutoff) ? H.iterm_relax_cutoff[a] : 10, rf = H.iterm_relax_type === 0 ? null : lib.relaxFactor(w.sp[a], R.relaxLevel, rc || 10, rate);
                for (let b = 0; b + 1 < R.bins.length; b++) {
                    const rows = [];
                    for (let s = 0; s + span < n; s += span) {
                        let good = +prof[s] === +p; for (let i = s; i <= s + span && good; i++) good = ok[i] && !sat[a][i] && collDeg[i] >= R.bins[b] && collDeg[i] < R.bins[b + 1] && Math.abs(w.sp[a][i]) <= R.quiet && +prof[i] === +p;
                        if (!good) continue;
                        // the logged I is after this loop's update: I[s + span] - I[s] integrates the errors of samples s + 1 .. s + span
                        let x1 = 0, x2 = 0, c = 0; for (let i = s; i < s + span; i++) { x1 += (w.sp[a][i + 1] - gf[i + 1]) * (rf ? rf[i + 1] : 1) / rate; x2 -= w.I[a][i] / rate; c += collDeg[i]; }
                        rows.push([x1, x2, w.I[a][s + span] - w.I[a][s], c / span]);
                    }
                    const fit = (sel) => { let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0; for (const q of sel) { a11 += q[0] * q[0]; a12 += q[0] * q[1]; a22 += q[1] * q[1]; b1 += q[0] * q[2]; b2 += q[1] * q[2]; }
                        const det = a11 * a22 - a12 * a12; return det > 0 ? { ki: (b1 * a22 - b2 * a12) / det, lambda: (b2 * a11 - b1 * a12) / det } : null; };
                    const f = rows.length >= 2 * R.groups ? fit(rows) : null, cm = rows.length ? rows.reduce((s, q) => s + q[3], 0) / rows.length : null;
                    let se = null;
                    if (f) { const G = R.groups, per = Math.floor(rows.length / G), jk = [];
                        for (let g = 0; g < G; g++) { const q = fit(rows.filter((_, k) => Math.floor(k / per) !== g)); if (q) jk.push(q.lambda); }
                        const m = jk.reduce((s, v) => s + v, 0) / jk.length; se = Math.sqrt((jk.length - 1) / jk.length * jk.reduce((s, v) => s + (v - m) ** 2, 0)); }
                    const airLambda = ed && cm !== null ? (10 / ed[0]) * curveAt(DECAY_CURVE, cm) * 0.08 : null;
                    bins.push({ collectiveDeg: [R.bins[b], R.bins[b + 1]], meanCollectiveDeg: r(cm, 2), spans: rows.length, seconds: r(rows.length * R.spanS, 1),
                        lambdaPerS: f ? r(f.lambda, 4) : null, lambdaSe: r(se, 4), tauS: f && f.lambda > 0 ? r(1 / f.lambda, 2) : null, tauSe: f && f.lambda > 0 && se !== null ? r(se / f.lambda ** 2, 2) : null,
                        kiFit: f ? r(f.ki / SCALE.I[a], 1) : null, expectedAirborneTauS: airLambda ? r(1 / airLambda, 2) : null, expectedGroundTauS: groundTau });
                }
                byProfile[p] = { bins };
            }
            res[AXES[a]] = { byProfile };
        }
        // spooled up and turning while the firmware says landed (only meaningful if the log has AIRBORNE_STATE events)
        const hasAirborne = w.airborneAt ? w.airborneAt.some(v => !v) : false, W = S(R.windowS), ev = [], FL = ctx.flightRule || RULE.flight;
        if (hasAirborne) for (let s = 0; s + W <= n; s += W) {
            let landed = true, rms = 0; for (let i = s; i < s + W && landed; i++) { landed = !w.airborneAt[i] && w.hs[i] >= FL.headspeed && (!gov || gov[i] === 4); rms += w.gyro[0][i] ** 2 + w.gyro[1][i] ** 2 + w.gyro[2][i] ** 2; }
            if (landed && Math.sqrt(rms / W) >= FL.rate) ev.push({ t: t(s), seconds: R.windowS, profile: prof[s], value: r(Math.sqrt(rms / W), 1) });
        }
        out.C10 = Object.assign(res, { headerErrorDecay: ed, headerErrorDecayGround: H.error_decay_ground === undefined ? null : H.error_decay_ground,
            method: 'dI = Ki sum(relax x error) dt - lambda sum(I) dt over 0.1 s spans with the stick quiet, per collective bin (relax level assumed RULE.decay.relaxLevel, cutoff from the header); SE by leave-one-group-out over 10 groups. Offset flood (> 2 deg) moves I into O and also shows as decay',
            airborneStateLogged: hasAirborne, landedWhileMoving: hasAirborne ? { seconds: r(ev.length * R.windowS, 1), events: cap(ev) } : { skipped: 'The log has no AIRBORNE_STATE log events.' } });
    }

    out.C11 = dNoise(w, rate, prof, ok);

    // --- T6: yaw kick after collective steps; T7: precomp against I in collective pumps
    if (!w.coll) { out.T6 = { skipped: 'The log does not record the collective setpoint.' }; out.T7 = { skipped: 'The log does not record the collective setpoint.' }; }
    else {
        let range = cr ? cr[1] - cr[0] : null;
        if (!range) { const v = []; for (let i = 0; i < n; i += 10) if (ok[i]) v.push(w.coll[i]); v.sort((p, q) => p - q); range = v.length ? v[Math.floor(v.length * 0.995)] - v[Math.floor(v.length * 0.005)] : 0; }
        const R = RULE.kick, Wd = S(R.withinS), after = S(R.afterS), pre = S(R.preS), e = Float64Array.from(w.gyro[2], (v, i) => v - w.sp[2][i]), ev = [];
        for (let i = Wd; i < n; i++) {
            const d = w.coll[i] - w.coll[i - Wd]; if (Math.abs(d) < R.fraction * range) continue;
            const s = i - Wd, end = Math.min(n, s + after + Wd);
            const skip = () => { i += S(R.refractoryS); };
            if (s - pre < 0 || !all(ok, s - pre, end) || !same(prof, s - pre, end) || swing(w.sp[2], s - pre, end) > R.quiet) { skip(); continue; }
            let satN = 0; for (let k = s; k < end; k++) satN += satY[k]; if (satN) { skip(); continue; }
            const base = mean(e, s - pre, s); let pk = 0; for (let k = s; k < end; k++) if (Math.abs(e[k] - base) > Math.abs(pk)) pk = e[k] - base;
            const dAbs = Math.abs(w.coll[i]) - Math.abs(w.coll[s]), torque = Math.sign(dAbs) * torqueSign.sign;
            ev.push({ t: t(s), profile: prof[s], collectiveStep: r(d, 0), absCollectiveChange: r(dAbs, 0), peak: r(pk, 1), value: torque ? r(pk * torque, 1) : null, withTorque: torque ? pk * torque > 0 : null });
            skip();
        }
        const byProfile = {};
        for (const [p, e2] of Object.entries(groupBy(ev, 'profile'))) {
            const sgn = e2.filter(q => q.value !== null);
            byProfile[p] = { events: e2.length, absPeak: stat(e2.map(q => Math.abs(q.peak))), towardTorque: stat(sgn.map(q => q.value)), withTorqueShare: sgn.length ? r(sgn.filter(q => q.withTorque).length / sgn.length, 2) : null };
        }
        out.T6 = { range: r(range, 0), torqueSign: torqueSign.sign, definition: 'peak of (yaw gyro - setpoint) within RULE.kick.afterS of a collective step; value > 0 when it yaws the way the torque change pushes (the torque change of a rise in |collective| pushes toward torqueSign)', byProfile, events: cap(ev) };

        const P = RULE.pump, N = S(P.windowS), wins = [];
        for (let s = 0; s + N <= n; s += N >> 1) {
            if (!all(ok, s, s + N) || !same(prof, s, s + N) || swing(w.coll, s, s + N) < P.fraction * range || swing(w.sp[2], s, s + N) > P.quiet) continue;
            let satN = 0; for (let k = s; k < s + N; k++) satN += satY[k]; if (satN) continue;
            const Fg = gainOf(prof[s], 2, 'F', true) || 0, pc = new Float64Array(N);
            for (let k = 0; k < N; k++) pc[k] = w.F[2][s + k] - SCALE.F[2] * Fg * w.sp[2][s + k];
            const mp = mean(pc, 0, N), mi = mean(w.I[2], s, s + N); let sxy = 0, sxx = 0, syy = 0;
            for (let k = 0; k < N; k++) { const dx = pc[k] - mp, dy = w.I[2][s + k] - mi; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
            if (!sxx || !syy) continue;
            wins.push({ t: t(s), seconds: P.windowS, profile: prof[s], value: r(sxy / Math.sqrt(sxx * syy), 3), slope: r(sxy / sxx, 3), sxy, sxx, precompSwing: r(swing(pc, 0, N), 4) });
        }
        const byP = {};
        for (const [p, e2] of Object.entries(groupBy(wins, 'profile'))) {
            const k = e2.reduce((s, q) => s + q.sxy, 0) / e2.reduce((s, q) => s + q.sxx, 0);
            const jk = e2.length > 2 ? e2.map((_, j) => { const o = e2.filter((__, q) => q !== j); return o.reduce((s, q) => s + q.sxy, 0) / o.reduce((s, q) => s + q.sxx, 0); }) : null;
            const m = jk ? jk.reduce((s, v) => s + v, 0) / jk.length : null, se = jk ? Math.sqrt((jk.length - 1) / jk.length * jk.reduce((s, v) => s + (v - m) ** 2, 0)) : null;
            byP[p] = { windows: e2.length, r: stat(e2.map(q => q.value)), slope: r(k, 3), slopeSe: r(se, 3), precompScale: r(1 + k, 2),
                yawF: gainOf(p, 2, 'F', true) };
        }
        out.T7 = { definition: 'correlation of axisI[2] with the precomp part of axisF[2] (axisF[2] - Kf x setpoint[2]) in 2 s windows with collective swing >= RULE.pump.fraction of range and the yaw stick quiet; precompScale = 1 + slope of I on precomp is the scale that would leave I flat (< 0: wrong sign)',
            byProfile: byP, events: cap(wins.map(({ sxy, sxx, ...q }) => q)) };
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------------------------

const DEFAULT_RULES = {
    C1: { level: 0.95, minS: 0.2, source: 'firmware', note: 'limit from firmware (pid.c:1156-1166); 95 % and 0.2 s are pipeline, unvalidated' },
    C2: { minEpisodes: 1, source: 'firmware', note: 'limits enforced by the firmware; detected from the data (RULE.limitSamples, pipeline)' },
    C3: { iShare: 0.10, gyroRatio: [0.9, 1.1], minEvents: 3, source: 'pipeline, unvalidated', note: 'doc says only "I remains near 0" (TUNE)' },
    C4: { overshootPct: 10, settleS: 0.3, minEvents: 3, source: 'pipeline, unvalidated' },
    C6: { prominence: 5, minWindows: 8, source: 'pipeline, unvalidated', note: 'band from doc (TUNE 0.5-1, PROF 1-3 Hz)' },
    C8: { minWindows: 10, source: 'pipeline, unvalidated', note: 'report only, no threshold' },
    C9: { minBlocks: 10, source: 'pipeline, unvalidated', note: 'report only' },
    C10: { tau: [2, 3], airborneTauMin: 5, minSpans: 200, source: 'firmware', note: 'ground decay tau 2.5 s at error_decay_ground 25 (pid.c:1170-1181); window pipeline' },
    C11: { share: 0.5, minWindows: 10, source: 'pipeline, unvalidated' },
    T2: { prominence: 5, minWindows: 8, source: 'pipeline, unvalidated', note: 'band from doc' },
    T4: { hzChange: 0.10, gainChange: 0.20, minBursts: 5, source: 'pipeline, unvalidated', note: 'rationale PROC45' },
    T5: { ratio: 1.5, minEvents: 3, source: 'pipeline, unvalidated', note: '+-10 deg/s blend is firmware (pid.c:1277)' },
    T6: { kick: 30, minEvents: 3, source: 'pipeline, unvalidated', note: 'sign rule PROF' },
    T7: { r: 0.5, minWindows: 5, source: 'pipeline, unvalidated', note: 'rationale [COM] RCG-55' },
    T8: { minEpisodes: 1, source: 'firmware' },
    T9: { iShare: 0.10, gyroRatio: [0.9, 1.1], minEvents: 3, source: 'pipeline, unvalidated' },
};

function judge(flights, RULES = DEFAULT_RULES) {
    const F = [], fmt = (v, d = 2) => v === null || v === undefined ? 'n/a' : (+v).toFixed(d);
    const add = (id, severity, f, profile, o) => F.push(Object.assign({ id, severity, log: f.log, profile: profile === undefined || profile === null ? null : +profile, value: null, se: null, n: null, threshold: null, source: (RULES[id] || {}).source || null }, o));
    const thin = (n, min, what) => `No result: ${n} ${what}. A minimum of ${min} is necessary.`;

    for (const f of flights) {
        const M = f.metrics || {};
        if (M.skipped) { for (const id of Object.keys(RULES)) add(id, 'skipped', f, null, { text: M.skipped }); continue; }

        // C1
        if (M.C1) { const R = RULES.C1; if (M.C1.skipped) add('C1', 'skipped', f, null, { text: M.C1.skipped });
            else for (const ax of ['roll', 'pitch']) for (const [p, m] of Object.entries(M.C1[ax].byProfile)) {
                if (m.skipped) { add('C1', 'skipped', f, p, { axis: ax, text: m.skipped }); continue; }
                const lv = Object.keys(m.longestAtLevel).map(Number).filter(v => v >= R.level).sort((a, b) => a - b)[0], longest = lv === undefined ? null : m.longestAtLevel[lv];
                const flag = longest !== null && longest > R.minS;
                add('C1', flag ? 'flag' : 'ok', f, p, { axis: ax, value: longest, n: m.runs, threshold: `> ${R.minS} s at >= ${lv} of the limit`,
                    text: `The ${ax} I-term stays at ${Math.round(lv * 100)} % or more of its limit for a maximum of ${fmt(longest, 2)} s. The limit is ${fmt(m.limit, 3)} ("I ${m.iGain} x error_limit"). The largest I-term value without its sign is ${fmt(m.maxRatio, 2)} of the limit.` + (flag ? '\nThe I-term has a small reserve. This does not show the cause of the load or if the gyro follows the setpoint.' : '') });
            } }
        // C2, T8
        for (const id of ['C2', 'T8']) { const m = M[id]; if (!m) continue; const R = RULES[id];
            const lims = m.limits;
            const profs = Object.keys(m.byProfile);
            if (!profs.length) add(id, 'ok', f, null, { value: 0, n: 0, threshold: `>= ${R.minEpisodes} episode`, text: `The check finds no periods at an output limit. Recorded ranges: ${id === 'C2' ? `roll ${fmt(lims.roll && lims.roll.min, 3)} to ${fmt(lims.roll && lims.roll.max, 3)}, pitch ${fmt(lims.pitch && lims.pitch.min, 3)} to ${fmt(lims.pitch && lims.pitch.max, 3)}` : `yaw ${fmt(lims.yaw && lims.yaw.min, 3)} to ${fmt(lims.yaw && lims.yaw.max, 3)}`}. The header does not record these limits.` + (m.missing.length ? ` The log does not record ${m.missing.join(', ')}.` : '') });
            for (const p of profs) { const s = m.byProfile[p], flag = s.episodes >= R.minEpisodes;
                const what = [...new Set(m.events.filter(e => +e.profile === +p).map(e => e.what))].join(', ');
                add(id, flag ? 'flag' : 'ok', f, p, { value: s.seconds, n: s.episodes, threshold: `>= ${R.minEpisodes} episode`, text: `There are ${s.episodes} periods at an output limit (${what}), for a total of ${fmt(s.seconds, 2)} s. The longest period is ${fmt(s.longestS, 3)} s. The analysis finds these limits from the data. The output limit does not identify its cause.` }); } }
        // C3, T9
        for (const [id, list] of [['C3', M.C3 ? [['roll', M.C3.roll], ['pitch', M.C3.pitch]] : []], ['T9', M.T9 ? [['yaw', M.T9]] : []]]) { const R = RULES[id];
            for (const [ax, m] of list) { const profs = Object.keys(m.byProfile);
                if (!profs.length) add(id, 'note', f, null, { axis: ax, n: 0, text: `No result: no stable ${ax} maneuver at ${fmt(m.level, 0)} deg/s or more for ${RULE.steady.minS} s with no output limit.` });
                for (const p of profs) { const s = m.byProfile[p], n = s.iShare.n;
                    if (n < R.minEvents) { add(id, 'note', f, p, { axis: ax, value: s.iShare.mean, se: s.iShare.se, n, text: thin(n, R.minEvents, 'stable maneuvers') + ` The I-term ratio is ${fmt(s.iShare.mean)}. The gyro/setpoint ratio is ${fmt(s.gyroRatio.mean)}.` }); continue; }
                    const badI = Math.abs(s.iShare.mean) > R.iShare, badG = s.gyroRatio.mean < R.gyroRatio[0] || s.gyroRatio.mean > R.gyroRatio[1];
                    add(id, badI || badG ? 'flag' : 'ok', f, p, { axis: ax, value: s.iShare.mean, se: s.iShare.se, n, threshold: `|I share| <= ${R.iShare}, gyro/setpoint ${R.gyroRatio.join('-')}`,
                        gyroRatio: s.gyroRatio, text: `The ${ax} I-term ratio is ${fmt(s.iShare.mean)} ± ${fmt(s.iShare.se)} in ${n} maneuvers. The gyro/setpoint ratio is ${fmt(s.gyroRatio.mean, 3)} ± ${fmt(s.gyroRatio.se, 3)}.` +
                        (badI ? (s.iShare.mean > 0 ? ' I supplies part of the rate. "FF too low" is one possible cause.' : ' I operates against FF. "FF too high" is one possible cause.') : '') + (badG && !badI ? ' The rate is not equal to the setpoint.' : '') }); } } }
        // C4, T5
        if (M.C4) { const R = RULES.C4; for (const ax of ['roll', 'pitch']) { const m = M.C4[ax], profs = Object.keys(m.byProfile);
            if (!profs.length) add('C4', 'note', f, null, { axis: ax, n: 0, text: `No result: no ${ax} stops from ${RULE.stop.from} deg/s or more.` });
            for (const p of profs) { const s = m.byProfile[p], n = s.overshootPct.n;
                if (n < R.minEvents) { add('C4', 'note', f, p, { axis: ax, value: s.overshootPct.mean, se: s.overshootPct.se, n, text: thin(n, R.minEvents, 'stops') + ` The overshoot is ${fmt(s.overshootPct.mean, 1)} %. The gyro becomes stable after ${fmt(s.settleS.mean)} s.` }); continue; }
                const flag = s.overshootPct.mean > R.overshootPct || s.settleS.mean > R.settleS, ff = s.iWithRotationShare >= 0.5 ? 'I has the same sign as the turn at the stop. "FF too low" is one possible cause.' : 'I has the opposite sign to the turn at the stop. "FF too high", I-term relax or B gain are possible causes.';
                add('C4', flag ? 'flag' : 'ok', f, p, { axis: ax, value: s.overshootPct.mean, se: s.overshootPct.se, n, threshold: `overshoot <= ${R.overshootPct} %, settling <= ${R.settleS} s`, settleS: s.settleS,
                    text: `The ${ax} stop overshoot is ${fmt(s.overshootPct.mean, 1)} ± ${fmt(s.overshootPct.se, 1)} %. The gyro becomes stable after ${fmt(s.settleS.mean)} ± ${fmt(s.settleS.se)} s. I has the same sign as the turn in ${Math.round(s.iWithRotationShare * 100)} % of ${n} stops.` + (flag ? '\n' + ff : '') }); } } }
        if (M.T5) { const R = RULES.T5, sg = M.T5.stopGain || {};
            const check = sg.measuredCW !== null && sg.measuredCW !== undefined ? `\nThe calculated stop gains are ${fmt(sg.measuredCW, 0)} for positive error and ${fmt(sg.measuredCCW, 0)} for negative error. The header values are "${JSON.stringify(sg.header)} [cw, ccw]".` : '';
            const profs = Object.keys(M.T5.byProfile); if (!profs.length) add('T5', 'note', f, null, { n: 0, text: 'No result: no yaw stops from 150 deg/s or more.' });
            for (const p of profs) { const s = M.T5.byProfile[p], c = s.cw, w = s.ccw, nc = c ? c.overshootPct.n : 0, nw = w ? w.overshootPct.n : 0;
                if (nc < R.minEvents || nw < R.minEvents) { add('T5', 'note', f, p, { n: Math.min(nc, nw), text: thin(Math.min(nc, nw), R.minEvents, 'stops on one side') + ` The "CW-gain" side has ${nc} stops with an overshoot of ${fmt(c && c.overshootPct.mean, 1)} %. The "CCW-gain" side has ${nw} stops with an overshoot of ${fmt(w && w.overshootPct.mean, 1)} %.` + check }); continue; }
                const oc = Math.max(c.overshootPct.mean, 1), ow = Math.max(w.overshootPct.mean, 1), ratio = Math.max(oc, ow) / Math.min(oc, ow), big = oc > ow ? 'cw' : 'ccw';
                const se = ratio * Math.hypot((c.overshootPct.se || 0) / oc, (w.overshootPct.se || 0) / ow), flag = ratio >= R.ratio;
                add('T5', flag ? 'flag' : 'ok', f, p, { value: r(ratio, 2), se: r(se, 2), n: nc + nw, threshold: `ratio >= ${R.ratio}`, larger: big,
                    text: `The yaw stop overshoot on the "CW-gain" side is ${fmt(c.overshootPct.mean, 1)} ± ${fmt(c.overshootPct.se, 1)} % in ${nc} stops. On the "CCW-gain" side, it is ${fmt(w.overshootPct.mean, 1)} ± ${fmt(w.overshootPct.se, 1)} % in ${nw} stops. The ratio is ${fmt(ratio)} ± ${fmt(se)}.` + (flag ? ` The yaw_${big}_stop_gain side has more overshoot. This does not identify a new gain.` : '') + check }); } }
        // C6, T2
        for (const [id, list] of [['C6', M.C6 ? [['roll', M.C6.roll], ['pitch', M.C6.pitch]] : []], ['T2', M.T2 ? [['yaw', M.T2]] : []]]) { const R = RULES[id];
            for (const [ax, m] of list) { const profs = Object.keys(m.byProfile); if (!profs.length) add(id, 'note', f, null, { axis: ax, n: 0, text: `No result: no ${RULE.slow.windowS} s windows with stable stick input.` });
                for (const p of profs) { const s = m.byProfile[p];
                    if (s.windows < R.minWindows || s.prominence === null) { add(id, 'note', f, p, { axis: ax, value: s.prominence, n: s.windows, text: thin(s.windows, R.minWindows, 'windows with stable input') + ` The peak is at ${fmt(s.hz)} Hz, with a prominence of ${fmt(s.prominence)}.` }); continue; }
                    const flag = s.prominence >= R.prominence;
                    add(id, flag ? 'flag' : 'ok', f, p, { axis: ax, value: s.prominence, n: s.windows, threshold: `prominence >= ${R.prominence}`, hz: s.hz,
                        text: `In the ${ax} band of 0.5-3 Hz, the peak is at ${fmt(s.hz)} Hz with an amplitude of ${fmt(s.amplitude, 1)} deg/s. Its prominence is ${fmt(s.prominence)} in ${s.windows} windows. The I-term supplies ${fmt(s.iShareOfControl * 100, 0)} % of the control at this frequency.` +
                        (flag ? (s.iShareOfControl >= 0.5 ? '\nThe label is "driven by I" because I supplies half or more of the control. This does not identify which gain is incorrect.' : '\nThe label is "not driven by I" because I supplies less than half of the control. This does not show that the I-loop is correct.') : '') }); } } }
        // C8, C9
        if (M.C8) { const R = RULES.C8; for (const [p, s] of Object.entries(M.C8.byProfile))
            add('C8', 'note', f, p, { axis: 'roll', value: s.gainSigned, n: s.windows, text: s.windows < R.minWindows ? thin(s.windows, R.minWindows, 'windows') : `The roll response to pitch stick acceleration is ${fmt(s.gain, 4)} deg/s for each deg/s^2. The value with its sign is ${fmt(s.gainSigned, 4)}. The coherence is ${fmt(s.coherence)}. The header cyclic_coupling is "${JSON.stringify(M.C8.headerCyclicCoupling)}". This is information only.` }); }
        if (M.C9) { const R = RULES.C9; if (M.C9.skipped) add('C9', 'skipped', f, null, { text: M.C9.skipped });
            else for (const [p, s] of Object.entries(M.C9.byProfile)) { const n = Math.min(s.pitchErrorPositive.n, s.pitchErrorNegative.n);
                add('C9', 'note', f, p, { axis: 'pitch', value: s.difference, se: s.differenceSe, n, text: (n < R.minBlocks ? thin(n, R.minBlocks, 'periods on one side') + '\n' : '') + `The pitch error at positive collective is ${fmt(s.pitchErrorPositive.mean)} deg/s in ${s.pitchErrorPositive.n} periods. At negative collective, it is ${fmt(s.pitchErrorNegative.mean)} deg/s in ${s.pitchErrorNegative.n} periods. The difference is ${fmt(s.difference)} ± ${fmt(s.differenceSe)} deg/s. The axisO ratio is ${fmt(s.oShare[0])} for roll and ${fmt(s.oShare[1])} for pitch. This is information only.` }); } }
        // C10
        if (M.C10) { const R = RULES.C10; if (M.C10.skipped) add('C10', 'skipped', f, null, { text: M.C10.skipped });
            else { for (const ax of ['roll', 'pitch']) for (const [p, s] of Object.entries(M.C10[ax].byProfile)) for (const b of s.bins) {
                    const lab = `${b.collectiveDeg[0]}-${b.collectiveDeg[1]} deg`;
                    if (b.spans < R.minSpans) { add('C10', 'note', f, p, { axis: ax, value: b.tauS, n: b.spans, text: thin(b.spans, R.minSpans, `stable periods of 0.1 s at ${lab}`) + ` The time constant is ${fmt(b.tauS)} s.` }); continue; }
                    if (b.tauS === null) { add('C10', 'note', f, p, { axis: ax, value: b.lambdaPerS, se: b.lambdaSe, n: b.spans, text: `No result: the ${ax} I-term decrease rate at ${lab} is ${fmt(b.lambdaPerS, 3)} ± ${fmt(b.lambdaSe, 3)} /s. This rate is not positive in ${b.spans} periods.` }); continue; }
                    const inBand = b.tauS >= R.tau[0] && b.tauS <= R.tau[1], slowExpected = b.expectedAirborneTauS === null || b.expectedAirborneTauS >= R.airborneTauMin, fast = inBand && slowExpected;
                    // With AIRBORNE_STATE events every measured sample is firmware-airborne (ok needs airborneAt), and pid.c then
                    // applies the airborne curve: a ground-rate tau cannot be misdetection. Only without the events can it be.
                    const known = M.C10.airborneStateLogged !== undefined ? M.C10.airborneStateLogged : !!(M.C10.landedWhileMoving && !M.C10.landedWhileMoving.skipped), flag = fast && !known;
                    add('C10', flag ? 'flag' : fast ? 'note' : 'ok', f, p, { axis: ax, value: b.tauS, se: b.tauSe, n: b.spans, threshold: `tau in ${R.tau.join('-')} s where airborne tau >= ${R.airborneTauMin} s`,
                        text: `The ${ax} I-term time constant at ${lab} is ${fmt(b.tauS)} ± ${fmt(b.tauSe)} s. The firmware curve gives ${fmt(b.expectedAirborneTauS, 1)} s in flight and ${fmt(b.expectedGroundTauS, 1)} s on the ground.` + (flag ? '\nThe I-term decreases at the ground rate in flight. The log has no AIRBORNE_STATE log events. The airborne condition can be incorrect.'
                            : fast ? '\nThe I-term decreases faster than the airborne curve in firmware-airborne flight. The firmware applied the airborne curve here. Examine other effects on the I-term.' : '') }); }
                const lw = M.C10.landedWhileMoving; if (lw && !lw.skipped) add('C10', lw.seconds > 0 ? 'flag' : 'ok', f, null, { value: lw.seconds, n: lw.events.length, threshold: '> 0 s', text: `The rotor is at speed with helicopter movement for ${fmt(lw.seconds, 1)} s "while the firmware says landed". The ground I-term decrease is active.` }); } }
        // C11
        if (M.C11) { const R = RULES.C11; for (const ax of ['roll', 'pitch']) { const m = M.C11[ax]; if (!m) continue;
            if (m.skipped) { add('C11', 'skipped', f, null, { axis: ax, text: m.skipped }); continue; }
            if (m.zero) { add('C11', 'ok', f, null, { axis: ax, value: 0, n: 0, dZero: true, text: `The ${ax} axisD is 0 in this log: the D gain is 0. Thus, the D-term noise is 0.` }); continue; }
            for (const [p, s] of Object.entries(m.byProfile)) { if (s.windows < R.minWindows) { add('C11', 'note', f, p, { axis: ax, value: s.share, n: s.windows, text: thin(s.windows, R.minWindows, 'windows') }); continue; }
                const flag = s.share > R.share;
                add('C11', flag ? 'flag' : 'ok', f, p, { axis: ax, value: s.share, se: s.perWindow.se, n: s.windows, threshold: `> ${R.share}`, text: `The ${ax} axisD power at more than ${RULE.dNoise.hz} Hz is ${fmt(s.share * 100, 0)} % of its total power. The mean of the window percentages is ${fmt(s.perWindow.mean * 100, 0)} ± ${fmt(s.perWindow.se * 100, 1)} %.` + (flag ? ' High-frequency D power can come from vibration. Examine the gyro spectra.' : '') }); } } }
        // T6
        if (M.T6) { const R = RULES.T6; if (M.T6.skipped) add('T6', 'skipped', f, null, { text: M.T6.skipped });
            else { const profs = Object.keys(M.T6.byProfile); if (!profs.length) add('T6', 'note', f, null, { n: 0, text: `No result: no collective step of ${RULE.kick.fraction * 100} % of the range or more with stable yaw stick input.` });
                for (const p of profs) { const s = M.T6.byProfile[p], n = s.absPeak.n;
                    if (n < R.minEvents) { add('T6', 'note', f, p, { value: s.absPeak.mean, n, text: thin(n, R.minEvents, 'collective steps') + ` The mean yaw kick without its sign is ${fmt(s.absPeak.mean, 1)} deg/s.` }); continue; }
                    const flag = s.absPeak.mean >= R.kick, dir = s.towardTorque.mean, sure = dir !== null && s.towardTorque.se !== null && Math.abs(dir) > 2 * s.towardTorque.se;
                    add('T6', flag ? 'flag' : 'ok', f, p, { value: s.absPeak.mean, se: s.absPeak.se, n, threshold: `>= ${R.kick} deg/s`, towardTorque: s.towardTorque,
                        text: `The yaw kick after ${n} collective steps is ${fmt(s.absPeak.mean, 1)} ± ${fmt(s.absPeak.se, 1)} deg/s. The value in the direction of the torque change is ${fmt(dir, 1)} ± ${fmt(s.towardTorque.se, 1)} deg/s. This direction occurs in ${fmt(s.withTorqueShare * 100, 0)} % of the steps.` +
                        (flag ? (!sure ? '\nThe direction is not the same in the steps. The check gives no precompensation direction. Examine yaw_precomp_cutoff and the pilot input.' : dir > 0 ? ' A low collective precompensation is one possible cause.' : ' A high collective precompensation is one possible cause.') : '') }); } } }
        // T7
        if (M.T7) { const R = RULES.T7; if (M.T7.skipped) add('T7', 'skipped', f, null, { text: M.T7.skipped });
            else { const profs = Object.keys(M.T7.byProfile); if (!profs.length) add('T7', 'note', f, null, { n: 0, text: 'No result: no collective movements with stable yaw stick input.' });
                for (const p of profs) { const s = M.T7.byProfile[p];
                    if (s.windows < R.minWindows) { add('T7', 'note', f, p, { value: s.r.mean, n: s.windows, text: thin(s.windows, R.minWindows, 'windows with collective movement') + ` The correlation is ${fmt(s.r.mean)}.` }); continue; }
                    const flag = Math.abs(s.r.mean) >= R.r;
                    add('T7', flag ? 'flag' : 'ok', f, p, { value: s.r.mean, se: s.r.se, n: s.windows, threshold: `|r| >= ${R.r}`, precompScale: s.precompScale,
                        text: `In collective movements, yaw I and precompensation have a correlation of ${fmt(s.r.mean)} ± ${fmt(s.r.se)}. The slope is ${fmt(s.slope)} ± ${fmt(s.slopeSe)}. The fit gives a scale estimate of ${fmt(s.precompScale)} for the recorded precompensation. The estimate does not show that this change is correct.` +
                        (flag ? (s.precompScale < 0 ? '\nThe fit can show an incorrect sign.' : s.r.mean < 0 ? '\nThe fit can show too much precompensation.' : '\nThe fit can show that precompensation is not sufficient.') : '') }); } } }
    }

    // T4 across logs: wag frequency per gain set
    { const R = RULES.T4, sets = [];
        for (const f of flights) { const m = f.metrics && f.metrics.T4; if (!m) continue;
            for (const [p, s] of Object.entries(m.byProfile)) { const g = s.gains.header || s.gains.recovered; if (!g || s.fast.bursts < R.minBursts) continue;
                // one unit on both sides: the mean of the P applied on the two stop-gain sides, base P x (cw + ccw) / 200.
                // Recovered: (Pcw + Pccw) / 2. Header: base P x the header yaw_stop_gain; without it the header P is not comparable.
                let P = null;
                if (g === s.gains.header) { const sg = g.stopGain; P = typeof g.P === 'number' && Array.isArray(sg) && sg.length === 2 ? g.P * (sg[0] + sg[1]) / 200 : null; }
                else P = typeof g.Pcw === 'number' && typeof g.Pccw === 'number' ? (g.Pcw + g.Pccw) / 2 : null;
                sets.push({ log: f.log, profile: +p, P, I: g.I, D: g.D, hz: s.fast.hz.mean, se: s.fast.hz.se, n: s.fast.bursts }); } }
        const rel = (a, b) => (a && b) ? Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) : 0;
        let pairs = 0;
        for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
            const a = sets[i], b = sets[j], dg = Math.max(rel(a.P, b.P), rel(a.I, b.I), rel(a.D, b.D)); if (dg <= R.gainChange) continue;
            pairs++; const dh = rel(a.hz, b.hz), flag = dh < R.hzChange;
            F.push({ id: 'T4', severity: flag ? 'note' : 'ok', log: a.log, profile: a.profile, value: r(dh, 3), se: null, n: a.n + b.n, threshold: `hz change < ${R.hzChange} while gains change > ${R.gainChange}`, source: R.source, other: { log: b.log, profile: b.profile },
                text: `The tail oscillation is ${fmt(a.hz)} Hz in log ${a.log}, PID profile ${a.profile}, and ${fmt(b.hz)} Hz in log ${b.log}, PID profile ${b.profile}. The mean applied P/I/D gains are ${fmt(a.P, 0)}/${fmt(a.I, 0)}/${fmt(a.D, 0)} and ${fmt(b.P, 0)}/${fmt(b.I, 0)}/${fmt(b.D, 0)}. The gain difference is ${fmt(dg * 100, 0)} %, and the frequency difference is ${fmt(dh * 100, 1)} %.` + (flag ? ' The result is "suspect mechanics": examine the mechanical parts.' : '') });
        }
        if (!pairs) F.push({ id: 'T4', severity: 'note', log: null, profile: null, value: null, se: null, n: sets.length, threshold: null, source: R.source, text: `No result: no two gain sets have ${R.minBursts} or more yaw oscillations and a gain difference of more than ${R.gainChange * 100} %. The analysis has ${sets.length} sets.` });
    }
    return F;
}

module.exports = { EXTRA, RULE, DEFAULT_RULES, analyse, judge };
