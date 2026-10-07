'use strict';

/**
 * Data validity and filter setup: checks D1-D4 and F1-F6, F8, F9 of docs/TUNING_KNOWLEDGE.md section 10.
 *
 *   const hs = require('./health_setup.cjs');
 *   for (const w of lib.segments(app, file, { whole: true, extra: hs.EXTRA })) metrics = hs.analyse(w, ctx);
 *   findings = hs.judge([{ log, start, header, metrics }, ...], hs.DEFAULT_RULES);
 *
 * analyse measures, judge decides. analyse holds no good/bad threshold, only measurement parameters (RULE).
 *
 *   D1  logging rate, nominal and as the log clock has it
 *   D2  time and loop-iteration jumps inside the segment, gaps of the log
 *   D3  which fields the log has, which are all zero, and which checks that rules out
 *   D4  header against a CLI dump (ctx.cli): gains, cutoffs, limits, notch banks, features; CLI-only settings
 *   F1-F4, F8   filter setup from the header
 *   F5  rotor-locked lines of gyroRAW (against rotor revolutions) and the notch nearest each
 *   F6  gyroADC / gyroRAW power at every configured RPM notch, window by window
 *   F9  configured notch frequencies against the log Nyquist and the firmware notch ceiling
 *   setup   per-log facts: rates, filters, RPM notch banks decoded, governor gains, yaw precomp, TTA, stop gains
 *
 * RPM notch source codes, rotorflight-firmware release/4.6.0 src/main/flight/rpm_filter.c rpmFilterInit (lines 186-236):
 *   10 main motor fundamental (only if main gear ratio != 1), 11..18 main rotor harmonic 1..8,
 *   20 tail motor fundamental (motorised geared tail only), 21..28 tail rotor harmonic 1..8, 0 unused.
 *   Q = constrain(q, 10, 250) / 10; centre = (1 + notch_center / 10000) x rpm x ratio / 60.
 *   Main harmonic k sits at k x headspeed/60. Tail harmonic k: motor rpm x tailGearRatio x k/60, where for a
 *   non-motorised tail tailGearRatio = mainGearRatio / (tail[0]/tail[1]) (src/main/flight/motors.c:251-258), so
 *   k x headspeed x tail[1]/tail[0] / 60. Gear ratios are not in the header; they come from the CLI or ctx.gear.
 *   Notch ceiling 0.45 x gyro.filterRateHz, fade-in between min_hz and 1.25 x min_hz (rpm_filter.c:204-206, 305-311);
 *   filterRateHz = gyro sample rate / filter_process_denom (sensors/gyro_init.c:636); header looptime is
 *   gyro.sampleLooptime (blackbox/blackbox.c:1637).
 * Feature bits: src/main/config/feature.h (GOVERNOR 26, ESC_SENSOR 27, FREQ_SENSOR 28, DYN_NOTCH 29, RPM_FILTER 30).
 * Dynamic notch disabled when its update rate (PID rate) < 1000 Hz: flight/dyn_notch_filter.c:89,163-166.
 */

const lib = require('./lib.cjs');

const RULE = {
    order: { perRev: 32, revolutions: 256, steadyRpm: 300, nyquistMargin: 0.95, from: 0.4, to: 12 }, // order spectra: windows of this many revolutions, headspeed within steadyRpm
    line: { local: 0.05, band: 0.5, keep: 12, minProminence: 2, sameOrder: 0.01, otherHeadspeed: 0.08 }, // orders: local max over +-local, prominence over the median of +-band; kept lines
    attenuation: { halfBins: 2 },  // bins either side of a notch centre summed, raw and filtered
    gap: { dtFactor: 1.5 },        // a frame interval above this x the median is a jump
    activeGovState: 4,             // vibration windows only in governor ACTIVE when the log has GOVSTATE
    cli: { dumpMasterSets: 300 },  // a capture without 'diff'/'dump' is a dump if it has more master 'set' lines than this (a 4.6.0 dump has about 380)
};

const EXTRA = ['time', 'loopIteration', 'gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]', 'servo[0]', 'servo[1]', 'servo[2]', 'servo[3]', 'motor[0]',
    'govTarget', 'govRequest', 'govSum', 'govP', 'govI', 'govD', 'govF', 'Vbat', 'Ibat', 'Tesc', 'EscV', 'EscI', 'EscRPM', 'EscThr', 'axisO[0]', 'axisO[1]'];

const DEFAULT_RULES = {
    D1: { minHz: 1000, source: 'pipeline, unvalidated' },            // from Nyquist, section 7.4
    D2: { maxJumps: 0, maxGaps: 0, source: 'pipeline, unvalidated' },
    D3: { source: 'pipeline, unvalidated' },
    D4: { source: 'pipeline, unvalidated' },
    F1: { source: 'doc' },
    F2: { flagHz: 60, noteHz: 80, source: 'doc' },
    F3: { minQ: 2.0, source: 'doc' },
    F4: { targetHz: 20, toleranceHz: 5, source: 'doc' },              // "around 20Hz" is doc; the 5 Hz tolerance is pipeline
    F5: { minProminence: 5, maxDistance: 0.02, minWindows: 3, source: 'pipeline, unvalidated' },
    F6: { minDb: 10, minWindows: 3, minLineProminence: 5, source: 'pipeline, unvalidated' },
    F8: { minPidHz: 1000, source: 'firmware' },
    F9: { notchCeiling: 0.45, source: 'pipeline, unvalidated' },      // arithmetic; 0.45 is firmware
    H: { source: 'log header' },
};

const FEATURE_BITS = { GOVERNOR: 26, ESC_SENSOR: 27, FREQ_SENSOR: 28, DYN_NOTCH: 29, RPM_FILTER: 30 };
const LPF_TYPES = ['NONE', 'FIRST_ORDER', 'SECOND_ORDER', 'PT1', 'PT2', 'PT3', 'ORDER1', 'BUTTER', 'BESSEL', 'DAMPED']; // common/filter.h lowpassFilterType_e
const GOV_STATES = ['OFF', 'IDLE', 'SPOOLUP', 'RECOVERY', 'ACTIVE', 'HOLD', 'FALLBACK', 'AUTOROTATION', 'BAILOUT', 'BYPASS'];

const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const hk = (h, k) => (h && h[k] !== undefined && h[k] !== null) ? h[k] : null;
const arr = (v) => Array.isArray(v) ? v : (v === null || v === undefined ? null : [v]);
const meanSe = (list) => { const n = list.length; if (!n) return { mean: null, se: null, n: 0 };
    const m = list.reduce((s, v) => s + v, 0) / n, sd = n > 1 ? Math.sqrt(list.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1)) : null;
    return { mean: m, se: sd === null ? null : sd / Math.sqrt(n), n }; };
const median = (list) => { const s = Array.from(list).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };

// ---------------------------------------------------------------------------------------------
// CLI dump ('dump' or 'diff all')
// ---------------------------------------------------------------------------------------------

