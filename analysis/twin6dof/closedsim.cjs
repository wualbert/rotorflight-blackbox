// Closed-loop simulation windows: the native Rotorflight 4.6 controller flies the twin with the recorded pilot inputs.
const fs = require('fs');
const T = require('../../tools/autotune/heli_twin.cjs'), F = require('../../tools/autotune/twin_fit.cjs');
const FW = require('../../tools/autotune/firmware_controller.cjs');

function parseCli(text) {
    const global = {}, profiles = {}; let cur = global;
    for (const line of text.split(/\r?\n/)) {
        let m;
        if ((m = /^profile (\d+)/.exec(line))) { cur = profiles[+m[1]] = {}; continue; }
        if (/^rateprofile /.test(line)) { cur = {}; continue; }
        if ((m = /^set (\S+) = (.*)$/.exec(line.trim()))) { const v = m[2].trim(); cur[m[1]] = /^-?\d+(\.\d+)?$/.test(v) ? +v : v; }
    }
    return { global, profiles };
}
function configFor(header, cli, profileAt) {
    const idx = profileAt === 0 ? 0 : profileAt - 1, config = FW.fromHeader(header, Object.assign({}, cli.global, cli.profiles[idx]), {});
    for (const f of FW.SCHEMA) { const v = config.values[f.name]; if (v !== undefined && (!Number.isInteger(v) || v < f.min || v > f.max)) delete config.values[f.name]; }
    return config;
}
// windows of one PID profile: { run, s0, win, pre, config }
function windows(runs, header, cli, windowS = 10, prefixS = 2, strideS) {
    const out = [];
    for (const run of runs) {
        const win = Math.round((windowS + prefixS) * run.rate), pre = Math.round(prefixS * run.rate), stride = Math.round((strideS || windowS + prefixS) * run.rate);
        for (let s0 = 0; s0 + win <= run.n; s0 += stride) {
            const prof = run.profileAt[s0 + pre];
            if (run.profileAt.subarray(s0, s0 + win).some(p => p !== prof)) continue;
            out.push({ run, s0, win, pre, profile: prof === 0 ? 1 : prof, config: configFor(header, cli, prof) });
        }
    }
    return out;
}

async function simulate(model, w, runtimeCache = new Map()) {
    const { run, s0, win, pre, config } = w, rate = run.rate;
    const key = JSON.stringify(config.values); let runtime = runtimeCache.get(key);
    if (!runtime) { runtime = await FW.create({ config }); runtimeCache.set(key, runtime); }
    runtime.reset();
    const sim = T.createSim(model, rate), m = { gyro: [0, 0, 0], att: [0, 0, 0] }, u = { u: [0, 0, 0] };
    const meas = i => { for (let a = 0; a < 3; a++) { m.gyro[a] = run.gyro[a][i]; m.att[a] = run.att[a][i]; } m.alt = run.alt[i]; m.vario = run.vario[i]; m.hs = run.hs[i]; m.thr = run.thr[i]; return m; };
    const inp = (i, mix) => { if (mix) { u.u = mix.u; u.coll = mix.coll; } else { u.u = [run.u[0][i], run.u[1][i], run.u[2][i]]; u.coll = run.coll[i]; } u.thr = run.thr[i]; u.vbat = run.vbat[i]; return u; };
    T.initState(sim, meas(s0)); for (let k = 0; k < sim.maxDelay; k++) T.push(sim, inp(s0)); sim.count = 0;
    const v = config.values, sc = [2e-4, 2e-4, 5e-4];
    runtime.seed({ axisError: ['roll', 'pitch', 'yaw'].map((a, k) => v[a + '_i_gain'] > 0 ? run.I[k][s0] / (v[a + '_i_gain'] * sc[k]) : 0), axisOffset: [0, 0, 0] });
    const sample = (i, gyro, first) => ({ setpoint: [run.sp[0][i], run.sp[1][i], run.sp[2][i]], gyro, collective: run.pcoll[i], headspeed: run.hs[i],
        throttle: run.thr[i], airborne: true, spooledUp: true, spoolUpRatio: 1, ttaIncrease: 0, saturation: [0, 0, 0],
        previousMixer: first ? [run.u[0][i - 1], run.u[1][i - 1], run.u[2][i - 1], run.coll[i - 1]] : undefined });
    const n = win - pre, pg = [0, 1, 2].map(() => new Float64Array(n)), pm = [0, 1, 2, 3].map(() => new Float64Array(n));
    const alpha = 1 - Math.exp(-2 * Math.PI * 50 / rate); let filt = null, mix = null, diverged = false;
    for (let i = s0 + 1; i < s0 + win; i++) {
        if (i - s0 < pre) {
            T.push(sim, inp(i - 1)); T.step(sim); T.observe(sim, meas(i));
            runtime.step(sample(i, [run.gyro[0][i], run.gyro[1][i], run.gyro[2][i]], i === s0 + 1));
            filt = [run.gyro[0][i], run.gyro[1][i], run.gyro[2][i]];
            continue;
        }
        T.push(sim, inp(i - 1, mix));
        try { T.step(sim); } catch (e) { diverged = true; break; }
        sim.x[15] = sim.x[30] = run.hs[i] * T.RPM;
        const k = i - s0 - pre, now = [sim.x[10] / T.DEG, sim.x[11] / T.DEG, sim.x[12] / T.DEG];
        for (let a = 0; a < 3; a++) filt[a] += alpha * (now[a] - filt[a]);
        const r = runtime.step(sample(i, filt.slice(), false));
        mix = { u: r.u, coll: r.collective };
        for (let a = 0; a < 3; a++) { pg[a][k] = now[a]; pm[a][k] = r.u[a]; } pm[3][k] = r.collective;
        if (Math.abs(now[0]) + Math.abs(now[1]) + Math.abs(now[2]) > 6000) { diverged = true; break; }
    }
    return { pg, pm, n, diverged };
}

const SCALE = { gyro: 15, mixer: 0.05 };
// residuals of one window: low-passed gyro and mixer (both 20 Hz) at 50 Hz
function residuals(w, sim, out = []) {
    const { run, s0, pre } = w, n = sim.n, step = Math.round(run.rate / 50), lp = x => F.lowpass(x, 20, run.rate);
    const recG = [0, 1, 2].map(a => lp(run.gyro[a].subarray(s0 + pre, s0 + pre + n))), recM = [0, 1, 2].map(a => lp(run.u[a].subarray(s0 + pre, s0 + pre + n)));
    const pg = sim.diverged ? null : sim.pg.map(lp), pm = sim.diverged ? null : sim.pm.slice(0, 3).map(lp);
    for (let i = step; i < n; i += step) for (let a = 0; a < 3; a++) {
        const eg = pg ? (pg[a][i] - recG[a][i]) / SCALE.gyro : 50, em = pm ? (pm[a][i] - recM[a][i]) / SCALE.mixer : 50, c = 3;
        for (const r of [eg, em]) out.push(Math.sign(r) * Math.sqrt(2 * c * c * (Math.sqrt(1 + (r / c) ** 2) - 1)));
    }
    return out;
}
module.exports = { parseCli, configFor, windows, simulate, residuals, SCALE };
