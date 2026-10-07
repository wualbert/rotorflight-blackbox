'use strict';

/**
 * Normal-flight mask, and the health checks the other modules do not make (docs/TUNING_KNOWLEDGE.md section 10; new ids):
 *
 *   normalMask   in flight and not in rescue, a level mode, failsafe or ground contact, each span widened by RULE.spanGuardS.
 *                Ground contact: out of the flight phase (liftoff to touchdown) of health_phase.cjs, the one source of the
 *                flights (SPEC2 D13); without that module, RULE.ground. The in-app engine ANDs the mask into ctx.flying for
 *                every module (then passes ctx.normal).
 *   D6   excluded spans: in-flight seconds per reason; failsafe while airborne
 *   F10  noise into the loop and servos: axisD power above 30 Hz (C11's measure; C11 does not judge yaw), mixer rms above 30 Hz;
 *        findings: yaw D share, and the mixer noise of roll and pitch (their D share is C11's finding)
 *   F11  gyro filter delay, measured: phase of gyroRAW -> gyroADC at 8-16 Hz, and the passband gain
 *   T13  hover tail I trim
 *   C14  pitch I + O against collective, and what pitch_collective_ff_gain would supply it
 *   T14  yaw at headspeed ramps, and what yaw_inertia_precomp_gain would supply (judged on that regression; the peak yaw described)
 *   G14  governor state census, spool-up, autorotation and bailout in flight
 *   curves(w, ctx, metrics)  governor, vibration, D-term, control and tail series for the UI
 *
 * Module contract as health_loop.cjs: analyse measures with the parameters in RULE, judge decides with DEFAULT_RULES.
 * Evidence for the app (index time, RULE.worst or fewer per profile): F10[axis].byProfile[p].worst, the 1 s windows of the judged
 * statistic; T13.byProfile[p].worst, the longest runs of hover windows; C14.byProfile[p].worst, the 30 s blocks with the most
 * collective power; curves vib[axis].phaseDeg, the phase of the gyro filters (F11). Finding texts are ASD-STE100
 * (docs/STE_GLOSSARY.md), a note on thin data has thin: true, and every finding has its flight phase (phase: 'flight', or
 * null for G14, which uses the governor states of all phases).
 * Units: rates deg/s; control and PID terms in permille of full authority (the logged value) where a field says permille,
 * else a fraction; collective in logged units (1000 = 12 deg); time s from log start.
 *
 * Firmware facts used (rotorflight-firmware release/4.6.0):
 *   - flightModeFlags is rcModeActivationMask, the RC box bits (blackbox.c:1108); bit order FLIGHT_LOG_FLIGHT_MODE_NAME_RF_4_6
 *     of js/flightlog_fielddefs.js (the same bits since 4.3): ANGLE 1, HORIZON 2, TRAINER 3, RESCUE 5, GPSRESCUE 6, FAILSAFE 7.
 *     Gaui X4 #58: value 33 (ARM + RESCUE) for 8.60 s in four activations, as analysis/gaui-x4/rescue/ found.
 *   - rescue blends out over rescue_exit_time after the switch drops (rescue.c:191-205), per profile 0..250 x 0.1 s
 *     (settings.c:1190), default 5 (pg/pid.c:95). RESCUE_STATE events (blackbox.c:1911-1916, lib rescueAt) cover the EXIT
 *     state as flown; without them the switch span is extended by the default.
 *   - pitch collective FF: F[pitch] += collective x pitch_collective_ff_gain / 500, both as fractions (pid.c:937-942);
 *     so I + O moving k per unit of collective is supplied by a gain change of 500 k. Range 0..250 (settings.c:1147).
 *   - inertia precomp: F[yaw] += rotSign x difFilter(PT2_20Hz((headspeed + rotSign x yaw setpoint / 6) / 3000),
 *     cutoff / 10 Hz) x gain / 200 (pid.c:893-904, 920-924). Range 0..250 (settings.c:1144). rotSign is read from the data:
 *     the sign of the median tail control in flight, the anti-torque side (health_loop.cjs rotation). T14 fits that term
 *     on the rotor speed in space (yaw gyro in place of the setpoint, rampEvents).
 *   - SPOOLUP ramps the throttle at 10 / gov_spoolup_time per second (governor.c:1603-1609), so the time is 1000 / (%/s).
 */

const lib = require('./lib.cjs');
const setup = require('./health_setup.cjs');
const { pt2 } = require('./health_gov.cjs'); // pt2Filter (filter.c)
const { AXES } = lib;

const RULE = {
    guardS: 1,                 // usable: s cut either side of profile switches and governor state changes (health_loop RULE.guardS)
    spanGuardS: 1,             // normalMask: s cut either side of each abnormal span
    blockS: 10,                // jackknife blocks of log time
    rescueExitS: 0.5,          // rescue_exit_time default (pg/pid.c:95), used only for logs without RESCUE_STATE events; CLI only, not in the header
    modeBits: { rf46: { level: [1, 2, 3], rescue: [5, 6], failsafe: [7] }, rf42: { level: [1, 2], rescue: [5, 6], failsafe: [4] } }, // fielddefs RF_4_6 (4.3 on), RF_4_2
    ground: { collective: 300, afterS: 0.5, beforeEndS: 2, fillS: 2 }, // only without health_phase.cjs, as the Gaui X4 analysis found it: take-off until |collective| > 300 (3.6 deg) + 0.5 s, the last 2 s before landing; airborne drop-outs < fillS at flight headspeed are filled
    noise: { hz: 30, windowS: 1 },                      // F10: as health_loop RULE.dNoise
    delay: { band: [8, 16], gainHz: 12, logTicks: 1,    // F11; logTicks: the gyro samples between the gyroRAW and the gyroADC of one frame, which are not filter delay
        logSource: 'firmware 4.6.0 core.c, blackbox gyroRAW timing: the log writes gyroRAW 1 gyro sample after the filter input (measured by the parity of filter_tune.cjs)' },
    hover: { yaw: 10, cyclic: 20, collSwing: 0.03, collAbove: 150, windowS: 1, authority: 1.25 }, // T13; collSwing as share of collectiveRange; collAbove: logged collective units (1.8 deg) a window may sit above the median |collective| of the log's hover windows (a climb or punch-out is not a hover); authority: mixer input clamp +-1250 default (pg/mixer.c:49-55) when no limit is detected
    pitch: { quiet: 30, hpHz: 0.2, slow: [0.03, 0.3], slowBlockS: 30, joinS: 0.5, step: 250, withinS: 0.3, preS: 0.3, postS: 1, errS: 0.5, gapS: 2 }, // C14; steps as analysis/gaui-x4/cyclic/coupling.py; joinS: the level means where usable runs are joined before the band-pass
    ramp: { rate: 200, minS: 0.3, halfS: 0.15, minTarget: 100, maxCollDeg: 3, quiet: 50, preS: 1, postGapS: 0.3, postS: 1, baseS: 0.5, afterS: 0.3, fitS: [0.5, 1], gainMax: 250 }, // T14: |d(headspeed)/dt| over a 2 halfS central difference; maxCollDeg: change of the mean |collective| from before the ramp to while the peak is read; quiet: max |yaw setpoint| then (deg/s); gainMax: yaw_inertia_precomp_gain range 0..250 (settings.c:1144)
    limit: { samples: 20, band: 0.02, tol: 0.0015 },    // tail output limit as health_loop RULE.limitSamples, limitBand, limitTol
    binS: 0.1,                                          // curves time step
    vibMinWindows: 3,                                   // curves vib.byProfile: fewest 1 s windows for a profile's spectrum
    maxEvents: 200,
    worst: 3,                                           // F10, T13, C14: windows, runs or blocks kept per profile as evidence
};

const EXTRA = ['flightModeFlags', 'failsafePhase', 'mixer[3]', 'axisO[0]', 'axisO[1]', 'gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]', 'govTarget', 'govSum', 'govI', 'motor[0]'];

// the sources are shown to the pilot (quoted, review V3): no file name. C14 pitch FF: pid.c:937-942; T14 inertia: pid.c:893-904;
// G14 states: governor.c:1090-1240
const P = 'pipeline, unvalidated';
const DEFAULT_RULES = {
    sig: 2,                    // a flag with an SE must pass its threshold by this many SE
    D6: { source: `${P}; report only, except failsafe while airborne` },
    F10: { share: 0.5, minWindows: 10, minBlocks: 3, source: `${P}; the rule of check C11, for the yaw axis` },   // health_loop C11
    F11: { flagMs: 10, minWindows: 10, minBlocks: 3, source: P },
    T13: { share: 0.15, minBlocks: 3, nearLimit: 0.8, source: `${P}; doc MIXS: a constant hover I means tail centre or zero-pitch trim, not gain`, note: 'nearLimit: hover mixer[2] at this share of the authority is called near the tail limit, not normal' },
    C14: { flag: 20, minGainChange: 10, minBlocks: 8, source: `${P}; gain change from the formula of the firmware`, note: 'flag in pitch I + O per 1000 collective (20 = 10 gain units); minBlocks of RULE.pitch.slowBlockS (30 s): a jackknife over fewer long blocks is not trusted' },
    T14: { minEvents: 3, consistent: 0.8, minGainChange: 15, relGainChange: 0.15, source: `${P}; gain from the formula of the firmware`,
        note: 'judged on the regression gain change, not on the peak yaw: the precomp lags the torque (PT2 20 Hz, difFilter 2.5 Hz), so in simulated loops (a rate plant and the Gaui integrator plant, test/health_more.test.cjs) the peak stayed at 8-32 deg/s for every gain from 0 to 250 and changed sign at 50-90 % of the matching gain. minGainChange, relGainChange: there the regression read -1 to +14 % off at gain 0 and 5-13 units high at the matching gain, so a change must pass max(15, 0.15 x header gain) by 2 SE; on a wagging tail without inertia torque (1-8 Hz, peak about 26 deg/s) it flagged 0 of 300 logs, the peak rule 11 %. consistent: share of the per-event fits of the pooled sign' },
    G14: { hover: 300, autoS: 0.5, source: `${P}; the governor states of the firmware`, note: 'landing autorotations (in the landing ground-contact span) do not count' },
};
const UNITS = { D6: 's', F10: 'fraction', F11: 'ms', T13: 'fraction', C14: 'per 1000 collective', T14: 'gain units', G14: 'entries' }, IDS = Object.keys(UNITS);
const AXIS = { T13: 'yaw', C14: 'pitch', T14: 'yaw' }; // the one axis of these checks, as a field (code never reads it from the text)
// the flight phase of each check (SPEC2 D13 correction): the flight only, but G14 (the governor states of all phases: null)
const PHASE_OF = { D6: 'flight', F10: 'flight', F11: 'flight', T13: 'flight', C14: 'flight', T14: 'flight', G14: null };
const STATES = setup.GOV_STATES;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (x, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += x[i]; return s / Math.max(1, i1 - i0); };
const median = (list) => { const s = Float64Array.from(list).sort(); return s.length ? s[s.length >> 1] : null; }; // a typed array sorts numerically
function stat(v) { // mean, standard error across items, n
    const x = v.filter(q => typeof q === 'number' && isFinite(q)), n = x.length;
    if (!n) return { mean: null, se: null, n: 0 };
    const m = sum(x) / n, sd = n > 1 ? Math.sqrt(sum(x.map(q => (q - m) ** 2)) / (n - 1)) : null;
    return { mean: r(m, 4), se: sd === null ? null : r(sd / Math.sqrt(n), 4), n };
}
// leave-one-out jackknife of fn over summed accumulators: parts = [[a, b, ...] or nested arrays, ...]
function jackknife(parts, fn) {
    const add = (a, b, k) => Array.isArray(a) ? a.map((v, j) => add(v, b[j], k)) : a + k * b;
    const k = parts.length; if (!k) return { value: null, se: null, n: 0 };
    const tot = parts.slice(1).reduce((t, p) => add(t, p, 1), parts[0]), value = fn(tot);
    if (k < 3) return { value, se: null, n: k };
    const loo = parts.map(p => fn(add(tot, p, -1))).filter(v => typeof v === 'number' && isFinite(v)), m = sum(loo) / loo.length;
    return { value, se: loo.length === k ? Math.sqrt((k - 1) / k * sum(loo.map(v => (v - m) ** 2))) : null, n: k };
}
function runs(n, pred) { // contiguous runs [s, e) where pred holds
    const out = []; let s = -1;
    for (let i = 0; i <= n; i++) { const on = i < n && pred(i); if (on && s < 0) s = i; else if (!on && s >= 0) { out.push([s, i]); s = -1; } }
    return out;
}
const cap = (ev) => ev.slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, RULE.maxEvents); // largest first
const arr = (v) => Array.isArray(v) ? v : v === null || v === undefined ? null : [v];
const series = (v) => v.length > 1 ? `${v.slice(0, -1).join(', ')} and ${v[v.length - 1]}` : v.join(''); // "a, b and c"
const many = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;                                    // "1 window", "2 windows"

