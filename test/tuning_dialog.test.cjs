// The Tuning dialog (js/tuning_dialog.js) in node:vm with a minimal jQuery and DOM stand-in: it renders a synthetic
// TuningResult in every tab without throwing, escapes what comes from the log, drives the worker protocol of docs/DEVELOPMENT.md
// section 4, seeks the viewer, and is registered once in index.html and in gulpfile.js distSources.
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
    'health_track', 'health_more', 'advice'].map((n) => `./tools/autotune/${n}.cjs`);

// --- stand-ins -------------------------------------------------------------------------------------------------

// jQuery: every selector maps to one record of what the dialog wrote there (the dialog's selectors are unique)
function fakeJquery() {
    const nodes = new Map(), handlers = [], modal = [];
    const node = (sel) => {
        if (!nodes.has(sel)) nodes.set(sel, { sel, html: '', text: '', val: '', props: {}, attrs: {}, css: {}, classes: new Set(), clicks: 0 });
        return nodes.get(sel);
    };
    const wrap = (n) => {
        const w = {
            0: { click() { n.clicks++; } }, length: n.sel.startsWith('$') ? 0 : 1,
            find: (sel) => wrap(node(sel)),
            html(v) { if (v === undefined) return n.html; n.html = String(v); return w; },
            text(v) { if (v === undefined) return n.text; n.text = String(v); return w; },
            val(v) { if (v === undefined) return n.val; n.val = v; return w; },
            prop(k, v) { if (v === undefined) return n.props[k]; n.props[k] = v; return w; },
            attr(k, v) { if (v === undefined) return n.attrs[k]; n.attrs[k] = v; return w; },
            css(k, v) { if (v === undefined) return n.css[k]; n.css[k] = v; return w; },
            toggleClass(c, on) { if (on) n.classes.add(c); else n.classes.delete(c); return w; },
            on(type, sel, fn) { if (typeof sel === 'function') { fn = sel; sel = null; } handlers.push({ type, sel, fn }); return w; },
            modal(cmd) { modal.push(cmd); fire(cmd === 'show' ? 'shown.bs.modal' : 'hidden.bs.modal', null); return w; },
            remove() { return w; },
        };
        return w;
    };
    // An event on an element matching a delegated selector: the handler gets the element as `this`
    function fire(type, sel, attrs = {}, props = {}) {
        const el = Object.assign({ getAttribute: (k) => (k in attrs ? String(attrs[k]) : null), textContent: 'Copy' }, props);
        const hit = handlers.filter((h) => h.type === type && h.sel === sel);
        hit.forEach((h) => h.fn.call(el, { preventDefault() {}, which: props.which }));
        return { count: hit.length, el };
    }
    const $ = (sel) => wrap(node(typeof sel === 'string' && !sel.startsWith('#dlg') ? '$' + sel : sel));
    return { $, node, nodes, fire, modal };
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
// getFlightLog, where the dialog uses the FlightLog given to show()
function setup({ result, logCount = 3, current = 1, sysConfig = {}, liveHook = true } = {}) {
    const jq = fakeJquery(), workers = [], plots = [], destroyed = [], errors = [], saved = [], copied = [], elements = {};
    const calls = { seek: [], selectLog: [] };
    let bytes = Uint8Array.from({ length: 400 }, (_, i) => (i * 7) & 0xff), fileName = '<i>flight</i>.bbl';
    let flightLog = fakeLog({ count: logCount, current, sysConfig });
    const offsets = [0, 100, 250, 400];
    class Worker {
        constructor(url) { this.url = url; this.sent = []; this.terminated = false; workers.push(this); }
        postMessage(msg, transfer) { this.sent.push({ msg, transfer }); }
        terminate() { this.terminated = true; }
        reply(data) { this.onmessage({ data: Object.assign({ id: this.sent[0].msg.id }, data) }); }
    }
    const document = {
        getElementById(id) {
            if (!elements[id]) elements[id] = { id, parentNode: { innerHTML: '', className: '' }, scrolled: 0, scrollIntoView() { this.scrolled++; } };
            return elements[id];
        },
        createElement: () => ({ style: {}, select() {}, remove() {} }),
        body: { appendChild() {} },
        execCommand: () => true,
    };
    const context = vm.createContext({
        $: jq.$, document, Worker, Blob, console: { log() {}, warn() {}, error: (e) => errors.push(e) },
        setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
        navigator: { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } },
        // the three logs of the 400-byte files, one log in any other
        FlightLogIndex: function (b) {
            const o = b.length === offsets.at(-1) ? offsets : [0, b.length];
            this.getLogCount = () => o.length - 1;
            this.getLogBeginOffset = (i) => o[i];
        },
        FileReader: function () { this.readAsText = (file) => { this.result = file.text; this.onload(); }; },
        TuningPlot: {
            attach(canvas, spec) { plots.push({ canvas, spec }); return { update() {}, destroy() { destroyed.push(spec.title); } }; },
        },
        pickSaveFile: (options) => Promise.resolve({ write: async (blob) => saved.push({ options, text: await blob.text() }) }),
        reportSaveError: (e) => errors.push(e),
        getLogBaseFilename: () => 'flight',
    });
    vm.runInContext(read('js/tuning_dialog.js'), context, { filename: 'js/tuning_dialog.js' });
    const hooks = {
        seek: (us) => calls.seek.push(us), selectLog: (i) => { calls.selectLog.push(i); flightLog.openLog(i); },
        getBytes: () => bytes, getFileName: () => fileName, getCurrentLogIndex: () => (flightLog ? flightLog.getLogIndex() : null),
    };
    if (liveHook) hooks.getFlightLog = () => flightLog;
    const dialog = new context.TuningDialog(jq.$('#dlgTuning'), hooks);
    const html = (sel) => jq.node(sel).html;
    const pane = (key) => html(`.tuning-pane[data-pane="${key}"]`);
    const allHtml = () => [...jq.nodes.values()].map((n) => n.html).join('\n') + Object.values(elements).map((e) => e.parentNode.innerHTML).join('\n');
    return {
        context, jq, dialog, hooks, calls, workers, plots, destroyed, errors, saved, copied, offsets, elements, html, pane, allHtml,
        internals: context.TuningDialog.internals,
        get flightLog() { return flightLog; }, get bytes() { return bytes; }, setFile(b, name) { bytes = b; fileName = name; },
        // js/main.js loadLogFile, as for a file dropped on the window while the dialog is open: new bytes, name and
        // FlightLog, and no show()
        load(b, name, log) { bytes = b; fileName = name; flightLog = log; },
        show() { dialog.show(flightLog); },
        tab(key) { return jq.fire('click', '.tuning-tab', { 'data-tab': key }); },
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
        vib.notches[a] = [{ code: 1, q: 8, order: 2, hz: 76.6, label: 'main 2x <b>' }, { code: 9, q: 8, order: null, hz: null, label: 'tail 1x' }];
        // per profile, over the windows wholly on it: P1 at 38.3 Hz, P2 at 41.7 Hz, each with its notches at its own headspeed
        for (const [p, hz, windows] of [[1, 38.3, 30], [2, 41.7, 8]]) {
            const q = vib.byProfile[p] = vib.byProfile[p] || { windows, share: windows / 40, rotorHz: hz, notches: {} };
            q.notches[a] = [{ code: 1, q: 8, order: 2, hz: 2 * hz, label: 'main 2x <b>' }, { code: 9, q: 8, order: null, hz: null, label: 'tail 1x' }];
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

function synthResult(over = {}) {
    const findings = [
        { module: 'setup', id: 'D1', severity: 'flag', log: 1, profile: null, value: 250, se: null, n: 2764, threshold: 'nominal >= 1000 Hz', source: 'pipeline, unvalidated', text: 'logging 250 Hz', times: [] },
        { module: 'setup', id: 'D2', severity: 'flag', log: 1, profile: null, value: 1, se: null, n: 76300, threshold: 'gaps <= 0', source: 'pipeline, unvalidated', text: '1 loop stall at 12.3 s', times: [12.34, 56.7, 60, 70.5] },
        { module: 'more', id: 'MORE', severity: 'error', log: 1, text: 'judge failed: <b>boom</b>', times: [] },
        { module: 'gov', id: 'G3', severity: 'note', log: [], profile: 0, value: null, se: null, n: 0, threshold: { minStep: 0.3, flag: 0.05, source: 'pipeline, unvalidated' }, source: 'pipeline, unvalidated', text: 'no finding: 0 collective rises', times: [] },
        { module: 'gov', id: 'G2', severity: 'note', log: 1, profile: 3, value: -0.00074, se: 0.00046, n: 6027, threshold: { median: 0.01, band: 0.02 }, source: 'pipeline, unvalidated', text: 'headspeed error', times: [] },
        { module: 'gov', id: 'G12', severity: 'ok', log: 1, profile: null, value: 0.99868, se: 0.00003, n: 10, threshold: 0.005, source: 'pipeline, unvalidated', text: 'main rotor line', times: [] },
        { module: 'track', id: 'C12', severity: 'note', log: 1, profile: 1, axis: 'roll', value: 0.31, se: 0.03, n: 12, unit: 'fraction', threshold: 0.3, source: 'pipeline, unvalidated', text: 'tracking error', times: [100.2] },
        { module: 'track', id: 'C13', severity: 'note', log: 1, profile: 1, axis: 'roll', value: 26, se: 2, n: 12, unit: 'ms', threshold: 120, source: 'pipeline, unvalidated', text: 'lag', times: [] },
        { module: 'track', id: 'C5', severity: 'flag', log: 1, profile: 1, axis: 'roll', value: 2, se: null, n: 2, unit: 'bursts', threshold: 'any self-excited burst', source: 'wag_report.cjs RULES.onset', text: 'self-excited bursts', times: [45, 80] },
        { module: 'loop', id: 'T8', severity: 'flag', log: 1, profile: 1, value: 0.54, se: null, n: 22, threshold: '>= 1 episode', source: 'firmware', text: '22 episodes at an output limit', times: [] },
        { module: 'setup', id: 'F5', severity: 'flag', log: 1, profile: 1, value: 4.061, se: null, n: 22, threshold: 'prominence >= 5', source: 'pipeline, unvalidated', text: '<script>alert(2)</script> line at 4.061 x rotor', times: [], filterPass: [{ hz: 155.7, roll: 0.002, pitch: 0.001, yaw: 0.004 }] },
        { module: 'setup', id: 'H', severity: 'note', log: 1, profile: 'global', value: 'Rotorflight <4.4>', se: null, n: null, threshold: null, source: 'log header', text: 'Firmware revision changed', times: [] },
        { module: 'setup', id: 'F8', severity: 'ok', log: 1, profile: null, value: false, se: null, n: null, threshold: 'PID rate >= 1000 Hz', source: 'firmware', text: 'dynamic notch off', times: [] },
        { module: 'setup', id: 'D4', severity: 'skipped', log: 1, profile: null, value: null, se: null, n: null, threshold: null, source: 'pipeline, unvalidated', text: 'no CLI dump given', times: [] },
        { module: 'track', id: 'R1', severity: 'note', log: 1, profile: 1, axis: 'yaw', value: 35, se: 4, n: 9, unit: 'ms', threshold: 40, source: 'pipeline, unvalidated', text: 'stick to setpoint lag', times: [] },
    ];
    const recommendations = [
        { id: 'F5:check:p1', area: 'filters', order: 2, severity: 'check', title: 'Check the notch for the 4.06× line', parameter: null, scope: null, cliProfile: null,
            from: null, to: null, direction: 'check', cli: [], evidence: [findings[10]], rule: 'F5: prominence >= 5, no notch within 2 %', confidence: 'advisory', blockedBy: [], caveats: ['no CLI dump'] },
        { id: 'T7:yaw_collective_ff_gain:p1', area: 'tail', order: 10, severity: 'action', title: 'Raise yaw collective precomp <b>!</b>',
            parameter: 'yaw_collective_ff_gain', scope: 'profile', cliProfile: 0, from: 60, to: 72, direction: 'raise', cli: ['profile 0', 'set yaw_collective_ff_gain = 72'],
            evidence: [{ module: 'loop', id: 'T7', log: 1, profile: 1, axis: null, value: 0.62, se: 0.05, n: 12, unit: 'r', threshold: '|r| >= 0.5', source: 'pipeline, unvalidated', text: 'I follows the precomp', times: [33.3] }],
            rule: 'T7: |r| >= 0.5 and 2 SE; step bounded to 20 %', confidence: 'measured', blockedBy: [], caveats: [] },
        { id: 'C7:pitch_f_gain:p1', area: 'cyclic', order: 20, severity: 'action', title: 'Lower pitch F', parameter: 'pitch_f_gain', scope: 'profile', cliProfile: 0, from: 100, to: 80,
            direction: 'lower', cli: ['profile 0', 'set pitch_f_gain = 80'], evidence: [], rule: 'report.cjs rules 6 to 8', confidence: 'predicted', blockedBy: [], caveats: [] },
        // a blocked action keeps its severity and gets no CLI (advice.cjs guard and finish)
        { id: 'C7:roll_p_gain:p1', area: 'cyclic', order: 21, severity: 'action', title: 'Raise roll P', parameter: 'roll_p_gain', scope: 'profile', cliProfile: 0, from: 50, to: 60,
            direction: 'raise', cli: [], evidence: [], rule: '', confidence: 'predicted', blockedBy: ['filters first: F5 flag'], caveats: [] },
        { id: 'G9:gov_i_gain', area: 'governor', order: 5, severity: 'watch', title: 'Governor I oscillation below 2 SE', parameter: 'gov_i_gain', scope: 'global', cliProfile: null,
            from: 50, to: null, direction: 'check', cli: [], evidence: [], rule: 'G9: prominence 5 and 2 SE', confidence: 'measured', blockedBy: [], caveats: [] },
        { id: 'T13:p0', area: 'tail', order: 11, severity: 'check', title: 'Tail centre trim\nset motor_poles = 2', parameter: 'yaw_center_offset', scope: 'profile', cliProfile: null, from: null, to: null,
            direction: 'check', cli: [], evidence: [], rule: 'T13', confidence: 'measured', blockedBy: [], caveats: ['confirm the active profile'] },
        { id: 'R1:info', area: 'rates', order: 30, severity: 'info', title: 'Stick to setpoint lag 35 ms', parameter: null, scope: null, cliProfile: null, from: null, to: null,
            direction: null, cli: [], evidence: [findings[14]], rule: 'R1: note always', confidence: 'measured', blockedBy: [], caveats: [] },
    ];
    // advice.cjs rows name their parameter group; the first has none, as advice.cjs coverage rows
    const coverage = ['finding', 'checked', 'not-assessable', 'needs-cli', 'needs-fields', 'needs-flights', 'no-check'].map((status, i) => Object.assign({
        area: 'Area ' + i, parameters: ['roll_p_gain', 'pitch_p_gain'], checks: ['C5', 'C7'], status, detail: 'detail <svg onload=alert(3)>' }, i ? { group: 'Group ' + i } : {}));
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
        advice: { recommendations, coverage, notes: ['advice note <iframe>'], script: advice.script(recommendations) }, // as js/tuning_worker.js adviseAll
        curves: synthCurves(1),
        reportMarkdown: '# Health report\n\nThe toolkit report.',
        notes: ['note <iframe src=x>'],
    }, over);
}

// Shows the dialog (which starts a log-scope analysis) and answers with the result
function analysed(opts = {}) {
    const app = setup(opts);
    app.show();
    app.result = opts.result || synthResult();
    app.workers[0].reply({ type: 'result', result: app.result });
    return app;
}

function noRawMarkup(app) {
    const all = app.allHtml();
    for (const bad of ['<img', '<script', '<iframe', '<svg', '<b>', '<i>']) assert.ok(!all.includes(bad), `raw ${bad} in the dialog HTML`);
}

// --- tests ----------------------------------------------------------------------------------------------------

test('opening on a log slices that log on the main thread and posts analyseLog with the slice transferred', () => {
    const app = setup();
    app.show();
    assert.deepEqual(app.jq.modal, ['show']);
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
    assert.deepEqual(JSON.parse(JSON.stringify(msg.options)), { flightRpm: null, cliText: null, cliName: null, excludeAbnormal: true, curves: true });
    assert.equal(app.jq.node('.tuning-cancel').props.disabled, false);
    assert.equal(app.jq.node('.tuning-analyse').props.disabled, true);

    app.workers[0].reply({ type: 'progress', stage: 'decode', fraction: 0.35, text: 'log 2/3 <img src=y>' });
    assert.match(app.jq.node('.tuning-progress-text').text, /^Decode: log 2\/3 <img src=y> \(35 %\) · 0:00$/);
    assert.equal(app.jq.node('.tuning-progress-bar').css.width, '35.0%');
    assert.equal(app.jq.node('.tuning-progress').attrs.class, 'tuning-progress is-running');
    app.workers[0].reply({ type: 'progress', stage: 'analyse', text: 'fetching modules' });
    assert.equal(app.jq.node('.tuning-progress').attrs.class, 'tuning-progress is-busy');
});

test('a result renders every tab, plots and tables, with log-derived text escaped', () => {
    const app = analysed();
    assert.equal(app.workers[0].terminated, true, 'the worker is released after the result');
    const expect = { overview: 0, recs: 0, curves: 5, governor: 3, filters: 4, tail: 2, checks: 0, coverage: 0 };
    for (const t of app.internals.TABS) {
        const before = app.plots.length;
        assert.equal(app.tab(t.key).count, 1);
        assert.ok(app.pane(t.key).length > 100, `${t.key} renders`);
        assert.ok(!app.pane(t.key).includes('could not be drawn'), `${t.key} draws without an error`);
        assert.equal(app.plots.length - before, expect[t.key], `${t.key} attaches ${expect[t.key]} plots`);
    }
    for (const a of ['pitch', 'yaw']) {
        app.tab('curves');
        app.jq.fire('click', '.tuning-axis', { 'data-axis': a });
        assert.match(app.pane('curves'), new RegExp('Checks for ' + a));
    }
    assert.deepEqual(app.errors, []);
    noRawMarkup(app);
    assert.ok(app.html('.tuning-context').includes(HOSTILE_ESCAPED), 'craft name escaped in the context bar');
    assert.ok(app.pane('checks').includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
    assert.ok(app.pane('coverage').includes('detail &lt;svg onload=alert(3)&gt;'));
    assert.match(app.pane('coverage'), /<span class="tuning-badge st-insufficient">Not checked by the app<\/span>/, 'advice.cjs no-check rows');
    assert.match(app.pane('coverage'), /No check of this app informs the groups marked "Not checked by the app"/);
    assert.match(app.html('.tuning-context'), /<span>excluded: rescue 10\.6 s, ground 4\.0 s; 3\.9 min of normal flight left<\/span>/, 'records[].normalS beside the exclusions');
    assert.match(app.pane('checks'), /Log numbers count from 1 as in the log picker, in the finding texts too\./);
    assert.match(app.pane('checks'), /Measured filter pass \(gyroRAW to gyroADC\): 155\.7 Hz roll 0\.2 %, pitch 0\.1 %, yaw 0\.4 %/, 'F5 shows what the filters pass of its line');

    const o = app.pane('overview');
    assert.match(o, /Log 2\/3: 15 findings \(1 error, 5 flags, 6 notes, 2 ok, 1 skipped\), 7 recommendations \(2 to act on, 1 blocked\)\./,
        'a blocked action is not one to act on');
    assert.match(o, /st-watch">Action, blocked<\/span> <a [^>]*>Raise roll P<\/a>[\s\S]*?<span class="tuning-top-blocked">Blocked by filters first: F5 flag<\/span><\/li>/,
        'the top list marks a blocked action and says what it waits for');
    assert.match(o, /st-attention">Action<\/span> <a [^>]*>Lower pitch F<\/a>/, 'an unblocked action keeps its badge');
    assert.match(o, /Flight rpm 2000 \(85 % of the lowest governor target, 2353 rpm\) · no CLI dump · analysed in 3\.4 s/);
    assert.match(o, /1 check could not run\./);
    assert.match(o, /tuning-card st-error" data-area="data"[\s\S]*?Analysis error[\s\S]*?1 error, 2 flags, 1 note, 1 skipped[\s\S]*?D1, D2, MORE/, 'data card: the worst state, counts, flagged ids');
    assert.match(o, /tuning-card st-info" data-area="rates"[\s\S]*?Report only/);
    const recs = app.pane('recs');
    assert.match(recs, /Advice only\. Review before applying; nothing is sent to the flight controller\./);
    assert.match(recs, /yaw_collective_ff_gain<\/code> \(PID profile 1, CLI profile 0\): 60 → 72 \(raise\)/);
    assert.match(recs, /yaw_center_offset<\/code> \(PID profile unknown\): check/);
    assert.match(recs, /0\.620&nbsp;±&nbsp;0\.050 r/, 'evidence value ± SE with unit, kept on one line');
    assert.match(recs, /tuning-rec st-watch"[^>]*><div class="tuning-rec-head"><span class="tuning-badge st-watch">Action, blocked<\/span><span class="tuning-rec-title">Raise roll P</);
    assert.match(recs, /Blocked by[\s\S]*filters first: F5 flag/);
    assert.match(recs, /F ×0\.8 \(100 → 80\), tracking error 3\.43 → 1\.682 deg\/s \(improves 1\.75 ± 0\.64, 2\.7 SE\)/);
    assert.match(app.pane('checks'), /Showing 12 of 15 findings/);
    assert.match(app.pane('checks'), /-0\.00074&nbsp;±&nbsp;0\.00046/);
    assert.match(app.pane('governor'), /0\.998680&nbsp;±&nbsp;0\.000030/, 'the governor tab lists every governor check, ok ones too');
});

test('plot specs follow the TuningPlot contract and time plots seek the viewer', () => {
    const app = analysed();
    app.tab('curves');
    const specs = app.plots.map((p) => p.spec);
    for (const s of specs) {
        assert.equal(typeof s.title, 'string');
        assert.equal(s.height, undefined, s.title + ': the height is the stylesheet\'s, lower in short windows');
        assert.ok(s.x && s.y && Array.isArray(s.series) && s.series.length, s.title);
        for (const ser of s.series) assert.ok(ser.y.length > 1 && ser.x.length === ser.y.length && typeof ser.color === 'string', s.title + ' / ' + ser.name);
    }
    const track = specs.find((s) => /^Tracking error, roll/.test(s.title));
    assert.equal(track.series.length, 3);
    assert.deepEqual(Array.from(track.series, (q) => q.name), ['setpoint', 'error below 30 Hz', 'error at the best delay, below 30 Hz (τ = 26 ms)'], 'the error as C12 has it, low-passed at lpHz');
    assert.ok(track.bands.length >= 2 && track.bands.every((b) => b.x1 > b.x0), 'unusable spans shaded');
    assert.deepEqual(Array.from(track.markers, (m) => m.x).sort((a, b) => a - b), [45, 80, 100.2], 'roll finding times as markers');
    const spectrum = specs.find((s) => /^Error and response spectrum/.test(s.title));
    assert.equal(spectrum.x.log, true);
    assert.ok(spectrum.x.min > 0);
    assert.equal(JSON.stringify(spectrum.bands.map((b) => [b.x0, b.x1])), '[[10,20]]');
    const phase = specs.find((s) => /^Phase/.test(s.title)), delay = phase.series.find((q) => /^delay/.test(q.name));
    assert.ok(Math.abs(delay.y[10] - -360 * delay.x[10] * 0.026) < 1e-9, 'delay line −360 f τ');
    // T is drawn as measured only where its random error sqrt(1 - coh) / sqrt(2 n coh) is under 20 % (coh 0.8 below, 0.02 above m / 2)
    const half = (q) => [Array.from(q.y).slice(0, q.y.length / 2 - 1).every(Number.isFinite), Array.from(q.y).slice(q.y.length / 2 + 1).every(Number.isNaN)];
    const named = (sp, re) => sp.series.find((q) => re.test(q.name));
    assert.deepEqual(half(named(spectrum, /^\|T\| setpoint to gyro \(SE < 20 %\)$/)), [true, true], '|T| masked where its SE is too large');
    assert.deepEqual(half(named(phase, /^phase of T \(SE < 20 %\)$/)), [true, true], 'phase masked likewise');
    assert.ok(Array.from(named(spectrum, /^\|T\|, SE too large$/).y).every(Number.isFinite), 'the faint series keeps every bin');
    assert.ok(phase.y.min % 90 === 0 && phase.y.max % 90 === 0 && phase.y.min < 0, 'phase axis from the measured bins, in 90 deg steps');
    const osc = specs.find((s) => /^Band-passed error amplitude in 10-20 Hz, roll \(shaded: stick-driven\)$/.test(s.title));
    assert.equal(osc.hlines.map((h) => h.y).join(), '10,20,40');
    assert.equal(osc.series[0].name, '√2 rms of the band-passed error over 0.5 s; passes 0.47-0.64 of a sine in the band', 'the scale of C5 and T1');
    const byErr = specs.find((s) => /^Mean \|error\| by \|setpoint\|, roll/.test(s.title));
    assert.deepEqual(Array.from(byErr.series, (q) => q.name), ['mean |error| below 30 Hz', 'at the best delay, below 30 Hz']);

    app.tab('governor');
    const hs = app.plots.map((p) => p.spec).find((s) => /^Headspeed and governor target/.test(s.title));
    assert.equal(hs.bands.map((b) => b.label).filter(Boolean).join(), 'SPOOLUP', 'non-ACTIVE states shaded, long runs labelled');
    assert.equal(hs.bands.length, 2, 'SPOOLUP and AUTOROTATION');
    assert.equal(hs.vlines.map((v) => v.label).join(), 'P2', 'profile switch');
    let at = app.plots.length;
    app.tab('filters');
    // the spectra of the profile flown longest (P1, 200 s), with its rotor harmonics and its notches; filter lines first
    const raw = app.plots.map((p) => p.spec).find((s) => /^Gyro spectrum, raw and filtered, roll, P1 \(30 windows\); rotor harmonics at 38\.3 Hz$/.test(s.title));
    assert.ok(raw, 'the profile flown longest');
    assert.equal(raw.vlines.map((v) => v.label).join(', '), 'main 2x <b> Q8, LPF1 150 Hz, 1×, 2×, 3×, 4×, 5×, 6×, 7×, 8×', 'notches of unknown frequency left out; filter lines take the label rows first');
    assert.ok(Math.abs(raw.vlines.find((v) => v.label === '3×').x - 3 * 38.3) < 1e-9 && raw.vlines[0].x === 76.6);
    assert.ok(raw.series[0].y === app.result.curves[0].more.vib.byProfile[1].roll.raw, 'P1\'s own spectrum');
    assert.match(app.pane('filters'), /<select class="form-control input-sm tuning-vib-profile"[^>]*><option value="all">All profiles, weighted by time in each<\/option><option value="1" selected>P1, 2298 rpm, 30 windows \(75 %\), flown longest<\/option><option value="2">P2, 2502 rpm, 8 windows \(20 %\)<\/option><\/select>/);
    assert.equal(app.plots[at + 1].spec.title, 'Filter transmission |filtered| / |raw|, roll, P1 (30 windows)');
    at = app.plots.length;
    app.jq.fire('change', '.tuning-vib-profile', {}, { value: 'all' });
    const pooled = app.plots.slice(at).map((p) => p.spec)[0];
    assert.equal(pooled.title, 'Gyro spectrum, raw and filtered, roll, all profiles weighted by time in each; rotor harmonics of P1 at 38.3 Hz', 'pooled: harmonics of the profile flown longest');
    assert.ok(pooled.series[0].y === app.result.curves[0].more.vib.roll.raw && pooled.vlines[0].x === 76.6, 'the pooled spectrum, notches at the median headspeed');
    at = app.plots.length;
    app.jq.fire('change', '.tuning-vib-profile', {}, { value: '2' });
    const p2 = app.plots.slice(at).map((p) => p.spec)[0];
    assert.equal(p2.title, 'Gyro spectrum, raw and filtered, roll, P2 (8 windows); rotor harmonics at 41.7 Hz');
    assert.ok(Math.abs(p2.vlines[0].x - 83.4) < 1e-9 && Math.abs(p2.vlines.find((v) => v.label === '2×').x - 83.4) < 1e-9, 'P2\'s notch and harmonics at its own headspeed');
    app.jq.fire('click', '.tuning-axis', { 'data-axis': 'yaw' });
    assert.match(app.plots.at(-4).spec.title, /^Gyro spectrum, raw and filtered, yaw, P2 \(8 windows\)/, 'the choice holds across axes');
    app.jq.fire('change', '.tuning-vib-profile', {}, { value: '1' });
    app.jq.fire('click', '.tuning-axis', { 'data-axis': 'roll' });
    const err = app.plots.map((p) => p.spec).find((s) => /^Headspeed error from the reference \(govTarget\)$/.test(s.title));
    assert.deepEqual([err.y.min, err.y.max], [-3, 3], 'scaled to flight, not to the spool-up spike');
    assert.equal(raw.y.log, true);
    assert.equal(JSON.stringify(raw.bands.map((b) => [b.x0, b.x1])), '[[80,400]]');
    app.tab('tail');
    const tail = app.plots.map((p) => p.spec).find((s) => /^Tail command against its limits/.test(s.title));
    assert.equal(tail.hlines.map((h) => h.y).join(), '-400,400');
    assert.equal(tail.series[0].lo.length, 3000);
    assert.equal(tail.series[0].y[0], -20, 'the mean per 0.1 s');

    track.onClick(12.5);
    assert.deepEqual(app.calls.selectLog, [], 'already on log 1');
    assert.deepEqual(app.calls.seek, [app.flightLog.getMinTime(1) + 12.5e6]);
    assert.equal(app.jq.modal.at(-1), 'hide');
    // a finding time on another log selects that log first
    app.jq.fire('click', '.tuning-seek', { 'data-log': 2, 'data-t': 3.5 });
    assert.deepEqual(app.calls.selectLog, [2]);
    assert.equal(app.calls.seek.at(-1), app.flightLog.getMinTime(2) + 3.5e6);
    // a log of the file that does not parse is not sought: FlightLog.getMinTime would throw on it
    app.flightLog.getLogError = (i) => (i === 0 ? 'Log truncated' : false);
    app.jq.fire('click', '.tuning-seek', { 'data-log': 0, 'data-t': 1 });
    assert.equal(app.calls.seek.length, 2);
    assert.deepEqual(app.errors, []);

    // plots need a laid-out canvas: with the modal hidden they wait for shown.bs.modal
    const later = analysed();
    later.jq.fire('click', '.tuning-seek', { 'data-log': 1, 'data-t': 1 });
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
        const track = app.plots.slice(before).map((p) => p.spec).find((s) => s.title === `Tracking error, ${axis}: rms per 0.1 s`);
        seen[axis] = { markers: Array.from(track.markers, (m) => `${m.label} ${m.x}`).sort(), listed: /<td class="tuning-id">T14</.test(app.pane('curves')) };
    }
    assert.deepEqual(seen.roll, { markers: ['C12 note 100.2', 'C5 flag 45', 'C5 flag 80'], listed: false }, 'roll as without T14');
    assert.deepEqual(seen.pitch, { markers: [], listed: false });
    assert.deepEqual(seen.yaw, { markers: ['T14 flag 150', 'T14 flag 50'], listed: true }, 'the markers on the yaw plot and their check below it');
    app.tab('tail');
    const tail = app.plots.map((p) => p.spec).find((s) => /^Tail command against its limits/.test(s.title));
    assert.deepEqual(Array.from(tail.markers, (m) => m.x), [50, 150], 'the tail tab marks every tail check');
    const I = app.internals;
    assert.deepEqual([I.findingAxis({ id: 'T8' }), I.findingAxis({ id: 'C2' }), I.findingAxis({ id: 'C5', axis: 'pitch' })], ['yaw', null, 'pitch']);
});

test('a flag the advice explains (all its recommendations information) is report-only, with the reason', () => {
    const result = synthResult(), f5 = result.findings.find((f) => f.id === 'F5');
    f5.explained = 'Vibration line already filtered out';
    const app = analysed({ result });
    app.tab('checks');
    assert.match(app.pane('checks'), /<span class="tuning-badge st-info" title="Explained: Vibration line already filtered out">flag, explained<\/span>/);
    assert.match(app.pane('checks'), /<div class="tuning-muted">Explained: Vibration line already filtered out<\/div>/);
    app.tab('overview');
    const card = /<div class="tuning-card st-(\w+)" data-area="filters"[\s\S]*?<div class="tuning-card-counts">([^<]*)<\/div>/.exec(app.pane('overview'));
    assert.ok(card && /1 explained flag/.test(card[2]) && !/\bflags?\b(?! explained)/.test(card[2].replace('explained flag', '')), card && card[2]);
    assert.notEqual(card[1], 'attention', 'an explained flag alone does not mark its area');
});

test('missing curves say why, the toolkit report and the 250 Hz warning are shown', () => {
    const curves = synthCurves(1);
    curves[0].more = { gov: null, vib: null, dterm: null, control: null, tail: null };
    delete curves[0].track.yaw;
    const app = analysed({ result: synthResult({ curves, fields: { 'gyroRAW[0]': 'absent', headspeed: 'zero', 'axisD[0]': 'present' },
        records: [Object.assign(synthResult().records[0], { rate: 250, actualRate: 253.2 })] }) });
    app.tab('governor');
    assert.match(app.pane('governor'), /not available: headspeed is logged as all zero/);
    app.tab('filters');
    assert.match(app.pane('filters'), /not available: gyroRAW\[0\] is not logged/);
    app.tab('curves');
    app.jq.fire('click', '.tuning-axis', { 'data-axis': 'yaw' });
    assert.match(app.pane('curves'), /not available: no yaw curves in the result/);
    assert.match(app.html('.tuning-notices'), /This log is recorded at 250 Hz \(Nyquist 125 Hz\)/);

    const none = analysed({ result: synthResult({ curves: null, advice: null, notes: ['health_more.cjs failed to load'] }) });
    for (const key of ['curves', 'governor', 'filters', 'tail']) {
        none.tab(key);
        assert.match(none.pane(key), /not available: /, key);
    }
    none.tab('governor');
    assert.match(none.pane('governor'), /not available: health_more.cjs failed to load/);
    none.tab('recs');
    assert.match(none.pane('recs'), /Recommendations not available/);
    none.tab('coverage');
    assert.match(none.pane('coverage'), /Coverage not available/);
    assert.deepEqual(none.errors, []);

    // gyroRAW not logged: health_more gives the filtered spectrum only
    const only = synthCurves(1), vib = only[0].more.vib;
    vib.filtOnly = true;
    for (const a of ['roll', 'pitch', 'yaw']) for (const q of [vib, ...Object.values(vib.byProfile)]) q[a] = Object.assign({}, q[a], { raw: null, pass: null }); // per profile too, as health_more gives it
    const filt = analysed({ result: synthResult({ curves: only, fields: { 'gyroRAW[0]': 'absent' } }) });
    filt.tab('filters');
    const spec = filt.plots.map((p) => p.spec).find((x) => /^Gyro spectrum, filtered only \(gyroRAW not logged\), roll/.test(x.title));
    assert.equal(spec.series.length, 1);
    assert.match(filt.pane('filters'), /Filter transmission \|filtered\| \/ \|raw\|, roll, P1 \(30 windows\)<\/div><div class="tuning-na">not available: gyroRAW\[0\] is not logged/);

    const before = setup({ sysConfig: { looptime: 500, frameIntervalPDenom: 4, pid_process_denom: 2 } });
    before.show();
    assert.match(before.html('.tuning-notices'), /recorded at 250 Hz/);
});

test('worker errors, cancel, bad input and no log are reported, escaped', () => {
    const app = setup();
    app.show();
    app.workers[0].reply({ type: 'error', message: '<script>bad()</script>', stack: 'at <anonymous>' });
    assert.equal(app.workers[0].terminated, true);
    assert.match(app.html('.tuning-notices'), /The analysis failed\.<\/strong> &lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.match(app.html('.tuning-notices'), /at &lt;anonymous&gt;/);
    app.show();
    assert.equal(app.workers.length, 1, 'a failed run is not repeated on reopening');

    app.jq.fire('click', '.tuning-analyse');
    assert.equal(app.workers.length, 2);
    app.jq.fire('click', '.tuning-cancel');
    assert.equal(app.workers[1].terminated, true);
    assert.match(app.jq.node('.tuning-progress-text').text, /^Cancelled after 0:00$/);
    app.workers[1].reply({ type: 'result', result: synthResult() });
    assert.equal(app.pane('overview'), '', 'a cancelled run is ignored');
    app.show();
    assert.equal(app.workers.length, 2, 'a cancelled run is not restarted on reopening');

    app.jq.node('.tuning-rpm').val = 'fast';
    app.jq.fire('click', '.tuning-analyse');
    assert.equal(app.workers.length, 2);
    assert.match(app.html('.tuning-notices'), /Flight rpm must be a number from 300 to 50000/);

    // no log open: main.js has no FlightLog yet, or a host without getFlightLog passes none to show()
    const none = setup();
    none.load(null, null, null);
    none.show();
    const bare = setup({ liveHook: false });
    bare.dialog.show(null);
    for (const empty of [none, bare]) {
        assert.match(empty.html('.tuning-notices'), /Open a blackbox log to analyse it\./);
        assert.equal(empty.workers.length, 0);
        assert.equal(empty.jq.node('.tuning-analyse').props.disabled, true);
        noRawMarkup(empty);
    }
});

test('a file dropped while the dialog is open: log count, labels and seeks follow the viewer\'s FlightLog', async () => {
    const app = analysed(); // file A: 3 logs, log 2 analysed and shown
    // js/main.js window.ondrop -> loadLogFile: new bytes, name and FlightLog, selectLog(null) opens log 1; show() is not called
    const B = fakeLog({ count: 1, current: 0, t0: 5000 });
    app.load(Uint8Array.from({ length: 100 }, (_, i) => (i * 29 + 3) & 0xff), 'B.bbl', B);

    // a time of A's result: a notice, never a seek into B (A's log 2 + 3.5 s clamped into B would land anywhere)
    app.jq.fire('click', '.tuning-seek', { 'data-log': 1, 'data-t': 3.5 });
    assert.deepEqual(app.calls.seek, []);
    assert.deepEqual(app.jq.modal, ['show'], 'the dialog stays open');
    const notices = app.html('.tuning-notices');
    assert.match(notices, /These results are for another file\. Press Analyse to check the open file\./);
    assert.doesNotMatch(notices, /the viewer shows log|differ from this result/, 'log numbers and settings of two files are not compared');
    assert.match(app.html('.tuning-context'), /<span>Log 2\/3<\/span>/, 'the context bar describes the result on display');
    assert.equal(app.jq.node('.tuning-scope option[value="file"]').text, 'All flights (1 log)', 'the scope is the open file\'s');
    app.jq.fire('click', '.tuning-save');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.saved[0].options.suggestedName, '<i>flight</i>-log2-tuning.md', 'A\'s report is named after A, not after the open file');

    app.jq.fire('click', '.tuning-analyse');
    const { msg } = app.workers[1].sent[0];
    assert.deepEqual([msg.cmd, msg.fileName, msg.logIndex, msg.logCount, msg.bytes.byteLength], ['analyseLog', 'B.bbl', 0, 1, 100]);
    app.workers[1].reply({ type: 'result', result: synthResult({ fileName: 'B.bbl', logIndex: 0, curves: synthCurves(0) }) });
    assert.match(app.pane('overview'), /^<p class="tuning-summary">Log 1\/1: /);
    assert.match(app.html('.tuning-context'), /<span>Log 1\/1<\/span>/);
    assert.equal(app.html('.tuning-notices'), '');
    app.tab('curves');
    app.plots.map((p) => p.spec).find((s) => /^Tracking error, roll/.test(s.title)).onClick(7.25);
    app.jq.fire('click', '.tuning-seek', { 'data-log': 0, 'data-t': 12.5 });
    assert.deepEqual(app.calls.seek, [5007.25e6, B.getMinTime(0) + 12.5e6], 'B\'s log 1 starts at 5000 s: a plot click and a time link');
    assert.deepEqual(app.calls.selectLog, []);
});

test('results are cached per file, scope, log, flight rpm and CLI dump', async () => {
    const app = analysed();
    app.show();
    assert.equal(app.workers.length, 1, 'reopening shows the cached result');

    // all flights in the file, with a CLI dump and a flight rpm
    app.jq.fire('change', '.tuning-cli-input', {}, { files: [{ name: 'notes.txt', text: 'hello' }] });
    assert.match(app.html('.tuning-notices'), /notes\.txt does not look like a Rotorflight CLI dump/);
    const dump = '# diff all\nprofile 0\nset gov_mode = 1\n';
    app.jq.fire('change', '.tuning-cli-input', {}, { files: [{ name: '<b>dump</b>.txt', text: dump }] });
    assert.match(app.html('.tuning-cli-name'), /&lt;b&gt;dump&lt;\/b&gt;\.txt/);
    app.jq.node('.tuning-rpm').val = '2200';
    app.jq.fire('change', '.tuning-scope', {}, { value: 'file' });
    assert.match(app.html('.tuning-notices'), /differ from this result/);
    app.jq.fire('click', '.tuning-analyse');
    const { msg } = app.workers[1].sent[0];
    assert.equal(msg.cmd, 'analyseFile');
    assert.equal(msg.bytes.byteLength, 400);
    assert.equal(msg.selectedLog, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(msg.options)), { flightRpm: 2200, cliText: dump, cliName: '<b>dump</b>.txt', excludeAbnormal: true, gains: true });
    app.workers[1].reply({ type: 'result', result: synthResult({ scope: 'file', logs: [0, 1, 2], logIndex: undefined }) });
    assert.match(app.pane('overview'), /All 3 logs in the file: /);
    app.tab('checks');
    assert.match(app.pane('checks'), /<th class="tuning-sortable" data-sort="log">Log<\/th>/, 'file scope lists the log');

    // back to this log with the old settings: the first result again, no new run
    app.jq.fire('change', '.tuning-scope', {}, { value: 'log' });
    app.jq.node('.tuning-rpm').val = '';
    app.jq.fire('click', '.tuning-cli-clear');
    app.tab('overview');
    assert.match(app.pane('overview'), /^<p class="tuning-summary">Log 2\/3: /);
    app.show();
    assert.equal(app.workers.length, 2);

    // another file: the old result is dropped and the new log is analysed
    app.setFile(Uint8Array.from({ length: 400 }, (_, i) => (i * 13) & 0xff), 'other.bbl');
    app.show();
    assert.equal(app.workers.length, 3);
    assert.equal(app.workers[2].sent[0].msg.fileName, 'other.bbl');
    assert.equal(app.pane('overview'), '');
});

test('a file-scope result is cached per selected log: its curves, header and the header values of its recommendations are that log\'s', () => {
    const app = analysed(); // log 2, this log
    app.jq.fire('change', '.tuning-scope', {}, { value: 'file' });
    app.jq.fire('click', '.tuning-analyse');
    assert.equal(app.workers[1].sent[0].msg.selectedLog, 1);
    app.workers[1].reply({ type: 'result', result: synthResult({ scope: 'file', logs: [0, 1, 2], logIndex: 1 }) });
    assert.match(app.html('.tuning-context'), /All 3 logs, curves for log 2/);
    app.hooks.selectLog(2); // the viewer shows log 3
    app.show();
    assert.equal(app.workers.length, 2, 'all flights do not start by themselves');
    assert.match(app.html('.tuning-notices'), /The curves, the log details and the header values of the recommendations are for log 2; the viewer shows log 3\. Press Analyse to check log 3\./);
    app.jq.fire('click', '.tuning-analyse');
    assert.equal(app.workers[2].sent[0].msg.selectedLog, 2);
    app.workers[2].reply({ type: 'result', result: synthResult({ scope: 'file', logs: [0, 1, 2], logIndex: 2, curves: synthCurves(2) }) });
    assert.match(app.html('.tuning-context'), /All 3 logs, curves for log 3/);
    app.hooks.selectLog(1);
    app.show();
    assert.equal(app.workers.length, 3, 'the result with log 2 selected is cached apart');
    assert.match(app.html('.tuning-context'), /All 3 logs, curves for log 2/);
    assert.equal(app.html('.tuning-notices'), '');
});

test('filters, sorting, copy and save', async () => {
    const app = analysed();
    app.tab('checks');
    app.jq.fire('change', '.tuning-f-sev', {}, { value: 'all' });
    assert.match(app.html('.tuning-checks-table'), /Showing 15 of 15 findings/);
    app.jq.fire('change', '.tuning-f-area', {}, { value: 'governor' });
    assert.match(app.html('.tuning-checks-table'), /Showing 3 of 15/);
    app.jq.fire('input', '.tuning-f-query', {}, { value: 'G12' });
    assert.match(app.html('.tuning-checks-table'), /Showing 1 of 15/);
    app.jq.fire('change', '.tuning-f-area', {}, { value: 'all' });
    app.jq.fire('input', '.tuning-f-query', {}, { value: '' });
    app.jq.fire('click', 'th[data-sort]', { 'data-sort': 'id' });
    const ids = [...app.html('.tuning-checks-table').matchAll(/<td class="tuning-id">([^<]+)/g)].map((m) => m[1]);
    assert.deepEqual(ids.slice(0, 6), ['C5', 'C12', 'C13', 'D1', 'D2', 'D4'], 'natural id order');
    app.jq.fire('click', 'th[data-sort]', { 'data-sort': 'id' });
    assert.equal([...app.html('.tuning-checks-table').matchAll(/<td class="tuning-id">([^<]+)/g)][0][1], 'T8', 'reversed');

    app.jq.fire('click', '.tuning-card', { 'data-area': 'tail' });
    assert.match(app.pane('checks'), /Showing 1 of 15/);

    app.tab('recs');
    const block = /data-copy="(\d+)">Copy<\/button><pre>profile 0\nset yaw_collective_ff_gain = 72<\/pre>/.exec(app.pane('recs'));
    assert.ok(block, 'CLI block with a Copy button');
    const copied = app.jq.fire('click', '.tuning-copy', { 'data-copy': block[1] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(app.copied, ['profile 0\nset yaw_collective_ff_gain = 72']);
    assert.equal(copied.el.textContent, 'Copy');

    // the combined script is the worker's advice.script(recommendations), shown and copied as it is
    const script = synthResult().advice.script;
    assert.match(script, /set yaw_collective_ff_gain = 72[\s\S]*set pitch_f_gain = 80\nsave$/);
    const combined = /Combined CLI for the action items<\/h5><div class="tuning-cli"><button [^>]*data-copy="(\d+)">Copy<\/button><pre>([\s\S]*?)<\/pre>/.exec(app.pane('recs'));
    assert.ok(combined, 'the combined script with a Copy button');
    assert.equal(combined[2], app.internals.esc(script), 'advice.script, escaped');
    app.jq.fire('click', '.tuning-copy', { 'data-copy': combined[1] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.copied.at(-1), script);

    app.jq.fire('click', '.tuning-goto-rec', { 'data-rec': 2 });
    assert.equal(app.jq.node('.tuning-pane[data-pane="recs"]').classes.has('active'), true);
    assert.equal(app.elements['tuning1-rec-2'].scrolled, 1, 'the card is scrolled into view');

    app.jq.fire('click', '.tuning-save');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.saved.length, 1);
    assert.equal(app.saved[0].options.suggestedName, 'flight-log2-tuning.md');
    const md = app.saved[0].text;
    for (const part of ['# Tuning report', '> Advice only. Review before applying; nothing is sent to the flight controller.',
        '### 3. Raise yaw collective precomp <b>!</b> (action)', '### 4. Tail centre trim set motor_poles = 2 (check)', '### 6. Raise roll P (action, blocked)', '```\nprofile 0\nset yaw_collective_ff_gain = 72\n```',
        '## Combined CLI for the action items\n\n```\n' + script + '\n```', '## Gain analysis (report.cjs)', '| F5 | 2 | P1 | 4.061 (n 22) |', '## Coverage',
        '| Group | Area | Status | Checks | Parameters | Detail |', '| Area 0 | Area 0 | finding | C5, C7 | roll_p_gain, pitch_p_gain |', '| Group 1 | Area 1 | checked | C5, C7 |',
        '## Toolkit report (health_report.cjs)', 'The toolkit report.',
        "Log numbers count from 1 as in the viewer's log picker, in the finding texts too; only the toolkit report at the end counts from 0."]) assert.ok(md.includes(part), part);
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
    assert.equal(I.findingStatus({ severity: 'note', id: 'C13', text: 'lag 26 ms' }), 'info');
    assert.equal(I.findingStatus({ severity: 'note', id: 'C12', text: 'error 0.31' }), 'watch');
    assert.equal(I.areaOf({ id: 'GOV', module: 'gov', severity: 'error' }), 'governor');
    assert.equal(I.areaOf({ id: 'T11' }), 'tail');
    assert.equal(I.paramText({ scope: 'rateprofile', cliProfile: 1, from: 30, to: 25, direction: 'lower' }), '(rate profile 2, CLI rateprofile 1): 30 → 25 (lower)');
    assert.equal(I.paramText({ scope: 'profile', cliProfile: null, from: null, to: null, direction: 'check' }), '(PID profile unknown): check');
    assert.equal(I.findingWhere({ id: 'T5', profile: 1, axis: 'yaw' }, ' · '), 'P1 · yaw');
    assert.equal(I.findingWhere({ id: 'D4', profile: 0 }, ' '), 'CLI profile 0', 'D4 carries the CLI profile index');
    // the flight rpm of js/tuning_worker.js autoRpm: basis, profile, seconds in the air and the logs pooled (from 0)
    assert.equal(I.rpmText({ value: 1900, source: 'govTarget', basis: 2300, profile: 1, seconds: 70.4, logs: [49, 50, 51] }),
        '1900 (85 % of the lowest governor target, 2300 rpm on P1, 70.4 s in the air in logs 50, 51, 52)');
    assert.equal(I.rpmText({ value: 3000, source: 'headspeed', basis: 3541, profile: 0, seconds: 5.2, logs: [3] }),
        '3000 (85 % of the lowest per-profile median airborne headspeed, 3541 rpm, 5.2 s in the air in log 4)', 'profile 0: the arming profile, not named');
    assert.equal(I.rpmText({ value: 1900, source: 'govTarget', basis: 2300, profile: 2, seconds: 400, logs: [...Array(10).keys()] }),
        '1900 (85 % of the lowest governor target, 2300 rpm on P2, 6.7 min in the air in logs 1, 2, 3, 4, 5, 6, 7, 8 and 2 more)');
    assert.equal(I.rpmText({ value: 3000, source: 'default', basis: null, profile: null, seconds: null, logs: [] }), '3000 (toolkit default)');
    assert.equal(I.rpmText({ value: 2200, source: 'user', basis: null, profile: null, seconds: null, logs: [] }), '2200 (set here)');
});

test('app code is one IIFE global, Chromium 99 safe', () => {
    const src = read('js/tuning_dialog.js'), css = read('css/tuning_dialog.css');
    const context = vm.createContext({});
    const before = new Set(Object.getOwnPropertyNames(context));
    vm.runInContext(src, context);
    assert.deepEqual(Object.getOwnPropertyNames(context).filter((k) => !before.has(k)), ['TuningDialog']);
    assert.ok(!/^(const|let|class)\s/m.test(src), 'no top-level const, let or class');
    for (const api of ['toSorted', 'toReversed', 'Object.groupBy', 'findLast', '.at(', 'structuredClone', 'replaceAll']) assert.ok(!src.includes(api), api);
    assert.ok(!/:has\(|@container|&\s*[.:{]/.test(css), 'no :has(), container queries or nesting');
    assert.ok(!/(src|href|url)\s*[=(]\s*["']?\//.test(src + css), 'relative URLs only');
});

test('a Top recommendations link scrolls its card to below the sticky tab strip', () => {
    const css = read('css/tuning_dialog.css');
    assert.match(css, /\n\.tuning-tabs \{[^}]*position: sticky;/);
    // Chromium 99 (NW.js 0.62.2) scrolls the card to the top edge, under the 33-35 px strip, unless the card keeps a margin
    const margin = /\n\.tuning-rec \{[^}]*scroll-margin-top: (\d+)px;/.exec(css);
    assert.ok(margin && +margin[1] >= 40, 'scroll-margin-top clears the strip');
});

test('index.html, gulpfile.js, main.js and branding.css register the dialog once', () => {
    const html = read('index.html'), gulp = read('gulpfile.js'), main = read('js/main.js'), branding = read('css/branding.css');
    const count = (text, needle) => text.split(needle).length - 1;
    assert.equal(count(html, '<link rel="stylesheet" href="css/tuning_dialog.css">'), 1);
    for (const js of ['tuning_plot', 'tuning_dialog']) assert.equal(count(html, `<script src="js/${js}.js"></script>`), 1, js);
    assert.equal(count(html, 'tuning_worker.js'), 0, 'the worker is not a page script');
    const at = (needle) => html.indexOf(needle);
    assert.ok(at('js/flight_analysis_dialog.js') < at('js/tuning_plot.js') && at('js/tuning_plot.js') < at('js/tuning_dialog.js') &&
        at('js/tuning_dialog.js') < at('js/main.js'), 'script order: flight analysis dialog, plot, dialog, main');
    assert.equal(count(html, 'id="dlgTuning"'), 1);
    assert.equal(count(html, 'id="tuningBody"'), 1);
    assert.equal(count(html, 'open-tuning-dialog'), 1);
    assert.ok(at('id="dlgFlightAnalysis"') < at('id="dlgTuning"'));

    const list = /(?:var distSources|APP_ASSET_SOURCES) = \[([\s\S]*?)\];/.exec(gulp)[1]; // master, or origin/master's list
    for (const file of ['./css/tuning_dialog.css', './js/tuning_plot.js', './js/tuning_dialog.js', './js/tuning_worker.js', ...TOOLKIT]) {
        assert.equal(count(list, `'${file}'`), 1, file);
    }
    assert.equal(count(main, 'new TuningDialog($("#dlgTuning")'), 1);
    assert.equal(count(main, 'getFlightLog: function() { return flightLog; }'), 1, 'the dialog reads the viewer\'s FlightLog, not one kept from show()');
    assert.equal(count(main, '$(".open-tuning-dialog").click('), 1);
    assert.match(branding, /\.rf-nav-icon\.open-tuning-dialog \{\s*display: none;\s*\}/);
    assert.match(branding, /html\.has-log \.rf-nav-icon\.open-tuning-dialog \{\s*display: inline-flex;\s*\}/);
});

test('every registered tuning file exists, so packaged builds have it', () => {
    const missing = ['./css/tuning_dialog.css', './js/tuning_plot.js', './js/tuning_dialog.js', './js/tuning_worker.js', ...TOOLKIT]
        .filter((file) => !fs.existsSync(path.join(ROOT, file)));
    assert.deepEqual(missing, []);
});
