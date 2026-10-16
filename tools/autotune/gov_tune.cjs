'use strict';

/**
 * Governor autotune: rows for each of the 42 governor CLI names (docs/GOVERNOR_AUTOTUNE.md sections 5 and 7;
 * analysis/governor-20261014/critique.md wins on conflicts). This file has the parts that do not need the identified twin
 * (gov_twin, gov_fit) or the closed-loop simulator (gov_sim):
 *   - the registry of the 42 CLI names, their firmware ranges, defaults, firmware/schema.cjs fields and UI families, and the
 *     related rows of section 5;
 *   - the value at this time of each name for each PID profile, with its source and the "values possibly not current" flags;
 *   - the rule rows: numbers from the flight logs, a rule id (a key of RULES) and STE text;
 *   - the conversion of a row to a recommendation of advice.exportScript.
 * The model families (MODEL: gains, precomp, limits, filters, power, spoolup, tracking, fallback, maxThrottle, bypass) give
 * 'pending-model' rows here. A later phase replaces them: tune(runs, { families: { gains(ctx) { return rows; } } }) or MODEL.gains = ...
 * Each family function gets ctx (section "tune") and returns rows made with row(ctx, name, profile, {...}).
 *
 *   REGISTRY / REG      [{ name, scope, type, default, range, unit, family, field, bit, values }] the 42 names (gov_params NAMES)
 *   RELATED             the related, non-governor rows (battery_meter, battery_cell_count, feature GOVERNOR, freq_input_pull/edge/minhz,
 *                       blackbox_log_esc, blackbox_log_battery, debug_mode)
 *   FAMILIES            { key: STE label } the groups of the parameter table
 *   cliValue(name, v)   the CLI text of a value ('ON'/'OFF', an enum name, '0,0,...' for gov_bypass_throttle, an integer), or null
 *                       when the firmware does not accept it
 *   currentValues(runs, recovered, { cli })  { profiles, byName: { name: { [p]: { value, source, se, lo, hi, candidates, effect,
 *                       conflict, reason, logs, from, stale } } }, related: { name: {...} }, cli }. p is 0 for a global name. Source:
 *                       "CLI dump" (with its section), "log header, PID profile N at the start of the log" or "calculated from the log:
 *                       <method>" (gov_params), else "unknown"
 *   measure(ctx)        the numbers of the rule rows (state census, FALLBACK, BAILOUT, spool-up, throttle limits, headroom, drift,
 *                       RPM signal, floor, term limits, rest voltage)
 *   tune(runs, { recovered, cli, model, sim, families }) -> { status, rows, recommendations, coverage, parameters, current, measures,
 *                       notes, rules, families }. runs: the runs of gov_data.cjs of one file, bench runs too (gov_params uses them as
 *                       configuration evidence only); the rows use the flight runs only (CLAUDE.md)
 *   toRecommendation(row, ctx)  a row as an advice.exportScript recommendation: severity 'action' with CLI text for a change, 'check'
 *                       for a check, 'info' for a row that the pilot must know (row.inform), no CLI for the others
 *
 * Row: { id, name, scope ('global' | 'profile' | 'related'), profile (1-6, 0 = PID profile unknown, null for a global or related name),
 *   family, topic, title, current { value, source, ... }, status ('change' | 'keep' | 'check' | 'not-applicable' | 'not-recorded' |
 *   'pending-model'), to, evidence [{ text, value, unit, lo, hi, n, se, log, t0, t1 }], rule (a key of RULES), method ('firmware' | 'rule' |
 *   'data' | 'model' | 'simulation'), stale (null or { reasons, text, source, flags }), cli, text, reason, record, inform }
 * A name can have more than one row: a rule row, a model row and event rows (one for each FALLBACK). coverage asserts one row or more
 * for each of the 42 names (and each PID profile of a profile name).
 * Log numbers: run.log is the index of the log in the file (0 = the first log). The texts give log + 1, as the app does. Times: s on
 * the time of the items of gov_params (fromS + time).
 */

const GP = require('./gov_params.cjs');
const GD = require('./gov_data.cjs');
const optional = (load) => { try { return load(); } catch (e) { return null; } };
// check G21 of the analysis (health_gov.cjs): one detector of the sudden changes of the headspeed signal and one test against the
// time at the throttle maximum for the analysis, the rule rows here and the maximum throttle test of gov_scenarios.cjs
const HG = require('./health_gov.cjs');

// Thresholds. id: the rule number in the texts and in the CLI file ("Result of check GT9"). source: the source in the words of the
// pilot (advice.cjs RULES.source: no file name or line). The developer references are in the comments.
const RULES = {
    minProfileS: 2,       // s of ACTIVE in the flight logs: a PID profile with less time gets no rows of its own (except its control limits)
    pauseS: 0.5,          // s between two samples: a logging pause
    mode: { id: 'GT1', source: 'firmware 4.6.0',                                      // flight_governor.c:1434-1459, 1619-1638 (critique M3)
        text: 'The governor model is for the governor mode ELECTRIC with a fast RPM source. The other modes do not use all governor parameters.' },
    throttleType: { id: 'GT2', low: 0.333, high: 0.666, source: 'firmware 4.6.0',    // flight_governor.c:429-461
        text: 'The throttle type sets the use of the throttle stick by the governor.' },
    feature: { id: 'GT3', bit: 26, source: 'firmware 4.6.0',                         // init.c:798-800 at 118e912 (critique M1), header features bit 26
        text: 'The governor operates only with the feature GOVERNOR on.' },
    census: { id: 'GT4', source: 'firmware 4.6.0',                                   // flight_governor.c:389-392, 449-461, 1157-1161 (critique C5, C7)
        text: 'With the throttle type FUNCTION, the middle switch position gives AUTOROTATION when "gov_autorotation_timeout" is more than 0.' },
    bailout: { id: 'GT5', lowShare: 0.5, afterS: 6, source: 'toolkit rule, no flight test', // log_evidence 6.3, critique M4 and C9
        get text() { return `A BAILOUT that starts at less than ${pct(this.lowShare, 0)} % of the headspeed target is from a stopped or slow rotor.`; } },
    // exitShare, exitHs: the exit of SPOOLUP by the firmware (u > 0.95 max or H > 0.99 R, flight_governor.c; firmware_parameters.md 6.1); exitTol: 2 counts of 0.1 %
    spool: { id: 'GT6', overshoot: 0.02, windowS: 3, minS: 0.5, lastS: 1, exitShare: 0.95, exitHs: 0.99, exitTol: 0.002, source: 'toolkit rule, no flight test', // GOVERNOR_AUTOTUNE.md 5 (spoolOvershoot), critique C6, M17
        get text() { return `After SPOOLUP, the headspeed must not be more than the target by more than ${pct(this.overshoot, 0)} %.`; } },
    // minU: a motor output below this is off, never a maximum (gov_max_throttle is 10 % or more: settings.c)
    saturation: { id: 'GT7', near: 0.005, gapS: 0.05, lowShare: 0.5, minU: 0.05, source: 'toolkit rule, no flight test', // CLAUDE.md "Control limits", critique C9
        get text() { return `Each period with the throttle at its maximum is a result to examine. A period with the headspeed at less than ${pct(this.lowShare, 0)} % of the target is an ESC acceleration limit.`; } },
    // q: the throttle quantile against 1 - reserve; dvQ: the quantile of throttle x voltage; vbQ: the low quantile of the battery voltage
    headroom: { id: 'GT8', reserve: 0.15, q: 0.95, dvQ: 0.99, vbQ: 0.01, stride: 10, vbatLagS: 0.05, source: 'Rotorflight documentation, a governor throttle of 75 % to 85 %, and a toolkit rule for a reserve of 15 %', // FlyRotor, GOVERNOR_AUTOTUNE.md RULES.headroom, critique C11
        get text() { return `In ACTIVE flight, the throttle must be ${pct(1 - this.reserve, 0)} % or less for ${pct(this.q, 0)} % of the time. This gives a reserve of ${pct(this.reserve, 0)} %.`; } },
    // the drift: 2-s blocks of ACTIVE flight under uMax x gov_max_throttle at a moderate load (block means), the regression
    // throttle = a + b V + c1 |collective| + c2 cyclic + c3 |yaw| per flight and PID profile, drift = b (V end - V start)
    vcomp: { id: 'GT9', blockS: 2, coll: [0, 0.4], cyc: 0.4, yaw: 0.5, uMax: 0.98, minBlocks: 15, minDv: 0.5, endBlocks: 5, valid: 0.9, source: 'firmware 4.6.0', // flight_governor.c:490-509, 1556 (critique C10, M10)
        text: 'Voltage compensation operates only with the voltage source ADC ("battery_meter") and the mode ELECTRIC.' },
    cells: { id: 'GT10', restS: 1, auto: [1, 2, 3, 4, 5, 6, 7, 8, 10, 12], source: 'firmware 4.6.0', // battery.c:315-336 (health_power.autoCells; auto: its list when health_power is absent)
        text: 'The value 0 of "battery_cell_count" tells the firmware to find the cell count from the battery voltage.' },
    // govInitTTA does not read tail_rotor_mode: the assist operates in DIRECT and ELECTRIC with gov_tta_gain and gov_tta_limit more than 0
    tta: { id: 'GT11', source: 'firmware 4.6.0',                                      // flight_governor.c:511-534, 1523-1541
        text: 'The tail torque assist operates in the modes DIRECT and ELECTRIC when "gov_tta_gain" and "gov_tta_limit" are more than 0. It increases the headspeed with yaw.' },
    // kmotHz, kmotU, kmotShare: the update of the motor constant (0.05 Hz, throttle > 0.2, H / Hf > 0.2: flight_governor.c:550-560)
    fallback: { id: 'GT12', preS: 0.4, postS: 5, satU: 0.999, holdS: 0.2, within: 0.01, sag: 0.9, kmotHz: 0.05, kmotU: 0.2, kmotShare: 0.2, glitch: 0.25, glitchWinS: [0.1, 0.02], source: 'firmware 4.6.0', // flight_governor.c:550-606, 979-1010 (critique V3, M6, M11, C12)
        text: 'An error of the RPM signal starts FALLBACK. In FALLBACK, the throttle is "govI" multiplied by (100 - "gov_fallback_drop") / 100.' },
    // the sudden changes of the headspeed signal: the detector and the test of check G21 (health_gov RULE.g21, DEFAULT_RULES.G21:
    // analysis/rpm-spikes, user rule 2026-10-15), in all flight phases of the flight logs with the governor in RECOVERY, ACTIVE or
    // FALLBACK. trial: the gov_max_throttle range of the test for the RPM signal errors at the maximum throttle (GOVERNOR_AUTOTUNE.md 5)
    glitch: { id: 'GT13', trial: [0.95, 0.98], source: 'toolkit rule, no flight test', // log_evidence 6.2, critique C14, analysis/rpm-spikes
        get text() { const P = HG.RULE.g21; return `A sudden change of the headspeed signal is ${P.minStep * 100} % of the target or more in ${P.windowS * 1000} ms, at more than ${P.minRate * 1000} rpm/s. This is not a movement of the rotor (check G21).`; } },
    unlogged: { id: 'GT14', source: 'toolkit rule, no flight test',                   // gov_params flags (critique V4, M7)
        text: 'A value that changes between logs, and that the log does not record, is a result to examine.' },
    // margin: govSum less than the motor output by more than this (counts of 0.1 % and the truncation of govSum); atMin: the motor
    // output at the minimum throttle within this (when voltage compensation can operate, or in LIMIT)
    floor: { id: 'GT15', margin: 0.002, atMin: 0.003, source: 'firmware 4.6.0',      // flight_governor.c:536-548, 658-664, 958-962
        text: 'The minimum throttle is necessary only with a bearing that turns freely in one direction. It is also necessary if the motor speed decreases after a fast load decrease.' },
    // dVisible: a governor D-term of this size or less is in the noise of the log (2 counts of 0.1 %)
    terms: { id: 'GT16', margin: 0.0015, dVisible: 0.0025, source: 'firmware 4.6.0', // flight_governor.c:935-938, CLAUDE.md "Control limits"
        text: 'A term of the governor must be at its limit only when the throttle is at its limit.' },
    notRecorded: { id: 'GT17', source: 'toolkit rule, no flight test',               // CLAUDE.md "No access to the flight controller"
        text: 'The analysis tells which values the log does not record, and the procedure to record them in a flight.' },
    model: { id: 'GT18', source: 'toolkit rule, no flight test',                     // GOVERNOR_AUTOTUNE.md section 7
        text: 'Only the governor model can calculate this value.' },
    value: { id: 'GT19', source: 'toolkit rule, no flight test',
        text: 'The analysis shows the value and its source.' },
    // firmware validation of the throttle values (flight_governor.c:1468-1486): a CLI value outside these limits is changed by the firmware
    validation: { id: 'GT20', source: 'firmware 4.6.0',
        text: 'The firmware changes a throttle value that is not in the limits of the other throttle values.' },
};
// autotune() (not a rule): budgetMs the expected time of the whole analysis in the app (about 3-5 min; information only). NOMAD stops after
// gov_search RULES.nomad.evaluations points, so the result does not depend on the speed of the computer; nomadMaxMs is a safety limit
// (a stop there gives the note gov_search TEXT.nomadTime). points: the largest number of points of a plot trace
// noCurrent: the text (gov_search and gov_scenarios RULES.twins.noCurrent). minVoltageLogs: when some flight logs record the battery voltage and
// others do not, the model uses only the logs with the voltage if they are this many or more (autotune: without the voltage both crafts give
// 'rejected', docs/GOVERNOR_AUTOTUNE.md section 4), else every flight log without the voltage (gov_fit TEXT.mixedV)
const RUN = { budgetMs: 210000, nomadMaxMs: 90000, points: 2000, noCurrent: [0.7, 1.4], minVoltageLogs: 2 };

// ---------------------------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------------------------

const FAMILIES = { gains: 'Gains and precompensation', limits: 'Limits and filters', power: 'Headspeed and power', state: 'Spool-up and governor conditions',
    fallback: 'FALLBACK and RPM signal', battery: 'Battery and voltage', tta: 'Tail torque assist' };
// name: [type, default, lo, hi, unit, family]. Ranges: settings.c of 4.6.0 (firmware_parameters.json) and firmware/schema.cjs. The
// conditional ranges are wider here (gov_idle_throttle and gov_auto_throttle: <= 10 x handover - 1, gov_max_throttle >= handover,
// gov_min_throttle <= max_throttle, flight_governor.c:1468-1486)
const SPEC = {
    gov_mode: ['enum', 'OFF', 0, 4, '', 'state'], gov_throttle_type: ['enum', 'NORMAL', 0, 2, '', 'state'],
    gov_startup_time: ['int', 200, 0, 600, '0.1 s', 'state'], gov_spoolup_time: ['int', 100, 0, 600, '0.1 s', 'state'], gov_tracking_time: ['int', 50, 0, 600, '0.1 s', 'state'],
    gov_recovery_time: ['int', 30, 0, 600, '0.1 s', 'fallback'], gov_spooldown_time: ['int', 30, 0, 600, '0.1 s', 'state'],
    gov_throttle_hold_timeout: ['int', 50, 0, 250, '0.1 s', 'state'], gov_autorotation_timeout: ['int', 15, 0, 250, 's', 'state'],
    gov_idle_throttle: ['int', 0, 0, 250, '0.1 %', 'state'], gov_auto_throttle: ['int', 0, 0, 250, '0.1 %', 'state'], gov_handover_throttle: ['int', 25, 10, 100, '%', 'state'],
    gov_bypass_throttle: ['list', [0, 0, 0, 0, 0, 0, 0, 0, 0], 0, 200, '0.5 %', 'state'],
    gov_pwr_filter: ['int', 5, 0, 250, 'Hz', 'battery'], gov_rpm_filter: ['int', 10, 0, 250, 'Hz', 'limits'], gov_tta_filter: ['int', 0, 0, 250, 'Hz', 'tta'],
    gov_ff_filter: ['int', 5, 0, 250, 'Hz', 'limits'], gov_d_filter: ['int', 50, 0, 250, '0.1 Hz', 'limits'],
    gov_use_fallback_precomp: ['flag', 'OFF', 0, 1, '', 'fallback'], gov_use_voltage_comp: ['flag', 'OFF', 0, 1, '', 'battery'],
    gov_use_pid_spoolup: ['flag', 'OFF', 0, 1, '', 'state'], gov_use_dyn_min_throttle: ['flag', 'OFF', 0, 1, '', 'limits'],
    gov_headspeed: ['int', 1000, 0, 50000, 'rpm', 'power'], gov_min_throttle: ['int', 10, 10, 100, '%', 'limits'], gov_max_throttle: ['int', 100, 10, 100, '%', 'power'],
    gov_gain: ['int', 40, 0, 250, '', 'gains'], gov_p_gain: ['int', 40, 0, 250, '', 'gains'], gov_i_gain: ['int', 50, 0, 250, '', 'gains'],
    gov_d_gain: ['int', 0, 0, 250, '', 'gains'], gov_f_gain: ['int', 10, 0, 250, '', 'gains'],
    gov_p_limit: ['int', 20, 0, 100, '%', 'limits'], gov_i_limit: ['int', 95, 0, 100, '%', 'limits'], gov_d_limit: ['int', 20, 0, 100, '%', 'limits'], gov_f_limit: ['int', 100, 0, 100, '%', 'limits'],
    gov_tta_gain: ['int', 0, 0, 250, '', 'tta'], gov_tta_limit: ['int', 20, 0, 250, '%', 'tta'],
    gov_yaw_ff_weight: ['int', 10, 0, 250, '%', 'gains'], gov_cyclic_ff_weight: ['int', 10, 0, 250, '%', 'gains'], gov_collective_ff_weight: ['int', 50, 0, 250, '%', 'gains'],
    gov_collective_curve: ['int', 20, 5, 40, '0.1', 'gains'], gov_fallback_drop: ['int', 10, 0, 50, '%', 'fallback'], gov_dyn_min_throttle: ['int', 80, 0, 100, '%', 'limits'],
};
const ENUMS = { gov_mode: ['OFF', 'LIMIT', 'DIRECT', 'ELECTRIC', 'NITRO'], gov_throttle_type: ['NORMAL', 'SWITCH', 'FUNCTION'] };
// the four CLI flags are bits of the schema field gov_flags (pg_governor.h:39-44)
const FLAG_BITS = { gov_use_fallback_precomp: 2, gov_use_voltage_comp: 3, gov_use_pid_spoolup: 4, gov_use_dyn_min_throttle: 6 };
// the firmware/schema.cjs field of a CLI name: gov_X_ff_weight <-> gov_X_weight, the flags <-> gov_flags, the bypass curve <-> 9 fields
const fieldOf = (name) => FLAG_BITS[name] !== undefined ? 'gov_flags' : name === 'gov_bypass_throttle' ? 'gov_bypass_throttle[0..8]' : /_ff_weight$/.test(name) ? name.replace('_ff_weight', '_weight') : name;
const REGISTRY = GP.NAMES.map((name) => { const [type, def, lo, hi, unit, family] = SPEC[name];
    return { name, scope: GP.scopeOf(name), type, default: def, range: [lo, hi], unit, family, field: fieldOf(name), bit: FLAG_BITS[name] === undefined ? null : FLAG_BITS[name], values: ENUMS[name] || null }; });
const REG = Object.fromEntries(REGISTRY.map(R => [R.name, R]));
const RELATED = [
    { name: 'battery_meter', family: 'battery', values: ['NONE', 'ADC', 'ESC', 'FBUS'] }, { name: 'battery_cell_count', family: 'battery', range: [0, 24] },
    { name: 'feature GOVERNOR', family: 'state' }, { name: 'freq_input_pull', family: 'fallback' }, { name: 'freq_input_edge', family: 'fallback' },
    { name: 'freq_input_minhz', family: 'fallback' }, { name: 'blackbox_log_esc', family: 'state' }, { name: 'blackbox_log_battery', family: 'battery' },
    { name: 'debug_mode', family: 'fallback' },
].map(o => Object.assign({ scope: 'related' }, o));
const REL = Object.fromEntries(RELATED.map(R => [R.name, R]));
// the products of gov_params (EFFECTIVE) and the CLI names that each one shows
const PRODUCT_OF = { gov_kp_effective: ['gov_gain', 'gov_p_gain'], gov_ki_effective: ['gov_gain', 'gov_i_gain'], gov_collective_ff_effective: ['gov_gain', 'gov_f_gain', 'gov_collective_ff_weight'],
    gov_cyclic_ff_effective: ['gov_gain', 'gov_f_gain', 'gov_cyclic_ff_weight'], gov_yaw_ff_effective: ['gov_gain', 'gov_f_gain', 'gov_yaw_ff_weight'] };

const STATES = ['OFF', 'IDLE', 'SPOOLUP', 'RECOVERY', 'ACTIVE', 'HOLD', 'FALLBACK', 'AUTOROTATION', 'BAILOUT', 'BYPASS'];
const PH_FLIGHT = GD.PHASES.indexOf('flight');
const STATUS_ORDER = ['change', 'check', 'pending-model', 'keep', 'not-recorded', 'not-applicable'];

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && isFinite(v);
const r2 = (v, d = 3) => isNum(v) ? +v.toFixed(d) : null;
const fmt = (v, d = 1) => isNum(v) ? String(+v.toFixed(d)) : 'unknown';
const pct = (x, d = 1) => isNum(x) ? fmt(100 * x, d) : 'unknown';
const N = (l) => l + 1;   // the log number in a text
const prof = (p) => p > 0 ? `PID profile ${p}` : 'PID profile unknown';
const and = (l) => l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const logWords = (logs) => { const u = [...new Set(logs)].sort((a, b) => a - b); return u.length === 1 ? `log ${N(u[0])}` : `logs ${and(u.map(N).map(String))}`; };
const quote = (s) => `"${String(s).replace(/"/g, "'")}"`;
const show = (v) => Array.isArray(v) ? v.join(',') : v === null || v === undefined ? 'unknown' : String(v);
const sig = (v) => isNum(v) ? String(+v.toPrecision(3)) : show(v);   // 3 significant digits
const many = (n, one, more) => `${n} ${n === 1 ? one : more || one + 's'}`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const memo = (f) => { const m = new Map(); return (k) => { if (!m.has(k)) m.set(k, f(k)); return m.get(k); }; };
function quantile(a, q) { if (!a.length) return null; const s = Float64Array.from(a).sort(); const x = q * (s.length - 1), i = Math.floor(x); return i + 1 < s.length ? s[i] + (x - i) * (s[i + 1] - s[i]) : s[i]; }
const median = (a) => quantile(a, 0.5);
function meanSe(a) { const v = a.filter(isNum), n = v.length; if (!n) return { mean: null, se: null, n: 0 }; const m = v.reduce((s, x) => s + x, 0) / n;
    return { mean: m, se: n > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1) / n) : null, n }; }
function spans(n, pred, gap = 0) { const out = []; for (let i = 0; i < n;) { if (!pred(i)) { i++; continue; } let j = i + 1; for (;;) { while (j < n && pred(j)) j++; let k = j; while (k < n && k - j < gap && !pred(k)) k++; if (k < n && k - j < gap && pred(k)) j = k; else break; } out.push([i, j]); i = j; } return out; }
function stateSpans(st) { const out = []; for (let s = 0; s < st.length;) { let e = s + 1; while (e < st.length && st[e] === st[s]) e++; out.push([st[s], s, e]); s = e; } return out; }
const posOf = (x) => !isNum(x) ? null : x < RULES.throttleType.low ? 'low' : x < RULES.throttleType.high ? 'middle' : 'top';
const isFlight = (run) => run.class === 'flight';
// the governor conditions of a run, or null when the log does not record them (no GOVERNOR_STATE event: the mode LIMIT or OFF)
const SCACHE = new WeakMap();
const statesOf = (run) => { if (!SCACHE.has(run)) SCACHE.set(run, run.state && run.state.some(v => v > 0) ? run.state : null); return SCACHE.get(run); };
// least squares of k unknowns from the normal equations; null when singular. Returns { x, cov } (cov = (X'X)^-1)
function lsq(rows, k) {
    const A = new Float64Array(k * k), b = new Float64Array(k); let yy = 0;
    for (const [x, y] of rows) { for (let i = 0; i < k; i++) { b[i] += x[i] * y; for (let j = 0; j < k; j++) A[i * k + j] += x[i] * x[j]; } yy += y * y; }
    const inv = new Float64Array(k * k), M = Float64Array.from(A); for (let i = 0; i < k; i++) inv[i * k + i] = 1;
    for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r * k + c]) > Math.abs(M[p * k + c])) p = r; if (!(Math.abs(M[p * k + c]) > 1e-12)) return null;
        for (let j = 0; j < k; j++) { [M[c * k + j], M[p * k + j]] = [M[p * k + j], M[c * k + j]]; [inv[c * k + j], inv[p * k + j]] = [inv[p * k + j], inv[c * k + j]]; }
        const d = M[c * k + c]; for (let j = 0; j < k; j++) { M[c * k + j] /= d; inv[c * k + j] /= d; }
        for (let r = 0; r < k; r++) if (r !== c) { const f = M[r * k + c]; if (f) for (let j = 0; j < k; j++) { M[r * k + j] -= f * M[c * k + j]; inv[r * k + j] -= f * inv[c * k + j]; } } }
    const x = []; for (let i = 0; i < k; i++) { let s = 0; for (let j = 0; j < k; j++) s += inv[i * k + j] * b[j]; x.push(s); }
    let sse = yy; for (let i = 0; i < k; i++) sse -= x[i] * b[i];
    const s2 = rows.length > k ? Math.max(0, sse) / (rows.length - k) : null;
    return { x, se: x.map((_, i) => s2 === null ? null : Math.sqrt(s2 * inv[i * k + i])) };
}

