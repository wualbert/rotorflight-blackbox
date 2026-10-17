'use strict';

/**
 * Governor run objects (docs/GOVERNOR_AUTOTUNE.md section 2), shared by gov_params, gov_fit and gov_tune.
 *
 *   EXTRA                          the logged fields to decode (lib.segments extra), besides headspeed and the event columns
 *   fromColumns(cols, meta, ph)    one run from named columns: the dev data (analysis/governor-20261014/data/<craft>/*.f32,
 *                                  'time' in s from the segment start) or the worker path (fromSegment converts to this)
 *   partsOf(w)                     the parts of a whole-log segment out of the cut of each receiver signal loss (IMP-02), for runOf
 *   runOf(w, ctx)                  one run from a whole-log segment of lib.segments (the worker decode), ctx: { phases (the
 *                                  result of health_phase.phases, with its code), segment, name, events, armingProfile }. Without
 *                                  phases it calls health_phase.phases; when that fails, class is null with a reason. fromSegment
 *                                  is the same function
 *   load(dir, {logs, bench})       the runs of a dev data directory (meta.json, phases.json, <name>.f32, <name>.phase); Node only.
 *                                  Flight runs only, bench runs too with bench: true
 *
 * A run holds every sample of a segment, all flight phases included (idle, spool-up, ground, flight, spool-down). Class
 * 'flight' or 'bench' comes from health_phase: the model and the tuning use flight runs only (CLAUDE.md: give gov_fit and
 * gov_tune the runs of class 'flight'); gov_params also reads bench runs, as evidence of the configuration only (critique M9).
 * Events (ctx.events, meta.events): [{ t, name, value }] with t in s on the time of the items (fromS + time).
 * Arrays are at the logged frame rate (rate, Hz), Float32Array
 * except time (Float64Array, s from the segment start, the frame clock). Units: u, thr, roll..coll, govP..govSum as a fraction
 * of full throttle (logged x 1000); target, request, hs in rpm; vbat V; ibat A; vario m/s.
 *   state    GOVERNOR_STATE events per sample (0 OFF ... 9 BYPASS), null when the log has none
 *   profile  PID profile 1-6 from the logged changes, 0 before the first change (unknown; ctx.armingProfile fills it, and
 *            profileFilled is the number of samples that it filled: not a logged change)
 *   armed    1 = armed. With DISARM events (armSource 'events'): 0 from each disarm (the sample of the event, or the OFF transition
 *            up to RULES.disarmBackS before it) to the next arm: an ARM event, else the
 *            first logged governor state other than OFF after RULES.disarmHoldS, else (no governor states) the next rise of the
 *            arm switch, else the log end. Without them (armSource 'switch'): flightModeFlags bit 0 (the arm switch, BOXARM,
 *            which falls 8-16 ms before the DISARM event), else 1 in every sample ('none': the log runs while armed)
 *   armSwitch flightModeFlags bit 0 per sample, or null
 *   disarms  the sample of each DISARM event
 *   preroll  PID loops armed before sample 0 (analysis/governor-twin/parity.cjs): the firmware arms before the first logged
 *            frame (the log header takes time). A log that starts in IDLE with the motor on is in its startup ramp, and the
 *            ramp gives the loops: u = (preroll + loopsPerFrame (k + 1)) x the rate per loop, with the rate from the slope of the
 *            ramp (gov_startup_time in 0.1 s is an integer: 10 / (pidHz x time) per loop). The logged counts are used as they are
 *            (as parity.cjs): truncated counts make it up to 0.5 count lower (5 loops at 1 kHz and gov_startup_time 100). 0 for any
 *            other start
 *   phase    health_phase code per sample (PHASES), null without phases
 * Arming events (in ctx.events or meta.events, the same time base): { t, name: 'DISARM' } or { t, event: 15 } (FlightLogEvent.DISARM,
 * js/flightlog_fielddefs.js), and { t, name: 'ARM' } where a source has it (the log has no arm event). The worker gives them from
 * decode(): events.concat(epochEvents.filter(e => e.event === 15)), with t in frame s from the log start, as the other events.
 * The dev data has no events: load(dir, { events: { [log]: [...] } }) adds them (analysis/governor-twin/out/disarm_<craft>.json
 * holds the DISARM times in us since boot: t = (us - timeStartUs) / 1e6 + fromS).
 * A missing field gives null and a reason in STE text (reasons), never an exception. vbat is null when Vbat is missing, 0 or
 * not finite in every sample; ibat is null when Ibat is non-zero in less than RULES.ibatShare of the motor-running samples
 * (u > RULES.runningU; all samples without motor[0]): the Fireball ESC has no current sensor and logs Ibat = 0.
 */

