'use strict';

/**
 * Configuration checks that are prerequisites of the tuning (SPEC3 A: the prerequisites band), new id:
 *
 *   D9   rescue on in every PID profile: rescue_mode of each PID profile from the CLI dump (each `profile` section), or,
 *        without a dump, the rescues that the logs show in each PID profile. A PID profile with rescue_mode OFF is a
 *        problem: in that PID profile the rescue switch does not start a rescue
 *   D12  the response of the firmware when the receiver signal stops (IMP-11, information): from the parameter snapshot of the
 *        newest flight log (else the CLI dump) the throttle of failsafe stage 1 (`rxfail` of the throttle channel), its band of
 *        the governor throttle input, the governor state from ACTIVE, the time to the motor stop, the time limit of a fast
 *        recovery, and the other `rxfail` values with their risks as text. No CLI text and no export line: `rxfail` is a safety
 *        value, and the pilot sets it. On firmware 4.3 to 4.7 failsafe stage 2 does not operate (the note of the result)
 *
 *   rxfailPulse(typed)        the pulse that the CLI stores for a typed `rxfail <n> s <us>` value (875 us + 5 us steps)
 *   rxfailResponse(values, rxfail, u0)   the D12 calculation (see the function)
 *   throttleValues(src, basis)            the values of D12 from a snapshot (basis 'snapshot') or a parsed CLI dump ('cli')
 *
 *   rescueOfCli(cli)          rescue_mode and the other rescue values of each PID profile of a CLI dump, or of the parameter
 *                             snapshot of a log header (judge: { kind: 'dump', profiles }, basis 'snapshot', above the CLI dump) (parsed with
 *                             health_setup.cjs parseCli, or its text): { kind, profiles: { [1-6]: { mode, on, params,
 *                             defaults, lines } }, missing: [PID profiles that the dump does not have] }
 *   analyse(w, ctx)           per segment: the seconds of each raw PID profile label (all samples and the flight samples),
 *                             the rescue starts by label (RESCUE_STATE runs), and the header keys that start with "rescue"
 *   judge(flights, RULES, extra)   D9 findings; extra = { cli: parsed CLI dump (or its text) or null, arming: { [log]:
 *                             { profile: 1-6 or 0, confirmed } } (an object or a Map) }: the label 0 of a log (the time
 *                             before the first PID profile change) is its arming profile only when that is confirmed
 *
 * Module contract as health_rescue.cjs: analyse measures, judge decides with DEFAULT_RULES. A D9 finding has the PID
 * profile NUMBER (1-6, as the Configurator counts them) in profile, or null; phase null (a configuration value); unit
 * 'state'; value 1 (rescue on), 0 (rescue off) or null (not known); thin true when the value is not known. Finding texts
 * are ASD-STE100 (docs/STE_GLOSSARY.md); code reads the fields, never the text. Texts give no log number (the views show
 * the log of each finding), and CLI names are in code font. `profile N` in a CLI dump is PID profile N + 1.
 *
 * Firmware facts (rotorflight-firmware release/4.6.0):
 *   - settings.c (copy: analysis/gaui-x4/20261004_233406/verify/PWR-CURRENT-TEMP/fw460/settings.c) lines 1183-1201: the
 *     18 rescue values of RESCUE below, each `PROFILE_VALUE` in `PG_PID_PROFILE`: a value of each PID profile. rescue_mode
 *     is a lookup of lookupTableRescueMode, lines 492-494: OFF, CLIMB, ALT_HOLD (flight/rescue.h RESCUE_MODE_OFF = 0)
 *   - pg/pid.c, the pidProfile reset (copy: analysis/gaui-x4/verify/VIB-FILTERS_semantics/fw/pg_pid.c, release/4.6.0 as
 *     its fw_facts.py says) lines 88-105: rescue.mode = 0 (OFF), flip_mode 1 (ON), flip_gain 200, level_gain 100,
 *     pull_up_time 3, climb_time 10, flip_time 20, exit_time 5, pull_up_collective 650, climb_collective 450,
 *     hover_collective 350, hover_altitude 500, alt_p_gain 20, alt_i_gain 20, alt_d_gain 10, max_collective 500,
 *     max_setpoint_rate 300, max_setpoint_accel 3000. A `diff` prints only the values that are not at these defaults
 *   - blackbox.c header (copy fw460/blackbox.c lines 1598-1779): no rescue value. Thus, a 4.6 log header cannot show
 *     rescue_mode
 *   - flight/rescue.c (release/4.6.0, read 2026-10-06 from raw.githubusercontent.com, copy in the scratchpad r2T/config/fw):
 *     rescueUpdate (lines 500-514) runs the rescue state machine only `if (rescue.mode)`, and rescueApply (516-522)
 *     changes the setpoints only then. rescue.mode comes from the active PID profile (rescueInitProfile, line 527, called by
 *     pidInitProfile: flight/pid.c line 716 of the copy). The state leaves RESCUE_STATE_OFF only in that state machine
 *     (line 430). Thus, a RESCUE_STATE change in the log (blackbox.c logs a change of getRescueState(), lines 1911-1916 of
 *     the copy blackbox_blackbox.c) shows that rescue_mode was not OFF in the PID profile at that time
 *   - D12 (release/4.6.0 118e912; 4.7.0 85d7049a9; the bbp builds 58a4bd5cc and 874f369d5: git diff of rx/rx.c, rx/rx.h, fc/rc.c,
 *     flight/failsafe.c and flight/governor.c against 118e912 adds only the parameter journal and, in 85d7049a9, the RX wiring
 *     trial of MSP): rx.h RXFAIL_STEP_TO_CHANNEL_VALUE = 875 + 5 x step and CHANNEL_VALUE_TO_RXFAIL_STEP = (us - 875) / 5 (integer,
 *     0..250); rx.c getRxfailValue AUTO of the throttle = getFailsafeThrottle() (fc/rc.c) = offThrottle - 5; initRcProcessing:
 *     minThrottle = rc_min_throttle (885..2115) or rc_center - 0.9 x rc_deflection, maxThrottle likewise (at least minThrottle +
 *     10), offThrottle = minThrottle - 5, isThrottleOff = rcInput < offThrottle, getThrottle = transition(rcInput, min, max, 0, 1);
 *     detectAndApplySignalLossBehaviour: the last values for MAX_INVALID_PULSE_TIME_MS 300, then the rxfail values, at the 100 ms
 *     rechecks of rxFrameCheck after rxSignalReceived goes to 0 (100 ms after the last frame): 0.3 to 0.4 s after the last frame;
 *     governor.c govGetInputThrottle FUNCTION: < 0.333 idle, < 0.666 auto, else max; govUpdateGovernedState ACTIVE: input off ->
 *     THROTTLE_HOLD, input < handover -> AUTOROTATION (gov_autorotation_timeout > 0 and input >= auto) else THROTTLE_HOLD;
 *     govThrottleSlewControl: output 0 at once with the input off, else to constrain(input, idle or auto, handover) at the
 *     spool-down rate 10 / gov_spooldown_time per s (govCalcRate, 1..600; 0: no limit); THROTTLE_HOLD -> RECOVERY with the input
 *     more than the handover and motorRPMGood in gov_throttle_hold_timeout x 0.1 s, then OFF with the input off, else IDLE;
 *     AUTOROTATION -> BAILOUT with the same conditions in gov_autorotation_timeout s, then IDLE (OFF at once with the input off);
 *     a CLI text value that is not a step (`rxfail 4 s 1037`) is stored as the step below (rxfailPulse); gov_mode LIMIT and
 *     DIRECT are not modelled (lookupTableGovernorMode OFF, LIMIT, DIRECT, ELECTRIC, NITRO);
 *     failsafe.c failsafeStartMonitoring: its only statement is commented out ("RTFL: Keep disabled until code refactored",
 *     d864d6496, in release/4.3.0 to 4.6.0 and 85d7049a9), so stage 2 never runs
 */