// ---------------------------------------------------------------------------------------------
// CLI values
// ---------------------------------------------------------------------------------------------

// the CLI text of value v of name, or null when the firmware does not accept it (CLAUDE.md "Export": each value in its range)
function cliValue(name, v) {
    const R = REG[name]; if (!R || v === null || v === undefined) return null;
    if (R.type === 'flag') { const s = String(v).toUpperCase(); return v === true || v === 1 || s === 'ON' ? 'ON' : v === false || v === 0 || s === 'OFF' ? 'OFF' : null; }
    if (R.type === 'enum') { const s = typeof v === 'number' ? R.values[v] : String(v).toUpperCase(); return R.values.includes(s) ? s : null; }
    if (R.type === 'list') { const a = Array.isArray(v) ? v : String(v).split(','); if (a.length !== 9) return null; const x = a.map(q => Number(String(q).trim()));
        return x.every(q => Number.isInteger(q) && q >= R.range[0] && q <= R.range[1]) ? x.join(',') : null; }
    const x = Number(v); return Number.isInteger(x) && x >= R.range[0] && x <= R.range[1] ? String(x) : null;
}
const norm = (v) => (Array.isArray(v) ? v.join(',') : String(v)).replace(/\s+/g, '').toUpperCase();
function parseCli(cli) { if (!cli) return null; if (typeof cli !== 'string') return cli; const HS = optional(() => require('./health_setup.cjs')); return HS ? HS.parseCli(cli) : null; }
// the value of name in the CLI section of PID profile p (global: p ignored): { value, where, def } or null. A `diff` leaves out the
// 4.6 defaults of a section that it prints (advice.cjs current())
function cliOf(cli, name, p) {
    if (!cli) return null;
    const R = REG[name] || REL[name], global = !R || R.scope !== 'profile', sec = global ? cli.global : p > 0 ? (cli.profiles || {})[String(p - 1)] : null;
    if (!sec) return null;
    const where = global ? 'CLI dump' : `CLI dump, section \`profile ${p - 1}\``, v = sec[name];
    if (v !== undefined && v !== null) return { value: v, where };
    if (cli.kind === 'diff' && R && R.default !== undefined) return { value: R.default, where: `${where}, the default of 4.6, because \`diff\` does not show a default value`, def: true };
    return null;
}

// ---------------------------------------------------------------------------------------------
// PID profiles and the logs
// ---------------------------------------------------------------------------------------------

// the PID profile of each sample of each run (gov_params labels: the logged change, else the governor headspeed rule of the profile
// map; under SWITCH the logged changes only, because the stick sets govRequest)
function labelsOf(runs, rec) {
    const map = rec && rec.profileMap || { byHeadspeed: {}, basis: {} }, out = new Map();
    for (const run of runs) out.set(run, GP.throttleRequest(run).type === 'SWITCH' ? Uint8Array.from(run.profile) : GP.labels(run, map));
    return out;
}
// the PID profiles of the flight runs with RULES.minProfileS of ACTIVE (0: PID profile unknown), else [0]
function profilesOf(flights, labels) {
    const sec = new Map();
    for (const run of flights) { const lab = labels.get(run), st = statesOf(run), u = run.u; if (!lab) continue;
        for (let i = 0; i < run.n; i++) if (st ? st[i] === 4 : u && u[i] > 0.02) sec.set(lab[i], (sec.get(lab[i]) || 0) + 1 / run.rate); }
    const out = [...sec].filter(([, s]) => s >= RULES.minProfileS).map(([p]) => p).sort((a, b) => a - b);
    return out.length ? out : [0];
}
// every PID profile label of the samples of the flight runs (0: PID profile unknown)
function allLabelsOf(flights, labels) { const out = new Set(); for (const run of flights) { const lab = labels.get(run); if (lab) for (let i = 0; i < run.n; i++) out.add(lab[i]); } return [...out].sort((a, b) => a - b); }
// for each log: the PID profile at its start, a second arm, a logging pause, the PID profiles in ACTIVE
function logInfo(runs, labels) {
    const by = new Map();
    for (const run of runs) {
        const lab = labels.get(run), x = by.get(run.log) || { log: run.log, flight: false, startProfile: null, rearm: false, pause: false, profiles: new Set() };
        if (isFlight(run)) x.flight = true;
        if (!run.segment && lab) x.startProfile = lab[0];
        if (run.segment) x.pause = true;
        let armed = false; for (let i = 0; i < run.n; i++) { const a = run.armed ? run.armed[i] === 1 : true; if (a && !armed && i > 0 && x.armedOnce) x.rearm = true; if (a) x.armedOnce = true; armed = a; }
        for (let i = 1; i < run.n; i++) if (run.time[i] - run.time[i - 1] > RULES.pauseS) { x.pause = true; break; }
        const st = statesOf(run); if (lab) for (let i = 0; i < run.n; i++) if (st ? st[i] === 4 : run.u && run.u[i] > 0.02) x.profiles.add(lab[i]);
        by.set(run.log, x);
    }
    return [...by.values()];
}

// ---------------------------------------------------------------------------------------------
// values at this time (CLAUDE.md "PID profiles": the CLI section, the values that the analysis calculates, the log header of the
// PID profile at the start of the log; else unknown)
// ---------------------------------------------------------------------------------------------

