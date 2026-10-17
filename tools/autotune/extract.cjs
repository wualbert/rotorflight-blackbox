'use strict';

/**
 * Step 1 of 2: decode blackbox logs and reduce every usable flight segment to numbers.
 *
 *   node tools/autotune/extract.cjs <out dir> <log file> [more log files...] [--logs=<i,j>] [--clip=<json file>]
 *
 * --clip (IMP-04): { "<log index>": [[t0, t1], ...] } in frame seconds (the flights of js/tuning_worker.js, for one log file). A segment
 * is cut to the span that it overlaps most, and it is used only if it is still lib.DEFAULTS.minSegmentS or longer; a segment of a log
 * with spans that overlaps none is skipped. A log with no entry keeps its segments.
 *
 * Writes <out dir>/segments.json. A segment is an airborne, spooled-up stretch flown on one PID profile
 * with no logging gaps. Per segment and axis it stores the recovered gains, the cross-spectra and the
 * strongest narrow vibration line. Decoding is the slow part, so report.cjs works from this file.
 */

const fs = require('node:fs'), path = require('node:path');
const lib = require('./lib.cjs');

const [OUT, ...args] = process.argv.slice(2);
const flags = args.filter(x => x.startsWith('--logs=')), FILES = args.filter(x => !x.startsWith('--logs=') && !x.startsWith('--clip='));
if (flags.length > 1 || flags.length && !/^--logs=\d+(,\d+)*$/.test(flags[0])) throw new Error('Invalid --logs selection.');
const logs = flags.length ? flags[0].slice(7).split(',').map(Number) : undefined;
const clipArg = args.find(x => x.startsWith('--clip=')), clip = clipArg ? JSON.parse(fs.readFileSync(clipArg.slice(7), 'utf8')) : null;
if (!OUT || !FILES.length) { console.error('usage: node extract.cjs <out dir> <log file> [more log files...]'); process.exit(2); }
// the spans of --clip are for the logs of one file (keyed by log index only)
if (clip && FILES.length > 1) throw new Error('--clip is for one log file: its spans are keyed by the log index only.');

const app = lib.loadApp();
const seen = new Map(), flights = [], skipped = [], segments = [];
const rms = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); };
const round = (v, d = 4) => (typeof v === 'number' && isFinite(v)) ? +v.toPrecision(d + 2) : v;
const tidy = (o) => JSON.parse(JSON.stringify(o, (k, v) => typeof v === 'number' ? round(v) : v));
// the part of a segment in frame seconds [t0, t1) (item.extra.time): every column cut, the headspeed of the part (lib.segments)
function cut(item, t0, t1) {
    const T = item.extra.time, n = item.n, at = (s) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (item.fromS + (T[m] - T[0]) / 1e6 < s) lo = m + 1; else hi = m; } return lo; };
    const j0 = at(t0), j1 = Math.max(j0, at(t1)), sub = (v) => v && v.subarray ? v.subarray(j0, j1) : v, m = j1 - j0;
    const hs = []; for (let i = j0; i < j1; i += 10) hs.push(item.hs[i]); hs.sort((a, b) => a - b);
    return Object.assign({}, item, { n: m, seconds: m / item.rate, fromS: item.fromS + (j0 < n ? (T[j0] - T[0]) / 1e6 : 0), sp: item.sp.map(sub), gyro: item.gyro.map(sub), u: item.u.map(sub), P: item.P.map(sub), I: item.I.map(sub),
        D: item.D.map(sub), F: item.F.map(sub), B: item.B.map(sub), hs: sub(item.hs), coll: sub(item.coll), extra: Object.fromEntries(Object.entries(item.extra).map(([k, v]) => [k, sub(v)])),
        headspeed: { median: hs[hs.length >> 1] || 0, p05: hs[Math.floor(hs.length * 0.05)], p95: hs[Math.floor(hs.length * 0.95)] }, clipped: [j0, n - j1] });
}
// the span of clip for a segment of log li: the one with the largest overlap, null when none overlaps; undefined when the log has none
function spanOf(li, item) {
    const list = clip && clip[String(li)]; if (!Array.isArray(list)) return undefined;
    const T = item.extra.time, a = item.fromS, b = item.fromS + (T[item.n - 1] - T[0]) / 1e6;
    let best = null, size = 0; for (const [t0, t1] of list) { const o = Math.min(b, t1) - Math.max(a, t0); if (o > size) { size = o; best = [t0, t1]; } }
    return best;
}

