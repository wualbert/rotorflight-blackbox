'use strict';

// Tests of tools/autotune/gov_search.cjs (docs/GOVERNOR_AUTOTUNE.md section 7): the feedforward design, the margin test, the paired
// block bootstrap, the twin set, and the search with a synthetic twin and the native governor (controller.wasm). The synthetic "logs"
// are closed loops of the native governor and a known twin (gov_sim.run), so the identified twin is exact:
//   - an over-damped baseline (a small I-gain) gets a larger I-gain, and the test flights accept it;
//   - an oscillating baseline (gains too high) does not pass the margin test, and gets a smaller P-gain and I-gain;
//   - the feedforward design recovers the weights of a synthetic load;
//   - the acceptance refuses an improvement that only the training flights show (test flights at the power limit).
// The rows (gov_tune.row format), their recommendations and the STE lint of every text.
//
//   node --test test/gov_search.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SE = require(path.join(ROOT, 'tools/autotune/gov_search.cjs'));
const GS = require(path.join(ROOT, 'tools/autotune/gov_sim.cjs'));
const GT = require(path.join(ROOT, 'tools/autotune/gov_twin.cjs'));
const GD = require(path.join(ROOT, 'tools/autotune/gov_data.cjs'));
const TUNE = require(path.join(ROOT, 'tools/autotune/gov_tune.cjs'));
const F = require(path.join(ROOT, 'tools/autotune/firmware_controller.cjs'));

// ---------------------------------------------------------------------------------------------
// the synthetic plant, the governor configuration and the logs
// ---------------------------------------------------------------------------------------------

const PROFILE_FIELDS = F.SCHEMA.filter(f => f.member.startsWith('profile.governor.')).map(f => f.name);
const pick = (o, names) => Object.fromEntries(names.filter(k => k in o).map(k => [k, o[k]]));
const GOV = { gov_mode: 'ELECTRIC', gov_throttle_type: 'FUNCTION', gov_startup_time: 20, gov_spoolup_time: 30, gov_tracking_time: 20, gov_recovery_time: 20, gov_spooldown_time: 30,
    gov_handover_throttle: 25, gov_autorotation_timeout: 15, gov_rpm_filter: 10, gov_ff_filter: 5, gov_d_filter: 50, gov_pwr_filter: 5, gov_tta_filter: 0, gov_idle_throttle: 0,
    gov_auto_throttle: 0, gov_throttle_hold_timeout: 50 };
const PROF = { gov_headspeed: 4500, gov_gain: 50, gov_p_gain: 20, gov_i_gain: 60, gov_d_gain: 0, gov_f_gain: 20, gov_p_limit: 30, gov_i_limit: 95, gov_d_limit: 20, gov_f_limit: 100,
    gov_yaw_ff_weight: 20, gov_cyclic_ff_weight: 40, gov_collective_ff_weight: 100, gov_collective_curve: 20, gov_max_throttle: 100, gov_min_throttle: 10, gov_fallback_drop: 10,
    gov_tta_gain: 0, gov_tta_limit: 20, gov_dyn_min_throttle: 80, gov_use_fallback_precomp: 'OFF', gov_use_voltage_comp: 'OFF', gov_use_pid_spoolup: 'OFF', gov_use_dyn_min_throttle: 'OFF' };
// a gov_sim configuration (configOf format) of PID profile 1
function cfgOf(prof) {
    const d = F.defaults(), cli = { global: Object.assign({}, GOV), profiles: { 1: Object.assign({}, PROF, prof) } };
    return { global: Object.assign({}, d, GS.toSchema(Object.assign({}, cli.global, { tail_rotor_mode: 'VARIABLE', main_rotor_dir: 'CW' }))),
        profiles: { 1: Object.assign(pick(d, PROFILE_FIELDS), pick(GS.toSchema(cli.profiles[1], { gov_flags: 0 }), PROFILE_FIELDS)) }, cli, gear: null, voltageSource: 'ESC', cells: 6,
        assumptions: [], unknown: [], flags: [], excluded: null, notes: [] };
}
// the true plant: the load sL = n^2 (q0 + qc coll^2 + qx cyc + qy |yaw|) + qf n at 25 V, no battery resistance (the steady extra throttle is
// (qc coll^2 + qx cyc + qy |yaw|) / 25 at the full headspeed: 0.1 coll^2 + 0.04 cyc + 0.02 |yaw|, the weights 100, 40, 20 with gov_gain 50 and gov_f_gain 20)
const truth = (o = {}) => GT.copy(GT.copy(GT.defaults({ kv: 290, Href: 4500, V0: 25 }), { tm: 0.3, te: 0.05, ass: 2000, sneg: 2, q0: 0.8, qc: 2.5, qx: 1.0, qy: 0.5, qf: 0.2, qs: 0, pc: 2, c0: 0,
    beta: 0, kappa: 0, vp: 0, th: 0.01, tv: 0.06 }), o);
