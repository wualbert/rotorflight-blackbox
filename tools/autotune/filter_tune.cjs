'use strict';

/**
 * Filter analysis and firmware coefficient helpers (SPEC3 G). Public tune() now
 * delegates to filter_autotune.cjs and filter_replay.cjs: time-domain-only evaluation.
 * The spectral helpers below remain for log analysis and regression comparisons.
 * Legacy analysis: a replica of the Rotorflight 4.6.0 gyro filter chain predicts gyroADC
 * from the logged gyroRAW; the replica is validated on each log (parity); then filter settings are searched on the logged
 * gyroRAW of the flight phase, scored by the noise that reaches the PID output under a time-delay limit at 10-30 Hz, and the
 * chosen set is validated leave-one-flight-out. Pure computation, no DOM; it runs in Node and in the worker's CommonJS shim.
 *
 *   config(header, opts)      the filter settings of one log: header first, the CLI dump only for what the header lacks
 *   withSettings(cfg, s)      the same settings with some CLI names changed; compile(cfg) gives the stages of the replica
 *   runChain(model, seg)      the time-varying stages in the time domain on the logged gyroRAW: RPM notches sample by sample,
 *                             and the dynamic notch with its SDFT peak tracking, tick by tick of the PID loop (exact when the
 *                             log rate is the filter rate)
 *   chainResponse, pidResponse  exact discrete transfer functions at the firmware rates (static filters, PID path, delay)
 *   prepare(logs, opts)       windows of the flight phase; raw PSD; the replica of the logged settings run on every log
 *   parity(prep)              predicted against logged gyroADC per log, PID profile and axis, with the limits of RULES.parity
 *   evaluate(prep, changes)   a candidate: the noise at the PID output per flight, axis and line, and the time delay
 *   greedy / choose           the search: screening (frequency domain, line-aware, or a quarter of the time domain for the
 *                             dynamic notch), the best candidates run in full; the smallest change that reaches the target
 *   tune(logs, opts)          everything: parity, the current noise, candidates, the recommended set with CLI lines and the
 *                             rows of each change, leave-one-out validation, the delay change, curves for a before/after plot
 *   tailOrder(logs, opts)     without gear ratios (no CLI dump): the configured order of the tail rotor RPM notch (tail notch
 *                             frequency / rotor frequency) and of the main motor notch, from the dip that the firmware notch
 *                             leaves in gyroADC / gyroRAW against rotor order; prepare() uses it (basis 'log notch')
 *
 * Input (logs): [{ w, mask?, normal?, phases?, cli? }] with w a whole-log segment of lib.segments(..., { whole: true, extra:
 * EXTRA }) (several per log when the log has gaps; they are grouped by w.flight.log). mask is the flight phase
 * (health_phase.flightMask) without rescue, level modes and failsafe (health_more normalMask): the attitude-loop and filter
 * mask of CLAUDE.md. Without mask the module computes health_phase.flightMask itself. A log with no flight (bench run) is
 * not used.
 *
 * Firmware (rotorflight-firmware release/4.6.0, tag 118e912) read for this file:
 *   sensors/gyro_filter_impl.c:20-75    per axis: gyroADCd -> RPM notches -> LPF2 -> LPF1 -> notch2 -> notch1 -> dynamic notch
 *                                       -> gyroADCf; the decimator (4th-order Bessel at gyro_decimation_hz, gyro_init.c:121-131,
 *                                       gyro.c gyroUpdate) is before gyroRAW, so it is not in gyroRAW -> gyroADC
 *   sensors/gyro_init.c:86-183, 627-643 LPF1/LPF2 at filterRateHz = gyro rate / filter denom; static notch Q from
 *                                       notchFilterGetQ, the Nyquist adjustment; dynamic LPF1 only with lpf1_dyn_min_hz > 0
 *   config/config.c:575-713             filter denom fix, cutoff limit 0.45 x gyro rate / filter denom, LPF hz 0 -> NONE,
 *                                       notch cutoff >= hz -> notch off
 *   common/filter.c                     limitCutoff 0.475 fs (28), PT1/PT2/PT3 (122-250), first order bilinear (670), RBJ biquad
 *                                       LPF and notch (545), difFilter (449), the LPF types (752), notchFilterGetQ (873)
 *   flight/rpm_filter.c                 presets (57), validateAndFix (140: a preset overwrites the custom banks), init (173:
 *                                       sources 10/11-18/20/21-28, Q = q/10 in 1..25, max 0.45 filter rate, min
 *                                       constrain(min_hz, 10, max/2), fade to 1.25 min), apply (282: v += (notch(v) - v) fader),
 *                                       update (295: 3 banks per cycle, designed at filter rate x cycle-time multiplier)
 *   flight/motors.c:241-306             headspeed = motor rpm x main gear ratio; tail = motor rpm x main / tail ratio (not motorised)
 *                                       rpm_filter.c:186-236 gives each bank a notch at motor rpm x ratio / 60 Hz: 11-18 main x h,
 *                                       21-28 (main / tail) x h, 10 x 1 (only when the main ratio is not 1), 20 (motorised tail only).
 *                                       So a tail rotor notch is at h x T x the logged headspeed (lrintf(motor rpm x main), motors.c
 *                                       313, blackbox.c:1403) and a main motor notch at M x the headspeed, M = 1 / main ratio. The
 *                                       log header has no gear ratio: tailOrder() finds T and M from the dips of the notches
 *   scheduler/scheduler.c:571-600, 789  cycle-time multiplier = measured gyro rate / nominal: the notch is designed at the real
 *                                       loop rate, so in log time (CPU clock, actualRate) the notch sits at h x T x headspeed / 60 Hz
 *   flight/dyn_notch_filter.c:147-360   SDFT of the dynamic notch input averaged over sampleCount PID loops, 12 ticks per round of
 *                                       3 axes, top-N local maxima of the Hann-windowed squared spectrum, parabolic peak, Q =
 *                                       q/10 + 0.2 p, off when the PID rate is less than 1 kHz; on only with feature DYN_NOTCH
 *                                       (fc/init.c:793)
 *   common/sdft.c                       72 samples, r = 0.9999, Hann in frequency, batches of bins over sampleCount loops
 *   flight/pid.c:551-573, 841-853, 1147 PID gyro filter: first order at <axis>_gyro_cutoff; D = difFilter(-gyro, <axis>_d_cutoff)
 *                                       at the PID rate; d_cutoff 0 gives no D-term (difFilterUpdate a = b = 0)
 *   blackbox/blackbox.c:1329-1330       gyroADC = lrintf(gyroADCf), gyroRAW = lrintf(gyroADCd): both rounded to 1 deg/s
 *   fc/core.c:856-1056, scheduler.c:520 per gyro tick: gyro sample, filter (counter % filter denom == 0), PID task; the blackbox
 *                                       writes at PID counter 0,0,1,1,2,3,4,5,6 for denom 1..8, so the logged gyroRAW is that many
 *                                       gyro ticks after the filter input of the logged gyroADC (Fireball 0.5 ms, Gaui X4 0.25 ms)
 *   cli/settings.c:660-681, 1124-1134, 1699-1709  names and ranges (FW_RANGE)
 *
 * Units: rates deg/s; PSD (deg/s)^2/Hz one-sided; frequencies in nominal Hz of the firmware clock inside the module (the
 * loop runs off the gyro clock: log Hz = nominal x scale, scale = actualRate / nominal log rate) and in log Hz in the result;
 * noise at the PID output in permille of full authority (gains x lib.SCALE); delays in ms.
 */

const lib = require('./lib.cjs');
const setup = require('./health_setup.cjs');

const AXES = ['roll', 'pitch', 'yaw'];
const EXTRA = ['gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]', 'tailspeed', 'time', 'govRequest', 'govTarget', 'govP'];

// ---------------------------------------------------------------------------------------------
// Firmware constants (sources in the header comment)
// ---------------------------------------------------------------------------------------------

const FW = {
    q: { butter: 0.707106781, bessel: 0.577350269, damped: 0.5, bessel4a: 0.805538282, bessel4b: 0.521934582 },   // filter.h:24-42
    c: { butter: 1.0, bessel: 1.272019649, damped: 1.553773974, bessel4a: 1.603357516, bessel4b: 1.430171560 },
    pt2: 1.553773974, pt3: 1.961459177,          // filter.c:168, 208
    cutoffLimit: 0.475,                          // filter.c:28 limitCutoff
    configLimit: 0.45,                           // config.c:672 cutoff_limit (x gyro rate / filter denom)
    notchMax: 0.45, fade: 1.25, minHzLo: 10,     // rpm_filter.c:195-197
    rpmBanks: 16, rpmUpdateBanks: 3,             // pg/rpm_filter.h, rpm_filter.c:34
    sdftN: 72, sdftR: 0.9999,                    // sdft.h:34, sdft.c:30
    dynQAdvance: 0.2, dynMinUpdateHz: 1000, dynCountMax: 8, dynTicks: 12,   // dyn_notch_filter.c:80-83, dyn_notch_filter.h:29
    bbCounter: [0, 0, 1, 1, 2, 3, 4, 5, 6],      // core.c taskMainPidLoop: PID counter of subTaskBlackboxUpdate, index = PID denom (>= 8: 6)
    LPF: ['NONE', 'FIRST_ORDER', 'SECOND_ORDER', 'PT1', 'PT2', 'PT3', 'ORDER1', 'BUTTER', 'BESSEL', 'DAMPED'],  // settings.c:296 lookupTableLowpassType
    features: { DYN_NOTCH: 29, RPM_FILTER: 30 },  // config/feature.h
    roundingVar: 1 / 12,                         // lrintf of gyroRAW and gyroADC (blackbox.c:1329-1330): uniform error of 1 deg/s
};
// RPM notch presets 1..3 (rpm_filter.c:57-110): [roll, pitch, yaw] of { source, q (x10), center (x10000) }. LNC2(30) = -1000/30
// in C integer division = -33
const PRESETS = (() => {
    const z = (n) => new Array(n).fill(0), row = (s, q, c) => ({ source: s, q, center: c || z(s.length) });
    const low = row([11, 12, 14, 21], [80, 40, 60, 50]), lowY = row([11, 12, 21], [80, 40, 50]);
    const mid = row([11, 12, 13, 14, 21, 22, 10], [80, 30, 80, 60, 60, 50, 80]), midY = row([11, 12, 13, 14, 21, 22, 10], [80, 40, 80, 80, 60, 50, 80]);
    const hi = row([11, 12, 12, 13, 14, 15, 16, 21, 22, 10], [50, 30, 30, 80, 50, 80, 80, 60, 50, 80], [0, -33, 33, 0, 0, 0, 0, 0, 0, 0]), hiY = row([11, 12, 13, 14, 21, 22, 10], [80, 40, 80, 80, 50, 40, 80]);
    return { 1: [low, low, lowY], 2: [mid, mid, midY], 3: [hi, hi, hiY] };
})();

// Firmware ranges of the settings this module may write (cli/settings.c, release/4.6.0). advice.cjs RANGE has some of them;
// test/filter_tune.test.cjs checks that the two agree where both have a name.
const FW_RANGE = {
    gyro_decimation_hz: [0, 1000],
    gyro_lpf1_static_hz: [0, 1000], gyro_lpf2_static_hz: [0, 1000],                         // settings.c:663, 670 (LPF_MAX_HZ, gyro.h:40)
    gyro_notch1_hz: [0, 1000], gyro_notch1_cutoff: [0, 1000], gyro_notch2_hz: [0, 1000], gyro_notch2_cutoff: [0, 1000], // 672-675
    dyn_notch_count: [0, 8], dyn_notch_q: [10, 100], dyn_notch_min_hz: [10, 200], dyn_notch_max_hz: [100, 500], // 678-681
    gyro_rpm_notch_preset: [0, 3], gyro_rpm_notch_min_hz: [1, 100],                         // 1699-1700
    rpm_notch_q: [10, 250],                       // effective, rpm_filter.c:204 constrainf(q, 10, 250); the array has no CLI range
    rpm_notch_center: [-32768, 32767],            // VAR_INT16 array (settings.c:1702)
    d_cutoff: [0, 250], gyro_cutoff: [0, 250],    // settings.c:1124-1134 (per axis, per PID profile)
};

// ---------------------------------------------------------------------------------------------
// Rules: every threshold with its source and reasoning
// ---------------------------------------------------------------------------------------------

const P = 'pipeline, unvalidated';
const RULES = {
    sig: 2,   // a predicted change must pass its threshold by this many SE over flights (the 2-SE gate of the toolkit, advice.cjs)
    parity: {
        lineDb: 1.0, bandDb: 1.0, delayMs: 0.3, minCoherence: 0.9, minLineSnr: 10, minFloorRatio: 2, removedPass: 0.1, minWindows: 5,
        source: `${P}. A recommendation needs a predicted noise reduction of reduction.minDb (3 dB). A model error of 1 dB is a third of it, so the model is used only where the median error at the lines and the error in each band are 1 dB or less. Coherence 0.9 with about 100 windows gives a random error of |T| of 2 % (0.2 dB), well inside the limit. delayMs: 0.3 ms is 3 % of the F11 flag (10 ms). removedPass: a line that the log and the replica pass at 10 % (-20 dB) or less is removed in both. Its residual is not compared in dB: the bands compare the totals`,
    },
    delay: {
        band: [10, 30], step: 5, maxAddMs: 0.5, f11Band: [8, 16], f11FlagMs: 10,
        source: `${P}. 0.5 ms costs 5.4 deg of phase at 30 Hz and 1.8 deg at 10 Hz, about a tenth of a 45 deg phase margin. The Rotorflight documentation gives no number ("a filter too strong ... may lower the maximum gains later", FILT). f11FlagMs: the F11 flag of health_more.cjs`,
    },
    reduction: {
        minDb: 3, targetShare: 0.9, axisWorseDb: 0.25, minStepDb: 0.1, looMinShare: 0.8,
        source: `${P}. minDb: half of the noise power. targetShare: the smallest change that gives 90 % of the best reduction in dB. axisWorseDb: no axis may get more noise. looMinShare: in leave-one-flight-out, the set chosen without a flight must reduce the noise on that flight in 80 % of the folds`,
    },
    floors: { minLpfHz: 60, minNotchQ: 2.0, source: 'Rotorflight documentation (FILT): "not advised to lower it below 60hz", "not advised to lower the Q value below 2.0"; the same floors as advice.cjs RULES' },
    noise: { band: [30, 0.95], source: `${P}. 30 Hz: the edge of check F10 (health_more RULE.noise). The upper edge is 0.95 x the log Nyquist frequency: the log cannot show more` },
    lines: { prominence: 5, harmonicTol: 0.01, minOrder: 0.6, halfWidthBins: 2, source: `${P}. prominence 5 and 1 %: check F5 (health_setup RULES.lineProminence, advice RULES.harmonicTol)` },
    // tailOrder(): the order of the tail rotor notches (21-28) and of the main motor notch (10) from the log
    notchFit: {
        tailRange: [2.5, 8], motorRange: [3, 20], revs: 64, halfWindow: 0.5, candidates: 4, lineRatio: 10, lobeBins: 4, maxNyquist: 0.8, minDepthDb: 10, minPhaseJumpDeg: 90, maxDev: 0.1, minUnits: 3, minWindows: 10,
        gapFrames: 3, staticBand: 1.5, qGrid: [1, 25, 1.05], qRatio: 1.1, timeBase: 0.001, overlap: 0.003,
        source: `${P}. tailRange: tail rotor speed / rotor speed of helicopters (SAB Fireball 76/19 = 4.0, Gaui X4 II 61/15 = 4.07, 3 to 6 is usual). `
            + 'motorRange: motor rpm / rotor speed (main gear ratios of 3 to 20). revs: FFT windows of 64 revolutions (bins of 1/64 order, 25 or more bins across a notch of Q 5), '
            + 'Blackman-Harris window (sidelobes -92 dB: the tail line of the Gaui X4 is 44 dB over the broadband, a Hann window lets it into 8 bins next to it). '
            + 'halfWindow: the fit uses +-0.5 order around each dip. lineRatio, lobeBins: a line of gyroRAW (10 x the median power of the bins of the fit) is one point '
            + 'at its own order with the sums of its main lobe (+-4 bins of the Blackman-Harris window). A strong line in the skirt of the notch still moves the fit by up to 0.1 % '
            + '(synthetic: a 4 x line next to a notch at 4.067 x gives 4.069-4.071, without it 4.0667 +- 0.0019), which the SE over the units does not show. maxNyquist: bins up to 0.8 x the log Nyquist frequency. Above it the coherence of gyroADC with gyroRAW '
            + 'falls under 0.1 on the Fireball roll axis (390-460 Hz of a 1 kHz log) and the transfer has dips that no filter makes. '
            + 'minPhaseJumpDeg: a notch zero turns the phase of gyroADC / gyroRAW by 180 deg, and at its -3 dB points the notch phase is +-45 deg. So the mean phases of the two sides '
            + '(from 2 bins to one half-width from the dip) differ by 90 deg or more. Real dips: 121 deg (Fireball), 166-170 deg (Gaui X4). The other dips of their roll and pitch '
            + 'axes (no filter there): 4-54 deg. minDepthDb: |gyroADC / gyroRAW| at the fitted order is 10 dB (90 % of the power) or more under '
            + 'the level next to it. A flat transfer gives less than 3 dB. The real dips are 45 to 60 dB (Fireball) and 23 to 42 dB (Gaui X4, dynamic notch on). '
            + 'maxDev: every unit is within 0.1 notch half-width (order / (2 Q)) of the mean. At that distance the notch passes 10 % (-20 dB) of a line, 1 % of the '
            + 'order for Q 5 (for a fit on harmonic h of the group, in orders of X: the notch at h x X moves h times as far). The Fireball flights scatter by 0.03 %. minUnits: 3 units (flight logs, else '
            + 'blocks of 30 s) for an SE. minWindows: 10 windows in a unit. gapFrames: a logged frame interval of more than 3 nominal intervals is a gap or a stall; the revolutions count '
            + 'the nominal interval there (the time base of the other frames is the logged time: Gaui X4 #50 and #51 have 3 to 6.5 % of their intervals at 1050-1500 us, actualRate 1001.7 '
            + 'and 1003.8 Hz against a 987 us median, and their orders were 4.049 and 4.044 on the sample count against 4.065 on the logged time). staticBand: the bins within 1.5 -3 dB '
            + 'half-widths of a static notch of the header are left out (at one governed headspeed a static notch is a fixed order, and its dip passed every rule in a test: 3.19 x for a '
            + '160 Hz notch at 3000 rpm). qGrid: the Q of a dip, from 1 to 25 (the firmware range of the RPM notch Q) in steps of 5 %, then 0.5 %. qRatio: the Q of the dip must be nearer '
            + 'to the Q of its bank than to the Q of another notch that can make the same dip by 10 % or more (the dynamic notch: dyn_notch_q / 10 + 0.2 p, 2.5 to 3.5 for q 25 and 6 '
            + 'notches; the main motor notch of presets 2 and 3: Q 8 against tail Q 5 and 6). In a test, a dynamic notch on a 3 x line passed every other rule with the tail notch out of '
            + 'view (2.994 x), and the main motor notch at 7.5 x passed as the tail notch on preset 2 with tail 1x under main 4x and tail 2x out of view. timeBase: the SE of the '
            + 'order is the SE over the units and 0.1 % of the order (in quadrature): the orders of the same flights with the revolutions on the logged time and on the mean frame rate '
            + 'differ by 0.04 % (Fireball 2026-10-05, 6 flights, 4.0039 against 4.0023 for 76/19 = 4.0) to 0.16 % (Gaui X4 2026-10-04, 14 flights, 4.0706 against 4.0642 for 61/15 = 4.0667), '
            + 'which the scatter of the units does not show. overlap: a fit on a bank that overlaps a main rotor bank (presets 2 and 3: tail 1x next to main 3x and 4x, tail 2x out of '
            + 'view) adds 0.3 % of the order to its SE: in tests with presets 2 and 3 at 3000 rpm, such fits were 0.1 to 0.25 % from the configured order (61/15, 76/19)',
    },
};

// analysis parameters
const RULE = {
    windowS: 1,          // FFT window about 1 s (a power of two)
    states: 4,           // notch states (rotor speed, dynamic notch centres) averaged in each window: at the centres of 4 sub-blocks
    screenStates: 2,     // the same in the screening pass of the search
    rpmSpread: 0.01,     // a parity window has (max - min) / median headspeed of 1 % or less (near-constant rotor speed)
    rpmQuant: 2,         // rpm step of the cached RPM notch responses
    screenRpmStep: 0.004, // screening of RPM notch moves: windows grouped in headspeed steps of 0.4 % (the time domain verifies)
    dynQuant: 0.5,       // Hz step of the cached dynamic notch responses
    bands: [[30, 60], [60, 120], [120, 240], [240, 0.95]],   // parity bands, Hz (0.95: x the log Nyquist)
    orderStep: 0.01, maxOrder: 12,
    maxRounds: 3,
    blockS: 30,          // uncertainty and leave-one-out units when a file has fewer than 3 flight logs: 30 s blocks of flight
    verifyTop: 2,        // screened candidates verified in the time domain in each round
    leadS: 2,            // s simulated before each run of windows (the notches and the SDFT settle); the rest of the log is not simulated
    curveBins: 0.95,     // curves up to 0.95 x Nyquist
};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const arr = (v) => Array.isArray(v) ? v : (v === null || v === undefined ? null : [v]);
const hk = (h, k) => (h && h[k] !== undefined && h[k] !== null) ? h[k] : null;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const db = (ratio) => ratio > 0 ? 10 * Math.log10(ratio) : null;
const sum = (a) => { let s = 0; for (const v of a) s += v; return s; };
function meanSe(list) {
    const x = list.filter(v => typeof v === 'number' && isFinite(v)), n = x.length;
    if (!n) return { mean: null, se: null, n: 0 };
    const m = sum(x) / n, sd = n > 1 ? Math.sqrt(sum(x.map(v => (v - m) ** 2)) / (n - 1)) : null;
    return { mean: m, se: sd === null ? null : sd / Math.sqrt(n), n };
}
const median = (list) => { const s = Float64Array.from(list).sort(); return s.length ? s[s.length >> 1] : null; };
const andWords = (l) => l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : l.join('');

// ---------------------------------------------------------------------------------------------
// Firmware filter coefficients, as second-order sections [b0, b1, b2, a1, a2] (a0 = 1)
// ---------------------------------------------------------------------------------------------

const PASS = Object.freeze([1, 0, 0, 0, 0]);
const limitCutoff = (c, fs) => Math.min(c, FW.cutoffLimit * fs);
function pt1Gain(c, fs) {                       // pt1FilterGain
    if (!(c > 0 && fs > 0)) return 1;
    c = limitCutoff(c, fs);
    return Math.min(c / (c + fs / (2 * Math.PI)), 1);
}
const ptSection = (alpha) => [alpha, 0, 0, alpha - 1, 0];   // y += (x - y) alpha
function firstOrderLpf(c, fs) {                 // firstOrderLPFUpdate (bilinear)
    if (!(c > 0 && fs > 0)) return PASS.slice();
    c = limitCutoff(c, fs);
    const W = Math.tan(Math.PI * c / fs), b0 = W / (W + 1);
    return [b0, b0, 0, (W - 1) / (W + 1), 0];
}
function biquad(kind, c, fs, Q) {               // biquadFilterUpdate: RBJ cookbook, a0 = 1 + alpha
    if (!(c > 0 && fs > 0 && Q > 0)) return PASS.slice();
    c = limitCutoff(c, fs);
    const w = 2 * Math.PI * c / fs, sn = Math.sin(w), cs = Math.cos(w), al = sn / (2 * Q), a0 = 1 + al;
    if (kind === 'lpf') { const b1 = 1 - cs; return [b1 / 2 / a0, b1 / a0, b1 / 2 / a0, -2 * cs / a0, (1 - al) / a0]; }
    return [1 / a0, -2 * cs / a0, 1 / a0, -2 * cs / a0, (1 - al) / a0];   // notch
}
function difSection(c, fs) {                   // difFilterUpdate: H = b (1 - z^-1) / (1 + a z^-1); cutoff 0 gives 0
    if (!(c > 0 && fs > 0)) return [0, 0, 0, 0, 0];
    c = limitCutoff(c, fs / 2);
    const W = Math.tan(Math.PI * c / fs), b = 2 * fs * W / (W + 1);
    return [b, -b, 0, (W - 1) / (W + 1), 0];
}
// lowpassFilterInit: the sections of one LPF of a type index (FW.LPF)
function lowpassSections(type, c, fs) {
    if (!(c > 0)) return [];
    switch (type) {
        case 1: case 6: return [firstOrderLpf(c, fs)];
        case 2: case 8: return [biquad('lpf', FW.c.bessel * c, fs, FW.q.bessel)];
        case 7: return [biquad('lpf', FW.c.butter * c, fs, FW.q.butter)];
        case 9: return [biquad('lpf', FW.c.damped * c, fs, FW.q.damped)];
        case 3: return [ptSection(pt1Gain(c, fs))];
        case 4: { const g = pt1Gain(c * FW.pt2, fs); return [ptSection(g), ptSection(g)]; }
        case 5: { const g = pt1Gain(c * FW.pt3, fs); return [ptSection(g), ptSection(g), ptSection(g)]; }
        default: return [];
    }
}
// notchFilterGetQ: Q from centre and lower cutoff
const notchQ = (center, cutoff) => (center > 0 && cutoff > 0 && cutoff < center) ? center * cutoff / (center * center - cutoff * cutoff) : 0;
// the lower cutoff that gives a Q (inverse of notchQ), rounded as a CLI integer
const notchCutoffFor = (center, Q) => Math.round(center * (Math.sqrt(1 + 4 * Q * Q) - 1) / (2 * Q));
// transition (maths.h:293)
const transition = (x, x0, x1, y0, y1) => x > x1 ? y1 : x < x0 ? y0 : y0 + (x - x0) * (y1 - y0) / (x1 - x0);
// -3 dB width of an RBJ notch: alpha = tan(dw / 2) (Regalia-Mitra form), so a notch can be redesigned at another rate with
// the same centre and width in Hz (used only for the time-domain tracker on a log at a lower rate than the filters)
function notchAt(center, Q, fsFrom, fsTo) {
    if (fsFrom === fsTo) return biquad('notch', center, fsTo, Q);
    if (!(center > 0) || center >= 0.5 * fsTo) return PASS.slice();
    const w0 = 2 * Math.PI * Math.min(center, FW.cutoffLimit * fsFrom) / fsFrom, al = Math.sin(w0) / (2 * Q), dw = 2 * Math.atan(al), df = dw * fsFrom / (2 * Math.PI);
    const w1 = 2 * Math.PI * center / fsTo, al2 = Math.tan(Math.PI * df / fsTo), Q2 = Math.sin(w1) / (2 * al2);
    return Q2 > 0 ? biquad('notch', center, fsTo, Q2) : PASS.slice();
}

// ---------------------------------------------------------------------------------------------
// Configuration: header first, the CLI dump only for what the header lacks
// ---------------------------------------------------------------------------------------------

const lpfIndex = (v) => typeof v === 'number' ? v : typeof v === 'string' ? Math.max(0, FW.LPF.indexOf(v.trim().toUpperCase())) : null;
const pad16 = (a) => Array.from({ length: FW.rpmBanks }, (_, i) => (a && +a[i]) || 0);

