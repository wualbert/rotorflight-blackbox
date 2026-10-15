// Native Rotorflight 4.6 controller fed recorded setpoints and gyro: does it reproduce the logged mixer?
const fs = require('fs'), FW = require('../../tools/autotune/firmware_controller.cjs'), { loadRuns, split } = require('./runs.cjs');
const parse = t => { const g = {}, p = {}; let c = g; for (const l of t.split(/\r?\n/)) { let m; if ((m = /^profile (\d+)/.exec(l))) { c = p[+m[1]] = {}; continue; } if (/^rateprofile/.test(l)) { c = {}; continue; }
    if ((m = /^set (\S+) = (.*)$/.exec(l.trim()))) c[m[1]] = /^-?\d+(\.\d+)?$/.test(m[2].trim()) ? +m[2] : m[2].trim(); } return { g, p }; };
(async () => {
    const cli = parse(fs.readFileSync(process.argv[2], 'utf8')), { meta, runs } = loadRuns('data/fireball', { minRunS: 12 });
    const rows = [];
    for (const run of split(runs).test) for (let s0 = 0; s0 + 10000 <= run.n; s0 += 10000) {
        const prof = run.profileAt[s0 + 2000]; if (run.profileAt.slice(s0, s0 + 10000).some(p => p !== prof)) continue;
        const config = FW.fromHeader(meta.header, Object.assign({}, cli.g, cli.p[prof === 0 ? 0 : prof - 1]), {});
        for (const f of FW.SCHEMA) { const v = config.values[f.name]; if (v !== undefined && (!Number.isInteger(v) || v < f.min || v > f.max)) delete config.values[f.name]; }
        const rt = await FW.create({ config }), v = config.values, sc = [2e-4, 2e-4, 5e-4];
        rt.seed({ axisError: ['roll', 'pitch', 'yaw'].map((a, k) => v[a + '_i_gain'] > 0 ? run.I[k][s0] / (v[a + '_i_gain'] * sc[k]) : 0), axisOffset: [0, 0, 0] });
        const e = [0, 0, 0, 0], y = [0, 0, 0, 0]; let n = 0;
        for (let i = s0 + 1; i < s0 + 10000; i++) {
            const r = rt.step({ setpoint: [0, 1, 2].map(a => run.sp[a][i]), gyro: [0, 1, 2].map(a => run.gyro[a][i]), collective: run.pcoll[i], headspeed: run.hs[i], throttle: run.thr[i],
                airborne: true, spooledUp: true, spoolUpRatio: 1, ttaIncrease: 0, saturation: [0, 0, 0], previousMixer: i === s0 + 1 ? [0, 1, 2].map(a => run.u[a][i - 1]).concat(run.coll[i - 1]) : undefined });
            if (i - s0 < 2000) continue; n++;
            [...r.u, r.collective].forEach((val, a) => { const rec = a < 3 ? run.u[a][i] : run.coll[i]; e[a] += (val - rec) ** 2; y[a] += rec * rec; });
        }
        rows.push({ id: run.id + '+' + (s0 / 1000) + 's', profile: prof, rel: e.map((q, a) => Math.sqrt(q / y[a])) });
    }
    rows.forEach(r => console.log(r.id.padEnd(22), 'P' + r.profile, 'relative mixer error roll/pitch/yaw/coll', r.rel.map(x => (100 * x).toFixed(1) + '%').join(' ')));
})();
