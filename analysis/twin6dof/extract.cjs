// Dump whole logs (native rate) to float32 column files for twin development.
// node extract.cjs <out dir> <bbl> [log indexes comma-separated]
const L = require('../../tools/autotune/lib.cjs'), fs = require('fs'), path = require('path');
const [out, file, sel] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const EXTRA = ['time', 'mixer[3]', 'gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]', 'attitude[0]', 'attitude[1]', 'attitude[2]', 'altitude', 'vario',
    'Vbat', 'Ibat', 'motor[0]', 'servo[0]', 'servo[1]', 'servo[2]', 'servo[3]', 'rcCommand[3]', 'govTarget', 'govRequest', 'flightModeFlags', 'stateFlags', 'Tesc'];
const app = L.loadApp(), meta = [];
const logs = sel ? sel.split(',').map(Number) : undefined;
for (const s of L.segments(app, file, { whole: true, extra: EXTRA, logs })) {
    if (!s.whole) continue;
    const cols = { profileAt: s.profileAt, airborneAt: s.airborneAt, govStateAt: s.govStateAt, rescueAt: s.rescueAt, hs: s.hs, coll: s.coll };
    ['sp', 'gyro', 'u', 'P', 'I', 'D', 'F', 'B'].forEach(k => s[k].forEach((c, a) => { cols[`${k}${a}`] = c; }));
    for (const k of EXTRA) cols[k] = s.extra[k];
    const names = Object.keys(cols).filter(k => cols[k]);
    const buf = new Float32Array(s.n * names.length);
    names.forEach((k, j) => { const c = cols[k]; for (let i = 0; i < s.n; i++) buf[i * names.length + j] = c[i]; });
    const name = `log${String(s.flight.log).padStart(2, '0')}_${String(meta.filter(m => m.log === s.flight.log).length)}`;
    fs.writeFileSync(path.join(out, name + '.f32'), Buffer.from(buf.buffer));
    meta.push({ name, log: s.flight.log, n: s.n, rate: s.rate, actualRate: s.flight.actualRate, fromS: s.fromS, columns: names, craft: s.flight.craft, start: s.flight.start });
    console.log(name, s.n, (s.n / s.rate).toFixed(1) + 's');
}
const header = (() => { const s = L.segments(app, file, { whole: true, logs: logs && [logs[0]] }).next().value; return s.flight.header; })();
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ file: path.basename(file), segments: meta, header }, null, 1));
