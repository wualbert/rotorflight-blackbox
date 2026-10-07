'use strict';

/**
 * Checks at each rescue start (new ids):
 *
 *   G19  headspeed at the rescue: from RULE.window.preS before the start to RULE.window.postS after the end, the headspeed
 *        (a running median of RULE.medianS) against the governor target; the largest decrease, the time more than
 *        RULE.below under the target, the time with the throttle at RULE.throttleHigh or more, the governor state changes,
 *        and the overload (a headspeed that decreases with the throttle at its high value before the governor changes)
 *   T15  tail at the rescue: in the first RULE.tail.afterS, the largest |gyro yaw - setpoint yaw| against the largest value
 *        in the time before the rescue, and the time at the tail output limit
 *   D8   PID profile change at a rescue: a change (INFLIGHT_ADJUSTMENT function 2) from RULE.profile.beforeS before to
 *        RULE.profile.afterS after the rescue start, with the two PID profiles and the governor targets
 *   G20  the cause of each FALLBACK (LOST_HEADSPEED before 4.6) of the governor, with or without a rescue (coordinator, round 2):
 *        'overload' when the throttle is at RULE.throttleHigh or more before the change while the headspeed decreases (the G19
 *        overload test); 'signal' when the headspeed signal reads 0, jumps (the glitch rule of governor.c: more than 25 % from its
 *        10 Hz PT2) or is more than 2 x the target, with the throttle under that value; else 'none' (no overload sign). Only
 *        'signal' and 'none' are errors of the RPM signal (check G1); an overload is the throttle limit (L1, rule K22)
 *   curves(w, ctx, metrics)  the rescue periods for the UI
 *
 * Module contract as health_loop.cjs: analyse measures with the parameters in RULE, judge decides with DEFAULT_RULES. These
 * checks use all phases of a flight log: the rescue is not removed (the attitude and governor tracking checks remove it).
 * Every finding has phase (the phase at the rescue start), unit, thin and pidProfile through profile (the PID profile at the
 * rescue start). Times: events t, t1 are index times (w.fromS + i / rate, as every module gives them; evidence.cjs converts
 * them); tS, t1S are frame seconds (the time field: the clock of the viewer, which the texts use). On the Fireball dump
 * 2026-10-05 the two clocks differ by up to 0.1 s at a rescue. Finding texts are ASD-STE100 (docs/STE_GLOSSARY.md); code
 * reads the fields, never the text.
 *
 * Rescue start: the first sample of a run of RESCUE_STATE not 0 (lib rescueAt, EXIT included) or of the RESCUE flight mode
 * (flightModeFlags bits of health_more RULE.modeBits); runs closer than RULE.mergeS are one rescue. Without RESCUE_STATE
 * events, the end is the switch end + health_more RULE.rescueExitS.
 *
 * Firmware facts (rotorflight-firmware release/4.6.0, governor.c): in ACTIVE the governor follows govTarget, which moves to
 * govRequest at a limited rate (slewLimit, lines 904, 973); a PID profile change moves govRequest to the gov_headspeed of the
 * new profile, and govTarget follows it: this is a commanded change, not a decrease. ACTIVE -> FALLBACK when the RPM signal
 * is not good (motorRPMGood, lines 1152-1164: an RPM error or glitch, governor.c 584-606); in FALLBACK the throttle is
 * (I + F) x the fallback ratio (gov_fallback_drop, lines 980-993); FALLBACK -> RECOVERY when the signal is good again, and
 * RECOVERY starts from the current headspeed (govTarget = headspeed, the throttle from the motor constant, lines 995-1010).
 * Thus in RECOVERY, SPOOLUP and BAILOUT the reference is govRequest (else the last ACTIVE target), and govTarget elsewhere.
 * State names: 4.6.0 (fielddefs FLIGHT_LOG_GOVSTATES_RF_4_6) HOLD 5, FALLBACK 6; before 4.6 LOST_THROTTLE 5, LOST_HEADSPEED 6.
 * Rescue (rescue.c 191-204, 300): the rescue flies its own roll, pitch and collective; its yaw setpoint is the setpoint of the
 * pilot (except in FLIP), so the logged yaw setpoint is valid for T15.
 */

const lib = require('./lib.cjs');
const optional = (name) => { try { return require(name); } catch (e) { return null; } };
const GOV = optional('./health_gov.cjs'), LOOP = optional('./health_loop.cjs'), MORE = optional('./health_more.cjs');

const RULE = {
    window: { preS: 2, postS: 2 },        // G19: from 2 s before the start to 2 s after the end
    medianS: 0.2,                         // running median of the headspeed (a rotor cannot change by tens of % in a few ms)
    stepS: 0.005,                         // the step of the running median
    below: 0.10,                          // G19: time with the headspeed more than 10 % under the target
    throttleHigh: 950,                    // motor[0] at 95 % or more (0.1 % units)
    overload: { minS: 0.05, fall: 0.02, lateS: 0.3 }, // a run of the throttle at throttleHigh of minS or more, ending lateS or less before the change (or holding it), with the headspeed error decreasing by fall or more
    tail: { afterS: 1.5, baseS: [2, 0.2], limitTol: 0.005 }, // T15: the first 1.5 s; the time before: from 2 s to 0.2 s before the start; at the limit: within 0.5 % of it
    limit: { samples: 20, band: 0.02, tol: 0.0015 },  // tail output limit from the data as health_loop RULE.limitSamples, limitBand, limitTol (T8)
    profile: { beforeS: 1, afterS: 0.1, targetS: 0.05 }, // D8 window; targetS: govRequest that long after the change
    mergeS: 0.5,
    rescueExitS: (MORE && MORE.RULE && MORE.RULE.rescueExitS) || 0.5,
    modeBits: (MORE && MORE.RULE && MORE.RULE.modeBits) || { rf46: { rescue: [5, 6] }, rf42: { rescue: [5, 6] } },
    maxEvents: 50,
};