const HEADER = { looptime: 500, pid_process_denom: 2, vbatcellvoltage: [330, 350, 430] };
function inputsRun(log, seconds, f, rest) {
    const rate = 1000, n = Math.round(seconds * rate), c = { time: new Float64Array(n), hs: new Float32Array(n), 'motor[0]': new Float32Array(n), 'rcCommand[4]': new Float32Array(n),
        'mixer[0]': new Float32Array(n), 'mixer[1]': new Float32Array(n), 'mixer[2]': new Float32Array(n), 'mixer[3]': new Float32Array(n), Vbat: new Float32Array(n).fill(rest * 100), profileAt: new Uint8Array(n).fill(1) };
    for (let i = 0; i < n; i++) { const t = i / rate, v = f(t); c.time[i] = t; c['rcCommand[4]'][i] = v.thr * 1000; ['roll', 'pitch', 'yaw', 'coll'].forEach((k, j) => { c[`mixer[${j}]`][i] = (v[k] || 0) * 1000; }); }
    return GD.fromColumns(c, { log, n, rate, actualRate: rate, timeStartUs: 20e6, header: HEADER }, { class: 'flight', flights: [] });
}
// a logged flight: the native governor flies the true plant; the log records hs, motor[0], Vbat, the governor conditions, target and I
async function logOf(log, seconds, f, prof, rest = 25) {
    const run0 = inputsRun(log, seconds, f, rest), cfg = cfgOf(prof), res = await GS.run(run0, cfg, { plant: 'twin', twin: truth(), record: { points: 1e9 } }), tr = res.trace, n = run0.n;
    const c = { time: run0.time, hs: tr.hs, 'motor[0]': Float32Array.from(tr.u, v => Math.round(v * 1000)), 'rcCommand[4]': Float32Array.from(run0.thr, v => v * 1000), Vbat: Float32Array.from(tr.vbat, v => Math.round(v * 100)),
        govStateAt: Uint8Array.from(tr.state), govTarget: tr.target, govRequest: Float32Array.from(tr.target, (v, i) => tr.state[i] === 4 ? v : 4500), govI: Float32Array.from(tr.I, v => Math.trunc(v * 1000)), profileAt: new Uint8Array(n).fill(1) };
    ['roll', 'pitch', 'yaw', 'coll'].forEach((k, j) => { c[`mixer[${j}]`] = Float32Array.from(run0[k], v => v * 1000); });
    return { run: GD.fromColumns(c, { log, n, rate: 1000, actualRate: 1000, timeStartUs: 20e6, header: HEADER }, { class: 'flight', flights: [] }), cfg };
}
const smooth = (x) => x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x);
// collective pumps: up by amp for width s every period s, with 0.15-s ramps
const pumps = (period, amp, width, phase = 0) => (t) => { const q = (t + phase) % period; return amp * Math.min(smooth(q / 0.15), q < width + 0.15 ? smooth((width - q) / 0.15 + 1) : 0); };
const flight = (pump) => (t) => ({ thr: t < 0.5 ? 0 : 1, coll: 0.3 + (t > 8 ? pump(t) : 0), roll: 0.04 * Math.sin(3.1 * t), pitch: 0.03 * Math.cos(2.3 * t), yaw: 0.08 * Math.sin(5.3 * t) });
// three flight logs (log 2 is the test log, o.testS long); o.power: the test log at 16 V (the throttle at its maximum in ACTIVE)
async function scenario(prof, o = {}) {
    const logs = [await logOf(0, 60, flight(pumps(5, 0.35, 1.2)), prof), await logOf(1, 60, flight(pumps(4.3, 0.3, 0.9, 1.7)), prof),
        o.power ? await logOf(2, 60, flight(pumps(5, 0.35, 1.2)), prof, 16) : await logOf(2, o.testS || 60, flight(pumps(4.7, 0.33, 1.1, 0.9)), prof)];
    const runs = logs.map(l => l.run), configs = Object.fromEntries(logs.map(l => [GS.keyOf(l.run), l.cfg])), p = truth();
    const model = { params: p, samples: [GT.copy(p, { tm: 0.27 }), GT.copy(p, { tm: 0.33, kv: 285 })], split: { mode: 'logs', testLogs: [2] }, status: 'identified', has: { voltage: true, current: o.current !== false } };
    const S = await SE.search(runs, { model, validation: { status: 'validated', checks: [] }, configs, nomad: o.nomad || false, budgetMs: o.budgetMs, families: o.families });
    return { S, runs, configs };
}
const memo = new Map(), once = (k, f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };
const eff = (v) => ({ kp: v.gov_gain * v.gov_p_gain, ki: v.gov_gain * v.gov_i_gain });

// ---------------------------------------------------------------------------------------------
// rows: a gov_tune ctx with the values of the CLI section of PID profile 1
// ---------------------------------------------------------------------------------------------

