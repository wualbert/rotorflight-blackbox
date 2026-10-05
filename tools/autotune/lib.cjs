'use strict';

/**
 * Shared code for the tuning analysis scripts.
 *
 *   loadApp / segments   decode logs with the app's own parser, headless, and cut them into analysis segments
 *   lpf1 / dif           sample-for-sample replicas of the firmware filters (rotorflight-firmware common/filter.c)
 *   recoverGains         PID gains actually in effect, regressed from the logged PID terms
 *   segmentSpectra       Welch cross-spectra between setpoint (r), mixer input (u) and gyro (y)
 *   pool                 pooled frequency responses with leave-one-flight-out (jackknife) standard errors
 *   fitPlant             parametric plant model, weighted by the measured uncertainty
 *   closedLoop / ...     the firmware control law (PID mode 3) around a plant model
 *
 * Units: rates in deg/s, control (mixer, PID terms) as a fraction of full authority, time in seconds.
 */

const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const AXES = ['roll', 'pitch', 'yaw'];

// Gain scaling, rotorflight-firmware src/main/flight/pid.h. O shares the I scale.
const SCALE = {
    P: [6.66666e-6, 6.66666e-6, 6.666666e-5],
    I: [2e-4, 2e-4, 5e-4],
    D: [0.1e-6, 1.0e-6, 1.0e-6],
    F: [2.5e-5, 2.5e-5, 2.5e-5],
    B: [0.1e-6, 0.1e-6, 1.0e-6],
};

const SPEC = { N: 2000, bins: 120 }; // 2 s windows at 1 kHz -> 0.5 Hz bins, kept up to 60 Hz

// Flights are grouped by the headspeed they were flown at, to the nearest 250 rpm
const headspeedClass = (rpm) => Math.round(rpm / 250) * 250;

// ---------------------------------------------------------------------------------------------
// Headless loader
// ---------------------------------------------------------------------------------------------

const SCRIPTS = ['vendor/semver', 'complex', 'real', 'tools', 'cache', 'datastream', 'decoders',
    'flightlog_fielddefs', 'flightlog_fields_presenter', 'flightlog_parser', 'flightlog_index', 'flightlog'];

function loadApp(root = path.resolve(__dirname, '../..')) {
    // jQuery stand-in: the decoder only toggles CSS classes and merges option objects.
    const chain = new Proxy(function() {}, { get: () => () => chain });
    const $ = Object.assign(() => chain, {
        extend: (deep, target, ...rest) => deep === true ? Object.assign(target, ...rest) : Object.assign(deep, target, ...rest),
    });
    const context = vm.createContext({ $, console: { log() {}, error: console.error } });
    for (const name of SCRIPTS) {
        const file = path.join(root, 'js', name + '.js');
        vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    }
    return context;
}

// ---------------------------------------------------------------------------------------------
// Segments: airborne, spooled up, one PID profile, no logging gaps
// ---------------------------------------------------------------------------------------------

// extra: names of further logged fields to return as raw columns in seg.extra (null where the log lacks one)
// whole: yield every log from start to end, cut only at logging gaps, with the PID profile and the airborne
//        state as columns (profileAt, 0 until the first switch, and airborneAt), the governor state from GOVSTATE
//        events (govStateAt, 0 = OFF until the first event; null if the log has none) and rescue (rescueAt, 1 while
//        RESCUE_STATE is not 0, exit blend included). Nothing is left out.
// Rescue flies its own setpoint while the log keeps the pilot's, so analysis segments (both modes) leave it out.
// In flight: rotor at or above this rpm. 3000 suits 3500-5000 rpm flying; set AUTOTUNE_FLIGHT_RPM for a slower rotor.
const FLIGHT_RPM = +process.env.AUTOTUNE_FLIGHT_RPM || 3000;
const DEFAULTS = { minFlightS: 30, minSegmentS: 20, minHeadspeed: FLIGHT_RPM * 5 / 6, spoolFraction: 0.9, extra: [], whole: false };

function* segments(app, file, options = {}) {
    const o = Object.assign({}, DEFAULTS, options);
    app.__bytes = new Uint8Array(fs.readFileSync(file));
    const log = vm.runInContext('new FlightLog(__bytes)', app);
    const EVENT = vm.runInContext('FlightLogEvent', app);

    for (let li = 0; li < log.getLogCount(); li++) {
        if (log.getLogError(li) || !log.openLog(li)) continue;
        const sc = log.getSysConfig(), tMin = log.getMinTime(), tMax = log.getMaxTime();
        const durationS = (tMax - tMin) / 1e6;
        const rate = 1e6 / sc.looptime * sc.frameIntervalPNum / sc.frameIntervalPDenom / (sc.pid_process_denom || 1);
        const flight = {
            file: path.basename(file), log: li, start: sc['Log start datetime'], durationS, rate,
            firmware: sc['Firmware revision'], craft: sc['Craft name'],
            id: `${sc['Log start datetime']}|${tMin}|${tMax}`, // the same flight can sit in two flash dumps
            header: sc,
        };
        if (!o.whole && durationS < o.minFlightS) { yield { flight, skipped: `shorter than ${o.minFlightS} s` }; continue; }

        const frames = [], cuts = [], events = [];
        for (const c of log.getChunksInTimeRange(tMin, tMax)) {
            const base = frames.length;
            for (const k in c.gapStartsHere) cuts.push(base + (+k) + 1);
            for (const f of c.frames) frames.push(f);
            for (const e of c.events) events.push(e);
        }
        flight.frames = frames.length;
        flight.gaps = cuts.length;
        // frames per second as the log clock has them. The loop runs off the gyro's own clock, so this differs a
        // little from the nominal rate; frequencies read from the data are true only with this one.
        { const ends = [0, ...cuts.filter(v => v > 0 && v < frames.length), frames.length]; let a = 0, b = 0;
            for (let i = 0; i + 1 < ends.length; i++) if (ends[i + 1] - ends[i] > b - a) { a = ends[i]; b = ends[i + 1]; } // longest stretch without a gap
            flight.actualRate = b - a > 1 ? (b - a - 1) / ((frames[b - 1][1] - frames[a][1]) / 1e6) : rate; }

        const indexAt = (t) => { let lo = 0, hi = frames.length; while (lo < hi) { const m = (lo + hi) >> 1; if (frames[m][1] < t) lo = m + 1; else hi = m; } return lo; };
        const sawAirborne = events.some(e => e.event === EVENT.AIRBORNE_STATE);
        const changes = [];
        for (const e of events) {
            const at = indexAt(e.time === undefined ? tMax : e.time);
            if (e.event === EVENT.INFLIGHT_ADJUSTMENT && e.data && e.data.func === 2) changes.push({ at, profile: e.data.value });
            else if (e.event === EVENT.AIRBORNE_STATE) changes.push({ at, airborne: e.data.airborneState === 1 });
            else if (e.event === EVENT.GOVERNOR_STATE && e.data) changes.push({ at, gov: e.data.govState });
            else if (e.event === EVENT.RESCUE_STATE && e.data) changes.push({ at, rescue: e.data.rescueState !== 0 });
        }
        const sawGov = events.some(e => e.event === EVENT.GOVERNOR_STATE);
        for (const at of cuts) changes.push({ at, cut: true });
        changes.sort((a, b) => a.at - b.at);
        changes.push({ at: frames.length, cut: true });

        const ix = (n) => log.getMainFieldIndexByName(n), tri = (n) => [0, 1, 2].map(a => ix(`${n}[${a}]`));
        const I = { sp: tri('setpoint'), gyro: tri('gyroADC'), u: tri('mixer'), P: tri('axisP'), I: tri('axisI'), D: tri('axisD'),
            F: tri('axisF'), B: tri('axisB'), hs: ix('headspeed'), coll: ix('setpoint[3]') };
        const needed = [...I.sp, ...I.gyro, ...I.u, ...I.P, ...I.I, ...I.D, ...I.F, I.hs];
        if (needed.some(v => v === undefined)) { yield { flight, skipped: 'log lacks setpoint, gyro, mixer, PID or headspeed fields' }; continue; }

        if (o.whole) {
            const profileAt = new Uint8Array(frames.length), airborneAt = new Uint8Array(frames.length), govAt = sawGov ? new Uint8Array(frames.length) : null, rescueAt = new Uint8Array(frames.length);
            let p = 0, air = sawAirborne ? 0 : 1, g = 0, rs = 0, c = 0; // governor state 0 (OFF) until its first event
            for (let i = 0; i < frames.length; i++) {
                for (; c < changes.length && changes[c].at <= i; c++) { if (changes[c].profile !== undefined) p = changes[c].profile; if (changes[c].airborne !== undefined) air = changes[c].airborne ? 1 : 0; if (changes[c].gov !== undefined) g = changes[c].gov; if (changes[c].rescue !== undefined) rs = changes[c].rescue ? 1 : 0; }
                profileAt[i] = p; airborneAt[i] = air; if (govAt) govAt[i] = g; rescueAt[i] = rs;
            }
            const bounds = [0, ...cuts.filter(v => v > 0 && v < frames.length), frames.length];
            for (let b = 0; b + 1 < bounds.length; b++) {
                const i0 = bounds[b], n = bounds[b + 1] - i0; if (n < 2) continue;
                const col = (idx, k = 1) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = frames[i0 + i][idx] * k; return a; };
                const three = (idxs, k) => idxs.map(idx => idx === undefined ? null : col(idx, k));
                yield { flight, whole: true, fromS: (frames[i0][1] - tMin) / 1e6, seconds: n / rate, rate, n, profileAt: profileAt.subarray(i0, i0 + n), airborneAt: airborneAt.subarray(i0, i0 + n),
                    govStateAt: govAt ? govAt.subarray(i0, i0 + n) : null, rescueAt: rescueAt.subarray(i0, i0 + n),
                    sp: three(I.sp), gyro: three(I.gyro), u: three(I.u, 1e-3), P: three(I.P, 1e-3), I: three(I.I, 1e-3), D: three(I.D, 1e-3), F: three(I.F, 1e-3), B: three(I.B, 1e-3),
                    hs: col(I.hs), coll: I.coll === undefined ? null : col(I.coll), extra: Object.fromEntries(o.extra.map(name => [name, ix(name) === undefined ? null : col(ix(name))])) };
            }
            continue;
        }

        let from = 0, profile = 'arm', airborne = !sawAirborne, rescue = false, produced = 0;
        for (const ch of changes) {
            if (airborne && !rescue && ch.at > from) {
                let i0 = from, i1 = ch.at;
                const hsSorted = []; for (let i = i0; i < i1; i += 10) hsSorted.push(frames[i][I.hs]);
                hsSorted.sort((a, b) => a - b);
                const median = hsSorted[hsSorted.length >> 1] || 0, floor = o.spoolFraction * median;
                while (i0 < i1 && frames[i0][I.hs] < floor) i0++;
                while (i1 > i0 && frames[i1 - 1][I.hs] < floor) i1--;
                const n = i1 - i0;
                if (median >= o.minHeadspeed && n / rate >= o.minSegmentS) {
                    const col = (idx, k = 1) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = frames[i0 + i][idx] * k; return a; };
                    const three = (idxs, k) => idxs.map(idx => idx === undefined ? null : col(idx, k));
                    produced++;
                    yield { flight, profile, fromS: (frames[i0][1] - tMin) / 1e6, seconds: n / rate, rate, n,
                        headspeed: { median, p05: hsSorted[Math.floor(hsSorted.length * 0.05)], p95: hsSorted[Math.floor(hsSorted.length * 0.95)] },
                        sp: three(I.sp), gyro: three(I.gyro), u: three(I.u, 1e-3),
                        P: three(I.P, 1e-3), I: three(I.I, 1e-3), D: three(I.D, 1e-3), F: three(I.F, 1e-3), B: three(I.B, 1e-3),
                        hs: col(I.hs), coll: I.coll === undefined ? null : col(I.coll),
                        extra: Object.fromEntries(o.extra.map(name => [name, ix(name) === undefined ? null : col(ix(name))])) };
                }
            }
            if (ch.profile !== undefined) profile = ch.profile;
            if (ch.airborne !== undefined) airborne = ch.airborne;
            if (ch.rescue !== undefined) rescue = ch.rescue;
            from = ch.at;
        }
        if (!produced) yield { flight, skipped: `no airborne, spooled-up stretch of ${o.minSegmentS} s on one profile` };
    }
}