const EXTRA = ['motor[0]', 'govTarget', 'govRequest', 'mixer[3]', 'flightModeFlags', 'time'];

// limits of other checks, read from their modules (with a default when a module does not load)
const G3_FLAG = GOV && GOV.DEFAULT_RULES && GOV.DEFAULT_RULES.G3 ? GOV.DEFAULT_RULES.G3.flag : 0.05;
const T6_KICK = LOOP && LOOP.DEFAULT_RULES && LOOP.DEFAULT_RULES.T6 ? LOOP.DEFAULT_RULES.T6.kick : 30;
// The sources are shown to the pilot (quoted): no file name or path
const P = 'pipeline, unvalidated';
const DEFAULT_RULES = {
    sig: 2,
    G19: { flag: G3_FLAG, source: `${P}; the limit of check G3 (${G3_FLAG * 100} % headspeed decrease at a collective increase), and the governor states of the firmware: a change from ACTIVE to FALLBACK, RECOVERY or BAILOUT is a problem`,
        note: 'flag: the largest decrease of the median headspeed from the target, by 2 x the variation of the headspeed signal (one event has no SE); or a governor change from ACTIVE to FALLBACK, RECOVERY or BAILOUT' },
    T15: { kick: T6_KICK, source: `${P}; the yaw kick limit of check T6 (${T6_KICK} deg/s), for the increase from the largest yaw error before the rescue; and the tail output limit of check T8`,
        note: 'flag: (largest |yaw error| in the first 1.5 s) - (largest |yaw error| from 2 s to 0.2 s before) more than kick; or a sample at 0.5 % of a tail output limit or nearer in the first 1.5 s' },
    D8: { source: `${P}; a PID profile change at a rescue start changes the gains, the governor headspeed and the precompensation while the rescue pulls up`,
        note: 'flag: a PID profile change from 1 s before to 0.1 s after a rescue start' },
};
const UNITS = { G19: 'fraction', T15: 'deg/s', D8: 'count', G20: 'count' };
// G20: the window before a change to FALLBACK, and the glitch rule of the firmware (governor.c 584-606, health_gov RULE.firmware)
RULE.fallback = { preS: 2, signalS: 0.5, afterS: 0.05, rpmFilterHz: 10, glitchDelta: 0.25, glitchLimit: 2, zeroMotor: 100, state: 6,
    source: 'firmware 4.6.0 governor.c: FALLBACK (LOST_HEADSPEED before 4.6) when the RPM signal is not good, and the glitch rule of the RPM signal (25 % from its 10 Hz filter, 2 x the target, 0 with the motor on)' };
DEFAULT_RULES.G20 = { source: `${P}; the overload test of check G19 (a headspeed decrease of 2 % or more with the throttle at 95 % or more, 0.3 s or less before the change), and the glitch rule of the firmware`,
    note: 'information: the cause of each FALLBACK. An overload is a possible result of the throttle limit (rule K22); a signal error or no overload sign is an error of the RPM signal (check G1)' };

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const sum = (a) => a.reduce((s, v) => s + v, 0);
const median = (list) => { const s = Float64Array.from(list).sort(); return s.length ? s[s.length >> 1] : null; };
function stat(v) { // mean, standard error across items, n
    const x = v.filter(q => typeof q === 'number' && isFinite(q)), n = x.length;
    if (!n) return { mean: null, se: null, n: 0 };
    const m = sum(x) / n, sd = n > 1 ? Math.sqrt(sum(x.map(q => (q - m) ** 2)) / (n - 1)) : null;
    return { mean: r(m, 4), se: sd === null ? null : r(sd / Math.sqrt(n), 4), n };
}
const maxOf = (x, a, b) => { let m = -Infinity; for (let i = a; i < b; i++) if (x[i] > m) m = x[i]; return m; }; // no spread: a long window has too many values for the call stack
function runs(n, pred) { const out = []; let s = -1; for (let i = 0; i <= n; i++) { const on = i < n && pred(i); if (on && s < 0) s = i; else if (!on && s >= 0) { out.push([s, i]); s = -1; } } return out; }
const STATES46 = ['OFF', 'IDLE', 'SPOOLUP', 'RECOVERY', 'ACTIVE', 'HOLD', 'FALLBACK', 'AUTOROTATION', 'BAILOUT', 'BYPASS']; // health_setup GOV_STATES
const STATES_OLD = ['OFF', 'IDLE', 'SPOOLUP', 'RECOVERY', 'ACTIVE', 'LOST_THROTTLE', 'LOST_HEADSPEED', 'AUTOROTATION', 'BAILOUT', 'BYPASS']; // fielddefs FLIGHT_LOG_GOVSTATES_RF
const version = (h) => String((h && h.firmwareVersion) || '').split('.').map(Number);
const statesOf = (h) => { const v = version(h); return v[0] === 4 && v[1] < 6 ? STATES_OLD : STATES46; };
const modeBits = (h) => { const v = version(h); return v.length >= 2 && v[0] === 4 && v[1] < 3 ? RULE.modeBits.rf42 : RULE.modeBits.rf46; }; // health_more modeBits
const ACTIVE = 4, LEAVE = new Set([3, 6, 8]), RAMP = new Set([2, 3, 8]); // the changes from ACTIVE that the pilot does not command; the states that ramp from the current headspeed
const PHASES = ['idle', 'spoolup', 'ground', 'flight', 'spooldown'];  // health_phase PHASES

