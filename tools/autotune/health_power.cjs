'use strict';

/**
 * Battery health at load steps (new ids, SPEC3 I):
 *
 *   P1  battery voltage under load, one finding for each flight log: at each load step (a fast throttle increase with the rotor
 *       governed), the battery voltage before the step against the lowest voltage in the step window, for each cell. The value
 *       is the mean decrease for each cell (V) with its SE over the steps; also the lowest cell voltage at a step, and the steps
 *       that take a battery from the warning level or more to less than the minimum level of the firmware ("possibly a weak
 *       battery")
 *   P2  voltage decrease for each ampere, one finding for each battery when the log records the battery output (Ibat): at each
 *       step with an increase of RULE.minDeltaA or more, (voltage before - lowest voltage) / (highest output - output before),
 *       in milliohm for the battery (and for each cell), mean and SE over the steps of all logs of that battery
 *   curves(w, ctx, metrics)  the step windows for the UI
 *
 * Module contract as health_rescue.cjs: analyse measures with the parameters in RULE, judge decides with DEFAULT_RULES. The
 * checks use all phases of a flight log (the governor, motor, ESC and power checks: CLAUDE.md "Flights, phases and bench
 * runs"), with the same rule in each phase; each step has its phase. Every finding has unit, thin, phase, profile null (a battery
 * is not a PID profile value), battery { id, index, logs } and events. Times: events t, t1 are index times (w.fromS + i / rate,
 * as every module gives them; evidence.cjs converts them); tS, t1S are frame seconds (the time field). Finding texts are
 * ASD-STE100 (docs/STE_GLOSSARY.md); code reads the fields, never the text. Log numbers in the texts count from 0 ("log 5"),
 * as the other modules write them: the worker writes them for the viewer.
 *
 * Not measured here (no duplicate): D5 (the largest Vbat step in 10 ms, the time under the minimum cell voltage in flight), G11
 * (the throttle increase at equal collective over a battery) and G13 (1 % of the in-flight cell voltage). The texts name them.
 *
 * Units (firmware 4.6.0 blackbox.c, battery.c): Vbat in 0.01 V (getBatteryVoltage), Ibat in 0.01 A (getBatteryCurrent),
 * motor[0] in 0.1 % of the throttle range. The header line `vbatcellvoltage` (the decoder: vbatmincellvoltage,
 * vbatwarningcellvoltage, vbatmaxcellvoltage) gives the battery levels in 0.01 V for each cell (330, 350, 430 on the Gaui X4 and
 * the Fireball, 2026-10). A log whose Vbat is 0 in every sample has no voltage sensor (Gaui X4 II 2026-10-04: "Vbat logs as 0").
 *
 * Cell count: ctx.cells when it comes from the CLI (battery_cell_count), else the rule of the firmware at the battery
 * connection (battery.c batteryUpdatePresence): the smallest count of 1-8, 10, 12 with vbat_min_cell_voltage x count <= voltage
 * <= vbat_max_cell_voltage x count, from the resting voltage at the start of the log. The firmware uses that count for its own
 * battery warnings, so the levels for each cell here agree with the warnings of the helicopter. An inferred count of
 * health_gov.cjs (ctx.cellsSource "inferred ...") is not used: with 4.30 V as the maximum, 25.2 V fits 6 and 7 cells for
 * health_gov, and the firmware takes 6.
 *
 * Telemetry: on the Fireball (ESC telemetry, 2026-10-05) Vbat changes 28.6 times each second (it holds a value for 20 ms, 80 ms
 * for 90 % of the holds), and Vbat lags Ibat by 37 ms and motor[0] by 68 ms (Gaui X4 dump 2026-10-04 23:34, 10 flights). Thus
 * the lowest voltage is the lowest 0.1 s running median (a held telemetry error of one update is not a decrease), in a window
 * that ends RULE.step.holdS after the throttle gets to the step.
 */

const optional = (name) => { try { return require(name); } catch (e) { return null; } };