// The analysis segments of a whole log (see `whole`): airborne, one PID profile, headspeed settled, minSegmentS
// or longer. Columns are views into the whole log, so nothing is copied.
function* steadySegments(w, options = {}) {
    const o = Object.assign({}, DEFAULTS, options), cut = (v) => v.subarray(i0, i1), rescue = (i) => w.rescueAt ? w.rescueAt[i] : 0; let i0 = 0, i1 = 0;
    for (let a = 0; a < w.n; a = i1) {
        i1 = a + 1; while (i1 < w.n && w.profileAt[i1] === w.profileAt[a] && w.airborneAt[i1] === w.airborneAt[a] && rescue(i1) === rescue(a)) i1++;
        const end = i1; i0 = a;
        if (!w.airborneAt[a] || rescue(a)) continue;
        const sorted = []; for (let i = i0; i < i1; i += 10) sorted.push(w.hs[i]);
        sorted.sort((p, q) => p - q);
        const median = sorted[sorted.length >> 1] || 0, floor = o.spoolFraction * median;
        while (i0 < i1 && w.hs[i0] < floor) i0++;
        while (i1 > i0 && w.hs[i1 - 1] < floor) i1--;
        const n = i1 - i0;
        if (median >= o.minHeadspeed && n / w.rate >= o.minSegmentS) {
            const three = (list) => list.map(v => v ? cut(v) : null);
            yield { flight: w.flight, profile: w.profileAt[a] || 'arm', fromS: w.fromS + i0 / w.rate, seconds: n / w.rate, rate: w.rate, n, i0, i1,
                headspeed: { median, p05: sorted[Math.floor(sorted.length * 0.05)], p95: sorted[Math.floor(sorted.length * 0.95)] },
                sp: three(w.sp), gyro: three(w.gyro), u: three(w.u), P: three(w.P), I: three(w.I), D: three(w.D), F: three(w.F), B: three(w.B),
                hs: cut(w.hs), coll: w.coll ? cut(w.coll) : null, extra: Object.fromEntries(Object.entries(w.extra).map(([k, v]) => [k, v ? cut(v) : null])) };
        }
        i1 = end;
    }
}

// PID profile per sample of a whole log (see `whole`). Before the first switch the log does not say which profile is
// active; it is the one that the same log later flies at the same governor target, if there is one.
// Returns the profile per sample and the governor target of each profile.
function profilesOf(w, target, minHeadspeed = FLIGHT_RPM) {
    const p = Uint8Array.from(w.profileAt), round = (v) => Math.round(v / 50) * 50, seen = new Map(), count = new Map();
    let first = p.findIndex(v => v > 0); if (first < 0) first = w.n;
    for (let i = first; i < w.n; i += 20) if (Math.abs(target[i] - w.hs[i]) < 150 && w.hs[i] > minHeadspeed) { const k = p[i] + '|' + round(target[i]); seen.set(k, (seen.get(k) || 0) + 1); }
    const targetOf = {}; for (const [k] of [...seen.entries()].sort((a, b) => a[1] - b[1])) targetOf[k.split('|')[0]] = +k.split('|')[1];
    let t0 = null; for (let i = 0; i < first; i += 20) if (w.hs[i] > minHeadspeed && Math.abs(target[i] - w.hs[i]) < 150) { const v = round(target[i]); count.set(v, (count.get(v) || 0) + 1); if (t0 === null || count.get(v) > count.get(t0)) t0 = v; }
    const p0 = +(Object.keys(targetOf).find(k => targetOf[k] === t0) || 0);
    for (let i = 0; i < first; i++) p[i] = p0;
    if (p0 === 0 && t0 !== null) targetOf[0] = t0;
    return { p, targetOf };
}

// ---------------------------------------------------------------------------------------------
// Rotor orders
// ---------------------------------------------------------------------------------------------

// Signals resampled at equal steps of rotor angle (perRev samples per revolution of the logged headspeed), so that
// whatever turns with the rotor becomes a sharp line at a fixed order, whatever the headspeed does.
function byRevolution(hs, rate, columns, perRev) {
    const n = hs.length, rev = new Float64Array(n); for (let i = 1; i < n; i++) rev[i] = rev[i - 1] + hs[i] / 60 / rate;
    const M = Math.floor(rev[n - 1] * perRev), at = new Float64Array(M), frac = new Float64Array(M); let j = 0;
    for (let k = 0; k < M; k++) { const r = k / perRev; while (j < n - 2 && rev[j + 1] < r) j++; at[k] = j; frac[k] = (r - rev[j]) / (rev[j + 1] - rev[j] || 1); }
    return { M, index: at, columns: columns.map(x => Float64Array.from(at, (i, k) => x[i] + frac[k] * (x[i + 1] - x[i]))) };
}

