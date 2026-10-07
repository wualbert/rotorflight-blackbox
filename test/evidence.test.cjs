'use strict';

// tools/autotune/evidence.cjs: frame seconds, the located blocks and windows (parity with the modules), Evidence.
//   node --test test/evidence.test.cjs
//   AUTOTUNE_REAL_LOG=<Gaui X4 dump .BBL> node --test test/evidence.test.cjs        # also parity on its logs #50 and #58 (2000 rpm)
//   AUTOTUNE_EVIDENCE_LOGS='[{"file": "<.bbl>", "rpm": 2900}, {"file": "<.bbl>", "rpm": 1900, "logs": [0]}]' node --test test/evidence.test.cjs
// The real logs run in a child process each, as the flight rpm is read when lib.cjs loads.

process.env.AUTOTUNE_FLIGHT_RPM = process.env.AUTOTUNE_FLIGHT_RPM || '2000'; // the simulated flights fly at 2500 rpm
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const lib = require('../tools/autotune/lib.cjs');
const E = require('../tools/autotune/evidence.cjs');
const C = require('../tools/autotune/catalog.cjs');
const HEALTH = require('../tools/autotune/health.cjs');
const M = { setup: require('../tools/autotune/health_setup.cjs'), gov: require('../tools/autotune/health_gov.cjs'), loop: require('../tools/autotune/health_loop.cjs'),
    track: require('../tools/autotune/health_track.cjs'), more: require('../tools/autotune/health_more.cjs') };
const EXTRA = [...new Set(Object.values(M).flatMap(m => m.EXTRA).concat(['govTarget', 'time', 'loopIteration']))];

// A record as js/tuning_worker.js analyseSegment builds it: the health.cjs mask, the normal-flight mask ANDed in (when flown),
// the five modules, the time map and the located spans. Returns the record and the context the modules saw
function analyse(app, w) {
    const fl = w.flight, rate = fl.actualRate, { p: profile } = lib.profilesOf(w, w.extra.govTarget || w.hs, HEALTH.RULE.flight.headspeed);
    const { flying, flown } = HEALTH.flightMask(w, rate), ctx = HEALTH.buildCtx(w, fl, { flying, profile, app });
    if (flown) { const N = M.more.normalMask(w, Object.assign({}, ctx)); ctx.normal = N.mask; ctx.flyingAll = flying; ctx.flying = Uint8Array.from(flying, (v, i) => v & N.mask[i]); }
    const metrics = {}; for (const [k, m] of Object.entries(M)) metrics[k] = k !== 'setup' && !flown ? null : m.analyse(w, Object.assign({}, ctx));
    metrics.locate = E.locate(w, ctx, metrics);
    return { rec: { log: fl.log, segment: 0, start: fl.start, fromS: w.fromS, seconds: w.seconds, n: w.n, actualRate: rate, header: fl.header, metrics, timeMap: E.timeMap(w) }, ctx, flown };
}
// the module counts that locate must equal
function moduleCounts(m) {
    const out = {}, g = m.gov, l = m.loop, s = m.setup;
    if (g && g.G2) out.G2 = Object.fromEntries(Object.entries(g.G2.byProfile).map(([p, q]) => [p, q.blocks || 0]));
    if (g && g.G9) out.G9 = Object.fromEntries(Object.entries(g.G9.byProfile).map(([p, q]) => [p, q.windows]));
    if (g && g.G11 && !g.G11.skipped) out.G11 = g.G11.blocks;
    if (g && g.D5 && !g.D5.skipped) { const H = g.D5.cellHistogram; out.D5 = H.counts.reduce((a, c, k) => a + (H.from + (k + 1) * H.step <= M.gov.DEFAULT_RULES.D5.minCell + 1e-9 ? c : 0), 0); }
    if (l && !l.skipped) {
        out.C8 = Object.fromEntries(Object.entries(l.C8.byProfile).map(([p, q]) => [p, q.windows]));
        if (!l.C10.skipped) out.C10 = Object.fromEntries(['roll', 'pitch'].map(ax => [ax, Object.fromEntries(Object.entries(l.C10[ax].byProfile).map(([p, q]) => [p, q.bins.map(b => b.spans)]))]));
        out.C11 = Object.fromEntries(['roll', 'pitch', 'yaw'].filter(ax => l.C11[ax] && !l.C11[ax].skipped).map(ax => [ax, Object.fromEntries(Object.entries(l.C11[ax].byProfile).map(([p, q]) => [p, q.windows]))]));
    }
    if (s && s.F5 && !s.F5.skipped) out.F5 = Object.fromEntries(s.F5.profiles.map(p => [p.profile, p.windows]));
    return out;
}