const RULE = {
    step: { throttle: 100, riseS: 0.5, holdS: 0.5, beforeS: 0.3, gapS: 1 }, // a load step: motor[0] up by 100 (10 points) or more in 0.5 s
    smoothS: 0.1,              // running median of Vbat and Ibat (telemetry updates at about 29 Hz)
    strideS: 0.005,            // the step of the running median in the window
    spool: { share: 0.8, stable: 0.05 }, // without GOVSTATE: the headspeed is 80 % or more of the median headspeed of the samples with the rotor turning, and changes by 5 % or less in the 0.3 s before the step
    turningRpm: 100,           // rpm: the rotor turns
    active: 4,                 // governor state ACTIVE (FLIGHT_LOG_GOVSTATES_RF_4_6)
    minDeltaA: 10,             // A: P2 uses a step only with this increase of the battery output or more
    rest: { motor: 50, s: 1, searchS: 30, minS: 2 }, // a resting voltage: motor[0] at 5 % or less; median of 1 s; in the first and last 30 s; stretches of 2 s or more
    newBatteryCell: 0.15,      // V/cell: a resting voltage this much more than the last one is a different battery
    minVolts: 1,               // V: a sample under this is no battery voltage (no telemetry yet)
    cells: { auto: [1, 2, 3, 4, 5, 6, 7, 8, 10, 12] }, // battery.c batteryUpdatePresence auto_cells
    maxEvents: 200,
    maxRests: 20,
    source: {
        step: 'pipeline, unvalidated: a fast throttle increase of 10 points or more in 0.5 s with the governor ACTIVE. On the Fireball 2026-10-05 flights this finds 7 to 47 steps in each flight (15 points: 3 to 25), and the lowest voltage comes 0.38 s to 0.96 s after the start of the increase',
        smoothS: 'pipeline, unvalidated: the ESC telemetry of the Fireball 2026-10-05 changes Vbat 28.6 times each second. A median of 0.1 s removes one held error',
        holdS: 'measured: Vbat lags motor[0] by 67.5 +- 1.1 ms and Ibat by 36.6 +- 1.3 ms (Gaui X4 dump 2026-10-04 23:34, 10 flights)',
        minDeltaA: 'pipeline, unvalidated: a smaller increase of the battery output gives a voltage decrease near the 0.01 V step of Vbat',
        rest: 'pipeline, unvalidated: with the motor at 5 % or less, the battery output is small, and the voltage is near the resting voltage',
        newBatteryCell: 'pipeline, unvalidated: a battery that rests after a flight recovers less than 0.15 V for each cell, and a charged battery is 0.3 V or more for each cell above a battery after a flight',
        cells: 'firmware 4.6.0 battery.c batteryUpdatePresence: the smallest cell count of 1 to 8, 10 and 12 whose minimum and maximum cell voltages include the battery voltage at connection',
    },
};

const EXTRA = ['Vbat', 'Ibat', 'motor[0]', 'mixer[3]', 'time'];

