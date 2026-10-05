"use strict";

/**
 * TuningDialog - the "Tuning" modal.
 *
 * Runs the offline toolkit (tools/autotune, inside js/tuning_worker.js) on the open log or on every
 * log in the file, then shows the TuningResult: findings with their number, uncertainty and rule,
 * recommendations with CLI text for the pilot to review, which setup areas could be assessed, and
 * error curves drawn with TuningPlot. Built once in js/main.js against the jQuery-wrapped modal, with
 * hooks into the viewer:
 *   { seek(us), selectLog(i), getBytes() (the whole file: copied, never transferred),
 *     getFileName(), getCurrentLogIndex(), getFlightLog() }
 * read at each use: main.js replaces the file and its FlightLog on every load, also one dropped on the
 * window while this modal is open.
 *
 * Advice only: nothing is sent to a flight controller. Every string that comes from the log or the
 * worker is escaped before it becomes HTML.
 */
var TuningDialog = (function () {

    var AXES = ["roll", "pitch", "yaw"];

    // Rotorflight 4.6 governor states, as in lib.cjs govStateAt
    var GOV_STATES = ["OFF", "IDLE", "SPOOLUP", "RECOVERY", "ACTIVE", "HOLD", "FALLBACK", "AUTOROTATION", "BAILOUT", "BYPASS"];

    var SEVERITY_RANK = { error: 0, flag: 1, note: 2, ok: 3, skipped: 4 };

    // Checks whose notes report a measurement rather than a problem (TUNING_KNOWLEDGE.md section 10)
    var REPORT_ONLY = { C8: 1, C9: 1, C13: 1, C14: 1, D3: 1, D6: 1, F10: 1, F11: 1, G8: 1, G14: 1, H: 1, R1: 1, SETUP: 1, T12: 1, T13: 1, T14: 1 };

    // Card and badge states, coloured as in css/flight_analysis_dialog.css
    var STATUS_LABEL = {
        error: "Analysis error", attention: "Needs attention", watch: "Worth watching", good: "Looks good",
        info: "Report only", insufficient: "Not enough data"
    };
    var STATUS_ORDER = ["error", "attention", "watch", "good", "info", "insufficient"];

    // Overview areas; findings are placed by check id, as in health_report's sections
    var AREAS = [
        { key: "data", title: "Data", re: /^(D\d+|H|SETUP)$/ },
        { key: "filters", title: "Filters & vibration", re: /^F\d+$/ },
        { key: "governor", title: "Governor & power", re: /^G\d+$/ },
        { key: "cyclic", title: "Cyclic", re: /^C\d+$/ },
        { key: "tail", title: "Tail", re: /^T\d+$/ },
        { key: "rates", title: "Rates & sticks", re: /^R\d+$/ }
    ];
    var MODULE_AREA = { gov: "governor", loop: "cyclic", track: "cyclic" };
    var REC_AREA = {
        precondition: "data", logging: "data", mechanical: "data", filters: "filters", governor: "governor",
        tail: "tail", cyclic: "cyclic", rates: "rates"
    };
    var REC_SEVERITY = {
        action: { label: "Action", status: "attention", rank: 0 }, check: { label: "Check", status: "watch", rank: 1 },
        watch: { label: "Watch", status: "info", rank: 2 }, info: { label: "Info", status: "insufficient", rank: 3 }
    };
    var COVERAGE = {
        finding: ["Finding", "attention"], checked: ["Checked", "good"], "not-assessable": ["Not assessable", "insufficient"],
        "needs-cli": ["Needs CLI dump", "info"], "needs-fields": ["Needs logged fields", "info"], "needs-flights": ["Needs more flights", "info"],
        "no-check": ["Not checked by the app", "insufficient"] // no check of the app informs the group: none exists, or it does not run in the app
    };

    var TABS = [
        { key: "overview", title: "Overview" }, { key: "recs", title: "Recommendations" }, { key: "curves", title: "Error curves" },
        { key: "governor", title: "Governor" }, { key: "filters", title: "Filters & vibration" }, { key: "tail", title: "Tail" },
        { key: "checks", title: "All checks" }, { key: "coverage", title: "Coverage" }
    ];

    var DISCLAIMER = "Advice only. Review before applying; nothing is sent to the flight controller.";
    var LOW_RATE = "Below 1 kHz rotor and tail harmonics alias, and the vibration, D-term and gain analyses are not reliable; " +
        "log at 1 kHz for tuning (D1).";
    var T_MAX_SE = 0.2; // largest random error of |T| and its phase that the response plots draw as measured

    // Plot colours: GraphConfig.PALETTE on the dark plot surface
    var C = {
        roll: "#fb8072", pitch: "#8dd3c7", yaw: "#ffffb3", blue: "#80b1d3", orange: "#fdb462", green: "#b3de69",
        purple: "#bc80bd", grey: "#d9d9d9", ref: "rgba(255,255,255,0.45)", limit: "#fb8072",
        unusable: "rgba(255,255,255,0.07)", stick: "rgba(128,177,211,0.14)", band: "rgba(253,180,98,0.12)", dyn: "rgba(188,128,189,0.16)"
    };
    var STATUS_COLOR = { error: "#ff5a4f", attention: "#c9483f", watch: "#d99a1f", good: "#3c9d40", info: "#3a7fc1", insufficient: "#b0b0b0" };
    var STATE_BAND = [ // by governor state; ACTIVE is not shaded
        "rgba(255,255,255,0.06)", "rgba(255,255,255,0.06)", "rgba(128,177,211,0.18)", "rgba(141,211,199,0.18)", null,
        "rgba(253,180,98,0.18)", "rgba(251,128,114,0.25)", "rgba(188,128,189,0.22)", "rgba(251,128,114,0.32)", "rgba(255,255,255,0.1)"
    ];

    var CACHE_MAX = 6, instances = 0;

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

    // Log profile numbers count from 1 as in the Configurator (CLI index + 1); 0 = arming profile unknown
    function profileLabel(p) {
        if (typeof p === "number") return p > 0 ? "P" + p : "P?";
        return p === null || p === undefined ? "" : String(p);
    }

    // Where a finding applies; D4 (health_setup) gives the CLI profile index, not the log profile
    function findingWhere(f, sep) {
        var p = f.id === "D4" && typeof f.profile === "number" ? "CLI profile " + f.profile : profileLabel(f.profile);
        return [p, f.axis].filter(Boolean).join(sep);
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

    // "1 error, 5 flags, 6 notes, 2 ok, 1 skipped"
    function severityCounts(findings) {
        var c = countBy(findings, "severity");
        c.explained = findings.filter(function (f) { return f.severity === "flag" && f.explained; }).length;
        if (c.flag) c.flag -= c.explained;
        return ["error", "flag", "explained", "note", "ok", "skipped"].filter(function (k) { return c[k]; }).map(function (k) {
            return k === "ok" || k === "skipped" ? c[k] + " " + k : k === "explained" ? plural(c[k], "explained flag") : plural(c[k], k);
        }).join(", ");
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

    function findingStatus(f) {
        switch (f.severity) {
            case "error": return "error";
            case "flag": return f.explained ? "info" : "attention"; // explained: the worker found every recommendation on it is information
            case "ok": return "good";
            case "note":
                if (/^no finding/i.test(String(f.text || ""))) return "insufficient";
                return REPORT_ONLY[f.id] ? "info" : "watch";
            default: return "insufficient";
        }
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

    function recsOf(result) {
        var adv = result.advice, recs = adv && Array.isArray(adv.recommendations) ? adv.recommendations.slice() : [];
        function rank(r) { return (REC_SEVERITY[r.severity] || REC_SEVERITY.info).rank; }
        return recs.sort(function (a, b) {
            return (isNum(a.order) ? a.order : 1e9) - (isNum(b.order) ? b.order : 1e9) || rank(a) - rank(b);
        });
    }

    // A guard of advice.cjs holds the item back until another fix is made: no CLI, and nothing to do now
    function isBlocked(rec) {
        return Array.isArray(rec.blockedBy) && rec.blockedBy.length > 0;
    }

    function hasCli(rec) {
        return Array.isArray(rec.cli) && rec.cli.length > 0 && !isBlocked(rec);
    }

    // The badge of a recommendation: "Action, blocked" is shown as waiting, not as something to act on
    function recBadge(rec) {
        var sev = REC_SEVERITY[rec.severity] || REC_SEVERITY.info;
        if (!isBlocked(rec)) return sev;
        return { label: sev.label + ", blocked", status: sev.status === "attention" ? "watch" : sev.status };
    }

    // "(PID profile 1, CLI profile 0): 60 → 72 (raise)"
    function paramText(rec) {
        var p = rec.cliProfile, where = "";
        if (rec.scope === "profile") where = isNum(p) ? "PID profile " + (p + 1) + ", CLI profile " + p : "PID profile unknown";
        else if (rec.scope === "rateprofile") where = isNum(p) ? "rate profile " + (p + 1) + ", CLI rateprofile " + p : "rate profile unknown";
        else if (rec.scope === "global") where = "global";
        var from = rec.from === null || rec.from === undefined ? "" : num(rec.from),
            to = rec.to === null || rec.to === undefined ? "" : num(rec.to),
            change = from && to ? from + " → " + to : from ? "now " + from : to ? "→ " + to : "",
            how = change ? change + (rec.direction ? " (" + rec.direction + ")" : "") : rec.direction || "";
        return (where ? "(" + where + ")" : "") + (how ? ": " + how : "");
    }

    // A report.cjs decision in one line, with the predicted improvement in standard errors
    function decisionOutcome(d) {
        if (!d.change) return "no change: " + oneLine(d.reason);
        var steps = (d.changes || []).map(function (s) {
            return s.gain + " ×" + num(s.multiplier) + " (" + num(isNum(s.from) ? +s.from.toFixed(1) : s.from) + " → " +
                num(isNum(s.to) ? +s.to.toFixed(1) : s.to) + ")";
        }).join(", ");
        var tracking = Array.isArray(d.tracking) ? ", tracking error " + num(d.tracking[0]) + " → " + num(d.tracking[1]) + " deg/s" : "";
        var sigma = isNum(d.dTrack) && isNum(d.seTrack) && d.seTrack > 0 ?
            " (improves " + valueSe(d.dTrack, d.seTrack) + ", " + (d.dTrack / d.seTrack).toFixed(1) + " SE)" : "";
        return steps + tracking + sigma;
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
            if (isNum(r.normalS)) out.normalS = (out.normalS || 0) + r.normalS; // s of normal flight left by excludeAbnormal; null without it
            ["profileSeconds", "excluded", "targetOf"].forEach(function (k) {
                var src = r[k] || {};
                Object.keys(src).forEach(function (p) {
                    if (isNum(src[p])) out[k][p] = k === "targetOf" ? src[p] : (out[k][p] || 0) + src[p];
                });
            });
        });
        return out;
    }

    function profilesText(rec) {
        return Object.keys(rec.profileSeconds).filter(function (p) { return rec.profileSeconds[p] >= 0.05; }).map(function (p) {
            var t = rec.targetOf[p];
            return profileLabel(+p) + (isNum(t) ? " " + Math.round(t) + " rpm" : "") + " " + secs(rec.profileSeconds[p]);
        }).join(" · ");
    }

    function excludedText(ex) {
        var names = { rescueS: "rescue", levelModeS: "level mode", failsafeS: "failsafe", groundS: "ground", guardS: "guard" };
        return Object.keys(ex).filter(function (k) { return ex[k] >= 0.05; })
            .map(function (k) { return (names[k] || k) + " " + secs(ex[k]); }).join(", ");
    }

    function firmwareNote(fw) {
        var m = /rotorflight\D*(\d+)\.(\d+)/i.exec(String(fw || ""));
        if (!fw) return "";
        if (!m) return "This is not a Rotorflight log; the checks and CLI names assume Rotorflight 4.6.";
        if (+m[1] * 100 + +m[2] < 406) return "Rotorflight " + m[1] + "." + m[2] + " log: the checks and CLI names assume Rotorflight 4.6, and some parameters differ.";
        return "";
    }

    // The flight rpm and where it came from (js/tuning_worker.js autoRpm): "1900 (85 % of the lowest governor target, 2300
    // rpm on P1, 70.4 s in the air in logs 50, 51, 52)"; profile as the log has it (0 = the arming profile), logs from 0
    function rpmText(fr) {
        if (!fr) return "";
        var logs = Array.isArray(fr.logs) ? fr.logs.filter(isNum) : [];
        var basis = (isNum(fr.basis) ? ", " + Math.round(fr.basis) + " rpm" + (isNum(fr.profile) && fr.profile > 0 ? " on " + profileLabel(fr.profile) : "") : "") +
            (isNum(fr.seconds) ? ", " + secs(fr.seconds) + " in the air" : "") +
            (logs.length ? " in log" + (logs.length > 1 ? "s " : " ") + logLabel(logs.slice(0, 8)) + (logs.length > 8 ? " and " + (logs.length - 8) + " more" : "") : "");
        var why = { user: "set here", govTarget: "85 % of the lowest governor target" + basis, headspeed: "85 % of the lowest per-profile median airborne headspeed" + basis,
            "default": "toolkit default" }[fr.source] || oneLine(fr.source);
        return num(fr.value) + " (" + why + ")";
    }

    function rateNote(rate) {
        return isNum(rate) && rate < 1000 ? "This log is recorded at " + Math.round(rate) + " Hz (Nyquist " + Math.round(rate / 2) + " Hz). " + LOW_RATE : "";
    }

    // ---------------------------------------------------------------------------------------------
    // HTML pieces

    function badge(text, status, title) {
        return '<span class="tuning-badge st-' + status + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + esc(text) + "</span>";
    }

    function notice(kind, html) {
        return '<div class="tuning-notice is-' + kind + '">' + html + "</div>";
    }

    function timeLinks(f) {
        var times = Array.isArray(f.times) ? f.times.filter(isNum) : [];
        var links = times.slice(0, 3).map(function (t) {
            var label = esc(num(+t.toFixed(1))) + " s";
            return typeof f.log === "number" ?
                '<a href="#" class="tuning-seek" data-log="' + esc(f.log) + '" data-t="' + esc(t) + '" title="Show in the viewer">' + label + "</a>" : label;
        });
        if (times.length > 3) links.push('<span class="tuning-muted">+' + (times.length - 3) + "</span>");
        return links.join(" ");
    }

    // F5: what the gyro filters pass of each line, measured by the worker (gyroRAW -> gyroADC)
    function passHtml(f) {
        if (!Array.isArray(f.filterPass) || !f.filterPass.length) return "";
        var pct = function (v) { return isNum(v) ? num(v * 100) + " %" : "n/a"; };
        return '<div class="tuning-muted">Measured filter pass (gyroRAW to gyroADC): ' + esc(f.filterPass.slice(0, 4).map(function (q) {
            return num(q.hz) + " Hz roll " + pct(q.roll) + ", pitch " + pct(q.pitch) + ", yaw " + pct(q.yaw);
        }).join("; ")) + (f.filterPass.length > 4 ? "; &hellip;" : "") + "</div>";
    }

    // Findings, or a recommendation's evidence (opts.evidence: no severity column, the text on a row of its own)
    function findingsTable(list, opts) {
        opts = opts || {};
        if (!list.length) return '<p class="tuning-muted">' + esc(opts.empty || "No findings.") + "</p>";
        var cols = [opts.evidence ? null : ["severity", "Severity"], ["id", opts.evidence ? "Evidence" : "Check"], opts.showLog ? ["log", "Log"] : null,
            [null, "Where"], ["value", "Value"], [null, "Threshold / source"], opts.evidence ? null : [null, "Finding"], [null, "Times"]].filter(Boolean);
        var head = cols.map(function (c) {
            if (!opts.sortable || !c[0]) return "<th>" + c[1] + "</th>";
            return '<th class="tuning-sortable' + (opts.sort === c[0] ? " is-sorted" + (opts.dir < 0 ? " is-desc" : "") : "") + '" data-sort="' + c[0] + '">' + c[1] + "</th>";
        }).join("");
        var rows = list.map(function (f) {
            var status = findingStatus(f), where = findingWhere(f, " · ");
            return (opts.evidence ? "<tr>" : '<tr class="row-' + status + '">') +
                (opts.evidence ? "" : "<td>" + badge(f.explained ? "flag, explained" : f.severity, status, f.explained ? "Explained: " + f.explained : STATUS_LABEL[status]) + "</td>") +
                '<td class="tuning-id">' + esc(f.id) + (f.module ? '<div class="tuning-muted">' + esc(f.module) + "</div>" : "") + "</td>" +
                (opts.showLog ? "<td>" + esc(logLabel(f.log)) + "</td>" : "") +
                "<td>" + esc(where) + "</td>" +
                '<td class="' + (typeof f.value === "string" ? "tuning-text-value" : "tuning-num") + '">' + esc(valueSe(f.value, f.se, f.unit)).replace(/ ± /g, "&nbsp;±&nbsp;") +
                    (isNum(f.n) ? '<div class="tuning-muted">n ' + esc(num(f.n)) + "</div>" : "") + "</td>" +
                '<td class="tuning-rule">' + esc(threshold(f.threshold)) + sourceHtml(f.source) + "</td>" +
                (opts.evidence ? "" : '<td class="tuning-text">' + esc(f.text) + passHtml(f) + (f.explained ? '<div class="tuning-muted">Explained: ' + esc(f.explained) + "</div>" : "") + "</td>") +
                '<td class="tuning-times">' + timeLinks(f) + "</td></tr>" +
                (opts.evidence && f.text ? '<tr class="tuning-evidence-text"><td colspan="' + cols.length + '">' + esc(f.text) + passHtml(f) + "</td></tr>" : "");
        }).join("");
        return '<div class="tuning-table-wrap"><table class="tuning-table' + (opts.evidence ? " tuning-evidence" : "") + '"><thead><tr>' + head +
            "</tr></thead><tbody>" + rows + "</tbody></table></div>";
    }

    // The source's first clause, the whole of it on hover
    function sourceHtml(source) {
        var text = oneLine(source), short = text.split(/;\s*/)[0];
        return '<div class="tuning-muted"' + (short !== text ? ' title="' + esc(text) + '"' : "") + ">" + esc(short) + (short !== text ? "&hellip;" : "") + "</div>";
    }

    function cliBlock(text, env) {
        return '<div class="tuning-cli"><button type="button" class="btn btn-default btn-xs tuning-copy" data-copy="' + env.copy(text) +
            '">Copy</button><pre>' + esc(text) + "</pre></div>";
    }

    function bulletList(items, label, cls) {
        if (!Array.isArray(items) || !items.length) return "";
        return '<div class="tuning-rec-list ' + cls + '"><span class="tuning-label">' + label + "</span><ul>" +
            items.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul></div>";
    }

    function recCard(rec, i, env) {
        var sev = recBadge(rec);
        return '<div class="tuning-rec st-' + sev.status + '" id="' + env.recId(i) + '">' +
            '<div class="tuning-rec-head">' + badge(sev.label, sev.status) + '<span class="tuning-rec-title">' + esc(rec.title) + "</span>" +
                '<span class="tuning-muted">' + esc([cap(rec.area), rec.confidence].filter(Boolean).join(" · ")) + "</span></div>" +
            (rec.text ? '<div class="tuning-rec-text">' + esc(rec.text) + "</div>" : "") +
            (rec.parameter ? '<div class="tuning-rec-param"><code>' + esc(rec.parameter) + "</code> " + esc(paramText(rec)) + "</div>" : "") +
            (rec.rule ? '<div class="tuning-rec-rule"><span class="tuning-label">Rule</span>' + esc(rec.rule) + "</div>" : "") +
            bulletList(rec.blockedBy, "Blocked by", "is-blocked") +
            bulletList(rec.caveats, "Caveats", "is-caveat") +
            findingsTable(Array.isArray(rec.evidence) ? rec.evidence : [], { evidence: true, showLog: true, empty: "No evidence listed." }) +
            (hasCli(rec) ? cliBlock(rec.cli.join("\n"), env) : '<div class="tuning-muted tuning-cli-none">No CLI text for this item.</div>') +
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
        return notesOf(result).filter(function (n) { return /advice/i.test(n); })[0] || "the advice module returned nothing";
    }

    function options(list, value) {
        return list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === value ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("");
    }

    // ---------------------------------------------------------------------------------------------
    // Tabs: each returns { html, plots: [{ id, spec }] }

    function renderOverview(entry) {
        var r = entry.result, fs = r.findings || [], recs = recsOf(r), counts = severityCounts(fs);
        // a blocked action waits for another fix first (advice.cjs guards): not one to act on now
        var act = recs.filter(function (x) { return x.severity === "action" && !isBlocked(x); }).length,
            held = recs.filter(function (x) { return x.severity === "action" && isBlocked(x); }).length,
            todo = [act ? act + " to act on" : "", held ? held + " blocked" : ""].filter(Boolean).join(", ");
        var html = '<p class="tuning-summary">' + esc(entry.label + ": " + plural(fs.length, "finding") + (counts ? " (" + counts + ")" : "") +
            ", " + plural(recs.length, "recommendation") + (todo ? " (" + todo + ")" : "") + ".") + '<span class="tuning-muted">' +
            esc([r.flightRpm ? "Flight rpm " + rpmText(r.flightRpm) : "",
                entry.cliName ? "CLI dump " + entry.cliName : "no CLI dump", r.timing && isNum(r.timing.totalS) ? "analysed in " + secs(r.timing.totalS) : ""]
                .filter(Boolean).join(" · ")) + "</span></p>";

        var errors = fs.filter(function (f) { return f.severity === "error"; });
        if (errors.length) {
            html += notice("error", "<strong>" + esc(plural(errors.length, "check") + " could not run.") + "</strong> " +
                errors.slice(0, 4).map(function (f) { return esc(f.id + ": " + oneLine(f.text)); }).join("; ") + (errors.length > 4 ? "; &hellip;" : ""));
        }

        html += '<div class="tuning-cards">' + AREAS.map(function (a) {
            var mine = fs.filter(function (f) { return areaOf(f) === a.key; }), status = worstStatus(mine);
            var flagged = {}, ids = [];
            mine.forEach(function (f) {
                if ((f.severity !== "flag" || f.explained) && f.severity !== "error") return;
                if (!flagged[f.id]) ids.push(f.id);
                flagged[f.id] = (flagged[f.id] || 0) + 1;
            });
            var open = recs.filter(function (x) { return REC_AREA[x.area] === a.key && (x.severity === "action" || x.severity === "check"); }).length;
            return '<div class="tuning-card st-' + status + '" data-area="' + a.key + '" title="Show these checks">' +
                '<div class="tuning-card-top"><span class="tuning-card-title">' + esc(a.title) + '</span><span class="tuning-card-status">' +
                    (mine.length ? STATUS_LABEL[status] : "Not checked") + "</span></div>" +
                '<div class="tuning-card-counts">' + esc(severityCounts(mine) || "no findings") + "</div>" +
                (ids.length ? '<div class="tuning-card-ids">' + esc(ids.slice(0, 6).map(function (id) { return flagged[id] > 1 ? id + " ×" + flagged[id] : id; }).join(", ") +
                    (ids.length > 6 ? ", …" : "")) + "</div>" : "") +
                (open ? '<div class="tuning-card-recs">' + plural(open, "recommendation") + "</div>" : "") +
            "</div>";
        }).join("") + "</div>";

        var top = recs.map(function (x, i) { return { rec: x, i: i }; })
            .filter(function (x) { return x.rec.severity === "action" || x.rec.severity === "check"; }).slice(0, 5);
        html += '<h5 class="tuning-h">Top recommendations</h5>' + (top.length ? '<ol class="tuning-top-recs">' + top.map(function (x) {
            var sev = recBadge(x.rec);
            return "<li>" + badge(sev.label, sev.status) + ' <a href="#" class="tuning-goto-rec" data-rec="' + x.i + '">' + esc(x.rec.title) + "</a>" +
                (x.rec.parameter ? ' <span class="tuning-muted"><code>' + esc(x.rec.parameter) + "</code> " + esc(paramText(x.rec)) + "</span>" : "") +
                (isBlocked(x.rec) ? ' <span class="tuning-top-blocked">Blocked by ' + esc(x.rec.blockedBy.map(oneLine).join("; ")) + "</span>" : "") + "</li>";
        }).join("") + "</ol>" : '<p class="tuning-muted">' + esc(adviceRan(r) ? "Nothing to change or check" + (recs.length ? " (" + plural(recs.length, "item") + " to watch)" : "") + "." :
            "Recommendations not available: " + whyNoAdvice(r) + ".") + "</p>");

        var notes = notesOf(r);
        if (notes.length) html += '<h5 class="tuning-h">Notes</h5><ul class="tuning-notes">' + notes.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") + "</ul>";
        return { html: html, plots: [] };
    }

    function renderRecs(entry, view, env) {
        var r = entry.result;
        if (!adviceRan(r)) return { html: '<p class="tuning-na-text">Recommendations not available: ' + esc(whyNoAdvice(r)) + ".</p>", plots: [] };
        var recs = recsOf(r), c = countBy(recs, "severity"), script = (r.advice && r.advice.script) || ""; // advice.script(recommendations)
        var html = '<p class="tuning-disclaimer">' + DISCLAIMER + "</p>" +
            '<p class="tuning-muted">' + esc(recs.length ? plural(recs.length, "item") + " in tuning order (" + ["action", "check", "watch", "info"]
                .filter(function (k) { return c[k]; }).map(function (k) { return c[k] + " " + k; }).join(", ") + "). " + (recs.some(hasCli) ?
                "Each CLI block selects its profile and sets the value; type save afterwards, or use the combined script at the end, which ends with save." :
                "None of them carries CLI text.") : "No recommendations.") + "</p>" +
            recs.map(function (rec, i) { return recCard(rec, i, env); }).join("");
        if (script) html += '<h5 class="tuning-h">Combined CLI for the action items</h5>' + cliBlock(script, env);
        if (Array.isArray(r.decisions) && r.decisions.length) {
            html += '<h5 class="tuning-h">Gain analysis (report.cjs)</h5><div class="tuning-table-wrap"><table class="tuning-table"><thead><tr>' +
                "<th>Axis</th><th>Headspeed</th><th>Flights</th><th>Windows</th><th>Outcome</th></tr></thead><tbody>" +
                r.decisions.map(function (d) {
                    return "<tr><td>" + esc(d.axis) + '</td><td class="tuning-num">' + esc(num(d.bin)) + ' rpm</td><td class="tuning-num">' + esc(num(d.flights)) +
                        '</td><td class="tuning-num">' + esc(num(d.windows)) + '</td><td class="tuning-text">' + esc(decisionOutcome(d)) + "</td></tr>";
                }).join("") + "</tbody></table></div>";
        }
        return { html: html, plots: [] };
    }

    function checksTable(entry, view) {
        var r = entry.result, q = String(view.query || "").trim().toLowerCase(), all = r.findings || [];
        var sev = { issues: ["error", "flag", "note"], problems: ["error", "flag"], all: null }[view.sev], sort = SORTS[view.sort] || SORTS.severity;
        var list = all.filter(function (f) {
            if (sev ? sev.indexOf(f.severity) < 0 : view.sev !== "all" && f.severity !== view.sev) return false;
            if (view.area !== "all" && areaOf(f) !== view.area) return false;
            return !q || [f.id, f.module, f.text, f.source, f.axis, f.profile].join(" ").toLowerCase().indexOf(q) >= 0;
        }).sort(function (a, b) { return (view.dir < 0 ? -1 : 1) * sort(a, b); });
        return '<p class="tuning-muted tuning-count">Showing ' + list.length + " of " + plural(all.length, "finding") +
            ". Log numbers count from 1 as in the log picker, in the finding texts too.</p>" +
            findingsTable(list, { showLog: r.scope === "file", sortable: true, sort: view.sort, dir: view.dir, empty: "No finding matches the filter." });
    }

    function renderChecks(entry, view) {
        var html = '<div class="tuning-filters">' +
            '<select class="form-control input-sm tuning-f-sev">' + options([["issues", "Errors, flags and notes"], ["problems", "Errors and flags"],
                ["all", "All severities"], ["flag", "Flags"], ["note", "Notes"], ["ok", "OK"], ["skipped", "Skipped"], ["error", "Errors"]], view.sev) + "</select>" +
            '<select class="form-control input-sm tuning-f-area">' + options([["all", "All areas"]].concat(AREAS.map(function (a) { return [a.key, a.title]; })), view.area) + "</select>" +
            '<input type="search" class="form-control input-sm tuning-f-query" placeholder="Filter by check, text or source" value="' + esc(view.query) + '">' +
            '</div><div class="tuning-checks-table">' + checksTable(entry, view) + "</div>";
        return { html: html, plots: [] };
    }

    function renderCoverage(entry) {
        var r = entry.result, rows = adviceRan(r) ? r.advice.coverage : null;
        if (!rows) return { html: '<p class="tuning-na-text">Coverage not available: ' + esc(whyNoAdvice(r)) + ".</p>", plots: [] };
        var c = countBy(rows, "status");
        function meta(status) { return COVERAGE[status] || [String(status), "insufficient"]; }
        var html = '<p class="tuning-coverage-summary">' + Object.keys(c).map(function (s) { return badge(c[s] + " " + meta(s)[0].toLowerCase(), meta(s)[1]); }).join(" ") + "</p>" +
            (c["needs-cli"] && !entry.cliName ? '<p class="tuning-muted">Load a CLI dump (diff all or dump) and analyse again to assess the groups marked "Needs CLI dump".</p>' : "") +
            (c["no-check"] ? '<p class="tuning-muted">No check of this app informs the groups marked "Not checked by the app" (none exists, or it does not run here): review those settings by hand.</p>' : "") +
            '<div class="tuning-table-wrap"><table class="tuning-table"><thead><tr><th>Group</th><th>Status</th><th>Checks</th><th>Parameters</th><th>Detail</th></tr></thead><tbody>' +
            rows.map(function (row) {
                return "<tr><td>" + esc(row.group || row.area) + (row.group ? '<div class="tuning-muted">' + esc(row.area) + "</div>" : "") + "</td><td>" + badge(meta(row.status)[0], meta(row.status)[1]) + '</td><td class="tuning-id">' + esc((row.checks || []).join(", ")) +
                    '</td><td class="tuning-params">' + esc((row.parameters || []).join(", ")).replace(/_/g, "_<wbr>") + '</td><td class="tuning-text">' + esc(row.detail) + "</td></tr>";
            }).join("") + "</tbody></table></div>";
        return { html: html, plots: [] };
    }

    // ---------------------------------------------------------------------------------------------
    // Plots: items are { spec } (TuningPlot) or { title, na: reason }

    // Why a curve is missing: a field the log lacks, a log that was not flown (the loop modules skip those), a field
    // logged as zero, a note of the worker, else the plain fact
    function whyMissing(result, curve, part, field) {
        var state = result.fields && field ? result.fields[field] : null, rec = curve && logRecord(result, curve.log);
        if (state === "absent") return field + " is not logged";
        if (rec && !rec.flown) return "log " + logLabel(curve.log) + " was not flown (airborne with the rotor above the flight rpm)";
        if (state === "zero") return field + " is logged as all zero";
        var re = part === "track" ? /health_track|track curves/ : /health_more|more curves/;
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
        return spec.series.length ? { spec: spec } : { title: spec.title, na: reason || "no data in the result" };
    }

    function timeItem(curve, env, spec, reason) {
        spec.x = { label: "time", unit: "s" };
        spec.onClick = function (x) { env.seek(curve.log, x); };
        return item(spec, reason);
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
                if (isNum(t) && out.length < 150) out.push({ x: t, color: STATUS_COLOR[findingStatus(f)], label: f.id + " " + f.severity, shape: "tri" });
            });
        });
        return out;
    }

    function firstPositive(f) {
        for (var i = 0; i < f.length; i++) if (f[i] > 0) return f[i];
        return 0.1;
    }

    function trackPlots(curve, axis, result, env) {
        var tr = curve.track && curve.track[axis], color = C[axis], out = [];
        if (!tr) return [{ title: "Tracking error, " + axis, na: curve.track ? "no " + axis + " curves in the result" : whyMissing(result, curve, "track", "setpoint[" + AXES.indexOf(axis) + "]") }];
        var tm = tr.time || {}, sp = tr.spectrum, ev = tr.errVsSp, tau = tr.tauMs;
        var none = tm.usable && Array.prototype.indexOf.call(tm.usable, 1) < 0 ? "no usable flight in this log: every sample is excluded (not flying, " +
            "governor not ACTIVE, rescue, level mode or failsafe, or within 1 s of a profile or governor change)" : "";
        var tauText = isNum(tau) ? " (τ = " + num(tau) + " ms)" : "", unusable = maskBands(tm.t, tm.usable, 0, C.unusable, "not usable");
        // the error as C12 and T11 have it: gyro and setpoint low-passed at lpHz, the vibration above it is the F checks'
        var lp = isNum(tr.lpHz) ? " below " + num(tr.lpHz) + " Hz" : "";
        out.push(timeItem(curve, env, {
            title: "Tracking error, " + axis + ": rms per 0.1 s", y: { label: "rms", unit: "deg/s", min: 0 }, bands: unusable,
            series: [line("setpoint", tm.t, tm.sp, C.grey, { width: 1 }), line("error" + lp, tm.t, tm.err, color),
                line("error at the best delay" + (lp ? "," + lp : "") + tauText, tm.t, tm.errComp, C.blue, { dash: [4, 3] })],
            markers: markers(result, curve, /^(C|T|R)\d+$/, axis)
        }));
        // C5 and T1 amplitudes: of the band-passed error, which passes oscGain of a sine in the band; the 10/20/40 lines are on that scale
        var ob = Array.isArray(tr.oscBand) ? tr.oscBand : sp && Array.isArray(sp.band) ? sp.band : null,
            bandText = ob ? " in " + num(ob[0]) + "-" + num(ob[1]) + " Hz" : "",
            gainText = Array.isArray(tr.oscGain) && isNum(tr.oscGain[0]) && isNum(tr.oscGain[1]) ? "; passes " + num(tr.oscGain[0]) + "-" + num(tr.oscGain[1]) + " of a sine in the band" : "";
        out.push(timeItem(curve, env, {
            title: "Band-passed error amplitude" + bandText + ", " + axis + " (shaded: stick-driven)", y: { label: "amplitude", unit: "deg/s", min: 0 },
            series: [line("√2 rms of the band-passed error over 0.5 s" + gainText, tm.t, tm.osc, color)],
            bands: maskBands(tm.t, tm.stickDriven, 1, C.stick, "stick-driven").concat(unusable),
            hlines: [10, 20, 40].map(function (y) { return { y: y, color: C.ref, label: y + " deg/s", dash: [4, 3] }; }),
            markers: markers(result, curve, /^(C5|T1)$/, axis)
        }));
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
            var faint = "rgba(128,177,211,0.35)", seText = " (SE < " + T_MAX_SE * 100 + " %)";
            out.push(item({
                title: "Error and response spectrum, " + axis + (isNum(sp.windows) ? " (" + plural(sp.windows, "window") + ")" : ""),
                x: x, y: { label: "ratio", log: true }, y2: { label: "coherence", min: 0, max: 1 }, bands: bands,
                series: [line("|error| / |setpoint|", sp.f, sp.ratio, color), line("|T| setpoint to gyro" + seText, sp.f, Tm, C.blue),
                    line("|T|, SE too large", sp.f, sp.Tmag, faint, { width: 1 }),
                    line("coherence", sp.f, sp.coh, C.grey, { axis: "y2", width: 1, dash: [2, 3] })],
                hlines: [{ y: 1, color: C.ref, dash: [4, 3] }]
            }));
            out.push(item({
                title: "Phase, setpoint to gyro" + tauText, x: x, bands: bands,
                y: lo <= hi ? { label: "phase", unit: "deg", min: Math.floor(Math.min(lo, -90) / 90) * 90, max: Math.ceil(Math.max(hi, 0) / 90) * 90 } : { label: "phase", unit: "deg" },
                series: [line("phase of T" + seText, sp.f, Td, color), line("phase, SE too large", sp.f, sp.Tdeg, faint, { width: 1 }),
                    line("delay −360 f τ", sp.f, delay, C.grey, { dash: [4, 3], width: 1 })]
            }));
        } else {
            out.push({ title: "Error spectrum, " + axis, na: none || "too little usable flight for a spectrum (runs of 2 s or more are needed)" });
        }
        if (ev && Array.isArray(ev.edges) && ev.edges.length > 2) {
            var mids = [], full = []; // bins up to the last with samples
            for (var k = 0; k + 1 < ev.edges.length; k++) {
                mids.push((ev.edges[k] + ev.edges[k + 1]) / 2);
                if (!ev.n || ev.n[k] > 0) full.push(k);
            }
            mids.length = full.length ? full[full.length - 1] + 1 : 0;
            var one = full.length === 1 && ev.meanAbsErr ? "only the " + ev.edges[full[0]] + "-" + ev.edges[full[0] + 1] + " deg/s bin has samples: mean |error| " +
                num(ev.meanAbsErr[full[0]]) + " deg/s (n " + num(ev.n[full[0]]) + ")" : "";
            out.push(item({
                title: "Mean |error| by |setpoint|, " + axis, x: { label: "|setpoint|", unit: "deg/s", min: 0 }, y: { label: "mean |error|", unit: "deg/s", min: 0 },
                series: [line("mean |error|" + lp, mids, ev.meanAbsErr && ev.meanAbsErr.slice(0, mids.length), color, { points: true }),
                    line("at the best delay" + (lp ? "," + lp : ""), mids, ev.meanAbsErrComp && ev.meanAbsErrComp.slice(0, mids.length), C.blue, { points: true, dash: [4, 3] })]
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
        var profiles = runsOf(g.t, g.profile).slice(1, 60).map(function (r) { return { x: r.x0, color: C.purple, label: profileLabel(r.value), dash: [3, 3] }; });
        var range = errRange(g);
        return [
            timeItem(curve, env, { title: "Headspeed and governor target (shaded: governor state)", y: { label: "headspeed", unit: "rpm" },
                series: [line("headspeed", g.t, g.hs, C.orange), line("governor target", g.t, g.target, C.blue, { dash: [4, 3] })],
                bands: states, vlines: profiles, markers: markers(result, curve, /^G\d+$/) }),
            timeItem(curve, env, { title: "Headspeed error from the reference" + (g.reference ? " (" + oneLine(g.reference) + ")" : ""), vlines: profiles,
                y: { label: "error", unit: "%", min: -range, max: range },
                series: [line("(headspeed − reference) / reference", g.t, g.errPct, C.orange)],
                hlines: [-2, -1, 1, 2].map(function (y) { return { y: y, color: C.ref, label: (y > 0 ? "+" : "") + y + " %", dash: Math.abs(y) === 1 ? [2, 3] : [5, 3] }; }) }),
            timeItem(curve, env, { title: "Throttle and collective", y: { label: "throttle", unit: "%", min: 0 }, y2: { label: "collective", unit: "‰" }, vlines: profiles,
                series: [line("throttle (motor[0])", g.t, g.throttle, C.green), line("collective", g.t, g.coll, C.grey, { axis: "y2", width: 1 })] },
                whyMissing(result, curve, "throttle", "motor[0]"))
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
        return keys.length ? { hz: rotorHz[keys[0]], profile: keys.length > 1 ? +keys[0] : null } : null;
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
        return '<select class="form-control input-sm tuning-vib-profile" title="Spectra of one PID profile (its own headspeed), or of all pooled">' +
            options([["all", "All profiles, weighted by time in each"]].concat(ch.keys.map(function (k) {
                var q = by[k];
                return [k, profileLabel(+k) + (isNum(q.rotorHz) ? ", " + Math.round(q.rotorHz * 60) + " rpm" : "") + ", " + plural(q.windows, "window") +
                    (isNum(q.share) ? " (" + Math.round(q.share * 100) + " %)" : "") + (k === ch.longest ? ", flown longest" : "")];
            })), ch.p) + "</select>";
    }

    function vibPlots(curve, axis, result, env, view) {
        var m = curve.more || {}, v = m.vib, k = AXES.indexOf(axis), out = [], fx = { label: "frequency", unit: "Hz", min: 0 };
        var ch = vibChoice(curve, result, view), one = ch.one, src = one || v, a = src && src[axis];
        var raw = "gyroRAW[" + k + "]", noFlight = "no flying window long enough for a spectrum";
        var where = one ? ", " + profileLabel(+ch.p) + " (" + plural(one.windows, "window") + ")" : ch.p === "all" ? ", all profiles weighted by time in each" : "";
        if (a && has(a, "f") && v.windows !== 0) {
            var notches = (src.notches && src.notches[axis] || []).filter(function (n) { return isNum(n.hz); }).slice(0, 30).map(function (n) {
                return { x: n.hz, color: C.orange, dash: [4, 2], label: oneLine(n.label || "notch") + (isNum(n.q) ? " Q" + num(n.q) : "") };
            });
            var lpf = (v.lpf || []).filter(function (l) { return isNum(l.hz) && l.hz > 0; }).map(function (l) {
                return { x: l.hz, color: C.green, dash: [6, 3], label: oneLine(l.name) + " " + num(l.hz) + " Hz" };
            });
            var dn = v.dynNotch || {}, dyn = dn.enabled !== false && dn.count > 0 && isNum(dn.min) && isNum(dn.max) ?
                [{ x0: dn.min, x1: dn.max, color: C.dyn, label: "dynamic notch range" }] : [];
            var rotor = one ? (isNum(one.rotorHz) && one.rotorHz > 0 ? { hz: one.rotorHz, profile: null } : null) : mainRotor(v.rotorHz, logRecord(result, curve.log)),
                fmax = a.f[a.f.length - 1], marks = [];
            for (var n = 1; rotor && n <= 8 && n * rotor.hz <= fmax; n++) marks.push({ x: n * rotor.hz, color: C.ref, dash: [2, 3], label: n + "×" });
            marks = notches.concat(lpf, marks); // the filter lines take the label rows first; the title gives the rotor frequency
            var both = !v.filtOnly && a.raw, of = rotor ? "; rotor harmonics" + (rotor.profile !== null ? " of " + profileLabel(rotor.profile) : "") + " at " + num(rotor.hz) + " Hz" : "";
            out.push(item({ title: (both ? "Gyro spectrum, raw and filtered, " : "Gyro spectrum, filtered only (gyroRAW not logged), ") + axis + where + of,
                x: fx, y: { label: "amplitude", unit: "deg/s", log: true }, vlines: marks, bands: dyn,
                series: [line("gyroRAW, before the filters", a.f, both ? a.raw : null, C.grey, { width: 1 }), line("gyroADC, filtered", a.f, a.filt, C[axis])] }));
            out.push(item({ title: "Filter transmission |filtered| / |raw|, " + axis + where, x: fx, y: { label: "gain", min: 0, max: 1.5 }, vlines: marks,
                series: [line("transmission", a.f, a.pass, C[axis])], hlines: [{ y: 1, color: C.ref, dash: [4, 3] }] }, whyMissing(result, curve, "transmission", raw)));
        } else {
            out.push({ title: "Gyro spectrum, " + axis, na: v && v.windows === 0 ? noFlight : whyMissing(result, curve, "vibration", raw) });
        }
        // D-term and control spectra are of all profiles' usable flight; with a profile choice, say so
        var d = m.dterm && m.dterm[axis], u = m.control && m.control[axis], at30 = [{ x: 30, color: C.ref, label: "30 Hz", dash: [4, 3] }], all = ch.p !== null ? ", all profiles" : "";
        out.push(item({ title: "D-term spectrum (axisD), " + axis + all + (d && isNum(d.share30) ? ": " + Math.round(d.share30 * 100) + " % of the power above 30 Hz" : ""),
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
        return [
            timeItem(curve, env, { title: "Tail command against its limits" + (limits.length ? "" : " (no limits detected)"), y: { label: "mixer[2]", unit: "‰" },
                series: [line("mixer[2]: mean, and min to max per 0.1 s", tl.t, mid, C.yaw, { lo: u.min, hi: u.max, fill: true, width: 1 })],
                hlines: limits, markers: markers(result, curve, /^T\d+$/) }),
            timeItem(curve, env, { title: "Yaw error, rms per 0.1 s", y: { label: "rms", unit: "deg/s", min: 0 }, series: [line("setpoint − gyro", tl.t, tl.err, C.yaw)] })
        ];
    }

    var PLOT_TABS = {
        curves: { build: trackPlots, axes: true, part: "track", checks: /^(C5|C12|C13|T1|T11|T12|T14|R1)$/ },
        governor: { build: govPlots, axes: false, part: "governor", checks: /^(G\d+|D5)$/ },
        filters: { build: vibPlots, axes: true, part: "vibration", checks: /^F\d+$/, toolbar: vibToolbar },
        tail: { build: tailPlots, axes: false, part: "tail", checks: /^T\d+$/ }
    };

    // The curve entry on display: the chosen segment, else the longest
    function curveOf(result, view) {
        var list = Array.isArray(result.curves) ? result.curves : [];
        if (list[view.segment]) return list[view.segment];
        return list.reduce(function (a, b) { return a && (a.seconds || 0) >= (b.seconds || 0) ? a : b; }, null);
    }

    function renderPlotTab(key, entry, view, env) {
        var tab = PLOT_TABS[key], r = entry.result, curve = curveOf(r, view), list = Array.isArray(r.curves) ? r.curves : [];
        var html = '<div class="tuning-plot-toolbar">';
        if (tab.axes) {
            html += '<div class="btn-group btn-group-xs">' + AXES.map(function (a) {
                return '<button type="button" class="btn btn-default tuning-axis' + (a === view.axis ? " active" : "") + '" data-axis="' + a + '">' +
                    '<span class="tuning-dot" style="background:' + C[a] + '"></span>' + cap(a) + "</button>";
            }).join("") + "</div>";
        }
        if (list.length > 1) {
            html += '<select class="form-control input-sm tuning-segment">' + options(list.map(function (c, i) {
                return [String(i), "Log " + logLabel(c.log) + ", from " + secs(c.fromS) + " for " + secs(c.seconds)];
            }), String(list.indexOf(curve))) + "</select>";
        }
        if (tab.toolbar && curve) html += tab.toolbar(curve, r, view);
        html += '<span class="tuning-muted">' + (curve ? "Log " + esc(logLabel(curve.log)) + ". Click a time plot to show that moment in the viewer." : "") + "</span></div>";

        var items = curve ? tab.build(curve, view.axis, r, env, view) : [{ title: TABS.filter(function (t) { return t.key === key; })[0].title, na: whyMissing(r, null, tab.part) }];
        html += '<div class="tuning-plots">' + items.map(function (it) {
            if (it.na) return '<div class="tuning-plot is-na"><div class="tuning-plot-title">' + esc(it.title) + '</div><div class="tuning-na">not available: ' + esc(it.na) + "</div></div>";
            it.id = env.plotId();
            return '<div class="tuning-plot"><canvas id="' + it.id + '" class="tuning-plot-canvas"></canvas></div>';
        }).join("") + "</div>";

        var li = curve ? curve.log : r.logIndex;
        var mine = (r.findings || []).filter(function (f) {
            var fa = findingAxis(f);
            return tab.checks.test(String(f.id)) && (!isNum(li) || onLog(f, li)) && (!tab.axes || !fa || fa === view.axis);
        }).sort(SORTS.severity);
        html += '<h5 class="tuning-h">Checks' + (tab.axes ? " for " + view.axis : "") + (isNum(li) ? " in log " + esc(logLabel(li)) : "") + "</h5>" +
            findingsTable(mine, { empty: "No findings from these checks for this log." });
        return { html: html, plots: items.filter(function (it) { return it.spec; }).map(function (it) { return { id: it.id, spec: it.spec }; }) };
    }

    function renderTab(key, entry, view, env) {
        if (PLOT_TABS[key]) return renderPlotTab(key, entry, view, env);
        return ({ overview: renderOverview, recs: renderRecs, checks: renderChecks, coverage: renderCoverage })[key](entry, view, env);
    }

    // ---------------------------------------------------------------------------------------------
    // "Save report": findings, recommendations and the toolkit's own report as Markdown

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
        function value(f) { return valueSe(f.value, f.se, f.unit) + (isNum(f.n) ? " (n " + num(f.n) + ")" : ""); }

        out.push("# Tuning report");
        table(["Item", "Value"], [
            ["File", r.fileName], ["Analysed", entry.label], ["Craft", h["Craft name"]], ["Firmware", h["Firmware revision"]],
            ["Flight rpm", rpmText(r.flightRpm)],
            ["CLI dump", entry.cliName ? entry.cliName + (r.cli ? " (" + [r.cli.kind, r.cli.version].filter(Boolean).join(" ") + ")" : "") : "none"],
            ["Date", new Date(entry.finishedAt).toISOString()], ["Run time", r.timing ? secs(r.timing.totalS) : ""]
        ]);
        out.push("> " + DISCLAIMER, "", "Log numbers count from 1 as in the viewer's log picker, in the finding texts too; only the toolkit report at the end counts from 0.", "", "## Recommendations", "");
        if (!recs.length) out.push(adviceRan(r) ? "No recommendations." : "Recommendations not available: " + whyNoAdvice(r) + ".", "");
        recs.forEach(function (rec, i) {
            out.push("### " + (i + 1) + ". " + oneLine(rec.title) + " (" + rec.severity + (isBlocked(rec) ? ", blocked" : "") + ")", "");
            if (rec.text) out.push(oneLine(rec.text), "");
            if (rec.parameter) out.push("- Parameter: `" + oneLine(rec.parameter) + "` " + paramText(rec));
            out.push("- Area: " + oneLine(rec.area) + "; confidence: " + oneLine(rec.confidence));
            if (rec.rule) out.push("- Rule: " + oneLine(rec.rule));
            (rec.blockedBy || []).forEach(function (b) { out.push("- Blocked by: " + oneLine(b)); });
            (rec.caveats || []).forEach(function (c) { out.push("- Caveat: " + oneLine(c)); });
            table(["Evidence", "Log", "Where", "Value", "Threshold", "Source", "Text"], (rec.evidence || []).map(function (e) {
                return [e.id, logLabel(e.log), where(e), value(e), threshold(e.threshold), e.source, e.text];
            }));
            if (hasCli(rec)) out.push("```", rec.cli.join("\n"), "```", "");
        });
        var script = (r.advice && r.advice.script) || "";
        if (script) out.push("## Combined CLI for the action items", "", "```", script, "```", "");
        if (Array.isArray(r.decisions) && r.decisions.length) {
            out.push("## Gain analysis (report.cjs)");
            table(["Axis", "Headspeed", "Flights", "Windows", "Outcome"], r.decisions.map(function (d) {
                return [d.axis, num(d.bin) + " rpm", num(d.flights), num(d.windows), decisionOutcome(d)];
            }));
        }
        out.push("## Findings: errors, flags and notes");
        table(["Severity", "Check", "Log", "Where", "Value", "Threshold", "Source", "Text"], (r.findings || []).filter(function (f) {
            return rankOf(f) <= SEVERITY_RANK.note;
        }).sort(SORTS.severity).map(function (f) {
            return [f.severity, f.id, logLabel(f.log), where(f), value(f), threshold(f.threshold), f.source, f.text];
        }));
        if (adviceRan(r)) {
            out.push("## Coverage");
            table(["Group", "Area", "Status", "Checks", "Parameters", "Detail"], r.advice.coverage.map(function (c) {
                return [c.group || c.area, c.area, c.status, (c.checks || []).join(", "), (c.parameters || []).join(", "), c.detail];
            }));
        }
        var notes = notesOf(r);
        if (notes.length) out.push("## Notes", "", notes.map(function (n) { return "- " + oneLine(n); }).join("\n"), "");
        out.push("---", "", "## Toolkit report (health_report.cjs)", "", r.reportMarkdown || "(none)", "");
        return out.join("\n");
    }

    // ---------------------------------------------------------------------------------------------
    // The dialog

    var SKELETON =
        '<div class="tuning-context"></div>' +
        '<div class="tuning-controls">' +
            '<label class="tuning-field">Scope <select class="form-control input-sm tuning-scope">' +
                '<option value="log">This log</option><option value="file">All flights in file</option></select></label>' +
            '<label class="tuning-field" title="Headspeed from which the helicopter counts as flying. Empty (auto): 85 % of the lowest per-profile governor target in the air ' +
                '(else of the lowest per-profile median headspeed there), over every log of the file for All flights and over this log for This log; ' +
                'in a log without AIRBORNE_STATE events the governor ACTIVE counts as in the air.">' +
                'Flight rpm <input type="number" class="form-control input-sm tuning-rpm" min="300" max="50000" step="100" placeholder="auto"></label>' +
            '<span class="tuning-field"><button type="button" class="btn btn-default btn-sm tuning-cli-load" title="A Rotorflight CLI diff all or dump of this helicopter, kept in memory only">' +
                'Load CLI dump&hellip;</button><span class="tuning-cli-name tuning-muted"></span>' +
                '<input type="file" class="tuning-cli-input tuning-hide" accept=".txt,.cli,.diff,.dump,text/plain"></span>' +
            '<span class="tuning-actions">' +
                '<button type="button" class="btn btn-primary btn-sm tuning-analyse">Analyse</button>' +
                '<button type="button" class="btn btn-default btn-sm tuning-cancel">Cancel</button></span>' +
        "</div>" +
        '<div class="tuning-progress"><div class="tuning-progress-track"><div class="tuning-progress-bar"></div></div><div class="tuning-progress-text"></div>' +
            '<button type="button" class="btn btn-default btn-xs tuning-save" title="Findings, recommendations, CLI and the toolkit report as Markdown">Save report&hellip;</button></div>' +
        '<div class="tuning-notices"></div>' +
        '<div class="tuning-tabs tuning-hide">' + TABS.map(function (t) {
            return '<a href="#" class="tuning-tab" data-tab="' + t.key + '">' + esc(t.title) + '<span class="tuning-tab-count"></span></a>';
        }).join("") + "</div>" +
        '<div class="tuning-panes tuning-hide">' + TABS.map(function (t) { return '<div class="tuning-pane" data-pane="' + t.key + '"></div>'; }).join("") + "</div>" +
        '<div class="tuning-empty"></div>';

    function TuningDialog(dialog, hooks) {
        hooks = hooks || {};

        var body = dialog.find("#tuningBody"),
            uid = "tuning" + (++instances),
            cachedLog = null,           // the FlightLog given to show(), only for a host without hooks.getFlightLog
            files = new WeakMap(),      // whole-file bytes -> { name, key, offsets }
            cache = [],                 // finished runs, newest last
            job = null, jobSeq = 0, ticker = null,
            shown = null,               // the cache entry on display
            failure = null,             // { key, message, stack }
            cancelled = null,           // { key, ms }
            cli = null,                 // { name, text, hash }
            view = { tab: "overview", axis: "roll", segment: null, vibProfile: null, scope: "log", sev: "issues", area: "all", query: "", sort: "severity", dir: 1 },
            rendered = {}, handles = {}, pending = {}, visible = false, plotSeq = 0, copyTexts = [], queryTimer = null;

        body.html(SKELETON);

        function part(name) { return body.find(".tuning-" + name); }
        function pane(key) { return body.find('.tuning-pane[data-pane="' + key + '"]'); }

        // The viewer's FlightLog now, never one kept from show(): a file dropped on the window replaces it while this
        // modal is open, and a kept one would give the old file's log count and times
        function viewerLog() {
            return (hooks.getFlightLog ? hooks.getFlightLog() : cachedLog) || null;
        }

        var context = part("context"), scopeSelect = part("scope"), rpmInput = part("rpm"), cliName = part("cli-name"),
            analyseButton = part("analyse"), cancelButton = part("cancel"), saveButton = part("save"), progress = part("progress"),
            progressBar = part("progress-bar"), progressText = part("progress-text"), notices = part("notices"), empty = part("empty");

        var env = {
            seek: function (li, t) { seekTo(li, t); },
            copy: function (text) { copyTexts.push(String(text)); return copyTexts.length - 1; },
            plotId: function () { return uid + "-plot-" + (++plotSeq); },
            recId: function (i) { return uid + "-rec-" + i; }
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

        // null = auto, false = not a valid entry
        function readRpm() {
            var text = String(rpmInput.val() || "").trim(), v = Number(text);
            if (!text) return null;
            return isFinite(v) && v >= 300 && v <= 50000 ? Math.round(v) : false;
        }

        // A file-scope result takes its header, fields, curves and the header values of its recommendations from the log
        // selected when it ran (the findings are the file's), so the log is in its key too
        function keyFor(info, scope, li, rpm) {
            return [info.key, scope, li, rpm === null ? "auto" : rpm, cli ? cli.hash : "no-cli"].join("|");
        }

        function currentKey() {
            var info = fileInfo(), rpm = readRpm();
            return info && rpm !== false ? keyFor(info, view.scope, currentLog(), rpm) : null;
        }

        function cached(key) {
            return cache.filter(function (e) { return e.key === key; })[0] || null;
        }

        // --- the worker

        function endJob() {
            if (job) job.worker.terminate();
            job = null;
            clearInterval(ticker);
        }

        function start() {
            var info = fileInfo(), rpm = readRpm();
            failure = cancelled = null;
            if (!info) return renderChrome();
            if (rpm === false) {
                failure = { message: "Flight rpm must be a number from 300 to 50000, or empty for auto." };
                return renderChrome();
            }
            endJob();
            var li = currentLog(), scope = view.scope, count = viewerLog().getLogCount(), msg, worker; // fileInfo() needs a FlightLog
            try {
                if (scope === "log") {
                    if (!info.offsets) {
                        var index = new FlightLogIndex(info.bytes);
                        info.offsets = [];
                        for (var i = 0; i <= index.getLogCount(); i++) info.offsets.push(index.getLogBeginOffset(i));
                    }
                    if (li + 1 >= info.offsets.length) throw new Error("log " + (li + 1) + " is not in the file index");
                    msg = { cmd: "analyseLog", bytes: info.bytes.slice(info.offsets[li], info.offsets[li + 1]).buffer, logIndex: li, logCount: count,
                        options: { flightRpm: rpm, cliText: cli ? cli.text : null, cliName: cli ? cli.name : null, excludeAbnormal: true, curves: true } };
                } else {
                    msg = { cmd: "analyseFile", bytes: info.bytes.slice().buffer, selectedLog: li,
                        options: { flightRpm: rpm, cliText: cli ? cli.text : null, cliName: cli ? cli.name : null, excludeAbnormal: true, gains: true } };
                }
                msg.id = ++jobSeq;
                msg.fileName = info.name;
                worker = new Worker("js/tuning_worker.js");
            } catch (e) {
                failure = { message: "The analysis could not start: " + (e && e.message || e) };
                return renderChrome();
            }
            var mine = job = { id: msg.id, key: keyFor(info, scope, li, rpm), fileKey: info.key, scope: scope, logIndex: li, logCount: count,
                rpm: rpm, cliName: cli ? cli.name : null, worker: worker, started: Date.now(), last: null };
            worker.onmessage = function (e) { onMessage(mine, e.data); };
            worker.onerror = function (e) {
                if (e && e.preventDefault) e.preventDefault();
                fail(mine, { message: "The analysis worker stopped: " + (e && e.message || "script error") });
            };
            ticker = setInterval(renderProgress, 500);
            try {
                worker.postMessage(msg, [msg.bytes]);
            } catch (e) {
                return fail(mine, { message: "The log could not be passed to the worker: " + (e && e.message || e) });
            }
            renderChrome();
        }

        function fail(j, err) {
            if (j !== job) return;
            endJob();
            failure = { key: j.key, message: oneLine(err.message || "unknown error"), stack: err.stack ? String(err.stack) : "" };
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
                endJob();
                var entry = { key: j.key, fileKey: j.fileKey, scope: j.scope, logIndex: j.logIndex, logCount: j.logCount, rpm: j.rpm, cliName: j.cliName,
                    finishedAt: Date.now(), result: m.result, label: j.scope === "log" ? "Log " + (j.logIndex + 1) + "/" + j.logCount : "All " + plural(j.logCount, "log") + " in the file" };
                cache = cache.filter(function (e) { return e.key !== entry.key; }).concat([entry]).slice(-CACHE_MAX);
                var info = fileInfo();
                if (info && info.key === entry.fileKey) display(entry);
                else renderChrome();
            }
        }

        function cancel() {
            if (!job) return;
            cancelled = { key: job.key, ms: Date.now() - job.started };
            endJob();
            renderChrome();
        }

        // --- panes and plots

        function destroyPlots(key) {
            (handles[key] || []).forEach(function (h) {
                try { h.destroy(); } catch (e) { console.warn(e); }
            });
            handles[key] = [];
            delete pending[key];
        }

        // Plots need laid-out canvases, so they attach once the modal is shown. Their height is the stylesheet's
        // (.tuning-plot-canvas in css/tuning_dialog.css, lower in short windows), so the spec gives none
        function attachPlots(key) {
            var list = pending[key] || [];
            delete pending[key];
            list.forEach(function (p) {
                var canvas = document.getElementById(p.id), why = "the plot library (js/tuning_plot.js) is not loaded";
                if (!canvas) return;
                try {
                    if (typeof TuningPlot !== "undefined") return handles[key].push(TuningPlot.attach(canvas, p.spec));
                } catch (e) {
                    console.error(e);
                    why = "the plot failed: " + (e && e.message || e);
                }
                canvas.parentNode.className = "tuning-plot is-na";
                canvas.parentNode.innerHTML = '<div class="tuning-plot-title">' + esc(p.spec.title) + '</div><div class="tuning-na">not available: ' + esc(why) + "</div>";
            });
        }

        function renderPane(key) {
            if (!shown) return;
            destroyPlots(key);
            var out;
            try {
                out = renderTab(key, shown, view, env);
            } catch (e) {
                console.error(e);
                out = { html: notice("error", "This view could not be drawn: " + esc(e && e.message || e)), plots: [] };
            }
            pane(key).html(out.html);
            rendered[key] = shown;
            pending[key] = out.plots;
            if (visible) attachPlots(key);
        }

        function showTab(key) {
            view.tab = TABS.some(function (t) { return t.key === key; }) ? key : "overview";
            TABS.forEach(function (t) {
                body.find('.tuning-tab[data-tab="' + t.key + '"]').toggleClass("active", t.key === view.tab);
                pane(t.key).toggleClass("active", t.key === view.tab);
            });
            if (rendered[view.tab] !== shown) renderPane(view.tab);
            else if (visible) attachPlots(view.tab);
        }

        function clearPanes() {
            TABS.forEach(function (t) { destroyPlots(t.key); pane(t.key).html(""); });
            rendered = {};
            copyTexts = [];
        }

        function display(entry) {
            shown = entry;
            failure = null;
            view.segment = null;
            view.vibProfile = null;
            clearPanes();
            var n = { recs: recsOf(entry.result).length, checks: (entry.result.findings || []).length };
            Object.keys(n).forEach(function (k) { body.find('.tuning-tab[data-tab="' + k + '"] .tuning-tab-count').text(n[k] ? String(n[k]) : ""); });
            renderChrome();
            showTab(view.tab);
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
            var sc = r ? r.header || {} : log ? log.getSysConfig() : {}, items = ["<strong>" + esc(sc["Craft name"] || "Unnamed craft") + "</strong>"];
            if (sc["Firmware revision"]) items.push(esc(sc["Firmware revision"]));
            if (log) {
                var count = shown ? shown.logCount : log.getLogCount(), rec = r && isNum(li) ? logRecord(r, li) : null;
                items.push(esc(r && r.scope === "file" ? "All " + plural(count, "log") + (isNum(li) ? ", curves for log " + (li + 1) : "") :
                    "Log " + ((isNum(li) ? li : currentLog()) + 1) + "/" + count));
                if (rec) {
                    items.push(esc(secs(rec.durationS) + " long, " + secs(rec.flyingS) + " flying"));
                    if (profilesText(rec)) items.push(esc(profilesText(rec)));
                    items.push(esc(num(rec.rate) + " Hz logging" + (isNum(rec.actualRate) ? " (" + rec.actualRate.toFixed(1) + " Hz measured)" : "")));
                    if (excludedText(rec.excluded)) items.push(esc("excluded: " + excludedText(rec.excluded) + (isNum(rec.normalS) ? "; " + secs(rec.normalS) + " of normal flight left" : "")));
                } else if (!r) {
                    items.push(esc(secs((log.getMaxTime() - log.getMinTime()) / 1e6) + " long"));
                    if (headerRate(sc)) items.push(esc(Math.round(headerRate(sc)) + " Hz logging"));
                }
            }
            return items.map(function (x) { return "<span>" + x + "</span>"; }).join("");
        }

        function noticesHtml() {
            var out = [], info = fileInfo(), r = shown && shown.result, log = viewerLog();
            if (!log) return notice("info", "Open a blackbox log to analyse it.");
            if (failure) {
                out.push(notice("error", "<strong>The analysis failed.</strong> " + esc(failure.message) +
                    (failure.stack ? '<details><summary>Details</summary><pre class="tuning-stack">' + esc(failure.stack) + "</pre></details>" : "")));
            }
            if (r) {
                var low = (r.records || []).filter(function (x) { return isNum(x.rate) && x.rate < 1000; }).map(function (x) { return x.log; })
                    .filter(function (l, i, a) { return a.indexOf(l) === i; });
                if (r.scope === "file" && low.length) {
                    out.push(notice("warn", esc(plural(low.length, "log") + " (" + low.slice(0, 12).map(logLabel).join(", ") + (low.length > 12 ? ", …" : "") +
                        ") " + (low.length === 1 ? "is" : "are") + " recorded below 1 kHz. " + LOW_RATE)));
                } else if (low.length) {
                    out.push(notice("warn", esc(rateNote((r.records || []).filter(function (x) { return x.log === low[0]; })[0].rate))));
                }
                var li = shownLog(), key = currentKey();
                if (info && shown.fileKey !== info.key) { // log numbers and settings of two files do not compare
                    out.push(notice("warn", "These results are for another file. Press Analyse to check the open file."));
                } else if (isNum(li) && li !== currentLog()) {
                    out.push(notice("info", esc((r.scope === "log" ? "These results are" : "The curves, the log details and the header values of the recommendations are") + " for log " + (li + 1) +
                        "; the viewer shows log " + (currentLog() + 1) + ". Press Analyse to check log " + (currentLog() + 1) + ".")));
                } else if (key && key !== shown.key && !job) {
                    out.push(notice("info", "The scope, flight rpm or CLI dump differ from this result. Press Analyse to apply them."));
                }
                if (r.version !== 1) out.push(notice("warn", esc("The worker returned result version " + r.version + "; this dialog reads version 1.")));
                if (firmwareNote((r.header || {})["Firmware revision"])) out.push(notice("info", esc(firmwareNote(r.header["Firmware revision"]))));
            } else {
                var sc = log.getSysConfig();
                if (rateNote(headerRate(sc))) out.push(notice("warn", esc(rateNote(headerRate(sc)))));
                if (firmwareNote(sc["Firmware revision"])) out.push(notice("info", esc(firmwareNote(sc["Firmware revision"]))));
            }
            return out.join("");
        }

        function renderProgress() {
            var frac = 0, text, state = "";
            if (job) {
                var m = job.last || {};
                frac = isNum(m.fraction) ? Math.max(0, Math.min(1, m.fraction)) : null;
                text = cap(m.stage ? oneLine(m.stage) : "starting") + (m.text ? ": " + oneLine(m.text) : "") +
                    (frac !== null ? " (" + Math.round(frac * 100) + " %)" : "") + " · " + clock(Date.now() - job.started);
                state = frac === null ? "is-busy" : "is-running";
            } else if (failure) {
                text = "Failed";
                state = "is-failed";
            } else if (cancelled) {
                text = "Cancelled after " + clock(cancelled.ms);
            } else if (shown) {
                frac = 1;
                text = "Done: " + shown.label + (shown.result.timing && isNum(shown.result.timing.totalS) ? " in " + secs(shown.result.timing.totalS) : "");
                state = "is-done";
            } else {
                text = viewerLog() ? "Ready" : "No log loaded";
            }
            progress.attr("class", "tuning-progress " + state);
            progressBar.css("width", (frac === null ? 100 : frac * 100).toFixed(1) + "%");
            progressText.text(text);
        }

        function renderChrome() {
            var r = shown && shown.result, log = viewerLog(), count = log ? log.getLogCount() : 0;
            context.html(contextHtml());
            notices.html(noticesHtml());
            scopeSelect.val(view.scope);
            body.find('.tuning-scope option[value="file"]').text(count ? "All flights (" + plural(count, "log") + ")" : "All flights in file");
            scopeSelect.prop("disabled", !log);
            rpmInput.prop("disabled", !log);
            rpmInput.attr("placeholder", r && r.flightRpm && shown.rpm === null ? "auto: " + num(r.flightRpm.value) : "auto");
            analyseButton.prop("disabled", !log || !!job);
            cancelButton.prop("disabled", !job);
            saveButton.prop("disabled", !shown);
            cliName.html(cli ? esc(cli.name) + ' <a href="#" class="tuning-cli-clear" title="Forget the CLI dump">&times;</a>' : "");
            body.find(".tuning-tabs, .tuning-panes").toggleClass("tuning-hide", !shown);
            empty.toggleClass("tuning-hide", !!shown).html(shown ? "" : '<div class="tuning-intro"><p>' + (job ? "Analysing&hellip; the results appear here." :
                "Checks the setup Rotorflight controls (filters, governor, PID loops, feedforward, tail precompensation, rates and limits) against the " +
                "toolkit's rules, shows the error curves behind them, and suggests changes with CLI text for you to review.") + "</p>" +
                '<p class="tuning-muted">This log takes a few seconds. All flights in file also runs the gain analysis and takes one to three minutes per 100 MB, more the longer the flights. ' +
                "A CLI dump lets the checks compare the header with your settings and know where the notches sit.</p></div>");
            renderProgress();
        }

        // --- actions

        // A finding time t (s) of log li, in the viewer's FlightLog; only for the file the result is of
        function seekTo(li, t) {
            var info = fileInfo(), log = viewerLog();
            if (!shown || !info) return;
            if (shown.fileKey !== info.key) return renderChrome(); // another file was opened: say so rather than seek into it
            if (!isNum(li) || !isNum(t) || li < 0 || li >= log.getLogCount() || (log.getLogError && log.getLogError(li))) return;
            var us = log.getMinTime(li) + t * 1e6;
            dialog.modal("hide");
            if (li !== currentLog() && hooks.selectLog) hooks.selectLog(li);
            if (hooks.seek) hooks.seek(us);
        }

        function loadCli(file) {
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function () {
                var text = String(reader.result || "");
                if (text.length > 4e6 || !/^\s*(set\s+\S+\s*=|profile\s+\d|#\s*(dump|diff))/im.test(text)) {
                    failure = { message: file.name + " does not look like a Rotorflight CLI dump (diff all or dump)." };
                } else {
                    cli = { name: file.name, text: text, hash: fnv(text.length, function (i) { return text.charCodeAt(i); }, 1) };
                    failure = null;
                }
                settingsChanged();
            };
            reader.onerror = function () {
                failure = { message: "Could not read " + file.name + "." };
                renderChrome();
            };
            reader.readAsText(file);
        }

        function copy(text, button) {
            function done(ok) {
                button.textContent = ok ? "Copied" : "Copy failed";
                setTimeout(function () { button.textContent = "Copy"; }, 1500);
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

        function save() {
            if (!shown) return;
            var info = fileInfo(), sameFile = info && info.key === shown.fileKey; // else named after its own file, not the one dropped since
            var base = sameFile && typeof getLogBaseFilename === "function" ? getLogBaseFilename("log") : String(shown.result.fileName || "log").replace(/\.[^.]*$/, "");
            var text = markdown(shown);
            pickSaveFile({
                suggestedName: base + (shown.scope === "log" ? "-log" + (shown.logIndex + 1) : "") + "-tuning.md",
                description: "Markdown report", mimeType: "text/markdown", extension: ".md"
            }).then(function (target) {
                if (target) return target.write(new Blob([text], { type: "text/markdown" }));
            }).catch(function (error) { reportSaveError(error); });
        }

        function settingsChanged() {
            var hit = !job && cached(currentKey());
            if (hit && hit !== shown) display(hit);
            else renderChrome();
        }

        function refreshChecks() {
            if (shown) body.find(".tuning-checks-table").html(checksTable(shown, view));
        }

        // --- events (Bootstrap's data API is off, see js/main.js, so nothing here relies on it)

        dialog.on("click", ".tuning-analyse", function (e) { e.preventDefault(); start(); });
        dialog.on("click", ".tuning-cancel", function (e) { e.preventDefault(); cancel(); });
        dialog.on("click", ".tuning-save", function (e) { e.preventDefault(); save(); });
        dialog.on("click", ".tuning-cli-load", function (e) { e.preventDefault(); body.find(".tuning-cli-input")[0].click(); });
        dialog.on("change", ".tuning-cli-input", function () { loadCli(this.files && this.files[0]); this.value = ""; });
        dialog.on("click", ".tuning-cli-clear", function (e) { e.preventDefault(); cli = null; settingsChanged(); });
        dialog.on("change", ".tuning-scope", function () { view.scope = this.value === "file" ? "file" : "log"; settingsChanged(); });
        dialog.on("change", ".tuning-rpm", function () { settingsChanged(); });
        dialog.on("keydown", ".tuning-rpm", function (e) { if (e.which === 13 && !job) { e.preventDefault(); start(); } });
        dialog.on("click", ".tuning-tab", function (e) { e.preventDefault(); showTab(this.getAttribute("data-tab")); });
        dialog.on("click", ".tuning-axis", function () { view.axis = this.getAttribute("data-axis"); renderPane(view.tab); });
        dialog.on("change", ".tuning-segment", function () { view.segment = +this.value; renderPane(view.tab); renderChrome(); });
        dialog.on("change", ".tuning-vib-profile", function () { view.vibProfile = this.value; renderPane(view.tab); });
        dialog.on("click", ".tuning-seek", function (e) { e.preventDefault(); seekTo(+this.getAttribute("data-log"), +this.getAttribute("data-t")); });
        dialog.on("click", ".tuning-copy", function () { copy(copyTexts[+this.getAttribute("data-copy")] || "", this); });
        dialog.on("click", ".tuning-card", function () {
            view.area = this.getAttribute("data-area") || "all";
            view.sev = "all";
            rendered.checks = null;
            showTab("checks");
        });
        dialog.on("click", ".tuning-goto-rec", function (e) {
            e.preventDefault();
            showTab("recs");
            var target = document.getElementById(env.recId(+this.getAttribute("data-rec")));
            if (target) target.scrollIntoView({ block: "start" });
        });
        dialog.on("change", ".tuning-f-sev", function () { view.sev = this.value; refreshChecks(); });
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
        dialog.on("shown.bs.modal", function () {
            visible = true;
            attachPlots(view.tab);
        });
        dialog.on("hidden.bs.modal", function () {
            visible = false;
            if (!$(".modal.in").length) $(".modal-backdrop").remove(); // stuck backdrop, as in header_dialog.js
        });

        this.show = function (log) {
            cachedLog = hooks.getFlightLog ? null : log || null; // with the hook nothing keeps an old file's FlightLog alive
            var info = fileInfo();
            if (job && (!info || job.fileKey !== info.key)) endJob(); // another file was opened meanwhile
            if (shown && (!info || shown.fileKey !== info.key)) {
                shown = null;
                clearPanes();
            }
            var key = !job && currentKey(), hit = key && cached(key);
            if (hit && hit !== shown) {
                display(hit);
            } else if (key && !hit && view.scope === "log" && !(failure && failure.key === key) && !(cancelled && cancelled.key === key)) {
                start(); // one log takes seconds: analyse it straight away
            }
            renderChrome();
            dialog.modal("show");
        };
    }

    // Pure pieces, for test/tuning_dialog.test.cjs
    TuningDialog.internals = {
        esc: esc, num: num, valueSe: valueSe, threshold: threshold, logLabel: logLabel, paramText: paramText, findingStatus: findingStatus,
        areaOf: areaOf, findingWhere: findingWhere, findingAxis: findingAxis, rpmText: rpmText, TABS: TABS
    };

    return TuningDialog;
})();