/**
 * cfg = { s: settings by CLI name (LPF types as index, notch arrays as 16 numbers, DYN_NOTCH and RPM_FILTER as features),
 *         from: the source of each setting ('header', 'cli', 'default'), rates, gear, pid: { [profile|'header']: per axis
 *         { gyro_cutoff, d_cutoff, P, D, from } }, notes }
 * opts: { cli (text or health_setup.parseCli result), gear: { main: [a, b], tail: [a, b], motorisedTail }, actualRate,
 *         logGear (tailOrder().gear: the notch orders that the log shows, used only when neither gear nor the CLI gives them) }
 */
function config(header, opts = {}) {
    const h = header || {}, cli = opts.cli ? (typeof opts.cli === 'string' ? setup.parseCli(opts.cli) : opts.cli) : null, g = cli ? cli.global : {};
    const s = {}, from = {}, notes = [];
    const take = (name, hv, cv, def) => {
        if (hv !== null && hv !== undefined) { s[name] = hv; from[name] = 'header'; }
        else if (cv !== null && cv !== undefined) { s[name] = cv; from[name] = 'cli'; }
        else { s[name] = def; from[name] = 'default'; }
    };
    const el = (k, i) => { const v = arr(hk(h, k)); return v && v.length > i ? +v[i] : null; };
    take('gyro_lpf1_type', lpfIndex(hk(h, 'gyro_soft_type')), lpfIndex(g.gyro_lpf1_type), 1);
    take('gyro_lpf1_static_hz', hk(h, 'gyro_lowpass_hz'), g.gyro_lpf1_static_hz, 100);
    take('gyro_lpf2_type', lpfIndex(hk(h, 'gyro_soft2_type')), lpfIndex(g.gyro_lpf2_type), 0);
    take('gyro_lpf2_static_hz', hk(h, 'gyro_lowpass2_hz'), g.gyro_lpf2_static_hz, 50);
    take('gyro_lpf1_dyn_min_hz', el('gyro_lowpass_dyn_hz', 0), g.gyro_lpf1_dyn_min_hz, 0);
    take('gyro_lpf1_dyn_max_hz', el('gyro_lowpass_dyn_hz', 1), g.gyro_lpf1_dyn_max_hz, 0);
    take('gyro_notch1_hz', el('gyro_notch_hz', 0), g.gyro_notch1_hz, 0);
    take('gyro_notch2_hz', el('gyro_notch_hz', 1), g.gyro_notch2_hz, 0);
    take('gyro_notch1_cutoff', el('gyro_notch_cutoff', 0), g.gyro_notch1_cutoff, 0);
    take('gyro_notch2_cutoff', el('gyro_notch_cutoff', 1), g.gyro_notch2_cutoff, 0);
    take('dyn_notch_count', hk(h, 'dyn_notch_count'), g.dyn_notch_count, 6);
    take('dyn_notch_q', hk(h, 'dyn_notch_q'), g.dyn_notch_q, 25);
    take('dyn_notch_min_hz', hk(h, 'dyn_notch_min_hz'), g.dyn_notch_min_hz, 20);
    take('dyn_notch_max_hz', hk(h, 'dyn_notch_max_hz'), g.dyn_notch_max_hz, 240);
    take('gyro_rpm_notch_preset', hk(h, 'gyro_rpm_notch_preset'), g.gyro_rpm_notch_preset, 2);
    take('gyro_rpm_notch_min_hz', hk(h, 'gyro_rpm_notch_min_hz'), g.gyro_rpm_notch_min_hz, 20);
    for (const ax of AXES) for (const k of ['source', 'q', 'center']) {
        const name = `gyro_rpm_notch_${k}_${ax}`, hv = arr(hk(h, name)), cv = arr(g[name]);
        take(name, hv ? pad16(hv) : null, cv ? pad16(cv) : null, null);
    }
    const feat = hk(h, 'features');
    for (const [name, bit] of Object.entries(FW.features)) {
        const cv = cli && cli.features[name] !== undefined ? cli.features[name] : null;
        take(name, typeof feat === 'number' ? ((feat >>> bit) & 1) === 1 : null, cv, null);
    }
    // rates (gyro_init.c:627-643, config.c:577-660)
    const looptime = hk(h, 'looptime'), pidDenom = hk(h, 'pid_process_denom') || 1;
    let filtDenom = hk(h, 'filter_process_denom') || pidDenom;
    if (filtDenom < pidDenom) while (pidDenom % filtDenom) filtDenom++; else filtDenom = pidDenom;
    const gyroHz = looptime ? 1e6 / looptime : null, pNum = hk(h, 'frameIntervalPNum') || 1, pDen = hk(h, 'frameIntervalPDenom') || 1;
    const dec = (hk(h, 'unknownHeaders') || []).find(u => u.name === 'gyro_decimation_hz');
    take('gyro_decimation_hz', dec ? +dec.value : hk(h, 'gyro_decimation_hz'), g.gyro_decimation_hz, null);
    take('motor_rpm_lpf', arr(hk(h, 'motor_rpm_lpf')), arr(g.motor_rpm_lpf), null);
    const rates = { gyroHz, pidDenom, filtDenom, pidHz: gyroHz && gyroHz / pidDenom, filterHz: gyroHz && gyroHz / filtDenom, logHz: gyroHz && gyroHz / pidDenom * pNum / pDen,
        loopsPerFrame: pDen / pNum, decimationHz: s.gyro_decimation_hz };
    rates.offsetTicks = FW.bbCounter[Math.min(8, pidDenom)] - Math.floor(FW.bbCounter[Math.min(8, pidDenom)] / filtDenom) * filtDenom;
    rates.scale = opts.actualRate && rates.logHz ? opts.actualRate / rates.logHz : 1;
    if (!gyroHz) notes.push('The log header has no looptime. The filter rates are unknown.');
    // gear ratios: not in the header (blackbox.c writes none); from opts.gear or the CLI dump (health_setup gearOf)
    let gear = opts.gear || null;
    if (!gear && cli) {
        const dflt = cli.kind === 'diff' ? [1, 1] : null, mode = g.tail_rotor_mode === undefined || g.tail_rotor_mode === null ? 'VARIABLE' : String(g.tail_rotor_mode).trim().toUpperCase();
        gear = { main: arr(g.main_rotor_gear_ratio) || dflt, tail: arr(g.tail_rotor_gear_ratio) || dflt, motorisedTail: mode !== 'VARIABLE' && mode !== '0', source: 'cli' };
    }
    // no CLI dump: the notch orders that the log shows (tailOrder), the configured values that the firmware notches use
    if (!gear && opts.logGear) gear = Object.assign({}, opts.logGear);
    // PID path per profile: the header holds the profile at arming; the CLI sections the others
    const bw = (ax) => arr(hk(h, `${ax}BW`)), pid = (ax) => arr(hk(h, `${ax}PID`));
    const entry = (a,i) => a && a[i] !== null && a[i] !== undefined && Number.isFinite(+a[i]) ? +a[i] : null;
    const pidHeader = Object.fromEntries(AXES.map(ax => [ax, { gyro_cutoff: entry(bw(ax),0), d_cutoff: entry(bw(ax),1), P: entry(pid(ax),0), D: entry(pid(ax),2), from: 'header' }]));
    const stop = arr(hk(h, 'yaw_stop_gain'));
    if (stop && stop.length >= 2) pidHeader.yaw.stopGain = [stop[1] / 100, stop[0] / 100];
    const pidCli = {};
    if (cli) for (const [k, sec] of Object.entries(cli.profiles)) pidCli[+k + 1] = Object.fromEntries(AXES.map(ax => [ax, {
        gyro_cutoff: sec[`${ax}_gyro_cutoff`] !== undefined ? +sec[`${ax}_gyro_cutoff`] : null, d_cutoff: sec[`${ax}_d_cutoff`] !== undefined ? +sec[`${ax}_d_cutoff`] : null,
        P: sec[`${ax}_p_gain`] !== undefined ? +sec[`${ax}_p_gain`] : null, D: sec[`${ax}_d_gain`] !== undefined ? +sec[`${ax}_d_gain`] : null, from: 'cli' }]));
    if (cli) for (const [k, sec] of Object.entries(cli.profiles)) {
        if (Number.isFinite(sec.yaw_ccw_stop_gain) && Number.isFinite(sec.yaw_cw_stop_gain))
            pidCli[+k + 1].yaw.stopGain = [sec.yaw_ccw_stop_gain / 100, sec.yaw_cw_stop_gain / 100];
    }
    return { s, from, rates, gear, pid: { header: pidHeader, cli: pidCli }, notes, cliKind: cli ? cli.kind : null };
}

// the settings with some CLI names changed (a candidate); arrays are copied
function withSettings(cfg, changes) {
    const s = {}; for (const [k, v] of Object.entries(cfg.s)) s[k] = Array.isArray(v) ? v.slice() : v;
    for (const [k, v] of Object.entries(changes || {})) s[k] = Array.isArray(v) ? v.slice() : v;
    return Object.assign({}, cfg, { s });
}

// the RPM notch banks the firmware runs (validateAndFixRPMFilterConfig + rpmFilterInit): per axis [{ source, q, center }]
function effectiveBanks(s) {
    const preset = s.gyro_rpm_notch_preset;
    return AXES.map((ax, a) => {
        if (preset >= 1 && preset <= 3) { const p = PRESETS[preset][a]; return p.source.map((src, i) => ({ source: src, q: p.q[i], center: p.center[i] })); }
        const src = s[`gyro_rpm_notch_source_${ax}`], q = s[`gyro_rpm_notch_q_${ax}`], c = s[`gyro_rpm_notch_center_${ax}`];
        if (preset > 3) { const p = PRESETS[2][a]; return p.source.map((v, i) => ({ source: v, q: p.q[i], center: p.center[i] })); }  // PG_RESET: preset 2
        if (!src || !q) return null;   // custom banks unknown (no header arrays, no CLI)
        return src.map((v, i) => ({ source: v, q: q[i], center: (c && c[i]) || 0 })).filter(b => b.source && b.q);
    });
}

/**
 * compile(cfg) -> the replica: rates, per axis the RPM banks (mult: notch Hz per rpm of the reference speed), the static
 * sections (LPF2, LPF1, notch2, notch1 at the filter rate), the dynamic notch, and the PID path per profile.
 */
function compile(cfg) {
    const s = cfg.s, R = cfg.rates, notes = [], fsF = R.filterHz, gear = cfg.gear;
    const limit = R.gyroHz ? Math.round(FW.configLimit * R.gyroHz / R.filtDenom) : Infinity;
    // validateAndFixGyroConfig: LPF above the limit -> the limit; hz 0 -> NONE
    const lpf = (t, hz) => { let c = hz > limit ? limit : hz; return c > 0 && t > 0 ? { type: t, hz: c } : null; };
    const L2 = lpf(s.gyro_lpf2_type, s.gyro_lpf2_static_hz), L1 = lpf(s.gyro_lpf1_type, s.gyro_lpf1_static_hz);
    const dynLpf = L1 && s.gyro_lpf1_dyn_min_hz > 0 && s.gyro_lpf1_dyn_min_hz <= s.gyro_lpf1_dyn_max_hz && s.gyro_lpf1_dyn_min_hz <= L1.hz && s.gyro_lpf1_dyn_max_hz >= L1.hz;
    if (dynLpf) notes.push('The dynamic LPF1 cutoff follows the governor headspeed ratio.');
    const notch = (hz, co) => {
        if (hz > limit) hz = limit; if (co > limit) co = 0; if (co >= hz) return null;
        const nyq = fsF / 2; if (hz > nyq) hz = co < nyq ? nyq : 0;
        const q = hz > 0 && co > 0 ? notchQ(hz, co) : 0; return hz > 0 && q > 0 ? { hz, q } : null;
    };
    const N2 = notch(s.gyro_notch2_hz, s.gyro_notch2_cutoff), N1 = notch(s.gyro_notch1_hz, s.gyro_notch1_cutoff);
    const statics = [];   // recipes, in chain order after the RPM notches
    if (L2) statics.push({ kind: 'lpf', name: 'LPF2', type: L2.type, hz: L2.hz });
    if (L1) statics.push({ kind: 'lpf', name: 'LPF1', type: L1.type, hz: L1.hz });
    if (N2) statics.push({ kind: 'notch', name: 'notch2', hz: N2.hz, q: N2.q });
    if (N1) statics.push({ kind: 'notch', name: 'notch1', hz: N1.hz, q: N1.q });
    const sectionsOf = (st, fs) => st.kind === 'lpf' ? lowpassSections(st.type, st.hz, fs) : [biquad('notch', st.hz, fs, st.q)];
    // RPM notches
    const rpmOn = s.RPM_FILTER !== false, maxHz = FW.notchMax * fsF, minHz = clamp(s.gyro_rpm_notch_min_hz, FW.minHzLo, 0.5 * maxHz);
    // ratios as the firmware has them (motors.c:251-258); a fitted order (tailOrder, basis 'log notch') gives them directly
    const ratio = (p) => p ? Math.max(+p[0], 1) / Math.max(+p[1], 1) : null;
    const mainGR = gear ? (gear.motorOrder > 0 ? 1 / gear.motorOrder : ratio(gear.main)) : null, tailCfg = gear ? (gear.tailOrder > 0 ? 1 / gear.tailOrder : ratio(gear.tail)) : null;
    const banks = effectiveBanks(s), rpm = [], leftOut = [];
    for (let a = 0; a < 3; a++) {
        const list = [];
        if (rpmOn && banks[a] === null) notes.push(`The ${AXES[a]} RPM notch banks are unknown (preset 0 and no bank arrays).`);
        if (rpmOn && banks[a]) for (const b of banks[a]) {
            const src = b.source, k = 1 + b.center / 10000, Q = clamp(b.q, 10, 250) / 10;
            let ref = 'hs', mult = null, label;
            if (src === 10) { label = 'main motor'; if (mainGR === 1) continue; mult = mainGR ? k / mainGR / 60 : null; }
            else if (src >= 11 && src <= 18) { label = `main rotor ${src - 10}x`; mult = (src - 10) * k / 60; }
            else if (src === 20) { label = 'tail motor'; // only on a motorised tail. Unknown (no gear, or gear.motorisedTail null: the fit of the log did not
                // show the tail notch, so a motorised tail is possible): left out, with a note
                if (!gear || gear.motorisedTail === null || gear.motorisedTail === undefined) { leftOut.push({ axis: AXES[a], source: src, label }); continue; }
                if (!gear.motorisedTail || tailCfg === 1) continue; ref = 'tail'; mult = k / tailCfg / 60; }
            else if (src >= 21 && src <= 28) { label = `tail rotor ${src - 20}x`; if (gear && gear.motorisedTail) { ref = 'tail'; mult = (src - 20) * k / 60; } else mult = tailCfg ? (src - 20) * k / tailCfg / 60 : null; }
            else { notes.push(`RPM notch source ${src} is not valid; the firmware does not arm (rpm_filter.c:243).`); continue; }
            if (mult === null) leftOut.push({ axis: AXES[a], source: src, label });
            list.push({ source: src, q: Q, center: b.center, ref, mult, label, order: ref === 'hs' && mult !== null ? mult * 60 : null });
        }
        rpm.push(list);
    }
    // one note for each notch that the model does not have (its frequency is not known: no gear ratio, and the log did not show it)
    for (const label of [...new Set(leftOut.map(x => x.label))]) {
        const axes = AXES.filter(ax => leftOut.some(x => x.label === label && x.axis === ax));
        notes.push(`The app does not know the frequency of the RPM notch filter "${label}" on the ${andWords(axes)} ${axes.length > 1 ? 'axes' : 'axis'}. Thus, the model does not have this filter.`);
    }
    // dynamic notch (dyn_notch_filter.c:147-197)
    const dynOn = s.DYN_NOTCH === true && s.dyn_notch_count > 0 && R.pidHz >= FW.dynMinUpdateHz;
    let dyn = { on: false };
    if (s.DYN_NOTCH === true && s.dyn_notch_count > 0 && !(R.pidHz >= FW.dynMinUpdateHz)) notes.push(`The PID loop rate (${r(R.pidHz, 0)} Hz) is less than 1000 Hz. The firmware turns the dynamic notch off.`);
    if (dynOn) {
        const nyq = R.pidHz / 2, minD = Math.max(s.dyn_notch_min_hz, 10), maxD = Math.min(Math.max(minD, s.dyn_notch_max_hz), nyq);
        const count = Math.min(s.dyn_notch_count, FW.dynCountMax), sampleCount = Math.max(1, Math.floor(nyq / maxD)), sdftHz = R.pidHz / sampleCount, res = sdftHz / FW.sdftN;
        const startBin = Math.max(2, Math.round(minD / res)), endBin = Math.min(FW.sdftN / 2 - 1, Math.round(maxD / res));
        dyn = { on: true, count, q: s.dyn_notch_q / 10, minHz: minD, maxHz: maxD, sampleCount, sdftHz, res, startBin, endBin, rcp: 1 / (sampleCount * (R.filterHz / R.pidHz)) };
    }
    // PID path: the profile at arming from the header; others from the CLI section when the CLI agrees with the header
    return { cfg, rates: R, rpm, rpmMinHz: minHz, rpmMaxHz: maxHz, rpmFadeHz: FW.fade * minHz, statics, sectionsOf, dyn, notes, dynLpf, leftOut };
}

// the PID path of an axis in one PID profile (pid.c): first-order gyro filter, difFilter D, gains as fractions per deg/s
function pidPath(cfg, profile, a, override) {
    const ax = AXES[a], base = (cfg.pid.cli[profile] && cfg.pid.cli[profile][ax] && cfg.pid.cli[profile][ax].d_cutoff !== null) ? cfg.pid.cli[profile][ax] : cfg.pid.header[ax];
    const v = Object.assign({}, base, override || {});
    return { gyro_cutoff: v.gyro_cutoff, d_cutoff: v.d_cutoff, Kp: (v.P || 0) * lib.SCALE.P[a], Kd: (v.D || 0) * lib.SCALE.D[a], from: base.from };
}

// ---------------------------------------------------------------------------------------------
// Frequency response
// ---------------------------------------------------------------------------------------------

// multiply (re, im) by the response of section c at the frequencies f (Hz) for a filter running at fs (both nominal)
const trigCache = new Map();
function trigOf(f, fs) {
    let byFs = trigCache.get(f); if (!byFs) { if (trigCache.size > 8) trigCache.clear(); trigCache.set(f, byFs = new Map()); }
    let t = byFs.get(fs); if (!t) { const n = f.length; t = { c1: new Float64Array(n), s1: new Float64Array(n), c2: new Float64Array(n), s2: new Float64Array(n) };
        for (let k = 0; k < n; k++) { const w = 2 * Math.PI * f[k] / fs; t.c1[k] = Math.cos(w); t.s1[k] = Math.sin(w); t.c2[k] = Math.cos(2 * w); t.s2[k] = Math.sin(2 * w); } byFs.set(fs, t); }
    return t;
}
function mulSection(c, fs, f, re, im, mix) {
    const [b0, b1, b2, a1, a2] = c;
    if (f.length > 16 || f === DELAY_ALL) { const T = trigOf(f, fs);
        for (let k = 0; k < f.length; k++) {
            const c1 = T.c1[k], s1 = T.s1[k], c2 = T.c2[k], s2 = T.s2[k];
            const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2), d = dr * dr + di * di;
            let hr = (nr * dr + ni * di) / d, hi = (ni * dr - nr * di) / d;
            if (mix !== undefined) { hr = 1 + mix * (hr - 1); hi = mix * hi; }
            const xr = re[k], xi = im[k]; re[k] = xr * hr - xi * hi; im[k] = xr * hi + xi * hr;
        }
        return;
    }
    for (let k = 0; k < f.length; k++) {
        const w = 2 * Math.PI * f[k] / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
        const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2), d = dr * dr + di * di;
        let hr = (nr * dr + ni * di) / d, hi = (ni * dr - nr * di) / d;
        if (mix !== undefined) { hr = 1 + mix * (hr - 1); hi = mix * hi; }
        const xr = re[k], xi = im[k]; re[k] = xr * hr - xi * hi; im[k] = xr * hi + xi * hr;
    }
}
// one RPM bank at a rotor (or tail) speed: notch at the filter rate x cycle-time multiplier (rpm_filter.c:295-340)
function rpmBankSection(model, b, speed) {
    const freq = speed * b.mult, center = clamp(freq, model.rpmMinHz, model.rpmMaxHz), fader = transition(freq, model.rpmMinHz, model.rpmFadeHz, 0, 1);
    const mult = clamp(model.rates.scale, 0.75, 1.25), c = biquad('notch', center, model.rates.filterHz * mult, b.q);
    return { c, fader };
}

/**
 * Complex response of the gyro chain of one axis (gyroRAW -> gyroADC, without the logging offset) at frequencies f (nominal Hz):
 * state = { hs, tail, dyn: [centres] }. parts: 'all' | 'rpm' | 'static' | 'dyn'.
 */
function chainResponse(model, a, f, state, parts = 'all') {
    const re = new Float64Array(f.length).fill(1), im = new Float64Array(f.length), fs = model.rates.filterHz;
    if (parts === 'all' || parts === 'rpm') for (const b of model.rpm[a]) {
        if (b.mult === null) continue;
        const speed = b.ref === 'tail' ? state.tail : state.hs; if (!(speed > 0)) continue;
        const { c, fader } = rpmBankSection(model, b, speed);
        if (fader > 0) mulSection(c, fs, f, re, im, fader);
    }
    if (parts === 'all' || parts === 'static') for (const st of model.statics) for (const c of model.sectionsOf(st, fs)) mulSection(c, fs, f, re, im);
    if ((parts === 'all' || parts === 'dyn') && model.dyn.on && state.dyn) state.dyn.forEach((cen, p) => mulSection(biquad('notch', cen, fs, model.dyn.q + p * FW.dynQAdvance), fs, f, re, im));
    return { re, im };
}

// the PID path response at the PID rate: first-order gyro filter, and the PID output of the gyro part |Kp + Kd dif|
const pidCache = new Map(), pidCacheD = new Map(); let pidGrid = null;
function pidResponse(model, path, f) {
    if (f.length > 16 || f === DELAY_ALL) { const pc = f === DELAY_ALL ? pidCacheD : pidCache; if (f !== DELAY_ALL && pidGrid !== f) { pidCache.clear(); pidGrid = f; }
        const key = `${model.rates.pidHz}|${path.gyro_cutoff}|${path.d_cutoff}|${path.Kp}|${path.Kd}`; let v = pc.get(key);
        if (!v) { v = pidResponseCalc(model, path, f); if (pc.size > 512) pc.clear(); pc.set(key, v); } return v; }
    return pidResponseCalc(model, path, f);
}
function pidResponseCalc(model, path, f) {
    const fs = model.rates.pidHz, g = { re: new Float64Array(f.length).fill(1), im: new Float64Array(f.length) };
    mulSection(firstOrderLpf(path.gyro_cutoff, fs), fs, f, g.re, g.im);
    const d = { re: new Float64Array(f.length).fill(1), im: new Float64Array(f.length) };
    mulSection(difSection(path.d_cutoff, fs), fs, f, d.re, d.im);
    const out = new Float64Array(f.length), gain = new Float64Array(f.length);
    for (let k = 0; k < f.length; k++) {
        const tr = path.Kp + path.Kd * d.re[k], ti = path.Kd * d.im[k];    // Kp + Kd dif (both act on the filtered gyro)
        gain[k] = g.re[k] ** 2 + g.im[k] ** 2; out[k] = gain[k] * (tr * tr + ti * ti);
    }
    return { gyro: gain, out, gyroC: g, difC: d };
}

// ---------------------------------------------------------------------------------------------
// Time domain: the chain on the logged gyroRAW (rpm_filter.c, gyro_filter_impl.c, dyn_notch_filter.c, sdft.c)
// ---------------------------------------------------------------------------------------------

/**
 * runChain(model, seg, mode) -> { y: [Float32Array x 3], track: [per axis { at, c, count }] | null }
 * mode 'rpm': the RPM notch banks only. They change with the headspeed sample by sample and follow their lines, which a
 * windowed spectrum cannot show; the static filters and the PID path are then applied exactly in the frequency domain at the
 * firmware rates. mode 'all': RPM banks, the static filters at the log rate, and the dynamic notch with its peak tracking, tick
 * by tick of the PID loop, notches switched as the firmware does (DF1 state kept through a switch). The dynamic notch needs
 * the time domain: on the Gaui X4 logs its switching leaks stored filter state into 10-60 Hz, 2.5 times the power at 10-20
 * Hz when the LPF before it is removed. Exact when the log rate is the filter rate (one frame for each PID loop, filter denom
 * = PID denom); else the stages are redesigned at the log rate (same centres, cutoffs and notch widths in Hz) and each frame
 * stands for the PID loops between frames (a stated approximation; the static part is corrected in the frequency domain).
 */
