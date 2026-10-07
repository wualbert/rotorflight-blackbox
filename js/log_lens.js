"use strict";

/**
 * LogLens - the log lens of the Analysis view (#logLensBody, under the verdict of js/analysis_view.js). A time window
 * moves through the open log; the lens shows the results of the analysis whose evidence spans are in the window, and
 * values that the derive worker calculates for the window, each with its limit and the check that uses it.
 *
 *   var lens = new LogLens(container, hooks);   // container: the #logLensBody element (or a jQuery of it)
 *   lens.show(flightLog); lens.hide(); lens.setResult(result); lens.goTo(log, t0, t1);
 *
 * hooks (js/main.js through js/analysis_view.js, read at each use): getViewerWindow() -> { t0us, t1us } (the graph
 *   window, in the time base of flightLog.getMinTime()), setViewerWindow(t0us, t1us) (time and zoom, no view switch),
 *   viewInLog(req), getBytes(), getFileName(), getCurrentLogIndex(), getFlightLog(), runAnalysis() (optional: without
 *   it the lens has no "Start the analysis" button, the verdict has it), getResult(), onResult(cb) and
 *   derive(kind, cols, rate, params) -> Promise (the derive worker of js/tuning_worker.js that the Tuning view owns),
 *   configuration() -> "all" | id, setConfiguration(id), onConfiguration(cb) (SPEC3 J: the configuration menu of the Tuning
 *   view, optional: the lens shows the results of that configuration and the items for all configurations).
 *
 * Layout: a timeline of the whole log (headspeed from the result, else the throttle of the log index; the PID profile;
 * the configurations of the result (result.datasets.labels, M1: a strip with the letter of each configuration); the flight
 * phases of the result, with the time out of flight shaded; the evidence spans of the results by status; the
 * window as a box to pull), the legend and the PID profile at the start of the log with how the analysis found it
 * (startHtml), the flag rows of the parts of the window whose values are possibly not those of the log header (result.epochs:
 * epochRowsHtml, CLAUDE.md "Values that are possibly not current"; these parts are lighter on the PID profile strip), then the
 * strip charts of the window (TuningPlot, left) and the panel "In this time window" (right). The mouse wheel over the
 * plots moves the window by PAN of its width, Ctrl or Cmd and the wheel zoom (MIN_S to MAX_S), a pull on the timeline
 * moves it, and so do the left and right arrow keys. A change reads the window
 * (TuningSnippet.Reader on the viewer's FlightLog) and asks the derive worker for its values when DEBOUNCE_MS pass with
 * no change; an answer for an older window is dropped. The viewer follows the window (setViewerWindow).
 *
 * "Show the measurement" of a result draws its evidence plot (tools/autotune/evidence.cjs) as the Tuning view draws
 * it (evidenceCompare, with the pure parts of js/tuning_dialog.js); "Show" of a window value draws a plot of the window.
 * LogLens.internals also gives the pieces that js/analysis_view.js shares: statusOf, profileOf, phasesOf, flightsOf,
 * benchOf, evidenceCompare, and the parts with values that are possibly not those of the log header (windowEpochs,
 * epochCauses, epochRowsHtml). logPreview and logSpecs also serve the "Show in the log" panels of both views.
 *
 * Times are frame seconds from the log start: the viewer clock (SPEC2 D1). The text is ASD-STE100; strings that come
 * from the log, the toolkit or a worker are escaped, and text that is not ours is in data-ste="quoted" or <code>.
 * Viewer only: nothing goes to a flight controller.
 */
