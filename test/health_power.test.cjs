'use strict';

// Ground-truth checks for tools/autotune/health_power.cjs (P1 battery voltage under load, P2 voltage decrease for each 1 A):
// simulated segments with a battery model V = V0 - drift t - R I (Vbat lags the current by 50 ms and holds each telemetry value
// for 35 ms, in 0.01 V steps), throttle steps with the governor ACTIVE, and known injections: a weak battery whose load steps
// take it from the warning level to less than the minimum, a battery change between logs, a log with no Ibat, a cell count
// that the firmware rule cannot find, telemetry errors that the running median removes. A simulated 4.6 flight written as a
// .bbl file and read back by the app's decoder checks the header levels, the units and the cell count. With AUTOTUNE_REAL_LOG
// (the Gaui X4 dump 2026-10-04, Vbat 0 in all samples) and AUTOTUNE_RESCUE_LOG (the Fireball dump 2026-10-05, Vbat from the ESC
// telemetry, Ibat 0), the flight logs of the two files.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const P = require('../tools/autotune/health_power.cjs');

const RATE = 1000, at = (s) => Math.round(s * RATE);
const within = (got, want, tol, what) => assert.ok(typeof got === 'number' && Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);
const only = (F, id, log) => { const l = F.filter(f => f.id === id && (log === undefined || JSON.stringify(f.log) === JSON.stringify(log))); assert.equal(l.length, 1, `${id} log ${log}: one finding, got ${l.length}`); return l[0]; };
const HEADER = { vbatmincellvoltage: 330, vbatwarningcellvoltage: 350, vbatmaxcellvoltage: 430, 'Firmware revision': 'Rotorflight 4.6.0 (sim)' };

// One segment as lib.segments whole gives it. o: seconds, v0 (V, resting at the start), R (ohm), drift (V/s), baseA (A at 0 %
// throttle), aPerPct (A for each throttle point), steps [[t, from %, to %, rampS, holdS]] (the governor ACTIVE from 3 s to 2 s
// before the end, 50 % between steps), lag (s of the Vbat lag), holdS (telemetry hold), noIbat, zeroVbat, glitches [[t, V, s]],
// dropouts [[t, s]] (Vbat 0), endRest (s of rest at the end, motor 0), noGov (no GOVSTATE: the headspeed decides)
function segment(o = {}) {
    o = Object.assign({ seconds: 40, v0: 25.2, R: 0.015, drift: 0.004, baseA: 2, aPerPct: 1, steps: [[10, 50, 80, 0.2, 1], [16, 50, 80, 0.2, 1], [22, 50, 80, 0.2, 1], [28, 50, 80, 0.2, 1]], lag: 0.05, holdS: 0.035,
        noIbat: false, zeroVbat: false, glitches: [], dropouts: [], endRest: 2, noGov: false }, o);
    const n = at(o.seconds), mot = new Float64Array(n), V = new Float64Array(n), I = new Float64Array(n), hs = new Float64Array(n), gov = new Uint8Array(n), time = new Float64Array(n);
    const active = (t) => t >= 3 && t < o.seconds - o.endRest;
    const thrAt = (t) => { if (!active(t)) return 0; for (const [s, a, b, ramp, hold] of o.steps) { if (t >= s && t < s + ramp) return a + (b - a) * (t - s) / ramp; if (t >= s + ramp && t < s + ramp + hold) return b; if (t >= s + ramp + hold && t < s + 2 * ramp + hold) return b - (b - a) * (t - s - ramp - hold) / ramp; } return 50; };
    const amps = new Float64Array(n), volts = new Float64Array(n);
    for (let i = 0; i < n; i++) { const t = i / RATE, thr = thrAt(t); mot[i] = Math.round(thr * 10); amps[i] = o.baseA + o.aPerPct * thr; gov[i] = active(t) ? 4 : t >= 1 && t < 3 ? 2 : 0;
        hs[i] = active(t) ? 2500 : t >= 1 && t < 3 ? 2500 * (t - 1) / 2 : 0; time[i] = 1e6 + i * 1e6 / RATE; }
    for (let i = 0; i < n; i++) { const t = i / RATE, j = Math.max(0, i - at(o.lag)); volts[i] = o.v0 - o.drift * t - o.R * amps[j]; }
    const hold = Math.max(1, at(o.holdS));
    for (let i = 0; i < n; i++) { const k = i - (i % hold); V[i] = o.zeroVbat ? 0 : Math.round(volts[k] * 100); I[i] = Math.round(amps[k] * 100); }
    for (const [t, v, s] of o.glitches) for (let i = at(t); i < at(t + s); i++) V[i] = Math.round(v * 100);
    for (const [t, s] of o.dropouts) for (let i = at(t); i < at(t + s); i++) V[i] = 0;
    const extra = { Vbat: V, Ibat: o.noIbat ? null : I, 'motor[0]': mot, 'mixer[3]': new Float64Array(n), time };
    return { n, rate: RATE, fromS: 0, seconds: n / RATE, hs, govStateAt: o.noGov ? null : gov, extra, flight: { log: 0, header: HEADER, actualRate: RATE } };
}
const metrics = (w, ctx = {}) => JSON.parse(JSON.stringify(P.analyse(w, Object.assign({ rate: RATE, header: HEADER }, ctx))));
const judgeOne = (w, ctx) => P.judge([{ log: 0, segment: 0, header: HEADER, metrics: metrics(w, ctx) }]);

