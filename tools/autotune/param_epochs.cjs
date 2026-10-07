'use strict';

/**
 * Parameter epochs: for each time span of one log, how well the log header describes the parameters in effect.
 *
 * Rotorflight 4.6.0 writes the header once per log, while the blackbox state goes to RUNNING, with the values of the PID
 * and rate profile active then (src/main/blackbox/blackbox.c blackboxWriteSysinfo, 1587-1789). It writes no profile
 * index. After a disarm the log stays open for blackbox_grace_period s (default 5, blackbox.c:1226-1240), and a re-arm in
 * that time continues the same log with no new header and no event (blackbox.c:2173-2176). Every flight-parameter MSP
 * write (the radio Lua script, the Configurator) and MSP_SELECT_SETTING are accepted while armed and leave no event
 * (msp.c:2486-2501, 2560-2577, ...). The only parameter changes that the log records are INFLIGHT_ADJUSTMENT events.
 *
 *   const PE = require('./param_epochs.cjs');
 *   const spans = PE.paramEpochs({ header, events, govRequest, frameS, profileAtStart });
 *
 * input:
 *   events          [{ event, t, data }] decoded E-frame events (js/flightlog_parser.js), t in frame seconds (the same
 *                   base as frameS), in log order
 *   frameS          Float64Array, the time of every frame in frame seconds (only the first and last are necessary)
 *   govRequest      Float32Array or Float64Array aligned with frameS, or null (the governor headspeed request, rpm)
 *   profileAtStart  the PID profile at the log start when it is confirmed (1-6), else 0
 *   rateAtStart     the rate profile at the log start when it is confirmed (1-6), else 0 (optional)
 *   header          FlightLog.getSysConfig() (optional; not read at present)
 *
 * output: [{ t0, t1, arm, armed, pidProfile, rateProfile, fresh, reasons, adjust, check }] in time order, covering
 * frameS[0] .. frameS[last]:
 *   arm          0 = the arm at which the header was written, 1, 2, ... = later arms in the same log
 *   armed        false between a disarm and the next arm (the grace period)
 *   pidProfile   1-6, 0 = not known; rateProfile the same
 *   reasons      why the header values can be wrong in the span (fresh = no reason):
 *                'grace'    disarmed after a disarm: a change at this time is not recorded
 *                'rearm'    a later arm in the same log: a change between the arms is not recorded
 *                'switched' a PID or rate profile that is not the one at the log start: the header has not its values
 *                'unlogged' the governor headspeed request changed with no profile event
 *                'adjusted' an in-flight adjustment changed a value (adjust lists them)
 *                'resume'   after LOGGING_RESUME: the paused time is not recorded
 *   check        null (reserved: agreement of the gains that the data give with the header)
 * A span that is fresh can still differ from the header: an MSP write while armed leaves no record at all.
 *
 * With input.timeline (a param log: param_log.cjs buildTimeline, Blackbox_Params_Spec.md 4.5) the spans are
 * timeline.epochs instead, with times from frameS at the epoch frame indices (frameS must have one entry per frame of the
 * timeline; else the epoch times in µs from the first frame):
 *   pidProfile, rateProfile  from the S-frame, 1-6 (the app writes "PID profile 1" to "PID profile 6"); 0 = not known
 *   arm          the count of 0->1 changes of the S-frame armed before the span (0 = the first arm of the log)
 *   armed        the S-frame armed
 *   check        'journal'
 *   adjust       the C records of the span [{ seq, t, src, arg, items: [{ key, value, old }], func, name, value }]: func is the
 *                adjustment function (arg) of a record with src 'a', else null; name and value are the key and the new value of
 *                its first item (the shape of the stock adjust items, for the consumers that read func)
 *   reasons      'mixed', 'uncertain', 'pending', 'unknown', 'effect-unknown', 'lost', 'snapshot-incomplete',
 *                'chain-mismatch', 'order-unknown', 'unexplained-runtime', 'resume' (never grace, rearm, switched, unlogged)
 *   fresh        reasons is empty
 *   seq, status  the S-frame paramSeq at the span start, the epoch status
 *   keys         { unknown, pending, uncertain, mixed }: the keys of each kind in the span (PID and rate slot in force);
 *                uncertain includes the transition frames of the RX and ACC keys
 * The source of the values of a 'journal' span is the parameter journal of the log (spec 4.7 source 1), never the log
 * header or a CLI dump.
 */