function runChain(model, seg, mode = 'all', spans) {
    const R = model.rates, fsL = R.logHz, fsF = R.filterHz, n = seg.n, mult = clamp(R.scale, 0.75, 1.25);
    const D = mode === 'all' && model.dyn.on ? model.dyn : null, count = D ? D.count : 0;
    const statics = []; if (mode === 'all') for (const st of model.statics) { if (st.kind === 'lpf') for (const c of lowpassSections(st.type, st.hz, fsL)) statics.push(c); else statics.push(notchAt(st.hz, st.q, fsF, fsL)); }
    const banks = model.rpm.map(list => list.filter(b => b.mult !== null));
    const bankCoef = (b, key) => { const freq = key * b.mult, center = clamp(freq, model.rpmMinHz, model.rpmMaxHz);
        return { c: fsL === fsF ? biquad('notch', center, fsF * mult, b.q) : notchAt(center, b.q, fsF * mult, fsL * mult), fader: transition(freq, model.rpmMinHz, model.rpmFadeHz, 0, 1) }; };
    const designDyn = (c, p) => { const q = D.q + p * FW.dynQAdvance; return fsL === fsF ? biquad('notch', c, fsF, q) : notchAt(c, q, fsF, fsL); };
    // coefficients for every integer speed up to the largest of the segment (the logged speeds are integers)
    let maxSp = 0; for (let i = 0; i < n; i++) { if (seg.hs[i] > maxSp) maxSp = seg.hs[i]; if (seg.tail && seg.tail[i] > maxSp) maxSp = seg.tail[i]; }
    const MB = Math.max(1, ...banks.map(l => l.length)), MS = Math.max(1, statics.length), MC = Math.max(1, count), NS = FW.sdftN, NB = NS / 2;
    const tSize = Math.min(30001, Math.ceil(maxSp) + 2);
    const X = {
        n, raw0: seg.raw[0], raw1: seg.raw[1], raw2: seg.raw[2], hs: seg.hs, tail: seg.tail || new Float64Array(n), y0: new Float32Array(n), y1: new Float32Array(n), y2: new Float32Array(n),
        MB, MS, MC, nB: Int32Array.from(banks.map(l => l.length)), isTail: new Uint8Array(3 * MB), tSize,
        tabC: Array.from({ length: 3 * MB }, () => new Float64Array(5 * tSize)), tabF: Array.from({ length: 3 * MB }, () => new Float64Array(tSize)), tabOk: Array.from({ length: 3 * MB }, () => new Uint8Array(tSize)),
        fill: (q, key) => { const a = Math.floor(q / MB), j = q % MB, e = bankCoef(banks[a][j], key); X.tabC[q].set(e.c, key * 5); X.tabF[q][key] = e.fader; X.tabOk[q][key] = 1; },
        sc: new Float64Array(MS * 5), nS: statics.length, count, D: D ? 1 : 0,
        bst: new Float64Array(3 * MB * 4), sst: new Float64Array(3 * MS * 4), dcf: new Float64Array(3 * MC * 5), dst: new Float64Array(3 * MC * 4), v: new Float64Array(3),
        // dynamic notch state (dyn_notch_filter.c, sdft.c)
        loops: Math.max(1, Math.round(R.loopsPerFrame)), fpl: R.pidDenom / R.filtDenom, sampleCount: D ? D.sampleCount : 1, rcp: D ? D.rcp : 1, rN: Math.pow(FW.sdftR, NS),
        twr: new Float64Array(NB), twi: new Float64Array(NB), start: D ? D.startBin : 0, end: D ? D.endBin : 0, numBatches: D ? Math.max(1, D.sampleCount) : 1,
        sre: new Float64Array(3 * NB), sim: new Float64Array(3 * NB), sx: new Float64Array(3 * NS), sidx: new Int32Array(3), acc: new Float64Array(3), avg: new Float64Array(3), data: new Float64Array(NB),
        pkBin: new Int32Array(MC), pkVal: new Float64Array(MC), cen: new Float64Array(3 * MC), ints: new Int32Array(4),   // tick, step, axis, sampleIndex
        res: D ? D.res : 1, minHz: D ? D.minHz : 0, maxHz: D ? D.maxHz : 0, setDyn: (a, p, c) => X.dcf.set(designDyn(c, p), (a * MC + p) * 5),
        out: D ? [0, 1, 2].map(() => ({ at: [], c: [] })) : null,
    };
    X.batchSize = D ? Math.floor((X.end - X.start + 1) / X.numBatches) : 0;
    banks.forEach((l, a) => l.forEach((b, j) => { X.isTail[a * MB + j] = b.ref === 'tail' ? 1 : 0; }));
    statics.forEach((c, j) => X.sc.set(c, j * 5));
    for (let i = 0; i < NB; i++) { X.twr[i] = FW.sdftR * Math.cos(2 * Math.PI * i / NS); X.twi[i] = FW.sdftR * Math.sin(2 * Math.PI * i / NS); }
    for (const [s0, s1] of (spans && spans.length ? spans : [[0, n]])) {
        // fresh state at the start of each span (the lead-in before the first window lets the notches and the SDFT settle)
        X.bst.fill(0); X.sst.fill(0); X.dst.fill(0); X.sre.fill(0); X.sim.fill(0); X.sx.fill(0); X.sidx.fill(0); X.acc.fill(0); X.avg.fill(0); X.ints.fill(0);
        if (D) for (let a = 0; a < 3; a++) { X.out[a].at.push(s0);
            for (let p = 0; p < count; p++) { const c = (p + 0.5) * (D.maxHz - D.minHz) / count + D.minHz; X.cen[a * MC + p] = c; X.setDyn(a, p, c); X.out[a].c.push(c); } }
        chainLoop(X, s0, s1);
    }
    return { y: [X.y0, X.y1, X.y2], track: D ? X.out.map(o => ({ at: Int32Array.from(o.at), c: Float32Array.from(o.c), count })) : null };
}
// the per-sample part of runChain: RPM banks (rpmFilterGyro), static sections, the dynamic notches, then the PID loops
function chainLoop(X, s0, s1) {
    const MB = X.MB, MS = X.MS, MC = X.MC, nS = X.nS, count = X.count, bst = X.bst, sst = X.sst, sc = X.sc, dcf = X.dcf, dst = X.dst, v = X.v, hs = X.hs, tail = X.tail, isTail = X.isTail, tSize = X.tSize;
    const lastK = new Int32Array(3 * MB).fill(-1), off = new Int32Array(3 * MB), fad = new Float64Array(3 * MB), tabs = new Array(3 * MB).fill(X.tabC[0]), nB = X.nB;
    for (let i = s0; i < s1; i++) {
        const hsi = hs[i], tli = tail[i];
        for (let a = 0; a < 3; a++) {
            let x = a === 0 ? X.raw0[i] : a === 1 ? X.raw1[i] : X.raw2[i];
            for (let j = 0, nb = nB[a]; j < nb; j++) {
                const q = a * MB + j, speed = isTail[q] ? tli : hsi; if (!(speed > 0)) continue;
                const key = Math.min(tSize - 1, Math.round(speed));
                if (key !== lastK[q]) { lastK[q] = key; if (!X.tabOk[q][key]) X.fill(q, key); off[q] = key * 5; fad[q] = X.tabF[q][key]; tabs[q] = X.tabC[q]; }
                const fader = fad[q]; if (!(fader > 0)) continue;
                const bc = tabs[q], o = off[q], t = q * 4, u = bc[o] * x + bc[o + 1] * bst[t] + bc[o + 2] * bst[t + 1] - bc[o + 3] * bst[t + 2] - bc[o + 4] * bst[t + 3];
                bst[t + 1] = bst[t]; bst[t] = x; bst[t + 3] = bst[t + 2]; bst[t + 2] = u; x += (u - x) * fader;
            }
            for (let j = 0; j < nS; j++) { const o = j * 5, t = (a * MS + j) * 4, u = sc[o] * x + sc[o + 1] * sst[t] + sc[o + 2] * sst[t + 1] - sc[o + 3] * sst[t + 2] - sc[o + 4] * sst[t + 3];
                sst[t + 1] = sst[t]; sst[t] = x; sst[t + 3] = sst[t + 2]; sst[t + 2] = u; x = u; }
            v[a] = x;
            for (let p = 0; p < count; p++) { const o = (a * MC + p) * 5, t = (a * MC + p) * 4, u = dcf[o] * x + dcf[o + 1] * dst[t] + dcf[o + 2] * dst[t + 1] - dcf[o + 3] * dst[t + 2] - dcf[o + 4] * dst[t + 3];
                dst[t + 1] = dst[t]; dst[t] = x; dst[t + 3] = dst[t + 2]; dst[t + 2] = u; x = u; }
            if (a === 0) X.y0[i] = x; else if (a === 1) X.y1[i] = x; else X.y2[i] = x;
        }
        if (X.D) for (let t = 0; t < X.loops; t++) dynLoop(X, i);
    }
}
// dynNotchUpdate for one PID loop: the SDFT batch of each axis (sdftPushBatch) and one step of dynNotchProcess
function dynLoop(X, i) {
    const I = X.ints, acc = X.acc, avg = X.avg, v = X.v, NB = FW.sdftN / 2, NS = FW.sdftN, sre = X.sre, sim = X.sim, sx = X.sx, twr = X.twr, twi = X.twi, start = X.start, end = X.end;
    for (let a = 0; a < 3; a++) acc[a] += v[a] * X.fpl;
    if (I[3] === X.sampleCount) { I[3] = 0; for (let a = 0; a < 3; a++) { avg[a] = acc[a] * X.rcp; acc[a] = 0; } I[0] = FW.dynTicks; }
    const bIdx = I[3], bs0 = X.batchSize * bIdx + start, last = bIdx === X.numBatches - 1, be = last ? end + 1 : bs0 + X.batchSize;
    for (let a = 0; a < 3; a++) {
        const o = a * NB, xo = a * NS, delta = avg[a] - X.rN * sx[xo + X.sidx[a]];
        if (last) { sx[xo + X.sidx[a]] = avg[a]; X.sidx[a] = (X.sidx[a] + 1) % NS; }
        for (let k = bs0; k < be; k++) { const xr = sre[o + k] + delta, xi = sim[o + k]; sre[o + k] = twr[k] * xr - twi[k] * xi; sim[o + k] = twr[k] * xi + twi[k] * xr; }
        if (start > 0 && bIdx === 0) { const k = start - 1, xr = sre[o + k] + delta, xi = sim[o + k]; sre[o + k] = twr[k] * xr - twi[k] * xi; sim[o + k] = twr[k] * xi + twi[k] * xr; }
        if (end < NB - 1 && last) { const k = end + 1, xr = sre[o + k] + delta, xi = sim[o + k]; sre[o + k] = twr[k] * xr - twi[k] * xi; sim[o + k] = twr[k] * xi + twi[k] * xr; }
    }
    I[3]++;
    if (I[0] > 0) { dynStep(X, i); I[0]--; }
}
function dynStep(X, i) {
    const I = X.ints, axis = I[2], step = I[1], NB = FW.sdftN / 2, o = axis * NB, sre = X.sre, sim = X.sim, data = X.data, start = X.start, end = X.end, count = X.count, pkBin = X.pkBin, pkVal = X.pkVal, MC = X.MC;
    if (step === 0) {          // STEP_WINDOW: sdftWinSq
        for (let k = start; k <= end; k++) { let vr, vi;
            if (k === end && end === NB - 1) { vr = sre[o + k] - sre[o + k - 1]; vi = sim[o + k] - sim[o + k - 1]; }
            else { vr = sre[o + k] - 0.5 * (sre[o + k - 1] + sre[o + k + 1]); vi = sim[o + k] - 0.5 * (sim[o + k - 1] + sim[o + k + 1]); }
            data[k] = vr * vr + vi * vi; }
    } else if (step === 1) {   // STEP_DETECT_PEAKS: the count largest local maxima
        pkBin.fill(0); pkVal.fill(0);
        for (let bin = start + 1; bin < end; bin++) if (data[bin] > data[bin - 1] && data[bin] > data[bin + 1]) {
            for (let p = 0; p < count; p++) if (data[bin] > pkVal[p]) { for (let k = count - 1; k > p; k--) { pkBin[k] = pkBin[k - 1]; pkVal[k] = pkVal[k - 1]; } pkBin[p] = bin; pkVal[p] = data[bin]; break; }
            bin++;
        }
    } else if (step === 2) {   // STEP_CALC_FREQUENCIES: parabola through the peak bin and its neighbours
        for (let p = 0; p < count; p++) if (pkBin[p] !== 0 && pkVal[p] > 0) {
            let mb = pkBin[p]; const y0 = data[mb - 1], y1 = data[mb], y2 = data[mb + 1], den = 2 * (y0 - 2 * y1 + y2);
            if (den !== 0) mb += (y0 - y2) / den;
            X.cen[axis * MC + p] = clamp(mb * X.res, X.minHz, X.maxHz);
        }
    } else {                   // STEP_UPDATE_FILTERS: the notches with a peak get the new centre
        let any = false;
        for (let p = 0; p < count; p++) if (pkBin[p] !== 0 && pkVal[p] > 0) { X.setDyn(axis, p, X.cen[axis * MC + p]); any = true; }
        if (any) { const o2 = X.out[axis]; o2.at.push(i); for (let p = 0; p < count; p++) o2.c.push(X.cen[axis * MC + p]); }
        I[2] = (axis + 1) % 3;
    }
    I[1] = (step + 1) % 4;
}
// the sample spans of a segment that hold its windows: runs of windows less than RULE.leadS apart, each with RULE.leadS before
function spansOf(L, si, prep, subset) {
    const W = L.windows, N = prep.N, lead = Math.round(RULE.leadS * prep.logHz), out = [];
    for (let w = 0; w < W.n; w++) { if (W.seg[w] !== si || (subset && !subset(w))) continue; const a = Math.max(0, W.i0[w] - lead), b = W.i0[w] + N;
        if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = b; else out.push([a, b]); }
    return out;
}
// the centres of a track at log sample i (the last update at or before i)
function centresAt(tr, i, count, out) {
    const at = tr.at; let lo = 0, hi = at.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (at[m] <= i) lo = m; else hi = m - 1; }
    const k = tr.count;
    for (let p = 0; p < count; p++) out[p] = tr.c[lo * k + p];
    return out;
}

// ---------------------------------------------------------------------------------------------
// FFT: two real signals with one complex radix-2 FFT
// ---------------------------------------------------------------------------------------------

const fftCache = new Map();
function fftPlan(N) {
    let p = fftCache.get(N); if (p) return p;
    const bits = Math.log2(N), rev = new Uint32Array(N), cr = new Float64Array(N / 2), ci = new Float64Array(N / 2);
    for (let i = 0; i < N; i++) { let x = i, y = 0; for (let b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1; } rev[i] = y; }
    for (let i = 0; i < N / 2; i++) { cr[i] = Math.cos(2 * Math.PI * i / N); ci[i] = -Math.sin(2 * Math.PI * i / N); }
    const win = new Float64Array(N); let pw = 0;
    for (let i = 0; i < N; i++) { win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1))); pw += win[i] * win[i]; }   // lib fftFor: symmetric Hann
    p = { N, rev, cr, ci, win, power: pw, re: new Float64Array(N), im: new Float64Array(N) }; fftCache.set(N, p);
    return p;
}
function fft(p, re, im) {
    const N = p.N;
    for (let i = 0; i < N; i++) { const j = p.rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let s = 0; s < N; s += size) for (let k = 0; k < half; k++) {
            const wr = p.cr[k * step], wi = p.ci[k * step], a = s + k, b = a + half;
            const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
    }
}
// spectra of x and y over [s, s + N) with the mean removed and the Hann window: X, Y bins 0..N/2 into (xr, xi, yr, yi)
function twoSpectra(p, x, y, s, xr, xi, yr, yi) {
    const N = p.N, re = p.re, im = p.im; let mx = 0, my = 0;
    for (let i = 0; i < N; i++) { mx += x[s + i]; my += y[s + i]; } mx /= N; my /= N;
    for (let i = 0; i < N; i++) { re[i] = (x[s + i] - mx) * p.win[i]; im[i] = (y[s + i] - my) * p.win[i]; }
    fft(p, re, im);
    for (let k = 0; k <= N / 2; k++) { const j = (N - k) % N;
        xr[k] = 0.5 * (re[k] + re[j]); xi[k] = 0.5 * (im[k] - im[j]); yr[k] = 0.5 * (im[k] + im[j]); yi[k] = -0.5 * (re[k] - re[j]); }
}

// ---------------------------------------------------------------------------------------------
// Response rows (cached): power |H|^2 and complex H on the window grid
// ---------------------------------------------------------------------------------------------

function rowCache(f) {
    const pw = new Map(), cx = new Map();
    const make = (sections, fs) => { const re = new Float64Array(f.length).fill(1), im = new Float64Array(f.length); for (const [c, mix] of sections) mulSection(c, fs, f, re, im, mix); return { re, im }; };
    return {
        power(key, sections, fs) { let v = pw.get(key); if (!v) { const h = make(sections, fs); v = Float32Array.from(h.re, (x, k) => x * x + h.im[k] * h.im[k]); pw.set(key, v); } return v; },
        complex(key, sections, fs) { let v = cx.get(key); if (!v) { v = make(sections, fs); cx.set(key, v); } return v; },
        size() { return pw.size + cx.size; },
    };
}
// the sections of one axis's RPM banks at a speed (rounded to RULE.rpmQuant), and their cache key
function rpmSections(model, a, hs, tail) {
    const out = [], keys = [];
    for (const b of model.rpm[a]) {
        if (b.mult === null) continue;
        const sp = Math.round((b.ref === 'tail' ? tail : hs) / RULE.rpmQuant) * RULE.rpmQuant; if (!(sp > 0)) continue;
        const { c, fader } = rpmBankSection(model, b, sp); if (!(fader > 0)) continue;
        out.push([c, fader]); keys.push(`${b.mult.toFixed(9)}:${b.q}:${sp}`);
    }
    return { sections: out, key: keys.join(',') };
}
const staticKey = (model) => model.statics.map(st => st.kind === 'lpf' ? `L${st.type}:${st.hz}` : `N${st.hz}:${st.q.toFixed(6)}`).join(',') + '@' + model.rates.filterHz;
const dynKey = (model) => model.dyn.on ? `${model.dyn.minHz}:${model.dyn.maxHz}:${model.dyn.sampleCount}` : 'off';
// the upstream of the dynamic notch (what its SDFT sees): RPM banks and static filters
const upstreamKey = (model) => model.rpm.map(l => l.map(b => `${b.mult}:${b.q}`).join('/')).join('|') + '#' + staticKey(model);

// ---------------------------------------------------------------------------------------------
// The orders of the RPM notches that follow a gear ratio, from the log (no CLI dump)
// ---------------------------------------------------------------------------------------------

// a group of RPM notch banks whose order is h x X, X unknown without the gear ratios: tail rotor h x T, main motor 1 x M
const GROUPS = {
    tail: { harmonic: (src) => src >= 21 && src <= 28 ? src - 20 : 0, range: 'tailRange' },
    motor: { harmonic: (src) => src === 10 ? 1 : 0, range: 'motorRange' },
};
const bhCache = new Map();
function bhPlan(N) {        // the FFT plan with a 4-term Blackman-Harris window (sidelobes -92 dB) and its own scratch arrays
    let p = bhCache.get(N); if (p) return p;
    const win = new Float64Array(N); let pw = 0;
    for (let i = 0; i < N; i++) { const t = 2 * Math.PI * i / (N - 1); win[i] = 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t); pw += win[i] * win[i]; }
    p = Object.assign({}, fftPlan(N), { win, power: pw, re: new Float64Array(N), im: new Float64Array(N) }); bhCache.set(N, p);
    return p;
}
const notchHalfWidth = (order, Q) => order / (2 * Q);   // -3 dB half-width of a notch, in orders (analog form)

// The headspeed of a run as revolutions on the logged time base: hs[i] x (dt_i x rate), dt_i the logged frame interval (lib.byRevolution
// counts hs / 60 / rate for each sample, so a log whose mean frame interval is not 1 / rate gets orders that are off by that ratio: Gaui
// X4 #50, actualRate 1001.7 Hz against a 987 us median interval, 4.049 against 4.065). A frame interval of more than
// RULES.notchFit.gapFrames / rate (a logging gap or a stall) or one that does not increase counts as 1 / rate. Without a time column: hs
function revHeadspeed(hs, t, rate) {
    if (!t) return hs;
    const n = hs.length, out = new Float64Array(n), nominal = 1 / rate, gap = RULES.notchFit.gapFrames / rate;
    out[0] = hs[0];
    for (let i = 1; i < n; i++) { const dt = (t[i] - t[i - 1]) / 1e6; out[i] = hs[i] * (dt > 0 && dt <= gap ? dt : nominal) * rate; }
    return out;
}
// the logged seconds from sample i0 to sample i1 of a run that starts at sample s (t: the time column in us, else the samples / rate)
const runSeconds = (t, rate, s, i0, i1) => t && t[s + i1] > t[s + i0] ? (t[s + i1] - t[s + i0]) / 1e6 : (i1 - i0) / rate;

/**
 * orderSpectra(entries, axes, revs) -> [axis] Map of units 'li|block' -> { li, log, block, windows, rots, xx, yy, re, im, n }: the
 * sums of the auto- and cross-spectra of gyroRAW (x) and gyroADC (y) of each axis of axes against rotor order. Each run of the
 * flight mask is resampled at perRev samples for each revolution of the logged headspeed on the logged time base (revHeadspeed,
 * lib.byRevolution), so a notch that follows the headspeed is a fixed order. FFT windows of revs revolutions, hop 1/2. Bin k is the
 * order k / revs. A bin is used in a window only between the fade-in of the RPM notches (1.25 x gyro_rpm_notch_min_hz) and the
 * smaller of RULES.notchFit.maxNyquist x the log Nyquist frequency and the notch ceiling (0.45 x the filter rate: above it the firmware
 * holds the notch at a constant frequency), and not inside the band of a static notch filter of the log header (E.statics:
 * RULES.notchFit.staticBand x its -3 dB half-width, at the rotor frequency of the window). A static notch is at a constant frequency:
 * at one governed headspeed it is a fixed order, as an RPM notch is, so its dip is not a candidate.
 */
function orderSpectra(entries, axes, revs) {
    const F = RULES.notchFit, out = [new Map(), new Map(), new Map()], Kc = Math.ceil(revs * (F.motorRange[1] + F.halfWindow + 1)) + 1;
    entries.forEach((E, li) => {
        const N = revs * E.perRev, K = N / 2 + 1, plan = bhPlan(N), xr = new Float64Array(K), xi = new Float64Array(K), yr = new Float64Array(K), yi = new Float64Array(K);
        for (const it of E.items) {
            const w = it.w, m = it.mask, use = axes.filter(a => w.extra[`gyroRAW[${a}]`] && w.gyro[a]), t = w.extra && w.extra.time && w.extra.time.length === w.n ? w.extra.time : null;
            if (!m || !use.length) continue;
            for (let i = 0; i < w.n;) {
                if (!m[i]) { i++; continue; }
                let j = i; while (j < w.n && m[j]) j++;
                if (j - i > 2 * E.perRev) {
                    const tr = t ? t.subarray(i, j) : null, R = lib.byRevolution(revHeadspeed(w.hs.subarray(i, j), tr, E.rate), E.rate, [].concat(...use.map(a => [w.extra[`gyroRAW[${a}]`].subarray(i, j), w.gyro[a].subarray(i, j)])), E.perRev);
                    for (let s = 0; s + N <= R.M; s += N >> 1) {
                        const i0 = i + R.index[s], i1 = i + R.index[s + N - 1], secs = runSeconds(t, E.rate, 0, i0, i1), rot = secs > 0 ? (N - 1) / E.perRev / secs : 0;
                        if (!(rot > 1)) continue;
                        const mid = Math.round(0.5 * (i0 + i1)), at = t ? w.fromS + (t[mid] - t[0]) / 1e6 : w.fromS + mid / E.rate;
                        const block = Math.floor(at / RULE.blockS), key = `${li}|${block}`;
                        const kLo = Math.max(1, Math.ceil(E.fadeHz / rot * revs)), kHi = Math.min(K - 1, Kc - 1, Math.floor(Math.min(F.maxNyquist * E.rate / 2, E.ceilHz) / rot * revs));
                        const off = (E.statics || []).map(st => { const hw = F.staticBand * st.hz / (2 * st.q); return [Math.floor((st.hz - hw) / rot * revs), Math.ceil((st.hz + hw) / rot * revs)]; });
                        const skip = (k) => off.some(([a, b]) => k >= a && k <= b);
                        use.forEach((a, u) => {
                            let U = out[a].get(key);
                            if (!U) out[a].set(key, U = { li, log: E.log, block, windows: 0, rots: [], xx: new Float64Array(Kc), yy: new Float64Array(Kc), re: new Float64Array(Kc), im: new Float64Array(Kc), n: new Float64Array(Kc) });
                            twoSpectra(plan, R.columns[2 * u], R.columns[2 * u + 1], s, xr, xi, yr, yi);
                            for (let k = kLo; k <= kHi; k++) {
                                if (off.length && skip(k)) continue;
                                U.xx[k] += xr[k] * xr[k] + xi[k] * xi[k]; U.yy[k] += yr[k] * yr[k] + yi[k] * yi[k];
                                U.re[k] += xr[k] * yr[k] + xi[k] * yi[k]; U.im[k] += xr[k] * yi[k] - xi[k] * yr[k]; U.n[k]++;
                            }
                            U.windows++; U.rots.push(rot);
                        });
                    }
                }
                i = j;
            }
        }
    });
    return out;
}
// the sum of some units of orderSpectra
function sumUnits(list) {
    const S = { li: list[0].li, log: list[0].log, block: null, windows: 0, rots: [], xx: new Float64Array(list[0].xx.length), yy: new Float64Array(list[0].xx.length), re: new Float64Array(list[0].xx.length), im: new Float64Array(list[0].xx.length), n: new Float64Array(list[0].xx.length) };
    for (const U of list) { S.windows += U.windows; for (const v of U.rots) S.rots.push(v); for (const k of ['xx', 'yy', 're', 'im', 'n']) for (let i = 0; i < U[k].length; i++) S[k][i] += U[k][i]; }
    return S;
}

// The points of a fit within halfWindow of each order of `centres`: each bin, but a line of gyroRAW (RULES.notchFit.lineRatio x the median
// power of the bins or more) is one point at its own order (the power centroid of its main lobe) with the sums of the lobe: inside the
// lobe every bin gives the transfer at the line, not at the bin (a 4x rotor line next to a tail notch at 4.07 x moves the fit by 0.2 %
// without this). null with less than 16 bins. { o, f (Hz at the median rotor frequency), Hr, Hi, W (inverse variance), x: o - c0, kr, ki
// (the known part: the known banks of ctx and the logging offset), rot }
function fitPoints(S, ctx, centres, c0) {
    const F = RULES.notchFit, revs = F.revs, rot = median(S.rots), Kc = S.xx.length, ks = [];
    if (!(rot > 0)) return null;
    for (const c of centres) for (let k = Math.max(1, Math.ceil((c - F.halfWindow) * revs)); k <= Math.min(Kc - 1, Math.floor((c + F.halfWindow) * revs)); k++) if (S.n[k] > 0 && S.xx[k] > 0 && S.yy[k] > 0 && !ks.includes(k)) ks.push(k);
    if (ks.length < 16) return null;
    ks.sort((p, q) => p - q);
    const pts = [], used = new Set(), lobe = F.lobeBins, bg = median(ks.map(k => S.xx[k])), point = (oo, list) => {
        let xx = 0, yy = 0, re = 0, im = 0, n = 0; for (const k of list) { xx += S.xx[k]; yy += S.yy[k]; re += S.re[k]; im += S.im[k]; n = Math.max(n, S.n[k]); }
        const coh = (re * re + im * im) / (xx * yy); pts.push({ o: oo, hr: re / xx, hi: im / xx, w: n * xx / (yy * Math.max(1e-3, 1 - coh)) }); };
    for (const k of ks.slice().sort((p, q) => S.xx[q] - S.xx[p])) {
        if (used.has(k) || !(S.xx[k] >= F.lineRatio * bg)) continue;
        let top = true; for (let j = k - lobe; j <= k + lobe; j++) if (j !== k && j > 0 && j < Kc && S.xx[j] > S.xx[k]) top = false;
        if (!top) continue;
        const list = ks.filter(j => Math.abs(j - k) <= lobe && !used.has(j)); list.forEach(j => used.add(j));
        let sw = 0, sk = 0; for (const j of list) { sw += S.xx[j]; sk += j * S.xx[j]; }
        point(sk / sw / revs, list);
    }
    for (const k of ks) if (!used.has(k)) point(k / revs, [k]);
    pts.sort((p, q) => p.o - q.o);
    const nB = pts.length, o = Float64Array.from(pts, p => p.o), f = Float64Array.from(o, v => v * rot);
    // the known part: main rotor banks (and the tail banks of a passed tail fit for the motor fit) and the logging offset (fixed)
    const kr = new Float64Array(nB).fill(1), ki = new Float64Array(nB);
    for (const b of ctx.known) mulSection(biquad('notch', b.order * rot, ctx.fs, b.Q), ctx.fs, f, kr, ki);
    for (let j = 0; j < nB; j++) { const ph = -2 * Math.PI * f[j] * ctx.tau, c = Math.cos(ph), sn = Math.sin(ph), r0 = kr[j]; kr[j] = r0 * c - ki[j] * sn; ki[j] = r0 * sn + ki[j] * c; }
    return { nB, o, f, Hr: Float64Array.from(pts, p => p.hr), Hi: Float64Array.from(pts, p => p.hi), W: Float64Array.from(pts, p => p.w), x: Float64Array.from(o, v => v - c0), kr, ki, rot };
}
// the weighted least squares residual of the model (a + b x) x known x the notches of sections(f) over the points P: { e, ar, ai, br, bi } |
// null; notches: [{ hz, Q }] (none: the flat model)
function fitCost(P, ctx, notches) {
    const { nB, f, Hr, Hi, W, x } = P, nr = Float64Array.from(P.kr), ni = Float64Array.from(P.ki);
    for (const b of notches) mulSection(biquad('notch', b.hz, ctx.fs, b.Q), ctx.fs, f, nr, ni);
    let s00 = 0, s01 = 0, s11 = 0, p0r = 0, p0i = 0, p1r = 0, p1i = 0;
    for (let j = 0; j < nB; j++) { const w = W[j], n2 = nr[j] * nr[j] + ni[j] * ni[j], cr = nr[j] * Hr[j] + ni[j] * Hi[j], ci = nr[j] * Hi[j] - ni[j] * Hr[j];
        s00 += w * n2; s01 += w * x[j] * n2; s11 += w * x[j] * x[j] * n2; p0r += w * cr; p0i += w * ci; p1r += w * x[j] * cr; p1i += w * x[j] * ci; }
    const det = s00 * s11 - s01 * s01; if (!(det > 0)) return null;
    const ar = (s11 * p0r - s01 * p1r) / det, ai = (s11 * p0i - s01 * p1i) / det, br = (s00 * p1r - s01 * p0r) / det, bi = (s00 * p1i - s01 * p0i) / det;
    let e = 0;
    for (let j = 0; j < nB; j++) { const gr = ar + br * x[j], gi = ai + bi * x[j], mr = gr * nr[j] - gi * ni[j], mi = gr * ni[j] + gi * nr[j]; e += W[j] * ((Hr[j] - mr) ** 2 + (Hi[j] - mi) ** 2); }
    return { e, ar, ai, br, bi };
}

