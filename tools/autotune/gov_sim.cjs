'use strict';

/**
 * Closed-loop runner of the native Rotorflight 4.6 governor (docs/GOVERNOR_AUTOTUNE.md sections 4.6, 6 and 7). It drives
 * firmware_controller.govCreate (controller.wasm, rf_gov_step) with the inputs of one logged run (gov_data.cjs), on the
 * recorded headspeed (parity, open loop) or on the governor twin (gov_twin.cjs, closed loop). It generalizes
 * analysis/governor-twin/parity.cjs for gov_fit (validation) and gov_tune (scenarios).
 *
 *   configOf(runs, recovered, { cli })  the governor values of each run, for govCreate: { [key]: cfg }, key = String(run.log) (with
 *                       '.<segment>' for a segment > 0). recovered: gov_params.recover(runs, { cli }); cli: the text of a CLI dump or
 *                       health_setup.parseCli output (optional). cfg:
 *     global, profiles   schema values (firmware/schema.cjs names) of the global governor values and of each PID profile n (1-6)
 *     cli                the same values with the CLI names: { global: { name: value }, profiles: { n: { name: value } } }
 *     sources            { name: source } of the global names; profileSources { n: { name: source } }. A source is "CLI dump",
 *                        "log header", "calculated from the log: <method>", "default value" or "unknown"
 *     assumptions        [{ name, profile, value, reason (STE), states }]: a value that the log does not give. states: the governor
 *                        states (0-9) in which the value acts, when the rule is "the log has none of these states"; run() reports
 *                        the assumptions whose states the simulation visits (assumedInEffect)
 *     unknown            [{ name, profile, reason, used }]: the names with no value; used: the governor reads it (then excluded)
 *     flags              the gov_params flags ("values possibly not current") of the values of this log
 *     excluded           null, or the STE reason why the simulation cannot use this log (or one of its PID profiles)
 *     start, changes     the PID profile at sample 0 and the applied changes [{ k (sample), profile, at (sample of the event) }].
 *                        The PID profile of a sample: the logged change, else the governor headspeed (gov_params.labels), else the
 *                        CLI dump PID profile with that headspeed (only one); a sample with none: "PID profile unknown" (excluded)
 *     gear, voltageSource, cells (the CLI dump; else 1:1, none, 0 = the auto rule of govCreate), notes
 *   Value priority (for each log, and each PID profile of a profile name):
 *     1. the CLI dump, if it agrees with the recovered values of that log (gov_params.compareCli, also the products of the gains
 *        that contain the name, and the candidates), or if that log cannot show the value
 *     2. the recovered value of that log: its epoch (calculated from the log, then the log header; bench epochs only for their
 *        own log), with its flag. An epoch that holds the logs before and after the log gives the value too (an assumption)
 *     3. gains: the products K Kp, K Ki and K Kf w only: integer values that keep every product (decompose(); an assumption: the
 *        simulation depends on the products only)
 *     4. the nearest epoch of the same name and PID profile, if it agrees with the bounds of that log (an assumption)
 *     5. a bound (a limit never reached, a timeout): the default value if it agrees with the bound, else the bound
 *     6. candidates: the default value if it is a candidate, else a rule (gov_mode), else the first candidate
 *     7. no effect in this log: the default value, when the governor reads the value only in states that the log does not have
 *        (FALLBACK, RECOVERY, BAILOUT, HOLD, AUTOROTATION, SPOOLUP; for a PID profile value: no PID state in that PID profile), a
 *        limit with no evidence, the D-term below RULES.dNegligible (gov_d_gain of another PID profile with the same gov_gain, else
 *        0), no tail torque assist (gov_tta_gain 0), no minimum throttle floor (gov_use_dyn_min_throttle OFF), and the
 *        tail_rotor_mode VARIABLE that the yaw feedforward fit shows
 *     A value that the governor reads (govRequiredFields) with none of these: the log is excluded with an STE reason. The CLI
 *     names of the 42 governor values are gov_params NAMES; toSchema() maps them to the schema (weights, flag bits, enumerations).
 *
 *   run(run, cfg, { plant, twin, scenario, record })  async. plant 'recorded' (default): the recorded headspeed into the governor
 *     (open loop, parity of SPEC 6.7). plant 'twin': closed loop, the governor throttle drives gov_twin (twin: its parameter set),
 *     the twin rotor speed x gear is the raw RPM into the governor, the twin vLog is the battery voltage (the recorded Vbat if
 *     the twin has no voltage), the load is the recorded mixer. Both step at pidHz, with the logged inputs held between frames.
 *     Arming from run.armed and run.preroll. At each recorded PID profile change: profile() with the values of that PID profile.
 *     scenario:
 *       forceFallback  'recorded' (default: the logged FALLBACK entries, as parity.cjs: the filtered logged headspeed cannot
 *                      reproduce the raw RPM glitches, critique M11), [] (none), or times (s, run.time): govFallback for one loop
 *       glitches       times (s, run.time): a raw RPM spike of RULES.glitch x the full headspeed for one PID loop
 *       ocv            the open-circuit voltage at the start (V; e.g. end-of-pack). Without voltage in the twin: the twin voltage
 *                      scale and the recorded Vbat into the governor scale by ocv / (the recorded rest voltage)
 *       values         { global: {...}, profiles: { n: {...} }, all: {...} }: CLI or schema names, for candidate evaluation
 *       twinStart      true: the twin starts with the rotor stopped at the recorded rest voltage (else from the data at sample 0)
     A twin start from rest (twinStart, or the rotor stopped at sample 0) puts the OCV at the rest voltage (or ocv) less the rest offset
     vp of the twin (gov_twin). A run whose first logged governor state is later than IDLE (a part of a log after a logging pause)
     returns { excluded } (TEXT.midStart): the governor starts in its reset state. Not with twinStart.
 *     record: false, or { points } (default RULES.points): the decimated traces { stride, i (sample), t, hs, target, u, I, vbat,
 *     ibat, state, profile }; hs is the twin hsLog (the logged headspeed of the twin) or the recorded headspeed.
 *   -> { log, plant, frames, seconds, metrics: { profiles: { n: {...} }, events }, compare, parity (plant 'recorded'), trace,
 *        assumedInEffect, preroll, changes, forced, glitches, notes, ms } or { excluded }
 *
 *   logMetrics(run, cfg)  the same metrics of the log itself (the logged hs, govTarget, motor[0], states, govI): a baseline
 *   metrics(x, o)  section 7 metrics for each PID profile in ACTIVE: x { rate, hs, target, request, u, state, I, profile } (arrays
 *     per sample; the log itself gives the baseline: hs, target, request, u, state, govI, labels), o.limits { n: { maxThrottle,
 *     iLimit } } (fractions). eRms, droop95, over95 (% of target), thrHF (% throttle RMS above RULES.hfHz), satShare, iLimitOutsideSat
 *     (s and share), spool overshoot (% of the request, in RULES.spoolS after the SPOOLUP exit while the request stays), and for
 *     each FALLBACK entry the G droop (minimum HS / request: RECOVERY starts the target at the headspeed, so HS / target stays near
 *     1) and the recovery time to within RULES.recoverTol of the request (null when not in RULES.eventS).
 *
 * Kmot starts at 0 in each log, as after a power-up (SPEC 6.5). The parity script also carries Kmot across the logs of one power
 * cycle (critique M12); the effect on the parity is 0.1 count or less.
 */

const F = require('./firmware_controller.cjs');
const GP = require('./gov_params.cjs');
const GT = require('./gov_twin.cjs');

