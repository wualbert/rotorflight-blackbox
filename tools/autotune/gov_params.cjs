'use strict';

/**
 * Governor configuration recovered from the log (docs/GOVERNOR_AUTOTUNE.md sections 5 and 6.4; analysis/governor-20261014/
 * firmware_parameters.md section 11 and critique.md, which wins on conflicts).
 *
 *   recover(runs, { cli })  the runs of gov_data.cjs of one file (the PID profile rule is for one file), in log order, bench runs
 *                           too (configuration evidence only, critique M9: gov_data.load(dir, { bench: true })). cli: the text of a
 *                           CLI dump or health_setup.parseCli output (optional; only for the comparison).
 *   -> { profileMap, items, epochs, changes, flags, unknown, cli, notes }
 *     items     one per log, PID profile and name (two or more when the value changes inside the log): { name, scope, profile,
 *               headspeed, log, t0, t1, kind ('value' | 'effect' | 'lower' | 'upper' | 'range' | 'candidates'), value, estimate,
 *               se, lo, hi, candidates and reason (STE) of kind 'candidates', n, unit, method (STE), source ('calculated from the
 *               log: <method>' or 'log header'), logs, effective (a product of gains, EFFECTIVE, not a CLI name), bench }. profile 0
 *               is a PID profile that the log does not give: then headspeed is the key
 *     epochs    the logs (and times) in which a value stays the same, in log order, for each name and PID profile; bench: from
 *               bench runs only
 *     changes   a change of a recovered value between two epochs: between logs or inside a log, with headersEqual (the governor
 *               keys of the log headers, RULES.headerKeys) and reason 'recovered' (no INFLIGHT_ADJUSTMENT event of that name) or
 *               'adjusted'. A change of a log header value is in the log: no change and no flag
 *     flags     the "values possibly not current" flag of each epoch with a flight run of a value that changes: { name, profile,
 *               value, reasons, cause, logs (the flight logs), source, text }, as r.stale in js/tuning_worker.js. The reason
 *               'recovered' is not in REASONS of the worker: show the cause and the text of the flag (not through staleUnion)
 *     unknown   [{ name, scope, profile, reason }] the names that the logs do not show, with an STE reason: a profile name for each
 *               PID profile of the logs (profile 0 when the logs give none)
 *     cli       with a CLI dump: [{ name, profile, logs, recovered, cli, agree }] for each epoch, the products from the CLI gains
 *
 * Log numbers: run.log is the index of the log in the file (0 = the first log); the texts give log + 1, as the app does.
 *
 * Methods (time parameters in 0.1 s; slopes per frame x the nominal frame rate, index time: critique C3):
 *   ramps     motor[0] is a slew in IDLE/HOLD (up: gov_startup_time, down: gov_spooldown_time), SPOOLUP (gov_spoolup_time, only
 *             while govSum keeps its last value: the open loop, flight_governor.c:906-926), AUTOROTATION (up: gov_recovery_time,
 *             down: gov_spooldown_time), RECOVERY/BAILOUT (gov_recovery_time). Rate per PID loop 10 dT / time
 *             (flight_governor.c:1603-1609), so time = 10000 / (slope per frame in 0.1 % x frames per s).
 *   spool-up  PID spool-up: govSum = motor[0] in SPOOLUP (flight_governor.c:877-905). OFF: the open loop above the handover
 *             throttle (918), else candidates
 *   tracking  the target ramp in ACTIVE: max(gov_headspeed, Kmot) x 10 / time rpm/s (flight_governor.c:562-565), Kmot from the
 *             EWMA of H/u (0.05 Hz, flight_governor.c:550-560) reconstructed from the log; a lower bound before Kmot settles
 *   timeouts  the duration of HOLD (gov_throttle_hold_timeout) and AUTOROTATION (gov_autorotation_timeout) in real time, a
 *             lower bound when the timeout was not reached
 *   plateaus  the slew target in IDLE/HOLD/AUTOROTATION: clamp(in, lo, handover) (flight_governor.c:633-650), with FUNCTION
 *             positions low = idle, middle = auto, top = max_throttle (critique C5, C7)
 *   type      SWITCH: govRequest = stick x gov_headspeed (flight_governor.c:440-446), for two stick positions in one PID profile;
 *             NORMAL: ACTIVE at the middle position and govRequest the same at two stick positions; the error and the target
 *             rate use the full headspeed (621, 564), under SWITCH govRequest / stick, and the headspeed rule of the PID
 *             profiles does not apply (critique M3)
 *   mode      ELECTRIC: the throttle step at the start of RECOVERY and BAILOUT (Kmot, 1003-1008); DIRECT: govSum 0 in ACTIVE
 *             (no PID sum, 690-724); OFF or LIMIT: no governor state and no PID terms; else candidates
 *   fallback  FALLBACK throttle = (govI + F if precomp) x (1 - drop / 100) (flight_governor.c:979-995; critique C12, V3)
 *   piles     motor[0] at a constant value while govSum is beyond it: max or min throttle (critique C8)
 *   govP      govP = 1000 K Kp (T - H) / Hf with H = PT2(headspeed, gov_rpm_filter): grid over the cutoff (0 = no filter),
 *             K Kp by least squares
 *   govI      dgovI per frame = 1000 K Ki e / frames per s
 *   govF      govF = PT2_ff(1000 K Kf (wc |coll|^(curve/10) + wx cyc + wy |yaw|)) for each log and PID profile (critique C1): the
 *             products K Kf w always, the weights only where the log header gives K and Kf of that PID profile
 *   limits    a term at a constant clamp, else a lower bound from its largest value
 *   identity  motor[0] = clamp(govSum) gives voltage compensation inactive (critique V1)
 * Every estimate is per log segment and per stretch of a PID profile: a new stretch starts at each in-flight adjustment of a
 * governor value and at each change of govRequest inside a PID profile. Epochs merge the estimates that agree (RULES.agree).
 */

const RULES = {
    ramp: { minFrames: 100, minRange: 20, maxRms: 1.0 },            // motor counts (0.1 %)
    plateauS: 0.2,                                                   // a constant slew target: longer than one count of a 60 s ramp
    pile: { minFrames: 20, share: 0.9, ratio: 3, minPush: 5 },       // health_gov pile rule, with the govSum condition (C8); minPush: counts
                                                                     // that the integrator adds at the pile without a clamp
    steadyRpm: 1,                                                    // |govTarget - govRequest| for a steady target
    hsLagMs: 2.2,   // the logged headspeed lags the raw RPM (Bessel motor_rpm_lpf 100 Hz); H uses the raw RPM of the last PID loop
    maxHz: 255,     // the largest cutoff of gov_rpm_filter and gov_ff_filter (uint8); 0 is no filter (common_filter.c:124-133)
    pFit: { coarse: [2, 3, 5, 7, 10, 12, 15, 20, 30, 50, 100], relTol: 0.01, blockS: 5, step: 2, topShare: 0.001, minS: 5 },
    iFit: { blockS: 0.5, minBlockS: 0.2, minBlocks: 10 },
    ff: { curves: [10, 15, 20, 25, 30], filters: [2, 3, 4, 5, 6, 8, 10, 15, 20, 50, 100], step: 2, minS: 10, blockS: 5, relTol: 0.005, minBlocks: 5, seInflate: 3, settleS: 1, fc0: 5, gridStep: 2 },
    track: { minGapRpm: 20, minS: 0.3, kmotHz: 0.05, kmotSettle: 5, kmotRel: 0.02 },  // kmotSettle: EWMA weights of updates
    hold: { offsetS: 0.02 },                                         // event latency taken off a timeout duration
    spool: { minS: 0.5, pidS: 0.2 },                                 // a SPOOLUP of minS or more; PID spool-up: pidS of govSum = motor[0]
    groupS: 0.5,                                                     // the shortest ACTIVE stretch with its own values
    stickS: 0.5,                                                     // a constant stick in ACTIVE (throttle type)
    switchRel: 0.005,                                                // SWITCH: govRequest / stick the same within this share
    mode: { directS: 1 },                                            // DIRECT: ACTIVE with the motor on and govSum 0 for this time
    vcomp: { share: 0.99, margin: 5 },
    recoveryJump: 10,                                                // counts: a step at RECOVERY/BAILOUT entry (Kmot init, ELECTRIC)
    agree: { sigma: 3, abs: { time: 1, weight: 2, curve: 1, filter: 1, percent: 0.5, rpm: 1, gain: 0.03 } },
    headerKeys: ['govPID', 'yaw_tta', 'features', 'looptime', 'pid_process_denom', 'frameIntervalPNum', 'frameIntervalPDenom', 'minthrottle', 'maxthrottle',
        'motor_pwm_rate', 'fast_pwm_protocol', 'Firmware revision'],
};

const GLOBAL = ['gov_mode', 'gov_throttle_type', 'gov_startup_time', 'gov_spoolup_time', 'gov_tracking_time', 'gov_recovery_time', 'gov_spooldown_time',
    'gov_throttle_hold_timeout', 'gov_autorotation_timeout', 'gov_idle_throttle', 'gov_auto_throttle', 'gov_handover_throttle', 'gov_bypass_throttle',
    'gov_pwr_filter', 'gov_rpm_filter', 'gov_tta_filter', 'gov_ff_filter', 'gov_d_filter'];
const PROFILE = ['gov_use_fallback_precomp', 'gov_use_voltage_comp', 'gov_use_pid_spoolup', 'gov_use_dyn_min_throttle', 'gov_headspeed', 'gov_min_throttle',
    'gov_max_throttle', 'gov_gain', 'gov_p_gain', 'gov_i_gain', 'gov_d_gain', 'gov_f_gain', 'gov_p_limit', 'gov_i_limit', 'gov_d_limit', 'gov_f_limit',
    'gov_tta_gain', 'gov_tta_limit', 'gov_yaw_ff_weight', 'gov_cyclic_ff_weight', 'gov_collective_ff_weight', 'gov_collective_curve', 'gov_fallback_drop',
    'gov_dyn_min_throttle'];