/**
 * fitOrderAt(S, ctx, c0, use) -> { order, depthDb, phaseJumpDeg, level, improvement, bins, edge, at, bank } or null. The measured
 * transfer H(o) = Sxy / Sxx at the bins within halfWindow of each dip h x c0 x (1 + centre) of the group banks `use` (default: all of
 * ctx.group; a bank that overlaps a known bank is left out by the caller, cleanBanks) is fitted by (a + b (o - c0)) x N(o; X): N is
 * the exact firmware response (RBJ notches at the real filter rate) of the known banks of the axis (main rotor harmonics) and of all
 * the group banks at h x X, with the logging offset, at the median rotor frequency of the windows; a and b complex, weighted least
 * squares with the inverse variance of H (n Sxx / (Syy (1 - coherence))). X runs over c0 +- halfWindow / 2 (0.002, then 0.0002
 * steps). improvement = 1 - residual / residual without the group notches. depthDb: the smallest |H| within 1.5 bins of the dip of the
 * lowest harmonic of `use` (bank, at order `at`) against the fitted level there (negative: a dip).
 */
function fitOrderAt(S, ctx, c0, use) {
    const F = RULES.notchFit, revs = F.revs, banks = use && use.length ? use : ctx.group;
    const P = fitPoints(S, ctx, banks.map(b => b.h * c0 * b.k), c0); if (!P) return null;
    const { nB, o, Hr, Hi, W, kr, ki, rot } = P;
    const cost = (X) => fitCost(P, ctx, X === null ? [] : ctx.group.map(b => ({ hz: b.h * X * b.k * rot, Q: b.Q })));
    const flat = cost(null); let best = null;
    const scan = (from, to, step) => { for (let X = from; X <= to + 1e-12; X += step) { const c = cost(X); if (c && (!best || c.e < best.c.e)) best = { X, c }; } };
    scan(c0 - F.halfWindow / 2, c0 + F.halfWindow / 2, 0.002);
    if (!best) return null;
    scan(best.X - 0.002, best.X + 0.002, 0.0002);
    const X = best.X, c = best.c, b0 = banks.reduce((p, q) => q.h < p.h ? q : p), od = b0.h * X * b0.k;
    // the level at the dip: |a + b x| x |known part| at the dip order
    const kd = { re: [1], im: [0] }; for (const b of ctx.known) mulSection(biquad('notch', b.order * rot, ctx.fs, b.Q), ctx.fs, [od * rot], kd.re, kd.im);
    const level = Math.hypot(c.ar + c.br * (od - c0), c.ai + c.bi * (od - c0)) * Math.hypot(kd.re[0], kd.im[0]);
    let hMin = Infinity; for (let j = 0; j < nB; j++) if (Math.abs(o[j] - od) * revs <= 1.5) hMin = Math.min(hMin, Math.hypot(Hr[j], Hi[j]));
    if (!isFinite(hMin)) { let jm = 0; for (let j = 1; j < nB; j++) if (Math.abs(o[j] - od) < Math.abs(o[jm] - od)) jm = j; hMin = Math.hypot(Hr[jm], Hi[jm]); }
    // the phase jump of the measured H over the dip (H over the known part): the weighted means of the two sides, from 2 bins to
    // one -3 dB half-width of the firmware notch away from it (RBJ: bandwidth 2 atan(sin(w0) / 2Q) rad, narrower than f0 / Q
    // when f0 is a large part of the filter rate)
    const al = Math.sin(2 * Math.PI * Math.min(od * rot, FW.cutoffLimit * ctx.fs) / ctx.fs) / (2 * b0.Q), span = Math.min(F.halfWindow, Math.atan(al) * ctx.fs / (2 * Math.PI) / rot), side = [[0, 0], [0, 0]];
    for (let j = 0; j < nB; j++) { const d = o[j] - od; if (Math.abs(d) * revs < 2 || Math.abs(d) > span) continue; const q = d < 0 ? 0 : 1, k2 = kr[j] * kr[j] + ki[j] * ki[j]; if (!(k2 > 0)) continue;
        side[q][0] += W[j] * (Hr[j] * kr[j] + Hi[j] * ki[j]) / k2; side[q][1] += W[j] * (Hi[j] * kr[j] - Hr[j] * ki[j]) / k2; }
    const jump = side[0][0] || side[0][1] ? Math.abs(Math.atan2(side[1][1] * side[0][0] - side[1][0] * side[0][1], side[1][0] * side[0][0] + side[1][1] * side[0][1])) * 180 / Math.PI : null;
    return { order: X, depthDb: isFinite(hMin) && level > 0 ? 20 * Math.log10(Math.max(hMin, 1e-12) / level) : null, phaseJumpDeg: jump, level, improvement: flat && flat.e > 0 ? 1 - c.e / flat.e : null, bins: nB,
        edge: Math.abs(X - c0) > F.halfWindow / 2 - 0.003, at: od, bank: b0 };
}
// The Q of the dip at order od: one notch at od with a free Q (RULES.notchFit.qGrid, then a finer step), the same points and model as
// fitOrderAt with no group bank. A firmware RPM notch of the group has the Q of its bank; the dynamic notch (dyn_notch_q / 10 + 0.2 p)
// and the main motor notch (source 10) have their own. -> Q | null
function fitQAt(S, ctx, od) {
    const G = RULES.notchFit.qGrid, P = fitPoints(S, ctx, [od], od); if (!P) return null;
    let best = null; const at = (Q) => { const c = fitCost(P, ctx, [{ hz: od * P.rot, Q }]); if (c && (!best || c.e < best.e)) best = { Q, e: c.e }; };
    for (let q = G[0]; q <= G[1] * 1.0001; q *= G[2]) at(q);
    if (!best) return null;
    const q0 = best.Q; for (let q = q0 / G[2]; q <= q0 * G[2] * 1.0001; q *= Math.pow(G[2], 0.1)) at(q);
    return best.Q;
}
// the group banks of ctx whose dip at order X does not overlap a known bank (closer than the sum of their -3 dB half-widths)
const cleanBanks = (ctx, X) => ctx.group.filter(gb => ctx.known.every(kb => Math.abs(kb.order - gb.h * X * gb.k) > notchHalfWidth(kb.order, kb.Q) + notchHalfWidth(gb.h * X * gb.k, gb.Q)));
// the group banks of ctx whose dip at order X is in view on the summed spectra S: data at a third or more of the bins within one -3 dB
// half-width on each side of it (a dip at the edge of the view has one side only: its Q and its order are not known; a static notch
// band can take a part of one side)
const inViewBanks = (S, ctx, X) => ctx.group.filter(b => { const o = b.h * X * b.k, hw = notchHalfWidth(o, b.Q), revs = RULES.notchFit.revs, kc = Math.round(o * revs), k0 = Math.floor((o - hw) * revs), k1 = Math.ceil((o + hw) * revs);
    if (k0 < 1 || k1 >= S.n.length) return false; let lo = 0, hi = 0; for (let k = k0; k < kc; k++) if (S.n[k] > 0) lo++; for (let k = kc + 1; k <= k1; k++) if (S.n[k] > 0) hi++;
    return lo >= (kc - k0) / 3 && hi >= (k1 - kc) / 3; });
// the banks that a fit at X uses: the clean banks in view; when none, the banks in view that overlap a known bank (overlap: true; the
// known bank is in the model), else none
function banksAt(S, ctx, X) {
    const view = inViewBanks(S, ctx, X), clean = cleanBanks(ctx, X).filter(b => view.includes(b));
    return clean.length ? { use: clean, overlap: false } : { use: view, overlap: view.length > 0 };
}
// the dip in dB of a bank at order X on summed spectra: |H|^2 at its order (within 1.5 bins, the lowest) against the median within
// +-0.5 order (dipCandidates score), null when its bins are not in view (no data, or under a known notch)
function bankDip(S, ctx, X, b) {
    const revs = RULES.notchFit.revs, Kc = S.xx.length, k0 = Math.round(b.h * X * b.k * revs), rot = median(S.rots), half = revs >> 1;
    if (k0 - half < 1 || k0 + half >= Kc || !(rot > 0)) return null;
    const kr = new Float64Array(1), ki = new Float64Array(1), known = (k) => { kr[0] = 1; ki[0] = 0; for (const q of ctx.known) mulSection(biquad('notch', q.order * rot, ctx.fs, q.Q), ctx.fs, [k / revs * rot], kr, ki); return kr[0] * kr[0] + ki[0] * ki[0]; };
    const dB = (k) => S.n[k] > 0 && S.xx[k] > 0 && known(k) >= 0.5 ? 10 * Math.log10(Math.max(1e-30, (S.re[k] ** 2 + S.im[k] ** 2) / (S.xx[k] ** 2))) : NaN;
    const ref = []; for (let k = k0 - half; k <= k0 + half; k++) { const v = dB(k); if (!isNaN(v)) ref.push(v); }
    let low = Infinity; for (let k = k0 - 1; k <= k0 + 1; k++) { const v = dB(k); if (!isNaN(v)) low = Math.min(low, v); }
    return ref.length > half && isFinite(low) ? low - median(ref) : null;
}

// the dip candidates of a group on summed spectra: |H|^2 in dB over its median within +-0.5 order, the deepest local minima
// (bins where the known notches pass less than half the power are not used), as orders X of the group
function dipCandidates(S, ctx, range) {
    const F = RULES.notchFit, revs = F.revs, Kc = S.xx.length, rot = median(S.rots), hs = [...new Set(ctx.group.map(b => b.h))];
    const lo = Math.max(1, Math.floor(range[0] * Math.min(...hs) * revs)), hi = Math.min(Kc - 1, Math.ceil(range[1] * Math.max(...hs) * revs));
    const known = new Float64Array(Kc).fill(1), f = Float64Array.from({ length: Kc }, (_, k) => k / revs * rot), kr = new Float64Array(Kc).fill(1), ki = new Float64Array(Kc);
    for (const b of ctx.known) mulSection(biquad('notch', b.order * rot, ctx.fs, b.Q), ctx.fs, f, kr, ki);
    for (let k = 0; k < Kc; k++) known[k] = kr[k] * kr[k] + ki[k] * ki[k];
    const dB = new Float64Array(Kc).fill(NaN);
    for (let k = lo; k <= hi; k++) if (S.n[k] > 0 && S.xx[k] > 0 && known[k] >= 0.5) dB[k] = 10 * Math.log10(Math.max(1e-30, (S.re[k] ** 2 + S.im[k] ** 2) / (S.xx[k] ** 2)));
    const half = revs >> 1, score = new Float64Array(Kc).fill(NaN);
    for (let k = lo; k <= hi; k++) { if (isNaN(dB[k])) continue; const ref = []; for (let j = k - half; j <= k + half; j++) if (j >= 0 && j < Kc && !isNaN(dB[j])) ref.push(dB[j]); if (ref.length > half) score[k] = dB[k] - median(ref); }
    const mins = [];
    for (let k = lo; k <= hi; k++) { if (isNaN(score[k])) continue; let low = true; for (let j = k - (revs >> 2); j <= k + (revs >> 2) && low; j++) if (j !== k && j >= 0 && j < Kc && score[j] < score[k]) low = false; if (low) mins.push(k); }
    mins.sort((p, q) => score[p] - score[q]);
    const out = [];
    for (const k of mins.slice(0, F.candidates)) for (const b of ctx.group) { const X = k / revs / b.h / b.k; if (X >= range[0] && X <= range[1]) out.push({ X, scoreDb: score[k] }); }
    return out;
}

/**
 * tailOrder(logs, opts) -> fit. The orders of the RPM notches that follow a gear ratio (rpm_filter.c): the tail rotor banks
 * (sources 21-28, at h x T x the rotor frequency, T = the configured tail rotor speed / rotor speed) and the main motor bank
 * (source 10, at M x the rotor frequency, M = 1 / the configured main gear ratio). The log header has no gear ratio, but each
 * of these firmware notches leaves a dip in |gyroADC / gyroRAW| at its order (the notch zero is exact). So the fit recovers the
 * configured values that the firmware uses. It does not measure the mechanics.
 *   logs: as tune() ([{ w, mask?, flight? }], w a whole-log segment with gyroRAW[0..2], and the time column when the log has it); opts:
 *   { flightRpm }
 *   For each group and each axis with a bank of the group: the units of the logs with the filter settings (the bank signature: banks,
 *   Q, centres, filter rate, logging offset) that most windows have give the dip candidates (dipCandidates) and the pooled fit; a log
 *   with other settings is a unit of its own, fitted with its own banks (the header changed between logs: settings in res). Each
 *   candidate: fitOrderAt on the banks of the group that are clear of the known banks at it (cleanBanks: preset 2 and 3 have main
 *   rotor 13 and 14 next to tail 1x for T of about 2.6 to 4.6, and then tail 2x alone gives the fit). Kept: the candidate with a dip of
 *   RULES.notchFit.minDepthDb or more and a phase jump, the deepest (on a mixed axis, the lowest order: a geared main motor turns
 *   faster than the tail rotor). A dip that another notch can make is checked (alias): on an axis with a bank of the other group
 *   (presets 2 and 3: source 10 next to 21 and 22), and in the band of the dynamic notch when DYN_NOTCH is on, the dip must have the
 *   Q of its bank (fitQAt: nearer to the bank Q than to the Q of the other notch, by RULES.notchFit.qRatio), or a second harmonic of
 *   the group in view must show a dip at h x X too (bankDip). The axis used: yaw when it is clean, deep and passes the alias check,
 *   else the deepest such axis, but not when yaw has a deep dip at another order (axes disagree). On it, fitOrderAt again for each
 *   unit (flight log when 3 or more, else 30 s block) around the order of the pooled fit, each unit with its own banks.
 * fit = { passed, order, se, n, unit: 'flight' | 'block', flights, windows, depthDb (median of the units), maxDevOrder,
 *         limitDevOrder, axis, sources, Q, settings (the filter settings of the units: 1, or more when the header changed between
 *         logs), units: [{ id, log, block, order, depthDb, windows }], axes: { roll|pitch|yaw: { order, depthDb, improvement, clean,
 *         used, qFit, alias } }, reasons: [{ code, ... }], basis: 'log notch', motor: the same for the main motor bank (source 10) | null
 *         when no axis has one,
 *         gear: { main: [1, M] | null, tail: [1, T] | null, tailOrder, motorOrder, motorisedTail: false (the tail fit passed) | null (it
 *               did not: a motorised tail is possible), source: 'log notch' } | null (null when no group passed; the input of
 *               config(opts.logGear), of health_setup gearOf (ctx.gear) and of the views. [1, T] is not a CLI value: never show it as a
 *               gear ratio and never write it as CLI text), ms }
 * Reasons: 'no flight data', 'no dip', 'no clean axis' (overlap: 'main rotor' | 'tail rotor', the kind of the known bank), 'alias'
 * (other: 'dynamic notch' | 'main motor' | 'tail rotor', qFit, qBank, qOther), 'axes disagree' (axis, order, yawOrder), 'not deep',
 * 'no phase jump', 'units disagree', 'too few units', 'error' (prepare: the message).
 * The tail fit says motorisedTail false: a dip at a fixed order of the headspeed shows a tail notch that follows the main motor.
 * A motorised tail (notch on the tail motor rpm, rpm_filter.c:225) gives no such dip, and the fit fails.
 *
 * The same in steps, for a caller that decodes one log at a time and lets it go (js/tuning_worker.js, its first pass):
 * acc = tailOrderStart(); tailOrderAdd(acc, logs, opts) for the logs of each decode (acc keeps the sums of orderSpectra of each
 * log and its banks, not its samples); fit = tailOrderFit(acc). tailOrder(logs, opts) is the three in one call: the same fit
 * as the logs added in the same order (orderSpectra sums each log apart, its units are 'log|block').
 */
function tailOrder(logs, opts = {}) {
    const acc = tailOrderStart(); tailOrderAdd(acc, logs, opts);
    return tailOrderFit(acc);
}
const tailOrderStart = () => ({ entries: [], spectra: [new Map(), new Map(), new Map()], ms: 0 });
// the entries of logs (one or more logs, grouped by file and log) and the sums of their order spectra on the axes with a bank of a
// group, added to acc; -> the number of flight logs added
function tailOrderAdd(acc, logs, opts = {}) {
    const t0 = Date.now(), F = RULES.notchFit, byLog = new Map(), entries = [];
    for (const item of logs || []) { const w = item.w || item; if (!w || !w.flight) continue; const k = `${w.flight.file || ''}#${w.flight.log}`; if (!byLog.has(k)) byLog.set(k, []); byLog.get(k).push(Object.assign({}, item, { w })); }
    for (const items of byLog.values()) {
        const w0 = items[0].w, h = w0.flight.header || {}, rate = w0.flight.actualRate || w0.rate, cfg = config(h, { actualRate: rate });
        if (!cfg.rates.gyroHz || ![0, 1, 2].every(a => w0.extra && w0.extra[`gyroRAW[${a}]`])) continue;
        const its = []; let flight = false, rots = [];
        for (const it of items) { const mk = maskOf(it.w, it, opts); if (mk.flight) flight = true; its.push({ w: it.w, mask: mk.mask });
            if (mk.mask) for (let i = 0; i < it.w.n; i += 50) if (mk.mask[i] && it.w.hs[i] > 0) rots.push(it.w.hs[i] / 60); }
        if (!flight || !rots.length) continue;
        rots.sort((p, q) => p - q);
        const rotLow = rots[Math.floor(0.05 * rots.length)], perRev = Math.min(256, Math.max(16, 2 ** Math.ceil(Math.log2(1.25 * rate / rotLow))));
        const s = cfg.s, rpmOn = s.RPM_FILTER !== false, R = cfg.rates, minHz = clamp(s.gyro_rpm_notch_min_hz, FW.minHzLo, 0.5 * FW.notchMax * R.filterHz);
        // the static notches (log Hz) and the dynamic notch (its band in log Hz, the Q of its notches) of the header: compile() as the replica
        const M = compile(cfg), statics = M.statics.filter(st => st.kind === 'notch').map(st => ({ hz: st.hz * R.scale, q: st.q }));
        const dyn = M.dyn.on ? { minHz: M.dyn.minHz * R.scale, maxHz: M.dyn.maxHz * R.scale, q: [M.dyn.q, M.dyn.q + (M.dyn.count - 1) * FW.dynQAdvance] } : null;
        entries.push({ log: w0.flight.log, items: its, cfg, banks: rpmOn ? effectiveBanks(s) : [null, null, null], rate, perRev, fadeHz: FW.fade * minHz * R.scale,
            ceilHz: FW.notchMax * R.filterHz * R.scale, fs: R.filterHz * R.scale, tau: R.offsetTicks / (R.gyroHz * R.scale), statics, dyn });
    }
    // the spectra of every axis with a bank of a group, once for both groups; the units get the index of their log in acc
    const axes = AXES.map((ax, a) => a).filter(a => entries.some(E => (E.banks[a] || []).some(b => GROUPS.tail.harmonic(b.source) || GROUPS.motor.harmonic(b.source))));
    if (entries.length && axes.length) { const base = acc.entries.length;
        orderSpectra(entries, axes, F.revs).forEach((units, a) => { for (const U of units.values()) { U.li += base; acc.spectra[a].set(`${U.li}|${U.block}`, U); } }); }
    for (const E of entries) { E.items = null; acc.entries.push(E); }
    acc.ms += Date.now() - t0;
    return entries.length;
}
// the fit of the logs in acc (tailOrder above)
function tailOrderFit(acc) {
    const t0 = Date.now(), F = RULES.notchFit, entries = acc.entries, spectraOf = () => acc.spectra;
    // tail first. An axis with banks of both groups (presets 2 and 3: 21, 22 and 10 on every axis) is "mixed": the tail is then
    // its lowest deep dip in the tail range that passes the alias check (a geared main motor turns faster than the tail rotor: M
    // 6.7-13 against T 4-5), and the motor fit treats the tail banks at the fitted T as known and needs a passed tail fit
    const groupFit = (gname, tailFit) => {
        const G = GROUPS[gname], other = GROUPS[gname === 'tail' ? 'motor' : 'tail'], range = F[G.range], ctxOf = (E, a) => {
            const B = E.banks[a] || [], known = [], group = [], others = []; let mixed = false;
            for (const b of B) { const Q = clamp(b.q, 10, 250) / 10, k = 1 + b.center / 10000, h = G.harmonic(b.source), ho = other.harmonic(b.source);
                if (b.source >= 11 && b.source <= 18) known.push({ order: (b.source - 10) * k, Q, source: b.source, kind: 'main rotor' });
                else if (h) group.push({ h, k, Q, source: b.source });
                else if (ho) { mixed = true; others.push({ h: ho, k, Q, source: b.source }); if (gname === 'motor' && tailFit && tailFit.passed) known.push({ order: ho * tailFit.order * k, Q, source: b.source, tail: true, kind: 'tail rotor' }); } }
            const sig = JSON.stringify([known.map(b => [r(b.order, 5), b.Q]), group.map(b => [b.h, r(b.k, 5), b.Q]), others.map(b => [b.h, b.Q]), r(E.fs, 1), r(E.tau * 1e6, 1), E.dyn ? E.dyn.q : null]);
            return { known, group, others, mixed, fs: E.fs, tau: E.tau, dyn: E.dyn, sig };
        };
        // no flight log with the raw gyro data: the tail fit says so (the motor fit has nothing to say)
        if (!entries.length) return gname === 'tail' ? { passed: false, order: null, se: null, n: 0, unit: null, flights: 0, windows: 0, axis: null, sources: [], units: [], axes: {}, reasons: [{ code: 'no flight data' }], basis: 'log notch' } : null;
        const axesWith = AXES.map((ax, a) => entries.some(E => ctxOf(E, a).group.length) ? a : -1).filter(a => a >= 0);
        if (!axesWith.length) return null;
        const res = { passed: false, order: null, se: null, n: 0, unit: null, flights: 0, windows: 0, depthDb: null, maxDevOrder: null, limitDevOrder: null, axis: null, sources: [], Q: null, settings: 1, units: [], axes: {}, reasons: [], basis: 'log notch' };
        // the alias check of a fit ft on axis context ctx: another notch that can make the same dip (see tailOrder). null: passed, else
        // { other, qFit, qBank, qOther } (the reason 'alias')
        const aliasOf = (S, ctx, ft) => {
            const b0 = ft.bank, hz = ft.at * median(S.rots), alts = [];
            if (gname === 'tail' && ctx.mixed) for (const ob of ctx.others) alts.push({ other: 'main motor', q: [ob.Q, ob.Q] });
            if (ctx.dyn && hz >= ctx.dyn.minHz && hz <= ctx.dyn.maxHz) alts.push({ other: 'dynamic notch', q: ctx.dyn.q });
            if (!alts.length) return null;
            // a second harmonic of the group in view with a dip at h x X: the dip pattern of the group, not of one other notch
            const clean = cleanBanks(ctx, ft.order), seen = inViewBanks(S, ctx, ft.order).filter(b => clean.includes(b) && b.h !== b0.h).map(b => bankDip(S, ctx, ft.order, b)).filter(v => v !== null);
            if (seen.some(v => v <= -F.minDepthDb / 2)) return null;
            const qFit = fitQAt(S, ctx, ft.at); if (qFit === null) return { other: alts[0].other, qFit: null, qBank: b0.Q, qOther: alts[0].q[0] };
            const dist = (lo, hi) => qFit < lo ? Math.log(lo / qFit) : qFit > hi ? Math.log(qFit / hi) : 0, dBank = dist(b0.Q, b0.Q);
            const bad = alts.find(x => !(dist(x.q[0], x.q[1]) > dBank + Math.log(F.qRatio)));
            return bad ? { other: bad.other, qFit: r(qFit, 2), qBank: b0.Q, qOther: bad.q[0] === bad.q[1] ? bad.q[0] : bad.q.map(v => r(v, 2)) } : null;
        };
        const perAxis = {};
        for (const a of axesWith) {
            const units = new Map([...spectraOf()[a]].filter(([, U]) => ctxOf(entries[U.li], a).group.length));
            if (!units.size) { res.axes[AXES[a]] = { order: null, depthDb: null, improvement: null, clean: null, used: false }; continue; }
            // the units of each set of filter settings (the header changed between logs): the pooled fit and its candidates on the units of
            // one set; the set with the best pick (then the most windows) gives the axis its fit
            const bySig = new Map(); for (const U of units.values()) { const s = ctxOf(entries[U.li], a).sig; if (!bySig.has(s)) bySig.set(s, []); bySig.get(s).push(U); }
            const sets = [...bySig].map(([sg, list]) => ({ sig: sg, list, windows: list.reduce((p, U) => p + U.windows, 0) })).sort((p, q) => q.windows - p.windows);
            let best = null;
            for (const set of sets) { const r0 = pickOf(set.list, ctxOf(entries[set.list[0].li], a)); if (r0 && (!best || (r0.pick ? r0.pick.rank : -1) > (best.pick ? best.pick.rank : -1))) best = Object.assign(r0, { sig: set.sig }); }
            if (!best) { res.axes[AXES[a]] = { order: null, depthDb: null, improvement: null, clean: false, used: false }; continue; }
            const { pick, unclean, ctx, sig } = best, ft = pick && pick.ft, X = ft ? ft.order : null;
            res.axes[AXES[a]] = { order: r(X, 4), depthDb: ft ? r(ft.depthDb, 1) : null, phaseJumpDeg: ft ? r(ft.phaseJumpDeg, 0) : null, improvement: ft ? r(ft.improvement, 3) : null, clean: ft ? !pick.overlap : null, used: false,
                alias: pick && pick.alias ? pick.alias : null };
            perAxis[a] = { ft, clean: !!ft && !pick.overlap, deep: !!(pick && pick.deep), good: !!(pick && pick.good), alias: pick ? pick.alias : null, units, ctx, use: pick ? pick.use : null, overlap: !!(pick && pick.overlap), sig, unclean };
        }
        // the best candidate of the units `list` with the filter settings of ctx: { pick: { ft, deep, good, alias, use, overlap, rank } | null,
        // unclean, ctx } | null (the motor fit on a mixed axis without a passed tail fit)
        function pickOf(list, ctx) {
            if (ctx.mixed && gname === 'motor' && !(tailFit && tailFit.passed)) return null;
            const all = sumUnits(list), cands = dipCandidates(all, ctx, range);
            // each candidate on the clean banks in view (banksAt), else on the banks in view that overlap a main rotor bank (preset 2 and 3:
            // tail 1x next to main 3x or 4x, tail 2x out of view): a fit with the known bank in the model, ranked after a clean one
            let pick = null, unclean = null;
            for (const cd of cands) {
                let B = banksAt(all, ctx, cd.X); if (!B.use.length) continue;
                let ft = fitOrderAt(all, ctx, cd.X, B.use); if (!ft || ft.edge) continue;
                const again = banksAt(all, ctx, ft.order); if (!again.use.length) continue;
                if (again.use.length !== B.use.length || again.overlap !== B.overlap) { B = again; ft = fitOrderAt(all, ctx, ft.order, B.use); if (!ft || ft.edge) continue; }
                if (B.overlap) unclean = unclean === null ? ft.order : unclean;
                const deep = ft.depthDb !== null && ft.depthDb <= -F.minDepthDb && ft.phaseJumpDeg !== null && ft.phaseJumpDeg >= F.minPhaseJumpDeg;
                const alias = deep ? aliasOf(all, ctx, ft) : null, good = deep && !alias;
                const rank = (good ? 2 : deep ? 1 : 0) * 2 + (B.overlap ? 0 : 1), better = !pick || rank > pick.rank || (rank === pick.rank && (good && ctx.mixed && gname === 'tail' ? ft.order < pick.ft.order : ft.depthDb < pick.ft.depthDb));
                if (better) pick = { ft, deep, good, alias, use: B.use, overlap: B.overlap, rank };
            }
            return { pick, unclean, ctx };
        }
        // the axis: yaw when its dip is clean, deep with a phase jump and passes the alias check, else the deepest such axis, else (for the
        // numbers of the reasons) the deepest clean axis. Not another axis when yaw has a deep dip at another order
        // (an axis whose fit overlaps a known bank only after the clean axes)
        const withFit = Object.keys(perAxis).map(Number).filter(a => perAxis[a].ft), deepest = (l) => l.slice().sort((p, q) => perAxis[p].ft.depthDb - perAxis[q].ft.depthDb)[0];
        const good = withFit.filter(a => perAxis[a].good), goodClean = good.filter(a => perAxis[a].clean);
        let use = goodClean.includes(2) ? 2 : goodClean.length ? deepest(goodClean) : good.includes(2) ? 2 : good.length ? deepest(good) : deepest(withFit);
        if (use === undefined) { res.reasons.push({ code: 'no dip' }); return res; }
        // a fit on another axis at an order that the yaw dip does not agree with (more than one -3 dB half-width of the yaw notch apart)
        const Y = perAxis[2], yb = Y && Y.ft ? Y.ft.bank : null;
        if (use !== 2 && perAxis[use].good && Y && Y.deep && yb && Math.abs(Y.ft.order - perAxis[use].ft.order) > notchHalfWidth(Y.ft.order * yb.h * yb.k, yb.Q) / (yb.h * yb.k)) {
            res.axes.yaw.used = false; res.axis = AXES[use];
            res.reasons.push({ code: 'axes disagree', axis: AXES[use], order: r(perAxis[use].ft.order, 4), yawOrder: r(Y.ft.order, 4) }); return res;
        }
        const P = perAxis[use], ctx = P.ctx, banks = P.use && P.use.length ? P.use : ctx.group, fund = banks.reduce((p, q) => q.h < p.h ? q : p);
        res.axis = AXES[use]; res.axes[AXES[use]].used = true; res.sources = [...new Set(ctx.group.map(b => b.source))].sort((p, q) => p - q); res.Q = fund.Q;
        // units: flight logs when 3 or more have data, else blocks of 30 s; each with the banks of its own log at the order of the pooled fit
        const list = [...P.units.values()], logsWith = [...new Set(list.map(U => U.li))];
        res.flights = logsWith.length; res.windows = list.reduce((p, U) => p + U.windows, 0); res.settings = new Set(list.map(U => ctxOf(entries[U.li], use).sig)).size;
        res.unit = logsWith.length >= F.minUnits ? 'flight' : 'block';
        const unitSums = res.unit === 'flight' ? logsWith.map(li => sumUnits(list.filter(U => U.li === li))) : list;
        for (const U of unitSums) {
            if (U.windows < F.minWindows) continue;
            // its own banks; a unit whose banks overlap a main rotor bank where the pooled fit had a clean bank (other settings) is left out
            const uc = ctxOf(entries[U.li], use), UB = banksAt(U, uc, P.ft.order); if (!UB.use.length || (UB.overlap && !P.overlap)) continue;
            const ft = fitOrderAt(U, uc, P.ft.order, UB.use); if (!ft) continue;
            res.units.push({ id: res.unit === 'flight' ? `log ${U.log}` : `log ${U.log}, ${U.block * RULE.blockS}-${(U.block + 1) * RULE.blockS} s`, log: U.log, block: U.block, order: r(ft.order, 4), depthDb: r(ft.depthDb, 1), windows: U.windows });
        }
        const ms = meanSe(res.units.map(u => u.order)), dep = res.units.map(u => u.depthDb).filter(v => v !== null);
        // the SE: over the units, and the time base of the logs (RULES.notchFit.timeBase) in quadrature; seUnits: over the units only
        res.n = ms.n; res.order = r(ms.mean, 4); res.seUnits = r(ms.se, 4); res.overlap = !!P.overlap;
        res.se = ms.se === null || ms.mean === null ? null : r(Math.hypot(ms.se, F.timeBase * ms.mean, P.overlap ? F.overlap * ms.mean : 0), 4); res.depthDb = dep.length ? r(median(dep), 1) : null;
        res.maxDevOrder = ms.n ? r(Math.max(...res.units.map(u => Math.abs(u.order - ms.mean))), 4) : null;
        res.limitDevOrder = ms.n ? r(F.maxDev * notchHalfWidth(ms.mean * fund.h * fund.k, fund.Q) / (fund.h * fund.k), 4) : null; // in orders of X: harmonic h moves h times as far
        res.pooled = { order: r(P.ft.order, 4), depthDb: r(P.ft.depthDb, 1), improvement: r(P.ft.improvement, 3) };
        res.pooled.phaseJumpDeg = r(P.ft.phaseJumpDeg, 0);
        if (P.alias) res.reasons.push(Object.assign({ code: 'alias' }, P.alias));
        if (P.overlap && !P.good) { const kb = ctx.known.find(q => banks.some(gb => Math.abs(q.order - gb.h * P.ft.order * gb.k) <= notchHalfWidth(q.order, q.Q) + notchHalfWidth(gb.h * P.ft.order * gb.k, gb.Q)));
            res.reasons.push({ code: 'no clean axis', overlap: kb ? kb.kind : 'main rotor' }); }
        if (res.depthDb === null || res.depthDb > -F.minDepthDb) res.reasons.push({ code: 'not deep', depthDb: res.depthDb, limit: F.minDepthDb });
        if (!(P.ft.phaseJumpDeg >= F.minPhaseJumpDeg)) res.reasons.push({ code: 'no phase jump', phaseJumpDeg: res.pooled.phaseJumpDeg, limit: F.minPhaseJumpDeg });
        if (res.maxDevOrder !== null && res.maxDevOrder > res.limitDevOrder) res.reasons.push({ code: 'units disagree', maxDevOrder: res.maxDevOrder, limit: res.limitDevOrder });
        if (ms.n < F.minUnits) res.reasons.push({ code: 'too few units', n: ms.n, limit: F.minUnits });
        res.passed = !res.reasons.length;
        return res;
    };
    const tail = groupFit('tail', null), motor = groupFit('motor', tail);
    const out = Object.assign(tail || { passed: false, order: null, se: null, n: 0, unit: null, flights: entries.length, axis: null, sources: [], units: [], axes: {}, reasons: [{ code: 'no tail rotor notch' }], basis: 'log notch' }, { motor });
    const T = tail && tail.passed ? tail.order : null, M = motor && motor.passed ? motor.order : null;
    // motorisedTail: false only when the tail fit passed (a dip at a fixed order of the headspeed); else unknown (null: source 20 possible)
    out.gear = T !== null || M !== null ? { main: M !== null ? [1, M] : null, tail: T !== null ? [1, T] : null, tailOrder: T, motorOrder: M, motorisedTail: T !== null ? false : null, source: 'log notch' } : null;
    out.ms = acc.ms + Date.now() - t0;
    return out;
}

