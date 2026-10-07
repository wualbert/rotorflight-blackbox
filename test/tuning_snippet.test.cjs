// js/tuning_snippet.js, the raw columns of a span of a log for "Show the measurement" and the log lens: run in a vm realm
// with the app's own decoder (tools/autotune/lib.cjs loadApp) on a synthetic three-log .bbl (test/helpers/bbl_encode.cjs)
// whose columns are the ground truth. Times are frame seconds from the log start (the viewer clock): across a logging gap
// the frame clock jumps and index time does not.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const lib = require('../tools/autotune/lib.cjs');
const bbl = require('./helpers/bbl_encode.cjs');

const ROOT = path.join(__dirname, '..');
const A = bbl.simulateFlight({ seconds: 20, seed: 1, airborne: [3, 18] });
const B = bbl.simulateFlight({ seconds: 30, seed: 2, airborne: [3, 28], gapAt: 12 }); // 300 frames lost at 12 s
const FILE = bbl.encode([A, { broken: true }, B]);
const GAP = { at: B.gapAt, frames: B.gapFrames };

// frame seconds and gyroADC[0], setpoint[0] of sample i as the encoder wrote them
const frameS = (log, i) => (log === B && i >= GAP.at ? i + GAP.frames : i) / 1000;
const truth = (log, name, i) => Math.round({ 'gyroADC[0]': log.w.gyro[0], 'setpoint[0]': log.w.sp[0] }[name][i]) + 0; // + 0: no -0

function realm() {
    const app = lib.loadApp();
    app.setTimeout = setTimeout;
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/tuning_snippet.js'), 'utf8'), app, { filename: 'js/tuning_snippet.js' });
    let made = 0;
    const Orig = app.FlightLog;
    app.FlightLog = function (data) { made++; return new Orig(data); }; // count the FlightLogs of other logs
    app.__bytes = FILE.bytes;
    const viewer = vm.runInContext('new FlightLog(__bytes)', app); // made by the viewer, not counted below
    made = 0;
    viewer.openLog(2);
    const calls = [], opened = [];
    const chunks = viewer.getChunksInTimeRange, open = viewer.openLog;
    viewer.getChunksInTimeRange = function (a, b) { calls.push([a, b]); return chunks.call(this, a, b); };
    viewer.openLog = function (i) { opened.push(i); return open.call(this, i); };
    const hooks = { getFlightLog: () => viewer, getBytes: () => FILE.bytes };
    return { app, viewer, calls, opened, hooks, made: () => made, reader: new app.TuningSnippet.Reader(hooks) };
}

test('the log on display: frame seconds across a logging gap, the values as logged, missing fields, nothing of the viewer changes', async () => {
    const R = realm(), out = await R.reader.read(2, 10, 14, ['gyroADC[0]', 'setpoint[0]', 'axisError[0]', 'nothere', 'gyroADC[0]']);
    assert.equal(out.source, 'viewer');
    assert.deepEqual([out.log, out.t0, out.t1, out.clipped], [2, 10, 14, false]);
    assert.deepEqual(Array.from(out.missing), ['nothere']);
    assert.deepEqual(Object.keys(out.cols), ['gyroADC[0]', 'setpoint[0]', 'axisError[0]'], 'each field once');
    // samples 10000..11999 at 10.000..11.999 s, then the gap: sample 12000 at 12.300 s, up to sample 13700 at 14.000 s
    const want = [];
    for (let i = 10000; i <= 13700; i++) if (frameS(B, i) >= 10 && frameS(B, i) <= 14) want.push(i);
    assert.equal(out.frames, want.length);
    assert.equal(out.t.length, want.length);
    let worst = 0;
    want.forEach((i, k) => {
        worst = Math.max(worst, Math.abs(out.t[k] - frameS(B, i)));
        assert.equal(out.cols['gyroADC[0]'][k], truth(B, 'gyroADC[0]', i));
        assert.equal(out.cols['setpoint[0]'][k], truth(B, 'setpoint[0]', i));
    });
    assert.ok(worst < 1e-9, `frame seconds off by ${worst}`);
    assert.ok(Math.abs(out.t[2000] - out.t[1999] - 0.301) < 1e-9, 'the gap is in the frame clock');
    const type = (x) => Object.prototype.toString.call(x);
    assert.deepEqual([type(out.cols['axisError[0]']), type(out.t)], ['[object Float32Array]', '[object Float64Array]']);
    assert.ok(Math.abs(out.rate - (want.length - 1) / 4) < 1e-9, 'frames per second of the read');
    assert.deepEqual(R.opened, [], 'no openLog on the viewer');
    assert.equal(R.viewer.getLogIndex(), 2);
    assert.equal(R.made(), 0, 'the viewer\'s own FlightLog');
});

test('a long read: calls of 12 s or less on the viewer, no frame lost or doubled at their edges, cut at 60 s', async () => {
    const R = realm(), out = await R.reader.read(2, 0, 30.5, ['gyroADC[0]']);
    assert.ok(R.calls.length >= 3);
    for (const [a, b] of R.calls) assert.ok(b - a <= R.app.TuningSnippet.CALL_S * 1e6, 'each call spans 12 s or less');
    assert.equal(out.frames, B.truth.frames, 'every frame of the log, once');
    for (let k = 1; k < out.t.length; k++) assert.ok(out.t[k] > out.t[k - 1]);
    for (const k of [0, 11999, 12000, 23999, 24000, out.frames - 1]) assert.equal(out.cols['gyroADC[0]'][k], truth(B, 'gyroADC[0]', k), `sample ${k}`);
    const long = await R.reader.read(2, 0, 100, ['gyroADC[0]']);
    assert.deepEqual([long.t0, long.t1, long.clipped], [0, R.app.TuningSnippet.MAX_S, true]);
    const back = await R.reader.read(2, 5, 4, ['gyroADC[0]']);
    assert.deepEqual([back.t0, back.t1], [4, 5], 'a reversed span');
});