// Thresholds. The battery levels come from the log header (or the CLI) of each log: the levels that the pilot set in the firmware
const P = 'pipeline, unvalidated';
const DEFAULT_RULES = {
    sig: 2,
    P1: { min: null, warning: null, minSteps: 3, defaults: { min: 3.30, warning: 3.50, source: 'firmware 4.6.0 default (vbat_min_cell_voltage 330, vbat_warning_cell_voltage 350)' },
        source: 'log header vbatcellvoltage (vbat_min_cell_voltage, vbat_warning_cell_voltage): the battery levels that the pilot set; a load step that takes a battery from the warning level or more to less than the minimum shows a weak battery',
        note: 'flag: a load step with the voltage for each cell at the warning level or more before it and less than the minimum level in it; note (monitor): the lowest voltage for each cell at a load step is less than the warning level; thin: less than minSteps load steps' },
    P2: { relHigh: 1.3, minSteps: 3,
        source: `${P}; the voltage decrease for each 1 A of a battery against the median of the other batteries of the same helicopter. No absolute limit: the wires, the connectors and the current sensor are in the value`,
        note: 'note (information); note with higher (monitor): the battery value is more than relHigh x the median of the other batteries by 2 SE (2 or more batteries with a result)' },
};
const UNITS = { P1: 'V', P2: 'mOhm' };
const PHASES = ['idle', 'spoolup', 'ground', 'flight', 'spooldown'];  // health_phase PHASES

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const num = (v) => typeof v === 'number' && isFinite(v);
const sum = (a) => a.reduce((s, v) => s + v, 0);
function stat(v) { // mean, standard error across items, n
    const x = v.filter(num), n = x.length;
    if (!n) return { mean: null, se: null, n: 0 };
    const m = sum(x) / n, sd = n > 1 ? Math.sqrt(sum(x.map(q => (q - m) ** 2)) / (n - 1)) : null;
    return { mean: m, se: sd === null ? null : sd / Math.sqrt(n), n };
}
const medianOf = (list) => { if (!list.length) return null; const s = Float64Array.from(list).sort(); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
// the median of the valid samples of v in [a, b) (keep: a sample filter), or null when none is valid
function medianIn(v, a, b, keep) { const out = []; for (let i = Math.max(0, a); i < Math.min(v.length, b); i++) if (keep(v[i])) out.push(v[i]); return out.length ? medianOf(out) : null; }

// The clocks of a segment (health_rescue.cjs clocks): F(i) frame seconds (the time field), t(i) index seconds
function clocks(w, rate) {
    const n = w.n, T = w.extra && w.extra.time && w.extra.time.length === n ? w.extra.time : null;
    const F = (i) => !T ? w.fromS + i / rate : i <= 0 ? w.fromS + i / rate : i >= n - 1 ? w.fromS + (T[n - 1] - T[0]) / 1e6 + (i - n + 1) / rate : w.fromS + (T[i] - T[0]) / 1e6;
    return { F, t: (i) => r(w.fromS + i / rate, 3), frame: !!T };
}

// a battery level of the header in V for each cell: Rotorflight writes 0.01 V (330), Betaflight 0.1 V (33)
const level = (v) => num(v) && v > 0 ? (v > 100 ? v / 100 : v / 10) : null;
function limitsOf(H, cli) {
    const g = cli && cli.global ? cli.global : {}, out = { min: null, warning: null, max: null, source: null };
    const c = { min: level(g.vbat_min_cell_voltage), warning: level(g.vbat_warning_cell_voltage), max: level(g.vbat_max_cell_voltage) };
    const h = { min: level(H.vbatmincellvoltage), warning: level(H.vbatwarningcellvoltage), max: level(H.vbatmaxcellvoltage) };
    // the log header first: it holds the values at the time of the log, and a CLI dump that does not agree with it is older
    // (the 2026-09-04 Fireball dump differs from the 2026-09-19 logs, check D4)
    const from = h.min !== null && h.warning !== null ? 'header' : c.min !== null && c.warning !== null ? 'cli' : 'default';
    const D = DEFAULT_RULES.P1.defaults;
    out.min = from === 'cli' ? c.min : from === 'header' ? h.min : D.min;
    out.warning = from === 'cli' ? c.warning : from === 'header' ? h.warning : D.warning;
    out.max = h.max !== null ? h.max : c.max !== null ? c.max : 4.30;
    out.source = from === 'cli' ? 'CLI vbat_min_cell_voltage and vbat_warning_cell_voltage' : from === 'header' ? 'log header vbatcellvoltage' : D.source;
    return out;
}
// the cell count of the firmware for a resting voltage (battery.c batteryUpdatePresence), or null
function autoCells(v, min, max) {
    if (!num(v) || !num(min) || !num(max)) return null;
    for (const k of RULE.cells.auto) if (v >= k * min - 1e-9 && v <= k * max + 1e-9) return k;
    return null;
}

// ---------------------------------------------------------------------------------------------
// analyse
// ---------------------------------------------------------------------------------------------

function analyse(w, ctx = {}) {
    const n = w.n, rate = ctx.rate || w.rate, X = w.extra || {}, H = ctx.header || (w.flight && w.flight.header) || {}, C = clocks(w, rate), { F, t } = C;
    const S = (s) => Math.max(1, Math.round(s * rate));
    const out = { module: 'health_power', rule: RULE, rate: r(rate, 2), fromS: r(w.fromS, 3), seconds: r(n / rate, 1), frameClock: C.frame, limits: limitsOf(H, ctx.cliParsed || null),
        cells: null, cellsSource: null, cellsBasis: null, hasVoltage: false, hasCurrent: false, restStart: null, restEnd: null, rests: [], steps: [], stepsFound: 0, notes: [] };
    const V = X.Vbat, I = X.Ibat, mot = X['motor[0]'];
    if (!V) { out.skipped = 'The log does not record the battery voltage (`Vbat`).'; out.noVoltage = 'absent'; return out; }
    const vMin = RULE.minVolts * 100, okV = (x) => x >= vMin;
    let valid = 0; for (let i = 0; i < n; i++) if (okV(V[i])) valid++;
    if (valid < S(RULE.rest.s)) { out.skipped = valid ? 'The battery voltage (`Vbat`) is 0 in almost all samples of the log.' : 'The battery voltage (`Vbat`) is 0 in all samples of the log.'; out.noVoltage = 'zero'; return out; }
    out.hasVoltage = true;
    if (!mot) { out.skipped = 'The log does not record the throttle (`motor[0]`). Thus, the analysis cannot find the load steps.'; return out; }
    let anyI = false; if (I) for (let i = 0; i < n; i++) if (I[i] > 0) { anyI = true; break; }
    out.hasCurrent = anyI;
    const gov = ctx.govState !== undefined ? ctx.govState : w.govStateAt || null, code = ctx.phases && ctx.phases.code && ctx.phases.code.length === n ? ctx.phases.code : null;

    // resting voltages: stretches with motor[0] at rest.motor or less
    const quiet = [];
    for (let i = 0; i < n;) { if (!(mot[i] <= RULE.rest.motor)) { i++; continue; } let j = i; while (j < n && mot[j] <= RULE.rest.motor) j++; quiet.push([i, j]); i = j; }
    const restOf = (a, b, atEnd) => { const len = S(RULE.rest.s), lo = atEnd ? Math.max(a, b - len) : a, hi = atEnd ? b : Math.min(b, a + len), v = medianIn(V, lo, hi, okV);
        return v === null ? null : { v: r(v / 100, 3), t: t(lo), tS: r(F(lo), 3), t1S: r(F(hi), 3) }; };
    const first = quiet.find(([a, b]) => b - a >= S(RULE.rest.s) && F(a) - F(0) <= RULE.rest.searchS), last = quiet.slice().reverse().find(([a, b]) => b - a >= S(RULE.rest.s) && F(n - 1) - F(b - 1) <= RULE.rest.searchS);
    out.restStart = first ? restOf(first[0], first[1], false) : null;
    out.restEnd = last ? restOf(last[0], last[1], true) : null;
    for (const [a, b] of quiet) if (b - a >= S(RULE.rest.minS) && out.rests.length < RULE.maxRests) { const q = restOf(a, b, false); if (q) out.rests.push(q); }

    // cells: the CLI (ctx), else the rule of the firmware on the resting voltage at the start (else the first valid second)
    const L = out.limits;
    // cellsBasis { kind: 'cli' | 'firmware' | 'none', volts, at: 'rest' (motor at rest.motor or less) | 'first' (the first second with a voltage) }
    if (num(ctx.cells) && ctx.cells > 0 && !/^inferred/.test(String(ctx.cellsSource || '')) && !ctx.cellsAmbiguous) { out.cells = ctx.cells; out.cellsSource = ctx.cellsSource || 'CLI battery_cell_count'; out.cellsBasis = { kind: 'cli', volts: null, at: null }; }
    else {
        let v0 = out.restStart ? out.restStart.v : null, at0 = 'rest';
        if (v0 === null) { let a = 0; while (a < n && !okV(V[a])) a++; const m = medianIn(V, a, a + S(RULE.rest.s), okV); v0 = m === null ? null : m / 100; at0 = 'first'; }
        const k = autoCells(v0, L.min, L.max);
        out.cellsBasis = { kind: k ? 'firmware' : 'none', volts: r(v0, 2), at: v0 === null ? null : at0 };
        if (k) { out.cells = k; out.cellsSource = `firmware rule (battery.c): ${r(v0, 2)} V at the start of the log${at0 === 'rest' ? ' with the motor at 5 % or less' : ', the first second with a voltage'}`; }
        else out.cellsSource = v0 === null ? 'no voltage at the start of the log' : `no cell count of the firmware rule fits ${r(v0, 2)} V with ${L.min} V to ${L.max} V for each cell`;
    }

    // load steps: motor[0] up by step.throttle or more within step.riseS (a running minimum), the rotor governed over the rise
    const rise = S(RULE.step.riseS), hold = S(RULE.step.holdS), before = S(RULE.step.beforeS), gap = S(RULE.step.gapS), half = Math.max(1, Math.round(S(RULE.smoothS) / 2)), stride = Math.max(1, S(RULE.strideS));
    let hsRef = null; if (!gov && w.hs) { const turning = []; for (let i = 0; i < n; i += 10) if (w.hs[i] >= RULE.turningRpm) turning.push(w.hs[i]); hsRef = medianOf(turning); }
    const spooled = (i) => gov ? gov[i] === RULE.active : !!w.hs && hsRef !== null && w.hs[i] >= RULE.spool.share * hsRef;
    const okI = (x) => num(x) && x >= 0;
    const dq = []; let next = 0;
    for (let i = 0; i < n; i++) {
        while (dq.length && mot[dq[dq.length - 1]] >= mot[i]) dq.pop();
        dq.push(i); while (dq[0] < i - rise) dq.shift();
        if (i < next || mot[i] - mot[dq[0]] < RULE.step.throttle) continue;
        const i0 = dq[0], i1 = i, end = Math.min(n, i1 + hold);
        next = i1 + 1;
        if (i0 - before < 0) continue;
        let gov0 = true; for (let j = i0; j <= i1; j += Math.max(1, (i1 - i0) >> 3)) if (!spooled(j)) { gov0 = false; break; }
        if (!gov0 || !spooled(i1)) continue;
        // without GOVSTATE, the headspeed must also be stable before the step (a spool-up ramps it)
        if (!gov && !(spooled(i0 - before) && Math.abs(w.hs[i0] - w.hs[i0 - before]) <= RULE.spool.stable * hsRef)) continue;
        const vb = medianIn(V, i0 - before, i0 + 1, okV); if (vb === null) continue;
        let low = Infinity, lowAt = -1, iMax = -Infinity, peak = -Infinity;
        for (let j = i0; j < end; j += stride) { const m = medianIn(V, j - half, j + half + 1, okV); if (m !== null && m < low) { low = m; lowAt = j; }
            if (anyI) { const q = medianIn(I, j - half, j + half + 1, okI); if (q !== null && q > iMax) iMax = q; } }
        for (let j = i1; j < end; j++) if (mot[j] > peak) peak = mot[j];
        if (lowAt < 0) continue;
        const ib = anyI ? medianIn(I, i0 - before, i0 + 1, okI) : null, dA = ib !== null && isFinite(iMax) ? (iMax - ib) / 100 : null, sag = (vb - low) / 100;
        out.stepsFound++;
        if (out.steps.length < RULE.maxEvents) out.steps.push({ t: t(i0), t1: t(end - 1), tS: r(F(i0), 3), t1S: r(F(end - 1), 3), lowS: r(F(lowAt), 3), riseS: r((i1 - i0) / rate, 3),
            vBefore: r(vb / 100, 3), vMin: r(low / 100, 3), sag: r(sag, 3), throttleBefore: r(mot[i0] / 10, 1), throttlePeak: r(peak / 10, 1),
            iBefore: ib === null ? null : r(ib / 100, 2), iMax: isFinite(iMax) ? r(iMax / 100, 2) : null, dA: r(dA, 2), mOhm: dA !== null && dA >= RULE.minDeltaA ? r(1000 * sag / dA, 2) : null,
            phase: code ? PHASES[code[i0]] || null : null });
        next = end + gap;
    }
    if (out.stepsFound > out.steps.length) out.notes.push(`The log has ${out.stepsFound} load steps. The analysis keeps the first ${out.steps.length}.`);
    return out;
}

// ---------------------------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------------------------

// The logs of the file as one list, in log order: the segments of a log together (steps, rests), the resting voltages at the
// start of the first segment and at the end of the last one
function byLog(flights) {
    const m = new Map();
    for (const f of flights) { if (!f || !f.metrics) continue; if (!m.has(f.log)) m.set(f.log, []); m.get(f.log).push(f); }
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([log, list]) => {
        list.sort((a, b) => (a.segment || 0) - (b.segment || 0));
        const M = list.map(f => f.metrics), live = M.filter(x => !x.skipped);
        return { log, list, M, live, skipped: live.length ? null : M[0].skipped, noVoltage: live.length ? null : M[0].noVoltage || null,
            steps: [].concat(...live.map(x => x.steps || [])), rests: [].concat(...live.map(x => x.rests || [])),
            restStart: live.length ? live[0].restStart : null, restEnd: live.length ? live[live.length - 1].restEnd : null,
            cells: (live.find(x => num(x.cells)) || {}).cells || null, cellsSource: (live.find(x => num(x.cells)) || live[0] || M[0]).cellsSource || null,
            cellsBasis: (live.find(x => num(x.cells)) || live[0] || M[0]).cellsBasis || null,
            limits: (live[0] || M[0]).limits, hasCurrent: live.some(x => x.hasCurrent), notes: [].concat(...live.map(x => x.notes || [])) };
    });
}