const optional = (name) => { try { return require(name); } catch (e) { return null; } };

// The rescue values of one PID profile (settings.c 1183-1201): CLI name, default (pg/pid.c 88-105), firmware range (or
// the lookup values)
const RESCUE = [
    ['rescue_mode', 'OFF', ['OFF', 'CLIMB', 'ALT_HOLD']], ['rescue_flip', 'ON', ['OFF', 'ON']], ['rescue_flip_gain', 200, [5, 250]], ['rescue_level_gain', 100, [5, 250]],
    ['rescue_pull_up_time', 3, [0, 250]], ['rescue_climb_time', 10, [0, 250]], ['rescue_flip_time', 20, [0, 250]], ['rescue_exit_time', 5, [0, 250]],
    ['rescue_pull_up_collective', 650, [0, 1000]], ['rescue_climb_collective', 450, [0, 1000]], ['rescue_hover_collective', 350, [0, 1000]],
    ['rescue_hover_altitude', 500, [0, 10000]], ['rescue_alt_p_gain', 20, [0, 10000]], ['rescue_alt_i_gain', 20, [0, 10000]], ['rescue_alt_d_gain', 10, [0, 10000]],
    ['rescue_max_sp_rate', 300, [1, 1000]], ['rescue_max_sp_accel', 3000, [1, 10000]], ['rescue_max_collective', 500, [1, 1000]],
].map(([name, def, range]) => ({ name, default: def, range }));

const RULE = {
    modes: ['OFF', 'CLIMB', 'ALT_HOLD'],  // lookupTableRescueMode: the number in a header or an old dump is the index
    profiles: 6,                          // PID profiles of 4.6 (a `diff all` prints 6 profile sections)
    minFlightS: 1,                        // s of flight in a PID profile before the logs "fly" that PID profile
    maxRescues: 200,                      // rescue starts kept for each segment
    maxParams: 6,                         // values that are not at their defaults, named in a text
    // D12: rxfail steps (pulseMin + stepUs x step, 0..rangeMax), the limits of rc_min_throttle, the throttle deadband, the share of
    // rc_deflection, the FUNCTION bands, the time of the rxfail values after the last frame, the throttle channel (logical, after
    // rcmap), the firmware versions with this model and with no failsafe stage 2, the limits of gov_spooldown_time, the minimum
    // throttle range, the values that the calculation reads and the stage-2 values with no effect
    rxfail: { pulseMin: 875, stepUs: 5, rangeMax: 250, pulseLimits: [885, 2115], deadbandUs: 5, deflectionShare: 0.9, band: [0.333, 0.666], cutDelayS: [0.3, 0.4], channel: 4,
        firmware: ['4.6', '4.7'], stage2Off: ['4.3', '4.4', '4.5', '4.6', '4.7'], spooldown: [1, 600], minRangeUs: 10,
        names: ['rc_center', 'rc_deflection', 'rc_min_throttle', 'rc_max_throttle', 'gov_mode', 'gov_throttle_type', 'gov_idle_throttle', 'gov_auto_throttle', 'gov_handover_throttle',
            'gov_autorotation_timeout', 'gov_throttle_hold_timeout', 'gov_spooldown_time'],
        stage2: ['failsafe_delay', 'failsafe_procedure', 'failsafe_off_delay', 'failsafe_throttle_low_delay', 'failsafe_throttle'],
        // settings.c lookupTableGovernorMode and lookupTableGovernorThrottleType (4.6.0 and 4.7.0): a number in a header or a dump is the index
        lookups: { gov_mode: ['OFF', 'LIMIT', 'DIRECT', 'ELECTRIC', 'NITRO'], gov_throttle_type: ['NORMAL', 'SWITCH', 'FUNCTION'] }, modes: ['OFF', 'ELECTRIC', 'NITRO'] },
    source: {
        modes: 'firmware 4.6.0: the values of rescue_mode are OFF, CLIMB and ALT_HOLD',
        profiles: 'firmware 4.6.0: 6 PID profiles, and `diff all` shows all of them',
        minFlightS: 'pipeline, unvalidated: 1 s of flight in a PID profile is a flight in that PID profile, not a short PID profile change',
        maxRescues: 'pipeline: a limit of the result size',
        maxParams: 'a limit of the display',
        rxfail: 'firmware 4.6.0 and 4.7.0: an rxfail value is 875 us + 5 us x step (step 0 to 250), and the CLI keeps a typed value in these steps; AUTO gives the throttle the off value - 5 us; ' +
            'the off value is the minimum throttle - 5 us; the minimum throttle is rc_min_throttle, or rc_center - 0.9 x rc_deflection when it is 0; the RC values stay for 300 ms, then the rxfail values come at the 100 ms rechecks ' +
            '(0.3 s to 0.4 s after the last RC frame); the FUNCTION throttle bands are 0.333 and 0.666 of the throttle range; failsafe stage 2 does not operate on 4.3 to 4.7',
    },
};

const EXTRA = ['motor[0]', 'time']; // the rescue state (rescueAt) and the PID profile (profileAt) come from the log events (lib.cjs segments); D12: the throttle

// The sources are shown to the pilot (quoted): no file name or path
const DEFAULT_RULES = {
    D9: { flag: 0, source: 'firmware 4.6.0: rescue_mode is a value of each PID profile (default OFF), and with OFF the rescue switch does not start a rescue in that PID profile',
        note: 'flag: a PID profile with rescue_mode OFF in the CLI dump (a `diff` leaves out a value at its default, OFF), or in the log header; ok: rescue_mode CLIMB or ALT_HOLD, or a RESCUE_STATE change in the logs in that PID profile (the firmware runs the rescue state machine only when rescue_mode is not OFF); note (not sufficient data): the PID profiles with no CLI section and no rescue in the logs' },
    D12: { source: 'firmware 4.6.0 and 4.7.0: the throttle of failsafe stage 1 (rxfail) and the governor states; information only, no recommendation',
        note: 'note: information (the values of the parameter snapshot of the newest flight log, else of the CLI dump); thin: the log and the CLI dump do not give the values' },
};
const UNITS = { D9: 'state', D12: 'us' };

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const and = (a) => a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a.join('');
const many = (k, one, more) => `${k} ${k === 1 ? one : more || `${one}s`}`;
const PROFILES = Array.from({ length: RULE.profiles }, (_, i) => i + 1);
const pidOk = (p) => Number.isInteger(p) && p >= 1 && p <= RULE.profiles ? p : null;
// a rescue_mode value as its lookup name: 'CLIMB', 1 -> 'CLIMB', 0 -> 'OFF'; null for a value that is not a mode
function modeName(v) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < RULE.modes.length) return RULE.modes[v];
    const s = String(v === undefined || v === null ? '' : v).trim().toUpperCase();
    return RULE.modes.includes(s) ? s : null;
}
const same = (a, b) => String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
const armingOf = (arming, log) => { if (!arming) return null; const a = arming instanceof Map ? arming.get(log) : arming[log]; return a && a.confirmed === true ? pidOk(a.profile) : null; };

// ---------------------------------------------------------------------------------------------
// CLI dump
// ---------------------------------------------------------------------------------------------