const NAMES = GLOBAL.concat(PROFILE);
const WEIGHTS = ['gov_collective_ff_weight', 'gov_cyclic_ff_weight', 'gov_yaw_ff_weight'];
// products (not CLI names) for each PID profile: K Kp, K Ki, and K Kf w of the three feedforward weights (w as a fraction)
const EFFECTIVE = ['gov_kp_effective', 'gov_ki_effective', 'gov_collective_ff_effective', 'gov_cyclic_ff_effective', 'gov_yaw_ff_effective'];
const HEADER = ['gov_p_gain', 'gov_i_gain', 'gov_d_gain', 'gov_f_gain', 'gov_gain', 'gov_tta_gain', 'gov_tta_limit'];
// the names that motor[0] and the governor states show without the governor fields
const STATE_ONLY = ['gov_mode', 'gov_throttle_type', 'gov_startup_time', 'gov_recovery_time', 'gov_spooldown_time', 'gov_throttle_hold_timeout',
    'gov_autorotation_timeout', 'gov_idle_throttle', 'gov_auto_throttle', 'gov_handover_throttle', 'gov_bypass_throttle'];
const scopeOf = (n) => GLOBAL.includes(n) ? 'global' : 'profile';
const UNIT = (n) => /_time$|_timeout$/.test(n) ? (n === 'gov_autorotation_timeout' ? 's' : '0.1 s') : /filter$/.test(n) ? (n === 'gov_d_filter' ? '0.1 Hz' : 'Hz')
    : /weight$/.test(n) ? '%' : /_(idle|auto)_throttle$/.test(n) ? '0.1 %' : /throttle|limit|drop/.test(n) ? '%' : n === 'gov_headspeed' ? 'rpm' : '';
const KIND = (n) => /_time$|_timeout$/.test(n) ? 'time' : /weight$/.test(n) ? 'weight' : n === 'gov_collective_curve' ? 'curve' : /filter$/.test(n) ? 'filter'
    : n === 'gov_headspeed' ? 'rpm' : /effective$/.test(n) ? 'gain' : 'percent';
const STATES = ['OFF', 'IDLE', 'SPOOLUP', 'RECOVERY', 'ACTIVE', 'HOLD', 'FALLBACK', 'AUTOROTATION', 'BAILOUT', 'BYPASS'];
// INFLIGHT_ADJUSTMENT names (js/flightlog_parser.js) of the governor values
const ADJUST = { 'Governor Gain': 'gov_gain', 'Governor P-gain': 'gov_p_gain', 'Governor I-gain': 'gov_i_gain', 'Governor D-gain': 'gov_d_gain', 'Governor F-gain': 'gov_f_gain',
    'Governor TTA-gain': 'gov_tta_gain', 'Governor Cyclic FF': 'gov_cyclic_ff_weight', 'Governor Collective FF': 'gov_collective_ff_weight', 'Gov Idle Throttle': 'gov_idle_throttle',
    'Gov Auto Throttle': 'gov_auto_throttle', 'Gov Max Throttle': 'gov_max_throttle', 'Gov Min Throttle': 'gov_min_throttle', 'Gov Headspeed': 'gov_headspeed', 'Gov Yaw FF': 'gov_yaw_ff_weight' };

// STE texts: the method of each name (also in the source string), the reasons of the names that the logs do not show
const METHOD = {
    gov_startup_time: 'the slope of the throttle increase in IDLE',
    gov_spoolup_time: 'the slope of the throttle increase in SPOOLUP',
    gov_spooldown_time: 'the slope of the throttle decrease in IDLE, HOLD and AUTOROTATION',
    gov_recovery_time: 'the slope of the throttle in RECOVERY, BAILOUT and AUTOROTATION',
    gov_tracking_time: 'the slope of the headspeed target in ACTIVE, with the motor constant that the analysis calculates',
    gov_throttle_hold_timeout: 'the time in HOLD',
    gov_autorotation_timeout: 'the time in AUTOROTATION',
    gov_handover_throttle: 'the constant throttle in IDLE and AUTOROTATION with the throttle switch at the top position',
    gov_idle_throttle: 'the constant throttle in IDLE with the throttle switch at the low position',
    gov_auto_throttle: 'the constant throttle in AUTOROTATION with the throttle switch at the middle position',
    idleFromAuto: 'the value of "gov_auto_throttle", because "gov_idle_throttle" is not more than "gov_auto_throttle"',
    gov_mode: 'the throttle at the start of RECOVERY and BAILOUT, and "govSum" in ACTIVE',
    gov_throttle_type: 'the governor changes and "govRequest" at each position of the throttle switch',
    gov_rpm_filter: 'the low-pass filter frequency that makes "govP" agree best with the headspeed error',
    gov_ff_filter: 'a fit of "govF" to the mixer inputs',
    gov_collective_curve: 'a fit of "govF" to the mixer inputs',
    gov_collective_ff_weight: 'a fit of "govF" to the mixer inputs, with "gov_gain" and "gov_f_gain" of the log header',
    gov_cyclic_ff_weight: 'a fit of "govF" to the mixer inputs, with "gov_gain" and "gov_f_gain" of the log header',
    gov_yaw_ff_weight: 'a fit of "govF" to the mixer inputs, with "gov_gain" and "gov_f_gain" of the log header',
    gov_kp_effective: 'the ratio of "govP" to the headspeed error',
    gov_ki_effective: 'the changes of "govI" against the headspeed error',
    gov_collective_ff_effective: 'a fit of "govF" to the mixer inputs',
    gov_cyclic_ff_effective: 'a fit of "govF" to the mixer inputs',
    gov_yaw_ff_effective: 'a fit of "govF" to the mixer inputs',
    gov_headspeed: 'the value of "govRequest"',
    gov_fallback_drop: 'the throttle in FALLBACK against "govI" and "govF"',
    gov_use_fallback_precomp: 'the value of "govF" in FALLBACK',
    gov_use_voltage_comp: 'the ratio of the motor output to "govSum"',
    gov_use_pid_spoolup: 'the motor output and "govSum" in SPOOLUP',
    gov_use_dyn_min_throttle: 'the motor output at its minimum while "govSum" is less',
    gov_max_throttle: 'the motor output at its maximum while "govSum" is more',
    gov_min_throttle: 'the motor output at its minimum while "govSum" is less',
    gov_p_limit: 'the largest value of "govP"', gov_i_limit: 'the largest value of "govI"', gov_d_limit: 'the largest value of "govD"', gov_f_limit: 'the largest value of "govF"',
    gov_gain: 'the log header', gov_p_gain: 'the log header', gov_i_gain: 'the log header', gov_d_gain: 'the log header', gov_f_gain: 'the log header',
    gov_tta_gain: 'the log header', gov_tta_limit: 'the log header',
};
const NOT_SHOWN = {
    gov_bypass_throttle: 'The log shows this value only when the governor is in BYPASS. To find it, use the "GOVERNOR BYPASS" mode in a flight.',
    gov_pwr_filter: 'This filter has an effect only with voltage compensation. The log shows that voltage compensation is not active.',
    gov_tta_filter: 'This filter has an effect only with the tail torque assist ("gov_tta_gain" more than 0).',
    gov_d_filter: 'The D-term of the governor in the log ("govD") is 0 or too small. Thus, the analysis cannot find this filter.',
    gov_throttle_hold_timeout: 'The log shows this value only when the governor stays in HOLD until its time limit.',
    gov_recovery_time: 'The log shows this value only after FALLBACK or BAILOUT, or when the throttle increases in AUTOROTATION.',
    gov_fallback_drop: 'The log shows this value only after the governor goes to FALLBACK.',
    gov_use_fallback_precomp: 'The log shows this value only after the governor goes to FALLBACK.',
    gov_d_limit: 'The log shows this value only when the D-term of the governor is at its limit.',
    gov_use_dyn_min_throttle: 'The log shows this value only when the minimum throttle limits the motor output.',
    gov_dyn_min_throttle: 'The log shows this value only when "gov_use_dyn_min_throttle" is ON and the minimum throttle limits the motor output.',
    gov_use_pid_spoolup: 'The log shows this value only in SPOOLUP, when the throttle increases more than "gov_handover_throttle".',
    gov_d_gain: 'The log header has this value for the PID profile at the start of the log only.',
    gov_f_gain: 'The log header has this value for the PID profile at the start of the log only.',
    gov_gain: 'The log header has this value for the PID profile at the start of the log only.',
    gov_p_gain: 'The log header has this value for the PID profile at the start of the log only.',
    gov_i_gain: 'The log header has this value for the PID profile at the start of the log only.',
    gov_tta_gain: 'The log header has this value for the PID profile at the start of the log only.',
    gov_tta_limit: 'The log header has this value for the PID profile at the start of the log only.',
    weight: 'The log gives only the value of "gov_gain" multiplied by "gov_f_gain" and this weight. The log header has "gov_gain" and "gov_f_gain" only for the PID profile at the start of the log.',
    noGov: 'The log does not record the governor values ("govP", "govI", "govF", "govSum", "govTarget" and "govRequest"). To record them, set "blackbox_log_governor" to ON.',
    other: 'The logs do not show this value. The log records it only when the governor uses it.',
};
const N = (l) => l + 1; // the log number in a text
// a name in a text: a CLI name in quotation marks, a product with its CLI names
const nameText = (n) => !EFFECTIVE.includes(n) ? `"${n}"` : `the value of "gov_gain" multiplied by ${n === 'gov_kp_effective' ? '"gov_p_gain"' : n === 'gov_ki_effective' ? '"gov_i_gain"' : `"gov_f_gain" and "${WEIGHTS[EFFECTIVE.indexOf(n) - 2]}"`}`;
const logWords = (logs) => logs.length === 1 ? `log ${N(logs[0])}` : `logs ${logs.map(N).join(', ')}`;
const TEXT = {
    mapBasis: (p, h) => `The governor headspeed ("govRequest") gives PID profile ${p}. Each change to PID profile ${p} in the log has the headspeed ${h} rpm, and no other PID profile has it.`,
    cause: (n) => `a change of ${nameText(n)} with no record in the log`,
    flag: (n, places, same, v, logs, m) => `${EFFECTIVE.includes(n) ? 'T' + nameText(n).slice(1) : `The value of ${nameText(n)}`} changes ${places.join(' and ')}.${same ? ' The governor values of the log headers are the same.' : ''} `
        + `The log does not record ${places.length > 1 ? 'these changes' : 'this change'}. In ${logWords(logs)}, the value is ${v}. The source is "calculated from the log: ${m}".`,
    place: (c) => c.inLog ? `in log ${N(c.after.log)}` : `between log ${N(c.after.log)} and log ${N(c.before.log)}`,
    adjusted: (n, a) => `An in-flight adjustment changes ${nameText(n)} in log ${N(a)}.`,
    benchNote: 'The analysis uses the bench runs to find the configuration only. The other results do not use them.',
    switchNote: (logs) => `In ${logWords(logs)}, the throttle stick sets "govRequest" ("gov_throttle_type" is SWITCH). Thus, the analysis does not use the headspeed to find the PID profile.`,
    spoolCand: (x) => `In SPOOLUP, the throttle increases to ${x} % and the PID control does not start. Thus, "gov_use_pid_spoolup" is OFF, or "gov_handover_throttle" is ${x} % or more.`,
    typeCand: 'In ACTIVE, the throttle switch is at the middle position, and "govRequest" does not show the effect of the throttle stick. Thus, the throttle type is NORMAL or SWITCH.',
    modeCand: 'The log does not show a throttle step at the start of RECOVERY or BAILOUT. Thus, the analysis cannot find the governor mode.',
};
const r = (v, d = 3) => typeof v === 'number' && isFinite(v) ? +v.toFixed(d) : v;