const RULES = {
    runningU: 0.02,   // motor running: u above this (gov_fit uses the same rule)
    ibatShare: 0.5,   // Ibat must be non-zero in this share of the motor-running samples
    // s after a DISARM event in which the governor stays disarmed whatever the logged state (the state event can come a few
    // frames late; analysis/governor-twin/parity.cjs: 50 frames at 1 kHz)
    disarmHoldS: 0.05,
    // the governor goes OFF at the disarm, and the logged OFF state can come one frame before the sample of the DISARM event
    // (Gaui log 48, Fireball log 10): an OFF transition at most this time before the event sample is the disarm
    disarmBackS: 0.005,
    prerollFrames: 2000, // the samples of the IDLE ramp at the log start that give the loops before sample 0
    prerollMin: 10,      // fewer ramp samples give no estimate (preroll 0)
    // partsOf: a part of a segment out of the cut of a receiver signal loss (lib.cjs rxLossAt, IMP-02) that is shorter than this is not a
    // run (pipeline, unvalidated: less than 1 s has no governor response to fit, for example the time before a loss at the log start)
    rxLossMinS: 1,
};
const DISARM = 15; // FlightLogEvent.DISARM (js/flightlog_fielddefs.js)
const PHASES = ['idle', 'spoolup', 'ground', 'flight', 'spooldown', 'fall', 'aftercontact']; // health_phase PHASES (fall, aftercontact: IMP-03)
const MIX = ['mixer[0]', 'mixer[1]', 'mixer[2]', 'mixer[3]'];
const GOV = { govP: 'govP', govI: 'govI', govD: 'govD', govF: 'govF', govSum: 'govSum', target: 'govTarget', request: 'govRequest' };
const EXTRA = ['time', 'govP', 'govI', 'govD', 'govF', 'govSum', 'govTarget', 'govRequest', 'motor[0]', 'rcCommand[3]', 'rcCommand[4]', ...MIX, 'Vbat', 'Ibat', 'vario', 'flightModeFlags'];

// The reasons of a run. The worker also shows them as notes: information only (STE Rule 5.5), with the setting that records the value
// (CLAUDE.md "No access to the flight controller")
const TEXT = {
    noVbat: 'The log does not record the battery voltage ("Vbat" is missing or 0). Thus, the governor model uses a constant voltage. The log records the voltage only with a voltage source ("battery_meter") and with "blackbox_log_battery" ON.',
    // a flight log that gov_tune modelRunsOf leaves out of the model (the other logs record the voltage): the rules use it (review 2026-10-15)
    noVbatLeft: 'The log does not record the battery voltage ("Vbat" is missing or 0). Thus, the governor model does not use the log. The log records the voltage only with a voltage source ("battery_meter") and with "blackbox_log_battery" ON.',
    noIbat: 'The log does not record the battery output ("Ibat" is 0 in most samples with the motor on). Thus, the model uses the battery voltage only. The governor does not use "Ibat".',
    noGov: 'The log does not record the governor values ("govP", "govI", "govF", "govSum", "govTarget" or "govRequest"). Thus, the analysis cannot find the governor gains and the PID profile from the headspeed. The log records these values only with "blackbox_log_governor" ON.',
    noState: 'The log does not record the governor changes ("GOVERNOR_STATE"). Thus, the analysis cannot find the ramps, the time limits and the values of FALLBACK.',
    noMotor: 'The log does not record the motor output ("motor[0]"). Thus, the governor autotune is not possible for this log.',
    noThr: 'The log does not record the throttle input ("rcCommand[4]"). Thus, the analysis uses the governor changes in the log for the throttle input.',
    noMixer: 'The log does not record the mixer inputs ("mixer[0]" to "mixer[3]"). Thus, the analysis cannot find the feedforward values and the rotor load.',
    noHs: 'The log does not record the headspeed. Thus, the governor autotune is not possible for this log.',
    noPhase: 'The analysis cannot find the flight phases of this log. Thus, the governor model and the tuning do not use this log.',
};

