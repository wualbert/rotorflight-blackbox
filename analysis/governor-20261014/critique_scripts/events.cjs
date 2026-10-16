'use strict';
// node events.cjs <log file> <first> <last>: event type counts and non-state events per log (no frame data written)
const fs = require('node:fs'), vm = require('node:vm');
const lib = require('/Users/albertwu/exp/rotorflight-blackbox/tools/autotune/lib.cjs');
const [FILE, A, B] = process.argv.slice(2);
const app = lib.loadApp();
app.__bytes = new Uint8Array(fs.readFileSync(FILE));
const log = vm.runInContext('new FlightLog(__bytes)', app), EVENT = vm.runInContext('FlightLogEvent', app);
const names = Object.fromEntries(Object.entries(EVENT).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k]));
for (let li = +A; li <= Math.min(+B, log.getLogCount() - 1); li++) {
    if (log.getLogError(li) || !log.openLog(li)) { console.log(`#${li}: ${log.getLogError(li)}`); continue; }
    const tMin = log.getMinTime(), tMax = log.getMaxTime(), counts = {}, other = [];
    for (const c of log.getChunksInTimeRange(tMin, tMax)) for (const e of c.events) {
        const nm = names[e.event] || e.event; counts[nm] = (counts[nm] || 0) + 1;
        if (nm === "INFLIGHT_ADJUSTMENT") other.push({ t: e.time !== undefined ? +((e.time - tMin) / 1e6).toFixed(2) : null, nm, data: e.data });
    }
    console.log(`#${li}`, JSON.stringify(counts), JSON.stringify(Object.entries(other.reduce((a, o) => (a[o.data.name || o.data.func] = (a[o.data.name || o.data.func] || 0) + 1, a), {}))));
}
