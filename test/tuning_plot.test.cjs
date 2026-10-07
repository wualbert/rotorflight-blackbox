// Tests for js/tuning_plot.js, the Tuning dialog's canvas plots. The app script runs unchanged in a vm realm with a
// fake canvas, 2D context and ResizeObserver: tick generation (linear and log), M4 decimation against brute force,
// nearest-point lookup, drawing with NaN, log axes with values <= 0 and empty series (no non-finite coordinate may
// reach the context), interaction (hover readout, click, legend toggle, resize, destroy) and speed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '../js/tuning_plot.js'), 'utf8');
const METHODS = ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'rect', 'arc', 'fill', 'stroke', 'clip',
    'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'setLineDash', 'setTransform', 'translate', 'rotate', 'drawImage'];
const RED = '#fb8072', CYAN = '#8dd3c7';
const plain = (v) => JSON.parse(JSON.stringify(v)); // objects of the vm realm have its prototypes // PALETTE[0], PALETTE[1]: default colours of series 0 and 1

function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

// 2D context stand-in: logs each call with the styles in force. Canvas ignores NaN coordinates silently, so any
// non-finite number reaching it is recorded as a gap-handling bug.
function fakeContext() {
    const ctx = { log: [], bad: [], measureText: (t) => ({ width: String(t).length * 6 }) };
    for (const m of METHODS) {
        ctx[m] = (...args) => {
            ctx.log.push({ m, args, stroke: ctx.strokeStyle, fill: ctx.fillStyle, alpha: ctx.globalAlpha ?? 1, align: ctx.textAlign, baseline: ctx.textBaseline });
            if (args.some((a) => typeof a === 'number' && !Number.isFinite(a))) ctx.bad.push(m + '(' + args.join(', ') + ')');
        };
    }
    return ctx;
}

// Canvas stand-in: css width as given (0 = not laid out), css height from style.height like a laid-out canvas,
// bounding box at (10, 20) on the page so the plot has to subtract it.
function fakeCanvas(cssWidth) {
    const listeners = {}, ctx = fakeContext();
    return {
        width: 300, height: 150, style: {}, cssWidth, ctx, listeners,
        get clientWidth() { return this.cssWidth; },
        get clientHeight() { return this.cssWidth ? parseFloat(this.style.height) || 220 : 0; }, // no inline height: the stylesheet's 220 px
        getContext: () => ctx,
        addEventListener(type, f) { (listeners[type] = listeners[type] || []).push(f); },
        removeEventListener(type, f) { listeners[type] = (listeners[type] || []).filter((g) => g !== f); },
        getBoundingClientRect() { return { left: 10, top: 20, width: this.clientWidth, height: this.clientHeight }; },
        fire(type, x, y) { for (const f of listeners[type] || []) f({ clientX: x + 10, clientY: y + 20 }); },
    };
}

// A fresh realm with the script loaded. DONT_CONTEXTIFY (Node >= 22.8) gives an ordinary global object; a
// contextified one makes every global lookup slow and would distort the timing test.
function setup(dpr = 2) {
    const realm = vm.constants?.DONT_CONTEXTIFY ? vm.createContext(vm.constants.DONT_CONTEXTIFY) : vm.createContext({});
    const created = [], observers = [];
    realm.devicePixelRatio = dpr;
    realm.document = { createElement: () => { const c = fakeCanvas(0); created.push(c); return c; } };
    realm.ResizeObserver = class {
        constructor(cb) { this.cb = cb; this.targets = []; observers.push(this); }
        observe(t) { this.targets.push(t); }
        disconnect() { this.targets = []; }
    };
    vm.runInContext(SRC, realm, { filename: 'js/tuning_plot.js' });
    return { TP: realm.TuningPlot, created, observers, realm };
}

// Attaches a plot; ctx is the context of its cached canvas, where the plot itself is drawn, main the canvas's own.
// With `ms` the attach runs inside the realm under that time limit, so an endless loop fails the test instead of
// hanging the run.
function plot(spec, { width = 800, dpr = 2, ms } = {}) {
    const env = setup(dpr), canvas = fakeCanvas(width);
    if (ms) env.realm.__attach = [canvas, spec];
    const h = ms ? vm.runInContext('TuningPlot.attach(__attach[0], __attach[1])', env.realm, { timeout: ms }) : env.TP.attach(canvas, spec);
    const cache = env.created[env.created.length - 1];
    return { ...env, canvas, h, cache, ctx: cache.ctx, main: canvas.ctx };
}
const calls = (ctx, ...m) => ctx.log.filter((c) => m.includes(c.m));
const texts = (ctx) => calls(ctx, 'fillText').map((c) => c.args[0]);
const textAt = (ctx, text) => calls(ctx, 'fillText').find((c) => c.args[0] === text)?.args;
function clean(p, what) { assert.deepEqual([...p.ctx.bad, ...p.main.bad], [], (what || 'plot') + ': non-finite canvas arguments'); }

// tick labels: x ones are centred below the plot, y ones right-aligned on its left; [text, x, y] each
const xTicks = (ctx) => calls(ctx, 'fillText').filter((c) => c.align === 'center' && c.baseline === 'top').map((c) => c.args);
const yTicks = (ctx) => calls(ctx, 'fillText').filter((c) => c.align === 'right' && c.baseline === 'middle').map((c) => c.args);
const yPixel = (ctx, text) => yTicks(ctx).find((a) => a[0] === text)[2];
// readout texts after moving the mouse to (x, y) (canvas css px)
function hover(p, x, y) { p.main.log.length = 0; p.canvas.fire('mousemove', x, y); return texts(p.main); }
// x pixel of a value, interpolated between the x tick labels a and b (linear axes)
function xPixel(ctx, v, a, b) {
    const at = (t) => xTicks(ctx).find((c) => c[0] === String(t))[1], pa = at(a), pb = at(b);
    return pa + (pb - pa) * (v - a) / (b - a);
}

test('niceTicks: round steps of 1, 2 or 5 x 10^k inside the range, exact decimals', () => {
    const { TP } = setup();
    const T = (...a) => [...TP.niceTicks(...a)];
    assert.deepEqual(T(0, 1, 5), [0, 0.2, 0.4, 0.6, 0.8, 1]);
    assert.deepEqual(T(0.1, 0.7, 6), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]); // no 0.30000000000000004
    assert.deepEqual(T(-3.7, 12.2, 5), [0, 5, 10]);
    assert.deepEqual(T(-10, -2, 4), [-10, -8, -6, -4, -2]);
    assert.deepEqual(T(0, 600, 8), [0, 100, 200, 300, 400, 500, 600]);
    assert.deepEqual(T(975.5, 1514.5, 6), [1000, 1100, 1200, 1300, 1400, 1500]);
    assert.deepEqual(T(5, 5, 5), []);
    assert.deepEqual(T(0, NaN, 5), []);
    assert.deepEqual(T(0, Infinity, 5), []);
    // random ranges: inside, evenly spaced, a 1-2-5 step, and step / (span / count) within [0.63, 1.59] by
    // construction, so between 0.63 count - 1 and 1.59 count + 1 ticks
    const rand = rng(1);
    for (let n = 0; n < 3000; n++) {
        const span = 10 ** (rand() * 16 - 8), lo = (rand() - 0.5) * span * 200, count = 2 + Math.floor(rand() * 14);
        const t = T(lo, lo + span, count), what = `[${lo}, ${lo + span}] count ${count}: ${t}`;
        assert.ok(t.length >= Math.max(1, 0.63 * count - 1) && t.length <= 1.59 * count + 1, what);
        assert.ok(t[0] >= lo - 1e-9 * span && t[t.length - 1] <= lo + span + 1e-9 * span, what);
        if (t.length < 2) continue;
        const step = t[1] - t[0], mant = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
        for (let k = 2; k < t.length; k++) assert.ok(Math.abs(t[k] - t[k - 1] - step) <= 1e-6 * step, what);
        assert.ok([1, 2, 5, 10].some((m) => Math.abs(mant - m) < 1e-6), what + ' mantissa ' + mant);
    }
});

