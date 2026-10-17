'use strict';

/**
 * Flight phases of a log, the log class, and the checks of the ground phases (SPEC2 D13 and its correction; new ids):
 *
 *   phases(w, ctx)      every sample in one phase: idle, spoolup, ground, flight, spooldown; the flights (liftoff to
 *                       touchdown); the log class: a flight log (one flight or more) or a bench run (no flight)
 *   flightMask(w, ctx)  Uint8Array, 1 in the flight phase. The in-app engine ANDs it into ctx.flying for the attitude-loop,
 *                       filter and vibration checks, and leaves bench runs out of the analysis
 *   D7   log class and the seconds of each phase (report only)
 *   G15  spool-up: throttle ramp, duration, headspeed ramp, and the yaw rate on the ground during the ramp
 *   G16  governor change from SPOOLUP to ACTIVE: headspeed overshoot or undershoot against the target, throttle step, time
 *        until the headspeed is stable
 *   G17  motor kicks (with GOVSTATE): a sudden step of motor[0] at IDLE or in the spool-up in one governor state, the rotor
 *        that starts to turn at IDLE with no motor output, a sudden headspeed decrease at a throttle that does not decrease
 *        (ESC sync loss)
 *   G18  headspeed at IDLE with a constant motor output
 *   C15  ground resonance: a roll or pitch oscillation on the skids before liftoff that increases
 *   curves(w, ctx, metrics)  the phase strip for the UI
 *
 * Module contract as health_loop.cjs: analyse measures with the parameters in RULE, judge decides with DEFAULT_RULES. The
 * phase checks use the flight logs only: a bench run gets D7 and no other finding (SPEC2 D13 correction). Every finding
 * has phase, unit and thin; finding texts are ASD-STE100 (docs/STE_GLOSSARY.md); code reads the fields, never the text.
 * Indices are samples of w; times are index times, s from log start (w.fromS + i / rate), as the other modules. The worker
 * converts them to frame seconds. Durations of flights and phases use the time field when the segment has it (the frame
 * clock: on the Gaui X4 #49 the flight is 157.23 s of frame time and 157.43 s of index time).
 *
 * Flights (phases):
 *   - Bound. The AIRBORNE_STATE runs (lib airborneAt), drop-outs shorter than RULE.bound.fillS at the flight headspeed
 *     filled (health_more RULE.ground.fillS), each padded by RULE.bound.padS. On the Gaui X4 II the flag sets 0.1-4.4 s
 *     before liftoff and drops 0.4-1.9 s after touchdown (analysis/gaui-x4/spoolup GROUND-AIRBORNE-FLAG), so it only bounds
 *     the search. A log without the events: the runs at RULE.bound.rpmFrac x the flight rpm or more (data only).
 *   - Liftoff. The collective (setpoint[3], else mixer[3]) at RULE.lift.frac x the hover collective or more for
 *     RULE.lift.holdS: the peer's liftoff rule (analysis/gaui-x4/spoolup sp_common.py liftoff_coll, checked there with the
 *     baro on 4 flights). Hover collective: the median of the positive collective at the flight rpm in the bound.
 *   - Touchdown. The first sudden roll or pitch movement (5-20 Hz, RULE.td.jolt deg/s or more; the Gaui: 106-226 deg/s
 *     that rings at about 10 Hz, ROLL-TOUCHDOWN) in the RULE.td.searchS before the landing bound (the end of the high
 *     collective + RULE.td.afterCollS, the bound end and, without AIRBORNE_STATE, the headspeed under the flight rpm +
 *     RULE.td.afterRpmS). Without it: the earliest of the collective decrease, the throttle cut - RULE.td.cutLateS, the
 *     flag drop - RULE.td.flagLateS.
 *   - In-flight cut (IMP-03). The firmware clears AIRBORNE when the motor stops (airborne.c touchdown(): isSpooledUp() is false in
 *     OFF, IDLE and HOLD, governor.c), also at 5 m. A flag drop RULE.td.cutTieS or less after a governor change to OFF, IDLE, HOLD
 *     or AUTOROTATION, or in a receiver signal loss (lib.cjs RX_LOSS: from the inferred last RC frame to the RX return), or with
 *     failsafePhase > 0, is a cut in flight when no touchdown movement comes before the end of the control and the helicopter
 *     is in the air: for a loss or a failsafe the collective at the liftoff level or more, or the altitude RULE.baro.rise or more
 *     above the level before the liftoff; for a cut by the pilot both (the sanity rule: no in-flight cut on the ground, and no
 *     touchdown while the altitude stays high). Then the flight ends at the earlier of the inferred last RC frame and the cut
 *     (touchdownBy 'in-flight cut'). The ground contact is the first 1-frame step of the roll or pitch gyroRAW (gyroADC without
 *     it) of more than RULE.td.crashFactor x the largest step of the flight, from the end of the flight to RULE.td.cutSearchS
 *     after the cut, back to the first frame of the steep rise (steps of RULE.td.onsetFrac x the largest step of the flight or
 *     more); else the first touchdown movement (RULE.td.jolt; the band-pass is not causal, so it can come early). The phase
 *     'fall' is from the end of the flight to the contact, the phase 'aftercontact' from the contact to the disarm (the governor
 *     OFF, or armed 0): RECOVERY or ACTIVE after a contact is neither a spool-up nor a flight. Check D11 reports each cut.
 *     Crash log 2026-10-15: the last RC frame 68.344 s, HOLD at 68.645 s, the flag drop 1 ms later at about 5 m, the contact
 *     70.4435 s (the gyroRAW roll step 109 deg/s, then 537 deg/s against the largest step of the flight, 121 deg/s)
 *   - A flight is RULE.minFlightS or longer, has the flight rpm or more for half of its time, and has roll and pitch
 *     movement at 0.1-2 Hz of RULE.body.minRms deg/s rms or more; or, for a calm flight, of RULE.body.calmRms or more
 *     with a signal that the sticks and the governor do not set: the touchdown movement or the altitude increase.
 *     Measured on the two Gaui X4 II dumps (20261004_113720, 20261004_233406; 14 different flights, 10 rejected bench
 *     candidates, fix2 cands.cjs): flights 14.75-60.22 deg/s rms (the calmest 10 s of a flight 4.85-16.26), each with
 *     the touchdown movement (42-140 deg/s) and an altitude increase (4.1-28.8 m); bench candidates 0.08-0.17 deg/s rms
 *     with no touchdown movement and 0.13 m or less. AIRBORNE_STATE was set in 10 of 10 bench candidates (0.85-1.0 of
 *     their time), and the collective is at the hover value in each by construction: neither counts as a signal of a
 *     flight. Margins: calmRms 1 is 5.9 x the largest bench value; minRms 3 is 1 / 4.9 of the smallest flight. Two
 *     high-collective runs with RULE.split.minS or more between them, with the body still (RULE.body.groundRms), are two
 *     flights.
 *   - Phases out of the flights: with GOVSTATE events, SPOOLUP and RECOVERY are spoolup; ACTIVE, FALLBACK and BYPASS are
 *     ground; HOLD, AUTOROTATION and BAILOUT are spooldown; OFF and IDLE are idle, except with the rotor still turning
 *     after one of the other phases (spooldown: the rotor slows down after a throttle cut, also after a spool-up
 *     that stops). Without the events: each run of the rotor turning is spoolup until RULE.noGov.top of its top
 *     headspeed, then ground, then spooldown after the last time at that level.
 *
 * Firmware facts (rotorflight-firmware release/4.6.0): governor states OFF 0, IDLE 1, SPOOLUP 2, RECOVERY 3, ACTIVE 4,
 * HOLD 5, FALLBACK 6, AUTOROTATION 7, BAILOUT 8, BYPASS 9 (health_setup GOV_STATES); SPOOLUP ramps the throttle at
 * 10 / gov_spoolup_time per second (governor.c:1603-1609), so gov_spoolup_time = 1000 / (%/s), unit 0.1 s; motor[0] is
 * the throttle in 0.1 %.
 */

const lib = require('./lib.cjs');

const RULE = {
    spinRpm: 300,                                       // the rotor turns (analysis/gaui-x4/spoolup RULE.spin)
    bound: { fillS: 2, padS: 0.5, rpmFrac: 0.5 },       // airborne drop-outs < fillS at the flight rpm are filled; data-only bound: headspeed >= rpmFrac x flight rpm
    lift: { frac: 0.6, holdS: 1, minHover: 50 },        // peer liftoff rule (sp_common.py lift_frac, lift_hold); minHover: a hover collective under this (0.6 deg) is not a hover
    body: { band: [0.1, 2], minRms: 3, calmRms: 1, groundRms: 1.5 },  // roll and pitch movement, deg/s rms; minRms: a flight from the movement alone; calmRms: a calm flight with the touchdown movement or the altitude (margins in the head of this file)
    minFlightS: 2,
    split: { minS: 3 },                                 // s of low collective with the body still between two flights
    td: { band: [5, 20], jolt: 40, searchS: 4, afterCollS: 1, afterRpmS: 2, minAfterLiftS: 0.5, cutLateS: 0.7, flagLateS: 1.0,
        // in-flight cut (IMP-03): cutTieS the flag drop after the governor change (crash log: 1 ms); cutSearchS the contact search after
        // the cut; crashFactor, onsetFrac: the contact step against the largest gyroRAW step of the flight (crash log: 4.4 x, onset 0.9 x);
        // controlS: the collective and the altitude before the end of the control; peakS: the peak rates after the contact; landingS: a cut by
        // the pilot with the ground contact this time or less after it is a landing (health_more RULE.hold.landingS). 2026-10-05 dump, 6 normal
        // landings: the touchdown gyroRAW step is 0.45-1.15 x the largest step of the flight; crash log 2026-10-15: 4.4 x (DEFAULT_RULES.D11)
        cutTieS: 0.01, cutSearchS: 4, crashFactor: 2.0, onsetFrac: 0.5, controlS: 0.2, peakS: 0.2, landingS: 0.5 },
    baro: { rise: 50, withinS: 5, beforeS: 2 },         // altitude (cm) rise in withinS after liftoff that confirms it (peer hop_baro 0.5 m)
    noGov: { top: 0.95, q: 0.9 },                       // without GOVSTATE: the spool-up ends at top x the q quantile of the run's headspeed
    spool: { motor: [100, 450], minS: 0.3, slopeS: 0.05, preS: 1 }, // G15: the throttle ramp is the slope of motor[0] in this range (0.1 %, peer ramp_mot); slopeS: half width of the headspeed slope; preS: the IDLE time before SPOOLUP with the rotor turning that the spool-up includes, at most
    handover: { windowS: 3, band: 0.01, holdS: 0.5, stepS: 0.1, settledS: [1, 3] }, // G16; band as health_gov RULE.step.band; settledS: the reference without govTarget
    kick: { motorS: 0.02, motorStep: 50, zeroMotor: 10, zeroS: 0.05, meanS: 0.1,
        dropS: 0.2, dropFrac: 0.1, holdS: 0.1, motorTol: 10, collS: 0.3, coll: 150, minRpmFrac: 0.3, mergeS: 0.5 }, // G17
    idle: { windowS: 0.5, minMotor: 10, motorTol: 10 },  // G18: windows at IDLE with motor[0] >= minMotor that moves less than motorTol (0.1 %)
    osc: { band: [5, 15], windowS: 0.1, mult: 2, floor: 1, peak: 5, rpmFrac: 0.75, minS: 1, riseWindows: 4 }, // C15: peer liftosc (sp_common.py osc_*): 0.1 s rms of the band; an episode >= max(mult x median, floor) that reaches peak; riseWindows: windows from the start to the peak for a growth (a knock rises in 0.2 s, the Gaui resonance in 0.5-0.8 s)
    binS: 0.1,                                          // curves time step
    maxEvents: 200,
};

// time: the durations on the frame clock; gyroRAW, failsafePhase, armed: the in-flight cut and the ground contact (IMP-03)
const EXTRA = ['mixer[3]', 'motor[0]', 'govTarget', 'altitude', 'time', 'gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]', 'failsafePhase', 'armed'];
const PHASES = ['idle', 'spoolup', 'ground', 'flight', 'spooldown', 'fall', 'aftercontact']; // fall, aftercontact: after an in-flight cut (IMP-03)
const [IDLE, SPOOL, GROUND, FLIGHT, DOWN, FALL, AFTER] = [0, 1, 2, 3, 4, 5, 6];
// OFF, IDLE and HOLD: isSpooledUp() is false (governor.c, the same in 4.6.0 118e912, 58a4bd5cc and 4.7.0 85d7049a9), so airborne.c touchdown()
// clears AIRBORNE at once; AUTOROTATION keeps isSpooledUp() true, but its motor cut is a cut too (IMP-03)
const CUT_STATES = new Set([0, 1, 5, 7]);
const STATES = ['OFF', 'IDLE', 'SPOOLUP', 'RECOVERY', 'ACTIVE', 'HOLD', 'FALLBACK', 'AUTOROTATION', 'BAILOUT', 'BYPASS']; // health_setup GOV_STATES