function ctxOf(S, cur = Object.assign({}, GOV, PROF)) {
    const byName = {}; for (const R of TUNE.REGISTRY) byName[R.name] = { 0: { value: cur[R.name] === undefined ? null : cur[R.name], source: 'CLI dump', stale: null }, 1: { value: cur[R.name] === undefined ? null : cur[R.name], source: 'CLI dump, section `profile 0`', stale: null } };
    return { sim: S, profiles: [1], current: { byName, related: {} }, modelEvidence: {}, limitMode: false, modelState: null, num: (n) => typeof cur[n] === 'number' ? cur[n] : null };
}
const rowsOf = (S, cur) => { const ctx = ctxOf(S, cur); return { ctx, rows: [].concat(...Object.values(SE.FAMILIES).map(f => f(ctx))) }; };

// ---------------------------------------------------------------------------------------------
// unit tests
// ---------------------------------------------------------------------------------------------

test('the feedforward design recovers the weights of a synthetic load (gov_gain fixed, integer values in range)', () => {
    const p = truth(), rand = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })(), smp = [];
    for (let i = 0; i < 4000; i++) smp.push({ coll: -0.5 + 1.3 * rand(), cyc: 0.3 * rand(), yaw: -0.4 + 0.8 * rand() });
    const cur = { gov_gain: 50, gov_f_gain: 20, gov_collective_ff_weight: 50, gov_cyclic_ff_weight: 10, gov_yaw_ff_weight: 10, gov_collective_curve: 15 };
    const d = SE.designPrecomp(p, smp, 4500, 25, cur);
    assert.deepEqual(d.values, { gov_gain: 50, gov_f_gain: 20, gov_collective_ff_weight: 100, gov_cyclic_ff_weight: 40, gov_yaw_ff_weight: 20, gov_collective_curve: 20 });
    assert.ok(d.rms < 1e-6 && d.r2 > 0.9999 && d.rmsNow > 0.005, JSON.stringify(d));
    // another f_gain at this time: the nearest f_gain with exact integer weights keeps the same products K Kf w
    const d2 = SE.designPrecomp(p, smp, 4500, 25, Object.assign({}, cur, { gov_f_gain: 25 }));
    assert.deepEqual(d2.values, { gov_gain: 50, gov_f_gain: 25, gov_collective_ff_weight: 80, gov_cyclic_ff_weight: 32, gov_yaw_ff_weight: 16, gov_collective_curve: 20 });
    // a collective exponent of 1.5 gives the curve 15; a lower headspeed scales the load with n^2
    const d3 = SE.designPrecomp(truth({ pc: 1.5 }), smp, 4500, 25, cur), d4 = SE.designPrecomp(p, smp, 3600, 25, cur);
    assert.equal(d3.values.gov_collective_curve, 15);
    assert.ok(Math.abs(d4.eff[0] / d.eff[0] - 0.64) < 1e-3, `${d4.eff[0]} ${d.eff[0]}`);
    assert.equal(SE.designPrecomp(p, [], 4500, 25, cur), null);
});

test('the margin ratio: successive peaks with alternate signs, a floor, and the step response less the reference run', () => {
    const e = (f) => Float64Array.from({ length: 4000 }, (_, k) => k < 1000 ? 0 : f((k - 1000) / 1000));
    const ring = e((t) => -Math.exp(-0.7 * t) * Math.cos(2 * Math.PI * t)), over = e((t) => -Math.exp(-3 * t) * (1 - 2 * t));
    const r = SE.decay(ring, 1000, 4000, 0);
    assert.ok(Math.abs(r.ratio - Math.exp(-0.7 * 0.5)) < 0.02, JSON.stringify(r));
    assert.equal(SE.decay(over, 1000, 4000, 0).peaks.length, 2);
    assert.equal(SE.decay(e(() => -0.001), 1000, 4000, 0).ratio, 0, 'under the floor');
    // an oscillation on a slow change that does not cross 0 (the I-term recovery): the ratio of the swings between successive extrema
    const onTrend = e((t) => -0.4 * Math.exp(-0.3 * t) - 0.3 * Math.exp(-2 * t) * Math.cos(2 * Math.PI * 3 * t)), d = SE.decay(onTrend, 1000, 4000, 0, -1);
    assert.ok(d.peaks.length === 1 && Math.abs(d.swing - Math.exp(-2 / 6)) < 0.08 && Math.abs(d.ratio - d.swing) < 1e-3 && d.ratio > SE.RULES.margin.ratio, JSON.stringify(d));
    assert.equal(SE.decay(e((t) => -0.4 * Math.exp(-0.3 * t)), 1000, 4000, 0, -1).ratio, 0, 'a slow change alone');
    // the tail of an earlier response with the other sign is not the first peak (sign0: the expected sign)
    const tail = e((t) => t < 0.1 ? -0.06 : 0.6 * Math.exp(-3 * (t - 0.1)));
    assert.ok(SE.decay(tail, 1000, 4000, 0).ratio > 5 && SE.decay(tail, 1000, 4000, 0, 1).ratio === 0);
    // ratioOf on traces: the reference run cancels a slow drift that is common to both runs
    const tr = (f) => ({ hs: Float32Array.from({ length: 9000 }, (_, k) => 4500 * (1 + f(k) / 100)), target: new Float32Array(9000).fill(4500), state: new Uint8Array(9000).fill(4) });
    const drift = (k) => 2 * Math.exp(-k / 3000), w = { k: 3000, rate: 1000, sign: -1 };
    const a = tr((k) => drift(k) + (k >= 3000 ? -0.5 * Math.exp(-(k - 3000) / 300) : 0)), b = tr(drift);
    const q = SE.ratioOf(a, w, b);
    assert.equal(q.pass, true); assert.equal(q.ratio, 0);
    const left = tr(() => 0); left.state[5000] = 6;
    assert.deepEqual([SE.ratioOf(left, w, b).pass, SE.ratioOf(left, w, b).ratio], [false, null], 'the governor leaves ACTIVE: not satisfactory');
    // the gains of the test: x2, or gov_gain x2 when a gain is out of range, and the F-term off
    const v = { global: {}, profiles: { 1: { gov_gain: 50, gov_f_gain: 20, gov_p_gain: 20, gov_i_gain: 60, gov_d_gain: 0 } } };
    assert.deepEqual(SE.doubled(v, 1).profiles[1], { gov_gain: 50, gov_f_gain: 0, gov_p_gain: 40, gov_i_gain: 120, gov_d_gain: 0 });
    v.profiles[1].gov_i_gain = 200;
    assert.deepEqual(SE.doubled(v, 1).profiles[1], { gov_gain: 100, gov_f_gain: 0, gov_p_gain: 20, gov_i_gain: 200, gov_d_gain: 0 });
});