// Finding texts follow ASD-STE100 (docs/STE_GLOSSARY.md): sentences of 25 words or less, joined by '\n' as paragraphs.
// Code reads the fields of a finding, never its text.
function judge(flights, RULES = DEFAULT_RULES) {
    const F = [], sig = RULES.sig === undefined ? 2 : RULES.sig, rule = (id) => Object.assign({}, DEFAULT_RULES[id], RULES[id] || {});
    const fmt = (v, d = 2) => num(v) ? (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d) : 'unknown';
    const many = (k, w, ws) => `${k} ${k === 1 ? w : ws || `${w}s`}`, para = (...p) => p.filter(Boolean).join('\n');
    const logsWord = (list) => list.length === 1 ? `log ${list[0]}` : `${list.slice(0, -1).map(l => `log ${l}`).join(', ')} and log ${list[list.length - 1]}`;
    const add = (id, severity, log, o) => F.push(Object.assign({ id, severity, log, profile: null, value: null, se: null, n: null, threshold: null, source: rule(id).source || null, unit: UNITS[id], phase: null, thin: false }, o));
    const L1 = rule('P1'), L2 = rule('P2'), logs = byLog(flights);

    // batteries: a new battery at a log whose resting voltage at the start is more than newBatteryCell above the resting voltage at
    // the end of the flight log before it (or when one of the two is unknown); a rise of that size between two resting stretches
    // inside a log also starts a battery (its steps after that time go to the new battery)
    const batteries = []; let prev = null;
    const newBattery = (log) => { const b = { id: log, index: batteries.length + 1, logs: [log], steps: [], cells: null, hasCurrent: false }; batteries.push(b); return b; };
    for (const g of logs) {
        if (!g.live.length || !num(g.cells)) { g.battery = null; continue; }
        const startCell = g.restStart ? g.restStart.v / g.cells : null, endCell = prev && prev.restEnd && num(prev.cells) ? prev.restEnd.v / prev.cells : null;
        const same = prev && prev.battery && prev.cells === g.cells && startCell !== null && endCell !== null && startCell - endCell <= RULE.newBatteryCell;
        g.battery = same ? prev.lastBattery : newBattery(g.log);
        if (same && !g.battery.logs.includes(g.log)) g.battery.logs.push(g.log);
        g.sameAs = same ? prev.log : null; g.riseCell = startCell !== null && endCell !== null ? startCell - endCell : null;
        g.lastBattery = g.battery; g.changeAt = null;
        for (let k = 1; k < g.rests.length; k++) if ((g.rests[k].v - g.rests[k - 1].v) / g.cells > RULE.newBatteryCell) { g.changeAt = g.rests[k].tS; g.lastBattery = newBattery(g.log); break; }
        for (const s of g.steps) (g.changeAt !== null && s.tS >= g.changeAt ? g.lastBattery : g.battery).steps.push(Object.assign({ log: g.log }, s));
        for (const b of new Set([g.battery, g.lastBattery])) { b.cells = g.cells; b.hasCurrent = b.hasCurrent || g.hasCurrent; }
        prev = g;
    }
    const batteryOf = (b) => b ? { id: b.id, index: b.index, logs: b.logs.slice() } : null;

    // P1, one finding for each flight log
    for (const g of logs) {
        const lim = { min: num(L1.min) ? L1.min : g.limits ? g.limits.min : L1.defaults.min, warning: num(L1.warning) ? L1.warning : g.limits ? g.limits.warning : L1.defaults.warning,
            source: num(L1.min) && num(L1.warning) ? 'rules' : g.limits ? g.limits.source : L1.defaults.source };
        const base = { limits: lim, threshold: { min: lim.min, warning: lim.warning, minSteps: L1.minSteps }, battery: batteryOf(g.battery) };
        if (!g.live.length) { add('P1', 'skipped', g.log, Object.assign(base, { noVoltage: g.noVoltage, text: g.skipped || 'The log has no battery voltage.' })); continue; }
        if (!num(g.cells)) { const b = g.cellsBasis || {};
            add('P1', 'skipped', g.log, Object.assign(base, { cellsSource: g.cellsSource, text: para(`The cell count of the battery is not clear.${num(b.volts) && g.limits ? ` No cell count of the firmware rule agrees with ${fmt(b.volts, 2)} V and ${fmt(g.limits.min, 2)} V to ${fmt(g.limits.max, 2)} V for each cell.` : ' The log has no voltage at the start.'}`,
                'Thus, the analysis does not calculate the voltage for each cell. The log does not record the cell count.') })); continue; }
        const c = g.cells, steps = g.steps.map(s => Object.assign({}, s, { sagCell: s.sag / c, beforeCell: s.vBefore / c, minCell: s.vMin / c }));
        const severe = steps.filter(s => s.beforeCell >= lim.warning && s.minCell < lim.min), m = stat(steps.map(s => s.sagCell)), nSteps = steps.length;
        const lowest = steps.slice().sort((a, b) => a.minCell - b.minCell)[0] || null, worst = steps.slice().sort((a, b) => b.sagCell - a.sagCell)[0] || null;
        const thin = nSteps < L1.minSteps, sev = severe.length ? 'flag' : thin ? 'note' : lowest && lowest.minCell < lim.warning ? 'note' : 'ok';
        const events = steps.map(s => ({ t: s.t, t1: s.t1, tS: s.tS, t1S: s.t1S, lowS: s.lowS, value: r(s.sagCell, 4), rank: r(s.sagCell, 4), beforeCell: r(s.beforeCell, 3), minCell: r(s.minCell, 3),
            vBefore: s.vBefore, vMin: s.vMin, throttleBefore: s.throttleBefore, throttlePeak: s.throttlePeak, dA: s.dA, mOhm: s.mOhm, phase: s.phase, profile: null,
            bad: s.beforeCell >= lim.warning && s.minCell < lim.min, low: s.minCell < lim.warning }));
        const cb = g.cellsBasis || {}, cellsText = cb.kind === 'firmware' ? `The battery has ${c} cells. The firmware gives this cell count for ${fmt(cb.volts, 2)} V, ${cb.at === 'rest' ? 'the voltage at the start of the log before the motor starts' : 'the voltage in the first second of the log'}.`
            : `The battery has ${c} cells (\`battery_cell_count\` in the CLI).`;
        const what = 'When the throttle increases quickly, the battery voltage decreases. A weak battery cannot hold its voltage, and then the headspeed can decrease.';
        const meanText = !nSteps ? 'The log has no load step with the governor in ACTIVE.' : nSteps === 1 ? `At 1 load step, the voltage for each cell decreases by ${fmt(m.mean, 3)} V.`
            : `At ${many(nSteps, 'load step')}, the voltage for each cell decreases by ${fmt(m.mean, 3)} ± ${fmt(m.se, 3)} V on average. The largest decrease is ${fmt(worst.sagCell, 3)} V at ${fmt(worst.tS, 1)} s.`;
        const lowText = lowest ? `The lowest voltage for each cell at a load step is ${fmt(lowest.minCell, 2)} V at ${fmt(lowest.lowS, 1)} s. Before that step, it is ${fmt(lowest.beforeCell, 2)} V.` : '';
        const limText = `The firmware levels are ${fmt(lim.warning, 2)} V (warning) and ${fmt(lim.min, 2)} V (minimum) for each cell.`;
        const verdict = severe.length ? `At ${many(severe.length, 'load step')}, the voltage goes from the warning level or more to less than the minimum. Possibly, the battery is weak.`
            : thin ? `The log has ${many(nSteps, 'load step')}. A minimum of ${L1.minSteps} is necessary for a result.`
            : lowest && lowest.minCell < lim.warning ? 'The voltage at a load step goes to less than the warning level. Examine the battery and the time of the flight.'
            : 'At the load steps, the voltage does not go less than the warning level.';
        const other = 'Check G13 gives the low voltage of all of the flight. Check D5 gives the sudden voltage changes.';
        const sameText = g.sameAs !== null && g.sameAs !== undefined ? `The voltage at the start of this log agrees with the end of log ${g.sameAs}. Thus, the analysis uses one battery for the two logs.` : '';
        add('P1', sev, g.log, Object.assign(base, { value: m.n ? r(m.mean, 4) : null, se: m.n > 1 ? r(m.se, 4) : null, n: nSteps, thin, cells: c, cellsSource: g.cellsSource,
            minCell: lowest ? r(lowest.minCell, 3) : null, minCellT: lowest ? lowest.t : null, minCellS: lowest ? lowest.lowS : null, beforeCell: lowest ? r(lowest.beforeCell, 3) : null,
            throttleAtMin: lowest ? lowest.throttlePeak : null, worstSagCell: worst ? r(worst.sagCell, 4) : null, worstSagS: worst ? worst.tS : null, severe: severe.length, hasCurrent: g.hasCurrent,
            restStartCell: g.restStart ? r(g.restStart.v / c, 3) : null, restEndCell: g.restEnd ? r(g.restEnd.v / c, 3) : null, sameBatteryAs: g.sameAs === undefined ? null : g.sameAs, batteryChangeS: g.changeAt,
            phase: (severe[0] || lowest || {}).phase || null, onsets: severe.map(s => ({ t: s.t, tS: s.tS })), events,
            text: para(what, `${meanText} ${lowText}`.trim(), `${limText} ${verdict}`, `${cellsText} ${sameText}`.trim(), other) }));
    }

    // P2, one finding for each battery with the battery output (Ibat)
    const res = [];
    for (const b of batteries) {
        const L = b.logs.length === 1 ? b.logs[0] : b.logs.slice(), base = { battery: batteryOf(b), cells: b.cells, threshold: { relHigh: L2.relHigh, sig, minDeltaA: RULE.minDeltaA, minSteps: L2.minSteps } };
        if (!b.hasCurrent) { add('P2', 'skipped', L, Object.assign(base, { text: 'The log does not record the battery output (`Ibat`), or it is 0. Thus, the analysis cannot calculate the voltage decrease for each 1 A.' })); continue; }
        const use = b.steps.filter(s => num(s.mOhm)), m = stat(use.map(s => s.mOhm)), thin = use.length < L2.minSteps;
        const q = { b, L, base, m, use, thin, events: use.map(s => ({ log: s.log, t: s.t, t1: s.t1, tS: s.tS, t1S: s.t1S, value: s.mOhm, rank: s.mOhm, dA: s.dA, sag: s.sag, phase: s.phase, profile: null })) };
        res.push(q);
    }
    const ok = res.filter(q => !q.thin && num(q.m.mean));
    for (const q of res) {
        const { b, L, base, m, thin, events } = q, others = ok.filter(x => x !== q).map(x => x.m.mean), med = others.length ? medianOf(others) : null;
        const higher = !thin && med !== null && num(m.se) && m.mean - L2.relHigh * med > sig * m.se;
        const perCell = num(m.mean) && b.cells ? m.mean / b.cells : null, perCellSe = num(m.se) && b.cells ? m.se / b.cells : null;
        const where = b.logs.length > 1 ? `This battery flies ${logsWord(b.logs)}.` : '';
        const what = 'When the battery output increases, the battery voltage decreases. A weak battery, a bad connector or a bad wire increases this decrease.';
        const val = !m.n ? `The battery has no load step with an increase of ${RULE.minDeltaA} A or more.`
            : `At ${many(m.n, 'load step')}, the voltage decreases by ${fmt(m.mean, 1)}${m.n > 1 ? ` ± ${fmt(m.se, 1)}` : ''} mV for each 1 A. This is ${fmt(perCell, 2)} mΩ for each cell.`;
        const cmp = thin ? `A minimum of ${L2.minSteps} load steps is necessary for a result.` : med === null ? 'The other batteries of the file have no result. Thus, the analysis cannot compare this battery.'
            : higher ? `This is more than ${fmt(L2.relHigh, 1)} times the median of the other batteries (${fmt(med, 1)} mΩ), by ${sig} SE. Possibly, the battery is weak.`
            : `The median of the other batteries is ${fmt(med, 1)} mΩ. The limit is ${fmt(L2.relHigh, 1)} times this value (${sig} SE test).`;
        add('P2', 'note', L, Object.assign(base, { value: m.n ? r(m.mean, 2) : null, se: m.n > 1 ? r(m.se, 2) : null, n: m.n, thin, perCell: r(perCell, 3), perCellSe: r(perCellSe, 3), higher, others: others.length, othersMedian: r(med, 2),
            events, text: para(what, val, `${cmp} ${where}`.trim()) }));
    }
    return F;
}