// The rescue values of each PID profile of a CLI dump. A section that the dump has: the value of each line, else (a diff)
// the default; in a dump every value is a line, and a value that it does not have is unknown (null). on: rescue_mode is
// not OFF (null when the mode is not known)
function rescueOfCli(cli) {
    if (typeof cli === 'string') { const S = optional('./health_setup.cjs'); cli = S && typeof S.parseCli === 'function' ? S.parseCli(cli) : null; }
    if (!cli || typeof cli !== 'object') return null;
    const kind = cli.kind === 'dump' ? 'dump' : 'diff', out = { kind, profiles: {}, missing: [] };
    for (const p of PROFILES) {
        const sec = cli.profiles && cli.profiles[String(p - 1)];
        if (!sec) { out.missing.push(p); continue; }
        const params = {}, defaults = [], lines = [];
        for (const q of RESCUE) {
            const has = Object.prototype.hasOwnProperty.call(sec, q.name);
            if (has) lines.push(q.name);
            const v = has ? sec[q.name] : kind === 'diff' ? q.default : null;
            params[q.name] = v;
            if (v !== null && same(v, q.default)) defaults.push(q.name);
        }
        const mode = params.rescue_mode === null ? null : modeName(params.rescue_mode);
        out.profiles[p] = { mode, on: mode === null ? null : mode !== 'OFF', params, defaults, lines, cliProfile: p - 1 };
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// analyse
// ---------------------------------------------------------------------------------------------

function analyse(w, ctx = {}) {
    const n = w.n, rate = ctx.rate || w.rate, H = ctx.header || (w.flight && w.flight.header) || {}, pa = w.profileAt || null, rs = w.rescueAt || null;
    const fm = ctx.flightMask && ctx.flightMask.length === n ? ctx.flightMask : ctx.flying && ctx.flying.length === n ? ctx.flying : null;
    const T = w.extra && w.extra.time && w.extra.time.length === n ? w.extra.time : null, F = (i) => r(T ? w.fromS + (T[i] - T[0]) / 1e6 : w.fromS + i / rate, 3);
    const out = { module: 'health_config', rule: RULE, rate: r(rate, 2), fromS: r(w.fromS, 3), seconds: r(n / rate, 1), flightBy: ctx.flightMask ? 'phases' : fm ? 'flying' : null, labels: {}, rescues: [], header: {} };
    for (const k of Object.keys(H)) if (/^rescue/i.test(k)) out.header[k] = H[k];
    // D12: the throttle (motor[0] / 1000) at the inferred last RC frame of each receiver signal loss (lib.cjs rxLoss), and its median
    // in flight with the governor ACTIVE (state 4): the throttle that the governor decreases when the signal stops. rotor: at the last
    // RC frame the motor is on and the governor is ACTIVE or the headspeed is at the flight rpm or more (a loss on the ground with the
    // motor stopped does not give the throttle of a loss in flight)
    const mot = w.extra && w.extra['motor[0]'] && w.extra['motor[0]'].length === n ? w.extra['motor[0]'] : null, gs = ctx.govState || w.govStateAt || null;
    const hsFl = ctx.flightRule && typeof ctx.flightRule.headspeed === 'number' && isFinite(ctx.flightRule.headspeed) ? ctx.flightRule.headspeed : null;
    if (mot) {
        const lower = (us) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < us) lo = m + 1; else hi = m; } return lo; };
        const atLoss = (Array.isArray(w.rxLoss) ? w.rxLoss : []).filter(s => s && s.i1 > 0 && s.i0 < n).map(s => { const k = Math.max(0, Math.min(n - 1, T && isFinite(s.lastFrameUs) ? lower(s.lastFrameUs) : s.i0));
            return { tS: F(k), u: r(mot[k] / 1000, 3), rotor: mot[k] > 0 && ((!!gs && gs[k] === 4) || (hsFl !== null && !!w.hs && w.hs[k] >= hsFl)) }; });
        const v = []; if (fm) for (let i = 0; i < n; i += 10) if (fm[i] && (!gs || gs[i] === 4)) v.push(mot[i] / 1000);
        v.sort((a, b) => a - b);
        out.throttle = { atLoss, flight: v.length ? r(v[v.length >> 1], 3) : null, flightSamples: v.length };
    }
    if (!pa) { out.skipped = 'The log does not give the PID profile of each sample.'; return out; }
    const all = new Map(), fly = new Map();
    for (let i = 0; i < n; i++) { const p = pa[i]; all.set(p, (all.get(p) || 0) + 1); if (fm && fm[i]) fly.set(p, (fly.get(p) || 0) + 1); }
    for (const [p, c] of all) out.labels[p] = { seconds: r(c / rate, 2), flightS: fm ? r((fly.get(p) || 0) / rate, 2) : null };
    if (rs) for (let i = 0; i < n && out.rescues.length < RULE.maxRescues; i++) if (rs[i] && (i === 0 || !rs[i - 1]))
        out.rescues.push({ label: pa[i], t: r(w.fromS + i / rate, 3), tS: F(i), atStart: i === 0 }); // atStart: the rescue started before this segment
    return out;
}

// ---------------------------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------------------------

// D9 and D12
function judge(flights, RULES = DEFAULT_RULES, extra = {}) { return judgeD9(flights, RULES, extra).concat(judgeD12(flights, RULES, extra)); }

