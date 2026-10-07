// The log lens (js/log_lens.js) in node:vm with stand-ins for the DOM, the canvas, the timers, TuningPlot,
// TuningSnippet.Reader and the hooks of js/main.js: it renders with and without a result, shows in each window the results
// whose evidence spans overlap it (synthetic results with known spans), reads and derives once 150 ms after the last
// change and drops an answer for an older window, moves with the wheel, a pull on the timeline and the arrow keys, keeps
// the viewer in step, opens "Show in the log" and the plots of "Show", escapes what comes from the log and the workers,
// compares with the toolkit's own limits, and is registered in index.html and gulpfile.js. The derive stand-in answers in
// the shapes of js/tuning_worker.js DERIVE (window items, { cols }, { f, psd, amplitude }).
// test/ste_text.test.cjs runs these tests again to read every text that the lens writes.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const HOSTILE = '<img src=x onerror=alert(1)>"\'&';
const RATE = 1000, LEN = 300;
const ALL_FIELDS = ['setpoint[0]', 'setpoint[1]', 'setpoint[2]', 'gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]', 'gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]',
    'axisD[0]', 'axisD[1]', 'axisD[2]', 'mixer[2]', 'mixer[3]', 'headspeed', 'govTarget'];
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const kind = (x) => Object.prototype.toString.call(x).slice(8, -1); // typed arrays of the vm realm fail instanceof here
// Objects and arrays made in the vm realm have its prototypes, which deepStrictEqual compares: compare them as JSON
const eq = (got, want, what) => assert.deepEqual(JSON.parse(JSON.stringify(got)), want, what);

// --- stand-ins -------------------------------------------------------------------------------------------------

// The lens reaches its parts with unique selectors, so one stand-in element for each selector does: it records what the
// lens writes there, its listeners, and draws into a recording 2D context
function fakeDom() {
    const parts = new Map(), doc = {};
    function context() {
        const ctx = { calls: [], texts: [] };
        for (const m of ['fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'setTransform', 'clearRect', 'save', 'restore']) {
            ctx[m] = (...a) => ctx.calls.push({ m, a, fill: ctx.fillStyle, stroke: ctx.strokeStyle, alpha: ctx.globalAlpha === undefined ? 1 : ctx.globalAlpha });
        }
        ctx.fillText = (s, x, y) => { ctx.texts.push(String(s)); ctx.calls.push({ m: 'fillText', a: [s, x, y] }); };
        return ctx;
    }
    function element(sel) {
        const listeners = {}, ctx = context();
        return { sel, innerHTML: '', textContent: '', listeners, ctx, width: 0, height: 0, clientWidth: 800, clientHeight: 96, firstChild: { focus() {} },
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
        addEventListener(type, fn) { (doc[type] = doc[type] || []).push(fn); },
        removeEventListener(type, fn) { doc[type] = (doc[type] || []).filter((f) => f !== fn); },
    };
    return { root: element('#logLensBody'), part, parts, document, doc };
}

// An event whose target is inside the lens: closest(selector) finds the elements of `at` ({ selector: attributes })
// A change of one of the two filters of the result list (SPEC3 E): its checkbox data-lens-rf="thin" or "ok"
function rfEvent(kind, checked) {
    return { target: { getAttribute: (k) => (k === 'data-lens-rf' ? kind : null), checked } };
}

function event(at, extra = {}) {
    const target = { tagName: extra.tagName || 'DIV', closest: (sel) => (sel in at ? { getAttribute: (k) => (k in at[sel] ? String(at[sel][k]) : null) } : null) };
    return Object.assign({ target, prevented: false, preventDefault() { this.prevented = true; }, button: 0 }, extra);
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
        pending: () => list.length,
    };
}

// Log `current` of `count` starts at tMin(i) = (100 + 1000 i) s and lasts LEN s; the activity summary every 0.128 s,
// PID profile 1 to 150 s and 2 after
function fakeLog({ count = 3, current = 1, fields = new Set(ALL_FIELDS), error = false } = {}) {
    const tMin = (i) => 1e6 * (100 + 1000 * i), times = [], avgThrottle = [], pidProfile = [];
    for (let k = 0; k * 0.128 <= LEN; k++) {
        const t = k * 0.128;
        times.push(tMin(current) + t * 1e6);
        avgThrottle.push(t < 20 || t > 280 ? 100 : 600);
        pidProfile.push(t < 150 ? 1 : 2);
    }
    return { tMin, getLogCount: () => count, getLogIndex: () => current, getLogError: () => error, getMinTime: (i = current) => tMin(i),
        getMaxTime: (i = current) => tMin(i) + LEN * 1e6, getMainFieldIndexByName: (n) => (fields.has(n) ? 1 : undefined),
        getActivitySummary: () => ({ times, avgThrottle, collective: [], hasEvent: [], pidProfile }), getSysConfig: () => ({}) };
}

// The window at RATE: roll setpoint a 1 Hz sine of 50 deg/s and the gyro 25 ms after it, headspeed and target 2000 rpm,
// the tail output a 0.5 Hz sine of 300 permille
const SIGNAL = {
    'setpoint[0]': (t) => 50 * Math.sin(2 * Math.PI * t), 'gyroADC[0]': (t) => 50 * Math.sin(2 * Math.PI * (t - 0.025)),
    'setpoint[1]': (t) => 20 * Math.sin(2 * Math.PI * 0.5 * t), 'gyroADC[1]': (t) => 18 * Math.sin(2 * Math.PI * 0.5 * t),
    'setpoint[2]': () => 0, 'gyroADC[2]': (t) => 2 * Math.sin(2 * Math.PI * 12 * t), headspeed: () => 2000, govTarget: () => 2000,
    'mixer[2]': (t) => 300 * Math.sin(Math.PI * t), 'mixer[3]': () => 100,
};
function snippet(t0, t1, fields, present) {
    const n = Math.floor((t1 - t0) * RATE + 1e-9) + 1, t = Float64Array.from({ length: n }, (_, i) => t0 + i / RATE), cols = {}, missing = [];
    for (const f of fields) {
        if (!present.has(f)) { missing.push(f); continue; }
        cols[f] = Float32Array.from(t, (x) => (SIGNAL[f] || ((s) => Math.sin(2 * Math.PI * 120 * s)))(x));
    }
    return { log: 1, t0, t1, t, cols, missing, frames: n, rate: RATE, clipped: false, source: 'viewer' };
}

// derive("window") as js/tuning_worker.js windowStats answers: { t0, t1, seconds, padS, items, notes }
function synthValues(edit) {
    const item = (o) => Object.assign({ axis: null, value: null, unit: null, limits: [], over: 0, status: 'satisfactory', n: 0, detail: {}, checkNoun: null, text: '' }, o);
    const track = [{ value: 0.3, level: 'note' }, { value: 0.45, level: 'flag' }];
    let items = [
        item({ key: 'track.roll', check: 'C12', axis: 'roll', unit: 'fraction', value: 0.34, n: 6200, status: 'monitor', over: 1, limits: track,
            detail: { tauMs: 26, tauSource: 'fitted', seconds: 6.2 }, text: 'The roll tracking error is 34.0 % of the setpoint.' }),
        item({ key: 'track.pitch', check: 'C12', axis: 'pitch', unit: 'fraction', value: 0.5, status: 'monitor', over: 2, limits: track, detail: { tauMs: 70, seconds: 5 } }),
        item({ key: 'track.yaw', check: 'T11', axis: 'yaw', unit: 'fraction', status: 'insufficient', limits: track, text: 'The yaw setpoint is ' + HOSTILE }),
        item({ key: 'osc.roll', check: 'C5', axis: 'roll', unit: 'deg/s', value: 25.1, status: 'monitor', over: 1, limits: [{ value: 20, level: 'note' }], detail: { band: [10, 20], hz: 12.3 } }),
        item({ key: 'osc.pitch', check: 'C5', axis: 'pitch', unit: 'deg/s', value: 4.2, limits: [{ value: 20, level: 'note' }], detail: { band: [8, 16], hz: 9.1 } }),
        item({ key: 'osc.yaw', check: 'T1', axis: 'yaw', status: 'notMeasured', text: 'The log does not record "gyroADC[2]".' }),
        item({ key: 'gov.error', check: 'G2', unit: 'fraction', value: 0.004, status: 'monitor', over: 1,
            limits: [{ value: 0.01, level: 'flag', what: 'median' }, { value: 0.02, level: 'flag', what: 'p5..p95' }],
            detail: { reference: 'govTarget', median: -0.004, p5: -0.012, p95: 0.025, seconds: 9.5 } }),
        item({ key: 'tail.limit', check: 'T8', unit: 's', value: 0.42, n: 3, status: 'monitor', over: 1, limits: [{ value: 0, level: 'flag' }],
            detail: { lo: -400, hi: 400, limitSource: 'window', periods: 3 } }),
        item({ key: 'dterm.roll', check: 'C11', axis: 'roll', unit: 'fraction', value: 0.31, limits: [{ value: 0.5, level: 'flag' }], detail: { hz: 30 } }),
        item({ key: 'dterm.pitch', check: 'C11', axis: 'pitch', unit: 'fraction', value: 0.2, limits: [{ value: 0.5, level: 'flag' }], detail: { hz: 30 } }),
        item({ key: 'dterm.yaw', check: 'F10', axis: 'yaw', unit: 'fraction', value: 0.62, status: 'monitor', over: 1, limits: [{ value: 0.5, level: 'flag' }], detail: { hz: 30 } }),
        item({ key: 'lines.roll', check: 'F5', axis: 'roll', unit: 'deg/s', value: 3.2, status: 'information',
            detail: { rotorHz: 33.33, lines: [{ hz: 155.7, amplitude: 3.2, prominence: 12, order: 4.671, notch: { hz: 66.7, distance: 0.5716 } }, { hz: 66.7, amplitude: 1.1, prominence: 4, order: 2.001 }] } }),
        item({ key: 'lines.pitch', check: 'F5', axis: 'pitch', unit: 'deg/s', value: 2.1, status: 'information',
            detail: { lines: [{ hz: 66.7, amplitude: 2.1, prominence: 9, order: 2.001, notch: { hz: 66.7, distance: 0 } }] } }),
        item({ key: 'lines.yaw', check: 'F5', axis: 'yaw', unit: 'deg/s', status: 'information', detail: { lines: [] },
            text: 'The yaw gyro spectrum has no line of 3 × its median amplitude or more (check F5).' }),
    ];
    if (edit) items = edit(items);
    return { kind: 'window', rate: RATE, t0: 9.5, t1: 20, seconds: 10, padS: 0.5, items, notes: ['The log does not record "govTarget".'] };
}

// A result of log 1 whose findings have evidence spans in frame seconds (SPEC2 3.3): the ground truth of each window
function synthResult(over = {}) {
    const span = (t0, t1, log = 1, label = '') => ({ log, t0, t1, value: null, label });
    const ev = (fid, spans, view = null) => ({ v: 1, fid, spans, view, plot: null, expected: '', summary: '', context: [] });
    const f = (o) => Object.assign({ module: 'track', log: 1, profile: 1, se: null, n: 10, unit: null, threshold: null, source: 'pipeline, unvalidated',
        text: 'toolkit text of ' + o.id, summary: 'Check ' + o.id + ' has a result.' }, o, { evidence: ev(o.fid, o.spans || [], o.view || null) });
    const findings = [
        f({ fid: 'fA', id: 'C12', axis: 'roll', severity: 'flag', value: 0.52, se: 0.03, unit: 'fraction', threshold: 'value - 2 SE > 0.45 flag, value > 0.3 note',
            summary: 'Check C12, roll: the tracking error is 52 ± 3 % of the setpoint.', spans: [span(5, 12)],
            view: { log: 1, t0: 4.5, t1: 12.5, at: 8, graphs: [['setpoint[0]', 'gyroADC[0]'], ['axisError[0]']], analyser: null } }),
        f({ fid: 'fB', id: 'C5', axis: 'pitch', severity: 'note', value: 0.08, se: 0.01, unit: 'fraction', spans: [span(19.5, 25)] }),
        f({ fid: 'fC', id: 'G2', module: 'gov', severity: 'ok', value: -0.004, se: 0.001, threshold: { median: 0.01, band: 0.02, source: 'x' }, spans: [span(30, 31)] }),
        f({ fid: 'fD', id: 'T1', axis: 'yaw', severity: 'flag', log: 2, spans: [span(10, 15, 2)] }),
        f({ fid: 'fE', id: 'D1', module: 'setup', severity: 'flag', spans: [] }),
        f({ fid: 'fF', id: 'F5', module: 'setup', severity: 'flag', value: 4.06, spans: [span(0, 3), span(14, 16)] }),
        f({ fid: 'fG"><b>x', id: 'C11', module: 'loop', axis: 'roll', severity: 'flag', value: 0.7, summary: 'Check C11 shows "D-term & gyro" in the result.', text: HOSTILE, threshold: HOSTILE,
            spans: [span(16, 17, 1, HOSTILE)] }),
        f({ fid: 'fH', id: 'C13', axis: 'roll', severity: 'note', thin: true, value: null, spans: [span(8, 9)] }),
        f({ fid: 'fI', id: 'R1', axis: 'yaw', severity: 'note', value: 35, unit: 'ms', spans: [span(12, 13)] }),
        f({ fid: 'fJ', id: 'T8', module: 'loop', severity: 'flag', explained: 'Tail output', value: 1.3, spans: [span(40, 42)] }),
        f({ fid: 'fK', id: 'C12', axis: 'pitch', severity: 'error', value: null, spans: [span(100, 101)] }),
        f({ fid: 'fT', id: 'C13', axis: 'roll', severity: 'note', value: 26, unit: 'ms', spans: [span(200, 210)] }),
    ];
    const n = LEN * 10, t = Float32Array.from({ length: n }, (_, i) => i / 10);
    const curves = [{ log: 1, segment: 0, fromS: 0, seconds: LEN, track: {}, more: {
        gov: { t, hs: Float32Array.from(t, (x) => (x < 20 ? 100 * x : 2000)), target: Float32Array.from(t, () => 2000), profile: Uint8Array.from(t, (x) => (x < 150 ? 1 : 2)) },
        tail: { t, limits: { lo: -400, hi: 400 } },
        vib: { rotorHz: 2000 / 60, notches: { roll: [{ hz: 66.7, q: 8, label: 'main 2x' }], pitch: [{ hz: 66.7, q: 8, label: 'main 2x' }], yaw: [] } } } }];
    return Object.assign({ version: 1, scope: 'log', fileName: 'flight.bbl', logIndex: 1, logs: [1], findings, curves }, over);
}

// The lens over a fake viewer. opts: result (given through getResult), reader / derive 'auto' or 'manual' (each call
// waits for call.resolve), fields (the fields of the log), view ([t0, t1] of the viewer in frame seconds), values,
// noRunHook (no hooks.runAnalysis: the verdict of js/analysis_view.js has the button), noTuningDialog (js/tuning_dialog.js,
// whose pure parts draw "Show the measurement", is not loaded)
function setup(opts = {}) {
    const dom = fakeDom(), clock = fakeClock(), plots = [], reads = [], derives = [], errors = [];
    const present = opts.fields || new Set(ALL_FIELDS);
    let log = fakeLog({ fields: present, error: opts.logError }), current = opts.result === undefined ? null : opts.result, view = opts.view || [10, 20];
    const calls = { setViewerWindow: [], viewInLog: [], runAnalysis: 0, onResult: [] };
    function Reader(hooks) { this.hooks = hooks; }
    Reader.prototype.read = function (li, t0, t1, fields) {
        const call = { li, t0, t1, fields: [...fields] };
        reads.push(call);
        if (opts.reader === 'manual') return new Promise((resolve, reject) => { call.resolve = () => resolve(snippet(t0, t1, fields, present)); call.reject = reject; });
        if (opts.readError) return Promise.reject(new Error(opts.readError));
        if (opts.readDelay) return new Promise((resolve) => setImmediate(() => resolve(snippet(t0, t1, fields, present))));
        return Promise.resolve(snippet(t0, t1, fields, present));
    };
    function answer(k, cols, rate, params) {
        if (k === 'window') { // opts.values: the answer, or a function of the params (the notch distances of the worker)
            const v = typeof opts.values === 'function' ? opts.values(params) : opts.values === undefined ? synthValues() : opts.values;
            if (v && !params.notchHz) v.items.forEach((q) => (q.detail.lines || []).forEach((l) => { delete l.notch; })); // the worker measures notch distances only with notchHz
            return v;
        }
        if (k === 'spectrum') {
            const N = params.N, f = Float32Array.from({ length: N / 2 + 1 }, (_, i) => i * rate / N), psd = {}, amplitude = {};
            for (const name of Object.keys(cols)) { psd[name] = Float32Array.from(f, () => 1); amplitude[name] = Float32Array.from(f, () => 0.5); }
            return { kind: k, rate, f, psd, amplitude, windows: 4, N };
        }
        return { kind: k, rate, cols }; // lowpass, bandpass: the columns as they came
    }
    const context = vm.createContext({
        document: dom.document, devicePixelRatio: 2, console: { log() {}, warn() {}, error: (e) => errors.push(e) },
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        ResizeObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} },
        TuningSnippet: opts.noReader ? undefined : { Reader, CALL_S: 12, MAX_S: 60 },
    });
    vm.runInContext(read('js/tuning_plot.js'), context, { filename: 'js/tuning_plot.js' }); // the real niceTicks
    context.TuningPlot.attach = (canvas, spec) => {
        const h = { canvas, spec, specs: [spec], destroyed: false, update(s) { h.spec = s; h.specs.push(s); }, destroy() { h.destroyed = true; } };
        plots.push(h);
        return h;
    };
    if (!opts.noTuningDialog) vm.runInContext(read('js/tuning_dialog.js'), context, { filename: 'js/tuning_dialog.js' }); // curveSeries, compareSpec, toFrame
    vm.runInContext(read('js/log_lens.js'), context, { filename: 'js/log_lens.js' });
    const hooks = {
        getViewerWindow: () => ({ t0us: log.tMin(1) + view[0] * 1e6, t1us: log.tMin(1) + view[1] * 1e6 }),
        setViewerWindow: (a, b) => calls.setViewerWindow.push([a, b]),
        viewInLog: (req) => { calls.viewInLog.push(req); return true; },
        getBytes: () => new Uint8Array(10), getFileName: () => 'flight.bbl', getCurrentLogIndex: () => 1, getFlightLog: () => log,
        runAnalysis: () => { calls.runAnalysis++; return opts.runAnalysis ? opts.runAnalysis() : true; },
        getResult: () => current, onResult: (cb) => calls.onResult.push(cb),
    };
    if (opts.noRunHook) hooks.runAnalysis = null;
    if (opts.hooks) Object.assign(hooks, opts.hooks); // the hooks of js/main.js that a test gives (SPEC3 E: the filters of the lists)
    if (!opts.noDerive) {
        hooks.derive = (k, cols, rate, params, transfer) => {
            const call = { kind: k, cols, rate, params, transfer };
            derives.push(call);
            if (opts.derive === 'manual') return new Promise((resolve, reject) => { call.resolve = (v) => resolve(v === undefined ? answer(k, cols, rate, params) : v); call.reject = reject; });
            return Promise.resolve(answer(k, cols, rate, params));
        };
    }
    const lens = new context.LogLens(dom.root, hooks);
    const part = (name) => dom.part(`[data-lens="${name}"]`);
    const html = (name) => part(name).innerHTML;
    const timeline = part('timeline');
    const allHtml = () => [dom.root.innerHTML, ...[...dom.parts.values()].map((p) => p.innerHTML + '\n' + p.textContent)].join('\n');
    return {
        context, dom, clock, lens, hooks, calls, plots, reads, derives, errors, timeline, part, html, allHtml, internals: context.LogLens.internals,
        get log() { return log; }, setView(v) { view = v; },
        give(r) { current = r; for (const cb of calls.onResult) cb(r); },
        fire(type, ev) { for (const l of dom.root.listeners[type] || []) l.fn(ev); return ev; },
        key(k, extra) { return this.fire('keydown', event({}, Object.assign({ key: k }, extra))); },
        wheel(extra) { return this.fire('wheel', event({ '[data-lens-wheel]': {} }, extra)); },
        click(act, attrs = {}) { return this.fire('click', event({ '[data-lens-act]': Object.assign({ 'data-lens-act': act }, attrs) })); },
        win() { return lens.internals.getWindow(); },
        text() { return part('window').textContent; },
        fids() { return [...html('findings').matchAll(/data-lens-act="log" data-fid="([^"]*)"/g)].map((m) => m[1]); },
        // the client x of time t on the timeline: canvas 800 css px at left 10, the lens PAD of 6 px on each side
        xAt(t) { return 10 + 6 + (800 - 12) * t / LEN; },
    };
}