const RULES = {
    profileSearch: [-5, 50], // samples around a logged PID profile change in which the govRequest step marks governorInitProfile
    glitch: 2.5,             // injected raw RPM spike, x the full headspeed / gear (firmware limit 2.0, GOV_HS_GLITCH_LIMIT)
    decompTol: 0.01,         // largest relative error of a product of gains after the integer decomposition
    dNegligible: 0.003,      // |govD| at most this in ACTIVE (fraction of throttle, 3 counts): the D-term has no effect
    electricV: 9,            // gov_mode candidates: ELECTRIC above this rest voltage (a flight pack: 3 cells or more)
    parity: { state: 0.995, thrRms: 2 }, // SPEC 6.7: state agreement, ACTIVE throttle RMS in counts (0.1 %)
    satEps: 0.005,           // u >= max throttle - satEps: saturated
    iLimitEps: 0.005,        // |I| >= i_limit - iLimitEps: at the I limit
    hfHz: 5,                 // thrHF: RMS of u above this frequency (u less its zero-phase low-pass)
    windowS: 1, worst: 0.05, // droop95 and over95: the mean of the worst 5 % of the 1-s windows (the window minimum or maximum)
    spoolS: 5,               // spool overshoot: the peak in this time after the SPOOLUP exit
    eventS: 5,               // G droop and recovery: the window after a FALLBACK entry
    recoverTol: 0.01,        // recovery: the headspeed within 1 % of the request
    points: 2000,            // trace points
};

const STATES = ['OFF', 'IDLE', 'SPOOLUP', 'RECOVERY', 'ACTIVE', 'HOLD', 'FALLBACK', 'AUTOROTATION', 'BAILOUT', 'BYPASS'];
const RENAME = { gov_yaw_ff_weight: 'gov_yaw_weight', gov_cyclic_ff_weight: 'gov_cyclic_weight', gov_collective_ff_weight: 'gov_collective_weight' };
const FLAG_BITS = { gov_use_fallback_precomp: 2, gov_use_voltage_comp: 3, gov_use_pid_spoolup: 4, gov_use_dyn_min_throttle: 6 };
const ENUMS = { gov_mode: { OFF: 0, NONE: 0, LIMIT: 1, DIRECT: 2, ELECTRIC: 3, NITRO: 4 }, gov_throttle_type: { NORMAL: 0, SWITCH: 1, FUNCTION: 2 },
    battery_meter: { NONE: 0, ADC: 1, ESC: 2 }, voltage_meter: { NONE: 0, ADC: 1, ESC: 2 }, main_rotor_dir: { CW: 0, CCW: 1 },
    tail_rotor_mode: { VARIABLE: 0, MOTORIZED: 1, BIDIRECTIONAL: 2 } };
const GAINS = ['gov_gain', 'gov_p_gain', 'gov_i_gain', 'gov_f_gain', 'gov_collective_ff_weight', 'gov_cyclic_ff_weight', 'gov_yaw_ff_weight'];
// each product (gov_params EFFECTIVE) with its factors, and its value from integer CLI values
const PRODUCTS = { gov_kp_effective: ['gov_gain', 'gov_p_gain'], gov_ki_effective: ['gov_gain', 'gov_i_gain'], gov_collective_ff_effective: ['gov_gain', 'gov_f_gain', 'gov_collective_ff_weight'],
    gov_cyclic_ff_effective: ['gov_gain', 'gov_f_gain', 'gov_cyclic_ff_weight'], gov_yaw_ff_effective: ['gov_gain', 'gov_f_gain', 'gov_yaw_ff_weight'] };
const productOf = (e, v) => PRODUCTS[e].length === 2 ? v[PRODUCTS[e][0]] * v[PRODUCTS[e][1]] / 1000 : v.gov_gain * v.gov_f_gain * v[PRODUCTS[e][2]] / 1e6;
// the states in which a value acts (rule 7), the text of these states
const ONLY_IN = { gov_recovery_time: [3, 8], gov_throttle_hold_timeout: [5], gov_autorotation_timeout: [7], gov_fallback_drop: [6], gov_use_fallback_precomp: [6], gov_use_pid_spoolup: [2] };
const LIMITS = ['gov_p_limit', 'gov_i_limit', 'gov_d_limit', 'gov_f_limit', 'gov_max_throttle', 'gov_min_throttle'];
const PID_STATES = [2, 3, 4, 6, 8]; // a PID profile value with none of these states in that profile has no effect
const PROFILE_FIELDS = F.SCHEMA.filter(f => f.member.startsWith('profile.governor.')).map(f => f.name);

const N = (l) => l + 1; // the log number in a text
const logWords = (logs) => logs.length === 1 ? `log ${N(logs[0])}` : `logs ${logs.map(N).join(', ')}`;
const stateWords = (s) => s.map(x => STATES[x]).join(s.length > 2 ? ', ' : ' and ').replace(/, ([^,]+)$/, ' and $1');
const TEXT = {
    noHs: 'The log does not record the headspeed. Thus, the governor model cannot use this log.',
    noThr: 'The log does not record the throttle input ("rcCommand[4]"). Thus, the governor model cannot use this log.',
    noMixer: 'The log does not record the mixer inputs ("mixer[0]" to "mixer[3]"). Thus, the governor model cannot use this log.',
    noMotor: 'The log does not record the motor output ("motor[0]"). Thus, the governor model cannot use this log.',
    profileUnknown: (log) => `PID profile unknown. The analysis cannot find the PID profile of each part of log ${N(log)}. Thus, the governor model cannot use this log.`,
    unknownValue: (name, p, log) => `The analysis cannot find the value of "${name}"${p ? ` for PID profile ${p}` : ''} in log ${N(log)}. The governor uses this value. Thus, the governor model cannot use this log.`,
    bypass: (log) => `The governor goes to BYPASS in log ${N(log)}. The log does not record the BYPASS switch. Thus, the governor model cannot use this log.`,
    govError: (log, msg) => `The governor model cannot use log ${N(log)}. The cause is "${msg}".`,
    inLog: (name, log, v) => `The value of "${name}" changes in log ${N(log)}. The model uses ${v}, the value of the longest part.`,
    between: (name, log, logs) => `Log ${N(log)} does not show "${name}". The model uses the value of ${logWords(logs)}, before and after this log.`,
    nearest: (name, log, logs) => `Log ${N(log)} does not show "${name}". The model uses the value of ${logWords(logs)}.`,
    bound: (name, lo, hi, v, def) => `The log does not show "${name}". The value is ${lo != null && hi != null ? `${lo} to ${hi}` : lo != null ? `${lo} or more` : `${hi} or less`}. Thus, the model uses ${def ? 'the default value ' : ''}${v}.`,
    candidates: (name, list, v, why) => `The log does not show "${name}". The possible values are ${list.join(' and ')}.${why ? ' ' + why : ''} Thus, the model uses ${v}.`,
    electric: (v) => `The battery voltage at the start of the log is ${v} V, more than ${RULES.electricV} V. Only a motor battery has this voltage.`,
    stateOnly: (name, s, v, p) => `The governor uses "${name}" only in ${stateWords(s)}. The log does not have ${stateWords(s)}${p ? ` in PID profile ${p}` : ''}. Thus, the model uses the default value ${v}.`,
    limit: (name, v) => `The log does not show "${name}", because the governor does not get to this limit. Thus, the model uses the default value ${v}.`,
    dynOff: (v) => `The model uses "gov_use_dyn_min_throttle" OFF. Thus, "gov_dyn_min_throttle" has no effect, and the model uses the default value ${v}.`,
    noFloor: 'The motor output does not stop at a minimum in the log. Thus, the model uses "gov_use_dyn_min_throttle" OFF.',
    dOther: (p, max, q, v) => `For PID profile ${p}, the D-term of the governor ("govD") is ${max > 0 ? `${+(max * 100).toFixed(2)} % or less` : '0'} in ACTIVE. Thus, the model uses "gov_d_gain" ${v} of PID profile ${q}, which has the same "gov_gain".`,
    dZero: (p, max) => `For PID profile ${p}, the D-term of the governor ("govD") is ${max > 0 ? `${+(max * 100).toFixed(2)} % or less` : '0'} in ACTIVE. Thus, the model uses "gov_d_gain" 0.`,
    dOff: (name, v) => `The D-term of the governor is 0 or very small. Thus, the effect of "${name}" is very small, and the model uses the default value ${v}.`,
    tta: 'The log header gives "gov_tta_gain" only for the PID profile at the start of the log. The fit of "govP" shows no tail torque assist. Thus, the model uses 0.',
    tailMode: 'The log does not record "tail_rotor_mode". The fit of "govF" agrees with the tail rotor mode "VARIABLE". Thus, the model uses "VARIABLE".',
    vcompOff: 'The log shows that the voltage compensation is not active. Thus, the model uses "gov_use_voltage_comp" OFF. The result is the same.',
    vcompAdc: 'The log shows that the voltage compensation is active. The firmware does this only with the voltage source ADC. Thus, the model uses ADC.',
    decomposed: (p, list) => `For PID profile ${p}, the log gives "gov_gain" multiplied by each other gain, but not each gain. The model uses ${list}. The result is the same for all values that give the same multiplied gains.`,
    kmot: 'The motor constant of the governor starts at 0 at the start of each log, as after a power-up.',
    midStart: (rec, s) => `${rec.segment ? `Part ${rec.segment + 1} of log ${N(rec.log)}` : `Log ${N(rec.log)}`} starts ${s == null ? 'with the motor on' : `with the governor in ${STATES[s]}`}. ` +
        'The governor model must start before the helicopter is armed. Thus, the governor model cannot use this part of the log.',
};

