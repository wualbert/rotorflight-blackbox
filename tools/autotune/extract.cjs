'use strict';

/**
 * Step 1 of 2: decode blackbox logs and reduce every usable flight segment to numbers.
 *
 *   node tools/autotune/extract.cjs <out dir> <log file> [more log files...]
 *
 * Writes <out dir>/segments.json. A segment is an airborne, spooled-up stretch flown on one PID profile
 * with no logging gaps. Per segment and axis it stores the recovered gains, the cross-spectra and the
 * strongest narrow vibration line. Decoding is the slow part, so report.cjs works from this file.
 */

const fs = require('node:fs'), path = require('node:path');
const lib = require('./lib.cjs');

const [OUT, ...FILES] = process.argv.slice(2);
if (!OUT || !FILES.length) { console.error('usage: node extract.cjs <out dir> <log file> [more log files...]'); process.exit(2); }

const app = lib.loadApp();
const seen = new Map(), flights = [], skipped = [], segments = [];
const rms = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); };
const round = (v, d = 4) => (typeof v === 'number' && isFinite(v)) ? +v.toPrecision(d + 2) : v;
const tidy = (o) => JSON.parse(JSON.stringify(o, (k, v) => typeof v === 'number' ? round(v) : v));

for (const file of FILES) {
    const started = Date.now();
    for (const item of lib.segments(app, file)) {
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