for (const file of FILES) {
    const started = Date.now();
    for (let item of lib.segments(app, file, { logs, extra: clip ? ['time'] : [] })) {
        const fl = item.flight;
        if (seen.has(fl.id) && seen.get(fl.id) !== file) { if (!skipped.some(s => s.id === fl.id && s.file === fl.file)) skipped.push({ file: fl.file, log: fl.log, id: fl.id, reason: `same flight as one in ${path.basename(seen.get(fl.id))}` }); continue; }
        seen.set(fl.id, file);
        if (!flights.some(f => f.id === fl.id)) {
            const h = fl.header;
            flights.push({ id: fl.id, file: fl.file, log: fl.log, start: fl.start, durationS: round(fl.durationS), rate: fl.rate, frames: fl.frames, gaps: fl.gaps,
                firmware: fl.firmware, craft: fl.craft,
                header: { rollPID: h.rollPID, pitchPID: h.pitchPID, yawPID: h.yawPID, govPID: h.govPID, rollBW: h.rollBW, pitchBW: h.pitchBW, yawBW: h.yawBW,
                    hsi_gain: h.hsi_gain, yaw_stop_gain: h.yaw_stop_gain, yaw_precomp: h.yaw_precomp, cyclic_coupling: h.cyclic_coupling,
                    iterm_relax_type: h.iterm_relax_type, iterm_relax_cutoff: h.iterm_relax_cutoff, error_decay: h.error_decay,
                    rates_type: h.rates_type, rc_rates: h.rc_rates, rc_expo: h.rc_expo, rates: h.rates, response_time: h.response_time, accel_limit: h.accel_limit,
                    looptime: h.looptime, pid_process_denom: h.pid_process_denom, gyro_lowpass_hz: h.gyro_lowpass_hz, gyro_lowpass2_hz: h.gyro_lowpass2_hz,
                    dyn_notch_count: h.dyn_notch_count, dyn_notch_min_hz: h.dyn_notch_min_hz, dyn_notch_max_hz: h.dyn_notch_max_hz } });
        }
        if (item.skipped) { skipped.push({ file: fl.file, log: fl.log, id: fl.id, durationS: round(fl.durationS), reason: item.skipped }); continue; }
        // --clip: the part of the segment in its flight (IMP-04)
        if (clip && item.extra.time) { const sp = spanOf(fl.log, item);
            if (sp === null) { skipped.push({ file: fl.file, log: fl.log, id: fl.id, durationS: round(fl.durationS), reason: `segment at ${round(item.fromS)} s: not in a flight` }); continue; }
            if (sp) { const c = cut(item, sp[0], sp[1]);
                if (c.seconds < lib.DEFAULTS.minSegmentS) { skipped.push({ file: fl.file, log: fl.log, id: fl.id, durationS: round(fl.durationS), reason: `segment at ${round(item.fromS)} s: ${round(c.seconds)} s in the flight, shorter than ${lib.DEFAULTS.minSegmentS} s` }); continue; }
                if (c.clipped[0] || c.clipped[1]) item = c; } }

        const seg = { flight: fl.id, file: fl.file, log: fl.log, profile: item.profile, fromS: round(item.fromS), seconds: round(item.seconds), rate: item.rate,
            headspeed: item.headspeed, collectiveRms: item.coll ? rms(item.coll) : null, axes: {} };
        for (let a = 0; a < 3; a++) {
            const u = item.u[a]; let sat = 0, uMax = 0;
            for (let i = 0; i < u.length; i++) { const v = Math.abs(u[i]); if (v > uMax) uMax = v; if (v >= 0.95) sat++; }
            const gains = lib.recoverGains(item, a), S = lib.segmentSpectra(app, item, a, gains.integratorInput), spectra = { windows: S.windows };
            for (const k in S) if (k !== 'windows') spectra[k] = Array.from(S[k], v => +v.toPrecision(7));
            seg.axes[lib.AXES[a]] = tidy({ setpointRms: rms(item.sp[a]), gyroRms: rms(item.gyro[a]), controlMax: uMax, controlAbove95pct: sat / u.length,
                gains, line: lib.spectralLine(app, item.gyro[a], item.rate, 8, 30) });
            seg.axes[lib.AXES[a]].spectra = spectra;
        }
        const C = lib.crossAxisSpectra(app, item);
        seg.cross = C && { windows: C.windows, xx: Array.from(C.xx, v => +v.toPrecision(7)), xy: Array.from(C.xy, v => +v.toPrecision(7)) };
        segments.push(seg);
        console.error(`${fl.file.slice(-19)} #${fl.log} profile ${item.profile}: ${item.seconds.toFixed(0)} s at ${item.headspeed.median} rpm`);
    }
    console.error(`${path.basename(file)} done in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

fs.mkdirSync(OUT, { recursive: true });
const out = path.join(OUT, 'segments.json');
fs.writeFileSync(out, JSON.stringify({ files: FILES.map(f => path.basename(f)), rules: `airborne, headspeed >= 90% of segment median and >= ${lib.DEFAULTS.minHeadspeed} rpm, one PID profile, no logging gaps, >= 20 s`,
    flights, skipped, segments }));
console.error(`${flights.length} flights, ${segments.length} segments, ${skipped.length} skipped -> ${out}`);