const r = (v, d = 3) => v == null || !isFinite(v) ? null : +v.toFixed(d);
const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const D = F.defaults();
// the default value of a CLI name (strings for the flags and the enumerations)
function cliDefault(name) {
    if (FLAG_BITS[name] !== undefined) return D.gov_flags >> FLAG_BITS[name] & 1 ? 'ON' : 'OFF';
    if (ENUMS[name]) return Object.keys(ENUMS[name]).find(k => ENUMS[name][k] === D[name === 'battery_meter' ? 'voltage_meter' : name]);
    if (name === 'gov_bypass_throttle') return Array.from({ length: 9 }, (_, i) => D[`gov_bypass_throttle[${i}]`]);
    return D[RENAME[name] || name];
}
const same = (a, b) => typeof a === 'string' || typeof b === 'string' ? String(a).toUpperCase() === String(b).toUpperCase() : Math.abs(a - b) < 1e-9;

// CLI or schema names to schema values; flags change the bits of base.gov_flags (or of the default)
function toSchema(values, base = {}) {
    const out = {};
    let flags = own(base, 'gov_flags') ? base.gov_flags : null;
    for (const [k, v] of Object.entries(values || {})) {
        if (v === undefined || v === null) continue;
        if (FLAG_BITS[k] !== undefined) {
            if (flags === null) flags = D.gov_flags;
            const on = v === true || v === 1 || String(v).toUpperCase() === 'ON';
            flags = on ? flags | 1 << FLAG_BITS[k] : flags & ~(1 << FLAG_BITS[k]);
        } else if (k === 'gov_bypass_throttle') (Array.isArray(v) ? v : String(v).split(/[,\s]+/)).forEach((x, i) => { out[`gov_bypass_throttle[${i}]`] = Number(x); });
        else if (k === 'main_rotor_gear_ratio') (Array.isArray(v) ? v : String(v).split(/[,\s]+/)).forEach((x, i) => { out[`main_rotor_gear_ratio[${i}]`] = Number(x); });
        else if (ENUMS[k]) out[k === 'battery_meter' ? 'voltage_meter' : k] = typeof v === 'number' ? v : ENUMS[k][String(v).toUpperCase()];
        else out[RENAME[k] || k] = Number(v);
    }
    if (flags !== null) out.gov_flags = flags >>> 0;
    return out;
}

// ---------------------------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------------------------

const keyOf = (run) => run.segment ? `${run.log}.${run.segment}` : String(run.log);

// the PID profile at sample 0 and the applied profile changes (parity.cjs): each logged change (with the arming profile fill, the
// first logged sample), applied at the govRequest step from RULES.profileSearch around it (the frame of governorInitProfile)
function profileEvents(run, lab) {
    const n = run.n, p = run.profile, q = run.request, f = run.profileFilled || 0, out = [];
    for (let i = 1; i < n; i++) if (p[i] > 0 && (f > 0 && i === f || i !== f && p[i] !== p[i - 1])) {
        let k = i;
        if (q) for (let j = Math.max(1, i + RULES.profileSearch[0]); j < Math.min(n, i + RULES.profileSearch[1]); j++) if (q[j] !== q[j - 1]) { k = j; break; }
        out.push({ k, at: i, profile: p[i] });
    }
    return { start: lab ? lab[0] : p[0], changes: out.sort((a, b) => a.k - b.k) };
}

// integer gains that keep the products: { values, err } or null. known: the gains with a value; prods: { product name: value };
// cands: { gov_gain: [...], gov_f_gain: [...] } in the order of preference. The first preferred pair that keeps every product
// within RULES.decompTol, else the pair of 1-250 with the smallest error (within RULES.decompTol)
function decompose(known, prods, cands = {}) {
    const need = GAINS.filter(g => known[g] === undefined);
    const usable = Object.keys(PRODUCTS).filter(e => prods[e] != null && PRODUCTS[e].some(g => need.includes(g)));
    if (!need.length || !usable.length) return null;
    const tryWith = (G, Fg) => {
        const v = Object.assign({}, known);
        if (G != null) v.gov_gain = G;
        if (Fg != null) v.gov_f_gain = Fg;
        let err = 0;
        for (const e of usable) {
            const fs = PRODUCTS[e], last = fs[fs.length - 1], div = fs.length === 2 ? v.gov_gain / 1000 : v.gov_gain * v.gov_f_gain / 1e6;
            if (v[last] === undefined) { if (!(div > 0)) return null; const x = Math.round(prods[e] / div); if (x > 250) return null; v[last] = x; }
            const q = productOf(e, v), t = prods[e];
            if (!isFinite(q)) return null;
            err = Math.max(err, t === 0 ? (q === 0 ? 0 : Infinity) : Math.abs(q - t) / Math.abs(t));
        }
        return { values: v, err };
    };
    const needF = known.gov_f_gain === undefined && usable.some(e => PRODUCTS[e].length === 3);
    const all = Array.from({ length: 250 }, (_, i) => i + 1);
    const Gp = known.gov_gain !== undefined ? [null] : cands.gov_gain || [], Fp = needF ? cands.gov_f_gain || [] : [null];
    for (const G of Gp) for (const Fg of Fp) { const x = tryWith(G, Fg); if (x && x.err <= RULES.decompTol) return x; }
    let best = null;
    for (const G of known.gov_gain !== undefined ? [null] : all) for (const Fg of needF ? all : [null]) { const x = tryWith(G, Fg); if (x && (!best || x.err < best.err - 1e-12)) best = x; }
    return best && best.err <= RULES.decompTol ? best : null;
}

// the governor configuration of each run (see the header)
function configOf(runs, recovered, opts = {}) {
    const R = recovered, cli = !opts.cli ? null : typeof opts.cli === 'string' ? require('./health_setup.cjs').parseCli(opts.cli) : opts.cli;
    const cmp = cli ? (R.cli && R.cli.length ? R.cli : GP.compareCli(R, cli)) : [];
    const out = {};
    for (const run of runs) out[keyOf(run)] = logConfig(run, R, cli, cmp);
    return out;
}

