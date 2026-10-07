'use strict';
// Regression tests of the log viewer UI (2026-10-06): the functions of the upstream viewer that the NW.js audit found broken.
// The audit itself (real CDP mouse, wheel and keyboard input in NW.js 0.62.2, the original app, the fork's upstream and this
// tree) is the script viewer_audit/audit.cjs of the scratchpad; see the report of that day. A Node test here covers each
// fixed function that does not need a browser. The log picker during "Show in the log" is in test/views.test.cjs (it uses the
// harness of the main.js shell there).
//   node --test test/viewer_regression.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// A jQuery with namespaced events, as jQuery 1.11: on("change.ns"), off(".ns"), trigger("change") runs every handler of the
// type in the order of binding, trigger("change.ns") only those of the namespace. A handler that throws stops the handlers
// after it, as in jQuery.event.dispatch: that was the failure
function fakeJquery() {
    const els = new Map();
    function el(key) {
        if (!els.has(key)) els.set(key, { key, value: '', handlers: [], classes: new Set() });
        return els.get(key);
    }
    function parse(types) {
        return String(types).split(/\s+/).filter(Boolean).map((t) => { const i = t.indexOf('.'); return i < 0 ? { type: t, ns: '' } : { type: t.slice(0, i), ns: t.slice(i + 1) }; });
    }
    function wrap(e) {
        const w = {
            on(types, fn) { parse(types).forEach((t) => e.handlers.push({ type: t.type, ns: t.ns, fn })); return w; },
            off(types, fn) {
                parse(types).forEach((t) => { e.handlers = e.handlers.filter((h) => !((!t.type || h.type === t.type) && (!t.ns || h.ns === t.ns) && (!fn || h.fn === fn))); });
                return w;
            },
            trigger(types) {
                parse(types).forEach((t) => e.handlers.filter((h) => h.type === t.type && (!t.ns || h.ns === t.ns)).forEach((h) => h.fn.call(e, { type: t.type })));
                return w;
            },
            val(v) { if (v === undefined) return e.value; e.value = String(v); return w; },
            toggle() { return w; }, toggleClass(c, on) { if (on) e.classes.add(c); else e.classes.delete(c); return w; },
            addClass(c) { e.classes.add(c); return w; }, removeClass(c) { e.classes.delete(c); return w; },
            css() { return w; }, parent() { return wrap(el('parent of ' + e.key)); },
        };
        return w;
    }
    const $ = (sel, ctx) => wrap(el(typeof sel === 'string' ? sel + (ctx ? ' in ctx' : '') : sel && sel.key ? sel.key : sel));
    $.debounce = (ms, fn) => fn;
    return { $, el, els };
}

function analyserContext() {
    const jq = fakeJquery(), loads = [];
    const context = vm.createContext({
        $: jq.$, console: { log() {} },
        userSettings: { analyser: { size: 30, left: 5, top: 60 } },
        SPECTRUM_TYPE: { FREQUENCY: 0, FREQ_VS_THROTTLE: 1, PIDERROR_VS_SETPOINT: 2 },
        SPECTRUM_OVERDRAW_TYPE: { ALL_FILTERS: 0 },
        PrefStorage: function () { this.get = (k, cb) => cb({}); this.set = () => {}; },
        GraphSpectrumPlot: { initialize() {}, setOverdraw() {}, setData() {}, draw() {}, setZoom() {}, setSize() {}, setFullScreen() {} },
        // as js/graph_spectrum_calc.js: the samples go through dataBuffer.curve.lookupRaw (an analyser that never drew has the
        // curve 0, so lookupRaw is not a function)
        GraphSpectrumCalc: {
            initialize() {}, setDataBuffer(b) { this.b = b; },
            load(kind) { loads.push(kind); this.b.curve.lookupRaw(1); return { fieldIndex: this.b.fieldIndex }; },
            dataLoadFrequency() { return this.load('frequency'); }, dataLoadFrequencyVsThrottle() { return this.load('throttle'); },
            dataLoadPidErrorVsSetpoint() { return this.load('setpoint'); },
        },
    });
    vm.runInContext(read('js/graph_spectrum.js'), context, { filename: 'js/graph_spectrum.js' });
    const canvas = { key: 'analyserCanvas' }, mainCanvas = { height: 100, width: 100 };
    const make = () => new context.FlightLogAnalyser({ getSysConfig: () => ({}) }, mainCanvas, canvas);
    return { jq, context, loads, make, canvas };
}

