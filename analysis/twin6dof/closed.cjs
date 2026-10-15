// Closed-loop check: the Rotorflight 4.6 controller (native WASM) flies the twin with the recorded pilot setpoints.
// node closed.cjs <data dir> <model.json> <cli dump> <out json> [windowS]
const fs = require('fs'), path = require('path');
const T = require('../../tools/autotune/heli_twin.cjs'), F = require('../../tools/autotune/twin_fit.cjs');
const FW = require('../../tools/autotune/firmware_controller.cjs');
const { loadRuns, split } = require('./runs.cjs');

function parseCli(text) {
    const global = {}, profiles = {}, rates = {}; let cur = global;
    for (const line of text.split(/\r?\n/)) {
        let m;
        if ((m = /^profile (\d+)/.exec(line))) { cur = profiles[+m[1]] = {}; continue; }
        if ((m = /^rateprofile (\d+)/.exec(line))) { cur = rates[+m[1]] = {}; continue; }
        if ((m = /^set (\S+) = (.*)$/.exec(line.trim()))) { const v = m[2].trim(); cur[m[1]] = /^-?\d+(\.\d+)?$/.test(v) ? +v : v; }
    }
    return { global, profiles, rates };
}

async function main() {
    const [dir, modelFile, cliFile, out, windowArg] = process.argv.slice(2), windowS = +(windowArg || 10), prefixS = 2;
    const model = JSON.parse(fs.readFileSync(modelFile)), cli = parseCli(fs.readFileSync(cliFile, 'utf8'));
    const { meta, runs } = loadRuns(dir, { minRunS: windowS + prefixS }), sp = split(runs);
    const header = meta.header, rows = [];
    for (const run of sp.test) {
        const rate = run.rate, win = Math.round((windowS + prefixS) * rate), pre = Math.round(prefixS * rate);
        for (let s0 = 0; s0 + win <= run.n; s0 += win) {
            const prof = run.profileAt[s0 + pre];
            if (run.profileAt.slice(s0, s0 + win).some(p => p !== prof)) continue;
            const idx = prof === 0 ? 0 : prof - 1; // before the first switch: the start profile (profile 1 here)
            const values = Object.assign({}, cli.global, cli.profiles[idx]);
            const config = FW.fromHeader(header, values, {});
            // values outside the controller schema (for example unset battery fields) fall back to firmware defaults
            for (const f of FW.SCHEMA) { const v = config.values[f.name]; if (v !== undefined && (!Number.isInteger(v) || v < f.min || v > f.max)) delete config.values[f.name]; }
            const runtime = await FW.create({ config });
            const sim = T.createSim(model, rate), m = { gyro: [0, 0, 0], att: [0, 0, 0] }, u = { u: [0, 0, 0] };
            const meas = i => { m.gyro = [0, 1, 2].map(a => run.gyro[a][i]); m.att = [0, 1, 2].map(a => run.att[a][i]); m.alt = run.alt[i]; m.vario = run.vario[i]; m.hs = run.hs[i]; return m; };
            const inp = (i, mix) => { u.u = mix ? mix.u : [0, 1, 2].map(a => run.u[a][i]); u.coll = mix ? mix.coll : run.coll[i]; u.thr = run.thr[i]; u.vbat = run.vbat[i]; return u; };
            T.initState(sim, meas(s0)); for (let k = 0; k < sim.maxDelay; k++) T.push(sim, inp(s0)); sim.count = 0;
            const sample = (i, gyro, first) => ({ setpoint: [0, 1, 2].map(a => run.sp[a][i]), gyro, collective: run.pcoll[i], headspeed: run.hs[i],
                throttle: run.thr[i], airborne: true, spooledUp: true, spoolUpRatio: 1, ttaIncrease: 0, saturation: [0, 0, 0],
                previousMixer: first ? [0, 1, 2].map(a => run.u[a][i - 1]).concat(run.coll[i - 1]) : undefined });
            // seed I terms from the log (pid_mode 3: error integral = I / (gain * scale))
            const v = config.values, scale = [2e-4, 2e-4, 5e-4];
            runtime.seed({ axisError: ['roll', 'pitch', 'yaw'].map((a, k) => v[a + '_i_gain'] > 0 ? run.I[k][s0] / (v[a + '_i_gain'] * scale[k]) : 0), axisOffset: [0, 0, 0] });
            const pred = { gyro: [[], [], []], mix: [[], [], [], []] }, rec = { gyro: [[], [], []], mix: [[], [], [], []] };
            let filt = null; const alpha = 1 - Math.exp(-2 * Math.PI * 50 / rate);
            let mix = null;
            for (let i = s0 + 1; i < s0 + win; i++) {
                if (i - s0 < pre) {
                    T.push(sim, inp(i - 1)); T.step(sim); T.observe(sim, meas(i));
                    runtime.step(sample(i, [0, 1, 2].map(a => run.gyro[a][i]), i === s0 + 1));
                    filt = [0, 1, 2].map(a => run.gyro[a][i]);
                    continue;
                }
                // closed loop: the controller sees the twin rate through the gyro low-pass filter
                T.push(sim, inp(i - 1, mix)); T.step(sim); sim.x[15] = run.hs[i] * T.RPM;
                const rateNow = [0, 1, 2].map(a => sim.x[10 + a] / T.DEG);
                filt = filt.map((f, a) => f + alpha * (rateNow[a] - f));
                const r = runtime.step(sample(i, filt, false));
                mix = { u: r.u, coll: r.collective };
                for (let a = 0; a < 3; a++) { pred.gyro[a].push(rateNow[a]); rec.gyro[a].push(run.gyro[a][i]); pred.mix[a].push(r.u[a]); rec.mix[a].push(run.u[a][i]); }
                pred.mix[3].push(r.collective); rec.mix[3].push(run.coll[i]);
                if (Math.max(...rateNow.map(Math.abs)) > 3000) throw new Error('diverged');
            }
            const lp = x => F.lowpass(Float64Array.from(x), 20, rate);
            const rms = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length);
            const std = a => { const mu = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - mu) ** 2, 0) / a.length); };
            const row = { run: run.id, start: s0 / rate, profile: idx + 1, gyro: [0, 1, 2].map(a => { const P = lp(pred.gyro[a]), R = lp(rec.gyro[a]), S = lp(run.sp[a].slice(s0 + pre, s0 + win));
                return { rmse: rms(P, R), setpointBaseline: rms(S, R), std: std(R) }; }),
                mixer: [0, 1, 2, 3].map(a => { const P = lp(pred.mix[a]), R = lp(rec.mix[a]); return { rmse: rms(P, R), std: std(R) }; }),
                trace: { rate: 100, gyroPred: pred.gyro.map(x => lp(x).filter((_, i) => i % 10 === 0).map(v => +v.toFixed(2))), gyroRec: rec.gyro.map(x => lp(x).filter((_, i) => i % 10 === 0).map(v => +v.toFixed(2))),
                    mixPred: pred.mix.map(x => lp(x).filter((_, i) => i % 10 === 0).map(v => +v.toFixed(4))), mixRec: rec.mix.map(x => lp(x).filter((_, i) => i % 10 === 0).map(v => +v.toFixed(4))),
                    setpoint: [0, 1, 2].map(a => run.sp[a].slice(s0 + pre, s0 + win).filter((_, i) => i % 10 === 0)) } };
            rows.push(row);
            console.log(row.run, row.start.toFixed(0), 'P' + row.profile, 'gyro rmse', row.gyro.map(g => `${g.rmse.toFixed(1)}(sp ${g.setpointBaseline.toFixed(1)}, std ${g.std.toFixed(0)})`).join(' '),
                'mixer', row.mixer.map(g => `${(g.rmse * 1000).toFixed(0)}/${(g.std * 1000).toFixed(0)}`).join(' '));
        }
    }
    const pool = k => [0, 1, 2].map(a => Math.sqrt(rows.reduce((s, r) => s + r.gyro[a][k] ** 2, 0) / rows.length));
    console.log('pooled gyro rmse', pool('rmse').map(v => v.toFixed(1)), 'setpoint-as-prediction', pool('setpointBaseline').map(v => v.toFixed(1)), 'std', pool('std').map(v => v.toFixed(1)));
    fs.writeFileSync(out, JSON.stringify({ windowS, prefixS, rows }));
}
main().catch(e => { console.error(e); process.exit(1); });