// position and size of the largest value of p between two bins, refined by a parabola through its neighbours
function spectralPeak(p, k0, k1) {
    let b = k0; for (let k = k0; k <= k1; k++) if (p[k] > p[b]) b = k;
    const A = Math.log(p[b - 1] || 1e-300), B = Math.log(p[b] || 1e-300), C = Math.log(p[b + 1] || 1e-300), d = A - 2 * B + C;
    return { bin: b + (d ? 0.5 * (A - C) / d : 0), power: p[b] };
}

// ---------------------------------------------------------------------------------------------
// Firmware filters
// ---------------------------------------------------------------------------------------------

function lpf1(x, fc, rate) { // firstOrderLPF
    const W = Math.tan(Math.PI * fc / rate), a1 = (W - 1) / (W + 1), b0 = W / (W + 1);
    const y = new Float64Array(x.length); let x1 = x[0], y1 = x[0];
    for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b0 * x1 - a1 * y1; x1 = x[i]; y1 = v; y[i] = v; }
    return y;
}

function dif(x, fc, rate) { // difFilter: band-limited differentiator
    const W = Math.tan(Math.PI * fc / rate), a = (W - 1) / (W + 1), b = 2 * rate * W / (W + 1);
    const y = new Float64Array(x.length); let x1 = x[0], y1 = 0;
    for (let i = 0; i < x.length; i++) { const v = b * (x[i] - x1) - a * y1; x1 = x[i]; y1 = v; y[i] = v; }
    return y;
}

function pt1(x, fc, rate) { // pt1Filter
    const k = 1 / (rate / (2 * Math.PI * fc) + 1), y = new Float64Array(x.length); let y1 = x[0];
    for (let i = 0; i < x.length; i++) { y1 += k * (x[i] - y1); y[i] = y1; }
    return y;
}

// I-term relax (pid.c applyItermRelax): the error fed to the integrator is scaled by
// max(0, 1 - |setpoint - pt1(setpoint, cutoff)| / level), so the I term stops charging while the stick moves.
function relaxFactor(sp, level, cutoff, rate) {
    const lp = pt1(sp, cutoff, rate), f = new Float64Array(sp.length);
    for (let i = 0; i < sp.length; i++) f[i] = Math.max(0, 1 - Math.abs(sp[i] - lp[i]) / level);
    return f;
}

// complex numbers as [re, im]
const cx = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1]], sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
    mul: (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]],
    div: (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; },
    scale: (a, k) => [a[0] * k, a[1] * k], abs: (a) => Math.hypot(a[0], a[1]), arg: (a) => Math.atan2(a[1], a[0]),
    expj: (ph) => [Math.cos(ph), Math.sin(ph)], conj: (a) => [a[0], -a[1]],
};

function lpf1Response(f, fc, rate) {
    if (!fc) return [1, 0];
    const W = Math.tan(Math.PI * fc / rate), a1 = (W - 1) / (W + 1), b0 = W / (W + 1), z = cx.expj(-2 * Math.PI * f / rate);
    return cx.div(cx.scale(cx.add([1, 0], z), b0), cx.add([1, 0], cx.scale(z, a1)));
}

function difResponse(f, fc, rate) {
    const W = Math.tan(Math.PI * fc / rate), a = (W - 1) / (W + 1), b = 2 * rate * W / (W + 1), z = cx.expj(-2 * Math.PI * f / rate);
    return cx.div(cx.scale(cx.sub([1, 0], z), b), cx.add([1, 0], cx.scale(z, a)));
}

// ---------------------------------------------------------------------------------------------
// Gain recovery
// ---------------------------------------------------------------------------------------------

// ordinary least squares y = X beta by normal equations; rows of X are observations
function solve(X, y) {
    const n = X.length, k = X[0].length, M = Array.from({ length: k }, (_, i) => Array.from({ length: 2 * k + 1 }, (_, j) => j === k + i ? 1 : 0));
    for (let i = 0; i < n; i++) { const x = X[i]; for (let p = 0; p < k; p++) { for (let q = 0; q < k; q++) M[p][q] += x[p] * x[q]; M[p][2 * k] += x[p] * y[i]; } }
    for (let c = 0; c < k; c++) {
        let piv = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        if (Math.abs(M[piv][c]) < 1e-300) return null;
        [M[c], M[piv]] = [M[piv], M[c]];
        const d = M[c][c]; for (let j = 0; j < M[c].length; j++) M[c][j] /= d;
        for (let r = 0; r < k; r++) if (r !== c) { const f = M[r][c]; if (f) for (let j = 0; j < M[r].length; j++) M[r][j] -= f * M[c][j]; }
    }
    const beta = M.map(r => r[2 * k]); let sse = 0, sst = 0, ym = 0;
    for (let i = 0; i < n; i++) ym += y[i]; ym /= n;
    for (let i = 0; i < n; i++) { let fit = 0; for (let j = 0; j < k; j++) fit += X[i][j] * beta[j]; sse += (y[i] - fit) ** 2; sst += (y[i] - ym) ** 2; }
    const s2 = sse / Math.max(1, n - k);
    return { beta, se: M.map((r, i) => Math.sqrt(Math.max(0, s2 * r[k + i]))), r2: 1 - sse / sst, n, dof: n - k };
}

// least squares through the origin, y = k x, over an optional index subset
function fitLine(x, y, sel) {
    let sxy = 0, sxx = 0, syy = 0, n = 0;
    const take = (i) => { sxy += x[i] * y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; n++; };
    if (sel) for (const i of sel) take(i); else for (let i = 0; i < x.length; i++) take(i);
    if (!sxx || !syy || n < 3) return null;
    const k = sxy / sxx, sse = Math.max(0, syy - k * sxy);
    // samples are strongly autocorrelated, so this standard error is a lower bound
    return { k, r2: 1 - sse / syy, se: Math.sqrt(sse / (n - 1) / sxx), n };
}

// The filter cutoffs are part of the PID profile too, so search the cutoff that explains the logged term best.
function bestCutoff(make, y, sel) {
    let top = null;
    const tryFc = (fc) => { const f = fitLine(make(fc), y, sel); if (f && (!top || f.r2 > top.r2)) top = Object.assign(f, { fc }); };
    for (let fc = 10; fc <= 250; fc += 5) tryFc(fc);
    if (top) { const c = top.fc; for (let fc = Math.max(5, c - 4); fc <= c + 4; fc++) if (fc !== c) tryFc(fc); }
    return top;
}

/**
 * Firmware control law, PID mode 3 (pid.c):
 *   F = Kf * setpoint                       B = Kb * dif(setpoint, b_cutoff)
 *   P = Kp * (setpoint - gyroF) [* stop]    D = Kd * dif(-gyroF, d_cutoff)       gyroF = lpf1(gyro, gyro_cutoff)
 *   dI/dt = Ki * (setpoint - gyroF) - decay * I      (while I-term relax is inactive)
 * Yaw P carries the stop gain, chosen by the sign of the error, so yaw reports P x stop per direction.
 */
