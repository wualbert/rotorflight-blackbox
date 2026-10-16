'use strict';
// Governor state transitions, govRequest and throttle levels for each log of a dump.
// usage: node states.cjs <dump.BBL> [log indexes comma list]
const lib = require('../../../tools/autotune/lib.cjs');
const file = process.argv[2], pick = process.argv[3] ? process.argv[3].split(',').map(Number) : undefined;
const app = lib.loadApp();
const NAMES = ['OFF','IDLE','SPOOLUP','RECOVERY','ACTIVE','HOLD','FALLBACK','AUTOROT','BAILOUT','BYPASS'];
const extra = ['govP','govI','govD','govF','govSum','govTarget','govRequest','motor[0]','rcCommand[4]','Vbat','Ibat','mixer[3]'];
const out = [];
for (const w of lib.segments(app, file, { whole: true, extra, logs: pick })) {
    if (!w.whole) { out.push({ log: w.flight.log, skipped: w.skipped }); continue; }
    const x = w.extra, n = w.n, rate = w.rate, g = w.govStateAt;
    const tr = []; let last = -1;
    for (let i = 0; i < n; i++) { const s = g ? g[i] : -1; if (s !== last) { tr.push([+(i / rate).toFixed(3), NAMES[s] || s, x['rcCommand[4]'] ? x['rcCommand[4]'][i] : null, x['motor[0]'] ? x['motor[0]'][i] : null, w.hs[i], x.govRequest ? x.govRequest[i] : null]); last = s; } }
    const req = {}; if (x.govRequest) for (let i = 0; i < n; i += 50) req[x.govRequest[i]] = (req[x.govRequest[i]] || 0) + 1;
    const thr = {}; if (x['rcCommand[4]']) for (let i = 0; i < n; i += 50) { const v = Math.round(x['rcCommand[4]'][i] / 10) * 10; thr[v] = (thr[v] || 0) + 1; }
    const fields = Object.fromEntries(extra.map(k => [k, x[k] ? 'yes' : 'no']));
    let vb = null; if (x.Vbat) { let ch = 0; for (let i = 1; i < n; i++) if (x.Vbat[i] !== x.Vbat[i - 1]) ch++; vb = { changesPerS: +(ch / (n / rate)).toFixed(1), first: x.Vbat[0] / 100, last: x.Vbat[n - 1] / 100 }; }
    let ib = null; if (x.Ibat) { let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, x.Ibat[i]); ib = { maxA: mx / 100 }; }
    out.push({ log: w.flight.log, fromS: +w.fromS.toFixed(2), seconds: +w.seconds.toFixed(1), rate, actualRate: +w.flight.actualRate.toFixed(2), fields, govRequest: req, throttleStick: thr, vbat: vb, ibat: ib, transitions: tr });
}
console.log(JSON.stringify(out));