async function shown(opts) {
    const app = setup(opts);
    app.lens.show(app.log);
    await flush();
    return app;
}

// The window of the lens from the head text "Time window: 10.0 s to 20.0 s (10.0 s)"
function windowOf(app) {
    const m = /(-?[\d.]+) s to (-?[\d.]+) s/.exec(app.text());
    return m ? [+m[1], +m[2]] : null;
}

function near(got, want, tol, what) {
    assert.ok(Math.abs(got - want) <= tol, `${what}: ${got} is not ${want} ± ${tol}`);
}

// The calls of the last drawing of the timeline: from its last full background fill
function lastDraw(ctx) {
    let k = -1;
    ctx.calls.forEach((c, i) => { if (c.m === 'fillRect' && c.a[0] === 0 && c.a[1] === 0) k = i; });
    return ctx.calls.slice(k);
}

// --- tests ----------------------------------------------------------------------------------------------------

test('the pure window rules: clamp to the log and to 0.5-60 s, wheel notches, D9 status words', () => {
    const I = setup().internals;
    eq(I.clampWindow(10, 20, LEN), [10, 20]);
    eq(I.clampWindow(-5, 5, LEN), [0, 10], 'moved inside the start');
    eq(I.clampWindow(295, 305, LEN), [290, 300], 'moved inside the end');
    const short = I.clampWindow(10, 10.1, LEN), long = I.clampWindow(0, 200, LEN);
    near(short[0], 9.8, 1e-9, 'MIN_S about the centre');
    near(short[1] - short[0], 0.5, 1e-9, 'MIN_S');
    near(long[1] - long[0], 60, 1e-9, 'MAX_S');
    eq(I.clampWindow(0, 200, 20), [0, 20], 'a log shorter than 60 s');
    assert.equal(I.wheelSteps({ deltaY: 100, deltaMode: 0 }), 1);
    assert.equal(I.wheelSteps({ deltaY: -250, deltaMode: 0 }), -1, 'one notch at most');
    assert.equal(I.wheelSteps({ deltaY: 5, deltaMode: 0 }), 0.05, 'a touchpad: in proportion');
    near(I.wheelSteps({ deltaY: 3, deltaMode: 1 }), 1, 1e-12, 'lines');
    assert.equal(I.wheelSteps({ deltaX: -40, deltaY: 10, deltaMode: 0 }), -0.4, 'the larger of x and y');
    const s = (o) => I.statusOf(Object.assign({ id: 'C12', text: '' }, o));
    assert.equal(s({ severity: 'flag' }), 'problem');
    assert.equal(s({ severity: 'flag', explained: 'x' }), 'information');
    assert.equal(s({ severity: 'note' }), 'monitor');
    assert.equal(s({ severity: 'note', thin: true }), 'insufficient');
    assert.equal(s({ severity: 'note', text: 'no finding: 2 blocks' }), 'insufficient', 'the thin notes of the other session (D5)');
    assert.equal(s({ severity: 'note', id: 'R1' }), 'information', 'report-only check');
    assert.equal(s({ severity: 'ok' }), 'satisfactory');
    assert.equal(s({ severity: 'skipped' }), 'notMeasured');
    assert.equal(s({ severity: 'error' }), 'error');
    assert.equal(s({ severity: 'flag', status: 'monitor' }), 'monitor', 'a status from the worker wins');
    eq(Object.keys(I.STATUS).map((k) => I.STATUS[k][0]), ['Analysis error', 'Problem', 'Monitor', 'Not sufficient data', 'Information', 'Satisfactory', 'Not measured']);
});

test('the results that each window shows: evidence spans of this log that overlap it, the worst first', () => {
    const I = setup().internals, fs = synthResult().findings, ids = (t0, t1, li = 1) => Array.from(I.overlapping(fs, li, t0, t1), (o) => o.f.fid);
    // ground truth from the spans of synthResult: fA 5-12, fB 19.5-25, fF 0-3 and 14-16, fG 16-17, fH 8-9, fI 12-13
    assert.deepEqual(ids(10, 20), ['fG"><b>x', 'fA', 'fF', 'fB', 'fI'], 'problems C11, C12, F5, then monitor C5, then information R1');
    assert.deepEqual(ids(28, 38), ['fC']);
    assert.deepEqual(ids(0, 4), ['fF']);
    assert.deepEqual(ids(7.5, 9.5), ['fA', 'fH']);
    assert.deepEqual(ids(12, 12), ['fA', 'fI'], 'touching ends overlap');
    assert.deepEqual(ids(50, 60), []);
    assert.deepEqual(ids(10, 15, 2), ['fD'], 'the spans of log 2 only on log 2');
    eq(I.overlapping(fs, 1, 0, 20).find((o) => o.f.fid === 'fF').spans.map((q) => [q.t0, q.t1]), [[0, 3], [14, 16]]);
    assert.deepEqual(ids(0, LEN).filter((x) => x === 'fE'), [], 'a header check has no span');
    assert.equal(I.overlapping(fs, 1, 99, 102)[0].status, 'error');
});

test('without a result: the window of the viewer, the values of derive("window") and "Start the analysis"', async () => {
    const app = await shown({ result: null });
    assert.deepEqual(windowOf(app), [10, 20]);
    assert.deepEqual(app.calls.setViewerWindow, [], 'show() takes the window of the viewer and writes nothing back');
    assert.equal(app.reads.length, 1);
    assert.deepEqual([app.reads[0].li, app.reads[0].t0, app.reads[0].t1], [1, 9.5, 20.5], 'the window and a pad of 0.5 s on each side');
    assert.deepEqual(app.reads[0].fields, ALL_FIELDS);
    const d = app.derives.filter((c) => c.kind === 'window');
    assert.equal(d.length, 1);
    assert.equal(d[0].rate, RATE);
    assert.equal(kind(d[0].cols['setpoint[0]']), 'Float32Array');
    assert.equal(d[0].cols['setpoint[0]'].length, 11001);
    eq(d[0].params, { t0: 9.5, padS: 0.5, tauMs: { roll: null, pitch: null, yaw: null }, tailLimits: null, notchHz: null, lines: 3 },
        'no result: the worker fits the time delay and finds the tail limits');
    const values = app.html('values');
    for (const s of ['Tracking error, roll', '34.0 %', 'More than 30 %', '30 % and 45 %', 'C12', 'Time delay: 26 ms. Data: 6.2 s.', 'More than 45 %', 'T11',
        'Not sufficient data', 'The yaw setpoint is &lt;img', 'Oscillation, roll, 10-20 Hz', '25.1 deg/s', 'More than 20 deg/s', 'At 12.3 Hz.', '20 deg/s or less',
        'Not measured', 'The log does not record &quot;gyroADC[2]&quot;.', 'Headspeed error, median', '-0.40 %', '1 % or less',
        'Headspeed error, 90 % of the samples', '-1.20 % to 2.50 %', 'More than 2 %', '0.42 s in 3 periods', '1 period or more', 'Limits: -400 ‰ and 400 ‰.',
        'D-term power at more than 30 Hz, yaw', '62.0 %', 'F10', 'More than 50 %', '50 % or less', 'Gyro lines, roll', '155.7 Hz, 3.2 deg/s',
        'Lines: 155.7 Hz (4.67 × the rotor frequency), 66.7 Hz (2.00 × the rotor frequency).', 'Prominence 5 or more', 'The notch filters are not available without an analysis result.',
        'The yaw gyro spectrum has no line', 'The log does not record &quot;govTarget&quot;.']) {
        assert.ok(values.includes(s), s);
    }
    assert.equal((values.match(/data-lens-act="show"/g) || []).length, 13, 'a "Show" for each row with a value: track 2, osc 2, gov 2, tail 1, D-term 3, lines 3');
    assert.match(app.html('notice'), /data-lens-act="start"[^>]*>Start the analysis</);
    assert.equal(app.html('findings'), '', 'no results section without a result');
    app.click('start');
    assert.equal(app.calls.runAnalysis, 1);
    assert.match(app.html('notice'), /The analysis started\. Wait for the results\./);
    assert.match(app.html('notice'), /data-lens-act="start" disabled/);
    // the timeline: the throttle of the log index, the PID profiles, the window as a box at 10-20 s
    const ctx = app.timeline.ctx;
    assert.ok(ctx.texts.includes('Throttle'));
    assert.ok(ctx.texts.includes('PID profile 1') && ctx.texts.includes('PID profile 2'));
    assert.ok(ctx.texts.includes('0 s') && ctx.texts.includes('100 s'), ctx.texts.join('|'));
    const box = ctx.calls.filter((c) => c.m === 'strokeRect').pop();
    near(box.a[0], 6 + 788 * 10 / LEN, 1e-9, 'box left');
    near(box.a[2], 788 * 10 / LEN, 1e-9, 'box width');
    // the strip charts of the window
    assert.deepEqual(app.plots.map((p) => /data-chart="(\w+)"/.exec(p.canvas.sel)[1]), ['roll', 'pitch', 'yaw', 'gov', 'tail', 'dterm']);
    const roll = app.plots[0].spec;
    eq([roll.x.min, roll.x.max], [10, 20], 'the window, without the pad');
    eq(roll.series.map((q) => q.name), ['setpoint', 'gyro', 'error']);
    const i = 2500, sp = roll.series[0].y[i], gy = roll.series[1].y[i];
    near(roll.series[2].y[i], sp - gy, 1e-4, 'error = setpoint - gyro');
    assert.equal(app.plots[5].spec.x.label, 'time', 'the last chart has the time axis title');
    assert.equal(app.plots[0].spec.x.label, undefined);
    eq(app.plots[4].spec.hlines.map((h) => h.y), [-400, 400], 'the tail limits that the worker found in the window');
});

test('with a result: the panel lists the results of the window, and they follow the window', async () => {
    const app = await shown({ result: synthResult() });
    assert.deepEqual(app.fids(), ['fG&quot;&gt;&lt;b&gt;x', 'fA', 'fF', 'fB', 'fI']);
    const h = app.html('findings');
    assert.match(h, /Results in this time window <span class="log-lens-count">5<\/span>/);
    for (const s of ['Problem', 'Monitor', 'Information', 'Check C12, roll: the tracking error is 52 ± 3 % of the setpoint.', 'Value: 52.0 ± 3.0 %.',
        'Limit: <code>value - 2 SE &gt; 0.45 flag, value &gt; 0.3 note</code>', 'Time in the log: 5.0 s to 12.0 s.', 'C12, roll, PID profile 1',
        'Time in the log: 14.0 s to 16.0 s.', 'Show in the log', 'Show the measurement', 'Toolkit text (not STE)']) {
        assert.ok(h.includes(s), s);
    }
    assert.match(h, /data-lens-act="compare" data-fid="fA" data-arg="track:roll"/);
    assert.match(h, /data-lens-act="compare" data-fid="fF" data-arg="lines:roll"/);
    assert.ok(!/data-lens-act="compare" data-fid="fI"/.test(h), 'R1 has no plot in the lens');
    assert.match(h, /<details data-ste="quoted"><summary>Toolkit text \(not STE\)<\/summary>toolkit text of C12<\/details>/);
    assert.equal(app.html('notice'), '', 'no notice with a result that has spans');
    // the timeline: headspeed of the result curves, the spans by status in the span strip
    const ctx = app.timeline.ctx;
    assert.ok(ctx.texts.includes('Headspeed'));
    const strip = lastDraw(ctx).filter((c) => c.m === 'fillRect' && c.a[1] === app.internals.timelineRows(96).S0); // the span strip of drawTimeline
    assert.equal(strip.length, 11, 'the 11 spans of log 1: none of log 2, none of a header check');
    const fF = strip.filter((c) => Math.abs(c.a[0] - (6 + 788 * 14 / LEN)) < 1e-9);
    assert.deepEqual(fF.map((c) => [c.fill, +c.a[2].toFixed(6)]), [['#c9483f', +(788 * 2 / LEN).toFixed(6)]], 'F5 at 14-16 s, as a problem');
    assert.ok(strip.some((c) => c.fill === '#3c9d40'), 'a satisfactory span');
    assert.ok(['#c9483f', '#ff5a4f'].includes(strip[strip.length - 1].fill), 'the worst drawn last, on top');
    const over = lastDraw(ctx).filter((c) => c.m === 'fillRect' && c.a[1] === app.internals.timelineRows(96).T && c.alpha === 0.16);
    assert.deepEqual([...new Set(over.map((c) => c.fill))].sort(), ['#c9483f', '#d99a1f', '#ff5a4f'], 'over the trace: only errors, problems and values to monitor');
    for (const s of ['Time window', 'Problem', 'Monitor', 'Satisfactory', 'Information', 'Not sufficient data', 'Analysis error']) assert.ok(app.html('legend').includes(s), s);
    // the window values use the time delay of C13 for PID profile 1, the tail limits and the notch filters of the result
    const d = app.derives.filter((c) => c.kind === 'window').pop();
    eq(d.params.tauMs, { roll: 26, pitch: null, yaw: null });
    eq(d.params.tailLimits, { lo: -400, hi: 400 });
    eq(d.params.notchHz, { roll: [66.7], pitch: [66.7], yaw: [] }, 'at the headspeed of the window (2000 rpm, as in the curves)');
    // the strip charts shade the spans of the results on their chart, cut to the window
    const bands = (key) => JSON.parse(JSON.stringify(app.plots.find((p) => p.canvas.sel.includes(`"${key}"`)).spec.bands.map((b) => [b.x0, b.x1, b.label])));
    assert.deepEqual(bands('roll'), [[10, 12, 'C12']]);
    assert.deepEqual(bands('pitch'), [[19.5, 20, 'C5']]);
    assert.deepEqual(bands('yaw'), [[12, 13, 'R1']]);
    assert.deepEqual(bands('dterm'), [[16, 17, 'C11']]);
    assert.deepEqual(bands('gov'), []);
    // with the notch filters, the worker gives the distance of each line: roll 57 % (none near), pitch 0 %
    const values = app.html('values');
    assert.ok(values.includes('No notch filter at 2 % or less'));
    assert.ok(values.includes('Notch filter at 2 % or less'));
    assert.ok(!values.includes('The notch filters are not available'));
    // the window moves: the list follows at once, before the debounce
    app.lens.internals.setWindow(28, 38);
    // SPEC3 E: a satisfactory result shows only with "Show satisfactory results", and the list says how many it does not show
    assert.deepEqual(app.fids(), []);
    assert.ok(app.html('findings').includes('Show satisfactory results (1)</label><span class="log-lens-muted">The list does not show 1 result.</span>'));
    assert.ok(!app.html('findings').includes('No result of the analysis is in this time window.'), 'the window has a result: the list does not show it');
    app.fire('change', rfEvent('ok', true));
    assert.deepEqual(app.fids(), ['fC']);
    assert.ok(app.html('findings').includes('Satisfactory'));
    app.lens.internals.setWindow(50, 60);
    assert.ok(app.html('findings').includes('No result of the analysis is in this time window.'));
    app.lens.internals.setWindow(7.5, 9.5);
    assert.deepEqual(app.fids(), ['fA'], 'the result with not sufficient data is not shown by default');
    app.fire('change', rfEvent('thin', true));
    assert.deepEqual(app.fids(), ['fA', 'fH']);
    assert.ok(app.html('findings').includes('Not sufficient data'));
});

