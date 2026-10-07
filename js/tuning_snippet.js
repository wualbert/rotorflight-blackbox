"use strict";

/**
 * TuningSnippet - the raw columns of one span of a log, read on the main thread for "Show the measurement"
 * (js/tuning_dialog.js) and the log lens (js/log_lens.js). Filters and spectra of the columns are not done here: the
 * "derive" command of js/tuning_worker.js does them.
 *
 *   var reader = new TuningSnippet.Reader(hooks);   // hooks: { getFlightLog(), getBytes() }, read at each use (js/main.js
 *                                                   // replaces the file and its FlightLog on every load)
 *   reader.read(li, t0, t1, fields) -> Promise<{ log, t0, t1, t, cols, missing, frames, rate, clipped, source }>
 *   reader.drop()                                   // forget the FlightLog kept for another log of the file
 *   reader.sync()                                   // forget them only when they are of a file that is not open now
 *                                                   // (each read does this first)
 *
 * t0, t1 and t are frame seconds from the start of log li: (frame time - getMinTime(li)) / 1e6, the clock of the log
 * viewer. t is a Float64Array; cols holds one Float32Array per field the log has (NaN where a slow field has no value
 * yet); missing lists the fields it does not have. rate is the frame rate of the read (frames per second).
 * - The log the viewer shows: its own FlightLog, getChunksInTimeRange (never the smoothed variant), CALL_S or less in
 *   each call: the chunk cache of the viewer grows to 3 x the chunks of one call + 1 and never shrinks
 *   (flightlog.js:308-313). The values are copied out after each call, because the cache recycles the frame arrays of
 *   old chunks. Nothing of the viewer changes: no openLog, no seek.
 * - Another log of the file: a FlightLog over the bytes of that log (FlightLogIndex offsets), kept for the next read of
 *   the same log of the same file. Its index blocks the main thread for about 1 s per 13 MB of log in Node, 2 s in NW.js.
 * A read gives MAX_S or less: a longer span is cut to its first MAX_S seconds (clipped: true).
 * Errors are STE sentences for the user (the Tuning view shows them).
 */