test('another log of the file: a FlightLog of that log\'s bytes, kept for the next read, dropped with the file', async () => {
    const R = realm(), out = await R.reader.read(0, 2, 5, ['gyroADC[0]', 'setpoint[0]']);
    assert.equal(out.source, 'slice');
    assert.equal(R.made(), 1);
    assert.equal(out.frames, 3001);
    for (const k of [0, 1500, 3000]) {
        assert.ok(Math.abs(out.t[k] - frameS(A, 2000 + k)) < 1e-9);
        assert.equal(out.cols['gyroADC[0]'][k], truth(A, 'gyroADC[0]', 2000 + k));
    }
    const again = await R.reader.read(0, 10, 11, ['setpoint[0]']);
    assert.equal(R.made(), 1, 'the same FlightLog for the same log');
    assert.equal(again.cols['setpoint[0]'][0], truth(A, 'setpoint[0]', 10000));
    assert.equal(R.viewer.getLogIndex(), 2, 'the viewer stays on its log');
    assert.deepEqual(R.opened, []);
    // the viewer opens log 0: its own FlightLog again; a new file: a new FlightLog for the other log
    await R.reader.read(2, 1, 2, ['gyroADC[0]']);
    assert.equal(R.made(), 1, 'the log on display uses the viewer');
    const copy = FILE.bytes.slice();
    R.hooks.getBytes = () => copy;
    await R.reader.read(0, 2, 3, ['gyroADC[0]']);
    assert.equal(R.made(), 2, 'other bytes: a new FlightLog');
    R.reader.drop();
    await R.reader.read(0, 2, 3, ['gyroADC[0]']);
    assert.equal(R.made(), 3, 'drop() forgets it');
});

test('a new file: the FlightLog and the offsets of the old file go at once, also when the next read is of the log on display (B4)', async () => {
    const R = realm();
    await R.reader.read(0, 2, 3, ['gyroADC[0]']);
    assert.ok(R.reader.slice && R.reader.slice.bytes === FILE.bytes && R.reader.offsets.bytes === FILE.bytes, 'kept for the next read');
    // another file opens (main.js replaces the bytes); the next read is of the log on display: nothing of the old file stays
    const copy = FILE.bytes.slice();
    R.hooks.getBytes = () => copy;
    await R.reader.read(2, 1, 2, ['gyroADC[0]']);
    assert.deepEqual([R.reader.slice, R.reader.offsets], [null, null], 'the old file is not in memory');
    // sync() does the same with no read (the views call it when they show); the same file keeps them
    await R.reader.read(0, 2, 3, ['gyroADC[0]']);
    R.reader.sync();
    assert.ok(R.reader.slice && R.reader.slice.bytes === copy, 'the open file: kept');
    R.hooks.getBytes = () => null;
    R.reader.sync();
    assert.deepEqual([R.reader.slice, R.reader.offsets], [null, null]);
});

test('errors are STE sentences: a log that does not parse, a log not in the file, no log, no bytes, a time that is not a number', async () => {
    const R = realm();
    await assert.rejects(R.reader.read(1, 0, 1, ['gyroADC[0]']), { message: 'The app cannot read log 2.' });
    await assert.rejects(R.reader.read(5, 0, 1, ['gyroADC[0]']), { message: 'Log 6 is not in the file.' });
    await assert.rejects(R.reader.read(2, NaN, 1, ['gyroADC[0]']), { message: 'The time period is not correct.' });
    const none = new R.app.TuningSnippet.Reader({ getFlightLog: () => null });
    await assert.rejects(none.read(0, 0, 1, ['gyroADC[0]']), { message: 'No log is open.' });
    const nobytes = new R.app.TuningSnippet.Reader({ getFlightLog: () => R.viewer, getBytes: () => null });
    await assert.rejects(nobytes.read(0, 0, 1, ['gyroADC[0]']), { message: 'The data of the file is not available.' });
    const empty = await R.reader.read(2, 50, 55, ['gyroADC[0]']);
    assert.deepEqual([empty.frames, empty.rate], [0, null], 'after the end of the log: no frames');
});

test('app code is one IIFE global, Chromium 99 safe', () => {
    const src = fs.readFileSync(path.join(ROOT, 'js/tuning_snippet.js'), 'utf8'), context = vm.createContext({});
    vm.runInContext(src, context);
    assert.deepEqual(Object.keys(context), ['TuningSnippet']);
    assert.ok(!/^(const|let|class)\s/m.test(src), 'no top-level const, let or class');
    assert.ok(!/getSmoothedChunksInTimeRange/.test(src), 'never the smoothed variant (CLAUDE.md)');
    for (const api of ['toSorted', 'Object.groupBy', 'findLast', '.at(', 'structuredClone', 'replaceAll']) assert.ok(!src.includes(api), api);
});