function logConfig(run, R, cli, cmp) {
    const log = run.log, cfg = { key: keyOf(run), log, segment: run.segment || 0, global: {}, profiles: {}, cli: { global: {}, profiles: {} }, sources: {}, profileSources: {},
        assumptions: [], unknown: [], flags: [], excluded: null, start: 0, changes: [], gear: null, voltageSource: null, cells: 0, notes: [TEXT.kmot] };
    const why = !run.hs ? TEXT.noHs : !run.u ? TEXT.noMotor : !run.thr ? TEXT.noThr : !run.coll || !run.roll || !run.pitch || !run.yaw ? TEXT.noMixer : null;
    if (why) { cfg.excluded = why; return cfg; }
    const lab = GP.labels(run, R.profileMap);
    // the CLI dump gives the PID profile of a governor headspeed that only one of its PID profiles has (CLAUDE.md "PID profiles")
    if (cli && run.request && lab.some(v => v === 0)) {
        const by = {}; for (const [k, s] of Object.entries(cli.profiles || {})) if (typeof s.gov_headspeed === 'number') by[s.gov_headspeed] = by[s.gov_headspeed] === undefined ? +k + 1 : 0;
        for (let i = 0; i < run.n; i++) if (!lab[i]) lab[i] = by[Math.round(run.request[i])] || 0;
    }
    const ev = profileEvents(run, lab);
    cfg.start = ev.start; cfg.changes = ev.changes;
    if (lab.some(v => v === 0) || ev.changes.some(c => !(c.profile > 0))) { cfg.excluded = TEXT.profileUnknown(log); return cfg; }
    const profiles = [...new Set(lab)].sort((a, b) => a - b), st = run.state, seen = new Set();
    if (st) for (let i = 0; i < run.n; i++) { seen.add(st[i]); seen.add(lab[i] * 10 + st[i] + 100); }
    if (seen.has(9)) { cfg.excluded = TEXT.bypass(log); return cfg; }
    const hasIn = (p, s) => seen.has(p ? p * 10 + s + 100 : s);
    const items = R.items.filter(i => i.log === log || i.log == null && (i.logs || []).includes(log)), sec = (p) => !cli ? null : p ? (cli.profiles || {})[String(p - 1)] : cli.global;
    const val = (p) => p ? (cfg.cli.profiles[p] || (cfg.cli.profiles[p] = {})) : cfg.cli.global;
    const srcOf = (p) => p ? (cfg.profileSources[p] || (cfg.profileSources[p] = {})) : cfg.sources;
    const isSet = (name, p) => own(val(p), name);
    const set = (name, p, v, source, reason, states) => {
        val(p)[name] = v; srcOf(p)[name] = source;
        if (reason) cfg.assumptions.push({ name, profile: p, value: v, reason, states: states || null });
    };
    const num = (v) => typeof v === 'number' ? v : NaN, dist = (e) => Math.min(Math.abs(e.from.log - log), Math.abs(e.to.log - log));
    // the epochs of a name: of flight logs, and of this log (a bench run of its own values)
    const epochsOf = (name, p) => R.epochs.filter(e => e.name === name && e.profile === p && (!e.bench || e.logs.includes(log)));
    const boundOf = (name, p) => {
        let lo = null, hi = null;
        for (const i of items) if (i.name === name && i.profile === p && (i.kind === 'lower' || i.kind === 'upper' || i.kind === 'range')) {
            if (i.lo != null) lo = lo == null ? i.lo : Math.max(lo, i.lo);
            if (i.hi != null) hi = hi == null ? i.hi : Math.min(hi, i.hi);
        }
        return { lo, hi };
    };
    const candOf = (name, p) => { const c = items.filter(i => i.name === name && i.profile === p && i.kind === 'candidates'); return c.length ? [...new Set(c.flatMap(i => i.candidates))] : null; };
    // the candidates of the other logs, when they agree (the same list in each log)
    const candAll = (name, p) => { const c = R.items.filter(i => i.name === name && i.profile === p && i.kind === 'candidates' && !i.bench).map(i => i.candidates.slice().sort().join('|'));
        return c.length && c.every(x => x === c[0]) ? c[0].split('|') : null; };
    const fits = (v, name, p) => { const b = boundOf(name, p), c = candOf(name, p);
        return typeof v !== 'number' ? !c || c.some(x => same(x, v)) : (b.lo == null || v >= b.lo - 1e-9) && (b.hi == null || v <= b.hi + 1e-9); };
    const valueOf = (e) => e.effective ? e.estimate : e.value;
    // 1-2: the CLI dump, the epoch of this log, an epoch around this log -> { v, source, reason, flag } or null
    const lookup = (name, p) => {
        const s = sec(p), cv = s ? s[name] : undefined;
        if (cv !== undefined) {
            const prods = Object.keys(PRODUCTS).filter(e => PRODUCTS[e].includes(name));
            if (cmp.every(x => !((x.name === name || prods.includes(x.name)) && x.profile === p && x.logs.includes(log)) || x.agree) && fits(cv, name, p)) return { v: cv, source: 'CLI dump' };
        }
        const eps = epochsOf(name, p), here = eps.filter(e => e.logs.includes(log)), calc = here.filter(e => e.source !== 'log header'), mine = calc.length ? calc : here;
        if (mine.length) {
            const its = items.filter(i => i.name === name && i.profile === p && (i.kind === 'value' || i.kind === 'effect')), big = its.reduce((a, b) => !a || b.n > a.n ? b : a, null);
            const ep = !big || mine.length === 1 ? mine[0] : typeof big.value === 'string' ? mine.find(e => e.value === big.value) || mine[0]
                : mine.reduce((a, b) => Math.abs(num(b.estimate) - num(big.estimate)) < Math.abs(num(a.estimate) - num(big.estimate)) ? b : a);
            return { v: valueOf(ep), source: ep.source, reason: mine.length > 1 ? TEXT.inLog(name, log, ep.value) : null,
                flag: R.flags.find(f => f.name === name && f.profile === p && f.logs.includes(log) && same(f.value, ep.value)) };
        }
        const around = eps.find(e => e.from.log < log && e.to.log > log && fits(e.value, name, p));
        return around ? { v: valueOf(around), source: around.source, reason: TEXT.between(name, log, around.logs) } : null;
    };
    const direct = (name, p) => { const x = lookup(name, p); if (!x) return; if (x.flag) cfg.flags.push(x.flag); set(name, p, x.v, x.source, x.reason); };
    // 4-7: the nearest epoch, a bound, candidates, no effect in this log
    const fallback = (name, p) => {
        const near = epochsOf(name, p).filter(e => fits(e.value, name, p)).sort((a, b) => dist(a) - dist(b))[0];
        if (near) return set(name, p, valueOf(near), near.source, TEXT.nearest(name, log, near.logs));
        const b = boundOf(name, p), def = cliDefault(name);
        if ((b.lo != null || b.hi != null) && typeof def === 'number') {
            const ok = (b.lo == null || def >= b.lo) && (b.hi == null || def <= b.hi), v = ok ? def : b.lo != null && def < b.lo ? Math.ceil(b.lo) : Math.floor(b.hi);
            return set(name, p, v, ok ? 'default value' : `calculated from the log: ${GP.METHOD[name] || 'a bound'}`, TEXT.bound(name, b.lo, b.hi, v, ok));
        }
        const c = candOf(name, p) || candAll(name, p);
        if (c) {
            const V0 = run.vbat ? run.vbat[0] : 0, electric = name === 'gov_mode' && c.includes('ELECTRIC') && (run.hasCurrent || V0 > RULES.electricV);
            const v = c.some(x => same(x, def)) ? def : electric ? 'ELECTRIC' : name === 'gov_mode' ? null : c[0];
            if (v !== null) return set(name, p, v, 'default value', TEXT.candidates(name, c, v, electric && v === 'ELECTRIC' && !same(v, def) ? TEXT.electric(r(V0, 1)) : null));
        }
        if (LIMITS.includes(name) && !items.some(i => i.name === name && i.profile === p)) return set(name, p, def, 'default value', TEXT.limit(name, def));
        const only = name === 'gov_recovery_time' && val(0).gov_auto_throttle > 0 ? [3, 7, 8] : ONLY_IN[name] || (p && name !== 'gov_headspeed' ? PID_STATES : null);
        if (st && only && only.every(s => !hasIn(p, s))) return set(name, p, def, 'default value', TEXT.stateOnly(name, only, def, p), only);
    };
    // the largest |govD| in ACTIVE of PID profile p, null without govD or ACTIVE
    const gD = (p) => { if (!run.govD || !st) return null; let m = null; for (let i = 0; i < run.n; i++) if (st[i] === 4 && lab[i] === p) { const a = Math.abs(run.govD[i]); if (m === null || a > m) m = a; } return m; };

    for (const name of GP.GLOBAL) direct(name, 0);
    for (const p of profiles) for (const name of GP.PROFILE) direct(name, p);
    // 3: the gains from the products
    for (const p of profiles) {
        const known = {}, prods = {};
        for (const g of GAINS) if (isSet(g, p)) known[g] = val(p)[g];
        for (const e of Object.keys(PRODUCTS)) { const x = lookup(e, p); if (x) prods[e] = x.v; }
        const cand = (g) => [...new Set([...epochsOf(g, p).sort((a, b) => dist(a) - dist(b)).map(e => e.value), ...profiles.filter(q => q !== p).map(q => val(q)[g]),
            ...R.epochs.filter(e => e.name === g && !e.bench).map(e => e.value), ...(cli ? Object.values(cli.profiles || {}).map(s => s[g]) : []), cliDefault(g)].filter(x => typeof x === 'number' && x > 0))];
        const x = decompose(known, prods, { gov_gain: cand('gov_gain'), gov_f_gain: cand('gov_f_gain') });
        if (!x) continue;
        const added = GAINS.filter(g => known[g] === undefined && x.values[g] !== undefined);
        for (const g of added) set(g, p, x.values[g], 'calculated from the log: values that keep the products of the governor gains');
        cfg.assumptions.push({ name: 'gov_gain', profile: p, value: x.values.gov_gain, states: null, products: prods, err: r(x.err, 5),
            reason: TEXT.decomposed(p, added.map(g => `"${g}" ${x.values[g]}`).join(', ').replace(/, ([^,]+)$/, ' and $1')) });
    }
    for (const name of GP.GLOBAL) if (!isSet(name, 0)) fallback(name, 0);
    for (const p of profiles) for (const name of GP.PROFILE) if (!isSet(name, p)) fallback(name, p);
    // the D-term below the log resolution: the value of another PID profile of this log with the same gov_gain, else 0; the
    // tail torque assist; the minimum throttle floor
    for (const p of profiles) {
        const m = gD(p), q = profiles.find(o => o !== p && isSet('gov_d_gain', o) && val(o).gov_gain === val(p).gov_gain && srcOf(o).gov_d_gain !== 'default value');
        if (!isSet('gov_d_gain', p) && m != null && m <= RULES.dNegligible) {
            if (q) set('gov_d_gain', p, val(q).gov_d_gain, srcOf(q).gov_d_gain, TEXT.dOther(p, m, q, val(q).gov_d_gain));
            else set('gov_d_gain', p, 0, 'calculated from the log: the D-term of the governor', TEXT.dZero(p, m));
        }
        if (!isSet('gov_tta_gain', p)) set('gov_tta_gain', p, 0, 'default value', TEXT.tta);
        if (!isSet('gov_use_dyn_min_throttle', p) && !items.some(i => i.name === 'gov_min_throttle' && i.profile === p && i.kind === 'value')) set('gov_use_dyn_min_throttle', p, 'OFF', 'default value', TEXT.noFloor);
        if (!isSet('gov_dyn_min_throttle', p) && same(val(p).gov_use_dyn_min_throttle, 'OFF')) set('gov_dyn_min_throttle', p, cliDefault('gov_dyn_min_throttle'), 'default value', TEXT.dynOff(cliDefault('gov_dyn_min_throttle')));
    }
    // no D-term effect: each PID profile has K Kd 0, no ACTIVE, or a logged D-term of at most RULES.dNegligible
    if (profiles.every(p => val(p).gov_d_gain === 0 || run.govD && st && (gD(p) === null || gD(p) <= RULES.dNegligible))) {
        const dv = (n) => cliDefault(n);
        if (!isSet('gov_d_filter', 0)) set('gov_d_filter', 0, dv('gov_d_filter'), 'default value', TEXT.dOff('gov_d_filter', dv('gov_d_filter')));
        for (const p of profiles) if (!isSet('gov_d_limit', p)) set('gov_d_limit', p, dv('gov_d_limit'), 'default value', TEXT.dOff('gov_d_limit', dv('gov_d_limit')));
    }
    // the voltage compensation: "inactive" (motor[0] = govSum) simulates as OFF; "active" proves the voltage source ADC
    for (const p of profiles) {
        const v = val(p);
        if (same(v.gov_use_voltage_comp, 'inactive')) { v.gov_use_voltage_comp = 'OFF'; cfg.assumptions.push({ name: 'gov_use_voltage_comp', profile: p, value: 'OFF', reason: TEXT.vcompOff, states: null }); }
        else if (same(v.gov_use_voltage_comp, 'active')) {
            v.gov_use_voltage_comp = 'ON';
            if (!(cli && cli.global.battery_meter) && cfg.voltageSource !== 'ADC') { cfg.voltageSource = 'ADC'; cfg.assumptions.push({ name: 'battery_meter', profile: 0, value: 'ADC', reason: TEXT.vcompAdc, states: null }); }
        }
    }
    // the values outside the governor list: the CLI dump, else the rules
    const g = cli ? cli.global : {}, extra = {};
    cfg.gear = Array.isArray(g.main_rotor_gear_ratio) ? g.main_rotor_gear_ratio.map(Number) : null;
    if (g.battery_meter !== undefined) cfg.voltageSource = g.battery_meter;
    cfg.cells = typeof g.battery_cell_count === 'number' ? g.battery_cell_count : 0;
    for (const k of ['main_rotor_dir', 'tail_rotor_mode']) if (g[k] !== undefined) { extra[k] = g[k]; cfg.sources[k] = 'CLI dump'; }
    // schema values; a profile without all four flags has no gov_flags
    cfg.global = toSchema(Object.assign({}, cfg.cli.global, extra));
    for (const p of profiles) {
        const s = toSchema(cfg.cli.profiles[p], { gov_flags: 0 });
        if (!Object.keys(FLAG_BITS).every(f => isSet(f, p))) delete s.gov_flags;
        cfg.profiles[p] = pick(s, PROFILE_FIELDS);
    }
    if (extra.tail_rotor_mode === undefined && profiles.some(p => cfg.profiles[p].gov_f_gain !== 0 && cfg.profiles[p].gov_yaw_weight !== 0)) {
        cfg.global.tail_rotor_mode = 0; cfg.sources.tail_rotor_mode = 'default value';
        cfg.assumptions.push({ name: 'tail_rotor_mode', profile: 0, value: 'VARIABLE', reason: TEXT.tailMode, states: null });
    }
    // the names that stay unknown; the governor reads one of them (govRequiredFields with each PID profile): excluded
    const schemaOf = (name) => name === 'gov_bypass_throttle' ? 'gov_bypass_throttle[0]' : FLAG_BITS[name] !== undefined ? 'gov_flags' : RENAME[name] || name;
    const reqG = new Set(), meter = cfg.voltageSource != null ? toSchema({ battery_meter: cfg.voltageSource }).voltage_meter : undefined, perProfile = [];
    const miss = (name, p, used) => { srcOf(p)[name] = 'unknown'; return { name, profile: p, used, reason: used ? TEXT.unknownValue(name, p, log) : null }; };
    for (const p of profiles) {
        const req = new Set(F.govRequiredFields(Object.assign({}, cfg.global, cfg.profiles[p], meter !== undefined ? { voltage_meter: meter } : {})).required);
        req.forEach(n => reqG.add(n));
        for (const name of GP.PROFILE) if (!isSet(name, p)) perProfile.push(miss(name, p, req.has(schemaOf(name))));
    }
    for (const name of GP.GLOBAL) if (!isSet(name, 0)) cfg.unknown.push(miss(name, 0, reqG.has(schemaOf(name))));
    cfg.unknown.push(...perProfile);
    const first = cfg.unknown.find(u => u.used);
    if (first) cfg.excluded = first.reason;
    return cfg;
}
const pick = (o, names) => { const x = {}; for (const k of names) if (own(o, k)) x[k] = o[k]; return x; };

