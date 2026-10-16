'use strict';
// print fields every <step> frames from <t0> to <t1> s of one log. usage: node peek.cjs <dump> <log> <t0> <t1> <step>
const lib = require('../../../tools/autotune/lib.cjs');
const [file, li, t0, t1, step] = process.argv.slice(2);
const app = lib.loadApp();
const extra = ['govP','govI','govD','govF','govSum','govTarget','govRequest','motor[0]','rcCommand[4]','Vbat','mixer[3]'];
for (const w of lib.segments(app, file, { whole: true, extra, logs: [+li] })) {
    if (!w.whole) continue; const x = w.extra;
    console.log('start', w.flight.start, 'fromS', w.fromS);
    for (let i = Math.round(+t0 * w.rate); i < Math.min(w.n, Math.round(+t1 * w.rate)); i += +step)
        console.log((i / w.rate).toFixed(3), 'st', w.govStateAt ? w.govStateAt[i] : '-', 'thr', x['rcCommand[4]'][i], 'mot', x['motor[0]'][i], 'hs', w.hs[i], 'tgt', x.govTarget[i], 'req', x.govRequest[i], 'P', x.govP[i], 'I', x.govI[i], 'F', x.govF[i], 'sum', x.govSum[i], 'V', x.Vbat ? x.Vbat[i] : '-');
}