// usable for loop-type checks: in flight, governor ACTIVE when logged, away from profile switches and state changes (health_loop.cjs)
function usableMask(w, ctx, rate) {
    const n = w.n, ok = new Uint8Array(n), g = Math.max(1, Math.round(RULE.guardS * rate)), prof = ctx.profile, gov = ctx.govState;
    for (let i = 0; i < n; i++) ok[i] = ctx.flying[i] && (!gov || gov[i] === 4) ? 1 : 0;
    for (let i = 1; i < n; i++) if (prof[i] !== prof[i - 1] || (gov && gov[i] !== gov[i - 1])) ok.fill(0, Math.max(0, i - g), Math.min(n, i + g));
    return ok;
}

// in-flight samples before the normal mask. With ctx.normal the engine has ANDed the mask into ctx.flying and keeps the
// health.cjs mask as ctx.flyingAll; without flyingAll the health.cjs gate (airborne, headspeed >= ctx.flightRule.headspeed)
// is applied again to recover what was excluded
function rawFlying(w, ctx) {
    if (ctx.flyingAll) return ctx.flyingAll;
    if (!ctx.normal) return ctx.flying;
    const hs = (ctx.flightRule || { headspeed: lib.FLIGHT_RPM }).headspeed, f = new Uint8Array(w.n);
    for (let i = 0; i < w.n; i++) f[i] = ctx.flying[i] || (w.airborneAt[i] && w.hs[i] >= hs) ? 1 : 0;
    return f;
}

// output limit of a control column (health_loop.cjs limitOf): an extreme reached at least RULE.limit.samples times in usable
// flight, and at least as often as the values within RULE.limit.band inside it (a clamp piles samples up at one value)
function limitOf(v, ok) {
    const L = RULE.limit; let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < v.length; i++) if (ok[i]) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
    if (!isFinite(lo)) return null;
    let atLo = 0, atHi = 0, nearLo = 0, nearHi = 0;
    for (let i = 0; i < v.length; i++) if (ok[i]) { const x = v[i];
        if (x <= lo + L.tol) atLo++; else if (x <= lo + L.band) nearLo++;
        if (x >= hi - L.tol) atHi++; else if (x >= hi - L.band) nearHi++; }
    return { lo: atLo >= L.samples && atLo >= nearLo ? lo : null, hi: atHi >= L.samples && atHi >= nearHi ? hi : null, min: lo, max: hi };
}

// T13: one-sided yaw authority in permille on side 'lo' (I < 0) or 'hi', from m = { limit, observed, cliLimit } (permille).
// In order: the clamp detected in this log; the clamp detected in other logs of the file (pool.det) when those detections
// agree within RULE.limit.tol and no log logged beyond it; the CLI mixer input SY limit when no log logged beyond it and no
// detected clamp disagrees; else RULE.hover.authority, assumed, but never less than this log's own extreme on that side.
// pool: { det: [detected clamps of the file], obs: [logged extremes of the file], cli } (judge), else this log alone
function authority(m, side, pool) {
    const tol = RULE.limit.tol * 1000, sg = side === 'lo' ? -1 : 1, num = (v) => typeof v === 'number' && isFinite(v);
    const own = m.limit ? m.limit[side] : null, obs = m.observed ? m.observed[side] : null, dflt = RULE.hover.authority * 1000;
    if (num(own)) return { value: sg * own, source: 'log', text: 'the output limit in this log' };
    const P = pool || { det: [], obs: num(obs) ? [obs] : [], cli: m.cliLimit ? m.cliLimit[side] : null }, beyond = (v) => P.obs.some(o => sg * o > sg * v + tol);
    if (P.det.length && Math.max(...P.det) - Math.min(...P.det) <= tol && !beyond(median(P.det))) return { value: sg * median(P.det), source: 'file', text: `the output limit in ${P.det.length} other log${P.det.length > 1 ? 's' : ''} of this file` };
    const cliOk = num(P.cli) && sg * P.cli > 0 && !beyond(P.cli) && P.det.every(d => Math.abs(d - P.cli) <= tol);
    if (cliOk) return { value: sg * P.cli, source: 'cli', text: 'the limit of the SY mixer input in the CLI dump' };
    const seen = num(obs) ? sg * obs : 0, why = `no log shows an output limit, and ${num(P.cli) ? `the CLI SY limit (${P.cli}) does not agree with the logs` : 'the log does not record the SY limits'}`; // the log only: no word that asks for a CLI dump
    return seen > dflt ? { value: seen, source: 'observed', text: `the largest value in this log, because ${why}` } : { value: dflt, source: 'assumed', text: `the default limit of the mixer input, because ${why}` };
}

// Welch sums over the windows of N samples (Hann, mean removed, hop N/2) lying wholly inside mask: |X|^2 per bin of every
// column, the cross-spectrum conj(Xa) Xb of every pair [a, b], per block of log time the same sums at the bins `keep`, and
// with group(s) (a key for the window starting at s, or null) the same full sums per key
function welch(app, cols, pairs, mask, N, blockN, keep, group) {
    const n = mask.length, K = N / 2 + 1, { fft, win } = lib.fftFor(app, N), buf = new Float64Array(N), X = cols.map(() => new Float64Array(2 * N));
    const cum = new Int32Array(n + 1); for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + (mask[i] ? 1 : 0);
    const sums = () => ({ windows: 0, pw: cols.map(() => new Float64Array(K)), re: pairs.map(() => new Float64Array(K)), im: pairs.map(() => new Float64Array(K)) });
    const { pw, re, im } = sums(), blocks = new Map(), groups = new Map();
    let windows = 0;
    for (let s = 0; s + N <= n; s += N / 2) {
        if (cum[s + N] - cum[s] < N) continue;
        const gk = group ? group(s) : null; let G = null;
        if (gk !== null && gk !== undefined) { G = groups.get(gk); if (!G) groups.set(gk, G = sums()); G.windows++; }
        for (let c = 0; c < cols.length; c++) { const x = cols[c]; let m = 0; for (let i = 0; i < N; i++) m += x[s + i]; m /= N;
            for (let i = 0; i < N; i++) buf[i] = (x[s + i] - m) * win[i]; fft.simple(X[c], buf, 'real');
            const Y = X[c], Q = pw[c], GQ = G && G.pw[c]; for (let k = 0; k < K; k++) { const v = Y[2 * k] ** 2 + Y[2 * k + 1] ** 2; Q[k] += v; if (GQ) GQ[k] += v; } }
        for (let j = 0; j < pairs.length; j++) { const A = X[pairs[j][0]], B = X[pairs[j][1]], R = re[j], I = im[j], GR = G && G.re[j], GI = G && G.im[j];
            for (let k = 0; k < K; k++) { const a = A[2 * k] * B[2 * k] + A[2 * k + 1] * B[2 * k + 1], b = A[2 * k] * B[2 * k + 1] - A[2 * k + 1] * B[2 * k]; R[k] += a; I[k] += b; if (GR) { GR[k] += a; GI[k] += b; } } }
        if (keep) { const b = Math.floor(s / blockN); let o = blocks.get(b);
            if (!o) blocks.set(b, o = { windows: 0, sums: pairs.map(() => keep.map(() => [0, 0, 0, 0])) });
            o.windows++;
            pairs.forEach(([a, c], j) => keep.forEach((k, q) => { const A = X[a], B = X[c], v = o.sums[j][q];
                v[0] += A[2 * k] * B[2 * k] + A[2 * k + 1] * B[2 * k + 1]; v[1] += A[2 * k] * B[2 * k + 1] - A[2 * k + 1] * B[2 * k];
                v[2] += A[2 * k] ** 2 + A[2 * k + 1] ** 2; v[3] += B[2 * k] ** 2 + B[2 * k + 1] ** 2; })); }
        windows++;
    }
    return { N, K, windows, pw, re, im, blocks: [...blocks.values()], groups };
}
const fftSize = (rate) => 2 ** Math.round(Math.log2(rate)); // about 1 s, a power of two for the FFT
// phase in degrees of a cross-spectrum conj(Xa) Xb (welch re, im), unwrapped from the first bin up: -360 f tau for b = a delayed by
// tau. NaN at 0 Hz and where a has no power (rr = |Xa|^2)
function phaseDeg(re, im, rr) {
    const o = new Float32Array(re.length).fill(NaN); let prev = null;
    for (let k = 1; k < re.length; k++) { if (!(rr[k] > 0)) continue; let p = Math.atan2(im[k], re[k]);
        if (prev !== null) { while (p - prev > Math.PI) p -= 2 * Math.PI; while (p - prev < -Math.PI) p += 2 * Math.PI; } prev = p; o[k] = p * 180 / Math.PI; }
    return o;
}

// the pilot's CLI dump, parsed (health_setup parseCli): ctx.cliParsed, else ctx.cli (text) parsed; null without one
function cliOf(ctx) {
    if (ctx.cliParsed) return ctx.cliParsed;
    const text = ctx.cli && (typeof ctx.cli === 'string' ? ctx.cli : ctx.cli.text); if (!text) return null;
    if (!cliOf.last || cliOf.last.text !== text) cliOf.last = { text, cli: setup.parseCli(text) }; // the same dump for every log of a run
    return cliOf.last.cli;
}

// gear ratios for the tail notch orders: ctx.gear, else the CLI (as health_setup.cjs gearOf, which it does not export)
function gearOf(ctx) {
    if (ctx.gear) return ctx.gear;
    const cli = cliOf(ctx); if (!cli) return null;
    const g = cli.global, dflt = cli.kind === 'diff' ? [1, 1] : null;
    const mode = g.tail_rotor_mode === undefined || g.tail_rotor_mode === null ? 'VARIABLE' : String(g.tail_rotor_mode).trim().toUpperCase();
    return { main: arr(g.main_rotor_gear_ratio) || dflt, tail: arr(g.tail_rotor_gear_ratio) || dflt, motorisedTail: mode !== 'VARIABLE' && mode !== '0' };
}

// ---------------------------------------------------------------------------------------------
// Abnormal spans and the normal mask
// ---------------------------------------------------------------------------------------------

// RC box bits of the logged flightModeFlags for this firmware: 4.2 has its own order, 4.3 and later the 4.6 one
function modeBits(h) {
    const v = String((h && h.firmwareVersion) || '').split('.').map(Number);
    return v.length >= 2 && v[0] === 4 && v[1] < 3 ? RULE.modeBits.rf42 : RULE.modeBits.rf46;
}