// The sources are shown to the pilot (quoted, review V3): no file name or path. The methods and the numbers of the Gaui X4 II
// come from analysis/gaui-x4/spoolup (sp_common.py liftoff_coll, ROLL-TOUCHDOWN, BENCH-YAWSPIN, GROUND-LIFTOFF-OSC), and
// their text says that they are results of a different helicopter, not of the logs of the analysis
const P = 'pipeline, unvalidated', GAUI = 'a result on a different helicopter (Gaui X4 II, 2026-10-04), not from the logs of this analysis';
const DEFAULT_RULES = {
    sig: 2,
    D7: { source: `${P}; report only. Liftoff: the collective at liftoff, and touchdown: the roll movement at touchdown, as the spool-up analysis of a different helicopter (Gaui X4 II) found them` },
    G15: { yawFlag: 150, yawNote: 50, source: `${P}; ${GAUI}: the 10 ground events of more than 150 deg/s were yaw turns at throttle ramps of 50-101 per s; at 34-41 per s, 0 of 7`,
        note: 'yawFlag, yawNote: the largest |gyroADC[2]| on the ground during a spool-up, deg/s' },
    G16: { flag: 0.03, settleS: 1, source: `${P}; the limit of check G4 (3 %), and the band of a governor step (1 %)`, note: 'flag: |headspeed - target| / target in RULE.handover.windowS after the change; settleS: time until the error stays in the band' },
    G17: { flag: 1, source: `${P}; a step that the throttle does not command, or a headspeed decrease at a throttle that does not decrease, as the spool-up analysis of a different helicopter (Gaui X4 II) found them`, note: 'flag: number of kicks' },
    G18: { flag: 0.05, minWindows: 3, source: P, note: 'flag: rms headspeed change / mean headspeed at IDLE with a constant motor output, by 2 SE' },
    C15: { peak: 5, minS: 1, source: `${P}; ${GAUI}: 8.46 +- 0.11 Hz, increase 3.34 +- 0.74 /s in 3 of 4 flights`, note: 'flag: an episode of RULE.osc that reaches peak deg/s rms and increases (growth - 2 SE > 0); minS: s of ground running before liftoff' },
    D11: { crashFactor: 2.0, source: `${P}; the firmware clears AIRBORNE_STATE when the motor stops (airborne.c), also in the air. Crash log 2026-10-15: the receiver signal stops, HOLD at 5 m, the ground contact 1.80 s later, with a rate step of 4.4 times the largest step of the flight. The 6 normal landings of the 2026-10-05 dump: 0.45 to 1.15 times`,
        note: 'flag: a ground contact after a motor cut in flight from a receiver signal loss or a failsafe, or a ground contact step (the largest 1-frame roll or pitch step in RULE.td.peakS from the contact) of crashFactor x the largest step of the flight or more; note: a cut by the pilot with a contact that is not that strong, or no contact found' },
};
const UNITS = { D7: 's', G15: 'deg/s', G16: 'fraction', G17: 'count', G18: 'fraction', C15: 'deg/s', D11: 'count' };
const PHASE_OF = { D7: null, G15: 'spoolup', G16: 'spoolup', G17: null, G18: 'idle', C15: 'ground', D11: 'fall' }; // G17: the phase of its first kick
// the phases that a check examines, when it is more than one (catalog.cjs CHECKS[id].phases; js/tuning_worker.js f.phases): D11, the end of
// the flight, the fall and the time after the ground contact
const PHASES_OF = { D11: ['flight', 'fall', 'aftercontact'] };

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (x, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += x[i]; return s / Math.max(1, i1 - i0); };
const median = (list) => { const s = Float64Array.from(list).sort(); return s.length ? s[s.length >> 1] : null; };
function stat(v) { // mean, standard error across items, n
    const x = v.filter(q => typeof q === 'number' && isFinite(q)), n = x.length;
    if (!n) return { mean: null, se: null, n: 0 };
    const m = sum(x) / n, sd = n > 1 ? Math.sqrt(sum(x.map(q => (q - m) ** 2)) / (n - 1)) : null;
    return { mean: r(m, 4), se: sd === null ? null : r(sd / Math.sqrt(n), 4), n };
}
function runs(n, pred, from = 0) { // contiguous runs [s, e) where pred holds
    const out = []; let s = -1;
    for (let i = from; i <= n; i++) { const on = i < n && pred(i); if (on && s < 0) s = i; else if (!on && s >= 0) { out.push([s, i]); s = -1; } }
    return out;
}
function slope(x, s, e, rate, keep) { // OLS slope per second of x over [s, e), samples where keep(v) holds
    let n = 0, mt = 0, mx = 0;
    for (let i = s; i < e; i++) if (!keep || keep(x[i])) { n++; mt += i; mx += x[i]; }
    if (n < 10) return null; mt /= n; mx /= n;
    let sxy = 0, sxx = 0; for (let i = s; i < e; i++) if (!keep || keep(x[i])) { sxy += (i - mt) * (x[i] - mx); sxx += (i - mt) ** 2; }
    return sxx > 0 ? sxy / sxx * rate : null;
}
function lineFit(t, y) { // slope and its standard error (ordinary least squares)
    const n = t.length; if (n < 3) return { value: null, se: null };
    const mt = sum(t) / n, my = sum(y) / n; let sxy = 0, sxx = 0;
    for (let k = 0; k < n; k++) { sxy += (t[k] - mt) * (y[k] - my); sxx += (t[k] - mt) ** 2; }
    if (!(sxx > 0)) return { value: null, se: null };
    const b = sxy / sxx; let ee = 0; for (let k = 0; k < n; k++) ee += (y[k] - my - b * (t[k] - mt)) ** 2;
    return { value: b, se: Math.sqrt(ee / (n - 2) / sxx) };
}
const series = (v) => v.length > 1 ? `${v.slice(0, -1).join(', ')} and ${v[v.length - 1]}` : v.join(''); // "a, b and c"
const many = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;                                    // "1 flight", "2 flights"
const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

const flightRpm = (ctx) => (ctx.flightRule || { headspeed: lib.FLIGHT_RPM }).headspeed;
const govOf = (w, ctx) => ctx.govState !== undefined ? ctx.govState : w.govStateAt || null;

// ---------------------------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------------------------

/**
 * phases(w, ctx) -> { flight, class: 'flight' | 'bench', spans: [{ phase, i0, i1, t0, t1 }], liftoffs: [i], touchdowns: [i],
 *   flights: [{ i0, i1, t0, t1, seconds, liftoffBy, touchdownBy, method, confidence, hover, threshold, bodyRms, calm, agree, jolt, baroRise, airShare, atStart, atEnd, rpmShare }],
 *   rejected: [{ i0, i1, t0, t1, seconds, reason: 'short' | 'movement' | 'headspeed', bodyRms, calm, agree, touchdownBy, jolt, baroRise, airShare, rpmShare, hover, threshold }],
 *   seconds: { idle, spoolup, ground, flight, spooldown },
 *   (calm: bodyRms < RULE.body.minRms; agree: the signals that the sticks and the governor do not set, 'touchdown movement' and 'altitude';
 *   airShare: the part of the time with AIRBORNE_STATE set, null without the events)
 *   hasAirborne, collective, flightRpm, notes } and code (Uint8Array, the phase index of every sample; not enumerable, so not in JSON).
 * liftoffs and touchdowns hold only the ones in the segment: not a flight that starts at its first sample (atStart) or
 * ends at its last (atEnd). ctx: rate, govState, flightRule.headspeed (the flight rpm), airborneEvents (optional: whether
 * the log has AIRBORNE_STATE events; else this segment tells). analyse, flightMask and curves take the result as ctx.phases.
 */
function phases(w, ctx = {}) { return compute(w, ctx, flightRpm(ctx), govOf(w, ctx)); }

