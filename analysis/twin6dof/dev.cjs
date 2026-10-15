// Development driver for the 6-DOF twin: load extracted logs, split, fit with a worker pool, evaluate.
// node dev.cjs <data dir> <out dir> [--fit stages] [--model model.json]
const fs = require('fs'), path = require('path'), os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const T = require('../../tools/autotune/heli_twin.cjs'), F = require('../../tools/autotune/twin_fit.cjs');
const H = require('../../tools/autotune/helicopter_model.cjs');
const { loadRuns, split, byProfile } = require('./runs.cjs');

if (!isMainThread) {
    const { dir, ids, rules } = workerData;
    const { runs } = loadRuns(dir); const mine = runs.filter(r => ids.includes(r.id)).map(r => F.prepareRun(r));
    parentPort.on('message', ({ job, model, weights, stageRules, disturbanceWeight }) => {
        let out; try { out = F.predictionErrors(model, mine, { residuals: true, rules: Object.assign({}, rules, stageRules), weights, disturbanceWeight }); } catch (e) { out = { failed: true, reason: e.message }; }
        parentPort.postMessage({ job, out });
    });
    return;
}

function pool(dir, runs, size, rules) {
    // each worker owns a share of the runs; a model evaluation sums the shares in run order
    const shares = Array.from({ length: size }, () => []), load = new Float64Array(size);
    for (const r of [...runs].sort((a, b) => b.n - a.n)) { const k = load.indexOf(Math.min(...load)); shares[k].push(r.id); load[k] += r.n; }
    const workers = shares.map(ids => new Worker(__filename, { workerData: { dir, ids, rules } }));
    let job = 0; const waiting = new Map();
    // shares are assembled in worker order, whatever order the replies arrive in
    workers.forEach((w, k) => w.on('message', ({ job, out }) => { const p = waiting.get(job); p.parts[k] = out; if (++p.count === workers.length) { waiting.delete(job); p.resolve(p.parts); } }));
    const one = (model, weights, stageRules, disturbanceWeight) => new Promise(resolve => { const id = job++; waiting.set(id, { parts: [], count: 0, resolve }); workers.forEach(w => w.postMessage({ job: id, model, weights, stageRules, disturbanceWeight })); })
        .then(parts => parts.some(p => p.failed) ? { failed: true, reason: parts.find(p => p.failed).reason } :
            { residuals: Float64Array.from(parts.flatMap(p => Array.from(p.residuals))) });
    return { many: async (models, weights) => { const out = []; for (const m of models) out.push(await one(m, weights)); return out; },
        // evaluate several models at once across the pool: each worker processes its share for every model in turn
        manyParallel: (models, weights, stageRules, dw) => Promise.all(models.map(m => one(m, weights, stageRules, dw))), close: () => workers.forEach(w => w.terminate()) };
}

function report(label, e) {
    const pts = e.points, show = [1, 3, 4, 6, 8].filter(k => k < pts.length);
    const lines = [`${label}: ${e.origins} origins`];
    lines.push('channel'.padEnd(10) + show.map(k => `${pts[k]}s model/persist`.padStart(24)).join(''));
    e.channels.forEach((c, ch) => lines.push(c.padEnd(10) + show.map(k => `${e.rmse[ch][k].toFixed(2)} / ${e.persistence[ch][k].toFixed(2)}`.padStart(24)).join('')));
    return lines.join('\n');
}

async function main() {
    const args = process.argv.slice(2), dir = args[0], out = args[1]; fs.mkdirSync(out, { recursive: true });
    const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
    const { meta, runs } = loadRuns(dir), sp = split(runs);
    console.log(`runs ${runs.length}, train ${sp.train.length} (${(sp.train.reduce((s, r) => s + r.n / r.rate, 0)).toFixed(0)} s), test ${sp.test.length} (${(sp.test.reduce((s, r) => s + r.n / r.rate, 0)).toFixed(0)} s) flights ${sp.testFlights}`);
    const craft = H.craftPrior(opt('--craft') || meta.header['Craft name'] || 'fireball');
    const op = F.operatingPoint(sp.train.map(r => F.prepareRun(r)));
    let model = opt('--model') ? JSON.parse(fs.readFileSync(opt('--model'))) : Object.assign(T.createModel(craft, { refRpm: op.rpm }), { collRef: op.coll });
    console.log('craft', craft.craft, 'operating point', JSON.stringify(op));
    const prepTest = sp.test.map(r => F.prepareRun(r));
    let t0 = Date.now(); const e0 = F.predictionErrors(model, prepTest); console.log(report('initial test', e0), `\n(${Date.now() - t0} ms)`);
    const stages = opt('--fit') ? JSON.parse(fs.readFileSync(opt('--fit'))) : [];
    // profileAt must follow the decimation: pick every second sample like the other slow channels
    const prepProfile = r => { const p = F.prepareRun(r); p.profileAt = Float64Array.from({ length: p.n }, (_, i) => r.profileAt[i * (p.decimation || 1) + (p.decimation || 1) - 1]); return p; };
    const frd = F.operatingResponses(byProfile(sp.train.map(prepProfile)));
    console.log('frequency groups', frd.map(g => `${g.key} ${g.seconds.toFixed(0)} s at ${g.op.rpm} rpm`).join(', '));
    fs.writeFileSync(path.join(out, 'frd_train.json'), JSON.stringify(frd));
    if (!opt('--model')) model.constants.gyroLowpassHz = meta.header.gyro_lowpass2_hz || meta.header.gyro_lowpass_hz || 0;
    if (stages.length) {
        const P = pool(dir, sp.train, Math.min(9, os.cpus().length - 1), F.RULES);
        for (const st of stages) {
            console.log(`stage ${st.name}: ${st.free.join(' ')}`);
            t0 = Date.now();
            const timeResiduals = st.frequencyOnly ? async ms => ms.map(() => ({ residuals: new Float64Array(0) })) : ms => P.manyParallel(ms, st.weights, st.rules, st.disturbanceWeight);
            const r = await F.fit(model, null, { free: st.free, iterations: st.iterations || 15, weights: st.weights, residualsMany: timeResiduals,
                extraResiduals: st.frequencyWeight ? m => F.frequencyResiduals(m, frd, st.frequencyWeight) : null, log: s => console.log('  ' + s) });
            model = r.model; console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s`, JSON.stringify(Object.fromEntries(st.free.map(n => [n, +model.params[n].toPrecision(4)]))));
            fs.writeFileSync(path.join(out, 'model.json'), JSON.stringify(model, null, 1));
        }
        P.close();
    }
    const testProfiles = sp.test.map(prepProfile), v = F.validate(model, testProfiles, byProfile(testProfiles)), a = F.assess(v), eTest = v.prediction;
    console.log(report('test', eTest));
    console.log('assessment', a.status, JSON.stringify(a.prediction.map(q => [q.axis, +q.rmse.toFixed(1), +q.persistence.toFixed(1)])),
        JSON.stringify(a.frequency.map(q => [q.axis, q.bins, q.medianLogMagnitude && +q.medianLogMagnitude.toFixed(2), q.medianPhaseDeg && +q.medianPhaseDeg.toFixed(0)])), a.reasons.join(' | '));
    fs.writeFileSync(path.join(out, 'validation.json'), JSON.stringify({ frequency: v.frequency, assessment: a }));
    fs.writeFileSync(path.join(out, 'model.json'), JSON.stringify(model, null, 1));
    fs.writeFileSync(path.join(out, 'eval_test.json'), JSON.stringify(eTest));
}
main().catch(e => { console.error(e); process.exit(1); });