const f32 = (src, k = 1) => { if (!src) return null; const a = new Float32Array(src.length); for (let i = 0; i < src.length; i++) a[i] = src[i] * k; return a; };
const u8 = (src) => src ? Uint8Array.from(src) : null;

// cols: { name: array } with the names of lib.segments (profileAt, airborneAt, govStateAt, rescueAt, hs, and the EXTRA names),
// 'time' in s from the segment start. meta: { log, segment, name, file, craft, n, rate, actualRate, fromS, timeStartUs, header }.
// ph: { class, flights, seconds, code } (health_phase phases(), or phases.json with the .phase codes), null, or false (the phases failed)
function fromColumns(cols, meta, ph) {
    const n = meta.n, h = meta.header || {}, reasons = [], has = (k) => !!cols[k] && cols[k].length === n;
    const pidHz = h.looptime > 0 ? 1e6 / (h.looptime * (h.pid_process_denom || 1)) : meta.rate;
    const run = { log: meta.log, segment: meta.segment || 0, name: meta.name || null, file: meta.file || null, craft: meta.craft || null, rate: meta.rate,
        actualRate: meta.actualRate || meta.rate, n, fromS: meta.fromS || 0, t0Us: meta.timeStartUs === undefined ? null : meta.timeStartUs, pidHz,
        loopsPerFrame: Math.max(1, Math.round(pidHz / meta.rate)), header: h, class: ph ? ph.class || null : null,
        flights: ph && ph.flights ? ph.flights.map(f => ({ i0: f.i0, i1: f.i1, t0: f.t0, t1: f.t1 })) : [], phase: ph && ph.code ? u8(ph.code) : null, phaseNames: PHASES };
    run.time = new Float64Array(n);
    if (has('time')) for (let i = 0; i < n; i++) run.time[i] = cols.time[i]; else for (let i = 0; i < n; i++) run.time[i] = i / run.actualRate;
    run.hs = has('hs') ? f32(cols.hs) : null; if (!run.hs) reasons.push(TEXT.noHs);
    run.u = has('motor[0]') ? f32(cols['motor[0]'], 1e-3) : null; if (!run.u) reasons.push(TEXT.noMotor);
    run.thr = has('rcCommand[4]') ? f32(cols['rcCommand[4]'], 1e-3) : null; if (!run.thr) reasons.push(TEXT.noThr);
    run.collStick = has('rcCommand[3]') ? f32(cols['rcCommand[3]'], 1 / 500) : null;   // collective stick -1..1 (the BYPASS curve input)
    ['roll', 'pitch', 'yaw', 'coll'].forEach((k, j) => { run[k] = has(MIX[j]) ? f32(cols[MIX[j]], 1e-3) : null; });
    if (!run.coll || !run.roll) reasons.push(TEXT.noMixer);
    let v = has('Vbat') ? cols.Vbat : null;
    if (v) { let ok = false; for (let i = 0; i < n && !ok; i++) ok = v[i] > 0 && isFinite(v[i]); if (!ok) v = null; }
    run.vbat = f32(v, 0.01); if (!run.vbat) reasons.push(TEXT.noVbat);
    let ib = has('Ibat') ? cols.Ibat : null;
    if (ib) { let on = 0, nz = 0; for (let i = 0; i < n; i++) if (!run.u || run.u[i] > RULES.runningU) { on++; if (ib[i] !== 0 && isFinite(ib[i])) nz++; } if (!on || nz < RULES.ibatShare * on) ib = null; }
    run.ibat = f32(ib, 0.01); if (!run.ibat && run.vbat) reasons.push(TEXT.noIbat); // without the voltage the model uses no current: noVbat says it
    for (const [k, c] of Object.entries(GOV)) run[k] = has(c) ? f32(cols[c], k === 'target' || k === 'request' ? 1 : 1e-3) : null;
    run.state = has('govStateAt') ? u8(cols.govStateAt) : null;
    run.hasGovernor = ['govP', 'govI', 'govF', 'govSum', 'target', 'request'].every(k => !!run[k]);
    if (!run.hasGovernor) reasons.push(TEXT.noGov);
    if (!run.state) reasons.push(TEXT.noState);
    run.profile = has('profileAt') ? u8(cols.profileAt) : new Uint8Array(n);
    run.profileFilled = 0;
    if (meta.armingProfile > 0) for (let i = 0; i < n && run.profile[i] === 0; i++) { run.profile[i] = meta.armingProfile; run.profileFilled++; }
    run.armSwitch = has('flightModeFlags') ? Uint8Array.from(cols.flightModeFlags, x => x & 1) : null;
    run.airborne = has('airborneAt') ? u8(cols.airborneAt) : null;
    run.rescue = has('rescueAt') ? u8(cols.rescueAt) : null;
    run.vario = has('vario') ? f32(cols.vario, 0.01) : null;
    run.events = meta.events || null;
    arming(run, run.events);
    run.hasVoltage = !!run.vbat; run.hasCurrent = !!run.ibat;
    if (ph === false) reasons.push(TEXT.noPhase);
    run.reasons = reasons;
    return run;
}