function judgeD9(flights, RULES = DEFAULT_RULES, extra = {}) {
    const R = Object.assign({}, DEFAULT_RULES.D9, (RULES && RULES.D9) || {}), x = extra || {}, F = [];
    const add = (o) => F.push(Object.assign({ id: 'D9', severity: 'ok', log: null, profile: null, value: null, se: null, n: null, threshold: { flag: R.flag }, source: R.source || null, unit: UNITS.D9, phase: null, thin: false }, o));
    // what the logs show for each PID profile: seconds, flight seconds, rescues, logs; the label 0 of a log with no confirmed arming profile is unknown
    const use = (flights || []).filter(f => f && f.metrics && !f.metrics.skipped);
    const P = {}, unknown = { seconds: 0, flightS: 0, rescues: 0, logs: new Set() }, header = {};
    for (const p of PROFILES) P[p] = { seconds: 0, flightS: 0, flightKnown: false, rescues: 0, logs: new Set(), rescueLogs: new Set() };
    for (const f of use) {
        const M = f.metrics, arm = armingOf(x.arming, f.log), pid = (label) => { const q = +label; return q >= 1 ? pidOk(q) : q === 0 ? arm : null; };
        for (const [label, s] of Object.entries(M.labels || {})) {
            const p = pid(label), Q = p === null ? unknown : P[p];
            Q.seconds += s.seconds || 0; if (typeof s.flightS === 'number') { Q.flightS += s.flightS; Q.flightKnown = true; }
            if ((s.seconds || 0) > 0) Q.logs.add(f.log);
        }
        for (const ev of M.rescues || []) { const p = pid(ev.label); if (p === null) unknown.rescues++; else { P[p].rescues++; P[p].rescueLogs.add(f.log); } }
        // a header with rescue_mode (not 4.6.0) holds the value of the confirmed arming profile
        const hm = M.header && M.header.rescue_mode !== undefined ? modeName(M.header.rescue_mode) : null;
        if (hm !== null && arm !== null && !header[arm]) header[arm] = { mode: hm, log: f.log };
    }
    const flown = (p) => (P[p].flightKnown ? P[p].flightS : P[p].seconds) >= RULE.minFlightS;
    const logsOf = (set) => [...set].sort((a, b) => a - b);
    const flightText = (p) => !use.length ? '' : !flown(p) ? 'The logs have no flight in this PID profile.' : P[p].flightKnown ? `The logs have ${r(P[p].flightS, 0)} s of flight in this PID profile.` : 'The logs show this PID profile in flight.';
    const rescueText = (p) => P[p].rescues ? `The logs show ${many(P[p].rescues, 'rescue')} in this PID profile.` : '';
    const why = '`rescue_mode` is a value of each PID profile. If the pilot operates the rescue switch in this PID profile, the helicopter does not level and does not climb.';
    const facts = (p) => ({ flown: flown(p), flightS: r(P[p].flightKnown ? P[p].flightS : P[p].seconds, 1), rescues: P[p].rescues, logs: logsOf(P[p].logs), rescueLogs: logsOf(P[p].rescueLogs) });
    const para = (...a) => a.filter(Boolean).join('\n');

    // a parameter snapshot in the log header (blackbox_params FULL; extra.snapshots { log: snapshot } from the worker, else param_log.cjs
    // snapshotOf of the header): the rescue values of every PID profile at the start of the newest flight log that has one. It ranks
    // above a CLI dump (IMP-05: the dump can be of a different time)
    const PL = optional('./param_log.cjs'), snapOf = (f) => x.snapshots && Object.prototype.hasOwnProperty.call(x.snapshots, f.log) ? x.snapshots[f.log] : PL && typeof PL.snapshotOf === 'function' ? PL.snapshotOf(f.header) : null;
    const snapLog = use.map(f => ({ log: f.log, snap: snapOf(f) })).filter(o => o.snap).sort((a, b) => b.log - a.log)[0] || null;
    const C = snapLog ? rescueOfCli({ kind: 'dump', profiles: snapLog.snap.profiles }) : x.cli ? rescueOfCli(x.cli) : null, snapBasis = !!snapLog;
    if (C) {
        for (const p of PROFILES) {
            const q = C.profiles[p]; if (!q) continue;
            const line = snapBasis ? (q.lines.includes('rescue_mode') ? `The log header of log ${snapLog.log} gives \`rescue_mode = ${q.params.rescue_mode}\` for this PID profile.` : `The log header of log ${snapLog.log} does not give \`rescue_mode\` for this PID profile.`)
                : q.lines.includes('rescue_mode') ? `The CLI dump has \`set rescue_mode = ${q.params.rescue_mode}\` in \`profile ${p - 1}\`.`
                : C.kind === 'diff' ? `The CLI dump has no \`rescue_mode\` line in \`profile ${p - 1}\`. Thus, the value is the default value, OFF.` : `The CLI dump has no \`rescue_mode\` line in \`profile ${p - 1}\`.`;
            const other = RESCUE.filter(v => v.name !== 'rescue_mode' && q.params[v.name] !== null && !q.defaults.includes(v.name)).map(v => `\`${v.name} = ${q.params[v.name]}\``);
            const otherText = other.length ? `These rescue values are not at their default values: ${other.length > RULE.maxParams ? `${other.slice(0, RULE.maxParams).join(', ')} and ${other.length - RULE.maxParams} more` : and(other)}.` : 'The other rescue values are at their default values.';
            const base = Object.assign({ profile: p, basis: snapBasis ? 'snapshot' : 'cli', cliKind: snapBasis ? null : C.kind, cliProfile: p - 1, mode: q.mode, params: q.params, defaults: q.defaults, n: P[p].rescues },
                snapBasis ? { log: snapLog.log } : {}, facts(p));
            const what = snapBasis ? 'the log header' : 'the CLI dump';
            if (q.on === null) { add(Object.assign(base, { severity: 'note', thin: true, value: null, text: para(`In PID profile ${p}, ${what} does not give a known \`rescue_mode\` value. ${line}`, 'The analysis cannot find if the rescue is on in this PID profile.', flightText(p)) })); continue; }
            if (!q.on) { const conflict = P[p].rescues > 0;
                add(Object.assign(base, { severity: 'flag', value: 0, conflict, text: para(`In PID profile ${p}, the rescue switch does not start a rescue, because \`rescue_mode\` is OFF.`, why,
                    `${line} The limit is a value other than OFF (CLIMB or ALT_HOLD).`, flightText(p) + (conflict ? ` But the logs show ${many(P[p].rescues, 'rescue')} in this PID profile. Thus, ${snapBasis ? '`rescue_mode` is possibly different in some logs.' : 'the CLI dump is possibly not from the time of these logs.'}` : '')) })); continue; }
            add(Object.assign(base, { severity: 'ok', value: 1, text: para(`The rescue mode is on in PID profile ${p}. ${line}`, otherText, [flightText(p), rescueText(p)].filter(Boolean).join(' ')) }));
        }
        if (C.missing.length) { const fl = C.missing.filter(flown);
            add({ severity: 'note', thin: true, basis: 'cli', cliKind: C.kind, unknownProfiles: C.missing.slice(), flownUnknown: fl, unknownRescues: unknown.rescues,
                text: para(`The CLI dump does not have PID ${C.missing.length > 1 ? 'profiles' : 'profile'} ${and(C.missing.map(String))}. Thus, the analysis cannot find if the rescue is on in ${C.missing.length > 1 ? 'these PID profiles' : 'this PID profile'}.`,
                    fl.length ? `The logs have flight in PID ${fl.length > 1 ? 'profiles' : 'profile'} ${and(fl.map(String))}.` : '', 'The log header does not record `rescue_mode`. The log records a rescue only when it occurs.') });
        }
        return F;
    }
    if (!use.length) { add({ severity: 'skipped', text: 'The analysis has no flight log. Thus, this check did not operate.' }); return F; }
    const known = [];
    for (const p of PROFILES) {
        const h = header[p];
        if (h) { known.push(p); const off = h.mode === 'OFF', conflict = off && P[p].rescues > 0;
            add(Object.assign({ profile: p, basis: 'header', mode: h.mode, log: h.log, severity: off ? 'flag' : 'ok', value: off ? 0 : 1, n: P[p].rescues }, off ? { conflict } : {}, facts(p), { text: off
                ? para(`In PID profile ${p}, the rescue switch does not start a rescue, because \`rescue_mode\` is OFF.`, why, `In PID profile ${p}, the log header gives \`rescue_mode\` OFF. The limit is a value other than OFF (CLIMB or ALT_HOLD).`,
                    flightText(p) + (conflict ? ` But the logs show ${many(P[p].rescues, 'rescue')} in this PID profile. Thus, \`rescue_mode\` is possibly different in some logs.` : ''))
                : para(`The rescue mode is on in PID profile ${p}. The log header gives \`rescue_mode\` ${h.mode} for this PID profile.`, [flightText(p), rescueText(p)].filter(Boolean).join(' ')) })); continue; }
        if (P[p].rescues > 0) { known.push(p);
            add(Object.assign({ profile: p, basis: 'log', mode: null, log: logsOf(P[p].rescueLogs), severity: 'ok', value: 1, n: P[p].rescues }, facts(p), {
                text: para(`In PID profile ${p}, the logs show ${many(P[p].rescues, 'rescue')}. The firmware starts a rescue only if \`rescue_mode\` is not OFF. Thus, the rescue is on in this PID profile.`, flightText(p)) })); continue; }
        if (flown(p)) add(Object.assign({ profile: p, basis: 'log', mode: null, log: logsOf(P[p].logs), severity: 'note', thin: true, value: null, n: 0 }, facts(p), {
            text: para(`In PID profile ${p}, the logs show no rescue. The log header does not record \`rescue_mode\`. Thus, the analysis cannot find if the rescue is on in this PID profile.`, flightText(p)) }));
    }
    const unk = PROFILES.filter(p => !known.includes(p));
    if (unk.length) add({ severity: 'note', thin: true, basis: 'log', unknownProfiles: unk, flownUnknown: unk.filter(flown), unknownRescues: unknown.rescues, log: logsOf(new Set(use.map(f => f.log))),
        text: para(`The log header does not record \`rescue_mode\`. Thus, the analysis cannot find if the rescue is on in PID ${unk.length > 1 ? 'profiles' : 'profile'} ${and(unk.map(String))}.`,
            unknown.rescues ? `The logs show ${many(unknown.rescues, 'rescue')} in a part of the log with an unknown PID profile.` : '',
            `The log records a rescue only when it occurs, and the logs show no rescue in ${unk.length > 1 ? 'these PID profiles' : 'this PID profile'}.`) });
    return F;
}