test('the paired block bootstrap: a consistent improvement passes, a mixed one or a small one does not', () => {
    const blk = (p, e, n = 10000) => ({ p, part: 1, n, e2: e * e * n, hf2: 1e-4 * n, sat: 0, il: 0, dro: Array(10).fill(e * 2), ove: Array(10).fill(e), rate: 1000 });
    const base = [], good = [], mixed = [], tiny = [];
    for (let i = 0; i < 12; i++) { const e = 1 + 0.3 * Math.sin(i); base.push(blk(1, e)); good.push(blk(1, 0.8 * e)); mixed.push(blk(1, (i % 2 ? 0.5 : 1.45) * e)); tiny.push(blk(1, 0.997 * e)); }
    const g = SE.paired(base, good, [1]), m = SE.paired(base, mixed, [1]), t = SE.paired(base, tiny, [1]);
    assert.ok(g.imp > 10 && SE.passes(g), JSON.stringify(g));
    assert.ok(!SE.passes(m), JSON.stringify(m));
    assert.ok(t.imp > 0 && t.imp < 1 && !SE.passes(t), JSON.stringify(t));
    assert.equal(SE.jRel(SE.agg(base), SE.agg(base)), 1);
    assert.ok(!SE.passes(SE.paired(base.slice(0, 2), good.slice(0, 2), [1])), 'fewer blocks than RULES.accept.minBlocks');
});

