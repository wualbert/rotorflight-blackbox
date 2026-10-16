'use strict';
// RPM-reading spikes of the logged headspeed against the throttle, for one dump.
// A spike: the logged headspeed changes faster than the rotor can (|change over ~3 ms| / 3 ms > rateMin rpm/ms; the fastest real
// rotor acceleration in the Fireball logs is ~3.5 rpm/ms). Only governed motor-running samples (RECOVERY, ACTIVE, FALLBACK, hs > 1000).
// node --max-old-space-size=8000 analysis/rpm-spikes/scan.cjs <dump.BBL> <out.json>
const fs = require('node:fs');
const L = require('../../tools/autotune/lib.cjs');
const [file, out] = process.argv.slice(2);
const BANDS = [[0, 0.8], [0.8, 0.9], [0.9, 0.95], [0.95, 0.99], [0.99, 0.995], [0.995, 1.01]];
const RATES = [40, 100];                       // rpm per ms
const app = L.loadApp(), res = { file: file.split('/').pop(), logs: [], spikes: [], fallbacks: [] };
const EXTRA = ['time', 'motor[0]', 'govTarget', 'govRequest', 'Vbat'];
for (const s of L.segments(app, file, { whole: true, extra: EXTRA })) {
    if (!s.whole || !s.hs || !s.extra['motor[0]'] || !s.govStateAt) { res.logs.push({ log: s.flight && s.flight.log, skipped: s.skipped || 'no headspeed, motor or governor state' }); continue; }
    const rate = s.flight.actualRate || s.rate, n = s.n, hs = s.hs, u = s.extra['motor[0]'], st = s.govStateAt, v = s.extra.Vbat;
    const k = Math.max(1, Math.round(0.003 * rate)), dtMs = 1000 * k / rate;
    const secs = BANDS.map(() => 0), cnt = RATES.map(() => BANDS.map(() => [0, 0]));
    const gov = (i) => (process.env.ANY_STATE ? u[i] > 50 : (st[i] === 3 || st[i] === 4 || st[i] === 6)) && hs[i] > 1000;
    const band = (x) => BANDS.findIndex(([lo, hi]) => x >= lo && x < hi);
    for (let i = 0; i < n; i++) if (gov(i)) { const b = band(u[i] / 1000); if (b >= 0) secs[b] += 1 / rate; }
    // physical acceleration: the p99.9 of the 100-ms mean slope in ACTIVE
    const m = Math.max(1, Math.round(0.1 * rate)), acc = [];
    for (let i = m; i + m < n; i += m) if (st[i] === 4) { let a = 0, b = 0; for (let j = 0; j < m; j++) { a += hs[i - m + j]; b += hs[i + j]; } acc.push(Math.abs(b - a) / m / 0.1); }
    acc.sort((a, b) => a - b);
    RATES.forEach((r, ri) => {
        let last = -1e9;
        for (let i = k; i < n; i++) {
            if (!gov(i)) continue;
            const d = hs[i] - hs[i - k];
            if (Math.abs(d) / dtMs <= r) continue;
            if (i - last > 0.05 * rate) {
                const b = band(u[i - k] / 1000); cnt[ri][b][d > 0 ? 0 : 1]++;
                if (ri === 0) res.spikes.push({ log: s.flight.log, start: s.flight.start || null, fromS: s.fromS, t: +(i / rate).toFixed(3), rateRpmMs: +(Math.abs(d) / dtMs).toFixed(0), up: d > 0, throttle: u[i - k] / 10,
                    state: st[i], target: s.extra.govTarget ? s.extra.govTarget[i] : null, vbat: v ? v[i] / 100 : null });
            }
            last = i;
        }
    });
    for (let i = 1; i < n; i++) if (st[i] === 6 && st[i - 1] !== 6) res.fallbacks.push({ log: s.flight.log, start: s.flight.start || null, t: +(i / rate).toFixed(3), throttleBefore: u[Math.max(0, i - 3)] / 10 });
    res.logs.push({ log: s.flight.log, start: s.flight.start || null, fromS: s.fromS, seconds: +(n / rate).toFixed(1), rate: +rate.toFixed(1), k, accP999: acc.length ? Math.round(acc[Math.floor(acc.length * 0.999)]) : null,
        governedS: secs.reduce((a, b) => a + b, 0), secs: secs.map((x) => +x.toFixed(2)), counts: cnt, firmware: s.flight.firmware || null });
}
// totals
const tot = { secs: BANDS.map((_, b) => res.logs.reduce((a, l) => a + (l.secs ? l.secs[b] : 0), 0)), counts: RATES.map((_, ri) => BANDS.map((_, b) => [0, 1].map((d) => res.logs.reduce((a, l) => a + (l.counts ? l.counts[ri][b][d] : 0), 0)))) };
res.bands = BANDS; res.rates = RATES; res.total = tot;
fs.writeFileSync(out, JSON.stringify(res, null, 1));
console.log(res.file, 'governed s per band', tot.secs.map((x) => x.toFixed(1)).join(' / '));
RATES.forEach((r, ri) => console.log(`  > ${r} rpm/ms: up/down per band`, tot.counts[ri].map(([a, b]) => `${a}/${b}`).join('  ')));
console.log('  FALLBACK entries', res.fallbacks.length, JSON.stringify(res.fallbacks));