test('logTicks: decades with 2 and 5 minor ticks, labels thinned to fit, linear inside one decade', () => {
    const { TP } = setup();
    const L = (...a) => [...TP.logTicks(...a)], labels = (t) => t.filter((k) => k.label).map((k) => k.v);
    let t = L(0.5, 60, 15);
    assert.deepEqual(t.map((k) => k.v), [0.5, 1, 2, 5, 10, 20, 50]);
    assert.deepEqual(t.filter((k) => k.major).map((k) => k.v), [1, 10]);
    assert.deepEqual(labels(t), [0.5, 1, 2, 5, 10, 20, 50]); // room for all: 2 and 5 labelled too
    assert.deepEqual(labels(L(0.5, 60, 4)), [1, 10]); // no room: decades only, minor ticks stay as grid
    assert.equal(L(0.5, 60, 4).length, 7);
    t = L(1e-4, 1e4, 4);
    assert.equal(t.filter((k) => k.major).length, 9);
    assert.deepEqual(labels(t), [1e-3, 1, 1e3]); // every third decade
    assert.deepEqual(labels(L(1, 1000, 12)), [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]); // exact end decades kept
    t = L(3, 8, 10); // only 5 is a log tick here: falls back to linear ticks
    assert.deepEqual(labels(t), [3, 4, 5, 6, 7, 8]);
    t = L(0.9, 1.1, 8);
    assert.ok(labels(t).length >= 2 && t.every((k) => k.v >= 0.9 && k.v <= 1.1), JSON.stringify(t));
    assert.deepEqual(labels(L(0.039, 2.5, 8)), [0.05, 0.1, 0.2, 0.5, 1, 2]); // six ticks in range fit eight labels
    assert.deepEqual(labels(L(0.039, 2.5, 5)), [0.1, 1]);
});

test('ranges a few float ulps wide, or past the double range on log axes, end at once and keep their labels', () => {
    const { realm } = setup(); // calls inside the realm under a time limit, like plot(spec, { ms })
    const within = (f, ...args) => { realm.__args = args; return [...vm.runInContext('TuningPlot.' + f + '.apply(null, __args)', realm, { timeout: 250 })]; };
    // on [0.1, 0.1 + 1 ulp] the tick counter starts at 5e16 > 2^53, where k++ no longer changes it
    assert.deepEqual(within('niceTicks', 0.1, 0.10000000000000002, 6), []);
    assert.deepEqual(within('niceTicks', 1500, 1500.0000000000002, 6), []);
    assert.deepEqual(within('niceTicks', 0, 1, 5000), []); // over 1000 ticks
    assert.deepEqual(within('logTicks', 0, 1, 8), []); // log10(0) = -Infinity: the decade loop would never end
    assert.deepEqual(within('logTicks', 1, Infinity, 5), []);
    // through attach: the float noise of a constant is widened like a single value; log ranges are kept inside
    // 1e-300..1e300 (10^-336 is 0, 10^315 is Infinity). Before the fix every one of these attach calls never returned.
    const y2Ticks = (ctx) => calls(ctx, 'fillText').filter((c) => c.align === 'left' && c.baseline === 'middle').map((c) => c.args); // no legend
    const cases = [
        ['y [0.1, (0.1 + 0.1 + 0.1) / 3]', { series: [{ x: [0, 1], y: [0.1, (0.1 + 0.1 + 0.1) / 3] }] }, yTicks],
        ['y2 [33.3, 33.300000000000004] beside a y from 0', { y: { min: 0 }, y2: {},
            series: [{ x: [0, 1], y: [1, 2] }, { x: [0, 1], y: [33.3, 33.300000000000004], axis: 'y2' }] }, y2Ticks],
        ['x [1500, 1500 + 1 ulp]', { series: [{ x: [1500, 1500.0000000000002], y: [1, 2] }] }, xTicks],
        ['log y [1, 1 + 1 ulp]', { y: { log: true }, series: [{ x: [0, 1], y: [1, 1.0000000000000002] }] }, yTicks],
        ['log y [1 - 1 ulp, 1]', { y: { log: true }, series: [{ x: [0, 1], y: [0.9999999999999999, 1] }] }, yTicks],
        ['log y [1e-320, 1]: the padding underflows', { y: { log: true }, series: [{ x: [0, 1], y: [1e-320, 1] }] }, yTicks],
        ['log y [1, 1e300]: the padding overflows', { y: { log: true }, series: [{ x: [0, 1], y: [1, 1e300] }] }, yTicks],
        ['y min and max 1 ulp apart', { y: { min: 0.1, max: 0.10000000000000002 }, series: [{ x: [0, 1], y: [0.1, 0.1] }] }, null],
    ];
    for (const [what, spec, ticks] of cases) {
        const p = plot(spec, { ms: 250 });
        clean(p, what);
        if (ticks) assert.ok(ticks(p.ctx).length >= 2, what + ': ' + texts(p.ctx).join(' '));
    }
    assert.deepEqual(yTicks(plot(cases[3][1]).ctx).map((a) => a[0]), ['0.5', '1', '2'], 'log near 1: half a decade each side');
});

test('formatNumber: significant digits, no float noise, exponent outside 1e-3..1e5', () => {
    const { TP } = setup();
    const cases = [[0.30000000000000004, 6, '0.3'], [123.456, 4, '123.5'], [1e5, 6, '1e5'], [1.5e-4, 4, '1.5e-4'],
        [-0, 4, '0'], [0, 6, '0'], [-2500, 4, '-2500'], [123456, 4, '1.235e5'], [0.001, 4, '0.001'], [NaN, 4, '-'],
        [Infinity, 4, '-'], [null, 4, '-']];
    for (const [v, d, want] of cases) assert.equal(TP.formatNumber(v, d), want, `${v} ${d}`);
});

test('nearest: binary search on ascending x, in pixels when a mapping is given', () => {
    const { TP } = setup();
    const x = new Float32Array([0, 1, 2, 3, 10]);
    const cases = [[1.4, 1], [1.6, 2], [1.5, 1], [-5, 0], [99, 4], [6.4, 3], [6.6, 4], [2, 2], [NaN, -1]];
    for (const [v, want] of cases) assert.equal(TP.nearest(x, v), want, String(v));
    assert.equal(TP.nearest([], 1), -1);
    assert.equal(TP.nearest(x, 2.9, 3), 2); // only the first 3 entries count
    assert.equal(TP.nearest([1, 2], 1.45), 0);
    assert.equal(TP.nearest([1, 2], 1.45, 2, Math.log10), 1); // on a log axis 1.45 is nearer 2
    // against brute force on random ascending arrays with repeats
    const rand = rng(3);
    for (let n = 0; n < 500; n++) {
        const len = 1 + Math.floor(rand() * 40), a = [];
        for (let i = 0; i < len; i++) a.push(i ? a[i - 1] + Math.floor(rand() * 3) : 0);
        const v = (rand() * 1.2 - 0.1) * a[len - 1], i = TP.nearest(a, v);
        const best = Math.min(...a.map((u) => Math.abs(u - v)));
        assert.equal(Math.abs(a[i] - v), best, `${a} ${v} -> ${i}`);
    }
});