// The clocks of a segment: F(i) frame seconds (the time field), t(i) index seconds, at(s) the first sample at frame s or later
function clocks(w, rate) {
    const n = w.n, T = w.extra && w.extra.time && w.extra.time.length === n ? w.extra.time : null;
    const F = (i) => !T ? w.fromS + i / rate : i <= 0 ? w.fromS + i / rate : i >= n - 1 ? w.fromS + (T[n - 1] - T[0]) / 1e6 + (i - n + 1) / rate : w.fromS + (T[i] - T[0]) / 1e6;
    const at = (s) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (F(m) < s) lo = m + 1; else hi = m; } return lo; };
    return { F, at, t: (i) => r(w.fromS + i / rate, 3), frame: !!T };
}

// The rescues of a segment: runs of RESCUE_STATE not 0 or of the RESCUE flight mode, joined when closer than RULE.mergeS.
// [{ i0, i1, byState, bySwitch }] and the source
function rescueRuns(w, ctx, rate) {
    const n = w.n, X = w.extra || {}, H = ctx.header || (w.flight && w.flight.header) || {}, fm = X.flightModeFlags, bits = (modeBits(H).rescue || []).reduce((m, b) => m | (1 << b), 0);
    const st = w.rescueAt || null, hasState = !!st && st.some(v => v), on = new Uint8Array(n);
    for (let i = 0; i < n; i++) on[i] = (hasState && st[i]) || (fm && (fm[i] & bits)) ? 1 : 0;
    if (!hasState && fm) { const ext = Math.round(RULE.rescueExitS * rate); for (const [, e] of runs(n, i => fm[i] & bits)) on.fill(1, e, Math.min(n, e + ext)); }
    const list = [], gap = Math.round(RULE.mergeS * rate);
    for (const [s, e] of runs(n, i => on[i])) { const last = list[list.length - 1]; if (last && s - last.i1 < gap) last.i1 = e; else list.push({ i0: s, i1: e }); }
    for (const q of list) { let a = false, b = false; for (let i = q.i0; i < q.i1; i++) { if (hasState && st[i]) a = true; if (fm && (fm[i] & bits)) b = true; } q.byState = a; q.bySwitch = b; }
    return { list, source: hasState ? (fm ? 'RESCUE_STATE and the RESCUE switch' : 'RESCUE_STATE') : fm ? 'the RESCUE switch' : null, hasState, hasSwitch: !!fm };
}

// output limit of a control column from the data (health_loop.cjs limitOf, the T8 rule)
function limitOf(v, i0, i1) {
    const L = RULE.limit; let lo = Infinity, hi = -Infinity;
    for (let i = i0; i < i1; i++) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
    if (!isFinite(lo)) return { lo: null, hi: null };
    let atLo = 0, atHi = 0, nearLo = 0, nearHi = 0;
    for (let i = i0; i < i1; i++) { const x = v[i]; if (x <= lo + L.tol) atLo++; else if (x <= lo + L.band) nearLo++; if (x >= hi - L.tol) atHi++; else if (x >= hi - L.band) nearHi++; }
    return { lo: atLo >= L.samples && atLo >= nearLo && lo < 0 ? lo : null, hi: atHi >= L.samples && atHi >= nearHi && hi > 0 ? hi : null };
}