function parseCli(text) {
    // a capture holds the echoed command after the CLI prompt '# ' (cli.c:1028, 6977): '# diff all'. A full dump says
    // 'dump' or '# master', or has every master setting (hundreds of 'set' lines before the first 'profile'); a capture
    // that shows none of these is taken as a diff.
    const head = text.split(/^\s*profile\s+\d/m)[0], masterSets = (head.match(/^\s*set\s/gm) || []).length;
    const kind = /^\s*(#\s*)?diff\b/m.test(text) ? 'diff' : /^\s*(#\s*)?dump\b/m.test(text) || /^\s*#\s*master\b/m.test(text) || masterSets > RULE.cli.dumpMasterSets ? 'dump' : 'diff';
    const out = { kind, version: null, features: {}, global: {}, profiles: {}, rateprofiles: {}, mixerInputs: {}, selectedProfile: null };
    let cur = out.global;
    const value = (s) => { const parts = s.split(',').map(p => p.trim()); const conv = parts.map(p => (p !== '' && isFinite(+p)) ? +p : p); return conv.length === 1 ? conv[0] : conv; };
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim(); let m;
        if ((m = /^# Rotorflight .*? (\d+\.\d+\.\d+)/.exec(line))) out.version = m[1];
        if (!line || line.startsWith('#')) continue;
        if ((m = /^profile (\d+)/.exec(line))) { cur = out.profiles[m[1]] = out.profiles[m[1]] || {}; out.selectedProfile = +m[1]; continue; }
        if ((m = /^rateprofile (\d+)/.exec(line))) { cur = out.rateprofiles[m[1]] = out.rateprofiles[m[1]] || {}; continue; }
        if ((m = /^feature (-?)(\w+)/.exec(line))) { out.features[m[2]] = m[1] !== '-'; continue; }
        if ((m = /^mixer input (\w+) (-?\d+) (-?\d+) (-?\d+)/.exec(line))) { out.mixerInputs[m[1]] = [+m[2], +m[3], +m[4]]; continue; }
        if ((m = /^set (\w+)\s*=\s*(.*)$/.exec(line))) cur[m[1]] = value(m[2]);
    }
    return out;
}

// Header key and element against a CLI key, with the 4.6 default a 'diff all' leaves out (null = unknown, compared
// only when the dump has it). Defaults: FW src/main/pg/pid.c:43-126, pg/gyro.c, pg/rpm_filter.c (TUNING_KNOWLEDGE 2.5, 2.10, 3.2, 7.1).
const PAIRS_PROFILE = [];
for (const [ax, def, bw] of [['roll', [50, 100, 0, 100, 0], [50, 15, 15]], ['pitch', [50, 100, 40, 100, 0], [50, 15, 15]], ['yaw', [80, 120, 10, 0, 0], [100, 20, 20]]]) {
    ['p', 'i', 'd', 'f', 'b'].forEach((g, i) => PAIRS_PROFILE.push([ax + 'PID', i, `${ax}_${g}_gain`, def[i]]));
    ['gyro', 'd', 'b'].forEach((g, i) => PAIRS_PROFILE.push([ax + 'BW', i, `${ax}_${g}_cutoff`, bw[i]]));
}
PAIRS_PROFILE.push(
    ['govPID', 0, 'gov_p_gain', 40], ['govPID', 1, 'gov_i_gain', 50], ['govPID', 2, 'gov_d_gain', 0], ['govPID', 3, 'gov_f_gain', 10], ['govPID', 4, 'gov_gain', 40],
    ['yaw_stop_gain', 0, 'yaw_cw_stop_gain', 120], ['yaw_stop_gain', 1, 'yaw_ccw_stop_gain', 80],
    ['yaw_precomp', 0, 'yaw_precomp_cutoff', 5], ['yaw_precomp', 1, 'yaw_cyclic_ff_gain', 10], ['yaw_precomp', 2, 'yaw_collective_ff_gain', 60],
    ['yaw_inertia_precomp', 0, 'yaw_inertia_precomp_gain', 0], ['yaw_inertia_precomp', 1, 'yaw_inertia_precomp_cutoff', 25],
    ['yaw_tta', 0, 'gov_tta_gain', 0], ['yaw_tta', 1, 'gov_tta_limit', 20],
    ['hsi_gain', 0, 'roll_o_gain', 50], ['hsi_gain', 1, 'pitch_o_gain', 50], ['hsi_limit', 0, 'offset_limit[0]', 90], ['hsi_limit', 1, 'offset_limit[1]', 90],
    ['error_limit', 0, 'error_limit[0]', null], ['error_limit', 1, 'error_limit[1]', null], ['error_limit', 2, 'error_limit[2]', null],
    ['error_decay', 0, 'error_decay_time_cyclic', 250], ['error_decay', 1, 'error_decay_limit_cyclic', 12], ['error_decay_ground', null, 'error_decay_time_ground', 25],
    ['iterm_relax_cutoff', 0, 'iterm_relax_cutoff[0]', 10], ['iterm_relax_cutoff', 1, 'iterm_relax_cutoff[1]', 10], ['iterm_relax_cutoff', 2, 'iterm_relax_cutoff[2]', 10],
    ['cyclic_coupling', 0, 'cyclic_cross_coupling_gain', 50], ['cyclic_coupling', 1, 'cyclic_cross_coupling_ratio', 0], ['cyclic_coupling', 2, 'cyclic_cross_coupling_cutoff', 25],
    ['pitch_compensation', null, 'pitch_collective_ff_gain', 0]);
const PAIRS_GLOBAL = [
    ['gyro_soft_type', null, 'gyro_lpf1_type', 'FIRST_ORDER', LPF_TYPES], ['gyro_lowpass_hz', null, 'gyro_lpf1_static_hz', 100],
    ['gyro_soft2_type', null, 'gyro_lpf2_type', 'NONE', LPF_TYPES], ['gyro_lowpass2_hz', null, 'gyro_lpf2_static_hz', 50],
    ['gyro_lowpass_dyn_hz', 0, 'gyro_lpf1_dyn_min_hz', 0], ['gyro_lowpass_dyn_hz', 1, 'gyro_lpf1_dyn_max_hz', 0],
    ['dyn_notch_count', null, 'dyn_notch_count', 6], ['dyn_notch_q', null, 'dyn_notch_q', 25], ['dyn_notch_min_hz', null, 'dyn_notch_min_hz', 20], ['dyn_notch_max_hz', null, 'dyn_notch_max_hz', 240],
    ['gyro_rpm_notch_preset', null, 'gyro_rpm_notch_preset', 2], ['gyro_rpm_notch_min_hz', null, 'gyro_rpm_notch_min_hz', 20],
    ['pid_process_denom', null, 'pid_process_denom', null], ['collectiveRange', 0, 'mixer input SC[0]', -1250], ['collectiveRange', 1, 'mixer input SC[1]', 1250],
];
for (const ax of ['roll', 'pitch', 'yaw']) for (const k of ['source', 'q', 'center']) PAIRS_GLOBAL.push([`gyro_rpm_notch_${k}_${ax}`, 'all', `gyro_rpm_notch_${k}_${ax}`, null]);

function cliValue(scope, cli, key) {
    let m;
    if ((m = /^mixer input (\w+)\[(\d)\]$/.exec(key))) { const v = cli.mixerInputs[m[1]]; return v ? v[+m[2]] : undefined; }
    if ((m = /^(\w+)\[(\d)\]$/.exec(key))) { const v = scope[m[1]]; return v === undefined ? undefined : arr(v)[+m[2]]; }
    return scope[key];
}

function compareCli(header, cli, profileIndex) {
    const rows = [], cmp = (pairs, scope, where) => {
        for (const [hKey, idx, cKey, def, names] of pairs) {
            const hv0 = hk(header, hKey); if (hv0 === null) continue;
            let hv = idx === null ? hv0 : idx === 'all' ? arr(hv0) : arr(hv0)[idx];
            let cv = scope ? cliValue(scope, cli, cKey) : undefined, from = 'cli';
            if (cv === undefined && cli.kind === 'diff' && def !== null) { cv = def; from = 'default'; }
            if (cv === undefined) continue;
            if (names && typeof cv === 'string') cv = names.indexOf(cv);
            if (idx === 'all') { const a = arr(cv).map(Number), b = hv.map(Number), L = Math.max(a.length, b.length), pad = (v) => Array.from({ length: L }, (_, i) => v[i] || 0).join(',');
                hv = pad(b); cv = pad(a); }
            rows.push({ where, header: hKey + (idx === null || idx === 'all' ? '' : `[${idx}]`), cli: cKey, headerValue: hv, cliValue: cv, from, match: String(hv) === String(cv) });
        }
    };
    cmp(PAIRS_PROFILE, profileIndex === null ? null : cli.profiles[profileIndex] || {}, `profile ${profileIndex}`);
    cmp(PAIRS_GLOBAL, cli.global, 'global');
    // features the pilot switched: header bitmask against the CLI's feature lines
    const f = hk(header, 'features');
    if (f !== null) for (const [name, bit] of Object.entries(FEATURE_BITS)) if (cli.features[name] !== undefined) {
        const hv = ((f >>> bit) & 1) === 1; rows.push({ where: 'global', header: `features.${name}`, cli: `feature ${name}`, headerValue: hv, cliValue: cli.features[name], from: 'cli', match: hv === cli.features[name] }); }
    return rows;
}

// ---------------------------------------------------------------------------------------------
// Header facts
// ---------------------------------------------------------------------------------------------

function gearOf(ctx) {
    if (ctx && ctx.gear) return Object.assign({ source: 'ctx.gear' }, ctx.gear);
    const cli = ctx && ctx.cliParsed;
    if (!cli) return null;
    const g = cli.global, main = arr(g.main_rotor_gear_ratio) || (cli.kind === 'diff' ? [1, 1] : null), tail = arr(g.tail_rotor_gear_ratio) || (cli.kind === 'diff' ? [1, 1] : null);
    // every mode but VARIABLE drives the tail with its own motor (mixer.h:142-145: tail_rotor_mode != TAIL_MODE_VARIABLE);
    // lookup VARIABLE, MOTORIZED, BIDIRECTIONAL = 0, 1, 2
    const mode = g.tail_rotor_mode === undefined || g.tail_rotor_mode === null ? 'VARIABLE' : String(g.tail_rotor_mode).trim().toUpperCase();
    return { main, tail, motorisedTail: mode !== 'VARIABLE' && mode !== '0', source: 'cli' + (cli.kind === 'diff' ? ' (absent keys taken as default 1,1)' : '') };
}

// what an RPM notch source code filters, as a multiple of the logged headspeed (rpm_filter.c:186-236, motors.c:251-258)
function decodeNotchSource(code, gear) {
    const ratio = (p) => p ? Math.max(p[0], 1) / Math.max(p[1], 1) : null;
    const mainGR = gear ? ratio(gear.main) : null, tailPair = gear ? gear.tail : null;
    if (code === 10) return { code, kind: 'main motor', harmonic: 1, order: mainGR ? 1 / mainGR : null, enabled: mainGR === null ? null : mainGR !== 1 };
    if (code >= 11 && code <= 18) return { code, kind: 'main rotor', harmonic: code - 10, order: code - 10, enabled: true };
    // motorisedTail null (a gear from the log notch fit with no tail fit: tuning_worker gearFit): the tail type is unknown
    if (code === 20) return { code, kind: 'tail motor', harmonic: 1, order: null, enabled: gear && gear.motorisedTail !== null ? !!gear.motorisedTail && ratio(tailPair) !== 1 : null };
    if (code >= 21 && code <= 28) {
        const k = code - 20; let order = null;
        if (gear && !gear.motorisedTail && tailPair) order = k * Math.max(tailPair[1], 1) / Math.max(tailPair[0], 1);
        return { code, kind: 'tail rotor', harmonic: k, order, enabled: true };
    }
    return { code, kind: code ? 'invalid' : 'unused', harmonic: null, order: null, enabled: false };
}

function rpmBanks(header, gear) {
    const out = {};
    for (const ax of lib.AXES) {
        const src = arr(hk(header, `gyro_rpm_notch_source_${ax}`)) || [], q = arr(hk(header, `gyro_rpm_notch_q_${ax}`)) || [], c = arr(hk(header, `gyro_rpm_notch_center_${ax}`)) || [];
        out[ax] = [];
        src.forEach((code, i) => { if (!code || !q[i]) return;
            const d = decodeNotchSource(code, gear); if (d.enabled === false) return; // the firmware creates no filter (rpm_filter.c: if (enable10), tail motor only if motorised)
            const centre = 1 + (c[i] || 0) / 10000;
            out[ax].push(Object.assign(d, { bank: i, q: Math.min(250, Math.max(10, q[i])) / 10, centreShift: (c[i] || 0) / 10000, order: d.order === null ? null : d.order * centre })); });
    }
    return out;
}

function setupFacts(w, gear) {
    const h = w.flight.header || {}, f = hk(h, 'features'), bit = (name) => f === null ? null : ((f >>> FEATURE_BITS[name]) & 1) === 1;
    const looptime = hk(h, 'looptime'), pidDenom = hk(h, 'pid_process_denom') || 1, filtDenom = hk(h, 'filter_process_denom') || pidDenom;
    const gyroHz = looptime ? 1e6 / looptime : null, unknown = (hk(h, 'unknownHeaders') || []).find(u => u.name === 'gyro_decimation_hz');
    const lpf = (tKey, hzKey) => { const t = hk(h, tKey), hz = hk(h, hzKey); return { type: t, typeName: t === null ? null : LPF_TYPES[t] || String(t), hz, active: t !== null && t > 0 && hz > 0 }; };
    const dyn = arr(hk(h, 'gyro_lowpass_dyn_hz')) || [0, 0];
    const p = (k) => arr(hk(h, k));
    return {
        firmware: hk(h, 'Firmware revision'), craft: hk(h, 'Craft name'),
        logRateHz: r(w.flight.rate, 2), measuredRateHz: r(w.flight.actualRate, 2), gyroSampleHz: r(gyroHz, 1), pidHz: gyroHz ? r(gyroHz / pidDenom, 1) : null, filterHz: gyroHz ? r(gyroHz / filtDenom, 1) : null,
        gyroDecimationHz: unknown ? +unknown.value : hk(h, 'gyro_decimation_hz'), debugMode: hk(h, 'debug_mode'),
        features: Object.fromEntries(Object.keys(FEATURE_BITS).map(k => [k, bit(k)])),
        lpf1: lpf('gyro_soft_type', 'gyro_lowpass_hz'), lpf2: lpf('gyro_soft2_type', 'gyro_lowpass2_hz'), lpf1Dynamic: { min: dyn[0] || 0, max: dyn[1] || 0, active: hk(h, 'gyro_soft_type') !== null && hk(h, 'gyro_soft_type') > 0 && (dyn[0] || 0) > 0 }, // gyro_init.c: lpf1 type != NONE && dyn min > 0
        staticNotch: { hz: p('gyro_notch_hz'), cutoff: p('gyro_notch_cutoff') },
        dynNotch: { enabled: bit('DYN_NOTCH'), count: hk(h, 'dyn_notch_count'), q: hk(h, 'dyn_notch_q') === null ? null : hk(h, 'dyn_notch_q') / 10, minHz: hk(h, 'dyn_notch_min_hz'), maxHz: hk(h, 'dyn_notch_max_hz') },
        rpm: { enabled: bit('RPM_FILTER'), preset: hk(h, 'gyro_rpm_notch_preset'), minHz: hk(h, 'gyro_rpm_notch_min_hz'), ceilingHz: gyroHz ? r(0.45 * gyroHz / filtDenom, 1) : null, gear, banks: rpmBanks(h, gear) },
        pid: { roll: p('rollPID'), pitch: p('pitchPID'), yaw: p('yawPID'), order: 'P,I,D,F,B' },
        bandwidth: { roll: p('rollBW'), pitch: p('pitchBW'), yaw: p('yawBW'), order: 'gyro_cutoff,dterm_cutoff,bterm_cutoff (Hz)' },
        governor: { gains: p('govPID'), order: 'P,I,D,F,gain' },
        yaw: { stopGain: p('yaw_stop_gain'), stopOrder: 'CW,CCW', precomp: p('yaw_precomp'), precompOrder: 'cutoff Hz, cyclic FF, collective FF', inertia: p('yaw_inertia_precomp'), inertiaOrder: 'gain, cutoff x0.1 Hz', tta: p('yaw_tta'), ttaOrder: 'gain, limit %' },
        errorLimit: p('error_limit'), errorDecay: p('error_decay'), relaxCutoff: p('iterm_relax_cutoff'), hsi: { gain: p('hsi_gain'), limit: p('hsi_limit') },
    };
}

// ---------------------------------------------------------------------------------------------
// Order spectra: raw and filtered gyro against rotor revolutions
// ---------------------------------------------------------------------------------------------

function power(set, x, s, N, out, buf) { // squared amplitude per bin of one Hann window: a sinusoid of amplitude A gives A^2 at its bin
    let m = 0; for (let i = 0; i < N; i++) m += x[s + i]; m /= N;
    for (let i = 0; i < N; i++) buf[i] = (x[s + i] - m) * set.win[i];
    set.fft.simple(out, buf, 'real');
    const p = new Float64Array(N / 2); for (let k = 0; k < N / 2; k++) p[k] = (out[2 * k] ** 2 + out[2 * k + 1] ** 2) / (N / 4) ** 2;
    return p;
}

// Resampling by linear interpolation (lib.byRevolution) is a triangle kernel: it passes a line of frequency hz at
// sinc^2(hz / rate) of its amplitude. Power ratios between raw and filtered gyro are unaffected; amplitudes are corrected.
const interpGain = (hz, rate) => { const x = Math.PI * hz / rate; return x ? Math.max(0.05, (Math.sin(x) / x) ** 2) : 1; };

let appCache = null;
function orderSpectra(w, ctx, raw, banks) {
    const O = RULE.order, rate = w.flight.actualRate || w.rate, N = O.perRev * O.revolutions, app = ctx.app || appCache || (appCache = lib.loadApp());
    const set = lib.fftFor(app, N), out = new Float64Array(2 * N), buf = new Float64Array(N), top = Math.min(N / 2 - 1, Math.round(O.to * O.revolutions));
    const R = lib.byRevolution(w.hs, rate, [...raw, ...w.gyro], O.perRev), gov = ctx.govState, H = RULE.attenuation.halfBins;
    const groups = new Map(), windows = [];
    const notchBins = lib.AXES.map((ax) => banks[ax].filter(b => b.order !== null).map(b => ({ b, k: Math.round(b.order * O.revolutions) })));
    for (let s = 0; s + N <= R.M; s += N / 2) {
        const i0 = R.index[s], i1 = R.index[s + N - 1], pr = ctx.profile[i0]; let ok = true, lo = Infinity, hi = -Infinity, sum = 0, cnt = 0;
        for (let j = s; j < s + N && ok; j += 16) { const i = R.index[j]; if (!ctx.flying[i] || ctx.profile[i] !== pr || (gov && gov[i] !== RULE.activeGovState)) ok = false; const v = w.hs[i]; if (v < lo) lo = v; if (v > hi) hi = v; sum += v; cnt++; }
        if (!ok || hi - lo > O.steadyRpm) continue;
        const hs = sum / cnt, nyqOrder = O.nyquistMargin * (rate / 2) / (hs / 60), kMax = Math.min(top, Math.floor(nyqOrder * O.revolutions));
        let g = groups.get(pr); if (!g) groups.set(pr, g = { profile: pr, windows: 0, headspeed: [], kMax: top, raw: [0, 1, 2].map(() => new Float64Array(top + 1)), gyro: [0, 1, 2].map(() => new Float64Array(top + 1)) });
        g.windows++; g.headspeed.push(hs); g.kMax = Math.min(g.kMax, kMax);
        const rec = { t: r(w.fromS + i0 / rate, 2), tEnd: r(w.fromS + i1 / rate, 2), profile: pr, headspeed: r(hs, 0), db: [[], [], []] };
        for (let a = 0; a < 3; a++) {
            const p = power(set, R.columns[a], s, N, out, buf), q = power(set, R.columns[3 + a], s, N, out, buf);
            for (let k = 0; k <= top; k++) { g.raw[a][k] += p[k]; g.gyro[a][k] += q[k]; }
            for (const { k } of notchBins[a]) { if (k + H > kMax) { rec.db[a].push(null); continue; }
                let er = 0, ef = 0; for (let j = k - H; j <= k + H; j++) { er += p[j]; ef += q[j]; }
                rec.db[a].push(r(10 * Math.log10(er / Math.max(ef, 1e-30)), 2)); }
        }
        windows.push(rec);
    }
    return { groups: [...groups.values()], windows, notchBins };
}

// lines of a summed order spectrum: local maxima over +-local, prominence = amplitude over the median of +-band
function findLines(P, revolutions, k0, k1) {
    const L = RULE.line, loc = Math.max(1, Math.round(L.local * revolutions)), band = Math.round(L.band * revolutions), lines = [];
    for (let k = Math.max(k0, loc + 1); k <= k1 - loc; k++) {
        let top = true; for (let j = k - loc; j <= k + loc && top; j++) if (P[j] > P[k]) top = false;
        if (!top) continue;
        const around = []; for (let j = Math.max(1, k - band); j <= Math.min(P.length - 1, k + band); j++) if (Math.abs(j - k) > 3) around.push(P[j]);
        const prominence = Math.sqrt(P[k] / (median(around) || 1e-30));
        if (prominence >= L.minProminence) lines.push({ k, prominence });
    }
    return lines.sort((a, b) => b.prominence - a.prominence).slice(0, L.keep);
}

// ---------------------------------------------------------------------------------------------
// analyse
// ---------------------------------------------------------------------------------------------

function analyse(w, ctx = {}) {
    const fl = w.flight, h = fl.header || {}, rate = fl.actualRate || w.rate, x = w.extra || {}, n = w.n;
    const flying = ctx.flying || new Uint8Array(n), profile = ctx.profile || w.profileAt;
    ctx = Object.assign({}, ctx, { flying, profile });
    const out = { log: fl.log, fromS: r(w.fromS, 3), seconds: r(n / rate, 2), n, rule: RULE };
    let flyingN = 0; for (let i = 0; i < n; i++) flyingN += flying[i];
    out.flyingS = r(flyingN / rate, 1);
    out.startProfile = profile[0];

    // CLI
    let cli = null;
    if (ctx.cli) { const text = typeof ctx.cli === 'string' ? ctx.cli : ctx.cli.text; cli = parseCli(text); ctx.cliParsed = cli; }
    const gear = gearOf(ctx);
    out.setup = setupFacts(w, gear);

    // D1 logging rate
    const pNum = hk(h, 'frameIntervalPNum') || 1, pDen = hk(h, 'frameIntervalPDenom') || 1;
    out.D1 = { nominalHz: r(fl.rate, 2), measuredHz: r(fl.actualRate, 2), nyquistHz: r(rate / 2, 1), looptimeUs: hk(h, 'looptime'), pidProcessDenom: hk(h, 'pid_process_denom'), pInterval: `${pNum}/${pDen}` };

    // D2 gaps and jumps
    { const t = x.time, it = x.loopIteration, events = []; let jumps = 0, stalls = 0, missing = 0, backwards = 0, medDt = null, medIt = null;
        // loopIteration (blackboxIteration, one per FC loop, absolute in every I-frame) tells lost frames from a stalled loop:
        // a time jump over contiguous iterations lost no frame
        if (it) { const d = []; for (let i = 1; i < n; i += Math.max(1, Math.floor(n / 20000))) d.push(it[i] - it[i - 1]); medIt = median(d); }
        const itContiguous = (i) => it && medIt > 0 && it[i] - it[i - 1] > 0 && it[i] - it[i - 1] <= RULE.gap.dtFactor * medIt;
        if (t) { const d = []; for (let i = 1; i < n; i += Math.max(1, Math.floor(n / 20000))) d.push(t[i] - t[i - 1]); medDt = median(d);
            for (let i = 1; i < n; i++) { const dt = t[i] - t[i - 1];
                if (dt <= 0) { backwards++; events.push({ t: r(w.fromS + i / rate, 3), value: r(dt / 1000, 3), kind: 'time not increasing', unit: 'ms' }); }
                else if (dt > RULE.gap.dtFactor * medDt) {
                    if (itContiguous(i)) { stalls++; events.push({ t: r(w.fromS + i / rate, 3), value: r(dt / 1000, 3), kind: 'loop stall (time jump, iteration contiguous: no frame lost)', unit: 'ms' }); continue; }
                    jumps++; const miss = it && medIt > 0 ? Math.max(0, Math.round((it[i] - it[i - 1]) / medIt) - 1) : Math.round(dt / medDt) - 1; if (!it) missing += miss;
                    events.push({ t: r(w.fromS + i / rate, 3), value: miss, dtMs: r(dt / 1000, 3), kind: 'time jump', unit: 'frames', from: it ? 'loopIteration' : 'time' }); } } }
        let itJumps = 0;
        if (it) for (let i = 1; i < n; i++) { const di = it[i] - it[i - 1]; if (di <= 0 || di > RULE.gap.dtFactor * medIt) { itJumps++; missing += Math.max(0, Math.round(di / medIt) - 1); if (events.length < 500) events.push({ t: r(w.fromS + i / rate, 3), value: di, kind: 'loopIteration jump', unit: 'iterations' }); } }
        out.D2 = { logGaps: fl.gaps === undefined ? null : fl.gaps, frames: fl.frames === undefined ? null : fl.frames, logSeconds: r(fl.durationS, 2), segmentEndS: r(w.fromS + n / rate, 2),
            medianDtUs: r(medDt, 1), timeJumps: t ? jumps : null, loopStalls: t ? stalls : null, missingFrames: t || it ? missing : null, missingFramesFrom: it ? 'loopIteration' : t ? 'time' : null, timeBackwards: t ? backwards : null, iterationStep: medIt, iterationJumps: it ? itJumps : null,
            events: events.slice(0, 500), skipped: t ? null : 'no time field in the segment (add "time" to EXTRA); only the log gap count is known' }; }

    // D3 field availability
    { const fields = {}, state = (v) => { if (!v) return 'absent'; for (let i = 0; i < v.length; i++) if (v[i] !== 0) return 'present'; return 'zero'; };
        for (const k of EXTRA) if (k !== 'time' && k !== 'loopIteration') fields[k] = state(x[k]);
        for (let a = 0; a < 3; a++) { fields[`axisB[${a}]`] = state(w.B && w.B[a]); fields[`axisD[${a}]`] = state(w.D && w.D[a]); }
        fields.headspeed = state(w.hs); fields['setpoint[3]'] = state(w.coll);
        const ok = (...ks) => ks.every(k => fields[k] === 'present'), skips = [], need = (ids, ks, why) => { if (!ok(...ks)) skips.push({ checks: ids, missing: ks.filter(k => fields[k] !== 'present').map(k => `${k} ${fields[k]}`), why }); };
        need(['F5', 'F6', 'F7'], ['gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]'], 'raw gyro needed for vibration before the filters');
        need(['C2', 'T8'], ['servo[0]', 'servo[1]', 'servo[2]', 'servo[3]'], 'servo outputs for saturation');
        need(['G0', 'G2', 'G3', 'G4', 'G5', 'G9'], ['govTarget', 'govSum'], 'governor fields');
        need(['G6', 'G7', 'G8', 'G11'], ['motor[0]'], 'throttle output');
        need(['D5', 'G8', 'G11', 'G13'], ['Vbat'], 'battery voltage');
        need(['power', 'current'], ['Ibat'], 'battery current (logged but all zero means no current sensor)');
        need(['G12 (independent rpm)'], ['EscRPM'], 'ESC telemetry rpm; needs feature ESC_SENSOR and blackbox_log_esc');
        need(['C9 (HSI share)'], ['axisO[0]', 'axisO[1]'], 'axisO is written only if roll or pitch O > 0');
        need(['T6', 'G3', 'G4'], ['setpoint[3]'], 'collective');
        out.D3 = { fields, skips, govStateEvents: !!ctx.govState }; }

    // D4 header against CLI: only with a CLI dump, an optional input (user rule 2026-10-06: the log is the only necessary
    // input). Without one there is no D4 metric and no D4 result, not a result that was not done
    if (cli) {
        const profiles = Object.keys(cli.profiles).map(Number), score = profiles.map(p => ({ p, rows: compareCli(h, cli, p) })).map(s => ({ p: s.p, rows: s.rows, bad: s.rows.filter(v => !v.match && v.where !== 'global').length }));
        const guess = profile[0] > 0 ? profile[0] - 1 : null, best = score.slice().sort((a, b) => a.bad - b.bad)[0] || null;
        const chosen = guess !== null && profiles.includes(guess) ? guess : best ? best.p : null, rows = compareCli(h, cli, chosen);
        // governor mode: the CLI says, the data shows (govI, govSum identically zero in flight -> no PID governor)
        let govData = null; if (x.govSum && x.govI) { let nz = 0, cnt = 0; for (let i = 0; i < n; i++) if (flying[i]) { cnt++; if (x.govSum[i] !== 0 || x.govI[i] !== 0) nz++; } govData = cnt ? (nz ? 'PID governor (govSum/govI non-zero in flight)' : 'no PID governor output (DIRECT/LIMIT/OFF)') : null; }
        const g = cli.global, prof = (k) => Object.fromEntries(profiles.map(p => [p, cli.profiles[p][k] === undefined ? null : cli.profiles[p][k]]));
        out.D4 = { cliKind: cli.kind, cliVersion: cli.version, headerFirmware: hk(h, 'firmwareVersion'), profileCompared: chosen, profileChosenBy: chosen === guess && guess !== null ? 'log profile at start (1-based event value - 1)' : 'fewest mismatches',
            mismatchesByProfile: Object.fromEntries(score.map(s => [s.p, s.bad])), compared: rows.length, mismatches: rows.filter(v => !v.match), matches: rows.filter(v => v.match).length,
            cliOnly: { pid_mode: Object.fromEntries(profiles.map(p => [p, cli.profiles[p].pid_mode !== undefined ? cli.profiles[p].pid_mode : cli.kind === 'diff' ? '3 (default, absent from diff)' : null])), gov_mode: g.gov_mode === undefined ? null : g.gov_mode, govModeFromData: govData,
                gov_headspeed: prof('gov_headspeed'), gov_max_throttle: prof('gov_max_throttle'), iterm_relax_level: prof('iterm_relax_level'), blackbox_rate_denom: g.blackbox_rate_denom === undefined ? null : g.blackbox_rate_denom,
                main_rotor_gear_ratio: g.main_rotor_gear_ratio === undefined ? null : g.main_rotor_gear_ratio, tail_rotor_gear_ratio: g.tail_rotor_gear_ratio === undefined ? null : g.tail_rotor_gear_ratio,
                tail_rotor_mode: g.tail_rotor_mode === undefined ? null : g.tail_rotor_mode, motor_poles: g.motor_poles === undefined ? null : g.motor_poles, mixerInputs: cli.mixerInputs,
                swash_ring: g.swash_ring === undefined ? null : g.swash_ring, swash_pitch_limit: g.swash_pitch_limit === undefined ? null : g.swash_pitch_limit } };
    }

    // F1-F4, F8: header facts
    const S = out.setup;
    { const act = [S.lpf1.active && { stage: 'lpf1', type: S.lpf1.typeName, hz: S.lpf1.hz }, S.lpf2.active && { stage: 'lpf2', type: S.lpf2.typeName, hz: S.lpf2.hz }, S.lpf1Dynamic.active && { stage: 'lpf1 dynamic', hz: S.lpf1Dynamic.min }].filter(Boolean);
        out.F1 = { lpf1: S.lpf1, lpf2: S.lpf2, lpf1Dynamic: S.lpf1Dynamic, active: act, rpmFilter: S.rpm.enabled, pidBandwidthHz: { roll: S.bandwidth.roll && S.bandwidth.roll[0], pitch: S.bandwidth.pitch && S.bandwidth.pitch[0], yaw: S.bandwidth.yaw && S.bandwidth.yaw[0] }, skipped: hk(h, 'gyro_soft_type') === null ? 'header lacks gyro_lpf1_type' : null };
        out.F2 = { lowestHz: act.length ? Math.min(...act.map(v => v.hz)) : null, active: act };
        const qs = []; for (const ax of lib.AXES) for (const b of S.rpm.banks[ax]) qs.push({ axis: ax, bank: b.bank, code: b.code, q: b.q });
        out.F3 = { rpm: qs, rpmMinQ: qs.length ? Math.min(...qs.map(v => v.q)) : null, dynNotchQ: S.dynNotch.q, dynNotchEnabled: S.dynNotch.enabled };
        out.F4 = { dtermCutoffHz: { roll: S.bandwidth.roll && S.bandwidth.roll[1], pitch: S.bandwidth.pitch && S.bandwidth.pitch[1], yaw: S.bandwidth.yaw && S.bandwidth.yaw[1] } };
        out.F8 = { enabled: S.dynNotch.enabled, count: S.dynNotch.count, pidHz: S.pidHz, forcedOffBelowHz: 1000, forcedOff: S.pidHz === null ? null : S.pidHz < 1000 }; }

    // F9: every configured notch at the in-flight headspeed of each profile
    { const byProfile = {}; for (let i = 0; i < n; i += 10) if (flying[i]) (byProfile[profile[i]] = byProfile[profile[i]] || []).push(w.hs[i]);
        const nyq = rate / 2, ceiling = S.rpm.ceilingHz, rows = [];
        for (const [p, list] of Object.entries(byProfile)) { const hs = median(list);
            for (const ax of lib.AXES) for (const b of S.rpm.banks[ax]) { if (b.order === null) { rows.push({ profile: +p, axis: ax, code: b.code, headspeed: r(hs, 0), hz: null, why: 'order unknown (gear ratios not given)' }); continue; }
                const f = b.order * hs / 60, alias = Math.abs(f - Math.round(f / rate) * rate);
                rows.push({ profile: +p, axis: ax, code: b.code, kind: b.kind, harmonic: b.harmonic, headspeed: r(hs, 0), samples: list.length * 10, hz: r(f, 1), aboveNyquist: f > nyq, aliasHz: f > nyq ? r(alias, 1) : null, aboveCeiling: ceiling ? f > ceiling : null, clampedToHz: ceiling && f > ceiling ? ceiling : null }); } }
        out.F9 = { nyquistHz: r(nyq, 1), notchCeilingHz: ceiling, rows }; }

    // F5, F6 from raw and filtered gyro against revolutions
    const raw = [0, 1, 2].map(a => x[`gyroRAW[${a}]`] || null);
    if (!raw.every(Boolean)) { out.F5 = out.F6 = { skipped: 'log lacks gyroRAW' }; return out; }
    if (flyingN < RULE.order.perRev * RULE.order.revolutions / 4) { out.F5 = out.F6 = { skipped: `too little flight (${out.flyingS} s) for ${RULE.order.revolutions}-revolution windows` }; return out; }
    const spec = orderSpectra(w, ctx, raw, S.rpm.banks), revs = RULE.order.revolutions, from = Math.round(RULE.order.from * revs);
    const notchOrders = lib.AXES.map((ax) => S.rpm.banks[ax].filter(b => b.order !== null));
    // F5 lines per profile, summed over axes, with the nearest configured notch of each axis
    const lines = [];
    for (const g of spec.groups) {
        const P = Float64Array.from(g.raw[0], (v, k) => (v + g.raw[1][k] + g.raw[2][k]) / g.windows);
        for (const L of findLines(P, revs, from, g.kMax)) {
            const pk = lib.spectralPeak(P, L.k - 2, L.k + 2), order = pk.bin / revs, gain = interpGain(order * meanSe(g.headspeed).mean / 60, rate);
            const perAxis = lib.AXES.map((ax, a) => { let best = null; for (const b of notchOrders[a]) { const d = Math.abs(order / b.order - 1); if (!best || d < best.distance) best = { code: b.code, order: r(b.order, 4), distance: r(d, 4) }; }
                const amp = (P) => { let e = 0; for (let q = L.k - RULE.attenuation.halfBins; q <= L.k + RULE.attenuation.halfBins; q++) e += P[q]; return r(Math.sqrt(e / g.windows / 1.5) / gain, 2); }; // 1.5: Hann width in bins
                return { axis: ax, amplitude: amp(g.raw[a]), filtered: amp(g.gyro[a]), nearestNotch: best }; });
            lines.push({ profile: g.profile, windows: g.windows, headspeed: r(meanSe(g.headspeed).mean, 0), order: r(order, 4), hz: r(order * meanSe(g.headspeed).mean / 60, 1), prominence: r(L.prominence, 1), axes: perAxis, rotorLocked: null });
        }
    }
    // a line is rotor-locked if the same order stands out in a profile flown at another headspeed (below that profile's
    // Nyquist order); unknown when no such profile exists
    for (const l of lines) {
        const k = Math.round(l.order * revs), tol = Math.max(2, Math.round(RULE.line.sameOrder * l.order * revs)), band = Math.round(RULE.line.band * revs); let best = null;
        for (const g of spec.groups) {
            if (g.profile === l.profile || Math.abs(meanSe(g.headspeed).mean / l.headspeed - 1) < RULE.line.otherHeadspeed || k + band > g.kMax) continue;
            const P = (q) => g.raw[0][q] + g.raw[1][q] + g.raw[2][q], around = []; let pk = 0;
            for (let q = k - tol; q <= k + tol; q++) pk = Math.max(pk, P(q));
            for (let q = k - band; q <= k + band; q++) if (Math.abs(q - k) > tol + 3) around.push(P(q));
            const pr = Math.sqrt(pk / (median(around) || 1e-30)); if (best === null || pr > best.prominence) best = { profile: g.profile, prominence: r(pr, 1) };
        }
        l.otherHeadspeed = best; l.rotorLocked = best === null ? null : best.prominence >= RULE.line.minProminence;
    }
    out.F5 = { windows: spec.windows.length, profiles: spec.groups.map(g => ({ profile: g.profile, windows: g.windows, headspeed: r(meanSe(g.headspeed).mean, 0), maxOrder: r(g.kMax / revs, 2) })), gear: gear ? gear.source : null,
        tailOrderKnown: lib.AXES.every((ax) => S.rpm.banks[ax].every(b => b.order !== null)), lines };

    // F6 attenuation per notch, per profile: mean and standard error over windows, and the pooled power ratio
    const rows = [];
    for (let a = 0; a < 3; a++) spec.notchBins[a].forEach(({ b, k }, j) => {
        for (const g of spec.groups) {
            const list = [], ev = []; for (const wv of spec.windows) if (wv.profile === g.profile && wv.db[a][j] !== null) { list.push(wv.db[a][j]); ev.push({ t: wv.t, value: wv.db[a][j], headspeed: wv.headspeed }); }
            const H = RULE.attenuation.halfBins; let er = 0, ef = 0, line = null;
            if (k + H <= g.kMax) { for (let q = k - H; q <= k + H; q++) { er += g.raw[a][q]; ef += g.gyro[a][q]; }
                const around = []; for (let q = Math.max(1, k - Math.round(RULE.line.band * revs)); q <= Math.min(g.raw[a].length - 1, k + Math.round(RULE.line.band * revs)); q++) if (Math.abs(q - k) > 3) around.push(g.raw[a][q]);
                let pk = 0; for (let q = k - H; q <= k + H; q++) pk = Math.max(pk, g.raw[a][q]); line = Math.sqrt(pk / (median(around) || 1e-30)); }
            const ms = meanSe(list);
            rows.push({ axis: lib.AXES[a], code: b.code, kind: b.kind, harmonic: b.harmonic, order: r(b.order, 4), q: b.q, profile: g.profile, headspeed: r(meanSe(g.headspeed).mean, 0),
                hz: r(b.order * meanSe(g.headspeed).mean / 60, 1), db: r(ms.mean, 2), se: r(ms.se, 2), n: ms.n, pooledDb: er && ef ? r(10 * Math.log10(er / ef), 2) : null,
                rawAmplitude: er ? r(Math.sqrt(er / g.windows / 1.5) / interpGain(b.order * meanSe(g.headspeed).mean / 60, rate), 2) : null, rawProminence: r(line, 1), events: ev, why: ms.n ? null : 'notch above the Nyquist order of every window' });
        } });
    const unknown = []; for (const ax of lib.AXES) for (const b of S.rpm.banks[ax]) if (b.order === null) unknown.push(`${ax} source ${b.code} (${b.kind}): order unknown without gear ratios`);
    out.F6 = { windows: spec.windows.length, rows, notMeasured: unknown };
    return out;
}

// ---------------------------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------------------------

const HEADER_KEYS = { profile: ['rollPID', 'pitchPID', 'yawPID', 'rollBW', 'pitchBW', 'yawBW', 'govPID', 'yaw_stop_gain', 'yaw_precomp', 'yaw_inertia_precomp', 'yaw_tta', 'error_limit', 'error_decay', 'error_decay_ground',
    'iterm_relax_type', 'iterm_relax_cutoff', 'cyclic_coupling', 'hsi_gain', 'hsi_limit', 'pitch_compensation'],
    global: ['Firmware revision', 'looptime', 'pid_process_denom', 'filter_process_denom', 'frameIntervalPDenom', 'features', 'debug_mode', 'rates_type', 'rc_rates', 'rc_expo', 'rates', 'response_time', 'accel_limit',
    'gyro_soft_type', 'gyro_lowpass_hz', 'gyro_soft2_type', 'gyro_lowpass2_hz', 'gyro_lowpass_dyn_hz', 'gyro_notch_hz', 'gyro_notch_cutoff', 'dyn_notch_count', 'dyn_notch_q', 'dyn_notch_min_hz', 'dyn_notch_max_hz',
    'gyro_rpm_notch_preset', 'gyro_rpm_notch_min_hz', 'gyro_rpm_notch_source_roll', 'gyro_rpm_notch_q_roll', 'gyro_rpm_notch_source_pitch', 'gyro_rpm_notch_q_pitch', 'gyro_rpm_notch_source_yaw', 'gyro_rpm_notch_q_yaw', 'collectiveRange'] };

// Tuning history: what changed in the header between consecutive logs. Profile gains are compared only between logs
// that started on the same PID profile; the header holds the profile active at arming.
function headerChanges(flights) {
    const list = flights.slice().sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.log - b.log), rows = [], s = (v) => Array.isArray(v) ? v.join(',') : String(v);
    let prev = null; const prevByProfile = new Map();
    for (const f of list) {
        const h = f.header || {}, sp = f.metrics ? f.metrics.startProfile : null;
        if (prev) for (const k of HEADER_KEYS.global) if (s(hk(prev.header, k)) !== s(hk(h, k))) rows.push({ log: f.log, since: prev.log, scope: 'global', key: k, from: s(hk(prev.header, k)), to: s(hk(h, k)) });
        const pp = prevByProfile.get(sp);
        if (pp) for (const k of HEADER_KEYS.profile) if (s(hk(pp.header, k)) !== s(hk(h, k))) rows.push({ log: f.log, since: pp.log, scope: `start profile ${sp}`, key: k, from: s(hk(pp.header, k)), to: s(hk(h, k)) });
        prev = f; prevByProfile.set(sp, f);
    }
    return rows;
}

function judge(flights, RULES = DEFAULT_RULES) {
    const F = [], add = (o) => F.push(Object.assign({ profile: null, value: null, se: null, n: null, threshold: null }, o)), R = RULES;
    for (const f of flights) {
        const m = f.metrics, log = f.log; if (!m) continue;
        // D1
        { const t = R.D1, v = m.D1.nominalHz, ok = v >= t.minHz;
            add({ id: 'D1', severity: ok ? 'ok' : 'flag', log, value: v, n: m.n, threshold: `nominal >= ${t.minHz} Hz`, source: t.source,
                text: `logging ${v} Hz nominal, ${m.D1.measuredHz} Hz by the log clock (Nyquist ${m.D1.nyquistHz} Hz). ` + (ok ? 'Vibration and D-noise checks may run.' : `Below ${t.minHz} Hz: rotor and tail harmonics alias; vibration and D-noise checks should not run.`) }); }
        // D2
        { const t = R.D2, d = m.D2, bad = (d.logGaps || 0) > t.maxGaps || (d.timeJumps || 0) + (d.loopStalls || 0) + (d.timeBackwards || 0) > t.maxJumps || (d.iterationJumps || 0) > t.maxJumps;
            add({ id: 'D2', severity: bad ? 'flag' : d.skipped ? 'note' : 'ok', log, value: (d.timeJumps || 0) + (d.timeBackwards || 0), n: m.n, threshold: `gaps <= ${t.maxGaps}, jumps <= ${t.maxJumps}`, source: t.source,
                text: `${d.logGaps} logging gaps in the log; in this segment ${d.timeJumps} time jumps (${d.missingFrames} frames missing, by ${d.missingFramesFrom}), ${d.loopStalls || 0} loop stalls (time jumps over contiguous loopIteration: no frame lost), ${d.timeBackwards} non-increasing times, ${d.iterationJumps} loopIteration jumps over ${m.n} frames` + (bad ? '; exclude the spans at the listed times.' : '.') + (d.skipped ? ` ${d.skipped}.` : ''), events: d.events }); }
        // D3
        { const sk = m.D3.skips;
            add({ id: 'D3', severity: sk.length ? 'note' : 'ok', log, value: sk.length, source: R.D3.source,
                text: sk.length ? 'checks that cannot run: ' + sk.map(s => `${s.checks.join('/')} (${s.missing.join(', ')})`).join('; ') : 'all fields for the checks are present.' }); }
        // D4
        if (!m.D4) { /* no CLI dump: no D4 result */ }
        else if (m.D4.skipped) add({ id: 'D4', severity: 'skipped', log, source: R.D4.source, text: m.D4.skipped });
        else { const d = m.D4, mm = d.mismatches, gm = d.cliOnly.gov_mode, gd = d.cliOnly.govModeFromData, govClash = gm && gd && ((/DIRECT|LIMIT|OFF/.test(gm) && /^PID/.test(gd)) || (/ELECTRIC|NITRO/.test(gm) && /^no PID/.test(gd)));
            add({ id: 'D4', severity: mm.length || govClash ? 'flag' : 'ok', log, profile: d.profileCompared, value: mm.length, n: d.compared, threshold: 'any disagreement', source: R.D4.source,
                text: `header vs CLI (${d.cliKind}, CLI profile ${d.profileCompared}, chosen by ${d.profileChosenBy}): ${mm.length} of ${d.compared} values differ` + (mm.length ? ': ' + mm.slice(0, 12).map(v => `${v.header} ${v.headerValue} vs ${v.cli} ${v.cliValue}${v.from === 'default' ? ' (default)' : ''}`).join('; ') + (mm.length > 12 ? '; ...' : '') + '. Trust the log header for header keys.' : '.')
                    + (govClash ? ` CLI gov_mode ${gm} but the data shows ${gd}: trust the data for the mode.` : '') }); }
        // F1
        { const x = m.F1;
            if (x.skipped) add({ id: 'F1', severity: 'skipped', log, source: R.F1.source, text: x.skipped });
            else { const none = !x.active.length, bad = none && x.rpmFilter;
                add({ id: 'F1', severity: bad ? 'flag' : none ? 'note' : 'ok', log, value: x.active.length, threshold: 'a gyro LPF when RPM filters are on', source: R.F1.source,
                    text: none ? `no gyro LPF active (lpf1 ${x.lpf1.typeName} ${x.lpf1.hz} Hz, lpf2 ${x.lpf2.typeName} ${x.lpf2.hz} Hz, dynamic ${x.lpf1Dynamic.min}-${x.lpf1Dynamic.max} Hz)${x.rpmFilter ? ' with RPM filters on' : ''}; only the PID bandwidth filter (gyro_cutoff ${x.pidBandwidthHz.roll}/${x.pidBandwidthHz.pitch}/${x.pidBandwidthHz.yaw} Hz) smooths the gyro before P.`
                        : 'gyro LPF: ' + x.active.map(v => `${v.stage} ${v.type || ''} ${v.hz} Hz`).join(', ') + '.' }); } }
        // F2
        { const t = R.F2, v = m.F2.lowestHz;
            if (v === null) add({ id: 'F2', severity: 'skipped', log, source: t.source, text: 'no gyro LPF active, nothing to compare (see F1).' });
            else add({ id: 'F2', severity: v < t.flagHz ? 'flag' : v < t.noteHz ? 'note' : 'ok', log, value: v, threshold: `< ${t.flagHz} Hz flag, < ${t.noteHz} Hz note`, source: t.source, text: `lowest gyro LPF cutoff ${v} Hz.` }); }
        // F3
        { const t = R.F3, x = m.F3, low = x.rpm.filter(v => v.q < t.minQ), dynLow = x.dynNotchEnabled && x.dynNotchQ !== null && x.dynNotchQ < t.minQ;
            add({ id: 'F3', severity: low.length || dynLow ? 'flag' : x.rpm.length ? 'ok' : 'note', log, value: x.rpmMinQ, n: x.rpm.length, threshold: `Q >= ${t.minQ}`, source: t.source,
                text: x.rpm.length ? `RPM notch Q ${x.rpmMinQ}..${Math.max(...x.rpm.map(v => v.q))} over ${x.rpm.length} banks` + (low.length ? `; below ${t.minQ}: ` + low.map(v => `${v.axis} ${v.code} Q ${v.q}`).join(', ') : '') + (x.dynNotchEnabled ? `; dynamic notch Q ${x.dynNotchQ}` : '; dynamic notch off') + '.' : 'no RPM notch banks configured.' }); }
        // F4
        { const t = R.F4; for (const [ax, v] of Object.entries(m.F4.dtermCutoffHz)) { if (v === null || v === undefined) continue; const dev = v - t.targetHz;
            add({ id: 'F4', severity: Math.abs(dev) > t.toleranceHz ? 'note' : 'ok', log, profile: ax, value: v, threshold: `${t.targetHz} +- ${t.toleranceHz} Hz (advisory)`, source: t.source, text: `${ax} D cutoff ${v} Hz, ${dev >= 0 ? '+' : ''}${dev} Hz from the documented ~${t.targetHz} Hz; advisory only.` }); } }
        // F8
        { const x = m.F8, t = R.F8, uncovered = m.F5 && m.F5.lines ? m.F5.lines.filter(l => l.prominence >= R.F5.minProminence && l.axes.every(a => !a.nearestNotch || a.nearestNotch.distance > R.F5.maxDistance)) : [];
            const forced = x.pidHz !== null && x.pidHz < t.minPidHz;
            add({ id: 'F8', severity: (!x.enabled && uncovered.length) || forced ? 'note' : 'ok', log, value: x.enabled, threshold: `PID rate >= ${t.minPidHz} Hz`, source: t.source,
                text: `dynamic notch ${x.enabled ? 'on' : 'off'} (count ${x.count}), PID rate ${x.pidHz} Hz` + (forced ? `: forced off below ${t.minPidHz} Hz` : '') + (!x.enabled && uncovered.length ? `; ${uncovered.length} strong line-profile pair(s) without RPM notch coverage (see F5).` : '.') }); }
        // F9
        { const x = m.F9, over = x.rows.filter(v => v.aboveNyquist || v.aboveCeiling), unk = x.rows.filter(v => v.hz === null);
            add({ id: 'F9', severity: over.length ? 'note' : unk.length ? 'note' : 'ok', log, value: over.length, n: x.rows.length, threshold: `harmonic > Nyquist ${x.nyquistHz} Hz or > notch ceiling ${x.notchCeilingHz} Hz`, source: R.F9.source,
                text: (over.length ? over.map(v => `profile ${v.profile} ${v.axis} source ${v.code} at ${v.hz} Hz (${v.headspeed} rpm)` + (v.aboveNyquist ? ` above Nyquist, logged alias ${v.aliasHz} Hz` : '') + (v.aboveCeiling ? `, notch clamped to ${v.clampedToHz} Hz` : '')).join('; ') : 'every configured notch below Nyquist and the notch ceiling')
                    + (unk.length ? `; ${unk.length} bank-profile pairs of unknown frequency (no gear ratios)` : '') + '.' }); }
        // F5
        if (m.F5.skipped) add({ id: 'F5', severity: 'skipped', log, source: R.F5.source, text: m.F5.skipped });
        else for (const p of m.F5.profiles) {
            const t = R.F5, ls = m.F5.lines.filter(l => l.profile === p.profile);
            if (p.windows < t.minWindows) { add({ id: 'F5', severity: 'note', log, profile: p.profile, n: p.windows, threshold: `>= ${t.minWindows} windows`, source: t.source, text: `no finding: ${p.windows} window(s) at ${p.headspeed} rpm, too few.` }); continue; }
            const bad = ls.filter(l => l.prominence >= t.minProminence && l.axes.some(a => a.amplitude > 0 && (!a.nearestNotch || a.nearestNotch.distance > t.maxDistance)));
            add({ id: 'F5', severity: bad.length ? 'flag' : 'ok', log, profile: p.profile, value: bad.length ? bad[0].order : null, n: p.windows, threshold: `prominence >= ${t.minProminence} with no notch within ${t.maxDistance * 100} %`, source: t.source,
                text: bad.length ? bad.map(l => `line at ${l.order} x rotor (${l.hz} Hz, prominence ${l.prominence}${l.rotorLocked === true ? ', rotor-locked' : l.rotorLocked === false ? ', absent at the same order at another headspeed: not rotor-locked' : ''}): nearest notch ` + l.axes.map(a => `${a.axis} ${a.nearestNotch ? `${a.nearestNotch.code} at ${a.nearestNotch.order} (${(a.nearestNotch.distance * 100).toFixed(1)} %)` : 'none'}`).join(', ')).join('; ')
                    : `${ls.length} line(s) of prominence >= ${RULE.line.minProminence}; every one of prominence >= ${t.minProminence} has a notch within ${t.maxDistance * 100} % on every axis.` + (m.F5.tailOrderKnown ? '' : ' Tail notch orders unknown (no gear ratios): tail lines count as uncovered.') }); }
        // F6
        if (m.F6.skipped) add({ id: 'F6', severity: 'skipped', log, source: R.F6.source, text: m.F6.skipped });
        else { const t = R.F6;
            for (const row of m.F6.rows) {
                const base = { id: 'F6', log, profile: row.profile, value: row.db, se: row.se, n: row.n, threshold: `>= ${t.minDb} dB`, source: t.source };
                const what = `${row.axis} notch ${row.code} (${row.kind} ${row.harmonic}, ${row.order} x rotor, ${row.hz} Hz, Q ${row.q}) at ${row.headspeed} rpm`;
                if (row.n < t.minWindows) add(Object.assign(base, { severity: 'note', text: `no finding: ${what} measured in ${row.n} window(s)` + (row.why ? ` (${row.why})` : '') + '.' }));
                else if (row.rawProminence < t.minLineProminence) add(Object.assign(base, { severity: 'ok', text: `no finding: ${what}: raw line prominence ${row.rawProminence} < ${t.minLineProminence}, nothing to attenuate; ${row.db} +- ${row.se} dB over ${row.n} windows.` }));
                else add(Object.assign(base, { severity: row.db < t.minDb ? 'flag' : 'ok', text: `${what}: ${row.db} +- ${row.se} dB (pooled ${row.pooledDb} dB) over ${row.n} windows, raw ${row.rawAmplitude} deg/s, prominence ${row.rawProminence}` + (row.db < t.minDb ? ': mis-centred or too narrow.' : '.') }));
            }
            for (const s of m.F6.notMeasured) add({ id: 'F6', severity: 'skipped', log, source: t.source, text: s }); }
        // setup facts
        { const s = m.setup, b = (ax) => s.rpm.banks[ax].map(v => `${v.code}${v.order !== null ? `@${r(v.order, 3)}x` : ''}/Q${v.q}`).join(' ');
            add({ id: 'SETUP', severity: 'note', log, source: 'log header', text: `${s.firmware}; log ${s.logRateHz} Hz (PID ${s.pidHz}, gyro ${s.gyroSampleHz}, decimation ${s.gyroDecimationHz} Hz); LPF1 ${s.lpf1.typeName} ${s.lpf1.hz}, LPF2 ${s.lpf2.typeName} ${s.lpf2.hz}; dyn notch ${s.dynNotch.enabled ? 'on' : 'off'}; RPM preset ${s.rpm.preset} min ${s.rpm.minHz} Hz, roll ${b('roll')}, pitch ${b('pitch')}, yaw ${b('yaw')}; `
                + `PID R ${s.pid.roll} P ${s.pid.pitch} Y ${s.pid.yaw}; BW R ${s.bandwidth.roll} P ${s.bandwidth.pitch} Y ${s.bandwidth.yaw}; gov ${s.governor.gains} (${s.governor.order}); yaw stop ${s.yaw.stopGain}, precomp ${s.yaw.precomp}, inertia ${s.yaw.inertia}, TTA ${s.yaw.tta}.` }); }
    }
    for (const c of headerChanges(flights)) add({ id: 'H', severity: 'note', log: c.log, profile: c.scope, value: c.to, source: R.H ? R.H.source : 'log header', text: `${c.key}: ${c.from} -> ${c.to} (since log ${c.since}, ${c.scope})` });
    return F;
}

module.exports = { EXTRA, RULE, DEFAULT_RULES, analyse, judge, parseCli, compareCli, decodeNotchSource, rpmBanks, headerChanges, GOV_STATES, LPF_TYPES, FEATURE_BITS };
