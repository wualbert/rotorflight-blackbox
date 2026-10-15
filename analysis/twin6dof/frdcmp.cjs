// compare model and measured MIMO responses: node frdcmp.cjs model.json frd.json
const fs = require('fs'), T = require('../../tools/autotune/heli_twin.cjs'), F = require('../../tools/autotune/twin_fit.cjs');
const m = JSON.parse(fs.readFileSync(process.argv[2])), g = JSON.parse(fs.readFileSync(process.argv[3]));
for (const grp of g) {
    const bins = grp.frd.bins.filter(b => b.H), Hm = T.frequencyResponseMatrix(m, bins.map(b => b.f), grp.op);
    const fmt = z => (Math.hypot(...z).toFixed(1) + '/' + (Math.atan2(z[1], z[0]) * 57.3).toFixed(0)).padStart(9);
    console.log(grp.key, JSON.stringify(grp.op));
    for (const [i, j] of [[0, 0], [1, 1], [2, 2], [0, 1], [1, 0]]) {
        console.log(`H[${i}][${j}] data :` + bins.map(b => fmt(b.H[i][j])).join(''));
        console.log(`H[${i}][${j}] model:` + Hm.map(h => fmt(h[i][j])).join(''));
    }
    console.log('f       :' + bins.map(b => b.f.toFixed(1).padStart(9)).join(''));
    console.log('cost', F.frequencyResiduals(m, [grp], 1).reduce((s, v) => s + v * v, 0).toFixed(2));
}