// raw abnormal spans (Uint8Array each), not widened, and what could not be applied
function spans(w, ctx) {
    const n = w.n, rate = ctx.rate || w.rate, X = w.extra || {}, H = ctx.header || (w.flight && w.flight.header) || {}, S = (s) => Math.max(1, Math.round(s * rate));
    const out = { rescue: new Uint8Array(n), levelMode: new Uint8Array(n), failsafe: new Uint8Array(n), ground: new Uint8Array(n), notes: [], rescueActivations: 0 };
    const fm = X.flightModeFlags, fp = X.failsafePhase, B = modeBits(H), bits = (list) => list.reduce((m, b) => m | (1 << b), 0);
    if (fm) {
        const mr = bits(B.rescue), ml = bits(B.level), mf = bits(B.failsafe);
        for (let i = 0; i < n; i++) { const v = fm[i]; if (v & mr) out.rescue[i] = 1; if (v & ml) out.levelMode[i] = 1; if (v & mf) out.failsafe[i] = 1; }
        const on = runs(n, i => fm[i] & mr); out.rescueActivations = on.length;
        for (const [, e] of on) out.rescue.fill(1, e, Math.min(n, e + S(RULE.rescueExitS))); // EXIT blend after the switch drops, default rescue_exit_time
    }
    // the firmware's own state (lib rescueAt: RESCUE_STATE != 0, EXIT of any rescue_exit_time included), joined to the switch
    // span: rescueAt is all zero both when the firmware did not log RESCUE_STATE and when rescue did not run, so the switch
    // span stays as the fallback
    const fw = w.rescueAt; let fromState = false;
    if (fw) for (let i = 0; i < n; i++) if (fw[i]) { out.rescue[i] = 1; fromState = true; }
    if (!fm && fromState) out.rescueActivations = runs(n, i => fw[i]).length;
    out.rescueSource = fromState ? `The analysis finds rescue from the RESCUE_STATE log events${fm ? ' and the RESCUE switch' : ''}.`
        : fm ? `The analysis finds rescue from the RESCUE switch, and adds ${RULE.rescueExitS} s for the exit (RULE.rescueExitS), because the log does not record RESCUE_STATE.`
        : fw ? 'The log records RESCUE_STATE, but rescue did not operate in this log.' : null;
    if (!fm) out.notes.push(fw ? 'The log does not have flightModeFlags. Thus, the analysis cannot remove the periods with a level mode or with the failsafe switch on. It finds rescue only from the RESCUE_STATE log events.'
        : 'The log does not have flightModeFlags. Thus, the analysis cannot remove the periods with rescue, a level mode or the failsafe switch on.');
    if (fp) { for (let i = 0; i < n; i++) if (fp[i]) out.failsafe[i] = 1; }
    else out.notes.push('The log does not have failsafePhase. Thus, only the failsafe switch shows failsafe.');

    // ground contact: the samples out of the flight phase of health_phase.cjs (liftoff to touchdown, SPEC2 D13: the one source
    // of the flights; ctx.phases when the engine has it). Without that module, the rule it replaces: around each take-off and
    // landing the firmware reports (AIRBORNE_STATE), drop-outs at flight headspeed filled
    const air = w.airborneAt, coll = X['mixer[3]'] || w.coll, G = RULE.ground, hsMin = (ctx.flightRule || { headspeed: lib.FLIGHT_RPM }).headspeed, ph = phaseOf(w, ctx);
    out.hasAirborne = !!air && air.some(v => !v);
    out.groundSource = ph ? 'phases' : 'airborne';
    if (ph) { for (let i = 0; i < n; i++) if (ph.code[i] !== FLIGHT_PHASE) out.ground[i] = 1; }
    else if (!out.hasAirborne) out.notes.push('The log does not record AIRBORNE_STATE. Thus, the analysis cannot remove ground contact.');
    else {
        const A = Uint8Array.from(air);
        for (const [s, e] of runs(n, i => !A[i])) { let low = false; for (let i = s; i < e && !low; i++) low = w.hs[i] < hsMin;
            if (s > 0 && e < n && e - s < S(G.fillS) && !low) A.fill(1, s, e); }
        if (!coll) out.notes.push('The log does not have the collective. Thus, the analysis removes ground contact only before landings, not after take-off.');
        for (const [s, e] of runs(n, i => A[i])) {
            if (s > 0 && coll) { let j = s; while (j < e && Math.abs(coll[j]) <= G.collective) j++; out.ground.fill(1, s, Math.min(e, j + S(G.afterS))); }
            if (e < n) out.ground.fill(1, Math.max(s, e - S(G.beforeEndS)), e);
        }
    }
    return out;
}

const REASONS = ['failsafe', 'rescue', 'levelMode', 'ground']; // attribution order of an excluded sample
const FLIGHT_PHASE = 3; // health_phase PHASES.indexOf('flight')
// the phases of w: ctx.phases (the engine runs health_phase.cjs first), else health_phase.cjs here, loaded on first use;
// null without that module or with ctx.phases false (then the ground-contact rule of RULE.ground)
let PHASE;
function phaseOf(w, ctx) {
    if (ctx.phases === false) return null;
    if (ctx.phases && ctx.phases.code) return ctx.phases;
    if (PHASE === undefined) { try { PHASE = require('./health_phase.cjs'); } catch (e) { PHASE = null; } }
    return PHASE ? PHASE.phases(w, ctx) : null;
}

/**
 * mask = ctx.flying and none of rescue (RESCUE_STATE events and the switch, the switch plus RULE.rescueExitS without
 * events), level mode, failsafe, ground contact, each widened by RULE.spanGuardS. excluded: in-flight seconds removed per
 * reason (a sample counts once, in REASONS order; guardS = removed only by the widening).
 */
function normalMask(w, ctx, sp = spans(w, ctx)) {
    const n = w.n, rate = ctx.rate || w.rate, g = Math.round(RULE.spanGuardS * rate), bad = new Uint8Array(n), mask = new Uint8Array(n), count = { guard: 0 };
    for (const k of REASONS) { count[k] = 0; for (const [s, e] of runs(n, i => sp[k][i])) bad.fill(1, Math.max(0, s - g), Math.min(n, e + g)); }
    for (let i = 0; i < n; i++) { if (!ctx.flying[i]) continue; if (!bad[i]) { mask[i] = 1; continue; }
        const why = REASONS.find(k => sp[k][i]); count[why || 'guard']++; }
    const excluded = { rescueS: r(count.rescue / rate, 2), levelModeS: r(count.levelMode / rate, 2), failsafeS: r(count.failsafe / rate, 2), groundS: r(count.ground / rate, 2), guardS: r(count.guard / rate, 2) };
    return { mask, excluded, notes: sp.notes, rescueSource: sp.rescueSource, groundSource: sp.groundSource };
}

// ---------------------------------------------------------------------------------------------
// analyse
// ---------------------------------------------------------------------------------------------