// ---------------------------------------------------------------------------------------------
// numerics
// ---------------------------------------------------------------------------------------------

// firmware PT2 (common_filter.c:122-203) at the PID rate, L loops per logged frame with the frame value held; starts at x[0]
function pt2(x, fc, pidHz, L, out) {
    const n = x.length, y = out || new Float64Array(n);
    if (!(fc > 0)) { for (let i = 0; i < n; i++) y[i] = x[i]; return y; }
    const f = Math.min(1.553773974 * fc, 0.475 * pidHz), g = Math.min(1, f / (f + pidHz / (2 * Math.PI)));
    let a = x[0], b = x[0];
    for (let i = 0; i < n; i++) { const v = x[i]; for (let k = 0; k < L; k++) { b += (v - b) * g; a += (b - a) * g; } y[i] = a; }
    return y;
}
// x advanced by d samples (linear interpolation; the end held)
function shift(x, d) { const n = x.length, y = new Float64Array(n), k = Math.floor(d), f = d - k; for (let i = 0; i < n; i++) { const j = Math.min(n - 1, i + k), j1 = Math.min(n - 1, j + 1); y[i] = x[j] + f * (x[j1] - x[j]); } return y; }
// least squares of k unknowns from normal equations A (k x k, flat) and b; null when singular
function solve(A, b, k) {
    const M = A.slice(), v = b.slice();
    for (let i = 0; i < k; i++) {
        let p = i; for (let j = i + 1; j < k; j++) if (Math.abs(M[j * k + i]) > Math.abs(M[p * k + i])) p = j;
        if (!(Math.abs(M[p * k + i]) > 1e-12)) return null;
        for (let j = 0; j < k; j++) { const t = M[i * k + j]; M[i * k + j] = M[p * k + j]; M[p * k + j] = t; } { const t = v[i]; v[i] = v[p]; v[p] = t; }
        for (let j = i + 1; j < k; j++) { const f = M[j * k + i] / M[i * k + i]; for (let c = i; c < k; c++) M[j * k + c] -= f * M[i * k + c]; v[j] -= f * v[i]; }
    }
    const x = new Array(k).fill(0);
    for (let i = k - 1; i >= 0; i--) { let s = v[i]; for (let j = i + 1; j < k; j++) s -= M[i * k + j] * x[j]; x[i] = s / M[i * k + i]; }
    return x;
}
// normal-equation accumulators with blocks for a delete-one-block jackknife
function acc(k) { return { k, A: new Float64Array(k * k), b: new Float64Array(k), yy: 0, n: 0, blocks: [] }; }
function accAdd(S, x, y, block) {
    const k = S.k; let B = S.blocks[S.blocks.length - 1];
    if (!B || B.id !== block) { B = { id: block, A: new Float64Array(k * k), b: new Float64Array(k), n: 0 }; S.blocks.push(B); }
    for (let i = 0; i < k; i++) { S.b[i] += x[i] * y; B.b[i] += x[i] * y; for (let j = 0; j < k; j++) { S.A[i * k + j] += x[i] * x[j]; B.A[i * k + j] += x[i] * x[j]; } }
    S.yy += y * y; S.n++; B.n++;
}
function accSolve(S, minBlocks = 3, inflate = 1) {
    const x = solve(S.A, S.b, S.k); if (!x) return null;
    let sse = S.yy; for (let i = 0; i < S.k; i++) sse -= x[i] * S.b[i];
    const B = S.blocks.filter(q => q.n > 0), est = [];
    if (B.length >= minBlocks) for (const q of B) { const A = S.A.map((v, i) => v - q.A[i]), b = S.b.map((v, i) => v - q.b[i]), y = solve(A, b, S.k); if (y) est.push(y); }
    const inv = S.n > S.k ? x.map((_, i) => { const u = new Array(S.k).fill(0); u[i] = 1; const c = solve(S.A, u, S.k); return c ? c[i] : null; }) : null;
    const ls = x.map((_, i) => inv && inv[i] > 0 ? Math.sqrt(Math.max(0, sse) / (S.n - S.k) * inv[i]) : null);
    const se = x.map((_, i) => { if (est.length < minBlocks) return ls[i] === null ? null : ls[i] * inflate; const m = est.reduce((s, e) => s + e[i], 0) / est.length;
        return Math.max(ls[i] || 0, Math.sqrt((est.length - 1) / est.length * est.reduce((s, e) => s + (e[i] - m) ** 2, 0))); });
    return { x, se, sse: Math.max(0, sse), n: S.n, rms: Math.sqrt(Math.max(0, sse) / Math.max(1, S.n)) };
}
const median = (a) => { const s = Array.from(a).sort((p, q) => p - q); return s.length ? s[s.length >> 1] : null; };
const mode = (a) => { const c = new Map(); let best = null; for (const v of a) { c.set(v, (c.get(v) || 0) + 1); if (best === null || c.get(v) > c.get(best)) best = v; } return best === null ? null : { value: best, count: c.get(best) }; };
function spans(n, pred) { const out = []; for (let i = 0; i < n;) { if (!pred(i)) { i++; continue; } let j = i + 1; while (j < n && pred(j)) j++; out.push([i, j]); i = j; } return out; }
const counts = (a) => a ? Int32Array.from(a, v => Math.round(v * 1000)) : null;
const keyOf = (p, h) => p > 0 ? `p${p}` : `h${h}`;
// the first sample at or after tS (s, the time of the items: fromS + time)
function frameAt(run, tS) { let lo = 0, hi = run.n; while (lo < hi) { const k = (lo + hi) >> 1; if (run.fromS + run.time[k] < tS) lo = k + 1; else hi = k; } return lo; }
// a cutoff from the sse of each tried value (Map): a value, or a lower bound when the cap or 0 (no filter) fits as well
function cutoffOf(sse, best, relTol) {
    const near = [...sse].filter(([, s]) => s <= sse.get(best) * (1 + relTol)).map(([f]) => f);
    if (best === 0 && near.length === 1) return { value: 0, se: 0.5 };
    if (near.includes(0) || near.includes(RULES.maxHz)) return { kind: 'lower', lo: Math.min(...near.filter(f => f > 0)), detail: { noFilterFits: near.includes(0) } };
    return { value: best, se: Math.max(0.5, (Math.max(...near) - Math.min(...near)) / 2) };
}

// ---------------------------------------------------------------------------------------------
// PID profiles from the governor headspeed (CLAUDE.md "PID profiles"), the throttle type from govRequest
// ---------------------------------------------------------------------------------------------

// only the logged PID profile changes count: not the samples that gov_data filled with the arming profile (run.profileFilled)
function profileMap(runs) {
    const at = new Map();
    for (const run of runs) {
        if (!run.request) continue;
        const p = run.profile, q = run.request, f = run.profileFilled || 0;
        for (let i = f; i < run.n; i++) if (p[i] > 0 && (i === f || p[i] !== p[i - 1])) {
            const v = []; for (let k = i; k < Math.min(run.n, i + 20); k++) if (q[k] > 0) v.push(Math.round(q[k]));
            if (v.length) { if (!at.has(p[i])) at.set(p[i], new Set()); at.get(p[i]).add(median(v)); }
        }
    }
    const byHeadspeed = {}, basis = {};
    for (const [p, hs] of at) if (hs.size === 1) { const h = [...hs][0]; if (![...at].some(([q, s]) => q !== p && s.has(h))) { byHeadspeed[h] = p; basis[p] = TEXT.mapBasis(p, h); } }
    return { byHeadspeed, basis };
}
// the PID profile of every sample: the logged change, else the governor headspeed; 0 = unknown
function labels(run, map) {
    const lab = Uint8Array.from(run.profile);
    if (run.request) for (let i = 0; i < run.n; i++) if (!lab[i]) lab[i] = map.byHeadspeed[Math.round(run.request[i])] || 0;
    return lab;
}
// govRequest against the stick in ACTIVE, for each PID profile: SWITCH when govRequest / stick is the same at two stick positions
// (flight_governor.c:440-446), free when govRequest is the same at two stick positions. hf: the full headspeed of each PID profile
// under SWITCH (the median govRequest / stick)
function throttleRequest(run) {
    const out = { type: null, free: false, hf: new Map() };
    if (!run.thr || !run.request || !run.state) return out;
    const c = counts(run.thr), Q = run.request, p = run.profile, st = run.state, t = run.time, parts = [];
    for (const [a, e] of spans(run.n, i => st[i] === 4)) for (let s = a; s < e;) {
        let k = s + 1; while (k < e && c[k] === c[s] && p[k] === p[s] && Q[k] === Q[s]) k++;
        if (c[s] > 0 && Q[s] > 0 && t[k - 1] - t[s] >= RULES.stickS) parts.push({ p: p[s], thr: c[s] / 1000, q: Q[s], i0: s, i1: k - 1 });
        s = k;
    }
    for (const a of parts) for (const b of parts) if (a.p === b.p && a.thr < b.thr) {
        if (Math.abs(a.q - b.q) <= 1) out.free = true;
        else if (Math.abs(a.q / a.thr - b.q / b.thr) <= RULES.switchRel * b.q / b.thr && !out.type)
            Object.assign(out, { type: 'SWITCH', i0: Math.min(a.i0, b.i0), i1: Math.max(a.i1, b.i1), detail: { stick: [a.thr, b.thr], request: [a.q, b.q] } });
    }
    if (out.type) for (const q of new Set(parts.map(x => x.p))) out.hf.set(q, Math.round(median(parts.filter(x => x.p === q).map(x => x.q / x.thr))));
    return out;
}

// ---------------------------------------------------------------------------------------------
// the estimates of one run
// ---------------------------------------------------------------------------------------------