// run.armed, armSource, disarms and preroll from the arming events and run.armSwitch (see the header). Called by fromColumns;
// call it again after a change of the events.
function arming(run, events) {
    const n = run.n, st = run.state, t = run.time, f = run.fromS || 0;
    const at = (x) => { let lo = 0, hi = n; while (lo < hi) { const k = (lo + hi) >> 1; if (f + t[k] < x) lo = k + 1; else hi = k; } return lo; };
    const list = Array.isArray(events) ? events.filter(e => e && Number.isFinite(e.t)) : [];
    const dis = list.filter(e => e.name === 'DISARM' || e.event === DISARM).map(e => e.t).sort((a, b) => a - b);
    const arm = list.filter(e => e.name === 'ARM').map(e => e.t).sort((a, b) => a - b);
    const back = Math.round(RULES.disarmBackS * run.rate);
    run.disarms = dis.map(x => {
        let d = at(x), b = d;
        if (st && d < n) { while (b > 0 && st[b - 1] === 0 && d - b < back) b--; if (b < d && (b === 0 || st[b - 1] !== 0)) d = b; }
        return d;
    });
    const sw = run.armSwitch;
    run.armed = sw ? Uint8Array.from(sw) : new Uint8Array(n).fill(1); run.armSource = sw ? 'switch' : 'none';
    if (dis.length) {
        const a = new Uint8Array(n).fill(1), hold = Math.round(RULES.disarmHoldS * run.rate);
        for (const d of run.disarms) {
            const ta = arm.find(x => at(x) > d);
            let e = ta === undefined ? n : at(ta);
            for (let k = d + hold; k < e; k++) if (st ? st[k] !== 0 : sw && sw[k] && !sw[k - 1]) { e = k; break; }
            for (let k = d; k < e; k++) a[k] = 0;
        }
        run.armed = a; run.armSource = 'events';
    }
    run.preroll = preroll(run);
    return run;
}
// the loops before sample 0 (see the header)
function preroll(run) {
    const st = run.state, u = run.u, L = run.loopsPerFrame, n = run.n;
    if (!st || !u || st[0] !== 1 || !(u[0] > 0) || !run.armed[0]) return 0;
    let m = 0; while (m < n && m < RULES.prerollFrames && st[m] === 1) m++;
    let top = 0; for (let k = 0; k < m; k++) if (u[k] > top) top = u[k];
    let e = 0; while (e < m && u[e] < top) e++; // the ramp, without its last value (the plateau at the handover throttle)
    if (e < RULES.prerollMin) return 0;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = 0; k < e; k++) { sx += k; sy += u[k]; sxx += k * k; sxy += k * u[k]; }
    const slope = (e * sxy - sx * sy) / (e * sxx - sx * sx), T = Math.round(10 * L / (run.pidHz * slope));
    if (!(T > 0)) return 0;
    const per = 10 / (run.pidHz * T);
    let s = 0; for (let k = 0; k < e; k++) s += u[k] / per - L * (k + 1);
    return Math.max(0, Math.round(s / e));
}

