// The Tuning view (js/tuning_dialog.js) in node:vm with a minimal jQuery and DOM stand-in: it renders a synthetic
// TuningResult (with the tuning sequence and log evidence) in every tab without throwing, escapes what comes from the log,
// drives the worker protocol of docs/DEVELOPMENT.md section 4 and the derive worker, draws the tuning sequence, shows log
// spans in the viewer in frame seconds, draws "Show the measurement" from curves and from a raw span, and is registered
// once in index.html and in gulpfile.js distSources.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const advice = require('../tools/autotune/advice.cjs');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const HOSTILE = '<img src=x onerror=alert(1)>"\'&';
const HOSTILE_ESCAPED = '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;';
const TOOLKIT = ['lib', 'health', 'health_setup', 'health_gov', 'health_loop', 'health_report', 'extract', 'report',
    'health_track', 'health_more', 'advice', 'catalog', 'hierarchy', 'evidence'].map((n) => `./tools/autotune/${n}.cjs`);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const plain = (v) => JSON.parse(JSON.stringify(v));
const eq = (got, want, what) => assert.deepEqual(plain(got), want, what); // objects of the vm realm, compared as JSON

// The two filters of the result lists on (SPEC3 E): every result in the lists, as before the filters
function showAllResults(app) {
    app.jq.fire('change', '.tuning-rf', { 'data-rf': 'thin' }, { checked: true });
    app.jq.fire('change', '.tuning-rf', { 'data-rf': 'ok' }, { checked: true });
}

// --- stand-ins -------------------------------------------------------------------------------------------------

function fakeElement(tag = 'div') {
    const events = {};
    return {
        tagName: tag.toUpperCase(), children: [], parentNode: null, style: {}, scrolled: 0,
        addEventListener(type, fn) { (events[type] = events[type] || []).push(fn); },
        dispatchEvent(e) { (events[e.type] || []).forEach(fn => fn(e)); },
        appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; },
        insertAdjacentElement(where, child) {
            assert.equal(where, 'afterend');
            child.remove();
            const parent = this.parentNode;
            parent.children.splice(parent.children.indexOf(this) + 1, 0, child);
            child.parentNode = parent;
        },
        remove() {
            if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
            this.parentNode = null;
        },
        scrollIntoView() { this.scrolled++; }, select() {},
    };
}

// jQuery: every selector maps to one record of what the view wrote there (the view's selectors are unique)
function fakeJquery() {
    const nodes = new Map(), handlers = [], modal = [];
    const node = (sel) => {
        if (!nodes.has(sel)) nodes.set(sel, { sel, html: '', text: '', val: '', props: {}, attrs: {}, css: {}, classes: new Set(), clicks: 0, element: fakeElement() });
        return nodes.get(sel);
    };
    const wrap = (n) => {
        const w = {
            0: Object.assign(n.element, { click() { n.clicks++; } }), length: n.sel.startsWith('$') ? 0 : 1,
            find: (sel) => wrap(node(sel)),
            html(v) { if (v === undefined) return n.html; n.html = String(v); n.htmlWrites = (n.htmlWrites || 0) + 1; return w; },
            text(v) { if (v === undefined) return n.text; n.text = String(v); return w; },
            val(v) { if (v === undefined) return n.val; n.val = v; return w; },
            prop(k, v) { if (v === undefined) return n.props[k]; n.props[k] = v; return w; },
            attr(k, v) { if (v === undefined) return n.attrs[k]; n.attrs[k] = v; return w; },
            css(k, v) { if (v === undefined) return n.css[k]; n.css[k] = v; return w; },
            toggleClass(c, on) { if (on) n.classes.add(c); else n.classes.delete(c); return w; },
            on(type, sel, fn) { if (typeof sel === 'function') { fn = sel; sel = null; } handlers.push({ type, sel, fn }); return w; },
            modal(cmd) { modal.push(cmd); return w; },
            remove() { return w; },
        };
        return w;
    };
    // An event on an element matching a delegated selector: the handler gets the element as `this`
    function fire(type, sel, attrs = {}, props = {}) {
        const el = props.element || Object.assign({ getAttribute: (k) => (k in attrs ? String(attrs[k]) : null), textContent: 'Copy' }, props);
        const hit = handlers.filter((h) => h.type.split(' ').includes(type) && h.sel === sel);
        hit.forEach((h) => h.fn.call(el, { preventDefault() {}, which: props.which }));
        return { count: hit.length, el };
    }
    const $ = (sel) => wrap(node(typeof sel === 'string' && !/^#(dlg|view)/.test(sel) ? '$' + sel : sel));
    return { $, node, nodes, fire, modal, handlers };
}

// A viewer FlightLog of `count` logs: log i runs from t0 + 10 i to t0 + 8 + 10 i seconds
function fakeLog({ count = 3, current = 1, t0 = 1, sysConfig = {} } = {}) {
    let index = current;
    return {
        getLogCount: () => count, getLogIndex: () => index, openLog: (i) => { index = i; return true; }, getLogError: () => false,
        getMinTime: (i = index) => 1e6 * (t0 + 10 * i), getMaxTime: (i = index) => 1e6 * (t0 + 8 + 10 * i),
        getSysConfig: () => Object.assign({ 'Craft name': HOSTILE, 'Firmware revision': 'Rotorflight 4.6.0 (118e912) STM32F7X2',
            looptime: 125, frameIntervalPNum: 1, frameIntervalPDenom: 8, pid_process_denom: 1 }, sysConfig),
    };
}

// The hooks read the viewer's file, name and FlightLog at each call, as js/main.js's do; liveHook false: a host without
// getFlightLog, where the view uses the FlightLog given to show()
function setup({ result, logCount = 3, current = 1, sysConfig = {}, liveHook = true, hooks: extraHooks = null, scope = 'log' } = {}) {
    const jq = fakeJquery(), workers = [], plots = [], destroyed = [], errors = [], saved = [], copied = [], elements = {}, reads = [], later = [];
    const calls = { seek: [], selectLog: [] };
    let bytes = Uint8Array.from({ length: 400 }, (_, i) => (i * 7) & 0xff), fileName = '<i>flight</i>.bbl';
    let flightLog = fakeLog({ count: logCount, current, sysConfig });
    const offsets = [0, 100, 250, 400];
    class Worker {
        constructor(url) { this.url = url; this.sent = []; this.terminated = false; workers.push(this); }
        postMessage(msg, transfer) { this.sent.push({ msg, transfer }); }
        terminate() { this.terminated = true; }
        reply(data, id = this.sent[0].msg.id) { this.onmessage({ data: Object.assign({ id }, data) }); }
    }
    const document = {
        getElementById(id) {
            if (!elements[id]) elements[id] = { id, parentNode: { innerHTML: '', className: '' }, scrolled: 0, scrollIntoView() { this.scrolled++; } };
            return elements[id];
        },
        createElement: fakeElement,
        body: { appendChild() {} },
        execCommand: () => true,
    };
    // raw spans for "Show the measurement": the Reader of js/tuning_snippet.js, answered from `snippet` (fields -> f(t))
    const snippet = { rate: 1000, fields: {} };
    const TuningSnippet = {
        Reader: function (h) {
            this.hooks = h;
            this.read = (li, t0, t1, fields) => {
                reads.push({ li, t0, t1, fields: [...fields] });
                const n = Math.round((t1 - t0) * snippet.rate) + 1, t = Float64Array.from({ length: n }, (_, i) => t0 + i / snippet.rate), cols = {}, missing = [];
                for (const name of fields) {
                    if (snippet.fields[name]) cols[name] = Float32Array.from(t, snippet.fields[name]);
                    else missing.push(name);
                }
                return Promise.resolve({ log: li, t0, t1, t, cols, missing, frames: n, rate: snippet.rate, clipped: false, source: 'viewer' });
            };
        },
    };
    const context = vm.createContext({
        $: jq.$, document, Worker, Blob, console: { log() {}, warn() {}, error: (e) => errors.push(e) },
        // short timers run at once; the derive timeout (30 s) waits in `later`
        setTimeout: (fn, ms) => { if ((ms || 0) <= 2000) fn(); else later.push(fn); return 0; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
        navigator: { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } },
        // the three logs of the 400-byte files, one log in any other
        FlightLogIndex: function (b) {
            const o = b.length === offsets.at(-1) ? offsets : [0, b.length];
            this.getLogCount = () => o.length - 1;
            this.getLogBeginOffset = (i) => o[i];
        },
        FileReader: function () { this.readAsText = (file) => { this.result = file.text; this.onload(); }; },
        TuningPlot: {
            attach(canvas, spec) {
                const plot = { canvas, spec }; plots.push(plot);
                return { update(next) { plot.spec = next; }, destroy() { destroyed.push(spec.title); } };
            },
        },
        TuningSnippet,
        pickSaveFile: (options) => Promise.resolve({ write: async (blob) => saved.push({ options, text: await blob.text() }) }),
        reportSaveError: (e) => errors.push(e),
        getLogBaseFilename: () => 'flight',
    });
    vm.runInContext(read('js/tuning_dialog.js'), context, { filename: 'js/tuning_dialog.js' });
    vm.runInContext(read('js/log_lens.js'), context, { filename: 'js/log_lens.js' });
    const hooks = {
        seek: (us) => calls.seek.push(us), selectLog: (i) => { calls.selectLog.push(i); flightLog.openLog(i); },
        getBytes: () => bytes, getFileName: () => fileName, getCurrentLogIndex: () => (flightLog ? flightLog.getLogIndex() : null),
    };
    if (liveHook) hooks.getFlightLog = () => flightLog;
    if (extraHooks) Object.assign(hooks, extraHooks); // the hooks of js/main.js that a test gives (SPEC3 E: the filters of the lists)
    const dialog = new context.TuningDialog(jq.$('#viewTuning'), hooks);
    // the pilot's choice in "Logs" before the view shows: "This log" for the tests of one log; scope null: the default of the
    // view, "All flights in the file" (2026-10-06)
    if (scope) jq.fire('change', '.tuning-scope', {}, { value: scope });
    const html = (sel) => jq.node(sel).html;
    const pane = (key) => html(`.tuning-pane[data-pane="${key}"]`);
    const allHtml = () => [...jq.nodes.values()].map((n) => n.html).join('\n') + Object.values(elements).map((e) => e.parentNode.innerHTML).join('\n');
    // Native details toggle events do not bubble. Model the body insertion without replacing the parent pane,
    // including nested disclosures, so deferred tables are tested only after the user opens them.
    function detail(key, open = true) {
        const n = [...jq.nodes.values()].find(n => n.html.includes('data-tuning-detail-key="' + key + '"'));
        assert.ok(n, 'disclosure exists: ' + key);
        const keyAt = n.html.indexOf('data-tuning-detail-key="' + key + '"');
        const start = n.html.lastIndexOf('<details', keyAt), headEnd = n.html.indexOf('>', keyAt);
        const head = n.html.slice(start, headEnd + 1), id = /data-tuning-detail="([^"]+)"/.exec(head)[1];
        n.html = n.html.slice(0, start) + head.replace(/ open(?=>)/, '').replace(/>$/, open ? ' open>' : '>') + n.html.slice(headEnd + 1);
        const content = {};
        Object.defineProperty(content, 'innerHTML', { set(value) {
            const at = n.html.indexOf('data-tuning-detail="' + id + '"');
            if (at < 0) return;
            const body = n.html.indexOf('<div class="tuning-detail-body">', at) + '<div class="tuning-detail-body">'.length;
            const tags = /<details\b|<\/details>/g; tags.lastIndex = body;
            let depth = 1, match;
            while ((match = tags.exec(n.html))) {
                depth += match[0] === '</details>' ? -1 : 1;
                if (!depth) break;
            }
            assert.ok(match, 'matching disclosure end');
            n.html = n.html.slice(0, body) + value + n.html.slice(match.index - '</div>'.length);
        } });
        const el = { open, getAttribute: name => name === 'data-tuning-detail' ? id : null, querySelector: () => content };
        jq.node('#viewTuning').element.dispatchEvent({ type: 'toggle', target: el });
        return el;
    }
    return {
        context, jq, dialog, hooks, calls, workers, plots, destroyed, errors, saved, copied, offsets, elements, html, pane, allHtml, reads, snippet, later, detail,
        internals: context.TuningDialog.internals,
        get flightLog() { return flightLog; }, get bytes() { return bytes; }, setFile(b, name) { bytes = b; fileName = name; },
        // js/main.js loadLogFile, as for a file dropped on the window while the view is open: new bytes, name and
        // FlightLog, and no show()
        load(b, name, log) { bytes = b; fileName = name; flightLog = log; },
        show() { dialog.show(flightLog); },
        tab(key) { return jq.fire('click', '.tuning-tab', { 'data-tab': key }); },
        // the derive worker: the one whose first message is init
        deriveWorker() { return workers.find((w) => w.sent.length && w.sent[0].msg.cmd === 'init'); },
    };
}

// --- a synthetic TuningResult (docs/DEVELOPMENT.md section 13) with every curve family and the awkward shapes real findings have ----

function series(n, f) { return Float32Array.from({ length: n }, (_, i) => f(i)); }

function synthCurves(log) {
    const n = 3000, t = series(n, (i) => i * 0.1), m = 120, f = series(m, (i) => 0.5 * (i + 1)), mask = (p) => Uint8Array.from({ length: n }, (_, i) => +p(i));
    // the shapes of health_track.cjs and health_more.cjs curves()
    const track = {}, vib = { filtOnly: false, windows: 40, rotorHz: { 1: 38.3, 2: 41.7 }, notches: {}, byProfile: {}, lpf: [{ name: 'LPF1', hz: 150, type: 'PT1' }],
        dynNotch: { enabled: true, count: 2, q: 3, min: 80, max: 400 } };
    const dterm = {}, control = { windows: 40 };
    for (const a of ['roll', 'pitch', 'yaw']) {
        track[a] = {
            time: { t, sp: series(n, (i) => 40 + 20 * Math.sin(i / 50)), err: series(n, (i) => 8 + Math.sin(i / 7)), errComp: series(n, (i) => 5 + Math.sin(i / 9)),
                osc: series(n, (i) => (i % 400 < 20 ? 25 : 4)), stickDriven: mask((i) => i % 500 < 40), usable: mask((i) => i > 50 && i < 2900) },
            tauMs: 26, lpHz: 30, oscBand: [10, 20], oscGain: [0.47, 0.64],
            spectrum: { f, rr: series(m, () => 10), yy: series(m, () => 9), ee: series(m, () => 2), ratio: series(m, (i) => 0.2 + i / m), Tmag: series(m, (i) => 1 - i / (2 * m)),
                Tdeg: series(m, (i) => -9.4 * f[i]), coh: series(m, (i) => i < m / 2 ? 0.8 : 0.02), windows: 40, band: [10, 20] }, // upper half: SE of T > 20 %
            errVsSp: { edges: [0, 25, 50, 100, 150, 200, 300, 400, 600], meanAbsErr: [2, 3, 4, 6, 8, 11, 15, NaN], meanAbsErrComp: [1, 2, 3, 4, 6, 8, 10, NaN], n: [900, 700, 500, 300, 120, 60, 10, 0] },
        };
        const fv = series(500, (i) => i);
        vib[a] = { f: fv, raw: series(500, (i) => 1 + (i % 38 === 0 ? 30 : 0)), filt: series(500, (i) => 0.5 / (1 + i / 100)), pass: series(500, (i) => 1 / (1 + i / 150)) };
        vib.notches[a] = [{ code: 1, q: 8, order: 2, hz: 76.6, label: 'main rotor 2x <b>' }, { code: 21, q: 8, order: null, hz: null, label: 'tail rotor 1x' }];
        // per profile, over the windows wholly on it: P1 at 38.3 Hz, P2 at 41.7 Hz, each with its notches at its own headspeed
        for (const [p, hz, windows] of [[1, 38.3, 30], [2, 41.7, 8]]) {
            const q = vib.byProfile[p] = vib.byProfile[p] || { windows, share: windows / 40, rotorHz: hz, notches: {} };
            q.notches[a] = [{ code: 1, q: 8, order: 2, hz: 2 * hz, label: 'main rotor 2x <b>' }, { code: 21, q: 8, order: null, hz: null, label: 'tail rotor 1x' }];
            q[a] = { f: fv, raw: series(500, (i) => 1 + (i % Math.round(hz) === 0 ? 30 : 0)), filt: vib[a].filt, pass: vib[a].pass };
        }
        dterm[a] = { f: fv, psd: series(500, (i) => 1 / (1 + i)), share30: 0.24 };
        control[a] = { f: fv, psd: series(500, (i) => 2 / (1 + i)) };
    }
    const gov = { t, hs: series(n, (i) => 2300 + 10 * Math.sin(i / 30)), target: series(n, () => 2300), reference: 'govTarget',
        errPct: series(n, (i) => (i < 20 ? 150 : 0.4 * Math.sin(i / 30))),
        throttle: series(n, () => 52), coll: series(n, (i) => 300 * Math.sin(i / 80)),
        state: Uint8Array.from({ length: n }, (_, i) => (i < 100 ? 2 : i > 2950 ? 7 : 4)), profile: Uint8Array.from({ length: n }, (_, i) => (i < 2000 ? 1 : 2)) };
    const tail = { t, u: { min: series(n, () => -120), max: series(n, () => 80), mean: series(n, () => -20) }, err: series(n, () => 6), limits: { lo: -400, hi: 400 } };
    return [{ log, segment: 0, fromS: 0, seconds: 300, track, more: { gov, vib, dterm, control, tail } }];
}

// fids as js/tuning_worker.js gives them (module|id|log|segment|profile|axis|k)
const FID = { C12: 'track|C12|1|0|1|roll|0', C5: 'track|C5|1|0|1|roll|0', T8: 'loop|T8|1|0|1|null|0', F5: 'setup|F5|1|0|1|null|0', F1: 'setup|F1|1|0|null|null|0' };

// evidence.cjs Evidence: C12 from the curves, C5 from a raw span and the derive worker, F1 a header table
function synthEvidence() {
    return {
        C12: { v: 1, fid: FID.C12, id: 'C12', log: 1, profile: 1, axis: 'roll',
            spans: [{ log: 1, t0: 100.3, t1: 104.3, value: 0.4, label: 'Worst 4 s' }, { log: 1, t0: 150.1, t1: 154.1, value: 0.35, label: '' }],
            view: { log: 1, t0: 99.8, t1: 104.8, at: 102.3, graphs: [['setpoint[0]', 'gyroADC[0]'], ['axisError[0]']], analyser: null },
            plot: { kind: 'time', tab: 'curves', curve: 'track.roll.time', snippet: null, reference: [{ kind: 'hline', value: 12, label: 'Limit 12 deg/s' }, { kind: 'band', from: 10, to: 20, label: 'Band <b>' }],
                caption: 'The plot shows the setpoint and the error. The line at 12 deg/s is the limit of `axisError[0]` <b>.' },
            expected: 'The tracking error is less than 30 % of the setpoint.', summary: 'In PID profile 1 the roll tracking error is 31 ± 3 % of the setpoint.', context: [] },
        C5: { v: 1, fid: FID.C5, id: 'C5', log: 1, profile: 1, axis: 'roll',
            spans: [{ log: 1, t0: 44.7, t1: 45.8, value: 150, label: 'Oscillation 1' }, { log: 1, t0: 79.7, t1: 80.9, value: 120, label: 'Oscillation 2' }],
            view: { log: 1, t0: 44.2, t1: 46.3, at: 45, graphs: [['gyroADC[0]', 'setpoint[0]'], ['axisD[0]']], analyser: 'gyroRAW[0]' },
            plot: { kind: 'time', tab: 'curves', curve: null, snippet: { fields: ['gyroADC[0]', 'setpoint[0]', 'axisD[0]'], derive: { kind: 'bandpass', params: { lo: 10, hi: 20 } } },
                reference: [{ kind: 'hline', value: 30, label: '30 deg/s' }, { kind: 'hline', value: 150, label: '150 deg/s' }] },
            expected: 'The oscillation amplitude stays less than 30 deg/s.', summary: 'At 45.0 s a roll oscillation at 14 Hz increases from less than 30 to 150 deg/s.', context: [] },
        F1: { v: 1, fid: FID.F1, id: 'F1', log: 1, profile: null, axis: null, spans: [], view: null,
            plot: { kind: 'table', rows: [{ key: 'gyro_lpf1_type', value: 0 }, { key: 'gyro_lpf1_static_hz', value: HOSTILE }], reference: [], caption: 'The table shows the gyro low-pass filters of the log header.' },
            expected: 'One gyro low-pass filter is on.', summary: 'No gyro low-pass filter is on.', context: [] },
    };
}

function synthResult(over = {}) {
    const E = synthEvidence();
    const findings = [
        { module: 'setup', id: 'D1', node: 'logging', tuner: false, severity: 'flag', log: 1, profile: null, value: 250, se: null, n: 2764, threshold: 'nominal >= 1000 Hz', source: 'pipeline, unvalidated', text: 'logging 250 Hz', times: [] },
        { module: 'setup', id: 'D2', node: 'logging', tuner: false, severity: 'flag', log: 1, profile: null, value: 1, se: null, n: 76300, threshold: 'gaps <= 0', source: 'pipeline, unvalidated', text: '1 loop stall at 12.3 s', times: [12.34, 56.7, 60, 70.5], events: [{ t: 12.34, kind: 'time jump', value: 1000, unit: 'frames' }] }, // 1.3 % of the frames missing: a problem (catalog.cjs D2 statusOf)
        { module: 'more', id: 'MORE', severity: 'error', log: 1, text: 'judge failed: <b>boom</b>', times: [] },
        { module: 'gov', id: 'G3', node: 'governor', tuner: true, severity: 'note', log: [], profile: 0, value: null, se: null, n: 0, threshold: { minStep: 0.3, flag: 0.05, source: 'pipeline, unvalidated' }, source: 'pipeline, unvalidated', text: 'no finding: 0 collective rises', times: [] },
        { module: 'gov', id: 'G2', node: 'governor', tuner: true, severity: 'note', log: 1, profile: 3, value: -0.00074, se: 0.00046, n: 6027, threshold: { median: 0.01, band: 0.02 }, source: 'pipeline, unvalidated', text: 'headspeed error', times: [] },
        { module: 'gov', id: 'G12', node: 'rpm', tuner: false, severity: 'ok', log: 1, profile: null, value: 0.99868, se: 0.00003, n: 10, threshold: 0.005, source: 'pipeline, unvalidated', text: 'main rotor line', times: [] },
        { module: 'track', id: 'C12', severity: 'note', log: 1, profile: 1, axis: 'roll', value: 0.31, se: 0.03, n: 12, unit: 'fraction', threshold: 0.3, source: 'pipeline, unvalidated', text: 'tracking error', times: [100.2],
            fid: FID.C12, summary: E.C12.summary, evidence: E.C12, node: 'cyclic', tuner: true },
        { module: 'track', id: 'C13', node: 'cyclic', tuner: true, severity: 'note', log: 1, profile: 1, axis: 'roll', value: 26, se: 2, n: 12, unit: 'ms', threshold: 120, source: 'pipeline, unvalidated', text: 'lag', times: [] },
        { module: 'track', id: 'C5', severity: 'flag', log: 1, profile: 1, axis: 'roll', value: 2, se: null, n: 2, unit: 'bursts', threshold: 'any self-excited burst', source: 'wag_report.cjs RULES.onset', text: 'self-excited bursts', times: [45, 80],
            fid: FID.C5, summary: E.C5.summary, evidence: E.C5, node: 'cyclic', tuner: true },
        { module: 'loop', id: 'T8', severity: 'flag', log: 1, profile: 1, value: 0.54, se: null, n: 22, threshold: '>= 1 episode', source: 'firmware', text: '22 episodes at an output limit', times: [], fid: FID.T8, node: 'tailcomp', tuner: true },
        { module: 'setup', id: 'F5', severity: 'flag', log: 1, profile: 1, value: 4.061, se: null, n: 22, threshold: 'prominence >= 5', source: 'pipeline, unvalidated', text: '<script>alert(2)</script> line at 4.061 x rotor', times: [], filterPass: [{ hz: 155.7, roll: 0.002, pitch: 0.001, yaw: 0.004 }],
            fid: FID.F5, node: 'filters', tuner: true },
        { module: 'setup', id: 'H', node: 'logging', tuner: false, severity: 'note', log: 1, profile: 'global', value: 'Rotorflight <4.4>', se: null, n: null, threshold: null, source: 'log header', text: 'Firmware revision changed', times: [] },
        { module: 'setup', id: 'F8', node: 'filters', tuner: true, severity: 'ok', log: 1, profile: null, value: false, se: null, n: null, threshold: 'PID rate >= 1000 Hz', source: 'firmware', text: 'dynamic notch off', times: [] },
        { module: 'setup', id: 'D4', node: 'logging', tuner: false, severity: 'skipped', log: 1, profile: null, value: null, se: null, n: null, threshold: null, source: 'pipeline, unvalidated', text: 'the CLI dump has no profile section', times: [] }, // a CLI dump that the pilot loaded
        { module: 'track', id: 'R1', node: 'controller', tuner: false, severity: 'note', log: 1, profile: 1, axis: 'yaw', value: 35, se: 4, n: 9, unit: 'ms', threshold: 40, source: 'pipeline, unvalidated', text: 'stick to setpoint lag', times: [] },
        { module: 'setup', id: 'F1', severity: 'flag', log: 1, profile: null, value: 0, se: null, n: null, threshold: 'one gyro LPF', source: 'doc RPMF', text: 'no gyro LPF', times: [],
            fid: FID.F1, summary: E.F1.summary, evidence: E.F1, node: 'filters', tuner: true },
    ];
    const recommendations = [
        { id: 'F5:check:p1', area: 'filters', order: 2, severity: 'check', title: 'Examine the notch filter for the line at 4.06×', parameter: null, scope: null, cliProfile: null, node: 'filters',
            from: null, to: null, direction: 'check', cli: [], evidence: [Object.assign({}, findings[10])], rule: 'Check F5: a prominence of 5 or more.', confidence: 'advisory', blockedBy: [], caveats: ['The line is near the tail rotor notch filter.'] },
        { id: 'T7:yaw_collective_ff_gain:p1', area: 'tail', order: 10, severity: 'action', title: 'Increase the yaw collective precompensation <b>!</b>', node: 'tailcomp',
            parameter: 'yaw_collective_ff_gain', scope: 'profile', cliProfile: 0, profile: 1, from: 60, to: 72, direction: 'raise', cli: ['profile 0', 'set yaw_collective_ff_gain = 72'],
            evidence: [{ module: 'loop', id: 'T7', log: 1, profile: 1, axis: null, value: 0.62, se: 0.05, n: 12, unit: 'r', threshold: '|r| >= 0.5', source: 'pipeline, unvalidated', text: 'I follows the precomp', times: [33.3] }],
            rule: 'Check T7: r is 0.5 or more, with a 2 SE test. The step is 20 % or less.', confidence: 'measured', blockedBy: [], caveats: [] },
        { id: 'C7:pitch_f_gain:p1', area: 'cyclic', order: 20, severity: 'action', title: 'Decrease the pitch F gain', parameter: 'pitch_f_gain', scope: 'profile', cliProfile: 0, profile: 1, from: 100, to: 80, node: 'cyclic',
            direction: 'lower', cli: ['profile 0', 'set pitch_f_gain = 80'], evidence: [], rule: 'The rules 6 to 8 of report.cjs.', confidence: 'predicted', blockedBy: [], caveats: [] },
        // a blocked action keeps its severity and gets no CLI (advice.cjs guard and finish); blockedBy names the gate node
        { id: 'C7:roll_p_gain:p1', area: 'cyclic', order: 21, severity: 'action', title: 'Increase the roll P gain', parameter: 'roll_p_gain', scope: 'profile', cliProfile: 0, profile: 1, from: 50, to: 60, node: 'cyclic',
            direction: 'raise', cli: [], evidence: [{ fid: FID.C5, id: 'C5', log: 1, profile: 1, axis: 'roll', value: 2, unit: 'bursts', text: 'self-excited bursts' }], rule: '', confidence: 'predicted',
            blockedBy: ['filters', 'Correct the filters first (check F5).'], caveats: [] },
        { id: 'G9:gov_i_gain', area: 'governor', order: 5, severity: 'watch', title: 'Monitor the governor I-term oscillation', parameter: 'gov_i_gain', scope: 'global', cliProfile: null,
            from: 50, to: null, direction: 'check', cli: [], evidence: [], rule: 'Check G9: a prominence of 5, with a 2 SE test.', confidence: 'measured', blockedBy: [], caveats: [] },
        { id: 'T13:p0', area: 'tail', order: 11, severity: 'check', title: 'Examine the tail center trim\nof PID profile 1', parameter: 'yaw_center_offset', scope: 'profile', cliProfile: null, from: null, to: null,
            direction: 'check', cli: [], evidence: [], rule: 'Check T13.', confidence: 'measured', blockedBy: [], caveats: ['Make sure that the PID profile is correct.'] },
        { id: 'R1:info', area: 'rates', order: 30, severity: 'info', title: 'Time delay from the stick to the setpoint: 35 ms', parameter: null, scope: null, cliProfile: null, from: null, to: null,
            direction: null, cli: [], evidence: [findings[14]], rule: 'Check R1 gives information only.', confidence: 'measured', blockedBy: [], caveats: [] },
        // a possible result of the C5 burst (K5): no CLI until the cause is corrected
        { id: 'C12:roll:p1', area: 'cyclic', order: 31, severity: 'check', title: 'Examine the roll tracking error', parameter: null, scope: null, cliProfile: null, from: null, to: null, node: 'cyclic',
            direction: 'check', cli: [], evidence: [{ fid: FID.C12, id: 'C12', log: 1, profile: 1, axis: 'roll', value: 0.31, se: 0.03 }], rule: 'Check C12: 30 %.', confidence: 'measured', blockedBy: [], caveats: [],
            causes: [{ rule: 'K5', name: 'Tracking error', fids: [FID.C5], first: ['Correct C5 first.', 'Then fly again.'] }] },
        { id: 'C5:roll:p1', area: 'cyclic', order: 22, severity: 'check', title: 'Examine the roll oscillation', parameter: null, scope: null, cliProfile: null, from: null, to: null, node: 'cyclic',
            direction: 'check', cli: [], evidence: [{ fid: FID.C5, id: 'C5', log: 1, profile: 1, axis: 'roll', value: 2 }], rule: 'Check C5: one oscillation.', confidence: 'measured', blockedBy: [], caveats: [] },
    ];
    // advice.cjs rows name their parameter group; the first has none, as advice.cjs coverage rows
    const coverage = ['finding', 'checked', 'not-assessable', 'not-in-log', 'needs-fields', 'needs-flights', 'no-check'].map((status, i) => Object.assign({
        area: 'Area ' + i, parameters: ['roll_p_gain', 'pitch_p_gain'], checks: ['C5', 'C7'], status, detail: 'The data of this group <svg>.' }, i ? { group: 'Group ' + i } : {}));
    return Object.assign({
        version: 1, scope: 'log', fileName: '<i>flight</i>.bbl', logIndex: 1, flightRpm: { value: 2000, source: 'govTarget', basis: 2353 }, cli: null,
        timing: { decodeS: 1, analyseS: 2, judgeS: 0.1, gainsS: 0, totalS: 3.4 },
        records: [{ log: 1, segment: 0, start: '2026-10-04T18:00:07Z', durationS: 300, fromS: 0, seconds: 300, flown: true, flyingS: 250, rate: 1000, actualRate: 1001.74,
            bodyRate: 70, profileSeconds: { 1: 200, 2: 50 }, targetOf: { 1: 2300, 2: 2500 }, govStateLogged: true, excluded: { rescueS: 10.6, groundS: 4 }, normalS: 235.4, skipped: null, errors: {} }],
        header: { 'Craft name': HOSTILE, 'Firmware revision': 'Rotorflight 4.6.0 (118e912) STM32F7X2', looptime: 125 },
        fields: { 'gyroRAW[0]': 'present', headspeed: 'present', 'axisD[0]': 'present' },
        findings,
        decisions: [
            { axis: 'pitch', bin: 4250, flights: 16, windows: 1313, change: true, tracking: [3.42962, 1.68168], dTrack: 1.74794, seTrack: 0.640823,
                changes: [{ gain: 'F', multiplier: 0.8, from: 99.9969, to: 79.9975, improves: 'tracking', dTrack: 1.74794, seTrack: 0.640823 }] },
            { axis: 'roll', bin: 3500, flights: 11, windows: 445, change: false, reason: 'the best remaining change (I ×1.2) fails the rule' },
        ],
        groups: null,
        advice: { recommendations, coverage, notes: ['This is a note of the recommendations <iframe>.'], script: advice.script(recommendations) }, // as js/tuning_worker.js adviseAll
        hierarchy: synthHierarchy(),
        curves: synthCurves(1),
        reportMarkdown: '# Health report\n\nThe toolkit report.',
        notes: ['This is a note of the analysis <iframe>.'],
    }, over);
}

// hierarchy.cjs graph (SPEC3 K1, a part of it) and status() for the findings above: the items before the first flight
// (prereq) and the tuning steps (blocks, parameters only)
function synthGraph() {
    const doc = (title, page) => ({ title, url: `https://rotorflight.org/docs/${page}` });
    const prereq = [
        { id: 'logging', title: 'Blackbox log', about: 'The log rate and the fields that the checks use.', checks: ['D1', 'D2', 'D3', 'D4', 'H'], params: ['blackbox_rate_denom'],
            gates: ['filters', 'cyclic', 'tail', 'nowhere'], docs: [doc('Blackbox tab', 'configurator/tabs/blackbox'), { title: 'Bad link', url: 'javascript:alert(1)' }] },
        { id: 'rpm', title: 'RPM signal and motor poles', checks: ['G1', 'G12'], params: ['motor_poles'], gates: ['filters', 'governor'] },
        { id: 'power', title: 'Power', checks: ['D5', 'G13', 'G11'], params: [], gates: [] },
        { id: 'mechanics', title: 'Mechanical parts', checks: ['F7', 'C15', 'T4'], params: [], gates: [] },
        { id: 'rescue', title: 'Rescue', checks: ['D9', 'D8', 'D6'], params: ['rescue_mode'], gates: [] },
        { id: 'controller', title: 'Flight controller', checks: ['SETUP:pid_mode', 'D7', 'R1'], params: ['pid_process_denom'], gates: [] },
    ];
    const blocks = [
        { id: 'filters', title: 'Filters', about: 'The gyro filters and the D-term cutoffs.', lane: 'main', order: 1,
            params: ['gyro_lpf1_type', 'gyro_lpf1_static_hz', 'gyro_rpm_notch_preset', 'gyro_rpm_notch_q_roll', 'gyro_rpm_notch_q_pitch', 'gyro_rpm_notch_q_yaw', 'dyn_notch_count', 'dyn_notch_q', 'roll_d_cutoff', 'pitch_d_cutoff'],
            checks: ['F1', 'F2', 'F3', 'F5', 'F6', 'F8', 'F9', 'F10', 'F11', 'F4', 'C11'], docs: [doc('RPM filters', 'setup/rpm-filters')] },
        { id: 'governor', title: 'Governor', lane: 'main', order: 2, params: ['gov_mode', 'gov_headspeed', 'gov_p_gain'], checks: ['G0', 'G2', 'G3', 'G6'], docs: [] },
        { id: 'cyclic', title: 'Cyclic gains', lane: 'cyclic', order: 3, params: ['{pitch,roll}_{d,p,i,f,o,b}_gain'], checks: ['C1', 'C5', 'C7:cyclic', 'C12', 'C13'],
            docs: [doc('Tuning your helicopter <b>', 'Tuning/Tuning-description')] },
        { id: 'cycomp', title: 'Cyclic compensation', lane: 'cyclic', order: 4, params: ['pitch_collective_ff_gain', 'cyclic_cross_coupling_gain'], checks: ['C8', 'C14'], docs: [] },
        { id: 'tail', title: 'Tail gains', lane: 'tail', order: 3, params: ['yaw_d_gain', 'yaw_p_gain', 'yaw_i_gain', 'yaw_f_gain', 'yaw_b_gain'], checks: ['T1', 'T2', 'T9'], docs: [] },
        { id: 'tailcomp', title: 'Tail compensation and output range', lane: 'tail', order: 4, params: ['yaw_collective_ff_gain', 'yaw_cw_stop_gain', 'gov_tta_gain'],
            checks: ['T5', 'T6', 'T7', 'T8', 'T13', 'T14'], docs: [] },
    ];
    const gate = (from, to) => ({ from, to, kind: 'gate', text: 'Correct this first.', source: 'DOC' });
    const order = (from, to) => ({ from, to, kind: 'order', text: 'Do this step first.', source: 'DOC' });
    const edges = [gate('logging', 'filters'), gate('rpm', 'filters'), gate('rpm', 'governor'), order('filters', 'governor'), gate('filters', 'cyclic'), gate('filters', 'tail'),
        order('governor', 'cyclic'), order('governor', 'tail'), order('cyclic', 'cycomp'), order('tail', 'tailcomp'),
        { from: 'cyclic', to: 'tail', kind: 'cause', text: 'The cyclic gains change the tail load.', source: 'INF' },
        { from: 'logging', to: 'filters', kind: 'validity', when: ['D1'], text: 'Record the log at 1 kHz.', source: 'INF' },
        { from: 'nowhere', to: 'cyclic', kind: 'gate', text: 'The view does not show a line from a step that is not known.', source: '' }];
    const rules = [{ id: 'K5', name: 'Tracking error', symptoms: ['C12', 'T11'], upstream: ['C5'], first: ['Correct C2 and T8 first.', 'Then C5.'], source: ['TUNE'], confidence: 'INF' }];
    return { prereq, blocks, edges, rules };
}

function synthHierarchy() {
    return {
        nodes: {
            logging: { status: 'problem', fids: [], reason: 'The log rate is less than 1 kHz <b>.' },
            rpm: { status: 'ok', fids: [] },
            power: { status: 'noData', fids: [], reason: 'The log does not contain the battery voltage.' },
            mechanics: { status: 'ok', fids: [] },
            rescue: { status: 'noData', fids: [] },
            controller: { status: 'ok', fids: [] },
            filters: { status: 'problem', fids: [FID.F5, FID.F1], reason: 'Check F5 shows a line without a notch filter <b>.' },
            governor: { status: 'notApplicable', fids: [], reason: 'The governor mode is DIRECT.' },
            cyclic: { status: 'blocked', fids: [FID.C5, FID.C12], blockedBy: ['filters', 'logging'], recs: ['C7:pitch_f_gain:p1'] },
            cycomp: { status: 'notMeasured', fids: [] },
            tail: { status: 'possible', fids: [], possible: [{ rule: 'K5', name: 'Tracking error', fids: [FID.C5], from: ['cyclic'] }, { rule: 'cause', from: ['cyclic'], fids: [FID.C5], ids: [] }] },
            tailcomp: { status: 'problem', fids: [FID.T8], reason: 'Check T8 shows a problem.' },
        },
        startHere: ['filters', 'tailcomp'],
        prereqProblems: ['logging'],
        graph: synthGraph(),
    };
}

// Shows the view (which starts a log-scope analysis) and answers with the result
function analysed(opts = {}) {
    const app = setup(opts);
    app.show();
    app.result = opts.result || synthResult();
    app.workers[0].reply({ type: 'result', result: app.result });
    return app;
}

function noRawMarkup(app) {
    const all = app.allHtml().replace(/<svg class="tuning-order-svg"[\s\S]*?<\/svg>/g, (svg) => svg.replace(/<\/?(svg|defs|marker|pattern|path|rect|line|text|tspan|g|circle|title)\b/g, '<ok'));
    for (const bad of ['<img', '<script', '<iframe', '<svg', '<b>', '<i>']) assert.ok(!all.includes(bad), `raw ${bad} in the view HTML`);
}

// --- tests ----------------------------------------------------------------------------------------------------

test('opening on a log slices that log on the main thread and posts analyseLog with the slice transferred', () => {
    const app = setup();
    app.show();
    assert.deepEqual(app.jq.modal, [], 'a view at the level of the log viewer, not a Bootstrap modal');
    assert.equal(app.workers.length, 1);
    assert.equal(app.workers[0].url, 'js/tuning_worker.js');
    const { msg, transfer } = app.workers[0].sent[0];
    assert.equal(msg.cmd, 'analyseLog');
    assert.equal(msg.logIndex, 1);
    assert.equal(msg.logCount, 3);
    assert.equal(msg.fileName, '<i>flight</i>.bbl');
    assert.ok(msg.bytes instanceof ArrayBuffer);
    assert.equal(msg.bytes.byteLength, app.offsets[2] - app.offsets[1]);
    assert.deepEqual(new Uint8Array(msg.bytes), app.bytes.slice(100, 250));
    assert.equal(transfer.length, 1);
    assert.equal(transfer[0], msg.bytes);
    assert.equal(app.bytes.length, 400, 'the viewer\'s buffer is copied, never transferred');
    assert.deepEqual(plain(msg.options), { flightRpm: null, cliText: null, cliName: null, excludeAbnormal: true, curves: true });
    assert.equal(app.jq.node('.tuning-cancel').props.disabled, false);
    assert.equal(app.jq.node('.tuning-analyse').props.disabled, false, 'V9: "Start analysis" works while the automatic run operates');

    app.workers[0].reply({ type: 'progress', stage: 'decode', fraction: 0.35, text: 'The app reads log 2 of 3 <b>.' });
    assert.match(app.jq.node('.tuning-progress-text').text, /^The app reads log 2 of 3 <b>\. \(35 %\) · 0:00$/, 'the worker text, as text');
    assert.equal(app.jq.node('.tuning-progress-bar').css.width, '35.0%');
    assert.equal(app.jq.node('.tuning-progress').attrs.class, 'tuning-progress is-running');
    app.workers[0].reply({ type: 'progress', stage: 'analyse', text: 'The app loads the toolkit.' });
    assert.equal(app.jq.node('.tuning-progress').attrs.class, 'tuning-progress is-busy');
});

test('a result renders every tab, plots and tables, with log-derived text escaped', () => {
    const app = analysed();
    assert.equal(app.workers[0].terminated, true, 'the worker is released after the result');
    const expect = { overview: 0, cyclic: 1, cycomp: 1, tailcomp: 1, recs: 0, export: 0, curves: 5, governor: 1, filters: 0, tail: 1, checks: 0, configs: 0, coverage: 0 };
    for (const t of app.internals.TABS) {
        const before = app.plots.length;
        assert.equal(app.tab(t.key).count, 1);
        assert.ok(app.pane(t.key).length > 100, `${t.key} renders`);
        assert.ok(!app.pane(t.key).includes('because of an error'), `${t.key} draws without an error`);
        assert.equal(app.plots.length - before, expect[t.key], `${t.key} attaches ${expect[t.key]} plots`);
    }
    for (const a of ['pitch', 'yaw']) {
        app.tab('curves');
        app.jq.fire('click', '.tuning-axis', { 'data-axis': a });
        assert.match(app.pane('curves'), new RegExp('Checks: ' + a + ', log 2'));
    }
    assert.deepEqual(app.errors, []);
    noRawMarkup(app);
    assert.equal(app.jq.modal.length, 0, 'no modal calls');
    assert.ok(app.html('.tuning-context').includes(HOSTILE_ESCAPED), 'craft name escaped in the context bar');
    assert.ok(app.pane('checks').includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
    assert.ok(app.pane('coverage').includes('The data of this group &lt;svg&gt;.'));
    assert.match(app.pane('coverage'), /<span class="tuning-badge st-insufficient">No check in the app<\/span>/, 'advice.cjs no-check rows');
    assert.match(app.pane('coverage'), /For the groups with the condition "No check in the app", the app has no check that operates on a log\./);
    assert.match(app.html('.tuning-context'), /<div>Not in the analysis: rescue 10\.6 s, on the ground 4\.0 s<\/div><div>Flight in the analysis: 3\.9 min<\/div>/, 'records[].normalS beside the exclusions');
    assert.match(app.html('.tuning-context'), /<div>Log 2 of 3<\/div>/);
    assert.match(app.html('.tuning-context'), /<div>PID profile 1: 2300 rpm, 3\.3 min · PID profile 2: 2500 rpm, 50\.0 s<\/div>/);
    assert.match(app.html('.tuning-context'), /^<div><strong><span data-ste="quoted">&lt;img/, 'the craft name is log-derived text');
    assert.match(app.pane('checks'), /The log numbers start at 1, as in the log list of the log viewer\./);
    assert.match(app.pane('checks'), /Measured filter transmission, gyroRAW to gyroADC:<ul><li>155\.7 Hz: roll 0\.2 %, pitch 0\.1 %, yaw 0\.4 %\.<\/li><\/ul>/, 'F5 shows what the filters pass of its line, one item for each line');

    const o = app.pane('overview');
    assert.match(o, /Log 2 of 3: 16 results, 9 recommendations\. 2 changes to do, 1 change that must wait\./, 'a blocked change is not one to do now');
    assert.match(o, /Analysis error 1 · Problem 6 · Monitor 2 · Satisfactory 2 · Information 3 · Not sufficient data 1 · Not measured 1/);
    assert.doesNotMatch(o, /<h5[^>]*>(Areas|Before you tune|Start here|First recommendations)<\/h5>/, 'the overview has no duplicate summaries');
    assert.doesNotMatch(o, /class="tuning-(cards|start-list|top-recs)"/);
    assert.match(o, /class="tuning-tab-link" data-tab="checks"/, 'all checks remain accessible');
    assert.match(o, /class="tuning-tab-link" data-tab="recs"/, 'all recommendations remain accessible');
    assert.match(o, /<div class="tuning-muted">Flight rpm 2000 \(85 % of the lowest governor target: 2353 rpm\) · Analysis time 3\.4 s<\/div>/, 'no CLI dump: no word about it');
    assert.ok(!/CLI dump/.test(o), 'the overview names the CLI dump only when the pilot loaded one');
    assert.match(o, /Analysis error in 1 check\./);
    const recs = app.pane('recs');
    assert.match(recs, /<strong>WARNING:<\/strong> Examine each change before you set it in the flight controller\. After each change, do a hover test in a safe area\./);
    assert.match(recs, /<strong>NOTE:<\/strong> This app does not send data to the flight controller\./);
    assert.match(recs, /Yaw collective feedforward gain<\/span> \(PID profile 1\): 60 to 72 \(increase\)/);
    assert.match(recs, /Yaw center offset<\/span> \(PID profile unknown\): examine/);
    assert.match(recs, /0\.620&nbsp;±&nbsp;0\.050 r/, 'evidence value ± SE with unit, kept on one line');
    assert.match(recs, /tuning-rec st-blocked"[^>]*><div class="tuning-rec-head"><div class="tuning-rec-badges"><span class="tuning-badge st-monitor">Change<\/span> <span class="tuning-badge st-blocked">Blocked<\/span><\/div><div class="tuning-rec-title">Increase the roll P gain</);
    assert.match(recs, /Blocked<\/div><ul><li><a href="#" class="tuning-node-link" data-node="filters">Filters<\/a><\/li><li>Correct the filters first \(check F5\)\.<\/li>/);
    assert.match(recs, /F ×0\.8 \(100 to 80\)\. Tracking error 3\.43 to 1\.682 deg\/s\. Decrease 1\.75 ± 0\.64 deg\/s \(2\.7 SE\)\./);
    assert.match(recs, /No change\. <span data-ste="quoted">the best remaining change \(I ×1\.2\) fails the rule<\/span>/, 'the toolkit reason is quoted text');
    // SPEC3 E: by default the list does not show the results with not sufficient data and the satisfactory ones
    assert.match(app.pane('checks'), /12 of 16 results\./, 'errors, problems and notes, without the note with not sufficient data');
    assert.match(app.pane('checks'), /Show results with not sufficient data \(1\)<\/label>.*Show satisfactory results \(2\)<\/label><span class="tuning-muted tuning-rf-hidden">The list does not show 3 results\.<\/span>/);
    assert.match(app.pane('checks'), /-0\.00074&nbsp;±&nbsp;0\.00046/);
    assert.doesNotMatch(app.pane('governor'), /0\.998680&nbsp;±&nbsp;0\.000030/, 'SPEC3 E: a satisfactory result only with "Show satisfactory results"');
    app.detail('governor:checks');
    assert.match(app.pane('governor'), /Show satisfactory results \(\d+\)<\/label><span class="tuning-muted tuning-rf-hidden">The list does not show \d+ results?\.<\/span>/);
    showAllResults(app);
    app.tab('governor');
    assert.match(app.pane('governor'), /0\.998680&nbsp;±&nbsp;0\.000030/, 'the governor tab lists every governor check, ok ones too');
});

test('All checks: the STE summary first, the toolkit text collapsed and quoted, the links to the log', () => {
    const app = analysed();
    app.tab('checks');
    showAllResults(app); // SPEC3 E: the two filters on, so that the list has each result
    const c = app.pane('checks');
    assert.match(c, /<td class="tuning-text"><div class="tuning-summary-text">In PID profile 1 the roll tracking error is 31 ± 3 % of the setpoint\.<\/div><details class="tuning-toolkit" data-ste="quoted"><summary>Toolkit text \(not STE\)<\/summary>tracking error<\/details><\/td>/);
    assert.match(c, /<div class="tuning-summary-text">Check D2: Problem\.<\/div>[\s\S]*?Toolkit text \(not STE\)<\/summary>1 loop stall at 12\.3 s<\/details>/, 'a finding without a catalog summary: a label from its status');
    assert.match(c, /<a href="#" class="tuning-show" data-key="track\|C12\|1\|0\|1\|roll\|0" title="Show this part of the log">Show in the log<\/a>/);
    assert.match(c, /<a href="#" class="tuning-compare-open" data-key="track\|C12\|1\|0\|1\|roll\|0" data-where="checks" [^>]*>Show the measurement<\/a>/);
    assert.match(c, /<a href="#" class="tuning-span" data-key="track\|C5\|1\|0\|1\|roll\|0" data-span="1" [^>]*>79\.7 s<\/a>/, 'the parts of the log of a finding');
    assert.match(c, /<td class="tuning-rule"><span data-ste="quoted">nominal &gt;= 1000 Hz<\/span><div class="tuning-muted" data-ste="quoted">pipeline, unvalidated<\/div><\/td>/, 'thresholds and sources are toolkit text');
    assert.match(c, /class="tuning-seek" data-log="1" data-t="12\.34" data-id="D2" data-axis=""/, 'a finding without evidence keeps its time links');
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    const all = app.html('.tuning-checks-table');
    assert.match(all, /<span class="tuning-badge st-notmeasured">Not measured<\/span>/, 'skipped: Not measured (SPEC2 D9)');
    assert.match(all, /<span class="tuning-badge st-insufficient">Not sufficient data<\/span>/, 'a "no finding" note: Not sufficient data');
    const thin = analysed({ result: synthResult({ findings: [{ module: 'track', id: 'C12', severity: 'note', thin: true, log: 1, text: 'The check has no result.' }] }) });
    thin.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    assert.doesNotMatch(thin.html('.tuning-checks-table'), /st-insufficient">Not sufficient data/, 'SPEC3 E: not shown by default');
    assert.match(thin.html('.tuning-checks-table'), /The list does not show 1 result\./);
    thin.jq.fire('change', '.tuning-rf', { 'data-rf': 'thin' }, { checked: true });
    thin.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    assert.match(thin.html('.tuning-checks-table'), /st-insufficient">Not sufficient data/, 'our modules mark it with thin (SPEC2 D5)');
});

// The boxes of the flow (SPEC3 B): [id, class status, selected] in the order of the HTML
const blocksOf = (o) => [...o.matchAll(/<div class="tuning-node tuning-block st-(\w+)( is-selected)?" data-node="(\w+)"/g)].map((m) => [m[3], m[1], !!m[2]]);
const prereqsOf = (o) => [...o.matchAll(/<li class="tuning-node tuning-prereq-item st-(\w+)( is-selected)?" data-node="(\w+)"/g)].map((m) => [m[3], m[1], !!m[2]]);
const panelOf = (o) => /<aside class="tuning-order-panel" id="[^"]*-panel">([\s\S]*?)<\/aside>/.exec(o)[1];

test('SPEC3 A: the checklist before the first flight is a band above the steps: "No problem found" with the checks that ran, "No data", a problem with its checks and the steps that wait', () => {
    const app = analysed();
    const o = app.pane('overview');
    assert.ok(o.indexOf('<section class="tuning-prereq"') < o.indexOf('<div class="tuning-flow"'), 'the band is above the flow');
    assert.match(o, /<h5 class="tuning-h">Before the first flight<\/h5><p class="tuning-muted">The log shows only problems that the analysis can measure\. Before the first flight, correct all items with a problem\.<\/p>/);
    assert.deepEqual(prereqsOf(o), [['logging', 'problem', false], ['rpm', 'ok', false], ['power', 'nodata', false], ['mechanics', 'ok', false], ['rescue', 'nodata', false], ['controller', 'ok', false]]);
    assert.match(o, /data-node="logging" tabindex="0" role="button" aria-label="Blackbox log: Problem"><div class="tuning-prereq-top"><span class="tuning-badge st-problem">Problem<\/span> <span class="tuning-prereq-title">Blackbox log<\/span><\/div><ul class="tuning-prereq-problems"><li><span class="tuning-block-check">D1<\/span><\/li><li><span class="tuning-block-check">D2<\/span><\/li><\/ul>/,
        'a problem: its checks with the problem');
    assert.match(o, /Checks that operated: D1, D2, H\.<\/div><div class="tuning-prereq-gates">This item is necessary for these steps: Filters, Cyclic gains, Tail gains\.<\/div>/, 'the checks that ran, and the steps that need the item (known steps only)');
    assert.match(o, /aria-label="RPM signal and motor poles: No problem found"><div class="tuning-prereq-top"><span class="tuning-badge st-ok">No problem found<\/span> <span class="tuning-prereq-title">RPM signal and motor poles<\/span><\/div><div class="tuning-muted tuning-prereq-checks">Checks that operated: G12\.<\/div><\/li>/);
    assert.match(o, /aria-label="Power: No data"><div class="tuning-prereq-top"><span class="tuning-badge st-nodata">No data<\/span> <span class="tuning-prereq-title">Power<\/span><\/div><div class="tuning-muted tuning-prereq-checks">The log does not contain the battery voltage\.<\/div><\/li>/, 'No data: the reason');
    assert.match(o, /aria-label="Rescue: No data">[^]*?The log cannot show this item\.<\/div><\/li>/, 'No data without a reason');
    assert.ok(!/tuning-prereq-item[^>]*>[^]*?Start here[^]*?<\/li>/.test(o.slice(o.indexOf('tuning-prereq-list'), o.indexOf('</ul></section>'))), 'never "Start here" for an item');
    // the side panel of an item: its condition, the steps that wait, its checks, its parameters and pages
    app.jq.fire('click', '.tuning-node', { 'data-node': 'logging' });
    const panel = panelOf(app.pane('overview'));
    assert.match(panel, /^<div class="tuning-node-head"><div class="tuning-muted">Before the first flight<\/div><h5 class="tuning-node-title-text">Blackbox log<\/h5><span class="tuning-badge st-problem">Problem<\/span><\/div><p class="tuning-node-about">The log rate and the fields that the checks use\.<\/p><p class="tuning-node-reason">The log rate is less than 1 kHz &lt;b&gt;\.<\/p>/);
    assert.match(panel, /<div class="tuning-panel-block is-blocked"><div class="tuning-label">This item is necessary for these steps<\/div><div><a href="#" class="tuning-node-link" data-node="filters">Filters<\/a>, <a href="#" class="tuning-node-link" data-node="cyclic">Cyclic gains<\/a>, <a href="#" class="tuning-node-link" data-node="tail">Tail gains<\/a><\/div><\/div>/);
    assert.match(panel, /<strong>D1 · All PID profiles · log 2<\/strong>/, 'the problem checks of the item');
    assert.match(panel, /<span class="tuning-badge st-notmeasured">Not measured<\/span> <strong>D4 · All PID profiles · log 2<\/strong>/, 'D4 skipped: Not measured');
    assert.match(panel, /These checks have no result: D3\./);
    assert.match(panel, /<div class="tuning-label">Parameters<\/div><span class="tuning-param" title="blackbox_rate_denom">Log rate<\/span><\/div>$/);
    assert.ok(!panel.includes('javascript:'), 'only https links');
    app.jq.fire('click', '.tuning-node', { 'data-node': 'rpm' });
    const p2 = panelOf(app.pane('overview'));
    assert.match(p2, /<span class="tuning-badge st-ok">No problem found<\/span>/);
    assert.match(p2, /<div class="tuning-panel-block"><div class="tuning-label">This item is necessary for these steps<\/div><div><a [^>]*data-node="filters">Filters<\/a>, <a [^>]*data-node="governor">Governor<\/a><\/div><\/div>/);
    noRawMarkup(app);
    assert.deepEqual(app.errors, []);
});

test('SPEC3 B: the tuning steps are parameters only: Filters, Governor, then the cyclic and tail lanes, each with readable parameter labels, its checks with their conditions and "Start here"', () => {
    const app = analysed();
    const o = app.pane('overview'), I = app.internals, g = I.graphOf(app.result);
    assert.deepEqual(blocksOf(o), [['filters', 'start', true], ['governor', 'notapplicable', false], ['cyclic', 'blocked', false], ['tail', 'possible', false],
        ['cycomp', 'notmeasured', false], ['tailcomp', 'start', false]], 'each step once, the first "Start here" step selected');
    assert.deepEqual(plain(g.blocks.map((b) => I.stepNo(b))), ['1', '2', '3a', '4a', '3b', '4b']);
    assert.deepEqual(plain(g.columns.map((c) => [c.order, c.main.map((b) => b.id), c.cyclic.map((b) => b.id), c.tail.map((b) => b.id)])),
        [[1, ['filters'], [], []], [2, ['governor'], [], []], [3, [], ['cyclic'], ['tail']], [4, [], ['cycomp'], ['tailcomp']]]);
    // the grid: a column for each order and an arrow column between; the main lane takes the two rows, cyclic row 1, tail row 2
    assert.match(o, /<div class="tuning-flow" role="group" aria-label="Tuning steps" style="grid-template-columns: minmax\(calc\(200 \* var\(--rf-px\)\), 1fr\) calc\(26 \* var\(--rf-px\)\) minmax/);
    const cells = [...o.matchAll(/<div class="tuning-flow-(cell|arrow)" style="grid-column: (\d+); grid-row: ([^"]+)"/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
    assert.deepEqual(cells, ['cell 1 1 / span 2', 'arrow 2 1 / span 2', 'cell 3 1 / span 2', 'arrow 4 1', 'arrow 4 2', 'cell 5 1', 'cell 5 2', 'arrow 6 1', 'arrow 6 2', 'cell 7 1', 'cell 7 2']);
    // a step: number, title, "Start here" number, condition with the checks that have a problem, parameters, checks
    assert.match(o, /data-node="filters" tabindex="0" role="button" aria-label="Step 1, Filters: Start here 1"><div class="tuning-block-head"><span class="tuning-block-no">1<\/span><span class="tuning-block-title">Filters<\/span><span class="tuning-start-badge" title="Start here">1<\/span><\/div><div class="tuning-block-status"><span class="tuning-badge st-start">Start here 1<\/span> <span class="tuning-block-ids">F5, F1<\/span><\/div>/);
    assert.match(o, /data-node="filters"[^]*?<div class="tuning-label">Parameters<\/div><div class="tuning-block-params"><span class="tuning-param" title="gyro_lpf1_type">Gyro low-pass filter 1 type<\/span> <span class="tuning-param" title="gyro_lpf1_static_hz">Gyro low-pass filter 1 constant frequency<\/span> [^]*?<span class="tuning-param" title="dyn_notch_q">Dynamic notch filter Q<\/span> <span class="tuning-muted tuning-block-more">2 more parameters<\/span><\/div>/,
        '8 parameter labels in the box, the others in the side panel');
    assert.match(o, /data-node="filters"[^]*?<div class="tuning-label">Checks<\/div><ul class="tuning-block-checks"><li class="st-problem" title="Problem"><span class="tuning-dot st-problem"><\/span><span class="tuning-block-check">F1<\/span> <span class="tuning-block-check-st">Problem<\/span><\/li><li class="st-problem" title="Problem"><span class="tuning-dot st-problem"><\/span><span class="tuning-block-check">F5<\/span> <span class="tuning-block-check-st">Problem<\/span><\/li><\/ul><div class="tuning-block-group st-satisfactory"><span class="tuning-dot st-satisfactory"><\/span>Satisfactory: <span class="tuning-block-check">F8<\/span><\/div><div class="tuning-muted tuning-block-none">No result: F2, F3, F6, F9, F10, F11, F4, C11\.<\/div>/,
        'the checks to act on one in each row, worst first, then in the sequence of the step; the others in one row for each condition; the checks without a result');
    assert.match(o, /data-node="cyclic"[^]*?<li class="st-monitor" title="Monitor"><span class="tuning-dot st-monitor"><\/span><span class="tuning-block-check">C12<\/span> <span class="tuning-block-check-st">Monitor<\/span><\/li>/, 'a value to monitor has its own row');
    assert.match(o, /data-node="cyclic"[^]*?<span class="tuning-badge st-blocked">Blocked<\/span> <span class="tuning-block-ids">C5 roll<\/span><\/div><div class="tuning-block-wait">Correct first: Filters, Blackbox log\.<\/div>/, 'what a step waits for: steps and items, no link in a box');
    assert.match(o, /data-node="tailcomp"[^]*?<span class="tuning-block-no">4b<\/span><span class="tuning-block-title">Tail compensation and output range<\/span><span class="tuning-start-badge" title="Start here">2<\/span>/);
    assert.ok(!/<a [^>]*>[^<]*<\/a>/.test(o.slice(o.indexOf('<div class="tuning-flow"'), o.indexOf('<aside'))), 'a box is a button: no link in the flow');
    for (const old of ['Examine the D-term noise', 'Examine the tracking error', 'Set the rates', 'TTA', 'Set the rescue', 'Calibrate', '<svg']) assert.ok(!o.includes(old), old);
    // the legend: the conditions of the steps, "Start here" numbers, the arrow
    const legend = /<div class="tuning-order-legend">([\s\S]*?)<\/div><div class="tuning-order-scroll">/.exec(o)[1];
    assert.deepEqual([...legend.matchAll(/<\/span>([^<]+)<\/div>/g)].map((m) => m[1]), ['Start here', 'Blocked', 'Possible result', 'Not measured', 'Not applicable',
        'The sequence of the steps to correct', 'Tune the step on the left first']);
    assert.match(panelOf(o), /class="tuning-goto-rec" data-rec="\d+">Examine the notch filter for the line at 4\.06×<\/a>/, 'the first step has its recommendation in the details panel');
    noRawMarkup(app);
    assert.deepEqual(app.errors, []);
});

test('a click on a step opens its side panel: what it waits for, possible result of, do first, checks, recommendations, pages, all parameters', () => {
    const app = analysed();
    app.jq.fire('click', '.tuning-node', { 'data-node': 'cyclic' });
    let o = app.pane('overview');
    assert.deepEqual(blocksOf(o).filter((b) => b[2]).map((b) => b[0]), ['cyclic'], 'the selected step has a ring');
    const panel = panelOf(o);
    assert.match(panel, /^<div class="tuning-node-head"><div class="tuning-muted">Step 3a<\/div><h5 class="tuning-node-title-text">Cyclic gains<\/h5><span class="tuning-badge st-blocked">Blocked<\/span><\/div>/);
    assert.match(panel, /<div class="tuning-panel-block is-blocked"><div class="tuning-label">Correct first<\/div><div><a href="#" class="tuning-node-link" data-node="filters">Filters<\/a>, <a href="#" class="tuning-node-link" data-node="logging">Blackbox log<\/a><\/div><\/div>/);
    assert.match(panel, /<div class="tuning-label">Do first<\/div><ul><li><a href="#" class="tuning-node-link" data-node="filters">Filters<\/a> <span class="tuning-badge st-start">Start here 1<\/span> <span class="tuning-muted">Correct this first\.<\/span><\/li><li><a href="#" class="tuning-node-link" data-node="governor">Governor<\/a> <span class="tuning-badge st-notapplicable">Not applicable<\/span> <span class="tuning-muted">Do this step first\.<\/span><\/li><\/ul>/,
        'the gate and order edges into the step, without the edge from an unknown node');
    assert.match(panel, /<ul class="tuning-check-list"><li class="row-problem"><span class="tuning-badge st-problem">Problem<\/span> <strong>C5 · PID profile 1 · roll · log 2<\/strong><div class="tuning-summary-text">At 45\.0 s a roll oscillation/);
    assert.match(panel, /class="tuning-show" data-key="track\|C5\|1\|0\|1\|roll\|0"[^>]*>Show in the log<\/a> <a href="#" class="tuning-compare-open" data-key="track\|C5\|1\|0\|1\|roll\|0" data-where="overview"[^>]*>Show the measurement<\/a>/);
    assert.match(panel, /These checks have no result: C1, C7\./, 'the checks of the step without a result');
    assert.match(panel, /<h5 class="tuning-h">Recommendations<\/h5><ul class="tuning-node-recs"><li class="tuning-node-rec" id="[^"]+-rec-\d+-panel"><div class="tuning-rec-badges"><span class="tuning-badge st-problem">Change<\/span><\/div> <a href="#" class="tuning-goto-rec" data-rec="\d+">Decrease the pitch F gain<\/a> <div class="tuning-inline tuning-muted"><span class="tuning-param" title="pitch_f_gain">Pitch F<\/span> \(PID profile 1\): 100 to 80 \(decrease\)<\/div><\/li>/);
    assert.ok(panel.indexOf('>Recommendations</h5>') < panel.indexOf('>Checks</h5>'), 'recommendations precede detailed checks');
    assert.match(panel, /<span class="tuning-badge st-monitor">Change<\/span> <span class="tuning-badge st-blocked">Blocked<\/span><\/div> <a [^>]*>Increase the roll P gain<\/a>[\s\S]*?<div class="tuning-node-rec-blocked">Blocked: <a href="#" class="tuning-node-link" data-node="filters">Filters<\/a>, Correct the filters first \(check F5\)\.<\/div><\/li>/,
        'the step keeps the blocked change and links its gate');
    assert.match(panel, /<div class="tuning-label">Rotorflight page<\/div><ul class="tuning-docs"><li><a href="https:\/\/rotorflight\.org\/docs\/Tuning\/Tuning-description" target="_blank" rel="noopener noreferrer" data-ste="quoted">Tuning your helicopter &lt;b&gt;<\/a><\/li><\/ul>/);
    assert.match(panel, /<div class="tuning-label">Parameters<\/div><span class="tuning-param" title="\{pitch,roll\}_\{d,p,i,f,o,b\}_gain">Pitch and roll D, P, I, F, O, B<\/span><\/div>$/);
    // the keyboard selects a step; a possible result shows its K rule and the step of its cause
    app.jq.fire('keydown', '.tuning-node', { 'data-node': 'tail' }, { which: 13 });
    o = app.pane('overview');
    assert.deepEqual(blocksOf(o).filter((b) => b[2]).map((b) => b[0]), ['tail']);
    assert.match(panelOf(o), /<div class="tuning-label">Possible result of<\/div><ul><li><strong>K5 Tracking error<\/strong>: C5 roll \(PID profile 1, log 2\)<div class="tuning-muted">Do first:<\/div><ol class="tuning-steps"><li>Correct C2 and T8 first\.<\/li><li>Then C5\.<\/li><\/ol><\/li><li><a href="#" class="tuning-node-link" data-node="cyclic">Cyclic gains<\/a>: C5 roll \(PID profile 1, log 2\)<\/li><\/ul>/,
        'a K rule with its steps, and a cause (hierarchy.cjs rule "cause") with its step');
    // a link in the panel selects that step; all the parameters of a step are in its panel
    app.jq.fire('click', '.tuning-node-link', { 'data-node': 'filters' });
    const p3 = panelOf(app.pane('overview'));
    assert.match(p3, /<span class="tuning-badge st-start">Start here 1<\/span><\/div><p class="tuning-node-about">The gyro filters and the D-term cutoffs\.<\/p><p class="tuning-node-reason">Check F5 shows a line without a notch filter &lt;b&gt;\.<\/p>/);
    assert.match(p3, /<div class="tuning-label">Do first<\/div><ul><li><a href="#" class="tuning-node-link" data-node="logging">Blackbox log<\/a> <span class="tuning-badge st-problem">Problem<\/span>[^]*?data-node="rpm">RPM signal and motor poles<\/a> <span class="tuning-badge st-ok">No problem found<\/span>/, 'the items that gate a step');
    assert.match(p3, /<span class="tuning-param" title="roll_d_cutoff">Roll D cutoff<\/span> <span class="tuning-param" title="pitch_d_cutoff">Pitch D cutoff<\/span><\/div>$/);
    noRawMarkup(app);
    assert.deepEqual(app.errors, []);
});

test('the graph of the diagram: prereq and blocks (SPEC3 K1), or one list of nodes with their kind; a result without either has no diagram', () => {
    const g = synthGraph(), flat = { nodes: g.prereq.map((n) => Object.assign({ kind: 'prereq' }, n)).concat(g.blocks.map((n) => Object.assign({ kind: 'block' }, n))), edges: g.edges, rules: g.rules };
    const a = analysed(), b = analysed({ result: synthResult({ hierarchy: Object.assign(synthHierarchy(), { graph: flat }) }) });
    const ga = a.internals.graphOf(a.result), gb = b.internals.graphOf(b.result);
    assert.deepEqual(plain(gb.columns.map((c) => [c.order, c.main.map((x) => x.id), c.cyclic.map((x) => x.id), c.tail.map((x) => x.id)])),
        plain(ga.columns.map((c) => [c.order, c.main.map((x) => x.id), c.cyclic.map((x) => x.id), c.tail.map((x) => x.id)])));
    assert.deepEqual(plain(gb.prereq.map((x) => x.id)), ['logging', 'rpm', 'power', 'mechanics', 'rescue', 'controller']);
    assert.equal(gb.edges.length, 12, 'the edges between known items and steps');
    assert.deepEqual(blocksOf(b.pane('overview')).map((x) => x[0]), blocksOf(a.pane('overview')).map((x) => x[0]));
    const none = analysed({ result: synthResult({ hierarchy: { nodes: {}, startHere: [], graph: { nodes: [{ id: 'setup', step: 1, title: 'Prepare the flight controller' }], edges: [] } } }) });
    assert.equal(none.internals.graphOf(none.result), null, 'a graph of round 1 (no kind): no diagram');
    assert.match(none.pane('overview'), /This result has no data for the tuning sequence\./);
    assert.deepEqual(none.errors, []);
});

test('SPEC3 I: focus() (the Analysis view: "Open in the Tuning view") opens the step of a result with its recommendation first and its CLI text', () => {
    const app = analysed();
    app.jq.fire('click', '.tuning-profile', { 'data-profile': 2 }); // a PID profile that does not show the result
    app.tab('checks');
    assert.equal(app.dialog.focus({ node: 'tailcomp', fid: FID.T8, recs: ['T7:yaw_collective_ff_gain:p1'] }), true);
    const o = app.pane('overview');
    assert.equal(app.jq.node('.tuning-pane[data-pane="overview"]').classes.has('active'), true, 'the tab "Tuning steps"');
    assert.match(o, /class="btn btn-default tuning-profile active" data-profile="all"/, 'All PID profiles: the result is of PID profile 1');
    assert.deepEqual(blocksOf(o).filter((b) => b[2]).map((b) => b[0]), ['tailcomp']);
    const panel = panelOf(o);
    assert.match(panel, /<h5 class="tuning-h">Recommendations<\/h5><ul class="tuning-node-recs"><li class="tuning-node-rec is-focus" id="([^"]+)-rec-(\d+)-panel"><div class="tuning-rec-badges"><span class="tuning-badge st-problem">Change<\/span><\/div> <a href="#" class="tuning-goto-rec" data-rec="\d+">Increase the yaw collective precompensation &lt;b&gt;!&lt;\/b&gt;<\/a> <div class="tuning-inline tuning-muted"><span class="tuning-param" title="yaw_collective_ff_gain">Yaw collective feedforward gain<\/span> \(PID profile 1\): 60 to 72 \(increase\)<\/div><div class="tuning-rec-rule"><div class="tuning-label">Rule<\/div><div>Check T7: r is 0\.5 or more, with a 2 SE test\. The step is 20 % or less\.<\/div><\/div><div class="tuning-cli"><button [^>]*>Copy<\/button><pre>profile 0\nset yaw_collective_ff_gain = 72<\/pre><\/div><\/li>/);
    const id = /<li class="tuning-node-rec is-focus" id="([^"]+)"/.exec(panel)[1];
    assert.ok(app.elements[id] && app.elements[id].scrolled === 1, 'the recommendation scrolls into view');
    // another step: the focus goes; an unknown step or no result: false
    app.jq.fire('click', '.tuning-node', { 'data-node': 'filters' });
    assert.ok(!app.pane('overview').includes('is-focus'));
    assert.equal(app.dialog.focus({ node: 'nowhere' }), false);
    assert.equal(setup().dialog.focus({ node: 'filters' }), false, 'no result on display');
    // js/main.js: openTuning(target) shows the view, then focus(target)
    const main = read('js/main.js');
    assert.match(main, /openTuning: function\(target\) \{\s*showView\("tuning"\);\s*if \(target\) \{\s*tuningDialog\.focus\(target\);\s*\}\s*\}/);
    assert.deepEqual(app.errors, []);
});

test('the real hierarchy.cjs graph draws every item and step, when the toolkit has the graph of SPEC3 K1', { skip: !(() => { try { return !!require('../tools/autotune/hierarchy.cjs').PREREQ; } catch (e) { return false; } })() && 'tools/autotune/hierarchy.cjs has no PREREQ yet' }, () => {
    const H = require('../tools/autotune/hierarchy.cjs');
    const result = synthResult();
    let hier;
    try {
        hier = H.status(result.findings, result.advice.recommendations, { logs: [1] });
    } catch (e) {
        hier = { nodes: {}, startHere: [] };
    }
    if (!hier.graph) hier.graph = typeof H.graph === 'function' ? H.graph() : { prereq: H.PREREQ, blocks: H.BLOCKS, edges: H.EDGES, rules: H.RULES };
    const app = analysed({ result: synthResult({ hierarchy: hier }) });
    const g = app.internals.graphOf(app.result), o = app.pane('overview');
    assert.ok(g && g.blocks.length >= 6 && g.prereq.length >= 6, 'the six steps and the six items');
    assert.equal(blocksOf(o).length, g.blocks.length);
    assert.equal(prereqsOf(o).length, g.prereq.length);
    for (const b of g.blocks) assert.ok(/^[1-9][ab]?$/.test(app.internals.stepNo(b)), b.id);
    // SPEC3 B: the documented sequence, Filters, Governor, then the two lanes; parameters only, no old step
    assert.deepEqual(plain(g.columns.map((c) => [c.main.map((x) => x.id), c.cyclic.map((x) => x.id), c.tail.map((x) => x.id)])),
        [[['filters'], [], []], [['governor'], [], []], [[], ['cyclic'], ['tail']], [[], ['cycomp'], ['tailcomp']]]);
    assert.ok(g.blocks.every((b) => Array.isArray(b.params) && b.params.length), 'every step has its parameters');
    assert.deepEqual(plain(g.prereq.map((x) => x.id)), ['logging', 'rpm', 'power', 'mechanics', 'rescue', 'controller']);
    assert.deepEqual(app.errors, []);
});

test('parameter labels are readable, distinguish axes, escape unknown names and preserve CLI commands', () => {
    const result = synthResult();
    result.advice.recommendations[0].title = 'Measure yaw_d_gain again <b>!';
    const app = analysed({ result }), I = app.internals;
    assert.match(app.pane('overview'), />Measure Yaw D again &lt;b&gt;!</);
    for (const [name, label] of Object.entries({ roll_p_gain: 'Roll P', pitch_i_gain: 'Pitch I', yaw_d_gain: 'Yaw D',
        gov_f_gain: 'Governor F', roll_b_gain: 'Roll B', pitch_o_gain: 'Pitch O', gov_headspeed: 'Governor headspeed',
        iterm_relax_cutoff: 'I-term relax cutoff', rescue_max_sp_rate: 'Rescue maximum setpoint rate',
        'feature RPM_FILTER': 'RPM notch filters', new_filter_setting: 'New filter setting' })) {
        assert.equal(I.parameterLabel(name), label);
    }
    app.jq.fire('click', '.tuning-node', { 'data-node': 'tail' });
    const panel = panelOf(app.pane('overview'));
    assert.match(panel, /title="yaw_p_gain">Yaw P<\/span>/);
    assert.doesNotMatch(panel.replace(/<[^>]+>/g, ''), /yaw_[pidfb]_gain/);
    assert.equal(I.parameterHtml('new_<setting>'), '<span class="tuning-param" title="new_&lt;setting&gt;">New &lt;setting&gt;</span>');
    app.tab('recs');
    assert.match(app.pane('recs'), />Measure Yaw D again &lt;b&gt;!</);
    assert.match(app.pane('recs'), /title="yaw_collective_ff_gain">Yaw collective feedforward gain<\/span>/);
    assert.match(app.pane('recs'), /set yaw_collective_ff_gain = 72/, 'CLI text keeps the exact firmware name');
    app.tab('export');
    assert.match(app.pane('export'), /Measure Yaw D again &lt;b&gt;!<\/label>/);
    assert.equal(result.advice.recommendations[0].title, 'Measure yaw_d_gain again <b>!', 'display labels do not change the report data');
});

test('Show in the log uses the Analysis inline panel with shaded raw plots and an explicit viewer link', async () => {
    const app = analysed({ result: withFreshness(synthResult()) }), asked = [];
    app.hooks.viewInLog = req => { asked.push(plain(req)); return true; };
    app.snippet.fields['setpoint[0]'] = t => 20 * Math.sin(t);
    app.snippet.fields['gyroADC[0]'] = t => 18 * Math.sin(t);
    app.tab('checks');
    app.jq.fire('click', '.tuning-show', { 'data-key': FID.C12 });
    await tick();
    assert.equal(asked.length, 0, 'opening the inline panel keeps the Tuning view and viewer position');
    assert.deepEqual(app.calls.seek, []);
    assert.deepEqual(app.calls.selectLog, []);
    const panel = app.html('.tuning-log-preview');
    assert.match(panel, /Data from the log \(log 2, 99\.8 s to 104\.8 s\)/);
    assert.match(panel, /Open in the log viewer/);
    assert.match(panel, /class="analysis-compare-head"/);
    assert.doesNotMatch(panel, /tuning-log-context/, 'the result text stays above the inline panel, as in Analysis');
    assert.match(panel, /PID profile 1/);
    assert.match(panel, /Values possibly different/);
    assert.equal(app.jq.node('.tuning-log-preview').classes.has('tuning-hide'), false);
    eq(app.reads.at(-1), { li: 1, t0: 99.55, t1: 105.05, fields: ['setpoint[0]', 'gyroADC[0]', 'axisError[0]'] });
    const spec = app.plots.at(-1).spec;
    eq(spec.series.map(s => s.name), ['setpoint[0]', 'gyroADC[0]']);
    assert.ok(spec.bands.length > 0, 'the evidence is shaded');
    assert.match(app.html('.tuning-log-body'), /This log does not contain these fields: <code>axisError\[0\]<\/code>/);
    assert.match(app.html('.tuning-log-body'), /class="log-lens-plot"><canvas class="analysis-compare-canvas is-log"/);
    const destroyed = app.destroyed.length;
    app.jq.fire('click', '.tuning-span', { 'data-key': FID.C5, 'data-span': 1 });
    await tick();
    assert.ok(app.destroyed.length > destroyed, 'changing the evidence disposes of the previous plots');
    assert.equal(asked.length, 0);
    app.jq.fire('click', '[data-tuning-log-act="viewer"]');
    assert.equal(asked[0].fromS, 79.7);
    assert.equal(asked[0].toS, 80.9);
    assert.equal(asked[0].analyser, 'gyroRAW[0]');
    assert.equal(app.jq.node('.tuning-log-preview').classes.has('tuning-hide'), true);
    assert.deepEqual(app.errors, []);
});

test('the log panel follows its result, toggles closed, and moves out of a table before that pane is redrawn', async () => {
    const app = analysed(), list = fakeElement('li'), links = fakeElement();
    list.appendChild(links);
    const clicked = app.jq.fire('click', '.tuning-show', { 'data-key': FID.C12 }, {
        closest: selector => selector === 'td, th' ? null : links,
    });
    const panel = app.jq.node('.tuning-log-preview').element;
    assert.deepEqual(list.children, [links, panel], 'the panel is immediately below the links of this result');
    app.jq.fire('click', '.tuning-show', {}, { element: clicked.el });
    assert.deepEqual(list.children, [links], 'the same link closes the panel');
    assert.equal(app.html('.tuning-log-preview'), '');
    await tick();
    assert.equal(app.plots.length, 0, 'the closed panel cannot draw a late result');

    app.tab('checks');
    const table = fakeElement('tbody'), row = fakeElement('tr'), cell = fakeElement('td');
    row.cells = [{ colSpan: 2 }, { colSpan: 1 }];
    cell.closest = () => row;
    table.appendChild(row);
    app.jq.fire('click', '.tuning-show', { 'data-key': FID.C12 }, { closest: () => cell });
    assert.equal(table.children.length, 2);
    const previewRow = table.children[1];
    assert.equal(previewRow.children[0].colSpan, 3);
    assert.equal(previewRow.children[0].children[0], panel);
    app.jq.fire('change', '.tuning-rf', { 'data-rf': 'ok' }, { checked: true });
    assert.deepEqual(table.children, [row], 'redrawing the findings removes the temporary table row');
    assert.equal(panel.parentNode, app.jq.node('#tuningBody').element, 'the panel remains reusable after a redraw');
    assert.equal(app.html('.tuning-log-preview'), '');
    assert.deepEqual(app.errors, []);
});

test('a closed or obsolete log preview ignores pending reads and cannot navigate into a new file', async () => {
    const app = analysed(), asked = [], resolve = [];
    app.hooks.viewInLog = req => { asked.push(req); return true; };
    app.context.TuningSnippet.Reader = function () { this.read = () => new Promise(done => resolve.push(done)); };
    const data = { cols: { 'gyroADC[0]': [1, 2] }, t: [100, 101], missing: [], clipped: false };
    app.jq.fire('click', '.tuning-show', { 'data-key': FID.C12 });
    await tick();
    app.jq.fire('keydown', '.tuning-log-preview', {}, { which: 27 });
    const plotCount = app.plots.length;
    resolve[0](data);
    await tick();
    assert.equal(app.html('.tuning-log-preview'), '');
    assert.equal(app.plots.length, plotCount, 'closing the popup ignores the pending read');
    app.jq.fire('click', '.tuning-show', { 'data-key': FID.C12 });
    await tick();
    app.load(new Uint8Array(100), 'different.bbl', fakeLog({ count: 1, current: 0 }));
    resolve[1](data);
    await tick();
    assert.equal(app.plots.length, plotCount, 'a result for a previous file cannot paint the new file');
    app.jq.fire('click', '[data-tuning-log-act="viewer"]');
    assert.deepEqual(asked, []);
    assert.equal(app.html('.tuning-log-preview'), '');
    assert.match(app.html('.tuning-notices'), /These results are for a different file/);
});

test('Show in the log: the evidence view and each part of the log, in frame seconds, with the fields of the check', () => {
    const app = analysed(), asked = [];
    app.hooks.viewInLog = (req) => { asked.push(plain(req)); return true; };
    app.tab('checks');
    app.jq.fire('click', '.tuning-show', { 'data-key': FID.C12 });
    app.jq.fire('click', '[data-tuning-log-act="viewer"]');
    assert.deepEqual(asked[0], { log: 1, fromS: 99.8, toS: 104.8, atS: 102.3, graphs: [['setpoint[0]', 'gyroADC[0]'], ['axisError[0]']], analyser: null,
        title: 'C12 roll, PID profile 1: Monitor', text: 'In PID profile 1 the roll tracking error is 31 ± 3 % of the setpoint.' });
    app.jq.fire('click', '.tuning-span', { 'data-key': FID.C5, 'data-span': 1 });
    app.jq.fire('click', '[data-tuning-log-act="viewer"]');
    assert.deepEqual(asked[1], { log: 1, fromS: 79.7, toS: 80.9, atS: 80.30000000000001, graphs: [['gyroADC[0]', 'setpoint[0]'], ['axisD[0]']], analyser: 'gyroRAW[0]',
        title: 'C5 roll, PID profile 1: Problem', text: 'At 45.0 s a roll oscillation at 14 Hz increases from less than 30 to 150 deg/s.' });
    // an evidence row of a recommendation links through its fid to the finding's evidence
    app.tab('recs');
    assert.match(app.pane('recs'), /data-key="track\|C5\|1\|0\|1\|roll\|0" title="Show this part of the log">Show in the log/);
    app.jq.fire('click', '.tuning-show', { 'data-key': FID.C5 });
    app.jq.fire('click', '[data-tuning-log-act="viewer"]');
    assert.equal(asked[2].fromS, 44.2);
    // a header check has no view: no link; a time link without evidence: that time +- 2 s; a plot click: the fields of the plot
    assert.ok(!/class="tuning-show" data-key="setup\|F1/.test(app.pane('checks')));
    app.jq.fire('click', '.tuning-seek', { 'data-log': 1, 'data-t': 45, 'data-id': 'C5', 'data-axis': 'roll' });
    assert.deepEqual(asked[3], { log: 1, atS: 45, fromS: 43, toS: 47, graphs: [['setpoint[0]', 'gyroADC[0]'], ['axisError[0]']], analyser: null, title: 'C5 roll, PID profile 1: Problem', text: asked[1].text });
    app.tab('governor');
    app.plots.map((p) => p.spec).find((s) => /^Headspeed, governor target/.test(s.title)).onClick(0.5);
    assert.deepEqual(asked[4].graphs, [['headspeed', 'govTarget'], ['motor[0]'], ['setpoint[3]']]);
    assert.equal(asked[4].fromS, 0, 'not before the log start');
    assert.deepEqual(app.calls.seek, [], 'viewInLog replaces seek');
    assert.deepEqual(plain(app.internals.lookFor('F5', 'pitch')), { graphs: [['gyroRAW[1]', 'gyroADC[1]']], analyser: 'gyroRAW[1]' });
    assert.equal(app.internals.lookFor('D2', null), null, 'no fields: the user\'s own graphs');
    // the viewer refuses: a notice
    app.hooks.viewInLog = () => false;
    app.jq.fire('click', '.tuning-show', { 'data-key': FID.C12 });
    app.jq.fire('click', '[data-tuning-log-act="viewer"]');
    assert.match(app.html('.tuning-notices'), /The app cannot show this part of the log\./);
});

test('index time of the curves and the toolkit times goes to frame seconds: evidence.cjs maps, and the worker map with its jumps', () => {
    const I = setup().internals;
    // ground truth: 20 000 samples at a nominal 1000 Hz on a frame clock 0.2 % slower, with a 26 ms stall before sample 4321
    const n = 20000, rate = 1000, fromS = 3, stall = 4321, us = Float64Array.from({ length: n }, (_, i) => 1e6 * (fromS + i * 1.002 / rate) + (i >= stall ? 26000 : 0));
    const frameOf = (i) => fromS + (us[i] - us[0]) / 1e6, indexOf = (i) => fromS + i / rate;
    // the worker's own map (js/tuning_worker.js timeMapOf): knots every 250 samples, the last sample, both sides of the stall
    const every = 250, wm = { fromS, every, actualRate: rate, n, frameS: Float32Array.from({ length: Math.ceil(n / every) }, (_, k) => frameOf(k * every)),
        endS: frameOf(n - 1), jumps: [[stall, frameOf(stall - 1), frameOf(stall)]] };
    let worst = 0;
    for (let i = 0; i < n; i += 7) worst = Math.max(worst, Math.abs(I.toFrame(wm, indexOf(i)) - frameOf(i)));
    for (const i of [stall - 1, stall, n - 1]) worst = Math.max(worst, Math.abs(I.toFrame(wm, indexOf(i)) - frameOf(i)));
    assert.ok(worst < 1e-5, `frame time from the worker map: worst ${worst} s`);
    assert.ok(Math.abs(I.toFrame(wm, indexOf(n - 1) + 1) - (frameOf(n - 1) + 1)) < 1e-5, 'after the last knot: the nominal rate');
    assert.equal(I.toFrame(null, 7.5), 7.5, 'without a time map: the same time');
    // evidence.cjs timeMap and toFrame: the same frame seconds at any time
    if (fs.existsSync(path.join(ROOT, 'tools/autotune/evidence.cjs'))) {
        const E = require('../tools/autotune/evidence.cjs'), tm = E.timeMap({ n, rate, fromS, flight: { actualRate: rate }, extra: { time: us } });
        for (let t = fromS - 0.5; t < 23.5; t += 0.0137) assert.ok(Math.abs(I.toFrame(tm, t) - E.toFrame(tm, t)) < 1e-9, `t ${t}: ${I.toFrame(tm, t)} against ${E.toFrame(tm, t)}`);
        for (const i of [0, stall - 1, stall, 9999, n - 1]) assert.ok(Math.abs(I.toFrame(tm, indexOf(i)) - frameOf(i)) < 1e-5, `sample ${i}`);
    }
    // in the view: a plot click and a time link of a finding, through the map of their record
    const map = { fromS: 2, every: 250, actualRate: 1000, n: 300001, frameS: Float32Array.from({ length: 1201 }, (_, k) => 2 + k * 0.25 * 1.001), endS: 2 + 300 * 1.001, jumps: [] };
    const records = [Object.assign(synthResult().records[0], { fromS: 2, timeMap: map })];
    const app = analysed({ result: synthResult({ records }) }), asked = [];
    app.hooks.viewInLog = (req) => { asked.push(plain(req)); return true; };
    app.tab('curves');
    app.plots.map((p) => p.spec).find((s) => /^Tracking error, roll/.test(s.title)).onClick(4.5);
    assert.ok(Math.abs(asked[0].atS - (2 + 2.5 * 1.001)) < 1e-5, 'a plot click');
    app.jq.fire('click', '.tuning-seek', { 'data-log': 1, 'data-t': 6.5, 'data-id': 'D2', 'data-axis': '' });
    assert.ok(Math.abs(asked[1].atS - (2 + 4.5 * 1.001)) < 1e-5, 'a time of a finding');
});

test('Show the measurement from the curves: the curve series, the reference lines and bands, the parts of the log shaded', () => {
    const tm = { fromS: 0, every: 250, actualRate: 1000, frameS: Float32Array.from({ length: 1300 }, (_, k) => k * 0.25 * 1.002) };
    const app = analysed({ result: synthResult({ records: [Object.assign(synthResult().records[0], { timeMap: tm })] }) });
    app.tab('checks');
    const before = app.plots.length;
    app.jq.fire('click', '.tuning-compare-open', { 'data-key': FID.C12, 'data-where': 'checks' });
    const t = app.html('.tuning-checks-table');
    assert.match(t, /<a href="#" class="tuning-compare-open active" data-key="track\|C12\|1\|0\|1\|roll\|0" data-where="checks"/);
    assert.match(t, /<tr class="tuning-compare-row"><td colspan="7"><div class="tuning-compare"><div class="tuning-compare-head"><strong>Measurement: C12, roll, PID profile 1, log 2<\/strong>/);
    assert.match(t, /<div class="tuning-compare-expected"><div class="tuning-label">Satisfactory<\/div><div>The tracking error is less than 30 % of the setpoint\.<\/div><\/div><div class="tuning-compare-measured"><div class="tuning-label">Measured<\/div><div>In PID profile 1/);
    assert.match(t, /Source: the curves of log 2\. The bands show the parts of the log that the result comes from\./);
    assert.match(t, /<canvas id="[^"]+" class="tuning-plot-canvas"><\/canvas><\/div><p class="tuning-plot-caption">The plot shows the setpoint and the error\. The line at 12 deg\/s is the limit of <code>axisError\[0\]<\/code> &lt;b&gt;\.<\/p>/,
        'SPEC3 H: the caption of the plot (evidence.cjs plot.caption) under the plot, code font for the text in back quotes, escaped');
    assert.equal(app.plots.length - before, 1, 'one plot');
    const spec = app.plots.at(-1).spec, curve = app.result.curves[0].track.roll.time;
    assert.deepEqual(plain(spec.series.map((s) => s.name)), ['setpoint', 'error', 'error without the time delay', 'oscillation amplitude']);
    assert.ok(spec.series[0].y === curve.sp, 'the curve itself');
    assert.ok(Math.abs(spec.series[0].x[1000] - 100 * 1.002) < 1e-3, 'curve time (index) on the frame clock of the spans');
    assert.deepEqual(plain(spec.hlines.map((h) => [h.y, h.label])), [[12, 'Limit 12 deg/s']]);
    assert.deepEqual(plain(spec.bands.map((b) => [b.x0, b.x1, b.label])), [[10, 20, 'Band <b>'], [100.3, 104.3, 'Worst 4 s'], [150.1, 154.1, 'part 2']], 'reference band, then the spans');
    assert.deepEqual([spec.x.label, spec.x.unit, spec.y.label], ['time', 's', 'value']);
    // a leaf path draws one series against its sibling axis; a missing path says why
    const I = app.internals, c = app.result.curves[0];
    assert.deepEqual(plain(I.curveSeries(I.curvePath(c, 'track.roll.spectrum.ee'), 'spectrum').series.map((s) => s.name)), ['error spectrum']);
    assert.equal(I.curveSeries(I.curvePath(c, 'track.roll.spectrum.ee'), 'spectrum').xs, 'f');
    assert.deepEqual(plain(I.curveSeries(I.curvePath(c, 'more.vib.roll'), 'transmission').series.map((s) => s.name)), ['transmission']);
    assert.deepEqual(plain(I.curveSeries(I.curvePath(c, 'more.tail'), 'time').series.map((s) => s.name)), ['tail output (mixer[2])', 'error']);
    assert.equal(I.curvePath(c, 'track.roll.nothing'), null);
    // close
    app.jq.fire('click', '.tuning-compare-close');
    assert.ok(!app.html('.tuning-checks-table').includes('tuning-compare-row'));
    // a header check: the table of header keys and values, escaped and in code font
    app.jq.fire('click', '.tuning-compare-open', { 'data-key': FID.F1, 'data-where': 'checks' });
    assert.match(app.html('.tuning-checks-table'), /<table class="tuning-table tuning-compare-table"><thead><tr><th><span data-ste="quoted">key<\/span><\/th><th><span data-ste="quoted">value<\/span><\/th><\/tr><\/thead><tbody><tr><td><span class="tuning-param" title="gyro_lpf1_type">Gyro low-pass filter 1 type<\/span><\/td><td><code>0<\/code><\/td><\/tr><tr><td><span class="tuning-param" title="gyro_lpf1_static_hz">Gyro low-pass filter 1 constant frequency<\/span><\/td><td><code>&lt;img/);
    assert.match(app.html('.tuning-checks-table'), /<\/tbody><\/table><\/div><p class="tuning-plot-caption">The table shows the gyro low-pass filters of the log header\.<\/p>/, 'the caption under a table too');
    noRawMarkup(app);
    assert.deepEqual(app.errors, []);
});

test('Show the measurement from a raw span: the reader of the current log, the derive worker, the plot in its slot', async () => {
    const app = analysed();
    app.snippet.fields = { 'gyroADC[0]': (t) => 40 * Math.sin(2 * Math.PI * 14 * t), 'setpoint[0]': () => 5 };
    app.jq.fire('click', '.tuning-node', { 'data-node': 'cyclic' });
    app.jq.fire('click', '.tuning-compare-open', { 'data-key': FID.C5, 'data-where': 'overview' });
    let o = app.pane('overview');
    assert.match(o, /<div class="tuning-order-compare"><div class="tuning-compare">/, 'under the diagram, at its full width');
    assert.match(o, /<div class="tuning-compare-body" id="(tuning\d+-cmp-\d+)"><p class="tuning-muted">Wait while the app reads the log\.<\/p><\/div>/);
    assert.match(o, /<button type="button" class="btn btn-default tuning-compare-span active" data-span="0">Part 1<\/button><button type="button" class="btn btn-default tuning-compare-span" data-span="1">Part 2<\/button>/);
    assert.deepEqual(app.reads, [{ li: 1, t0: 44.7, t1: 45.8, fields: ['gyroADC[0]', 'setpoint[0]', 'axisD[0]'] }], 'the first part, frame seconds');
    await tick();
    const w = app.deriveWorker();
    assert.ok(w, 'the derive worker starts on the first request');
    assert.deepEqual(w.sent.map((s) => s.msg.cmd), ['init', 'derive']);
    const d = w.sent[1].msg;
    assert.deepEqual([d.kind, d.rate, plain(d.params), Object.keys(d.cols)], ['bandpass', 1000, { lo: 10, hi: 20 }, ['gyroADC[0]', 'setpoint[0]']], 'axisD[0] is not in this log');
    const before = app.plots.length;
    w.onmessage({ data: { id: d.id, type: 'derived', result: { cols: { 'gyroADC[0]': d.cols['gyroADC[0]'].map((v) => v / 2) } } } });
    await tick();
    const slot = /<div class="tuning-compare-body" id="(tuning\d+-cmp-\d+)">/.exec(o)[1];
    const inner = app.jq.node('#' + slot).html;
    assert.match(inner, /<canvas id="tuning\d+-plot-\d+" class="tuning-plot-canvas"><\/canvas>/);
    assert.match(inner, /Source: log 2, 44\.7 s to 45\.8 s\. Not in this log: axisD\[0\]\./);
    assert.equal(app.plots.length - before, 1, 'the plot attaches into the slot');
    const spec = app.plots.at(-1).spec;
    assert.deepEqual(plain(spec.series.map((s) => s.name)), ['gyroADC[0]']);
    assert.equal(spec.series[0].x.length, 1101);
    assert.ok(Math.abs(spec.series[0].x[0] - 44.7) < 1e-9 && Math.abs(spec.series[0].y[250] - 20 * Math.sin(2 * Math.PI * 14 * 44.95)) < 1e-4, 'the derived column on the frame clock');
    assert.deepEqual(plain(spec.hlines.map((h) => h.y)), [30, 150]);
    assert.deepEqual(plain(spec.bands.map((b) => [b.x0, b.x1])), [[44.7, 45.8], [79.7, 80.9]]);
    // the second part: a new read; a derive error: the columns as the log records them, and the message as quoted text
    app.jq.fire('click', '.tuning-compare-span', { 'data-span': 1 });
    assert.deepEqual(app.reads.at(-1), { li: 1, t0: 79.7, t1: 80.9, fields: ['gyroADC[0]', 'setpoint[0]', 'axisD[0]'] });
    await tick();
    const d2 = w.sent.at(-1).msg, n2 = app.plots.length;
    w.onmessage({ data: { id: d2.id, type: 'error', message: 'unknown kind <b>bandpass</b>' } });
    await tick();
    o = app.pane('overview');
    const slot2 = /<div class="tuning-compare-body" id="(tuning\d+-cmp-\d+)">/.exec(o)[1];
    assert.match(app.jq.node('#' + slot2).html, /The app cannot filter the data: <span data-ste="quoted">unknown kind &lt;b&gt;bandpass&lt;\/b&gt;<\/span>\. The plot shows the values as the log records them\./);
    assert.deepEqual(plain(app.plots.slice(n2).map((p) => p.spec.series.map((q) => q.name))), [['gyroADC[0]', 'setpoint[0]']], 'the raw columns');
    // the link shows only when the evidence has something to draw
    const I = app.internals;
    assert.deepEqual([{ kind: 'table', rows: [] }, { kind: 'events', points: [{ t: 1, value: 2 }] }, { kind: 'time', curve: null, snippet: null }, { kind: 'time', snippet: { fields: ['gyroADC[0]'] } }]
        .map((plot) => I.canCompare({ plot, spans: [], view: null })), [false, false, false, false]);
    assert.deepEqual([{ kind: 'table', rows: [{ key: 'a', value: 1 }] }, { kind: 'events', points: [{ t: 1, value: 2 }, { t: 2, value: 3 }] }, { kind: 'spectrum', curve: 'more.dterm.roll' }]
        .map((plot) => I.canCompare({ plot, spans: [] })).concat(I.canCompare({ plot: { kind: 'time', snippet: { fields: ['gyroADC[0]'] } }, spans: [{ t0: 1, t1: 2 }] })), [true, true, true, true]);
    assert.equal(app.workers.filter((x) => x.sent.length && x.sent[0].msg.cmd === 'init').length, 1, 'one derive worker for the view');
    assert.deepEqual(app.errors, []);
});

test('derive, getResult, onResult and runAnalysis for the log lens', async () => {
    const app = setup(), seen = [];
    const off = app.dialog.onResult((r) => seen.push(r));
    assert.equal(app.dialog.getResult(), null);
    const run = app.dialog.runAnalysis();
    assert.equal(typeof run.then, 'function', 'a run starts: a promise of its result');
    assert.equal(app.workers.length, 1);
    assert.equal(app.workers[0].sent[0].msg.cmd, 'analyseLog');
    const result = synthResult();
    app.workers[0].reply({ type: 'result', result });
    assert.equal(await run, result);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], result);
    assert.equal(app.dialog.getResult(), result);
    assert.equal(await app.dialog.runAnalysis(), result, 'the cached result');
    assert.equal(app.workers.length, 1, 'no new run');
    // derive: one persistent worker, answers matched by id, errors and a stopped worker reject
    const p1 = app.dialog.derive('window', { 'gyroADC[0]': new Float32Array([1, 2, 3]) }, 1000, { lo: 1 }), p2 = app.dialog.derive('spectrum', {}, 1000);
    const w = app.deriveWorker();
    assert.deepEqual(w.sent.map((s) => [s.msg.cmd, s.msg.kind]), [['init', undefined], ['derive', 'window'], ['derive', 'spectrum']]);
    w.onmessage({ data: { id: w.sent[2].msg.id, type: 'derived', result: { f: [1, 2] } } });
    w.onmessage({ data: { id: w.sent[1].msg.id, type: 'error', message: 'no such kind' } });
    assert.deepEqual(plain(await p2), { f: [1, 2] });
    await assert.rejects(p1, /no such kind/);
    const p3 = app.dialog.derive('window', {}, 1000);
    w.onerror({ message: 'script error', preventDefault() {} });
    await assert.rejects(p3, /script error/);
    assert.equal(w.terminated, true);
    const p4 = app.dialog.derive('window', {}, 1000);
    assert.equal(app.workers.filter((x) => x.sent.length && x.sent[0].msg.cmd === 'init').length, 2, 'a new derive worker after a stop');
    app.later.forEach((fn) => fn()); // 30 s without an answer
    await assert.rejects(p4, /no answer from the derive worker in 30 s/);
    // another file: the result goes, the listeners hear null
    app.setFile(Uint8Array.from({ length: 400 }, (_, i) => (i * 13) & 0xff), 'other.bbl');
    assert.equal(app.dialog.getResult(), null, 'only a result of the open file');
    app.show();
    assert.equal(seen.at(-1), null);
    off();
    app.workers.at(-1).reply({ type: 'result', result: synthResult() });
    assert.equal(seen.length, 2, 'removed listeners hear nothing');
});

test('runAnalysis of the Analysis view: a run for another file or log stops first; the promise rejects when the run stops (B1)', async () => {
    const reason = (r, extra = {}) => (e) => e.reason === r && Object.keys(extra).every((k) => e[k] === extra[k]);
    // (a) a run for file A; file B is dropped on the window (the Tuning view is not shown); Start again
    const app = setup();
    const a = app.dialog.runAnalysis();
    app.load(Uint8Array.from({ length: 400 }, (_, i) => (i * 13 + 5) & 0xff), 'B.bbl', app.flightLog);
    const b = app.dialog.runAnalysis();
    await assert.rejects(a, reason('replaced'));
    assert.equal(app.workers[0].terminated, true, 'the run for file A stops');
    assert.deepEqual(app.workers.map((w) => w.sent[0].msg.fileName), ['<i>flight</i>.bbl', 'B.bbl'], 'a run for file B');
    const rb = synthResult({ fileName: 'B.bbl' });
    app.workers[1].reply({ type: 'result', result: rb });
    assert.equal(await b, rb);
    // (b) a run for log 2; the viewer moves to log 3: Start runs log 3; a second Start waits for the same run
    const c = setup();
    const p2 = c.dialog.runAnalysis();
    c.flightLog.openLog(2);
    const p3 = c.dialog.runAnalysis(), again = c.dialog.runAnalysis();
    await assert.rejects(p2, reason('replaced'));
    assert.deepEqual(c.workers.map((w) => w.sent[0].msg.logIndex), [1, 2]);
    const r3 = synthResult({ logIndex: 2 });
    c.workers[1].reply({ type: 'result', result: r3 });
    assert.equal(await p3, r3);
    assert.equal(await again, r3);
    // (c) an error of the worker, a crash, Cancel: the promise rejects with the reason; Start again makes a new run
    const d = setup();
    const pe = d.dialog.runAnalysis();
    d.workers[0].reply({ type: 'error', message: 'The log cannot be decoded.' });
    await assert.rejects(pe, reason('failed', { detail: 'The log cannot be decoded.' }));
    const pw = d.dialog.runAnalysis();
    assert.equal(d.workers.length, 2, 'Start after an error: a new run');
    d.workers[1].onerror({ message: 'script error', preventDefault() {} });
    await assert.rejects(pw, reason('failed', { message: 'The script of the analysis stopped.', detail: 'script error' }));
    const pc = d.dialog.runAnalysis();
    d.jq.fire('click', '.tuning-cancel');
    await assert.rejects(pc, reason('canceled', { message: 'You canceled the analysis.' }));
    // the Tuning view starts a run with other settings: the run of the Analysis view stops
    const pr = d.dialog.runAnalysis();
    d.jq.fire('change', '.tuning-scope', {}, { value: 'file' });
    d.jq.fire('click', '.tuning-analyse');
    await assert.rejects(pr, reason('replaced'));
    // "All logs in the file": a run for another selected log gives the findings of this log too, so it goes on
    const f = setup();
    f.jq.fire('change', '.tuning-scope', {}, { value: 'file' });
    const pf = f.dialog.runAnalysis();
    f.flightLog.openLog(2);
    const pf2 = f.dialog.runAnalysis();
    assert.equal(f.workers.length, 1, 'no second run of the file');
    assert.equal(f.workers[0].sent[0].msg.cmd, 'analyseFile');
    const rf = synthResult({ scope: 'file', logs: [0, 1, 2] });
    f.workers[0].reply({ type: 'result', result: rf });
    assert.equal(await pf, rf);
    assert.equal(await pf2, rf);
    // no file
    const n = setup();
    n.setFile(null, 'x.bbl');
    assert.equal(n.dialog.runAnalysis(), false);
});

test('derive: the buffers of the log lens and the Analysis view go to the worker in the transfer list, once each (B2)', async () => {
    const app = setup();
    const a = new Float32Array([1, 2, 3]), b = new Float32Array([4, 5]);
    app.dialog.derive('window', { a, b, c: a, d: null }, 1000, {}, true);
    const w = app.deriveWorker(), last = w.sent.at(-1);
    assert.equal(last.msg.kind, 'window');
    assert.equal(last.transfer.length, 2, 'each buffer once');
    assert.ok(last.transfer[0] === a.buffer && last.transfer[1] === b.buffer);
    // without transfer (the Tuning view reads its own columns again): a copy, no transfer list
    app.dialog.derive('spectrum', { a }, 1000, {});
    assert.equal(w.sent.at(-1).transfer, undefined);
});

test('the status of a finding: the worker\'s status first, else the rule of catalog.cjs status() for every check id and severity', () => {
    const I = setup().internals, catalog = require('../tools/autotune/catalog.cjs');
    const variants = [{ severity: 'flag' }, { severity: 'flag', explained: 'x' }, { severity: 'note' }, { severity: 'note', thin: true }, { severity: 'note', text: 'no finding: 2 blocks' },
        { severity: 'ok' }, { severity: 'skipped' }, { severity: 'error' }, { severity: 'note', axis: 'yaw', se: 0.1 }, { severity: 'note', axis: 'roll', se: 0.1, unit: 'permille' }];
    const bad = [];
    for (const id of Object.keys(catalog.CHECKS)) {
        for (const v of variants) {
            const f = Object.assign({ id, text: '' }, v), want = catalog.status(f), got = I.findingStatus(f);
            if (got !== want) bad.push(`${id} ${JSON.stringify(v)}: view ${got}, catalog ${want}`);
        }
    }
    assert.deepEqual(bad, [], 'REPORT_ONLY in js/tuning_dialog.js (for a finding without the status of the worker) must list the checks whose notes are "information" in the catalog');
    assert.equal(I.findingStatus({ id: 'C13', severity: 'note', status: 'monitor' }), 'monitor', 'the worker\'s status wins');
    assert.equal(I.findingStatus({ id: 'C13', severity: 'note', status: 'toString' }), 'information', 'a text that is not a status word: the rule');
});

test('one PID profile label for each row (D-M2): the worker\'s pidProfile, then the label of its summary, never a PID profile next to "PID profile unknown"', () => {
    const I = setup().internals;
    // pidProfile null: the worker does not know the PID profile at arming
    assert.deepEqual([0, 'arm', 2, null].map((p) => I.profileNo({ id: 'C12', profile: p, pidProfile: null })), [0, 0, 0, null]);
    assert.equal(I.profileNo({ id: 'C12', profile: 0, pidProfile: 2 }), 2, 'a known PID profile at arming');
    assert.equal(I.profileNo({ id: 'C12', profile: 0, pidProfile: 2, display: { profile: 'PID profile unknown' } }), 0, 'never next to an unknown summary');
    assert.equal(I.profileNo({ id: 'C12', profile: 0, display: { profile: 'PID profile 3' } }), 3, 'the label of the summary');
    assert.equal(I.profileNo({ id: 'C12', profile: 2, display: { profile: null } }), null, 'a summary for all PID profiles');
    assert.equal(I.profileNo({ id: 'D4', profile: 1, pidProfile: null }), 2, 'D4: its CLI section');
    // a row of All checks: the label of the row agrees with its summary
    const result = synthResult(), c12 = result.findings.find((f) => f.id === 'C12');
    Object.assign(c12, { profile: 0, pidProfile: null, summary: 'In an unknown PID profile, the roll tracking error is 31 ± 3 % of the setpoint.',
        display: { value: '31 ± 3 %', unit: '%', scale: 100, limit: null, profile: 'PID profile unknown', phase: null } });
    const app = analysed({ result });
    app.tab('checks');
    const row = /<tr class="row-monitor">(?:(?!<\/tr>)[\s\S])*?In an unknown PID profile, the roll tracking error[\s\S]*?<\/tr>/.exec(app.pane('checks'));
    assert.ok(row, 'the row of C12');
    assert.match(row[0], /<td>PID profile unknown · roll<\/td>/);
    assert.ok(!/PID profile [1-6]/.test(row[0].replace(/<details[\s\S]*?<\/details>/g, '')), 'no PID profile number in the row');
});

test('the CLI file: the changes of a group (C7) are selected together, and a part of a group gives no file (C3)', async () => {
    const result = synthResult(), recs = result.advice.recommendations;
    recs.find((r) => r.id === 'C7:pitch_f_gain:p1').group = 'C7:pitch:4250';
    recs.push({ id: 'C7:pitch_p_gain:p1', group: 'C7:pitch:4250', area: 'cyclic', order: 20, severity: 'action', title: 'Increase the pitch P gain', parameter: 'pitch_p_gain', scope: 'profile', cliProfile: 0,
        profile: 1, from: 50, to: 55, node: 'cyclic', direction: 'raise', cli: ['profile 0', 'set pitch_p_gain = 55'], evidence: [], rule: 'The rules 6 to 8 of report.cjs.', confidence: 'predicted', blockedBy: [], caveats: [] });
    // a group with a change that a cause holds: no CLI for that one, so the group cannot go into the file
    recs.find((r) => r.id === 'C7:roll_p_gain:p1').group = 'C7:roll:3500';
    recs.push({ id: 'C7:roll_f_gain:p1', group: 'C7:roll:3500', area: 'cyclic', order: 21, severity: 'action', title: 'Decrease the roll F gain', parameter: 'roll_f_gain', scope: 'profile', cliProfile: 0,
        profile: 1, from: 100, to: 90, node: 'cyclic', direction: 'lower', cli: ['profile 0', 'set roll_f_gain = 90'], evidence: [], rule: '', confidence: 'predicted', blockedBy: [], caveats: [] });
    const app = analysed({ result });
    app.tab('export');
    const boxes = () => [...app.pane('export').matchAll(/<li class="tuning-pick-row[^"]*"(?: data-group="([^"]*)")?><label class="tuning-pick-label"><input type="checkbox" class="tuning-pick" data-pick="(\d+)"( checked)?( disabled)?> [\s\S]*?<\/label>/g)]
        .map((m) => [+m[2], m[1] || '', m[3] ? 'on' : m[4] ? 'off' : 'free']);
    const at = (id) => [...app.pane('export').matchAll(/data-pick="(\d+)"[^>]*> [\s\S]*?<\/span> ([^<]+)<\/label>/g)].find((m) => m[2] === recs.find((r) => r.id === id).title)[1];
    const pitch = [at('C7:pitch_f_gain:p1'), at('C7:pitch_p_gain:p1')].map(Number), roll = [at('C7:roll_p_gain:p1'), at('C7:roll_f_gain:p1')].map(Number);
    let b = boxes();
    assert.deepEqual(pitch.map((i) => b.find((x) => x[0] === i)), pitch.map((i) => [i, 'C7:pitch:4250', 'on']), 'the group is selected at first, as one');
    assert.deepEqual(roll.map((i) => b.find((x) => x[0] === i)), roll.map((i) => [i, 'C7:roll:3500', 'off']), 'a group with a change without CLI text: none can be selected');
    let x = app.pane('export');
    assert.match(x, /Group C7, pitch, 4250 rpm: 2 changes\. The app selects all of them, or none of them\./);
    assert.match(x, /Group C7, roll, 3500 rpm: 2 changes\. The app selects all of them, or none of them\. A change of this group has no CLI text\. Thus, the CLI file cannot contain this group\./);
    await tick();
    assert.deepEqual(plain(app.deriveWorker().sent.filter((s) => s.msg.cmd === 'export').at(-1).msg.picks), ['T7:yaw_collective_ff_gain:p1', 'C7:pitch_f_gain:p1', 'C7:pitch_p_gain:p1']);
    // a click on one change of the group removes all of it, and selects all of it again
    app.jq.fire('change', '.tuning-pick', { 'data-pick': pitch[1] }, { checked: false });
    b = boxes();
    assert.deepEqual(pitch.map((i) => b.find((q) => q[0] === i)[2]), ['free', 'free']);
    await tick();
    assert.deepEqual(plain(app.deriveWorker().sent.filter((s) => s.msg.cmd === 'export').at(-1).msg.picks), ['T7:yaw_collective_ff_gain:p1']);
    app.jq.fire('change', '.tuning-pick', { 'data-pick': pitch[0] }, { checked: true });
    b = boxes();
    assert.deepEqual(pitch.map((i) => b.find((q) => q[0] === i)[2]), ['on', 'on']);
    // a selection with a part of a group (here a group with a change without CLI text): no file, and why
    app.jq.fire('change', '.tuning-pick', { 'data-pick': roll[1] }, { checked: true });
    assert.match(app.pane('export'), /The CLI file is not available\. The changes of group C7, roll, 3500 rpm go into the CLI file together\. Select all the changes of the group, or none of them\./);
    assert.match(app.pane('export'), /tuning-export-copy" data-label="Copy commands" disabled>/);
    // the cards show the group
    app.tab('recs');
    assert.match(app.pane('recs'), /<div class="tuning-rec-title">Increase the pitch P gain<\/div><div class="tuning-muted">Cyclic · PID profile 1 · Calculated with the gain model · Group C7, pitch, 4250 rpm<\/div>/);
    // the pure parts; advice.cjs groupSize: a group with a change that is not in the list cannot go into the file
    const I = app.internals, two = [{ id: 'a', group: 'C7:yaw:2000', groupSize: 3, severity: 'action', cli: ['set x = 1'], scope: 'global' },
        { id: 'b', group: 'C7:yaw:2000', groupSize: 3, severity: 'action', cli: ['set y = 1'], scope: 'global' }];
    assert.deepEqual([I.canPick(two, 0), I.canPick(two.slice(0, 1).concat([Object.assign({}, two[1], { groupSize: 2 })]).map((r) => Object.assign({}, r, { groupSize: 2 })), 0)], [false, true]);
    assert.deepEqual(plain(I.partGroups(two, { 0: true, 1: true })), ['C7:yaw:2000']);
    assert.equal(I.groupLabel('C7:yaw:2000'), 'C7, yaw, 2000 rpm');
    assert.equal(I.groupLabel('X:1'), 'X:1');
    noRawMarkup(app);
    assert.deepEqual(app.errors, []);
});

test('the CLI file restores the PID profile of the CLI dump only when the worker gives one (C7)', () => {
    const I = setup().internals, meta = (cli) => plain(I.exportMeta({ finishedAt: Date.now(), result: synthResult({ cli }) }));
    assert.deepEqual([meta({ kind: 'diff', selectedProfile: 2, selectedRateProfile: 1 })].map((m) => [m.activeProfile, m.activeRateProfile]), [[2, 1]]);
    assert.deepEqual([meta({ kind: 'diff', selectedProfile: null, selectedRateProfile: null })].map((m) => [m.activeProfile, m.activeRateProfile]), [[null, null]],
        'a dump that is possibly cut: no profile to select again');
    assert.deepEqual([null, undefined, -1, 6, 1.5, '2'].map(I.cliIndex), [null, null, null, null, null, null], 'a CLI index is 0 to 5');
    assert.equal(meta(null).activeProfile, null);
});

test('Show the measurement without the curves of the log: a true message, or the raw span of the evidence (D-H3)', async () => {
    // "All logs in the file": the curves of the log of the viewer only (log 2); an F5 of log 3 without a snippet
    const result = synthResult({ scope: 'file', logs: [0, 1, 2] }), f5 = result.findings.find((f) => f.id === 'F5');
    f5.log = 2;
    f5.evidence = { v: 1, fid: FID.F5, id: 'F5', log: 2, profile: 1, axis: null, spans: [{ log: 2, t0: 30, t1: 36 }], view: { log: 2, t0: 30, t1: 36, at: 33, graphs: [['gyroRAW[0]']], analyser: null },
        plot: { kind: 'spectrum', tab: 'filters', curve: 'more.vib.byProfile.1.roll', snippet: null, reference: [] }, expected: '', summary: 'A line at 4.06 x.', context: [] };
    let app = analysed({ result });
    app.tab('checks');
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    app.jq.fire('click', '.tuning-compare-open', { 'data-key': FID.F5, 'data-where': 'checks' });
    let t = app.html('.tuning-checks-table');
    assert.match(t, /<p class="tuning-na">The result has curves only for log 2\. To see this plot for log 3, open log 3 in the log viewer\. Then start the analysis again\.<\/p>/);
    assert.ok(!/for log \d+ only/.test(t), 'not the old text');
    // no curves at all
    app = analysed({ result: synthResult({ curves: [] }) });
    app.tab('checks');
    app.jq.fire('click', '.tuning-compare-open', { 'data-key': FID.C12, 'data-where': 'checks' });
    assert.match(app.html('.tuning-checks-table'), /<p class="tuning-na">The result has no curves\. Thus, the app cannot show this plot\.<\/p>/);
    // the curves of the log without these data
    app = analysed({ result: synthResult() });
    const I = app.internals;
    assert.equal(I.noCurveText(app.result, 1, true), 'The curves of log 2 do not contain the data of this plot.');
    // evidence.cjs gives a raw span when the result has no curves of the log: the snippet, read and derived
    const r2 = synthResult({ scope: 'file', logs: [0, 1, 2] }), g = r2.findings.find((f) => f.id === 'F5');
    g.log = 2;
    g.evidence = Object.assign({}, f5.evidence, { plot: { kind: 'spectrum', tab: 'filters', curve: 'more.vib.byProfile.1.roll',
        snippet: { fields: ['gyroRAW[0]', 'gyroADC[0]'], derive: { kind: 'spectrum', params: { N: 256 } } }, reference: [{ kind: 'vline', value: 156, label: '156 Hz', unit: 'Hz' }] } });
    app = analysed({ result: r2 });
    app.snippet.fields = { 'gyroRAW[0]': (x) => Math.sin(2 * Math.PI * 156 * x), 'gyroADC[0]': (x) => 0.01 * Math.sin(2 * Math.PI * 156 * x) };
    app.tab('checks');
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    app.jq.fire('click', '.tuning-compare-open', { 'data-key': FID.F5, 'data-where': 'checks' });
    assert.deepEqual(app.reads.at(-1), { li: 2, t0: 30, t1: 36, fields: ['gyroRAW[0]', 'gyroADC[0]'] }, 'the raw span of log 3');
    await tick();
    const w = app.deriveWorker(), d = w.sent.at(-1).msg;
    assert.deepEqual([d.kind, plain(d.params), Object.keys(d.cols)], ['spectrum', { N: 256 }, ['gyroRAW[0]', 'gyroADC[0]']]);
    const fq = Float32Array.from({ length: 129 }, (_, i) => i * 1000 / 256);
    w.onmessage({ data: { id: d.id, type: 'derived', result: { f: fq, amplitude: { 'gyroRAW[0]': Float32Array.from(fq, () => 1), 'gyroADC[0]': Float32Array.from(fq, () => 0.01) } } } });
    await tick();
    const spec = app.plots.at(-1).spec;
    assert.deepEqual(plain(spec.series.map((q) => q.name)), ['gyroRAW[0]', 'gyroADC[0]']);
    assert.deepEqual([spec.x.unit, plain(spec.vlines.map((v) => v.x))], ['Hz', [156]]);
    // T8 of a log without curves (evidence.cjs FALLBACK): mixer[2] against the limits in ‰, the tail servo in µs on the right axis
    const r3 = synthResult({ scope: 'file', logs: [0, 1, 2] }), t8 = r3.findings.find((f) => f.id === 'T8'), lim = [{ kind: 'hline', value: 400, label: 'Limit 400 ‰', unit: '‰' }, { kind: 'hline', value: -400, label: 'Limit −400 ‰', unit: '‰' }];
    Object.assign(t8, { log: 2, evidence: { v: 1, fid: FID.T8, id: 'T8', log: 2, profile: 1, axis: null, spans: [{ log: 2, t0: 50, t1: 52 }], view: null, expected: '', summary: '', context: [],
        plot: { kind: 'time', tab: 'tail', curve: 'more.tail', snippet: { fields: ['mixer[2]', 'servo[3]'], derive: null, fallback: true, reference: lim }, reference: lim } } });
    app = analysed({ result: r3 });
    app.snippet.fields = { 'mixer[2]': (x) => 400 * Math.sin(x), 'servo[3]': (x) => 1500 + 400 * Math.sin(x) };
    app.tab('checks');
    app.jq.fire('click', '.tuning-compare-open', { 'data-key': FID.T8, 'data-where': 'checks' });
    assert.deepEqual(app.reads.at(-1), { li: 2, t0: 50, t1: 52, fields: ['mixer[2]', 'servo[3]'] });
    await tick();
    await tick();
    const s8 = app.plots.at(-1).spec;
    assert.deepEqual(plain(s8.series.map((q) => [q.name, q.axis || 'y'])), [['mixer[2]', 'y'], ['servo[3]', 'y2']], 'the servo pulse is drawn too, on its own axis');
    assert.deepEqual(plain([s8.y.unit, s8.y2 && s8.y2.unit, s8.hlines.map((h) => h.y)]), ['‰', 'µs', [400, -400]]);
    assert.deepEqual(app.errors, []);
});

test('Recommendations: possible result of, with the upstream recommendation and the K rule, and no CLI until the cause is correct', () => {
    const app = analysed();
    app.tab('recs');
    const r = app.pane('recs');
    const card = /<div class="tuning-rec st-possible" id="tuning\d+-rec-(\d+)">([\s\S]*?)(<div class="tuning-rec |<h5 class="tuning-h">Gain analysis)/.exec(r);
    assert.ok(card, 'a possible result has its own status');
    assert.match(card[2], /<div class="tuning-rec-badges"><span class="tuning-badge st-monitor">Check<\/span> <span class="tuning-badge st-possible">Possible result<\/span><\/div><div class="tuning-rec-title">Examine the roll tracking error<\/div>/);
    assert.match(card[2], /<div class="tuning-label">Possible result of<\/div><ul><li><strong>K5 Tracking error<\/strong>: C5 roll \(PID profile 1\)<div>Do first: <a href="#" class="tuning-goto-rec" data-rec="\d+">Increase the roll P gain<\/a>, <a href="#" class="tuning-goto-rec" data-rec="\d+">Examine the roll oscillation<\/a><\/div><ol class="tuning-steps"><li>Correct C5 first\.<\/li><li>Then fly again\.<\/li><\/ol><\/li><\/ul>/);
    assert.match(card[2], /This recommendation has no CLI text\. Correct the cause first\. Then start the analysis again\./);
    // its evidence row is the finding's: the summary, Show in the log, Show the measurement inline in the card
    assert.match(card[2], /<div class="tuning-summary-text">In PID profile 1 the roll tracking error is 31 ± 3 % of the setpoint\.<\/div>/);
    const where = /data-key="track\|C5\|1\|0\|1\|roll\|0" data-where="(recs:\d+)"/.exec(r)[1];
    app.jq.fire('click', '.tuning-compare-open', { 'data-key': FID.C5, 'data-where': where });
    const panels = app.pane('recs').split('<tr class="tuning-compare-row"><td colspan="7"><div class="tuning-compare">').length - 1;
    assert.equal(panels, 1, 'a finding in two cards: the panel opens in the card of the click only');
    assert.match(app.html('.tuning-pane[data-pane="recs"]'), /Wait while the app reads the log\./);
});

// hierarchy.byProfile (SPEC2 D12): the status of each PID profile; PID profile 2 has no tail problem and starts at the cyclic
function synthByProfile() {
    const top = synthHierarchy();
    const p1 = { nodes: top.nodes, startHere: top.startHere };
    const p2 = { nodes: { logging: { status: 'problem', fids: [] }, rpm: { status: 'ok', fids: [] }, filters: { status: 'satisfactory', fids: [] }, governor: { status: 'monitor', fids: [] },
        cyclic: { status: 'startHere', number: 1, fids: [], reason: 'This step has a problem <b>.' }, tail: { status: 'possible', fids: [] }, tailcomp: { status: 'satisfactory', fids: [] } }, startHere: ['cyclic'] };
    return Object.assign(top, { byProfile: { 1: p1, 2: p2 } });
}

test('PID profiles: the selector, the status of each PID profile in the diagram, the lists of one PID profile, a PID profile on every row', () => {
    const app = analysed({ result: synthResult({ hierarchy: synthByProfile() }) });
    let o = app.pane('overview');
    // the selector: all, then each PID profile of the result (findings, recommendations, flight time); the unknown arming profile last
    const bar = /<div class="tuning-profile-bar"[\s\S]*?<\/span><\/div>/.exec(o)[0];
    assert.deepEqual([...bar.matchAll(/data-profile="(\w+)">([^<]+)/g)].map((m) => [m[1], m[2].trim()]),
        [['all', 'All PID profiles'], ['1', 'PID profile 1'], ['2', 'PID profile 2'], ['3', 'PID profile 3'], ['0', 'PID profile unknown']]);
    assert.match(bar, /class="btn btn-default tuning-profile active" data-profile="all"/);
    assert.match(bar, /data-profile="1">PID profile 1 <span class="tuning-profile-count" title="5 items with a problem">5<\/span>/, 'a chip: the items and steps with a problem in that PID profile');
    assert.match(bar, /data-profile="2">PID profile 2 <span class="tuning-profile-count" title="3 items with a problem">3<\/span>/);
    assert.match(bar, /data-profile="3">PID profile 3<\/button>/, 'no per-profile status and no problem: no chip');
    // "All PID profiles": a chip for each PID profile on each item and step, coloured by its condition in that PID profile
    assert.match(o, /data-node="tailcomp"[^]*?<div class="tuning-block-profiles"><span class="tuning-label">PID profile<\/span><span class="tuning-pchip st-start" data-profile="1" title="PID profile 1: Start here">1<\/span><span class="tuning-pchip st-satisfactory" data-profile="2" title="PID profile 2: Satisfactory">2<\/span><\/div>/);
    assert.match(o, /data-node="cyclic"[^]*?data-profile="1" title="PID profile 1: Blocked">1<\/span><span class="tuning-pchip st-start" data-profile="2" title="PID profile 2: Start here">2<\/span>/);
    const rpmItem = o.slice(o.indexOf('data-node="rpm"'), o.indexOf('</li>', o.indexOf('data-node="rpm"')));
    assert.ok(rpmItem.length > 0 && !rpmItem.includes('tuning-block-profiles'), 'an item with the same condition in each PID profile: no chips');
    assert.match(o, /<span class="tuning-pchip">1<\/span>The condition in each PID profile<\/div>/, 'the legend tells what the chips are');
    // PID profile 2: its own status, start numbers and lists
    app.jq.fire('click', '.tuning-profile', { 'data-profile': 2 });
    o = app.pane('overview');
    assert.ok(!o.includes('tuning-block-profiles'), 'one PID profile: no chips for the others');
    assert.deepEqual(blocksOf(o).filter((b) => b[0] === 'cyclic' || b[0] === 'tailcomp'), [['cyclic', 'start', true], ['tailcomp', 'satisfactory', false]], 'the first start step of PID profile 2 is selected');
    assert.match(o, /The diagram and the lists show PID profile 2 and the items for all PID profiles\./);
    assert.match(o, /<div class="tuning-summary"><div>Log 2 of 3, PID profile 2: 8 results, 1 recommendation\./, 'the summary counts PID profile 2 and the items for all PID profiles');
    assert.match(o, /<span class="tuning-badge st-start">Start here 1<\/span><\/div><p class="tuning-node-reason">This step has a problem &lt;b&gt;\.<\/p>/);
    assert.ok(!/C5 · PID profile 1/.test(o), 'the side panel shows the results of PID profile 2 only');
    app.tab('recs');
    const recs = app.pane('recs');
    assert.match(recs, /1 recommendation in the tuning sequence for PID profile 2: 1 item to monitor\./);
    assert.deepEqual([...recs.matchAll(/<div class="tuning-rec-title">([^<]+)/g)].map((m) => m[1]), ['Monitor the governor I-term oscillation']);
    app.tab('checks');
    const checks = app.pane('checks');
    assert.ok(!/<td>PID profile 1/.test(checks) && /<td>All PID profiles<\/td>/.test(checks), 'All checks: PID profile 2 and the checks for all PID profiles');
    // PID profile 3 has no per-profile status: the diagram says that it shows all PID profiles together
    app.jq.fire('click', '.tuning-profile', { 'data-profile': 3 });
    app.tab('overview');
    assert.match(app.pane('overview'), /The diagram shows the results of all PID profiles together\. The lists show PID profile 3 and the items for all PID profiles\./);
    // all again: every row shows its PID profile, every card too
    app.jq.fire('click', '.tuning-profile', { 'data-profile': 'all' });
    app.tab('checks');
    showAllResults(app); // SPEC3 E: the two filters on, so that the list has each result
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    const rows = [...app.html('.tuning-checks-table').matchAll(/<td class="tuning-id">[^]*?<\/td>(?:<td>[^<]*<\/td>)?<td>([^<]*)<\/td>/g)].map((m) => m[1]);
    assert.equal(rows.length, 16);
    assert.ok(rows.every((w) => /^(PID profile [1-6]|PID profile unknown|All PID profiles)( · \w+)?$/.test(w)), rows.join(' | '));
    assert.ok(rows.includes('PID profile unknown') && rows.includes('PID profile 3'), 'the arming profile G3 and G2 of PID profile 3');
    app.tab('recs');
    const all = app.pane('recs');
    assert.match(all, /<div class="tuning-rec-title">Increase the yaw collective precompensation &lt;b&gt;!&lt;\/b&gt;<\/div><div class="tuning-muted">Tail · PID profile 1 · Measured<\/div>/);
    assert.match(all, /<div class="tuning-rec-title">Monitor the governor I-term oscillation<\/div><div class="tuning-muted">Governor · All PID profiles · Measured<\/div>/);
    assert.match(all, /<div class="tuning-rec-title">Examine the roll oscillation<\/div><div class="tuning-muted">Cyclic · PID profile 1 · Measured<\/div>/, 'without a profile field: the PID profile of its evidence rows');
    assert.match(all, /Examine the tail center trim\nof PID profile 1<\/div><div class="tuning-muted">Tail · PID profile unknown · Measured<\/div>/, 'a PID profile parameter with no profile: unknown');
    noRawMarkup(app);
    assert.deepEqual(app.errors, []);
    // one PID profile only: no selector; a stale choice falls back to all PID profiles with a new result
    const one = analysed({ result: synthResult({ findings: synthResult().findings.filter((f) => f.profile === 1), records: [Object.assign(synthResult().records[0], { profileSeconds: { 1: 250 } })],
        advice: { recommendations: [], coverage: synthResult().advice.coverage, notes: [] } }) });
    assert.ok(!one.pane('overview').includes('tuning-profile-bar'));
    const I = app.internals;
    assert.deepEqual([I.profileNo({ profile: 'arm' }), I.profileNo({ profile: '2' }), I.profileNo({ id: 'D4', profile: 3 }), I.profileNo({ scope: 'profile', cliProfile: null, evidence: [] }),
        I.profileNo({ scope: 'profile', cliProfile: 4, evidence: [{ profile: 1 }] }), I.profileNo({ scope: 'global', evidence: [{ profile: 1 }] }), I.profileNo({ evidence: [{ profile: 1 }, { profile: 2 }] })],
    [0, 2, 4, 0, 5, null, null]);
    // a recommendation on several PID profiles: all of them, and in the list of each
    const multi = { severity: 'check', scope: null, profile: null, evidence: [{ id: 'T14', profile: 2 }, { id: 'T14', profile: 1 }, { id: 'T14', profile: 0 }] };
    assert.equal(I.profileText(multi), 'PID profiles 1 and 2, PID profile unknown');
    assert.deepEqual([1, 2, 3, 0].map((p) => I.inProfile(multi, p)), [true, true, false, true]);
    assert.equal(I.profileText({ severity: 'action', scope: 'global', parameter: 'gov_p_gain', profile: null, evidence: [{ profile: 1 }] }), 'All PID profiles');
    assert.equal(I.profileText({ severity: 'action', scope: 'rateprofile', rateProfile: 3, cliProfile: 2 }), 'rate profile 3');
    assert.equal(I.profileNo({ id: 'C12', profile: 0, pidProfile: 2 }), 2, 'the worker\'s pidProfile: the arming profile that it found');
    // the upstream results of a K rule in a few words: one item for each check and axis (Rule 6.3: 25 words or less)
    const up = [1, 2, 3].map((p) => ({ id: 'T8', profile: p, log: 0 })).concat([{ id: 'T13', profile: 1, log: 0 }, { id: 'T13', profile: 0, log: 4 }]);
    assert.equal(I.upstreamText(up, false), 'T8 yaw (PID profiles 1, 2 and 3), T13 yaw (PID profile 1, PID profile unknown)');
    assert.equal(I.upstreamText(up, true), 'T8 yaw (PID profiles 1, 2 and 3, log 1), T13 yaw (PID profile 1, PID profile unknown, logs 1 and 5)');
    // the coverage rows name their area as the view does, not with the key of advice.cjs
    const cov = analysed({ result: synthResult({ advice: Object.assign(synthResult().advice, { coverage: [{ area: 'logging', group: 'Log rate', status: 'checked', checks: ['D1'], parameters: [], detail: 'D1 measured it.' },
        { area: 'precondition', status: 'checked', checks: ['D3'], parameters: [], detail: 'D3 measured it.' }] }) }) });
    cov.tab('coverage');
    assert.match(cov.pane('coverage'), /<td>Log rate<div class="tuning-muted">Log<\/div><\/td>/);
    assert.match(cov.pane('coverage'), /<tr><td>Data<\/td>/);
});

test('an unknown PID profile: no CLI text, and not in the CLI file', () => {
    const result = synthResult(), rec = result.advice.recommendations.find((r) => r.id === 'T7:yaw_collective_ff_gain:p1');
    Object.assign(rec, { cliProfile: null, profile: 0 });
    const app = analysed({ result });
    app.tab('recs');
    assert.match(app.pane('recs'), /Increase the yaw collective precompensation &lt;b&gt;!&lt;\/b&gt;<\/div><div class="tuning-muted">Tail · PID profile unknown · Measured<\/div>[\s\S]*?The PID profile of this recommendation is unknown\. Thus, it has no CLI text\./);
    assert.ok(!app.pane('recs').includes('set yaw_collective_ff_gain = 72'), 'its CLI text is not shown');
    app.tab('export');
    assert.match(app.pane('export'), /<input type="checkbox" class="tuning-pick" data-pick="2" disabled>/);
});

// The derive worker answers the export request with `text` (advice.cjs exportScript, SPEC2 D11)
function answerExport(app, text) {
    const w = app.deriveWorker(), q = w.sent.filter((s) => s.msg.cmd === 'export').at(-1).msg;
    w.onmessage({ data: { id: q.id, type: 'exported', result: text } });
    return q;
}

test('CLI file: the changes with CLI text are selected, advice exportScript in the derive worker, copy and save; nothing goes to the flight controller', async () => {
    const app = analysed();
    app.tab('export');
    let x = app.pane('export');
    // WARNING and NOTE in STE: a backup with diff all first, the app sends nothing
    assert.match(x, /<strong>WARNING:<\/strong> Before you paste these commands, save the output of <code>diff all<\/code> in a file\. If a change is incorrect, you can then set the previous values again\./);
    assert.match(x, /<strong>NOTE:<\/strong> This app does not send data to the flight controller\. You paste the commands in the CLI tab of the Rotorflight Configurator\./);
    // the selection: changes with CLI text; a blocked change, a check, an item to monitor and an item for information cannot be selected
    const boxes = [...x.matchAll(/<input type="checkbox" class="tuning-pick" data-pick="(\d)"( checked)?( disabled)?>/g)].map((m) => [+m[1], m[2] ? 'on' : m[3] ? 'off' : 'free']);
    assert.deepEqual(boxes, [[0, 'off'], [1, 'off'], [2, 'on'], [3, 'off'], [4, 'on'], [5, 'off'], [6, 'off'], [7, 'off'], [8, 'off']]);
    assert.match(x, /2 recommendations of 9 selected\./);
    assert.match(x, /Increase the roll P gain<\/label><div class="tuning-muted">PID profile 1\. Cyclic\. <span class="tuning-param" title="roll_p_gain">Roll P<\/span> 50 to 60 \(increase\)\. This recommendation has no CLI text\. First, correct the steps in the &quot;Blocked&quot; list\./);
    assert.match(x, /Increase the yaw collective precompensation &lt;b&gt;!&lt;\/b&gt;<\/label>/, 'titles escaped');
    assert.match(x, /Wait while the app makes the commands\./);
    assert.match(x, /<button type="button" class="btn btn-primary btn-sm tuning-export-copy" data-label="Copy commands" disabled>Copy commands<\/button>/);
    // the request: all recommendations, the ids of the selected ones, the meta of the analysis
    await tick();
    const q = answerExport(app, '# Rotorflight CLI <b>\nprofile 0\nset yaw_collective_ff_gain = 72\nset pitch_f_gain = 80\nsave');
    assert.deepEqual(plain(q.picks), ['T7:yaw_collective_ff_gain:p1', 'C7:pitch_f_gain:p1']);
    assert.equal(q.recs.length, 9);
    assert.deepEqual(plain(q.meta), { craft: HOSTILE, file: '<i>flight</i>.bbl', logs: ['2'], flights: null, firmware: 'Rotorflight 4.6.0 (118e912) STM32F7X2', profiles: [1, 2, 3],
        date: q.meta.date, logBase: 1, activeProfile: null, activeRateProfile: null }, 'advice.cjs exportScript meta: the log numbers of the log viewer');
    assert.match(q.meta.date, /^\d{4}-\d\d-\d\d$/, 'the local date of the analysis');
    await tick();
    x = app.html('.tuning-export-preview');
    assert.match(x, /<pre class="tuning-export-text"># Rotorflight CLI &lt;b&gt;\nprofile 0\nset yaw_collective_ff_gain = 72\nset pitch_f_gain = 80\nsave<\/pre>/, 'the script, escaped, in code font');
    assert.match(x, /tuning-export-copy" data-label="Copy commands">Copy commands<\/button><button type="button" class="btn btn-default btn-sm tuning-export-save" title="Save the commands as a text file">Save CLI file<\/button>/);
    const copied = app.jq.fire('click', '.tuning-export-copy', { 'data-label': 'Copy commands' });
    await tick();
    assert.equal(app.copied.at(-1), '# Rotorflight CLI <b>\nprofile 0\nset yaw_collective_ff_gain = 72\nset pitch_f_gain = 80\nsave');
    assert.equal(copied.el.textContent, 'Copy commands', 'the label comes back');
    app.jq.fire('click', '.tuning-export-save');
    await tick();
    assert.deepEqual(plain(app.saved.at(-1).options), { suggestedName: 'flight-log2-cli.txt', description: 'CLI commands', mimeType: 'text/plain', extension: '.txt' });
    assert.equal(app.saved.at(-1).text, '# Rotorflight CLI <b>\nprofile 0\nset yaw_collective_ff_gain = 72\nset pitch_f_gain = 80\nsave');
    // a new selection: a new request; the answer of an old request is not used
    app.jq.fire('change', '.tuning-pick', { 'data-pick': 4 }, { checked: false });
    assert.match(app.pane('export'), /1 recommendation of 9 selected\./);
    await tick();
    const w = app.deriveWorker(), stale = w.sent.filter((s) => s.msg.cmd === 'export').at(-1).msg;
    assert.deepEqual(plain(stale.picks), ['T7:yaw_collective_ff_gain:p1']);
    app.jq.fire('change', '.tuning-pick', { 'data-pick': 4 }, { checked: true });
    await tick();
    assert.deepEqual(plain(w.sent.filter((s) => s.msg.cmd === 'export').at(-1).msg.picks), ['T7:yaw_collective_ff_gain:p1', 'C7:pitch_f_gain:p1'], 'the two again');
    w.onmessage({ data: { id: stale.id, type: 'exported', result: 'old' } });
    await tick();
    assert.ok(!app.html('.tuning-export-preview').includes('>old<'), 'the answer of an old selection is not used');
    assert.match(app.pane('export'), /Wait while the app makes the commands\./, 'the pane of the new selection waits for its own answer');
    answerExport(app, 'new');
    await tick();
    assert.match(app.html('.tuning-export-preview'), /<pre class="tuning-export-text">new<\/pre>/);
    // nothing selected: no request; an error of the worker: why, as quoted text
    app.jq.fire('change', '.tuning-pick', { 'data-pick': 2 }, { checked: false });
    app.jq.fire('change', '.tuning-pick', { 'data-pick': 4 }, { checked: false });
    assert.match(app.pane('export'), /You did not select a recommendation\. Select one or more changes\./);
    assert.match(app.pane('export'), /tuning-export-save" [^>]*disabled>Save CLI file/);
    app.jq.fire('change', '.tuning-pick', { 'data-pick': 2 }, { checked: true });
    await tick();
    const e = w.sent.filter((s) => s.msg.cmd === 'export').at(-1).msg;
    w.onmessage({ data: { id: e.id, type: 'error', message: 'unknown command <i>export</i>' } });
    await tick();
    assert.match(app.html('.tuning-export-preview'), /The CLI file is not available: <span data-ste="quoted">unknown command &lt;i&gt;export&lt;\/i&gt;<\/span>/);
    // an answer that is not a text
    app.jq.fire('change', '.tuning-pick', { 'data-pick': 4 }, { checked: true });
    await tick();
    answerExport(app, { lines: ['save'] });
    await tick();
    assert.match(app.html('.tuning-export-preview'), /The CLI file is not available: <span data-ste="quoted">the answer of the worker has no text<\/span>/);
    noRawMarkup(app);
    assert.deepEqual(app.errors, []);
    assert.equal(app.workers.filter((v) => v.sent.length && v.sent[0].msg.cmd === 'init').length, 1, 'one derive worker for the view');
});

test('CLI file with advice.cjs exportScript, when the toolkit has it', { skip: typeof advice.exportScript !== 'function' && 'advice.cjs has no exportScript yet' }, async () => {
    const app = analysed();
    app.tab('export');
    await tick();
    const w = app.deriveWorker(), q = w.sent.find((s) => s.msg.cmd === 'export').msg;
    const text = advice.exportScript(plain(q.recs), plain(q.picks), plain(q.meta));
    assert.equal(typeof text, 'string');
    assert.match(text, /^# /, 'comment lines open the script');
    // the meta of the view (the labels are advice.cjs's): the file, the log number of the viewer, firmware, PID profiles, date
    for (const re of [/^# [^\n]*: "<i>flight<\/i>\.bbl"$/m, /^# [^\n]*: 2$/m, /^# [^\n]*: "Rotorflight 4\.6\.0 \(118e912\) STM32F7X2"$/m,
        /^# [^\n]*: PID profile 1, PID profile 2 and PID profile 3$/m, /^# [^\n]*: \d{4}-\d\d-\d\d$/m]) assert.match(text, re);
    assert.match(text, /\nprofile 0\nset yaw_collective_ff_gain = 72\nset pitch_f_gain = 80\n/, 'the two changes that the view selects, in PID profile 1');
    assert.ok(!/roll_p_gain/.test(text.replace(/^#.*$/gm, '')), 'no command for a blocked change');
    assert.match(text, /\nsave$/, 'the last command is save');
    w.onmessage({ data: { id: q.id, type: 'exported', result: text } });
    await tick();
    assert.ok(app.html('.tuning-export-preview').includes(app.internals.esc(text)));
    // the evidence rows of the file name the logs as the log viewer does (logBase 1)
    assert.match(text, /check T7 \(log 2, PID profile 1\)/);
});

test('flights and phases of each log in the context bar; a bench run is "Bench run (no analysis)" as in the Analysis view (SPEC2 D13, V7)', () => {
    const rec = Object.assign(synthResult().records[0], {
        phases: [{ phase: 'idle', t0: 0, t1: 5 }, { phase: 'spoolup', t0: 5, t1: 11.1 }, { phase: 'ground', t0: 11.1, t1: 14.3 }, { phase: 'flight', t0: 14.3, t1: 87 },
            { phase: 'ground', t0: 87, t1: 90 }, { phase: 'spooldown', t0: 90, t1: 94 }],
        flights: [{ t0: 14.3, t1: 87, seconds: 72.7, method: 'airborne', confidence: 0.9 }, { t0: 120.25, t1: 150, method: 'data' }] });
    const app = analysed({ result: synthResult({ records: [rec] }) }), asked = [];
    app.hooks.viewInLog = (req) => { asked.push(plain(req)); return true; };
    const ctx = app.html('.tuning-context');
    assert.match(ctx, /<div>Flights: <a href="#" class="tuning-flight" data-log="1" data-t0="14\.3" data-t1="87" data-title="Flight 1, log 2" title="Show this flight in the log">14\.3 s to 87 s<\/a>, <a [^>]*data-t0="120\.25"[^>]*>120\.3 s to 150 s<\/a><\/div>/);
    assert.match(ctx, /<div>Phases: idle 5\.0 s · spool-up 6\.1 s · on the ground 6\.2 s · flight 72\.7 s · spool-down 4\.0 s<\/div>/);
    app.jq.fire('click', '.tuning-flight', { 'data-log': 1, 'data-t0': 14.3, 'data-t1': 87, 'data-title': 'Flight 1, log 2' });
    app.jq.fire('click', '[data-tuning-log-act="viewer"]');
    assert.deepEqual(asked[0], { log: 1, fromS: 14.3, toS: 87, atS: 50.65, graphs: null, analyser: null, title: 'Flight 1, log 2', text: '' }, 'frame seconds; the pilot\'s own graphs');
    // a bench run: the label of the Analysis view and of docs/STE_GLOSSARY.md (CLAUDE.md "Flights, phases and bench runs")
    const bench = analysed({ result: synthResult({ records: [Object.assign(synthResult().records[0], { logClass: 'bench', phases: [], flights: [] })] }) });
    assert.match(bench.html('.tuning-context'), /<div>Log 2: Bench run \(no analysis\)<\/div>/);
    const glossary = fs.readFileSync(path.join(ROOT, 'docs/STE_GLOSSARY.md'), 'utf8'), lens = read('js/log_lens.js') + read('js/analysis_view.js');
    assert.ok(glossary.includes('| Bench run (no analysis) |') && read('js/analysis_view.js').includes('bench: "Bench run (no analysis)"'), 'the same label in the glossary and the Analysis view');
    // all logs: "N flights in M logs", the bench runs, a line for each log (result.flights and result.benchRuns)
    const file = analysed({ result: synthResult({ scope: 'file', logs: [0, 1, 2], logIndex: 1, benchRuns: [0, { log: 2, reason: 'no AIRBORNE_STATE' }],
        flights: [{ log: 1, t0: 14.3, t1: 87, seconds: 72.7 }, { log: 1, t0: 100, t1: 130 }], records: [rec] }) });
    const fctx = file.html('.tuning-context');
    assert.match(fctx, /<details class="tuning-flights"><summary>2 flights in 1 log\. 2 bench runs \(no analysis\)\.<\/summary><ul><li>Log 1: Bench run \(no analysis\)<\/li><li>Log 2: 2 flights \(<a [^>]*>14\.3 s to 87 s<\/a>, <a [^>]*>100 s to 130 s<\/a>\)\. Phases: idle 5\.0 s · spool-up 6\.1 s · on the ground 6\.2 s · flight 72\.7 s · spool-down 4\.0 s\.<\/li><li>Log 3: Bench run \(no analysis\)<\/li>/);
    const one = analysed({ result: synthResult({ scope: 'file', logs: [0, 1], logIndex: 1, benchRuns: [0], flights: [{ log: 1, t0: 14.3, t1: 87 }], records: [rec] }) });
    assert.match(one.html('.tuning-context'), /<summary>1 flight in 1 log\. 1 bench run \(no analysis\)\.<\/summary>/, 'one bench run');
    for (const a of [bench, file, one]) assert.ok(!/test on the ground|tests on the ground/.test(a.allHtml()), 'no other words for a bench run');
    assert.ok(!/test on the ground/.test(lens), 'the lens and the verdict have the same label');
    // a finding carries its phase
    assert.equal(app.internals.findingWhere({ id: 'G15', profile: 1, phase: 'spoolup' }, ' · '), 'PID profile 1 · spool-up');
    // a result without these fields: the context bar as before
    const old = analysed();
    assert.ok(!/Flights?:|tuning-flights|Phases:/.test(old.html('.tuning-context')));
    for (const a of [app, bench, file]) { noRawMarkup(a); assert.deepEqual(a.errors, []); }
    // the CLI file meta has the flights and the tests on the ground, in one line
    const meta = file.internals.exportMeta({ result: file.result, finishedAt: 0, cliName: null });
    assert.equal(meta.flights, 'Log 1: Bench run (no analysis). Log 2: 14.3 s to 87 s, 100 s to 130 s. Log 3: Bench run (no analysis).');
    assert.deepEqual(plain(meta.logs), ['1', '2', '3']);
});

test('plot specs follow the TuningPlot contract and time plots seek the viewer', () => {
    const app = analysed();
    app.tab('curves');
    const specs = app.plots.map((p) => p.spec);
    for (const s of specs) {
        assert.equal(typeof s.title, 'string');
        assert.equal(s.height, undefined, s.title + ': the height is the stylesheet\'s, sized to the window');
        assert.ok(s.x && s.y && Array.isArray(s.series) && s.series.length, s.title);
        for (const ser of s.series) assert.ok(ser.y.length > 1 && ser.x.length === ser.y.length && typeof ser.color === 'string', s.title + ' / ' + ser.name);
    }
    const track = specs.find((s) => /^Tracking error, roll/.test(s.title));
    assert.equal(track.series.length, 3);
    assert.deepEqual(Array.from(track.series, (q) => q.name), ['setpoint', 'error, less than 30 Hz', 'error without the time delay, less than 30 Hz (time delay 26 ms)'], 'the error as C12 has it, low-passed at lpHz');
    assert.ok(track.bands.length >= 2 && track.bands.every((b) => b.x1 > b.x0), 'unusable spans shaded');
    assert.deepEqual(Array.from(track.markers, (m) => m.x).sort((a, b) => a - b), [45, 80, 100.2], 'roll finding times as markers');
    const spectrum = specs.find((s) => /^Error spectrum and gain from setpoint to gyro/.test(s.title));
    assert.equal(spectrum.x.log, true);
    assert.ok(spectrum.x.min > 0);
    assert.equal(JSON.stringify(spectrum.bands.map((b) => [b.x0, b.x1])), '[[10,20]]');
    const phase = specs.find((s) => /^Phase/.test(s.title)), delay = phase.series.find((q) => /^time delay/.test(q.name));
    assert.ok(Math.abs(delay.y[10] - -360 * delay.x[10] * 0.026) < 1e-9, 'time delay line −360 f τ');
    // T is drawn as measured only where its random error sqrt(1 - coh) / sqrt(2 n coh) is under 20 % (coh 0.8 below, 0.02 above m / 2)
    const half = (q) => [Array.from(q.y).slice(0, q.y.length / 2 - 1).every(Number.isFinite), Array.from(q.y).slice(q.y.length / 2 + 1).every(Number.isNaN)];
    const named = (sp, re) => sp.series.find((q) => re.test(q.name));
    assert.deepEqual(half(named(spectrum, /^gain from setpoint to gyro \(SE less than 20 %\)$/)), [true, true], '|T| masked where its SE is too large');
    assert.deepEqual(half(named(phase, /^phase of T \(SE less than 20 %\)$/)), [true, true], 'phase masked likewise');
    assert.ok(Array.from(named(spectrum, /^gain, SE too large$/).y).every(Number.isFinite), 'the faint series keeps every bin');
    assert.ok(phase.y.min % 90 === 0 && phase.y.max % 90 === 0 && phase.y.min < 0, 'phase axis from the measured bins, in 90 deg steps');
    const osc = specs.find((s) => /^Oscillation amplitude, 10-20 Hz, roll$/.test(s.title));
    assert.equal(osc.hlines.map((h) => h.y).join(), '10,20,40');
    assert.equal(osc.series[0].name, '√2 × RMS of the error in the band, in 0.5 s (filter gain in the band 0.47-0.64)', 'the scale of C5 and T1');
    const byErr = specs.find((s) => /^Mean error for each setpoint range, roll/.test(s.title));
    assert.deepEqual(Array.from(byErr.series, (q) => q.name), ['mean error, less than 30 Hz', 'without the time delay, less than 30 Hz']);

    app.tab('governor');
    app.detail('governor:signals');
    const hs = app.plots.map((p) => p.spec).find((s) => /^Headspeed, governor target and governor condition/.test(s.title));
    assert.equal(hs.bands.map((b) => b.label).filter(Boolean).join(), 'SPOOLUP', 'non-ACTIVE states shaded, long runs labelled');
    assert.equal(hs.bands.length, 2, 'SPOOLUP and AUTOROTATION');
    assert.equal(hs.vlines.map((v) => v.label).join(), 'PID profile 2', 'profile switch');
    let at = app.plots.length;
    app.tab('filters');
    // the spectra of the profile flown longest (P1, 200 s), with its rotor harmonics and its notches; filter lines first
    const recorded = (axis, profile) => app.internals.vibPlots(app.result.curves[0],axis,app.result,{}, {vibProfile:profile}).map(p=>p.spec);
    const raw = recorded('roll').find((s) => /^Gyro spectrum before and after the filters, roll, PID profile 1 \(30 windows\)\. Rotor harmonics at 38\.3 Hz$/.test(s.title));
    assert.ok(raw, 'the profile flown longest');
    assert.equal(raw.vlines.map((v) => v.label).join(', '), 'main rotor 2× <b> Q8, LPF1 150 Hz, 1×, 2×, 3×, 4×, 5×, 6×, 7×, 8×', 'notches of unknown frequency left out; filter lines take the label rows first');
    assert.ok(Math.abs(raw.vlines.find((v) => v.label === '3×').x - 3 * 38.3) < 1e-9 && raw.vlines[0].x === 76.6);
    assert.ok(raw.series[0].y === app.result.curves[0].more.vib.byProfile[1].roll.raw, 'P1\'s own spectrum');
    assert.match(app.internals.vibToolbar(app.result.curves[0],app.result,{}), /<select class="form-control input-sm tuning-vib-profile"[^>]*><option value="all">All PID profiles \(weight: time in each\)<\/option><option value="1" selected>PID profile 1, 2298 rpm, 30 windows \(75 %\), longest flight time<\/option><option value="2">PID profile 2, 2502 rpm, 8 windows \(20 %\)<\/option><\/select>/);
    assert.equal(recorded('roll')[1].title, 'Filter transmission (gyroADC / gyroRAW), roll, PID profile 1 (30 windows)');
    at = app.plots.length;
    app.jq.fire('change', '.tuning-vib-profile', {}, { value: 'all' });
    const pooled = recorded('roll','all')[0];
    assert.equal(pooled.title, 'Gyro spectrum before and after the filters, roll, all PID profiles (weight: time in each). Rotor harmonics of PID profile 1 at 38.3 Hz', 'pooled: harmonics of the profile flown longest');
    assert.ok(pooled.series[0].y === app.result.curves[0].more.vib.roll.raw && pooled.vlines[0].x === 76.6, 'the pooled spectrum, notches at the median headspeed');
    at = app.plots.length;
    app.jq.fire('change', '.tuning-vib-profile', {}, { value: '2' });
    const p2 = recorded('roll','2')[0];
    assert.equal(p2.title, 'Gyro spectrum before and after the filters, roll, PID profile 2 (8 windows). Rotor harmonics at 41.7 Hz');
    assert.ok(Math.abs(p2.vlines[0].x - 83.4) < 1e-9 && Math.abs(p2.vlines.find((v) => v.label === '2×').x - 83.4) < 1e-9, 'P2\'s notch and harmonics at its own headspeed');
    app.jq.fire('click', '.tuning-axis', { 'data-axis': 'yaw' });
    assert.match(recorded('yaw','2')[0].title, /^Gyro spectrum before and after the filters, yaw, PID profile 2 \(8 windows\)/, 'the choice holds across axes');
    app.jq.fire('change', '.tuning-vib-profile', {}, { value: '1' });
    app.jq.fire('click', '.tuning-axis', { 'data-axis': 'roll' });
    const err = app.plots.map((p) => p.spec).find((s) => /^Headspeed error from govTarget$/.test(s.title));
    assert.deepEqual([err.y.min, err.y.max], [-3, 3], 'scaled to flight, not to the spool-up spike');
    assert.equal(raw.y.log, true);
    assert.equal(JSON.stringify(raw.bands.map((b) => [b.x0, b.x1])), '[[80,400]]');
    app.tab('tail');
    app.detail('tail:signals');
    const tail = app.plots.map((p) => p.spec).find((s) => /^Tail output and the tail output limits/.test(s.title));
    assert.equal(tail.hlines.map((h) => h.y).join(), '-400,400');
    assert.equal(tail.series[0].lo.length, 3000);
    assert.equal(tail.series[0].y[0], -20, 'the mean in each 0.1 s');

    track.onClick(12.5);
    assert.deepEqual(app.calls.selectLog, [], 'already on log 1');
    assert.deepEqual(app.calls.seek, [app.flightLog.getMinTime(1) + 12.5e6]);
    // a finding time on another log selects that log first
    app.jq.fire('click', '.tuning-seek', { 'data-log': 2, 'data-t': 3.5 });
    assert.deepEqual(app.calls.selectLog, [2]);
    assert.equal(app.calls.seek.at(-1), app.flightLog.getMinTime(2) + 3.5e6);
    // a log of the file that does not parse is not sought: FlightLog.getMinTime would throw on it
    app.flightLog.getLogError = (i) => (i === 0 ? 'Log truncated' : false);
    app.jq.fire('click', '.tuning-seek', { 'data-log': 0, 'data-t': 1 });
    assert.equal(app.calls.seek.length, 2);
    assert.deepEqual(app.errors, []);

    // plots need a laid-out canvas: with the view hidden (js/main.js showView calls hide()) they wait for show()
    const later = analysed();
    later.dialog.hide();
    later.tab('curves');
    assert.equal(later.plots.length, 0);
    later.show();
    assert.equal(later.plots.length, 5);
});

test('a tail check without an axis marks and lists the yaw curves only', () => {
    // T14 (yaw at headspeed ramps) has no axis field, as T4 to T8 and T13
    const t14 = { module: 'more', id: 'T14', severity: 'flag', log: 1, profile: null, value: 31.2, se: 4.1, n: 9, unit: 'deg/s',
        threshold: '>= 3 events, >= 80 % one sign, |mean| - 2 SE > 20 deg/s', source: 'pipeline, unvalidated', text: 'peak yaw at the ramps', times: [50, 150] };
    const app = analysed({ result: synthResult({ findings: synthResult().findings.concat([t14]) }) });
    app.tab('curves');
    const seen = {};
    for (const axis of ['roll', 'pitch', 'yaw']) {
        const before = app.plots.length;
        app.jq.fire('click', '.tuning-axis', { 'data-axis': axis });
        const track = app.plots.slice(before).map((p) => p.spec).find((s) => s.title === `Tracking error, ${axis}: RMS in each 0.1 s`);
        seen[axis] = { markers: Array.from(track.markers, (m) => `${m.label} ${m.x}`).sort(), listed: /<td class="tuning-id">T14</.test(app.pane('curves')) };
    }
    assert.deepEqual(seen.roll, { markers: ['C12 Monitor 100.2', 'C5 Problem 45', 'C5 Problem 80'], listed: false }, 'roll as without T14');
    assert.deepEqual(seen.pitch, { markers: [], listed: false });
    assert.deepEqual(seen.yaw, { markers: ['T14 Problem 150', 'T14 Problem 50'], listed: true }, 'the markers on the yaw plot and their check below it');
    app.tab('tail');
    app.detail('tail:signals');
    const tail = app.plots.map((p) => p.spec).find((s) => /^Tail output and the tail output limits/.test(s.title));
    assert.deepEqual(Array.from(tail.markers, (m) => m.x), [50, 150], 'the tail tab marks every tail check');
    const I = app.internals;
    assert.deepEqual([I.findingAxis({ id: 'T8' }), I.findingAxis({ id: 'C2' }), I.findingAxis({ id: 'C5', axis: 'pitch' })], ['yaw', null, 'pitch']);
});

test('a flag the advice explains (all its recommendations information) is report-only, with the reason', () => {
    const result = synthResult(), f5 = result.findings.find((f) => f.id === 'F5');
    f5.explained = 'The filters remove this vibration line.';
    const app = analysed({ result });
    app.tab('checks');
    assert.match(app.pane('checks'), /<span class="tuning-badge st-information" title="Information only: The filters remove this vibration line\.">Information<\/span>/);
    assert.match(app.pane('checks'), /<div class="tuning-muted">Information only: <span data-ste="quoted">The filters remove this vibration line\.<\/span><\/div>/);
    app.tab('overview');
    const block = app.pane('overview').split('data-node="filters"')[1].split('</li>')[0];
    assert.doesNotMatch(block, /tuning-block-ids">F5/, 'the explained flag is not listed as a problem');
    assert.match(app.pane('overview'), /Information: <span class="tuning-block-check">F5<\/span>/, 'the step keeps the explained flag as information');
    const alone = synthResult({ findings: [Object.assign({}, f5)] }), one = analysed({ result: alone });
    assert.match(one.pane('overview'), /<div class="tuning-muted">Information 1<\/div>/, 'an explained flag alone contributes no problem to the summary');
});

test('missing curves say why, the toolkit report and the 250 Hz warning are shown', () => {
    const curves = synthCurves(1);
    curves[0].more = { gov: null, vib: null, dterm: null, control: null, tail: null };
    delete curves[0].track.yaw;
    const app = analysed({ result: synthResult({ curves, fields: { 'gyroRAW[0]': 'absent', headspeed: 'zero', 'axisD[0]': 'present' },
        records: [Object.assign(synthResult().records[0], { rate: 250, actualRate: 253.2 })] }) });
    app.tab('governor');
    assert.match(app.pane('governor'), /Not available: all values of headspeed in the log are 0/);
    app.tab('filters');
    assert.match(app.internals.vibPlots(curves[0],'roll',app.result,{},{} )[0].na, /gyroRAW\[0\] is not in the log/);
    app.tab('curves');
    app.jq.fire('click', '.tuning-axis', { 'data-axis': 'yaw' });
    assert.match(app.pane('curves'), /Not available: the result has no yaw curves/);
    assert.match(app.html('.tuning-notices'), /The log rate is 250 Hz\. The Nyquist frequency is 125 Hz\. If the log rate is less than 1 kHz, the log does not show the rotor and tail harmonics correctly\./);

    const none = analysed({ result: synthResult({ curves: null, advice: null, hierarchy: null, notes: ['The app cannot load "health_more.cjs".'] }) });
    for (const key of ['curves', 'governor', 'tail']) {
        none.tab(key);
        assert.match(none.pane(key), /Not available: /, key);
    }
    none.tab('governor');
    assert.match(none.pane('governor'), /Not available: The app cannot load &quot;health_more\.cjs&quot;\./, 'the worker note');
    none.tab('recs');
    assert.match(none.pane('recs'), /The recommendations are not available/);
    none.tab('coverage');
    assert.match(none.pane('coverage'), /The parameter groups are not available/);
    none.tab('overview');
    assert.match(none.pane('overview'), /This result has no data for the tuning sequence\./, 'a result without result.hierarchy');
    assert.match(none.pane('overview'), /The recommendations are not available/, 'missing advice remains explicit in the summary');
    assert.deepEqual(none.errors, []);

    // gyroRAW not logged: health_more gives the filtered spectrum only
    const only = synthCurves(1), vib = only[0].more.vib;
    vib.filtOnly = true;
    for (const a of ['roll', 'pitch', 'yaw']) for (const q of [vib, ...Object.values(vib.byProfile)]) q[a] = Object.assign({}, q[a], { raw: null, pass: null }); // per profile too, as health_more gives it
    const filt = analysed({ result: synthResult({ curves: only, fields: { 'gyroRAW[0]': 'absent' } }) });
    filt.tab('filters');
    const recorded = filt.internals.vibPlots(only[0],'roll',filt.result,{},{});
    const spec = recorded.map((p) => p.spec).filter(Boolean).find((x) => /^Gyro spectrum after the filters only \(gyroRAW is not in the log\), roll/.test(x.title));
    assert.equal(spec.series.length, 1);
    assert.match(recorded[1].na,/gyroRAW\[0\] is not in the log/);

    const before = setup({ sysConfig: { looptime: 500, frameIntervalPDenom: 4, pid_process_denom: 2 } });
    before.show();
    assert.match(before.html('.tuning-notices'), /The log rate is 250 Hz/);
});

test('worker errors, cancel, bad input and no log are reported, escaped', () => {
    const app = setup();
    app.show();
    app.workers[0].reply({ type: 'error', message: '<script>bad()</script>', stack: 'at <anonymous>' });
    assert.equal(app.workers[0].terminated, true);
    assert.match(app.html('.tuning-notices'), /The analysis stopped because of an error\.<\/strong> <span data-ste="quoted">&lt;script&gt;bad\(\)&lt;\/script&gt;<\/span>/);
    assert.match(app.html('.tuning-notices'), /<details><summary>More information<\/summary><pre class="tuning-stack">at &lt;anonymous&gt;/);
    app.show();
    assert.equal(app.workers.length, 1, 'a failed run is not repeated on reopening');

    app.jq.fire('click', '.tuning-analyse');
    assert.equal(app.workers.length, 2);
    app.jq.fire('click', '.tuning-cancel');
    assert.equal(app.workers[1].terminated, true);
    assert.match(app.jq.node('.tuning-progress-text').text, /^Canceled after 0:00$/);
    app.workers[1].reply({ type: 'result', result: synthResult() });
    assert.equal(app.pane('overview'), '', 'a canceled run is ignored');
    app.show();
    assert.equal(app.workers.length, 2, 'a canceled run is not started again on reopening');

    // no log open: main.js has no FlightLog yet, or a host without getFlightLog passes none to show()
    const none = setup();
    none.load(null, null, null);
    none.show();
    const bare = setup({ liveHook: false });
    bare.dialog.show(null);
    for (const empty of [none, bare]) {
        assert.match(empty.html('.tuning-notices'), /Open a blackbox log in the log viewer\./);
        assert.equal(empty.workers.length, 0);
        assert.equal(empty.jq.node('.tuning-analyse').props.disabled, true);
        noRawMarkup(empty);
    }
});

test('a file dropped while the view is open: log count, labels and seeks follow the viewer\'s FlightLog', async () => {
    const app = analysed(); // file A: 3 logs, log 2 analysed and shown
    // js/main.js window.ondrop -> loadLogFile: new bytes, name and FlightLog, selectLog(null) opens log 1; show() is not called
    const B = fakeLog({ count: 1, current: 0, t0: 5000 });
    app.load(Uint8Array.from({ length: 100 }, (_, i) => (i * 29 + 3) & 0xff), 'B.bbl', B);

    // a time of A's result: a notice, never a seek into B (A's log 2 + 3.5 s clamped into B would land anywhere)
    app.jq.fire('click', '.tuning-seek', { 'data-log': 1, 'data-t': 3.5 });
    app.jq.fire('click', '.tuning-show', { 'data-key': FID.C12 });
    app.jq.fire('click', '[data-tuning-log-act="viewer"]');
    assert.deepEqual(app.calls.seek, []);
    assert.deepEqual(app.jq.modal, [], 'no modal');
    const notices = app.html('.tuning-notices');
    assert.match(notices, /These results are for a different file\. To examine the open file, click "Start analysis"\./);
    assert.doesNotMatch(notices, /The log viewer shows log|are different from this result/, 'log numbers and settings of two files are not compared');
    assert.match(app.html('.tuning-context'), /<div>Log 2 of 3<\/div>/, 'the context bar describes the result on display');
    assert.equal(app.jq.node('.tuning-scope option[value="file"]').text, 'All flights in the file', 'the scope is the open file\'s: no result knows its flights');
    app.jq.fire('click', '.tuning-save');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.saved[0].options.suggestedName, '<i>flight</i>-log2-tuning.md', 'A\'s report is named after A, not after the open file');

    app.jq.fire('click', '.tuning-analyse');
    const { msg } = app.workers[1].sent[0];
    assert.deepEqual([msg.cmd, msg.fileName, msg.logIndex, msg.logCount, msg.bytes.byteLength], ['analyseLog', 'B.bbl', 0, 1, 100]);
    app.workers[1].reply({ type: 'result', result: synthResult({ fileName: 'B.bbl', logIndex: 0, curves: synthCurves(0) }) });
    assert.match(app.pane('overview'), /<div class="tuning-summary"><div>Log 1 of 1: /);
    assert.match(app.html('.tuning-context'), /<div>Log 1 of 1<\/div>/);
    assert.equal(app.html('.tuning-notices'), '');
    app.tab('curves');
    app.plots.map((p) => p.spec).find((s) => /^Tracking error, roll/.test(s.title)).onClick(7.25);
    app.jq.fire('click', '.tuning-seek', { 'data-log': 0, 'data-t': 12.5 });
    assert.deepEqual(app.calls.seek, [5007.25e6, B.getMinTime(0) + 12.5e6], 'B\'s log 1 starts at 5000 s: a plot click and a time link');
    assert.deepEqual(app.calls.selectLog, []);
});

test('results are cached per file, scope, log and CLI dump', async () => {
    const app = analysed();
    app.show();
    assert.equal(app.workers.length, 1, 'reopening shows the cached result');

    // all logs in the file, with a CLI dump and automatic RPM
    app.jq.fire('change', '.tuning-cli-input', {}, { files: [{ name: 'notes.txt', text: 'hello' }] });
    assert.match(app.html('.tuning-notices'), /The file is not a Rotorflight CLI dump \(&quot;diff all&quot; or &quot;dump&quot;\)\. <span data-ste="quoted">notes\.txt<\/span>/);
    const dump = '# diff all\nprofile 0\nset gov_mode = 1\n';
    app.jq.fire('change', '.tuning-cli-input', {}, { files: [{ name: '<b>dump</b>.txt', text: dump }] });
    assert.match(app.html('.tuning-cli-name'), /&lt;b&gt;dump&lt;\/b&gt;\.txt/);
    app.jq.fire('change', '.tuning-scope', {}, { value: 'file' });
    assert.match(app.html('.tuning-notices'), /The logs, the flights or the CLI dump are different from this result\. To use them, click "Start analysis"\./);
    app.jq.fire('click', '.tuning-analyse');
    const { msg } = app.workers[1].sent[0];
    assert.equal(msg.cmd, 'analyseFile');
    assert.equal(msg.bytes.byteLength, 400);
    assert.equal(msg.selectedLog, 1);
    assert.deepEqual(plain(msg.options), { flightRpm: null, cliText: dump, cliName: '<b>dump</b>.txt', excludeAbnormal: true, gains: true });
    app.workers[1].reply({ type: 'result', result: synthResult({ scope: 'file', logs: [0, 1, 2], logIndex: undefined }) });
    assert.match(app.pane('overview'), /All flights in the file \(3 logs\): /);
    app.tab('checks');
    assert.match(app.pane('checks'), /<th class="tuning-sortable" data-sort="log">Log<\/th>/, 'file scope lists the log');

    // back to this log with the old settings: the first result again, no new run
    app.jq.fire('change', '.tuning-scope', {}, { value: 'log' });
    app.jq.fire('click', '.tuning-cli-clear');
    app.tab('overview');
    assert.match(app.pane('overview'), /<div class="tuning-summary"><div>Log 2 of 3: /);
    app.show();
    assert.equal(app.workers.length, 2);

    // another file: the old result is dropped and the new log is analysed
    app.setFile(Uint8Array.from({ length: 400 }, (_, i) => (i * 13) & 0xff), 'other.bbl');
    app.show();
    assert.equal(app.workers.length, 3);
    assert.equal(app.workers[2].sent[0].msg.fileName, 'other.bbl');
    assert.equal(app.pane('overview'), '');
});

// 2026-10-06: a result of "All flights in the file" is of the file. Its key has no log, so another log in the viewer shows the same
// result (with the curves of the log that was on display when it ran, and a notice) and does not start the long run again
test('a file result is cached for the file: another log in the viewer keeps it, and "Start analysis" takes the curves of the log on display', () => {
    const app = analysed(); // log 2, this log
    app.jq.fire('change', '.tuning-scope', {}, { value: 'file' });
    app.jq.fire('click', '.tuning-analyse');
    assert.equal(app.workers[1].sent[0].msg.selectedLog, 1);
    app.workers[1].reply({ type: 'result', result: synthResult({ scope: 'file', logs: [0, 1, 2], logIndex: 1 }) });
    assert.match(app.html('.tuning-context'), /<div>All flights in the file \(3 logs\)<\/div><div>Curves of log 2<\/div>/);
    app.hooks.selectLog(2); // the viewer shows log 3
    app.show();
    assert.equal(app.workers.length, 2, 'the result of the file stays: no new run');
    assert.match(app.html('.tuning-context'), /<div>Curves of log 2<\/div>/);
    assert.match(app.html('.tuning-notices'), /The curves, the log data and the header values of the recommendations are for log 2\. The log viewer shows log 3\. To examine log 3, click &quot;Start analysis&quot;\./);
    // the selected log is a bench run: the worker takes the header of the recommendations from a flight log (headerLog)
    const h = analysed();
    h.jq.fire('change', '.tuning-scope', {}, { value: 'file' });
    h.jq.fire('click', '.tuning-analyse');
    h.workers[1].reply({ type: 'result', result: synthResult({ scope: 'file', logs: [0, 1, 2], logIndex: 1, headerLog: 0 }) });
    assert.match(h.html('.tuning-notices'), /Log 2 is not a flight log\. Thus, the recommendations use the log header of log 1\./);
    h.hooks.selectLog(2);
    h.show();
    assert.match(h.html('.tuning-notices'), /The curves and the log data are for log 2\. The log viewer shows log 3\./);
    // "Start analysis": the file again, with the curves and the header of log 3; the new result replaces the old one
    app.jq.fire('click', '.tuning-analyse');
    assert.equal(app.workers[2].sent[0].msg.selectedLog, 2);
    app.workers[2].reply({ type: 'result', result: synthResult({ scope: 'file', logs: [0, 1, 2], logIndex: 2, curves: synthCurves(2) }) });
    assert.match(app.html('.tuning-context'), /<div>All flights in the file \(3 logs\)<\/div><div>Curves of log 3<\/div>/);
    assert.equal(app.html('.tuning-notices'), '');
    app.hooks.selectLog(1);
    app.show();
    assert.equal(app.workers.length, 3, 'one result for the file');
    assert.match(app.html('.tuning-context'), /<div>Curves of log 3<\/div>/);
    assert.match(app.html('.tuning-notices'), /are for log 3\. The log viewer shows log 2\./);
    // the key: "*" for the log of a file or flights run, the log for "This log"
    assert.deepEqual(app.workers.slice(1).map((w) => w.sent[0].msg.cmd), ['analyseFile', 'analyseFile']);
});

test('filters, sorting, copy and save', async () => {
    const app = analysed();
    app.tab('checks');
    showAllResults(app); // SPEC3 E: the two filters on, so that the list has each result
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    assert.match(app.html('.tuning-checks-table'), /16 of 16 results\./);
    app.jq.fire('change', '.tuning-f-area', {}, { value: 'governor' });
    assert.match(app.html('.tuning-checks-table'), /3 of 16 results\./);
    app.jq.fire('input', '.tuning-f-query', {}, { value: 'G12' });
    assert.match(app.html('.tuning-checks-table'), /1 of 16 results\./);
    app.jq.fire('change', '.tuning-f-area', {}, { value: 'all' });
    app.jq.fire('input', '.tuning-f-query', {}, { value: 'oscillation at 14 Hz' });
    assert.match(app.html('.tuning-checks-table'), /1 of 16 results\./, 'the filter reads the STE summaries too');
    app.jq.fire('input', '.tuning-f-query', {}, { value: '' });
    app.jq.fire('click', 'th[data-sort]', { 'data-sort': 'id' });
    const ids = [...app.html('.tuning-checks-table').matchAll(/<td class="tuning-id">([^<]+)/g)].map((m) => m[1]);
    assert.deepEqual(ids.slice(0, 6), ['C5', 'C12', 'C13', 'D1', 'D2', 'D4'], 'natural id order');
    app.jq.fire('click', 'th[data-sort]', { 'data-sort': 'id' });
    assert.equal([...app.html('.tuning-checks-table').matchAll(/<td class="tuning-id">([^<]+)/g)][0][1], 'T8', 'reversed');

    app.jq.fire('change', '.tuning-f-area', {}, { value: 'tail' });
    assert.match(app.html('.tuning-checks-table'), /1 of 16 results\./);

    app.tab('recs');
    const block = /data-copy="(\d+)">Copy<\/button><pre>profile 0\nset yaw_collective_ff_gain = 72<\/pre>/.exec(app.pane('recs'));
    assert.ok(block, 'CLI block with a Copy button');
    const copied = app.jq.fire('click', '.tuning-copy', { 'data-copy': block[1] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(app.copied, ['profile 0\nset yaw_collective_ff_gain = 72']);
    assert.equal(copied.el.textContent, 'Copy');

    // one CLI file of the selected changes is on the "Export" tab (SPEC2 D11); the report keeps the worker's advice.script
    const script = synthResult().advice.script;
    assert.match(script, /set yaw_collective_ff_gain = 72[\s\S]*set pitch_f_gain = 80[\s\S]*\nsave$/);
    assert.ok(!/CLI script for all changes/.test(app.pane('recs')), 'no second script beside the CLI file');
    assert.match(app.pane('recs'), /After you paste a CLI block, type <code>save<\/code>\. To make one CLI file of the changes that you select, use the &quot;Export&quot; tab\./);

    app.jq.fire('click', '.tuning-goto-rec', { 'data-rec': 2 });
    assert.equal(app.jq.node('.tuning-pane[data-pane="recs"]').classes.has('active'), true);
    assert.equal(app.elements['tuning1-rec-2'].scrolled, 1, 'the card is scrolled into view');

    app.jq.fire('click', '.tuning-save');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.saved.length, 1);
    assert.equal(app.saved[0].options.suggestedName, 'flight-log2-tuning.md');
    const md = app.saved[0].text;
    for (const part of ['# Tuning report', '> **WARNING:** Examine each change before you set it in the flight controller.', '> **NOTE:** This app does not send data to the flight controller.',
        '### 3. Increase the yaw collective precompensation <b>!</b> (Change)', '### 4. Examine the tail center trim of PID profile 1 (Check)', '### 6. Increase the roll P gain (Change, blocked)',
        '### 9. Examine the roll tracking error (Check, possible result)', '- Possible result of: K5 Tracking error. Do first: Correct C5 first. Then fly again.',
        '```\nprofile 0\nset yaw_collective_ff_gain = 72\n```', '## CLI script for all changes\n\n```\n' + script + '\n```', '## Gain analysis',
        '| Problem | F5 | 2 | PID profile 1 | 4.061 (22 values) |', '| Monitor | C12 | 2 | PID profile 1 roll | 0.310 ± 0.030 fraction (12 values) | 0.3 | pipeline, unvalidated | In PID profile 1 the roll tracking error is 31 ± 3 % of the setpoint. | tracking error |',
        '## Before the first flight', '| Item | Condition | Checks with a problem | Checks |', '| Blackbox log | Problem | D1, D2 | D1, D2, D3, D4, H |', '| Power | No data |  | D5, G13, G11 |',
        '## Tuning steps', '| 1 | Filters | Start here | 1 | F5, F1 | gyro_lpf1_type, gyro_lpf1_static_hz,', '| 3a | Cyclic gains | Blocked |  | C5 roll | {pitch,roll}_{d,p,i,f,o,b}_gain |',
        '| 4b | Tail compensation and output range | Start here | 2 | T8 | yaw_collective_ff_gain, yaw_cw_stop_gain, gov_tta_gain |',
        '## Parameter groups', '| Group | Area | Status | Checks | Parameters | Data |', '| Area 0 | Area 0 | Result | C5, C7 | roll_p_gain, pitch_p_gain |', '| Group 1 | Area 1 | Measured | C5, C7 |',
        '## Toolkit report (not STE)', 'The toolkit report.',
        'The log numbers start at 1, as in the log list of the log viewer. Only the toolkit report at the end starts at 0.']) assert.ok(md.includes(part), part);
    assert.deepEqual(app.errors, []);
});

test('formatting: value ± SE to the SE\'s second digit, thresholds, log numbers', () => {
    const { internals: I } = setup();
    assert.equal(I.valueSe(41.1, 11.4596, 'deg/s'), '41 ± 11 deg/s');
    assert.equal(I.valueSe(1.54, 0.38), '1.54 ± 0.38');
    assert.equal(I.valueSe(0.99868, 0.00003), '0.998680 ± 0.000030');
    assert.equal(I.valueSe(161594, null), '161594');
    assert.equal(I.valueSe('Rotorflight 4.4', null, 'deg/s'), 'Rotorflight 4.4');
    assert.equal(I.valueSe(false), 'no');
    assert.equal(I.num(NaN), 'n/a');
    assert.equal(I.threshold({ median: 0.01, band: 0.02, source: 'x', note: 'y' }), 'median 0.01, band 0.02');
    assert.equal(I.logLabel(49), '50');
    assert.equal(I.logLabel([49, 50]), '50, 51');
    assert.equal(I.logLabel('1:49'), '1:49');
    assert.equal(I.esc(HOSTILE), HOSTILE_ESCAPED);
    assert.equal(I.findingStatus({ severity: 'note', id: 'G2', text: 'no finding: 6 s' }), 'insufficient');
    assert.equal(I.findingStatus({ severity: 'note', id: 'G2', thin: true, text: 'The check has no result.' }), 'insufficient');
    assert.equal(I.findingStatus({ severity: 'note', id: 'C13', text: 'lag 26 ms' }), 'information');
    assert.equal(I.findingStatus({ severity: 'note', id: 'C12', text: 'error 0.31' }), 'monitor');
    assert.equal(I.findingStatus({ severity: 'skipped', id: 'D4' }), 'notMeasured');
    assert.equal(I.findingStatus({ severity: 'flag', id: 'C5' }), 'problem');
    assert.equal(I.findingStatus({ severity: 'ok', id: 'C5' }), 'satisfactory');
    assert.equal(I.findingStatus({ severity: 'error', id: 'MORE' }), 'error');
    assert.equal(I.areaOf({ id: 'GOV', module: 'gov', severity: 'error' }), 'governor');
    assert.equal(I.areaOf({ id: 'T11' }), 'tail');
    assert.equal(I.paramText({ scope: 'rateprofile', cliProfile: 1, from: 30, to: 25, direction: 'lower' }), '(rate profile 2): 30 to 25 (decrease)');
    assert.equal(I.paramText({ scope: 'profile', cliProfile: null, from: null, to: null, direction: 'check' }), '(PID profile unknown): examine');
    assert.equal(I.paramText({ scope: 'global', from: 50, to: null, direction: 'check' }), '(all PID profiles): value 50 (examine)');
    assert.equal(I.findingWhere({ id: 'T5', profile: 1, axis: 'yaw' }, ' · '), 'PID profile 1 · yaw');
    assert.equal(I.findingWhere({ id: 'D4', profile: 0 }, ' '), 'PID profile 1', 'D4 carries the CLI profile index: PID profile 1 is `profile 0`');
    assert.equal(I.findingWhere({ id: 'H', profile: 'global' }, ' '), 'All PID profiles');
    assert.equal(I.findingWhere({ id: 'F4', profile: 'roll' }, ' · '), 'All PID profiles · roll', 'F4 keeps its axis in profile');
    assert.equal(I.findingWhere({ id: 'C12', profile: 0, axis: 'pitch' }, ' · '), 'PID profile unknown · pitch', 'the arming profile before the first switch');
    // the flight rpm of js/tuning_worker.js autoRpm: basis, profile, seconds in flight and the logs pooled (from 0)
    assert.equal(I.rpmText({ value: 1900, source: 'govTarget', basis: 2300, profile: 1, seconds: 70.4, logs: [49, 50, 51] }),
        '1900 (85 % of the lowest governor target: 2300 rpm in PID profile 1, 70.4 s in flight in logs 50, 51, 52)');
    assert.equal(I.rpmText({ value: 3000, source: 'headspeed', basis: 3541, profile: 0, seconds: 5.2, logs: [3] }),
        '3000 (85 % of the lowest median headspeed in flight of a PID profile: 3541 rpm, 5.2 s in flight in log 4)', 'profile 0: the arming profile, not named');
    assert.equal(I.rpmText({ value: 1900, source: 'govTarget', basis: 2300, profile: 2, seconds: 400, logs: [...Array(10).keys()] }),
        '1900 (85 % of the lowest governor target: 2300 rpm in PID profile 2, 6.7 min in flight in logs 1, 2, 3, 4, 5, 6, 7, 8 and 2 more)');
    assert.equal(I.rpmText({ value: 3000, source: 'default', basis: null, profile: null, seconds: null, logs: [] }), '3000 (the value of the toolkit)');
    assert.equal(I.rpmText({ value: 2200, source: 'user', basis: null, profile: null, seconds: null, logs: [] }), '2200 (your value)');
    // hierarchy status words, tolerant of the spelling of hierarchy.cjs
    const hier = { nodes: { a: { status: 'Possible result' }, b: { status: 'not_applicable' }, c: { status: 'problem' }, d: { status: 'start' }, e: { status: 'whatever' } }, startHere: ['c'] };
    assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [I.nodeState(hier, id).key, I.nodeState(hier, id).start]),
        [['possible', 0], ['notApplicable', 0], ['start', 1], ['problem', 0], ['notMeasured', 0], ['notMeasured', 0]]);
    // derive results as series: an axis of their own, or the span's t
    assert.deepEqual(plain(I.derivedSeries({ f: [1, 2, 3], cols: { a: [4, 5, 6], b: [1] } }, null).series.map((s) => s.name)), ['a']);
    assert.equal(I.derivedSeries({ cols: { a: [4, 5, 6] } }, { t: [0, 1, 2] }).xs, 't');
    assert.equal(I.derivedSeries({ nothing: 1 }, null), null);
});


// --- V1: the CLI dump of one file is not used for a different file, nor for a log of a different craft name ----------------

const DUMP = (name) => '# dump\n\n# version\n# Rotorflight / STM32G47X (SG47) 4.6.0\n\nbatch start\n\n' + (name ? '# name: ' + name + '\n\n' : '') +
    'profile 0\nset gov_mode = 1\n' + (name ? 'set name = ' + name + '\n' : 'set name = -\n') + 'batch end\n';

test('V1: a CLI dump goes with its file: a different file removes it with a notice, the same file keeps it', () => {
    const app = setup({ sysConfig: { 'Craft name': 'SAB Fireball' } });
    app.show();
    app.workers[0].reply({ type: 'result', result: synthResult() });
    app.jq.fire('change', '.tuning-cli-input', {}, { files: [{ name: 'fireball_cli_dump.txt', text: DUMP('SAB Fireball') }] });
    app.jq.fire('click', '.tuning-analyse');
    assert.equal(app.workers[1].sent[0].msg.options.cliText, DUMP('SAB Fireball'), 'the same craft name: the analysis uses the dump');
    app.workers[1].reply({ type: 'result', result: synthResult() });
    assert.match(app.html('.tuning-cli-name'), /fireball_cli_dump\.txt/);
    // the same file opened again (same name, length and bytes): the dump stays
    app.load(Uint8Array.from(app.bytes), '<i>flight</i>.bbl', fakeLog({ sysConfig: { 'Craft name': 'SAB Fireball' } }));
    app.show();
    assert.match(app.html('.tuning-cli-name'), /fireball_cli_dump\.txt/);
    assert.ok(!/removed the CLI dump/.test(app.html('.tuning-notices')));
    // a different file (the Gaui logs have no craft name): the dump goes, the notice says why, the run has no CLI text
    const before = app.workers.length;
    app.load(Uint8Array.from({ length: 400 }, (_, i) => (i * 13) & 0xff), 'gaui_58.bbl', fakeLog({ sysConfig: { 'Craft name': '' } }));
    app.show();
    assert.equal(app.workers.length, before + 1, 'the automatic run of the new log');
    assert.equal(app.workers[before].sent[0].msg.options.cliText, null);
    assert.equal(app.workers[before].sent[0].msg.options.cliName, null);
    assert.equal(app.html('.tuning-cli-name'), '');
    assert.match(app.html('.tuning-notices'), /The app removed the CLI dump <span data-ste="quoted">fireball_cli_dump\.txt<\/span>, because a different file is open\. The analysis of this file uses only the log\./);
    app.workers[before].reply({ type: 'result', result: synthResult() });
    assert.match(app.html('.tuning-notices'), /removed the CLI dump/, 'the notice stays after the result');
    // the pilot loads a dump again: no notice
    app.jq.fire('change', '.tuning-cli-input', {}, { files: [{ name: 'gaui.txt', text: DUMP(null) }] });
    assert.ok(!/removed the CLI dump/.test(app.html('.tuning-notices')));
    assert.match(app.html('.tuning-notices'), /The logs, the flights or the CLI dump are different from this result/);
    // the Analysis view asks for a run with the dump of an old file: runAnalysis goes without it
    app.load(Uint8Array.from({ length: 400 }, (_, i) => (i * 5) & 0xff), 'third.bbl', fakeLog({ sysConfig: { 'Craft name': '' } }));
    const n = app.workers.length;
    app.dialog.runAnalysis();
    assert.equal(app.workers[n].sent[0].msg.options.cliText, null, 'runAnalysis: no CLI text of the file before');
    assert.deepEqual(app.errors, []);
    noRawMarkup(app);
});

test('V1: the craft names of the CLI dump and of the log header are not the same: the analysis does not use the dump, and says why', () => {
    const I = setup().internals;
    assert.equal(I.cliCraft(DUMP('SAB Fireball')), 'SAB Fireball');
    assert.equal(I.cliCraft('# diff all\r\nset name = Goblin 700\r\n'), 'Goblin 700', 'set name of a diff, CRLF');
    assert.equal(I.cliCraft('# dump\n# name: Gaui X4\n'), 'Gaui X4', 'the comment line only');
    assert.equal(I.cliCraft(DUMP(null)), null, 'set name = - is no name');
    assert.equal(I.cliCraft('set rateprofile_name = -\nset model_set_name = OFF\n'), null, 'other names are not the craft name');
    assert.ok(I.sameCraft(' SAB Fireball', 'sab fireball'));
    assert.ok(!I.sameCraft('SAB Fireball', 'Gaui X4'));

    const app = setup({ sysConfig: { 'Craft name': 'Gaui X4' } });
    app.show();
    app.workers[0].reply({ type: 'result', result: synthResult() });
    app.jq.fire('change', '.tuning-cli-input', {}, { files: [{ name: 'fireball_cli_dump.txt', text: DUMP('SAB Fireball') }] });
    const warn = /The craft name in the CLI dump \(<span data-ste="quoted">SAB Fireball<\/span>\) is not the same as the craft name in the log header \(<span data-ste="quoted">Gaui X4<\/span>\)\. Thus, the analysis does not use the CLI dump\. It uses only the values of the log\./;
    assert.match(app.html('.tuning-notices'), warn);
    assert.match(app.html('.tuning-cli-name'), /fireball_cli_dump\.txt<\/span> <span class="tuning-cli-off">\(not used\)<\/span>/);
    assert.ok(!/different from this result/.test(app.html('.tuning-notices')), 'the key has no CLI dump: the result on display is for it');
    app.jq.fire('change', '.tuning-scope', {}, { value: 'file' });
    app.jq.fire('click', '.tuning-analyse');
    const msg = app.workers[app.workers.length - 1].sent[0].msg;
    assert.equal(msg.cmd, 'analyseFile');
    assert.equal(msg.options.cliText, null);
    assert.equal(msg.options.cliName, null);
    // no craft name in the dump, or none in the log header: nothing to compare, the dump is used
    for (const [head, text] of [['Gaui X4', DUMP(null)], ['', DUMP('SAB Fireball')]]) {
        const b = setup({ sysConfig: { 'Craft name': head } });
        b.show();
        b.jq.fire('change', '.tuning-cli-input', {}, { files: [{ name: 'd.txt', text }] });
        b.jq.fire('click', '.tuning-analyse');
        assert.equal(b.workers[b.workers.length - 1].sent[0].msg.options.cliText, text, JSON.stringify(head));
        assert.ok(!/craft name in the CLI dump/.test(b.html('.tuning-notices')));
    }
    noRawMarkup(app);
});

// --- V9: "Start analysis" while the automatic run of one log operates ---------------------------------------------------------

test('V9: "Start analysis" stops the automatic run and starts the run that the pilot asked for; a run for the same values goes on', async () => {
    const app = setup();
    app.show();
    const auto = app.workers[0], waiting = app.dialog.runAnalysis(); // the Analysis view waits for the automatic run
    assert.equal(auto.sent[0].msg.cmd, 'analyseLog');
    assert.equal(app.jq.node('.tuning-analyse').props.disabled, false);
    // the same values: the run goes on, and the view says so
    app.jq.fire('click', '.tuning-analyse');
    assert.equal(app.workers.length, 1);
    assert.equal(auto.terminated, false);
    assert.match(app.html('.tuning-notices'), /The analysis for these values operates at this time\. Wait for the result\./);
    // "All logs in the file" while it operates: a notice, then the first click stops it and starts the file run
    app.jq.fire('change', '.tuning-scope', {}, { value: 'file' });
    // no CLI dump: the notice does not name it (the log is the only necessary input)
    assert.match(app.html('.tuning-notices'), /The analysis that operates at this time uses different logs\. To use the values that you selected, click "Start analysis"\./);
    app.jq.fire('click', '.tuning-analyse');
    assert.equal(auto.terminated, true, 'the automatic run stops');
    assert.equal(app.workers.length, 2);
    assert.equal(app.workers[1].sent[0].msg.cmd, 'analyseFile');
    await assert.rejects(waiting, (e) => e.reason === 'replaced', 'the waiter of the old run hears that it stopped');
    assert.ok(!/operates at this time/.test(app.html('.tuning-notices')), 'the run is for the values on display');
    app.workers[1].reply({ type: 'result', result: synthResult({ scope: 'file', logs: [0, 1, 2], logIndex: undefined }) });
    assert.equal(app.jq.node('.tuning-analyse').props.disabled, false);
    assert.deepEqual(app.errors, []);
});

// --- V4: the confidence label of a recommendation is not the status "Not measured" ---------------------------------------------

test('V4: a recommendation from the rule of a check (advice.cjs "advisory") has no "Not measured" in its header', () => {
    const app = analysed();
    app.tab('recs');
    const recs = app.pane('recs');
    assert.match(recs, /<div class="tuning-rec-title">Examine the notch filter for the line at 4\.06×<\/div><div class="tuning-muted">Filters · PID profile 1<\/div>/, 'advisory: area and PID profile only');
    assert.ok(!/<div class="tuning-muted">[^<]*Not measured[^<]*<\/div><\/div>/.test(recs), 'no rec header says Not measured');
    assert.match(recs, /Tail · PID profile 1 · Measured/);
    assert.match(recs, /Cyclic · PID profile 1 · Calculated with the gain model/);
    const I = app.internals;
    assert.deepEqual([I.confidenceText('measured'), I.confidenceText('predicted'), I.confidenceText('advisory'), I.confidenceText('<b>x'), I.confidenceText(undefined)],
        ['Measured', 'Calculated with the gain model', '', '', '']);
    app.dialog.runAnalysis();
    app.saved.length = 0;
    app.jq.fire('click', '.tuning-save');
    return new Promise((r) => setImmediate(r)).then(() => {
        const md = app.saved[0].text;
        assert.match(md, /- Area: Filters\.\n/, 'the report has no confidence line for advisory');
        assert.match(md, /- Area: Tail\. Confidence: Measured\./);
        assert.ok(!/Confidence: Not measured/.test(md));
    });
});

// --- V10: the diagram status text fits its box; a compare plot of one PID profile shows its periods only -------------------

test('V10: a step lists the checks with a problem in its condition line, 6 at most and "+N"; a check with more results has its count', () => {
    const r = synthResult(), c11 = ['roll', 'pitch', 'yaw'].map((a) => ({ module: 'loop', id: 'C11', severity: 'flag', log: 1, profile: 1, pidProfile: 1, axis: a, value: 0.7,
        threshold: 0.5, text: 'D-term', times: [], fid: 'loop|C11|1|0|1|' + a + '|0', node: 'filters', noun: 'D-term noise' }));
    const f10 = ['roll', 'pitch', 'yaw'].map((a) => ({ module: 'more', id: 'F10', severity: 'flag', log: 1, profile: 1, axis: a, value: 0.6, threshold: 0.5, text: 'D', times: [],
        fid: 'more|F10|1|0|1|' + a + '|0', node: 'filters', noun: 'D-term noise' }));
    r.findings = r.findings.concat(c11, f10);
    const app = analysed({ result: r }), o = app.pane('overview');
    assert.match(o, /data-node="filters"[^]*?<span class="tuning-badge st-start">Start here 1<\/span> <span class="tuning-block-ids">F5, F1, C11 roll, C11 pitch, C11 yaw, F10 roll \+2<\/span>/);
    assert.match(o, /<li class="st-problem" title="Problem, 3 results"><span class="tuning-dot st-problem"><\/span><span class="tuning-block-check">C11<\/span> D-term noise <span class="tuning-block-check-st">Problem ×3<\/span><\/li>/,
        'one row for each check, with its noun and the number of results');
    assert.deepEqual(app.errors, []);
});

test('V10: "Show the measurement" from the curves of the whole log, for a result of one PID profile, shows only its periods', () => {
    const I = setup().internals;
    const r = { records: [{ log: 1, profiles: { pid: [{ t0: 0, t1: 40, profile: 0 }, { t0: 40, t1: 100, profile: 2 }, { t0: 100, t1: 150, profile: '1' }, { t0: 150, t1: 200, profile: 2 },
        { t0: 200, t1: 260, profile: 1 }, { t0: 260, t1: 320, profile: 3 }] } }, { log: 2, profiles: { pid: [{ t0: 0, t1: 9, profile: 1 }] } }] };
    assert.deepEqual(plain(I.profilePeriods(r, 1)).map((q) => q.p), [0, 2, 1, 2, 1, 3]);
    const n = 3201, x = Array.from({ length: n }, (_, i) => i * 0.1), u = Float32Array.from(x, (t) => Math.sin(t)), node = { t: x, u: { mean: u, min: u, max: u } };
    const f = { id: 'T8', fid: 'loop|T8|1|0|1|null|0', pidProfile: 1, profile: 1, log: 1 };
    const ev = { plot: { kind: 'time', curve: 'more.tail', reference: [{ kind: 'hline', value: 1250, unit: '‰', label: 'Tail output limit 1250 ‰' }] }, spans: [{ t0: 120, t1: 121 }] };
    const got = { x, xs: 't', node, series: [{ key: 'u', name: 'tail output (mixer[2])', y: u, unit: '‰', lo: u, hi: u, fill: true }] };
    const out = I.compareSpec(f, ev, got, 'T8', { periods: I.profilePeriods(r, 1) });
    assert.equal(out.only, 1);
    assert.equal(out.onlyText, 'The plot shows only the periods of PID profile 1.');
    // the x axis: the first period of PID profile 1 (100 s) to the end of its last (260 s), with a margin of 3 % of 160 s
    assert.ok(Math.abs(out.spec.x.min - (100 - 4.8)) < 1e-9 && Math.abs(out.spec.x.max - (260 + 4.8)) < 1e-9, JSON.stringify(out.spec.x));
    const y = out.spec.series[0].y, at = (t) => y[Math.round(t * 10)];
    assert.ok(Number.isNaN(at(50)) && Number.isNaN(at(170)) && Number.isNaN(at(300)), 'no data of the other PID profiles');
    assert.ok(Math.abs(at(120) - Math.sin(120)) < 1e-6 && Math.abs(at(230) - Math.sin(230)) < 1e-6, 'the data of PID profile 1 as it is');
    assert.ok(Number.isNaN(out.spec.series[0].lo[1700]) && Number.isNaN(out.spec.series[0].hi[1700]), 'the band too');
    // not for: a result of all PID profiles, an unknown PID profile, a log with one PID profile, a frequency plot, a raw span
    const all = I.compareSpec(Object.assign({}, f, { pidProfile: null, profile: null }), ev, got, 'T8', { periods: I.profilePeriods(r, 1) });
    assert.equal(all.only, null);
    assert.equal(all.spec.x.min, undefined);
    assert.equal(I.compareSpec(f, ev, got, 'T8', { periods: I.profilePeriods(r, 2) }).only, null, 'one PID profile in the log');
    assert.equal(I.compareSpec(f, ev, Object.assign({}, got, { node: undefined }), 'T8', { periods: I.profilePeriods(r, 1) }).only, null, 'a raw span is short already');
    assert.equal(I.compareSpec(f, ev, got, 'T8').only, null, 'no periods given');
    // the view: the note of the panel says so
    const app = analysed({ result: synthResult({ records: [Object.assign(synthResult().records[0], { profiles: { pid: [{ t0: 0, t1: 100, profile: 1 }, { t0: 100, t1: 300, profile: 2 }] } })] }) });
    app.tab('tail');
    const T8 = app.result.findings.find((q) => q.id === 'T8');
    T8.evidence = { v: 1, fid: FID.T8, id: 'T8', log: 1, profile: 1, spans: [{ log: 1, t0: 20, t1: 22 }], view: null,
        plot: { kind: 'time', curve: 'more.tail', reference: [{ kind: 'hline', value: 400, unit: '‰', label: 'Tail output limit 400 ‰' }] }, expected: 'The tail output does not touch its limits.' };
    app.tab('checks');
    app.jq.fire('click', '.tuning-compare-open', { 'data-key': FID.T8, 'data-where': 'checks' });
    const spec = app.plots.map((q) => q.spec).filter((q) => /T8/.test(q.title)).pop();
    assert.ok(spec && spec.x.max <= 103 + 1e-9, 'PID profile 1: 0 s to 100 s and the margin ' + (spec && JSON.stringify(spec.x)));
    assert.match(app.html('.tuning-checks-table'), /Source: the curves of log 2\. The plot shows only the periods of PID profile 1\./);
});


test('flight RPM comes from the recorded data and has no user input', () => {
    const app = analysed();
    assert.doesNotMatch(app.allHtml(), /<input[^>]*tuning-rpm/);
    assert.equal(app.workers[0].sent[0].msg.options.flightRpm, null, 'analysis derives the threshold');
    app.tab('filters');
    assert.doesNotMatch(app.pane('filters'), /Selected changes from this step|tuning-step-picks/);
    app.jq.fire('click', '.tuning-ft-start');
    assert.equal(ftWorker(app).sent[0].msg.options.flightRpm, 2000, 'autotune reuses the recorded analysis threshold');
    // Changed configuration inputs must derive RPM again, not reuse a stale result.
    app.jq.fire('change', '.tuning-cli-input', {}, { files: [{ name: 'configuration.txt', text: '# diff all\nprofile 0\nset gov_headspeed = 2300\n' }] });
    app.jq.fire('click', '.tuning-ft-start');
    assert.equal(ftWorker(app).sent[0].msg.options.flightRpm, null);
});

// --- the worker's display of a finding (catalog.cjs display: review V5, V6) and the sources of a recommendation ------------

test('the tables show the worker\'s display.value and display.bound (then display.limit, then the toolkit value), and the sources of a rule apart', () => {
    const r = synthResult(), d2 = r.findings.find((f) => f.id === 'D2'), g2 = r.findings.find((f) => f.id === 'G2'), t8 = r.findings.find((f) => f.id === 'T8');
    d2.fid = 'setup|D2|1|0|null|null|0';
    d2.display = { value: '1 loop stall', unit: '', scale: 1, limit: 'The limit is 0 for each type.', bound: '0 for each type', profile: null, phase: null };
    g2.display = { value: null, unit: '%', scale: 100, limit: 'The limit is 1 % for the median.', bound: null, profile: 'PID profile 3', phase: null };
    t8.display = { value: '0.54 s at a limit', unit: 's', scale: 1, limit: 'Each period at a limit counts as a problem.', bound: '0 s at a limit', profile: 'PID profile 1', phase: 'in flight' };
    const rec = r.advice.recommendations.find((x) => x.id === 'G9:gov_i_gain');
    // an evidence row of a recommendation: its own e.display; the finding of its fid when the result has it
    rec.evidence = [{ fid: d2.fid, id: 'D2', module: 'setup', log: 1, value: 0, threshold: 'gaps <= 0', display: d2.display },
        { fid: 'none|G10|1|0|1|null|0', id: 'G10', module: 'gov', log: 1, profile: 1, value: 0.235, se: 0.139, threshold: { implicated: 0.5, ruledOut: 0.1, flatRpm: 10, minWindows: 8 },
            display: { value: 'coherence 0.235 ± 0.139', bound: '0.5 or more (2 SE test)', limit: null } }];
    rec.rule = 'Check G9 has a problem if the prominence is 5 or more by 2 SE. Source: "pipeline, unvalidated". Source: "doc GOV: \'governor\'".';
    rec.sources = ['pipeline, unvalidated', 'doc GOV: "governor"'];
    const app = analysed({ result: r });
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    app.tab('checks');
    const table = app.html('.tuning-checks-table'), row = (id) => (table.match(new RegExp('<tr class="row-[^"]*"><td>[^]*?<td class="tuning-id">' + id + '<[^]*?</tr>')) || [''])[0];
    assert.match(row('D2'), /<td class="tuning-text-value">1 loop stall<\/td><td class="tuning-rule">0 for each type<div/, 'D2: the value of the rule and its limit, as STE text; the value gives the count');
    assert.ok(!/gaps &lt;= 0/.test(row('D2')), 'not the toolkit threshold');
    assert.match(row('G2'), /<td class="tuning-text-value"><div class="tuning-muted">6027 values<\/div><\/td><td class="tuning-rule">The limit is 1 % for the median\.<div/, 'no display.value: no bare toolkit value; no bound: the limit sentence');
    assert.match(row('T8'), /<td class="tuning-text-value">0\.54 s at a limit<[^]*?<td class="tuning-rule">0 s at a limit<div/);
    assert.match(row('C12'), /<td class="tuning-num"><span data-ste="quoted">0\.310&nbsp;±&nbsp;0\.030 fraction<\/span>/, 'no display: the toolkit value, quoted, as before');
    app.tab('recs');
    const recs = app.pane('recs');
    const card = recs.slice(recs.indexOf('Monitor the governor I-term oscillation'), recs.indexOf('Examine the tail center trim'));
    assert.match(card, /<td class="tuning-text-value">1 loop stall<\/td><td class="tuning-rule">0 for each type</, 'the evidence row finds its finding by fid');
    assert.match(card, /<td class="tuning-text-value">coherence 0\.235&nbsp;±&nbsp;0\.139<[^]*?<td class="tuning-rule">0\.5 or more \(2 SE test\)</, 'a row with no finding: its own display');
    assert.ok(!/implicated|ruledOut/.test(card));
    assert.match(card, /<div class="tuning-label">Rule<\/div><div>Check G9 has a problem if the prominence is 5 or more by 2 SE\.<\/div><\/div><div class="tuning-rec-rule tuning-rec-sources"><div class="tuning-label">Sources<\/div><ul><li><span data-ste="quoted">pipeline, unvalidated<\/span><\/li><li><span data-ste="quoted">doc GOV: &quot;governor&quot;<\/span><\/li><\/ul><\/div>/);
    // a rule with no sources stays as it is
    assert.match(recs, /<div class="tuning-label">Rule<\/div><div>Check T7: r is 0\.5 or more, with a 2 SE test\. The step is 20 % or less\.<\/div><\/div><div class="tuning-table-wrap">/);
    const I = app.internals;
    assert.equal(I.ruleText({ rule: 'A. Source: "x, \'y\'".', sources: ['x, "y"'] }), 'A.');
    assert.equal(I.ruleText({ rule: 'A. Source: "x".', sources: [] }), 'A. Source: "x".', 'no sources: the rule as it is');
    // the side panel of a step and the saved report
    const panel = I.valueHtml(t8) + ' | ' + I.limitHtml(t8);
    assert.equal(panel, '0.54 s at a limit | 0 s at a limit');
    app.saved.length = 0;
    app.jq.fire('click', '.tuning-save');
    return new Promise((res) => setImmediate(res)).then(() => {
        const md = app.saved[0].text;
        assert.match(md, /\| D2 \| 2 \|[^\n]*\| 1 loop stall \| 0 for each type \|/);
        noRawMarkup(app);
        assert.deepEqual(app.errors, []);
    });
});

test('the count under the value: only when it adds information, with "samples" when it is the sample count of the log', () => {
    const I = setup().internals, rec = (log, n) => ({ log, segment: 0, timeMap: { n } });
    const r = { records: [rec(58, 332541), rec(1, 1000), rec(1, 500)] }, s58 = I.sampleCounts(r, 58), s1 = I.sampleCounts(r, 1);
    assert.deepEqual(plain(s58), [332541]);
    assert.deepEqual(plain(s1), [1000, 500, 1500], 'each segment and the log');
    const f = (n, value) => ({ id: 'X', n, display: value === undefined ? undefined : { value } });
    assert.equal(I.countText(f(332541, null), s58), '332541 samples', 'G13: no value, the samples of the log');
    assert.equal(I.countText(f(332541, '0 V in 10 ms'), s58), '332541 samples', 'D5: a value in V gives no count');
    assert.equal(I.countText(f(332541, '1 loop stall'), s58), '', 'D2: the value gives the count');
    assert.equal(I.countText(f(291871, '291028 of 291871 flight samples with a governor output'), s58), '', 'G0');
    assert.equal(I.countText(f(2, '55 deg/s from 2 collective steps with the yaw stick stable'), s58), '', 'T6 with not sufficient data');
    assert.equal(I.countText(f(0, null), s58), '', 'G10 with no data: no "0 values"');
    assert.equal(I.countText(f(3, '41.1 ± 11.5 deg/s'), s58), '3 values', 'T6: a count that is not of samples');
    assert.equal(I.countText(f(1500, '1000 Hz'), s1), '1500 samples', 'D1: Hz is a unit, not a count');
    assert.equal(I.countText(f(22, '11 deg/s'), s58), '22 values');
    assert.equal(I.countText(f(1, undefined), s58), '1 value', 'no display: as before');
    assert.equal(I.countText(f(null, null), s58), '');
    for (const v of ['3 groups of checks that did not operate', '0 changes', '0 sudden steps', '1 gyro low-pass filter', '0 of 44 notch filters']) assert.ok(I.givesCount(v), v);
    for (const v of ['1000 Hz', '0 V in 10 ms', '305 s', '52.2 %', 'coherence 0.166 ± 0.1', '2.37 s at a limit', 'Q 4', '11 deg/s', '3500 rpm']) assert.ok(!I.givesCount(v), v);
});

test('app code is one IIFE global, Chromium 99 safe', () => {
    for (const [file, name] of [['js/tuning_dialog.js', 'TuningDialog'], ['js/tuning_snippet.js', 'TuningSnippet']]) {
        const src = read(file);
        const context = vm.createContext({});
        const before = new Set(Object.getOwnPropertyNames(context));
        vm.runInContext(src, context);
        assert.deepEqual(Object.getOwnPropertyNames(context).filter((k) => !before.has(k)), [name], file);
        assert.ok(!/^(const|let|class)\s/m.test(src), file + ': no top-level const, let or class');
        for (const api of ['toSorted', 'toReversed', 'Object.groupBy', 'findLast', '.at(', 'structuredClone', 'replaceAll', 'Promise.withResolvers', 'Array.fromAsync']) assert.ok(!src.includes(api), file + ': ' + api);
        assert.ok(!/(src|href|url)\s*[=(]\s*["']?\//.test(src), file + ': relative URLs only');
    }
    const css = read('css/tuning_dialog.css');
    assert.ok(!/:has\(|@container|&\s*[.:{]/.test(css), 'no :has(), container queries or nesting');
    assert.ok(!/(src|href|url)\s*[=(]\s*["']?\//.test(css), 'relative URLs only');
    assert.ok(!/\.tuning-dialog \.modal|modal-body/.test(css), 'no modal rules left');
});

test('the full-screen view: plots size from the stylesheet, the tab strip and cards stick and fit', () => {
    const css = read('css/tuning_dialog.css');
    assert.match(css, /#viewTuning \{\s*padding: 10px 15px 14px;/, 'the padding that the sticky strip assumes');
    assert.match(css, /\n\.tuning-tabs \{[^}]*position: sticky;[^}]*top: -10px;/);
    // SPEC3 C: the heights and the column width scale with the text (--rf-px), the middle term stays with the window
    assert.match(css, /\.tuning-plot-canvas \{\s*display: block;\s*width: 100%;\s*height: clamp\(calc\(207 \* var\(--rf-px\)\), calc\(\(100vh - 330px\) \/ 2\), calc\(460 \* var\(--rf-px\)\)\);/);
    assert.match(css, /\.tuning-plots \{\s*display: grid;\s*grid-template-columns: repeat\(auto-fill, minmax\(calc\(554 \* var\(--rf-px\)\), 1fr\)\);/);
    // Chromium 99 (NW.js 0.62.2) scrolls the card to the top edge, under the 33-35 px strip, unless the card keeps a margin
    const margin = /\n\.tuning-rec \{[^}]*scroll-margin-top: (\d+)px;/.exec(css);
    assert.ok(margin && +margin[1] >= 40, 'scroll-margin-top clears the strip');
    for (const st of ['problem', 'start', 'blocked', 'possible', 'monitor', 'satisfactory', 'information', 'notmeasured', 'notapplicable', 'notaccurate', 'error']) {
        assert.ok(css.includes(`.tuning-block.st-${st}`), `step status ${st} has a style`);
        assert.ok(css.includes(`.tuning-swatch.st-${st}`), `legend swatch ${st}`);
        assert.ok(css.includes(`.tuning-pchip.st-${st}`), `PID profile chip ${st}`);
        assert.ok(css.includes(`.tuning-badge.st-${st}`) || ['notmeasured'].includes(st), `badge ${st}`);
    }
    for (const st of ['ok', 'problem', 'nodata']) {
        assert.ok(css.includes(`.tuning-prereq-item.st-${st}`), `item status ${st} has a style`);
        assert.ok(css.includes(`.tuning-badge.st-${st}`), `badge ${st}`);
        assert.ok(css.includes(`.tuning-pchip.st-${st}`) || st === 'problem', `PID profile chip ${st}`);
    }
});

test('index.html, gulpfile.js, main.js and branding.css register the view once', () => {
    const html = read('index.html'), gulp = read('gulpfile.js'), main = read('js/main.js'), branding = read('css/branding.css');
    const count = (text, needle) => text.split(needle).length - 1;
    assert.equal(count(html, '<link rel="stylesheet" href="css/tuning_dialog.css">'), 1);
    for (const js of ['tuning_plot', 'tuning_snippet', 'tuning_dialog']) assert.equal(count(html, `<script src="js/${js}.js"></script>`), 1, js);
    assert.equal(count(html, 'tuning_worker.js'), 0, 'the worker is not a page script');
    const at = (needle) => html.indexOf(needle);
    assert.ok(at('js/flight_analysis_dialog.js') < at('js/tuning_plot.js') && at('js/tuning_plot.js') < at('js/tuning_snippet.js') &&
        at('js/tuning_snippet.js') < at('js/tuning_dialog.js') && at('js/tuning_dialog.js') < at('js/main.js'), 'script order: flight analysis, plot, snippet, view, main');
    assert.equal(count(html, 'id="viewTuning"'), 1);
    assert.equal(count(html, 'id="tuningBody"'), 1);
    assert.equal(count(html, 'data-view="tuning"'), 1, 'one navbar tab');
    assert.equal(count(html, 'id="dlgTuning"') + count(main, 'dlgTuning'), 0, 'the Tuning view is a view, not a modal'); // upstream's #dlgFlightAnalysis stays, unused (SPEC2 D7)
    assert.ok(Math.max(at('id="viewAnalysis"'), at('id="viewFlightAnalysis"')) < at('id="viewTuning"'), 'the Analysis view, then the Tuning view');

    const list = /(?:var distSources|APP_ASSET_SOURCES) = \[([\s\S]*?)\];/.exec(gulp)[1]; // master, or origin/master's list
    for (const file of ['./css/tuning_dialog.css', './js/tuning_plot.js', './js/tuning_snippet.js', './js/tuning_dialog.js', './js/tuning_worker.js', ...TOOLKIT]) {
        assert.equal(count(list, `'${file}'`), 1, file);
    }
    assert.equal(count(main, 'new TuningDialog($("#viewTuning")'), 1);
    assert.equal(count(main, 'getFlightLog: function() { return flightLog; }'), 1, 'the view reads the viewer\'s FlightLog, not one kept from show()');
    assert.equal(count(main, '$(".rf-view-tab").click('), 1);
    assert.equal(count(main, 'views.tuning = tuningDialog;'), 1);
    assert.match(main, /if \(graph && activeView === "viewer" && e\.target\.type != 'text'/, 'the viewer\'s keys only in the viewer');
    assert.match(main, /if \(!graph \|\| activeView !== "viewer" \|\|/, 'the viewer\'s wheel only in the viewer');
    assert.match(branding, /\.rf-view-tabs \{\s*display: none;/);
    assert.match(branding, /html\.has-log \.rf-view-tabs \{\s*display: inline-flex;\s*\}/);
});

test('every registered tuning file exists, so packaged builds have it', () => {
    const missing = ['./css/tuning_dialog.css', './js/tuning_plot.js', './js/tuning_snippet.js', './js/tuning_dialog.js', './js/tuning_worker.js', ...TOOLKIT]
        .filter((file) => !fs.existsSync(path.join(ROOT, file)));
    assert.deepEqual(missing, []);
});

// --- SPEC3 C: the text size of the view ---------------------------------------------------------------------------------

test('SPEC3 C: the view text is in --rf-px units (15 px body at 100 %), the diagram too: HTML that scales with the text size', () => {
    const css = read('css/tuning_dialog.css');
    assert.match(css, /#viewTuning \{[^}]*font-size: calc\(15 \* var\(--rf-px\)\);/, 'body text 15 px at 100 %');
    // every font size of the view is in text units, 12 px or more at 100 %: no px font size, no SVG text
    for (const m of css.matchAll(/\n([^{}\n]+)\{([^}]*)\}/g)) {
        const sel = m[1].trim(), px = /font-size: ([\d.]+)px/.exec(m[2]), unit = /font-size: calc\(([\d.]+) \* var\(--rf-px\)\)/.exec(m[2]);
        assert.ok(!px, `${sel}: a px font size`);
        if (unit) assert.ok(+unit[1] >= 12, `${sel}: ${unit[1]} px at 100 %, the smallest text is 12 px`);
    }
    assert.doesNotMatch(css, /line-height: \d+(\.\d+)?px/, 'line heights scale with the text');
    assert.doesNotMatch(css, /tuning-order-svg|tuning-node-box|tuning-col-head/, 'no SVG diagram is left');
    assert.match(css, /\.tuning-order \{\s*display: flex;\s*flex-wrap: wrap;/, 'the side panel goes under the diagram when the two do not fit');
    assert.match(css, /\.tuning-order-scroll \{\s*overflow-x: auto;/, 'a flow wider than the view scrolls');
    assert.match(css, /\.tuning-flow \{\s*display: grid;[^}]*min-width: min-content;/, 'the columns do not shrink under their minimum width');
    const main = read('css/main.css');
    assert.match(main, /:root \{\s*--rf-text-scale: 1;\s*--rf-px: calc\(var\(--rf-text-scale\) \* 1px\);\s*\}/);
    // the flow and the band are HTML: the column widths and every font of the diagram are in --rf-px
    const app = analysed(), o = app.pane('overview');
    assert.ok(!o.includes('<svg'), 'no SVG');
    assert.match(o, /style="grid-template-columns: (minmax\(calc\(200 \* var\(--rf-px\)\), 1fr\)( calc\(26 \* var\(--rf-px\)\) )?){4}"/);
    for (const sel of ['.tuning-block', '.tuning-block-title', '.tuning-block-checks', '.tuning-node-params .tuning-param', '.tuning-prereq-item', '.tuning-prereq-title', '.tuning-pchip', '.tuning-start-badge']) {
        assert.match(css, new RegExp('\\n' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*font-size: calc\\([\\d.]+ \\* var\\(--rf-px\\)\\);'), sel);
    }
});

// --- SPEC3 D: "Selected flights" ------------------------------------------------------------------------------------

// A 400-byte file of three logs (the FlightLogIndex stand-in: offsets 0, 100, 250) with "Log start datetime" in each
// header: a date in logs 1 and 3, the date of a flight controller with no clock in log 2
function datedFile() {
    const b = new Uint8Array(400);
    const put = (at, text) => { for (let i = 0; i < text.length; i++) b[at + i] = text.charCodeAt(i); };
    put(0, 'H Product:Blackbox flight data recorder\nH Log start datetime:2026-10-04T17:54:08.312+00:00\nH Craft name:x\n');
    put(100, 'H Log start datetime:0000-01-01T00:00:00.000+00:00\n');
    put(250, 'H Firmware revision:Rotorflight\nH Log start datetime:2026-10-04T18:03:13.691+00:00\n');
    return b;
}
const analyseWorkers = (app, cmd) => app.workers.filter((w) => w.sent.length && w.sent[0].msg.cmd === cmd);

test('SPEC3 D: the pure parts of the selection (list, key, text, actions, header date)', () => {
    const I = setup().internals;
    const list = I.selectionList({ '2:1': true, '0:all': true, '2:0': true, '0:3': true, '1:2': false });
    assert.deepEqual(plain(list), [{ log: 0, flight: null }, { log: 2, flight: 0 }, { log: 2, flight: 1 }], '"all" of a log replaces its flights; false is not selected');
    assert.equal(I.selectionKey(list), '0.*,2.0,2.1');
    assert.ok(!I.selectionKey(list).includes('|'), 'the key of a run is split at "|"');
    assert.equal(I.selectionText([{ log: 13, flight: 0 }, { log: 14, flight: 0 }]), 'log 14 flight 1, log 15 flight 1');
    assert.equal(I.selectionText([{ log: 0, flight: null }, { log: 1, flight: null }, { log: 2, flight: null }], { 0: 1, 1: 3 }), 'log 1 flight 1, log 2 flights 1 to 3, log 3 (all flights)');
    // the actions: a full log, a flight of a full log (the others stay), all flights again (the full log), none
    let m = I.selectionApply({}, { kind: 'log', log: 1, on: true });
    assert.deepEqual(plain(m), { '1:all': true });
    m = I.selectionApply(m, { kind: 'flight', log: 1, flight: 0, on: false, count: 3 });
    assert.deepEqual(plain(m), { '1:1': true, '1:2': true });
    m = I.selectionApply(m, { kind: 'flight', log: 1, flight: 0, on: true, count: 3 });
    assert.deepEqual(plain(m), { '1:all': true }, 'each flight of the log: the full log');
    m = I.selectionApply(Object.assign({ '0:all': true }, m), { kind: 'log', log: 1, on: false });
    assert.deepEqual(plain(m), { '0:all': true });
    assert.deepEqual(plain(I.selectionApply({ '2:1': true }, { kind: 'all' }, [{ log: 0, selectable: true }, { log: 1, selectable: false }, { log: 2, selectable: true }])),
        { '0:all': true, '2:all': true }, 'select all: each log that the analysis can use');
    assert.deepEqual(plain(I.selectionApply({ '0:all': true, '2:0': true }, { kind: 'none' })), {});
    // the rows: no data, not known, a bench run, flights; a full log selects each of its flights
    const rows = I.selectionRows([{ log: 0, date: 'd', seconds: 8 }, { log: 1, error: 'Log truncated' }, { log: 2, seconds: 3 }, { log: 3, seconds: 9 }],
        { 2: { bench: true, flights: [] }, 3: { bench: false, flights: [{ t0: 1, t1: 5 }, { t0: 6, t1: 8, seconds: 2 }] } }, { '0:all': true, '3:1': true });
    assert.deepEqual(rows.map((r) => [r.state, r.selectable, r.selected, r.partly]),
        [['unknown', true, true, false], ['nodata', false, false, false], ['bench', false, false, false], ['flights', true, false, true]]);
    assert.deepEqual(plain(rows[3].flights), [{ index: 0, t0: 1, t1: 5, seconds: 4, selected: false }, { index: 1, t0: 6, t1: 8, seconds: 2, selected: true }]);
    // the date of a log from its header
    const b = datedFile();
    assert.equal(I.headerValue(b, 0, 100, 'Log start datetime'), '2026-10-04T17:54:08.312+00:00');
    assert.equal(I.headerValue(b, 100, 250, 'Log start datetime'), '0000-01-01T00:00:00.000+00:00');
    assert.equal(I.headerValue(b, 0, 40, 'Log start datetime'), null, 'only inside the log');
    assert.equal(I.headerValue(b, 0, 100, 'Firmware revision'), null);
    assert.equal(I.logDateText('2026-10-04T17:54:08.312+00:00'), '2026-10-04 17:54:08');
    assert.equal(I.logDateText('0000-01-01T00:00:00.000+00:00'), null, 'no clock: no date');
    assert.equal(I.logDateText(null), null);
});

test('SPEC3 D: "Selected flights" lists the logs and the known flights, sends options.flights, and keys, caches and names the run', () => {
    const app = setup({ logCount: 3, current: 1 });
    app.setFile(datedFile(), 'gaui.bbl');
    app.flightLog.getLogError = (i) => (i === 2 ? 'Log truncated <b>x</b>' : false);
    app.show(); // "This log": the automatic run of log 2
    const rec = Object.assign({}, synthResult().records[0], { log: 1, flights: [{ t0: 14.3, t1: 87, seconds: 72.7 }, { t0: 100, t1: 130 }] });
    app.workers[0].reply({ type: 'result', result: synthResult({ records: [rec] }) });
    assert.ok(app.jq.node('.tuning-fsel').classes.has('tuning-hide'), 'no list for "This log"');
    assert.match(app.html('#tuningBody'), /<option value="file" selected>All flights in the file<\/option><option value="flights">Selected flights<\/option><option value="log">This log<\/option>/,
        '"Logs": all flights of the file first, the default of the view (2026-10-06)');

    app.jq.fire('change', '.tuning-scope', {}, { value: 'flights' });
    let list = app.html('.tuning-fsel');
    assert.ok(!app.jq.node('.tuning-fsel').classes.has('tuning-hide'));
    // the default selection is every flight that the analysis can use, and the list is closed under its head (2026-10-06)
    assert.match(list, /^<details class="tuning-fsel-box"><summary class="tuning-fsel-head" title="Open or close the list of the flights"><strong>Flights in the analysis:<\/strong> <span class="tuning-fsel-count">2 of 2 flights, all flights of 1 of 1 other log \(1 log with no data\)<\/span><\/summary><div class="tuning-fsel-body">/);
    assert.match(list, /<div class="tuning-fsel-actions"><button type="button" class="btn btn-default btn-xs tuning-fsel-all">Select all flights<\/button><button type="button" class="btn btn-default btn-xs tuning-fsel-none">Remove the selection<\/button><\/div>/);
    assert.match(list, /The list shows the flights of a log after an analysis of that log\. For the other logs, select the full log\./);
    // log 1: the date of its header, its length from the log index, its flights not known; log 2: no date, its two flights
    // with their times, closed under its row; log 3: no data, not selectable, its error in the title as quoted text
    assert.match(list, /data-log="0" checked aria-label="Log 1"><\/td><td>Log 1<\/td><td><span data-ste="quoted">2026-10-04 17:54:08<\/span><\/td><td class="tuning-num">8\.0 s<\/td><td><span class="tuning-muted">All flights of this log<\/span>/);
    assert.match(list, /<td>Log 2<\/td><td><span class="tuning-muted">No date<\/span><\/td><td class="tuning-num">8\.0 s<\/td><td><details class="tuning-fsel-sub" data-log="1"><summary title="Open or close the list of the flights of this log">2 of 2 flights<\/summary><div class="tuning-fsel-flights"><label class="tuning-fsel-flight"><input type="checkbox" class="tuning-fsel-one" data-log="1" data-flight="0" data-count="2" checked> Flight 1: 14\.3 s to 87 s \(72\.7 s\)<\/label><label class="tuning-fsel-flight"><input type="checkbox" class="tuning-fsel-one" data-log="1" data-flight="1" data-count="2" checked> Flight 2: 100 s to 130 s \(30\.0 s\)<\/label><\/div><\/details>/);
    assert.match(list, /data-log="2" disabled aria-label="Log 3"><\/td><td>Log 3<\/td><td><span data-ste="quoted">2026-10-04 18:03:13<\/span><\/td><td class="tuning-num"><\/td><td><span class="tuning-nodata">No data that the app can read<\/span> <span class="tuning-muted tuning-nodata-why" data-ste="quoted" title="Log truncated &lt;b&gt;x&lt;\/b&gt;">\(Log truncated &lt;b&gt;x&lt;\/b&gt;\)<\/span>/, 'M4: a log with no data');
    // the pilot opens the list and the flights of log 2 (the click comes before the details element opens): the state stays
    app.jq.fire('click', '.tuning-fsel-head', {}, { parentNode: { open: false } });
    app.jq.fire('click', '.tuning-fsel-sub > summary', {}, { parentNode: { open: false, getAttribute: () => '1' } });

    // no selection: the analysis does not start, and the view says what to do
    app.jq.fire('click', '.tuning-fsel-none');
    assert.match(app.html('.tuning-fsel'), /^<details class="tuning-fsel-box" open>[\s\S]*?tuning-fsel-count">no flight \(1 log with no data\)<\/span>/);
    assert.match(app.html('.tuning-fsel'), /<details class="tuning-fsel-sub" data-log="1" open><summary title="Open or close the list of the flights of this log">0 of 2 flights<\/summary>/);
    const before = app.workers.length;
    app.jq.fire('click', '.tuning-analyse');
    assert.equal(app.workers.length, before, 'no run');
    assert.match(app.html('.tuning-notices'), /Select one or more flights in the list\. Then click &quot;Start analysis&quot;\./);

    // flight 2 of log 2, and the full log 1
    app.jq.fire('change', '.tuning-fsel-one', { 'data-log': 1, 'data-flight': 1, 'data-count': 2 }, { checked: true });
    app.jq.fire('change', '.tuning-fsel-log', { 'data-log': 0 }, { checked: true });
    list = app.html('.tuning-fsel');
    assert.match(list, /tuning-fsel-count">1 of 2 flights, all flights of 1 of 1 other log \(1 log with no data\)<\/span>/);
    assert.match(list, /^<details class="tuning-fsel-box" open>/, 'the list stays open while the pilot selects');
    assert.match(list, /class="tuning-fsel-log" data-log="1" aria-label="Log 2" data-partly="1">/, 'log 2: some of its flights');
    assert.match(list, /data-log="1" data-flight="1" data-count="2" checked>/);
    app.jq.fire('click', '.tuning-analyse');
    const runs = analyseWorkers(app, 'analyseFile');
    assert.equal(runs.length, 1);
    const msg = runs[0].sent[0].msg;
    assert.deepEqual(plain(msg.options.flights), [{ log: 0, flight: null }, { log: 1, flight: 1 }], '0-based logs and flights; null: every flight of the log');
    assert.equal(msg.selectedLog, 1, 'the open log is in the selection: its curves and header');
    assert.equal(msg.options.gains, true);
    runs[0].reply({ type: 'result', result: synthResult({ scope: 'file', logs: [0, 1], logIndex: 1, records: [rec] }) });
    const ctx = app.html('.tuning-context');
    assert.match(ctx, /<div>Selected flights<\/div><div>Flights in the analysis: log 1 \(all flights\), log 2 flight 2<\/div><div>Curves of log 2<\/div>/);
    assert.equal(app.jq.node('.tuning-progress-text').text.split(' in ')[0], 'Analysis completed: Selected flights');
    assert.deepEqual(plain(app.dialog.getSelection()), { scope: 'flights', flights: [{ log: 0, flight: null }, { log: 1, flight: 1 }],
        text: 'Flights in the analysis: log 1 (all flights), log 2 flight 2.' });

    // the selection is part of the key: another selection is another run, the same selection again is the cached result
    app.jq.fire('change', '.tuning-fsel-one', { 'data-log': 1, 'data-flight': 0, 'data-count': 2 }, { checked: true });
    assert.match(app.html('.tuning-fsel'), /tuning-fsel-count">2 of 2 flights, all flights of 1 of 1 other log \(1 log with no data\)</);
    assert.match(app.html('.tuning-notices'), /The logs or the flights are different from this result\./);
    app.jq.fire('change', '.tuning-fsel-one', { 'data-log': 1, 'data-flight': 0, 'data-count': 2 }, { checked: false });
    assert.doesNotMatch(app.html('.tuning-notices'), /are different from this result/, 'the cached result of this selection');
    assert.equal(analyseWorkers(app, 'analyseFile').length, 1, 'no run for a cached selection');

    // the selected flights of a known log only: "N flights in M logs"; select all, then no selection
    app.jq.fire('change', '.tuning-fsel-log', { 'data-log': 0 }, { checked: false });
    assert.match(app.html('.tuning-fsel'), /tuning-fsel-count">1 of 2 flights, all flights of 0 of 1 other log \(1 log with no data\)</);
    app.jq.fire('click', '.tuning-fsel-all');
    list = app.html('.tuning-fsel');
    assert.match(list, /data-log="0" checked aria-label="Log 1"/);
    assert.match(list, /data-log="1" checked aria-label="Log 2"/);
    assert.match(list, /data-log="2" disabled aria-label="Log 3"/, 'a log with no data stays out');
    app.jq.fire('click', '.tuning-fsel-none');
    assert.match(app.html('.tuning-fsel'), /tuning-fsel-count">no flight \(1 log with no data\)</);
    assert.deepEqual(app.errors, []);
    noRawMarkup(app);
});

test('SPEC3 D: a bench run cannot be selected; before a result each log is a full log; the selection goes with its file', () => {
    const app = setup({ logCount: 3, current: 0 });
    app.setFile(datedFile(), 'gaui.bbl');
    app.show();
    // before a result: each log as a full log, the help says so
    app.jq.fire('change', '.tuning-scope', {}, { value: 'flights' });
    let list = app.html('.tuning-fsel');
    assert.match(list, /The list shows the flights of a log after an analysis of that log\. Before that, select the full log\./);
    assert.equal((list.match(/All flights of this log/g) || []).length, 3);
    // a result that finds no flight in log 1: "Bench run (no analysis)", not selectable
    const bench = Object.assign({}, synthResult().records[0], { log: 0, logClass: 'bench', phases: [], flights: [] });
    app.workers[0].reply({ type: 'result', result: synthResult({ records: [bench], logIndex: 0 }) });
    list = app.html('.tuning-fsel');
    assert.match(list, /data-log="0" disabled aria-label="Log 1"><\/td><td>Log 1<\/td>[\s\S]*?<span class="tuning-muted">Bench run \(no analysis\)<\/span>/);
    assert.match(list, /tuning-fsel-count">all flights of 2 of 2 logs \(1 bench run\)</, 'the default selection without the bench run');
    app.jq.fire('click', '.tuning-fsel-none');
    app.jq.fire('change', '.tuning-fsel-log', { 'data-log': 2 }, { checked: true });
    app.jq.fire('click', '.tuning-analyse');
    const run = analyseWorkers(app, 'analyseFile')[0];
    assert.deepEqual(plain(run.sent[0].msg.options.flights), [{ log: 2, flight: null }]);
    assert.equal(run.sent[0].msg.selectedLog, 2, 'the open log is not selected: the first selected log');
    // another file: its own selection, the default again (all flights of its 3 logs)
    app.load(Uint8Array.from({ length: 400 }, (_, i) => i & 0xff), 'other.bbl', fakeLog({ count: 3, current: 0 }));
    app.show();
    assert.match(app.html('.tuning-fsel'), /tuning-fsel-count">all flights of 3 of 3 logs</);
    assert.deepEqual(app.errors, []);
});

// --- SPEC3 E: the two filters of the result lists ----------------------------------------------------------------------

test('SPEC3 E: "Show results with not sufficient data" and "Show satisfactory results": off by default, the counts, the host keeps them', () => {
    // the filter of js/main.js: one state for the Tuning view and the log lens, each change to every listener
    let state = { thin: false, ok: false }, saved = [];
    const listeners = [];
    const hooks = { resultFilter: () => state, setResultFilter: (f) => { state = f; saved.push(plain(f)); listeners.forEach((cb) => cb(f)); return f; },
        onResultFilter: (cb) => { listeners.push(cb); return () => {}; } };
    const app = analysed({ hooks });
    assert.equal(listeners.length, 1, 'the view listens');
    app.tab('checks');
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    let t = app.html('.tuning-checks-table');
    assert.match(t, /^<div class="tuning-rf-bar"><label class="tuning-rf-item"><input type="checkbox" class="tuning-rf" data-rf="thin"> Show results with not sufficient data \(1\)<\/label><label class="tuning-rf-item"><input type="checkbox" class="tuning-rf" data-rf="ok"> Show satisfactory results \(2\)<\/label><span class="tuning-muted tuning-rf-hidden">The list does not show 3 results\.<\/span><\/div>/);
    assert.match(t, /13 of 16 results\./);
    assert.doesNotMatch(t, /st-insufficient">Not sufficient data|st-satisfactory">Satisfactory/);
    // "Satisfactory only" shows them, as the menu asks
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'ok' });
    assert.match(app.html('.tuning-checks-table'), /2 of 16 results\./);
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    // the filter goes to the host, which calls the listeners: the lists draw again
    app.jq.fire('change', '.tuning-rf', { 'data-rf': 'thin' }, { checked: true });
    assert.deepEqual(saved, [{ thin: true, ok: false }]);
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    t = app.html('.tuning-checks-table');
    assert.match(t, /data-rf="thin" checked> Show results with not sufficient data \(1\)/);
    assert.match(t, /The list does not show 2 results\./);
    assert.match(t, /14 of 16 results\./);
    // a change from the other view (the lens) draws this view again
    state = { thin: true, ok: true };
    listeners[0](state);
    app.tab('checks');
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    assert.match(app.html('.tuning-checks-table'), /16 of 16 results\./);
    assert.doesNotMatch(app.html('.tuning-checks-table'), /tuning-rf-hidden/, 'nothing hidden: no count of hidden rows');
    // the side panel of a step and the plot tabs: the same filters, with their own counts
    state = { thin: false, ok: false };
    listeners[0](state);
    app.tab('governor');
    app.detail('governor:checks');
    assert.match(app.pane('governor'), /Show satisfactory results \(\d+\)<\/label><span class="tuning-muted tuning-rf-hidden">The list does not show \d+ results?\./);
    const I = app.internals, fs = [{ id: 'A', severity: 'ok' }, { id: 'B', severity: 'note', thin: true }, { id: 'C', severity: 'flag' }];
    const got = I.filterResults(fs, { thin: false, ok: false });
    assert.deepEqual(plain(got.list.map((f) => f.id)), ['C']);
    assert.deepEqual(plain(got.counts), { thin: 1, ok: 1 });
    assert.equal(got.hidden, 2);
    assert.equal(I.filterBar({}, I.filterResults([{ id: 'C', severity: 'flag' }], {}), false), '', 'no bar for a list without the two kinds');
    assert.deepEqual(app.errors, []);
});

// --- 2026-10-06: the analysis uses all valid flights of the file by default; the flight lists collapse --------------------

// a file result that knows the flights of each log: log 1 a bench run, logs 2 and 3 one flight each
const fileResult = (over = {}) => synthResult(Object.assign({ scope: 'file', logs: [0, 1, 2], logIndex: 1, benchRuns: [0],
    flights: [{ log: 1, t0: 14.3, t1: 87, seconds: 72.7 }, { log: 2, t0: 2, t1: 6 }] }, over));

test('the default of "Logs" is all flights of the file: the view starts the file run at once, and another log in the viewer does not start it again', async () => {
    const app = setup({ scope: null });
    assert.match(app.html('#tuningBody'), /<option value="file" selected>All flights in the file<\/option><option value="flights">Selected flights<\/option><option value="log">This log<\/option>/);
    app.show();
    assert.equal(app.workers.length, 1, 'the automatic run');
    const { msg } = app.workers[0].sent[0];
    assert.equal(msg.cmd, 'analyseFile', 'all flights of the file, not the log on display');
    assert.equal(msg.selectedLog, 1, 'the curves and the header of the log on display');
    assert.equal(msg.bytes.byteLength, 400, 'the whole file');
    assert.equal(msg.options.flights, undefined, 'the worker leaves out the bench runs and the logs with no data');
    assert.equal(app.jq.node('.tuning-scope-text').text, 'Flights in the analysis: all flights of 3 of 3 logs.');
    assert.equal(app.jq.node('.tuning-scope option[value="file"]').text, 'All flights in the file', 'no result knows the flights yet');
    app.workers[0].reply({ type: 'result', result: fileResult() });
    assert.equal(app.jq.node('.tuning-scope-text').text, 'Flights in the analysis: 2 of 2 flights (1 bench run).');
    assert.equal(app.jq.node('.tuning-scope option[value="file"]').text, 'All flights in the file (2 flights)');
    assert.match(app.html('.tuning-context'), /<div>All flights in the file \(3 logs\)<\/div><div>Curves of log 2<\/div>/);
    assert.match(app.jq.node('.tuning-progress-text').text, /^Analysis completed: All flights in the file \(3 logs\)/);
    // the pilot looks at log 3 in the viewer: the same result, no new run (its key has no log)
    app.hooks.selectLog(2);
    app.show();
    assert.equal(app.workers.length, 1);
    assert.match(app.html('.tuning-notices'), /are for log 2\. The log viewer shows log 3\./);
    // the report says what the analysis used
    app.jq.fire('click', '.tuning-save');
    await new Promise((resolve) => setImmediate(resolve));
    const md = app.saved[0].text;
    assert.match(md, /\| Analysis \| All flights in the file \(3 logs\) \|/);
    assert.match(md, /\| Flights in the analysis \| 2 flights in 2 logs, 1 bench run \|/);
    // "This log" stays a choice, kept while the app is open: the next show uses it
    app.jq.fire('change', '.tuning-scope', {}, { value: 'log' });
    assert.equal(app.jq.node('.tuning-scope-text').text, 'The analysis uses only log 3. The log viewer shows this log.');
    app.show();
    assert.equal(app.workers.at(-1).sent[0].msg.cmd, 'analyseLog');
    assert.equal(app.workers.at(-1).sent[0].msg.logIndex, 2);
    assert.deepEqual(app.errors, []);
});

test('the flight list collapses: its head gives the counts, it is closed when a selection exists, a log with flights collapses them, the state stays', () => {
    const I = setup().internals;
    const rows = I.selectionRows([{ log: 0, seconds: 8 }, { log: 1, error: 'Log truncated' }, { log: 2, seconds: 3 }, { log: 3, seconds: 9 }, { log: 4, seconds: 9 }],
        { 2: { bench: true, flights: [] }, 3: { bench: false, flights: [{ t0: 1, t1: 5 }, { t0: 6, t1: 8 }, { t0: 9, t1: 12 }] }, 4: { bench: false, flights: [{ t0: 1, t1: 5 }] } },
        { '0:all': true, '3:0': true, '3:2': true, '4:all': true });
    eq(I.selectionCounts(rows), { flights: 4, flightsOn: 3, other: 1, otherOn: 1, bench: 1, noData: 1 });
    assert.equal(I.selectionHead(I.selectionCounts(rows)), 'Flights in the analysis: 3 of 4 flights, all flights of 1 of 1 other log (1 bench run, 1 log with no data)');
    assert.equal(I.selectionHead({ flights: 6, flightsOn: 6, other: 0, otherOn: 0, bench: 8, noData: 2 }), 'Flights in the analysis: 6 of 6 flights (8 bench runs, 2 logs with no data)', 'the example of the request');
    assert.equal(I.selectionHead({ flights: 0, flightsOn: 0, other: 3, otherOn: 0, bench: 0, noData: 0 }), 'Flights in the analysis: no flight');
    let html = I.selectionHtml(rows, true);
    assert.match(html, /^<details class="tuning-fsel-box"><summary class="tuning-fsel-head" title="Open or close the list of the flights"><strong>Flights in the analysis:<\/strong> <span class="tuning-fsel-count">3 of 4 flights, all flights of 1 of 1 other log \(1 bench run, 1 log with no data\)<\/span><\/summary>/, 'a selection: closed');
    assert.match(html, /<details class="tuning-fsel-sub" data-log="3"><summary title="Open or close the list of the flights of this log">2 of 3 flights<\/summary><div class="tuning-fsel-flights">/, 'three flights collapse under the row');
    assert.match(html, /<td><label class="tuning-fsel-flight"><input type="checkbox" class="tuning-fsel-one" data-log="4" data-flight="0" data-count="1" checked> Flight 1: 1 s to 5 s \(4\.0 s\)<\/label><\/td>/, 'one flight: no sub list');
    assert.match(I.selectionHtml(I.selectionRows([{ log: 0, seconds: 8 }], {}, {}), false), /^<details class="tuning-fsel-box" open>/, 'no selection: open');
    html = I.selectionHtml(rows, true, { open: true, subOpen: { 3: true } });
    assert.match(html, /^<details class="tuning-fsel-box" open>/);
    assert.match(html, /<details class="tuning-fsel-sub" data-log="3" open>/);
    assert.match(I.selectionHtml(rows, true, { open: false }), /^<details class="tuning-fsel-box">/);
    // keyboard: the control that had the focus gets it again after the list is drawn again
    const app = setup();
    const focusAt = (a, inside = true) => { app.context.document.activeElement = a; return app.internals.fselFocus({ contains: (x) => inside && x === a }); };
    const el = (className, attrs = {}, tagName = 'INPUT', parentNode) => ({ className, tagName, parentNode, getAttribute: (k) => (k in attrs ? String(attrs[k]) : null) });
    assert.equal(focusAt(el('tuning-fsel-one', { 'data-log': 3, 'data-flight': 2 })), '.tuning-fsel-one[data-log="3"][data-flight="2"]');
    assert.equal(focusAt(el('tuning-fsel-log', { 'data-log': 1 })), '.tuning-fsel-log[data-log="1"]');
    assert.equal(focusAt(el('tuning-fsel-head', {}, 'SUMMARY')), '.tuning-fsel-head');
    assert.equal(focusAt(el('', {}, 'SUMMARY', { getAttribute: () => '3' })), '.tuning-fsel-sub[data-log="3"] > summary');
    assert.equal(focusAt(el('btn btn-default btn-xs tuning-fsel-none', {}, 'BUTTON')), '.tuning-fsel-none');
    assert.equal(focusAt(el('form-control input-sm tuning-scope', {}, 'SELECT')), '.tuning-scope');
    assert.equal(focusAt(el('tuning-fsel-one'), false), null, 'the focus is not in the list');
    const focused = [];
    app.internals.fselRefocus({ querySelector: (sel) => ({ focus: (o) => focused.push([sel, o.preventScroll]) }) }, '.tuning-fsel-head');
    eq(focused, [['.tuning-fsel-head', true]]);
    app.internals.fselRefocus({ querySelector: () => null }, '.tuning-fsel-head');
    app.internals.fselRefocus(null, null);
});

test('selecting logs and flights keeps the table scroll position and keyboard focus after each redraw', () => {
    const app = setup({ scope: 'file' });
    app.setFile(datedFile(), 'gaui.bbl');
    app.show();
    app.workers[0].reply({ type: 'result', result: fileResult() });
    app.dialog.scopeAction({ kind: 'scope', value: 'flights' });
    app.dialog.scopeAction({ kind: 'open', on: true });
    const node = app.jq.node('.tuning-fsel'), root = node.element;
    let html = node.html, wrap = { scrollTop: 0, scrollLeft: 0 }, active, selector, focused;
    // Replacing the HTML creates a new table at (0, 0) and removes the focused checkbox, as in Chromium.
    Object.defineProperty(node, 'html', { get: () => html, set(value) {
        html = value;
        wrap = { scrollTop: 0, scrollLeft: 0 };
        app.context.document.activeElement = null;
        active = Object.assign({}, active, { focus(options) { focused = options; app.context.document.activeElement = this; } });
    } });
    root.contains = (el) => el === active;
    root.querySelector = (sel) => sel === '.tuning-fsel-wrap' ? wrap : sel === selector ? active : null;
    for (const [className, checked] of [['tuning-fsel-log', false], ['tuning-fsel-log', true], ['tuning-fsel-one', false], ['tuning-fsel-one', true]]) {
        const attrs = { 'data-log': 2, 'data-flight': 0, 'data-count': 1 };
        selector = '.' + className + '[data-log="2"]' + (className === 'tuning-fsel-one' ? '[data-flight="0"]' : '');
        active = { className, checked, getAttribute: (key) => String(attrs[key]) };
        app.context.document.activeElement = active;
        wrap.scrollTop = 287.5;
        wrap.scrollLeft = 31;
        const before = wrap;
        app.jq.fire('change', '.' + className, attrs, { element: active });
        assert.notEqual(wrap, before, 'the selection redraws the table');
        assert.equal(wrap.scrollTop, 287.5, className + ': vertical scroll');
        assert.equal(wrap.scrollLeft, 31, className + ': horizontal scroll');
        assert.equal(app.context.document.activeElement, active, 'the replacement checkbox keeps the focus');
        assert.equal(focused.preventScroll, true);
        assert.match(html, checked ? /tuning-fsel-count">2 of 2 flights/ : /tuning-fsel-count">1 of 2 flights/);
    }
    assert.deepEqual(app.errors, []);
});

test('the "Logs" control of the Analysis view: scopePanel, scopeAction and onSettings share the settings and the flight list of the Tuning view', () => {
    const app = setup({ scope: null });
    app.setFile(datedFile(), 'gaui.bbl');
    const told = [];
    const off = app.dialog.onSettings(() => told.push(app.dialog.scopePanel().scope));
    app.show();
    let p = app.dialog.scopePanel();
    assert.equal(p.scope, 'file');
    assert.equal(p.running, true, 'the automatic run of the file');
    assert.match(p.html, /^<div class="tuning-scope-bar"><label class="tuning-field">Logs <select class="form-control input-sm tuning-scope" title="The logs and the flights that the analysis uses"><option value="file" selected>All flights in the file<\/option>/);
    assert.match(p.html, /<span class="tuning-scope-text tuning-muted">Flights in the analysis: all flights of 3 of 3 logs\.<\/span><\/div>$/, 'no list for all flights');
    app.workers[0].reply({ type: 'result', result: fileResult() });
    assert.equal(app.dialog.scopePanel().stale, false);
    // the pilot selects flights in the Analysis view: the same selection as the Tuning view, closed at first
    assert.equal(app.dialog.scopeAction({ kind: 'scope', value: 'flights' }), true);
    p = app.dialog.scopePanel();
    assert.equal(p.scope, 'flights');
    assert.equal(app.jq.node('.tuning-scope').val, 'flights', 'the Tuning view shows the same value');
    assert.match(p.html, /<div class="tuning-fsel"><details class="tuning-fsel-box"><summary class="tuning-fsel-head"[^>]*><strong>Flights in the analysis:<\/strong> <span class="tuning-fsel-count">2 of 2 flights \(1 bench run\)<\/span>/);
    assert.equal(p.stale, false, 'every flight is selected: the result of all flights is for these flights');
    const runs = app.workers.length;
    app.show();
    assert.equal(app.workers.length, runs, '"Selected flights": no automatic run, the pilot starts it after the selection');
    app.dialog.scopeAction({ kind: 'open', on: true });
    assert.match(app.dialog.scopePanel().html, /<details class="tuning-fsel-box" open>/, 'opened in one view, open in both');
    app.dialog.scopeAction({ kind: 'flight', log: 2, flight: 0, count: 1, on: false });
    assert.match(app.dialog.scopePanel().html, /tuning-fsel-count">1 of 2 flights \(1 bench run\)</);
    assert.equal(app.dialog.scopePanel().stale, true, 'another selection: the result on display is of other flights');
    assert.match(app.html('.tuning-notices'), /The logs or the flights are different from this result\./);
    assert.match(app.html('.tuning-fsel'), /tuning-fsel-count">1 of 2 flights \(1 bench run\)</, 'the list of the Tuning view too');
    app.dialog.scopeAction({ kind: 'none' });
    assert.match(app.dialog.scopePanel().html, /tuning-fsel-count">no flight \(1 bench run\)</);
    app.dialog.scopeAction({ kind: 'all' });
    assert.match(app.dialog.scopePanel().html, /tuning-fsel-count">2 of 2 flights \(1 bench run\)</);
    assert.equal(app.dialog.scopeAction({ kind: 'what' }), false);
    assert.equal(app.dialog.scopeAction(null), false);
    app.dialog.scopeAction({ kind: 'scope', value: 'file' });
    assert.equal(app.dialog.scopePanel().stale, false, 'the cached result of all flights again');
    assert.ok(told.length >= 5 && told.includes('flights') && told.at(-1) === 'file', 'the Analysis view draws its control again after each change');
    off();
    const n = told.length;
    app.dialog.scopeAction({ kind: 'scope', value: 'log' });
    assert.equal(told.length, n, 'removed');
    assert.deepEqual(app.errors, []);
});

test('SPEC3 D: the context bar of a run of selected flights: the selection with the known flight numbers, and only the selected logs', () => {
    const app = setup({ logCount: 3, current: 1 });
    app.setFile(datedFile(), 'gaui.bbl');
    app.show();
    app.jq.fire('change', '.tuning-scope', {}, { value: 'flights' });
    app.jq.fire('click', '.tuning-fsel-none');
    app.jq.fire('change', '.tuning-fsel-log', { 'data-log': 1 }, { checked: true });
    app.jq.fire('click', '.tuning-analyse');
    const run = analyseWorkers(app, 'analyseFile')[0], rec = synthResult().records[0];
    // the worker found the flights of each log of the file, and used the flight of log 2
    run.reply({ type: 'result', result: synthResult({ scope: 'file', logs: [1], logIndex: 1, records: [rec],
        flights: [{ log: 0, t0: 1, t1: 5 }, { log: 1, t0: 14.3, t1: 87, seconds: 72.7 }, { log: 2, t0: 2, t1: 6 }],
        selection: { flights: [{ log: 1, flight: 0, t0: 14.3, t1: 87 }], windows: [{ log: 1, t0: 0, t1: 9 }], text: 'Flights in the analysis: log 2, flight 1 (14.3 s to 87.0 s).' } }) });
    const ctx = app.html('.tuning-context');
    assert.match(ctx, /<div>Flights in the analysis: log 2 flight 1<\/div>/, 'the full log 2, with the one flight that the result found in it');
    assert.match(ctx, /<summary>1 flight in 1 log\.<\/summary><ul><li>Log 2: 1 flight \(<a href="#" class="tuning-flight" data-log="1"/, 'the flights of the selected logs only');
    assert.doesNotMatch(ctx, /Log 1:|Log 3:/);
    assert.equal(app.dialog.getSelection().text, 'Flights in the analysis: log 2 flight 1.');
    // the list now knows the flight of log 2 (a full log of the selection), not those of the other logs
    const list = app.html('.tuning-fsel');
    assert.match(list, /data-log="1" data-flight="0" data-count="1" checked> Flight 1: 14\.3 s to 87 s \(72\.7 s\)/);
    assert.equal((list.match(/All flights of this log/g) || []).length, 2);
    assert.deepEqual(app.errors, []);
});

test('SPEC3 E: in the default list ("Problems, notes and analysis errors"), "Show satisfactory results" adds the satisfactory results', () => {
    const app = analysed();
    app.tab('checks');
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'issues' });
    assert.match(app.html('.tuning-checks-table'), /12 of 16 results\./);
    app.jq.fire('change', '.tuning-rf', { 'data-rf': 'ok' }, { checked: true });
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'issues' });
    const t = app.html('.tuning-checks-table');
    assert.match(t, /14 of 16 results\./, 'the 2 satisfactory results too');
    assert.match(t, /st-satisfactory">Satisfactory/);
    assert.match(t, /The list does not show 1 result\./, 'the result with not sufficient data stays out');
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'problems' });
    assert.doesNotMatch(app.html('.tuning-checks-table'), /st-satisfactory">Satisfactory/, '"Problems and analysis errors" only');
});

// --- SPEC3 J (M1): configurations -----------------------------------------------------------------------------------

// the stale of an A/B comparison and of its result (js/tuning_worker.js comparisonStale)
const AB_STALE = { reasons: ['switched'], findings: 1, source: 'The app uses the values of the log header of log 1.',
    text: '1 result of this pair uses a part of the log in which the values are possibly not the values of the log header. The cause is a different PID profile or rate profile. The app uses the values of the log header of log 1.' };
// result.datasets of tools/autotune/datasets.cjs: A and C in PID profile 1 (roll_p_gain 50 and 55), B in PID profile 2 with the
// PID profile values of log 1 and one value unknown; C12 of A, C5 of C, F5 of no single configuration
function withDatasets(r) {
    r.datasets = {
        datasets: [
            { id: 'A', pidProfile: 1, logs: [1], flights: [{ log: 1, flight: 0, t0: 14, t1: 87, seconds: 73 }], seconds: 100, flightSeconds: 73, assumed: false, unknown: [], summary: 'Configuration A has PID profile 1. It has 73 s of flight in log 2.',
                sources: { roll_p_gain: 'header', motor_poles: 'cli', yaw_expo: 'header', iterm_relax_type: 'none' } },
            { id: 'B', pidProfile: 2, logs: [1], flights: [], seconds: 30, flightSeconds: 0, assumed: true, assumedFrom: [{ log: 1, t0: 100, t1: 130, from: 0 }], unknown: ['yaw_p_gain'], summary: 'Configuration B has PID profile 2 <b>.' },
            { id: 'C', pidProfile: 1, logs: [1, 2], flights: [{ log: 1, flight: 1, t0: 100, t1: 130, seconds: 30 }], seconds: 160, flightSeconds: 150, assumed: false, unknown: [], newest: true,
                summary: 'Configuration C has PID profile 1. It has 2.5 min of flight in logs 2 and 3.' },
        ],
        labels: [{ log: 1, t0: 0, t1: 100, dataset: 'A', index: 0, pidProfile: 1, assumed: false }, { log: 1, t0: 100, t1: 130, dataset: 'B', index: 1, pidProfile: 2, assumed: true },
            { log: 1, t0: 130, t1: 300, dataset: 'C', index: 2, pidProfile: 1, assumed: false }],
        diff: [
            { name: 'roll_p_gain', group: 'pid', scope: 'profile', title: 'PID gains', values: { A: 50, B: null, C: 55 }, samePidProfile: true, unknownIn: ['B'], missingIn: [] },
            { name: 'motor_poles', group: 'rpmSignal', scope: 'global', title: 'RPM signal', values: { A: 14, C: 16 }, samePidProfile: true, unknownIn: [], missingIn: ['B'] },
            { name: 'yaw_expo', group: 'rates', scope: 'rate', title: 'Rates <b>', values: { A: 25, B: 20, C: 25 }, samePidProfile: false, unknownIn: [], missingIn: [] },
        ],
        pairs: [{ a: 'A', b: 'C', names: ['roll_p_gain', 'motor_poles'], unknown: [], samePidProfile: true }],
        info: [{ name: 'rescue_mode', group: 'rescue', title: 'Rescue', values: [{ value: 1, logs: [1], datasets: ['A'] }, { value: 0, logs: [2], datasets: ['C'] }] }],
        unknownNames: [{ name: 'foo_<b>', logs: [1] }], benchRuns: [], newest: 'C', newestByProfile: { 1: 'C', 2: 'B' },
        notes: ['The log header records the values of PID profile 2 only when the pilot arms the helicopter in PID profile 2.'],
        // advice.cjs comparisons: the A/B change of each result in configurations that are different in a few parameters
        // stale (js/tuning_worker.js comparisonStale): the union over the results of the two configurations, of the pair and of each result
        comparisons: [{ a: 'A', b: 'C', names: ['roll_p_gain'], values: { roll_p_gain: [50, 55] }, text: 'Configurations A and C are different only in `roll_p_gain` 50 against 55.', stale: AB_STALE,
            results: [{ check: 'C12', axis: 'roll', a: { mean: 31, se: 1, n: 3 }, b: { mean: 26.9, se: 0.8, n: 4 }, delta: -4.1, se: 1.2, unit: '%', significant: true,
                text: 'With `roll_p_gain` 55, the roll tracking error is 4.1 ± 1.2 % less than with 50.', stale: AB_STALE }] },
            { id: 'T8', a: 'A', b: 'B', names: [], delta: 0.2, se: 0.3, significant: false }],
    };
    r.findings.find((f) => f.fid === FID.C12).dataset = 'A';
    r.findings.find((f) => f.fid === FID.C5).dataset = 'C';
    Object.assign(r.advice.recommendations.find((x) => x.id === 'C7:pitch_f_gain:p1'), { dataset: 'C', supportedBy: ['A', 'C'],
        ab: [{ a: 'A', b: 'C', names: ['roll_p_gain'], delta: -0.12, se: 0.03, significant: true }, { a: 'A', b: 'B', names: [], delta: 0.01, se: 0.05, significant: false }],
        slope: { name: 'roll_p_gain', perUnit: -0.024, se: 0.006 } });
    return r;
}

test('recorded configurations sit before the tuning tabs and select one configuration for the entire workflow', () => {
    const app=analysed({result:withDatasets(synthResult())}), got=[];
    app.dialog.onConfiguration(id=>got.push(id));
    const root=app.html('#tuningBody');
    assert.ok(root.indexOf('class="tuning-fsel ')<root.indexOf('class="tuning-configuration '));
    assert.ok(root.indexOf('class="tuning-configuration ')<root.indexOf('class="tuning-tabs '));
    assert.equal(app.dialog.getConfiguration(),'C');
    let bar=app.html('.tuning-configuration');
    assert.match(bar,/<option value="C" selected>/);
    assert.doesNotMatch(bar,/<option value="all"/);
    for(const title of ['Recorded values of Configuration C','Compare recorded configurations','PID profile 1','PID profile 2'])assert.ok(bar.includes(title),title);
    assert.doesNotMatch(app.pane('overview'),/<select[^>]*tuning-config/);
    app.dialog.setConfiguration('A');
    eq(got,['A']);
    app.tab('checks');assert.ok(app.pane('checks').includes(FID.C12));assert.ok(!app.pane('checks').includes(FID.C5));
    app.tab('recs');assert.ok(!app.pane('recs').includes('data-rec="C7:pitch_f_gain:p1"'),'evidence from A does not apply a recommendation for C');
    app.dialog.setConfiguration('C');app.tab('checks');assert.ok(app.pane('checks').includes(FID.C5));assert.ok(!app.pane('checks').includes(FID.C12));
    assert.equal(app.dialog.setConfiguration('Z'),false);
    assert.equal(app.dialog.setConfiguration('B'),true);
    assert.match(app.html('.tuning-configuration'),/<option value="B" selected>/);
    const one=withDatasets(synthResult());one.datasets.datasets=one.datasets.datasets.slice(0,1);
    assert.match(app.internals.configBar({result:one},{dataset:'A'},{}),/Recorded values of Configuration A/,'one configuration still has its reference');
    assert.deepEqual(app.errors,[]);
});

test('a new analysis replaces an unavailable control configuration without imposing it on the filter flight source', async () => {
    const app=analysed({result:withDatasets(synthResult())}), changed=[];
    assert.equal(app.dialog.getConfiguration(),'C');
    app.dialog.onConfiguration(id=>changed.push(id));
    const next=withDatasets(synthResult());
    next.datasets.datasets.forEach(d=>{
        d.analysed=d.id!=='C';
        d.analysedFlightSeconds=d.id==='A'?40:0;
    });
    next.datasets.labels=next.datasets.labels.filter(q=>q.dataset==='A');
    app.flightLog.openLog(2);
    next.logIndex=2;
    const pending=app.dialog.runAnalysis();
    app.workers.at(-1).reply({type:'result',result:next});
    await pending;
    assert.equal(app.dialog.getConfiguration(),'A');
    eq(changed,['A']);
    assert.match(app.html('.tuning-configuration'),/<option value="A" selected>/);
    assert.match(app.html('.tuning-configuration'),/Recorded values of Configuration A/);
    assert.doesNotMatch(app.html('.tuning-configuration'),/Recorded values of Configuration C/);
    app.tab('filters');app.jq.fire('click','.tuning-ft-start');
    const request=ftWorker(app).sent[0].msg;
    assert.equal(request.options.configuration,undefined);
    eq(request.options.logs,[2]);
    eq(request.options.flights,[{log:2,flight:null}]);
    eq(request.options.recordedConfigurations.labels,[],'another log cannot supply the recorded intervals');
    assert.equal(app.dialog.setConfiguration('C'),false,'a configuration outside this analysis cannot become the active draft');
});

test('the initial tuning configuration has flight data when the last configuration is only on the ground', () => {
    const r=withDatasets(synthResult());
    r.datasets.datasets.find(d=>d.id==='C').flightSeconds=0;
    const app=analysed({result:r});
    assert.equal(app.dialog.getConfiguration(),'A');
    assert.match(app.html('.tuning-configuration'),/<option value="A" selected>/);
});

test('a ground-only control configuration does not prevent tuning the selected flight log', () => {
    const app=analysed({result:withDatasets(synthResult())});
    assert.equal(app.dialog.setConfiguration('B'),true);
    app.tab('filters');
    assert.doesNotMatch(app.pane('filters'),/tuning-ft-start" disabled/);
    assert.ok(app.jq.node('.tuning-configuration').classes.has('tuning-hide'));
    app.jq.fire('click','.tuning-ft-start');
    const q=ftWorker(app).sent[0].msg;
    eq(q.options.logs,[1]);assert.equal(q.options.configuration,undefined);
    eq(q.options.recordedConfigurations.labels.map(q=>q.dataset),['A','B','C']);
    const bench=analysed({result:synthResult({flights:[],benchRuns:[1]})});bench.tab('filters');
    assert.match(bench.pane('filters'),/The analysis has no flight data for filter tuning/);
    assert.match(bench.pane('filters'),/tuning-ft-start" disabled/);
    const count=bench.workers.length;bench.jq.fire('click','.tuning-ft-start');assert.equal(bench.workers.length,count);
});

test('SPEC3 J: the tab "Configurations": the configurations, the table "Parameters that are not the same" with "?" and "-", and the values that do not change the flight', () => {
    const app = analysed({ result: withDatasets(synthResult()) });
    assert.equal(app.jq.node('.tuning-tab[data-tab="configs"] .tuning-tab-count').text, '3');
    app.jq.fire('click', '.tuning-config-diff', {});
    let c = app.pane('configs');
    for (const s of ['A configuration is one PID profile and one set of the parameter values that change the flight.',
        '<tr class="tuning-config-row"><td><strong>B</strong></td><td>PID profile 2</td><td>Log 2</td><td class="tuning-num">0</td><td class="tuning-num">0.0 s</td><td>PID profile values from log 1, 1 value unknown, the newest of PID profile 2</td>',
        '<td>Values from the log header and the CLI dump</td>', '<h5 class="tuning-h">Parameters that are not the same</h5>',
        '<tr class="tuning-diff-row is-same-profile"><td><span class="tuning-param" title="roll_p_gain">Roll P</span><div class="tuning-muted">PID gains</div></td><td><code>50</code></td><td><span class="tuning-diff-unknown" title="The value is unknown">?</span></td><td class="is-selected"><code>55</code></td></tr>',
        '<td><span class="tuning-diff-absent" title="The configuration does not have this parameter">-</span></td>', '<tr class="tuning-diff-row"><td><span class="tuning-param" title="yaw_expo">Yaw expo</span><div class="tuning-muted">Rates &lt;b&gt;</div>',
        'A row with a mark has different values in two configurations of the same PID profile.', '<li><span class="tuning-param" title="rescue_mode">Rescue mode</span>: <code>1</code> (log 2), <code>0</code> (log 3)</li>',
        'Thus, the app uses them as parameters that change the flight: <span data-ste="quoted"><span class="tuning-param" title="foo_&lt;b&gt;">Foo &lt;b&gt;</span></span>.', '<li>The log header records the values of PID profile 2 only when the pilot arms the helicopter in PID profile 2.</li>',
        '<h5 class="tuning-h">Results of configurations that are different in some parameters</h5>',
        '<div class="tuning-ab-pair"><div><strong>Configuration A to Configuration C</strong>: <span class="tuning-param" title="roll_p_gain">Roll P</span> 50 to 55 <span class="tuning-badge st-stale" title="' + AB_STALE.text + '">Values possibly different</span></div>' +
            '<p class="tuning-muted">Configurations A and C are different only in <span class="tuning-param" title="roll_p_gain">Roll P</span> 50 against 55.</p>',
        '<tr><td class="tuning-ab-check"><strong>C12 roll</strong> <span class="tuning-badge st-stale" title="' + AB_STALE.text + '">Values possibly different</span><div class="tuning-muted">With <span class="tuning-param" title="roll_p_gain">Roll P</span> 55, the roll tracking error is 4.1 ± 1.2 % less than with 50.</div></td><td class="tuning-num">31.0 ± 1.0 %</td><td class="tuning-num">26.90 ± 0.80 %</td><td class="tuning-num">-4.1 ± 1.2 %</td><td>Yes</td></tr>',
        '<div class="tuning-ab-pair"><div><strong>Configuration A to Configuration B</strong>: <span class="tuning-muted">no parameter</span></div>',
        '<tr><td class="tuning-ab-check"><strong>T8</strong></td><td class="tuning-num"></td><td class="tuning-num"></td><td class="tuning-num">0.20 ± 0.30</td><td>No</td></tr>']) {
        assert.ok(c.includes(s), s);
    }
    app.jq.fire('click', '.tuning-config-pick', { 'data-config': 'B' });
    c = app.pane('configs');
    assert.ok(c.includes('<th class="is-selected">B<div class="tuning-muted">PID profile 2</div></th>'), 'the column of the configuration on display');
    assert.ok(c.includes('<tr class="tuning-config-row is-selected"><td><strong>B</strong>'));
    // the saved report has the configurations and the table
    const md = app.internals.markdown({ result: app.result, label: 'x', finishedAt: 0, scope: 'log' });
    assert.ok(md.includes('## Configurations') && md.includes('| `roll_p_gain` (same PID profile) | 50 | ? | 55 |') && md.includes('| `motor_poles` (same PID profile) | 14 | - | 16 |'));
    // a configuration that is not in the time of the analysis: in the table, not in the menu
    const sel = withDatasets(synthResult());
    Object.assign(sel.datasets.datasets[1], { analysed: false, analysedFlightSeconds: 0 });
    sel.datasets.datasets[0].analysed = true;
    sel.datasets.datasets[0].analysedFlightSeconds = 40;
    const app2 = analysed({ result: sel });
    app2.tab('configs');
    assert.ok(app2.pane('configs').includes('PID profile values from log 1, 1 value unknown, not in the analysis, the newest of PID profile 2'));
    assert.ok(!app2.pane('configs').includes('data-config="B"'), 'no "Show" for it');
    assert.ok(app2.html('.tuning-configuration').includes('<option value="A">Configuration A: PID profile 1, log 2, 40.0 s of flight</option>'), 'the flight time in the analysis');
    assert.ok(!app2.html('.tuning-configuration').includes('<option value="B">'));
    // "Show the configurations" of the Analysis view: the tab
    app2.tab('overview');
    assert.equal(app2.dialog.focus({ tab: 'configs' }), true);
    assert.equal(app2.jq.node('.tuning-tab[data-tab="configs"]').classes.has('active'), true);
    assert.equal(app2.dialog.focus({ tab: 'nowhere' }), false);
    // a result without configurations
    const none = analysed();
    none.tab('configs');
    assert.ok(none.pane('configs').includes('This result has no configurations. The analysis did not calculate them.'));
});

test('SPEC3 J: a recommendation shows its configuration, the configurations with data for it, the A/B pairs with SE and the measured slope', () => {
    const app = analysed({ result: withDatasets(synthResult()) });
    app.tab('recs');
    const card = app.pane('recs').slice(app.pane('recs').indexOf('Decrease the pitch F gain'));
    for (const s of ['<div class="tuning-muted">Cyclic · PID profile 1 · Configuration C · Calculated with the gain model</div>',
        '<div><span class="tuning-label">Configuration</span> Configuration C, the newest configuration of PID profile 1.</div>',
        '<div><span class="tuning-label">Data from</span> Configurations A and C.</div>',
        '<th>Configurations</th><th>Parameters that are not the same</th><th>Change of the result</th><th>More than 2 SE</th>',
        '<tr><td>A to C</td><td><span class="tuning-param" title="roll_p_gain">Roll P</span> 50 to 55</td><td class="tuning-num">-0.120 ± 0.030</td><td>Yes</td></tr>',
        '<tr><td>A to B</td><td><span class="tuning-muted">None</span></td><td class="tuning-num">0.010 ± 0.050</td><td>No</td></tr>',
        '<span class="tuning-label">Measured slope</span> For each change of 1 in <span class="tuning-param" title="roll_p_gain">Roll P</span>, the result changes by -0.0240 ± 0.0060.']) {
        assert.ok(card.includes(s), s);
    }
    // the worker's own text of the slope (STE, names in backticks)
    const I = app.internals, r = withDatasets(synthResult());
    assert.ok(I.recConfigHtml({ slope: { name: 'x', perUnit: 1, se: 0.1, text: 'For each 10 of `yaw_cw_stop_gain`, the yaw kick decreases by 4 deg/s.' } }, r).includes('For each 10 of <span class="tuning-param" title="yaw_cw_stop_gain">Yaw CW stop gain</span>, the yaw kick decreases by 4 deg/s.'));
    assert.equal(I.recConfigHtml({}, r), '', 'nothing without the fields');
});

// --- SPEC3 G (M2): the filter calculation ----------------------------------------------------------------------------

// tools/autotune/filter_tune.cjs tune() as the worker gives it (the fb1005 shape, shorter)
function synthFilterTune(over = {}) {
    const f = Float32Array.from({ length: 50 }, (_, i) => i * 10), c = (k) => Float32Array.from(f, (x, i) => k / (1 + i));
    const ax = (a, passed) => ({ passed, linesPassed: passed, delayPassed: true, windows: 46, medianLineErrorDb: 0.01, maxLineErrorDb: passed ? 0.06 : 1.6, linesUsed: 6, maxBandErrorDb: 0.15,
        delayMeasuredMs: 1.126, delayPredictedMs: 1.147 });
    const result = {
        version: 1, ms: { total: 9000 },
        model: { passed: false, parity: [{ log: 5, passed: true, axes: { roll: ax('roll', true), pitch: ax('pitch', true), yaw: ax('yaw', true) } },
            { log: 10, passed: false, axes: { roll: ax('roll', true), pitch: ax('pitch', false), yaw: ax('yaw', true) } }], rules: { lineDb: 1, bandDb: 1, delayMs: 0.3 }, notes: ['log 10: a toolkit note <b>'] },
        bench: [{ log: 0, reason: 'Bench run (no flight).' }], units: { kind: 'flight', n: 3, ids: ['log 5', 'log 10', 'log 11'] },
        recommended: { status: 'recommended', reasons: [], params: { DYN_NOTCH: true, dyn_notch_count: 2 },
            cli: ['feature DYN_NOTCH', 'set dyn_notch_count = 2', 'set dyn_notch_min_hz = 170', 'profile 0', 'set roll_d_cutoff = 25'],
            rows: [{ name: 'feature DYN_NOTCH', from: false, to: true, source: 'header', scope: 'global' }, { name: 'dyn_notch_count', from: '6', to: '2', source: 'header', scope: 'global' },
                { name: 'dyn_notch_min_hz', from: '20', to: '170', source: 'cli', scope: 'global' }, { name: 'roll_d_cutoff', from: 30, to: 25, source: 'cli', scope: 'profile', profile: 1 }],
            unknownProfiles: ['unknown'],
            predicted: { totalDb: -7.06, se: 0.51, axes: [{ axis: 'roll', db: -4.9, se: 0.51 }, { axis: 'pitch', db: -5.89, se: 0.49 }, { axis: 'yaw', db: -9.79, se: 1.32 }] },
            delay: { maxAddMs: 0.362, at: { log: 13, profile: 1, axis: 'pitch', path: 'P', hz: 30 }, f11MaxMs: 1.733, f11BaseMs: 1.386 },
            validation: { leaveOneOut: { unit: 'flight', folds: [{ unit: 'log 5', chosen: { DYN_NOTCH: true, dyn_notch_count: 2 }, heldOutDb: -5.12 }, { unit: 'log 10', chosen: { DYN_NOTCH: true, dyn_notch_count: 3 }, heldOutDb: -7.9 },
                { unit: 'log 11', chosen: { DYN_NOTCH: true, dyn_notch_count: 2 }, heldOutDb: 0.4 }], heldOutMeanDb: -4.21, heldOutSe: 2.5, sameAsFull: 2 } } },
        curves: { f, windows: 46, unit: '(deg/s)^2/Hz', roll: { raw: c(9), logged: c(4), predicted: c(4.1), candidate: c(1), pidOut: c(3), pidOutCandidate: c(0.5) },
            pitch: { raw: c(9), logged: c(4), predicted: c(4.1), candidate: c(1), pidOut: c(3), pidOutCandidate: c(0.5) }, yaw: { raw: c(9), logged: c(4), predicted: c(4.1), candidate: null, pidOut: c(3), pidOutCandidate: null } },
        notes: ['The file has 3 flight logs <i>.'],
    };
    return Object.assign(result, over);
}

// The worker of the filter calculation: the one whose first message is filterTune
function ftWorker(app) { return app.workers.filter((w) => w.sent.length && w.sent[0].msg.cmd === 'filterTune').at(-1); }

test('SPEC3 G: "Find the best filter values" in the Filters step and its tab: filterTune for the open file, the progress, and the result', () => {
    const app = analysed();
    // the side panel of the Filters step (the first "Start here") and the Filters tab have the button
    assert.ok(app.pane('overview').includes('<section class="tuning-ft is-compact" aria-label="Filter values from the flight logs">'), 'in the side panel of the Filters step');
    app.tab('filters');
    assert.ok(app.pane('filters').includes('<button type="button" class="btn btn-primary btn-sm tuning-ft-start">Autotune</button>'));
    assert.ok(app.pane('filters').includes('Autotune calculates the filter parameters.'));
    app.jq.fire('click', '.tuning-ft-start', {});
    const w = ftWorker(app), { msg, transfer } = w.sent[0];
    eq([msg.cmd, msg.fileName, msg.selectedLog, msg.logCount, msg.bytes.byteLength, transfer[0] === msg.bytes], ['filterTune', '<i>flight</i>.bbl', 1, 3, 400, true], 'the whole file, transferred (a copy)');
    eq(plain(msg.options), { flightRpm: 2000, cliText: null, cliName: null, flights: [{log:1,flight:null}], logs:[1], blockedBy: [], maxAddMs: .5 }, 'one source log and the flight rpm of the analysis on display');
    assert.equal(app.bytes.length, 400, 'the buffer of the viewer stays');
    assert.ok(app.pane('filters').includes('The app calculates the filter values. Wait for the result.') && app.pane('filters').includes('tuning-ft-cancel'), 'the progress and Cancel');
    w.reply({ type: 'progress', fraction: 0.4, text: 'The app tries 12 sets of values.' });
    assert.equal(app.jq.node('.tuning-ft-progress-text').text, 'The app tries 12 sets of values. (40 %)');
    assert.equal(app.jq.node('.tuning-ft-bar').css.width, '40.0%');
    w.reply({ type: 'filterTuned', result: synthFilterTune() });
    assert.equal(w.terminated, true, 'the worker of the calculation is released');
    const p = app.pane('filters');
    for (const s of ['<span class="tuning-badge st-problem">Recommendation</span>', 'Set the filter values of the table. The model calculates a decrease of 7.06 ± 0.51 dB of the vibration in the PID output.',
        '<tr><td>roll</td><td class="tuning-num">Decrease of 4.90 ± 0.51 dB</td></tr>', '<tr class="tuning-ft-total"><td>All axes</td><td class="tuning-num">Decrease of 7.06 ± 0.51 dB</td></tr>',
        'The largest increase of the time delay is 0.362 ms (pitch, PID profile 1, at 30 Hz). The time delay of the gyro filters (check F11) changes from 1.386 ms to 1.733 ms.',
        '<tr><td><span class="tuning-param" title="feature DYN_NOTCH">Dynamic notch filter</span></td><td>All PID profiles</td><td><code>false</code></td><td><code>true</code></td><td>Log header</td></tr>',
        '<tr><td><span class="tuning-param" title="roll_d_cutoff">Roll D cutoff</span></td><td>PID profile 1</td><td><code>30</code></td><td><code>25</code></td><td>CLI dump</td></tr>',
        '<pre>feature DYN_NOTCH\nset dyn_notch_count = 2\nset dyn_notch_min_hz = 170\nprofile 0\nset roll_d_cutoff = 25</pre>',
        'The &quot;Export&quot; tab has these commands. The app selects them first.', 'The PID profile of some logs is unknown. Thus, the app gives no CLI text for the cutoffs of that PID profile.',
        '<h6 class="tuning-h">Model check</h6>', 'The error must be 1 dB or less at the gyro lines, 1 dB or less in each band and 0.3 ms or less in the time delay.',
        '<tr><td>Log 6</td><td>roll</td><td class="tuning-num">0.01 dB, 0.06 dB</td><td class="tuning-num">0.15 dB</td><td class="tuning-num">1.126 ms, 1.147 ms</td><td class="tuning-num">46</td><td><span class="tuning-badge st-satisfactory">Agrees</span></td></tr>',
        '<tr><td>Log 11</td><td>pitch</td><td class="tuning-num">0.01 dB, 1.6 dB</td>', '<span class="tuning-badge st-monitor">Does not agree</span>',
        '<h6 class="tuning-h">Test on each flight</h6>', 'The vibration decreased in 2 of 3 logs. The mean change is a decrease of 4.2 ± 2.5 dB. In 2 of 3 tests, the app found the same values.',
        '<tr><td>Log 6</td><td class="tuning-num">-5.12 dB</td><td>Yes</td></tr>', '<tr><td>Log 11</td><td class="tuning-num">-7.9 dB</td><td>No</td></tr>',
        '<details class="tuning-toolkit" data-ste="quoted"><summary>Toolkit text (not STE)</summary><ul><li>The file has 3 flight logs &lt;i&gt;.</li><li>log 10: a toolkit note &lt;b&gt;</li></ul></details>',
        'class="tuning-ft-plot"', 'Autotune again']) {
        assert.ok(p.includes(s), s);
    }
    // the side panel: the short form, with a link to the tab
    app.tab('overview');
    const o = app.pane('overview');
    assert.ok(o.includes('<section class="tuning-ft is-compact"') && o.includes('Recommendation') && o.includes('<a href="#" class="tuning-tab-link" data-tab="filters">Show all the filter results</a>'));
    assert.ok(!o.includes('Model check'), 'the model check only in the tab');
    app.tab('filters');
    // "Show the measurement": the spectra of the axis of the tab, with captions
    const before = app.plots.length;
    app.jq.fire('click', '.tuning-ft-plot', {});
    const specs = app.plots.slice(before).map((q) => q.spec).filter((s) => /^(Gyro spectra|Vibration in the PID output)/.test(s.title));
    eq(specs.map((s) => s.title), ['Gyro spectra, roll (46 windows)', 'Vibration in the PID output, roll (46 windows)']);
    eq(specs[0].series.map((s) => s.name), ['gyroRAW, before the filters', 'gyroADC, as the log records it', 'gyroADC from the model, with the values of the log', 'gyroADC from the model, with the recommended values']);
    eq(specs[1].series.map((s) => s.name), ['with the values of the log', 'with the recommended values']);
    assert.equal(specs[0].y.log, true);
    assert.ok(app.pane('filters').includes('</canvas></div><p class="tuning-plot-caption">The gray curve is gyroRAW. The roll curve is gyroADC as the log records it. The blue curve is the model with the values of the log, and the green curve is the model with the recommended values.</p>'));
    app.jq.fire('click', '.tuning-axis', { 'data-axis': 'yaw' });
    const yaw = app.plots.slice(-2).map((q) => q.spec);
    eq(yaw[0].series.map((s) => s.name), ['gyroRAW, before the filters', 'gyroADC, as the log records it', 'gyroADC from the model, with the values of the log'], 'no recommended values for yaw');
    // a result for other settings, or of another file
    assert.ok(app.internals.filterSearchHtml({ state: 'done', result: synthFilterTune(), stale: true, other: true }, { copy: () => 0, plotId: () => 'p' }, {}).html.includes('This result is for a different file.'));
    // the pure parts: no plots without curves; the worker's own STE texts first
    eq(app.internals.ftPlotSpecs({}, 'roll'), []);
    const own = app.internals.filterSearchHtml({ state: 'done', result: synthFilterTune({ text: { summary: 'The dynamic notch filter removes the line at 284 Hz.', recommendation: 'Turn on `DYN_NOTCH` with 2 notch filters.',
        delay: 'The time delay increases by 0.4 ms.', validation: 'Each flight shows a decrease.', parity: 'The model agrees with 5 of 6 axes.' } }) }, { copy: () => 0, plotId: () => 'p' }, {}).html;
    for (const s of ['The dynamic notch filter removes the line at 284 Hz.', 'Turn on <code>DYN_NOTCH</code> with 2 notch filters.', 'The time delay increases by 0.4 ms.', 'Each flight shows a decrease.', 'The model agrees with 5 of 6 axes.']) assert.ok(own.includes(s), s);
    // r.stale of the recommendations of the search (js/tuning_worker.js filterStale): the caveat, once for each text
    const st = { reasons: ['resume'], text: 'This recommendation uses a part of the log in which the values are possibly not the values of the log header. The cause is a period with no data. The app uses the values of the log header of log 2.' };
    const recs = [{ id: 'F:filters', severity: 'check', scope: 'global', title: 'Filter values', cli: [], stale: st }, { id: 'F:filters:p1', severity: 'check', scope: 'profile', profile: 1, title: 'Cutoffs', cli: [], stale: st }];
    const marked = app.internals.filterSearchHtml({ state: 'done', result: synthFilterTune({ recommendations: recs }) }, { copy: () => 0, plotId: () => 'p' }, {}).html;
    eq(marked.split('<div class="tuning-rec-list is-stale"><div class="tuning-label">Values possibly different</div><div class="tuning-stale-text">' + st.text + '</div></div>').length - 1, 1, 'the caveat once');
});

test('SPEC3 G: the CLI lines of the calculation go into the Export tab, the feature lines too, selected first; one group of changes', () => {
    const app = analysed();
    app.tab('filters');
    app.jq.fire('click', '.tuning-ft-start', {});
    ftWorker(app).reply({ type: 'filterTuned', result: synthFilterTune() });
    app.tab('export');
    const x = app.pane('export');
    assert.ok(x.includes('Set the gyro filter values that the app found') && x.includes('Set the cutoffs of PID profile 1 that the app found'));
    assert.ok(x.includes('The app calculated these filter values.'));
    assert.ok(x.includes('Group of the calculated filter values: 2 changes. The app selects all of them, or none of them.'));
    const boxes = [...x.matchAll(/<input type="checkbox" class="tuning-pick" data-pick="(\d+)"( checked)?( disabled)?>/g)].map((m) => [+m[1], m[2] ? 'on' : m[3] ? 'off' : 'free']);
    eq(boxes.slice(-2), [[9, 'on'], [10, 'on']], 'after the 9 recommendations of the result, selected first');
    const q = app.deriveWorker().sent.filter((s) => s.msg.cmd === 'export').at(-1).msg;
    eq(q.picks, ['T7:yaw_collective_ff_gain:p1', 'C7:pitch_f_gain:p1', 'FT:global', 'FT:profile0']);
    const g = q.recs.find((r) => r.id === 'FT:global'), p0 = q.recs.find((r) => r.id === 'FT:profile0');
    eq([g.cli, g.scope, g.severity, g.group, g.groupSize], [['feature DYN_NOTCH', 'set dyn_notch_count = 2', 'set dyn_notch_min_hz = 170'], 'global', 'action', 'FT:filters', 2]);
    eq([p0.cli, p0.scope, p0.profile, p0.cliProfile], [['profile 0', 'set roll_d_cutoff = 25'], 'profile', 1, 0]);
    eq(plain(g.fromSets), { dyn_notch_count: '6', dyn_notch_min_hz: '20' });
    eq(plain(g.fromSources), { dyn_notch_count: 'log header', dyn_notch_min_hz: 'CLI dump' });
    // the advice of the worker, when it gives recommendations, takes the place of the view's own
    eq(app.internals.filterRecs(synthFilterTune({ recommendations: [{ id: 'F:filters', cli: ['set x = 1'] }, null] })).map((r) => r.id), ['F:filters']);
    eq(app.internals.filterRecs(synthFilterTune({ recommended: { status: 'not recommended', cli: [] } })), [], 'no change: nothing to export');
    // one change of the group off: neither goes into the CLI file
    app.jq.fire('change', '.tuning-pick', { 'data-pick': '10' }, { checked: false });
    eq(app.deriveWorker().sent.filter((s) => s.msg.cmd === 'export').at(-1).msg.picks, ['T7:yaw_collective_ff_gain:p1', 'C7:pitch_f_gain:p1']);
    // Different configuration input invalidates the replay and its export.
    app.tab('filters');
    app.jq.fire('change', '.tuning-cli-input', {}, { files: [{ name: 'configuration.txt', text: '# diff all\nprofile 0\nset gov_headspeed = 2400\n' }] });
    app.tab('export');
    assert.ok(!app.pane('export').includes('that the app found'));
    app.tab('filters');
    assert.ok(app.pane('filters').includes('This result is for different flights or a different CLI dump.'), 'the notice names the changed input');
});

test('SPEC3 G: the result of the worker: its STE texts in paragraphs, its recommendations (advice.cjs filterRecommendations) for the CLI file, and the gates of the Filters step', () => {
    const result = synthResult();
    result.hierarchy.nodes.filters.blockedBy = ['rpm'];
    const app = analysed({ result });
    app.tab('filters');
    app.jq.fire('click', '.tuning-ft-start', {});
    eq(plain(ftWorker(app).sent[0].msg.options.blockedBy), ['rpm'], 'the gates of the Filters step go to the worker');
    const rec = (o) => Object.assign({ node: 'filters', area: 'filters', severity: 'action', scope: 'global', group: 'F:filters', groupSize: 2, blockedBy: [], caveats: [], evidence: [], confidence: 'predicted' }, o);
    const text = { status: 'recommended', summary: 'The app calculated the vibration for 40 sets of filter values on 600 s of flight in logs 6 and 11.\nThe recommended set decreases the vibration.',
        parity: 'The model agrees with the recorded gyroADC in all 2 flight logs.\nThe app does not use the model for these axes.', recommendation: 'The recommended set has 2 changes: `dyn_notch_count` 2 and `roll_d_cutoff` (PID profile 1) 25.',
        delay: 'The recommended set adds 0.36 ms of time delay at 30 Hz.', validation: 'To make sure that the set is correct for other flights, the app selected the set again without each flight log (3 tests).', why: [], rows: [] };
    ftWorker(app).reply({ type: 'filterTuned', result: synthFilterTune({ text, recommendations: [
        rec({ id: 'F:filters', title: 'Set the gyro filters of the filter search', cli: ['feature DYN_NOTCH', 'set dyn_notch_count = 2'] }),
        rec({ id: 'F:filters:p1', scope: 'profile', profile: 1, cliProfile: 0, title: 'Set the PID cutoffs of the filter search on PID profile 1', cli: ['profile 0', 'set roll_d_cutoff = 25'] })] }) });
    let p = app.pane('filters');
    for (const s of ['<p class="tuning-ft-summary">The app calculated the vibration for 40 sets of filter values on 600 s of flight in logs 6 and 11.</p><p class="tuning-ft-summary">The recommended set decreases the vibration.</p>',
        '<p class="tuning-ft-text">The recommended set has 2 changes: <span class="tuning-param" title="dyn_notch_count">Dynamic notch filter count</span> 2 and <span class="tuning-param" title="roll_d_cutoff">Roll D cutoff</span> (PID profile 1) 25.</p>', '<p class="tuning-ft-text">The recommended set adds 0.36 ms of time delay at 30 Hz.</p>',
        '<p class="tuning-ft-text">The model agrees with the recorded gyroADC in all 2 flight logs.</p><p class="tuning-ft-text">The app does not use the model for these axes.</p>',
        '<pre>feature DYN_NOTCH\nset dyn_notch_count = 2\nprofile 0\nset roll_d_cutoff = 25</pre>']) {
        assert.ok(p.includes(s), s);
    }
    app.tab('export');
    assert.ok(app.pane('export').includes('Group of the calculated filter values: 2 changes.'));
    const q = app.deriveWorker().sent.filter((x) => x.msg.cmd === 'export').at(-1).msg;
    assert.ok(q.picks.includes('F:filters') && q.picks.includes('F:filters:p1'), 'the recommendations of the worker, selected first');
    // a gate of the Filters step: the worker gives the changes with blockedBy and no CLI text
    app.tab('filters');
    app.jq.fire('click', '.tuning-ft-start', {});
    ftWorker(app).reply({ type: 'filterTuned', result: synthFilterTune({ text, recommendations: [rec({ id: 'F:filters', title: 'Set the gyro filters of the filter search', cli: [], blockedBy: ['rpm'] })] }) });
    p = app.pane('filters');
    assert.ok(p.includes('<span class="tuning-badge st-blocked">Blocked</span>'));
    assert.ok(p.includes('A step before the filters in the tuning sequence has a problem. Thus, the change has no CLI text until you correct it: <a href="#" class="tuning-node-link" data-node="rpm">RPM signal and motor poles</a>.'));
    assert.ok(!p.includes('<pre>feature DYN_NOTCH'), 'no CLI text');
    // no change: the reasons of the worker in STE
    app.jq.fire('click', '.tuning-ft-start', {});
    ftWorker(app).reply({ type: 'filterTuned', result: synthFilterTune({ recommended: { status: 'not recommended', reasons: ['raw text'], cli: [], rows: [], predicted: {} },
        text: Object.assign({}, text, { recommendation: '', why: ['The decrease of 1.2 ± 0.4 dB is less than 2 SE.'] }), recommendations: [rec({ id: 'F:filters', severity: 'check', title: 'The filter search: no change (to examine)', cli: [] })] }) });
    p = app.pane('filters');
    assert.ok(p.includes('<span class="tuning-badge st-satisfactory">No change</span>') && p.includes('<li>The decrease of 1.2 ± 0.4 dB is less than 2 SE.</li>') && !p.includes('raw text'));
});

test('SPEC3 G: cancel, an error of the worker, no flight log and no change', () => {
    const app = analysed();
    app.tab('filters');
    app.jq.fire('click', '.tuning-ft-start', {});
    let w = ftWorker(app);
    app.jq.fire('click', '.tuning-ft-cancel', {});
    assert.equal(w.terminated, true);
    assert.ok(app.pane('filters').includes('You canceled the analysis of the filter values.'));
    app.jq.fire('click', '.tuning-ft-start', {});
    w = ftWorker(app);
    w.reply({ type: 'error', message: 'The toolkit file "filter_tune.cjs" <b>' });
    assert.equal(w.terminated, true);
    assert.ok(app.pane('filters').includes('The analysis of the filter values stopped because of an error. <span data-ste="quoted">The toolkit file &quot;filter_tune.cjs&quot; &lt;b&gt;</span>'));
    app.jq.fire('click', '.tuning-ft-start', {});
    ftWorker(app).reply({ type: 'filterTuned', result: { version: 1, model: { parity: [], passed: false }, recommended: { status: 'no flight log', reasons: ['Bench run.'] }, notes: [] } });
    assert.ok(app.pane('filters').includes('The file has no flight log. Thus, the app cannot calculate filter values.'));
    assert.ok(app.pane('filters').includes('<span class="tuning-badge st-satisfactory">No change</span>'));
    app.jq.fire('click', '.tuning-ft-start', {});
    ftWorker(app).reply({ type: 'filterTuned', result: synthFilterTune({ recommended: { status: 'not recommended', reasons: ['The predicted change is -1.2 dB.'], cli: [], rows: [], predicted: { totalDb: -1.2, se: 0.4, axes: [] } } }) });
    const p = app.pane('filters');
    assert.ok(p.includes('The app does not recommend a change of the filter values.') && p.includes('<li><span data-ste="quoted">The predicted change is -1.2 dB.</span></li>'), 'the reasons of the toolkit, quoted');
    assert.ok(!p.includes('tuning-cli'), 'no CLI text');
    // a different file: the calculation stops
    app.jq.fire('click', '.tuning-ft-start', {});
    w = ftWorker(app);
    app.load(Uint8Array.from({ length: 50 }, (_, i) => i), 'other.bbl', app.flightLog);
    app.show();
    assert.equal(w.terminated, true, 'a calculation for another file stops');
});

test('M4: a log with no data that the app can read: "No data that the app can read" in the context bar, the flight list and the CLI file', () => {
    const r = synthResult({ scope: 'file', logs: [0, 1, 2] });
    r.records = r.records.concat([{ log: 2, segment: 0, noData: true, noDataReason: 'No frames <b>x</b>' }]);
    r.flights = [{ log: 1, t0: 14.3, t1: 87, seconds: 72.7 }];
    const fl = (() => { const app = analysed({ result: r }); return app.internals.flightsOf(r); })();
    eq([fl.noData, fl.bench, fl.logs[2].noData, fl.logs[2].why], [1, 0, true, 'No frames <b>x</b>']);
    assert.ok(fl && true);
    const html = (() => { const app = analysed({ result: r }); return app.internals.flightsHtml(fl, r, 1).join(''); })();
    assert.ok(html.includes('1 flight in 1 log. 1 log with no data that the app can read.'), html);
    assert.ok(html.includes('<li><span class="tuning-nodata">Log 3: No data that the app can read</span> <span class="tuning-muted tuning-nodata-why" data-ste="quoted" title="No frames &lt;b&gt;x&lt;/b&gt;">(No frames &lt;b&gt;x&lt;/b&gt;)</span></li>'));
    const app = analysed({ result: r });
    assert.equal(app.internals.flightsLine(fl), 'Log 2: 14.3 s to 87 s. Log 3: No data that the app can read.');
    // one log
    const one = app.internals.flightsHtml(fl, Object.assign({}, r, { scope: 'log' }), 2).join('');
    assert.ok(one.startsWith('<span class="tuning-nodata">Log 3: No data that the app can read</span>'));
    // the flight list: a log that a result knows has no data cannot be selected
    const rows = app.internals.selectionRows([{ log: 2, date: null, seconds: 5 }], { 2: { bench: false, flights: [], noData: true, why: 'No frames' } }, {});
    eq([rows[0].state, rows[0].selectable, rows[0].error], ['nodata', false, 'No frames']);
    assert.ok(app.internals.selectionHtml(rows, true).includes('<span class="tuning-nodata">No data that the app can read</span>'));
    // result.noData of the worker: [{ log, reason }], also for a log that has no record
    const only = app.internals.flightsOf({ records: [], noData: [{ log: 7, reason: 'The header is cut.' }] });
    eq([only.noData, only.logs[7].noData, only.logs[7].why], [1, true, 'The header is cut.']);
});

// --- The log is the only necessary input (user rule 2026-10-06): the optional CLI dump, the coverage, the basis of the PID
// profile at the start of each log, the notch orders of the log and a CLI dump that does not agree with the log ----------------

test('the CLI dump is an optional line under the controls; without one, no text names it: overview, report, intro, coverage', () => {
    const app = setup();
    const body = app.jq.node('#tuningBody').html, controls = body.indexOf('<div class="tuning-controls">'), line = body.indexOf('<div class="tuning-cli-line">');
    assert.ok(controls >= 0 && line > body.indexOf('tuning-actions'), 'the CLI dump is not in the main controls: its own line after them');
    for (const s of ['<span class="tuning-cli-label">Optional: CLI dump</span>', 'class="btn btn-default btn-xs tuning-cli-load"', '>Load</button>', '<span class="tuning-cli-name tuning-muted"></span>',
        '<input type="file" class="tuning-cli-input tuning-hide"',
        '<div class="tuning-cli-about tuning-muted">A CLI dump is the text of <code>diff all</code> from the CLI tab of the Configurator. The analysis is complete without a CLI dump. ' +
            'A CLI dump can add values that the log does not record, for example the rescue mode and the servo limits.</div>']) {
        assert.ok(body.slice(line).includes(s), s);
    }
    assert.ok(!body.slice(controls, line).includes('tuning-cli'), 'nothing of the CLI dump in the main controls');
    assert.ok(!/Load the output|Load CLI dump/.test(body), 'no instruction to load a CLI dump');
    app.show();
    const intro = app.html('.tuning-empty');
    assert.match(intro, /The analysis uses only the log file\.<\/p>/);
    assert.ok(!/With a CLI dump|notch filters/.test(intro), 'the old intro is gone');
    app.workers[0].reply({ type: 'result', result: synthResult() });
    assert.ok(!/CLI dump/.test(app.pane('overview')), 'overview: no "No CLI dump"');
    // coverage: "not-in-log" has its own label, not the label of "not-assessable"; no remedy that asks for a CLI dump
    app.tab('coverage');
    const c = app.pane('coverage'), I = app.internals;
    assert.match(c, /<span class="tuning-badge st-information">Not recorded in the log 1<\/span>/);
    assert.match(c, /<span class="tuning-badge st-insufficient">A log cannot show it 1<\/span>/);
    assert.notEqual(I.COVERAGE['not-in-log'][0], I.COVERAGE['not-assessable'][0]);
    assert.equal(I.COVERAGE['needs-cli'], undefined, 'the old key is gone');
    assert.ok(c.includes('For the groups with the condition &quot;Not recorded in the log&quot;, the log header and the log data do not record the values. Thus, the analysis cannot examine them.'));
    assert.ok(!/CLI dump necessary|load a CLI dump|needs-cli/i.test(c), 'no dead remedy, no raw key');
    // the report: no "CLI dump" row without one, the label of not-in-log in the parameter groups
    const md = I.markdown({ result: synthResult(), label: 'Log 2 of 3', finishedAt: 0, scope: 'log', cliName: null });
    assert.ok(!/\| CLI dump \|/.test(md) && !/\| none \|/.test(md), 'no "CLI dump: none"');
    assert.match(md, /\| Group 3 \| Area 3 \| Not recorded in the log \|/);
    const withDump = I.markdown({ result: Object.assign(synthResult(), { cli: { kind: 'diff', version: '4.6.0' } }), label: 'x', finishedAt: 0, scope: 'log', cliName: 'fireball.txt' });
    assert.match(withDump, /\| CLI dump \| fireball\.txt \(diff 4\.6\.0\) \|/, 'a loaded CLI dump is in the report');
    // a loaded CLI dump before a result: the intro says what the analysis uses
    const b = setup();
    b.jq.fire('change', '.tuning-cli-input', {}, { files: [{ name: 'dump.txt', text: '# diff all\nprofile 0\nset gov_mode = 1\n' }] });
    assert.match(b.html('.tuning-empty'), /The analysis uses the log file\. It also uses the values of the CLI dump that agree with the log\.<\/p>/);
});

// result.profiles.arming of js/tuning_worker.js: log 2 starts in PID profile 1, confirmed by "govRequest" (the headspeed step)
const HS_ARMING = { log: 1, profile: 1, basis: ['headspeed'], confirmed: true, estimate: null,
    headspeed: { headspeed: 3500, why: null, profile: 1, observations: { switches: 2, logs: 2 }, map: { 1: 3500, 2: 4500 } } };

test('D12: the basis of the PID profile at the start of a log: context bar, flight list, configurations and report', () => {
    const r = synthResult({ profiles: { pid: {}, rateChanges: [], arming: [HS_ARMING] } });
    r.records[0].profileSeconds = { 0: 200, 2: 50 };
    r.records[0].targetOf = { 0: 3500, 2: 4500 };
    const app = analysed({ result: r }), I = app.internals;
    const ctx = app.html('.tuning-context');
    assert.match(ctx, /<div>PID profile 1: 3500 rpm, 3\.3 min · PID profile 2: 4500 rpm, 50\.0 s<\/div>/, 'the part before the first change is in the confirmed PID profile, not "unknown"');
    assert.ok(ctx.includes('<div><span class="tuning-start" title="&quot;govRequest&quot; is 3500 rpm at the start of the log. Only PID profile 1 has this value at the PID profile changes of this log ' +
        '(2 changes in 2 logs).">Start: PID profile 1, from &quot;govRequest&quot;</span></div>'), ctx);
    // the other bases, and a PID profile that is not confirmed
    eq(I.startBasisText({ profile: 2, basis: ['event'], confirmed: true }, 'this file'), 'The log records a change to PID profile 2 at the first frame.');
    eq(I.startBasisText({ profile: 3, basis: ['cli', 'cliTarget'], confirmed: true }, 'this file'),
        'Only the CLI section of PID profile 3 agrees with the log header. At the start of the log, the governor target agrees with the "gov_headspeed" of PID profile 3 in the CLI dump.');
    eq(I.startBasisText({ profile: 0, basis: [], confirmed: false, estimate: 2 }, 'this file'),
        'The app cannot find the PID profile at the start of the log. The governor target agrees with PID profile 2. But the governor target does not show the PID profile without other data.');
    eq(I.startBasisText({ profile: 1, basis: ['headspeed'], confirmed: true, headspeed: { headspeed: 2300 } }, 'this file'),
        '"govRequest" is 2300 rpm at the start of the log. Only PID profile 1 has this value at the PID profile changes of this file.', 'no count without the observations');
    eq(I.startBasisText({ profile: 2, basis: ['govTarget'], confirmed: false, estimate: 2 }, 'this file').startsWith('The app cannot find'), true, 'an estimate does not confirm');
    assert.equal(I.startHtml(r, 0), '', 'a log without an arming result (a bench run)');
    assert.match(I.startHtml({ records: [], profiles: { arming: [{ log: 4, profile: 0, basis: [], confirmed: false, estimate: null }] } }, 4), />Start: PID profile unknown<\/span>$/);
    // the file: each log of the flight list with its start and the basis in its title (the map of the file)
    const f = synthResult({ scope: 'file', logs: [0, 1, 2], profiles: { pid: {}, rateChanges: [], arming: [Object.assign({}, HS_ARMING, { log: 0 }), HS_ARMING,
        { log: 2, profile: 2, basis: ['event'], confirmed: true, estimate: null, headspeed: null }] } });
    f.flights = [{ log: 0, t0: 5, t1: 50, seconds: 45 }, { log: 1, t0: 14.3, t1: 87, seconds: 72.7 }, { log: 2, t0: 3, t1: 9, seconds: 6 }];
    const list = I.flightsHtml(I.flightsOf(f), f, 1).join('');
    assert.ok(list.includes('<span class="tuning-start" title="&quot;govRequest&quot; is 3500 rpm at the start of the log. Only PID profile 1 has this value at the PID profile changes of this file (2 changes in 2 logs).">' +
        'Start: PID profile 1, from &quot;govRequest&quot;</span>.</li>'), list);
    assert.ok(list.includes('<span class="tuning-start" title="The log records a change to PID profile 2 at the first frame.">Start: PID profile 2, from the log event</span>.</li>'));
    // the configurations: the PID profile of a configuration with the basis of its logs that start in it, logs with the same basis together
    const d = withDatasets(f);
    d.datasets.datasets[2].logs = [0, 1, 2];
    const app2 = analysed({ result: d });
    app2.tab('configs');
    const cfg = app2.pane('configs');
    assert.ok(cfg.includes('<td><span class="tuning-start" title="Logs 1 and 2: &quot;govRequest&quot; is 3500 rpm at the start of the log. Only PID profile 1 has this value at the PID profile changes of this file ' +
        '(2 changes in 2 logs).">PID profile 1</span></td><td>Logs 1, 2 and 3</td>'), 'configuration C: logs 1 and 2 start in PID profile 1, log 3 does not');
    assert.ok(cfg.includes('<td><strong>B</strong></td><td>PID profile 2</td>'), 'B: no log of it starts in PID profile 2');
    // the report: a table of the PID profile at the start of each log with its basis
    const md = I.markdown({ result: f, label: 'All flights in the file', finishedAt: 0, scope: 'file' });
    assert.ok(md.includes('## PID profile at the start of each log\n\nThe log header has the values of the PID profile that is active when the pilot arms the helicopter.\n\n| Log | PID profile | Basis |'));
    assert.ok(md.includes('| 3 | PID profile 2 | The log records a change to PID profile 2 at the first frame. |'));
    // the curves: the label 0 of the modules is the confirmed PID profile at the start
    assert.equal(I.profilesText({ profileSeconds: { 0: 10, 1: 20, 3: 5 }, targetOf: { 0: 2300, 1: 2300, 3: 2700 } }, 1), 'PID profile 1: 2300 rpm, 30.0 s · PID profile 3: 2700 rpm, 5.0 s');
    assert.equal(I.profilesText({ profileSeconds: { 0: 10, 1: 20 }, targetOf: {} }, 0), 'PID profile 1: 20.0 s · PID profile unknown: 10.0 s', 'not confirmed: unknown, last');
    noRawMarkup(app);
});

// result.notchFit of js/tuning_worker.js notchFitOut: the tail rotor notch order of the log (sources 21 to 28)
const TAIL_FIT = { passed: true, order: 4.0019, se: 0.0016, n: 6, unit: 'flight', axis: 'yaw', depthDb: -40.1, sources: [21], Q: 5, reasons: [] };

function withTailNotch(r, hz) {
    for (const c of r.curves) for (const a of ['roll', 'pitch', 'yaw']) {
        c.more.vib.notches[a] = c.more.vib.notches[a].map((n) => n.code === 21 ? Object.assign({}, n, { order: hz === null ? null : 4.0019, hz }) : n);
        for (const p of Object.keys(c.more.vib.byProfile)) c.more.vib.byProfile[p].notches[a] = c.more.vib.byProfile[p].notches[a].map((n) => n.code === 21 ? Object.assign({}, n, { hz }) : n);
    }
    return r;
}

test('notchFit: the tail rotor notch filters from the log in the vibration plots and the Filters tab, and the text when the log does not show them', () => {
    // the fit is used: the markers say "from the log", the caption gives the order with its SE and the data
    const app = analysed({ result: withTailNotch(synthResult({ notchFit: { used: true, logs: [0, 1, 2], tail: TAIL_FIT, motor: null, ms: 2500 } }), 153.3) });
    app.jq.fire('click', '.tuning-axis', { 'data-axis': 'yaw' });
    let before = app.plots.length;
    app.tab('filters');
    let p = app.internals.vibCaption(app.result.curves[0],app.result,{axis:'yaw'}), specs = app.internals.vibPlots(app.result.curves[0],'yaw',app.result,{},{}).map(x=>x.spec);
    assert.ok(p.includes('<p class="tuning-muted tuning-notch-fit">Tail rotor notch filters: 4.002 ± 0.002 × the rotor frequency, from the log (yaw axis, 6 flight logs). ' +
        'The plots show these notch filters at this frequency.</p>'), p);
    const spectrum = specs.find((s) => /^Gyro spectrum before and after the filters, yaw/.test(s.title));
    const tail = spectrum.vlines.find((v) => /^tail rotor/.test(v.label));
    eq([tail.x, tail.label, tail.dash], [153.3, 'tail rotor 1× Q8, from the log', [2, 2]]);
    assert.ok(spectrum.vlines.some((v) => v.label === 'main rotor 2× &lt;b&gt; Q8' || /^main rotor 2×/.test(v.label)), 'the other notch filters as before');
    assert.ok(!/gear|ratio|pulley|teeth/i.test(p.match(/tuning-notch-fit">[^<]*/)[0]), 'the gear-ratio rule: no word about a gear ratio');
    eq(app.internals.notchFitRows(app.result), [['Tail rotor notch filters', '4.002 ± 0.002 × the rotor frequency, from the log (yaw axis, 6 flight logs)']]);
    assert.match(app.internals.markdown({ result: app.result, label: 'x', finishedAt: 0, scope: 'log' }), /\| Tail rotor notch filters \| 4\.002 ± 0\.002 × the rotor frequency, from the log \(yaw axis, 6 flight logs\) \|/);
    // 30 s blocks and a precise order: 4 decimals
    eq(app.internals.notchFitTexts({ notchFit: { used: true, tail: Object.assign({}, TAIL_FIT, { order: 4.0003, se: 0.0006, n: 4, unit: 'block' }) } }, []),
        ['Tail rotor notch filters: 4.0003 ± 0.0006 × the rotor frequency, from the log (yaw axis, 4 periods of 30 s).']);

    // the fit is not used: the log does not show the frequency, and the plots do not show these notch filters
    const failed = { used: false, logs: [1], tail: { passed: false, order: null, se: null, n: 2, unit: 'block', axis: null, depthDb: -3, sources: [21], Q: 5, reasons: [{ code: 'not deep', depthDb: -3 }] }, motor: null, ms: 900 };
    const app2 = analysed({ result: withTailNotch(synthResult({ notchFit: failed }), null) });
    before = app2.plots.length;
    app2.tab('filters');
    p = app2.internals.vibCaption(app2.result.curves[0],app2.result,{axis:'roll'});
    specs = app2.internals.vibPlots(app2.result.curves[0],'roll',app2.result,{},{}).map(x=>x.spec);
    assert.ok(p.includes('<p class="tuning-muted tuning-notch-fit">The log does not show the frequency of the tail rotor notch filters. Thus, the plots do not show these notch filters.</p>'), p);
    assert.ok(!specs.some((s) => (s.vlines || []).some((v) => /tail rotor/.test(v.label || ''))), 'no tail rotor marker');
    eq(app2.internals.notchFitRows(app2.result), [['Tail rotor notch filters', 'The log does not show the frequency.']]);
    // the motor notch filter (source 10) from the log, the tail rotor notch filters not
    eq(app2.internals.notchFitTexts({ notchFit: { used: true, tail: failed.tail, motor: Object.assign({}, TAIL_FIT, { order: 6.6678, se: 0.0008, sources: [10] }) } }, [{ code: 10, hz: 250 }]),
        ['The log does not show the frequency of the tail rotor notch filters.', 'Motor notch filter: 6.6678 ± 0.0008 × the rotor frequency, from the log (yaw axis, 6 flight logs). The plots show this notch filter at this frequency.']);
    // no fit (a CLI dump gave the orders, or the fit did not operate): a notch filter with no frequency is not hidden without a word
    const app3 = analysed();
    app3.tab('filters');
    assert.ok(app3.internals.vibCaption(app3.result.curves[0],app3.result,{axis:'roll'}).includes('<p class="tuning-muted tuning-notch-fit">The plots do not show 1 notch filter, because its frequency is unknown.</p>'));
    eq(app3.internals.notchFitTexts({ notchFit: null }, [{ code: 21, hz: 150 }]), [], 'all notch filters on display: nothing to say');
    eq(app3.internals.notchFitTexts({ notchFit: { used: true, tail: null, motor: null } }, []), [], 'no tail rotor notch filter in the log header');
});

test('result.cliStatus: a CLI dump that does not agree with the log gives a notice, the conflicts and the report; the log wins', () => {
    // the shapes of js/tuning_worker.js cliStatusOf: the text says what, with the names in backticks
    const conflicts = [{ what: 'gov_headspeed', profile: 1, cli: 1800, log: [3500], text: 'In the CLI dump, `gov_headspeed` of `profile 0` is 1800. The PID profile changes in this file show 3500 rpm for PID profile 1. The app uses the values of the log.' },
        { what: 'header', logs: [5], text: 'No section of the CLI dump agrees with the log header of log 6 <b>.' }, { what: 'profile' }];
    const app = analysed({ result: synthResult({ cliStatus: { name: 'fireball_0904.txt', used: true, conflicts } }) });
    const n = app.html('.tuning-notices');
    assert.ok(n.includes('<div class="tuning-notice is-warn"><strong>The CLI dump does not agree with the log.</strong> The analysis uses the values of the log.<ul class="tuning-cli-conflicts">' +
        '<li>In the CLI dump, <span class="tuning-param" title="gov_headspeed">Governor headspeed</span> of <code>profile 0</code> is 1800. The PID profile changes in this file show 3500 rpm for PID profile 1. The app uses the values of the log.</li>' +
        '<li>No section of the CLI dump agrees with the log header of log 6 &lt;b&gt;.</li><li><span data-ste="quoted">profile</span></li></ul></div>'), n);
    assert.ok(!/Load the CLI dump|load it again/.test(n), 'no instruction to load a CLI dump');
    const md = app.internals.markdown({ result: app.result, label: 'x', finishedAt: 0, scope: 'log', cliName: 'fireball_0904.txt' });
    assert.ok(md.includes('> **The CLI dump does not agree with the log.** The analysis uses the values of the log.\n\n- In the CLI dump, `gov_headspeed` of `profile 0` is 1800. ' +
        'The PID profile changes in this file show 3500 rpm for PID profile 1. The app uses the values of the log.\n- No section of the CLI dump agrees with the log header of log 6 <b>.\n- profile'), md);
    // many conflicts: 12 and the number of the others
    const many = Array.from({ length: 15 }, (_, i) => ({ what: 'p' + i, text: 'Different.' }));
    assert.match(app.internals.cliStatusHtml({ cliStatus: { name: 'x', used: true, conflicts: many } }), /<li>3 other differences\.<\/li><\/ul><\/div>$/);
    // a CLI dump that the analysis does not use, and one that agrees with the log or none: no conflict notice
    assert.equal(app.internals.cliStatusHtml({ cliStatus: { name: 'x', used: false, conflicts: [] } }),
        '<div class="tuning-notice is-info">The analysis does not use the CLI dump. The analysis uses the values of the log.</div>');
    assert.equal(app.internals.cliStatusHtml({ cliStatus: { name: 'x', used: true, conflicts: [] } }), '');
    assert.equal(app.internals.cliStatusHtml({ cliStatus: null }), '');
    const none = analysed();
    assert.ok(!/CLI dump/.test(none.html('.tuning-notices')), 'no CLI dump: no notice about it');
    noRawMarkup(app);
});

// --- Values that are possibly not current (CLAUDE.md, user rule 2026-10-06; js/tuning_worker.js freshnessOf) ---------------------

// The texts of js/tuning_worker.js FRESH and staleFrom, as the worker writes them (STE)
const FRESH_TEXT = {
    caveat: 'The log does not record a change that the transmitter or the Configurator makes after the pilot arms the helicopter.',
    reasons: { grace: 'After the pilot disarms the helicopter, the log continues for some seconds. The log does not record a change at this time.',
        rearm: 'The pilot armed the helicopter again in the same log. The log header has the values of the first arm only. A change between the arms is not in the log.',
        switched: 'This part of the log uses a PID profile or a rate profile that is not the one at the start of the log. The log header has only the values at the start of the log.',
        unlogged: '"govRequest" changes, and the log records no PID profile change at that time. Thus, the pilot possibly changed a value, and the log does not show the change.',
        adjusted: 'An in-flight adjustment changed a value. The log header has the value before the change.',
        resume: 'The log has a period with no data. The log does not record a change in that period.' } };
const OWN_SOURCE = 'The values come from the log header of log 2.';
const STALE_RESULT = 'This result uses a part of the log in which the values are possibly not the values of the log header. The cause is a second arm in the same log. ' + OWN_SOURCE;
const STALE_TWO = 'This result uses a part of the log in which the values are possibly not the values of the log header. The causes are a second arm in the same log and a different PID profile ' +
    'or rate profile. ' + OWN_SOURCE + ' Other parts have other sources.';
const STALE_PERIOD = 'This period is in a part of the log in which the values are possibly not the values of the log header. The cause is a second arm in the same log. ' + OWN_SOURCE;
const STALE_PERIOD2 = 'This period is in a part of the log in which the values are possibly not the values of the log header. The causes are a second arm in the same log and a different PID ' +
    'profile or rate profile. The values of PID profile 2 come from the log header of log 12, and the other values come from the log header of log 2.';
const STALE_REC = '1 result of this recommendation uses a part of the log in which the values are possibly not the values of the log header. The cause is a second arm in the same log. ' + OWN_SOURCE;
const SPAN_TEXT = {
    grace: 'The pilot disarmed the helicopter at 30 s, and the log does not record a change in this part. ' + OWN_SOURCE,
    rearm: 'The pilot armed the helicopter again at 35 s, and the log header has the values of the first arm only. ' + OWN_SOURCE,
    switched: 'The pilot armed the helicopter again at 35 s, and the log header has the values of the first arm only. This part flies PID profile 2, and the log header has the values of PID profile 1. ' +
        'The values of PID profile 2 come from the log header of log 12. The other values come from the log header of log 2.',
    resume: 'This part flies PID profile 2, and the log header has the values of PID profile 1. The log has no data for a period before 250 s, and the log does not record a change in that period. ' +
        'The values of PID profile 2 are unknown. The other values come from the log header of log 2.',
};
const FID_L4 = 'limits|L4|1|0|1|yaw|0';

// result.epochs of three logs: log 1 (a bench run) with a part that has a cause, log 2 with a disarm, a second arm, PID profile 2
// from the header of log 12 and a period with no data, log 3 with no cause. f.stale of C12 and C5, the periods of L4 (two of
// three with a stale), r.stale of the T7 change (with CLI text) and d.stale of the first decision
function withFreshness(r) {
    const H = { pid: 'header', rate: 'header' };
    const span = (t0, t1, arm, armed, pid, reasons, source, text) => ({ t0, t1, arm, armed, pidProfile: pid, rateProfile: 1, fresh: !reasons.length, reasons, adjust: [], check: null, source, text });
    r.epochs = [
        { log: 0, spans: [span(0, 10, 0, true, 1, [], H, ''), span(10, 15, 0, false, 1, ['grace'], H, SPAN_TEXT.grace)] },
        { log: 1, spans: [span(0, 30, 0, true, 1, [], H, ''), span(30, 35, 0, false, 1, ['grace'], H, SPAN_TEXT.grace), span(35, 120.5, 1, true, 1, ['rearm'], H, SPAN_TEXT.rearm),
            span(120.5, 250, 1, true, 2, ['rearm', 'switched'], { pid: 'log 11', rate: 'header' }, SPAN_TEXT.switched),
            span(250, 300, 1, true, 2, ['switched', 'resume'], { pid: 'none', rate: 'header' }, SPAN_TEXT.resume)] },
        { log: 2, spans: [span(0, 9, 0, true, 1, [], H, '')] },
    ];
    r.freshness = FRESH_TEXT;
    for (const f of r.findings) f.stale = null; // the worker gives each result a stale: null when the result has no part with a cause
    r.findings.find((f) => f.fid === FID.C12).stale = { reasons: ['rearm'], text: STALE_RESULT, source: OWN_SOURCE, spans: [{ log: 1, t0: 35, t1: 120.5 }] };
    r.findings.find((f) => f.fid === FID.C5).stale = { reasons: ['rearm', 'switched'], text: STALE_TWO, source: OWN_SOURCE, spans: [{ log: 1, t0: 35, t1: 120.5 }, { log: 1, t0: 120.5, t1: 250 }] };
    const ev = (tS, seconds, stale) => ({ t: tS + 0.15, t1: tS + 0.15 + seconds, tS, t1S: tS + seconds, seconds, value: seconds, side: 'lo', limit: -1250, phase: 'flight', profile: 1, with: [], same: [], stale });
    const periods = [ev(50, 0.1, { reasons: ['rearm'], text: STALE_PERIOD, spans: [{ log: 1, t0: 35, t1: 120.5 }] }), ev(20, 0.05, null),
        ev(130, 0.2, { reasons: ['rearm', 'switched'], text: STALE_PERIOD2, spans: [{ log: 1, t0: 120.5, t1: 250 }] })];
    r.findings.push({ module: 'limits', id: 'L4', node: 'tailcomp', tuner: true, severity: 'flag', log: 1, profile: 1, pidProfile: 1, axis: 'yaw', value: 0.35, se: null, n: 3, unit: 's',
        threshold: { longS: 0.1 }, source: 'pipeline, unvalidated', text: 'tail limit', times: [50.15, 20.15, 130.15], events: periods, fid: FID_L4,
        summary: 'In PID profile 1, the tail output is at its limit in 3 periods, for a total of 0.35 s.',
        stale: { reasons: ['rearm', 'switched'], text: STALE_TWO, source: OWN_SOURCE, spans: [{ log: 1, t0: 35, t1: 120.5 }, { log: 1, t0: 120.5, t1: 250 }] },
        evidence: { v: 1, fid: FID_L4, id: 'L4', log: 1, profile: 1, axis: 'yaw', view: null, plot: null, context: [],
            spans: periods.map((e) => ({ log: 1, t0: e.tS - 0.5, t1: e.t1S + 0.5, value: e.seconds, label: 'Tail limit' })) } });
    for (const x of r.advice.recommendations) x.stale = null;
    r.advice.recommendations.find((x) => x.id === 'T7:yaw_collective_ff_gain:p1').stale = { reasons: ['rearm'], findings: 1, text: STALE_REC, source: OWN_SOURCE };
    r.decisions[0].stale = { reasons: ['rearm'], text: STALE_RESULT, source: OWN_SOURCE, spans: [{ log: 1, t0: 35, t1: 120.5 }] };
    r.decisions[1].stale = null;
    return r;
}

// The row of the table in `html` whose check is `id`
const rowOf = (html, id) => html.split('<tr').find((t) => t.includes(`<td class="tuning-id">${id}<`)) || '';
const badgeOf = (text) => `<span class="tuning-badge st-stale" title="${text.replace(/"/g, '&quot;')}">Values possibly different</span>`;

test('values possibly different: a result with f.stale has the mark, its text and "Show in the log" to its parts; a result without it shows nothing extra', () => {
    const app = analysed({ result: withFreshness(synthResult()) }), asked = [];
    app.hooks.viewInLog = (req) => { asked.push(plain(req)); return true; };
    showAllResults(app);
    app.tab('checks');
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    const checks = app.html('.tuning-checks-table');
    // one part: "Show in the log", with the text in the bar over the graph
    const c12 = rowOf(checks, 'C12');
    assert.ok(c12.includes('<td class="tuning-text"><details class="tuning-stale"><summary>' + badgeOf(STALE_RESULT) + '</summary><div class="tuning-stale-text">' + STALE_RESULT + '</div>' +
        '<div class="tuning-stale-links"><a href="#" class="tuning-part" data-log="1" data-t0="35" data-t1="120.5" data-title="Values possibly different" data-text="' + STALE_RESULT + '" ' +
        'title="Show this part of the log">Show in the log</a></div></details><div class="tuning-summary-text">'), c12);
    app.jq.fire('click', '.tuning-part', { 'data-log': 1, 'data-t0': 35, 'data-t1': 120.5, 'data-title': 'Values possibly different', 'data-text': STALE_RESULT });
    app.jq.fire('click', '[data-tuning-log-act="viewer"]');
    eq(asked, [{ log: 1, fromS: 35, toS: 120.5, atS: 77.75, graphs: null, analyser: null, title: 'Values possibly different', text: STALE_RESULT }], 'frame seconds, the pilot\'s own graphs');
    // two parts: a link with the time of each
    assert.match(rowOf(checks, 'C5'), /<div class="tuning-stale-links">Show in the log: <a href="#" class="tuning-part" data-log="1" data-t0="35" data-t1="120\.5"[^>]*>35 s to 120\.5 s<\/a>, <a [^>]*data-t0="120\.5" data-t1="250"[^>]*>120\.5 s to 250 s<\/a><\/div>/);
    // a result with stale null, or with no stale at all: nothing extra
    for (const id of ['C13', 'F5', 'D2', 'G2']) assert.ok(!/tuning-stale|st-stale|tuning-part/.test(rowOf(checks, id)), id);
    eq(app.internals.staleHtml({ id: 'X', stale: null }), '');
    eq(app.internals.staleHtml({ id: 'X', stale: { reasons: [], text: '' } }), '', 'an empty stale is no mark');
    // the side panel of a step (findingsList) has the same mark under the summary
    app.tab('overview');
    app.jq.fire('click', '.tuning-node', { 'data-node': 'cyclic' });
    assert.ok(panelOf(app.pane('overview')).includes('<details class="tuning-stale"><summary>' + badgeOf(STALE_RESULT)), 'the side panel');
    noRawMarkup(app);
    assert.deepEqual(app.errors, []);
});

test('values possibly different: each period of a limits check with a stale has the mark on its link, and the mark of the result lists these periods', () => {
    const app = analysed({ result: withFreshness(synthResult()) }), asked = [];
    app.hooks.viewInLog = (req) => { asked.push(plain(req)); return true; };
    showAllResults(app);
    app.tab('checks');
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    const l4 = rowOf(app.html('.tuning-checks-table'), 'L4');
    // the evidence links of the periods: a stale period has the class is-stale and its text in the title, the other period not
    assert.ok(l4.includes('<a href="#" class="tuning-span is-stale" data-key="' + FID_L4 + '" data-span="0" title="Show this part of the log. ' + STALE_PERIOD + '">49.5 s</a>'), l4);
    assert.ok(l4.includes('<a href="#" class="tuning-span" data-key="' + FID_L4 + '" data-span="1" title="Show this part of the log">19.5 s</a>'), 'a period with no stale');
    assert.ok(l4.includes('class="tuning-span is-stale" data-key="' + FID_L4 + '" data-span="2" title="Show this part of the log. ' + STALE_PERIOD2 + '">129.5 s</a>'));
    // the mark of the result: its text, its parts, and the periods in these parts (each +- 0.5 s, with the text of the period)
    assert.match(l4, /<div class="tuning-stale-links">2 of 3 periods are in these parts: <a href="#" class="tuning-part" data-log="1" data-t0="49\.5" data-t1="50\.6" data-title="Values possibly different" data-text="This period is in a part[^"]*" title="Show this part of the log">50 s \(0\.1 s\)<\/a>, <a [^>]*data-t0="129\.5" data-t1="130\.7"[^>]*>130 s \(0\.2 s\)<\/a><\/div><\/details>/);
    app.jq.fire('click', '.tuning-part', { 'data-log': 1, 'data-t0': 129.5, 'data-t1': 130.7, 'data-title': 'Values possibly different', 'data-text': STALE_PERIOD2 });
    app.jq.fire('click', '[data-tuning-log-act="viewer"]');
    eq(asked[0], { log: 1, fromS: 129.5, toS: 130.7, atS: 130.1, graphs: null, analyser: null, title: 'Values possibly different', text: STALE_PERIOD2 });
    // the pure parts: the periods of a result, the period of an evidence span
    const I = app.internals, f = app.result.findings.find((x) => x.id === 'L4');
    eq(I.stalePeriods(f).map((p) => [p.log, p.a, +p.b.toFixed(3)]), [[1, 50, 50.1], [1, 130, 130.2]]);
    eq(I.spanStale(f, { log: 1, t0: 19.5, t1: 20.55 }), null);
    eq(I.spanStale(f, { log: 1, t0: 49.5, t1: 50.6 }).text, STALE_PERIOD);
    eq(I.spanStale(f, { log: 2, t0: 49.5, t1: 50.6 }), null, 'a span of another log');
    // a period with a stale in a result with none: the mark shows the period, with the text of the period
    const only = I.staleHtml({ id: 'L1', module: 'limits', log: 1, stale: null, events: [{ tS: 3, t1S: 3.2, stale: { reasons: ['grace'], text: STALE_PERIOD } }, { tS: 9, t1S: 9.1, stale: null }] });
    assert.ok(only.startsWith('<details class="tuning-stale"><summary>' + badgeOf('The values in this period are possibly different from the log header.') + '</summary>'), only);
    assert.match(only, /1 of 2 periods is in these parts: <a [^>]*data-t0="2\.5" data-t1="3\.7"[^>]*>3 s \(0\.2 s\)<\/a><\/div><\/details>$/);
    noRawMarkup(app);
});

test('values possibly different: a recommendation with r.stale has the caveat with its text and the mark in each list; its CLI text stays; a decision with d.stale has the mark', () => {
    const app = analysed({ result: withFreshness(synthResult()) });
    app.tab('recs');
    const recs = app.pane('recs'), card = recs.split('<div class="tuning-rec ').find((c) => c.includes('id="tuning1-rec-2"'));
    assert.ok(card.includes('<div class="tuning-rec-badges"><span class="tuning-badge st-problem">Change</span> ' + badgeOf(STALE_REC) + '</div>'), card);
    assert.ok(card.includes('<div class="tuning-rec-list is-stale"><div class="tuning-label">Values possibly different</div><div class="tuning-stale-text">' + STALE_REC + '</div></div>'), 'the caveat line');
    assert.ok(card.includes('<pre>profile 0\nset yaw_collective_ff_gain = 72</pre>'), 'a change with CLI text keeps it: the pilot reads the caveat');
    const others = recs.split('<div class="tuning-rec ').filter((c) => /^st-/.test(c) && !c.includes('id="tuning1-rec-2"'));
    assert.ok(others.length > 5 && others.every((c) => !c.includes('tuning-rec-list is-stale') && !c.includes('<div class="tuning-rec-badges">' + badgeOf(STALE_REC))), 'no caveat on the other cards');
    // the evidence rows of a card have the mark of their result (C5 under the K5 item)
    assert.ok(recs.split('<div class="tuning-rec ').find((c) => c.includes('Examine the roll oscillation')).includes('<details class="tuning-stale"><summary>' + badgeOf(STALE_TWO)));
    // the gain analysis: the decision with d.stale
    assert.ok(recs.includes('Decrease 1.75 ± 0.64 deg/s (2.7 SE).<div>' + badgeOf(STALE_RESULT) + '</div></td>'), 'the decision with d.stale');
    assert.ok(/No change\. <span data-ste="quoted">[^<]*<\/span><\/td>/.test(recs), 'the decision without it');
    // the CLI file: the mark next to the change in the list of the Export tab
    app.tab('export');
    assert.ok(app.pane('export').includes('<span class="tuning-badge st-problem">Change</span> ' + badgeOf(STALE_REC) + ' Increase the yaw collective precompensation &lt;b&gt;!&lt;/b&gt;</label>'));
    // the recommendations in the side panel of the step
    app.tab('overview');
    app.jq.fire('click', '.tuning-node', { 'data-node': 'tailcomp' });
    assert.ok(panelOf(app.pane('overview')).includes(badgeOf(STALE_REC)), 'the side panel');
    // a recommendation with stale null: the badges as before
    eq(app.internals.recBadges({ severity: 'check', stale: null }), '<span class="tuning-badge st-monitor">Check</span>');
    eq(app.internals.staleRecHtml({ stale: null }), '');
    noRawMarkup(app);
});

test('values possibly different: the flight list gives the parts with a cause of each log, and the link opens the parts in the Configurations tab', () => {
    // the file: a line for each flight log that has a part with a cause, the parts in its title; a bench run as before
    const f = withFreshness(fileResult());
    const app = analysed({ result: f }), I = app.internals, list = I.flightsHtml(I.flightsOf(f), f, 1).join('');
    const title = 'Disarmed after arm 1, 30 s to 35 s: disarmed.\nArm 2, 35 s to 120.5 s: armed again.\nArm 2, 120.5 s to 250 s: armed again, different PID profile or rate profile.\n' +
        'Arm 2, 250 s to 300 s: different PID profile or rate profile, period with no data.';
    assert.ok(list.includes(' <a href="#" class="tuning-fresh-link" title="' + title + '">The values are possibly different in 4 of 5 parts.</a></li>'), list);
    assert.match(list, /<li>Log 1: Bench run \(no analysis\)<\/li>/, 'a bench run: no parts');
    assert.match(list, /<li>Log 3: 1 flight \(<a [^>]*>2 s to 6 s<\/a>\)\.<\/li>/, 'a log with no part that has a cause: nothing extra');
    eq(plain(I.epochSummary(f, 2)), null);
    // one log: a line under its flights
    const one = analysed({ result: withFreshness(synthResult({ records: [Object.assign(synthResult().records[0], { flights: [{ t0: 14.3, t1: 87 }] })] })) });
    assert.ok(one.html('.tuning-context').includes('<div><a href="#" class="tuning-fresh-link" title="' + title + '">The values are possibly different in 4 of 5 parts of this log.</a></div>'));
    // the link: the Configurations tab, scrolled to the parts
    one.jq.fire('click', '.tuning-fresh-link', {});
    assert.equal(one.jq.node('.tuning-pane[data-pane="configs"]').classes.has('active'), true);
    assert.equal(one.elements['tuning1-fresh'].scrolled, 1);
    assert.ok(one.pane('configs').includes('<div class="tuning-fresh" id="tuning1-fresh">'));
    // the overview: the number of results with the mark, as a link to the same place
    assert.match(one.pane('overview'), /<div class="tuning-muted"><a href="#" class="tuning-fresh-link" title="Show the parts of the logs in the Configurations tab">3 of 17 results use values that are possibly different from the log header\.<\/a><\/div>/);
    eq(I.freshLine([{ stale: { reasons: ['grace'], text: 'x' } }, {}]), '<div class="tuning-muted"><a href="#" class="tuning-fresh-link" title="Show the parts of the logs in the Configurations tab">1 of 2 results uses values that are possibly different from the log header.</a></div>');
    noRawMarkup(app);
    noRawMarkup(one);
});

test('values possibly different: the Configurations tab has the caveat of result.freshness, the causes, the counts and the parts of each flight log; the report too', () => {
    const f = withFreshness(fileResult()), app = analysed({ result: withDatasets(f) });
    app.tab('configs');
    const cfg = app.pane('configs'), fresh = cfg.slice(cfg.indexOf('<div class="tuning-fresh"'));
    assert.ok(fresh.startsWith('<div class="tuning-fresh" id="tuning1-fresh"><h5 class="tuning-h">Values of the log header</h5><p class="tuning-muted">The log header has the values of the first arm in the log. ' +
        'In some parts of a log, the values are possibly different from the log header. Each result, period and recommendation that uses one of these parts shows the mark ' +
        '&quot;Values possibly different&quot;.</p><p class="tuning-fresh-caveat">' + FRESH_TEXT.caveat + ' Thus, a result without this mark can also use values that are different from the log header.</p>' +
        '<p class="tuning-muted">In this analysis, 3 of 17 results, 2 of 3 periods at a limit and 1 of 9 recommendations use one of these parts.</p>'), fresh);
    // the causes of the flight logs, in the order of the worker, with the texts of result.freshness (the bench run has no cause of its own here)
    assert.ok(fresh.includes('<dl class="tuning-fresh-causes"><dt>Disarmed</dt><dd>' + FRESH_TEXT.reasons.grace + '</dd><dt>Armed again</dt><dd>' + FRESH_TEXT.reasons.rearm +
        '</dd><dt>Different PID profile or rate profile</dt><dd>' + FRESH_TEXT.reasons.switched + '</dd><dt>Period with no data</dt><dd>' + FRESH_TEXT.reasons.resume + '</dd></dl>'));
    assert.ok(!fresh.includes('In-flight adjustment') && !fresh.includes('govRequest&quot; changes'), 'only the causes that the logs show');
    // a row for each part with a cause: the link, the arm, the PID profile and the rate profile, the causes (the text of the part in the title), the source
    assert.ok(fresh.includes('<p class="tuning-muted">The table shows the parts of the flight logs that have a cause. 1 log with no flight is not in the table.</p>'));
    assert.ok(fresh.includes('<tr><td>2</td><td><a href="#" class="tuning-part" data-log="1" data-t0="30" data-t1="35" data-title="Values possibly different" data-text="' + SPAN_TEXT.grace + '" ' +
        'title="Show this part of the log">30 s to 35 s</a></td><td>Disarmed after arm 1</td><td class="tuning-num">1</td><td class="tuning-num">1</td>' +
        '<td><span class="tuning-fresh-cause" title="' + SPAN_TEXT.grace + '">Disarmed</span></td><td>Log header</td></tr>'), fresh);
    assert.ok(fresh.includes('<td>Arm 2</td><td class="tuning-num">2</td><td class="tuning-num">1</td><td><span class="tuning-fresh-cause" title="' + SPAN_TEXT.switched + '">Armed again, different PID profile or rate profile</span></td>' +
        '<td>Log header of log 12 (PID profile), log header (rate profile)</td></tr>'));
    assert.ok(fresh.includes('>Different PID profile or rate profile, period with no data</span></td><td>Unknown (PID profile), log header (rate profile)</td></tr>'), 'the source "unknown"');
    assert.ok(fresh.includes('<tr><td>3</td><td colspan="6" class="tuning-muted">No known cause</td></tr>'), 'a flight log with no cause');
    assert.ok(!/<tr><td>1<\/td>/.test(fresh), 'no row of the bench run');
    eq((fresh.match(/<tr><td>2<\/td>/g) || []).length, 4, 'the 4 parts of log 2 with a cause, not the part with no cause');
    // the pure parts
    const I = app.internals;
    eq(I.causeText(['grace', 'switched', 'mixed']), 'Disarmed, different PID profile or rate profile, mixed', 'a cause that the view does not know, as it is');
    eq(I.sourceLabel({ pidProfile: 3, source: { pid: 'cli', rate: 'cli' } }), 'CLI dump');
    eq(I.sourceLabel({ source: { pid: 'recovered', rate: 'adjustment' } }), 'Calculated gains (PID profile), in-flight adjustment (rate profile)');
    eq(I.sourceLabel(null), 'Unknown');
    // a CLI dump that the log contradicts (result.cliStatus: not used, or a gov_headspeed conflict of that PID profile), as the log lens says it
    const old = { cliStatus: { used: true, conflicts: [{ what: 'gov_headspeed', profile: 3 }] } };
    eq(I.sourceLabel({ pidProfile: 3, source: { pid: 'cli', rate: 'header' } }, old), 'CLI dump that does not agree with the log (PID profile), log header (rate profile)');
    eq(I.sourceLabel({ pidProfile: 2, source: { pid: 'cli', rate: 'cli' } }, old), 'CLI dump');
    eq(I.sourceLabel({ pidProfile: 2, source: { pid: 'cli', rate: 'cli' } }, { cliStatus: { used: false, conflicts: [] } }), 'CLI dump that does not agree with the log');
    eq([I.armText({ arm: 0, armed: true }), I.armText({ arm: 2, armed: false }), I.armText({})], ['Arm 1', 'Disarmed after arm 3', '']);
    eq(I.epochsOf({ epochs: [{ log: 1, spans: [{ t0: 1 }] }, null, { log: 'x', spans: [] }] }), null, 'no part with a time');
    // no configurations: the section after the sentence
    const bare = analysed({ result: withFreshness(fileResult()) });
    bare.tab('configs');
    assert.match(bare.pane('configs'), /^<p class="tuning-na-text">This result has no configurations\. The analysis did not calculate them\.<\/p><div class="tuning-fresh" id="tuning1-fresh">/);
    // the report: the section, the parts, the caveat of each recommendation and the mark of each result
    const md = I.markdown({ result: f, label: 'All flights in the file', finishedAt: 0, scope: 'file' });
    assert.ok(md.includes('## Values of the log header\n\nThe log header has the values of the first arm in the log. In some parts of a log, the values are possibly different from the log header. ' +
        'Each result, period and recommendation that uses one of these parts shows the mark "Values possibly different".\n\n' + FRESH_TEXT.caveat +
        ' Thus, a result without this mark can also use values that are different from the log header.\n\nIn this analysis, 3 of 17 results, 2 of 3 periods at a limit and 1 of 9 recommendations use one of these parts.\n\n' +
        'The table shows the parts of the flight logs that have a cause.\n\n| Log | Part of the log | Arm | PID profile | Rate profile | Values from | Causes |'), md);
    assert.ok(md.includes('| 2 | 120.5 s to 250 s | Arm 2 | PID profile 2 | rate profile 1 | Log header of log 12 (PID profile), log header (rate profile) | ' + SPAN_TEXT.switched + ' |'));
    assert.ok(md.includes('- Values possibly different: ' + STALE_REC + '\n'), 'the caveat of the recommendation');
    assert.ok(md.includes('| tracking error | ' + STALE_RESULT + ' |'), 'the results table: the text of the mark');
    assert.ok(md.includes('| ' + STALE_RESULT + ' |\n'), 'the decision');
    noRawMarkup(app);
});

test('values possibly different: a result without epochs and stale shows no mark, no part and no caveat', () => {
    const app = analysed();
    for (const t of app.internals.TABS) app.tab(t.key);
    const all = app.allHtml();
    for (const bad of ['tuning-stale', 'st-stale', 'tuning-fresh', 'tuning-part', 'Values possibly different', 'possibly different']) assert.ok(!all.includes(bad), bad);
    const md = app.internals.markdown({ result: app.result, label: 'x', finishedAt: 0, scope: 'log' });
    assert.ok(!md.includes('## Values of the log header') && !md.includes('- Values possibly different:'), 'the report has no section');
    eq(app.internals.freshCounts(app.result), '');
    eq(app.internals.freshnessHtml(app.result, 'u'), '');
    // result.epochs with no part that has a cause: the caveat and "no cause", no mark on a result
    const r = synthResult({ epochs: [{ log: 1, spans: [{ t0: 0, t1: 300, arm: 0, armed: true, pidProfile: 1, rateProfile: 1, fresh: true, reasons: [], adjust: [], source: { pid: 'header', rate: 'header' }, text: '' }] }],
        freshness: FRESH_TEXT });
    const html = app.internals.freshnessHtml(r, 'u');
    assert.ok(html.includes('<p class="tuning-fresh-caveat">' + FRESH_TEXT.caveat + ' Thus, a result without this mark') && html.includes('<p class="tuning-muted">The app found no cause in the parts of the logs.</p>'));
    assert.ok(html.includes('<tr><td>2</td><td colspan="6" class="tuning-muted">No known cause</td></tr>'));
    assert.ok(!html.includes('In this analysis,'), 'no count without a mark');
});

test('filter autotune v2: complete setup, replay signals, trace selector, stale export and unvalidated labels', async () => {
    const app=analysed(), res=synthFilterTune();
    res.version=2; res.model.passed=true; res.model.reconstructed=true;
    res.model.coverage=[{log:5,gyroHz:4000,filterHz:2000,logHz:1000}];
    res.model.parity[0].axes.roll.reconstruction={samples:1000,interpolationRmsDegS:1.2,withheldRmsDegS:.4,passed:true};
    res.recommended.fullRows=res.recommended.rows.concat([{name:'gyro_lpf1_type',from:'NONE',to:'BESSEL',source:'header',scope:'global'},
        {name:'gyro_rpm_notch_source_roll',from:'0,0',to:Array(16).fill(11).join(','),source:'header',scope:'global'}]);
    res.recommended.validation={holdout:{blocks:3,meanDb:-5}};
    res.search={tested:360}; res.text=require('../tools/autotune/filter_autotune.cjs').texts(res);
    res.cliFile='# complete setup\nset gyro_lpf1_type = BESSEL\nsave\n';
    const data=[0,1,2].map(()=>Float32Array.of(1,2,1)), trace={log:5,profile:1,t:Float64Array.of(10,10.001,10.002),raw:data,logged:data,baseline:data,candidate:data,pidBaseline:data,pidCandidate:data,pidKnown:false};
    res.traces=[trace,{...trace,log:10,t:Float64Array.of(20,20.001,20.002)}];
    trace.native={...trace,t:Float64Array.of(10,10.0005,10.001,10.0015,10.002,10.0025),baseline:[0,1,2].map(()=>new Float32Array(6)),candidate:[0,1,2].map(()=>new Float32Array(6)),pidBaseline:[0,1,2].map(()=>new Float32Array(6)),pidCandidate:[0,1,2].map(()=>new Float32Array(6))};
    res.capabilities=require('../tools/autotune/filter_autotune.cjs').capabilities({segments:[]});
    res.checklist={confirmed:true,rows:['Cleared in replay','Remains','New issue','Unchanged','Not evaluated'].map((outcome,i)=>({id:'F'+(i+1),title:'Filter check',log:5,profile:1,axis:'roll',
        before:{status:i<2?'Issue':'Pass',issues:i<2?1:0,findings:[]},after:{status:i===4?'Not evaluated':i===1||i===2?'Issue':'Pass',issues:i===1||i===2?1:0,findings:[]},outcome}))};

    app.tab('filters'); app.jq.fire('click','.tuning-ft-start',{}); ftWorker(app).reply({type:'filterTuned',result:res});
    const html=app.pane('filters');
    for(const text of ['Filter parameters','BESSEL','Save filter CLI file','Flight interval','Filter analysis coverage','Show changed values only']) assert.ok(html.includes(text),text);
    const primary=app.plots.find(p=>p.spec.title==='Flight spectrum, roll');
    eq(primary.spec.series.map(s=>s.name),['Raw data','Previous filter (recorded)','New filter (calculated)']);
    assert.doesNotMatch(html,/tuning-ft-comparison|All filter parameters|Filter checks before and after|Replay checks and filter coverage/);
    assert.equal((html.match(/tuning-ft-checklist/g)||[]).length,1);
    assert.match(html,/<section class="tuning-ft-editor">/);
    assert.match(html,/<section class="tuning-ft-signals">/);
    assert.doesNotMatch(html,/class="[^"]*tuning-axis[ "]|Recorded flight checks and spectra/);
    assert.equal(app.plots.filter(p=>/^Gyro signals,/.test(p.spec.title)).length,3);
    assert.doesNotMatch(html,/tuning-step-picks/);
    assert.equal(app.plots.filter(p=>/Previous filter replay/.test(p.spec.title)).length,6);
    assert.ok(!app.plots.some(p=>/Vibration in the PID output|Replayed P and D/.test(p.spec.title)));
    assert.doesNotMatch(html,/The PID values are unknown/);
    const diagnostics=html.indexOf('<summary data-ft-detail="replay">');
    for (const p of app.plots.filter(p=>/Previous filter replay/.test(p.spec.title))) {
        assert.ok(html.indexOf('id="'+p.canvas.id+'"')>diagnostics, 'replay curves are in the collapsed diagnostics only');
        eq(p.spec.series.map(s=>s.ftCurve),['old','replay']);
    }
    assert.match(html,/tuning-ft-reconstruction/);assert.match(html,/gyro 4000 Hz/);
    assert.equal(app.plots.find(p=>/^Gyro signals,/.test(p.spec.title)).spec.series[2].y.length,6);
    app.jq.fire('click','.tuning-ft-workspace summary[data-ft-detail]', {'data-ft-detail':'replay'}, {parentNode:{open:false}});
    app.jq.fire('change','.tuning-ft-trace',{}, {value:'1'});
    assert.match(app.pane('filters'),/<details class="tuning-ft-details" open><summary data-ft-detail="replay">/);
    assert.ok(app.plots.some(p=>/^Gyro signals,/.test(p.spec.title)&&p.spec.series[0].x[0]===20));
    app.jq.fire('click','.tuning-ft-save',{}); await tick(); await tick();
    assert.equal(app.saved.at(-1).text,res.cliFile);
    const env={copy:()=>0,plotId:()=> 'filterplot'};
    const replaced=app.internals.filterSearchHtml({state:'done',result:res},env,{plot:true,trace:99});
    assert.ok(replaced.plots.some(p=>/^Gyro signals,/.test(p.spec.title)&&p.spec.series[0].x[0]===10));
    assert.match(replaced.html,/<option value="0" selected>/);
    const stale=app.internals.filterSearchHtml({state:'done',result:res,stale:true},env,{}).html;
    assert.match(stale,/tuning-ft-save" disabled/);
    res.recommended.status='not recommended';res.recommended.cli=[];res.recommended.reasons=['The recorded filter configuration does not agree with the replay on all axes.'];res.cliFile='';res.text=require('../tools/autotune/filter_autotune.cjs').texts(res);
    const bad=app.internals.filterSearchHtml({state:'done',result:res},env,{plot:true});
    assert.match(bad.html,/No recommendation/);assert.match(bad.html,/tuning-ft-save" disabled/);
    assert.ok(bad.plots.every(p=>p.spec.series.every(s=>!/recommended/i.test(s.name))));
});

test('filter curve controls select raw, recorded old and calculated new data without losing the draft or running analysis', () => {
    const app=analysed(), res=synthFilterTune({version:2});
    const axes=v=>[0,1,2].map(()=>Float32Array.of(v,v+1,v));
    res.traces=[{log:5,profile:1,t:Float64Array.of(10,10.001,10.002),raw:axes(9),logged:axes(4),baseline:axes(5),candidate:axes(1),pidBaseline:axes(3),pidCandidate:axes(2)}];
    res.parameters=[{key:'gyro_lpf1_static_hz',name:'gyro_lpf1_static_hz',from:100,to:130,source:'header',scope:'global',editable:true,range:[0,1000]}];
    app.tab('filters');app.jq.fire('click','.tuning-ft-start');const w=ftWorker(app);w.reply({type:'filterTuned',result:res});
    const primary=(axis='roll')=>app.plots.filter(p=>p.spec.title==='Flight spectrum, '+axis).at(-1).spec;
    const signal=(axis='roll')=>app.plots.filter(p=>p.spec.title==='Gyro signals, '+axis).at(-1).spec;
    const keys=spec=>spec.series.map(s=>s.ftCurve);
    const toggle=(key,checked)=>app.jq.fire('change','.tuning-ft-curve',{'data-ft-curve':key},{checked});
    for (const key of ['raw','old','new']) assert.match(app.pane('filters'),new RegExp('data-ft-curve="'+key+'" checked'));
    assert.equal(primary().series[0].y,res.curves.roll.raw);
    assert.equal(primary().series[1].y,res.curves.roll.logged, 'old is the recorded output, not the baseline replay');
    assert.equal(primary().series[2].y,res.curves.roll.candidate);
    assert.equal(primary().legend,false, 'the checkboxes are the only visibility controls');
    const messages=w.sent.length, plots=app.plots.length, destroyed=app.destroyed.length, html=app.pane('filters');
    app.jq.fire('input','.tuning-ft-param',{'data-param':'gyro_lpf1_static_hz'},{value:'175'});
    toggle('raw',false);eq(keys(primary()),['old','new']);eq(keys(signal()),['old','new']);
    toggle('old',false);eq(keys(primary()),['new']);assert.equal(signal().series[0].y,res.traces[0].candidate[0]);
    toggle('new',false);eq(keys(primary()),[]);eq(keys(signal()),[]);
    assert.equal(primary().emptyText,'Select a curve to show.');
    toggle('raw',true);eq(keys(primary()),['raw']);
    assert.equal(app.pane('filters'),html,'the pane and focused controls are not replaced');
    assert.equal(app.plots.length,plots);assert.equal(app.destroyed.length,destroyed);assert.equal(w.sent.length,messages);
    app.jq.fire('click','.tuning-axis',{'data-axis':'pitch'});
    eq(keys(primary('pitch')),['raw']);assert.equal(primary('pitch').series[0].y,res.curves.pitch.raw);
    assert.match(app.pane('filters'),/data-param="gyro_lpf1_static_hz"[^>]*value="175"/,'a curve selection does not discard the edit');
    app.tab('overview');app.tab('filters');eq(keys(primary()),['raw']);
    app.jq.fire('click','.tuning-ft-simulate');const request=w.sent.at(-1).msg;
    assert.equal(request.options.simulate.gyro_lpf1_static_hz,'175');
    w.reply({type:'filterTuned',result:{...res,mode:'simulation'}},request.id);
    eq(keys(primary()),['raw'],'visibility survives a new replay result');
    toggle('new',true);app.jq.fire('click','.tuning-axis',{'data-axis':'yaw'});
    // This fixture has new time signals but no new yaw spectrum. The curve keeps its proper identity.
    eq(keys(primary('yaw')),['raw']);eq(keys(signal('yaw')),['raw','new']);
    app.jq.fire('click','.tuning-axis',{'data-axis':'roll'});eq(keys(primary()),['raw','new']);
    assert.deepEqual(app.errors,[]);
});

test('filter comparison handles missing curves without relabeling replay as recorded data', () => {
    const app=setup(),res=synthFilterTune({version:2});
    res.curves.roll.raw=null;res.curves.roll.logged=null;res.curves.roll.pidOut=null;res.curves.roll.pidOutCandidate=null;
    res.recommended.status='not recommended';
    const out=app.internals.filterSearchHtml({state:'done',result:res},{plotId:()=> 'filterplot'},{});
    const primary=out.plots.find(p=>p.spec.title==='Flight spectrum, roll').spec;
    eq(primary.series.map(s=>s.name),['New filter (calculated, not confirmed)']);
    assert.equal(primary.series[0].y,res.curves.roll.candidate);
    for (const key of ['raw','old']) assert.match(out.html,new RegExp('data-ft-curve="'+key+'" checked'),'other axes retain available data');
    assert.match(out.html,/The new filter result is not confirmed/);
    assert.ok(!out.plots.some(p=>/PID output|P and D/.test(p.spec.title)));
});

test('one draft per recorded configuration, one final candidate per PID profile, and a shared compiled CLI diff', async () => {
    const r=withDatasets(synthResult());
    for(const d of r.datasets.datasets)d.values={roll_p_gain:d.id==='A'?50:d.id==='C'?55:70};
    const make=(id,p,node,name,to)=>({id:'change:'+name,dataset:id,profile:p,cliProfile:p-1,scope:'profile',severity:'action',node,area:node,
        title:'Set '+name,parameter:name,from:20,to,cli:['profile '+(p-1),'set '+name+' = '+to],evidence:[],blockedBy:[],causes:[]});
    r.advice.byDataset={A:[make('A',1,'cyclic','roll_d_gain',21)],C:[make('C',1,'cyclic','roll_d_gain',24),make('C',1,'tail','yaw_p_gain',81)],B:[make('B',2,'cyclic','roll_d_gain',30)]};
    r.advice.recommendations=[make('C',1,'cyclic','roll_d_gain',99)]; // Analysis keeps its file-wide advice.
    advice.configurationBases(r.datasets);
    const app=analysed({result:r});
    app.tab('cyclic'); app.detail('cyclic:checks'); assert.match(app.pane('cyclic'),/data-pick="0" checked/);
    assert.doesNotMatch(app.pane('cyclic'),/set roll_d_gain = 99/,'the tuning step uses only its configuration advice');
    app.jq.fire('change','.tuning-pick',{'data-pick':0},{checked:false});
    app.dialog.setConfiguration('A');app.tab('cyclic');assert.match(app.pane('cyclic'),/data-pick="0" checked/,'A has an independent default selection');
    app.dialog.setConfiguration('C');app.tab('cyclic');assert.doesNotMatch(app.pane('cyclic'),/data-pick="0" checked/,'C keeps its unchecked value');
    app.tab('export');await tick();
    assert.equal((app.pane('export').match(/class="form-control input-sm tuning-final-config"/g)||[]).length,2);
    let q=app.deriveWorker().sent.filter(x=>x.msg.cmd==='export').at(-1).msg;
    eq(q.recs.filter(x=>q.picks.includes(x.id)).map(x=>[x.dataset,x.parameter]),[['C','yaw_p_gain'],['B','roll_d_gain']]);
    app.jq.fire('change','.tuning-final-config',{'data-profile':1},{value:'A'});await tick();
    q=app.deriveWorker().sent.filter(x=>x.msg.cmd==='export').at(-1).msg;
    const chosen=q.recs.filter(x=>q.picks.includes(x.id));
    assert.ok(chosen.every(x=>x.dataset!=='C'));assert.ok(chosen.some(x=>x.dataset==='B'));
    assert.ok(chosen.some(x=>x.configurationBase && x.parameter==='roll_p_gain' && x.to===50),'the CLI restores A before applying its D change');
    const script=advice.exportScript(plain(q.recs),plain(q.picks),plain(q.meta));
    assert.match(script,/set roll_d_gain = 21/);assert.match(script,/set roll_d_gain = 30/);assert.match(script,/set roll_p_gain = 50/);
    assert.doesNotMatch(script,/set roll_d_gain = 24|set yaw_p_gain = 81/);
    assert.match(app.pane('export'),/Selected parameter changes/);assert.match(app.pane('export'),/<code>50<\/code>/);
    assert.deepEqual(app.errors,[]);
});

test('opening an Analysis result selects its recorded configuration and its own recommendation', () => {
    const r=withDatasets(synthResult()), id='T7:yaw_collective_ff_gain:p1';
    r.findings.find(f=>f.fid===FID.T8).dataset='A';
    const own={...r.advice.recommendations.find(q=>q.id===id),id:'configuration:A:'+id,dataset:'A'};
    r.advice.byDataset={A:[own],B:[],C:[]};
    const app=analysed({result:r});
    assert.equal(app.dialog.getConfiguration(),'C');
    assert.equal(app.dialog.focus({node:'tailcomp',fid:FID.T8,recs:[id]}),true);
    assert.equal(app.dialog.getConfiguration(),'A');
    assert.match(panelOf(app.pane('overview')),/tuning-node-rec is-focus/);
    assert.match(panelOf(app.pane('overview')),/set yaw_collective_ff_gain = 72/);
    app.jq.fire('click','.tuning-goto-rec',{'data-rec':0});
    assert.match(app.pane('recs'),/set yaw_collective_ff_gain = 72/);
    assert.deepEqual(app.errors,[]);
});

test('configuration tuning plots use the selected configuration across logs outside the viewer selection', () => {
    const r=withDatasets(synthResult()), curve=r.curves[0];
    r.datasets.curves=[{...curve,dataset:'A',log:0},{...curve,dataset:'B',log:2}];
    const app=analysed({result:r});
    app.dialog.setConfiguration('A');app.tab('governor');
    assert.match(app.pane('governor'),/Log 1\. Click a time plot/);
    app.dialog.setConfiguration('B');app.tab('governor');
    assert.match(app.pane('governor'),/Log 3\. Click a time plot/);
    assert.doesNotMatch(app.pane('governor'),/Log 2\. Click a time plot/);
    assert.deepEqual(app.errors,[]);
});

test('filter workspace keeps delay and edits per flight source, independent of the control configuration', async () => {
    const r=withDatasets(synthResult());for(const d of r.datasets.datasets)d.values={roll_p_gain:50};
    r.flights=[{log:1,t0:14,t1:87,seconds:73},{log:1,t0:140,t1:230,seconds:90}];
    r.advice.recommendations=[{id:'old-filter-advice',dataset:'C',scope:'profile',profile:1,cliProfile:0,node:'filters',area:'filters',severity:'action',title:'Set the filter cutoff',
        parameter:'roll_d_cutoff',from:10,to:20,cli:['profile 0','set roll_d_cutoff = 20'],evidence:[],causes:[],blockedBy:[]}];
    const app=analysed({result:r}), res=synthFilterTune({version:2,mode:'autotune'});
    res.parameters=[{key:'gyro_lpf1_type',name:'gyro_lpf1_type',from:'FIRST_ORDER',to:'BESSEL',source:'header',scope:'global',editable:true,choices:['FIRST_ORDER','BESSEL']},
        {key:'gyro_lpf1_static_hz',name:'gyro_lpf1_static_hz',from:100,to:130,source:'header',scope:'global',editable:true,range:[0,1000]}];
    res.recommended.fullRows=res.parameters;res.cliFile='set gyro_lpf1_type = BESSEL\nsave\n';
    app.tab('filters');app.jq.fire('input','.tuning-ft-delay',{}, {value:'1.25'});app.jq.fire('click','.tuning-ft-start');
    const w=ftWorker(app), initial=w.sent[0].msg;
    assert.equal(initial.options.maxAddMs,1.25);assert.equal(initial.options.configuration,undefined);
    eq(initial.options.flights,[{log:1,flight:null}]);
    eq(initial.options.recordedConfigurations.labels,r.datasets.labels);
    w.reply({type:'filterTuned',result:res});assert.equal(w.terminated,false,'keep reconstruction for interactive replay');
    app.jq.fire('input','.tuning-ft-param',{'data-param':'gyro_lpf1_static_hz'},{value:'170'});
    app.tab('export');await tick();assert.ok(!app.deriveWorker() || !app.deriveWorker().sent.some(q=>q.msg.cmd==='export'),'an unplayed edit has no pending filter commands');
    app.tab('filters');app.jq.fire('click','.tuning-ft-simulate');
    const msg=w.sent.at(-1).msg;
    assert.equal(msg.cmd,'filterReplay');assert.equal(msg.bytes,undefined);assert.equal(msg.workspaceKey,initial.workspaceKey);
    assert.equal(msg.options.simulate.gyro_lpf1_static_hz,'170');
    w.reply({type:'filterTuned',result:{...res,mode:'simulation'}},msg.id);
    app.dialog.setConfiguration('A');assert.equal(w.terminated,false,'a control configuration does not change the replay input');
    app.tab('filters');assert.match(app.pane('filters'),/value="1.25"/);assert.match(app.pane('filters'),/data-param="gyro_lpf1_static_hz"/);
    app.jq.fire('change','.tuning-ft-source-select',{}, {value:'1:0'});assert.equal(w.terminated,true);
    assert.match(app.pane('filters'),/value="0.5"/);assert.doesNotMatch(app.pane('filters'),/data-param="gyro_lpf1_static_hz"/,'a different flight starts with its own draft');
    app.jq.fire('change','.tuning-ft-source-select',{}, {value:'1:all'});
    assert.match(app.pane('filters'),/value="1.25"/);assert.match(app.pane('filters'),/data-param="gyro_lpf1_static_hz"/);
    app.jq.fire('change','.tuning-ft-delay',{}, {value:'0'});app.jq.fire('click','.tuning-ft-start');
    assert.equal(ftWorker(app).sent[0].msg.options.maxAddMs,0,'zero additional delay is allowed');
    assert.deepEqual(app.errors,[]);
});

test('compiled parameter record detects global conflicts but allows different values in distinct PID profiles', () => {
    const I=setup().internals;
    const rec=(id,scope,p,value)=>({id,scope,profile:p,severity:'action',cli:(scope==='profile'?['profile '+(p-1)]:[]).concat(['set '+(scope==='profile'?'roll_d_gain':'gyro_lpf1_static_hz')+' = '+value]),node:'filters',dataset:id});
    const recs=[rec('A','global',null,90),rec('B','global',null,110),rec('C','profile',1,20),rec('D','profile',2,40)];
    const plan=I.pendingPlan(recs,{0:true,1:true,2:true,3:true});
    assert.equal(plan.rows.length,3);assert.equal(plan.conflicts.length,1);assert.equal(plan.conflicts[0].name,'gyro_lpf1_static_hz');
    eq(plan.rows.filter(r=>r.scope==='profile').map(r=>r.index),[0,1]);
    const same=I.pendingPlan([{...rec('E','global',null,100),fromSets:{gyro_lpf1_static_hz:100}}],{0:true});
    assert.match(I.pendingDiffHtml(same),/<details><summary>Values that do not change in the CLI file \(1\)/);
    assert.doesNotMatch(I.pendingDiffHtml(same).split('<details>')[0],/<code>gyro_lpf1_static_hz/);
});

test('filter sources preserve original flight numbers and identify every recorded configuration in the comparison', async () => {
    const r=withDatasets(synthResult({scope:'file',logs:[0,1,2],benchRuns:[0],flights:[
        {log:1,t0:14,t1:200,seconds:186},{log:2,t0:20,t1:60,seconds:40}
    ]}));
    r.datasets.labels=r.datasets.labels.filter(q=>q.dataset!=='B');
    r.datasets.labels[0].t1=130;
    r.datasets.datasets.forEach(d=>{d.values={gyro_lpf1_static_hz:d.id==='A'?100:140,gyro_lpf1_type:1};
        for(let i=0;i<4;i++)d.values['motor_rpm_lpf['+i+']']=d.id==='A'?10+i:20+i;
    });
    const app=analysed({result:r,scope:'file'}), I=app.internals;
    eq(I.filterSources(r).map(s=>[s.key,s.log]),[['1:all',1],['2:all',2]],'bench data is not a tune source');
    const partial={...r,selection:{flights:[{log:1,flight:3,t0:140,t1:200}],all:[]},flights:[{log:1,t0:140,t1:200,seconds:60}]};
    const sources=I.filterSources(partial);eq(sources.map(s=>s.key),['1:3']);assert.match(sources[0].title,/Flight 4/);
    eq(I.filterBaseline(partial,sources[0]).map(q=>[q.id,q.t0,q.t1]),[['C',140,200]],'the selected flight clips baseline intervals');
    app.tab('filters');
    let html=app.pane('filters');
    assert.ok(html.indexOf('Flight data for this tune')<html.indexOf('Autotune</button>'));
    assert.match(html,/Recorded output includes 2 configurations/);
    assert.match(html,/14 s to 130 s/);assert.match(html,/130 s to 200 s/);
    const res=synthFilterTune({version:2,mode:'autotune'});
    res.parameters=[{key:'gyro_lpf1_static_hz',name:'gyro_lpf1_static_hz',scope:'global',from:140,to:140,editable:true,source:'header'},
        {key:'gyro_lpf1_type',name:'gyro_lpf1_type',scope:'global',from:'FIRST_ORDER',to:'FIRST_ORDER',choices:['NONE','FIRST_ORDER','SECOND_ORDER'],editable:true,source:'header'},
        {key:'motor_rpm_lpf',name:'motor_rpm_lpf',scope:'global',from:'20,21,22,23',to:'20,21,22,23',count:4,editable:true,source:'header'}];
    res.recommended.rows=[];res.recommended.fullRows=res.parameters.map(({choices,count,...q})=>q);
    res.recommendations=[{id:'F:filters',node:'filters',area:'filters',severity:'action',scope:'global',filterSearch:true,
        title:'Set the gyro filter values',cli:['set gyro_lpf1_static_hz = 140'],fromSets:{gyro_lpf1_static_hz:140},evidence:[],blockedBy:[]}];
    app.jq.fire('click','.tuning-ft-start');ftWorker(app).reply({type:'filterTuned',result:res});
    html=app.pane('filters');
    assert.match(html,/A: 100/);assert.match(html,/C: 140/,'even an unchanged last value is compared against earlier configurations');
    assert.match(html,/A: 10,11,12,13/);assert.match(html,/C: 20,21,22,23/,'indexed dataset arrays retain each configuration value');
    app.jq.fire('change','.tuning-ft-hide-unchanged',{}, {checked:true});
    assert.doesNotMatch(app.pane('filters'),/data-param="gyro_lpf1_type"/,'equivalent enum numbers and labels are not changes');
    assert.match(app.pane('filters'),/data-param="gyro_lpf1_static_hz"/,'an earlier configuration differs from the new value');
    assert.match(html,/The spectra average all flight windows used by the replay/);
    app.tab('export');await tick();
    const q=app.deriveWorker().sent.filter(q=>q.msg.cmd==='export').at(-1).msg;
    const filters=q.recs.filter(q=>q.id==='F:filters');assert.equal(filters.length,1,'one filter tune across all control drafts');
    assert.equal(filters[0].dataset,null);assert.equal(filters[0].filterSource,'Log 2 · Flight 1');
    assert.ok(q.picks.includes('F:filters'));
    app.tab('filters');app.jq.fire('click','.tuning-ft-start');
    res.recommended.params={};res.recommended.status='not recommended';res.recommendations=[];
    ftWorker(app).reply({type:'filterTuned',result:res},ftWorker(app).sent.at(-1).msg.id);
    html=app.pane('filters');
    assert.match(html,/Recorded filter replay/);assert.match(html,/No filter values changed/);
    assert.doesNotMatch(html,/One new filter configuration across/,'a baseline replay preserves the multiple recorded configurations');
    assert.doesNotMatch(html,/class="tuning-table tuning-ft-comparison"/,'reference values are not presented as an untested candidate');
    assert.match(html,/data-ft-curve="new" disabled/);
    app.jq.fire('change','.tuning-ft-source-select',{}, {value:'2:all'});
    assert.doesNotMatch(app.pane('filters'),/data-param="gyro_lpf1_static_hz"/);
    app.jq.fire('click','.tuning-ft-start');
    eq(ftWorker(app).sent[0].msg.options.flights,[{log:2,flight:null}]);
    assert.deepEqual(app.errors,[]);
});

test('unlabelled recorded intervals remain visible and cannot be attributed to a known configuration', () => {
    const r=withDatasets(synthResult({flights:[{log:1,t0:14,t1:200}]}));
    r.datasets.labels=r.datasets.labels.filter(q=>q.dataset!=='B');
    const app=analysed({result:r});app.tab('filters');
    assert.match(app.pane('filters'),/Some recorded configuration intervals are unknown/);
    assert.match(app.pane('filters'),/100 s to 130 s<\/td><td>Unknown<\/td><td>PID profile unknown/);
});

function controlResult() {
    const r=withDatasets(synthResult());
    r.datasets.datasets.forEach(d=>{d.analysed=true;d.analysedFlightSeconds=100;d.values={roll_p_gain:50,roll_d_gain:20};});
    const rec=(id,name,from,to)=>({id:name,dataset:id,node:'cyclic',area:'cyclic',profile:id==='B'?2:1,cliProfile:id==='B'?1:0,scope:'profile',
        severity:'action',axis:'roll',title:'Increase the roll gain',parameter:name,from,to,fromSource:'log header',confidence:'measured',
        text:'The roll response has slow oscillation after a stop. This change can decrease the slow oscillation.',
        cli:['profile '+(id==='B'?1:0),'set '+name+' = '+to],rule:'The change is less than the step limit.',blockedBy:[],causes:[],
        evidence:[{id:'C6',fid:FID.C12,profile:1,value:30,se:2,unit:'deg/s'}]});
    r.advice.byDataset={A:[rec('A','roll_p_gain',50,55)],B:[],C:[rec('C','roll_p_gain',50,55),rec('C','roll_d_gain',20,22)]};
    return r;
}
const controlRequest=app=>app.deriveWorker().sent.filter(q=>q.msg.cmd==='controlTune').at(-1).msg;
function answerControl(app,q=controlRequest(app)) {
    const out=require('../tools/autotune/control_tune.cjs').tune(plain(q));
    app.deriveWorker().reply({type:'controlTuned',result:out},q.id);return out;
}
test('control autotune connects recorded problems to the reason for each change, then exports a selected flight plan',async()=>{
    const app=analysed({result:controlResult()});app.tab('cyclic');
    for(const text of ['Recorded problems','Recommended changes','Recorded response','Flight test necessary'])assert.ok(app.pane('cyclic').includes(text),text);
    assert.doesNotMatch(app.pane('cyclic'),/tuning-ct-metrics|tuning-ct-pending|New values|<th>New<\/th>|>Compare<\/h5>/);
    app.jq.fire('click','.tuning-ct-start');const q=controlRequest(app);
    assert.equal(q.configuration,'C');assert.equal(q.step,'cyclic');assert.equal(q.analysis.curves,undefined);
    assert.match(app.pane('cyclic'),/The app selects a control change/);
    answerControl(app);await tick();
    const htmlAfter=app.pane('cyclic');
    for(const text of ['Effect of this change','slow oscillation after a stop','can decrease the slow oscillation','Results for this change','Recommended</th>','log header'])assert.ok(htmlAfter.includes(text),text);
    assert.ok(htmlAfter.indexOf('Effect of this change')<htmlAfter.indexOf('Recorded response'),'the explanation precedes the signal plots');
    assert.match(htmlAfter,/\+5/);app.detail('cyclic:flight');assert.match(app.pane('cyclic'),/roll stick/);
    assert.doesNotMatch(app.pane('cyclic'),/Replay checks satisfactory|cleared issue/);
    app.tab('export');await tick();
    const e=app.deriveWorker().sent.filter(q=>q.msg.cmd==='export').at(-1).msg;
    assert.equal(e.withPlan,true);
    const selected=e.recs.filter(r=>e.picks.includes(r.id) && r.dataset==='C');
    assert.equal(selected.length,1);assert.equal(selected[0].controlTune,true);assert.equal(selected[0].parameter,'roll_p_gain');
    const bundle=advice.exportScript(plain(e.recs),plain(e.picks),plain(e.meta),true);
    app.deriveWorker().reply({type:'exported',result:bundle},e.id);await tick();
    const html=app.html('.tuning-export-preview');
    for(const text of ['Next flight maneuvers','PID profile 1','Roll steps and stops','each direction','Blackbox log rate'])assert.ok(html.includes(text),text);
    assert.match(html,/set roll_p_gain = 55/);assert.doesNotMatch(html,/set roll_d_gain = 22/);
    assert.deepEqual(app.errors,[]);
});

test('tab colors follow configuration results and do not clear when a control proposal is selected', async () => {
    const r = controlResult();
    r.findings = [
        {fid:'tab-a', id:'C12', node:'cyclic', dataset:'A', pidProfile:1, status:'satisfactory'},
        {fid:'tab-b', id:'C12', node:'cyclic', dataset:'B', pidProfile:2, status:'monitor'},
        {fid:'tab-c', id:'C12', node:'cyclic', dataset:'C', pidProfile:1, status:'problem'},
        {fid:'tab-info', id:'G20', node:'rpm', status:'information', severity:'flag'},
    ];
    const app = analysed({result:r}), tab = key => app.jq.node('.tuning-tab[data-tab="' + key + '"]');
    const label = key => app.jq.node('.tuning-tab[data-tab="' + key + '"] .tuning-tab-status').text;
    assert.ok(tab('cyclic').classes.has('st-problem'));
    assert.equal(label('cyclic'), 'Problem (1)');
    assert.ok(tab('overview').classes.has('st-problem'));
    assert.equal(label('tail'), 'Not measured');
    app.dialog.setConfiguration('A');
    assert.ok(tab('cyclic').classes.has('st-satisfactory'));
    assert.ok(!tab('cyclic').classes.has('st-problem'));
    app.dialog.setConfiguration('B');
    assert.ok(tab('cyclic').classes.has('st-monitor'));
    app.dialog.setConfiguration('C');
    app.tab('cyclic');
    assert.ok(tab('cyclic').classes.has('active'));
    assert.ok(tab('cyclic').classes.has('st-problem'));
    assert.match(tab('cyclic').attrs['aria-label'], /Cyclic gains: Problem \(1\).*Configuration C/);
    assert.equal(tab('cyclic').attrs['aria-current'], 'page');
    app.jq.fire('click', '.tuning-ct-start'); answerControl(app); await tick();
    assert.equal(label('cyclic'), 'Problem (1)', 'a flight-test proposal is not a measured correction');
    assert.ok(tab('export').classes.has('st-monitor'));
    app.tab('export');
    assert.ok(!tab('cyclic').classes.has('active'));
    assert.ok(tab('cyclic').classes.has('st-problem'), 'inactive tabs retain their issue colors');
    app.jq.fire('change', '.tuning-pick', {'data-pick':0}, {checked:false});
    assert.equal(label('cyclic'), 'Problem (1)', 'export selection does not hide an issue');
    assert.deepEqual(app.errors, []);
});

test('filter tab clearance requires a current confirmed replay and retains physical or unavailable problems', () => {
    const r = synthResult({findings:[{fid:'tab-f1',id:'F1',node:'filters',log:1,status:'problem'}]});
    const app = analysed({result:r}), I = app.internals;
    const side = (status, issues = 0) => ({status, issues, findings:[]});
    const cleared = {id:'F1',before:side('Issue',1),after:side('Pass'),outcome:'Cleared in replay'};
    const res = synthFilterTune({version:2, checklist:{confirmed:true,rows:[cleared]}});
    const tab = () => app.jq.node('.tuning-tab[data-tab="filters"]');
    app.tab('filters');
    assert.ok(tab().classes.has('st-problem'));
    app.jq.fire('click', '.tuning-ft-start');
    const w = ftWorker(app); w.reply({type:'filterTuned',result:res});
    assert.ok(tab().classes.has('st-satisfactory'));
    assert.match(tab().attrs['aria-label'], /Satisfactory in replay/);
    app.jq.fire('input', '.tuning-ft-param', {'data-param':'gyro_lpf1_static_hz'}, {value:'150'});
    assert.ok(tab().classes.has('st-problem'), 'unreplayed edits restore outstanding recorded problems immediately');
    assert.ok(!tab().classes.has('st-satisfactory'));
    const model = {state:'done',result:res,recordedChecks:r.findings};
    const status = m => I.tabStatus(I.filterTabStates(m)).key;
    assert.equal(status({...model,stale:true}), 'problem');
    assert.equal(status({...model,result:{checklist:{confirmed:false,rows:[cleared]}}}), 'problem');
    assert.equal(status({...model,recordedChecks:[{id:'F7',status:'problem'}]}), 'problem');
    assert.equal(status({...model,result:{checklist:{rows:[{...cleared,after:side('Not evaluated'),outcome:'Not evaluated'}]}}}), 'problem');
    assert.equal(status({...model,result:{checklist:{rows:[{...cleared,before:side('Pass'),after:side('Issue',1),outcome:'New issue'}]}}}), 'problem');
    assert.equal(I.tabStatus(['satisfactory','notMeasured']).key, 'notMeasured');
    assert.equal(I.tabStatus(['satisfactory','insufficient']).key, 'insufficient');
    assert.deepEqual(app.errors, []);
});

test('export tab flags conflicting selected changes before opening Export', () => {
    const r = controlResult(), own = r.advice.byDataset.C;
    own.push({...own[0],id:'conflicting-gain',to:60,cli:['profile 0','set roll_p_gain = 60']});
    const app = analysed({result:r}), tab = app.jq.node('.tuning-tab[data-tab="export"]');
    assert.ok(tab.classes.has('st-problem'));
    assert.match(tab.attrs['aria-label'], /Cannot export/);
    assert.equal(app.pane('export'), '', 'status checks do not render or enter the Export tab');
    app.tab('export');
    app.jq.fire('change', '.tuning-pick', {'data-pick':2}, {checked:false});
    assert.ok(!tab.classes.has('st-problem'));
    assert.ok(tab.classes.has('st-monitor'));
    assert.deepEqual(app.errors, []);
});
test('control drafts survive navigation and cancellation, reset and input changes cannot export an old proposal',async()=>{
    const app=analysed({result:controlResult()});app.tab('cyclic');app.jq.fire('click','.tuning-ct-start');
    const q=controlRequest(app);app.jq.fire('click','.tuning-ct-cancel');answerControl(app,q);await tick();
    assert.match(app.pane('cyclic'),/was canceled/);assert.doesNotMatch(app.pane('cyclic'),/tuning-ct-reset/);
    app.jq.fire('click','.tuning-ct-start');answerControl(app);await tick();
    app.dialog.setConfiguration('A');assert.doesNotMatch(app.pane('cyclic'),/tuning-ct-reset/,'C does not become A');
    app.dialog.setConfiguration('C');assert.match(app.pane('cyclic'),/tuning-ct-reset/,'C keeps the proposal');
    app.jq.fire('click','.tuning-ct-reset');assert.doesNotMatch(app.pane('cyclic'),/tuning-ct-reset/);
    app.jq.fire('click','.tuning-ct-start');answerControl(app);await tick();
    app.jq.fire('change','.tuning-scope',{}, {value:'file'});
    assert.match(app.pane('cyclic'),/analysis uses different inputs/);
    assert.match(app.pane('cyclic'),/tuning-ct-start" disabled/);
    app.tab('export');await tick();
    assert.doesNotMatch(app.pane('export'),/<code>55<\/code>/,'the old control proposal leaves the shared diff');
    assert.deepEqual(app.errors,[]);
});
test('recorded control comparisons retain uncertainty and parameter differences without claiming an after-flight result',()=>{
    const app=analysed({result:controlResult()});app.tab('cyclic');
    assert.doesNotMatch(app.pane('cyclic'),/The two configurations were flown|tuning-ct-reference/,'history is supporting detail');
    app.detail('cyclic:history');
    app.jq.fire('change','.tuning-ct-reference',{}, {value:'A'});
    assert.match(app.pane('cyclic'),/The two configurations were flown/);
    assert.match(app.pane('cyclic'),/4\.1/);assert.match(app.pane('cyclic'),/Other recorded configuration/);
    assert.match(app.pane('cyclic'),/Recorded configurations/);
    app.detail('cyclic:checks');
    app.jq.fire('click','.tuning-axis',{'data-axis':'pitch'});
    assert.match(app.pane('cyclic'),/<details class="tuning-ct-details"[^>]* open><summary data-ct-detail="cyclic:checks"/);
    assert.deepEqual(app.errors,[]);
});

test('each control step retains recorded problem context without proposed measurements',()=>{
    for(const [step,id,axis] of [['governor','G3',null],['cyclic','C6','roll'],['tail','T2','yaw'],['cycomp','C14','pitch'],['tailcomp','T14','yaw']]) {
        const r=controlResult(), f={...r.findings.find(f=>f.id==='C12'),fid:'control-problem',id,node:step,axis,
            dataset:'C',profile:1,pidProfile:1,log:1,severity:'flag',status:'problem',value:30,se:2,threshold:20,unit:'deg/s',
            noun:'Recorded error',summary:'The recorded error is more than its limit.',display:null,
            stale:{text:'The values come from the log header.',source:'Log header'},
            evidence:{spans:[{t0:10,t1:12}],view:{log:1,t0:10,t1:12},plot:{kind:'time',curve:'track.roll'}}};
        r.findings.push(f);
        const app=analysed({result:r});app.tab(step);
        const html=app.pane(step);
        for(const text of ['The recorded error is more than its limit.','10.0 s to 12.0 s','30.0&nbsp;±&nbsp;2.0 deg/s','Log 2','PID profile 1','Configuration C','Show in the log','Show the measurement','The values come from the log header.'])assert.ok(html.includes(text),step+': '+text);
        assert.doesNotMatch(html,/tuning-ct-metrics|tuning-ct-pending|<th>New<\/th>|New values/);
        assert.deepEqual(app.errors,[]);
    }
});

test('an unavailable control change keeps the recorded problem and never implies a clearance',async()=>{
    const r=controlResult();r.advice.byDataset.C=[];
    const app=analysed({result:r});app.tab('cyclic');
    app.jq.fire('click','.tuning-ct-start');answerControl(app);await tick();
    const html=app.pane('cyclic');
    assert.match(html,/The data gives no control change/);
    assert.match(html,/Recorded problems/);
    assert.doesNotMatch(html,/Effect of this change|tuning-ct-reset|cleared|<th>New<\/th>/);
    assert.deepEqual(app.errors,[]);
});

test('a control model estimate stays in supporting detail and never supplies measured new results',async()=>{
    const app=analysed({result:controlResult()});app.tab('cyclic');app.jq.fire('click','.tuning-ct-start');
    const q=controlRequest(app), out=require('../tools/autotune/control_tune.cjs').tune(plain(q));
    out.prediction={axis:'roll',tracking:[20,15],delta:-5,se:1,band:[1,15]};
    app.deriveWorker().reply({type:'controlTuned',result:out},q.id);await tick();
    assert.match(app.pane('cyclic'),/Model estimate \(not measured\)/);
    assert.doesNotMatch(app.pane('cyclic'),/20 to 15 deg\/s|tuning-ct-metrics/);
    app.detail('cyclic:model');
    assert.match(app.pane('cyclic'),/model tracking error: 20 to 15 deg\/s/);
    assert.match(app.pane('cyclic'),/It has no flight test/);
    app.jq.fire('change','.tuning-scope',{}, {value:'file'});
    assert.doesNotMatch(app.pane('cyclic'),/Model estimate \(not measured\)|Effect of this change/,'stale proposals do not describe the new selection');
    assert.deepEqual(app.errors,[]);
});

test('large control results keep closed checks and secondary plots out of the tab', () => {
    const result = synthResult(), finding = result.findings.find(f => f.id === 'C12');
    result.findings.push(...Array.from({ length: 1200 }, (_, i) => ({ ...finding, fid: 'many-' + i, node: 'cyclic', severity: 'flag' })));
    const app = analysed({ result });
    app.tab('cyclic');
    assert.equal(app.plots.length, 1, 'only the visible primary plot attaches');
    assert.doesNotMatch(app.pane('cyclic'), /tuning-step-picks|<td class="tuning-id">|many-1199/);
    assert.ok(app.pane('cyclic').length < 20000, 'tab content stays small with 1200 additional findings');
    app.detail('cyclic:checks');
    assert.match(app.pane('cyclic'), /many-1199/, 'all evidence remains reachable');
    app.detail('cyclic:checks', false);
    assert.doesNotMatch(app.pane('cyclic'), /many-1199/, 'closing releases the table DOM');
    assert.equal(app.plots.length, 1, 'opening checks does not replace the primary plot');
    assert.deepEqual(app.errors, []);
});

test('native disclosure toggles load plots once, release them on close and ignore obsolete elements', () => {
    const app = analysed();
    app.tab('cyclic');
    const primary = app.plots[0], owner = app.jq.node('#viewTuning').element;
    const signals = app.detail('cyclic:signals');
    assert.equal(app.plots.length, 5);
    owner.dispatchEvent({ type: 'toggle', target: signals });
    assert.equal(app.plots.length, 5, 'duplicate toggle notification does not duplicate plots');
    app.detail('cyclic:signals', false);
    assert.equal(app.destroyed.length, 4, 'only the secondary plots are destroyed');
    assert.ok(!app.destroyed.includes(primary.spec.title), 'primary plot and summary retain their DOM');
    app.detail('cyclic:signals');
    assert.equal(app.plots.length, 9);
    app.jq.fire('click', '.tuning-axis', { 'data-axis': 'pitch' });
    const count = app.plots.length;
    owner.dispatchEvent({ type: 'toggle', target: signals });
    assert.equal(app.plots.length, count, 'an old element cannot attach old data after a render');
    assert.match(app.pane('cyclic'), /data-tuning-detail-key="cyclic:signals" open/);
    assert.deepEqual(app.errors, []);
});

test('configuration tables load on demand and survive routine chrome refreshes', () => {
    const app = analysed({ result: controlResult() }), configuration = app.jq.node('.tuning-configuration');
    assert.doesNotMatch(configuration.html, /<table/);
    app.detail('configuration:values');
    assert.match(configuration.html, /<table/);
    const written = configuration.htmlWrites, html = configuration.html;
    app.show();
    assert.equal(configuration.htmlWrites, written, 'reopening Tuning does not rebuild the same configuration panel');
    assert.equal(configuration.html, html, 'the expanded reference stays open');
    app.detail('configuration:comparison');
    assert.match(configuration.html, /tuning-config-table/);
    app.detail('configuration:comparison', false);
    assert.doesNotMatch(configuration.html, /tuning-config-table/);
    app.dialog.setConfiguration('A');
    assert.match(configuration.html, /Recorded values of Configuration A/);
    assert.deepEqual(app.errors, []);
});

test('control problem cards open one measurement in the active control tab',()=>{
    const app=analysed({result:controlResult()});app.tab('cyclic');
    const key=/class="tuning-compare-open[^>]*data-key="([^"]+)" data-where="cyclic"/.exec(app.pane('cyclic'))[1];
    app.jq.fire('click','.tuning-compare-open',{'data-key':key,'data-where':'cyclic'});
    assert.equal((app.pane('cyclic').match(/class="tuning-compare"/g)||[]).length,1);
    assert.match(app.pane('cyclic'),/tuning-order-compare/);
    app.jq.fire('click','.tuning-compare-close');
    assert.doesNotMatch(app.pane('cyclic'),/class="tuning-compare"/);
    assert.deepEqual(app.errors,[]);
});


test('one filter checklist retains prior violations, physical input issues and unconfirmed outcomes', () => {
    const I=setup().internals, side=(issues,status)=>({issues,status,findings:[]});
    const row=(id,before,after,outcome)=>({id,title:'Filter check',log:1,configuration:'A',profile:2,axis:'pitch',fromS:10,toS:20,before:side(before,before?'Issue':'Pass'),after:side(after,after?'Issue':'Pass'),outcome});
    const checklist={confirmed:true,rows:[row('F3',0,0,'Unchanged'),row('F1',1,0,'Cleared in replay'),row('F2',1,1,'Remains'),row('F4',0,1,'New issue'),{id:'F7',title:'Vibration source'}]};
    const physical=[{id:'F7',log:1,severity:'flag',axis:'yaw',pidProfile:2,noun:'Vibration source',text:'A vibration source is present.'}];
    let html=I.filterChecklistHtml({checklist},physical);
    assert.equal((html.match(/Previous problem<\/span>/g)||[]).length,3);
    assert.ok(html.indexOf('F1:')<html.indexOf('F3:'));
    assert.match(html,/<tr class="tuning-ft-prior-issue tuning-ft-cleared">/);
    assert.match(html,/Configuration A, PID profile 2, pitch/);
    assert.match(html,/Same input/);
    assert.equal((html.match(/F7:/g)||[]).length,1,'the raw-input result replaces the unavailable placeholder');
    checklist.confirmed=false;html=I.filterChecklistHtml({checklist},physical);
    assert.doesNotMatch(html,/tuning-ft-cleared|Not found in replay|1 previous problem not found/);
    assert.match(html,/Not confirmed/);
    assert.match(html,/Previous problem/);
    html=I.filterChecklistHtml(null,physical);
    assert.match(html,/Not replayed/);assert.match(html,/Previous problem/);
});

test('hide unchanged values compares every recorded configuration and preserves manual drafts across replay', () => {
    const app=analysed(),res=synthFilterTune({version:2,mode:'autotune'});
    res.parameters=[{key:'gyro_lpf1_static_hz',name:'gyro_lpf1_static_hz',scope:'global',from:100,to:130,editable:true},
        {key:'dyn_notch_q',name:'dyn_notch_q',scope:'global',from:50,to:50,editable:true},
        {key:'gyro_lpf1_type',name:'gyro_lpf1_type',scope:'global',from:'FIRST_ORDER',to:'FIRST_ORDER',choices:['NONE','FIRST_ORDER'],editable:true}];
    app.tab('filters');app.jq.fire('click','.tuning-ft-start');const w=ftWorker(app);w.reply({type:'filterTuned',result:res});
    app.jq.fire('input','.tuning-ft-param',{'data-param':'dyn_notch_q'},{value:'60'});
    app.jq.fire('change','.tuning-ft-hide-unchanged',{}, {checked:true});
    let html=app.pane('filters');
    assert.match(html,/data-param="dyn_notch_q"[^>]*value="60"/);
    assert.doesNotMatch(html,/data-param="gyro_lpf1_type"/);
    assert.match(html,/data-param="gyro_lpf1_static_hz"/);
    assert.match(html,/btn-default btn-sm tuning-ft-start">Autotune again/);
    assert.match(html,/tuning-ft-save" disabled/);
    assert.equal(w.sent.length,1,'a display filter does not run analysis');
    app.jq.fire('click','.tuning-ft-simulate');const request=w.sent.at(-1).msg;
    assert.equal(request.options.simulate.dyn_notch_q,'60');
    w.reply({type:'filterTuned',result:{...res,mode:'simulation',parameters:res.parameters.map(q=>({...q,to:q.key==='dyn_notch_q'?60:q.to}))}},request.id);
    assert.match(app.pane('filters'),/tuning-ft-hide-unchanged" checked/);
    app.jq.fire('change','.tuning-ft-hide-unchanged',{}, {checked:false});
    assert.match(app.pane('filters'),/data-param="gyro_lpf1_type"/);
    const I=app.internals,baseline=[{id:'A',profile:1,t0:0,t1:10,values:{motor_rpm_lpf:'10,20'}},{id:'B',profile:1,t0:10,t1:20,values:{motor_rpm_lpf:'10,20'}}];
    const array={key:'motor_rpm_lpf',name:'motor_rpm_lpf',scope:'global',count:2,from:'10,20',to:'10, 20',editable:true};
    html=I.filterSearchHtml({result:{...res,parameters:[array]},baseline},{plotId:()=> 'p'},{hideUnchanged:true}).html;
    assert.doesNotMatch(html,/data-param="motor_rpm_lpf"/,'array spaces do not make a change');
    baseline[0].values={};
    html=I.filterSearchHtml({result:{...res,parameters:[array]},baseline},{plotId:()=> 'p'},{hideUnchanged:true}).html;
    assert.match(html,/data-param="motor_rpm_lpf"/,'unknown baselines must remain visible');
});

test('all axis pairs use the selected interval spectrum and identify its complete source', () => {
    const app=analysed(),res=synthFilterTune({version:2}), data=[0,1,2].map(()=>Float32Array.of(1,2,1));
    res.traces=[10,20].map((start,i)=>({log:5,configuration:i?'B':'A',profile:i+1,t:Float64Array.of(start,start+.001,start+.002),
        raw:data,logged:data,baseline:data,candidate:data,pidBaseline:data,pidCandidate:data,
        spectrum:{f:Float64Array.of(0,100,200),windows:1,...Object.fromEntries(['roll','pitch','yaw'].map(ax=>[ax,{raw:Float64Array.of(i+2,i+3,i+4),logged:data[0],predicted:data[1],candidate:data[2]}]))}}));
    app.tab('filters');app.jq.fire('click','.tuning-ft-start');const w=ftWorker(app);w.reply({type:'filterTuned',result:res});
    const assertWindow=i=>{
        for(const ax of ['roll','pitch','yaw']) {
            const spectrum=app.plots.filter(p=>p.spec.title==='Spectrum of selected interval, '+ax).at(-1).spec;
            const time=app.plots.filter(p=>p.spec.title==='Gyro signals, '+ax).at(-1).spec;
            assert.equal(spectrum.series[0].y,res.traces[i].spectrum[ax].raw);
            assert.equal(time.series[0].x,res.traces[i].t);
        }
    };
    assertWindow(0);app.jq.fire('change','.tuning-ft-trace',{}, {value:'1'});assertWindow(1);
    const html=app.pane('filters');
    assert.match(html,/<option value="1" selected>Log 6, Configuration B, PID profile 2, 20.000 to 20.002 s/);
    assert.match(html,/Each spectrum uses the selected time interval at the recorded sample rate/);
    assert.doesNotMatch(html,/The spectra average/);
    assert.equal((html.match(/class="tuning-ft-axis-pair"/g)||[]).length,3);
    assert.equal(w.sent.length,1);
});
