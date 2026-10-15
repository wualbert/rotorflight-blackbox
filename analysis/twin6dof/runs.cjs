// Load extracted logs (extract.cjs) as twin runs and split whole flights into fit and test.
const fs = require('fs'), path = require('path');
const F = require('../../tools/autotune/twin_fit.cjs');

function loadRuns(dir, rules = F.RULES) {
    rules = Object.assign({}, F.RULES, rules);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'))), runs = [];
    for (const s of meta.segments) {
        const a = new Float32Array(fs.readFileSync(path.join(dir, s.name + '.f32')).buffer.slice(0));
        const C = Object.fromEntries(s.columns.map((c, j) => [c, j])), nc = s.columns.length;
        const col = (name, k = 1) => { const o = new Float64Array(s.n), j = C[name]; for (let i = 0; i < s.n; i++) o[i] = a[i * nc + j] * k; return o; };
        const hs = col('hs'), air = col('airborneAt'), rescue = col('rescueAt');
        const airHs = []; for (let i = 0; i < s.n; i += 50) if (air[i] > 0) airHs.push(hs[i]);
        airHs.sort((x, y) => x - y); const floor = 0.7 * (airHs[airHs.length >> 1] || 1e9);
        const ok = i => air[i] > 0 && rescue[i] === 0 && hs[i] > floor;
        const full = { u: [col('u0'), col('u1'), col('u2')], coll: col('mixer[3]', 1e-3), thr: col('motor[0]', 1e-3), vbat: col('Vbat', 0.01),
            gyro: [col('gyro0'), col('gyro1'), col('gyro2')], att: [col('attitude[0]'), col('attitude[1]'), col('attitude[2]')],
            alt: col('altitude', 0.01), vario: col('vario', 0.01), hs, sp: [col('sp0'), col('sp1'), col('sp2')], pcoll: col('coll', 1e-3), profileAt: col('profileAt'), I: [col('I0'), col('I1'), col('I2')] };
        let i = 0;
        while (i < s.n) {
            while (i < s.n && !ok(i)) i++;
            const i0 = i; while (i < s.n && ok(i)) i++;
            if ((i - i0) / s.rate < rules.minRunS) continue;
            const sl = x => x.slice(i0, i);
            runs.push({ id: `${s.name}@${(i0 / s.rate).toFixed(1)}`, flight: s.name, log: s.log, rate: s.actualRate || s.rate, n: i - i0, fromIndex: i0,
                u: full.u.map(sl), coll: sl(full.coll), thr: sl(full.thr), vbat: sl(full.vbat), gyro: full.gyro.map(sl), att: full.att.map(sl),
                alt: sl(full.alt), vario: sl(full.vario), hs: sl(full.hs), sp: full.sp.map(sl), pcoll: sl(full.pcoll), profileAt: sl(full.profileAt), I: full.I.map(sl) });
        }
    }
    return { meta, runs };
}

// Seeded split of whole flights (captures) into fit and test.
function split(runs, seed = 'twin6dof', testFraction = 0.2) {
    const flights = [...new Set(runs.map(r => r.flight))];
    let h = 2166136261; for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const rand = () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
    const order = flights.map(f => [rand(), f]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    const total = runs.reduce((s, r) => s + r.n, 0), test = new Set(); let acc = 0;
    for (const f of order) { if (acc / total >= testFraction) break; test.add(f); acc += runs.filter(r => r.flight === f).reduce((s, r) => s + r.n, 0); }
    return { train: runs.filter(r => !test.has(r.flight)), test: runs.filter(r => test.has(r.flight)), testFlights: [...test] };
}

// Pieces of runs with one PID profile (one governor headspeed) for the frequency responses.
function byProfile(runs) {
    const groups = new Map();
    for (const r of runs) {
        let i0 = 0;
        for (let i = 1; i <= r.n; i++) if (i === r.n || r.profileAt[i] !== r.profileAt[i0]) {
            const key = 'profile ' + (r.profileAt[i0] || 1), sl = x => x.subarray(i0, i);
            if (i - i0 > 8 * r.rate) { if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(Object.assign({}, r, { n: i - i0, u: r.u.map(sl), coll: sl(r.coll), thr: sl(r.thr), vbat: sl(r.vbat), gyro: r.gyro.map(sl), sp: r.sp.map(sl), hs: sl(r.hs),
                    att: r.att.map(sl), alt: sl(r.alt), vario: sl(r.vario), target: r.target ? { gyro: r.target.gyro.map(sl) } : undefined, profileAt: sl(r.profileAt) })); }
            i0 = i;
        }
    }
    return [...groups].map(([key, runs]) => ({ key, runs }));
}
module.exports = { loadRuns, split, byProfile };