// The parts of a whole-log segment w out of the cut of each receiver signal loss (lib.cjs rxLossAt, else the cut0..cut1 of w.rxLoss;
// IMP-02): after the inferred last RC frame the throttle is the held or the rxfail value, not the pilot's, and the RC values come back
// settleS after the RX return. -> { parts: [[i0, i1], ...] in samples, each RULES.rxLossMinS or longer, cutS: the seconds that the
// parts leave out (the cut and the parts that are too short), 0 without a loss }
function partsOf(w) {
    const n = w.n, rate = (w.flight && w.flight.actualRate) || w.rate || 1;
    let cut = w.rxLossAt && w.rxLossAt.length === n ? w.rxLossAt : null;
    if (!cut && Array.isArray(w.rxLoss) && w.rxLoss.length) { cut = new Uint8Array(n); for (const q of w.rxLoss) if (q && isFinite(q.cut0) && isFinite(q.cut1)) cut.fill(1, Math.max(0, q.cut0), Math.min(n, q.cut1)); }
    if (!cut || cut.indexOf(1) < 0) return { parts: [[0, n]], cutS: 0 };
    const min = Math.max(2, Math.round(RULES.rxLossMinS * rate)), parts = []; let left = 0;
    for (let i = 0; i < n;) { if (cut[i]) { left++; i++; continue; } let j = i; while (j < n && !cut[j]) j++; if (j - i >= min) parts.push([i, j]); else left += j - i; i = j; }
    return { parts, cutS: +(left / rate).toFixed(2) };
}
// w: a whole-log segment of lib.segments (w.hs, w.extra[name], w.profileAt, w.govStateAt, w.airborneAt, w.rescueAt, w.flight). ctx.i0,
// ctx.i1: the samples of the run (a part of partsOf: the time, the phases, the flights and the DISARM events of that part; class
// 'bench' when the part has no flight of its own). Without them, the first part of partsOf: a receiver signal loss ends the run at its
// cut (run.rxLossEnd: the samples that the run left out after it). run.part: [i0, i1] of a part that is not all of w
function fromSegment(w, ctx = {}) {
    const n0 = w.n, ranged = Number.isInteger(ctx.i0) && Number.isInteger(ctx.i1), P = ranged ? null : partsOf(w);
    const [a, b] = ranged ? [Math.max(0, ctx.i0), Math.min(n0, Math.max(ctx.i0 + 1, ctx.i1))] : P.parts.length ? P.parts[0] : [0, Math.min(n0, 1)];
    const x = w.extra || {}, end = b - a, sub = a > 0 || b < n0;
    const cut = (v) => v && sub ? v.subarray(a, b) : v, cols = { profileAt: cut(w.profileAt), airborneAt: cut(w.airborneAt), govStateAt: cut(w.govStateAt), rescueAt: cut(w.rescueAt), hs: cut(w.hs) };
    for (const k of EXTRA) if (k !== 'time' && x[k]) cols[k] = cut(x[k]);
    if (!cols['mixer[0]'] && w.u) w.u.forEach((q, j) => { if (q) cols[MIX[j]] = Float64Array.from(cut(q), v => v * 1000); }); // lib w.u = mixer[0..2] / 1000
    const t = x.time && x.time.length === n0 ? x.time : null, fl = w.flight || {}, rate = fl.actualRate || w.rate, tAt = (i) => t ? w.fromS + (t[i] - t[0]) / 1e6 : w.fromS + i / rate;
    if (t) { cols.time = new Float64Array(end); for (let i = 0; i < end; i++) cols.time[i] = (t[a + i] - t[a]) / 1e6; }
    let ph = ctx.phases || null;
    if (!ph) try { ph = require('./health_phase.cjs').phases(w, Object.assign({ rate: w.flight && w.flight.actualRate || w.rate }, ctx)); } catch (e) { ph = false; }
    if (ph && sub) { const flights = (ph.flights || []).filter(f => f.i1 > a && f.i0 < b).map(f => Object.assign({}, f, { i0: Math.max(f.i0, a) - a, i1: Math.min(f.i1, b) - a,
        t0: f.i0 >= a ? f.t0 : tAt(a), t1: f.i1 <= b ? f.t1 : tAt(b - 1) }));
        ph = Object.assign({}, ph, { code: ph.code ? ph.code.subarray(a, b) : ph.code, flights, class: ph.class === 'flight' && !flights.length ? 'bench' : ph.class }); }
    // the DISARM events of the part (arming puts an earlier one at sample 0); the other events of the whole log (adjustments: gov_params)
    const fromS = tAt(a), tol = 0.5 / rate, t1 = tAt(b - 1), isDisarm = (e) => e && (e.event === DISARM || e.name === 'DISARM');
    const events = sub && Array.isArray(ctx.events) ? ctx.events.filter(e => !isDisarm(e) || (e.t >= fromS - tol && e.t <= t1 + tol)) : ctx.events;
    const run = fromColumns(cols, { log: fl.log, segment: ctx.segment || 0, name: ctx.name || null, file: fl.file, craft: fl.craft, n: end, rate: w.rate, actualRate: fl.actualRate,
        fromS, timeStartUs: t ? t[a] : undefined, header: fl.header, events, armingProfile: ctx.armingProfile }, ph);
    if (!ranged && b < n0) run.rxLossEnd = n0 - b;
    if (sub) run.part = [a, b];
    return run;
}

