'use strict';
// Spool-up (SPOOLUP, RECOVERY, BAILOUT -> ACTIVE) episodes: duration, exit cause, overshoot and settling of the headspeed.
// usage: node spool.cjs <dump.BBL> <log indexes>
const lib = require('../../../tools/autotune/lib.cjs');
const [file, list] = process.argv.slice(2);
const app = lib.loadApp(), out = [];
for (const w of lib.segments(app, file, { whole: true, extra: ['motor[0]', 'govRequest', 'govTarget', 'Vbat'], logs: list.split(',').map(Number) })) {
    if (!w.whole || !w.govStateAt) continue;
    const s = w.govStateAt, hs = w.hs, m = w.extra['motor[0]'], req = w.extra.govRequest, tg = w.extra.govTarget, r = w.flight.actualRate;
    for (let i = 1; i < w.n; i++) if (s[i] === 4 && [2, 3, 8].includes(s[i - 1])) {
        let a = i - 1; while (a > 0 && s[a - 1] === s[i - 1]) a--;
        const q = req[i]; let peak = -1e9, peakAt = i, settle = null;
        for (let k = i; k < Math.min(w.n, i + 5 * w.rate) && s[k] === 4; k++) { if (hs[k] - q > peak) { peak = hs[k] - q; peakAt = k; } }
        for (let k = i; k < Math.min(w.n, i + 10 * w.rate) && s[k] === 4; k++) { let ok = true; for (let j = k; j < Math.min(w.n, k + 0.5 * w.rate); j++) if (Math.abs(hs[j] - q) > 0.01 * q) { ok = false; break; } if (ok) { settle = (k - i) / r; break; } }
        out.push({ log: w.flight.log, from: ['', '', 'SPOOLUP', 'RECOVERY', '', '', '', '', 'BAILOUT'][s[i - 1]], atS: +(i / w.rate).toFixed(2), durS: +((i - a) / r).toFixed(2),
            exit: hs[i] > 0.99 * q ? 'headspeed' : 'throttle', hsAtExit: hs[i], request: q, motorAtExit: m[i], vbat: w.extra.Vbat ? w.extra.Vbat[i] / 100 : null,
            overshootRpm: peak, overshootPct: +(100 * peak / q).toFixed(1), peakAfterS: +((peakAt - i) / r).toFixed(2), settleWithin1PctS: settle, targetAtExit: tg[i] });
    }
}
console.log(JSON.stringify(out));