// the child of a real-log parity test: one file at one flight rpm, the logs asked for
if (process.env.EVIDENCE_PARITY_CHILD) {
    const o = JSON.parse(process.env.EVIDENCE_PARITY_CHILD), app = lib.loadApp(), out = [];
    // the logs asked for, each cut out of the file (as the viewer slices a log) so that only they are decoded
    const MARKER = Buffer.from('H Product:Blackbox flight data recorder by Nicholas Sherlock\n'), all = fs.readFileSync(o.file), at = [];
    for (let i = all.indexOf(MARKER); i >= 0; i = all.indexOf(MARKER, i + 1)) at.push(i);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-real-')), files = (o.logs || [null]).map(li => {
        if (li === null) return [null, o.file];
        const f = path.join(dir, `log${li}.bbl`); fs.writeFileSync(f, all.subarray(at[li], at[li + 1])); return [li, f]; });
    try {
        for (const [li, file] of files) for (const w of lib.segments(app, file, { whole: true, extra: EXTRA })) {
            if (w.skipped) continue;
            const t0 = Date.now(), { rec, flown } = analyse(app, w); if (!flown) continue;
            const L = rec.metrics.locate;
            out.push({ log: li === null ? w.flight.log : li, n: w.n, mismatch: L.mismatch, errors: L.errors, counts: L.counts, module: moduleCounts(rec.metrics), spans: Object.fromEntries(['G2', 'G9', 'G11', 'C8', 'C10', 'C11', 'F5', 'D5'].map(k => [k, L[k].length])), ms: Date.now() - t0 });
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    process.stdout.write(JSON.stringify(out));
    return;
}

const test = require('node:test');
const assert = require('node:assert/strict');
const bbl = require('./helpers/bbl_encode.cjs');

const within = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got} against ${want} (tolerance ${tol})`);
const frameOf = (w, i) => w.fromS + (w.extra.time[i] - w.extra.time[0]) / 1e6;
const indexOf = (w, i) => w.fromS + i / w.flight.actualRate;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// a segment whose frame clock runs at 1012.8 frames/s in flight and 988.9 after the landing, with a 26 ms loop stall (the
// Gaui X4 #58 and #50 clocks, critic.md section 3): actualRate is the mean, so index time drifts from the frame clock
function driftingSegment(n = 200000, fromS = 1.5) {
    const t = new Float64Array(n); let us = 5e6;
    for (let i = 0; i < n; i++) { t[i] = Math.round(us); us += i < 150000 ? 987.4 : 1011.2; if (i === 83573) us += 26206; }
    const actualRate = (n - 1) / ((t[n - 1] - t[0]) / 1e6);
    return { n, fromS, rate: 1000, flight: { actualRate, log: 4, header: {} }, extra: { time: t } };
}

test('timeMap and toFrame: index time to the frame clock across a drift of 0.6 ms/s, a rate change and a 26 ms stall', () => {
    const w = driftingSegment(), tm = E.timeMap(w);
    assert.equal(tm.every, 250); assert.ok(tm.frameS instanceof Float32Array); assert.equal(tm.frameS.length, Math.ceil(w.n / 250));
    assert.equal(tm.n, w.n); assert.equal(tm.actualRate, w.flight.actualRate); within(tm.endS, frameOf(w, w.n - 1), 1e-6, 'endS');
    assert.deepEqual(tm.jumps.map(j => j[0]), [83574], 'the stall is a knot');
    let drift = 0, far = 0, near = 0;
    for (let i = 0; i < w.n; i += 3) {
        const d = Math.abs(E.toFrame(tm, indexOf(w, i)) - frameOf(w, i)); drift = Math.max(drift, Math.abs(indexOf(w, i) - frameOf(w, i)));
        if (Math.abs(i - 150000) < 250) near = Math.max(near, d); else far = Math.max(far, d);
    }
    assert.ok(drift > 0.05, `index time is ${(drift * 1000).toFixed(1)} ms off the frame clock: the map matters`);
    assert.ok(far < 5e-5, `away from the rate change: ${(far * 1e3).toFixed(4)} ms, the stall included`);
    assert.ok(near < 3e-3, `at the rate change, a straight line between two knots: ${(near * 1e3).toFixed(3)} ms`);
    // before the start and after the end, the index rate; no map, or no time field: index time
    within(E.toFrame(tm, w.fromS - 1), w.fromS - 1, 1e-6, 'before the start');
    within(E.toFrame(tm, indexOf(w, w.n - 1) + 2), frameOf(w, w.n - 1) + 2, 1e-6, 'after the end');
    assert.equal(E.toFrame(null, 12.5), 12.5);
    const plain = E.timeMap(Object.assign({}, w, { extra: {} }));
    for (const i of [0, 777, 123456, w.n - 1]) within(E.toFrame(plain, indexOf(w, i)), indexOf(w, i), 1e-4, `no time field, sample ${i}`);
});

test('forFinding: spans in frame seconds, worst first, pads around the event, view and plot (synthetic record with a known drift)', () => {
    const w = driftingSegment(), tm = E.timeMap(w), at = (i) => +indexOf(w, i).toFixed(3);
    const rec = { log: 4, segment: 0, fromS: w.fromS, seconds: w.n / 1000, n: w.n, actualRate: w.flight.actualRate, header: { rollPID: [50, 100, 0, 100, 0] }, timeMap: tm,
        metrics: { setup: { D2: { events: [{ t: at(83574), value: 26.206, kind: 'loop stall (time jump, iteration contiguous: no frame lost)', unit: 'ms' }] } },
            loop: { T8: { events: [{ t: at(120000), seconds: 0.4, value: 0.4, what: 'mixer[2]', profile: 1 }, { t: at(60000), seconds: 1.2, value: 1.2, what: 'mixer[2]', profile: 1 },
                { t: at(60300), seconds: 0.9, value: 0.9, what: 'mixer[2]', profile: 1 }, { t: at(10000), seconds: 0.1, value: 0.1, what: 'mixer[2]', profile: 2 }] }, C2: { events: [] } },
            more: { D6: { events: [{ t: at(59000), seconds: 3, value: 3, reason: 'rescue' }] } } } };
    const T8 = { fid: 'loop|T8|4|0|1||0', id: 'T8', severity: 'flag', log: 4, profile: 1, value: 2.5, n: 3, threshold: '>= 1 episode', text: '' };
    const ev = E.forFinding(T8, { record: rec, others: { 4: [rec] }, findings: [T8] });
    assert.equal(ev.v, 1); assert.equal(ev.fid, T8.fid); assert.equal(ev.id, 'T8'); assert.equal(ev.log, 4); assert.equal(ev.axis, 'yaw');
    assert.equal(ev.spans.length, 2, 'the profile 2 event is not of this finding; the 60.3 s event overlaps the 60.0 s one by more than half');
    const [a, b] = ev.spans;
    within(a.t0, frameOf(w, 60000) - 0.5, 1e-3, 'worst span start: frame time of the event less the 0.5 s pad');
    within(a.t1, frameOf(w, Math.round((at(60000) + 1.2 - w.fromS) * w.flight.actualRate)) + 0.5, 2e-3, 'worst span end: frame time of the event end and the pad');
    within(b.t0, frameOf(w, 120000) - 0.5, 1e-3, 'second span');
    assert.ok(Math.abs(a.t0 - (at(60000) - 0.5)) > 0.02, 'frame seconds, not index seconds');
    assert.deepEqual([a.value, a.label, a.log], [1.2, 'Tail output limit', 4]);
    assert.deepEqual(ev.view.graphs, [['mixer[2]'], ['servo[3]'], ['setpoint[2]', 'gyroADC[2]'], ['axisI[2]']]);
    assert.deepEqual([ev.view.t0, ev.view.t1, ev.view.analyser], [a.t0, a.t1, null]); within(ev.view.at, (a.t0 + a.t1) / 2, 1e-3, 'view centre');
    assert.deepEqual([ev.plot.kind, ev.plot.tab, ev.plot.curve], ['time', 'tail', 'more.tail']);
    assert.deepEqual(ev.context.map(q => [q.id, q.label]), [['D6', 'Rescue']], 'the rescue span overlaps the worst span');
    assert.equal(ev.summary, 'The tail output stays at its limit. At its limit, the tail does not have sufficient authority. Gain changes cannot correct this.\nIn PID profile 1, the tail output is at a limit for 2.5 s in 3 periods. Each period at a limit counts as a problem.');
    assert.equal(ev.plot.caption, 'The curve is the tail output, and the lines are the tail output limits: at a line, the tail does not have sufficient authority.', 'SPEC3 H: what the curves are and where the limit is');
    assert.equal(ev.expected, 'The tail output does not touch its limits.');
    // D2 at the stall: the span is the frame time of the first frame after the stall, ± 0.25 s
    const D2 = { fid: 'setup|D2|4|0|||0', id: 'D2', severity: 'flag', log: 4, profile: null, value: 0, n: w.n, text: '', events: rec.metrics.setup.D2.events };
    const d = E.forFinding(D2, { record: rec }).spans[0];
    within(d.t0 + 0.25, frameOf(w, 83574), 1e-3, 'D2 span start + pad'); within(d.t1 - 0.25, frameOf(w, 83574), 1e-3, 'D2 span end - pad'); assert.equal(d.label, 'Loop stall');
    assert.equal(E.forFinding(D2, { record: rec }).plot.points[0].t, d.t0 + 0.25);
    // a header check: no span, a table of the header keys, no view
    const h = E.forFinding({ id: 'SETUP', severity: 'note', log: 4, text: '' }, { record: rec });
    assert.deepEqual([h.spans, h.view, h.plot.kind, h.plot.rows], [[], null, 'table', [{ key: 'rollPID', value: '50,100,0,100,0' }]]);
    // skipped and unknown findings have no evidence
    assert.equal(E.forFinding({ id: 'T8', severity: 'skipped', log: 4 }, { record: rec }), null);
    assert.equal(E.forFinding({ id: 'XYZ', severity: 'flag', log: 4 }, { record: rec }), null);
    // a check with no span: the view is the whole record
    const g0 = E.forFinding({ id: 'G0', severity: 'ok', log: 4, value: 1, n: 1 }, { record: rec });
    assert.deepEqual([g0.spans.length, g0.view.t0], [0, +frameOf(w, 0).toFixed(3)]); within(g0.view.t1, frameOf(w, w.n - 1), 2e-3, 'view end');
});

// a record with an F5 line (yaw has no notch filter near it, roll and pitch have one 1.7 % away: the Gaui X4 4.07 x line), the
// T8 limits and events, and the T13 hover runs; no curves are given unless the test says so
function fileScopeRecord(w) {
    const at = (i) => +indexOf(w, i).toFixed(3);
    const line = { profile: 1, windows: 9, headspeed: 2300, order: 4.0673, hz: 155.9, prominence: 54.6, rotorLocked: true, axes: [
        { axis: 'roll', amplitude: 3.1, filtered: 0.2, nearestNotch: { code: 14, order: 4, distance: 0.0168 } }, { axis: 'pitch', amplitude: 2.2, filtered: 0.1, nearestNotch: { code: 14, order: 4, distance: 0.0168 } },
        { axis: 'yaw', amplitude: 4.4, filtered: 0.6, nearestNotch: { code: 12, order: 2, distance: 1.0337 } }] };
    return { log: 4, segment: 0, fromS: w.fromS, seconds: w.n / 1000, n: w.n, actualRate: w.flight.actualRate, header: {}, timeMap: E.timeMap(w),
        metrics: { setup: { F5: { profiles: [{ profile: 1, windows: 9, headspeed: 2300 }], lines: [line] } }, locate: { F5: [{ t0: at(50000), t1: at(56700), profile: 1, order: 4.0673, hz: 155.9, value: 3.2 }] },
            loop: { T8: { limits: { yaw: { min: -0.498, max: 0.5, limitLow: -0.498, limitHigh: 0.5 } }, events: [{ t: at(60000), seconds: 1.2, value: 1.2, what: 'mixer[2]', profile: 1 }] } },
            more: { T13: { byProfile: { 1: { windows: 20, seconds: 20, blocks: 4, iPermille: -41.3, iSe: 2, share: -0.0826, shareSe: 0.004, authorityPermille: 500, worst: [{ t0: at(70000), t1: at(80000), windows: 10, value: -41 }] } } } } } };
}

test('Show the measurement in file scope (review D-H3): with no curves for its log, a finding gets the raw fields of its span and the derive', () => {
    const w = driftingSegment(), rec = fileScopeRecord(w), F = (id, o) => Object.assign({ fid: `x|${id}`, id, severity: 'flag', log: 4, profile: 1, value: null, se: null, n: 3, threshold: null, text: '' }, o);
    const ctx = (curves) => ({ record: rec, others: { 4: [rec] }, curves });
    // F5: the spectrum of the raw and filtered gyro of the axis that has no notch filter near the line; the peak and the notch filters as lines
    const f5 = F('F5', { value: 4.0673, n: 9 }), a = E.forFinding(f5, ctx(null));
    assert.equal(a.plot.curve, 'more.vib.byProfile.1.yaw');
    assert.deepEqual(a.plot.snippet && [a.plot.snippet.fields, a.plot.snippet.derive, a.plot.snippet.fallback], [['gyroRAW[2]', 'gyroADC[2]'], { kind: 'spectrum', params: { fields: ['gyroRAW[2]', 'gyroADC[2]'] } }, true]);
    assert.deepEqual(a.plot.reference.map(r => [r.kind, r.value, r.label]), [['vline', 155.9, 'Peak 156 Hz'], ['vline', 153.3, 'Roll notch filter 153 Hz'], ['vline', 153.3, 'Pitch notch filter 153 Hz'], ['vline', 76.7, 'Yaw notch filter 76.7 Hz']]);
    assert.deepEqual(a.plot.snippet.reference, a.plot.reference);
    assert.ok(a.spans.length === 1 && a.view, 'a span to read');
    // review D-M5a: the facts for each axis, and a summary that is true for roll and pitch
    assert.deepEqual(a.facts.axes.map(q => [q.axis, q.near]), [['roll', true], ['pitch', true], ['yaw', false]]); assert.equal(a.facts.axis, 'yaw');
    assert.match(a.summary, /\(156 Hz\), [\d.]+ x the median level\. The yaw axis has no notch filter near this peak, but the roll and pitch axes have one\. /);
    assert.ok(typeof a.facts.prominence === 'number' && a.facts.prominence >= 5, 'review V5: the prominence that the F5 rule compares is a fact of the evidence');
    // the log has curves (the selected log): the curve only, as before
    const b = E.forFinding(f5, ctx({ log: 4, segment: 0 })); assert.deepEqual([b.plot.curve, b.plot.snippet], [a.plot.curve, null]); assert.deepEqual(b.plot.reference, a.plot.reference);
    // T8: mixer[2] and servo[3] against the tail output limits of the log (permille, as the log records mixer[2])
    const t8 = E.forFinding(F('T8', { value: 1.2, n: 1 }), ctx(null));
    assert.deepEqual([t8.plot.curve, t8.plot.snippet.fields, t8.plot.snippet.derive, t8.plot.snippet.fallback], ['more.tail', ['mixer[2]', 'servo[3]'], null, true]);
    assert.deepEqual(t8.plot.reference.map(r => [r.value, r.unit, r.label]), [[-498, '‰', 'Tail output limit −498 ‰'], [500, '‰', 'Tail output limit 500 ‰']]);
    assert.equal(E.forFinding(F('T8', { value: 1.2, n: 1 }), ctx({})).plot.snippet, null);
    // T13: the yaw I-term against its limit, 15 % of the tail output range on the side of the trim (permille), and the hover median
    const t13 = E.forFinding(F('T13', { severity: 'note', axis: 'yaw', value: -0.0826, se: 0.004, n: 20 }), ctx(null));
    assert.deepEqual([t13.plot.snippet.fields, t13.plot.snippet.derive], [['axisI[2]', 'mixer[2]'], null]);
    assert.deepEqual(t13.plot.reference.map(r => [r.value, r.unit, r.label]), [[-75, '‰', 'Limit −75 ‰ (15 % of the tail output range)'], [-41.3, '‰', 'Hover median −41.3 ‰']]);
    const t13c = E.forFinding(F('T13', { severity: 'note', axis: 'yaw', value: -0.0826, se: 0.004, n: 20 }), ctx({}));
    assert.deepEqual([t13c.plot.snippet, t13c.plot.reference.map(r => r.unit)], [null, ['%', '%']], 'with curves: the catalog lines');
    // any other plot that draws a curve: the fields of its first graphs (a time plot), the spectrum or the transmission of its first graph
    const c12 = E.forFinding(F('C12', { severity: 'note', axis: 'roll', value: 0.31, se: 0.02, n: 6 }), ctx(null)).plot.snippet;
    assert.deepEqual([c12.fields, c12.derive], [['setpoint[0]', 'gyroADC[0]', 'axisP[0]', 'axisI[0]'], null]);
    const c13 = E.forFinding(F('C13', { severity: 'note', axis: 'pitch', value: 32, se: 3, n: 6 }), ctx(null)).plot.snippet;
    assert.deepEqual(c13.derive, { kind: 'transmission', params: { from: 'setpoint[1]', to: 'gyroADC[1]' } });
    const c11 = E.forFinding(F('C11', { severity: 'note', axis: 'pitch', value: 0.4, n: 6 }), ctx(null)).plot.snippet;
    assert.deepEqual([c11.fields, c11.derive.kind], [['axisD[1]'], 'spectrum']);
    // the tables, and the plots with a snippet of their own, do not change
    assert.equal(E.forFinding(F('G9', { severity: 'note', value: 3, n: 4 }), ctx(null)).plot.snippet.fallback, undefined);
});

test('C14 spans (review D-LOW): the longest part of a 30 s block in the flight phase, out of rescue (with the guard of health_more)', () => {
    const w = driftingSegment(), tm = E.timeMap(w), at = (i) => +indexOf(w, i).toFixed(3), fr = (i) => +frameOf(w, i).toFixed(3), guard = M.more.RULE.spanGuardS;
    const rec = { log: 4, segment: 0, fromS: w.fromS, seconds: w.n / 1000, n: w.n, actualRate: w.flight.actualRate, header: {}, timeMap: tm,
        phases: [{ phase: 'idle', t0: fr(0), t1: fr(20000) }, { phase: 'flight', t0: fr(20000), t1: fr(140000) }, { phase: 'spooldown', t0: fr(140000), t1: fr(w.n - 1) }],
        metrics: { more: { D6: { events: [{ t: at(25000), seconds: 2, value: 2, reason: 'rescue' }] },
            C14: { byProfile: { 1: { blocks: 9, worst: [{ t0: at(10000), t1: at(40000), value: 31 }, { t0: at(130000), t1: at(160000), value: 22 }, { t0: at(150000), t1: at(180000), value: 40 }] } } } } } };
    const ev = E.forFinding({ fid: 'more|C14|4', id: 'C14', severity: 'note', log: 4, profile: 1, axis: 'pitch', value: 31, se: 5, n: 9, text: '' }, { record: rec });
    // block 3 (150-180 s) is after the flight: dropped. Block 1 (10-40 s): IDLE to 20 s and the rescue at 25-27 s: its part after the rescue. Block 2: to the end of the flight
    assert.equal(ev.spans.length, 2, JSON.stringify(ev.spans));
    const [a, b] = ev.spans;
    within(a.t0, E.toFrame(tm, at(25000) + 2) + guard, 2e-3, 'after the rescue and its guard'); within(a.t1, fr(40000), 2e-3, 'the end of the block');
    within(b.t0, fr(130000), 2e-3, 'block 2 start'); within(b.t1, fr(140000), 2e-3, 'block 2: to the end of the flight phase');
    for (const s of ev.spans) assert.equal(s.phase, 'flight');
});

test('PID profiles (SPEC2 D12): the evidence and its spans carry the PID profile of the finding (the worker\'s pidProfile)', () => {
    const w = driftingSegment(), at = (i) => +indexOf(w, i).toFixed(3);
    const rec = { log: 4, segment: 0, fromS: w.fromS, seconds: w.n / 1000, n: w.n, actualRate: w.flight.actualRate, header: {}, timeMap: E.timeMap(w),
        metrics: { loop: { T8: { events: [{ t: at(60000), seconds: 1.2, value: 1.2, profile: 0 }, { t: at(90000), seconds: 0.4, value: 0.4, profile: 0 }] } } } };
    const T8 = { fid: 'loop|T8|4|0|0||0', id: 'T8', severity: 'flag', log: 4, profile: 0, value: 1.6, n: 2, text: '' };
    const known = E.forFinding(Object.assign({ pidProfile: 2 }, T8), { record: rec });
    assert.deepEqual([known.profile, known.pidProfile, known.spans.map(s => [s.profile, s.pidProfile])], [0, 2, [[0, 2], [0, 2]]]);
    assert.match(known.summary.split('\n').pop(), /^In PID profile 2, /);
    const unknown = E.forFinding(Object.assign({ pidProfile: null }, T8), { record: rec });
    assert.deepEqual([unknown.pidProfile, unknown.spans.map(s => s.pidProfile)], [null, [null, null]]); assert.match(unknown.summary.split('\n').pop(), /^In an unknown PID profile, /);
});

test('forDecision: the three longest segments of the headspeed bin, in frame seconds (extract.cjs fromS)', () => {
    const seg = (log, fromS, seconds, median) => ({ log, fromS, seconds, headspeed: { median } });
    const S = [seg(1, 10, 30, 2490), seg(1, 50, 80, 2510), seg(2, 5, 25, 2620), seg(3, 7, 60, 2375), seg(3, 90, 20, 2499), seg(4, 0, 100, 2000)];
    const d = { axis: 'pitch', bin: 2500, flights: 3, windows: 90, change: true, changes: [{ gain: 'F', multiplier: 0.8, from: 100, to: 80 }], dTrack: 1.2, seTrack: 0.4, gates: { V1: true } };
    const ev = E.forDecision(d, S);
    assert.deepEqual(ev.spans.map(s => [s.log, s.t0, s.t1]), [[1, 50, 130], [3, 7, 67], [1, 10, 40]], '2375 and 2620 round to the 2500 bin and the 2750 bin');
    assert.equal(ev.id, 'C7'); assert.deepEqual(ev.view.graphs, [['setpoint[1]', 'gyroADC[1]'], ['mixer[1]']]);
    assert.equal(ev.summary, 'At 2500 rpm, the model calculates that pitch_f_gain 80 decreases the tracking error by 1.2 ± 0.4 deg/s. A change must decrease the tracking error by 10 % or more, and by 2 standard errors (SE) or more.');
    assert.equal(ev.plot.caption, 'The curves are the response from the setpoint to the gyro rate at this headspeed.');
    assert.deepEqual(ev.plot.rows, [{ key: 'V1', value: 'true' }]);
    assert.deepEqual(E.forDecision({ axis: 'yaw', bin: 4000, change: false, reason: 'x' }, S).spans, []);
});

test('flight phases (SPEC2 D13): every span has the phase of its record; D7 shows the flights; the new checks find their events', () => {
    const w = driftingSegment(), tm = E.timeMap(w), at = (i) => +indexOf(w, i).toFixed(3), fr = (i) => +frameOf(w, i).toFixed(3);
    // the phases of the segment as js/tuning_worker.js keeps them (frame seconds), and as health_phase.cjs gives them (index samples)
    const SPANS = [['idle', 0, 20000], ['spoolup', 20000, 30000], ['ground', 30000, 40000], ['flight', 40000, 150000], ['ground', 150000, 160000], ['spooldown', 160000, w.n - 1]];
    const frameSpans = SPANS.map(([phase, i0, i1]) => ({ phase, t0: fr(i0), t1: fr(i1) })), indexSpans = SPANS.map(([phase, i0, i1]) => ({ phase, i0, i1 }));
    const base = { log: 4, segment: 0, fromS: w.fromS, seconds: w.n / 1000, n: w.n, actualRate: w.flight.actualRate, header: {}, timeMap: tm };
    const T8ev = { loop: { T8: { events: [{ t: at(60000), seconds: 1.2, value: 1.2, profile: 1 }, { t: at(35000), seconds: 0.3, value: 0.3, profile: 1 }] }, C2: { events: [] } } };
    const T8 = { fid: 't8', id: 'T8', severity: 'flag', log: 4, profile: 1, value: 1.5, n: 2, text: '' };
    for (const rec of [Object.assign({}, base, { phases: frameSpans, metrics: T8ev }), Object.assign({}, base, { metrics: Object.assign({ phase: { spans: indexSpans } }, T8ev) }),
        Object.assign({}, base, { phases: { flight: true, spans: indexSpans }, metrics: T8ev })]) {
        const ev = E.forFinding(T8, { record: rec });
        assert.deepEqual(ev.spans.map(q => q.phase), ['flight', 'ground'], 'the worst span in flight, the other on the ground before liftoff');
        assert.equal(ev.phase, 'flight', 'the phase of the worst span when the finding has none');
        assert.deepEqual(E.phaseSpansOf(rec).map(q => q.phase), SPANS.map(q => q[0]));
        within(E.phaseSpansOf(rec)[3].t0, frameOf(w, 40000), 2e-3, 'index samples to frame seconds');
    }
    assert.deepEqual(E.forFinding(T8, { record: Object.assign({}, base, { metrics: T8ev }) }).spans.map(q => q.phase), [null, null], 'no phase spans: no phase');
    assert.deepEqual([E.phaseAt(frameSpans, fr(45000), fr(45000)), E.phaseAt(frameSpans, fr(38000), fr(42000) + 1), E.phaseAt([], 1, 2)], ['flight', 'flight', null]);
    // D7: the flights of the record (the worker's, frame seconds), else its flight phase, else the flights of the finding
    // (health_phase.cjs, index times); longest first; the seconds of each phase in a table; a bench run has no span
    const rec = Object.assign({}, base, { phases: frameSpans, metrics: {} });
    const D7 = { fid: 'd7', id: 'D7', severity: 'note', log: 4, profile: null, unit: 's', value: 110, n: 1, text: '', class: 'flight', bench: false, flights: [{ t0: at(40000), t1: at(150000), seconds: 110 }] };
    let ev = E.forFinding(D7, { record: Object.assign({}, rec, { flights: [{ log: 4, t0: 12.5, t1: 19 }, { log: 4, t0: 41, t1: 140.25 }] }) });
    assert.deepEqual(ev.spans.map(q => [q.t0, q.t1, q.label, q.phase]), [[41, 140.25, 'Flight', 'flight'], [12.5, 19, 'Flight', 'idle']], 'frame seconds as they are, not converted again');
    assert.deepEqual(ev.plot.rows.map(r => r.key), ['Flights', 'IDLE', 'Spool-up', 'Ground', 'Flight', 'Spool-down']); assert.equal(ev.plot.rows[0].value, '1');
    within(parseFloat(ev.plot.rows.find(r => r.key === 'Ground').value), frameOf(w, 40000) - frameOf(w, 30000) + frameOf(w, 160000) - frameOf(w, 150000), 0.11, 'ground seconds');
    assert.equal(ev.summary, 'The log has 1 flight of 110 s. The attitude checks use only the flight time.');
    ev = E.forFinding(D7, { record: rec });
    assert.deepEqual(ev.spans.map(q => q.phase), ['flight'], 'the flight phase of the record'); within(ev.spans[0].t0, frameOf(w, 40000), 2e-3, 'flight start');
    ev = E.forFinding(D7, { record: Object.assign({}, base, { metrics: {} }) });
    within(ev.spans[0].t0, frameOf(w, 40000), 2e-3, 'the flights of the finding: index time to frame seconds'); within(ev.spans[0].t1, frameOf(w, 150000), 2e-3, 'flight end');
    assert.ok(Math.abs(ev.spans[0].t1 - at(150000)) > 0.05, 'not the index time');
    ev = E.forFinding({ fid: 'd7b', id: 'D7', severity: 'note', log: 4, profile: null, unit: 's', value: 0, flights: 0, text: '', phaseSeconds: { idle: 8.1 } }, { record: Object.assign({}, base, { metrics: {} }) });
    assert.deepEqual([ev.spans, ev.plot.rows, ev.summary, ev.expected], [[], [{ key: 'Flights', value: '0' }, { key: 'IDLE', value: '8.1 s' }], 'The log has no flight. Thus, the analysis does not use this log.', null]);
    assert.equal(ev.view.t0, +frameOf(w, 0).toFixed(3), 'a bench run shows the whole log');
    // the new checks: events of the finding (index time, converted), events of the module metrics, worst blocks, times
    const G17 = { fid: 'g17', id: 'G17', severity: 'flag', log: 4, profile: 1, unit: 'count', value: 2, phase: 'idle', text: '', events: [{ t: at(5000), value: 80 }, { t: at(12000), value: 160, seconds: 0.2 }] };
    ev = E.forFinding(G17, { record: rec });
    assert.deepEqual(ev.spans.map(q => q.value), [160, 80]); within(ev.spans[0].t0, frameOf(w, 12000) - 0.5, 2e-3, 'G17 pad'); within(ev.spans[0].t1, frameOf(w, 12200) + 0.5, 3e-3, 'G17 end');
    assert.deepEqual([ev.spans[0].phase, ev.phase, ev.spans[0].label], ['idle', 'idle', 'Sudden motor steps']);
    assert.deepEqual(ev.view.graphs, [['motor[0]', 'govSum'], ['headspeed', 'govTarget']]);
    const metr = Object.assign({}, rec, { metrics: { phase: { spans: indexSpans, G15: { events: [{ t: at(21000), value: 41, profile: 1, seconds: 8 }, { t: at(25000), value: 12, profile: 2 }] }, C15: { worst: [{ t0: at(31000), t1: at(33000), value: 106, axis: 'roll', profile: 1 }, { t0: at(36000), t1: at(37000), value: 20, axis: 'pitch', profile: 1 }] } } } });
    ev = E.forFinding({ fid: 'g15', id: 'G15', severity: 'note', log: 4, profile: 1, unit: 'deg/s', value: 41, text: '' }, { record: metr });
    assert.deepEqual(ev.spans.map(q => [q.value, q.phase]), [[41, 'spoolup']], 'the events of its profile in rec.metrics.phase.G15');
    ev = E.forFinding({ fid: 'c15', id: 'C15', severity: 'flag', log: 4, profile: 1, axis: 'roll', unit: 'deg/s', value: 106, text: '' }, { record: metr });
    assert.deepEqual(ev.spans.map(q => [q.value, q.phase]), [[106, 'ground']], 'the worst blocks of its axis'); assert.equal(ev.view.analyser, 'gyroADC[0]');
    ev = E.forFinding({ fid: 'g18', id: 'G18', severity: 'note', log: 4, profile: 1, unit: 'fraction', value: 0.01, text: '', times: [at(9000)] }, { record: rec });
    assert.deepEqual(ev.spans.map(q => q.phase), ['idle']); within(ev.spans[0].t0, frameOf(w, 9000), 2e-3, 'a time of the finding');
    // D2 labels in STE
    const D2 = { id: 'D2', severity: 'note', log: 4, value: 1, text: '', events: [{ t: at(1000), value: 3, kind: 'time jump' }, { t: at(90000), value: 2, kind: 'loopIteration jump' }] };
    assert.deepEqual(E.forFinding(D2, { record: rec }).spans.map(q => q.label).sort(), ['Loop count change', 'Sudden time change']);
});

// ---------------------------------------------------------------------------------------------
// A simulated flight through the decoder and the modules: locate equals the module counts
// ---------------------------------------------------------------------------------------------

const simulated = (() => { let v = null; return () => v || (v = (() => {
    const flight = bbl.simulateFlight({ seconds: 90, seed: 5, airborne: [6, 84], profiles: [{ from: 0, profile: 1, target: 2500 }, { from: 40, profile: 2, target: 2700 }], rescue: [60, 63],
        clock: { periods: [[0, 987.4], [80000, 1011.2]], stalls: [[33000, 26000]] } });
    const file = path.join(tmp, 'sim.bbl'); fs.writeFileSync(file, bbl.encode([flight]).bytes);
    const app = lib.loadApp(), [w] = [...lib.segments(app, file, { whole: true, extra: EXTRA })].filter(q => !q.skipped);
    return Object.assign({ w, app, file }, analyse(app, w));
})()); })();

test('locate: on a simulated flight the counts equal the modules\' (G2, G9, G11, D5, C8, C10, C11, F5) and the spans lie in the segment', () => {
    const { w, rec, flown } = simulated(), L = rec.metrics.locate, want = moduleCounts(rec.metrics);
    assert.ok(flown);
    assert.deepEqual(L.errors, []); assert.deepEqual(L.mismatch, []);
    for (const k of Object.keys(want)) assert.deepEqual(L.counts[k], want[k], k);
    assert.ok(['G2', 'G9', 'G11', 'C8', 'C10', 'C11', 'F5'].every(k => L.counts[k] !== undefined), `every group is located: ${Object.keys(L.counts)}`);
    assert.ok(Object.values(L.counts.G2).some(v => v > 0) && L.counts.G11 > 0 && Object.values(L.counts.F5).some(v => v > 0), JSON.stringify(L.counts));
    const end = w.fromS + w.n / w.flight.actualRate;
    for (const k of ['G2', 'G9', 'G11', 'C8', 'C10', 'C11', 'F5', 'D5']) for (const q of L[k]) assert.ok(q.t0 >= w.fromS - 1e-3 && q.t1 <= end + 1e-3 && q.t1 >= q.t0, `${k} ${q.t0}-${q.t1}`);
    assert.equal(L.n, w.n);
    // G2 spans: the blocks of the profile with the largest |median error| first
    for (const p of Object.keys(L.counts.G2)) { const s = L.G2.filter(q => String(q.profile) === p).map(q => Math.abs(q.value)); assert.deepEqual(s, s.slice().sort((x, y) => y - x)); }
});

test('locate: a count that is not the module\'s drops the spans of that group', () => {
    const { w, ctx, rec } = simulated(), m = JSON.parse(JSON.stringify(rec.metrics, (k, v) => ArrayBuffer.isView(v) ? Array.from(v) : v)), p = Object.keys(m.gov.G2.byProfile)[0];
    m.gov.G2.byProfile[p].blocks += 1; m.loop.C11.pitch = m.loop.C11.pitch.skipped ? m.loop.C11.pitch : Object.assign(m.loop.C11.pitch, { byProfile: Object.assign({}, m.loop.C11.pitch.byProfile, { 9: { windows: 4 } }) });
    const L = E.locate(w, ctx, m);
    assert.ok(L.mismatch.some(q => q.id === 'G2' && q.key === p), JSON.stringify(L.mismatch));
    assert.deepEqual(L.G2, []); assert.ok(L.G11.length > 0, 'the other groups keep their spans');
    // without the module metrics, nothing is located and nothing throws
    assert.deepEqual(E.locate(w, ctx, {}).counts, {});
    assert.deepEqual(E.locate(w, ctx, { gov: null, loop: { skipped: 'x' }, setup: { F5: { skipped: 'x' } } }).errors, []);
});

test('forFinding: every finding of the simulated flight, the worker\'s context; STE summaries; frame seconds in the segment', () => {
    const { w, rec } = simulated(), findings = [];
    for (const [k, m] of Object.entries(M)) for (const f of m.judge([{ log: rec.log, start: rec.start, header: rec.header, metrics: rec.metrics[k] }], m.DEFAULT_RULES)) findings.push(Object.assign({ module: k, fid: `${k}|${f.id}|${findings.length}` }, f));
    assert.ok(findings.length > 100);
    const lo = E.toFrame(rec.timeMap, w.fromS), hi = E.toFrame(rec.timeMap, w.fromS + w.n / w.flight.actualRate), ids = new Set();
    let spans = 0;
    for (const f of findings) {
        const ev = E.forFinding(f, { record: rec, others: { [rec.log]: [rec] }, findings });
        if (f.severity === 'skipped' || f.severity === 'error' || !C.CHECKS[f.id]) { assert.equal(ev, null, f.fid); continue; }
        ids.add(f.id);
        assert.equal(ev.fid, f.fid); assert.ok(ev.spans.length <= 3);
        for (const s of ev.spans) { assert.ok(s.t0 >= lo - 1e-3 && s.t1 <= hi + 1e-3 && s.t0 <= s.t1, `${f.fid}: ${s.t0}-${s.t1} in ${lo}-${hi}`); assert.equal(s.log, rec.log); spans++; }
        const header = C.CHECKS[f.id].evidence.source === 'header';
        assert.equal(ev.view === null, header, `${f.fid}: view`); assert.equal(ev.plot.kind === 'table', header || ev.plot.kind === 'table', f.fid);
        if (ev.view) assert.ok(ev.view.graphs.length && ev.view.graphs.every(g => g.every(k => !/[{}]/.test(k))), f.fid);
        assert.ok(typeof ev.summary === 'string' && ev.summary.split('\n').every(p => /^[A-Z0-9−].*\.$/.test(p)) && !/;|\+-|undefined|NaN|null/.test(ev.summary), `${f.fid}: ${ev.summary}`);
        assert.ok(typeof ev.plot.caption === 'string' && /^The (curve|curves|points|table) /.test(ev.plot.caption) && /\.$/.test(ev.plot.caption) && ev.plot.caption.split(/(?<=\.)\s+/).length === 1, `${f.fid}: caption ${ev.plot.caption}`);
        assert.ok(JSON.stringify(ev).length < 20000, `${f.fid}: compact`);
    }
    assert.ok(spans > 50, `${spans} spans`);
    for (const id of ['D1', 'D2', 'G2', 'G9', 'G11', 'C8', 'C10', 'C11', 'C12', 'F5', 'F6', 'T8', 'C5']) assert.ok(ids.has(id), id);
});

test('health_phase.cjs (when it loads): its findings on the simulated flight get STE summaries and spans with their phase (SPEC2 D13)', (t) => {
    let PH = null; try { PH = require('../tools/autotune/health_phase.cjs'); } catch (e) { t.skip(`health_phase.cjs does not load: ${e.message}`); return; }
    const { w, ctx, rec } = simulated(), m = PH.analyse(w, Object.assign({}, ctx)), r = Object.assign({}, rec, { metrics: Object.assign({}, rec.metrics, { phase: m }) });
    const F = PH.judge([{ log: r.log, start: r.start, header: r.header, metrics: m }], PH.DEFAULT_RULES).map((f, i) => Object.assign({ module: 'phase', fid: `phase|${f.id}|${i}` }, f));
    assert.deepEqual([...new Set(F.map(f => f.id))].sort(), ['C15', 'D7', 'G15', 'G16', 'G17', 'G18']);
    const lo = E.toFrame(r.timeMap, w.fromS), hi = E.toFrame(r.timeMap, w.fromS + w.n / w.flight.actualRate);
    for (const f of F) {
        const ev = E.forFinding(f, { record: r, findings: F });
        if (f.severity === 'skipped' || f.severity === 'error') { assert.equal(ev, null, f.fid); continue; }
        assert.ok(ev.summary.split('\n').every(p => /^[A-Z].*\.$/.test(p)) && !/\b(null|undefined|NaN)\b|;|\+-/i.test(ev.summary), `${f.fid}: ${ev.summary}`);
        assert.ok(ev.phase === null || E.PHASES.includes(ev.phase), `${f.fid}: phase ${ev.phase}`);
        for (const q of ev.spans) { assert.ok(E.PHASES.includes(q.phase), `${f.fid}: span phase ${q.phase}`); assert.ok(q.t0 >= lo - 1e-3 && q.t1 <= hi + 1e-3, `${f.fid}: ${q.t0}-${q.t1}`); }
    }
    // the flight of the simulation is airborne from 6 s to 84 s: D7 shows it in frame seconds, as a flight
    const d7 = E.forFinding(F.find(f => f.id === 'D7'), { record: r, findings: F });
    assert.equal(d7.spans.length, 1); assert.equal(d7.spans[0].phase, 'flight'); assert.ok(d7.spans[0].t0 > 4 && d7.spans[0].t0 < 10 && d7.spans[0].t1 > 78 && d7.spans[0].t1 < 86, JSON.stringify(d7.spans));
    assert.equal(d7.plot.kind, 'table'); assert.ok(d7.plot.rows.some(q => q.key === 'Flight'));
    // and the spans of the other checks of the record get the phase of the time they cover
    const T = E.forFinding({ id: 'C12', severity: 'note', module: 'track', fid: 'c12', log: r.log, profile: 2, axis: 'roll', value: 0.2, se: 0.02, n: 4, text: '' }, { record: r });
    assert.ok(T.spans.length > 0, 'C12 has its worst blocks'); for (const q of T.spans) assert.equal(q.phase, 'flight', 'C12 blocks are in flight');
});

// ---------------------------------------------------------------------------------------------
// Real logs (opt-in): parity of every count with the modules
// ---------------------------------------------------------------------------------------------

const REAL = process.env.AUTOTUNE_REAL_LOG || '';
const ENTRIES = (() => { const list = [];
    if (REAL && fs.existsSync(REAL)) list.push({ file: REAL, rpm: 2000, logs: [50, 58] });
    if (process.env.AUTOTUNE_EVIDENCE_LOGS) for (const o of JSON.parse(process.env.AUTOTUNE_EVIDENCE_LOGS)) if (fs.existsSync(o.file)) list.push(o);
    return list; })();
for (const o of ENTRIES) test(`locate parity on ${path.basename(o.file)}${o.logs ? ` logs ${o.logs.join(', ')}` : ''} at ${o.rpm} rpm (real log)`, () => {
    const r = spawnSync(process.execPath, ['--max-old-space-size=8000', __filename], { env: Object.assign({}, process.env, { EVIDENCE_PARITY_CHILD: JSON.stringify(o), AUTOTUNE_FLIGHT_RPM: String(o.rpm) }), encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(out.length >= 1, 'a flown log');
    for (const q of out) {
        assert.deepEqual(q.errors, [], `log ${q.log}`); assert.deepEqual(q.mismatch, [], `log ${q.log}`);
        for (const k of Object.keys(q.module)) assert.deepEqual(q.counts[k], q.module[k], `log ${q.log} ${k}`);
        assert.ok(q.spans.G2 > 0 && q.spans.C11 + q.spans.C10 > 0, `log ${q.log}: spans ${JSON.stringify(q.spans)}`);
    }
});
