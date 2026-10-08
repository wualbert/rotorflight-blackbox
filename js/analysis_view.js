"use strict";

/**
 * AnalysisView - the "Analysis" view (#viewAnalysis): the verdict of the analysis (#analysisVerdictBody), at the full
 * width of the view. The pieces that it shares with the Tuning view come from js/log_lens.js (LogLens.internals).
 *
 *   var view = new AnalysisView($("#viewAnalysis"), hooks);   // js/main.js; showView("analysis") calls show() and hide()
 *   view.show(flightLog); view.hide(); view.setResult(result); view.verdict
 *
 * The verdict comes from OUR analysis (SPEC2 D7): the TuningResult that the Tuning view has (hooks.getResult,
 * hooks.onResult), in ASD-STE100. It is an overview of the health of each part of the helicopter (SPEC3 I). A summary (the
 * number of results for each status, the areas with a problem, the items before the first flight with a problem, the
 * first steps of the tuning order, the flights and the bench runs), then one card for each area of f.area (SPEC3 K3):
 * battery and power, motor and ESC, governor, RPM signal, vibration and mechanical parts, control limits and authority, tail, cyclic,
 * transmitter and rescue, blackbox log (docs/STE_GLOSSARY.md). A card has its condition, its main numbers and its results,
 * each with its status, value, limit and PID profile, and the links "Show in the log" (a panel under the link: the fields
 * of evidence.view.graphs over the span of the result, read with TuningSnippet.Reader, one plot for each graph, with
 * "Open in the log viewer" for hooks.viewInLog) and "Show the measurement" (the evidence plot under the row with its
 * caption, as the Tuning view draws it: LogLens.internals.evidenceCompare). One panel is open at a time. A problem of a tuning step (f.tuner, SPEC3 K2)
 * has "Open in the Tuning view" (hooks.openTuning({ node, fid, recs })); a hardware or setup item says what to examine.
 * Values that are possibly not the values of the log header (CLAUDE.md "Values that are possibly not current", the worker's f.stale,
 * issues[].stale, r.stale, result.epochs and result.freshness): a mark on each item, result and recommendation with the count, the
 * causes and the source of the values (epochHtml); the summary gives the numbers and result.freshness.caveat, the one place of the
 * caveat (epochSummaryHtml); the panel of "Show in the log" shows the parts of its time window as the log lens does (epochRowsHtml).
 *
 * hooks: viewInLog(req), getBytes(), getFileName(), getCurrentLogIndex(), getFlightLog(), runAnalysis(), getResult(),
 * onResult(cb), derive(kind, cols, rate, params, transfer), scopePanel(), scopeAction(act), onSettings(cb) and
 * openTuning(target) (shows the Tuning view, at target when given). runAnalysis() gives a Promise of the result, or it
 * rejects when the run stops (js/tuning_dialog.js). The words, values and units of the checks are those that the worker
 * writes on each finding from tools/autotune/catalog.cjs: status, noun and display { value, unit, profile }.
 *
 * The upstream Flight analysis (js/flight_analysis.js, js/flight_analysis_dialog.js) stays as it is and is not used.
 * Text is ASD-STE100 (docs/STE_GLOSSARY.md). Every string from the log, the toolkit or a worker is escaped, and toolkit
 * text that is not STE is in data-ste="quoted" or <code>. Viewer only: nothing goes to a flight controller.
 */