test('decimate: every pixel column keeps its first, last, lowest and highest point; invalid points make gaps', () => {
    const { TP } = setup();
    const n = 100000, x = new Float64Array(n), y = new Float64Array(n), rand = rng(7);
    for (let i = 0; i < n; i++) { x[i] = i * 1e-3; y[i] = 50 * Math.sin(i / 700) + 20 * (rand() - 0.5); }
    y[12345] = -1000;
    y[54321] = 1000;
    for (let i = 70000; i < 70500; i++) y[i] = NaN;
    const cols = 800, col = (v) => v / x[n - 1] * cols, ok = (i) => Number.isFinite(y[i]);
    const idx = [...TP.decimate(x, y, 0, n - 1, col, ok, true)], pts = idx.filter((i) => i >= 0);
    assert.ok(idx.length <= 4 * (cols + 2) + 1, 'length ' + idx.length);
    assert.ok(pts.includes(12345) && pts.includes(54321), 'global extremes kept');
    assert.ok(pts.every((i, k) => k === 0 || i > pts[k - 1]), 'in order');
    assert.ok(pts.every(ok), 'no invalid point');
    assert.equal(idx.filter((i) => i === -1).length, 1);
    assert.deepEqual(idx.slice(idx.indexOf(-1) - 1, idx.indexOf(-1) + 2), [69999, -1, 70500]);
    // brute force: group by (run between gaps, column); first occurrences of min and max as the decimator keeps
    const groups = new Map(), kept = new Set(pts);
    let run = 0;
    for (let i = 0; i < n; i++) {
        if (!ok(i)) { if (ok(i - 1)) run++; continue; }
        const key = run + ':' + Math.floor(col(x[i])), g = groups.get(key);
        if (!g) groups.set(key, { first: i, last: i, lo: i, hi: i });
        else { g.last = i; if (y[i] < y[g.lo]) g.lo = i; if (y[i] > y[g.hi]) g.hi = i; }
    }
    for (const [key, g] of groups) for (const i of [g.first, g.last, g.lo, g.hi]) assert.ok(kept.has(i), `column ${key} lost ${i}`);
    assert.equal(kept.size, new Set([...groups.values()].flatMap((g) => [g.first, g.last, g.lo, g.hi])).size, 'nothing else kept');
    // sparse: every valid point, one -1 per gap, none leading
    const ys = [NaN, 1, 2, NaN, NaN, 5, null, 7], sparse = [...TP.decimate([0, 1, 2, 3, 4, 5, 6, 7], ys, 0, 7, col, (i) => Number.isFinite(ys[i]), false)];
    assert.deepEqual(sparse, [1, 2, -1, 5, -1, 7]);
});

test('attach: hi-DPI backing store, css size from the spec, one blit of the cached plot', () => {
    const p = plot({ series: [{ x: [0, 1, 2], y: [0, 1, 0] }], height: 180 }, { width: 640, dpr: 2 });
    assert.equal(p.canvas.style.height, '180px');
    assert.equal(p.canvas.style.width, '100%');
    assert.deepEqual([p.canvas.width, p.canvas.height, p.cache.width, p.cache.height], [1280, 360, 1280, 360]);
    assert.deepEqual(calls(p.ctx, 'setTransform')[0].args, [2, 0, 0, 2, 0, 0]);
    assert.equal(calls(p.main, 'drawImage').length, 1);
    clean(p);
    const q = plot({ series: [{ x: [0, 1], y: [0, 1] }] }, { width: 500, dpr: 1.5 });
    assert.equal(q.canvas.style.height, undefined, 'no height in the spec: the canvas keeps its stylesheet height');
    assert.deepEqual([q.canvas.width, q.canvas.height], [750, 330]); // 220 css px, the stylesheet's
    p.h.update({ series: [{ x: [0, 1], y: [0, 1] }] }); // a spec without height after one with: back to the stylesheet's
    assert.equal(p.canvas.style.height, '');
});

test('attach: the backing store takes the device pixel box the resize observer reports; the scale stays the ratio', () => {
    // a canvas 547.45 css px wide: clientWidth rounds to 548 (1096 device px), the compositor paints 1095
    const spec = { series: [{ x: [0, 1, 2], y: [0, 1, 0] }] }, box = (w, h) => [{ devicePixelContentBoxSize: [{ inlineSize: w, blockSize: h }] }];
    const p = plot(spec, { width: 548, dpr: 2 }), size = () => [p.canvas.width, p.canvas.height, p.cache.width, p.cache.height];
    assert.deepEqual(size(), [1096, 440, 1096, 440], 'before the first report: css size x ratio');
    p.ctx.log.length = 0;
    p.observers[0].cb(box(1095, 440));
    assert.deepEqual(size(), [1095, 440, 1095, 440]);
    assert.deepEqual(calls(p.ctx, 'setTransform')[0].args, [2, 0, 0, 2, 0, 0], 'scale exactly the ratio');
    assert.deepEqual(calls(p.ctx, 'fillRect')[0].args, [0, 0, 547.5, 220], 'laid out over 1095 / 2 css px');
    const blits = calls(p.main, 'drawImage').length;
    p.observers[0].cb(box(1095, 440)); // the same box again: no redraw
    assert.equal(calls(p.main, 'drawImage').length, blits);
    p.h.update({ ...spec, height: 300 }); // the last box no longer fits the css size: not used until a new report
    assert.deepEqual(size(), [1096, 600, 1096, 600]);
    p.observers[0].cb(box(1095, 600));
    assert.deepEqual(size(), [1095, 600, 1095, 600]);
    p.observers[0].cb([{}]); // an engine without devicePixelContentBoxSize
    assert.deepEqual(size(), [1096, 600, 1096, 600]);
    clean(p);
});

test('drawing: NaN and null break the line, step draws stairs, fills and bands close per run', () => {
    // fixed axes, so a plot without the series has the same grid and the differences are the series' own calls
    const axes = { x: { min: 0, max: 6 }, y: { min: 0, max: 10 }, legend: false };
    const base = plot({ ...axes, series: [] });
    const diff = (p, m) => calls(p.ctx, m).length - calls(base.ctx, m).length;
    const x = [0, 1, 2, 3, 4, 5, 6], y = [1, 2, NaN, 4, 5, null, 7];
    const line = plot({ ...axes, series: [{ x, y }] });
    assert.deepEqual([diff(line, 'moveTo'), diff(line, 'lineTo')], [3, 2]); // runs [0, 1], [3, 4], [6]
    const step = plot({ ...axes, series: [{ x, y, step: true }] });
    // each step across then up, and the last value of a run held to the next x: runs [0, 1] and [3, 4] reach x = 2
    // and x = 5 (3 lineTo each); the last point has no next x
    assert.deepEqual([diff(step, 'moveTo'), diff(step, 'lineTo')], [3, 6]);
    const fill = plot({ ...axes, series: [{ x, y, fill: true, width: 0 }] });
    assert.deepEqual([diff(fill, 'moveTo'), diff(fill, 'lineTo'), diff(fill, 'closePath')], [3, 3 + 3 + 2, 3]);
    const band = plot({ ...axes, series: [{ x, y: x, lo: [0, 1, 2, 3, NaN, 5, 6], hi: [2, 3, 4, 5, 6, 7], width: 0 }] });
    // band valid at 0-3 and 5 (lo NaN at 4, hi shorter than x): polygons over 4 and 1 points
    assert.deepEqual([diff(band, 'moveTo'), diff(band, 'lineTo'), diff(band, 'closePath')], [2, 7 + 1, 2]);
    for (const p of [base, line, step, fill, band]) clean(p);
});