// ---------------------------------------------------------------------------------------------
// prepare: windows of the flight phase of every flight log
// ---------------------------------------------------------------------------------------------

const optionalRequire = (name) => { try { return require(name); } catch (e) { return null; } };

// the flight-phase mask of a whole segment when the caller gives none: health_phase flightMask (the flights of CLAUDE.md),
// without rescue (lib rescueAt). The app passes its own mask (flight phase without rescue, level modes and failsafe).
function maskOf(w, item, opts) {
    if (item.mask) return { mask: item.mask, flight: item.flight !== false, source: 'caller' };
    const phase = optionalRequire('./health_phase.cjs');
    if (!phase) return { mask: null, flight: false, source: 'health_phase.cjs is missing' };
    const ctx = { rate: w.rate, flightRule: { headspeed: opts.flightRpm || lib.FLIGHT_RPM } }, ph = item.phases || phase.phases(w, ctx), fm = phase.flightMask(w, ctx, ph);
    if (w.rescueAt) for (let i = 0; i < w.n; i++) if (w.rescueAt[i]) fm[i] = 0;
    return { mask: fm, flight: ph.class === 'flight', source: 'health_phase flightMask, rescue out' };
}

/**
 * prepare(logs, opts) -> prep. opts: { cli, gear, flightRpm, windowS, lines }.
 * Per flight log: the replica of its header (compile(config(...))); the windows of the mask (N samples, no overlap) with the
 * raw PSD minus the rounding floor per axis, the headspeed at RULE.states times, the PID profile; the replica run on the logged
 * gyroRAW (runChain: 'rpm', or 'all' with a dynamic notch) and its PSD in every window; the parity sums per PID profile and axis
 * over the windows at near-constant rotor speed. Then the rotor-locked lines (findLines) and the line-aware split of each
 * window (decompose, for the screening of RPM notch candidates). Bench runs are listed, not used.
 */