function analyse(w, ctx) {
    const n = w.n, rate = ctx.rate || w.rate, H = ctx.header || (w.flight && w.flight.header) || {}, X = w.extra || {};
    const prof = ctx.profile, gov = ctx.govState, t = (i) => r(w.fromS + i / rate, 3), S = (s) => Math.max(1, Math.round(s * rate));
    const out = { module: 'health_more', rule: RULE, rate: r(rate, 2), fromS: r(w.fromS, 3), seconds: r(n / rate, 1), notes: [] };
    const base = rawFlying(w, ctx), sp = spans(w, ctx); let baseN = 0; for (let i = 0; i < n; i++) baseN += base[i];
    if (!baseN) { out.skipped = 'The log has no samples in flight.'; return out; }
    const coll = X['mixer[3]'] || w.coll, blockN = S(RULE.blockS);

    // --- D6: excluded spans
    {
        const nm = normalMask(w, Object.assign({}, ctx, { flying: base }), sp), air = sp.hasAirborne ? w.airborneAt : base, ev = [];
        let fsAir = 0; for (let i = 0; i < n; i++) if (sp.failsafe[i] && air[i]) fsAir++;
        for (const k of REASONS) for (const [s, e] of runs(n, i => sp[k][i])) { let fl = 0; for (let i = s; i < e; i++) fl += base[i];
            if (fl) ev.push({ t: t(s), seconds: r((e - s) / rate, 3), value: r(fl / rate, 3), reason: k }); }
        let normN = 0; for (let i = 0; i < n; i++) normN += nm.mask[i];
        out.D6 = { flyingS: r(baseN / rate, 1), normalS: r(normN / rate, 1), excluded: nm.excluded, rescueActivations: sp.rescueActivations, failsafeAirborneS: r(fsAir / rate, 3),
            applied: !!ctx.normal, notes: nm.notes, rescueSource: sp.rescueSource, groundSource: sp.groundSource, events: cap(ev),
            definition: 'in-flight seconds removed per reason (a sample counts once: failsafe, rescue, level mode, ground contact); guard = removed only by the RULE.spanGuardS widening. Rescue = the RESCUE switch, or RESCUE_STATE != 0 when logged (the exit blend of any rescue_exit_time), else the switch plus RULE.rescueExitS. Ground contact (groundSource phases) = out of the flight phase of health_phase.cjs, else (airborne) RULE.ground around the AIRBORNE_STATE runs' };
    }

    // --- G14: governor states
    out.G14 = governorCensus(w, ctx, sp, base, coll, rate, t);

    const ok = usableMask(w, ctx, rate); let usableN = 0; for (let i = 0; i < n; i++) usableN += ok[i];
    out.usableS = r(usableN / rate, 1);
    if (!gov) out.notes.push('The log does not record GOVSTATE. Thus, the analysis uses all samples in flight, not only the samples with the governor ACTIVE.');

    // --- F10: axisD above 30 Hz (share, as C11) and mixer above 30 Hz (rms permille), per axis and profile, block jackknife
    {
        const R = RULE.noise, N = S(R.windowS), res = {};
        if (R.hz >= 0.45 * rate) out.F10 = { skipped: `The log rate (${r(rate, 0)} Hz) is too low for the check at ${R.hz} Hz.` };
        else {
            for (let a = 0; a < 3; a++) {
                const D = w.D[a], hasD = !!D && D.some(v => v !== 0), hpD = hasD ? lib.bandpass(D, R.hz, 0.45 * rate, rate) : null, hpU = lib.bandpass(w.u[a], R.hz, 0.45 * rate, rate), acc = {};
                for (let s = 0; s + N <= n; s += N) {
                    let all = true; for (let i = s; i < s + N && all; i++) all = ok[i] && prof[i] === prof[s];
                    if (!all) continue;
                    let tot = 0, hi = 0, uu = 0; const m = hasD ? mean(D, s, s + N) : 0;
                    for (let i = s; i < s + N; i++) { if (hasD) { tot += (D[i] - m) ** 2; hi += hpD[i] ** 2; } uu += hpU[i] ** 2; }
                    const A = acc[prof[s]] = acc[prof[s]] || { windows: 0, blocks: new Map(), list: [] }, b = Math.floor(s / blockN), q = A.blocks.get(b) || [0, 0, 0, 0];
                    q[0] += hi; q[1] += tot; q[2] += uu; q[3] += N; A.blocks.set(b, q); A.windows++;
                    A.list.push({ t0: t(s), t1: t(s + N), share: hasD && tot > 0 ? r(hi / tot, 4) : null, controlPermille: r(1000 * Math.sqrt(uu / N), 3) });
                }
                const byProfile = {};
                for (const p in acc) { const parts = [...acc[p].blocks.values()], sh = hasD ? jackknife(parts, (v) => v[1] > 0 ? v[0] / v[1] : null) : null, cn = jackknife(parts, (v) => 1000 * Math.sqrt(v[2] / v[3]));
                    // worst: the windows of the judged statistic, the yaw D share (roll and pitch: the mixer noise, their D share is C11's)
                    const key = a === 2 && hasD ? 'share' : 'controlPermille', worst = acc[p].list.sort((x, y) => y[key] - x[key]).slice(0, RULE.worst).map(q => Object.assign(q, { value: q[key] }));
                    byProfile[p] = { windows: acc[p].windows, blocks: parts.length, share: sh ? r(sh.value, 4) : null, shareSe: sh ? r(sh.se, 4) : null, controlPermille: r(cn.value, 3), controlSe: r(cn.se, 3), worst }; }
                res[AXES[a]] = { dLogged: hasD, byProfile };
            }
            out.F10 = Object.assign(res, { hz: R.hz, windowS: R.windowS, definition: 'share = axisD power above hz / total over the windows (health_loop C11); control = rms of mixer band-passed hz..0.45 x rate, permille of full authority; SE leave-one-block-out' });
        }
    }

    // --- F11: gyro filter delay gyroRAW -> gyroADC
    const raw = [0, 1, 2].map(a => X[`gyroRAW[${a}]`] || null);
    if (!raw.every(Boolean)) out.F11 = { skipped: 'The log does not have gyroRAW.' };
    else {
        const N = fftSize(rate), df = rate / N, B = RULE.delay, keep = [];
        for (let k = Math.ceil(B.band[0] / df); k <= Math.floor(B.band[1] / df); k++) keep.push(k);
        const g12 = keep.reduce((b, k) => Math.abs(k * df - B.gainHz) < Math.abs(b * df - B.gainHz) ? k : b, keep[0]), gq = keep.indexOf(g12);
        const Wl = welch(appOf(ctx), [raw[0], w.gyro[0], raw[1], w.gyro[1], raw[2], w.gyro[2]], [[0, 1], [2, 3], [4, 5]], ctx.flying, N, blockN, keep);
        // the logging offset (RULE.delay.logTicks gyro samples, the gyro sample time is the header looptime in us): measured - offset is the filter delay
        const tickMs = typeof H.looptime === 'number' && H.looptime > 0 ? H.looptime / 1000 : null, offsetMs = tickMs === null ? 0 : B.logTicks * tickMs;
        const res = { band: B.band, hz: keep.map(k => r(k * df, 2)), windows: Wl.windows, blocks: Wl.blocks.length, windowS: r(N / rate, 3), logOffsetMs: r(offsetMs, 3), gyroTickMs: r(tickMs, 4), logOffsetSource: tickMs === null ? 'no looptime in the log header: no offset' : B.logSource };
        const delayMs = (v) => { let s = 0, c = 0; v.forEach((q, j) => { const coh = (q[0] ** 2 + q[1] ** 2) / (q[2] * q[3] || 1e-300); s += coh * -Math.atan2(q[1], q[0]) / (2 * Math.PI * keep[j] * df); c += coh; }); return c ? 1000 * s / c : null; };
        for (let a = 0; a < 3; a++) {
            const parts = Wl.blocks.map(b => b.sums[a]), d = jackknife(parts, delayMs), g = jackknife(parts, (v) => Math.hypot(v[gq][0], v[gq][1]) / (v[gq][2] || 1e-300));
            const tot = parts.length ? parts.slice(1).reduce((t, p) => t.map((q, j) => q.map((x, k) => x + p[j][k])), parts[0]) : null;
            res[AXES[a]] = { delayMs: r(d.value === null ? null : d.value - offsetMs, 3), measuredMs: r(d.value, 3), delaySe: r(d.se, 3), gain12: r(g.value, 4), gainSe: r(g.se, 4), coherence: tot ? r(stat(tot.map(q => (q[0] ** 2 + q[1] ** 2) / (q[2] * q[3] || 1e-300))).mean, 4) : null };
        }
        out.F11 = Object.assign(res, { definition: 'delay = -phase / (2 pi f) of the gyroRAW -> gyroADC cross-spectrum, coherence-weighted over the band, less the logging offset (logTicks gyro samples); gain = |S_rf| / S_rr at the bin nearest gainHz; in-flight windows of about 1 s; SE leave-one-block-out' });
    }

    // --- T13: hover tail I trim, per profile
    const limY = limitOf(w.u[2], ok);
    {
        const R = RULE.hover, N = S(R.windowS), cr = arr(H.collectiveRange), range = cr && cr.length === 2 && cr[1] > cr[0] ? cr[1] - cr[0] : 2500, acc = {}, cand = [];
        // the tail limits of this log (permille): detected clamp, logged extremes over the whole segment, the CLI's SY input
        let uLo = Infinity, uHi = -Infinity; for (let i = 0; i < n; i++) { const u = w.u[2][i]; if (u < uLo) uLo = u; if (u > uHi) uHi = u; }
        const cli = cliOf(ctx), sy = cli && cli.mixerInputs && cli.mixerInputs.SY;
        const lim = { limit: limY && { lo: r(limY.lo === null ? null : limY.lo * 1000, 1), hi: r(limY.hi === null ? null : limY.hi * 1000, 1) }, observed: { lo: r(uLo * 1000, 1), hi: r(uHi * 1000, 1) },
            cliLimit: sy ? { lo: sy[0], hi: sy[1] } : null };
        // a window touching the tail limit is not a trim (the integrator winds up there): the authority on each side
        const aLo = authority(lim, 'lo').value / 1000, aHi = authority(lim, 'hi').value / 1000, tol = RULE.limit.tol;
        let atLimit = 0, climb = 0;
        for (let s = 0; s + N <= n; s += N) {
            let all = true, lo = Infinity, hi = -Infinity, cAbs = 0, sat = false;
            for (let i = s; i < s + N && all; i++) { all = ok[i] && prof[i] === prof[s] && Math.abs(w.sp[2][i]) < R.yaw && Math.abs(w.sp[0][i]) < R.cyclic && Math.abs(w.sp[1][i]) < R.cyclic;
                if (coll) { if (coll[i] < lo) lo = coll[i]; if (coll[i] > hi) hi = coll[i]; cAbs += Math.abs(coll[i]); }
                if (w.u[2][i] <= -aLo + tol || w.u[2][i] >= aHi - tol) sat = true; }
            if (!all || (coll && hi - lo >= R.collSwing * range)) continue;
            if (sat) { atLimit++; continue; }
            cand.push({ s, c: coll ? cAbs / N : null });
        }
        // a steady climb or punch-out passes the swing test: |collective| more than collAbove above the median of the log's
        // candidate windows (all profiles: a profile may hold only the climb) is not a hover
        const cMed = coll ? median(cand.map(q => q.c)) : null;
        for (const { s, c } of cand) {
            if (cMed !== null && c > cMed + R.collAbove) { climb++; continue; }
            const A = acc[prof[s]] = acc[prof[s]] || { windows: 0, blocks: new Map(), runs: [] }, b = Math.floor(s / blockN), q = A.blocks.get(b) || { I: [], u: [] };
            for (let i = s; i < s + N; i++) { q.I.push(w.I[2][i] * 1000); q.u.push(w.u[2][i] * 1000); }
            A.blocks.set(b, q); A.windows++;
            const last = A.runs[A.runs.length - 1]; if (last && last.e === s) last.e = s + N; else A.runs.push({ s, e: s + N }); // runs of adjacent hover windows
        }
        const byProfile = {};
        for (const p in acc) {
            const bl = [...acc[p].blocks.values()], all = (k) => bl.flatMap(q => q[k]), mI = median(all('I')), mU = median(all('u'));
            // SE of a median from block medians, as health_gov G2
            const se = (k) => { const v = bl.map(q => median(q[k])); if (v.length < 2) return null; const m = sum(v) / v.length; return 1.2533 * Math.sqrt(sum(v.map(x => (x - m) ** 2)) / (v.length - 1)) / Math.sqrt(v.length); };
            const A = authority(lim, mI < 0 ? 'lo' : 'hi'), sI = se('I');
            // worst: the longest runs of hover windows, with their median axisI[2] in permille
            const worst = acc[p].runs.sort((x, y) => (y.e - y.s) - (x.e - x.s)).slice(0, RULE.worst).map(q => ({ t0: t(q.s), t1: t(q.e), windows: (q.e - q.s) / N, value: r(1000 * median(w.I[2].slice(q.s, q.e)), 1) }));
            byProfile[p] = { windows: acc[p].windows, seconds: r(acc[p].windows * R.windowS, 1), blocks: bl.length, iPermille: r(mI, 1), iSe: r(sI, 1), share: r(mI / A.value, 4), shareSe: sI === null ? null : r(sI / A.value, 4),
                authorityPermille: r(A.value, 0), authoritySource: A.source, uPermille: r(mU, 1), uSe: r(se('u'), 1), worst };
        }
        out.T13 = Object.assign({ byProfile }, lim, { atLimitWindows: atLimit, climbWindows: climb, collectiveMedian: r(cMed, 0),
            definition: `steady hover: 1 s usable windows with |yaw sp| < ${R.yaw}, |roll, pitch sp| < ${R.cyclic} deg/s, collective swing < ${R.collSwing * 100} % of collectiveRange, mixer[2] off the tail limit, and mean |collective| within ${R.collAbove} of the median of the log's such windows; median axisI[2] and mixer[2] in permille; share = I / one-sided yaw authority (this log's clamp, else the file's, else the CLI SY limit, else ${R.authority * 1000} but at least the logged extreme; judge pools over the file); SE from ${RULE.blockS} s block medians` });
    }

    // --- C14: pitch I + O against collective, per profile, in 0.03-0.3 Hz, where the loop has absorbed the moment the
    // collective puts on the pitch axis. Above 0.2 Hz (pumps) it has not: in a simulated loop with the Gaui gains a regression
    // there reads 55-70 % of the true coupling (test/health_more.test.cjs), so that band is reported, not judged.
    if (!coll) out.C14 = { skipped: 'The log does not have the collective.' };
    else {
        const R = RULE.pitch, O = X['axisO[1]'], io = Float64Array.from(w.I[1], (v, i) => v * 1000 + (O ? O[i] : 0));
        // band-passed over each profile's usable runs stitched together. A filter over the whole log spreads the take-off and
        // landing steps (collective -200 to hover, I + O from its ground value to the trim), rescue, and the steps of hover
        // collective and trim at a profile switch over about 20 s of usable samples, and the regression reads them as
        // coupling; a filter per run starts each run at its own first value, and that start transient reads low on short
        // runs; runs of other profiles joined in carry their coupling across the join. So the usable runs of one profile (a
        // usable run never spans a switch) are joined in time order, each shifted to continue the level the run before ended
        // at (means over joinS), and filtered once. Simulated pitch loop with 20 s on the ground at each end and 80 rms of
        // collective activity, mean bias over 8 seeds (per 1000 collective): truth 100, whole log +29, stitched -2; a 50
        // permille trim step at profile switches with no coupling, whole log +24 to +84, stitched within 1; couplings 300
        // and 100 on 15 s profile segments, all runs stitched together +36 on the 100, per profile -2; 12 s segments, a
        // filter per run -14, stitched -2 (test/health_more.test.cjs C14 with take-off and landing)
        const groups = new Map(), J = S(R.joinS);
        for (const [a, b] of runs(n, i => ok[i])) { if (!groups.has(prof[a])) groups.set(prof[a], []); groups.get(prof[a]).push([a, b]); }
        const bp = (x, lo, hi) => { const y = new Float64Array(n);
            for (const segs of groups.values()) { const st = new Float64Array(segs.reduce((q, [a, b]) => q + b - a, 0)); let k = 0, prev = null;
                for (const [a, b] of segs) { const off = prev === null ? 0 : prev - mean(x, a, Math.min(b, a + J)); for (let i = a; i < b; i++) st[k++] = x[i] + off; prev = mean(x, Math.max(a, b - J), b) + off; }
                const f = lib.bandpass(st, lo, hi, rate); k = 0; for (const [a, b] of segs) for (let i = a; i < b; i++) y[i] = f[k++]; }
            return y; };
        const band = (lo, hi, bs) => { const hy = bp(io, lo, hi), hx = bp(coll, lo, hi), acc = {}, B = S(bs);
            for (let i = 0; i < n; i++) { if (!ok[i] || Math.abs(w.sp[1][i]) >= R.quiet) continue;
                const A = acc[prof[i]] = acc[prof[i]] || new Map(), b = Math.floor(i / B), q = A.get(b) || [0, 0, 0]; q[0] += hx[i] * hy[i]; q[1] += hx[i] * hx[i]; q[2]++; A.set(b, q); }
            return acc; };
        const slow = band(R.slow[0], R.slow[1], R.slowBlockS), fast = band(R.hpHz, 0.45 * rate, RULE.blockS), slope = (A) => jackknife(A ? [...A.values()] : [], (v) => v[1] > 0 ? 1000 * v[0] / v[1] : null);
        const SB = S(R.slowBlockS), heavy = (A) => { if (!A) return []; const tot = sum([...A.values()].map(q => q[1]));
            return [...A].sort((x, y) => y[1][1] - x[1][1]).slice(0, RULE.worst).map(([b, q]) => ({ t0: t(b * SB), t1: t(Math.min(n, (b + 1) * SB)), value: r(q[1] > 0 ? 1000 * q[0] / q[1] : null, 2), share: r(tot > 0 ? q[1] / tot : null, 4), seconds: r(q[2] / rate, 1) })); };
        // collective steps with both cyclic sticks quiet, as the peer: pitch error over errS, change of I + O, signed by the step
        const W = S(R.withinS), pre = S(R.preS), post = S(R.postS), half = S(R.errS), steps = [];
        for (let i = pre; i < n - post - W;) {
            const d = coll[i + W] - coll[i]; if (Math.abs(d) < R.step) { i += 10; continue; }
            let good = true; for (let j = i - pre; j < i + W + post && good; j++) good = ok[j] && prof[j] === prof[i] && Math.abs(w.sp[0][j]) < R.quiet && Math.abs(w.sp[1][j]) < R.quiet;
            if (!good) { i += 10; continue; }
            const sg = Math.sign(d); let e = 0; for (let j = i; j < i + half; j++) e += w.sp[1][j] - w.gyro[1][j];
            steps.push({ t: t(i), profile: prof[i], step: r(d, 0), value: r(sg * e / half, 2), err: r(sg * e / half, 2), perK: r(1000 * sg * (io[i + W + post - 1] - io[i - pre]) / Math.abs(d), 2) });
            i += S(R.gapS);
        }
        const g0 = typeof H.pitch_compensation === 'number' ? H.pitch_compensation : null, byProfile = {};
        for (const p of new Set([...Object.keys(slow), ...Object.keys(fast), ...steps.map(s => String(s.profile))])) {
            const k = slope(slow[p]), kf = slope(fast[p]), st = steps.filter(s => String(s.profile) === p), N = slow[p] ? sum([...slow[p].values()].map(q => q[2])) : 0;
            byProfile[p] = { seconds: r(N / rate, 1), blocks: k.n, slope: r(k.value, 2), slopeSe: r(k.se, 2), gainChange: r(k.value === null ? null : k.value / 2, 1), gainChangeSe: r(k.se === null ? null : k.se / 2, 1),
                fast: { slope: r(kf.value, 2), se: r(kf.se, 2), blocks: kf.n }, steps: { n: st.length, err: stat(st.map(s => s.err)), perK: stat(st.map(s => s.perK)) }, worst: heavy(slow[p]) };
        }
        out.C14 = { headerGain: g0, axisOLogged: !!O, byProfile, events: cap(steps),
            definition: `slope = 1000 x sum(bp(I + O) bp(coll)) / sum(bp(coll)^2) over usable samples with |pitch sp| < ${R.quiet}, bp = ${R.slow[0]}-${R.slow[1]} Hz band-pass over each profile's usable runs joined end to end, each shifted to the level the one before ended at (${R.joinS} s means): pitch I + O (permille) per 1000 collective, SE over ${R.slowBlockS} s blocks; the gain change that supplies it is slope / 2 (pid.c:937-942). fast: the same above ${R.hpHz} Hz, SE over ${RULE.blockS} s blocks. Steps: |d mixer[3]| >= ${R.step} in ${R.withinS} s, both cyclic sticks quiet; err = mean pitch sp - gyro over ${R.errS} s, perK = change of I + O from -${R.preS} to +${R.withinS + R.postS} s per 1000 collective, both signed by the step` };
    }

    // --- T14: yaw at headspeed ramps
    out.T14 = rampEvents(w, ctx, H, X, ok, rate, t, limY);
    return out;
}