test('drawing: log axes leave out values <= 0 everywhere', () => {
    const axes = { x: { log: true, min: 0.5, max: 8 }, y: { log: true, min: 0.5, max: 500 }, legend: false };
    const extras = { vlines: [{ x: 0 }, { x: -2 }, { x: 3, label: 'notch' }], hlines: [{ y: -1 }, { y: 0 }, { y: 50, label: 'limit' }],
        bands: [{ x0: -5, x1: 2, label: 'unusable' }], markers: [{ x: 0, y: 1 }, { x: 2, y: -3 }, { x: 4, y: 100 }] };
    const base = plot({ ...axes, ...extras, series: [] });
    const p = plot({ ...axes, ...extras, series: [{ x: [-1, 0, 1, 2, 4], y: [5, 5, 0, 10, 100], lo: [1, 1, -1, 5, 50],
        hi: [9, 9, 1, 20, 200], fill: true, points: true }] });
    clean(base, 'base');
    clean(p, 'log');
    const diff = (m) => calls(p.ctx, m).length - calls(base.ctx, m).length;
    // valid points (2, 10) and (4, 100): line 1 moveTo + 1 lineTo, fill 1 + 3, dots 2 moveTo + 2 arcs, band (lo at
    // x = 1 is negative) over the same two points: 1 moveTo + 3 lineTo
    assert.deepEqual([diff('moveTo'), diff('lineTo'), diff('arc')], [1 + 1 + 2 + 1, 1 + 3 + 3, 2]);
    // autoscaled log axes with only non-positive data: a default decade, no error
    const none = plot({ x: { log: true }, y: { log: true }, series: [{ name: 'zero', x: [0, -1], y: [0, -5] }] });
    clean(none, 'non-positive only');
    assert.ok(texts(none.ctx).includes('1') && texts(none.ctx).includes('10'), texts(none.ctx).join(' '));
    // autoscaled: x from the positive x, y from the positive y inside that x range
    const auto = plot({ x: { log: true }, y: { log: true }, legend: false, series: [{ x: [0, 0.5, 1, 2, 40, 60], y: [1e6, 1e-3, 2, 30, 0, 500] }] });
    clean(auto, 'autoscaled');
    const xs = xTicks(auto.ctx).map((a) => a[0]), ys = yTicks(auto.ctx).map((a) => a[0]);
    assert.deepEqual(xs, ['0.5', '1', '2', '5', '10', '20', '50']); // 0.5..60
    assert.deepEqual(ys, ['0.001', '0.01', '0.1', '1', '10', '100']); // 1e-3..500: the 1e6 at x = 0 is left out
});

test('drawing: empty, missing and degenerate specs draw an empty frame without throwing', () => {
    const specs = [undefined, {}, { series: [] }, { series: [null] }, { series: [{ x: [], y: [] }] }, { series: [{ x: [1, 2, 3] }] },
        { series: [{ x: [1], y: [5] }] }, { series: [{ x: [0, 1], y: [3, 3] }], y: { log: true } },
        { x: { min: 5, max: 1 }, series: [{ x: [0, 1], y: [0, 1] }] }, { y: { min: 0 }, series: [{ x: [0, 1], y: [-5, -4] }] },
        { y2: {}, series: [{ x: [0, 1], y: [0, 1], axis: 'y2' }] }, { series: [{ x: [0, 1, 2], y: [NaN, NaN, NaN], lo: [], hi: [] }] },
        { series: [{ x: [NaN, NaN], y: [1, 2] }] }, { bands: [{ x0: NaN, x1: 2 }], vlines: [{ x: NaN }], hlines: [{ y: NaN }], markers: [{ x: NaN }] },
        { title: 'Tiny', series: [{ x: [0, 1], y: [0, 1] }], height: 30 }];
    for (const spec of specs) {
        const p = plot(spec);
        clean(p, JSON.stringify(spec));
        assert.equal(calls(p.main, 'drawImage').length, 1, JSON.stringify(spec));
    }
    const tiny = plot({ series: [{ x: [0, 1], y: [0, 1] }] }, { width: 30 }); // no room for a plot: background only
    assert.equal(calls(tiny.ctx, 'strokeRect').length, 0);
    assert.equal(calls(tiny.ctx, 'fillRect').length, 1);
});

test('drawing: every feature together, with NaN sprinkled in, two y axes and a legend', () => {
    const n = 500, t = Float32Array.from({ length: n }, (_, i) => i * 0.1), rand = rng(11);
    const sp = t.map((v) => 100 * Math.sin(v)), err = t.map((v, i) => (i % 97 < 5 ? NaN : 20 + 10 * rand()));
    const p = plot({
        title: 'Roll tracking error', x: { label: 'Time', unit: 's' }, y: { label: 'Error', unit: 'deg/s' }, y2: { label: 'Setpoint', unit: 'deg/s' },
        series: [{ name: 'err', x: t, y: err, lo: err.map((v) => v - 3), hi: err.map((v) => v + 3), fill: true },
            { name: 'sp', x: t, y: sp, axis: 'y2', dash: [4, 2], color: '#80b1d3' }, { name: 'pts', x: t, y: err, points: true, width: 0, step: true }],
        bands: [{ x0: 10, x1: 15, label: 'unusable' }, { x0: 40, x1: 1e9 }], vlines: [{ x: 20, label: 'C12', color: '#c9483f' }],
        hlines: [{ y: 10, label: '10 deg/s' }, { y: 0, axis: 'y2' }], markers: [{ x: 25, label: 'flag' }, { x: 30, y: 25, shape: 'tri' }],
        format: { x: (v) => v.toFixed(0) + 's' },
    });
    clean(p);
    const tx = texts(p.ctx);
    for (const want of ['Roll tracking error', 'Time (s)', 'Error (deg/s)', 'Setpoint (deg/s)', 'err', 'sp', 'pts', 'unusable', 'C12', '10 deg/s', '20s']) {
        assert.ok(tx.includes(want), want + ' missing in ' + tx.join(' | '));
    }
    assert.ok(tx.includes('-100') && tx.includes('100'), 'y2 tick labels from the setpoint range');
});