// the values of a name in the logs (["10 in log 39", ...]): all of them, or the first and the last (STE Rule 6.3: 25 words)
const valuesText = (vals) => vals.length === 1 ? `The value is ${vals[0]}.` : vals.length === 2 ? `The values are ${and(vals)}.` : `The first value is ${vals[0]}, and the last value is ${vals[vals.length - 1]}.`;
// a name in a text: a product of gains (an EFFECTIVE name of gov_params) as its CLI names
const valueName = (n) => PRODUCT_OF[n] ? `The value of ${quote(PRODUCT_OF[n][0])} multiplied by ${and(PRODUCT_OF[n].slice(1).map(quote))}` : `The value of ${quote(n)}`;
const STALE_TEXT = {
    lead: 'This value is possibly not the same in all logs.',
    cause: { unlogged: 'a change between logs that the log does not record', adjusted: 'an in-flight adjustment', switched: 'a different PID profile at the start of the log',
        rearm: 'a second arm in the same log', resume: 'a period with no data', cli: 'a different value in the CLI dump' },
    // two causes in each sentence (STE Rule 6.3: 25 words)
    causes: (list) => { const out = []; for (let i = 0; i < list.length; i += 2) { const l = list.slice(i, i + 2); out.push(i === 0 ? `The ${list.length === 1 ? 'cause is' : 'causes are'} ${and(l)}.` : `${l.length === 1 ? 'One more cause is' : 'Other causes are'} ${and(l)}.`); } return out.join(' '); },
    source: (s) => `The source of the value is ${quote(s)}.`,
    switched: (p, logs) => `In ${logWords(logs)}, ${prof(p)} is not the PID profile at the start of the log. The log header gives only the values at the start of the log.`,
    rearm: (logs) => `The pilot armed the helicopter again in ${logWords(logs)}. A change between the arms is not in the log.`,
    resume: (logs) => `${cap(logWords(logs))} ${new Set(logs).size > 1 ? 'have' : 'has'} a period with no data. The log does not record a change in that period.`,
    cli: (name, c) => `The CLI dump gives ${show(c.cli)} for "${name}", and the log gives ${show(c.log)}. The app cannot find which value is correct at this time.`,
    unlogged: (name, vals) => `${valueName(name)} changes between logs, and the log does not record the change. ${valuesText(vals)}`,
    adjusted: (name, vals) => `An in-flight adjustment changes ${valueName(name).replace(/^The /, 'the ')}. ${valuesText(vals)}`,
};
// the products of gains that change between logs in a PID profile (gov_params flags of an EFFECTIVE name), and the CLI names that can
// cause the change: a factor is constant when one value of it (an epoch of the name, or of another product that has it and no flag)
// covers logs of two or more values of the product. { 'X|p': { name, profile, flags, changed: [CLI names] } }
const PCACHE = new WeakMap();
function productChanges(rec) {
    if (PCACHE.has(rec)) return PCACHE.get(rec);
    const out = new Map(), flagged = (name, p) => rec.flags.some(g => g.name === name && g.profile === p);
    for (const f of rec.flags) if (PRODUCT_OF[f.name]) { const k = `${f.name}|${f.profile}`; if (!out.has(k)) out.set(k, { name: f.name, profile: f.profile, flags: [], changed: [] }); out.get(k).flags.push(f); }
    for (const c of out.values()) {
        const groups = c.flags.map(f => new Set(f.logs)), two = (logs) => groups.filter(g => (logs || []).some(l => g.has(l))).length >= 2;
        c.changed = PRODUCT_OF[c.name].filter(f => !rec.epochs.some(e => e.profile === c.profile && two(e.logs) &&
            ((e.name === f && !flagged(f, c.profile)) || (e.name !== c.name && PRODUCT_OF[e.name] && PRODUCT_OF[e.name].includes(f) && !flagged(e.name, c.profile)))));
    }
    PCACHE.set(rec, out); return out;
}
// the flag of a value: the gov_params flags of the name (and of the products that it can change), the PID profile at the start of the
// log, a second arm, a logging pause, a CLI dump that does not agree. null when there is none
function staleOf(R, p, cur, rec, info) {
    const flags = [], global = R.scope !== 'profile', PC = productChanges(rec);
    const names = [R.name].concat(Object.keys(PRODUCT_OF).filter(k => { const c = PC.get(`${k}|${p}`); return !global && c && c.changed.includes(R.name); }));
    // each name: its flags of each log and a summary (logs []: js/tuning_worker.js govJoin shows the summary in place of the text of each
    // log). A name with one value in these logs and no in-flight adjustment does not change (a flag of the model logs only: modelStale)
    const by = new Map();
    for (const f of rec.flags) if (names.includes(f.name) && (global || f.profile === p)) (by.get(f.name) || by.set(f.name, []).get(f.name)).push(f);
    for (const [name, g] of by) {
        const adj = g.some(f => (f.reasons || []).includes('adjusted')), vals = [...new Map(g.map(f => [String(f.value), `${show(f.value)} in ${logWords(f.logs)}`])).values()];
        if (vals.length < 2 && !adj) continue;
        const pp = global ? 0 : p;
        for (const f of g) flags.push({ reason: (f.reasons || []).includes('adjusted') ? 'adjusted' : 'unlogged', name: f.name, profile: pp, logs: f.logs, value: f.value, source: f.source, text: f.text });
        flags.push({ reason: adj ? 'adjusted' : 'unlogged', name, profile: pp, logs: [], text: adj ? STALE_TEXT.adjusted(name, vals) : STALE_TEXT.unlogged(name, vals) });
    }
    // the flight logs that use the value: a value that the analysis calculates, the logs that give it; else the logs of PID profile p
    // (a profile name) or all flight logs (a global name). Each source (the log header, the CLI dump, unknown): the PID profile at the
    // start of the log for a profile name, a second arm and a pause (CLAUDE.md "Values that are possibly not current";
    // js/tuning_worker.js reasonsFor)
    const used = cur.from === 'log' ? info.filter(l => l.flight && (cur.logs || []).includes(l.log)) : info.filter(l => l.flight && (global || l.profiles.has(p)));
    if (cur.from !== 'log' && !global) { const sw = used.filter(l => l.startProfile !== p).map(l => l.log); if (sw.length) flags.push({ reason: 'switched', logs: sw, text: STALE_TEXT.switched(p, sw) }); }
    const re = used.filter(l => l.rearm).map(l => l.log), pa = used.filter(l => l.pause).map(l => l.log);
    if (re.length) flags.push({ reason: 'rearm', logs: re, text: STALE_TEXT.rearm(re) });
    if (pa.length) flags.push({ reason: 'resume', logs: pa, text: STALE_TEXT.resume(pa) });
    if (cur.conflict) flags.push({ reason: 'cli', logs: [], text: STALE_TEXT.cli(R.name, cur.conflict) });
    if (!flags.length) return null;
    const reasons = [...new Set(flags.map(f => f.reason))], source = cur.source || 'unknown';
    return { reasons, flags, source, text: [STALE_TEXT.lead, STALE_TEXT.causes(reasons.map(k => STALE_TEXT.cause[k])), STALE_TEXT.source(source)].join(' ') };
}
// the flag of a model row that simulates the logs (CLAUDE.md "Values that are possibly not current"; review 2026-10-15): the values of the
// simulated logs that the simulation uses. names: the CLI names that it uses (a product of gains with one of them too); p: the PID profile
// of the row (null: all); logs: the simulated logs. The gov_params flags (a change between logs with no record, an in-flight adjustment)
// with the values and their source, a second arm and a pause (all values). null when there is none. Format of staleOf
const SIM_TEXT = {
    lead: 'The governor model uses values that are possibly not correct for all the time of each log.',
    name: (n, p) => `${PRODUCT_OF[n] ? `The value of ${quote(PRODUCT_OF[n][0])} multiplied by ${and(PRODUCT_OF[n].slice(1).map(quote))}` : quote(n)}${p > 0 ? ` (${prof(p)})` : ''}`,
    unlogged: (nm) => `${nm} changes between logs, and the log does not record the change. The model uses the value of each log.`,
    adjusted: (nm) => `An in-flight adjustment changes ${nm.replace(/^The /, 'the ')}. The model uses the value of each log.`,
    source: (s) => `The source of these values is ${quote(s)}.`,
    rearm: (logs) => `The pilot armed the helicopter again in ${logWords(logs)}. The model uses the values of the first arm for all the log.`,
    resume: (logs) => `${cap(logWords(logs))} ${new Set(logs).size > 1 ? 'have' : 'has'} a period with no data. The model uses the same values after this period.`,
};
function simStale(ctx, names, p, logs) {
    const rec = ctx && ctx.rec, set = new Set(logs || []), inSet = (l) => (l || []).some(x => set.has(x));
    if (!set.size || !names || !names.length) return null;
    const uses = (n) => names.includes(n) || (PRODUCT_OF[n] || []).some(k => names.includes(k));
    const groups = new Map();
    for (const f of rec && rec.flags || []) if (uses(f.name) && (!(p > 0) || !(f.profile > 0) || f.profile === p) && inSet(f.logs)) { const k = `${f.name}|${f.profile}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
    const flags = [], text = [], sources = [];
    for (const g of groups.values()) {
        const f = g[0], adj = g.some(x => (x.reasons || []).includes('adjusted')), src = fromSourceOf(f.source) || 'unknown', nm = SIM_TEXT.name(f.name, f.profile);
        const vals = [...new Map(g.map(x => [String(x.value), `${show(x.value)} in ${logWords(x.logs.filter(l => set.has(l)))}`])).values()];
        // one value in the simulated logs and no in-flight adjustment: the value does not change in the logs that the simulation uses
        if (vals.length < 2 && !adj) continue;
        // the PID profile on each flag (govJoin: the summary of a name and a PID profile replaces the flags of each log)
        for (const x of g) flags.push({ reason: adj ? 'adjusted' : 'unlogged', name: x.name, profile: f.profile, logs: x.logs.filter(l => set.has(l)), value: x.value, source: x.source, text: x.text });
        const said = [adj ? SIM_TEXT.adjusted(nm) : SIM_TEXT.unlogged(nm), vals.length === 1 ? `The value is ${vals[0]}.` : valuesText(vals), SIM_TEXT.source(src)];
        // the summary of the name (logs []: as staleOf): js/tuning_worker.js govJoin shows it in place of the text of each log
        flags.push({ reason: adj ? 'adjusted' : 'unlogged', name: f.name, profile: f.profile, logs: [], text: said.join(' ') });
        text.push(...said);
        if (!sources.includes(src)) sources.push(src);
    }
    const info = (ctx && ctx.info || []).filter(l => l.flight && set.has(l.log)), re = info.filter(l => l.rearm).map(l => l.log), pa = info.filter(l => l.pause).map(l => l.log);
    if (re.length) { flags.push({ reason: 'rearm', logs: re, text: SIM_TEXT.rearm(re) }); text.push(SIM_TEXT.rearm(re)); }
    if (pa.length) { flags.push({ reason: 'resume', logs: pa, text: SIM_TEXT.resume(pa) }); text.push(SIM_TEXT.resume(pa)); }
    if (!flags.length) return null;
    return { reasons: [...new Set(flags.map(f => f.reason))], flags, source: sources.join(', ') || 'unknown', text: [SIM_TEXT.lead].concat(text).join(' '), simulation: true };
}
// the union of two flags (staleOf, simStale). A name and PID profile with a summary in b (the simulated values) is left out of a: one text
// for each value (review 2026-10-15)
function mergeStale(a, b) {
    if (!a || !b) return a || b || null;
    const key = (f) => `${f.name}|${f.profile || 0}`, inB = new Set(b.flags.filter(f => f.name && Array.isArray(f.logs) && !f.logs.length).map(key));
    const af = a.flags.filter(f => !f.name || !inB.has(key(f)));
    if (!af.length) return b;
    const reasons = [...new Set(af.map(f => f.reason))];
    const at = af.length === a.flags.length ? a.text : [STALE_TEXT.lead, STALE_TEXT.causes(reasons.map(k => STALE_TEXT.cause[k])), STALE_TEXT.source(a.source || 'unknown')].join(' ');
    return { reasons: [...new Set(reasons.concat(b.reasons))], flags: af.concat(b.flags), source: a.source, text: `${at} ${b.text}`, simulation: true };
}
// the flag of a row of the model (method 'model' or 'simulation'): the values of the flight logs of the model only (ctx.modelLogs: the
// logs with the battery voltage when some logs do not record it; review 2026-10-15). A rule row keeps the flag of all flight logs
function modelStale(ctx, name, p, cur) {
    const R = REG[name];
    if (!R || !Array.isArray(ctx.modelLogs)) return cur.stale || null;
    const key = `${name}|${p}`; ctx.mStale = ctx.mStale || new Map();
    if (ctx.mStale.has(key)) return ctx.mStale.get(key);
    const set = new Set(ctx.modelLogs);
    const rec = ctx.recModel || (ctx.recModel = { flags: ctx.rec.flags.map(f => Object.assign({}, f, { logs: f.logs.filter(l => set.has(l)) })).filter(f => f.logs.length), epochs: ctx.rec.epochs });
    const x = staleOf(R, R.scope !== 'profile' ? null : p, cur, rec, ctx.info.filter(l => set.has(l.log)));
    ctx.mStale.set(key, x);
    return x;
}
// a recovered value against a CLI value: the same within the uncertainty of the recovery
function sameValue(R, cur, v) {
    if (typeof cur.value === 'number' && isNum(Number(v))) return Math.abs((isNum(cur.estimate) ? cur.estimate : cur.value) - Number(v)) <= Math.max(0.5, 3 * (cur.se || 0));
    return norm(cur.value) === norm(R.type === 'flag' ? cliValue(R.name, v) || v : v);
}
function valueAt(R, p, rec, cli, info) {
    const global = R.scope !== 'profile', eps = rec.epochs.filter(e => e.name === R.name && (global || e.profile === p));
    const hdr = eps.filter(e => e.source === 'log header'), calc = eps.filter(e => e.source !== 'log header' && !e.effective && !(R.name === 'gov_use_voltage_comp'));
    const eff = R.name === 'gov_use_voltage_comp' ? eps.filter(e => e.value === 'inactive' || e.value === 'active') : [];
    const c = cliOf(cli, R.name, p);
    let out = null;
    if (hdr.length) { const e = hdr[hdr.length - 1]; out = { value: e.value, source: `log header, ${prof(p)} at the start of the log`, se: null, logs: e.logs, from: 'header' }; }
    else if (calc.length) { const e = calc[calc.length - 1]; out = { value: e.value, estimate: e.estimate, source: e.source, se: e.se, logs: e.logs, from: 'log' }; }
    if (out && c) { if (sameValue(R, out, c.value)) { out.cli = 'same'; if (out.from === 'header') out.source = `${c.where}, the same as the log header`; } else out.conflict = { log: out.value, cli: c.value }; }
    if (!out && c) out = { value: c.value, source: c.where, se: null, logs: [], from: 'cli' };
    if (!out) {
        const items = rec.items.filter(i => i.name === R.name && (global || i.profile === p));
        const lo = Math.max(-Infinity, ...items.filter(i => i.lo !== null && i.lo !== undefined).map(i => i.lo)), hi = Math.min(Infinity, ...items.filter(i => i.hi !== null && i.hi !== undefined).map(i => i.hi));
        const cand = [...new Set(items.filter(i => i.kind === 'candidates').flatMap(i => i.candidates || []))];
        const u = rec.unknown.find(x => x.name === R.name && (global || x.profile === p));
        out = { value: null, source: 'unknown', se: null, logs: [...new Set(items.map(i => i.log).filter(l => l !== null))], from: null,
            lo: isFinite(lo) ? lo : null, hi: isFinite(hi) ? hi : null, candidates: cand.length ? cand : null,
            reason: cand.length && items.find(i => i.reason) ? items.find(i => i.reason).reason : u ? u.reason : GP.NOT_SHOWN.other };
    }
    if (eff.length) out.effect = eff[eff.length - 1].value;
    out.stale = staleOf(R, global ? null : p, out, rec, info);
    return out;
}
// the related values: the CLI global section, the log header (features), the recorded fields; else unknown
function relatedValues(runs, cli) {
    const h = (runs.find(r => !r.segment) || runs[0] || {}).header || {}, out = {};
    for (const R of RELATED) {
        if (R.name === 'feature GOVERNOR') {
            const f = isNum(h.features) ? ((h.features >>> RULES.feature.bit) & 1) === 1 : null, c = cli && cli.features ? cli.features.GOVERNOR : undefined;
            out[R.name] = f !== null ? { value: f ? 'ON' : 'OFF', source: 'log header', from: 'header' } : c !== undefined ? { value: c ? 'ON' : 'OFF', source: 'CLI dump', from: 'cli' } : { value: null, source: 'unknown', from: null };
            continue;
        }
        const c = cliOf(cli, R.name, 0);
        out[R.name] = c ? { value: c.value, source: c.where, from: 'cli' } : { value: null, source: 'unknown', from: null };
    }
    out.tail_rotor_mode = (() => { const c = cliOf(cli, 'tail_rotor_mode', 0); return c ? { value: c.value, source: c.where, from: 'cli' } : { value: null, source: 'unknown', from: null }; })();
    return out;
}
// profiles: the PID profiles with rows; extraProfiles: the other labels of the flight samples (a short PID profile, PID profile unknown),
// with values for the rows of their control limits
function currentValues(runs, recovered, o = {}) {
    const rec = recovered || GP.recover(runs, { cli: o.cli || null }), cli = parseCli(o.cli), labels = o.labels || labelsOf(runs, rec), flights = runs.filter(isFlight);
    const profiles = o.profiles || profilesOf(flights, labels), extra = allLabelsOf(flights, labels).filter(p => !profiles.includes(p)), info = logInfo(runs, labels), byName = {};
    for (const R of REGISTRY) { byName[R.name] = {}; for (const p of R.scope === 'global' ? [0] : profiles.concat(extra)) byName[R.name][p] = valueAt(R, p, rec, cli, info); }
    return { profiles, extraProfiles: extra, byName, related: relatedValues(runs, cli), cli: cli ? { kind: cli.kind || null, version: cli.version || null } : null };
}

// ---------------------------------------------------------------------------------------------
// measurements (flight runs only, all flight phases unless a rule says otherwise)
// ---------------------------------------------------------------------------------------------

const KCACHE = new WeakMap();
// the governor headspeed H = PT2(headspeed, gov_rpm_filter) and the motor constant Kmot: the EWMA of H / throttle at 0.05 Hz in SPOOLUP
// and ACTIVE with throttle > 0.2 and H / Hf > 0.2, from 0 at the start of the run (a power cycle, critique M5, M12;
// flight_governor.c:550-560; gov_params tracking())
function kmotOf(run, fc) {
    const key = KCACHE.get(run); if (key && key.fc === fc) return key;
    const n = run.n, L = run.loopsPerFrame || 1, H = GP.pt2(run.hs, fc, run.pidHz, L), K = new Float64Array(n), st = run.state, u = run.u, Q = run.request;
    const W = (RULES.fallback.kmotHz + run.pidHz / (2 * Math.PI)) / RULES.fallback.kmotHz; let y = 0, c = 0;
    for (let i = 0; i < n; i++) { const hf = Q ? Q[i] : 0;
        if (st && (st[i] === 2 || st[i] === 4) && u[i] > RULES.fallback.kmotU && hf > 0 && H[i] / hf > RULES.fallback.kmotShare) for (let k = 0; k < L; k++) { c = Math.min(c + 1, W); y += (H[i] / u[i] - y) / c; }
        K[i] = y; }
    const out = { fc, H, K }; KCACHE.set(run, out); return out;
}
const TERM_LIMIT = { govP: 'gov_p_limit', govI: 'gov_i_limit', govD: 'gov_d_limit', govF: 'gov_f_limit' };
// the measurements of a PID profile in ACTIVE (the term times in s: runs can have different rates)
function newProf(ctx, p) {
    const terms = {};
    for (const k of Object.keys(TERM_LIMIT)) terms[k] = { lim: ctx.termLim(k, p), atS: 0, inSatS: 0, outSatS: 0, max: 0, n: 0 };
    return { p, activeS: 0, satS: 0, shares: [], p95s: [], p50s: [], thr: [], dv: [], vb: [], floorS: 0, floorPeriods: 0, activeAllS: 0, minU: Infinity, maxU: 0, terms, request: new Map() };
}

function fallbackEvent(run, lab, ctx, a, e, next) {
    const F = RULES.fallback, n = run.n, rate = run.rate, u = run.u, hs = run.hs, Q = run.request, st = run.state, near = RULES.saturation.near;
    const p = lab[a] || (a ? lab[a - 1] : 0), req = Q ? Q[a] || (a ? Q[a - 1] : 0) : 0, mu = ctx.maxThr(p), at = (i) => r2(run.fromS + run.time[clamp(i, 0, n - 1)], 3);
    let uMax = 0, satN = 0, coll = 0;
    for (let k = Math.max(0, a - Math.round(F.preS * rate)); k < a; k++) { uMax = Math.max(uMax, u[k]); if (u[k] >= mu - near) satN++; if (run.coll) coll = Math.max(coll, Math.abs(run.coll[k])); }
    const Ib = run.govI && a ? run.govI[a - 1] : null, Fb = run.govF && a ? run.govF[a - 1] : null;
    const mid = []; for (let k = a + 1; k < e - 1; k++) mid.push(u[k]);
    const ufb = mid.length ? median(mid) : u[a], drop = ctx.num('gov_fallback_drop', p), pre = ctx.val('gov_use_fallback_precomp', p), lo = ctx.minThr(p);
    const fbOf = (on) => Ib === null || drop === null ? null : clamp((Ib + (on ? Fb || 0 : 0)) * (1 - drop / 100), lo, mu);
    const K = kmotOf(run, ctx.fc);
    let urec = null, calcRec = null, km = null;
    if (next === 3 && e < n) { urec = u[e]; const H = K.H[e - 1]; km = K.K[e - 1]; if (km > req && req > 0 && H / req > RULES.fallback.kmotShare) calcRec = Math.min(H / km, H / req); }
    let k = e; while (k < n && (st[k] === 3 || st[k] === 6)) k++;
    const kA = k < n && st[k] === 4 ? k : -1, w1 = Math.min(n, (kA >= 0 ? kA : k) + Math.round(F.postS * rate));
    let minHs = Infinity, iMin = a, below = 0;
    for (let j = a; j < w1; j++) { if (hs[j] < minHs) { minHs = hs[j]; iMin = j; } if (req > 0 && hs[j] < F.sag * req) below++; }
    let within = null;
    if (kA >= 0 && req > 0) { const hold = Math.max(1, Math.round(F.holdS * rate)); let c = 0;
        for (let j = kA; j < Math.min(n, kA + Math.round(3 * F.postS * rate)); j++) { if (st[j] !== 4) break; if (Math.abs(hs[j] - req) <= F.within * req) { if (++c >= hold) { within = (j - hold + 1 - a) / rate; break; } } else c = 0; } }
    let jump = 0; for (let j = Math.max(0, a - Math.round(F.glitchWinS[0] * rate)); j <= Math.min(n - 1, a + Math.round(F.glitchWinS[1] * rate)); j++) jump = Math.max(jump, Math.abs(hs[j] - K.H[j]));
    return { log: run.log, segment: run.segment, profile: p, i: a, t: at(a), t1: at(w1), request: req, throttleBefore: r2(uMax, 4), satS: r2(satN / rate, 3), atMax: satN > 0, coll: r2(coll, 3),
        vbat: run.vbat ? r2(run.vbat[a], 2) : null, govI: r2(Ib, 4), govF: r2(Fb, 4), throttle: r2(ufb, 4), calc: r2(pre === 'ON' ? fbOf(true) : pre === 'OFF' ? fbOf(false) : null, 4),
        calcOff: r2(fbOf(false), 4), calcOn: r2(fbOf(true), 4), drop, precomp: pre || null, ratio: Ib > 0 ? r2(ufb / Ib, 4) : null, durS: r2((e - a) / rate, 3), next: next === null ? null : STATES[next],
        recovery: r2(urec, 4), recoveryCalc: r2(calcRec, 4), kmot: km > 0 ? Math.round(km) : null, minHs: isFinite(minHs) ? Math.round(minHs) : null, minShare: req > 0 && isFinite(minHs) ? r2(minHs / req, 4) : null,
        tMin: at(iMin), belowS: r2(below / rate, 3), activeS: kA >= 0 ? r2((kA - a) / rate, 3) : null, withinS: r2(within, 3), jump: Math.round(jump), jumpLimit: Math.round(F.glitch * req),
        rescue: run.rescue ? run.rescue[a] > 0 : null };
}
function bailoutEvent(run, lab, ctx, a, e, next) {
    const B = RULES.bailout, n = run.n, rate = run.rate, u = run.u, hs = run.hs, Q = run.request, st = run.state, p = lab[a], req = Q ? Q[a] : 0, mu = ctx.maxThr(p);
    const w1 = Math.min(n, e + Math.round(B.afterS * rate)); let sat = 0, top = -Infinity;
    for (let j = a; j < w1; j++) { if (j >= e && st[j] !== 4) break; if (u[j] >= mu - RULES.saturation.near) sat++; if (j >= e && req > 0) top = Math.max(top, (hs[j] - req) / req); }
    return { log: run.log, profile: p, i: a, t: r2(run.fromS + run.time[a], 3), request: req, hs: Math.round(hs[a]), share: req > 0 ? r2(hs[a] / req, 4) : null, airborne: run.airborne ? run.airborne[a] > 0 : null,
        durS: r2((e - a) / rate, 3), next: next === null ? null : STATES[next], satS: r2(sat / rate, 3), overshoot: isFinite(top) ? r2(top, 4) : null, low: req > 0 && hs[a] < B.lowShare * req };
}
function spoolupEvent(run, lab, ctx, a, e) {
    const SP = RULES.spool, n = run.n, rate = run.rate, u = run.u, hs = run.hs, Q = run.request, st = run.state;
    if ((e - a) / rate < SP.minS || !Q || e < 1) return null;
    const p = lab[e], req = Q[e]; if (!(req > 0)) return null;
    let changed = false; for (let k = a; k <= e; k++) if (Q[k] !== req) { changed = true; break; }
    let w1 = e; const lim = Math.min(n, e + Math.round(SP.windowS * rate)); while (w1 < lim && st[w1] === 4 && Q[w1] === req) w1++;
    let top = -Infinity, air = false; for (let k = e; k < w1; k++) { top = Math.max(top, hs[k]); if (run.airborne && run.airborne[k] > 0) air = true; }
    const j0 = Math.max(a, e - 1 - Math.round(SP.lastS * rate)), acc = e - 1 > j0 ? (hs[e - 1] - hs[j0]) / ((e - 1 - j0) / rate) : null, mu = ctx.maxThr(p);
    const byThrottle = u[e - 1] >= SP.exitShare * mu - SP.exitTol && hs[e - 1] < SP.exitHs * req;
    // a change of the target in SPOOLUP with the exit by the throttle rule: the overshoot is not that of the spool-up (critique C6, log 15)
    return { log: run.log, profile: p, i: e, t: r2(run.fromS + run.time[e], 3), request: req, overshoot: isFinite(top) ? r2((top - req) / req, 4) : null, exitThrottle: r2(u[e - 1], 4),
        byThrottle, airborne: air, accel: r2(acc, 0), durS: r2((e - a) / rate, 3), changed, excluded: changed && byThrottle, windowS: r2((w1 - e) / rate, 3) };
}

function measureRun(run, lab, ctx, M) {
    const n = run.n, rate = run.rate, dt = 1 / rate, st = statesOf(run), u = run.u, hs = run.hs, Q = run.request, S = run.govSum, V = run.vbat, thr = run.thr;
    if (!u || !lab) return;
    const ph = run.phase, air = run.airborne, resc = run.rescue, near = RULES.saturation.near, C = M.census, G = M.glitch;
    const fl = (i) => ph ? ph[i] === PH_FLIGHT : air ? air[i] > 0 : true, P = (p) => M.prof[p] || (M.prof[p] = newProf(ctx, p));
    const at = (i) => r2(run.fromS + run.time[clamp(i, 0, n - 1)], 3);
    for (let i = 0; i < n; i++) if (u[i] > (M.uMax[lab[i]] || 0)) M.uMax[lab[i]] = u[i];
    // rest voltage before the motor starts (battery.c: the cell count at connection)
    if (V) { let k = 0; while (k < n && u[k] <= 0.02 && k < RULES.cells.restS * rate) k++; const v = []; for (let i = 0; i < k; i++) if (V[i] > 0) v.push(V[i]); if (v.length) M.rest.push({ log: run.log, v: r2(median(v), 2) }); }
    if (st) {
        const sr = stateSpans(st);
        for (let j = 0; j < sr.length; j++) {
            const [s, a, e] = sr[j], d = (e - a) / rate, prev = j ? sr[j - 1][0] : null, next = j + 1 < sr.length ? sr[j + 1][0] : null;
            C.seconds[s] += d; C.entries[s]++;
            if (s === 7) C.autorotations.push({ log: run.log, t: at(a), s: r2(d, 3), from: prev === null ? null : STATES[prev], next: next === null ? null : STATES[next], pos: thr ? posOf(thr[a]) : null, airborne: air ? air[a] > 0 : null });
            else if (s === 5) C.holds.push({ log: run.log, t: at(a), s: r2(d, 3), next: next === null ? null : STATES[next], pos: thr ? posOf(thr[a]) : null });
            else if (s === 9) C.bypassS += d;
            else if (!hs) continue;
            else if (s === 8) M.bailouts.push(bailoutEvent(run, lab, ctx, a, e, next));
            else if (s === 6 && a > 0) M.fallbacks.push(fallbackEvent(run, lab, ctx, a, e, next));
            else if (s === 2 && next === 4) { const x = spoolupEvent(run, lab, ctx, a, e); if (x) M.spoolups.push(x); }
        }
        // the stick census: a sample with no stick value is not counted
        if (thr) for (let i = 0; i < n; i++) { const q = posOf(thr[i]); if (q === null) continue; const c = Math.round(thr[i] * 1000); C.stick.set(c, (C.stick.get(c) || 0) + dt); C.pos[q][st[i]] += dt; }
    }
    // the limits of the outputs (CLAUDE.md "Control limits"), in all flight phases and in rescue:
    //   max    the throttle at gov_max_throttle (all governor conditions);
    //   floor  the throttle at its minimum. ACTIVE: govSum less than the output when the output is clamp(govSum) (no voltage compensation),
    //          else the output at gov_min_throttle or at the dynamic minimum (flight_governor.c:536-548, 958-962). LIMIT (no governor
    //          conditions): the output at max(idle, min) with the stick less (flight_governor.c:658-664);
    //   govP, govI, govD, govF  a governor term at its limit in ACTIVE
    const terms = Object.keys(TERM_LIMIT).map(k => [k, run[k]]).filter(([, a]) => a), margin = RULES.floor.margin, atMin = RULES.floor.atMin;
    const atMax = (i) => u[i] >= Math.max(RULES.saturation.minU, ctx.maxThr(lab[i]) - near);
    const termAt = {}; for (const [k, arr] of terms) termAt[k] = (i) => { if (!st || st[i] !== 4) return false; const L = ctx.termLim(k, lab[i]); return L !== null && L > 0 && Math.abs(arr[i]) >= L - RULES.terms.margin; };
    const floorAt = new Uint8Array(n);
    if (st && S) {
        const K = hs && Q && run.target ? kmotOf(run, ctx.fc) : null;
        for (let i = 0; i < n; i++) {
            if (st[i] !== 4) continue;
            const p = lab[i];
            if (ctx.gvOne(p)) { if (S[i] < u[i] - margin) floorAt[i] = 1; continue; }
            let m = ctx.minThr(p); const dyn = ctx.dynMin(p);
            if (dyn !== null && K && K.K[i] > Q[i] && Q[i] > 0) m = Math.max(m, dyn * run.target[i] / K.K[i]);
            if (Math.abs(u[i] - m) <= atMin) floorAt[i] = 1;
        }
    } else if (!st && ctx.limitMode && thr) {
        for (let i = 0; i < n; i++) { const m = Math.max(ctx.minThr(lab[i]), ctx.idleThr()); if (u[i] > 0 && u[i] <= m + atMin && thr[i] < u[i] - margin) floorAt[i] = 1; }
    }
    for (let i = 0; i < n; i++) if (floorAt[i]) P(lab[i]).floorS += dt;
    // ACTIVE: the terms, the throttle in ACTIVE flight (no rescue) for the headroom
    const stride = RULES.headroom.stride, lagN = Math.round(RULES.headroom.vbatLagS * rate), mine = new Map();
    if (st) for (let i = 0; i < n; i++) {
        if (st[i] !== 4) continue;
        const p = lab[i], Pp = P(p), mx = atMax(i), floor = floorAt[i] === 1;
        Pp.activeAllS += dt; if (u[i] < Pp.minU) Pp.minU = u[i]; if (u[i] > Pp.maxU) Pp.maxU = u[i];
        for (const [k, arr] of terms) { const T = Pp.terms[k], v = Math.abs(arr[i]); if (!isNum(v)) continue; T.n++; if (v > T.max) T.max = v; if (termAt[k](i)) { T.atS += dt; if (mx || floor) T.inSatS += dt; else T.outSatS += dt; } }
        if (!fl(i) || (resc && resc[i])) continue;
        const R = mine.get(p) || (mine.set(p, { act: 0, sat: 0, thr: [] }), mine.get(p));
        Pp.activeS += dt; R.act++; if (Q && Q[i] > 0) Pp.request.set(Math.round(Q[i]), (Pp.request.get(Math.round(Q[i])) || 0) + 1);
        if (mx) { Pp.satS += dt; R.sat++; }
        if (i % stride === 0) { Pp.thr.push(u[i]); R.thr.push(u[i]); if (V && V[i] > 0) { Pp.vb.push(V[i]); const v = V[Math.min(n - 1, i + lagN)]; if (!mx && v > 0) Pp.dv.push(u[i] * v); } }
    }
    for (const [p, R] of mine) if (R.act >= RULES.minProfileS * rate) { const Pp = P(p); Pp.shares.push(R.sat / R.act); Pp.p95s.push(quantile(R.thr, RULES.headroom.q)); Pp.p50s.push(median(R.thr)); }
    // the periods of each limit, with the other outputs at their limits at the same time and the headspeed error
    const gap = Math.round(RULES.saturation.gapS * rate), preds = [['max', atMax], ['floor', (i) => floorAt[i] === 1]].concat(terms.map(([k]) => [k, termAt[k]]));
    const period = (kind, a, e) => {
        let rs = false, lo = Infinity, hi = -Infinity;
        for (let k = a; k < e; k++) { if (resc && resc[k]) rs = true; if (hs && Q && Q[k] > 0) { const x = (hs[k] - Q[k]) / Q[k]; if (x < lo) lo = x; if (x > hi) hi = x; } }
        // overlap: the seconds of the period with each other output at its limit (CLAUDE.md "Control limits"; review 2026-10-15)
        const overlap = {}, others = preds.filter(([q, f]) => { if (q === kind) return false; let c = 0; for (let k = a; k < e; k++) if (f(k)) c++; if (c) overlap[q] = r2(c / rate, 3); return c > 0; }).map(([q]) => q), s = st ? st[a] : null;
        return { kind, log: run.log, profile: lab[a], t: at(a), t1: at(e), s: r2((e - a) / rate, 3), state: s === null ? null : STATES[s], phase: ph ? GD.PHASES[ph[a]] : null, rescue: rs, others, overlap,
            minError: isFinite(lo) ? r2(lo, 4) : null, maxError: isFinite(hi) ? r2(hi, 4) : null, active: s === 4 && fl(a) };
    };
    for (const [a, e] of spans(n, atMax, gap)) {
        // the cause: the headspeed at the start under RULES.saturation.lowShare of the target, or SPOOLUP, RECOVERY or BAILOUT: the ESC acceleration (critique C9, M4)
        const x = period('max', a, e), s = st ? st[a] : null, r0 = hs && Q && Q[a] > 0 ? hs[a] / Q[a] : null;
        M.periods.push(Object.assign(x, { iLimit: x.others.includes('govI'), cause: (r0 !== null && r0 < RULES.saturation.lowShare) || [2, 3, 8].includes(s) ? 'acceleration' : 'load' }));
    }
    for (const [a, e] of spans(n, i => floorAt[i] === 1, gap)) { M.floors.push(period('floor', a, e)); P(lab[a]).floorPeriods++; }
    for (const [k] of terms) for (const [a, e] of spans(n, termAt[k], gap)) M.termPeriods.push(Object.assign(period(k, a, e), { term: k }));
    // the RPM signal: the sudden changes of the headspeed signal of check G21 (health_gov spikeScan) by throttle band, against the time
    // at the maximum throttle (gov_max_throttle of each PID profile), in all flight phases with the governor in RECOVERY, ACTIVE or
    // FALLBACK (critique C14: the periods at the maximum throttle too)
    if (st && hs) {
        const P = HG.RULE.g21, cnt = (a) => a ? Float64Array.from(a, v => Math.round(1000 * v)) : null, o = { hs, motor: cnt(u), state: st, profile: lab, target: run.target || null, request: Q || null, rate, sum: cnt(S), t: at };
        o.vc = HG.vcompBlocks(o, P); o.ceiling = (p) => ceilingOf(ctx, p);
        G.items.push({ log: run.log, metrics: HG.spikeScan(o, P) });
    }
    // drift (vcomp): blocks of RULES.vcomp.blockS at a load near hover, the regression throttle = a + b V + c |collective| per profile
    const D = RULES.vcomp, Bn = Math.round(D.blockS * rate);
    if (V && st && run.coll) {
        const blocks = new Map();
        for (let k0 = 0; k0 + Bn <= n; k0 += Bn) {
            const p = lab[k0], uMax = D.uMax * ctx.maxThr(p); let c = 0, su = 0, sv = 0, sc = 0, sx = 0, sy = 0, sf = 0;
            for (let i = k0; i < k0 + Bn; i++) {
                if (st[i] !== 4 || !fl(i) || (resc && resc[i]) || lab[i] !== p || !(u[i] < uMax) || !(V[i] > 0)) continue;
                c++; su += u[i]; sv += V[Math.min(n - 1, i + lagN)]; sc += Math.abs(run.coll[i]); sx += Math.hypot(run.roll ? run.roll[i] : 0, run.pitch ? run.pitch[i] : 0); sy += Math.abs(run.yaw ? run.yaw[i] : 0);
                if (run.govF && isNum(run.govF[i])) sf += run.govF[i];
            }
            if (c < D.valid * Bn) continue;
            const cc = sc / c; if (cc < D.coll[0] || cc > D.coll[1] || sx / c > D.cyc || sy / c > D.yaw) continue;
            if (!blocks.has(p)) blocks.set(p, []); blocks.get(p).push({ u: su / c, v: sv / c, c: cc, x: sx / c, y: sy / c, f: run.govF ? sf / c : null, t: at(k0) });
        }
        for (const [p, b] of blocks) {
            if (b.length < D.minBlocks) continue;
            const e = D.endBlocks, v0 = b.slice(0, e).reduce((s, x) => s + x.v, 0) / e, v1 = b.slice(-e).reduce((s, x) => s + x.v, 0) / e;
            if (v0 - v1 < D.minDv) continue;
            const keys = ['c', 'x', 'y'].filter(k => { const m = b.reduce((s, x) => s + x[k], 0) / b.length; return b.reduce((s, x) => s + (x[k] - m) ** 2, 0) / b.length > 1e-8; });
            const f = lsq(b.map(x => [[1, x.v].concat(keys.map(k => x[k])), x.u]), 2 + keys.length); if (!f) continue;
            const um = b.reduce((s, x) => s + x.u, 0) / b.length, fm = run.govF ? b.reduce((s, x) => s + x.f, 0) / b.length : null;
            // the loop gain of the governor is proportional to the battery voltage: it changes by v1 / v0 - 1. The F-term is for the
            // voltage at the start: at the end it is short by F (v0 / v1 - 1) (critique C10)
            M.drift.push({ log: run.log, profile: p, n: b.length, v0: r2(v0, 2), v1: r2(v1, 2), points: r2(100 * f.x[1] * (v1 - v0), 2), se: f.se[1] === null ? null : r2(100 * Math.abs(v1 - v0) * f.se[1], 2),
                slope: r2(100 * f.x[1], 3), slopeSe: f.se[1] === null ? null : r2(100 * f.se[1], 3), oneOverV: r2(100 * um * (v0 / v1 - 1), 2), gain: r2(v1 / v0 - 1, 4),
                fMean: r2(fm, 4), fShort: fm === null ? null : r2(100 * fm * (v0 / v1 - 1), 2), t0: b[0].t, t1: b[b.length - 1].t });
        }
    }
}

// check G21 on the runs: the throttle maximum of label p for the detector (gov_max_throttle at this time: the CLI dump, the value of
// gov_params, else 100 %), and the pooled result (health_gov g21Pool) with the events of each run (log, frame seconds)
function ceilingOf(ctx, p) {
    const c = (ctx.current && ctx.current.byName.gov_max_throttle || {})[p], src = c && typeof c.source === 'string' ? c.source : 'unknown';
    return { value: Math.round(1000 * ctx.maxThr(p)), kind: /^CLI/.test(src) ? 'cli' : /^calculated/.test(src) ? 'pile' : 'assumed', source: src };
}
function g21Of(items) {
    const pool = HG.g21Pool(items, HG.DEFAULT_RULES.G21), spikes = [], fallbacks = [];
    for (const it of items) { const m = it.metrics; for (const x of m.spikes) spikes.push(Object.assign({ log: it.log }, x)); for (const x of m.fallbacks) fallbacks.push(Object.assign({ log: it.log }, x)); }
    return Object.assign(pool, { spikes: spikes.slice(0, 500), fallbacks: fallbacks.slice(0, 500), fires: Object.values(pool.byProfile).some(q => q.severity === 'flag') });
}
// check G21 for PID profile p of a measurement (ctx.M.glitch, or res.measures.glitch): { fires, to (the gov_max_throttle of the change, %),
// ceiling (%) } or null when check G21 does not give a change for p
function g21Change(G, p, maxThr) {
    const q = G && G.byProfile ? G.byProfile[String(p)] : null;
    if (!q || q.severity !== 'flag') return null;
    const vals = [...new Set((q.ceilings || []).map(c => c.value))], ceiling = vals.length === 1 ? vals[0] : isNum(maxThr) ? 100 * maxThr : null;
    return ceiling === null ? null : { fires: true, ceiling, to: Math.round(ceiling - HG.DEFAULT_RULES.G21.margin), test: q };
}

function measure(ctx) {
    const M = { census: { seconds: new Array(10).fill(0), entries: new Array(10).fill(0), stick: new Map(), pos: { low: new Array(10).fill(0), middle: new Array(10).fill(0), top: new Array(10).fill(0) },
        autorotations: [], holds: [], bypassS: 0 }, fallbacks: [], bailouts: [], spoolups: [], periods: [], floors: [], termPeriods: [], uMax: {}, prof: {}, drift: [],
        glitch: { items: [] }, rest: [],
        flights: ctx.flights.length, hasVoltage: ctx.flights.some(r => r.hasVoltage), hasCurrent: ctx.flights.some(r => r.hasCurrent),
        hasGovernor: ctx.flights.some(r => r.hasGovernor), hasState: ctx.flights.some(r => !!r.state && r.state.some(v => v > 0)), hasD: ctx.flights.some(r => !!r.govD) };
    for (const run of ctx.flights) measureRun(run, ctx.labels.get(run), ctx, M);
    M.glitch = g21Of(M.glitch.items);
    for (const P of Object.values(M.prof)) {
        P.p50 = median(P.thr); P.p95 = quantile(P.thr, RULES.headroom.q); P.p95Se = meanSe(P.p95s).se; P.p95Flights = P.p95s.length;
        P.dvq = quantile(P.dv, RULES.headroom.dvQ); P.vb01 = quantile(P.vb, RULES.headroom.vbQ); P.vb50 = median(P.vb);
        P.share = P.activeS > 0 ? P.satS / P.activeS : null; P.shareSe = meanSe(P.shares).se;
        P.headspeed = P.request.size ? [...P.request].sort((a, b) => b[1] - a[1])[0][0] : null;
        if (!isFinite(P.minU)) P.minU = null;
    }
    return M;
}
// the measurements without the large arrays (the result of tune)
function measureSummary(M) {
    const prof = {};
    for (const [p, P] of Object.entries(M.prof)) prof[p] = { activeS: r2(P.activeS, 2), activeAllS: r2(P.activeAllS, 2), satS: r2(P.satS, 3), share: r2(P.share, 5), shareSe: r2(P.shareSe, 5),
        p50: r2(P.p50, 4), p95: r2(P.p95, 4), p95Se: r2(P.p95Se, 4), p95Flights: P.p95Flights, dvq: r2(P.dvq, 2), vb01: r2(P.vb01, 2), vb50: r2(P.vb50, 2), headspeed: P.headspeed,
        floorS: r2(P.floorS, 3), floorPeriods: P.floorPeriods, minU: r2(P.minU, 4), maxU: r2(P.maxU, 4),
        terms: Object.fromEntries(Object.entries(P.terms).map(([k, T]) => [k, { lim: T.lim, max: r2(T.max, 4), atS: r2(T.atS, 3), inSatS: r2(T.inSatS, 3), outSatS: r2(T.outSatS, 3), n: T.n }])) };
    const C = M.census;
    return { flights: M.flights, census: { seconds: C.seconds.map(v => r2(v, 2)), entries: C.entries, stick: [...C.stick].filter(([, s]) => s >= 1).sort((a, b) => a[0] - b[0]).map(([c, s]) => ({ value: c, s: r2(s, 1) })),
        pos: Object.fromEntries(Object.entries(C.pos).map(([k, a]) => [k, a.map(v => r2(v, 2))])), autorotations: C.autorotations, holds: C.holds, bypassS: r2(C.bypassS, 2) },
        fallbacks: M.fallbacks, bailouts: M.bailouts, spoolups: M.spoolups, periods: M.periods.slice(0, 500), periodCount: M.periods.length, floors: M.floors.slice(0, 500), floorCount: M.floors.length,
        termPeriods: M.termPeriods.slice(0, 500), termPeriodCount: M.termPeriods.length, uMax: Object.fromEntries(Object.entries(M.uMax).map(([p, v]) => [p, r2(v, 4)])), drift: M.drift,
        glitch: { rule: 'G21', all: M.glitch.all, byProfile: M.glitch.byProfile, spikes: M.glitch.spikes, fallbacks: M.glitch.fallbacks }, rest: M.rest, prof };
}

// ---------------------------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------------------------

function row(ctx, name, p, o = {}) {
    const R = REG[name] || REL[name], scope = R.scope, pr = scope === 'profile' ? p : null;
    const cur = scope === 'related' ? ctx.current.related[name] || { value: null, source: 'unknown' } : (ctx.current.byName[name] || {})[scope === 'global' ? 0 : p] || { value: null, source: 'unknown', reason: GP.NOT_SHOWN.other };
    const out = Object.assign({ id: null, name, scope, profile: pr, family: R.family, topic: 'value', title: null, current: cur, status: 'keep', to: null, evidence: [], rule: 'value', method: 'rule',
        stale: cur.stale || null, cli: [], text: '', reason: null, record: null, inform: false }, o);
    if ((out.method === 'model' || out.method === 'simulation') && !Object.prototype.hasOwnProperty.call(o, 'stale')) out.stale = modelStale(ctx, name, pr, cur);
    out.id = `${name}|${pr === null ? 'g' : pr}|${out.topic}`;
    if (!out.title) out.title = `"${name}"${pr === null ? '' : ` (${prof(pr)})`}`;
    return out;
}
const ev = (text, value, unit, o = {}) => Object.assign({ text, value: isNum(value) ? value : value === undefined ? null : value, unit: unit || null, lo: null, hi: null, n: null, se: null, log: null, t0: null, t1: null }, o);
const valueText = (name, cur) => cur.value !== null && cur.value !== undefined ? `The value of "${name}" is ${show(cur.value)}${REG[name] && REG[name].unit && !/^0\.1$/.test(REG[name].unit) ? ` (${REG[name].unit})` : ''}.`
    : cur.lo !== null && cur.lo !== undefined ? `The log shows only that "${name}" is ${show(cur.lo)} or more.` : cur.hi !== null && cur.hi !== undefined ? `The log shows only that "${name}" is ${show(cur.hi)} or less.`
    : cur.candidates ? `The log shows only that "${name}" is ${and(cur.candidates.map(String)).replace(/ and /, ' or ')}.` : `The value of "${name}" is unknown.`;

// the other outputs at their limits during a period, and the largest headspeed error (CLAUDE.md "Control limits")
const OUT_NAME = { max: 'the throttle', floor: 'the throttle', govP: 'the P-term', govI: 'the I-term', govD: 'the D-term', govF: 'the F-term' };
// with the seconds of each other output at its limit in the period (x.overlap), two outputs in each sentence (STE Rule 6.3)
const othersText = (o, ov) => {
    const m = new Map(); for (const k of o || []) { const nm = OUT_NAME[k], v = ov && isNum(ov[k]) ? ov[k] : null; if (!m.has(nm) || (v !== null && (m.get(nm) === null || v > m.get(nm)))) m.set(nm, v); }
    const l = [...m]; if (!l.length) return '';
    if (l.some(([, v]) => v === null)) return ` At the same time, ${and(l.map(([n]) => n))} ${l.length === 1 ? 'is at its limit' : 'are at their limits'}.`;
    if (l.length === 1) return ` For ${fmt(l[0][1], 2)} s of this period, ${l[0][0]} is also at its limit.`;
    const out = []; for (let i = 0; i < l.length; i += 2) out.push(`${i ? 'It is' : 'In this period, the time at the limit is'} ${and(l.slice(i, i + 2).map(([n, v]) => `${fmt(v, 2)} s for ${n}`))}.`);
    return ` ${out.join(' ')}`;
};
const errText = (x) => { const lo = isNum(x.minError) ? -x.minError : 0, hi = isNum(x.maxError) ? x.maxError : 0;
    return +pct(lo, 1) > 0 && lo >= hi ? ` The headspeed is less than the target by a maximum of ${pct(lo, 1)} %.` : +pct(hi, 1) > 0 ? ` The headspeed is more than the target by a maximum of ${pct(hi, 1)} %.` : ''; };
const condText = (x) => `${x.state || 'governor condition unknown'}${x.cause ? `, ${x.cause === 'acceleration' ? 'ESC acceleration' : 'load'}` : ''}${x.rescue ? ', rescue' : ''}`;

const TEXT = {
    mode: {
        electric: 'The governor mode is ELECTRIC. Thus, the governor model and all governor parameters apply.',
        off: 'The governor mode is OFF. The governor parameters have no effect.',
        limit: 'The governor mode is LIMIT. The governor uses only "gov_idle_throttle", "gov_min_throttle" and "gov_max_throttle" as throttle limits. The other governor parameters have no effect.',
        offOrLimit: 'The log records no governor changes ("GOVERNOR_STATE") and no governor terms with the motor on. Thus, the governor mode is OFF or LIMIT.',
        direct: 'The governor mode is DIRECT. The governor does not use its PID terms. The governor model is for the mode ELECTRIC only.',
        nitro: 'The governor mode is NITRO. The governor model is for the mode ELECTRIC only.',
        unknown: 'The log does not show the governor mode. The analysis uses ELECTRIC. If the mode is not ELECTRIC, the results of the governor model do not apply.',
        // gov_sim configOf gives no mode for any flight log of the model (RULES.electricV): no closed loop (review 2026-10-15)
        noSim: (v) => `The log does not show the governor mode. The analysis uses the mode ELECTRIC only if the log records the battery current or a battery voltage of more than ${v} V. ` +
            'Thus, the governor model does not calculate the closed loop.',
        source: (s) => `The source of this value is ${quote(s)}.`,
        step: (k, logs) => `In ${logWords(logs)}, the throttle changes in one step ${many(k, 'time')} at the start of RECOVERY or BAILOUT. Only the mode ELECTRIC does this.`,
    },
    notApplicable: { off: 'The governor mode is OFF. Thus, this parameter has no effect.', limit: 'The governor mode is LIMIT. The governor uses only the throttle limits. Thus, this parameter has no effect.',
        offOrLimit: 'The governor mode is OFF or LIMIT. Thus, this parameter has no effect.', direct: 'The governor mode is DIRECT. The governor model is for the mode ELECTRIC only.',
        nitro: 'The governor mode is NITRO. The governor model is for the mode ELECTRIC only.', noFlight: 'The logs have no flight. The analysis does not use bench runs.' },
    limit: {
        ifLimit: 'If the governor mode is LIMIT, this value applies. If the mode is OFF, it has no effect.',
        idle: 'In LIMIT, the lowest throttle is the larger value of "gov_idle_throttle" and "gov_min_throttle".',
        handover: 'The firmware makes "gov_max_throttle" equal to or more than this value.',
        stick: (s, k) => `The throttle is at its minimum for ${fmt(s, 2)} s in ${many(k, 'period')}, while the throttle stick is less.`,
    },
    type: {
        FUNCTION: 'The throttle type is FUNCTION. The low switch position gives "gov_idle_throttle", the middle position gives "gov_auto_throttle", and the top position gives "gov_max_throttle".',
        SWITCH: 'The throttle type is SWITCH. The throttle stick sets the headspeed ("govRequest"). Thus, the analysis does not use the headspeed to find the PID profile.',
        NORMAL: 'The throttle type is NORMAL. The governor uses the throttle stick as the throttle in IDLE and AUTOROTATION.',
        stick: (list) => `The throttle stick ("rcCommand[4]") has ${many(list.length, 'value')}: ${and(list)}.`,
    },
    feature: { on: 'The log header shows that the feature GOVERNOR is on.', off: 'The log header shows that the feature GOVERNOR is off. Thus, the governor does not operate.',
        unknown: 'The log header does not record the features.' },
    autorotation: (k, x) => `The governor goes to AUTOROTATION ${many(k, 'time')} in the flight logs. The longest time in AUTOROTATION is ${fmt(x, 2)} s.`,
    autoMiddle: (m, k) => `With the throttle type FUNCTION, the middle switch position gives AUTOROTATION. In ${m} of ${k} times, the switch goes from the top position to the middle position in ACTIVE.`,
    autoTimeout: (k) => `${many(k, 'AUTOROTATION')} ${k === 1 ? 'stops' : 'stop'} at the time limit.`,
    bailout: (b) => `In log ${N(b.log)}, at ${fmt(b.t, 2)} s, BAILOUT starts with the headspeed at ${pct(b.share, 0)} % of the target. The start ramp of the ESC limits the acceleration of a slow rotor.`,
    bailoutAfter: (b) => `After BAILOUT, the throttle is at its maximum for ${fmt(b.satS, 2)} s. The headspeed is more than the target by ${pct(b.overshoot, 1)} %.`,
    bailoutDo: 'To stop the motor on the ground, set the throttle switch to the low position. If "gov_autorotation_timeout" is 0, the governor does not use AUTOROTATION and BAILOUT.',
    hold: (k, x, j) => `The governor goes to HOLD ${many(k, 'time')}. The longest time in HOLD is ${fmt(x, 2)} s.${j ? ` ${many(j, 'HOLD')} ${j === 1 ? 'stops' : 'stop'} at the time limit.` : ''}`,
    noHold: 'The governor does not go to HOLD in the flight logs.',
    // flight_governor.c 6.1 of firmware_parameters.md: idle is the lower limit of IDLE, HOLD, SPOOLUP, RECOVERY, BAILOUT and BYPASS; auto is
    // the lower limit of AUTOROTATION and the entry condition in >= auto
    idle: { all: 'The governor uses this throttle as the lower limit in IDLE, HOLD, SPOOLUP, RECOVERY, BAILOUT and BYPASS.',
        fn: 'With the throttle type FUNCTION, the low switch position sets the throttle to this value.' },
    auto: { all: 'The governor uses this throttle as the lower limit in AUTOROTATION.',
        entry: 'From ACTIVE, the governor goes to AUTOROTATION only if "gov_autorotation_timeout" is more than 0 and the throttle is at this value or more.',
        fn: 'With the throttle type FUNCTION, the middle switch position always gives AUTOROTATION when "gov_autorotation_timeout" is more than 0. Thus, a larger "gov_auto_throttle" does not stop AUTOROTATION.' },
    handover: 'The governor uses this throttle for the changes from IDLE to SPOOLUP, and from ACTIVE to AUTOROTATION or HOLD.',
    ramp: { gov_startup_time: 'the throttle increase in IDLE and HOLD', gov_spooldown_time: 'the throttle decrease in IDLE, HOLD and AUTOROTATION', gov_spoolup_time: 'the throttle increase in SPOOLUP',
        gov_recovery_time: 'the throttle in RECOVERY and BAILOUT' },
    rampText: (name, v) => `For ${TEXT.ramp[name]}, a throttle change of 100 % occurs in ${fmt(v / 10, 1)} s.`,
    spool: (o) => `After SPOOLUP, the headspeed is more than the target by ${pct(o.med, 1)} % (median of ${many(o.n, 'spool-up')}, ${pct(o.lo, 1)} % to ${pct(o.hi, 1)} %), and the limit is ${pct(RULES.spool.overshoot, 0)} %.`,
    spoolAccel: (a) => `In the last ${fmt(RULES.spool.lastS, 1)} s of SPOOLUP, the headspeed increases at ${fmt(a, 0)} rpm/s (median). The start ramp of the ESC can limit this value.`,
    spoolAir: 'Some of these spool-ups continue into the air. The rule uses the spool-ups on the ground.',
    spoolNone: 'The flight logs have no SPOOLUP that ends in ACTIVE at a constant headspeed target.',
    spoolEv: (s, o) => `Overshoot after SPOOLUP, log ${N(s.log)} at ${fmt(s.t, 1)} s (${prof(s.profile)})${s.byThrottle ? `, exit at ${pct(RULES.spool.exitShare, 0)} % of the maximum throttle` : ''}${o || ''}.`,
    tracking: (rate) => `In ACTIVE, the target changes at ${fmt(rate, 0)} rpm/s after a change of the headspeed target. After RECOVERY and BAILOUT, the target increases at this rate too.`,
    vcomp: {
        notAdc: (m) => `The voltage source is ${m} ("battery_meter"). With this source, the governor does not use voltage compensation, also with "gov_use_voltage_comp" ON.`,
        adc: 'The voltage source is ADC ("battery_meter"). Thus, voltage compensation can operate.',
        unknownInactive: 'In these logs, voltage compensation does not operate: the motor output is the same as "govSum".',
        unknownIf: 'If the voltage source ("battery_meter") is ADC, "gov_use_voltage_comp" ON gives voltage compensation. If it is ESC, this value has no effect.',
        active: 'In these logs, voltage compensation operates: the motor output is not the same as "govSum".',
        // d: { slope, se, n (logs), dv (V, median), points, pointsSe }
        drift: (d) => `At the same load, the throttle increases by ${fmt(d.slope, 1)}${isNum(d.se) ? ` ± ${fmt(d.se, 1)}` : ''} points for each 1 V decrease of the battery voltage (${many(d.n, 'log')}).`,
        dropped: (d) => `For the median voltage decrease in a flight (${fmt(d.dv, 2)} V), this is ${fmt(d.points, 1)}${isNum(d.pointsSe) ? ` ± ${fmt(d.pointsSe, 1)}` : ''} points.`,
        gain: (g) => `From the start to the end of a flight, the loop gain of the governor decreases by ${pct(g.mean, 1)}${isNum(g.se) ? ` ± ${pct(g.se, 1)}` : ''} % (${many(g.n, 'log')}).`,
        fShort: (f) => `At the end of the flight, the F-term is less than necessary by ${fmt(f.mean, 2)}${isNum(f.se) ? ` ± ${fmt(f.se, 2)}` : ''} points (${many(f.n, 'log')}).`,
        logEv: (x) => `Throttle increase at the same load, log ${N(x.log)}, ${prof(x.profile)}, ${fmt(x.v0, 2)} V to ${fmt(x.v1, 2)} V. With a throttle that changes as 1 / voltage, the increase is ${fmt(x.oneOverV, 1)} points.`,
        integral: 'The governor I-term compensates for this slow change.',
        noDrift: 'The flight logs do not have sufficient time at a hover load to measure the throttle change for a battery.',
        record: 'To find the voltage source, set "blackbox_log_esc" to ON for one flight. If "EscV" is the same as "Vbat", the source is the ESC.',
        pwr: 'This filter has an effect only with voltage compensation, and voltage compensation does not operate in these logs.',
    },
    cells: {
        auto: (v, l, k) => `The value 0 of "battery_cell_count" tells the firmware to find the cell count. With ${fmt(v, 2)} V at the start of log ${N(l)}, the firmware finds ${k} cells.`,
        noCli: (v, l, k) => `The log does not record "battery_cell_count". With ${fmt(v, 2)} V at the start of log ${N(l)}, the rule of the firmware gives ${k} cells.`,
        fixed: (k) => `The cell count is ${k}.`,
        unknown: 'The log does not record "battery_cell_count", and the battery voltage at the start of the logs does not give a cell count.',
        use: 'The governor uses the cell count only for voltage compensation.',
    },
    // govInitTTA (flight_governor.c:1523-1541) does not read tail_rotor_mode: the assist operates with gov_tta_gain and gov_tta_limit more than 0
    tta: {
        off: 'The tail torque assist is off, because "gov_tta_gain" or "gov_tta_limit" is 0.',
        mode: 'The tail torque assist operates only in the modes DIRECT and ELECTRIC.',
        effect: (L) => `With yaw, the governor increases the headspeed by a maximum of ${isNum(L) ? `${fmt(L, 0)} %` : 'the value of "gov_tta_limit"'}.`,
        variable: (m) => `The tail rotor mode is ${m} ("tail_rotor_mode"), and the tail torque assist is on.`,
        variableDo: 'If this is not necessary, set "gov_tta_gain" to 0.',
        variableUnknown: (m) => `The tail rotor mode is ${m} ("tail_rotor_mode"). The log does not show "gov_tta_gain". If it is more than 0, the governor increases the headspeed with yaw.`,
        motorized: 'The tail rotor has a tail motor. The governor model does not include the tail torque assist.',
        unknown: 'The log does not record "tail_rotor_mode", and the tail torque assist is on.',
        unknownGain: 'The log does not record "tail_rotor_mode" and "gov_tta_gain". If "gov_tta_gain" is more than 0, the governor increases the headspeed with yaw.',
        unknownDo: 'If the tail rotor has no tail motor, set "gov_tta_gain" to 0.',
        follows: 'The tail torque assist uses this value only when "gov_tta_gain" is more than 0.',
    },
    fallback: {
        title: (f) => `FALLBACK in log ${N(f.log)} at ${fmt(f.t, 2)} s`,
        start: (f) => `In log ${N(f.log)}, at ${fmt(f.t, 2)} s (${prof(f.profile)}), the governor goes to FALLBACK.`,
        throttle: (f) => `In FALLBACK, the throttle is ${pct(f.throttle, 1)} %${isNum(f.calc) ? `, and the rule of the firmware gives ${pct(f.calc, 1)} %` : isNum(f.ratio) ? `, which is ${fmt(f.ratio, 3)} × "govI"` : ''}.`,
        sag: (f) => `The headspeed decreases to ${pct(f.minShare, 0)} % of the target, and it stays at less than ${pct(RULES.fallback.sag, 0)} % for ${fmt(f.belowS, 2)} s.`,
        cause: (f) => `An error of the RPM signal starts FALLBACK, not the load.${f.atMax ? ' This FALLBACK starts with the throttle at its maximum.' : ''} Examine the RPM sensor, its wire and its supply.`,
        before: (f) => `Before FALLBACK, the throttle is ${pct(f.throttleBefore, 1)} %. It is at its maximum for ${fmt(f.satS, 2)} s, and the collective is ${pct(f.coll, 0)} % of its range.`,
        calcRule: (f) => `The rule is "govI" (${pct(f.govI, 1)} %) multiplied by (100 - ${f.drop}) / 100${f.precomp === 'ON' ? `, with "govF" (${pct(f.govF, 1)} %) added to "govI"` : ''}.`,
        on: (f) => `With "gov_use_fallback_precomp" ON, the FALLBACK throttle is ${pct(f.calcOn, 1)} %. RECOVERY starts at the same throttle as with "gov_use_fallback_precomp" OFF.`,
        recovery: (f) => `RECOVERY starts at a throttle of ${pct(f.recovery, 1)} %.${isNum(f.recoveryCalc) ? ` The headspeed divided by the motor constant (${f.kmot} rpm) gives ${pct(f.recoveryCalc, 1)} %.` : ''}`,
        back: (f) => `The governor is in ACTIVE again after ${fmt(f.activeS, 2)} s.${isNum(f.withinS) ? ` The headspeed is in ${pct(RULES.fallback.within, 1)} % of the target after ${fmt(f.withinS, 2)} s.` : ''}`,
        jump: (f) => `Near the start of FALLBACK, the headspeed signal is different from its filtered value by ${f.jump} rpm. The limit of the firmware is ${f.jumpLimit} rpm.`,
        jumpNote: 'The log records the headspeed after a different filter. Thus, the error of the raw signal is possibly larger.',
        vbat: (f) => `The battery voltage is ${fmt(f.vbat, 2)} V at the start of FALLBACK.`,
    },
    rpm: {
        title: 'Errors of the RPM signal at the maximum throttle',
        atMax: (k, m) => `${k} of ${many(m, 'FALLBACK')} start with the throttle at its maximum.`,
        // A: the pooled test of check G21 (health_gov g21Test)
        steps: (A) => `With the throttle at its maximum, the headspeed signal has ${many(A.k, 'sudden change')} in ${fmt(A.atMaxS, 1)} s. With the throttle less than the maximum, it has ${many(A.N - A.k, 'sudden change')} in ${fmt(A.belowS, 1)} s.`,
        test: (A) => `The test value of check G21 is \`P(X >= ${A.k}) = ${A.p}\` for \`X ~ Binomial(${A.N}, ${A.share})\`.`,
        expect: (x) => `The rate at less than the maximum throttle gives ${fmt(x, 2)} sudden changes in the time at the maximum throttle.`,
        g21: 'Check G21 of the analysis gives a lower "gov_max_throttle" for each PID profile with these errors.',
        levers: 'The flight controller uses "freq_input_pull", "freq_input_edge" and "freq_input_minhz" to read the RPM signal.',
        examine: 'Examine the RPM sensor, its wire and its supply. Make sure that the wire is not near the motor wires or the battery wires.',
        none: 'The flight logs have no FALLBACK and no error of the RPM signal at the maximum throttle.',
        other: 'The flight controller uses this value to read the RPM signal. The analysis cannot find its effect.',
        raw: 'The log does not record the raw RPM that the governor uses. The recorded headspeed has a different filter.',
        rawRecord: 'To record the raw RPM, set "debug_mode" to RPM_SOURCE for one flight.',
    },
    unlogged: (name, p, vals) => `The value of "${name}"${p !== null ? ` (${prof(p)})` : ''} changes between logs, and the log does not record the change. ${valuesText(vals)}`,
    unloggedTitle: (name, p) => `"${name}" changes between logs${p === null || p === undefined ? '' : ` (${prof(p)})`}`,
    // a product of gains that changes (gov_params EFFECTIVE) when no CLI name of it has a flag: factors are the CLI names that can cause it
    unloggedProduct: (names, p, vals, changed) => `The value of ${and(names.map(quote))} multiplied together${p > 0 || p === 0 ? ` (${prof(p)})` : ''} changes between logs, and the log does not record the change. ${valuesText(vals)} ${changed.length === 1 ? `The other governor values show that ${quote(changed[0])} changes.` : 'The log cannot show which of these values changes.'}`,
    floor: {
        min: (u) => `In ACTIVE, the lowest throttle is ${pct(u, 1)} %.`,
        contact: (s, k) => `The throttle is at its minimum for ${fmt(s, 2)} s in ${many(k, 'period')}, while "govSum" is less.`,
        contactVcomp: (s, k) => `The throttle is at its minimum for ${fmt(s, 2)} s in ${many(k, 'period')}.`,
        none: 'In ACTIVE, the throttle does not stay at its minimum.',
        need: 'A minimum throttle is necessary only with a bearing that turns freely in one direction. It is also necessary if the motor speed decreases after a fast load decrease.',
        dyn: 'This value has an effect only with "gov_use_dyn_min_throttle" ON.',
        period: (x) => `Log ${N(x.log)} at ${fmt(x.t, 2)} s: ${fmt(x.s, 2)} s at the minimum throttle (${condText(x)}).${othersText(x.others, x.overlap)}${errText(x)}`,
    },
    terms: {
        name: { govP: 'P-term', govI: 'I-term', govD: 'D-term', govF: 'F-term' },
        max: (t, x) => `In ACTIVE, the largest governor ${t} is ${pct(x, 1)} %.`,
        lim: (L) => `The limit is ${fmt(100 * L, 0)} %.`,
        unknown: (x) => `The limit is unknown. The log shows that it is ${Math.max(0, Math.ceil(100 * (x - RULES.terms.margin) - 1e-9))} % or more.`,
        at: (t, s, k, o) => `The ${t} is at its limit for ${fmt(s, 2)} s in ${many(k, 'period')}. Of this time, ${fmt(o, 2)} s are with the throttle not at a limit.`,
        none: 'The log does not record this term.',
        zero: (t, x) => `In ACTIVE, the governor ${t} is ${x > 0 ? `${pct(x, 1)} % or less` : '0'}. Thus, its limit has no effect.`,
        period: (t, x) => `Log ${N(x.log)} at ${fmt(x.t, 2)} s: the ${t} is at its limit for ${fmt(x.s, 2)} s (${condText(x)}).${othersText(x.others, x.overlap)}${errText(x)}`,
    },
    sat: {
        title: (p) => `Throttle at its maximum (${prof(p)})`,
        all: (mx, s, k) => `The throttle is at its maximum (${fmt(100 * mx, 0)} %) for ${fmt(s, 2)} s in ${many(k, 'period')}, in all flight phases.`,
        active: (s, sh) => `In ACTIVE flight, this is ${fmt(s, 2)} s (${pct(sh, 2)} % of the time).`,
        median: (d) => `In these periods, the headspeed is less than the target by ${pct(-d, 1)} % (median).`,
        accel: (k, s) => `${many(k, 'period')} (${fmt(s, 2)} s) ${k === 1 ? 'starts' : 'start'} in SPOOLUP, RECOVERY or BAILOUT, or with the headspeed at less than ${pct(RULES.saturation.lowShare, 0)} % of the target. The ESC acceleration causes ${k === 1 ? 'this period' : 'these periods'}, not the power.`,
        rescue: (k) => `${many(k, 'period')} ${k === 1 ? 'is' : 'are'} in a rescue.`,
        iLimit: (k) => `In ${many(k, 'period')}, the governor I-term is also at its limit.`,
        period: (x) => `Log ${N(x.log)} at ${fmt(x.t, 2)} s: ${fmt(x.s, 2)} s at the maximum throttle (${condText(x)}).${othersText(x.others, x.overlap)}${errText(x)}`,
        none: (p, mx, x) => `In ${prof(p)}, the throttle is not at its maximum (${fmt(100 * mx, 0)} %) in the flight logs.${isNum(x) ? ` The largest throttle is ${pct(x, 1)} %.` : ''}`,
        get assumed() { return `The log does not show "gov_max_throttle". The analysis uses ${SPEC.gov_max_throttle[1]} %.`; },
    },
    headroom: {
        p95: (R, x, se, n) => `In ACTIVE flight at ${R} rpm, the throttle is ${pct(x, 1)}${isNum(se) ? ` ± ${pct(se, 1)}` : ''} % or less for ${pct(RULES.headroom.q, 0)} % of the time (${many(n, 'flight')}).`,
        get lim() { return `The limit is ${pct(1 - RULES.headroom.reserve, 0)} %. This gives a reserve of ${pct(RULES.headroom.reserve, 0)} %.`; },
        p50: (x) => `The median throttle is ${pct(x, 1)} %.`,
        p95Ev: () => `In ACTIVE flight, the throttle is less than this value for ${pct(RULES.headroom.q, 0)} % of the time.`,
        dv: (v) => `For ${pct(RULES.headroom.dvQ, 0)} % of the samples at less than the maximum throttle, the throttle multiplied by the battery voltage is ${fmt(v, 2)} V or less. At a lower battery voltage, the throttle is not sufficient.`,
        censor: 'The samples at the maximum throttle are not in this value. Thus, the correct value is larger.',
        vb: (v) => `In ACTIVE flight, the battery voltage is ${fmt(v, 2)} V or more for ${pct(1 - RULES.headroom.vbQ, 0)} % of the time.`,
        none: 'The flight logs do not have sufficient time in ACTIVE flight for this PID profile.',
    },
    record: {
        esc: 'The log does not record "EscThr" and "EscPwm". They show the start ramp of the ESC and the throttle that the ESC uses.',
        escRecord: 'To record them, set "blackbox_log_esc" to ON for one flight.',
        escOn: 'The value is ON. The governor analysis does not use the ESC fields at this time.',
        ibat: 'The log does not record the battery output ("Ibat" is 0). The governor does not use "Ibat". The model uses it to find the motor resistance and the rotor inertia.',
        ibatRecord: 'If the ESC or the flight controller has a sensor for "Ibat", set "current_meter" to that source.',
        vbat: 'The log does not record the battery voltage.',
        vbatRecord: 'To record the battery voltage, set a voltage source ("battery_meter"). Then set "blackbox_log_battery" to ON.',
        battery: 'The log records the battery voltage and the battery output ("Ibat").',
        bypass: 'The governor does not go to BYPASS in the flight logs.',
        dFilter: () => `The governor D-term ("govD") is ${pct(RULES.terms.dVisible, 2)} % or less in the log. Thus, the log cannot show the effect of "gov_d_filter".`,
        dRecord: 'To record the D-term more accurately, set "debug_mode" to GOVERNOR for one flight.',
        dOff: 'The value of "gov_d_gain" is 0. Thus, "gov_d_filter" has no effect.',
    },
    validation: {
        max: (h) => `"gov_max_throttle" must be equal to or more than "gov_handover_throttle" (${h}).`,
        min: (m) => `"gov_min_throttle" must be equal to or less than "gov_max_throttle" (${m}).`,
        idle: (k) => `"gov_idle_throttle" must be equal to or less than ${k}, because of "gov_handover_throttle".`,
        auto: (lo, hi) => `"gov_auto_throttle" must be from ${lo} to ${hi}, because of "gov_idle_throttle" and "gov_handover_throttle".`,
        handover: (lo, hi) => `If "gov_handover_throttle" is not from ${lo} to ${hi}, the firmware changes the other throttle values.`,
        result: (v, x) => `The firmware changes the value ${v} to ${x}. Thus, there is no CLI text.`,
    },
    value: { keep: 'The analysis has no rule that changes this value.' },
    pending: 'This part of the analysis is not available at this time.',
};
// the model families: the names (and PID profiles) that each one gives a row for, and its STE description (the numbers from RULES)
const MODEL_INFO = {
    gains: { names: ['gov_gain', 'gov_p_gain', 'gov_i_gain', 'gov_d_gain'], method: 'simulation', scenario: 'R, E, M',
        text: 'The governor model flies the recorded flights again with each gain step. It compares the headspeed error and the margin to an oscillation.' },
    precomp: { names: ['gov_f_gain', 'gov_collective_ff_weight', 'gov_cyclic_ff_weight', 'gov_yaw_ff_weight', 'gov_collective_curve'], method: 'model', scenario: 'R',
        text: 'The governor model calculates the throttle that the collective, the cyclic and the yaw add. The feedforward values come from this throttle.' },
    limits: { names: ['gov_p_limit', 'gov_i_limit', 'gov_d_limit', 'gov_f_limit'], method: 'simulation', scenario: 'R, E',
        text: 'The governor model finds the term values that are necessary for the flights. A limit must stop a term only when the throttle is at its limit.' },
    filters: { names: ['gov_rpm_filter', 'gov_ff_filter', 'gov_d_filter'], method: 'simulation', scenario: 'R, G, M',
        text: 'The governor model compares the time delay of each filter with the vibration that it removes. "gov_rpm_filter" also changes the limit of the RPM signal errors.' },
    power: { names: ['gov_headspeed'], method: 'model', scenario: 'E, F',
        get text() { return `The governor model calculates the throttle that is necessary for the load at the end of a battery. It finds the largest headspeed with a reserve of ${pct(RULES.headroom.reserve, 0)} %.`; } },
    spoolup: { names: ['gov_spoolup_time', 'gov_use_pid_spoolup', 'gov_startup_time', 'gov_spooldown_time'], method: 'simulation', scenario: 'S',
        get text() { return `The governor model flies the spool-up with the start ramp of the ESC that it measures. It finds the time that keeps the overshoot at ${pct(RULES.spool.overshoot, 0)} % or less.`; },
        textOf: { gov_startup_time: 'The governor model flies the throttle increase in IDLE and the start of the motor.', gov_spooldown_time: 'The governor model flies the throttle decrease in IDLE, HOLD and AUTOROTATION.',
            gov_autorotation_timeout: 'The governor model flies the BAILOUT from a slow rotor with the start ramp of the ESC that it measures. It shows the time at the maximum throttle and the overshoot.' } },
    tracking: { names: ['gov_tracking_time'], method: 'simulation', scenario: 'R, G',
        text: 'The governor model changes the target at different rates. The target must not increase faster than the rotor can follow without the maximum throttle.' },
    fallback: { names: ['gov_recovery_time', 'gov_fallback_drop', 'gov_use_fallback_precomp'], method: 'simulation', scenario: 'G',
        text: 'The governor model adds an error of the RPM signal at each period with the throttle at its maximum. It compares the decrease of the headspeed for each value.' },
    maxThrottle: { names: ['gov_max_throttle'], method: 'simulation', scenario: 'G, E',
        get text() { return `The governor model calculates the power that a lower maximum throttle removes. A value of ${pct(RULES.glitch.trial[0], 0)} % to ${pct(RULES.glitch.trial[1], 0)} % is a test for the RPM signal errors at the maximum throttle.`; } },
    bypass: { names: ['gov_bypass_throttle'], method: 'model', scenario: 'F',
        text: 'The governor model calculates the throttle curve that holds the headspeed at each collective position. The pilot selects the use of BYPASS.' },
};