test('a burst of changes reads and derives once, 150 ms after the last one', async () => {
    const app = await shown({ result: null });
    assert.equal(app.reads.length, 1);
    app.key('ArrowRight');
    app.clock.tick(50);
    app.key('ArrowRight');
    app.clock.tick(50);
    app.key('ArrowRight');
    assert.deepEqual(windowOf(app), [13, 23], 'each key at once on the timeline and the head');
    app.clock.tick(149);
    await flush();
    assert.equal(app.reads.length, 1, 'nothing read in the 150 ms');
    app.clock.tick(1);
    await flush();
    assert.equal(app.reads.length, 2);
    assert.deepEqual([app.reads[1].t0, app.reads[1].t1], [12.5, 23.5]);
    assert.equal(app.derives.filter((c) => c.kind === 'window').length, 2);
    assert.equal(app.clock.pending(), 0);
});

test('an answer for an older window is dropped, and one request at a time goes to the derive worker (B2)', async () => {
    const app = await shown({ result: null, derive: 'manual' });
    const first = app.derives[0];
    app.key('ArrowRight');
    app.clock.tick(150);
    await flush();
    assert.equal(app.derives.length, 1, 'no second request while the first is on its way: requests do not wait in a queue of the worker');
    assert.equal(app.reads.length, 1);
    const roll = (v) => synthValues((items) => items.map((q) => (q.key === 'track.roll' ? Object.assign({}, q, { value: v }) : q)));
    // more changes while the first is on its way: only the window of the last change goes next
    app.key('ArrowRight');
    app.clock.tick(150);
    app.key('ArrowRight');
    app.clock.tick(150);
    await flush();
    assert.equal(app.derives.length, 1);
    first.resolve(roll(0.1)); // late, for the window before
    await flush();
    assert.ok(!app.html('values').includes('10.0 %'), 'the late answer is dropped');
    assert.equal(app.reads.length, 2, 'then one read of the window as it is now');
    assert.deepEqual([app.reads[1].t0, app.reads[1].t1], [12.5, 23.5]);
    assert.equal(app.derives.length, 2);
    app.derives[1].resolve(roll(0.9));
    await flush();
    assert.ok(app.html('values').includes('90.0 %'));
    assert.equal(app.derives.length, 2, 'nothing more to ask');
    // the columns go to the worker as copies that it takes (the transfer list of js/tuning_dialog.js derive)
    assert.equal(app.derives[1].transfer, true);
    assert.ok(ArrayBuffer.isView(app.derives[1].cols['gyroADC[0]']), 'a typed array of its own');

    const r = setup({ result: null, reader: 'manual' });
    r.lens.show(r.log);
    await flush();
    r.key('ArrowRight');
    r.clock.tick(150);
    await flush();
    assert.equal(r.reads.length, 1, 'the read on its way first');
    r.reads[0].resolve(); // late
    await flush();
    assert.equal(r.derives.filter((c) => c.kind === 'window').length, 0, 'no values for the old window');
    assert.equal(r.reads.length, 2);
    r.reads[1].resolve();
    await flush();
    const w = r.derives.filter((c) => c.kind === 'window');
    assert.equal(w.length, 1);
    assert.equal(w[0].params.t0, 10.5, 'the read of the window 11-21 s, with its pad');
    assert.equal(r.plots.length, 6);
    assert.ok(r.plots.every((p) => p.specs.every((q) => q.x.min === 11 && q.x.max === 21)), 'the old data never reached the charts');
});

test('a new log drops the answers for the log before and its timer (B5)', async () => {
    const app = await shown({ result: null, derive: 'manual' });
    app.key('ArrowRight'); // a timer for the old log
    // another log of the file is open in the viewer, with an unreadable header
    const other = Object.assign({}, app.log, { getLogIndex: () => 2, getLogError: () => true });
    app.hooks.getFlightLog = () => other;
    app.hooks.getCurrentLogIndex = () => 2;
    app.lens.show(other);
    app.clock.tick(1000);
    await flush();
    assert.equal(app.reads.length, 1, 'no read of the old window after the new log');
    app.derives[0].resolve(); // the answer for the old log comes late
    await flush();
    assert.ok(!app.html('values').includes('Values in this time window'), 'the values of the old log do not show in the new log');
    assert.ok(app.html('notice').includes('No data that the app can read.'));
});

test('the mouse wheel moves the window by 10 % of its width; Ctrl or Cmd with the wheel zooms from 0.5 s to 60 s', async () => {
    const app = await shown({ result: null });
    assert.equal(app.dom.root.listeners.wheel[0].opts.passive, false, 'so that the page does not scroll');
    assert.ok(app.wheel({ deltaY: 100, deltaMode: 0 }).prevented);
    assert.deepEqual(windowOf(app), [11, 21]);
    app.wheel({ deltaY: -100, deltaMode: 0 });
    assert.deepEqual(windowOf(app), [10, 20]);
    app.wheel({ deltaY: 3, deltaMode: 1 });
    assert.deepEqual(windowOf(app), [11, 21], 'three lines are one notch');
    app.wheel({ deltaY: -20, deltaMode: 0 });
    near(app.win()[0], 10.8, 1e-9, 'a touchpad moves in proportion');
    app.lens.internals.setWindow(10, 20);
    app.wheel({ deltaY: 100, deltaMode: 0, ctrlKey: true });
    near(app.win()[1] - app.win()[0], 12.5, 1e-9, 'Ctrl: zoom out by 1.25');
    near((app.win()[0] + app.win()[1]) / 2, 15, 1e-9, 'about the centre');
    app.wheel({ deltaY: -100, deltaMode: 0, metaKey: true });
    near(app.win()[1] - app.win()[0], 10, 1e-9, 'Cmd: zoom in');
    for (let i = 0; i < 30; i++) app.wheel({ deltaY: -100, ctrlKey: true });
    near(app.win()[1] - app.win()[0], 0.5, 1e-9, 'MIN_S');
    for (let i = 0; i < 40; i++) app.wheel({ deltaY: 100, ctrlKey: true });
    near(app.win()[1] - app.win()[0], 60, 1e-9, 'MAX_S');
    for (let i = 0; i < 100; i++) app.wheel({ deltaY: 100 });
    eq(app.win(), [240, 300], 'the end of the log');
    const outside = app.fire('wheel', event({}, { deltaY: 100 }));
    assert.equal(outside.prevented, false, 'the wheel over the panel scrolls the page');
    eq(app.win(), [240, 300]);
    app.clock.tick(150);
    await flush();
    eq([app.reads[app.reads.length - 1].t0, app.reads[app.reads.length - 1].t1], [240, 300], 'a 60 s window reads no pad: TuningSnippet gives 60 s at most');
});

test('a pull on the timeline moves the window; a press outside the box centres the window there', async () => {
    const app = await shown({ result: null });
    const down = app.fire('mousedown', event({ '[data-lens="timeline"]': {} }, { clientX: app.xAt(15) }));
    assert.ok(down.prevented);
    assert.equal(app.dom.doc.mousemove.length, 1);
    app.dom.doc.mousemove[0]({ clientX: app.xAt(45) });
    near(app.win()[0], 40, 1e-9, 'the box keeps the point under the mouse');
    near(app.win()[1], 50, 1e-9, 'and its width');
    app.dom.doc.mouseup[0]({});
    assert.equal(app.dom.doc.mousemove.length, 0, 'the pull ends on mouseup');
    app.fire('mousedown', event({ '[data-lens="timeline"]': {} }, { clientX: app.xAt(150) }));
    near(app.win()[0], 145, 1e-9, 'centred on the press');
    app.dom.doc.mouseup[0]({});
    app.fire('mousedown', event({ '[data-lens="timeline"]': {} }, { clientX: app.xAt(150), button: 2 }));
    assert.equal(app.dom.doc.mousemove.length, 0, 'only the left button');
    app.clock.tick(150);
    await flush();
    assert.equal(app.calls.setViewerWindow.length, 1, 'one viewer move for the whole pull');
});

test('the left and right arrow keys move the window; not in a form field', async () => {
    const app = await shown({ result: null });
    assert.ok(app.key('ArrowRight').prevented);
    assert.deepEqual(windowOf(app), [11, 21]);
    app.key('ArrowLeft');
    app.key('ArrowLeft');
    assert.deepEqual(windowOf(app), [9, 19]);
    assert.equal(app.key('ArrowUp').prevented, false, 'up and down scroll the view');
    app.key('ArrowRight', { tagName: 'INPUT' });
    assert.deepEqual(windowOf(app), [9, 19]);
});

test('the viewer follows the window: setViewerWindow in log microseconds, once the changes stop', async () => {
    const app = await shown({ result: null }), tMin = app.log.tMin(1);
    app.key('ArrowRight');
    assert.deepEqual(app.calls.setViewerWindow, []);
    app.clock.tick(150);
    await flush();
    assert.deepEqual(app.calls.setViewerWindow, [[tMin + 11e6, tMin + 21e6]]);
    app.clock.tick(1000);
    await flush();
    assert.equal(app.calls.setViewerWindow.length, 1, 'a refresh with no change writes nothing');
    // back from the viewer: the lens takes its window again, as it is now
    app.lens.hide();
    app.setView([100, 104]);
    app.lens.show(app.log);
    assert.deepEqual(windowOf(app), [100, 104]);
    app.setView([-30, 90]);
    app.lens.show(app.log);
    eq(app.win(), [0, 60], 'a viewer window of 120 s from before the log start: 60 s at the start');
    await flush();
    assert.equal(app.calls.setViewerWindow.length, 1, 'show() never writes back');
});

test('"Show in the log" sends the evidence view of the result; "Show the measurement" opens its plot', async () => {
    const app = await shown({ result: synthResult() });
    app.click('log', { 'data-fid': 'fA' });
    eq(app.calls.viewInLog, [{ log: 1, fromS: 4.5, toS: 12.5, atS: 8, graphs: [['setpoint[0]', 'gyroADC[0]'], ['axisError[0]']], analyser: null,
        title: 'C12, roll, PID profile 1', text: 'Check C12, roll: the tracking error is 52 ± 3 % of the setpoint.', from: 'analysis' }]);
    app.click('log', { 'data-fid': 'fF' }); // no view: the span in the window
    assert.deepEqual([app.calls.viewInLog[1].fromS, app.calls.viewInLog[1].toS], [14, 16]);
    app.click('compare', { 'data-fid': 'fA', 'data-arg': 'track:roll' });
    await flush();
    const lp = app.derives.filter((c) => c.kind === 'lowpass').pop();
    assert.deepEqual(Object.keys(lp.cols), ['setpoint', 'gyro']);
    eq(lp.params, { hz: 30 });
    const plot = app.plots[app.plots.length - 1], spec = plot.spec;
    assert.match(plot.canvas.sel, /data-detail-plot="0"/);
    assert.equal(spec.title, 'Tracking error, roll: setpoint and gyro after a low-pass filter at 30 Hz');
    eq(spec.series.map((q) => q.name), ['setpoint, band of ± 45 % of its RMS', 'gyro, time delay of 26 ms removed', 'error']);
    // ground truth: the gyro 25 ms after a 1 Hz sine of 50 deg/s; with the 26 ms of the window values removed, 1 ms is left,
    // so the error is 2 pi 50 0.001 deg/s or less
    const sp = spec.series[0].y, g = spec.series[1].y, gyro = snippet(9.5, 20.5, ['gyroADC[0]'], new Set(ALL_FIELDS)).cols['gyroADC[0]'];
    for (const i of [0, 3000, 9000]) near(g[i], gyro[i + 26], 1e-4, 'the gyro 26 samples earlier');
    assert.ok(Number.isNaN(g[g.length - 10]), 'no gyro after the end of the data');
    let worst = 0;
    for (let i = 0; i < 9000; i++) worst = Math.max(worst, Math.abs(sp[i] - g[i]));
    assert.ok(worst <= 2 * Math.PI * 50 * 0.001 + 1e-3, `error ${worst}`);
    const w = sp.subarray(500, 10501), rms = Math.sqrt(w.reduce((s, v) => s + v * v, 0) / w.length);
    near(spec.series[0].hi[0] - sp[0], 0.45 * rms, 1e-3, 'the band is 45 % of the setpoint RMS in the window');
    eq(spec.bands.map((b) => [b.x0, b.x1, b.label]), [[10, 12, 'C12']], 'the span of the result, in the window');
    assert.match(app.html('detail'), /data-lens-act="close"/);
    assert.ok(app.html('detail-body').includes('Check C12 compares the RMS of the error with 30 % and 45 % of the RMS of the setpoint.'));
});

test('"Show" opens the derived plot of the window, follows the window and closes', async () => {
    const app = await shown({ result: synthResult() });
    app.click('show', { 'data-arg': 'lines:roll' });
    await flush();
    const sp = app.derives.filter((c) => c.kind === 'spectrum').pop();
    assert.deepEqual(Object.keys(sp.cols), ['raw', 'filtered']);
    assert.equal(sp.cols.filtered.length, 10001, 'the spectrum of the window, without the pad');
    assert.equal(sp.params.N, 2048, '10001 samples: a power of two, n / 4 or less');
    let plot = app.plots[app.plots.length - 1];
    assert.equal(plot.spec.title, 'Gyro spectrum, roll, rotor at 33.3 Hz');
    eq(plot.spec.y, { label: 'amplitude', unit: 'deg/s', log: true });
    assert.equal(plot.spec.series[1].y[3], 0.5, 'the amplitude spectrum of the worker');
    const v = plot.spec.vlines.map((l) => [+l.x.toFixed(2), l.label]);
    eq(v.slice(0, 3), [[66.7, 'notch filter Q 8'], [33.33, '1×'], [66.67, '2×']]);
    assert.equal(v.filter((l) => /×$/.test(l[1])).length, 8, 'rotor harmonics to 8× under the Nyquist frequency');
    app.key('ArrowRight');
    app.clock.tick(150);
    await flush();
    assert.equal(app.derives.filter((c) => c.kind === 'spectrum').length, 2, 'the plot follows the window');
    assert.ok(plot.destroyed, 'the old plot is gone');
    eq([app.reads[1].t0, app.reads[1].t1], [10.5, 21.5]);
    app.click('show', { 'data-arg': 'osc:roll' });
    await flush();
    const bp = app.derives.filter((c) => c.kind === 'bandpass').pop();
    eq(bp.params, { lo: 10, hi: 20 });
    const osc = app.plots.slice(-2).map((p) => p.spec);
    assert.deepEqual(osc.map((s) => s.title), ['Oscillation, roll: error in the 10-20 Hz band', 'Error spectrum, roll']);
    eq(osc[0].hlines.map((h) => h.y), [20, -20]);
    // the amplitude line: sqrt(2) rms over 0.5 s of a sine of amplitude A is A (ground truth on the pure helper)
    const A = 7, x = Float32Array.from({ length: 4000 }, (_, i) => A * Math.sin(2 * Math.PI * 12 * i / 1000)), amp = app.internals.amplitude(x, 500);
    near(amp[2000], A, 0.02, 'amplitude of a 12 Hz sine');
    app.click('show', { 'data-arg': 'gov' });
    await flush();
    const gov = app.plots[app.plots.length - 1].spec;
    assert.equal(gov.title, 'Headspeed error from the governor target');
    eq(gov.hlines.map((h) => h.y), [-2, -1, 1, 2]);
    assert.equal(gov.series[0].y[100], 0, 'headspeed 2000 on target 2000');
    app.click('show', { 'data-arg': 'tail' });
    await flush();
    eq(app.plots[app.plots.length - 1].spec.hlines.map((h) => h.label), ['limit -400 ‰', 'limit 400 ‰']);
    app.click('show', { 'data-arg': 'dterm:yaw' });
    await flush();
    assert.deepEqual(Object.keys(app.derives[app.derives.length - 1].cols), ['axisD[2]']);
    assert.ok(app.html('detail-body').includes('Check F10 compares the part of the power at more than 30 Hz with 50 %.'));
    const open = app.plots[app.plots.length - 1];
    app.click('close');
    assert.equal(app.html('detail'), '');
    assert.ok(open.destroyed);
    app.key('ArrowRight');
    app.clock.tick(150);
    await flush();
    assert.equal(app.derives.filter((c) => c.kind === 'spectrum' && Object.keys(c.cols)[0] === 'axisD[2]').length, 1, 'a closed plot is not calculated again');
});