const RULES = {
    blipS: 0.030,       // an arm-switch change shorter than this is a receiver blip (the disarm needs 4 ticks, rc_controls.c:155)
    graceS: 5,          // blackbox_grace_period of the logs (not in the header; measured 4.999-5.000 s on both helicopters)
    graceMarginS: 0.25, // a log that goes on longer than graceS + this after its last disarm was armed again
    plateauS: 0.5,      // the governor request must stay at one value for this long to be a plateau
    requestTolRpm: 1,   // two plateaus of the governor request are different above this difference
};

const EV = { SYNC_BEEP: 0, INFLIGHT_ADJUSTMENT: 13, LOGGING_RESUME: 14, DISARM: 15, FLIGHT_MODE: 30 };
const ARM_BIT = 1; // flightModeFlags bit 0 = BOXARM (rcModeActivationMask, blackbox.c:1106-1113)

// Times of the arm-switch rises that stay on (blips removed), as [{ on, off }] intervals; off = Infinity if open.
function armSwitch(events, rules) {
    const raw = [];
    for (const e of events) if (e.event === EV.FLIGHT_MODE && e.data) {
        const now = (e.data.newFlags & ARM_BIT) !== 0, was = (e.data.lastFlags & ARM_BIT) !== 0;
        if (now !== was) raw.push({ t: e.t, on: now });
    }
    const on = [];
    for (const c of raw) {
        if (c.on) {
            const last = on[on.length - 1];
            if (last && c.t - last.off < rules.blipS) last.off = Infinity; // an off-blip: the interval goes on
            else on.push({ on: c.t, off: Infinity });
        } else if (on.length && on[on.length - 1].off === Infinity) on[on.length - 1].off = c.t;
    }
    return on.filter(i => i.off - i.on >= rules.blipS);
}

// Arm intervals [{ t0, t1 }]: t1 = the disarm, or the log end. Each DISARM ends one arm, and only an armed craft logs one
// (fc/core.c:432-446), so two DISARMs prove an arm between them. There is no arm event: the arm is the rise of the switch
// interval that holds the next disarm (an earlier rise that fell with no disarm was a refused arm), else the arming
// beep, else the disarm itself (no switch data). After the last disarm the log was armed again only if it goes on past
// the grace period or has an arming beep. The first arm is at the log start (t0 = null here).
function arms(events, tEnd, rules) {
    const disarms = events.filter(e => e.event === EV.DISARM).map(e => e.t), sw = armSwitch(events, rules);
    const out = [{ t0: null, t1: disarms.length ? disarms[0] : tEnd }];
    for (let k = 1; k <= disarms.length; k++) {
        const prev = disarms[k - 1], last = k === disarms.length, t1 = last ? tEnd : disarms[k];
        const holds = sw.filter(i => i.on > prev && i.on < t1 && (last ? i.off === Infinity : i.off >= t1 - rules.blipS));
        const beep = events.find(e => e.event === EV.SYNC_BEEP && e.t > prev && e.t < t1);
        if (last && !beep && tEnd - prev < rules.graceS + rules.graceMarginS) break; // the grace period ran out: not armed again
        out.push({ t0: holds.length ? holds[holds.length - 1].on : beep ? beep.t : prev, t1 });
    }
    return out;
}

// Times where the governor request goes from one plateau to a different one: [{ t0, t1 }] (end of the old plateau,
// start of the new one). A request of 0 (governor off) is not a plateau.
function requestSteps(govRequest, frameS, rules) {
    if (!govRequest || !govRequest.length) return [];
    const plateaus = [];
    for (let i = 0; i < govRequest.length;) {
        let j = i + 1; while (j < govRequest.length && Math.abs(govRequest[j] - govRequest[i]) <= rules.requestTolRpm) j++;
        if (govRequest[i] > 0 && frameS[j - 1] - frameS[i] >= rules.plateauS) plateaus.push({ v: govRequest[i], t0: frameS[i], t1: frameS[j - 1] });
        i = j;
    }
    const steps = [];
    for (let k = 1; k < plateaus.length; k++)
        if (Math.abs(plateaus[k].v - plateaus[k - 1].v) > rules.requestTolRpm) steps.push({ t0: plateaus[k - 1].t1, t1: plateaus[k].t0, from: plateaus[k - 1].v, to: plateaus[k].v });
    return steps;
}