function analyseRun(run, map, out, sw) {
    const n = run.n, st = run.state, m = counts(run.u), rate = run.rate, t = run.time, R = RULES, T = run.target, Q = run.request, isSwitch = sw.type === 'SWITCH';
    const lab = isSwitch ? Uint8Array.from(run.profile) : labels(run, map);
    // the full headspeed of each sample (flight_governor.c:621, 564): govRequest, under SWITCH govRequest / stick of the PID profile
    const hfAt = isSwitch ? (i) => sw.hf.get(lab[i]) || 0 : Q ? (i) => Q[i] : () => 0, hsAt = (i) => Math.round(hfAt(i));
    // a stretch: a new one at each in-flight adjustment of a governor value and at each change of govRequest inside a PID profile.
    // The key of a sample: its PID profile (or headspeed) and its stretch
    const cut = new Uint8Array(n), seg = new Int32Array(n), gainCut = { at: n };
    for (const ev of run.events || []) if (ADJUST[ev.name]) { const i = frameAt(run, ev.t); if (i < n) cut[i] = 1; if (ev.name === 'Governor Gain' || ev.name === 'Governor F-gain') gainCut.at = Math.min(gainCut.at, i); }
    for (let i = 1; i < n; i++) seg[i] = seg[i - 1] + (cut[i] || (Q && !isSwitch && lab[i] > 0 && lab[i] === lab[i - 1] && Q[i] !== Q[i - 1]) ? 1 : 0);
    const ids = new Map(), kid = new Int32Array(n), keys = [];
    for (let i = 0; i < n; i++) { const k = `${keyOf(lab[i], hsAt(i))}|${seg[i]}`; let id = ids.get(k); if (id === undefined) { id = keys.length; ids.set(k, id); keys.push(k); } kid[i] = id; }
    const kAt = (i) => keys[kid[i]];
    // K Kf of the log header: the PID profile at the start of the log, until an adjustment of gov_gain or gov_f_gain
    const g = (run.header || {}).govPID, KKf = !run.segment && Array.isArray(g) && g[4] > 0 && g[3] > 0 ? g[4] / 100 * g[3] / 100 : null, key0 = keyOf(lab[0], hsAt(0));
    const kkfAt = (i) => KKf && i < gainCut.at && keyOf(lab[i], hsAt(i)) === key0 ? KKf : null;
    const add = (name, i0, i1, o) => out.push(Object.assign({ name, log: run.log, segment: run.segment, profile: scopeOf(name) === 'global' ? 0 : lab[i0],
        headspeed: scopeOf(name) === 'global' ? null : hsAt(i0), t0: r(run.fromS + t[i0], 3), t1: r(run.fromS + t[Math.min(n - 1, i1)], 3), kind: 'value', bench: run.class === 'bench' }, o));
    header(run, add);
    if (!m) return;
    const thrC = run.thr ? counts(run.thr) : null, S = counts(run.govSum), I = counts(run.govI), F = counts(run.govF), P = counts(run.govP);
    // no governor state (lib: govStateAt null without GOVERNOR_STATE events) and no PID terms while the motor runs: gov_mode OFF or
    // LIMIT (no state machine and no govDataUpdate, flight_governor.c:1438-1458)
    if (!st || st.every(v => v === 0)) { if (S && P && S.every(v => v === 0) && P.every(v => v === 0) && m.filter(v => v > 50).length >= rate)
        add('gov_mode', 0, n - 1, { kind: 'candidates', value: null, candidates: ['OFF', 'LIMIT'], n: 1 }); return; }
    const sr = []; for (let s = 0; s < n;) { let e = s + 1; while (e < n && st[e] === st[s]) e++; sr.push([st[s], s, e]); s = e; }
    // SPOOLUP: the open loop until govSum changes (the PID spool-up writes govSum, flight_governor.c:877-905)
    const openEnd = (a, e) => { let k = a + 1; while (k < e && S[k] === S[k - 1]) k++; return k; };

    // ramps
    for (const [s, a, e] of sr) {
        if (![1, 2, 3, 5, 7, 8].includes(s) || (s === 2 && !S)) continue;
        for (const q of rampsIn(m, a, s === 2 ? openEnd(a, e) : e)) {
            const up = q.slope > 0, name = s === 2 ? 'gov_spoolup_time' : s === 3 || s === 8 || (s === 7 && up) ? 'gov_recovery_time' : up ? 'gov_startup_time' : 'gov_spooldown_time';
            const v = 10000 / (Math.abs(q.slope) * rate);
            add(name, q.a, q.b, { value: v, se: v * q.se / Math.abs(q.slope), n: q.b - q.a + 1, detail: { state: STATES[s], slopePerS: r(q.slope * rate, 2), rms: r(q.rms, 3) } });
        }
    }
    // PID spool-up: govSum = motor[0] in SPOOLUP. OFF only when the open loop goes above the handover throttle (recover)
    if (S) for (const [s, a, e] of sr) if (s === 2 && t[e - 1] - t[a] >= R.spool.minS) {
        const k = openEnd(a, e); let pid = 0, top = 0; for (let i = k; i < e; i++) if (Math.abs(S[i] - m[i]) <= 1) pid++; for (let i = a; i < k; i++) top = Math.max(top, m[i]);
        if (pid >= R.spool.pidS * rate) add('gov_use_pid_spoolup', a, e, { value: 'ON', n: 1, detail: { pidS: r(pid / rate, 2) } });
        else if (k === e && top - m[a] >= R.ramp.minRange) add('gov_use_pid_spoolup', a, e, { value: 'OFF', n: 1, needs: 'handover', top, detail: { top } });
    }
    // timeouts (real time)
    for (const [s, a, e] of sr) {
        if (s !== 5 && s !== 7) continue;
        const d = t[Math.min(e, n - 1)] - t[a], next = e < n ? st[e] : null, armed = run.armed.subarray(a, Math.min(n, e + 1)).every(v => v === 1);
        const stick = thrC ? thrC[e - 1] : null, name = s === 5 ? 'gov_throttle_hold_timeout' : 'gov_autorotation_timeout', k = s === 5 ? 10 : 1;
        const timedOut = armed && (s === 5 ? next === 0 || next === 1 : next === 1 && (stick === null || stick >= 333));
        if (timedOut) add(name, a, e, { value: Math.round((d - R.hold.offsetS) * k), estimate: d * k, se: 0.05 * k, n: 1, detail: { seconds: r(d, 3), next: STATES[next] } });
        else add(name, a, e, { kind: 'lower', lo: Math.max(s === 7 ? 1 : 0, Math.floor(d * k)), n: 1, detail: { seconds: r(d, 3), next: next === null ? null : STATES[next] } });
    }
    // plateaus of the slew target: handover, idle, auto, and FUNCTION
    if (thrC) for (const [s, a, e] of sr) {
        if (s !== 1 && s !== 5 && s !== 7) continue;
        for (const [b0, b1] of subRuns(thrC, a, e)) {
            const pos = thrC[b0] >= 666 ? 'top' : thrC[b0] >= 333 ? 'middle' : 'low';
            let k = b1 - 1; while (k > b0 && m[k - 1] === m[b1 - 1]) k--;
            const flat = t[b1 - 1] - t[k] >= R.plateauS, v = m[b1 - 1];
            if (pos === 'top') {
                if (flat && v > 0 && v % 10 === 0) add('gov_handover_throttle', k, b1 - 1, { value: v / 10, se: 0, n: b1 - k, detail: { state: STATES[s] } });
                else if (!flat && b1 < n && [2, 3, 8].includes(st[b1])) { let mx = 0; for (let i = b0; i < b1; i++) mx = Math.max(mx, m[i]); if (mx > 0) add('gov_handover_throttle', b0, b1, { kind: 'lower', lo: Math.ceil(mx / 10), n: b1 - b0, detail: { state: STATES[s], next: STATES[st[b1]] } }); }
            } else if (flat && pos === 'middle') {
                if (v < Math.min(thrC[b0], 100)) add('gov_throttle_type', k, b1 - 1, { value: 'FUNCTION', n: 1, detail: { stick: thrC[b0], throttle: v } }); // NORMAL: clamp(stick, lo, handover) >= 10 %
                add('gov_auto_throttle', k, b1 - 1, { value: v, se: 0, n: b1 - k, needs: 'FUNCTION', detail: { state: STATES[s] } });
                add('gov_idle_throttle', k, b1 - 1, v === 0 ? { value: 0, se: 0, n: 1, needs: 'FUNCTION', method: METHOD.idleFromAuto } : { kind: 'upper', hi: v, n: 1, needs: 'FUNCTION' }); // auto >= idle (flight_governor.c:1468-1477)
            } else if (flat && pos === 'low' && s === 1) add('gov_idle_throttle', k, b1 - 1, { value: v, se: 0, n: b1 - k, needs: 'FUNCTION', detail: { state: STATES[s] } });
        }
    }
    // SWITCH from govRequest; NORMAL: the stick at the middle position in ACTIVE (not FUNCTION: there the middle position gives the
    // auto throttle, below the handover) and govRequest the same at two stick positions
    if (isSwitch) add('gov_throttle_type', sw.i0, sw.i1, { value: 'SWITCH', n: 1, detail: sw.detail });
    else if (thrC) { let mid = null; for (const [s, a, e] of sr) if (s === 4 && !mid) mid = subRuns(thrC, a, e).find(([b0, b1]) => thrC[b0] >= 333 && thrC[b0] < 666 && t[b1 - 1] - t[b0] >= R.stickS);
        if (mid) add('gov_throttle_type', mid[0], mid[1], sw.free ? { value: 'NORMAL', n: 1, detail: { stick: thrC[mid[0]] } } : { kind: 'candidates', value: null, candidates: ['NORMAL', 'SWITCH'], reason: TEXT.typeCand, n: 1 }); }
    // FALLBACK, the start of RECOVERY and BAILOUT (gov_mode ELECTRIC), and DIRECT (no PID sum in ACTIVE)
    for (const [s, a, e] of sr) {
        if (s === 6 && S && F && a > 0 && e - a > 4) {
            const fb = F[a - 1], fIn = []; const ratio = [];
            for (let i = a + 1; i < e - 1; i++) { fIn.push(F[i]); if (S[i] > 0 && m[i] > 0 && m[i] < 1000) ratio.push(m[i] / (S[i] + 0.5)); }
            if (fb >= 3) add('gov_use_fallback_precomp', a, e, { value: fIn.every(v => v === 0) ? 'OFF' : 'ON', n: 1, detail: { govFBefore: fb } });
            if (ratio.length) { const q = median(ratio), Sm = median(Array.from(S.subarray(a + 1, e - 1))); add('gov_fallback_drop', a, e, { value: 100 * (1 - q), se: 100 * 0.6 / Math.max(1, Sm), n: 1, detail: { ratio: r(q, 4), throttle: m[a + 1], govI: I ? I[a - 1] : null } }); }
        }
        if ((s === 3 || s === 8) && a > 0 && m[a] < 990 && Math.abs(m[a] - m[a - 1]) > R.recoveryJump) add('gov_mode', a, a + 1, { value: 'ELECTRIC', n: 1, detail: { state: STATES[s], from: m[a - 1], to: m[a] } });
    }
    if (S) { let on = 0, zero = 0; for (let i = 0; i < n; i++) if (st[i] === 4 && m[i] > 0) { on++; if (S[i] === 0) zero++; } if (on >= R.mode.directS * rate && zero === on) add('gov_mode', 0, n - 1, { value: 'DIRECT', n: 1, detail: { activeS: r(on / rate, 1) } }); }
    if (!run.hasGovernor || !run.hs || !T || !Q) return;
    // ACTIVE: identities, piles and limits for each key
    const A = []; for (let i = 1; i < n; i++) if (st[i] === 4 && st[i - 1] === 4) A.push(i);
    if (!A.length) return;
    const groups = new Map(); for (const i of A) { const k = kAt(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
    const hsL = shift(run.hs, Math.max(0, R.hsLagMs - 1000 / run.pidHz) * rate / 1000), pid = govPFit(run, A, kAt, hfAt, P, hsL), fc = pid ? pid.fc : 10;
    if (pid) {
        add('gov_rpm_filter', A[0], A[A.length - 1], Object.assign({ n: pid.n }, pid.cutoff, { detail: Object.assign({ rms: r(pid.rms, 3) }, pid.cutoff.detail) }));
        for (const [k, g] of pid.keys) add('gov_kp_effective', g.i0, g.i1, { value: g.x / 1000, se: g.se === null ? null : g.se / 1000, n: g.n, detail: { rms: r(g.rms, 2) } });
    }
    const e = pid ? pid.e : null, kI = e ? govIFit(run, A, kAt, e, m, I, P, add) : new Map();
    for (const [k, idx] of groups) {
        if (idx.length < R.groupS * rate) continue;
        const i0 = idx[0], i1 = idx[idx.length - 1];
        let mMax = 0, mMin = 1e9; for (const i of idx) { mMax = Math.max(mMax, m[i]); mMin = Math.min(mMin, m[i]); }
        // voltage compensation: motor[0] = clamp(govSum) within 1 count (G8)
        let ok = 0, tot = 0; for (const i of idx) if (S[i] > mMin + R.vcomp.margin && S[i] < mMax - R.vcomp.margin) { tot++; if (Math.abs(m[i] - S[i]) <= 1) ok++; }
        const inactive = tot > 0 && ok >= R.vcomp.share * tot;
        if (tot) add('gov_use_voltage_comp', i0, i1, { kind: 'effect', value: inactive ? 'inactive' : 'active', n: tot, detail: { share: r(ok / tot, 4) } });
        if (inactive) { // piles (C8): the output at a limit while govSum is beyond it
            const hi = [], lo = []; for (const i of idx) { if (S[i] >= m[i] + 2) hi.push(m[i]); else if (S[i] <= m[i] - 2) lo.push(m[i]); }
            const top = hi.length >= R.pile.minFrames ? mode(hi) : null, bot = lo.length >= R.pile.minFrames ? mode(lo) : null;
            if (top && top.count >= R.pile.share * hi.length && top.value % 10 === 0) add('gov_max_throttle', i0, i1, { value: top.value / 10, se: 0, n: hi.length });
            else add('gov_max_throttle', i0, i1, { kind: 'lower', lo: Math.ceil(mMax / 10), n: idx.length });
            if (bot && bot.count >= R.pile.share * lo.length && bot.value % 10 === 0) add('gov_min_throttle', i0, i1, { value: bot.value / 10, se: 0, n: lo.length });
            else if (bot) add('gov_use_dyn_min_throttle', i0, i1, { value: 'ON', n: lo.length });
            else if (mMin >= 100) add('gov_min_throttle', i0, i1, { kind: 'upper', hi: Math.floor(mMin / 10), n: idx.length });
        }
        // term limits: a pile at the largest value (P and F with the unclamped value beyond it), else a lower bound
        const pk = pid && pid.keys.get(k), ki = kI.get(k);
        for (const [name, C, beyond] of [['gov_p_limit', P, pk ? (at, c) => at.filter(i => Math.abs(pk.x * e[i]) > c + 3).length >= R.pile.minFrames : null],
            ['gov_i_limit', I, ki ? (at) => at.filter(i => m[i] > mMin + 1 && m[i] < mMax - 1 && P[i] * I[i] > 0).reduce((s, i) => s + 1000 * ki * Math.abs(e[i]) / rate, 0) >= R.pile.minPush : null],
            ['gov_d_limit', counts(run.govD), null], ['gov_f_limit', F, null]]) {
            if (!C) continue;
            let c = 0; for (const i of idx) c = Math.max(c, Math.abs(C[i]));
            const at = idx.filter(i => Math.abs(C[i]) >= c - 1), below = [2, 3, 4].map(d => idx.filter(i => Math.abs(C[i]) === c - d).length).reduce((s, v) => s + v, 0) / 3;
            const pile = Math.round(c / 10) >= 1 && at.length >= R.pile.ratio * below && Math.abs(c - 10 * Math.round(c / 10)) <= 1 && at.length >= R.pile.minFrames && beyond && beyond(at, c);
            if (pile) add(name, i0, i1, { value: Math.round(c / 10), se: 0, n: at.length });
            else if (c > 0 && name !== 'gov_f_limit') add(name, i0, i1, { kind: 'lower', lo: Math.ceil(c / 10), n: idx.length, detail: { largest: c } });
        }
        // headspeed of the PID profile
        if (hsAt(i0) > 0) add('gov_headspeed', i0, i1, { value: hsAt(i0), se: isSwitch ? 1 : 0, n: idx.length });
    }
    govFFit(run, A, kAt, kkfAt, F, add);
    tracking(run, A, hfAt, fc, m, add, hsL);
}

// sub-runs of a constant stick in [a, e)
function subRuns(c, a, e) { const out = []; for (let s = a; s < e;) { let k = s + 1; while (k < e && c[k] === c[s]) k++; out.push([s, k]); s = k; } return out; }

// the linear ramps of motor counts in [s, e): maximal monotone runs, constant head and tail cut, a straight line within maxRms
function rampsIn(m, s, e) {
    const out = [], R = RULES.ramp;
    for (let a = s; a < e - 1;) {
        let b = a; while (b + 1 < e && m[b + 1] === m[b]) b++;
        if (b + 1 >= e) break;
        const dir = m[b + 1] > m[b] ? 1 : -1; let c = b + 1;
        while (c + 1 < e && (m[c + 1] - m[c]) * dir >= 0) c++;
        let d = c; while (d > b + 1 && m[d - 1] === m[c]) d--;
        const N = d - b + 1;
        if (N >= R.minFrames && Math.abs(m[d] - m[b]) >= R.minRange) {
            let sx = 0, sy = 0; for (let i = b; i <= d; i++) { sx += i - b; sy += m[i]; }
            const mx = sx / N, my = sy / N; let sxx = 0, sxy = 0; for (let i = b; i <= d; i++) { sxx += (i - b - mx) ** 2; sxy += (i - b - mx) * (m[i] - my); }
            const slope = sxy / sxx; let ss = 0; for (let i = b; i <= d; i++) ss += (m[i] - my - slope * (i - b - mx)) ** 2;
            const rms = Math.sqrt(ss / N);
            if (rms <= R.maxRms) out.push({ a: b, b: d, slope, se: Math.max(rms, 0.289) / Math.sqrt(sxx), rms });
        }
        a = c;
    }
    return out;
}

// govP = 1000 K Kp (T - PT2(hs, fc)) / Hf in ACTIVE with a steady target: the cutoff by a grid of least squares (0 = no filter, up to
// RULES.maxHz), K Kp for each key
function govPFit(run, A, kAt, hfAt, P, hs) {
    const R = RULES.pFit, T = run.target, Q = run.request, L = run.loopsPerFrame, n = run.n;
    let pmax = []; for (const i of A) pmax.push(Math.abs(P[i])); pmax.sort((a, b) => a - b); const top = pmax[Math.floor(pmax.length * (1 - R.topShare))];
    const use = A.filter((i, j) => j % R.step === 0 && Math.abs(T[i] - Q[i]) < RULES.steadyRpm && Math.abs(T[i - 1] - Q[i - 1]) < RULES.steadyRpm && Math.abs(P[i]) < top && hfAt(i) > 0);
    if (use.length < 1000) return null;
    const H = new Float64Array(n), blk = Math.round(R.blockS * run.rate);
    const fit = (fc, keep) => {
        pt2(hs, fc, run.pidHz, L, H);
        const keys = new Map(); let sse = 0, cnt = 0;
        for (const i of use) { const k = kAt(i); if (!keys.has(k)) keys.set(k, Object.assign(acc(1), { i0: i, i1: i })); const S = keys.get(k); S.i1 = i;
            const e = (T[i] - H[i]) / hfAt(i), p = P[i] + (P[i] > 0 ? 0.5 : P[i] < 0 ? -0.5 : 0); accAdd(S, [e], p, Math.floor(i / blk)); }
        const out = new Map(); for (const [k, S] of keys) { const s = accSolve(S); if (!s) continue; sse += s.sse; cnt += s.n; if (s.n * R.step >= R.minS * run.rate) out.set(k, { x: s.x[0], se: s.se[0], rms: s.rms, n: s.n, i0: S.i0, i1: S.i1 }); }
        return { fc, sse, n: cnt, keys: out, e: keep ? Float64Array.from(H, (h, i) => hfAt(i) > 0 ? (T[i] - h) / hfAt(i) : 0) : null };
    };
    const tried = new Map(), at = (fc) => { if (!tried.has(fc)) tried.set(fc, fit(fc, false)); return tried.get(fc); };
    let best = [0, RULES.maxHz].concat(R.coarse).map(at).reduce((p, q) => q.sse < p.sse ? q : p);
    for (;;) { const b = [best.fc - 1, best.fc + 1].filter(f => f >= 1 && f <= RULES.maxHz).map(at).reduce((p, q) => q.sse < p.sse ? q : p, best); if (b === best) break; best = b; }
    const res = fit(best.fc, true);
    return { fc: best.fc, cutoff: cutoffOf(new Map([...tried].map(([f, q]) => [f, q.sse])), best.fc, R.relTol), rms: Math.sqrt(res.sse / res.n), n: res.n, keys: res.keys, e: res.e };
}

// dgovI per frame = 1000 K Ki e / frames per s, in blocks of iFit.blockS with no clamp, for each key
function govIFit(run, A, kAt, e, m, I, P, add) {
    const R = RULES.iFit, Q = run.request, T = run.target, rate = run.rate, keys = new Map();
    let mMax = 0, mMin = 1e9, iMax = 0, pMax = 0; for (const i of A) { mMax = Math.max(mMax, m[i]); mMin = Math.min(mMin, m[i]); iMax = Math.max(iMax, Math.abs(I[i])); pMax = Math.max(pMax, Math.abs(P[i])); }
    const ok = (i) => run.state[i] === 4 && run.state[i - 1] === 4 && m[i] < mMax - 1 && m[i] > mMin + 1 && Math.abs(I[i]) < iMax - 2 && Math.abs(P[i]) < pMax - 1
        && Math.abs(T[i] - Q[i]) < RULES.steadyRpm && kAt(i) === kAt(i - 1) && Q[i] === Q[i - 1];
    const B = Math.round(R.blockS * rate), minB = Math.round(R.minBlockS * rate);
    let dI = 0, E = 0, c = 0, key = null, first = 0;
    const flush = (i) => { if (c >= minB && key) { if (!keys.has(key)) keys.set(key, Object.assign(acc(1), { i0: first, i1: i })); const S = keys.get(key); S.i1 = i; accAdd(S, [E], dI, Math.floor(first / (10 * B))); } dI = 0; E = 0; c = 0; };
    for (const i of A) {
        if (!ok(i)) { flush(i); continue; }
        const k = kAt(i); if (k !== key) { flush(i); key = k; }
        if (!c) first = i;
        dI += I[i] - I[i - 1]; E += e[i]; c++;
        if (c === B) flush(i);
    }
    flush(A[A.length - 1]);
    const out = new Map();
    for (const [k, S] of keys) { const s = S.n >= R.minBlocks ? accSolve(S) : null; if (s) { out.set(k, s.x[0] * rate / 1000); add('gov_ki_effective', S.i0, S.i1, { value: s.x[0] * rate / 1000, se: s.se[0] === null ? null : s.se[0] * rate / 1000, n: s.n }); } }
    return out;
}

// govF = PT2_ff(sum b_j x_j) with b = 1000 K Kf w: the curve for each key and the ff filter of the log by a grid; the products K Kf w
// for each stretch of a PID profile of RULES.ff.minS or more of ACTIVE (the short stretches of a key pooled), and the weights where
// kkfAt gives K Kf (the log header, critique M8)
function govFFit(run, A, kAt, kkfAt, F, add) {
    if (!run.coll || !run.roll || !run.pitch || !run.yaw || !F) return;
    const R = RULES.ff, n = run.n, L = run.loopsPerFrame, rate = run.rate;
    let fMax = 0; for (const i of A) fMax = Math.max(fMax, F[i]);
    const settle = Math.round(R.settleS * rate), ago = new Int32Array(n); for (let i = 1; i < n; i++) ago[i] = kAt(i) === kAt(i - 1) ? ago[i - 1] + 1 : 0;
    const use = A.filter((i, j) => j % R.step === 0 && F[i] >= 1 && F[i] < fMax - 1 && ago[i] >= settle);
    if (use.length < R.minS * rate / R.step) return;
    const cyc = Float64Array.from(run.roll, (v, i) => Math.hypot(v, run.pitch[i])), yaw = Float64Array.from(run.yaw, Math.abs), raw = new Float64Array(n);
    const X = [new Float64Array(n), new Float64Array(n), new Float64Array(n)], blk = Math.round(R.blockS * rate), cache = new Map();
    let rawCurve = null, xyFc = null; // the features of the last curve and filter (pow_approx of the firmware: Math.pow)
    const feats = (curve, fc) => { if (curve !== rawCurve) { for (let i = 0; i < n; i++) raw[i] = Math.pow(Math.abs(run.coll[i]), curve / 10); rawCurve = curve; }
        pt2(raw, fc, run.pidHz, L, X[0]); if (fc !== xyFc) { pt2(cyc, fc, run.pidHz, L, X[1]); pt2(yaw, fc, run.pidHz, L, X[2]); xyFc = fc; } };
    const sseAt = (curve, fc) => { // { key: sse }
        const id = `${curve}|${fc}`; if (cache.has(id)) return cache.get(id);
        feats(curve, fc); const keys = new Map();
        for (let j = 0; j < use.length; j += R.gridStep) { const i = use[j], k = kAt(i); if (!keys.has(k)) keys.set(k, acc(3)); accAdd(keys.get(k), [X[0][i], X[1][i], X[2][i]], F[i] + 0.5, 0); }
        const out = new Map(); for (const [k, S] of keys) { const s = accSolve(S); out.set(k, s ? s.sse : Infinity); }
        cache.set(id, out); return out;
    };
    const keys = [...new Set(use.map(kAt))];
    // the curve of each key at fc0, the common filter with these curves, then both again from there (integer steps)
    const descend = (b, f, lo, hi) => { for (;;) { const c = [b - 1, b + 1].filter(v => v >= lo && v <= hi).reduce((p, v) => f(v) < f(p) ? v : p, b); if (c === b) return b; b = c; } };
    const bestCurve = (fc, k, from) => descend(from || R.curves.reduce((p, c) => (sseAt(c, fc).get(k) < sseAt(p, fc).get(k) ? c : p)), (c) => sseAt(c, fc).get(k), 5, 40);
    const curves = new Map(keys.map(k => [k, bestCurve(R.fc0, k)])), total = (fc) => keys.reduce((s, k) => s + sseAt(curves.get(k), fc).get(k), 0);
    const grid = [0, RULES.maxHz].concat(R.filters);
    let fc = descend(grid.reduce((p, f) => total(f) < total(p) ? f : p), total, 1, RULES.maxHz);
    for (let pass = 0; pass < 3; pass++) { let moved = false; for (const k of keys) { const c = bestCurve(fc, k, curves.get(k)); if (c !== curves.get(k)) { curves.set(k, c); moved = true; } } if (!moved) break; fc = descend(fc, total, 1, RULES.maxHz); }
    add('gov_ff_filter', use[0], use[use.length - 1], Object.assign({ n: use.length }, cutoffOf(new Map(grid.concat([fc - 1, fc, fc + 1]).filter(f => f >= 0 && f <= RULES.maxHz).map(f => [f, total(f)])), fc, R.relTol)));
    for (const k of keys) {
        const idx = use.filter(i => kAt(i) === k); if (idx.length * R.step < R.minS * rate) continue;
        const curve = curves.get(k), s0 = sseAt(curve, fc).get(k), cn = [curve - 1, curve + 1].filter(v => v >= 5 && v <= 40 && sseAt(v, fc).get(k) <= s0 * (1 + R.relTol));
        add('gov_collective_curve', idx[0], idx[idx.length - 1], { value: curve, se: cn.length ? 1 : 0.5, n: idx.length });
        feats(curve, fc);
        // the stretches of this key (a run of its PID profile label): long ones alone, the short ones pooled
        const parts = [], short = []; let cur = null;
        for (const i of idx) { if (cur && sameKey(kAt, cur[cur.length - 1], i)) cur.push(i); else { cur = [i]; parts.push(cur); } }
        const long = parts.filter(q => q.length * R.step >= R.minS * rate); for (const q of parts) if (!long.includes(q)) short.push(...q);
        const kkf = kkfAt(idx[0]); // the same for every sample of a key
        for (const part of long.concat(short.length * R.step >= R.minS * rate ? [short] : [])) {
            const S = acc(3); for (const i of part) accAdd(S, [X[0][i], X[1][i], X[2][i]], F[i] + 0.5, Math.floor(i / blk));
            const s = accSolve(S, R.minBlocks, R.seInflate); if (!s) continue;
            const i0 = part[0], i1 = part[part.length - 1];
            WEIGHTS.forEach((name, j) => {
                add(EFFECTIVE[2 + j], i0, i1, { value: s.x[j] / 1000, se: s.se[j] === null ? null : s.se[j] / 1000, n: s.n, detail: { rms: r(s.rms, 3) } });
                if (kkf) add(name, i0, i1, { value: s.x[j] / (10 * kkf), se: s.se[j] === null ? null : s.se[j] / (10 * kkf), n: s.n, detail: { product: r(s.x[j], 2), rms: r(s.rms, 3) } });
            });
        }
        // gov_f_limit: govF at a constant largest value while the fitted feedforward is more
        const S = acc(3); for (const i of idx) accAdd(S, [X[0][i], X[1][i], X[2][i]], F[i] + 0.5, 0); const s = accSolve(S);
        const all = A.filter(i => kAt(i) === k); let fk = 0; for (const i of all) fk = Math.max(fk, F[i]);
        const at = all.filter(i => F[i] >= fk - 1), over = s ? at.filter(i => s.x[0] * X[0][i] + s.x[1] * X[1][i] + s.x[2] * X[2][i] > fk + 3).length : 0;
        if (Math.round(fk / 10) >= 1 && Math.abs(fk - 10 * Math.round(fk / 10)) <= 1 && over >= RULES.pile.minFrames) add('gov_f_limit', at[0], at[at.length - 1], { value: Math.round(fk / 10), se: 0, n: over });
        else if (fk > 0) add('gov_f_limit', idx[0], idx[idx.length - 1], { kind: 'lower', lo: Math.ceil(fk / 10), n: all.length, detail: { largest: fk } });
    }
}
// i and j in one run of the key
function sameKey(kAt, i, j) { for (let k = i + 1; k <= j; k++) if (kAt(k) !== kAt(i)) return false; return true; }

// target ramps in ACTIVE: slope = max(Hf, Kmot) x 10 / gov_tracking_time per s; Kmot reconstructed (EWMA of H/u, SPOOLUP and ACTIVE)
function tracking(run, A, hfAt, fc, m, add, hs) {
    const R = RULES.track, n = run.n, L = run.loopsPerFrame, T = run.target, Q = run.request, st = run.state, H = pt2(hs, fc, run.pidHz, L);
    const W = (R.kmotHz + run.pidHz / (2 * Math.PI)) / R.kmotHz, K = new Float64Array(n), U = new Float64Array(n); let y = 0, N = 0, ups = 0;
    for (let i = 0; i < n; i++) { const u = m[i] / 1000, hf = hfAt(i);
        if ((st[i] === 2 || st[i] === 4) && u > 0.2 && hf > 0 && H[i] / hf > 0.2) for (let k = 0; k < L; k++) { N = Math.min(N + 1, W); y += (H[i] / u - y) / N; ups++; }
        K[i] = y; U[i] = ups; }
    for (const [a, b] of spans(n, i => st[i] === 4 && Math.abs(Q[i] - T[i]) > R.minGapRpm && i > 0 && Q[i] === Q[i - 1])) {
        const hf = hfAt(a); if ((b - a) / run.rate < R.minS || !(hf > 0)) continue;
        const N2 = b - a; let sx = 0, sy = 0; for (let i = a; i < b; i++) { sx += i - a; sy += T[i]; }
        const mx = sx / N2, my = sy / N2; let sxx = 0, sxy = 0, ss = 0; for (let i = a; i < b; i++) { sxx += (i - a - mx) ** 2; sxy += (i - a - mx) * (T[i] - my); }
        const slope = sxy / sxx; for (let i = a; i < b; i++) ss += (T[i] - my - slope * (i - a - mx)) ** 2;
        if (Math.sign(slope) !== Math.sign(Q[a] - T[a]) || Math.sqrt(ss / N2) > 2) continue; // a straight ramp toward the request
        let km = 0; for (let i = a; i < b; i++) km += K[i]; km /= N2;
        const settled = U[a] >= R.kmotSettle * W, base = Math.max(hf, km), v = 10 * base / (Math.abs(slope) * run.rate);
        const seRel = Math.hypot(Math.sqrt(ss / N2) / Math.sqrt(sxx) / Math.abs(slope), km > hf ? R.kmotRel : 0);
        if (settled || km <= hf) add('gov_tracking_time', a, b, { value: v, se: v * seRel, n: N2, detail: { rpmPerS: r(slope * run.rate, 1), kmot: r(km, 0), headspeed: r(hf, 0) } });
        else add('gov_tracking_time', a, b, { kind: 'lower', lo: Math.floor(10 * hf / (Math.abs(slope) * run.rate)), n: N2, detail: { rpmPerS: r(slope * run.rate, 1) } });
    }
}

// the values of the log header: the PID profile at the start of the log (blackbox.c:1668-1699); a missing value gives no item
function header(run, add) {
    if (run.segment) return;
    const h = run.header || {}, g = h.govPID, tta = h.yaw_tta;
    const o = (name, v) => { if (typeof v === 'number' && isFinite(v)) add(name, 0, 0, { value: v, se: 0, n: 1, source: 'log header' }); };
    if (Array.isArray(g)) [['gov_p_gain', 0], ['gov_i_gain', 1], ['gov_d_gain', 2], ['gov_f_gain', 3], ['gov_gain', 4]].forEach(([k, j]) => o(k, g[j]));
    if (Array.isArray(tta)) { o('gov_tta_gain', tta[0]); o('gov_tta_limit', tta[1]); }
}

// ---------------------------------------------------------------------------------------------
// epochs, items, flags, the CLI comparison
// ---------------------------------------------------------------------------------------------

function agrees(a, o) {
    if (typeof a.value === 'string' || typeof o.value === 'string') return a.value === o.value;
    const tol = Math.max(RULES.agree.abs[KIND(o.name)] * (KIND(o.name) === 'gain' ? Math.abs(a.estimate) : 1), RULES.agree.sigma * Math.hypot(a.se || 0, o.se || 0));
    return Math.abs(a.estimate - o.value) <= tol;
}
// the value of an integer CLI name: rounded; a product: 4 significant digits
const finalValue = (name, v) => typeof v !== 'number' ? v : EFFECTIVE.includes(name) ? +v.toPrecision(4) : Math.round(v);
const known = (i) => i.value != null || i.lo != null || i.hi != null || i.kind === 'candidates';

function recover(runs, opts = {}) {
    const sws = runs.map(throttleRequest), map = profileMap(runs.filter((q, j) => sws[j].type !== 'SWITCH')), obs = [], notes = [];
    runs.forEach((run, j) => analyseRun(run, map, obs, sws[j]));
    if (runs.some(q => q.class === 'bench')) notes.push(TEXT.benchNote);
    const swLogs = [...new Set(runs.filter((q, j) => sws[j].type === 'SWITCH').map(q => q.log))]; if (swLogs.length) notes.push(TEXT.switchNote(swLogs));
    // FUNCTION throttle: needed for the plateaus of idle and auto (the middle position is the auto throttle only with FUNCTION).
    // PID spool-up OFF: the open loop above the largest handover throttle. DIRECT: no PID, so no PID spool-up
    const types = new Set(obs.filter(o => o.name === 'gov_throttle_type' && o.kind === 'value').map(o => o.value));
    const isFunction = types.size === 1 && types.has('FUNCTION'), direct = obs.some(o => o.name === 'gov_mode' && o.value === 'DIRECT');
    const hoMax = Math.max(-Infinity, ...obs.filter(o => o.name === 'gov_handover_throttle' && o.kind === 'value').map(o => o.value)), kept = [];
    for (const o of obs) {
        if ((o.needs === 'FUNCTION' && !isFunction) || (direct && o.name === 'gov_use_pid_spoolup')) continue;
        if (o.needs === 'handover' && !(isFinite(hoMax) && o.top >= 10 * hoMax + 2)) kept.push(Object.assign({}, o, { kind: 'candidates', value: null, candidates: ['OFF', 'ON'], reason: TEXT.spoolCand(o.top / 10) }));
        else kept.push(o);
    }
    const order = new Map(runs.map((q, i) => [`${q.log}|${q.segment}`, i]));
    const groups = new Map();
    for (const o of kept) { const k = `${o.name}|${scopeOf(o.name) === 'global' ? 'g' : keyOf(o.profile, o.headspeed)}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o); }
    const items = [], epochs = [], changes = [], flags = [];
    for (const list of groups.values()) {
        list.sort((a, b) => order.get(`${a.log}|${a.segment}`) - order.get(`${b.log}|${b.segment}`) || a.t0 - b.t0);
        const name = list[0].name, values = list.filter(o => o.kind === 'value' || o.kind === 'effect');
        // epochs of the values in log order
        const eps = [];
        for (const o of values) {
            const cur = eps[eps.length - 1];
            if (cur && agrees(cur, o)) {
                cur.obs.push(o);
                if (typeof o.value === 'number') { const w0 = cur.w, w = 1 / Math.max(1e-6, o.se || 0.05) ** 2; cur.estimate = (cur.estimate * w0 + o.value * w) / (w0 + w); cur.w = w0 + w; cur.se = 1 / Math.sqrt(cur.w); }
            } else eps.push({ name, obs: [o], estimate: o.value, value: o.value, w: typeof o.value === 'number' ? 1 / Math.max(1e-6, o.se || 0.05) ** 2 : 0, se: o.se === undefined ? null : o.se });
        }
        for (const ep of eps) {
            ep.value = finalValue(name, ep.estimate);
            ep.logs = [...new Set(ep.obs.map(o => o.log))]; ep.flightLogs = [...new Set(ep.obs.filter(o => !o.bench).map(o => o.log))];
            ep.from = { log: ep.obs[0].log, t: ep.obs[0].t0 }; ep.to = { log: ep.obs[ep.obs.length - 1].log, t: ep.obs[ep.obs.length - 1].t1 };
        }
        const o0 = list[0], scope = scopeOf(name), profile = scope === 'global' ? 0 : o0.profile, headspeed = scope === 'global' ? null : o0.headspeed;
        const method = o0.method || METHOD[name] || name, source = o0.source === 'log header' ? 'log header' : `calculated from the log: ${method}`;
        eps.forEach((ep) => epochs.push({ name, scope, profile, headspeed, value: ep.value, estimate: typeof ep.estimate === 'number' ? +ep.estimate.toPrecision(6) : ep.estimate, se: r(ep.se, 6), logs: ep.logs,
            from: ep.from, to: ep.to, n: ep.obs.length, source, effective: EFFECTIVE.includes(name), bench: !ep.flightLogs.length }));
        // items: each log (its epochs inside the log), with the bounds of that log; without a value, the bounds or the candidates
        for (const log of [...new Set(list.map(o => o.log))]) {
            const mine = list.filter(o => o.log === log), bounds = mine.filter(o => o.kind === 'lower' || o.kind === 'upper'), cand = mine.filter(o => o.kind === 'candidates');
            const lo = bounds.filter(o => o.kind === 'lower').reduce((s, o) => Math.max(s, o.lo), -Infinity), hi = bounds.filter(o => o.kind === 'upper').reduce((s, o) => Math.min(s, o.hi), Infinity);
            const inLog = eps.map(ep => ({ ep, obs: ep.obs.filter(o => o.log === log) })).filter(q => q.obs.length);
            const base = { name, scope, profile, headspeed, log, unit: UNIT(name), method, source, effective: EFFECTIVE.includes(name), bench: mine.some(o => o.bench), logs: [log] };
            const none = { value: null, estimate: null, se: null, lo: isFinite(lo) ? lo : null, hi: isFinite(hi) ? hi : null };
            if (!inLog.length && bounds.length) items.push(Object.assign({}, base, none, { kind: isFinite(lo) && isFinite(hi) ? 'range' : isFinite(lo) ? 'lower' : 'upper', n: bounds.length,
                t0: bounds[0].t0, t1: bounds[bounds.length - 1].t1, detail: bounds.map(o => o.detail).filter(Boolean).slice(0, 12) }));
            else if (!inLog.length && cand.length) items.push(Object.assign({}, base, none, { kind: 'candidates', candidates: [...new Set(cand.flatMap(o => o.candidates))], reason: cand[0].reason || null,
                n: cand.length, t0: cand[0].t0, t1: cand[cand.length - 1].t1, detail: cand.map(o => o.detail).filter(Boolean).slice(0, 12) }));
            for (const q of inLog) {
                const ws = q.obs.filter(o => typeof o.value === 'number'), w = ws.map(o => 1 / Math.max(1e-6, o.se || 0.05) ** 2), sw = w.reduce((s, v) => s + v, 0);
                const est = ws.length ? ws.reduce((s, o, j) => s + o.value * w[j], 0) / sw : q.ep.estimate;
                items.push(Object.assign({}, base, { kind: q.obs[0].kind === 'effect' ? 'effect' : 'value', value: finalValue(name, est), estimate: typeof est === 'number' ? +est.toPrecision(6) : est,
                    se: ws.length ? r(1 / Math.sqrt(sw), 6) : null, lo: none.lo, hi: none.hi, n: q.obs.length, t0: q.obs[0].t0, t1: q.obs[q.obs.length - 1].t1, detail: q.obs.map(o => o.detail).filter(Boolean).slice(0, 12) }));
            }
        }
        // changes between epochs (an INFLIGHT_ADJUSTMENT event of the name in between: 'adjusted', else 'recovered') and their flags
        const chs = [];
        for (let j = 1; j < eps.length && source !== 'log header'; j++) {
            const a = eps[j - 1], b = eps[j], la = a.to.log, lb = b.from.log, ia = runs.findIndex(q => q.log === la), ib = runs.findIndex(q => q.log === lb);
            const ra = runs[ia], rb = runs[ib], same = !!ra && !!rb && RULES.headerKeys.every(k => JSON.stringify((ra.header || {})[k]) === JSON.stringify((rb.header || {})[k]));
            const adj = runs.slice(ia, ib + 1).filter(q => q.events).flatMap(q => q.events.filter(ev => ADJUST[ev.name] === name && (q.log !== la || ev.t >= a.to.t) && (q.log !== lb || ev.t <= b.from.t)));
            chs.push({ name, scope, profile, headspeed, from: a.value, to: b.value, after: a.to, before: b.from, inLog: la === lb, headersEqual: same, reason: adj.length ? 'adjusted' : 'recovered', events: adj, bench: a.flightLogs.length === 0 || b.flightLogs.length === 0 });
        }
        changes.push(...chs);
        // the flags of the epochs with a flight run: the results do not use bench runs
        eps.forEach((ep, j) => { const near = [chs[j - 1], chs[j]].filter(Boolean); if (!near.length || !ep.flightLogs.length) return; const adj = near.find(c => c.reason === 'adjusted');
            flags.push({ name, profile, headspeed, value: ep.value, reasons: [...new Set(near.map(c => c.reason))], cause: adj ? 'an in-flight adjustment' : TEXT.cause(name), logs: ep.flightLogs, source,
                text: adj ? TEXT.adjusted(name, adj.before.log) : TEXT.flag(name, near.map(TEXT.place), near.every(c => c.headersEqual), ep.value, ep.flightLogs, method) }); });
    }
    // gov_mode: candidates when no rule gives it (the PID sum in ACTIVE excludes DIRECT)
    if (!items.some(i => i.name === 'gov_mode') && runs.some(q => q.state && q.state.some(v => v > 0))) {
        const pidSum = runs.some(q => q.govSum && q.state && q.state.some((s, i) => s === 4 && q.govSum[i] !== 0));
        items.push({ name: 'gov_mode', scope: 'global', profile: 0, headspeed: null, log: null, kind: 'candidates', value: null, estimate: null, se: null, lo: null, hi: null,
            candidates: pidSum ? ['ELECTRIC', 'NITRO'] : ['ELECTRIC', 'NITRO', 'DIRECT'], reason: TEXT.modeCand, unit: '', method: METHOD.gov_mode, source: `calculated from the log: ${METHOD.gov_mode}`,
            effective: false, bench: false, logs: [...new Set(runs.map(q => q.log))] });
    }
    // the names that the logs do not show: the specific reasons only when their condition holds; without the governor fields, how to record them
    const anyGov = runs.some(q => q.hasGovernor), profiles = [...new Set(items.filter(i => i.scope === 'profile' && i.profile > 0).map(i => i.profile))].sort((a, b) => a - b);
    const holds = { gov_pwr_filter: items.some(i => i.name === 'gov_use_voltage_comp' && i.value === 'inactive') && !items.some(i => i.name === 'gov_use_voltage_comp' && i.value === 'active'),
        gov_tta_filter: runs.length > 0 && runs.every(q => q.header && Array.isArray(q.header.yaw_tta) && !(q.header.yaw_tta[0] > 0)),
        gov_d_filter: runs.some(q => q.govD) && runs.every(q => !q.govD || q.govD.every(v => Math.abs(v) <= 0.0025)) };
    const why = (nm, p) => {
        if (WEIGHTS.includes(nm) && items.some(i => i.name === EFFECTIVE[2 + WEIGHTS.indexOf(nm)] && i.profile === p && known(i))) return NOT_SHOWN.weight;
        if (!anyGov && !STATE_ONLY.includes(nm) && !HEADER.includes(nm)) return NOT_SHOWN.noGov;
        return NOT_SHOWN[nm] && holds[nm] !== false ? NOT_SHOWN[nm] : NOT_SHOWN.other;
    };
    const unknown = [];
    for (const nm of NAMES) {
        if (scopeOf(nm) === 'global') { if (!items.some(i => i.name === nm && known(i))) unknown.push({ name: nm, scope: 'global', profile: 0, reason: why(nm, 0) }); continue; }
        if (!profiles.length) { if (!items.some(i => i.name === nm && known(i))) unknown.push({ name: nm, scope: 'profile', profile: 0, reason: why(nm, 0) }); continue; }
        for (const p of profiles) if (!items.some(i => i.name === nm && i.profile === p && known(i))) unknown.push({ name: nm, scope: 'profile', profile: p, reason: why(nm, p) });
    }
    const out = { rules: RULES, profileMap: map, items, epochs, changes, flags, unknown, notes, cli: null };
    if (opts.cli) out.cli = compareCli(out, opts.cli);
    return out;
}

// the products of the CLI gains of a PID profile section (undefined when a value is missing)
function cliProduct(name, s) {
    const K = s.gov_gain / 100, Kf = K * s.gov_f_gain / 100;
    const v = { gov_kp_effective: K * s.gov_p_gain / 10, gov_ki_effective: K * s.gov_i_gain / 10, gov_collective_ff_effective: Kf * s.gov_collective_ff_weight / 100,
        gov_cyclic_ff_effective: Kf * s.gov_cyclic_ff_weight / 100, gov_yaw_ff_effective: Kf * s.gov_yaw_ff_weight / 100 }[name];
    return typeof v === 'number' && isFinite(v) ? v : undefined;
}
// the recovered epochs against the CLI dump (text or health_setup.parseCli): agree when the CLI value is in the uncertainty
function compareCli(res, cli) {
    const c = typeof cli === 'string' ? require('./health_setup.cjs').parseCli(cli) : cli, out = [];
    const meter = c.global && c.global.battery_meter, secOf = (o) => o.scope === 'global' ? c.global : o.profile > 0 ? (c.profiles || {})[String(o.profile - 1)] : null;
    for (const ep of res.epochs) {
        const sec = secOf(ep), v = !sec ? undefined : ep.effective ? cliProduct(ep.name, sec) : sec[ep.name];
        if (v === undefined) continue;
        let agree;
        if (ep.name === 'gov_use_voltage_comp') agree = ep.value === 'inactive' ? v === 'OFF' || (meter !== undefined && meter !== 'ADC') : v === 'ON';
        else if (typeof ep.value === 'string' || typeof v === 'string') agree = String(ep.value).toUpperCase() === String(v).toUpperCase();
        else if (ep.effective) agree = Math.abs(ep.estimate - v) <= Math.max(RULES.agree.abs.gain * v, RULES.agree.sigma * (ep.se || 0));
        else agree = Math.abs(ep.estimate - v) <= Math.max(0.5, RULES.agree.sigma * (ep.se || 0));
        out.push({ name: ep.name, profile: ep.profile, headspeed: ep.headspeed, logs: ep.logs, recovered: ep.value, estimate: ep.estimate, cli: ep.effective ? +v.toPrecision(4) : v, agree });
    }
    for (const it of res.items.filter(i => i.kind === 'lower' || i.kind === 'upper' || i.kind === 'range')) {
        const sec = secOf(it);
        if (!sec || typeof sec[it.name] !== 'number' || res.epochs.some(e => e.name === it.name && e.profile === it.profile && e.logs.includes(it.log))) continue;
        out.push({ name: it.name, profile: it.profile, headspeed: it.headspeed, logs: [it.log], recovered: null, lo: it.lo, hi: it.hi, cli: sec[it.name],
            agree: (it.lo === null || sec[it.name] >= it.lo) && (it.hi === null || sec[it.name] <= it.hi), bound: true });
    }
    return out;
}

module.exports = { RULES, NAMES, GLOBAL, PROFILE, EFFECTIVE, WEIGHTS, METHOD, NOT_SHOWN, TEXT, scopeOf, pt2, rampsIn, profileMap, labels, throttleRequest, recover, compareCli };
if (require.main !== module) return;

// node tools/autotune/gov_params.cjs <data dir> [--cli <dump>] [--logs 5,6]: the recovered values, epochs and the CLI comparison (bench runs too)
const args = process.argv.slice(2), opt = (k) => { const j = args.indexOf(k); return j >= 0 ? args[j + 1] : null; };
const GD = require('./gov_data.cjs'), fs = require('fs');
const res = recover(GD.load(args[0], { bench: true, logs: opt('--logs') ? opt('--logs').split(',').map(Number) : undefined }), { cli: opt('--cli') ? fs.readFileSync(opt('--cli'), 'utf8') : null });
for (const e of res.epochs) console.log(e.name.padEnd(28), String(e.profile || '-').padEnd(2), String(e.value).padEnd(10), `est ${e.estimate} se ${e.se}`.padEnd(34), 'logs', e.logs.join(','), e.bench ? '(bench)' : '');
for (const i of res.items.filter(i => i.kind === 'candidates')) console.log('CANDIDATES', i.name, i.profile, i.log, i.candidates.join('/'));
for (const c of res.changes) console.log('CHANGE', c.name, c.profile, c.from, '->', c.to, c.inLog ? 'in log' : 'between', c.after.log, c.before.log, c.headersEqual ? 'same headers' : 'headers differ', c.reason);
if (res.cli) for (const c of res.cli) console.log('CLI', c.agree ? 'agree ' : 'DIFFER', c.name, c.profile, 'logs', c.logs.join(','), 'recovered', c.recovered === null ? `[${c.lo}, ${c.hi}]` : c.recovered, 'cli', c.cli);
for (const u of res.unknown) console.log('UNKNOWN', u.name, u.profile || '');
for (const n of res.notes) console.log('NOTE', n);