// a 'pending-model' row of family f for each of its names and PID profiles (no governor model given: tune() without o.model). ctx.modelState
// (the model does not apply: the governor mode, no flight) or ctx.modelReason (the identification failed, or the validation rejects the
// model): then 'not-applicable' rows with that reason
function pendingRows(ctx, f, extra = []) {
    const I = MODEL_INFO[f], out = [], why = ctx.modelState || ctx.modelReason || null;
    for (const name of I.names.concat(extra)) for (const p of REG[name].scope === 'global' ? [0] : ctx.profiles) {
        if (ctx.limitMode && LIMIT_NAMES.includes(name)) continue;
        const o = { topic: 'model', family: REG[name].family, rule: 'model', method: I.method, evidence: (ctx.modelEvidence[name] || (() => []))(p) };
        out.push(why ? row(ctx, name, p, Object.assign(o, { status: 'not-applicable', reason: why, text: why }))
            : row(ctx, name, p, Object.assign(o, { status: 'pending-model', reason: NOTES.model, text: `${(I.textOf && I.textOf[name]) || I.text} ${TEXT.pending}` })));
    }
    return out;
}
// the names that apply in the mode LIMIT (flight_governor.c:658-664, the validation 1468-1486)
const LIMIT_NAMES = ['gov_max_throttle', 'gov_min_throttle', 'gov_idle_throttle', 'gov_handover_throttle'];
const MODEL = {
    gains: (ctx) => pendingRows(ctx, 'gains'), precomp: (ctx) => pendingRows(ctx, 'precomp'), limits: (ctx) => pendingRows(ctx, 'limits'),
    filters: (ctx) => pendingRows(ctx, 'filters'),
    power: (ctx) => pendingRows(ctx, 'power', ctx.meter === 'ADC' ? ['gov_use_voltage_comp', 'gov_pwr_filter'] : []),   // vcomp with ADC: the twin with and without
    spoolup: (ctx) => pendingRows(ctx, 'spoolup', ctx.M.bailouts.some(b => b.low) ? ['gov_autorotation_timeout'] : []),  // a bailout from a slow rotor: the soft start limit
    tracking: (ctx) => pendingRows(ctx, 'tracking'), fallback: (ctx) => pendingRows(ctx, 'fallback'), maxThrottle: (ctx) => pendingRows(ctx, 'maxThrottle'),
    bypass: (ctx) => pendingRows(ctx, 'bypass'),
};