test('module contract: exports, the require.main guard, and no Node API call at load', () => {
    for (const k of ['EXTRA', 'RULE', 'DEFAULT_RULES', 'analyse', 'judge', 'curves']) assert.ok(k in P, k);
    for (const f of ['Vbat', 'Ibat', 'motor[0]', 'time']) assert.ok(P.EXTRA.includes(f), f);
    const src = fs.readFileSync(path.join(__dirname, '../tools/autotune/health_power.cjs'), 'utf8');
    assert.match(src, /module\.exports = \{[^}]*\};\nif \(require\.main !== module\) return;/);
    const head = src.split('if (require.main !== module) return;')[0];
    assert.doesNotMatch(head, /require\('node:/, 'no Node module before the guard');
    for (const id of ['P1', 'P2']) assert.ok(typeof P.DEFAULT_RULES[id].source === 'string' && P.DEFAULT_RULES[id].source.length > 20, `${id} source`);
    for (const k of ['step', 'smoothS', 'minDeltaA', 'rest', 'newBatteryCell', 'cells']) assert.ok(P.RULE.source[k], `RULE source ${k}`);
});

test('the cell count follows the firmware rule (battery.c batteryUpdatePresence), and the CLI count comes first; the header levels come before a CLI dump', () => {
    assert.equal(P.autoCells(25.2, 3.3, 4.3), 6, '25.2 V: 6 cells, the smallest count that fits (7 cells also fit)');
    assert.equal(P.autoCells(16.8, 3.3, 4.3), 4);
    assert.equal(P.autoCells(9.0, 3.3, 4.3), null, '9.0 V fits no count of 1-8, 10, 12');
    const w = segment();
    assert.equal(metrics(w).cells, 6);
    assert.equal(metrics(w, { cells: 7, cellsSource: 'inferred, low confidence: resting 25.2 V fits 6 or 7 cell counts', cellsAmbiguous: true }).cells, 6, 'an inference of health_gov is not used');
    const m = metrics(w, { cells: 12, cellsSource: 'CLI battery_cell_count' });
    assert.equal(m.cells, 12); assert.equal(m.cellsSource, 'CLI battery_cell_count');
    // the log header holds the levels at the time of the log: a CLI dump that does not agree with it is older (user rule 2026-10-06)
    const lim = P.limitsOf({ vbatmincellvoltage: 330, vbatwarningcellvoltage: 350, vbatmaxcellvoltage: 430 }, { global: { vbat_min_cell_voltage: 340, vbat_warning_cell_voltage: 360, vbat_max_cell_voltage: 440 } });
    assert.deepEqual([lim.min, lim.warning, lim.max, lim.source], [3.3, 3.5, 4.3, 'log header vbatcellvoltage']);
    // a log header with no levels: the CLI dump, else the firmware defaults
    const cli = P.limitsOf({}, { global: { vbat_min_cell_voltage: 340, vbat_warning_cell_voltage: 360 } });
    assert.deepEqual([cli.min, cli.warning], [3.4, 3.6]); assert.match(cli.source, /CLI/);
    assert.deepEqual([P.limitsOf({}, null).min, P.limitsOf({}, null).warning], [3.3, 3.5], 'firmware defaults without a header');
    assert.deepEqual([P.limitsOf({ vbatmincellvoltage: 33, vbatwarningcellvoltage: 35 }, null).min], [3.3], 'Betaflight units (0.1 V)');
});

test('P1 and P2 recover the battery model: decrease for each cell, lowest cell voltage, and the voltage decrease for each 1 A', () => {
    // dA = 30 A at each step (50 % -> 80 %, 1 A for each point), R = 15 mOhm: 0.45 V for the battery, 0.075 V for each cell
    const w = segment(), F = judgeOne(w), p1 = only(F, 'P1', 0), p2 = only(F, 'P2', 0);
    assert.equal(p1.severity, 'ok'); assert.equal(p1.n, 4); assert.equal(p1.cells, 6); assert.equal(p1.profile, null); assert.equal(p1.unit, 'V');
    within(p1.value, 0.075, 0.006, 'mean decrease for each cell');
    assert.ok(p1.se !== null && p1.se < 0.005, `SE ${p1.se}`);
    within(p1.minCell, (25.2 - 0.004 * 28.3 - 0.015 * 82) / 6, 0.01, 'lowest cell voltage at a step');
    assert.equal(p1.events.length, 4); assert.ok(p1.events.every(e => typeof e.tS === 'number' && typeof e.t === 'number' && e.t1 > e.t && e.bad === false));
    within(p1.events[0].tS, 10, 0.02, 'step start in frame seconds (the time field from the segment start)');
    within(p1.events[0].t, 10, 0.02, 'step start in index seconds');
    assert.deepEqual(p1.limits, { min: 3.3, warning: 3.5, source: 'log header vbatcellvoltage' });
    assert.equal(p2.severity, 'note'); assert.equal(p2.unit, 'mOhm'); assert.equal(p2.n, 4); assert.equal(p2.higher, false);
    within(p2.value, 15, 1.5, 'voltage decrease for each 1 A, mOhm'); within(p2.perCell, 2.5, 0.25, 'for each cell');
    assert.deepEqual(p2.battery, { id: 0, index: 1, logs: [0] });
    const c = P.curves(w, { rate: RATE, header: HEADER }); assert.equal(c.steps.length, 4); within(c.steps[0].sag, 0.45, 0.04, 'curve sag');
});

test('a weak battery: a load step takes the voltage from the warning level or more to less than the minimum (flag)', () => {
    // R = 80 mOhm, 25.3 V at rest: 52 A before the step gives 21.14 V (3.52 V for each cell), 82 A in the step 18.74 V (3.12 V)
    const F = judgeOne(segment({ v0: 25.3, R: 0.08, drift: 0 })), p1 = only(F, 'P1', 0);
    assert.equal(p1.severity, 'flag'); assert.ok(p1.severe >= 1, `severe ${p1.severe}`);
    assert.ok(p1.minCell < 3.3 && p1.beforeCell >= 3.5, `${p1.beforeCell} -> ${p1.minCell}`);
    assert.ok(p1.events.some(e => e.bad)); assert.ok(p1.onsets.length >= 1);
    assert.match(p1.text, /Possibly, the battery is weak\./);
    // the same voltage decrease from a battery that is already low is a value to monitor, not the weak-battery flag
    // (the CLI count: for 20.9 V the firmware rule takes 5 cells, the smallest count that fits)
    const low = only(judgeOne(segment({ v0: 20.9, R: 0.02, drift: 0 }), { cells: 6, cellsSource: 'CLI battery_cell_count' }), 'P1', 0);
    assert.equal(P.autoCells(20.86, 3.3, 4.3), 5);
    assert.equal(low.severity, 'note'); assert.equal(low.severe, 0); assert.ok(low.minCell < 3.5 && low.thin === false);
});

test('telemetry errors: a held low value of 35 ms and dropouts to 0 do not change the result', () => {
    const base = only(judgeOne(segment()), 'P1', 0);
    const F = judgeOne(segment({ glitches: [[16.5, 18.0, 0.035], [22.6, 15.0, 0.035]], dropouts: [[10.4, 0.05], [28.5, 0.2]] })), p1 = only(F, 'P1', 0);
    within(p1.value, base.value, 0.004, 'mean decrease with errors'); within(p1.minCell, base.minCell, 0.01, 'lowest cell voltage with errors');
    assert.equal(p1.severity, 'ok');
});

test('no Ibat: P2 is skipped; Vbat 0 in all samples or no Vbat: P1 is skipped with the reason', () => {
    const F = judgeOne(segment({ noIbat: true }));
    assert.equal(only(F, 'P1', 0).severity, 'ok');
    const p2 = only(F, 'P2', 0); assert.equal(p2.severity, 'skipped'); assert.match(p2.text, /`Ibat`/);
    const z = judgeOne(segment({ zeroVbat: true }));
    assert.equal(only(z, 'P1', 0).severity, 'skipped'); assert.equal(only(z, 'P1', 0).noVoltage, 'zero'); assert.match(only(z, 'P1', 0).text, /0 in all samples/);
    assert.equal(z.filter(f => f.id === 'P2').length, 0, 'no battery without a voltage');
    const w = segment(); w.extra.Vbat = null;
    assert.equal(only(judgeOne(w), 'P1', 0).noVoltage, 'absent');
});

test('a cell count that the firmware rule cannot find, and too few load steps', () => {
    const p1 = only(judgeOne(segment({ v0: 9.0, R: 0.005 })), 'P1', 0);
    assert.equal(p1.severity, 'skipped'); assert.match(p1.text, /cell count/);
    const t = only(judgeOne(segment({ steps: [[10, 50, 80, 0.2, 1], [16, 50, 80, 0.2, 1]] })), 'P1', 0);
    assert.equal(t.severity, 'note'); assert.equal(t.thin, true); assert.equal(t.n, 2);
    const p2 = only(judgeOne(segment({ steps: [[10, 50, 80, 0.2, 1]] })), 'P2', 0); assert.equal(p2.thin, true);
});

test('the rotor must be governed: a spool-up is not a load step; without GOVSTATE the headspeed decides', () => {
    const w = segment({ steps: [] });
    for (let i = at(1); i < at(3); i++) w.extra['motor[0]'][i] = Math.round(i / at(3) * 500); // a throttle ramp in SPOOLUP
    assert.equal(only(judgeOne(w), 'P1', 0).n, 0);
    const g = only(judgeOne(segment({ noGov: true })), 'P1', 0); assert.equal(g.n, 4);
});

test('batteries: a log whose resting voltage at the start agrees with the end of the log before it uses the same battery', () => {
    // log 3: a charged battery (25.2 V); log 4 starts where log 3 ends (one battery); log 6: a new charged battery
    const a = segment({ v0: 25.2, drift: 0.02 }), endA = 25.2 - 0.02 * 40;
    const b = segment({ v0: endA + 0.05, drift: 0.02 }), c = segment({ v0: 25.1, R: 0.03 }); // log 4 ends at 23.65 V: log 6 is 0.24 V for each cell more
    const F = P.judge([{ log: 3, segment: 0, metrics: metrics(a) }, { log: 4, segment: 0, metrics: metrics(b) }, { log: 6, segment: 0, metrics: metrics(c) }]);
    const p3 = only(F, 'P1', 3), p4 = only(F, 'P1', 4), p6 = only(F, 'P1', 6);
    assert.deepEqual(p3.battery, { id: 3, index: 1, logs: [3, 4] }); assert.deepEqual(p4.battery, { id: 3, index: 1, logs: [3, 4] });
    assert.equal(p4.sameBatteryAs, 3); assert.deepEqual(p6.battery, { id: 6, index: 2, logs: [6] });
    const q34 = only(F, 'P2', [3, 4]), q6 = only(F, 'P2', 6);
    assert.equal(q34.n, 8, 'the steps of the two logs of one battery'); within(q34.value, 15, 1.5, 'battery 1'); within(q6.value, 30, 3, 'battery 2');
    assert.match(q34.text, /log 3 and log 4/);
});

test('P2 compares the batteries: a battery with 1.3 times the median of the others by 2 SE is a value to monitor', () => {
    // each log a charged battery after a battery that ends at 23.6 V (0.27 V for each cell less than the next start)
    const logs = [[0, 0.015], [1, 0.016], [2, 0.014], [3, 0.040]].map(([log, R]) => ({ log, segment: 0, metrics: metrics(segment({ v0: 25.2, R, drift: 0.04 })) }));
    const F = P.judge(logs), hi = only(F, 'P2', 3);
    assert.equal(hi.higher, true); assert.equal(hi.others, 3); within(hi.othersMedian, 15, 1.5, 'median of the others');
    for (const l of [0, 1, 2]) assert.equal(only(F, 'P2', l).higher, false, `battery ${l}`);
    assert.match(hi.text, /Possibly, the battery is weak\./);
});

test('a battery change inside a log: a rise of the resting voltage starts a new battery for the steps after it', () => {
    const w = segment({ seconds: 70, steps: [[10, 50, 80, 0.2, 1], [16, 50, 80, 0.2, 1], [50, 50, 80, 0.2, 1], [56, 50, 80, 0.2, 1]] });
    // two rests (30-34 s and 36-40 s), and a different battery from 36 s: before it, the voltage is 1.2 V (0.2 V for each cell) less
    for (const [a, b] of [[30, 34], [36, 40]]) for (let i = at(a); i < at(b); i++) { w.extra['motor[0]'][i] = 0; w.govStateAt[i] = 1; }
    for (let i = 0; i < at(36); i++) if (w.extra.Vbat[i] > 0) w.extra.Vbat[i] -= 120;
    const F = judgeOne(w), p1 = only(F, 'P1', 0);
    assert.ok(typeof p1.batteryChangeS === 'number' && p1.batteryChangeS > 30 && p1.batteryChangeS < 41, `change at ${p1.batteryChangeS}`);
    const p2 = F.filter(f => f.id === 'P2'); assert.equal(p2.length, 2); assert.deepEqual(p2.map(f => f.n), [2, 2]);
});

test('a simulated 4.6 flight through the decoder: header levels, units, cell count and the model of the simulator', () => {
    let bbl, lib; try { bbl = require('./helpers/bbl_encode.cjs'); lib = require('../tools/autotune/lib.cjs'); } catch (e) { return; }
    const app = lib.loadApp(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'power-')), file = path.join(tmp, 'sim.bbl');
    const log = bbl.simulateFlight({ seconds: 60, seed: 5 }); // Vbat = 2520 - 1.5 t - 150 thr (0.01 V), Ibat = 200 + 4000 thr (0.01 A): 37.5 mOhm
    fs.writeFileSync(file, bbl.encode([log]).bytes);
    const [w] = [...lib.segments(app, file, { whole: true, extra: P.EXTRA })].filter(q => !q.skipped);
    const m = P.analyse(w, { rate: w.flight.actualRate, header: w.flight.header });
    assert.deepEqual([m.limits.min, m.limits.warning, m.limits.max], [3.3, 3.5, 4.3]); assert.equal(m.limits.source, 'log header vbatcellvoltage');
    assert.equal(m.cells, 6); assert.ok(m.hasCurrent); within(m.restStart.v, 25.18, 0.03, 'resting voltage at the start');
    const F = P.judge([{ log: 0, segment: 0, header: w.flight.header, metrics: JSON.parse(JSON.stringify(m)) }]), p2 = only(F, 'P2', 0);
    assert.ok(p2.n >= 3, `steps ${p2.n}`); within(p2.value, 37.5, 4, 'the voltage decrease for each 1 A of the simulator');
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- real logs -------------------------------------------------------------------------------------------------------------

const MARKER = Buffer.from('H Product:Blackbox flight data recorder by Nicholas Sherlock\n');
// the logs `want` of a file as separate files (fast: the decoder reads only those), each segment with its log index
function realLogs(file, want) {
    const lib = require('../tools/autotune/lib.cjs'), app = lib.loadApp(), buf = fs.readFileSync(file), at0 = [], tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'power-real-')), out = [];
    for (let i = buf.indexOf(MARKER); i >= 0; i = buf.indexOf(MARKER, i + 1)) at0.push(i);
    for (const li of want) {
        const f = path.join(tmp, `log${li}.bbl`); fs.writeFileSync(f, buf.subarray(at0[li], li + 1 < at0.length ? at0[li + 1] : buf.length));
        let seg = 0; for (const w of lib.segments(app, f, { whole: true, extra: P.EXTRA })) if (!w.skipped) out.push({ log: li, segment: seg++, header: w.flight.header, metrics: JSON.parse(JSON.stringify(P.analyse(w, { rate: w.flight.actualRate, header: w.flight.header }))) });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    return out;
}

test('real log: the Gaui X4 flights record Vbat as 0, so P1 is skipped with that reason', { skip: !process.env.AUTOTUNE_REAL_LOG && 'AUTOTUNE_REAL_LOG is not set' }, () => {
    const F = P.judge(realLogs(process.env.AUTOTUNE_REAL_LOG, [49, 50, 51, 58]));
    for (const l of [49, 50, 51, 58]) { const p1 = only(F, 'P1', l); assert.equal(p1.severity, 'skipped'); assert.equal(p1.noVoltage, 'zero'); }
    assert.equal(F.filter(f => f.id === 'P2').length, 0);
});

test('real log: the Fireball flights (ESC telemetry, 6 cells, Ibat 0)', { skip: !process.env.AUTOTUNE_RESCUE_LOG && 'AUTOTUNE_RESCUE_LOG is not set' }, () => {
    const flights = [5, 10, 11, 13, 14, 15], F = P.judge(realLogs(process.env.AUTOTUNE_RESCUE_LOG, flights));
    for (const l of flights) {
        const p1 = only(F, 'P1', l);
        assert.equal(p1.cells, 6, `log ${l} cells`); assert.ok(p1.n >= 3, `log ${l} steps ${p1.n}`); assert.notEqual(p1.severity, 'flag', `log ${l}`);
        assert.ok(p1.value > 0.03 && p1.value < 0.2, `log ${l} mean decrease for each cell ${p1.value}`);
        assert.ok(p1.minCell > 3.4 && p1.minCell < 3.8, `log ${l} lowest cell voltage ${p1.minCell}`);
        assert.ok(p1.restStartCell === null || (p1.restStartCell > 4.15 && p1.restStartCell < 4.25), `log ${l}: a charged battery at the start (${p1.restStartCell})`);
    }
    assert.equal(new Set(F.filter(f => f.id === 'P1').map(f => f.battery.index)).size, flights.length, 'each flight has its own charged battery');
    for (const f of F.filter(f => f.id === 'P2')) assert.equal(f.severity, 'skipped', 'Ibat is 0');
});