// ---------------------------------------------------------------------------------------------
// D12: the response of the firmware when the receiver signal stops (IMP-11)
// ---------------------------------------------------------------------------------------------

// the pulse that the CLI keeps for a typed `rxfail <n> s <us>` (CHANNEL_VALUE_TO_RXFAIL_STEP, then RXFAIL_STEP_TO_CHANNEL_VALUE)
function rxfailPulse(typed) {
    const R = RULE.rxfail, step = Math.min(R.rangeMax, Math.max(0, Math.trunc((Math.round(+typed) - R.pulseMin) / R.stepUs)));
    return R.pulseMin + R.stepUs * step;
}
const GOV_LOG_NAME = { THROTTLE_OFF: 'OFF', THROTTLE_IDLE: 'IDLE', THROTTLE_HOLD: 'HOLD', AUTOROTATION: 'AUTOROTATION', ACTIVE: 'ACTIVE' }; // the names of the log (GOVSTATE)
const numOf = (v) => typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? +v : null;

// The values of D12 of a parameter snapshot (basis 'snapshot': every value) or of a parsed CLI dump (basis 'cli'; a `diff` leaves out a
// default value: the table of its build and board, cli_defaults.cjs, else the value is missing; with no `rxfail 4` line the reset value
// AUTO of a control channel). A restore script of `set` lines can look like a `dump` (health_setup parseCli): the defaults apply to
// every CLI dump, and a `dump all` has all the values. -> { values, rxfail (['a'] | ['h'] | ['s', us] | null), missing, defaulted, basis, kind }
function throttleValues(src, basis) {
    const R = RULE.rxfail, g = (src && src.global) || {}, rx = (src && src.rxfail) || {}, diff = basis === 'cli';
    let D = null;
    if (diff) { const CD = optional('./cli_defaults.cjs'); try { D = CD && src.versionLine && src.board ? CD.forRevision(`${src.versionLine}\nboard_name ${src.board}`) : null; } catch (e) { D = null; } }
    const values = {}, missing = [], defaulted = [];
    for (const k of R.names) {
        let v = g[k];
        if ((v === undefined || v === null) && D && D.global && D.global[k] !== undefined) { v = D.global[k]; defaulted.push(k); }
        if (v === undefined || v === null) missing.push(k);
        else { const q = numOf(v), L = R.lookups[k]; values[k] = L ? (q !== null ? (Number.isInteger(q) && q >= 0 && q < L.length ? L[q] : String(q)) : String(v).trim().toUpperCase()) : q !== null ? q : String(v).trim().toUpperCase(); }
    }
    let fail = rx[R.channel] || rx[String(R.channel)] || null;
    if (!fail && diff) { fail = ['a']; defaulted.push('rxfail'); }
    if (!fail) missing.push('rxfail');
    return { values, rxfail: fail, missing, defaulted, basis, kind: basis === 'snapshot' ? 'snapshot' : src.kind || null };
}