// --- the rule rows ---

function modeRows(ctx) {
    const c = ctx.current.byName.gov_mode[0], ms = ctx.modeKey, known = c.value !== null && c.value !== undefined;
    // the throttle steps at the start of RECOVERY and BAILOUT (gov_params items: n steps in each log)
    const items = ctx.rec.items.filter(i => i.name === 'gov_mode' && i.value === 'ELECTRIC'), k = items.reduce((s, i) => s + (isNum(i.n) ? i.n : 1), 0);
    const logs = [...new Set(items.map(i => i.log).filter(l => l !== null && l !== undefined))];
    const evs = k ? [ev(TEXT.mode.step(k, logs), k, 'times', { n: k, log: logs.length ? logs[0] : null })] : [];
    const src = known ? ` ${TEXT.mode.source(c.source)}` : '';
    const o = { electric: { status: 'keep', text: TEXT.mode.electric + src }, off: { status: 'check', inform: true, text: TEXT.mode.off + src, title: 'The governor does not operate' },
        limit: { status: 'check', inform: true, text: TEXT.mode.limit + src, title: 'The governor mode is LIMIT' },
        offOrLimit: { status: 'check', inform: true, text: TEXT.mode.offOrLimit, title: 'The governor does not operate' },
        direct: { status: 'keep', inform: true, text: TEXT.mode.direct + src, title: 'The governor mode is DIRECT' }, nitro: { status: 'keep', inform: true, text: TEXT.mode.nitro + src, title: 'The governor mode is NITRO' },
        unknown: { status: 'check', text: `${ctx.noModeSim ? TEXT.mode.noSim(require('./gov_sim.cjs').RULES.electricV) : TEXT.mode.unknown}${!known && c.reason ? ` ${c.reason}` : ''}`, title: 'The governor mode is unknown' } }[ms];
    return [row(ctx, 'gov_mode', 0, Object.assign({ rule: 'mode', method: 'firmware', evidence: evs }, o))];
}
function typeRows(ctx) {
    const c = ctx.current.byName.gov_throttle_type[0], C = ctx.M.census, v = typeof c.value === 'string' ? c.value : null;
    const stick = [...C.stick].filter(([, s]) => s >= 1).sort((a, b) => a[0] - b[0]);
    const evs = stick.length && stick.length <= 6 ? [ev(TEXT.type.stick(stick.map(([x, s]) => `${fmt(x / 10, 1)} % (${fmt(s, 0)} s)`)), stick.length, 'values', { n: stick.length })] : [];
    if (!v) return [row(ctx, 'gov_throttle_type', 0, { rule: 'throttleType', status: 'not-recorded', evidence: evs, reason: c.reason || null, text: `${valueText('gov_throttle_type', c)}${c.reason ? ` ${c.reason}` : ''}` })];
    return [row(ctx, 'gov_throttle_type', 0, { rule: 'throttleType', method: 'firmware', status: v === 'SWITCH' ? 'check' : 'keep', evidence: evs, text: TEXT.type[v] || valueText('gov_throttle_type', c),
        title: v === 'SWITCH' ? 'The throttle type SWITCH sets the headspeed' : null })];
}
function featureRow(ctx) {
    const c = ctx.current.related['feature GOVERNOR'], v = c.value;
    return [row(ctx, 'feature GOVERNOR', null, { rule: 'feature', method: 'firmware', status: v === 'ON' ? 'keep' : v === 'OFF' ? 'check' : 'not-recorded', inform: v === 'OFF',
        text: v === 'ON' ? TEXT.feature.on : v === 'OFF' ? TEXT.feature.off : TEXT.feature.unknown, title: v === 'OFF' ? 'The feature GOVERNOR is off' : null })];
}
function censusRows(ctx) {
    const C = ctx.M.census, out = [], fn = ctx.type === 'FUNCTION', A = C.autorotations, cur = (n) => ctx.current.byName[n][0];
    // gov_autorotation_timeout (critique C7)
    {
        const c = cur('gov_autorotation_timeout'), mid = A.filter(a => a.from === 'ACTIVE' && a.pos === 'middle').length, fromA = A.filter(a => a.from === 'ACTIVE').length;
        const lim = isNum(c.value) ? A.filter(a => a.next === 'IDLE' && Math.abs(a.s - c.value) <= 0.1).length : 0, longest = A.reduce((s, a) => Math.max(s, a.s), 0);
        const t = [A.length ? TEXT.autorotation(A.length, longest) : 'The governor does not go to AUTOROTATION in the flight logs.'];
        if (fn && fromA) t.push(TEXT.autoMiddle(mid, fromA));
        if (lim) t.push(TEXT.autoTimeout(lim));
        t.push(valueText('gov_autorotation_timeout', c));
        out.push(row(ctx, 'gov_autorotation_timeout', 0, { rule: 'census', status: c.value === null && !A.length ? 'not-recorded' : 'keep', reason: c.value === null ? c.reason : null, text: t.join(' '),
            evidence: [ev('Number of times in AUTOROTATION.', A.length, 'times', { n: A.length }), ev('Number of times from ACTIVE to AUTOROTATION with the switch at the middle position.', mid, 'times', { n: fromA })] }));
        // a BAILOUT from a stopped or slow rotor (Fireball log 10 type): a check for each
        for (const b of ctx.M.bailouts.filter(x => x.low)) out.push(row(ctx, 'gov_autorotation_timeout', 0, { topic: `bailout:${b.log}:${b.t}`, rule: 'bailout', status: 'check', method: 'data',
            title: `BAILOUT from a slow rotor (log ${N(b.log)}, ${fmt(b.t, 1)} s)`, text: [TEXT.bailout(b), TEXT.bailoutAfter(b), TEXT.bailoutDo].join(' '),
            evidence: [ev('Headspeed at the start of BAILOUT.', b.hs, 'rpm', { log: b.log, t0: b.t }), ev('Headspeed at the start of BAILOUT, as a part of the target.', b.share, 'fraction', { log: b.log, t0: b.t }),
                ev('Time at the maximum throttle after BAILOUT.', b.satS, 's', { log: b.log, t0: b.t }), ev('Headspeed more than the target after BAILOUT.', b.overshoot, 'fraction', { log: b.log, t0: b.t })] }));
    }
    // gov_throttle_hold_timeout
    {
        const c = cur('gov_throttle_hold_timeout'), H = C.holds, lim = isNum(c.value) ? H.filter(h => Math.abs(h.s - c.value / 10) <= 0.1 && (h.next === 'OFF' || h.next === 'IDLE')).length : 0;
        const longest = H.reduce((s, h) => Math.max(s, h.s), 0);
        out.push(row(ctx, 'gov_throttle_hold_timeout', 0, { rule: 'census', status: c.value === null && !H.length ? 'not-recorded' : 'keep', reason: c.value === null ? c.reason : null,
            text: `${H.length ? TEXT.hold(H.length, longest, lim) : TEXT.noHold} ${valueText('gov_throttle_hold_timeout', c)}${c.value === null && c.reason ? ` ${c.reason}` : ''}`,
            evidence: [ev('Number of times in HOLD.', H.length, 'times', { n: H.length })] }));
    }
    // gov_idle_throttle, gov_auto_throttle (critique C5, C7)
    for (const name of ['gov_idle_throttle', 'gov_auto_throttle']) {
        const c = cur(name), t = [valueText(name, c)], s = name === 'gov_idle_throttle' ? C.seconds[1] : C.seconds[7];
        if (name === 'gov_idle_throttle') t.push(...(fn ? [TEXT.idle.fn] : []), TEXT.idle.all); else t.push(TEXT.auto.all, fn ? TEXT.auto.fn : TEXT.auto.entry);
        out.push(row(ctx, name, 0, { rule: 'census', status: c.value === null ? 'not-recorded' : 'keep', reason: c.value === null ? c.reason : null, text: `${t.join(' ')}${c.value === null && c.reason ? ` ${c.reason}` : ''}`,
            evidence: [ev(name === 'gov_idle_throttle' ? 'Time in IDLE.' : 'Time in AUTOROTATION.', r2(s, 2), 's')] }));
    }
    // gov_handover_throttle
    { const c = cur('gov_handover_throttle');
        out.push(row(ctx, 'gov_handover_throttle', 0, { rule: 'census', status: c.value === null && c.lo === null ? 'not-recorded' : 'keep', reason: c.value === null ? c.reason : null,
            text: `${valueText('gov_handover_throttle', c)} ${TEXT.handover}${c.value === null && c.lo === null && c.reason ? ` ${c.reason}` : ''}`, evidence: c.lo !== null && c.lo !== undefined ? [ev('Lower limit from the log.', c.lo, '%')] : [] })); }
    return out;
}
function rampRows(ctx) {
    const out = [];
    for (const name of ['gov_startup_time', 'gov_spooldown_time', 'gov_recovery_time']) {
        const c = ctx.current.byName[name][0], t = [valueText(name, c)]; if (isNum(c.value) && c.value > 0) t.push(TEXT.rampText(name, c.value));
        if (name === 'gov_recovery_time' && ctx.M.fallbacks.length) t.push('After FALLBACK, RECOVERY increases the throttle at this rate.');
        out.push(row(ctx, name, 0, { rule: 'value', status: c.value === null ? 'not-recorded' : 'keep', reason: c.value === null ? c.reason : null, text: `${t.join(' ')}${c.value === null && c.reason ? ` ${c.reason}` : ''}`,
            evidence: isNum(c.se) ? [ev('Value that the analysis calculates from the throttle slope.', c.estimate === undefined ? c.value : c.estimate, '0.1 s', { se: c.se })] : [] }));
    }
    // gov_tracking_time (critique M6: the target after RECOVERY and BAILOUT)
    { const c = ctx.current.byName.gov_tracking_time[0], it = ctx.rec.items.filter(i => i.name === 'gov_tracking_time' && i.detail && i.detail.length);
        const rates = it.flatMap(i => i.detail.map(d => Math.abs(d.rpmPerS))).filter(isNum), t = [valueText('gov_tracking_time', c)];
        if (rates.length) t.push(TEXT.tracking(median(rates)));
        out.push(row(ctx, 'gov_tracking_time', 0, { rule: 'value', status: c.value === null ? 'not-recorded' : 'keep', reason: c.value === null ? c.reason : null, text: t.join(' '),
            evidence: rates.length ? [ev('Target slope after a change of the headspeed target (median).', r2(median(rates), 0), 'rpm/s', { n: rates.length, lo: r2(Math.min(...rates), 0), hi: r2(Math.max(...rates), 0) })] : [] })); }
    return out;
}
function spoolRows(ctx) {
    // the spool-ups of the logs of the value at this time (the overshoot depends on the ramp: critique C6), on the ground if possible (M17)
    const c = ctx.current.byName.gov_spoolup_time[0], all = ctx.M.spoolups.filter(s => !s.excluded && s.overshoot !== null), logs = c.from === 'log' && c.logs ? c.logs : null;
    const SP = logs && all.some(s => logs.includes(s.log)) ? all.filter(s => logs.includes(s.log)) : all, other = all.filter(s => !SP.includes(s));
    const ground = SP.filter(s => !s.airborne), use = ground.length ? ground : SP;
    const epochOf = (l) => { const e = ctx.rec.epochs.find(x => x.name === 'gov_spoolup_time' && x.logs.includes(l)); return e ? e.value : null; };
    if (!use.length) return [row(ctx, 'gov_spoolup_time', 0, { rule: 'spool', status: c.value === null ? 'not-recorded' : 'keep', reason: c.value === null ? c.reason : null, text: `${valueText('gov_spoolup_time', c)} ${TEXT.spoolNone}` })];
    const os = use.map(s => s.overshoot), o = { med: median(os), lo: Math.min(...os), hi: Math.max(...os), n: os.length }, acc = use.map(s => s.accel).filter(isNum);
    const t = [TEXT.spool(o)]; if (acc.length) t.push(TEXT.spoolAccel(median(acc))); if (ground.length && ground.length < SP.length) t.push(TEXT.spoolAir); t.push(valueText('gov_spoolup_time', c));
    const bad = o.med > RULES.spool.overshoot, air = SP.filter(s => !use.includes(s));
    return [row(ctx, 'gov_spoolup_time', 0, { rule: 'spool', method: 'data', status: bad ? 'check' : 'keep', title: bad ? 'Headspeed overshoot after SPOOLUP' : null, text: t.join(' '),
        evidence: use.map(s => ev(TEXT.spoolEv(s), s.overshoot, 'fraction', { log: s.log, t0: s.t }))
            .concat(air.map(s => ev(TEXT.spoolEv(s, ', in the air (not in the rule)'), s.overshoot, 'fraction', { log: s.log, t0: s.t })))
            .concat(acc.length ? [ev(`Headspeed increase in the last ${fmt(RULES.spool.lastS, 1)} s of SPOOLUP (median).`, r2(median(acc), 0), 'rpm/s', { n: acc.length, lo: Math.min(...acc), hi: Math.max(...acc) })] : [])
            .concat(other.map(s => ev(TEXT.spoolEv(s, `, with "gov_spoolup_time" ${show(epochOf(s.log))} in that log${s.airborne ? ', in the air' : ''}`), s.overshoot, 'fraction', { log: s.log, t0: s.t }))) })];
}
function vcompRows(ctx) {
    const out = [], meter = ctx.meter, M = ctx.M;
    // the drift for a battery: the PID profiles of one log together (the slope weighted by the blocks, the voltage span of the log),
    // then the mean and its standard error over the logs. The per-flight value uses one voltage decrease: the median of the logs
    const driftOf = (p) => {
        const d = M.drift.filter(x => p === null || x.profile === p); if (!d.length) return null;
        const byLog = new Map(); for (const x of d) { if (!byLog.has(x.log)) byLog.set(x.log, []); byLog.get(x.log).push(x); }
        const logs = [...byLog.values()].map(l => { const w = l.reduce((s, x) => s + x.n, 0), mean = (k) => l.every(x => isNum(x[k])) ? l.reduce((s, x) => s + x[k] * x.n, 0) / w : null;
            return { perV: -mean('slope'), perVSe: l.length === 1 ? l[0].slopeSe : null, dv: Math.max(...l.map(x => x.v0)) - Math.min(...l.map(x => x.v1)), gain: -mean('gain'), fShort: mean('fShort') }; });
        const m = meanSe(logs.map(x => x.perV)), dv = median(logs.map(x => x.dv));
        if (m.n === 1 && isNum(logs[0].perVSe)) m.se = logs[0].perVSe;
        return { slope: m.mean, se: m.se, n: m.n, dv, points: m.mean * dv, pointsSe: isNum(m.se) ? m.se * dv : null, gain: meanSe(logs.map(x => x.gain)), fShort: meanSe(logs.map(x => x.fShort)), list: d };
    };
    // the text (STE: 6 sentences or less in a paragraph) gives the drift; the evidence also gives the loop gain and the F-term (GOVERNOR_AUTOTUNE.md 5)
    const dText = (d) => [TEXT.vcomp.drift(d), TEXT.vcomp.dropped(d)];
    const dEv = (d) => d ? [ev(`${TEXT.vcomp.drift(d)} ${TEXT.vcomp.dropped(d)}`, r2(d.points, 2), 'points', { se: r2(d.pointsSe, 2), n: d.n })]
        .concat(isNum(d.gain.mean) ? [ev(TEXT.vcomp.gain(d.gain), r2(d.gain.mean, 4), 'fraction', { se: r2(d.gain.se, 4), n: d.gain.n })] : [])
        .concat(isNum(d.fShort.mean) ? [ev(TEXT.vcomp.fShort(d.fShort), r2(d.fShort.mean, 2), 'points', { se: r2(d.fShort.se, 2), n: d.fShort.n })] : [])
        .concat(d.list.map(x => ev(TEXT.vcomp.logEv(x), x.points, 'points', { se: x.se, n: x.n, log: x.log, t0: x.t0, t1: x.t1, profile: x.profile }))) : [];
    const all = driftOf(null), anyEffect = ctx.profiles.map(p => ctx.current.byName.gov_use_voltage_comp[p].effect), inactive = anyEffect.every(e => e !== 'active') && anyEffect.some(e => e === 'inactive');
    // battery_meter (the vcomp explanation, critique M10)
    { const t = []; let status = 'keep', inform = false, title = null, record = null;
        if (meter && meter !== 'ADC') { t.push(TEXT.vcomp.notAdc(meter)); inform = true; title = 'Voltage compensation has no effect with this voltage source'; }
        else if (meter === 'ADC') t.push(TEXT.vcomp.adc);
        else if (inactive) { t.push(TEXT.vcomp.unknownInactive, TEXT.vcomp.unknownIf); status = 'check'; title = 'The voltage source is unknown'; record = TEXT.vcomp.record; }
        else t.push('The log does not record "battery_meter".');
        if (all && meter !== 'ADC') t.push(...dText(all), TEXT.vcomp.integral); else if (!all && M.hasVoltage) t.push(TEXT.vcomp.noDrift);
        if (!M.hasVoltage) { status = 'not-recorded'; t.push(TEXT.record.vbat); inform = true; title = 'The log does not record the battery voltage'; record = TEXT.record.vbatRecord; }
        out.push(row(ctx, 'battery_meter', null, { rule: 'vcomp', method: 'firmware', status, inform, title, record, text: t.join(' '), evidence: dEv(all) })); }
    // gov_use_voltage_comp for each PID profile
    for (const p of ctx.profiles) {
        const c = ctx.current.byName.gov_use_voltage_comp[p], d = driftOf(p), t = [];
        let status = 'keep', reason = null;
        if (meter && meter !== 'ADC') { status = 'not-applicable'; reason = TEXT.vcomp.notAdc(meter); t.push(reason); }
        else if (meter === 'ADC') t.push(TEXT.vcomp.adc, valueText('gov_use_voltage_comp', c));
        else { t.push(c.effect === 'active' ? TEXT.vcomp.active : c.effect === 'inactive' ? TEXT.vcomp.unknownInactive : valueText('gov_use_voltage_comp', c)); if (c.effect !== 'active') t.push(TEXT.vcomp.unknownIf); }
        if (d) t.push(TEXT.vcomp.drift(d), TEXT.vcomp.dropped(d));
        out.push(row(ctx, 'gov_use_voltage_comp', p, { rule: 'vcomp', method: 'firmware', status, reason, text: t.join(' '), evidence: dEv(d) }));
    }
    // gov_pwr_filter
    { const on = ctx.profiles.some(p => norm(ctx.current.byName.gov_use_voltage_comp[p].value) === 'ON');
        const na = (meter && meter !== 'ADC') || inactive || (meter === 'ADC' && !on), c = ctx.current.byName.gov_pwr_filter[0];
        out.push(row(ctx, 'gov_pwr_filter', 0, { rule: 'vcomp', method: 'firmware', status: na ? 'not-applicable' : 'keep', reason: na ? TEXT.vcomp.pwr : null, text: na ? `${TEXT.vcomp.pwr} ${valueText('gov_pwr_filter', c)}` : valueText('gov_pwr_filter', c) })); }
    // battery_cell_count (0 = auto: health_power.autoCells on the rest voltage)
    { const c = ctx.current.related.battery_cell_count, h = (ctx.flights[0] || {}).header || {}, vc = Array.isArray(h.vbatcellvoltage) ? h.vbatcellvoltage : null;
        const lev = (v) => isNum(v) && v > 0 ? (v > 100 ? v / 100 : v / 10) : null, min = lev(vc ? vc[0] : h.vbatmincellvoltage) || 3.3, max = lev(vc ? vc[2] : h.vbatmaxcellvoltage) || 4.3;
        const HP = optional(() => require('./health_power.cjs')), rest = ctx.M.rest[0] || null;
        const auto = (v) => HP ? HP.autoCells(v, min, max) : RULES.cells.auto.find(k => v >= k * min - 1e-9 && v <= k * max + 1e-9) || null, k = rest ? auto(rest.v) : null;
        let text, mapped = null;
        if (isNum(Number(c.value)) && c.value !== null && Number(c.value) > 0) { text = TEXT.cells.fixed(Number(c.value)); mapped = Number(c.value); }
        else if (k && Number(c.value) === 0 && c.value !== null) { text = TEXT.cells.auto(rest.v, rest.log, k); mapped = k; }
        else if (k) { text = TEXT.cells.noCli(rest.v, rest.log, k); mapped = k; }
        else text = TEXT.cells.unknown;
        out.push(row(ctx, 'battery_cell_count', null, { rule: 'cells', method: 'firmware', status: mapped ? 'keep' : 'not-recorded', text: `${text} ${TEXT.cells.use}`, cells: mapped,
            evidence: ctx.M.rest.slice(0, 6).map(x => ev(`Battery voltage before the motor starts, log ${N(x.log)}.`, x.v, 'V', { log: x.log })) })); }
    return out;
}
// the tail torque assist (flight_governor.c:1523-1541): it operates in DIRECT and ELECTRIC with gov_tta_gain and gov_tta_limit more than 0,
// in each tail rotor mode. With a tail rotor that has no tail motor (VARIABLE), an assist that is on is a check
function ttaRows(ctx) {
    const tm = ctx.current.related.tail_rotor_mode, m = tm.value === null || tm.value === undefined ? null : String(tm.value).toUpperCase(), out = [];
    const stateOf = (p) => { const g = ctx.num('gov_tta_gain', p), L = ctx.num('gov_tta_limit', p);
        if (ctx.modeKey === 'nitro') return { status: 'not-applicable', text: TEXT.tta.mode };
        if (g === 0 || L === 0) return { status: 'not-applicable', text: TEXT.tta.off };
        if (g === null) return m === 'VARIABLE' ? { status: 'not-recorded', text: TEXT.tta.variableUnknown(m) } : m ? { status: 'keep', text: TEXT.tta.motorized }
            : { status: 'check', text: `${TEXT.tta.unknownGain} ${TEXT.tta.unknownDo}`, title: 'The tail torque assist without a known tail rotor mode' };
        if (m === 'VARIABLE') return { status: 'check', text: `${TEXT.tta.variable(m)} ${TEXT.tta.effect(L)} ${TEXT.tta.variableDo}`, title: 'The tail torque assist is on with a tail rotor that has no tail motor' };
        if (m) return { status: 'keep', text: TEXT.tta.motorized };
        return { status: 'check', text: `${TEXT.tta.unknown} ${TEXT.tta.effect(L)} ${TEXT.tta.unknownDo}`, title: 'The tail torque assist without a known tail rotor mode' };
    };
    const na = (x) => x.status === 'not-applicable';
    for (const p of ctx.profiles) {
        const x = stateOf(p), c = ctx.current.byName.gov_tta_limit[p];
        out.push(row(ctx, 'gov_tta_gain', p, { rule: 'tta', method: 'firmware', status: x.status, reason: na(x) || x.status === 'not-recorded' ? x.text : null, text: x.text, title: x.status === 'check' ? x.title : null }));
        // the limit follows the gain: one check is sufficient
        out.push(row(ctx, 'gov_tta_limit', p, { rule: 'tta', method: 'firmware', status: na(x) ? 'not-applicable' : c.value === null ? 'not-recorded' : 'keep', reason: na(x) ? x.text : c.value === null ? c.reason : null,
            text: na(x) ? x.text : `${valueText('gov_tta_limit', c)} ${TEXT.tta.follows}` }));
    }
    { const xs = ctx.profiles.map(stateOf), off = xs.every(na), c = ctx.current.byName.gov_tta_filter[0];
        out.push(row(ctx, 'gov_tta_filter', 0, { rule: 'tta', method: 'firmware', status: off ? 'not-applicable' : c.value === null ? 'not-recorded' : 'keep', reason: off ? xs[0].text : c.value === null ? c.reason : null,
            text: off ? xs[0].text : `${valueText('gov_tta_filter', c)} ${TEXT.tta.follows}` })); }
    return out;
}
function fallbackRows(ctx) {
    const out = [], M = ctx.M, F = M.fallbacks, G = M.glitch;
    for (const f of F) {
        const evs = [ev(TEXT.fallback.before(f), f.satS, 's', { log: f.log, t0: f.t }), ev(TEXT.fallback.throttle(f), f.throttle, 'fraction', { log: f.log, t0: f.t })];
        if (isNum(f.calc)) evs.push(ev(TEXT.fallback.calcRule(f), f.calc, 'fraction', { log: f.log, t0: f.t }));
        if (isNum(f.calcOn) && f.precomp !== 'ON') evs.push(ev(TEXT.fallback.on(f), f.calcOn, 'fraction', { log: f.log, t0: f.t }));
        if (isNum(f.recovery)) evs.push(ev(TEXT.fallback.recovery(f), f.recovery, 'fraction', { log: f.log, t0: f.t }));
        evs.push(ev(TEXT.fallback.sag(f), f.minShare, 'fraction', { log: f.log, t0: f.t, t1: f.t1 }));
        if (isNum(f.activeS)) evs.push(ev(TEXT.fallback.back(f), f.activeS, 's', { log: f.log, t0: f.t }));
        evs.push(ev(`${TEXT.fallback.jump(f)} ${TEXT.fallback.jumpNote}`, f.jump, 'rpm', { log: f.log, t0: f.t }));
        if (isNum(f.vbat)) evs.push(ev(TEXT.fallback.vbat(f), f.vbat, 'V', { log: f.log, t0: f.t }));
        out.push(row(ctx, 'gov_fallback_drop', f.profile, { topic: `fallback:${f.log}:${f.t}`, rule: 'fallback', method: 'data', status: 'check', title: TEXT.fallback.title(f),
            text: [TEXT.fallback.start(f), TEXT.fallback.throttle(f), TEXT.fallback.sag(f), TEXT.fallback.cause(f)].join(' '), evidence: evs }));
    }
    // the RPM signal: the association with the maximum throttle (critique C14) by the detector and the test of check G21 (health_gov),
    // the levers (freq_input_*), the raw RPM (debug_mode)
    const A = G.all, atMax = F.filter(f => f.atMax).length, problem = F.length > 0 || A.k > 0 || G.fires, below = A.belowS > 0 ? (A.N - A.k) / A.belowS : null;
    const assoc = [ev(TEXT.rpm.steps(A), A.k, 'times', { n: A.N })];
    if (isNum(A.p) && A.N > 0) assoc.push(ev(TEXT.rpm.test(A), A.p, null, { n: A.N }));
    if (isNum(below) && A.atMaxS > 0) assoc.push(ev(TEXT.rpm.expect(below * A.atMaxS), r2(below * A.atMaxS, 3), 'times'));
    if (F.length) assoc.unshift(ev(TEXT.rpm.atMax(atMax, F.length), atMax, 'times', { n: F.length }));
    ctx.assoc = assoc;
    out.push(row(ctx, 'freq_input_pull', null, { rule: 'glitch', method: 'data', status: problem ? 'check' : 'keep', title: problem ? TEXT.rpm.title : null, evidence: assoc,
        text: problem ? [F.length ? TEXT.rpm.atMax(atMax, F.length) : TEXT.rpm.steps(A), G.fires ? TEXT.rpm.g21 : '', TEXT.rpm.levers, TEXT.rpm.examine].filter(Boolean).join(' ') : `${TEXT.rpm.none} ${TEXT.rpm.levers}` }));
    for (const name of ['freq_input_edge', 'freq_input_minhz']) out.push(row(ctx, name, null, { rule: 'glitch', status: 'keep', text: TEXT.rpm.other }));
    const dm = ctx.current.related.debug_mode;
    out.push(row(ctx, 'debug_mode', null, { rule: 'notRecorded', status: norm(dm.value) === 'RPM_SOURCE' ? 'keep' : 'not-recorded', inform: problem && norm(dm.value) !== 'RPM_SOURCE', text: TEXT.rpm.raw, record: TEXT.rpm.rawRecord,
        title: problem ? 'The log does not record the raw RPM' : null }));
    return out;
}
function unloggedRows(ctx) {
    const out = [], by = new Map();
    for (const f of ctx.rec.flags) for (const name of (PRODUCT_OF[f.name] || !REG[f.name] ? [] : [f.name])) { const k = `${name}|${f.profile}`; if (!by.has(k)) by.set(k, []); by.get(k).push(f); }
    for (const [k, list] of by) {
        const [name, p] = k.split('|'), pr = REG[name].scope === 'profile' ? +p : 0, vals = [...new Map(list.map(f => [String(f.value), `${f.value} in ${logWords(f.logs)}`])).values()];
        out.push(row(ctx, name, pr, { topic: 'unlogged', rule: 'unlogged', method: 'data', status: 'check', title: TEXT.unloggedTitle(name, REG[name].scope === 'profile' ? pr : null), text: TEXT.unlogged(name, REG[name].scope === 'profile' ? pr : null, vals),
            evidence: list.map(f => ev(`Value in ${logWords(f.logs)}.`, typeof f.value === 'number' ? f.value : null, REG[name].unit, { n: f.logs.length, log: f.logs[0] })) }));
    }
    // a product of gains that changes when no CLI name that can cause it has a flag in that PID profile (critique C1: the yaw weight
    // of the Gaui in PID profiles 2 and 3). The row is for the name that the other values show, else for the name of this product only
    for (const c of productChanges(ctx.rec).values()) {
        const names = PRODUCT_OF[c.name], cands = c.changed.length ? c.changed : names;
        if (cands.some(n => ctx.rec.flags.some(f => f.name === n && f.profile === c.profile))) continue;
        const own = names.find(n => !Object.keys(PRODUCT_OF).some(k => k !== c.name && PRODUCT_OF[k].includes(n)));
        const target = c.changed.length === 1 ? c.changed[0] : own && cands.includes(own) ? own : cands[cands.length - 1];
        const vals = [...new Map(c.flags.map(f => [String(f.value), `${sig(f.value)} in ${logWords(f.logs)}`])).values()];
        out.push(row(ctx, target, c.profile, { topic: `unlogged:${c.name}`, rule: 'unlogged', method: 'data', status: 'check',
            title: c.changed.length === 1 ? TEXT.unloggedTitle(target, c.profile) : `"${target}" or a value that it multiplies changes between logs (${prof(c.profile)})`, text: TEXT.unloggedProduct(names, c.profile, vals, c.changed),
            evidence: c.flags.map(f => ev(`Value in ${logWords(f.logs)}.`, typeof f.value === 'number' ? f.value : null, null, { n: f.logs.length, log: f.logs[0] })) }));
    }
    return out;
}
// the control limits (CLAUDE.md "Control limits"): a row for each PID profile with rows, and for each other label (a short PID profile,
// PID profile unknown) that has a period at the limit. Each period is evidence, with its time, its duration, the other outputs at their
// limits and the headspeed error
function floorRows(ctx) {
    const out = [];
    for (const p of ctx.limitProfiles) {
        const P = ctx.M.prof[p], FP = ctx.M.floors.filter(x => x.profile === p), main = ctx.profiles.includes(p);
        if (!main && !FP.length) continue;
        const c = ctx.current.byName.gov_min_throttle[p], contact = FP.length > 0, s = P ? P.floorS : FP.reduce((a, x) => a + x.s, 0);
        const contactText = ctx.limitMode ? TEXT.limit.stick : ctx.gvOne(p) ? TEXT.floor.contact : TEXT.floor.contactVcomp;
        const evs = [ev('Time with the throttle at its minimum.', r2(s, 3), 's', { n: FP.length })];
        if (P && isNum(P.minU)) evs.push(ev('Lowest throttle in ACTIVE.', r2(P.minU, 4), 'fraction'));
        for (const x of FP) evs.push(ev(TEXT.floor.period(x), x.s, 's', { log: x.log, t0: x.t, t1: x.t1 }));
        const t = (P && isNum(P.minU) ? [TEXT.floor.min(P.minU)] : []).concat(contact ? [contactText(s, FP.length)] : P && !ctx.limitMode ? [TEXT.floor.none] : []);
        out.push(row(ctx, 'gov_min_throttle', p, { rule: 'floor', method: 'data', status: contact ? 'check' : c.value === null && !P ? 'not-recorded' : 'keep', title: contact ? `Throttle at its minimum (${prof(p)})` : null,
            text: t.concat([valueText('gov_min_throttle', c), ctx.limitMode ? TEXT.limit.idle : TEXT.floor.need]).join(' '), evidence: evs }));
        if (!main || ctx.limitMode) continue;
        const cd = ctx.current.byName.gov_use_dyn_min_throttle[p], cm = ctx.current.byName.gov_dyn_min_throttle[p];
        out.push(row(ctx, 'gov_use_dyn_min_throttle', p, { rule: 'floor', method: 'data', status: contact ? 'check' : cd.value === null && !P ? 'not-recorded' : 'keep',
            text: t.concat([valueText('gov_use_dyn_min_throttle', cd), TEXT.floor.need]).join(' '), evidence: evs.slice(0, 2) }));
        const off = norm(cd.value) === 'OFF';
        out.push(row(ctx, 'gov_dyn_min_throttle', p, { rule: 'floor', status: off ? 'not-applicable' : cm.value === null ? 'not-recorded' : 'keep', reason: off ? TEXT.floor.dyn : cm.value === null ? cm.reason : null,
            text: `${valueText('gov_dyn_min_throttle', cm)} ${off ? TEXT.floor.dyn : ''}`.trim() }));
    }
    return out;
}
function termRows(ctx) {
    const out = [];
    for (const p of ctx.limitProfiles) for (const [k, name] of Object.entries(TERM_LIMIT)) {
        const P = ctx.M.prof[p], T = P ? P.terms[k] : null, tn = TEXT.terms.name[k], c = ctx.current.byName[name][p], main = ctx.profiles.includes(p);
        const TP = ctx.M.termPeriods.filter(x => x.profile === p && x.term === k);
        if (!main && !TP.length) continue;
        if (!T || !T.n) { out.push(row(ctx, name, p, { rule: 'terms', status: c.value === null ? 'not-recorded' : 'keep', text: `${TEXT.terms.none} ${valueText(name, c)}` })); continue; }
        if (T.max < RULES.terms.margin && !TP.length) { out.push(row(ctx, name, p, { rule: 'terms', method: 'data', status: 'keep', text: `${TEXT.terms.zero(tn, T.max)} ${valueText(name, c)}`, evidence: [ev(`Largest governor ${tn} in ACTIVE.`, r2(T.max, 4), 'fraction', { n: T.n })] })); continue; }
        const t = [TEXT.terms.max(tn, T.max), T.lim !== null ? TEXT.terms.lim(T.lim) : TEXT.terms.unknown(T.max)];
        if (TP.length) t.push(TEXT.terms.at(tn, T.atS, TP.length, T.outSatS));
        out.push(row(ctx, name, p, { rule: 'terms', method: 'data', status: TP.length ? 'check' : 'keep', title: TP.length ? `The governor ${tn} at its limit (${prof(p)})` : null, text: t.join(' '),
            evidence: [ev(`Largest governor ${tn} in ACTIVE.`, r2(T.max, 4), 'fraction', { n: T.n }), ev('Time at the limit, with the throttle at a limit.', r2(T.inSatS, 3), 's'),
                ev('Time at the limit, with the throttle not at a limit.', r2(T.outSatS, 3), 's', { n: TP.length })].concat(TP.map(x => ev(TEXT.terms.period(tn, x), x.s, 's', { log: x.log, t0: x.t, t1: x.t1 }))) }));
    }
    return out;
}
function saturationRows(ctx) {
    const out = [];
    for (const p of ctx.limitProfiles) {
        const P = ctx.M.prof[p], c = ctx.current.byName.gov_max_throttle[p], mx = ctx.maxThr(p), per = ctx.M.periods.filter(x => x.profile === p), main = ctx.profiles.includes(p);
        if (!main && !per.length) continue;
        const t = [], evs = [], tot = per.reduce((s, x) => s + x.s, 0), acc = per.filter(x => x.cause === 'acceleration'), resc = per.filter(x => x.rescue).length, act = P && P.activeS > 0;
        if (per.length) {
            t.push(TEXT.sat.all(mx, tot, per.length)); if (act) t.push(TEXT.sat.active(P.satS, P.share));
            const errs = per.filter(x => x.cause === 'load' && isNum(x.minError)).map(x => x.minError), me = errs.length ? median(errs) : null; if (isNum(me) && +pct(-me, 1) > 0) t.push(TEXT.sat.median(me));
            if (acc.length) t.push(TEXT.sat.accel(acc.length, acc.reduce((s, x) => s + x.s, 0)));
            if (act) evs.push(ev('Time at the maximum throttle in ACTIVE flight, as a part of the time.', r2(P.share, 5), 'fraction', { se: r2(P.shareSe, 5), n: P.shares.length }));
            if (resc) evs.push(ev(TEXT.sat.rescue(resc), resc, 'periods'));
            const il = per.filter(x => x.iLimit).length; if (il) evs.push(ev(TEXT.sat.iLimit(il), il, 'periods'));
            for (const x of per) evs.push(ev(TEXT.sat.period(x), x.s, 's', { log: x.log, t0: x.t, t1: x.t1 }));
        } else t.push(TEXT.sat.none(p, mx, isNum(ctx.M.uMax[p]) ? ctx.M.uMax[p] : null));
        if (c.value === null) t.push(TEXT.sat.assumed);
        out.push(row(ctx, 'gov_max_throttle', p, { rule: 'saturation', method: 'data', status: per.length ? 'check' : 'keep', title: per.length ? TEXT.sat.title(p) : null, text: t.join(' '), evidence: evs }));
    }
    return out;
}
function headroomRows(ctx) {
    const out = [], H = RULES.headroom, lim = 1 - H.reserve;
    for (const p of ctx.profiles) {
        const P = ctx.M.prof[p], c = ctx.current.byName.gov_headspeed[p];
        if (!P || P.activeS < RULES.minProfileS || P.p95 === null) { out.push(row(ctx, 'gov_headspeed', p, { rule: 'headroom', status: c.value === null ? 'not-recorded' : 'keep', text: `${TEXT.headroom.none} ${valueText('gov_headspeed', c)}` })); continue; }
        const R = isNum(c.value) ? c.value : P.headspeed, se = P.p95Se, over = isNum(se) ? P.p95 - 2 * se > lim : P.p95 > lim;
        const t = [TEXT.headroom.p95(R, P.p95, se, P.p95Flights), TEXT.headroom.lim, TEXT.headroom.p50(P.p50)];
        const evs = [ev(TEXT.headroom.p95Ev(), r2(P.p95, 4), 'fraction', { se: r2(se, 4), n: P.p95Flights }), ev('Median throttle in ACTIVE flight.', r2(P.p50, 4), 'fraction')];
        if (isNum(P.dvq)) { evs.push(ev(`${TEXT.headroom.dv(P.dvq)} ${TEXT.headroom.censor}`, r2(P.dvq, 2), 'V')); if (isNum(P.vb01)) evs.push(ev(TEXT.headroom.vb(P.vb01), r2(P.vb01, 2), 'V')); }
        out.push(row(ctx, 'gov_headspeed', p, { rule: 'headroom', method: 'data', status: over ? 'check' : 'keep', title: over ? `Small throttle reserve (${prof(p)})` : null, text: t.join(' '), evidence: evs }));
    }
    return out;
}
function recordRows(ctx) {
    const out = [], M = ctx.M, esc = ctx.current.related.blackbox_log_esc, on = norm(esc.value) === 'ON';
    out.push(row(ctx, 'blackbox_log_esc', null, { rule: 'notRecorded', status: on ? 'keep' : 'not-recorded', text: on ? TEXT.record.escOn : TEXT.record.esc, record: on ? null : TEXT.record.escRecord }));
    out.push(row(ctx, 'blackbox_log_battery', null, { rule: 'notRecorded', status: M.hasVoltage && M.hasCurrent ? 'keep' : 'not-recorded', inform: !M.hasVoltage,
        text: !M.hasVoltage ? TEXT.record.vbat : !M.hasCurrent ? TEXT.record.ibat : TEXT.record.battery, record: !M.hasVoltage ? TEXT.record.vbatRecord : !M.hasCurrent ? TEXT.record.ibatRecord : null,
        title: !M.hasVoltage ? 'The log does not record the battery voltage' : null }));
    // gov_bypass_throttle: the log shows it only in BYPASS
    { const c = ctx.current.byName.gov_bypass_throttle[0], used = M.census.bypassS > 0;
        out.push(row(ctx, 'gov_bypass_throttle', 0, { rule: 'notRecorded', status: c.value === null ? 'not-recorded' : 'keep', reason: c.value === null ? c.reason : null,
            text: `${used ? `The governor is in BYPASS for ${fmt(M.census.bypassS, 1)} s.` : TEXT.record.bypass} ${valueText('gov_bypass_throttle', c)}${c.value === null && c.reason ? ` ${c.reason}` : ''}` })); }
    // gov_d_filter: D = 0 or below the log resolution (critique: only the model can examine it)
    { const c = ctx.current.byName.gov_d_filter[0], dz = ctx.profiles.every(p => ctx.current.byName.gov_d_gain[p].value === 0);
        const small = ctx.profiles.every(p => { const T = M.prof[p] && M.prof[p].terms.govD; return !T || !T.n || T.max <= RULES.terms.dVisible; });
        out.push(row(ctx, 'gov_d_filter', 0, { rule: 'notRecorded', status: dz ? 'not-applicable' : small ? 'not-recorded' : 'keep', reason: dz ? TEXT.record.dOff : small ? TEXT.record.dFilter() : null,
            record: !dz && small ? TEXT.record.dRecord : null, text: `${dz ? TEXT.record.dOff : small ? TEXT.record.dFilter() : ''} ${valueText('gov_d_filter', c)}`.trim() })); }
    return out;
}
// one row for each name (and PID profile) that has no row: its value and source, else why the log does not show it
function defaultRows(ctx, rows) {
    const out = [], has = new Set(rows.map(r => `${r.name}|${r.profile === null ? 'g' : r.profile}`));
    for (const R of REGISTRY) for (const p of R.scope === 'global' ? [0] : ctx.profiles) {
        if (has.has(`${R.name}|${R.scope === 'global' ? 'g' : p}`)) continue;
        const c = ctx.current.byName[R.name][p], known = c.value !== null && c.value !== undefined;
        out.push(row(ctx, R.name, p, ctx.modelState && R.name !== 'gov_mode' ? { status: 'not-applicable', reason: ctx.modelState, text: ctx.modelState }
            : { rule: 'value', status: known ? 'keep' : 'not-recorded', reason: known ? null : c.reason, text: `${valueText(R.name, c)} ${known ? TEXT.value.keep : c.reason || ''}`.trim() }));
    }
    for (const R of RELATED) if (!has.has(`${R.name}|g`)) out.push(row(ctx, R.name, null, { rule: 'value', status: 'keep', text: valueText(R.name, ctx.current.related[R.name] || { value: null }) }));
    return out;
}
function ruleRows(ctx) {
    const rows = modeRows(ctx).concat(featureRow(ctx));
    if (ctx.modeKey === 'off' || !ctx.flights.length) return rows;
    if (ctx.limitMode) return rows.concat(limitModeRows(ctx));
    return rows.concat(typeRows(ctx), censusRows(ctx), rampRows(ctx), spoolRows(ctx), vcompRows(ctx), ttaRows(ctx), fallbackRows(ctx), unloggedRows(ctx), floorRows(ctx),
        termRows(ctx), saturationRows(ctx), headroomRows(ctx), recordRows(ctx));
}
// the mode LIMIT (or OFF or LIMIT): u = clamp(stick, max(idle, min), max) (flight_governor.c:658-664). The throttle limits apply and are
// examined. gov_handover_throttle sets the lower limit of gov_max_throttle (the validation, 1468-1486). The other names have no effect
function limitModeRows(ctx) {
    const cur = (n) => ctx.current.byName[n][0], out = saturationRows(ctx).concat(floorRows(ctx));
    for (const [name, add, rule] of [['gov_idle_throttle', TEXT.limit.idle, 'floor'], ['gov_handover_throttle', TEXT.limit.handover, 'validation']]) {
        const c = cur(name);
        out.push(row(ctx, name, 0, { rule, method: 'firmware', status: c.value === null ? 'not-recorded' : 'keep', reason: c.value === null ? c.reason : null, text: `${valueText(name, c)} ${add}` }));
    }
    if (ctx.modeKey === 'offOrLimit') for (const r of out) r.text = `${r.text} ${TEXT.limit.ifLimit}`;
    return out;
}
// the measured evidence that a model row shows, for each name: (p) -> evidence
function modelEvidence(ctx) {
    const E = {}, eff = (name, p) => ctx.rec.epochs.filter(e => e.name === name && e.profile === p);
    // the logs in a sentence of their own: with 14 logs one sentence has more than 25 words (STE Rule 6.3)
    const prod = (name, label) => (p) => eff(name, p).map(e => ev(`${label}. The value is from ${logWords(e.logs)}.`, e.estimate, null, { se: e.se, n: e.n }));
    E.gov_p_gain = prod('gov_kp_effective', 'The value of "gov_gain" multiplied by "gov_p_gain", calculated from the log');
    E.gov_i_gain = prod('gov_ki_effective', 'The value of "gov_gain" multiplied by "gov_i_gain", calculated from the log');
    for (const w of GP.WEIGHTS) E[w] = prod(w.replace('_weight', '_effective'), `The value of "gov_gain" multiplied by "gov_f_gain" and "${w}", calculated from the log`);
    E.gov_max_throttle = () => ctx.assoc || [];
    E.gov_fallback_drop = (p) => ctx.M.fallbacks.filter(f => f.profile === p).map(f => ev(`${TEXT.fallback.title(f)}: the headspeed decreases to ${pct(f.minShare, 0)} % of the target.`, f.minShare, 'fraction', { log: f.log, t0: f.t }));
    E.gov_use_fallback_precomp = (p) => ctx.M.fallbacks.filter(f => f.profile === p && isNum(f.calcOn)).map(f => ev(TEXT.fallback.on(f), f.calcOn, 'fraction', { log: f.log, t0: f.t }));
    return E;
}
// the rows of the model families: families[k] (gov_search and gov_scenarios, familiesOf) replaces MODEL[k]; when the model does not apply
// (ctx.modelState) or is not available (ctx.modelReason), the 'not-applicable' rows of MODEL with that reason
function modelRows(ctx, families) {
    const out = [];
    for (const k of Object.keys(MODEL)) { const f = !ctx.modelState && !ctx.modelReason && families && typeof families[k] === 'function' ? families[k] : MODEL[k]; out.push(...(f(ctx) || [])); }
    return out;
}
// the families of the governor model: gov_search (precomp, gains, filters, limits: ctx.sim) and gov_scenarios (power, spoolup, tracking,
// fallback, maxThrottle, bypass), from their results o.search and o.scenarios. null without them (the 'pending-model' rows)
function familiesOf(o) {
    if (!o.search && !o.scenarios) return null;
    const out = {};
    if (o.scenarios) Object.assign(out, require('./gov_scenarios.cjs').families(o.scenarios));
    if (o.search) Object.assign(out, require('./gov_search.cjs').FAMILIES);
    return out;
}

