"use strict";

/**
 * TuningPlot - small dependency-free canvas plots for the Tuning dialog (error curves, spectra, governor, tail).
 *
 *   var plot = TuningPlot.attach(canvas, spec); // draws now and again whenever the canvas is resized
 *   plot.update(spec);                          // new data or options; legend toggles are kept by series name
 *   plot.destroy();                             // removes the listeners and the resize observer
 *
 * spec (every field optional):
 *   title, height  canvas height in css px, optional: without it the canvas keeps its stylesheet height (the Tuning
 *                  dialog's .tuning-plot-canvas: 220 px, 180 px under max-height 600px); the width is the
 *                  canvas's own (inline 100 % if unset)
 *   x, y, y2       { label, unit, log, min, max }; y2 null = no right axis. A missing x min or max fits every
 *                  series with data, hidden ones too (legend toggles never move x); a missing y or y2 one fits the
 *                  drawn series inside that x range and the hlines. Values within 1e-9 (relative) of each other
 *                  count as one; log axes leave out values <= 0 and stay inside 1e-300..1e300
 *   series         [{ name, x, y, color, width (1.5; 0 = no line), dash, axis: "y"|"y2", fill, lo, hi (shaded
 *                  band), step, points }]. x ascending (unsorted x is drawn, without hover readout); a y that is
 *                  NaN or null breaks the line. A step value (and its band) holds until the next x (bin edges: x
 *                  one longer than y, and the x range reaches the last edge)
 *   bands          [{ x0, x1, color, label }], shaded spans of x
 *   vlines, hlines [{ x, color, label, dash }], [{ y, color, label, dash, axis }]
 *   markers        [{ x, y, color, label, shape: "dot"|"tri" }], y on the left axis; without y a triangle on the
 *                  top edge
 *   legend         true (default): top right; clicking an entry hides or shows its series
 *   onClick(x, info), onHover(x, info)
 *                  x = the x value under the mouse (onHover(null, null) when the mouse leaves the plot); info =
 *                  { series: index into spec.series or -1, index: point index or -1, name, marker: index into
 *                  spec.markers or -1 }. Each series offers its point at the mouse x; info has the one of those
 *                  nearest the mouse, and the marker within 8 px
 *   format         { x, y }: value -> text, for the tick labels and the readout (the y2 axis keeps the default)
 * step, onHover, format and dot markers are supported, but the Tuning dialog does not use them yet.
 *
 * Hovering shows a crosshair and a readout: x, each series' value at it (with its lo..hi band), and the labels of
 * the marker and the vlines under the mouse and of the bands around it. Band labels, then vline labels, go along the
 * top in spec order, each on the first of a few rows with room and clear of the legend; those that find none show
 * only here.
 *
 * Series with more than 4 points per pixel column are drawn through the first, last, lowest and highest point of
 * each column (M4 decimation: the same picture, every extreme kept). The plot is drawn into a cached canvas once
 * per change; hovering copies it and draws only the crosshair and readout.
 */