var LogLens = (function () {

    var AXES = ["roll", "pitch", "yaw"];
    var MIN_S = 0.5, MAX_S = 60, PAN = 0.1, ZOOM = 1.25, DEBOUNCE_MS = 150,
        PAD_S = 0.5, // s read on each side of the window, so that the filters of the derive worker start and end outside it
        PAD = 6;     // css px on each side of the timeline

    // The fields that the lens reads for its window: the strip charts and the window values
    var FIELDS = ["setpoint[0]", "setpoint[1]", "setpoint[2]", "gyroADC[0]", "gyroADC[1]", "gyroADC[2]", "gyroRAW[0]", "gyroRAW[1]", "gyroRAW[2]",
        "axisD[0]", "axisD[1]", "axisD[2]", "mixer[2]", "mixer[3]", "headspeed", "govTarget"];

    // The limits in the plots of "Show" and in the tail and line rows; the worker gives the limits of the other rows. They
    // are the toolkit's DEFAULT_RULES: test/log_lens.test.cjs keeps them equal to the modules
    var LIMITS = {
        track: [0.30, 0.45], // C12, T11 note and flag: rms(error) / rms(setpoint), health_track.cjs
        osc: 20,             // C5, T1 level: deg/s of band-passed error amplitude, health_track.cjs
        gov: [0.01, 0.02],   // G2 median and band: (headspeed - target) / target, health_gov.cjs
        tail: 1,             // T8 minEpisodes: times at a tail output limit, health_loop.cjs
        dterm: 0.5,          // C11 and F10 share: D-term power at more than 30 Hz, health_loop.cjs and health_more.cjs
        line: 5,             // F5 minProminence and maxDistance, health_setup.cjs
        lineNotch: 0.02
    };
    var OSC_BANDS = { roll: [10, 20], pitch: [8, 16], yaw: [5, 16] }; // Hz: health_track.cjs RULE.osc.bands (wag.cjs RULE.bands)
    var CHECKS = { track: ["C12", "C12", "T11"], osc: ["C5", "C5", "T1"], dterm: ["C11", "C11", "F10"] };

    // Status words (SPEC2 D9) and their order in the lists
    var STATUS = {
        error: ["Analysis error", 0], problem: ["Problem", 1], monitor: ["Monitor", 2], insufficient: ["Not sufficient data", 3],
        information: ["Information", 4], satisfactory: ["Satisfactory", 5], notMeasured: ["Not measured", 6]
    };

    // The flight phases of SPEC2 D13 (records[].phases of the result): label and colour on the timeline
    var PHASES = { idle: ["Idle", "#6b6b6b"], spoolup: ["Spool-up", "#80b1d3"], ground: ["On the ground", "#bc80bd"], flight: ["Flight", "#b3de69"],
        spooldown: ["Spool-down", "#fdb462"] };
    var PHASE_ORDER = ["idle", "spoolup", "ground", "flight", "spooldown"];

    // D4, F4 and H have no PID profile of the log (catalog.cjs NO_LOG_PROFILE)
    var NO_LOG_PROFILE = { D4: 1, F4: 1, H: 1 };
    var COMPARE_S = 12; // a raw read for "Show the measurement": 12 s or less (js/tuning_snippet.js CALL_S)

    // All fixed text, in ASD-STE100 (test/ste_text.test.cjs reads this table)
    var TEXT = {
        title: "Log lens",
        hint: "To move the time window, pull the box on the timeline. You can also scroll on the plots. " +
            'To zoom in or out, hold "Ctrl" or "Cmd" and scroll. After you click the timeline or a plot, the left and right arrow keys also move the time window.',
        noLog: "No log is open.",
        logError: "No data that the app can read.",
        noData: "No data that the app can read.",
        configuration: "Configuration",
        allConfigs: "All configurations",
        configList: "The list shows the results of this configuration and the results for all configurations.",
        noResult: "The results of the analysis are not available for this log. The app shows only the values of the time window.",
        start: "Start the analysis",
        running: "The analysis started. Wait for the results.",
        startFailed: "The analysis did not start.",
        stopped: "The analysis stopped because of an error.",
        canceled: "You canceled the analysis.",
        noSpans: "No result of this analysis has a time in the log. Thus, the app cannot show the results in the time window.",
        inWindow: "In this time window",
        findings: "Results in this time window",
        noFindings: "No result of the analysis is in this time window.",
        values: "Values in this time window",
        busy: "The app updates the plots and the values.",
        noValues: "The app cannot calculate the values.",
        noDerive: "The app cannot calculate the values of the time window.",
        noReader: "The app did not load js/tuning_snippet.js. Thus, the app cannot read the data.",
        noRead: "The app cannot read the data of this time window.",
        noPlot: "The plot is not available.",
        noPlots: "The plot library (js/tuning_plot.js) is not available.",
        notInLog: "This log does not contain the fields of this plot.",
        noFields: "This log does not contain these fields:",
        showInLog: "Show in the log",
        compare: "Show the measurement",
        show: "Show",
        close: "Close",
        quoted: "Toolkit text (not STE)",
        window: "Time window",
        quantity: "Quantity", value: "Value", limit: "Limit", check: "Check",
        notMeasured: "Not measured", insufficient: "Not sufficient data",
        notches: "The notch filters are not available without an analysis result.",
        noNotchData: "The analysis result does not give the notch filters of this log.",
        notchUnknown: "Notch filter frequency unknown",
        fromLog: "from the log",
        startOf: "Start of the log:",
        noStart:"To start the analysis, use the button at the top of this view.",
        bench: "This log is a bench run. The analysis does not include bench runs.",
        allProfiles: "All PID profiles", unknownProfile: "PID profile unknown",
        phases: "Flight phases", flight: "Flight",
        expected: "Satisfactory", measured: "Measured",
        compareTitle: "Measurement",
        noEvidence: "This result has no plot.",
        noKit: "The app did not load js/tuning_dialog.js. Thus, the app cannot show this plot.",
        noCurve: "The curves of the result do not contain the data of this plot.",
        windowPlot: "This plot shows the data of the time window.",
        noTable: "This result has no data for a table.",
        missed: "The plot cannot show these limits:",
        showThin: "Show results with not sufficient data",
        showOk: "Show satisfactory results",
        notShown: "The list does not show",
        source: "Data:",
        // values that are possibly not the values of the log header (CLAUDE.md "Values that are possibly not current")
        epochHead: "Values possibly different", // as js/tuning_dialog.js FRESH.badge and js/analysis_view.js epochTag
        epochMore: "more parts of the log with these values are in the time window.",
        epochOneMore: "1 more part of the log with these values is in the time window.",
        fromHeader: "values from the log header", fromLogN: "values from log", fromCli: "values from the CLI dump",
        fromOldCli: "values from a CLI dump that does not agree with the log", fromFlights: "gains from the flights",
        fromAdjustment: "values from an in-flight adjustment", fromNone: "values unknown",
        rateUnknown: "Rate profile unknown"
    };

    // Plot colours: GraphConfig.PALETTE on the dark plot surface, as js/tuning_dialog.js
    var C = { roll: "#fb8072", pitch: "#8dd3c7", yaw: "#ffffb3", grey: "#d9d9d9", blue: "#80b1d3", orange: "#fdb462", green: "#b3de69",
        purple: "#bc80bd", ref: "rgba(255,255,255,0.45)", limit: "#fb8072" };
    var STATUS_COLOR = { error: "#ff5a4f", problem: "#c9483f", monitor: "#d99a1f", insufficient: "#b0b0b0", information: "#3a7fc1",
        satisfactory: "#3c9d40", notMeasured: "#808080" };
    var PROFILE_COLOR = ["#606060", "#80b1d3", "#fdb462", "#b3de69", "#bc80bd", "#fccde5", "#ffed6f"]; // unknown, then PID profiles 1 to 6
    var CONFIG_COLOR = ["#e5c494", "#66c2a5", "#fc8d62", "#8da0cb", "#e78ac3", "#a6d854", "#ffd92f", "#b3b3b3"]; // configurations A, B, ... (again from the first after 8)
    var BG = "rgb(20,20,20)", INK = "rgba(255,255,255,0.85)", GRID = "rgba(255,255,255,0.12)", ACCENT = "#4da8da";

    // The text size of the canvases (SPEC3 C): the metrics of js/tuning_plot.js (k: 1.2 x the text scale of the views, font:
    // the 10 px font x k), the same at 100 % text without it
    function textMetrics() {
        return typeof TuningPlot !== "undefined" && TuningPlot.textMetrics ? TuningPlot.textMetrics() : { k: 1.2, font: "12px Verdana, Arial, sans-serif", row: 16 };
    }

    var CHARTS = [ // the strip charts; need: the fields without which a chart has nothing to show
        { key: "roll", name: "Roll", need: ["setpoint[0]", "gyroADC[0]"] }, { key: "pitch", name: "Pitch", need: ["setpoint[1]", "gyroADC[1]"] },
        { key: "yaw", name: "Yaw", need: ["setpoint[2]", "gyroADC[2]"] }, { key: "gov", name: "Headspeed", need: ["headspeed"] },
        { key: "tail", name: "Tail output", need: ["mixer[2]"] }, { key: "dterm", name: "D-term", need: ["axisD[0]", "axisD[1]", "axisD[2]"] }
    ];

    // ---------------------------------------------------------------------------------------------
    // Formatting

    function esc(text) {
        return String(text === undefined || text === null ? "" : text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function isNum(v) {
        return typeof v === "number" && isFinite(v);
    }

    function fmt(v, digits) {
        return isNum(v) ? String(+v.toPrecision(digits || 3)) : "";
    }

    function sec(t) {
        return isNum(t) ? t.toFixed(1) + " s" : "";
    }

    function pct(v, d) {
        return isNum(v) ? (v * 100).toFixed(d === undefined ? 1 : d) + " %" : "";
    }

    function degLimit(v) {
        return isNum(v) ? fmt(v) + " deg/s" : "";
    }

    function cap(s) {
        s = String(s || "");
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function quoted(text) {
        return text ? ' <span data-ste="quoted">' + esc(text) + "</span>" : "";
    }

    // "a", "a and b", "a, b and c"
    function and(list) {
        return list.length > 1 ? list.slice(0, -1).join(", ") + " and " + list[list.length - 1] : list.join("");
    }

    function plural(n, one, many) {
        return n + " " + (n === 1 ? one : many);
    }

    function message(e) {
        return String(e && e.message || e || "");
    }

    // An error of runAnalysis as HTML (js/tuning_dialog.js jobError: reason "start" (no run), "failed" (the worker),
    // "canceled"): our sentence, then the message that is not ours, quoted. Another error: its text when it is one of ours
    function runErrorHtml(e) {
        var reason = e && e.reason, m = message(e), detail = e && e.detail ? String(e.detail) : "";
        if (reason === "canceled") return esc(TEXT.canceled);
        if (reason === "failed") return esc(TEXT.stopped) + quoted(detail || m);
        if (reason === "start") return esc(TEXT.startFailed) + (m && m !== TEXT.startFailed ? " " + esc(m) : "") + quoted(detail);
        return Object.keys(TEXT).some(function (k) { return TEXT[k] === m; }) ? esc(m) : esc(TEXT.startFailed) + quoted(m);
    }

    // The rows of an evidence table (header keys and values, from the log): in code font, as they are
    function tableHtml(rows) {
        var list = Array.isArray(rows) ? rows.filter(function (q) { return q && typeof q === "object"; }) : [];
        if (!list.length) return '<p class="log-lens-muted">' + esc(TEXT.noTable) + "</p>";
        var cols = Array.isArray(list[0]) ? null : Object.keys(list[0]);
        return '<table class="log-lens-table">' + (cols ? "<thead><tr>" + cols.map(function (c) { return "<th><code>" + esc(c) + "</code></th>"; }).join("") + "</tr></thead>" : "") +
            "<tbody>" + list.map(function (row) {
                return "<tr>" + (cols ? cols.map(function (c) { return row[c]; }) : row).map(function (v) { return "<td><code>" + esc(v) + "</code></td>"; }).join("") + "</tr>";
            }).join("") + "</tbody></table>";
    }

    // value ± SE to the second significant digit of the SE; a fraction as %
    function valueSe(v, se, unit) {
        if (!isNum(v)) return v === null || v === undefined ? "" : String(v);
        var k = unit === "fraction" ? 100 : 1, u = unit === "fraction" ? "%" : unit || "", s;
        if (isNum(se) && se > 0) {
            var d = Math.max(0, Math.min(6, 1 - Math.floor(Math.log10(se * k))));
            s = (v * k).toFixed(d) + " ± " + (se * k).toFixed(d);
        } else {
            s = String(+(v * k).toPrecision(4));
        }
        return u ? s + " " + u : s;
    }

    // A threshold as the toolkit gives it: text, a number or a RULES entry
    function limitText(t) {
        if (t && typeof t === "object" && !Array.isArray(t)) {
            return Object.keys(t).filter(function (k) { return k !== "source"; }).map(function (k) { return k + " " + t[k]; }).join(", ");
        }
        return t === null || t === undefined ? "" : String(t);
    }

    // The worker's display of a finding (catalog.cjs display(): { value, bound, limit, unit, scale, profile, phase }), or null
    function displayOf(f) {
        return f && f.display && typeof f.display === "object" ? f.display : null;
    }

    // The limit of a finding: { text, code }. display.bound (the limit in the unit of the value, the same in log and file
    // scope), else display.limit (an STE sentence), else the threshold of the toolkit (not STE: code font); null for none
    function limitOf(f) {
        var d = displayOf(f), t;
        if (d && typeof d.bound === "string" && d.bound.trim()) return { text: d.bound, code: false };
        if (d && typeof d.limit === "string" && d.limit.trim()) return { text: d.limit, code: false };
        t = limitText(f && f.threshold);
        return t ? { text: t, code: true } : null;
    }

    // The value of a finding as text: display.value (STE, in the unit of the rule), else the value of the toolkit with its
    // unit. null for none: a display with no value gives no value
    function valueOf(f) {
        var d = displayOf(f);
        if (d) return typeof d.value === "string" && d.value.trim() ? d.value : null;
        return isNum(f.value) ? valueSe(f.value, f.se, f.unit) : null;
    }

    // Natural order of check ids: G2 before G10
    function compareIds(a, b) {
        var x = /^(\D*)(\d*)(.*)$/.exec(String(a)), y = /^(\D*)(\d*)(.*)$/.exec(String(b));
        if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
        if (x[2] !== y[2]) return (x[2] === "" ? -1 : +x[2]) - (y[2] === "" ? -1 : +y[2]);
        return x[3] < y[3] ? -1 : x[3] > y[3] ? 1 : 0;
    }

    // ---------------------------------------------------------------------------------------------
    // The window, the results in it and its values (pure, for test/log_lens.test.cjs)

    // [t0, t1] moved inside [0, len], its width kept in [MIN_S, MAX_S] (and len or less)
    function clampWindow(t0, t1, len) {
        var w = Math.min(Math.max(t1 - t0, Math.min(MIN_S, len)), Math.min(MAX_S, len)), a = (t0 + t1) / 2 - w / 2;
        a = Math.min(Math.max(a, 0), Math.max(0, len - w));
        return [a, a + w];
    }

    // A wheel event in notches of a mouse wheel (100 px or 3 lines), one at most: a touchpad sends many small ones
    function wheelSteps(e) {
        var d = Math.abs(e.deltaX || 0) > Math.abs(e.deltaY || 0) ? e.deltaX : e.deltaY || 0;
        d *= e.deltaMode === 1 ? 100 / 3 : e.deltaMode === 2 ? 100 : 1;
        return Math.max(-1, Math.min(1, d / 100));
    }

    // The status of a finding (SPEC2 D9): the worker's (tools/autotune/catalog.cjs status()), else the Tuning view's
    // rule (js/tuning_dialog.js findingStatus), else from the severity only
    function statusOf(f) {
        if (typeof f.status === "string" && STATUS.hasOwnProperty(f.status)) return f.status;
        var K = kit();
        if (K && typeof K.findingStatus === "function") return K.findingStatus(f);
        switch (f.severity) {
            case "error": return "error";
            case "skipped": return "notMeasured";
            case "flag": return f.explained ? "information" : "problem";
            case "ok": return "satisfactory";
            case "note": return f.thin === true || /^no finding/i.test(String(f.text || "")) ? "insufficient" : "monitor";
            default: return "information";
        }
    }

    // The PID profile of a finding as the Configurator counts them (SPEC2 D12): 1 to 6; 0 when it is not known; null when
    // the finding is of all the profiles. One label for each row, as js/tuning_dialog.js profileNo: the worker's
    // pidProfile (it sets one only when it knows the PID profile, null when it does not), then the label of the worker's
    // summary (display.profile), then the label of the toolkit (catalog.cjs profileOf: 0, "arm" and "unknown" are not
    // known). Never a PID profile next to a summary that says "PID profile unknown"
    function profileOf(f) {
        if (!f) return null;
        var d = f.display && typeof f.display === "object" && "profile" in f.display ? f.display.profile : undefined, m,
            said = typeof d === "string" ? ((m = /^PID profile ([1-9]\d*)$/.exec(d)) ? +m[1] : 0) : d === null ? null : undefined;
        if (isNum(f.pidProfile) && f.pidProfile > 0) return said === 0 ? 0 : f.pidProfile;
        if (NO_LOG_PROFILE[f.id]) return null;
        var p = f.profile, q = typeof p === "string" && /^\d+$/.test(p) ? +p : p,
            own = said !== undefined ? said : isNum(q) ? (q > 0 ? q : 0) : p === "arm" || p === "unknown" ? 0 : null;
        return f.pidProfile === null && own !== null ? 0 : own;
    }

    function profileText(q) {
        return q === null || q === undefined ? TEXT.allProfiles : q > 0 ? "PID profile " + q : TEXT.unknownProfile;
    }

    // The pure parts of js/tuning_dialog.js (curvePath, curveSeries, derivedSeries, compareSpec, toFrame), or null
    function kit() {
        return typeof TuningDialog !== "undefined" && TuningDialog && TuningDialog.internals && typeof TuningDialog.internals.compareSpec === "function" ? TuningDialog.internals : null;
    }

    // Index time (the modules and curves) to frame seconds, through the time map of a record (js/tuning_dialog.js toFrame)
    function toFrame(tm, t) {
        var K = kit();
        return K && typeof K.toFrame === "function" ? K.toFrame(tm, t) : t;
    }

    function recordsOf(r, li) {
        return r && Array.isArray(r.records) ? r.records.filter(function (q) { return q && q.log === li; }) : [];
    }

    // The flight phases of log li (SPEC2 D13: records[].phases, the spans in frame seconds, or { spans }; spans in index
    // samples i0, i1 go through the time map of their record): [{ phase, t0, t1 }] in time order
    function phasesOf(r, li) {
        var out = [];
        recordsOf(r, li).forEach(function (rec) {
            var ph = rec.phases, rate = rec.actualRate || rec.rate;
            (Array.isArray(ph) ? ph : ph && Array.isArray(ph.spans) ? ph.spans : []).forEach(function (s) {
                if (!s || !PHASES[s.phase]) return;
                var t0 = s.t0, t1 = s.t1;
                if (!isNum(t0) && isNum(s.i0) && isNum(s.i1) && isNum(rec.fromS) && rate > 0) {
                    t0 = toFrame(rec.timeMap, rec.fromS + s.i0 / rate);
                    t1 = toFrame(rec.timeMap, rec.fromS + s.i1 / rate);
                }
                if (isNum(t0) && isNum(t1) && t1 > t0) out.push({ phase: s.phase, t0: t0, t1: t1 });
            });
        });
        return out.sort(function (a, b) { return a.t0 - b.t0; });
    }

    // The flights of log li, liftoff to touchdown: result.flights (SPEC2 D13), else the flight phases. [{ t0, t1, seconds }]
    function flightsOf(r, li) {
        var list = r && Array.isArray(r.flights) ? r.flights.filter(function (q) { return q && q.log === li && isNum(q.t0) && isNum(q.t1) && q.t1 > q.t0; }) : [];
        if (!list.length) list = phasesOf(r, li).filter(function (p) { return p.phase === "flight"; });
        return list.map(function (q) { return { t0: q.t0, t1: q.t1, seconds: q.t1 - q.t0 }; }).sort(function (a, b) { return a.t0 - b.t0; });
    }

    // Log li is a bench run (SPEC2 D13 CORRECTION: no flight): in result.benchRuns, or its records say so (logClass "bench",
    // or phases with flight false)
    function benchOf(r, li) {
        if (r && Array.isArray(r.benchRuns) && r.benchRuns.some(function (q) { return (isNum(q) ? q : q && q.log) === li; })) return true;
        var recs = recordsOf(r, li).filter(function (q) { return q.logClass === "bench" || q.logClass === "flight" || (q.phases && typeof q.phases.flight === "boolean"); });
        return recs.length > 0 && recs.every(function (q) { return q.logClass === "bench" || (q.logClass !== "flight" && q.phases.flight === false); });
    }

    // The PID profile spans of log li in frame seconds (records[].profiles.pid, the profile of the stretch before the first
    // switch as the worker found it): [{ t0, t1, p }], or [] when the result does not have them
    function profileSpansOf(r, li) {
        var out = [];
        recordsOf(r, li).forEach(function (rec) {
            var list = rec.profiles && Array.isArray(rec.profiles.pid) ? rec.profiles.pid : [];
            list.forEach(function (q) {
                var p = q && (typeof q.profile === "string" && /^\d+$/.test(q.profile) ? +q.profile : q.profile);
                if (q && isNum(q.t0) && isNum(q.t1) && q.t1 > q.t0) out.push({ t0: q.t0, t1: q.t1, p: isNum(p) && p > 0 ? p : 0 });
            });
        });
        return out.sort(function (a, b) { return a.t0 - b.t0; });
    }

    // The PID profile at the start of log li as the worker found it (records[].profiles.arming, else result.profiles.arming[]
    // of that log: { profile (0: unknown), basis, confirmed, headspeed }), or null when the result does not have it
    function armingOf(r, li) {
        var rec = recordsOf(r, li).filter(function (q) { return q.profiles && q.profiles.arming && typeof q.profiles.arming === "object"; })[0];
        if (rec) return rec.profiles.arming;
        var list = r && r.profiles && Array.isArray(r.profiles.arming) ? r.profiles.arming : [];
        return list.filter(function (q) { return q && q.log === li; })[0] || null;
    }

    // The PID profile at the start of the log and how the worker found it (js/tuning_worker.js armingFinal, basis), as HTML in
    // STE: "Start of the log: PID profile 1." For the basis "headspeed": the "govRequest" value at the start, and the PID profile
    // changes of the file (log scope: of the log) that show this value for this PID profile only. "" without a = null
    function startHtml(a, scope) {
        if (!a || typeof a !== "object") return "";
        var p = isNum(+a.profile) && +a.profile > 0 && a.confirmed !== false ? +a.profile : 0, b = Array.isArray(a.basis) ? a.basis : [], h = a.headspeed,
            out = [esc(TEXT.startOf + " " + profileText(p) + ".")];
        if (!p) return out[0];
        if (b.indexOf("headspeed") >= 0 && h && isNum(h.headspeed)) {
            var o = h.observations || {};
            out.push("At the start, <code>govRequest</code> is " + esc(h.headspeed) + " rpm.");
            out.push(esc("In this " + (scope === "file" || scope === "flights" ? "file" : "log") + ", only " + profileText(p) + " has this value after a PID profile change" +
                (isNum(o.switches) && isNum(o.logs) ? " (" + plural(o.switches, "change", "changes") + " in " + plural(o.logs, "log", "logs") + ")" : "") + "."));
        } else if (b.indexOf("event") >= 0) {
            out.push(esc("A log event at the start of the log gives this PID profile."));
        } else if (b.indexOf("cli") >= 0) {
            out.push(esc("Only this PID profile of the CLI dump has the same values as the log header."));
        } else if (b.indexOf("cliTarget") >= 0) {
            out.push("Only this PID profile of the CLI dump has the headspeed of <code>govTarget</code> at the start.");
        }
        return out.join(" ");
    }

    // The RPM notch filters (health_setup.cjs decodeNotchSource): the kind of a filter from its source code, else from the label
    // of the curves ("tail rotor 1x"). null: not known
    var NOTCH_KIND = [[10, 10, "motor"], [11, 18, "main rotor"], [20, 20, "tail motor"], [21, 28, "tail rotor"]];
    function notchKind(q) {
        var c = q && q.code, m;
        for (var i = 0; isNum(c) && i < NOTCH_KIND.length; i++) if (c >= NOTCH_KIND[i][0] && c <= NOTCH_KIND[i][1]) return NOTCH_KIND[i][2];
        m = /^(main motor|main rotor|tail motor|tail rotor)\b/.exec(String(q && q.label || ""));
        return m ? (m[1] === "main motor" ? "motor" : m[1]) : null;
    }

    // The part of result.notchFit (js/tuning_worker.js notchFitOut) that gives the frequency of the notch filters of a kind: the
    // tail rotor or the motor fit when it passed and the checks use it (used), else null. Its order is of the log, not of the header
    function notchFitOf(fit, kind) {
        var g = fit && fit.used ? (kind === "tail rotor" ? fit.tail : kind === "motor" ? fit.motor : null) : null;
        return g && g.passed && isNum(g.order) ? g : null;
    }

    // The RPM notch filters of axis a in the vibration curves v of a log (health_more.cjs curves: vib.notches and
    // vib.byProfile[p].notches, [{ code, q, order, hz, label }] at the median headspeed), at the rotor frequency rotorHz of the
    // window when it is known: order x rotorHz (hz = order x headspeed / 60 in the curves). Without an order, hz scaled by the
    // rotor frequency of the PID profile. The curves label the time before the first PID profile change 0 when the records have
    // the PID profile that the analysis found (by and v.rotorHz[p] are then not there): thus the order first. fit: result.notchFit.
    // -> { list: [{ hz, q, label, kind, fit }] (fit: the part of notchFit that gives the frequency, else null), unknown: [kind] (the
    // kinds of the filters with no frequency, "" for a kind not known) }
    function notchSet(v, p, a, rotorHz, fit) {
        var by = v && v.byProfile && v.byProfile[p], list = ((by && by.notches) || (v && v.notches) || {})[a] || [], live = isNum(rotorHz) && rotorHz > 0,
            ref = by && isNum(by.rotorHz) ? by.rotorHz : v && isNum(v.rotorHz) ? v.rotorHz : v && v.rotorHz && v.rotorHz[p],
            k = isNum(ref) && ref > 0 && live ? rotorHz / ref : 1, out = { list: [], unknown: [] };
        (Array.isArray(list) ? list : []).forEach(function (q) {
            if (!q) return;
            var kind = notchKind(q), hz = isNum(q.order) && q.order > 0 && live ? q.order * rotorHz : isNum(q.hz) ? q.hz * k : null;
            if (isNum(hz)) out.list.push({ hz: hz, q: q.q, label: q.label, kind: kind, fit: notchFitOf(fit, kind) });
            else if (out.unknown.indexOf(kind || "") < 0) out.unknown.push(kind || "");
        });
        return out;
    }

    // The notch filters with no frequency (notchSet unknown): "The log does not show the frequency of the tail rotor notch filters."
    function unknownNotchText(kinds) {
        var named = (kinds || []).filter(Boolean);
        return "The log does not show the frequency of " + (named.length && named.length === kinds.length ? "the " + and(named) : "some") + " notch filters.";
    }

    // The kinds of the notch filters in `list` whose frequency comes from the fit of the log, each once
    function fitKinds(list) {
        var out = [];
        (list || []).forEach(function (n) { if (n && n.fit && n.kind && out.indexOf(n.kind) < 0) out.push(n.kind); });
        return out;
    }

    // ---------------------------------------------------------------------------------------------
    // "Show the measurement" of a result: its evidence plot (evidence.cjs plot: kind, curve, snippet, reference), drawn
    // as js/tuning_dialog.js compareModel draws it, from the curves of the result, from the values of the check, or from a
    // raw span (io.reader().read, then io.derive). -> Promise of { spec, missed, note } | { table } | { na, error }

    function fieldUnit(name) {
        var n = String(name);
        if (/^(setpoint\[[0-2]\]|gyroADC\[|gyroRAW\[)/.test(n)) return "deg/s";
        if (/^(mixer|axis[PIDFBO])\[/.test(n)) return "‰";
        if (/^servo\[/.test(n)) return "µs"; // js/flightlog_fields_presenter.js: servo pulses
        return /^(headspeed|govTarget)$/.test(n) ? "rpm" : null;
    }

    function evidenceCompare(f, r, io) {
        var ev = f && f.evidence, plot = ev && ev.plot, K = kit();
        if (!plot || typeof plot !== "object") return Promise.resolve({ na: TEXT.noEvidence });
        if (plot.kind === "table") {
            var rows = plot.rows || plot.table || [];
            return Promise.resolve(Array.isArray(rows) && rows.length ? { table: rows } : { na: TEXT.noTable });
        }
        if (!K) return Promise.resolve({ na: TEXT.noKit });
        var li = isNum(ev.log) ? ev.log : isNum(f.log) ? f.log : r && r.logIndex, logName = "log " + (isNum(li) ? li + 1 : "?"),
            title = TEXT.compareTitle + ": " + [f.id, axisOf(f), profileText(profileOf(f)), logName].filter(Boolean).join(", ");
        // a time plot of the curves for a result of one PID profile shows the periods of that PID profile only (V10)
        function ready(got, note) {
            var out = K.compareSpec(f, ev, got, title, { periods: profileSpansOf(r, li) });
            return { spec: out.spec, missed: out.missed || [], note: note, only: out.onlyText || "" };
        }
        var points = Array.isArray(plot.points) ? plot.points.filter(function (q) { return q && isNum(q.t) && isNum(q.value); }) : [];
        if (plot.kind === "events" && points.length > 1) {
            return Promise.resolve(ready({ x: points.map(function (q) { return q.t; }), xs: "t", series: [{ key: "value", name: [f.id, axisOf(f)].filter(Boolean).join(" "),
                y: points.map(function (q) { return q.value; }), unit: f.unit && f.unit !== "fraction" ? String(f.unit) : null, points: true }] }, "the values of the check in " + logName));
        }
        if (plot.curve) {
            var curve = (r && Array.isArray(r.curves) ? r.curves : []).filter(function (c) { return c && c.log === li; })
                .sort(function (a, b) { return (b.seconds || 0) - (a.seconds || 0); })[0], got = curve ? K.curveSeries(K.curvePath(curve, plot.curve), plot.kind) : null;
            if (got) {
                if (got.xs === "t") {
                    var rec = recordsOf(r, li).filter(function (q) { return q.segment === curve.segment; })[0] || recordsOf(r, li)[0], tm = rec && rec.timeMap;
                    got.x = Array.prototype.map.call(got.x, function (t) { return toFrame(tm, t); });
                }
                return Promise.resolve(ready(got, "the curves of " + logName));
            }
            // no data in the curves of the result: the raw span of the snippet, else why (the result can have no curves of this log)
            if (!plot.snippet) return Promise.resolve({ na: typeof K.noCurveText === "function" ? K.noCurveText(r, li, !!curve) : TEXT.noCurve, noCurve: true });
        }
        var snip = plot.snippet, spans = (Array.isArray(ev.spans) ? ev.spans : []).filter(function (s) { return s && isNum(s.t0) && isNum(s.t1); }),
            sp = spans[0] || (ev.view && isNum(ev.view.t0) && isNum(ev.view.t1) ? ev.view : null), rd = io && io.reader ? io.reader() : null;
        if (!snip || !Array.isArray(snip.fields) || !snip.fields.length || !sp) return Promise.resolve({ na: TEXT.noEvidence });
        if (!rd) return Promise.resolve({ na: TEXT.noReader });
        var at = isNum(sp.log) ? sp.log : li, t0 = Math.min(sp.t0, sp.t1), t1 = Math.max(sp.t0, sp.t1), mid = ev.view && isNum(ev.view.at) ? ev.view.at : (t0 + t1) / 2;
        if (t1 - t0 > COMPARE_S) {
            t0 = Math.max(t0, Math.min(mid - COMPARE_S / 2, t1 - COMPARE_S));
            t1 = t0 + COMPARE_S;
        }
        return Promise.resolve().then(function () { return rd.read(at, t0, t1, snip.fields); }).then(function (data) {
            if (!data || !data.t || !data.t.length) return { na: TEXT.noRead };
            var d = snip.derive;
            return (d && d.kind ? io.derive(d.kind, data.cols, data.rate, d.params || {}) : Promise.resolve(null)).then(function (out) {
                var got = out ? K.derivedSeries(out, data, plot.kind) : { x: data.t, xs: "t", series: Object.keys(data.cols || {}).map(function (k) {
                    return { key: k, name: k, y: data.cols[k], unit: fieldUnit(k) }; }) };
                if (!got || !got.series.length) return { na: TEXT.noValues };
                var res = ready(got, "log " + (at + 1) + ", " + fmt(data.t[0], 4) + " s to " + fmt(data.t[data.t.length - 1], 4) + " s");
                res.missing = data.missing && data.missing.length ? data.missing.slice() : [];
                return res;
            });
        }).catch(function (e) {
            return { na: TEXT.noValues, error: e };
        });
    }

    function spanLog(s, f) {
        return isNum(s.log) ? s.log : f.evidence && isNum(f.evidence.log) ? f.evidence.log : f.log;
    }

    // The evidence spans of log li (frame seconds), with the status of their result: [{ t0, t1, status, f }]
    function spansOf(findings, li) {
        var out = [];
        (findings || []).forEach(function (f) {
            var ev = f && f.evidence;
            if (!ev || !Array.isArray(ev.spans)) return;
            ev.spans.forEach(function (s) {
                if (s && isNum(s.t0) && isNum(s.t1) && spanLog(s, f) === li) out.push({ t0: Math.min(s.t0, s.t1), t1: Math.max(s.t0, s.t1), status: statusOf(f), f: f, label: s.label,
                    pidProfile: isNum(s.pidProfile) && s.pidProfile > 0 ? s.pidProfile : null }); // evidence.cjs: the PID profile of the span
            });
        });
        return out;
    }

    // The results with an evidence span of log li that overlaps [t0, t1]: [{ f, spans, status }], the worst first
    function overlapping(findings, li, t0, t1) {
        var by = [], index = new Map();
        spansOf(findings, li).forEach(function (s) {
            if (s.t1 < t0 || s.t0 > t1) return;
            if (!index.has(s.f)) { index.set(s.f, by.length); by.push({ f: s.f, spans: [], status: s.status }); }
            by[index.get(s.f)].spans.push(s);
        });
        return by.sort(function (a, b) {
            return STATUS[a.status][1] - STATUS[b.status][1] || compareIds(a.f.id, b.f.id) || a.spans[0].t0 - b.spans[0].t0;
        });
    }

    function axisOf(f) {
        return AXES.indexOf(f.axis) >= 0 ? f.axis : /^T\d+$/.test(String(f.id)) ? "yaw" : null;
    }

    // The strip chart that shows a result: its axis, the governor, the tail output or the D-term
    function chartOf(f) {
        var id = String(f.id);
        if (/^G\d+$/.test(id) || /^L[127]$/.test(id) || id === "D5") return "gov";
        if (/^(T8|T13|T14|T15|L4)$/.test(id) || (id === "L5" && f.axis === "yaw")) return "tail";
        if (id === "C11" || id === "F10") return "dterm";
        return axisOf(f);
    }

    // The plot of "Show" that compares a result with its limit, or null
    function detailKeyOf(f) {
        var id = String(f.id), a = axisOf(f) || "roll";
        if (/^(C12|C13|T11|T12)$/.test(id)) return "track:" + a;
        if (/^(C5|T1)$/.test(id)) return "osc:" + a;
        if (/^G[2-6]$|^G9$|^G19$|^L[17]$/.test(id)) return "gov";
        if (id === "T8" || id === "T15" || id === "L4") return "tail";
        if (id === "C11" || id === "F10") return "dterm:" + a;
        if (/^(F5|F6|G12)$/.test(id)) return "lines:" + a;
        return null;
    }

    // A value in its unit, as a value or as a limit (no decimals): "34.0 %" and "30 %"
    function inUnit(v, unit, asLimit) {
        if (!isNum(v)) return "";
        if (unit === "fraction") return pct(v, asLimit ? 0 : 1);
        if (unit === "deg/s") return (asLimit ? fmt(v) : v.toFixed(1)) + " deg/s";
        if (unit === "s") return v.toFixed(2) + " s";
        return fmt(v) + (unit ? " " + unit : "");
    }

    // A value against its limits (ascending): [status, STE text]. One window has no standard error, so a value more
    // than a limit is "monitor", never "problem" (js/tuning_worker.js windowStats)
    function against(v, limits, show) {
        var over = limits.filter(function (q) { return v > q; }).length;
        return over ? ["monitor", "More than " + show(limits[over - 1])] : ["satisfactory", show(limits[0]) + " or less"];
    }

    // The rows of "Values in this time window" from the items of derive("window") (js/tuning_worker.js windowStats):
    //   { key: "track.roll" | "osc.roll" | "gov.error" | "tail.limit" | "dterm.roll" | "lines.roll", check, axis, value,
    //     unit, limits: [{ value }], status, n, detail, text }
    // Row: { key (the plot of "Show"), what, value, limit, check, status (SPEC2 D9 key), levelText, note }. An item that is
    // not measured, or has not sufficient data, gives its status and the text of the worker.
    // notch: the notch filters of the result for the gyro lines, { roll|pitch|yaw: notchSet() } (an axis that is not there: the
    // result does not give them for this log), null or undefined without a result. The worker gives the distance of each line
    // to the filters with a frequency (params notchHz). With a result, a strong line with no filter at 2 % or less is "Monitor",
    // as check F5 counts it. When the axis also has filters with no frequency (the tail rotor filters without the fit of the log),
    // such a line is "Information": the filter that the log does not show can be at the line
    function windowRows(d, notch) {
        var rows = [];
        (d && Array.isArray(d.items) ? d.items : []).forEach(function (it) {
            if (!it || typeof it.key !== "string") return;
            var p = it.key.split("."), kind = p[0], a = it.axis || p[1] || "", det = it.detail || {}, unit = it.unit, band = det.band,
                key = kind === "gov" ? "gov" : kind === "tail" ? "tail" : kind + ":" + a,
                limits = (it.limits || []).map(function (q) { return q && q.value; }).filter(isNum).sort(function (x, y) { return x - y; }),
                show = function (v) { return inUnit(v, unit, true); };
            // worker: the note is the text of the worker (STE, linted at its source), else ours
            function row(what, value, limit, cmp, note, worker) {
                var gone = it.status === "notMeasured" || it.status === "insufficient" || !cmp;
                rows.push({ key: key, what: what, check: String(it.check || ""), value: gone ? "" : value, limit: limit,
                    status: gone ? (it.status === "notMeasured" ? "notMeasured" : "insufficient") : cmp[0],
                    levelText: gone ? STATUS[it.status === "notMeasured" ? "notMeasured" : "insufficient"][0] : cmp[1],
                    note: gone ? String(it.text || "") : note || "", worker: gone || !!worker });
            }
            var measured = isNum(it.value);
            if (kind === "track") {
                row("Tracking error, " + a, inUnit(it.value, unit), limits.map(show).join(" and "), measured && limits.length ? against(it.value, limits, show) : null,
                    [isNum(det.tauMs) ? "Time delay: " + fmt(det.tauMs) + " ms." : "", isNum(det.seconds) ? "Data: " + sec(det.seconds) + "." : ""].join(" ").trim());
            } else if (kind === "osc") {
                row("Oscillation, " + a + (Array.isArray(band) ? ", " + band[0] + "-" + band[1] + " Hz" : ""), inUnit(it.value, unit), limits.map(show).join(" and "),
                    measured && limits.length ? against(it.value, limits, show) : null, isNum(det.hz) ? "At " + fmt(det.hz) + " Hz." : "");
            } else if (kind === "dterm") {
                row("D-term power at more than " + (isNum(det.hz) ? det.hz : 30) + " Hz, " + a, inUnit(it.value, unit), limits.map(show).join(" and "),
                    measured && limits.length ? against(it.value, limits, show) : null, "");
            } else if (kind === "gov") { // two limits of two quantities: the median error, and the error of 90 % of the samples
                var lim = it.limits || [], m = det.median, spread = isNum(det.p5) && isNum(det.p95) ? Math.max(-det.p5, det.p95) : null,
                    lm = lim[0] && isNum(lim[0].value) ? [lim[0].value] : [], ls = lim[1] && isNum(lim[1].value) ? [lim[1].value] : [];
                row("Headspeed error, median", pct(m, 2), lm.map(show).join(""), isNum(m) && lm.length ? against(Math.abs(m), lm, show) : null,
                    det.reference === "median headspeed" ? "Reference: the median headspeed of the time window." : "");
                if (it.status !== "notMeasured" && it.status !== "insufficient") {
                    row("Headspeed error, 90 % of the samples", pct(det.p5, 2) + " to " + pct(det.p95, 2), ls.map(show).join(""), spread !== null && ls.length ? against(spread, ls, show) : null, "");
                }
            } else if (kind === "tail") {
                var n = isNum(it.n) ? it.n : isNum(det.periods) ? det.periods : 0, lo = det.lo, hi = det.hi;
                row("Time at the tail output limit", inUnit(it.value, "s") + " in " + n + (n === 1 ? " period" : " periods"), "1 period",
                    measured ? (n >= LIMITS.tail ? ["monitor", "1 period or more"] : ["satisfactory", "Less than 1 period"]) : null,
                    isNum(lo) || isNum(hi) ? "Limits: " + [lo, hi].filter(isNum).map(function (v) { return fmt(v, 4) + " ‰"; }).join(" and ") + "." : "");
            } else if (kind === "lines") {
                var lines = Array.isArray(det.lines) ? det.lines.filter(function (q) { return q && isNum(q.hz); }) : [], strong = lines.filter(function (q) { return q.prominence >= LIMITS.line; }),
                    known = strong.filter(function (q) { return q.notch && isNum(q.notch.distance); }), open = known.filter(function (q) { return q.notch.distance > LIMITS.lineNotch; }),
                    set = notch ? notch[a] || null : null, bare = strong.length - known.length, // bare: strong lines with no distance (no filter with a frequency)
                    gap = set && set.unknown.length && (open.length || bare) ? set.unknown : null,
                    near = set ? set.list.filter(function (n) { return strong.some(function (q) { return q.notch && q.notch.distance <= LIMITS.lineNotch && Math.abs(q.notch.hz - n.hz) < 1e-6; }); }) : [];
                var cmp = !lines.length ? ["information", ""] : !strong.length ? ["information", "Prominence less than " + LIMITS.line] : gap ? ["information", TEXT.notchUnknown] :
                    open.length || (set && bare) ? ["monitor", "No notch filter at 2 % or less"] :
                    known.length === strong.length ? ["satisfactory", "Notch filter at 2 % or less"] : ["information", "Prominence " + LIMITS.line + " or more"];
                row("Gyro lines, " + a, lines.length ? fmt(lines[0].hz, 4) + " Hz, " + inUnit(lines[0].amplitude, "deg/s") : "", "Prominence " + LIMITS.line, cmp,
                    lines.length ? "Lines: " + lines.map(function (q) { return fmt(q.hz, 4) + " Hz" + (isNum(q.order) ? " (" + q.order.toFixed(2) + " × the rotor frequency)" : ""); }).join(", ") + "." +
                        (bare && !set ? " " + (notch ? TEXT.noNotchData : TEXT.notches) : "") + (gap ? " " + unknownNotchText(gap) : "") +
                        (fitKinds(near).length ? " The frequency of the " + and(fitKinds(near)) + " notch filters comes from the log." : "") : String(it.text || ""), !lines.length);
            }
        });
        return rows;
    }

    // Welch size for n samples: a power of two, n / 4 or less, from 64 to 4096
    function fftSize(n) {
        var N = 64;
        while (N * 2 <= n / 4 && N < 4096) N *= 2;
        return N;
    }

    function median(a) {
        var v = [];
        for (var i = 0; a && i < a.length; i++) if (isNum(a[i])) v.push(a[i]);
        v.sort(function (x, y) { return x - y; });
        return v.length ? v[v.length >> 1] : null;
    }

    // The columns of a derive result (js/tuning_worker.js DERIVE): { cols } of a filter, { f, psd, amplitude } of a spectrum
    function colsOf(r) {
        return r && typeof r === "object" ? r.cols || r.psd || {} : {};
    }

    function freqOf(r) {
        return r && r.f || null;
    }

    // sqrt(2) rms over a centred window of m samples: the amplitude of C5 and T1 (health_track.cjs amp)
    function amplitude(x, m) {
        var n = x.length, P = new Float64Array(n + 1), out = new Float32Array(n), h = Math.max(1, m >> 1);
        for (var i = 0; i < n; i++) P[i + 1] = P[i] + (isNum(x[i]) ? x[i] * x[i] : 0);
        for (i = 0; i < n; i++) {
            var j0 = Math.max(0, i - h), j1 = Math.min(n, i + h);
            out[i] = Math.sqrt(2 * (P[j1] - P[j0]) / Math.max(1, j1 - j0));
        }
        return out;
    }

    function line(name, x, y, color, width, dash) {
        return { name: name, x: x, y: y, color: color, width: width || 1.5, dash: dash || [] };
    }

    function finish(spec) {
        spec.series = spec.series.filter(function (s) { return s.x && s.y && s.y.length > 1; });
        spec.legend = spec.series.length > 1;
        return spec;
    }

    // A strip chart of the window: snap = { t, cols } of TuningSnippet.Reader; ctx: { win, last (the chart with the time
    // axis title), tailLimits, bands(key) }
    function chartSpec(key, snap, ctx) {
        var t = snap.t, c = snap.cols || {}, k = AXES.indexOf(key), spec;
        if (k >= 0) {
            var s = c["setpoint[" + k + "]"], g = c["gyroADC[" + k + "]"], e = null;
            if (s && g) {
                e = new Float32Array(s.length);
                for (var i = 0; i < s.length; i++) e[i] = s[i] - g[i];
            }
            spec = { title: cap(key) + ": setpoint, gyro and error", y: { label: "rate", unit: "deg/s" },
                series: [line("setpoint", t, s, C.grey, 1), line("gyro", t, g, C[key]), line("error", t, e, C.blue, 1)] };
        } else if (key === "gov") {
            spec = { title: "Headspeed and governor target", y: { label: "headspeed", unit: "rpm" },
                series: [line("headspeed", t, c.headspeed, C.orange), line("governor target", t, c.govTarget, C.blue, 1.5, [4, 3])] };
        } else if (key === "tail") {
            var lim = ctx.tailLimits || {};
            spec = { title: "Tail output (mixer[2]) and its limits", y: { label: "output", unit: "‰" }, series: [line("mixer[2]", t, c["mixer[2]"], C.yaw)],
                hlines: ["lo", "hi"].filter(function (q) { return isNum(lim[q]); }).map(function (q) {
                    return { y: lim[q], color: C.limit, label: "limit " + fmt(lim[q], 4) + " ‰", dash: [5, 3] };
                }) };
        } else {
            spec = { title: "D-term (axisD)", y: { label: "D-term", unit: "‰" },
                series: AXES.map(function (a, j) { return line(a, t, c["axisD[" + j + "]"], C[a], 1); }) };
        }
        spec.x = key === ctx.last ? { label: "time", unit: "s", min: ctx.win[0], max: ctx.win[1] } : { min: ctx.win[0], max: ctx.win[1] };
        spec.bands = ctx.bands ? ctx.bands(key) : [];
        return finish(spec);
    }

    // ---------------------------------------------------------------------------------------------
    // "Show": the plot of one value of the window. A builder gets env = { t, rate, col(name), derive(kind, cols, params),
    // values, tau(axis), tailLimits, notches(axis), rotorHz, bands(key), x } and returns a Promise of
    // { specs: [TuningPlot spec], text: STE caption } or { na: reason }

    var DETAILS = {
        track: function (a, env) {
            var k = AXES.indexOf(a), s = env.col("setpoint[" + k + "]"), g = env.col("gyroADC[" + k + "]"), check = CHECKS.track[k];
            if (!s || !g) return Promise.resolve({ na: TEXT.notInLog });
            return env.derive("lowpass", { setpoint: s, gyro: g }, { hz: 30 }).then(function (r) {
                var c = colsOf(r), sl = c.setpoint, gl = c.gyro, tau = env.tau(a) || 0, lag = Math.max(0, Math.round(tau * env.rate / 1000));
                if (!sl || !gl) return { na: TEXT.noValues };
                var n = sl.length, gs = new Float32Array(n), e = new Float32Array(n), lo = new Float32Array(n), hi = new Float32Array(n), w = env.inner(sl), ss = 0, m = 0,
                    lim = LIMITS.track.map(function (v) { return pct(v, 0); });
                for (var i = 0; i < w.length; i++) if (isNum(w[i])) { ss += w[i] * w[i]; m++; }
                var band = LIMITS.track[1] * Math.sqrt(ss / Math.max(1, m)); // of the setpoint RMS in the window
                for (i = 0; i < n; i++) {
                    gs[i] = i + lag < n ? gl[i + lag] : NaN;
                    e[i] = sl[i] - gs[i];
                    lo[i] = sl[i] - band;
                    hi[i] = sl[i] + band;
                }
                var sp = line("setpoint, band of ± " + lim[1] + " of its RMS", env.t, sl, C.grey, 1);
                sp.lo = lo;
                sp.hi = hi;
                return { specs: [finish({ title: "Tracking error, " + a + ": setpoint and gyro after a low-pass filter at 30 Hz", x: env.x,
                    y: { label: "rate", unit: "deg/s" }, bands: env.bands("track:" + a),
                    series: [sp, line("gyro, time delay of " + fmt(tau) + " ms removed", env.t, gs, C[a]), line("error", env.t, e, C.blue, 1)] })],
                    text: "The plot shows the setpoint and the gyro after a low-pass filter at 30 Hz. The plot removes a time delay of " + fmt(tau) +
                        " ms from the gyro. The band shows " + lim[1] + " of the RMS of the setpoint on each side of the setpoint. Check " + check +
                        " compares the RMS of the error with " + lim[0] + " and " + lim[1] + " of the RMS of the setpoint." };
            });
        },
        osc: function (a, env) {
            var k = AXES.indexOf(a), s = env.col("setpoint[" + k + "]"), g = env.col("gyroADC[" + k + "]"), check = CHECKS.osc[k],
                q = env.item("osc." + a), band = q && q.detail && Array.isArray(q.detail.band) ? q.detail.band : OSC_BANDS[a];
            if (!s || !g) return Promise.resolve({ na: TEXT.notInLog });
            var e = new Float32Array(s.length);
            for (var i = 0; i < s.length; i++) e[i] = g[i] - s[i]; // the error of health_track.cjs oscillation()
            var ei = env.inner(e);
            return Promise.all([env.derive("bandpass", { error: e }, { lo: band[0], hi: band[1] }),
                env.derive("spectrum", { error: ei }, { N: fftSize(ei.length) }).catch(function () { return null; })]).then(function (r) {
                var be = colsOf(r[0]).error, f = freqOf(r[1]), psd = colsOf(r[1]).error, at = band[0] + "-" + band[1] + " Hz";
                if (!be) return { na: TEXT.noValues };
                var specs = [finish({ title: "Oscillation, " + a + ": error in the " + at + " band", x: env.x, y: { label: "error", unit: "deg/s" },
                    bands: env.bands("osc:" + a), hlines: [{ y: LIMITS.osc, color: C.limit, label: "limit " + degLimit(LIMITS.osc), dash: [5, 3] }, { y: -LIMITS.osc, color: C.limit, dash: [5, 3] }],
                    series: [line("error, " + at, env.t, be, C[a], 1), line("amplitude, √2 RMS in 0.5 s", env.t, amplitude(be, Math.round(0.5 * env.rate)), C.orange)] })];
                if (f && psd) {
                    specs.push(finish({ title: "Error spectrum, " + a, x: { label: "frequency", unit: "Hz", min: 0, max: Math.min(100, env.rate / 2) },
                        y: { label: "PSD", log: true }, bands: [{ x0: band[0], x1: band[1], color: "rgba(253,180,98,0.14)", label: at }], series: [line("error", f, psd, C[a])] }));
                }
                return { specs: specs, text: "The plot shows the error in the " + at + " band. The amplitude line is `√2 × RMS` of the error in 0.5 s. Check " +
                    check + " compares the amplitude with " + degLimit(LIMITS.osc) + " when the pilot does not move the sticks." };
            });
        },
        gov: function (a, env) {
            var hs = env.col("headspeed"), tg = env.col("govTarget");
            if (!hs) return Promise.resolve({ na: TEXT.notInLog });
            var ref = tg && median(tg) > 0 ? null : median(hs), n = hs.length, e = new Float32Array(n), mag = [];
            for (var i = 0; i < n; i++) {
                var r = ref === null ? tg[i] : ref;
                e[i] = r > 0 ? (hs[i] - r) / r * 100 : NaN;
                if (isNum(e[i])) mag.push(Math.abs(e[i]));
            }
            mag.sort(function (x, y) { return x - y; });
            var span = Math.max(3, Math.ceil(1.2 * (mag.length ? mag[Math.floor(0.99 * (mag.length - 1))] : 0)));
            return Promise.resolve({ specs: [finish({ title: "Headspeed error from the " + (ref === null ? "governor target" : "median headspeed of the time window"), x: env.x,
                y: { label: "error", unit: "%", min: -span, max: span }, bands: env.bands("gov"),
                hlines: [-LIMITS.gov[1], -LIMITS.gov[0], LIMITS.gov[0], LIMITS.gov[1]].map(function (v) {
                    return { y: v * 100, color: C.ref, label: pct(Math.abs(v), 0), dash: Math.abs(v) === LIMITS.gov[0] ? [2, 3] : [5, 3] };
                }),
                series: [line("headspeed error", env.t, e, C.orange)] })],
                text: "The plot shows the headspeed error from the " + (ref === null ? "governor target." : "median headspeed. The log does not contain the governor target.") +
                    " Check G2 compares the median error with " + pct(LIMITS.gov[0], 0) + ". It also compares the errors of 90 % of the samples with " + pct(LIMITS.gov[1], 0) + "." });
        },
        tail: function (a, env) {
            var u = env.col("mixer[2]"), lim = env.tailLimits || {};
            if (!u) return Promise.resolve({ na: TEXT.notInLog });
            return Promise.resolve({ specs: [finish({ title: "Tail output (mixer[2]) and its limits", x: env.x, y: { label: "output", unit: "‰" }, bands: env.bands("tail"),
                hlines: ["lo", "hi"].filter(function (q) { return isNum(lim[q]); }).map(function (q) { return { y: lim[q], color: C.limit, label: "limit " + fmt(lim[q], 4) + " ‰", dash: [5, 3] }; }),
                series: [line("mixer[2]", env.t, u, C.yaw)] })],
                text: "The plot shows the tail output (mixer[2]) and its limits. Check T8 counts the times when the tail output is at a limit." });
        },
        dterm: function (a, env) {
            var k = AXES.indexOf(a), name = "axisD[" + k + "]", d = env.inner(env.col(name)), cols = {}, check = CHECKS.dterm[k];
            if (!d) return Promise.resolve({ na: TEXT.notInLog });
            cols[name] = d;
            return env.derive("spectrum", cols, { N: fftSize(d.length) }).then(function (r) {
                var f = freqOf(r), psd = colsOf(r)[name];
                if (!f || !psd) return { na: TEXT.noValues };
                return { specs: [finish({ title: "D-term spectrum, " + a, x: { label: "frequency", unit: "Hz", min: 0, max: env.rate / 2 }, y: { label: "PSD", log: true },
                    vlines: [{ x: 30, color: C.ref, label: "30 Hz", dash: [4, 3] }], series: [line(name, f, psd, C[a])] })],
                    text: "The plot shows the spectrum of the D-term (" + name + "). Check " + check + " compares the part of the power at more than 30 Hz with " + pct(LIMITS.dterm, 0) + "." };
            });
        },
        lines: function (a, env) {
            var k = AXES.indexOf(a), raw = env.inner(env.col("gyroRAW[" + k + "]")), filt = env.inner(env.col("gyroADC[" + k + "]")), cols = {};
            if (!filt) return Promise.resolve({ na: TEXT.notInLog });
            if (raw) cols.raw = raw;
            cols.filtered = filt;
            return env.derive("spectrum", cols, { N: fftSize(filt.length) }).then(function (r) {
                var f = freqOf(r), c = r && r.amplitude || {}, hz = env.rotorHz, marks = [], top = env.rate / 2, // the amplitude of a sine, as the window lines
                    set = env.notchSet ? env.notchSet(a) : null, list = set ? set.list : env.notches(a) || [], fits = [];
                if (!f || !c.filtered) return { na: TEXT.noValues };
                list.forEach(function (q) { // a filter whose frequency comes from the fit of the log: its own dash and the label "from the log"
                    marks.push({ x: q.hz, color: C.orange, label: "notch filter" + (isNum(q.q) ? " Q " + fmt(q.q) : "") + (q.fit ? ", " + TEXT.fromLog : ""), dash: q.fit ? [8, 3] : [4, 2] });
                    if (q.fit && q.kind && !fits.some(function (x) { return x[0] === q.kind; })) fits.push([q.kind, q.fit]);
                });
                for (var h = 1; isNum(hz) && hz > 0 && h <= 8 && h * hz <= top; h++) marks.push({ x: h * hz, color: C.ref, label: h + "×", dash: [2, 3] });
                return { specs: [finish({ title: "Gyro spectrum, " + a + (isNum(hz) ? ", rotor at " + fmt(hz) + " Hz" : ""), x: { label: "frequency", unit: "Hz", min: 0, max: top },
                    y: { label: "amplitude", unit: "deg/s", log: true }, vlines: marks,
                    series: [line("gyroRAW, before the filters", f, c.raw, C.grey, 1), line("gyroADC, after the filters", f, c.filtered, C[a])] })],
                    text: "The plot shows the gyro spectrum before the filters (gyroRAW) and after them (gyroADC). The lines with the labels 1× to 8× show the rotor harmonics. " +
                        "Check F5 finds lines with a prominence of " + LIMITS.line + " or more and no notch filter at 2 % or less from the line." +
                        fits.map(function (x) {
                            return " The analysis found the frequency of the " + x[0] + " notch filters in the log: " + valueSe(x[1].order, x[1].se) + " × the rotor frequency.";
                        }).join("") +
                        (set && set.unknown.length ? " " + unknownNotchText(set.unknown) + " Thus, the plot does not show them." : "") };
            });
        },
        // "Show the measurement" of a result (a = its fid): the evidence plot; without one, the plot of the window for its check
        result: function (fid, env) {
            var f = env.finding(fid);
            if (!f) return Promise.resolve({ na: TEXT.noPlot });
            return env.compare(f).then(function (out) {
                var key = detailKeyOf(f), p = key ? key.split(":") : null;
                if (out.na && p && DETAILS[p[0]]) {
                    return DETAILS[p[0]](p[1] || null, env).then(function (w) { // the plot of the window, and why it is not the plot of the result
                        if (w && !w.na && out.noCurve) w.pre = out.na + " " + TEXT.windowPlot;
                        return w;
                    });
                }
                return out.na ? out : compareOut(f, out);
            });
        }
    };

    // An evidenceCompare answer as a "Show" plot: the plot or the table, what is satisfactory and what the check measured,
    // the caption of the plot (evidence.cjs plot.caption, SPEC3 H: what the curves are and where the limit is) and the source
    function compareOut(f, out) {
        var ev = f.evidence || {}, sum = f.summary || ev.summary || "", cap = ev.plot && typeof ev.plot.caption === "string" ? ev.plot.caption.replace(/\s+/g, " ").trim() : "";
        return { specs: out.spec ? [out.spec] : [], table: out.table || null, caption: cap,
            lines: [ev.expected ? [TEXT.expected, ev.expected] : null, sum ? [TEXT.measured, sum] : null].filter(Boolean),
            text: [out.note ? TEXT.source + " " + out.note + "." : "", out.only || "", out.missing && out.missing.length ? TEXT.noFields + " `" + out.missing.join(", ") + "`." : "",
                out.missed && out.missed.length ? TEXT.missed + " " + out.missed.join(", ") + "." : ""].filter(Boolean).join(" ") };
    }

    function detailTitle(key, f) {
        var p = String(key).split(":"), a = p[1] ? ", " + p[1] : "";
        if (p[0] === "result") return TEXT.compareTitle + (f ? ": " + [f.id, axisOf(f), profileText(profileOf(f))].filter(Boolean).join(", ") : "");
        return ({ track: "Tracking error", osc: "Oscillation", gov: "Headspeed error", tail: "Tail output", dterm: "D-term power", lines: "Gyro lines" }[p[0]] || "Plot") + a;
    }

    // The configurations of a result (result.datasets.datasets, M1): [{ id, pidProfile, ... }]
    function configsOf(r) {
        var ds = r && r.datasets;
        return ds && Array.isArray(ds.datasets) ? ds.datasets.filter(function (d) { return d && typeof d.id === "string" && d.id; }) : [];
    }

    // The configurations of log li in frame seconds (result.datasets.labels): [{ t0, t1, id, index, assumed, pidProfile }]
    function configSpansOf(r, li) {
        var ds = r && r.datasets, list = ds && Array.isArray(ds.labels) ? ds.labels : [], ids = configsOf(r).map(function (d) { return d.id; });
        return list.filter(function (q) { return q && q.log === li && isNum(q.t0) && isNum(q.t1) && q.t1 > q.t0 && typeof q.dataset === "string"; }).map(function (q) {
            return { t0: q.t0, t1: q.t1, id: q.dataset, index: isNum(q.index) ? q.index : Math.max(0, ids.indexOf(q.dataset)), assumed: !!q.assumed, pidProfile: isNum(q.pidProfile) ? q.pidProfile : null };
        }).sort(function (a, b) { return a.t0 - b.t0; });
    }

    // A result for the configuration on display: a result of no single configuration (f.dataset null), else of that configuration
    function inConfig(f, id) {
        return !id || id === "all" || !f || !f.dataset || f.dataset === id;
    }

    // A log with no data that the decoder can read (M4: records[].noData, with the decoder's reason): { why } or null
    function noDataOf(r, li) {
        var rec = recordsOf(r, li).filter(function (q) { return q.noData; })[0], e = r && Array.isArray(r.noData) ? r.noData.filter(function (q) { return q && q.log === li; })[0] : null;
        if (!rec && e) return { why: typeof e.reason === "string" ? e.reason : "" }; // result.noData: [{ log, reason }]
        if (!rec) return null;
        var w = rec.noDataReason || rec.reason || rec.error;
        return { why: typeof w === "string" ? w : "" };
    }

    // ---------------------------------------------------------------------------------------------
    // Values that are possibly not the values of the log header (CLAUDE.md "Values that are possibly not current"). Firmware 4.6.0
    // writes the header once, at the first arm of the log. js/tuning_worker.js gives result.epochs = [{ log, spans: [{ t0, t1 (frame
    // s), arm, armed, pidProfile, rateProfile, fresh, reasons, adjust, source: { pid, rate } | null, text ('' when fresh) }] }]
    // (tools/autotune/param_epochs.cjs) and result.freshness { caveat, reasons }. A part with a reason is "stale"; a fresh part
    // has no known reason, but that is not a proof (freshness.caveat: js/analysis_view.js shows it once)

    // The reasons of param_epochs.cjs in their order, and their causes as nouns (js/tuning_worker.js FRESH.cause)
    var EPOCH_REASONS = ["grace", "rearm", "switched", "unlogged", "adjusted", "resume"];
    var EPOCH_CAUSE = { grace: "the time after a disarm", rearm: "a second arm in the same log", switched: "a different PID profile or rate profile",
        unlogged: 'a change of "govRequest"', adjusted: "an in-flight adjustment", resume: "a period with no data" };
    var EPOCH_ALPHA = 0.4; // the PID profile strip in a stale part: lighter (as a configuration with values of another log, 0.7)
    var EPOCH_ROWS = 4;    // the stale parts of a time window in its flag rows, at most

    // The spans of result.epochs for log li, in time order: [{ t0, t1, reasons (known, in their order), stale, text, source,
    // pidProfile, rateProfile }]. stale: a reason, or fresh false
    function epochSpansOf(r, li) {
        var e = r && Array.isArray(r.epochs) ? r.epochs.filter(function (q) { return q && q.log === li && Array.isArray(q.spans); })[0] : null;
        return (e ? e.spans : []).filter(function (s) { return s && isNum(s.t0) && isNum(s.t1) && s.t1 > s.t0; }).map(function (s) {
            var reasons = Array.isArray(s.reasons) ? EPOCH_REASONS.filter(function (k) { return s.reasons.indexOf(k) >= 0; }) : [];
            return { t0: s.t0, t1: s.t1, reasons: reasons, stale: s.fresh === false || (s.fresh !== true && reasons.length > 0), text: typeof s.text === "string" ? s.text : "",
                source: s.source && typeof s.source === "object" ? s.source : null, pidProfile: isNum(s.pidProfile) && s.pidProfile > 0 ? s.pidProfile : 0,
                rateProfile: isNum(s.rateProfile) && s.rateProfile > 0 ? s.rateProfile : 0 };
        }).sort(function (a, b) { return a.t0 - b.t0; });
    }

    // The stale parts of log li
    function staleSpansOf(r, li) {
        return epochSpansOf(r, li).filter(function (s) { return s.stale; });
    }

    // The stale parts of log li that overlap the time window t0..t1
    function windowEpochs(r, li, t0, t1) {
        return staleSpansOf(r, li).filter(function (s) { return s.t1 > t0 && s.t0 < t1; });
    }

    // The causes of the reasons: "a second arm in the same log and a different PID profile or rate profile", "" for none
    function epochCauses(reasons) {
        return and((Array.isArray(reasons) ? reasons : []).filter(function (k, i, all) { return EPOCH_CAUSE[k] && all.indexOf(k) === i; }).map(function (k) { return EPOCH_CAUSE[k]; }));
    }

    // A CLI dump that the log contradicts for PID profile p (result.cliStatus: not used, or a gov_headspeed conflict of p)
    function cliDisagrees(r, p) {
        var st = r && r.cliStatus;
        return !!(st && typeof st === "object" && (st.used === false || (Array.isArray(st.conflicts) && st.conflicts.some(function (c) { return c && c.what === "gov_headspeed" && c.profile === p; }))));
    }

    // One source of span.source (header, cli, "log N" with N 0-based, recovered, adjustment, none) in words: "values from log 7"
    function sourceWords(v, r, p) {
        var m = typeof v === "string" ? /^log (\d+)$/.exec(v) : null;
        if (v === "header") return TEXT.fromHeader;
        if (m) return TEXT.fromLogN + " " + (+m[1] + 1);
        if (v === "cli") return cliDisagrees(r, p) ? TEXT.fromOldCli : TEXT.fromCli;
        if (v === "recovered") return TEXT.fromFlights;
        if (v === "adjustment") return TEXT.fromAdjustment;
        return TEXT.fromNone;
    }

    // The source of the values of a part, short (CLAUDE.md: each flag gives the source of the values, or "unknown"): "PID profile 2,
    // values from log 7", and the rate profile when its values come from another source
    function epochSource(s, r) {
        var src = s && s.source ? s.source : {}, out = profileText(s && s.pidProfile > 0 ? s.pidProfile : 0) + ", " + sourceWords(src.pid, r, s && s.pidProfile);
        if (src.rate && src.rate !== "header" && src.rate !== src.pid) out += " · " + (s.rateProfile > 0 ? "Rate profile " + s.rateProfile : TEXT.rateUnknown) + ", " + sourceWords(src.rate, r, 0);
        return out;
    }

    // The flag rows of the stale parts `list` in the time window t0..t1 (frame seconds): the time of the window that they cover, then
    // for each part (EPOCH_ROWS at most) its causes, its time, the source of its values and the STE text of the worker. "" for none
    function epochRowsHtml(list, r, t0, t1) {
        if (!list || !list.length) return "";
        var secs = list.reduce(function (a, s) { return a + Math.max(0, Math.min(s.t1, t1) - Math.max(s.t0, t0)); }, 0), more = list.length - EPOCH_ROWS,
            fr = r && r.freshness && r.freshness.reasons && typeof r.freshness.reasons === "object" ? r.freshness.reasons : {};
        return '<h6 class="log-lens-sub">' + esc(TEXT.epochHead) + ' <span class="log-lens-count">' + esc(sec(secs) + " of " + sec(t1 - t0)) + "</span></h6>" +
            '<ul class="log-lens-epoch-list">' + list.slice(0, EPOCH_ROWS).map(function (s) {
                var text = s.text || s.reasons.map(function (k) { return typeof fr[k] === "string" ? fr[k] : ""; }).filter(Boolean).join(" "), why = epochCauses(s.reasons);
                return '<li class="log-lens-epoch"><div class="log-lens-epoch-head">' + (why ? "<strong>" + esc(cap(why)) + "</strong> " : "") +
                    '<span class="log-lens-epoch-meta">' + esc(sec(s.t0) + " to " + sec(s.t1) + " · " + epochSource(s, r)) + "</span></div>" +
                    (text ? '<div class="log-lens-epoch-text">' + esc(text) + "</div>" : "") + "</li>";
            }).join("") + "</ul>" +
            (more > 0 ? '<p class="log-lens-muted">' + esc(more === 1 ? TEXT.epochOneMore : more + " " + TEXT.epochMore) + "</p>" : "");
    }

    // [t0, t1] cut at the parts `spans` ([{ t0, t1 }] in time order, not one over another): [{ t0, t1, on (in a part) }]
    function cutAt(t0, t1, spans) {
        var out = [], t = t0;
        (spans || []).forEach(function (s) {
            var a = Math.max(s.t0, t), b = Math.min(s.t1, t1);
            if (!(b > a)) return;
            if (a > t) out.push({ t0: t, t1: a, on: false });
            out.push({ t0: a, t1: b, on: true });
            t = b;
        });
        if (t1 > t || !out.length) out.push({ t0: t, t1: Math.max(t, t1), on: false });
        return out;
    }

    // ---------------------------------------------------------------------------------------------
    // The timeline: m = { len, trace: { t, v } | null, label, profiles: [{ t0, t1, p }], phases: [{ phase, t0, t1 }],
    // spans: [{ t0, t1, status }], epochs: the stale parts [{ t0, t1 }] (staleSpansOf) }, win = [t0, t1]; in css px. Its x of time
    // t is PAD + (W - 2 PAD) t / len. From the top: the trace (T to B), the PID profile strip (P0 to P1, lighter in the stale parts:
    // EPOCH_ALPHA), the phase strip (Q0 to Q1), the span strip (S0 to S1), the ticks

    // The rows in css px for a canvas H high; k: the text factor (textMetrics), the strips and the tick labels scale with it.
    // config: the configuration strip (C0 to C1, with the letters) goes under the PID profile strip
    function timelineRows(H, k, config) {
        k = isNum(k) && k > 0 ? k : textMetrics().k;
        var z = function (v) { return Math.round(v * k); }, B = H - z(config ? 54 : 42), P0 = B + z(3), C0 = config ? P0 + z(9) : null, C1 = config ? C0 + z(10) : null,
            Q0 = config ? C1 + z(3) : P0 + z(9), S0 = Q0 + z(9);
        return { T: 4, B: B, P0: P0, P1: P0 + z(6), C0: C0, C1: C1, Q0: Q0, Q1: Q0 + z(6), S0: S0, S1: S0 + z(7), k: k };
    }

    function drawTimeline(c, W, H, m, win) {
        var M = textMetrics(), R = timelineRows(H, M.k, !!(m.configs && m.configs.length)), X0 = PAD, X1 = W - PAD, T = R.T, B = R.B, P0 = R.P0, P1 = R.P1, S0 = R.S0, S1 = R.S1, len = m.len > 0 ? m.len : 1,
            phases = m.phases || [];
        function x(t) { return X0 + (X1 - X0) * Math.min(Math.max(t / len, 0), 1); }
        c.fillStyle = BG;
        c.fillRect(0, 0, W, H);
        c.font = M.font;
        c.lineWidth = 1;
        if (phases.length) { // the time out of flight shaded (SPEC2 D13)
            c.fillStyle = "rgba(255,255,255,0.07)";
            phases.forEach(function (p) { if (p.phase !== "flight") c.fillRect(x(p.t0), T, Math.max(1, x(p.t1) - x(p.t0)), B - T); });
        }
        var order = m.spans.slice().sort(function (a, b) { return STATUS[b.status][1] - STATUS[a.status][1]; }); // the worst on top
        order.forEach(function (s) { // over the trace only the results to act on (error, problem, monitor): the strip has all
            if (STATUS[s.status][1] > STATUS.monitor[1]) return;
            c.globalAlpha = 0.16;
            c.fillStyle = STATUS_COLOR[s.status];
            c.fillRect(x(s.t0), T, Math.max(1, x(s.t1) - x(s.t0)), B - T);
        });
        c.globalAlpha = 1;
        var ticks = typeof TuningPlot !== "undefined" && TuningPlot.niceTicks ? TuningPlot.niceTicks(0, len, Math.max(2, Math.round((X1 - X0) / (90 * M.k)))) : [0, len];
        c.textAlign = "center";
        c.textBaseline = "top";
        ticks.forEach(function (t) {
            var px = Math.round(x(t)) + 0.5;
            c.strokeStyle = GRID;
            c.beginPath();
            c.moveTo(px, T);
            c.lineTo(px, B);
            c.stroke();
            c.fillStyle = INK;
            c.fillText(fmt(t, 4) + " s", Math.min(Math.max(px, 14 * M.k), W - 14 * M.k), S1 + 3);
        });
        if (m.trace) {
            var hi = 0, tr = m.trace;
            for (var i = 0; i < tr.v.length; i++) if (isNum(tr.v[i]) && tr.v[i] > hi) hi = tr.v[i];
            c.strokeStyle = C.orange;
            c.lineWidth = 1.2;
            c.beginPath();
            var open = false;
            for (i = 0; i < tr.t.length; i++) {
                var v = tr.v[i];
                if (!isNum(v) || !isNum(tr.t[i]) || !(hi > 0)) { open = false; continue; }
                var px2 = x(tr.t[i]), py = B - (B - T - 4) * Math.max(0, v) / hi;
                if (open) c.lineTo(px2, py); else c.moveTo(px2, py);
                open = true;
            }
            c.stroke();
            c.lineWidth = 1;
        }
        c.textAlign = "left";
        c.fillStyle = INK;
        if (m.label) c.fillText(m.label, X0 + 4, T + 2);
        var epochs = m.epochs || [];
        m.profiles.forEach(function (p) {
            var a = x(p.t0), b = x(p.t1);
            c.fillStyle = PROFILE_COLOR[p.p] || PROFILE_COLOR[0];
            cutAt(p.t0, p.t1, epochs).forEach(function (q) { // a part with values that are possibly not those of the log header: lighter
                c.globalAlpha = q.on ? EPOCH_ALPHA : 1;
                c.fillRect(x(q.t0), P0, Math.max(1, x(q.t1) - x(q.t0)), P1 - P0);
            });
            c.globalAlpha = 1;
            c.fillStyle = INK;
            c.textBaseline = "bottom";
            if (b - a > 78 * M.k) c.fillText(profileText(p.p > 0 ? p.p : 0), a + 3, P0 - 2);
        });
        if (!m.profiles.length) epochs.forEach(function (s) { // no PID profile strip: the stale parts on its row
            c.globalAlpha = EPOCH_ALPHA;
            c.fillStyle = PROFILE_COLOR[0];
            c.fillRect(x(s.t0), P0, Math.max(1, x(s.t1) - x(s.t0)), P1 - P0);
            c.globalAlpha = 1;
        });
        (m.configs || []).forEach(function (q) { // the configurations: the one on display bright, the others dark; a stretch with values of another log lighter
            var a = x(q.t0), b = x(q.t1), other = m.config && m.config !== "all" && q.id !== m.config;
            c.globalAlpha = other ? 0.25 : q.assumed ? 0.7 : 1;
            c.fillStyle = CONFIG_COLOR[(isNum(q.index) ? q.index : 0) % CONFIG_COLOR.length];
            c.fillRect(a, R.C0, Math.max(1, b - a), R.C1 - R.C0);
            c.globalAlpha = 1;
            if (b - a > 12 * M.k && !other) {
                c.fillStyle = "#111";
                c.textBaseline = "middle";
                c.fillText(q.id, a + 3, (R.C0 + R.C1) / 2 + 0.5);
            }
        });
        phases.forEach(function (p) {
            c.fillStyle = PHASES[p.phase][1];
            c.fillRect(x(p.t0), R.Q0, Math.max(1, x(p.t1) - x(p.t0)), R.Q1 - R.Q0);
        });
        order.forEach(function (s) {
            c.fillStyle = STATUS_COLOR[s.status];
            c.fillRect(x(s.t0), S0, Math.max(2, x(s.t1) - x(s.t0)), S1 - S0);
        });
        if (win) { // the outside of the window darker, the window as a box
            var a = x(win[0]), b = x(win[1]);
            c.fillStyle = "rgba(0,0,0,0.5)";
            c.fillRect(X0, T, Math.max(0, a - X0), S1 - T);
            c.fillRect(b, T, Math.max(0, X1 - b), S1 - T);
            c.strokeStyle = ACCENT;
            c.lineWidth = 1.5;
            c.strokeRect(a, T - 1.5, Math.max(2, b - a), S1 - T + 3);
        }
    }

    // The two filters of the result lists (SPEC3 E, as js/tuning_dialog.js): rows [{ f, status }], filter { thin, ok } (true:
    // show the rows with the status "Not sufficient data" or "Satisfactory"). { list, hidden, counts: { thin, ok } }
    function filterRows(rows, filter) {
        var out = [], counts = { thin: 0, ok: 0 }, hidden = 0;
        filter = filter || {};
        (rows || []).forEach(function (o) {
            var kind = o.status === "insufficient" ? "thin" : o.status === "satisfactory" ? "ok" : null;
            if (kind) counts[kind]++;
            if (kind && !filter[kind]) hidden++;
            else out.push(o);
        });
        return { list: out, hidden: hidden, counts: counts };
    }

    // The two filters above the list, with the number of results of each kind and the rows that the list does not show
    function filterBarHtml(filter, got) {
        if (!got.counts.thin && !got.counts.ok) return "";
        function box(kind, label) {
            return '<label class="log-lens-rf-item"><input type="checkbox" data-lens-rf="' + kind + '"' + (filter[kind] ? " checked" : "") + "> " +
                esc(label + " (" + got.counts[kind] + ")") + "</label>";
        }
        return '<div class="log-lens-rf">' + box("thin", TEXT.showThin) + box("ok", TEXT.showOk) +
            (got.hidden ? '<span class="log-lens-muted">' + esc(TEXT.notShown + " " + got.hidden + (got.hidden === 1 ? " result." : " results.")) + "</span>" : "") + "</div>";
    }

    // The PID profiles of the periods `runs` ([{ t0, t1, p }], 0: unknown) in the window t0..t1: [{ p, seconds }] in the
    // sequence of the first period of each, without a part of less than 0.05 s
    function windowProfiles(runs, t0, t1) {
        var out = [], at = {};
        (Array.isArray(runs) ? runs : []).forEach(function (q) {
            var a = Math.max(q.t0, t0), b = Math.min(q.t1, t1), p = isNum(q.p) && q.p > 0 ? q.p : 0;
            if (!(b > a)) return;
            if (!(p in at)) out.push(at[p] = { p: p, seconds: 0 });
            at[p].seconds += b - a;
        });
        return out.filter(function (q) { return q.seconds >= 0.05; });
    }

    // The configurations of the periods `spans` ([{ t0, t1, id }]) in the window t0..t1: [{ id, seconds }] in the sequence of
    // the first period of each, without a part of less than 0.05 s
    function windowConfigs(spans, t0, t1) {
        var out = [], at = {};
        (Array.isArray(spans) ? spans : []).forEach(function (q) {
            var a = Math.max(q.t0, t0), b = Math.min(q.t1, t1);
            if (!(b > a) || !q.id) return;
            if (!(q.id in at)) out.push(at[q.id] = { id: q.id, seconds: 0 });
            at[q.id].seconds += b - a;
        });
        return out.filter(function (q) { return q.seconds >= 0.05; });
    }

    // Runs of equal value: [{ t0, t1, p }], each to the next start (the last to len)
    function runsOf(t, v, len) {
        var out = [];
        for (var i = 0; t && v && i < Math.min(t.length, v.length); i++) {
            if (!out.length || out[out.length - 1].p !== v[i]) {
                if (out.length) out[out.length - 1].t1 = t[i];
                out.push({ t0: t[i], t1: len, p: v[i] });
            }
        }
        return out;
    }

    // ---------------------------------------------------------------------------------------------
    // The lens

    var SKELETON =
        '<div class="log-lens" tabindex="0" aria-label="' + TEXT.title + '">' +
            '<div class="log-lens-head"><h4 class="log-lens-title">' + TEXT.title + '</h4><span class="log-lens-window" data-lens="window"></span>' +
                '<span class="log-lens-where" data-lens="where"></span><span class="log-lens-config" data-lens="config"></span><span class="log-lens-busy" data-lens="busy"></span></div>' +
            '<p class="log-lens-hint">' + TEXT.hint + "</p>" +
            '<div data-lens="notice"></div>' +
            '<div class="log-lens-timeline" data-lens-wheel="1"><canvas class="log-lens-timeline-canvas" data-lens="timeline"></canvas></div>' +
            '<div class="log-lens-legend" data-lens="legend"></div>' +
            '<p class="log-lens-start" data-lens="start"></p>' +
            '<div class="log-lens-epochs" data-lens="epochs"></div>' +
            '<div class="log-lens-main">' +
                '<div class="log-lens-charts" data-lens="charts" data-lens-wheel="1"></div>' +
                '<div class="log-lens-panel"><h5 class="log-lens-h">' + TEXT.inWindow + "</h5>" +
                    '<div data-lens="detail"></div><div data-lens="findings"></div><div data-lens="values"></div></div>' +
            "</div>" +
        "</div>";

    function LogLens(container, hooks) {
        hooks = hooks || {};
        var root = container && container.jquery ? container[0] : container, self = this;
        var log = null, li = -1, tMin = 0, len = 0, has = {}, shownCharts = [], // the open log, its start (us), length (s), fields, charts
            win = null, result = null, given = null, visible = false, // the window [t0, t1]; the result for this log; the last one given
            seq = 0, timer = null, dirty = false, drag = null, reader = null,
            inflight = false, again = false, // a read and derive("window") on their way; a newer window waits for them
            snap = null, readError = null, values = null, valuesError = null, // the window data and its derive("window") result
            detail = null, charts = {}, detailPlots = [], running = false, startError = null, shownKey = "";

        root.innerHTML = SKELETON;
        function part(name) { return root.querySelector('[data-lens="' + name + '"]'); }
        var el = { window: part("window"), where: part("where"), config: part("config"), busy: part("busy"), notice: part("notice"), timeline: part("timeline"), legend: part("legend"),
            start: part("start"), epochs: part("epochs"), charts: part("charts"), detail: part("detail"), findings: part("findings"), values: part("values") };

        function findings() { return result && Array.isArray(result.findings) ? result.findings : []; }

        // The configuration on display (SPEC3 J): the configuration menu of the Tuning view, "all" without it or for an id that
        // the result does not have
        function config() {
            var id = hooks.configuration ? hooks.configuration() : "all";
            return id && id !== "all" && configsOf(result).some(function (d) { return d.id === id; }) ? String(id) : "all";
        }

        // The result covers the open log: its log, or a file result with it; and the same file name
        function covers(r) {
            if (!r || typeof r !== "object" || !log) return false;
            var name = hooks.getFileName ? hooks.getFileName() : null;
            if (name && r.fileName && String(r.fileName) !== String(name)) return false;
            // "Selected flights" (SPEC3 D) is a file result of the selected logs: scope "file" (or "flights") and r.logs
            return r.scope === "file" || r.scope === "flights" ? (Array.isArray(r.logs) && r.logs.indexOf(li) >= 0) || benchOf(r, li) : r.logIndex === li;
        }

        function curve() {
            var list = result && Array.isArray(result.curves) ? result.curves : [];
            return list.filter(function (q) { return q && q.log === li; }).sort(function (a, b) { return (b.seconds || 0) - (a.seconds || 0); })[0] || null;
        }

        // The PID profile at frame second t: from the result curves, else from the log index
        function profileAt(t) {
            var g = curve() && curve().more && curve().more.gov, a = log && log.getActivitySummary ? log.getActivitySummary() : null, i,
                spans = result ? profileSpansOf(result, li) : [];
            for (i = 0; i < spans.length; i++) if (t >= spans[i].t0 && t < spans[i].t1) return spans[i].p;
            if (g && g.t && g.profile && g.t.length) {
                for (i = 0; i + 1 < g.t.length && g.t[i + 1] <= t; i++);
                return g.profile[i];
            }
            if (a && a.times && a.pidProfile) {
                for (i = 0; i + 1 < a.times.length && (a.times[i + 1] - tMin) / 1e6 <= t; i++);
                return a.pidProfile[i] || 0;
            }
            return 0;
        }

        // The time delay of C13 / T12 for axis a on the profile of the window, null without one
        function tauOf(a) {
            var p = profileAt((win[0] + win[1]) / 2), id = a === "yaw" ? "T12" : "C13", hit = findings().filter(function (f) {
                return f.id === id && f.axis === a && f.log === li && +f.profile === +p && isNum(f.value);
            })[0];
            return hit ? hit.value : null;
        }

        // An item of the window values: "track.roll", "tail.limit" ... (js/tuning_worker.js windowStats)
        function item(key) {
            return values && Array.isArray(values.items) ? values.items.filter(function (it) { return it && it.key === key; })[0] || null : null;
        }

        // The tail output limits (permille of mixer[2]): of the result (health_more curves), else those the worker found in the window
        function tailLimits() {
            var t = curve() && curve().more && curve().more.tail, d = item("tail.limit") && item("tail.limit").detail;
            if (t && t.limits && (isNum(t.limits.lo) || isNum(t.limits.hi))) return { lo: t.limits.lo, hi: t.limits.hi };
            return d && (isNum(d.lo) || isNum(d.hi)) ? { lo: d.lo, hi: d.hi } : null;
        }

        // The notch filters of the result for axis a at the headspeed of the window (notchSet: the filters with a frequency, the
        // frequency from the fit of the log, the kinds with no frequency), null without a result or without its vibration curves
        function notchInfo(a, rotorHz) {
            var v = curve() && curve().more && curve().more.vib;
            return v ? notchSet(v, profileAt((win[0] + win[1]) / 2), a, rotorHz, result && result.notchFit) : null;
        }

        // The notch filters with a frequency, null without a result
        function notches(a, rotorHz) {
            var s = notchInfo(a, rotorHz);
            return s ? s.list : null;
        }

        // The notch filters of each axis for the gyro lines of windowRows: null without a result
        function lineNotches() {
            if (!result) return null;
            var hz = snap ? rotorHz() : null, out = {};
            AXES.forEach(function (a) { var s = notchInfo(a, hz); if (s) out[a] = s; });
            return out;
        }

        // A column of the window without the pad on each side
        function inner(x) {
            return x && snap ? x.subarray(snap.i0, snap.i1) : null;
        }

        function rotorHz() {
            var m = snap ? median(inner(snap.cols.headspeed)) : null;
            return isNum(m) && m > 0 ? m / 60 : null;
        }

        // Shaded spans of the results in the window on a strip chart (by chartOf) or a "Show" plot (by detailKeyOf)
        function bandsFor(key, byDetail) {
            return overlapping(findings(), li, win[0], win[1]).filter(function (o) { return (byDetail ? detailKeyOf(o.f) : chartOf(o.f)) === key; })
                .reduce(function (out, o) {
                    return out.concat(o.spans.map(function (s, i) {
                        return { x0: Math.max(s.t0, win[0]), x1: Math.min(s.t1, win[1]), color: hexAlpha(STATUS_COLOR[o.status], 0.22), label: i ? "" : String(o.f.id) };
                    }));
                }, []).slice(0, 60);
        }

        function derive(kind, cols, rate, params) {
            if (typeof hooks.derive !== "function") return Promise.reject(new Error(TEXT.noDerive));
            var copy = {}; // copies, which the worker takes (transfer): the charts keep the columns of the window
            Object.keys(cols).forEach(function (k) { if (cols[k]) copy[k] = new Float32Array(cols[k]); });
            return Promise.resolve().then(function () { return hooks.derive(kind, copy, rate, params || {}, true); });
        }

        // --- the log and the window

        function destroyCharts() {
            Object.keys(charts).forEach(function (k) { try { charts[k].destroy(); } catch (e) { console.warn(e); } });
            charts = {};
        }

        function destroyDetail() {
            detailPlots.forEach(function (h) { try { h.destroy(); } catch (e) { console.warn(e); } });
            detailPlots = [];
        }

        function openLog(lg, i) {
            seq++; // the answers for the log before are dropped
            clearTimeout(timer);
            timer = null;
            again = false;
            destroyCharts();
            destroyDetail();
            log = lg;
            li = i;
            win = snap = values = readError = valuesError = detail = null;
            reader = null;
            has = {};
            shownKey = "";
            result = covers(given) ? given : null;
            var error = !lg ? TEXT.noLog : lg.getLogError && lg.getLogError(i) ? TEXT.logError : "";
            len = error ? 0 : Math.max(0, (lg.getMaxTime(i) - lg.getMinTime(i)) / 1e6);
            if (!error && !(len > 0)) error = TEXT.logError;
            tMin = error ? 0 : lg.getMinTime(i);
            FIELDS.forEach(function (name) { has[name] = !error && lg.getMainFieldIndexByName(name) !== undefined; });
            var list = CHARTS.filter(function (c) { return c.need.some(function (n) { return has[n]; }); });
            shownCharts = list.map(function (c) { return c.key; });
            el.charts.innerHTML = error ? "" : CHARTS.map(function (c) {
                if (list.indexOf(c) < 0) return '<div class="log-lens-chart is-na"><strong>' + esc(c.name) + "</strong> " + esc(TEXT.noFields) + " <code>" + esc(c.need.join(", ")) + "</code></div>";
                return '<div class="log-lens-chart"><canvas class="log-lens-chart-canvas" data-chart="' + c.key + '"></canvas></div>';
            }).join("");
            el.notice.innerHTML = error ? '<div class="log-lens-notice is-error">' + esc(error) + "</div>" : "";
            el.window.textContent = "";
            el.findings.innerHTML = el.values.innerHTML = el.detail.innerHTML = el.legend.innerHTML = el.start.innerHTML = el.config.innerHTML = el.epochs.innerHTML = "";
            return !error;
        }

        function setWindow(t0, t1, user) {
            if (!log || !(len > 0) || !isNum(t0) || !isNum(t1)) return;
            var w = clampWindow(Math.min(t0, t1), Math.max(t0, t1), len);
            if (win && Math.abs(w[0] - win[0]) < 1e-9 && Math.abs(w[1] - win[1]) < 1e-9) return;
            win = w;
            if (user) dirty = true;
            el.window.textContent = TEXT.window + ": " + sec(win[0]) + " to " + sec(win[1]) + " (" + sec(win[1] - win[0]) + ")";
            el.where.textContent = whereText();
            paintTimeline();
            renderEpochs();
            renderFindings(false);
            schedule();
        }

        function panBy(frac) {
            if (win) setWindow(win[0] + frac * (win[1] - win[0]), win[1] + frac * (win[1] - win[0]), true);
        }

        function zoomBy(factor) {
            if (!win) return;
            var c = (win[0] + win[1]) / 2, w = (win[1] - win[0]) * factor;
            setWindow(c - w / 2, c + w / 2, true);
        }

        function viewerWindow() {
            var v = hooks.getViewerWindow ? hooks.getViewerWindow() : null;
            if (Array.isArray(v)) v = { t0us: v[0], t1us: v[1] };
            var a = v && (isNum(v.t0us) ? v.t0us : v.t0), b = v && (isNum(v.t1us) ? v.t1us : v.t1);
            return isNum(a) && isNum(b) && b > a ? [(a - tMin) / 1e6, (b - tMin) / 1e6] : null;
        }

        // The PID profiles and the flight phases of the window, for the head. Each PID profile that is active in the window,
        // in the sequence of its first period, with its seconds when there are more than one (V8); "PID profile unknown" only
        // for the part with no known PID profile
        function whereText() {
            var m = model(), names = [], list = windowProfiles(m.profiles, win[0], win[1]);
            m.phases.forEach(function (p) { if (p.t1 > win[0] && p.t0 < win[1] && names.indexOf(PHASES[p.phase][0]) < 0) names.push(PHASES[p.phase][0]); });
            var prof = !list.length ? profileText(profileAt((win[0] + win[1]) / 2) || 0) : list.length === 1 ? profileText(list[0].p) :
                list.map(function (q) { return profileText(q.p) + " (" + sec(q.seconds) + ")"; }).join(", ");
            var cfg = windowConfigs(m.configs, win[0], win[1]);
            var cfgText = !cfg.length ? "" : cfg.length === 1 ? TEXT.configuration + " " + cfg[0].id : "Configurations " + cfg.map(function (q) { return q.id + " (" + sec(q.seconds) + ")"; }).join(", ");
            return [prof, cfgText, names.length ? TEXT.phases + ": " + names.join(", ") : ""].filter(Boolean).join(" · ");
        }

        // --- the timeline

        var traceCache = null; // { log, li, result, m }

        // The time of a curve sample as frame seconds (the curves have index time: SPEC2 D1)
        function curveTimes(t) {
            var c = curve(), rec = c ? recordsOf(result, li).filter(function (q) { return q.segment === c.segment; })[0] : null, tm = rec && rec.timeMap;
            return tm ? Float64Array.from(t, function (x) { return toFrame(tm, x); }) : t;
        }

        function model() {
            if (traceCache && traceCache.log === log && traceCache.li === li && traceCache.result === result) return traceCache.m;
            var m = { len: len, trace: null, label: "", profiles: [], phases: result ? phasesOf(result, li) : [], flights: result ? flightsOf(result, li) : [],
                bench: !!result && benchOf(result, li), spans: spansOf(findings(), li) };
            var g = curve() && curve().more && curve().more.gov, a = log.getActivitySummary ? log.getActivitySummary() : null, gt = g && g.t ? curveTimes(g.t) : null;
            if (g && g.t && g.hs && g.t.length > 1) {
                m.trace = { t: gt, v: g.hs };
                m.label = "Headspeed";
            } else if (a && a.times && a.times.length > 1) {
                var t = Float64Array.from(a.times, function (us) { return (us - tMin) / 1e6; });
                if (a.avgThrottle && a.avgThrottle.length) {
                    m.trace = { t: t, v: a.avgThrottle };
                    m.label = "Throttle";
                }
                if (a.pidProfile && a.pidProfile.length) m.profiles = runsOf(t, a.pidProfile, len);
            }
            if (g && g.t && g.profile && g.t.length) m.profiles = runsOf(gt, g.profile, len);
            var spans = result ? profileSpansOf(result, li) : [];
            if (spans.length) m.profiles = spans; // the PID profiles of the worker: frame seconds, the arming profile found
            m.configs = result ? configSpansOf(result, li) : []; // the configurations of the log (M1)
            m.epochs = result ? staleSpansOf(result, li) : []; // the parts with values that are possibly not those of the log header
            traceCache = { log: log, li: li, result: result, m: m };
            return m;
        }

        function paintTimeline() {
            var canvas = el.timeline;
            if (!log || !(len > 0) || !canvas.getContext) return;
            canvas.className = "log-lens-timeline-canvas" + (model().configs.length ? " has-config" : ""); // css/log_lens.css: higher, for the strip of the configurations
            var W = canvas.clientWidth, H = canvas.clientHeight, r = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
            if (!(W > 0 && H > 0)) return;
            if (canvas.width !== Math.round(W * r)) canvas.width = Math.round(W * r);
            if (canvas.height !== Math.round(H * r)) canvas.height = Math.round(H * r);
            var c = canvas.getContext("2d"), m = model();
            c.setTransform(r, 0, 0, r, 0, 0);
            m.config = config();
            drawTimeline(c, W, H, m, win);
        }

        function timeAt(e) {
            var b = el.timeline.getBoundingClientRect(), W = b.width || el.timeline.clientWidth;
            return (e.clientX - b.left - PAD) / Math.max(1, W - 2 * PAD) * len;
        }

        // --- the panel

        function renderNotice() {
            if (!log || !(len > 0)) return;
            var html = "";
            if (!result && typeof hooks.runAnalysis !== "function") {
                html = '<div class="log-lens-notice">' + esc(TEXT.noResult) + " " + esc(TEXT.noStart) + "</div>";
            } else if (!result) {
                html = '<div class="log-lens-notice">' + esc(TEXT.noResult) + ' <button type="button" class="btn btn-primary btn-xs" data-lens-act="start"' +
                    (running ? " disabled" : "") + ">" + esc(TEXT.start) + "</button>" + (running ? ' <span class="log-lens-muted">' + esc(TEXT.running) + "</span>" : "") +
                    (startError ? ' <span class="log-lens-muted">' + runErrorHtml(startError) + "</span>" : "") + "</div>";
            } else if (noDataOf(result, li)) {
                var nd = noDataOf(result, li);
                html = '<div class="log-lens-notice is-warn">' + esc(TEXT.noData) + (nd.why ? quoted(nd.why) : "") + "</div>";
            } else if (model().bench) {
                html = '<div class="log-lens-notice is-warn">' + esc(TEXT.bench) + "</div>";
            } else if (!model().spans.length) {
                html = '<div class="log-lens-notice is-warn">' + esc(TEXT.noSpans) + "</div>";
            }
            el.notice.innerHTML = html;
        }

        // The flag rows of the window: its parts with values that are possibly not those of the log header (CLAUDE.md "Values that
        // are possibly not current"), with their causes and the source of their values. Nothing without a result or such a part
        function renderEpochs() {
            el.epochs.innerHTML = result && win && log && len > 0 ? epochRowsHtml(windowEpochs(result, li, win[0], win[1]), result, win[0], win[1]) : "";
        }

        // The configuration menu of the head (SPEC3 J): the menu of the Tuning view (hooks.setConfiguration), with two or more
        // configurations in the result
        function renderConfigMenu() {
            var list = configsOf(result), cur = config();
            el.config.innerHTML = list.length < 2 || typeof hooks.setConfiguration !== "function" ? "" :
                '<label class="log-lens-config-label">' + esc(TEXT.configuration) + ' <select class="form-control input-sm" data-lens-config="1">' +
                [["all", TEXT.allConfigs]].concat(list.map(function (d) { return [d.id, TEXT.configuration + " " + d.id + ": " + profileText(isNum(d.pidProfile) && d.pidProfile > 0 ? d.pidProfile : 0)]; })).map(function (o) {
                    return '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? " selected" : "") + ">" + esc(o[1]) + "</option>";
                }).join("") + "</select></label>";
        }

        // Another configuration on display: the menu, the head, the timeline and the results of the window
        function configChanged() {
            if (!log || !(len > 0) || !win) return;
            renderConfigMenu();
            el.where.textContent = whereText();
            paintTimeline();
            renderFindings(true);
        }

        function renderLegend() {
            var seen = {}, phase = {}, m = log && len > 0 ? model() : null;
            // the PID profile at the start of the log, and how the analysis found it (not for a bench run: no arming result)
            el.start.innerHTML = m && result && !m.bench ? startHtml(armingOf(result, li), result.scope) : "";
            if (!m) {
                el.legend.innerHTML = "";
                return;
            }
            m.spans.forEach(function (s) { seen[s.status] = true; });
            m.phases.forEach(function (p) { phase[p.phase] = true; });
            el.legend.innerHTML = '<span><i class="log-lens-swatch is-window"></i>' + esc(TEXT.window) + "</span>" +
                Object.keys(STATUS).filter(function (k) { return seen[k]; }).map(function (k) {
                    return '<span><i class="log-lens-swatch" style="background:' + STATUS_COLOR[k] + '"></i>' + esc(STATUS[k][0]) + "</span>";
                }).join("") +
                (m.epochs && m.epochs.length ? '<span class="log-lens-legend-gap"><i class="log-lens-swatch is-epoch"></i>' + esc(TEXT.epochHead) + "</span>" : "") +
                PHASE_ORDER.filter(function (k) { return phase[k]; }).map(function (k, i) {
                    return '<span class="' + (i ? "" : "log-lens-legend-gap") + '"><i class="log-lens-swatch is-phase" style="background:' + PHASES[k][1] + '"></i>' + esc(PHASES[k][0]) + "</span>";
                }).join("") +
                (m.configs || []).filter(function (q, i, all) { return all.map(function (x) { return x.id; }).indexOf(q.id) === i; }).map(function (q, i) {
                    var d = configsOf(result).filter(function (x) { return x.id === q.id; })[0];
                    return '<span class="' + (i ? "" : "log-lens-legend-gap") + '"><i class="log-lens-swatch is-config" style="background:' + CONFIG_COLOR[(isNum(q.index) ? q.index : 0) % CONFIG_COLOR.length] + '"></i>' +
                        esc(TEXT.configuration + " " + q.id + (d ? ": " + profileText(isNum(d.pidProfile) && d.pidProfile > 0 ? d.pidProfile : 0) : "")) + "</span>";
                }).join("") +
                m.flights.map(function (q, i) {
                    return '<button type="button" class="log-lens-flight" data-lens-act="flight" data-arg="' + q.t0 + "," + q.t1 + '">' +
                        esc(TEXT.flight + " " + (i + 1) + ": " + sec(q.t0) + " to " + sec(q.t1)) + "</button>";
                }).join("");
        }

        // The id, axis, PID profile and flight phase of a result (SPEC2 D12, D13)
        function headOf(f) {
            return [f.id, axisOf(f), profileText(profileOf(f)), PHASES[f.phase] ? PHASES[f.phase][0] : ""].filter(Boolean).join(", ");
        }

        function summaryOf(f) {
            return f.summary || (f.evidence && f.evidence.summary) || "";
        }

        // A result of the window: a problem or a value to monitor in full, the others in one line that opens. The value is
        // in the STE summary; the raw one only with its unit, or with no summary
        function findingHtml(o) {
            var f = o.f, key = f.evidence && f.evidence.plot ? "result:" + (f.fid || "") : detailKeyOf(f), fid = esc(f.fid || ""), lim = limitOf(f), sum = summaryOf(f),
                val = valueOf(f), own = !!displayOf(f),
                full = o.status === "error" || o.status === "problem" || o.status === "monitor",
                times = o.spans.slice(0, 3).map(function (s) { // a span of another PID profile than the result says so
                    return sec(s.t0) + " to " + sec(s.t1) + (s.pidProfile !== null && s.pidProfile !== profileOf(f) ? " (" + profileText(s.pidProfile) + ")" : "");
                }).join(", "),
                head = '<span class="log-lens-badge st-' + o.status + '">' + esc(STATUS[o.status][0]) + '</span> <span class="log-lens-id">' + esc(headOf(f)) + "</span>",
                body = (sum ? '<div class="log-lens-summary">' + esc(sum).replace(/`([^`]*)`/g, "<code>$1</code>") + "</div>" : "") + // names in backticks: code font
                    '<div class="log-lens-facts">' + (val && (own || f.unit || !sum) ? "Value: " + esc(val) + ". " : "") +
                        (lim ? "Limit: " + (lim.code ? "<code>" + esc(lim.text) + "</code>" : esc(lim.text.replace(/\.$/, ""))) + ". " : "") +
                        "Time in the log: " + esc(times) + (o.spans.length > 3 ? " (" + (o.spans.length - 3) + " more)" : "") + ".</div>" +
                    '<div class="log-lens-links">' + (f.fid ? '<a href="#" data-lens-act="log" data-fid="' + fid + '">' + esc(TEXT.showInLog) + "</a>" : "") +
                        (key && f.fid ? ' <a href="#" data-lens-act="compare" data-fid="' + fid + '" data-arg="' + esc(key) + '">' + esc(TEXT.compare) + "</a>" : "") + "</div>" +
                    (f.text ? '<details data-ste="quoted"><summary>' + esc(TEXT.quoted) + "</summary>" + esc(f.text) + "</details>" : "");
            return '<li class="log-lens-finding st-' + o.status + (full ? "" : " is-compact") + '">' + (full ? '<div class="log-lens-finding-head">' + head + "</div>" + body :
                '<details><summary class="log-lens-finding-head">' + head + "</summary>" + body + "</details>") + "</li>";
        }

        // force: also when the same results are in the window (a new result, a new log)
        // The two filters of the result lists (SPEC3 E): from js/main.js (the preferences, shared with the Tuning view), else kept here
        var localFilter = { thin: false, ok: false };
        function resultFilter() {
            var f = hooks.resultFilter ? hooks.resultFilter() : localFilter;
            return { thin: !!(f && f.thin), ok: !!(f && f.ok) };
        }

        function renderFindings(force) {
            if (!win) return;
            var filter = resultFilter(), cfg = config(), all = result ? overlapping(findings(), li, win[0], win[1]).filter(function (o) { return inConfig(o.f, cfg); }) : [],
                got = filterRows(all, filter), list = got.list,
                key = result ? all.map(function (o) { return o.f.fid || o.f.id; }).join("|") + "#" + all.length + "#" + filter.thin + filter.ok + "#" + cfg : "none";
            if (!force && key === shownKey) return;
            shownKey = key;
            el.findings.innerHTML = !result ? "" : '<h6 class="log-lens-sub">' + esc(TEXT.findings) + ' <span class="log-lens-count">' + list.length + "</span></h6>" +
                (cfg !== "all" ? '<p class="log-lens-muted log-lens-config-note">' + esc(TEXT.configuration + " " + cfg + ". " + TEXT.configList) + "</p>" : "") +
                filterBarHtml(filter, got) +
                (list.length ? '<ul class="log-lens-findings">' + list.map(findingHtml).join("") + "</ul>" : got.hidden ? "" : '<p class="log-lens-muted">' + esc(TEXT.noFindings) + "</p>");
        }

        // An error as STE text: our own sentence as it is, any other message quoted after `base`
        function failText(e, base) {
            var m = message(e);
            return Object.keys(TEXT).some(function (k) { return TEXT[k] === m; }) ? esc(m) : esc(base) + quoted(m);
        }

        function renderValues() {
            var html = '<h6 class="log-lens-sub">' + esc(TEXT.values) + "</h6>";
            if (readError) {
                html += '<p class="log-lens-muted">' + failText(readError, TEXT.noRead) + "</p>";
            } else if (valuesError) {
                html += '<p class="log-lens-muted">' + failText(valuesError, TEXT.noValues) + "</p>";
            } else if (!values) {
                html += '<p class="log-lens-muted">' + esc(TEXT.busy) + "</p>";
            } else {
                html += '<table class="log-lens-values"><thead><tr><th>' + esc(TEXT.quantity) + "</th><th>" + esc(TEXT.value) + "</th><th>" + esc(TEXT.limit) +
                    "</th><th>" + esc(TEXT.check) + "</th><th></th></tr></thead><tbody>" + windowRows(values, lineNotches()).map(function (r) {
                        var gone = r.status === "notMeasured" || r.status === "insufficient";
                        return '<tr class="lv-' + r.status + '"><td class="log-lens-what">' + esc(r.what) +
                            (r.note ? '<div class="log-lens-note"' + (r.worker ? ' data-ste="quoted"' : "") + ">" + esc(r.note) + "</div>" : "") +
                            '</td><td class="log-lens-num">' + esc(r.value) + (r.levelText ? '<div class="log-lens-level">' + esc(r.levelText) + "</div>" : "") +
                            '</td><td class="log-lens-num">' + esc(r.limit) + '</td><td class="log-lens-check">' + esc(r.check) + "</td><td>" +
                            (gone ? "" : '<button type="button" class="btn btn-default btn-xs" data-lens-act="show" data-arg="' + esc(r.key) + '">' + esc(TEXT.show) + "</button>") + "</td></tr>";
                    }).join("") + "</tbody></table>" +
                    (Array.isArray(values.notes) && values.notes.length ? '<ul class="log-lens-notes" data-ste="quoted">' + values.notes.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") + "</ul>" : "");
            }
            el.values.innerHTML = html;
        }

        function busy(on) {
            el.busy.textContent = on ? TEXT.busy : "";
        }

        // --- the strip charts

        function drawCharts() {
            if (!win) return;
            var ctx = { win: win, last: shownCharts[shownCharts.length - 1], tailLimits: tailLimits(), bands: function (k) { return bandsFor(k, false); } };
            shownCharts.forEach(function (key) {
                var canvas = root.querySelector('[data-chart="' + key + '"]');
                if (!canvas || !snap) return;
                var spec = chartSpec(key, snap, ctx);
                try {
                    if (charts[key]) charts[key].update(spec);
                    else if (typeof TuningPlot !== "undefined") charts[key] = TuningPlot.attach(canvas, spec);
                } catch (e) {
                    console.error(e);
                }
            });
            if (typeof TuningPlot === "undefined" && snap) el.charts.innerHTML = '<p class="log-lens-muted">' + esc(TEXT.noPlots) + "</p>";
        }

        // --- "Show"

        // The evidence plots of the results, once each for a result (they do not change with the window)
        var compares = { result: null, map: new Map() };
        function compareOf(f) {
            if (compares.result !== result) compares = { result: result, map: new Map() };
            if (!compares.map.has(f)) {
                compares.map.set(f, evidenceCompare(f, result, { derive: function (kind, cols, rate, params) { return derive(kind, cols, rate, params); },
                    reader: function () { return snippetReader(); } }));
            }
            return compares.map.get(f);
        }

        function snippetReader() {
            if (!reader && typeof TuningSnippet !== "undefined" && TuningSnippet.Reader) reader = new TuningSnippet.Reader(hooks);
            return reader;
        }

        // Without the data of the window (a read that failed), col() gives null: the plots of the window are not available
        function env() {
            var rate = snap ? snap.rate : null, hz = snap ? rotorHz() : null;
            return { t: snap ? snap.t : null, rate: rate, rotorHz: hz, tailLimits: tailLimits(), x: { label: "time", unit: "s", min: win[0], max: win[1] },
                finding: byFid, compare: compareOf,
                col: function (name) { return snap && snap.cols[name] || null; },
                inner: inner,
                item: item,
                derive: function (kind, cols, params) { return derive(kind, cols, rate, params); },
                tau: function (a) { var q = item("track." + a); return q && q.detail && isNum(q.detail.tauMs) ? q.detail.tauMs : tauOf(a); },
                notches: function (a) { return notches(a, hz); },
                notchSet: function (a) { return notchInfo(a, hz); },
                bands:function (k) { return bandsFor(k, true); } };
        }

        function argOf(key) {
            var k = String(key || ""), i = k.indexOf(":");
            return i < 0 ? null : k.slice(i + 1);
        }

        // "Show" and "Show the measurement" (V2): the plot goes just above the list of the row that asked for it (the values
        // of the window, or the results of the window), and the panel scrolls it into view
        function placeDetail(where) {
            var d = el.detail, next = where === "findings" ? el.findings : el.values;
            try {
                if (next && next.parentNode && next.parentNode.insertBefore && d.nextSibling !== next) next.parentNode.insertBefore(d, next);
            } catch (e) {
                console.warn(e);
            }
            scrollDetail();
        }

        function scrollDetail() {
            try {
                if (el.detail.scrollIntoView) el.detail.scrollIntoView({ block: "nearest" });
            } catch (e) {
                console.warn(e);
            }
        }

        function openDetail(key, where) {
            var p = String(key || "").split(":");
            if (!DETAILS[p[0]]) return;
            detail = { key: key, fixed: false, scroll: true };
            destroyDetail();
            placeDetail(where);
            el.detail.innerHTML = '<div class="log-lens-detail"><div class="log-lens-detail-head"><span class="log-lens-detail-title">' +
                esc(detailTitle(key, p[0] === "result" ? byFid(argOf(key)) : null)) +
                '</span><button type="button" class="btn btn-default btn-xs" data-lens-act="close">' + esc(TEXT.close) + '</button></div>' +
                '<div data-lens="detail-body"><p class="log-lens-muted">' + esc(TEXT.busy) + "</p></div></div>";
            updateDetail(seq);
        }

        function closeDetail() {
            detail = null;
            destroyDetail();
            el.detail.innerHTML = "";
        }

        // The plot of "Show" for the data of the window as it is now; the evidence plot of a result once (detail.fixed)
        function updateDetail(my) {
            if (!detail || detail.fixed) return Promise.resolve();
            var key = detail.key, p = key.split(":");
            if (!snap && p[0] !== "result") {
                if (readError) drawDetail({ na: TEXT.noRead, error: readError });
                return Promise.resolve();
            }
            return DETAILS[p[0]](argOf(key), env()).then(function (out) {
                if (my === seq && detail && detail.key === key) drawDetail(out);
            }, function (e) {
                if (my === seq && detail && detail.key === key) drawDetail({ na: TEXT.noValues, error: e });
            });
        }

        function caption(text) {
            return esc(text || "").replace(/`([^`]*)`/g, "<code>$1</code>");
        }

        function drawDetail(out) {
            drawDetailBody(out);
            if (detail && detail.scroll) { // the first answer after "Show": the whole plot in view
                detail.scroll = false;
                scrollDetail();
            }
        }

        function drawDetailBody(out) {
            var body = root.querySelector('[data-lens="detail-body"]'), specs = out.specs || [],
                lines = (out.lines || []).map(function (q) { return '<div class="log-lens-line"><strong>' + esc(q[0]) + "</strong> " + esc(q[1]) + "</div>"; }).join("");
            destroyDetail();
            if (!body) return;
            if (detail) detail.fixed = !!(out.lines && !out.na); // an evidence plot: the same for each window
            var under = (out.caption ? '<p class="log-lens-caption is-plot">' + caption(out.caption) + "</p>" : "") + (out.text ? '<p class="log-lens-caption">' + caption(out.text) + "</p>" : "");
            if (out.table) {
                body.innerHTML = lines + tableHtml(out.table) + under;
                return;
            }
            if (!specs.length || typeof TuningPlot === "undefined") {
                body.innerHTML = lines + '<p class="log-lens-muted">' + esc(TEXT.noPlot) + " " + esc(typeof TuningPlot === "undefined" ? TEXT.noPlots : out.na || TEXT.noValues) +
                    (out.error ? quoted(message(out.error)) : "") + "</p>";
                return;
            }
            body.innerHTML = lines + (out.pre ? '<p class="log-lens-muted">' + esc(out.pre) + "</p>" : "") + specs.map(function (s, i) {
                return '<div class="log-lens-plot"><canvas class="log-lens-detail-canvas" data-detail-plot="' + i + '"></canvas></div>';
            }).join("") + under;
            specs.forEach(function (s, i) {
                try { detailPlots.push(TuningPlot.attach(body.querySelector('[data-detail-plot="' + i + '"]'), s)); } catch (e) { console.error(e); }
            });
        }

        // --- reading the window and its values

        function schedule() {
            clearTimeout(timer);
            timer = visible ? setTimeout(refresh, DEBOUNCE_MS) : null;
        }

        // The parameters of derive("window"): the time delays of C13 and T12 and the tail limits of the result, the notch
        // filters at the headspeed of the window (the worker measures the distance of each line to them)
        function params(padS) {
            var tau = {}, notch = {}, hz = rotorHz();
            AXES.forEach(function (a) {
                tau[a] = tauOf(a);
                var list = notches(a, hz);
                notch[a] = list ? list.map(function (q) { return q.hz; }) : null;
            });
            return { t0: snap.t[0], padS: padS, tauMs: tau, tailLimits: tailLimits(), notchHz: notch.roll || notch.pitch || notch.yaw ? notch : null, lines: 3 };
        }

        // One read and derive("window") at a time (a 60 s window at 4 kHz takes approximately 0.8 s in the worker). A change
        // while one is on its way makes its answer old, and the window as it is then goes next. Thus the requests do not wait
        // in a queue of the derive worker
        function refresh() {
            clearTimeout(timer);
            timer = null;
            if (!visible || !log || !win) return;
            if (inflight) {
                seq++;
                again = true;
                return;
            }
            inflight = true;
            again = false;
            var my = ++seq, w = win.slice(), pad = Math.max(0, Math.min(PAD_S, w[0], len - w[1], (MAX_S - (w[1] - w[0])) / 2));
            if (dirty && hooks.setViewerWindow) hooks.setViewerWindow(tMin + w[0] * 1e6, tMin + w[1] * 1e6);
            dirty = false;
            busy(true);
            var read = typeof TuningSnippet !== "undefined" && TuningSnippet.Reader ? Promise.resolve().then(function () {
                return snippetReader().read(li, w[0] - pad, w[1] + pad, FIELDS); // a pad on each side: the filters start and end outside the window
            }) : Promise.reject(new Error(TEXT.noReader));
            read.then(function (data) {
                if (my !== seq) return null;
                if (!data || !data.t) throw new Error(TEXT.noRead);
                var n = data.t.length, i0 = 0, i1 = n;
                data.rate = isNum(data.rate) && data.rate > 0 ? data.rate : n > 1 ? (n - 1) / (data.t[n - 1] - data.t[0]) : null;
                while (i0 < n && data.t[i0] < w[0] - 1e-9) i0++;
                while (i1 > i0 && data.t[i1 - 1] > w[1] + 1e-9) i1--;
                data.i0 = i0; // the window without the pad
                data.i1 = i1;
                snap = data;
                readError = values = valuesError = null;
                drawCharts();
                renderValues();
                var cols = {};
                FIELDS.forEach(function (name) { if (data.cols && data.cols[name]) cols[name] = data.cols[name]; });
                // the pad as the worker drops it: the same number of samples on each side
                return derive("window", cols, data.rate, params(Math.min(i0, n - i1) / data.rate)).then(function (d) {
                    if (my !== seq) return;
                    values = d && typeof d === "object" ? d : {};
                    drawCharts(); // the tail limits can come from the values
                }, function (e) {
                    if (my === seq) valuesError = e instanceof Error ? e : new Error(message(e));
                }).then(function () {
                    if (my !== seq) return null;
                    renderValues();
                    return updateDetail(my);
                });
            }).catch(function (e) {
                if (my !== seq) return;
                snap = values = null;
                readError = e;
                renderValues();
            }).then(function () {
                if (my === seq) busy(false);
                inflight = false;
                if (again) refresh(); // the window of the last change
            });
        }

        // --- actions

        function byFid(fid) {
            return findings().filter(function (f) { return f.fid === fid; })[0] || null;
        }

        function showInLog(fid) {
            var f = byFid(fid), ev = f && f.evidence;
            if (!ev || !hooks.viewInLog) return;
            var v = ev.view || {}, s = overlapping([f], li, win[0], win[1])[0], span = s ? s.spans[0] : spansOf([f], li)[0];
            if (!span && !isNum(v.t0)) return;
            hooks.viewInLog({ log: isNum(v.log) ? v.log : li, fromS: isNum(v.t0) ? v.t0 : span.t0, toS: isNum(v.t1) ? v.t1 : span.t1,
                atS: isNum(v.at) ? v.at : undefined, graphs: v.graphs, analyser: v.analyser, title: headOf(f), text: summaryOf(f), from: "analysis" });
        }

        function start() {
            running = true;
            startError = null;
            renderNotice();
            var p;
            try {
                p = hooks.runAnalysis ? hooks.runAnalysis() : null;
            } catch (e) {
                p = Promise.reject(e);
            }
            if (p === false) p = Promise.reject(new Error(TEXT.startFailed)); // the Tuning view did not start a run (js/tuning_dialog.js runAnalysis)
            if (p && typeof p.then === "function") {
                p.then(function (r) {
                    if (r && typeof r === "object") self.setResult(r);
                    if (running && !result) { // a result that is not for this log: the button again
                        running = false;
                        renderNotice();
                    }
                }, function (e) {
                    running = false;
                    startError = e && e.reason === "replaced" ? null : e; // a run with other settings: no error
                    renderNotice();
                });
            }
        }

        // --- events

        function onDrag(e) {
            if (!drag) return;
            var t = timeAt(e);
            setWindow(t - drag.offset, t - drag.offset + drag.width, true);
        }

        function endDrag() {
            drag = null;
            document.removeEventListener("mousemove", onDrag);
            document.removeEventListener("mouseup", endDrag);
        }

        function within(e, sel) {
            return !!(e.target && e.target.closest && e.target.closest(sel));
        }

        // the two filters of the result list (SPEC3 E)
        root.addEventListener("change", function (e) {
            var t = e.target;
            if (t && t.getAttribute && t.getAttribute("data-lens-config")) { // the configuration menu: the Tuning view keeps it and says so (onConfiguration)
                if (hooks.setConfiguration) hooks.setConfiguration(String(t.value || "all"));
                if (typeof hooks.onConfiguration !== "function") configChanged();
                return;
            }
            if (!t || !t.getAttribute || !t.getAttribute("data-lens-rf")) return;
            var f = resultFilter();
            f[t.getAttribute("data-lens-rf") === "ok" ? "ok" : "thin"] = !!t.checked;
            if (hooks.setResultFilter) hooks.setResultFilter(f); // js/main.js saves it and calls the onResultFilter listeners
            else { localFilter = f; renderFindings(true); }
        });
        if (typeof hooks.onResultFilter === "function") hooks.onResultFilter(function () { renderFindings(true); });
        if (typeof hooks.onConfiguration === "function") hooks.onConfiguration(function () { configChanged(); });

        root.addEventListener("click", function (e) {
            var t = e.target && e.target.closest ? e.target.closest("[data-lens-act]") : null;
            if (!t) return;
            e.preventDefault();
            var act = t.getAttribute("data-lens-act");
            if (act === "start") start();
            else if (act === "show" || act === "compare") openDetail(t.getAttribute("data-arg"), act === "show" ? "values" : "findings");
            else if (act === "log") showInLog(t.getAttribute("data-fid"));
            else if (act === "close") closeDetail();
            else if (act === "flight") goTo(li, +String(t.getAttribute("data-arg")).split(",")[0], +String(t.getAttribute("data-arg")).split(",")[1]);
        });
        root.addEventListener("wheel", function (e) {
            if (!win || !within(e, "[data-lens-wheel]")) return;
            e.preventDefault();
            var s = wheelSteps(e);
            if (e.ctrlKey || e.metaKey) zoomBy(Math.pow(ZOOM, s));
            else panBy(PAN * s);
        }, { passive: false });
        root.addEventListener("mousedown", function (e) {
            if (e.button !== 0 || !win || !within(e, '[data-lens="timeline"]')) return;
            e.preventDefault();
            if (root.firstChild && root.firstChild.focus) root.firstChild.focus({ preventScroll: true });
            var t = timeAt(e), w = win[1] - win[0];
            if (!(t >= win[0] && t <= win[1])) setWindow(t - w / 2, t + w / 2, true);
            drag = { offset: t - win[0], width: win[1] - win[0] };
            document.addEventListener("mousemove", onDrag);
            document.addEventListener("mouseup", endDrag);
        });
        root.addEventListener("keydown", function (e) {
            if (!win || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target && e.target.tagName || "")) return;
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            panBy(e.key === "ArrowLeft" ? -PAN : PAN);
        });
        if (typeof ResizeObserver === "function") new ResizeObserver(function () { paintTimeline(); }).observe(el.timeline);
        if (typeof TuningPlot !== "undefined" && TuningPlot.onTextScale) TuningPlot.onTextScale(function () { paintTimeline(); }); // the strip charts are TuningPlots: they draw again by themselves

        // --- API

        this.show = function (flightLog) {
            visible = true;
            running = false; // a run that the Tuning view did not finish can start again
            var lg = (hooks.getFlightLog && hooks.getFlightLog()) || flightLog || null,
                i = hooks.getCurrentLogIndex ? hooks.getCurrentLogIndex() : null;
            if (!isNum(i)) i = lg ? lg.getLogIndex() : 0;
            if ((lg !== log || i !== li || !win) && !openLog(lg, i)) return;
            if (hooks.getResult) self.setResult(hooks.getResult());
            var v = viewerWindow();
            win = null; // the window of the viewer as it is now, with no write back
            setWindow(v ? v[0] : 0, v ? v[1] : Math.min(10, len), false);
            renderNotice();
            renderLegend();
            renderConfigMenu();
            renderFindings(true);
            refresh();
        };

        this.hide = function () {
            visible = false;
            clearTimeout(timer);
            timer = null;
            seq++; // answers on their way are dropped
            again = false;
            endDrag();
            busy(false);
        };

        // A TuningResult (null: none). It applies when it covers the open log; js/main.js and hooks.onResult can both give it
        this.setResult = function (r) {
            given = r || null;
            var next = covers(given) ? given : null;
            if (next) running = false;
            if (next === result) return;
            result = next;
            traceCache = null;
            if (detail && /^result:/.test(detail.key)) closeDetail(); // the plot of a result of the result before
            if (!log || !(len > 0) || !win) return;
            el.where.textContent = whereText(); // the PID profiles and phases of the result
            paintTimeline();
            renderEpochs();
            renderNotice();
            renderLegend();
            renderConfigMenu();
            renderFindings(true);
            schedule(); // the bands, the time delays and the tail limits of the result
        };

        // The window at a part of log `lg` (frame seconds): its start at t0 less 10 % of the window width, the width as it
        // is (a span of less than the width), or the span. The viewer follows. False for another log than the open one
        function goTo(lg, t0, t1) {
            if (!log || lg !== li || !win || !isNum(t0)) return false;
            var w = win[1] - win[0], span = isNum(t1) && t1 > t0 ? t1 - t0 : 0;
            if (span > 0 && span < w) setWindow(t0 - (w - span) / 2, t1 + (w - span) / 2, true);
            else setWindow(t0 - 0.1 * w, t0 + 0.9 * w, true);
            if (root.scrollIntoView) root.scrollIntoView({ block: "nearest" });
            return true;
        }
        this.goTo = goTo;

        // For test/log_lens.test.cjs: the window, and a move of it as a user makes it
        this.internals = { getWindow: function () { return win && win.slice(); }, setWindow: function (t0, t1) { setWindow(t0, t1, true); } };

        if (typeof hooks.onResult === "function") hooks.onResult(function (r) { self.setResult(r); });
    }

    function hexAlpha(hex, a) {
        var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
        return m ? "rgba(" + parseInt(m[1], 16) + "," + parseInt(m[2], 16) + "," + parseInt(m[3], 16) + "," + a + ")" : "rgba(255,255,255," + a + ")";
    }

    var LOG_COLORS = ["#fb8072", "#8dd3c7", "#ffffb3", "#80b1d3", "#fdb462", "#b3de69", "#bc80bd", "#d9d9d9"];

    // The plots of "Show in the log": one for each graph of req with the fields that data has (TuningSnippet.Reader: { t, cols }),
    // x from t0 to t1 (frame seconds), the spans of the result in that log shaded
    function logSpecs(f, req, data, t0, t1) {
        var ev = f.evidence || {}, cols = data.cols || {};
        var bands = (Array.isArray(ev.spans) ? ev.spans : []).filter(function (q) {
            return q && isNum(q.t0) && isNum(q.t1) && (isNum(q.log) ? q.log : req.log) === req.log && q.t1 > t0 && q.t0 < t1;
        }).slice(0, 60).map(function (q, i) { return { x0: Math.max(q.t0, t0), x1: Math.min(q.t1, t1), color: "rgba(77,168,218,0.18)", label: i ? "" : String(f.id || "") }; });
        var specs = req.graphs.map(function (names) {
            var series = names.filter(function (n) { return cols[n]; }).map(function (n, i) { return { name: n, x: data.t, y: cols[n], color: LOG_COLORS[i % LOG_COLORS.length], width: 1.2 }; });
            return { title: series.map(function (q) { return q.name; }).join(", "), y: {}, x: { min: t0, max: t1 }, series: series, bands: bands, legend: series.length > 1 };
        }).filter(function (q) { return q.series.length && data.t && data.t.length > 1; });
        if (specs.length) specs[specs.length - 1].x = { label: "time", unit: "s", min: t0, max: t1 };
        return specs;
    }

    // The two views read the same padded window, shade the evidence spans and show the same freshness flags.
    // The caller owns the panel and rejects late answers when it closes or changes the result.
    function logPreview(f, req, result, reader) {
        var pad = Math.max(0.05 * (req.toS - req.fromS), 0.1), t0 = Math.max(0, req.fromS - pad), t1 = req.toS + pad;
        var fields = req.graphs.reduce(function (a, g) { return a.concat(g.filter(function (n) { return a.indexOf(n) < 0; })); }, []);
        return {
            epochs: epochRowsHtml(windowEpochs(result, req.log, t0, t1), result, t0, t1),
            read: function () {
                return Promise.resolve().then(function () {
                    if (!reader) throw new Error("The app cannot read the data of this part of the log.");
                    return reader.read(req.log, t0, t1, fields);
                }).then(function (data) {
                    return { specs: logSpecs(f, req, data, t0, data.clipped ? data.t1 : t1),
                        missing: Array.isArray(data.missing) ? data.missing : [], clipped: !!data.clipped };
                });
            }
        };
    }

    // Shared inline panel markup. Action and canvas attributes are supplied by each view's own handlers and generated IDs.
    function logPreviewHtml(req, epochs, actions) {
        return '<div class="analysis-compare-head"><strong>Data from the log' +
            (req ? " " + esc("(log " + (req.log + 1) + ", " + sec(req.fromS) + " to " + sec(req.toS) + ")") : "") +
            '</strong><span>' + (actions.viewer ? '<button type="button" class="btn btn-default btn-xs" ' + actions.viewer + '>Open in the log viewer</button> ' : "") +
            '<button type="button" class="btn btn-default btn-xs" ' + actions.close + '>Close</button></span></div>' +
            (epochs ? '<div class="analysis-compare-epochs log-lens-epochs">' + epochs + "</div>" : "") +
            '<div class="analysis-compare-body tuning-log-body"><p class="analysis-muted">The app reads the data for the plot.</p></div>';
    }

    function logPreviewBody(data, canvases) {
        return (data.missing.length ? '<p class="analysis-muted">This log does not contain these fields: ' + data.missing.map(function (n) { return "<code>" + esc(n) + "</code>"; }).join(", ") + "</p>" : "") +
            (data.clipped ? '<p class="analysis-muted">The plot shows only the first 60 s.</p>' : "") +
            (!canvases.length ? '<p class="analysis-muted">The plot is not available.</p>' :
                canvases.map(function (attrs) { return '<div class="log-lens-plot"><canvas class="analysis-compare-canvas is-log" ' + attrs + "></canvas></div>"; }).join(""));
    }

    // Pure pieces, for test/log_lens.test.cjs and test/ste_text.test.cjs
    LogLens.internals = {
        TEXT: TEXT, logSpecs: logSpecs, logPreview: logPreview, logPreviewHtml: logPreviewHtml, logPreviewBody: logPreviewBody,
        LIMITS: LIMITS, OSC_BANDS: OSC_BANDS, STATUS: STATUS, MIN_S: MIN_S, MAX_S: MAX_S, PAN: PAN, ZOOM: ZOOM, DEBOUNCE_MS: DEBOUNCE_MS, FIELDS: FIELDS,
        esc: esc, valueSe: valueSe, limitOf: limitOf, valueOf: valueOf, clampWindow: clampWindow, wheelSteps: wheelSteps, statusOf: statusOf, overlapping: overlapping, spansOf: spansOf,
        chartOf: chartOf, detailKeyOf: detailKeyOf, windowRows: windowRows, chartSpec: chartSpec, drawTimeline: drawTimeline, DETAILS: DETAILS,
        amplitude: amplitude, fftSize: fftSize, runsOf: runsOf, filterRows: filterRows, filterBarHtml: filterBarHtml, textMetrics: textMetrics, windowProfiles: windowProfiles, timelineRows: timelineRows, PHASES: PHASES, PHASE_ORDER: PHASE_ORDER,
        notchKind: notchKind, notchFitOf: notchFitOf, notchSet: notchSet, unknownNotchText: unknownNotchText, armingOf: armingOf, startHtml: startHtml,
        EPOCH_REASONS: EPOCH_REASONS, EPOCH_CAUSE: EPOCH_CAUSE, EPOCH_ALPHA: EPOCH_ALPHA, EPOCH_ROWS: EPOCH_ROWS, cutAt: cutAt,
        // shared with js/analysis_view.js
        isNum: isNum, fmt: fmt, sec: sec, cap: cap, quoted: quoted, message: message, runErrorHtml: runErrorHtml, compareIds: compareIds, axisOf: axisOf, limitText: limitText,
        tableHtml: tableHtml, profileOf: profileOf, profileText: profileText, recordsOf: recordsOf, phasesOf: phasesOf, flightsOf: flightsOf, benchOf: benchOf,
        profileSpansOf: profileSpansOf, configsOf: configsOf, configSpansOf: configSpansOf, windowConfigs: windowConfigs, inConfig: inConfig, noDataOf: noDataOf, CONFIG_COLOR: CONFIG_COLOR,
        evidenceCompare: evidenceCompare, compareOut: compareOut, kit: kit, STATUS_COLOR: STATUS_COLOR,
        epochSpansOf: epochSpansOf, staleSpansOf: staleSpansOf, windowEpochs: windowEpochs, epochCauses: epochCauses, epochSource: epochSource, epochRowsHtml: epochRowsHtml
    };

    return LogLens;
})();
