// Indirect closed-loop identification: the native controller flies the twin with the recorded pilot inputs; fit the
// twin so that both the gyro and the controller output (mixer) agree with the log.
// node closedfit.cjs <data dir> <start model> <cli> <out dir> '<free json>' [iterations] [frequencyWeight]
const fs = require('fs'), path = require('path'), os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const F = require('../../tools/autotune/twin_fit.cjs'), C = require('./closedsim.cjs'), { loadRuns, split, byProfile } = require('./runs.cjs');

function trainWindows(dir, cliFile, which) {
    const { meta, runs } = loadRuns(dir, { minRunS: 9 }), sp = split(runs), cli = C.parseCli(fs.readFileSync(cliFile, 'utf8'));
    return { meta, sp, ws: C.windows(which === 'test' ? sp.test : sp.train, meta.header, cli, 6, 2, 8) };
}

if (!isMainThread) {
    const { dir, cliFile, ids } = workerData, { ws } = trainWindows(dir, cliFile, 'train'), mine = ws.filter((w, i) => ids.includes(i)), cache = new Map();
    parentPort.on('message', async ({ job, model }) => {
        const res = [];
        for (const w of mine) C.residuals(w, await C.simulate(model, w, cache), res);
        parentPort.postMessage({ job, res });
    });
    return;
}

(async () => {
    const [dir, start, cliFile, out, freeJson, itArg, fwArg] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
    const { sp, ws } = trainWindows(dir, cliFile, 'train'), size = Math.min(9, os.cpus().length - 1);
    console.log(`training windows ${ws.length}`);
    const shares = Array.from({ length: size }, () => []); ws.forEach((w, i) => shares[i % size].push(i));
    const workers = shares.map(ids => new Worker(__filename, { workerData: { dir, cliFile, ids } }));
    let job = 0; const waiting = new Map();
    workers.forEach((w, k) => w.on('message', ({ job, res }) => { const p = waiting.get(job); p.parts[k] = res; if (++p.count === workers.length) { waiting.delete(job); p.resolve(p.parts.flat()); } }));
    const one = model => new Promise(resolve => { const id = job++; waiting.set(id, { parts: [], count: 0, resolve }); workers.forEach(w => w.postMessage({ job: id, model })); });
    const prepProfile = r => { const p = F.prepareRun(r); p.profileAt = Float64Array.from({ length: p.n }, (_, i) => r.profileAt[i * 2 + 1]); return p; };
    const frd = F.operatingResponses(byProfile(sp.train.map(prepProfile))), fw = +(fwArg || 50);
    const model0 = JSON.parse(fs.readFileSync(start));
    const t0 = Date.now();
    const r = await F.fit(model0, null, { free: JSON.parse(freeJson), iterations: +(itArg || 15),
        residualsMany: async ms => Promise.all(ms.map(async m => ({ residuals: Float64Array.from(await one(m)) }))),
        extraResiduals: fw ? m => F.frequencyResiduals(m, frd, fw) : null, log: s => console.log('  ' + s) });
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s`, JSON.stringify(Object.fromEntries(r.free.map(n => [n, +r.model.params[n].toPrecision(4)]))));
    fs.writeFileSync(path.join(out, 'model.json'), JSON.stringify(r.model, null, 1));
    workers.forEach(w => w.terminate());
})().catch(e => { console.error(e); process.exit(1); });