var TuningPlot = (function () {

    var PALETTE = ["#fb8072", "#8dd3c7", "#ffffb3", "#bebada", "#80b1d3", "#fdb462", "#b3de69", "#fccde5",
        "#d9d9d9", "#bc80bd", "#ccebc5", "#ffed6f"]; // the colours of GraphConfig.PALETTE: default series colours

    var BACKGROUND = "rgb(20,20,20)", TEXT = "rgba(255,255,255,0.85)", GRID = "rgba(255,255,255,0.12)",
        GRID_MINOR = "rgba(255,255,255,0.05)", FRAME = "rgba(255,255,255,0.3)", CURSOR = "rgba(0,255,0,0.66)",
        HALO = "rgba(0,0,0,0.8)", FONT = "10px Verdana, Arial, sans-serif", TITLE_FONT = "bold 11px Verdana, Arial, sans-serif",
        ROW = 13, LOG_STEPS = [1, 2, 5]; // ROW: text line height, css px

    var finite = Number.isFinite;
    function positive(v) { return v > 0 && v < Infinity; }
    function format4(v) { return formatNumber(v, 4); }
    function format6(v) { return formatNumber(v, 6); }
    function labelled(v) { return { v: v, major: true, label: true }; } // a linear tick

    // A number as short text: `digits` significant digits without trailing zeros, exponent form outside 1e-3..1e5.
    function formatNumber(v, digits) {
        if (!finite(v)) return "-";
        var a = Math.abs(v);
        if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(digits - 1).replace(/\.?0+e/, "e").replace("e+", "e");
        return String(+v.toPrecision(digits));
    }

    // ---- axes and ticks ----

    // About `count` round ticks, 1, 2 or 5 x 10^k apart, inside [lo, hi]. None for a range a few float ulps wide:
    // the tick counter would pass 2^53, where k++ no longer changes it (and none where over 1000 would be needed).
    function niceTicks(lo, hi, count) {
        var raw = (hi - lo) / Math.max(1, count), ticks = [];
        if (!(raw > 0 && raw < Infinity)) return ticks;
        var e = Math.floor(Math.log10(raw)), f = raw / Math.pow(10, e);
        var m = f >= 7.07 ? 10 : f >= 3.16 ? 5 : f >= 1.41 ? 2 : 1; // thresholds sqrt(50), sqrt(10), sqrt(2)
        var step = m * Math.pow(10, e), inv = e < 0 ? Math.pow(10, -e) : 0;
        var k = Math.ceil(lo / step - 1e-9), k1 = Math.floor(hi / step + 1e-9);
        if (!(Math.abs(k) < 1e15 && Math.abs(k1) < 1e15 && k1 - k <= 1000)) return ticks;
        for (; k <= k1; k++) {
            ticks.push((inv ? k * m / inv : k * step) + 0); // k * m / 10^-e gives 0.3 exactly, k * 0.1 does not; + 0: no -0
        }
        return ticks;
    }

    // Log axis ticks: decades (major) and their 2 and 5 multiples (minor) inside [lo, hi]. All are labelled when at
    // most `maxLabels` of them fit, else every decade, or every stride-th one. Fewer than two labels: linear ticks.
    function logTicks(lo, hi, maxLabels) {
        var ticks = [], majors = 0, labels = 0;
        if (!(lo > 0 && hi < Infinity)) return ticks; // log10 of 0 or Infinity: the decade loop would never end
        for (var d = Math.floor(Math.log10(lo)), d1 = Math.ceil(Math.log10(hi)); d <= d1; d++) {
            for (var j = 0; j < 3; j++) {
                var m = LOG_STEPS[j], v = d < 0 ? m / Math.pow(10, -d) : m * Math.pow(10, d);
                if (v < lo * (1 - 1e-9) || v > hi * (1 + 1e-9)) continue;
                ticks.push({ v: v, major: m === 1, d: d });
                if (m === 1) majors++;
            }
        }
        var all = ticks.length <= maxLabels, stride = Math.max(1, Math.ceil(majors / maxLabels));
        ticks.forEach(function (t) { if ((t.label = all || (t.major && t.d % stride === 0))) labels++; });
        if (labels >= 2) return ticks;
        return niceTicks(lo, hi, Math.max(2, maxLabels / 2)).filter(positive).map(labelled);
    }

    // [min, max] of an axis: the spec's where set, else the extent of the valid values in `parts` ([array, i0, i1]
    // each), padded by `pad` of the span (in decades on log axes). No data or a single value still gives a range;
    // values within 1e-9 of each other count as one (the float noise of a constant, too narrow for any tick). A log
    // range stays inside 1e-300..1e300, so that 10^a neither underflows to 0 nor overflows.
    function axisRange(opt, parts, pad) {
        var log = !!opt.log, ok = log ? positive : finite, lo = Infinity, hi = -Infinity;
        parts.forEach(function (p) {
            for (var i = p[1], v; i <= p[2]; i++) if (ok(v = p[0][i])) { if (v < lo) lo = v; if (v > hi) hi = v; }
        });
        var t = log ? Math.log10 : Number, a = t(lo), b = t(hi), w = log ? 0.5 : Math.abs(a) * 0.1 || 0.5;
        if (!(lo <= hi)) { a = 0; b = 1; } else if (!(hi - lo > 1e-9 * Math.max(Math.abs(lo), Math.abs(hi)))) { a -= w; b += w; }
        var span = b - a;
        a = ok(opt.min) ? t(opt.min) : a - pad * span;
        b = ok(opt.max) ? t(opt.max) : b + pad * span;
        if (!(a < b)) { if (ok(opt.min)) b = a + span; else a = b - span; } // a set min above the data, or max below it
        if (log) { a = Math.max(a, -300); b = Math.min(b, 300); if (!(a < b)) { a = b < 300 ? -300 : 299; b = a + 1; } }
        return log ? [Math.pow(10, a), Math.pow(10, b)] : [a, b];
    }

    // Maps the range linearly (log axes: in log10) onto the pixels p0..p1.
    function makeAxis(opt, range, p0, p1) {
        var log = !!opt.log, t0 = log ? Math.log10(range[0]) : range[0], k = (p1 - p0) / ((log ? Math.log10(range[1]) : range[1]) - t0);
        return {
            opt: opt, min: range[0], max: range[1], log: log, ok: log ? positive : finite,
            px: log ? function (v) { return p0 + (Math.log10(v) - t0) * k; } : function (v) { return p0 + (v - t0) * k; },
            val: function (p) { var u = t0 + (p - p0) / k; return log ? Math.pow(10, u) : u; }
        };
    }

    // Ticks along an axis `pixels` long: log labels at least logGap px apart, linear ticks about linGap apart.
    function axisTicks(A, pixels, logGap, linGap) {
        if (A.log) return logTicks(A.min, A.max, Math.max(2, Math.floor(pixels / logGap)));
        return niceTicks(A.min, A.max, Math.max(2, Math.round(pixels / linGap))).map(labelled);
    }

    // ---- series data ----

    // First index i < n of the ascending array a with a[i] >= v (a[i] > v when `after`), n if there is none.
    function search(a, v, n, after) {
        for (var lo = 0, hi = n, mid; lo < hi;) {
            mid = (lo + hi) >> 1;
            if (a[mid] < v || (after && a[mid] === v)) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    // Index of the element of the ascending array a (its first n) nearest to v, -1 if there is none; with px,
    // nearest in pixels (which differs on log axes).
    function nearest(a, v, n, px) {
        if (n === undefined) n = a.length;
        if (!(n > 0) || !finite(v)) return -1;
        var i = search(a, v, n);
        if (i === 0) return 0;
        if (i === n) return n - 1;
        px = px || Number;
        return px(v) - px(a[i - 1]) <= px(a[i]) - px(v) ? i - 1 : i;
    }

    function ascending(a, n) {
        for (var i = 1; i < n; i++) if (!(a[i] >= a[i - 1])) return false;
        return true;
    }

    // Indices of the points i0..i1 to draw, in order, -1 for each gap (where ok(i) is false). Dense series keep the
    // first, last, lowest and highest point of every pixel column col(x) (M4 decimation): the line looks the same
    // to the pixel and every extreme stays.
    function decimate(x, y, i0, i1, col, ok, dense) {
        var out = [], c = NaN, first = -1, last = -1, lo = -1, hi = -1;
        function flush() {
            if (first < 0) return;
            var keep = [first, lo, hi, last].sort(function (p, q) { return p - q; });
            for (var j = 0; j < 4; j++) if (keep[j] !== out[out.length - 1]) out.push(keep[j]);
            first = -1;
        }
        for (var i = i0, k; i <= i1; i++) {
            if (!ok(i)) {
                flush();
                c = NaN;
                if (out.length && out[out.length - 1] !== -1) out.push(-1);
            } else if (!dense) {
                out.push(i);
            } else {
                if ((k = Math.floor(col(x[i]))) !== c) { flush(); c = k; first = lo = hi = i; }
                else if (y[i] < y[lo]) lo = i;
                else if (y[i] > y[hi]) hi = i;
                last = i;
            }
        }
        flush();
        return out;
    }

    // ---- drawing ----

    function crisp(p) { return Math.round(p) + 0.5; } // the middle of a pixel, for sharp 1 px lines
    function seg(c, x0, y0, x1, y1) { c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }
    function refLine(c, color, dash, x0, y0, x1, y1) { // hlines and vlines, dashed unless told otherwise
        c.lineWidth = 1; c.strokeStyle = color || TEXT; c.setLineDash(dash || [4, 3]);
        seg(c, x0, y0, x1, y1);
        c.setLineDash([]);
    }
    function text(c, s, x, y, align, baseline, color) {
        c.textAlign = align; c.textBaseline = baseline; c.fillStyle = color || TEXT;
        c.fillText(s, x, y);
    }
    function haloText(c, s, x, y, align, baseline, color) { // with a dark outline, readable over curves
        c.lineWidth = 3; c.strokeStyle = HALO; c.textAlign = align; c.textBaseline = baseline;
        c.strokeText(s, x, y);
        text(c, s, x, y, align, baseline, color);
    }
    function axisTitle(opt) { return opt.label && opt.unit ? opt.label + " (" + opt.unit + ")" : opt.label || opt.unit || ""; }

    // Adds the line through the points idx (-1 = gap) to the path; with a baseline each run is closed down to it.
    // A step value holds until the next x, so the last one of a run reaches the next x (bin edges: x one longer).
    function tracePath(c, d, idx, X, base) {
        var s = d.s, step = s.step && !d.dense, open = false, qx = 0, qy = 0, qi = -1, filled = base !== undefined;
        for (var k = 0; k <= idx.length; k++) {
            var i = k < idx.length ? idx[k] : -1;
            if (i < 0) {
                if (open && step && X.ok(s.x[qi + 1])) c.lineTo(qx = X.px(s.x[qi + 1]), qy);
                if (open && filled) { c.lineTo(qx, base); c.closePath(); }
                open = false;
                continue;
            }
            var nx = X.px(s.x[i]), ny = d.A.px(s.y[i]);
            if (!open) c.moveTo(nx, filled ? base : ny);
            if (open && step) c.lineTo(nx, qy);
            if (open || filled) c.lineTo(nx, ny);
            open = true; qx = nx; qy = ny; qi = i;
        }
    }

    // Adds the lo..hi band of a series to the path: a polygon per run of valid points, upper edge forwards and lower
    // edge back; dense series use the envelope of each pixel column, and a step band holds until the next x like
    // its line.
    function traceBand(c, d, X) {
        var s = d.s, A = d.A, up = [], down = [], col = NaN, step = s.step && !d.dense;
        function close() {
            for (var k = 0; k < up.length; k += 2) c[k ? "lineTo" : "moveTo"](up[k], up[k + 1]);
            for (k = down.length - 2; k >= 0; k -= 2) c.lineTo(down[k], down[k + 1]);
            if (up.length) c.closePath();
            up = []; down = []; col = NaN;
        }
        for (var i = d.i0, i1 = Math.min(d.i1, d.nb - 1); i <= i1; i++) {
            if (!X.ok(s.x[i]) || !A.ok(s.lo[i]) || !A.ok(s.hi[i])) { close(); continue; }
            var px = X.px(s.x[i]), top = A.px(s.hi[i]), bottom = A.px(s.lo[i]), k = d.dense ? Math.floor(px) : i;
            if (k === col) {
                up[up.length - 1] = Math.min(up[up.length - 1], top);
                down[down.length - 1] = Math.max(down[down.length - 1], bottom);
            } else {
                up.push(px, top); down.push(px, bottom); col = k;
                if (step && X.ok(s.x[i + 1])) { px = X.px(s.x[i + 1]); up.push(px, top); down.push(px, bottom); }
            }
        }
        close();
    }

    function attach(canvas, spec) {
        if (canvas._tuningPlot) canvas._tuningPlot.destroy(); // one plot per canvas
        var g = canvas.getContext("2d"), cache = document.createElement("canvas"), cg = cache.getContext("2d"),
            hidden = {}, meta = [], L = null, mouse = null, observer = null, dead = false, drawn = "", device = null,
            ownHeight = false; // the inline height is spec.height, set here

        function update(newSpec) {
            if (dead) return;
            spec = newSpec || {};
            meta = (spec.series || []).map(function (s, k) {
                var n = s && s.x && s.y ? Math.min(s.x.length, s.y.length) : 0;
                return { s: s, k: k, n: n, sorted: ascending(n && s.x, n), color: (s && s.color) || PALETTE[k % PALETTE.length],
                    nb: n && s.lo && s.hi ? Math.min(n, s.lo.length, s.hi.length) : 0 }; // nb: points with a band
            });
            if (!canvas.style.width) canvas.style.width = "100%";
            if (!canvas.style.display) canvas.style.display = "block";
            if (spec.height) { canvas.style.height = spec.height + "px"; ownHeight = true; }
            else if (ownHeight) { canvas.style.height = ""; ownHeight = false; } // back to the stylesheet height
            draw();
        }

        // css width and height to lay out in, the device pixel ratio and the backing store's width and height. The
        // store is the css size x the ratio, or the device pixel box the resize observer last reported when that is
        // within r + 1.5 device px of it (clientWidth is a rounded css px; a box further off is stale, e.g. from
        // before update() set a new height). A store a device px off the box the compositor paints is rescaled,
        // which blurs the text and the crisp 1 px lines. The layout is then that box / the ratio, so the scale stays
        // the exact ratio.
        function size() {
            var W = canvas.clientWidth, H = canvas.clientHeight, r = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1,
                bw = Math.round(W * r), bh = Math.round(H * r);
            if (device && W > 0 && H > 0 && Math.abs(device[0] - bw) <= r + 1.5 && Math.abs(device[1] - bh) <= r + 1.5) {
                bw = device[0]; bh = device[1]; W = bw / r; H = bh / r;
            }
            return [W, H, r, bw, bh];
        }

        function draw() {
            var z = size(), W = z[0], H = z[1], r = z[2], bw = z[3], bh = z[4];
            if (dead) return;
            drawn = z.join();
            if (!(W > 0 && H > 0)) { // hidden or detached: free the cache, the resize observer calls again when shown
                cache.width = cache.height = 0;
                L = null;
                return;
            }
            [canvas, cache].forEach(function (k) { if (k.width !== bw || k.height !== bh) { k.width = bw; k.height = bh; } });
            cg.setTransform(r, 0, 0, r, 0, 0);
            L = render(cg, W, H);
            if (L) L.r = r;
            paint();
        }

        // Draws the whole plot in css px and returns its layout (axes, plot box, drawn series, markers, legend).
        function render(c, W, H) {
            var xo = spec.x || {}, yo = spec.y || {}, y2o = spec.y2 || null, fmt = spec.format || {};
            var list = meta.filter(function (d) { return d.n && !(d.s.name && hidden[d.s.name]); });
            c.fillStyle = BACKGROUND; c.fillRect(0, 0, W, H); c.font = FONT; c.lineJoin = "round";

            // ranges: x from every series with data, hidden ones too, so that legend toggles never move it (a step
            // series in bin-edge form up to its last edge); y from the drawn series' points inside the x range (on a
            // step series also the bin the range starts in) and the hlines
            var xr = axisRange(xo, meta.filter(function (d) { return d.n; }).map(function (d) {
                return [d.s.x, 0, d.s.step && d.s.x.length > d.n ? d.n : d.n - 1];
            }), 0);
            list.forEach(function (d) {
                d.j0 = !d.sorted ? 0 : d.s.step ? Math.max(0, search(d.s.x, xr[0], d.n, true) - 1) : search(d.s.x, xr[0], d.n);
                d.j1 = d.sorted ? search(d.s.x, xr[1], d.n, true) - 1 : d.n - 1;
                d.i0 = Math.max(0, d.j0 - 1); // one point beyond each end, so lines run to the edges
                d.i1 = Math.min(d.n - 1, d.j1 + 1);
                d.y2 = !!y2o && d.s.axis === "y2";
                d.unit = (d.y2 ? y2o : yo).unit;
            });
            function yRange(opt, onY2) {
                var parts = [], hv = [];
                list.forEach(function (d) {
                    if (d.y2 !== onY2) return;
                    parts.push([d.s.y, d.j0, d.j1]);
                    if (d.nb) parts.push([d.s.lo, d.j0, Math.min(d.j1, d.nb - 1)], [d.s.hi, d.j0, Math.min(d.j1, d.nb - 1)]);
                });
                (spec.hlines || []).forEach(function (h) { if ((!!y2o && h.axis === "y2") === onY2) hv.push(h.y); });
                return axisRange(opt, parts.concat([[hv, 0, hv.length - 1]]), 0.05);
            }

            // layout: the left and right margins fit the widest tick label
            var tx = fmt.x || format6, ty = fmt.y || format6, ty2 = format6;
            var T = spec.title ? 22 : 8, B = H - (axisTitle(xo) ? 34 : 20);
            var Y = makeAxis(yo, yRange(yo, false), B, T), Y2 = y2o && makeAxis(y2o, yRange(y2o, true), B, T);
            var yTicks = axisTicks(Y, B - T, 20, 32), y2Ticks = Y2 ? axisTicks(Y2, B - T, 20, 32) : [];
            function widest(ticks, f) {
                return ticks.reduce(function (w, t) { return t.label ? Math.max(w, c.measureText(f(t.v)).width) : w; }, 0);
            }
            var left = Math.round(8 + widest(yTicks, ty) + (axisTitle(yo) ? 14 : 0)),
                right = Math.round(W - (Y2 ? 8 + widest(y2Ticks, ty2) + (axisTitle(y2o) ? 14 : 0) : 14));
            if (right - left < 20 || B - T < 20) return null; // too small for a plot
            var X = makeAxis(xo, xr, left, right), xTicks = axisTicks(X, right - left, 45, 70);
            list.forEach(function (d) { d.A = d.y2 ? Y2 : Y; d.dense = d.i1 - d.i0 + 1 > 4 * (right - left); });

            // the legend box (drawn last) comes first, so that the labels along the top keep clear of it
            var entries = spec.legend === false ? [] : meta.filter(function (d, k) {
                return d.n && d.s.name && !meta.slice(0, k).some(function (e) { return e.n && e.s.name === d.s.name; });
            });
            var lw = entries.length ? 32 + entries.reduce(function (w, e) { return Math.max(w, c.measureText(e.s.name).width); }, 0) : 0,
                lx = right - lw - 4, lb = T + 10 + entries.length * ROW; // left edge and bottom of the legend box

            // inside the plot box: bands, grid, reference lines, series, markers
            c.save(); c.beginPath(); c.rect(left, T, right - left, B - T); c.clip();
            var rows = [-Infinity, -Infinity, -Infinity]; // right ends of the label rows along the top
            while (lw && T + 3 + (rows.length - 1) * ROW < lb) rows.push(-Infinity); // more, down to one below the legend
            function topLabel(s, x, color) { // on the first row with room, clear of the legend, else only in the readout
                var w = c.measureText(s).width, at = x + 3 + w > right ? x - 3 - w : x + 3;
                for (var r = 0, y = T + 3; r < rows.length; r++, y += ROW) {
                    if (!(at > rows[r] + 4 && (!lw || at + w < lx - 2 || y >= lb))) continue;
                    rows[r] = at + w;
                    return haloText(c, s, at, y, "left", "top", color);
                }
            }
            (spec.bands || []).forEach(function (b) {
                if (!(b.x0 <= b.x1) || b.x1 < X.min || b.x0 > X.max) return;
                var a = X.ok(b.x0) && b.x0 > X.min ? X.px(b.x0) : left, z = b.x1 < X.max ? X.px(b.x1) : right;
                c.fillStyle = b.color || "rgba(255,255,255,0.08)";
                c.fillRect(a, T, Math.max(1, z - a), B - T);
                if (b.label) topLabel(b.label, a);
            });
            c.lineWidth = 1;
            xTicks.forEach(function (t) { var p = crisp(X.px(t.v)); c.strokeStyle = t.major ? GRID : GRID_MINOR; seg(c, p, T, p, B); });
            yTicks.forEach(function (t) {
                var p = crisp(Y.px(t.v));
                c.strokeStyle = t.major ? GRID : GRID_MINOR;
                seg(c, left, p, right, p);
            });
            (spec.hlines || []).forEach(function (h) {
                var A = h.axis === "y2" && Y2 ? Y2 : Y, p = A.ok(h.y) && h.y >= A.min && h.y <= A.max ? crisp(A.px(h.y)) : NaN;
                if (!finite(p)) return;
                refLine(c, h.color, h.dash, left, p, right, p);
                if (!h.label) return;
                var top = p - 2 - ROW < T ? p + 2 : p - 2 - ROW, onLeft = lw && top < lb; // above the line; the top right is the legend's
                haloText(c, h.label, onLeft ? left + 4 : right - 4, top, onLeft ? "left" : "right", "top", h.color);
            });
            (spec.vlines || []).forEach(function (v) {
                var p = X.ok(v.x) && v.x >= X.min && v.x <= X.max ? crisp(X.px(v.x)) : NaN;
                if (!finite(p)) return;
                refLine(c, v.color, v.dash, p, T, p, B);
                if (v.label) topLabel(v.label, p, v.color);
            });
            list.forEach(function (d) {
                var s = d.s, A = d.A;
                var idx = decimate(s.x, s.y, d.i0, d.i1, X.px, function (i) { return X.ok(s.x[i]) && A.ok(s.y[i]); }, d.dense);
                c.strokeStyle = c.fillStyle = d.color;
                if (d.nb) { c.globalAlpha = 0.2; c.beginPath(); traceBand(c, d, X); c.fill(); }
                if (s.fill) { // down to y = 0, or to the bottom edge when 0 is not on the axis
                    c.globalAlpha = 0.25;
                    c.beginPath();
                    tracePath(c, d, idx, X, A.log ? B : A.px(Math.min(Math.max(0, A.min), A.max)));
                    c.fill();
                }
                c.globalAlpha = 1;
                if (s.width !== 0) {
                    c.lineWidth = s.width || 1.5; c.setLineDash(s.dash || []);
                    c.beginPath(); tracePath(c, d, idx, X); c.stroke();
                    c.setLineDash([]);
                }
                if (!s.points) return;
                var radius = Math.max(2, (s.width || 1.5) + 0.5);
                c.beginPath();
                idx.forEach(function (i) {
                    if (i < 0) return;
                    c.moveTo(X.px(s.x[i]) + radius, A.px(s.y[i]));
                    c.arc(X.px(s.x[i]), A.px(s.y[i]), radius, 0, 2 * Math.PI);
                });
                c.fill();
            });
            var markers = [];
            (spec.markers || []).forEach(function (m, k) {
                var onTop = !Y.ok(m.y);
                if (!X.ok(m.x) || m.x < X.min || m.x > X.max) return;
                var px = X.px(m.x), py = onTop ? T + 8 : Y.px(m.y), tri = m.shape ? m.shape === "tri" : onTop;
                c.fillStyle = m.color || TEXT; c.strokeStyle = HALO; c.lineWidth = 1;
                c.beginPath();
                if (tri) { // pointing down at the spot
                    c.moveTo(px - 5, py - 8);
                    c.lineTo(px + 5, py - 8);
                    c.lineTo(px, py);
                    c.closePath();
                } else {
                    c.arc(px, py, 3.5, 0, 2 * Math.PI);
                }
                c.fill(); c.stroke();
                markers.push({ k: k, x: px, y: tri ? py - 4 : py });
            });
            if (!meta.some(function (d) { return d.n; })) {
                text(c, "no data", (left + right) / 2, (T + B) / 2, "center", "middle", "rgba(255,255,255,0.4)");
            }
            c.restore();

            // frame, tick labels, axis titles (the y ones rotated to read towards the plot), title
            c.strokeStyle = FRAME; c.lineWidth = 1;
            c.strokeRect(crisp(left), crisp(T), Math.round(right - left), Math.round(B - T));
            xTicks.forEach(function (t) {
                var s = t.label && tx(t.v), w = s && c.measureText(s).width;
                if (s) text(c, s, Math.min(Math.max(X.px(t.v), w / 2 + 1), W - w / 2 - 1), B + 4, "center", "top");
            });
            yTicks.forEach(function (t) { if (t.label) text(c, ty(t.v), left - 4, Y.px(t.v), "right", "middle"); });
            y2Ticks.forEach(function (t) { if (t.label) text(c, ty2(t.v), right + 4, Y2.px(t.v), "left", "middle"); });
            if (axisTitle(xo)) text(c, axisTitle(xo), (left + right) / 2, H - 3, "center", "bottom");
            [[yo, 3, -1], [y2o, W - 3, 1]].forEach(function (a) {
                if (!a[0] || !axisTitle(a[0])) return;
                c.save(); c.translate(a[1], (T + B) / 2); c.rotate(a[2] * Math.PI / 2);
                text(c, axisTitle(a[0]), 0, 0, "center", "top");
                c.restore();
            });
            if (spec.title) { c.font = TITLE_FONT; text(c, spec.title, left, 6, "left", "top"); c.font = FONT; }

            // legend: every named series with data, hidden ones dimmed
            var legend = [];
            if (lw) {
                c.fillStyle = "rgba(0,0,0,0.55)";
                c.fillRect(lx, T + 4, lw, lb - T - 4);
                entries.forEach(function (e, k) {
                    var y = T + 7 + k * ROW + ROW / 2;
                    c.globalAlpha = hidden[e.s.name] ? 0.35 : 1;
                    c.strokeStyle = c.fillStyle = e.color;
                    if (e.s.width === 0) c.fillRect(lx + 8, y - 3, 10, 6);
                    else { c.lineWidth = 2; c.setLineDash(e.s.dash || []); seg(c, lx + 5, y, lx + 21, y); c.setLineDash([]); }
                    text(c, e.s.name, lx + 26, y, "left", "middle");
                    legend.push({ x: lx, y: y - ROW / 2, w: lw, h: ROW, name: e.s.name });
                });
                c.globalAlpha = 1;
            }
            return { X: X, left: left, right: right, top: T, bottom: B, list: list, markers: markers, legend: legend,
                tx: fmt.x || format4, ty: fmt.y || format4, ty2: format4 };
        }

        // Each drawn series' point at the mouse x: the nearest (on a step series the step under the mouse), for
        // ascending series while the mouse is over the series' x span give or take 8 px; the one of them nearest the
        // mouse; and the marker within 8 px.
        function pick(m) {
            var X = L.X, xv = X.val(m.x), hits = [], best = null, marker = -1, reach = 8;
            L.list.forEach(function (d) {
                var s = d.s, i = !d.sorted ? -1 : s.step ? search(s.x, xv, d.n, true) - 1 : nearest(s.x, xv, d.n, X.px);
                if (i < 0 || !X.ok(s.x[i]) || !d.A.ok(s.y[i])) return;
                var h = { d: d, i: i, px: s.step ? m.x : X.px(s.x[i]), py: d.A.px(s.y[i]) },
                    end = s.x[Math.min(d.n, s.x.length - 1)]; // the last x, or the last bin edge
                if (Math.abs(X.px(s.x[i]) - m.x) > 8 && (xv < s.x[0] || !(xv <= end))) return;
                h.dist = Math.hypot(h.px - m.x, h.py - m.y);
                hits.push(h);
                if (!best || h.dist < best.dist) best = h;
            });
            L.markers.forEach(function (p) {
                var q = Math.hypot(p.x - m.x, p.y - m.y);
                if (q <= reach) { reach = q; marker = p.k; }
            });
            return { x: xv, hits: hits, info: { series: best ? best.d.k : -1, index: best ? best.i : -1,
                name: best ? best.d.s.name || null : null, marker: marker } };
        }

        // Crosshair at the hit nearest the mouse x, a dot on every hit, and a box with their values (each after a
        // swatch of its colour), the marker's label, the labels of the vlines on the axis within 4 px of the mouse
        // (whether or not they found room along the top) and of the bands under it.
        function readout(p) {
            var near = null, unit = function (u) { return u ? " " + u : ""; };
            p.hits.forEach(function (h) { if (!near || Math.abs(h.px - mouse.x) < Math.abs(near.px - mouse.x)) near = h; });
            var sx = crisp(near ? near.px : mouse.x), sy = crisp(mouse.y), xv = near && !near.d.s.step ? near.d.s.x[near.i] : p.x,
                lines = [{ text: L.tx(xv) + unit(L.X.opt.unit), color: "rgba(0,255,0,0.9)" }];
            g.lineWidth = 1; g.strokeStyle = CURSOR;
            seg(g, sx, L.top, sx, L.bottom);
            seg(g, L.left, sy, L.right, sy);
            p.hits.forEach(function (h) {
                var s = h.d.s, f = h.d.y2 ? L.ty2 : L.ty, i = h.i, A = h.d.A,
                    band = i < h.d.nb && A.ok(s.lo[i]) && A.ok(s.hi[i]) ? " [" + f(s.lo[i]) + ", " + f(s.hi[i]) + "]" : "";
                g.fillStyle = h.d.color; g.strokeStyle = HALO;
                g.beginPath(); g.arc(h.px, h.py, 3, 0, 2 * Math.PI); g.fill(); g.stroke();
                lines.push({ text: (s.name ? s.name + ": " : "") + f(s.y[i]) + unit(h.d.unit) + band, swatch: h.d.color });
            });
            var mk = p.info.marker >= 0 && spec.markers[p.info.marker];
            if (mk && mk.label) lines.push({ text: String(mk.label), swatch: mk.color || TEXT });
            (spec.vlines || []).forEach(function (v) {
                if (v.label && L.X.ok(v.x) && v.x >= L.X.min && v.x <= L.X.max && Math.abs(crisp(L.X.px(v.x)) - mouse.x) <= 4) {
                    lines.push({ text: String(v.label), swatch: v.color || TEXT });
                }
            });
            (spec.bands || []).forEach(function (b) { if (b.label && p.x >= b.x0 && p.x <= b.x1) lines.push({ text: String(b.label) }); });
            g.font = FONT;
            var bw = 26 + lines.reduce(function (w, l) { return Math.max(w, g.measureText(l.text).width); }, 0), bh = lines.length * ROW + 6;
            var bx = Math.max(0, mouse.x + 12 + bw > L.right ? mouse.x - 12 - bw : mouse.x + 12), // right of the cursor if it fits
                by = Math.max(L.top, Math.min(mouse.y + 12, L.bottom - bh));
            g.fillStyle = "rgba(0,0,0,0.75)";
            g.fillRect(bx, by, bw, bh);
            lines.forEach(function (l, k) {
                var y = by + 3 + k * ROW + ROW / 2;
                if (l.swatch) { g.fillStyle = l.swatch; g.fillRect(bx + 6, y - 2, 10, 4); }
                text(g, l.text, bx + 20, y, "left", "middle", l.color);
            });
        }

        // Copies the cached plot to the canvas and adds the hover readout; returns the pick under the mouse.
        function paint() {
            if (!cache.width || !cache.height) return null;
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.drawImage(cache, 0, 0);
            var p = mouse && inPlot(mouse) ? pick(mouse) : null;
            if (p) { g.setTransform(L.r, 0, 0, L.r, 0, 0); readout(p); }
            return p;
        }

        function inPlot(m) { return L && m.x >= L.left && m.x <= L.right && m.y >= L.top && m.y <= L.bottom; }
        function legendAt(m) {
            return L && L.legend.filter(function (e) { return m.x >= e.x && m.x <= e.x + e.w && m.y >= e.y && m.y < e.y + e.h; })[0];
        }
        function position(e) {
            var b = canvas.getBoundingClientRect();
            return { x: e.clientX - b.left, y: e.clientY - b.top };
        }

        function onMove(e) {
            mouse = position(e);
            var p = paint();
            canvas.style.cursor = legendAt(mouse) ? "pointer" : p && spec.onClick ? "crosshair" : "";
            if (spec.onHover) spec.onHover(p ? p.x : null, p ? p.info : null);
        }
        function onLeave() {
            mouse = null;
            paint();
            if (spec.onHover) spec.onHover(null, null);
        }
        function onClick(e) {
            var m = position(e), entry = legendAt(m), p;
            if (entry) {
                hidden[entry.name] = !hidden[entry.name];
                draw();
            } else if (spec.onClick && inPlot(m)) {
                p = pick(m);
                spec.onClick(p.x, p.info);
            }
        }

        function destroy() {
            if (dead) return;
            dead = true;
            if (observer) observer.disconnect();
            canvas.removeEventListener("mousemove", onMove);
            canvas.removeEventListener("mouseleave", onLeave);
            canvas.removeEventListener("click", onClick);
            if (canvas._tuningPlot === handle) delete canvas._tuningPlot;
            cache.width = cache.height = 0;
            L = null;
        }

        var handle = { update: update, destroy: destroy };
        canvas._tuningPlot = handle;
        canvas.addEventListener("mousemove", onMove);
        canvas.addEventListener("mouseleave", onLeave);
        canvas.addEventListener("click", onClick);
        if (typeof ResizeObserver === "function") { // redraws on a new size or pixel ratio, not for our own style.height
            observer = new ResizeObserver(function (entries) {
                var e = entries && entries[entries.length - 1], box = e && e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
                device = box ? [box.inlineSize, box.blockSize] : null; // Chromium 84+
                if (size().join() !== drawn) draw();
            });
            try { observer.observe(canvas, { box: "device-pixel-content-box" }); } catch (e) { observer.observe(canvas); }
        }
        update(spec);
        return handle;
    }

    return {
        attach: attach,
        // helpers, for the tests and for callers that want the same number format
        niceTicks: niceTicks, logTicks: logTicks, decimate: decimate, nearest: nearest, formatNumber: formatNumber
    };
})();