test('100k-point series: drawn in under 50 ms, decimated to the pixel columns, extremes on screen', () => {
    const n = 100000, x = new Float64Array(n), y = new Float64Array(n), rand = rng(5);
    for (let i = 0; i < n; i++) { x[i] = i * 1e-3; y[i] = 100 * Math.sin(i / 500) + 50 * (rand() - 0.5); }
    y[12345] = -1000;
    y[54321] = 1000;
    const env = setup(2), canvas = fakeCanvas(800);
    const t0 = performance.now();
    env.TP.attach(canvas, { series: [{ name: 'gyro', x, y }], legend: false });
    const ms = performance.now() - t0, ctx = env.created[0].ctx;
    assert.ok(ms < 50, `draw took ${ms.toFixed(1)} ms`);
    const path = calls(ctx, 'moveTo', 'lineTo').filter((c) => c.stroke === RED).map((c) => c.args[1]);
    assert.ok(path.length > 800 && path.length <= 4 * 800, 'path points ' + path.length);
    // y range [-1000, 1000] padded 5 %: plot box 10..196 px (220 high, no title or x label; at 100 % text the margins are
    // 1.2 x those of the 10 px font, SPEC3 C: top round(8 x 1.2), bottom round(20 x 1.2))
    const px = (v) => 196 + (v + 1100) * (10 - 196) / 2200;
    assert.ok(Math.abs(Math.min(...path) - px(1000)) < 1e-9 && Math.abs(Math.max(...path) - px(-1000)) < 1e-9, 'spikes drawn');
    const t1 = performance.now();
    for (let k = 0; k < 20; k++) canvas.fire('mousemove', 100 + 30 * k, 100);
    const hoverMs = (performance.now() - t1) / 20;
    assert.ok(hoverMs < 5, `hover took ${hoverMs.toFixed(2)} ms`);
    assert.deepEqual(ctx.bad, []);
});

test('hover: crosshair and readout of each visible series at the nearest x, nothing after leaving', () => {
    const x = Array.from({ length: 50 }, (_, i) => i), hovers = [];
    const p = plot({ x: { unit: 's' }, y: { unit: 'deg/s' }, series: [{ name: 'a', x, y: x.map((v) => 1000 + 10 * v), lo: x.map((v) => 990 + 10 * v), hi: x.map((v) => 1010 + 10 * v) },
        { name: 'b', x, y: x.map((v) => (v === 25 ? NaN : 1200)) }], markers: [{ x: 10, y: 1100, label: 'C12 flag at 10 s' }],
        onHover: (xv, info) => hovers.push([xv, info && { ...info }]) });
    const px = xPixel(p.ctx, 25, 20, 40);
    const tx = hover(p, px + 2, 100); // 2 px right of x = 25 snaps to it
    assert.ok(tx.includes('25 s') && tx.includes('a: 1250 deg/s [1240, 1260]'), tx.join(' | '));
    assert.ok(!tx.some((s) => s.startsWith('b:')), 'b has a gap at x = 25: no value');
    assert.equal(calls(p.main, 'arc').length, 1, 'one dot, on a');
    const cross = calls(p.main, 'moveTo')[0].args[0];
    assert.equal(cross, Math.round(px) + 0.5, 'crosshair snapped to x = 25');
    assert.ok(Math.abs(hovers.at(-1)[0] - (25 + 2 * 25 / (px - xPixel(p.ctx, 0, 20, 40)))) < 1e-6, 'onHover gets the x under the mouse');
    assert.deepEqual(hovers.at(-1)[1], { series: 0, index: 25, name: 'a', marker: -1 });
    // over the marker: its label joins the readout
    const mx = xPixel(p.ctx, 10, 20, 40), my = yPixel(p.ctx, '1100');
    assert.ok(hover(p, mx, my).includes('C12 flag at 10 s'));
    assert.equal(hovers.at(-1)[1].marker, 0);
    p.main.log.length = 0;
    p.canvas.fire('mouseleave', 0, 0);
    assert.deepEqual(texts(p.main), [], 'no readout after leaving');
    assert.equal(calls(p.main, 'drawImage').length, 1);
    assert.deepEqual(hovers.at(-1), [null, null]);
    assert.deepEqual(hover(p, 2, 2), [], 'in the margin: no readout');
    clean(p);
});

test('click: onClick(x, info) inside the plot only; a legend entry toggles its series and stays across update', () => {
    const x = Array.from({ length: 50 }, (_, i) => i), clicks = [];
    const spec = { series: [{ name: 'a', x, y: x.map((v) => 1000 + 10 * v) }, { name: 'b', x, y: x.map(() => 1300) }],
        vlines: [{ x: 40, label: 'P2' }], onClick: (xv, info) => clicks.push([xv, { ...info }]) };
    const p = plot(spec);
    const px = xPixel(p.ctx, 25, 20, 40), py = yPixel(p.ctx, '1300');
    p.canvas.fire('click', px, py);
    assert.equal(clicks.length, 1);
    assert.ok(Math.abs(clicks[0][0] - 25) < 1e-9, 'x ' + clicks[0][0]);
    assert.deepEqual(clicks[0][1], { series: 1, index: 25, name: 'b', marker: -1 }); // b passes through the click
    p.canvas.fire('click', 2, 2);
    assert.equal(clicks.length, 1, 'no callback for a click in the margin');
    const strokes = (name, color) => calls(p.ctx, 'lineTo').filter((c) => c.stroke === color && c.alpha === 1).length;
    assert.equal(strokes('a', RED), 49 + 1); // 49 segments and the legend swatch
    const [, lx, ly] = textAt(p.ctx, 'a');
    p.ctx.log.length = 0;
    p.canvas.fire('click', lx - 10, ly);
    assert.equal(clicks.length, 1, 'a legend click is not a plot click');
    assert.equal(strokes('a', RED), 0, 'a hidden (its swatch dimmed)');
    assert.equal(strokes('b', CYAN), 49 + 1, 'b still drawn');
    assert.deepEqual(yTicks(p.ctx).map((a) => a[0]), ['1200', '1250', '1300', '1350', '1400'], 'y fits b alone');
    // with every series hidden the x axis still fits them, so the reference lines on it stay
    const xs = xTicks(p.ctx).map((a) => a[0]), [, bx, by] = textAt(p.ctx, 'b');
    p.ctx.log.length = 0;
    p.canvas.fire('click', bx - 10, by);
    assert.equal(strokes('b', CYAN), 0, 'b hidden too');
    assert.deepEqual(xTicks(p.ctx).map((a) => a[0]), xs, 'x axis kept');
    assert.ok(texts(p.ctx).includes('P2'), 'vline at x = 40 still drawn');
    p.canvas.fire('click', bx - 10, by);
    p.ctx.log.length = 0;
    p.h.update(spec);
    assert.equal(strokes('a', RED), 0, 'still hidden after update');
    p.canvas.fire('click', lx - 10, ly);
    assert.equal(strokes('a', RED), 49 + 1, 'shown again');
    clean(p);
});