function recoverGains(seg, a) {
    const { rate } = seg, sp = seg.sp[a], g = seg.gyro[a], n = sp.length, out = {};
    const gain = (f, scale, extra) => f && Object.assign({ gain: f.k / scale, r2: f.r2 }, extra);

    out.F = gain(fitLine(sp, seg.F[a]), SCALE.F[a]);
    if (a === 2 && seg.coll) {
        // The logged yaw F also carries the collective and cyclic precompensation, which follows collective
        // deflection, not the yaw stick. Regress it out to expose the part that follows the yaw setpoint.
        const X = [], y = seg.F[a];
        for (let i = 0; i < n; i++) { const c = Math.abs(seg.coll[i]) / 1000; X.push([sp[i], c, c * c, 1]); }
        const m = solve(X, y);
        if (m) out.F = { gain: m.beta[0] / SCALE.F[a], se: m.se[0] / SCALE.F[a], r2: m.r2, precompRegressedOut: true };
    }

    const errWith = (fc) => { const gf = lpf1(g, fc, rate), e = new Float64Array(n); for (let i = 0; i < n; i++) e[i] = sp[i] - gf[i]; return e; };
    let gyroCut = a === 2 ? 200 : 80;
    if (a < 2) {
        const f = bestCutoff(errWith, seg.P[a]);
        if (f) { out.P = gain(f, SCALE.P[a], { gyroCutoff: f.fc }); gyroCut = f.fc; }
    } else {
        const sides = { cw: [], ccw: [] };
        for (let i = 0; i < n; i++) { const e = sp[i] - g[i]; if (e > 15) sides.cw.push(i); else if (e < -15) sides.ccw.push(i); }
        for (const side of ['cw', 'ccw']) {
            if (sides[side].length < 500) continue;
            const f = bestCutoff(errWith, seg.P[a], sides[side]);
            if (f) { out['P_' + side] = gain(f, SCALE.P[a], { gyroCutoff: f.fc }); gyroCut = f.fc; }
        }
    }
    out.gyroCutoff = gyroCut;

    const gf = lpf1(g, gyroCut, rate), neg = new Float64Array(n);
    for (let i = 0; i < n; i++) neg[i] = -gf[i];
    // D gain 0 logs a D term that is exactly zero: nothing to fit, the gain is known
    const fD = seg.D[a].some(v => v !== 0) ? bestCutoff((fc) => dif(neg, fc, rate), seg.D[a]) : null;
    out.D = fD ? gain(fD, SCALE.D[a], { cutoff: fD.fc }) : seg.D[a].some(v => v !== 0) ? null : { gain: 0, r2: 1, cutoff: null };

    if (seg.B[a]) {
        const fB = bestCutoff((fc) => dif(sp, fc, rate), seg.B[a]);
        out.B = gain(fB, SCALE.B[a], fB && { cutoff: fB.fc });
    }

    // I: dI/dt = Ki * relax(t) * (setpoint - gyroF) - decay * I. Relax level and cutoff belong to the profile and
    // are not logged, so they are searched too: the pair that best explains the change of the logged I term
    // over 100 ms spans wins. level = Infinity means relax is off.
    const span = Math.round(0.1 * rate), I = seg.I[a], nS = Math.floor((n - 1) / span), err = new Float64Array(n);
    for (let i = 0; i < n; i++) err[i] = sp[i] - gf[i];
    if (nS > 50) {
        const y = new Float64Array(nS), x2 = new Float64Array(nS), x1 = new Float64Array(nS);
        for (let k = 0; k < nS; k++) { let m = 0; for (let i = k * span; i < (k + 1) * span; i++) m += I[i]; x2[k] = -m / rate; y[k] = I[(k + 1) * span] - I[k * span]; }
        let syy = 0, s22 = 0, s2y = 0; for (let k = 0; k < nS; k++) { syy += y[k] * y[k]; s22 += x2[k] * x2[k]; s2y += x2[k] * y[k]; }
        let best = null;
        const tryPair = (level, cutoff, hp) => {
            let s11 = 0, s12 = 0, s1y = 0;
            for (let k = 0; k < nS; k++) { let e = 0; for (let i = k * span; i < (k + 1) * span; i++) e += hp ? Math.max(0, 1 - hp[i] / level) * err[i] : err[i]; x1[k] = e / rate; s11 += x1[k] * x1[k]; s12 += x1[k] * x2[k]; s1y += x1[k] * y[k]; }
            const det = s11 * s22 - s12 * s12; if (!(det > 0)) return;
            const ki = (s1y * s22 - s2y * s12) / det, decay = (s2y * s11 - s1y * s12) / det, r2 = 1 - (syy - ki * s1y - decay * s2y) / syy;
            if (!best || r2 > best.r2) best = { gain: ki / SCALE.I[a], decayPerS: Math.max(0, decay), r2, relaxLevel: level, relaxCutoff: cutoff };
        };
        tryPair(Infinity, null, null);
        for (let cutoff = 6; cutoff <= 30; cutoff += 2) {
            const lp = pt1(sp, cutoff, rate), hp = new Float64Array(n); for (let i = 0; i < n; i++) hp[i] = Math.abs(sp[i] - lp[i]);
            for (let level = 10; level <= 100; level += 5) tryPair(level, cutoff, hp);
        }
        if (best) { best.spans = nS; if (!isFinite(best.relaxLevel)) best.relaxLevel = null; out.I = best; }
    }
    // what the integrator saw, for the effective frequency response of relax (see segmentSpectra)
    const fac = out.I && out.I.relaxLevel ? relaxFactor(sp, out.I.relaxLevel, out.I.relaxCutoff, rate) : null, relaxed = new Float64Array(n);
    for (let i = 0; i < n; i++) relaxed[i] = fac ? fac[i] * err[i] : err[i];
    Object.defineProperty(out, 'integratorInput', { value: { error: err, relaxed }, enumerable: false });
    return out;
}

// ---------------------------------------------------------------------------------------------
// Spectra
// ---------------------------------------------------------------------------------------------

