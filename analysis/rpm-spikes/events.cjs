'use strict';
// The samples around each FALLBACK entry of one log: node events.cjs <dump.BBL> <log> <t1,t2,...>
const L = require('../../tools/autotune/lib.cjs');
const [file, li, ts] = process.argv.slice(2), app = L.loadApp();
for (const s of L.segments(app, file, { whole: true, extra: ['motor[0]', 'govTarget'], logs: [+li] })) {
    if (!s.whole) continue;
    const rate = s.flight.actualRate || s.rate, hs = s.hs, u = s.extra['motor[0]'], st = s.govStateAt;
    for (const t of ts.split(',').map(Number)) {
        const i = Math.round(t * rate);
        let maxU = 0, firstFull = null; for (let j = i - Math.round(0.5 * rate); j < i; j++) { maxU = Math.max(maxU, u[j]); if (u[j] >= 995 && firstFull === null) firstFull = j; }
        console.log(`log ${li} t ${t}: state before ${st[i - 2]}, max throttle in the 0.5 s before ${maxU / 10} %, throttle at -20/-10/-5/-2 ms ${[20, 10, 5, 2].map((ms) => u[i - Math.round(ms * rate / 1000)] / 10).join('/')}`);
        console.log('   hs every 2 ms from -16 ms:', Array.from({ length: 16 }, (_, k) => Math.round(hs[i - Math.round(0.016 * rate) + 2 * k])).join(' '), ' target', s.extra.govTarget[i]);
    }
}
