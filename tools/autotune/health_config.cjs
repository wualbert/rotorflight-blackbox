'use strict';

/**
 * Configuration checks that are prerequisites of the tuning (SPEC3 A: the prerequisites band), new id:
 *
 *   D9   rescue on in every PID profile: rescue_mode of each PID profile from the CLI dump (each `profile` section), or,
 *        without a dump, the rescues that the logs show in each PID profile. A PID profile with rescue_mode OFF is a
 *        problem: in that PID profile the rescue switch does not start a rescue
 *
 *   rescueOfCli(cli)          rescue_mode and the other rescue values of each PID profile of a CLI dump (parsed with
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
    source: {
        modes: 'firmware 4.6.0: the values of rescue_mode are OFF, CLIMB and ALT_HOLD',
        profiles: 'firmware 4.6.0: 6 PID profiles, and `diff all` shows all of them',
        minFlightS: 'pipeline, unvalidated: 1 s of flight in a PID profile is a flight in that PID profile, not a short PID profile change',
        maxRescues: 'pipeline: a limit of the result size',
        maxParams: 'a limit of the display',
    },
};

const EXTRA = []; // the rescue state (rescueAt) and the PID profile (profileAt) come from the log events (lib.cjs segments)

// The sources are shown to the pilot (quoted): no file name or path
const DEFAULT_RULES = {
    D9: { flag: 0, source: 'firmware 4.6.0: rescue_mode is a value of each PID profile (default OFF), and with OFF the rescue switch does not start a rescue in that PID profile',
        note: 'flag: a PID profile with rescue_mode OFF in the CLI dump (a `diff` leaves out a value at its default, OFF), or in the log header; ok: rescue_mode CLIMB or ALT_HOLD, or a RESCUE_STATE change in the logs in that PID profile (the firmware runs the rescue state machine only when rescue_mode is not OFF); note (not sufficient data): the PID profiles with no CLI section and no rescue in the logs' },
};
const UNITS = { D9: 'state' };

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

function judge(flights, RULES = DEFAULT_RULES, extra = {}) {
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

    const C = x.cli ? rescueOfCli(x.cli) : null;
    if (C) {
        for (const p of PROFILES) {
            const q = C.profiles[p]; if (!q) continue;
            const line = q.lines.includes('rescue_mode') ? `The CLI dump has \`set rescue_mode = ${q.params.rescue_mode}\` in \`profile ${p - 1}\`.`
                : C.kind === 'diff' ? `The CLI dump has no \`rescue_mode\` line in \`profile ${p - 1}\`. Thus, the value is the default value, OFF.` : `The CLI dump has no \`rescue_mode\` line in \`profile ${p - 1}\`.`;
            const other = RESCUE.filter(v => v.name !== 'rescue_mode' && q.params[v.name] !== null && !q.defaults.includes(v.name)).map(v => `\`${v.name} = ${q.params[v.name]}\``);
            const otherText = other.length ? `These rescue values are not at their default values: ${other.length > RULE.maxParams ? `${other.slice(0, RULE.maxParams).join(', ')} and ${other.length - RULE.maxParams} more` : and(other)}.` : 'The other rescue values are at their default values.';
            const base = Object.assign({ profile: p, basis: 'cli', cliKind: C.kind, cliProfile: p - 1, mode: q.mode, params: q.params, defaults: q.defaults, n: P[p].rescues }, facts(p));
            if (q.on === null) { add(Object.assign(base, { severity: 'note', thin: true, value: null, text: para(`In PID profile ${p}, the CLI dump does not give a known \`rescue_mode\` value. ${line}`, 'The analysis cannot find if the rescue is on in this PID profile.', flightText(p)) })); continue; }
            if (!q.on) { const conflict = P[p].rescues > 0;
                add(Object.assign(base, { severity: 'flag', value: 0, conflict, text: para(`In PID profile ${p}, the rescue switch does not start a rescue, because \`rescue_mode\` is OFF.`, why,
                    `${line} The limit is a value other than OFF (CLIMB or ALT_HOLD).`, flightText(p) + (conflict ? ` But the logs show ${many(P[p].rescues, 'rescue')} in this PID profile. Thus, the CLI dump is possibly not from the time of these logs.` : '')) })); continue; }
            add(Object.assign(base, { severity: 'ok', value: 1, text: para(`In PID profile ${p}, the rescue switch starts the rescue. ${line}`, otherText, [flightText(p), rescueText(p)].filter(Boolean).join(' ')) }));
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
                : para(`In PID profile ${p}, the rescue switch starts the rescue. The log header gives \`rescue_mode\` ${h.mode} for this PID profile.`, [flightText(p), rescueText(p)].filter(Boolean).join(' ')) })); continue; }
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

module.exports = { EXTRA, RULE, DEFAULT_RULES, RESCUE, analyse, judge, rescueOfCli, modeName };
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