// What the firmware does with the throttle when the receiver signal stops, from the values v (throttleValues) and the rxfail entry
// of the throttle channel; u0: the throttle (0..1) when the signal stops, or null. -> { ok, pulse (µs, null for HOLD), mode, band
// ('off', 'IDLE', 'AUTO', 'MAX' of FUNCTION; 'LOW', 'HIGH' of NORMAL and SWITCH (the handover); 'ON' with the governor OFF; 'HOLD'
// for rxfail h), state (the governor state from ACTIVE, firmware names: THROTTLE_HOLD, AUTOROTATION, ACTIVE; null with the governor
// OFF or not modelled), stateLog (the name of the log), cut (the motor stops at once), inputOff (the throttle input is off: after the
// time limit HOLD changes to OFF, else to IDLE), target (the throttle that the output goes to, null: governed), decayPerS, motorOffS
// (from the rxfail values to the motor stop, null: not known or no stop), unbounded (the motor does not stop), recovery { to, limitS },
// minThrottle, maxThrottle, offThrottle, autoPulse, typed (the value of an `s` entry as the CLI text has it; pulse is the value that the
// CLI keeps, rxfailPulse), modelled (gov_mode OFF, ELECTRIC or NITRO), groups (the stored pulses with the same response: [{ from, to,
// band, state, stateLog, target, cut, inputOff, motorOffS, unbounded, recovery }]), missing }
function rxfailResponse(v, fail, u0 = null) {
    const R = RULE.rxfail, clamp = (q, a, b) => Math.min(b, Math.max(a, q)), num = (k) => numOf(v[k]);
    const need = ['rc_center', 'rc_deflection'].filter(k => num(k) === null);
    if (need.length) return { ok: false, missing: need };
    const minT = num('rc_min_throttle') ? clamp(num('rc_min_throttle'), R.pulseLimits[0], R.pulseLimits[1]) : num('rc_center') - num('rc_deflection') * R.deflectionShare;
    const maxT = Math.max(num('rc_max_throttle') ? clamp(num('rc_max_throttle'), R.pulseLimits[0], R.pulseLimits[1]) : num('rc_center') + num('rc_deflection') * R.deflectionShare, minT + R.minRangeUs);
    const off = minT - R.deadbandUs, autoPulse = Math.trunc(off - R.deadbandUs), thr = (p) => p > maxT ? 1 : p < minT ? 0 : (p - minT) / (maxT - minT);
    const mode = String(v.gov_mode === undefined ? '' : v.gov_mode).toUpperCase(), type = String(v.gov_throttle_type === undefined ? '' : v.gov_throttle_type).toUpperCase();
    const governed = mode === 'ELECTRIC' || mode === 'NITRO', bypass = mode === 'OFF' || mode === '0' || mode === 'NONE';
    const govNeed = governed ? ['gov_throttle_type', 'gov_handover_throttle', 'gov_idle_throttle', 'gov_auto_throttle', 'gov_autorotation_timeout', 'gov_throttle_hold_timeout', 'gov_spooldown_time'].filter(k => v[k] === undefined) : [];
    const missing = (v.gov_mode === undefined ? ['gov_mode'] : []).concat(govNeed);
    const idle = (num('gov_idle_throttle') || 0) / 1000, auto = (num('gov_auto_throttle') || 0) / 1000, hand = num('gov_handover_throttle') !== null ? num('gov_handover_throttle') / 100 : null;
    const sd = num('gov_spooldown_time'), rate = sd === null ? null : sd > 0 ? 10 / clamp(sd, R.spooldown[0], R.spooldown[1]) : Infinity;
    const holdS = num('gov_throttle_hold_timeout') !== null ? num('gov_throttle_hold_timeout') / 10 : null, autoS = num('gov_autorotation_timeout');
    const bandOf = (p) => p < off ? 'off' : bypass ? 'ON' : type === 'FUNCTION' ? (thr(p) < R.band[0] ? 'IDLE' : thr(p) < R.band[1] ? 'AUTO' : 'MAX') : hand === null ? null : thr(p) < hand ? 'LOW' : 'HIGH';
    // the governor from ACTIVE with the input of pulse p (govGetInputThrottle, govUpdateGovernedState, govThrottleSlewControl)
    const respond = (p) => {
        const band = bandOf(p), o = { band, state: null, stateLog: null, target: null, cut: false, inputOff: band === 'off', motorOffS: null, unbounded: false, recovery: null };
        if (band === 'off') Object.assign(o, governed ? { state: 'THROTTLE_HOLD', recovery: holdS === null ? null : { to: 'RECOVERY', limitS: holdS } } : {}, { target: 0, cut: true, motorOffS: 0 });
        else if (bypass) Object.assign(o, { target: r(thr(p), 3), unbounded: thr(p) > 0, motorOffS: thr(p) > 0 ? null : 0 });
        else if (governed && band !== null && hand !== null) {
            const input = type === 'FUNCTION' ? (band === 'IDLE' ? idle : band === 'AUTO' ? auto : 1) : type === 'SWITCH' && thr(p) > hand ? 1 : thr(p);
            if (input >= hand) Object.assign(o, { state: 'ACTIVE', unbounded: true });
            else {
                const autorot = autoS !== null && autoS > 0 && input >= auto, target = r(clamp(input, autorot ? auto : idle, hand), 3);
                Object.assign(o, { state: autorot ? 'AUTOROTATION' : 'THROTTLE_HOLD', target, recovery: autorot ? (autoS === null ? null : { to: 'BAILOUT', limitS: autoS }) : holdS === null ? null : { to: 'RECOVERY', limitS: holdS } });
                if (target > 0) o.unbounded = true; else if (rate !== null && u0 !== null) o.motorOffS = rate === Infinity ? 0 : r(Math.max(0, u0) / rate, 2);
            }
        }
        o.stateLog = o.state ? GOV_LOG_NAME[o.state] || o.state : null;
        return o;
    };
    // a CLI text can have a value that is not a step (a restore script or a typed diff: `rxfail 4 s 1037`): the firmware keeps the step below
    const kind = fail ? String(fail[0]).toLowerCase() : null, typed = kind === 's' ? numOf(fail[1]) : null, pulse = kind === 'a' ? autoPulse : typed !== null ? rxfailPulse(typed) : null;
    const out = Object.assign({ ok: true, mode: kind, pulse, typed, minThrottle: r(minT, 1), maxThrottle: r(maxT, 1), offThrottle: r(off, 1), autoPulse, decayPerS: rate === null || rate === Infinity ? null : r(rate, 4), missing, modelled: governed || bypass },
        kind === 'h' ? { band: 'HOLD', state: governed ? 'ACTIVE' : null, stateLog: governed ? 'ACTIVE' : null, target: null, cut: false, inputOff: false, motorOffS: null, unbounded: true, recovery: null } : pulse === null ? { band: null, state: null } : respond(pulse));
    out.groups = [];
    for (let k = 0; k <= R.rangeMax; k++) { const p = R.pulseMin + R.stepUs * k, q = respond(p), last = out.groups[out.groups.length - 1], key = `${q.band}|${q.state}|${q.target}`;
        if (last && last.key === key) last.to = p; else out.groups.push(Object.assign({ key, from: p, to: p }, q)); }
    out.groups.forEach(g => delete g.key);
    return out;
}