// ---------------------------------------------------------------------------------------------
// simulation
// ---------------------------------------------------------------------------------------------

// scenario values: { global, profiles: { n }, all } (CLI or schema names), or a flat { name: value } (global and every profile)
function overrides(values) {
    if (!values) return { global: {}, profiles: {}, all: {} };
    if (values.global || values.profiles || values.all) return { global: values.global || {}, profiles: values.profiles || {}, all: values.all || {} };
    return { global: values, profiles: {}, all: values };
}

async function run(rec, cfg, o = {}) {
    const t0ms = Date.now(), plant = o.plant || 'recorded', sc = o.scenario || {}, p = o.twin || null;
    if (cfg.excluded) return { log: rec.log, plant, excluded: cfg.excluded };
    // the governor starts in its reset state (OFF): a log or a part of a log (after a logging pause) that starts later than IDLE cannot
    // be simulated from its start (unless the scenario starts the twin at rest)
    const s0 = rec.state ? rec.state[0] : null, mid = !sc.twinStart && (s0 != null ? s0 > 1 : rec.u && rec.u[0] > 0.02 && rec.hs && rec.hs[0] > 0);
    const why = !rec.hs ? TEXT.noHs : !rec.thr ? TEXT.noThr : !rec.coll || !rec.roll || !rec.pitch || !rec.yaw ? TEXT.noMixer : !rec.u && plant === 'recorded' ? TEXT.noMotor
        : mid ? TEXT.midStart(rec, s0) : null;
    if (why) return { log: rec.log, plant, excluded: why };
    if (plant === 'twin' && !p) throw new Error('With "plant: twin", the parameters of the governor model ("o.twin") are necessary.');
    const n = rec.n, L = rec.loopsPerFrame || 1, pidHz = rec.pidHz, rate = rec.rate, time = rec.time, st = rec.state;
    const ev = cfg.changes && cfg.start ? { start: cfg.start, changes: cfg.changes } : profileEvents(rec, null);
    const ov = overrides(sc.values), gl = Object.assign({}, cfg.global, toSchema(ov.global, cfg.global));
    const values = {};
    for (const q of [ev.start, ...ev.changes.map(c => c.profile)]) if (!values[q]) {
        if (!cfg.profiles[q]) return { log: rec.log, plant, excluded: TEXT.profileUnknown(rec.log) };
        const base = cfg.profiles[q], v = Object.assign({}, base);
        Object.assign(v, toSchema(ov.all, v)); Object.assign(v, toSchema(ov.profiles[q], v));
        values[q] = pick(v, PROFILE_FIELDS);
    }
    for (const k of Object.keys(gl)) if (PROFILE_FIELDS.includes(k)) delete gl[k];
    const h = rec.header || {}, vb = rec.vbat, rest = vb ? vb[0] : 0;
    const vScale = sc.ocv > 0 && rest > 0 ? sc.ocv / rest : 1;
    let gov;
    try {
        gov = await F.govCreate({ values: Object.assign({}, gl, values[ev.start]), gear: cfg.gear, pidHz, voltageSource: cfg.voltageSource, cells: cfg.cells || 0,
            restVoltage: sc.ocv > 0 ? sc.ocv : rest, minCell: Array.isArray(h.vbatcellvoltage) ? h.vbatcellvoltage[0] / 100 : undefined, maxCell: Array.isArray(h.vbatcellvoltage) ? h.vbatcellvoltage[2] / 100 : undefined });
        gov.profile(values[ev.start]);
    } catch (e) { return { log: rec.log, plant, excluded: TEXT.govError(rec.log, e.message) }; }
    const gv = gov.values, gearK = gv['main_rotor_gear_ratio[1]'] / gv['main_rotor_gear_ratio[0]'];
    // forced fallbacks and glitches: one flag per sample
    const at = (t) => { let lo = 0, hi = n; while (lo < hi) { const k = (lo + hi) >> 1; if (time[k] < t) lo = k + 1; else hi = k; } return lo; };
    const force = new Uint8Array(n), glitch = new Uint8Array(n), ff = sc.forceFallback === undefined ? 'recorded' : sc.forceFallback;
    if (ff === 'recorded') { if (st) for (let k = 1; k < n; k++) if (st[k] === 6 && st[k - 1] !== 6) force[k] = 1; }
    else for (const t of ff || []) { const k = at(t); if (k < n) force[k] = 1; }
    for (const t of sc.glitches || []) { const k = at(t); if (k < n) glitch[k] = 1; }
    // the twin
    let x = null, dt = 1 / pidHz;
    const inp = { u: 0, coll: 0, cyc: 0, yaw: 0 };
    if (plant === 'twin') {
        const start = sc.twinStart || !(rec.hs[0] > 0);
        // a start from rest: the OCV is the rest voltage less the rest offset vp of the twin (gov_twin: no polarization element)
        x = GT.initState(p, { hs: start ? 0 : rec.hs[0], u: start ? 0 : rec.u ? rec.u[0] : 0, vbat: vb ? vb[0] : null, ibat: rec.ibat ? rec.ibat[0] : null, stopped: start ? true : undefined,
            coll: rec.coll[0], cyc: Math.hypot(rec.roll[0], rec.pitch[0]), yaw: rec.yaw[0], rest: start });
        if (sc.ocv > 0) { const d = (p.voltage ? sc.ocv - (start && p.vp > 0 ? p.vp : 0) : x.V0 * vScale) - x.V0; x.V0 += d; x.V += d; x.vLog += d; }
    }
    const twinV = plant === 'twin' && p.voltage;
    // per-sample results
    const hsS = new Float32Array(n), tgt = new Float32Array(n), req = new Float32Array(n), uS = new Float32Array(n), iS = new Float32Array(n), stS = new Uint8Array(n), prof = new Uint8Array(n);
    const vS = x && p.voltage ? new Float32Array(n) : null, iB = x && p.current ? new Float32Array(n) : null;
    const s = { rawMotorRpm: 0, batteryVoltage: 0, throttleCommand: 0, throttleOff: true, armed: true, mixer: [0, 0, 0, 0], timeS: 0, govFallback: false };
    const R = rec.roll, P = rec.pitch, Y = rec.yaw, C = rec.coll, T = rec.thr, H = rec.hs, A = rec.armed, t0 = rec.t0Us != null ? rec.t0Us / 1e6 : 10;
    let vLast = vb && rest === rest ? rest * vScale : 0;
    const input = (k) => {
        s.armed = !A || A[k] === 1; s.throttleCommand = T[k]; s.throttleOff = !(T[k] > 0);
        s.mixer[0] = R[k]; s.mixer[1] = P[k]; s.mixer[2] = Y[k]; s.mixer[3] = C[k];
        if (vb && vb[k] === vb[k]) vLast = vb[k] * vScale;   // a sample that is not finite: the last value
        s.batteryVoltage = twinV ? x.vLog : vLast;
        s.rawMotorRpm = x ? x.H * gearK : H[k] * gearK;
        if (x) { inp.coll = C[k]; inp.cyc = Math.sqrt(R[k] * R[k] + P[k] * P[k]); inp.yaw = Y[k]; }
    };
    let cur = ev.start, ei = 0, g = null, forced = 0, glitches = 0;
    const visited = new Uint8Array(7 * 10);
    // the loops armed before sample 0 (gov_data preroll), with the inputs of sample 0
    const pre = rec.preroll || 0;
    if (pre) { input(0); for (let q = 0; q < pre; q++) { s.timeS = t0 + time[0] - (pre + L - q) / pidHz; g = gov.step(s); } }
    let prevT = t0 + time[0] - L / pidHz;
    for (let k = 0; k < n; k++) {
        while (ei < ev.changes.length && ev.changes[ei].k <= k) { cur = ev.changes[ei++].profile; gov.profile(values[cur]); }
        input(k);
        const tk = t0 + time[k];
        for (let q = 0; q < L; q++) {
            s.timeS = prevT + (tk - prevT) * (q + 1) / L;
            if (x) { s.rawMotorRpm = x.H * gearK; if (twinV) s.batteryVoltage = x.vLog; }
            if (glitch[k] && q === 0) { s.rawMotorRpm = RULES.glitch * values[cur].gov_headspeed * gearK; glitches++; }
            s.govFallback = force[k] === 1 && q === L - 1;
            g = gov.step(s);
            if (x) { inp.u = g.throttle; GT.step(x, inp, p, dt); }
        }
        if (force[k]) forced++;
        prevT = tk;
        hsS[k] = x ? x.hsLog : H[k]; tgt[k] = g.targetHS; req[k] = g.requestHS; uS[k] = g.throttle; iS[k] = g.I; stS[k] = g.state; prof[k] = cur;
        if (vS) vS[k] = x.vLog;
        if (iB) iB[k] = x.iLog;
        visited[cur * 10 + g.state] = 1;
    }
    const limits = {};
    for (const q of Object.keys(values)) limits[q] = { maxThrottle: values[q].gov_max_throttle / 100, iLimit: values[q].gov_i_limit / 100 };
    const res = { log: rec.log, segment: rec.segment || 0, plant, frames: n, seconds: r(n / rate, 2), loopsPerFrame: L, preroll: pre, changes: ev.changes.length, forced, glitches,
        metrics: metrics({ rate, hs: hsS, target: tgt, request: req, u: uS, state: stS, I: iS, profile: prof, time }, { limits }),
        compare: compare(rec, { hs: hsS, u: uS, state: stS, vbat: vS }, plant), parity: plant === 'recorded' ? parity(rec, uS, stS, prof, ev) : null,
        assumedInEffect: (cfg.assumptions || []).filter(a => a.states && a.states.some(v => a.profile ? visited[a.profile * 10 + v] : [1, 2, 3, 4, 5, 6].some(q => visited[q * 10 + v]))).map(a => ({ name: a.name, profile: a.profile, value: a.value, reason: a.reason })),
        notes: [...(cfg.notes || []), ...gov.notes], assumed: gov.assumed, trace: null, ms: 0 };
    if (o.record !== false) res.trace = trace(rec, { hs: hsS, target: tgt, u: uS, I: iS, vbat: vS || (vb ? vb : null), ibat: iB, state: stS, profile: prof }, o.record && o.record.points || RULES.points, vS ? 1 : vScale);
    res.ms = Date.now() - t0ms;
    return res;
}

