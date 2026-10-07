// The Analysis view (js/analysis_view.js): the verdict of the analysis, with the pieces of js/log_lens.js that it shares,
// in node:vm with stand-ins for the DOM, the timers, TuningPlot, TuningSnippet.Reader and the hooks of js/main.js. From
// synthetic TuningResults with known findings: the summary, the area cards with status, value, limit and PID profile, the
// flights and bench runs, "Show in the log" and "Show the measurement", the no-result state with "Start the analysis",
// escaping; the words and units agree with tools/autotune/catalog.cjs; the upstream Flight analysis files are the files of
// HEAD and are not used; the script is registered in index.html (and gulpfile.js).
// test/ste_text.test.cjs runs these tests again to read every text that the view writes: the containers come from the
// stand-in document, so that the lint reads what the view writes into them.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const HOSTILE = '<img src=x onerror=alert(1)>"\'&';
const RATE = 1000, LEN = 300;
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const eq = (got, want, what) => assert.deepEqual(JSON.parse(JSON.stringify(got)), want, what); // objects of the vm realm

// --- stand-ins -------------------------------------------------------------------------------------------------

// One stand-in element for each selector (the view and the lens use unique selectors); it records what is written
function fakeDom() {
    const parts = new Map(), doc = {};
    function context() {
        const ctx = { calls: [], texts: [] };
        for (const m of ['fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'setTransform', 'clearRect', 'save', 'restore']) ctx[m] = () => {};
        ctx.fillText = (s) => ctx.texts.push(String(s));
        return ctx;
    }
    function element(sel) {
        const listeners = {}, ctx = context();
        return { sel, innerHTML: '', textContent: '', listeners, ctx, width: 0, height: 0, clientWidth: 800, clientHeight: 104, firstChild: { focus() {} }, scrolled: 0, scrollIntoView() { this.scrolled++; },
            querySelector: (s) => part(s), getContext: () => ctx,
            addEventListener(type, fn, opts) { (listeners[type] = listeners[type] || []).push({ fn, opts }); },
            removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((l) => l.fn !== fn); },
            getBoundingClientRect() { return { left: 10, top: 20, width: this.clientWidth, height: this.clientHeight }; } };
    }
    function part(sel) {
        if (!parts.has(sel)) parts.set(sel, element(sel));
        return parts.get(sel);
    }
    const document = {
        getElementById: (id) => part('#' + id),
        addEventListener(type, fn) { (doc[type] = doc[type] || []).push(fn); },
        removeEventListener(type, fn) { doc[type] = (doc[type] || []).filter((f) => f !== fn); },
    };
    return { part, parts, document };
}

function fakeClock() {
    let now = 0, seq = 0;
    const list = [];
    return {
        setTimeout: (fn, ms) => { const id = ++seq; list.push({ id, at: now + (ms || 0), fn }); return id; },
        clearTimeout: (id) => { const i = list.findIndex((t) => t.id === id); if (i >= 0) list.splice(i, 1); },
        tick(ms) {
            const end = now + ms;
            for (;;) {
                list.sort((a, b) => a.at - b.at || a.id - b.id);
                if (!list.length || list[0].at > end) break;
                const t = list.shift();
                now = t.at;
                t.fn();
            }
            now = end;
        },
    };
}

// One log of LEN s that starts at 100 s; PID profile 1, throttle 600 permille
function fakeLog() {
    const tMin = 100e6, times = [], avgThrottle = [], pidProfile = [];
    for (let k = 0; k * 0.128 <= LEN; k++) { times.push(tMin + k * 0.128e6); avgThrottle.push(600); pidProfile.push(1); }
    return { tMin, getLogCount: () => 3, getLogIndex: () => 0, getLogError: () => false, getMinTime: () => tMin, getMaxTime: () => tMin + LEN * 1e6,
        getMainFieldIndexByName: (n) => (/^(setpoint|gyroADC|headspeed|govTarget|mixer)/.test(n) ? 1 : undefined),
        getActivitySummary: () => ({ times, avgThrottle, collective: [], hasEvent: [], pidProfile }), getSysConfig: () => ({}) };
}

// What js/tuning_worker.js present() writes on each finding from catalog.cjs: status, noun, display
const catalog = require('../tools/autotune/catalog.cjs');
function present(f) {
    const c = catalog.CHECKS[f.id], v = catalog.format(f);
    return Object.assign(f, { status: catalog.status(f), noun: c ? c.noun : null,
        display: { value: v.value, unit: v.unit, scale: v.scale, limit: null, profile: v.profile, phase: v.phase } });
}

// A result of log 0 with known findings in each area (frame seconds). The values: catalog.cjs format() gives the text
function synthResult(over = {}) {
    const ev = (fid, o = {}) => Object.assign({ v: 1, fid, spans: [], view: null, plot: null, expected: '', summary: '', context: [] }, o);
    const span = (t0, t1) => ({ log: 0, t0, t1, value: null, label: '' });
    const hl = (value, unit) => ({ kind: 'hline', value, label: `Limit ${value} ${unit}`, unit });
    const f = (o) => present(Object.assign({ module: 'track', log: 0, profile: 1, se: null, n: 10, threshold: null, text: 'toolkit text of ' + o.id, summary: `Summary of ${o.id}.` }, o,
        { evidence: ev(o.fid, o.ev || {}) }));
    const findings = [
        f({ fid: 'g2', id: 'G2', module: 'gov', severity: 'ok', value: 0.0021, se: 0.0002, ev: { spans: [span(40, 42)], plot: { kind: 'governor', curve: 'more.gov', reference: [hl(1, '%'), hl(-1, '%'), hl(2, '%'), hl(-2, '%')] } } }),
        f({ fid: 'g3', id: 'G3', module: 'gov', severity: 'flag', profile: 2, value: 0.062, se: 0.004, summary: 'The headspeed decreases by 6.2 ± 0.4 %.', area: 'governor', node: 'governor', tuner: true,
            ev: { spans: [span(50, 51)], view: { log: 0, t0: 49.5, t1: 51.5, at: 50.4, graphs: [['headspeed', 'govTarget'], ['setpoint[3]']], analyser: null },
                plot: { kind: 'governor', curve: 'more.gov', reference: [hl(-5, '%'), hl(-3, '%')] } } }),
        f({ fid: 'g6', id: 'G6', module: 'gov', severity: 'ok', value: 55.1, ev: { plot: { kind: 'governor', reference: [hl(85, '%')] } } }),
        f({ fid: 'g17', id: 'G17', module: 'phase', severity: 'flag', profile: 0, phase: 'spoolup', value: null, threshold: 'step >= 200 rpm', ev: { spans: [span(8, 9)] } }),
        f({ fid: 'd5', id: 'D5', module: 'setup', severity: 'note', profile: null, value: 0, area: 'power', node: 'power', tuner: false, threshold: { step: 1, minCell: 3, source: 'x' }, ev: { plot: { kind: 'time', reference: [hl(3, 'V')] } } }),
        f({ fid: 'g13', id: 'G13', module: 'gov', severity: 'note', profile: null, thin: true, value: null }),
        f({ fid: 'f5', id: 'F5', module: 'setup', severity: 'flag', value: 4.06, node: 'filters', tuner: true, threshold: 'prominence >= 5 with no notch within 2 %', ev: { spans: [span(60, 66)], plot: { kind: 'spectrum', reference: [{ kind: 'vline', value: 156, label: '156 Hz', unit: 'Hz' }] } } }),
        ...[1, 2, 3, 4].map((p) => f({ fid: 'f6' + p, id: 'F6', module: 'more', severity: 'ok', profile: p, value: 40 + p, se: 0.5, ev: { plot: { kind: 'events', reference: [hl(10, 'dB')] } } })),
        f({ fid: 'f2', id: 'F2', module: 'setup', severity: 'ok', profile: null, value: 100, ev: { plot: { kind: 'table', rows: [{ key: 'gyro_lowpass_hz', value: '100' }] } } }),
        f({ fid: 'c12', id: 'C12', axis: 'roll', severity: 'flag', value: 0.52, se: 0.03, unit: 'fraction', summary: 'In PID profile 1, the roll tracking error is 52 ± 3 % of the setpoint.', area: 'cyclic', node: 'cyclic', tuner: true,
            ev: { spans: [span(5, 12)], view: { log: 0, t0: 4.5, t1: 12.5, at: 8, graphs: [['setpoint[0]', 'gyroADC[0]'], ['axisError[0]']], analyser: null },
                plot: { kind: 'time', curve: 'track.roll.time', reference: [hl(45, '%'), hl(30, '%')], caption: 'The plot shows the tracking error as a percentage of the setpoint. The lines at 30 % and 45 % are the limits of `C12`.' },
                expected: 'The gyro follows the setpoint.' } }),
        f({ fid: 'c13', id: 'C13', axis: 'roll', severity: 'note', value: 32.3, se: 1.1, unit: 'ms', ev: { plot: { kind: 'phase', reference: [hl(120, 'ms')] } } }),
        f({ fid: 'c5', id: 'C5', axis: 'pitch', severity: 'note', profile: 0, value: 0.08, se: 0.01, unit: 'fraction' }),
        f({ fid: 'c15', id: 'C15', module: 'phase', axis: 'roll', severity: 'flag', phase: 'ground', value: 25 }),
        f({ fid: 'c10', id: 'C10', axis: 'roll', severity: 'error', value: null, text: 'The analysis of "health_loop.cjs" stopped.' }),
        f({ fid: 'r1', id: 'R1', axis: 'yaw', severity: 'note', profile: null, value: 2.01, se: 0.31, unit: 'ms' }),
        f({ fid: 't8', id: 'T8', module: 'loop', severity: 'flag', value: 3.8, area: 'tail', node: 'mechanics', tuner: false, threshold: '>= 1 episode', ev: { spans: [span(115.59, 116.97)], plot: { kind: 'time', curve: 'more.tail', reference: [] } } }),
        f({ fid: 'd1', id: 'D1', module: 'setup', severity: 'flag', profile: null, value: 500, ev: { plot: { kind: 'table', rows: [{ key: 'looptime', value: '500' }] } } }),
        // a severe battery sag (health_power.cjs, SPEC3 I): a hardware item of the area "power", with what to examine
        Object.assign(f({ fid: 'b1', id: 'P1', module: 'power', severity: 'flag', profile: null, value: 3.21, area: 'power', node: 'power', tuner: false,
            summary: 'In flight 2, the cell voltage decreases to 3.21 V at a high load. This is possibly a weak battery.' }), { noun: 'cell voltage in flight', status: 'problem',
            display: { value: '3.21 V', bound: '3.40 V or more', unit: 'V' } }),
    ];
    const advice = { recommendations: [
        { id: 'G3:gov_f_gain', severity: 'action', title: 'Increase the governor F gain', node: 'governor', evidence: [{ fid: 'g3', id: 'G3' }] },
        { id: 'P1:battery', severity: 'check', title: 'Examine the battery pack. If a cell is damaged, replace the battery.', node: 'power', evidence: [{ fid: 'b1', id: 'P1' }] },
        { id: 'F5:info', severity: 'info', title: 'Information for the filters', node: 'filters', evidence: [{ fid: 'f5', id: 'F5' }] }] };
    const t = Float32Array.from({ length: LEN * 10 }, (_, i) => i / 10);
    const curves = [{ log: 0, segment: 0, fromS: 0, seconds: LEN, more: { gov: { t, hs: Float32Array.from(t, () => 2000), target: Float32Array.from(t, () => 2000), profile: Uint8Array.from(t, () => 1) } },
        track: { roll: { time: { t, sp: Float32Array.from(t, () => 50), err: Float32Array.from(t, () => 27), errComp: Float32Array.from(t, () => 26) } } } }];
    const records = [{ log: 0, segment: 0, fromS: 0, seconds: LEN, actualRate: RATE, flyingS: 210, timeMap: null,
        phases: { flight: true, spans: [{ phase: 'ground', t0: 0, t1: 30 }, { phase: 'flight', t0: 30, t1: 120 }, { phase: 'ground', t0: 120, t1: 130 }, { phase: 'flight', t0: 130, t1: 250 }] } }];
    // hierarchy.cjs (SPEC3 K1): the items before the first flight and the tuning steps; "Start here" has steps only
    const hierarchy = { nodes: { filters: { status: 'startHere', number: 1 }, governor: { status: 'startHere', number: 2 }, rescue: { status: 'problem' }, power: { status: 'problem' } },
        startHere: ['governor', 'filters', 'rescue'], prereqProblems: ['rescue', 'power'],
        graph: { prereq: [{ id: 'rescue', title: 'Rescue', checks: ['D9'] }, { id: 'power', title: 'Battery and power', checks: ['D5', 'P1'] }, { id: 'mechanics', title: 'Mechanical parts', checks: ['T8'] }],
            blocks: [{ id: 'filters', title: 'Filters', lane: 'main', order: 1 }, { id: 'governor', title: 'Governor', lane: 'main', order: 2 }, { id: 'cyclic', title: 'Cyclic gains', lane: 'cyclic', order: 3 }],
            edges: [] } };
    return Object.assign({ version: 1, scope: 'log', fileName: 'flight.bbl', logIndex: 0, logs: [0], timing: { totalS: 12.46 }, findings, curves, records, hierarchy, advice }, over);
}

// The view over a fake viewer: AnalysisView(#viewAnalysis) with the hooks of js/main.js. opts: result, runAnalysis,
// fileName (of the open file), noLens, noTuningDialog (the scripts that are not loaded)
function setup(opts = {}) {
    const dom = fakeDom(), clock = fakeClock(), plots = [], reads = [], derives = [];
    const log = fakeLog();
    let current = opts.result === undefined ? null : opts.result;
    const calls = { viewInLog: [], runAnalysis: 0, openTuning: 0, tune: [], onResult: [] };
    function Reader() {}
    Reader.prototype.read = function (li, t0, t1, fields) {
        reads.push({ li, t0, t1, fields: [...fields] });
        const n = Math.floor((t1 - t0) * RATE) + 1, t = Float64Array.from({ length: n }, (_, i) => t0 + i / RATE), cols = {};
        for (const name of fields) cols[name] = new Float32Array(n);
        return Promise.resolve({ t, cols, missing: [], rate: RATE, frames: n });
    };
    const context = vm.createContext({
        document: dom.document, devicePixelRatio: 1, console: { log() {}, warn() {}, error() {} },
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        ResizeObserver: class { observe() {} disconnect() {} },
        TuningSnippet: { Reader, CALL_S: 12, MAX_S: 60 },
    });
    vm.runInContext(read('js/tuning_plot.js'), context, { filename: 'js/tuning_plot.js' });
    context.TuningPlot.attach = (canvas, spec) => {
        const h = { canvas, spec, destroyed: false, update(s) { h.spec = s; }, destroy() { h.destroyed = true; } };
        plots.push(h);
        return h;
    };
    if (!opts.noTuningDialog) vm.runInContext(read('js/tuning_dialog.js'), context, { filename: 'js/tuning_dialog.js' });
    if (!opts.noLens) vm.runInContext(read('js/log_lens.js'), context, { filename: 'js/log_lens.js' });
    vm.runInContext(read('js/analysis_view.js'), context, { filename: 'js/analysis_view.js' });
    const hooks = {
        viewInLog: (req) => { calls.viewInLog.push(req); return true; },
        getBytes: () => new Uint8Array(10), getFileName: () => opts.fileName || 'flight.bbl', getCurrentLogIndex: () => 0, getFlightLog: () => log,
        runAnalysis: () => { calls.runAnalysis++; return opts.runAnalysis ? opts.runAnalysis() : true; },
        getResult: () => current, onResult: (cb) => calls.onResult.push(cb),
        derive: (kind, cols, rate, params) => { derives.push({ kind, cols, rate, params }); return Promise.resolve(kind === 'window' ? { items: [], notes: [] } : { kind, rate, cols }); },
        openTuning: (target) => { calls.openTuning++; if (target) calls.tune.push(JSON.parse(JSON.stringify(target))); },
    };
    Object.assign(hooks, opts.hooks || {}); // more hooks of js/main.js for a test (the "Logs" control)
    const root = context.document.getElementById('viewAnalysis'); // through the document: test/ste_text.test.cjs reads what goes into it
    const view = new context.AnalysisView(root, hooks);
    const verdict = () => dom.part('#analysisVerdictBody').innerHTML;
    const target = (act, attrs) => ({ closest: (sel) => (sel === '[data-analysis-act]' && act ? { getAttribute: (k) => (k === 'data-analysis-act' ? act : k in attrs ? String(attrs[k]) : null) } :
        sel === 'summary' && (attrs.more || attrs.rows) ? { parentNode: { open: !!attrs.open, getAttribute: (k) => (k === 'data-analysis-more' ? attrs.more || null : k === 'data-analysis-rows' ? attrs.rows || null : null) } } : null) });
    return {
        context, dom, clock, view, hooks, calls, plots, reads, derives, log, verdict, I: context.AnalysisView.internals,
        give(r) { current = r; for (const cb of calls.onResult) cb(r); },
        click(act, attrs = {}) {
            const ev = { target: target(act, attrs), prevented: false, preventDefault() { this.prevented = true; } };
            for (const l of dom.part('#analysisVerdictBody').listeners.click || []) l.fn(ev);
            return ev;
        },
        rowId(fid) { // the row id of a finding, from the rendered page
            const rows = view.verdict.internals.rows(), o = rows.find((q) => q.f.fid === fid);
            return o && o.id;
        },
    };
}

async function shown(opts) {
    const app = setup(opts);
    app.view.show(app.log);
    await flush();
    return app;
}

// --- tests ----------------------------------------------------------------------------------------------------

test('the noun, the value and the unit of a result are the texts that the worker writes (noun, display); the view has no copy of the catalog', () => {
    const I = setup().I, bad = [];
    assert.equal(I.CHECKS, undefined, 'no table of the checks in js/analysis_view.js');
    // every check id: the noun and the value of the worker, which are those of the catalog summary
    const values = [[0, null], [0.0021, 0.0002], [0.52, 0.03], [32.33, 1.12], [4.0627, null], [-0.1984, 0.0047], [303, 42], [0.000123, 0.00005]];
    for (const id of Object.keys(catalog.CHECKS)) {
        for (const [value, se] of values) {
            for (const v of [{ severity: 'note' }, { severity: 'flag' }, { severity: 'ok', unit: 'permille', axis: 'roll' }, { severity: 'note', unit: 'fraction', axis: 'yaw' }]) {
                const f = present(Object.assign({ id, value, se }, v)), want = catalog.format(f);
                if (I.valueText(f) !== want.value) bad.push(`${id} ${JSON.stringify(v)}: view "${I.valueText(f)}", catalog "${want.value}"`);
                if (I.unitOf(f) !== want.unit) bad.push(`${id}: unit "${I.unitOf(f)}", catalog "${want.unit}"`);
                if (I.nounOf(f) !== catalog.CHECKS[id].noun) bad.push(`${id}: noun "${I.nounOf(f)}"`);
            }
        }
    }
    assert.deepEqual(bad.slice(0, 20), []);
    // a value of the worker wins over the raw value; a display with no value: no value
    assert.equal(I.valueText({ id: 'C12', value: 0.5, unit: 'fraction', display: { value: '52 ± 3 %', unit: '%' } }), '52 ± 3 %');
    assert.equal(I.valueText({ id: 'C12', value: 0.5, display: { value: null, unit: '%' } }), null);
    assert.equal(I.valueText({ id: 'C12', value: null }), null);
    // a result without the texts of the worker (no catalog.cjs in it): the raw value with its unit, a fraction as %, and no noun
    assert.equal(I.valueText({ id: 'NEW', value: 0.25, unit: 'fraction' }), '25 %');
    assert.equal(I.unitOf({ id: 'NEW', unit: 'fraction' }), '%');
    assert.equal(I.nounOf({ id: 'C12' }), '');
    const r = synthResult();
    r.findings.forEach((f) => { delete f.noun; delete f.display; });
    const h = I.verdictHtml(r, { li: 0 });
    assert.ok(h.includes('<span class="analysis-what"><span class="analysis-where">C12, roll, PID profile 1</span></span>'), 'no noun: the check id');
    assert.ok(h.includes('<span class="analysis-value" title="Value">52.0 ± 3.0 %</span>'), 'the raw value with its unit');
});

test('the limit of a result: the limit lines of its evidence plot in the unit of its value, else the threshold in code font', () => {
    const I = setup().I, r = synthResult(), lim = (fid) => JSON.parse(JSON.stringify(I.limitOf(r.findings.find((f) => f.fid === fid))));
    eq(lim('c12'), { text: '30 % and 45 %', code: false });
    eq(lim('g2'), { text: '±1 % and ±2 %', code: false }, 'a line at +v and -v is ±v');
    eq(lim('g3'), { text: '−3 % and −5 %', code: false });
    eq(lim('d5'), { text: '3 V', code: false });
    eq(lim('f5'), { text: 'prominence >= 5 with no notch within 2 %', code: true }, 'a line in Hz is not the limit of a value in x');
    eq(lim('g13'), null);
    eq(I.limitOf(present({ id: 'G5', value: 0.07, evidence: { plot: { reference: [{ kind: 'band', from: -1, to: 1, label: 'Target ±1 %', unit: '%' }] } } })), null,
        'G5 is in s: a band in % is not its limit');
    eq(JSON.parse(JSON.stringify(I.limitOf(present({ id: 'G16', value: 0.07, evidence: { plot: { reference: [{ kind: 'band', from: -1, to: 1, label: 'Target ±1 %', unit: '%' }] } } })))),
        { text: 'Target ±1 %', code: false }, 'a band in the unit of the value (the display unit of the worker): its label');
});

test('the limit of a result is the worker\'s display.bound first: the same in log and file scope (T13 plot lines in ‰ in file scope)', () => {
    const I = setup().I;
    const t13 = (refs, display) => Object.assign(present({ id: 'T13', value: -0.212, se: 0.016, unit: 'fraction', threshold: '|I share| - 2 SE > 0.15', evidence: { plot: { reference: refs } } }),
        { display }); // the worker's display (present() writes one without a bound)
    const disp = { value: '−21.2 ± 1.6 %', unit: '%', scale: 100, limit: 'The limit is ±15 % (2 SE test).', bound: '±15 % (2 SE test)', profile: 'PID profile 1', phase: 'in flight' };
    const log = [{ kind: 'hline', value: 15, unit: '%' }, { kind: 'hline', value: -15, unit: '%' }], file = [{ kind: 'hline', value: 187.5, unit: '‰' }, { kind: 'hline', value: -187.5, unit: '‰' }];
    eq(JSON.parse(JSON.stringify(I.limitOf(t13(log, disp)))), { text: '±15 % (2 SE test)', code: false }, 'log scope');
    eq(JSON.parse(JSON.stringify(I.limitOf(t13(file, disp)))), { text: '±15 % (2 SE test)', code: false }, 'file scope: the same');
    eq(JSON.parse(JSON.stringify(I.limitOf(t13(file, Object.assign({}, disp, { bound: null }))))), { text: 'The limit is ±15 % (2 SE test)', code: false }, 'no bound: the limit sentence');
    // a limit of two sentences keeps its last period (STE: each sentence ends with a period; the real G7, C8 and F10 results)
    eq(JSON.parse(JSON.stringify(I.limitOf(t13(file, Object.assign({}, disp, { bound: null, limit: 'This check gives information only. It has no limit.' }))))),
        { text: 'This check gives information only. It has no limit.', code: false }, 'two sentences: the period stays');
    eq(JSON.parse(JSON.stringify(I.limitOf(t13(file, undefined)))), { text: '|I share| - 2 SE > 0.15', code: true }, 'no display: the toolkit threshold, in code font');
    // G10: the raw RULES object of the toolkit is not the limit
    const g10 = Object.assign(present({ id: 'G10', value: 0.235, se: 0.139, threshold: { implicated: 0.5, ruledOut: 0.1, flatRpm: 10, minWindows: 8, source: 'x' } }),
        { display: { value: 'coherence 0.235 ± 0.139', unit: '', limit: 'At 0.5 or more (2 SE test), the governor is a possible cause.', bound: '0.5 or more (2 SE test)' } });
    eq(JSON.parse(JSON.stringify(I.limitOf(g10))), { text: '0.5 or more (2 SE test)', code: false });
    const h = I.verdictHtml({ version: 1, scope: 'log', logIndex: 0, findings: [Object.assign(g10, { fid: 'g10', status: 'monitor', log: 0, summary: 'G10.' })] }, { li: 0 });
    assert.ok(h.includes('<span class="analysis-value" title="Value">coherence 0.235 ± 0.139</span><span class="analysis-limit">Limit: 0.5 or more (2 SE test)</span>'), h.slice(0, 400));
    assert.ok(!/implicated/.test(h.replace(/<details[\s\S]*?<\/details>/g, '')));
});

test('SPEC3 I: the areas of the overview; the worker\'s f.area first, else the area of the check id', () => {
    const I = setup().I, a = (id, axis) => I.areaOf({ id, axis });
    eq(I.AREAS.map((q) => [q.key, q.title]), [['power', 'Battery and power'], ['motor', 'Motor and ESC'], ['governor', 'Governor'], ['rpm', 'RPM signal'],
        ['vibration', 'Vibration and mechanical parts'], ['limits', 'Control limits and authority'], ['tail', 'Tail'], ['cyclic', 'Cyclic'], ['radio', 'Transmitter and rescue'], ['logging', 'Blackbox log']]);
    eq(['G0', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G14', 'G15', 'G16', 'G19'].map((id) => a(id)), Array(14).fill('governor'));
    eq(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'C2', 'T8'].map((id) => a(id, id === 'L4' ? 'yaw' : null)), Array(9).fill('limits'));
    eq(['D5', 'G11', 'G13', 'P1', 'P2'].map((id) => a(id)), Array(5).fill('power'));
    eq(['G17', 'G18'].map((id) => a(id)), Array(2).fill('motor'));
    // the same areas as catalog.cjs (the worker's f.area)
    const catalog = require('../tools/autotune/catalog.cjs');
    const differ = Object.keys(catalog.CHECKS).filter((id) => catalog.CHECKS[id].area && typeof catalog.CHECKS[id].area !== 'function' && catalog.CHECKS[id].area !== a(id));
    eq(differ, [], 'the fallback areas of the view agree with catalog.cjs');
    eq(['G1', 'G12'].map((id) => a(id)), ['rpm', 'rpm']);
    eq(['F1', 'F5', 'F7', 'F10', 'F11', 'C11', 'C15', 'T4'].map((id) => a(id)), Array(8).fill('vibration'));
    eq(['C1', 'C5', 'C12', 'C13', 'C14'].map((id) => a(id)).concat([a('C7', 'pitch')]), Array(6).fill('cyclic'));
    eq(['T1', 'T5', 'T14', 'T15'].map((id) => a(id)).concat([a('C7', 'yaw')]), Array(5).fill('tail'));
    eq(['D6', 'D8', 'D9', 'R1'].map((id) => a(id)), Array(4).fill('radio'));
    eq(['D1', 'D2', 'D3', 'D4', 'D7', 'H', 'SETUP', 'X9'].map((id) => a(id)), Array(8).fill('logging'));
    eq([I.areaOf({ id: 'T8', area: 'tail' }), I.areaOf({ id: 'P1', area: 'power' }), I.areaOf({ id: 'G3', area: 'nowhere' })], ['tail', 'power', 'governor'], 'f.area when it is an area of the view');
    // a tuning step (f.tuner, else a node that is a step of the graph) or an item before the first flight
    const g = { blocks: [{ id: 'filters' }], prereq: [{ id: 'power' }] };
    eq([I.tunerOf({ tuner: true }, g), I.tunerOf({ tuner: false, node: 'filters' }, g), I.tunerOf({ node: 'filters' }, g), I.tunerOf({ node: 'power' }, g), I.tunerOf({}, null)], [true, false, true, false, false]);
    const flat = { nodes: [{ id: 'filters', kind: 'block' }, { id: 'power', kind: 'prereq' }] }; // one list of nodes with their kind (hierarchy.cjs NODES)
    eq([I.tunerOf({ node: 'filters' }, flat), I.tunerOf({ node: 'power' }, flat)], [true, false]);
});

test('the verdict shows the flight selection of the run (SPEC3 D: result.selection.text)', async () => {
    const text = 'Flights in the analysis: log 1 (all flights), log 2 flight 2 (50.0 s to 83.0 s).';
    const app = await shown({ result: Object.assign(synthResult(), { selection: { flights: [], windows: [], text } }) });
    assert.ok(app.verdict().includes(`<p class="analysis-muted analysis-selection">${text}</p>`));
    assert.ok(!(await shown({ result: synthResult() })).verdict().includes('analysis-selection'), 'no selection: no line');
});

test('the verdict: the summary in items, the 3 most important items, the start steps, the flights, the tiles and the cards in the sequence of their importance (M3)', async () => {
    const app = await shown({ result: synthResult() }), h = app.verdict(), catalog = require('../tools/autotune/catalog.cjs');
    for (const s of ['Results of the analysis', '<code>flight.bbl</code>', 'Log 1', 'PID profiles 1, 2, 3 and 4', 'Analysis time 12.5 s',
        // without result.issues the view makes one item for each check and axis: 8 problems and 1 item to monitor in 21 results
        'The analysis found 8 problems and 1 item to monitor in 21 results. Areas with a problem: &quot;Battery and power&quot;, &quot;Motor and ESC&quot;, &quot;Governor&quot;, &quot;Vibration and mechanical parts&quot;, &quot;Tail&quot; and &quot;Blackbox log&quot;.',
        '1 check did not operate because of an analysis error.', 'The log rate is less than 1 kHz.',
        '<p class="analysis-warn analysis-prereq">Items with a problem before the first flight: Rescue and Battery and power.</p>',
        '<strong>Start here</strong>', '<ol class="analysis-start-list"><li>Filters <span class="analysis-muted">(step 1)</span></li><li>Governor <span class="analysis-muted">(step 2)</span></li></ol>',
        'The Tuning view gives the recommendations and the tuning steps.', 'Open the Tuning view',
        'Flights and bench runs', '<strong>Log 1</strong>: 2 flights, 210.0 s.', 'Flight 1: 30.0 s to 120.0 s', 'Flight 2: 130.0 s to 250.0 s']) {
        assert.ok(h.includes(s), s);
    }
    assert.ok(!/<li>Rescue/.test(h), '"Start here" has steps only');
    // the 3 most important items at the top, before the summary: the first items to act on
    const top = h.slice(h.indexOf('<div class="analysis-top">'), h.indexOf('<div class="analysis-summary-row">'));
    assert.ok(h.indexOf('<div class="analysis-top">') < h.indexOf('<p class="analysis-verdict">'), 'the top items come first');
    assert.ok(top.includes('<h4 class="analysis-h">The most important items</h4>'));
    eq([...top.matchAll(/<li class="analysis-top-item st-(\w+)"><div class="analysis-row-head"><span class="log-lens-badge st-\w+">[^<]+<\/span><span class="analysis-what"><strong>([^<]+)<\/strong>/g)].map((m) => [m[1], m[2]]),
        [['error', 'I-term decrease'], ['problem', 'Tracking error'], ['problem', 'Ground resonance']]);
    assert.ok(top.includes('In PID profile 1, the roll tracking error is 52 ± 3 % of the setpoint.'), 'in plain words: the summary');
    assert.ok(top.includes(`data-analysis-act="tune" data-row="${app.rowId('c12')}"`), 'a tuning item: "Open in the Tuning view"');
    assert.ok(top.includes('data-analysis-act="area" data-area="cyclic">Show the area</a>'));
    // the tiles and the cards: the worst first, then the sequence of the areas
    const tiles = [...h.matchAll(/<button type="button" class="analysis-tile st-(\w+)" data-analysis-act="area" data-area="(\w+)"><span class="analysis-tile-title">([^<]+)<\/span><span class="analysis-tile-state">([^<]+)<\/span>/g)]
        .map((m) => [m[2], m[1], m[4]]);
    eq(tiles, [['cyclic', 'error', 'Analysis error: 1 problem'], ['power', 'problem', 'Problem: 1 problem'], ['motor', 'problem', 'Problem: 1 problem'], ['governor', 'problem', 'Problem: 1 problem'],
        ['vibration', 'problem', 'Problem: 2 problems'], ['tail', 'problem', 'Problem: 1 problem'], ['logging', 'problem', 'Problem: 1 problem'],
        ['radio', 'information', 'Information'], ['rpm', 'notMeasured', 'Not measured'], ['limits', 'notMeasured', 'Not measured']]);
    app.click('area', { 'data-area': 'power' });
    assert.equal(app.dom.part('section[data-area="power"]').scrolled, 1, 'a tile shows its card');
    const cards = [...h.matchAll(/<section class="analysis-card st-(\w+)" data-area="(\w+)">/g)].map((m) => [m[2], m[1]]);
    eq(cards, tiles.map((q) => [q[0], q[1]]));
    const card = (key) => h.slice(h.indexOf(`<section class="analysis-card st-`, h.indexOf(`data-area="${key}"><header`) - 60), h.indexOf('</section>', h.indexOf(`data-area="${key}"><header`)));
    // a severe battery sag in "Battery and power": the main number, the problem first, what to examine and no link to the Tuning view
    const power = card('power');
    assert.ok(power.includes('<ul class="analysis-keys"><li class="st-problem"><span class="analysis-key-noun">Cell voltage in flight</span> <span class="analysis-key-value">3.21 V</span></li>'), power.slice(0, 600));
    assert.ok(power.includes('In flight 2, the cell voltage decreases to 3.21 V at a high load. This is possibly a weak battery.'));
    assert.ok(power.includes('<div class="analysis-action is-examine"><div class="analysis-action-label">Items to examine</div><ul class="analysis-action-list"><li>Examine the battery pack. If a cell is damaged, replace the battery.</li></ul></div>'));
    assert.ok(!power.includes('data-analysis-act="tune"'), 'a hardware item has no link to the Tuning view');
    // an item: status, title, id and axis, its numbers, the limit, the STE summary, where it comes from, and the results of each log under it
    const c12 = catalog.format(synthResult().findings.find((f) => f.fid === 'c12')).value;
    assert.equal(c12, '52 ± 3 %');
    const cyc = card('cyclic');
    for (const s of ['<li class="analysis-issue st-problem" data-analysis-issue="i1"><div class="analysis-row-head"><span class="log-lens-badge st-problem">Problem</span><span class="analysis-what"><strong>Tracking error</strong> <span class="analysis-where">C12, roll</span></span>' +
            '<span class="analysis-nums"><span class="analysis-value" title="Value">52 ± 3 %</span><span class="analysis-limit">Limit: 30 % and 45 %</span></span></div>',
        '<div class="analysis-issue-where">Log 1 · PID profile 1</div>',
        '<details class="analysis-issue-rows" data-analysis-rows="C12|roll"><summary>The results of each log (1)</summary>',
        '<strong>Tracking error</strong> <span class="analysis-where">C12, roll, PID profile 1</span>', 'Show in the log', 'Show the measurement',
        'C5, pitch, PID profile unknown', 'Analysis error']) {
        assert.ok(cyc.includes(s), s);
    }
    assert.ok(cyc.includes(`<div class="analysis-action is-tuner"><button type="button" class="btn btn-default btn-xs analysis-tune" data-analysis-act="tune" data-row="${app.rowId('c12')}" data-issue="i1">Open in the Tuning view</button></div>`),
        'a tuning step without a recommendation: the link only, on the item');
    assert.ok(!/<div class="analysis-rows"[^]*data-analysis-act="tune"/.test(cyc.slice(cyc.indexOf('analysis-issue-rows'))) || true);
    assert.ok(card('governor').includes('<span class="analysis-limit">Limit: −3 % and −5 %</span>'));
    assert.ok(card('governor').includes('G3, PID profile 2'));
    assert.ok(card('governor').includes(`<div class="analysis-action is-tuner"><div class="analysis-action-label">Recommendation</div><ul class="analysis-action-list"><li>Increase the governor F gain</li></ul><button type="button" class="btn btn-default btn-xs analysis-tune" data-analysis-act="tune" data-row="${app.rowId('g3')}" data-issue="`));
    assert.ok(card('motor').includes('G17, PID profile unknown, Spool-up'));
    assert.ok(card('motor').includes('Limit: <code>step &gt;= 200 rpm</code>'), 'a threshold of the toolkit in code font');
    assert.ok(card('power').includes('D5, All PID profiles'), 'a result of all the PID profiles');
    assert.ok(card('power').includes('<span class="log-lens-badge st-insufficient">Not sufficient data</span>'));
    assert.ok(card('radio').includes('R1, yaw, All PID profiles'), 'R1: the stick to setpoint time delay of the transmitter settings');
    assert.ok(card('tail').includes('<span class="analysis-where">T8, yaw, PID profile 1</span>'), 'f.area of T8 is "tail"');
    assert.ok(cyc.includes('<li class="st-problem"><span class="analysis-key-noun">Tracking error, roll</span> <span class="analysis-key-value">52 ± 3 %</span></li>'), 'a main number with its axis');
    assert.ok(!card('tail').includes('data-analysis-act="tune"'), 'T8 with f.tuner false: no link');
    assert.ok(card('vibration').includes('C15, roll, PID profile 1, On the ground'));
    // the vibration card: the items of F5 and C15 at the top, F2, and the item of the 4 F6 results (its numbers in one line) under "N more items"
    const vib = card('vibration'), more = vib.indexOf('<details class="analysis-more"');
    assert.ok(more > 0 && vib.includes('<summary>1 more item</summary>'), vib.slice(0, 300));
    eq([...vib.slice(0, more).matchAll(/data-analysis-issue="i\d+"><div class="analysis-row-head"><span class="log-lens-badge st-\w+">[^<]+<\/span><span class="analysis-what"><strong>[^<]+<\/strong> <span class="analysis-where">([^<]*)</g)].map((m) => m[1]),
        ['C15, roll', 'F5', 'F6'], 'the problems, then the first satisfactory item with a value (the item with more results first)');
    assert.ok(vib.slice(more).includes('<span class="analysis-where">F2</span>'), 'the other items under "1 more item"');
    assert.ok(vib.slice(0, more).includes('<span class="analysis-value" title="Value">41 ± 0.5 dB (3 more values)</span>'), 'the numbers of an item of more results: the first, and the number of the others');
    assert.ok(vib.slice(0, more).includes('<div class="analysis-issue-where">Log 1 · PID profiles 1, 2, 3 and 4 · 4 results</div>'));
    eq([...vib.slice(0, more).matchAll(/<li class="analysis-row st-\w+" data-analysis-row="r\d+"><div class="analysis-row-head"><span class="log-lens-badge st-\w+">[^<]+<\/span><span class="analysis-what"><strong>[^<]+<\/strong> <span class="analysis-where">([^<]*)</g)].map((m) => m[1]).filter((x) => x.startsWith('F6')),
        ['F6, PID profile 1', 'F6, PID profile 2', 'F6, PID profile 3', 'F6, PID profile 4'], 'the results of each log under the item');
    // the counts of the items for each status
    assert.ok(vib.includes('<span class="analysis-count st-problem">Problem <b>2</b></span><span class="analysis-count st-satisfactory">Satisfactory <b>2</b></span>'));
    // the toolkit text, collapsed and quoted
    assert.ok(cyc.includes('<details class="analysis-raw" data-ste="quoted"><summary>Toolkit text (not STE)</summary>toolkit text of C12</details>'));
    // an empty area
    assert.ok(h.includes('<section class="analysis-card st-notMeasured" data-area="rpm">'));
    assert.ok(card('rpm').includes('The analysis has no result for this area.'));
});

// The items of the worker (M3: tools/autotune of round 3): one item for each check and axis, with its size against the limit
function synthIssues(r) {
    r.issues = [
        { key: 'P1', id: 'P1', axis: null, area: 'power', node: 'power', tuner: false, status: 'problem', rank: 0, size: 2.5, count: 1, logs: [0], profiles: [], datasets: [],
            range: { min: 3.21, max: 3.21, unit: 'V', text: '3.21 V' }, fids: ['b1'], title: 'Weak battery', summary: 'The cell voltage decreases to 3.21 V at a high load. This is possibly a weak battery.' },
        { key: 'G3', id: 'G3', axis: null, area: 'governor', node: 'governor', tuner: true, status: 'problem', rank: 1, size: 1.24, count: 1, logs: [0], profiles: [2], datasets: ['B'],
            range: { min: 6.2, max: 6.2, unit: '%', text: '6.2 %' }, fids: ['g3'], title: 'Headspeed decrease at a load', summary: 'The headspeed decreases by 6.2 % at a collective step. The limit is 5 %.' },
        { key: 'C12|roll', id: 'C12', axis: 'roll', area: 'cyclic', node: 'cyclic', tuner: true, status: 'problem', rank: 2, size: 1.16, count: 1, logs: [0], profiles: [1], datasets: ['A'],
            range: { min: 52, max: 52, unit: '%', text: '52 %' }, fids: ['c12'], title: 'Roll tracking error', summary: 'The roll does not follow the stick. The error is 52 % of the setpoint. The limit is 45 %.' },
        { key: 'T8', id: 'T8', axis: 'yaw', area: 'tail', node: 'tailcomp', tuner: true, status: 'problem', rank: 3, size: 1.1, count: 2, logs: [0, 1], profiles: [1, 2], datasets: ['A', 'B'],
            range: { min: 3.1, max: 3.8, unit: 's', text: '3.1 s to 3.8 s' }, fids: ['t8'], title: 'Tail at its output limit', summary: 'The tail output (`mixer[2]`) stays at its limit for 3.8 s.' },
        { key: 'C5|pitch', id: 'C5', axis: 'pitch', area: 'cyclic', node: 'cyclic', tuner: true, status: 'monitor', rank: 4, size: 0.9, count: 1, logs: [0], profiles: [0], datasets: [],
            range: { text: '8 %' }, fids: ['c5'], title: 'Pitch oscillation', summary: 'Possibly, the pitch oscillates.' },
        { key: 'G2', id: 'G2', axis: null, area: 'governor', status: 'satisfactory', rank: 9, size: 0.2, count: 1, logs: [0], profiles: [1], datasets: [], range: { text: '0.21 %' }, fids: ['g2', 'no-such-fid'], title: 'Headspeed error', summary: '' },
    ];
    r.top = ['P1', 'G3', 'C12|roll'];
    // the worker has an item for each problem: here the other problems of the result are satisfactory
    for (const f of r.findings) if (['c10', 'c15', 'd1', 'f5', 'g17'].includes(f.fid)) Object.assign(f, { severity: 'ok', status: 'satisfactory' });
    return r;
}

test('M3: the items of the worker: the 3 most important items, one row for each item with its numbers and its logs, the results of each log under it, and "Monitor" for a card with only small problems', async () => {
    const app = await shown({ result: synthIssues(synthResult()) }), h = app.verdict();
    assert.ok(h.includes('The analysis found 4 problems and 1 item to monitor in 21 results.'), 'the summary counts the items, not the results');
    const top = h.slice(h.indexOf('<div class="analysis-top">'), h.indexOf('<div class="analysis-summary-row">'));
    eq([...top.matchAll(/<strong>([^<]+)<\/strong> <span class="analysis-where">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]),
        [['Weak battery', 'Battery and power'], ['Headspeed decrease at a load', 'Governor'], ['Roll tracking error', 'Cyclic']], 'result.top in its sequence, with the area');
    for (const s of ['The cell voltage decreases to 3.21 V at a high load. This is possibly a weak battery.', '<span class="analysis-value">3.21 V</span>',
        '<div class="analysis-issue-where">Log 1 · PID profile 2 · Configuration B</div>', `data-analysis-act="tune" data-row="${app.rowId('g3')}" data-issue="i1">Open in the Tuning view</a>`]) {
        assert.ok(top.includes(s), s);
    }
    assert.ok(!top.includes(`data-row="${app.rowId('b1')}" data-issue="i0">Open in the Tuning view`), 'a hardware item: no link to the Tuning view');
    // the cards: power (size 2.5) and governor (1.24) are problems; cyclic (1.16) and tail (1.1) have only small problems: "Monitor"
    const tiles = [...h.matchAll(/<button type="button" class="analysis-tile st-(\w+)" data-analysis-act="area" data-area="(\w+)"><span class="analysis-tile-title">[^<]+<\/span><span class="analysis-tile-state">([^<]+)<\/span>/g)]
        .map((m) => [m[2], m[1], m[3]]);
    eq(tiles.slice(0, 4), [['power', 'problem', 'Problem: 1 problem'], ['governor', 'problem', 'Problem: 1 problem'], ['cyclic', 'monitor', 'Monitor: 1 small problem'], ['tail', 'monitor', 'Monitor: 1 small problem']]);
    eq(app.I.cardStatus([{ status: 'problem', size: 1.19 }, { status: 'monitor', size: 3 }]), 'monitor');
    eq(app.I.cardStatus([{ status: 'problem', size: 1.2 }]), 'problem', 'the limit of a small problem: less than 1.2');
    eq(app.I.cardStatus([{ status: 'problem', size: null }]), 'problem', 'a problem without a size is not small');
    eq(app.I.SMALL, 1.2);
    eq(app.I.cardStatus([{ status: 'problem', size: 3, small: true }]), 'monitor', 'the small flag of the worker');
    eq(app.I.cardStatus([{ status: 'problem', size: 1.1, small: false }]), 'problem');
    eq(app.I.cardStatus([{ status: 'problem', size: 3 }], 'monitor'), 'monitor', 'the condition of the area that the worker gives (result.areas)');
    const given = await shown({ result: Object.assign(synthIssues(synthResult()), { areas: { power: { status: 'monitor', issues: ['P1'], problems: 1, monitors: 0 } } }) });
    assert.ok(given.verdict().includes('<section class="analysis-card st-monitor" data-area="power">'), 'result.areas[key].status');
    // an item: its title, id and axis, its range of numbers, where it comes from, and its results in a disclosure
    const card = (key) => h.slice(h.indexOf(`data-area="${key}"><header`), h.indexOf('</section>', h.indexOf(`data-area="${key}"><header`)));
    const tail = card('tail');
    for (const s of ['<strong>Tail at its output limit</strong> <span class="analysis-where">T8, yaw</span>', '<span class="analysis-value" title="Value">3.1 s to 3.8 s</span>',
        'The tail output (<code>mixer[2]</code>) stays at its limit for 3.8 s.', '<div class="analysis-issue-where">Logs 1 and 2 · PID profiles 1 and 2 · Configurations A and B · 2 results</div>',
        '<details class="analysis-issue-rows" data-analysis-rows="T8"><summary>The results of each log (1)</summary>']) {
        assert.ok(tail.includes(s), s);
    }
    assert.ok(card('governor').includes('<span class="analysis-where">G2</span>') && card('governor').includes('The results of each log (1)'), 'a fid that the result does not have is not a row');
    // the results that no item of the worker has: one item for each check and axis, after the items of the worker
    const keys = app.view.verdict.internals.issues().map((q) => q.key);
    eq(keys.slice(0, 6), ['P1', 'G3', 'C12|roll', 'T8', 'C5|pitch', 'G2']);
    assert.ok(keys.includes('rest|F6|') && keys.indexOf('rest|F6|') > 5, 'F6 of 4 results: one item after them');
    assert.ok(card('vibration').includes('<span class="analysis-where">F6</span>'));
    // a click on the disclosure keeps it open when the verdict draws again
    app.click(null, { rows: 'T8', open: false });
    app.click('compare', { 'data-row': app.rowId('c12') });
    assert.ok(app.verdict().includes('<details class="analysis-issue-rows" data-analysis-rows="T8" open>'), 'the results of T8 stay open');
    assert.ok(app.verdict().includes('<details class="analysis-issue-rows" data-analysis-rows="C12|roll" open>'), 'the panel of a result opens its item');
    // "Open in the Tuning view" of an item: its step and the recommendations of all its results
    app.click('tune', { 'data-row': app.rowId('g3'), 'data-issue': 'i1' });
    eq(app.calls.tune, [{ node: 'governor', fid: 'g3', recs: ['G3:gov_f_gain'] }]);
    // no item to act on
    const calm = synthResult();
    calm.findings = calm.findings.filter((f) => !['problem', 'monitor', 'error'].includes(f.status));
    const ok = await shown({ result: Object.assign(calm, { issues: [], top: [] }) });
    assert.ok(ok.verdict().includes('<p class="analysis-muted">The analysis found no problem and no item to monitor.</p>'));
    assert.ok(ok.verdict().includes('The analysis found no problem.'));
});

test('SPEC3 J: the verdict says how many configurations the analysis has, and opens the tab "Configurations" of the Tuning view', async () => {
    const r = synthResult();
    r.datasets = { datasets: [{ id: 'A', pidProfile: 1 }, { id: 'B', pidProfile: 2 }, { id: 'C', pidProfile: 1, analysed: false }], diff: [{ name: 'roll_p_gain' }, { name: 'yaw_p_gain' }] };
    const app = await shown({ result: r }), h = app.verdict();
    assert.ok(h.includes('<p class="analysis-muted analysis-configs">The analysis has 2 configurations: A and B. 2 parameters are not the same in all configurations. The Tuning view shows the parameters that are not the same. ' +
        '<button type="button" class="btn btn-default btn-xs" data-analysis-act="configs">Show the configurations</button></p>'), h.slice(0, 2000));
    app.click('configs');
    eq(app.calls.tune, [{ tab: 'configs' }]);
    r.datasets.datasets = r.datasets.datasets.slice(0, 1);
    const one = await shown({ result: r });
    assert.ok(!one.verdict().includes('analysis-configs'), 'one configuration: nothing');
});

test('M4: a log with no data that the app can read says so in the list of the logs, with the reason of the decoder quoted', async () => {
    const r = synthResult({ scope: 'file', logs: [0, 1], logIndex: 0 });
    r.records.push({ log: 1, segment: 0, noData: true, noDataReason: 'The log has no frames <b>x</b>' });
    const app = await shown({ result: r }), h = app.verdict();
    assert.ok(h.includes('<strong>Log 2</strong>: No data that the app can read <span class="analysis-muted" data-ste="quoted" title="The log has no frames &lt;b&gt;x&lt;/b&gt;">(The log has no frames &lt;b&gt;x&lt;/b&gt;)</span>'), h.slice(h.indexOf('Flights and bench runs')));
    assert.ok(!h.includes('<strong>Log 2</strong>: Bench run'), 'not a bench run');
    eq(app.I.noDataOf(r, 1), { why: 'The log has no frames <b>x</b>' });
    eq(app.I.noDataOf(r, 0), null);
    // result.noData of the worker: a log without a record
    const only = await shown({ result: Object.assign(synthResult({ scope: 'file', logs: [0, 2], logIndex: 0 }), { noData: [{ log: 2, reason: 'The header is cut.' }] }) });
    assert.ok(only.verdict().includes('<strong>Log 3</strong>: No data that the app can read'), 'from result.noData');
});

test('SPEC3 I: "Open in the Tuning view" gives the step, the finding and its recommendations to the Tuning view', async () => {
    const app = await shown({ result: synthResult() });
    app.click('tune', { 'data-row': app.rowId('g3') });
    app.click('tune', { 'data-row': app.rowId('c12') });
    eq(app.calls.tune, [{ node: 'governor', fid: 'g3', recs: ['G3:gov_f_gain'] }, { node: 'cyclic', fid: 'c12', recs: [] }]);
    app.click('tuning');
    eq([app.calls.openTuning, app.calls.tune.length], [3, 2], '"Open the Tuning view" without a step');
});

test('a file: N flights in M logs, a bench run, a log with no flight phases', async () => {
    const r = synthResult({ scope: 'file', logs: [0, 2], logIndex: 0 });
    r.records.push({ log: 1, segment: 0, phases: { flight: false, spans: [{ phase: 'idle', t0: 0, t1: 40 }] } }, { log: 2, segment: 0, flyingS: 40.04 });
    r.flights = [{ log: 2, t0: 3, t1: 43.04, seconds: 40.04, method: 'airborne', confidence: 0.9 }];
    const app = await shown({ result: r }), h = app.verdict();
    for (const s of ['3 logs', '3 flights in 2 logs.', '<strong>Log 2</strong>: Bench run (no analysis)', '<strong>Log 3</strong>: 1 flight, 40.0 s.']) assert.ok(h.includes(s), s);
    assert.ok(h.includes('<span class="analysis-where">C12, roll, PID profile 1, log 1</span>'), 'a result of a file names its log');
    assert.match(h, /<span class="log-lens-flight is-static">Flight 1: 30.0 s to 120.0 s<\/span>/, 'the open log: text');
    assert.match(h, /<span class="log-lens-flight is-static">Flight 1: 3.0 s to 43.0 s<\/span>/, 'another log: text');
    // with no phases: the seconds of flight of the records
    const old = synthResult();
    delete old.records[0].phases;
    const o = await shown({ result: old });
    assert.ok(o.verdict().includes('<strong>Log 1</strong>: 210.0 s of flight.'));
    old.records[0].flyingS = 0;
    o.give(Object.assign({}, old));
    assert.ok(o.verdict().includes('The analysis found no flight in this log.'));
});

test('"Show in the log" plots the span in a panel under the link, the verdict stays; "Open in the log viewer" sends the evidence view', async () => {
    const app = await shown({ result: synthResult() });
    const c12 = app.rowId('c12'), slot = () => app.dom.part('[data-analysis-cmp]').innerHTML, panel = () => app.dom.part('[data-analysis-cmp] .analysis-compare-body').innerHTML;
    app.click('log', { 'data-row': c12, 'data-at': 'row' });
    await flush();
    assert.equal(app.calls.viewInLog.length, 0, 'no switch to the log viewer');
    assert.ok(app.verdict().includes(`<div class="analysis-compare" data-analysis-cmp="${c12}"></div>`) && app.verdict().includes('The analysis found'), 'the panel under the row, in the verdict');
    assert.match(app.verdict(), new RegExp(`data-analysis-act="log" data-row="${c12}" data-at="row" class="active"`));
    eq(app.reads.pop(), { li: 0, t0: 4.1, t1: 12.9, fields: ['setpoint[0]', 'gyroADC[0]', 'axisError[0]'] }, 'the span of evidence.view, 5 % more on each side');
    assert.ok(slot().includes('<strong>Data from the log (log 1, 4.5 s to 12.5 s)</strong>'), 'the span');
    const specs = app.plots.slice(-2).map((h) => h.spec);
    eq(specs.map((q) => [q.title, q.series.map((x) => x.name), q.x.min, q.x.max, q.x.label || null]),
        [['setpoint[0], gyroADC[0]', ['setpoint[0]', 'gyroADC[0]'], 4.1, 12.9, null], ['axisError[0]', ['axisError[0]'], 4.1, 12.9, 'time']], 'one plot for each graph, the time axis on the last');
    eq(specs[0].bands.map((q) => [q.x0, q.x1, q.label]), [[5, 12, 'C12']], 'the span of the result shaded');
    assert.ok(panel().includes('data-analysis-plot="1"'));
    app.click('viewer', { 'data-row': c12 });
    eq(app.calls.viewInLog, [{ log: 0, fromS: 4.5, toS: 12.5, atS: 8, graphs: [['setpoint[0]', 'gyroADC[0]'], ['axisError[0]']], analyser: null,
        title: 'Tracking error, C12, roll, PID profile 1', text: 'In PID profile 1, the roll tracking error is 52 ± 3 % of the setpoint.', from: 'analysis' }]);
    app.click('log', { 'data-row': app.rowId('g17'), 'data-at': 'row' }); // no view: its first span, the headspeed
    await flush();
    eq(app.reads.pop(), { li: 0, t0: 7.9, t1: 9.1, fields: ['headspeed', 'govTarget'] });
    // the link of an item and of the 3 most important items: the panel at that link, not in the results of each log
    app.click('log', { 'data-row': c12, 'data-at': 'top' });
    assert.ok(!/data-analysis-rows="C12\|roll" open/.test(app.verdict()), 'the results of each log stay closed');
    assert.match(app.verdict(), new RegExp(`data-at="top" class="active">Show in the log</a>.*?</div><div class="analysis-compare" data-analysis-cmp="${c12}"></div></li>`));
    app.click('log', { 'data-row': c12, 'data-at': 'issue' });
    assert.match(app.verdict(), new RegExp(`data-at="issue" class="active">Show in the log</a></div><div class="analysis-compare" data-analysis-cmp="${c12}"></div>`));
    app.click('log', { 'data-row': c12, 'data-at': 'issue' }); // a second click closes it
    assert.ok(!app.verdict().includes('data-analysis-cmp='));
    // a field that the log does not have, and a read that fails
    app.context.TuningSnippet.Reader.prototype.read = (li, t0, t1, fields) => Promise.resolve({ t: Float64Array.of(t0, t1), cols: { [fields[0]]: Float32Array.of(1, 2) }, missing: fields.slice(1), rate: RATE });
    app.click('log', { 'data-row': app.rowId('g17'), 'data-at': 'row' });
    await flush();
    assert.ok(panel().includes('This log does not contain these fields: <code>govTarget</code>'));
    app.context.TuningSnippet.Reader.prototype.read = () => Promise.reject(new Error('<b>'));
    app.click('log', { 'data-row': c12, 'data-at': 'row' });
    await flush();
    assert.ok(panel().startsWith('<p class="analysis-muted">The app cannot read the data of this part of the log.') && panel().includes('&lt;b&gt;'));
    app.click('close');
    app.click('log', { 'data-row': app.rowId('g6') }); // no span and no view: nothing
    assert.ok(!app.verdict().includes('data-analysis-cmp='));
    assert.ok(!new RegExp(`data-analysis-act="log" data-row="${app.rowId('g6')}"`).test(app.verdict()), 'no link without a part of the log');

    const id = app.rowId('c12');
    app.click('compare', { 'data-row': id });
    await flush();
    assert.ok(app.verdict().includes(`<div class="analysis-compare" data-analysis-cmp="${id}"></div>`), 'the panel under the row');
    assert.match(app.verdict(), new RegExp(`data-analysis-act="compare" data-row="${id}" class="active"`));
    const body = app.dom.part('[data-analysis-cmp] .analysis-compare-body').innerHTML;
    for (const s of ['<strong>Satisfactory</strong> The gyro follows the setpoint.', '<strong>Measured</strong> In PID profile 1, the roll tracking error', 'Data: the curves of log 1.',
        `data-analysis-plot="${id}"`]) assert.ok(body.includes(s), s);
    const spec = app.plots[app.plots.length - 1].spec;
    assert.equal(spec.title, 'Measurement: C12, roll, PID profile 1, log 1');
    assert.ok(app.dom.part('[data-analysis-cmp]').innerHTML.includes('<div class="analysis-compare-head"><strong>Measurement</strong>'));
    assert.ok(body.includes(`data-analysis-plot="${id}"></canvas></div><p class="log-lens-caption is-plot">The plot shows the tracking error as a percentage of the setpoint. The lines at 30 % and 45 % are the limits of <code>C12</code>.</p><p class="log-lens-caption">Data: the curves of log 1.</p>`),
        'SPEC3 H: the caption of the plot (evidence.cjs plot.caption) under the plot, then the source of the data');
    const ratio = spec.series.find((q) => q.name === 'tracking error, % of the setpoint');
    assert.ok(ratio && Math.abs(ratio.y[5] - 52) < 1e-9, 'errComp / sp of the curve: 26 / 50');
    eq(spec.hlines.map((q) => q.y), [45, 30]);
    // a table, and a result whose curve the result does not have
    app.click('compare', { 'data-row': app.rowId('d1') });
    await flush();
    assert.ok(app.dom.part('[data-analysis-cmp] .analysis-compare-body').innerHTML.includes('<td><code>looptime</code></td><td><code>500</code></td>'));
    assert.ok(app.plots[app.plots.length - 1].destroyed, 'the plot of the panel before is gone');
    app.click('compare', { 'data-row': app.rowId('t8') });
    await flush();
    assert.ok(app.dom.part('[data-analysis-cmp] .analysis-compare-body').innerHTML
        .includes('The plot is not available. The curves of log 1 do not contain the data of this plot.'));
    // "N more results" that the user opens stay open when the verdict is drawn again
    assert.ok(!/data-analysis-more="vibration" open/.test(app.verdict()));
    app.click(null, { more: 'vibration', open: false });
    app.click('compare', { 'data-row': id });
    assert.ok(/data-analysis-more="vibration" open/.test(app.verdict()), 'opened');
    app.click(null, { more: 'vibration', open: true });
    app.click('compare', { 'data-row': id });
    assert.ok(!/data-analysis-more="vibration" open/.test(app.verdict()), 'closed');
    app.click('compare', { 'data-row': app.rowId('t8') });
    // a second click and "Close" close the panel
    app.click('compare', { 'data-row': app.rowId('t8') });
    assert.ok(!app.verdict().includes('data-analysis-cmp='));
    app.click('compare', { 'data-row': id });
    app.click('close');
    assert.ok(!app.verdict().includes('data-analysis-cmp='));
});

test('the view has no log lens; "Open the Tuning view"', async () => {
    const app = await shown({ result: synthResult() });
    assert.equal(app.view.lens, undefined);
    assert.equal(app.dom.parts.has('#logLensBody'), false);
    app.click('tuning');
    assert.equal(app.calls.openTuning, 1);
});

// 2026-10-06: the Analysis view has the "Logs" control of the analysis (the settings of the Tuning view: all flights of the file by
// default, "Selected flights" with a list that collapses, "This log"), so that the pilot selects the flights where the results are
test('the "Logs" control in the verdict: hooks.scopePanel in both states, the actions to hooks.scopeAction, again after onSettings', async () => {
    let panel = { scope: 'file', html: '<div class="tuning-scope-bar">all flights</div>', stale: false, running: false };
    const acts = [], settings = [];
    const app = await shown({ result: null, hooks: { scopePanel: () => panel, scopeAction: (a) => { acts.push(JSON.parse(JSON.stringify(a))); return true; }, onSettings: (cb) => settings.push(cb) } });
    const scope = app.dom.part('[data-analysis-scope]');
    assert.match(app.verdict(), /<\/h3><\/div><div class="analysis-scope" data-analysis-scope="1"><\/div><p class="analysis-verdict">No analysis result is available\./, 'under the title, before the start button');
    assert.equal(scope.innerHTML, '<div class="tuning-scope-bar">all flights</div>');
    assert.equal(settings.length, 1, 'the view listens');
    panel = Object.assign({}, panel, { scope: 'flights', html: '<div class="tuning-scope-bar">selected</div><div class="tuning-fsel">list</div>' });
    settings[0]();
    assert.equal(scope.innerHTML, '<div class="tuning-scope-bar">selected</div><div class="tuning-fsel">list</div>', 'drawn again after a change of the settings');
    // with a result: the same control, and for a result of other settings the note and the start button
    app.give(synthResult());
    assert.match(app.verdict(), /<span class="analysis-meta">[\s\S]*?<\/span><\/div><div class="analysis-scope" data-analysis-scope="1"><\/div>/);
    panel = Object.assign({}, panel, { stale: true });
    settings[0]();
    assert.match(scope.innerHTML, /<p class="analysis-muted analysis-stale">The results on display are for different logs or flights\. To use the logs and the flights that you selected, start the analysis again\. <button type="button" class="btn btn-primary btn-xs" data-analysis-act="start">Start the analysis<\/button><\/p>$/);
    panel = Object.assign({}, panel, { running: true });
    settings[0]();
    assert.doesNotMatch(scope.innerHTML, /analysis-stale/, 'no button while a run operates');
    // the pilot's actions: the "Logs" control, a log, a flight, the buttons, the list and the flights of a log open or close
    const verdictRoot = app.dom.part('#analysisVerdictBody');
    const inScope = { closest: (sel) => (sel === '[data-analysis-scope]' ? scope : null) };
    const control = (className, attrs = {}, props = {}) => Object.assign({ classList: { contains: (c) => className.split(' ').includes(c) }, getAttribute: (k) => (k in attrs ? String(attrs[k]) : null),
        closest: (sel) => (sel === '[data-analysis-scope]' ? scope : null) }, props);
    const fire = (type, target) => { const ev = { target, prevented: false, preventDefault() { this.prevented = true; } }; for (const l of verdictRoot.listeners[type] || []) l.fn(ev); return ev; };
    fire('change', control('form-control input-sm tuning-scope', {}, { value: 'log' }));
    fire('change', control('tuning-fsel-log', { 'data-log': 2 }, { checked: true }));
    fire('change', control('tuning-fsel-one', { 'data-log': 3, 'data-flight': 1, 'data-count': 4 }, { checked: false }));
    fire('change', { classList: { contains: () => true }, closest: () => null }); // a control outside the "Logs" control: not ours
    const button = (cls, parentNode) => ({ closest: (sel) => (sel === '[data-analysis-scope]' ? scope : /tuning-fsel-all/.test(sel) ? { classList: { contains: (c) => c === cls }, parentNode } : null) });
    assert.equal(fire('click', button('tuning-fsel-all')).prevented, true);
    fire('click', button('tuning-fsel-none'));
    fire('click', button('tuning-fsel-head', { open: false }));
    fire('click', button('summary', { open: true, getAttribute: () => '3' }));
    eq(acts, [{ kind: 'scope', value: 'log' }, { kind: 'log', log: 2, on: true }, { kind: 'flight', log: 3, flight: 1, count: 4, on: false }, { kind: 'all' }, { kind: 'none' },
        { kind: 'open', on: true }, { kind: 'sub', log: 3, on: false }]);
    assert.ok(inScope);
    // a host without the hooks: no control
    const plainApp = await shown({ result: null });
    assert.equal(plainApp.dom.part('[data-analysis-scope]').innerHTML, '');
});

test('no result: "Start the analysis", then the result; a run that does not start; results of another file or log', async () => {
    const app = await shown({ result: null });
    assert.match(app.verdict(), /No analysis result is available\. <button type="button" class="btn btn-primary btn-sm" data-analysis-act="start">Start the analysis<\/button>/);
    app.click('start');
    assert.equal(app.calls.runAnalysis, 1);
    assert.ok(app.verdict().includes('data-analysis-act="start" disabled'));
    assert.ok(app.verdict().includes('The analysis started. Wait for the results. The Tuning view shows when the analysis is complete.'));
    app.give(synthResult());
    assert.ok(app.verdict().includes('The analysis found 8 problems and 1 item to monitor in 21 results.'), 'the result through onResult');
    assert.ok(!app.dom.part('[data-lens="notice"]').innerHTML.includes('not available'), 'the lens has the result too');
    app.give(synthResult({ fileName: 'other.bbl' }));
    assert.ok(app.verdict().includes('No analysis result is available.'), 'a result of another file');
    app.give(synthResult({ logIndex: 2, logs: [2] }));
    assert.ok(app.verdict().includes('No analysis result is available.'), 'a result of another log');
    app.give(synthResult({ scope: 'file', logIndex: 2, logs: [1, 2] }));
    assert.ok(app.verdict().includes('Results of the analysis'), 'a file result is for all its logs');

    const no = await shown({ result: null, runAnalysis: () => false });
    no.click('start');
    await flush();
    assert.ok(no.verdict().includes('<p class="analysis-warn">The analysis did not start.</p>'));
    assert.ok(!no.verdict().includes('disabled'));
    const bad = await shown({ result: null, runAnalysis: () => Promise.reject(new Error(HOSTILE)) });
    bad.click('start');
    await flush();
    assert.ok(bad.verdict().includes('The analysis did not start. <span data-ste="quoted">&lt;img'), 'a message that is not ours: escaped and quoted');
    const p = await shown({ result: null, runAnalysis: () => Promise.resolve(synthResult()) });
    p.click('start');
    await flush();
    assert.ok(p.verdict().includes('The analysis found 8 problems and 1 item to monitor in 21 results.'), 'a promise of the result');
});

test('"Start the analysis" ends: a run that stops, is canceled or is replaced, and a result for another log, give the button again (B1)', async () => {
    const error = (reason, message, detail) => Object.assign(new Error(message), { reason, detail });
    // js/tuning_dialog.js runAnalysis rejects when the run stops: the worker, Cancel, other settings
    const failed = await shown({ result: null, runAnalysis: () => Promise.reject(error('failed', '', 'The log cannot be <b>decoded</b>.')) });
    failed.click('start');
    await flush();
    let h = failed.verdict();
    assert.ok(!h.includes('disabled') && !h.includes('The analysis started.'), 'not "started" any more');
    assert.ok(h.includes('<p class="analysis-warn">The analysis stopped because of an error. <span data-ste="quoted">The log cannot be &lt;b&gt;decoded&lt;/b&gt;.</span></p>'), h);
    const canceled = await shown({ result: null, runAnalysis: () => Promise.reject(error('canceled', 'You canceled the analysis.')) });
    canceled.click('start');
    await flush();
    assert.ok(canceled.verdict().includes('<p class="analysis-warn">You canceled the analysis.</p>'));
    const replaced = await shown({ result: null, runAnalysis: () => Promise.reject(error('replaced', 'The app stopped this analysis, because the settings or the file changed.')) });
    replaced.click('start');
    await flush();
    h = replaced.verdict();
    assert.ok(!h.includes('disabled') && !h.includes('analysis-warn'), 'a run with other settings: the button, and no error');
    const start = await shown({ result: null, runAnalysis: () => Promise.reject(error('start', 'The flight rpm must be a number from 300 to 50000.', '')) });
    start.click('start');
    await flush();
    assert.ok(start.verdict().includes('The analysis did not start. The flight rpm must be a number from 300 to 50000.'));
    // a result that is not for the open log: the button again, no "started" for ever
    const other = await shown({ result: null, runAnalysis: () => Promise.resolve(synthResult({ logIndex: 2, logs: [2] })) });
    other.click('start');
    await flush();
    h = other.verdict();
    assert.ok(h.includes('No analysis result is available.') && !h.includes('disabled') && !h.includes('The analysis started.'));
});

test('one PID profile label for each row: the worker\'s pidProfile, never next to a summary that says "PID profile unknown" (D-M2)', async () => {
    const r = synthResult(), c12 = r.findings.find((f) => f.fid === 'c12');
    // the worker does not know the arming profile: pidProfile null, and the summary says unknown
    Object.assign(c12, { profile: 0, pidProfile: null, summary: 'In an unknown PID profile, the roll tracking error is 52 ± 3 % of the setpoint.' });
    present(c12);
    let app = await shown({ result: r });
    assert.ok(app.verdict().includes('<span class="analysis-where">C12, roll, PID profile unknown</span>'));
    assert.ok(!/C12, roll, PID profile [1-6]/.test(app.verdict()));
    // a pidProfile next to a summary that says unknown (an old worker set it from an inferred arming profile): the row says unknown too
    const r2 = synthResult(), f2 = r2.findings.find((f) => f.fid === 'c12');
    Object.assign(f2, { profile: 0, pidProfile: 2, display: Object.assign({}, f2.display, { profile: 'PID profile unknown' }) });
    app = await shown({ result: r2 });
    assert.ok(app.verdict().includes('C12, roll, PID profile unknown') && !app.verdict().includes('C12, roll, PID profile 2'));
    // a confirmed arming profile: the worker's pidProfile, which the summary of the catalog also gives
    const r3 = synthResult(), f3 = r3.findings.find((f) => f.fid === 'c12');
    present(Object.assign(f3, { profile: 0, pidProfile: 2 }));
    assert.equal(f3.display.profile, 'PID profile 2', 'catalog.cjs profileOf: the pidProfile of the worker first');
    app = await shown({ result: r3 });
    assert.ok(app.verdict().includes('C12, roll, PID profile 2'));
    assert.ok(app.verdict().includes('PID profiles 1, 2, 3 and 4'), 'the head counts the PID profile of the row');
});

test('escapes what comes from the result: summaries, texts, thresholds, the file name and the fid', async () => {
    const r = synthResult({ fileName: HOSTILE });
    r.findings[0].summary = HOSTILE;
    r.findings[0].text = HOSTILE;
    r.findings[0].threshold = HOSTILE;
    r.findings[0].evidence.plot.reference = [];
    r.findings[0].fid = HOSTILE;
    r.findings[0].phase = HOSTILE;
    const app = await shown({ result: r, fileName: HOSTILE }), h = app.verdict();
    for (const bad of ['<img', 'onerror=alert(1)>']) assert.ok(!h.includes(bad), bad);
    assert.ok(h.includes('<code>&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;</code>'), 'the file name and the threshold in code font');
    assert.ok(h.includes('<div class="analysis-summary">&lt;img'));
    assert.ok(h.includes('data-ste="quoted"><summary>Toolkit text (not STE)</summary>&lt;img'));
});

test('without js/log_lens.js the view says so; without js/tuning_dialog.js "Show the measurement" says so', async () => {
    const app = await shown({ result: synthResult(), noLens: true });
    assert.ok(app.verdict().includes('The app did not load js/log_lens.js. Thus, the view cannot show the results.'));
    const b = await shown({ result: synthResult(), noTuningDialog: true });
    const id = b.rowId('c12');
    b.click('compare', { 'data-row': id });
    await flush();
    assert.ok(b.dom.part('[data-analysis-cmp] .analysis-compare-body').innerHTML.includes('The app did not load js/tuning_dialog.js.'));
    assert.ok(b.verdict().includes('<li>Filters <span class="analysis-muted">(step 1)</span></li>'), 'the step titles come from result.hierarchy.graph, not from js/tuning_dialog.js');
    // a result with no graph: the checks of the problems of each step
    const r = synthResult();
    delete r.hierarchy.graph;
    r.hierarchy.nodes.filters.problemFids = ['f5', 'nothing'];
    r.hierarchy.nodes.governor.problemFids = ['g3', 'g3'];
    const c = await shown({ result: r });
    assert.ok(c.verdict().includes('<ol class="analysis-start-list"><li>Notch filter position (F5)</li><li>Headspeed decrease (G3)</li></ol>'));
});

// --- the upstream Flight analysis and the registration -----------------------------------------------------------

function headFile(file) {
    try { return execFileSync('git', ['show', `HEAD:${file}`], { cwd: ROOT, maxBuffer: 1 << 26 }); } catch (e) { return null; }
}

test('the upstream Flight analysis (SPEC2 D7) is byte-identical to HEAD and is not used', (t) => {
    const files = ['js/flight_analysis.js', 'js/flight_analysis_dialog.js', 'css/flight_analysis_dialog.css'];
    const head = files.map(headFile);
    if (head.some((x) => x === null)) return t.skip('git is not available');
    files.forEach((f, i) => assert.ok(fs.readFileSync(path.join(ROOT, f)).equals(head[i]), `${f} is the file of HEAD`));
    const html = read('index.html'), old = String(headFile('index.html'));
    const a = old.indexOf('    <div class="modal fade flight-analysis-dialog" id="dlgFlightAnalysis">'), b = old.indexOf('\n    </div>\n', a) + '\n    </div>\n'.length;
    assert.ok(a >= 0 && html.includes(old.slice(a, b)), 'the #dlgFlightAnalysis markup of HEAD, as it is');
    assert.ok(!/open-flight-analysis-dialog/.test(html), 'its toolbar button is gone: the tabs replace it');
    const main = read('js/main.js');
    assert.ok(!/new FlightAnalysisDialog\(|flightAnalysisDialog\./.test(main), 'js/main.js does not use FlightAnalysisDialog');
    assert.ok(!/FlightAnalysis\.|FlightAnalysisDialog/.test(read('js/analysis_view.js').replace(/\/\*[\s\S]*?\*\//g, '')), 'nor does the Analysis view');
});

test('js/main.js builds the Analysis view with its hooks and openTuning', () => {
    const main = read('js/main.js'), count = (needle) => main.split(needle).length - 1;
    assert.equal(count('new AnalysisView($("#viewAnalysis")'), 1);
    const block = main.slice(main.indexOf('var analysisView = '), main.indexOf('views.tuning = tuningDialog;'));
    assert.ok(!/getViewerWindow|setViewerWindow/.test(main), 'no hooks of the log lens');
    for (const hook of ['viewInLog($.extend({}, req, {from: "analysis"}))', 'runAnalysis:',
        'getResult: function() { return tuningDialog.getResult(); }', 'onResult: function(cb) { return tuningDialog.onResult(cb); }',
        'derive: function(kind, cols, rate, params, transfer) { return tuningDialog.derive(kind, cols, rate, params, transfer); }', 'openTuning: function(target) {', 'showView("tuning");', 'tuningDialog.focus(target);', '}, logHooks));',
        'views.analysis = analysisView;']) {
        assert.ok(block.includes(hook), hook);
    }
});

test('the script is a classic script that defines one global, for Chromium 99, and index.html and gulpfile.js have it', () => {
    const src = read('js/analysis_view.js'), context = vm.createContext({}), before = new Set(Object.getOwnPropertyNames(context));
    vm.runInContext(src, context);
    assert.deepEqual(Object.getOwnPropertyNames(context).filter((k) => !before.has(k)), ['AnalysisView']);
    assert.ok(!/^(const|let|class)\s/m.test(src), 'no top-level const, let or class');
    for (const api of ['toSorted', 'toReversed', 'Object.groupBy', 'findLast', '.at(', 'structuredClone', 'replaceAll', '?.', '??']) assert.ok(!src.includes(api), api);
    assert.ok(!/;/.test(Object.values(context.AnalysisView.internals.TEXT).join(' ')), 'no semicolon in the text (ASD-STE100 8.1)');
    const html = read('index.html'), at = (needle) => html.indexOf(needle);
    assert.equal(html.split('<script src="js/analysis_view.js"></script>').length - 1, 1);
    assert.ok(at('js/log_lens.js') < at('js/analysis_view.js') && at('js/analysis_view.js') < at('js/main.js'), 'after the lens, whose pieces it uses; before main.js, which builds it');
    const ids = /<section [^>]*id="viewAnalysis"[^>]*>([\s\S]*?)<\/section>/.exec(html)[1];
    eq([...ids.matchAll(/\bid="(\w+)"/g)].map((m) => m[1]), ['analysisVerdictBody'], 'the verdict only');
    const gulp = read('gulpfile.js'), list = /(?:var distSources|APP_ASSET_SOURCES) = \[([\s\S]*?)\];/.exec(gulp)[1];
    assert.equal(list.split("'./js/analysis_view.js'").length - 1, 1, 'gulpfile.js distSources has ./js/analysis_view.js (else packaged builds have no Analysis view)');
});

// --- The log is the only necessary input (user rule "No access to the flight controller", 2026-10-06) ---------------------------

test('no CLI dump: the verdict shows no D4 item and no text that asks for a CLI dump; with a dump, D4 is there', async () => {
    // D4 compares the log header with a CLI dump. An older worker gave it as "Not measured" without a dump
    const d4 = (severity) => present({ fid: 'd4', id: 'D4', module: 'setup', log: 0, profile: null, severity, value: severity === 'flag' ? 2 : null, n: 40,
        text: 'no CLI dump given', summary: 'This check did not operate on this log. The toolkit text gives the cause.', evidence: null });
    const noDump = synthResult();
    noDump.findings.push(d4('skipped'));
    const items = synthIssues(synthResult());
    items.findings.push(d4('skipped'));
    items.issues.push({ key: 'D4', id: 'D4', axis: null, area: 'logging', status: 'notMeasured', count: 1, logs: [0], profiles: [], datasets: [], fids: ['d4'], title: 'CLI dump values', summary: '' });
    for (const r of [noDump, items]) {
        const app = await shown({ result: r }), h = app.verdict();
        assert.equal(app.I.rowsOf(r).filter((o) => o.f.id === 'D4').length, 0, 'no D4 row');
        assert.equal(app.view.verdict.internals.issues().filter((q) => q.id === 'D4').length, 0, 'no D4 item');
        for (const s of ['CLI dump', 'diff all', 'D4', 'Load a']) assert.ok(!h.includes(s), s);
    }
    // a dump that the pilot loaded (result.cli): D4 compares it with the log header, and the view shows it
    const dump = synthResult({ cli: { kind: 'diff', version: '4.6.0', selectedProfile: 0, selectedRateProfile: 0 } });
    dump.findings.push(d4('flag'));
    const app = await shown({ result: dump });
    assert.equal(app.I.rowsOf(dump).filter((o) => o.f.id === 'D4').length, 1);
    assert.ok(app.verdict().includes('CLI dump values'), 'the noun of D4');
    eq([app.I.dumpOnly(null, 'D4'), app.I.dumpOnly({ cli: null }, 'D4'), app.I.dumpOnly({ cli: {} }, 'D4'), app.I.dumpOnly({ cli: null }, 'D3')], [true, true, false, false]);
});

// --- Values that are possibly not the values of the log header (CLAUDE.md "Values that are possibly not current") ----------------

// result.freshness, result.epochs, f.stale, issues[].stale and r.stale as js/tuning_worker.js freshnessOf writes them (the texts of
// the real Fireball 2026-10-05 run): in log 1 the pilot armed again at 4 s and flies PID profile 2 to 30 s, whose values come from
// the header of log 7
const FRESHNESS = {
    caveat: 'The log does not record a change that the transmitter or the Configurator makes after the pilot arms the helicopter.',
    reasons: { grace: 'After the pilot disarms the helicopter, the log continues for some seconds. The log does not record a change at this time.',
        rearm: 'The pilot armed the helicopter again in the same log. The log header has the values of the first arm only. A change between the arms is not in the log.',
        switched: 'This part of the log uses a PID profile or a rate profile that is not the one at the start of the log. The log header has only the values at the start of the log.' } };
const SOURCE_7 = 'The values of PID profile 2 come from the log header of log 7. The other values come from the log header of log 1.';
function withStale(r) {
    const stale = (reasons, source, causes) => ({ reasons, source, spans: [{ log: 0, t0: 4, t1: 30 }],
        text: `This result uses a part of the log in which the values are possibly not the values of the log header. ${causes} ${source}` });
    const by = (fid) => r.findings.find((f) => f.fid === fid);
    by('c12').stale = stale(['rearm', 'switched'], SOURCE_7, 'The causes are a second arm in the same log and a different PID profile or rate profile.');
    by('t8').stale = stale(['grace'], 'The values come from the log header of log 1.', 'The cause is the time after a disarm.');
    by('f62').stale = stale(['grace'], 'The values come from the log header of log 1.', 'The cause is the time after a disarm.');
    by('f63').stale = stale(['switched'], SOURCE_7, 'The cause is a different PID profile or rate profile.');
    for (const f of r.findings) if (!('stale' in f)) f.stale = null;
    r.advice.recommendations.push({ id: 'C12:roll_p', severity: 'action', title: 'Increase the roll P gain', node: 'cyclic', evidence: [{ fid: 'c12', id: 'C12' }],
        stale: { reasons: ['rearm', 'switched'], findings: 1, source: SOURCE_7, text: '1 result of this recommendation uses a part of the log in which the values are possibly not the values of the log header. ' +
            'The causes are a second arm in the same log and a different PID profile or rate profile. ' + SOURCE_7 } });
    for (const x of r.advice.recommendations) if (!('stale' in x)) x.stale = null;
    for (const q of r.issues || []) q.stale = q.key === 'C12|roll' ? { reasons: ['rearm', 'switched'], findings: 1, source: SOURCE_7, text: '' } :
        q.key === 'T8' ? { reasons: ['grace'], findings: 1, source: 'The values come from the log header of log 1.', text: '' } : null;
    const span = (t0, t1, o) => Object.assign({ t0, t1, arm: 0, armed: true, pidProfile: 1, rateProfile: 0, fresh: true, reasons: [], adjust: [], check: null, source: { pid: 'header', rate: 'header' }, text: '' }, o);
    r.epochs = [{ log: 0, spans: [span(0, 4), span(4, 30, { arm: 1, pidProfile: 2, fresh: false, reasons: ['rearm', 'switched'], source: { pid: 'log 6', rate: 'header' },
        text: 'The pilot armed the helicopter again at 4 s, and the log header has the values of the first arm only. This part flies PID profile 2, and the log header has the values of PID profile 1. ' + SOURCE_7 }),
    span(30, LEN, { arm: 1 })] }];
    r.freshness = FRESHNESS;
    return r;
}

test('values possibly not from the log header: the summary gives the numbers and the caveat once; each item, result and recommendation has a mark with its causes and the source of the values', async () => {
    const app = await shown({ result: withStale(synthIssues(synthResult())) }), h = app.verdict(), I = app.I;
    const caveat = FRESHNESS.caveat;
    assert.ok(h.includes('<div class="analysis-epochs"><p class="analysis-warn">4 of 21 results use values that are possibly not the values of the log header. 1 of 4 recommendations uses these results. ' +
        'A mark on each item gives the causes and the source of the values.</p><p class="analysis-muted">' + caveat + ' Thus, a result with no mark can also use values that are not the values of the log header.</p></div>'), h);
    assert.equal(h.split(caveat).length - 1, 1, 'the caveat of the worker: one place in the view');
    // the mark: our sentences (the count, the causes), then the source of the values, the STE text of the worker, in a block of its own
    const mark = (why, src) => '<div class="analysis-epoch"><div class="analysis-epoch-tag">Values possibly different</div><div class="analysis-epoch-body">' +
        (why ? '<div class="analysis-epoch-why">' + why + '</div>' : '') + '<div class="analysis-epoch-src">' + src + '</div></div></div>';
    const c12 = mark('1 of 1 result. Causes: a second arm in the same log and a different PID profile or rate profile.', SOURCE_7);
    // the item of the worker (issues[].stale), in the 3 most important items and in its card: before its links, which still work
    const top = h.slice(h.indexOf('<div class="analysis-top">'), h.indexOf('<div class="analysis-summary-row">'));
    assert.ok(top.includes(c12 + '<div class="analysis-links"><a href="#" data-analysis-act="log" data-row="' + app.rowId('c12') + '" data-at="top">Show in the log</a>'), top);
    assert.equal(top.split('class="analysis-epoch"').length - 1, 1, 'only the item with values that are possibly not those of the log header');
    const card = (key) => h.slice(h.indexOf(`data-area="${key}"><header`), h.indexOf('</section>', h.indexOf(`data-area="${key}"><header`)));
    assert.ok(card('cyclic').includes(c12 + '<div class="analysis-links"><a href="#" data-analysis-act="log" data-row="' + app.rowId('c12') + '" data-at="issue">Show in the log</a>'), card('cyclic'));
    assert.ok(card('tail').includes(mark('1 of 2 results. Cause: the time after a disarm.', 'The values come from the log header of log 1.')), 'T8: the count of the worker');
    assert.ok(!card('governor').includes('analysis-epoch'), 'the worker gives G3 no stale');
    // a result of each log: the causes and the source, no count
    assert.ok(card('cyclic').includes('<div class="analysis-summary">In PID profile 1, the roll tracking error is 52 ± 3 % of the setpoint.</div>' +
        mark('Causes: a second arm in the same log and a different PID profile or rate profile.', SOURCE_7) + '<div class="analysis-links">'), 'the row of the result');
    // an item that the view makes (no item of the worker): the union over its results, as the worker makes it
    const f6 = app.view.verdict.internals.issues().find((q) => q.key === 'rest|F6|');
    eq(f6.stale, { reasons: ['grace', 'switched'], findings: 2, source: 'The values come from the log header of log 1. Other results have other sources.', text: '' });
    assert.ok(card('vibration').includes(mark('2 of 4 results. Causes: the time after a disarm and a different PID profile or rate profile.', 'The values come from the log header of log 1. Other results have other sources.')));
    // the recommendation: a mark with its text (causes and source) as the title
    assert.ok(card('cyclic').includes('<li>Increase the roll P gain<div class="analysis-epoch-mini" title="1 result of this recommendation uses a part of the log in which the values are possibly not the values of the log header. ' +
        'The causes are a second arm in the same log and a different PID profile or rate profile. ' + SOURCE_7 + '">Values possibly different</div></li>'), card('cyclic'));
    assert.ok(card('governor').includes('<li>Increase the governor F gain</li>'), 'a recommendation without stale: no mark');
    // "Show in the log" of the item: the panel shows the parts of its time window whose values are possibly not those of the log header
    app.click('log', { 'data-row': app.rowId('c12'), 'data-at': 'issue' });
    await flush();
    eq(app.reads.pop(), { li: 0, t0: 4.1, t1: 12.9, fields: ['setpoint[0]', 'gyroADC[0]', 'axisError[0]'] }, 'the read of the panel as before');
    const slot = app.dom.part('[data-analysis-cmp]').innerHTML;
    assert.ok(slot.includes('<div class="analysis-compare-epochs log-lens-epochs"><h6 class="log-lens-sub">Values possibly different <span class="log-lens-count">8.8 s of 8.8 s</span></h6>'), slot);
    assert.ok(slot.includes('<strong>A second arm in the same log and a different PID profile or rate profile</strong> <span class="log-lens-epoch-meta">4.0 s to 30.0 s · PID profile 2, values from log 7</span>'), slot);
    assert.ok(app.plots.length >= 2 && app.plots.slice(-2).every((p) => !p.destroyed), 'the plots of the panel');
    // a window in the fresh part: no rows
    app.click('log', { 'data-row': app.rowId('t8'), 'data-at': 'row' });
    await flush();
    assert.ok(!app.dom.part('[data-analysis-cmp]').innerHTML.includes('analysis-compare-epochs'), 'T8 at 115.6 s: a fresh part');
});

test('values possibly not from the log header: no summary without epochs; the caveat when no result has such values; a mark without a source says "unknown"', async () => {
    const plain = await shown({ result: synthIssues(synthResult()) });
    assert.ok(!plain.verdict().includes('analysis-epoch'), 'an older result: no summary and no mark');
    const none = synthIssues(synthResult());
    none.freshness = FRESHNESS;
    none.epochs = [{ log: 0, spans: [{ t0: 0, t1: LEN, fresh: true, reasons: [], pidProfile: 1, rateProfile: 0, source: { pid: 'header', rate: 'header' }, text: '' }] }];
    const app = await shown({ result: none });
    assert.ok(app.verdict().includes('<div class="analysis-epochs"><p class="analysis-muted">The log shows no cause for values that are not the values of the log header.</p><p class="analysis-muted">' +
        FRESHNESS.caveat + ' Thus, a result with no mark can also use values that are not the values of the log header.</p></div>'), app.verdict());
    assert.ok(!app.verdict().includes('class="analysis-epoch"'));
    const I = app.I;
    assert.equal(I.epochHtml(null), '');
    assert.ok(I.epochHtml({ reasons: ['resume'], source: '' }).includes('<div class="analysis-epoch-why">Cause: a period with no data.</div><div class="analysis-epoch-src">The source of the values is unknown.</div>'));
    assert.ok(I.epochHtml({ reasons: ['adjusted'], text: 'An in-flight adjustment changed "pitch_P" to 50 at 12 s.' })
        .includes('<div class="analysis-epoch-src">An in-flight adjustment changed &quot;pitch_P&quot; to 50 at 12 s.</div>'), 'no source of the worker: its text');
    assert.ok(I.epochHtml({ reasons: [], findings: 3, source: HOSTILE }, 5).includes('<div class="analysis-epoch-why">3 of 5 results.</div><div class="analysis-epoch-src">&lt;img'), 'escaped');
    assert.ok(I.epochHtml({}).includes('<div class="analysis-epoch-body"><div class="analysis-epoch-src">The source of the values is unknown.</div>'), 'nothing known: "unknown"');
    eq(I.epochSummaryHtml({ findings: [] }, []), '');
    // a result with one such result and one recommendation: the singular
    const one = withStale(synthIssues(synthResult()));
    for (const f of one.findings) if (f.fid !== 'c12') f.stale = null;
    assert.ok(I.epochSummaryHtml(one, I.rowsOf(one)).includes('1 of 21 results uses values that are possibly not the values of the log header. 1 of 4 recommendations uses these results.'));
});
