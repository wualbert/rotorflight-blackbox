// Governor evidence extractor: whole logs (native rate) -> float32 column files, one per log segment between logging gaps.
// node extract.cjs <out dir> <bbl> [log indexes comma-separated]
// Adapted from analysis/twin6dof/extract.cjs with the governor, battery and command fields.
const L = require('../../tools/autotune/lib.cjs'), fs = require('fs'), path = require('path');
const [out, file, sel] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const EXTRA = ['time', 'govP', 'govI', 'govD', 'govF', 'govSum', 'govTarget', 'govRequest', 'motor[0]', 'Vbat', 'Ibat', 'Tesc', 'Tmcu',
    'rcCommand[0]', 'rcCommand[1]', 'rcCommand[2]', 'rcCommand[3]', 'rcCommand[4]', 'setpoint[3]', 'mixer[0]', 'mixer[1]', 'mixer[2]', 'mixer[3]',
    'attitude[0]', 'attitude[1]', 'attitude[2]', 'altitude', 'vario', 'flightModeFlags', 'stateFlags', 'failsafePhase', 'gyroADC[2]', 'setpoint[2]'];
const app = L.loadApp(), meta = [];
const logs = sel ? sel.split(',').map(Number) : undefined;
let header0 = null;
for (const s of L.segments(app, file, { whole: true, extra: EXTRA, logs })) {
    if (!s.whole) { console.log('skip log', s.flight.log, s.skipped); continue; }
    if (!header0) header0 = s.flight.header;
    const cols = { profileAt: s.profileAt, airborneAt: s.airborneAt, govStateAt: s.govStateAt, rescueAt: s.rescueAt, hs: s.hs };
    for (const k of EXTRA) cols[k] = s.extra[k];
    const names = Object.keys(cols).filter(k => cols[k]);
    const buf = new Float32Array(s.n * names.length);
    names.forEach((k, j) => { const c = cols[k]; for (let i = 0; i < s.n; i++) buf[i * names.length + j] = c[i]; });
    // time in microseconds overflows float32 precision: store time relative to the segment start in seconds instead
    const tj = names.indexOf('time');
    if (tj >= 0) { const t0 = s.extra.time[0]; for (let i = 0; i < s.n; i++) buf[i * names.length + tj] = (s.extra.time[i] - t0) / 1e6; }
    const name = `log${String(s.flight.log).padStart(2, '0')}_${String(meta.filter(m => m.log === s.flight.log).length)}`;
    fs.writeFileSync(path.join(out, name + '.f32'), Buffer.from(buf.buffer));
    const h = s.flight.header;
    meta.push({ name, log: s.flight.log, n: s.n, rate: s.rate, actualRate: s.flight.actualRate, fromS: s.fromS, timeStartUs: s.extra.time ? s.extra.time[0] : null,
        columns: names, craft: s.flight.craft, start: s.flight.start, durationS: s.flight.durationS, gaps: s.flight.gaps,
        header: { govPID: h.govPID, vbatref: h.vbatref, vbatcellvoltage: [h.vbatmincellvoltage, h.vbatwarningcellvoltage, h.vbatmaxcellvoltage], currentMeterScale: h.currentMeterScale, currentMeterOffset: h.currentMeterOffset, collectiveRange: h.collectiveRange, yaw_tta: h.yaw_tta, looptime: h.looptime, pid_process_denom: h.pid_process_denom, minthrottle: h.minthrottle, maxthrottle: h.maxthrottle, features: h.features,
            // a log of firmware with blackbox_params: the parameter snapshot (gov_tune.cjs uses its values, IMP-05)
            ...(h.paramHeader ? { paramHeader: h.paramHeader, 'Firmware revision': h['Firmware revision'] } : {}) } });
    console.log(name, s.n, (s.n / s.rate).toFixed(1) + 's', 'from', s.fromS.toFixed(2));
}
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ file: path.basename(file), segments: meta }, null, 1));
