// The shell of the three views "Log viewer", "Analysis" and "Tuning" (index.html, js/main.js, the view CSS,
// js/graph_spectrum_calc.js). Static checks of the tab strip, the view sections, the script order and the guards; then
// the shell functions of js/main.js, taken from the source, in node:vm against a stand-in viewer: showView, "Show in the
// log" (viewInLog, endEvidence: snapshot and restore of the user's graphs, marks, zoom and time) and the zoom fit.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const HTML = read('index.html'), MAIN = read('js/main.js');
const count = (text, needle) => text.split(needle).length - 1;
const plain = (x) => JSON.parse(JSON.stringify(x)); // objects made in node:vm have the prototypes of that realm
const attrOf = (attrs, name) => (new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs) || [])[1];

// ---------------------------------------------------------------------------------------------------------------------
// Static: markup, order, CSS

test('index.html: one tab strip, "Log viewer", "Analysis" and "Tuning", each tab for a view that exists', () => {
    assert.equal(count(HTML, 'class="rf-view-tabs"'), 1);
    const strip = /<div class="rf-view-tabs" role="tablist" aria-label="Views">([\s\S]*?)<\/div>/.exec(HTML);
    assert.ok(strip, 'the tab strip is a tablist');
    const tabs = [...strip[1].matchAll(/<button ([^>]*)>([^<]*)<\/button>/g)].map(([, attrs, label]) => ({ attrs, label }));
    assert.deepEqual(tabs.map((t) => t.label), ['Log viewer', 'Analysis', 'Tuning']);
    assert.deepEqual(tabs.map((t) => attrOf(t.attrs, 'data-view')), ['viewer', 'analysis', 'tuning']);
    assert.deepEqual(tabs.map((t) => attrOf(t.attrs, 'role')), ['tab', 'tab', 'tab']);
    assert.deepEqual(tabs.map((t) => attrOf(t.attrs, 'type')), ['button', 'button', 'button']);
    assert.deepEqual(tabs.map((t) => attrOf(t.attrs, 'aria-selected')), ['true', 'false', 'false']);
    assert.deepEqual(tabs.map((t) => /\bis-active\b/.test(attrOf(t.attrs, 'class'))), [true, false, false]);
    assert.deepEqual(tabs.map((t) => attrOf(t.attrs, 'aria-controls')), ['screenshot-frame', 'viewAnalysis', 'viewTuning']);
    for (const t of tabs) {
        assert.equal(count(HTML, `id="${attrOf(t.attrs, 'id')}"`), 1, attrOf(t.attrs, 'id'));
        assert.equal(count(HTML, `id="${attrOf(t.attrs, 'aria-controls')}"`), 1, attrOf(t.attrs, 'aria-controls'));
    }
    for (const gone of ['open-flight-analysis-dialog', 'open-tuning-dialog', 'id="dlgTuning"', 'id="viewFlightAnalysis"']) {
        assert.equal(count(HTML, gone), 0, `${gone}: views, not modals`);
    }
    assert.equal(count(HTML, 'id="dlgFlightAnalysis"'), 1, 'the upstream Flight analysis markup stays, unused (SPEC2 D7; test/analysis_view.test.cjs)');
});

test('index.html: the Analysis view holds the verdict (js/analysis_view.js), and no log lens; the Tuning view holds its body', () => {
    const section = (id) => new RegExp(`<section ([^>]*\\bid="${id}"[^>]*)>([\\s\\S]*?)</section>`).exec(HTML);
    const analysis = section('viewAnalysis'), tuning = section('viewTuning');
    assert.ok(analysis && tuning);
    for (const [s, tab] of [[analysis, 'tabAnalysis'], [tuning, 'tabTuning']]) {
        assert.match(attrOf(s[1], 'class'), /^rf-view\b/);
        assert.equal(attrOf(s[1], 'role'), 'tabpanel');
        assert.equal(attrOf(s[1], 'aria-labelledby'), tab);
        assert.equal(attrOf(s[1], 'tabindex'), '-1', 'focusable, so the keys scroll the view');
    }
    assert.deepEqual([...analysis[2].matchAll(/\bid="(\w+)"/g)].map((m) => m[1]), ['analysisVerdictBody']);
    assert.deepEqual([...tuning[2].matchAll(/\bid="(\w+)"/g)].map((m) => m[1]), ['tuningBody']);
    for (const id of ['viewAnalysis', 'analysisVerdictBody', 'viewTuning', 'tuningBody']) assert.equal(count(HTML, `id="${id}"`), 1, id);
    const dialogs = HTML.indexOf('<!-- Dialog Boxes and Popup Windows -->');
    assert.ok(HTML.indexOf('id="viewAnalysis"') < HTML.indexOf('id="viewTuning"') && HTML.indexOf('id="viewTuning"') < dialogs,
        'the views sit before the modal dialogs, outside them');
});