// D12 findings: one result for the file, from the snapshot of the newest flight log that has one (else the CLI dump). With both,
// the dump is also calculated when its values are different (a dump of another time: the current values can be the dump's)
function judgeD12(flights, RULES = DEFAULT_RULES, extra = {}) {
    const R = Object.assign({}, DEFAULT_RULES.D12, (RULES && RULES.D12) || {}), x = extra || {}, Rr = RULE.rxfail, F = [], para = (...a) => a.filter(Boolean).join('\n');
    const add = (o) => F.push(Object.assign({ id: 'D12', severity: 'note', log: null, profile: null, value: null, se: null, n: null, threshold: 'report only', source: R.source || null, unit: UNITS.D12, phase: null, thin: false, export: false }, o));
    const use = (flights || []).filter(f => f && f.metrics && !f.metrics.skipped);
    const PL = optional('./param_log.cjs'), snapOf = (f) => x.snapshots && Object.prototype.hasOwnProperty.call(x.snapshots, f.log) ? x.snapshots[f.log] : PL && typeof PL.snapshotOf === 'function' ? PL.snapshotOf(f.header) : null;
    const snapLog = use.map(f => ({ log: f.log, header: f.header, snap: snapOf(f) })).filter(o => o.snap).sort((a, b) => b.log - a.log)[0] || null;
    let cli = x.cli || null; if (typeof cli === 'string') { const S = optional('./health_setup.cjs'); cli = S && typeof S.parseCli === 'function' ? S.parseCli(cli) : null; }
    if (!use.length && !cli) { add({ severity: 'skipped', text: 'The analysis has no flight log. Thus, this check did not operate.' }); return F; }
    const newest = use.slice().sort((a, b) => b.log - a.log)[0] || null, H = (snapLog && snapLog.header) || (newest && newest.header) || {};
    const fw = H.firmwareVersion || (cli && cli.version) || null, mm = (v) => { const p = String(v || '').split('.'); return p.length >= 2 && p[0] !== '' ? `${+p[0]}.${+p[1]}` : null; };
    const stage2 = Rr.stage2Off.includes(mm(fw)), modelled = Rr.firmware.includes(mm(fw));
    // the throttle when the signal stops: at the first loss of the logs with the rotor turning (the snapshot log first; analyse: the motor
    // on, the governor ACTIVE or the headspeed at the flight rpm), else the median in flight of the newest log
    const order = use.slice().sort((a, b) => (snapLog && b.log === snapLog.log) - (snapLog && a.log === snapLog.log) || b.log - a.log);
    const lossOf = order.map(f => f.metrics.throttle && Array.isArray(f.metrics.throttle.atLoss) ? f.metrics.throttle.atLoss.find(e => e && e.rotor === true) : null).find(Boolean) || null;
    const fly = order.map(f => f.metrics.throttle && f.metrics.throttle.flight).find(v => typeof v === 'number') ?? null;
    const u0 = lossOf ? lossOf.u : fly, u0Basis = lossOf ? 'loss' : fly !== null ? 'flight' : null;
    const f1 = (v, d = 1) => typeof v === 'number' && isFinite(v) ? String(+v.toFixed(d)) : 'unknown', us = (p) => `${f1(p, 0)} µs`;
    const cmd = (fail) => !fail ? '`rxfail 4`' : fail[0] === 's' ? `\`rxfail 4 s ${fail[1]}\`` : `\`rxfail 4 ${fail[0]}\``;
    const stage2Text = stage2 ? para(`On Rotorflight ${fw}, failsafe "stage 2" does not operate. Thus, ${and(Rr.stage2.map(k => `\`${k}\``))} have no effect in flight.`
        + ' The `failsafe_switch_mode` values STAGE2 and KILL also have no effect. The Rotorflight documentation shows that "stage 2" disarms, but this firmware does not.') : '';
    const base = { log: snapLog ? snapLog.log : null, basis: snapLog ? 'snapshot' : cli ? 'cli' : null, firmware: fw, modelled, stage2Off: stage2, cutDelayS: Rr.cutDelayS.slice(), throttleAtStop: u0, throttleBasis: u0Basis };
    const src = snapLog ? throttleValues(snapLog.snap, 'snapshot') : cli ? throttleValues(cli, 'cli') : null;
    const what = snapLog ? `the log header of log ${snapLog.log}` : 'the CLI dump'; // a log number from 0, as every toolkit text (the app shows it from 1: tuning_worker viewerText)
    if (!src || src.missing.includes('rxfail') || src.missing.includes('rc_center') || src.missing.includes('rc_deflection')) {
        const miss = src ? src.missing : ['rxfail'].concat(Rr.names);
        add(Object.assign(base, { thin: true, missing: miss, text: para(`${src ? (snapLog ? 'The log header does not record' : 'The CLI dump does not give') : 'The log header does not record'} ${and(miss.map(k => `\`${k}\``))}. ` +
            'Thus, the analysis cannot calculate the response of the firmware when the receiver signal stops.', src ? '' : 'The log header of a firmware with `blackbox_params` records these values.', stage2Text) }));
        return F;
    }
    if (!modelled) { add(Object.assign(base, { thin: true, rxfail: src.rxfail, values: src.values, text: para(`The governor model of the app is for firmware ${and(Rr.firmware)} only. Thus, the analysis cannot calculate the response of firmware ${fw || 'of an unknown version'}.`, stage2Text) })); return F; }
    const res = rxfailResponse(src.values, src.rxfail, u0);
    const typedText = (q, fail) => fail && fail[0] === 's' && q.typed !== null && q.typed !== undefined && q.pulse !== null && q.typed !== q.pulse ? `The CLI text has ${cmd(fail)}. The firmware keeps ${us(q.pulse)}.` : '';
    // gov_mode LIMIT or DIRECT (or a value that is not known): the stored throttle and if it is off, with no band and no governor state
    if (!res.modelled) { const gm = src.values.gov_mode === undefined ? null : String(src.values.gov_mode);
        add(Object.assign(base, { thin: true, modelled: false, value: res.pulse, typed: res.typed, rxfail: src.rxfail, mode: res.mode, band: null, state: null, stateLog: null, cut: res.band === 'off', values: src.values, missing: src.missing, defaulted: src.defaulted, govMode: gm,
            text: para([src.rxfail[0] === 'h' ? `With ${cmd(src.rxfail)}, the firmware keeps the last throttle position after the last RC frame.` : `With ${cmd(src.rxfail)}, the firmware sets the throttle to ${us(res.pulse)} at ${f1(Rr.cutDelayS[0])} s to ${f1(Rr.cutDelayS[1])} s after the last RC frame.`,
                typedText(res, src.rxfail), res.band === 'off' ? `This value is less than the off value of the throttle (${us(res.offThrottle)}), and the motor stops.` : res.pulse !== null ? `This value is not less than the off value of the throttle (${us(res.offThrottle)}).` : ''].filter(Boolean).join(' '),
                (gm === null ? `${snapLog ? 'The log header does not record' : 'The CLI dump does not give'} \`gov_mode\`. Thus, the app does not calculate the governor response.` : `The app does not calculate the governor response for \`gov_mode = ${gm}\`.`)
                    + ` The governor model of the app is for \`gov_mode\` ${and(Rr.modes)} only.`, stage2Text) }));
        return F; }
    const bandText = (q) => { const g = res.groups.find(o => q.pulse !== null && o.from <= q.pulse && o.to >= q.pulse) || null;
        return q.band === 'off' ? `This value is less than the off value of the throttle (${us(res.offThrottle)}).` : q.band === 'HOLD' || !q.band ? '' : `This value is in the ${q.band} band${g ? ` (${us(g.from)} to ${us(g.to)})` : ''}.`; };
    const stateText = (q) => q.cut ? (q.state ? `Thus, the governor changes from ACTIVE to ${q.stateLog}, and the motor stops immediately.` : 'Thus, the motor stops immediately.')
        : q.state === 'ACTIVE' ? 'Thus, the governor stays in ACTIVE, and the motor does not stop.'
        : q.state ? `Thus, the governor changes from ACTIVE to ${q.stateLog}. ` + (res.decayPerS === null ? 'The throttle decreases immediately' : `The throttle decreases by ${f1(res.decayPerS, 3)} each second`)
            + (q.target > 0 ? ` to ${f1(q.target * 100)} %, and the motor does not stop.` : q.motorOffS !== null ? `, and the motor stops after approximately ${f1(q.motorOffS)} s.` : '.')
        : q.band === 'ON' ? `Thus, the throttle goes to ${f1((q.target || 0) * 100)} %.` : '';
    // governor.c govUpdateGovernedState: HOLD -> RECOVERY and AUTOROTATION -> BAILOUT only with the throttle input more than the handover
    // value and a good RPM signal; after gov_throttle_hold_timeout HOLD changes to OFF with the input off, else to IDLE; after
    // gov_autorotation_timeout AUTOROTATION changes to IDLE
    const cond = 'For this change, the throttle must be more than the handover value, and the RPM signal must be good.';
    const recText = (q) => !q.recovery ? '' : q.recovery.to === 'RECOVERY' ? `If the signal comes back in ${f1(q.recovery.limitS)} s, the governor can change to RECOVERY. ${cond} `
            + (q.inputOff ? 'After this time, it changes to OFF, and the rotor must spool up again.' : 'After this time, it changes to IDLE.')
        : `If the signal comes back in ${f1(q.recovery.limitS)} s, the governor can change to BAILOUT. ${cond} After this time, it changes to IDLE.`;
    const u0Text = (q) => q.motorOffS > 0 ? (u0Basis === 'loss' ? `This time is for the throttle at the last RC frame (${f1(u0 * 100, 0)} %).` : `This time is for the median throttle in flight (${f1(u0 * 100, 0)} %).`)
        : q.state && !q.cut && q.target === 0 && q.motorOffS === null ? 'The log does not show the throttle in flight. Thus, the analysis cannot calculate the time to the motor stop.' : '';
    const head = (q, fail) => fail[0] === 'h' ? `With ${cmd(fail)}, the firmware keeps the last throttle position after the last RC frame.`
        : `With ${cmd(fail)}, the firmware sets the throttle to ${us(q.pulse)} at ${f1(Rr.cutDelayS[0])} s to ${f1(Rr.cutDelayS[1])} s after the last RC frame.`;
    const now = para([head(res, src.rxfail), typedText(res, src.rxfail), bandText(res), stateText(res), u0Text(res)].filter(Boolean).join(' '), recText(res));
    const shown = ['rc_min_throttle', 'gov_mode', 'gov_throttle_type', 'gov_idle_throttle', 'gov_auto_throttle', 'gov_spooldown_time'].filter(k => src.values[k] !== undefined).map(k => `\`${k} = ${src.values[k]}\``);
    const valueText = `The values come from ${what}.` + (snapLog ? '' : ' The log header does not record them.') + ` They are ${and([cmd(src.rxfail)].concat(shown))}.` + ` The throttle range is ${us(res.minThrottle)} to ${us(res.maxThrottle)}.`
        + (src.defaulted.length ? ` The CLI dump does not show ${and(src.defaulted.map(k => `\`${k}\``))}. Thus, the analysis uses the default values of this firmware.` : '')
        + (src.missing.length ? ` ${snapLog ? 'The log header does not record' : 'The CLI dump does not give'} ${and(src.missing.map(k => `\`${k}\``))}.` : '');
    // the options: each group of the stored pulses with its response, the default and rxfail h (no recommendation: the text only)
    const opt = [], range = (g) => g.from === g.to ? `\`rxfail 4 s ${g.from}\`` : `\`rxfail 4 s ${g.from}\` to \`rxfail 4 s ${g.to}\``, holdG = res.groups.find(g => g.state === 'ACTIVE');
    const defRes = rxfailResponse(src.values, ['a'], u0);
    opt.push(`The default \`rxfail 4 a\` stops the motor ${f1(Rr.cutDelayS[0])} s to ${f1(Rr.cutDelayS[1])} s after the last RC frame.` + (defRes.cut ? ' Then the headspeed decreases until the signal comes back, and the helicopter can fall.' : ''));
    // the bands with the same response are one option (FUNCTION with gov_idle_throttle = gov_auto_throttle: IDLE and AUTO)
    const same = (a, b) => a.state === b.state && a.target === b.target && JSON.stringify(a.recovery) === JSON.stringify(b.recovery) && a.motorOffS === b.motorOffS, merged = [];
    for (const g of res.groups) { const last = merged[merged.length - 1]; if (last && same(last, g) && last.to + Rr.stepUs === g.from) { last.to = g.to; last.bands.push(g.band); } else merged.push(Object.assign({}, g, { bands: [g.band] })); }
    for (const g of merged) if (g.band !== 'off' && g.state && g.state !== 'ACTIVE')
        opt.push(`With ${range(g)} (the ${and(g.bands)} ${g.bands.length > 1 ? 'bands' : 'band'}), the governor changes to ${g.stateLog}` + (g.target > 0 ? `, and the throttle goes to ${f1(g.target * 100)} %. The motor does not stop.` : g.motorOffS !== null ? `, and the motor stops after approximately ${f1(g.motorOffS)} s.` : '.')
            + (g.recovery ? ` If the signal comes back in ${f1(g.recovery.limitS)} s, the governor can change to ${g.recovery.to}. ${cond}` : '') + (g.target === 0 ? ' If the signal does not come back, the motor operates for this time after the RC values change.' : ''));
    if (holdG) opt.push(`With \`rxfail 4 s ${holdG.from}\` or more, or with \`rxfail 4 h\`, the governor stays in ACTIVE. If the signal does not come back, the motor does not stop until the battery is empty.`);
    const offG = res.groups.find(g => g.band === 'off'), typedOff = offG ? Math.ceil(res.offThrottle) : null;
    if (offG && typedOff !== null && typedOff % Rr.stepUs !== 0 && rxfailPulse(typedOff) < res.offThrottle)
        opt.push(`The CLI keeps a value in steps of ${Rr.stepUs} µs from ${Rr.pulseMin} µs. Thus, \`rxfail 4 s ${typedOff}\` to \`rxfail 4 s ${typedOff + Rr.stepUs - 1 - ((typedOff - Rr.pulseMin) % Rr.stepUs)}\` give ${us(rxfailPulse(typedOff))}, which is off.`);
    opt.push('The app does not write `rxfail` lines in the export. Before you change `rxfail 4`, compare the risks of these values.');
    // a CLI dump with other values than the snapshot: its response too (it can be of a later time than the log)
    let alt = null;
    if (snapLog && cli) { const c = throttleValues(cli, 'cli'), same = JSON.stringify(c.rxfail) === JSON.stringify(src.rxfail) && Rr.names.every(k => c.values[k] === undefined || String(c.values[k]) === String(src.values[k]));
        if (!same && !c.missing.includes('rxfail') && !c.missing.includes('rc_center') && !c.missing.includes('rc_deflection')) { const q = rxfailResponse(c.values, c.rxfail, u0);
            alt = { rxfail: c.rxfail, band: q.band, state: q.state, stateLog: q.stateLog, cut: !!q.cut, pulse: q.pulse, typed: q.typed, target: q.target, motorOffS: q.motorOffS, unbounded: q.unbounded, recovery: q.recovery, modelled: q.modelled,
                text: para(`The CLI dump gives ${cmd(c.rxfail)}, and the log header gives ${cmd(src.rxfail)}. Thus, the CLI dump is possibly not of the time of the log.`,
                    [`With the values of the CLI dump${q.pulse !== null ? `, the throttle is ${us(q.pulse)}` : ''}.`, typedText(q, c.rxfail), bandText(q), stateText(q), u0Text(q)].filter(Boolean).join(' '), recText(q)) }; } }
    add(Object.assign(base, { value: res.pulse, rxfail: src.rxfail, mode: res.mode, band: res.band, state: res.state, stateLog: res.stateLog, cut: res.cut, target: res.target, decayPerS: res.decayPerS,
        motorOffS: res.motorOffS, unbounded: res.unbounded, recovery: res.recovery, throttleRange: [res.minThrottle, res.maxThrottle], offThrottle: res.offThrottle, autoPulse: res.autoPulse,
        values: src.values, missing: src.missing, defaulted: src.defaulted, groups: res.groups, cliAlt: alt, cliDiffers: !!alt, typed: res.typed,
        text: [now, alt ? alt.text : '', valueText, stage2Text, ...opt].filter(Boolean).join('\n') }));
    return F;
}