// The spans of a param log: one for each epoch of the timeline (spec 4.5)
function fromTimeline(input) {
    const tl = input.timeline, epochs = tl.epochs || [], frameS = input.frameS;
    const total = epochs.length ? epochs[epochs.length - 1].i1 : 0;
    const useS = frameS && frameS.length === total && total > 0, t00 = epochs.length && epochs[0].t0 !== null ? epochs[0].t0 : 0;
    const tAt = (e, end) => useS ? frameS[end ? Math.min(e.i1, total - 1) : e.i0] : ((end ? e.t1 : e.t0) === null ? null : ((end ? e.t1 : e.t0) - t00) / 1e6);
    const one = (v) => Number.isInteger(v) && v >= 0 && v <= 5 ? v + 1 : 0;
    const records = tl.journal && tl.journal.records instanceof Map ? tl.journal.records : new Map();
    let arm = 0, firstArmed = null, prevArmed = null;
    return epochs.map((e) => {
        const armed = e.armed === null || e.armed === undefined ? null : !!e.armed;
        if (firstArmed === null) firstArmed = armed;
        if (prevArmed === false && armed === true) arm++;
        prevArmed = armed;
        const adjust = (e.records || []).map(seq => records.get(seq)).filter(Boolean).map(r => {
            const items = r.items.map(it => ({ key: it.key, value: it.value, old: it.old }));
            return { seq: r.seq, t: r.time === undefined || r.time === null ? null : (r.time - t00) / 1e6, src: r.src, arg: r.arg, items,
                func: r.src === 'a' && typeof r.arg === 'number' ? r.arg : null, name: items.length ? items[0].key : null, value: items.length ? items[0].value : null };
        });
        const reasons = (e.reasons || []).slice();
        return { t0: tAt(e, false), t1: tAt(e, true), arm: firstArmed === false ? Math.max(0, arm - 1) : arm, armed: armed === null ? true : armed,
            pidProfile: one(e.pidProfile), rateProfile: one(e.rateProfile), fresh: !reasons.length, reasons, adjust, check: 'journal',
            seq: e.seq === undefined ? null : e.seq, status: e.status,
            keys: { unknown: (e.unknown || []).slice(), pending: (e.pending || []).slice(), uncertain: (e.uncertain || []).slice(), mixed: (e.mixed || []).slice() } };
    });
}