function compute(w, ctx, hsMin, gov) {
    const n = w.n, rate = ctx.rate || w.rate, X = w.extra || {}, S = (s) => Math.max(1, Math.round(s * rate)), t = (i) => r(w.fromS + i / rate, 3);
    // durations (flights, phase seconds) on the frame clock when the segment has the time field (us): the viewer's and the
    // worker's seconds; index samples / rate without it. Times (t0, t1) stay index times, as in the other modules
    const T = X.time && X.time.length === n ? X.time : null, clock = (i) => T ? (i < n ? T[i] : T[n - 1] + 1e6 / rate) / 1e6 : i / rate, dur = (a, b) => clock(b) - clock(a);
    const coll = w.coll || X['mixer[3]'] || null, air = w.airborneAt, notes = [];
    const hasAir = ctx.airborneEvents !== undefined ? !!ctx.airborneEvents && !!air : !!air && air.some(v => !v);
    if (!coll) notes.push('The log does not have the collective. Thus, the analysis finds the flights from the movement of the helicopter only.');
    if (!hasAir) notes.push('The log does not record AIRBORNE_STATE. Thus, the analysis finds the flights from the headspeed, the collective and the movement of the helicopter.');
    const B = RULE.body, bp = [0, 1].map(a => lib.bandpass(w.gyro[a], B.band[0], B.band[1], rate));
    const cumBody = new Float64Array(n + 1); for (let i = 0; i < n; i++) cumBody[i + 1] = cumBody[i] + bp[0][i] ** 2 + bp[1][i] ** 2;
    const bodyRms = (s, e) => e > s ? Math.sqrt((cumBody[e] - cumBody[s]) / (e - s)) : 0;
    let joltSig = null; const jolt = () => { if (!joltSig) { const [a, b] = [0, 1].map(k => lib.bandpass(w.gyro[k], RULE.td.band[0], RULE.td.band[1], rate)); joltSig = Float64Array.from(a, (v, i) => Math.max(Math.abs(v), Math.abs(b[i]))); } return joltSig; };
    // the in-flight cut (IMP-03): the receiver signal losses of the segment (lib.segments w.rxLoss) with the sample of the inferred last
    // RC frame, failsafePhase, the gyro for the contact (gyroRAW, else gyroADC), the altitude and the armed field
    const lowerBound = (us) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < us) lo = m + 1; else hi = m; } return lo; }, RX = lib.RX_LOSS || {};
    const rxSpans = (Array.isArray(w.rxLoss) ? w.rxLoss : []).filter(s => s && s.i1 > 0).map(s => Object.assign({}, s, { last: T && typeof s.lastFrameUs === 'number' ? Math.min(s.i0, lowerBound(s.lastFrameUs))
        : Math.max(0, s.i0 - S(s.cause === 'signal' ? RX.lastFrameLeadS || 0.1 : s.cause === 'channel' ? RX.holdS || 0.3 : 0)) }));
    const rawOk = [0, 1, 2].every(k => X[`gyroRAW[${k}]`] && X[`gyroRAW[${k}]`].length === n);
    const env = { T, rx: rxSpans, fsp: X.failsafePhase || null, raw: rawOk ? [0, 1, 2].map(k => X[`gyroRAW[${k}]`]) : w.gyro, rawField: rawOk ? 'gyroRAW' : 'gyroADC', armed: X.armed || null,
        alt: X.altitude && !X.altitude.every(v => v === X.altitude[0]) ? X.altitude : null };

    // bounds of the search
    const bounds = [];
    if (hasAir) {
        const A = Uint8Array.from(air);
        for (const [s, e] of runs(n, i => !A[i])) { let low = false; for (let i = s; i < e && !low; i++) low = w.hs[i] < hsMin;
            if (s > 0 && e < n && e - s < S(RULE.bound.fillS) && !low) A.fill(1, s, e); }
        for (const [s, e] of runs(n, i => A[i])) bounds.push({ b0: Math.max(0, s - S(RULE.bound.padS)), b1: Math.min(n, e + S(RULE.bound.padS)), flagOn: s, flagOff: e < n ? e : null });
    } else for (const [s, e] of runs(n, i => w.hs[i] >= RULE.bound.rpmFrac * hsMin)) bounds.push({ b0: s, b1: e, flagOn: null, flagOff: null });

    // A candidate is a flight when the helicopter moves (RULE.body.minRms), or when it moves less (RULE.body.calmRms or more:
    // a calm hover) and a signal that the sticks and the governor do not set agrees: the sudden movement at the touchdown or
    // the altitude increase after the liftoff. AIRBORNE_STATE, the collective and the governor state follow the sticks and
    // the throttle: on the Gaui X4 II they are set in bench runs too (the bench simulation of the tests), so they are not
    // evidence of a flight (RULE.body). The signals of a rejected candidate are kept, for the D7 text and the margins
    const alt = X.altitude, flat = !alt || alt.every(v => v === alt[0]);
    const baroOf = (fl) => flat || fl.atStart ? null : (() => { let hi = -Infinity; for (let i = fl.i0; i < Math.min(fl.i1, fl.i0 + S(RULE.baro.withinS)); i++) hi = Math.max(hi, alt[i]);
        const m = median(alt.subarray(Math.max(0, fl.i0 - S(RULE.baro.beforeS)), fl.i0 + 1)); return hi - m; })();
    const flights = [], rejected = [];
    for (const bd of bounds) for (const c of candidates(w, bd, coll, hsMin, rate, bodyRms, S)) {
        const fl = touchdown(w, ctx, c, bd, coll, gov, hsMin, rate, S, jolt, hasAir, env);
        const secs = dur(fl.i0, fl.i1), rms = bodyRms(fl.i0, fl.i1);
        let atRpm = 0, airN = 0; for (let i = fl.i0; i < fl.i1; i += 4) { atRpm += w.hs[i] >= hsMin ? 1 : 0; airN += hasAir && air[i] ? 1 : 0; }
        const k4 = Math.max(1, Math.ceil((fl.i1 - fl.i0) / 4)), rpmShare = atRpm / k4, baro = baroOf(fl);
        const byJolt = fl.touchdownBy === 'jolt' || fl.touchdownBy === 'ground contact', byBaro = baro !== null && baro >= RULE.baro.rise, agree = [byJolt ? 'touchdown movement' : null, byBaro ? 'altitude' : null].filter(Boolean);
        const moves = rms >= B.minRms || (rms >= B.calmRms && agree.length > 0);
        const reason = secs < RULE.minFlightS ? 'short' : !moves ? 'movement' : rpmShare < 0.5 ? 'headspeed' : null;
        const base = { i0: fl.i0, i1: fl.i1, t0: t(fl.i0), t1: t(fl.i1), seconds: r(secs, 2), bodyRms: r(rms, 2), calm: rms < B.minRms, agree,
            touchdownBy: fl.touchdownBy, jolt: fl.jolt, baroRise: baro === null ? null : r(baro / 100, 2), airShare: hasAir ? r(airN / k4, 3) : null, rpmShare: r(rpmShare, 3) };
        if (reason) { rejected.push(Object.assign(base, { reason, hover: r(c.hover, 0), threshold: r(c.thr, 0) })); continue; }
        const signals = [hasAir ? 'airborne' : null, c.by, byJolt ? 'touchdown movement' : null, byBaro ? 'altitude' : null].filter(Boolean);
        const score = (hasAir ? 1 : 0) + (byJolt ? 1 : 0) + (byBaro ? 1 : 0);
        flights.push(Object.assign(base, { liftoffBy: c.by, method: signals.join('+'), confidence: score >= 2 ? 'high' : score === 1 ? 'medium' : 'low',
            hover: r(c.hover, 0), threshold: r(c.thr, 0), atStart: fl.atStart, atEnd: fl.atEnd }, fl.cut ? { cut: fl.cut } : {}));
    }
    flights.sort((a, b) => a.i0 - b.i0);
    // after an in-flight cut: the ground contact, and the end of the phase after it (the disarm: the governor OFF or armed 0; without
    // GOVSTATE the rotor under RULE.spinRpm), never into the next flight. After a cut by the pilot with a ground contact that is not a contact
    // step (an autorotation landing: D11 a note), also the motor start (a change from OFF, IDLE, HOLD or AUTOROTATION to SPOOLUP or RECOVERY)
    // or the rotor under RULE.spinRpm: the spool-up and the ground run after it are not 'aftercontact'. After a receiver signal loss or a
    // failsafe, RECOVERY on the ground stays in the phase after the contact
    for (const [k, f] of flights.entries()) if (f.cut) {
        const q = f.cut, next = k + 1 < flights.length ? flights[k + 1].i0 : n, ct = contactOf(w, f.i0, f.i1, q.i, next, rate, S, env, jolt);
        // the disarm: armed 0 when the log records it; else the governor that changes to OFF (or stays OFF after a cut to OFF: the rotor stops)
        const soft = q.by === 'pilot' && !!ct && ct.by !== 'step', restart = (i) => !!gov && i > 0 && (gov[i] === 2 || gov[i] === 3) && CUT_STATES.has(gov[i - 1]);
        const off = (i) => (soft && (restart(i) || w.hs[i] < RULE.spinRpm)) || (env.armed ? !env.armed[i] : gov && gov[q.i] !== 0 ? gov[i] === 0 : w.hs[i] < RULE.spinRpm);
        let end = next; for (let i = ct ? ct.i : q.i; i < next; i++) if (off(i)) { end = i; break; }
        Object.assign(q, { contact: ct, fallEnd: ct ? ct.i : Math.min(end, q.i + S(RULE.td.cutSearchS)), afterEnd: ct ? Math.max(ct.i, end) : null });
    }

    // the phase of every sample
    const code = new Uint8Array(n), spin = (i) => w.hs[i] >= RULE.spinRpm;
    if (gov) for (let i = 0; i < n; i++) { const g = gov[i]; code[i] = g === 2 || g === 3 ? SPOOL : g === 4 || g === 6 || g === 9 ? GROUND : g === 5 || g === 7 || g === 8 ? DOWN : IDLE; }
    else for (const [s, e] of runs(n, spin)) {
        const top = RULE.noGov.top * quantile(w.hs, s, e, RULE.noGov.q); let up = s, dn = e - 1;
        while (up < e && w.hs[up] < top) up++; while (dn > up && w.hs[dn] < top) dn--;
        code.fill(SPOOL, s, up); code.fill(GROUND, up, dn + 1); code.fill(DOWN, dn + 1, e);
    }
    for (const f of flights) code.fill(FLIGHT, f.i0, f.i1);
    for (const f of flights) if (f.cut) { const q = f.cut; for (let i = f.i1; i < q.fallEnd; i++) if (code[i] !== FLIGHT) code[i] = FALL;
        if (q.contact) for (let i = q.contact.i; i < q.afterEnd; i++) if (code[i] !== FLIGHT) code[i] = AFTER; }
    for (let i = 0, last = IDLE; i < n; i++) { // OFF or IDLE with the rotor still turning after ground, flight or spool-down
        if (code[i] === IDLE) { if (spin(i) && last !== IDLE) code[i] = DOWN; else if (!spin(i)) last = IDLE; }
        else last = code[i];
    }
    const spans = [], seconds = Object.fromEntries(PHASES.map(p => [p, 0]));
    for (let s = 0; s < n;) { let e = s + 1; while (e < n && code[e] === code[s]) e++; spans.push({ phase: PHASES[code[s]], i0: s, i1: e, t0: t(s), t1: t(e) }); seconds[PHASES[code[s]]] += dur(s, e); s = e; }
    for (const k of PHASES) seconds[k] = r(seconds[k], 2);
    const res = { flight: flights.length > 0, class: flights.length ? 'flight' : 'bench', spans, liftoffs: flights.filter(f => !f.atStart).map(f => f.i0), touchdowns: flights.filter(f => !f.atEnd).map(f => f.i1),
        flights, rejected, seconds, hasAirborne: hasAir, collective: w.coll ? 'setpoint[3]' : coll ? 'mixer[3]' : null, flightRpm: hsMin, notes };
    Object.defineProperty(res, 'code', { value: code, enumerable: false });
    return res;
}

function quantile(x, s, e, q) { const v = []; for (let i = s; i < e; i += 5) v.push(x[i]); v.sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : 0; }

// the liftoff candidates of one bound: the high-collective runs (or, without the collective, the body movement) grouped
// into flights; { L, E (end of the last high run), hover, thr, by }
function candidates(w, bd, coll, hsMin, rate, bodyRms, S) {
    const { b0, b1 } = bd, out = [];
    if (!coll) { // the movement of the helicopter only: 1 s windows of RULE.body.minRms or more
        const W = S(1), on = []; for (let s = b0; s + W <= b1; s += W) on.push(bodyRms(s, s + W) >= RULE.body.minRms);
        const k0 = on.indexOf(true), k1 = on.lastIndexOf(true);
        if (k0 >= 0) out.push({ L: b0 + k0 * W, E: b0 + (k1 + 1) * W, hover: null, thr: null, by: 'movement', next: null });
        return out;
    }
    const pos = []; let atRpm = 0;
    for (let i = b0; i < b1; i += 2) if (w.hs[i] >= hsMin) { atRpm++; if (coll[i] > 0) pos.push(coll[i]); }
    if (atRpm * 2 < S(RULE.minFlightS) || pos.length * 2 < S(1)) return out;
    const hover = median(pos), thr = RULE.lift.frac * hover;
    if (!(hover >= RULE.lift.minHover)) return out;
    const high = runs(b1, i => coll[i] >= thr, b0).filter(([s, e]) => e - s >= S(RULE.lift.holdS));
    if (!high.length) return out;
    let cur = { L: high[0][0], E: high[0][1] };
    for (let k = 1; k < high.length; k++) {
        const [s, e] = high[k];
        if (s - cur.E >= S(RULE.split.minS) && bodyRms(cur.E, s) <= RULE.body.groundRms) { out.push(cur); cur = { L: s, E: e }; } else cur.E = e;
    }
    out.push(cur);
    return out.map((c, k) => Object.assign(c, { hover, thr, by: 'collective', next: k + 1 < out.length ? out[k + 1].L : null }));
}

// the touchdown of a candidate: the first sudden roll or pitch movement before the landing bound, else the earliest sign
// of the landing; { i0, i1, touchdownBy, jolt, atStart, atEnd }
function touchdown(w, ctx, c, bd, coll, gov, hsMin, rate, S, jolt, hasAir, env = {}) {
    const T = RULE.td, n = w.n, L = c.L, end = c.next !== null ? c.next : bd.b1;
    let hsEnd = L; for (let i = L; i < end; i++) if (w.hs[i] >= hsMin) hsEnd = i + 1;
    const U = Math.min(end, c.E + S(T.afterCollS), hasAir ? end : hsEnd + S(T.afterRpmS)), atStart = L === 0, j0 = Math.max(L + S(T.minAfterLiftS), U - S(T.searchS));
    // an in-flight cut (IMP-03): the touchdown movement is searched only up to the end of the control; a movement after it is the
    // ground contact (contactOf), not a landing
    // a cut by the pilot with the ground contact RULE.td.landingS or less after it is a landing: the touchdown at the contact
    const found = hasAir ? inFlightCut(w, c, bd, coll, gov, rate, S, env, jolt) : null, cut = found && !found.landing ? found : null, J = jolt(); let at = -1;
    for (let i = j0; i < (cut ? Math.min(U, cut.end) : U); i++) if (J[i] >= T.jolt) { at = i; break; }
    if (at >= 0) { let pk = 0; for (let i = at; i < Math.min(U, at + S(0.2)); i++) pk = Math.max(pk, J[i]);
        return { i0: L, i1: at, touchdownBy: 'jolt', jolt: { i: at, t: r(w.fromS + at / rate, 3), value: r(pk, 1) }, atStart, atEnd: false }; }
    if (found && found.landing) return { i0: L, i1: found.landing.i, touchdownBy: 'ground contact', jolt: null, atStart, atEnd: false };
    if (cut) return { i0: L, i1: cut.end, touchdownBy: 'in-flight cut', jolt: null, atStart, atEnd: false, cut };
    const cands = [];
    if (c.E < U && c.E < bd.b1 - S(RULE.bound.padS)) cands.push(['collective', c.E]);
    if (gov) { let cut = -1; for (let i = Math.max(L + 1, 1); i < Math.min(n, U + S(1)); i++) if (gov[i - 1] === 4 && gov[i] !== 4 && gov[i] !== 6 && gov[i] !== 3) cut = i;
        if (cut > L) cands.push(['throttle cut', cut - S(T.cutLateS)]); }
    if (hasAir && bd.flagOff !== null && bd.flagOff <= U + S(RULE.bound.padS)) cands.push(['airborne flag', bd.flagOff - S(T.flagLateS)]);
    const best = cands.filter(([, i]) => i > L).sort((a, b) => a[1] - b[1])[0];
    if (best) return { i0: L, i1: Math.min(best[1], U), touchdownBy: best[0], jolt: null, atStart, atEnd: false };
    return { i0: L, i1: U, touchdownBy: U >= n ? 'log end' : 'bound end', jolt: null, atStart, atEnd: U >= n };
}