function appOf(ctx) { return ctx.app || appOf.cache || (appOf.cache = lib.loadApp()); } // FFT host; lib.loadApp needs Node (CLI and tests only)

// G14: seconds and entries per state, over the whole segment and while airborne; spool-ups; autorotation and bailout entries
function governorCensus(w, ctx, sp, base, coll, rate, t) {
    const n = w.n, g = ctx.govState, X = w.extra || {}, mot = X['motor[0]'], S = (s) => Math.max(1, Math.round(s * rate));
    if (!g) return { skipped: 'The log does not record GOVSTATE.' };
    const air = sp.hasAirborne ? w.airborneAt : base, states = {}, spoolups = [], entries = [];
    const slope = (x, s, e) => { if (!x || e - s < 10) return null; let mt = 0, mx = 0; for (let i = s; i < e; i++) { mt += i; mx += x[i]; } mt /= e - s; mx /= e - s;
        let sxy = 0, sxx = 0; for (let i = s; i < e; i++) { sxy += (i - mt) * (x[i] - mx); sxx += (i - mt) ** 2; } return sxy / sxx * rate; };
    for (let s = 0, e = 1; s < n; s = e, e = s + 1) {
        while (e < n && g[e] === g[s]) e++;
        const name = STATES[g[s]] || String(g[s]), q = states[name] = states[name] || { seconds: 0, secondsAirborne: 0, entries: 0, entriesAirborne: 0 };
        let a = 0; for (let i = s; i < e; i++) a += air[i];
        q.seconds += (e - s) / rate; q.secondsAirborne += a / rate;
        if (s > 0) { q.entries++; if (air[s]) q.entriesAirborne++; }
        if (g[s] === 2) { const thr = mot ? slope(mot, s, e) : null;
            spoolups.push({ t: t(s), seconds: r((e - s) / rate, 2), value: r((e - s) / rate, 2), to: e < n ? STATES[g[e]] : null, throttlePctPerS: r(thr === null ? null : thr / 10, 3), rpmPerS: r(slope(w.hs, s, e), 1),
                impliedSpoolupTime: thr > 0 ? Math.round(1000 / (thr / 10)) : null, headspeedEnd: r(w.hs[e - 1], 0) }); }
        if (s > 0 && (g[s] === 7 || g[s] === 8) && air[s]) {
            const c = coll ? mean(coll, Math.max(0, s - S(0.2)), s) : null;
            entries.push({ t: t(s), state: name, from: STATES[g[s - 1]], seconds: r((e - s) / rate, 3), value: r((e - s) / rate, 3), collective: r(c, 0), headspeed: r(w.hs[s], 0), landing: !!sp.ground[s], inFlight: !!base[s] });
        }
    }
    for (const k in states) { states[k].seconds = r(states[k].seconds, 2); states[k].secondsAirborne = r(states[k].secondsAirborne, 2); }
    const done = spoolups.filter(q => q.to === 'ACTIVE'), thr = stat(done.map(q => q.throttlePctPerS));
    return { states, spoolups: spoolups.slice(0, RULE.maxEvents), entries: entries.slice(0, RULE.maxEvents), airborneFrom: sp.hasAirborne ? 'AIRBORNE_STATE events' : 'in-flight mask (no AIRBORNE_STATE events)',
        spoolup: { n: done.length, seconds: stat(done.map(q => q.seconds)), throttlePctPerS: thr, rpmPerS: stat(done.map(q => q.rpmPerS)), impliedSpoolupTime: thr.mean > 0 ? Math.round(1000 / thr.mean) : null },
        definition: 'states from GOVSTATE events; entries counted at the state change (airborne by the firmware flag); spool-up ramps are OLS slopes of motor[0] / 10 (%/s) and headspeed over the SPOOLUP state; implied gov_spoolup_time = 1000 / (%/s), unit 0.1 s (governor.c:1603-1609); landing = entry inside the landing ground-contact span' };
}

// T14: rotor speed ramps the governor makes in flight (target change, profile switch), outside governor state changes.
// lim: the tail output limit (limitOf of mixer[2]) or null
function rampEvents(w, ctx, H, X, ok, rate, t, lim) {
    const n = w.n, R = RULE.ramp, S = (s) => Math.max(1, Math.round(s * rate)), prof = ctx.profile, gov = ctx.govState, tg = X.govTarget, fly = ctx.flying;
    // anti-torque side of the tail control: sign of its median in usable flight (health_loop rotation); the precomp sign as fallback
    const med = (x) => { const v = []; for (let i = 0; i < n; i += 10) if (ok[i]) v.push(x[i]); return median(v) || 0; };
    const rot = Math.sign(med(w.u[2])) || Math.sign(med(w.F[2]));
    if (!rot) return { skipped: 'The direction in which the main rotor turns is unknown. The log has no flight data that the check can use, or the tail control and the precompensation are 0.' };
    const hsT = Float64Array.from(w.hs, (h, i) => h + rot * w.gyro[2][i] / 6), h = S(R.halfS), d = new Float64Array(n); // rotor speed in space: frame rotation removed
    for (let i = h; i < n - h; i++) d[i] = (hsT[i + h] - hsT[i - h]) / (2 * h / rate);
    const ic = Array.isArray(H.yaw_inertia_precomp) ? H.yaw_inertia_precomp : null, gain0 = ic ? ic[0] : null, cut = ic && ic[1] > 0 ? ic[1] / 10 : 2.5;
    // the firmware's inertia term (pid.c:897-901) on the rotor speed in space, and the tail feedback (control minus all FF and
    // precomp). The firmware corrects the headspeed with the yaw setpoint, not the gyro; the two differ by the tracking error
    // / 6 rpm, nothing at a 200 rpm/s ramp, but the gyro part of that term moves with the tail's own response to noise: on
    // simulated wagging tails without inertia torque it biased the fit by +2 to +13 units, the rotor speed in space by 2 at most
    const sc = lib.dif(pt2(Float64Array.from(hsT, (v) => v / 3000), 20, rate), cut, rate), fb = Float64Array.from(w.u[2], (v, i) => v - w.F[2][i]);
    const atLim = (i) => !!lim && ((lim.lo !== null && w.u[2][i] <= lim.lo + RULE.limit.tol) || (lim.hi !== null && w.u[2][i] >= lim.hi - RULE.limit.tol));
    const pre = S(R.preS), gap = S(R.postGapS), post = S(R.postS), ev = [], seen = { ramps: 0, unexplained: 0, governorState: 0, collective: 0, stick: 0, limit: 0 };
    const FULL = [4, 6, 9]; // ACTIVE, FALLBACK, BYPASS: spool-up ratio 1, precomp fully applied (governor.c:293-322, pid.c:886)
    const cA = (X['mixer[3]'] || w.coll) ? Float64Array.from(X['mixer[3]'] || w.coll, Math.abs) : null; // |collective|
    const cands = [];
    for (const sg of [1, -1]) for (const [s, e] of runs(n, i => fly[i] && sg * d[i] >= R.rate)) if (e - s >= S(R.minS)) cands.push([s, e, sg]);
    cands.sort((a, b) => a[0] - b[0]);
    for (const [s, e, sg] of cands) {
        if (s - pre < 0 || e + gap + post > n) continue;
        let all = true; for (let i = s - pre; i < e + gap + post && all; i++) all = !!fly[i];
        if (!all) continue;
        seen.ramps++;
        // a governor state change gates the precomp (spool-up ratio) and switches the drive torque: not an inertia event
        let sw = false, gs = !!gov && !FULL.includes(gov[s - pre]); for (let i = s - pre + 1; i < e + gap + post; i++) { if (i < e && prof[i] !== prof[i - 1]) sw = true; if (gov && gov[i] !== gov[i - 1]) gs = true; }
        if (gs) { seen.governorState++; continue; }
        // without a profile switch in the ramp the target must have moved by its end, in its direction: a target change that
        // starts after the ramp (a later switch) does not explain it (the governor recovering from a collective punch)
        const tg0 = tg ? mean(tg, s - pre, s) : null, dT = tg ? mean(tg, e + gap, e + gap + post) - tg0 : null, dTe = tg ? tg[e - 1] - tg0 : null;
        if (!(sw || (dT !== null && Math.abs(dT) >= R.minTarget && sg * dTe >= R.minTarget))) { seen.unexplained++; continue; }
        // |collective| moving while the yaw peak is read (ramp and afterS) changes the drag torque: the collective precomp's job
        const dC = cA ? (mean(cA, s, e + S(R.afterS)) - mean(cA, s - pre, s)) * 0.012 : null;
        if (dC !== null && Math.abs(dC) > R.maxCollDeg) { seen.collective++; continue; }
        let ys = 0; for (let i = s - S(R.baseS); i < e + S(R.afterS); i++) ys = Math.max(ys, Math.abs(w.sp[2][i])); // a moving yaw stick swamps the torque
        if (ys > R.quiet) { seen.stick++; continue; }
        // the tail at its output limit: the yaw then shows the missing authority, and the feedback is clipped
        let sat = false; for (let i = s - S(R.baseS); i < e + S(R.afterS) && !sat; i++) sat = atLim(i);
        if (sat) { seen.limit++; continue; }
        // yaw deviation toward the reaction torque (+ = nose moved with it): torque yaws the body to -rot (health_loop torqueSign)
        const b0 = mean(w.sp[2], s - S(R.baseS), s) - mean(w.gyro[2], s - S(R.baseS), s), tw = (i) => (w.sp[2][i] - w.gyro[2][i] - b0) * rot * sg, end = e + S(R.afterS);
        let pw = 0, wt = 0; for (let i = s; i < e; i++) { pw += tw(i) * Math.abs(d[i]); wt += Math.abs(d[i]); }
        const dir = Math.sign(pw) || 1; let pk = 0; for (let i = s; i < end; i++) pk = Math.max(pk, dir * tw(i));
        // tail control and feedback over the ramp against the straight line between the levels before and after
        const c0 = s - pre / 2, c1 = e + gap + post / 2, line = (x) => { const a = mean(x, s - pre, s), b = mean(x, e + gap, e + gap + post); return (i) => a + (b - a) * (i - c0) / (c1 - c0); };
        const lu = line(w.u[2]), lf = line(fb); let du = 0; for (let i = s; i < e; i++) du += w.u[2][i] - lu(i); du /= e - s;
        let sxy = 0, sxx = 0; for (let i = s - S(R.fitS[0]); i < e + S(R.fitS[1]); i++) { const x = rot * sc[i] / 200; sxy += x * (fb[i] - lf(i)); sxx += x * x; }
        const rpm = mean(d, s, e);
        ev.push({ t: t(s), seconds: r((e - s) / rate, 3), rpmPerS: r(rpm, 0), profile: prof[e], profileFrom: prof[s - pre], cause: sw ? 'profile switch' : 'target change', targetChange: r(dT, 0),
            value: r(dir * pk, 1), toward: r(dir * pk, 1), weighted: r(wt ? pw / wt : null, 2), duPermille: r(du * 1000, 1), againstAcceleration: Math.sign(du) === -sg, antiTorque: Math.sign(du) === rot * sg,
            gainFit: r(sxx ? sxy / sxx : null, 0), yawStickMax: r(ys, 0), collectiveChangeDeg: r(dC, 2), sxy, sxx });
    }
    const v = ev.map(q => q.toward), pos = v.filter(x => x > 0).length, fit = jackknife(ev.map(q => [q.sxy, q.sxx]), (q) => q[1] > 0 ? q[0] / q[1] : null);
    const fitSign = fit.value === null ? 0 : Math.sign(fit.value), fitSame = ev.filter(q => q.sxx > 0 && Math.sign(q.sxy) === fitSign).length;
    return { rotationSign: rot, mainRotor: rot < 0 ? 'CW' : 'CCW', headerInertia: ic, events: cap(ev.map(({ sxy, sxx, ...q }) => q)), n: ev.length, rampsInFlight: seen.ramps, unexplainedRamps: seen.unexplained, stateChangeRamps: seen.governorState, collectiveRamps: seen.collective, stickRamps: seen.stick, limitRamps: seen.limit,
        toward: stat(v), consistency: ev.length ? r(Math.max(pos, ev.length - pos) / ev.length, 3) : null, majority: pos >= ev.length - pos ? 1 : -1,
        againstAcceleration: ev.filter(q => q.againstAcceleration).length, antiTorque: ev.filter(q => q.antiTorque).length,
        gainChange: { value: r(fit.value, 0), se: r(fit.se, 0), n: fit.n }, gainImplied: fit.value === null ? null : r((gain0 || 0) + fit.value, 0), fitConsistency: ev.length && fitSign ? r(fitSame / ev.length, 3) : null,
        definition: `events: |d(rotor speed)/dt| >= ${R.rate} rpm/s (central difference over ${2 * R.halfS} s, frame rotation removed with the yaw gyro) for >= ${R.minS} s, in flight from ${R.preS} s before to ${R.postGapS + R.postS} s after, caused by a profile switch in the ramp or a governor target change >= ${R.minTarget} rpm already made by the end of the ramp, the governor in one state with spool-up ratio 1 throughout (ACTIVE, FALLBACK, BYPASS), the tail off its output limit and, while the peak is read, the mean |collective| within ${R.maxCollDeg} deg of its level before and the yaw stick within ${R.quiet} deg/s. gainChange (judged): least squares of the tail feedback (mixer - axisF) deviation from the line between the levels before and after, on the firmware inertia term (pid.c:897-904) of the rotor speed in space, from ${R.fitS[0]} s before to ${R.fitS[1]} s after the ramp, pooled over events, jackknife over events; fitConsistency: share of the per-event fits with its sign. toward (described): the largest yaw-rate deviation from the ${R.baseS} s before, within the ramp and ${R.afterS} s after, in the direction the |acceleration|-weighted deviation takes over the ramp; + = the nose moved with the reaction torque; a lagging precomp leaves it at the matching gain. du: tail control over the ramp minus the line between the levels before and after` };
}

