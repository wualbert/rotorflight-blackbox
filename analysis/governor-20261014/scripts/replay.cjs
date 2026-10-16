'use strict';
// Open-loop parity of the native governor (controller.wasm, executeGovernor) with the logged governor:
// the WASM gets the recorded headspeed, stick, battery voltage, setpoint and gyro from the first frame of a log and runs
// the state machine and the PID; its throttle and terms are compared with motor[0], govP, govI, govF and the state events.
// usage: node replay.cjs <dump.BBL> <log index> <overrides.json> <endS>
// overrides.json: { values: { CLI name: value }, loopsPerFrame, gear: [num, den] }
const fs = require('node:fs');
const lib = require('../../../tools/autotune/lib.cjs');
const fw = require('../../../tools/autotune/firmware_controller.cjs');
const [file, li, ovFile, endS] = process.argv.slice(2);
const ov = JSON.parse(fs.readFileSync(ovFile, 'utf8'));
const app = lib.loadApp();
const extra = ['govP', 'govI', 'govD', 'govF', 'govSum', 'govTarget', 'govRequest', 'motor[0]', 'rcCommand[0]', 'rcCommand[1]', 'rcCommand[2]', 'rcCommand[3]', 'rcCommand[4]', 'Vbat'];
(async () => {
    for (const w of lib.segments(app, file, { whole: true, extra, logs: [+li] })) {
        if (!w.whole || w.fromS !== 0) continue;
        const cfg = fw.fromHeader(w.flight.header, ov.values, {});
        const values = Object.assign(fw.defaults(), cfg.values, ov.direct || {});
        const runtime = await fw.create({ config: { firmwareVersion: '4.6.0', firmwareRevision: fw.COMMIT, values, unknown: [], executeGovernor: true } });
        const x = w.extra, n = Math.min(w.n, Math.round(+endS * w.rate)), L = ov.loopsPerFrame || 1;
        const rows = { thr: [], P: [], I: [], F: [], tgt: [], hsGov: [] }; let stateAgree = 0, stateN = 0; const firstDiff = [];
        let out = null; const trace = [];
        for (let k = 0; k < n; k++) {
            const cmd = x['rcCommand[4]'][k] / 1000;
            const sample = { setpoint: w.sp.map(c => c[k]), gyro: w.gyro.map(c => c[k]), collective: w.coll[k] / 1000, headspeed: w.hs[k],
                spoolUpRatio: 1, throttle: x['motor[0]'][k] / 1000, ttaIncrease: 0, airborne: true, spooledUp: true,
                rcDeflection: [0, 1, 2, 3].map(a => x[`rcCommand[${a}]`][k] / 500), armed: true,
                rawMotorRpm: w.hs[k] * ov.gear[1] / ov.gear[0], batteryVoltage: x.Vbat[k] / 100, throttleCommand: cmd, throttleOff: !(cmd > 0) };
            for (let r = 0; r < L; r++) out = runtime.step(sample);
            const g = out.governor, st = w.govStateAt ? w.govStateAt[k] : null;
            if (st !== null) { stateN++; if (g.state === st) stateAgree++; else if (firstDiff.length < 8 && (!firstDiff.length || k - firstDiff[firstDiff.length - 1].k > 200)) firstDiff.push({ k, t: +(k / w.rate).toFixed(3), wasm: g.state, log: st }); }
            if (st === 4 && g.state === 4) {
                rows.thr.push(Math.round(g.throttle * 1000) - x['motor[0]'][k]); rows.P.push(Math.trunc(g.P * 1000) - x.govP[k]);
                rows.I.push(Math.trunc(g.I * 1000) - x.govI[k]); rows.F.push(Math.trunc(g.F * 1000) - x.govF[k]); rows.tgt.push(Math.trunc(g.targetHS) - x.govTarget[k]);
            }
            if (k % Math.round(w.rate) === 0) trace.push([+(k / w.rate).toFixed(0), g.state, st, Math.round(g.throttle * 1000), x['motor[0]'][k], Math.round(g.currentHeadSpeed), w.hs[k]]);
        }
        const stat = a => { const s = Float64Array.from(a).sort(); const r = Math.sqrt(a.reduce((q, v) => q + v * v, 0) / Math.max(1, a.length)); return { n: a.length, rms: +r.toFixed(2), p50: s[s.length >> 1], p01: s[Math.floor(s.length * 0.01)], p99: s[Math.floor(s.length * 0.99)], maxAbs: a.reduce((m, v) => Math.max(m, Math.abs(v)), 0) }; };
        console.log(JSON.stringify({ log: +li, endS: +endS, stateAgreement: +(stateAgree / stateN).toFixed(5), stateFrames: stateN, firstStateDifferences: firstDiff,
            activeBoth: { throttle: stat(rows.thr), P: stat(rows.P), I: stat(rows.I), F: stat(rows.F), target: stat(rows.tgt) }, trace: trace.filter((r, i) => i % 2 === 0).slice(0, 40) }, null, 0));
    }
})().catch(e => { console.error(e); process.exit(1); });