let hann = null, fftCache = null;
function fftFor(app, N) {
    if (!fftCache || fftCache.N !== N) {
        hann = new Float64Array(N);
        for (let i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
        fftCache = { N, fft: new app.FFT.complex(N, false), win: hann, power: hann.reduce((s, v) => s + v * v, 0) };
    }
    return fftCache;
}

/**
 * Welch cross-spectra of one axis of one segment: setpoint r, control u, gyro y, tracking error e = r - y.
 * All spectra are one-sided PSDs, (unit)^2 per Hz, summed over windows.
 */
function segmentSpectra(app, seg, a, integratorInput) {
    const { N, bins } = SPEC, { fft, win, power } = fftFor(app, N), hop = N / 2;
    const r = seg.sp[a], u = seg.u[a], y = seg.gyro[a];
    const z = () => new Float64Array(bins + 1);
    // k: error offered to the integrator, q: the same after I-term relax. Sq/Sk is the linear response of relax.
    const kIn = integratorInput ? integratorInput.error : null, qIn = integratorInput ? integratorInput.relaxed : null;
    const S = { windows: 0, rr: z(), yy: z(), uu: z(), ee: z(), ryRe: z(), ryIm: z(), ruRe: z(), ruIm: z(), kk: z(), kqRe: z(), kqIm: z() };
    const K = new Float64Array(2 * N), Q = new Float64Array(2 * N), bk = new Float64Array(N), bq = new Float64Array(N);
    const R = new Float64Array(2 * N), U = new Float64Array(2 * N), Y = new Float64Array(2 * N);
    const br = new Float64Array(N), bu = new Float64Array(N), by = new Float64Array(N);
    const norm = 2 / (seg.rate * power);
    for (let s = 0; s + N <= r.length; s += hop) {
        let mr = 0, mu = 0, my = 0;
        for (let i = 0; i < N; i++) { mr += r[s + i]; mu += u[s + i]; my += y[s + i]; }
        mr /= N; mu /= N; my /= N;
        for (let i = 0; i < N; i++) { br[i] = (r[s + i] - mr) * win[i]; bu[i] = (u[s + i] - mu) * win[i]; by[i] = (y[s + i] - my) * win[i]; }
        fft.simple(R, br, 'real'); fft.simple(U, bu, 'real'); fft.simple(Y, by, 'real');
        if (kIn) {
            let mk = 0, mq = 0; for (let i = 0; i < N; i++) { mk += kIn[s + i]; mq += qIn[s + i]; }
            mk /= N; mq /= N;
            for (let i = 0; i < N; i++) { bk[i] = (kIn[s + i] - mk) * win[i]; bq[i] = (qIn[s + i] - mq) * win[i]; }
            fft.simple(K, bk, 'real'); fft.simple(Q, bq, 'real');
        }
        for (let k = 0; k <= bins; k++) {
            const rr = R[2 * k], ri = R[2 * k + 1], ur = U[2 * k], ui = U[2 * k + 1], yr = Y[2 * k], yi = Y[2 * k + 1];
            if (kIn) { const kr = K[2 * k], ki = K[2 * k + 1], qr = Q[2 * k], qi = Q[2 * k + 1];
                S.kk[k] += (kr * kr + ki * ki) * norm; S.kqRe[k] += (kr * qr + ki * qi) * norm; S.kqIm[k] += (kr * qi - ki * qr) * norm; }
            S.rr[k] += (rr * rr + ri * ri) * norm; S.yy[k] += (yr * yr + yi * yi) * norm; S.uu[k] += (ur * ur + ui * ui) * norm;
            S.ee[k] += ((rr - yr) ** 2 + (ri - yi) ** 2) * norm;
            S.ryRe[k] += (rr * yr + ri * yi) * norm; S.ryIm[k] += (rr * yi - ri * yr) * norm; // conj(R) Y
            S.ruRe[k] += (rr * ur + ri * ui) * norm; S.ruIm[k] += (rr * ui - ri * ur) * norm; // conj(R) U
        }
        S.windows++;
    }
    return S;
}

const SUM_KEYS = ['rr', 'yy', 'uu', 'ee', 'ryRe', 'ryIm', 'ruRe', 'ruIm', 'kk', 'kqRe', 'kqIm'];

function sumSpectra(list) {
    const T = { windows: 0 };
    for (const k of SUM_KEYS) T[k] = new Float64Array(SPEC.bins + 1);
    for (const S of list) {
        T.windows += S.windows;
        for (const k of SUM_KEYS) for (let i = 0; i <= SPEC.bins; i++) T[k][i] += S[k][i];
    }
    return T;
}

function estimates(S, k) {
    const ry = [S.ryRe[k], S.ryIm[k]], ru = [S.ruRe[k], S.ruIm[k]];
    return {
        T: cx.scale(ry, 1 / S.rr[k]),   // closed loop, setpoint -> gyro
        U: cx.scale(ru, 1 / S.rr[k]),   // setpoint -> control
        G: cx.div(ry, ru),              // plant, with the setpoint as instrument
        cohRY: (ry[0] ** 2 + ry[1] ** 2) / (S.rr[k] * S.yy[k]),
        cohRU: (ru[0] ** 2 + ru[1] ** 2) / (S.rr[k] * S.uu[k]),
        relax: S.kk[k] > 0 ? [S.kqRe[k] / S.kk[k], S.kqIm[k] / S.kk[k]] : [1, 0], // effective response of I-term relax
    };
}

/**
 * Pool segment spectra and attach leave-one-flight-out standard errors.
 * items: [{ flight: id, spectra }]. Returns rows per frequency bin.
 * seLog is the standard error of ln|H|, sePhase of arg H in radians; sigma combines both and is the
 * relative standard error of the complex value.
 */
function pool(items) {
    const byFlight = new Map();
    for (const it of items) { if (!byFlight.has(it.flight)) byFlight.set(it.flight, []); byFlight.get(it.flight).push(it.spectra); }
    const kept = [...byFlight.entries()].map(([id, list]) => ({ id, S: sumSpectra(list) })).filter(o => o.S.windows > 0);
    const perFlight = kept.map(o => o.S), flightIds = kept.map(o => o.id);
    const total = sumSpectra(perFlight), n = perFlight.length, rows = [];
    const leaveOut = perFlight.map((S) => { const L = { windows: total.windows - S.windows };
        for (const k of SUM_KEYS) { L[k] = new Float64Array(SPEC.bins + 1); for (let i = 0; i <= SPEC.bins; i++) L[k][i] = total[k][i] - S[k][i]; } return L; });
    const df = 1 / (SPEC.N / 1000);
    for (let k = 1; k <= SPEC.bins; k++) {
        const e = estimates(total, k), row = { f: k * df, T: e.T, U: e.U, G: e.G, cohRY: e.cohRY, cohRU: e.cohRU, relax: e.relax,
            rr: total.rr[k] / total.windows, yy: total.yy[k] / total.windows, ee: total.ee[k] / total.windows, uu: total.uu[k] / total.windows };
        for (const name of ['T', 'G', 'U']) {
            if (n < 3) { row[name + 'se'] = null; continue; }
            let sl = 0, sp = 0;
            for (const L of leaveOut) {
                const v = estimates(L, k)[name], ratio = cx.div(v, e[name]);
                sl += Math.log(cx.abs(ratio)) ** 2; sp += cx.arg(ratio) ** 2;
            }
            const seLog = Math.sqrt((n - 1) / n * sl), sePhase = Math.sqrt((n - 1) / n * sp);
            row[name + 'se'] = { seLog, sePhase, sigma: Math.hypot(seLog, sePhase) };
        }
        rows.push(row);
    }
    return { rows, flights: n, flightIds, windows: total.windows, leaveOut, total };
}

function rowsOf(S) { // frequency-response rows of a (leave-one-out) spectra sum, without uncertainty
    const rows = [], df = 1 / (SPEC.N / 1000);
    for (let k = 1; k <= SPEC.bins; k++) {
        const e = estimates(S, k);
        rows.push({ f: k * df, T: e.T, G: e.G, U: e.U, cohRY: e.cohRY, cohRU: e.cohRU, relax: e.relax, rr: S.rr[k] / S.windows, yy: S.yy[k] / S.windows, ee: S.ee[k] / S.windows });
    }
    return rows;
}

// RMS of a one-sided PSD over a band
function bandRms(rows, key, f0, f1) {
    let s = 0; const df = rows[1].f - rows[0].f;
    for (const r of rows) if (r.f >= f0 && r.f <= f1) s += r[key] * df;
    return Math.sqrt(s);
}

// Strongest narrow line of a signal between f0 and f1, at 0.125 Hz resolution: the largest bin that is a local
// maximum over +-0.5 Hz and at least 1 Hz inside the band. prominence is its amplitude over the band median.
// A broad resonance can pass as a line here; whether lines are rotor-locked is decided across segments.
function spectralLine(app, x, rate, f0, f1) {
    const N = 8000;
    if (x.length < 2 * N) return null;
    const { fft, win } = fftFor(app, N), acc = new Float64Array(N / 2), buf = new Float64Array(N), out = new Float64Array(2 * N);
    let count = 0;
    for (let s = 0; s + N <= x.length; s += N / 2) {
        let m = 0; for (let i = 0; i < N; i++) m += x[s + i]; m /= N;
        for (let i = 0; i < N; i++) buf[i] = (x[s + i] - m) * win[i];
        fft.simple(out, buf, 'real');
        for (let k = 0; k < N / 2; k++) acc[k] += out[2 * k] ** 2 + out[2 * k + 1] ** 2;
        count++;
    }
    const df = rate / N, k0 = Math.round(f0 / df), k1 = Math.round(f1 / df), edge = Math.round(1 / df), local = Math.round(0.5 / df), band = [];
    let best = -1;
    for (let k = k0; k <= k1; k++) {
        band.push(acc[k]);
        if (k < k0 + edge || k > k1 - edge) continue;
        let top = true; for (let j = k - local; j <= k + local && top; j++) if (acc[j] > acc[k]) top = false;
        if (top && (best < 0 || acc[k] > acc[best])) best = k;
    }
    if (best < 0) return null;
    band.sort((p, q) => p - q);
    // amplitude of a sinusoid that would produce this peak (Hann coherent gain 0.5)
    return { hz: best * df, amplitude: Math.sqrt(acc[best] / count) / (N / 4), prominence: Math.sqrt(acc[best] / band[band.length >> 1]), windows: count };
}

// ---------------------------------------------------------------------------------------------
// Oscillation bursts in the time domain
// ---------------------------------------------------------------------------------------------

// Second-order Butterworth section run forward and backward: zero phase, fourth-order magnitude
function biquad(x, fc, rate, highpass) {
    const k = Math.tan(Math.PI * fc / rate), q = Math.SQRT1_2, n = 1 / (1 + k / q + k * k);
    const b0 = highpass ? n : k * k * n, b1 = highpass ? -2 * n : 2 * k * k * n, b2 = b0, a1 = 2 * (k * k - 1) * n, a2 = (1 - k / q + k * k) * n;
    const pass = (u, reverse) => { const y = new Float64Array(u.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        const first = reverse ? u[u.length - 1] : u[0]; if (!highpass) { x1 = x2 = y1 = y2 = first; } else { x1 = x2 = first; }
        for (let j = 0; j < u.length; j++) { const i = reverse ? u.length - 1 - j : j, v = b0 * u[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = u[i]; y2 = y1; y1 = v; y[i] = v; }
        return y; };
    return pass(pass(x, false), true);
}
const bandpass = (x, lo, hi, rate) => biquad(biquad(x, lo, rate, true), hi, rate, false);

/**
 * Sustained oscillation in a signal. After band-passing, the signal is cut at its zero crossings into half
 * cycles. A burst is a run of at least minHalfCycles consecutive half cycles that each reach minAmplitude and
 * whose durations stay within `regular` of their neighbour, which rejects single transients and stick
 * movements. Returns bursts with frequency, amplitude and the per-cycle growth rate.
 */
const BURST = { band: [3, 40], minAmplitude: 5, minHalfCycles: 6, regular: 1.5, freq: [4, 30] };

function oscillationBursts(x, rate, options = {}) {
    const o = Object.assign({}, BURST, options), y = bandpass(x, o.band[0], o.band[1], rate), half = [];
    let start = 0, peak = 0, peakAt = 0;
    for (let i = 1; i < y.length; i++) {
        if (Math.abs(y[i]) > peak) { peak = Math.abs(y[i]); peakAt = i; }
        if ((y[i - 1] < 0) !== (y[i] < 0)) {
            const t = i - 1 + y[i - 1] / (y[i - 1] - y[i]); // interpolated crossing
            half.push({ t0: start, t1: t, peak, peakAt, sign: y[i - 1] < 0 ? -1 : 1 });
            start = t; peak = 0;
        }
    }
    const ok = (h) => { const f = rate / (2 * (h.t1 - h.t0)); return h.peak >= o.minAmplitude && f >= o.freq[0] && f <= o.freq[1]; };
    const bursts = [];
    for (let i = 0; i < half.length;) {
        if (!ok(half[i])) { i++; continue; }
        let j = i;
        while (j + 1 < half.length && ok(half[j + 1])) { const r = (half[j + 1].t1 - half[j + 1].t0) / (half[j].t1 - half[j].t0); if (r > o.regular || r < 1 / o.regular) break; j++; }
        const n = j - i + 1;
        if (n >= o.minHalfCycles) {
            const run = half.slice(i, j + 1), dur = (run[n - 1].t1 - run[0].t0) / rate, peaks = run.map(h => h.peak).sort((a, b) => a - b);
            bursts.push({ start: run[0].t0 / rate, seconds: dur, hz: n / (2 * dur), cycles: n / 2, amplitude: peaks[n >> 1], peak: peaks[n - 1],
                i0: Math.floor(run[0].t0), i1: Math.ceil(run[n - 1].t1), peaks: run.map(h => [h.peakAt / rate, h.peak]) });
        }
        i = j + 1;
    }
    // one disturbed cycle should not split a burst: join neighbours of like frequency less than 1.5 periods apart
    const joined = [];
    for (const b of bursts) {
        const a = joined[joined.length - 1];
        if (a && b.start - (a.start + a.seconds) < 1.5 / a.hz && Math.abs(b.hz / a.hz - 1) < 0.25) {
            const end = b.start + b.seconds, cycles = a.cycles + b.cycles + (b.start - a.start - a.seconds) * a.hz;
            const all = a.peaks.concat(b.peaks), sorted = all.map(p => p[1]).sort((u, v) => u - v);
            Object.assign(a, { seconds: end - a.start, cycles, hz: cycles / (end - a.start), amplitude: sorted[sorted.length >> 1], peak: sorted[sorted.length - 1], i1: b.i1, peaks: all });
        } else joined.push(Object.assign({}, b));
    }
    for (const b of joined) {
        // growth per cycle: slope of ln(peak amplitude) against time counted in cycles
        let sx = 0, sy = 0, sxy = 0, sxx = 0; const m = b.peaks.length;
        for (const [t, v] of b.peaks) { const c = (t - b.start) * b.hz, l = Math.log(v); sx += c; sy += l; sxy += c * l; sxx += c * c; }
        b.growthPerCycle = Math.exp((m * sxy - sx * sy) / (m * sxx - sx * sx)) - 1;
        delete b.peaks;
    }
    return { bursts: joined, filtered: y };
}

// ---------------------------------------------------------------------------------------------
// Cross-axis check
// ---------------------------------------------------------------------------------------------

/**
 * In aerobatic flying the sticks move together, so the response of an axis to its own stick could be biased
 * by what the other sticks do at the same moment. This keeps the full cross-spectral matrix of the four
 * stick inputs (roll, pitch, yaw, collective) at 1 to 3 Hz, so the response can also be estimated with the
 * other three inputs held constant.
 */
const CROSS = { bins: [2, 3, 4, 5, 6] }; // 1, 1.5, 2, 2.5, 3 Hz

function crossAxisSpectra(app, seg) {
    const { N } = SPEC, { fft, win } = fftFor(app, N), ins = [seg.sp[0], seg.sp[1], seg.sp[2], seg.coll], outs = seg.gyro;
    if (!seg.coll) return null;
    const nb = CROSS.bins.length, X = ins.map(() => new Float64Array(2 * N)), Y = outs.map(() => new Float64Array(2 * N)), buf = new Float64Array(N);
    const S = { windows: 0, xx: new Float64Array(nb * 32), xy: new Float64Array(nb * 24) }; // [bin][4][4][re,im], [bin][3][4][re,im]
    const tf = (x, s, out) => { let m = 0; for (let i = 0; i < N; i++) m += x[s + i]; m /= N; for (let i = 0; i < N; i++) buf[i] = (x[s + i] - m) * win[i]; fft.simple(out, buf, 'real'); };
    for (let s = 0; s + N <= seg.n; s += N / 2) {
        ins.forEach((x, i) => tf(x, s, X[i])); outs.forEach((y, i) => tf(y, s, Y[i]));
        CROSS.bins.forEach((k, b) => {
            for (let p = 0; p < 4; p++) { const ar = X[p][2 * k], ai = X[p][2 * k + 1];
                for (let q = 0; q < 4; q++) { const br = X[q][2 * k], bi = X[q][2 * k + 1], at = b * 32 + (p * 4 + q) * 2; S.xx[at] += ar * br + ai * bi; S.xx[at + 1] += ar * bi - ai * br; }
                for (let o = 0; o < 3; o++) { const br = Y[o][2 * k], bi = Y[o][2 * k + 1], at = b * 24 + (o * 4 + p) * 2; S.xy[at] += ar * br + ai * bi; S.xy[at + 1] += ar * bi - ai * br; } }
        });
        S.windows++;
    }
    return S;
}

function sumCross(list) {
    const T = { windows: 0, xx: new Float64Array(list[0].xx.length), xy: new Float64Array(list[0].xy.length) };
    for (const S of list) { T.windows += S.windows; for (let i = 0; i < T.xx.length; i++) T.xx[i] += S.xx[i]; for (let i = 0; i < T.xy.length; i++) T.xy[i] += S.xy[i]; }
    return T;
}

// Closed-loop gain of axis `a` over 1 to 3 Hz: from its own stick alone, and with the other three inputs held constant
function crossAxisGain(T, a) {
    let alone = 0, held = 0, cohCollective = 0, cohStick = 0;
    CROSS.bins.forEach((k, b) => {
        const xx = (p, q) => [T.xx[b * 32 + (p * 4 + q) * 2], T.xx[b * 32 + (p * 4 + q) * 2 + 1]], xy = (p) => [T.xy[b * 24 + (a * 4 + p) * 2], T.xy[b * 24 + (a * 4 + p) * 2 + 1]];
        alone += cx.abs(xy(a)) / xx(a, a)[0];
        const M = [0, 1, 2, 3].map(p => [0, 1, 2, 3].map(q => xx(p, q)).concat([xy(p)]));
        for (let c = 0; c < 4; c++) { // complex Gauss-Jordan
            let piv = c; for (let r = c + 1; r < 4; r++) if (cx.abs(M[r][c]) > cx.abs(M[piv][c])) piv = r;
            [M[c], M[piv]] = [M[piv], M[c]];
            const d = M[c][c]; for (let j = 0; j <= 4; j++) M[c][j] = cx.div(M[c][j], d);
            for (let r = 0; r < 4; r++) if (r !== c) { const f = M[r][c]; for (let j = 0; j <= 4; j++) M[r][j] = cx.sub(M[r][j], cx.mul(f, M[c][j])); }
        }
        held += cx.abs(M[a][4]);
        const coh = (q) => (xx(a, q)[0] ** 2 + xx(a, q)[1] ** 2) / (xx(a, a)[0] * xx(q, q)[0]);
        cohCollective += coh(3); cohStick += Math.max(...[0, 1, 2].filter(q => q !== a).map(coh));
    });
    const n = CROSS.bins.length;
    return { alone: alone / n, held: held / n, cohCollective: cohCollective / n, cohStick: cohStick / n };
}

// ---------------------------------------------------------------------------------------------
// Plant models and fitting
// ---------------------------------------------------------------------------------------------

const MODELS = {
    // K wn^2 e^{-s tau} / (s^2 + 2 zeta wn s + wn^2): rate response with one resonant mode
    second: {
        params: ['fn', 'zeta', 'tau'],
        grid: () => { const g = []; for (let fn = 3; fn <= 30; fn += 1) for (let zeta = 0.05; zeta <= 1.6; zeta *= 1.35) for (let tau = 0; tau <= 0.04; tau += 0.004) g.push({ fn, zeta, tau }); return g; },
        bounds: { fn: [1, 40], zeta: [0.02, 3], tau: [0, 0.06] },
        shape: (p, f) => { const w = 2 * Math.PI * f, wn = 2 * Math.PI * p.fn; return cx.mul(cx.div([wn * wn, 0], [wn * wn - w * w, 2 * p.zeta * wn * w]), cx.expj(-w * p.tau)); },
    },
    // damped integrator times one resonant mode, for a tail whose drive or boom adds a resonance
    lagres: {
        params: ['a', 'fn', 'zeta', 'tau'],
        grid: () => { const g = []; for (let a = 0.5; a <= 100; a *= 2.2) for (let fn = 6; fn <= 30; fn += 2) for (let zeta = 0.08; zeta <= 1.2; zeta *= 1.6) for (let tau = 0; tau <= 0.04; tau += 0.008) g.push({ a, fn, zeta, tau }); return g; },
        bounds: { a: [0.01, 500], fn: [2, 40], zeta: [0.02, 3], tau: [0, 0.06] },
        shape: (p, f) => { const w = 2 * Math.PI * f, wn = 2 * Math.PI * p.fn;
            return cx.mul(cx.mul(cx.div([1, 0], [p.a, w]), cx.div([wn * wn, 0], [wn * wn - w * w, 2 * p.zeta * wn * w])), cx.expj(-w * p.tau)); },
    },
    // K e^{-s tau} / (s + a): control produces angular acceleration, opposed by rate damping a
    lag: {
        params: ['a', 'tau'],
        grid: () => { const g = []; for (let a = 0.1; a <= 300; a *= 1.4) for (let tau = 0; tau <= 0.04; tau += 0.004) g.push({ a, tau }); return g; },
        bounds: { a: [0.01, 500], tau: [0, 0.06] },
        shape: (p, f) => { const w = 2 * Math.PI * f; return cx.mul(cx.div([1, 0], [p.a, w]), cx.expj(-w * p.tau)); },
    },
};

function plantResponse(model, f) { return cx.scale(MODELS[model.kind].shape(model, f), model.K); }

// points: [{f, G, sigma}] with sigma the relative standard error of G
function fitCost(kind, p, points) {
    let num = 0, den = 0; const H = points.map(q => MODELS[kind].shape(p, q.f));
    points.forEach((q, i) => { const w = 1 / (q.sigma ** 2 * (q.G[0] ** 2 + q.G[1] ** 2)); num += w * (q.G[0] * H[i][0] + q.G[1] * H[i][1]); den += w * (H[i][0] ** 2 + H[i][1] ** 2); });
    const K = num / den; let chi2 = 0;
    points.forEach((q, i) => { chi2 += ((q.G[0] - K * H[i][0]) ** 2 + (q.G[1] - K * H[i][1]) ** 2) / (q.sigma ** 2 * (q.G[0] ** 2 + q.G[1] ** 2)); });
    return { K, chi2 };
}

function refine(kind, start, points) {
    const M = MODELS[kind], p = Object.assign({}, start);
    let best = fitCost(kind, p, points);
    const step = {}; for (const k of M.params) step[k] = Math.max(Math.abs(p[k]) * 0.2, k === 'tau' ? 0.002 : 0.05);
    for (let it = 0; it < 200; it++) {
        let improved = false;
        for (const k of M.params) for (const dir of [1, -1]) {
            const q = Object.assign({}, p); q[k] = Math.min(M.bounds[k][1], Math.max(M.bounds[k][0], p[k] + dir * step[k]));
            const c = fitCost(kind, q, points);
            if (c.chi2 < best.chi2 - 1e-12) { Object.assign(p, q); best = c; improved = true; }
        }
        if (!improved) { let small = true; for (const k of M.params) { step[k] /= 2; if (step[k] > Math.abs(p[k]) * 1e-4 + 1e-7) small = false; } if (small) break; }
    }
    return Object.assign({}, p, { kind, K: best.K, chi2: best.chi2 });
}

/**
 * Fit every candidate model to pooled plant estimates. Bins enter when their relative standard error is
 * below maxSigma. chi2red near 1 means the model explains the data to within the measurement uncertainty.
 * Parameter standard errors come from refitting each leave-one-flight-out estimate.
 */
function fitPlant(pooled, fLo, fHi, maxSigma = 0.35, minSigma = 0.03) {
    const keep = pooled.rows.map((r, i) => ({ r, i })).filter(o => o.r.f >= fLo && o.r.f <= fHi && o.r.Gse && o.r.Gse.sigma < maxSigma && cx.abs(o.r.G) > 0);
    // a floor on sigma keeps a handful of very well measured low-frequency bins from dictating the whole fit
    const points = keep.map(o => ({ f: o.r.f, G: o.r.G, sigma: Math.max(minSigma, o.r.Gse.sigma) }));
    if (points.length < 8) return { points: points.length, models: [] };
    const models = [];
    for (const kind of Object.keys(MODELS)) {
        let start = null, cost = Infinity;
        for (const p of MODELS[kind].grid()) { const c = fitCost(kind, p, points); if (c.chi2 < cost) { cost = c.chi2; start = p; } }
        const best = refine(kind, start, points), dof = 2 * points.length - (MODELS[kind].params.length + 1);
        best.chi2red = best.chi2 / dof;
        const names = ['K', ...MODELS[kind].params], jack = pooled.leaveOut.map((L) => {
            const rows = rowsOf(L); return refine(kind, best, keep.map((o, j) => ({ f: o.r.f, G: rows[o.i].G, sigma: points[j].sigma })));
        });
        best.se = {}; best.jack = jack;
        const n = jack.length;
        for (const k of names) { const mean = jack.reduce((s, m) => s + m[k], 0) / n; best.se[k] = Math.sqrt((n - 1) / n * jack.reduce((s, m) => s + (m[k] - mean) ** 2, 0)); }
        models.push(best);
    }
    models.sort((p, q) => p.chi2red - q.chi2red);
    return { points: points.length, fRange: [points[0].f, points[points.length - 1].f], models };
}

// ---------------------------------------------------------------------------------------------
// Closed loop: firmware control law around a plant
// ---------------------------------------------------------------------------------------------

/**
 * gains: { P, I, D, F, B, gyroCutoff, dCutoff, bCutoff, decayPerS, stop, relax } in firmware units;
 * relax is an optional function f -> complex, see relaxResponse.
 * plant: function f -> complex deg/s per unit control.
 */
function loop(a, gains, plant, f, rate = 1000) {
    const g = gains, w = 2 * Math.PI * f;
    const Kp = SCALE.P[a] * g.P * (g.stop || 1), Ki = SCALE.I[a] * g.I, Kd = SCALE.D[a] * g.D, Kf = SCALE.F[a] * g.F, Kb = SCALE.B[a] * (g.B || 0);
    const relax = g.relax ? g.relax(f) : [1, 0];                              // measured linear response of I-term relax
    const PI = cx.add([Kp, 0], cx.mul(relax, cx.div([Ki, 0], [g.decayPerS || 0, w]))); // P + relax * Ki / (s + decay)
    const ff = cx.add(cx.add(PI, [Kf, 0]), cx.scale(difResponse(f, g.bCutoff || 35, rate), Kb));
    const fb = cx.mul(lpf1Response(f, g.gyroCutoff, rate), cx.add(PI, cx.scale(difResponse(f, g.dCutoff, rate), Kd)));
    const G = plant(f), L = cx.mul(G, fb), den = cx.add([1, 0], L);
    return { T: cx.div(cx.mul(G, ff), den), S: cx.div([1, 0], den), L, U: cx.div(ff, den) };
}

function margins(a, gains, plant, fMax = 60) {
    let Ms = 0, fMs = 0, gm = Infinity, fGm = null, prev = null;
    for (let f = 0.5; f <= fMax; f += 0.05) {
        const { L, S } = loop(a, gains, plant, f);
        if (cx.abs(S) > Ms) { Ms = cx.abs(S); fMs = f; }
        if (prev && prev[1] * L[1] < 0 && L[0] < 0 && prev[0] < 0) { const m = 1 / cx.abs(L); if (m < gm) { gm = m; fGm = f; } }
        prev = L;
    }
    return { peakSensitivity: Ms, peakSensitivityHz: fMs, gainMargin: isFinite(gm) ? gm : null, gainMarginHz: fGm };
}

// Unit step response of a transfer function given as f -> complex, by inverse DFT on a 0.25 Hz grid
function stepResponse(Tf, seconds = 0.5, rate = 1000) {
    const N = 4000, Tk = [];
    for (let k = 1; k < N / 2; k++) Tk.push(Tf(k * rate / N));
    const dc = Tk[0], n = Math.round(seconds * rate), out = new Float64Array(n); let acc = 0;
    for (let i = 0; i < n; i++) {
        let s = dc[0];
        for (let k = 1; k < N / 2; k++) { const ph = 2 * Math.PI * k * i / N, v = Tk[k - 1]; s += 2 * (v[0] * Math.cos(ph) - v[1] * Math.sin(ph)); }
        acc += s / N; out[i] = acc;
    }
    return out;
}

function stepMetrics(s, rate = 1000) {
    const ms = 1000 / rate, tail = Math.round(0.1 * rate); let fin = 0;
    for (let i = s.length - tail; i < s.length; i++) fin += s[i];
    fin /= tail;
    let peak = -Infinity, pi = 0;
    for (let i = 0; i < Math.min(s.length, Math.round(0.25 * rate)); i++) if (s[i] > peak) { peak = s[i]; pi = i; }
    let t50 = null; for (let i = 0; i < s.length; i++) if (s[i] >= 0.5 * fin) { t50 = i * ms; break; }
    let settle = 0; for (let i = 0; i < s.length; i++) if (Math.abs(s[i] - fin) > 0.1 * Math.abs(fin)) settle = (i + 1) * ms;
    return { final: fin, peak, peakMs: pi * ms, overshootPct: (peak / fin - 1) * 100, t50Ms: t50, settle10Ms: settle };
}

// Pure delay that best matches a response to the setpoint spectrum, and the RMS of what is left.
// A constant delay is not a tracking fault, so performance is scored after removing it.
function delayFit(rows, Tof, f0, f1, maxDelay = 0.1) {
    const band = rows.filter(r => r.f >= f0 && r.f <= f1), df = rows[1].f - rows[0].f, T = band.map(r => Tof(r.f, r));
    let best = null;
    for (let tau = 0; tau <= maxDelay; tau += 0.0005) {
        let s = 0;
        band.forEach((r, i) => { const d = cx.sub(T[i], cx.expj(-2 * Math.PI * r.f * tau)); s += (d[0] * d[0] + d[1] * d[1]) * r.rr * df; });
        if (!best || s < best.s) best = { s, tau };
    }
    return { delayMs: best.tau * 1000, shapeRms: Math.sqrt(best.s) };
}

// Gyro motion the setpoint does not explain, as a PSD: (1 - coherence) * output PSD
const residualPsd = (r) => Math.max(0, 1 - r.cohRY) * r.yy;

// ---------------------------------------------------------------------------------------------
// Prediction from the measured plant response
// ---------------------------------------------------------------------------------------------

/**
 * The validated band is the longest stretch of plant bins whose relative standard error is below maxSigma,
 * tolerating dropouts of up to maxDropout consecutive bins (a vibration line ruins one or two bins).
 */
function validBand(rows, fLo, fHi, maxSigma, maxDropout = 2) {
    const ok = (r) => r.f >= fLo && r.f <= fHi && r.Gse && r.Gse.sigma < maxSigma;
    let best = null, start = null, last = null, miss = 0;
    const close = () => { if (start !== null && (!best || last - start > best[1] - best[0])) best = [start, last]; };
    for (const r of rows) {
        if (ok(r)) { if (start === null) start = r.f; last = r.f; miss = 0; }
        else if (start !== null && ++miss > maxDropout) { close(); start = null; miss = 0; }
    }
    close();
    if (!best) return null;
    const inBand = rows.filter(r => r.f >= best[0] && r.f <= best[1]);
    return { band: best, bins: inBand.length, usable: inBand.filter(ok).map(r => r.f) };
}

// Plant response on every bin of the band: measured where usable, interpolated in log-magnitude and phase
// across dropouts. rows may be a leave-one-out replicate; usable comes from the pooled estimate.
function plantTable(rows, vb) {
    const use = new Set(vb.usable), pts = rows.filter(r => use.has(r.f)), table = new Map();
    let ph = null;
    const un = pts.map((r) => { let a = cx.arg(r.G); if (ph !== null) { while (a - ph > Math.PI) a -= 2 * Math.PI; while (a - ph < -Math.PI) a += 2 * Math.PI; } ph = a; return { f: r.f, lm: Math.log(cx.abs(r.G)), ph: a }; });
    for (const r of rows) {
        if (r.f < vb.band[0] || r.f > vb.band[1]) continue;
        let i = un.findIndex(q => q.f >= r.f);
        if (i < 0) i = un.length - 1;
        const hi = un[i], lo = un[Math.max(0, hi.f === r.f ? i : i - 1)], t = hi.f === lo.f ? 0 : (r.f - lo.f) / (hi.f - lo.f);
        const lm = lo.lm + t * (hi.lm - lo.lm), p = lo.ph + t * (hi.ph - lo.ph);
        table.set(r.f, cx.scale(cx.expj(p), Math.exp(lm)));
    }
    return table;
}

/**
 * What the loop would do with `gains`, given the measured plant and the measured flight spectra.
 * base is the tune that was flown when the spectra were recorded. Everything is limited to the band.
 *   track     RMS of gyro - setpoint for the pilot's stick spectrum, after removing a pure delay <= tauMax
 *   disturb   RMS of uncommanded motion: measured residual scaled by |S / S_base|^2
 *   total     sqrt(track^2 + disturb^2)
 */
function predict(a, gains, base, table, rows, vb, tauMax = 0.1) {
    const plant = (f) => table.get(f), band = vb.band, df = rows[1].f - rows[0].f;
    const tr = delayFit(rows, (f) => loop(a, gains, plant, f).T, band[0], band[1], tauMax);
    let d = 0, peakS = 0, peakSHz = null, peakT = 0, peakTHz = null, low = 0, nLow = 0, minDist = Infinity;
    for (const r of rows) {
        if (r.f < band[0] || r.f > band[1]) continue;
        const g = loop(a, gains, plant, r.f), b = loop(a, base, plant, r.f), s = cx.abs(g.S), t = cx.abs(g.T);
        d += (s / cx.abs(b.S)) ** 2 * residualPsd(r) * df;
        if (s > peakS) { peakS = s; peakSHz = r.f; }
        if (t > peakT) { peakT = t; peakTHz = r.f; }
        if (r.f >= 1 && r.f <= 3) { low += t; nLow++; }
        minDist = Math.min(minDist, 1 / s);
    }
    return { track: tr.shapeRms, delayMs: tr.delayMs, disturb: Math.sqrt(d), total: Math.hypot(tr.shapeRms, Math.sqrt(d)),
        peakSensitivity: peakS, peakSensitivityHz: peakSHz, peakT, peakTHz, lowFreqGain: nLow ? low / nLow : null };
}

// I-term relax as a function of frequency, from pooled rows. Above the last bin it holds the last value.
function relaxResponse(rows) {
    const map = new Map(rows.map(r => [r.f, r.relax])), last = rows[rows.length - 1], df = rows[1].f - rows[0].f;
    return (f) => map.get(Math.round(f / df) * df) || (f > last.f ? last.relax : rows[0].relax);
}

// Feedback gain magnitude |fb| at a frequency, used to forbid raising loop gain where the plant is unmeasured
function feedbackGain(a, gains, f) { return cx.abs(loop(a, gains, () => [1, 0], f).L); }

module.exports = { FLIGHT_RPM, DEFAULTS, AXES, SCALE, SPEC, MODELS, BURST, cx, headspeedClass, loadApp, segments, steadySegments, profilesOf, byRevolution, spectralPeak, fftFor, bandpass, oscillationBursts, lpf1, dif, pt1, relaxFactor, relaxResponse, lpf1Response, difResponse, fitLine, solve, recoverGains,
    segmentSpectra, sumSpectra, pool, rowsOf, bandRms, spectralLine, crossAxisSpectra, sumCross, crossAxisGain, fitPlant, plantResponse, loop, margins, stepResponse, stepMetrics, delayFit, residualPsd, estimates, validBand, plantTable, predict, feedbackGain };