// decimated traces: every stride-th sample; i is the sample index (the measured values of the run at the same samples)
function trace(rec, a, points, vk) {
    const n = rec.n, stride = Math.max(1, Math.ceil(n / points)), m = Math.ceil(n / stride), out = { stride, i: new Int32Array(m), t: new Float64Array(m) };
    for (const k of Object.keys(a)) out[k] = a[k] ? (k === 'state' || k === 'profile' ? new Uint8Array(m) : new Float32Array(m)) : null;
    for (let j = 0, i = 0; j < m; j++, i += stride) {
        out.i[j] = i; out.t[j] = rec.time[i];
        for (const k of Object.keys(a)) if (a[k]) out[k][j] = k === 'vbat' && a[k] === rec.vbat ? a[k][i] * vk : a[k][i];
    }
    return out;
}

// the simulation against the log: state agreement (all samples), u RMS in ACTIVE (both), HS RMS in % of the logged target, Vbat RMS
function compare(rec, a, plant) {
    const n = rec.n, st = rec.state, U = rec.u, T = rec.target;
    let agree = 0, ns = 0, nu = 0, su = 0, mu = 0, nh = 0, sh = 0, nv = 0, sv = 0;
    for (let k = 0; k < n; k++) {
        if (st) { ns++; if (st[k] === a.state[k]) agree++; }
        if (!st || st[k] !== 4 || a.state[k] !== 4) continue;
        if (U) { const d = a.u[k] - U[k]; su += d * d; nu++; if (Math.abs(d) > mu) mu = Math.abs(d); }
        if (plant === 'twin' && T && T[k] > 0) { const d = (a.hs[k] - rec.hs[k]) / T[k] * 100; sh += d * d; nh++; }
        if (a.vbat && rec.vbat) { const d = a.vbat[k] - rec.vbat[k]; sv += d * d; nv++; }
    }
    return { stateAgreement: ns ? r(agree / ns, 5) : null, activeFrames: nu, uRms: nu ? r(Math.sqrt(su / nu), 5) : null, uMax: nu ? r(mu, 4) : null,
        hsRmsPct: nh ? r(Math.sqrt(sh / nh), 3) : null, vbatRms: nv ? r(Math.sqrt(sv / nv), 3) : null };
}