// ---------------------------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------------------------

// Finding texts follow ASD-STE100 (docs/STE_GLOSSARY.md): sentences of 25 words or less, paragraphs of 6 sentences or
// less, joined by '\n'. A note on thin data has thin: true. Code reads the fields of a finding, never its text.
function judge(flights, RULES = DEFAULT_RULES) {
    const F = [], sig = RULES.sig === undefined ? 2 : RULES.sig, fmt = (v, d = 2) => typeof v === 'number' && isFinite(v) ? v.toFixed(d) : 'unknown';
    const pm = (v, se, d) => typeof se === 'number' && isFinite(se) ? `${fmt(v, d)} ± ${fmt(se, d)}` : fmt(v, d), pct = (v) => typeof v === 'number' ? 100 * v : null;
    const add = (id, severity, f, profile, o) => F.push(Object.assign({ id, severity, log: f.log, profile: profile === undefined || profile === null ? null : +profile, value: null, se: null, n: null, threshold: null, source: (RULES[id] || {}).source || null, unit: UNITS[id],
        phase: PHASE_OF[id] }, AXIS[id] ? { axis: AXIS[id] } : {}, o));
    const NONE = 'The data is not sufficient for a result.', thin = (what, n, min) => `${NONE} The number of ${what} is ${n}. A minimum of ${min} is necessary.`;
    const pass = (v, se, thr) => v !== null && se !== null && se !== undefined && v - sig * se > thr; // the 2-SE test
    const para = (...p) => p.map(q => q && q.trim()).filter(Boolean).join('\n'), BL = `periods of ${RULE.blockS} s`, bl = (k) => `${many(k, 'period')} of ${RULE.blockS} s`, by = `by more than ${sig} SE`;
    const info = (lim) => `This value is for information. Only a time delay of more than ${lim} ms ${by} is a problem.`;

    // T13 authority pool over the logs of this call (one heli, one CLI): detected tail clamps, logged extremes, the CLI SY limit
    const isNum = (v) => typeof v === 'number' && isFinite(v), t13 = flights.map(f => f.metrics && f.metrics.T13).filter(m => m && m.byProfile), cl = t13.find(m => m.cliLimit), t13Pool = { conflict: '' };
    for (const sd of ['lo', 'hi']) t13Pool[sd] = { det: t13.map(m => m.limit && m.limit[sd]).filter(isNum), obs: t13.map(m => m.observed && m.observed[sd]).filter(isNum), cli: cl ? cl.cliLimit[sd] : null };
    const odd = cl ? ['lo', 'hi'].filter(sd => t13Pool[sd].det.some(d => Math.abs(d - cl.cliLimit[sd]) > RULE.limit.tol * 1000)) : [];
    if (odd.length) t13Pool.conflict = `The CLI dump gives the limits ${cl.cliLimit.lo} and ${cl.cliLimit.hi} for the SY mixer input, but the logs show an output limit at ${odd.map(sd => `${median(t13Pool[sd].det)}`).join(' and ')}. ` +
        'Thus, the CLI dump is not from the time of these flights.';

    for (const f of flights) {
        const M = f.metrics || {};
        if (M.skipped) { for (const id of IDS) add(id, 'skipped', f, null, { text: M.skipped }); continue; }
        // D6
        if (M.D6) { const d = M.D6, x = d.excluded, tot = r(x.rescueS + x.levelModeS + x.failsafeS + x.groundS + x.guardS, 2), fsEv = d.events.filter(e => e.reason === 'failsafe');
            const parts = series([[x.rescueS, 'rescue'], [x.levelModeS, 'a level mode'], [x.failsafeS, 'failsafe'], [x.groundS, 'ground contact']].filter(([v]) => v > 0).map(([v, w]) => `${fmt(v)} s is ${w}`));
            const used = tot > 0 ? `The analysis does not use ${fmt(tot, 1)} s of the ${fmt(d.flyingS, 1)} s of flight.` + (parts ? ` Of this time, ${parts}.` : '') + ` The ${parts ? 'remaining ' : ''}${fmt(x.guardS)} s is the ${RULE.spanGuardS} s before and after each of these periods.`
                : `The analysis uses all ${fmt(d.flyingS, 1)} s of flight.`;
            const text = (head) => para(`${head} ${used}` + (d.rescueActivations ? ` Rescue operated ${many(d.rescueActivations, 'time')}, and the rescue time includes the exit time.` : ''), d.rescueSource, ...d.notes);
            if (d.failsafeAirborneS > 0) add('D6', 'flag', f, null, { value: d.failsafeAirborneS, n: fsEv.length, threshold: 'failsafe while airborne > 0 s', unit: 's', events: fsEv,
                text: text(`Failsafe was active for ${fmt(d.failsafeAirborneS)} s in flight${fsEv.length ? `, first at ${fsEv.map(e => e.t).sort((a, b) => a - b)[0]} s` : ''}. Examine the receiver link and the failsafe adjustments.`) });
            else add('D6', tot > 0 ? 'note' : 'ok', f, null, { value: tot, n: d.events.length, threshold: 'report only; failsafe while airborne > 0 s flags', unit: 's', events: d.events, text: text('') }); }
        // F10
        if (M.F10) { const R = RULES.F10; if (M.F10.skipped) add('F10', 'skipped', f, null, { text: M.F10.skipped });
            else for (const ax of AXES) { const m = M.F10[ax]; if (!m) continue;
                const yaw = ax === 'yaw', unit = yaw ? 'fraction' : 'permille', hz = M.F10.hz, win = `windows of ${M.F10.windowS} s`;
                if (!Object.keys(m.byProfile).length) add('F10', 'note', f, null, { axis: ax, n: 0, unit, thin: true, text: `${NONE} The flight has no window of ${M.F10.windowS} s on one PID profile that the check can use.` });
                for (const [p, s] of Object.entries(m.byProfile)) {
                    const other = AXES.filter(a => a !== ax).map(a => M.F10[a] && M.F10[a].byProfile[p] ? `${a} ${fmt(M.F10[a].byProfile[p].controlPermille, 2)} ‰` : null).filter(Boolean).join(', ');
                    const ctl = `The ${ax} mixer output at more than ${hz} Hz is ${pm(s.controlPermille, s.controlSe, 2)} ‰ rms${other ? ` (${other})` : ''}.`;
                    // roll and pitch: the control noise only; their D share is C11's (health_loop), the same measure
                    if (!yaw) { add('F10', 'note', f, p, { axis: ax, value: s.controlPermille, se: s.controlSe, n: s.windows, unit, threshold: 'report only (no documented threshold)', controlPermille: s.controlPermille, controlSe: s.controlSe,
                        text: `${ctl} C11 measures the ${ax} D-term at more than ${hz} Hz.` }); continue; }
                    const o = { axis: ax, value: s.share, se: s.shareSe, n: s.windows, unit, threshold: `D share - ${sig} SE > ${R.share} (yaw; roll and pitch are judged by C11)`, controlPermille: s.controlPermille, controlSe: s.controlSe };
                    if (!m.dLogged) { add('F10', 'note', f, p, Object.assign(o, { text: `The yaw D-term (axisD[2]) is 0, or the log does not have it. ${ctl}` })); continue; }
                    const dTxt = `Of the yaw D-term power, ${pm(pct(s.share), pct(s.shareSe), 1)} % is at more than ${hz} Hz (${many(s.windows, 'window')} of ${M.F10.windowS} s, ${bl(s.blocks)}).`;
                    const few = s.windows < R.minWindows ? thin(win, s.windows, R.minWindows) : s.blocks < R.minBlocks ? thin(BL, s.blocks, R.minBlocks) : s.shareSe === null ? `${NONE} The analysis cannot calculate a standard error from the ${BL}.` : null;
                    if (few) { add('F10', 'note', f, p, Object.assign(o, { thin: true, text: para(few, `${dTxt} ${ctl}`) })); continue; }
                    const flag = pass(s.share, s.shareSe, R.share);
                    add('F10', flag ? 'flag' : 'ok', f, p, Object.assign(o, { text: para(`${dTxt} This is ${flag ? '' : 'not '}more than ${fmt(R.share * 100, 0)} % ${by}.` +
                        (flag ? ` Most of the yaw D-term comes from gyro noise at more than ${hz} Hz. Correct the filters first. Then decrease yaw_d_gain.` : ''), ctl) })); } } }
        // F11
        if (M.F11) { const R = RULES.F11; if (M.F11.skipped) add('F11', 'skipped', f, null, { text: M.F11.skipped });
            else for (const ax of AXES) { const s = M.F11[ax], o = { axis: ax, value: s.delayMs, se: s.delaySe, n: M.F11.windows, unit: 'ms', threshold: `delay - ${sig} SE > ${R.flagMs} ms`, gain12: s.gain12, measuredMs: s.measuredMs, logOffsetMs: M.F11.logOffsetMs };
                const txt = `The gyro filters cause a time delay of ${pm(s.delayMs, s.delaySe)} ms in the ${ax} gyro at ${M.F11.band[0]}-${M.F11.band[1]} Hz, from gyroRAW to gyroADC (coherence ${fmt(s.coherence, 3)}, ${many(M.F11.windows, 'window')}). ` +
                    `At ${RULE.delay.gainHz} Hz, the gain of the filters is ${pm(s.gain12, s.gainSe, 3)}.` + (M.F11.logOffsetMs > 0 ? ` The log records gyroRAW ${many(RULE.delay.logTicks, 'gyro sample')} after the filter input. Thus, the analysis decreases the measured ${fmt(s.measuredMs, 2)} ms by ${fmt(M.F11.logOffsetMs, 2)} ms.` : '');
                if (M.F11.windows < R.minWindows || M.F11.blocks < R.minBlocks) { add('F11', 'note', f, null, Object.assign(o, { thin: true,
                    text: para(`${NONE} The number of windows in flight is ${M.F11.windows}, in ${bl(M.F11.blocks)}. A minimum of ${R.minWindows} windows in ${R.minBlocks} periods is necessary.`, txt) })); continue; }
                const flag = pass(s.delayMs, s.delaySe, R.flagMs);
                add('F11', flag ? 'flag' : 'note', f, null, Object.assign(o, { text: txt + (flag ? ` The time delay is more than ${R.flagMs} ms ${by}. This time delay is too large for the loop. ` +
                    'Examine the low-pass filter cutoffs, the notch filters and the dynamic notch filter.' : ` ${info(R.flagMs)}`) })); } }
        // T13: the one-sided authority pooled over the logs of this call (authority(): this log's clamp, the file's, the CLI)
        if (M.T13) { const R = RULES.T13, T = M.T13, ps = Object.entries(T.byProfile), Hv = RULE.hover;
            const out = [T.atLimitWindows ? `${many(T.atLimitWindows, 'window')} at the tail output limit` : '',
                T.climbWindows ? `${many(T.climbWindows, 'window')} with a collective of more than ${T.collectiveMedian + Hv.collAbove} (the median hover collective plus ${Hv.collAbove})` : ''].filter(Boolean);
            const left = out.length ? `The analysis does not use ${series(out)}.` : '';
            if (!ps.length) add('T13', 'note', f, null, { n: 0, unit: 'fraction', thin: true, text: `${NONE} The log has no windows of stable hover. ${left}`.trim() });
            for (const [p, s] of ps) {
                const side = s.iPermille < 0 ? 'lo' : 'hi', A = authority(T, side, t13Pool[side]), uA = authority(T, s.uPermille < 0 ? 'lo' : 'hi', t13Pool[s.uPermille < 0 ? 'lo' : 'hi']).value;
                const share = s.iPermille / A.value, shareSe = s.iSe === null ? null : s.iSe / A.value, near = Math.abs(s.uPermille) >= R.nearLimit * uA;
                const o = { value: r(share, 4), se: r(shareSe, 4), n: s.windows, unit: 'fraction', threshold: `|I share| - ${sig} SE > ${R.share}`, iPermille: s.iPermille, iSe: s.iSe, uPermille: s.uPermille, authorityPermille: r(A.value, 0), authoritySource: A.source };
                const p1 = `In hover, the yaw I-term is ${pm(s.iPermille, s.iSe, 0)} ‰. This is ${pm(share * 100, shareSe === null ? null : shareSe * 100, 1)} % of the tail output limit of ${fmt(A.value, 0)} ‰ (${A.text}).`;
                const p2 = `The analysis uses ${s.seconds} s of hover in ${bl(s.blocks)}. In hover, mixer[2] is ${pm(s.uPermille, s.uSe, 0)} ‰. ` +
                    (near ? `This is near the tail output limit of ${fmt(uA, 0)} ‰ (refer to T8).` : 'This is the tail pitch that is necessary for the hover, and it is a usual value.'), p3 = `${left} ${t13Pool.conflict}`;
                if (s.blocks < R.minBlocks || shareSe === null) { add('T13', 'note', f, p, Object.assign(o, { thin: true, text: para(thin(`${BL} with hover`, s.blocks, R.minBlocks), p1, p2, p3) })); continue; }
                const flag = pass(Math.abs(share), shareSe, R.share);
                add('T13', flag ? 'flag' : 'note', f, p, Object.assign(o, { text: para(`${p1} The I-term is ${flag ? '' : 'not '}more than ${fmt(R.share * 100, 0)} % of this limit ${by}.`,
                    flag ? 'The I-term holds a constant trim in hover, and the feedforward does not supply it. Examine the tail center trim (tail_center_trim, MIXS). ' +
                        'If the I-term follows the collective, the collective precompensation is too low (T7). The PID gains are not the cause.' : '', p2, p3) })); } }
        // C14
        if (M.C14) { const R = RULES.C14, P = RULE.pitch; if (M.C14.skipped) add('C14', 'skipped', f, null, { text: M.C14.skipped });
            else { const ps = Object.entries(M.C14.byProfile); if (!ps.length) add('C14', 'note', f, null, { n: 0, unit: 'per 1000 collective', thin: true, text: `${NONE} The check has no samples with a stable pitch stick.` });
                for (const [p, s] of ps) {
                    const g0 = M.C14.headerGain, to = g0 === null || s.gainChange === null ? null : Math.max(0, Math.min(250, Math.round(g0 + s.gainChange))), change = to === null ? null : to - g0;
                    const st = s.steps, fs = s.fast, io = M.C14.axisOLogged ? 'sum of axisI[1] and axisO[1]' : 'pitch I-term', o = { value: s.slope, se: s.slopeSe, n: s.blocks, unit: 'per 1000 collective',
                        threshold: `|slope| - ${sig} SE > ${R.flag}, a gain change >= ${R.minGainChange}, the fast coupling not of the other sign by ${sig} SE`, gainChange: s.gainChange, gainChangeSe: s.gainChangeSe, from: g0, to, fast: fs };
                    const p1 = `The ${io} changes by ${pm(s.slope, s.slopeSe, 1)} ‰ for each 1000 units of collective at ${P.slow[0]}-${P.slow[1]} Hz (${s.seconds} s, ${many(s.blocks, 'period')} of ${P.slowBlockS} s). ` +
                        `A pitch_collective_ff_gain change of ${pm(s.gainChange, s.gainChangeSe, 0)} can supply this, and the header value is ${g0 === null ? 'unknown' : g0}.`;
                    const p2 = `At more than ${P.hpHz} Hz, the change is ${pm(fs.slope, fs.se, 1)} ‰ for each 1000 units. The check does not use this value, because the loop does not fully correct the pitch change from the collective at these frequencies.`;
                    const p3 = st.n ? `In ${many(st.n, 'collective step')}, the pitch error is ${pm(st.err.mean, st.err.se, 1)} deg/s. In ${st.n === 1 ? 'this step' : 'these steps'}, the ${io} changes by ${pm(st.perK.mean, st.perK.se, 0)} ‰ for each 1000 units.` : 'The log has no collective steps with the cyclic sticks stable.';
                    if (s.blocks < R.minBlocks || s.slopeSe === null) { add('C14', 'note', f, p, Object.assign(o, { thin: true, text: para(thin(`periods of ${P.slowBlockS} s`, s.blocks, R.minBlocks), p1, p2, p3) })); continue; }
                    const big = pass(Math.abs(s.slope), s.slopeSe, R.flag), against = fs.slope !== null && Math.sign(fs.slope) === -Math.sign(s.slope) && pass(Math.abs(fs.slope), fs.se, 0);
                    const flag = big && !against && change !== null && Math.abs(change) >= R.minGainChange;
                    const verdict = flag ? `${change > 0 ? 'Increase' : 'Decrease'} pitch_collective_ff_gain from ${g0} to ${to}.`
                        : big && against ? `The change at more than ${P.hpHz} Hz has the opposite sign. Thus, one feedforward gain cannot supply the two.`
                        : big && g0 === null ? 'The header does not give the present gain. Thus, there is no target value.'
                        : big ? `The parameter range (0 to 250) cannot supply this change, and the header value is ${g0}. Examine the swashplate and the servos.`
                        : `The change is not more than ${R.flag} ‰ for each 1000 units ${by}.`;
                    add('C14', flag ? 'flag' : 'note', f, p, Object.assign(o, { text: para(`${p1} ${verdict}`, p2, p3) })); } } }
        // T14: judged on the regression, the gain change that would supply the tail feedback moving with the rotor acceleration.
        // The peak yaw is described only: the precomp lags the torque, so a kick of about the same size stays at the matching gain
        if (M.T14) { const R = RULES.T14, m = M.T14; if (m.skipped) add('T14', 'skipped', f, null, { text: m.skipped });
            else { const tw = m.toward, g = m.gainChange, g0 = m.headerInertia ? m.headerInertia[0] : null, max = RULE.ramp.gainMax;
                const minChange = Math.max(R.minGainChange, R.relGainChange * (g0 || 0));
                const to = g0 === null || g.value === null ? null : Math.max(0, Math.min(max, Math.round(g0 + g.value))), change = to === null ? null : to - g0;
                const sure = m.n >= R.minEvents && g.value !== null && pass(Math.abs(g.value), g.se, minChange) && m.fitConsistency !== null && m.fitConsistency >= R.consistent;
                const flag = sure && change !== null && Math.abs(change) >= minChange, beyond = sure && g0 !== null && g0 + g.value - sig * g.se > max;
                const o = { value: g.value, se: g.se, n: m.n, unit: 'gain units', threshold: `>= ${R.minEvents} events, |gain change| - ${sig} SE > max(${R.minGainChange}, ${R.relGainChange} x header gain) = ${fmt(minChange, 0)}, >= ${R.consistent * 100} % of the per-event fits of its sign`,
                    from: g0, to: flag ? to : null, gainChange: g.value, gainChangeSe: g.se, gainImplied: m.gainImplied, fitConsistency: m.fitConsistency, toward: tw.mean, towardSe: tw.se, consistency: m.consistency,
                    events: m.events.map(e => ({ t: e.t, value: e.gainFit, toward: e.toward })) };
                const why = [[m.unexplainedRamps, 'with no change of the governor target'], [m.stateChangeRamps, 'at a change of the governor condition'], [m.collectiveRamps, 'with collective movement'],
                    [m.stickRamps, 'with yaw stick movement'], [m.limitRamps, 'with the tail at its output limit']].filter(([k]) => k > 0).map(([k, w]) => `The number of headspeed changes ${w} is ${k}.`).join(' ');
                const p1 = `The check uses ${m.n} of the ${many(m.rampsInFlight, 'headspeed change')} of the governor in flight. ${why}`;
                const p2 = g.value === null ? '' : `A yaw_inertia_precomp_gain change of ${pm(g.value, g.se, 0)} can supply the part of the tail control that follows the rotor acceleration. ` +
                    `The regression of each headspeed change gives this sign in ${Math.round((m.fitConsistency || 0) * 100)} % of the changes. The header value is ${g0 === null ? 'unknown' : g0}, and the firmware maximum is ${max}.`;
                const p3 = !m.n ? '' : `The peak yaw rate in the direction that the rotor acceleration turns the helicopter is ${pm(tw.mean, tw.se, 1)} deg/s. This peak has one sign in ${Math.round((m.consistency || 0) * 100)} % of the changes. ` +
                    'The check does not use this peak. The precompensation has a time delay. Thus, a peak of this dimension stays at the correct gain. ' +
                    `The tail control moved ${m.rotationSign < 0 ? 'against' : 'with'} the rotor acceleration (${m.mainRotor} rotor) in ${m.antiTorque} of ${many(m.n, 'change')}.`;
                const fails = [g.value === null || !pass(Math.abs(g.value), g.se, minChange) ? `The change is not more than ${fmt(minChange, 0)} ${by}.` : '',
                    m.fitConsistency === null || m.fitConsistency < R.consistent ? `Less than ${fmt(R.consistent * 100, 0)} % of the changes give this sign.` : ''].join(' ');
                const verdict = flag ? `${change > 0 ? 'Increase' : 'Decrease'} yaw_inertia_precomp_gain from ${g0} to ${to}.` +
                        (beyond ? ` The necessary value (${pm(g0 + g.value, g.se, 0)}) is more than the firmware maximum of ${max}. Thus, also make the headspeed changes slower (gov_tracking_time).` : '') +
                        ' In simulated loops, the regression was as much as 14 % too high. After the change, record a log with PID profile changes in flight.'
                    : beyond ? `The parameter range (0 to ${max}) cannot supply this change, and the header value is ${g0}. Make the headspeed changes slower (gov_tracking_time).`
                    : sure && g0 === null ? 'The header does not have yaw_inertia_precomp. Thus, there is no target value.'
                    : sure && g.value < 0 && change === 0 ? `The necessary change is less than the parameter range (0 to ${max}). Examine the rotor direction that the analysis finds from the tail control (${m.mainRotor}).`
                    : sure ? `The parameter range (0 to ${max}) limits the change to ${change}, but a minimum of ${fmt(minChange, 0)} is necessary.` : fails;
                add('T14', flag ? 'flag' : 'note', f, null, Object.assign(o, m.n < R.minEvents ? { thin: true, text: para(thin('headspeed changes', m.n, R.minEvents), p1, p2, p3) } : { text: para(p1, p2, verdict, p3) })); } }
        // G14
        if (M.G14) { const R = RULES.G14, m = M.G14; if (m.skipped) add('G14', 'skipped', f, null, { text: m.skipped });
            else { const bad = m.entries.filter(e => !e.landing && (e.state === 'BAILOUT' || (e.state === 'AUTOROTATION' && e.collective !== null && e.collective >= R.hover && e.seconds > R.autoS)));
                const st = Object.entries(m.states).sort((a, b) => b[1].seconds - a[1].seconds).map(([k, q]) => `${k} for ${fmt(q.seconds, 1)} s (${fmt(q.secondsAirborne, 1)} s in flight, ${many(q.entries, 'time')})`);
                const states = []; for (let i = 0; i < st.length; i += 4) states.push(`${i ? 'It was also' : 'The governor was'} ${series(st.slice(i, i + 4))}.`);
                const sp = m.spoolup, spTxt = !sp.n ? 'There is no spool-up to ACTIVE.' : `The spool-up to ACTIVE was ${fmt(sp.seconds.mean, 2)} s long, at ${fmt(sp.throttlePctPerS.mean, 2)} %/s of throttle and ${fmt(sp.rpmPerS.mean, 0)} rpm/s` +
                    `${sp.n > 1 ? ` (the mean of ${sp.n} spool-ups)` : ''}.` + (sp.impliedSpoolupTime ? ` This agrees with a gov_spoolup_time of approximately ${sp.impliedSpoolupTime}.` : '');
                const en = m.entries.map(e => `In flight, the governor went to ${e.state} at ${e.t} s for ${fmt(e.seconds, 2)} s${e.collective === null ? '' : `, with a collective of ${e.collective}`}${e.landing ? ' at the landing' : ''}.`), enP = [];
                for (let i = 0; i < en.length; i += 6) enP.push(en.slice(i, i + 6).join(' '));
                add('G14', bad.length ? 'flag' : 'note', f, null, { value: bad.length, n: m.entries.length, unit: 'entries', threshold: `BAILOUT in flight, or AUTOROTATION in flight with collective >= ${R.hover} for > ${R.autoS} s (landings excluded)`, events: bad.map(e => ({ t: e.t, value: e.seconds })),
                    text: para(bad.length ? `The governor went to AUTOROTATION or BAILOUT ${many(bad.length, 'time')} in flight (${bad.map(e => `${e.state} at ${e.t} s`).join(', ')}). ` +
                        'Examine the throttle switch and the throttle hold adjustments.' : '', `${states.join(' ')} ${spTxt}`, ...enP) }); } }
    }
    return F;
}

