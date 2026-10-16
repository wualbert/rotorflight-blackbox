// Flight phases (tools/autotune/health_phase.cjs phases()) of each whole log -> data/<craft>/<name>.phase (uint8 per sample) + phases.json
// node phase.cjs <data dir> <bbl> <log indexes> <flight rpm>
const L = require('../../tools/autotune/lib.cjs'), PH = require('../../tools/autotune/health_phase.cjs'), fs = require('fs'), path = require('path');
const [out, file, sel, rpm] = process.argv.slice(2);
const app = L.loadApp(), res = {};
const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json')));
for (const w of L.segments(app, file, { whole: true, extra: PH.EXTRA, logs: sel.split(',').map(Number) })) {
    if (!w.whole) continue;
    const name = meta.segments.find(m => m.log === w.flight.log && Math.abs(m.fromS - w.fromS) < 1e-6).name;
    const p = PH.phases(w, { rate: w.rate, flightRule: { headspeed: +rpm } });
    fs.writeFileSync(path.join(out, name + '.phase'), Buffer.from(p.code.buffer));
    res[name] = { class: p.class, seconds: p.seconds, flights: p.flights.map(f => ({ i0: f.i0, i1: f.i1, t0: f.t0, t1: f.t1, seconds: f.seconds, method: f.method, confidence: f.confidence, hover: f.hover })), rejected: p.rejected.length, notes: p.notes };
    console.log(name, p.class, JSON.stringify(p.seconds), p.flights.length);
}
fs.writeFileSync(path.join(out, 'phases.json'), JSON.stringify(res, null, 1));