// ---------------------------------------------------------------------------------------------
// recommendations (advice.exportScript)
// ---------------------------------------------------------------------------------------------

// the source of a value in the words of the CLI file comment of advice.exportScript ("the value at this time is from the <source>"). A value
// that the analysis calculates: "analysis of the log" (its method is in the row: a longer sentence than STE Rule 6.3 permits)
const fromSourceOf = (s) => typeof s !== 'string' || !s || s === 'unknown' ? null : s.replace(/^calculated from the log: [^]*$/, 'analysis of the log');
// the firmware validation of the throttle values (flight_governor.c:1468-1486; firmware_parameters.md 6.10) against the other values at
// this time: { text } when the firmware changes v (no CLI text), { note } when a value that the rule needs is unknown, else null
function validationOf(name, v, p, ctx) {
    const num = ctx && typeof ctx.num === 'function' ? ctx.num : () => null, V = TEXT.validation, unknown = (n) => ({ note: `The firmware also limits this value with ${quote(n)}, and its value at this time is unknown.` });
    const h = num('gov_handover_throttle', 0), idle = num('gov_idle_throttle', 0), auto = num('gov_auto_throttle', 0), top = h === null ? null : Math.min(10 * h - 1, 250);
    const out = (lo, hi, why) => v < lo || v > hi ? { text: `${why} ${V.result(v, clamp(v, lo, hi))}` } : null;
    if (name === 'gov_max_throttle') return h === null ? unknown('gov_handover_throttle') : out(h, 100, V.max(h));
    if (name === 'gov_min_throttle') { const m = p > 0 ? num('gov_max_throttle', p) : null; return m === null ? unknown('gov_max_throttle') : out(10, m, V.min(m)); }
    if (name === 'gov_idle_throttle') return top === null ? unknown('gov_handover_throttle') : out(0, top, V.idle(top));
    if (name === 'gov_auto_throttle') return top === null ? unknown('gov_handover_throttle') : out(idle === null ? 0 : idle, top, V.auto(idle === null ? 0 : idle, top));
    if (name === 'gov_handover_throttle') {
        const maxes = (ctx && ctx.profiles || []).filter(q => q > 0).map(q => num('gov_max_throttle', q)).filter(isNum), lo = Math.max(10, Math.ceil((Math.max(idle || 0, auto || 0) + 1) / 10)), hi = maxes.length ? Math.min(...maxes) : 100;
        return v < lo || v > hi ? { text: `${V.handover(lo, hi)} Thus, there is no CLI text.` } : null;
    }
    return null;
}
// the values of the firmware rules of advice.govLinks that the analysis knows, as CLI values: the global values and those of PID profile p.
// fromSets has them (review 2026-10-15): else the CLI file says that a known value is unknown
const LINKED = { global: ['gov_mode', 'gov_throttle_type', 'gov_handover_throttle', 'gov_idle_throttle', 'gov_auto_throttle'],
    profile: ['gov_max_throttle', 'gov_min_throttle', 'gov_use_fallback_precomp', 'gov_use_voltage_comp', 'gov_use_pid_spoolup', 'gov_use_dyn_min_throttle'] };