test('the twin set: the main twin, the extremes of tm, load, kv and te of the samples, and the tm-scan winner when tmBand fails', () => {
    const p = truth(), samples = [{ tm: 0.2 }, { tm: 0.5 }, { kv: 270 }, { kv: 310 }, { te: 0.02 }, { te: 0.09 }, { q0: 1.5 }, { q0: 0.4 }].map(c => Object.assign({}, p, c));
    const val = { checks: [{ rule: 'tmBand', pass: false }], tmScan: [{ factor: 0.7, band: 0.6 }, { factor: 1.4, band: 0.45 }, { factor: 2, band: 0.5 }] };
    const T = SE.twinSet({ params: p, samples, has: { current: true } }, val, { coll: 0.3, cyc: 0.05, yaw: 0.05 });
    assert.equal(T.list[0].name, 'main'); assert.equal(T.tmFactor, 1.4);
    assert.equal(T.list.length, 1 + SE.RULES.twins.max + 1);
    const tms = T.list.map(t => t.tm); assert.ok(tms.includes(0.2) && tms.includes(0.5) && tms.includes(r4(p.tm * 1.4)), JSON.stringify(tms));
    assert.equal(SE.twinSet({ params: p, samples: [], has: { current: true } }, { checks: [{ rule: 'tmBand', pass: true }] }, { coll: 0, cyc: 0, yaw: 0 }).list.length, 1);
    // without battery current (critique C13): tm x 0.7 and x 1.4 too, once (the tm-scan winner 1.4 is not repeated)
    const nc = SE.twinSet({ params: p, samples: [], has: { current: false } }, val, { coll: 0, cyc: 0, yaw: 0 });
    assert.deepEqual(nc.list.map(t => t.name), ['main', 'tm x1.4', 'tm x0.7']); assert.deepEqual(nc.noCurrent, [0.7]);
    assert.deepEqual(SE.twinSet({ params: p, samples: [] }, null, { coll: 0, cyc: 0, yaw: 0 }).list.map(t => t.tm), [p.tm, r4(p.tm * 0.7), r4(p.tm * 1.4)].map(r4), 'the parameters have no current');
});
const r4 = (v) => +v.toFixed(4);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (tol ${tol})`);

test('the module has no Node API at load and exports before the CLI part (the worker shim)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tools/autotune/gov_search.cjs'), 'utf8'), head = src.slice(0, src.indexOf('if (require.main !== module) return;'));
    assert.ok(head.includes('module.exports = {'), 'module.exports before the guard');
    assert.ok(!/require\(['"](fs|path|node:)/.test(head) && !/process\./.test(head), 'no Node API before the guard');
    assert.ok(!/\?\?=|\|\|=|&&=|\.at\(|structuredClone|Object\.hasOwn\(/.test(head), 'Chromium 99 syntax');
    for (const k of Object.values(SE.RULE_KEYS)) assert.ok(TUNE.RULES[k] && /^GS\d$/.test(TUNE.RULES[k].id) && TUNE.RULES[k].text, `rule ${k} in gov_tune RULES`);
});

// ---------------------------------------------------------------------------------------------
// the search with the native governor
// ---------------------------------------------------------------------------------------------

test('an over-damped baseline (I-gain 8) gets a larger I-gain, accepted on the test flights', async (t) => {
    const { S } = await once('low', () => scenario({ gov_i_gain: 8 }));
    t.diagnostic(`${S.ms} ms, ${S.timing.sims} simulations; gains ${JSON.stringify(S.accept.gains)}`);
    assert.equal(S.status, 'ok');
    assert.equal(S.stages.gains.grids.gov_i_gain.profiles[1].to, 16, 'the I grid on the training flights');
    const D = S.accept.gains.profiles[1], c = S.current.profiles[1], f = S.final.profiles[1];
    assert.ok(D.accepted && D.imp > 2 * D.se && D.imp >= SE.RULES.accept.minPct, JSON.stringify(D));
    assert.ok(eff(f).ki > eff(c).ki, `K Ki ${eff(c).ki} -> ${eff(f).ki}`);
    assert.ok(S.margin.final[1].pass && D.twins.length === 3 && D.twinLo > 0, JSON.stringify(S.margin.final));
    // the robustness rule: the bootstrap of each twin passes (the same blocks), and the interval is imp ± z SE over the set
    assert.ok(D.twins.every(x => x.pass && x.imp > SE.RULES.accept.z * x.se), JSON.stringify(D.twins));
    near(D.twinLo, Math.min(...D.twins.map(x => x.imp - SE.RULES.accept.z * x.se)), 2e-3); near(D.twinHi, Math.max(...D.twins.map(x => x.imp + SE.RULES.accept.z * x.se)), 2e-3);
    // the feedforward design of the exact twin agrees with the values at this time: no change
    assert.deepEqual(S.stages.precomp.profiles[1].values, pick(c, ['gov_gain', 'gov_f_gain', 'gov_collective_ff_weight', 'gov_cyclic_ff_weight', 'gov_yaw_ff_weight', 'gov_collective_curve']));
    assert.equal(Object.keys(S.accept.precomp.profiles).length, 0);
    // the rows and their recommendations: CLI text for each change, with the PID profile
    const { ctx, rows } = rowsOf(S);
    const changes = rows.filter(r => r.status === 'change');
    assert.ok(changes.length >= 1 && changes.every(r => r.rule === 'gsGains' || r.rule === 'gsPrecomp' || r.rule === 'gsMargin'), JSON.stringify(changes.map(r => [r.name, r.to, r.rule])));
    for (const r of changes) {
        const rec = TUNE.toRecommendation(r, ctx);
        assert.equal(rec.severity, 'action'); assert.deepEqual(rec.cli, ['profile 0', `set ${r.name} = ${r.to}`]);
        assert.ok(rec.evidence.length >= 2 && rec.evidence[0].value !== null && rec.rule === TUNE.RULES[r.rule].text, JSON.stringify(rec.evidence[0]));
        assert.ok(rec.evidence.every(e => typeof e.value === 'number'), `${r.id}: each evidence row has its number (the CLI file shows it)`);
        // the linked values of advice.govLinks that the analysis knows are in fromSets (the CLI file does not call them unknown)
        assert.equal(rec.fromSets.gov_mode, 'ELECTRIC'); assert.equal(rec.fromSets.gov_max_throttle, 100);
    }
    // a gains row of a changed PID profile: the margin of the recommended gains (S.margin.final), then the gains at this time
    const ip = rows.find(r => r.name === 'gov_i_gain'), mNew = ip.evidence.find(e => /recommended gains/.test(e.text));
    assert.ok(mNew && mNew.value === S.margin.final[1].ratio, JSON.stringify(ip.evidence.map(e => e.text)));
    assert.ok(ip.evidence.some(e => /gains at this time/.test(e.text) && e.value === S.margin.current[1].ratio));
    // the grid: J against the values of the stage (the value at this time of the name: 1, not an evidence row)
    const gi = S.stages.gains.grids.gov_i_gain.profiles[1]; assert.equal(gi.tested[0].J, 1);
    const g16 = ip.evidence.find(e => /^Change of the tuning value J with "gov_i_gain" 16 against 8,/.test(e.text));
    assert.ok(g16 && g16.value === +(100 * (gi.tested.find(q => q.value === 16).J - 1)).toFixed(2) && !ip.evidence.some(e => /"gov_i_gain" 8 against 8/.test(e.text)), JSON.stringify(g16));
    for (const name of [].concat(...Object.values(SE.NAMES))) assert.ok(rows.some(r => r.name === name), name);
    for (const r of rows) assert.ok(r.evidence.every(e => typeof e.value === 'number'), `${r.id}: each evidence row has its number (the CLI file shows it)`);
    // the plot data: the baseline and the candidate on the test log
    assert.equal(S.plot.log, 2); assert.ok(S.plot.trace.hsBase.length > 100 && S.plot.trace.hsBase.length <= 2000 && S.plot.table[0].J < 1);
});

test('without battery current: tm x 0.7 and x 1.4 in the set, and a larger I-gain is a check with opt-in CLI text (critique C13)', async (t) => {
    const { S } = await once('lowNc', () => scenario({ gov_i_gain: 8 }, { current: false }));
    t.diagnostic(`twins ${JSON.stringify(S.twins.map(x => [x.name, x.tm]))}; gains ${JSON.stringify(S.accept.gains && S.accept.gains.profiles[1] && [S.accept.gains.profiles[1].accepted, S.accept.gains.profiles[1].changes])}`);
    assert.equal(S.hasCurrent, false); assert.deepEqual(S.noCurrent, [0.7, 1.4]);
    assert.ok(S.twins.some(x => x.name === 'tm x0.7') && S.twins.some(x => x.name === 'tm x1.4'));
    // the decision passes the robustness rule, but a larger gain is not accepted: an opt-in check; the values at this time stay in S.final
    const D = S.accept.gains.profiles[1];
    assert.ok(D && !D.accepted && D.optIn && D.why.includes(SE.TEXT.noCurrent), JSON.stringify(D));
    assert.deepEqual(S.final.profiles[1], S.current.profiles[1]);
    const { ctx, rows } = rowsOf(S, Object.assign({}, GOV, PROF, { gov_i_gain: 8 }));
    const opt = rows.filter(r => r.optIn);
    assert.deepEqual(opt.map(r => r.name).sort(), Object.keys(D.changes).sort(), 'one opt-in row for each value of the decision');
    for (const r of opt) {
        assert.equal(r.status, 'check'); assert.equal(r.to, null); assert.ok(r.text.includes(SE.TEXT.noCurrent), r.text);
        assert.ok(r.optIn.to === D.changes[r.name] && r.optIn.cli.length === 2, JSON.stringify(r.optIn));
        assert.equal(TUNE.toRecommendation(r, ctx).severity, 'check');
        if (opt.length > 1) assert.ok(r.group === 'GS:gains:1' && r.groupSize === opt.length, `${r.id}: one group`);
    }
    assert.ok(!rows.some(r => r.status === 'change' && SE.NAMES.gains.includes(r.name)), 'no larger gain is a change without current');
});

// gov_gain 70, P 200, I 250: K Kp 14 and K Ki 17.5, an oscillation of the headspeed in every flight (gov_f_gain 14 keeps the feedforward)
const OSC = { gov_gain: 70, gov_p_gain: 200, gov_i_gain: 250, gov_f_gain: 14 };
test('an oscillating baseline (gains too high) does not pass the margin test and gets a smaller P-gain and I-gain', async (t) => {
    const { S } = await once('osc', () => scenario(OSC, { testS: 150 }));
    t.diagnostic(`margin ${JSON.stringify(S.margin)}; gains ${JSON.stringify(S.accept.gains)}`);
    assert.equal(S.margin.current[1].pass, false);
    const c = S.current.profiles[1], f = S.final.profiles[1], D = S.accept.gains.profiles[1];
    assert.ok(eff(f).kp < eff(c).kp && eff(f).ki < eff(c).ki, `${JSON.stringify(eff(c))} -> ${JSON.stringify(eff(f))}`);
    assert.ok(D.accepted && D.fix && S.margin.final[1].pass, JSON.stringify(D));
    assert.ok(S.baseline.test[1].thrHF > 5 && D.imp > 2 * D.se, 'the oscillation: fast throttle changes; the change decreases J on the test flights');
    const { rows } = rowsOf(S, Object.assign({}, GOV, PROF, OSC));
    const ch = rows.filter(r => r.status === 'change' && SE.NAMES.gains.includes(r.name));
    assert.ok(ch.length && ch.every(r => r.rule === 'gsMargin' && r.text.includes(SE.TEXT.fixed)), JSON.stringify(ch.map(r => [r.name, r.to, r.rule])));
    assert.ok(rows.find(r => r.name === 'gov_p_gain').evidence.some(e => /not satisfactory/.test(e.text)), 'the margin test of the gains at this time is evidence');
});

test('gains that do not pass the margin test, with a smaller J than the values that pass it: a check row with these values, no change (SPEC 7)', async (t) => {
    const { S } = await once('stable', () => scenario({ gov_p_gain: 100, gov_i_gain: 120 }));
    const D = S.accept.gains.profiles[1];
    t.diagnostic(`margin ${JSON.stringify(S.margin.current)}; gains ${JSON.stringify(D)}`);
    assert.equal(S.margin.current[1].pass, false);
    assert.ok(D.fix && !D.accepted && D.imp < 0, JSON.stringify(D));
    const { rows } = rowsOf(S, Object.assign({}, GOV, PROF, { gov_p_gain: 100, gov_i_gain: 120 }));
    const g = rows.filter(r => SE.NAMES.gains.includes(r.name));
    assert.ok(g.every(r => r.status === 'check' && r.rule === 'gsMargin'), JSON.stringify(g.map(r => [r.name, r.status, r.rule])));
    assert.ok(g.find(r => r.name === 'gov_p_gain').text.includes(SE.TEXT.proposal(D.changes)), g.find(r => r.name === 'gov_p_gain').text);
});

test('the acceptance refuses an improvement that only the training flights show', async (t) => {
    const { S } = await once('power', () => scenario({ gov_i_gain: 8 }, { power: true }));
    const D = S.accept.gains.profiles[1];
    t.diagnostic(`gains ${JSON.stringify(D)}`);
    assert.ok(S.stages.gains.grids.gov_i_gain.profiles[1].to > 8, 'the training flights select a larger I-gain');
    assert.ok(!D.accepted && !(D.imp > 2 * D.se && D.imp >= SE.RULES.accept.minPct), JSON.stringify(D));
    assert.ok(S.baseline.test[1].satShare > 0.9, 'the test log is at the power limit');
    assert.deepEqual(S.final.profiles[1], S.current.profiles[1]);
    const { rows } = rowsOf(S, Object.assign({}, GOV, PROF, { gov_i_gain: 8 }));
    for (const r of rows.filter(q => SE.NAMES.gains.includes(q.name))) assert.notEqual(r.status, 'change', r.id);
    assert.ok(rows.find(r => r.name === 'gov_i_gain').text.includes(SE.TEXT.why.small()));
});

test('NOMAD refines P and I inside the time budget (deterministic restarts of the synchronous library)', async (t) => {
    const keep = SE.RULES.nomad.maxEvaluations; SE.RULES.nomad.maxEvaluations = 10;
    try {
        const { S } = await scenario({ gov_i_gain: 8 }, { nomad: true, budgetMs: 60000, families: ['gains'] });
        t.diagnostic(JSON.stringify(S.stages.nomad));
        assert.ok(S.stages.nomad.evaluations >= 5 && S.stages.nomad.evaluations <= 10, JSON.stringify(S.stages.nomad));
        assert.ok(S.notes.some(n => /^NOMAD compares \d+ sets of gains/.test(n)));
    } finally { SE.RULES.nomad.maxEvaluations = keep; }
});

test('without the search result the families give the pending rows of gov_tune; an unavailable search gives its reason', async () => {
    const ctx = ctxOf(null);
    assert.ok(SE.FAMILIES.gains(ctx).every(r => r.status === 'pending-model'));
    const S = await SE.search([], { model: null });
    assert.equal(S.status, 'unavailable');
    const rows = SE.FAMILIES.limits(ctxOf(S));
    assert.ok(rows.length === 4 && rows.every(r => r.status === 'keep' && r.text.startsWith(SE.TEXT.noModel)), JSON.stringify(rows.map(r => r.text)));
    assert.equal((await SE.search([], { model: { params: truth() }, validation: { status: 'rejected' } })).reason, SE.TEXT.rejected);
});

// ---------------------------------------------------------------------------------------------
// STE: every text through lintText of test/ste_text.test.cjs
// ---------------------------------------------------------------------------------------------

function steLinter() {
    const file = path.join(ROOT, 'test/ste_text.test.cjs'), src = fs.readFileSync(file, 'utf8');
    const stubs = { 'node:test': { test() {} }, 'node:worker_threads': { isMainThread: true, workerData: null } };
    const ctx = { require: (n) => stubs[n] || require(n), __dirname: path.dirname(file), __filename: file, module: { exports: {} }, process, console, Buffer, setTimeout, clearTimeout };
    vm.runInNewContext(`${src}\n;this.__ste = { lintText, loadVocabulary, FAILING };`, ctx, { filename: file });
    const S = ctx.__ste, L = S.loadVocabulary(JSON.parse(fs.readFileSync(path.join(ROOT, 'test/ste/vocabulary.json'), 'utf8')));
    return (text, kind) => S.lintText(text, kind, L).filter(h => S.FAILING.includes(h.check));
}
const D0 = { imp: 5.7, lo: 4.2, hi: 7.6, se: 1, n: 37, log: 4, t: 221.05, step: 0.2 };
// sample arguments of each template of TEXT (by the name of the template)
const SAMPLE = { noState: [4], excluded: [4, 'The log does not record the headspeed.'], few: [2, 8.4], twins: [[8, 1.4], [3, null]], noWindow: [1], change: ['gov_p_gain', 25], same: [D0], imp: [D0],
    worse: [Object.assign({}, D0, { imp: -2.8, lo: -5.3, hi: -1.2 })], twinRange: [-6.1, -5.6], 'why.small': [], 'why.blocks': [], 'why.sat': ['sample 3'], 'why.iLim': ['tm x1.4'], 'why.margin': ['sample 3'],
    'why.satE': [22.3, 0.0139, 0.0152], marginPass: [2, 0.42], marginFail: [[2, 0.98, 'sample 3'], [2, null, 'main']], marginStep: [D0], proposal: [{ gov_p_gain: 35, gov_i_gain: 42 }], design: [2, 0.0216, 0.776], designNow: [0.0317],
    designRange: ['gov_collective_ff_weight', 115, 132], uniform: [2], fKeep: [10], gridJ: ['gov_i_gain', 84, 42], twinsCurrent: [[[0.7, 1.4]]], twinWorst: [-0.2, 'tm x1.4'],
    'why.twin': ['tm x1.4'], marginNow: [2, 0.14], marginNew: [2, 0.37, 'sample 9'], marginOpt: [1, 0.39, 'tm x0.7'], glitch: [10, 861, 1125], lim: ['I-term', 0.95, 0.24, 3.79], limNone: ['P-term', 0.198, 0.3],
    limOut: ['P-term'], limIn2: ['P-term'], limMax: ['P-term'], nomad: [42, 61000], nomadTime: [17], pNoise: [0.0021, 0.0042] };
function templates(obj, where, add) {
    for (const [k, v] of Object.entries(obj)) {
        const at = where ? `${where}.${k}` : k;
        if (k === 'termName') continue;   // words in the sentences of TEXT.lim
        if (typeof v === 'string') add(v, 'message', at);
        else if (typeof v === 'function') {
            const a = SAMPLE[at]; assert.ok(a, `sample arguments of TEXT.${at}`);
            for (const args of Array.isArray(a[0]) ? a : [a]) { const s = v(...args); assert.ok(typeof s === 'string' && !/undefined|NaN|\[object/.test(s), `TEXT.${at}: ${s}`); add(s, 'message', at); }
        } else if (v && typeof v === 'object') templates(v, at, add);
    }
}
test('STE: every text of TEXT, RULES and the rows of the search', async (t) => {
    let lint;
    try { lint = steLinter(); } catch (e) { t.skip(`lintText of test/ste_text.test.cjs is not available: ${e.message}`); return; }
    const seen = new Map(), add = (text, kind, where) => { if (typeof text === 'string' && text.trim() && !seen.has(`${kind}|${text}`)) seen.set(`${kind}|${text}`, { text, kind, where }); };
    templates(SE.TEXT, '', add);
    for (const R of Object.values(SE.RULES)) if (R && R.text) add(R.text, 'message', 'RULES');
    for (const [k, cur] of [['low', null], ['lowNc', Object.assign({}, GOV, PROF, { gov_i_gain: 8 })], ['osc', Object.assign({}, GOV, PROF, OSC)], ['power', Object.assign({}, GOV, PROF, { gov_i_gain: 8 })], ['stable', Object.assign({}, GOV, PROF, { gov_p_gain: 100, gov_i_gain: 120 })]]) {
        const { S } = await once(k, () => k === 'low' ? scenario({ gov_i_gain: 8 }) : k === 'lowNc' ? scenario({ gov_i_gain: 8 }, { current: false }) : k === 'osc' ? scenario(OSC, { testS: 150 }) : k === 'stable' ? scenario({ gov_p_gain: 100, gov_i_gain: 120 }) : scenario({ gov_i_gain: 8 }, { power: true }));
        const { ctx, rows } = rowsOf(S, cur || undefined);
        for (const r of rows) {
            add(r.title, 'label', `${r.id} title`); add(r.text, 'message', r.id); add(r.reason, 'message', `${r.id} reason`); add(r.record, 'instruction', `${r.id} record`);
            for (const e of r.evidence) add(e.text, 'message', `${r.id} evidence`);
            const rec = TUNE.toRecommendation(r, ctx); add(rec.title, 'label', rec.id); add(rec.text, 'message', rec.id); for (const c of rec.caveats) add(c, 'note', `${rec.id} caveat`);
            if (r.stale) add(r.stale.text, 'note', `${r.id} stale`);
        }
        for (const n of S.notes) add(n, 'note', 'note');
    }
    const bad = [];
    for (const { text, kind, where } of seen.values()) { const h = lint(text, kind); if (h.length) bad.push(`${where}: ${h.map(x => `${x.check} ${x.detail}`).join(', ')} | "${text.slice(0, 160)}"`); }
    t.diagnostic(`${seen.size} texts`);
    assert.deepEqual(bad, []);
});