// SPEC 6.7 parity: the logged state sequence and motor[0] in counts (0.1 %), for the log and for each PID profile segment
function parity(rec, u, stS, prof, ev) {
    const n = rec.n, st = rec.state, U = rec.u, segs = [], all = [];
    if (!st || !U) return null;
    let agree = 0, seg = null;
    const cuts = new Set(ev.changes.map(c => c.k));
    for (let k = 0; k < n; k++) {
        if (!seg || cuts.has(k)) segs.push(seg = { fromS: r(rec.time[k], 3), profile: prof[k], frames: 0, agree: 0, thr: [] });
        seg.frames++;
        if (st[k] === stS[k]) { agree++; seg.agree++; }
        if (st[k] === 4 && stS[k] === 4) { const d = Math.round(u[k] * 1000) - Math.round(U[k] * 1000); all.push(d); seg.thr.push(d); }
    }
    const thr = stats(all), state = agree / n;
    return { stateAgreement: r(state, 5), throttle: thr, gate: { pass: state >= RULES.parity.state && thr.n > 0 && thr.rms <= RULES.parity.thrRms, state: state >= RULES.parity.state, throttle: thr.n > 0 && thr.rms <= RULES.parity.thrRms },
        segments: segs.map(q => { const t = stats(q.thr); return { fromS: q.fromS, profile: q.profile, frames: q.frames, stateAgreement: r(q.agree / q.frames, 5), activeFrames: t.n, throttleRms: t.n ? t.rms : null, throttleMax: t.n ? t.maxAbs : null }; }) };
}
function stats(a) {
    if (!a.length) return { n: 0 };
    let q = 0, m = 0; for (const v of a) { q += v * v; m = Math.max(m, Math.abs(v)); }
    const s = Float64Array.from(a).sort();
    return { n: a.length, rms: r(Math.sqrt(q / a.length), 2), maxAbs: m, p01: s[Math.floor(s.length * 0.01)], p50: s[s.length >> 1], p99: s[Math.floor(s.length * 0.99)] };
}

// ---------------------------------------------------------------------------------------------
// metrics (SPEC section 7), for each PID profile in ACTIVE
// ---------------------------------------------------------------------------------------------