// The cut in flight of candidate c in bound bd (head of this file), or null: { i (the motor cut: the governor change; with no motor cut
// in a receiver signal loss, the inferred last RC frame), motorCut (false: the governor stays out of CUT_STATES in the loss, no RC
// control only), end (the end of the flight: the earlier of the inferred last RC frame and the cut), by ('receiver loss' | 'failsafe' |
// 'pilot'), state (the governor state of the cut, null with no motor cut), lastFrame, rxReturn (samples, null when the loss does not end
// in the segment), collective (the mean before the end of the control), baroRise (cm over the level before the liftoff, null without the
// altitude), baroDrop (cm from the end of the flight to the ground contact, null without the altitude), contact (a cut by the pilot only) }.
// { landing: contact } for a cut by the pilot with the ground contact RULE.td.landingS or less after it: a landing (touchdown at the contact).
//   - A receiver signal loss (env.rx) that starts after the liftoff, before the end of the candidate, and not after the flag drop (a loss
//     after the flag drop is on the ground): the helicopter in the air at the inferred last RC frame (the collective at the liftoff level,
//     or the altitude RULE.baro.rise over the level before the liftoff), and the flag drop in the loss or up to RX_LOSS.settleS after the
//     RX return, or a contact step in the loss. With the pilot's option B (rxfail 1500, the AUTOROTATION band) isSpooledUp() stays true:
//     the flag drops only when the sticks come back, after the RX return or never. The cut is the first governor change into CUT_STATES
//     after the last RC frame in the loss (the stage-1 change of the rxfail values), not the flag drop
//   - Else the flag drop: RULE.td.cutTieS or less after a governor change into CUT_STATES (by the pilot), or with failsafePhase > 0
function inFlightCut(w, c, bd, coll, gov, rate, S, env, jolt) {
    const T = RULE.td, L = c.L, n = w.n, stop = c.next !== null ? c.next : bd.b1, RX = lib.RX_LOSS || {}, settle = S(typeof RX.settleS === 'number' ? RX.settleS : 1);
    const f = bd.flagOff !== null && bd.flagOff > L + 1 && (c.next === null || bd.flagOff < c.next) ? bd.flagOff : null; // the flag drop of this candidate (not of the next flight of the bound)
    const control = (end) => { const k = Math.max(L, end - S(T.controlS)), cm = coll ? mean(coll, k, end) : null; let rise = null, at = null;
        if (env.alt) { at = median(env.alt.subarray(k, end)); if (L > 0) { const base = median(env.alt.subarray(Math.max(0, L - S(RULE.baro.beforeS)), L + 1)); if (base !== null && at !== null) rise = at - base; } }
        return { k, cm, high: cm !== null && c.thr !== null && cm >= c.thr, rise, at, up: rise !== null && rise >= RULE.baro.rise }; };
    const stateOf = (i) => gov ? STATES[gov[i]] || String(gov[i]) : null;
    // 1. a receiver signal loss in the flight
    for (const rx of env.rx || []) {
        const end = rx.last; if (!(end > L + 1 && end < stop) || (f !== null && f < end)) continue;
        const a = control(end); if (!(a.high || a.up)) continue;
        // the motor cut before the loss (an autorotation of the pilot that the loss interrupts): the cut of the pilot, with the last RC frame
        let ci = null, before = false; if (gov) { if (CUT_STATES.has(gov[end])) { ci = end; while (ci > L + 1 && gov[ci - 1] === gov[end]) ci--; before = true; }
            else for (let i = end + 1; i < Math.min(n, rx.i1); i++) if (gov[i] !== gov[i - 1] && CUT_STATES.has(gov[i])) { ci = i; break; } }
        const flagIn = f !== null && f <= Math.min(n, rx.i1 + settle), hit = flagIn ? null : contactOf(w, L, end, end, Math.min(n, rx.i1), rate, S, env, jolt, true);
        if (!flagIn && !hit) continue;
        return { i: ci !== null ? ci : end, motorCut: ci !== null, end: Math.max(L + 1, ci !== null ? Math.min(ci, end) : end), by: before ? 'pilot' : 'receiver loss', state: ci !== null ? stateOf(ci) : null, lastFrame: end,
            rxReturn: rx.i1 < n ? rx.i1 : null, collective: r(a.cm, 0), threshold: r(c.thr, 0), baroRise: r(a.rise, 0), baroDrop: null };
    }
    // 2. the flag drop after a governor change (the pilot) or in failsafe
    if (f === null) return null;
    let g = -1; if (gov) for (let i = f; i >= Math.max(L + 1, f - S(T.cutTieS)); i--) if (gov[i] !== gov[i - 1] && CUT_STATES.has(gov[i]) && !CUT_STATES.has(gov[i - 1])) { g = i; break; }
    const fs = !!(env.fsp && env.fsp[f] > 0);
    if (g < 0 && !fs) return null;
    const ci = g >= 0 ? g : f, end = Math.max(L + 1, ci), a = control(end);
    const out = { i: ci, motorCut: true, end, by: fs ? 'failsafe' : 'pilot', state: g >= 0 ? stateOf(ci) : null, lastFrame: null, rxReturn: null, collective: r(a.cm, 0), threshold: r(c.thr, 0), baroRise: r(a.rise, 0), baroDrop: null };
    if (fs) return a.high || a.up ? out : null;
    // a cut by the pilot: the collective at the liftoff level, and an altitude decrease of RULE.baro.rise or more from the end of the flight to
    // the ground contact (the median over 1 s from the contact; with no contact, the minimum in RULE.td.cutSearchS). The level before the
    // liftoff is not used: at the end of a flight the baro drifts (2026-09-26 and 2026-09-29 dumps, 28 HOLDs at the landing: -2.49 to +0.49 m)
    if (!a.high || !env.alt || a.at === null) return null;
    const ct = contactOf(w, L, end, ci, Math.min(n, c.next !== null ? c.next : n), rate, S, env, jolt);
    if (ct && ct.i - ci <= S(T.landingS)) return { landing: ct };
    let after = null; if (ct) after = median(env.alt.subarray(ct.i, Math.min(n, ct.i + S(1)))); else { after = Infinity; for (let i = ci; i < Math.min(n, ci + S(T.cutSearchS)); i++) after = Math.min(after, env.alt[i]); }
    const drop = after !== null && isFinite(after) ? a.at - after : null;
    if (!(drop !== null && drop >= RULE.baro.rise)) return null;
    return Object.assign(out, { baroDrop: r(drop, 0), contact: ct });
}
// The ground contact after the cut q.i of the flight [L, end) (head of this file): { i, by ('step' | 'jolt'), step, flightStep, ratio, field }
// or null. The search ends RULE.td.cutSearchS after the cut, at the next flight (stop) or at the segment end. stepOnly: no jolt
function contactOf(w, L, end, ci, stop, rate, S, env, jolt, stepOnly) {
    const T = RULE.td, x = env.raw || w.gyro, hi = Math.min(stop, w.n, ci + S(T.cutSearchS));
    const step = (i) => Math.max(Math.abs(x[0][i] - x[0][i - 1]), Math.abs(x[1][i] - x[1][i - 1]));
    let big = 0; for (let i = L + 1; i < end; i++) { const d = step(i); if (d > big) big = d; } // the steps in the flight
    if (big > 0) for (let i = Math.max(1, end); i < hi; i++) if (step(i) > T.crashFactor * big) {
        let j = i; while (j - 1 > end && step(j - 1) >= T.onsetFrac * big) j--;
        return { i: j, by: 'step', step: r(step(i), 1), flightStep: r(big, 1), ratio: r(step(i) / big, 2), field: env.rawField || 'gyroADC' }; }
    if (stepOnly) return null;
    const J = jolt(); for (let i = end; i < hi; i++) if (J[i] >= T.jolt) return { i, by: 'jolt', step: null, flightStep: r(big, 1), ratio: null, field: 'gyroADC' };
    return null;
}