test('escapes what comes from the log, the toolkit and the workers, and marks text that is not ours as quoted', async () => {
    const app = await shown({ result: synthResult() });
    app.click('show', { 'data-arg': 'track:roll' });
    await flush();
    const all = app.allHtml();
    for (const bad of ['<img', '<b>x', 'onerror=alert(1)>', '"D-term & gyro"']) assert.ok(!all.includes(bad), `raw ${bad}`);
    assert.ok(all.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'));
    assert.ok(app.html('findings').includes('Check C11 shows &quot;D-term &amp; gyro&quot; in the result.'), 'the summary, escaped');
    assert.match(app.html('findings'), /data-fid="fG&quot;&gt;&lt;b&gt;x"/, 'an attribute, escaped');
    assert.match(app.html('findings'), /Limit: <code>&lt;img/, 'the threshold of the toolkit as code');
    assert.match(app.html('values'), /<div class="log-lens-note" data-ste="quoted">The yaw setpoint is &lt;img src=x/, 'the text of the worker, escaped and quoted');
    assert.match(app.html('values'), /<ul class="log-lens-notes" data-ste="quoted"><li>The log does not record &quot;govTarget&quot;\.<\/li>/);
    assert.match(app.html('findings'), /<details data-ste="quoted"><summary>Toolkit text \(not STE\)<\/summary>&lt;img/);
    // a reader that fails: our sentence, then its message quoted
    const r = await shown({ result: null, readError: HOSTILE });
    assert.match(r.html('values'), /The app cannot read the data of this time window\. <span data-ste="quoted">&lt;img/);
    const n = await shown({ result: null, noReader: true, noDerive: true });
    assert.ok(n.html('values').includes('The app did not load js/tuning_snippet.js. Thus, the app cannot read the data.'));
    const d = await shown({ result: null, noDerive: true });
    assert.ok(d.html('values').includes('The app cannot calculate the values of the time window.'));
    assert.equal(d.plots.length, 6, 'the strip charts still show the window');
});

test('hide() drops the answers on their way and stops the timers', async () => {
    const app = await shown({ result: null, derive: 'manual' });
    app.key('ArrowRight');
    app.lens.hide();
    app.clock.tick(1000);
    await flush();
    assert.equal(app.reads.length, 1, 'no read after hide()');
    const before = app.html('values');
    app.derives[0].resolve();
    await flush();
    assert.equal(app.html('values'), before, 'the late answer is dropped');
    app.fire('mousedown', event({ '[data-lens="timeline"]': {} }, { clientX: app.xAt(15) }));
    app.lens.hide();
    assert.equal(app.dom.doc.mousemove.length, 0, 'a pull ends');
});

test('takes a result through onResult and getResult only when it covers the open log of this file', async () => {
    const app = await shown({ result: null });
    assert.equal(app.calls.onResult.length, 1, 'the lens listens for results');
    app.give(synthResult({ logIndex: 2, logs: [2] }));
    assert.equal(app.html('findings'), '', 'a result of another log');
    app.give(synthResult({ fileName: 'other.bbl' }));
    assert.equal(app.html('findings'), '', 'a result of another file');
    app.give(synthResult({ scope: 'file', logIndex: 0, logs: [0, 1, 2] }));
    assert.equal(app.fids().length, 5, 'a file result that has this log');
    app.clock.tick(150);
    await flush();
    assert.equal(app.derives.filter((c) => c.kind === 'window').pop().params.tauMs.roll, 26, 'a new result refreshes the window values');
    app.give(null);
    assert.match(app.html('notice'), /Start the analysis/);
    // a result without evidence spans (an old one, or no evidence.cjs)
    const old = synthResult();
    old.findings.forEach((f) => { delete f.evidence; });
    app.give(old);
    assert.ok(app.html('notice').includes('No result of this analysis has a time in the log.'));
    // runAnalysis of the Tuning view gives true or false; a promise of the result also works
    const no = await shown({ result: null, runAnalysis: () => false });
    no.click('start');
    await flush();
    assert.ok(no.html('notice').includes('The analysis did not start.'));
    assert.ok(!no.html('notice').includes('disabled'));
    const p = await shown({ result: null, runAnalysis: () => Promise.resolve(synthResult()) });
    p.click('start');
    await flush();
    assert.equal(p.fids().length, 5);
});

test('a log without some fields: those charts say which fields, and their values are not measured', async () => {
    const fields = new Set(ALL_FIELDS.filter((f) => !/^(headspeed|govTarget|gyroRAW)/.test(f)));
    const values = synthValues((items) => items.map((q) => (q.key === 'gov.error' ? { key: 'gov.error', check: 'G2', status: 'notMeasured', limits: [], detail: {},
        text: 'The log does not record "headspeed". Thus, the app cannot calculate the headspeed error (check G2).' } : q)));
    const app = await shown({ result: null, fields, values });
    assert.match(app.html('charts'), /<strong>Headspeed<\/strong> This log does not contain these fields: <code>headspeed<\/code>/);
    assert.deepEqual(app.plots.map((p) => /data-chart="(\w+)"/.exec(p.canvas.sel)[1]), ['roll', 'pitch', 'yaw', 'tail', 'dterm']);
    assert.deepEqual(app.reads[0].fields, ALL_FIELDS, 'the reader lists the missing ones');
    assert.ok(!('headspeed' in app.derives[0].cols));
    const rows = app.html('values');
    assert.match(rows, /Headspeed error, median<div class="log-lens-note" data-ste="quoted">The log does not record &quot;headspeed&quot;\. Thus, the app cannot calculate the headspeed error \(check G2\)\.<\/div><\/td><td class="log-lens-num"><div class="log-lens-level">Not measured/);
    assert.ok(!rows.includes('Headspeed error, 90 % of the samples'), 'one row for a quantity that is not measured');
    app.click('show', { 'data-arg': 'gov' });
    await flush();
    assert.ok(app.html('detail-body').includes('The plot is not available. This log does not contain the fields of this plot.'));
    const bad = await shown({ result: null, logError: 'truncated' });
    assert.ok(bad.html('notice').includes('No data that the app can read.'));
    assert.equal(bad.reads.length, 0);
});

test('compares with the limits of the toolkit modules', () => {
    const I = setup().internals, L = I.LIMITS;
    const track = require('../tools/autotune/health_track.cjs'), gov = require('../tools/autotune/health_gov.cjs'), loop = require('../tools/autotune/health_loop.cjs');
    const more = require('../tools/autotune/health_more.cjs'), setupMod = require('../tools/autotune/health_setup.cjs');
    eq(L.track, [track.DEFAULT_RULES.C12.note, track.DEFAULT_RULES.C12.flag]);
    eq(L.track, [track.DEFAULT_RULES.T11.note, track.DEFAULT_RULES.T11.flag]);
    assert.equal(L.osc, track.DEFAULT_RULES.C5.level);
    assert.equal(L.osc, track.DEFAULT_RULES.T1.level);
    eq(I.OSC_BANDS, track.RULE.osc.bands);
    eq(L.gov, [gov.DEFAULT_RULES.G2.median, gov.DEFAULT_RULES.G2.band]);
    assert.equal(L.tail, loop.DEFAULT_RULES.T8.minEpisodes);
    assert.equal(L.dterm, loop.DEFAULT_RULES.C11.share);
    assert.equal(L.dterm, more.DEFAULT_RULES.F10.share);
    assert.equal(L.line, setupMod.DEFAULT_RULES.F5.minProminence);
    assert.equal(L.lineNotch, setupMod.DEFAULT_RULES.F5.maxDistance);
});

test('the window rows: each value with its limit, its check and its status, from the items of derive("window")', () => {
    const I = setup().internals, rows = I.windowRows(synthValues()), row = (what) => rows.find((r) => r.what === what);
    eq(rows.map((r) => r.check), ['C12', 'C12', 'T11', 'C5', 'C5', 'T1', 'G2', 'G2', 'T8', 'C11', 'C11', 'F10', 'F5', 'F5', 'F5']);
    const pick = (r) => [r.status, r.value, r.limit, r.levelText, r.key];
    eq(pick(row('Tracking error, roll')), ['monitor', '34.0 %', '30 % and 45 %', 'More than 30 %', 'track:roll']);
    eq(pick(row('Tracking error, pitch')), ['monitor', '50.0 %', '30 % and 45 %', 'More than 45 %', 'track:pitch']);
    eq(pick(row('Tracking error, yaw')), ['insufficient', '', '30 % and 45 %', 'Not sufficient data', 'track:yaw']);
    eq(pick(row('Oscillation, roll, 10-20 Hz')), ['monitor', '25.1 deg/s', '20 deg/s', 'More than 20 deg/s', 'osc:roll']);
    eq(pick(row('Oscillation, pitch, 8-16 Hz')), ['satisfactory', '4.2 deg/s', '20 deg/s', '20 deg/s or less', 'osc:pitch']);
    eq(pick(row('Oscillation, yaw')), ['notMeasured', '', '', 'Not measured', 'osc:yaw']);
    eq(pick(row('Headspeed error, median')), ['satisfactory', '-0.40 %', '1 %', '1 % or less', 'gov']);
    eq(pick(row('Headspeed error, 90 % of the samples')), ['monitor', '-1.20 % to 2.50 %', '2 %', 'More than 2 %', 'gov']);
    eq(pick(row('Time at the tail output limit')), ['monitor', '0.42 s in 3 periods', '1 period', '1 period or more', 'tail']);
    eq(pick(row('D-term power at more than 30 Hz, yaw')), ['monitor', '62.0 %', '50 %', 'More than 50 %', 'dterm:yaw']);
    eq(pick(row('Gyro lines, roll')), ['monitor', '155.7 Hz, 3.2 deg/s', 'Prominence 5', 'No notch filter at 2 % or less', 'lines:roll']);
    eq(pick(row('Gyro lines, pitch')), ['satisfactory', '66.7 Hz, 2.1 deg/s', 'Prominence 5', 'Notch filter at 2 % or less', 'lines:pitch']);
    eq(pick(row('Gyro lines, yaw')), ['information', '', 'Prominence 5', '', 'lines:yaw']);
    const quiet = I.windowRows(synthValues((items) => items.map((q) => (q.key === 'tail.limit' ? Object.assign({}, q, { value: 0, n: 0 }) : q))));
    eq(pick(quiet.find((r) => r.check === 'T8')), ['satisfactory', '0.00 s in 0 periods', '1 period', 'Less than 1 period', 'tail']);
    const weak = I.windowRows(synthValues((items) => items.filter((q) => q.key === 'lines.roll').map((q) => Object.assign({}, q, { detail: { lines: [{ hz: 50, amplitude: 1, prominence: 4 }] } }))));
    eq(weak.map((r) => [r.status, r.levelText]), [['information', 'Prominence less than 5']]);
    eq(I.windowRows({}), [], 'no items, no rows');
    eq(I.windowRows(null), []);
});

// The flight phases of log 1 (SPEC2 D13, records[].phases in frame seconds): idle, spool-up, ground, two flights, spool-down
const PHASE_SPANS = [['idle', 0, 5], ['spoolup', 5, 20], ['ground', 20, 30], ['flight', 30, 120], ['ground', 120, 130], ['flight', 130, 250],
    ['ground', 250, 260], ['spooldown', 260, 300]].map(([phase, t0, t1]) => ({ phase, t0, t1 }));
const withPhases = (over = {}) => synthResult(Object.assign({ records: [{ log: 1, segment: 0, fromS: 0, seconds: LEN, actualRate: RATE, flyingS: 210,
    timeMap: null, phases: { flight: true, spans: PHASE_SPANS, liftoffs: [30, 130], touchdowns: [120, 250] } }] }, over));

test('the flight phases: a strip on the timeline, the time out of flight shaded, the flights in the legend move the window', async () => {
    const app = await shown({ result: withPhases() }), R = app.internals.timelineRows(96), x = (t) => 6 + 788 * t / LEN;
    const draw = lastDraw(app.timeline.ctx), strip = draw.filter((c) => c.m === 'fillRect' && c.a[1] === R.Q0);
    eq(strip.map((c) => [c.fill, +c.a[0].toFixed(6)]), PHASE_SPANS.map((p) => [app.internals.PHASES[p.phase][1], +x(p.t0).toFixed(6)]), 'one bar for each phase, in its colour');
    const shade = draw.filter((c) => c.m === 'fillRect' && c.a[1] === R.T && c.fill === 'rgba(255,255,255,0.07)');
    eq(shade.map((c) => +c.a[0].toFixed(6)), PHASE_SPANS.filter((p) => p.phase !== 'flight').map((p) => +x(p.t0).toFixed(6)), 'all the time out of flight is shaded');
    const legend = app.html('legend');
    for (const s of ['Idle', 'Spool-up', 'On the ground', 'Flight', 'Spool-down', 'Flight 1: 30.0 s to 120.0 s', 'Flight 2: 130.0 s to 250.0 s']) assert.ok(legend.includes(s), s);
    assert.equal(app.part('where').textContent, 'PID profile 1 · Flight phases: Spool-up', 'the window 10-20 s: in spool-up (5-20 s), PID profile 1');
    app.lens.internals.setWindow(25, 35);
    assert.equal(app.part('where').textContent, 'PID profile 1 · Flight phases: On the ground, Flight');
    // a flight button: the window (10 s) starts 1 s before the liftoff
    app.click('flight', { 'data-arg': '130,250' });
    eq(app.win(), [129, 139]);
    app.clock.tick(150);
    await flush();
    const tMin = app.log.tMin(1);
    eq(app.calls.setViewerWindow.pop(), [tMin + 129e6, tMin + 139e6], 'the viewer follows');
    // goTo: a span shorter than the window is centred; another log does nothing
    assert.equal(app.lens.goTo(1, 200, 204), true);
    eq(app.win(), [197, 207]);
    assert.equal(app.lens.goTo(2, 50, 60), false);
    eq(app.win(), [197, 207]);
});

test('flight phases in index samples go through the time map of their record (js/tuning_dialog.js toFrame)', () => {
    const I = setup().internals;
    // ground truth: frame seconds = index seconds + 0.25 s (a log that starts its index clock 0.25 s late)
    const frameS = Float32Array.from({ length: 1201 }, (_, k) => k * 250 / RATE + 0.25);
    const r = { records: [{ log: 1, segment: 0, fromS: 0, seconds: LEN, actualRate: RATE, timeMap: { fromS: 0, every: 250, actualRate: RATE, n: LEN * RATE + 1, frameS },
        phases: { flight: true, spans: [{ phase: 'ground', i0: 0, i1: 20000 }, { phase: 'flight', i0: 20000, i1: 100000 }, { phase: 'nonsense', i0: 1, i1: 2 }] } }] };
    eq(I.phasesOf(r, 1).map((p) => [p.phase, +p.t0.toFixed(6), +p.t1.toFixed(6)]), [['ground', 0.25, 20.25], ['flight', 20.25, 100.25]]);
    eq(I.flightsOf(r, 1), [{ t0: 20.25, t1: 100.25, seconds: 80 }]);
    eq(I.flightsOf({ flights: [{ log: 1, t0: 3, t1: 9, seconds: 6, method: 'airborne', confidence: 0.9 }], records: r.records }, 1), [{ t0: 3, t1: 9, seconds: 6 }],
        'result.flights wins over the phases');
    eq(I.phasesOf(r, 0), [], 'no records of log 1 for log 0');
    assert.equal(I.benchOf(r, 1), false);
    assert.equal(I.benchOf({ records: [{ log: 3, phases: { flight: false, spans: [] } }] }, 3), true, 'a log with no flight is a bench run');
    assert.equal(I.benchOf({ benchRuns: [4, { log: 5 }] }, 5), true, 'result.benchRuns, numbers or objects');
    assert.equal(I.benchOf({ records: [{ log: 3 }] }, 3), false, 'no phases: not known, not a bench run');
});

test('the shapes of js/tuning_worker.js: records[].phases as a list, logClass, and the PID profiles in frame seconds', async () => {
    const I = setup().internals;
    const rec = { log: 1, segment: 0, logClass: 'flight', phases: [{ phase: 'idle', t0: 0, t1: 6 }, { phase: 'spoolup', t0: 6, t1: 15.4 }, { phase: 'flight', t0: 15.4, t1: 290 }],
        profiles: { arming: { profile: 1, inferred: 1 }, pid: [{ t0: 0, t1: 39.37, profile: 1 }, { t0: 39.37, t1: 79.26, profile: 2 }, { t0: 79.26, t1: LEN, profile: '3' }] } };
    eq(I.phasesOf({ records: [rec] }, 1).map((p) => p.phase), ['idle', 'spoolup', 'flight']);
    eq(I.flightsOf({ records: [rec] }, 1), [{ t0: 15.4, t1: 290, seconds: 274.6 }]);
    assert.equal(I.benchOf({ records: [rec] }, 1), false);
    assert.equal(I.benchOf({ records: [Object.assign({}, rec, { logClass: 'bench' })] }, 1), true);
    eq(I.profileSpansOf({ records: [rec] }, 1), [{ t0: 0, t1: 39.37, p: 1 }, { t0: 39.37, t1: 79.26, p: 2 }, { t0: 79.26, t1: LEN, p: 3 }]);
    // the lens: the profile strip and the head use these spans (the curves say profile 2 from 150 s; the worker's spans win)
    const app = await shown({ result: synthResult({ records: [rec] }) });
    const R = I.timelineRows(96), x = (t) => 6 + 788 * t / LEN, strip = lastDraw(app.timeline.ctx).filter((c) => c.m === 'fillRect' && c.a[1] === R.P0);
    eq(strip.map((c) => +c.a[0].toFixed(6)), [x(0), x(39.37), x(79.26)].map((v) => +v.toFixed(6)));
    app.lens.internals.setWindow(50, 60);
    assert.equal(app.part('where').textContent, 'PID profile 2 · Flight phases: Flight');
    app.give(null);
    assert.equal(app.part('where').textContent, 'PID profile 1', 'no result: the PID profile of the log index, no phases');
    app.give(synthResult({ records: [rec] }));
    assert.equal(app.part('where').textContent, 'PID profile 2 · Flight phases: Flight', 'a new result: the head at once');
    app.lens.internals.setWindow(200, 210);
    assert.equal(app.part('where').textContent, 'PID profile 3 · Flight phases: Flight');
});

test('a bench run: the lens says that the analysis does not include it', async () => {
    const r = synthResult({ scope: 'file', logs: [0], records: [{ log: 1, segment: 0, phases: { flight: false, spans: [{ phase: 'idle', t0: 0, t1: 300 }] } }] });
    r.findings = [];
    const app = await shown({ result: r });
    assert.ok(app.html('notice').includes('This log is a bench run. The analysis does not include bench runs.'), 'a file result without this log, but with its bench run');
    assert.equal(app.part('where').textContent, 'PID profile 1 · Flight phases: Idle');
});

test('without the runAnalysis hook the lens has no start button: the verdict above it has the button', async () => {
    const app = await shown({ result: null, noRunHook: true });
    assert.ok(!app.html('notice').includes('data-lens-act="start"'));
    assert.ok(app.html('notice').includes('To start the analysis, use the button at the top of this view.'));
    app.click('start');
    assert.equal(app.calls.runAnalysis, 0);
});

test('every result has its PID profile (1 to 6, unknown, all) and its flight phase', async () => {
    const r = synthResult();
    r.findings = [
        { fid: 'p1', id: 'C12', axis: 'roll', severity: 'flag', profile: 2, log: 1, evidence: { spans: [{ t0: 11, t1: 12 }] } },
        { fid: 'p0', id: 'C13', axis: 'roll', severity: 'flag', profile: 0, log: 1, evidence: { spans: [{ t0: 11, t1: 12 }] } },
        { fid: 'pa', id: 'C1', axis: 'roll', severity: 'flag', profile: 'arm', log: 1, evidence: { spans: [{ t0: 11, t1: 12 }] } },
        { fid: 'pn', id: 'G0', severity: 'flag', profile: null, log: 1, evidence: { spans: [{ t0: 11, t1: 12 }] } },
        { fid: 'ph', id: 'C15', axis: 'roll', severity: 'flag', profile: '3', phase: 'ground', log: 1, evidence: { spans: [{ t0: 11, t1: 12 }] } },
        { fid: 'h', id: 'F4', severity: 'flag', profile: 'roll', log: 1, evidence: { spans: [{ t0: 11, t1: 12 }] } },
    ];
    const app = await shown({ result: r }), h = app.html('findings');
    for (const s of ['C12, roll, PID profile 2', 'C13, roll, PID profile unknown', 'C1, roll, PID profile unknown', 'G0, All PID profiles', 'C15, roll, PID profile 3, On the ground',
        'F4, All PID profiles']) assert.ok(h.includes(s), s);
    const I = app.internals;
    eq([2, 0, 'arm', 'unknown', null, '4', 'roll'].map((p) => I.profileOf({ id: 'C12', profile: p })), [2, 0, 0, 0, null, 4, null]);
    eq(['D4', 'F4', 'H'].map((id) => I.profileOf({ id, profile: 1 })), [null, null, null], 'checks with no PID profile of the log');
});

test('"Show the measurement" draws the evidence plot as the Tuning view draws it, with its caption: curves, a raw span with derive, a table', async () => {
    const r = withPhases(), t = Float32Array.from({ length: LEN * 10 }, (_, i) => i / 10);
    // the tracking curve of log 1: the setpoint, and an error of 40 % of it after the time delay
    r.curves[0].track = { roll: { time: { t, sp: Float32Array.from(t, () => 50), err: Float32Array.from(t, () => 21), errComp: Float32Array.from(t, () => 20) } } };
    // the record maps index seconds to frame seconds 0.5 s later
    r.records[0].timeMap = { fromS: 0, every: 250, actualRate: RATE, n: LEN * RATE + 1, frameS: Float32Array.from({ length: 1201 }, (_, k) => k / 4 + 0.5) };
    const ref = [{ kind: 'hline', value: 45, label: 'Limit 45 %', unit: '%' }, { kind: 'hline', value: 30, label: 'Limit 30 %', unit: '%' }];
    const ev = (fid, spans, plot, extra = {}) => Object.assign({ v: 1, fid, spans, view: null, plot, expected: 'The gyro follows the setpoint.', summary: '', context: [] }, extra);
    r.findings.push(
        { fid: 'cv', id: 'C12', module: 'track', axis: 'roll', severity: 'flag', profile: 1, log: 1, value: 0.4, summary: 'The roll tracking error is 40 % of the setpoint.',
            evidence: ev('cv', [{ log: 1, t0: 11, t1: 13 }], { kind: 'time', tab: 'curves', curve: 'track.roll.time', snippet: null, reference: ref,
                caption: 'The plot shows the tracking error as a percentage of the setpoint. The lines at 30 % and 45 % are the limits of `C12`.' }) },
        { fid: 'sn', id: 'T6', module: 'loop', severity: 'flag', profile: 1, log: 1, value: 41,
            evidence: ev('sn', [{ log: 1, t0: 10, t1: 30 }], { kind: 'time', curve: null, snippet: { fields: ['setpoint[0]', 'gyroADC[0]'], derive: { kind: 'lowpass', params: { hz: 30 } } }, reference: [] },
                { view: { log: 1, t0: 10, t1: 30, at: 15, graphs: [['mixer[3]']], analyser: null } }) },
        { fid: 'tb', id: 'F2', module: 'setup', severity: 'flag', log: 1, evidence: ev('tb', [{ log: 1, t0: 14, t1: 15 }], { kind: 'table', rows: [{ key: 'gyro_lowpass_hz', value: '<100>' }],
            caption: 'The table shows the low-pass filter of the log header <b>.' }) },
        { fid: 'fb', id: 'C13', module: 'track', axis: 'roll', severity: 'flag', profile: 1, log: 1, value: 130,
            evidence: ev('fb', [{ log: 1, t0: 15, t1: 16 }], { kind: 'phase', curve: 'track.roll.spectrum', snippet: null, reference: [] }) });
    const app = await shown({ result: r }), h = app.html('findings');
    assert.match(h, /data-lens-act="compare" data-fid="cv" data-arg="result:cv"/, 'a result with an evidence plot');
    app.click('compare', { 'data-fid': 'cv', 'data-arg': 'result:cv' });
    await flush();
    let spec = app.plots[app.plots.length - 1].spec;
    assert.equal(spec.title, 'Measurement: C12, roll, PID profile 1, log 2');
    assert.ok(app.html('detail').includes('Measurement: C12, roll, PID profile 1'));
    assert.ok(app.html('detail-body').includes('</canvas></div><p class="log-lens-caption is-plot">The plot shows the tracking error as a percentage of the setpoint. The lines at 30 % and 45 % are the limits of <code>C12</code>.</p><p class="log-lens-caption">Data: the curves of log 2.</p>'),
        'SPEC3 H: the caption of the plot (evidence.cjs plot.caption) under the plot, then the source');
    const ratio = spec.series.find((q) => q.name === 'tracking error, % of the setpoint');
    assert.ok(ratio, spec.series.map((q) => q.name).join('|'));
    near(ratio.y[100], 40, 1e-9, 'errComp / sp of the curve, in %');
    near(ratio.x[100], 10.5, 1e-6, 'index time 10 s is frame time 10.5 s (the time map)');
    eq(spec.hlines.map((q) => [q.y, q.label]), [[45, 'Limit 45 %'], [30, 'Limit 30 %']]);
    for (const s of ['<strong>Satisfactory</strong> The gyro follows the setpoint.', '<strong>Measured</strong> The roll tracking error is 40 % of the setpoint.', 'Data: the curves of log 2.']) {
        assert.ok(app.html('detail-body').includes(s), s);
    }
    // the evidence plot does not change with the window: no new plot when the window moves
    const n = app.plots.length;
    app.key('ArrowRight');
    app.clock.tick(150);
    await flush();
    assert.equal(app.plots.filter((p) => /data-detail-plot/.test(p.canvas.sel)).length, app.plots.slice(0, n).filter((p) => /data-detail-plot/.test(p.canvas.sel)).length);

    // a raw span of 20 s: 12 s about the view time, read and filtered in the derive worker
    app.click('compare', { 'data-fid': 'sn', 'data-arg': 'result:sn' });
    await flush();
    const rd = app.reads[app.reads.length - 1];
    eq([rd.li, rd.t0, rd.t1, rd.fields], [1, 10, 22, ['setpoint[0]', 'gyroADC[0]']]);
    const lp = app.derives.filter((c) => c.kind === 'lowpass').pop();
    eq(lp.params, { hz: 30 });
    spec = app.plots[app.plots.length - 1].spec;
    eq(spec.series.map((q) => q.name), ['setpoint[0]', 'gyroADC[0]']);
    eq(spec.y.unit, 'deg/s');
    assert.ok(app.html('detail-body').includes('Data: log 2, 10 s to 22 s.'));

    // a table: the header keys and values, in code font and escaped
    app.click('compare', { 'data-fid': 'tb', 'data-arg': 'result:tb' });
    await flush();
    assert.ok(app.html('detail-body').includes('<td><code>gyro_lowpass_hz</code></td><td><code>&lt;100&gt;</code></td>'));
    assert.ok(app.html('detail-body').includes('</tbody></table><p class="log-lens-caption is-plot">The table shows the low-pass filter of the log header &lt;b&gt;.</p>'), 'the caption of a table, escaped');

    // no curve and no raw span: the plot of the window for check C13
    app.click('compare', { 'data-fid': 'fb', 'data-arg': 'result:fb' });
    await flush();
    assert.equal(app.plots[app.plots.length - 1].spec.title, 'Tracking error, roll: setpoint and gyro after a low-pass filter at 30 Hz');

    // without js/tuning_dialog.js: a table still shows, a plot does not
    const bare = await shown({ result: r, noTuningDialog: true });
    bare.click('compare', { 'data-fid': 'sn', 'data-arg': 'result:sn' });
    await flush();
    assert.ok(bare.html('detail-body').includes('The plot is not available. The app did not load js/tuning_dialog.js. Thus, the app cannot show this plot.'));
    bare.click('compare', { 'data-fid': 'tb', 'data-arg': 'result:tb' });
    await flush();
    assert.ok(bare.html('detail-body').includes('<code>gyro_lowpass_hz</code>'));
});

test('the status of a result is the worker\'s (f.status), else the rule of the Tuning view; the lens has no copy of the catalog', () => {
    const app = setup(), I = app.internals;
    assert.ok(!/REPORT_ONLY/.test(read('js/log_lens.js')), 'no list of the report-only checks in js/log_lens.js');
    assert.equal(I.statusOf({ id: 'C13', severity: 'note', status: 'monitor' }), 'monitor', 'the worker\'s status wins');
    assert.equal(I.statusOf({ id: 'C13', severity: 'note', status: 'constructor' }), 'information', 'a status that is not a status word: the rule');
    // without the worker's status: js/tuning_dialog.js findingStatus (test/tuning_dialog.test.cjs keeps it equal to the catalog)
    const K = app.context.TuningDialog.internals;
    for (const f of [{ id: 'C13', severity: 'note' }, { id: 'F10', severity: 'note', axis: 'yaw', se: 0.1 }, { id: 'C12', severity: 'flag', explained: 'x' }, { id: 'D7', severity: 'note', thin: true }]) {
        assert.equal(I.statusOf(f), K.findingStatus(f), JSON.stringify(f));
    }
    // without js/tuning_dialog.js: the severity only
    const bare = setup({ noTuningDialog: true }).internals;
    eq(['flag', 'note', 'ok', 'skipped', 'error'].map((severity) => bare.statusOf({ id: 'C13', severity })), ['problem', 'monitor', 'satisfactory', 'notMeasured', 'error']);
    assert.equal(bare.statusOf({ id: 'C13', severity: 'note', status: 'information' }), 'information');
});

test('one PID profile label for each row: the worker\'s pidProfile, then the label of its summary (D-M2)', async () => {
    const I = setup().internals;
    // pidProfile null: the worker does not know the PID profile, whatever the label of the toolkit
    eq([0, 'arm', 2, null].map((p) => I.profileOf({ id: 'C12', profile: p, pidProfile: null })), [0, 0, 0, null]);
    assert.equal(I.profileOf({ id: 'C12', profile: 0, pidProfile: 2 }), 2, 'a confirmed arming profile');
    assert.equal(I.profileOf({ id: 'C12', profile: 0, pidProfile: 2, display: { profile: 'PID profile unknown' } }), 0, 'never a PID profile next to an unknown summary');
    assert.equal(I.profileOf({ id: 'C12', profile: 2, display: { profile: 'PID profile 2' } }), 2);
    assert.equal(I.profileOf({ id: 'C12', profile: 2, display: { profile: null } }), null, 'the summary is for all PID profiles');
    assert.equal(I.profileOf({ id: 'D4', profile: 1, pidProfile: 2, display: { profile: 'PID profile 2' } }), 2, 'D4 of the CLI section of the known arming profile: as its summary');
    // a span of another PID profile than its result (evidence.cjs spans[].pidProfile): the time says which
    const rs = synthResult();
    rs.findings = [Object.assign({}, rs.findings[0], { profile: null, pidProfile: null, display: { profile: null },
        evidence: Object.assign({}, rs.findings[0].evidence, { spans: [{ log: 1, t0: 11, t1: 12, pidProfile: 2 }, { log: 1, t0: 13, t1: 14 }] }) })];
    const sp = await shown({ result: rs });
    assert.ok(sp.html('findings').includes('Time in the log: 11.0 s to 12.0 s (PID profile 2), 13.0 s to 14.0 s.'), sp.html('findings'));
    // the row: its label agrees with its summary
    const r = synthResult();
    Object.assign(r.findings[0], { profile: 0, pidProfile: null, display: { value: '52 ± 3 %', unit: '%', profile: 'PID profile unknown' },
        summary: 'In an unknown PID profile, the roll tracking error is 52 ± 3 % of the setpoint.' });
    const app = await shown({ result: r }), h = app.html('findings');
    assert.ok(h.includes('C12, roll, PID profile unknown') && !h.includes('C12, roll, PID profile 1'), h);
});

test('"Show the measurement" without the curves of the log says why, in STE (D-H3)', async () => {
    const r = synthResult({ scope: 'file', logs: [0, 1, 2], logIndex: 0 });
    r.curves = r.curves.map((c) => Object.assign({}, c, { log: 0 })); // "All logs in the file": the curves of log 1 (index 0) only
    const ev = (fid, curve) => ({ v: 1, fid, spans: [{ log: 1, t0: 11, t1: 13 }], view: null, plot: { kind: 'time', curve, snippet: null, reference: [] }, expected: '', summary: '', context: [] });
    r.findings.push({ fid: 'nc', id: 'T13', module: 'more', severity: 'flag', profile: 1, log: 1, value: 0.2, evidence: ev('nc', 'more.tail') },
        { fid: 'n8', id: 'T8', module: 'loop', severity: 'flag', profile: 1, log: 1, value: 1.2, evidence: ev('n8', 'more.tail') });
    const app = await shown({ result: r });
    app.click('compare', { 'data-fid': 'nc', 'data-arg': 'result:nc' });
    await flush();
    const why = 'The result has curves only for log 1. To see this plot for log 2, open log 2 in the log viewer. Then start the analysis again.';
    assert.ok(app.html('detail-body').includes(why), app.html('detail-body'));
    assert.ok(!app.html('detail-body').includes('for log 1 only'), 'not the old text');
    // T8 has a plot of the time window: why the plot of the result is not there, then that plot
    app.click('compare', { 'data-fid': 'n8', 'data-arg': 'result:n8' });
    await flush();
    assert.ok(app.html('detail-body').includes('<p class="log-lens-muted">' + why + ' This plot shows the data of the time window.</p><div class="log-lens-plot">'), app.html('detail-body'));
    // no curves at all
    const none = await shown({ result: Object.assign(synthResult(), { curves: [] }) });
    none.give(Object.assign(synthResult(), { curves: [], findings: [r.findings.find((f) => f.fid === 'nc')] }));
    none.click('compare', { 'data-fid': 'nc', 'data-arg': 'result:nc' });
    await flush();
    assert.ok(none.html('detail-body').includes('The result has no curves. Thus, the app cannot show this plot.'));
});

test('"Start the analysis" of the lens ends when the run stops, and says why (B1)', async () => {
    const error = (reason, message, detail) => Object.assign(new Error(message), { reason, detail });
    const failed = await shown({ result: null, runAnalysis: () => Promise.reject(error('failed', '', 'The log cannot be decoded.')) });
    failed.click('start');
    await flush();
    assert.ok(failed.html('notice').includes('The analysis stopped because of an error. <span data-ste="quoted">The log cannot be decoded.</span>'));
    assert.ok(!failed.html('notice').includes('disabled'));
    const replaced = await shown({ result: null, runAnalysis: () => Promise.reject(error('replaced', 'x')) });
    replaced.click('start');
    await flush();
    assert.ok(!replaced.html('notice').includes('disabled') && !replaced.html('notice').includes('The analysis did not start.'));
    const other = await shown({ result: null, runAnalysis: () => Promise.resolve(synthResult({ logIndex: 2, logs: [2] })) });
    other.click('start');
    await flush();
    assert.ok(!other.html('notice').includes('disabled') && !other.html('notice').includes('Wait for the results'), 'a result for another log: the button again');
});


// --- V8: the head lists every PID profile of the window -----------------------------------------------------------------------

test('V8: the head lists every PID profile that is active in the window, with its seconds; "PID profile unknown" only for its part', async () => {
    const I = setup().internals;
    // the real case of gaui_58 (V.md V8): unknown to 19.8 s, then 2, 3, 2, 1, 2, 3, 2, 1
    const runs = [[0, 19.78, 0], [19.78, 22.38, 2], [22.38, 23.64, 3], [23.64, 27.49, 2], [27.49, 67.89, 1], [67.89, 110.19, 2], [110.19, 120.79, 3], [120.79, 135.92, 2],
        [135.92, 196.48, 1]].map(([t0, t1, p]) => ({ t0, t1, p }));
    eq(I.windowProfiles(runs, 90, 150).map((q) => [q.p, +q.seconds.toFixed(2)]), [[2, 35.32], [3, 10.6], [1, 14.08]], 'in the sequence of the first period of each');
    eq(I.windowProfiles(runs, 0, 60).map((q) => [q.p, +q.seconds.toFixed(2)]), [[0, 19.78], [2, 6.45], [3, 1.26], [1, 32.51]]);
    eq(I.windowProfiles(runs, 30, 60).map((q) => q.p), [1], 'one PID profile');
    eq(I.windowProfiles([{ t0: 0, t1: 10.03, p: 1 }, { t0: 10.03, t1: 20, p: 2 }], 10, 20).map((q) => q.p), [2], 'a part of less than 0.05 s does not count');
    const rec = { log: 1, segment: 0, logClass: 'flight', phases: [{ phase: 'flight', t0: 0, t1: LEN }],
        profiles: { arming: { profile: 0, confirmed: false }, pid: runs.map((q) => ({ t0: q.t0, t1: q.t1, profile: q.p })).concat([{ t0: 196.48, t1: LEN, profile: 2 }]) } };
    const app = await shown({ result: synthResult({ records: [rec] }) });
    app.lens.internals.setWindow(90, 150);
    assert.equal(app.part('where').textContent, 'PID profile 2 (35.3 s), PID profile 3 (10.6 s), PID profile 1 (14.1 s) · Flight phases: Flight');
    app.lens.internals.setWindow(0, 19);
    assert.equal(app.part('where').textContent, 'PID profile unknown · Flight phases: Flight', 'all of the window is before the first switch');
    app.lens.internals.setWindow(10, 25);
    assert.equal(app.part('where').textContent, 'PID profile unknown (9.8 s), PID profile 2 (4.0 s), PID profile 3 (1.3 s) · Flight phases: Flight',
        'unknown only for the part before the first switch');
    app.lens.internals.setWindow(30, 60);
    assert.equal(app.part('where').textContent, 'PID profile 1 · Flight phases: Flight');
    // without a result: the PID profiles of the log index (PID profile 1 to 150 s, then 2)
    app.give(null);
    app.lens.internals.setWindow(140, 160);
    assert.equal(app.part('where').textContent, 'PID profile 1 (10.0 s), PID profile 2 (10.0 s)');
});

// --- V2: the plot of "Show" is next to the row that asked for it, in view ------------------------------------------------------

test('V2: "Show" puts its plot just above the values of the window and scrolls it into view; "Show the measurement" above the results', async () => {
    const app = await shown({ result: synthResult() });
    const moves = [], scrolls = [], panel = { insertBefore(a, b) { moves.push([a.sel, b.sel]); a.nextSibling = b; } };
    app.part('values').parentNode = panel;
    app.part('findings').parentNode = panel;
    app.part('detail').scrollIntoView = (o) => scrolls.push(JSON.parse(JSON.stringify(o)));
    assert.match(app.html('values'), /data-lens-act="show" data-arg="lines:yaw"/, 'a row at the end of the values');
    app.click('show', { 'data-arg': 'lines:yaw' });
    eq(moves, [['[data-lens="detail"]', '[data-lens="values"]']], 'the plot goes above the values');
    eq(scrolls, [{ block: 'nearest' }], 'into view at once');
    await flush();
    eq(scrolls.length, 2, 'and again when the plot is drawn');
    assert.ok(app.plots.some((q) => /data-detail-plot="0"/.test(q.canvas.sel)));
    // the plot follows the window, and the panel does not jump to it again
    app.key('ArrowRight');
    app.clock.tick(150);
    await flush();
    eq(scrolls.length, 2);
    eq(moves.length, 1, 'already above the values');
    // "Show the measurement" of a result of the window: above the results
    app.click('compare', { 'data-fid': 'fA', 'data-arg': 'track:roll' });
    eq(moves[1], ['[data-lens="detail"]', '[data-lens="findings"]']);
    eq(scrolls.length, 3);
    // without these DOM methods (an old host): the plot stays where it is, and nothing throws
    const bare = await shown({ result: synthResult() });
    bare.click('show', { 'data-arg': 'tail' });
    await flush();
    assert.match(bare.html('detail'), /data-lens-act="close"/);
    assert.deepEqual(bare.errors, []);
});

// --- V10: a compare plot of the curves for one PID profile shows its periods only -----------------------------------------------

test('V10: "Show the measurement" of a result of one PID profile, from the curves of the whole log, shows only the periods of that PID profile', async () => {
    const r = withPhases(), t = Float32Array.from({ length: LEN * 10 }, (_, i) => i / 10), u = Float32Array.from(t, (x) => 300 * Math.sin(x));
    r.records[0].profiles = { pid: [{ t0: 0, t1: 40, profile: 0 }, { t0: 40, t1: 100, profile: 2 }, { t0: 100, t1: 150, profile: 1 }, { t0: 150, t1: 200, profile: 2 },
        { t0: 200, t1: 260, profile: 1 }, { t0: 260, t1: LEN, profile: 3 }] };
    r.curves[0].more.tail = { t, u: { mean: u, min: u, max: u }, limits: { lo: -400, hi: 400 } };
    const plot = { kind: 'time', curve: 'more.tail', snippet: null, reference: [{ kind: 'hline', value: 400, unit: '‰', label: 'Tail output limit 400 ‰' }] };
    r.findings.push({ fid: 't8', id: 'T8', module: 'loop', severity: 'flag', profile: 1, pidProfile: 1, log: 1, value: 1.44, summary: 'In PID profile 1, the tail output is at a limit for 1.44 s.',
        evidence: { v: 1, fid: 't8', spans: [{ log: 1, t0: 11, t1: 12 }], view: null, plot, expected: 'The tail output does not touch its limits.', summary: '', context: [] } });
    const app = await shown({ result: r });
    app.click('compare', { 'data-fid': 't8', 'data-arg': 'result:t8' });
    await flush();
    const spec = app.plots[app.plots.length - 1].spec;
    near(spec.x.min, 100 - 4.8, 1e-9, 'from the first period of PID profile 1, less 3 % of 160 s');
    near(spec.x.max, 260 + 4.8, 1e-9, 'to the end of its last');
    const y = spec.series[0].y;
    assert.ok(Number.isNaN(y[700]) && Number.isNaN(y[1700]) && !Number.isNaN(y[1200]) && !Number.isNaN(y[2300]), 'the other PID profiles are not drawn');
    assert.ok(app.html('detail-body').includes('Data: the curves of log 2. The plot shows only the periods of PID profile 1.'));
});

test('a result of the window shows the worker\'s display.value and display.bound, else the toolkit value and threshold (V5, V6)', async () => {
    const I = setup().internals;
    const g10 = { id: 'G10', value: 0.235, se: 0.139, threshold: { implicated: 0.5, ruledOut: 0.1, flatRpm: 10, minWindows: 8, source: 'x' },
        display: { value: 'coherence 0.235 ± 0.139', bound: '0.5 or more (2 SE test)', limit: 'At 0.5 or more (2 SE test), the governor is a possible cause.' } };
    eq(I.limitOf(g10), { text: '0.5 or more (2 SE test)', code: false });
    eq(I.limitOf(Object.assign({}, g10, { display: { value: null, bound: null, limit: 'The limit is 0 for each type.' } })), { text: 'The limit is 0 for each type.', code: false });
    eq(I.limitOf(Object.assign({}, g10, { display: undefined })), { text: 'implicated 0.5, ruledOut 0.1, flatRpm 10, minWindows 8', code: true });
    assert.equal(I.valueOf(g10), 'coherence 0.235 ± 0.139');
    assert.equal(I.valueOf({ id: 'D2', value: 0, display: { value: null } }), null, 'a display with no value: no bare toolkit count');
    assert.equal(I.valueOf({ id: 'C13', value: 26, unit: 'ms' }), '26 ms');
    const r = synthResult();
    r.findings.push({ fid: 'd2', id: 'D2', module: 'setup', severity: 'flag', log: 1, value: 0, threshold: 'gaps <= 0, jumps <= 0', summary: 'The log has 1 loop stall.',
        display: { value: '1 loop stall', bound: '0 for each type', limit: 'The limit is 0 for each type.', unit: '', scale: 1, profile: null, phase: null },
        evidence: { v: 1, fid: 'd2', spans: [{ log: 1, t0: 12, t1: 13 }], view: null, plot: null, expected: '', summary: '', context: [] } });
    const app = await shown({ result: r }), h = app.html('findings');
    assert.ok(h.includes('Value: 1 loop stall. Limit: 0 for each type. Time in the log: 12.0 s to 13.0 s.'), h.slice(h.indexOf('D2'), h.indexOf('D2') + 600));
    assert.ok(!/gaps &lt;= 0/.test(h.replace(/<details data-ste="quoted">[\s\S]*?<\/details>/g, '')), 'not the toolkit threshold');
});

test('the script is a classic script that defines one global, for Chromium 99', () => {
    const src = read('js/log_lens.js'), css = read('css/log_lens.css'), context = vm.createContext({});
    const before = new Set(Object.getOwnPropertyNames(context));
    vm.runInContext(src, context);
    assert.deepEqual(Object.getOwnPropertyNames(context).filter((k) => !before.has(k)), ['LogLens']);
    assert.ok(!/^(const|let|class)\s/m.test(src), 'no top-level const, let or class');
    for (const api of ['toSorted', 'toReversed', 'Object.groupBy', 'findLast', '.at(', 'structuredClone', 'replaceAll']) assert.ok(!src.includes(api), api);
    assert.ok(!/:has\(|@container|&\s*[.:{]/.test(css), 'no :has(), container queries or nesting');
    assert.ok(!/(src|href|url)\s*[=(]\s*["']?\//.test(src + css), 'relative URLs only');
    assert.ok(!/;/.test(Object.values(context.LogLens.internals.TEXT).join(' ')), 'no semicolon in the text (ASD-STE100 8.1)');
});

test('index.html loads the lens after the Tuning view scripts, and gulpfile.js packages it', () => {
    const html = read('index.html'), gulp = read('gulpfile.js'), count = (text, needle) => text.split(needle).length - 1, at = (needle) => html.indexOf(needle);
    assert.equal(count(html, '<script src="js/log_lens.js"></script>'), 1);
    assert.equal(count(html, '<link rel="stylesheet" href="css/log_lens.css">'), 1);
    assert.ok(at('js/tuning_plot.js') < at('js/log_lens.js') && at('js/tuning_snippet.js') < at('js/log_lens.js') && at('js/tuning_dialog.js') < at('js/log_lens.js'),
        'after the plot, the snippet reader and the Tuning view (SPEC2 section 2)');
    assert.ok(at('js/log_lens.js') < at('js/analysis_view.js'), 'before js/analysis_view.js, which uses its pieces');
    assert.ok(at('css/tuning_dialog.css') < at('css/log_lens.css'));
    assert.equal(count(html, 'id="logLensBody"'), 0, 'the Analysis view has no log lens (2026-10-06)');
    const list = /(?:var distSources|APP_ASSET_SOURCES) = \[([\s\S]*?)\];/.exec(gulp)[1];
    for (const file of ['./js/log_lens.js', './css/log_lens.css']) assert.equal(count(list, `'${file}'`), 1, file);
});

// --- SPEC3 C and E ------------------------------------------------------------------------------------------------------

test('SPEC3 C: the timeline scales its font, strips and tick labels with the text size, and draws again after a change', async () => {
    const app = await shown({ result: synthResult() }), I = app.internals, TP = app.context.TuningPlot;
    eq(I.timelineRows(96, 1.2), { T: 4, B: 46, P0: 50, P1: 57, C0: null, C1: null, Q0: 61, Q1: 68, S0: 72, S1: 80, k: 1.2 }, '100 %: the rows of a 96 px canvas');
    eq(I.timelineRows(110, 1.2, true), { T: 4, B: 45, P0: 49, P1: 56, C0: 60, C1: 72, Q0: 76, Q1: 83, S0: 87, S1: 95, k: 1.2 }, 'with the strip of the configurations under the PID profile strip');
    const big = I.timelineRows(200, 1.92);
    assert.deepEqual([big.B, big.P0, big.P1, big.Q0, big.S0, big.S1], [119, 125, 137, 142, 159, 172], 'each row x 1.92');
    assert.ok(big.S1 + 3 + 19 <= 200, 'the tick labels fit under the strips');
    assert.equal(app.timeline.ctx.font, '12px Verdana, Arial, sans-serif', '100 %: 12 px');
    const before = app.timeline.ctx.calls.length;
    TP.setTextScale(1.5);
    assert.ok(app.timeline.ctx.calls.length > before, 'drawn again');
    assert.equal(app.timeline.ctx.font, '18px Verdana, Arial, sans-serif', '10 px x 1.2 x 1.5');
    const R = I.timelineRows(96), strip = lastDraw(app.timeline.ctx).filter((c) => c.m === 'fillRect' && c.a[1] === R.S0);
    assert.ok(strip.length > 0, 'the span strip at the scaled row');
    assert.ok(Math.abs(R.k - 1.8) < 1e-12, String(R.k));
    TP.setTextScale(1);
});

test('SPEC3 E: the result list of the lens has the two filters of js/main.js, shared with the Tuning view', async () => {
    let state = { thin: false, ok: false };
    const listeners = [], saved = [];
    const hooks = { resultFilter: () => state, setResultFilter: (f) => { state = f; saved.push(JSON.parse(JSON.stringify(f))); listeners.forEach((cb) => cb(f)); return f; },
        onResultFilter: (cb) => { listeners.push(cb); return () => {}; } };
    const app = await shown({ result: synthResult(), hooks });
    assert.equal(listeners.length, 1);
    app.lens.internals.setWindow(28, 38);
    assert.deepEqual(app.fids(), []);
    app.fire('change', rfEvent('ok', true));
    eq(saved, [{ thin: false, ok: true }], 'to the host, which keeps it in the preferences');
    assert.deepEqual(app.fids(), ['fC']);
    assert.ok(app.html('findings').includes('<input type="checkbox" data-lens-rf="ok" checked> Show satisfactory results (1)'));
    // a change in the Tuning view
    state = { thin: false, ok: false };
    listeners[0](state);
    assert.deepEqual(app.fids(), []);
    const I = app.internals, got = I.filterRows([{ status: 'satisfactory' }, { status: 'insufficient' }, { status: 'problem' }], { thin: true });
    eq(got, { list: [{ status: 'insufficient' }, { status: 'problem' }], hidden: 1, counts: { thin: 1, ok: 1 } });
    assert.equal(I.filterBarHtml({}, I.filterRows([{ status: 'problem' }], {})), '', 'no bar without the two kinds');
    assert.deepEqual(app.errors, []);
});

// SPEC3 J, M1: the configurations of the result (result.datasets of tools/autotune/datasets.cjs): A in PID profile 1 to 150 s, then
// B in PID profile 2 (values from a different log); C12 roll of A, C5 pitch of B, F5 of no single configuration
function withConfigs(r) {
    r.datasets = { datasets: [{ id: 'A', pidProfile: 1, logs: [1] }, { id: 'B', pidProfile: 2, logs: [1, 2], assumed: true }],
        labels: [{ log: 1, t0: 0, t1: 150, dataset: 'A', index: 0, pidProfile: 1, assumed: false }, { log: 1, t0: 150, t1: 300, dataset: 'B', index: 1, pidProfile: 2, assumed: true },
            { log: 2, t0: 0, t1: 300, dataset: 'B', index: 1, pidProfile: 2, assumed: true }], diff: [], newest: 'B' };
    r.findings.find((f) => f.fid === 'fA').dataset = 'A';
    r.findings.find((f) => f.fid === 'fB').dataset = 'B';
    return r;
}

test('SPEC3 J: the strip of the configurations under the PID profile strip, with their letters, the legend and the head', async () => {
    const app = await shown({ result: withConfigs(synthResult()) }), I = app.internals;
    eq(I.configSpansOf(app.hooks.getResult(), 1).map((q) => [q.t0, q.t1, q.id, q.index, q.assumed]), [[0, 150, 'A', 0, false], [150, 300, 'B', 1, true]]);
    assert.equal(app.timeline.className, 'log-lens-timeline-canvas has-config', 'a higher canvas for the strip (css/log_lens.css)');
    const R = I.timelineRows(app.timeline.clientHeight, I.textMetrics().k, true), calls = lastDraw(app.timeline.ctx);
    const strip = calls.filter((c) => c.m === 'fillRect' && c.a[1] === R.C0);
    eq(strip.map((c) => [c.fill, c.alpha]), [[I.CONFIG_COLOR[0], 1], [I.CONFIG_COLOR[1], 0.7]], 'one colour for each configuration; values from a different log lighter');
    assert.ok(calls.some((c) => c.m === 'fillText' && c.a[0] === 'A') && calls.some((c) => c.m === 'fillText' && c.a[0] === 'B'), 'the letters on the strip');
    assert.ok(app.html('legend').includes('<i class="log-lens-swatch is-config" style="background:' + I.CONFIG_COLOR[0] + '"></i>Configuration A: PID profile 1</span>'), app.html('legend'));
    assert.ok(app.html('legend').includes('Configuration B: PID profile 2'));
    assert.equal(app.part('where').textContent, 'PID profile 1 · Configuration A', 'the configuration of the window');
    app.lens.internals.setWindow(140, 160);
    assert.equal(app.part('where').textContent, 'PID profile 1 (10.0 s), PID profile 2 (10.0 s) · Configurations A (10.0 s), B (10.0 s)');
    // a result without configurations: no strip
    const plain = await shown({ result: synthResult() });
    assert.equal(plain.timeline.className, 'log-lens-timeline-canvas');
    assert.ok(!plain.html('legend').includes('Configuration'));
});

test('SPEC3 J: the configuration menu of the Tuning view filters the results of the window, and the menu of the lens sets it', async () => {
    let cfg = 'all';
    const listeners = [], set = [];
    const hooks = { configuration: () => cfg, setConfiguration: (id) => { set.push(id); cfg = id; listeners.forEach((cb) => cb(id)); }, onConfiguration: (cb) => listeners.push(cb) };
    const app = await shown({ result: withConfigs(synthResult()), hooks });
    const all = app.fids(), without = (x) => all.filter((f) => f !== x);
    assert.ok(all.includes('fA') && all.includes('fB') && all.includes('fF'), 'all configurations: the results of A, of B and of no single configuration');
    assert.ok(app.html('config').includes('<select class="form-control input-sm" data-lens-config="1"><option value="all" selected>All configurations</option><option value="A">Configuration A: PID profile 1</option>'));
    cfg = 'A';
    listeners.forEach((cb) => cb('A'));
    eq(app.fids(), without('fB'), 'configuration A: its results and the results of no single configuration');
    assert.ok(app.html('findings').includes('Configuration A. The list shows the results of this configuration and the results for all configurations.'));
    const strip = lastDraw(app.timeline.ctx).filter((c) => c.m === 'fillRect' && (c.fill === app.internals.CONFIG_COLOR[0] || c.fill === app.internals.CONFIG_COLOR[1]));
    eq(strip.map((c) => c.alpha), [1, 0.25], 'the other configurations dark on the strip');
    // the menu of the lens: the Tuning view keeps the configuration and tells the views
    app.fire('change', { target: { value: 'B', getAttribute: (k) => (k === 'data-lens-config' ? '1' : null) } });
    eq(set, ['B']);
    eq(app.fids(), without('fA'));
    // a configuration that the result does not have: all
    cfg = 'Z';
    listeners.forEach((cb) => cb('Z'));
    eq(app.fids(), all);
    assert.ok(app.internals.inConfig({ dataset: null }, 'A') && app.internals.inConfig({ dataset: 'A' }, 'A') && !app.internals.inConfig({ dataset: 'B' }, 'A'));
    // without the hooks of the Tuning view: no menu, all results
    const lone = await shown({ result: withConfigs(synthResult()) });
    assert.equal(lone.html('config'), '');
    eq(lone.fids(), all);
});

test('M4: the open log has no data that the app can read: the lens says so, with the reason of the decoder quoted', async () => {
    const r = synthResult({ scope: 'file', logs: [0, 1] });
    r.records = [{ log: 1, segment: 0, noData: true, noDataReason: 'No frames <b>x</b>' }];
    r.findings = [];
    const app = await shown({ result: r });
    assert.ok(app.html('notice').includes('<div class="log-lens-notice is-warn">No data that the app can read. <span data-ste="quoted">No frames &lt;b&gt;x&lt;/b&gt;</span></div>'), app.html('notice'));
    eq(app.internals.noDataOf(r, 1), { why: 'No frames <b>x</b>' });
    eq(app.internals.noDataOf(r, 0), null);
});

// --- The notch filters of the log (result.notchFit) and the PID profile at the start of the log --------------------------------

const ROTOR = 2000 / 60; // the headspeed of the window (SIGNAL): 2000 rpm
const FIT = { used: true, logs: [1], tail: { passed: true, order: 4.0019, se: 0.0016, n: 6, unit: 'flight', axis: 'yaw', depthDb: -40.1, sources: [21], Q: 5, reasons: [] }, motor: null, ms: 12 };

// A result whose vibration curves have the RPM notch filters as health_more.cjs curves gives them ({ code, q, order, hz, label }
// at the median headspeed, 2000 rpm): main rotor 1x and 2x, and tail rotor 1x. fit: result.notchFit; tail: the order of the
// tail rotor filter (null: not known, then hz null too, as without the fit of the log)
function withNotches({ fit = FIT, tail = 4.0019 } = {}) {
    const r = synthResult(), bank = () => [{ code: 11, q: 8, order: 1, hz: 33.3, label: 'main rotor 1x' }, { code: 12, q: 4, order: 2, hz: 66.7, label: 'main rotor 2x' },
        { code: 21, q: 5, order: tail, hz: tail === null ? null : +(tail * ROTOR).toFixed(1), label: 'tail rotor 1x' }];
    r.curves[0].more.vib = { rotorHz: { 1: +ROTOR.toFixed(2), 2: +ROTOR.toFixed(2) }, notches: { roll: bank(), pitch: bank(), yaw: bank() }, byProfile: {} };
    r.notchFit = fit;
    return r;
}

// derive("window") with the gyro lines of each axis measured against params.notchHz as js/tuning_worker.js windowStats measures
// them: the nearest filter and |filter - line| / line. Yaw: the tail rotor line at 4.0019 x and a resonance at 3.78 x
function tailValues(params) {
    const at = { roll: [[33.4, 9, 40], [66.6, 4, 20]], pitch: [[66.7, 3, 15]], yaw: [[4.0019 * ROTOR, 2.5, 30], [3.78 * ROTOR, 1.4, 12]] };
    return synthValues((items) => items.map((q) => {
        if (!/^lines\./.test(q.key)) return q;
        const list = (params.notchHz && params.notchHz[q.axis]) || [];
        const lines = at[q.axis].map(([hz, amplitude, prominence]) => {
            const o = { hz: +hz.toFixed(2), amplitude, prominence, order: +(hz / ROTOR).toFixed(3) };
            if (list.length) { const near = list.reduce((b, v) => (Math.abs(v - hz) < Math.abs(b - hz) ? v : b), list[0]); o.notch = { hz: near, distance: +(Math.abs(near - hz) / hz).toFixed(4) }; }
            return o;
        });
        return Object.assign({}, q, { value: lines[0].amplitude, detail: { rotorHz: +ROTOR.toFixed(2), lines } });
    }));
}

test('notch filters: the kind of each filter, the fit of the log, the frequency at the headspeed of the window from the order', () => {
    const I = setup().internals;
    eq([10, 11, 18, 20, 21, 28, 0].map((code) => I.notchKind({ code })), ['motor', 'main rotor', 'main rotor', 'tail motor', 'tail rotor', 'tail rotor', null]);
    eq(['main motor 1x', 'tail rotor 2x', 'main 2x', ''].map((label) => I.notchKind({ label })), ['motor', 'tail rotor', null, null], 'without a code: the label of the curves');
    assert.equal(I.notchFitOf(FIT, 'tail rotor').order, 4.0019);
    eq([I.notchFitOf(FIT, 'motor'), I.notchFitOf(FIT, 'main rotor'), I.notchFitOf(Object.assign({}, FIT, { used: false }), 'tail rotor'),
        I.notchFitOf(Object.assign({}, FIT, { tail: Object.assign({}, FIT.tail, { passed: false }) }), 'tail rotor'), I.notchFitOf(null, 'tail rotor')], [null, null, null, null, null],
        'only a fit that passed and that the checks use');
    // ground truth of the real Fireball 2026-10-05 dump, log 6: the curves label the 23.3 s before the first PID profile change 0 (rotor
    // 58.37 Hz, 3500 rpm), the records give PID profile 1 for it, and the notch filters of the curves are at the median headspeed
    // (rotor 74.97 Hz). In a window at 3500 rpm the filters are at order x 58.37 Hz, not at the 75 Hz, 150 Hz and 300 Hz of 4500 rpm
    const fb = { rotorHz: { 0: 58.37, 2: 74.97 }, byProfile: { 0: { rotorHz: 58.37 }, 2: { rotorHz: 74.97 } },
        notches: { yaw: [{ code: 11, q: 8, order: 1, hz: 75, label: 'main rotor 1x' }, { code: 12, q: 4, order: 2, hz: 149.9, label: 'main rotor 2x' },
            { code: 21, q: 5, order: 4.0019, hz: 300, label: 'tail rotor 1x' }] } };
    const s = I.notchSet(fb, 1, 'yaw', 58.37, FIT);
    eq(s.list.map((q) => [+q.hz.toFixed(2), q.kind, q.fit ? q.fit.order : null]), [[58.37, 'main rotor', null], [116.74, 'main rotor', null], [233.59, 'tail rotor', 4.0019]]);
    eq(s.unknown, []);
    // without an order (an older result): hz scaled by the rotor frequency of the PID profile, as before
    eq(I.notchSet({ rotorHz: ROTOR, notches: { roll: [{ hz: 66.7, q: 8, label: 'main 2x' }] } }, 1, 'roll', ROTOR * 1.1, null).list.map((q) => +q.hz.toFixed(2)), [73.37]);
    // the tail rotor filter without its order (no fit of the log): no frequency, and its kind is known
    const none = I.notchSet(withNotches({ fit: null, tail: null }).curves[0].more.vib, 1, 'yaw', ROTOR, null);
    eq([none.list.map((q) => q.kind), none.unknown], [['main rotor', 'main rotor'], ['tail rotor']]);
    assert.equal(I.unknownNotchText(['tail rotor']), 'The log does not show the frequency of the tail rotor notch filters.');
    assert.equal(I.unknownNotchText(['tail rotor', 'motor']), 'The log does not show the frequency of the tail rotor and motor notch filters.');
    assert.equal(I.unknownNotchText(['tail rotor', '']), 'The log does not show the frequency of some notch filters.');
});

test('the gyro lines of the window: with a result, "Monitor" only when no filter can be at the line; a tail rotor filter that the log does not show gives "Information"', () => {
    const I = setup().internals, row = (rows, a) => rows.find((r) => r.what === 'Gyro lines, ' + a), pick = (r) => [r.status, r.levelText];
    const vib = (o) => withNotches(o).curves[0].more.vib, sets = (o, fit) => Object.fromEntries(['roll', 'pitch', 'yaw'].map((a) => [a, I.notchSet(vib(o), 1, a, ROTOR, fit)]));
    const hz = (s) => ({ notchHz: Object.fromEntries(Object.entries(s).map(([a, q]) => [a, q.list.map((n) => n.hz)])) });
    // the fit of the log: the tail rotor line is at its filter (from the log); the 3.78 x line has no filter at 2 % or less
    const fit = sets({}, FIT), withFit = I.windowRows(tailValues(hz(fit)), fit);
    eq(pick(row(withFit, 'yaw')), ['monitor', 'No notch filter at 2 % or less']);
    assert.ok(row(withFit, 'yaw').note.endsWith('The frequency of the tail rotor notch filters comes from the log.'), row(withFit, 'yaw').note);
    eq(pick(row(withFit, 'roll')), ['satisfactory', 'Notch filter at 2 % or less']);
    // no fit: the worker measures the tail line against the main rotor filters only (the critic's false "Monitor"): "Information"
    const gap = sets({ fit: null, tail: null }, null), noFit = I.windowRows(tailValues(hz(gap)), gap);
    assert.ok(row(noFit, 'yaw').note.includes('The log does not show the frequency of the tail rotor notch filters.'), row(noFit, 'yaw').note);
    eq(pick(row(noFit, 'yaw')), ['information', 'Notch filter frequency unknown']);
    eq(pick(row(noFit, 'roll')), ['satisfactory', 'Notch filter at 2 % or less'], 'all lines at a filter: satisfactory also with the gap');
    for (const r of noFit) assert.ok(!r.note.includes(I.TEXT.notches), 'a result: never "without an analysis result"');
    // the same values with the old call (no notch filters of a result): the old rule
    eq(pick(row(I.windowRows(tailValues(hz(gap))), 'yaw')), ['monitor', 'No notch filter at 2 % or less']);
    // a result with no RPM notch filter on the axis: a strong line has no filter (check F5 counts it), "Monitor"
    const empty = { roll: { list: [], unknown: [] }, pitch: { list: [], unknown: [] }, yaw: { list: [], unknown: [] } }, bare = I.windowRows(tailValues({ notchHz: null }), empty);
    eq(pick(row(bare, 'yaw')), ['monitor', 'No notch filter at 2 % or less']);
    // a result that has no vibration curves for this log, and no result
    const noCurves = I.windowRows(tailValues({ notchHz: null }), {}), none = I.windowRows(tailValues({ notchHz: null }), null);
    eq(pick(row(noCurves, 'yaw')), ['information', 'Prominence 5 or more']);
    assert.ok(row(noCurves, 'yaw').note.endsWith('The analysis result does not give the notch filters of this log.'));
    assert.ok(row(none, 'yaw').note.endsWith('The notch filters are not available without an analysis result.'));
});

test('the lens with the fit of the log: the tail rotor filter in the window values and in "Show", with the basis "from the log"', async () => {
    const app = await shown({ result: withNotches(), values: tailValues });
    const d = app.derives.filter((c) => c.kind === 'window').pop();
    eq(Object.fromEntries(Object.entries(d.params.notchHz).map(([a, l]) => [a, l.map((v) => +v.toFixed(2))])), { roll: [33.33, 66.67, 133.4], pitch: [33.33, 66.67, 133.4], yaw: [33.33, 66.67, 133.4] },
        'order x the rotor frequency of the window');
    const values = app.html('values');
    assert.ok(values.includes('The frequency of the tail rotor notch filters comes from the log.'));
    assert.ok(!values.includes('Notch filter frequency unknown') && !values.includes(app.internals.TEXT.notches));
    app.click('show', { 'data-arg': 'lines:yaw' });
    await flush();
    const spec = app.plots[app.plots.length - 1].spec, notch = spec.vlines.filter((l) => /^notch filter/.test(l.label));
    eq(notch.map((l) => [+l.x.toFixed(2), l.label, l.dash]), [[33.33, 'notch filter Q 8', [4, 2]], [66.67, 'notch filter Q 4', [4, 2]], [133.4, 'notch filter Q 5, from the log', [8, 3]]]);
    assert.ok(app.html('detail-body').includes('The analysis found the frequency of the tail rotor notch filters in the log: 4.0019 ± 0.0016 × the rotor frequency.'), app.html('detail-body'));
});

test('the lens without the fit of the log: the log does not show the tail rotor filter, and a tail line is not "Monitor"', async () => {
    const app = await shown({ result: withNotches({ fit: Object.assign({}, FIT, { used: false, tail: Object.assign({}, FIT.tail, { passed: false }) }), tail: null }), values: tailValues });
    const d = app.derives.filter((c) => c.kind === 'window').pop();
    eq(d.params.notchHz.yaw.map((v) => +v.toFixed(2)), [33.33, 66.67], 'no frequency for the tail rotor filter');
    const values = app.html('values'), yaw = values.slice(values.indexOf('Gyro lines, yaw'));
    assert.ok(yaw.includes('The log does not show the frequency of the tail rotor notch filters.') && yaw.includes('Notch filter frequency unknown'), yaw);
    assert.ok(!yaw.includes('No notch filter at 2 % or less') && !values.includes(app.internals.TEXT.notches) && !/CLI dump|diff all/.test(values));
    app.click('show', { 'data-arg': 'lines:yaw' });
    await flush();
    const spec = app.plots[app.plots.length - 1].spec;
    eq(spec.vlines.filter((l) => /^notch filter/.test(l.label)).map((l) => l.label), ['notch filter Q 8', 'notch filter Q 4']);
    assert.ok(app.html('detail-body').includes('The log does not show the frequency of the tail rotor notch filters. Thus, the plot does not show them.'), app.html('detail-body'));
});

test('the PID profile at the start of the log: the profile and how the analysis found it ("govRequest" and the PID profile changes)', async () => {
    const I = setup().internals;
    const hs = { profile: 1, basis: ['headspeed'], confirmed: true, estimate: null,
        headspeed: { headspeed: 2300, why: null, profile: 1, observations: { switches: 13, logs: 8 }, map: { 1: [2100, 2300], 2: [1000, 2500] } } };
    const said = 'Start of the log: PID profile 1. At the start, <code>govRequest</code> is 2300 rpm. ' +
        'In this file, only PID profile 1 has this value after a PID profile change (13 changes in 8 logs).';
    assert.equal(I.startHtml(hs, 'file'), said, 'the real Gaui 2026-10-04 11:37 file, log 50');
    assert.equal(I.startHtml(Object.assign({}, hs, { headspeed: Object.assign({}, hs.headspeed, { observations: { switches: 1, logs: 1 } }) }), 'log'),
        said.replace('In this file', 'In this log').replace('(13 changes in 8 logs)', '(1 change in 1 log)'));
    eq([{ profile: 0, basis: [], confirmed: false, headspeed: { headspeed: 3500, why: 'cli' } }, { profile: 2, basis: ['event'], confirmed: true },
        { profile: 3, basis: ['cli'], confirmed: true }, { profile: 3, basis: ['cliTarget'], confirmed: true }, { profile: 2, basis: [], confirmed: false }, null].map((a) => I.startHtml(a, 'file')),
        ['Start of the log: PID profile unknown.', 'Start of the log: PID profile 2. A log event at the start of the log gives this PID profile.',
            'Start of the log: PID profile 3. Only this PID profile of the CLI dump has the same values as the log header.',
            'Start of the log: PID profile 3. Only this PID profile of the CLI dump has the headspeed of <code>govTarget</code> at the start.',
            'Start of the log: PID profile unknown.', '']);
    // records[].profiles.arming of the log first, else result.profiles.arming[] of that log
    const r = synthResult({ records: [{ log: 1, segment: 0, phases: { flight: true, spans: [{ phase: 'flight', t0: 0, t1: LEN }] }, profiles: { arming: hs, pid: [{ t0: 0, t1: LEN, profile: 1 }] } }] });
    assert.equal(I.armingOf(r, 1), r.records[0].profiles.arming);
    assert.equal(I.armingOf({ profiles: { arming: [{ log: 0, profile: 2 }, Object.assign({ log: 1 }, hs)] } }, 1).headspeed.headspeed, 2300);
    assert.equal(I.armingOf(synthResult(), 1), null);
    // the lens: under the legend; nothing without a result or for a bench run
    const app = await shown({ result: r });
    assert.equal(app.html('start'), said.replace('In this file', 'In this log'));
    app.give(null);
    assert.equal(app.html('start'), '');
    const bench = synthResult({ scope: 'file', logs: [0], records: [{ log: 1, segment: 0, phases: { flight: false, spans: [{ phase: 'idle', t0: 0, t1: LEN }] }, profiles: { arming: hs } }] });
    app.give(bench);
    assert.equal(app.html('start'), '');
    const css = read('css/log_lens.css');
    assert.ok(/\.log-lens-start \{/.test(css) && /\.log-lens-start:empty \{\s*display: none;/.test(css), 'css/log_lens.css styles the line');
});

// --- Values that are possibly not the values of the log header (CLAUDE.md "Values that are possibly not current") ----------------

// result.freshness and result.epochs as js/tuning_worker.js freshnessOf writes them (the texts of the real Fireball 2026-10-05 run)
const FRESHNESS = {
    caveat: 'The log does not record a change that the transmitter or the Configurator makes after the pilot arms the helicopter.',
    reasons: {
        grace: 'After the pilot disarms the helicopter, the log continues for some seconds. The log does not record a change at this time.',
        rearm: 'The pilot armed the helicopter again in the same log. The log header has the values of the first arm only. A change between the arms is not in the log.',
        switched: 'This part of the log uses a PID profile or a rate profile that is not the one at the start of the log. The log header has only the values at the start of the log.',
        unlogged: '"govRequest" changes, and the log records no PID profile change at that time. Thus, the pilot possibly changed a value, and the log does not show the change.',
        adjusted: 'An in-flight adjustment changed a value. The log header has the value before the change.',
        resume: 'The log has a period with no data. The log does not record a change in that period.' } };
// log 1 (the open log): armed in PID profile 1 to 20 s, a disarm at 20 s, a second arm at 25 s, PID profile 2 from 150 s (its values
// from the header of log 0); log 2: a part with a reason that the open log must not show
function withEpochs(r = synthResult()) {
    const span = (t0, t1, o) => Object.assign({ t0, t1, arm: 0, armed: true, pidProfile: 1, rateProfile: 0, fresh: false, reasons: [], adjust: [], check: null,
        source: { pid: 'header', rate: 'header' }, text: '' }, o);
    r.epochs = [
        { log: 1, spans: [span(0, 20, { fresh: true }),
            span(20, 25, { armed: false, reasons: ['grace'], text: 'The pilot disarmed the helicopter at 20 s, and the log does not record a change in this part. The values come from the log header of log 2.' }),
            span(25, 150, { arm: 1, reasons: ['rearm'], text: 'The pilot armed the helicopter again at 25 s, and the log header has the values of the first arm only. The values come from the log header of log 2.' }),
            span(150, 300, { arm: 1, pidProfile: 2, reasons: ['rearm', 'switched'], source: { pid: 'log 0', rate: 'header' },
                text: 'The pilot armed the helicopter again at 25 s, and the log header has the values of the first arm only. This part flies PID profile 2, and the log header has the values of PID profile 1. ' +
                    'The values of PID profile 2 come from the log header of log 1. The other values come from the log header of log 2.' })] },
        { log: 2, spans: [span(0, 300, { reasons: ['unlogged'], text: 'At 12 s, "govRequest" changes from 2000 rpm to 2300 rpm with no PID profile change in the log.' })] }];
    r.freshness = FRESHNESS;
    return r;
}

test('values possibly not from the log header: the parts of result.epochs, their causes and the source of their values (pure)', () => {
    const I = setup().internals, r = withEpochs();
    eq(I.EPOCH_REASONS, ['grace', 'rearm', 'switched', 'unlogged', 'adjusted', 'resume'], 'the order of param_epochs.cjs');
    eq(I.epochSpansOf(r, 1).map((s) => [s.t0, s.t1, s.stale, s.reasons, s.pidProfile]), [[0, 20, false, [], 1], [20, 25, true, ['grace'], 1], [25, 150, true, ['rearm'], 1],
        [150, 300, true, ['rearm', 'switched'], 2]]);
    eq(I.staleSpansOf(r, 1).map((s) => s.t0), [20, 25, 150]);
    eq(I.staleSpansOf(r, 0), [], 'a log without epochs');
    eq(I.staleSpansOf({}, 1), [], 'a result without epochs (an older worker)');
    eq(I.windowEpochs(r, 1, 10, 20), [], 'a window of the fresh part: no flag (a part that starts at the end of the window is not in it)');
    eq(I.windowEpochs(r, 1, 18, 28).map((s) => s.t0), [20, 25]);
    eq(I.windowEpochs(r, 2, 0, 10).map((s) => s.reasons), [['unlogged']], 'the parts of each log');
    // a part with no reason that the view knows, an unknown reason, a part with no time, fresh with no reasons
    const odd = { epochs: [{ log: 0, spans: [{ t0: 5, t1: 9, fresh: false, reasons: ['x'] }, { t0: 1, t1: 2, reasons: ['resume', 'x'] }, { t0: 3, t1: 3, reasons: ['grace'] }, { t0: 2, t1: 5, reasons: [] }, null] }] };
    eq(I.epochSpansOf(odd, 0).map((s) => [s.t0, s.stale, s.reasons, s.text, s.source]), [[1, true, ['resume'], '', null], [2, false, [], '', null], [5, true, [], '', null]]);
    eq(I.epochCauses(['rearm', 'switched']), 'a second arm in the same log and a different PID profile or rate profile');
    eq(I.epochCauses(['grace', 'unlogged', 'adjusted', 'resume']), 'the time after a disarm, a change of "govRequest", an in-flight adjustment and a period with no data');
    eq(I.epochCauses([]), '');
    // the source of the values (span.source: header, cli, "log N" 0-based, recovered, adjustment, none), or "unknown"
    const src = (pid, rate, o = {}, res = r) => I.epochSource(Object.assign({ pidProfile: 2, rateProfile: 3, source: pid === undefined ? null : { pid, rate } }, o), res);
    eq([src('header', 'header'), src('log 6', 'header'), src('none', 'header'), src('recovered', 'header'), src('adjustment', 'adjustment'), src('cli', 'header'),
        src('cli', 'header', {}, { cliStatus: { used: false, conflicts: [] } }), src('cli', 'header', {}, { cliStatus: { used: true, conflicts: [{ what: 'gov_headspeed', profile: 2 }] } }),
        src('cli', 'header', {}, { cliStatus: { used: true, conflicts: [{ what: 'gov_headspeed', profile: 1 }] } }), src('header', 'log 2'), src('none', 'none', { rateProfile: 0 }),
        src('header', 'header', { pidProfile: 0 }), src(undefined)],
    ['PID profile 2, values from the log header', 'PID profile 2, values from log 7', 'PID profile 2, values unknown', 'PID profile 2, gains from the flights',
        'PID profile 2, values from an in-flight adjustment', 'PID profile 2, values from the CLI dump', 'PID profile 2, values from a CLI dump that does not agree with the log',
        'PID profile 2, values from a CLI dump that does not agree with the log', 'PID profile 2, values from the CLI dump', 'PID profile 2, values from the log header · Rate profile 3, values from log 3',
        'PID profile 2, values unknown', 'PID profile unknown, values from the log header', 'PID profile 2, values unknown']);
    eq(src('header', 'none', { rateProfile: 0 }), 'PID profile 2, values from the log header · Rate profile unknown, values unknown');
    // the timeline pieces of a PID profile run
    eq(I.cutAt(0, 150, [{ t0: 20, t1: 25 }, { t0: 25, t1: 150 }, { t0: 150, t1: 300 }]), [{ t0: 0, t1: 20, on: false }, { t0: 20, t1: 25, on: true }, { t0: 25, t1: 150, on: true }]);
    eq(I.cutAt(150, 300, [{ t0: 20, t1: 25 }, { t0: 150, t1: 300 }]), [{ t0: 150, t1: 300, on: true }]);
    eq(I.cutAt(0, 10, [{ t0: 2, t1: 4 }]), [{ t0: 0, t1: 2, on: false }, { t0: 2, t1: 4, on: true }, { t0: 4, t1: 10, on: false }]);
    eq(I.cutAt(0, 10, []), [{ t0: 0, t1: 10, on: false }]);
    eq(I.cutAt(5, 5, []), [{ t0: 5, t1: 5, on: false }], 'a run of no time: one piece');
    // the flag rows: the time of the window that the parts cover, each part with its causes, time, source and text; EPOCH_ROWS at most
    const rows = I.epochRowsHtml(I.windowEpochs(r, 1, 18, 28), r, 18, 28);
    assert.ok(rows.startsWith('<h6 class="log-lens-sub">Values possibly different <span class="log-lens-count">8.0 s of 10.0 s</span></h6><ul class="log-lens-epoch-list">'), rows);
    assert.ok(rows.includes('<li class="log-lens-epoch"><div class="log-lens-epoch-head"><strong>The time after a disarm</strong> <span class="log-lens-epoch-meta">20.0 s to 25.0 s · PID profile 1, values from the log header</span></div>' +
        '<div class="log-lens-epoch-text">The pilot disarmed the helicopter at 20 s, and the log does not record a change in this part. The values come from the log header of log 2.</div></li>'), rows);
    assert.equal(I.epochRowsHtml([], r, 0, 10), '');
    const many = Array.from({ length: 6 }, (_, i) => ({ t0: i, t1: i + 1, reasons: ['resume'], text: '', source: { pid: 'header', rate: 'header' }, pidProfile: 1, rateProfile: 0 }));
    const six = I.epochRowsHtml(many, r, 0, 10);
    assert.equal((six.match(/<li class="log-lens-epoch">/g) || []).length, I.EPOCH_ROWS);
    assert.ok(six.endsWith('<p class="log-lens-muted">2 more parts of the log with these values are in the time window.</p>'), six);
    assert.ok(I.epochRowsHtml(many.slice(0, 5), r, 0, 10).endsWith('<p class="log-lens-muted">1 more part of the log with these values is in the time window.</p>'));
    assert.ok(six.includes('<div class="log-lens-epoch-text">The log has a period with no data. The log does not record a change in that period.</div>'), 'no text of the worker: the text of the reason (result.freshness.reasons)');
    assert.ok(!I.epochRowsHtml(many.slice(0, 1), {}, 0, 10).includes('log-lens-epoch-text'), 'neither: only the causes and the source');
    const hostile = I.epochRowsHtml([Object.assign({}, many[0], { text: HOSTILE })], r, 0, 10);
    assert.ok(!hostile.includes('<img') && hostile.includes('&lt;img'), 'the text of the worker is escaped');
});

test('values possibly not from the log header: the lens shows a flag row for each such part of the window, and these parts are lighter on the PID profile strip', async () => {
    const app = await shown({ result: withEpochs() }), I = app.internals, R = I.timelineRows(app.timeline.clientHeight, I.textMetrics().k, false);
    assert.equal(app.html('epochs'), '', 'the window 10 s to 20 s: the fresh part only');
    app.lens.internals.setWindow(18, 28);
    const h = app.html('epochs');
    assert.ok(h.startsWith('<h6 class="log-lens-sub">Values possibly different <span class="log-lens-count">8.0 s of 10.0 s</span></h6>'), h);
    eq([...h.matchAll(/<strong>([^<]+)<\/strong> <span class="log-lens-epoch-meta">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]),
        [['The time after a disarm', '20.0 s to 25.0 s · PID profile 1, values from the log header'], ['A second arm in the same log', '25.0 s to 150.0 s · PID profile 1, values from the log header']]);
    assert.ok(h.includes('The pilot armed the helicopter again at 25 s, and the log header has the values of the first arm only. The values come from the log header of log 2.'));
    // the window moves into PID profile 2, whose values come from the header of another log
    app.lens.internals.setWindow(145, 155);
    assert.ok(app.html('epochs').includes('<strong>A second arm in the same log and a different PID profile or rate profile</strong> <span class="log-lens-epoch-meta">150.0 s to 300.0 s · PID profile 2, values from log 1</span>'),
        app.html('epochs'));
    assert.ok(app.html('epochs').includes('The values of PID profile 2 come from the log header of log 1. The other values come from the log header of log 2.'));
    assert.ok(!app.html('epochs').includes('govRequest'), 'not the parts of log 2');
    // the timeline: the PID profile strip lighter in these parts (as the configuration with values of another log), and the legend
    const strip = lastDraw(app.timeline.ctx).filter((c) => c.m === 'fillRect' && c.a[1] === R.P0);
    const x = (t) => 6 + 788 * t / LEN;
    eq(strip.map((c) => [+c.a[0].toFixed(3), c.alpha]), [[x(0), 1], [x(20), I.EPOCH_ALPHA], [x(25), I.EPOCH_ALPHA], [x(150), I.EPOCH_ALPHA]].map((q) => [+q[0].toFixed(3), q[1]]));
    assert.equal(I.EPOCH_ALPHA, 0.4);
    assert.ok(app.html('legend').includes('<span class="log-lens-legend-gap"><i class="log-lens-swatch is-epoch"></i>Values possibly different</span>'), app.html('legend'));
    assert.ok(/\.log-lens-swatch\.is-epoch \{/.test(read('css/log_lens.css')) && /\.log-lens-epochs:empty \{\s*display: none;/.test(read('css/log_lens.css')), 'css/log_lens.css styles the rows and the swatch');
    // no result, or a result without epochs (an older worker): no rows, no swatch, the strip as before
    app.give(null);
    assert.equal(app.html('epochs'), '');
    app.give(synthResult());
    assert.equal(app.html('epochs'), '');
    assert.ok(!app.html('legend').includes('is-epoch'));
    eq(lastDraw(app.timeline.ctx).filter((c) => c.m === 'fillRect' && c.a[1] === R.P0).map((c) => c.alpha), [1, 1]);
    // a result through onResult: the rows of the window at once
    app.give(withEpochs());
    assert.ok(app.html('epochs').includes('150.0 s to 300.0 s'));
    // the PID profile strip of a log without PID profiles: the stale parts on its row
    const ctx = { calls: [], texts: [] };
    for (const m of ['fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'setTransform']) ctx[m] = (...a) => ctx.calls.push({ m, a, alpha: ctx.globalAlpha === undefined ? 1 : ctx.globalAlpha });
    ctx.fillText = () => {};
    I.drawTimeline(ctx, 800, 96, { len: LEN, trace: null, label: '', profiles: [], phases: [], spans: [], epochs: [{ t0: 20, t1: 25 }] }, null);
    eq(ctx.calls.filter((c) => c.m === 'fillRect' && c.a[1] === I.timelineRows(96).P0).map((c) => c.alpha), [I.EPOCH_ALPHA]);
    assert.deepEqual(app.errors, []);
});