function linkedOf(ctx, p) {
    const out = {}, by = ctx && ctx.current && ctx.current.byName;
    if (!by) return out;
    for (const [sc, names] of Object.entries(LINKED)) for (const n of names) {
        const c = sc === 'global' ? (by[n] || {})[0] : p > 0 ? (by[n] || {})[p] : null, v = c && !c.conflict ? cliValue(n, c.value) : null;
        if (v !== null) out[n] = REG[n].type === 'int' ? Number(v) : v;
    }
    return out;
}
// a row as a recommendation: change -> 'action' with CLI text; a change with no CLI text -> 'check'; check -> 'check'; a row that the pilot
// must know (inform) -> 'info'. No CLI for an unknown PID profile, an unknown value at this time, a CLI dump that does not agree with the
// log, or a value that the firmware does not accept or changes (CLAUDE.md "PID profiles", "Export")
function toRecommendation(r, ctx = {}) {
    const R = REG[r.name] || REL[r.name], rule = RULES[r.rule] || RULES.value, profile = r.scope === 'profile' ? r.profile : null, caveats = [];
    // an evidence row of one PID profile in a row of all of them (e.profile: the drift of each log and PID profile) keeps its PID profile
    const pOf = (e) => Number.isInteger(e.profile) && e.profile > 0 ? e.profile : profile;
    const evidence = (r.evidence || []).map(e => ({ fid: null, module: 'gov_tune', id: rule.id, log: e.log === undefined ? null : e.log, profile: pOf(e), pidProfile: pOf(e) > 0 ? pOf(e) : null, axis: null,
        value: e.value === undefined ? null : e.value, se: isNum(e.se) ? e.se : null, n: e.n === undefined ? null : e.n, unit: e.unit || null, threshold: null, source: rule.source, text: e.text,
        times: [e.t0, e.t1].filter(isNum), summary: e.text, display: null }));
    let cli = [], to = null, from = r.current ? r.current.value : null;
    const asValue = (v) => v === null || v === undefined ? null : R && R.type === 'int' && isNum(Number(v)) ? Number(v) : REG[r.name] ? cliValue(r.name, v) || show(v) : v;
    if (r.status === 'change') {
        to = cliValue(r.name, r.to);
        if (!REG[r.name]) caveats.push('This value is not a governor parameter. Thus, there is no CLI text.');
        else if (to === null) caveats.push(`The value ${show(r.to)} is not in the firmware range of "${r.name}". Thus, there is no CLI text.`);
        else if (profile !== null && !(profile > 0)) caveats.push(`The PID profile is unknown (PID profile unknown). Thus, there is no CLI text.`);
        else if (from === null || from === undefined) caveats.push(`The value of "${r.name}" at this time is unknown. Thus, there is no CLI text.`);
        else if (r.current && r.current.conflict) caveats.push(`The CLI dump and the log give different values of "${r.name}". The app cannot find which value is correct at this time. Thus, there is no CLI text.`);
        else { const val = R.type === 'int' ? validationOf(r.name, Number(to), profile, ctx) : null;
            if (val && val.text) caveats.push(val.text);
            else { if (val && val.note) caveats.push(val.note); cli = (profile !== null ? [`profile ${profile - 1}`] : []).concat([`set ${r.name} = ${to}`]); } }
    }
    const severity = r.status === 'change' ? (cli.length ? 'action' : 'check') : r.status === 'check' ? (r.severity === 'watch' ? 'watch' : 'check') : 'info';
    const fromCli = REG[r.name] ? cliValue(r.name, from) : null, src = fromSourceOf(r.current && r.current.source);
    const setText = cli.length ? `Set "${r.name}"${profile !== null ? ` on ${prof(profile)}` : ''} from ${show(fromCli === null ? from : fromCli)} to ${to}.${src ? ` The value at this time is from the ${src}.` : ''}` : '';
    return { id: `gov:${r.id}`, node: 'governor', area: 'governor', order: 0, severity, title: cli.length ? `Set "${r.name}" to ${to}${profile !== null ? ` (${prof(profile)})` : ''}` : r.title,
        text: [r.text, setText].filter(Boolean).join(' '), procedure: r.record ? { title: r.record, steps: [] } : null, parameter: r.name, scope: R ? R.scope === 'related' ? 'global' : R.scope : 'global',
        cliProfile: profile > 0 ? profile - 1 : null, profile, rateProfile: null, axis: null, from: asValue(from), fromSource: src,
        fromSources: null, fromSets: fromCli !== null && cli.length ? Object.assign(linkedOf(ctx, profile), { [r.name]: asValue(from) }) : null, to: asValue(to), direction: r.status === 'change' ? 'set' : 'check', cli, evidence,
        rule: rule.text, sources: [rule.source], confidence: r.method === 'simulation' || r.method === 'model' ? 'predicted' : 'measured', blockedBy: [], holds: [], gate: null, causes: [],
        caveats: caveats.concat(r.caveats || []), group: r.group || null, groupSize: r.groupSize || null, dataset: null, supportedBy: [], ab: [], slope: null, stale: r.stale || null, row: r.id, status: r.status };
}

// the CLI text of a check row that the pilot can select (advice.exportPlan: severity 'check' with optIn; gov_scenarios.finish puts it in
// the recommendation)
function optIn(r, to, ctx) {
    const x = toRecommendation(Object.assign({}, r, { status: 'change', to }), ctx);
    r.optIn = { to, cli: x.cli, toCli: x.to, fromSets: x.fromSets, caveats: x.caveats.filter(c => !(r.caveats || []).includes(c)) };
    return r;
}

// ---------------------------------------------------------------------------------------------
// tune
// ---------------------------------------------------------------------------------------------

const NOTES = {
    kmot: 'The analysis starts the motor constant of the governor at 0 in each log. The firmware starts it at 0 only at power-up.',
    model: 'The governor model is not available at this time. Thus, the rows of the model show the values and the measurements only.',
    noFlight: 'The logs have no flight. The analysis does not use bench runs.',
};
function tune(runs, o = {}) {
    runs = (runs || []).filter(Boolean);
    const rec = o.recovered || GP.recover(runs, { cli: o.cli || null }), labels = labelsOf(runs, rec), flights = runs.filter(isFlight), profiles = profilesOf(flights, labels);
    const current = currentValues(runs, rec, { cli: o.cli, labels, profiles });
    const num = (name, p) => { const c = (current.byName[name] || {})[REG[name] && REG[name].scope === 'global' ? 0 : p]; const v = c ? Number(c.value) : NaN; return c && c.value !== null && c.value !== '' && isFinite(v) ? v : null; };
    const val = (name, p) => { const c = (current.byName[name] || {})[REG[name] && REG[name].scope === 'global' ? 0 : p]; return c && c.value !== null && c.value !== undefined ? (REG[name].type === 'flag' ? cliValue(name, c.value) : c.value) : null; };
    const modeC = current.byName.gov_mode[0], mode = typeof modeC.value === 'string' ? modeC.value.toUpperCase() : null, cand = modeC.candidates || [];
    const only = (...m) => cand.length > 0 && cand.every(c => m.includes(c));
    const modeKey = mode === 'ELECTRIC' ? 'electric' : mode === 'OFF' ? 'off' : mode === 'LIMIT' ? 'limit' : mode === 'DIRECT' ? 'direct' : mode === 'NITRO' ? 'nitro'
        : mode ? 'unknown' : only('OFF') ? 'off' : only('LIMIT') ? 'limit' : only('OFF', 'LIMIT') ? 'offOrLimit' : 'unknown';
    const meterV = current.related.battery_meter.value, meter = meterV === null || meterV === undefined ? null : String(meterV).toUpperCase();
    const ctx = { runs, flights, labels, profiles, rec, current, info: logInfo(runs, labels), num, val, modeKey, limitMode: modeKey === 'limit' || modeKey === 'offOrLimit', meter, model: o.model || null, sim: o.sim || o.search || null,
        modelReason: o.modelReason || null, modelLogs: Array.isArray(o.modelLogs) ? o.modelLogs : null, noModeSim: !!o.noModeSim,
        rate: (flights[0] || runs[0] || { rate: 1000 }).rate, type: val('gov_throttle_type', 0), fc: isNum(num('gov_rpm_filter', 0)) && num('gov_rpm_filter', 0) > 0 ? num('gov_rpm_filter', 0) : SPEC.gov_rpm_filter[1],
        maxThr: memo((p) => (num('gov_max_throttle', p) === null ? SPEC.gov_max_throttle[1] : num('gov_max_throttle', p)) / 100), minThr: memo((p) => (num('gov_min_throttle', p) === null ? SPEC.gov_min_throttle[1] : num('gov_min_throttle', p)) / 100),
        idleThr: () => (num('gov_idle_throttle', 0) === null ? 0 : num('gov_idle_throttle', 0)) / 1000,
        // a governor term limit of PID profile p (null: unknown; 0: the firmware does not use the term, so it is not a limit to examine)
        termLim: (() => { const m = new Map(); return (k, p) => { const key = `${k}|${p}`; if (!m.has(key)) { const L = num(TERM_LIMIT[k], p); m.set(key, L === null ? null : L / 100); } return m.get(key); }; })(),
        // the motor output is clamp(govSum) when voltage compensation cannot operate: its effect is inactive in the logs, the voltage
        // source is not ADC, or gov_use_voltage_comp is OFF (flight_governor.c:490-509, 1556)
        gvOne: memo((p) => { const c = (current.byName.gov_use_voltage_comp || {})[p]; if (c && c.effect === 'inactive') return true; if (c && c.effect === 'active') return false;
            return (meter !== null && meter !== 'ADC') || val('gov_use_voltage_comp', p) === 'OFF'; }),
        // the dynamic minimum throttle (a share of T / Kmot) when gov_use_dyn_min_throttle is ON, else null (flight_governor.c:536-548)
        dynMin: memo((p) => val('gov_use_dyn_min_throttle', p) !== 'ON' ? null : (num('gov_dyn_min_throttle', p) === null ? SPEC.gov_dyn_min_throttle[1] : num('gov_dyn_min_throttle', p)) / 100),
        modelState: !flights.length ? TEXT.notApplicable.noFlight : TEXT.notApplicable[modeKey] || null };
    ctx.M = measure(ctx);
    // the labels with rows of the control limits: the PID profiles with rows, and each other label with a period at a limit
    ctx.limitProfiles = [...new Set(profiles.concat(ctx.M.periods.concat(ctx.M.floors, ctx.M.termPeriods).map(x => x.profile)))].sort((a, b) => a - b);
    ctx.modelEvidence = modelEvidence(ctx);
    const families = o.families || familiesOf(o);
    let rows = ruleRows(ctx);
    if (flights.length) rows = rows.concat(modelRows(ctx, families));
    rows = rows.concat(defaultRows(ctx, rows));
    if (modeKey === 'off') for (const r of rows) if (REG[r.name] && r.name !== 'gov_mode' && r.status !== 'not-applicable') Object.assign(r, { status: 'not-applicable', reason: TEXT.notApplicable.off, text: TEXT.notApplicable.off });
    // coverage: each of the 42 names, and each PID profile of a profile name, has one row or more
    const byName = {}; for (const r of rows) byName[r.name] = (byName[r.name] || 0) + 1;
    const missing = [];
    for (const R of REGISTRY) for (const p of R.scope === 'global' ? [null] : profiles) if (!rows.some(r => r.name === R.name && r.profile === p)) missing.push(p === null ? R.name : `${R.name} (${prof(p)})`);
    const coverage = { names: REGISTRY.length, covered: REGISTRY.filter(R => byName[R.name] > 0).length, missing, byName, related: RELATED.filter(R => byName[R.name] > 0).length };
    // one entry for each name and PID profile: the most important status of its rows
    const params = new Map();
    for (const r of rows) { const k = `${r.name}|${r.profile === null ? 'g' : r.profile}`, q = params.get(k);
        if (!q) params.set(k, { name: r.name, scope: r.scope, profile: r.profile, family: r.family, status: r.status, current: r.current, rows: [r.id] });
        else { q.rows.push(r.id); if (STATUS_ORDER.indexOf(r.status) < STATUS_ORDER.indexOf(q.status)) q.status = r.status; } }
    const recommendations = rows.filter(r => r.status === 'change' || r.status === 'check' || (r.inform && ['keep', 'not-applicable', 'not-recorded'].includes(r.status))).map(r => toRecommendation(r, ctx));
    const notes = rec.notes.slice();
    if (!flights.length) notes.push(NOTES.noFlight);
    else { notes.push(NOTES.kmot); if (!families && !ctx.modelReason) notes.push(NOTES.model); }
    return { status: !flights.length ? 'no-flights' : modeKey === 'off' || modeKey === 'offOrLimit' ? 'governor-off' : modeKey === 'limit' ? 'governor-limit' : 'ok', rows, recommendations, coverage, parameters: [...params.values()], current, measures: measureSummary(ctx.M),
        notes, rules: RULES, families: FAMILIES, profiles, profileBasis: rec.profileMap ? rec.profileMap.basis : {}, modelState: ctx.modelState };
}

// ---------------------------------------------------------------------------------------------
// autotune: the governor model and the autotune of one file (the worker command governorTune, docs/GOVERNOR_AUTOTUNE.md section 8)
// ---------------------------------------------------------------------------------------------