function paramEpochs(input, options = {}) {
    if (input && input.timeline) return fromTimeline(input);
    const rules = Object.assign({}, RULES, options.rules || {});
    const frameS = input.frameS, events = (input.events || []).filter(e => e && Number.isFinite(e.t));
    if (!frameS || !frameS.length) return [];
    const tStart = frameS[0], tEnd = frameS[frameS.length - 1];
    const armList = arms(events, tEnd, rules);
    armList[0].t0 = tStart;

    const adjustEvents = events.filter(e => e.event === EV.INFLIGHT_ADJUSTMENT && e.data);
    const profileEvents = adjustEvents.filter(e => e.data.func === 1 || e.data.func === 2);
    // a request step that an adjustment explains (a PID profile switch, a headspeed adjustment) is recorded
    const steps = requestSteps(input.govRequest, frameS, rules).filter(s => !adjustEvents.some(e => e.data.func !== 1 && e.t >= s.t0 - rules.blipS && e.t <= s.t1 + rules.blipS));

    // the cut times, then one span between each pair of cuts
    const cuts = new Set([tStart, tEnd]);
    for (const a of armList) { cuts.add(a.t0); cuts.add(a.t1); }
    for (const e of events) if (e.event === EV.INFLIGHT_ADJUSTMENT || e.event === EV.LOGGING_RESUME) cuts.add(e.t);
    for (const s of steps) cuts.add(s.t1);
    const times = [...cuts].filter(t => t >= tStart && t <= tEnd).sort((a, b) => a - b);

    const pidStart = input.profileAtStart || 0, rateStart = input.rateAtStart || 0;
    // a profile event at the first frame gives the profile at the start
    const atStart = (func) => { const e = profileEvents.find(x => x.data.func === func && x.t <= tStart); return e ? e.data.value : 0; };
    const pid0 = pidStart || atStart(2), rate0 = rateStart || atStart(1);

    const spans = [];
    for (let k = 0; k + 1 < times.length; k++) {
        const t0 = times[k], t1 = times[k + 1], mid = (t0 + t1) / 2;
        if (t1 <= t0) continue;
        let arm = 0, armed = false;
        for (let a = 0; a < armList.length; a++) if (mid >= armList[a].t0) { arm = a; armed = mid < armList[a].t1; }
        const before = events.filter(e => e.t <= t0);
        let pid = pid0, rate = rate0, pidSwitch = false, rateSwitch = false;
        for (const e of before) if (e.event === EV.INFLIGHT_ADJUSTMENT && e.data) {
            if (e.data.func === 2) { pid = e.data.value; if (e.t > tStart) pidSwitch = true; }
            if (e.data.func === 1) { rate = e.data.value; if (e.t > tStart) rateSwitch = true; }
        }
        const reasons = [];
        const firstDisarm = armList[0].t1 < tEnd ? armList[0].t1 : Infinity;
        if (!armed && t0 >= firstDisarm) reasons.push('grace');
        if (armed && arm > 0) reasons.push('rearm');
        // a switch back to the start profile is the start profile again only when that profile is known
        if ((pidSwitch && !(pid0 && pid === pid0)) || (rateSwitch && !(rate0 && rate === rate0))) reasons.push('switched');
        if (steps.some(s => s.t1 <= t0)) reasons.push('unlogged');
        const adjust = before.filter(e => e.event === EV.INFLIGHT_ADJUSTMENT && e.data && e.data.func > 2)
            .map(e => ({ t: e.t, func: e.data.func, name: e.data.name, value: e.data.value }));
        if (adjust.length) reasons.push('adjusted');
        if (before.some(e => e.event === EV.LOGGING_RESUME)) reasons.push('resume');
        const span = { t0, t1, arm, armed, pidProfile: pidSwitch || pid0 ? pid : 0, rateProfile: rateSwitch || rate0 ? rate : 0, fresh: !reasons.length, reasons, adjust, check: null };
        const last = spans[spans.length - 1];
        if (last && last.arm === span.arm && last.armed === span.armed && last.pidProfile === span.pidProfile && last.rateProfile === span.rateProfile
            && last.reasons.join() === span.reasons.join() && last.adjust.length === span.adjust.length) last.t1 = t1;
        else spans.push(span);
    }
    return spans;
}

module.exports = { RULES, EV, armSwitch, arms, requestSteps, paramEpochs, fromTimeline };
if (require.main !== module) return;

// node tools/autotune/param_epochs.cjs <log file>: the spans of every log of the file
const lib = require('./lib.cjs');
const file = process.argv[2];
if (!file) { console.error('usage: node tools/autotune/param_epochs.cjs <log file>'); process.exit(1); }
const app = lib.loadApp(), FlightLog = app.FlightLog;
const log = new FlightLog(require('fs').readFileSync(file));
for (let i = 0; i < log.getLogCount(); i++) {
    if (!log.openLog(i)) { console.log(`log ${i + 1}: ${log.getLogError(i)}`); continue; }
    const tMin = log.getMinTime(), chunks = log.getChunksInTimeRange(tMin, Infinity), gi = log.getMainFieldIndexByName('govRequest');
    const t = [], g = [], events = [];
    for (const c of chunks) {
        for (const f of c.frames) { t.push((f[1] - tMin) / 1e6); if (gi !== undefined) g.push(f[gi]); }
        for (const e of c.events) events.push({ event: e.event, t: (e.time - tMin) / 1e6, data: e.data });
    }
    const spans = paramEpochs({ events, frameS: Float64Array.from(t), govRequest: gi === undefined ? null : Float64Array.from(g), profileAtStart: 0 });
    console.log(`log ${i + 1}: ${spans.length} spans`);
    for (const s of spans) console.log(`  ${s.t0.toFixed(3).padStart(8)} - ${s.t1.toFixed(3).padStart(8)} arm ${s.arm} ${s.armed ? 'armed   ' : 'disarmed'} pid ${s.pidProfile || '?'} rate ${s.rateProfile || '?'} ${s.fresh ? 'fresh' : s.reasons.join(',')}`);
}