function metrics(x, o = {}) {
    const n = x.state.length, rate = x.rate, Q = RULES, st = x.state, hs = x.hs, T = x.target, U = x.u, I = x.I, P = x.profile, req = x.request || x.target;
    // u less its zero-phase low-pass at hfHz (forward-backward first order)
    const a = 1 - Math.exp(-2 * Math.PI * Q.hfHz / rate), lp = new Float64Array(n);
    if (n) { lp[0] = U[0]; for (let k = 1; k < n; k++) lp[k] = lp[k - 1] + a * (U[k] - lp[k - 1]); for (let k = n - 2; k >= 0; k--) lp[k] = lp[k + 1] + a * (lp[k] - lp[k + 1]); }
    const W = Math.max(1, Math.round(Q.windowS * rate)), acc = {};
    const get = (p) => acc[p] || (acc[p] = { frames: 0, e2: 0, hf2: 0, sat: 0, iLim: 0, wDroop: [], wOver: [], spool: [], events: [], wn: 0, wmin: Infinity, wmax: -Infinity });
    for (let k = 0; k < n; k++) {
        const p = P[k];
        if (st[k] !== 4 || !(T[k] > 0)) { if (acc[p]) acc[p].wn = 0; continue; }
        const A = get(p), lim = o.limits && o.limits[p] || {}, e = (hs[k] - T[k]) / T[k] * 100, hf = U[k] - lp[k];
        A.frames++; A.e2 += e * e; A.hf2 += hf * hf;
        const sat = lim.maxThrottle != null && U[k] >= lim.maxThrottle - Q.satEps;
        if (sat) A.sat++;
        if (!sat && I && lim.iLimit != null && Math.abs(I[k]) >= lim.iLimit - Q.iLimitEps) A.iLim++;
        // 1-s windows of consecutive ACTIVE samples of this profile
        if (A.wn === 0 || P[k - 1] !== p) { A.wn = 0; A.wmin = Infinity; A.wmax = -Infinity; }
        A.wn++; if (e < A.wmin) A.wmin = e; if (e > A.wmax) A.wmax = e;
        if (A.wn === W) { A.wDroop.push(Math.max(0, -A.wmin)); A.wOver.push(Math.max(0, A.wmax)); A.wn = 0; }
    }
    const events = [];
    for (let k = 1; k < n; k++) {
        // spool-up overshoot: the peak after a SPOOLUP exit to ACTIVE, while the request stays
        if (st[k] === 4 && st[k - 1] === 2) {
            const q0 = req[k], end = Math.min(n, k + Math.round(Q.spoolS * rate));
            let peak = 0, j = k; for (; j < end && st[j] === 4 && req[j] === q0 && P[j] === P[k]; j++) if (hs[j] > peak) peak = hs[j];
            if (q0 > 0) get(P[k]).spool.push({ atS: r(x.time ? x.time[k] : k / rate, 3), overshootPct: r((peak / q0 - 1) * 100, 2), full: j === end });
        }
        // a FALLBACK entry: the G droop (minimum HS / request) and the recovery time to within recoverTol
        if (st[k] === 6 && st[k - 1] !== 6) {
            const q0 = req[k] > 0 ? req[k] : req[k - 1], end = Math.min(n, k + Math.round(Q.eventS * rate));
            let jm = k; for (let j = k; j < end; j++) if (hs[j] < hs[jm]) jm = j;
            let jr = -1; for (let j = jm; j < end; j++) if (hs[j] >= (1 - Q.recoverTol) * q0) { jr = j; break; }
            const e = { atS: r(x.time ? x.time[k] : k / rate, 3), profile: P[k], request: q0, minRatio: q0 > 0 ? r(hs[jm] / q0, 4) : null, minAtS: r((jm - k) / rate, 3), recoveryS: jr >= 0 ? r((jr - k) / rate, 3) : null, windowS: Q.eventS };
            events.push(e); get(P[k]).events.push(e);
        }
    }
    const worst = (w) => { if (!w.length) return null; const s = w.slice().sort((a, b) => b - a), m = Math.max(1, Math.ceil(Q.worst * s.length)); let t = 0; for (let i = 0; i < m; i++) t += s[i]; return r(t / m, 3); };
    const profiles = {};
    for (const [p, A] of Object.entries(acc)) {
        if (!A.frames && !A.spool.length && !A.events.length) continue;
        const sp = A.spool.map(v => v.overshootPct).filter(v => v != null), ev = A.events;
        profiles[p] = { frames: A.frames, seconds: r(A.frames / rate, 2), eRms: A.frames ? r(Math.sqrt(A.e2 / A.frames), 3) : null, droop95: worst(A.wDroop), over95: worst(A.wOver), windows: A.wDroop.length,
            thrHF: A.frames ? r(Math.sqrt(A.hf2 / A.frames) * 100, 3) : null, satShare: A.frames ? r(A.sat / A.frames, 5) : null, satS: r(A.sat / rate, 3),
            iLimitOutsideSat: A.frames ? r(A.iLim / A.frames, 5) : null, iLimitOutsideSatS: r(A.iLim / rate, 3),
            spoolOvershoot: sp.length ? Math.max(...sp) : null, spoolups: A.spool,
            gDroop: ev.length ? Math.min(...ev.map(e => e.minRatio)) : null, recoveryS: ev.length ? (ev.some(e => e.recoveryS === null) ? null : Math.max(...ev.map(e => e.recoveryS))) : null, fallbacks: ev.length };
    }
    return { profiles, events };
}

// the metrics of the log itself (a baseline): the logged hs, govTarget, govRequest, motor[0], states and govI, with the PID profiles
// of cfg (start, changes) and their limits; null without the governor fields
function logMetrics(rec, cfg) {
    if (!rec.state || !rec.u || !rec.target || !rec.hs) return null;
    const n = rec.n, prof = new Uint8Array(n), ev = cfg.changes && cfg.start ? { start: cfg.start, changes: cfg.changes } : profileEvents(rec, null), limits = {};
    let cur = ev.start, ei = 0;
    for (let k = 0; k < n; k++) { while (ei < ev.changes.length && ev.changes[ei].k <= k) cur = ev.changes[ei++].profile; prof[k] = cur; }
    for (const [q, v] of Object.entries(cfg.profiles || {})) limits[q] = { maxThrottle: v.gov_max_throttle / 100, iLimit: v.gov_i_limit / 100 };
    return metrics({ rate: rec.rate, hs: rec.hs, target: rec.target, request: rec.request, u: rec.u, state: rec.state, I: rec.govI, profile: prof, time: rec.time }, { limits });
}

module.exports = { RULES, TEXT, STATES, PRODUCTS, configOf, run, metrics, logMetrics, decompose, toSchema, profileEvents, cliDefault, keyOf };
if (require.main !== module) return;

// node tools/autotune/gov_sim.cjs <data dir> [--logs 10,11] [--cli <dump>] [--disarm <disarm json>] [--twin <params json>] [--bench]: the parity
// (and with --twin the closed loop) of each flight run of a dev data directory (analysis/governor-20261014/data/<craft>)
(async () => {
    const fs = require('fs'), path = require('path'), GD = require('./gov_data.cjs');
    const args = process.argv.slice(2), opt = (k) => { const j = args.indexOf(k); return j >= 0 ? args.splice(j, 2)[1] : null; };
    const logs = opt('--logs'), cliFile = opt('--cli'), disarm = opt('--disarm'), twinFile = opt('--twin'), dir = args[0];
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')), events = {};
    if (disarm) { const d = JSON.parse(fs.readFileSync(disarm, 'utf8')); for (const s of meta.segments) events[s.log] = (d.us[s.log] || []).map(us => ({ t: (us - s.timeStartUs) / 1e6 + (s.fromS || 0), name: 'DISARM' })); }
    const all = GD.load(dir, { bench: true, events }), cli = cliFile ? fs.readFileSync(cliFile, 'utf8') : null;
    const rec = GP.recover(all, { cli }), cfgs = configOf(all, rec, { cli }), twin = twinFile ? JSON.parse(fs.readFileSync(twinFile, 'utf8')) : null;
    for (const run0 of all.filter(q => (q.class === 'flight' || args.includes('--bench')) && (!logs || logs.split(',').map(Number).includes(q.log)))) {
        const cfg = cfgs[keyOf(run0)], res = await run(run0, cfg, { record: false });
        if (res.excluded) { console.log(`log ${run0.log}: EXCLUDED ${res.excluded}`); continue; }
        const pa = res.parity;
        console.log(`log ${run0.log}: state ${pa.stateAgreement}, ACTIVE throttle RMS ${pa.throttle.rms} max ${pa.throttle.maxAbs} n ${pa.throttle.n}, pre-roll ${res.preroll}, profiles ${res.changes}, forced ${res.forced}, ${res.ms} ms -> ${pa.gate.pass ? 'PASS' : 'MISS'}; assumptions ${cfg.assumptions.length}`);
        if (twin) { const c = await run(run0, cfg, { plant: 'twin', twin: GT.copy(twin), record: false }); console.log(`  twin: ${JSON.stringify(c.compare)} ${c.ms} ms`); }
    }
})().catch((e) => { console.error(e); process.exit(1); });