// ---------------------------------------------------------------------------------------------
// curves
// ---------------------------------------------------------------------------------------------

/**
 * Plot series for the UI (JSON-safe, typed arrays). Times are s from log start in RULE.binS steps (bin centres).
 *   gov      { t, hs, target, errPct, throttle, coll, state, profile }: means per bin, state and profile at the bin centre
 *   vib      per axis { f, raw, filt, pass, phaseDeg } (amplitude deg/s of a sinusoid per bin, 1 s Hann windows in flight;
 *            pass = |S_rf| / S_rr clipped to 1.5; phaseDeg = unwrapped phase of S_rf, the F11 phase: -360 f x its delay), rotorHz
 *            per profile, notches per axis (hz at the median headspeed), lpf, dynNotch; raw, pass and phaseDeg null and filtOnly
 *            true without gyroRAW. byProfile { p: { windows, share, rotorHz, notches (hz at that profile's headspeed),
 *            roll|pitch|yaw { f, raw, filt, pass, phaseDeg } } } over the windows wholly on profile p (at
 *            least RULE.vibMinWindows): the pooled spectrum splits a rotor-order line into one peak per profile, each
 *            scaled by about sqrt(the profile's share of the windows)
 *   dterm    per axis { f, psd (axisD, permille^2/Hz), share30 }; control per axis { f, psd (mixer, permille^2/Hz) }
 *   tail     { t, u: { min, max, mean } (mixer[2] permille per bin), err (rms yaw sp - gyro per bin), limits: { lo, hi } }
 */