const AUTO = {
    progress: {
        start: 'The app finds the governor values of the logs.',
        fit: { 'initial values': 'The app calculates the start values of the governor model.', fit: 'The app makes the governor model from the flights.',
            bootstrap: 'The app calculates the uncertainty of the governor model.', done: 'The app makes the governor model from the flights.' },
        validate: 'The app compares the governor model with the test flights.',
        scenarios: { power: 'The governor model calculates the throttle reserve at the end of the battery.', trial: 'The governor model flies the test of the maximum throttle.',
            spool: 'The governor model flies the spool-up.', tracking: 'The governor model calculates the slope of the headspeed target.',
            fallback: 'The governor model adds errors of the RPM signal.', bypass: 'The governor model calculates the throttle curve for BYPASS.',
            vcomp: 'The governor model calculates the effect of the battery voltage.', bailout: 'The governor model flies a BAILOUT from a slow rotor.', done: 'The governor model flies the test conditions.' },
        rows: 'The app makes the recommendations.',
    },
    cancelled: 'The governor analysis stopped before the end.',
    failed: 'The app cannot make the governor model from these logs.',
    limits: {
        noise: 'The RPM signal of the governor model has no vibration. Thus, a larger gain or a filter with a higher cutoff can give more fast throttle changes in flight than in the model.',
        again: 'The model calculates the effect of a change. A flight with the change shows the effect on the helicopter.',
        noCurrent: (fs) => `The log does not record the battery current ("Ibat"). Thus, the rotor inertia of the governor model has a larger uncertainty.${fs && fs.length ? ` The set of models also has ${and(fs.map(String))} times the rotor time constant, and a larger governor gain is a check.` : ''}`,
        // the flight logs without the battery voltage that the model does not use (RUN.minVoltageLogs)
        noVoltageLogs: (logs) => `${logs.length > 1 ? 'Logs' : 'Log'} ${and(logs.map(N))} ${logs.length > 1 ? 'do' : 'does'} not record the battery voltage. Thus, the governor model does not use ${logs.length > 1 ? 'these logs' : 'this log'}. The rules use all flight logs.`,
        // the twin set against the uncertainty of a parameter (review 2026-10-15: the set comes from the bootstrap samples)
        range: (k, lo, hi, a, b, u) => `For "${k}", the uncertainty of the governor model is ${sig4(lo)} to ${sig4(hi)}${u ? ` ${u}` : ''}, and the set of models has ${sig4(a)} to ${sig4(b)}${u ? ` ${u}` : ''}. Thus, the ranges of the results are possibly too small.`,
        load: 'At a headspeed that the flights do not use, the governor model calculates the load from the flights at the other headspeeds.',
        battery: 'The battery voltage of the governor model does not increase again after a load decrease. Thus, in the first seconds of a flight, the battery voltage of the model can be too low.',
    },
    plot: {
        time: 'Time', hs: 'Headspeed', thr: 'Throttle', vbat: 'Battery voltage', coll: 'Collective', err: 'Headspeed error', horizon: 'Time after the start point', share: 'Time at the maximum throttle',
        droop: 'Headspeed decrease, worst 5 % of the time', cell: 'Battery voltage with no load, for each cell', spool: '"gov_spoolup_time"', over: 'Headspeed overshoot after SPOOLUP',
        log: 'Log', closed: 'Model, closed loop', open: 'Model, open loop', target: 'Target', limit: 'Limit', now: 'Model, values at this time', cand: 'Model, recommended values',
        searched: 'Model, values that the analysis does not recommend', hold: 'Hold the start value', logged: 'Recorded target', points: 'Log, 1 s periods',
        hsTitle: (l) => `Headspeed of the test flight (log ${N(l)})`, thrTitle: (l) => `Throttle of the test flight (log ${N(l)})`, vTitle: (l) => `Battery voltage of the test flight (log ${N(l)})`,
        horizonTitle: 'Headspeed error of the model against the time after the start point', steadyTitle: 'Throttle for the load against the collective',
        curve: (h, k) => `${h} rpm, ${k === 'full' ? 'full battery' : k === 'end' ? 'end of the battery' : 'model'}`,
        candHs: (l) => `Headspeed with the recommended values (log ${N(l)})`, candThr: (l) => `Throttle with the recommended values (log ${N(l)})`,
        battTitle: 'Time at the maximum throttle against the battery voltage', droopTitle: 'Headspeed decrease against the battery voltage', prof: (p, h) => `${prof(p)} (${h} rpm)`,
        spoolTitle: 'Overshoot after SPOOLUP against the spool-up time', spoolCase: (p, v, pid) => `${prof(p)}, ${isNum(v) ? `${fmt(v, 1)} V` : 'recorded voltage'}${pid ? ', PID spool-up' : ''}`,
        fbTitle: (l) => `Headspeed after an RPM signal error (log ${N(l)})`, marginTitle: (p) => `Margin test of ${prof(p)}: headspeed error after a collective step`,
        marginNow: 'Gains at this time, multiplied by 2', marginNew: 'Recommended gains, multiplied by 2', marginOpt: 'Gains of the check, multiplied by 2',
        twinNote: 'The model flies the recorded inputs with the firmware governor from the arm to the end of the log.',
        bandNote: 'The bands show the governor conditions of the log other than ACTIVE.',
    },
};
const progressOf = (o) => (f, text) => { if (o && typeof o.progress === 'function') o.progress(text, f); };
const sig4 = (v) => isNum(v) ? String(+v.toPrecision(4)) : 'unknown';
// JSON-cloneable: typed arrays as arrays, numbers that are not finite as null
const clean = (x) => JSON.parse(JSON.stringify(x, (k, v) => ArrayBuffer.isView(v) ? Array.from(v, q => isNum(q) ? q : null) : typeof v === 'number' && !isFinite(v) ? null : v));
// up to RUN.points evenly spaced points of each of the arrays (the same indices)
function thin(arrays, points = RUN.points) {
    const n = Math.max(0, ...arrays.filter(Boolean).map(a => a.length)), step = Math.max(1, Math.ceil(n / points)), idx = [];
    for (let k = 0; k < n; k += step) idx.push(k);
    return arrays.map(a => a ? idx.map(k => isNum(a[k]) ? +(+a[k]).toPrecision(6) : null) : null);
}
// a plot spec of the Governor tab (js/tuning_dialog.js govPlotSpec): series { name, role (measured | model | baseline | candidate | limit), x, y, style, axis }
const ser = (name, role, x, y, style, axis) => { const [a, b] = thin([x, y]); return a && b ? Object.assign({ name, role, x: a, y: b }, style ? { style } : {}, axis ? { axis } : {}) : null; };
const scale = (a, k) => a ? Array.from(a, v => isNum(v) ? v * k : null) : null;
function plotSpec(id, title, kind, x, y, series, o = {}) { const s = series.filter(q => q && q.y.some(isNum)); return s.length ? Object.assign({ id, title, kind, x, y, series: s }, o) : null; }

// the plots of the model quality (gov_fit.plotData): the test flights in closed loop and open loop with the logged governor states as bands
// (the time in frame seconds, fromS + time: the clock of the log viewer, env.seekFrame of js/tuning_dialog.js), the horizon curve, the
// steady-state map
function twinPlots(pd) {
    const P = AUTO.plot, out = [], T = { label: P.time, unit: 's' };
    for (const r of (pd && pd.runs) || []) {
        const t = r.time, bands = (r.bands || []).map(b => ({ x0: b.x0, x1: b.x1, label: b.state, state: b.state })), o = Object.assign({ log: r.log, note: bands.length ? `${P.twinNote} ${P.bandNote}` : P.twinNote }, bands.length ? { bands } : {});
        out.push(plotSpec(`twin-hs-${r.log}-${r.segment}`, P.hsTitle(r.log), 'time', T, { label: P.hs, unit: 'rpm' },
            [ser(P.log, 'measured', t, r.hs), ser(P.closed, 'model', t, r.hsClosed), ser(P.open, 'model', t, r.hsOpen, 'dash'), ser(P.target, 'limit', t, r.target)], o));
        out.push(plotSpec(`twin-u-${r.log}-${r.segment}`, P.thrTitle(r.log), 'time', T, { label: P.thr, unit: '%' }, [ser(P.log, 'measured', t, scale(r.u, 100)), ser(P.closed, 'model', t, scale(r.uClosed, 100))], o));
        if (r.vbat) out.push(plotSpec(`twin-v-${r.log}-${r.segment}`, P.vTitle(r.log), 'time', T, { label: P.vbat, unit: 'V' },
            [ser(P.log, 'measured', t, r.vbat), ser(P.closed, 'model', t, r.vbatClosed), ser(P.open, 'model', t, r.vbatOpen, 'dash')], o));
    }
    const h = pd && pd.horizon, a = h && h.inActive;
    if (a) out.push(plotSpec('twin-horizon', P.horizonTitle, 'xy', { label: P.horizon, unit: 's', log: true }, { label: P.err, unit: '%' },
        [ser(P.open, 'model', h.horizons, a.model.map(q => q.rms)), ser(P.hold, 'baseline', h.horizons, a.hold.map(q => q.rms)), ser(P.logged, 'limit', h.horizons, a.target.map(q => q.rms))]));
    const s = pd && pd.steady;
    if (s) out.push(plotSpec('twin-steady', P.steadyTitle, 'xy', { label: P.coll }, { label: P.thr, unit: '%' },
        s.curves.map(c => ser(P.curve(c.headspeed, c.ocv), 'model', c.coll, scale(c.throttle, 100), c.ocv === 'end' ? 'dash' : null))
            .concat([ser(P.points, 'measured', s.points.map(q => q.coll), s.points.map(q => 100 * q.u), 'points')])));
    return out.filter(Boolean);
}
// the plots of the autotune: the closed loop with the recommended values (gov_search), the battery tradeoff, the spool-up scan, the RPM
// signal error (gov_scenarios) and the margin test (gov_search)
function tunePlots(S, SS) {
    const P = AUTO.plot, out = [], T = { label: P.time, unit: 's' };
    const pl = S && S.plot, tr = pl && pl.trace;
    if (tr) {
        const cand = pl.candidate === 'accepted' ? P.cand : P.searched;
        out.push(plotSpec('tune-hs', P.candHs(pl.log), 'time', T, { label: P.hs, unit: 'rpm' }, [ser(P.log, 'measured', tr.t, tr.hs), ser(P.now, 'baseline', tr.t, tr.hsBase), ser(cand, 'candidate', tr.t, tr.hsCand), ser(P.target, 'limit', tr.t, tr.target)], { log: pl.log }));
        out.push(plotSpec('tune-u', P.candThr(pl.log), 'time', T, { label: P.thr, unit: '%' }, [ser(P.now, 'baseline', tr.t, scale(tr.uBase, 100)), ser(cand, 'candidate', tr.t, scale(tr.uCand, 100))], { log: pl.log }));
    }
    const pw = SS && SS.power, curve = pw && pw.curve || [];
    if (curve.length) {
        const ps = [...new Set(curve.flatMap(c => Object.keys(c.profiles)))].map(Number).sort((a, b) => a - b), x = curve.map(c => c.perCell);
        const name = (p) => P.prof(p, pw.profiles[p] ? pw.profiles[p].Hf : 'unknown');
        out.push(plotSpec('tune-battery', P.battTitle, 'xy', { label: P.cell, unit: 'V' }, { label: P.share, unit: '%' },
            ps.map(p => ser(name(p), 'model', x, curve.map(c => c.profiles[p] ? 100 * c.profiles[p].share : null)))));
        out.push(plotSpec('tune-battery-droop', P.droopTitle, 'xy', { label: P.cell, unit: 'V' }, { label: P.droop, unit: '%' },
            ps.map(p => ser(name(p), 'model', x, curve.map(c => c.profiles[p] && isNum(c.profiles[p].droop95) ? 100 * c.profiles[p].droop95 : null)))));
    }
    const sp = SS && SS.spool;
    if (sp && sp.scan && sp.scan.length && sp.cases) {
        const sr = [], one = (scan, pid) => sp.cases.forEach((c, j) => sr.push(ser(P.spoolCase(c.profile, c.rest, pid), pid ? 'candidate' : 'model', scan.map(q => q.value / 10), scan.map(q => q.os[j]), pid ? 'dash' : null)));
        one(sp.scan, false); if (sp.scanPid && sp.scanPid.length) one(sp.scanPid, true);
        const xs = sp.scan.map(q => q.value / 10);
        sr.push(ser(P.limit, 'limit', [xs[0], xs[xs.length - 1]], [RULES.spool.overshoot * 100, RULES.spool.overshoot * 100]));
        out.push(plotSpec('tune-spool', P.spoolTitle, 'xy', { label: P.spool, unit: 's' }, { label: P.over, unit: '%' }, sr));
    }
    const fb = SS && SS.fallback && SS.fallback.traces;
    if (fb && fb.alts && fb.alts.length) out.push(plotSpec('tune-fallback', P.fbTitle(fb.log), 'time', T, { label: P.hs, unit: 'rpm' },
        fb.alts.map((a, j) => ser(a.label, j === 0 ? 'baseline' : a.best ? 'candidate' : 'model', a.t, a.hs, j === 0 || a.best ? null : 'dash')).concat([ser(P.target, 'limit', fb.alts[0].t, fb.alts[0].target)]), { log: fb.log }));
    for (const [p, m] of Object.entries((S && S.marginPlot) || {})) out.push(plotSpec(`tune-margin-${p}`, P.marginTitle(+p), 'time', T, { label: P.err, unit: '%' },
        [ser(P.marginNow, 'baseline', m.t, m.base), m.final ? ser(m.opt ? P.marginOpt : P.marginNew, 'candidate', m.t, m.final) : null], { log: m.log }));
    return out.filter(Boolean);
}
// the validation without the traces (the result of the app)
function validationSummary(v) {
    if (!v) return null;
    const cl = v.closedLoop || {}, hz = v.horizon;
    return { status: v.status, reasons: v.reasons, checks: (v.checks || []).map(q => ({ rule: q.rule, value: r2(q.value, 4), limit: q.limit, pass: q.pass, text: q.text })), openLoop: v.openLoop || null,
        closedLoop: { available: !!cl.available, hsRms: cl.hsRms, uRms: cl.uRms, vbatRms: cl.vbatRms, stateAgreement: cl.stateAgreement, baseRms: cl.baseRms, skill: cl.skill, band: cl.band, worst: cl.worst || null,
            reasons: cl.reasons || (cl.reason ? [cl.reason] : []), runs: (cl.runs || []).map(q => Object.assign({}, q, { trace: undefined, metrics: undefined })) },
        unforced: v.unforced || null, tmScan: v.tmScan || [], events: v.events || null,
        horizon: hz ? { horizons: hz.horizons, starts: hz.starts, model: hz.model, hold: hz.hold, inActive: hz.inActive, crossing: hz.crossing, skill: hz.skill } : null };
}
// the parameters of the twin and their p5-p95 (gov_fit uncertainty)
function twinParams(model) {
    const GT = require('./gov_twin.cjs'), names = GT.paramNames(model.has || {}), u = model.uncertainty || {}, params = {}, unc = {};
    for (const k of names) { if (!isNum(model.params[k])) continue; params[k] = +model.params[k].toPrecision(6); const x = u[k];
        if (x) unc[k] = { p5: r2(x.p5, 6), p50: r2(x.p50, 6), p95: r2(x.p95, 6), unit: (GT.PARAM[k] || {}).unit || null, source: x.source || null }; }
    return { params, uncertainty: unc };
}

// The runs of the governor model: with the battery voltage in some flight logs and not in others, the flight logs with the voltage when they are
// RUN.minVoltageLogs or more (gov_fit would leave out the voltage of every log: TEXT.mixedV), else all runs. { runs (the bench runs stay: the
// configuration evidence), flights, left (the flight logs left out, sorted) }
function modelRunsOf(runs) {
    const flights = runs.filter(isFlight), noV = [...new Set(flights.filter(r => !r.vbat).map(r => r.log))].sort((a, b) => a - b);
    const withV = [...new Set(flights.filter(r => !!r.vbat && !noV.includes(r.log)).map(r => r.log))];
    if (!noV.length || withV.length < RUN.minVoltageLogs) return { runs, flights, left: [] };
    const keep = runs.filter(r => !isFlight(r) || !noV.includes(r.log));
    return { runs: keep, flights: keep.filter(isFlight), left: noV };
}

// autotune(runs, { cli, progress(text, fraction), cancelled(), nomad (false: no NOMAD), model, validation, configs, recovered }) -> { status ('validated' |
// 'partial' | 'rejected' | 'unavailable'), reasons, twin { params, uncertainty, validation, plots, has, Href, split, physical }, rows,
// recommendations, limitations, plots, notes, coverage, parameters, profiles, rules, families, measures, search, scenarios, modelLogs, timing }, JSON only.
// recover -> configOf -> identify -> validate -> scenarios -> search -> tune. o.model and o.validation (gov_fit results) skip the identification
// and the validation, o.scenarios (gov_scenarios.evaluate) and o.search (gov_search.search) the scenarios and the search (tests, the dev harness)
async function autotune(runs, o = {}) {
    const A = RUN, t0 = Date.now(), timing = {}, say = progressOf(o), since = (t) => r2((Date.now() - t) / 1000, 2);
    const halt = async () => { await new Promise(res => setTimeout(res, 0)); return typeof o.cancelled === 'function' && !!o.cancelled(); };
    const GF = require('./gov_fit.cjs'), GS = require('./gov_sim.cjs');
    runs = (runs || []).filter(Boolean);
    const cli = o.cli || null, flights = runs.filter(isFlight);
    say(0, AUTO.progress.start);
    const rec = o.recovered || GP.recover(runs, { cli }), configs = o.configs || GS.configOf(runs, rec, { cli }), base = tune(runs, { recovered: rec, cli });
    timing.recoverS = since(t0);
    // the runs of the model (identify, validate, scenarios, search; modelRunsOf), and a limitation for the flight logs that it leaves out; the
    // rule rows (tune) use every flight log. modelLogs: the flight logs of the model (the worker flags the values of these logs only)
    const M = modelRunsOf(runs), modelRuns = M.runs, fl = M.flights, limits = M.left.length ? [AUTO.limits.noVoltageLogs(M.left)] : [];
    const modelLogs = [...new Set(fl.map(r => r.log))].sort((a, b) => a - b);
    // the result: the rows of tune (with the families of the model when there are results), the recommendations (gov_scenarios.finish: the opt-in CLI)
    const finish = (status, reasons, x = {}) => {
        const res = x.res || base;
        if (x.scenarios) require('./gov_scenarios.cjs').finish(res);
        const lim = [...new Set((x.limitations || []).filter(Boolean))];
        timing.totalS = since(t0);
        return clean({ status, reasons: [...new Set(reasons.filter(Boolean))], twin: x.twin || null, rows: res.rows, recommendations: res.recommendations, limitations: lim, plots: x.plots || [],
            notes: [...new Set(res.notes.concat(x.notes || []))], coverage: res.coverage, parameters: res.parameters, profiles: res.profiles, profileBasis: res.profileBasis, rules: res.rules, families: res.families,
            measures: res.measures, search: x.search || null, scenarios: x.scenarios ? require('./gov_scenarios.cjs').summary(Object.assign({}, x.scenarios, { mainParams: undefined })) : null, modelLogs, timing });
    };
    const stopped = () => finish('unavailable', [AUTO.cancelled]);
    if (base.modelState) return finish('unavailable', [base.modelState]);   // no flight, or a governor mode other than ELECTRIC
    // the identification (synchronous) and the validation (closed loop with the native governor)
    let model = o.model || null, val = o.validation || null;
    if (!model) {
        if (await halt()) return stopped();
        const t = Date.now(); say(0.02, AUTO.progress.fit['initial values']);
        model = GF.identify(fl, { progress: (f, k) => say(0.02 + 0.2 * f, AUTO.progress.fit[k] || AUTO.progress.fit.fit) });
        timing.identifyS = since(t);
    }
    const has = model.has || { voltage: !!(model.params && model.params.voltage), current: !!(model.params && model.params.current) };
    // gov_fit: the battery voltage that the model does not use (no voltage in the logs, or not in all of them): a reason of a rejected model
    // and a limitation of a model that the analysis uses (review 2026-10-15: the cause of the larger headspeed errors)
    const vWhy = (model.reasons || []).filter(t => t === GF.TEXT.noVoltage || t === GF.TEXT.mixedV || t === GF.TEXT.mixedI);
    // no governor mode in any flight log of the model (gov_sim configOf: no voltage and no current): no closed loop, and the gov_mode row says so
    const noModeSim = fl.length > 0 && fl.every(r => { const c = configs[GS.keyOf(r)]; return !!c && (c.unknown || []).some(u => u.name === 'gov_mode' && u.used); });
    if (!model.params || model.status === 'failed') {
        const why = [AUTO.failed].concat(model.reasons || []);
        return finish('unavailable', why, { res: tune(runs, { recovered: rec, cli, model, modelReason: why.join(' '), modelLogs, noModeSim }), limitations: limits });
    }
    if (!val) {
        if (await halt()) return stopped();
        const t = Date.now(); say(0.23, AUTO.progress.validate);
        val = await GF.validate(model, fl, { sim: GS, configs });
        timing.validateS = since(t);
    }
    const tp = Date.now(), twin = Object.assign(twinParams(model), { has, Href: r2(model.Href, 1), split: model.split || null, physical: model.physical || null, status: val.status,
        validation: validationSummary(val), plots: twinPlots(GF.plotData(model, fl, val)) });
    timing.plotS = since(tp);
    // a rejected model: no set of models (the rotor time constant) and no tuning step, thus the first sentence of the current limitation only
    if (!has.current) limits.push(AUTO.limits.noCurrent(val.status === 'rejected' ? null : RUN.noCurrent));
    if (val.status === 'rejected') {
        const SR = require('./gov_search.cjs');
        return finish('rejected', (val.reasons || []).concat(vWhy), { twin, limitations: limits, res: tune(runs, { recovered: rec, cli, model, modelReason: SR.TEXT.rejected, modelLogs, noModeSim }) });
    }
    limits.push(...vWhy);
    // the scenario families (gov_scenarios), then the search families (gov_search; NOMAD with a fixed number of evaluations)
    const SC = require('./gov_scenarios.cjs'), SR = require('./gov_search.cjs');
    if (await halt()) return stopped();
    const ts = Date.now(); say(0.3, AUTO.progress.scenarios.done);
    const SS = o.scenarios || await SC.evaluate(modelRuns, { model, validation: val, recovered: rec, cli, configs, base, progress: (f, k) => say(0.3 + 0.3 * f, AUTO.progress.scenarios[k] || AUTO.progress.scenarios.done) });
    timing.scenariosS = since(ts);
    if (await halt()) return stopped();
    const tq = Date.now();
    const S = o.search || await SR.search(modelRuns, { model, validation: val, configs, budgetMs: A.nomadMaxMs, nomad: o.nomad !== false, progress: (f, text) => say(0.6 + 0.37 * f, text) });
    timing.searchS = since(tq); timing.nomadBudgetS = S.timing && isNum(S.timing.nomadBudgetMs) ? r2(S.timing.nomadBudgetMs / 1000, 1) : null;
    if (await halt()) return stopped();
    say(0.98, AUTO.progress.rows);
    const res = tune(runs, { recovered: rec, cli, model, search: S, scenarios: SS, modelLogs, noModeSim });
    if (res.rows.some(q => q.status === 'pending-model')) throw new Error('gov_tune.autotune: a model family gave a pending-model row.');
    if (res.coverage.missing.length) throw new Error(`gov_tune.autotune: no row for ${res.coverage.missing.join(', ')}.`);
    const tmT = (SS.twins || []).find(q => q.scan);
    if (tmT) limits.push(SC.TEXT.tm(tmT.factor));
    // the twin set against the uncertainty of kv, tm and te (p5-p95 of gov_fit: the single flights or the bootstrap)
    const U = model.uncertainty || {}, GT = require('./gov_twin.cjs');
    for (const k of ['kv', 'tm', 'te']) {
        const u = U[k], v = (SS.twins || []).map(t => t[k]).filter(isNum), tol = 0.005 * Math.abs(model.params[k] || 0);
        if (u && isNum(u.p5) && isNum(u.p95) && v.length && (Math.min(...v) > u.p5 + tol || Math.max(...v) < u.p95 - tol)) limits.push(AUTO.limits.range(k, u.p5, u.p95, Math.min(...v), Math.max(...v), (GT.PARAM[k] || {}).unit));
    }
    limits.push(AUTO.limits.noise, AUTO.limits.load, AUTO.limits.battery, AUTO.limits.again);
    if (S.status !== 'ok' && S.reason) limits.push(S.reason);
    if (S.stages && S.stages.nomad && S.stages.nomad.skipped) limits.push(SR.TEXT.nomadNone);
    if (SS.reason) limits.push(SS.reason);
    const search = S.status === 'ok' ? { status: S.status, twins: S.twins, tmFactor: S.tmFactor, split: S.split, profiles: S.profiles, current: S.current, final: S.final, baseline: S.baseline, windows: S.windows,
        margin: S.margin, endOcv: S.endOcv, stages: S.stages, accept: S.accept, table: S.plot ? S.plot.table : null, notes: S.notes, timing: S.timing, ms: S.ms } : { status: S.status, reason: S.reason };
    return finish(val.status, val.reasons || [], { twin, res, limitations: limits, plots: tunePlots(S, SS), notes: (S.notes || []).filter(t => t !== SR.TEXT.nomadNone).concat(SS.notes || []), search, scenarios: SS });
}

// a text table of the rows (the CLI and the real-data test)
function table(rows) {
    const cut = (s, k) => { s = String(s === null || s === undefined ? '' : s); return s.length > k ? s.slice(0, k - 1) + '…' : s.padEnd(k); };
    return rows.map(r => [cut(r.name, 28), cut(r.profile === null ? '-' : r.profile, 2), cut(r.topic, 22), cut(r.status, 14), cut(show(r.current && r.current.value), 12),
        cut(r.current && r.current.source, 28), cut(r.rule, 11), cut(r.text, 140)].join(' ')).join('\n');
}

module.exports = { RULES, REGISTRY, REG, RELATED, FAMILIES, MODEL, MODEL_INFO, STATES, TEXT, NOTES, AUTO, RUN, STATUS_ORDER, cliValue, parseCli, currentValues, labelsOf, profilesOf,
    measure, ruleRows, modelRows, pendingRows, familiesOf, row, ev, tune, autotune, modelRunsOf, twinPlots, tunePlots, toRecommendation, optIn, simStale, mergeStale, linkedOf, table, g21Change, ceilingOf };
if (require.main !== module) return;

// node tools/autotune/gov_tune.cjs <data dir> [--cli <dump>] [--json <out>]: the rows table of a dev data directory
const args = process.argv.slice(2), opt = (k) => { const j = args.indexOf(k); return j >= 0 ? args[j + 1] : null; };
const fs = require('fs');
const res = tune(GD.load(args[0], { bench: true }), { cli: opt('--cli') ? fs.readFileSync(opt('--cli'), 'utf8') : null });
console.log(table(res.rows));
console.log(`coverage ${res.coverage.covered}/${res.coverage.names}, missing ${res.coverage.missing.length}, recommendations ${res.recommendations.length}`);
for (const n of res.notes) console.log('NOTE', n);
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(res, null, 1));
