const fs = require('fs'), F = require('../../tools/autotune/twin_fit.cjs'), { loadRuns, split } = require('./runs.cjs');
const base = JSON.parse(fs.readFileSync(process.argv[2])), { runs } = loadRuns('data/fireball'), test = split(runs).test.map(r => F.prepareRun(r));
const variants = JSON.parse(process.argv[3]);
for (const [name, v] of Object.entries(variants)) {
    const m = JSON.parse(JSON.stringify(base)); Object.assign(m.params, v.params || {}); Object.assign(m.observer, v.observer || {});
    let runsV = test;
    if (v.inputLowpass) runsV = test.map(r => Object.assign({}, r, { u: r.u.map(c => { const o = new Float64Array(c.length); const a = 1 - Math.exp(-2 * Math.PI * v.inputLowpass / r.rate); let y = c[0]; for (let i = 0; i < c.length; i++) { y += a * (c[i] - y); o[i] = y; } return o; }) }));
    const e = F.predictionErrors(m, runsV, { rules: { originEveryS: 1 } });
    console.log(name.padEnd(22), [0, 1, 2].map(ch => [1, 3, 4, 6].map(k => e.rmse[ch][k].toFixed(1)).join('/')).join('  |  '), '  hold', [0, 1, 2].map(ch => [1, 3, 4, 6].map(k => e.persistence[ch][k].toFixed(1)).join('/')).join(' | '));
}