function curves(w, ctx, metrics) {
    const n = w.n, rate = ctx.rate || w.rate, X = w.extra || {}, H = ctx.header || (w.flight && w.flight.header) || {}, prof = ctx.profile, gov = ctx.govState;
    const nb = Math.max(1, Math.ceil(n / rate / RULE.binS)), bin = (i) => Math.min(nb - 1, Math.floor(i / rate / RULE.binS)), F32 = (k) => new Float32Array(k).fill(NaN);
    const t = Float32Array.from({ length: nb }, (_, k) => w.fromS + (k + 0.5) * RULE.binS);
    const avg = (fn) => { const o = F32(nb), s = new Float64Array(nb), c = new Float64Array(nb); for (let i = 0; i < n; i++) { const v = fn(i); if (isFinite(v)) { s[bin(i)] += v; c[bin(i)]++; } } for (let k = 0; k < nb; k++) if (c[k]) o[k] = s[k] / c[k]; return o; };
    const at = (x) => Uint8Array.from({ length: nb }, (_, k) => x[Math.min(n - 1, Math.round(((k + 0.5) * RULE.binS) * rate))]);

    // governor
    const tg = X.govTarget, mot = X['motor[0]'], coll = X['mixer[3]'] || w.coll, gS = X.govSum, gI = X.govI;
    let governed = false; // a PID governor runs (health_gov G0): govSum or govI non-zero in flight
    if (tg && (gS || gI)) for (let i = 0; i < n && !governed; i++) governed = !!ctx.flying[i] && ((gS && gS[i] !== 0) || (gI && gI[i] !== 0));
    const medHs = {}; { const v = {}; for (let i = 0; i < n; i += 5) if (ctx.flying[i]) (v[prof[i]] = v[prof[i]] || []).push(w.hs[i]); for (const p in v) medHs[p] = median(v[p]); }
    const ref = (i) => governed ? tg[i] : medHs[prof[i]];
    const govOut = { t, hs: avg(i => w.hs[i]), target: tg ? avg(i => tg[i]) : null, errPct: avg(i => { const q = ref(i); return q > 0 ? (w.hs[i] - q) / q * 100 : NaN; }), reference: governed ? 'govTarget' : 'per-profile median headspeed',
        throttle: mot ? avg(i => mot[i] / 10) : null, coll: coll ? avg(i => coll[i]) : null, state: gov ? at(gov) : null, profile: at(prof) };

    // vibration: raw and filtered gyro in flight
    const N = fftSize(rate), K = N / 2 + 1, f = Float32Array.from({ length: K }, (_, k) => k * rate / N), raw = [0, 1, 2].map(a => X[`gyroRAW[${a}]`] || null), hasRaw = raw.every(Boolean), app = appOf(ctx);
    // windows wholly on one profile are also summed per profile (pc: profile changes before each sample)
    const pc = new Int32Array(n + 1); for (let i = 1; i < n; i++) pc[i + 1] = pc[i] + (prof[i] !== prof[i - 1] ? 1 : 0);
    const V = welch(app, hasRaw ? [...raw, ...w.gyro] : w.gyro, hasRaw ? [[0, 3], [1, 4], [2, 5]] : [], ctx.flying, N, null, null, (s) => pc[s + N] - pc[s + 1] === 0 ? prof[s] : null);
    const spectra = (S) => Object.fromEntries(AXES.map((ax, a) => { const amp = (q) => Float32Array.from(q, v => S.windows ? Math.sqrt(v / S.windows) / (N / 4) : NaN);
        return [ax, { f, raw: hasRaw ? amp(S.pw[a]) : null, filt: amp(S.pw[hasRaw ? 3 + a : a]), pass: hasRaw ? Float32Array.from(S.pw[a], (rr, k) => rr > 0 ? Math.min(1.5, Math.hypot(S.re[a][k], S.im[a][k]) / rr) : NaN) : null,
            phaseDeg: hasRaw ? phaseDeg(S.re[a], S.im[a], S.pw[a]) : null }]; }));
    const vib = Object.assign({ filtOnly: !hasRaw, windows: V.windows }, spectra(V));
    const flyHs = []; for (let i = 0; i < n; i += 5) if (ctx.flying[i]) flyHs.push(w.hs[i]);
    const hsMed = median(flyHs), banks = setup.rpmBanks(H, gearOf(ctx));
    const notchesAt = (hs) => Object.fromEntries(AXES.map(ax => [ax, banks[ax].map(b => ({ code: b.code, q: b.q, order: r(b.order, 4), hz: b.order === null || hs === null || hs === undefined ? null : r(b.order * hs / 60, 1), label: `${b.kind} ${b.harmonic}x` }))]));
    vib.rotorHz = Object.fromEntries(Object.entries(medHs).map(([p, v]) => [p, r(v / 60, 2)]));
    vib.notches = notchesAt(hsMed);
    // per profile: a rotor-order line sits at another frequency on each headspeed, so the pooled spectrum splits it into one
    // peak per profile, each scaled by about sqrt(that profile's share of the windows); these compare flights at equal headspeed
    vib.byProfile = {};
    for (const [p, G] of [...V.groups].sort((a, b) => a[0] - b[0])) if (G.windows >= RULE.vibMinWindows)
        vib.byProfile[p] = Object.assign({ windows: G.windows, share: r(G.windows / V.windows, 3), rotorHz: medHs[p] === undefined ? null : r(medHs[p] / 60, 2), notches: notchesAt(medHs[p]) }, spectra(G));
    const lt = (k) => typeof H[k] === 'number' ? setup.LPF_TYPES[H[k]] || String(H[k]) : null, dyn = arr(H.gyro_lowpass_dyn_hz) || [0, 0];
    vib.lpf = [['lpf1', 'gyro_soft_type', 'gyro_lowpass_hz'], ['lpf2', 'gyro_soft2_type', 'gyro_lowpass2_hz']].filter(([, a, b]) => H[a] > 0 && H[b] > 0).map(([name, a, b]) => ({ name, hz: H[b], type: lt(a) }))
        .concat(H.gyro_soft_type > 0 && dyn[0] > 0 ? [{ name: 'lpf1 dynamic min', hz: dyn[0], type: lt('gyro_soft_type') }] : []);
    vib.dynNotch = { enabled: typeof H.features === 'number' ? ((H.features >>> setup.FEATURE_BITS.DYN_NOTCH) & 1) === 1 : null, count: H.dyn_notch_count === undefined ? null : H.dyn_notch_count, q: typeof H.dyn_notch_q === 'number' ? H.dyn_notch_q / 10 : null,
        min: H.dyn_notch_min_hz === undefined ? null : H.dyn_notch_min_hz, max: H.dyn_notch_max_hz === undefined ? null : H.dyn_notch_max_hz };

    // D-term and control spectra in usable flight
    const ok = usableMask(w, ctx, rate), Dcols = [0, 1, 2].map(a => w.D[a] && w.D[a].some(v => v !== 0) ? w.D[a] : null), cols = [], idx = [];
    for (let a = 0; a < 3; a++) { if (Dcols[a]) { idx.push(['d', a, cols.length]); cols.push(Dcols[a]); } idx.push(['u', a, cols.length]); cols.push(w.u[a]); }
    const U = welch(app, cols, [], ok, N), norm = 2 / (rate * lib.fftFor(app, N).power) * 1e6, psd = (c) => Float32Array.from(U.pw[c], v => U.windows ? v * norm / U.windows : NaN);
    const dterm = {}, control = { windows: U.windows };
    for (const [kind, a, c] of idx) { if (kind === 'd') { const m = metrics && metrics.F10 && metrics.F10[AXES[a]], sh = m ? Object.values(m.byProfile).map(q => q.share).filter(v => v !== null) : [];
        dterm[AXES[a]] = { f, psd: psd(c), share30: sh.length ? r(median(sh), 4) : null }; } else control[AXES[a]] = { f, psd: psd(c) }; }
    for (const ax of AXES) if (!dterm[ax]) dterm[ax] = null;

    // tail
    const umin = F32(nb), umax = F32(nb);
    for (let i = 0; i < n; i++) { const k = bin(i), v = w.u[2][i] * 1000; if (!(umin[k] <= v)) umin[k] = v; if (!(umax[k] >= v)) umax[k] = v; }
    const e2 = avg(i => (w.sp[2][i] - w.gyro[2][i]) ** 2), L = limitOf(w.u[2], ok);
    const tail = { t, u: { min: umin, max: umax, mean: avg(i => w.u[2][i] * 1000) }, err: e2.map(Math.sqrt), limits: L ? { lo: L.lo === null ? null : r(L.lo * 1000, 1), hi: L.hi === null ? null : r(L.hi * 1000, 1) } : null };
    return { gov: govOut, vib, dterm, control, tail };
}

module.exports = { EXTRA, RULE, DEFAULT_RULES, normalMask, analyse, judge, curves };