// The FALLBACK entries of a segment (G20) and the cause of each: [{ t, tS, profile, kind, overload, signal, throttleHighS, fall, ... }]
function fallbacksOf(w, ctx, rate, C) {
    const n = w.n, X = w.extra || {}, gov = ctx.govState !== undefined ? ctx.govState : w.govStateAt || null, tg = X.govTarget, mot = X['motor[0]'], prof = ctx.profile || w.profileAt, B = RULE.fallback;
    if (!gov || !tg) return [];
    const { F, at, t } = C, hs = w.hs, k = Math.max(1, Math.round(RULE.medianS * rate / 2));
    // the 10 Hz PT2 of the headspeed (governor.c rpm filter), cutoff corrected for two stages
    const pt = new Float64Array(n), q = new Float64Array(n), rc = 1 / (2 * Math.PI * B.rpmFilterHz * 1.553773974), a = (1 / rate) / (rc + 1 / rate);
    for (let i = 0; i < n; i++) { q[i] = i ? q[i - 1] + a * (hs[i] - q[i - 1]) : hs[i]; pt[i] = i ? pt[i - 1] + a * (q[i] - pt[i - 1]) : hs[i]; }
    let lastActive = null; const refAt = new Float64Array(n);
    for (let i = 0; i < n; i++) { if (gov[i] === ACTIVE && tg[i] > 0) lastActive = tg[i]; refAt[i] = RAMP.has(gov[i]) || gov[i] === B.state ? lastActive || tg[i] : tg[i]; }
    const eAt = (i) => { const ref = refAt[i]; return ref > 0 ? (median(hs.subarray(Math.max(0, i - k), Math.min(n, i + k + 1))) - ref) / ref : null; };
    const out = [];
    for (let c = 1; c < n && out.length < RULE.maxEvents; c++) {
        if (gov[c] !== B.state || gov[c - 1] === B.state) continue;
        const a0 = at(F(c) - B.preS), s0 = at(F(c) - B.signalS), ref = refAt[c - 1] || lastActive;
        // signal: a glitch of the RPM signal before the change, with the throttle under its high value. After the change the
        // governor cuts the throttle (FALLBACK), so a glitch there (signalAfter) is information only
        const glitch = (i) => { const kind = hs[i] === 0 && mot && mot[i] > B.zeroMotor ? 'zero' : ref > 0 && Math.abs(hs[i] - pt[i]) > B.glitchDelta * ref ? 'jump' : ref > 0 && hs[i] > B.glitchLimit * ref ? 'limit' : null;
            return kind ? { kind, t: t(i), tS: r(F(i), 3), headspeed: r(hs[i], 0), filtered: r(pt[i], 0), throttle: mot ? mot[i] : null } : null; };
        let sig = null, after = null;
        for (let i = s0; i < c && !sig; i++) if (!(mot && mot[i] >= RULE.throttleHigh)) sig = glitch(i);
        for (let i = c; i <= Math.min(n - 1, c + Math.round(B.afterS * rate)) && !after; i++) after = glitch(i);
        // overload: the last run of the throttle at its high value that ends lateS or less before the change, with the headspeed falling
        let ov = null, high = 0;
        if (mot) { for (let i = a0; i < c; i++) if (mot[i] >= RULE.throttleHigh) high++;
            for (const [s1, e1] of runs(c + 1, (i) => i >= a0 && mot[i] >= RULE.throttleHigh)) {
                if ((e1 - s1) / rate < RULE.overload.minS || F(c) - F(Math.min(e1, c)) > RULE.overload.lateS) continue;
                const e0 = eAt(s1), e2 = eAt(Math.min(e1, c)), fall = e0 !== null && e2 !== null ? e0 - e2 : null;
                if (fall !== null && fall >= RULE.overload.fall) ov = { t: t(s1), tS: r(F(s1), 3), dtS: r(F(s1) - F(c), 3), seconds: r((e1 - s1) / rate, 3), fall: r(fall, 4) }; } }
        const e = eAt(Math.max(0, c - 1));
        out.push({ t: t(c), tS: r(F(c), 3), profile: prof ? prof[c] : null, kind: sig ? 'signal' : ov ? 'overload' : 'none', overload: ov, signal: sig, signalAfter: after, throttleHighS: mot ? r(high / rate, 3) : null,
            throttleMax: mot ? r(maxOf(mot, a0, c + 1), 0) : null, headspeedError: r(e, 4), ref: r(ref, 0), from: gov[c - 1] });
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// analyse
// ---------------------------------------------------------------------------------------------

function analyse(w, ctx = {}) {
    const n = w.n, rate = ctx.rate || w.rate, X = w.extra || {}, H = ctx.header || (w.flight && w.flight.header) || {}, C = clocks(w, rate), { F, at, t } = C;
    const out = { module: 'health_rescue', rule: RULE, rate: r(rate, 2), fromS: r(w.fromS, 3), seconds: r(n / rate, 1), frameClock: C.frame, rescues: [], notes: [] };
    out.fallbacks = fallbacksOf(w, ctx, rate, C);
    const R = rescueRuns(w, ctx, rate); out.source = R.source;
    if (!R.hasState && !R.hasSwitch) { out.skipped = 'The log does not record RESCUE_STATE or flightModeFlags. Thus, the analysis cannot find a rescue.'; return out; }
    const prof = ctx.profile || w.profileAt, gov = ctx.govState !== undefined ? ctx.govState : w.govStateAt || null, names = statesOf(H), code = ctx.phases && ctx.phases.code && ctx.phases.code.length === n ? ctx.phases.code : null;
    const tg = X.govTarget, rq = X.govRequest, mot = X['motor[0]'], coll = X['mixer[3]'] || w.coll;
    const ty = ctx.tailLimits && (typeof ctx.tailLimits.lo === 'number' || typeof ctx.tailLimits.hi === 'number') ? { lo: ctx.tailLimits.lo, hi: ctx.tailLimits.hi, source: 'T8' }
        : Object.assign(limitOf(w.u[2], 0, n), { source: 'data' });
    out.tailLimits = { lo: r(ty.lo, 4), hi: r(ty.hi, 4), source: ty.source };
    // the reference headspeed: govTarget, but govRequest (else the last ACTIVE target) in the states that start from the current headspeed
    let lastActive = null;
    const refAt = new Float64Array(n);
    if (tg) for (let i = 0; i < n; i++) { const g = gov ? gov[i] : ACTIVE; if (g === ACTIVE && tg[i] > 0) lastActive = tg[i];
        refAt[i] = gov && RAMP.has(g) ? (rq && rq[i] > 0 ? rq[i] : lastActive || tg[i]) : tg[i]; }
    for (const q of R.list) {
        const s0 = q.i0, e0 = q.i1, st = F(s0), en = F(e0), ev = { t: t(s0), t1: t(e0), tS: r(st, 3), t1S: r(en, 3), seconds: r(en - st, 3), phase: code ? PHASES[code[s0]] : null, profile: prof ? prof[s0] : null,
            byState: q.byState, bySwitch: q.bySwitch };
        // --- G19
        const a = at(st - RULE.window.preS), b = Math.min(n, at(en + RULE.window.postS));
        if (!tg) ev.G19 = { skipped: 'The log does not have govTarget.' };
        else {
            const k = Math.max(1, Math.round(RULE.medianS * rate / 2)), step = Math.max(1, Math.round(RULE.stepS * rate)), pts = [];
            for (let i = a; i < b; i += step) { const ref = refAt[i]; if (!(ref > 0)) continue;
                const hm = median(w.hs.subarray(Math.max(0, i - k), Math.min(n, i + k + 1))); pts.push({ i, e: (hm - ref) / ref, dev: Math.abs(w.hs[i] - hm) / ref }); }
            const g = { n: pts.length };
            if (pts.length) {
                let worst = pts[0]; for (const p of pts) if (p.e < worst.e) worst = p;
                const first = pts.find(p => p.e < -G3_FLAG) || null; // the onset of the decrease: the first time under the limit of check G3
                let below = 0; for (const p of pts) if (p.e < -RULE.below) below++;
                let high = 0; if (mot) for (let i = a; i < b; i++) if (mot[i] >= RULE.throttleHigh) high++;
                const states = []; if (gov) for (let i = Math.max(1, a); i < b; i++) if (gov[i] !== gov[i - 1]) states.push({ t: t(i), tS: r(F(i), 3), dtS: r(F(i) - st, 3), from: names[gov[i - 1]] || String(gov[i - 1]), to: names[gov[i]] || String(gov[i]), fromCode: gov[i - 1], toCode: gov[i],
                    throttleBefore: mot ? mot[i - 1] : null });
                const leave = states.find(c => c.fromCode === ACTIVE && LEAVE.has(c.toCode)) || null;
                // the lowest throttle out of ACTIVE (FALLBACK, RECOVERY) after the change
                let minThr = null; if (leave && mot) { const i0 = at(leave.tS); for (let i = i0; i < b && gov[i] !== ACTIVE; i++) minThr = minThr === null ? mot[i] : Math.min(minThr, mot[i]); }
                // overload: the last run of the throttle at throttleHigh that starts before the change (or before the worst point)
                const endI = leave ? at(leave.tS) : worst.i, eOf = (i) => { let best = null; for (const p of pts) if (best === null || Math.abs(p.i - i) < Math.abs(best.i - i)) best = p; return best ? best.e : null; };
                let ov = null;
                if (mot) for (const [s, e] of runs(b, i => i >= a && mot[i] >= RULE.throttleHigh)) {
                    if (s >= endI || (e - s) / rate < RULE.overload.minS || F(endI) - F(e) > RULE.overload.lateS) continue;
                    const e1 = Math.min(e, endI), fall = eOf(s) - eOf(e1);
                    if (fall >= RULE.overload.fall) ov = { t: t(s), tS: r(F(s), 3), dtS: r(F(s) - st, 3), seconds: r((e - s) / rate, 3), fall: r(fall, 4), until: leave ? leave.to : null, untilT: leave ? leave.t : null, untilS: leave ? leave.tS : null };
                }
                const devs = pts.map(p => p.dev).sort((x, y) => x - y), noise = devs.length ? 1.4826 * devs[devs.length >> 1] : null; // median absolute change around the median
                Object.assign(g, { value: r(worst.e, 4), onsetT: first ? t(first.i) : null, onsetS: first ? r(F(first.i), 3) : null, worstT: t(worst.i), worstS: r(F(worst.i), 3), worstDtS: r(F(worst.i) - st, 3), ref: r(refAt[worst.i], 0), headspeed: r(median(w.hs.subarray(Math.max(0, worst.i - k), Math.min(n, worst.i + k + 1))), 0),
                    refBefore: r(refAt[Math.max(0, s0 - 1)], 0), belowS: r(below * step / rate, 3), throttleHighS: mot ? r(high / rate, 3) : null, throttleMax: mot ? r(maxOf(mot, a, b), 0) : null,
                    noise: r(noise, 5), states, leave, minThrottleAfter: minThr, overload: ov, collectiveMax: coll ? r(maxOf(coll, a, b), 0) : null, windowS: r(F(b - 1) - F(a), 2) });
            }
            ev.G19 = g;
        }
        // --- T15
        { const i1 = Math.min(n, at(st + RULE.tail.afterS)), b0 = at(st - RULE.tail.baseS[0]), b1 = at(st - RULE.tail.baseS[1]);
            let pk = 0, pkI = s0, base = 0, bs = 0, bn = 0, atLim = 0, tmax = 0;
            for (let i = s0; i < i1; i++) { const e = Math.abs(w.gyro[2][i] - w.sp[2][i]); if (e > pk) { pk = e; pkI = i; } }
            for (let i = b0; i < b1; i++) { const e = Math.abs(w.gyro[2][i] - w.sp[2][i]); if (e > base) base = e; bs += e * e; bn++; }
            const tol = RULE.tail.limitTol, onLim = (v) => (typeof ty.hi === 'number' && v >= ty.hi - tol * Math.abs(ty.hi)) || (typeof ty.lo === 'number' && v <= ty.lo + tol * Math.abs(ty.lo));
            let tmaxV = 0; for (let i = s0; i < i1; i++) { const v = w.u[2][i]; if (Math.abs(v) > tmax) { tmax = Math.abs(v); tmaxV = v; } if (onLim(v)) atLim++; }
            ev.T15 = { value: r(pk - base, 1), peak: r(pk, 1), peakT: t(pkI), peakS: r(F(pkI), 3), peakDtS: r(F(pkI) - st, 3), base: bn ? r(base, 1) : null, baseRms: bn ? r(Math.sqrt(bs / bn), 1) : null, atLimitS: r(atLim / rate, 3),
                tailMaxPermille: r(tmaxV * 1000, 0), limitKnown: typeof ty.lo === 'number' || typeof ty.hi === 'number', afterS: RULE.tail.afterS }; }
        // --- D8 (the PID profile labels: ctx.pidLabels when ctx.profile holds the configurations of js/tuning_worker.js)
        { const p0 = Math.max(1, at(st - RULE.profile.beforeS)), p1 = Math.min(n, at(st + RULE.profile.afterS) + 1), ch = [], req = rq || tg, pidP = ctx.pidLabels || prof;
            if (pidP) for (let i = p0; i < p1; i++) if (pidP[i] !== pidP[i - 1]) { const j = Math.min(n - 1, i + Math.round(RULE.profile.targetS * rate));
                ch.push({ t: t(i), tS: r(F(i), 3), dtS: r(F(i) - st, 3), from: pidP[i - 1], to: pidP[i], fromTarget: req ? r(req[i - 1], 0) : null, toTarget: req ? r(req[j], 0) : null, target: rq ? 'govRequest' : tg ? 'govTarget' : null }); }
            ev.D8 = { changes: ch }; }
        out.rescues.push(ev);
        if (out.rescues.length >= RULE.maxEvents) break;
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------------------------

// Finding texts follow ASD-STE100 (docs/STE_GLOSSARY.md): sentences of 25 words or less, joined by '\n' as paragraphs.
// Code reads the fields of a finding, never its text.
function judge(flights, RULES = DEFAULT_RULES) {
    const F = [], sig = RULES.sig === undefined ? 2 : RULES.sig, rule = (id) => Object.assign({}, DEFAULT_RULES[id], RULES[id] || {});
    const fmt = (v, d = 2) => typeof v === 'number' && isFinite(v) ? (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d) : 'unknown';
    const pc = (v, d = 1) => fmt(typeof v === 'number' ? 100 * v : null, d), many = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`, para = (...p) => p.filter(Boolean).join('\n');
    const at = (ev) => `at ${fmt(ev.tS, 2)} s`, prof = (p) => p > 0 ? `PID profile ${p}` : 'an unknown PID profile';
    const rel = (dt, d = 2) => dt < 0 ? `${fmt(-dt, d)} s before the start` : `${fmt(dt, d)} s after the start`;
    const add = (id, severity, f, profile, o) => F.push(Object.assign({ id, severity, log: f.log, profile: profile === undefined || profile === null ? null : +profile, value: null, se: null, n: null,
        threshold: null, source: rule(id).source || null, unit: UNITS[id], phase: null, thin: false }, o));
    const noSe = (n) => n >= 3 ? '' : `The log has ${many(n, 'rescue')} in this PID profile. A minimum of 3 is necessary for an SE. Thus, the result has no SE.`;
    for (const f of flights) {
        const M = f.metrics; if (!M) continue;
        if (Array.isArray(M.fallbacks) && M.fallbacks.length) { const L = M.fallbacks, ov = L.filter(x => x.kind === 'overload'), sg = L.filter(x => x.kind === 'signal');
            const one = (x) => `At the change to FALLBACK ${at(x)}, ` + (x.kind === 'overload' ? `the throttle is at ${RULE.throttleHigh / 10} % or more for ${fmt(x.overload.seconds, 2)} s, and the headspeed decreases by ${pc(x.overload.fall)} % before the change.`
                    + (x.signalAfter ? ` After the change, the headspeed signal ${x.signalAfter.kind === 'zero' ? 'reads 0' : `reads ${fmt(x.signalAfter.headspeed, 0)} rpm against ${fmt(x.signalAfter.filtered, 0)} rpm`}.` : '')
                : x.kind === 'signal' ? `the headspeed signal ${x.signal.kind === 'zero' ? 'reads 0' : x.signal.kind === 'jump' ? `jumps to ${fmt(x.signal.headspeed, 0)} rpm from ${fmt(x.signal.filtered, 0)} rpm` : `reads ${fmt(x.signal.headspeed, 0)} rpm`} while the throttle is less than ${RULE.throttleHigh / 10} %.`
                : `the throttle is less than ${RULE.throttleHigh / 10} % for most of the time, and the headspeed signal shows no error.`);
            add('G20', 'note', f, null, { value: ov.length, n: L.length, unit: UNITS.G20, overloads: ov.length, signals: sg.length, threshold: { throttleHigh: RULE.throttleHigh, fall: RULE.overload.fall, lateS: RULE.overload.lateS }, phase: null,
                events: L.map(x => ({ t: x.overload ? Math.min(x.overload.t, x.t) : Math.max(f.metrics.fromS, x.t - RULE.fallback.signalS), t1: x.t + RULE.fallback.afterS, start: x.t, tS: x.tS, kind: x.kind, value: x.overload ? x.overload.fall : null,
                    seconds: x.overload ? x.overload.seconds : null, signal: x.signal, signalAfter: x.signalAfter, throttleHighS: x.throttleHighS, throttleMax: x.throttleMax, profile: x.profile, bad: x.kind !== 'overload' })),
                text: para(...L.slice(0, 4).map(one), ov.length === L.length ? `Thus, ${L.length === 1 ? 'the FALLBACK is' : 'each FALLBACK is'} possibly a result of the load at the throttle limit. The RPM signal is possibly correct.`
                    : `${L.length - ov.length} of ${many(L.length, 'FALLBACK')} ${L.length - ov.length === 1 ? 'comes' : 'come'} at a usual load. ${L.length - ov.length === 1 ? 'It is' : 'They are'} possibly an error of the RPM signal (check G1).`) }); }
        if (M.skipped) { for (const id of ['G19', 'T15', 'D8']) add(id, 'skipped', f, null, { text: M.skipped }); continue; }
        if (!M.rescues.length) { for (const id of ['G19', 'T15', 'D8']) add(id, 'skipped', f, null, { n: 0, text: `The log has no rescue (${M.source === 'RESCUE_STATE' ? 'RESCUE_STATE' : M.source || 'no rescue data'}).` }); continue; }
        const groups = new Map(); for (const ev of M.rescues) { const k = ev.profile === null ? 'null' : String(ev.profile); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(ev); }
        for (const [k, list] of groups) {
            const p = k === 'null' ? null : +k, n = list.length;
            // G19
            { const R = rule('G19'), ok = list.filter(ev => ev.G19 && !ev.G19.skipped && typeof ev.G19.value === 'number');
                if (!ok.length) add('G19', 'skipped', f, p, { n, text: (list[0].G19 && list[0].G19.skipped) || 'The log has no headspeed target at the rescue.' });
                else {
                    const passes = (g) => g.value + sig * (g.noise || 0) < -R.flag, bad = (g) => passes(g) || !!g.leave;
                    const worst = ok.slice().sort((x, y) => (bad(y.G19) - bad(x.G19)) || x.G19.value - y.G19.value)[0], g = worst.G19, flag = ok.some(ev => bad(ev.G19)), m = stat(ok.map(ev => ev.G19.value));
                    const dec = `At the rescue ${at(worst)}, the headspeed decreases to ${pc(-g.value)} % less than the target. This is ${fmt(g.headspeed, 0)} rpm against ${fmt(g.ref, 0)} rpm, ${rel(g.worstDtS)}.`;
                    const thr = g.throttleHighS === null ? 'The log does not have motor[0].' : (g.belowS > 0 ? `The headspeed is more than ${RULE.below * 100} % less than the target for ${fmt(g.belowS, 2)} s.` : `The headspeed does not decrease to ${RULE.below * 100} % less than the target.`)
                        + (g.throttleHighS > 0 ? ` The throttle is at ${RULE.throttleHigh / 10} % or more for ${fmt(g.throttleHighS, 2)} s.` : ` The throttle stays less than ${RULE.throttleHigh / 10} %.`);
                    const ov = g.overload ? `From ${rel(g.overload.dtS)}, the headspeed decreases by ${pc(g.overload.fall)} % while the throttle is at ${RULE.throttleHigh / 10} % or more${g.overload.until ? `. Then the governor changes to ${g.overload.until}` : ''}. The motor cannot hold the headspeed at this load.` : '';
                    const chg = (list) => `The governor changes are: ${list.slice(0, 5).map(c => `${c.from} to ${c.to} ${rel(c.dtS)}`).join(', ')}.`;
                    const lv = g.leave ? `The governor changes from ACTIVE to ${g.leave.to} ${rel(g.leave.dtS)}.` + (g.minThrottleAfter !== null && g.leave.throttleBefore !== null && g.minThrottleAfter < g.leave.throttleBefore ? ` Then the throttle decreases from ${fmt(g.leave.throttleBefore / 10, 1)} % to ${fmt(g.minThrottleAfter / 10, 1)} %.` : '')
                        + (g.states.length > 1 ? ` ${chg(g.states)}` : '') : g.states.length ? chg(g.states) : 'The governor stays in ACTIVE.';
                    const unc = `Around its ${RULE.medianS} s median, the headspeed signal changes by ±${pc(g.noise, 2)} %. The decrease must be more than the limit by ${sig} times this value.`;
                    const verdict = !flag ? `This is not more than the limit of ${pc(R.flag, 0)} % of check G3, and the governor does not change from ACTIVE to FALLBACK, RECOVERY or BAILOUT.`
                        : passes(g) && g.leave ? `This is more than the limit of ${pc(R.flag, 0)} % of check G3, and the governor changes from ACTIVE.` : passes(g) ? `This is more than the limit of ${pc(R.flag, 0)} % of check G3.` : 'The governor changes from ACTIVE. This is a problem.';
                    const pool = n >= 3 && m.se !== null ? `The mean of the ${n} rescues is ${pc(-m.mean)} ± ${pc(m.se)} % less than the target.` : noSe(n);
                    add('G19', flag ? 'flag' : 'ok', f, p, { value: g.value, se: null, n, threshold: { flag: R.flag, sig }, noise: g.noise, mean: m.mean, meanSe: n >= 3 ? m.se : null, phase: worst.phase,
                        onsets: ok.filter(ev => bad(ev.G19)).map(ev => ({ t: ev.G19.onsetT !== null ? ev.G19.onsetT : ev.G19.worstT, tS: ev.G19.onsetS !== null ? ev.G19.onsetS : ev.G19.worstS })),
                        belowS: g.belowS, throttleHighS: g.throttleHighS, throttleMax: g.throttleMax, leave: g.leave ? g.leave.to : null, overload: !!g.overload, minThrottleAfter: g.minThrottleAfter,
                        events: ok.map(ev => ({ t: Math.max(f.metrics.fromS, ev.t - RULE.window.preS), t1: ev.t1, start: ev.t, tS: ev.tS, t1S: ev.t1S, value: ev.G19.value, worstS: ev.G19.worstS, belowS: ev.G19.belowS, throttleHighS: ev.G19.throttleHighS,
                            onsetS: ev.G19.onsetS, leave: ev.G19.leave ? ev.G19.leave.to : null, leaveT: ev.G19.leave ? ev.G19.leave.t : null, leaveS: ev.G19.leave ? ev.G19.leave.tS : null, states: ev.G19.states.map(c => ({ tS: c.tS, from: c.from, to: c.to })),
                            overload: ev.G19.overload, phase: ev.phase, profile: ev.profile, bad: bad(ev.G19) })),
                        text: para(`${dec} ${thr}`, `${ov} ${lv}`.trim(), `${verdict} ${unc}`, pool, n > 1 ? `The log has ${many(n, 'rescue')} in ${prof(p)}, and this is the largest decrease.` : '') });
                } }
            // T15
            { const R = rule('T15'), ok = list.filter(ev => ev.T15 && typeof ev.T15.value === 'number'), bad = (q) => q.value > R.kick || q.atLimitS > 0;
                const worst = ok.slice().sort((x, y) => (bad(y.T15) - bad(x.T15)) || y.T15.value - x.T15.value)[0], q = worst.T15, flag = ok.some(ev => bad(ev.T15)), m = stat(ok.map(ev => ev.T15.value));
                const lim = !q.limitKnown ? 'The log does not show a tail output limit. Thus, the check cannot find the time at the limit.'
                    : q.atLimitS > 0 ? `The tail output is at its limit for ${fmt(q.atLimitS, 3)} s in the first ${RULE.tail.afterS} s (largest value ${fmt(q.tailMaxPermille, 0)} ‰).` : `The tail output does not get to its limit in the first ${RULE.tail.afterS} s (largest value ${fmt(q.tailMaxPermille, 0)} ‰).`;
                const verdict = flag ? `${q.value > R.kick ? `The increase is more than the limit of ${fmt(R.kick, 0)} deg/s of check T6.` : `The increase is not more than ${fmt(R.kick, 0)} deg/s.`}${q.atLimitS > 0 ? ' The tail output at its limit is a problem.' : ''}`
                    : `The increase is not more than the limit of ${fmt(R.kick, 0)} deg/s of check T6, and the tail output does not get to its limit.`;
                add('T15', flag ? 'flag' : 'ok', f, p, { value: q.value, se: null, n, axis: 'yaw', threshold: { kick: R.kick }, peak: q.peak, base: q.base, atLimitS: q.atLimitS, tailMaxPermille: q.tailMaxPermille, mean: m.mean, meanSe: n >= 3 ? m.se : null, phase: worst.phase,
                    onsets: ok.filter(ev => bad(ev.T15)).map(ev => ({ t: ev.T15.peakT, tS: ev.T15.peakS })),
                    events: ok.map(ev => ({ t: ev.t, t1: ev.t + RULE.tail.afterS, tS: ev.tS, value: ev.T15.value, rank: ev.T15.value, peak: ev.T15.peak, base: ev.T15.base, peakS: ev.T15.peakS, atLimitS: ev.T15.atLimitS, phase: ev.phase, profile: ev.profile, bad: bad(ev.T15) })),
                    text: para(`At the rescue ${at(worst)}, the largest yaw error in the first ${RULE.tail.afterS} s is ${fmt(q.peak, 0)} deg/s, ${rel(q.peakDtS)}. Before the rescue, the largest yaw error is ${fmt(q.base, 0)} deg/s.`,
                        `${q.value > 0 ? `Thus, the yaw error increases by ${fmt(q.value, 0)} deg/s.` : 'Thus, the yaw error does not increase at the rescue.'} ${lim}`, verdict, n >= 3 && m.se !== null ? `The mean increase of the ${n} rescues is ${fmt(m.mean, 0)} ± ${fmt(m.se, 0)} deg/s.` : noSe(n)) }); }
            // D8
            { const withCh = list.filter(ev => ev.D8 && ev.D8.changes.length), flag = withCh.length > 0, ev0 = withCh[0] || list[0], c = withCh.length ? ev0.D8.changes[ev0.D8.changes.length - 1] : null;
                const one = (ev) => { const x = ev.D8.changes[ev.D8.changes.length - 1];
                    return `At the rescue ${at(ev)}, ${rel(x.dtS, 3)}, the PID profile changes from ${prof(x.from)} to ${prof(x.to)}.` + (x.fromTarget !== null && x.toTarget !== null ? ` The governor headspeed changes from ${fmt(x.fromTarget, 0)} rpm to ${fmt(x.toTarget, 0)} rpm.` : ''); };
                add('D8', flag ? 'flag' : 'ok', f, p, { value: withCh.length, n, threshold: { flag: 1 }, phase: ev0.phase, fromProfile: c ? c.from : null, toProfile: c ? c.to : null, fromTarget: c ? c.fromTarget : null, toTarget: c ? c.toTarget : null,
                    events: list.map(ev => ({ t: Math.max(f.metrics.fromS, ev.t - RULE.profile.beforeS), t1: ev.t + RULE.profile.afterS, start: ev.t, tS: ev.tS, value: ev.D8.changes.length, changes: ev.D8.changes, phase: ev.phase, profile: ev.profile })),
                    text: flag ? para(...withCh.slice(0, 4).map(one), 'The rescue pulls up with the gains, the governor headspeed and the precompensation of a different PID profile. Thus, the transmitter changes the PID profile with the rescue switch.')
                        : `At ${many(n, 'rescue')}, the PID profile does not change from ${RULE.profile.beforeS} s before to ${RULE.profile.afterS} s after the start.` }); }
        }
    }
    return F;
}

// ---------------------------------------------------------------------------------------------
// curves
// ---------------------------------------------------------------------------------------------

// the rescue periods for the UI: [{ t0, t1 }] in frame seconds
function curves(w, ctx, metrics) {
    const m = metrics || analyse(w, ctx);
    return { rescues: (m.rescues || []).map(ev => ({ t0: ev.tS, t1: ev.t1S, profile: ev.profile })) };
}

module.exports = { EXTRA, RULE, DEFAULT_RULES, analyse, judge, curves, rescueRuns, clocks };
if (require.main !== module) return;

// node tools/autotune/health_rescue.cjs <log files...>: the rescues of every log, with the three checks
const app = lib.loadApp();
for (const file of process.argv.slice(2)) {
    const flights = [];
    for (const w of lib.segments(app, file, { whole: true, extra: EXTRA })) {
        if (w.skipped) continue;
        const fl = w.flight, m = analyse(w, { rate: fl.actualRate, header: fl.header });
        if (m.rescues.length) flights.push({ log: fl.log, metrics: m });
    }
    for (const f of judge(flights)) console.log(`#${f.log + 1} ${f.id} ${f.severity} p${f.profile} ${f.value}\n  ${String(f.text).replace(/\n/g, '\n  ')}`);
}