test('step series: bins hold to the next edge, hover reads the bin under the mouse', () => {
    const edges = [0, 25, 50, 100, 150, 200], mae = [3, 5, 8, 12, 17]; // x one longer than y: bin edges
    const p = plot({ legend: false, x: { min: 0, max: 250 }, y: { min: 0, max: 20 }, series: [{ name: 'raw', x: edges, y: mae, step: true }] });
    const path = calls(p.ctx, 'moveTo', 'lineTo').filter((c) => c.stroke === RED).map((c) => c.args[0]);
    const px200 = xPixel(p.ctx, 200, 0, 100);
    assert.ok(Math.abs(Math.max(...path) - px200) < 1e-9, 'last bin drawn to its edge at 200');
    for (const [xv, want] of [[140, 'raw: 12'], [101, 'raw: 12'], [99, 'raw: 8'], [199, 'raw: 17'], [10, 'raw: 3']]) {
        const tx = hover(p, xPixel(p.ctx, xv, 0, 100), 100);
        assert.ok(tx.includes(want) && tx.filter((t) => t.startsWith('raw')).length === 1, `${xv}: ${tx.join(' | ')}`);
    }
    const past = hover(p, xPixel(p.ctx, 230, 0, 100), 100); // past the last edge: no value
    assert.ok(!past.some((t) => t.startsWith('raw')), past.join(' | '));
    clean(p);

    // auto x range: up to the last edge, so the last bin is on screen and readable
    const auto = plot({ legend: false, y: { min: 0, max: 20 }, series: [{ name: 'raw', x: edges, y: mae, step: true }] });
    assert.equal(xTicks(auto.ctx).at(-1)[0], '200', xTicks(auto.ctx).map((a) => a[0]).join(' '));
    const right = xPixel(auto.ctx, 200, 0, 100);
    assert.ok(hover(auto, right - 1, 100).includes('raw: 17'), 'last bin under the right edge');
    clean(auto, 'auto x');

    // a set x min inside a bin: that bin reaches into the plot, so the y range has room for its value 5
    const cut = plot({ legend: false, x: { min: 30, max: 200 }, series: [{ name: 'raw', x: edges, y: mae, step: true }] });
    const [left, , , boxH] = calls(cut.ctx, 'strokeRect')[0].args, bottom = calls(cut.ctx, 'strokeRect')[0].args[1] + boxH;
    const inside = calls(cut.ctx, 'moveTo', 'lineTo').filter((c) => c.stroke === RED && c.args[0] >= left).map((c) => c.args[1]);
    assert.ok(inside.length && inside.every((y) => y <= bottom), 'every vertex inside the box ' + inside.join(' ') + ' vs ' + bottom);
    assert.ok(hover(cut, xPixel(cut.ctx, 40, 40, 100), 100).includes('raw: 5'));
    clean(cut, 'x min inside a bin');

    // a step band holds each bin's lo..hi up to the next edge, like its line: the upper edge is a staircase
    const band = plot({ legend: false, x: { min: 0, max: 250 }, y: { min: 0, max: 20 },
        series: [{ name: 'raw', x: edges, y: mae, lo: mae.map((v) => v - 1), hi: mae.map((v) => v + 1), step: true, width: 0 }] });
    const X = (v) => xPixel(band.ctx, v, 0, 100), y0 = yPixel(band.ctx, '0'), y20 = yPixel(band.ctx, '20'), Y = (v) => y0 + (y20 - y0) * v / 20;
    const poly = calls(band.ctx, 'moveTo', 'lineTo').filter((c) => c.fill === RED && c.alpha === 0.2).map((c) => c.args);
    const upper = mae.flatMap((v, i) => [[X(edges[i]), Y(v + 1)], [X(edges[i + 1]), Y(v + 1)]]);
    assert.equal(poly.length, 2 * upper.length, 'upper edge forwards, lower edge back');
    upper.forEach(([x, y], k) => assert.ok(Math.abs(poly[k][0] - x) < 1e-9 && Math.abs(poly[k][1] - y) < 1e-9, `vertex ${k}: ${poly[k]} vs ${x},${y}`));
    const tx = hover(band, X(190), 100);
    assert.ok(tx.includes('raw: 17 [16, 18]'), tx.join(' | '));
    clean(band, 'step band');
});

test('labels: top labels keep clear of the legend, hline labels flip below at the top edge, bands show on hover', () => {
    const p = plot({ x: { min: 0, max: 100 }, y: { min: 0, max: 40 }, series: [{ name: 'amplitude', x: [0, 100], y: [5, 6] }],
        vlines: [{ x: 97, label: 'notch' }], hlines: [{ y: 40, label: '40' }, { y: 10, label: '10' }], bands: [{ x0: 20, x1: 30, label: 'rescue' }] });
    const T = 8, lb = T + 10 + 13; // plot top, legend box bottom (one entry)
    const at = (t) => calls(p.ctx, 'fillText').find((c) => c.args[0] === t);
    assert.ok(at('notch').args[2] >= lb, 'notch label below the legend, y ' + at('notch').args[2]);
    const y40 = yPixel(p.ctx, '40'), y10 = yPixel(p.ctx, '10');
    assert.ok(at('40').args[2] > y40 && at('40').align === 'left', '40: below its line (top edge) and on the left (legend)');
    assert.ok(at('10').args[2] < y10 && at('10').align === 'right', '10: above its line, on the right');
    const tx = hover(p, xPixel(p.ctx, 25, 20, 40), 150);
    assert.ok(tx.includes('rescue'), tx.join(' | '));
    const empty = plot({ series: [] });
    assert.ok(texts(empty.ctx).includes('no data'));
    clean(p);
});

test('labels: a two-entry legend leaves a row below it; every vline label shows in the readout over its line', () => {
    // five labels close together fill the rows in spec order; the notch under the legend takes the row below it
    const vlines = [1, 2, 3, 4, 5].map((x) => ({ x, label: 'rotor ' + x + 'x', color: '#bebada' }))
        .concat([{ x: 97, label: 'notch' }, { x: 100.3, label: 'outside' }]);
    const p = plot({ x: { min: 0, max: 100 }, y: { min: 0, max: 40 }, vlines,
        series: [{ name: 'gyroRAW', x: [0, 100], y: [5, 6] }, { name: 'gyroADC', x: [0, 100], y: [3, 4] }] });
    const T = 8, lb = T + 10 + 2 * 13; // plot top, legend box bottom (two entries)
    const at = (t) => calls(p.ctx, 'fillText').find((c) => c.args[0] === t);
    assert.deepEqual(vlines.filter((v) => at(v.label)).map((v) => v.label), ['rotor 1x', 'rotor 2x', 'rotor 3x', 'rotor 4x', 'notch']);
    assert.ok(at('notch').args[2] >= lb && at('rotor 4x').args[2] >= lb, 'the fourth row is below the legend');
    for (const v of vlines.slice(0, 6)) { // drawn or not (rotor 5x found no row), the readout names the line
        const tx = hover(p, xPixel(p.ctx, v.x, 20, 40), 150);
        assert.deepEqual(tx.filter((t) => /rotor|notch|outside/.test(t)), [v.label], v.label + ': ' + tx.join(' | '));
    }
    const edge = hover(p, xPixel(p.ctx, 100, 20, 40), 150); // 2.3 px from the line at 100.3, which is off the axis
    assert.ok(!edge.includes('outside'), edge.join(' | '));
    clean(p);
});


// the box of a label from its fillText call (6 px a character in the fake context, 13 px a row): [x0, y0, x1, y1]
function labelBox(ctx, text) {
    const c = calls(ctx, 'fillText').find((q) => q.args[0] === text);
    if (!c) return null;
    const w = String(text).length * 6, x0 = c.align === 'right' ? c.args[1] - w : c.args[1];
    return [x0, c.args[2], x0 + w, c.args[2] + 12];
}
const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