module.exports = { EXTRA, RULE, DEFAULT_RULES, RESCUE, analyse, judge, rescueOfCli, modeName, rxfailPulse, rxfailResponse, throttleValues };
if (require.main !== module) return;

// node tools/autotune/health_config.cjs <log files...> [--cli <cli dump>]: check D9 over the flight logs (a log with no
// flight is a bench run, as health_phase.cjs finds it; set AUTOTUNE_FLIGHT_RPM for a slow rotor) and the CLI dump. The label 0 of a log is its arming profile only
// when a PID profile change at the first frame shows it (the CLI cannot find the other confirmations of the app)
const fs = require('node:fs');
const lib = require('./lib.cjs'), HC = require('./health.cjs'), PH = optional('./health_phase.cjs'), S = require('./health_setup.cjs');
const args = process.argv.slice(2), ci = args.indexOf('--cli'), cliFile = ci >= 0 ? args.splice(ci, 2)[1] : null;
const app = lib.loadApp(), all = [], arming = {}, flown = new Set();
for (const file of args) for (const w of lib.segments(app, file, { whole: true, extra: ['time'].concat(PH && PH.EXTRA || []) })) {
    if (w.skipped) continue;
    const fl = w.flight, ctx = { rate: fl.actualRate, header: fl.header, govState: w.govStateAt || null, flightRule: HC.RULE.flight };
    if (PH && typeof PH.phases === 'function') { try { const P = PH.phases(w, ctx); ctx.flightMask = PH.flightMask(w, ctx, P); if (P.flight) flown.add(fl.log); } catch (e) { flown.add(fl.log); } } else flown.add(fl.log);
    if (w.profileAt && w.profileAt[0] > 0) arming[fl.log] = { profile: w.profileAt[0], confirmed: true };
    all.push({ log: fl.log, segment: 0, header: fl.header, metrics: analyse(w, ctx) });
}
for (const f of judge(all.filter(f => flown.has(f.log)), DEFAULT_RULES, { cli: cliFile ? S.parseCli(fs.readFileSync(cliFile, 'utf8')) : null, arming }))
    console.log(`D9 ${f.severity} p${f.profile} ${f.basis || ''} logs ${JSON.stringify(f.log)}\n  ${String(f.text).replace(/\n/g, '\n  ')}`);