// flight phase: 1, else 0
function flightMask(w, ctx = {}, ph) {
    const p = ph || ctx.phases || phases(w, ctx);
    return Uint8Array.from(p.code, (c) => c === FLIGHT ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------
// analyse
// ---------------------------------------------------------------------------------------------

function analyse(w, ctx) {
    const n = w.n, rate = ctx.rate || w.rate, X = w.extra || {}, t = (i) => r(w.fromS + i / rate, 3), S = (s) => Math.max(1, Math.round(s * rate));
    const ph = ctx.phases && ctx.phases.code ? ctx.phases : phases(w, ctx), hsMin = ph.flightRpm, gov = govOf(w, ctx), prof = ctx.profile || w.profileAt;
    const out = { module: 'health_phase', rule: RULE, rate: r(rate, 2), fromS: r(w.fromS, 3), seconds: r(n / rate, 1), class: ph.class,
        phases: { spans: ph.spans.map(({ phase, i0, i1, t0, t1 }) => ({ phase, i0, i1, t0, t1 })), seconds: ph.seconds, flights: ph.flights, rejected: ph.rejected, liftoffs: ph.liftoffs, touchdowns: ph.touchdowns,
            hasAirborne: ph.hasAirborne, collective: ph.collective, flightRpm: hsMin }, notes: ph.notes.slice() };
    out.D7 = { class: ph.class, flights: ph.flights.length, flightS: ph.seconds.flight, seconds: ph.seconds, rejected: ph.rejected.length };
    if (ph.class === 'bench' && !ctx.includeBench) return out; // a bench run: no other check (SPEC2 D13 correction); ctx.includeBench: the checks anyway (validation only)
    const code = ph.code, mot = X['motor[0]'], tg = X.govTarget;
    out.G15 = spoolups(w, ctx, code, gov, mot, prof, rate, t, S);
    out.G16 = handovers(w, ctx, ph, code, gov, mot, tg, prof, rate, t, S);
    out.G17 = kicks(w, ctx, code, gov, mot, prof, hsMin, rate, t, S);
    out.G18 = idleStability(w, code, gov, mot, rate, t, S);
    out.C15 = groundResonance(w, ph, code, gov, prof, hsMin, rate, t, S);
    out.D11 = inFlightCuts(w, ph, gov, prof, rate, t, S);
    return out;
}

// D11 (IMP-03): each cut in flight (head of this file), in frame seconds (the time column; index time without it): cutS (the motor cut;
// with no motor cut, the last RC frame), motorCut, endS (the end of the flight), lastFrameS, returnS (the RX return), contactS, fallS
// (contact - cut), afterReturnS (contact - RX return; < 0: the contact comes before the return), ratio (the largest 1-frame roll or pitch
// step in RULE.td.peakS from the contact / the largest step of the flight: judge DEFAULT_RULES.D11.crashFactor), the peak rates in
// RULE.td.peakS after the contact (gyroRAW when logged), the headspeed at the cut and at the contact, the collective and the altitude before
// the end of the control. { skipped } when the log cannot show a cut: no AIRBORNE_STATE, or no GOVSTATE, receiver fields and failsafePhase
function inFlightCuts(w, ph, gov, prof, rate, t, S) {
    const n = w.n, X = w.extra || {}, T = X.time && X.time.length === n ? X.time : null, F = (i) => i === null || i === undefined ? null : r(T ? w.fromS + (T[Math.min(n - 1, i)] - T[0]) / 1e6 : w.fromS + i / rate, 4);
    if (!ph.hasAirborne) return { skipped: 'The log does not record AIRBORNE_STATE. Thus, check D11 did not operate.', events: [] };
    if (!gov && !Array.isArray(w.rxLoss) && !X.failsafePhase) return { skipped: 'The log does not record GOVSTATE, the receiver signal or failsafePhase. Thus, check D11 did not operate.', events: [] };
    const raw = [0, 1, 2].every(k => X[`gyroRAW[${k}]`] && X[`gyroRAW[${k}]`].length === n) ? [0, 1, 2].map(k => X[`gyroRAW[${k}]`]) : w.gyro, field = raw === w.gyro ? 'gyroADC' : 'gyroRAW';
    const stepAt = (i) => i > 0 ? Math.max(Math.abs(raw[0][i] - raw[0][i - 1]), Math.abs(raw[1][i] - raw[1][i - 1])) : 0;
    // the altitude decrease from the end of the flight to the ground contact (median over RULE.td.controlS before the end, over 1 s from the contact)
    const alt = X.altitude && X.altitude.length === n && !X.altitude.every(v => v === X.altitude[0]) ? X.altitude : null;
    const dropOf = (end, ci) => alt && ci < n ? median(alt.subarray(Math.max(0, end - S(RULE.td.controlS)), Math.max(1, end))) - median(alt.subarray(ci, Math.min(n, ci + S(1)))) : null;
    const events = ph.flights.filter(f => f.cut).map(f => { const q = f.cut, ct = q.contact, peak = {}; let big = 0;
        if (ct) { for (const [a, name] of [[0, 'roll'], [1, 'pitch'], [2, 'yaw']]) { let pk = 0; for (let i = ct.i; i < Math.min(n, ct.i + S(RULE.td.peakS)); i++) pk = Math.max(pk, Math.abs(raw[a][i])); peak[name] = r(pk, 0); }
            for (let i = ct.i; i < Math.min(n, ct.i + S(RULE.td.peakS)); i++) big = Math.max(big, stepAt(i)); }
        const cutS = F(q.i), contactS = ct ? F(ct.i) : null, returnS = F(q.rxReturn);
        return { t: t(q.i), cutS, motorCut: q.motorCut !== false, endS: F(f.i1), lastFrameS: F(q.lastFrame), returnS, by: q.by, state: q.state, contactS, contactBy: ct ? ct.by : null, step: ct ? ct.step : null, flightStep: ct ? ct.flightStep : null,
            ratio: ct && ct.flightStep > 0 ? r(Math.max(big, ct.step || 0) / ct.flightStep, 2) : null, fallS: ct ? r(contactS - cutS, 4) : null, afterReturnS: ct && returnS !== null ? r(contactS - returnS, 4) : null, peak: ct ? peak : null, field,
            headspeedAtCut: r(w.hs[q.i], 0), headspeedAtContact: ct ? r(w.hs[ct.i], 0) : null, collective: q.collective, threshold: q.threshold, baroRise: q.baroRise === null ? null : r(q.baroRise / 100, 2),
            baroDrop: typeof q.baroDrop === 'number' ? r(q.baroDrop / 100, 2) : ct && dropOf(f.i1, ct.i) !== null ? r(dropOf(f.i1, ct.i) / 100, 2) : null,
            afterContactS: ct && q.afterEnd !== null ? r((T ? (T[Math.min(n - 1, q.afterEnd)] - T[ct.i]) / 1e6 : (q.afterEnd - ct.i) / rate), 3) : null, profile: prof ? prof[q.i] : null }; });
    const landed = ph.flights.every(f => !f.cut && f.touchdownBy !== 'log end' && f.touchdownBy !== 'bound end');
    return { events, landed, definition: `a receiver signal loss after the liftoff with the collective at the liftoff level or the altitude ${RULE.baro.rise} cm over the level before the liftoff at the last RC frame, and the flag drop of AIRBORNE_STATE in the loss or ${(lib.RX_LOSS || {}).settleS || 1} s or less after the RX return, or a contact step in the loss (the cut: the first governor change to OFF, IDLE, HOLD or AUTOROTATION after the last RC frame); else a flag drop ${RULE.td.cutTieS} s or less after a governor change to one of these states (the pilot: the collective at the liftoff level and an altitude decrease of ${RULE.baro.rise} cm or more to the ground contact, the contact more than ${RULE.td.landingS} s after the cut), or with failsafePhase > 0; contact: the first 1-frame step of the ${field} roll or pitch rate of more than ${RULE.td.crashFactor} x the largest step of the flight, back to the first frame of steps of ${RULE.td.onsetFrac} x that step or more, in ${RULE.td.cutSearchS} s after the cut, else the first ${RULE.td.band.join('-')} Hz movement of ${RULE.td.jolt} deg/s or more; times are frame seconds` };
}

// G15: each spool-up (SPOOLUP state, or the spoolup phase without GOVSTATE), with the IDLE time before it where the rotor
// already turns (RULE.spool.preS or less); yaw on the ground only
function spoolups(w, ctx, code, gov, mot, prof, rate, t, S) {
    const n = w.n, R = RULE.spool, list = [];
    const ups = gov ? runs(n, i => gov[i] === 2) : runs(n, i => code[i] === SPOOL);
    for (const [s0, e] of ups) {
        let s = s0; const s1 = Math.max(0, s0 - S(R.preS)); while (s > s1 && code[s - 1] === IDLE && w.hs[s - 1] >= RULE.spinRpm) s--;
        if (e - s < S(R.minS)) continue;
        let yaw = 0, yawAt = s, head = 0, air = 0; for (let i = s; i < e; i++) { if (code[i] === FLIGHT) { air++; continue; } const y = Math.abs(w.gyro[2][i]); if (y > yaw) { yaw = y; yawAt = i; } head += w.gyro[2][i] / rate; }
        const thr = mot ? slope(mot, s0, e, rate, (v) => v >= R.motor[0] && v <= R.motor[1]) : null, h = S(R.slopeS);
        let peak = 0; for (let i = s + h; i < e - h; i += 2) peak = Math.max(peak, (w.hs[i + h] - w.hs[i - h]) * rate / (2 * h));
        const to = gov ? (e < n ? STATES[gov[e]] : null) : (e < n ? PHASES[code[e]] : null);
        list.push({ t: t(s), seconds: r((e - s) / rate, 2), to, value: r(yaw, 1), yawAt: t(yawAt), headingDeg: r(head, 0), throttlePctPerS: r(thr === null ? null : thr / 10, 3),
            impliedSpoolupTime: thr > 0 ? Math.round(1000 / (thr / 10)) : null, rpmPerS: r(slope(w.hs, s, e, rate), 1), peakRpmPerS: r(peak, 0), headspeedEnd: r(w.hs[e - 1], 0),
            inFlightS: r(air / rate, 2), profile: prof ? prof[e - 1] : null });
    }
    if (!list.length) return { n: 0, spoolups: [], skipped: gov ? 'The governor is not in SPOOLUP in this log.' : 'The log has no spool-up.' };
    const done = list.filter(q => gov ? q.to === 'ACTIVE' : q.to === 'ground' || q.to === 'flight'), thr = stat(list.map(q => q.throttlePctPerS));
    const worst = list.slice().sort((a, b) => b.value - a.value)[0];
    return { n: list.length, spoolups: list.slice(0, RULE.maxEvents), worst, yawMax: worst.value, throttlePctPerS: thr, impliedSpoolupTime: thr.mean > 0 ? Math.round(1000 / thr.mean) : null,
        seconds: stat(done.map(q => q.seconds)), rpmPerS: stat(list.map(q => q.rpmPerS)), completed: done.length, source: gov ? 'GOVSTATE' : 'headspeed',
        definition: `each SPOOLUP state (without GOVSTATE: the spool-up phase), with the ${R.preS} s or less at IDLE before it where the rotor turns at ${RULE.spinRpm} rpm or more; throttle ramp = OLS slope of motor[0] / 10 (%/s) over the samples of the state with motor[0] in ${R.motor.join('-')}; yaw = largest |gyroADC[2]| out of the flight phase; heading = the integral of gyroADC[2] out of the flight phase; implied gov_spoolup_time = 1000 / (%/s), unit 0.1 s (governor.c:1603-1609)` };
}

// G16: each change from SPOOLUP to ACTIVE
function handovers(w, ctx, ph, code, gov, mot, tg, prof, rate, t, S) {
    const n = w.n, R = RULE.handover;
    if (!gov) return { skipped: 'The log does not record GOVSTATE.', n: 0, events: [] };
    const ev = [];
    for (let h = 1; h < n; h++) {
        if (!(gov[h - 1] === 2 && gov[h] === 4)) continue;
        let e = Math.min(n, h + S(R.windowS)); for (let i = h + 1; i < e; i++) if (gov[i] !== 4) { e = i; break; }
        const lift = ph.liftoffs.find(L => L > h && L < e); if (lift !== undefined) e = lift;
        if (e - h < S(R.holdS)) continue;
        let ref = null;
        if (!tg) { const a = h + S(R.settledS[0]), b = Math.min(e, h + S(R.settledS[1])); if (b - a >= S(R.holdS)) { const v = []; for (let i = a; i < b; i++) v.push(w.hs[i]); ref = median(v); } }
        const err = (i) => { const q = tg ? tg[i] : ref; return q > 0 ? (w.hs[i] - q) / q : NaN; };
        let over = 0, under = 0, overAt = h, underAt = h, valid = 0;
        for (let i = h; i < e; i++) { const v = err(i); if (!isFinite(v)) continue; valid++; if (v > over) { over = v; overAt = i; } if (v < under) { under = v; underAt = i; } }
        if (!valid) continue;
        let settle = null; for (let i = h, k = 0; i < e; i++) { const v = err(i); k = isFinite(v) && Math.abs(v) <= R.band ? k + 1 : 0; if (k >= S(R.holdS)) { settle = (i - k + 1 - h) / rate; break; } }
        const st = S(R.stepS), step = mot && h - st >= 0 ? (mean(mot, h, Math.min(n, h + st)) - mean(mot, h - st, h)) / 10 : null, big = Math.abs(under) > over;
        // a change in flight: the helicopter became airborne before the governor was ACTIVE (the spool-up time is not the cause)
        const fl = code[h] === FLIGHT ? ph.flights.find(f => h >= f.i0 && h < f.i1) : null, lifted = !!fl && !fl.atStart;
        ev.push({ t: t(h), value: r(big ? under : over, 4), overshoot: r(over, 4), overshootAt: t(overAt), undershoot: r(under, 4), undershootAt: t(underAt), throttleStepPct: r(step, 2),
            settleS: r(settle, 3), censored: settle === null, windowS: r((e - h) / rate, 2), target: tg ? r(tg[h], 0) : r(ref, 0), headspeed: r(w.hs[h], 0), inFlight: code[h] === FLIGHT,
            afterLiftoff: code[h] === FLIGHT, liftoffT: lifted ? fl.t0 : null, afterLiftoffS: lifted ? r((h - fl.i0) / rate, 3) : null, profile: prof ? prof[h] : null });
    }
    if (!ev.length) return { skipped: 'The log has no change from SPOOLUP to ACTIVE.', n: 0, events: [] };
    const worst = ev.slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0], peaks = stat(ev.map(q => Math.abs(q.value)));
    return { n: ev.length, events: ev.slice(0, RULE.maxEvents), worst, peakError: peaks, settleMaxS: ev.some(q => q.censored) ? null : r(Math.max(...ev.map(q => q.settleS)), 3),
        censored: ev.filter(q => q.censored).length, afterLiftoffN: ev.filter(q => q.afterLiftoff).length, reference: tg ? 'govTarget' : 'settled headspeed',
        definition: `each change of GOVSTATE from SPOOLUP to ACTIVE; error = (headspeed - ${tg ? 'govTarget' : `the median headspeed ${R.settledS.join('-')} s after the change`}) / that, over ${R.windowS} s or until the state changes or a liftoff; settle = first time the |error| stays at ${R.band * 100} % or less for ${R.holdS} s; throttle step = mean motor[0] in the ${R.stepS} s after minus the ${R.stepS} s before, %` };
}

// G17: motor kicks, with the governor states as the throttle command: a step of motor[0] in one state at IDLE or in the
// spool-up, the rotor that starts to turn at IDLE with no motor output, and a headspeed decrease at a throttle that does
// not decrease (the governor in SPOOLUP, RECOVERY or ACTIVE, the collective steady)
function kicks(w, ctx, code, gov, mot, prof, hsMin, rate, t, S) {
    const n = w.n, K = RULE.kick, ev = [], add = (i, kind, value, unit) => { const last = ev.filter(q => q.kind === kind).pop();
        if (last && i - last.i < S(K.mergeS)) { if (Math.abs(value) > Math.abs(last.value)) last.value = r(value, 1); return; }
        ev.push({ i, t: t(i), kind, value: r(value, 1), unit, phase: PHASES[code[i]], state: STATES[gov[i]], profile: prof ? prof[i] : null }); };
    if (!gov) return { skipped: 'The log does not record GOVSTATE. Thus, the analysis cannot find the difference between a throttle change and a motor kick.', n: 0, events: [] };
    const coll = w.coll || (w.extra || {})['mixer[3]'] || null, spin = (i) => w.hs[i] >= RULE.spinRpm;
    if (mot) {
        const k = S(K.motorS);
        for (let i = 0; i + k < n; i++) { const c = code[i]; if ((c !== IDLE && c !== SPOOL) || code[i + k] !== c || gov[i] !== gov[i + k]) continue;
            const d = mot[i + k] - mot[i]; if (Math.abs(d) >= K.motorStep) add(i, 'motor step', d / 10, '%'); }
        const z = S(K.zeroS);
        for (const [s, e] of runs(n, i => code[i] === IDLE && mot[i] <= K.zeroMotor && spin(i))) if (e - s >= z && (s === 0 || !spin(s - 1))) { let pk = 0; for (let i = s; i < e; i++) pk = Math.max(pk, w.hs[i]); add(s, 'rotor turns with no motor output', pk, 'rpm'); }
    }
    // headspeed means over meanS: a decrease of dropFrac in dropS that stays for holdS
    const M = S(K.meanS), cum = new Float64Array(n + 1); for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + w.hs[i];
    const hm = (i) => { const a = Math.max(0, i), b = Math.min(n, i + M); return (cum[b] - cum[a]) / Math.max(1, b - a); }; // mean over [i, i + M)
    const dk = S(K.dropS), hk = S(K.holdS), ck = S(K.collS), driven = (g) => g === 2 || g === 3 || g === 4;
    for (let i = M; i + dk + hk + M < n; i += 2) {
        if (!driven(gov[i]) || gov[i - M] !== gov[i] || gov[i + dk + hk + M] !== gov[i]) continue;
        const h0 = hm(i - M); if (h0 < K.minRpmFrac * hsMin) continue;
        const h1 = hm(i + dk), h2 = hm(i + dk + hk); if (!(h1 <= (1 - K.dropFrac) * h0 && h2 <= (1 - K.dropFrac) * h0)) continue;
        if (mot && mot[i + dk] - mot[i] < -K.motorTol) continue;
        if (coll) { let lo = Infinity, hi = -Infinity; for (let j = Math.max(0, i - ck); j < i + dk + hk + M; j += 2) { const a = Math.abs(coll[j]); lo = Math.min(lo, a); hi = Math.max(hi, a); } if (hi - lo > K.coll) continue; }
        let j = i; while (j < i + dk + hk && hm(j) > (1 - K.dropFrac / 2) * h0) j++; // the onset: the mean 5 % under the level before
        add(j, 'headspeed decrease', (h2 - h0) / h0 * 100, '%');
    }
    ev.sort((a, b) => a.i - b.i);
    return { n: ev.length, events: ev.slice(0, RULE.maxEvents).map(({ i, ...q }) => q), byKind: Object.fromEntries(['motor step', 'rotor turns with no motor output', 'headspeed decrease'].map(k => [k, ev.filter(q => q.kind === k).length])),
        motorLogged: !!mot,
        definition: `motor step: |motor[0] change| >= ${K.motorStep / 10} % in ${K.motorS} s at IDLE or in the spool-up, in one governor state; rotor turns with no motor output: at IDLE, motor[0] <= ${K.zeroMotor / 10} % and the headspeed >= ${RULE.spinRpm} rpm for ${K.zeroS} s after the rotor was stopped; headspeed decrease: the ${K.meanS} s mean decreases by ${K.dropFrac * 100} % in ${K.dropS} s and stays there ${K.holdS} s, from ${K.minRpmFrac} x flight rpm or more, the governor in one of SPOOLUP, RECOVERY, ACTIVE, motor[0] not ${K.motorTol / 10} % lower, |collective| in a range of ${K.coll} from ${K.collS} s before to the end of the decrease` };
}

// G18: windows at IDLE with a constant motor output and the rotor turning: rms headspeed change / mean headspeed
function idleStability(w, code, gov, mot, rate, t, S) {
    const n = w.n, R = RULE.idle, N = S(R.windowS), win = [];
    if (!mot) return { skipped: 'The log does not have motor[0].', windows: 0 };
    let idleS = 0, idleMotorS = 0; for (let i = 0; i < n; i++) if (code[i] === IDLE) { idleS++; if (mot[i] >= R.minMotor) idleMotorS++; }
    for (const [s, e] of runs(n, i => code[i] === IDLE && mot[i] >= R.minMotor && (!gov || gov[i] === 1))) for (let a = s; a + N <= e; a += N) {
        let lo = Infinity, hi = -Infinity, turn = true; for (let i = a; i < a + N; i++) { lo = Math.min(lo, mot[i]); hi = Math.max(hi, mot[i]); turn = turn && w.hs[i] >= RULE.spinRpm; }
        if (hi - lo >= R.motorTol || !turn) continue;
        const m = mean(w.hs, a, a + N); let v = 0; for (let i = a; i < a + N; i++) v += (w.hs[i] - m) ** 2;
        win.push({ t0: t(a), t1: t(a + N), value: r(Math.sqrt(v / N) / m, 5), headspeed: r(m, 0), motorPct: r(mean(mot, a, a + N) / 10, 1) });
    }
    const st = stat(win.map(q => q.value));
    return { windows: win.length, value: st.mean, se: st.se, idleS: r(idleS / rate, 2), idleMotorS: r(idleMotorS / rate, 2), worst: win.slice().sort((a, b) => b.value - a.value).slice(0, 3),
        headspeed: r(median(win.map(q => q.headspeed)), 0),
        definition: `windows of ${R.windowS} s at IDLE (governor state IDLE when logged) with motor[0] >= ${R.minMotor / 10} % that moves less than ${R.motorTol / 10} %, and the rotor at ${RULE.spinRpm} rpm or more; value = rms(headspeed - mean) / mean, mean and SE over the windows` };
}

// C15: roll and pitch at RULE.osc.band in 0.1 s windows on the ground before each liftoff (the rotor at rpmFrac x flight
// rpm or more, the collective under the liftoff threshold)
function groundResonance(w, ph, code, gov, prof, hsMin, rate, t, S) {
    const n = w.n, O = RULE.osc, N = S(O.windowS), coll = w.coll || (w.extra || {})['mixer[3]'] || null, mask = new Uint8Array(n);
    let prev = 0;
    for (const f of ph.flights) { if (f.atStart) { prev = f.i1; continue; }
        for (let i = prev; i < f.i0; i++) if (code[i] !== FLIGHT && w.hs[i] >= O.rpmFrac * hsMin && (!coll || f.threshold === null || coll[i] < f.threshold)) mask[i] = 1;
        prev = f.i1; }
    let groundN = 0; for (let i = 0; i < n; i++) groundN += mask[i];
    const out = { groundS: r(groundN / rate, 2), episodes: [], definition: `0.1 s rms of gyroADC (roll, pitch) band-passed ${O.band.join('-')} Hz on the ground before each liftoff at ${O.rpmFrac} x flight rpm or more with the collective under the liftoff threshold; episode: adjacent windows >= max(${O.mult} x the median window, ${O.floor} deg/s) that reach ${O.peak} deg/s; growth: OLS slope of ln(rms) from the start to the peak (/s), ${O.riseWindows} windows or more; frequency: the mean of the full cycles` };
    if (groundN < S(O.minS) * 0.5) return out;
    for (const [a, name] of [[0, 'roll'], [1, 'pitch']]) {
        const x = lib.bandpass(w.gyro[a], O.band[0], O.band[1], rate), st = [], rms = [];
        for (const [s, e] of runs(n, i => mask[i])) for (let q = s; q + N <= e; q += N) { let v = 0, m = 0; for (let i = q; i < q + N; i++) m += x[i]; m /= N; for (let i = q; i < q + N; i++) v += (x[i] - m) ** 2; st.push(q); rms.push(Math.sqrt(v / N)); }
        if (!rms.length) continue;
        const base = median(rms), lim = Math.max(O.mult * base, O.floor);
        for (let k = 0; k < rms.length;) {
            if (rms[k] < lim) { k++; continue; }
            let b = k; while (b + 1 < rms.length && rms[b + 1] >= lim && st[b + 1] - st[b] === N) b++;
            const a0 = k; k = b + 1; let p = a0; for (let q = a0; q <= b; q++) if (rms[q] > rms[p]) p = q;
            if (rms[p] < O.peak) continue;
            const i0 = st[a0], i1 = st[b] + N, tt = [], ly = []; for (let q = a0; q <= p; q++) { tt.push((st[q] + N / 2) / rate); ly.push(Math.log(rms[q])); }
            const g = tt.length >= O.riseWindows ? lineFit(tt, ly) : { value: null, se: null }, cyc = cycles(x, i0, i1, rate);
            let cm = 0; if (coll) cm = mean(coll, i0, i1);
            out.episodes.push({ axis: name, t: t(i0), t1: t(i1), seconds: r((i1 - i0) / rate, 2), value: r(rms[p], 2), peakAt: t(st[p]), base: r(base, 2), growth: r(g.value, 3), growthSe: r(g.se, 3),
                hz: cyc.hz, hzSe: cyc.se, cycles: cyc.n, collective: coll ? r(cm, 0) : null, headspeed: r(w.hs[st[p]], 0), headspeedFrac: r(w.hs[st[p]] / hsMin, 3),
                state: gov ? STATES[gov[i0]] : null, phase: PHASES[code[i0]], profile: prof ? prof[i0] : null });
        }
    }
    out.episodes.sort((a, b) => b.value - a.value);
    return out;
}
function cycles(x, i0, i1, rate) { // frequency from the full cycles (upward zero crossings) with a peak of 0.3 x the largest
    let big = 0; for (let i = i0; i < i1; i++) big = Math.max(big, Math.abs(x[i]));
    const z = []; for (let i = i0 + 1; i < i1; i++) if (x[i - 1] < 0 && x[i] >= 0) z.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
    const f = []; for (let k = 0; k + 1 < z.length; k++) { let pk = 0; for (let i = Math.ceil(z[k]); i <= Math.floor(z[k + 1]); i++) pk = Math.max(pk, Math.abs(x[i])); if (pk >= 0.3 * big) f.push(rate / (z[k + 1] - z[k])); }
    const s = stat(f); return { hz: r(s.mean, 2), se: r(s.se, 2), n: f.length };
}

// ---------------------------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------------------------

// Finding texts follow ASD-STE100 (docs/STE_GLOSSARY.md): sentences of 25 words or less, paragraphs of 6 sentences or
// less, joined by '\n'. A note on thin data has thin: true. Code reads the fields of a finding, never its text.
function judge(flights, RULES = DEFAULT_RULES) {
    const F = [], sig = RULES.sig === undefined ? 2 : RULES.sig, rule = (id) => RULES[id] || DEFAULT_RULES[id];
    const fmt = (v, d = 2) => typeof v === 'number' && isFinite(v) ? (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d) : 'unknown'; // no "-0.0"
    const pm = (v, se, d) => typeof se === 'number' && isFinite(se) ? `${fmt(v, d)} ± ${fmt(se, d)}` : fmt(v, d), pct = (v) => typeof v === 'number' ? 100 * v : null;
    const add = (id, severity, f, profile, o) => F.push(Object.assign({ id, severity, log: f.log, profile: profile === undefined || profile === null ? null : +profile, value: null, se: null, n: null,
        threshold: null, source: rule(id).source || null, unit: UNITS[id], phase: PHASE_OF[id], thin: false }, PHASES_OF[id] ? { phases: PHASES_OF[id].slice() } : {}, o));
    const para = (...p) => p.map(q => q && q.trim()).filter(Boolean).join('\n'), NONE = 'The data is not sufficient for a result.';
    const at = (s) => `at ${fmt(s, 1)} s`;

    // one D7 for each log: its segments together
    const byLog = new Map(); for (const f of flights) { if (!f.metrics) continue; if (!byLog.has(f.log)) byLog.set(f.log, []); byLog.get(f.log).push(f); }
    for (const [log, segs] of byLog) {
        const ok = segs.filter(s => !s.metrics.skipped), ms = ok.map(s => s.metrics), fl = ok.flatMap(s => s.metrics.phases.flights.map(q => Object.assign({ segment: s.segment === undefined ? null : s.segment }, q))), rj = ms.flatMap(m => m.phases.rejected);
        const sec = Object.fromEntries(PHASES.map(p => [p, r(sum(ms.map(m => m.phases.seconds[p] || 0)), 2)])), flightS = sec.flight, bench = !fl.length, f0 = segs[0];
        if (!ms.length) { add('D7', 'skipped', f0, null, { text: segs[0].metrics.skipped }); continue; }
        const list = fl.map(q => ({ segment: q.segment, i0: q.i0, i1: q.i1, t0: q.t0, t1: q.t1, seconds: q.seconds, method: q.method, confidence: q.confidence, liftoffBy: q.liftoffBy, touchdownBy: q.touchdownBy, atStart: q.atStart, atEnd: q.atEnd,
            bodyRms: q.bodyRms, calm: !!q.calm, agree: q.agree || [] }));
        const each = fl.slice(0, 6).map((q, k) => { const sg = String(q.method || '').split('+').filter(Boolean).map(x => SIGNAL[x] || x), ag = (q.agree || []).map(x => SIGNAL[x] || x);
            return `Flight ${k + 1} is from ${fmt(q.t0, 1)} s to ${fmt(q.t1, 1)} s (${fmt(q.seconds, 1)} s). ` + (sg.length > 1 ? `For this flight, ${sg.length} signals agree: ${series(sg)}.` : `Only ${sg[0] || 'the collective'} shows this flight.`)
                + (q.calm && ag.length ? ` In this flight, the roll and pitch rates are only ${fmt(q.bodyRms, 2)} deg/s rms. ${cap(series(ag))} ${ag.length > 1 ? 'show' : 'shows'} that the helicopter was airborne.` : ''); });
        const how = fl.length ? `The analysis finds the start of each flight from the collective. It finds the end of each flight from ${series([...new Set(fl.map(q => TD[q.touchdownBy] || q.touchdownBy))])}.` : '';
        const parts = series(PHASES.filter(p => sec[p] > 0 && !CUT_PHASES.includes(p)).map(p => `${fmt(sec[p], 1)} s ${PHASE_WORD[p]}`)),
            cutParts = series(CUT_PHASES.filter(p => sec[p] > 0).map(p => `${fmt(sec[p], 1)} s ${PHASE_WORD[p]}`)); // IMP-03: a sentence of their own (STE length)
        // the periods that are not a flight, for each reason, with the values against the rule (RULE.body, minFlightS, the flight rpm)
        const B = RULE.body, hsMin = ms.length ? ms[0].phases.flightRpm : null, these = (k) => k === 1 ? 'this period is' : 'these periods are';
        const range = (v) => { const x = v.filter(q => typeof q === 'number'); if (!x.length) return 'unknown'; const lo = Math.min(...x), hi = Math.max(...x); return lo === hi ? fmt(lo, 2) : `${fmt(lo, 2)} to ${fmt(hi, 2)}`; };
        const mv = rj.filter(q => q.reason === 'movement'), sh = rj.filter(q => q.reason === 'short'), hs = rj.filter(q => q.reason === 'headspeed');
        const why = para(mv.length ? `The analysis finds ${many(mv.length, 'period')} with the collective at the hover value. In ${mv.length === 1 ? 'this period' : 'these periods'}, the roll and pitch rates are ${range(mv.map(q => q.bodyRms))} deg/s rms. `
                + `A flight has a minimum of ${B.minRms} deg/s rms. With the sudden movement at the landing or an altitude increase, a flight has a minimum of ${B.calmRms} deg/s rms. `
                + (mv.some(q => q.bodyRms >= B.calmRms) ? `The log has no sudden movement at the landing and no altitude increase in ${mv.length === 1 ? 'this period' : 'these periods'}. ` : '') + `Thus, ${these(mv.length)} not a flight.` : '',
            sh.length ? `The analysis finds ${many(sh.length, 'period')} with the collective at the hover value that ${sh.length === 1 ? 'is' : 'are'} shorter than ${RULE.minFlightS} s. Thus, ${these(sh.length)} not a flight.` : '',
            hs.length ? `In ${many(hs.length, 'period')} with the collective at the hover value, the headspeed is less than ${fmt(hsMin, 0)} rpm for half of the time or more. Thus, ${these(hs.length)} not a flight.` : '');
        const air = ms.some(m => m.phases.hasAirborne) ? '' : 'The log does not record AIRBORNE_STATE. Thus, the analysis finds the flights from the headspeed, the collective and the movement of the helicopter.';
        add('D7', 'note', f0, null, { value: flightS, n: fl.length, unit: 's', class: bench ? 'bench' : 'flight', bench, flights: list, flightS, phaseSeconds: sec, rejected: rj.length,
            rejectedBy: { movement: rj.filter(q => q.reason === 'movement').length, short: rj.filter(q => q.reason === 'short').length, headspeed: rj.filter(q => q.reason === 'headspeed').length },
            rejectedRms: rj.length ? [Math.min(...rj.map(q => q.bodyRms)), Math.max(...rj.map(q => q.bodyRms))] : null, threshold: { minRms: RULE.body.minRms, calmRms: RULE.body.calmRms },
            text: bench ? para('This log is a bench run. It has no flight. Thus, the analysis does not use this log.', why, parts ? `The log has ${parts}.` : '', air)
                : para(`This log is a flight log. It has ${many(fl.length, 'flight')}, with a total of ${fmt(flightS, 1)} s in the air.`, ...each, how, parts ? `The log has ${parts}.` + (cutParts ? ` It also has ${cutParts}.` : '') : '', why, air) });
        // D11 (IMP-03): the cuts in flight of a flight log, its segments together
        if (!bench) d11(f0, ms);
    }
    function d11(f0, ms) {
        const ran = ms.filter(m => m.D11 && !m.D11.skipped), sk = ms.find(m => m.D11 && m.D11.skipped);
        if (!ran.length) { if (sk) add('D11', 'skipped', f0, null, { text: sk.D11.skipped }); return; }
        const ev = ran.flatMap(m => m.D11.events || []), landed = ran.every(m => m.D11.landed !== false);
        const R = rule('D11'), D = RULE.td, cf = typeof R.crashFactor === 'number' ? R.crashFactor : DEFAULT_RULES.D11.crashFactor, contacts = ev.filter(e => e.contactS !== null);
        const strong = (e) => typeof e.ratio === 'number' && e.ratio >= cf, bad = contacts.filter(e => e.by !== 'pilot' || strong(e)), rx = ev.some(e => e.by !== 'pilot');
        const base = { n: ev.length, value: contacts.length, threshold: { crashFactor: cf, cutTieS: D.cutTieS, cutSearchS: D.cutSearchS, limit: 0 },
            events: ev.map(e => Object.assign({ tS: e.endS, t1S: e.contactS !== null ? e.contactS : e.cutS, value: e.fallS }, e)) };
        if (!ev.length) return add('D11', 'ok', f0, null, Object.assign(base, { text: 'The analysis finds no motor cut while the helicopter is in the air.' + (landed ? ' Each flight ends with a landing.' : '') }));
        const CUT = { 'receiver loss': 'after the receiver signal stops', failsafe: 'in failsafe', pilot: 'from the throttle switch or the throttle stick' };
        const one = (e, k) => { const lead = ev.length > 1 ? `${e.motorCut ? 'Motor cut' : 'Flight end'} ${k + 1}: at` : 'At', from = e.motorCut ? 'the motor cut' : 'the last RC frame';
            return para((e.motorCut ? `${lead} ${fmt(e.cutS, 2)} s, the governor changes to ${e.state || 'a state with no motor output'} ${CUT[e.by]}, while the helicopter is in the air.`
                    + (e.lastFrameS !== null ? ` The last RC frame comes at approximately ${fmt(e.lastFrameS, 2)} s (check D10).` : '')
                    : `${lead} approximately ${fmt(e.lastFrameS, 2)} s, the last RC frame comes while the helicopter is in the air (check D10). After it, the pilot has no RC control. The governor does not stop the motor.`)
                    + ` Thus, the flight ends at ${fmt(e.endS, 2)} s.`
                    + (e.baroDrop !== null && e.baroDrop !== undefined ? ` From the end of the flight to the ground contact, the altitude decreases by ${fmt(e.baroDrop, 1)} m.`
                        : e.baroRise !== null ? ` Before the end of the flight, the altitude is ${fmt(e.baroRise, 1)} m more than before the liftoff.` : ''),
                e.contactS === null ? `The analysis does not find a ground contact in the ${D.cutSearchS} s after ${from}.`
                    : (e.motorCut ? `The helicopter falls for ${fmt(e.fallS, 2)} s, and it touches the ground at ${fmt(e.contactS, 2)} s.` : `After ${fmt(e.fallS, 2)} s, the helicopter touches the ground at ${fmt(e.contactS, 2)} s.`)
                    + (e.afterReturnS !== null ? ` This is ${fmt(Math.abs(e.afterReturnS), 2)} s ${e.afterReturnS < 0 ? 'before' : 'after'} the receiver signal comes back at ${fmt(e.returnS, 2)} s.` : '')
                    + (e.contactBy === 'step' ? ` At the ground contact, the ${e.field} rate changes by ${fmt(e.step, 0)} deg/s in one frame, ${fmt(e.step / e.flightStep, 1)} times the largest change in the flight.` : ` The ground contact is the first sudden roll or pitch movement after ${from}.`)
                    + ` After the ground contact, the rates get to ${fmt(e.peak.roll, 0)} deg/s roll, ${fmt(e.peak.pitch, 0)} deg/s pitch and ${fmt(e.peak.yaw, 0)} deg/s yaw.`
                    + ` The headspeed ${e.headspeedAtContact < e.headspeedAtCut ? 'decreases' : 'changes'} from ${fmt(e.headspeedAtCut, 0)} rpm at ${from} to ${fmt(e.headspeedAtContact, 0)} rpm at the ground contact.`); };
        const RXDO = 'Examine the receiver, its power supply, its connectors and its antennas. Check D12 gives the response of the firmware when the receiver signal stops.';
        const verdict = bad.length ? `This is a problem. ${bad.some(e => e.by === 'receiver loss') ? `${RXDO} ` : ''}Before the next flight, examine the helicopter for damage.`
            : rx ? RXDO : 'Make sure that the motor cut in flight was a command of the pilot, for example an autorotation.';
        const top = bad[0] || contacts[0] || ev[0], allCut = ev.every(e => e.motorCut);
        add('D11', bad.length ? 'flag' : 'note', f0, top.profile, Object.assign(base, { contactS: top.contactS, cutS: top.cutS, fallS: top.fallS, by: top.by, state: top.state, motorCut: top.motorCut, afterReturnS: top.afterReturnS, peak: top.peak, contactBy: top.contactBy, ratio: top.ratio,
            text: [ev.length > 1 ? (allCut ? `The analysis finds ${many(ev.length, 'motor cut')} while the helicopter is in the air.` : `The analysis finds ${many(ev.length, 'flight')} that end in the air, with a motor cut or with no RC control.`) : '',
                ...ev.slice(0, 3).map(one), verdict].filter(Boolean).join('\n') }));
    }

    for (const f of flights) {
        const M = f.metrics; if (!M || M.skipped || !M.G15) continue; // a bench run has D7 only
        // G15
        { const R = rule('G15'), m = M.G15;
            if (m.skipped) add('G15', 'skipped', f, null, { text: m.skipped });
            else { const wv = m.worst, flag = wv.value > R.yawFlag, note = !flag && wv.value > R.yawNote, lim = flag ? R.yawFlag : R.yawNote;
                const ramp = m.throttlePctPerS.mean !== null ? `The throttle increases at ${pm(m.throttlePctPerS.mean, m.throttlePctPerS.se, m.throttlePctPerS.se !== null && m.throttlePctPerS.se < 0.005 ? 3 : 2)} %/s${m.impliedSpoolupTime ? `. This agrees with a gov_spoolup_time of approximately ${m.impliedSpoolupTime}` : ''}.` : '';
                const dur = m.seconds.mean !== null ? `The spool-up to ACTIVE is ${pm(m.seconds.mean, m.seconds.se, 1)} s long, and the headspeed increases at ${pm(m.rpmPerS.mean, m.rpmPerS.se, 0)} rpm/s.` : '';
                const head = `During the spool-up, the largest yaw rate on the ground is ${fmt(wv.value, 0)} deg/s ${at(wv.yawAt)}. The heading changes by ${fmt(Math.abs(wv.headingDeg), 0)} deg.`;
                const verdict = flag ? `This is more than the limit of ${R.yawFlag} deg/s. The torque of the rotor turns the helicopter on the ground. Increase gov_spoolup_time to make the spool-up slower.`
                    : note ? `This is more than ${R.yawNote} deg/s, but it is not more than ${R.yawFlag} deg/s.` : `This is less than ${R.yawNote} deg/s.`;
                add('G15', flag ? 'flag' : note ? 'note' : 'ok', f, wv.profile, { value: wv.value, n: m.n, threshold: { yawFlag: R.yawFlag, yawNote: R.yawNote, limit: lim }, events: m.spoolups.map(q => ({ t: q.t, value: q.value, seconds: q.seconds })),
                    throttlePctPerS: m.throttlePctPerS, impliedSpoolupTime: m.impliedSpoolupTime, seconds: m.seconds, rpmPerS: m.rpmPerS, headingDeg: wv.headingDeg,
                    text: para(`${head} ${verdict}`, `${ramp} ${dur}`, m.n > 1 ? `The log has ${m.n} spool-ups, and these values are their mean.` : '') }); } }
        // G16
        { const R = rule('G16'), m = M.G16;
            if (m.skipped) add('G16', 'skipped', f, null, { text: m.skipped });
            else { const wv = m.worst, flag = Math.abs(wv.value) >= R.flag || (wv.settleS !== null && wv.settleS > R.settleS) || wv.censored;
                const ref = m.reference === 'govTarget' ? 'the target' : 'the stable headspeed after the change';
                const size = wv.value >= 0 ? `${fmt(pct(wv.value), 2)} % more than ${ref}` : `${fmt(-pct(wv.value), 2)} % less than ${ref}`;
                const band = `a band of ${fmt(RULE.handover.band * 100, 0)} % around ${ref}`, settle = wv.censored ? `The headspeed does not become stable in ${band} in ${fmt(wv.windowS, 1)} s.`
                    : wv.settleS > 0 ? `The headspeed becomes stable in ${band} after ${fmt(wv.settleS, 2)} s.` : `The headspeed stays in ${band} from the change.`;
                // A change after liftoff can coincide with a rotor-load change. Timing alone does not isolate its cause.
                const air = !!wv.afterLiftoff, lifted = air && wv.liftoffT !== null;
                const verdict = !flag ? `This is less than ${fmt(R.flag * 100, 0)} %, and the time is less than ${R.settleS} s.`
                    : air ? `This is more than the limit of ${fmt(R.flag * 100, 0)} % or ${R.settleS} s.` : `This is more than the limit of ${fmt(R.flag * 100, 0)} % or ${R.settleS} s. Examine the spool-up and governor adjustments.`;
                const inAir = !air ? '' : (lifted ? `The change comes ${fmt(wv.afterLiftoffS, 2)} s after the liftoff ${at(wv.liftoffT)}. ` : 'The change comes in flight. ')
                    + 'A change in rotor load can cause part of the error. The time of this change does not identify a governor parameter change.'
                    + (flag ? ' Compare collective, throttle and headspeed around the change to ACTIVE.' : '');
                add('G16', flag ? 'flag' : 'ok', f, wv.profile, { value: wv.value, se: m.n >= 3 ? m.peakError.se : null, n: m.n, threshold: { flag: R.flag, settleS: R.settleS }, overshoot: wv.overshoot, undershoot: wv.undershoot,
                    throttleStepPct: wv.throttleStepPct, settleS: wv.settleS, censored: wv.censored, reference: m.reference, phase: air ? 'flight' : PHASE_OF.G16,
                    afterLiftoff: air, liftoffT: wv.liftoffT, afterLiftoffS: wv.afterLiftoffS, afterLiftoffN: m.afterLiftoffN || 0,
                    events: m.events.map(q => ({ t: q.t, value: q.value, settleS: q.settleS, afterLiftoff: !!q.afterLiftoff })),
                    text: para(`At the change from SPOOLUP to ACTIVE ${at(wv.t)}, the largest headspeed error is ${size}. ${settle} ${verdict}`, inAir,
                        wv.throttleStepPct !== null ? `At the change, the throttle changes by ${fmt(wv.throttleStepPct, 1)} %.` : '',
                        m.n > 1 ? `The log has ${m.n} changes from SPOOLUP to ACTIVE, and this is the largest error.` + (m.afterLiftoffN && !air ? ` ${m.afterLiftoffN} of these changes ${m.afterLiftoffN === 1 ? 'comes' : 'come'} after a liftoff.` : '') : '') }); } }
        // G17
        if (M.G17.skipped) add('G17', 'skipped', f, null, { text: M.G17.skipped });
        else { const R = rule('G17'), m = M.G17, k = m.n, first = m.events[0];
            const KIND = { 'motor step': 'a sudden step of the motor output', 'rotor turns with no motor output': 'the rotor turns with no motor output', 'headspeed decrease': 'a sudden decrease of the headspeed' };
            const list = m.events.slice(0, 6).map(q => `${at(q.t)} (${PHASE_WORD[q.phase]}), ${KIND[q.kind]} of ${fmt(Math.abs(q.value), q.unit === 'rpm' ? 0 : 1)} ${q.unit}.`);
            const verdict = k >= R.flag ? `Examine the ESC, the motor wires and the motor timing. A sudden decrease of the headspeed at a constant throttle can be a sync loss of the ESC.` : '';
            add('G17', k >= R.flag ? 'flag' : 'ok', f, first ? first.profile : null, { value: k, n: k, threshold: { flag: R.flag }, phase: first ? first.phase : null, byKind: m.byKind, events: m.events.map(q => ({ t: q.t, value: q.value, kind: q.kind, phase: q.phase })),
                text: k ? para(`The log has ${many(k, 'motor kick')} that the throttle does not command. ${verdict}`, ...list.map((q, j) => `Kick ${j + 1} is ${q}`))
                    : 'The log has no motor kick. The motor output and the headspeed change only when the throttle changes.' + (m.motorLogged ? '' : ' The log does not have motor[0]. Thus, the analysis examines only the headspeed.') }); }
        // G18
        { const R = rule('G18'), m = M.G18;
            if (m.skipped) add('G18', 'skipped', f, null, { text: m.skipped });
            else if (!m.windows) add('G18', 'skipped', f, null, { n: 0, text: m.idleMotorS > 0 ? 'At IDLE, the motor output is not constant while the rotor turns. Thus, the analysis cannot examine the headspeed at IDLE.' : 'At IDLE, the motor output is 0. Thus, the rotor does not turn at IDLE, and there is no headspeed to examine.' });
            else if (m.windows < R.minWindows || m.se === null) add('G18', 'note', f, null, { value: m.value, se: m.se, n: m.windows, thin: true, threshold: { flag: R.flag },
                text: para(`${NONE} The number of periods of ${RULE.idle.windowS} s at IDLE with a constant motor output is ${m.windows}. A minimum of ${R.minWindows} is necessary.`, `At IDLE, the rms change of the headspeed is ${fmt(pct(m.value), 2)} % of ${fmt(m.headspeed, 0)} rpm.`) });
            else { const flag = m.value - sig * m.se > R.flag;
                add('G18', flag ? 'flag' : 'ok', f, null, { value: m.value, se: m.se, n: m.windows, threshold: { flag: R.flag }, headspeed: m.headspeed,
                    text: para(`At IDLE, the rms change of the headspeed is ${pm(pct(m.value), pct(m.se), 2)} % of ${fmt(m.headspeed, 0)} rpm (${many(m.windows, 'period')} of ${RULE.idle.windowS} s at a constant motor output).`,
                        flag ? `This is more than ${fmt(R.flag * 100, 0)} % by more than ${sig} SE. The headspeed at IDLE is not stable. Examine the ESC and the idle throttle adjustment.` : `This is not more than ${fmt(R.flag * 100, 0)} % by more than ${sig} SE.`) }); } }
        // C15
        { const R = rule('C15'), m = M.C15;
            if (m.groundS < R.minS) add('C15', 'note', f, null, { value: null, n: 0, thin: true, threshold: { peak: R.peak, limit: R.peak },
                text: `${NONE} Before the helicopter is airborne, the log has ${fmt(m.groundS, 1)} s on the ground at ${fmt(RULE.osc.rpmFrac * 100, 0)} % of the flight headspeed or more. A minimum of ${R.minS} s is necessary.` });
            else { const ep = m.episodes, grows = (e) => typeof e.growth === 'number' && typeof e.growthSe === 'number' && e.growth - sig * e.growthSe > 0;
                const bad = ep.filter(e => e.value >= R.peak && grows(e)), top = bad[0] || ep[0];
                const one = (e) => `At ${fmt(e.t, 1)} s, the ${e.axis} rate has an oscillation${e.hz !== null ? ` at ${pm(e.hz, e.hzSe, 1)} Hz` : ''} of ${fmt(e.value, 1)} deg/s rms on the skids.` +
                    (e.growth !== null ? ` The oscillation ${grows(e) ? 'increases' : 'does not increase'} (${pm(e.growth, e.growthSe, 2)} /s).` : '') +
                    ` The collective is ${e.collective === null ? 'unknown' : fmt(e.collective, 0)} and the headspeed is ${fmt(e.headspeed, 0)} rpm${e.state ? `, with the governor in ${e.state}` : ''}.`;
                const verdict = bad.length ? 'Ground resonance is a possible cause. This check does not identify a gain change. Examine the dampers of the main rotor and the skids.'
                    : ep.length ? `The measured oscillation does not increase by more than ${sig} SE. This check does not identify its cause.` : '';
                add('C15', bad.length ? 'flag' : ep.length ? 'note' : 'ok', f, top ? top.profile : null, { value: top ? top.value : 0, n: ep.length, axis: top ? top.axis : null, threshold: { peak: R.peak, sig, limit: R.peak }, hz: top ? top.hz : null, hzSe: top ? top.hzSe : null,
                    growth: top ? top.growth : null, growthSe: top ? top.growthSe : null, collective: top ? top.collective : null, headspeed: top ? top.headspeed : null, groundS: m.groundS,
                    events: ep.map(e => ({ t: e.t, value: e.value, axis: e.axis, seconds: e.seconds, hz: e.hz, growth: e.growth })),
                    text: ep.length ? para(`Before the helicopter is airborne, the analysis finds ${many(ep.length, 'oscillation')} of ${R.peak} deg/s rms or more in ${fmt(m.groundS, 1)} s on the ground.`, ...ep.slice(0, 3).map(one), verdict)
                        : `Before the helicopter is airborne, the roll and pitch rates have no oscillation of ${R.peak} deg/s rms or more on the skids (${fmt(m.groundS, 1)} s on the ground).` }); } }
    }
    return F;
}
// the words of the texts: the signals of a flight (its method), how its end was found, the phases (catalog.cjs PHASE_AT)
const SIGNAL = { airborne: 'AIRBORNE_STATE', collective: 'the collective', 'touchdown movement': 'the sudden movement at the landing', altitude: 'the altitude', movement: 'the movement of the helicopter' };
const TD = { jolt: 'the sudden roll or pitch movement at the landing', collective: 'the decrease of the collective', 'throttle cut': 'the throttle cut', 'airborne flag': 'AIRBORNE_STATE', 'bound end': 'the end of the high collective', 'log end': 'the end of the log',
    'in-flight cut': 'the motor cut in flight or the last RC frame before it', 'ground contact': 'the ground contact at the landing' };
const CUT_PHASES = ['fall', 'aftercontact'];
const PHASE_WORD = { idle: 'at IDLE', spoolup: 'during the spool-up', ground: 'on the ground', flight: 'in flight', spooldown: 'during the spool-down', fall: 'from the end of the flight to the ground contact', aftercontact: 'after the ground contact' };

// ---------------------------------------------------------------------------------------------
// curves
// ---------------------------------------------------------------------------------------------

/**
 * Plot series for the UI (JSON-safe, typed arrays): t (bin centres, s from log start, RULE.binS steps) and phase (the index
 * into names of the phase at the bin centre), with the flights.
 */
function curves(w, ctx, metrics) {
    const n = w.n, rate = ctx.rate || w.rate, ph = ctx.phases && ctx.phases.code ? ctx.phases : phases(w, ctx), nb = Math.max(1, Math.ceil(n / rate / RULE.binS));
    const t = Float32Array.from({ length: nb }, (_, k) => w.fromS + (k + 0.5) * RULE.binS), phase = Uint8Array.from({ length: nb }, (_, k) => ph.code[Math.min(n - 1, Math.round((k + 0.5) * RULE.binS * rate))]);
    return { t, phase, names: PHASES, flights: ph.flights.map(f => ({ t0: f.t0, t1: f.t1 })), class: ph.class };
}

module.exports = { EXTRA, RULE, DEFAULT_RULES, PHASES, PHASES_OF, phases, flightMask, analyse, judge, curves };
if (require.main !== module) return;

// node tools/autotune/health_phase.cjs <log files...>: the class, phases and flights of every log
const app = lib.loadApp();
for (const file of process.argv.slice(2)) for (const w of lib.segments(app, file, { whole: true, extra: EXTRA })) {
    if (w.skipped) { console.log(`${w.flight.file} #${w.flight.log}: skipped, ${w.skipped}`); continue; }
    const fl = w.flight, ctx = { rate: fl.actualRate, govState: w.govStateAt || null, header: fl.header }, p = phases(w, ctx);
    console.log(`${fl.file} #${fl.log}: ${p.class}; ${PHASES.map(k => `${k} ${p.seconds[k]} s`).join(', ')}` + p.flights.map(f => `\n  flight ${f.t0}-${f.t1} s (${f.seconds} s), ${f.method}, ${f.confidence}`).join(''));
}