// the runs of a dev data directory (analysis/governor-20261014/extract.cjs and phase.cjs), in meta order; o.logs: the logs to read,
// o.bench: bench runs too, o.events: { [log]: events } (the arming events, see the header)
function load(dir, o = {}) {
    const fs = require('fs'), path = require('path');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')), phj = JSON.parse(fs.readFileSync(path.join(dir, 'phases.json'), 'utf8'));
    const runs = [];
    for (const s of meta.segments) {
        if (o.logs && !o.logs.includes(s.log)) continue;
        const b = fs.readFileSync(path.join(dir, s.name + '.f32')), a = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4), m = s.columns.length, cols = {};
        s.columns.forEach((c, j) => { const v = new Float32Array(s.n); for (let i = 0; i < s.n; i++) v[i] = a[i * m + j]; cols[c] = v; });
        const pf = path.join(dir, s.name + '.phase'), ph = phj[s.name] ? Object.assign({}, phj[s.name]) : null;
        if (!o.bench && ph && ph.class === 'bench') continue;
        if (ph && fs.existsSync(pf)) ph.code = new Uint8Array(fs.readFileSync(pf));
        const sm = Object.assign({ file: meta.file, segment: +(s.name.split('_')[1] || 0) }, s);
        if (o.events && o.events[s.log]) sm.events = o.events[s.log];
        runs.push(fromColumns(cols, sm, ph));
    }
    return runs;
}

module.exports = { RULES, PHASES, EXTRA, TEXT, fromColumns, runOf: fromSegment, fromSegment, partsOf, load, arming };
if (require.main !== module) return;

// node tools/autotune/gov_data.cjs <data dir>: a summary of each run
for (const r of load(process.argv[2], { bench: true })) console.log(r.log, r.segment, r.class, r.n, r.rate, r.pidHz, r.loopsPerFrame, 'V', r.hasVoltage, 'I', r.hasCurrent, 'gov', r.hasGovernor, r.reasons.length);