var TuningSnippet = (function () {

    var CALL_S = 12, MAX_S = 60;

    function isNum(v) {
        return typeof v === "number" && isFinite(v);
    }

    function timeIndex() {
        return typeof FlightLogParser !== "undefined" && FlightLogParser.prototype && isNum(FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME) ?
            FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME : 1;
    }

    function fail(text) {
        return new Error(text);
    }

    // The values of `fields` in frame seconds [t0, t1] of log li of `log` (a FlightLog that has log li open)
    function readFrames(log, li, t0, t1, fields) {
        var T = timeIndex(), tMin = log.getMinTime(li), idx = fields.map(function (name) { return log.getMainFieldIndexByName(name); });
        var t = [], cols = fields.map(function () { return []; });
        for (var a = t0; a < t1 || (a === t0 && t0 === t1); a += CALL_S) {
            var b = Math.min(t1, a + CALL_S), last = b >= t1, A = tMin + a * 1e6, B = tMin + b * 1e6;
            var chunks = log.getChunksInTimeRange(A, B) || [];
            for (var c = 0; c < chunks.length; c++) {
                var frames = chunks[c].frames || [];
                for (var i = 0; i < frames.length; i++) {
                    var frame = frames[i], ft = frame[T];
                    if (!(ft >= A) || (last ? ft > B : ft >= B)) continue;
                    t.push((ft - tMin) / 1e6);
                    for (var j = 0; j < fields.length; j++) {
                        if (idx[j] !== undefined) cols[j].push(frame[idx[j]]);
                    }
                }
            }
            if (last) break;
        }
        var out = {}, missing = [];
        fields.forEach(function (name, j) {
            if (idx[j] === undefined) {
                missing.push(name);
                return;
            }
            var src = cols[j], col = new Float32Array(src.length);
            for (var k = 0; k < src.length; k++) col[k] = src[k] === null || src[k] === undefined ? NaN : src[k];
            out[name] = col;
        });
        var n = t.length, tt = Float64Array.from(t);
        return { t: tt, cols: out, missing: missing, frames: n, rate: n > 1 && tt[n - 1] > tt[0] ? (n - 1) / (tt[n - 1] - tt[0]) : null };
    }

    function Reader(hooks) {
        this.hooks = hooks || {};
        this.slice = null;   // { bytes, li, log }: the FlightLog of another log of the file
        this.offsets = null; // { bytes, list }: the log offsets of the file
    }

    Reader.prototype.drop = function () {
        this.slice = null;
        this.offsets = null;
    };

    // Forget the FlightLog and the offsets of a file that is not the open file now (another file was opened): they keep
    // the bytes of that file in memory
    Reader.prototype.sync = function () {
        var bytes = this.hooks.getBytes ? this.hooks.getBytes() : null;
        if (this.slice && this.slice.bytes !== bytes) this.slice = null;
        if (this.offsets && this.offsets.bytes !== bytes) this.offsets = null;
    };

    // A FlightLog with log li open, without a change to the viewer: the viewer's own when it shows log li
    Reader.prototype.logFor = function (li) {
        this.sync();
        var viewer = this.hooks.getFlightLog ? this.hooks.getFlightLog() : null;
        if (!viewer) throw fail("No log is open.");
        if (!isNum(li) || li < 0 || li >= viewer.getLogCount() || li !== Math.floor(li)) throw fail("Log " + (li + 1) + " is not in the file.");
        if (viewer.getLogError && viewer.getLogError(li)) throw fail("The app cannot read log " + (li + 1) + ".");
        if (viewer.getLogIndex() === li) return { log: viewer, li: li, source: "viewer" };
        var bytes = this.hooks.getBytes ? this.hooks.getBytes() : null;
        if (!bytes || !bytes.length) throw fail("The data of the file is not available.");
        if (this.slice && this.slice.bytes === bytes && this.slice.li === li) return { log: this.slice.log, li: 0, source: "slice" };
        this.slice = null;
        if (!this.offsets || this.offsets.bytes !== bytes) {
            var index = new FlightLogIndex(bytes), list = [];
            for (var i = 0; i <= index.getLogCount(); i++) list.push(index.getLogBeginOffset(i));
            this.offsets = { bytes: bytes, list: list };
        }
        var o = this.offsets.list;
        if (li + 1 >= o.length) throw fail("Log " + (li + 1) + " is not in the file.");
        var log = new FlightLog(bytes.subarray(o[li], o[li + 1])), header = typeof $ === "function" ? $(".open-header-dialog") : null,
            display = header && header.css ? header.css("display") : null, opened;
        try {
            opened = log.getLogCount() > 0 && !log.getLogError(0) && log.openLog(0);
        } finally {
            if (header && header.css && typeof display === "string") header.css("display", display); // openLog shows or hides the viewer's header button
        }
        if (!opened) throw fail("The app cannot read log " + (li + 1) + ".");
        this.slice = { bytes: bytes, li: li, log: log };
        return { log: log, li: 0, source: "slice" };
    };

    // Frame seconds [t0, t1] of log li (from 0), the given fields
    Reader.prototype.read = function (li, t0, t1, fields) {
        var self = this;
        return new Promise(function (resolve, reject) {
            setTimeout(function () { // the caller can show a message before the index of another log blocks the thread
                try {
                    if (!isNum(t0) || !isNum(t1)) throw fail("The time period is not correct.");
                    var a = Math.max(0, Math.min(t0, t1)), b = Math.max(t0, t1), clipped = b - a > MAX_S;
                    if (clipped) b = a + MAX_S;
                    var names = (Array.isArray(fields) ? fields : []).map(String).filter(function (name, i, all) { return name && all.indexOf(name) === i; });
                    var at = self.logFor(li), out = readFrames(at.log, at.li, a, b, names);
                    out.log = li;
                    out.t0 = a;
                    out.t1 = b;
                    out.clipped = clipped;
                    out.source = at.source;
                    resolve(out);
                } catch (e) {
                    reject(e instanceof Error ? e : fail(String(e)));
                }
            }, 0);
        });
    };

    return { Reader: Reader, CALL_S: CALL_S, MAX_S: MAX_S };
})();
