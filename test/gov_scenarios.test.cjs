'use strict';

// Tests of tools/autotune/gov_scenarios.cjs: the scenario families of the governor autotune (docs/GOVERNOR_AUTOTUNE.md sections 5 and 7)
// with a synthetic twin and the native governor: the steady state in closed form, the twin set, the paired bootstrap, the power and
// battery-voltage tradeoff (scenarios E and F), the spool-up from a stopped motor (S), the target slope (tracking), the RPM signal errors
// (G), the maximum throttle test, the BYPASS curve, the voltage compensation numbers, the BAILOUT from a slow rotor, the rows of
// gov_tune.tune, the opt-in CLI text and the STE lint of every text.
//
//   node --test test/gov_scenarios.test.cjs
//   GOV_SCENARIOS_REAL=1 also runs the Fireball and Gaui dev data (analysis/governor-20261014/data and analysis/governor-twin/out, about
//   3 min; GOV_CLI=<RTFL_cli_SAB_Fireball_20261013_184504.txt> adds the Fireball CLI dump).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const GSC = require(path.join(ROOT, 'tools/autotune/gov_scenarios.cjs'));
const GS = require(path.join(ROOT, 'tools/autotune/gov_sim.cjs'));
const GD = require(path.join(ROOT, 'tools/autotune/gov_data.cjs'));
const GT = require(path.join(ROOT, 'tools/autotune/gov_twin.cjs'));
const GTU = require(path.join(ROOT, 'tools/autotune/gov_tune.cjs'));
const ADV = require(path.join(ROOT, 'tools/autotune/advice.cjs'));
const F = require(path.join(ROOT, 'tools/autotune/firmware_controller.cjs'));

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (tol ${tol})`);
const PROFILE_FIELDS = F.SCHEMA.filter(f => f.member.startsWith('profile.governor.')).map(f => f.name);
const pick = (o, names) => Object.fromEntries(names.filter(k => k in o).map(k => [k, o[k]]));

// ---------------------------------------------------------------------------------------------
// a synthetic craft: a Fireball-like twin (a power limit at the end of the battery, an ESC soft start) flown by the native governor
// ---------------------------------------------------------------------------------------------

const TRUTH = GT.copy(GT.defaults({ kv: 290, Href: 4500, V0: 25 }), { tm: 0.3, te: 0.05, ass: 650, asr: 0.2, as0: 150, as1: 250, u0: 0.1, sneg: 2, q0: 1.5, qc: 4, qx: 0.5, qy: 0.3,
    qf: 0.2, qs: 0.1, pc: 2, c0: -0.1, beta: 0.12, kappa: 0.004, tv: 0.06, vp: 0.3 });
const GOV = { gov_mode: 3, gov_throttle_type: 2, gov_startup_time: 100, gov_spoolup_time: 80, gov_tracking_time: 50, gov_recovery_time: 20, gov_spooldown_time: 30,
    gov_handover_throttle: 25, gov_autorotation_timeout: 15, gov_throttle_hold_timeout: 50, gov_rpm_filter: 10, gov_ff_filter: 5, gov_d_filter: 50, gov_pwr_filter: 5, tail_rotor_mode: 0, main_rotor_dir: 0 };
const PROF = { gov_flags: 0, gov_headspeed: 4500, gov_gain: 55, gov_p_gain: 18, gov_i_gain: 60, gov_d_gain: 2, gov_f_gain: 32, gov_p_limit: 30, gov_i_limit: 95, gov_d_limit: 5,
    gov_f_limit: 40, gov_yaw_weight: 5, gov_cyclic_weight: 35, gov_collective_weight: 100, gov_collective_curve: 20, gov_max_throttle: 100, gov_min_throttle: 10, gov_fallback_drop: 10 };
const CLI_G = { gov_mode: 'ELECTRIC', gov_throttle_type: 'FUNCTION', gov_startup_time: 100, gov_spoolup_time: 80, gov_tracking_time: 50, gov_recovery_time: 20, gov_spooldown_time: 30,
    gov_handover_throttle: 25, gov_autorotation_timeout: 15, gov_pwr_filter: 5 };
const CLI_P = (h) => ({ gov_headspeed: h, gov_max_throttle: 100, gov_use_pid_spoolup: 'OFF', gov_use_fallback_precomp: 'OFF', gov_fallback_drop: 10, gov_use_voltage_comp: 'OFF' });
// the configuration of gov_sim (configOf) for the synthetic logs: PID profile 1 at 4500 rpm, PID profile 2 at 4000 rpm
function cfgOf(start = 1, changes = [], o = {}) {
    const d = F.defaults();
    return { global: Object.assign({}, d, GOV), profiles: { 1: Object.assign(pick(d, PROFILE_FIELDS), PROF), 2: Object.assign(pick(d, PROFILE_FIELDS), PROF, { gov_headspeed: 4000 }) },
        cli: { global: Object.assign({}, CLI_G), profiles: { 1: CLI_P(4500), 2: CLI_P(4000) } }, gear: null, voltageSource: o.voltageSource || 'ESC', cells: 6, assumptions: [], flags: [], excluded: null,
        start, changes };
}
// the inputs of a flight at 1 kHz: f(t) -> { thr, coll, roll, pitch, yaw, profile }, the rest voltage vrest
function inputs(log, seconds, f, vrest = 25.2) {
    const rate = 1000, n = Math.round(seconds * rate), c = { time: new Float64Array(n), hs: new Float32Array(n), 'motor[0]': new Float32Array(n), 'rcCommand[4]': new Float32Array(n),
        'mixer[0]': new Float32Array(n), 'mixer[1]': new Float32Array(n), 'mixer[2]': new Float32Array(n), 'mixer[3]': new Float32Array(n), Vbat: new Float32Array(n), profileAt: new Uint8Array(n), flightModeFlags: new Uint8Array(n) };
    for (let i = 0; i < n; i++) {
        const t = i / rate, v = f(t);
        c.time[i] = t; c['rcCommand[4]'][i] = v.thr * 1000; c.Vbat[i] = 100 * vrest; c.profileAt[i] = v.profile || 1; c.flightModeFlags[i] = 1;
        ['roll', 'pitch', 'yaw', 'coll'].forEach((k, j) => { c[`mixer[${j}]`][i] = (v[k] || 0) * 1000; });
    }
    return { c, meta: { log, n, rate, actualRate: rate, timeStartUs: 20e6, header: { looptime: 500, pid_process_denom: 2, vbatcellvoltage: [330, 350, 430], features: (1 << 26) | (1 << 28) } } };
}
// a logged flight: the native governor flies TRUTH (gov_sim plant 'twin'); the log records the twin headspeed, the throttle, the governor
// state, target, request and I-term, and the twin battery voltage. forceFallback: the times of a FALLBACK in the log
async function flight(log, seconds, f, o = {}) {
    const { c, meta } = inputs(log, seconds, f, o.vrest), cfg = cfgOf(1, o.changes || [], o), pre = GD.fromColumns(c, meta, { class: 'flight', flights: [] });
    const res = await GS.run(pre, cfg, { plant: 'twin', twin: o.twin || TRUTH, record: { points: 1e9 }, scenario: { forceFallback: o.forceFallback || [] } });
    const tr = res.trace, n = meta.n;
    c.hs = Float32Array.from(tr.hs); c['motor[0]'] = Float32Array.from(tr.u, v => Math.round(1000 * v)); c.govStateAt = Uint8Array.from(tr.state); c.Vbat = Float32Array.from(tr.vbat, v => Math.round(100 * v));
    c.govTarget = Float32Array.from(tr.target); c.govI = Float32Array.from(tr.I, v => Math.trunc(1000 * v)); c.govRequest = new Float32Array(n);
    for (let i = 0; i < n; i++) c.govRequest[i] = cfg.profiles[tr.profile[i]].gov_headspeed;
    const run = GD.fromColumns(c, Object.assign({}, meta, { name: `log${log}` }), { class: 'flight', flights: [{ i0: 0, i1: n, t0: 0, t1: seconds }] });
    return { run, cfg };
}
// FUNCTION throttle: off, then RUN; a hover with collective movements to 1.1 every 6 s (0.4 s), the cyclic and the yaw; at 60 s the middle
// position (AUTOROTATION), at 63 s off (the rest voltage at the end)
const flying = (t) => {
    if (t < 0.5) return { thr: 0, coll: -0.1 };
    if (t < 12) return { thr: 1, coll: -0.15, yaw: 0.05 };
    if (t >= 60) return { thr: t < 63 ? 0.5 : 0, coll: -0.1 };
    const k = (t - 12) % 6, pump = k > 5 && k < 5.4;
    return { thr: 1, coll: pump ? 1.1 : 0.3 + 0.1 * Math.sin(1.3 * t), roll: 0.1 * Math.sin(2.1 * t), pitch: 0.1 * Math.cos(1.7 * t), yaw: 0.15 * Math.sin(3 * t) };
};
// the test flight: 140 s, the same pattern, the middle position at 130 s
const longer = (t) => t >= 130 ? flying(t - 70) : t >= 60 ? flying(12 + ((t - 60) % 48)) : flying(t);
let SET = null;
// three flights: the third is the test flight; log 1 has a FALLBACK at the maximum throttle of a collective movement
async function craft() {
    if (SET) return SET;
    const a = await flight(0, 70, flying), b = await flight(1, 70, flying, { forceFallback: [41.3] }), c = await flight(2, 140, longer, { vrest: 24.6 });
    const runs = [a.run, b.run, c.run], configs = {};
    for (const x of [a, b, c]) configs[GS.keyOf(x.run)] = x.cfg;
    const model = { params: TRUTH, samples: [GT.copy(TRUTH, { kv: 285, qc: 4.3 }), GT.copy(TRUTH, { kv: 295, tm: 0.36, qc: 3.8 }), GT.copy(TRUTH, { te: 0.03, tm: 0.27 })],
        uncertainty: { ass: { p5: 600, p95: 700 } }, split: { mode: 'logs', testLogs: [2] }, has: { voltage: true, current: true } };
    return (SET = { runs, configs, model });
}
const evalOf = async (steps, o = {}) => { const s = await craft(); return GSC.evaluate(s.runs, Object.assign({ model: s.model, configs: s.configs, steps }, o)); };

// ---------------------------------------------------------------------------------------------
// the parts
// ---------------------------------------------------------------------------------------------

test('dReq is the steady state of gov_twin in closed form; at another headspeed the inputs keep the thrust', () => {
    const p = TRUTH;
    for (const [H, coll, cyc, yaw, ocv] of [[4500, 0.3, 0.1, 0.1, 22], [4000, 0.9, 0.2, 0.3, 24.9], [3000, -0.4, 0, 0.5, 21.5], [4500, 1.1, 0.3, 0.2, 21.9]]) {
        const s = GT.steady(p, { H, coll, cyc, yaw, ocv }), d = GSC.dReq(p, H, Math.abs(coll - p.c0) ** p.pc, cyc, Math.abs(yaw), ocv);
        near(d, s.d, 1e-9, `H ${H} coll ${coll}`);
    }
    // the same thrust at r = H/Hf (blocksOf): the collective coll/r² (the thrust pivot is the zero blade pitch, not c0), the cyclic and the yaw /r²
    const H = 4000, Hf = 4500, r2 = (H / Hf) ** 2, S1 = { k: 1, coll: [0.5], cyc: [0.2], yaw: [-0.1], u: [0.6], vbat: null }, B = GSC.blocksOf(p, S1, H / Hf, { lo: -1, hi: 1, cyc: 1, yaw: 1 });
    near(GSC.dReq(p, H, B.A[0], B.X[0], B.Y[0], 22), GT.steady(p, { H, coll: 0.5 / r2, cyc: 0.2 / r2, yaw: 0.1 / r2, ocv: 22 }).d, 1e-9, 'same thrust');
    near(GSC.blocksOf(p, S1, H / Hf, { lo: -1, hi: 0.55, cyc: 1, yaw: 1 }).A[0], Math.abs(0.55 - p.c0) ** p.pc, 1e-12, 'the collective range of the flights');
    // no voltage: the constant V0 (kv per throttle unit)
    const nv = GT.copy(GT.defaults({ kv: 290 * 25, Href: 4500 }), { q0: 0.06, qc: 0.16, qx: 0.02, qy: 0.012, qf: 0.008, pc: 2 });
    near(GSC.dReq(nv, 4500, 0.09, 0.1, 0.1, 22), GT.steady(nv, { H: 4500, coll: 0.3, cyc: 0.1, yaw: 0.1 }).d, 1e-9, 'no voltage');
});

test('the twin set: the extremes of tm, kv, the load and te, the tm-scan winner when tmBand fails; the soft-start sets scale the ramp', () => {
    const S = [GT.copy(TRUTH, { tm: 0.2 }), GT.copy(TRUTH, { tm: 0.5 }), GT.copy(TRUTH, { kv: 270 }), GT.copy(TRUTH, { kv: 310, qc: 6 }), GT.copy(TRUTH, { te: 0.02 }), GT.copy(TRUTH, { te: 0.09 }), GT.copy(TRUTH, { q0: 0.1 }), GT.copy(TRUTH)];
    const set = GSC.twinSet({ params: TRUTH, samples: S, has: { current: true } }, null, { coll: 0.3, cyc: 0.1, yaw: 0.1 });
    assert.equal(set[0].key, 'main'); assert.ok(set.length <= 1 + GSC.RULES.twins.max);
    for (const [k, v] of [['tm', 0.2], ['tm', 0.5], ['kv', 270], ['kv', 310]]) assert.ok(set.some(t => t.p[k] === v), `${k} ${v}`);
    assert.ok(set.some(t => t.p.q0 === 0.1), 'the lowest load');
    assert.ok(!set.some(t => t.factor), 'no tm twin without a tmBand failure');
    const v = { checks: [{ rule: 'tmBand', pass: false }], tmScan: [{ factor: 0.7, band: 0.7 }, { factor: 1.4, band: 0.5 }, { factor: 2, band: 0.6 }] };
    const w = GSC.twinSet({ params: TRUTH, samples: [], has: { current: true } }, v), tw = w.find(t => t.factor);
    assert.equal(w.length, 2); assert.equal(tw.factor, 1.4); assert.ok(tw.scan); near(tw.p.tm, 1.4 * TRUTH.tm, 1e-12);
    // without battery current (critique C13): tm x 0.7 and x 1.4, the tm-scan winner once
    const nc = GSC.twinSet({ params: TRUTH, samples: [], has: { current: false } }, v);
    assert.deepEqual(nc.map(t => [t.key, !!t.scan, !!t.noCurrent]), [['main', false, false], ['tm1.4', true, false], ['tm0.7', false, true]]);
    assert.deepEqual(GSC.twinSet({ params: TRUTH, samples: [] }, null).map(t => t.factor || 1), [1, 0.7, 1.4], 'the twin parameters have no current');
    const soft = GSC.softSet({ params: TRUTH, uncertainty: { ass: { p5: 520, p95: 715 } } });
    assert.deepEqual(soft.map(s => s.key), ['softSlow', 'softFast']);
    near(soft[0].p.ass, 520, 1e-9); near(soft[0].p.as1 / TRUTH.as1, 0.8, 1e-9); near(soft[1].p.asr / TRUTH.asr, 1.1, 1e-9);
    assert.equal(soft[0].p.u0, TRUTH.u0);
});

test('the paired bootstrap: a consistent effect passes, an effect in the noise does not, too few blocks cannot', () => {
    const big = Array.from({ length: 30 }, (_, i) => 2 + Math.sin(i)), noise = Array.from({ length: 30 }, (_, i) => Math.sin(1.7 * i));
    const a = GSC.bootstrap(big), b = GSC.bootstrap(noise), c = GSC.bootstrap([5]);
    assert.ok(a.pass && a.mean > 2 * a.se && a.lo > 0, JSON.stringify(a));
    assert.ok(!b.pass, JSON.stringify(b)); assert.ok(!c.pass && c.se === null);
    assert.deepEqual(GSC.bootstrap(big), a, 'seeded');
    const acc = GSC.acceptOf([{ key: 'main', boot: a }, { key: 's1', boot: GSC.bootstrap(big.map(x => x + 1)) }]);
    assert.ok(acc.pass && acc.lo < acc.hi && acc.n === 30);
    assert.ok(!GSC.acceptOf([{ key: 'main', boot: a }, { key: 's1', boot: b }]).pass, 'every twin of the set must pass');
});

test('glitchSets: errors at least gapS apart in each simulation', () => {
    const sets = GSC.glitchSets([10, 12, 30, 15, 50, 51, 70], 8);
    for (const s of sets) for (let j = 1; j < s.length; j++) assert.ok(s[j] - s[j - 1] >= 8, JSON.stringify(sets));
    assert.equal(sets.flat().length, 7);
});

// ---------------------------------------------------------------------------------------------
// the families on the synthetic craft
// ---------------------------------------------------------------------------------------------

test('power: the throttle reserve fails at the end of the battery, the voltage curve, a lower headspeed with the same thrust', async (t) => {
    const S = await evalOf(['power']), x = S.power.profiles[1];
    t.diagnostic(`levels ${JSON.stringify(S.ocv)}; q95 E ${x.qE[1]}, F ${x.qF[1]}; E share ${x.E.share}, F ${x.F.share}; hmax ${x.hmax}; same ${x.hmaxSame}; candidate ${x.candidate}; accept ${JSON.stringify(x.accept && [x.accept.pass, x.accept.mean, x.accept.lo, x.accept.hi])}; ${S.timing.power} s`);
    assert.equal(S.ocv.cells, 6); near(S.ocv.full, 25.2, 1e-9);
    // E: the training flights (the selection); A: all flights, here the test flight (the effect on the test flights)
    assert.ok(S.ocv.endSource === 'log' && S.ocv.endLog !== 2 && S.ocv.endAll < 24 && S.ocv.endAllLog === 2 && S.ocv.end > S.ocv.endAll, JSON.stringify(S.ocv));
    assert.ok(x.qE[1] > x.qF[1] && x.qE[1] > 1 - GSC.RULES.scnPower.reserve, 'E needs more throttle');
    assert.ok(x.fails && x.reserveE < GSC.RULES.scnPower.reserve);
    assert.ok(x.E.share > x.F.share && x.E.share > 0, 'saturation at the end of the battery');
    // the voltage curve rises as the voltage falls
    const c = S.power.curve.map(q => q.profiles[1].share); for (let j = 1; j < c.length; j++) assert.ok(c[j] <= c[j - 1] + 1e-4, JSON.stringify(c));
    // the largest headspeed: the reserve holds there for the main twin, with the same thrust and with the same collective
    const tw = TRUTH, ocv = S.ocv.end - tw.vp;
    assert.ok(x.hmaxMain < 4500 && x.hmaxSame[0] < 4500 && x.hmaxMain <= x.hmaxSame[0], 'the same thrust needs a lower headspeed than the same collective');
    // the log has the control action of the governor on top of the steady demand of the twin: the analysis adds the difference
    assert.ok(x.q95Log >= x.q95R - 0.01, `${x.q95Log} ${x.q95R}`); near(x.extra, Math.max(0, x.q95Log - x.q95R), 2e-4, 'extra');
    // the candidate: a step of maxChange at most, with the acceptance of the set
    assert.equal(x.candidate, Math.max(x.hmaxSet[0], Math.ceil(0.9 * 4500 / 10) * 10));
    assert.ok(x.accept && x.accept.twins.length === S.twins.length, 'every twin of the set');
    assert.ok(x.accept.pass, 'a lower headspeed decreases the time above the reserve line on the test flight');
    near(x.accept.rest, S.ocv.endAll, 0.01, 'the acceptance at A');
    void ocv;
});

test('power: a candidate headspeed is different from the headspeed of each other PID profile by a step (govRequest gives the PID profile)', async () => {
    const s = await craft(), configs = {};
    for (const [k, c] of Object.entries(s.configs)) configs[k] = Object.assign({}, c, { cli: { global: c.cli.global, profiles: Object.assign({}, c.cli.profiles, { 2: Object.assign({}, c.cli.profiles[2], { gov_headspeed: 4050 }) }) } });
    const S = await GSC.evaluate(s.runs, { model: s.model, configs, steps: ['power'] }), x = S.power.profiles[1];
    assert.deepEqual(x.unique, { from: 4050, profile: 2, to: 4060 }, 'the 10 % step sets the candidate: the next step up');
    assert.equal(x.candidate, 4060);
});

test('the maximum throttle test: a lower maximum gives more time at the (lower) maximum and a larger droop at the end of the battery', async () => {
    const S = await evalOf(['power', 'trial']), y = S.trial.profiles[1], base = S.power.profiles[1].E;
    assert.ok(y[98].share >= base.share && y[95].share >= y[98].share, JSON.stringify({ y, base }));
    assert.ok(y[98].shareSet[0] <= y[98].share && y[98].share <= y[98].shareSet[1]);
});

// check G21 (health_gov, the detector and the test of the analysis): sudden changes of the headspeed signal at the maximum throttle only.
// The model flies the value of the change of check G21 (100 - 3) with the twin set; the row gives its cost as evidence, a check with no
// CLI text of its own (the CLI text is the one of check G21 in the analysis: no second set line in the export)
test('the maximum throttle test with check G21: the model gives the cost of its value, a check with no CLI text of its own', async () => {
    const s = await craft();
    // +400 rpm for one sample (a sudden change of check G21) at 2 samples of each run with the throttle at its maximum in ACTIVE, 0.5 s apart
    const runs = s.runs.map(r => { const q = Object.assign(Object.create(Object.getPrototypeOf(r)), r, { hs: Float32Array.from(r.hs) }); let last = -1e9, k = 0;
        for (let i = 0; i < q.n && k < 2; i++) if (q.state[i] === 4 && q.u[i] >= 0.999 && q.time[i] - last > 0.5) { q.hs[i] += 400; last = q.time[i]; k++; }
        return q; });
    const S = await GSC.evaluate(runs, { model: s.model, configs: s.configs, steps: ['power', 'trial'] });
    const G = GTU.tune(runs, {}).measures.glitch;
    assert.ok(G.all.k >= 3 && G.all.k === G.all.N && G.byProfile['1'].severity === 'flag', JSON.stringify(G.all));
    assert.deepEqual(S.trial.g21, [97]); assert.ok(S.trial.values.includes(97) && S.trial.values.includes(95) && S.trial.values.includes(98), JSON.stringify(S.trial.values));
    const y = S.trial.profiles[1][97]; assert.ok(y && Number.isFinite(y.share) && y.shareSet[0] <= y.share && y.share <= y.shareSet[1], JSON.stringify(y));
    const res = GSC.finish(GTU.tune(runs, { families: { maxThrottle: GSC.families(S).maxThrottle } }));
    const row = res.rows.find(r => r.name === 'gov_max_throttle' && r.topic === 'model' && r.profile === 1);
    assert.equal(row.status, 'check'); assert.match(row.title, /"gov_max_throttle" 97 of check G21/); assert.ok(!row.optIn, 'no opt-in CLI text: the change is the one of check G21');
    assert.match(row.text, /^Check G21 of the analysis gives "gov_max_throttle" 97 with its CLI text\./); assert.ok(row.evidence.some(e => / with 97 %/.test(e.text)), JSON.stringify(row.evidence.map(e => e.text)));
    const rec = res.recommendations.find(x => x.row === row.id); assert.deepEqual([rec.severity, rec.cli], ['check', []]);
    // the cost for the recommendation of check G21 (js/tuning_dialog.js modelNote, review 2026-10-15): the droop with 97 % and at this time
    assert.deepEqual([row.g21Cost.to, row.g21Cost.droop, row.g21Cost.droopNow], [97, +y.droop95.toFixed(4), +S.power.profiles[1].E.droop95.toFixed(4)]);
    assert.match(row.g21Cost.text, /^In the governor model, a maximum of 97 % (?:increases|decreases|does not change) the headspeed decrease/);
    assert.doesNotMatch(ADV.exportScript(res.recommendations, res.recommendations.map(x => x.id), {}), /set gov_max_throttle/);
    // the model has no result for the value of check G21: the same check with no cost, never the opt-in CLI text of the test of 98 %
    const S1 = Object.assign({}, S, { trial: Object.assign({}, S.trial, { profiles: { 1: Object.fromEntries(Object.entries(S.trial.profiles[1]).filter(([v]) => v !== '97')) } }) });
    const res1 = GSC.finish(GTU.tune(runs, { families: { maxThrottle: GSC.families(S1).maxThrottle } }));
    const row1 = res1.rows.find(r => r.name === 'gov_max_throttle' && r.topic === 'model' && r.profile === 1);
    assert.deepEqual([row1.status, !!row1.optIn, row1.evidence.length], ['check', false, 0]); assert.match(row1.text, /The model did not fly this value\. Thus, this row does not show its effect\./);
    assert.doesNotMatch(ADV.exportScript(res1.recommendations, res1.recommendations.map(x => x.id), {}), /set gov_max_throttle/);
    // without check G21: the test of 95 % and 98 % as before (the opt-in CLI text of 98 % with a FALLBACK at the maximum throttle)
    const S0 = await evalOf(['power', 'trial']); assert.deepEqual([S0.trial.g21, S0.trial.values], [[], [95, 98]]);
});

// review 2026-10-15: the row of a PID profile with no change of check G21 follows the rule of check G21 (health_gov g21Pool minOkS): no
// sudden change in less than 12 s at the maximum is "not measured", never "no RPM signal error ... Keep 100 %"
test('the maximum throttle test without a change of check G21: less than minOkS at the maximum is not measured', async () => {
    const s = await craft(), S0 = await evalOf(['power', 'trial']), fam = GSC.families(S0).maxThrottle;
    const rowOf = (q) => GTU.tune(s.runs, { families: { maxThrottle: (ctx) => { ctx.M.fallbacks = []; ctx.M.glitch = Object.assign({}, ctx.M.glitch, { fires: false, byProfile: q ? { 1: q } : {} }); return fam(ctx); } } })
        .rows.find(r => r.name === 'gov_max_throttle' && r.topic === 'model' && r.profile === 1);
    const short = rowOf({ k: 0, N: 1, atMaxS: 4.02, severity: 'note', ceilings: [] });
    assert.match(short.text, /^The logs have only 4\.02 s at the maximum throttle in this PID profile, and a minimum of 12 s is necessary\. Thus, the logs cannot show that the RPM signal has no errors at the maximum throttle\./);
    assert.doesNotMatch(short.text, /no RPM signal error at the maximum throttle|Keep 100 %/); assert.ok(!short.optIn, 'no opt-in CLI text');
    assert.ok(['check', 'not-recorded'].includes(short.status), short.status);
    const none = rowOf(null);
    assert.match(none.text, /^The logs have no time at the maximum throttle in this PID profile\. Thus, the logs cannot show that the RPM signal has no errors at the maximum throttle\./);
    // 12 s or more at the maximum with no sudden change: no error at the maximum, as before
    const long = rowOf({ k: 0, N: 0, atMaxS: 30, severity: 'ok', ceilings: [] });
    assert.match(long.text, /^The flight logs of this PID profile have no RPM signal error at the maximum throttle\. Thus, the test is not necessary\./); assert.match(long.text, /Keep 100 % for the power\./);
    assert.equal(GSC.RULES.scnTrial.id, 'GC6');
});

test('scenario S: the ESC soft start gives an overshoot at a short spool-up time; the search finds the value or the PID spool-up', async (t) => {
    const S = await evalOf(['spool']), X = S.spool;
    t.diagnostic(`current ${JSON.stringify(X.current.main)} set ${JSON.stringify(X.current.set)}, log ${X.logMedian}; min ${X.minCurrent}, PID ${X.minPid}, now with PID ${X.pidNow}; candidate ${JSON.stringify(X.candidate)}; accept ${JSON.stringify(X.accept && [X.accept.pass, X.accept.mean, X.accept.n])}; ${S.timing.spool} s`);
    assert.ok(X.current.main[1] > GSC.RULES.scnSpool.overshoot, 'the overshoot at 80');
    assert.ok(!X.passNow);
    assert.ok(X.logMedian > GSC.RULES.scnSpool.overshoot, 'the log (the native governor on the twin) has the overshoot too');
    assert.ok(Number.isFinite(X.minPid) || X.pidNow, 'the PID spool-up finds a value');
    if (Number.isFinite(X.minCurrent)) assert.ok(X.minCurrent > 80, 'a longer ramp without the PID spool-up');
    // the scan of the main twin: a longer time gives less overshoot
    const os = X.scan.map(q => Math.max(...q.os)); assert.ok(os[os.length - 1] < os[0], JSON.stringify(os));
    assert.ok(X.candidate && X.accept, 'a candidate with its acceptance on the test spool-ups');
});

test('scenario S with the PID spool-up unknown: the model uses the default OFF, the candidate keeps the flags, the row says that the log does not record it', async (t) => {
    const s = await craft(), configs = {};
    for (const [k, c] of Object.entries(s.configs)) configs[k] = Object.assign({}, c, { cli: { global: c.cli.global, profiles: Object.fromEntries(Object.entries(c.cli.profiles).map(([p, v]) => { const q = Object.assign({}, v); delete q.gov_use_pid_spoolup; return [p, q]; })) } });
    const S = await GSC.evaluate(s.runs, { model: s.model, configs, steps: ['spool'] }), X = S.spool;
    t.diagnostic(JSON.stringify({ flags: X.current.flags, candidate: X.candidate, minCurrent: X.minCurrent, minPid: X.minPid }));
    assert.equal(X.current.flags[1], 'unknown');
    assert.ok(X.candidate && X.candidate.flags[1] === 'unknown' && X.candidate.value === X.minCurrent, 'a change of an unknown value has no CLI text: the value with the flags at this time');
    const res = GTU.tune(s.runs, { families: GSC.families(S) }), r = res.rows.find(q => q.name === 'gov_use_pid_spoolup' && q.profile === 1 && q.topic === 'model');
    if (r.current.value === null) assert.ok(r.text.startsWith(GSC.TEXT.spool.unknownPid('OFF')) && !/The value is OFF/.test(r.text), r.text);
    assert.notEqual(r.status, 'change');
});

test('tracking: the smallest time keeps the target slope at the acceleration below the maximum throttle; the closed loop agrees', async (t) => {
    const S = await evalOf(['tracking']), x = S.tracking.profiles[1];
    assert.ok(x.acc > 0 && x.min > 0, JSON.stringify(x));
    // the analytic value: 10 max(Hf, Kmot) / the acceleration at the maximum throttle (0.1 s units)
    near(x.min, Math.ceil(10 * Math.max(4500, x.kmot) / x.acc), 1, 'the smallest time');
    // the closed loop: a PID profile change 4000 -> 4500 rpm at a high load at the end of the battery: the smallest time of the set gives
    // no more time at the maximum throttle than a target step (0.1 s)
    const f = (tt) => Object.assign(flying(Math.min(tt, 50)), { coll: tt < 0.5 ? -0.1 : tt < 12 ? -0.15 : 0.8, profile: tt < 20 ? 2 : 1 });
    const end = S.ocv.end, { c, meta } = inputs(9, 30, f, end), run = GD.fromColumns(c, meta, { class: 'flight', flights: [] }), cfg = cfgOf(2, [{ k: 20000, at: 20000, profile: 1 }]);
    const sat = async (T) => { const r = await GS.run(run, cfg, { plant: 'twin', twin: GT.copy(TRUTH, { kappa: 0 }), scenario: { ocv: end, values: { global: { gov_tracking_time: T } } }, record: { points: 1e9 } });
        let k = 0; for (let i = 20000; i < 25000; i++) if (r.trace.u[i] >= 0.995) k++; return k / 1000; };
    const a = await sat(1), b = await sat(x.minSet[1]);
    t.diagnostic(`acceleration ${x.acc} rpm/s, Kmot ${x.kmot}, smallest ${x.min} (${x.minSet}); saturated ${a} s with 1, ${b} s with ${x.minSet[1]}`);
    assert.ok(b <= a && b < 0.2, `${a} ${b}`);
});

test('scenario G: an RPM signal error at each saturation period and at seeded ACTIVE times; precomp ON and a smaller drop decrease the loss', async (t) => {
    const S = await evalOf(['fallback']), X = S.fallback;
    t.diagnostic(`tried ${JSON.stringify(X.tried.map(q => [JSON.stringify(q.values), q.loss, q.min, q.n]))}; best ${JSON.stringify(X.best)}; accept ${JSON.stringify(X.accept && [X.accept.pass, X.accept.mean, X.accept.n])}; ${S.timing.fallback} s`);
    assert.ok(X.times.every(r => r.list.filter(q => q.kind === 'random').length === GSC.RULES.scnFallback.random), 'the seeded times');
    assert.ok(X.times.every(r => r.list.some(q => q.kind === 'saturation')), 'the saturation periods of the logs');
    assert.ok(X.times.find(r => r.log === 1).list.some(q => Math.abs(q.t - 41.3) < GSC.RULES.scnFallback.mergeS), 'the FALLBACK of the log');
    const base = X.tried[0], on = X.tried.find(q => q.values.precomp[1] === 'ON' && q.values.drop[1] === base.values.drop[1]);
    assert.ok(on && on.loss < base.loss, 'precomp ON decreases the loss');
    assert.ok(X.best.drop[1] >= GSC.RULES.scnFallback.minDrop, 'the drop stays noticeable');
    // the cue rule: the throttle decrease at each error at the maximum throttle (measured, not the parameter) stays at minDrop or more
    const minD = GSC.RULES.scnFallback.minDrop / 100, bestT = X.tried.find(q => JSON.stringify(q.values) === JSON.stringify(X.best));
    assert.ok(bestT.cueOk && (!(base.cue >= minD) || bestT.cue >= minD - 1e-6), JSON.stringify({ base, bestT }));
    assert.ok(X.tried.every(q => q.cueOk === true || q.cueOk === false));
    // gov_recovery_time also sets the throttle rate of RECOVERY and BAILOUT: with FUNCTION and gov_autorotation_timeout, a BAILOUT from a
    // turning rotor and from a slow rotor at F and E are constraints of a new value (GC9 over, satS)
    const B = GSC.RULES.scnBailout;
    assert.ok(X.recovery.cases.filter(c => c.key === 'turn').length === 2 && X.recovery.cases.filter(c => c.key === 'slow').length === 2, JSON.stringify(X.recovery.cases));
    for (const q of X.recovery.tried) assert.equal(q.ok, q.cand.every((c, j) => { const b = q.base[j]; return !b || typeof b.overshoot !== 'number' || !!c && c.overshoot <= b.overshoot + B.over && c.satS <= b.satS + B.satS; }), JSON.stringify(q));
    if (X.best.recovery !== X.current.recovery) assert.ok(X.recovery.tried.some(q => q.value === X.best.recovery && q.ok), 'a new recovery time passes its cases');
    assert.equal(X.problem, true, 'a FALLBACK in the logs');
    assert.ok(X.accept, 'the acceptance on the test flight');
    // each PID profile has its own acceptance on its own test errors (review 2026-10-15): the drop of a PID profile changes only its errors
    for (const p of Object.keys(X.profiles)) { const A = X.accept.profiles[p]; assert.ok(A && typeof A.pass === 'boolean' && Number.isInteger(A.n) && Array.isArray(A.constraints), JSON.stringify(A));
        assert.ok(A.n <= X.accept.n, 'the errors of one PID profile are a part of all errors'); }
    // the source of each value that the rows do not know (the texts give it: review 2026-10-15), null for a value of the rows
    assert.ok(X.assumed && 'recovery' in X.assumed && Object.keys(X.assumed.drop).length === Object.keys(X.current.drop).length, JSON.stringify(X.assumed));
    const s0 = await craft(), rows = GTU.tune(s0.runs, { families: GSC.families(S) }).rows.filter(q => q.name === 'gov_fallback_drop' && q.topic === 'model');
    assert.ok(rows.length > 0);
    for (const r of rows) if (X.assumed.drop[r.profile]) assert.match(r.text, /The model uses \d+/, r.text);
    // glitchEvents on one trace: the event starts at the error and gives the loss and the lowest headspeed
    const s = await craft(), run = s.runs[2], r = await GS.run(run, s.configs[GS.keyOf(run)], { plant: 'twin', twin: TRUTH, scenario: { forceFallback: [], glitches: [40.2] }, record: { points: 1e9 } });
    const [e] = GSC.glitchEvents(run, r.trace, [40.2], () => 4500, () => 1);
    assert.ok(e && e.loss > 0 && e.min < 1 && e.min > 0.5, JSON.stringify(e));
    // the throttle decrease in FALLBACK: precomp OFF, drop 10: the throttle is 0.9 x I against the PID sum before the error
    assert.ok(e.drop > 0.05 && e.drop < 1 && typeof e.atMax === 'boolean', JSON.stringify(e));
});

test('the BYPASS curve: 9 points over the collective stick from the steady duty at the middle of the battery', async () => {
    const S = await evalOf(['power', 'bypass']), X = S.bypass, k = GSC.RULES.scnBypass.mixerPerStick, ocv = S.ocv.mid - TRUTH.vp;
    assert.equal(X.values.length, 9); assert.deepEqual(X.stick, [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]);
    X.stick.forEach((c, j) => { const d = GT.steady(TRUTH, { H: 4500, coll: k * c, cyc: X.cyc, yaw: X.yaw, ocv }).d; assert.equal(X.values[j], Math.round(200 * Math.min(1, Math.max(0, d))), `point ${j}`); });
    assert.equal(GTU.cliValue('gov_bypass_throttle', X.values), X.values.join(','));
});

test('voltage compensation: the loop gain and the F-term over the battery; with ADC the closed loop with and without it', async () => {
    const S = await evalOf(['vcomp']), X = S.vcomp, vF = S.ocv.full - TRUTH.vp, vE = S.ocv.end - TRUTH.vp;
    near(X.gain, 1 - vE / vF, 1e-3); near(X.ff, vF / vE - 1, 1e-3);
    assert.equal(X.meter, null, 'the synthetic logs have no battery_meter: no CLI text, the simulation for ADC');
    assert.ok(X.sim[1].off && X.sim[1].on && X.sim[1].on.eRms !== X.sim[1].off.eRms, JSON.stringify(X.sim));
});

test('voltage compensation with the voltage source ADC: the closed loop of each model of the set, and the acceptance', async (t) => {
    const S = await evalOf(['vcomp'], { cli: '# dump all\nset battery_meter = ADC' }), X = S.vcomp;
    t.diagnostic(JSON.stringify({ sim: X.sim, accept: X.accept && [X.accept.pass, X.accept.mean, X.accept.n, X.accept.twins.length] }));
    assert.equal(X.meter, 'ADC');
    assert.ok(X.accept && X.accept.twins.length === S.twins.length, 'every model of the set');
});

test('a BAILOUT from a slow rotor: the ESC start ramp keeps the throttle at its maximum', async (t) => {
    const S = await evalOf(['bailout']), y = S.bailout.synthetic;
    t.diagnostic(JSON.stringify(Object.assign({}, y, { rows: y && y.rows.map(r => [r.key, r.rest, r.share, r.satS, r.overshoot]) })));
    assert.ok(S.bailout.relevant && y && !y.none, 'FUNCTION with AUTOROTATION from ACTIVE: no; the scenario runs for FUNCTION');
    assert.ok(y.share <= GSC.RULES.scnBailout.share + 0.01 && y.share > GSC.RULES.scnBailout.minShare, `the rotor speed at the switch ${y.share}`);
    // the ramp of the twin from 20 %: at least the time of the soft-start ramp to 95 % of the request less the BAILOUT ramp
    assert.ok(y.satS > 1, `${y.satS} s`);
});

// ---------------------------------------------------------------------------------------------
// the rows of gov_tune, the recommendations, the opt-in CLI text, STE
// ---------------------------------------------------------------------------------------------

let RES = null;
const SYN_CLI = ['# dump all', 'set gov_mode = ELECTRIC', 'set gov_throttle_type = FUNCTION', 'set gov_spoolup_time = 80', 'set gov_startup_time = 100', 'set gov_spooldown_time = 30',
    'set gov_tracking_time = 50', 'set gov_recovery_time = 20', 'set gov_handover_throttle = 25', 'set gov_bypass_throttle = 0,0,0,0,0,0,0,0,0', 'set battery_meter = ESC', 'profile 0',
    'set gov_headspeed = 4500', 'set gov_max_throttle = 100', 'set gov_use_pid_spoolup = OFF', 'set gov_use_fallback_precomp = OFF', 'set gov_fallback_drop = 10', 'profile 1', 'set gov_headspeed = 4000'].join('\n');
async function full() {
    if (RES) return RES;
    const s = await craft(), cli = SYN_CLI;
    return (RES = await GSC.tune(s.runs, { model: s.model, configs: s.configs, cli, validation: { status: 'validated', checks: [], tmScan: [], events: { spoolups: [{ log: 2, atS: 8, overshoot: { log: 9.5, closed: 9.1 } }] } } }));
}
const MY = { gov_headspeed: 'p', gov_use_voltage_comp: 'p', gov_spoolup_time: 'g', gov_use_pid_spoolup: 'p', gov_startup_time: 'g', gov_spooldown_time: 'g', gov_tracking_time: 'g',
    gov_recovery_time: 'g', gov_fallback_drop: 'p', gov_use_fallback_precomp: 'p', gov_max_throttle: 'p', gov_bypass_throttle: 'g' };
test('tune: a model row of each family for each PID profile, the rule ids, changes with CLI text, the opt-in checks', async (t) => {
    const res = await full(), rows = res.rows.filter(r => /^model/.test(r.topic) && r.status !== 'pending-model');
    t.diagnostic(`\n${GTU.table(rows)}`);
    assert.deepEqual(res.coverage.missing, []);
    for (const [name, sc] of Object.entries(MY)) for (const p of sc === 'g' ? [null] : res.profiles) assert.ok(rows.some(r => r.name === name && r.profile === p), `${name} ${p}`);
    for (const r of rows) {
        assert.ok(GTU.RULES[r.rule] && GTU.RULES[r.rule].id, `${r.id}: rule ${r.rule}`);
        assert.ok(!(r.status === 'change') || r.to !== null, `${r.id}: a change has a value`);
        assert.ok(r.text.split(/(?<=[.!?])\s+(?=[A-Z"])/).length <= (r.status === 'change' ? 4 : 6), `${r.id}: sentences`);
        assert.ok(r.evidence.every(e => typeof e.value === 'number'), `${r.id}: each evidence row has its number (the CLI file shows it)`);
    }
    const changes = res.recommendations.filter(x => x.severity === 'action');
    for (const x of changes) { assert.ok(x.cli.length >= 1 && /^set gov_/.test(x.cli[x.cli.length - 1]), JSON.stringify(x.cli)); assert.ok(x.evidence.length > 0); }
    // the BYPASS curve: a check with opt-in CLI text (advice.exportPlan puts it in the file only when the pilot selects it)
    const bp = res.recommendations.find(x => x.parameter === 'gov_bypass_throttle' && x.optIn);
    assert.ok(bp && bp.severity === 'check' && /^set gov_bypass_throttle = \d+(,\d+){8}$/.test(bp.cli[0]), JSON.stringify(bp && bp.cli));
    const script = ADV.exportScript(res.recommendations, [bp.id], {});
    assert.match(script, /set gov_bypass_throttle = /);
    assert.ok(!ADV.exportScript(res.recommendations, changes.map(x => x.id), {}).includes('gov_bypass_throttle ='), 'not in the file by default');
    assert.ok(res.scenarios && res.scenarios.power && res.scenarios.timing.totalS > 0);
    // the spool-up: one test spool-up is one unit of the acceptance (at its rest voltage, F and A), fewer than minUnits: a check with
    // opt-in CLI text, the time and the PID spool-up in one group
    const X = res.scenarios.spool, sp = rows.find(r => r.name === 'gov_spoolup_time');
    assert.equal(X.accept.n, 1); assert.equal(X.accept.units.length, 3); assert.ok(!X.accept.pass);
    if (X.accept.better && X.candidate.value !== 80) {
        assert.equal(sp.status, 'check'); assert.ok(sp.optIn && sp.optIn.to === X.candidate.value, JSON.stringify(sp.optIn));
        assert.ok(sp.group === 'GC3:spoolup' && sp.groupSize === 2 && rows.find(r => r.name === 'gov_use_pid_spoolup').group === 'GC3:spoolup');
        assert.ok(sp.caveats.some(c => c === GSC.TEXT.spool.needPid(X.candidate.value, X.minCurrent)));
    }
});

test('without a governor model or with a rejected model: not-applicable rows with the reason', () => {
    const fams = GSC.families({ reason: GSC.TEXT.rejected });
    assert.deepEqual(Object.keys(fams).sort(), ['bypass', 'fallback', 'maxThrottle', 'power', 'spoolup', 'tracking']);
});

// ---------------------------------------------------------------------------------------------
// gov_tune.autotune: the one function of the worker (recover, configOf, identify, validate, scenarios, search, rows)
// ---------------------------------------------------------------------------------------------

const typedIn = (x, at = 'result') => { if (ArrayBuffer.isView(x)) return [at]; if (!x || typeof x !== 'object') return []; return Object.entries(x).flatMap(([k, v]) => typedIn(v, `${at}.${k}`)); };
let AUTO = null;
async function autoRes() {
    if (AUTO) return AUTO;
    const s = await craft(), say = [];
    // the identified model and its validation are given (gov_fit has its own tests); nomad false: no NOMAD (a fast test). The search needs the gains,
    // the limits, the weights and the filters with their CLI names in the configuration (gov_sim.configOf gives them from the log)
    const model = Object.assign({ status: 'identified', Href: 4500, has: { voltage: true, current: false } }, s.model), configs = {};
    const gains = { gov_gain: 55, gov_p_gain: 18, gov_i_gain: 60, gov_d_gain: 2, gov_f_gain: 32, gov_p_limit: 30, gov_i_limit: 95, gov_d_limit: 5, gov_f_limit: 40, gov_yaw_ff_weight: 5,
        gov_cyclic_ff_weight: 35, gov_collective_ff_weight: 100, gov_collective_curve: 20, gov_min_throttle: 10 };
    for (const [k, c] of Object.entries(s.configs)) configs[k] = Object.assign({}, c, { cli: { global: Object.assign({ gov_rpm_filter: 10, gov_ff_filter: 5, gov_d_filter: 50 }, c.cli.global),
        profiles: Object.fromEntries(Object.entries(c.cli.profiles).map(([p, v]) => [p, Object.assign({}, gains, v)])) } });
    const validation = { status: 'validated', reasons: ['The model agrees with the test flights.'], checks: [], tmScan: [], events: { spoolups: [] } };
    const t0 = Date.now(), res = await GTU.autotune(s.runs, { model, validation, configs, cli: SYN_CLI, nomad: false, progress: (text, f) => say.push([text, f]) });
    return (AUTO = { res, say, ms: Date.now() - t0 });
}
test('autotune: the scenarios and the search in one call; JSON only, plots of 2000 points or less, no pending-model row, each of the 42 names, the CLI file', async (t) => {
    const { res, say, ms } = await autoRes();
    t.diagnostic(`${ms} ms; status ${res.status}; ${res.rows.length} rows; ${res.recommendations.length} recommendations; plots ${res.plots.map(q => q.id).join(', ')}; twin plots ${res.twin.plots.map(q => q.id).join(', ')}; timing ${JSON.stringify(res.timing)}`);
    assert.equal(res.status, 'validated');
    assert.deepEqual(typedIn(res), [], 'no typed arrays');
    assert.deepEqual(JSON.parse(JSON.stringify(res)), res, 'JSON-cloneable');
    assert.deepEqual(res.coverage.missing, []); assert.equal(res.coverage.covered, 42);
    for (const name of GTU.REGISTRY.map(R => R.name)) assert.ok(res.rows.some(r => r.name === name), name);
    assert.ok(!res.rows.some(r => r.status === 'pending-model'), 'a model is given: no pending-model row');
    for (const k of ['precomp', 'gains', 'filters', 'limits', 'power', 'spoolup', 'tracking', 'fallback', 'maxThrottle', 'bypass'])
        for (const name of GTU.MODEL_INFO[k].names) assert.ok(res.rows.some(r => r.name === name && r.topic.startsWith('model')), `${k}: ${name} has a model row`);
    // the plots: the generic spec of the Governor tab, 2000 points or less in each series
    const plots = res.plots.concat(res.twin.plots);
    for (const q of plots) { assert.ok(q.id && q.title && ['time', 'xy'].includes(q.kind) && q.series.length, q.id); for (const x of q.series) { assert.ok(x.x.length === x.y.length && x.y.length <= GTU.RUN.points, `${q.id} ${x.name}`); assert.ok(!x.axis, 'one y axis'); } }
    for (const id of ['tune-hs', 'tune-u', 'tune-battery', 'tune-battery-droop', 'tune-spool', 'tune-fallback'].concat(Object.keys(res.search.windows).map(p => `tune-margin-${p}`))) assert.ok(plots.some(q => q.id === id), id);
    assert.ok(res.twin.params.kv === TRUTH.kv && res.twin.validation.status === 'validated');
    assert.ok(res.search && res.search.status === 'ok' && res.search.stages.gains && Object.keys(res.search.windows).length && res.scenarios && res.scenarios.power, 'the summaries of the search and of the scenarios');
    assert.ok(res.timing.scenariosS > 0 && res.timing.searchS > 0 && !(res.timing.nomadBudgetS > 0), JSON.stringify(res.timing));
    // the progress: STE texts, fractions from 0 to 1
    assert.ok(say.length > 5 && say.every(([x, f]) => typeof x === 'string' && x.length > 10 && f >= 0 && f <= 1), JSON.stringify(say.slice(0, 5)));
    assert.ok(say.some(([x]) => x === GTU.AUTO.progress.rows));
    // each change and each opt-in check through advice.exportScript: its CLI lines in the file, no refusal
    const recs = res.recommendations;
    // a group (advice.cjs group: the values that the acceptance tests together) goes into the file as one: all or none
    const members = (x) => x.group ? recs.filter(q => q.group === x.group).map(q => q.id) : [x.id];
    for (const x of recs.filter(q => q.cli.length)) { const sc = ADV.exportScript(recs, members(x), {}); assert.ok(!/Not in the file/.test(sc) && x.cli.every(l => sc.includes(l)), `${x.id}\n${sc}`); }
    for (const x of recs.filter(q => q.group && q.cli.length && members(q).length > 1)) assert.match(ADV.exportScript(recs, [x.id], {}), /Not in the file/, `${x.id}: a part of its group`);
    const all = ADV.exportScript(recs, recs.filter(q => q.severity === 'action').map(q => q.id), {});
    assert.ok(!/Not in the file/.test(all), all);
    assert.ok(res.limitations.length >= 3 && res.limitations.every(x => typeof x === 'string'));
});
test('autotune: without a flight, with a rejected model; tune without a model keeps the pending-model rows with the reason', async () => {
    const none = await GTU.autotune([], {});
    assert.equal(none.status, 'unavailable'); assert.deepEqual(none.reasons, [GTU.TEXT.notApplicable.noFlight]);
    const s = await craft(), model = Object.assign({ status: 'identified', Href: 4500, has: { voltage: true, current: false } }, s.model);
    const rej = await GTU.autotune(s.runs, { model, validation: { status: 'rejected', reasons: ['The model does not agree with the test flights.'], checks: [], tmScan: [] }, configs: s.configs, cli: SYN_CLI });
    assert.equal(rej.status, 'rejected'); assert.equal(rej.search, null); assert.equal(rej.scenarios, null);
    const mr = rej.rows.filter(r => r.topic === 'model');
    assert.ok(mr.length && mr.every(r => r.status === 'not-applicable' && r.reason === require(path.join(ROOT, 'tools/autotune/gov_search.cjs')).TEXT.rejected), JSON.stringify(mr.slice(0, 2)));
    assert.deepEqual(rej.coverage.missing, []);
    assert.ok(!rej.recommendations.some(x => x.severity === 'action' && /model/.test(x.row)), 'no change from a rejected model');
    const pend = GTU.tune(s.runs, { cli: SYN_CLI }).rows.filter(r => r.status === 'pending-model');
    assert.ok(pend.length && pend.every(r => r.reason === GTU.NOTES.model));
    // review 2026-10-15: a rejected model without the battery voltage gives the cause (gov_fit TEXT.noVoltage) in the reasons, and the current
    // limitation without the set of models (no tuning step after a rejected model)
    const GF = require(path.join(ROOT, 'tools/autotune/gov_fit.cjs'));
    const nv = await GTU.autotune(s.runs, { model: Object.assign({}, model, { has: { voltage: false, current: false }, reasons: [GF.TEXT.noVoltage] }),
        validation: { status: 'rejected', reasons: ['The model does not agree with the test flights.'], checks: [], tmScan: [] }, configs: s.configs, cli: SYN_CLI });
    assert.ok(nv.reasons.includes(GF.TEXT.noVoltage), JSON.stringify(nv.reasons));
    assert.deepEqual(nv.limitations, [GTU.AUTO.limits.noCurrent(null)]);
    assert.ok(!/set of models/.test(nv.limitations[0]));
    // gov_mode unknown in every configuration of the model (no voltage and no current): the mode row says that there is no closed loop
    const noMode = Object.fromEntries(Object.entries(s.configs).map(([k, c]) => [k, Object.assign({}, c, { unknown: (c.unknown || []).concat([{ name: 'gov_mode', profile: 0, used: true }]) })]));
    // the synthetic logs give ELECTRIC (the throttle steps): without these items, the mode is unknown
    const GPm = require(path.join(ROOT, 'tools/autotune/gov_params.cjs')), rec = GPm.recover(s.runs, {});
    rec.epochs = rec.epochs.filter(e => e.name !== 'gov_mode'); rec.items = rec.items.filter(i => i.name !== 'gov_mode');
    const t = GTU.tune(s.runs, { noModeSim: true, recovered: rec }), m = t.rows.find(r => r.name === 'gov_mode');
    assert.equal(t.current.byName.gov_mode[0].value, null, 'the mode is unknown');
    assert.match(m.text, /^The log does not show the governor mode\. The analysis uses the mode ELECTRIC only if the log records the battery current or a battery voltage of more than 9 V\. Thus, the governor model does not calculate the closed loop\./, m.text);
    assert.ok(!/The analysis uses ELECTRIC\./.test(m.text));
    const nm = await GTU.autotune(s.runs, { model, validation: { status: 'rejected', reasons: ['x'], checks: [], tmScan: [] }, configs: noMode, recovered: rec });
    assert.match(nm.rows.find(r => r.name === 'gov_mode').text, /does not calculate the closed loop/);
});

function steLinter() {
    const file = path.join(ROOT, 'test/ste_text.test.cjs'), src = fs.readFileSync(file, 'utf8');
    const stubs = { 'node:test': { test() {} }, 'node:worker_threads': { isMainThread: true, workerData: null } };
    const ctx = { require: (n) => stubs[n] || require(n), __dirname: path.dirname(file), __filename: file, module: { exports: {} }, process, console, Buffer, setTimeout, clearTimeout };
    vm.runInNewContext(`${src}\n;this.__ste = { lintText, loadVocabulary, FAILING };`, ctx, { filename: file });
    const S = ctx.__ste, L = S.loadVocabulary(JSON.parse(fs.readFileSync(path.join(ROOT, 'test/ste/vocabulary.json'), 'utf8')));
    return (text, kind) => S.lintText(text, kind, L).filter(h => S.FAILING.includes(h.check));
}
const SAMPLE = [0.123, 2, 4500, 3, 22.3, 'ON', [3, 4], 10], OBJ = { mean: 1.2, lo: 0.5, hi: 2, n: 3, satS: 2, overshoot: 5, closed: 3, logOs: 4, log: 2, atS: 8, loss: 3, min: 0.9 };
function templates(obj, where, add, force) {
    for (const [k, v] of Object.entries(obj)) {
        const at = `${where}.${k}`, kind = force || (/title$/i.test(k) ? 'label' : 'message');
        if (typeof v === 'string') add(v, kind, at);
        else if (typeof v === 'function') {
            const n = v.length; let ok = 0;
            for (const args of [SAMPLE.slice(0, n), Array(n).fill(2), Array(n).fill(-0.05), Array(n).fill([3, 4]), [OBJ].concat(SAMPLE.slice(1, n)), [[OBJ]], [2, 1, OBJ, 2, 5], [OBJ, '%', 1], ['the values', OBJ]]) { let out; try { out = v(...args); } catch (e) { continue; } if (typeof out === 'string' && !/undefined|NaN|\[object/.test(out)) { ok++; add(out, kind, at); } }
            assert.ok(ok > 0, `${at}: no text`);
        } else if (v && typeof v === 'object') templates(v, at, add, force);
    }
}
test('STE: every text of the rows, the recommendations, the CLI file comments, the rules and the templates', async (t) => {
    let lint; try { lint = steLinter(); } catch (e) { t.skip(`lintText is not available: ${e.message}`); return; }
    const seen = new Map(), add = (text, kind, where) => { if (typeof text === 'string' && text.trim() && !seen.has(`${kind}|${text}`)) seen.set(`${kind}|${text}`, { text, kind, where }); };
    const res = await full();
    for (const r of res.rows.filter(q => /^model/.test(q.topic))) { add(r.title, 'label', r.id); add(r.text, 'message', r.id); add(r.reason, 'message', r.id); for (const e of r.evidence) add(e.text, 'message', `${r.id} evidence`);
        for (const c of r.caveats || []) add(c, 'note', `${r.id} caveat`); for (const x of r.notes || []) add(x, 'message', `${r.id} note`); }
    for (const x of res.recommendations) { add(x.title, 'label', x.id); add(x.text, 'message', x.id); add(x.rule, 'message', x.id); for (const c of x.caveats) add(c, 'note', x.id); }
    const script = ADV.exportScript(res.recommendations, res.recommendations.map(x => x.id), {});
    for (const line of script.split('\n')) { const m = /^\s*#+\s?(.*)$/.exec(line); if (m && /[A-Za-z]{2}/.test(m[1])) add(m[1], 'block', 'CLI file comment'); }
    for (const R of Object.values(GSC.RULES)) if (R && R.text) add(R.text, 'message', 'RULES');
    templates(GSC.TEXT, 'TEXT', add);
    // autotune: the limitations, the progress texts and the labels of the plots
    const A = (await autoRes()).res;
    for (const x of A.limitations) add(x, 'note', 'autotune limitation');
    for (const q of A.plots.concat(A.twin.plots)) { add(q.title, 'label', q.id); add(q.note, 'message', `${q.id} note`); for (const a of [q.x, q.y]) add(a.label, 'label', `${q.id} axis`); for (const x of q.series) add(x.name, 'label', `${q.id} series`); }
    templates({ progress: GTU.AUTO.progress, cancelled: GTU.AUTO.cancelled, failed: GTU.AUTO.failed, limits: GTU.AUTO.limits, twinNote: GTU.AUTO.plot.twinNote }, 'AUTO', add);
    templates(Object.fromEntries(Object.entries(GTU.AUTO.plot).filter(([k]) => k !== 'twinNote')), 'AUTO.plot', add, 'label');
    // the plots of a validation with the horizon curve and the steady-state map (the synthetic validation has neither)
    const hz = { horizons: [0.1, 1, 10], inActive: { model: [{ rms: 0.5 }, { rms: 1 }, { rms: 2 }], hold: [{ rms: 0.4 }, { rms: 1.5 }, { rms: 3 }], target: [{ rms: 0.1 }, { rms: 0.2 }, { rms: 0.3 }] } };
    const tp = GTU.twinPlots({ runs: [], horizon: hz, steady: { curves: [{ headspeed: 4500, ocv: 'full', coll: [0, 1], throttle: [0.5, 0.8] }], points: [{ coll: 0.5, u: 0.6 }] } });
    assert.ok(tp.some(q => q.id === 'twin-horizon') && tp.some(q => q.id === 'twin-steady'));
    for (const q of tp) { add(q.title, 'label', q.id); for (const a of [q.x, q.y]) add(a.label, 'label', `${q.id} axis`); for (const x of q.series) add(x.name, 'label', `${q.id} series`); }
    // the flags of the simulated values (gov_tune.simStale)
    for (const r of res.rows.filter(q => q.stale)) add(r.stale.text, 'note', `${r.id} stale`);
    const bad = [];
    for (const { text, kind, where } of seen.values()) { const h = lint(text, kind); if (h.length) bad.push(`${where}: ${h.map(x => `${x.check} ${x.detail}`).join(', ')} | "${text.slice(0, 160)}"`); }
    t.diagnostic(`${seen.size} texts`);
    assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------------------------------------
// real data (GOV_SCENARIOS_REAL=1; analysis/governor-20261014/data and analysis/governor-twin/out, not in git)
// ---------------------------------------------------------------------------------------------

const DATA = path.join(ROOT, 'analysis/governor-20261014/data'), OUT = path.join(ROOT, 'analysis/governor-twin/out');
const REAL = process.env.GOV_SCENARIOS_REAL === '1';
async function real(craftName) {
    const dir = path.join(DATA, craftName), meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')), events = {};
    const dis = path.join(OUT, `disarm_${craftName}.json`);
    if (fs.existsSync(dis)) { const d = JSON.parse(fs.readFileSync(dis, 'utf8')); for (const s of meta.segments) events[s.log] = (d.us[s.log] || []).map(us => ({ t: (us - s.timeStartUs) / 1e6 + (s.fromS || 0), name: 'DISARM' })); }
    const runs = GD.load(dir, { bench: true, events }), R = JSON.parse(fs.readFileSync(path.join(OUT, craftName, 'result.json'), 'utf8')), params = GT.copy(R.model.params);
    const model = { params, samples: (R.samples || []).map(s => GT.copy(params, s)), uncertainty: R.params, split: R.model.split };
    const cli = craftName === 'fireball' && process.env.GOV_CLI && fs.existsSync(process.env.GOV_CLI) ? fs.readFileSync(process.env.GOV_CLI, 'utf8') : null;
    return GSC.tune(runs, { model, cli, validation: { status: R.status, checks: R.acceptance, tmScan: R.validation.tmScan, events: R.validation.events } });
}
const rowOf = (res, name, p, topic = 'model') => res.rows.find(r => r.name === name && r.profile === p && r.topic === topic);
test('Fireball: the spool-up overshoot of the logs, the power limit at 4500 and 5000 rpm, FALLBACK, the BAILOUT of log 11', { skip: !REAL || !fs.existsSync(path.join(OUT, 'fireball', 'result.json')) && 'GOV_SCENARIOS_REAL=1 and the dev data' }, async (t) => {
    const res = await real('fireball'), S = res.scenarios;
    t.diagnostic(`\n${GTU.table(res.rows.filter(r => /^model/.test(r.topic) && r.status !== 'pending-model'))}\ntiming ${JSON.stringify(S.timing)}`);
    assert.ok(S.twins.some(x => x.factor === 1.4), 'the tm × 1.4 twin (tmBand fails)');
    assert.ok(S.spool.current.main[1] > 9 && S.spool.current.main[1] < 16, `overshoot at 80: ${S.spool.current.main}`);
    assert.ok(S.power.profiles[2].reserveE < 0.15 && S.power.profiles[3].reserveE < S.power.profiles[2].reserveE);
    assert.ok(S.power.profiles[2].E.share > S.power.profiles[2].F.share);
    const b = S.bailout.recorded.find(x => x.log === 10); assert.ok(b && Math.abs(b.main.satS - b.log_.satS) < 0.5, JSON.stringify(b));
    assert.ok(S.fallback.problem && S.fallback.tried[1].loss < S.fallback.tried[0].loss);
    assert.equal(rowOf(res, 'gov_use_voltage_comp', 2).status, 'not-applicable');
});
test('Gaui X4 II: no FALLBACK (no change of the FALLBACK values), the reserve of 2500 and 2700 rpm, the spool-up', { skip: !REAL || !fs.existsSync(path.join(OUT, 'gaui', 'result.json')) && 'GOV_SCENARIOS_REAL=1 and the dev data' }, async (t) => {
    const res = await real('gaui'), S = res.scenarios;
    t.diagnostic(`\n${GTU.table(res.rows.filter(r => /^model/.test(r.topic) && r.status !== 'pending-model'))}\ntiming ${JSON.stringify(S.timing)}`);
    assert.ok(!S.fallback.problem);
    for (const name of ['gov_recovery_time', 'gov_fallback_drop', 'gov_use_fallback_precomp']) assert.ok(res.rows.filter(r => r.name === name && r.topic === 'model').every(r => r.status !== 'change'), name);
    assert.ok(S.spool.passNow, 'the overshoot of the logs is 1.2 %');
    assert.equal(rowOf(res, 'gov_headspeed', 1).status, 'keep');
});