test('the analyser: each log that the viewer opens makes a new analyser; destroy() removes its handlers, so the spectrum type select works after a log change', () => {
    const a = analyserContext();
    const curve = { lookupRaw: (v) => v };
    // log 1: an analyser that never drew (the pilot did not open the analyser), then main.js selectLog: graph.destroy(), new grapher
    const first = a.make();
    const select = a.jq.el('#spectrumTypeSelect');
    assert.equal(select.handlers.filter((h) => h.type === 'change').length, 1);
    first.destroy();
    for (const key of ['#spectrumTypeSelect', '#overdrawSpectrumTypeSelect', '#analyserZoomX', '#analyserZoomY', 'analyserCanvas']) {
        assert.equal(a.jq.el(key).handlers.length, 0, `${key}: no handler of the destroyed analyser`);
    }
    // log 2: the analyser draws, then the pilot selects another spectrum type
    const second = a.make();
    second.plotSpectrum(3, curve, 'Gyro [roll]');
    a.loads.length = 0;
    select.value = '1';
    assert.doesNotThrow(() => a.jq.$('#spectrumTypeSelect').trigger('change'));
    assert.deepEqual(a.loads, ['throttle'], 'the analyser of the open log loads the new spectrum');
    assert.equal(a.context.userSettings.spectrumType, 1);
    // the init of an analyser triggers only its own handler (a "change" of the namespace), not the handlers of others
    const third = a.make();
    assert.equal(select.handlers.filter((h) => h.type === 'change').length, 2, 'two analysers live: two handlers');
    third.destroy();
    second.destroy();
    assert.equal(select.handlers.length, 0);
});

test('the analyser fix is only in the handlers: before it, the handler of an analyser that never drew stopped the others (the failure of the audit)', () => {
    // the same steps without destroy(): the first handler throws at the change, as the upstream viewer did after a log change
    const a = analyserContext();
    a.make(); // never draws, never destroyed
    const second = a.make();
    second.plotSpectrum(3, { lookupRaw: (v) => v }, 'Gyro [roll]');
    a.loads.length = 0;
    a.jq.el('#spectrumTypeSelect').value = '1';
    assert.throws(() => a.jq.$('#spectrumTypeSelect').trigger('change'), /lookupRaw is not a function/);
    assert.deepEqual(a.loads, ['throttle'], 'only the old analyser ran: the new one did not load');
});

test('grapher.js destroy() destroys its analyser and step response, and main.js selectLog destroys the old grapher first', () => {
    const grapher = read('js/grapher.js'), main = read('js/main.js');
    const destroy = /this\.destroy = function\(\) \{([\s\S]*?)\n    \};/.exec(grapher);
    assert.ok(destroy, 'grapher destroy');
    assert.match(destroy[1], /\$\(canvas\)\.off\("mousedown", onMouseDown\);/, 'the upstream lines stay');
    assert.match(destroy[1], /if \(analyser && analyser\.destroy\) \{\s*analyser\.destroy\(\);\s*\}/);
    assert.match(destroy[1], /if \(stepResponse && stepResponse\.destroy\) \{\s*stepResponse\.destroy\(\);\s*\}/);
    assert.match(main, /if \(graph\) \{\s*graph\.destroy\(\);\s*\}[\s\S]{0,600}graph = new FlightLogGrapher\(/, 'selectLog: destroy, then the new grapher');
    const spectrum = read('js/graph_spectrum.js');
    assert.doesNotMatch(spectrum, /Elem\.change\(|\.dblclick\(/, 'every handler of the analyser is in its namespace');
    assert.match(spectrum, /spectrumTypeElem\.on\('change' \+ ns,[\s\S]*?\}\)\.trigger\('change' \+ ns\);/);
});
