'use strict';
// node dumpsel.cjs <log file> <out dir> <first> <last>: selected fields of logs first..last as int32 .npy + json
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const lib = require('/Users/albertwu/exp/rotorflight-blackbox/tools/autotune/lib.cjs');
const [FILE, OUT, A, B] = process.argv.slice(2);
const app = lib.loadApp();
app.__bytes = new Uint8Array(fs.readFileSync(FILE));
const log = vm.runInContext('new FlightLog(__bytes)', app), EVENT = vm.runInContext('FlightLogEvent', app);
function npy(file, typed, shape, descr) {
    let h = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
    h += ' '.repeat(64 - ((10 + h.length + 1) % 64)) + '\n';
    const head = Buffer.alloc(10); head.write('\x93NUMPY', 0, 'latin1'); head[6] = 1; head[7] = 0; head.writeUInt16LE(h.length, 8);
    fs.writeFileSync(file, Buffer.concat([head, Buffer.from(h, 'latin1'), Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength)]));
}
const WANT = /^(time|headspeed|tailspeed|motor\[0\]|vbat|amperage|Vbat|Ibat|rcCommand\[[0-3]\]|setpoint\[[0-3]\]|mixer\[[0-3]\]|gov.*|esc.*|Esc.*|debug\[[0-7]\]|erpm.*|rpm.*|throttle.*|bat.*)$/i;
console.error('logs', log.getLogCount());
for (let li = +A; li <= Math.min(+B, log.getLogCount() - 1); li++) {
    const tag = String(li).padStart(2, '0');
    if (log.getLogError(li) || !log.openLog(li)) { console.error(`#${li}: ${log.getLogError(li)}`); continue; }
    const sc = log.getSysConfig(), tMin = log.getMinTime(), tMax = log.getMaxTime(), names = log.getMainFieldNames();
    const sel = names.map((nm, j) => [nm, j]).filter(([nm]) => WANT.test(nm));
    const frames = [], events = [];
    for (const c of log.getChunksInTimeRange(tMin, tMax)) { for (const f of c.frames) frames.push(f); for (const e of c.events) events.push(e); }
    const n = frames.length, F = sel.length, data = new Int32Array(n * F);
    for (let i = 0; i < n; i++) for (let k = 0; k < F; k++) data[i * F + k] = frames[i][sel[k][1]] | 0;
    const indexAt = (t) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (frames[m][1] < t) lo = m + 1; else hi = m; } return lo; };
    npy(path.join(OUT, `log${tag}.npy`), data, [n, F], '<i4');
    const evs = events.map(e => ({ i: indexAt(e.time === undefined ? tMax : e.time), time: e.time, event: e.event, data: e.data }));
    fs.writeFileSync(path.join(OUT, `log${tag}.json`), JSON.stringify({ log: li, fields: sel.map(s => s[0]), allFields: names, n, tMin, tMax,
        eventNames: Object.fromEntries(Object.entries(EVENT).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k])), events: evs, header: sc },
        (k, v) => ArrayBuffer.isView(v) ? Array.from(v) : v));
    console.error(`#${li}: ${n} frames, ${F} fields, ${evs.length} events`);
}