test('labels (V10): the line labels keep clear of the band labels, the vline labels and the legend; each label is drawn after the curves on a dark box', () => {
    // A14.png: the T8 spans "Tail output limit" along the top, and the limit lines at 1250 and -1250 permille near the edges
    const x = Array.from({ length: 321 }, (_, i) => i), y = x.map((t) => 1200 * Math.sin(t / 3));
    const a = plot({ title: 'Measurement: T8, yaw, PID profile 1, log 1', x: { min: 0, max: 320 }, y: { min: -1300, max: 1300 },
        series: [{ name: 'tail output (mixer[2])', x, y }],
        bands: [{ x0: 100, x1: 102, label: 'Tail output limit' }, { x0: 230, x1: 232, label: 'Tail output limit' }],
        hlines: [{ y: 1250, label: 'Tail output limit 1250 ‰' }, { y: -1250, label: 'Tail output limit -1250 ‰' }] });
    // D07.png: "Hover tail trim" along the top and the limit at -187.5 permille at the top edge, with a legend of two entries
    const b = plot({ x: { min: 175, max: 186 }, y: { min: -400, max: -187.5 },
        series: [{ name: 'axisI[2]', x: [175, 186], y: [-210, -290] }, { name: 'mixer[2]', x: [175, 186], y: [-280, -330] }],
        bands: [{ x0: 175, x1: 186, label: 'Hover tail trim' }],
        hlines: [{ y: -187.5, label: 'Limit -187.5 ‰ (15 % of the tail output range)' }, { y: -265, label: 'Hover median -265 ‰' }] });
    // D06.png: the yaw notch label at 76.7 Hz and the peak line at 156 Hz that crossed it
    const c = plot({ x: { min: 0, max: 500 }, y: { min: 0.01, max: 20, log: true }, series: [{ name: 'gyroRAW[2]', x: [0, 500], y: [1, 1] }],
        vlines: [{ x: 156, label: 'Peak 156 Hz' }, { x: 153, label: 'Roll notch filter 153 Hz' }, { x: 76.7, label: 'Yaw notch filter 76.7 Hz' }] });
    for (const [p, labels] of [[a, ['Tail output limit', 'Tail output limit 1250 ‰', 'Tail output limit -1250 ‰']],
        [b, ['Hover tail trim', 'Limit -187.5 ‰ (15 % of the tail output range)', 'Hover median -265 ‰']],
        [c, ['Peak 156 Hz', 'Roll notch filter 153 Hz', 'Yaw notch filter 76.7 Hz']]]) {
        const boxes = labels.map((t) => [t, labelBox(p.ctx, t)]).filter((q) => q[1]);
        assert.ok(boxes.length >= 2, 'drawn: ' + boxes.map((q) => q[0]).join(', '));
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
            assert.ok(!overlap(boxes[i][1], boxes[j][1]), `"${boxes[i][0]}" ${boxes[i][1]} over "${boxes[j][0]}" ${boxes[j][1]}`);
        }
        // after the curves: the last stroke of a series comes before the first label; a dark box under each label
        const log = p.ctx.log, first = log.findIndex((q) => q.m === 'fillText' && labels.includes(q.args[0]));
        const clip = log.findIndex((q) => q.m === 'clip'), end = log.findIndex((q, i) => i > clip && q.m === 'restore'); // inside the plot box (the legend comes later)
        const lastCurve = log.map((q, i) => (q.m === 'stroke' && q.stroke === RED && i > clip && i < end ? i : -1)).filter((i) => i >= 0).pop();
        assert.ok(lastCurve > clip && first > lastCurve && first < end, `labels after the curves, in the plot box: ${clip} ${lastCurve} ${first} ${end}`);
        for (const [t] of boxes) {
            const k = log.findIndex((q) => q.m === 'fillText' && q.args[0] === t), box = log.slice(0, k).reverse().find((q) => q.m === 'fillRect');
            assert.equal(box.fill, 'rgba(20,20,20,0.72)', t + ': on a dark box');
        }
        clean(p);
    }
    assert.ok(labelBox(a.ctx, 'Tail output limit 1250 ‰') && labelBox(a.ctx, 'Tail output limit -1250 ‰'), 'both limits have their labels');
    // a line label that finds no room shows in the readout when the mouse is on its line
    const full = plot({ x: { min: 0, max: 10 }, y: { min: 0, max: 10 }, legend: false, series: [{ x: [0, 10], y: [0, 10] }],
        hlines: [5, 5.05, 5.1, 5.15].map((v, i) => ({ y: v, label: 'line label number ' + i + ' that is long, longer than half of the plot width' })) });
    const drawn = [0, 1, 2, 3].filter((i) => labelBox(full.ctx, 'line label number ' + i + ' that is long, longer than half of the plot width'));
    assert.ok(drawn.length < 4, 'four long labels on one line do not fit');
    const miss = [0, 1, 2, 3].find((i) => !drawn.includes(i)), y4 = yPixel(full.ctx, '4'), y6 = yPixel(full.ctx, '6');
    const tx = hover(full, 300, Math.round(y4 + (y6 - y4) * ([5, 5.05, 5.1, 5.15][miss] - 4) / 2) + 0.5);
    assert.ok(tx.some((t) => t.startsWith('line label number ' + miss)), 'the readout names the line: ' + tx.join(' | '));
});

test('a title that is wider than the plot goes on two lines, the second cut with "…" (V10: the lens plot title)', () => {
    const title = 'Tracking error, roll: setpoint and gyro after a low-pass filter at 30 Hz';
    const p = plot({ title, x: { min: 0, max: 10 }, y: { min: 0, max: 1 }, series: [{ x: [0, 10], y: [0, 1] }] }, { width: 300 });
    const lines = calls(p.ctx, 'fillText').filter((q) => q.align === 'left' && q.baseline === 'top' && (q.args[2] === 6 || q.args[2] === 22)).map((q) => q.args); // ROW 16 at 100 % text
    assert.equal(lines.length, 2, JSON.stringify(lines));
    const left = lines[0][1];
    for (const l of lines) assert.ok(left + String(l[0]).length * 6 <= 300 - 8, 'inside the canvas: ' + l[0]);
    assert.equal(lines[0][0] + ' ' + lines[1][0].replace(/…$/, ''), title.slice(0, lines[0][0].length + 1 + lines[1][0].replace(/…$/, '').length), 'the words in their sequence');
    const frame = calls(p.ctx, 'strokeRect')[0].args;
    assert.ok(frame[1] >= 35, 'the plot box starts under the two lines: ' + frame[1]);
    const one = plot({ title: 'Short', x: { min: 0, max: 10 }, y: { min: 0, max: 1 }, series: [{ x: [0, 10], y: [0, 1] }] }, { width: 300 });
    assert.equal(calls(one.ctx, 'strokeRect')[0].args[1], 26.5, 'one line: the plot box under the title (round(22 x 1.2) at 100 % text)');
    const { TP } = setup(), m = { measureText: (t) => ({ width: String(t).length * 6 }) };
    assert.deepEqual([...TP.wrapTitle(m, 'a b c', 100)], ['a b c']);
    assert.deepEqual([...TP.wrapTitle(m, 'aaaa bbbb cccc dddd', 60)], ['aaaa bbbb', 'cccc dddd']);
    assert.deepEqual([...TP.wrapTitle(m, 'aaaa bbbb cccc dddd eeee', 60)], ['aaaa bbbb', 'cccc dddd…']);
    assert.equal(TP.fitText(m, 'abcdefghijkl', 30), 'abcd…');
    clean(p);
});

test('unsorted x: every point drawn (no binary-search window), no hover readout', () => {
    const p = plot({ legend: false, x: { min: 0, max: 4 }, y: { min: 0, max: 4 }, series: [{ name: 'ev', x: [3, 1, 2], y: [3, 1, 2], points: true, width: 0 }] });
    assert.equal(calls(p.ctx, 'arc').length, 3);
    const tx = hover(p, xPixel(p.ctx, 1, 1, 3), yPixel(p.ctx, '1'));
    assert.ok(!tx.some((s) => s.startsWith('ev')), tx.join(' | '));
    clean(p);
});