function prepare(logs, opts = {}) {
    const t0 = Date.now(), byLog = new Map(), bench = [], notes = [];
    for (const item of logs) { const w = item.w || item; const k = `${w.flight.file || ''}#${w.flight.log}`; if (!byLog.has(k)) byLog.set(k, []); byLog.get(k).push(Object.assign({}, item, { w })); }
    // the notch orders that the log shows (tailOrder): used when neither opts.gear nor the CLI dump gives the gear ratios. With a
    // CLI dump the fit runs too, for the record (result.tailFit); opts.tailFit: a fit made before, opts.logGear false: no fit
    let fit = opts.tailFit || null;
    if (!fit && !opts.gear && opts.logGear !== false) try { fit = tailOrder(logs, opts); } catch (e) { fit = { passed: false, order: null, reasons: [{ code: 'error', message: String(e && e.message || e) }], gear: null, motor: null }; }
    const logGear = !opts.gear && fit && fit.gear ? fit.gear : null;
    const out = [];
    for (const [key, items] of byLog) {
        const w0 = items[0].w, h = w0.flight.header || {}, cfg = config(h, { cli: opts.cli, gear: opts.gear, logGear, actualRate: w0.flight.actualRate }), model = compile(cfg);
        const raw0 = [0, 1, 2].map(a => w0.extra && w0.extra[`gyroRAW[${a}]`]);
        const entry = { key, log: w0.flight.log, file: w0.flight.file, header: h, cfg, model, notes: model.notes.slice(), segs: [] };
        if (!raw0.every(Boolean)) { bench.push({ log: entry.log, reason: 'The log does not have gyroRAW.' }); continue; }
        if (!cfg.rates.gyroHz) { bench.push({ log: entry.log, reason: 'The log header has no looptime.' }); continue; }
        let flight = false;
        for (const it of items) {
            const w = it.w, mk = maskOf(w, it, opts); if (mk.flight) flight = true;
            entry.segs.push({ n: w.n, raw: [0, 1, 2].map(a => w.extra[`gyroRAW[${a}]`]), filt: w.gyro, hs: w.hs, tail: w.extra.tailspeed || null, prof: w.profileAt, mask: mk.mask, maskSource: mk.source, fromS: w.fromS });
        }
        if (!flight) { bench.push({ log: entry.log, reason: 'Bench run (no flight).' }); continue; }
        out.push(entry);
    }
    if (!out.length) return { logs: [], bench, notes: notes.concat(['No flight log with gyroRAW.']), tailFit: fit, ms: Date.now() - t0 };
    const logHz = out[0].model.rates.logHz, N = 2 ** Math.round(Math.log2(logHz * (opts.windowS || RULE.windowS))), K = N / 2 + 1, plan = fftPlan(N);
    const f = Float64Array.from({ length: K }, (_, k) => k * logHz / N), df = logHz / N;
    const norm = 2 / (logHz * plan.power), Q = 2 * FW.roundingVar / logHz;   // one-sided PSD of the rounding error (1 deg/s steps)
    const prep = { logs: out, bench, notes, N, K, f, df, logHz, Q, plan, norm, rows: rowCache(f), cache: new Map(), opts, tailFit: fit };
    prep.band = [Math.ceil(RULES.noise.band[0] / df), Math.floor(RULES.noise.band[1] * 0.5 * logHz / df)];
    for (const L of out) {
        if (L.model.rates.logHz !== logHz) L.notes.push(`The log rate (${r(L.model.rates.logHz, 1)} Hz) differs from the first log (${r(logHz, 1)} Hz).`);
        const S = RULE.states, W = { i0: [], seg: [], prof: [], hs: [], tail: [], hsK: [], pos: [], spread: [], steady: [] }, sxx = [[], [], []];
        L.segs.forEach((sg, si) => {
            const n = sg.n, cum = new Int32Array(n + 1); for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + (sg.mask && sg.mask[i] ? 1 : 0);
            for (let st = 0; st + N <= n; st += N) {
                if (cum[st + N] - cum[st] < N) continue;
                const pos = Array.from({ length: S }, (_, j) => st + Math.floor((j + 0.5) * N / S));
                let lo = Infinity, hi = -Infinity; for (let i = st; i < st + N; i += 4) { const v = sg.hs[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
                const hsK = pos.map(i => sg.hs[i]), hsMed = median(hsK), spread = hsMed > 0 ? (hi - lo) / hsMed : 1;
                W.i0.push(st); W.seg.push(si); W.prof.push(sg.prof ? sg.prof[st + (N >> 1)] : 0); W.hs.push(hsMed); W.tail.push(sg.tail ? sg.tail[st + (N >> 1)] : 0);
                W.hsK.push(hsK); W.pos.push(pos); W.spread.push(spread); W.steady.push(spread <= RULE.rpmSpread);
            }
        });
        L.windows = { n: W.i0.length, i0: Int32Array.from(W.i0), seg: Int32Array.from(W.seg), prof: Int32Array.from(W.prof), hs: Float64Array.from(W.hs), tail: Float64Array.from(W.tail), hsK: W.hsK, pos: W.pos, spread: Float64Array.from(W.spread), steady: W.steady, sxx,
            block: Int32Array.from(W.i0, (st, w) => Math.floor((L.segs[W.seg[w]].fromS + st / logHz) / RULE.blockS)) };
        L.tau = L.model.rates.offsetTicks / L.model.rates.gyroHz;
        L.seconds = L.windows.n * N / logHz;
        L.profiles = [...new Set(W.prof)].sort((p, q) => p - q);
        // the raw PSD of each window (lines, screening, curves) and the measured parity sums
        const par = new Map(), xr = new Float64Array(K), xi = new Float64Array(K), yr = new Float64Array(K), yi = new Float64Array(K);
        L.loggedSum = AXES.map(() => new Float64Array(K)); L.rawSum = AXES.map(() => new Float64Array(K));
        for (let w = 0; w < L.windows.n; w++) {
            const sg = L.segs[W.seg[w]], st = W.i0[w], prof = W.prof[w];
            let P = W.steady[w] ? par.get(prof) : null; if (W.steady[w] && !P) par.set(prof, P = AXES.map(() => ({ sxx: new Float64Array(K), syy: new Float64Array(K), sxyRe: new Float64Array(K), sxyIm: new Float64Array(K), n: 0, hs: [] })));
            for (let a = 0; a < 3; a++) {
                twoSpectra(plan, sg.raw[a], sg.filt[a], st, xr, xi, yr, yi);
                const sx = new Float32Array(K); for (let k = 0; k < K; k++) sx[k] = Math.max(0, (xr[k] * xr[k] + xi[k] * xi[k]) * norm - Q);
                sxx[a].push(sx);
                for (let k = 0; k < K; k++) { L.loggedSum[a][k] += (yr[k] * yr[k] + yi[k] * yi[k]) * norm; L.rawSum[a][k] += (xr[k] * xr[k] + xi[k] * xi[k]) * norm; }
                if (!P) continue;
                const A = P[a];
                for (let k = 0; k < K; k++) { A.sxx[k] += (xr[k] * xr[k] + xi[k] * xi[k]) * norm; A.syy[k] += (yr[k] * yr[k] + yi[k] * yi[k]) * norm;
                    A.sxyRe[k] += (xr[k] * yr[k] + xi[k] * yi[k]) * norm; A.sxyIm[k] += (xr[k] * yi[k] - xi[k] * yr[k]) * norm; }
                A.n++; A.hs.push(W.hs[w]);
            }
        }
        L.parity = par;
    }
    prep.lines = opts.lines || findLines(prep);
    decompose(prep, prep.lines);
    // the replica with the settings of the logs: time domain, then the parity sums of the replica
    prep.base = simulateAll(prep, prep.logs.map(L => L.cfg), true);
    prep.ms = Date.now() - t0;
    return prep;
}

/**
 * simulateAll(prep, cfgs, keepParity) runs the time-varying part of the replica (runChain) for the settings of each log and
 * gives, per log: the mode, the dynamic notch tracks, and per axis the PSD of the output in each window (zz) with its
 * aggregates per PID profile (S) and per line (Lsp: the bins of the line in each window), and the static correction C(f)
 * (exact firmware-rate response of the static filters, over the log-rate design used in the time domain for mode 'all').
 * keepParity adds the replica's cross-spectra with gyroRAW over the parity windows.
 */
function simulateAll(prep, cfgs, keepParity, subset) {
    const { K, plan, norm, f } = prep, res = [];
    const xr = new Float64Array(K), xi = new Float64Array(K), zr = new Float64Array(K), zi = new Float64Array(K);
    prep.logs.forEach((L, li) => {
        const cfg = cfgs[li], M = compile(cfg), mode = M.dyn.on ? 'all' : 'rpm', W = L.windows;
        const inSub = subset ? (w) => subset(L, w) : null;
        const runs = L.segs.map((sg, si) => runChain(M, sg, mode, spansOf(L, si, prep, inSub)));
        const C = staticCorrection(prep, M, mode);
        const zz = [[], [], []], S = AXES.map(() => new Map()), LS = AXES.map(() => new Map()), Lsp = AXES.map((ax, a) => W.lines[a].map(() => new Float64Array(K)));
        for (let w = 0; w < W.n; w++) {
            if (inSub && !inSub(w)) continue;
            const sg = L.segs[W.seg[w]], st = W.i0[w], y = runs[W.seg[w]].y, prof = W.prof[w];
            const P = keepParity && W.steady[w] ? L.parity.get(prof) : null;
            for (let a = 0; a < 3; a++) {
                twoSpectra(plan, sg.raw[a], y[a], st, xr, xi, zr, zi);
                const z = new Float32Array(K); for (let k = 0; k < K; k++) z[k] = (zr[k] * zr[k] + zi[k] * zi[k]) * norm;
                zz[a].push(z);
                const unit = `${prof}|${W.block[w]}`; let agg = S[a].get(unit); if (!agg) S[a].set(unit, agg = { prof, block: W.block[w], s: new Float64Array(K), n: 0 }); for (let k = 0; k < K; k++) agg.s[k] += z[k]; agg.n++;
                let Lo = LS[a].get(W.block[w]); if (!Lo) LS[a].set(W.block[w], Lo = W.lines[a].map(() => new Float64Array(K)));
                const own = W.owner[a][w]; for (let k = 0; k < K; k++) if (own[k] >= 0) { Lsp[a][own[k]][k] += z[k]; Lo[own[k]][k] += z[k]; }
                if (P) { const A = P[a]; if (!A.szz) { A.szz = new Float64Array(K); A.sxzRe = new Float64Array(K); A.sxzIm = new Float64Array(K); }
                    for (let k = 0; k < K; k++) { A.szz[k] += z[k]; A.sxzRe[k] += (xr[k] * zr[k] + xi[k] * zi[k]) * norm; A.sxzIm[k] += (xr[k] * zi[k] - xi[k] * zr[k]) * norm; } }
            }
        }
        res.push({ mode, model: M, C, S, Lsp, LS, tracks: runs.map(r0 => r0.track), zzSum: AXES.map((ax, a) => { const t = new Float64Array(K); for (const z of zz[a]) for (let k = 0; k < K; k++) t[k] += z[k]; return t; }) });
    });
    return res;
}

// the static filters in the frequency domain at the firmware rate (complex), over their log-rate design when the time domain
// already ran them (mode 'all'); 1 at log rate = filter rate in mode 'all'
function staticCorrection(prep, M, mode) {
    const ck = `${staticKey(M)}|${mode}|${M.rates.logHz}`; if (!prep.scCache) prep.scCache = new Map(); const hit = prep.scCache.get(ck); if (hit) return hit;
    const v = staticCorrectionCalc(prep, M, mode); prep.scCache.set(ck, v); return v;
}
function staticCorrectionCalc(prep, M, mode) {
    const { f, K } = prep, fsF = M.rates.filterHz, fsL = M.rates.logHz, re = new Float64Array(K).fill(1), im = new Float64Array(K);
    for (const st of M.statics) for (const c of M.sectionsOf(st, fsF)) mulSection(c, fsF, f, re, im);
    if (mode === 'all' && fsL !== fsF) {
        const lr = new Float64Array(K).fill(1), lm = new Float64Array(K);
        for (const st of M.statics) { const cs = st.kind === 'lpf' ? lowpassSections(st.type, st.hz, fsL) : [notchAt(st.hz, st.q, fsF, fsL)]; for (const c of cs) mulSection(c, fsL, f, lr, lm); }
        for (let k = 0; k < K; k++) { const d = lr[k] * lr[k] + lm[k] * lm[k]; if (d > 1e-12) { const a0 = (re[k] * lr[k] + im[k] * lm[k]) / d, b0 = (im[k] * lr[k] - re[k] * lm[k]) / d; re[k] = a0; im[k] = b0; } }
    } else if (mode === 'all') { re.fill(1); im.fill(0); }
    return { re, im, p2: Float64Array.from(re, (v, k) => v * v + im[k] * im[k]) };
}

// ---------------------------------------------------------------------------------------------
// Lines: rotor-locked lines of gyroRAW, from the windows (order spectrum of the raw PSD over the band median)
// ---------------------------------------------------------------------------------------------

/**
 * findLines(prep, logFilter) -> [{ axis, order, prominence, harmonic, tail, kind }]. The raw PSD of every window over its band
 * median is accumulated against rotor order (headspeed of the window); a rotor-locked line is a peak of prominence
 * RULES.lines.prominence (amplitude over the median of +-0.5 order). A line within RULES.lines.harmonicTol of an integer is a
 * main rotor harmonic and sits at that integer (the RPM notch filters of the firmware use the same multiple of the
 * headspeed); within the same tolerance of a tail rotor harmonic of the configured gear ratio it is a tail rotor harmonic. Any
 * other line is a resonance: a target for a notch filter (CLAUDE.md "Gear ratios").
 */
function findLines(prep, logFilter) {
    const { f, logHz } = prep, nyq = 0.5 * logHz, L0 = RULES.lines, step = 0.002, nb = Math.round(RULE.maxOrder / step) + 1, lines = [];
    const M = prep.logs[0] && prep.logs[0].model, tailBank = M ? M.rpm.flat().find(b => b.source >= 21 && b.source <= 28 && b.order !== null) : null;
    const tailOrder = tailBank ? tailBank.order / (tailBank.source - 20) / (1 + tailBank.center / 10000) : null;
    for (let a = 0; a < 3; a++) {
        const acc = new Float64Array(nb), cnt = new Float64Array(nb);
        for (const L of prep.logs) { if (logFilter && !logFilter(L)) continue; const W = L.windows, scale = L.model.rates.scale;
            for (let w = 0; w < W.n; w++) { const rot = W.hs[w] / 60 / scale; if (!(rot > 5)) continue; const sx = W.sxx[a][w];
                const band = []; for (let k = 0; k < sx.length; k += 2) if (f[k] >= 20 && f[k] <= 0.95 * nyq) band.push(sx[k]);
                const med = median(band) || 1e-12;
                // spread each bin over the orders it covers (linear interpolation into the order grid)
                for (let k = 1; k < sx.length; k++) { if (f[k] < 20 || f[k] > 0.95 * nyq) continue; const o = f[k] / rot / step, b = Math.floor(o), u = o - b; if (b + 1 >= nb) continue;
                    const v = sx[k] / med; acc[b] += v * (1 - u); cnt[b] += 1 - u; acc[b + 1] += v * u; cnt[b + 1] += u; } } }
        const m = Float64Array.from(acc, (v, b) => cnt[b] > 0.5 ? v / cnt[b] : 0), half = Math.round(0.04 / step), wide = Math.round(0.5 / step);
        const found = [];
        for (let b = Math.round(L0.minOrder / step); b < nb - wide; b++) {
            if (!(m[b] > 0)) continue; let top = true;
            for (let j = b - half; j <= b + half && top; j++) if (j !== b && m[j] > m[b]) top = false;
            if (!top) continue;
            const ref = []; for (let j = b - wide; j <= b + wide; j += 2) if (Math.abs(j - b) > 2 * half && m[j] > 0) ref.push(m[j]);
            const bg = median(ref) || 1e-12, prom = Math.sqrt(m[b] / bg);
            if (prom < L0.prominence) continue;
            const A = Math.log(m[b - 1] || 1e-300), B = Math.log(m[b]), C = Math.log(m[b + 1] || 1e-300), d = A - 2 * B + C;
            const order = (b + (d ? 0.5 * (A - C) / d : 0)) * step, near = Math.round(order);
            let harmonic = near >= 1 && Math.abs(order / near - 1) <= L0.harmonicTol ? near : null, tail = null;
            if (tailOrder) { const k = Math.round(order / tailOrder); if (k >= 1 && Math.abs(order / (k * tailOrder) - 1) <= L0.harmonicTol) tail = k; }
            const kind = harmonic ? `main rotor ${harmonic}x` : tail ? `tail rotor ${tail}x` : 'resonance (not a rotor harmonic)';
            const at = harmonic ? harmonic : tail ? tail * tailOrder : order;   // the line sits at the multiple the firmware uses
            found.push({ axis: AXES[a], order: r(at, 4), measuredOrder: r(order, 4), prominence: r(prom, 1), harmonic, tail, kind });
        }
        for (const l of found) lines.push(l);
    }
    return lines.sort((p, q) => q.prominence - p.prominence);
}

// ---------------------------------------------------------------------------------------------
// Line-aware windows: the raw PSD of a window as broadband plus the power of each rotor-locked line
// ---------------------------------------------------------------------------------------------

/**
 * A windowed spectrum spreads a line over the main lobe of the Hann window (+-2 bins) and over the change of the rotor speed in
 * the window, but an RPM notch follows the line sample by sample. So |H(f)|^2 of each bin under-estimates a deep notch on its
 * line. decompose() gives each window and axis: rest (the PSD with the bins of each line set to the local background) and,
 * per line, its power above the background (lineP), the background (lineBg), its centre bin and half width. The replica
 * then applies |H| at the line frequency itself (at each notch state) to the line power, and |H(f)| to the rest.
 */
function decompose(prep, lines) {
    const { f, df, logHz } = prep, nyq = 0.5 * logHz;
    for (const L of prep.logs) {
        const W = L.windows, scale = L.model.rates.scale;
        W.lines = AXES.map(ax => lines.map((l, i) => ({ l, i })).filter(o => o.l.axis === ax));
        W.rest = [[], [], []]; W.lineP = [[], [], []]; W.lineBg = [[], [], []]; W.lineK = [[], [], []]; W.lineSpan = [[], [], []]; W.owner = [[], [], []];
        for (let a = 0; a < 3; a++) {
            const LS = W.lines[a];
            for (let w = 0; w < W.n; w++) {
                const sx = W.sxx[a][w], rest = Float32Array.from(sx), rot = W.hs[w] / 60 / scale, P = new Float32Array(LS.length), Bg = new Float32Array(LS.length), Kc = new Int16Array(LS.length), Sp = new Int8Array(LS.length);
                const owner = new Int16Array(sx.length).fill(-1), dist = new Float64Array(sx.length).fill(Infinity);
                LS.forEach(({ l }, j) => { const fl = l.order * rot, kc = fl / df; if (!(rot > 5) || fl > 0.95 * nyq || kc < 3) { Kc[j] = -1; return; }
                    const span = 2 + Math.ceil(fl * W.spread[w] / 2 / df); Kc[j] = Math.round(kc); Sp[j] = Math.min(127, span);
                    for (let k = Kc[j] - span; k <= Kc[j] + span; k++) if (k > 0 && k < sx.length && Math.abs(k - kc) < dist[k]) { dist[k] = Math.abs(k - kc); owner[k] = j; } });
                LS.forEach((o, j) => { if (Kc[j] < 0) return; const span = Sp[j], bg = [];
                    for (let k = Kc[j] - span - 6; k <= Kc[j] + span + 6; k++) if (k > 0 && k < sx.length && owner[k] < 0) bg.push(sx[k]);
                    const b = bg.length ? median(bg) : 0; Bg[j] = b; let p = 0;
                    for (let k = Kc[j] - span; k <= Kc[j] + span; k++) if (k > 0 && k < sx.length && owner[k] === j) { p += Math.max(0, sx[k] - b); rest[k] = Math.min(sx[k], b); }
                    P[j] = p; });
                W.rest[a].push(rest); W.lineP[a].push(P); W.lineBg[a].push(Bg); W.lineK[a].push(Kc); W.lineSpan[a].push(Sp); W.owner[a].push(Int8Array.from(owner));
            }
        }
    }
}


// ---------------------------------------------------------------------------------------------
// Parity: the replica against the logged gyroADC, per log, PID profile and axis
// ---------------------------------------------------------------------------------------------

/**
 * parity(prep) -> per log { log, passed, axes: { roll|pitch|yaw: { passed, lines, bands, delay... } } }, from the windows at
 * near-constant rotor speed (RULE.rpmSpread). Predicted logged output = C(f) x replica output (C: the static filters at the
 * firmware rate), with the rounding of the logged gyroRAW taken out (|T|^2 Q) and that of the logged gyroADC put in (Q);
 * predicted cross-spectrum = C x replica cross-spectrum x exp(-j 2 pi f tau), tau the logging offset.
 *   lines: transmission |T| where the coherence of the log is RULES.parity.minCoherence or more; a line that both pass at
 *          RULES.parity.removedPass or less is "removed in both" (no dB compare); the median |error| over the lines used
 *   bands: output power in RULE.bands pooled over the profiles of the log; floor-limited where the prediction is under
 *          minFloorRatio x the rounding floor (not validated, noted)
 *   delay: F11 statistic (coherence-weighted -phase / 2 pi f at 8-16 Hz) of the log and of the replica
 * An axis passes when its median line error <= lineDb, every band that is not floor-limited <= bandDb and the delay error
 * <= delayMs. The model is used only on the axes and bands that pass (usableMask).
 */
function parity(prep) {
    const { f, logHz, Q, df } = prep, P = RULES.parity, nyq = logHz / 2, lines = prep.lines, out = [];
    prep.logs.forEach((L, li) => {
        const B = prep.base[li], C = B.C, res = { log: L.log, axes: {}, passed: true, windows: 0, seconds: r(L.seconds, 1) };
        for (let a = 0; a < 3; a++) {
            const lineErr = [], bandErr = [], lineRows = [], bandRows = [], pooled = [];
            let delayM = 0, delayP = 0, dw = 0, nWin = 0;
            for (const [prof, PA] of L.parity) {
                const A = PA[a]; if (A.n < P.minWindows || !A.szz) continue; nWin += A.n;
                const n = A.n, pyy = new Float64Array(f.length), pRe = new Float64Array(f.length), pIm = new Float64Array(f.length);
                for (let k = 0; k < f.length; k++) {
                    const tr = A.sxzRe[k] / A.sxx[k], ti = A.sxzIm[k] / A.sxx[k];
                    pyy[k] = C.p2[k] * Math.max(0, A.szz[k] - Q * n * (tr * tr + ti * ti)) + Q * n;
                    const cr = C.re[k] * A.sxzRe[k] - C.im[k] * A.sxzIm[k], ci = C.re[k] * A.sxzIm[k] + C.im[k] * A.sxzRe[k], w2 = 2 * Math.PI * f[k] * L.tau;
                    pRe[k] = cr * Math.cos(w2) + ci * Math.sin(w2); pIm[k] = ci * Math.cos(w2) - cr * Math.sin(w2);
                }
                const rot = median(PA[0].hs) / 60 / L.model.rates.scale;
                for (const [bi, [lo, hi0]] of RULE.bands.entries()) {
                    const hi = hi0 < 1 ? hi0 * nyq : hi0; let pm = 0, pp = 0, pf = 0;
                    for (let k = 0; k < f.length; k++) if (f[k] >= lo && f[k] < hi) { pm += A.syy[k]; pp += pyy[k]; pf += Q * n; }
                    bandRows.push({ profile: prof, band: [lo, r(hi, 1)], measuredDb: r(db(pm / pf), 2), predictedDb: r(db(pp / pf), 2), errorDb: r(db(pp / pm), 2), floorLimited: pp < P.minFloorRatio * pf, windows: n });
                    const T = pooled[bi] = pooled[bi] || { band: [lo, r(hi, 1)], pm: 0, pp: 0, pf: 0, windows: 0 }; T.pm += pm; T.pp += pp; T.pf += pf; T.windows += n;
                }
                for (const l of lines) { if (l.axis !== AXES[a]) continue;
                    const fl = l.order * rot, k0 = Math.round(fl / df); if (k0 < 3 || fl > 0.95 * nyq) continue;
                    const span = RULES.lines.halfWidthBins + Math.ceil(fl * RULE.rpmSpread / 2 / df);
                    let sx = 0, sy = 0, cr = 0, ci = 0, pr = 0, pi = 0, py = 0, fl0 = 0; const bg = [];
                    for (let k = k0 - span; k <= k0 + span; k++) { sx += A.sxx[k]; sy += A.syy[k]; cr += A.sxyRe[k]; ci += A.sxyIm[k]; pr += pRe[k]; pi += pIm[k]; py += pyy[k]; fl0 += Q * n; }
                    for (let k = k0 - 6 * span; k <= k0 + 6 * span; k++) if (k > 0 && k < f.length && Math.abs(k - k0) > 2 * span) bg.push(A.sxx[k]);
                    const snr = sx / ((median(bg) || 1e-12) * (2 * span + 1)), coh = (cr * cr + ci * ci) / (sx * sy), Tm = Math.hypot(cr, ci) / sx, Tp = Math.hypot(pr, pi) / sx;
                    const passM = Math.sqrt(Math.max(0, sy - fl0) / sx), passP = Math.sqrt(Math.max(0, py - fl0) / sx);
                    const row = { profile: prof, order: l.order, kind: l.kind, hz: r(fl * L.model.rates.scale, 1), snr: r(snr, 1), coherence: r(coh, 3), measuredPass: r(Tm, 4), predictedPass: r(Tp, 4),
                        transmissionErrorDb: r(20 * Math.log10(Tp / Tm), 2), measuredOutPass: r(passM, 4), predictedOutPass: r(passP, 4), outputErrorDb: r(db((py - fl0) / (sy - fl0)), 2), windows: n };
                    row.floorLimited = py < P.minFloorRatio * fl0 && sy < P.minFloorRatio * fl0;
                    row.removedInBoth = passM <= P.removedPass && passP <= P.removedPass;
                    row.used = snr >= P.minLineSnr && (row.floorLimited || row.removedInBoth || coh >= P.minCoherence);
                    row.errorDb = row.floorLimited || row.removedInBoth ? 0 : coh >= P.minCoherence ? row.transmissionErrorDb : row.outputErrorDb;
                    if (row.used && row.errorDb !== null) lineErr.push(Math.abs(row.errorDb));
                    lineRows.push(row);
                }
                for (let k = 1; k < f.length; k++) if (f[k] >= RULES.delay.f11Band[0] && f[k] <= RULES.delay.f11Band[1]) {
                    const coh = (A.sxyRe[k] ** 2 + A.sxyIm[k] ** 2) / (A.sxx[k] * A.syy[k]); if (!(coh > 0)) continue;
                    delayM += coh * -Math.atan2(A.sxyIm[k], A.sxyRe[k]) / (2 * Math.PI * f[k]); delayP += coh * -Math.atan2(pIm[k], pRe[k]) / (2 * Math.PI * f[k]); dw += coh;
                }
            }
            const bands = pooled.filter(Boolean).map(T => { const e = db(T.pp / T.pm), floorLimited = T.pp < P.minFloorRatio * T.pf;
                const ok = floorLimited || (e !== null && Math.abs(e) <= P.bandDb); if (!floorLimited && e !== null) bandErr.push(Math.abs(e));
                return { band: T.band, measuredDb: r(db(T.pm / T.pf), 2), predictedDb: r(db(T.pp / T.pf), 2), errorDb: r(e, 2), floorLimited, passed: ok, windows: T.windows }; });
            const dM = dw ? 1000 * delayM / dw / L.model.rates.scale : null, dP = dw ? 1000 * delayP / dw / L.model.rates.scale : null;
            const medLine = lineErr.length ? median(lineErr) : null, maxBand = bandErr.length ? Math.max(...bandErr) : null;
            const linesOk = medLine === null || medLine <= P.lineDb, delayOk = dM === null || Math.abs(dP - dM) <= P.delayMs;
            const ok = linesOk && (maxBand === null || maxBand <= P.bandDb) && delayOk && (lineErr.length + bandErr.length > 0);
            res.axes[AXES[a]] = { passed: ok, linesPassed: linesOk, delayPassed: delayOk, windows: nWin, medianLineErrorDb: r(medLine, 2), maxLineErrorDb: lineErr.length ? r(Math.max(...lineErr), 2) : null, linesUsed: lineErr.length,
                maxBandErrorDb: r(maxBand, 2), bandsPassed: bands.filter(b => b.passed).length, bandsUsed: bands.length,
                delayMeasuredMs: r(dM, 3), delayPredictedMs: r(dP, 3), delayErrorMs: dM === null ? null : r(dP - dM, 3), loggingOffsetMs: r(1000 * L.tau, 3), bands, lines: lineRows, bandsByProfile: bandRows };
            res.windows = Math.max(res.windows, nWin);
            if (!ok) res.passed = false;
        }
        out.push(res);
    });
    return out;
}

// the bins of the noise band where the model passed parity, per log and axis (an axis whose lines or delay fail: none)
function usableMasks(prep, par) {
    const { f, logHz } = prep, nyq = logHz / 2;
    return par.map(p => AXES.map(ax => {
        const A = p.axes[ax], m = new Uint8Array(f.length);
        if (!A || !A.linesPassed || !A.delayPassed) return m;
        for (const b of A.bands) if (b.passed) for (let k = prep.band[0]; k <= prep.band[1]; k++) if (f[k] >= b.band[0] && f[k] < b.band[1]) m[k] = 1;
        void nyq; return m;
    }));
}

// ---------------------------------------------------------------------------------------------
// Evaluation of a candidate: the noise that reaches the PID output, per flight log, axis and line; and the time delay
// ---------------------------------------------------------------------------------------------

// the signature of the time-varying part of a replica: what runChain depends on
function tvKey(M) {
    const rpm = M.rpm.map(l => l.filter(b => b.mult !== null).map(b => `${b.mult.toFixed(9)}:${b.q}`).join('/')).join('|');
    return M.dyn.on ? `${rpm}#dyn:${M.dyn.count}:${M.dyn.q}:${M.dyn.minHz}:${M.dyn.maxHz}:${M.dyn.sampleCount}#${staticKey(M)}` : `${rpm}#rpm`;
}
const changeKey = (ch) => JSON.stringify(Object.keys(ch).sort().map(k => [k, ch[k]]));
// the time-domain run of log li for a replica: the base run or a cached one; onlyCached: null when a new run is necessary
function simFor(prep, li, M, onlyCached) {
    const kk = tvKey(M), b = prep.base[li];
    if (tvKey(b.model) === kk && b.mode === (M.dyn.on ? 'all' : 'rpm')) return b;
    const ck = `${li}|${kk}`; let s0 = prep.simCache && prep.simCache.get(ck);
    if (s0 || onlyCached) return s0 || null;
    if (!prep.simCache) prep.simCache = new Map();
    const L = prep.logs[li]; s0 = simulateAll(Object.assign({}, prep, { logs: [L] }), [withSettings(L.cfg, {})].map(() => M.cfg), false)[0]; prep.simCache.set(ck, s0); prep.simRuns = (prep.simRuns || 0) + 1;
    return s0;
}

// global settings and PID-path overrides of a candidate: { settings: { cli name: value }, pid: { roll_d_cutoff: v, ... } }
function splitChanges(ch) {
    const g = {}, pid = {};
    for (const [k, v] of Object.entries(ch)) if (/^(roll|pitch|yaw)_(d|gyro)_cutoff$/.test(k)) pid[k] = v; else g[k] = v;
    return { g, pid };
}
const pathOf = (L, prof, a, pidCh) => {
    const ax = AXES[a], o = {}; if (pidCh[`${ax}_d_cutoff`] !== undefined) o.d_cutoff = pidCh[`${ax}_d_cutoff`]; if (pidCh[`${ax}_gyro_cutoff`] !== undefined) o.gyro_cutoff = pidCh[`${ax}_gyro_cutoff`];
    return pidPath(L.cfg, prof, a, o);
};

/**
 * evaluate(prep, changes) -> { key, changes, perLog: [{ log, J: [3] (PID output power, usable bins), G: [3] (gyro power at the
 * PID input, usable bins), lines: [{ id, axis, power }], windows }], delay: delayOf(...) }. Exact: the time-varying part comes
 * from runChain for these settings (cached by tvKey), the static filters and the PID path from their responses.
 */
function evaluate(prep, changes) {
    const key = changeKey(changes); let v = prep.cache.get(key); if (v) return v;
    const { g, pid } = splitChanges(changes), K = prep.K, f = prep.f;
    const cfgs = prep.logs.map(L => withSettings(L.cfg, g)), models = cfgs.map(compile);
    const sims = prep.logs.map((L, li) => simFor(prep, li, models[li]));
    const perLog = prep.logs.map((L, li) => {
        const sim = sims[li], M = models[li], C = staticCorrection(prep, M, sim.mode), use = prep.usable[li];
        const J = [0, 0, 0], G = [0, 0, 0], ctrl = [0, 0, 0], blocks = {}, linesOut = [], prs = new Map(), kc0 = Math.ceil(RULES.delay.band[0] / prep.df), kc1 = Math.floor(RULES.delay.band[1] / prep.df);
        const prOf = (prof, a) => { const k = prof + '|' + a; let v0 = prs.get(k); if (!v0) prs.set(k, v0 = pidResponse(M, pathOf(L, prof, a, pid), f)); return v0; };
        for (let a = 0; a < 3; a++) {
            const m = use[a];
            for (const agg of sim.S[a].values()) {
                const pr = prOf(agg.prof, a), S = agg.s; let j = 0, g0 = 0;
                for (let k = prep.band[0]; k <= prep.band[1]; k++) if (m[k]) { const o = C.p2[k] * S[k]; j += pr.out[k] * o; g0 += pr.gyro[k] * o; }
                for (let k = kc0; k <= kc1; k++) ctrl[a] += C.p2[k] * S[k];
                J[a] += j; G[a] += g0; const B0 = blocks[agg.block] = blocks[agg.block] || { J: [0, 0, 0], lines: {} }; B0.J[a] += j;
            }
            L.windows.lines[a].forEach(({ l, i }, j) => { const sp = sim.Lsp[a][j]; let p = 0; for (let k = 0; k < K; k++) p += C.p2[k] * sp[k]; linesOut.push({ id: i, axis: AXES[a], order: l.order, power: p });
                for (const [blk, Lo] of sim.LS[a]) { let q = 0; const v1 = Lo[j]; for (let k = 0; k < K; k++) q += C.p2[k] * v1[k]; const B0 = blocks[blk] = blocks[blk] || { J: [0, 0, 0], lines: {} }; B0.lines[i] = q; } });
        }
        return { log: L.log, J, G, ctrl, blocks, lines: linesOut, windows: L.windows.n };
    });
    v = { key, changes, perLog, delay: delayOf(prep, models, sims, pid) };
    prep.cache.set(key, v);
    return v;
}

/**
 * delayOf -> per log, PID profile and axis: the time delay of the gyro path (gyro chain x PID gyro filter, as P sees it) and of
 * the D path (x difFilter, against an ideal derivative) at RULES.delay.band, and the F11 statistic of the chain (8-16 Hz, with
 * the logging offset, as check F11 measures it). The RPM notches at the median headspeed of the profile; dynamic notches: the
 * mean complex response over the notch states of up to 48 windows of the profile.
 */
const DELAY_FQ = (() => { const D = RULES.delay, fq = []; for (let x = D.band[0]; x <= D.band[1] + 1e-9; x += D.step) fq.push(x); return fq; })();
const DELAY_ALL = Float64Array.from(DELAY_FQ.concat([8, 10, 12, 14, 16]));
function delayOf(prep, models, sims, pid, subset) {
    const fq = DELAY_FQ, f11 = [8, 10, 12, 14, 16], all = DELAY_ALL, out = [];
    prep.logs.forEach((L, li) => {
        const M = models[li], W = L.windows, sim = sims[li], byProf = {};
        for (const prof of L.profiles) {
            const ws = []; for (let w = 0; w < W.n; w++) if (W.prof[w] === prof && (!subset || !M.dyn.on || subset(L, w))) ws.push(w);
            if (!ws.length) { for (let w = 0; w < W.n; w++) if (W.prof[w] === prof) ws.push(w); }
            if (!ws.length) continue;
            const NW = M.dyn.on ? 16 : 48, pick = ws.length <= NW ? ws : Array.from({ length: NW }, (_, j) => ws[Math.floor((j + 0.5) * ws.length / NW)]);
            const res = {};
            for (let a = 0; a < 3; a++) {
                const re = new Float64Array(all.length), im = new Float64Array(all.length); let n = 0;
                if (M.dyn.on && sim.tracks) {
                    const c = new Float64Array(M.dyn.count);
                    for (const w of pick) for (const j of [0, RULE.states >> 1]) { const tr = sim.tracks[W.seg[w]][a]; centresAt(tr, W.pos[w][j], M.dyn.count, c);
                        const h = chainResponse(M, a, all, { hs: W.hsK[w][j], tail: W.tail[w], dyn: Array.from(c) }); for (let k = 0; k < all.length; k++) { re[k] += h.re[k]; im[k] += h.im[k]; } n++; }
                } else { const h = chainResponse(M, a, all, { hs: median(pick.map(w => W.hs[w])), tail: median(pick.map(w => W.tail[w])) }); re.set(h.re); im.set(h.im); n = 1; }
                const path = pathOf(L, prof, a, pid || {}), pr = pidResponse(M, path, all), tauOf = (x, y, fz) => -Math.atan2(y, x) / (2 * Math.PI * fz) * 1000 / M.rates.scale;
                const P0 = [], D0 = [];
                fq.forEach((fz, k) => { const hr = re[k] / n, hi = im[k] / n, gr = hr * pr.gyroC.re[k] - hi * pr.gyroC.im[k], gi = hr * pr.gyroC.im[k] + hi * pr.gyroC.re[k];
                    P0.push(tauOf(gr, gi, fz));
                    if (path.d_cutoff > 0) { const dr = gr * pr.difC.re[k] - gi * pr.difC.im[k], di = gr * pr.difC.im[k] + gi * pr.difC.re[k], ph = Math.atan2(di, dr) - Math.PI / 2; D0.push(-ph / (2 * Math.PI * fz) * 1000 / M.rates.scale); } else D0.push(null); });
                const f11v = f11.map((fz, j) => tauOf(re[fq.length + j] / n, im[fq.length + j] / n, fz)).reduce((p, q) => p + q, 0) / f11.length + 1000 * L.tau / M.rates.scale;
                res[AXES[a]] = { P: P0.map(v => r(v, 3)), D: D0.map(v => v === null ? null : r(v, 3)), f11Ms: r(f11v, 3) };
            }
            byProf[prof] = res;
        }
        out.push({ log: L.log, freqs: fq, byProfile: byProf });
    });
    return out;
}

// the delay change of a candidate against the base: the largest added delay (ms) over logs, profiles, axes, paths and freqs
function delayChange(base, cand) {
    let worst = -Infinity, at = null, f11Max = -Infinity, f11Base = -Infinity;
    cand.forEach((c, li) => { const b = base[li];
        for (const prof of Object.keys(c.byProfile)) for (const ax of AXES) { const C0 = c.byProfile[prof][ax], B0 = b.byProfile[prof] && b.byProfile[prof][ax]; if (!B0) continue;
            for (const path of ['P', 'D']) C0[path].forEach((v, k) => { if (v === null || B0[path][k] === null) return; const d = v - B0[path][k]; if (d > worst) { worst = d; at = { log: c.log, profile: +prof, axis: ax, path, hz: c.freqs[k], fromMs: B0[path][k], toMs: v }; } });
            if (C0.f11Ms > f11Max) f11Max = C0.f11Ms; if (B0.f11Ms > f11Base) f11Base = B0.f11Ms; } });
    return { maxAddMs: r(worst, 3), at, f11MaxMs: r(f11Max, 3), f11BaseMs: r(f11Base, 3) };
}

// the screening subset of the dynamic notch moves: every fourth block of RULE.blockS s (a quarter of the time domain work)
const inScreen = (L, w) => L.windows.block[w] % 4 === 0;
// J per log and axis of a candidate over the screening subset (time domain, cached), with the PID path of the candidate
function subsetJ(prep, changes) {
    const { g, pid } = splitChanges(changes), f = prep.f; if (!prep.subCache) prep.subCache = new Map();
    return prep.logs.map((L, li) => {
        const M = compile(withSettings(L.cfg, g)), ck = `${li}|${tvKey(M)}|${M.dyn.on ? 'all' : 'rpm'}`; let sim = prep.subCache.get(ck);
        if (!sim) { sim = simulateAll(Object.assign({}, prep, { logs: [L] }), [M.cfg], false, inScreen)[0]; prep.subCache.set(ck, sim); prep.subRuns = (prep.subRuns || 0) + 1; }
        const C = staticCorrection(prep, M, sim.mode), use = prep.usable[li], J = [0, 0, 0];
        for (let a = 0; a < 3; a++) for (const agg of sim.S[a].values()) { const pr = pidResponse(M, pathOf(L, agg.prof, a, pid), f), S = agg.s;
            for (let k = prep.band[0]; k <= prep.band[1]; k++) if (use[a][k]) J[a] += pr.out[k] * C.p2[k] * S[k]; }
        return { J, sim, model: M };
    });
}

// ---------------------------------------------------------------------------------------------
// Screening of RPM notch candidates (frequency domain, line-aware; no dynamic notch): the ratio to the base, verified later
// ---------------------------------------------------------------------------------------------

function screenGroups(prep) {
    if (prep.groups) return prep.groups;
    prep.groups = prep.logs.map(L => { const W = L.windows; return AXES.map((ax, a) => { const G = new Map();
        for (let w = 0; w < W.n; w++) { const q = Math.round(Math.log(Math.max(1, W.hs[w])) / Math.log(1 + RULE.screenRpmStep)), key = `${W.prof[w]}|${q}`; let g = G.get(key);
            if (!g) G.set(key, g = { prof: W.prof[w], hs: Math.round(Math.exp(q * Math.log(1 + RULE.screenRpmStep)) / RULE.rpmQuant) * RULE.rpmQuant, tail: W.tail[w], rest: new Float64Array(prep.K), lineP: new Float64Array(W.lines[a].length) });
            const rs = W.rest[a][w], lp = W.lineP[a][w]; for (let k = 0; k < prep.K; k++) g.rest[k] += rs[k]; for (let j = 0; j < lp.length; j++) g.lineP[j] += lp[j]; }
        return [...G.values()]; }); });
    return prep.groups;
}
const SCREEN_FLOOR = 0.02;   // the depth floor of a tracked notch on its line in screening only (the time domain verifies)
function screenJ(prep, li, M, pid) {
    const L = prep.logs[li], G = screenGroups(prep)[li], f = prep.f, fsF = M.rates.filterHz, use = prep.usable[li], J = [0, 0, 0];
    const C = staticCorrection(prep, M, 'rpm'); if (!prep.screenCache) prep.screenCache = new Map();
    for (let a = 0; a < 3; a++) {
        const ax = AXES[a], pk = `${pid[`${ax}_d_cutoff`]}|${pid[`${ax}_gyro_cutoff`]}`, ck = `${li}|${a}|${M.rpm[a].map(b => `${b.mult}:${b.q}`).join('/')}|${staticKey(M)}|${pk}`, hit = prep.screenCache.get(ck);
        if (hit !== undefined) { J[a] = hit; continue; }
        for (const g of G[a]) {
        const pr = pidResponse(M, pathOf(L, g.prof, a, pid), f), rs = rpmSections(M, a, g.hs, g.tail), R = prep.rows.power('R' + rs.key + '@' + fsF, rs.sections, fsF), m = use[a];
        for (let k = prep.band[0]; k <= prep.band[1]; k++) if (m[k]) J[a] += pr.out[k] * C.p2[k] * R[k] * g.rest[k];
        L.windows.lines[a].forEach(({ l }, j) => { if (!(g.lineP[j] > 0)) return; const fl = l.order * g.hs / 60 / M.rates.scale, kf = fl / prep.df, kk = Math.round(kf); if (kk < prep.band[0] || kk > prep.band[1] || !m[kk]) return;
            const k0 = Math.floor(kf), u = kf - k0, lerp = (row) => row[k0] * (1 - u) + row[k0 + 1] * u;
            const rk = `${a}|${rs.key}|${l.order}`; let h2 = prep.lineCache && prep.lineCache.get(rk);
            if (h2 === undefined) { if (!prep.lineCache) prep.lineCache = new Map(); const h = chainResponse(M, a, [fl], { hs: g.hs, tail: g.tail }, 'rpm'); h2 = h.re[0] ** 2 + h.im[0] ** 2; if (prep.lineCache.size > 2e5) prep.lineCache.clear(); prep.lineCache.set(rk, h2); }
            J[a] += lerp(pr.out) * lerp(C.p2) * Math.max(h2, SCREEN_FLOOR ** 2) * g.lineP[j]; });
        }
        if (prep.screenCache.size > 1e5) prep.screenCache.clear(); prep.screenCache.set(ck, J[a]);
    }
    return J;
}

// ---------------------------------------------------------------------------------------------
// Scores: noise reduction over units (flight logs; 30 s blocks when the file has fewer than 3 flight logs)
// ---------------------------------------------------------------------------------------------

function unitsOf(prep) {
    if (prep.units) return prep.units;
    const base = evaluate(prep, {});
    prep.unitKind = prep.logs.length >= 3 ? 'flight' : 'block';
    prep.units = prep.unitKind === 'flight' ? prep.logs.map((L, li) => ({ li, block: null, id: `log ${L.log}` }))
        : [].concat(...base.perLog.map((p, li) => Object.keys(p.blocks).map(b => ({ li, block: +b, id: `log ${p.log}, ${+b * RULE.blockS}-${(+b + 1) * RULE.blockS} s` }))));
    return prep.units;
}
const unitJ = (ev, u) => u.block === null ? ev.perLog[u.li].J : (ev.perLog[u.li].blocks[u.block] || { J: [0, 0, 0] }).J;
const unitLine = (ev, u, id) => { if (u.block === null) { const l = ev.perLog[u.li].lines.find(x => x.id === id); return l ? l.power : 0; } const b = ev.perLog[u.li].blocks[u.block]; return b && b.lines[id] !== undefined ? b.lines[id] : 0; };

/**
 * score(prep, ev, base, units) -> { db (total PID output noise power change, dB, pooled), se (jackknife over the units),
 * axes: [{ db, se }], perUnit: [db], worstAxisDb }. Negative dB is less noise.
 */
function score(prep, ev, base, units) {
    const tot = (e, us) => { const t = [0, 0, 0]; for (const u of us) { const j = unitJ(e, u); for (let a = 0; a < 3; a++) t[a] += j[a]; } return t; };
    const c = tot(ev, units), b = tot(base, units), dbT = (cc, bb) => db(sum(cc) / sum(bb)), dbA = (cc, bb, a) => bb[a] > 0 ? db(cc[a] / bb[a]) : null;
    const res = { db: dbT(c, b), axes: AXES.map((ax, a) => ({ axis: ax, db: dbA(c, b, a), se: null })), se: null, perUnit: units.map(u => dbT(unitJ(ev, u), unitJ(base, u))) };
    const n = units.length;
    if (n >= 3) {
        const loo = units.map((u, i) => { const cu = unitJ(ev, u), bu = unitJ(base, u); return { c: c.map((v, a) => v - cu[a]), b: b.map((v, a) => v - bu[a]) }; });
        const jk = (fn) => { const vals = loo.map(fn).filter(v => v !== null && isFinite(v)); if (vals.length < 3) return null; const m = sum(vals) / vals.length; return Math.sqrt((vals.length - 1) / vals.length * sum(vals.map(v => (v - m) ** 2))); };
        res.se = jk(o => dbT(o.c, o.b));
        res.axes.forEach((A, a) => { A.se = jk(o => dbA(o.c, o.b, a)); });
    }
    res.worstAxisDb = Math.max(...res.axes.map(A => A.db === null ? -Infinity : A.db));
    return res;
}

// ---------------------------------------------------------------------------------------------
// Moves: the candidate changes from one point of the search (CLI names, absolute values)
// ---------------------------------------------------------------------------------------------

const QGRID = [20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250];   // rpm notch q (Q x 10), >= the 2.0 floor
const DYNQ = [20, 25, 30, 35, 40, 50, 60, 80];
const DYNMIN = [20, 30, 40, 50, 60, 80, 100, 120, 150, 200];
const DYNMAX = [150, 200, 240, 280, 320, 360, 400, 450, 500];
const LPFHZ = [60, 70, 80, 100, 120, 150, 200, 250, 300, 400];
const LPFTYPES = [1, 3, 4, 5, 7, 8, 9];   // FIRST_ORDER, PT1, PT2, PT3, BUTTER, BESSEL, DAMPED (SECOND_ORDER = BESSEL, ORDER1 = FIRST_ORDER)
const bankChanges = (banks) => { const ch = { gyro_rpm_notch_preset: 0 };
    AXES.forEach((ax, a) => { const b = banks[a]; ch[`gyro_rpm_notch_source_${ax}`] = pad16(b.map(x => x.source)); ch[`gyro_rpm_notch_q_${ax}`] = pad16(b.map(x => x.q)); ch[`gyro_rpm_notch_center_${ax}`] = pad16(b.map(x => x.center)); });
    return ch; };

function movesOf(prep, ref, cur, lines, opts = {}) {
    const { g } = splitChanges(cur), cfg = withSettings(ref, g), s = cfg.s, M = compile(cfg), out = [], fl = RULES.floors;
    const add = (family, label, ch) => out.push({ family, label, changes: Object.assign({}, cur, ch) });
    const nyq = M.rates.pidHz / 2, rot = median(prep.logs.map(L => median(Array.from(L.windows.hs)))) / 60, scale = prep.logs[0].model.rates.scale;
    const res = lines.filter(l => !l.harmonic && !l.tail).sort((p, q) => q.prominence - p.prominence);
    // RPM notch banks (preset 0 with every bank written; a preset is one setting)
    const banks = effectiveBanks(s);
    if (s.RPM_FILTER !== false && banks.every(Boolean) && opts.rpm !== false) {
        const tailKnown = !!(cfg.gear && cfg.gear.tail);
        AXES.forEach((ax, a) => {
            const B = banks[a];
            B.forEach((b, i) => {
                for (const q of QGRID) if (q !== b.q && q >= fl.minNotchQ * 10) { const nb = banks.map(x => x.map(y => Object.assign({}, y))); nb[a][i].q = q; add('rpm', `${ax} RPM notch ${b.source} q ${q}`, bankChanges(nb)); }
                const nb = banks.map(x => x.slice()); nb[a] = B.filter((_, j) => j !== i); add('rpm', `${ax} RPM notch ${b.source} out`, bankChanges(nb));
            });
            if (B.length < FW.rpmBanks) {
                const want = []; for (let h = 1; h <= 8; h++) if (!B.some(b => b.source === 10 + h && b.center === 0)) want.push(10 + h);
                if (tailKnown) for (let h = 1; h <= 4; h++) if (!B.some(b => b.source === 20 + h)) want.push(20 + h);
                for (const src of want) for (const q of [30, 50, 80]) { const nb = banks.map(x => x.slice()); nb[a] = B.concat([{ source: src, q, center: 0 }]); add('rpm', `${ax} RPM notch ${src} q ${q} in`, bankChanges(nb)); }
                if (opts.allowCenterShift) for (const l of res.filter(x => x.axis === ax).slice(0, 2)) { const h = Math.max(1, Math.min(8, Math.round(l.order))), c = Math.round((l.order / h - 1) * 10000);
                    for (const q of [30, 50]) { const nb = banks.map(x => x.slice()); nb[a] = B.concat([{ source: 10 + h, q, center: c }]); add('rpm-center', `${ax} RPM notch ${10 + h} centre ${c} q ${q} in`, bankChanges(nb)); } }
            }
        });
        for (const p of [1, 2, 3]) if (p !== s.gyro_rpm_notch_preset) add('rpm', `RPM notch preset ${p}`, Object.assign({ gyro_rpm_notch_preset: p }, Object.fromEntries(AXES.flatMap(ax => ['source', 'q', 'center'].map(k => [`gyro_rpm_notch_${k}_${ax}`, pad16(PRESETS[p][AXES.indexOf(ax)][k])])))));
    }
    // dynamic notch (feature DYN_NOTCH; off below a PID rate of 1 kHz)
    if (M.rates.pidHz >= FW.dynMinUpdateHz && opts.dyn !== false) {
        const on = s.DYN_NOTCH === true && s.dyn_notch_count > 0, hzOf = (l) => l.order * rot * scale;
        if (on) {
            add('dyn', 'dynamic notch off', { DYN_NOTCH: false });
            const near = (grid, v, k) => { const i = grid.reduce((b, x, j) => Math.abs(x - v) < Math.abs(grid[b] - v) ? j : b, 0); return grid.filter((x, j) => Math.abs(j - i) <= k && x !== v); };
            for (const c of [s.dyn_notch_count - 1, s.dyn_notch_count + 1]) if (c >= 1 && c <= FW.dynCountMax) add('dyn', `dyn_notch_count ${c}`, { dyn_notch_count: c });
            for (const q of near(DYNQ, s.dyn_notch_q, 1)) add('dyn', `dyn_notch_q ${q}`, { dyn_notch_q: q });
            for (const mn of near(DYNMIN, s.dyn_notch_min_hz, 1)) if (mn < s.dyn_notch_max_hz - 40) add('dyn', `dyn_notch_min_hz ${mn}`, { dyn_notch_min_hz: mn });
            for (const mx of near(DYNMAX, s.dyn_notch_max_hz, 1)) if (mx > s.dyn_notch_min_hz + 40 && mx <= Math.max(nyq, 100)) add('dyn', `dyn_notch_max_hz ${mx}`, { dyn_notch_max_hz: mx });
        } else {
            // on, with a range that holds the strongest resonance lines of all profiles (each profile has its own headspeed)
            const hz = [].concat(...res.slice(0, 3).map(l => prep.logs.flatMap(L => L.profiles.map(p => { const ws = []; for (let w = 0; w < L.windows.n; w++) if (L.windows.prof[w] === p) ws.push(L.windows.hs[w]); return ws.length ? l.order * median(ws) / 60 : null; }).filter(Boolean))));
            const lo = hz.length ? Math.min(...hz) : 100, hi = hz.length ? Math.max(...hz) : 240;
            // the range of the resonance lines (80 % of the lowest to 115 % of the highest); the header range too if it holds them
            const mn = Math.min(200, Math.max(20, Math.floor(0.8 * lo / 10) * 10)), mx = Math.max(100, Math.min(500, Math.ceil(1.15 * hi / 10) * 10, Math.floor(nyq)));
            const ranges = [[mn, mx]]; if (s.dyn_notch_min_hz <= 0.8 * lo && s.dyn_notch_max_hz >= 1.15 * hi) ranges.push([s.dyn_notch_min_hz, s.dyn_notch_max_hz]);
            for (const [a0, b0] of ranges) if (b0 > a0 + 40) for (const c of [2, 4]) for (const q of [25, 40]) add('dyn', `dynamic notch on: count ${c}, q ${q}, ${a0}-${b0} Hz`, { DYN_NOTCH: true, dyn_notch_count: c, dyn_notch_q: q, dyn_notch_min_hz: a0, dyn_notch_max_hz: b0 });
        }
    }
    // gyro low-pass filters
    if (opts.lpf !== false) for (const [n0, tk, hk0] of [['LPF1', 'gyro_lpf1_type', 'gyro_lpf1_static_hz'], ['LPF2', 'gyro_lpf2_type', 'gyro_lpf2_static_hz']]) {
        const t0 = s[tk], h0 = s[hk0], limit = M.rates.gyroHz ? Math.round(FW.configLimit * M.rates.gyroHz / M.rates.filtDenom) : 1000;
        if (t0 > 0 && h0 > 0) add('lpf', `${n0} off`, { [tk]: 0 });
        for (const t of LPFTYPES) for (const hz of LPFHZ) if (hz >= fl.minLpfHz && hz <= limit && !(t === t0 && hz === h0)) add('lpf', `${n0} ${FW.LPF[t]} ${hz} Hz`, { [tk]: t, [hk0]: hz });
    }
    // static notches at a resonance line (one frequency: the profile with the most windows)
    if (opts.notch !== false) for (const l of res.slice(0, 3)) for (const [slot, hz0, co0] of [[1, 'gyro_notch1_hz', 'gyro_notch1_cutoff'], [2, 'gyro_notch2_hz', 'gyro_notch2_cutoff']]) {
        for (const L of prep.logs.slice(-1)) for (const p of L.profiles) { const ws = []; for (let w = 0; w < L.windows.n; w++) if (L.windows.prof[w] === p) ws.push(L.windows.hs[w]); if (ws.length < 10) continue;
            const c = Math.round(l.order * median(ws) / 60); if (c >= M.rates.filterHz / 2) continue;
            for (const Q of [3, 5, 8]) add('notch', `static notch ${slot} at ${c} Hz, Q ${Q} (${l.axis} ${l.order} x, PID profile ${p})`, { [hz0]: c, [co0]: notchCutoffFor(c, Q) }); }
    }
    // the PID path of each axis (all PID profiles that the logs fly): D-term cutoff, PID gyro filter cutoff
    if (opts.pid !== false) AXES.forEach((ax, a) => {
        const p0 = pidPath(cfg, prep.logs[prep.logs.length - 1].profiles[0], a, splitChanges(cur).pid[`${ax}_d_cutoff`] !== undefined ? { d_cutoff: splitChanges(cur).pid[`${ax}_d_cutoff`] } : {});
        if (p0.d_cutoff > 0 && p0.Kd > 0) for (const d of [-10, -5, -2, 2, 5, 10]) { const v = p0.d_cutoff + d; if (v >= 5 && v <= 250) add('pid', `${ax}_d_cutoff ${v}`, { [`${ax}_d_cutoff`]: v }); }
        if (p0.gyro_cutoff > 0) for (const d of [-20, -10, 10, 20]) { const v = p0.gyro_cutoff + d; if (v >= 20 && v <= 250) add('pid', `${ax}_gyro_cutoff ${v}`, { [`${ax}_gyro_cutoff`]: v }); }
    });
    return out;
}

// the number of CLI settings a candidate changes against the reference (feature lines count as one)
function changeSize(ref, changes) {
    let n = 0;
    for (const [k, v] of Object.entries(changes)) { const r0 = /^(roll|pitch|yaw)_(d|gyro)_cutoff$/.test(k) ? null : ref.s[k]; if (Array.isArray(v) ? String(v) !== String(r0) : v !== r0) n++; }
    return n;
}
// guards: firmware ranges, the documented floors, and the delay limit
function guards(ref, changes, dly) {
    const why = [];
    for (const [k, v] of Object.entries(changes)) {
        const lim = FW_RANGE[k] || (/_d_cutoff$/.test(k) ? FW_RANGE.d_cutoff : /_gyro_cutoff$/.test(k) ? FW_RANGE.gyro_cutoff : null);
        if (lim && typeof v === 'number' && (v < lim[0] || v > lim[1])) why.push(`${k} ${v} is out of the firmware range ${lim[0]}-${lim[1]}`);
        if (/^gyro_lpf\d_static_hz$/.test(k) && v > 0 && v < RULES.floors.minLpfHz && changes[k.replace('static_hz', 'type')] !== 0) why.push(`${k} ${v} is below ${RULES.floors.minLpfHz} Hz`);
        if (k === 'dyn_notch_q' && v < RULES.floors.minNotchQ * 10) why.push(`dyn_notch_q ${v} is below Q ${RULES.floors.minNotchQ}`);
        if (/^gyro_rpm_notch_q_/.test(k) && v.some(q => q && q < RULES.floors.minNotchQ * 10)) why.push(`${k} has a Q below ${RULES.floors.minNotchQ}`);
        if (/^gyro_rpm_notch_source_/.test(k) && v.some(x => x && !((x >= 10 && x <= 18) || (x >= 20 && x <= 28)))) why.push(`${k} has a source that the firmware does not know`);
        if (/^gyro_notch\d_hz$/.test(k) && v > 0) { const co = changes[k.replace('_hz', '_cutoff')]; const Q = notchQ(v, co); if (Q > 0 && Q < RULES.floors.minNotchQ) why.push(`${k}: Q ${r(Q, 2)} is below ${RULES.floors.minNotchQ}`); }
    }
    if (dly) { if (dly.maxAddMs > RULES.delay.maxAddMs) why.push(`it adds ${dly.maxAddMs} ms of delay at ${dly.at.hz} Hz (${dly.at.axis}, ${dly.at.path} path), more than ${RULES.delay.maxAddMs} ms`);
        if (dly.f11MaxMs > RULES.delay.f11FlagMs && dly.f11MaxMs > dly.f11BaseMs + 1e-6) why.push(`the gyro filter delay (check F11) goes to ${dly.f11MaxMs} ms, more than ${RULES.delay.f11FlagMs} ms`); }
    return why;
}

// ---------------------------------------------------------------------------------------------
// Search: greedy over the moves, screening then the time domain; the smallest change that reaches the target
// ---------------------------------------------------------------------------------------------

/**
 * greedy(prep, units, lines, opts) -> path: [{ changes, ev, score, delay, size, label }], starting with the settings of the
 * logs. Each round: every move of movesOf; RPM notch moves on logs without a dynamic notch are screened in the frequency
 * domain (screenJ, ratio to the present point), the best RULE.verifyTop are run in the time domain; all other moves run in
 * the time domain (cached). The best move that passes the guards and makes no axis worse by more than axisWorseDb is taken
 * if it gains minStepDb or more. At most RULE.maxRounds rounds.
 */
function greedy(prep, units, lines, opts = {}) {
    const ref = prep.logs[prep.logs.length - 1].cfg, base = evaluate(prep, {}), R0 = RULES.reduction, t0 = Date.now(), budget = opts.budgetMs || 20000;
    const node = (changes, ev, label) => { const sc = score(prep, ev, base, units), d = delayChange(base.delay, ev.delay); return { changes, ev, score: sc, delay: d, size: changeSize(ref, changes), label, why: guards(ref, changes, d) }; };
    const path = [node({}, base, 'the settings of the logs')], tried = [];
    for (let round = 0; round < RULE.maxRounds && Date.now() - t0 < budget; round++) {
        const cur = path[path.length - 1], moves = movesOf(prep, ref, cur.changes, lines, opts), scored = [];
        const curScreen = prep.logs.map((L, li) => screenJ(prep, li, compile(withSettings(L.cfg, splitChanges(cur.changes).g)), splitChanges(cur.changes).pid));
        let curSub = null;
        const curModels = prep.logs.map((L, li) => compile(withSettings(L.cfg, splitChanges(cur.changes).g))), curSims = prep.logs.map((L, li) => simFor(prep, li, curModels[li]));
        for (const m of moves) {
            const { g, pid } = splitChanges(m.changes), models = prep.logs.map(L => compile(withSettings(L.cfg, g)));
            const newSim = models.some((M, li) => !simFor(prep, li, M, true));
            if (newSim && m.family === 'dyn') {
                const sub = subsetJ(prep, m.changes), subCur = curSub || (curSub = subsetJ(prep, cur.changes));
                const est = { perLog: cur.ev.perLog.map((p, li) => { const sj = sub[li].J, cj = subCur[li].J, k = (v, a) => cj[a] > 0 ? v * sj[a] / cj[a] : v;
                    return { log: p.log, J: p.J.map(k), blocks: Object.fromEntries(Object.entries(p.blocks).map(([b0, B]) => [b0, { J: B.J.map(k), lines: B.lines }])), lines: p.lines }; }) };
                const d = delayChange(base.delay, delayOf(prep, models, sub.map(x => x.sim), pid, inScreen));
                scored.push({ m, screened: true, score: score(prep, est, base, units), delay: d, why: guards(ref, m.changes, d) });
            } else if (newSim) {
                // screening: the frequency-domain ratio against the present point (the dynamic notch held as it is)
                const est = { perLog: cur.ev.perLog.map((p, li) => { const sj = screenJ(prep, li, models[li], pid), cj = curScreen[li], k = (v, a) => cj[a] > 0 ? v * sj[a] / cj[a] : v;
                    return { log: p.log, J: p.J.map(k), blocks: Object.fromEntries(Object.entries(p.blocks).map(([b0, B]) => [b0, { J: B.J.map(k), lines: B.lines }])), lines: p.lines }; }) };
                const d = delayChange(base.delay, delayOf(prep, models, curSims, pid));
                scored.push({ m, screened: true, score: score(prep, est, base, units), delay: d, why: guards(ref, m.changes, d) });
            } else scored.push({ m, screened: false });
        }
        // the moves that need the time domain: evaluate all that are cheap (no new simulation) and the time-varying ones in order
        for (const c of scored) if (!c.screened) {
            if (Date.now() - t0 > budget) { c.skipped = true; continue; }
            const ev = evaluate(prep, c.m.changes), n0 = node(c.m.changes, ev, c.m.label); Object.assign(c, { ev, score: n0.score, delay: n0.delay, why: n0.why });
        }
        const ok = (c) => !c.skipped && c.score && c.score.db !== null && !c.why.length && c.score.axes.every((A, a) => A.db === null || A.db <= R0.axisWorseDb || (cur.score.axes[a].db !== null && A.db <= cur.score.axes[a].db + R0.axisWorseDb));
        const screenedOk = scored.filter(c => c.screened && ok(c)).sort((p, q) => p.score.db - q.score.db).slice(0, RULE.verifyTop);
        for (const c of screenedOk) { const ev = evaluate(prep, c.m.changes), n0 = node(c.m.changes, ev, c.m.label); Object.assign(c, { ev, score: n0.score, delay: n0.delay, why: n0.why, screened: false, verified: true }); }
        const exact = scored.filter(c => !c.screened && ok(c)).sort((p, q) => p.score.db - q.score.db || changeSize(ref, p.m.changes) - changeSize(ref, q.m.changes));
        tried.push(...scored.filter(c => c.score).map(c => ({ round, family: c.m.family, label: c.m.label, changes: c.m.changes, db: c.score.db, se: c.score.se, screened: !!c.screened, verified: !!c.verified, delay: c.delay, why: c.why })));
        const best = exact[0];
        if (!best || !(best.score.db <= cur.score.db - R0.minStepDb)) break;
        path.push(node(best.m.changes, best.ev, best.m.label));
    }
    path.tried = tried; path.timedOut = Date.now() - t0 >= budget;
    return path;
}

// the smallest change of a path that reaches the target: targetShare of the best reduction (dB), at least minDb
function choose(path) {
    const R0 = RULES.reduction, best = path.reduce((b, n) => n.score.db < b.score.db ? n : b, path[0]), target = R0.targetShare * best.score.db;
    const reach = path.filter(n => n.score.db <= target).sort((p, q) => p.size - q.size || p.score.db - q.score.db);
    return { chosen: reach[0] || path[0], best, targetDb: r(target, 2) };
}

// ---------------------------------------------------------------------------------------------
// Leave-one-out validation
// ---------------------------------------------------------------------------------------------

/**
 * looValidate(prep, units, pool) -> for each unit (flight log; 30 s block with fewer than 3 flight logs): the decision rule of
 * the search (guards, no axis worse, the smallest change that reaches targetShare of the best) applied again with the other
 * units only, over the pool of candidates that the search evaluated in the time domain (exact, per unit), and the chosen
 * set's noise change on the unit left out. The pool comes from the search on all units (its moves follow the lines of all
 * flights): a stated limit; the selection, where a fit to the data can happen, is out of sample.
 */
function looValidate(prep, units, pool) {
    const base = evaluate(prep, {}), ref = prep.logs[prep.logs.length - 1].cfg, R0 = RULES.reduction, folds = [];
    for (let i = 0; i < units.length; i++) {
        const train = units.filter((_, j) => j !== i), held = [units[i]];
        const cands = pool.map(n => ({ n, sc: score(prep, n.ev, base, train) })).filter(c => !c.n.why.length && c.sc.db !== null && c.sc.axes.every(A => A.db === null || A.db <= R0.axisWorseDb));
        const best = cands.reduce((b, c) => c.sc.db < b.sc.db ? c : b, { sc: { db: 0 }, n: null }), target = R0.targetShare * best.sc.db;
        const pick = best.n ? cands.filter(c => c.sc.db <= target).sort((p, q) => p.n.size - q.n.size || p.sc.db - q.sc.db)[0] : null;
        const ev = pick ? pick.n.ev : base, sc = score(prep, ev, base, held);
        folds.push({ unit: units[i].id, chosen: pick ? pick.n.changes : {}, chosenCli: pick ? cliLines(ref, pick.n.changes, prep).lines : [], trainDb: r(pick ? pick.sc.db : 0, 2), heldOutDb: r(sc.db, 2) });
    }
    return folds;
}

// ---------------------------------------------------------------------------------------------
// CLI lines, curves, tune()
// ---------------------------------------------------------------------------------------------

const cliValue = (k, v) => /^gyro_lpf\d_type$/.test(k) ? FW.LPF[v] || String(v) : Array.isArray(v) ? v.join(',') : String(v);
/**
 * cliLines(ref, changes, prep) -> { lines: ['feature ...', 'set ...', 'profile N', 'set ...'], rows: [{ name, from, to, source,
 * scope, profile }], unknownProfiles }. Global settings first; PID-path settings for each PID profile of the logs whose
 * value is known (CLI section of that profile, or the log header for the profile at arming when opts.armingProfile says so);
 * CLI profile index = PID profile - 1. The profile before the first switch (label 0) is "PID profile unknown": no CLI.
 */
function cliLines(ref, changes, prep, opts = {}) {
    const { g, pid } = splitChanges(changes), lines = [], rows = [], unknown = [];
    // banks that you set work only with gyro_rpm_notch_preset 0, and the stored custom banks need not equal the preset that
    // the header shows: with preset 0 in the change, every bank array is written
    const allBanks = g.gyro_rpm_notch_preset === 0 && ref.s.gyro_rpm_notch_preset !== 0;
    for (const [k, v] of Object.entries(g)) {
        const from = ref.s[k]; if (!(allBanks && /^gyro_rpm_notch_(source|q|center)_/.test(k)) && (Array.isArray(v) ? String(v) === String(from) : v === from)) continue;
        if (k === 'DYN_NOTCH' || k === 'RPM_FILTER') { lines.push(`feature ${v ? '' : '-'}${k}`); rows.push({ name: `feature ${k}`, from: from === null ? null : !!from, to: !!v, source: ref.from[k], scope: 'global' }); continue; }
        lines.push(`set ${k} = ${cliValue(k, v)}`); rows.push({ name: k, from: from === null || from === undefined ? null : cliValue(k, from), to: cliValue(k, v), source: ref.from[k], scope: 'global' });
    }
    const order = (l) => l.startsWith('feature') ? 0 : /gyro_rpm_notch_preset/.test(l) ? 1 : 2; lines.sort((p, q) => order(p) - order(q));
    if (Object.keys(pid).length) {
        const profs = [...new Set([].concat(...prep.logs.map(L => L.profiles)))].sort((p, q) => p - q);
        for (const p of profs) {
            const fromCli = ref.pid.cli[p], armed = opts.armingProfile && opts.armingProfile === p;
            if (!p || (!fromCli && !armed)) { unknown.push(p || 'unknown'); continue; }
            const sets = [];
            for (const [k, v] of Object.entries(pid)) { const [, ax, kind] = /^(roll|pitch|yaw)_(d|gyro)_cutoff$/.exec(k), src = fromCli && fromCli[ax] && fromCli[ax][`${kind}_cutoff`] !== null ? fromCli[ax] : armed ? ref.pid.header[ax] : null;
                const from = src ? src[`${kind}_cutoff`] : null; if (from === v) continue;
                sets.push(`set ${k} = ${v}`); rows.push({ name: k, from, to: v, source: src ? src.from : null, scope: 'profile', profile: p }); }
            if (sets.length) lines.push(`profile ${p - 1}`, ...sets);
        }
    }
    return { lines, rows, unknownProfiles: unknown };
}

// curves for a before/after spectrum plot, per axis, in log Hz: raw, logged, replica (logged settings), replica (candidate),
// and the PID output of both (permille^2/Hz), over all windows of the flight phase
function curves(prep, ev0, ev1) {
    const { f, K } = prep, kMax = Math.floor(RULE.curveBins * prep.K), scale = prep.logs[0].model.rates.scale, n = sum(prep.logs.map(L => L.windows.n));
    const sims0 = prep.logs.map((L, li) => prep.base[li]);
    const simOf = (ev) => prep.logs.map((L, li) => { const M = compile(withSettings(L.cfg, splitChanges(ev.changes).g)), kk = tvKey(M); return tvKey(prep.base[li].model) === kk ? prep.base[li] : (prep.simCache && prep.simCache.get(`${li}|${kk}`)) || prep.base[li]; });
    const sims1 = ev1 ? simOf(ev1) : null, out = { f: Float32Array.from({ length: kMax }, (_, k) => f[k] * scale), windows: n, unit: '(deg/s)^2/Hz', pidUnit: 'permille^2/Hz' };
    for (let a = 0; a < 3; a++) {
        const raw = new Float64Array(K), logged = new Float64Array(K), p0 = new Float64Array(K), p1 = new Float64Array(K), o0 = new Float64Array(K), o1 = new Float64Array(K);
        prep.logs.forEach((L, li) => {
            for (let k = 0; k < K; k++) { raw[k] += L.rawSum[a][k]; logged[k] += L.loggedSum[a][k]; }
            const add = (sim, ev, P, O) => { const M = compile(withSettings(L.cfg, splitChanges(ev.changes).g)), C = staticCorrection(prep, M, sim.mode), pid = splitChanges(ev.changes).pid;
                for (const agg of sim.S[a].values()) { const pr = pidResponse(M, pathOf(L, agg.prof, a, pid), f); for (let k = 0; k < K; k++) { const o = C.p2[k] * agg.s[k]; P[k] += o; O[k] += pr.out[k] * o * 1e6; } } };
            add(sims0[li], ev0, p0, o0); if (sims1) add(sims1[li], ev1, p1, o1);
        });
        const f32 = (x) => Float32Array.from(x.subarray(0, kMax), v => v / n / scale);
        out[AXES[a]] = { raw: f32(raw), logged: f32(logged), predicted: f32(p0), candidate: sims1 ? f32(p1) : null, pidOut: f32(o0), pidOutCandidate: sims1 ? f32(o1) : null };
    }
    return out;
}

const pm = (v, se, d = 2) => v === null || v === undefined ? null : se === null || se === undefined ? `${r(v, d)}` : `${r(v, d)} ± ${r(se, d)}`;
function summarizeNode(prep, n, base, units, ref) {
    const lines = prep.lines.map((l, id) => ({ l, id })).filter(o => o.l.prominence >= RULES.lines.prominence);
    const perLine = lines.map(({ l, id }) => {
        const vals = units.map(u => { const b = unitLine(base, u, id), c = unitLine(n.ev, u, id); return b > 0 && c > 0 ? db(c / b) : null; }).filter(v => v !== null), ms = meanSe(vals);
        let b0 = 0, c0 = 0; for (const u of units) { b0 += unitLine(base, u, id); c0 += unitLine(n.ev, u, id); }
        return { axis: l.axis, order: l.order, kind: l.kind, prominence: l.prominence, db: r(db(c0 / b0), 2), se: r(ms.se, 2), units: ms.n };
    });
    const ctrl = AXES.map((ax, a) => { let b0 = 0, c0 = 0; base.perLog.forEach((p, li) => { b0 += p.ctrl[a]; c0 += n.ev.perLog[li].ctrl[a]; }); return { axis: ax, db: r(db(c0 / b0), 2) }; });
    return { label: n.label, changes: n.changes, size: n.size, cli: cliLines(ref, n.changes, prep).lines, predicted: { totalDb: r(n.score.db, 2), se: r(n.score.se, 2), axes: n.score.axes.map(A => ({ axis: A.axis, db: r(A.db, 2), se: r(A.se, 2) })), perUnit: n.score.perUnit.map(v => r(v, 2)), perLine,
        controlBand: { band: RULES.delay.band, axes: ctrl, note: 'gyro power at 10-30 Hz after the gyro filters, predicted change (dB): the replica in the time domain shows the noise that the dynamic notch adds there when it switches' } },
        delay: n.delay, guards: n.why };
}

/**
 * tune(logs, opts) -> result. logs: see the header. opts: { cli, gear, flightRpm, armingProfile, allowCenterShift, pid, dyn, lpf,
 * notch, rpm (false turns a family off), budgetMs, foldBudgetMs, loo (false: no leave-one-out), curves (false: none) }.
 * result = { version, ms, model: { parity: [...], passed, rules, notes }, bench, units, lines, current: { settings, from, noise, delay },
 *   candidates: [...], path: [...], recommended: { status, reasons, params, cli, rows, predicted, delay, validation }, curves, notes }
 */
// the notch orders of a gear context: tail rotor speed / rotor speed, motor rpm / rotor speed (motors.c:251-258)
const tailOrderOf = (g) => !g ? null : g.tailOrder > 0 ? g.tailOrder : g.tail && !g.motorisedTail ? Math.max(+g.tail[1], 1) / Math.max(+g.tail[0], 1) : null;
const motorOrderOf = (g) => !g ? null : g.motorOrder > 0 ? g.motorOrder : g.main ? Math.max(+g.main[1], 1) / Math.max(+g.main[0], 1) : null;
// tailOrder() for the result: used (the replica has the fitted orders), and the orders of the CLI dump when one gave them
function summarizeFit(fit, L) {
    if (!fit) return null;
    const g = L && L.cfg && L.cfg.gear, used = !!(g && g.source === 'log notch');
    return Object.assign({}, fit, { used, cli: g && g.source === 'cli' ? { tailOrder: r(tailOrderOf(g), 4), motorOrder: r(motorOrderOf(g), 4) } : null });
}
function summarizeNoise(prep, ev, units) {
    const tot = [0, 0, 0], gy = [0, 0, 0], n = sum(prep.logs.map(L => L.windows.n));
    ev.perLog.forEach(p => { for (let a = 0; a < 3; a++) { tot[a] += p.J[a]; gy[a] += p.G[a]; } });
    return AXES.map((ax, a) => ({ axis: ax, pidOutRmsPermille: r(1000 * Math.sqrt(tot[a] * prep.df / n), 3), gyroRmsDegS: r(Math.sqrt(gy[a] * prep.df / n), 3), band: [RULES.noise.band[0], r(prep.f[prep.band[1]], 1)], units: units.length }));
}

// ---------------------------------------------------------------------------------------------
// Texts for the app (round 3 M2): ASD-STE100 (docs/STE_GLOSSARY.md). The reasons of tune() stay data for the code
// ---------------------------------------------------------------------------------------------

const AXIS_WORD = { roll: 'roll', pitch: 'pitch', yaw: 'yaw' };
const TPATH = { P: 'the P-term', D: 'the D-term' };
const n1 = (v, d = 2) => v === null || v === undefined || !isFinite(v) ? 'unknown' : String(+(+v).toFixed(d));
const andT = (l) => l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : l.join('');
const valueText = (v) => v === true ? 'on' : v === false ? 'off' : v === null || v === undefined ? 'unknown' : String(v);
// the reasons of tune() (English for the code) as STE sentences; a reason that is not known here is quoted
function reasonText(t, units) {
    let m; const s = String(t || '');
    if (/did not pass parity on any axis/.test(s)) return 'The filter model does not agree with the recorded gyroADC on any axis of any flight log.';
    if (/No change passed the guards/.test(s)) return 'No filter change decreases the vibration by 0.1 dB or more in the limits of the time delay and of the documentation.';
    if ((m = /^The predicted change is (-?[\d.]+) dB\. A reduction of ([\d.]+) dB or more is necessary\./.exec(s))) return +m[1] < 0 ? `The best set decreases the vibration by only ${n1(-m[1])} dB. A decrease of ${m[2]} dB or more is necessary.` : `No set decreases the vibration. A decrease of ${m[2]} dB or more is necessary.`;
    if ((m = /^There are (\d+) units/.exec(s))) return `The data has only ${m[1]} ${units}. For an SE, 3 or more are necessary.`;
    if ((m = /less than 2 standard errors \((-?[\d.]+) ± ([\d.]+) dB\)/.exec(s))) return `The decrease of ${n1(-m[1])} ± ${m[2]} dB is less than 2 SE.`;
    if ((m = /In leave-one-out, (\d+) % of the held-out units had less noise; (\d+) % is necessary\./.exec(s))) return `When the app selects the set without one of the ${units}, that part has less vibration in only ${m[1]} % of the tests. ${m[2]} % is necessary.`;
    if (/No flight log with gyroRAW/.test(s)) return 'The file has no flight log with the raw gyro data (`gyroRAW`).';
    return `The analysis of the filter values gives this cause: "${s.replace(/"/g, "'")}".`;
}
// The RPM notch filters that follow a gear ratio (tail rotor, main motor), in the words of the views: the orders that the log
// gave (tailOrder, when the model uses them), or the filters that the model does not have and why. The log is the only input:
// no text asks for a CLI dump or for the gear ratios (CLAUDE.md "Gear ratios": the fit finds the configured value)
const UNIT_WORDS = { flight: 'flight logs', block: 'periods of 30 s of flight' };
function notchFitText(TF, leftOut) {
    const out = [], left = (re) => { const l = leftOut.filter(x => re.test(String(x.label))); return AXES.filter(ax => l.some(x => x.axis === ax)); };
    const axesText = (axes) => `on the ${andWords(axes)} ${axes.length > 1 ? 'axes' : 'axis'}`;
    const groups = [['tail rotor', /^tail rotor/, TF], ['motor', /^main motor$/, TF ? TF.motor : null]]; // "motor notch filter": STE (main is only in "main rotor")
    for (const [name, re, G] of groups) {
        const axes = left(re);
        if (G && G.passed && TF.used && !axes.length) {
            const unitWord = G.n === 1 ? (G.unit === 'flight' ? 'flight log' : 'period of 30 s of flight') : UNIT_WORDS[G.unit] || 'units';
            out.push(`In the log, the ${name} notch filter is at ${n1(G.order, 4)} ± ${n1(G.se, 4)} x the rotor frequency (${G.axis} axis, ${G.n} ${unitWord}). `
                + (G.depthDb !== null ? `At this frequency, the filters decrease the gyro signal by ${n1(-G.depthDb, 0)} dB. ` : '') + 'The model uses this value.');
            continue;
        }
        if (!axes.length) continue;
        if (!G || G.passed) { out.push(`The app does not know the frequency of the ${name} notch filters. Thus, the model does not have them ${axesText(axes)}.`); continue; }
        out.push(`The data in the log is not sufficient to find the ${name} notch filter. ${fitCauseText(G, name)} Thus, the model does not have the ${name} notch filters ${axesText(axes)}.`);
    }
    return out.join(' ');
}
// the first reason of a fit of tailOrder() that did not pass (G: the tail fit or its motor fit; name: 'tail rotor' | 'motor'), as STE
// sentences from the log only (also for js/tuning_worker.js)
const unquote = (v) => String(v).replace(/"/g, "'");   // a text in quotation marks: its own double quotes as single quotes
const ALIAS_WORDS = { 'dynamic notch': 'dynamic notch filter', 'main motor': 'motor notch filter', 'tail rotor': 'tail rotor notch filter' };
function fitCauseText(G, name) {
    const why = G && G.reasons && G.reasons[0] || {}, unitWord = UNIT_WORDS[G && G.unit] || 'flight logs';
    const qText = (v) => Array.isArray(v) ? `${n1(v[0], 2)} to ${n1(v[1], 2)}` : n1(v, 2);
    switch (why.code) {
        case 'not deep': return why.depthDb !== null && why.depthDb < 0 ? `At the best frequency, the filters decrease the gyro signal by only ${n1(-why.depthDb, 1)} dB, and the minimum is ${why.limit} dB.` : 'The gyro signal does not decrease at a frequency that follows the rotor speed.';
        case 'no phase jump': return 'At the best frequency, the gyro signal decreases, but its phase does not change as it does at a notch filter.';
        case 'units disagree': return `The ${unitWord} give frequencies that are different by up to ${n1(100 * why.maxDevOrder / G.order, 1)} %, and the limit is ${n1(100 * why.limit / G.order, 1)} %.`;
        case 'too few units': return `The log has only ${why.n} ${unitWord} with sufficient data, and ${why.limit} or more are necessary.`;
        case 'no clean axis': return `On each axis, a ${why.overlap === 'tail rotor' ? 'tail rotor' : 'main rotor'} notch filter is near the ${name} notch filter.`;
        case 'alias': { const other = ALIAS_WORDS[why.other] || 'different notch filter';
            return (why.qFit !== null && why.qFit !== undefined ? `At the best frequency, the gyro signal decreases as a notch filter with a Q of ${n1(why.qFit, 2)} decreases it. ` +
                `The ${name} notch filter has a Q of ${qText(why.qBank)}, and the ${other} has a Q of ${qText(why.qOther)}. ` : '') + `Thus, the decrease can come from the ${other}.`; }
        case 'axes disagree': return `The yaw axis gives ${n1(why.yawOrder, 4)} x the rotor frequency, and the ${why.axis} axis gives ${n1(why.order, 4)} x the rotor frequency.`;
        case 'no flight data': return 'The log has no flight with the raw gyro data.';
        case 'error': return `The app cannot calculate this frequency. The error is "${unquote(why.message || '')}".`;
        default: return 'The gyro signal does not decrease at a frequency that follows the rotor speed.'; // 'no dip'
    }
}
/**
 * texts(res, { logBase, cli }) -> { status, summary, parity, recommendation, delay, validation, why: [STE reasons], rows: [{ name,
 * scope, profile, from, to, text }] }: the result of tune() in the words of the views. logBase: added to the log numbers (the
 * viewer counts from 1); cli: true when the analysis had a CLI dump. The parity paragraph gives the RPM notch filters that follow
 * a gear ratio: the orders that the log gave (res.tailFit) or the filters that the model does not have (res.model.leftOut)
 */
function texts(res, opts = {}) {
    if (res && res.version === 2) return require('./filter_autotune.cjs').texts(res);
    const lb = opts.logBase === undefined ? 1 : opts.logBase, R = (res && res.recommended) || {}, M = (res && res.model) || {}, par = Array.isArray(M.parity) ? M.parity : [];
    const unit = res && res.units && res.units.kind === 'block' ? 'periods of 30 s of flight' : 'flight logs', unit1 = unit === 'flight logs' ? 'flight log' : 'period of 30 s of flight';
    const L = (l) => typeof l === 'number' ? l + lb : l, logs = par.map(p => L(p.log)), seconds = par.reduce((a, p) => a + (+p.seconds || 0), 0);
    const out = { status: R.status || 'not recommended', summary: '', parity: '', recommendation: '', delay: '', validation: '', why: [], rows: [] };
    if (R.status === 'no flight log' || !par.length) {
        out.status = 'no flight log';
        out.summary = 'The file has no flight log with the raw gyro data (`gyroRAW`). Thus, the app cannot test filter values on the logs.';
        out.why = [out.summary];
        return out;
    }
    const tested = ((res.ms && res.ms.exactEvaluations) || 0) + ((res.ms && res.ms.screened) || 0), P = R.predicted || {}, rec = R.status === 'recommended' && M.passed;
    const where = `${n1(seconds, 0)} s of flight in ${logs.length > 1 ? `logs ${andT(logs)}` : `log ${logs[0]}`}`;
    const gain = P.totalDb !== null && P.totalDb !== undefined && P.totalDb < 0 ? `${n1(-P.totalDb)} ± ${n1(P.se)} dB` : null, share = gain ? Math.round(100 * (1 - Math.pow(10, P.totalDb / 10))) : null;
    // parity: the model of the 4.6 gyro filters against the logged gyroADC
    const bad = []; let maxBand = 0, maxLine = 0, maxDelay = 0;
    for (const p of par) for (const ax of ['roll', 'pitch', 'yaw']) { const A = p.axes && p.axes[ax]; if (!A) continue;
        if (A.maxBandErrorDb !== null) maxBand = Math.max(maxBand, Math.abs(A.maxBandErrorDb)); if (A.medianLineErrorDb !== null) maxLine = Math.max(maxLine, Math.abs(A.medianLineErrorDb));
        if (A.delayErrorMs !== null) maxDelay = Math.max(maxDelay, Math.abs(A.delayErrorMs));
        if (!A.passed) bad.push({ log: L(p.log), axis: ax, A }); }
    const lim = RULES.parity, okLogs = par.filter(p => p.passed).length;
    const failText = (b) => { const A = b.A, why = !A.linesPassed ? `an error of ${n1(A.medianLineErrorDb)} dB at the vibration lines` : !A.delayPassed ? `a time delay error of ${n1(A.delayErrorMs, 3)} ms`
        : A.maxBandErrorDb !== null && Math.abs(A.maxBandErrorDb) > lim.bandDb ? `an error of ${n1(A.maxBandErrorDb)} dB in a frequency band` : 'not sufficient data';
        return `In log ${b.log}, the ${AXIS_WORD[b.axis]} axis has ${why}.`; };
    const notchText = notchFitText(res.tailFit || null, Array.isArray(M.leftOut) ? M.leftOut : []);
    // paragraphs (STE: 6 sentences or fewer in each), joined by a line feed: the agreement, the axes with an error, the RPM notch
    // filters whose frequency the log gave (no CLI dump) or that the model does not have
    out.parity = [[okLogs === par.length
        ? `The model of the Rotorflight 4.6 gyro filters agrees with the recorded gyroADC in ${par.length === 1 ? 'the flight log' : `all ${par.length} flight logs`}.`
        : `The model of the Rotorflight 4.6 gyro filters agrees with the recorded gyroADC in ${okLogs} of ${par.length} flight logs.`,
        `The largest error is ${n1(maxBand)} dB in a frequency band and ${n1(maxLine)} dB at the vibration lines, and the limit is ${lim.bandDb} dB.`,
        `The largest time delay error is ${n1(maxDelay, 3)} ms, and the limit is ${lim.delayMs} ms.`].join(' '),
        bad.slice(0, 3).map(failText).concat(bad.length > 3 ? [`${bad.length - 3} more axes of the logs also have an error more than the limit.`] : [], bad.length ? ['The app does not use the model for these axes.'] : []).join(' '),
        notchText].filter(Boolean).join('\n');
    // the reasons and the recommendation
    out.why = (R.reasons || []).map(t => reasonText(t, unit));
    if (!M.passed && !out.why.some(t => /does not agree/.test(t))) out.why.unshift(`The filter model does not agree with the recorded gyroADC in ${par.length - okLogs} of ${par.length} flight logs.`);
    out.summary = rec ? `The app calculated the vibration for ${tested} sets of filter values on ${where}. The recommended set decreases the vibration that gets to the PID controller by ${gain} (${share} % less vibration power).`
        : `The app calculated the vibration for ${tested} sets of filter values on ${where}. The app does not recommend a filter change.`;
    out.rows = (R.rows || []).map(row => { const nm = String(row.name), feat = /^feature /.test(nm), on = row.profile ? ` in PID profile ${row.profile}` : '';
        const text = feat ? `Set \`${nm}\` ${row.to ? 'on' : 'off'}. At this time, it is ${valueText(row.from)}.` : `Set \`${nm}\`${on} from ${valueText(row.from)} to ${valueText(row.to)}.`;
        return { name: nm, scope: row.scope || 'global', profile: row.profile || null, from: row.from === undefined ? null : row.from, to: row.to, text }; });
    out.recommendation = rec ? `The recommended set has ${out.rows.length === 1 ? '1 change' : `${out.rows.length} changes`}: ${andT(out.rows.map(x => `\`${x.name}\`${x.profile ? ` (PID profile ${x.profile})` : ''} ${valueText(x.to)}`))}.`
        : out.why.length ? out.why.join('\n') : 'The app does not recommend a filter change.';
    if ((R.unknownProfiles || []).length && rec) out.recommendation += ` The values of the PID profile cutoffs are not known for ${andT(R.unknownProfiles.map(p => p === 'unknown' ? 'PID profile unknown' : `PID profile ${p}`))}. Thus, the set has no cutoff change for them.`;
    // time delay (check F11 and the control band)
    const D = R.delay || null, what = rec ? 'The recommended set' : 'The best set of filter values';
    if (D && D.at && D.maxAddMs > 0) out.delay = `${what} adds ${n1(D.maxAddMs, 2)} ms of time delay at ${n1(D.at.hz, 0)} Hz (${AXIS_WORD[D.at.axis] || D.at.axis} axis, ${TPATH[D.at.path] || D.at.path}). The limit is ${RULES.delay.maxAddMs} ms. `
        + `The gyro filter time delay (check F11) changes from ${n1(D.f11BaseMs, 2)} ms to ${n1(D.f11MaxMs, 2)} ms, and its limit is ${RULES.delay.f11FlagMs} ms.`;
    else if (D) out.delay = `${what} adds no time delay from ${RULES.delay.band[0]} Hz to ${RULES.delay.band[1]} Hz.`;
    // leave-one-out
    const V = R.validation && R.validation.leaveOneOut, folds = V && Array.isArray(V.folds) ? V.folds : [];
    out.validation = folds.length ? `To make sure that ${rec ? 'the set' : 'the best set'} is correct for other flights, the app selected the set again without each ${unit1} (${folds.length} tests). `
        + `In the ${unit1} that the app did not use, the vibration changed by ${n1(V.heldOutMeanDb)} ± ${n1(V.heldOutSe)} dB. The app selected the same set in ${V.sameAsFull} of ${folds.length} tests.`
        : (res.units && res.units.n || par.length) < 3 ? `The data has ${(res.units && res.units.n) || par.length} ${(res.units && res.units.n || par.length) === 1 ? unit1 : unit}, and 3 or more are necessary. Thus, the app cannot test the set on data that it did not use.`
            : 'The app did not test the set on data that it did not use.';
    return out;
}

function tune(logs, opts = {}) { return require('./filter_autotune.cjs').tune(logs, opts); }

module.exports = { FW, FW_RANGE, RULES, RULE, EXTRA, PRESETS, config, withSettings, compile, effectiveBanks, chainResponse, pidResponse, pidPath, runChain, centresAt,
    prepare, findLines, decompose, parity, usableMasks, evaluate, delayOf, delayChange, score, movesOf, guards, greedy, choose, looValidate, cliLines, curves, tune,
    lowpassSections, biquad, firstOrderLpf, difSection, pt1Gain, notchQ, notchCutoffFor, notchAt, mulSection, fftPlan, fft, twoSpectra, tvKey, texts,
    tailOrder, tailOrderStart, tailOrderAdd, tailOrderFit, fitCauseText, orderSpectra, fitOrderAt, tailOrderOf, motorOrderOf,
    _t: { sumUnits, dipCandidates, cleanBanks, inViewBanks, banksAt, fitQAt, bankDip, revHeadspeed, dynStep } /* stateful SDFT processing shared with native-rate replay */ };
if (require.main !== module) return;

// ---------------------------------------------------------------------------------------------
// CLI: node tools/autotune/filter_tune.cjs <out dir> <log file> [--cli <dump>] [--logs 0,1,...] [--flight-rpm 2000] [--budget-ms 120000]
// ---------------------------------------------------------------------------------------------
{
    const fsN = require('node:fs'), pathN = require('node:path'), args = process.argv.slice(2), outDir = args[0], file = args[1];
    const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
    if (!outDir || !file) { console.error('usage: node tools/autotune/filter_tune.cjs <out dir> <log file> [--cli <dump>] [--logs 0,1] [--flight-rpm 2000] [--budget-ms 120000]'); process.exit(1); }
    const phase = require('./health_phase.cjs'), more = require('./health_more.cjs'), only = opt('--logs') ? opt('--logs').split(',').map(Number) : null;
    const app = lib.loadApp(), extra = [...new Set([...EXTRA, ...phase.EXTRA, ...more.EXTRA])], items = [], t0 = Date.now();
    for (const w of lib.segments(app, file, { whole: true, extra })) {
        if (only && !only.includes(w.flight.log)) continue;
        const ctx = { rate: w.rate, flightRule: { headspeed: +opt('--flight-rpm') || lib.FLIGHT_RPM } }, ph = phase.phases(w, ctx), fm = phase.flightMask(w, ctx, ph);
        let mask = fm; try { mask = more.normalMask(w, Object.assign({ flying: fm, phases: ph, header: w.flight.header, profile: w.profileAt, govState: w.govStateAt }, ctx)).mask; } catch (e) { /* the flight phase only */ }
        items.push({ w, mask, flight: ph.class === 'flight' });
    }
    const tDecode = Date.now() - t0, cli = opt('--cli') ? fsN.readFileSync(opt('--cli'), 'utf8') : null;
    const res = tune(items, { cli, flightRpm: +opt('--flight-rpm') || undefined, budgetMs: +opt('--budget-ms') || undefined, progress: text => console.error(text) });
    res.ms.decode = tDecode;
    fsN.mkdirSync(outDir, { recursive: true });
    const plain = JSON.parse(JSON.stringify(res, (k, v) => ArrayBuffer.isView(v) ? Array.from(v, x => +(+x).toPrecision(5)) : v));
    fsN.writeFileSync(pathN.join(outDir, 'filter_tune.json'), JSON.stringify(plain, null, 1));
    if (res.cliFile) fsN.writeFileSync(pathN.join(outDir, 'filter-autotune.txt'), res.cliFile);
    else fsN.rmSync(pathN.join(outDir, 'filter-autotune.txt'), { force: true });
    const TF = res.tailFit;
    if (TF) console.log(JSON.stringify({ tailFit: { passed: TF.passed, used: TF.used, order: TF.order, se: TF.se, n: TF.n, unit: TF.unit, axis: TF.axis, depthDb: TF.depthDb, maxDevOrder: TF.maxDevOrder, limitDevOrder: TF.limitDevOrder, reasons: TF.reasons, cli: TF.cli, units: (TF.units || []).map(u => `${u.id}: ${u.order} (${u.depthDb} dB, ${u.windows} windows)`), motor: TF.motor && { passed: TF.motor.passed, order: TF.motor.order, reasons: TF.motor.reasons }, ms: TF.ms } }, null, 1));
    console.log(JSON.stringify({ parity: res.model.parity.map(p => ({ log: p.log, passed: p.passed, axes: Object.fromEntries(Object.entries(p.axes).map(([ax, A]) => [ax, { passed: A.passed, band: A.maxBandErrorDb, line: A.medianLineErrorDb, delay: A.delayErrorMs }])) })) }));
    console.log(JSON.stringify({ ms: res.ms, status: res.recommended.status, reasons: res.recommended.reasons, cli: res.recommended.cli, predicted: res.recommended.predicted, delay: res.recommended.delay, holdout: res.recommended.validation.holdout }, null, 1));
}