var AnalysisView = (function () {

    var AXES = ["roll", "pitch", "yaw"];

    // The cards of the overview (SPEC3 I): one for each part of the helicopter, in their order on the page. The worker gives
    // each finding its area (f.area, SPEC3 K3: catalog.cjs); a result without it gets the area of its check id (areaOf)
    var AREAS = [
        { key: "power", title: "Battery and power" },
        { key: "motor", title: "Motor and ESC" },
        { key: "governor", title: "Governor" },
        { key: "rpm", title: "RPM signal" },
        { key: "vibration", title: "Vibration and mechanical parts" },
        { key: "limits", title: "Control limits and authority" },
        { key: "tail", title: "Tail" },
        { key: "cyclic", title: "Cyclic" },
        { key: "radio", title: "Transmitter and rescue" },
        { key: "logging", title: "Blackbox log" }
    ];
    var AREA_KEYS = AREAS.map(function (a) { return a.key; });
    var KEYS = 3; // the main numbers of a card at most

    // The status words (SPEC2 D9): the worst first, for the status of a card (js/tuning_dialog.js STATUS_ORDER)
    var ORDER = ["error", "problem", "monitor", "satisfactory", "information", "insufficient", "notMeasured"];
    var LABEL = { error: "Analysis error", problem: "Problem", monitor: "Monitor", satisfactory: "Satisfactory", information: "Information",
        insufficient: "Not sufficient data", notMeasured: "Not measured" };
    var MAIN = 6; // the primary rows of a card at most; the others open with "N more items"
    // An item ("issue" of the worker, M3) is one check and axis across the logs, the PID profiles and the configurations. Its size
    // is its largest value against its limit (value / limit). A card whose problems all have a size of less than SMALL is
    // "Monitor", not "Problem" (M3, SPEC3 L3: no ten red cards). TOP: the most important items of the whole analysis
    var SMALL = 1.2, TOP = 3;

    // All fixed text, in ASD-STE100 (test/ste_text.test.cjs reads what the view writes)
    var TEXT = {
        title: "Results of the analysis",
        noResult: "No analysis result is available.",
        about: "The analysis examines the log with the checks of the toolkit. It gives each result with its value, its limit and the part of the log that it comes from.",
        stale: "The results on display are for different logs or flights. To use the logs and the flights that you selected, start the analysis again.",
        start: "Start the analysis",
        running: "The analysis started. Wait for the results. The Tuning view shows when the analysis is complete.",
        startFailed: "The analysis did not start.",
        openTuning: "Open the Tuning view",
        tuningNote: "The Tuning view gives the recommendations and the tuning steps.",
        noLens: "The app did not load js/log_lens.js. Thus, the view cannot show the results.",
        noProblem: "The analysis found no problem.",
        problemAreas: "Areas with a problem:",
        startHere: "Start here",
        lowRate: "The log rate is less than 1 kHz. Thus, the vibration, D-term and gain results are not accurate (check D1).",
        logs: "Flights and bench runs",
        bench: "Bench run (no analysis)",
        noFlight: "The analysis found no flight in this log.",
        noData: "No data that the app can read",
        top: "The most important items",
        noTop: "The analysis found no problem and no item to monitor.",
        items: "items",
        oneItem: "1 more item",
        moreItems: "more items",
        perLog: "The results of each log",
        showCard: "Show the area",
        configurations: "Configurations",
        showConfigs: "Show the configurations",
        configsNote: "The Tuning view shows the parameters that are not the same.",
        noArea: "The analysis has no result for this area.",
        more: "more results",
        oneMore: "1 more result",
        showInLog: "Show in the log",
        compare: "Show the measurement",
        measurement: "Measurement",
        overview: "Condition of each part of the helicopter",
        tune: "Open in the Tuning view",
        examine: "Items to examine",
        recommendation: "Recommendation",
        prereq: "Before the first flight",
        prereqProblem: "Items with a problem before the first flight:",
        close: "Close",
        quoted: "Toolkit text (not STE)",
        limit: "Limit",
        value: "Value",
        noPlot: "The plot is not available.",
        noPlots: "The plot library (js/tuning_plot.js) is not available.",
        busy: "The app reads the data for the plot.",
        logData: "Data from the log",
        openViewer: "Open in the log viewer",
        noFields: "This log does not contain these fields:",
        noRead: "The app cannot read the data of this part of the log.",
        clipped: "The plot shows only the first 60 s.",
        flight: "Flight",
        analysisTime: "Analysis time",
        // values that are possibly not the values of the log header (CLAUDE.md "Values that are possibly not current")
        epochTag: "Values possibly different", // the badge of js/tuning_dialog.js FRESH: the source sentences of the worker say where the app takes the values from
        epochUnknown: "The source of the values is unknown.",
        epochMark: "A mark on each item gives the causes and the source of the values.",
        epochNone: "The log shows no cause for values that are not the values of the log header.",
        epochAfter: "Thus, a result with no mark can also use values that are not the values of the log header."
    };

    // ---------------------------------------------------------------------------------------------
    // Formatting

    function I() {
        return typeof LogLens !== "undefined" && LogLens && LogLens.internals ? LogLens.internals : null;
    }

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

    // A text of the worker (STE): escaped, with the names in backticks in code font (quoted text, Rule 8.6)
    function codeText(text) {
        return esc(text).replace(/`([^`]*)`/g, "<code>$1</code>");
    }

    function sec(t) {
        return isNum(t) ? t.toFixed(1) + " s" : "";
    }

    function plural(n, one, many) {
        return n + " " + (n === 1 ? one : many);
    }

    // "1", "1 and 2", "1, 2 and 3"
    function and(list) {
        return list.length > 1 ? list.slice(0, -1).join(", ") + " and " + list[list.length - 1] : list.join("");
    }

    // A limit number as the catalog writes numbers (catalog.cjs fmt): decimals by size, "−" for a negative number
    function nfmt(v) {
        if (!isNum(v)) return null;
        var a = Math.abs(v), s = String(+v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : a >= 0.1 ? 3 : 4));
        return s === "-0" ? "0" : s.replace("-", "−");
    }

    // The worker's texts of a finding (js/tuning_worker.js present, from catalog.cjs): display { value, unit, scale, limit,
    // profile, phase } and noun. A result without them (no catalog.cjs in the worker) gives the raw value with its unit
    function displayOf(f) {
        return f && f.display && typeof f.display === "object" ? f.display : null;
    }

    // The noun of the check of a finding (catalog.cjs CHECKS noun), or ""
    function nounOf(f) {
        return f && typeof f.noun === "string" ? f.noun : "";
    }

    // The display unit of a finding: the worker's, else its own unit (a fraction as %)
    function unitOf(f) {
        var d = displayOf(f);
        if (d && typeof d.unit === "string") return d.unit;
        return f.unit === "fraction" ? "%" : f.unit === "permille" ? "‰" : typeof f.unit === "string" ? f.unit : "";
    }

    // The value of a finding as its STE summary writes it (the worker's display.value: catalog.cjs format().value), or null
    function valueText(f) {
        var d = displayOf(f), L = I();
        if (d) return typeof d.value === "string" && d.value ? d.value : null;
        return isNum(f.value) && L ? L.valueSe(f.value, f.se, f.unit) || null : null;
    }

    // The limit of a finding: the worker's display.bound (the limit in the unit of the value, the same in log and file scope:
    // the plot lines of T13 are in ‰ in file scope), else the limit lines of its evidence plot in the unit of its value
    // ("30 % and 45 %", "±2 %"), else display.limit, else the threshold of the toolkit (not STE: in code font). { text, code } or null
    function limitOf(f) {
        var d = displayOf(f);
        if (d && typeof d.bound === "string" && d.bound.trim()) return { text: d.bound, code: false };
        var unit = unitOf(f), plot = f.evidence && f.evidence.plot, refs = plot && Array.isArray(plot.reference) ? plot.reference : [];
        var mine = refs.filter(function (r) { return r && typeof r === "object" && unit && r.unit === unit; }), values = [], parts = [];
        mine.forEach(function (r) { if (r.kind === "hline" && isNum(r.value) && values.indexOf(r.value) < 0) values.push(r.value); });
        values.sort(function (a, b) { return Math.abs(a) - Math.abs(b) || a - b; }).forEach(function (v) {
            if (v < 0 && values.indexOf(-v) >= 0) return;
            parts.push((v > 0 && values.indexOf(-v) >= 0 ? "±" + nfmt(v) : nfmt(v)) + " " + unit);
        });
        mine.forEach(function (r) { if (r.kind === "band" && r.label) parts.push(String(r.label)); });
        if (parts.length) return { text: and(parts), code: false };
        // a phrase loses its period ("Limit: 3.3 V"), a text of two or more sentences keeps it ("This check gives information only.
        // It has no limit.": STE, a sentence ends with a period)
        if (d && typeof d.limit === "string" && d.limit.trim()) return { text: /\.\s+\S/.test(d.limit.trim()) ? d.limit.trim() : d.limit.replace(/\.$/, ""), code: false };
        var t = I() ? I().limitText(f.threshold) : "";
        return t ? { text: t, code: true } : null;
    }

    function axisOf(f) {
        return AXES.indexOf(f.axis) >= 0 ? f.axis : /^T\d+$/.test(String(f.id)) ? "yaw" : null;
    }

    // The area of a finding (AREAS): the worker's f.area (catalog.cjs AREA_OF, SPEC3 K3), else the area of its check id (the
    // same table)
    function areaOf(f) {
        if (f && typeof f.area === "string" && AREA_KEYS.indexOf(f.area) >= 0) return f.area;
        var id = String(f.id);
        if (/^(L\d+|C2|T8)$/.test(id)) return "limits";    // the control outputs at their limits (CLAUDE.md "Control limits")
        if (/^(D5|G11|G13|P\d+)$/.test(id)) return "power";
        if (/^G(17|18)$/.test(id)) return "motor";
        if (/^G(1|12|20)$/.test(id)) return "rpm";
        if (/^G\d+$/.test(id)) return "governor";
        if (/^(F\d+|C11|C15|T4)$/.test(id)) return "vibration";
        if (/^(D6|D8|D9|R1)$/.test(id)) return "radio";
        if (/^T\d+$/.test(id) || (id === "C7" && axisOf(f) === "yaw")) return "tail";
        if (/^C\d+$/.test(id)) return "cyclic";
        return "logging";
    }

    // A finding of a tuning step (f.tuner, SPEC3 K2: its home is a step with parameters to tune) has the link "Open in the
    // Tuning view". Without f.tuner: the home of the finding (f.node) is a step of result.hierarchy.graph. An item before the
    // first flight (hardware, setup) has no link: the row says what to examine
    function tunerOf(f, g) {
        if (f && typeof f.tuner === "boolean") return f.tuner;
        var n = f && f.node ? graphNodes(g)[f.node] : null;
        return !!(n && n.kind === "block");
    }

    // The recommendations of a finding: those with the finding in their evidence (advice.cjs evidence[].fid)
    function recsFor(r, f) {
        var list = r && r.advice && Array.isArray(r.advice.recommendations) ? r.advice.recommendations : [];
        return f && f.fid ? list.filter(function (rec) {
            return rec && Array.isArray(rec.evidence) && rec.evidence.some(function (e) { return e && e.fid === f.fid; });
        }) : [];
    }

    function worst(list) {
        var seen = {};
        list.forEach(function (o) { seen[o.status] = true; });
        return ORDER.filter(function (s) { return seen[s]; })[0] || "notMeasured";
    }

    function counts(list) {
        var n = {};
        list.forEach(function (o) { n[o.status] = (n[o.status] || 0) + 1; });
        return ORDER.filter(function (s) { return n[s]; }).map(function (s) { return [s, n[s]]; });
    }

    function countsHtml(list) {
        return counts(list).map(function (q) {
            return '<span class="analysis-count st-' + q[0] + '">' + esc(LABEL[q[0]]) + " <b>" + q[1] + "</b></span>";
        }).join("");
    }

    // The logs of a result: its logs, the logs of its records, and its bench runs, in order
    function logsOf(r) {
        var out = [], add = function (l) { if (isNum(l) && out.indexOf(l) < 0) out.push(l); };
        (Array.isArray(r.logs) ? r.logs : []).forEach(add);
        if (isNum(r.logIndex) && r.scope !== "file") add(r.logIndex);
        (Array.isArray(r.records) ? r.records : []).forEach(function (q) { if (q) add(q.log); });
        (Array.isArray(r.benchRuns) ? r.benchRuns : []).forEach(function (q) { add(isNum(q) ? q : q && q.log); });
        (Array.isArray(r.noData) ? r.noData : []).forEach(function (q) { add(q && q.log); }); // M4: the logs with no data that the app can read
        return out.sort(function (a, b) { return a - b; });
    }

    // ---------------------------------------------------------------------------------------------
    // The verdict as HTML (pure, for test/analysis_view.test.cjs)

    // D4 compares the log header with a CLI dump, an optional input (the log is the only necessary input). Without a dump
    // (result.cli null) the worker gives no D4 result (health_setup.cjs), and the view shows no D4 item of an older result
    function dumpOnly(r, id) {
        return id === "D4" && !(r && r.cli);
    }

    // ---------------------------------------------------------------------------------------------
    // Values that are possibly not the values of the log header (CLAUDE.md "Values that are possibly not current"): the worker
    // gives f.stale of each finding ({ reasons, text, source, spans }), issues[].stale and r.stale of each recommendation ({ reasons,
    // text, source, findings }), result.epochs and result.freshness { caveat, reasons } (js/tuning_worker.js freshnessOf). source:
    // the STE sentences of the source of the values. The view shows a mark on each item, result and recommendation with stale, and
    // the caveat once, in the summary

    function staleOf(x) {
        return x && x.stale && typeof x.stale === "object" && !Array.isArray(x.stale) ? x.stale : null;
    }

    // The stale of an item: the worker's (issues[].stale), else the union over its results (as js/tuning_worker.js staleUnion)
    function itemStale(q) {
        if (q.staleGiven) return q.stale;
        var L = I(), hit = q.rows.filter(function (o) { return staleOf(o.f); }), order = L && L.EPOCH_REASONS ? L.EPOCH_REASONS : [];
        if (!hit.length) return null;
        var reasons = [], sources = [];
        hit.forEach(function (o) {
            var st = staleOf(o.f);
            (Array.isArray(st.reasons) ? st.reasons : []).forEach(function (k) { if (reasons.indexOf(k) < 0) reasons.push(k); });
            if (typeof st.source === "string" && st.source && sources.indexOf(st.source) < 0) sources.push(st.source);
        });
        reasons.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
        return { reasons: reasons, findings: hit.length, source: sources.length ? sources[0] + (sources.length > 1 ? " Other results have other sources." : "") : "", text: "" };
    }

    // The mark of an item (of: the number of its results) or of a result: the causes and the source of the values (CLAUDE.md: each
    // flag gives the source, or "unknown"). Without a source from the worker: its text, which ends with the source
    function epochHtml(st, of) {
        if (!st) return "";
        var L = I(), reasons = Array.isArray(st.reasons) ? st.reasons : [], why = L && L.epochCauses ? L.epochCauses(reasons) : "", n = isNum(st.findings) ? st.findings : null;
        var ours = [n === null ? "" : isNum(of) && of >= n ? n + " of " + plural(of, "result", "results") + "." : plural(n, "result", "results") + ".",
            why ? (reasons.length > 1 ? "Causes: " : "Cause: ") + why + "." : ""].filter(Boolean).join(" "),
            theirs = typeof st.source === "string" ? st.source : typeof st.text === "string" ? st.text : ""; // the STE text of the worker: a block of its own
        return '<div class="analysis-epoch"><div class="analysis-epoch-tag">' + esc(TEXT.epochTag) + '</div><div class="analysis-epoch-body">' +
            (ours ? '<div class="analysis-epoch-why">' + esc(ours) + "</div>" : "") + '<div class="analysis-epoch-src">' + esc(theirs || TEXT.epochUnknown) + "</div></div></div>";
    }

    // The summary of the values that are possibly not those of the log header, with result.freshness.caveat (the one place of the
    // caveat in the view): how many results and recommendations use such values. "" for a result without epochs
    function epochSummaryHtml(r, rows) {
        var fr = r && r.freshness && typeof r.freshness === "object" ? r.freshness : null, n = rows.filter(function (o) { return staleOf(o.f); }).length;
        if (!fr && !n) return "";
        var recs = r.advice && Array.isArray(r.advice.recommendations) ? r.advice.recommendations.filter(Boolean) : [], k = recs.filter(staleOf).length;
        var head = n ? n + " of " + plural(rows.length, "result", "results") + " " + (n === 1 ? "uses" : "use") + " values that are possibly not the values of the log header." +
            (k ? " " + k + " of " + plural(recs.length, "recommendation", "recommendations") + " " + (k === 1 ? "uses" : "use") + " these results." : "") + " " + TEXT.epochMark : TEXT.epochNone;
        return '<div class="analysis-epochs"><p class="' + (n ? "analysis-warn" : "analysis-muted") + '">' + esc(head) + "</p>" +
            (fr && typeof fr.caveat === "string" && fr.caveat ? '<p class="analysis-muted">' + esc(fr.caveat + " " + TEXT.epochAfter) + "</p>" : "") + "</div>";
    }

    // The rows of a result: [{ f, status, area, id (the row id in the page) }], in order of status, check, axis, profile, log
    function rowsOf(r) {
        var L = I(), rank = {};
        ["error", "problem", "monitor", "insufficient", "information", "satisfactory", "notMeasured"].forEach(function (s, i) { rank[s] = i; });
        return (Array.isArray(r.findings) ? r.findings : []).filter(function (f) { return f && typeof f.id === "string" && !dumpOnly(r, f.id); }).map(function (f) {
            return { f: f, status: L.statusOf(f), area: areaOf(f) };
        }).sort(function (a, b) {
            return rank[a.status] - rank[b.status] || L.compareIds(a.f.id, b.f.id) || AXES.indexOf(axisOf(a.f)) - AXES.indexOf(axisOf(b.f)) ||
                (L.profileOf(a.f) || 0) - (L.profileOf(b.f) || 0) || (isNum(a.f.log) ? a.f.log : 0) - (isNum(b.f.log) ? b.f.log : 0);
        }).map(function (o, i) { o.id = "r" + i; return o; });
    }

    // ---------------------------------------------------------------------------------------------
    // Items (M3): result.issues of the worker, [{ key, id, axis, area, node, tuner, status, rank, size, count, logs, profiles,
    // datasets, range: { min, max, unit, text }, fids, title, summary }] sorted by rank, and result.top (the keys of the 3 most
    // important). Without result.issues the view makes the items from the results: one for each check and axis

    var RANK = { error: 0, problem: 1, monitor: 2, insufficient: 3, information: 4, satisfactory: 5, notMeasured: 6 };

    function unique(list) {
        return list.filter(function (x, i) { return x !== null && x !== undefined && x !== "" && list.indexOf(x) === i; });
    }

    // The items of a result, each with its rows (the results of its fids, worst first): [{ key, id, axis, area, node, tuner,
    // status, size, count, logs, profiles, datasets, range, title, summary, rows, n (the item id in the page) }]. The worker's
    // items first (result.issues: the problems and the values to monitor, in their rank), then one item for each check and axis of
    // the other results (satisfactory, information, not sufficient data, not measured), the worst first
    function issuesOf(r, rows) {
        var L = I(), byFid = {}, covered = new Set(), out = [], given = Array.isArray(r.issues);
        rows.forEach(function (o) { if (o.f.fid) byFid[o.f.fid] = o; });
        if (given) {
            out = r.issues.filter(function (q) { return q && typeof q === "object" && (q.key || q.id) && !dumpOnly(r, q.id); }).map(function (q) {
                var mine = unique(Array.isArray(q.fids) ? q.fids.map(String) : []).map(function (fid) { return byFid[fid]; }).filter(Boolean);
                mine.forEach(function (o) { covered.add(o); });
                var st = typeof q.status === "string" && LABEL[q.status] ? q.status : mine.length ? worst(mine) : "notMeasured";
                return { key: String(q.key || q.id + "|" + (q.axis || "")), id: String(q.id || (mine[0] && mine[0].f.id) || ""), axis: q.axis || null,
                    area: typeof q.area === "string" && AREA_KEYS.indexOf(q.area) >= 0 ? q.area : mine.length ? mine[0].area : "logging",
                    node: q.node || (mine[0] && mine[0].f.node) || null, tuner: typeof q.tuner === "boolean" ? q.tuner : null, status: st,
                    rank: isNum(q.rank) ? q.rank : null, size: isNum(q.size) ? q.size : null, count: isNum(q.count) ? q.count : mine.length,
                    logs: unique(Array.isArray(q.logs) ? q.logs.filter(isNum) : mine.map(function (o) { return isNum(o.f.log) ? o.f.log : null; })).sort(function (a, b) { return a - b; }),
                    profiles: unique(Array.isArray(q.profiles) ? q.profiles.filter(isNum) : mine.map(function (o) { return L.profileOf(o.f); })),
                    datasets: unique(Array.isArray(q.datasets) ? q.datasets.map(String) : mine.map(function (o) { return o.f.dataset || null; })),
                    range: q.range && typeof q.range === "object" ? q.range : null, title: typeof q.title === "string" ? q.title : "", summary: typeof q.summary === "string" ? q.summary : "",
                    small: typeof q.small === "boolean" ? q.small : null, rows: mine, stale: staleOf(q), staleGiven: "stale" in q };
            });
        }
        var by = {}, keys = [];
        rows.forEach(function (o) {
            if (covered.has(o)) return;
            var k = o.f.id + "|" + (axisOf(o.f) || "");
            if (!by[k]) { by[k] = []; keys.push(k); }
            by[k].push(o);
        });
        var rest = keys.map(function (k, i) {
            var mine = by[k], f = mine[0].f, values = unique(mine.map(function (o) { return o.status === "insufficient" || o.status === "notMeasured" ? null : valueText(o.f); }));
            return { key: given ? "rest|" + k : k, id: String(f.id), axis: axisOf(f), area: mine[0].area, node: f.node || null, tuner: null, status: worst(mine), rank: null, size: null, count: mine.length,
                logs: unique(mine.map(function (o) { return isNum(o.f.log) ? o.f.log : null; })).sort(function (a, b) { return a - b; }),
                profiles: unique(mine.map(function (o) { return L.profileOf(o.f); })), datasets: unique(mine.map(function (o) { return o.f.dataset || null; })),
                // without the range of the worker: the value of the worst result, and the number of the other values
                range: values.length ? { text: values[0] + (values.length > 1 ? " (" + plural(values.length - 1, "more value", "more values") + ")" : "") } : null,
                title: "", summary: "", small: null, rows: mine, order: i, stale: null, staleGiven: false };
        }).sort(function (a, b) { return RANK[a.status] - RANK[b.status] || b.count - a.count || a.order - b.order; });
        out = out.concat(rest);
        out.forEach(function (q) {
            q.rows.sort(function (a, b) { return RANK[a.status] - RANK[b.status]; });
            if (!q.title) q.title = (q.rows[0] && nounOf(q.rows[0].f) ? L.cap(nounOf(q.rows[0].f)) : "Check " + q.id);
            if (!q.summary && q.rows[0]) q.summary = String(q.rows[0].f.summary || "").split("\n")[0];
        });
        out.forEach(function (q, i) { q.n = "i" + i; q.stale = itemStale(q); });
        return out;
    }

    // The 3 most important items: result.top (their keys), else the first items to act on (analysis error, problem, monitor)
    function topIssues(r, issues) {
        var keys = Array.isArray(r.top) ? r.top.map(String) : null, out;
        if (keys) out = keys.map(function (k) { return issues.filter(function (q) { return q.key === k; })[0]; }).filter(Boolean);
        else out = issues.filter(function (q) { return /^(error|problem|monitor)$/.test(q.status); });
        return out.slice(0, TOP);
    }

    // The condition of a card from its items: the worst, but "Monitor" when each problem is small (q.small of the worker, else a
    // size of less than SMALL: M3). given: the condition of the area that the worker gives (result.areas[key].status)
    function cardStatus(list, given) {
        if (typeof given === "string" && LABEL[given]) return given;
        if (!list.length) return "notMeasured";
        var s = worst(list), problems = list.filter(function (q) { return q.status === "problem"; });
        if (s === "problem" && problems.every(function (q) { return q.small === true || (q.small !== false && isNum(q.size) && q.size < SMALL); })) return "monitor";
        return s;
    }

    // The cards in the sequence of their importance: the condition, then the largest size of an item, then the sequence of AREAS.
    // areas: result.areas of the worker ({ [key]: { status } }), or nothing
    function rankAreas(issues, areas) {
        return AREAS.map(function (a, i) {
            var mine = issues.filter(function (q) { return q.area === a.key; }), st = cardStatus(mine, areas && areas[a.key] && mine.length ? areas[a.key].status : null);
            var big = mine.reduce(function (m, q) { return RANK[q.status] <= RANK.monitor && isNum(q.size) ? Math.max(m, q.size) : m; }, 0);
            return { area: a, list: mine, status: st, size: big, i: i };
        }).sort(function (a, b) { return RANK[a.status] - RANK[b.status] || b.size - a.size || a.i - b.i; });
    }

    // The primary items of a card: the items to act on (MAIN at most); with less than 3, also the satisfactory items that have a
    // value, to 3. The others: rest
    function splitRows(list) {
        var top = list.filter(function (o) { return o.status === "error" || o.status === "problem" || o.status === "monitor"; }).slice(0, MAIN);
        if (top.length < 3) {
            top = top.concat(list.filter(function (o) { return (o.status === "satisfactory" || o.status === "information") && (o.range ? !!o.range.text : o.f && isNum(o.f.value)); }).slice(0, 3 - top.length));
            top.sort(function (a, b) { return list.indexOf(a) - list.indexOf(b); });
        }
        return { top: top, rest: list.filter(function (o) { return top.indexOf(o) < 0; }) };
    }

    // The name of a result: the noun of its check, then its id, axis, PID profile, configuration, flight phase and (more than
    // one log) log
    function whereOf(f, many) {
        var L = I(), phase = L.PHASES[f.phase];
        return [f.id, axisOf(f), L.profileText(L.profileOf(f)), f.dataset ? "Configuration " + f.dataset : "", phase ? phase[0] : "", many && isNum(f.log) ? "log " + (f.log + 1) : ""].filter(Boolean).join(", ");
    }

    // The panel of "Show in the log" or "Show the measurement" (one at a time) at the place of its link: "row", "issue" or "top"
    function slotHtml(opts, at, id) {
        return opts.open === id && opts.at === at ? '<div class="analysis-compare" data-analysis-cmp="' + id + '"></div>' : "";
    }

    function logLinkHtml(o, opts, at) {
        return '<a href="#" data-analysis-act="log" data-row="' + o.id + '" data-at="' + at + '"' + (opts.open === o.id && opts.at === at && opts.kind === "log" ? ' class="active"' : "") + ">" +
            esc(TEXT.showInLog) + "</a>";
    }

    function rowHtml(o, opts) {
        var f = o.f, L = I(), noun = nounOf(f), ev = f.evidence || {}, sum = f.summary || ev.summary || "",
            value = o.status === "insufficient" || o.status === "notMeasured" ? null : valueText(f), lim = limitOf(f),
            canLog = !!(ev.view && isNum(ev.view.t0) && isNum(ev.view.t1)) || (Array.isArray(ev.spans) && ev.spans.some(function (s) { return s && isNum(s.t0) && isNum(s.t1); })),
            canCompare = !!(ev.plot && typeof ev.plot === "object");
        return '<li class="analysis-row st-' + o.status + '" data-analysis-row="' + o.id + '">' +
            '<div class="analysis-row-head"><span class="log-lens-badge st-' + o.status + '">' + esc(LABEL[o.status]) + "</span>" +
                '<span class="analysis-what">' + (noun ? "<strong>" + esc(L.cap(noun)) + "</strong> " : "") + '<span class="analysis-where">' + esc(whereOf(f, opts.many)) + "</span></span>" +
                '<span class="analysis-nums">' + (value ? '<span class="analysis-value" title="' + esc(TEXT.value) + '">' + esc(value) + "</span>" : "") +
                    (lim ? '<span class="analysis-limit">' + esc(TEXT.limit) + ": " + (lim.code ? "<code>" + esc(lim.text) + "</code>" : esc(lim.text)) + "</span>" : "") + "</span></div>" +
            (sum ? '<div class="analysis-summary">' + codeText(sum) + "</div>" : "") +
            epochHtml(staleOf(f)) +
            (canLog || canCompare ? '<div class="analysis-links">' + (canLog ? logLinkHtml(o, opts, "row") : "") +
                (canCompare ? '<a href="#" data-analysis-act="compare" data-row="' + o.id + '"' + (opts.open === o.id && opts.at === "row" && opts.kind === "cmp" ? ' class="active"' : "") + ">" + esc(TEXT.compare) + "</a>" : "") + "</div>" : "") +
            (opts.noAction ? "" : actionHtml(o, opts)) +
            (f.text ? '<details class="analysis-raw" data-ste="quoted"><summary>' + esc(TEXT.quoted) + "</summary>" + esc(f.text) + "</details>" : "") +
            slotHtml(opts, "row", o.id) +
            "</li>";
    }

    // What to do about a problem or a value to monitor (SPEC3 I): a finding of a tuning step (poorly tuned parameters) has
    // its recommendations and "Open in the Tuning view" (that step and its recommendation); a hardware or setup item says
    // what to examine (its recommendations) and has no link to the Tuning view. q: the item of the row, when the row is an item
    function actionHtml(o, opts, q) {
        if (!/^(problem|monitor)$/.test(q ? q.status : o.status)) return "";
        var f = o.f, r = opts.r || {}, g = r.hierarchy && r.hierarchy.graph, tuner = q && typeof q.tuner === "boolean" ? q.tuner : tunerOf(f, g), node = (q && q.node) || f.node;
        var seen = {}, recs = [];
        (q ? q.rows : [o]).forEach(function (x) {
            recsFor(r, x.f).forEach(function (rec) {
                if (seen[rec.id] || !(rec.severity === "action" || rec.severity === "check" || ((q ? q.status : o.status) === "monitor" && rec.severity === "watch"))) return;
                seen[rec.id] = true;
                recs.push(rec);
            });
        });
        if (!tuner && !recs.length) return "";
        var said = [], titles = recs.map(function (rec) { return String(rec.title || "").replace(/\s+/g, " "); }).filter(function (t) { return t && said.indexOf(t) < 0 && said.push(t); })
            .slice(0, 3).map(function (t) { // one line for each title: the recommendations of the logs of an item are the same
                var st = recs.filter(function (rec) { return String(rec.title || "").replace(/\s+/g, " ") === t && staleOf(rec); }).map(staleOf)[0]; // r.stale: its text has the causes and the source
                return "<li>" + esc(t) + (st ? '<div class="analysis-epoch-mini"' + (typeof st.text === "string" && st.text ? ' title="' + esc(st.text) + '"' : "") + ">" + esc(TEXT.epochTag) + "</div>" : "") + "</li>";
            }).join("");
        return '<div class="analysis-action' + (tuner ? " is-tuner" : " is-examine") + '">' +
            (titles ? '<div class="analysis-action-label">' + esc(tuner ? TEXT.recommendation : TEXT.examine) + '</div><ul class="analysis-action-list">' + titles + "</ul>" : "") +
            (tuner && node ? '<button type="button" class="btn btn-default btn-xs analysis-tune" data-analysis-act="tune" data-row="' + o.id + '"' + (q ? ' data-issue="' + esc(q.n) + '"' : "") + ">" + esc(TEXT.tune) + "</button>" : "") +
            "</div>";
    }

    // "Logs 6, 11 and 12", "PID profiles 1 and 2", "Configurations B and G", "3 results": where an item comes from
    function issueWhere(q) {
        var L = I(), known = q.profiles.filter(function (p) { return p > 0; }).sort(function (a, b) { return a - b; });
        return [q.logs.length ? (q.logs.length > 1 ? "Logs " : "Log ") + and(q.logs.map(function (l) { return String(l + 1); })) : "",
            known.length ? (known.length > 1 ? "PID profiles " : "PID profile ") + and(known.map(String)) : "", q.profiles.indexOf(0) >= 0 ? L.profileText(0) : "",
            q.datasets.length ? (q.datasets.length > 1 ? "Configurations " : "Configuration ") + and(q.datasets.slice().sort(function (a, b) { return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0); })) : "",
            q.count > 1 ? q.count + " results" : ""].filter(Boolean).join(" · ");
    }

    // One item of a card: its condition, title, range of numbers and limit, its summary, where it comes from, the links of its
    // worst result, what to do, and the results of each log in a disclosure (open when the panel of one of them is open)
    function issueHtml(q, opts) {
        var o = q.rows[0], ev = o ? o.f.evidence || {} : {}, lim = o ? limitOf(o.f) : null, range = q.range && typeof q.range.text === "string" ? q.range.text : "";
        var canLog = !!(ev.view && isNum(ev.view.t0) && isNum(ev.view.t1)) || (Array.isArray(ev.spans) && ev.spans.some(function (x) { return x && isNum(x.t0) && isNum(x.t1); }));
        var open = (opts.issuesOpen && opts.issuesOpen[q.key]) || (opts.at === "row" && q.rows.some(function (x) { return x.id === opts.open; }));
        var sub = { r: opts.r, li: opts.li, open: opts.open, at: opts.at, kind: opts.kind, many: opts.many, noAction: true };
        return '<li class="analysis-issue st-' + q.status + '" data-analysis-issue="' + esc(q.n) + '">' +
            '<div class="analysis-row-head"><span class="log-lens-badge st-' + q.status + '">' + esc(LABEL[q.status]) + "</span>" +
                '<span class="analysis-what"><strong>' + esc(q.title) + '</strong> <span class="analysis-where">' + esc([q.id, q.axis].filter(Boolean).join(", ")) + "</span></span>" +
                '<span class="analysis-nums">' + (range && q.status !== "insufficient" && q.status !== "notMeasured" ? '<span class="analysis-value" title="' + esc(TEXT.value) + '">' + esc(range) + "</span>" : "") +
                    (lim ? '<span class="analysis-limit">' + esc(TEXT.limit) + ": " + (lim.code ? "<code>" + esc(lim.text) + "</code>" : esc(lim.text)) + "</span>" : "") + "</span></div>" +
            (q.summary ? '<div class="analysis-summary">' + codeText(q.summary) + "</div>" : "") +
            (issueWhere(q) ? '<div class="analysis-issue-where">' + esc(issueWhere(q)) + "</div>" : "") +
            epochHtml(q.stale, q.count) +
            (o && canLog ? '<div class="analysis-links">' + logLinkHtml(o, opts, "issue") + "</div>" + slotHtml(opts, "issue", o.id) : "") +
            (o ? actionHtml(o, opts, q) : "") +
            (q.rows.length ? '<details class="analysis-issue-rows" data-analysis-rows="' + esc(q.key) + '"' + (open ? " open" : "") + "><summary>" + esc(TEXT.perLog + " (" + q.rows.length + ")") + "</summary>" +
                '<ul class="analysis-rows">' + q.rows.map(function (x) { return rowHtml(x, sub); }).join("") + "</ul></details>" : "") +
            "</li>";
    }

    // The main numbers of a card: the ranges of its first items (problems first), with their titles
    function keysHtml(list) {
        var out = [];
        list.forEach(function (q) {
            var v = q.status === "insufficient" || q.status === "notMeasured" || q.status === "error" ? null : q.range && q.range.text;
            if (!v || out.length >= KEYS) return;
            out.push('<li class="st-' + q.status + '"><span class="analysis-key-noun">' + esc(q.title + (q.axis ? ", " + q.axis : "")) + '</span> <span class="analysis-key-value">' + esc(v) + "</span></li>");
        });
        return out.length ? '<ul class="analysis-keys">' + out.join("") + "</ul>" : "";
    }

    // The tile of an area in the overview: its title, its condition and the number of problems. A click shows its card
    function tileHtml(x) {
        var s = x.status, n = x.list.filter(function (o) { return o.status === "problem"; }).length, m = x.list.filter(function (o) { return o.status === "monitor"; }).length;
        var state = LABEL[s] + (n ? ": " + (s === "monitor" ? plural(n, "small problem", "small problems") : plural(n, "problem", "problems")) : m ? ": " + plural(m, "item to monitor", "items to monitor") : "");
        return '<li><button type="button" class="analysis-tile st-' + s + '" data-analysis-act="area" data-area="' + x.area.key + '">' +
            '<span class="analysis-tile-title">' + esc(x.area.title) + '</span><span class="analysis-tile-state">' + esc(state) + "</span></button></li>";
    }

    function cardHtml(x, opts) {
        var area = x.area, list = x.list, s = x.status, parts = splitRows(list), n = parts.rest.length,
            openRest = (opts.moreOpen && opts.moreOpen[area.key]) || (opts.at !== "top" && parts.rest.some(function (q) { return q.rows.some(function (o) { return o.id === opts.open; }); }));
        return '<section class="analysis-card st-' + s + '" data-area="' + area.key + '">' +
            '<header class="analysis-card-head"><h4 class="analysis-card-title">' + esc(area.title) + '</h4><span class="log-lens-badge st-' + s + '">' + esc(LABEL[s]) + "</span></header>" +
            (list.length ? keysHtml(list) + '<div class="analysis-counts">' + countsHtml(list) + "</div>" +
                '<ul class="analysis-rows analysis-issues">' + parts.top.map(function (q) { return issueHtml(q, opts); }).join("") + "</ul>" +
                (n ? '<details class="analysis-more" data-analysis-more="' + area.key + '"' + (openRest ? " open" : "") + "><summary>" + esc(n === 1 ? TEXT.oneItem : n + " " + TEXT.moreItems) + '</summary><ul class="analysis-rows analysis-issues">' +
                    parts.rest.map(function (q) { return issueHtml(q, opts); }).join("") + "</ul></details>" : "")
                : '<p class="analysis-muted">' + esc(TEXT.noArea) + "</p>") +
            "</section>";
    }

    // The 3 most important items of the whole analysis, in plain words, at the top (M3)
    function topHtml(list, opts) {
        if (!list.length) return '<div class="analysis-top is-empty"><h4 class="analysis-h">' + esc(TEXT.top) + '</h4><p class="analysis-muted">' + esc(TEXT.noTop) + "</p></div>";
        return '<div class="analysis-top"><h4 class="analysis-h">' + esc(TEXT.top) + '</h4><ol class="analysis-top-list">' + list.map(function (q) {
            var o = q.rows[0], ev = o ? o.f.evidence || {} : {}, area = AREAS.filter(function (a) { return a.key === q.area; })[0];
            var canLog = !!(ev.view && isNum(ev.view.t0) && isNum(ev.view.t1)) || (Array.isArray(ev.spans) && ev.spans.some(function (x) { return x && isNum(x.t0) && isNum(x.t1); }));
            var tuner = typeof q.tuner === "boolean" ? q.tuner : o ? tunerOf(o.f, opts.r.hierarchy && opts.r.hierarchy.graph) : false;
            return '<li class="analysis-top-item st-' + q.status + '"><div class="analysis-row-head"><span class="log-lens-badge st-' + q.status + '">' + esc(LABEL[q.status]) + "</span>" +
                '<span class="analysis-what"><strong>' + esc(q.title) + "</strong>" + (area ? ' <span class="analysis-where">' + esc(area.title) + "</span>" : "") + "</span>" +
                (q.range && q.range.text && q.status !== "error" ? '<span class="analysis-nums"><span class="analysis-value">' + esc(q.range.text) + "</span></span>" : "") + "</div>" +
                (q.summary ? '<div class="analysis-summary">' + codeText(q.summary) + "</div>" : "") +
                (issueWhere(q) ? '<div class="analysis-issue-where">' + esc(issueWhere(q)) + "</div>" : "") +
                epochHtml(q.stale, q.count) +
                '<div class="analysis-links">' + (o && canLog ? logLinkHtml(o, opts, "top") : "") +
                    (tuner && (q.node || (o && o.f.node)) && o ? '<a href="#" data-analysis-act="tune" data-row="' + o.id + '" data-issue="' + esc(q.n) + '">' + esc(TEXT.tune) + "</a>" : "") +
                    (area ? '<a href="#" data-analysis-act="area" data-area="' + area.key + '">' + esc(TEXT.showCard) + "</a>" : "") + "</div>" +
                (o && canLog ? slotHtml(opts, "top", o.id) : "") + "</li>";
        }).join("") + "</ol></div>";
    }

    // The nodes of result.hierarchy.graph by id: the items before the first flight (prereq) and the tuning steps (blocks) of
    // SPEC3 K1, else the nodes of an older graph
    function graphNodes(g) {
        var byId = {};
        if (!g || typeof g !== "object") return byId;
        var list = [].concat(Array.isArray(g.prereq) ? g.prereq.map(function (n) { return Object.assign({ kind: "prereq" }, n); }) : [],
            Array.isArray(g.blocks) ? g.blocks.map(function (n) { return Object.assign({ kind: "block" }, n); }) : [],
            Array.isArray(g.nodes) ? g.nodes : g.nodes && typeof g.nodes === "object" ? Object.keys(g.nodes).map(function (k) { return Object.assign({ id: k }, g.nodes[k]); }) : []);
        list.forEach(function (n) { if (n && n.id && !byId[n.id]) byId[n.id] = n; });
        return byId;
    }

    // The number of a tuning step: its order, with "a" for the cyclic lane and "b" for the tail lane ("3a"), or its step
    function stepOf(n) {
        if (!n) return null;
        if (n.kind === "block" && isNum(+n.order) && n.order !== null) return String(+n.order) + (n.lane === "cyclic" ? "a" : n.lane === "tail" ? "b" : "");
        return isNum(+n.step) && n.step !== null && n.step !== undefined ? String(+n.step) : null;
    }

    // The steps of the tuning order to do first: result.hierarchy.startHere, with the titles of the steps of
    // result.hierarchy.graph. Without a title: the checks of the problems of the step, with the noun that the worker gives
    // each finding ("Tail output limit (T8)")
    function startHereOf(r) {
        var h = r.hierarchy, ids = h && Array.isArray(h.startHere) ? h.startHere : [], L = I(), byId = graphNodes(h && h.graph), byFid = {};
        (Array.isArray(r.findings) ? r.findings : []).forEach(function (f) { if (f && f.fid) byFid[f.fid] = f; });
        return ids.map(function (id, k) {
            var n = byId[id], st = h.nodes && h.nodes[id], title = n && n.title ? String(n.title) : "", checks = [];
            if (n && n.kind === "prereq") return null;
            if (!title) {
                (st && Array.isArray(st.problemFids) ? st.problemFids : []).forEach(function (fid) {
                    var f = byFid[fid];
                    if (f && nounOf(f) && !checks.some(function (c) { return c.id === f.id; })) checks.push({ id: f.id, noun: nounOf(f) });
                });
                title = checks.map(function (c) { return L.cap(c.noun) + " (" + c.id + ")"; }).join(", ");
            }
            return title ? { id: String(id), title: title, step: stepOf(n), number: st && isNum(st.number) ? st.number : k + 1 } : null;
        }).filter(Boolean).sort(function (a, b) { return (a.number || 99) - (b.number || 99); }); // a step with no title and no result is not shown
    }

    // The items before the first flight with a problem (SPEC3 A: hierarchy.prereqProblems, else the items with the status
    // "problem"), with their titles
    function prereqProblemsOf(r) {
        var h = r.hierarchy, byId = graphNodes(h && h.graph), g = h && h.graph;
        var ids = h && Array.isArray(h.prereqProblems) ? h.prereqProblems :
            (g && Array.isArray(g.prereq) ? g.prereq : []).filter(function (p) { return p && h.nodes && h.nodes[p.id] && h.nodes[p.id].status === "problem"; }).map(function (p) { return p.id; });
        return ids.filter(function (id) { return byId[id] && byId[id].title; }).map(function (id) { return { id: String(id), title: String(byId[id].title) }; });
    }

    // The configurations of the analysis (SPEC3 J, result.datasets): "The logs have 4 configurations: A, B, C and D." with a
    // link to the tab "Configurations" of the Tuning view. Nothing with one configuration or none
    function configsHtml(r) {
        var ds = r && r.datasets, list = ds && Array.isArray(ds.datasets) ? ds.datasets.filter(function (d) { return d && d.id && d.analysed !== false; }) : [];
        if (list.length < 2) return "";
        var diff = Array.isArray(ds.diff) ? ds.diff.length : 0;
        return '<p class="analysis-muted analysis-configs">' + esc("The analysis has " + list.length + " configurations: " + and(list.map(function (d) { return d.id; })) + "." +
            (diff ? " " + plural(diff, "parameter is", "parameters are") + " not the same in all configurations." : "") + " " + TEXT.configsNote) +
            ' <button type="button" class="btn btn-default btn-xs" data-analysis-act="configs">' + esc(TEXT.showConfigs) + "</button></p>";
    }

    // A log with no data that the decoder can read (M4: records[].noData with the decoder's reason): { why } or null
    function noDataOf(r, li) {
        var L = I();
        if (L && L.noDataOf) return L.noDataOf(r, li);
        var e = (Array.isArray(r.noData) ? r.noData : []).filter(function (q) { return q && q.log === li; })[0];
        if (e) return { why: typeof e.reason === "string" ? e.reason : "" };
        var rec = (Array.isArray(r.records) ? r.records : []).filter(function (q) { return q && q.log === li && q.noData; })[0];
        return rec ? { why: typeof (rec.noDataReason || rec.reason) === "string" ? String(rec.noDataReason || rec.reason) : "" } : null;
    }

    // "Show in the log" of finding f: { log, fromS, toS, atS, graphs, analyser, title, text } (frame seconds, js/main.js
    // viewInLog), from evidence.view, else the first span of the evidence. Without the graphs of the check: the setpoint and the
    // gyro of its axis, else the headspeed. null: no time in the log
    function logReq(f, many) {
        var ev = f && f.evidence, L = I();
        if (!ev) return null;
        var v = ev.view && isNum(ev.view.t0) && isNum(ev.view.t1) ? ev.view : null, s = (Array.isArray(ev.spans) ? ev.spans : []).filter(function (q) { return q && isNum(q.t0) && isNum(q.t1); })[0];
        if (!v && !s) return null;
        var k = AXES.indexOf(axisOf(f)), graphs = v && Array.isArray(v.graphs) ? v.graphs.filter(function (g) { return Array.isArray(g) && g.length; }) : [];
        return { log: v && isNum(v.log) ? v.log : s && isNum(s.log) ? s.log : isNum(ev.log) ? ev.log : f.log, fromS: Math.min(v ? v.t0 : s.t0, v ? v.t1 : s.t1), toS: Math.max(v ? v.t0 : s.t0, v ? v.t1 : s.t1),
            atS: v && isNum(v.at) ? v.at : undefined, graphs: graphs.length ? graphs : k >= 0 ? [["setpoint[" + k + "]", "gyroADC[" + k + "]"]] : [["headspeed", "govTarget"]],
            analyser: v ? v.analyser : undefined, title: [nounOf(f) && L ? L.cap(nounOf(f)) : "", L ? whereOf(f, many) : ""].filter(Boolean).join(", "), text: f.summary || ev.summary || "" };
    }

    // Shared with the log preview in the Tuning view.
    function logSpecs(f, req, data, t0, t1) {
        return I().logSpecs(f, req, data, t0, t1);
    }

    // The flights and bench runs of each log of the result (SPEC2 D13)
    function logsHtml(r) {
        var L = I(), list = logsOf(r), total = 0, flown = 0;
        var items = list.map(function (lg) {
            var name = "Log " + (lg + 1), nd = noDataOf(r, lg);
            if (nd) return "<li><strong>" + esc(name) + "</strong>: " + esc(TEXT.noData) + (nd.why ? ' <span class="analysis-muted" data-ste="quoted" title="' + esc(nd.why) + '">(' + esc(nd.why.length > 60 ? nd.why.slice(0, 57) + "..." : nd.why) + ")</span>" : "") + "</li>";
            if (L.benchOf(r, lg)) return "<li><strong>" + esc(name) + "</strong>: " + esc(TEXT.bench) + "</li>";
            var fl = L.flightsOf(r, lg);
            if (fl.length) {
                total += fl.length;
                flown++;
                var secs = fl.reduce(function (s, q) { return s + q.seconds; }, 0);
                return "<li><strong>" + esc(name) + "</strong>: " + esc(plural(fl.length, "flight", "flights") + ", " + sec(secs) + ".") + " " + fl.map(function (q, i) {
                    return '<span class="log-lens-flight is-static">' + esc(TEXT.flight + " " + (i + 1) + ": " + sec(q.t0) + " to " + sec(q.t1)) + "</span>";
                }).join(" ") + "</li>";
            }
            var s = L.recordsOf(r, lg).reduce(function (a, q) { return a + (isNum(q.flyingS) ? q.flyingS : 0); }, 0);
            if (s > 0) flown++;
            return "<li><strong>" + esc(name) + "</strong>: " + esc(s > 0 ? sec(s) + " of flight." : TEXT.noFlight) + "</li>";
        });
        var head = total && list.length > 1 ? '<p class="analysis-muted">' + esc(plural(total, "flight", "flights") + " in " + plural(flown, "log", "logs") + ".") + "</p>" : "";
        return list.length ? '<div class="analysis-logs"><h5 class="analysis-h">' + esc(TEXT.logs) + "</h5>" + head + '<ul class="analysis-log-list">' + items.join("") + "</ul></div>" : "";
    }

    // The whole verdict of result r. opts: { li (the open log), open (the row id of the compare panel), moreOpen (the areas
    // whose "N more results" are open) }
    function verdictHtml(r, opts) {
        var L = I(), rows = rowsOf(r), many = logsOf(r).length > 1, o = { r: r, li: opts.li, open: opts.open, at: opts.at, kind: opts.kind, many: many, moreOpen: opts.moreOpen || {}, issuesOpen: opts.issuesOpen || {} };
        var issues = opts.issues || issuesOf(r, rows), cards = rankAreas(issues, r.areas && typeof r.areas === "object" ? r.areas : null);
        var problems = issues.filter(function (q) { return q.status === "problem"; }), monitor = issues.filter(function (q) { return q.status === "monitor"; }),
            errors = issues.filter(function (q) { return q.status === "error"; });
        var withProblem = cards.filter(function (x) { return x.status === "problem"; }).map(function (x) { return '"' + x.area.title + '"'; });
        var profiles = [];
        rows.forEach(function (q) { var p = L.profileOf(q.f); if (p > 0 && profiles.indexOf(p) < 0) profiles.push(p); });
        profiles.sort(function (a, b) { return a - b; });
        var start = startHereOf(r), pre = prereqProblemsOf(r), lowRate = rows.some(function (q) { return q.f.id === "D1" && q.status === "problem"; });
        var meta = ['<code>' + esc(r.fileName || "") + "</code>", esc(r.scope === "file" ? plural(logsOf(r).length, "log", "logs") : "Log " + (isNum(r.logIndex) ? r.logIndex + 1 : "?")),
            profiles.length ? esc((profiles.length > 1 ? "PID profiles " : "PID profile ") + and(profiles.map(String))) : "",
            r.timing && isNum(r.timing.totalS) ? esc(TEXT.analysisTime + " " + r.timing.totalS.toFixed(1) + " s") : ""].filter(Boolean).join(" · ");
        var found = [problems.length ? plural(problems.length, "problem", "problems") : "", monitor.length ? plural(monitor.length, "item to monitor", "items to monitor") : ""].filter(Boolean);
        var summary = '<p class="analysis-verdict">' + esc(found.length ? "The analysis found " + and(found) + " in " + plural(rows.length, "result", "results") + "." : TEXT.noProblem) +
            (withProblem.length ? " " + esc(TEXT.problemAreas + " " + and(withProblem) + ".") : "") +
            (errors.length ? " " + esc(plural(errors.length, "check", "checks") + " did not operate because of an analysis error.") : "") + "</p>";
        return '<div class="analysis-verdict-box">' +
            '<div class="analysis-head"><h3 class="analysis-title">' + esc(TEXT.title) + '</h3><span class="analysis-meta">' + meta + "</span></div>" +
            '<div class="analysis-scope" data-analysis-scope="1"></div>' +
            topHtml(topIssues(r, issues), o) +
            '<div class="analysis-summary-row"><div class="analysis-summary-main">' + summary + '<div class="analysis-counts">' + countsHtml(issues) + "</div>" +
                // the flight selection of the run (SPEC3 D: result.selection.text of js/tuning_worker.js, "Flights in the analysis: ...")
                (r.selection && typeof r.selection.text === "string" ? '<p class="analysis-muted analysis-selection">' + esc(r.selection.text) + "</p>" : "") +
                epochSummaryHtml(r, rows) +
                (lowRate ? '<p class="analysis-warn">' + esc(TEXT.lowRate) + "</p>" : "") +
                (pre.length ? '<p class="analysis-warn analysis-prereq">' + esc(TEXT.prereqProblem + " " + and(pre.map(function (q) { return q.title; })) + ".") + "</p>" : "") +
                (start.length ? '<div class="analysis-start"><strong>' + esc(TEXT.startHere) + "</strong>: " + '<ol class="analysis-start-list">' + start.map(function (q) {
                    return "<li>" + esc(q.title) + (q.step ? ' <span class="analysis-muted">' + esc("(step " + q.step + ")") + "</span>" : "") + "</li>";
                }).join("") + "</ol></div>" : "") +
                configsHtml(r) +
                '<p class="analysis-muted">' + esc(TEXT.tuningNote) + ' <button type="button" class="btn btn-default btn-xs" data-analysis-act="tuning">' + esc(TEXT.openTuning) + "</button></p>" +
                '<ul class="analysis-health" aria-label="' + esc(TEXT.overview) + '">' + cards.map(tileHtml).join("") + "</ul>" +
            "</div>" + logsHtml(r) + "</div>" +
            '<div class="analysis-cards">' + cards.map(function (x) { return cardHtml(x, o); }).join("") + "</div>" +
            "</div>";
    }

    function emptyHtml(state) {
        return '<div class="analysis-verdict-box is-empty"><div class="analysis-head"><h3 class="analysis-title">' + esc(TEXT.title) + "</h3></div>" +
            '<div class="analysis-scope" data-analysis-scope="1"></div>' +
            '<p class="analysis-verdict">' + esc(TEXT.noResult) + ' <button type="button" class="btn btn-primary btn-sm" data-analysis-act="start"' + (state.running ? " disabled" : "") + ">" +
                esc(TEXT.start) + "</button></p>" +
            (state.running ? '<p class="analysis-muted">' + esc(TEXT.running) + "</p>" : "") +
            (state.error ? '<p class="analysis-warn">' + (I() ? I().runErrorHtml(state.error) : esc(TEXT.startFailed)) + "</p>" : "") +
            '<p class="analysis-muted">' + esc(TEXT.about) + ' <button type="button" class="btn btn-default btn-xs" data-analysis-act="tuning">' + esc(TEXT.openTuning) + "</button></p></div>";
    }

    // ---------------------------------------------------------------------------------------------
    // The verdict

    function Verdict(container, hooks) {
        hooks = hooks || {};
        var root = container && container.jquery ? container[0] : container, self = this;
        var log = null, li = -1, given = null, result = null, rows = [], issues = [], open = null, running = false, startError = null, plots = [], compares = new Map(), reader = null,
            moreOpen = {},   // the areas whose "N more items" the user opened: they stay open when the verdict is drawn again
            issuesOpen = {}; // the items whose results of each log the user opened

        function covers(r) {
            if (!r || typeof r !== "object") return false;
            var name = hooks.getFileName ? hooks.getFileName() : null;
            if (name && r.fileName && String(r.fileName) !== String(name)) return false;
            return r.scope === "file" || r.logIndex === li;
        }

        function destroyPlots() {
            plots.forEach(function (h) { try { h.destroy(); } catch (e) { console.warn(e); } });
            plots = [];
        }

        function render() {
            var scopeState = getScopeState();
            destroyPlots();
            if (!I()) {
                root.innerHTML = '<div class="analysis-verdict-box"><p class="analysis-warn">' + esc(TEXT.noLens) + "</p></div>";
                return;
            }
            rows = result ? rowsOf(result) : [];
            issues = result ? issuesOf(result, rows) : [];
            if (open && !rows.some(function (o) { return o.id === open.id && o.f === open.f; })) open = null;
            root.innerHTML = result ? verdictHtml(result, { li: li, open: open && open.id, at: open && open.at, kind: open && open.kind, moreOpen: moreOpen, issuesOpen: issuesOpen, issues: issues }) :
                emptyHtml({ running: running, error: startError });
            renderScope(scopeState);
            if (open) (open.kind === "log" ? drawLog : drawCompare)(open);
        }

        // The "Logs" control of the analysis (2026-10-06): the settings of the Tuning view (hooks.scopePanel, js/tuning_dialog.js):
        // by default all flights of the file, else the flights that the pilot selects (a list that collapses) or the log on
        // display. With a result for other settings, a note and the start button. Keep the table's scroll position and focus,
        // including when a cached result replaces the whole verdict.
        function getScopeState() {
            var el = root.querySelector ? root.querySelector("[data-analysis-scope]") : null;
            var TD = typeof TuningDialog !== "undefined" && TuningDialog.internals ? TuningDialog.internals : null;
            return TD && TD.fselState ? TD.fselState(el) : null;
        }

        function renderScope(state) {
            var el = root.querySelector ? root.querySelector("[data-analysis-scope]") : null;
            if (!el) return;
            var p = null;
            try { p = typeof hooks.scopePanel === "function" ? hooks.scopePanel() : null; } catch (e) { console.warn(e); }
            var TD = typeof TuningDialog !== "undefined" && TuningDialog.internals ? TuningDialog.internals : null, again = state || getScopeState();
            el.innerHTML = !p || typeof p.html !== "string" ? "" : p.html + (p.stale && result && !p.running ? '<p class="analysis-muted analysis-stale">' + esc(TEXT.stale) +
                ' <button type="button" class="btn btn-primary btn-xs" data-analysis-act="start">' + esc(TEXT.start) + "</button></p>" : "");
            if (el.querySelectorAll) Array.prototype.forEach.call(el.querySelectorAll('[data-partly="1"]'), function (x) { x.indeterminate = true; });
            if (TD && TD.fselRestore) TD.fselRestore(el, again);
        }

        function scopeAct(act) {
            if (typeof hooks.scopeAction === "function") hooks.scopeAction(act);
        }

        function rowOf(id) {
            return rows.filter(function (o) { return o.id === id; })[0] || null;
        }

        function getReader() {
            if (!reader && typeof TuningSnippet !== "undefined" && TuningSnippet.Reader) reader = new TuningSnippet.Reader(hooks);
            return reader;
        }

        function compareOf(f) {
            if (!compares.has(f)) {
                compares.set(f, I().evidenceCompare(f, result, {
                    derive: function (kind, cols, rate, params) {
                        if (typeof hooks.derive !== "function") return Promise.reject(new Error("no derive"));
                        var copy = {};
                        Object.keys(cols || {}).forEach(function (k) { if (cols[k]) copy[k] = new Float32Array(cols[k]); }); // copies that the worker takes
                        return Promise.resolve().then(function () { return hooks.derive(kind, copy, rate, params || {}, true); });
                    },
                    reader: getReader
                }));
            }
            return compares.get(f);
        }

        // The panel under a row: what is satisfactory, what the check measured, then the plot or the table
        function drawCompare(o) {
            var slot = root.querySelector("[data-analysis-cmp]"), f = o.f, L = I();
            if (!slot) return;
            slot.innerHTML = '<div class="analysis-compare-head"><strong>' + esc(TEXT.measurement) + '</strong><button type="button" class="btn btn-default btn-xs" data-analysis-act="close">' +
                esc(TEXT.close) + '</button></div><div class="analysis-compare-body"><p class="analysis-muted">' + esc(TEXT.busy) + "</p></div>";
            var mine = open;
            compareOf(f).then(function (out) {
                if (open !== mine) return;
                var body = root.querySelector("[data-analysis-cmp] .analysis-compare-body") || slot, c = out.na ? null : L.compareOut(f, out);
                destroyPlots();
                var lines = c ? c.lines.map(function (q) { return '<div class="log-lens-line"><strong>' + esc(q[0]) + "</strong> " + esc(q[1]) + "</div>"; }).join("") : "",
                    caption = (c && c.caption ? '<p class="log-lens-caption is-plot">' + esc(c.caption).replace(/`([^`]*)`/g, "<code>$1</code>") + "</p>" : "") +
                        (c && c.text ? '<p class="log-lens-caption">' + esc(c.text).replace(/`([^`]*)`/g, "<code>$1</code>") + "</p>" : "");
                if (out.na) {
                    body.innerHTML = '<p class="analysis-muted">' + esc(TEXT.noPlot) + " " + esc(out.na) + (out.error ? L.quoted(L.message(out.error)) : "") + "</p>";
                } else if (c.table) {
                    body.innerHTML = lines + L.tableHtml(c.table) + caption;
                } else if (!c.specs.length || typeof TuningPlot === "undefined") {
                    body.innerHTML = lines + '<p class="analysis-muted">' + esc(TEXT.noPlot) + " " + esc(typeof TuningPlot === "undefined" ? TEXT.noPlots : "") + "</p>";
                } else {
                    body.innerHTML = lines + '<div class="log-lens-plot"><canvas class="analysis-compare-canvas" data-analysis-plot="' + o.id + '"></canvas></div>' + caption;
                    try { plots.push(TuningPlot.attach(body.querySelector('[data-analysis-plot="' + o.id + '"]'), c.specs[0])); } catch (e) { console.error(e); }
                }
            });
        }

        // "Show in the log": the fields of the check over the span of the result, read from the log (5 % more on each side), in
        // the panel under the link. The verdict stays on display. "Open in the log viewer" shows the same span in the viewer
        function drawLog(o) {
            var slot = root.querySelector("[data-analysis-cmp]"), f = o.f, L = I(), req = logReq(f, logsOf(result).length > 1), rd = getReader(), mine = open;
            if (!slot) return;
            var model = req ? L.logPreview(f, req, result, rd) : null, epochs = model ? model.epochs : "";
            slot.innerHTML = L.logPreviewHtml(req, epochs, {
                viewer: hooks.viewInLog && req ? 'data-analysis-act="viewer" data-row="' + esc(o.id) + '"' : "",
                close: 'data-analysis-act="close"'
            });
            Promise.resolve().then(function () {
                if (!model) throw new Error(TEXT.noRead);
                return model.read();
            }).then(function (data) {
                if (open !== mine) return;
                var body = root.querySelector("[data-analysis-cmp] .analysis-compare-body");
                if (!body) return;
                var specs = data.specs;
                destroyPlots();
                body.innerHTML = L.logPreviewBody(data, typeof TuningPlot === "undefined" ? [] :
                    specs.map(function (q, i) { return 'data-analysis-plot="' + i + '"'; }));
                if (typeof TuningPlot !== "undefined") specs.forEach(function (q, i) {
                    try { plots.push(TuningPlot.attach(body.querySelector('[data-analysis-plot="' + i + '"]'), q)); } catch (e) { console.error(e); }
                });
            }).catch(function (e) {
                if (open !== mine) return;
                var body = root.querySelector("[data-analysis-cmp] .analysis-compare-body"), m = L.message(e);
                if (body) body.innerHTML = '<p class="analysis-muted">' + esc(TEXT.noRead) + (m && m !== TEXT.noRead ? L.quoted(m) : "") + "</p>";
            });
        }

        // One panel at a time: a second click on its link closes it
        function toggle(id, kind, at) {
            var o = rowOf(id);
            if (!o || (kind === "log" && !logReq(o.f))) return;
            open = open && open.id === id && open.kind === kind && open.at === at ? null : { id: id, f: o.f, kind: kind, at: at };
            render();
            var slot = open && root.querySelector("[data-analysis-cmp]");
            if (slot && slot.scrollIntoView) slot.scrollIntoView({ block: "nearest" });
        }

        function openViewer(id) {
            var o = rowOf(id), req = o && logReq(o.f, logsOf(result).length > 1);
            if (req && hooks.viewInLog) hooks.viewInLog(Object.assign(req, { from: "analysis" }));
        }

        // "Open in the Tuning view" of a finding of a tuning step: hooks.openTuning({ node, fid, recs }) shows the Tuning view
        // with that step and its recommendations (js/main.js: TuningDialog focus)
        function openInTuning(id, issueId) {
            var o = rowOf(id), f = o && o.f, q = issueId ? issues.filter(function (x) { return x.n === issueId; })[0] : null, recs = [];
            if (!f || !hooks.openTuning) return;
            (q ? q.rows : [o]).forEach(function (x) { recsFor(result, x.f).forEach(function (rec) { if (recs.indexOf(rec.id) < 0) recs.push(rec.id); }); });
            hooks.openTuning({ node: (q && q.node) || f.node || null, fid: f.fid || null, recs: recs });
        }

        // runAnalysis of js/tuning_dialog.js: a Promise of the result, which rejects when the run stops (an error of the
        // worker, Cancel, or a run with other settings: reason "replaced", no error to show). false: no file. true (an old
        // host): the result comes through onResult
        function start() {
            running = true;
            startError = null;
            render();
            var p;
            try {
                p = hooks.runAnalysis ? hooks.runAnalysis() : false;
            } catch (e) {
                p = Promise.reject(e);
            }
            if (p === false) p = Promise.reject(new Error(TEXT.startFailed)); // js/tuning_dialog.js runAnalysis: no run
            if (p && typeof p.then === "function") {
                p.then(function (r) {
                    if (r && typeof r === "object") self.setResult(r);
                    if (running && !result) { // the result is not for this log of this file: the button again
                        running = false;
                        render();
                    }
                }, function (e) {
                    running = false;
                    startError = e && e.reason === "replaced" ? null : e || new Error(TEXT.startFailed);
                    render();
                });
            }
        }

        root.addEventListener("change", function (e) {
            var t = e.target;
            if (!t || !t.classList || !t.closest || !t.closest("[data-analysis-scope]")) return;
            if (t.classList.contains("tuning-scope")) scopeAct({ kind: "scope", value: t.value });
            else if (t.classList.contains("tuning-fsel-log")) scopeAct({ kind: "log", log: +t.getAttribute("data-log"), on: !!t.checked });
            else if (t.classList.contains("tuning-fsel-one")) scopeAct({ kind: "flight", log: +t.getAttribute("data-log"), flight: +t.getAttribute("data-flight"), count: +t.getAttribute("data-count"), on: !!t.checked });
        });

        root.addEventListener("click", function (e) {
            var inScope = e.target && e.target.closest ? e.target.closest("[data-analysis-scope]") : null;
            if (inScope) {
                var b = e.target.closest(".tuning-fsel-all, .tuning-fsel-none, .tuning-fsel-head, .tuning-fsel-sub > summary");
                if (b && b.classList.contains("tuning-fsel-all")) { e.preventDefault(); scopeAct({ kind: "all" }); return; }
                if (b && b.classList.contains("tuning-fsel-none")) { e.preventDefault(); scopeAct({ kind: "none" }); return; }
                // the click comes before the details element opens or closes
                if (b && b.classList.contains("tuning-fsel-head")) { scopeAct({ kind: "open", on: !b.parentNode.open }); return; }
                if (b) { scopeAct({ kind: "sub", log: +b.parentNode.getAttribute("data-log"), on: !b.parentNode.open }); return; }
            }
            var sum = e.target && e.target.closest ? e.target.closest("summary") : null, more = sum && sum.parentNode && sum.parentNode.getAttribute ? sum.parentNode.getAttribute("data-analysis-more") : null,
                rowsOf1 = sum && sum.parentNode && sum.parentNode.getAttribute ? sum.parentNode.getAttribute("data-analysis-rows") : null;
            if (more) moreOpen[more] = !sum.parentNode.open; // the click comes before the details element opens or closes
            if (rowsOf1) issuesOpen[rowsOf1] = !sum.parentNode.open;
            var t = e.target && e.target.closest ? e.target.closest("[data-analysis-act]") : null;
            if (!t) return;
            e.preventDefault();
            var act = t.getAttribute("data-analysis-act");
            if (act === "start") start();
            else if (act === "tuning") { if (hooks.openTuning) hooks.openTuning(); }
            else if (act === "configs") { if (hooks.openTuning) hooks.openTuning({ tab: "configs" }); }
            else if (act === "tune") openInTuning(t.getAttribute("data-row"), t.getAttribute("data-issue"));
            else if (act === "area") {
                var card = root.querySelector('section[data-area="' + String(t.getAttribute("data-area")).replace(/[^a-z]/g, "") + '"]');
                if (card && card.scrollIntoView) card.scrollIntoView({ block: "start" });
            }
            else if (act === "log") toggle(t.getAttribute("data-row"), "log", /^(issue|top)$/.test(t.getAttribute("data-at")) ? t.getAttribute("data-at") : "row");
            else if (act === "viewer") openViewer(t.getAttribute("data-row"));
            else if (act === "compare") toggle(t.getAttribute("data-row"), "cmp", "row");
            else if (act === "close") { open = null; render(); }
        });

        this.show = function (flightLog) {
            log = (hooks.getFlightLog && hooks.getFlightLog()) || flightLog || null;
            var i = hooks.getCurrentLogIndex ? hooks.getCurrentLogIndex() : null;
            li = isNum(i) ? i : log && log.getLogIndex ? log.getLogIndex() : 0;
            running = false; // a run that the Tuning view did not finish can start again
            if (reader && reader.sync) reader.sync(); // the log of another file that it kept
            if (hooks.getResult) given = hooks.getResult() || null;
            var next = covers(given) ? given : null;
            if (next !== result) {
                result = next;
                compares = new Map();
                open = null;
                moreOpen = {};
                issuesOpen = {};
            }
            render();
        };

        this.hide = function () {
            destroyPlots();
        };

        // A TuningResult (null: none). It applies when it is of the open file and covers the open log
        this.setResult = function (r) {
            given = r || null;
            var next = covers(given) ? given : null;
            if (next) running = false;
            if (next === result) return;
            result = next;
            compares = new Map();
            open = null;
            moreOpen = {};
            issuesOpen = {};
            render();
        };

        this.internals = { getResult: function () { return result; }, rows: function () { return rows.slice(); }, issues: function () { return issues.slice(); } };

        if (typeof hooks.onResult === "function") hooks.onResult(function (r) { self.setResult(r); });
        if (typeof hooks.onSettings === "function") hooks.onSettings(function () { renderScope(); });
    }

    // ---------------------------------------------------------------------------------------------
    // The view: the verdict

    function AnalysisView(container, hooks) {
        var root = container && container.jquery ? container[0] : container, self = this, verdictEl = root.querySelector("#analysisVerdictBody");
        this.verdict = verdictEl ? new Verdict(verdictEl, hooks || {}) : null;

        this.show = function (flightLog) { if (self.verdict) self.verdict.show(flightLog); };
        this.hide = function () { if (self.verdict) self.verdict.hide(); };
        this.setResult = function (r) { if (self.verdict) self.verdict.setResult(r); };
    }

    AnalysisView.Verdict = Verdict;

    // Pure pieces, for test/analysis_view.test.cjs
    AnalysisView.internals = {
        TEXT: TEXT, AREAS: AREAS, LABEL: LABEL, MAIN: MAIN, esc: esc, nfmt: nfmt, unitOf: unitOf, nounOf: nounOf, valueText: valueText,
        limitOf: limitOf, areaOf: areaOf, tunerOf: tunerOf, recsFor: recsFor, prereqProblemsOf: prereqProblemsOf, rowsOf: rowsOf, splitRows: splitRows, logsOf: logsOf, startHereOf: startHereOf, verdictHtml: verdictHtml, emptyHtml: emptyHtml,
        issuesOf: issuesOf, topIssues: topIssues, dumpOnly: dumpOnly, logReq: logReq, logSpecs: logSpecs, cardStatus: cardStatus, rankAreas: rankAreas, noDataOf: noDataOf, SMALL: SMALL, TOP: TOP,
        itemStale: itemStale, epochHtml: epochHtml, epochSummaryHtml: epochSummaryHtml
    };

    return AnalysisView;
})();