// ---------------------------------------------------------------------------------------------
// curves
// ---------------------------------------------------------------------------------------------

// the load step windows for the UI: [{ t0, t1, sag (V, the battery) }] in frame seconds
function curves(w, ctx, metrics) {
    const m = metrics || analyse(w, ctx);
    return { steps: (m.steps || []).map(s => ({ t0: s.tS, t1: s.t1S, sag: s.sag, profile: null })) };
}

module.exports = { EXTRA, RULE, DEFAULT_RULES, analyse, judge, curves, autoCells, limitsOf };
if (require.main !== module) return;

// node tools/autotune/health_power.cjs <log files...>: the load steps of every log, with the two checks
const lib = optional('./lib.cjs'), app = lib.loadApp();
for (const file of process.argv.slice(2)) {
    const flights = [];
    for (const w of lib.segments(app, file, { whole: true, extra: EXTRA })) {
        if (w.skipped) continue;
        const fl = w.flight;
        flights.push({ log: fl.log, segment: 0, header: fl.header, metrics: analyse(w, { rate: fl.actualRate, header: fl.header }) });
    }
    for (const f of judge(flights)) console.log(`#${Array.isArray(f.log) ? f.log.join('+') : f.log} ${f.id} ${f.severity} ${f.value} ± ${f.se} n ${f.n}\n  ${String(f.text).replace(/\n/g, '\n  ')}`);
}
