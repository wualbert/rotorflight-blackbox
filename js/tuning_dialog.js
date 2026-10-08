"use strict";

/**
 * TuningDialog - the "Tuning" view.
 *
 * Runs the offline toolkit (tools/autotune, inside js/tuning_worker.js) on the open log or on every log in the file, then
 * shows the TuningResult: the Rotorflight tuning sequence as a diagram with a status for each step (result.hierarchy),
 * findings with their number, uncertainty and rule, recommendations with CLI text for the pilot to review, which
 * parameter groups could be assessed, and error curves drawn with TuningPlot. Each finding links to the part of the log
 * it comes from ("Show in the log", a preview of evidence.view with "Open in the log viewer") and to a plot of the measured behaviour against its limit
 * ("Show the measurement", its evidence.plot: from the result curves, or from a raw span read with
 * js/tuning_snippet.js and derived in the persistent derive worker).
 *
 * Built once in js/main.js against the jQuery-wrapped view (#viewTuning), a view at the level of the log viewer:
 * showView("tuning") makes it visible and calls show(), leaving it calls hide(). Hooks into the viewer:
 *   { viewInLog(req) (see showRequest), seek(us), selectLog(i) (both used only without viewInLog),
 *     getBytes() (the whole file: copied, never transferred), getFileName(), getCurrentLogIndex(), getFlightLog() }
 * read at each use: main.js replaces the file and its FlightLog on every load, also one dropped on the window while this
 * view is open.
 *
 * For the log lens (js/log_lens.js): getResult(), onResult(cb), runAnalysis() and derive(kind, cols, rate, params), the
 * persistent "derive" worker (js/tuning_worker.js, cmd "derive") that this view and the lens share.
 *
 * What the view reads of a TuningResult besides findings, advice and curves (SPEC2 3.6, D11-D13):
 *   hierarchy.graph       { nodes, edges, rules }: hierarchy.cjs NODES, EDGES and RULES, for the diagram
 *   hierarchy.byProfile   { "1": { nodes, startHere }, ... }: hierarchy.cjs status() of each PID profile ("0": unknown)
 *   records[].phases      [{ phase: idle | spoolup | ground | flight | spooldown, t0, t1 }], frame seconds
 *   records[].flights or flights   [{ (log,) t0, t1, seconds, method, confidence }], frame seconds
 *   benchRuns ([log] or [{ log }]) or records[].logClass "bench": logs with no flight, not in the analysis
 *   epochs, freshness     the parts of each log in which the values are possibly not the values of the log header, and the
 *                         caveat (js/tuning_worker.js freshnessOf); f.stale, f.events[].stale (L1-L7), d.stale and r.stale give
 *                         the mark "Values possibly different" on each result, period, decision and recommendation (freshnessHtml)
 * The "Export" tab asks the derive worker { cmd: "export", recs, picks: [recommendation ids], meta } for advice.cjs
 * exportScript(recs, picks, meta) and takes the answer { type: "exported", result: text }.
 *
 * Times: evidence spans and every request to the viewer are frame seconds from the log start (the viewer clock). The
 * modules and curves use index time (fromS + i / actualRate); toFrame converts with the worker's time map of the segment.
 *
 * Text is ASD-STE100 (docs/STE_GLOSSARY.md). Toolkit text that is not STE (the finding texts of the other modules,
 * thresholds, sources, worker messages) is shown in elements marked data-ste="quoted".
 *
 * Advice only: nothing is sent to a flight controller. Every string that comes from the log or the worker is escaped
 * before it becomes HTML.
 */
var TuningDialog = (function () {

    var AXES = ["roll", "pitch", "yaw"];

    // Rotorflight 4.6 governor states, as in lib.cjs govStateAt
    var GOV_STATES = ["OFF", "IDLE", "SPOOLUP", "RECOVERY", "ACTIVE", "HOLD", "FALLBACK", "AUTOROTATION", "BAILOUT", "BYPASS"];

    var SEVERITY_RANK = { error: 0, flag: 1, note: 2, ok: 3, skipped: 4 };

    // Checks whose notes report a measurement rather than a problem: the notes that tools/autotune/catalog.cjs status()
    // gives "information". Only for a finding without the worker's status (findingStatus); test/tuning_dialog.test.cjs
    // keeps it equal to the catalog. F10: a yaw note with a standard error is to monitor
    var REPORT_ONLY = { C8: 1, C9: 1, C13: 1, C14: 1, D2: 1, D3: 1, D5: 1, D6: 1, D7: 1, F10: 1, F11: 1, G0: 1, G7: 1, G8: 1, G14: 1, H: 1, P2: 1, R1: 1,
        SETUP: 1, T12: 1, T13: 1, T14: 1 };
    // A finding that is information at most (catalog.cjs statusOf): C10 without an axis, the rotor at flight speed on the ground
    // (SPEC3 F: slow to take off, never a problem)
    function infoOnly(f) {
        return (f.id === "C10" && !f.axis && !isThin(f)) || (f.id === "G20" && !isThin(f));   // G20: the cause of each FALLBACK, information
    }
    // D2 (catalog.cjs D2 statusOf, SPEC3 A): a problem only for 1 % of the frames or more missing at its time jumps; a smaller loss is
    // a value to monitor, a loop stall alone information. L7 (the collective stick at its end) and G11 (the throttle increase that
    // supplies the normal pack sag) are values to monitor at most
    function flagStatus(f) {
        if (f.id === "L7" || f.id === "G11") return "monitor";
        if (f.id !== "D2") return "problem";
        var lost = (Array.isArray(f.events) ? f.events : []).reduce(function (s, e) { return s + (e && /^time jump/.test(String(e.kind || "")) && isNum(e.value) ? e.value : 0); }, 0);
        return isNum(f.n) && f.n > 0 && lost / f.n >= 0.01 ? "problem" : lost > 0 ? "monitor" : "information";
    }

    // Status of a finding (SPEC2 D9; tools/autotune/catalog.cjs status() gives the same keys)
    var STATUS = {
        error: "Analysis error", problem: "Problem", monitor: "Monitor", satisfactory: "Satisfactory", information: "Information",
        insufficient: "Not sufficient data", notMeasured: "Not measured"
    };
    var STATUS_ORDER = ["error", "problem", "monitor", "satisfactory", "information", "insufficient", "notMeasured"];

    // Status of a step of the tuning sequence (tools/autotune/hierarchy.cjs status()); "start": a Problem in startHere
    var NODE_STATUS = {
        start: "Start here", problem: "Problem", blocked: "Blocked", possible: "Possible result", error: "Analysis error", monitor: "Monitor",
        notAccurate: "Not accurate (log rate)", insufficient: "Not sufficient data", information: "Information", satisfactory: "Satisfactory",
        notMeasured: "Not measured", notApplicable: "Not applicable"
    };
    var NODE_KEYS = {
        start: "start", starthere: "start", problem: "problem", blocked: "blocked", possible: "possible", possibleresult: "possible",
        error: "error", analysiserror: "error", monitor: "monitor", notaccurate: "notAccurate", notaccuratelograte: "notAccurate",
        inaccurate: "notAccurate", insufficient: "insufficient", notsufficientdata: "insufficient", information: "information", info: "information",
        satisfactory: "satisfactory", ok: "satisfactory", notmeasured: "notMeasured", notapplicable: "notApplicable", na: "notApplicable"
    };

    // The checklist before the first flight (SPEC3 A, hierarchy.cjs graph.prereq): the condition words and their classes.
    // The analysis accepts an item as correct: "Problem" only for a clear measured problem
    var PREREQ_STATUS = { ok: "No problem found", problem: "Problem", noData: "No data" };
    var PREREQ_CLASS = { ok: "ok", problem: "problem", noData: "nodata" };
    var PREREQ_NOTE = "The log shows only problems that the analysis can measure. Before the first flight, correct all items with a problem.";
    var PANEL_HINT = "Click a step or an item to show its checks and recommendations.";
    var LANE_LETTER = { cyclic: "a", tail: "b" };
    var PARAMS_SHOWN = 8; // parameter names in the box of a step; the side panel shows all

    // Check-list areas; findings are placed by check id, as in health_report's sections
    var AREAS = [
        { key: "data", title: "Data", re: /^(D\d+|H|SETUP)$/ },
        { key: "filters", title: "Filters", re: /^F\d+$/ },
        { key: "governor", title: "Governor and battery", re: /^G\d+$/ },
        { key: "cyclic", title: "Cyclic", re: /^C\d+$/ },
        { key: "tail", title: "Tail", re: /^T\d+$/ },
        { key: "rates", title: "Rates", re: /^R\d+$/ }
    ];
    var MODULE_AREA = { gov: "governor", loop: "cyclic", track: "cyclic" };
    var REC_AREA = {
        precondition: "data", logging: "data", mechanical: "data", filters: "filters", governor: "governor",
        tail: "tail", cyclic: "cyclic", rates: "rates"
    };
    var REC_AREA_LABEL = {
        precondition: "Data", logging: "Log", mechanical: "Mechanical", filters: "Filters", governor: "Governor", tail: "Tail", cyclic: "Cyclic", rates: "Rates"
    };
    var REC_SEVERITY = {
        action: { label: "Change", status: "problem", rank: 0 }, check: { label: "Check", status: "monitor", rank: 1 },
        watch: { label: "Monitor", status: "information", rank: 2 }, info: { label: "Information", status: "insufficient", rank: 3 }
    };
    // The label of advice.cjs `confidence`: how the analysis got the value of the change. "advisory" (the default of
    // advice.cjs rec(): the rule of the check gives the change) has no label. It is not the status "Not measured": most of
    // these recommendations come from measured results (V4)
    var CONFIDENCE = { measured: "Measured", predicted: "Calculated with the gain model", advisory: "" };
    var BENCH = "Bench run (no analysis)"; // a log with no flight (CLAUDE.md, docs/STE_GLOSSARY.md), as js/analysis_view.js TEXT.bench
    var NO_DATA = "No data that the app can read"; // a log with no data that the decoder can read (M4: records[].noData), as js/analysis_view.js TEXT.noData
    var DIRECTION = { raise: "increase", lower: "decrease", set: "set", check: "examine" };
    // advice.cjs coverage[].status. "not-in-log": the log header and the log data do not record the values (the log is the only
    // necessary input, user rule 2026-10-06); "not-assessable": no log can show the item (hierarchy.cjs COVERAGE)
    var COVERAGE = {
        finding: ["Result", "problem"], checked: ["Measured", "satisfactory"], "not-assessable": ["A log cannot show it", "insufficient"],
        "not-in-log": ["Not recorded in the log", "information"], "needs-fields": ["Log fields necessary", "information"],
        "needs-flights": ["More flights necessary", "information"], "no-check": ["No check in the app", "insufficient"]
    };

    // The phases of a flight log (SPEC2 D13), in the sequence of a flight
    var PHASES = [["idle", "idle"], ["spoolup", "spool-up"], ["ground", "on the ground"], ["flight", "flight"], ["spooldown", "spool-down"]];

    var TABS = [
        { key: "overview", title: "Overview" },
        { key: "filters", title: "Filters", step: true },
        { key: "governor", title: "Governor", step: true },
        { key: "cyclic", title: "Cyclic gains", step: true },
        { key: "tail", title: "Tail gains", step: true },
        { key: "cycomp", title: "Cyclic compensation", step: true },
        { key: "tailcomp", title: "Tail compensation and authority", step: true },
        { key: "recs", title: "Recommendations", auxiliary: true }, { key: "curves", title: "Error curves", auxiliary: true },
        { key: "checks", title: "All checks", auxiliary: true }, { key: "configs", title: "Configurations", auxiliary: true },
        { key: "coverage", title: "Parameter groups", auxiliary: true },
        { key: "export", title: "Export" }
    ];

    // ASD-STE100 rule 7: a warning starts with an instruction; a note gives information only
    var WARNING = "Examine each change before you set it in the flight controller. After each change, do a hover test in a safe area. " +
        "Incorrect gains or filters can cause oscillations that you cannot control. The rotor blades can cause injury.";
    var NO_SEND = "This app does not send data to the flight controller.";
    var LOW_RATE = "If the log rate is less than 1 kHz, the log does not show the rotor and tail harmonics correctly. " +
        "Thus, the vibration, D-term and gain results are not accurate. Record the log at 1 kHz or more (refer to check D1).";
    var T_MAX_SE = 0.2; // largest random error of |T| and its phase that the response plots draw as measured

    // Plot colours: GraphConfig.PALETTE on the dark plot surface
    var C = {
        roll: "#fb8072", pitch: "#8dd3c7", yaw: "#ffffb3", blue: "#80b1d3", orange: "#fdb462", green: "#b3de69",
        purple: "#bc80bd", grey: "#d9d9d9", ref: "rgba(255,255,255,0.45)", limit: "#fb8072",
        unusable: "rgba(255,255,255,0.07)", stick: "rgba(128,177,211,0.14)", band: "rgba(253,180,98,0.12)", dyn: "rgba(188,128,189,0.16)",
        span: "rgba(253,180,98,0.2)"
    };
    var SERIES_COLORS = [C.blue, C.orange, C.green, C.purple, C.roll, C.pitch, C.yaw, C.grey];
    var STATUS_COLOR = {
        error: "#ff5a4f", problem: "#c9483f", monitor: "#d99a1f", satisfactory: "#3c9d40", information: "#3a7fc1", insufficient: "#b0b0b0", notMeasured: "#b0b0b0"
    };
    var STATE_BAND = [ // by governor state; ACTIVE is not shaded
        "rgba(255,255,255,0.06)", "rgba(255,255,255,0.06)", "rgba(128,177,211,0.18)", "rgba(141,211,199,0.18)", null,
        "rgba(253,180,98,0.18)", "rgba(251,128,114,0.25)", "rgba(188,128,189,0.22)", "rgba(251,128,114,0.32)", "rgba(255,255,255,0.1)"
    ];

    // The names of curve series for "Show the measurement" (health_track and health_more curves())
    var SERIES_NAME = {
        sp: "setpoint", err: "error", errComp: "error without the time delay", osc: "oscillation amplitude", ee: "error spectrum",
        rr: "setpoint spectrum", yy: "gyro spectrum", ratio: "error / setpoint", Tmag: "T amplitude", Tdeg: "phase of T", coh: "coherence",
        raw: "gyroRAW", filt: "gyroADC", pass: "transmission", psd: "PSD", hs: "headspeed", target: "governor target", errPct: "headspeed error",
        throttle: "throttle", coll: "collective", phaseDeg: "phase"
    };
    var SERIES_UNIT = { sp: "deg/s", err: "deg/s", errComp: "deg/s", osc: "deg/s", raw: "deg/s", filt: "deg/s", hs: "rpm", target: "rpm",
        errPct: "%", throttle: "%", coll: "‰", Tdeg: "deg", phaseDeg: "deg", u: "‰" };
    var CURVE_PICK = {
        spectrum: ["raw", "filt", "psd", "ee", "rr", "ratio"], transmission: ["pass", "Tmag"], phase: ["Tdeg", "phaseDeg"],
        governor: ["hs", "target", "errPct", "throttle"], time: ["sp", "err", "errComp", "osc", "hs", "target", "errPct", "throttle", "coll"]
    };

    var CACHE_MAX = 6, instances = 0;
    var SPAN_S = 2;        // "Show in the log" of a finding time that has no evidence: that time +- SPAN_S
    var COMPARE_S = 12;    // a raw read for "Show the measurement": 12 s or less (js/tuning_snippet.js CALL_S)
    var DERIVE_MS = 30000; // a derive request without an answer after this is an error

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

    // Display labels only. Keep the firmware names in tooltips and in executable CLI text.
    var PARAM_LABELS = {
        blackbox_rate_denom: "Log rate", pid_process_denom: "PID loop rate", blackbox_device: "Log storage",
        gyro_lpf1_dyn_min_hz: "Gyro low-pass filter 1 minimum cutoff", gyro_lpf1_dyn_max_hz: "Gyro low-pass filter 1 maximum cutoff",
        rc_center: "Stick center", rc_deflection: "Stick deflection", rc_smoothness: "Stick smoothing",
        vbat_min_cell_voltage: "Minimum cell voltage", vbat_warning_cell_voltage: "Cell voltage warning",
        vbat_max_cell_voltage: "Maximum cell voltage", freq_input_minhz: "Minimum RPM sensor frequency",
        dshot_bidir: "Bidirectional DShot", main_rotor_dir: "Main rotor direction",
        swash_geo_correction: "Swash geometry correction", rates_type: "Rate type",
        gov_use_voltage_comp: "Governor voltage compensation", gov_use_pid_spoolup: "Governor PID during spool-up",
        gov_use_fallback_precomp: "Governor fallback precompensation", gov_auto_throttle: "Autorotation throttle",
        gov_pwr_filter: "Governor power filter", gov_ff_filter: "Governor feedforward filter",
        "feature RPM_FILTER": "RPM notch filters", "feature DYN_NOTCH": "Dynamic notch filter",
        "feature FREQ_SENSOR": "RPM sensor", "mixer input SR": "Roll output range", "mixer input SP": "Pitch output range",
        "mixer input SC": "Collective output range", "mixer input SY": "Tail output range"
    };
    var PARAM_WORDS = {
        gov: "governor", pid: "PID", rpm: "RPM", rc: "stick", acc: "accelerometer", ff: "feedforward", iterm: "I-term",
        p: "P", i: "I", d: "D", f: "F", b: "B", o: "O", q: "Q", tta: "tail torque assist",
        lpf: "low-pass filter", lpf1: "low-pass filter 1", lpf2: "low-pass filter 2", notch: "notch filter", notch1: "notch filter 1", notch2: "notch filter 2",
        dyn: "dynamic", static: "constant", hz: "frequency", min: "minimum", max: "maximum", pos: "positive", neg: "negative",
        cw: "CW", ccw: "CCW", precomp: "precompensation", comp: "compensation", decay: "decrease", accel: "acceleration",
        spoolup: "spool-up", spooldown: "spool-down", startup: "start", timeout: "time limit", pwm: "PWM", sp: "setpoint"
    };

    function parameterLabel(name) {
        name = String(name || "");
        if (Object.prototype.hasOwnProperty.call(PARAM_LABELS, name)) return PARAM_LABELS[name];
        if (/^servo\s/.test(name)) return "Servo limits and speed";
        var gain = /^(roll|pitch|yaw|gov)_([pidfbo])_gain$/.exec(name);
        if (gain) return (gain[1] === "gov" ? "Governor" : gain[1].charAt(0).toUpperCase() + gain[1].slice(1)) + " " + gain[2].toUpperCase();
        var family = /^\{(pitch,roll|roll,pitch)\}_\{([a-z,]+)\}_gain$/.exec(name);
        if (family) return "Pitch and roll " + family[2].toUpperCase().split(",").join(", ");
        var label = name.replace(/^feature /, "").replace(/^dyn_notch_/, "dynamic_notch_").replace(/_/g, " ").toLowerCase().split(/\s+/).map(function (word) {
            return Object.prototype.hasOwnProperty.call(PARAM_WORDS, word) ? PARAM_WORDS[word] : word;
        }).join(" ");
        return label.charAt(0).toUpperCase() + label.slice(1);
    }

    function parameterHtml(name) {
        return '<span class="tuning-param" title="' + esc(name) + '">' + esc(parameterLabel(name)) + "</span>";
    }

    function recommendationTitle(rec) {
        return String(rec.title || "").replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, parameterLabel);
    }

    function isNum(v) {
        return typeof v === "number" && isFinite(v);
    }

    function isSeries(v) {
        return !!v && typeof v === "object" && typeof v.length === "number" && v.length > 1 && (Array.isArray(v) || ArrayBuffer.isView(v));
    }

    function num(v) {
        if (v === null || v === undefined) return "";
        if (typeof v === "boolean") return v ? "yes" : "no";
        if (Array.isArray(v)) return v.map(num).join(", ");
        if (typeof v !== "number") return String(v);
        if (!isFinite(v)) return "n/a";
        if (Number.isInteger(v) || Math.abs(v) >= 1e4) return String(Math.round(v));
        return String(+v.toPrecision(4));
    }

    // value ± se, both to the second significant digit of the standard error
    function valueSe(v, se, unit) {
        var s = num(v);
        if (isNum(v) && isNum(se) && se > 0) {
            var d = Math.max(0, Math.min(8, 1 - Math.floor(Math.log10(se))));
            s = v.toFixed(d) + " ± " + se.toFixed(d);
        }
        return isNum(v) && unit ? s + " " + unit : s;
    }

    // Thresholds come as text, a number or a whole RULES entry
    function threshold(t) {
        if (t && typeof t === "object" && !Array.isArray(t)) {
            return Object.keys(t).filter(function (k) { return k !== "source" && k !== "note"; })
                .map(function (k) { return k + " " + num(t[k]); }).join(", ");
        }
        return num(t);
    }

    function secs(s) {
        if (!isNum(s)) return "";
        return s >= 120 ? (s / 60).toFixed(1) + " min" : s.toFixed(1) + " s";
    }

    function clock(ms) {
        var s = Math.max(0, Math.round(ms / 1000));
        return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
    }

    // The toolkit numbers logs from 0, the viewer's log picker from 1
    function logLabel(log) {
        if (typeof log === "number") return String(log + 1);
        if (Array.isArray(log)) return log.map(logLabel).join(", ");
        return log === null || log === undefined ? "" : String(log);
    }

    // Log profile numbers count from 1 as in the Configurator (CLI index + 1); 0 = the arming profile, not in the log
    function profileLabel(p) {
        if (typeof p === "number") return p > 0 ? "PID profile " + p : "PID profile unknown";
        return p === null || p === undefined ? "" : String(p);
    }

    // The PID profile that the STE summary of a finding gives: the worker's display.profile ("PID profile 2", "PID profile
    // unknown", null: not for one PID profile), the label of catalog.cjs format(). undefined: the finding has no display
    function saidProfile(x) {
        var d = x.display && typeof x.display === "object" && "profile" in x.display ? x.display.profile : undefined, m;
        if (typeof d === "string") return (m = /^PID profile ([1-9]\d*)$/.exec(d)) ? +m[1] : 0;
        return d === null ? null : undefined;
    }

    // The PID profile of a finding or a recommendation (SPEC2 D12), numbered as the Configurator does (1 to 6). 0: the
    // arming profile, which the log does not record before the first switch ("arm" in some results). null: the item is
    // not for one PID profile (a header check, a global parameter, a result of all PID profiles together: advice.cjs
    // profile null). One label for each row (D-M2): the worker's pidProfile first (it sets one only when it knows the
    // PID profile, null when it does not), then the label of the worker's summary. A row never shows a PID profile next to
    // a summary that says "PID profile unknown". D4 (health_setup) gives the CLI index. F4 keeps its axis in `profile`
    function profileNo(x) {
        if (!x) return null;
        var p = x.profile, said = saidProfile(x), legacy;
        if (x.id === "D4") return isNum(x.pidProfile) && x.pidProfile > 0 ? x.pidProfile : isNum(p) && p >= 0 ? p + 1 : null;
        if (isNum(x.pidProfile) && x.pidProfile > 0) return said === 0 ? 0 : x.pidProfile;
        legacy = said !== undefined ? said : labelProfile(x);
        return x.pidProfile === null && legacy !== null ? 0 : legacy; // the worker does not know the PID profile: unknown
    }

    // The PID profile of an item from its own labels (a result without the worker's pidProfile and display, a recommendation)
    function labelProfile(x) {
        var p = x.profile;
        if (p === "arm") return 0;
        if (typeof p === "string" && /^\d+$/.test(p)) p = +p;
        if (isNum(p)) return p >= 0 ? p : null;
        if (x.scope === "global") return null;
        if (x.scope === "profile" && isNum(x.cliProfile)) return x.cliProfile + 1; // the section of its CLI text
        var ev = evidenceProfiles(x); // a recommendation: the PID profile of its evidence rows; with several, see profileText
        if (ev.length) return ev.length === 1 ? ev[0] : null;
        if (x.scope === "profile" && x.profile === undefined) return 0; // a PID profile item with no profile field: unknown (advice.cjs gives 0)
        return null;
    }

    // The PID profiles of the evidence rows of a recommendation (not of a rate profile item), 0 last
    function evidenceProfiles(x) {
        var out = [];
        if (x && Array.isArray(x.evidence) && x.scope !== "rateprofile") x.evidence.forEach(function (e) {
            var q = profileNo(e);
            if (q !== null && out.indexOf(q) < 0) out.push(q);
        });
        return out.sort(function (a, b) { return (a === 0) - (b === 0) || a - b; });
    }

    // "PID profile 2", "PID profile unknown"; an item for all PID profiles says so, a rate profile item names its rate profile
    function profileText(x) {
        if (x && x.scope === "rateprofile") return "rate profile " + (rateProfileOf(x) || "unknown");
        var p = profileNo(x), several = p === null ? evidenceProfiles(x) : [];
        if (several.length > 1) {
            var known = several.filter(function (q) { return q > 0; }).map(String);
            return [known.length ? (known.length > 1 ? "PID profiles " + known.slice(0, -1).join(", ") + " and " + known[known.length - 1] : "PID profile " + known[0]) : "",
                several.indexOf(0) >= 0 ? "PID profile unknown" : ""].filter(Boolean).join(", ");
        }
        return p === null ? "All PID profiles" : profileLabel(p);
    }

    // The rate profile of a recommendation (1 to 6): advice.cjs rateProfile, else its CLI index + 1; null when unknown
    function rateProfileOf(rec) {
        return isNum(rec.rateProfile) && rec.rateProfile > 0 ? rec.rateProfile : isNum(rec.cliProfile) ? rec.cliProfile + 1 : null;
    }

    // The view shows all PID profiles ("all") or one (a number): an item for no single PID profile shows in each
    function inProfile(x, sel) {
        if (sel === "all" || sel === null || sel === undefined) return true;
        var p = profileNo(x), several = p === null ? evidenceProfiles(x) : [];
        return p === sel || (p === null && (several.length < 2 || several.indexOf(sel) >= 0));
    }

    // Where a finding applies: its PID profile (SPEC2 D12: on every row), axis and phase (D13); F4 keeps its axis in `profile`
    function findingWhere(f, sep) {
        var axis = f.axis || (typeof f.profile === "string" && AXES.indexOf(f.profile) >= 0 ? f.profile : null);
        var phase = PHASES.filter(function (p) { return p[0] === f.phase; })[0];
        return [profileText(f), typeof f.dataset === "string" && f.dataset ? "Configuration " + f.dataset : null, axis, phase ? phase[1] : null].filter(Boolean).join(sep);
    }

    function oneLine(s) {
        return String(s === null || s === undefined ? "" : s).replace(/\s+/g, " ").trim();
    }

    function cap(s) {
        s = String(s || "");
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function plural(n, word) {
        return n + " " + word + (n === 1 ? "" : "s");
    }

    function countBy(list, key) {
        var out = {};
        list.forEach(function (x) { out[x[key]] = (out[x[key]] || 0) + 1; });
        return out;
    }

    // "Problem 2 · Monitor 1 · Satisfactory 4": the status of each finding, in STATUS_ORDER
    function statusCounts(findings) {
        var c = {};
        findings.forEach(function (f) { var s = findingStatus(f); c[s] = (c[s] || 0) + 1; });
        return STATUS_ORDER.filter(function (s) { return c[s]; }).map(function (s) { return STATUS[s] + " " + c[s]; }).join(" · ");
    }

    // FNV-1a; over bytes spread through a file it tells two files of one name and size apart
    function fnv(n, at, step) {
        var h = 0x811c9dc5;
        for (var i = 0; i < n; i += step) {
            h ^= at(i) & 0xff;
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16);
    }

    // ---------------------------------------------------------------------------------------------
    // Findings and recommendations

    // D5: our modules mark a note without sufficient data with `thin`; the other modules write "no finding"
    function isThin(f) {
        return !!f.thin || /^no finding/i.test(String(f.text || ""));
    }

    // The status of a finding: the worker's (catalog.cjs status, after explain), else from its severity
    function findingStatus(f) {
        if (typeof f.status === "string" && STATUS.hasOwnProperty(f.status)) return f.status;
        switch (f.severity) {
            case "error": return "error";
            case "flag": return f.explained || infoOnly(f) ? "information" : flagStatus(f); // explained: the worker found every recommendation on it is information
            case "ok": return "satisfactory";
            case "note":
                if (isThin(f)) return "insufficient";
                if (infoOnly(f)) return "information";
                if (f.id === "F10") return f.axis === "yaw" && isNum(f.se) ? "monitor" : "information";
                return REPORT_ONLY[f.id] ? "information" : "monitor";
            case "skipped": return "notMeasured";
            default: return "insufficient";
        }
    }

    // The STE sentence of a finding (the worker's catalog.summary), else a label from its status
    function summaryOf(f) {
        if (f.summary) return String(f.summary);
        if (f.evidence && f.evidence.summary) return String(f.evidence.summary);
        return "Check " + f.id + (findingAxis(f) ? ", " + findingAxis(f) : "") + ": " + STATUS[findingStatus(f)] + ".";
    }

    function areaOf(f) {
        var id = String(f.id);
        for (var i = 0; i < AREAS.length; i++) {
            if (AREAS[i].re.test(id)) return AREAS[i].key;
        }
        return MODULE_AREA[f.module] || "data";
    }

    function worstStatus(findings) {
        var seen = {};
        findings.forEach(function (f) { seen[findingStatus(f)] = true; });
        return STATUS_ORDER.filter(function (s) { return seen[s]; })[0] || "insufficient";
    }

    // Navigation reports outstanding results, independent of which tab was visited
    // or which proposed changes were selected. Missing checks cannot turn green.
    function tabStatus(states) {
        var counts = {}, order = ['error', 'problem', 'monitor', 'insufficient', 'notMeasured', 'satisfactory', 'information'];
        states.forEach(function (s) { counts[s] = (counts[s] || 0) + 1; });
        var key = order.find(function (s) { return counts[s]; }) || 'notMeasured';
        var counted = /^(error|problem|monitor)$/.test(key);
        return { key: key, label: STATUS[key] + (counted ? ' (' + counts[key] + ')' : '') };
    }

    function onLog(f, li) {
        return f.log === li || (Array.isArray(f.log) && f.log.indexOf(li) >= 0);
    }

    // The axis a finding is about: a tail check without one (T14 yaw at headspeed ramps, T8 ...) is a yaw check
    function findingAxis(f) {
        return f.axis || (/^T\d+$/.test(String(f.id)) ? "yaw" : null);
    }

    // Natural order of check ids: G2 before G10
    function compareIds(a, b) {
        var x = /^(\D*)(\d*)(.*)$/.exec(String(a)), y = /^(\D*)(\d*)(.*)$/.exec(String(b));
        if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
        if (x[2] !== y[2]) return (x[2] === "" ? -1 : +x[2]) - (y[2] === "" ? -1 : +y[2]);
        return x[3] < y[3] ? -1 : x[3] > y[3] ? 1 : 0;
    }

    function firstLog(f) {
        return typeof f.log === "number" ? f.log : Array.isArray(f.log) && f.log.length ? f.log[0] : Infinity;
    }

    function rankOf(f) {
        return f.severity in SEVERITY_RANK ? SEVERITY_RANK[f.severity] : 9;
    }

    var SORTS = {
        severity: function (a, b) { return rankOf(a) - rankOf(b) || compareIds(a.id, b.id) || firstLog(a) - firstLog(b); },
        id: function (a, b) { return compareIds(a.id, b.id) || firstLog(a) - firstLog(b); },
        log: function (a, b) { return firstLog(a) - firstLog(b) || rankOf(a) - rankOf(b) || compareIds(a.id, b.id); },
        value: function (a, b) { return (isNum(a.value) ? a.value : Infinity) - (isNum(b.value) ? b.value : Infinity) || compareIds(a.id, b.id); }
    };

    function recsOf(result, dataset) {
        var adv = result.advice, own = adv && adv.byDataset && adv.byDataset[dataset];
        var recs = own ? own.slice() : adv && Array.isArray(adv.recommendations) ? adv.recommendations.slice() : [];
        function rank(r) { return (REC_SEVERITY[r.severity] || REC_SEVERITY.info).rank; }
        return recs.sort(function (a, b) {
            return (isNum(a.order) ? a.order : 1e9) - (isNum(b.order) ? b.order : 1e9) || rank(a) - rank(b);
        });
    }

    // A gate of the tuning sequence holds the item back until an upstream step is correct: no CLI, nothing to do now
    function isBlocked(rec) {
        return Array.isArray(rec.blockedBy) && rec.blockedBy.length > 0;
    }

    // advice.cjs causes: [{ rule, name, fids, first }], the K rules that make this item a possible result of another
    function causesOf(rec) {
        return Array.isArray(rec.causes) ? rec.causes.filter(function (c) { return c && typeof c === "object"; }) : [];
    }

    // A cause holds the item (advice.cjs causes[].holds): no CLI text until it is corrected. A cause of a watch item does not
    function heldByCause(rec) {
        return causesOf(rec).some(function (c) { return c.holds !== false; });
    }

    // CLI text to show and to export: none while a gate or a cause holds the item, none for an unknown PID profile (D12)
    function hasCli(rec) {
        return Array.isArray(rec.cli) && rec.cli.length > 0 && !isBlocked(rec) && !heldByCause(rec) && profileNo(rec) !== 0;
    }

    // Why a recommendation has no CLI text, and thus is not in the CLI file
    function noCliText(rec) {
        if (isBlocked(rec)) return 'This recommendation has no CLI text. First, correct the steps in the "Blocked" list. Then start the analysis again.';
        if (heldByCause(rec)) return "This recommendation has no CLI text. Correct the cause first. Then start the analysis again.";
        if (profileNo(rec) === 0) return "The PID profile of this recommendation is unknown. Thus, it has no CLI text.";
        return "This recommendation has no CLI text.";
    }

    // The badges of a recommendation: its kind, then "Blocked" or "Possible result" when a gate or a cause holds it
    function recBadges(rec) {
        var sev = REC_SEVERITY[rec.severity] || REC_SEVERITY.info, out = [badge(sev.label, isBlocked(rec) && sev.status === "problem" ? "monitor" : sev.status)];
        if (isBlocked(rec)) out.push(badge("Blocked", "blocked"));
        if (causesOf(rec).length) out.push(badge("Possible result", "possible"));
        if (staleOf(rec)) out.push(staleBadge(staleOf(rec))); // r.stale: its results use values that are possibly not the values of the log header
        return out.join(" ");
    }

    // "(PID profile 1): 60 to 72 (increase)"; the CLI index shows only in the CLI text
    function paramText(rec) {
        var where = rec.scope === "profile" || rec.scope === "rateprofile" ? profileText(rec) : rec.scope === "global" ? "all PID profiles" : "";
        var from = rec.from === null || rec.from === undefined ? "" : num(rec.from),
            to = rec.to === null || rec.to === undefined ? "" : num(rec.to),
            dir = DIRECTION[rec.direction] || (rec.direction ? String(rec.direction) : ""),
            change = from && to ? from + " to " + to : from ? "value " + from : to ? "to " + to : "",
            how = change ? change + (dir ? " (" + dir + ")" : "") : dir;
        return (where ? "(" + where + ")" : "") + (how ? ": " + how : "");
    }

    // A report.cjs decision: { text (STE), quoted (the toolkit's reason, not STE) }
    function decisionOutcome(d) {
        if (!d.change) return { text: "No change.", quoted: oneLine(d.reason) };
        var steps = (d.changes || []).map(function (s) {
            return s.gain + " ×" + num(s.multiplier) + " (" + num(isNum(s.from) ? +s.from.toFixed(1) : s.from) + " to " +
                num(isNum(s.to) ? +s.to.toFixed(1) : s.to) + ")";
        }).join(", ");
        var tracking = Array.isArray(d.tracking) ? " Tracking error " + num(d.tracking[0]) + " to " + num(d.tracking[1]) + " deg/s." : "";
        var sigma = isNum(d.dTrack) && isNum(d.seTrack) && d.seTrack > 0 ?
            " Decrease " + valueSe(d.dTrack, d.seTrack) + " deg/s (" + (d.dTrack / d.seTrack).toFixed(1) + " SE)." : "";
        return { text: steps + "." + tracking + sigma, quoted: "" };
    }

    // ---------------------------------------------------------------------------------------------
    // Log and record summaries

    function headerRate(sc) {
        var r = sc ? 1e6 / sc.looptime * sc.frameIntervalPNum / sc.frameIntervalPDenom / (sc.pid_process_denom || 1) : NaN;
        return isFinite(r) && r > 0 ? r : null;
    }

    // The records of one log, merged over its segments
    function logRecord(result, li) {
        var out = null;
        (result.records || []).forEach(function (r) {
            if (r.log !== li) return;
            if (!out) out = { durationS: r.durationS, flown: false, flyingS: 0, normalS: null, rate: r.rate, actualRate: r.actualRate, profileSeconds: {}, targetOf: {}, excluded: {} };
            out.flown = out.flown || !!r.flown;
            out.flyingS += r.flyingS || 0;
            if (isNum(r.normalS)) out.normalS = (out.normalS || 0) + r.normalS; // s of usual flight left by excludeAbnormal; null without it
            ["profileSeconds", "excluded", "targetOf"].forEach(function (k) {
                var src = r[k] || {};
                Object.keys(src).forEach(function (p) {
                    if (isNum(src[p])) out[k][p] = k === "targetOf" ? src[p] : (out[k][p] || 0) + src[p];
                });
            });
        });
        return out;
    }

    // The flights and phases of each log (SPEC2 D13), in frame seconds: { logs: { [log]: { log, bench, flights: [{ t0, t1,
    // seconds, method, confidence }], phaseS: { idle, spoolup, ground, flight, spooldown } } }, flights, flightLogs, bench }
    // from records[].phaseSeconds or records[].phases ([{ phase, t0, t1 }]), records[].flights or result.flights ([{ log,
    // t0, t1, ... }]) and the bench runs (result.benchRuns: [log] or [{ log, durationS, ... }], or records[].logClass
    // "bench"). A log with no data that the decoder can read (records[].noData, M4: with the decoder's reason) has noData and
    // why. null when the result has none of these
    function flightsOf(result) {
        var recs = result.records || [], top = Array.isArray(result.flights) ? result.flights : null, benchList = Array.isArray(result.benchRuns) ? result.benchRuns : null,
            empty = Array.isArray(result.noData) ? result.noData.filter(function (q) { return q && isNum(q.log); }) : []; // M4: [{ log, reason }]
        var known = (top && top.length) || (benchList && benchList.length) || empty.length || recs.some(function (r) {
            return r.logClass || r.noData || (Array.isArray(r.phases) && r.phases.length) || (Array.isArray(r.flights) && r.flights.length) || (r.phaseSeconds && typeof r.phaseSeconds === "object");
        });
        if (!known) return null;
        var logs = {}, out = { logs: logs, flights: 0, flightLogs: 0, bench: 0, noData: 0 };
        function at(li) {
            return logs[li] || (logs[li] = { log: li, bench: false, noData: false, why: null, flights: [], phaseS: {} });
        }
        function flight(li, f) {
            if (!f || !isNum(f.t0) || !isNum(f.t1)) return;
            var t0 = Math.min(f.t0, f.t1), t1 = Math.max(f.t0, f.t1);
            at(li).flights.push({ t0: t0, t1: t1, seconds: isNum(f.seconds) ? f.seconds : t1 - t0, method: f.method || null, confidence: isNum(f.confidence) ? f.confidence : null });
        }
        recs.forEach(function (r) {
            if (!isNum(r.log)) return;
            var L = at(r.log), ps = r.phaseSeconds && typeof r.phaseSeconds === "object" ? r.phaseSeconds : null;
            if (r.logClass === "bench") L.bench = true;
            if (r.noData) { L.noData = true; L.why = L.why || noDataWhy(r); }
            if (ps) Object.keys(ps).forEach(function (k) { if (isNum(ps[k])) L.phaseS[k] = (L.phaseS[k] || 0) + ps[k]; }); // the worker's sums
            else (Array.isArray(r.phases) ? r.phases : []).forEach(function (p) {
                if (p && isNum(p.t0) && isNum(p.t1)) L.phaseS[p.phase] = (L.phaseS[p.phase] || 0) + Math.abs(p.t1 - p.t0);
            });
            if (!top) (Array.isArray(r.flights) ? r.flights : []).forEach(function (f) { flight(r.log, f); });
        });
        (top || []).forEach(function (f) { if (f && isNum(f.log)) flight(f.log, f); });
        (benchList || []).forEach(function (b) {
            var li = isNum(b) ? b : b && isNum(b.log) ? b.log : null;
            if (li !== null) at(li).bench = true;
        });
        empty.forEach(function (q) {
            var L = at(q.log);
            L.noData = true;
            L.why = L.why || (typeof q.reason === "string" && q.reason.trim() ? oneLine(q.reason) : null);
        });
        Object.keys(logs).forEach(function (k) {
            var L = logs[k];
            L.flights.sort(function (a, b) { return a.t0 - b.t0; });
            if (L.noData) { L.bench = false; out.noData++; } // no data: neither a flight log nor a bench run
            else if (L.bench) out.bench++;
            else if (L.flights.length) { out.flights += L.flights.length; out.flightLogs++; }
        });
        return out;
    }

    // The decoder's reason of a record with no data (M4), or null: toolkit text, which the views show quoted
    function noDataWhy(r) {
        var w = r && (r.noDataReason || r.reason || r.error || (r.errors && typeof r.errors === "object" ? r.errors.decode : null));
        return typeof w === "string" && w.trim() ? oneLine(w) : null;
    }

    // "No data that the app can read", then the reason of the decoder (toolkit text: quoted, the full text on hover), as HTML
    function noDataHtml(L, prefix) {
        var why = L && L.why ? oneLine(L.why) : "";
        return '<span class="tuning-nodata">' + esc((prefix || "") + NO_DATA) + "</span>" +
            (why ? ' <span class="tuning-muted tuning-nodata-why" data-ste="quoted" title="' + esc(why) + '">(' + esc(why.length > 60 ? why.slice(0, 57) + "..." : why) + ")</span>" : "");
    }

    // "idle 5.0 s · spool-up 6.1 s · on the ground 3.2 s · flight 72.7 s · spool-down 4.0 s"
    function phasesText(phaseS) {
        return PHASES.filter(function (p) { return phaseS[p[0]] >= 0.05; }).map(function (p) { return p[1] + " " + secs(phaseS[p[0]]); }).join(" · ");
    }

    // The flights and phases for the context bar (SPEC2 D13). One log: its flights (links to the log viewer) and its phases.
    // The file: "N flights in M logs" and the bench runs, with a line for each log. HTML, escaped. A bench run has the label
    // of the Analysis view and of docs/STE_GLOSSARY.md: "Bench run (no analysis)"
    function flightsHtml(fl, r, li) {
        function links(L) {
            return L.flights.map(function (f, i) {
                return '<a href="#" class="tuning-flight" data-log="' + L.log + '" data-t0="' + f.t0 + '" data-t1="' + f.t1 + '" data-title="' + esc("Flight " + (i + 1) + ", log " + (L.log + 1)) +
                    '" title="Show this flight in the log">' + esc(num(+f.t0.toFixed(1)) + " s to " + num(+f.t1.toFixed(1)) + " s") + "</a>";
            }).join(", ");
        }
        function benchText(L) {
            return "Log " + (L.log + 1) + ": " + BENCH;
        }
        if (!fileLike(r)) {
            var L = fl.logs[li];
            if (!L) return [];
            if (L.noData) return [noDataHtml(L, "Log " + (L.log + 1) + ": ")];
            if (L.bench) return [esc(benchText(L))];
            var ph = phasesText(L.phaseS), parts = epochHtml(r, L.log, true); // the parts of the log with values that are possibly different
            return [L.flights.length ? esc(L.flights.length === 1 ? "Flight: " : "Flights: ") + links(L) : esc("No flight")].concat(ph ? [esc("Phases: " + ph)] : [], parts ? [parts] : []);
        }
        var keys = Object.keys(fl.logs).map(Number).sort(function (a, b) { return a - b; });
        var head = plural(fl.flights, "flight") + " in " + plural(fl.flightLogs, "log") + "." +
            (fl.bench ? " " + plural(fl.bench, "bench run") + " (no analysis)." : "") +
            (fl.noData ? " " + plural(fl.noData, "log") + " with no data that the app can read." : "");
        return ['<details class="tuning-flights"><summary>' + esc(head) + "</summary><ul>" + keys.map(function (k) {
            var L = fl.logs[k], ph = phasesText(L.phaseS), start = startHtml(r, L.log); // D12: the PID profile at the start, its basis in the title
            if (L.noData) return "<li>" + noDataHtml(L, "Log " + (L.log + 1) + ": ") + "</li>";
            if (L.bench) return "<li>" + esc(benchText(L)) + "</li>";
            var parts = epochHtml(r, L.log, false); // the parts with values that are possibly different, the parts in the title
            return "<li>" + esc("Log " + (L.log + 1) + ": " + (L.flights.length ? plural(L.flights.length, "flight") + " " : "no flight")) + (L.flights.length ? "(" + links(L) + ")" : "") +
                esc("." + (ph ? " Phases: " + ph + "." : "")) + (start ? " " + start + "." : "") + (parts ? " " + parts : "") + "</li>";
        }).join("") + "</ul></details>"];
    }

    // "6 flights in 3 logs, 8 bench runs, 2 logs with no data": the flights of a file result (flightsOf), for the report
    function fileFlightsText(fl) {
        return [plural(fl.flights, "flight") + " in " + plural(fl.flightLogs, "log"), fl.bench ? plural(fl.bench, "bench run") : "",
            fl.noData ? plural(fl.noData, "log") + " with no data" : ""].filter(Boolean).join(", ");
    }

    // ---------------------------------------------------------------------------------------------
    // "Selected flights" (SPEC3 D): the logs and flights that the pilot selects for the analysis. The selection is a map
    // { "<log>:all": true, "<log>:<flight>": true } (log and flight 0-based; "all": every flight of the log, the only choice
    // before the app knows the flights of the log). The worker gets it as options.flights = [{ log, flight }] (flight
    // null: every flight of that log), sorted, with each log once as "all" or with its flights.

    // A result of more than one log: "All logs in the file", or "Selected flights" (a worker that gives scope "flights")
    function fileLike(r) {
        return !!r && (r.scope === "file" || r.scope === "flights");
    }

    // "Flights in the analysis: ..." of a run of "Selected flights" (no period): the selection that the view sent, with the
    // flight numbers that the app knows for the full logs. The worker writes its own text (result.selection.text) in the notes
    function runSelectionText(entry) {
        return "Flights in the analysis: " + selectionText(entry.flights, entry.counts);
    }

    // The flights of flightsOf() for the logs of a selection only, with the counts again
    function onlyLogs(fl, logs) {
        var out = { logs: {}, flights: 0, flightLogs: 0, bench: 0 };
        Object.keys(fl.logs).forEach(function (k) {
            var L = fl.logs[k];
            if (logs.indexOf(L.log) < 0) return;
            out.logs[k] = L;
            if (L.bench) out.bench++;
            else if (L.flights.length) { out.flights += L.flights.length; out.flightLogs++; }
        });
        return out;
    }

    // The number of logs in a selection list
    function selectedLogs(list) {
        return (list || []).map(function (x) { return x.log; }).filter(function (l, i, a) { return a.indexOf(l) === i; }).length;
    }

    // [{ log, flight }] of a selection map, sorted by log and flight; "all" of a log replaces its flights
    function selectionList(map) {
        var all = {}, out = [];
        Object.keys(map || {}).forEach(function (k) {
            var m = /^(\d+):all$/.exec(k);
            if (map[k] && m) all[m[1]] = true;
        });
        Object.keys(map || {}).forEach(function (k) {
            var m = /^(\d+):(all|\d+)$/.exec(k);
            if (!map[k] || !m) return;
            if (m[2] === "all") out.push({ log: +m[1], flight: null });
            else if (!all[m[1]]) out.push({ log: +m[1], flight: +m[2] });
        });
        return out.sort(function (a, b) { return a.log - b.log || (a.flight === null ? -1 : b.flight === null ? 1 : a.flight - b.flight); });
    }

    // The part of the key of a run: "13.*,14.0" (log.flight, * for every flight). No "|": keyFor splits the key at "|"
    function selectionKey(list) {
        return (list || []).map(function (x) { return x.log + "." + (x.flight === null ? "*" : x.flight); }).join(",");
    }

    // "log 14 flight 1, log 15 flights 1 to 3": the selection as text, numbers from 1. counts: { [log]: the number of
    // flights in the log } when the app knows it, so that a full log shows its flights
    function selectionText(list, counts) {
        return (list || []).map(function (x) {
            var n = counts && isNum(counts[x.log]) ? counts[x.log] : null;
            if (x.flight !== null) return "log " + (x.log + 1) + " flight " + (x.flight + 1);
            return "log " + (x.log + 1) + (n === 1 ? " flight 1" : n > 1 ? " flights 1 to " + n : " (all flights)");
        }).join(", ");
    }

    // The value of the header line "H <name>:" of the log in bytes[from, to), the first 64 kB of it at most; null if none
    function headerValue(bytes, from, to, name) {
        var key = "H " + name + ":", end = Math.min(isNum(to) ? to : bytes.length, bytes.length, from + 65536);
        for (var i = Math.max(0, from); i + key.length <= end; i++) {
            if (bytes[i] !== 72) continue; // "H"
            for (var j = 0; j < key.length && bytes[i + j] === key.charCodeAt(j); j++) { /* match */ }
            if (j < key.length) continue;
            var out = "";
            for (var k = i + key.length; k < end && bytes[k] !== 10 && bytes[k] !== 13 && out.length < 80; k++) out += String.fromCharCode(bytes[k]);
            return out.trim();
        }
        return null;
    }

    // "2026-10-04 17:54:08" from "2026-10-04T17:54:08.312+00:00" (the clock of the flight controller); null without a date
    // (a flight controller with no clock writes a date before 2000)
    function logDateText(raw) {
        var m = /^(20\d\d-\d\d-\d\d)[T ](\d\d:\d\d(?::\d\d)?)/.exec(String(raw || ""));
        return m ? m[1] + " " + m[2] : null;
    }

    // The rows of the flight list: one for each log of the file. logs: [{ log, date, seconds, error }] (from the headers and
    // the log index of the viewer); known: { [log]: { bench, flights: [{ t0, t1, seconds }] } } (from the results of the
    // file). state: "nodata" (the log has no data), "unknown" (no result knows its flights), "bench" (no flight: a bench
    // run), "flights"
    function selectionRows(logs, known, map) {
        var list = selectionList(map), on = {};
        list.forEach(function (x) { on[x.log + ":" + (x.flight === null ? "all" : x.flight)] = true; });
        return (logs || []).map(function (L) {
            var k = known && known[L.log], state = L.error || (k && k.noData) ? "nodata" : !k ? "unknown" : k.bench || !k.flights.length ? "bench" : "flights";
            var all = !!on[L.log + ":all"] && (state === "unknown" || state === "flights");
            var flights = state === "flights" ? k.flights.map(function (f, i) {
                return { index: i, t0: f.t0, t1: f.t1, seconds: isNum(f.seconds) ? f.seconds : f.t1 - f.t0, selected: all || !!on[L.log + ":" + i] };
            }) : [];
            var some = flights.some(function (f) { return f.selected; });
            return { log: L.log, date: L.date || null, seconds: isNum(L.seconds) ? L.seconds : null, error: L.error || (k && k.noData ? k.why || null : null), state: state, flights: flights,
                selected: all || (flights.length > 0 && flights.every(function (f) { return f.selected; })), partly: !all && some && !flights.every(function (f) { return f.selected; }),
                selectable: state === "unknown" || state === "flights" };
        });
    }

    // The selection map after an action: { kind: "log", log, on } (a full log, or no flight of it), { kind: "flight", log,
    // flight, on, count } (count: the flights of the log; the "all" of the log becomes its other flights), { kind: "all",
    // rows } (each log that the analysis can use), { kind: "none" }
    function selectionApply(map, act, rows) {
        var out = {};
        Object.keys(map || {}).forEach(function (k) { if (map[k]) out[k] = true; });
        function clearLog(li) { Object.keys(out).forEach(function (k) { if (k.split(":")[0] === String(li)) delete out[k]; }); }
        if (act.kind === "none") return {};
        if (act.kind === "all") {
            (rows || []).forEach(function (r) { if (r.selectable) { clearLog(r.log); out[r.log + ":all"] = true; } });
            return out;
        }
        if (act.kind === "log") {
            clearLog(act.log);
            if (act.on) out[act.log + ":all"] = true;
            return out;
        }
        if (act.kind === "flight") {
            var was = !!out[act.log + ":all"];
            delete out[act.log + ":all"];
            if (was) for (var i = 0; i < (act.count || 0); i++) out[act.log + ":" + i] = true;
            if (act.on) out[act.log + ":" + act.flight] = true;
            else delete out[act.log + ":" + act.flight];
            var n = 0;
            for (i = 0; i < (act.count || 0); i++) if (out[act.log + ":" + i]) n++;
            if (act.count && n === act.count) { clearLog(act.log); out[act.log + ":all"] = true; } // every flight: the full log
        }
        return out;
    }

    // The control of a flight list (or the "Logs" control) under root that has the focus, as a selector, so that a list drawn
    // again gives the focus back to the same control (a pilot who uses the keyboard does not lose the place); null for none
    function fselFocus(root) {
        var a = typeof document !== "undefined" && document ? document.activeElement : null;
        if (!a || !root || typeof root.contains !== "function" || a === root || !root.contains(a)) return null;
        var c = String(a.className || ""), log = a.getAttribute ? a.getAttribute("data-log") : null, fl = a.getAttribute ? a.getAttribute("data-flight") : null;
        if (/\btuning-fsel-one\b/.test(c)) return '.tuning-fsel-one[data-log="' + (+log) + '"][data-flight="' + (+fl) + '"]';
        if (/\btuning-fsel-log\b/.test(c)) return '.tuning-fsel-log[data-log="' + (+log) + '"]';
        if (/\btuning-fsel-all\b/.test(c)) return ".tuning-fsel-all";
        if (/\btuning-fsel-none\b/.test(c)) return ".tuning-fsel-none";
        if (/\btuning-fsel-head\b/.test(c)) return ".tuning-fsel-head";
        if (a.tagName === "SUMMARY" && a.parentNode && a.parentNode.getAttribute) return '.tuning-fsel-sub[data-log="' + (+a.parentNode.getAttribute("data-log")) + '"] > summary';
        if (/\btuning-scope\b/.test(c)) return ".tuning-scope";
        return null;
    }

    function fselRefocus(root, sel) {
        var e = sel && root && root.querySelector ? root.querySelector(sel) : null;
        if (e && e.focus) e.focus({ preventScroll: true });
    }

    // Both views replace the flight table when the selection changes. Keep its viewport as well as its focus.
    function fselState(root) {
        var wrap = root && root.querySelector ? root.querySelector(".tuning-fsel-wrap") : null;
        return { focus: fselFocus(root), scroll: wrap ? { top: wrap.scrollTop, left: wrap.scrollLeft } : null };
    }

    function fselRestore(root, state) {
        if (!state) return;
        fselRefocus(root, state.focus);
        var wrap = root && root.querySelector ? root.querySelector(".tuning-fsel-wrap") : null;
        if (wrap && state.scroll) {
            wrap.scrollTop = state.scroll.top;
            wrap.scrollLeft = state.scroll.left;
        }
    }

    // The values of the "Logs" control (2026-10-06): by default the analysis uses all flights of the file (the flight logs; the
    // worker leaves out the bench runs and the logs with no data), else the flights that the pilot selects, or the log on
    // display in the log viewer
    var SCOPES = [["file", "All flights in the file"], ["flights", "Selected flights"], ["log", "This log"]];

    function scopeSelectHtml(value) {
        return '<select class="form-control input-sm tuning-scope" title="The logs and the flights that the analysis uses">' + SCOPES.map(function (s) {
            return '<option value="' + s[0] + '"' + (s[0] === value ? " selected" : "") + ">" + esc(s[1]) + "</option>";
        }).join("") + "</select>";
    }

    // The counts of the flight list rows: { flights, flightsOn: the flights that the app knows; other, otherOn: the logs
    // whose flights the app does not know (each with all its flights); bench; noData }
    function selectionCounts(rows) {
        var c = { flights: 0, flightsOn: 0, other: 0, otherOn: 0, bench: 0, noData: 0 };
        (rows || []).forEach(function (r) {
            if (r.state === "flights") {
                c.flights += r.flights.length;
                c.flightsOn += r.flights.filter(function (f) { return f.selected; }).length;
            } else if (r.state === "unknown") {
                c.other++;
                if (r.selected) c.otherOn++;
            } else if (r.state === "bench") c.bench++;
            else if (r.state === "nodata") c.noData++;
        });
        return c;
    }

    // "Flights in the analysis: 6 of 6 flights (8 bench runs, 2 logs with no data)", no period. The logs whose flights the
    // app does not know yet: "all flights of 3 of 4 logs"
    function selectionHead(c) {
        var parts = [];
        if (c.flights) parts.push(c.flightsOn + " of " + plural(c.flights, "flight"));
        if (c.other) parts.push("all flights of " + c.otherOn + " of " + plural(c.other, c.flights ? "other log" : "log"));
        var extra = [c.bench ? plural(c.bench, "bench run") : "", c.noData ? plural(c.noData, "log") + " with no data" : ""].filter(Boolean);
        return "Flights in the analysis: " + (c.flightsOn || c.otherOn ? parts.join(", ") : "no flight") + (extra.length ? " (" + extra.join(", ") + ")" : "");
    }

    // The flight list as HTML: the logs of the file (log number, date, length) and, when a result knows them, the flights of
    // each log with their times in frame seconds. Bench runs and logs with no data cannot be selected. The list collapses
    // under its head (a <details>): opts.open true or false, else open only when no flight is selected. A log with more than
    // one flight collapses its flights under its row: opts.subOpen[log] (closed when not given)
    function selectionHtml(rows, hasKnown, opts) {
        opts = opts || {};
        var c = selectionCounts(rows), none = !c.flightsOn && !c.otherOn, open = typeof opts.open === "boolean" ? opts.open : none, sub = opts.subOpen || {};
        var head = selectionHead(c), at = head.indexOf(": ");
        var help = c.other ? (hasKnown ? "The list shows the flights of a log after an analysis of that log. For the other logs, select the full log." :
            "The list shows the flights of a log after an analysis of that log. Before that, select the full log.") : "Select the flights for the analysis. The analysis does not use bench runs.";
        var table = '<div class="tuning-fsel-wrap"><table class="tuning-table tuning-fsel-table"><thead><tr><th></th><th>Log</th><th>Date</th><th>Length</th><th>Flights</th></tr></thead><tbody>' +
            rows.map(function (r) {
                var box = '<input type="checkbox" class="tuning-fsel-log" data-log="' + r.log + '"' + (r.selected ? " checked" : "") + (r.selectable ? "" : " disabled") +
                    ' aria-label="' + esc("Log " + (r.log + 1)) + '"' + (r.partly ? ' data-partly="1"' : "") + ">";
                var what;
                if (r.state === "nodata") what = noDataHtml({ why: r.error });
                else if (r.state === "bench") what = '<span class="tuning-muted">' + esc(BENCH) + "</span>";
                else if (r.state === "unknown") what = '<span class="tuning-muted">' + esc("All flights of this log") + "</span>";
                else {
                    what = r.flights.map(function (f) {
                        return '<label class="tuning-fsel-flight"><input type="checkbox" class="tuning-fsel-one" data-log="' + r.log + '" data-flight="' + f.index + '" data-count="' + r.flights.length + '"' +
                            (f.selected ? " checked" : "") + "> " + esc("Flight " + (f.index + 1) + ": " + num(+f.t0.toFixed(1)) + " s to " + num(+f.t1.toFixed(1)) + " s (" + secs(f.seconds) + ")") + "</label>";
                    }).join("");
                    if (r.flights.length > 1) {
                        var on = r.flights.filter(function (f) { return f.selected; }).length;
                        what = '<details class="tuning-fsel-sub" data-log="' + r.log + '"' + (sub[r.log] === true ? " open" : "") + '><summary title="Open or close the list of the flights of this log">' +
                            esc(on + " of " + plural(r.flights.length, "flight")) + '</summary><div class="tuning-fsel-flights">' + what + "</div></details>";
                    }
                }
                return '<tr class="tuning-fsel-row is-' + r.state + (r.selected || r.partly ? " is-on" : "") + '"><td>' + box + "</td><td>" + esc("Log " + (r.log + 1)) + "</td><td>" +
                    (r.date ? '<span data-ste="quoted">' + esc(r.date) + "</span>" : '<span class="tuning-muted">No date</span>') + '</td><td class="tuning-num">' +
                    (isNum(r.seconds) ? esc(secs(r.seconds)) : "") + "</td><td>" + what + "</td></tr>";
            }).join("") + "</tbody></table></div>";
        return '<details class="tuning-fsel-box"' + (open ? " open" : "") + '><summary class="tuning-fsel-head" title="Open or close the list of the flights">' +
            "<strong>" + esc(head.slice(0, at + 1)) + '</strong> <span class="tuning-fsel-count">' + esc(head.slice(at + 2)) + "</span></summary>" +
            '<div class="tuning-fsel-body"><div class="tuning-fsel-actions"><button type="button" class="btn btn-default btn-xs tuning-fsel-all">Select all flights</button>' +
            '<button type="button" class="btn btn-default btn-xs tuning-fsel-none">Remove the selection</button></div>' +
            '<p class="tuning-muted tuning-fsel-help">' + esc(help) + "</p>" + table + "</div></details>";
    }

    // "PID profile 1: 2300 rpm, 3.3 min · PID profile 2: 2500 rpm, 50.0 s". The records keep the label of the modules (0: the
    // part before the first PID profile change); start: the confirmed PID profile at the start of the log (startProfile), which
    // that part is in, else 0 ("PID profile unknown", last)
    function profilesText(rec, start) {
        var by = {}, target = {}, ps = rec.profileSeconds || {}, tg = rec.targetOf || {};
        Object.keys(ps).forEach(function (k) {
            var p = +k === 0 && start > 0 ? start : +k;
            if (!isNum(ps[k])) return;
            by[p] = (by[p] || 0) + ps[k];
            if (isNum(tg[k]) && !isNum(target[p])) target[p] = tg[k];
        });
        return Object.keys(by).map(Number).filter(function (p) { return by[p] >= 0.05; }).sort(function (a, b) { return (a === 0) - (b === 0) || a - b; }).map(function (p) {
            return profileLabel(p) + ": " + (isNum(target[p]) ? Math.round(target[p]) + " rpm, " : "") + secs(by[p]);
        }).join(" · ");
    }

    // ---------------------------------------------------------------------------------------------
    // D12: the PID profile at the start of a log (js/tuning_worker.js armingCore and armingFinal, result.profiles.arming[]). The
    // log header has the values of the PID profile that is active when the pilot arms the helicopter, and the log records no PID
    // profile before the first change. The worker confirms it from the log ("event": a change at the first frame; "headspeed":
    // "govRequest" at the start against the headspeed of each PID profile at the logged changes of the file) or from a CLI dump
    // that the pilot loaded ("cli", "cliTarget"). "govTarget" and "fileTarget" are estimates only (js/tuning_worker.js CONFIRMS)

    var START_NOTE = "The log header has the values of the PID profile that is active when the pilot arms the helicopter.";
    var BASIS_SHORT = { event: "the log event", headspeed: '"govRequest"', cli: "the CLI dump", cliTarget: "the CLI dump" };

    // The arming result of log li: { log, profile (1-6, 0 unknown), basis, confirmed, estimate, headspeed }, or null (a bench run,
    // a log that the worker did not analyse, a result without it)
    function armingOf(r, li) {
        if (!r || !isNum(li)) return null;
        var list = r.profiles && Array.isArray(r.profiles.arming) ? r.profiles.arming : [], a = null;
        list.some(function (x) { if (x && x.log === li) a = x; return !!a; });
        if (!a) (r.records || []).some(function (x) { if (x && x.log === li && x.profiles && x.profiles.arming && typeof x.profiles.arming === "object") a = x.profiles.arming; return !!a; });
        return a;
    }

    // The confirmed PID profile at the start of log li (1 to 6), else 0
    function startProfile(r, li) {
        var a = armingOf(r, li);
        return a && a.confirmed && isNum(a.profile) && a.profile > 0 ? a.profile : 0;
    }

    // Where the worker found the headspeed of each PID profile: the logged PID profile changes of the file, or of the log alone
    function mapWhere(r) {
        return r && r.scope === "log" ? "this log" : "this file";
    }

    // The basis of the headspeed step (arming.headspeed: { headspeed, observations: { switches, logs } }): '"govRequest" is 3500
    // rpm at the start of the log. Only PID profile 1 has this value at the PID profile changes of this file (2 changes in 2 logs).'
    function headspeedText(x, p, where) {
        var o = x && x.observations, h = x && isNum(x.headspeed) ? x.headspeed : null;
        var seen = o && isNum(o.switches) && isNum(o.logs) ? " (" + plural(o.switches, "change") + " in " + plural(o.logs, "log") + ")" : "";
        if (h === null) return '"govRequest" at the start of the log agrees only with the headspeed of ' + profileLabel(p) + " at the PID profile changes of " + where + seen + ".";
        return '"govRequest" is ' + num(h) + " rpm at the start of the log. Only " + profileLabel(p) + " has this value at the PID profile changes of " + where + seen + ".";
    }

    // Why the PID profile at the start of a log is known: STE sentences, one for each basis that confirms it. For a PID profile
    // that is not confirmed: that the app cannot find it, with the estimate of the governor target. "" without an arming result
    function startBasisText(a, where) {
        if (!a) return "";
        var p = a.confirmed && isNum(a.profile) && a.profile > 0 ? a.profile : 0, out = [];
        if (!p) {
            out.push("The app cannot find the PID profile at the start of the log.");
            if (isNum(a.estimate) && a.estimate > 0) out.push("The governor target agrees with " + profileLabel(a.estimate) + ". But the governor target does not show the PID profile without other data.");
            return out.join(" ");
        }
        (Array.isArray(a.basis) ? a.basis : []).forEach(function (b) {
            if (b === "event") out.push("The log records a change to " + profileLabel(p) + " at the first frame.");
            else if (b === "cli") out.push("Only the CLI section of " + profileLabel(p) + " agrees with the log header.");
            else if (b === "cliTarget") out.push('At the start of the log, the governor target agrees with the "gov_headspeed" of ' + profileLabel(p) + " in the CLI dump.");
            else if (b === "headspeed") out.push(headspeedText(a.headspeed, p, where));
        });
        return out.join(" ");
    }

    // 'Start: PID profile 1, from "govRequest"' with the full basis in its title, as HTML. "" without an arming result
    function startHtml(r, li) {
        var a = armingOf(r, li);
        if (!a) return "";
        var p = startProfile(r, li), by = [];
        if (p) (Array.isArray(a.basis) ? a.basis : []).forEach(function (b) { if (BASIS_SHORT[b] && by.indexOf(BASIS_SHORT[b]) < 0) by.push(BASIS_SHORT[b]); });
        return '<span class="tuning-start" title="' + esc(startBasisText(a, mapWhere(r))) + '">' + esc("Start: " + profileLabel(p) + (by.length ? ", from " + andText(by) : "")) + "</span>";
    }

    // The rows of the report: [log, PID profile at the start, basis] of each log with an arming result
    function startRows(r) {
        var list = r && r.profiles && Array.isArray(r.profiles.arming) ? r.profiles.arming.filter(function (a) { return a && isNum(a.log); }) : [];
        return list.slice().sort(function (a, b) { return a.log - b.log; }).map(function (a) {
            return [logLabel(a.log), profileLabel(startProfile(r, a.log)), startBasisText(a, mapWhere(r))];
        });
    }

    // The title of the PID profile of a configuration: the basis for each of its logs that starts in its PID profile, the logs
    // with the same basis together. "" when no log of the configuration starts in its PID profile
    function configStartTitle(r, d) {
        var groups = [], by = {};
        if (!(isNum(d.pidProfile) && d.pidProfile > 0)) return "";
        (Array.isArray(d.logs) ? d.logs : []).filter(isNum).sort(function (a, b) { return a - b; }).forEach(function (li) {
            if (startProfile(r, li) !== d.pidProfile) return;
            var t = startBasisText(armingOf(r, li), mapWhere(r));
            if (!by[t]) groups.push(by[t] = { text: t, logs: [] });
            by[t].logs.push(li);
        });
        return groups.map(function (g) { return cap(logsText(g.logs)) + ": " + g.text; }).join(" ");
    }

    // The label of a PID profile of the curves of log li (the label of the modules): 0 is the confirmed PID profile at the start
    function curveProfile(r, li, p) {
        return +p === 0 ? startProfile(r, li) : +p;
    }

    // ---------------------------------------------------------------------------------------------
    // The notch orders of the log (result.notchFit, js/tuning_worker.js notchFitOut): { used, logs, tail, motor: { passed, order,
    // se, n, unit: "flight" | "block", axis, depthDb, sources, Q, reasons } | null } | null. Without a CLI dump, the worker finds in
    // the log the order of the tail rotor notch filters (RPM sources 21 to 28) and of the motor notch filter (source 10). The
    // gear ratios in the configuration are correct: these orders only put the notch filters at their frequency

    var FIT_NAME = { tail: "tail rotor notch filters", motor: "motor notch filter" };

    function fitGroupOf(code) {
        return code >= 21 && code <= 28 ? "tail" : code === 10 ? "motor" : null;
    }

    // The fit of a group ("tail" or "motor") when the checks and the plots use it, else null
    function fitUsed(r, group) {
        var nf = r && r.notchFit, g = nf && group ? nf[group] : null;
        return nf && nf.used && g && g.passed && isNum(g.order) ? g : null;
    }

    // "4.002 ± 0.002": the order with the decimals of its standard error
    function fitOrderText(g) {
        var d = isNum(g.se) && g.se > 0 && g.se < 0.001 ? 4 : 3;
        return g.order.toFixed(d) + (isNum(g.se) ? " ± " + g.se.toFixed(d) : "");
    }

    // "yaw axis, 6 flight logs", "yaw axis, 4 periods of 30 s"
    function fitWhereText(g) {
        var parts = [];
        if (g.axis) parts.push(g.axis + " axis");
        if (isNum(g.n) && g.n > 0) parts.push(g.unit === "block" ? plural(g.n, "period") + " of 30 s" : plural(g.n, "flight log"));
        return parts.join(", ");
    }

    // "4.002 ± 0.002 × the rotor frequency, from the log (yaw axis, 6 flight logs)"
    function fitValueText(g) {
        var where = fitWhereText(g);
        return fitOrderText(g) + " × the rotor frequency, from the log" + (where ? " (" + where + ")" : "");
    }

    // The sentences of the Filters tab about the notch filters of one axis (notches: the list of the plots, health_more vib
    // notches[axis]): the order from the log of each group, or that the log does not show it, and the notch filters that the plots
    // cannot show. [] when there is nothing to say
    function notchFitTexts(r, notches) {
        var nf = r && r.notchFit, list = Array.isArray(notches) ? notches.filter(Boolean) : [], out = [], told = {};
        if (nf && typeof nf === "object") ["tail", "motor"].forEach(function (k) {
            var g = nf[k], shown = list.filter(function (n) { return fitGroupOf(n.code) === k; }).length, them = k === "motor" ? "this notch filter" : "these notch filters";
            if (!g || typeof g !== "object") return; // the log header has no notch filter of this group
            told[k] = true;
            if (fitUsed(r, k)) out.push(cap(FIT_NAME[k]) + ": " + fitValueText(g) + "." + (shown ? " The plots show " + them + " at this frequency." : ""));
            else out.push("The log does not show the frequency of the " + FIT_NAME[k] + "." + (shown ? " Thus, the plots do not show " + them + "." : ""));
        });
        var hidden = list.filter(function (n) { return !isNum(n.hz) && !told[fitGroupOf(n.code)]; }).length;
        if (hidden) out.push("The plots do not show " + plural(hidden, "notch filter") + ", because " + (hidden > 1 ? "their" : "its") + " frequency is unknown.");
        return out;
    }

    // The rows of the report: [group, value] of each group of result.notchFit
    function notchFitRows(r) {
        var nf = r && r.notchFit, out = [];
        if (!nf || typeof nf !== "object") return out;
        ["tail", "motor"].forEach(function (k) {
            var g = nf[k];
            if (g && typeof g === "object") out.push([cap(FIT_NAME[k]), fitUsed(r, k) ? fitValueText(g) : "The log does not show the frequency."]);
        });
        return out;
    }

    // ---------------------------------------------------------------------------------------------
    // result.cliStatus (js/tuning_worker.js cliStatusOf): { name, used, conflicts: [{ what ("gov_headspeed", "header", "profile"),
    // text (STE, names in backticks), ... }] } for a CLI dump that the pilot loaded, else null.
    // The log is the only necessary input, and it wins: the worker does not use a value of the CLI dump that does not agree with
    // the log, and a conflict never makes a PID profile that the log confirms unknown

    var CLI_STATUS = { conflict: "The CLI dump does not agree with the log.", logWins: "The analysis uses the values of the log.", unused: "The analysis does not use the CLI dump." };
    var CONFLICTS_SHOWN = 12;

    function cliConflicts(r) {
        var cs = r && r.cliStatus;
        return cs && typeof cs === "object" && Array.isArray(cs.conflicts) ? cs.conflicts.filter(function (c) { return c && typeof c === "object" && (c.text || c.what); }) : [];
    }

    // The notice of result.cliStatus, as HTML: the conflicts, or that the analysis does not use the CLI dump. "" for a result with
    // no CLI dump or with a CLI dump that agrees with the log
    function cliStatusHtml(r) {
        var conf = cliConflicts(r), cs = r && r.cliStatus;
        if (conf.length) {
            return notice("warn", "<strong>" + esc(CLI_STATUS.conflict) + "</strong> " + esc(CLI_STATUS.logWins) + '<ul class="tuning-cli-conflicts">' +
                conf.slice(0, CONFLICTS_SHOWN).map(function (c) { return "<li>" + (c.text ? mdCode(c.text) : quoted(esc(oneLine(c.what)))) + "</li>"; }).join("") + // the text says what
                (conf.length > CONFLICTS_SHOWN ? "<li>" + esc(plural(conf.length - CONFLICTS_SHOWN, "other difference") + ".") + "</li>" : "") + "</ul>");
        }
        return cs && typeof cs === "object" && cs.used === false ? notice("info", esc(CLI_STATUS.unused + " " + CLI_STATUS.logWins)) : "";
    }

    // ---------------------------------------------------------------------------------------------
    // Values that are possibly not current (CLAUDE.md, user rule 2026-10-06; js/tuning_worker.js freshnessOf). The log header has
    // the values of the PID profile and the rate profile at the first arm of the log. param_epochs.cjs cuts each analysed log into
    // parts, result.epochs: [{ log, spans: [{ t0, t1 (frame s), arm (0: the arm of the log header), armed (false: after a disarm),
    // pidProfile, rateProfile (1-6, 0 unknown), fresh, reasons, adjust, source: { pid, rate }, text (STE, "" when fresh) }] }].
    // The worker marks each result (f.stale), each period of the limits checks (f.events[].stale), each decision (d.stale) and each
    // recommendation (r.stale): { reasons, text (STE, with the source of the values), spans: [{ log, t0, t1 }] (3 or less) } or
    // { reasons, text, findings }. A part with no cause is not proven: result.freshness.caveat says that the log does not record
    // a change by the transmitter or the Configurator while armed. The Configurations tab shows it (freshnessHtml). A result with
    // no stale shows nothing extra

    var FRESH = {
        badge: "Values possibly different",
        heading: "Values of the log header",
        about: "The log header has the values of the first arm in the log. In some parts of a log, the values are possibly different from the log header.",
        mark: 'Each result, period and recommendation that uses one of these parts shows the mark "Values possibly different".',
        noMark: "Thus, a result without this mark can also use values that are different from the log header.",
        period: "The values in this period are possibly different from the log header.",
        none: "The app found no cause in the parts of the logs.",
        table: "The table shows the parts of the flight logs that have a cause.",
        noCause: "No known cause"
    };
    // the causes (param_epochs.cjs reasons) as labels, in the order of the worker
    var FRESH_CAUSE = { grace: "Disarmed", rearm: "Armed again", switched: "Different PID profile or rate profile", unlogged: 'Change of "govRequest"',
        adjusted: "In-flight adjustment", resume: "Period with no data" };
    var FRESH_ORDER = ["grace", "rearm", "switched", "unlogged", "adjusted", "resume"];
    // the source of the values of a part (span.source.pid, .rate), as words: "log N" is the log header of log N (0-based)
    var FRESH_SOURCE = { header: "log header", cli: "CLI dump", recovered: "calculated gains", adjustment: "in-flight adjustment", none: "unknown" };
    var FRESH_OLD_CLI = "CLI dump that does not agree with the log"; // a source "cli" of a dump that the log contradicts (cliDisagrees)
    var FRESH_SHOWN = 6;    // the periods of a result in its mark; the others as a count
    var PERIOD_PAD_S = 0.5; // "Show in the log" of a period: the period +- this, as the evidence spans of the limits checks

    // The stale of a result, a period, a decision or a recommendation, or null
    function staleOf(x) {
        var s = x && typeof x === "object" ? x.stale : null;
        return s && typeof s === "object" && (oneLine(s.text) || (Array.isArray(s.reasons) && s.reasons.length)) ? s : null;
    }

    // "Armed again, different PID profile or rate profile": the labels of the causes, a key that this view does not know as it is
    function causeText(reasons) {
        return (Array.isArray(reasons) ? reasons : []).map(function (k, i) {
            var t = FRESH_CAUSE[k] || oneLine(k);
            return i ? t.charAt(0).toLowerCase() + t.slice(1) : t;
        }).filter(Boolean).join(", ");
    }

    // The mark, with the text of the stale in its title
    function staleBadge(s) {
        return '<span class="tuning-badge st-stale" title="' + esc(oneLine(s && s.text) || FRESH.period) + '">' + esc(FRESH.badge) + "</span>";
    }

    // "110.2 s to 120.8 s"
    function rangeText(t0, t1) {
        return num(+t0.toFixed(1)) + " s to " + num(+t1.toFixed(1)) + " s";
    }

    // A link that shows a part of log li in the log viewer (frame seconds), with the mark and `text` in the bar over the graph
    function partLink(li, t0, t1, label, text) {
        return '<a href="#" class="tuning-part" data-log="' + esc(li) + '" data-t0="' + esc(t0) + '" data-t1="' + esc(t1) + '" data-title="' + esc(FRESH.badge) +
            '" data-text="' + esc(oneLine(text)) + '" title="Show this part of the log">' + esc(label) + "</a>";
    }

    // The time of a period of a limits check (f.events: tS, t1S in frame seconds, else t, t1, as the worker reads them): [a, b], or null
    function periodTime(e) {
        var a = isNum(e.tS) ? e.tS : isNum(e.t) ? e.t : null, b = isNum(e.t1S) ? e.t1S : isNum(e.t1) ? e.t1 : a;
        return a === null ? null : [a, Math.max(a, b)];
    }

    // The periods of a result that have a stale (the limits checks L1-L7): [{ log, a, b, stale }], in time order
    function stalePeriods(f) {
        var li = Array.isArray(f.log) ? f.log[0] : f.log;
        return (Array.isArray(f.events) ? f.events : []).map(function (e) {
            var s = e && typeof e === "object" ? staleOf(e) : null, ab = s ? periodTime(e) : null, log = ab ? (isNum(e.log) ? e.log : li) : null;
            return ab && isNum(log) ? { log: log, a: ab[0], b: ab[1], stale: s } : null;
        }).filter(Boolean).sort(function (x, y) { return x.log - y.log || x.a - y.a; });
    }

    // The number of periods of a limits check (the events of the other checks are not periods at a limit)
    function periodCount(f) {
        if (f.module !== "limits") return stalePeriods(f).length;
        return (Array.isArray(f.events) ? f.events : []).filter(function (e) { return e && typeof e === "object" && periodTime(e); }).length;
    }

    // The stale of the period that an evidence span of f contains, or null
    function spanStale(f, sp, periods) {
        var hit = null;
        (periods || stalePeriods(f)).some(function (p) {
            if (isNum(sp.log) && sp.log !== p.log) return false;
            if (p.a >= sp.t0 - 1e-6 && p.b <= sp.t1 + 1e-6) hit = p.stale;
            return !!hit;
        });
        return hit;
    }

    // The mark of a result with f.stale, or with periods that have a stale: the badge (the text in its title) opens the text,
    // "Show in the log" of the parts of the log that it uses (stale.spans), and its periods in these parts. "" for a result with
    // neither
    function staleHtml(f) {
        var s = f ? staleOf(f) : null, periods = f ? stalePeriods(f) : [];
        if (!s && !periods.length) return "";
        var text = s ? oneLine(s.text) : FRESH.period, spans = s && Array.isArray(s.spans) ? s.spans.filter(function (q) { return q && isNum(q.log) && isNum(q.t0) && isNum(q.t1); }) : [];
        var many = Array.isArray(f.log) || spans.some(function (q) { return q.log !== spans[0].log; });
        var links = spans.length === 1 && !many ? partLink(spans[0].log, spans[0].t0, spans[0].t1, "Show in the log", text) :
            spans.map(function (q) { return partLink(q.log, q.t0, q.t1, (many ? "Log " + logLabel(q.log) + ", " : "") + rangeText(q.t0, q.t1), text); }).join(", ");
        var ps = periods.slice(0, FRESH_SHOWN).map(function (p) {
            return partLink(p.log, Math.max(0, p.a - PERIOD_PAD_S), p.b + PERIOD_PAD_S, num(+p.a.toFixed(1)) + " s (" + num(+(p.b - p.a).toFixed(3)) + " s)", p.stale.text);
        });
        if (periods.length > FRESH_SHOWN) ps.push('<span class="tuning-muted">+' + (periods.length - FRESH_SHOWN) + "</span>");
        return '<details class="tuning-stale"><summary>' + staleBadge(s || { text: FRESH.period }) + "</summary>" +
            '<div class="tuning-stale-text">' + esc(text) + "</div>" +
            (links ? '<div class="tuning-stale-links">' + (spans.length > 1 || many ? esc("Show in the log: ") : "") + links + "</div>" : "") +
            (ps.length ? '<div class="tuning-stale-links">' + esc(periods.length + " of " + plural(periodCount(f), "period") + (periods.length === 1 ? " is" : " are") + " in these parts: ") + ps.join(", ") + "</div>" : "") +
            "</details>";
    }

    // The caveat of a recommendation with r.stale (the union over its results): the mark and its text, "" without r.stale
    function staleRecHtml(rec) {
        var s = staleOf(rec);
        return s ? '<div class="tuning-rec-list is-stale"><div class="tuning-label">' + esc(FRESH.badge) + '</div><div class="tuning-stale-text">' + esc(oneLine(s.text) || FRESH.period) + "</div></div>" : "";
    }

    // result.epochs, the logs with their parts (spans with a time), or null
    function epochsOf(r) {
        var list = r && Array.isArray(r.epochs) ? r.epochs.filter(function (E) { return E && isNum(E.log) && Array.isArray(E.spans); }).map(function (E) {
            return { log: E.log, spans: E.spans.filter(function (s) { return s && typeof s === "object" && isNum(s.t0) && isNum(s.t1); }) };
        }).filter(function (E) { return E.spans.length; }) : [];
        return list.length ? list.sort(function (a, b) { return a.log - b.log; }) : null;
    }

    function epochOf(r, li) {
        return (epochsOf(r) || []).filter(function (E) { return E.log === li; })[0] || null;
    }

    // A part with a cause: reasons, else fresh false
    function hasCause(s) {
        return Array.isArray(s.reasons) && s.reasons.length ? true : s.fresh === false;
    }

    // "Arm 2", "Disarmed after arm 1" (span.arm 0 is the arm of the log header)
    function armText(s) {
        var n = isNum(s.arm) ? s.arm + 1 : null;
        return n === null ? "" : s.armed === false ? "Disarmed after arm " + n : "Arm " + n;
    }

    // A CLI dump that the log contradicts for PID profile p (result.cliStatus: not used, or a gov_headspeed conflict of p; p 0: the rate
    // profile), as js/log_lens.js cliDisagrees
    function cliDisagrees(r, p) {
        var st = r && r.cliStatus;
        return !!(st && typeof st === "object" && (st.used === false || (p > 0 && Array.isArray(st.conflicts) && st.conflicts.some(function (c) { return c && c.what === "gov_headspeed" && c.profile === p; }))));
    }

    // "log header of log 12" for a source of a part (span.source.pid or .rate); p: the PID profile of the part (0 for the rate profile)
    function sourceWord(v, r, p) {
        var m = /^log (\d+)$/.exec(String(v));
        if (v === "cli" && cliDisagrees(r, p || 0)) return FRESH_OLD_CLI;
        return m ? "log header of log " + (+m[1] + 1) : FRESH_SOURCE[v] || (v ? oneLine(v) : FRESH_SOURCE.none);
    }

    // The source of the values of a part s, as a label: "Log header of log 12", or "Log header of log 12 (PID profile), log header
    // (rate profile)" when the PID profile and the rate profile have different sources
    function sourceLabel(s, r) {
        var src = s && s.source;
        if (!src || typeof src !== "object") return cap(FRESH_SOURCE.none);
        var p = sourceWord(src.pid, r, isNum(s.pidProfile) ? s.pidProfile : 0), q = sourceWord(src.rate, r, 0);
        return p === q ? cap(p) : cap(p) + " (PID profile), " + q + " (rate profile)";
    }

    // The parts with a cause of log li, for the flight list: { n, of, title } (title: a line for each part), or null
    function epochSummary(r, li) {
        var E = epochOf(r, li), marked = E ? E.spans.filter(hasCause) : [];
        if (!marked.length) return null;
        var lines = marked.slice(0, 12).map(function (s) {
            var c = causeText(s.reasons) || FRESH.badge;
            return [armText(s), rangeText(s.t0, s.t1)].filter(Boolean).join(", ") + ": " + c.charAt(0).toLowerCase() + c.slice(1) + ".";
        });
        if (marked.length > 12) lines.push(plural(marked.length - 12, "other part") + ".");
        return { n: marked.length, of: E.spans.length, title: lines.join("\n") };
    }

    // The flight list: "The values are possibly different in 3 of 5 parts.", a link to the parts in the Configurations tab. ""
    // for a log with no part that has a cause
    function epochHtml(r, li, ofLog) {
        var q = epochSummary(r, li);
        return q ? '<a href="#" class="tuning-fresh-link" title="' + esc(q.title) + '">' + esc("The values are possibly different in " + q.n + " of " + plural(q.of, "part") + (ofLog ? " of this log" : "") + ".") + "</a>" : "";
    }

    // The line of the overview: "793 of 955 results use values that are possibly different from the log header.", a link to the
    // parts and the caveat in the Configurations tab. "" when no result on display has a mark
    function freshLine(fs) {
        var n = fs.filter(staleOf).length;
        return n ? '<div class="tuning-muted"><a href="#" class="tuning-fresh-link" title="Show the parts of the logs in the Configurations tab">' +
            esc(n + " of " + plural(fs.length, "result") + (n === 1 ? " uses" : " use") + " values that are possibly different from the log header.") + "</a></div>" : "";
    }

    // The counts of the marked items: "793 of 955 results, 60 of 70 periods at a limit and 41 of 53 recommendations use one of
    // these parts.", "" when no item has a mark
    function freshCounts(r) {
        var fs = Array.isArray(r.findings) ? r.findings.filter(function (f) { return f && typeof f === "object"; }) : [], recs = recsOf(r);
        var pAll = 0, pMarked = 0;
        fs.forEach(function (f) { pAll += periodCount(f); pMarked += stalePeriods(f).length; });
        var nf = fs.filter(staleOf).length, nr = recs.filter(staleOf).length;
        if (!nf && !nr && !pMarked) return "";
        var parts = [nf + " of " + plural(fs.length, "result")].concat(pAll ? [pMarked + " of " + plural(pAll, "period") + " at a limit"] : [], recs.length ? [nr + " of " + plural(recs.length, "recommendation")] : []);
        return "In this analysis, " + (parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0]) + " use one of these parts.";
    }

    // The section of the Configurations tab: what the log header has, the causes that the logs show (result.freshness.reasons),
    // the caveat (result.freshness.caveat: no mark is not proof), the counts, and a row for each part with a cause of each flight
    // log (a bench run is not in the analysis) with its arm, PID profile, rate profile, causes (the text of the part in the title)
    // and the source of its values. "" without result.epochs
    function freshnessHtml(r, uid) {
        var list = epochsOf(r);
        if (!list) return "";
        var fr = r.freshness && typeof r.freshness === "object" ? r.freshness : {}, why = fr.reasons && typeof fr.reasons === "object" ? fr.reasons : {}, fl = flightsOf(r);
        var logs = list.filter(function (E) { var L = fl && fl.logs[E.log]; return !(L && (L.bench || L.noData)); }), used = {};
        logs.forEach(function (E) { E.spans.forEach(function (s) { (Array.isArray(s.reasons) ? s.reasons : []).forEach(function (k) { used[k] = true; }); }); });
        var keys = FRESH_ORDER.filter(function (k) { return used[k]; }).concat(Object.keys(used).filter(function (k) { return FRESH_ORDER.indexOf(k) < 0; }));
        var rows = [];
        logs.forEach(function (E) {
            var marked = E.spans.filter(hasCause);
            if (!marked.length) {
                rows.push("<tr><td>" + esc(logLabel(E.log)) + '</td><td colspan="6" class="tuning-muted">' + esc(FRESH.noCause + (E.spans.length > 1 ? " in " + plural(E.spans.length, "part") : "")) + "</td></tr>");
                return;
            }
            marked.forEach(function (s) {
                var pid = isNum(s.pidProfile) && s.pidProfile > 0 ? String(s.pidProfile) : "unknown", rate = isNum(s.rateProfile) && s.rateProfile > 0 ? String(s.rateProfile) : "unknown";
                rows.push("<tr><td>" + esc(logLabel(E.log)) + "</td><td>" + partLink(E.log, s.t0, s.t1, rangeText(s.t0, s.t1), s.text || FRESH.period) + "</td><td>" + esc(armText(s)) +
                    '</td><td class="tuning-num">' + esc(pid) + '</td><td class="tuning-num">' + esc(rate) + '</td><td><span class="tuning-fresh-cause" title="' + esc(oneLine(s.text) || FRESH.period) + '">' +
                    esc(causeText(s.reasons) || FRESH.badge) + "</span></td><td>" + esc(sourceLabel(s, r)) + "</td></tr>");
            });
        });
        var counts = freshCounts(r), skipped = list.length - logs.length;
        return '<div class="tuning-fresh" id="' + esc(uid || "tuning") + '-fresh"><h5 class="tuning-h">' + esc(FRESH.heading) + "</h5>" +
            '<p class="tuning-muted">' + esc(FRESH.about + " " + FRESH.mark) + "</p>" +
            '<p class="tuning-fresh-caveat">' + esc([oneLine(fr.caveat), FRESH.noMark].filter(Boolean).join(" ")) + "</p>" +
            (counts ? '<p class="tuning-muted">' + esc(counts) + "</p>" : "") +
            (keys.length ? '<dl class="tuning-fresh-causes">' + keys.map(function (k) { // a label and its text: two texts
                return "<dt" + (FRESH_CAUSE[k] ? "" : ' data-ste="quoted"') + ">" + esc(FRESH_CAUSE[k] || k) + "</dt><dd>" + esc(oneLine(why[k])) + "</dd>";
            }).join("") + "</dl>" : '<p class="tuning-muted">' + esc(FRESH.none) + "</p>") +
            (rows.length ? '<p class="tuning-muted">' + esc(FRESH.table + (skipped ? " " + plural(skipped, "log") + " with no flight " + (skipped === 1 ? "is" : "are") + " not in the table." : "")) + "</p>" +
                '<div class="tuning-table-wrap"><table class="tuning-table tuning-fresh-table"><thead><tr><th>Log</th><th>Part of the log</th><th>Arm</th><th>PID profile</th><th>Rate profile</th>' +
                "<th>Causes</th><th>Values from</th></tr></thead><tbody>" + rows.join("") + "</tbody></table></div>" : "") + "</div>";
    }

    // The rows of the report: [log, part, arm, PID profile, rate profile, values from, text] of each part with a cause of each
    // flight log
    function freshnessRows(r) {
        var list = epochsOf(r) || [], fl = flightsOf(r), out = [];
        list.forEach(function (E) {
            var L = fl && fl.logs[E.log];
            if (L && (L.bench || L.noData)) return;
            E.spans.filter(hasCause).forEach(function (s) {
                out.push([logLabel(E.log), rangeText(s.t0, s.t1), armText(s), profileLabel(isNum(s.pidProfile) ? s.pidProfile : 0), "rate profile " + (isNum(s.rateProfile) && s.rateProfile > 0 ? s.rateProfile : "unknown"),
                    sourceLabel(s, r), oneLine(s.text) || causeText(s.reasons)]);
            });
        });
        return out;
    }

    function excludedText(ex) {
        var names = { rescueS: "rescue", levelModeS: "level mode", failsafeS: "failsafe", groundS: "on the ground", guardS: "near a change" };
        return Object.keys(ex).filter(function (k) { return ex[k] >= 0.05; })
            .map(function (k) { return (names[k] || k) + " " + secs(ex[k]); }).join(", ");
    }

    // The craft name of a CLI dump (V1): "set name = X" or the "# name: X" line of "dump" and "diff all". null when the dump
    // has none ("-" is the firmware default)
    function cliCraft(text) {
        var t = String(text || ""), m = /^[ \t]*set[ \t]+name[ \t]*=[ \t]*(.*?)[ \t]*\r?$/im.exec(t) || /^[ \t]*#[ \t]*name:[ \t]*(.*?)[ \t]*\r?$/im.exec(t);
        var v = m ? m[1].trim() : "";
        return v && v !== "-" ? v : null;
    }

    // Two craft names are the same when they differ only in upper and lower case or in the spaces at the ends
    function sameCraft(a, b) {
        return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
    }

    function firmwareNote(fw) {
        var m = /rotorflight\D*(\d+)\.(\d+)/i.exec(String(fw || ""));
        if (!fw) return "";
        if (!m) return "This is not a Rotorflight log. The checks and the CLI names are for Rotorflight 4.6.";
        if (+m[1] * 100 + +m[2] < 406) return "This log is from Rotorflight " + m[1] + "." + m[2] + ". The checks and the CLI names are for Rotorflight 4.6. Some parameters are different.";
        return "";
    }

    // The flight rpm and where it came from (js/tuning_worker.js autoRpm): "1900 (85 % of the lowest governor target: 2300
    // rpm in PID profile 1, 70.4 s in flight in logs 50, 51, 52)"; profile as the log has it (0 = the arming profile), logs from 0
    function rpmText(fr) {
        if (!fr) return "";
        var logs = Array.isArray(fr.logs) ? fr.logs.filter(isNum) : [];
        var basis = (isNum(fr.basis) ? ": " + Math.round(fr.basis) + " rpm" + (isNum(fr.profile) && fr.profile > 0 ? " in " + profileLabel(fr.profile) : "") : "") +
            (isNum(fr.seconds) ? ", " + secs(fr.seconds) + " in flight" : "") +
            (logs.length ? " in log" + (logs.length > 1 ? "s " : " ") + logLabel(logs.slice(0, 8)) + (logs.length > 8 ? " and " + (logs.length - 8) + " more" : "") : "");
        var why = { user: "your value", govTarget: "85 % of the lowest governor target" + basis, headspeed: "85 % of the lowest median headspeed in flight of a PID profile" + basis,
            "default": "the value of the toolkit" }[fr.source] || oneLine(fr.source);
        return num(fr.value) + " (" + why + ")";
    }

    function rateNote(rate) {
        return isNum(rate) && rate < 1000 ? "The log rate is " + Math.round(rate) + " Hz. The Nyquist frequency is " + Math.round(rate / 2) + " Hz. " + LOW_RATE : "";
    }

    // ---------------------------------------------------------------------------------------------
    // Time base

    // The record of log li that holds index time t (s), or the one of `segment`
    function recordAt(result, li, t, segment) {
        var list = (result.records || []).filter(function (r) { return r.log === li; });
        if (isNum(segment)) return list.filter(function (r) { return r.segment === segment; })[0] || list[0] || null;
        return list.filter(function (r) { return isNum(r.fromS) && isNum(r.seconds) && t >= r.fromS - 1e-6 && t <= r.fromS + r.seconds + 1e-6; })[0] || list[0] || null;
    }

    // Index time (fromS + i / actualRate: the modules and curves) to frame seconds (the viewer clock), through the
    // worker's time map of the segment: { fromS, every, actualRate (or rate), n, frameS (the frame seconds of samples 0,
    // every, 2 every, ...), endS (of the last sample), jumps: [[i, frame s of sample i - 1, frame s of sample i]] (a loop
    // stall or lost frames) }. The same function as tools/autotune/evidence.cjs toFrame, so the spans of the evidence and
    // the times of this view agree. Without a time map, t
    function toFrame(tm, t) {
        if (!tm || !isNum(t) || !tm.frameS || !tm.frameS.length) return t;
        // inside the segment the index is the nearest sample: module times are sample times rounded to 1 ms, and at a jump
        // the sample decides the side
        var rate = tm.actualRate || tm.rate, E = tm.every || 250, N = tm.frameS.length, last = Math.max(0, (isNum(tm.n) ? tm.n : (N - 1) * E + 1) - 1),
            x = (t - tm.fromS) * rate, i = x > 0 && x < last ? Math.round(x) : x;
        if (!(rate > 0) || !isNum(tm.fromS)) return t;
        var endS = isNum(tm.endS) ? tm.endS : tm.frameS[N - 1] + (last - (N - 1) * E) / rate;
        if (i <= 0) return tm.frameS[0] + i / rate;
        if (i >= last) return endS + (i - last) / rate;
        var k = Math.min(N - 1, Math.floor(i / E)), a = k * E, sa = tm.frameS[k], b = k + 1 < N ? (k + 1) * E : last, sb = k + 1 < N ? tm.frameS[k + 1] : endS;
        (Array.isArray(tm.jumps) ? tm.jumps : []).forEach(function (q) {
            var j = q[0];
            if (j <= a || j > b) return;
            if (i >= j) { a = j; sa = q[2]; } else { b = j - 1; sb = q[1]; }
        });
        return b === a ? sa : sa + (i - a) / (b - a) * (sb - sa);
    }

    function frameOf(result, li, t, segment) {
        var rec = recordAt(result, li, t, segment);
        return toFrame(rec && rec.timeMap, t);
    }

    // ---------------------------------------------------------------------------------------------
    // HTML pieces

    function cls(status) {
        return String(status).toLowerCase();
    }

    // The pane of a compare slot: "recs:3" is in "recs"
    function paneOf(where) {
        return String(where || "").split(":")[0];
    }

    function badge(text, status, title) {
        return '<span class="tuning-badge st-' + cls(status) + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + esc(text) + "</span>";
    }

    function notice(kind, html) {
        return '<div class="tuning-notice is-' + kind + '">' + html + "</div>";
    }

    // Text that is not ours (toolkit text, worker messages): shown as it is, and the STE lint does not read it
    function quoted(html, tag) {
        return "<" + (tag || "span") + ' data-ste="quoted">' + html + "</" + (tag || "span") + ">";
    }

    function timeLinks(f) {
        var times = Array.isArray(f.times) ? f.times.filter(isNum) : [];
        var links = times.slice(0, 3).map(function (t) {
            var label = esc(num(+t.toFixed(1))) + " s";
            return typeof f.log === "number" ?
                '<a href="#" class="tuning-seek" data-log="' + esc(f.log) + '" data-t="' + esc(t) + '" data-id="' + esc(f.id) + '" data-axis="' + esc(findingAxis(f) || "") +
                    '" title="Show this part of the log">' + label + "</a>" : label;
        });
        if (times.length > 3) links.push('<span class="tuning-muted">+' + (times.length - 3) + "</span>");
        return links.join(" ");
    }

    // "Show the measurement" has something to draw: a table with rows, 2 or more values of the check, a curve of the
    // result, or log fields with a part of the log to read them from
    function canCompare(ev) {
        var plot = ev && ev.plot;
        if (!plot || typeof plot !== "object") return false;
        if (plot.kind === "table") return (Array.isArray(plot.rows) && plot.rows.length > 0) || (Array.isArray(plot.table) && plot.table.length > 0);
        if (plot.kind === "events" && Array.isArray(plot.points) && plot.points.filter(function (q) { return q && isNum(q.t) && isNum(q.value); }).length > 1) return true;
        if (plot.curve) return true;
        var snip = plot.snippet, spans = Array.isArray(ev.spans) ? ev.spans.filter(function (q) { return q && isNum(q.t0) && isNum(q.t1); }) : [];
        return !!(snip && Array.isArray(snip.fields) && snip.fields.length && (spans.length || (ev.view && isNum(ev.view.t0) && isNum(ev.view.t1))));
    }

    // The caption of the plot of a result (evidence.cjs plot.caption, SPEC3 H): one STE sentence that says what the curves
    // are and where the limit is, under the plot. "" without one
    function captionHtml(f) {
        var plot = f && f.evidence && f.evidence.plot, text = plot && typeof plot.caption === "string" ? oneLine(plot.caption) : "";
        return text ? '<p class="tuning-plot-caption">' + esc(text).replace(/`([^`]*)`/g, "<code>$1</code>") + "</p>" : "";
    }

    // Why "Show the measurement" has no plot from the curves of the result (STE). ofLog: the result has curves of log
    // `log`, without these data. Else the result has the curves of other logs ("All logs in the file" keeps the curves of
    // the log that the viewer shows), or none
    function noCurveText(r, log, ofLog) {
        var name = isNum(log) ? "log " + logLabel(log) : "this log";
        if (ofLog) return "The curves of " + name + " do not contain the data of this plot.";
        var logs = (r && Array.isArray(r.curves) ? r.curves : []).map(function (c) { return c && c.log; })
            .filter(function (l, i, all) { return isNum(l) && all.indexOf(l) === i; }).sort(function (a, b) { return a - b; });
        if (!logs.length) return "The result has no curves. Thus, the app cannot show this plot.";
        var list = logs.map(logLabel), which = list.length > 1 ? "logs " + list.slice(0, -1).join(", ") + " and " + list[list.length - 1] : "log " + list[0];
        return "The result has curves only for " + which + "." +
            (isNum(log) ? " To see this plot for " + name + ", open " + name + " in the log viewer. Then start the analysis again." : " Thus, the app cannot show this plot.");
    }

    // The links of a finding to its log evidence: "Show in the log", "Show the measurement" and the times of its spans
    function evidenceLinks(f, where, env) {
        var ev = f.evidence, key = env.keyOf(f), out = [], k = esc(key), open = env.compareOpen(key, where);
        if (ev && ev.view && isNum(ev.view.t0) && isNum(ev.view.t1)) {
            out.push('<a href="#" class="tuning-show" data-key="' + k + '" title="Show this part of the log">Show in the log</a>');
        }
        if (canCompare(ev)) {
            out.push('<a href="#" class="tuning-compare-open' + (open ? " active" : "") + '" data-key="' + k + '" data-where="' + esc(where) +
                '" title="Show a plot of the measured values and the limit">Show the measurement</a>');
        }
        var spans = ev && Array.isArray(ev.spans) ? ev.spans.filter(function (s) { return s && isNum(s.t0) && isNum(s.t1); }).slice(0, 3) : [];
        if (spans.length > 1 || (spans.length && !(ev.view && isNum(ev.view.t0)))) {
            var periods = stalePeriods(f); // a period of a limits check with a stale: the link has the mark of its period
            out.push('<span class="tuning-spans">' + spans.map(function (s, i) {
                var st = periods.length ? spanStale(f, s, periods) : null;
                return '<a href="#" class="tuning-span' + (st ? " is-stale" : "") + '" data-key="' + k + '" data-span="' + i + '" title="' +
                    esc("Show this part of the log" + (st ? ". " + (oneLine(st.text) || FRESH.period) : "")) + '">' + esc(num(+s.t0.toFixed(1))) + " s</a>";
            }).join(" ") + "</span>");
        }
        if (!ev) {
            var times = timeLinks(f);
            if (times) out.push(times);
        }
        return out.length ? out.join(" ") : '<span class="tuning-muted">No time in the log</span>';
    }

    // F5: what the gyro filters pass of each line, measured by the worker (gyroRAW -> gyroADC)
    function passHtml(f) {
        if (!Array.isArray(f.filterPass) || !f.filterPass.length) return "";
        var pct = function (v) { return isNum(v) ? num(v * 100) + " %" : "n/a"; };
        return '<div class="tuning-muted tuning-pass">Measured filter transmission, gyroRAW to gyroADC:<ul>' + f.filterPass.map(function (q) {
            return "<li>" + esc(num(q.hz) + " Hz: roll " + pct(q.roll) + ", pitch " + pct(q.pitch) + ", yaw " + pct(q.yaw) + ".") + "</li>";
        }).join("") + "</ul></div>";
    }

    // The upstream results of a K rule in a few words: "T8 yaw (PID profiles 1, 2 and 3), T13 yaw (PID profile 1)", with
    // the logs when withLog. One item for each check and axis, its PID profiles and logs together
    function upstreamText(list, withLog) {
        var groups = [], by = {};
        list.forEach(function (f) {
            var k = [f.id, findingAxis(f)].filter(Boolean).join(" "), g = by[k];
            if (!g) groups.push(g = by[k] = { name: k, profiles: [], logs: [] });
            var p = profileNo(f);
            if (p !== null && g.profiles.indexOf(p) < 0) g.profiles.push(p);
            [].concat(isNum(f.log) || Array.isArray(f.log) ? f.log : []).forEach(function (l) { if (isNum(l) && g.logs.indexOf(l) < 0) g.logs.push(l); });
        });
        function and(a) { return a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a[a.length - 1] : a.join(""); }
        return groups.map(function (g) {
            var known = g.profiles.filter(function (p) { return p > 0; }).sort(function (a, b) { return a - b; }), parts = [];
            if (known.length) parts.push((known.length > 1 ? "PID profiles " : "PID profile ") + and(known.map(String)));
            if (g.profiles.indexOf(0) >= 0) parts.push("PID profile unknown");
            if (withLog && g.logs.length) parts.push((g.logs.length > 1 ? "logs " : "log ") + and(g.logs.sort(function (a, b) { return a - b; }).map(logLabel)));
            return g.name + (parts.length ? " (" + parts.join(", ") + ")" : "");
        }).join(", ");
    }

    // The worker's display of a finding or of an evidence row (catalog.cjs display(): { value, bound, limit, unit, scale,
    // profile, phase }), or null for a result without it (no catalog.cjs in the worker)
    function displayOf(f) {
        return f && f.display && typeof f.display === "object" ? f.display : null;
    }

    function textOf(v) {
        return typeof v === "string" && v.trim() ? v : null;
    }

    // The value of a row as HTML: the worker's display.value (STE, in the unit of the rule: "1 loop stall", "0 V in 10 ms"),
    // else the value of the toolkit, quoted. A display with no value gives no value: never a bare toolkit count
    function valueHtml(f) {
        var d = displayOf(f);
        if (d) return textOf(d.value) ? esc(d.value).replace(/ ± /g, "&nbsp;±&nbsp;") : "";
        var raw = valueSe(f.value, f.se, f.unit);
        return raw ? quoted(esc(raw).replace(/ ± /g, "&nbsp;±&nbsp;")) : "";
    }

    // The limit of a row as HTML: display.bound (the limit in the unit of the value, the same in log and file scope), else
    // display.limit (an STE sentence), else the threshold of the toolkit, quoted
    function limitHtml(f) {
        var d = displayOf(f), raw = threshold(f.threshold);
        if (d && textOf(d.bound)) return esc(d.bound);
        if (d && textOf(d.limit)) return esc(d.limit);
        return raw ? quoted(esc(raw)) : "";
    }

    // display.value says how many: "1 loop stall", "0 of 44 notch filters", "33 % from 1 period of 10 s" (not "1000 Hz", "0 V")
    function givesCount(v) {
        return typeof v === "string" && (/\bfrom \d+ /.test(v) || /\b\d+ of \d+\b/.test(v) || (/^\d+ [a-z]{3,}/i.test(v) && !/^\d+ (deg|rpm)\b/i.test(v)));
    }

    // The sample counts of log li: of each segment (records[].timeMap.n) and of all of them together
    function sampleCounts(result, li) {
        var list = (result && result.records || []).filter(function (q) { return q && q.log === li && q.timeMap && isNum(q.timeMap.n); }).map(function (q) { return q.timeMap.n; });
        return list.length > 1 ? list.concat([list.reduce(function (a, b) { return a + b; }, 0)]) : list;
    }

    // The line under the value: the count of the result, only when it adds information. Not when display.value gives a
    // count, and not for 0. "332541 samples" when it is the sample count of the log, else "3 values"
    function countText(f, samples) {
        var n = f.n, d = displayOf(f);
        if (!isNum(n) || n <= 0 || (d && givesCount(d.value))) return "";
        return plural(n, Array.isArray(samples) && samples.indexOf(n) >= 0 ? "sample" : "value");
    }

    // The same as plain text, for the saved report
    function valueTextOf(f) {
        var d = displayOf(f);
        return d ? textOf(d.value) || "" : valueSe(f.value, f.se, f.unit);
    }

    function limitTextOf(f) {
        var d = displayOf(f);
        return d && (textOf(d.bound) || textOf(d.limit)) || threshold(f.threshold);
    }

    // The toolkit text of a finding (not STE), collapsed under its STE summary (SPEC2 D6)
    function toolkitText(text) {
        if (!oneLine(text)) return "";
        return '<details class="tuning-toolkit" data-ste="quoted"><summary>Toolkit text (not STE)</summary>' + esc(text) + "</details>";
    }

    // The two filters of the result lists (SPEC3 E): filter = { thin, ok }, true to show the results with the status "Not
    // sufficient data" (thin) or "Satisfactory" (ok). keep: { thin, ok }, the kinds that a list shows in each case (All
    // checks with "Satisfactory only"). { list (the rows to show), hidden (the number of rows not shown), counts: { thin, ok } }
    function filterResults(list, filter, keep) {
        var out = [], counts = { thin: 0, ok: 0 }, hidden = 0;
        filter = filter || {};
        (list || []).forEach(function (row) {
            var s = findingStatus(row), kind = s === "insufficient" ? "thin" : s === "satisfactory" ? "ok" : null;
            if (kind) counts[kind]++;
            if (kind && !filter[kind] && !(keep && keep[kind])) hidden++;
            else out.push(row);
        });
        return { list: out, hidden: hidden, counts: counts };
    }

    // The two filters above a list, with the number of results of each kind and the number of rows not shown. always:
    // also when the list has no result of the two kinds (All checks)
    function filterBar(filter, got, always) {
        if (!always && !got.counts.thin && !got.counts.ok) return "";
        function box(kind, label) {
            return '<label class="tuning-rf-item"><input type="checkbox" class="tuning-rf" data-rf="' + kind + '"' + (filter[kind] ? " checked" : "") + "> " +
                esc(label + " (" + got.counts[kind] + ")") + "</label>";
        }
        return '<div class="tuning-rf-bar">' + box("thin", "Show results with not sufficient data") + box("ok", "Show satisfactory results") +
            (got.hidden ? '<span class="tuning-muted tuning-rf-hidden">' + esc("The list does not show " + plural(got.hidden, "result") + ".") + "</span>" : "") + "</div>";
    }

    // Findings, or a recommendation's evidence (opts.evidence: no status column). opts.where: the pane key, for the
    // inline "Show the measurement" panel under a row
    function findingsTable(list, opts, env) {
        opts = opts || {};
        if (!list.length) return '<p class="tuning-muted">' + esc(opts.empty || "No result.") + "</p>";
        var cols = [opts.evidence ? null : ["severity", "Condition"], ["id", "Check"], opts.showLog ? ["log", "Log"] : null,
            [null, "PID profile and axis"], ["value", "Value"], [null, "Limit and source"], [null, "Result"], [null, "In the log"]].filter(Boolean);
        var head = cols.map(function (c) {
            if (!opts.sortable || !c[0]) return "<th>" + c[1] + "</th>";
            return '<th class="tuning-sortable' + (opts.sort === c[0] ? " is-sorted" + (opts.dir < 0 ? " is-desc" : "") : "") + '" data-sort="' + c[0] + '">' + c[1] + "</th>";
        }).join("");
        var rows = list.map(function (row) {
            var f = env.findingOf(row) || row, status = findingStatus(f), where = findingWhere(f, " · "), key = env.keyOf(f);
            var html = '<tr class="row-' + cls(status) + '">' +
                (opts.evidence ? "" : "<td>" + badge(STATUS[status], status, f.explained ? "Information only: " + f.explained : "") + "</td>") +
                '<td class="tuning-id">' + esc(f.id) + (f.module ? '<div class="tuning-muted"><code>' + esc(f.module) + "</code></div>" : "") + "</td>" +
                (opts.showLog ? "<td>" + esc(logLabel(f.log)) + "</td>" : "") +
                "<td>" + esc(where) + "</td>" +
                '<td class="' + (typeof f.value === "string" || displayOf(f) ? "tuning-text-value" : "tuning-num") + '">' + valueHtml(f) +
                    (countText(f, env.samplesOf ? env.samplesOf(f.log) : null) ? '<div class="tuning-muted">' + esc(countText(f, env.samplesOf ? env.samplesOf(f.log) : null)) + "</div>" : "") + "</td>" +
                '<td class="tuning-rule">' + limitHtml(f) + sourceHtml(f.source) + "</td>" +
                '<td class="tuning-text">' + staleHtml(f) + '<div class="tuning-summary-text">' + esc(summaryOf(f)) + "</div>" + passHtml(f) +
                    (f.explained ? '<div class="tuning-muted">Information only: ' + quoted(esc(f.explained)) + "</div>" : "") + toolkitText(f.text) + "</td>" +
                '<td class="tuning-times">' + evidenceLinks(f, opts.where || "", env) + "</td></tr>";
            if (env.compareOpen(key, opts.where || "")) html += '<tr class="tuning-compare-row"><td colspan="' + cols.length + '">' + env.compareHtml(f, opts.where || "") + "</td></tr>";
            return html;
        }).join("");
        return '<div class="tuning-table-wrap"><table class="tuning-table' + (opts.evidence ? " tuning-evidence" : "") + '"><thead><tr>' + head +
            "</tr></thead><tbody>" + rows + "</tbody></table></div>";
    }

    // The findings of one step for the side panel: one block each (a table does not fit). The compare panel of these
    // opens under the diagram, at its full width (orderSection)
    function findingsList(list, where, env) {
        if (!list.length) return '<p class="tuning-muted">No result for the checks of this step.</p>';
        return '<ul class="tuning-check-list">' + list.map(function (row) {
            var f = env.findingOf(row) || row, status = findingStatus(f), key = env.keyOf(f);
            var head = [f.id, findingWhere(f, " · "), typeof f.log === "number" ? "log " + logLabel(f.log) : ""].filter(Boolean).join(" · ");
            return '<li class="row-' + cls(status) + (env.compareOpen(key, where) ? " is-open" : "") + '">' + badge(STATUS[status], status) + ' <strong>' + esc(head) + "</strong>" +
                '<div class="tuning-summary-text">' + esc(summaryOf(f)) + "</div>" + staleHtml(f) +
                '<div class="tuning-muted">' + [valueHtml(f), limitHtml(f) ? "Limit: " + limitHtml(f) : ""].filter(Boolean).join(" · ") + "</div>" +
                '<div class="tuning-times">' + evidenceLinks(f, where, env) + "</div>" + toolkitText(f.text) + "</li>";
        }).join("") + "</ul>";
    }

    // The source's first clause, the whole of it on hover (toolkit text)
    function sourceHtml(source) {
        var text = oneLine(source), short = text.split(/;\s*/)[0];
        if (!text) return "";
        return '<div class="tuning-muted" data-ste="quoted"' + (short !== text ? ' title="' + esc(text) + '"' : "") + ">" + esc(short) + (short !== text ? "&hellip;" : "") + "</div>";
    }

    function cliBlock(text, env) {
        return '<div class="tuning-cli"><button type="button" class="btn btn-default btn-xs tuning-copy" data-copy="' + env.copy(text) +
            '">Copy</button><pre>' + esc(text) + "</pre></div>";
    }

    function bulletList(items, label, cls) {
        if (!Array.isArray(items) || !items.length) return "";
        return '<div class="tuning-rec-list ' + cls + '"><div class="tuning-label">' + label + "</div><ul>" +
            items.map(function (x) { return "<li>" + x + "</li>"; }).join("") + "</ul></div>";
    }

    // A blockedBy item: a step of the tuning sequence (a link to it in the diagram), else advice's own text
    function blockedItem(b, graph) {
        var n = graph && typeof b === "string" && graph.byId[b];
        return n ? '<a href="#" class="tuning-node-link" data-node="' + esc(n.id) + '">' + esc(n.title) + "</a>" : esc(oneLine(b));
    }

    // "Possible result of": the K rules of advice.cjs causes, the upstream findings and their recommendations
    function causesHtml(rec, entry, env) {
        var list = causesOf(rec);
        if (!list.length) return "";
        var recs = recsOf(entry.result);
        return '<div class="tuning-rec-list is-possible"><div class="tuning-label">Possible result of</div><ul>' + list.map(function (c) {
            var fids = Array.isArray(c.fids) ? c.fids : [], up = fids.map(function (fid) { return env.findingOf(fid); }).filter(Boolean);
            var links = recs.map(function (x, i) { return { rec: x, i: i }; }).filter(function (x) {
                return x.rec !== rec && (x.rec.evidence || []).some(function (e) { return e && fids.indexOf(e.fid) >= 0; });
            });
            return "<li><strong>" + esc([c.rule, c.name].filter(Boolean).join(" ")) + "</strong>" +
                (up.length ? ": " + esc(upstreamText(up, false)) : "") +
                (links.length ? '<div>Do first: ' + links.map(function (x) {
                    return '<a href="#" class="tuning-goto-rec" data-rec="' + x.i + '">' + esc(recommendationTitle(x.rec)) + "</a>";
                }).join(", ") + "</div>" : "") + stepsHtml(c.first) + "</li>";
        }).join("") + "</ul></div>";
    }

    // The sources of a recommendation (advice.cjs rec.sources), apart from its rule: the rule without its last sentences
    // 'Source: "..."', and the sources in a list of their own (not STE: quoted)
    function sourcesOf(rec) {
        return (Array.isArray(rec.sources) ? rec.sources : []).map(oneLine).filter(function (x, i, a) { return x && a.indexOf(x) === i; });
    }

    function ruleText(rec) {
        var rule = oneLine(rec.rule);
        return sourcesOf(rec).length ? rule.replace(/(\s*Sources?: "[^"]*"\.)+\s*$/, "") : rule;
    }

    function sourcesHtml(rec) {
        var list = sourcesOf(rec);
        if (!list.length) return "";
        return '<div class="tuning-rec-rule tuning-rec-sources"><div class="tuning-label">' + (list.length > 1 ? "Sources" : "Source") + "</div><ul>" +
            list.map(function (x) { return "<li>" + quoted(esc(x)) + "</li>"; }).join("") + "</ul></div>";
    }

    // The confidence label of a recommendation, "" for "advisory" and for a value that this view does not know
    function confidenceText(c) {
        return Object.prototype.hasOwnProperty.call(CONFIDENCE, c) ? CONFIDENCE[c] : "";
    }

    function recCard(rec, i, entry, env) {
        var sev = REC_SEVERITY[rec.severity] || REC_SEVERITY.info, area = REC_AREA_LABEL[rec.area] || cap(rec.area), graph = graphOf(entry.result);
        var held = isBlocked(rec) ? "blocked" : causesOf(rec).length ? "possible" : sev.status;
        return '<div class="tuning-rec st-' + cls(held) + '" id="' + env.recId(i) + '">' +
            '<div class="tuning-rec-head"><div class="tuning-rec-badges">' + recBadges(rec) + '</div><div class="tuning-rec-title">' + esc(recommendationTitle(rec)) + "</div>" +
                '<div class="tuning-muted">' + esc([area, profileText(rec), typeof rec.dataset === "string" && rec.dataset ? configLabel(rec.dataset) : "", confidenceText(rec.confidence),
                    groupOf(rec) ? "Group " + groupLabel(groupOf(rec)) : ""].filter(Boolean).join(" · ")) + "</div></div>" +
            (rec.text ? '<div class="tuning-rec-text">' + esc(rec.text) + "</div>" : "") +
            (rec.parameter ? '<div class="tuning-rec-param">' + parameterHtml(rec.parameter) + " " + esc(paramText(rec)) + "</div>" : "") +
            staleRecHtml(rec) + // r.stale: the caveat with its text (CLAUDE.md "Values that are possibly not current")
            recConfigHtml(rec, entry.result) +
            (ruleText(rec) ? '<div class="tuning-rec-rule"><div class="tuning-label">Rule</div><div>' + esc(ruleText(rec)) + "</div></div>" : "") +
            sourcesHtml(rec) +
            bulletList((rec.blockedBy || []).map(function (b) { return blockedItem(b, graph); }), "Blocked", "is-blocked") +
            causesHtml(rec, entry, env) +
            bulletList((rec.caveats || []).map(function (c) { return esc(oneLine(c)); }), "Note", "is-caveat") +
            findingsTable(Array.isArray(rec.evidence) ? rec.evidence : [], { evidence: true, showLog: true, where: "recs:" + i, empty: "This recommendation has no result." }, env) +
            (hasCli(rec) ? cliBlock(rec.cli.join("\n"), env) : '<div class="tuning-muted tuning-cli-none">' + esc(noCliText(rec)) + "</div>") +
        "</div>";
    }

    // advice ran when its coverage matrix came back: one row per parameter group, never empty
    function adviceRan(result) {
        return !!(result.advice && Array.isArray(result.advice.coverage) && result.advice.coverage.length);
    }

    function notesOf(result) {
        return (result.notes || []).concat(result.advice && result.advice.notes || []).map(String)
            .filter(function (n, i, all) { return all.indexOf(n) === i; });
    }

    function whyNoAdvice(result) {
        return notesOf(result).filter(function (n) { return /advice/i.test(n); })[0] || "the advice module gave no result";
    }

    function options(list, value) {
        return list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === value ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("");
    }

    // ---------------------------------------------------------------------------------------------
    // The tuning sequence: result.hierarchy (tools/autotune/hierarchy.cjs status() and graph, SPEC3 A and B). The graph has
    // two parts:
    //   prereq  the checklist before the first flight ({ id, title, about, checks, params, gates }). The analysis accepts an
    //           item as correct; it shows a problem only for a clear measured problem (status "problem"), else "ok" or "noData"
    //   blocks  the tuning steps, parameters only ({ id, title, about, lane: main | cyclic | tail, order, params, checks }):
    //           1 Filters, 2 Governor, then two lanes: 3a Cyclic gains, 4a Cyclic compensation, 3b Tail gains, 4b Tail
    //           compensation and authority. The checks of a step are its evidence
    // and edges ({ from, to, kind: gate | order | cause | validity, text, source }) and the K rules. hierarchy.nodes[id] has the
    // status of each item and step ({ status, fids, problemFids, blockedBy, possible, reason }), hierarchy.startHere the steps
    // to correct first (steps only), hierarchy.prereqProblems the items with a problem

    // { prereq, blocks, nodes, edges, byId, ruleById, columns } or null (a result without the graph of SPEC3 K1)
    function graphOf(result) {
        var h = result && result.hierarchy;
        if (!h || typeof h !== "object") return null;
        if (h.__graph) return h.__graph;
        var g = h.graph, all = g && Array.isArray(g.nodes) ? g.nodes.filter(function (n) { return n && n.id; }) : [];
        // the graph of SPEC3 K1 (prereq, blocks), or one list of nodes with their kind (hierarchy.cjs NODES)
        var pre = g && Array.isArray(g.prereq) ? g.prereq : all.filter(function (n) { return n.kind === "prereq"; }),
            blk = g && Array.isArray(g.blocks) ? g.blocks : all.filter(function (n) { return n.kind === "block"; });
        if (!g || typeof g !== "object" || !blk.length) return null;
        var byId = {}, ruleById = {}, rules = g.rules || h.RULES || [];
        var prereq = pre.filter(function (p) { return p && p.id; }).map(function (p) {
            return Object.assign({}, p, { kind: "prereq" });
        });
        var blocks = blk.filter(function (b) { return b && b.id; }).map(function (b, i) {
            return Object.assign({}, b, { kind: "block", lane: b.lane === "cyclic" || b.lane === "tail" ? b.lane : "main", order: isNum(+b.order) && b.order !== null ? +b.order : i + 1 });
        });
        prereq.concat(blocks).forEach(function (n) { byId[n.id] = n; });
        (Array.isArray(rules) ? rules : Object.keys(rules).map(function (id) { return Object.assign({ id: id }, rules[id]); }))
            .forEach(function (r) { if (r && r.id) ruleById[r.id] = r; });
        var out = { prereq: prereq, blocks: blocks, nodes: prereq.concat(blocks), byId: byId, ruleById: ruleById, columns: columnsOf(blocks),
            edges: (Array.isArray(g.edges) ? g.edges : []).filter(function (e) { return e && byId[e.from] && byId[e.to]; }) };
        Object.defineProperty(h, "__graph", { value: out, enumerable: false, configurable: true });
        return out;
    }

    // The columns of the flow: one for each `order`, with the steps of the main lane (they take the two rows) and of the
    // two lanes (cyclic in the first row, tail in the second)
    function columnsOf(blocks) {
        var orders = [];
        blocks.forEach(function (b) { if (orders.indexOf(b.order) < 0) orders.push(b.order); });
        return orders.sort(function (a, b) { return a - b; }).map(function (o) {
            var mine = blocks.filter(function (b) { return b.order === o; });
            return { order: o, main: mine.filter(function (b) { return b.lane === "main"; }), cyclic: mine.filter(function (b) { return b.lane === "cyclic"; }),
                tail: mine.filter(function (b) { return b.lane === "tail"; }) };
        });
    }

    function hasLanes(col) {
        return !!(col && (col.cyclic.length || col.tail.length));
    }

    // The number of a step: its order, with "a" for the cyclic lane and "b" for the tail lane ("3a")
    function stepNo(n) {
        return n.kind === "block" ? String(n.order) + (LANE_LETTER[n.lane] || "") : "";
    }

    function edgeText(e) {
        return oneLine(e && (e.text || e.why));
    }

    function paramsOf(n) {
        var p = n && (Array.isArray(n.params) ? n.params : Array.isArray(n.parameters) ? n.parameters : []);
        return (p || []).map(String).filter(Boolean);
    }

    // The status of each PID profile (hierarchy.byProfile: { "1": { nodes, startHere }, ... }, "0" the unknown arming
    // profile), or null
    function byProfileOf(r) {
        var by = r && r.hierarchy && r.hierarchy.byProfile;
        if (!by || typeof by !== "object") return null;
        var out = {}, any = false;
        Object.keys(by).forEach(function (k) {
            if (/^\d+$/.test(k) && by[k] && by[k].nodes) { out[+k] = by[k]; any = true; }
        });
        return any ? out : null;
    }

    // The status for the PID profile on display: its own, else the status of all PID profiles. ds: the configuration on
    // display ("all" or its id): its own status (hierarchy.byDataset), else the status of its PID profile
    function hierFor(r, sel, ds) {
        var by = byProfileOf(r), h = r.hierarchy, d = ds && ds !== "all" ? configOf(r, ds) : null;
        if (d && h && h.byDataset && h.byDataset[d.id] && h.byDataset[d.id].nodes) return h.byDataset[d.id];
        if (d && isNum(d.pidProfile) && d.pidProfile > 0 && by && by[d.pidProfile]) return by[d.pidProfile];
        return sel !== "all" && by && by[sel] ? by[sel] : r.hierarchy;
    }

    // The PID profiles of a result: of the per-profile status, the findings, the recommendations and the flight time. 0 (the
    // unknown arming profile) is last, and only when an item has it
    function profileList(r) {
        var seen = {}, by = byProfileOf(r);
        Object.keys(by || {}).forEach(function (k) { seen[k] = true; });
        (r.findings || []).concat(recsOf(r)).forEach(function (x) { var p = profileNo(x); if (p !== null) seen[p] = true; });
        (r.records || []).forEach(function (rec) {
            Object.keys(rec.profileSeconds || {}).forEach(function (k) { if (/^[1-9]\d*$/.test(k) && rec.profileSeconds[k] >= 0.05) seen[+k] = true; });
        });
        return Object.keys(seen).map(Number).sort(function (a, b) { return (a === 0) - (b === 0) || a - b; });
    }

    // The status of an item or a step that has a problem in it (a prerequisite with a problem, a step with a problem)
    function hasProblem(hier, graph, id) {
        var n = graph && graph.byId[id];
        if (n && n.kind === "prereq") return prereqState(hier, id).key === "problem";
        return /^(start|problem|blocked|possible)$/.test(nodeState(hier, id).key);
    }

    // The PID profile selector of the diagram and the lists: "All PID profiles" and each PID profile, with a chip for the
    // number of items and steps with a problem in it (results with the condition "Problem" without a per-profile status)
    function profileBar(entry, view) {
        var r = entry.result, list = profileList(r), by = byProfileOf(r), graph = graphOf(r);
        if (list.length < 2) return "";
        function chip(p) {
            var n, title;
            if (by && by[p]) {
                n = Object.keys(by[p].nodes).filter(function (id) { return hasProblem(by[p], graph, id); }).length;
                title = n === 1 ? "1 item with a problem" : n + " items with a problem";
            } else {
                n = (r.findings || []).filter(function (f) { return profileNo(f) === p && findingStatus(f) === "problem"; }).length;
                title = n === 1 ? '1 result with the condition "Problem"' : n + ' results with the condition "Problem"';
            }
            return n ? ' <span class="tuning-profile-count" title="' + esc(title) + '">' + n + "</span>" : "";
        }
        return '<div class="tuning-profile-bar" role="group" aria-label="PID profile"><span class="tuning-label">PID profile</span>' +
            '<span class="btn-group btn-group-xs">' + [["all", "All PID profiles"]].concat(list.map(function (p) { return [p, profileLabel(p)]; })).map(function (o) {
                return '<button type="button" class="btn btn-default tuning-profile' + (String(view.profile) === String(o[0]) ? " active" : "") + '" data-profile="' + esc(o[0]) + '">' +
                    esc(o[1]) + (o[0] === "all" ? "" : chip(o[0])) + "</button>";
            }).join("") + "</span></div>";
    }

    // ---------------------------------------------------------------------------------------------
    // Configurations (SPEC3 J, M1): result.datasets, the output of tools/autotune/datasets.cjs datasets(). A configuration
    // ("dataset" in the toolkit) is one PID profile and one exact set of the parameter values that change the flight. Each
    // finding has f.dataset ("A", "B", ..., null for a header or global check), each recommendation r.dataset (the newest
    // configuration of its PID profile), r.supportedBy (the configurations with data for it), r.ab (A/B differences) and
    // r.slope (the measured slope, when it is more than 2 SE). The view writes "Configuration A". The configuration menu
    // filters the diagram, the lists and the log lens (getConfiguration, onConfiguration)

    // result.datasets with a list of configurations, else null
    function datasetsOf(r) {
        var ds = r && r.datasets;
        return ds && typeof ds === "object" && Array.isArray(ds.datasets) ? ds : null;
    }

    // all: also the configurations that are not in the time of the analysis (d.analysed false: another log of the file, or a
    // flight that the pilot did not select)
    function configList(r, all) {
        var ds = datasetsOf(r);
        return ds ? ds.datasets.filter(function (d) { return d && typeof d.id === "string" && d.id && (all || d.analysed !== false); }) : [];
    }

    // The seconds of flight of a configuration in the analysis (analysedFlightSeconds of the worker), else in the file
    function configFlight(d) {
        return isNum(d.analysedFlightSeconds) && d.analysed !== undefined ? d.analysedFlightSeconds : d.flightSeconds;
    }

    function configOf(r, id) {
        return configList(r, true).filter(function (d) { return d.id === id; })[0] || null;
    }

    // Keep an explicit choice only while it belongs to this analysis. Prefer
    // flight data when replacing a choice after a change of logs or flights.
    function selectedConfig(r, id) {
        var list = configList(r), selected = list.find(function (d) { return d.id === id; });
        if (selected) return selected;
        var flown = list.filter(function (d) { return configFlight(d) > 0; }), ds = datasetsOf(r);
        var choices = flown.length ? flown : list;
        return choices.find(function (d) { return ds && d.id === ds.newest; }) || choices[choices.length - 1] || null;
    }

    function configLabel(id) {
        return "Configuration " + id;
    }

    // "A", "A and B", "A, B and C"
    function andText(list) {
        return list.length > 1 ? list.slice(0, -1).join(", ") + " and " + list[list.length - 1] : list.join("");
    }

    // "log 6", "logs 6, 11 and 12" (the toolkit numbers logs from 0)
    function logsText(logs) {
        var list = (Array.isArray(logs) ? logs : []).filter(isNum).sort(function (a, b) { return a - b; }).map(logLabel);
        return list.length ? (list.length > 1 ? "logs " : "log ") + andText(list) : "";
    }

    // Where the PID profile values of a configuration come from when its logs do not show them (datasets.cjs assumedFrom:
    // the header of the nearest log armed in that PID profile, or the CLI dump): "", or a short text
    function configFrom(d) {
        var logs = [], cli = false;
        (Array.isArray(d.assumedFrom) ? d.assumedFrom : []).forEach(function (a) {
            if (a && isNum(a.from) && logs.indexOf(a.from) < 0) logs.push(a.from);
            if (a && a.from === "cli") cli = true;
        });
        return logs.length ? "PID profile values from " + logsText(logs) : cli ? "PID profile values from the CLI dump" : "";
    }

    // Where the values of a configuration come from (datasets.cjs sources: header, cli, "log N", adjustment, none): "Values from
    // the log header and the CLI dump", or ""
    function configSources(d) {
        var src = d && d.sources && typeof d.sources === "object" ? d.sources : null, kinds = {}, names = { header: "the log header", cli: "the CLI dump", log: "a different log", adjustment: "an adjustment in flight" };
        if (!src) return "";
        Object.keys(src).forEach(function (k) {
            var v = String(src[k]);
            if (v !== "none") kinds[names[v] ? v : /^log \d+$/.test(v) ? "log" : "other"] = true;
        });
        var parts = ["header", "cli", "log", "adjustment"].filter(function (k) { return kinds[k]; }).map(function (k) { return names[k]; });
        return parts.length ? "Values from " + andText(parts) : "";
    }

    // The marks of a configuration: the PID profile values from a different log, the values that are unknown, the newest
    function configMarks(d, ds) {
        var out = [], from = configFrom(d), newest = ds && ds.newestByProfile ? ds.newestByProfile[d.pidProfile > 0 ? d.pidProfile : "unknown"] : null;
        if (from) out.push(from);
        if (Array.isArray(d.unknown) && d.unknown.length) out.push(plural(d.unknown.length, "value") + " unknown");
        if (d.analysed === false) out.push("not in the analysis");
        if (d.newest || (ds && ds.newest === d.id)) out.push("the newest");
        else if (newest === d.id && d.pidProfile > 0) out.push("the newest of " + profileLabel(d.pidProfile));
        return out;
    }

    // "Configuration B: PID profile 2, logs 50, 51 and 59, 2.9 min of flight, 56 values unknown"
    function configText(d, ds) {
        var flight = isNum(configFlight(d)) ? secs(configFlight(d)) + " of flight" : "";
        return configLabel(d.id) + ": " + [profileLabel(isNum(d.pidProfile) ? d.pidProfile : 0), logsText(d.logs), flight].concat(configMarks(d, ds)).filter(Boolean).join(", ");
    }

    // The configuration on display shows an item: an item of no single configuration (f.dataset null, a header check), an
    // item of that configuration, or one with data from it (r.supportedBy, the configurations of an issue, an evidence row)
    function inDataset(x, sel) {
        if (!sel || sel === "all" || !x) return true;
        var own = typeof x.dataset === "string" && x.dataset ? x.dataset : null, more = [];
        if (Array.isArray(x.supportedBy)) more = more.concat(x.supportedBy);
        if (Array.isArray(x.datasets)) more = more.concat(x.datasets);
        (Array.isArray(x.evidence) ? x.evidence : []).forEach(function (e) { if (e && typeof e.dataset === "string") more.push(e.dataset); });
        if (own && Array.isArray(x.cli)) return own===sel;
        if (own === sel || more.indexOf(sel) >= 0) return true;
        return !own && !more.length;
    }

    // The PID profile and the configuration on display (view.profile, view.dataset) show an item
    function inView(x, v) {
        return inProfile(x, v ? v.profile : "all") && inDataset(x, v ? v.dataset : "all");
    }

    // Closed disclosures must not build their tables or plots. Chromium 99 still pays for large hidden DOM trees
    // when updating native accessibility. The host inserts a disclosure's body only after its native toggle event.
    function deferredDetails(env, key, label, classes, open, build, summaryAttrs) {
        if (env && env.details) return env.details(key, label, classes, open, build, summaryAttrs);
        var out = build(); // standalone HTML consumers have no event host
        if (env && env.extra && out.plots) Array.prototype.push.apply(env.extra, out.plots);
        return '<details class="' + classes + '"' + (open ? ' open' : '') + '><summary' + (summaryAttrs || '') + '>' + label + '</summary>' + out.html + '</details>';
    }

    // The configuration menu, next to the PID profile menu: "All configurations" and each configuration with its PID profile,
    // logs, flight time and marks. With one configuration or none the result has nothing to choose
    function configBar(entry, view, env) {
        var r=entry.result, ds=datasetsOf(r), list=configList(r), sel=selectedConfig(r,view.dataset);
        if (!list.length) return '';
        var id=(env && env.uid ? env.uid : 'tuning')+'-config';
        return '<div class="tuning-config-bar" role="group" aria-label="Recorded configuration"><label class="tuning-label" for="'+esc(id)+'">Recorded configuration</label>'+
            '<select class="form-control input-sm tuning-config" id="'+esc(id)+'">'+options(list.map(function(d){return [d.id,configText(d,ds)];}),sel ? sel.id : list[list.length-1].id)+'</select>'+
            '<p class="tuning-muted">Each configuration keeps its tuning changes. In Export, select one configuration for each PID profile.</p>'+
            (sel ? deferredDetails(env, 'configuration:values', 'Recorded values of ' + esc(configLabel(sel.id)), 'tuning-config-reference', false, function () {
                return { html: '<p>'+esc(configSources(sel))+'</p><div class="tuning-table-wrap"><table class="tuning-table"><thead><tr><th>Parameter</th><th>Recorded value</th><th>Source</th></tr></thead><tbody>'+Object.keys(sel.values||{}).sort().map(function(k){return '<tr><td><code>'+esc(k)+'</code></td><td><code>'+esc(sel.values[k]===null ? 'Unknown' : String(sel.values[k]))+'</code></td><td>'+esc(sel.sources&&sel.sources[k]||'Unknown')+'</td></tr>';}).join('')+'</tbody></table></div>' };
            }) : '') + deferredDetails(env, 'configuration:comparison', 'Compare recorded configurations', 'tuning-config-reference tuning-config-comparison', false, function () {
                return { html: env && env.configReference ? env.configReference(entry,view) : '' };
            }) + '</div>';
    }

    // The note of the diagram for a configuration on display: its own status (hierarchy.byDataset), else the status of its PID
    // profile
    function configNote(r, hier, id) {
        var d = configOf(r, id), h = r.hierarchy;
        if (h && h.byDataset && hier === h.byDataset[id]) return "The diagram and the lists show " + configLabel(id) + " and the items for all configurations.";
        return (d && d.pidProfile > 0 && hier !== h ? "The diagram shows " + profileLabel(d.pidProfile) + ", the PID profile of " + configLabel(id) + "." :
            "The diagram shows the results of all configurations together.") + " The lists show " + configLabel(id) + " and the items for all configurations.";
    }

    // The PID profile menu and the configuration menu, in one row
    function selectBars(entry, view, env) {
        return configList(entry.result).length ? '' : profileBar(entry,view);
    }

    // Parameter names in explanatory text use the same labels as the tables. Other quoted text stays in code font.
    function mdCode(text) {
        return oneLine(text).split(/(`[^`]*`)/).map(function (part) {
            if (part.charAt(0) !== "`") return esc(part);
            var name = part.slice(1, -1);
            return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name) ? parameterHtml(name) : "<code>" + esc(name) + "</code>";
        }).join("");
    }

    // The value of a parameter in a configuration for the table: the value (code font), "?" (unknown: no source shows it), or
    // "-" (the configuration does not have this parameter)
    function diffCell(row, id) {
        var v = row.values ? row.values[id] : undefined, missing = Array.isArray(row.missingIn) && row.missingIn.indexOf(id) >= 0;
        if (missing || v === undefined) return '<span class="tuning-diff-absent" title="The configuration does not have this parameter">-</span>';
        if (v === null) return '<span class="tuning-diff-unknown" title="The value is unknown">?</span>';
        return "<code>" + esc(num(v)) + "</code>";
    }

    // The table "Parameters that are not the same": one row for each parameter (name in code font, its group), one column for
    // each configuration. A row with different values in two configurations of the same PID profile has the class
    // is-same-profile: the analysis can compare those configurations (A/B). The column of the configuration on display has
    // the class is-selected
    function diffTable(ds, sel) {
        var list = (ds.datasets || []).filter(function (d) { return d && d.id; }), rows = Array.isArray(ds.diff) ? ds.diff.filter(function (q) { return q && q.name; }) : [];
        if (!rows.length) return '<p class="tuning-muted">All configurations have the same values of the parameters that change the flight.</p>';
        var col = function (d) { return d.id === sel ? ' class="is-selected"' : ""; };
        return '<p class="tuning-muted">' + esc('A row with a mark has different values in two configurations of the same PID profile. The analysis can compare these configurations. "?": the value is unknown. "-": the configuration does not have this parameter.') + "</p>" +
            '<div class="tuning-table-wrap"><table class="tuning-table tuning-diff-table"><thead><tr><th>Parameter</th>' + list.map(function (d) {
                return "<th" + col(d) + ">" + esc(d.id) + '<div class="tuning-muted">' + esc(profileLabel(isNum(d.pidProfile) ? d.pidProfile : 0)) + "</div></th>";
            }).join("") + "</tr></thead><tbody>" + rows.map(function (q) {
                return '<tr class="tuning-diff-row' + (q.samePidProfile ? " is-same-profile" : "") + '"><td>' + parameterHtml(q.name) + (q.title ? '<div class="tuning-muted">' + esc(q.title) + "</div>" : "") + "</td>" +
                    list.map(function (d) { return "<td" + col(d) + ">" + diffCell(q, d.id) + "</td>"; }).join("") + "</tr>";
            }).join("") + "</tbody></table></div>";
    }

    // The values of the parameters that change in a pair of configurations, from the table: "`yaw_p_gain` 65 to 45"
    function pairNames(ds, p) {
        var rows = ds && Array.isArray(ds.diff) ? ds.diff : [];
        return (Array.isArray(p.names) ? p.names : []).map(function (name) {
            var row = rows.filter(function (q) { return q && q.name === name; })[0], va = row && row.values ? row.values[p.a] : null, vb = row && row.values ? row.values[p.b] : null;
            return parameterHtml(name) + (va !== null && va !== undefined && vb !== null && vb !== undefined ? " " + esc(num(va) + " to " + num(vb)) : "");
        }).join(", ");
    }

    // The A/B comparisons of the result (datasets.comparisons, advice.cjs comparisons): for each pair of configurations that are
    // different in a few parameters ({ a, b, names, values: { name: [a value, b value] }, text, results: [{ check, axis, a: { mean,
    // se, n }, b, delta, se, significant, unit, text }] }), the change of each result from a to b with its SE and the 2-SE test.
    // A flat item ({ id, axis, a, b, names, delta, se, significant, unit, text }) is one pair with one result. sel: the
    // configuration on display (its pairs only)
    function comparisonsHtml(ds, sel) {
        var list = (Array.isArray(ds.comparisons) ? ds.comparisons : []).filter(function (p) { return p && p.a && p.b && (!sel || p.a === sel || p.b === sel); });
        if (!list.length) return "";
        function names(p) {
            if (p.values && typeof p.values === "object" && Array.isArray(p.names)) {
                return p.names.map(function (n) { var v = p.values[n]; return parameterHtml(n) + (Array.isArray(v) && v.length === 2 ? " " + esc(num(v[0]) + " to " + num(v[1])) : ""); }).join(", ");
            }
            return pairNames(ds, p);
        }
        function ms(x, unit) { return x && typeof x === "object" && isNum(x.mean) ? valueSe(x.mean, x.se, unit) : ""; }
        return '<h5 class="tuning-h">Results of configurations that are different in some parameters</h5>' + list.map(function (p) {
            var results = Array.isArray(p.results) ? p.results.filter(function (q) { return q && typeof q === "object"; }) : isNum(p.delta) ? [p] : [];
            return '<div class="tuning-ab-pair"><div><strong>' + esc(configLabel(p.a) + " to " + configLabel(p.b)) + "</strong>: " + (names(p) || '<span class="tuning-muted">no parameter</span>') +
                (staleOf(p) ? " " + staleBadge(staleOf(p)) : "") + "</div>" + // p.stale: its results use values that are possibly not the values of the log header
                (typeof p.text === "string" && p.text && results.indexOf(p) < 0 ? '<p class="tuning-muted">' + mdCode(p.text) + "</p>" : "") +
                (results.length ? '<div class="tuning-table-wrap"><table class="tuning-table tuning-ab-table"><thead><tr><th>Check</th><th>' + esc(configLabel(p.a)) + "</th><th>" + esc(configLabel(p.b)) +
                    "</th><th>Change of the result</th><th>More than 2 SE</th></tr></thead><tbody>" + results.map(function (q) {
                        var unit = typeof q.unit === "string" ? q.unit : "";
                        return '<tr><td class="tuning-ab-check"><strong>' + esc([q.check || q.id, q.axis].filter(Boolean).join(" ")) + "</strong>" + (staleOf(q) && q !== p ? " " + staleBadge(staleOf(q)) : "") +
                            (typeof q.text === "string" && q.text ? '<div class="tuning-muted">' + mdCode(q.text) + "</div>" : "") +
                            '</td><td class="tuning-num">' + esc(ms(q.a, unit)) + '</td><td class="tuning-num">' + esc(ms(q.b, unit)) + '</td><td class="tuning-num">' + esc(valueSe(q.delta, q.se, unit)) +
                            "</td><td>" + esc(q.significant ? "Yes" : "No") + "</td></tr>";
                    }).join("") + "</tbody></table></div>" : "") + "</div>";
        }).join("");
    }

    // The configuration part of a recommendation (SPEC3 J): its configuration (the newest of its PID profile), the
    // configurations with data for it, the A/B pairs (the change of the result from configuration a to b, with its SE and the
    // 2-SE test) and the measured slope
    function recConfigHtml(rec, r) {
        var ds = datasetsOf(r), own = typeof rec.dataset === "string" && rec.dataset ? configOf(r, rec.dataset) || { id: rec.dataset } : null;
        var by = (Array.isArray(rec.supportedBy) ? rec.supportedBy : []).filter(function (x) { return typeof x === "string" && x; });
        var ab = (Array.isArray(rec.ab) ? rec.ab : []).filter(function (p) { return p && p.a && p.b; }), slope = rec.slope && typeof rec.slope === "object" && rec.slope.name ? rec.slope : null;
        if (!own && !by.length && !ab.length && !slope) return "";
        var html = '<div class="tuning-rec-config">';
        if (own) {
            var newest = ds && ds.newestByProfile && isNum(own.pidProfile) && own.pidProfile > 0 && ds.newestByProfile[own.pidProfile] === own.id;
            html += '<div><span class="tuning-label">Configuration</span> ' + esc(configLabel(own.id) + (newest ? ", the newest configuration of " + profileLabel(own.pidProfile) : "") + ".") + "</div>";
        }
        if (by.length) html += '<div><span class="tuning-label">Data from</span> ' + esc((by.length > 1 ? "Configurations " : "Configuration ") + andText(by) + ".") + "</div>";
        if (ab.length) {
            html += '<div class="tuning-table-wrap"><table class="tuning-table tuning-ab-table"><thead><tr><th>Configurations</th><th>Parameters that are not the same</th>' +
                "<th>Change of the result</th><th>More than 2 SE</th></tr></thead><tbody>" + ab.map(function (p) {
                    return "<tr><td>" + esc(p.a + " to " + p.b) + "</td><td>" + (pairNames(ds, p) || '<span class="tuning-muted">None</span>') + '</td><td class="tuning-num">' +
                        esc(valueSe(p.delta, p.se, typeof p.unit === "string" ? p.unit : "")) + "</td><td>" + esc(p.significant ? "Yes" : "No") + "</td></tr>";
                }).join("") + "</tbody></table></div>";
        }
        if (slope) {
            html += '<div class="tuning-rec-slope"><span class="tuning-label">Measured slope</span> ' + (typeof slope.text === "string" && slope.text ? mdCode(slope.text) :
                esc("For each change of 1 in ") + parameterHtml(slope.name) + esc(", the result changes by " + valueSe(slope.perUnit, slope.se) + ".")) + "</div>";
        }
        return html + "</div>";
    }

    // A list of steps to do (a K rule's first), as a numbered list
    function stepsHtml(first) {
        var list = (Array.isArray(first) ? first : first ? [first] : []).map(oneLine).filter(Boolean);
        return list.length ? '<ol class="tuning-steps">' + list.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ol>" : "";
    }

    // The hierarchy status of a step: { key (NODE_STATUS), entry (status()'s), start (its number in startHere, or 0) }
    function nodeState(hier, id) {
        var e = hier && hier.nodes && hier.nodes[id] || {}, start = hier && Array.isArray(hier.startHere) ? hier.startHere.indexOf(id) + 1 : 0;
        var key = NODE_KEYS[String(e.status || "").toLowerCase().replace(/[^a-z]/g, "")] || "notMeasured";
        if (start && (key === "problem" || key === "start")) key = "start";
        if (key === "start" && !start) key = "problem";
        return { key: key, entry: e, start: key === "start" ? start : 0 };
    }

    // The status of an item before the first flight: "problem" only for a clear measured problem, "ok" when the checks
    // found no problem, else "noData" (the log cannot show it). Never "Start here" and never "Blocked" (SPEC3 A)
    function prereqState(hier, id) {
        var e = hier && hier.nodes && hier.nodes[id] || {}, s = String(e.status || "").toLowerCase().replace(/[^a-z]/g, "");
        var key = s === "problem" ? "problem" : /^(ok|satisfactory|information|monitor|noproblemfound)$/.test(s) ? "ok" : "noData";
        return { key: key, entry: e };
    }

    // The findings of an item or a step: those that its status names (fids, problemFids) and those that the worker gave it
    // (f.node, SPEC3 K2)
    function findingsAt(r, id, entry, env) {
        var out = env.findingsOf([].concat(Array.isArray(entry.fids) ? entry.fids : [], Array.isArray(entry.problemFids) ? entry.problemFids : []));
        (r.findings || []).forEach(function (f) { if (f && f.node === id && out.indexOf(f) < 0) out.push(f); });
        return out.filter(function (f, i) { return out.indexOf(f) === i; });
    }

    function problemIds(fs) {
        var ids = [];
        fs.forEach(function (f) {
            var s = findingStatus(f), label = f.id + (f.axis ? " " + f.axis : "");
            if ((s === "problem" || s === "error") && ids.indexOf(label) < 0) ids.push(label);
        });
        return ids;
    }

    // The checks of an item or a step with their condition: one row for each check id that has a result (its worst
    // condition, the number of results), worst first, then the checks of the item or step that have no result
    function checkRows(n, fs) {
        var by = {}, rows = [], order = (Array.isArray(n.checks) ? n.checks : []).map(function (c) { return String(c).split(":")[0]; });
        fs.forEach(function (f) {
            var id = String(f.id), row = by[id];
            if (!row) rows.push(row = by[id] = { id: id, noun: "", list: [] });
            if (!row.noun && typeof f.noun === "string") row.noun = f.noun;
            row.list.push(f);
        });
        rows.forEach(function (row) { row.status = worstStatus(row.list); row.count = row.list.length; });
        rows.sort(function (a, b) {
            return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || (order.indexOf(a.id) < 0 ? 99 : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? 99 : order.indexOf(b.id)) ||
                compareIds(a.id, b.id);
        });
        var none = order.filter(function (id, i) { return order.indexOf(id) === i && !by[id]; });
        return { rows: rows, none: none };
    }

    // The checks of a step in its box: the checks to act on (analysis error, problem, monitor) one in each row, with a dot for
    // the condition, the check id, its noun and the number of results; the other checks in one row for each condition (the
    // noun of each check in its title); then the checks that have no result
    function checksHtml(got) {
        if (!got.rows.length && !got.none.length) return '<div class="tuning-muted">No check.</div>';
        var act = got.rows.filter(function (row) { return /^(error|problem|monitor)$/.test(row.status); }), rest = {};
        got.rows.forEach(function (row) { if (act.indexOf(row) < 0) (rest[row.status] = rest[row.status] || []).push(row); });
        return (act.length ? '<ul class="tuning-block-checks">' + act.map(function (row) {
            return '<li class="st-' + cls(row.status) + '" title="' + esc(STATUS[row.status] + (row.count > 1 ? ", " + plural(row.count, "result") : "")) + '"><span class="tuning-dot st-' + cls(row.status) + '"></span>' +
                '<span class="tuning-block-check">' + esc(row.id) + "</span>" + (row.noun ? " " + esc(row.noun) : "") +
                ' <span class="tuning-block-check-st">' + esc(STATUS[row.status] + (row.count > 1 ? " ×" + row.count : "")) + "</span></li>";
        }).join("") + "</ul>" : "") +
            STATUS_ORDER.filter(function (k) { return rest[k]; }).map(function (k) {
                return '<div class="tuning-block-group st-' + cls(k) + '"><span class="tuning-dot st-' + cls(k) + '"></span>' + esc(STATUS[k] + ": ") + rest[k].map(function (row) {
                    return '<span class="tuning-block-check"' + (row.noun ? ' title="' + esc(row.noun) + '"' : "") + ">" + esc(row.id) + "</span>";
                }).join(", ") + "</div>";
            }).join("") +
            (got.none.length ? '<div class="tuning-muted tuning-block-none">' + esc("No result: " + got.none.join(", ") + ".") + "</div>" : "");
    }

    // What a step waits for: the items and steps of its blockedBy (hierarchy.cjs status(), along the gate edges). An item
    // before the first flight with a problem gates a step through a gate edge; through a validity edge it makes the results
    // of the step not accurate (D1), and the step does not wait
    function waitsFor(graph, hier, n, st) {
        var out = [];
        (Array.isArray(st.entry.blockedBy) ? st.entry.blockedBy : []).forEach(function (b) { if (graph.byId[b] && out.indexOf(b) < 0) out.push(b); });
        return out;
    }

    // "All PID profiles": the condition of an item or a step in each PID profile, one chip each (0: the unknown arming profile).
    // An item before the first flight has the chips only when a PID profile has another condition (the rescue of D9)
    function profileChips(n, ctx) {
        if (!Array.isArray(ctx.profiles)) return "";
        if (n.kind === "prereq") {
            var all = prereqState(ctx.hier, n.id).key;
            if (ctx.profiles.every(function (q) { return prereqState(q.hier, n.id).key === all; })) return "";
        }
        return '<div class="tuning-block-profiles"><span class="tuning-label">PID profile</span>' + ctx.profiles.map(function (q) {
            var key = n.kind === "prereq" ? PREREQ_CLASS[prereqState(q.hier, n.id).key] : nodeState(q.hier, n.id).key,
                word = n.kind === "prereq" ? PREREQ_STATUS[prereqState(q.hier, n.id).key] : NODE_STATUS[key];
            return '<span class="tuning-pchip st-' + cls(key) + '" data-profile="' + esc(q.p) + '" title="' + esc(profileLabel(q.p) + ": " + word) + '">' + (q.p > 0 ? q.p : "?") + "</span>";
        }).join("") + "</div>";
    }

    // One step of the flow: its number, title and condition, what it waits for, its parameter labels and its
    // checks with their conditions. The box is a button: a click shows the step in the side panel. It has no link of its own
    function blockHtml(n, ctx) {
        var st = nodeState(ctx.hier, n.id), fs = findingsAt(ctx.r, n.id, st.entry, ctx.env).filter(function (f) { return inView(f, ctx.view); });
        var ids = /^(start|problem|blocked|possible|error)$/.test(st.key) ? problemIds(fs) : [], waits = waitsFor(ctx.graph, ctx.hier, n, st), params = paramsOf(n);
        var more = params.length - PARAMS_SHOWN, word = NODE_STATUS[st.key] + (st.start ? " " + st.start : "");
        return '<div class="tuning-node tuning-block st-' + cls(st.key) + (ctx.selected === n.id ? " is-selected" : "") + '" data-node="' + esc(n.id) + '" tabindex="0" role="button" aria-label="' +
                esc("Step " + stepNo(n) + ", " + n.title + ": " + word) + '">' +
            '<div class="tuning-block-head"><span class="tuning-block-no">' + esc(stepNo(n)) + '</span><span class="tuning-block-title">' + esc(n.title || n.id) + "</span>" +
                (st.start ? '<span class="tuning-start-badge" title="Start here">' + st.start + "</span>" : "") + "</div>" +
            '<div class="tuning-block-status">' + badge(word, st.key) + (ids.length ? ' <span class="tuning-block-ids">' + esc(ids.slice(0, 6).join(", ") + (ids.length > 6 ? " +" + (ids.length - 6) : "")) + "</span>" : "") + "</div>" +
            (waits.length ? '<div class="tuning-block-wait">' + esc("Correct first: " + waits.map(function (id) { return ctx.graph.byId[id].title; }).join(", ") + ".") + "</div>" : "") +
            (params.length ? '<div class="tuning-block-sect"><div class="tuning-label">Parameters</div><div class="tuning-block-params">' +
                params.slice(0, PARAMS_SHOWN).map(parameterHtml).join(" ") +
                (more > 0 ? ' <span class="tuning-muted tuning-block-more">' + esc(plural(more, "more parameter")) + "</span>" : "") + "</div></div>" : "") +
            '<div class="tuning-block-sect"><div class="tuning-label">Checks</div>' + checksHtml(checkRows(n, fs)) + "</div>" +
            profileChips(n, ctx) +
        "</div>";
    }

    // The flow of the tuning steps: a grid with a column for each order and an arrow column between two columns. A column
    // of the main lane takes the two rows; the cyclic lane is the first row and the tail lane the second
    function flowHtml(ctx) {
        var cols = ctx.graph.columns, items = [], tracks = [];
        function cell(col, row, list) {
            if (!list.length) return;
            items.push('<div class="tuning-flow-cell" style="grid-column: ' + col + "; grid-row: " + row + '">' + list.map(function (b) { return blockHtml(b, ctx); }).join("") + "</div>");
        }
        function arrow(col, row) {
            items.push('<div class="tuning-flow-arrow" style="grid-column: ' + col + "; grid-row: " + row + '" aria-hidden="true"></div>');
        }
        cols.forEach(function (c, k) {
            var col = 2 * k + 1;
            if (k) {
                tracks.push("calc(26 * var(--rf-px))");
                if (!hasLanes(c) && !hasLanes(cols[k - 1])) arrow(col - 1, "1 / span 2");
                else { arrow(col - 1, "1"); arrow(col - 1, "2"); }
            }
            tracks.push("minmax(calc(200 * var(--rf-px)), 1fr)");
            if (!hasLanes(c)) cell(col, "1 / span 2", c.main);
            else {
                cell(col, "1", c.main.concat(c.cyclic));
                cell(col, "2", c.tail);
            }
        });
        return '<div class="tuning-flow" role="group" aria-label="Tuning steps" style="grid-template-columns: ' + tracks.join(" ") + '">' + items.join("") + "</div>";
    }

    // The checklist before the first flight (SPEC3 A): for each item its condition, the checks that operated, and for a problem
    // the checks with the problem and the steps that must wait for it. Each item is a button for the side panel
    function prereqHtml(ctx) {
        var graph = ctx.graph;
        if (!graph.prereq.length) return "";
        return '<section class="tuning-prereq" aria-label="Before the first flight"><div class="tuning-prereq-head"><h5 class="tuning-h">Before the first flight</h5>' +
            '<p class="tuning-muted">' + esc(PREREQ_NOTE) + "</p></div>" +
            '<ul class="tuning-prereq-list">' + graph.prereq.map(function (p) {
                var st = prereqState(ctx.hier, p.id), fs = findingsAt(ctx.r, p.id, st.entry, ctx.env).filter(function (f) { return inView(f, ctx.view); });
                var got = checkRows(p, fs), ran = Array.isArray(st.entry.checksRun) ? st.entry.checksRun.map(String) :
                    got.rows.filter(function (q) { return q.status !== "notMeasured" && q.status !== "error"; }).map(function (q) { return q.id; });
                // the checks with the problem: those of problemFids (hierarchy.cjs: D2 and D4 never count), else the checks whose condition is
                // "Problem"; none when the item has no problem
                var pf = Array.isArray(st.entry.problemFids) ? st.entry.problemFids : null, bad = st.key !== "problem" ? [] : pf ?
                    checkRows(p, fs.filter(function (f) { return pf.indexOf(f.fid) >= 0; })).rows : got.rows.filter(function (q) { return q.status === "problem"; });
                var gates = (Array.isArray(p.gates) ? p.gates : []).filter(function (id) { return graph.byId[id]; });
                var checks = st.key === "noData" ? (oneLine(st.entry.reason) || "The log cannot show this item.") :
                    ran.length ? "Checks that operated: " + ran.join(", ") + "." : "";
                return '<li class="tuning-node tuning-prereq-item st-' + PREREQ_CLASS[st.key] + (ctx.selected === p.id ? " is-selected" : "") + '" data-node="' + esc(p.id) +
                        '" tabindex="0" role="button" aria-label="' + esc(p.title + ": " + PREREQ_STATUS[st.key]) + '">' +
                    '<div class="tuning-prereq-top">' + badge(PREREQ_STATUS[st.key], PREREQ_CLASS[st.key]) + ' <span class="tuning-prereq-title">' + esc(p.title || p.id) + "</span></div>" +
                    (bad.length ? '<ul class="tuning-prereq-problems">' + bad.map(function (q) {
                        return '<li><span class="tuning-block-check">' + esc(q.id) + "</span>" + (q.noun ? " " + esc(q.noun) : "") + (q.count > 1 ? " " + esc("×" + q.count) : "") + "</li>";
                    }).join("") + "</ul>" : "") +
                    (checks ? '<div class="tuning-muted tuning-prereq-checks">' + esc(checks) + "</div>" : "") +
                    (st.key === "problem" && gates.length ? '<div class="tuning-prereq-gates">' + esc("This item is necessary for these steps: " + gates.map(function (id) { return graph.byId[id].title; }).join(", ") + ".") + "</div>" : "") +
                    profileChips(p, ctx) +
                "</li>";
            }).join("") + "</ul></section>";
    }

    // The legend: the conditions on the diagram, "Start here", the PID profile chips and the arrows
    function orderLegend(graph, hier, profileChipsOn) {
        var seen = {}, pre = {};
        graph.blocks.forEach(function (n) { seen[nodeState(hier, n.id).key] = true; });
        graph.prereq.forEach(function (n) { pre[prereqState(hier, n.id).key] = true; });
        var items = Object.keys(NODE_STATUS).filter(function (k) { return seen[k]; }).map(function (k) {
            return '<div class="tuning-legend-item"><span class="tuning-swatch st-' + cls(k) + '"></span>' + esc(NODE_STATUS[k]) + "</div>";
        });
        if (seen.start) items.push('<div class="tuning-legend-item"><span class="tuning-start-badge is-legend">1</span>The sequence of the steps to correct</div>');
        if (profileChipsOn) items.push('<div class="tuning-legend-item"><span class="tuning-pchip">1</span>The condition in each PID profile</div>');
        items.push('<div class="tuning-legend-item"><span class="tuning-legend-arrow"></span>Tune the step on the left first</div>');
        return '<div class="tuning-order-legend">' + items.join("") + "</div>";
    }

    // A recommendation in the side panel: its badges, title, change, rule and CLI text, and a link to its card (the
    // recommendation of a result that the Analysis view opened is first, with the class is-focus)
    function recBrief(x, focus, env, graph) {
        var rec = x.rec;
        return '<li class="tuning-node-rec' + (focus ? " is-focus" : "") + '" id="' + env.recId(x.i) + '-panel">' +
            '<div class="tuning-rec-badges">' + recBadges(rec) + '</div> <a href="#" class="tuning-goto-rec" data-rec="' + x.i + '">' + esc(recommendationTitle(rec)) + "</a>" +
            ' <div class="tuning-inline tuning-muted">' + (rec.parameter ? parameterHtml(rec.parameter) + " " + esc(paramText(rec)) : esc(profileText(rec))) +
                esc(typeof rec.dataset === "string" && rec.dataset ? ", " + configLabel(rec.dataset) : "") + "</div>" +
            (isBlocked(rec) ? '<div class="tuning-node-rec-blocked">Blocked: ' + rec.blockedBy.map(function (b) { return blockedItem(b, graph); }).join(", ") + "</div>" : "") +
            (focus && ruleText(rec) ? '<div class="tuning-rec-rule"><div class="tuning-label">Rule</div><div>' + esc(ruleText(rec)) + "</div></div>" : "") +
            (focus ? (hasCli(rec) ? cliBlock(rec.cli.join("\n"), env) : '<div class="tuning-muted tuning-cli-none">' + esc(noCliText(rec)) + "</div>") : "") +
        "</li>";
    }

    // The side panel of one item or step: its condition, what it waits for, "Possible result of", "Do first", its checks,
    // its recommendations, its Rotorflight pages and all its parameters. hier: the status of the PID profile on display. v: {
    // profile ("all" or its number), dataset ("all" or the id of a configuration) }. focus: { recs: [recommendation ids] } of a
    // result that the Analysis view opened. The Filters step also has the filter calculation (env.filterSearch, SPEC3 G)
    function nodePanel(entry, graph, hier, id, v, env, focus, where) {
        var r = entry.result, n = graph.byId[id];
        if (!n) return '<p class="tuning-muted">' + esc(PANEL_HINT) + "</p>";
        var pre = n.kind === "prereq", st = pre ? prereqState(hier, id) : nodeState(hier, id), e = st.entry;
        var fs = findingsAt(r, id, e, env).filter(function (f) { return inView(f, v); });
        var html = '<div class="tuning-node-head"><div class="tuning-muted">' + esc(pre ? "Before the first flight" : "Step " + stepNo(n)) + "</div>" +
            '<h5 class="tuning-node-title-text">' + esc(n.title || n.id) + "</h5>" +
            (pre ? badge(PREREQ_STATUS[st.key], PREREQ_CLASS[st.key]) : badge(NODE_STATUS[st.key] + (st.start ? " " + st.start : ""), st.key)) + "</div>";
        if (n.about) html += '<p class="tuning-node-about">' + esc(oneLine(n.about)) + "</p>";
        if (e.reason) html += '<p class="tuning-node-reason">' + esc(e.reason) + "</p>";
        if (n.optional) html += '<p class="tuning-muted">' + esc(n.optional) + "</p>";
        if (pre) {
            var gates = (Array.isArray(n.gates) ? n.gates : []).filter(function (g) { return graph.byId[g]; });
            if (gates.length) {
                html += '<div class="tuning-panel-block' + (st.key === "problem" ? " is-blocked" : "") + '"><div class="tuning-label">This item is necessary for these steps</div><div>' + gates.map(function (g) {
                        return '<a href="#" class="tuning-node-link" data-node="' + esc(g) + '">' + esc(graph.byId[g].title) + "</a>";
                    }).join(", ") + "</div></div>";
            }
        } else {
            var waits = waitsFor(graph, hier, n, st);
            if (waits.length) {
                html += '<div class="tuning-panel-block is-blocked"><div class="tuning-label">Correct first</div><div>' + waits.map(function (b) {
                    return '<a href="#" class="tuning-node-link" data-node="' + esc(b) + '">' + esc(graph.byId[b].title) + "</a>";
                }).join(", ") + "</div></div>";
            }
            var possible = (Array.isArray(e.possible) ? e.possible : []).filter(function (p) { return p && typeof p === "object"; });
            if (possible.length) {
                html += '<div class="tuning-panel-block is-possible"><div class="tuning-label">Possible result of</div><ul>' + possible.map(function (p) {
                    var rule = graph.ruleById[p.rule] || {}, up = env.findingsOf(p.fids), from = (Array.isArray(p.from) ? p.from : []).filter(function (x) { return graph.byId[x]; });
                    var head = p.rule === "cause" || !p.rule ? from.map(function (x) {
                        return '<a href="#" class="tuning-node-link" data-node="' + esc(x) + '">' + esc(graph.byId[x].title) + "</a>";
                    }).join(", ") : "<strong>" + esc([p.rule, p.name || rule.name].filter(Boolean).join(" ")) + "</strong>";
                    return "<li>" + (head || esc(oneLine(p.rule))) + (up.length ? ": " + esc(upstreamText(up, true)) : "") +
                        (rule.first ? '<div class="tuning-muted">Do first:</div>' + stepsHtml(rule.first) : "") + "</li>";
                }).join("") + "</ul></div>";
            }
            var before = graph.edges.filter(function (x) { return x.to === id && (x.kind === "gate" || x.kind === "order"); });
            if (before.length) {
                html += '<div class="tuning-panel-block"><div class="tuning-label">Do first</div><ul>' + before.map(function (x) {
                    var up = graph.byId[x.from], ust = up.kind === "prereq" ? null : nodeState(hier, x.from);
                    var word = ust ? badge(NODE_STATUS[ust.key] + (ust.start ? " " + ust.start : ""), ust.key) :
                        badge(PREREQ_STATUS[prereqState(hier, x.from).key], PREREQ_CLASS[prereqState(hier, x.from).key]);
                    return '<li><a href="#" class="tuning-node-link" data-node="' + esc(x.from) + '">' + esc(up.title) + "</a> " + word +
                        (edgeText(x) ? ' <span class="tuning-muted">' + esc(edgeText(x)) + "</span>" : "") + "</li>";
                }).join("") + "</ul></div>";
            }
        }
        if (id === "filters" && env.filterSearch) html += env.filterSearch("panel");
        var want = focus && Array.isArray(focus.recs) ? focus.recs : [];
        var recs = recsOf(r).map(function (x, i) { return { rec: x, i: i }; }).filter(function (x) {
            return (x.rec.node === id || (Array.isArray(e.recs) && e.recs.indexOf(x.rec.id) >= 0) || want.indexOf(x.rec.id) >= 0) && inView(x.rec, v);
        }).sort(function (a, b) { return (want.indexOf(b.rec.id) >= 0) - (want.indexOf(a.rec.id) >= 0); });
        if (recs.length) {
            html += '<h5 class="tuning-h">Recommendations</h5><ul class="tuning-node-recs">' + recs.map(function (x) { return recBrief(x, want.indexOf(x.rec.id) >= 0, env, graph); }).join("") + "</ul>";
        }
        var shownFs = filterResults(fs.slice().sort(SORTS.severity), env.filter ? env.filter() : null);
        html += '<h5 class="tuning-h">Checks</h5>' + filterBar(env.filter ? env.filter() : {}, shownFs, false) +
            (shownFs.list.length || !fs.length ? findingsList(shownFs.list, where || "overview", env) : "");
        var none = checkRows(n, fs).none;
        if (none.length) html += '<p class="tuning-muted">' + esc("These checks have no result: " + none.join(", ") + ".") + "</p>";
        var docs = (Array.isArray(n.docs) ? n.docs : []).filter(function (d) { return d && /^https:\/\//.test(String(d.url)); });
        if (docs.length) {
            html += '<div class="tuning-panel-block"><div class="tuning-label">Rotorflight page</div><ul class="tuning-docs">' + docs.map(function (d) {
                return '<li><a href="' + esc(d.url) + '" target="_blank" rel="noopener noreferrer" data-ste="quoted">' + esc(d.title || d.url) + "</a></li>"; // the title of that page
            }).join("") + "</ul></div>";
        }
        var params = paramsOf(n);
        if (params.length) html += '<div class="tuning-panel-block tuning-node-params"><div class="tuning-label">Parameters</div>' + params.map(parameterHtml).join(" ") + "</div>";
        return html;
    }

    // The items before the first flight with a problem: hierarchy.prereqProblems, else the items with the status "problem"
    function prereqProblems(graph, hier) {
        var given = hier && Array.isArray(hier.prereqProblems) ? hier.prereqProblems.filter(function (id) { return graph.byId[id] && graph.byId[id].kind === "prereq"; }) : null;
        return given || graph.prereq.filter(function (p) { return prereqState(hier, p.id).key === "problem"; }).map(function (p) { return p.id; });
    }

    // The diagram of the PID profile on display: its status (hierarchy.byProfile), or with "All PID profiles" the status of
    // all of them and a chip for each PID profile on each item and step
    function orderSection(entry, graph, hier, view, env) {
        var r = entry.result, sel = view.profile, by = byProfileOf(r), ds = view.dataset && view.dataset !== "all" ? view.dataset : null;
        var selected = graph.byId[view.node] ? view.node : (hier.startHere || []).filter(function (id) { return graph.byId[id]; })[0] || prereqProblems(graph, hier)[0] || null;
        var profiles = sel === "all" && !ds && by ? profileList(r).filter(function (p) { return by[p]; }).map(function (p) { return { p: p, hier: by[p] }; }) : [];
        if (profiles.length < 2) profiles = null;
        var ctx = { r: r, graph: graph, hier: hier, sel: sel, view: { profile: sel, dataset: ds || "all" }, env: env, selected: selected, profiles: profiles };
        var open = view.compare && view.compare.where === "overview" ? env.findingOf(view.compare.key) : null;
        var note = ds ? configNote(r, hier, ds) : sel === "all" ? "" : hier === r.hierarchy ? "The diagram shows the results of all PID profiles together. The lists show " + profileLabel(sel) + " and the items for all PID profiles." :
            "The diagram and the lists show " + profileLabel(sel) + " and the items for all PID profiles.";
        return prereqHtml(ctx) +
            '<h5 class="tuning-h">Tuning steps</h5><p class="tuning-muted">' + esc(PANEL_HINT + (note ? " " + note : "")) + "</p>" +
            '<div class="tuning-order"><div class="tuning-order-main">' + orderLegend(graph, hier, !!profiles) + '<div class="tuning-order-scroll">' + flowHtml(ctx) + "</div></div>" +
            '<aside class="tuning-order-panel" id="' + esc(env.uid) + '-panel">' + (selected ? nodePanel(entry, graph, hier, selected, ctx.view, env, view.focus && view.focus.node === selected ? view.focus : null) :
                '<p class="tuning-muted">' + esc(PANEL_HINT) + "</p>") + "</aside></div>" +
            (open ? '<div class="tuning-order-compare">' + env.compareHtml(open, "overview") + "</div>" : "");
    }

    // ---------------------------------------------------------------------------------------------
    // Tabs: each returns { html, plots: [{ id, spec }] }

    function renderOverview(entry, view, env) {
        var r = entry.result, sel = view.profile, graph = graphOf(r), all = recsOf(r), ds = view.dataset && view.dataset !== "all" && configOf(r, view.dataset) ? view.dataset : null;
        var fs = (r.findings || []).filter(function (f) { return inView(f, view); }), recs = all.filter(function (x) { return inView(x, view); });
        var changes = recs.filter(function (x) { return x.severity === "action"; }), held = changes.filter(function (x) { return isBlocked(x) || causesOf(x).length; }).length;
        var html = '<p class="tuning-workflow-intro">Follow the tuning steps from left to right. Each step adds selected changes to one configuration. Examine all selected changes in Export.</p>' +
            '<div class="tuning-review-links">' + TABS.filter(function (t) { return t.auxiliary && t.key !== "configs"; }).map(function (t) { return '<a href="#" class="tuning-tab-link" data-tab="' + t.key + '">' + esc(t.title) + '</a>'; }).join(' · ') + '</div>' + selectBars(entry, view, env) +
            '<div class="tuning-summary"><div>' + esc(entry.label + (sel === "all" ? "" : ", " + profileLabel(sel)) + (ds ? ", " + configLabel(ds) : "") + ": " + plural(fs.length, "result") + ", " + plural(recs.length, "recommendation") + ".") +
            (changes.length ? " " + esc(plural(changes.length - held, "change") + " to do" + (held ? ", " + plural(held, "change") + " that must wait" : "") + ".") : "") + "</div>" +
            // the CLI dump only when the pilot loaded one: the log is the only necessary input (user rule 2026-10-06)
            '<div class="tuning-muted">' + [r.flightRpm ? esc("Flight rpm " + rpmText(r.flightRpm)) : "", r.timing && isNum(r.timing.totalS) ? esc("Analysis time " + secs(r.timing.totalS)) : "",
                entry.cliName ? esc("CLI dump ") + quoted(esc(entry.cliName)) : ""].filter(Boolean).join(" · ") + "</div>" +
            (fs.length ? '<div class="tuning-muted">' + esc(statusCounts(fs)) + "</div>" : "") + freshLine(fs) +
            (!adviceRan(r) ? '<div class="tuning-muted">The recommendations are not available: ' + quoted(esc(whyNoAdvice(r))) + ".</div>" : "") + "</div>";

        var errors = fs.filter(function (f) { return f.severity === "error"; });
        if (errors.length) {
            html += notice("error", "<strong>" + esc("Analysis error in " + plural(errors.length, "check") + ".") + "</strong> " +
                quoted(errors.slice(0, 4).map(function (f) { return esc(f.id + ": " + oneLine(f.text)); }).join(". ") + (errors.length > 4 ? " &hellip;" : "")));
        }

        var hier = graph ? hierFor(r, sel, ds) : null;
        html += graph ? orderSection(entry, graph, hier, view, env) : '<p class="tuning-muted">This result has no data for the tuning sequence.</p>';

        var notes = notesOf(r);
        if (notes.length) html += '<h5 class="tuning-h">Notes</h5><ul class="tuning-notes">' + notes.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") + "</ul>";
        return { html: html, plots: [] };
    }

    function disclaimerHtml() {
        return '<div class="tuning-disclaimer"><p><strong>WARNING:</strong> ' + esc(WARNING) + "</p><p><strong>NOTE:</strong> " + esc(NO_SEND) + "</p></div>";
    }

    function renderRecs(entry, view, env) {
        var r = entry.result;
        if (!adviceRan(r)) return { html: '<p class="tuning-na-text">The recommendations are not available: ' + quoted(esc(whyNoAdvice(r))) + ".</p>", plots: [] };
        var mine = recsOf(r).map(function (rec, i) { return { rec: rec, i: i }; }).filter(function (x) { return inView(x.rec, view); }),
            recs = mine.map(function (x) { return x.rec; }), c = countBy(recs, "severity");
        var kinds = [["action", "change"], ["check", "check"], ["watch", "item to monitor"], ["info", "item for information"]].filter(function (k) { return c[k[0]]; })
            .map(function (k) { return k[1] === "item to monitor" ? c[k[0]] + (c[k[0]] === 1 ? " item to monitor" : " items to monitor") :
                k[1] === "item for information" ? c[k[0]] + (c[k[0]] === 1 ? " item for information" : " items for information") : plural(c[k[0]], k[1]); });
        var html = selectBars(entry, view, env) + disclaimerHtml() +
            '<p class="tuning-muted">' + esc(recs.length ? plural(recs.length, "recommendation") + " in the tuning sequence" + (view.profile === "all" ? "" : " for " + profileLabel(view.profile)) +
                (view.dataset && view.dataset !== "all" ? " for " + configLabel(view.dataset) : "") + ": " + kinds.join(", ") + "." : "No recommendation.") +
            (recs.some(hasCli) ? " After you paste a CLI block, type <code>save</code>. " + esc('To make one CLI file of the changes that you select, use the "Export" tab.') :
                recs.length ? esc(" No recommendation has CLI text.") : "") + "</p>" +
            mine.map(function (x) { return recCard(x.rec, x.i, entry, env); }).join("");
        if (Array.isArray(r.decisions) && r.decisions.length) {
            html += '<h5 class="tuning-h">Gain analysis</h5><div class="tuning-table-wrap"><table class="tuning-table"><thead><tr>' +
                "<th>Axis</th><th>Headspeed</th><th>Flights</th><th>Windows</th><th>Result</th></tr></thead><tbody>" +
                r.decisions.map(function (d) {
                    var o = decisionOutcome(d);
                    return "<tr><td>" + esc(d.axis) + '</td><td class="tuning-num">' + esc(num(d.bin)) + ' rpm</td><td class="tuning-num">' + esc(num(d.flights)) +
                        '</td><td class="tuning-num">' + esc(num(d.windows)) + '</td><td class="tuning-text">' + esc(o.text) + (o.quoted ? " " + quoted(esc(o.quoted)) : "") +
                        (staleOf(d) ? "<div>" + staleBadge(staleOf(d)) + "</div>" : "") + "</td></tr>"; // d.stale: its flights use values that are possibly not the values of the log header
                }).join("") + "</tbody></table></div>";
        }
        return { html: html, plots: [] };
    }

    // ---------------------------------------------------------------------------------------------
    // "Export" (SPEC2 D11): the pilot selects recommendations, advice.cjs exportScript writes the Rotorflight CLI script
    // (in the derive worker), and the view shows it, copies it or saves it. Nothing goes to a flight controller

    var EXPORT_WARNING = ["Before you paste these commands, save the output of ", " in a file.",
        "If a change is incorrect, you can then set the previous values again. After each change, do a hover test in a safe area. " +
        "Incorrect gains or filters can cause oscillations that you cannot control."];
    var EXPORT_NOTE = "This app does not send data to the flight controller. You paste the commands in the CLI tab of the Rotorflight Configurator.";

    // A recommendation goes in the CLI file only with CLI text: a change with CLI text is selected first; a check, an item to
    // monitor and an item for information have none
    function pickDefault(rec) {
        return rec.severity === "action" && hasCli(rec);
    }

    // The group of a recommendation (advice.cjs group, "C7:<axis>:<bin>": the gains that report.cjs changes together), or null
    function groupOf(rec) {
        return rec && typeof rec.group === "string" && rec.group ? rec.group : null;
    }

    // "C7, pitch, 4250 rpm" for "C7:pitch:4250"; another group id as it is
    function groupLabel(g) {
        if (String(g) === "FT:filters" || String(g) === "F:filters") return "of the calculated filter values";
        var m = /^(C7):(roll|pitch|yaw):(\d+(?:\.\d+)?)$/.exec(String(g));
        return m ? m[1] + ", " + m[2] + ", " + m[3] + " rpm" : String(g);
    }

    // The recommendations that the pilot selects with recs[i], by their index: its group, else itself
    function membersOf(recs, i) {
        var g = groupOf(recs[i]), out = [];
        if (!g) return [i];
        recs.forEach(function (rec, k) { if (groupOf(rec) === g) out.push(k); });
        return out;
    }

    // The number of changes of the group of recs[i]: advice.cjs groupSize (the gains that the model changes together), at
    // least the members in the list
    function groupSize(recs, i) {
        var n = membersOf(recs, i).length;
        return groupOf(recs[i]) && isNum(recs[i].groupSize) && recs[i].groupSize > n ? recs[i].groupSize : n;
    }

    // recs[i] can go into the CLI file: it has CLI text, and so has each change of its group (a group goes in as one, and
    // all its changes are in the list)
    function canPick(recs, i) {
        var list = membersOf(recs, i);
        return list.length >= groupSize(recs, i) && list.every(function (k) { return hasCli(recs[k]); });
    }

    // The groups that the selection has only a part of: [group]
    function partGroups(recs, picks) {
        var out = [];
        recs.forEach(function (rec, i) {
            var g = groupOf(rec);
            if (!g || out.indexOf(g) >= 0 || !picks[i]) return;
            if (!canPick(recs, i) || !membersOf(recs, i).every(function (k) { return picks[k]; })) out.push(g);
        });
        return out;
    }

    // The group of a recommendation in words, for the export panel and the cards
    function groupText(recs, i) {
        var g = groupOf(recs[i]), n = groupSize(recs, i);
        if (!g) return "";
        return ["Group " + groupLabel(g) + ": " + plural(n, "change") + ".", n > 1 ? "The app selects all of them, or none of them." : "",
            canPick(recs, i) ? "" : (membersOf(recs, i).length < n ? "The list does not have all the changes of this group." : "A change of this group has no CLI text.") +
                " Thus, the CLI file cannot contain this group."].filter(Boolean).join(" ");
    }

    function pendingPlan(recs, picks) {
        var rows = new Map(), selected = [];
        recs.forEach(function (rec, i) {
            if (!picks[i] || !canPick(recs,i)) return;
            selected.push(rec.id);
            var scope = rec.scope || 'global', index = scope === 'profile' ? (isNum(rec.cliProfile) ? rec.cliProfile : rec.profile-1) : scope === 'rateprofile' ? (isNum(rec.cliRateProfile) ? rec.cliRateProfile : rec.rateProfile-1) : null;
            (rec.cli || []).forEach(function (line) {
                var sel = /^(profile|rateprofile) (\d+)$/.exec(line.trim());
                if (sel) { scope = sel[1]; index = +sel[2]; return; }
                var set = /^set ([a-z0-9_]+) = (.+)$/.exec(line.trim()), feature = /^feature (-?)([A-Z_]+)$/.exec(line.trim());
                if (!set && !feature) return;
                var name = set ? set[1] : 'feature ' + feature[2], to = set ? set[2].trim() : !feature[1], sc = feature ? 'global' : scope,
                    ix = sc === 'global' ? null : index, key = [sc,ix,name].join(':'), from = rec.fromSets && rec.fromSets[name] !== undefined ? rec.fromSets[name] : rec.parameter === name ? rec.from : null;
                var row = rows.get(key);
                if (!row) { row = {key:key,name:name,scope:sc,index:ix,from:from,to:to,values:[],steps:[],recommendations:[],configurations:[],filterSources:[],stale:[]}; rows.set(key,row); }
                if (row.values.map(String).indexOf(String(to)) < 0) row.values.push(to);
                var step = rec.node || (rec.filterSearch ? 'filters' : rec.area || '');
                if (row.steps.indexOf(step) < 0) row.steps.push(step);
                row.recommendations.push(rec.id);
                if (rec.dataset && row.configurations.indexOf(rec.dataset)<0) row.configurations.push(rec.dataset);
                if (rec.filterSource && row.filterSources.indexOf(rec.filterSource)<0) row.filterSources.push(rec.filterSource);
                if (rec.stale && row.stale.indexOf(rec.stale.text) < 0) row.stale.push(rec.stale.text);
                row.conflict = row.values.length > 1;
            });
        });
        var list = Array.from(rows.values());
        return {rows:list,selected:selected,conflicts:list.filter(function(q){return q.conflict;}),signature:JSON.stringify(list)};
    }

    function pendingDiffHtml(plan) {
        var changed=plan.rows.filter(function(q){return q.conflict || q.from==null || String(q.from)!==String(q.to);});
        var retained=plan.rows.filter(function(q){return changed.indexOf(q)<0;});
        function table(rows) {
            return '<div class="tuning-table-wrap"><table class="tuning-table"><thead><tr><th>Parameter</th><th>Scope</th><th>Before</th><th>After</th><th>Tuning step</th><th>Source</th></tr></thead><tbody>' + rows.map(function(q){
                return '<tr class="' + (q.conflict ? 'tuning-ft-regression' : changed.indexOf(q)>=0 ? 'tuning-ft-changed' : '') + '"><td><code>' + esc(q.name) + '</code></td><td>' + esc(q.scope === 'global' ? 'All PID profiles' : q.scope === 'profile' ? profileLabel(q.index + 1) : 'Rate profile ' + (q.index + 1)) + '</td><td><code>' + esc(q.from == null ? 'Unknown' : String(q.from)) + '</code></td><td><code>' + esc(q.values.map(String).join(' / ')) + '</code>' + (q.conflict ? ' Different values' : '') + '</td><td>' + esc(q.steps.map(function(k){var t=TABS.find(function(t){return t.key===k;});return t?t.title:k;}).join(', ')) + q.stale.map(function(t){return '<p class="tuning-muted">' + esc(t) + '</p>';}).join('') + '</td><td>' + esc(q.configurations.map(configLabel).concat(q.filterSources || []).join(', ')) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
        }
        return '<section class="tuning-pending-diff"><h5 class="tuning-h">Selected parameter changes</h5><p>These values come from all tuning steps. The CLI file uses this same selection.</p>' +
            (plan.conflicts.length ? '<p class="tuning-na">Two selected changes give different values for the same parameter. Select one before export.</p>' : '') + table(changed) +
            (retained.length ? '<details><summary>Values that do not change in the CLI file (' + retained.length + ')</summary>' + table(retained) + '</details>' : '') + '</section>';
    }

    function stepPicksHtml(entry, key, env) {
        var recs = env.exportRecs ? env.exportRecs(entry) : recsOf(entry.result), picks = env.picks(entry);
        var mine = recs.map(function(r,i){return {rec:r,index:i};}).filter(function(x){return (x.rec.node || (x.rec.filterSearch ? 'filters' : x.rec.area)) === key;});
        return '<section class="tuning-step-picks"><h5 class="tuning-h">Changes for export</h5><p>Select the changes for the CLI file.</p>' +
            (mine.length ? mine.map(function(x){var can=canPick(recs,x.index);return '<label class="tuning-step-pick"><input type="checkbox" class="tuning-pick" data-pick="' + x.index + '"' + (can && picks[x.index] ? ' checked' : '') + (can ? '' : ' disabled') + '> ' + esc(recommendationTitle(x.rec)) + '</label>' + (can ? '' : '<p class="tuning-muted">' + esc(noCliText(x.rec)) + '</p>');}).join('') : '<p class="tuning-muted">No parameter change is available from this step.</p>') +
            '<a href="#" class="tuning-tab-link" data-tab="export">Examine all selected changes</a></section>';
    }

    // The CLI file of the selected recommendations: the script, or why it is not available
    function exportPreview(entry, env) {
        var m = env.exportOf(entry), ready = m.state === "ready" && !!m.text, body;
        if (m.state === "none") body = '<p class="tuning-muted">You did not select a recommendation. Select one or more changes.</p>';
        else if (m.state === "loading") body = '<p class="tuning-muted">Wait while the app makes the commands.</p>';
        else if (m.state === "na" && m.say) body = '<p class="tuning-na">The CLI file is not available. ' + esc(m.say) + "</p>"; // our own sentences
        else if (m.state === "na") body = '<p class="tuning-na">The CLI file is not available: ' + quoted(esc(m.why)) + "</p>";
        else body = '<pre class="tuning-export-text">' + esc(m.text) + "</pre>"; // the changes that it cannot write are comment lines of it
        return (ready ? flightPlanHtml(m.flightPlan) : '') + '<div class="tuning-export-actions">' +
            '<button type="button" class="btn btn-primary btn-sm tuning-export-copy" data-label="Copy commands"' + (ready ? "" : " disabled") + ">Copy commands</button>" +
            '<button type="button" class="btn btn-default btn-sm tuning-export-save" title="Save the commands as a text file"' + (ready ? "" : " disabled") + ">Save CLI file</button></div>" + body;
    }

    // The recommendations of the CLI file: those of the result, then the changes of the filter calculation of this file (SPEC3
    // G, env.exportRecs). The index of a recommendation of the result does not change when a calculation ends
    function renderExport(entry, view, env) {
        var r = entry.result, recs = env.exportRecs ? env.exportRecs(entry) : recsOf(r);
        if (!adviceRan(r) && recs.length === recsOf(r).length) return { html: '<p class="tuning-na-text">The recommendations are not available: ' + quoted(esc(whyNoAdvice(r))) + ".</p>", plots: [] };
        var picks = env.picks(entry), n = recs.filter(function (rec, i) { return picks[i] && canPick(recs, i); }).length;
        var html = '<div class="tuning-disclaimer"><p><strong>WARNING:</strong> ' + esc(EXPORT_WARNING[0]) + "<code>diff all</code>" + esc(EXPORT_WARNING[1]) + " " + esc(EXPORT_WARNING[2]) + "</p>" +
            "<p><strong>NOTE:</strong> " + esc(EXPORT_NOTE) + "</p></div>" +
            (env.finalProfiles ? env.finalProfiles(entry) : '') + pendingDiffHtml(env.pending ? env.pending(entry) : pendingPlan(recs,picks)) + '<div class="tuning-export"><div class="tuning-export-picks"><h5 class="tuning-h">Recommendations</h5>' +
            '<p class="tuning-muted">' + esc("Select the recommendations for the CLI file. The app selects each change that has CLI text first. " +
                "A check, an item to monitor and an item for information have no CLI text. " + plural(n, "recommendation") + " of " + recs.length + " selected.") + "</p>" +
            (recs.length ? '<ul class="tuning-pick-list">' + recs.map(function (rec, i) {
                var can = canPick(recs, i), g = groupOf(rec);
                return '<li class="tuning-pick-row' + (can ? "" : " is-off") + (g ? " is-group" : "") + '"' + (g ? ' data-group="' + esc(g) + '"' : "") +
                    '><label class="tuning-pick-label"><input type="checkbox" class="tuning-pick" data-pick="' + i + '"' +
                    (can && picks[i] ? " checked" : "") + (can ? "" : " disabled") + "> " + recBadges(rec) + " " + esc(recommendationTitle(rec)) + "</label>" +
                    '<div class="tuning-muted">' + esc(profileText(rec) + ". " + (REC_AREA_LABEL[rec.area] || cap(rec.area)) + "." + (rec.filterSearch ? " The app calculated these filter values." : "")) +
                    (rec.parameter ? " " + parameterHtml(rec.parameter) + " " + esc(paramText(rec).replace(/^\([^)]*\)(: )?/, "") + ".") : "") +
                    (hasCli(rec) ? "" : " " + esc(noCliText(rec))) + "</div>" +
                    (g ? '<div class="tuning-muted tuning-pick-group">' + esc(groupText(recs, i)) + "</div>" : "") + "</li>";
            }).join("") + "</ul>" : '<p class="tuning-muted">No recommendation.</p>') + "</div>" +
            '<div class="tuning-export-out"><h5 class="tuning-h">Commands</h5><div class="tuning-export-preview">' + exportPreview(entry, env) + "</div></div></div>";
        return { html: html, plots: [] };
    }

    // The flights of the analysis in one line of the CLI file: "Log 50: 14.3 s to 87 s. Log 3: Bench run (no analysis)."
    function flightsLine(fl) {
        if (!fl) return null;
        return Object.keys(fl.logs).map(Number).sort(function (a, b) { return a - b; }).map(function (k) {
            var L = fl.logs[k];
            return "Log " + (L.log + 1) + ": " + (L.noData ? NO_DATA + "." : L.bench ? BENCH + "." : L.flights.length ? L.flights.map(function (f) {
                return num(+f.t0.toFixed(1)) + " s to " + num(+f.t1.toFixed(1)) + " s";
            }).join(", ") + "." : "no flight.");
        }).join(" ") || null;
    }

    // A CLI index of a profile (0 to 5) that the CLI dump selects at its end, else null. The worker gives selectedProfile
    // only when the dump is complete (C7): the last `profile N` of a dump that is cut is not the selection of the pilot
    function cliIndex(v) {
        return isNum(v) && v === Math.floor(v) && v >= 0 && v <= 5 ? v : null;
    }

    // What the CLI file says about the analysis (advice.cjs exportScript meta): the log numbers of the log viewer (logBase
    // 1 for the evidence rows), the flights, the PID profiles as the Configurator numbers them, the local date of the
    // analysis, and the PID profile and rate profile to select again after the changes (CLI index), when the CLI dump has them
    function exportMeta(entry) {
        var r = entry.result, h = r.header || {}, d = new Date(entry.finishedAt), two = function (n) { return ("0" + n).slice(-2); };
        var logs = Array.isArray(r.logs) ? r.logs.filter(isNum) : isNum(r.logIndex) ? [r.logIndex] : [];
        return { craft: h["Craft name"] || null, file: r.fileName || null, logs: logs.map(function (l) { return String(l + 1); }), flights: flightsLine(flightsOf(r)),
            firmware: h["Firmware revision"] || null, profiles: profileList(r).filter(function (p) { return p > 0; }),
            date: d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()), logBase: 1,
            activeProfile: r.cli ? cliIndex(r.cli.selectedProfile) : null,
            activeRateProfile: r.cli ? cliIndex(r.cli.selectedRateProfile) : null };
    }

    function checksTable(entry, view, env) {
        var r = entry.result, q = String(view.query || "").trim().toLowerCase(), all = r.findings || [];
        // "issues" (the default) also takes the satisfactory results, which the filter "Show satisfactory results" shows (SPEC3 E)
        var sev = { issues: ["error", "flag", "note", "ok"], problems: ["error", "flag"], all: null }[view.sev], sort = SORTS[view.sort] || SORTS.severity;
        var list = all.filter(function (f) {
            if (!inView(f, view)) return false;
            if (sev ? sev.indexOf(f.severity) < 0 : view.sev !== "all" && f.severity !== view.sev) return false;
            if (view.area !== "all" && areaOf(f) !== view.area) return false;
            return !q || [f.id, f.module, f.text, f.summary, f.source, f.axis, f.profile].join(" ").toLowerCase().indexOf(q) >= 0;
        }).sort(function (a, b) { return (view.dir < 0 ? -1 : 1) * sort(a, b); });
        var filter = env.filter ? env.filter() : {}, got = filterResults(list, filter, view.sev === "ok" ? { ok: true } : null);
        list = got.list;
        return filterBar(filter, got, true) + '<p class="tuning-muted tuning-count">' + esc(list.length + " of " + plural(all.length, "result") + ".") +
            " The log numbers start at 1, as in the log list of the log viewer.</p>" +
            findingsTable(list, { showLog: fileLike(r), sortable: true, sort: view.sort, dir: view.dir, where: "checks", empty: "No result agrees with the filter." }, env);
    }

    function renderChecks(entry, view, env) {
        var html = selectBars(entry, view, env) + '<div class="tuning-filters">' +
            '<select class="form-control input-sm tuning-f-sev">' + options([["issues", "Problems, notes and analysis errors"], ["problems", "Problems and analysis errors"],
                ["all", "All results"], ["flag", "Problems only"], ["note", "Notes only"], ["ok", "Satisfactory only"], ["skipped", "Not measured only"], ["error", "Analysis errors only"]], view.sev) + "</select>" +
            '<select class="form-control input-sm tuning-f-area">' + options([["all", "All areas"]].concat(AREAS.map(function (a) { return [a.key, a.title]; })), view.area) + "</select>" +
            '<input type="search" class="form-control input-sm tuning-f-query" placeholder="Type a check, a word or a source" value="' + esc(view.query) + '">' +
            '</div><div class="tuning-checks-table">' + checksTable(entry, view, env) + "</div>";
        return { html: html, plots: [] };
    }

    // The tab "Configurations" (SPEC3 J): the configurations of the logs, the table "Parameters that are not the same", the
    // values that do not change the flight, the names that the app does not know and the notes of datasets.cjs
    var CONFIG_NOTE = "A configuration is one PID profile and one set of the parameter values that change the flight. A different value of one of these parameters starts a new configuration. " +
        "A different value of a parameter that does not change the flight (for example, rescue or telemetry) does not start a new configuration.";

    function renderConfigs(entry, view, env) {
        var r = entry.result, ds = datasetsOf(r), list = configList(r, true), sel = configOf(r, view.dataset) ? view.dataset : null;
        var fresh = freshnessHtml(r, env && env.uid); // the parts of the logs with values that are possibly different, and the caveat
        if (!ds) return { html: '<p class="tuning-na-text">This result has no configurations. The analysis did not calculate them.</p>' + fresh, plots: [] };
        var html = '<p class="tuning-muted">' + esc(CONFIG_NOTE) + "</p>" +
            '<div class="tuning-table-wrap"><table class="tuning-table tuning-config-table"><thead><tr><th>Configuration</th><th>PID profile</th><th>Logs</th><th>Flights</th><th>Flight time</th><th>Values</th><th></th></tr></thead><tbody>' +
            list.map(function (d) {
                var fl = Array.isArray(d.flights) ? d.flights : [], marks = configMarks(d, ds), start = configStartTitle(r, d), pl = esc(profileLabel(isNum(d.pidProfile) ? d.pidProfile : 0));
                return '<tr class="tuning-config-row' + (d.id === sel ? " is-selected" : "") + '"><td><strong>' + esc(d.id) + "</strong></td><td>" +
                    (start ? '<span class="tuning-start" title="' + esc(start) + '">' + pl + "</span>" : pl) + // D12: the basis of its logs that start in it
                    "</td><td>" + esc(cap(logsText(d.logs))) + '</td><td class="tuning-num">' + esc(String(fl.length)) + '</td><td class="tuning-num">' + esc(isNum(configFlight(d)) ? secs(configFlight(d)) : "") +
                    "</td><td>" + esc(cap([configSources(d)].concat(marks).filter(Boolean).join(", ")) || "From the log header") + "</td><td>" +
                    (configList(r).length > 1 && d.analysed !== false ? '<button type="button" class="btn btn-default btn-xs tuning-config-pick" data-config="' + esc(d.id) + '"' + (d.id === sel ? " disabled" : "") + ">Show</button>" : "") + "</td></tr>";
            }).join("") + "</tbody></table></div>" +
            '<h5 class="tuning-h">Parameters that are not the same</h5>' + diffTable(ds, sel) + comparisonsHtml(ds, null);
        var info = Array.isArray(ds.info) ? ds.info.filter(function (q) { return q && q.name && Array.isArray(q.values); }) : [];
        if (info.length) {
            html += '<h5 class="tuning-h">Values that do not change the flight</h5><p class="tuning-muted">These values are not the same in all logs. They do not start a new configuration.</p>' +
                '<ul class="tuning-config-info">' + info.map(function (q) {
                    return "<li>" + parameterHtml(q.name) + ": " + q.values.map(function (x) { return "<code>" + esc(num(x.value)) + "</code>" + (logsText(x.logs) ? " " + esc("(" + logsText(x.logs) + ")") : ""); }).join(", ") + "</li>";
                }).join("") + "</ul>";
        }
        var unknown = Array.isArray(ds.unknownNames) ? ds.unknownNames.filter(function (q) { return q && q.name; }) : [];
        if (unknown.length) {
            html += '<p class="tuning-muted">' + esc("The app does not know these parameters. Thus, the app uses them as parameters that change the flight: ") +
                unknown.map(function (q) { return quoted(parameterHtml(q.name)); }).join(", ") + ".</p>";
        }
        var notes = Array.isArray(ds.notes) ? ds.notes.filter(function (n) { return typeof n === "string" && n.trim(); }) : [];
        if (notes.length) html += '<h5 class="tuning-h">Notes</h5><ul class="tuning-notes">' + notes.map(function (n) { return "<li>" + mdCode(n) + "</li>"; }).join("") + "</ul>";
        return { html: html + fresh, plots: [] };
    }

    function renderCoverage(entry) {
        var r = entry.result, rows = adviceRan(r) ? r.advice.coverage : null;
        if (!rows) return { html: '<p class="tuning-na-text">The parameter groups are not available: ' + quoted(esc(whyNoAdvice(r))) + ".</p>", plots: [] };
        var c = countBy(rows, "status");
        function meta(status) { return COVERAGE[status] || [String(status), "insufficient"]; }
        var html = '<ul class="tuning-coverage-summary">' + Object.keys(c).map(function (s) { return "<li>" + badge(meta(s)[0] + " " + c[s], meta(s)[1]) + "</li>"; }).join("") + "</ul>" +
            (c["not-in-log"] ? '<p class="tuning-muted">' + esc('For the groups with the condition "' + COVERAGE["not-in-log"][0] + '", the log header and the log data do not record the values. ' +
                "Thus, the analysis cannot examine them.") + "</p>" : "") +
            (c["no-check"] ? '<p class="tuning-muted">For the groups with the condition "No check in the app", the app has no check that operates on a log. Examine these values on the helicopter.</p>' : "") +
            '<div class="tuning-table-wrap"><table class="tuning-table"><thead><tr><th>Group</th><th>Condition</th><th>Checks</th><th>Parameters</th><th>Data</th></tr></thead><tbody>' +
            rows.map(function (row) {
                var area = REC_AREA_LABEL[row.area] || row.area;
                return "<tr><td>" + esc(row.group || area) + (row.group ? '<div class="tuning-muted">' + esc(area) + "</div>" : "") + "</td><td>" + badge(meta(row.status)[0], meta(row.status)[1]) + '</td><td class="tuning-id">' + esc((row.checks || []).join(", ")) +
                    '</td><td class="tuning-params">' + (row.parameters || []).map(parameterHtml).join(", ") + '</td><td class="tuning-text">' + esc(row.detail) + "</td></tr>";
            }).join("") + "</tbody></table></div>";
        return { html: html, plots: [] };
    }

    // ---------------------------------------------------------------------------------------------
    // Plots: items are { spec } (TuningPlot) or { title, na: reason }

    // Why a curve is missing: a field the log lacks, a log with no flight (the loop modules do not use those), a field
    // recorded as zero, a note of the worker, else the plain fact
    function whyMissing(result, curve, part, field) {
        var state = result.fields && field ? result.fields[field] : null, rec = curve && logRecord(result, curve.log);
        if (state === "absent") return field + " is not in the log";
        if (rec && !rec.flown) return "log " + logLabel(curve.log) + " has no flight (headspeed more than the flight rpm, in flight)";
        if (state === "zero") return "all values of " + field + " in the log are 0";
        var re = part === "tracking error" ? /health_track|track curves/ : /health_more|more curves/;
        var note = (result.notes || []).filter(function (n) { return re.test(String(n)); })[0];
        if (note) return String(note);
        return curve ? "the result has no " + part + " curves for log " + logLabel(curve.log) : "the result has no curves";
    }

    function has(obj, key) {
        return !!(obj && obj[key] && obj[key].length > 1);
    }

    function line(name, x, y, color, extra) {
        var s = { name: name, x: x, y: y, color: color, width: 1.5 };
        Object.keys(extra || {}).forEach(function (k) { s[k] = extra[k]; });
        return s;
    }

    // A plot item, or "not available" when no series has data
    function item(spec, reason) {
        spec.series = spec.series.filter(function (s) { return s.y && s.y.length > 1; });
        if (spec.legend === undefined) spec.legend = spec.series.length > 1;
        return spec.series.length ? { spec: spec } : { title: spec.title, na: reason || "the result has no data" };
    }

    // look: the log fields behind the plot, one array of names per graph, for "Show in the log"
    function timeItem(curve, env, spec, reason, look) {
        spec.x = { label: "time", unit: "s" };
        spec.onClick = function (x) { env.seek(curve.log, x, look ? { graphs: look, title: spec.title } : null, curve.segment); };
        return item(spec, reason);
    }

    // "Show in the log" for a finding time without evidence: the log fields of its check (k: axis index)
    var LOOK = [
        { re: /^(C5|C12|C13|T1|T11|T12)$/, graphs: function (k) { return [["setpoint[" + k + "]", "gyroADC[" + k + "]"], ["axisError[" + k + "]"]]; } },
        { re: /^R1$/, graphs: function (k) { return [["rcCommand[" + k + "]"], ["setpoint[" + k + "]"]]; } },
        { re: /^G\d+$/, graphs: function () { return [["headspeed", "govTarget"], ["motor[0]"], ["setpoint[3]"]]; } },
        { re: /^T\d+$/, graphs: function () { return [["mixer[2]"], ["setpoint[2]", "gyroADC[2]"]]; } },
        { re: /^F\d+$/, graphs: function (k) { return [["gyroRAW[" + k + "]", "gyroADC[" + k + "]"]]; }, analyser: function (k) { return "gyroRAW[" + k + "]"; } }
    ];

    function lookFor(id, axis) {
        var k = Math.max(0, AXES.indexOf(axis || (/^T\d+$/.test(String(id)) ? "yaw" : "roll")));
        for (var i = 0; i < LOOK.length; i++) {
            if (LOOK[i].re.test(String(id))) return { graphs: LOOK[i].graphs(k), analyser: LOOK[i].analyser ? LOOK[i].analyser(k) : null };
        }
        return null;
    }

    // Runs of equal value on a regular time grid: [{ x0, x1, value }]
    function runsOf(t, v) {
        var out = [], n = Math.min(t ? t.length : 0, v ? v.length : 0), dt = n > 1 ? t[1] - t[0] : 0.1;
        for (var i = 0; i < n; ) {
            var j = i;
            while (j + 1 < n && v[j + 1] === v[i]) j++;
            out.push({ x0: t[i] - dt / 2, x1: t[j] + dt / 2, value: v[i] });
            i = j + 1;
        }
        return out;
    }

    // Shaded spans where mask is `want`; only the first carries the label
    function maskBands(t, mask, want, color, label) {
        return runsOf(t, mask).filter(function (r) { return (r.value ? 1 : 0) === want; }).slice(0, 400)
            .map(function (r, i) { return { x0: r.x0, x1: r.x1, color: color, label: i ? "" : label }; });
    }

    // Finding times of this log as triangles along the top edge of a time plot; with an axis, the findings of that
    // axis and those of none
    function markers(result, curve, re, axis) {
        var out = [];
        (result.findings || []).forEach(function (f) {
            var fa = findingAxis(f);
            if (!onLog(f, curve.log) || !re.test(String(f.id)) || (axis && fa && fa !== axis) || !Array.isArray(f.times)) return;
            f.times.forEach(function (t) {
                if (isNum(t) && out.length < 150) out.push({ x: t, color: STATUS_COLOR[findingStatus(f)], label: f.id + " " + STATUS[findingStatus(f)], shape: "tri" });
            });
        });
        return out;
    }

    // "main rotor 2× Q8": the notch filter label of health_more curves() ("main rotor 2x") in STE terms
    function notchLabel(n) {
        var text = oneLine(n.label || "notch filter").replace(/\bmain motor\b/, "motor").replace(/(\d)x\b/, "$1×");
        return text + (isNum(n.q) ? " Q" + num(n.q) : "");
    }

    function firstPositive(f) {
        for (var i = 0; i < f.length; i++) if (f[i] > 0) return f[i];
        return 0.1;
    }

    function trackPlots(curve, axis, result, env) {
        var tr = curve.track && curve.track[axis], color = C[axis], out = [];
        if (!tr) return [{ title: "Tracking error, " + axis, na: curve.track ? "the result has no " + axis + " curves" : whyMissing(result, curve, "tracking error", "setpoint[" + AXES.indexOf(axis) + "]") }];
        var tm = tr.time || {}, sp = tr.spectrum, ev = tr.errVsSp, tau = tr.tauMs;
        var none = tm.usable && Array.prototype.indexOf.call(tm.usable, 1) < 0 ? "this log has no flight that the analysis can use. The analysis does not use samples " +
            "on the ground, without the governor condition ACTIVE, in rescue, level mode or failsafe, or 1 s or less from a change of PID profile or governor condition" : "";
        var tauText = isNum(tau) ? " (time delay " + num(tau) + " ms)" : "", unusable = maskBands(tm.t, tm.usable, 0, C.unusable, "not used");
        // the error as C12 and T11 have it: gyro and setpoint low-passed at lpHz, the vibration above it is the F checks'
        var lp = isNum(tr.lpHz) ? ", less than " + num(tr.lpHz) + " Hz" : "";
        var ai = AXES.indexOf(axis), look = [["setpoint[" + ai + "]", "gyroADC[" + ai + "]"], ["axisError[" + ai + "]"]];
        out.push(timeItem(curve, env, {
            title: "Tracking error, " + axis + ": RMS in each 0.1 s", y: { label: "RMS", unit: "deg/s", min: 0 }, bands: unusable,
            series: [line("setpoint", tm.t, tm.sp, C.grey, { width: 1 }), line("error" + lp, tm.t, tm.err, color),
                line("error without the time delay" + lp + tauText, tm.t, tm.errComp, C.blue, { dash: [4, 3] })],
            markers: markers(result, curve, /^(C|T|R)\d+$/, axis)
        }, null, look));
        // C5 and T1 amplitudes: of the band-passed error, which passes oscGain of a sine in the band; the 10/20/40 lines are on that scale
        var ob = Array.isArray(tr.oscBand) ? tr.oscBand : sp && Array.isArray(sp.band) ? sp.band : null,
            bandText = ob ? ", " + num(ob[0]) + "-" + num(ob[1]) + " Hz" : "",
            gainText = Array.isArray(tr.oscGain) && isNum(tr.oscGain[0]) && isNum(tr.oscGain[1]) ? " (filter gain in the band " + num(tr.oscGain[0]) + "-" + num(tr.oscGain[1]) + ")" : "";
        out.push(timeItem(curve, env, {
            title: "Oscillation amplitude" + bandText + ", " + axis, y: { label: "amplitude", unit: "deg/s", min: 0 },
            series: [line("√2 × RMS of the error in the band, in 0.5 s" + gainText, tm.t, tm.osc, color)],
            bands: maskBands(tm.t, tm.stickDriven, 1, C.stick, "stick movement").concat(unusable),
            hlines: [10, 20, 40].map(function (y) { return { y: y, color: C.ref, label: y + " deg/s", dash: [4, 3] }; }),
            markers: markers(result, curve, /^(C5|T1)$/, axis)
        }, null, look));
        if (has(sp, "f") && sp.windows > 0) {
            var x = { label: "frequency", unit: "Hz", log: true, min: firstPositive(sp.f) }, delay = [];
            var bands = Array.isArray(sp.band) ? [{ x0: sp.band[0], x1: sp.band[1], color: C.band, label: "oscillation band" }] : [];
            for (var i = 0; i < sp.f.length; i++) delay.push(isNum(tau) ? -360 * sp.f[i] * tau / 1000 : NaN);
            // T is measured only where its random error sqrt(1 - coh) / sqrt(2 n coh) (Bendat and Piersol) is under
            // T_MAX_SE (report.cjs RULES.maxSigma); elsewhere it is drawn faint and left out of the phase axis range
            var Tm = [], Td = [], lo = Infinity, hi = -Infinity;
            for (var j = 0; j < sp.f.length; j++) {
                var c = sp.coh[j], se = c > 0 ? Math.sqrt((1 - c) / (2 * sp.windows * c)) : Infinity, ok = se <= T_MAX_SE;
                Tm.push(ok ? sp.Tmag[j] : NaN); Td.push(ok ? sp.Tdeg[j] : NaN);
                if (ok && isNum(sp.Tdeg[j])) { lo = Math.min(lo, sp.Tdeg[j]); hi = Math.max(hi, sp.Tdeg[j]); }
            }
            var faint = "rgba(128,177,211,0.35)", seText = " (SE less than " + T_MAX_SE * 100 + " %)";
            out.push(item({
                title: "Error spectrum and gain from setpoint to gyro, " + axis + (isNum(sp.windows) ? " (" + plural(sp.windows, "window") + ")" : ""),
                x: x, y: { label: "ratio", log: true }, y2: { label: "coherence", min: 0, max: 1 }, bands: bands,
                series: [line("error / setpoint", sp.f, sp.ratio, color), line("gain from setpoint to gyro" + seText, sp.f, Tm, C.blue),
                    line("gain, SE too large", sp.f, sp.Tmag, faint, { width: 1 }),
                    line("coherence", sp.f, sp.coh, C.grey, { axis: "y2", width: 1, dash: [2, 3] })],
                hlines: [{ y: 1, color: C.ref, dash: [4, 3] }]
            }));
            out.push(item({
                title: "Phase, setpoint to gyro" + tauText, x: x, bands: bands,
                y: lo <= hi ? { label: "phase", unit: "deg", min: Math.floor(Math.min(lo, -90) / 90) * 90, max: Math.ceil(Math.max(hi, 0) / 90) * 90 } : { label: "phase", unit: "deg" },
                series: [line("phase of T" + seText, sp.f, Td, color), line("phase, SE too large", sp.f, sp.Tdeg, faint, { width: 1 }),
                    line("time delay, −360 × f × τ", sp.f, delay, C.grey, { dash: [4, 3], width: 1 })]
            }));
        } else {
            out.push({ title: "Error spectrum, " + axis, na: none || "the usable flight is not sufficient for a spectrum (periods of 2 s or more are necessary)" });
        }
        if (ev && Array.isArray(ev.edges) && ev.edges.length > 2) {
            var mids = [], full = []; // bins up to the last with samples
            for (var k = 0; k + 1 < ev.edges.length; k++) {
                mids.push((ev.edges[k] + ev.edges[k + 1]) / 2);
                if (!ev.n || ev.n[k] > 0) full.push(k);
            }
            mids.length = full.length ? full[full.length - 1] + 1 : 0;
            var one = full.length === 1 && ev.meanAbsErr ? "only the bin from " + ev.edges[full[0]] + " to " + ev.edges[full[0] + 1] + " deg/s has samples: mean error " +
                num(ev.meanAbsErr[full[0]]) + " deg/s (" + plural(ev.n[full[0]], "sample") + ")" : "";
            out.push(item({
                title: "Mean error for each setpoint range, " + axis, x: { label: "setpoint amplitude", unit: "deg/s", min: 0 }, y: { label: "mean error amplitude", unit: "deg/s", min: 0 },
                series: [line("mean error" + lp, mids, ev.meanAbsErr && ev.meanAbsErr.slice(0, mids.length), color, { points: true }),
                    line("without the time delay" + lp, mids, ev.meanAbsErrComp && ev.meanAbsErrComp.slice(0, mids.length), C.blue, { points: true, dash: [4, 3] })]
            }, none || one));
        }
        return out;
    }

    function govPlots(curve, axis, result, env) {
        var g = curve.more && curve.more.gov;
        if (!g || !has(g, "t")) return [{ title: "Governor", na: whyMissing(result, curve, "governor", "headspeed") }];
        var span = g.t[g.t.length - 1] - g.t[0];
        var states = runsOf(g.t, g.state).filter(function (r) { return STATE_BAND[r.value]; }).slice(0, 300).map(function (r) {
            return { x0: r.x0, x1: r.x1, color: STATE_BAND[r.value], label: r.x1 - r.x0 > 0.03 * span ? GOV_STATES[r.value] : "" };
        });
        var profiles = runsOf(g.t, g.profile).slice(1, 60).map(function (r) { return { x: r.x0, color: C.purple, label: profileLabel(curveProfile(result, curve.log, r.value)), dash: [3, 3] }; });
        var range = errRange(g), look = [["headspeed", "govTarget"], ["motor[0]"], ["setpoint[3]"]], ref = g.reference ? oneLine(g.reference) : "the target";
        return [
            timeItem(curve, env, { title: "Headspeed, governor target and governor condition", y: { label: "headspeed", unit: "rpm" },
                series: [line("headspeed", g.t, g.hs, C.orange), line("governor target", g.t, g.target, C.blue, { dash: [4, 3] })],
                bands: states, vlines: profiles, markers: markers(result, curve, /^G\d+$/) }, null, look),
            timeItem(curve, env, { title: "Headspeed error from " + ref, vlines: profiles,
                y: { label: "error", unit: "%", min: -range, max: range },
                series: [line("(headspeed − target) / target", g.t, g.errPct, C.orange)],
                hlines: [-2, -1, 1, 2].map(function (y) { return { y: y, color: C.ref, label: (y > 0 ? "+" : "") + y + " %", dash: Math.abs(y) === 1 ? [2, 3] : [5, 3] }; }) }, null, look),
            timeItem(curve, env, { title: "Throttle and collective", y: { label: "throttle", unit: "%", min: 0 }, y2: { label: "collective", unit: "‰" }, vlines: profiles,
                series: [line("throttle (motor[0])", g.t, g.throttle, C.green), line("collective", g.t, g.coll, C.grey, { axis: "y2", width: 1 })] },
                whyMissing(result, curve, "throttle", "motor[0]"), look)
        ];
    }

    // Half the y range of the headspeed error plot: 1st to 99th percentile while the governor is ACTIVE (else all),
    // at least 3 %, so spool-up does not flatten the +-1 / +-2 % band the G2 check judges
    function errRange(g) {
        var v = [];
        for (var i = 0; g.errPct && i < g.errPct.length; i++) {
            if (isNum(g.errPct[i]) && (!g.state || g.state[i] === 4)) v.push(Math.abs(g.errPct[i]));
        }
        v.sort(function (a, b) { return a - b; });
        return Math.max(3, Math.ceil(1.2 * (v.length ? v[Math.floor(0.99 * (v.length - 1))] : 0)));
    }

    // The rotor frequency to mark harmonics of: rotorHz is one number or one per log profile; with several, the
    // profile flown longest in this log. { hz, profile }
    function mainRotor(rotorHz, rec) {
        if (isNum(rotorHz)) return { hz: rotorHz, profile: null };
        var keys = Object.keys(rotorHz || {}).filter(function (k) { return isNum(rotorHz[k]) && rotorHz[k] > 0; }), flown = rec ? rec.profileSeconds : {};
        keys.sort(function (a, b) { return (flown[b] || 0) - (flown[a] || 0); });
        return keys.length ? { hz: rotorHz[keys[0]], profile: keys.length > 1 ? +keys[0] : null } : null; // the label of the modules (0: the start, curveProfile)
    }

    // The vibration spectra on display (health_more curves vib): one profile's (vib.byProfile, over the windows wholly on
    // it) or all profiles pooled. A rotor-order line sits at another frequency on each headspeed, so the pooled spectrum
    // splits it into one peak per profile, each scaled by about sqrt(that profile's share of the windows); a profile's
    // own compares flights at one headspeed. The default is the profile flown longest in this log; with fewer than two
    // profiles there is nothing to choose. { keys, p: a key of byProfile, "all", or null (no choice), one: byProfile[p] }
    function vibChoice(curve, result, view) {
        var v = curve && curve.more && curve.more.vib, by = v && v.byProfile && typeof v.byProfile === "object" ? v.byProfile : {};
        var keys = Object.keys(by).filter(function (k) { return /^\d+$/.test(k) && by[k] && by[k].roll; }).sort(function (a, b) { return a - b; });
        if (keys.length < 2) return { keys: keys, p: null, one: null };
        var rec = logRecord(result, curve.log), flown = rec ? rec.profileSeconds : {};
        var longest = keys.slice().sort(function (a, b) { return (flown[b] || 0) - (flown[a] || 0) || (by[b].windows || 0) - (by[a].windows || 0) || a - b; })[0];
        var p = view.vibProfile === "all" || keys.indexOf(String(view.vibProfile)) >= 0 ? String(view.vibProfile) : longest;
        return { keys: keys, p: p, one: p === "all" ? null : by[p], longest: longest };
    }

    function vibToolbar(curve, result, view) {
        var ch = vibChoice(curve, result, view);
        if (ch.p === null) return "";
        var by = curve.more.vib.byProfile;
        return '<select class="form-control input-sm tuning-vib-profile" title="Show the spectra of one PID profile or of all PID profiles together">' +
            options([["all", "All PID profiles (weight: time in each)"]].concat(ch.keys.map(function (k) {
                var q = by[k];
                return [k, profileLabel(curveProfile(result, curve.log, k)) + (+k === 0 && ch.keys.indexOf(String(startProfile(result, curve.log))) >= 0 ? " at the start of the log" : "") +
                    (isNum(q.rotorHz) ? ", " + Math.round(q.rotorHz * 60) + " rpm" : "") + ", " + plural(q.windows, "window") +
                    (isNum(q.share) ? " (" + Math.round(q.share * 100) + " %)" : "") + (k === ch.longest ? ", longest flight time" : "")];
            })), ch.p) + "</select>";
    }

    // The caption of the Filters tab for the axis on display: the notch orders of the log (result.notchFit, notchFitTexts)
    function vibCaption(curve, result, view) {
        var v = curve && curve.more && curve.more.vib, ch = v ? vibChoice(curve, result, view) : { one: null }, src = ch.one || v;
        var texts = notchFitTexts(result, src && src.notches ? src.notches[view.axis] : []);
        return texts.length ? '<p class="tuning-muted tuning-notch-fit">' + esc(texts.join(" ")) + "</p>" : "";
    }

    function vibPlots(curve, axis, result, env, view) {
        var m = curve.more || {}, v = m.vib, k = AXES.indexOf(axis), out = [], fx = { label: "frequency", unit: "Hz", min: 0 };
        var ch = vibChoice(curve, result, view), one = ch.one, src = one || v, a = src && src[axis];
        var raw = "gyroRAW[" + k + "]", noFlight = "no window in flight is sufficiently long for a spectrum";
        var where = one ? ", " + profileLabel(curveProfile(result, curve.log, ch.p)) + " (" + plural(one.windows, "window") + ")" : ch.p === "all" ? ", all PID profiles (weight: time in each)" : "";
        if (a && has(a, "f") && v.windows !== 0) {
            // a notch filter at an order that the worker found in the log (result.notchFit) says so; one with no frequency is not
            // drawn, and the caption of the tab (vibCaption) says why
            var notches = (src.notches && src.notches[axis] || []).filter(function (n) { return isNum(n.hz); }).slice(0, 30).map(function (n) {
                var fromLog = !!fitUsed(result, fitGroupOf(n.code));
                return { x: n.hz, color: C.orange, dash: fromLog ? [2, 2] : [4, 2], label: notchLabel(n) + (fromLog ? ", from the log" : "") };
            });
            var lpf = (v.lpf || []).filter(function (l) { return isNum(l.hz) && l.hz > 0; }).map(function (l) {
                return { x: l.hz, color: C.green, dash: [6, 3], label: oneLine(l.name) + " " + num(l.hz) + " Hz" };
            });
            var dn = v.dynNotch || {}, dyn = dn.enabled !== false && dn.count > 0 && isNum(dn.min) && isNum(dn.max) ?
                [{ x0: dn.min, x1: dn.max, color: C.dyn, label: "dynamic notch filter range" }] : [];
            var rotor = one ? (isNum(one.rotorHz) && one.rotorHz > 0 ? { hz: one.rotorHz, profile: null } : null) : mainRotor(v.rotorHz, logRecord(result, curve.log)),
                fmax = a.f[a.f.length - 1], marks = [];
            for (var n = 1; rotor && n <= 8 && n * rotor.hz <= fmax; n++) marks.push({ x: n * rotor.hz, color: C.ref, dash: [2, 3], label: n + "×" });
            marks = notches.concat(lpf, marks); // the filter lines take the label rows first; the title gives the rotor frequency
            var both = !v.filtOnly && a.raw, of = rotor ? ". Rotor harmonics" + (rotor.profile !== null ? " of " + profileLabel(curveProfile(result, curve.log, rotor.profile)) : "") + " at " + num(rotor.hz) + " Hz" : "";
            out.push(item({ title: (both ? "Gyro spectrum before and after the filters, " : "Gyro spectrum after the filters only (gyroRAW is not in the log), ") + axis + where + of,
                x: fx, y: { label: "amplitude", unit: "deg/s", log: true }, vlines: marks, bands: dyn,
                series: [line("gyroRAW, before the filters", a.f, both ? a.raw : null, C.grey, { width: 1 }), line("gyroADC, after the filters", a.f, a.filt, C[axis])] }));
            out.push(item({ title: "Filter transmission (gyroADC / gyroRAW), " + axis + where, x: fx, y: { label: "ratio", min: 0, max: 1.5 }, vlines: marks,
                series: [line("transmission", a.f, a.pass, C[axis])], hlines: [{ y: 1, color: C.ref, dash: [4, 3] }] }, whyMissing(result, curve, "transmission", raw)));
        } else {
            out.push({ title: "Gyro spectrum, " + axis, na: v && v.windows === 0 ? noFlight : whyMissing(result, curve, "vibration", raw) });
        }
        // D-term and control spectra are of all profiles' usable flight; with a profile choice, say so
        var d = m.dterm && m.dterm[axis], u = m.control && m.control[axis], at30 = [{ x: 30, color: C.ref, label: "30 Hz", dash: [4, 3] }], all = ch.p !== null ? ", all PID profiles" : "";
        out.push(item({ title: "D-term spectrum (axisD), " + axis + all + (d && isNum(d.share30) ? ". Power at more than 30 Hz: " + Math.round(d.share30 * 100) + " %" : ""),
            x: fx, y: { label: "PSD", log: true }, vlines: at30, series: [line("axisD", d && d.f, d && d.psd, C[axis])] },
            m.control && m.control.windows === 0 ? noFlight : whyMissing(result, curve, "D-term", "axisD[" + k + "]")));
        out.push(item({ title: "Control spectrum (mixer), " + axis + all, x: fx, y: { label: "PSD", log: true }, vlines: at30,
            series: [line("mixer", u && u.f, u && u.psd, C[axis])] }, m.control && m.control.windows === 0 ? noFlight : whyMissing(result, curve, "control")));
        return out;
    }

    function tailPlots(curve, axis, result, env) {
        var tl = curve.more && curve.more.tail;
        if (!tl || !has(tl, "t")) return [{ title: "Tail", na: whyMissing(result, curve, "tail") }];
        var u = tl.u || {}, lim = tl.limits || {}, mid = u.mean;
        if (!mid && u.min && u.max) mid = Array.from(u.min, function (v, i) { return (v + u.max[i]) / 2; });
        var limits = ["lo", "hi"].filter(function (k) { return isNum(lim[k]); }).map(function (k) { return { y: lim[k], color: C.limit, label: "limit " + num(lim[k]), dash: [5, 3] }; });
        var look = [["mixer[2]"], ["setpoint[2]", "gyroADC[2]"]];
        return [
            timeItem(curve, env, { title: "Tail output and the tail output limits" + (limits.length ? "" : " (no limit found)"), y: { label: "mixer[2]", unit: "‰" },
                series: [line("mixer[2]: mean, and minimum to maximum in each 0.1 s", tl.t, mid, C.yaw, { lo: u.min, hi: u.max, fill: true, width: 1 })],
                hlines: limits, markers: markers(result, curve, /^T\d+$/) }, null, look),
            timeItem(curve, env, { title: "Yaw error, RMS in each 0.1 s", y: { label: "RMS", unit: "deg/s", min: 0 }, series: [line("setpoint − gyro", tl.t, tl.err, C.yaw)] }, null, look)
        ];
    }

    var PLOT_TABS = {
        curves: { build: trackPlots, axes: true, part: "tracking error", checks: /^(C5|C12|C13|T1|T11|T12|T14|R1)$/ },
        governor: { build: govPlots, axes: false, part: "governor", checks: /^(G\d+|D5)$/ },
        filters: { build: vibPlots, axes: true, part: "vibration", checks: /^(F\d+|C11)$/, toolbar: vibToolbar, caption: vibCaption },
        tail: { build: tailPlots, axes: false, part: "tail", checks: /^T\d+$/ }
    };

    function curvesInView(result,view) {
        var list=Array.isArray(result.curves) ? result.curves : [], ds=datasetsOf(result);
        if (view.dataset && view.dataset!=='all' && ds && Array.isArray(ds.curves))
            return ds.curves.filter(function(q){return q.dataset===view.dataset;});
        if (view.dataset && view.dataset!=='all' && list.some(function(c){return Array.isArray(c.configurations);}))
            return [].concat.apply([],list.map(function(c){return (c.configurations||[]).filter(function(q){return q.dataset===view.dataset;});}));
        return list;
    }
    // The curve entry on display: the chosen configuration interval, else the longest.
    function curveOf(result, view) {
        var list = curvesInView(result,view);
        if (list[view.segment]) return list[view.segment];
        return list.reduce(function (a, b) { return a && (a.seconds || 0) >= (b.seconds || 0) ? a : b; }, null);
    }

    function renderPlotTab(key, entry, view, env) {
        if (key === 'filters') return {html:env.filterSearch ? env.filterSearch('tab') : '',plots:[]};
        var tab = PLOT_TABS[key], r = entry.result, curve = curveOf(r,view), list = curvesInView(r,view), html = '';
        html += '<div class="tuning-plot-toolbar">';
        if (tab.axes) {
            html += '<div class="btn-group btn-group-xs">' + AXES.map(function (a) {
                return '<button type="button" class="btn btn-default tuning-axis' + (a === view.axis ? " active" : "") + '" data-axis="' + a + '">' +
                    '<span class="tuning-dot" style="background:' + C[a] + '"></span>' + cap(a) + "</button>";
            }).join("") + "</div>";
        }
        if (list.length > 1) {
            html += '<select class="form-control input-sm tuning-segment">' + options(list.map(function (c, i) {
                return [String(i), "Log " + logLabel(c.log) + (c.dataset ? ' · ' + configLabel(c.dataset) : '') + ": " + secs(c.fromS) + " to " + secs((c.fromS || 0) + (c.seconds || 0))];
            }), String(list.indexOf(curve))) + "</select>";
        }
        if (tab.toolbar && curve) html += tab.toolbar(curve, r, view);
        html += '<span class="tuning-muted">' + (curve ? "Log " + esc(logLabel(curve.log)) + ". Click a time plot to show that time in the log viewer." : "") + "</span></div>";
        var items = curve ? tab.build(curve, view.axis, r, env, view) : [{ title: TABS.filter(function (t) { return t.key === key; })[0].title, na: whyMissing(r, null, tab.part) }];
        if (tab.caption) html += tab.caption(curve, r, view);
        html += '<div class="tuning-plots">' + items.map(function (it) {
            if (it.na) return '<div class="tuning-plot is-na"><div class="tuning-plot-title">' + esc(it.title) + '</div><div class="tuning-na">Not available: ' + esc(it.na) + "</div></div>";
            it.id = env.plotId();
            return '<div class="tuning-plot"><canvas id="' + it.id + '" class="tuning-plot-canvas"></canvas></div>';
        }).join("") + "</div>";

        var li = curve ? curve.log : r.logIndex;
        var mine = (r.findings || []).filter(function (f) {
            var fa = findingAxis(f);
            return inView(f,view) && tab.checks.test(String(f.id)) && (!isNum(li) || onLog(f, li)) && (!tab.axes || !fa || fa === view.axis);
        }).sort(SORTS.severity);
        var shownMine = filterResults(mine, env.filter ? env.filter() : null);
        html += '<h5 class="tuning-h">' + esc("Checks" + (tab.axes ? ": " + view.axis : "") + (isNum(li) ? ", log " + logLabel(li) : "")) + "</h5>" +
            filterBar(env.filter ? env.filter() : {}, shownMine, false) +
            (shownMine.list.length || !mine.length ? findingsTable(shownMine.list, { where: key, empty: "These checks have no result for this log." }, env) : "");
        return { html: html, plots: items.filter(function (it) { return it.spec; }).map(function (it) { return { id: it.id, spec: it.spec }; }) };
    }

    // ---------------------------------------------------------------------------------------------
    // The filter calculation (SPEC3 G, M2). The worker command { cmd: "filterTune", id, bytes (the whole file), fileName,
    // selectedLog, options: { flightRpm, cliText, cliName, flights } } runs tools/autotune/filter_tune.cjs tune() on the flight
    // logs of the open file. It answers { id, type: "filterTuned", result } after { type: "progress", fraction, text }. result:
    //   model        { passed, parity: [{ log, passed, axes: { roll: { passed, windows, medianLineErrorDb, maxLineErrorDb,
    //                maxBandErrorDb, delayMeasuredMs, delayPredictedMs } } }], rules: { lineDb, bandDb, delayMs } }
    //   recommended  { status: "recommended" | "not recommended" | "no flight log", reasons, cli, rows: [{ name, from, to, source,
    //                scope, profile }], predicted: { totalDb, se, axes: [{ axis, db, se }] }, delay: { maxAddMs, at: { axis, profile,
    //                hz }, f11BaseMs, f11MaxMs }, validation: { leaveOneOut: { unit, folds: [{ unit, heldOutDb, chosen }],
    //                heldOutMeanDb, heldOutSe, sameAsFull } }, unknownProfiles }
    //   curves       { f, windows, roll: { raw, logged, predicted, candidate, pidOut, pidOutCandidate }, pitch, yaw } (log Hz)
    //   text         { summary, parity, recommendation, delay, validation }: STE sentences of the worker (names in backticks)
    //   recommendations (optional): advice.cjs recommendations of the result, for the export
    // The view gives its own STE sentences from the numbers when the result has no text.

    // A tune belongs to one log or flight. Preserve the original flight numbers
    // when the analysis contains only selected flights of a log.
    function filterSources(result) {
        if (!result) return [];
        var fl = flightsOf(result), selected = result.selection && result.selection.flights, out = [];
        var logs = selected && selected.length ? selected.map(function (f) { return f.log; }) :
            fl ? Object.keys(fl.logs).map(Number) : fileLike(result) ? result.logs || [] : [result.logIndex];
        logs.filter(isNum).filter(function (li, i, all) { return all.indexOf(li) === i; }).sort(function (a,b) { return a-b; }).forEach(function (li) {
            var L = fl && fl.logs[li], flights = L && L.flights || [], picks = selected && selected.filter(function (f) { return f.log === li; });
            if (L && (L.bench || L.noData || !flights.length)) return;
            var whole = !picks || !picks.length || picks.some(function (f) { return f.flight === null; }) ||
                result.selection && (result.selection.all || []).indexOf(li) >= 0;
            function add(flight, windows, title) {
                out.push({ key: li + ':' + (flight === null ? 'all' : flight), log: li, flight: flight, windows: windows,
                    title: 'Log ' + logLabel(li) + ' · ' + title });
            }
            if (whole) add(null, flights, flights.length === 1 ? 'Flight 1' : flights.length ? 'All ' + flights.length + ' flights' : 'All flights');
            if (!whole || flights.length > 1) (whole ? flights.map(function (f,i) { return Object.assign({flight:i},f); }) : picks).forEach(function (f) {
                if (!isNum(f.flight)) return;
                add(f.flight, [f], 'Flight ' + (f.flight + 1) + (isNum(f.t0) && isNum(f.t1) ? ' · ' + secs(f.t0) + ' to ' + secs(f.t1) : ''));
            });
        });
        return out;
    }

    function filterBaseline(result, source) {
        if (!source) return [];
        var ds = datasetsOf(result), windows = source.windows || [], out = [];
        ((ds && ds.labels) || []).filter(function (q) { return q.log === source.log; }).forEach(function (q) {
            var d = configOf(result,q.dataset), spans = windows.length ? windows : [q];
            spans.forEach(function (f) {
                var t0 = Math.max(q.t0,f.t0), t1 = Math.min(q.t1,f.t1);
                if (!(t1 > t0)) return;
                out.push({ id:q.dataset || null, log:q.log, t0:t0, t1:t1, profile:d ? d.pidProfile : q.pidProfile || 0,
                    values:d && d.values || {}, sources:d && d.sources || {}, assumed:!!q.assumed });
            });
        });
        // Do not present unlabelled flight time as part of a known configuration.
        if (ds) windows.forEach(function(f){
            var cursor=f.t0;
            out.slice().filter(function(q){return q.t1>f.t0 && q.t0<f.t1;}).sort(function(a,b){return a.t0-b.t0;}).forEach(function(q){
                if(q.t0>cursor)out.push({id:null,log:source.log,t0:cursor,t1:q.t0,profile:0,values:{},sources:{}});
                cursor=Math.max(cursor,q.t1);
            });
            if(cursor<f.t1)out.push({id:null,log:source.log,t0:cursor,t1:f.t1,profile:0,values:{},sources:{}});
        });
        var epochs=epochOf(result,source.log);
        out.forEach(function(q){
            var flagged=(epochs && epochs.spans || []).filter(function(s){return hasCause(s) && s.t0<q.t1 && s.t1>q.t0;});
            if(flagged.length)q.stale={text:flagged.map(function(s){return s.text;}).filter(Boolean).join(' '),spans:flagged.map(function(s){return {log:source.log,t0:Math.max(q.t0,s.t0),t1:Math.min(q.t1,s.t1)};})};
        });
        return out.sort(function (a,b) { return a.t0-b.t0; });
    }

    function filterBaselineIds(baseline) {
        return baseline.map(function (q) { return q.id; }).filter(function (id,i,all) { return all.indexOf(id) === i; });
    }

    function filterBaselineHtml(baseline) {
        if (!baseline.length) return '<p class="tuning-muted">The recorded configuration intervals are not available.</p>';
        var ids = filterBaselineIds(baseline), unknown = ids.indexOf(null)>=0, mixed = ids.length > 1 || unknown;
        return '<div class="tuning-ft-baseline' + (mixed ? ' is-mixed' : '') + '"><p><strong>' +
            esc(unknown ? 'Some recorded configuration intervals are unknown.' : mixed ? 'Recorded output includes ' + plural(ids.length,'configuration') + '.' : 'Recorded output: ' + configLabel(ids[0]) + '.') +
            '</strong> The output comes from the configuration active in each interval.</p><details' + (mixed ? ' open' : '') + '><summary>Recorded configurations and time ranges</summary>' +
            '<div class="tuning-table-wrap"><table class="tuning-table"><thead><tr><th>Time in the log</th><th>Recorded configuration</th><th>PID profile</th><th>Value source</th></tr></thead><tbody>' + baseline.map(function (q) {
                return '<tr><td>' + esc(num(+q.t0.toFixed(2)) + ' s to ' + num(+q.t1.toFixed(2)) + ' s') + '</td><td>' + esc(q.id ? configLabel(q.id) : 'Unknown') +
                    staleHtml(q) + '</td><td>' + esc(profileLabel(q.profile || 0)) + '</td><td>' + esc(configSources(q) || 'Unknown') + '</td></tr>';
            }).join('') + '</tbody></table></div></details></div>';
    }

    function filterRecordedValues(row, baseline) {
        var list = baseline.filter(function (q) { return row.scope !== 'profile' || q.profile === row.profile; }), seen = {};
        return list.filter(function (q) { var key = q.id || 'unknown'; if (seen[key]) return false; seen[key] = true; return true; }).map(function (q) {
            var key = row.name, values = q.values || {}, value = Object.prototype.hasOwnProperty.call(values,key) ? values[key] : null;
            // Dataset arrays are stored by element and filter enums as numbers.
            // Use the replay's schema to compare their public CLI values.
            if (value == null && row.count) {
                var array = Array.from({length:row.count},function(_,i){return values[key+'['+i+']'];});
                if (array.every(function(v){return v != null;})) value=array.join(',');
            }
            if (/^gyro_lpf[12]_type$/.test(key) && isNum(value) && row.choices) value=row.choices[value] || null;
            return { id:q.id, value:value };
        });
    }

    function filterValueText(value) { return value == null ? 'Unknown' : typeof value === 'boolean' ? value ? 'ON' : 'OFF' : String(value); }

    function filterRecordedHtml(row, baseline) {
        var values = filterRecordedValues(row,baseline);
        if (!values.length) return esc(filterValueText(row.from));
        if (values.every(function (v) { return String(v.value) === String(values[0].value); })) return esc(filterValueText(values[0].value));
        return values.map(function (v) { return '<span class="tuning-ft-recorded-value">' + esc((v.id || 'Unknown') + ': ' + filterValueText(v.value)) + '</span>'; }).join('');
    }

    var FT = {
        title: "Filter values from the flight logs",
        about: "The app uses a model of the gyro filters of the firmware. It calculates gyro samples between the recorded samples. It uses the recorded gyro and PID signals. " +
            "Then the app tries other filter values. It finds the values that give the smallest vibration in the PID output, with a small increase of the time delay.",
        start: "Autotune",
        again: "Autotune again",
        running: "The app calculates the filter values. Wait for the result.",
        canceled: "You canceled the analysis of the filter values.",
        failed: "The analysis of the filter values stopped because of an error.",
        noFlight: "The file has no flight log. Thus, the app cannot calculate filter values.",
        stale: 'This result is for different flights. To use the values that you selected, click "Autotune".',
        staleCli: 'This result is for different flights or a different CLI dump. To use the values that you selected, click "Autotune".', // with a CLI dump now or in the result
        other: "This result is for a different file.",
        exportNote: 'The "Export" tab has these commands. The app selects them first.',
        unknownProfile: "The PID profile of some logs is unknown. Thus, the app gives no CLI text for the cutoffs of that PID profile.",
        model: "Model check",
        modelNote: function (rules) {
            var r = rules || {}, line = isNum(r.lineDb) ? num(r.lineDb) : "1", band = isNum(r.bandDb) ? num(r.bandDb) : "1", delay = isNum(r.delayMs) ? num(r.delayMs) : "0.3";
            return "The app applies the filter values of the log to the calculated gyro samples. It compares the output with the recorded gyroADC signals. " +
                "The error must be " + line + " dB or less at the gyro lines, " + band + " dB or less in each band and " + delay + " ms or less in the time delay.";
        },
        validation: "Test on each flight",
        plotNote: "Show the measurement",
        all: "Show all the filter results"
    };

    // "decrease of 4.9 ± 0.51 dB", "increase of 0.2 ± 0.1 dB"
    function dbChange(v, se) {
        if (!isNum(v)) return "";
        return (v <= 0 ? "decrease of " : "increase of ") + valueSe(Math.abs(v), se, "dB");
    }

    // "Log 6" for a fold unit "log 5" (filter_tune.cjs numbers the logs from 0); a period of flight as it is
    function unitText(u) {
        var m = /^log (\d+)$/.exec(String(u || ""));
        return m ? "Log " + (+m[1] + 1) : cap(oneLine(u));
    }

    // The source of a "from" value of a row: the log header or the CLI dump
    function ftSource(src) {
        return src === "header" ? "Log header" : src === "cli" ? "CLI dump" : src ? String(src) : "";
    }

    // The CLI recommendations of a calculation for the export (SPEC2 D11): advice.cjs recommendations of the result when the
    // worker gives them, else one for the global values (with the `feature` lines) and one for each PID profile section. The
    // changes go in together (group "FT:filters"): the model calculated the decrease for all of them
    function filterRecs(res) {
        if (!res || typeof res !== "object") return [];
        if (Array.isArray(res.recommendations)) return res.recommendations.filter(function (x) { return x && typeof x === "object" && typeof x.id === "string"; })
            .map(function (x) { return Object.assign({}, x, { filterSearch: true }); });
        var rec = res.recommended;
        if (!rec || rec.status !== "recommended" || !Array.isArray(rec.cli) || !rec.cli.length) return [];
        var groups = [{ scope: "global", index: null, lines: [] }];
        rec.cli.map(String).forEach(function (l) {
            var m = /^profile (\d+)$/.exec(l.trim());
            if (m) groups.push({ scope: "profile", index: +m[1], lines: [l.trim()] });
            else groups[groups.length - 1].lines.push(l.trim());
        });
        groups = groups.filter(function (g) { return g.scope === "global" ? g.lines.length > 0 : g.lines.length > 1; });
        var rows = Array.isArray(rec.rows) ? rec.rows : [], p = rec.predicted || {};
        return groups.map(function (g) {
            var from = {}, src = {};
            rows.forEach(function (q) {
                if (!q || !q.name || q.from === null || q.from === undefined || /^feature /.test(q.name)) return;
                if (g.scope === "global" ? q.scope !== "profile" : q.scope === "profile" && q.profile === g.index + 1) {
                    from[q.name] = q.from;
                    src[q.name] = q.source === "cli" ? "CLI dump" : "log header";
                }
            });
            return { id: g.scope === "global" ? "FT:global" : "FT:profile" + g.index, area: "filters", node: "filters", severity: "action", filterSearch: true,
                title: g.scope === "global" ? "Set the gyro filter values that the app found" : "Set the cutoffs of " + profileLabel(g.index + 1) + " that the app found",
                parameter: null, scope: g.scope, cliProfile: g.scope === "profile" ? g.index : null, profile: g.scope === "profile" ? g.index + 1 : null,
                cli: g.lines, fromSets: from, fromSources: src, evidence: [], blockedBy: [], caveats: [], confidence: "predicted",
                group: groups.length > 1 ? "FT:filters" : null, groupSize: groups.length,
                rule: "The model of the gyro filters calculates a " + dbChange(p.totalDb, p.se) + " of the vibration in the PID output. The decrease must be more than 2 SE.",
                text: res.text && typeof res.text.recommendation === "string" ? res.text.recommendation : "" };
        });
    }

    // The table of the model check: one row for each log and axis
    function parityHtml(model) {
        var list = model && Array.isArray(model.parity) ? model.parity.filter(function (p) { return p && p.axes; }) : [];
        var errors = model && model.coverage;
        if (!list.length) return '<p class="tuning-muted">The result has no model check.</p>';
        var rows = [], reconstructionRows = [];
        list.forEach(function (p) {
            AXES.forEach(function (ax) {
                var a = p.axes[ax];
                if (!a) return;
                if (a.reconstruction) reconstructionRows.push('<tr><td>' + esc('Log ' + logLabel(p.log)) + '</td><td>' + esc(ax) + '</td><td>' + esc(num(a.reconstruction.interpolationRmsDegS) + ' deg/s') + '</td><td>' + esc(num(a.reconstruction.withheldRmsDegS) + ' deg/s') + '</td><td>' + esc(String(a.reconstruction.samples)) + '</td></tr>');
                rows.push("<tr><td>" + esc("Log " + logLabel(p.log)) + "</td><td>" + esc(ax) + '</td><td class="tuning-num">' + esc([isNum(a.medianLineErrorDb) ? num(a.medianLineErrorDb) + " dB" : "", isNum(a.maxLineErrorDb) ? num(a.maxLineErrorDb) + " dB" : ""].filter(Boolean).join(", ")) +
                    '</td><td class="tuning-num">' + esc(isNum(a.maxBandErrorDb) ? num(a.maxBandErrorDb) + " dB" : "") + '</td><td class="tuning-num">' +
                    esc(errors ? (isNum(a.delayErrorMs) ? num(a.delayErrorMs) + " ms" : "Not measured") : isNum(a.delayMeasuredMs) && isNum(a.delayPredictedMs) ? num(a.delayMeasuredMs) + " ms, " + num(a.delayPredictedMs) + " ms" : "") + '</td><td class="tuning-num">' + esc(isNum(a.windows) ? String(a.windows) : "") +
                    "</td><td>" + badge(a.passed ? "Agrees" : "Does not agree", a.passed ? "satisfactory" : "monitor") + "</td></tr>");
            });
        });
        return '<div class="tuning-table-wrap"><table class="tuning-table tuning-ft-parity"><thead><tr><th>Log</th><th>Axis</th><th>Error at the gyro lines (median, maximum)</th><th>Error in the bands (maximum)</th>' +
            "<th>" + (errors ? "Time delay error" : "Time delay (log, model)") + "</th><th>Windows</th><th>Result</th></tr></thead><tbody>" + rows.join("") + "</tbody></table></div>" +
            (reconstructionRows.length ? '<p>These gyro outputs are not in the sample fit. The PID response comes from the recorded values or a different fit.</p><div class="tuning-table-wrap"><table class="tuning-table tuning-ft-reconstruction"><thead><tr><th>Log</th><th>Axis</th><th>Error with raw gyro only (RMS)</th><th>Error from replay (RMS)</th><th>Samples</th></tr></thead><tbody>' + reconstructionRows.join('') + '</tbody></table></div>' : '');
    }

    // A text of the worker in paragraphs (a line feed between two): each paragraph escaped, the names in backticks in code font
    function ftParas(text, cls) {
        return String(text || "").split(/\n+/).map(oneLine).filter(Boolean).map(function (x) { return '<p class="' + (cls || "tuning-ft-text") + '">' + mdCode(x) + "</p>"; }).join("");
    }

    // The recommendation of a calculation in STE: the worker's text, else sentences from the numbers
    function ftRecText(res) {
        var t = res.text || {}, rec = res.recommended || {}, p = rec.predicted || {};
        if (typeof t.recommendation === "string" && t.recommendation.trim()) return mdCode(t.recommendation);
        if (rec.status === "no flight log") return esc(FT.noFlight);
        if (rec.status !== "recommended") return esc("The app does not recommend a change of the filter values.");
        return esc("Set the filter values of the table. " + (isNum(p.totalDb) ? "The model calculates a " + dbChange(p.totalDb, p.se) + " of the vibration in the PID output." : ""));
    }

    // The change of the time delay in STE
    function ftDelayText(res) {
        var t = res.text || {}, d = res.recommended && res.recommended.delay;
        if (typeof t.delay === "string" && t.delay.trim()) return mdCode(t.delay);
        if (!d || typeof d !== "object") return "";
        var at = d.at || {}, where = [at.axis, isNum(at.profile) ? profileLabel(at.profile) : "", isNum(at.hz) ? "at " + num(at.hz) + " Hz" : ""].filter(Boolean).join(", ");
        return esc([isNum(d.maxAddMs) ? "The largest increase of the time delay is " + num(d.maxAddMs) + " ms" + (where ? " (" + where + ")" : "") + "." : "",
            isNum(d.f11BaseMs) && isNum(d.f11MaxMs) ? "The time delay of the gyro filters (check F11) changes from " + num(d.f11BaseMs) + " ms to " + num(d.f11MaxMs) + " ms." : ""].filter(Boolean).join(" "));
    }

    // The test on each flight (leave one flight out) in STE and as a table
    function ftValidationHtml(res) {
        var t = res.text || {}, v = res.recommended && res.recommended.validation && res.recommended.validation.leaveOneOut, folds = v && Array.isArray(v.folds) ? v.folds : [];
        if (!folds.length && !(typeof t.validation === "string" && t.validation)) return "";
        var block = v && v.unit === "block", less = folds.filter(function (q) { return isNum(q.heldOutDb) && q.heldOutDb < 0; }).length;
        var text = typeof t.validation === "string" && t.validation.trim() ? mdCode(t.validation) :
            esc((block ? "The app calculated the values again for each period of flight, without the data of that period. " : "The app calculated the values again for each flight log, without the data of that log. ") +
                "Then it calculated the change of the vibration in the data that it did not use. The vibration decreased in " + less + " of " + folds.length + (block ? " periods." : " logs.") +
                (v && isNum(v.heldOutMeanDb) ? " The mean change is a " + dbChange(v.heldOutMeanDb, v.heldOutSe) + "." : "") +
                (v && isNum(v.sameAsFull) ? " In " + v.sameAsFull + " of " + folds.length + " tests, the app found the same values." : ""));
        return '<h6 class="tuning-h">' + esc(res.version === 2 ? "Test on different flight periods" : FT.validation) + '</h6><p class="tuning-ft-text">' + text + "</p>" + (folds.length ? '<div class="tuning-table-wrap"><table class="tuning-table tuning-ft-folds"><thead><tr><th>' +
            (block ? "Period that the app did not use" : "Log that the app did not use") + "</th><th>Change of the vibration in it</th><th>Same values</th></tr></thead><tbody>" + folds.map(function (q) {
                var same = res.recommended && res.recommended.params && q.chosen ? JSON.stringify(q.chosen) === JSON.stringify(res.recommended.params) : null;
                return "<tr><td>" + esc(unitText(q.unit)) + '</td><td class="tuning-num">' + esc(isNum(q.heldOutDb) ? num(q.heldOutDb) + " dB" : "") + "</td><td>" + esc(same === null ? "" : same ? "Yes" : "No") + "</td></tr>";
            }).join("") + "</tbody></table></div>" : "");
    }

    // The TuningPlot specs of "Show the measurement" of a calculation for one axis: the gyro spectra (gyroRAW, gyroADC as the
    // log records it, the model with the values of the log and with the recommended values) and the gyro noise in the PID output
    function ftPlotSpecs(res, axis, traceIndex) {
        var c = res && res.curves, a = c && c[axis], f = c && c.f;
        if (!a || !isSeries(f)) return [];
        var x = { label: "frequency", unit: "Hz", min: 0 }, cand = isSeries(a.candidate), n = isNum(c.windows) ? " (" + plural(c.windows, "window") + ")" : "";
        var out = [item({ title: "Gyro spectra, " + axis + n, x: x, y: { label: "PSD", log: true },
            series: [line("gyroRAW, before the filters", f, a.raw, C.grey, { width: 1, ftCurve: "raw" }), line("gyroADC, as the log records it", f, a.logged, C[axis], { ftCurve: "old" }),
                line("gyroADC from the model, with the values of the log", f, a.predicted, C.blue, { dash: [4, 3], ftCurve: "replay" }),
                line("gyroADC from the model, with the recommended values", f, cand ? a.candidate : null, C.green, { ftCurve: "new" })] }),
            item({ title: "Vibration in the PID output, " + axis + n, x: x, y: { label: "PSD", log: true },
                series: [line("with the values of the log", f, a.pidOut, C.orange, { ftCurve: "replay" }), line("with the recommended values", f, isSeries(a.pidOutCandidate) ? a.pidOutCandidate : null, C.green, { ftCurve: "new" })] })];
        out[0].caption = "The gray curve is gyroRAW. The " + axis + " curve is gyroADC as the log records it. The blue curve is the model with the values of the log" +
            (cand ? ", and the green curve is the model with the recommended values." : ".");
        out[1].caption = "The curves show the vibration in the PID output after the gyro filters" + (cand ? ", with the values of the log and with the recommended values." : ", with the values of the log.");
        if (res.version === 2) {
            var names = { raw: 'Raw data', old: 'Previous filter (recorded)', replay: 'Previous filter (replay)', new: 'New filter (calculated)' };
            out.forEach(function (it) {
                if (it.spec) it.spec.series.forEach(function (s) {
                    s.name = names[s.ftCurve];
                    if (s.ftCurve === 'old') s.color = C.blue;
                    if (s.ftCurve === 'replay') s.color = C.orange;
                });
            });
            out[0].caption='The curves compare raw gyro data with the previous and new filter outputs.';
            out[1].caption='The curves compare the vibration from the gyro in P and D.';
            if (res.recommended.status !== "recommended") out.forEach(function (it) {
                it.caption = it.caption.replace(/recommended values/g, "tested values (not confirmed)");
                if (it.spec) it.spec.series.forEach(function (s) { if (s.ftCurve === 'new') s.name = 'New filter (calculated, not confirmed)'; });
            });
            out[1].caption += " Unknown PID profiles use the header values for this plot only.";
        }
        var tr = res.traces && res.traces[traceIndex || 0], ai = AXES.indexOf(axis);
        if (tr && ai >= 0) {
            var tx = { label: "time in the log", unit: "s" }, tested = res.recommended && res.recommended.status === "recommended";
            var prefix = tested ? "New filter (calculated)" : "New filter (calculated, not confirmed)";
            var nativeTrace = tr.native || tr;
            out.unshift(item({ title: "Replayed gyro signals, " + axis, x: tx, y: { label: "gyro rate", unit: "deg/s" },
                series: [line("Raw data", tr.t, tr.raw[ai], C.grey, { ftCurve: "raw" }), line("Previous filter (recorded)", tr.t, tr.logged[ai], C.blue, { ftCurve: "old" }),
                    line("Previous filter (replay)", nativeTrace.t, nativeTrace.baseline[ai], C.orange, { dash: [4, 3], ftCurve: "replay" }), line(prefix, nativeTrace.t, nativeTrace.candidate[ai], C.green, { ftCurve: "new" })] }));
            out[0].caption = "These signals use the same recorded input. Move the cursor in the plot to read values.";
            out.push(item({ title: "Replayed P and D from the gyro, " + axis, x: tx, y: { label: "PID output", unit: "permille" },
                series: [line("Recorded configuration", nativeTrace.t, nativeTrace.pidBaseline[ai], C.orange), line(prefix, nativeTrace.t, nativeTrace.pidCandidate[ai], C.green)] }));
            out[out.length - 1].caption = "This plot shows the part of P and D that comes from the gyro. It does not calculate the helicopter response.";
            if (tr.pidKnown === false) out[out.length - 1].caption += " The PID values are unknown. This plot uses the header values.";
        }
        return out;
    }

    // HTML checkboxes control the comparison curves. Keep the complete spec for updates without rebuilding the pane.
    function ftComparisonSpec(spec, curves) {
        var selected = ['raw','old','new'].some(function (key) { return !curves || curves[key] !== false; });
        return Object.assign({}, spec, { legend: false, emptyText: selected ? 'No data for the selected curves.' : 'Select a curve to show.', series: spec.series.filter(function (s) {
            return s.ftCurve !== 'replay' && (!curves || curves[s.ftCurve] !== false);
        }) });
    }

    // The same check rows are shown before a candidate exists and after replay.
    // Prior violations keep their mark even when the candidate clears them.
    function filterChecklistRows(res, recorded) {
        var check = res && res.checklist;
        function recordedRow(f) {
            var status = findingStatus(f), before = {status:STATUS[status] || status, issues:status === 'problem' || status === 'error' ? 1 : 0, findings:[f]};
            return {id:f.id,title:f.noun || '',log:f.log,configuration:f.dataset,profile:profileNo(f),axis:findingAxis(f),before:before,
                after:check && f.id === 'F7' ? before : null, outcome:check && f.id === 'F7' ? 'Unchanged input' : 'Not replayed',
                detail:f.id === 'F7' ? 'The replay uses the same recorded vibration source.' : ''};
        }
        var physical = (recorded || []).filter(function(f){return f.id === 'F7';});
        var rows = check ? (check.rows || []).filter(function(q){return q.id !== 'F7' || !physical.length;}).concat(physical.map(recordedRow)) : (recorded || []).map(recordedRow);
        return rows.slice().sort(function(a,b){return Number(!!(b.before && b.before.issues)) - Number(!!(a.before && a.before.issues)) ||
            Number(b.outcome === 'New issue') - Number(a.outcome === 'New issue');});
    }

    function filterTabStates(model) {
        var res = model.result, check = res && res.checklist, states;
        var current = model.state === 'done' && !model.stale && !model.dirty;
        if (current && check && check.confirmed !== false) {
            states = filterChecklistRows(res, model.recordedChecks).reduce(function (out, row) {
                // An unavailable replay does not clear a recorded problem. Physical
                // vibration keeps the recorded result, as in the visible checklist.
                var after = row.after, before = row.before;
                if ((!after || row.outcome === 'Not evaluated') && before && before.issues) out.push('problem');
                if (!after) return out.concat('notMeasured');
                if (after.issues) return out.concat('problem');
                var findings = after.findings || [];
                return out.concat(findings.length ? findings.map(findingStatus) :
                    ({Pass: 'satisfactory', Satisfactory: 'satisfactory', Information: 'information', Monitor: 'monitor',
                        'Insufficient data': 'insufficient', 'Not sufficient data': 'insufficient'}[after.status] || 'notMeasured'));
            }, []);
        } else {
            states = (model.recordedChecks || []).map(findingStatus);
            if (current && check && check.confirmed === false) states.push('insufficient');
        }
        if (model.state === 'failed') states.push('error');
        if (model.dirty || model.stale) states.push('monitor');
        return states;
    }

    function filterChecklistHtml(res, recorded, support) {
        var check = res && res.checklist, confirmed = !check || check.confirmed !== false;
        var rows = filterChecklistRows(res, recorded);
        var outcomeLabels = {'Cleared in replay':'Not found in replay',Remains:'Not corrected','New issue':'New problem',Unchanged:'No change','Not evaluated':'Not measured','Unchanged input':'Same input'};
        var statusLabels = {Issue:'Problem',Pass:'Satisfactory','Not evaluated':'Not measured','Insufficient data':'Not sufficient data'};
        var html = '<section class="tuning-ft-checklist"><h5 class="tuning-h">Filter checks</h5>' +
            '<p class="tuning-muted">The recorded data and replay use the same checks and limits. Previous problems are shown first.</p>';
        if (!rows.length) return html + '<p class="tuning-muted">To see the filter checks, load recorded values.</p>' + (support || '') + '</section>';
        if (check && confirmed) {
            var count = function(outcome){return rows.filter(function(q){return q.outcome === outcome;}).length;};
            html += '<p>' + esc(plural(count('Cleared in replay'),'previous problem') + ' not found in replay. ' + plural(count('Remains') + rows.filter(function(q){return q.outcome === 'Unchanged input' && q.before.issues;}).length,'previous problem') + ' not corrected. ' + plural(count('New issue'),'new problem') + '. ' + count('Not evaluated') + ' not measured.') + '</p>';
        }
        if (!confirmed) html += '<p class="tuning-na">The recorded configuration fails the model check. The new results are not confirmed.</p>';
        html += '<div class="tuning-table-wrap"><table class="tuning-table tuning-ft-checks"><thead><tr><th>Check</th><th>Flight data</th><th>Recorded</th><th>New parameters</th><th>Result</th></tr></thead><tbody>';
        rows.forEach(function(q){
            var prior = !!(q.before && q.before.issues), cleared = confirmed && q.outcome === 'Cleared in replay';
            var outcome = !confirmed && q.outcome !== 'Unchanged input' ? 'Not confirmed' : q.outcome;
            function cell(side) {
                var x = q[side], findings = x && x.findings || [];
                return (x ? esc(statusLabels[x.status] || x.status || 'Not measured') + (x.issues ? ' (' + x.issues + ')' : '') : 'Not replayed') +
                    (findings.length ? '<details><summary>Values and rule</summary><div data-ste="quoted">' + findings.map(function(f){
                        return '<p>' + esc(f.summary || f.text || '') + '</p><code>' + esc(f.threshold || '') + '</code>';
                    }).join('') + '</div></details>' : '');
            }
            html += '<tr class="' + [prior ? 'tuning-ft-prior-issue' : '', cleared ? 'tuning-ft-cleared' : '', q.outcome === 'New issue' ? 'tuning-ft-regression' : ''].filter(Boolean).join(' ') + '"><td>' +
                esc(q.id + (q.title ? ': ' + q.title : '')) + (prior ? '<small>' + badge('Previous problem','monitor') + '</small>' : '') + '</td><td>' +
                esc([isNum(q.log) ? 'Log ' + logLabel(q.log) : '',q.configuration ? configLabel(q.configuration) : '',isNum(q.profile) ? profileLabel(q.profile) : '',q.axis].filter(Boolean).join(', ')) +
                (isNum(q.fromS) && isNum(q.toS) ? '<small>' + esc(secs(q.fromS) + ' to ' + secs(q.toS)) + '</small>' : '') + '</td><td>' + cell('before') + '</td><td>' + cell('after') +
                '</td><td>' + badge(outcomeLabels[outcome] || outcome || 'Not measured',cleared ? 'satisfactory' : prior || q.outcome === 'New issue' ? 'monitor' : 'information') +
                (q.detail ? '<p>' + esc(q.detail) + '</p>' : '') + '</td></tr>';
        });
        return html + '</tbody></table></div>' + (support || '') + '</section>';
    }

    function filterParameterChanged(row, value, baseline) {
        var values = filterRecordedValues(row,baseline);
        // Unknown recorded values are retained when unchanged rows are hidden.
        return (values.length ? values : [{value:row.from}]).some(function(v){
            return v.value == null || value == null || String(v.value).replace(/\s/g,'') !== String(value).replace(/\s/g,'');
        });
    }

    function filterWorkspaceHtml(m, env, opts) {
        var res = m.result, rec = res && res.recommended || {}, running = m.state === 'running', dirty = !!m.dirty,
            delay = m.maxAddMs === undefined ? .5 : m.maxAddMs, plots = [], compact = opts.compact,
            baseline = res && res.recordedConfigurations || m.baseline || [], recordedOnly = !!rec.params && !Object.keys(rec.params).length,
            accepted = rec.status === 'recommended';
        function detail(key,label,cls) {
            return '<details class="' + cls + '"' + (opts.openDetails && opts.openDetails[key] ? ' open' : '') + '><summary data-ft-detail="' + key + '">' + label + '</summary>';
        }
        function plot(it,comparison) {
            if (!it || !it.spec) return '<p class="tuning-na">No signal data.</p>';
            var id = env.plotId(); plots.push({id:id,spec:comparison ? ftComparisonSpec(it.spec,opts.curves) : it.spec,filterComparison:comparison ? it.spec : null});
            return '<div class="tuning-ft-plotbox"><div class="tuning-plot"><canvas id="' + id + '" class="tuning-plot-canvas"></canvas></div></div>';
        }
        var html = '<section class="tuning-ft' + (compact ? ' is-compact' : ' tuning-ft-workspace') + '" aria-label="' + esc(FT.title) + '"><div class="tuning-ft-heading"><div><h5 class="tuning-h">Filters</h5>' +
            '<p class="tuning-muted">Autotune calculates the filter parameters. Change the values as necessary. Examine the filter checks and flight signals after replay.</p></div></div>';
        if (m.source) html += compact ? '<p class="tuning-ft-source-title">' + esc(m.source.title) + '</p>' :
            '<div class="tuning-ft-source"><label>Flight data for this tune<select class="form-control tuning-ft-source-select"' + (running ? ' disabled' : '') + '>' +
            options((m.sources || []).map(function(s){return [s.key,s.title];}),m.source.key) + '</select></label></div>';
        if (!compact) html += filterBaselineHtml(baseline);
        html += '<section class="tuning-ft-editor"><div class="tuning-ft-section-head"><h5 class="tuning-h">Filter parameters</h5><div class="tuning-ft-actions">';
        if (running) {
            var frac = isNum(m.fraction) ? Math.max(0,Math.min(1,m.fraction)) : 0;
            html += '<div class="tuning-ft-progress" role="status"><div class="tuning-progress-track"><div class="tuning-progress-bar tuning-ft-bar" style="width:' + (100*frac).toFixed(1) + '%"></div></div><span class="tuning-ft-progress-text">' + esc(m.text || FT.running) + '</span></div><button type="button" class="btn btn-default btn-sm tuning-ft-cancel">Cancel</button>';
        } else html += '<button type="button" class="btn ' + (res ? 'btn-default' : 'btn-primary') + ' btn-sm tuning-ft-start"' + (opts.disabled ? ' disabled' : '') + '>' + (res ? 'Autotune again' : 'Autotune') + '</button>';
        html += '</div></div>';
        if (m.unavailable) return {html:html + '<p class="tuning-na">' + esc(m.unavailable) + '</p></section></section>',plots:plots};
        if (m.state === 'failed') html += notice('error',esc(FT.failed) + ' ' + quoted(esc(m.error && (m.error.detail || m.error.message) || '')));
        if (m.state === 'canceled') html += '<p class="tuning-muted">' + esc(FT.canceled) + '</p>';
        if (m.stale) html += notice('info','The inputs or time delay limit changed. Use autotune, or replay the changed values.');
        if (compact) return {html:html + (res ? '<p>' + ftRecText(res) + '</p>' : '') + '</section><a href="#" class="tuning-tab-link" data-tab="filters">Open filter tuning</a></section>',plots:plots};
        var controls = '<div class="tuning-ft-controls"><label>Maximum added time delay (ms) <input class="tuning-ft-delay" type="number" min="0" max="20" step="0.05" value="' + esc(String(delay)) + '"' + (running ? ' disabled' : '') + '></label>' +
            '<span class="tuning-muted">Default: 0.5 ms. The limit applies to the increase from the recorded configuration at 10–30 Hz.</span></div>';
        html += controls;
        if (!res) return {html:html + '<p class="tuning-muted">Autotune calculates the parameter values. To change the recorded values, load them first.</p><button type="button" class="btn btn-default btn-sm tuning-ft-load"' +
            (opts.disabled || running ? ' disabled' : '') + '>Load recorded values</button></section>' + filterChecklistHtml(null,m.recordedChecks) + '</section>',plots:plots};
        html += '<p>' + badge(accepted ? (res.mode === 'simulation' ? 'Replay checks satisfactory' : 'Values calculated') : 'No recommendation',accepted ? 'satisfactory' : 'monitor') + ' ' + ftRecText(res) + '</p>';
        if (recordedOnly) html += '<p class="tuning-muted">Recorded filter replay. No filter values changed. Each interval uses its recorded configuration.</p>';
        if (!recordedOnly && rec.delay && isNum(rec.delay.maxAddMs)) html += '<p>Added time delay: <strong>' + esc(num(rec.delay.maxAddMs) + ' ms') + '</strong></p>';
        html += '<p class="tuning-ft-draft-note' + (dirty ? '' : ' tuning-hide') + '">Replay the changed values. The plots and checks show the last replay.</p>' +
            '<div class="tuning-ft-section-head"><div class="tuning-ft-actions"><button type="button" class="btn btn-default btn-sm tuning-ft-simulate"' + (running ? ' disabled' : '') + '>Replay values</button>' +
            '<button type="button" class="btn btn-default btn-sm tuning-ft-reset"' + (running ? ' disabled' : '') + '>Use recorded values</button>' +
            '<button type="button" class="btn btn-default btn-sm tuning-ft-restore"' + (running || !m.hasAutotune ? ' disabled' : '') + '>Use autotune values</button></div>' +
            '<label class="tuning-ft-hide-label"><input type="checkbox" class="tuning-ft-hide-unchanged"' + (opts.hideUnchanged ? ' checked' : '') + '> Show changed values only</label></div>' +
            '<div class="tuning-ft-parameter-scroll"><table class="tuning-table tuning-ft-rows"><thead><tr><th>Parameter / PID profile</th><th>Recorded</th><th>New value</th></tr></thead><tbody>';
        var visible = 0;
        (res.parameters || rec.fullRows || []).forEach(function(q){
            var key = q.key || (q.scope === 'profile' ? 'p' + q.profile + ':' : '') + q.name.replace(/^feature /,''),
                edited = m.draft && Object.prototype.hasOwnProperty.call(m.draft,key), value = edited ? m.draft[key] : q.to,
                changed = (!recordedOnly || edited) && filterParameterChanged(q,value,baseline);
            if (opts.hideUnchanged && !changed) return;
            visible++;
            var attr = ' class="tuning-ft-param" data-param="' + esc(key) + '" aria-label="' + esc(q.name + (q.profile ? ' PID profile ' + q.profile : '')) + '"' + (running ? ' disabled' : ''), control;
            if (!q.editable) control = '<code>' + esc(value == null ? 'Unknown' : String(value)) + '</code><small>' + esc(q.reason || 'The replay cannot change this value.') + '</small>';
            else if (q.choices) control = '<select' + attr + '>' + q.choices.map(function(v){return '<option value="' + esc(String(v)) + '"' + (String(v) === String(value) ? ' selected' : '') + '>' + esc(typeof v === 'boolean' ? v ? 'ON' : 'OFF' : v) + '</option>';}).join('') + '</select>';
            else control = '<input' + attr + ' type="' + (q.count ? 'text' : 'number') + '"' + (q.range ? ' min="' + q.range[0] + '" max="' + q.range[1] + '" step="1"' : '') + ' value="' + esc(value == null ? '' : String(value)) + '">' + (q.count ? '<small>Enter ' + q.count + ' values with a comma between values.</small>' : '');
            html += '<tr' + (changed ? ' class="tuning-ft-changed"' : '') + '><td>' + parameterHtml(q.name) + '<small>' + esc(q.scope === 'profile' ? profileLabel(q.profile) : 'All PID profiles') + '</small>' + staleHtml(q) + '</td><td>' + filterRecordedHtml(q,baseline) + '</td><td>' + control + '</td></tr>';
        });
        if (!visible) html += '<tr><td colspan="3" class="tuning-muted">' + (opts.hideUnchanged ? 'No changed values. Clear "Show changed values only" to show all parameters.' : 'No filter parameters are available.') + '</td></tr>';
        html += '</tbody></table></div><div class="tuning-ft-actions"><button type="button" class="btn btn-default btn-sm tuning-ft-save"' + (!res.cliFile || m.stale || dirty || running ? ' disabled' : '') + '>Save filter CLI file</button> <a href="#" class="tuning-tab-link" data-tab="export">Examine CLI changes</a></div></section>';
        // Validation and input coverage support the checklist, rather than
        // presenting another checklist with different apparent criteria.
        var support = detail('diagnostics','Replay model and input coverage','tuning-ft-diagnostics') + '<h6 class="tuning-h">Model check</h6><p class="tuning-muted">' +
            esc(FT.modelNote(res.model && res.model.rules)) + '</p>' + parityHtml(res.model) + ftValidationHtml(res);
        if (res.bench && res.bench.length) support += '<ul>' + res.bench.map(function(q){return '<li>' + esc('Log ' + logLabel(q.log) + ': ' + q.reason) + '</li>';}).join('') + '</ul>';
        if (res.model && res.model.coverage) support += '<p>' + res.model.coverage.map(function(c){return esc('Log ' + logLabel(c.log) + ': gyro ' + c.gyroHz + ' Hz, filters ' + c.filterHz + ' Hz, recorded samples ' + c.logHz + ' Hz.');}).join(' ') + '</p>';
        support += '<h6>Filter analysis coverage</h6><div class="tuning-table-wrap"><table class="tuning-table"><thead><tr><th>Parameters</th><th>Result</th><th>Inputs and limits</th></tr></thead><tbody>' +
            (res.capabilities || []).map(function(c){return '<tr><td><code>' + esc(c.names) + '</code></td><td>' + esc(c.status) + '</td><td>' + esc(c.detail) + '</td></tr>';}).join('') + '</tbody></table></div></details>';
        html += filterChecklistHtml(res,m.recordedChecks,support);
        var traceIndex = opts.trace >= 0 && res.traces && opts.trace < res.traces.length ? opts.trace : 0, tr = res.traces && res.traces[traceIndex];
        // Never label a flight-wide average as the spectrum of one time window.
        var local = tr && tr.spectrum, pairs = AXES.map(function(axis){
            var specs = ftPlotSpecs(local ? Object.assign({},res,{curves:local}) : res,axis,traceIndex);
            if (recordedOnly) specs.forEach(function(it){if(it.spec) it.spec.series = it.spec.series.filter(function(s){return s.ftCurve !== 'new';});});
            return {axis:axis,time:specs.find(function(it){return it.spec && /^Replayed gyro signals/.test(it.spec.title);}),
                frequency:specs.find(function(it){return it.spec && /^Gyro spectra/.test(it.spec.title);})};
        });
        html += '<section class="tuning-ft-signals"><h5 class="tuning-h">Gyro signals</h5>';
        if (tr) html += '<label>Flight interval <select class="tuning-ft-trace">' + res.traces.map(function(t,i){return '<option value="' + i + '"' + (i === traceIndex ? ' selected' : '') + '>' +
            esc('Log ' + logLabel(t.log) + ', ' + (t.configuration ? configLabel(t.configuration) : 'configuration unknown') + ', ' + profileLabel(t.profile) + ', ' + t.t[0].toFixed(3) + ' to ' + t.t[t.t.length-1].toFixed(3) + ' s') + '</option>';}).join('') + '</select></label>';
        html += '<p class="tuning-muted">' + (local ? 'Each spectrum uses the selected time interval at the recorded sample rate.' : 'The spectra average all flight windows used by the replay. The time plots show the selected interval only.') + '</p>' +
            '<p class="tuning-muted">Raw data is recorded gyroRAW. Previous filter is recorded gyroADC. New filter is calculated from the same flight input.</p>' +
            (accepted || recordedOnly ? '' : '<p class="tuning-na">The new filter result is not confirmed.</p>') +
            '<fieldset class="tuning-ft-curves"><legend>Show curves on all axes</legend>' + [{key:'raw',name:'Raw data',color:C.grey},{key:'old',name:'Previous filter (recorded)',color:C.blue},{key:'new',name:'New filter (calculated)',color:C.green}].map(function(q){
                var available = pairs.some(function(p){return [p.time,p.frequency].some(function(it){return it && it.spec.series.some(function(s){return s.ftCurve === q.key;});});});
                return '<label><input type="checkbox" class="tuning-ft-curve" data-ft-curve="' + q.key + '"' + (available && (!opts.curves || opts.curves[q.key] !== false) ? ' checked' : '') + (available ? '' : ' disabled') +
                    '><span class="tuning-ft-curve-swatch" style="border-color:' + q.color + '" aria-hidden="true"></span>' + q.name + (available ? '' : ' (no data)') + '</label>';
            }).join('') + '</fieldset>';
        pairs.forEach(function(p){
            html += '<section class="tuning-ft-axis-pair" aria-label="' + cap(p.axis) + ' gyro signals"><h6>' + cap(p.axis) + '</h6><div class="tuning-ft-plot-pair">';
            if (p.time) p.time.spec = Object.assign({},p.time.spec,{title:'Gyro signals, ' + p.axis});
            if (p.frequency) p.frequency.spec = Object.assign({},p.frequency.spec,{title:(local ? 'Spectrum of selected interval, ' : 'Flight spectrum, ') + p.axis});
            html += plot(p.time,true) + plot(p.frequency,true) + '</div></section>';
        });
        html += detail('replay','Recorded output and model replay','tuning-ft-details') + '<p>These curves use the previous filter values. Compare the recorded output with the replay.</p>';
        pairs.forEach(function(p){
            html += '<div class="tuning-ft-plot-pair">';
            [p.time,p.frequency].forEach(function(it){
                html += plot(it ? {spec:Object.assign({},it.spec,{title:'Previous filter replay, ' + p.axis + (it === p.time ? ' (time)' : ' (frequency)'),series:it.spec.series.filter(function(s){return s.ftCurve === 'old' || s.ftCurve === 'replay';})})} : null);
            });
            html += '</div>';
        });
        return {html:html + '</details></section></section>',plots:plots};
    }

    // The filter calculation as HTML. m: { state: "none" | "running" | "done" | "failed" | "canceled", fraction, text (the
    // worker's progress), ms, result, error: { message, detail }, stale (true: the result is for other settings) }. opts: {
    // compact (the side panel of the Filters step), axis (of the plots), plot (true: "Show the measurement" is open) }.
    // Returns { html, plots: [{ id, spec }] }
    function filterSearchHtml(m, env, opts) {
        opts = opts || {};
        m = m || { state: "none" };
        if (m.unavailable) return filterWorkspaceHtml(m, env, Object.assign({}, opts, {disabled:true}));
        if (!m.result || m.result.version === 2) return filterWorkspaceHtml(m, env, opts);
        var res = m.result, rec = res && res.recommended || {}, plots = [], html = '<section class="tuning-ft' + (opts.compact ? " is-compact" : "") + '" aria-label="' + esc(FT.title) + '">' +
            '<h5 class="tuning-h">' + esc(FT.title) + "</h5>";
        if (!res || !opts.compact) html += '<p class="tuning-muted">' + esc(FT.about) + "</p>";
        html += '<div class="tuning-ft-actions">';
        if (m.state === "running") {
            var frac = isNum(m.fraction) ? Math.max(0, Math.min(1, m.fraction)) : null;
            html += '<div class="tuning-ft-progress"><div class="tuning-progress-track"><div class="tuning-progress-bar tuning-ft-bar" style="width: ' + (frac === null ? 100 : frac * 100).toFixed(1) + '%"></div></div>' +
                '<span class="tuning-ft-progress-text">' + esc((m.text ? oneLine(m.text) : FT.running) + (frac !== null ? " (" + Math.round(frac * 100) + " %)" : "")) + "</span></div>" +
                '<button type="button" class="btn btn-default btn-sm tuning-ft-cancel">Cancel</button>';
        } else {
            html += '<button type="button" class="btn ' + (res ? "btn-default" : "btn-primary") + ' btn-sm tuning-ft-start"' + (opts.disabled ? " disabled" : "") + ">" + esc(res && !m.stale ? FT.again : FT.start) + "</button>";
        }
        html += "</div>";
        if (m.state === "canceled") html += '<p class="tuning-muted">' + esc(FT.canceled) + "</p>";
        if (m.state === "failed") html += notice("error", esc(FT.failed) + (m.error && (m.error.detail || m.error.message) ? " " + quoted(esc(oneLine(m.error.detail || m.error.message))) : ""));
        if (!res) return { html: html + "</section>", plots: plots };
        if (m.stale) html += notice("info", esc(m.other ? FT.other : m.cli ? FT.staleCli : FT.stale));
        // a change: the action of the worker's recommendations (advice.cjs filterRecommendations: the model agrees with every flight
        // log), else a recommended set with CLI text. A gate of the Filters step holds it (blockedBy): no CLI text
        var recs = Array.isArray(res.recommendations) ? res.recommendations.filter(function (x) { return x && typeof x === "object"; }) : null;
        var acts = recs ? recs.filter(function (x) { return x.severity === "action"; }) : null, blocked = acts && acts.some(isBlocked);
        var good = acts ? acts.length > 0 : rec.status === "recommended" && Array.isArray(rec.cli) && rec.cli.length > 0, p = rec.predicted || {}, t = res.text || {};
        var lines = acts ? [].concat.apply([], acts.map(function (x) { return Array.isArray(x.cli) ? x.cli.map(String) : []; })) : good ? rec.cli : [];
        var noResult = res.version === 2 && !good;
        html += '<div class="tuning-ft-result st-' + (good ? "problem" : noResult ? "monitor" : "satisfactory") + '"><div class="tuning-ft-head">' + badge(good ? "Recommendation" : noResult ? "No recommendation" : "No change", good ? (blocked ? "monitor" : "problem") : noResult ? "monitor" : "satisfactory") +
            (blocked ? " " + badge("Blocked", "blocked") : "") + "</div>" +
            (typeof t.summary === "string" && t.summary.trim() ? ftParas(t.summary, "tuning-ft-summary") : "") +
            (typeof t.recommendation === "string" && t.recommendation.trim() ? ftParas(t.recommendation) : '<p class="tuning-ft-text">' + ftRecText(res) + "</p>");
        var why = Array.isArray(t.why) ? t.why.filter(function (x) { return typeof x === "string" && x.trim(); }) : null;
        if (!good && why && why.length && !(typeof t.recommendation === "string" && t.recommendation.trim())) {
            html += '<ul class="tuning-ft-reasons">' + why.map(function (x) { return "<li>" + mdCode(x) + "</li>"; }).join("") + "</ul>";
        } else if (!good && !why && Array.isArray(rec.reasons) && rec.reasons.length && !(res.text && res.text.recommendation)) {
            html += '<ul class="tuning-ft-reasons">' + rec.reasons.map(function (x) { return "<li>" + quoted(esc(oneLine(x))) + "</li>"; }).join("") + "</ul>";
        }
        // r.stale of the recommendations of the search (js/tuning_worker.js filterStale): the parts of the flight logs that it used, in
        // which the values are possibly not the values of the log header (CLAUDE.md "Values that are possibly not current"), once per text
        var said = [];
        (recs || []).filter(staleOf).forEach(function (x) { var k = oneLine(staleOf(x).text); if (said.indexOf(k) < 0) { said.push(k); html += staleRecHtml(x); } });
        if (blocked) {
            var by = [];
            acts.forEach(function (x) { (x.blockedBy || []).forEach(function (b) { if (by.indexOf(b) < 0) by.push(b); }); });
            html += notice("warn", esc("A step before the filters in the tuning sequence has a problem. Thus, the change has no CLI text until you correct it: ") +
                by.map(function (b) { return blockedItem(b, opts.graph || null); }).join(", ") + ".");
        }
        var axes = Array.isArray(p.axes) ? p.axes.filter(function (q) { return q && q.axis && isNum(q.db); }) : [];
        if (axes.length && !opts.compact) { // the side panel is narrow: the tables only in the Filters tab
            html += '<div class="tuning-table-wrap"><table class="tuning-table tuning-ft-axes"><thead><tr><th>Axis</th><th>' + (res.version === 2 ? "Change of gyro vibration (replay)" : "Change of the vibration in the PID output (model)") + '</th></tr></thead><tbody>' +
                axes.map(function (q) { return "<tr><td>" + esc(q.axis) + '</td><td class="tuning-num">' + esc(cap(dbChange(q.db, q.se))) + "</td></tr>"; }).join("") +
                (isNum(p.totalDb) ? '<tr class="tuning-ft-total"><td>' + (res.version === 2 ? "Analysis result (P and D where known)" : "All axes") + '</td><td class="tuning-num">' + esc(cap(dbChange(p.totalDb, p.se))) + "</td></tr>" : "") + "</tbody></table></div>";
        }
        if (typeof t.delay === "string" && t.delay.trim()) html += ftParas(t.delay);
        else if (ftDelayText(res)) html += '<p class="tuning-ft-text">' + ftDelayText(res) + "</p>";
        var rows = Array.isArray(rec.fullRows) ? rec.fullRows : Array.isArray(rec.rows) ? rec.rows.filter(function (q) { return q && q.name; }) : [];
        if ((good || res.version === 2) && rows.length && !opts.compact) {
            html += '<h6 class="tuning-h">' + (good ? "Complete filter configuration" : "Tested filter configuration (not confirmed)") + '</h6>';
            html += '<div class="tuning-table-wrap"><table class="tuning-table tuning-ft-rows"><thead><tr><th>Parameter</th><th>PID profile</th><th>From</th><th>To</th><th>Source of the value</th></tr></thead><tbody>' +
                rows.map(function (q) {
                    return "<tr><td>" + parameterHtml(q.name) + "</td><td>" + esc(q.scope === "profile" ? profileLabel(isNum(q.profile) ? q.profile : 0) : "All PID profiles") + "</td><td><code>" + esc(q.from === null || q.from === undefined ? "?" : String(q.from)) +
                        "</code></td><td><code>" + esc(String(q.to)) + "</code></td><td>" + esc(ftSource(q.source)) + staleHtml(q) + "</td></tr>";
                }).join("") + "</tbody></table></div>";
        }
        if (good && lines.length) {
            html += cliBlock(lines.join("\n"), env) + '<p class="tuning-muted">' + esc(FT.exportNote) + "</p>";
            if (Array.isArray(rec.unknownProfiles) && rec.unknownProfiles.length && !t.recommendation) html += '<p class="tuning-muted">' + esc(FT.unknownProfile) + "</p>";
        }
        html += "</div>";
        if (res.version === 2) {
            html += '<button type="button" class="btn btn-primary btn-sm tuning-ft-save"' + (!res.cliFile || m.stale ? ' disabled' : '') + '>Save filter CLI file</button>';
            html += '<p class="tuning-muted">The CLI file contains the complete filter configuration from the analysis. Save the configuration of your helicopter before you load this file.</p>';
            if (res.model.reconstructed) html += '<p class="tuning-muted">The app calculates gyro samples from the recorded gyro and PID signals. The sample fit does not use 1 in 5 gyro outputs. The last replay uses each log from its start.</p>';
            if (res.model.coverage) html += '<p class="tuning-muted">' + res.model.coverage.map(function(c) { return esc('Log ' + logLabel(c.log) + ': gyro ' + c.gyroHz + ' Hz, filters ' + c.filterHz + ' Hz, recorded samples ' + c.logHz + ' Hz.'); }).join(' ') + '</p>';
            if (!opts.compact && res.capabilities) html += '<details class="tuning-ft-coverage"><summary>Filter analysis coverage</summary><div class="tuning-table-wrap"><table class="tuning-table"><thead><tr><th>Parameters</th><th>Result</th><th>Inputs and limits</th></tr></thead><tbody>' +
                res.capabilities.map(function (c) { return '<tr><td><code>' + esc(c.names) + '</code></td><td>' + esc(c.status) + '</td><td>' + esc(c.detail) + '</td></tr>'; }).join('') + '</tbody></table></div></details>';
        }
        if (opts.compact) return { html: html + '<a href="#" class="tuning-tab-link" data-tab="filters">' + esc(FT.all) + "</a></section>", plots: plots };
        html += '<h6 class="tuning-h">' + esc(FT.model) + "</h6>" + (typeof t.parity === "string" && t.parity.trim() ? ftParas(t.parity) : "") +
            '<p class="tuning-muted">' + esc(FT.modelNote(res.model && res.model.rules)) + "</p>" + parityHtml(res.model) + ftValidationHtml(res);
        var traceIndex = opts.trace >= 0 && res.traces && opts.trace < res.traces.length ? opts.trace : 0;
        var specs = ftPlotSpecs(res, opts.axis || "roll", traceIndex);
        if (specs.length) {
            html += '<div class="tuning-ft-plot-links"><a href="#" class="tuning-ft-plot' + (opts.plot ? " active" : "") + '" title="Show the gyro spectra before and after the filters, from the model and from the log">' + esc(FT.plotNote) + "</a></div>";
            if (opts.plot) {
                if (res.traces && res.traces.length) html += '<label>Flight signals <select class="tuning-ft-trace">' + res.traces.map(function (tr, i) {
                    return '<option value="' + i + '"' + (i === traceIndex ? ' selected' : '') + '>' + esc('Log ' + logLabel(tr.log) + ', ' + profileLabel(tr.profile) + ', ' + num(tr.t[0]) + ' s') + '</option>';
                }).join('') + '</select></label>';
                html += '<div class="tuning-plots tuning-ft-plots">' + specs.map(function (it) {
                    if (it.na) return '<div class="tuning-plot is-na"><div class="tuning-plot-title">' + esc(it.title) + '</div><div class="tuning-na">Not available: ' + esc(it.na) + "</div></div>";
                    var id = env.plotId();
                    plots.push({ id: id, spec: it.spec });
                    return '<div class="tuning-ft-plotbox"><div class="tuning-plot"><canvas id="' + id + '" class="tuning-plot-canvas"></canvas></div><p class="tuning-plot-caption">' + esc(it.caption) + "</p></div>";
                }).join("") + "</div>";
            }
        }
        var notes = (Array.isArray(res.notes) ? res.notes : []).concat(res.model && Array.isArray(res.model.notes) ? res.model.notes : []).filter(function (n) { return typeof n === "string" && n.trim(); });
        if (notes.length) html += '<details class="tuning-toolkit" data-ste="quoted"><summary>Toolkit text (not STE)</summary><ul>' + notes.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") + "</ul></details>";
        return { html: html + "</section>", plots: plots };
    }

    var CONTROL_STEPS = ['governor','cyclic','tail','cycomp','tailcomp'];

    function flightPlanHtml(plan) {
        if (!plan || !plan.maneuvers || !plan.maneuvers.length) return '';
        function list(lines) { return '<ol>' + lines.map(function(t){return '<li>' + esc(t) + '</li>';}).join('') + '</ol>'; }
        return '<section class="tuning-flight-plan" aria-label="Next flight maneuvers"><h5 class="tuning-h">Next flight maneuvers</h5>' +
            '<p><strong>Flight test necessary.</strong></p><p>' + esc(plan.limitation) + '</p><h6>Before the maneuvers</h6>' + list(plan.preparation || []) +
            plan.maneuvers.map(function(q){return '<article><h6>' + esc(profileLabel(q.profile) + ' · ' + q.title) + '</h6>' +
                '<p class="tuning-muted">' + q.parameters.map(parameterHtml).join(', ') + (q.configurations.length ? ' · ' + esc(q.configurations.map(configLabel).join(', ')) : '') + '</p>' +
                '<p>' + esc(q.purpose) + '</p>' + list(q.instructions) + '</article>';}).join('') +
            '<h6>After the flight</h6>' + list(plan.followup || []) + '</section>';
    }

    function controlPairs(result, dataset, step) {
        var check = {governor:/^(G\d+|L1)$/,cyclic:/^(C\d+|L[236])$/,tail:/^(T\d+|L[46])$/,cycomp:/^C\d+$/,tailcomp:/^(T\d+|L4)$/}[step];
        return ((datasetsOf(result) || {}).comparisons || []).filter(function(p){
            return (p.a === dataset || p.b === dataset) && (p.results || []).some(function(q){return check.test(q.check);});
        }).map(function(p){return Object.assign({},p,{results:p.results.filter(function(q){return check.test(q.check);})});});
    }

    function controlWorkspaceHtml(entry, step, view, env, panel) {
        var r = entry.result, d = configOf(r,view.dataset), m = env.controlModel ? env.controlModel(step) : {state:'none'}, res = m.stale ? null : m.result,
            running = m.state === 'running', title = TABS.find(function(t){return t.key === step;}).title,
            graph = graphOf(r), hier = graph && hierFor(r,view.profile,view.dataset), state = nodeState(hier,step),
            fs = findingsAt(r,step,state.entry,env).filter(function(f){return inView(f,view);}).sort(SORTS.severity),
            bad = fs.filter(function(f){return f.id !== 'C7' && /^(problem|monitor|error)$/.test(findingStatus(f));}),
            axis = step === 'tail' || step === 'tailcomp' ? 'yaw' : step === 'cycomp' ? 'pitch' : view.axis === 'yaw' ? 'roll' : view.axis,
            curve = curveOf(r,view), plots = [], pairs = controlPairs(r,view.dataset,step),
            reference = view.ctReference && view.ctReference[step], pair = pairs.find(function(p){return (p.a === view.dataset ? p.b : p.a) === reference;}) || pairs[0],
            rows = res ? res.rows || [] : [];
        if (pair) reference = pair.a === view.dataset ? pair.b : pair.a;
        function detail(key,label,build) {
            return deferredDetails(env, step + ':' + key, label, 'tuning-ct-details', !!(view.ctDetails && view.ctDetails[step+':'+key]), function () {
                var before = plots.length, html = typeof build === 'function' ? build() : build;
                // Plots created later belong to this disclosure, not to the primary pane's plot list.
                return { html: html, plots: env.details ? plots.splice(before) : [] };
            }, ' data-ct-detail="' + step + ':' + key + '"');
        }
        function plot(it) {
            if (!it || !it.spec) return '<p class="tuning-na">' + (it && it.na ? 'Not available: ' + esc(it.na) : 'No recorded curve is available for this selection.') + '</p>';
            var id = env.plotId(); plots.push({id:id,spec:it.spec});
            return '<div class="tuning-plot"><canvas class="tuning-plot-canvas" id="' + id + '"></canvas></div>';
        }
        function evidenceHtml(row) {
            var f = env.findingOf(row) || row, ev = f.evidence, spans = ev && Array.isArray(ev.spans) ? ev.spans : [],
                context = [f.id, isNum(f.log) ? 'Log ' + logLabel(f.log) : '', findingWhere(f,' · ')].filter(Boolean).join(' · '),
                times = spans.filter(function(s){return isNum(s.t0) && isNum(s.t1);}).slice(0,3).map(function(s){return secs(s.t0) + ' to ' + secs(s.t1);}).join(', ');
            return '<div class="tuning-ct-evidence"><p class="tuning-muted">' + esc(context) + '</p>' +
                (f.id === 'C7' || f.module === 'report' ? '<p><strong>Model estimate, not measured</strong></p>' : '') +
                '<p><strong>' + (valueHtml(f) || 'Not measured') + '</strong>' + (limitHtml(f) ? ' · Limit: ' + limitHtml(f) : '') + '</p>' +
                (times ? '<p class="tuning-muted">' + esc(times) + '</p>' : '') + staleHtml(f) +
                '<p class="tuning-ct-links">' + evidenceLinks(f,step,env) + '</p></div>';
        }
        function parameterTable(changes, heading) {
            return '<div class="tuning-table-wrap"><table class="tuning-table tuning-ct-parameters"><thead><tr><th>Parameter</th><th>Recorded</th><th>' + esc(heading) + '</th><th>Difference</th></tr></thead><tbody>' + changes.map(function(q){
                var delta = isNum(q.from) && isNum(q.to) ? q.to-q.from : null;
                return '<tr><td>' + parameterHtml(q.name) + '<small>' + esc(q.source || 'Unknown source') + '</small>' + staleHtml(q) + '</td><td><code>' + esc(String(q.from)) + '</code></td><td><code>' + esc(String(q.to)) + '</code></td><td class="tuning-ct-delta">' + esc(delta === null ? 'Changed' : (delta > 0 ? '+' : '') + num(delta)) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
        }
        var disabled = !d || !d.pidProfile || d.analysed === false || !(configFlight(d) > 0) || m.stale;
        var html = '<section class="tuning-ct tuning-ft-workspace" aria-label="Control loop tuning"><div class="tuning-ft-heading"><div>' +
            '<span class="tuning-ct-eyebrow">CONTROL LOOP AUTOTUNE</span><h5 class="tuning-h">' + esc(title) + '</h5>' +
            '<p class="tuning-muted">Examine the recorded problems and the changes that can help.</p></div><div class="tuning-ft-actions">' +
            (running ? '<span role="status">The app selects a control change.</span><button type="button" class="btn btn-default btn-sm tuning-ct-cancel">Cancel</button>' :
                '<button type="button" class="btn btn-primary btn-sm tuning-ct-start"' + (disabled ? ' disabled' : '') + '>Autotune</button>') + '</div></div>' +
            '<p class="tuning-ct-limit"><strong>Flight test necessary.</strong> The log measures the response with the recorded values. A new flight must test the recommended values.</p>';
        if (disabled) html += '<p class="tuning-na">' + esc(m.stale ? 'The analysis uses different inputs. Start analysis for the selected inputs before autotune.' :
            !d ? 'Select one recorded configuration before autotune.' : !d.pidProfile ? 'The PID profile is unknown. No control change is available.' : 'This configuration has no flight data in the analysis.') + '</p>';
        if (m.state === 'failed') html += notice('error','The control analysis failed. ' + quoted(esc(m.error || '')));
        if (m.state === 'canceled') html += '<p role="status">The control analysis was canceled.</p>';
        html += '<section class="tuning-ct-section"><div class="tuning-ct-section-head"><h5 class="tuning-h">Recorded problems</h5>' +
            badge(bad.length ? plural(bad.length,'result') + ' to examine' : 'Recorded checks',bad.length ? 'monitor' : 'information') + '</div>';
        if (d) html += '<p class="tuning-muted">' + esc(configLabel(d.id) + ' · ' + profileLabel(d.pidProfile)) + '</p>';
        html += bad.length ? '<div class="tuning-ct-problems">' + bad.slice(0,4).map(function(f){
            return '<article class="st-' + cls(findingStatus(f)) + '">' + badge(STATUS[findingStatus(f)],findingStatus(f)) +
                '<h6>' + esc(f.noun || f.id) + '</h6>' + ftParas(summaryOf(f)) + evidenceHtml(f) + '</article>';
        }).join('') + '</div>' : '<p class="tuning-muted">' + (fs.length ? 'No measured control problem is available for this selection. The recorded checks give the data limits.' : 'No recorded checks are available for this selection.') + '</p>';
        if (bad.length > 4) html += '<p class="tuning-muted">' + esc('The first 4 of ' + bad.length + ' results are shown. All recorded checks are available below.') + '</p>';
        var open = view.compare && view.compare.where === step ? env.findingOf(view.compare.key) : null;
        if (open) html += '<div class="tuning-order-compare">' + env.compareHtml(open,step) + '</div>';
        html += '</section><section class="tuning-ct-section tuning-ct-recommendations"><h5 class="tuning-h">Recommended changes</h5>';
        if (res) html += '<p role="status">' + esc(res.reason) + '</p>';
        else if (!disabled && !running) html += '<p class="tuning-muted">Start autotune to select a change from the recorded problems.</p>';
        if (rows.length) html += parameterTable(rows,'Recommended');
        if (res && res.recommendations && res.recommendations.length) {
            html += '<h6 class="tuning-h">Effect of this change</h6><p class="tuning-muted">These are possible effects. The recorded problems stay open until a new flight tests the changes.</p>' +
                res.recommendations.map(function(rec,i){return '<article class="tuning-ct-reason"><h6>' + parameterHtml(rec.parameter) + ' · ' + esc(profileText(rec)) + '</h6>' +
                    ftParas(rec.text || ruleText(rec)) + staleRecHtml(rec) +
                    '<div class="tuning-label">Results for this change</div>' + (rec.evidence || []).map(evidenceHtml).join('') +
                    detail('change-' + i,'Rule and limits',function(){return ftParas(ruleText(rec)) + sourcesHtml(rec) +
                        bulletList((rec.caveats || []).map(function(c){return esc(oneLine(c));}), 'Note', 'is-caveat');}) + '</article>';}).join('');
            html += '<div class="tuning-ft-actions"><button type="button" class="btn btn-default btn-sm tuning-ct-reset">Use recorded values</button><a href="#" class="tuning-tab-link" data-tab="export">Examine CLI changes and flight maneuvers</a></div>' +
                detail('flight','Flight test necessary',flightPlanHtml(res.flightPlan));
        }
        if (res && res.prediction) {
            html += detail('model','Model estimate (not measured)',function(){
                var p = res.prediction;
                return '<div class="tuning-ct-model"><p>' + esc(cap(p.axis) + ' model tracking error: ' + num(p.tracking[0]) + ' to ' + num(p.tracking[1]) + ' deg/s.') +
                    '</p><p>' + esc('Change: ' + valueSe(p.delta,p.se,'deg/s') + '. Band: ' + p.band.join(' to ') + ' Hz.') + '</p><p>This is an estimate for the complete new gain set. It has no flight test.</p></div>';
            });
        }
        if (res && res.deferred && res.deferred.length) html += detail('deferred','Changes that must wait','<ul>' + res.deferred.map(function(q){return '<li><strong>' + mdCode(q.title) + '</strong><p>' + esc(q.reason) + '</p></li>';}).join('') + '</ul>');
        html += '</section><section class="tuning-ct-section"><h5 class="tuning-h">Recorded response</h5>';
        var curves = curvesInView(r,view);
        html += '<div class="tuning-plot-toolbar">';
        if (step === 'cyclic') html += '<div class="btn-group btn-group-xs">' + ['roll','pitch'].map(function(a){return '<button type="button" class="btn btn-default tuning-axis' + (axis === a ? ' active' : '') + '" data-axis="' + a + '">' + cap(a) + '</button>';}).join('') + '</div>';
        if (curves.length > 1) html += '<label>Recorded period <select class="form-control input-sm tuning-segment">' + options(curves.map(function(c,i){return [String(i),'Log ' + logLabel(c.log) + ': ' + secs(c.fromS) + ' to ' + secs((c.fromS||0)+(c.seconds||0))];}),String(curves.indexOf(curve))) + '</select></label>';
        html += (curve ? '<span class="tuning-muted">Log ' + esc(logLabel(curve.log)) + '. Click a time plot to show that time in the log viewer.</span>' : '') + '</div>';
        if (curve) {
            var items = step === 'governor' ? govPlots(curve,axis,r,env) : trackPlots(curve,axis,r,env);
            html += plot(items[0]);
            html += '<p class="tuning-plot-caption">These signals show the response with the recorded parameter values.</p>';
            html += detail('signals','More recorded signals',function () {
                var extra = step === 'tail' ? tailPlots(curve,axis,r,env) : items.slice(1);
                return '<div class="tuning-plots">' + extra.map(plot).join('') + '</div>';
            });
        } else html += plot({na:whyMissing(r,null,step === 'governor' ? 'governor' : step === 'tail' ? 'tail' : 'tracking error')});
        html += '</section>';
        if (pair) html += detail('history','Compare recorded configurations',function(){
            var html = '<label>Other recorded configuration <select class="form-control input-sm tuning-ct-reference">' +
                options(pairs.map(function(p){var id = p.a === view.dataset ? p.b : p.a;return [id,configLabel(id) + ' (recorded)'];}),reference) + '</select></label>' +
                '<p>The two configurations were flown. Different stick inputs and flight conditions can change the result.</p>' + comparisonsHtml({comparisons:[pair]},view.dataset);
            if (curve && step !== 'governor') {
                var otherCurve = curveOf(r,{dataset:reference}), a = curve.track && curve.track[axis] && curve.track[axis].spectrum,
                    b = otherCurve && otherCurve.track && otherCurve.track[axis] && otherCurve.track[axis].spectrum, series = [];
                if (a) series.push(line(configLabel(view.dataset) + ' (recorded)',a.f,a.ratio,C.blue));
                if (b) series.push(line(configLabel(reference) + ' (recorded)',b.f,b.ratio,C.orange));
                html += series.length ? plot(item({title:'Recorded error spectra, ' + axis,x:{label:'frequency',unit:'Hz',log:true,min:.5,max:30},y:{label:'error / setpoint',log:true},series:series})) : plot(null);
                html += '<p class="tuning-plot-caption">These curves show the ratio of recorded error to setpoint. They use different flight periods.</p>';
            }
            var diff = pair.names.map(function(name){var v = pair.values[name], reverse = pair.a !== view.dataset;return {name:name,from:v[reverse?1:0],to:v[reverse?0:1],source:'Recorded configurations'};});
            return html + (diff.length ? parameterTable(diff,configLabel(reference)) : '');
        });
        html += detail('checks','All recorded checks and recommendations',function () {
            var related = PLOT_TABS[step], measurements = related ? (r.findings || []).filter(function(f){
                return inView(f,view) && related.checks.test(String(f.id)) && (!curve || onLog(f,curve.log));
            }).sort(SORTS.severity) : fs;
            var shown = filterResults(measurements,env.filter ? env.filter() : null);
            return (typeof panel === 'function' ? panel() : panel || '') +
                '<h5 class="tuning-h">Recorded measurements</h5>' + filterBar(env.filter ? env.filter() : {},shown,false) +
                findingsTable(shown.list,{where:step},Object.assign({},env,{compareOpen:function(){return false;}})) + stepPicksHtml(entry,step,env);
        }) + '</section>';
        return {html:html,plots:plots};
    }

    function renderTab(key, entry, view, env) {
        var step = TABS.find(function (t) { return t.key === key && t.step; }), out;
        var advice=entry.result.advice;
        if ((step || key==='overview' || key==='recs') && advice && advice.byDataset && advice.byDataset[view.dataset])
            entry=Object.assign({},entry,{result:Object.assign({},entry.result,{advice:Object.assign({},advice,{recommendations:advice.byDataset[view.dataset]})})});
        if (step) {
            var panel = function () {
                var graph = graphOf(entry.result), hier = graph && hierFor(entry.result,view.profile,view.dataset);
                return graph ? nodePanel(entry,graph,hier,key,view,env,null,key) : '';
            };
            if (key !== 'filters') out = controlWorkspaceHtml(entry,key,view,env,panel);
            else if (PLOT_TABS[key]) out = renderPlotTab(key,entry,view,env);
            else if (key === 'cyclic') out = renderPlotTab('curves',entry,view,env);
            else out = {html:'',plots:[]};
        } else if (PLOT_TABS[key]) out = renderPlotTab(key,entry,view,env);
        else out = ({overview:renderOverview,recs:renderRecs,"export":renderExport,checks:renderChecks,configs:renderConfigs,coverage:renderCoverage})[key](entry,view,env);
        var route = TABS.filter(function(t){return !t.auxiliary;}), i = route.findIndex(function(t){return t.key===key;});
        if (i >= 0) out.html += '<nav class="tuning-step-nav">' + (i ? '<a href="#" class="tuning-tab-link" data-tab="' + route[i-1].key + '">Previous: ' + esc(route[i-1].title) + '</a>' : '<span></span>') + (i + 1 < route.length ? '<a href="#" class="tuning-tab-link" data-tab="' + route[i+1].key + '">Next: ' + esc(route[i+1].title) + '</a>' : '') + '</nav>';
        return out;
    }

    // ---------------------------------------------------------------------------------------------
    // "Show the measurement": evidence.plot drawn from the result curves or from a raw span (TuningSnippet + derive)

    // A dotted path into a curve entry ("track.roll.spectrum.ee"): { node, parent, key } or null
    function curvePath(curve, path) {
        var parts = String(path || "").split(".").filter(Boolean), node = curve, parent = null, key = null;
        for (var i = 0; i < parts.length; i++) {
            if (!node || typeof node !== "object" || !(parts[i] in node)) return null;
            parent = node;
            key = parts[i];
            node = node[parts[i]];
        }
        return parts.length ? { node: node, parent: parent, key: key } : null;
    }

    function seriesOf(key, y, extra) {
        return Object.assign({ key: key, name: SERIES_NAME[key] || key, y: y, unit: SERIES_UNIT[key] || null }, extra || {});
    }

    // The series of a curve node: a series against its sibling f or t, or the known series of an object for this kind.
    // { x, xs: "f" | "t", series: [{ key, name, y, unit }], node }
    function curveSeries(res, kind) {
        if (!res) return null;
        var node = res.node, parent = res.parent;
        if (isSeries(node)) {
            var px = parent && isSeries(parent.f) ? "f" : parent && isSeries(parent.t) ? "t" : null;
            return px && parent[px].length === node.length ? { x: parent[px], xs: px, series: [seriesOf(res.key, node)], node: parent } : null;
        }
        if (!node || typeof node !== "object") return null;
        var xs = isSeries(node.f) ? "f" : isSeries(node.t) ? "t" : null;
        if (!xs) return null;
        var x = node[xs], series = (CURVE_PICK[kind] || CURVE_PICK.time).filter(function (k) { return isSeries(node[k]) && node[k].length === x.length; })
            .map(function (k) { return seriesOf(k, node[k]); });
        if (node.u && isSeries(node.u.mean) && node.u.mean.length === x.length) {
            series.unshift(seriesOf("u", node.u.mean, { name: "tail output (mixer[2])", lo: node.u.min, hi: node.u.max, fill: true }));
        }
        return series.length ? { x: x, xs: xs, series: series, node: node } : null;
    }

    // The unit of a raw log column, as the viewer's FlightLog gives it (js/flightlog_fields_presenter.js: servo pulses in µs)
    function fieldUnit(name) {
        var n = String(name);
        if (/^(setpoint\[[0-2]\]|gyroADC\[|gyroRAW\[)/.test(n)) return "deg/s";
        if (/^(mixer|axis[PIDFBO])\[/.test(n)) return "‰";
        if (/^servo\[/.test(n)) return "µs";
        return /^(headspeed|govTarget)$/.test(n) ? "rpm" : null;
    }

    // A derive result as series (js/tuning_worker.js DERIVE): { cols } on the span's t (bandpass, lowpass, pt2, shift);
    // { f, amplitude, psd } (spectrum); { f, gain, phaseDeg, coherence } (transmission)
    function derivedSeries(out, data, kind) {
        if (!out || typeof out !== "object") return null;
        var xs = isSeries(out.f) ? "f" : isSeries(out.t) ? "t" : isSeries(out.x) ? "x" : null, x = xs ? out[xs] : data && data.t;
        if (!isSeries(x)) return null;
        var src, unit = null;
        if (out.cols) src = out.cols;
        else if (out.amplitude || out.psd) { src = out.amplitude || out.psd; unit = out.amplitude ? "field" : null; }
        else if (isSeries(out.gain) || isSeries(out.phaseDeg)) src = kind === "phase" ? { "phase": out.phaseDeg } : { "gain": out.gain, "coherence": out.coherence };
        else src = out.series || out;
        var series = Object.keys(src).filter(function (k) {
            return k !== "f" && k !== "t" && k !== "x" && isSeries(src[k]) && src[k].length === x.length;
        }).map(function (k) {
            return { key: k, name: k, y: src[k], unit: k === "phase" ? "deg" : unit === "field" || out.cols ? fieldUnit(k) : null };
        });
        return series.length ? { x: x, xs: xs === "f" ? "f" : "t", series: series } : null;
    }

    // The PID profile periods of log li in frame seconds (records[].profiles.pid of js/tuning_worker.js; the stretch before
    // the first switch has the profile that the worker found, 0 when it is not known): [{ t0, t1, p }] in time order
    function profilePeriods(r, li) {
        var out = [];
        (r && Array.isArray(r.records) ? r.records : []).forEach(function (rec) {
            if (!rec || rec.log !== li || !rec.profiles || !Array.isArray(rec.profiles.pid)) return;
            rec.profiles.pid.forEach(function (q) {
                var p = q && (typeof q.profile === "string" && /^\d+$/.test(q.profile) ? +q.profile : q.profile);
                if (q && isNum(q.t0) && isNum(q.t1) && q.t1 > q.t0) out.push({ t0: q.t0, t1: q.t1, p: isNum(p) && p > 0 ? p : 0 });
            });
        });
        return out.sort(function (a, b) { return a.t0 - b.t0; });
    }

    // V10: a time plot of the curves of a whole log, for a result of one PID profile, shows the periods of that PID profile
    // only. The x axis goes from the start of its first period to the end of its last, with a margin of 3 % (1 s or more),
    // and the data of the other PID profiles is not drawn. Returns the PID profile, or null when the plot stays as it is
    function onlyProfile(spec, got, f, periods) {
        var p = profileNo(f), xs = got.x, n = xs ? xs.length : 0;
        if (!(p > 0) || !Array.isArray(periods) || n < 2) return null;
        var mine = periods.filter(function (q) { return q.p === p; });
        if (!mine.length || mine.length === periods.length) return null; // one PID profile in the whole log: nothing to remove
        var x0 = mine[0].t0, x1 = mine.reduce(function (m, q) { return Math.max(m, q.t1); }, -Infinity), pad = Math.max(1, 0.03 * (x1 - x0));
        var keep = new Uint8Array(n), j = 0;
        for (var i = 0; i < n; i++) {
            while (j < mine.length && mine[j].t1 < xs[i]) j++;
            keep[i] = j < mine.length && xs[i] >= mine[j].t0 ? 1 : 0;
        }
        function cut(a) {
            if (!isSeries(a) || a.length !== n) return a;
            var out = new Float32Array(n);
            for (var k = 0; k < n; k++) out[k] = keep[k] ? a[k] : NaN;
            return out;
        }
        spec.series.forEach(function (s) {
            if (s.x !== xs && !(isSeries(s.x) && s.x.length === n)) return; // a limit of two points
            s.y = cut(s.y);
            if (s.lo) s.lo = cut(s.lo);
            if (s.hi) s.hi = cut(s.hi);
        });
        spec.x.min = Math.max(xs[0], x0 - pad);
        spec.x.max = Math.min(xs[n - 1], x1 + pad);
        if (!(spec.x.max > spec.x.min)) { delete spec.x.min; delete spec.x.max; }
        return p;
    }

    // The TuningPlot spec of one evidence: the measured series, its reference lines and bands, the spans. The references
    // are in the display unit of the check (evidence.cjs REF); a series of another unit is left out when one of that unit
    // is there, and a limit that no series can show is named in `missed`. opts.periods: the PID profile periods of the log
    // (profilePeriods): a time plot of the curves for a result of one PID profile shows only its periods (`only`)
    function compareSpec(f, ev, got, title, opts) {
        var plot = ev.plot || {}, freq = got.xs === "f", spans = Array.isArray(ev.spans) ? ev.spans : [];
        var refs = (Array.isArray(plot.reference) ? plot.reference : []).filter(function (r) { return r && typeof r === "object"; });
        var series = got.series.slice(), units = {}, missed = [];
        refs.forEach(function (r) { if (r.unit && r.kind !== "vline") units[r.unit] = true; });
        // the tracking error of a time curve, % of the setpoint, for limits in % (C12, T11)
        var node = got.node || {};
        if (units["%"] && !freq && isSeries(node.sp) && isSeries(node.errComp) && !series.some(function (q) { return q.unit === "%"; })) {
            series.push({ key: "ratio", name: "tracking error, % of the setpoint", unit: "%",
                y: Array.prototype.map.call(node.errComp, function (v, i) { var sp = node.sp[i]; return sp > 1 ? 100 * v / sp : NaN; }) });
        }
        var mine = series.filter(function (q) { return q.unit && units[q.unit]; });
        // a time plot of log columns (a raw span, not a curve): the columns of one other unit go on the right axis
        // (servo[3] in µs next to mixer[2] and its limits in ‰)
        var other = mine.length && !got.node ? series.filter(function (q) { return mine.indexOf(q) < 0 && q.unit; }) : [], y2unit = null;
        if (!freq && plot.kind === "time" && other.length && other.every(function (q) { return q.unit === other[0].unit; })) y2unit = other[0].unit;
        if (mine.length) series = mine;
        var shown = {};
        series.forEach(function (q) { if (q.unit) shown[q.unit] = true; });
        if (y2unit) series = series.concat(other.map(function (q) { return Object.assign({}, q, { axis: "y2" }); }));
        var y = plot.kind === "spectrum" ? { label: "amplitude", log: true } : plot.kind === "phase" ? { label: "phase", unit: "deg" } :
            plot.kind === "transmission" ? { label: "ratio", min: 0 } : { label: "value" };
        var only = Object.keys(shown);
        if (!plot.y && only.length === 1 && plot.kind !== "spectrum") y.unit = only[0];
        var spec = {
            title: title, x: Object.assign({}, plot.x || (freq ? { label: "frequency", unit: "Hz" } : { label: "time", unit: "s" })),
            y: Object.assign({}, plot.y || y), series: [], hlines: [], vlines: [], bands: []
        };
        if (y2unit) spec.y2 = { label: "value", unit: y2unit };
        series.forEach(function (s, i) {
            var q = line(s.name, s.x || got.x, s.y, SERIES_COLORS[i % SERIES_COLORS.length],
                s.lo ? { lo: s.lo, hi: s.hi, fill: !!s.fill, width: 1 } : s.points ? { points: true, width: 0 } : null);
            if (s.axis === "y2") { q.axis = "y2"; q.width = 1; }
            spec.series.push(q);
        });
        refs.forEach(function (ref) {
            var label = oneLine(ref.label), fits = !ref.unit || shown[ref.unit] || !only.length;
            if (ref.kind === "hline" && isNum(ref.value) && freq && plot.kind === "phase" && ref.unit === "ms") {
                // a time delay limit on a phase plot: the phase of a pure time delay, -360 f tau
                spec.series.push(line(label || "limit", got.x, Array.prototype.map.call(got.x, function (fq) { return -360 * fq * ref.value / 1000; }), C.limit, { dash: [5, 3], width: 1 }));
            } else if (ref.kind === "hline" && isNum(ref.value)) {
                if (fits) spec.hlines.push({ y: ref.value, color: C.limit, label: label, dash: [5, 3] });
                else missed.push(label);
            } else if (ref.kind === "vline" && isNum(ref.value)) {
                if (freq || ref.unit !== "Hz") spec.vlines.push({ x: ref.value, color: C.limit, label: label, dash: [5, 3] });
                else missed.push(label);
            } else if (ref.kind === "band" && isNum(ref.from) && isNum(ref.to)) {
                if (ref.axis === "y" || (ref.unit && ref.unit !== spec.x.unit)) {
                    if (fits) spec.series.push(line(label || "limit", [got.x[0], got.x[got.x.length - 1]], [(ref.from + ref.to) / 2, (ref.from + ref.to) / 2],
                        "rgba(251,128,114,0.6)", { lo: [ref.from, ref.from], hi: [ref.to, ref.to], fill: true, width: 0 }));
                    else missed.push(label);
                } else {
                    spec.bands.push({ x0: Math.min(ref.from, ref.to), x1: Math.max(ref.from, ref.to), color: C.band, label: label });
                }
            } else if (ref.kind === "series" && isSeries(ref.y) && isSeries(ref.x || got.x) && (ref.x || got.x).length === ref.y.length) {
                spec.series.push(line(label || "limit", ref.x || got.x, ref.y, C.ref, { dash: [4, 3], width: 1 }));
            }
        });
        if (!freq) {
            spans.forEach(function (s, i) {
                if (s && isNum(s.t0) && isNum(s.t1)) spec.bands.push({ x0: Math.min(s.t0, s.t1), x1: Math.max(s.t0, s.t1), color: C.span, label: oneLine(s.label) || "part " + (i + 1) });
            });
        }
        spec.series = spec.series.filter(function (s) { return isSeries(s.y); });
        spec.legend = spec.series.length > 1;
        var only = !freq && got.node && opts && opts.periods ? onlyProfile(spec, got, f, opts.periods) : null;
        return { spec: spec, missed: missed.filter(Boolean), only: only, onlyText: only ? "The plot shows only the periods of " + profileLabel(only) + "." : "" };
    }

    // ---------------------------------------------------------------------------------------------
    // "Save report": results, recommendations and the toolkit's own report as Markdown

    function markdown(entry) {
        var r = entry.result, recs = recsOf(r), out = [], h = r.header || {};
        function row(cells) { out.push("| " + cells.map(function (s) { return oneLine(s).replace(/\|/g, "\\|"); }).join(" | ") + " |"); }
        function table(head, rows) {
            if (!rows.length) return;
            out.push("");
            row(head);
            out.push("|" + head.map(function () { return "---"; }).join("|") + "|");
            rows.forEach(row);
            out.push("");
        }
        function where(f) { return findingWhere(f, " "); }
        function value(f) { var c = countText(f, sampleCounts(r, f.log)); return valueTextOf(f) + (c ? " (" + c + ")" : ""); }
        var byFid = {}; // the result behind an evidence row of a recommendation, for its stale
        (r.findings || []).forEach(function (f) { if (f && f.fid) byFid[f.fid] = f; });
        function staleText(f) {
            var s = staleOf(f) || (f && f.fid && byFid[f.fid] ? staleOf(byFid[f.fid]) : null);
            return s ? oneLine(s.text) || FRESH.period : "";
        }

        out.push("# Tuning report");
        table(["Item", "Value"], [
            ["File", r.fileName], ["Analysis", entry.label]].concat(entry.scope === "flights" ? [["Flights in the analysis", selectionText(entry.flights, entry.counts)]] :
                entry.scope === "file" && flightsOf(r) ? [["Flights in the analysis", fileFlightsText(flightsOf(r))]] : []).concat([
            ["Craft name", h["Craft name"]], ["Firmware", h["Firmware revision"]],
            ["Flight rpm", rpmText(r.flightRpm)]].concat(
            // the CLI dump only when the pilot loaded one (user rule 2026-10-06), the notch orders of the log when the worker found them
            entry.cliName ? [["CLI dump", entry.cliName + (r.cli ? " (" + [r.cli.kind, r.cli.version].filter(Boolean).join(" ") + ")" : "")]] : [],
            notchFitRows(r), [
            ["Date", new Date(entry.finishedAt).toISOString()], ["Analysis time", r.timing ? secs(r.timing.totalS) : ""]
        ])));
        out.push("> **WARNING:** " + WARNING, ">", "> **NOTE:** " + NO_SEND, "",
            "The log numbers start at 1, as in the log list of the log viewer. Only the toolkit report at the end starts at 0.", "");
        var conflicts = cliConflicts(r);
        if (conflicts.length) out.push("> **" + CLI_STATUS.conflict + "** " + CLI_STATUS.logWins, "", conflicts.map(function (c) { return "- " + oneLine(c.text || c.what); }).join("\n"), "");
        var starts = startRows(r);
        if (starts.length) {
            out.push("## PID profile at the start of each log", "", START_NOTE);
            table(["Log", "PID profile", "Basis"], starts);
        }
        if (epochsOf(r)) { // the parts of the logs with values that are possibly different (CLAUDE.md "Values that are possibly not current")
            var fr = r.freshness && typeof r.freshness === "object" ? r.freshness : {}, counts = freshCounts(r), parts = freshnessRows(r);
            out.push("## " + FRESH.heading, "", FRESH.about + " " + FRESH.mark, "", [oneLine(fr.caveat), FRESH.noMark].filter(Boolean).join(" "), "");
            if (counts) out.push(counts, "");
            if (parts.length) {
                out.push(FRESH.table);
                table(["Log", "Part of the log", "Arm", "PID profile", "Rate profile", "Values from", "Causes"], parts);
            } else out.push(FRESH.none, "");
        }
        out.push("## Recommendations", "");
        if (!recs.length) out.push(adviceRan(r) ? "No recommendation." : "The recommendations are not available: " + whyNoAdvice(r) + ".", "");
        recs.forEach(function (rec, i) {
            var sev = (REC_SEVERITY[rec.severity] || REC_SEVERITY.info).label;
            out.push("### " + (i + 1) + ". " + oneLine(rec.title) + " (" + sev + (isBlocked(rec) ? ", blocked" : "") + (causesOf(rec).length ? ", possible result" : "") + ")", "");
            if (rec.text) out.push(oneLine(rec.text), "");
            if (rec.parameter) out.push("- Parameter: `" + oneLine(rec.parameter) + "` " + paramText(rec));
            out.push("- Area: " + oneLine(REC_AREA_LABEL[rec.area] || rec.area) + "." + (confidenceText(rec.confidence) ? " Confidence: " + confidenceText(rec.confidence) + "." : ""));
            if (rec.rule) out.push("- Rule: " + oneLine(rec.rule));
            (rec.blockedBy || []).forEach(function (b) { out.push("- Blocked: " + oneLine(b)); });
            causesOf(rec).forEach(function (c) { out.push("- Possible result of: " + oneLine([c.rule, c.name].filter(Boolean).join(" ")) + (c.first ? ". Do first: " + oneLine(Array.isArray(c.first) ? c.first.join(" ") : c.first) : "")); });
            (rec.caveats || []).forEach(function (c) { out.push("- Note: " + oneLine(c)); });
            if (staleOf(rec)) out.push("- " + FRESH.badge + ": " + (oneLine(staleOf(rec).text) || FRESH.period));
            table(["Check", "Log", "Profile and axis", "Value", "Limit", "Source", "Result", "Toolkit text (not STE)", FRESH.badge], (rec.evidence || []).map(function (e) {
                return [e.id, logLabel(e.log), where(e), value(e), limitTextOf(e), e.source, summaryOf(e), e.text, staleText(e)];
            }));
            if (hasCli(rec)) out.push("```", rec.cli.join("\n"), "```", "");
        });
        var script = (r.advice && r.advice.script) || "";
        if (script) out.push("## CLI script for all changes", "", "```", script, "```", "");
        if (Array.isArray(r.decisions) && r.decisions.length) {
            out.push("## Gain analysis");
            table(["Axis", "Headspeed", "Flights", "Windows", "Result", FRESH.badge], r.decisions.map(function (d) {
                var o = decisionOutcome(d);
                return [d.axis, num(d.bin) + " rpm", num(d.flights), num(d.windows), o.text + (o.quoted ? " " + o.quoted : ""), staleOf(d) ? oneLine(staleOf(d).text) || FRESH.period : ""];
            }));
        }
        out.push("## Results: problems, notes and analysis errors");
        table(["Status", "Check", "Log", "Profile and axis", "Value", "Limit", "Source", "Result", "Toolkit text (not STE)", FRESH.badge], (r.findings || []).filter(function (f) {
            return rankOf(f) <= SEVERITY_RANK.note;
        }).sort(SORTS.severity).map(function (f) {
            return [STATUS[findingStatus(f)], f.id, logLabel(f.log), where(f), value(f), limitTextOf(f), f.source, summaryOf(f), f.text, staleText(f)];
        }));
        var hier = r.hierarchy, graph = graphOf(r);
        if (graph) {
            // the findings of an item or a step: those of its status and those that the worker gave it (f.node)
            var mine = function (id, e) {
                var fids = [].concat(e.fids || [], e.problemFids || []);
                return (r.findings || []).filter(function (f) { return f && (fids.indexOf(f.fid) >= 0 || f.node === id); });
            };
            if (graph.prereq.length) {
                out.push("## Before the first flight");
                table(["Item", "Condition", "Checks with a problem", "Checks"], graph.prereq.map(function (p) {
                    var st = prereqState(hier, p.id);
                    return [p.title, PREREQ_STATUS[st.key], problemIds(mine(p.id, st.entry)).join(", "), (p.checks || []).join(", ")];
                }));
            }
            out.push("## Tuning steps");
            table(["Step", "Title", "Condition", "Start here", "Checks with a problem", "Parameters"], graph.blocks.map(function (n) {
                var st = nodeState(hier, n.id);
                return [stepNo(n), n.title, NODE_STATUS[st.key], st.start ? String(st.start) : "", problemIds(mine(n.id, st.entry)).join(", "), paramsOf(n).join(", ")];
            }));
        }
        var dsets = datasetsOf(r), clist = configList(r, true);
        if (dsets && clist.length) {
            out.push("## Configurations");
            table(["Configuration", "PID profile", "Logs", "Flight time", "Values"], clist.map(function (d) {
                return [d.id, profileLabel(isNum(d.pidProfile) ? d.pidProfile : 0), cap(logsText(d.logs)), isNum(d.flightSeconds) ? secs(d.flightSeconds) : "", cap(configMarks(d, dsets).join(", "))];
            }));
            var drows = Array.isArray(dsets.diff) ? dsets.diff.filter(function (q) { return q && q.name; }) : [];
            if (drows.length) {
                out.push("### Parameters that are not the same", "", '"?": the value is unknown. "-": the configuration does not have this parameter.');
                table(["Parameter"].concat(clist.map(function (d) { return d.id; })), drows.map(function (q) {
                    return ["`" + q.name + "`" + (q.samePidProfile ? " (same PID profile)" : "")].concat(clist.map(function (d) {
                        var v = q.values ? q.values[d.id] : undefined;
                        return (Array.isArray(q.missingIn) && q.missingIn.indexOf(d.id) >= 0) || v === undefined ? "-" : v === null ? "?" : num(v);
                    }));
                }));
            }
        }
        if (adviceRan(r)) {
            out.push("## Parameter groups");
            table(["Group", "Area", "Status", "Checks", "Parameters", "Data"], r.advice.coverage.map(function (c) {
                return [c.group || c.area, c.area, (COVERAGE[c.status] || [c.status])[0], (c.checks || []).join(", "), (c.parameters || []).join(", "), c.detail];
            }));
        }
        var notes = notesOf(r);
        if (notes.length) out.push("## Notes", "", notes.map(function (n) { return "- " + oneLine(n); }).join("\n"), "");
        out.push("---", "", "## Toolkit report (not STE)", "", r.reportMarkdown || "(none)", "");
        return out.join("\n");
    }

    // ---------------------------------------------------------------------------------------------
    // The view

    // What a CLI dump is and what it can add, under its control (HTML)
    var CLI_ABOUT = "A CLI dump is the text of <code>diff all</code> from the CLI tab of the Configurator. The analysis is complete without a CLI dump. " +
        "A CLI dump can add values that the log does not record, for example the rescue mode and the servo limits.";

    var SKELETON =
        '<div class="tuning-context"></div>' +
        '<div class="tuning-controls">' +
            '<label class="tuning-field">Logs ' + scopeSelectHtml("file") + "</label>" +
            '<span class="tuning-scope-text tuning-muted"></span>' +
            '<span class="tuning-actions">' +
                '<button type="button" class="btn btn-primary btn-sm tuning-analyse">Start analysis</button>' +
                '<button type="button" class="btn btn-default btn-sm tuning-cancel">Cancel</button></span>' +
        "</div>" +
        // The CLI dump: an optional input on its own line (user rule 2026-10-06: the log is the only necessary input)
        '<div class="tuning-cli-line"><span class="tuning-cli-label">Optional: CLI dump</span>' +
            '<button type="button" class="btn btn-default btn-xs tuning-cli-load" title="The app reads the text of &quot;diff all&quot; from a file. The app does not save the file.">Load</button>' +
            '<span class="tuning-cli-name tuning-muted"></span><input type="file" class="tuning-cli-input tuning-hide" accept=".txt,.cli,.diff,.dump,text/plain">' +
            '<div class="tuning-cli-about tuning-muted">' + CLI_ABOUT + "</div></div>" +
        '<div class="tuning-fsel tuning-hide"></div>' +
        '<section class="tuning-configuration tuning-hide" aria-label="Recorded configurations"></section>' + // "Selected flights": the flight list (SPEC3 D)
        '<div class="tuning-progress"><div class="tuning-progress-track"><div class="tuning-progress-bar"></div></div><div class="tuning-progress-text"></div>' +
            '<button type="button" class="btn btn-default btn-xs tuning-save" title="Save the results, the recommendations and the CLI text as a Markdown file">Save report</button></div>' +
        '<div class="tuning-notices"></div>' +
        '<section class="tuning-log-preview analysis-compare tuning-hide" aria-label="Data from the log" tabindex="-1"></section>' +
        '<div class="tuning-tabs tuning-hide">' + TABS.filter(function (t) { return !t.auxiliary; }).map(function (t) {
            return '<a href="#" class="tuning-tab" data-tab="' + t.key + '">' + esc(t.title) + '<span class="tuning-tab-count"></span><span class="tuning-tab-status"></span></a>';
        }).join("") + "</div>" +
        '<div class="tuning-panes tuning-hide">' + TABS.map(function (t) { return '<div class="tuning-pane" data-pane="' + t.key + '"></div>'; }).join("") + "</div>" +
        '<div class="tuning-empty"></div>';

    function TuningDialog(dialog, hooks) {
        hooks = hooks || {};

        var self = this,
            body = dialog.find("#tuningBody"),
            uid = "tuning" + (++instances),
            cachedLog = null,           // the FlightLog given to show(), only for a host without hooks.getFlightLog
            files = new WeakMap(),      // whole-file bytes -> { name, key, offsets }
            cache = [],                 // finished runs, newest last
            job = null, jobSeq = 0, ticker = null,
            shown = null,               // the cache entry on display
            failure = null,             // { key, message, stack }
            cancelled = null,           // { key, ms }
            cli = null,                 // { name, text, hash, craft, fileKey }: the CLI dump, for the file that was open when it was loaded
            cliGone = null,             // { name, fileKey }: the CLI dump that the app removed because a different file opened
            hint = null,                // a message of the last action, until the next render of the notices
            view = { tab: "overview", axis: "roll", segment: null, vibProfile: null, scope: "file", sev: "issues", area: "all", query: "", sort: "severity", dir: 1,
                node: null, compare: null, profile: "all", dataset: "all" },  // profile: the PID profile of the diagram and the lists ("all" or its number); dataset: the configuration ("all" or its id)
            rendered = {}, handles = {}, pending = {}, visible = false, plotSeq = 0, copyTexts = [], queryTimer = null,
            details = {}, detailSeq = 0, detailOpen = {}, configurationRendered = null,
            listeners = [], configListeners = [], reader = null, compares = {}, cmpSlots = {}, preview = null,
            fsel = { fileKey: null, map: null }, // "Selected flights" (SPEC3 D): the selection map of the file of fileKey (null: the default, all flights)
            fselOpen = { list: null, sub: {} }, // the open state of the flight lists for the session (toggleList)
            settingsListeners = [],         // the Analysis view: cb() after each change of the settings of the analysis (onSettings)
            ft = { job: null, worker: null, workerKey: null, seq: 0, cache: [], failure: null, cancelled: null, sources: {}, limits: {}, drafts: {}, auto: {} }, // one filter draft per log/flight
            derive = { worker: null, seq: 0, waiting: {} };

        body.html(SKELETON);

        function part(name) { return body.find(".tuning-" + name); }
        function pane(key) { return body.find('.tuning-pane[data-pane="' + key + '"]'); }

        // The viewer's FlightLog now, never one kept from show(): a file dropped on the window replaces it while this
        // view is open, and a kept one would give the old file's log count and times
        function viewerLog() {
            return (hooks.getFlightLog ? hooks.getFlightLog() : cachedLog) || null;
        }

        var context = part("context"), fselBox = part("fsel"), scopeSelect = part("scope"), cliName = part("cli-name"),
            analyseButton = part("analyse"), cancelButton = part("cancel"), saveButton = part("save"), progress = part("progress"),
            progressBar = part("progress-bar"), progressText = part("progress-text"), notices = part("notices"), empty = part("empty");

        // --- findings of the result on display: by fid (SPEC2 D4), else by a key of this view

        var index = { result: null, byKey: {}, keys: new Map() };

        function indexOf(result) {
            if (index.result === result) return index;
            index = { result: result, byKey: {}, keys: new Map() };
            (result && result.findings || []).forEach(function (f, i) {
                var key = f.fid ? String(f.fid) : "#" + i;
                index.byKey[key] = f;
                index.keys.set(f, key);
            });
            return index;
        }

        // The two filters of the result lists (SPEC3 E): from js/main.js (the preferences, shared with the log lens), else
        // kept here
        var localFilter = { thin: false, ok: false };
        function resultFilter() {
            var f = hooks.resultFilter ? hooks.resultFilter() : localFilter;
            return { thin: !!(f && f.thin), ok: !!(f && f.ok) };
        }

        // The lists draw again with the filters of now: the panes with result lists (not the recommendations, the CLI file and
        // the parameter groups)
        function filterChanged() {
            if (!shown) return;
            Object.keys(rendered).forEach(function (k) { if (k !== "recs" && k !== "export" && k !== "coverage") rendered[k] = null; });
            showTab(view.tab);
        }

        var env = {
            uid: uid,
            details: detailHtml,
            filter: resultFilter,
            seek: function (li, t, what, segment) { seekTo(li, shown ? frameOf(shown.result, li, t, segment) : t, what); },
            copy: function (text) { copyTexts.push(String(text)); return copyTexts.length - 1; },
            plotId: function () { return uid + "-plot-" + (++plotSeq); },
            recId: function (i) { return uid + "-rec-" + i; },
            // a finding of the result, from its key or fid, or the finding behind a recommendation's evidence row
            findingOf: function (x) {
                var ix = indexOf(shown && shown.result);
                if (typeof x === "string") return ix.byKey[x] || null;
                if (x && x.fid && ix.byKey[x.fid]) return ix.byKey[x.fid];
                return x && ix.keys.has(x) ? x : null;
            },
            samplesOf: function (li) { return sampleCounts(shown && shown.result, li); },
            findingsOf: function (fids) {
                return (Array.isArray(fids) ? fids : []).map(function (fid) { return env.findingOf(String(fid)); }).filter(Boolean);
            },
            keyOf: function (f) {
                var ix = indexOf(shown && shown.result);
                return f && f.fid ? String(f.fid) : ix.keys.get(f) || "";
            },
            compareOpen: function (key, where) {
                return !!(view.compare && key && view.compare.key === key && view.compare.where === where);
            },
            compareHtml: function (f, where) { return compareHtml(f, where); },
            // the CLI file: the selected recommendations of a result (by their index in recsOf) and the script of them
            picks: function (entry) { return picksOf(entry); },
            pending: function (entry) { return compiledPlan(entry); },
            finalProfiles: function (entry) { return finalProfilesHtml(entry); },
            configReference: function (entry,v) { return renderConfigs(entry,v,{uid:uid}).html; },
            exportOf: function (entry) { return exportModel(entry); },
            exportRecs: function (entry) { return exportRecsOf(entry); },
            controlModel: function (step) { return ctModel(step); },
            filterSource: function () { return ftSource(); },
            // the filter calculation of the open file (SPEC3 G): its HTML, and its plots with the plots of the pane
            filterSearch: function (where) {
                var out = filterSearchHtml(ftModel(), env, { compact: where === "panel", openDetails: view.ftDetails, hideUnchanged: !!view.ftHideUnchanged, curves: view.ftCurves, axis: view.axis, trace: view.ftTrace || 0, plot: !!view.ftPlot && where !== "panel", disabled: !viewerLog(),
                    graph: shown ? graphOf(shown.result) : null });
                out.plots.forEach(function (q) { env.extra.push(q); });
                return out.html;
            },
            extra: [] // plots of the pane being drawn that are not in its tab's own list (the compare panels)
        };

        // --- the file and the settings

        function fileInfo() {
            var bytes = viewerLog() && hooks.getBytes ? hooks.getBytes() : null;
            if (!bytes || !bytes.length) return null;
            var name = String((hooks.getFileName && hooks.getFileName()) || "log"), info = files.get(bytes);
            if (!info || info.name !== name) {
                info = { name: name, offsets: null,
                    key: name + "|" + bytes.length + "|" + fnv(bytes.length, function (i) { return bytes[i]; }, Math.max(1, Math.floor(bytes.length / 4096))) };
                files.set(bytes, info);
            }
            info.bytes = bytes;
            return info;
        }

        function currentLog() {
            var i = hooks.getCurrentLogIndex ? hooks.getCurrentLogIndex() : null, log = viewerLog();
            if (!isNum(i) && log) i = log.getLogIndex();
            return isNum(i) && i >= 0 ? i : 0;
        }

        // The key of a run. "This log": the log is in the key. "All flights in the file" and "Selected flights" (2026-10-06): the
        // result is of the file, so the key has "*" for the log. Such a run takes its curves, and the header for the values of
        // its recommendations, from the log on display when it ran (job.logIndex, the notice of noticesHtml): another log in
        // the viewer does not start the long run of the file again
        function keyFor(info, scope, li, rpm) {
            var c = usedCli();
            return [info.key, scope, scope === "log" ? li : "*", rpm === null ? "auto" : rpm, c ? c.hash : "no-cli"].join("|");
        }

        // The CLI dump goes with the file that was open when the pilot loaded it (V1). When a different file opens, the app
        // removes the dump and says so (cliGone): the CLI values of one helicopter are not the values of another
        function syncCli() {
            var info = fileInfo();
            if (!cli || !info) return cli;
            if (!cli.fileKey) cli.fileKey = info.key; // loaded before a file was open
            else if (cli.fileKey !== info.key) {
                cliGone = { name: cli.name, fileKey: info.key };
                cli = null;
            }
            return cli;
        }

        // { dump, log }: the craft names of the CLI dump and of the log header, when both have one and they are not the same
        function cliConflict() {
            var log = viewerLog(), head = log ? String(log.getSysConfig()["Craft name"] || "").trim() : "";
            return cli && cli.craft && head && !sameCraft(cli.craft, head) ? { dump: cli.craft, log: head } : null;
        }

        // The CLI dump that the analysis uses: none for another file, or when its craft name is not that of the log header
        function usedCli() {
            return syncCli() && !cliConflict() ? cli : null;
        }

        // --- "Selected flights" (SPEC3 D)

        // The log offsets of the file (FlightLogIndex), once for each file; null when the index cannot read the file
        function offsetsOf(info) {
            if (!info.offsets) {
                try {
                    var ix = new FlightLogIndex(info.bytes), out = [];
                    for (var i = 0; i <= ix.getLogCount(); i++) out.push(ix.getLogBeginOffset(i));
                    info.offsets = out;
                } catch (e) {
                    return null;
                }
            }
            return info.offsets;
        }

        // The selection map of the open file. A file starts with every flight that the analysis can use (each log that is not a
        // bench run or a log with no data, with all its flights): the default of the "Logs" control is all flights (2026-10-06).
        // "Remove the selection" gives an empty map, which stays empty
        function selectionMap() {
            var info = fileInfo();
            if (!info) return {};
            if (fsel.fileKey !== info.key) fsel = { fileKey: info.key, map: null };
            if (!fsel.map) fsel.map = selectionApply({}, { kind: "all" }, selectionRows(fileLogs(), knownFlights(), {}));
            return fsel.map;
        }

        // The selection for the run: [{ log, flight }], without the logs that the app knows as a bench run or a log with no data
        function selection() {
            var known = knownFlights(), bad = {};
            fileLogs().forEach(function (L) { if (L.error) bad[L.log] = true; });
            Object.keys(known).forEach(function (k) { if (known[k].noData || known[k].bench || !known[k].flights.length) bad[k] = true; });
            return selectionList(selectionMap()).filter(function (x) { return !bad[x.log]; });
        }

        // The open state of the flight lists for the session: the list (null: open only with no selection) and the flights of
        // each log ({ "<file key>|<log>": true }: open; closed when not given)
        function subOpenOf(info) {
            var out = {};
            Object.keys(fselOpen.sub).forEach(function (k) {
                var i = k.lastIndexOf("|");
                if (info && k.slice(0, i) === info.key) out[k.slice(i + 1)] = fselOpen.sub[k];
            });
            return out;
        }

        // The flight list. Its first drawing in the session decides its open state: closed when a selection exists (the
        // default selection is every flight), open with no selection. Then the list keeps the state that the pilot gives it
        function selectionListHtml() {
            var info = fileInfo(), known = knownFlights(), rows = selectionRows(fileLogs(), known, selectionMap());
            if (fselOpen.list === null) {
                var c = selectionCounts(rows);
                fselOpen.list = !c.flightsOn && !c.otherOn;
            }
            return selectionHtml(rows, Object.keys(known).length > 0, { open: fselOpen.list, subOpen: subOpenOf(info) });
        }

        // The pilot opens or closes a flight list: { kind: "open", on } (the list), { kind: "sub", log, on } (the flights of a log)
        function toggleList(act) {
            var info = fileInfo();
            if (act.kind === "open") fselOpen.list = !!act.on;
            else if (act.kind === "sub" && info && isNum(act.log)) fselOpen.sub[info.key + "|" + act.log] = !!act.on;
        }

        // The logs of the open file for the flight list: number, date (the log header), length (the log index of the viewer)
        // and the error of a log with no data
        function fileLogs() {
            var info = fileInfo(), log = viewerLog(), out = [];
            if (!info || !log) return out;
            var offs = offsetsOf(info);
            info.dates = info.dates || {};
            for (var i = 0; i < log.getLogCount(); i++) {
                var err = null, seconds = null;
                try { err = log.getLogError ? log.getLogError(i) || null : null; } catch (e) { err = e && e.message || "error"; }
                if (!err) {
                    try { seconds = (log.getMaxTime(i) - log.getMinTime(i)) / 1e6; } catch (e) { err = e && e.message || "error"; }
                }
                if (!(i in info.dates)) info.dates[i] = offs && i + 1 < offs.length ? logDateText(headerValue(info.bytes, offs[i], offs[i + 1], "Log start datetime")) : null;
                out.push({ log: i, date: info.dates[i], seconds: isNum(seconds) && seconds >= 0 ? seconds : null, error: err ? String(err) : null });
            }
            return out;
        }

        // The flights of each log that a result of this file knows: { [log]: { bench, flights } }. The results of one log
        // or of the file first, the newest first; from a result of selected flights only its full logs (the flight numbers
        // of the others are not known)
        function knownFlights() {
            var info = fileInfo(), out = {}, list = info ? cache.filter(function (e) { return e.fileKey === info.key; }).reverse() : [];
            [false, true].forEach(function (ofSelection) {
                list.forEach(function (e) {
                    if ((e.scope === "flights") !== ofSelection) return;
                    var fl = flightsOf(e.result);
                    if (!fl) return;
                    Object.keys(fl.logs).forEach(function (k) {
                        var L = fl.logs[k];
                        if (out[L.log]) return;
                        if (ofSelection && !(e.flights || []).some(function (x) { return x.log === L.log && x.flight === null; })) return;
                        out[L.log] = { bench: L.bench, flights: L.flights, noData: !!L.noData, why: L.why || null };
                    });
                });
            });
            return out;
        }

        // { [log]: the number of flights } that the app knows, for selectionText
        function flightCounts(known) {
            var out = {};
            Object.keys(known || {}).forEach(function (k) { if (!known[k].bench) out[k] = known[k].flights.length; });
            return out;
        }

        // The log of the curves and of the log header of a run: the open log, or for "Selected flights" the first selected
        // log when the open log is not in the selection
        function runLog(list) {
            var li = currentLog();
            if (!list || !list.length || list.some(function (x) { return x.log === li; })) return li;
            return list[0].log;
        }

        function changeSelection(act) {
            var map = selectionMap(), rows = act.kind === "all" ? selectionRows(fileLogs(), knownFlights(), map) : null;
            fsel.map = selectionApply(map, act, rows);
            settingsChanged();
        }

        function renderSelection() {
            var log = viewerLog();
            if (view.scope !== "flights" || !log || !fileInfo()) {
                fselBox.toggleClass("tuning-hide", true).html("");
                return;
            }
            var el = fselBox[0], again = fselState(el);
            fselBox.toggleClass("tuning-hide", false).html(selectionListHtml());
            if (el && el.querySelectorAll) Array.prototype.forEach.call(el.querySelectorAll('[data-partly="1"]'), function (x) { x.indeterminate = true; }); // some flights of the log
            fselRestore(el, again);
        }

        // null: no file, or "Selected flights" with no selection
        function currentKey() {
            var info = fileInfo(), rpm = null, list = view.scope === "flights" ? selection() : null;
            if (!info || (list && !list.length)) return null;
            return keyFor(info, list ? "flights:" + selectionKey(list) : view.scope, list ? runLog(list) : currentLog(), rpm);
        }

        function cached(key) {
            return cache.filter(function (e) { return e.key === key; })[0] || null;
        }

        // --- the analysis worker

        // An error of a run for the waiters of runAnalysis: reason "start" (no run started), "failed" (the worker), "canceled"
        // (the user), "replaced" (a run with other settings, or another file, ends it). message: our sentence; detail: a
        // message that is not ours
        function jobError(reason, message, detail) {
            var e = new Error(message);
            e.reason = reason;
            e.detail = detail || "";
            return e;
        }

        // The run stops; its waiters get `error` (a "replaced" error when none is given). The result goes to them in onMessage
        function endJob(error) {
            var j = job;
            if (j) j.worker.terminate();
            job = null;
            clearInterval(ticker);
            if (j) settleJob(j, null, error || jobError("replaced", "The app stopped this analysis, because the settings or the file changed."));
        }

        function settleJob(j, result, error) {
            var list = j.waiters || [];
            j.waiters = [];
            list.forEach(function (w) {
                try { if (result) w.resolve(result); else w.reject(error); } catch (e) { console.error(e); }
            });
        }

        function start() {
            var info = fileInfo(), rpm = null, c = usedCli();
            failure = cancelled = null;
            if (!info) return renderChrome();
            var list = view.scope === "flights" ? selection() : null;
            if (list && !list.length) {
                failure = { input: true, message: 'Select one or more flights in the list. Then click "Start analysis".' };
                return renderChrome();
            }
            endJob();
            var li = list ? runLog(list) : currentLog(), scope = view.scope, count = viewerLog().getLogCount(), msg, worker; // fileInfo() needs a FlightLog
            try {
                if (scope === "log") {
                    if (!offsetsOf(info)) {
                        var ix = new FlightLogIndex(info.bytes);
                        info.offsets = [];
                        for (var i = 0; i <= ix.getLogCount(); i++) info.offsets.push(ix.getLogBeginOffset(i));
                    }
                    if (li + 1 >= info.offsets.length) throw new Error("log " + (li + 1) + " is not in the file index");
                    msg = { cmd: "analyseLog", bytes: info.bytes.slice(info.offsets[li], info.offsets[li + 1]).buffer, logIndex: li, logCount: count,
                        options: { flightRpm: rpm, cliText: c ? c.text : null, cliName: c ? c.name : null, excludeAbnormal: true, curves: true } };
                } else {
                    msg = { cmd: "analyseFile", bytes: info.bytes.slice().buffer, selectedLog: li,
                        options: { flightRpm: rpm, cliText: c ? c.text : null, cliName: c ? c.name : null, excludeAbnormal: true, gains: true } };
                    // "Selected flights" (SPEC3 D): [{ log, flight }], 0-based; flight null: every flight of that log
                    if (list) msg.options.flights = list.map(function (x) { return { log: x.log, flight: x.flight }; });
                }
                msg.id = ++jobSeq;
                msg.fileName = info.name;
                worker = new Worker("js/tuning_worker.js");
            } catch (e) {
                failure = { message: "The analysis did not start.", detail: e && e.message || String(e) };
                return renderChrome();
            }
            var mine = job = { id: msg.id, key: keyFor(info, list ? "flights:" + selectionKey(list) : scope, li, rpm), fileKey: info.key, scope: scope, logIndex: li, logCount: count,
                flights: list, counts: list ? flightCounts(knownFlights()) : null,
                rpm: rpm, cliName: c ? c.name : null, worker: worker, started: Date.now(), last: null, waiters: [] };
            worker.onmessage = function (e) { onMessage(mine, e.data); };
            worker.onerror = function (e) {
                if (e && e.preventDefault) e.preventDefault();
                fail(mine, { message: "The script of the analysis stopped.", detail: e && e.message || "script error" });
            };
            ticker = setInterval(renderProgress, 500);
            try {
                worker.postMessage(msg, [msg.bytes]);
            } catch (e) {
                return fail(mine, { message: "The app cannot send the log to the worker.", detail: e && e.message || String(e) });
            }
            renderChrome();
        }

        function fail(j, err) {
            if (j !== job) return;
            failure = { key: j.key, message: err.detail !== undefined ? err.message : "", detail: oneLine(err.detail !== undefined ? err.detail : err.message || "unknown error"),
                stack: err.stack ? String(err.stack) : "" };
            endJob(jobError("failed", failure.message, failure.detail));
            renderChrome();
        }

        function onMessage(j, m) {
            if (j !== job || !m || m.id !== j.id) return;
            if (m.type === "progress") {
                j.last = m;
                renderProgress();
            } else if (m.type === "error") {
                fail(j, m);
            } else if (m.type === "result" && m.result) {
                var waiters = j.waiters;
                j.waiters = []; // the result goes to them below, not the error of endJob
                endJob();
                var entry = { key: j.key, fileKey: j.fileKey, scope: j.scope, logIndex: j.logIndex, logCount: j.logCount, rpm: j.rpm, cliName: j.cliName,
                    flights: j.flights || null, counts: j.counts || null,
                    finishedAt: Date.now(), result: m.result, label: j.scope === "log" ? "Log " + (j.logIndex + 1) + " of " + j.logCount :
                        j.scope === "flights" ? "Selected flights in " + plural(selectedLogs(j.flights), "log") : "All flights in the file (" + plural(j.logCount, "log") + ")" };
                cache = cache.filter(function (e) { return e.key !== entry.key; }).concat([entry]).slice(-CACHE_MAX);
                if (entry.scope === "flights") entry.counts = flightCounts(knownFlights()); // with the flights of this result
                var info = fileInfo(), same = !!(info && info.key === entry.fileKey);
                if (same) display(entry);
                else renderChrome();
                j.waiters = waiters;
                settleJob(j, same ? entry.result : null, jobError("replaced", "The result is for a different file."));
            }
        }

        function cancel() {
            if (!job) return;
            cancelled = { key: job.key, ms: Date.now() - job.started };
            endJob(jobError("canceled", "You canceled the analysis."));
            renderChrome();
        }

        // --- the derive worker: one, kept for the view and the log lens

        // the answer to a request is the message of its id: "derived" (derive), "exported" (export); "error" rejects
        function deriveWorker() {
            if (derive.worker) return derive.worker;
            var w = new Worker("js/tuning_worker.js");
            w.onmessage = function (e) {
                var m = e.data || {}, p = derive.waiting[m.id];
                if (!p || m.type === "progress") return;
                if (m.type === "error") settle(m.id, new Error(oneLine(m.message) || "derive error"));
                else settle(m.id, null, m.result);
            };
            w.onerror = function (e) {
                if (e && e.preventDefault) e.preventDefault();
                var why = new Error(e && e.message || "script error");
                Object.keys(derive.waiting).forEach(function (id) { settle(+id, why); });
                try { w.terminate(); } catch (x) { /* already gone */ }
                if (derive.worker === w) derive.worker = null;
            };
            derive.worker = w;
            try { w.postMessage({ cmd: "init", id: 0 }); } catch (x) { /* the first derive says why */ }
            return w;
        }

        function settle(id, error, out) {
            var p = derive.waiting[id];
            if (!p) return;
            delete derive.waiting[id];
            clearTimeout(p.timer);
            if (error) p.reject(error);
            else p.resolve(out);
        }

        // One request to the derive worker: msg gets its id; the promise has the result of the answer. transfer: the
        // buffers to give to the worker (they are empty after the call), else the message is copied
        function ask(msg, transfer) {
            return new Promise(function (resolve, reject) {
                var id = ++derive.seq, w;
                try {
                    w = deriveWorker();
                } catch (e) {
                    return reject(e);
                }
                derive.waiting[id] = { resolve: resolve, reject: reject, timer: setTimeout(function () { settle(id, new Error("no answer from the derive worker in 30 s")); }, DERIVE_MS) };
                msg.id = id;
                try {
                    if (transfer && transfer.length) w.postMessage(msg, transfer);
                    else w.postMessage(msg);
                } catch (e) {
                    settle(id, e);
                }
            });
        }

        // The buffers of the typed arrays of cols, each once (a buffer twice in a transfer list is an error)
        function buffersOf(cols) {
            var out = [];
            Object.keys(cols || {}).forEach(function (k) {
                var b = cols[k] && ArrayBuffer.isView(cols[k]) ? cols[k].buffer : null;
                if (b && Object.prototype.toString.call(b) === "[object ArrayBuffer]" && b.byteLength && out.indexOf(b) < 0) out.push(b);
            });
            return out;
        }

        // transfer: the caller gives the buffers of cols to the worker (copies that it does not use again: the log lens and
        // the Analysis view). Without it, the worker gets a copy
        this.derive = function (kind, cols, rate, params, transfer) {
            return ask({ cmd: "derive", kind: String(kind), rate: rate, cols: cols || {}, params: params || {} }, transfer === true ? buffersOf(cols) : null);
        };

        // --- the CLI file (SPEC2 D11)

        // The selected recommendations of a result, by their index in recsOf: at first each change with CLI text
        // A group (C7) is selected as one: all its changes when each has CLI text and the first is a change, else none of them
        // The changes of the filter calculation come after the recommendations of the result: each new calculation selects its
        // changes first (ftSig), and the selection of the other recommendations stays
        function tuningState(entry) {
            if (!entry.tuning) entry.tuning={drafts:{},finalByProfile:{}};
            var state=entry.tuning, ds=datasetsOf(entry.result);
            configList(entry.result).forEach(function(d){
                if (!state.drafts[d.id]) state.drafts[d.id]={selected:{}};
                if (d.pidProfile>0 && state.finalByProfile[d.pidProfile]===undefined) {
                    var latest=ds.newestByProfile && ds.newestByProfile[d.pidProfile];
                    state.finalByProfile[d.pidProfile]=configList(entry.result).some(function(x){return x.id===latest;}) ? latest : d.id;
                }
            });
            return state;
        }
        function draftRecs(entry,id) {
            var d=configOf(entry.result,id), a=entry.result.advice, own=a && a.byDataset && a.byDataset[id] || recsOf(entry.result);
            if (d) own=own.filter(function(r){return (!r.dataset || r.dataset===id) && (!profileNo(r) || profileNo(r)===d.pidProfile) && (!r.dataset && r.supportedBy && r.supportedBy.length ? r.supportedBy.indexOf(id)>=0 : true);});
            // Filter results belong to the flight source, independently of the
            // control drafts. An edited replay cannot revive heuristic advice.
            if (ft.cache.some(function(e){return e.sourceKey===ftKey(true) && e.result.version===2;})) own=own.filter(function(r){return (r.node||r.area)!=='filters';});
            CONTROL_STEPS.forEach(function(step){
                var model=entry.control && entry.control[id+'|'+step];
                if (!model) return;
                own=own.filter(function(r){return (r.node||r.area)!==step;});
                if (ctCurrent(entry) && model.state==='done' && model.result) own=own.concat(model.result.recommendations || []);
            });
            return own.map(function(r){
                if (!d) return r;
                var q=Object.assign({},r,{id:id+':'+r.id,dataset:id});
                if (r.group) q.group=id+':'+r.group;
                return q;
            });
        }
        function filterDraftRecs(entry) {
            var f=ftFor(entry), key=ftKey(true);
            if (!f || ft.drafts[key] || ft.job) return [];
            return filterRecs(f.result).map(function(r){return Object.assign({},r,{dataset:null,supportedBy:[],filterSource:f.source.title,filterDraft:'filter:'+key});});
        }
        function finalIds(entry) {
            var state=tuningState(entry);
            return Object.keys(state.finalByProfile).sort(function(a,b){return +a-+b;}).map(function(p){return state.finalByProfile[p];}).filter(Boolean);
        }
        function contextIds(entry) {
            if (!configList(entry.result).length) return ['all'];
            return view.tab==='export' ? finalIds(entry) : [view.dataset];
        }
        function exportRecsOf(entry) {
            return [].concat.apply([],contextIds(entry).map(function(id){return draftRecs(entry,id);})).concat(filterDraftRecs(entry));
        }
        function draftPicks(entry,id,recs) {
            var state=tuningState(entry), draft=state.drafts[id]||(state.drafts[id]={selected:{}}), out={};
            recs.forEach(function(r,i){
                var signature=r.id+'|'+(r.cli||[]).join(';');
                if (draft.selected[signature]===undefined) draft.selected[signature]=canPick(recs,i)&&membersOf(recs,i).every(function(k){return pickDefault(recs[k]);});
                if (draft.selected[signature]) out[i]=true;
            });
            return out;
        }
        function picksOf(entry) {
            var out={}, offset=0;
            contextIds(entry).forEach(function(id){var recs=draftRecs(entry,id), picks=draftPicks(entry,id,recs);Object.keys(picks).forEach(function(k){out[+k+offset]=true;});offset+=recs.length;});
            var filters=filterDraftRecs(entry), selected=draftPicks(entry,'filter:'+ftKey(true),filters);
            Object.keys(selected).forEach(function(k){out[+k+offset]=true;});
            entry.picks=out;
            return out;
        }
        function savePicks(entry,recs,picks) {
            var state=tuningState(entry);
            recs.forEach(function(r,i){var id=r.filterDraft || (configOf(entry.result,r.dataset) ? r.dataset : 'all'), draft=state.drafts[id]||(state.drafts[id]={selected:{}});draft.selected[r.id+'|'+(r.cli||[]).join(';')]=!!picks[i];});
        }
        function compiledPlan(entry) {
            var ids=configList(entry.result).length ? finalIds(entry) : ['all'], records=[], picks={}, missing=[];
            var filters=filterDraftRecs(entry), filterPicks=draftPicks(entry,'filter:'+ftKey(true),filters), filterPlan=pendingPlan(filters,filterPicks);
            ids.forEach(function(id){
                var recs=draftRecs(entry,id), selected=draftPicks(entry,id,recs), offset=records.length, d=configOf(entry.result,id);
                records=records.concat(recs); Object.keys(selected).forEach(function(i){picks[+i+offset]=true;});
                if (!d || !d.exportBase) return;
                var own=pendingPlan(recs,selected), overwritten=new Set(own.rows.concat(filterPlan.rows).filter(function(q){return q.scope==='profile'&&q.index===d.pidProfile-1;}).map(function(q){return q.name;}));
                (d.exportBase.records||[]).forEach(function(r){if(!overwritten.has(r.parameter)){picks[records.length]=true;records.push(r);}});
                (d.exportBase.unsupported||[]).forEach(function(q){if(!overwritten.has(q.name)) missing.push({configuration:id,name:q.name,reason:q.reason});});
            });
            var offset=records.length; records=records.concat(filters); Object.keys(filterPicks).forEach(function(i){picks[+i+offset]=true;});
            var plan=pendingPlan(records,picks);plan.records=records;plan.picks=picks;plan.unsupported=missing;plan.configurations=ids;
            plan.signature+=JSON.stringify([ids,missing]);entry.pending=plan;return plan;
        }
        function finalProfilesHtml(entry) {
            var list=configList(entry.result), state=tuningState(entry), profiles=Object.keys(state.finalByProfile).sort(function(a,b){return +a-+b;});
            var source=ftSource(), filterNote=source ? '<section class="tuning-final-filter"><h5 class="tuning-h">Filter tune for export</h5><p>' + esc(source.title) +
                (filterDraftRecs(entry).length ? ' · Filter result available' : ' · No filter result for export') + '</p><a href="#" class="tuning-tab-link" data-tab="filters">Select the log or flight in Filters</a></section>' : '';
            if (!list.length) return filterNote;
            return filterNote + '<section class="tuning-final-profiles"><h5 class="tuning-h">Control configuration for each PID profile</h5><p>Select one recorded configuration for the control changes of each PID profile. The filter tune uses the log or flight above.</p><p class="tuning-muted">The export also includes recorded values that are different from the newest configuration of that PID profile. Global values apply to all PID profiles.</p>'+profiles.map(function(p){return '<label>'+esc(profileLabel(+p))+'<select class="form-control input-sm tuning-final-config" data-profile="'+p+'">'+options([['','No changes']].concat(list.filter(function(d){return d.pidProfile===+p;}).map(function(d){var rs=draftRecs(entry,d.id),ps=draftPicks(entry,d.id,rs);return [d.id,configLabel(d.id)+' — '+Object.keys(ps).length+' selected changes'];})),state.finalByProfile[p])+'</select></label>';}).join('')+(list.some(function(d){return !d.pidProfile;}) ? '<p class="tuning-muted">A configuration with an unknown PID profile is available for analysis only.</p>' : '')+'</section>';
        }

        // The script of the selected recommendations: { sig, state: "none" | "loading" | "ready" | "na", text, why (a message
        // of the worker), say (our own sentences) }. The derive worker runs advice.cjs exportScript(recommendations, picks:
        // their ids, meta); its answer is the text. A new selection makes a new request, and the answer of an old one is not
        // used. A selection with only a part of a group gives no file
        function exportModel(entry) {
            var plan=compiledPlan(entry), recs=plan.records, picks=plan.picks, ids=[], part=partGroups(recs,picks);
            recs.forEach(function (rec, i) { if (picks[i] && hasCli(rec)) ids.push(String(rec.id)); });
            var sig = (part.length ? "part|" : "") + ids.join("\n") + plan.signature, m = entry.exported;
            if (m && m.sig === sig) return m; // a failed request is not sent again until the selection changes
            if (plan.unsupported.length) return (entry.exported={sig:sig,state:"na",say:"The selected recorded configuration has values that the app cannot export: "+plan.unsupported.map(function(q){return q.name;}).join(", ")+"."});
            if (plan.conflicts.length) return (entry.exported = {sig:sig,state:"na",say:"Two selected changes give different values for the same parameter. Select one before export."});
            if (part.length) {
                return (entry.exported = { sig: sig, state: "na", say: "The changes of group " + part.map(groupLabel).join(" and ") +
                    " go into the CLI file together. Select all the changes of the group, or none of them." });
            }
            if (!ids.length) return (entry.exported = { sig: sig, state: "none" });
            m = entry.exported = { sig: sig, state: "loading" };
            ask({ cmd: "export", withPlan:true, recs: recs, picks: ids, meta: Object.assign(exportMeta(entry),configList(entry.result).length ? {configurations:plan.configurations.map(function(id){var d=configOf(entry.result,id);return d ? configLabel(id)+" ("+profileLabel(d.pidProfile)+")" : "";}).filter(Boolean).join(", ")} : {}) }).then(function (out) {
                var text=typeof out === 'string' ? out : out && out.text;
                if (typeof text !== "string") throw new Error("the answer of the worker has no text");
                m.text = text;
                m.flightPlan = out && out.flightPlan || null;
                m.state = "ready";
            }).catch(function (e) {
                m.state = "na";
                m.why = e && e.message ? String(e.message) : String(e);
            }).then(function () {
                if (shown === entry && entry.exported === m) refreshExport();
            });
            return m;
        }

        function refreshExport() {
            if (!shown || rendered["export"] !== shown) return;
            body.find(".tuning-export-preview").html(exportPreview(shown, env));
            renderTabStatus();
        }

        function saveCli() {
            var m = shown && shown.exported;
            if (!m || m.state !== "ready") return;
            pickSaveFile({
                suggestedName: baseName(shown) + (shown.scope === "log" ? "-log" + (shown.logIndex + 1) : "") + "-cli.txt",
                description: "CLI commands", mimeType: "text/plain", extension: ".txt"
            }).then(function (target) {
                if (target) return target.write(new Blob([m.text], { type: "text/plain" }));
            }).catch(function (error) { reportSaveError(error); });
        }

        // Control proposals belong to one completed analysis and configuration.
        // Changed inputs and canceled requests cannot contribute CLI commands.
        function ctCurrent(entry) {
            return !!entry && entry === shown && (entry.key === currentKey() || sameFlights());
        }
        function ctModel(step) {
            var model=shown && shown.control && shown.control[view.dataset+'|'+step];
            return Object.assign({state:'none'},model||{},{stale:!ctCurrent(shown)});
        }
        function ctRefresh() {
            CONTROL_STEPS.concat(['export','recs']).forEach(function(k){rendered[k]=null;});
            if (shown) { shown.exported=null; showTab(view.tab); }
        }
        function ctStart() {
            var entry=shown, step=view.tab, d=entry && configOf(entry.result,view.dataset);
            if (!ctCurrent(entry) || CONTROL_STEPS.indexOf(step)<0 || !d || !d.pidProfile || !(configFlight(d)>0)) return;
            var key=d.id+'|'+step, models=entry.control || (entry.control={}), model=models[key]={state:'running'};
            ctRefresh();
            // The analysis already decoded and measured the flight. Send only
            // the configuration, advice and gain decisions, without its curves.
            ask({cmd:'controlTune',configuration:d.id,step:step,analysis:{
                datasets:{datasets:[d]}, advice:{byDataset:entry.result.advice && entry.result.advice.byDataset || {}},
                decisions:entry.result.decisions || []
            }}).then(function(result){
                if (models[key]!==model) return;
                if (!result || result.configuration!==d.id || result.step!==step) throw new Error('The control result does not agree with the selected configuration.');
                model.state='done'; model.result=result;
            }).catch(function(e){if(models[key]===model){model.state='failed';model.error=String(e.message||e);}}).then(function(){if(shown===entry && models[key]===model) ctRefresh();});
        }
        function ctClear(state) {
            if (!shown || CONTROL_STEPS.indexOf(view.tab)<0) return;
            var models=shown.control || (shown.control={});
            models[view.dataset+'|'+view.tab]={state:state || 'none'};
            ctRefresh();
        }

        // --- the filter calculation (SPEC3 G, M2): its own worker, one run at a time, for the open file

        // The settings of a calculation: the file, the flights ("Selected flights", else all flight logs), the flight rpm and the
        // CLI dump; null without a file
        function ftSources() { return shown ? filterSources(shown.result) : []; }
        function ftSource() {
            var info = fileInfo(), list = ftSources();
            if (!info || !list.length) return null;
            var source = list.find(function(s){return s.key === ft.sources[info.key];}) || list.find(function(s){return s.log === currentLog();}) || list[list.length-1];
            ft.sources[info.key] = source.key;
            return source;
        }
        function ftLimit() { var key=ftKey(true);return ft.limits[key]!==undefined ? ft.limits[key] : .5; }
        function ftRpm() { return shown && shown.key === currentKey() && shown.result.flightRpm && isNum(shown.result.flightRpm.value) ? shown.result.flightRpm.value : null; }
        function ftKey(sourceOnly) {
            var info = fileInfo(), c = usedCli(), source = ftSource();
            if (!info || !source) return null;
            var baseline = filterBaseline(shown.result,source);
            return [info.key, 'flight:' + source.key, JSON.stringify(baseline), ftRpm() === null ? 'auto' : ftRpm(), c ? c.hash : 'no-cli'].concat(sourceOnly ? [] : ['delay:' + ftLimit()]).join('|');
        }

        // The calculation of the result entry for the CLI file: the one of the settings of now, for the file of the entry
        function ftFor(entry) {
            var key = ftKey();
            return key ? ft.cache.filter(function (e) { return e.key === key && e.fileKey === entry.fileKey; })[0] || null : null;
        }

        function ftUnavailable() {
            return ftSource() ? '' : 'The analysis has no flight data for filter tuning.';
        }

        // The state of the calculation for the view (filterSearchHtml): the run, else the result of the settings of now, else the
        // newest result of the open file (stale), with an error or a cancel of these settings
        function ftModel() {
            var info = fileInfo(), key = ftKey(), j = ft.job;
            var hit = key ? ft.cache.filter(function (e) { return e.key === key; })[0] : null;
            var source = ftSource(), mine = info && source ? ft.cache.filter(function (e) { return e.fileKey === info.key && e.source.key === source.key; }) : [], e = hit || mine[mine.length - 1] || null;
            var m = { state: "none", result: e ? e.result : null, stale: !!e && !hit, other: false, cli: !!cli || (!!e && !!e.cli) }; // cli: a CLI dump now or in the result
            if (j && info && j.fileKey === info.key) {
                m.state = "running";
                m.fraction = j.last && isNum(j.last.fraction) ? j.last.fraction : null;
                m.text = j.last && j.last.text ? j.last.text : "";
            } else if (ft.failure && ft.failure.key === key) {
                m.state = "failed";
                m.error = ft.failure;
            } else if (ft.cancelled && ft.cancelled.key === key) {
                m.state = "canceled";
            } else if (e) {
                m.state = "done";
            }
            m.maxAddMs = ftLimit(); m.draft = ft.drafts[ftKey(true)] || null; m.dirty = !!m.draft; m.hasAutotune = !!ft.auto[ftKey(true)];
            m.source = source; m.sources = ftSources(); m.baseline = shown ? filterBaseline(shown.result,source) : [];
            m.recordedChecks = shown ? (shown.result.findings || []).filter(function(f){
                return /^(F\d+|C11)$/.test(f.id) && (!source || onLog(f,source.log)) &&
                    (!f.dataset || !m.baseline.length || m.baseline.some(function(q){return q.id === f.dataset;}));
            }) : [];
            m.unavailable = ftUnavailable();
            return m;
        }

        // The panes with the calculation are drawn again: the Filters tab, the diagram (the side panel of the Filters step) and the
        // CLI file
        function ftRefresh() {
            TABS.forEach(function (t) { rendered[t.key] = null; });
            if (shown) showTab(view.tab);
        }

        // A progress message: the bar and the text only
        function ftProgress() {
            var m = ftModel(), frac = isNum(m.fraction) ? Math.max(0, Math.min(1, m.fraction)) : null;
            body.find(".tuning-ft-progress-text").text((m.text ? oneLine(m.text) : FT.running) + (frac !== null ? " (" + Math.round(frac * 100) + " %)" : ""));
            body.find(".tuning-ft-bar").css("width", (frac === null ? 100 : frac * 100).toFixed(1) + "%");
        }

        function ftStop() {
            var j = ft.job;
            ft.job = null;
            if (ft.worker) { try { ft.worker.terminate(); } catch (e) { /* already gone */ } }
            else if (j) { try { j.worker.terminate(); } catch (e) { /* already gone */ } }
            ft.worker = null; ft.workerKey = null;
        }

        function ftFail(j, message, detail) {
            if (j !== ft.job) return;
            ft.failure = { key: j.key, message: message, detail: oneLine(detail || "") };
            ftStop();
            ftRefresh();
        }

        function ftStart(mode) {
            var info = fileInfo(), log = viewerLog(), rpm = null, c = usedCli(), key = ftKey();
            if (!info || !log || ftUnavailable()) return false;
            var sourceKey = ftKey(true), reuse = !ft.job && ft.worker && ft.workerKey === sourceKey;
            if (!reuse) ftStop();
            ft.failure = ft.cancelled = null;
            var source = ftSource(), list = [{log:source.log,flight:source.flight}], w,
                h = shown && shown.fileKey === info.key ? hierFor(shown.result,'all','all') : null;
            // the gates of the Filters step in the diagram (hierarchy.nodes.filters.blockedBy): the changes wait for them
            var states = filterBaseline(shown.result,source).map(function(q){return shown.result.hierarchy && shown.result.hierarchy.byDataset && shown.result.hierarchy.byDataset[q.id];}).filter(Boolean);
            if (!states.length) states=[h];
            var gates=[];
            states.forEach(function(state){((state && state.nodes && state.nodes.filters && state.nodes.filters.blockedBy) || []).forEach(function(g){if(gates.indexOf(String(g))<0)gates.push(String(g));});});
            if (!isNum(ftLimit()) || ftLimit() < 0 || ftLimit() > 20) { ft.failure = {key:key,detail:"The maximum added time delay must be a number from 0 to 20 ms."}; ftRefresh(); return false; }
            var draft = ft.drafts[sourceKey], previous = ftModel().result;
            var values = {};
            if (mode !== "load") { ((previous && previous.parameters) || []).filter(function(q){return q.editable;}).forEach(function(q){values[q.key]=q.to;}); Object.assign(values,draft||{}); }
            var msg = { cmd: reuse ? "filterReplay" : "filterTune", workspaceKey: sourceKey, id: ++ft.seq, bytes: reuse ? undefined : info.bytes.slice().buffer, fileName: info.name, selectedLog: source.log, logCount: log.getLogCount(),
                // reuse the threshold derived from the recorded governor configuration only for the current analysis
                options: { flightRpm: ftRpm(),
                    cliText: c ? c.text : null, cliName: c ? c.name : null, flights: list, logs: [source.log],
                    blockedBy: gates, maxAddMs: ftLimit() } };
            var ds=shown && datasetsOf(shown.result);
            if (ds) msg.options.recordedConfigurations={datasets:ds.datasets.map(function(d){return {id:d.id,pidProfile:d.pidProfile||0,values:d.values,sources:d.sources};}),
                labels:(ds.labels||[]).filter(function(q){return q.log===source.log;})};
            if (mode === "simulate" || mode === "load") msg.options.simulate = values;
            try {
                w = reuse ? ft.worker : new Worker("js/tuning_worker.js");
                ft.worker = w; ft.workerKey = sourceKey;
            } catch (e) {
                ft.failure = { key: key, message: FT.failed, detail: e && e.message || String(e) };
                ftRefresh();
                return false;
            }
            var j = ft.job = { id: msg.id, key: key, fileKey: info.key, worker: w, started: Date.now(), last: null };
            w.onmessage = function (e) {
                var m = e.data || {};
                if (j !== ft.job || m.id !== j.id) return;
                if (m.type === "progress") {
                    j.last = m;
                    ftProgress();
                } else if (m.type === "error") {
                    ftFail(j, m.message, m.message);
                } else if ((m.type === "filterTuned" || m.type === "result") && m.result) {
                    ft.cache = ft.cache.filter(function (x) { return x.key !== j.key; }).concat([{ key: j.key, sourceKey:sourceKey, cli:!!c, source:source, fileKey: j.fileKey, result: m.result, finishedAt: Date.now() }]);
                    ft.job = null;
                    delete ft.drafts[sourceKey];
                    if (m.result.mode === "autotune") ft.auto[sourceKey] = m.result;
                    if (m.result.version !== 2) ftStop();
                    ftRefresh();
                }
            };
            w.onerror = function (e) {
                if (e && e.preventDefault) e.preventDefault();
                ftFail(j, "The script of the analysis stopped.", e && e.message || "script error");
            };
            try {
                w.postMessage(msg, msg.bytes ? [msg.bytes] : []);
            } catch (e) {
                ftFail(j, "The app cannot send the log to the worker.", e && e.message || String(e));
                return false;
            }
            ftRefresh();
            return true;
        }

        function ftCancel() {
            if (!ft.job) return;
            ft.cancelled = { key: ft.job.key };
            ftStop();
            ftRefresh();
        }

        // --- panes and plots

        function detailBody(model) {
            var previous = env.extra;
            env.extra = [];
            try {
                var out = model.build();
                out.plots = (out.plots || []).concat(env.extra);
                out.plots.forEach(function (p) { p.detailId = model.id; });
                return out;
            } finally {
                env.extra = previous;
            }
        }

        function detailHtml(key, label, classes, open, build, summaryAttrs) {
            var id = uid + '-detail-' + (++detailSeq), owner = key.split(':')[0];
            if (detailOpen[key] !== undefined) open = detailOpen[key];
            var model = details[id] = { id: id, key: key, owner: owner, entry: shown, build: build, loaded: !!open };
            var out = open ? detailBody(model) : { html: '', plots: [] };
            Array.prototype.push.apply(env.extra, out.plots);
            return '<details class="' + classes + '" data-tuning-detail="' + id + '" data-tuning-detail-key="' + esc(key) + '"' + (open ? ' open' : '') +
                '><summary' + (summaryAttrs || '') + '>' + label + '</summary><div class="tuning-detail-body">' + out.html + '</div></details>';
        }

        function clearDetails(owner) {
            Object.keys(details).forEach(function (id) { if (details[id].owner === owner) delete details[id]; });
        }

        // toggle does not bubble. Capture it so mouse, keyboard and programmatic disclosure changes use the same path.
        // Insert only the body: the summary keeps keyboard focus and the primary plot is not replaced.
        function toggleDetails(e) {
            var el = e.target, id = el && el.getAttribute && el.getAttribute('data-tuning-detail'), model = details[id];
            if (!model || model.entry !== shown) return;
            detailOpen[model.key] = !!el.open;
            var target = el.querySelector('.tuning-detail-body');
            if (!target || model.loaded === !!el.open) return;
            if (el.open) {
                var out;
                try {
                    out = detailBody(model);
                } catch (error) {
                    console.error(error);
                    target.innerHTML = notice('error', 'The app cannot show this tab because of an error: ' + quoted(esc(error && error.message || error)));
                    return;
                }
                target.innerHTML = out.html;
                model.loaded = true;
                pending[model.owner] = (pending[model.owner] || []).concat(out.plots);
                if (visible && (model.owner === view.tab || model.owner === 'configuration')) attachPlots(model.owner);
            } else {
                handles[model.owner] = (handles[model.owner] || []).filter(function (h) {
                    if (h.detailId !== id) return true;
                    h.destroy();
                    return false;
                });
                pending[model.owner] = (pending[model.owner] || []).filter(function (p) { return p.detailId !== id; });
                target.innerHTML = '';
                model.loaded = false;
            }
        }
        if (dialog[0] && dialog[0].addEventListener) dialog[0].addEventListener('toggle', toggleDetails, true);

        function destroyPlots(key) {
            (handles[key] || []).forEach(function (h) {
                try { h.destroy(); } catch (e) { console.warn(e); }
            });
            handles[key] = [];
            delete pending[key];
        }

        // Plots need laid-out canvases, so they attach once the view is shown. Their height is the stylesheet's
        // (.tuning-plot-canvas in css/tuning_dialog.css, sized to the window), so the spec gives none
        function attachPlots(key) {
            var list = pending[key] || [];
            delete pending[key];
            list.forEach(function (p) {
                var canvas = document.getElementById(p.id), why = "the app did not load js/tuning_plot.js";
                if (!canvas) return;
                try {
                    if (typeof TuningPlot !== "undefined") {
                        var h = TuningPlot.attach(canvas, p.spec);
                        h.filterComparison = p.filterComparison;
                        h.detailId = p.detailId;
                        return (handles[key] = handles[key] || []).push(h);
                    }
                } catch (e) {
                    console.error(e);
                    why = "the plot stopped because of an error: " + (e && e.message || e);
                }
                canvas.parentNode.className = "tuning-plot is-na";
                canvas.parentNode.innerHTML = '<div class="tuning-plot-title">' + esc(p.spec.title) + '</div><div class="tuning-na">Not available: ' + esc(why) + "</div>";
            });
        }

        function renderPane(key) {
            if (!shown) return;
            if (preview && preview.pane === key) closeLogPreview();
            destroyPlots(key);
            clearDetails(key);
            var out;
            env.pane = key;
            env.extra = [];
            try {
                out = renderTab(key, shown, view, env);
            } catch (e) {
                console.error(e);
                out = { html: notice("error", "The app cannot show this tab because of an error: " + quoted(esc(e && e.message || e))), plots: [] };
            }
            pane(key).html(out.html);
            rendered[key] = shown;
            pending[key] = out.plots.concat(env.extra);
            env.extra = [];
            if (visible) attachPlots(key);
        }

        function showTab(key) {
            if (key !== view.tab) closeLogPreview();
            view.tab = TABS.some(function (t) { return t.key === key; }) ? key : "overview";
            body.find('.tuning-configuration').toggleClass('tuning-hide',view.tab === 'filters' || !shown || !configList(shown.result).length);
            TABS.forEach(function (t) {
                body.find('.tuning-tab[data-tab="' + t.key + '"]').toggleClass("active", t.key === view.tab).attr('aria-current', t.key === view.tab ? 'page' : 'false');
                pane(t.key).toggleClass("active", t.key === view.tab);
            });
            if (rendered[view.tab] !== shown) renderPane(view.tab);
            else if (visible) attachPlots(view.tab);
            renderTabStatus();
        }

        function renderTabStatus() {
            if (!shown) return;
            var r = shown.result, hier = hierFor(r, view.profile, view.dataset), model = ftModel(), filters = filterTabStates(model);
            var fs = (r.findings || []).filter(function (f) { return inView(f, view); });
            var states = {}, current = ctCurrent(shown);
            states.filters = filters;
            states.overview = fs.filter(function (f) { return !/^(F\d+|C11)$/.test(f.id); }).map(findingStatus).concat(filters);
            CONTROL_STEPS.forEach(function (step) {
                states[step] = findingsAt(r, step, nodeState(hier, step).entry, env).filter(function (f) { return inView(f, view); }).map(findingStatus);
                if (ctModel(step).state === 'failed') states[step].push('error');
            });
            if (!current) ['overview'].concat(CONTROL_STEPS).forEach(function (key) { states[key].push('insufficient'); });
            var plan = compiledPlan(shown), conflicts = plan.conflicts.length + plan.unsupported.length + partGroups(plan.records, plan.picks).length;
            var changes = plan.records.filter(function (rec, i) { return plan.picks[i] && hasCli(rec); }).length;
            TABS.filter(function (t) { return !t.auxiliary; }).forEach(function (t) {
                var summary = tabStatus(states[t.key] || []), scope = t.key === 'filters' ? (model.source ? model.source.title + '. ' : '') :
                    t.key === 'overview' ? 'Selected control configuration and filter flight. ' :
                    view.dataset !== 'all' ? configLabel(view.dataset) + '. ' : '';
                if (t.key === 'filters' && summary.key === 'satisfactory' && model.result && model.result.checklist) summary.label = 'Satisfactory in replay';
                if (t.key === 'export') {
                    summary = {key: conflicts ? 'problem' : changes ? 'monitor' : 'information',
                        label: conflicts ? 'Cannot export' : changes ? plural(changes, 'change') + ' to examine' : 'No changes'};
                    scope = 'Selected changes from all tuning steps. ';
                }
                var selector = '.tuning-tab[data-tab="' + t.key + '"]', tab = body.find(selector);
                var description = (t.title + ': ' + summary.label + '. ' + scope).trim();
                // Avoid replacing navigation text during routine progress refreshes.
                if (tab.attr('title') === description) return;
                Object.keys(STATUS).forEach(function (s) { tab.toggleClass('st-' + cls(s), s === summary.key); });
                tab.attr('title', description).attr('aria-label', description);
                body.find(selector + ' .tuning-tab-status').text(summary.label);
            });
        }

        function clearPanes() {
            closeLogPreview();
            TABS.forEach(function (t) { destroyPlots(t.key); pane(t.key).html(""); });
            details = {};
            configurationRendered = null;
            rendered = {};
            copyTexts = [];
        }

        function notify() {
            var result = self.getResult();
            listeners.slice().forEach(function (cb) {
                try { cb(result); } catch (e) { console.error(e); }
            });
        }

        // The configuration on display goes to the log lens and the Analysis view (getConfiguration, onConfiguration)
        function notifyConfig() {
            var id = view.dataset;
            configListeners.slice().forEach(function (cb) {
                try { cb(id); } catch (e) { console.error(e); }
            });
        }

        // The configuration menu: "all" or the id of a configuration of the result on display. A configuration with a known
        // PID profile also selects that PID profile; the panes that show them are drawn again
        function setConfig(id) {
            var r = shown && shown.result, d = r ? selectedConfig(r, String(id)) : null;
            var next = d ? d.id : "all";
            if (next === view.dataset) return false;
            view.dataset = next;
            if (d) view.profile = isNum(d.pidProfile) ? d.pidProfile : "all";
            view.compare = null;
            TABS.forEach(function(t){rendered[t.key]=null;});
            renderChrome();
            if (shown) showTab(view.tab);
            notifyConfig();
            return true;
        }

        function display(entry) {
            shown = entry;
            failure = null;
            view.segment = null;
            view.vibProfile = null;
            view.node = null;
            view.focus = null;
            view.compare = null;
            if (view.profile !== "all" && profileList(entry.result).indexOf(view.profile) < 0) view.profile = "all";
            var hadConfig = view.dataset;
            var selected = selectedConfig(entry.result, view.dataset);
            view.dataset = selected ? selected.id : "all";
            if (ft.workerKey && ft.workerKey !== ftKey(true)) ftStop();
            if (selected) view.profile=selected.pidProfile||0;
            compares = {};
            cmpSlots = {};
            clearPanes();
            var n = { recs: recsOf(entry.result).length, checks: (entry.result.findings || []).length, configs: configList(entry.result).length };
            Object.keys(n).forEach(function (k) { body.find('.tuning-tab[data-tab="' + k + '"] .tuning-tab-count').text(n[k] ? String(n[k]) : ""); });
            renderChrome();
            showTab(view.tab);
            notify();
            if (hadConfig !== view.dataset) notifyConfig();
        }

        function drop() {
            var had = !!shown;
            shown = null;
            view.compare = null;
            compares = {};
            cmpSlots = {};
            clearPanes();
            if (had) notify();
        }

        // --- "Show the measurement"

        function snippetReader() {
            if (!reader && typeof TuningSnippet !== "undefined") reader = new TuningSnippet.Reader({ getFlightLog: viewerLog, getBytes: function () { return hooks.getBytes ? hooks.getBytes() : null; } });
            return reader;
        }

        function compareTitle(f) {
            return "Measurement: " + [f.id, findingAxis(f), profileNo(f) !== null ? profileLabel(profileNo(f)) : "", "log " + logLabel(f.log)].filter(Boolean).join(", ");
        }

        // The title of the bar over the log viewer: "C12 roll, PID profile 1: Monitor"
        function evidenceTitle(f) {
            return [f.id, findingAxis(f)].filter(Boolean).join(" ") + (profileNo(f) !== null ? ", " + profileLabel(profileNo(f)) : "") + ": " + STATUS[findingStatus(f)];
        }

        // The data of the compare panel of a finding: { state: "ready" | "loading" | "na", spec, missed, table | why, rows, note }
        function compareModel(f, spanIndex) {
            var key = env.keyOf(f) + "|" + spanIndex, have = compares[key];
            if (have) return have;
            var ev = f.evidence || {}, plot = ev.plot || {}, r = shown.result, log = isNum(ev.log) ? ev.log : typeof f.log === "number" ? f.log : r.logIndex;
            var rows = plot.kind !== "table" && Array.isArray(plot.rows) && plot.rows.length ? plot.rows : null;
            function ready(model, got) {
                var out = compareSpec(f, ev, got, compareTitle(f), { periods: profilePeriods(r, log) });
                if (out.onlyText) model.note = (model.note ? model.note + " " : "") + out.onlyText;
                return Object.assign(model, { state: "ready", spec: out.spec, missed: out.missed, rows: rows });
            }
            if (plot.kind === "table") return (compares[key] = { state: "ready", table: plot.rows || plot.table || [], note: "" });
            // events: the values that the check judges, one point each (evidence.cjs points, frame seconds)
            var points = Array.isArray(plot.points) ? plot.points.filter(function (q) { return q && isNum(q.t) && isNum(q.value); }) : [];
            if (plot.kind === "events" && points.length > 1) {
                return (compares[key] = ready({ fromCurve: true, note: "Source: the values of the check in log " + logLabel(log) + "." }, { x: points.map(function (q) { return q.t; }), xs: "t",
                    series: [{ key: "value", name: [f.id, findingAxis(f)].filter(Boolean).join(" "), y: points.map(function (q) { return q.value; }), unit: f.unit && f.unit !== "fraction" ? String(f.unit) : null, points: true }] }));
            }
            if (plot.curve) {
                var curves = Array.isArray(r.curves) ? r.curves.filter(function (c) { return c.log === log; }) : [];
                var curve = curves.sort(function (a, b) { return (b.seconds || 0) - (a.seconds || 0); })[0], got = curve && curveSeries(curvePath(curve, plot.curve), plot.kind);
                if (got) {
                    if (got.xs === "t") {
                        var rec = recordAt(r, log, null, curve.segment), tm = rec && rec.timeMap;
                        got.x = Array.prototype.map.call(got.x, function (t) { return toFrame(tm, t); });
                    }
                    return (compares[key] = ready({ fromCurve: true, note: "Source: the curves of log " + logLabel(log) + "." }, got));
                }
                if (!plot.snippet) return (compares[key] = { state: "na", say: noCurveText(r, log, curves.length > 0) });
            }
            var snip = plot.snippet, spans = Array.isArray(ev.spans) ? ev.spans.filter(function (s) { return s && isNum(s.t0) && isNum(s.t1); }) : [];
            var sp = spans[spanIndex] || spans[0] || (ev.view && isNum(ev.view.t0) ? ev.view : null);
            if (!snip || !Array.isArray(snip.fields) || !snip.fields.length || !sp) return (compares[key] = { state: "na", why: "this result has no plot" });
            var rd = snippetReader();
            if (!rd) return (compares[key] = { state: "na", why: "the app did not load js/tuning_snippet.js" });
            var li = isNum(sp.log) ? sp.log : log, t0 = Math.min(sp.t0, sp.t1), t1 = Math.max(sp.t0, sp.t1), at = isNum(ev.view && ev.view.at) ? ev.view.at : (t0 + t1) / 2;
            if (t1 - t0 > COMPARE_S) {
                t0 = Math.max(t0, Math.min(at - COMPARE_S / 2, t1 - COMPARE_S));
                t1 = t0 + COMPARE_S;
            }
            var model = compares[key] = { state: "loading" }, entry = shown;
            rd.read(li, t0, t1, snip.fields).then(function (data) {
                if (!data.frames) throw new Error("the log has no frames from " + num(+t0.toFixed(2)) + " s to " + num(+t1.toFixed(2)) + " s");
                var d = snip.derive, raw = function () { return { x: data.t, xs: "t", series: Object.keys(data.cols).map(function (k) { return { key: k, name: k, y: data.cols[k], unit: fieldUnit(k) }; }) }; };
                // a derive that fails: the columns as the log records them, and why (the worker's message)
                return (d && d.kind ? self.derive(d.kind, data.cols, data.rate, d.params || {}).catch(function (e) { model.derr = e && e.message ? String(e.message) : String(e); return null; }) :
                    Promise.resolve(null)).then(function (out) {
                    var got = out ? derivedSeries(out, data, plot.kind) : raw();
                    if (!got || !got.series.length) throw new Error("the derived data have no series");
                    ready(model, got);
                    model.note = "Source: log " + logLabel(li) + ", " + num(+data.t0.toFixed(2)) + " s to " + num(+data.t1.toFixed(2)) + " s." +
                        (data.missing && data.missing.length ? " Not in this log: " + data.missing.join(", ") + "." : "");
                });
            }).catch(function (e) {
                model.state = "na";
                model.why = e && e.message ? String(e.message) : String(e);
            }).then(function () {
                if (shown === entry) refreshCompare(key);
            });
            return model;
        }

        function compareHtml(f, where) {
            var ev = f.evidence || {}, spanIndex = view.compare && isNum(view.compare.span) ? view.compare.span : 0, key = env.keyOf(f) + "|" + spanIndex;
            var slot = uid + "-cmp-" + (++plotSeq);
            cmpSlots[key] = { id: slot, where: where };
            var inner = compareBody(f, key, spanIndex), model = compares[key] || {};
            var spans = Array.isArray(ev.spans) ? ev.spans.filter(function (s) { return s && isNum(s.t0) && isNum(s.t1); }) : [];
            var head = '<div class="tuning-compare-head"><strong>' + esc(compareTitle(f)) + "</strong>" +
                (spans.length > 1 && !model.fromCurve && model.table === undefined ? '<span class="btn-group btn-group-xs">' + spans.map(function (s, i) {
                    return '<button type="button" class="btn btn-default tuning-compare-span' + (i === spanIndex ? " active" : "") + '" data-span="' + i + '">Part ' + (i + 1) + "</button>";
                }).join("") + "</span>" : "") +
                '<a href="#" class="tuning-compare-close" title="Close">&times;</a></div>' +
                (ev.expected ? '<div class="tuning-compare-expected"><div class="tuning-label">Satisfactory</div><div>' + esc(ev.expected) + "</div></div>" : "") +
                '<div class="tuning-compare-measured"><div class="tuning-label">Measured</div><div>' + esc(summaryOf(f)) + "</div></div>";
            return '<div class="tuning-compare">' + head + '<div class="tuning-compare-body" id="' + slot + '">' + inner + "</div></div>";
        }

        function compareBody(f, key, spanIndex) {
            var m = compareModel(f, spanIndex), slot = cmpSlots[key], caption = captionHtml(f);
            if (m.state === "loading") return '<p class="tuning-muted">Wait while the app reads the log.</p>';
            if (m.state === "na" && m.say) return '<p class="tuning-na">' + esc(m.say) + "</p>"; // our own sentences
            if (m.state === "na") return '<p class="tuning-na">Not available: ' + quoted(esc(m.why)) + "</p>";
            if (m.table) return compareTable(m.table) + caption;
            var id = env.plotId();
            if (slot) slot.plot = { id: id, spec: m.spec };
            env.extra.push({ id: id, spec: m.spec });
            return '<div class="tuning-plot tuning-compare-plot"><canvas id="' + id + '" class="tuning-plot-canvas"></canvas></div>' + caption +
                (m.note ? '<p class="tuning-muted">' + esc(m.note) + (f.evidence && Array.isArray(f.evidence.spans) && f.evidence.spans.length && m.spec.x.unit === "s" ?
                    " The bands show the parts of the log that the result comes from." : "") + "</p>" : "") +
                (m.derr ? '<p class="tuning-muted">The app cannot filter the data: ' + quoted(esc(m.derr)) + ". The plot shows the values as the log records them.</p>" : "") +
                (m.missed && m.missed.length ? '<p class="tuning-muted">' + esc("This plot cannot show these limits: " + m.missed.join(", ") + ".") + "</p>" : "") +
                (m.rows ? compareTable(m.rows) : "");
        }

        // A header check: { key, value } rows (or [key, value] pairs), all log-derived
        function compareTable(rows) {
            var list = Array.isArray(rows) ? rows : [];
            if (!list.length) return '<p class="tuning-muted">This result has no data for a table.</p>';
            var cols = Array.isArray(list[0]) ? null : Object.keys(list[0]);
            return '<div class="tuning-table-wrap"><table class="tuning-table tuning-compare-table">' + (cols ? "<thead><tr>" + cols.map(function (c) { return "<th>" + quoted(esc(c)) + "</th>"; }).join("") + "</tr></thead>" : "") +
                "<tbody>" + list.map(function (row) {
                    var cells = cols ? cols.map(function (c) { return row[c]; }) : row;
                    return "<tr>" + cells.map(function (v, i) {
                        var param = i === 0 && typeof v === "string" && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(v);
                        return "<td>" + (param ? parameterHtml(v) : "<code>" + esc(num(v)) + "</code>") + "</td>";
                    }).join("") + "</tr>";
                }).join("") + "</tbody></table></div>";
        }

        // An async compare panel is ready: draw it into its slot, when that slot is on display
        function refreshCompare(key) {
            var slot = cmpSlots[key], f, where = slot && paneOf(slot.where);
            if (!slot || !view.compare || rendered[where] !== shown) return;
            f = env.findingOf(key.slice(0, key.lastIndexOf("|")));
            if (!f) return;
            env.extra = [];
            body.find("#" + slot.id).html(compareBody(f, key, +key.slice(key.lastIndexOf("|") + 1)));
            var plots = env.extra;
            env.extra = [];
            pending[where] = (pending[where] || []).concat(plots);
            if (visible && view.tab === where) attachPlots(where);
        }

        // --- the parts above the tabs

        function shownLog() {
            var r = shown.result;
            return isNum(r.logIndex) ? r.logIndex : (curveOf(r, view) || {}).log;
        }

        // The result on display, else the viewer's log. A result keeps the log count of its own file: one dropped on the
        // window since can have another
        function contextHtml() {
            var r = shown && shown.result, li = shown ? shownLog() : currentLog(), log = viewerLog();
            var sc = r ? r.header || {} : log ? log.getSysConfig() : {}, items = ["<strong>" + (sc["Craft name"] ? quoted(esc(sc["Craft name"])) : "No name") + "</strong>"];
            if (sc["Firmware revision"]) items.push(quoted(esc(sc["Firmware revision"])));
            if (log) {
                var count = shown ? shown.logCount : log.getLogCount(), rec = r && isNum(li) ? logRecord(r, li) : null;
                items.push(esc(shown && shown.scope === "flights" ? "Selected flights" : r && fileLike(r) ? "All flights in the file (" + plural(count, "log") + ")" : "Log " + ((isNum(li) ? li : currentLog()) + 1) + " of " + count));
                if (shown && shown.scope === "flights") items.push(esc(runSelectionText(shown)));
                if (r && fileLike(r) && isNum(li)) items.push(esc("Curves of log " + (li + 1)));
                if (rec) {
                    items.push(esc("Length " + secs(rec.durationS) + ", " + secs(rec.flyingS) + " in flight"));
                    if (profilesText(rec, startProfile(r, li))) items.push(esc(profilesText(rec, startProfile(r, li))));
                    if (startHtml(r, li)) items.push(startHtml(r, li)); // D12: the PID profile at the start of this log and its basis
                    items.push(esc("Log rate " + num(rec.rate) + " Hz" + (isNum(rec.actualRate) ? ", measured " + rec.actualRate.toFixed(1) + " Hz" : "")));
                    if (excludedText(rec.excluded)) items.push(esc("Not in the analysis: " + excludedText(rec.excluded)));
                    if (excludedText(rec.excluded) && isNum(rec.normalS)) items.push(esc("Flight in the analysis: " + secs(rec.normalS)));
                }
                var fl = r ? flightsOf(r) : null;
                if (fl && shown.scope === "flights") fl = onlyLogs(fl, (shown.flights || []).map(function (x) { return x.log; })); // the logs of the selection
                if (fl) items = items.concat(flightsHtml(fl, r, li));
                if (!r) {
                    items.push(esc("Length " + secs((log.getMaxTime() - log.getMinTime()) / 1e6)));
                    if (headerRate(sc)) items.push(esc("Log rate " + Math.round(headerRate(sc)) + " Hz"));
                }
            }
            return items.map(function (x) { return "<div>" + x + "</div>"; }).join("");
        }

        function noticesHtml() {
            var out = [], info = fileInfo(), r = shown && shown.result, log = viewerLog();
            if (!log) return notice("info", "Open a blackbox log in the log viewer.");
            if (hint) out.push(notice("info", esc(hint)));
            if (cliGone && info && cliGone.fileKey === info.key) {
                out.push(notice("info", "The app removed the CLI dump " + quoted(esc(cliGone.name)) + ", because a different file is open. " +
                    "The analysis of this file uses only the log."));
            }
            var clash = cliConflict();
            if (clash) {
                out.push(notice("warn", "The craft name in the CLI dump (" + quoted(esc(clash.dump)) + ") is not the same as the craft name in the log header (" +
                    quoted(esc(clash.log)) + "). Thus, the analysis does not use the CLI dump. It uses only the values of the log."));
            }
            if (failure) {
                out.push(notice("error", [failure.input ? "" : "<strong>The analysis stopped because of an error.</strong>", esc(failure.message || ""),
                    failure.detail ? quoted(esc(failure.detail)) : ""].filter(Boolean).join(" ") +
                    (failure.stack ? '<details><summary>More information</summary><pre class="tuning-stack">' + esc(failure.stack) + "</pre></details>" : "")));
            }
            if (r) {
                var low = (r.records || []).filter(function (x) { return isNum(x.rate) && x.rate < 1000; }).map(function (x) { return x.log; })
                    .filter(function (l, i, a) { return a.indexOf(l) === i; });
                if (fileLike(r) && low.length) {
                    out.push(notice("warn", esc("The log rate of " + plural(low.length, "log") + " (" + low.slice(0, 12).map(logLabel).join(", ") + (low.length > 12 ? ", …" : "") +
                        ") is less than 1 kHz. " + LOW_RATE)));
                } else if (low.length) {
                    out.push(notice("warn", esc(rateNote((r.records || []).filter(function (x) { return x.log === low[0]; })[0].rate))));
                }
                // "All logs in the file": the worker reads the header for the recommendations from a flight log (headerLog),
                // which is not the selected log when that log is a bench run
                var li = shownLog(), key = currentKey(), head = fileLike(r) && isNum(r.headerLog) && isNum(li) && r.headerLog !== li ? r.headerLog : null;
                if (info && shown.fileKey !== info.key) { // log numbers and settings of two files do not compare
                    out.push(notice("warn", 'These results are for a different file. To examine the open file, click "Start analysis".'));
                } else if (isNum(li) && li !== currentLog()) {
                    out.push(notice("info", esc((r.scope === "log" ? "These results are" : head !== null ? "The curves and the log data are" : "The curves, the log data and the header values of the recommendations are") +
                        " for log " + (li + 1) + ". The log viewer shows log " + (currentLog() + 1) + ". To examine log " + (currentLog() + 1) + ', click "Start analysis".')));
                } else if (key && key !== shown.key && !job && !sameFlights()) {
                    out.push(notice("info", (cli || shown.cliName ? "The logs, the flights or the CLI dump" : "The logs or the flights") +
                        ' are different from this result. To use them, click "Start analysis".')); // the CLI dump only when the pilot loaded one
                }
                out.push(cliStatusHtml(r)); // a CLI dump that does not agree with the log: the log wins

                if (head !== null) out.push(notice("info", esc("Log " + (li + 1) + " is not a flight log. Thus, the recommendations use the log header of log " + (head + 1) + ".")));
                if (r.version !== 1) out.push(notice("warn", esc("The result has version " + r.version + ". This app reads version 1.")));
                if (firmwareNote((r.header || {})["Firmware revision"])) out.push(notice("info", esc(firmwareNote(r.header["Firmware revision"]))));
            } else {
                var sc = log.getSysConfig();
                if (rateNote(headerRate(sc))) out.push(notice("warn", esc(rateNote(headerRate(sc)))));
                if (firmwareNote(sc["Firmware revision"])) out.push(notice("info", esc(firmwareNote(sc["Firmware revision"]))));
            }
            // V9: the run of the view (the automatic run of one log) is not for the values that the pilot selected since
            var now = job && currentKey();
            if (now && job.key !== now) {
                out.push(notice("info", "The analysis that operates at this time uses different logs" + (cli || job.cliName ? " or a different CLI dump" : "") +
                    '. To use the values that you selected, click "Start analysis".'));
            }
            hint = null;
            return out.join("");
        }

        function renderProgress() {
            var frac = 0, text, state = "";
            if (job) {
                var m = job.last || {};
                frac = isNum(m.fraction) ? Math.max(0, Math.min(1, m.fraction)) : null;
                text = (m.text ? oneLine(m.text) : "The analysis starts.") + (frac !== null ? " (" + Math.round(frac * 100) + " %)" : "") + " · " + clock(Date.now() - job.started);
                state = frac === null ? "is-busy" : "is-running";
            } else if (failure && !failure.input) {
                text = "Analysis error";
                state = "is-failed";
            } else if (cancelled) {
                text = "Canceled after " + clock(cancelled.ms);
            } else if (shown) {
                frac = 1;
                text = "Analysis completed: " + shown.label + (shown.result.timing && isNum(shown.result.timing.totalS) ? " in " + secs(shown.result.timing.totalS) : "");
                state = "is-done";
            } else {
                text = viewerLog() ? "No result" : "No log is open";
            }
            progress.attr("class", "tuning-progress " + state);
            progressBar.css("width", (frac === null ? 100 : frac * 100).toFixed(1) + "%");
            progressText.text(text);
        }

        function renderChrome() {
            syncCli(); // a different file: the CLI dump goes before the notices say what the analysis uses
            var r = shown && shown.result, log = viewerLog(), count = log ? log.getLogCount() : 0;
            context.html(contextHtml());
            notices.html(noticesHtml());
            scopeSelect.val(view.scope);
            part("scope-text").text(scopeText());
            var nf = fileFlightCount();
            body.find('.tuning-scope option[value="file"]').text(nf !== null ? "All flights in the file (" + plural(nf, "flight") + ")" : "All flights in the file");
            renderSelection();
            var configurationBox = body.find(".tuning-configuration");
            configurationBox.toggleClass("tuning-hide",view.tab === 'filters' || !shown || !configList(r).length);
            if (!configurationRendered || configurationRendered.entry !== shown || configurationRendered.dataset !== view.dataset) {
                clearDetails('configuration');
                configurationBox.html(shown ? configBar(shown,view,env) : "");
                configurationRendered = { entry: shown, dataset: view.dataset };
            }
            scopeSelect.prop("disabled", !log);
            analyseButton.prop("disabled", !log); // V9: also while a run operates (requestStart)
            cancelButton.prop("disabled", !job);
            saveButton.prop("disabled", !shown);
            cliName.html(cli ? quoted(esc(cli.name)) + (cliConflict() ? ' <span class="tuning-cli-off">(not used)</span>' : "") +
                ' <a href="#" class="tuning-cli-clear" title="Remove the CLI dump">&times;</a>' : "");
            body.find(".tuning-tabs, .tuning-panes").toggleClass("tuning-hide", !shown);
            renderTabStatus();
            empty.toggleClass("tuning-hide", !!shown).html(shown ? "" : '<div class="tuning-intro"><p>' + (job ? "Wait for the result of the analysis." :
                "The analysis examines the filters, the governor, the PID loops, the feedforward, the tail precompensation, the rates and the limits. " +
                "For each result, it shows the measured value, the limit and the part of the log that the result comes from. " +
                "It recommends changes and gives the CLI text for them.") + "</p>" +
                '<p class="tuning-muted">The analysis of one log is completed in approximately 5 s. For "All flights in the file", the analysis also includes the gain analysis. ' +
                "It is completed in 1 to 3 min for each 100 MB of log. " + (usedCli() ? "The analysis uses the log file. It also uses the values of the CLI dump that agree with the log." :
                "The analysis uses only the log file.") + "</p></div>");
            renderProgress();
            notifySettings(); // the "Logs" control of the Analysis view: the settings, the run and the flights that the app knows
        }

        // --- actions

        // Frame second t of log li in the log viewer; only for the file the result is of. With hooks.viewInLog the
        // viewer shows t +- SPAN_S with `what`: { graphs: [[field names], ...], analyser: a field name, title, text }
        function seekTo(li, t, what) {
            var info = fileInfo(), log = viewerLog();
            if (!shown || !info) return false;
            if (shown.fileKey !== info.key) return renderChrome(), false; // another file was opened: say so rather than seek into it
            if (!isNum(li) || !isNum(t) || li < 0 || li >= log.getLogCount() || (log.getLogError && log.getLogError(li))) return false;
            what = what || {};
            return showRequest({ log: li, atS: t, fromS: Math.max(0, t - SPAN_S), toS: t + SPAN_S, graphs: what.graphs || null,
                analyser: what.analyser || null, title: what.title || "", text: what.text || "" });
        }

        // A request of js/main.js viewInLog (frame seconds); without the hook, the old seek of the viewer
        function showRequest(req) {
            if (hooks.viewInLog) {
                var ok = hooks.viewInLog(req);
                if (ok === false) {
                    hint = "The app cannot show this part of the log.";
                    renderChrome();
                }
                return ok !== false;
            }
            var log = viewerLog();
            if (req.log !== currentLog() && hooks.selectLog) hooks.selectLog(req.log);
            if (hooks.seek) hooks.seek(log.getMinTime(req.log) + req.atS * 1e6);
            return true;
        }

        function closeLogPreview(restoreFocus) {
            var origin = preview && preview.origin, row = preview && preview.row, panel = part("log-preview");
            preview = null;
            destroyPlots("log-preview");
            panel.html("").toggleClass("tuning-hide", true);
            // Keep the reusable panel outside a pane before that pane is rendered again.
            if (panel[0] && panel[0].parentNode && body[0].appendChild) body[0].appendChild(panel[0]);
            if (row) row.remove();
            if (origin && origin.classList) origin.classList.remove("active");
            if (restoreFocus && origin && origin.isConnected && origin.focus) origin.focus();
        }

        // The same inline panel as Analysis, directly below the clicked result. Tables use a full-width row.
        function placeLogPreview(panel, origin) {
            if (!origin || !origin.closest || !panel) return null;
            var cell = origin.closest("td, th"), row = cell && cell.closest("tr");
            if (row) {
                var holder = document.createElement("tr"), content = document.createElement("td");
                holder.className = "tuning-log-row";
                content.colSpan = Array.prototype.reduce.call(row.cells, function (n, c) { return n + (c.colSpan || 1); }, 0);
                holder.appendChild(content);
                row.insertAdjacentElement("afterend", holder);
                content.appendChild(panel);
                return holder;
            }
            var line = origin.closest(".tuning-times, .tuning-stale-links, p, li") || origin;
            if (line.insertAdjacentElement) line.insertAdjacentElement("afterend", panel);
            return null;
        }

        // Keep the Tuning view on display. The shared Analysis preview reads raw frames without moving the viewer.
        function previewRequest(req, f, origin) {
            var info = fileInfo();
            if (!shown || !info || shown.fileKey !== info.key) return renderChrome(), false;
            if (preview && origin && preview.origin === origin) { closeLogPreview(true); return true; }
            closeLogPreview();
            var L = typeof LogLens !== "undefined" && LogLens.internals;
            if (!L || !L.logPreview) return false;
            var graphs = Array.isArray(req.graphs) ? req.graphs.filter(function (g) { return Array.isArray(g) && g.length; }) : [];
            if (!graphs.length) {
                var axis = AXES.indexOf(f && findingAxis(f));
                graphs = axis >= 0 ? [["setpoint[" + axis + "]", "gyroADC[" + axis + "]"]] : [["headspeed", "govTarget"]];
            }
            var mine = preview = { req: req, entry: shown, origin: origin || document.activeElement, pane: view.tab },
                model = L.logPreview(f || {}, Object.assign({}, req, { graphs: graphs }), shown.result, snippetReader()),
                panel = part("log-preview");
            panel.html(L.logPreviewHtml(req, model.epochs, {
                viewer: 'data-tuning-log-act="viewer"', close: 'data-tuning-log-act="close"'
            })).toggleClass("tuning-hide", false);
            mine.row = placeLogPreview(panel[0], mine.origin);
            if (mine.origin && mine.origin.classList) mine.origin.classList.add("active");
            if (panel[0] && panel[0].scrollIntoView) panel[0].scrollIntoView({ block: "nearest" });
            function current() {
                var now = fileInfo();
                return preview === mine && shown === mine.entry && now && shown.fileKey === now.key;
            }
            model.read().then(function (data) {
                if (!current()) return;
                var specs = data.specs, plots = [];
                part("log-body").html(L.logPreviewBody(data, typeof TuningPlot === "undefined" ? [] : specs.map(function (spec) {
                        var id = env.plotId();
                        plots.push({ id: id, spec: spec });
                        return 'id="' + id + '"';
                    })));
                pending["log-preview"] = plots;
                if (visible) attachPlots("log-preview");
            }).catch(function (e) {
                if (current()) part("log-body").html('<p class="analysis-muted">The app cannot read the data of this part of the log. ' + quoted(esc(e && e.message || e)) + "</p>");
            });
            return true;
        }

        // "Show in the log" of a finding: its evidence view, or one of its spans
        function showFinding(f, spanIndex, origin) {
            var info = fileInfo(), log = viewerLog(), ev = f && f.evidence;
            if (!ev || !shown || !info) return false;
            if (shown.fileKey !== info.key) return renderChrome(), false;
            var v = ev.view || {}, sp = isNum(spanIndex) && Array.isArray(ev.spans) ? ev.spans[spanIndex] : null,
                src = sp || (isNum(v.t0) && isNum(v.t1) ? v : (ev.spans || []).filter(function (s) { return s && isNum(s.t0) && isNum(s.t1); })[0]) || {};
            var li = isNum(src.log) ? src.log : isNum(v.log) ? v.log : isNum(ev.log) ? ev.log : f.log;
            if (!isNum(li) || li < 0 || li >= log.getLogCount() || (log.getLogError && log.getLogError(li)) || !isNum(src.t0) || !isNum(src.t1)) return false;
            return previewRequest({ log: li, fromS: Math.min(src.t0, src.t1), toS: Math.max(src.t0, src.t1), atS: sp ? (sp.t0 + sp.t1) / 2 : isNum(v.at) ? v.at : (src.t0 + src.t1) / 2,
                graphs: v.graphs || null, analyser: v.analyser || null, title: evidenceTitle(f), text: summaryOf(f) }, f, origin);
        }

        // The finding a time link is of, for the evidence bar: same check, log, axis and time
        function linkLook(el) {
            var id = el.getAttribute("data-id"), axis = el.getAttribute("data-axis") || null, li = +el.getAttribute("data-log"), t = +el.getAttribute("data-t");
            var f = shown && (shown.result.findings || []).filter(function (x) {
                return String(x.id) === id && onLog(x, li) && (findingAxis(x) || null) === axis && Array.isArray(x.times) && x.times.indexOf(t) >= 0;
            })[0];
            var look = lookFor(id, axis) || {};
            look.title = f ? evidenceTitle(f) : [id, axis].filter(Boolean).join(" ");
            look.text = f ? summaryOf(f) : "";
            return look;
        }

        function loadCli(file) {
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function () {
                var text = String(reader.result || "");
                if (text.length > 4e6 || !/^\s*(set\s+\S+\s*=|profile\s+\d|#\s*(dump|diff))/im.test(text)) {
                    failure = { input: true, message: 'The file is not a Rotorflight CLI dump ("diff all" or "dump").', detail: file.name };
                } else {
                    var info = fileInfo();
                    cli = { name: file.name, text: text, hash: fnv(text.length, function (i) { return text.charCodeAt(i); }, 1), craft: cliCraft(text),
                        fileKey: info ? info.key : null };
                    cliGone = null;
                    failure = null;
                }
                settingsChanged();
            };
            reader.onerror = function () {
                failure = { input: true, message: "The app cannot read the file.", detail: file.name };
                renderChrome();
            };
            reader.readAsText(file);
        }

        function copy(text, button) {
            var label = (button.getAttribute && button.getAttribute("data-label")) || "Copy";
            function done(ok) {
                button.textContent = ok ? "Copied" : "Copy error";
                setTimeout(function () { button.textContent = label; }, 1500);
            }
            function fallback() {
                var area = document.createElement("textarea");
                area.value = text;
                area.style.position = "fixed";
                area.style.opacity = "0";
                document.body.appendChild(area);
                area.select();
                var ok = false;
                try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
                area.remove();
                done(ok);
            }
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
            else fallback();
        }

        // The file name of a saved report or CLI file: the open file's, else the result's own (a file dropped since)
        function baseName(entry) {
            var info = fileInfo(), sameFile = info && info.key === entry.fileKey;
            return sameFile && typeof getLogBaseFilename === "function" ? getLogBaseFilename("log") : String(entry.result.fileName || "log").replace(/\.[^.]*$/, "");
        }

        function save() {
            if (!shown) return;
            var text = markdown(shown);
            pickSaveFile({
                suggestedName: baseName(shown) + (shown.scope === "log" ? "-log" + (shown.logIndex + 1) : "") + "-tuning.md",
                description: "Markdown report", mimeType: "text/markdown", extension: ".md"
            }).then(function (target) {
                if (target) return target.write(new Blob([text], { type: "text/markdown" }));
            }).catch(function (error) { reportSaveError(error); });
        }

        function settingsChanged() {
            var hit = !job && cached(currentKey());
            // the filter calculation of these settings (or none) for the Filters tab, the side panel and the CLI file
            if (ft.cache.length || ft.job || ft.failure || ft.cancelled) TABS.forEach(function (t) { rendered[t.key] = null; });
            if (hit && hit !== shown) display(hit);
            else renderChrome(); // display() renders the chrome too, and renderChrome tells the Analysis view
            if (shown && shown.control) ctRefresh();
        }

        // The Analysis view draws its "Logs" control again (onSettings)
        function notifySettings() {
            settingsListeners.slice().forEach(function (cb) {
                try { cb(); } catch (e) { console.error(e); }
            });
        }

        // "Selected flights" with every flight that the analysis can use, and a result of all flights of the file on display (same
        // flight rpm and CLI dump): the same flights, so the result is not for other settings
        function sameFlights() {
            var info = fileInfo(), rpm = null;
            if (view.scope !== "flights" || !shown || shown.scope !== "file" || !info) return false;
            if (shown.key !== keyFor(info, "file", currentLog(), rpm)) return false;
            return selectionRows(fileLogs(), knownFlights(), selectionMap()).every(function (r) { return !r.selectable || r.selected; });
        }

        // What the analysis uses with the settings on display, one STE sentence or "" ("Selected flights": the head of its list)
        function scopeText() {
            var log = viewerLog();
            if (!log || !fileInfo()) return "";
            if (view.scope === "log") return "The analysis uses only log " + (currentLog() + 1) + ". The log viewer shows this log.";
            if (view.scope === "flights") return "";
            var rows = selectionRows(fileLogs(), knownFlights(), {});
            return selectionHead(selectionCounts(selectionRows(fileLogs(), knownFlights(), selectionApply({}, { kind: "all" }, rows)))) + ".";
        }

        // The number of flights in the file when the app knows the flights of each log that has data, else null
        function fileFlightCount() {
            var known = knownFlights(), logs = fileLogs(), n = 0;
            if (!logs.length) return null;
            for (var i = 0; i < logs.length; i++) {
                if (logs[i].error) continue;
                var k = known[logs[i].log];
                if (!k) return null;
                if (!k.bench && !k.noData) n += k.flights.length;
            }
            return n;
        }

        function refreshChecks() {
            if (!shown) return;
            if (preview && preview.pane === "checks") closeLogPreview();
            env.pane = "checks";
            env.extra = [];
            body.find(".tuning-checks-table").html(checksTable(shown, view, env));
            pending.checks = (pending.checks || []).concat(env.extra);
            env.extra = [];
            if (visible) attachPlots("checks");
        }

        function selectNode(id) {
            view.node = id;
            if (view.focus && view.focus.node !== id) view.focus = null;
            if (view.compare && view.compare.where === "overview") view.compare = null;
            showTab("overview");
            renderPane("overview");
        }

        // --- events (Bootstrap's data API is off, see js/main.js, so nothing here relies on it)

        // "Start analysis" (V9): a run for other values stops, and the run for the values that the pilot selected starts. The
        // button works while the automatic run of one log operates. A run for the same values goes on
        function requestStart() {
            var key = currentKey();
            if (job && key && job.key === key) {
                hint = "The analysis for these values operates at this time. Wait for the result.";
                return renderChrome();
            }
            start();
        }

        dialog.on("click", ".tuning-analyse", function (e) { e.preventDefault(); requestStart(); });
        dialog.on("click", ".tuning-cancel", function (e) { e.preventDefault(); cancel(); });
        dialog.on("click", ".tuning-save", function (e) { e.preventDefault(); save(); });
        dialog.on("click", ".tuning-cli-load", function (e) { e.preventDefault(); body.find(".tuning-cli-input")[0].click(); });
        dialog.on("change", ".tuning-cli-input", function () { loadCli(this.files && this.files[0]); this.value = ""; });
        dialog.on("click", ".tuning-cli-clear", function (e) { e.preventDefault(); cli = cliGone = null; settingsChanged(); });
        dialog.on("change", ".tuning-scope", function () { view.scope = this.value === "log" || this.value === "flights" ? this.value : "file"; settingsChanged(); });
        dialog.on("change", ".tuning-fsel-log", function () { changeSelection({ kind: "log", log: +this.getAttribute("data-log"), on: !!this.checked }); });
        dialog.on("change", ".tuning-fsel-one", function () {
            changeSelection({ kind: "flight", log: +this.getAttribute("data-log"), flight: +this.getAttribute("data-flight"), count: +this.getAttribute("data-count"), on: !!this.checked });
        });
        dialog.on("click", ".tuning-fsel-head", function () { toggleList({ kind: "open", on: !this.parentNode.open }); });
        dialog.on("click", ".tuning-fsel-sub > summary", function () { toggleList({ kind: "sub", log: +this.parentNode.getAttribute("data-log"), on: !this.parentNode.open }); });
        dialog.on("click", ".tuning-fsel-all", function (e) { e.preventDefault(); changeSelection({ kind: "all" }); });
        dialog.on("click", ".tuning-fsel-none", function (e) { e.preventDefault(); changeSelection({ kind: "none" }); });
        dialog.on("click", ".tuning-tab", function (e) { e.preventDefault(); closeLogPreview(); showTab(this.getAttribute("data-tab")); });
        dialog.on("click", ".tuning-axis", function () { view.axis = this.getAttribute("data-axis"); renderPane(view.tab); });
        dialog.on("change", ".tuning-segment", function () { view.segment = +this.value; renderPane(view.tab); renderChrome(); });
        dialog.on("change", ".tuning-vib-profile", function () { view.vibProfile = this.value; renderPane(view.tab); });
        dialog.on("click", ".tuning-seek", function (e) {
            e.preventDefault();
            var li = +this.getAttribute("data-log"), t = +this.getAttribute("data-t");
            seekTo(li, shown ? frameOf(shown.result, li, t) : t, linkLook(this));
        });
        dialog.on("click", ".tuning-show", function (e) { e.preventDefault(); showFinding(env.findingOf(this.getAttribute("data-key")), null, this); });
        dialog.on("click", ".tuning-span", function (e) { e.preventDefault(); showFinding(env.findingOf(this.getAttribute("data-key")), +this.getAttribute("data-span"), this); });
        dialog.on("click", '[data-tuning-log-act="close"]', function () { closeLogPreview(true); });
        dialog.on("keydown", ".tuning-log-preview", function (e) {
            if (e.which === 27) { e.preventDefault(); closeLogPreview(true); }
        });
        dialog.on("click", '[data-tuning-log-act="viewer"]', function () {
            var info = fileInfo();
            if (!preview || !shown || !info || shown !== preview.entry || shown.fileKey !== info.key) {
                closeLogPreview();
                renderChrome();
                return;
            }
            if (showRequest(preview.req)) closeLogPreview();
        });
        // a compare panel opens, changes or closes: draw its pane again (the table only, on All checks)
        function redrawFor(where) {
            if (paneOf(where) === "checks") refreshChecks();
            else if (where) renderPane(paneOf(where));
        }
        dialog.on("click", ".tuning-compare-open", function (e) {
            e.preventDefault();
            var key = this.getAttribute("data-key"), where = this.getAttribute("data-where") || view.tab;
            view.compare = env.compareOpen(key, where) ? null : { key: key, where: where, span: 0 };
            redrawFor(where);
        });
        dialog.on("click", ".tuning-compare-close", function (e) {
            e.preventDefault();
            var where = view.compare && view.compare.where;
            view.compare = null;
            redrawFor(where);
        });
        dialog.on("click", ".tuning-compare-span", function () {
            if (!view.compare) return;
            view.compare.span = +this.getAttribute("data-span") || 0;
            redrawFor(view.compare.where);
        });
        dialog.on("click", ".tuning-node", function (e) { if (e && e.preventDefault) e.preventDefault(); selectNode(this.getAttribute("data-node")); });
        dialog.on("keydown", ".tuning-node", function (e) {
            if (e.which === 13 || e.which === 32) {
                e.preventDefault();
                selectNode(this.getAttribute("data-node"));
            }
        });
        dialog.on("click", ".tuning-node-link", function (e) { e.preventDefault(); selectNode(this.getAttribute("data-node")); });
        dialog.on("click", ".tuning-copy", function () { copy(copyTexts[+this.getAttribute("data-copy")] || "", this); });
        // the PID profile of the diagram and the lists: the panes that show it are drawn again
        dialog.on("click", ".tuning-profile", function (e) {
            if (e && e.preventDefault) e.preventDefault();
            var v = this.getAttribute("data-profile");
            if (shown && configList(shown.result).length) {
                var candidates=configList(shown.result).filter(function(d){return v==='all' || d.pidProfile===+v;});
                if(candidates.length) setConfig(candidates[candidates.length-1].id);
                return;
            }
            view.profile = v === "all" || !/^\d+$/.test(String(v)) ? "all" : +v;
            var d = shown && view.dataset !== "all" ? configOf(shown.result, view.dataset) : null, was = view.dataset;
            if (d && view.profile !== "all" && d.pidProfile !== view.profile) view.dataset = "all";
            view.compare = null;
            ["overview", "recs", "checks", "configs"].forEach(function (k) { rendered[k] = null; });
            showTab(view.tab);
            if (was !== view.dataset) notifyConfig();
        });
        // the filter calculation (SPEC3 G): start, cancel, "Show the measurement" of its spectra, and the link to the Filters tab
        dialog.on('click', '.tuning-ct-start', function () { ctStart(); });
        dialog.on('click', '.tuning-ct-cancel', function () { ctClear('canceled'); });
        dialog.on('click', '.tuning-ct-reset', function () { ctClear(); });
        dialog.on('change', '.tuning-ct-reference', function () {
            if (!view.ctReference) view.ctReference={};
            view.ctReference[view.tab]=this.value; renderPane(view.tab);
        });
        dialog.on('click', '.tuning-ct-details summary[data-ct-detail]', function () {
            if (!view.ctDetails) view.ctDetails={};
            view.ctDetails[this.getAttribute('data-ct-detail')]=!this.parentNode.open;
        });
        dialog.on("click", ".tuning-ft-start", function (e) { if (e && e.preventDefault) e.preventDefault(); ftStart(); });
        dialog.on('change', '.tuning-ft-source-select', function () {
            var info=fileInfo(), source=ftSources().find(function(s){return s.key===this.value;},this);
            if (!info || !source || ft.sources[info.key]===source.key) return;
            ftStop(); ft.sources[info.key]=source.key; view.ftTrace=0; view.segment=null; view.vibProfile=null; ftRefresh();
        });
        dialog.on("input change", ".tuning-ft-delay", function (e) {
            if (!ft.limits) ft.limits={};
            ft.limits[ftKey(true)]=String(this.value).trim()==='' ? NaN : Number(this.value);
            TABS.forEach(function(t){rendered[t.key]=null;});
            body.find(".tuning-ft-draft-note").toggleClass("tuning-hide",false);
            body.find(".tuning-ft-save").prop("disabled",true);
            renderTabStatus();
            // Preserve input focus while typing. The next render and every action use the updated limit.
            if (!e || e.type!=="input") ftRefresh();
        });
        dialog.on("input change", ".tuning-ft-param", function () {
            var key = ftKey(true), name = this.getAttribute("data-param");
            if (!key || !name) return;
            if (!ft.drafts[key]) ft.drafts[key] = {};
            ft.drafts[key][name] = this.value;
            body.find(".tuning-ft-draft-note").toggleClass("tuning-hide",false);
            body.find(".tuning-ft-save").prop("disabled", true);
            TABS.forEach(function(t){rendered[t.key]=null;});
            renderTabStatus();
        });
        dialog.on("click", ".tuning-ft-load", function () { ftStart("load"); });
        dialog.on("click", ".tuning-ft-simulate", function () { ftStart("simulate"); });
        dialog.on("click", ".tuning-ft-reset", function () {
            var m = ftModel(), values = {};
            ((m.result && m.result.parameters) || []).filter(function (q) { return q.editable; }).forEach(function (q) { values[q.key] = q.from; });
            ft.drafts[ftKey(true)] = values; ftRefresh();
        });
        dialog.on("click", ".tuning-ft-restore", function () {
            var saved = ft.auto[ftKey(true)]; if (!saved) return;
            var values = {}; (saved.parameters || []).filter(function (q) { return q.editable; }).forEach(function (q) { values[q.key] = q.to; });
            ft.drafts[ftKey(true)] = values; ftRefresh();
        });
        dialog.on("click", ".tuning-ft-cancel", function (e) { if (e && e.preventDefault) e.preventDefault(); ftCancel(); });
        dialog.on("click", ".tuning-ft-workspace summary[data-ft-detail]", function () {
            if (!view.ftDetails) view.ftDetails = {};
            view.ftDetails[this.getAttribute("data-ft-detail")] = !this.parentNode.open;
        });
        dialog.on("change", ".tuning-ft-hide-unchanged", function () {
            view.ftHideUnchanged = this.checked; rendered.filters = null; showTab("filters");
        });
        dialog.on("change", ".tuning-ft-trace", function () {
            view.ftTrace = +this.value || 0; rendered.filters = null; showTab("filters");
        });
        dialog.on("change", ".tuning-ft-curve", function () {
            var key = this.getAttribute("data-ft-curve");
            if (['raw','old','new'].indexOf(key) < 0) return;
            if (!view.ftCurves) view.ftCurves = {};
            view.ftCurves[key] = this.checked;
            (handles.filters || []).forEach(function (h) {
                if (h.filterComparison) h.update(ftComparisonSpec(h.filterComparison,view.ftCurves));
            });
        });
        dialog.on("click", ".tuning-ft-save", function () {
            var m = ftModel();
            if (m.stale || m.dirty || m.state === "running" || !m.result || !m.result.cliFile) return;
            var text = m.result.cliFile, name = String(m.result.fileName || "flight").replace(/\.[^.]*$/, "");
            pickSaveFile({ suggestedName: name + "-filter-autotune.txt", description: "Filter CLI commands", mimeType: "text/plain", extension: ".txt" })
                .then(function (target) { if (target) return target.write(new Blob([text], { type: "text/plain" })); })
                .catch(function (error) { reportSaveError(error); });
        });
        dialog.on("click", ".tuning-ft-plot", function (e) {
            if (e && e.preventDefault) e.preventDefault();
            view.ftPlot = !view.ftPlot;
            rendered.filters = null;
            showTab("filters");
        });
        dialog.on("click", ".tuning-tab-link", function (e) { if (e && e.preventDefault) e.preventDefault(); showTab(this.getAttribute("data-tab")); });
        // the configuration menu (SPEC3 J), the link to the table of the parameters that are not the same, and "Show" of a row
        dialog.on("change", ".tuning-config", function () { setConfig(this.value); });
        dialog.on("click", ".tuning-config-pick", function (e) { if (e && e.preventDefault) e.preventDefault(); setConfig(this.getAttribute("data-config")); });
        dialog.on("click", ".tuning-config-diff", function (e) { if (e && e.preventDefault) e.preventDefault(); showTab("configs"); });
        // a change of a group (C7) selects or removes all the changes of the group
        dialog.on("change", ".tuning-pick", function () {
            if (!shown) return;
            var i = +this.getAttribute("data-pick"), picks = picksOf(shown), on = !!this.checked;
            membersOf(exportRecsOf(shown), i).forEach(function (k) {
                if (on) picks[k] = true;
                else delete picks[k];
            });
            savePicks(shown,exportRecsOf(shown),picks);
            compiledPlan(shown);
            TABS.forEach(function(t){rendered[t.key]=null;});
            showTab(view.tab); // one selection and parameter record across the step pages
        });
        dialog.on("change", ".tuning-final-config", function () {
            if (!shown) return;
            var p=+this.getAttribute('data-profile'), d=configOf(shown.result,this.value);
            if (this.value && (!d || d.pidProfile!==p)) return;
            tuningState(shown).finalByProfile[p]=d ? d.id : '';
            rendered.export=null;showTab('export');
        });
        dialog.on("click", ".tuning-export-copy", function () {
            var m = shown && shown.exported;
            if (m && m.state === "ready") copy(m.text, this);
        });
        dialog.on("click", ".tuning-export-save", function () { saveCli(); });
        // a flight, or a part of a log with values that are possibly different (its text in the bar over the graph): data-log, data-t0,
        // data-t1 (frame seconds), data-title and data-text
        function showSpan(el) {
            var li = +el.getAttribute("data-log"), t0 = +el.getAttribute("data-t0"), t1 = +el.getAttribute("data-t1"), info = fileInfo(), log = viewerLog();
            if (!shown || !info || shown.fileKey !== info.key) return renderChrome();
            if (!isNum(li) || !isNum(t0) || !isNum(t1) || li < 0 || li >= log.getLogCount() || (log.getLogError && log.getLogError(li))) return;
            previewRequest({ log: li, fromS: Math.min(t0, t1), toS: Math.max(t0, t1), atS: (t0 + t1) / 2, graphs: null, analyser: null, title: el.getAttribute("data-title") || "", text: el.getAttribute("data-text") || "" }, null, el);
        }
        dialog.on("click", ".tuning-flight", function (e) { e.preventDefault(); showSpan(this); });
        dialog.on("click", ".tuning-part", function (e) { e.preventDefault(); showSpan(this); });
        // the parts of the logs and the caveat (result.freshness) at the end of the Configurations tab
        dialog.on("click", ".tuning-fresh-link", function (e) {
            if (e && e.preventDefault) e.preventDefault();
            showTab("configs");
            var target = document.getElementById(uid + "-fresh");
            if (target && target.scrollIntoView) target.scrollIntoView({ block: "start" });
        });
        dialog.on("click", ".tuning-goto-rec", function (e) {
            e.preventDefault();
            showTab("recs");
            var target = document.getElementById(env.recId(+this.getAttribute("data-rec")));
            if (target) target.scrollIntoView({ block: "start" });
        });
        dialog.on("change", ".tuning-f-sev", function () { view.sev = this.value; refreshChecks(); });
        dialog.on("change", ".tuning-rf", function () {
            var f = resultFilter();
            f[this.getAttribute("data-rf") === "ok" ? "ok" : "thin"] = !!this.checked;
            if (hooks.setResultFilter) hooks.setResultFilter(f); // js/main.js saves it and calls the onResultFilter listeners
            else { localFilter = f; filterChanged(); }
        });
        if (typeof hooks.onResultFilter === "function") hooks.onResultFilter(function () { filterChanged(); });
        dialog.on("change", ".tuning-f-area", function () { view.area = this.value; refreshChecks(); });
        dialog.on("input", ".tuning-f-query", function () {
            var value = this.value;
            clearTimeout(queryTimer);
            queryTimer = setTimeout(function () { view.query = value; refreshChecks(); }, 200);
        });
        dialog.on("click", "th[data-sort]", function () {
            var key = this.getAttribute("data-sort");
            view.dir = view.sort === key ? -view.dir : 1;
            view.sort = key;
            refreshChecks();
        });

        // js/main.js showView: leaving the view; panes drawn while it is hidden keep their plots until show()
        this.hide = function () {
            visible = false;
            closeLogPreview();
        };

        // js/main.js showView: the view is visible (laid out) when this runs
        this.show = function (log) {
            visible = true;
            cachedLog = hooks.getFlightLog ? null : log || null; // with the hook nothing keeps an old file's FlightLog alive
            var info = fileInfo();
            if (job && (!info || job.fileKey !== info.key)) endJob(); // another file was opened meanwhile
            if (ft.worker && ft.workerKey !== ftKey(true)) ftStop();
            if (shown && (!info || shown.fileKey !== info.key)) drop();
            if (reader && reader.sync) reader.sync(); // the log of another file that it kept
            var key = !job && currentKey(), hit = key && cached(key);
            if (hit && hit !== shown) {
                display(hit);
            } else if (key && !hit && view.scope !== "flights" && !(failure && failure.key === key) && !(cancelled && cancelled.key === key)) {
                start(); // the analysis starts at once: by default all flights of the file (2026-10-06), or "This log". For "Selected
                // flights" the pilot clicks "Start analysis" after the selection
            }
            renderChrome();
            attachPlots(view.tab); // a result that came while the view was hidden
        };

        // "Open in the Tuning view" of the Analysis view: Overview with the step (or the item) of a
        // result in the side panel, and its recommendations first. target: { node, fid, recs: [recommendation ids] }. The
        // PID profile on display changes to "All PID profiles" when it does not show the result. false: no result on display,
        // or the result does not have this step
        this.focus = function (target) {
            var info = fileInfo(), graph = shown && graphOf(shown.result);
            if (target && target.tab && shown && info && shown.fileKey === info.key && TABS.some(function (t) { return t.key === target.tab; })) { // a tab: "Configurations" of the Analysis view
                showTab(String(target.tab));
                return true;
            }
            if (!target || !shown || !info || shown.fileKey !== info.key || !graph || !graph.byId[target.node]) return false;
            var f = target.fid ? env.findingOf(String(target.fid)) : null;
            if (f && configList(shown.result).length) {
                var targetConfig = configOf(shown.result,f.dataset);
                if (!targetConfig && !inProfile(f,view.profile)) targetConfig = configList(shown.result).filter(function(d){return inProfile(f,d.pidProfile);}).pop();
                if (targetConfig) setConfig(targetConfig.id);
            } else if (view.profile !== "all" && f && !inProfile(f, view.profile)) view.profile = "all";
            view.node = String(target.node);
            var own = recsOf(shown.result,view.dataset), wanted = Array.isArray(target.recs) ? target.recs.map(String) : [];
            var matches = own.filter(function(r){return wanted.some(function(id){return r.id===id || r.id.endsWith(':'+id);});});
            view.focus = { node: view.node, fid: f ? f.fid : null, recs: matches.map(function(r){return r.id;}) };
            view.compare = null;
            rendered.overview = null;
            showTab("overview");
            var first = view.focus.recs.length ? own.map(function (x, i) { return { rec: x, i: i }; }).filter(function (x) { return x.rec.id === view.focus.recs[0]; })[0] : null;
            var el = document.getElementById(first ? env.recId(first.i) + "-panel" : uid + "-panel");
            if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
            return true;
        };

        // For the log lens: the TuningResult on display when it is of the open file, else null
        this.getResult = function () {
            var info = fileInfo();
            return shown && info && shown.fileKey === info.key ? shown.result : null;
        };

        // The analysis of the result on display, for js/analysis_view.js (SPEC3 D): { scope ("log", "file" or "flights"), flights
        // ([{ log, flight }] of "Selected flights", else null), text ("Flights in the analysis: log 14 flight 1", else null) },
        // null without a result of the open file
        this.getSelection = function () {
            var info = fileInfo();
            if (!shown || !info || shown.fileKey !== info.key) return null;
            return { scope: shown.scope, flights: shown.flights ? shown.flights.map(function (x) { return { log: x.log, flight: x.flight }; }) : null,
                text: shown.scope === "flights" ? runSelectionText(shown) + "." : null };
        };

        // The "Logs" control of the Analysis view (2026-10-06): the same settings as this view. { scope, html (the control, what
        // the analysis uses, and for "Selected flights" the flight list), stale (the result on display is for other settings),
        // running }. The Analysis view sends the pilot's actions to scopeAction and draws it again after onSettings
        this.scopePanel = function () {
            var info = fileInfo(), key = currentKey(), text = scopeText();
            var html = '<div class="tuning-scope-bar"><label class="tuning-field">Logs ' + scopeSelectHtml(view.scope) + "</label>" +
                (text ? ' <span class="tuning-scope-text tuning-muted">' + esc(text) + "</span>" : "") + "</div>" +
                (view.scope === "flights" && info ? '<div class="tuning-fsel">' + selectionListHtml() + "</div>" : "");
            return { scope: view.scope, html: html, running: !!job, stale: !!(shown && info && shown.fileKey === info.key && key && key !== shown.key && !sameFlights()) };
        };

        // An action of the Analysis view: { kind: "scope", value } (the "Logs" control), { kind: "log" | "flight" | "all" |
        // "none", ... } (the flight list, as changeSelection), { kind: "open" | "sub", ... } (a flight list opens or closes).
        // false for an action that is not known
        this.scopeAction = function (act) {
            if (!act || typeof act !== "object") return false;
            if (act.kind === "scope") {
                view.scope = act.value === "log" || act.value === "flights" ? act.value : "file";
                settingsChanged();
            } else if (act.kind === "log" || act.kind === "flight" || act.kind === "all" || act.kind === "none") {
                changeSelection(act);
            } else if (act.kind === "open" || act.kind === "sub") {
                toggleList(act);
            } else return false;
            return true;
        };

        // cb() after each change of the settings of the analysis (the "Logs" control, the flight list); returns a function
        // that removes cb
        this.onSettings = function (cb) {
            if (typeof cb !== "function") return function () {};
            settingsListeners.push(cb);
            return function () { settingsListeners = settingsListeners.filter(function (x) { return x !== cb; }); };
        };

        // The configuration on display for the log lens and the Analysis view (SPEC3 J): "all" or the id of a configuration of
        // the result on display. setConfiguration(id): the configuration menu; false when the result has no such configuration
        this.getConfiguration = function () {
            return shown && view.dataset !== "all" && configOf(shown.result, view.dataset) ? view.dataset : "all";
        };
        this.setConfiguration = function (id) {
            if (!shown || (id !== "all" && !configList(shown.result).some(function (d) { return d.id === String(id); }))) return false;
            setConfig(String(id));
            return true;
        };
        // cb(id) after each change of the configuration on display; returns a function that removes cb
        this.onConfiguration = function (cb) {
            if (typeof cb !== "function") return function () {};
            configListeners.push(cb);
            return function () { configListeners = configListeners.filter(function (x) { return x !== cb; }); };
        };

        // cb(result or null) after each change of the result on display; returns a function that removes cb
        this.onResult = function (cb) {
            if (typeof cb !== "function") return function () {};
            listeners.push(cb);
            return function () { listeners = listeners.filter(function (x) { return x !== cb; }); };
        };

        // A run for `key` gives the result of key: the same settings, or "All logs in the file" of the same file, flight rpm
        // and CLI dump with another selected log (its findings are of every log; its curves and header are of its own log)
        function serves(j, key) {
            var a = String(j.key).split("|"), b = String(key).split("|");
            return j.key === key || (a.length === b.length && a[a.length - 4] === "file" && b[b.length - 4] === "file" &&
                a.filter(function (x, i) { return i !== a.length - 3; }).join("|") === b.filter(function (x, i) { return i !== b.length - 3; }).join("|"));
        }

        // "Start the analysis" of the Analysis view: the cached result of the current settings, else a run for them. A run
        // for other settings or another log (a log moved to, a file dropped since) stops first. A Promise of the
        // TuningResult: it rejects with an Error (reason "failed", "canceled" or "replaced") when the run does not give
        // one. false when no file is open
        this.runAnalysis = function () {
            var info = fileInfo(), key = currentKey(), hit;
            if (!info) return false;
            if (shown && shown.fileKey !== info.key) drop();
            if (job && !(key && serves(job, key))) endJob();
            hit = !job && key && cached(key);
            if (hit) {
                if (hit !== shown) display(hit);
                return Promise.resolve(hit.result);
            }
            if (!job) start();
            var j = job, p = !j ? Promise.reject(jobError("start", failure && failure.message ? failure.message : "The analysis did not start.", failure ? failure.detail || "" : "")) :
                new Promise(function (resolve, reject) { j.waiters.push({ resolve: resolve, reject: reject }); });
            p.catch(function () {}); // a caller that does not wait for the result: no unhandled rejection
            return p;
        };
    }

    // Pure pieces, for test/tuning_dialog.test.cjs
    TuningDialog.internals = {
        tabStatus: tabStatus, filterTabStates: filterTabStates,
        controlWorkspaceHtml: controlWorkspaceHtml, controlPairs: controlPairs, flightPlanHtml: flightPlanHtml,
        esc: esc, parameterLabel: parameterLabel, parameterHtml: parameterHtml, num: num, valueSe: valueSe, threshold: threshold, logLabel: logLabel, paramText: paramText, findingStatus: findingStatus,
        areaOf: areaOf, findingWhere: findingWhere, findingAxis: findingAxis, rpmText: rpmText, lookFor: lookFor, toFrame: toFrame,
        graphOf: graphOf, columnsOf: columnsOf, flowHtml: flowHtml, prereqHtml: prereqHtml, prereqState: prereqState, checkRows: checkRows, stepNo: stepNo, nodeState: nodeState, curvePath: curvePath, curveSeries: curveSeries,
        derivedSeries: derivedSeries, compareSpec: compareSpec, profilePeriods: profilePeriods, statusCounts: statusCounts, summaryOf: summaryOf,
        profileNo: profileNo, profileText: profileText, profileList: profileList, byProfileOf: byProfileOf, flightsOf: flightsOf, exportMeta: exportMeta,
        inProfile: inProfile, upstreamText: upstreamText, canCompare: canCompare, noCurveText: noCurveText, captionHtml: captionHtml, groupLabel: groupLabel, canPick: canPick,
        partGroups: partGroups, cliIndex: cliIndex, countText: countText, givesCount: givesCount, sampleCounts: sampleCounts, valueHtml: valueHtml, limitHtml: limitHtml, ruleText: ruleText, sourcesOf: sourcesOf, cliCraft: cliCraft, sameCraft: sameCraft, confidenceText: confidenceText, flightsHtml: flightsHtml, flightsLine: flightsLine,
        selectionList: selectionList, selectionKey: selectionKey, selectionText: selectionText, selectionRows: selectionRows, selectionApply: selectionApply,
        selectionCounts: selectionCounts, selectionHead: selectionHead, scopeSelectHtml: scopeSelectHtml, fileFlightsText: fileFlightsText, fselFocus: fselFocus, fselRefocus: fselRefocus, fselState: fselState, fselRestore: fselRestore, SCOPES: SCOPES,
        selectionHtml: selectionHtml, headerValue: headerValue, logDateText: logDateText, filterResults: filterResults, filterBar: filterBar,
        datasetsOf: datasetsOf, configList: configList, configText: configText, configMarks: configMarks, inDataset: inDataset, inView: inView, configBar: configBar,
        diffTable: diffTable, recConfigHtml: recConfigHtml, hierFor: hierFor, filterRecs: filterRecs, filterSearchHtml: filterSearchHtml, filterSources: filterSources, filterBaseline: filterBaseline, filterChecklistHtml: filterChecklistHtml, pendingPlan: pendingPlan, pendingDiffHtml: pendingDiffHtml, ftPlotSpecs: ftPlotSpecs,
        vibPlots: vibPlots, vibCaption: vibCaption, vibToolbar: vibToolbar, parityHtml: parityHtml, dbChange: dbChange, markdown: markdown,
        armingOf: armingOf, startProfile: startProfile, startBasisText: startBasisText, startHtml: startHtml, startRows: startRows, configStartTitle: configStartTitle,
        profilesText: profilesText, notchFitTexts: notchFitTexts, notchFitRows: notchFitRows, fitUsed: fitUsed, cliStatusHtml: cliStatusHtml, cliConflicts: cliConflicts,
        staleOf: staleOf, staleHtml: staleHtml, staleRecHtml: staleRecHtml, stalePeriods: stalePeriods, spanStale: spanStale, causeText: causeText, epochsOf: epochsOf,
        epochSummary: epochSummary, epochHtml: epochHtml, freshCounts: freshCounts, freshLine: freshLine, freshnessHtml: freshnessHtml, freshnessRows: freshnessRows,
        sourceLabel: sourceLabel, armText: armText, recBadges: recBadges, evidenceLinks: evidenceLinks, FRESH: FRESH, FRESH_CAUSE: FRESH_CAUSE,
        COVERAGE: COVERAGE, CLI_ABOUT: CLI_ABOUT, CLI_STATUS: CLI_STATUS,
        TABS: TABS, STATUS: STATUS, NODE_STATUS: NODE_STATUS, PREREQ_STATUS: PREREQ_STATUS, NO_DATA: NO_DATA, FT: FT
    };

    return TuningDialog;
})();