test('index.html: the view scripts and styles load once each, in dependency order, before main.js', () => {
    const scripts = [...HTML.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    const order = ['js/vendor/jquery-1.11.3.min.js', 'js/graph_spectrum_calc.js', 'js/flight_analysis.js', 'js/flight_analysis_dialog.js',
        'js/tuning_plot.js', 'js/tuning_snippet.js', 'js/tuning_dialog.js', 'js/log_lens.js', 'js/analysis_view.js', 'js/main.js'];
    for (const s of order) assert.equal(scripts.filter((x) => x === s).length, 1, s);
    const at = order.map((s) => scripts.indexOf(s));
    assert.deepEqual(at, [...at].sort((a, b) => a - b), 'load order');
    const plot = scripts.indexOf('js/tuning_plot.js');
    assert.deepEqual(scripts.slice(plot, plot + 4), ['js/tuning_plot.js', 'js/tuning_snippet.js', 'js/tuning_dialog.js', 'js/log_lens.js'],
        'SPEC2 section 2: the new scripts directly after js/tuning_plot.js');

    const styles = [...HTML.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
    const css = ['css/main.css', 'css/branding.css', 'css/flight_analysis_dialog.css', 'css/tuning_dialog.css', 'css/log_lens.css'];
    for (const s of css) assert.equal(styles.filter((x) => x === s).length, 1, s);
    assert.equal(styles.indexOf('css/log_lens.css'), styles.indexOf('css/tuning_dialog.css') + 1, 'css/log_lens.css after css/tuning_dialog.css');
});

test('index.html: the "Show in the log" bar sits on the graph, with its text, Back and close buttons', () => {
    assert.equal(count(HTML, 'class="log-evidence"'), 1);
    const graph = HTML.indexOf('<div class="log-graph"'), bar = HTML.indexOf('class="log-evidence"'), legend = HTML.indexOf('<div class="log-graph-config">');
    assert.ok(graph >= 0 && graph < bar && bar < legend, 'inside .log-graph, over the canvas');
    const markup = HTML.slice(bar, HTML.indexOf('</div>\n            </div>', bar));
    assert.match(markup, /data-html2canvas-ignore="true"/, 'not in screenshots');
    assert.match(markup, /class="log-evidence-text"/);
    assert.match(markup, /class="btn btn-primary btn-xs log-evidence-back" title="Show the Tuning view again">Back to Tuning<\/button>/);
    assert.match(markup, /class="btn btn-default btn-xs log-evidence-close" aria-label="Close" title="Close this bar and show your graphs again">&times;<\/button>/);
});

test('CSS: the active view covers the viewer under the navbar, full width, and the tabs show only with a log', () => {
    const main = read('css/main.css'), branding = read('css/branding.css'), lens = read('css/log_lens.css');
    assert.match(main, /html\.has-log\[data-view="analysis"\] #viewAnalysis,\s*html\.has-log\[data-view="tuning"\] #viewTuning \{[^}]*position: fixed;[^}]*top: 50px;[^}]*z-index: 1020;[^}]*background: #fff;/);
    assert.match(branding, /\.rf-navbar \{[^}]*z-index: 1030;/, 'the view (1020) stays under the navbar');
    for (const view of ['analysis', 'tuning']) {
        for (const part of ['.main-pane', '.log-seek-bar', '#status-bar']) {
            assert.ok(main.includes(`html.has-log[data-view="${view}"] ${part}`), `${part} hidden (laid out) under ${view}`);
        }
    }
    assert.match(branding, /\.rf-view-tabs \{\s*display: none;/);
    assert.match(branding, /html\.has-log \.rf-view-tabs \{\s*display: inline-flex;\s*\}/);
    assert.match(lens, /#viewAnalysis \{\s*padding: 16px 24px 24px;\s*\}/, 'the Analysis view styles are in css/log_lens.css: the upstream css/flight_analysis_dialog.css stays as it is');
    assert.doesNotMatch(lens, /#analysisVerdictBody\s*\{[^}]*max-width/, 'the verdict uses the full width: no max-width cap');
});

test('main.js: one showView, viewInLog and endEvidence; the viewer\'s keys, wheel and drawing only in the viewer', () => {
    for (const name of ['showView', 'viewInLog', 'endEvidence', 'zoomForWidth', 'fitGraphToSpan', 'clampToLog']) {
        assert.equal(count(MAIN, `function ${name}(`), 1, name);
    }
    assert.equal(count(MAIN, 'if (graph && activeView === "viewer" && e.target.type != \'text\''), 1, 'keydown guard');
    assert.equal(count(MAIN, 'if (!graph || activeView !== "viewer" ||'), 1, 'wheel guard');
    assert.equal(count(MAIN, 'if (!graph || activeView !== "viewer") {'), 1, 'animationLoop guard');
    assert.doesNotMatch(extract(MAIN, 'viewInLog'), /newGraphConfig\(|prefs\./, '"Show in the log" never writes the user\'s graphs to prefs');
    assert.equal(count(MAIN, 'function setViewerWindow('), 0, 'no window hooks of a log lens');
    for (const name of ['showView', 'fitGraphToSpan', 'endEvidence']) assert.doesNotMatch(extract(MAIN, name), /prefs\./, name);
});

test('main.js: the views are built with the SPEC2 3.9 hooks', () => {
    assert.equal(count(MAIN, 'new FlightAnalysisDialog('), 0, 'the upstream Flight analysis is not used (SPEC2 D7)');
    assert.equal(count(MAIN, 'new TuningDialog($("#viewTuning")'), 1);
    assert.equal(count(MAIN, 'new AnalysisView($("#viewAnalysis")'), 1, 'the verdict');
    assert.equal(count(MAIN, 'getFlightLog: function() { return flightLog; }'), 1, 'one copy of the hooks to the open file');
    const lens = MAIN.slice(MAIN.indexOf('var analysisView = '), MAIN.indexOf('views.tuning = tuningDialog;'));
    for (const hook of ['viewInLog($.extend({}, req, {from: "analysis"}))',
        'runAnalysis:', 'getResult: function() { return tuningDialog.getResult(); }', 'onResult: function(cb) { return tuningDialog.onResult(cb); }',
        'derive: function(kind, cols, rate, params, transfer) { return tuningDialog.derive(kind, cols, rate, params, transfer); }', '}, logHooks));',
        'typeof AnalysisView !== "function" ? null : new AnalysisView(', 'views.analysis = analysisView;',
        'getSelection: function() { return tuningDialog.getSelection(); }']) { // SPEC3 D: "Selected flights" of the result
        assert.ok(lens.includes(hook), hook);
    }
    const hooks = MAIN.slice(MAIN.indexOf('var logHooks = {'), MAIN.indexOf('var tuningDialog'));
    for (const hook of ['getBytes:', 'getFlightLog:', 'getFileName:', 'getCurrentLogIndex:', 'resultFilter:', 'setResultFilter:', 'onResultFilter:']) assert.ok(hooks.includes(hook), hook);
    assert.ok(MAIN.includes('viewInLog($.extend({}, req, {from: "tuning"}))'), 'Back from the Tuning view goes to Tuning');
    assert.equal(count(MAIN, 'views.tuning = tuningDialog;'), 1);
    assert.equal(count(MAIN, '$(".rf-view-tab").click('), 1);
});

test('graph_spectrum_calc.js: the analyser range uses this._analyserTimeRange, so spans of more than 300 s do not throw', () => {
    const src = read('js/graph_spectrum_calc.js');
    assert.doesNotMatch(src, /(?<![\w.])analyserTimeRange\b/, 'no bare analyserTimeRange (no such global)');
    assert.ok(src.includes('this._analyserTimeRange.out = this._analyserTimeRange.in + MAX_ANALYSER_LENGTH;'));
    const ctx = vm.createContext({});
    vm.runInContext(src + '\nthis.calc = GraphSpectrumCalc;', ctx);
    const max = vm.runInContext('MAX_ANALYSER_LENGTH', ctx);
    assert.equal(max, 300e6);
    ctx.calc.setInTime(10e6);
    assert.equal(ctx.calc.setOutTime(10e6 + 120e6), 130e6, 'a span of 120 s: as asked');
    assert.equal(ctx.calc.setOutTime(10e6 + 400e6), 10e6 + max, 'a span of 400 s: the first 300 s');
});

// ---------------------------------------------------------------------------------------------------------------------
// The shell functions of js/main.js in node:vm

// The source of `function name(...) {...}`: braces matched, strings and comments skipped
function extract(src, name) {
    const at = src.search(new RegExp(`\\bfunction ${name}\\(`));
    assert.ok(at >= 0, `function ${name} in js/main.js`);
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'") {
            for (i++; src[i] !== c; i++) if (src[i] === '\\') i++;
        } else if (c === '/' && src[i + 1] === '/') {
            i = src.indexOf('\n', i);
        } else if (c === '/' && src[i + 1] === '*') {
            i = src.indexOf('*/', i) + 1;
        } else if (c === '{') {
            depth++;
        } else if (c === '}' && --depth === 0) {
            return src.slice(at, i + 1);
        }
    }
    throw new Error(`unbalanced braces in ${name}`);
}

const SHELL = ['clampToLog', 'setCurrentBlackboxTime', 'setVideoInTime', 'setVideoOutTime', 'setGraphZoomLevel', 'setLegendTitle',
    'newGraphConfig', 'animationLoop', 'showView', 'zoomForWidth', 'setExactZoom', 'fitGraphToSpan', 'showAnalyserOf',
    'viewInLog', 'endEvidence', 'evidenceLogPicked', 'onSwitchWorkspace', 'evidenceBar', 'renderEvidenceLegend', 'resetEvidence', 'textSizeStep', 'setTextSize', 'setResultFilter'];

// A stand-in element and a jQuery with the calls the shell makes
function element(attrs) {
    return {
        attrs: Object.assign({}, attrs), classes: new Set(), text: '', children: [], focused: [],
        getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
        focus(options) { this.focused.push(options); },
        blur() {},
    };
}
function textOf(node) {
    return node.nodeValue !== undefined ? node.nodeValue : node.text + node.children.map(textOf).join('');
}
function fakeJquery(registry) {
    function wrap(list) {
        const w = {
            nodes: list, length: list.length,
            each(fn) { list.forEach((e, i) => fn.call(e, i, e)); return w; },
            toggleClass(c, on) { list.forEach((e) => ((on === undefined ? !e.classes.has(c) : on) ? e.classes.add(c) : e.classes.delete(c))); return w; },
            addClass(c) { list.forEach((e) => e.classes.add(c)); return w; },
            removeClass(c) { list.forEach((e) => e.classes.delete(c)); return w; },
            hasClass(c) { return list.some((e) => e.classes.has(c)); },
            attr(name, value) {
                if (value === undefined) return list[0] ? list[0].getAttribute(name) : undefined;
                list.forEach((e) => { e.attrs[name] = String(value); });
                return w;
            },
            text(value) {
                if (value === undefined) return list.map(textOf).join('');
                list.forEach((e) => { e.text = String(value); e.children = []; });
                return w;
            },
            empty() { list.forEach((e) => { e.text = ''; e.children = []; }); return w; },
            append(...nodes) { list.forEach((e) => nodes.forEach((n) => e.children.push(n && n.nodes ? n.nodes[0] : n))); return w; },
            remove() { return w; },
            val(value) { list.forEach((e) => { e.value = value; }); return w; },
            css(name, value) { list.forEach((e) => { (e.css = e.css || {})[name] = value; }); return w; },
            prop(name, value) { if (value === undefined) return list[0] && list[0].props ? list[0].props[name] : undefined; list.forEach((e) => { (e.props = e.props || {})[name] = value; }); return w; },
            closest() { return wrap([]); },
        };
        return w;
    }
    const $ = (sel) => {
        if (sel && sel.nodes) return sel;
        if (typeof sel !== 'string') return wrap(sel ? [sel] : []);
        if (/^<\w+>$/.test(sel)) return wrap([element({})]);
        return wrap(registry[sel] || (registry[sel] = [element({})]));
    };
    $.extend = Object.assign;
    return $;
}

// logs: [{ min, max (us), fields, error }]; the open log is logs[0]
function fakeFlightLog(logs) {
    let open = 0;
    return {
        getLogIndex: () => open, getLogCount: () => logs.length, getLogError: (i) => logs[i].error || false,
        getMinTime: (i) => logs[i === undefined ? open : i].min, getMaxTime: (i) => logs[i === undefined ? open : i].max,
        getMainFieldIndexByName: (name) => (logs[open].fields.includes(name) ? logs[open].fields.indexOf(name) : undefined),
        getSysConfig: () => ({ debug_mode: 0 }),
        openLog: (i) => { open = i; return true; },
    };
}

const LOGS = [
    { min: 1e6, max: 61e6, fields: ['time', 'gyroADC[0]', 'motor[0]'] },
    { min: 100e6, max: 400e6, fields: ['time', 'setpoint[0]', 'gyroADC[0]', 'axisError[0]', 'headspeed'] },
    { min: 500e6, max: 520e6, fields: [], error: 'Log truncated' },
];
const USER_GRAPHS = [{ label: 'Gyros', fields: [{ name: 'gyroADC[0]' }] }, { label: 'Motors', fields: [{ name: 'motor[0]' }] }];

function shell({ logs = LOGS, withLog = true } = {}) {
    const calls = [], registry = {}, elements = {};
    registry['.rf-view-tab'] = ['viewer', 'analysis', 'tuning'].map((v) => element({ 'data-view': v }));
    const legend = { firstChild: { nodeValue: 'Legend ' } };
    const flightLog = withLog ? fakeFlightLog(logs) : null;
    const graph = withLog ? {
        width: 4e6, drawAnalyser: false, analyser: false, // the window of the user's zoom level, 25 %
        setGraphZoom(zoom) { this.width = Math.round(1e6 / zoom); calls.push(['zoom', zoom]); }, // as js/grapher.js
        getWindowWidthTime() { return this.width; },
        setInTime(t) { calls.push(['in', t]); }, setOutTime(t) { calls.push(['out', t]); },
        setDrawAnalyser(on) { this.drawAnalyser = on; }, setAnalyser(on) { this.analyser = on; },
        render(t) { calls.push(['render', t]); },
    } : null;
    const activeGraphConfig = {
        graphs: [], selectedFieldName: 'Gyro [roll]', selectedGraphIndex: 0, selectedFieldIndex: 0,
        // the colors of GraphConfig.PALETTE, from the first in each graph, as js/graph_config.js adaptGraphs
        adaptGraphs(log, config) { this.graphs = config.map((g) => ({ fields: g.fields.map((f, j) => ({ name: f.name, friendlyName: `F ${f.name}`, color: ['#fb8072', '#8dd3c7', '#ffffb3'][j % 3] })) })); calls.push(['adapt', config]); },
        getGraphs() { return this.graphs; },
    };
    const ctx = vm.createContext({
        $: fakeJquery(registry), record: (...call) => calls.push(call), flightLog, graph, activeGraphConfig,
        document: {
            getElementById: (id) => (id === 'legend_title' ? legend : elements[id] || (elements[id] = element({ id }))),
            createTextNode: (text) => ({ nodeValue: text }),
            activeElement: element({}),
            documentElement: { style: { setProperty: (k, v) => calls.push(['cssVar', k, v]) } },
        },
        TuningPlot: { setTextScale: (s) => calls.push(['textScale', s]) },
        seekBar: { setInTime() {}, setOutTime() {}, setCurrentTime() {}, setWindow() {}, repaint() {} },
        prefs: { set(key, value) { calls.push(['prefs', key, value]); } },
        ContextMenu: { close() { calls.push(['contextMenu.close']); } },
        FlightLogFieldPresenter: { fieldNameToFriendly: (name) => `F ${name}` },
        requestAnimationFrame: () => calls.push(['raf']),
    });
    const constants = /const GRAPH_ZOOM_LEVEL = \[[\s\S]*?\];/.exec(MAIN)[0] + '\n' + /const\s+GRAPH_MIN_ZOOM[\s\S]*?;/.exec(MAIN)[0];
    const state = /var\s+activeView = "viewer",[\s\S]*?evidence = null;[^\n]*/.exec(MAIN)[0];
    vm.runInContext(`"use strict";
        ${constants}
        var GRAPH_STATE_PAUSED = 0, GRAPH_STATE_PLAY = 1, graphState = GRAPH_STATE_PAUSED, currentBlackboxTime = 0, lastRenderTime = false,
            graphRendersCount = 0, animationFrameIsQueued = false, playbackRate = 100, hasLog = ${withLog}, hasVideo = false, video = {},
            videoOffset = 0, graphConfig = null, lastGraphConfig = null, hasAnalyser = false, hasAnalyserFullscreen = false,
            videoExportInTime = false, videoExportOutTime = false, graphZoom = GRAPH_DEFAULT_ZOOM, lastGraphZoom = GRAPH_DEFAULT_ZOOM,
            html = $("html"), updateValuesChartRateLimited = function() {}, seekBarRepaintRateLimited = function() {}, workspaceSelection = null;
        ${state}
        ${/var TEXT_SIZES = [\s\S]*?;/.exec(MAIN)[0]}
        ${/var resultFilter = [\s\S]*?;/.exec(MAIN)[0]}
        function invalidateGraph() { record("invalidate"); }
        function updateCanvasSize() { record("canvas"); }
        function updateValuesChart() { record("values"); }
        function setGraphState(s) { graphState = s; record("state", s); }
        function syncLogToVideo() {}
        // as main.js selectLog: open the log, clear the in and out marks, start at its beginning
        function selectLog(i) { record("selectLog", i); flightLog.openLog(i); setVideoInTime(false); setVideoOutTime(false);
            activeGraphConfig.adaptGraphs(flightLog, graphConfig); currentBlackboxTime = flightLog.getMinTime(); }
        ${SHELL.map((name) => extract(MAIN, name)).join('\n')}
        if (flightLog) { graphConfig = ${JSON.stringify(USER_GRAPHS)}; activeGraphConfig.adaptGraphs(flightLog, graphConfig); currentBlackboxTime = 5e6; }
        this.read = function(name) { return eval(name); };`, ctx);
    const views = {};
    for (const name of ['analysis', 'tuning']) {
        views[name] = { show: (log) => calls.push([`${name}.show`, log]), hide: () => calls.push([`${name}.hide`]) };
    }
    Object.assign(ctx.views, views);
    calls.length = 0;
    const tabs = () => registry['.rf-view-tab'].map((e) => `${e.attrs['data-view']}:${e.attrs['aria-selected']}:${e.classes.has('is-active')}`);
    const bar = () => ({ text: registry['.log-evidence-text'][0].children.map(textOf).join(''), title: registry['.log-evidence-text'][0].attrs.title,
        back: registry['.log-evidence-back'][0].text, backTitle: registry['.log-evidence-back'][0].attrs.title });
    return { ctx, calls, graph, flightLog, legend, elements, activeGraphConfig, tabs, bar, html: registry.html[0], of: (kind) => calls.filter((c) => c[0] === kind) };
}

test('zoomForWidth: the width held in 0.1 s to 100 s, the exact zoom, and the nearest zoom level on a log scale', () => {
    const { ctx } = shell();
    const LEVELS = ctx.read('GRAPH_ZOOM_LEVEL');
    assert.deepEqual(Array.from(LEVELS), [1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000], 'the percent levels of the zoom slider');
    const z = (w) => plain(ctx.zoomForWidth(w));
    // ground truth: a 4 s span with a 10 % margin is a 4.4 s window, zoom 22.7 %, nearest level 25 % (|ln(25/22.7)| = 0.10 < |ln(10/22.7)| = 0.82)
    assert.deepEqual(z(4.4e6), { width: 4.4e6, zoom: 1e6 / 4.4e6, level: 4 });
    assert.deepEqual(z(1e6), { width: 1e6, zoom: 1, level: 6 }, '1 s: 100 %');
    assert.deepEqual(z(10e6), { width: 10e6, zoom: 0.1, level: 3 }, '10 s: 10 %');
    assert.deepEqual(z(50e3), { width: 100e3, zoom: 10, level: 9 }, '50 ms: the narrowest window, 0.1 s');
    assert.deepEqual(z(0), { width: 100e3, zoom: 10, level: 9 }, 'an empty span: 0.1 s');
    assert.deepEqual(z(500e6), { width: 100e6, zoom: 0.01, level: 0 }, '500 s: the widest window, 100 s');
    assert.equal(z(1e6 / 0.34).level, 4, '34 %: nearer to 25 % than to 50 %');
    assert.equal(z(1e6 / 0.36).level, 5, '36 %: nearer to 50 % than to 25 %');
    // every width from 10 ms to 1000 s: the level is the minimum of |ln(level / zoom)|
    for (let lw = 4; lw <= 9; lw += 0.01) {
        const r = ctx.zoomForWidth(10 ** lw), w = Math.min(Math.max(10 ** lw, 1e5), 1e8);
        assert.equal(r.width, w);
        const err = (i) => Math.abs(Math.log(LEVELS[i] / 100 / (1e6 / w)));
        for (let i = 0; i < LEVELS.length; i++) assert.ok(err(r.level) <= err(i) + 1e-12, `width ${w}: level ${r.level} against ${i}`);
    }
});

test('showView: no view without a log; the views get show and hide; leaving the viewer pauses it', () => {
    const none = shell({ withLog: false });
    none.ctx.showView('tuning');
    assert.equal(none.ctx.read('activeView'), 'viewer');
    assert.deepEqual(none.of('tuning.show'), [], 'a video on its own shows only the viewer');

    const app = shell();
    app.ctx.showView('tuning');
    assert.equal(app.ctx.read('activeView'), 'tuning');
    assert.equal(app.html.attrs['data-view'], 'tuning');
    assert.deepEqual(app.tabs(), ['viewer:false:false', 'analysis:false:false', 'tuning:true:true']);
    assert.deepEqual(app.of('state'), [['state', 0]], 'playback stops');
    assert.equal(app.of('contextMenu.close').length, 1);
    assert.deepEqual(app.of('tuning.show'), [['tuning.show', app.flightLog]]);
    assert.deepEqual(plain(app.elements.viewTuning.focused), [{ preventScroll: true }], 'the keys scroll the view');

    app.calls.length = 0;
    app.ctx.showView('analysis');
    assert.deepEqual(app.calls.filter((c) => /\.(show|hide)$/.test(c[0])), [['tuning.hide'], ['analysis.show', app.flightLog]]);
    assert.deepEqual(plain(app.elements.viewAnalysis.focused), [{ preventScroll: true }]);

    app.calls.length = 0;
    app.ctx.showView('nothing');
    assert.equal(app.ctx.read('activeView'), 'viewer', 'an unknown name: the viewer');
    assert.deepEqual(app.of('analysis.hide'), [['analysis.hide']]);
    assert.deepEqual(app.of('in'), [], 'the marks stay as they are: no view changes the analyser range');
    assert.deepEqual(app.calls.filter((c) => c[0] === 'values' || c[0] === 'canvas'), [['values'], ['canvas']],
        'the legend values, then the canvas size (the legend width sets the graph width), which also draws');
    assert.deepEqual(app.tabs(), ['viewer:true:true', 'analysis:false:false', 'tuning:false:false']);

    // Analysis, then Tuning, then the viewer: the marks stay
    app.ctx.showView('analysis');
    app.ctx.showView('tuning');
    app.calls.length = 0;
    app.ctx.showView('viewer');
    assert.deepEqual(app.of('in'), []);
});

test('animationLoop draws the viewer only while it is on display', () => {
    const app = shell();
    app.ctx.showView('tuning');
    app.calls.length = 0;
    app.ctx.animationLoop();
    assert.deepEqual(app.of('render'), []);
    assert.equal(app.ctx.read('animationFrameIsQueued'), false, 'a later invalidateGraph queues a frame again');
    app.ctx.showView('viewer');
    app.ctx.animationLoop();
    assert.deepEqual(app.of('render'), [['render', 5e6]]);
});

test('Show in the log: the fields of that log, the span marked and fitted, the bar, and back to the view', () => {
    const app = shell();
    app.ctx.showView('analysis');
    app.calls.length = 0;
    const ok = app.ctx.viewInLog({ log: 1, fromS: 40, toS: 44, atS: 42, graphs: [['setpoint[0]', 'gyroADC[0]'], ['gyroRAW[0]']], analyser: 'gyroADC[0]',
        title: 'C12 roll: Problem', text: 'The tracking error is 52 %.', from: 'analysis' });
    assert.equal(ok, true);
    assert.deepEqual(app.of('selectLog'), [['selectLog', 1]], 'log 2 of the file');
    // the fields that log 2 has, as measured; gyroRAW[0] is not in it
    assert.deepEqual(plain(app.ctx.read('graphConfig')), [{ label: 'F setpoint[0], F gyroADC[0]', height: 1, fields: [
        { name: 'setpoint[0]', smoothing: 0, curve: { power: 1, outputRange: 1 } }, { name: 'gyroADC[0]', smoothing: 0, curve: { power: 1, outputRange: 1 } }] }]);
    // frame seconds from the start of log 2: in, then out (GraphSpectrumCalc.setOutTime measures from the in time)
    const marks = app.calls.filter((c) => (c[0] === 'in' || c[0] === 'out') && c[1] !== false);
    assert.deepEqual(marks, [['in', 140e6], ['out', 144e6]], 'set one time');
    assert.equal(app.ctx.read('videoExportInTime'), 140e6);
    assert.equal(app.ctx.read('videoExportOutTime'), 144e6);
    // a 4.4 s window (10 % margin), zoom slider at 25 %, centred on the span; playback stops
    assert.equal(app.graph.getWindowWidthTime(), 4.4e6);
    assert.equal(app.ctx.read('graphZoom'), 4);
    assert.equal(app.ctx.read('currentBlackboxTime'), 142e6);
    assert.equal(app.ctx.read('graphState'), 0);
    // the analyser on gyroADC[0]: graph 0, field 1
    assert.deepEqual([app.activeGraphConfig.selectedFieldName, app.activeGraphConfig.selectedGraphIndex, app.activeGraphConfig.selectedFieldIndex], ['F gyroADC[0]', 0, 1]);
    assert.equal(app.ctx.read('hasAnalyser'), true);
    assert.equal(app.graph.drawAnalyser, true);
    // the bar and the legend title (STE)
    assert.equal(app.legend.firstChild.nodeValue, 'Show in the log ');
    assert.deepEqual(app.bar(), {
        text: 'C12 roll: Problem The graphs show log 2 from 40.0 s to 44.0 s. This log does not contain these fields: gyroRAW[0]. The tracking error is 52 %.',
        title: 'C12 roll: Problem\nThe tracking error is 52 %.\nThe graphs show log 2 from 40.0 s to 44.0 s. This log does not contain these fields: gyroRAW[0].',
        back: 'Back to Analysis', backTitle: 'Show the Analysis view again' });
    assert.ok(app.html.classes.has('has-evidence'));
    assert.equal(app.ctx.read('activeView'), 'viewer');
    assert.deepEqual(app.of('analysis.hide'), [['analysis.hide']]);
    assert.deepEqual(app.of('prefs'), [], 'nothing goes to prefs');

    // Back: the Analysis view again, and the user's log, graphs, marks, zoom, time, analyser and legend title
    app.calls.length = 0;
    app.ctx.showView(app.ctx.read('evidence').from);
    assert.equal(app.ctx.read('activeView'), 'analysis');
    assert.equal(app.ctx.read('evidence'), null);
    assert.ok(!app.html.classes.has('has-evidence'));
    assert.deepEqual(app.of('selectLog'), [['selectLog', 0]]);
    assert.deepEqual(plain(app.ctx.read('graphConfig')), USER_GRAPHS);
    assert.equal(app.ctx.read('videoExportInTime'), false);
    assert.equal(app.ctx.read('videoExportOutTime'), false);
    assert.equal(app.ctx.read('currentBlackboxTime'), 5e6);
    assert.equal(app.ctx.read('graphZoom'), 4);
    assert.equal(app.ctx.read('lastGraphZoom'), 4);
    assert.equal(app.graph.getWindowWidthTime(), 4e6, 'the zoom level of the user again, 25 %: a 4 s window');
    assert.equal(app.ctx.read('hasAnalyser'), false);
    assert.equal(app.graph.drawAnalyser, false);
    assert.deepEqual([app.activeGraphConfig.selectedFieldName, app.activeGraphConfig.selectedGraphIndex, app.activeGraphConfig.selectedFieldIndex], ['Gyro [roll]', 0, 0]);
    assert.equal(app.legend.firstChild.nodeValue, 'Legend ');
    assert.deepEqual(app.of('analysis.show'), [['analysis.show', app.flightLog]]);
    assert.deepEqual(app.of('prefs'), []);
});

test('Show in the log: nested requests keep the first snapshot, a graph change of the user stays, a bad request changes nothing', () => {
    const app = shell();
    app.ctx.showView('tuning');
    assert.equal(app.ctx.viewInLog({ fromS: 10, toS: 12, graphs: [['gyroADC[0]']] }), true, 'the open log');
    assert.deepEqual(app.bar().back, 'Back to Tuning');
    assert.equal(app.bar().text, 'Show in the log The graphs show log 1 from 10.0 s to 12.0 s.', 'no title: the default');
    assert.equal(app.ctx.viewInLog({ log: 1, fromS: 250, toS: 0, atS: 200 }), true, 'a reversed span of 250 s, no fields');
    assert.equal(app.ctx.read('videoExportInTime'), 100e6, 'swapped: in at the log start');
    assert.equal(app.ctx.read('videoExportOutTime'), 350e6);
    assert.equal(app.graph.getWindowWidthTime(), 100e6, 'the widest window, 100 s');
    assert.equal(app.ctx.read('currentBlackboxTime'), 300e6, 'centred on atS: the span is wider than the window');
    assert.deepEqual(plain(app.ctx.read('graphConfig')), [{ label: 'F gyroADC[0]', height: 1,
        fields: [{ name: 'gyroADC[0]', smoothing: 0, curve: { power: 1, outputRange: 1 } }] }], 'no fields asked: the graphs on display stay');
    app.ctx.endEvidence('all');
    assert.deepEqual(plain(app.ctx.read('graphConfig')), USER_GRAPHS, 'the first snapshot: the user\'s graphs');
    assert.equal(app.ctx.read('currentBlackboxTime'), 5e6);
    assert.equal(app.flightLog.getLogIndex(), 0);

    // the user changes the graphs while the bar shows (Graph setup, a workspace): Back keeps the change
    app.ctx.viewInLog({ fromS: 10, toS: 12, graphs: [['gyroADC[0]']] });
    const mine = [{ label: 'Mine', fields: [{ name: 'motor[0]' }] }];
    app.ctx.newGraphConfig(mine);
    app.ctx.endEvidence('all');
    assert.deepEqual(plain(app.ctx.read('graphConfig')), mine);

    // a new file opens while the bar shows (main.js loadLogFile): the user's graphs, zoom and legend title come back, the log,
    // marks and time are left to selectLog, and nothing reads the new FlightLog before selectLog opens it
    app.ctx.viewInLog({ log: 1, fromS: 40, toS: 44, graphs: [['gyroADC[0]']] });
    app.calls.length = 0;
    app.ctx.endEvidence('graphs');
    assert.deepEqual(plain(app.ctx.read('graphConfig')), mine);
    assert.equal(app.graph.getWindowWidthTime(), 4e6);
    assert.equal(app.legend.firstChild.nodeValue, 'Legend ');
    assert.ok(!app.html.classes.has('has-evidence'));
    assert.deepEqual(app.calls.filter((c) => ['values', 'selectLog', 'adapt'].includes(c[0]) || (c[0] === 'in' || c[0] === 'out')), []);
    assert.equal(app.ctx.read('videoExportInTime'), 140e6, 'the marks: selectLog clears them');
    app.ctx.selectLog(0);

    // a span past the end of the log is held in it
    app.ctx.viewInLog({ fromS: 58, toS: 70 });
    assert.equal(app.ctx.read('videoExportOutTime'), 61e6);
    app.ctx.endEvidence('all');

    const before = app.calls.length;
    for (const req of [null, { fromS: '1', toS: 2 }, { fromS: 1 }, { log: 2, fromS: 1, toS: 2 }, { log: 3, fromS: 1, toS: 2 }, { log: -1, fromS: 1, toS: 2 }]) {
        assert.equal(app.ctx.viewInLog(req), false, JSON.stringify(req));
    }
    assert.equal(app.calls.length, before, 'nothing changed');
    assert.equal(app.ctx.read('evidence'), null);
    assert.equal(shell({ withLog: false }).ctx.viewInLog({ fromS: 1, toS: 2 }), false, 'no log');
});

test('Show in the log: a workspace that the user picks while the bar shows keeps its graphs and its legend title after Back (B3)', () => {
    const app = shell();
    app.ctx.showView('tuning');
    app.ctx.viewInLog({ log: 1, fromS: 10, toS: 14, graphs: [['setpoint[0]', 'gyroADC[0]']], title: 'C12', from: 'tuning' });
    assert.equal(app.legend.firstChild.nodeValue, 'Show in the log ');
    const WS = [{ title: 'Gyros', graphConfig: USER_GRAPHS }, { title: 'Motors', graphConfig: [{ label: 'Motors', fields: [{ name: 'motor[0]' }] }] }];
    app.ctx.onSwitchWorkspace(WS, 1); // main.js: newGraphConfig, then setLegendTitle
    assert.equal(app.legend.firstChild.nodeValue, 'Motors ');
    // a second "Show in the log" keeps the first snapshot and the title that the user picked
    app.ctx.viewInLog({ log: 1, fromS: 20, toS: 24, graphs: [['headspeed']], title: 'G2', from: 'tuning' });
    assert.equal(app.legend.firstChild.nodeValue, 'Show in the log ');
    app.ctx.showView('tuning'); // Back to Tuning
    app.ctx.showView('viewer');
    assert.deepEqual(plain(app.ctx.read('graphConfig')), WS[1].graphConfig, 'the graphs of the workspace');
    assert.equal(app.legend.firstChild.nodeValue, 'Motors ', 'the title of the workspace, not the old one');
    // with no workspace switch: the title of the snapshot
    app.ctx.viewInLog({ log: 1, fromS: 10, toS: 14, graphs: [['gyroADC[0]']], title: 'C12', from: 'tuning' });
    app.ctx.endEvidence('all');
    assert.equal(app.legend.firstChild.nodeValue, 'Motors ');
});

// Regression (2026-10-06, NW.js audit V3): a log that the pilot picks in the log picker of the legend while "Show in the log" is on
// display stays. Before, "Back to ...", a view tab and the close button opened the log of the snapshot again, so the pilot could not
// select another log (flight) after a "Show in the log".
test('the log picker during "Show in the log": the picked log stays after Back, a view tab or the close button', () => {
    const pick = (app, i) => { app.ctx.selectLog(i); app.ctx.evidenceLogPicked(); }; // the picker's own handler, then ours (delegated)
    const views = (app) => app.ctx.read('views');
    for (const leave of ['back', 'tab', 'close']) {
        const app = shell();
        Object.assign(views(app), { analysis: { show() {}, hide() {} }, tuning: { show() {}, hide() {} } });
        app.ctx.showView('analysis');
        app.ctx.viewInLog({ log: 1, fromS: 40, toS: 44, graphs: [['setpoint[0]', 'gyroADC[0]']], analyser: 'gyroADC[0]', title: 'C12', from: 'analysis' });
        assert.equal(app.flightLog.getLogIndex(), 1);
        app.calls.length = 0;
        pick(app, 0); // log 1 of the file, in the picker
        assert.equal(app.ctx.read('evidence'), null, `${leave}: the bar ends, its span is of another log`);
        assert.ok(!app.html.classes.has('has-evidence'));
        assert.deepEqual(app.of('selectLog'), [['selectLog', 0]], 'only the pick opens a log');
        assert.deepEqual(plain(app.ctx.read('graphConfig')), USER_GRAPHS, 'the pilot\'s graphs again');
        assert.equal(app.ctx.read('hasAnalyser'), false, 'the pilot\'s analyser again');
        assert.equal(app.legend.firstChild.nodeValue, 'Legend ');
        assert.equal(app.graph.getWindowWidthTime(), 4e6, 'the pilot\'s zoom again');
        assert.equal(app.ctx.read('currentBlackboxTime'), 1e6, 'the start of the picked log (selectLog)');
        assert.equal(app.ctx.read('videoExportInTime'), false, 'no marks of the span of the other log');
        if (leave === 'back') app.ctx.showView('analysis');
        else if (leave === 'tab') { app.ctx.showView('tuning'); app.ctx.showView('viewer'); }
        else app.ctx.endEvidence('all');
        assert.equal(app.flightLog.getLogIndex(), 0, `${leave}: the picked log stays`);
        assert.deepEqual(app.of('selectLog'), [['selectLog', 0]], `${leave}: no other log opens`);
    }
    // the same pick with no bar: only the pick (the picker of the upstream viewer)
    const plainApp = shell();
    plainApp.calls.length = 0;
    pick(plainApp, 1);
    assert.deepEqual(plainApp.of('selectLog'), [['selectLog', 1]]);
    assert.equal(plainApp.ctx.read('evidence'), null);
    assert.equal(plainApp.ctx.evidenceLogPicked(), false, 'nothing to end');
    // the handler: delegated on the document, after the picker's own change handler (renderLogFileInfo), which stays as upstream
    assert.match(MAIN, /\$\(document\)\.on\("change", "select\.log-index", function\(\) \{\s*evidenceLogPicked\(\);\s*\}\);/);
    assert.match(MAIN, /logIndexPicker\.change\(function\(\) \{\s*selectLog\(parseInt\(\$\(this\)\.val\(\), 10\)\);/, 'the upstream picker handler');
});

test('a mouse click on a view tab gives the keys back to the log viewer: jQuery 1.11 events have detail on originalEvent (B6)', () => {
    const src = /\$\("\.rf-view-tab"\)\.click\((function\(e\) \{[\s\S]*?\n        \})\);/.exec(MAIN);
    assert.ok(src, 'the click handler of the tabs');
    const shown = [], handler = vm.runInNewContext(`(${src[1]})`, { showView: (v) => shown.push(v) });
    const tab = () => ({ blurred: 0, blur() { this.blurred++; }, getAttribute: () => 'tuning' });
    const mouse = tab(), key = tab();
    handler.call(mouse, { preventDefault() {}, originalEvent: { detail: 1 } }); // jQuery 1.11.3 does not copy `detail`
    handler.call(key, { preventDefault() {}, originalEvent: { detail: 0 } });   // Enter or Space on the tab
    assert.deepEqual([mouse.blurred, key.blurred, shown], [1, 0, ['tuning', 'tuning']]);
});

// ---------------------------------------------------------------------------------------------------------------------
// ASD-STE100 (Issue 9) for the texts of this part: a few machine checks. test/ste_text.test.cjs has the full lint.

test('the texts of the views shell are STE: no semicolons, short sentences, no -ing forms, no Latin, contractions or "+-"', () => {
    const app = shell();
    app.ctx.viewInLog({ log: 1, fromS: 40, toS: 44, graphs: [['gyroRAW[0]', 'gyroADC[0]']], from: 'analysis' });
    const texts = [
        ...[...HTML.matchAll(/<button [^>]*class="rf-view-tab[^"]*"[^>]*>([^<]*)</g)].map((m) => ['label', m[1]]),
        ['label', 'Views'], ['label', 'Back to Tuning'], ['label', 'Show in the log'],
        ['instruction', /log-evidence-back" title="([^"]*)"/.exec(HTML)[1]], ['instruction', /log-evidence-close" aria-label="Close" title="([^"]*)"/.exec(HTML)[1]],
        ['instruction', app.bar().backTitle], ['label', app.bar().back], ['description', app.bar().text.replace(/^Show in the log /, '')],
    ];
    const ING = new Set(['tuning', 'during', 'missing', 'remaining']);
    for (const [kind, text] of texts) {
        assert.doesNotMatch(text, /;|\+-|\b(e\.g|i\.e|etc|vs)\b|n't|'(re|ve|ll|s)\b/i, text);
        assert.doesNotMatch(text, /\b(above|below|over|under)\s+[\d(]/i, `${text}: "more than" or "less than" for limits`);
        assert.doesNotMatch(text, /\b(view in|analy[sz]e|flight analysis)\b/i, `${text}: not approved here`);
        for (const word of text.match(/[A-Za-z]{3,}ing\b/g) || []) assert.ok(ING.has(word.toLowerCase()), `${text}: -ing form "${word}"`);
        for (const sentence of text.split(/(?<=\.)\s+/)) {
            const words = sentence.replace(/\d[\d.]*\s*(s|%)\b/g, 'N').split(/\s+/).filter(Boolean).length;
            assert.ok(words <= (kind === 'instruction' ? 20 : 25), `${sentence}: ${words} words`);
            if (kind === 'instruction') assert.match(sentence, /^(Show|Close)\b/, `${sentence}: imperative`);
        }
    }
});

// ---------------------------------------------------------------------------------------------------------------------
// SPEC3 C: the text size of the views; SPEC3 E: the filters of the result lists, the legend and "Show the period again"
// of "Show in the log"

test('index.html and CSS: the "Text" control sits after the view tabs and shows only with the Analysis and Tuning views', () => {
    const at = HTML.indexOf('<div class="rf-view-text"'), tabs = HTML.indexOf('class="rf-view-tabs"'), file = HTML.indexOf('class="rf-navbar-file');
    assert.ok(tabs > 0 && tabs < at && at < file, 'in the navbar, after the tab strip');
    const box = HTML.slice(at, HTML.indexOf('</div>', at));
    assert.match(box, /role="group" aria-label="Text of the Analysis and Tuning views"/);
    assert.match(box, /<span class="rf-view-text-label" title="Make the text of the Analysis and Tuning views smaller or larger\. The app keeps this value\.">Text<\/span>/);
    assert.match(box, /<button type="button" class="rf-view-text-step" data-text-step="-1" title="Make the text smaller" aria-label="Make the text smaller">A&minus;<\/button>/);
    assert.match(box, /<button type="button" class="rf-view-text-value" title="Set the text to 100 %">100 %<\/button>/);
    assert.match(box, /<button type="button" class="rf-view-text-step" data-text-step="1" title="Make the text larger" aria-label="Make the text larger">A\+<\/button>/);
    const branding = read('css/branding.css');
    assert.match(branding, /\.rf-view-text \{\s*display: none;/);
    assert.match(branding, /html\.has-log\[data-view="analysis"\] \.rf-view-text,\s*html\.has-log\[data-view="tuning"\] \.rf-view-text \{\s*display: inline-flex;\s*\}/);
    // the view text in units of the scale: the Tuning view, the verdict and the lens 15 px at 100 %
    assert.match(read('css/main.css'), /:root \{\s*--rf-text-scale: 1;/);
    const lens = read('css/log_lens.css');
    assert.match(lens, /\.analysis-verdict-box \{[^}]*font-size: calc\(15 \* var\(--rf-px\)\);/);
    assert.match(lens, /\.log-lens \{[^}]*font-size: calc\(15 \* var\(--rf-px\)\);/);
    assert.doesNotMatch(lens, /font-size: [\d.]+px|line-height: [\d.]+px/, 'no fixed text size in the Analysis view');
    for (const m of lens.matchAll(/font-size: calc\(([\d.]+) \* var\(--rf-px\)\)/g)) assert.ok(+m[1] >= 12, `${m[1]} px: 12 px or more at 100 %`);
});

test('the upstream Flight analysis files stay byte-identical to HEAD', () => {
    const { execFileSync } = require('node:child_process');
    for (const file of ['js/flight_analysis_dialog.js', 'css/flight_analysis_dialog.css']) {
        let head;
        try { head = execFileSync('git', ['show', `HEAD:${file}`], { cwd: ROOT, maxBuffer: 1 << 26 }); } catch (e) { return; } // not a git checkout: nothing to compare
        assert.ok(fs.readFileSync(path.join(ROOT, file)).equals(head), file);
    }
});

test('main.js setTextSize: 90 % to 160 % in steps of 10 %, at once in the CSS variable and the plots, into the preferences on a click', () => {
    const app = shell(), c = app.ctx;
    assert.deepEqual([c.textSizeStep(100, 1), c.textSizeStep(100, -1), c.textSizeStep(160, 1), c.textSizeStep(90, -1), c.textSizeStep(127, 0), c.textSizeStep('x', 0), c.textSizeStep(null, 1)],
        [110, 90, 160, 90, 130, 100, 110]);
    app.calls.length = 0;
    assert.equal(c.setTextSize(140, true), 140);
    assert.deepEqual(app.of('cssVar'), [['cssVar', '--rf-text-scale', '1.4']]);
    assert.deepEqual(app.of('textScale'), [['textScale', 1.4]], 'the canvas plots draw again');
    assert.deepEqual(app.of('prefs'), [['prefs', 'viewTextSize', 140]]);
    const reg = (sel) => c.$(sel).nodes[0];
    assert.equal(reg('.rf-view-text-value').text, '140 %');
    assert.equal(c.setTextSize(500, false), 160, 'a stored value out of range: the nearest step');
    assert.equal(reg('.rf-view-text-value').text, '160 %');
    assert.equal(app.of('prefs').length, 1, 'no save without a click');
    assert.equal(c.read('textSize'), 160);
    // the startup and the clicks in main.js
    assert.match(MAIN, /setTextSize\(100, false\);\s*prefs\.get\('viewTextSize', function\(item\) \{\s*if \(item !== null && item !== undefined\) \{\s*setTextSize\(item, false\);/);
    assert.match(MAIN, /\$\("\.rf-view-text-step"\)\.click\(function\(e\) \{\s*e\.preventDefault\(\);\s*setTextSize\(textSizeStep\(textSize, \+this\.getAttribute\("data-text-step"\)\), true\);/);
    assert.match(MAIN, /\$\("\.rf-view-text-value"\)\.click\(function\(e\) \{\s*e\.preventDefault\(\);\s*setTextSize\(100, true\);/);
});

test('main.js setResultFilter: the two filters of the result lists, off at first, to each listener and into the preferences', () => {
    const app = shell(), c = app.ctx, got = [];
    assert.deepEqual(plain(c.read('resultFilter')), { thin: false, ok: false });
    c.read('resultFilterListeners').push((f) => got.push(plain(f)));
    app.calls.length = 0;
    c.setResultFilter({ thin: 1, ok: 0, other: true }, true);
    assert.deepEqual(got, [{ thin: true, ok: false }]);
    assert.deepEqual(plain(app.of('prefs')), [['prefs', 'resultFilter', { thin: true, ok: false }]]);
    c.setResultFilter(null, false);
    assert.deepEqual(got[1], { thin: false, ok: false });
    assert.equal(app.of('prefs').length, 1);
    // the hooks of the two views: read, set (saved) and listen
    assert.match(MAIN, /resultFilter: function\(\) \{ return \{thin: resultFilter\.thin, ok: resultFilter\.ok\}; \},\s*setResultFilter: function\(f\) \{ return setResultFilter\(f, true\); \},\s*onResultFilter: function\(cb\)/);
    assert.match(MAIN, /prefs\.get\('resultFilter', function\(item\) \{\s*if \(item && typeof item === "object"\) \{\s*setResultFilter\(item, false\);/);
});

test('Show in the log: a legend of the curves in the bar (color, field name in code font, STE label), and "Show the period again"', () => {
    const app = shell(), c = app.ctx;
    // the labels: field names to short STE labels, none for a field without one
    const rows = plain(c.evidenceBar([{ fields: [{ name: 'gyroADC[2]', color: '#fb8072' }, { name: 'gyroRAW[0]', color: '#8dd3c7' }, { name: 'setpoint[3]' }] },
        { fields: [] }, { fields: [{ name: 'axisD[1]', color: '#ffffb3' }, { name: 'mixer[2]' }, { name: 'rcCommand[3]' }, { name: 'headspeed' }, { name: 'govTarget' }, { name: 'debug[0]' }] }]));
    assert.deepEqual(rows, [
        { graph: 1, fields: [{ name: 'gyroADC[2]', color: '#fb8072', label: 'yaw rate' }, { name: 'gyroRAW[0]', color: '#8dd3c7', label: 'roll rate before the filters' },
            { name: 'setpoint[3]', color: '#ffffff', label: 'collective setpoint' }] },
        { graph: 3, fields: [{ name: 'axisD[1]', color: '#ffffb3', label: 'pitch D-term' }, { name: 'mixer[2]', color: '#ffffff', label: 'tail output' },
            { name: 'rcCommand[3]', color: '#ffffff', label: 'collective stick' }, { name: 'headspeed', color: '#ffffff', label: 'headspeed' },
            { name: 'govTarget', color: '#ffffff', label: 'governor target' }, { name: 'debug[0]', color: '#ffffff', label: '' }] }]);
    // the bar after "Show in the log": one group for each graph, the colors of the graphs on display
    c.viewInLog({ log: 1, fromS: 40, toS: 44, atS: 42, graphs: [['setpoint[0]', 'gyroADC[0]'], ['axisError[0]']], title: 'C12 roll: Problem', from: 'tuning' });
    const box = c.$('.log-evidence-legend').nodes[0], textOf2 = (n) => n.nodeValue !== undefined ? n.nodeValue : n.text + n.children.map(textOf2).join('');
    assert.deepEqual(box.children.map(textOf2), ['Graph 1setpoint[0]: roll setpointgyroADC[0]: roll rate', 'Graph 2axisError[0]: roll PID error']);
    const curves = box.children[0].children.slice(1);
    assert.deepEqual(curves.map((n) => n.children[0].css.background), ['#fb8072', '#8dd3c7'], 'the swatch has the color of the curve');
    assert.deepEqual(curves.map((n) => n.children[1].children[0].text), ['setpoint[0]', 'gyroADC[0]'], 'the field name in a code element');
    assert.match(HTML, /<div class="log-evidence-legend" aria-label="Curves of the graphs"><\/div>/);
    assert.match(HTML, /class="btn btn-default btn-xs log-evidence-reset" title="Show the period of the result again, with its zoom and its marks">Show the period again<\/button>/);
    // the pilot moves and zooms: "Show the period again" gives the period, its marks and its zoom again, and keeps the snapshot
    const saved = c.read('evidence').saved;
    c.setCurrentBlackboxTime(300e6);
    c.setExactZoom(2, 0.05);
    assert.equal(app.graph.getWindowWidthTime(), 20e6);
    app.calls.length = 0;
    assert.equal(c.resetEvidence(), true);
    assert.equal(app.graph.getWindowWidthTime(), 4.4e6);
    assert.equal(c.read('currentBlackboxTime'), 142e6);
    assert.equal(c.read('videoExportInTime'), 140e6);
    assert.equal(c.read('videoExportOutTime'), 144e6);
    assert.equal(c.read('evidence').saved, saved, 'Back still gives the pilot\'s own graphs');
    assert.equal(c.read('evidence').from, 'tuning');
    assert.deepEqual(app.of('prefs'), [], 'nothing goes to prefs');
    // after Back, no bar: nothing to show again
    c.endEvidence('all');
    assert.equal(c.resetEvidence(), false);
    assert.match(MAIN, /\$\("\.log-evidence-reset"\)\.click\(function\(e\) \{\s*e\.preventDefault\(\);\s*resetEvidence\(\);/);
});

test('the log picker names each entry a log, with its flights when the analysis knows them (logPickerText)', () => {
    const tools = read('js/tools.js');
    const ctx = vm.createContext({});
    vm.runInContext(['leftPad', 'formatTime'].map((name) => extract(tools, name)).join('\n') + '\n' + extract(MAIN, 'logPickerText')
        + '\nthis.text = logPickerText;', ctx);
    const log = fakeFlightLog([{ min: 6e6, max: 67e6 }, { min: 9e6, max: 25e6 }, { min: 0, max: 0, error: 'Log truncated, no data' }]);
    const fl = (n, more) => Object.assign({ bench: false, noData: false, flights: Array.from({ length: n }, () => ({})) }, more);
    assert.equal(ctx.text(log, 0, null), 'Log 1 of 3: 00:06 - 01:07 [01:01]', 'flights not known: no flight text');
    assert.equal(ctx.text(log, 0, fl(2)), 'Log 1 of 3: 00:06 - 01:07 [01:01], 2 flights', 'more than one flight in one log');
    assert.equal(ctx.text(log, 1, fl(1)), 'Log 2 of 3: 00:09 - 00:25 [00:16], 1 flight');
    assert.equal(ctx.text(log, 1, fl(0, { bench: true })), 'Log 2 of 3: 00:09 - 00:25 [00:16], Bench run (no analysis)');
    assert.equal(ctx.text(log, 1, fl(0, { noData: true })), 'Log 2 of 3: 00:09 - 00:25 [00:16]');
    assert.equal(ctx.text(log, 2, fl(1)), 'Log 3 of 3: Log truncated, no data', 'the error of the decoder');
    assert.match(MAIN, /tuningDialog\.onResult\(updateLogPicker\);/, 'a new result updates the picker');
});
