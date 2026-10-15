// quick evaluation of a model with parameter overrides on the test flights
const fs = require('fs'), F = require('../../tools/autotune/twin_fit.cjs'), { loadRuns, split } = require('./runs.cjs');
const model = JSON.parse(fs.readFileSync(process.argv[2])); Object.assign(model.params, JSON.parse(process.argv[3] || '{}'));
if (process.argv[4]) Object.assign(model.observer, JSON.parse(process.argv[4]));
const { runs } = loadRuns('data/fireball'), sp = split(runs), e = F.predictionErrors(model, sp.test.map(r => F.prepareRun(r)));
const show = [1, 3, 4, 6, 8];
e.channels.forEach((c, ch) => console.log(c.padEnd(10) + show.map(k => `${e.rmse[ch][k].toFixed(2)}/${e.persistence[ch][k].toFixed(2)}`.padStart(16)).join('')));