test('resize, late layout, destroy and re-attach', () => {
    const env = setup(2), canvas = fakeCanvas(0);
    const h = env.TP.attach(canvas, { series: [{ x: [0, 1], y: [0, 1] }] });
    assert.equal(canvas.width, 300, 'not laid out yet: nothing drawn');
    assert.equal(calls(canvas.ctx, 'drawImage').length, 0);
    assert.deepEqual(env.observers[0].targets, [canvas]);
    canvas.cssWidth = 500;
    env.observers[0].cb([]);
    assert.deepEqual([canvas.width, canvas.height], [1000, 440]);
    canvas.cssWidth = 400;
    env.observers[0].cb([]);
    assert.equal(canvas.width, 800);
    let blits = calls(canvas.ctx, 'drawImage').length;
    env.observers[0].cb([]); // same size and pixel ratio (the observer also fires for the plot's own style.height): no redraw
    assert.equal(calls(canvas.ctx, 'drawImage').length, blits);
    canvas.cssWidth = 0; // hidden: the cache is freed, and shown again it is redrawn
    env.observers[0].cb([]);
    assert.equal(env.created[0].width, 0);
    canvas.cssWidth = 400;
    env.observers[0].cb([]);
    assert.equal(env.created[0].width, 800);
    blits = calls(canvas.ctx, 'drawImage').length;
    h.destroy();
    assert.deepEqual(env.observers[0].targets, []);
    assert.ok(['mousemove', 'mouseleave', 'click'].every((t) => canvas.listeners[t].length === 0));
    canvas.cssWidth = 600; // a late observer call with a new size, an update and a mouse move: all ignored
    env.observers[0].cb([]);
    h.update({ series: [] });
    canvas.fire('mousemove', 100, 100);
    assert.equal(calls(canvas.ctx, 'drawImage').length, blits, 'nothing drawn after destroy');
    const a = env.TP.attach(canvas, {}), b = env.TP.attach(canvas, {}); // the second replaces the first
    assert.ok(['mousemove', 'mouseleave', 'click'].every((t) => canvas.listeners[t].length === 1));
    assert.notEqual(a, b);
});

// --- SPEC3 C: the text size of the views --------------------------------------------------------------------------------

test('text size: the fonts, the line height, the margins and the tick spacing follow setTextScale; the live plots draw again', () => {
    const env = setup(1), canvas = fakeCanvas(800), spec = { title: 'Roll', x: { label: 'Time', unit: 's', min: 0, max: 10 }, y: { min: 0, max: 1 },
        series: [{ name: 'gyro', x: [0, 10], y: [0, 1] }] };
    assert.deepEqual(plain(env.TP.textMetrics()), { scale: 1, k: 1.2, font: '12px Verdana, Arial, sans-serif', title: 'bold 13px Verdana, Arial, sans-serif', row: 16 }, '100 %: 12 px tick labels');
    env.TP.attach(canvas, spec);
    const cache = env.created[env.created.length - 1], first = calls(cache.ctx, 'strokeRect')[0].args;
    assert.equal(env.TP.livePlots(), 1);
    let redraws = 0;
    const off = env.TP.onTextScale((s) => { redraws++; assert.equal(s, 1.6); });
    cache.ctx.log.length = 0;
    // a font that the stand-in measures: 0.6 x the px size for each character, so the margins follow the text
    let px = 12;
    cache.ctx.measureText = (t) => ({ width: String(t).length * 0.6 * px });
    Object.defineProperty(cache.ctx, 'font', { set(v) { px = parseFloat(/(\d+)px/.exec(v)[1]); this._font = v; }, get() { return this._font; }, configurable: true });
    assert.equal(env.TP.setTextScale(1.6), 1.6);
    assert.equal(redraws, 1, 'the listeners after the plots');
    assert.equal(cache.ctx._font, '19px Verdana, Arial, sans-serif', '10 px x 1.2 x 1.6');
    const box = calls(cache.ctx, 'strokeRect')[0].args;
    assert.ok(box[1] > first[1], `the plot box starts lower under the larger title: ${first[1]} -> ${box[1]}`);
    assert.ok(box[0] + box[2] <= 800 && box[1] + box[3] < 220 - 34 * 1.2 * 1.6 + 1, 'the bottom margin holds the larger tick labels and the axis title');
    assert.deepEqual(plain(env.TP.textMetrics()), { scale: 1.6, k: 1.92, font: '19px Verdana, Arial, sans-serif', title: 'bold 21px Verdana, Arial, sans-serif', row: 25 });
    assert.equal(env.TP.setTextScale(1.6), 1.6, 'the same scale: no draw');
    assert.equal(redraws, 1);
    // out of range or not a number: held to 0.5 to 3, or 100 %
    assert.equal(env.TP.setTextScale(9), 3);
    assert.equal(env.TP.setTextScale('x'), 1);
    off();
    env.TP.setTextScale(1.2);
    assert.equal(redraws, 3, 'no call after the listener is removed');
    // a destroyed plot and a plot taken off the page are not drawn again
    canvas._tuningPlot.destroy();
    assert.equal(env.TP.livePlots(), 0);
    const gone = fakeCanvas(800);
    env.TP.attach(gone, spec);
    gone.isConnected = false;
    const n = env.created.length, c2 = env.created[n - 1];
    c2.ctx.log.length = 0;
    env.TP.setTextScale(1.4);
    assert.equal(calls(c2.ctx, 'strokeRect').length, 0, 'detached: no draw');
    assert.equal(env.TP.livePlots(), 0, 'and no longer kept');
});

test('SPEC3 G: the spectra of the filter calculation (js/tuning_dialog.js ftPlotSpecs) draw on log y axes with their legend, also with a bin at 0 Hz and a series that is null', () => {
    const env = setup();
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/tuning_dialog.js'), 'utf8'), env.realm, { filename: 'js/tuning_dialog.js' });
    const f = Float32Array.from({ length: 200 }, (_, i) => i * 2.5), c = (k) => Float32Array.from(f, (x) => k / (1 + x)); // 0 Hz first: finite, positive
    const res = { curves: { f, windows: 46, roll: { raw: c(9), logged: c(4), predicted: c(4.1), candidate: c(1), pidOut: c(3), pidOutCandidate: c(0.5) },
        yaw: { raw: c(9), logged: c(4), predicted: c(4.1), candidate: null, pidOut: c(3), pidOutCandidate: null } } };
    const specs = env.realm.TuningDialog.internals.ftPlotSpecs(res, 'roll').map((it) => it.spec);
    assert.equal(specs.length, 2);
    for (const spec of specs) {
        const canvas = fakeCanvas(800), h = env.TP.attach(canvas, spec), ctx = env.created[env.created.length - 1].ctx;
        assert.deepEqual([...ctx.bad, ...canvas.ctx.bad], [], spec.title + ': non-finite canvas arguments');
        const tx = texts(ctx);
        assert.ok(tx.includes(spec.title), spec.title);
        for (const s of spec.series) assert.ok(tx.includes(s.name), s.name + ' in the legend');
        assert.ok(tx.includes('frequency (Hz)'), 'the x axis label');
        h.destroy();
    }
    const yaw = env.realm.TuningDialog.internals.ftPlotSpecs(res, 'yaw').map((it) => it.spec);
    assert.deepEqual(plain(yaw.map((s) => s.series.length)), [3, 1], 'no series for the recommended values of an axis without them');
    assert.deepEqual(plain(env.realm.TuningDialog.internals.ftPlotSpecs({ curves: { f } }, 'pitch')), [], 'no plot for an axis without curves');
});
