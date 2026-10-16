'use strict';

// Tests of tools/autotune/gov_sim.cjs: the native governor on the recorded headspeed (parity, SPEC 6.7) and in closed loop with
// the governor twin (forced fallback, glitch, PID profile change, OCV), the configuration from the log (configOf), the metrics.
// The real-data tests use analysis/governor-20261014/data and the DISARM times in analysis/governor-twin/out (skip without them),
// and reproduce analysis/governor-twin/out/parity.json.
//
//   node --test test/gov_sim.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GS = require(path.join(ROOT, 'tools/autotune/gov_sim.cjs'));
const GD = require(path.join(ROOT, 'tools/autotune/gov_data.cjs'));
const GP = require(path.join(ROOT, 'tools/autotune/gov_params.cjs'));
const GT = require(path.join(ROOT, 'tools/autotune/gov_twin.cjs'));
const F = require(path.join(ROOT, 'tools/autotune/firmware_controller.cjs'));

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (tol ${tol})`);
const PROFILE_FIELDS = F.SCHEMA.filter(f => f.member.startsWith('profile.governor.')).map(f => f.name);
const pick = (o, names) => Object.fromEntries(names.filter(k => k in o).map(k => [k, o[k]]));

// a synthetic flight at 1 kHz (gov_data run): f(t) -> { thr, coll, roll, pitch, yaw, profile }; the rest voltage 25 V
function synth(seconds, f, o = {}) {
    const rate = 1000, n = Math.round(seconds * rate), c = { time: new Float64Array(n), hs: new Float32Array(n), 'motor[0]': new Float32Array(n), 'rcCommand[4]': new Float32Array(n),
        'mixer[0]': new Float32Array(n), 'mixer[1]': new Float32Array(n), 'mixer[2]': new Float32Array(n), 'mixer[3]': new Float32Array(n), Vbat: new Float32Array(n), profileAt: new Uint8Array(n) };
    for (let i = 0; i < n; i++) {
        const t = i / rate, v = f(t);
        c.time[i] = t; c['rcCommand[4]'][i] = v.thr * 1000; c.Vbat[i] = 2500; c.profileAt[i] = v.profile || 1;
        ['roll', 'pitch', 'yaw', 'coll'].forEach((k, j) => { c[`mixer[${j}]`][i] = (v[k] || 0) * 1000; });
    }
    return GD.fromColumns(c, { log: 0, n, rate, actualRate: rate, timeStartUs: 20e6, header: { looptime: o.looptime || 500, pid_process_denom: 2, vbatcellvoltage: [330, 350, 430] } }, { class: 'flight', flights: [] });
}
// the Fireball values (CLI dump 2026-10-13) with short ramps; PID profile 2 at 4000 rpm
const GOV = { gov_mode: 3, gov_throttle_type: 2, gov_startup_time: 20, gov_spoolup_time: 30, gov_tracking_time: 20, gov_recovery_time: 20, gov_spooldown_time: 30,
    gov_handover_throttle: 25, gov_autorotation_timeout: 15, gov_rpm_filter: 10, gov_ff_filter: 5, gov_d_filter: 50, tail_rotor_mode: 0, main_rotor_dir: 0 };
const PROF = { gov_flags: 0, gov_headspeed: 4500, gov_gain: 55, gov_p_gain: 18, gov_i_gain: 60, gov_d_gain: 2, gov_f_gain: 32, gov_p_limit: 30, gov_i_limit: 95, gov_d_limit: 5,
    gov_f_limit: 40, gov_yaw_weight: 5, gov_cyclic_weight: 35, gov_collective_weight: 100, gov_collective_curve: 20, gov_max_throttle: 100, gov_min_throttle: 10, gov_fallback_drop: 10 };
const cfgOf = () => { const d = F.defaults(); return { global: Object.assign({}, d, GOV), profiles: { 1: Object.assign(pick(d, PROFILE_FIELDS), PROF), 2: Object.assign(pick(d, PROFILE_FIELDS), PROF, { gov_headspeed: 4000 }) },
    gear: null, voltageSource: 'ESC', cells: 6, assumptions: [] }; };
// a Fireball-like twin (gov_twin.test.cjs), with a faster ESC soft start (a speed ramp of 2000 rpm/s from the start at u0 = 0.1)
const twin = (o = {}) => GT.copy(GT.copy(GT.defaults({ kv: 290, Href: 4500, V0: 25 }), { tm: 0.3, te: 0.05, ass: 2000, sneg: 2, q0: 0.8, qc: 1.5, qx: 0.5, qy: 0.3, qf: 0.2, pc: 2, beta: 0.12, kappa: 0 }), o);
const hover = (t) => ({ thr: t < 0.5 ? 0 : 1, coll: 0.3 + 0.05 * Math.sin(2 * t), roll: 0.05 * Math.sin(3 * t), pitch: 0.04 * Math.cos(2.3 * t), yaw: 0.1 * Math.sin(5 * t) });
const ALL = { points: 1e9 }; // every sample in the trace
const mean = (a, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += a[i]; return s / (i1 - i0); };

test('closed loop with a known twin: spool-up, then ACTIVE at the requested headspeed; the run costs well under 1.5 s', async (t) => {
    const run = synth(20, hover), res = await GS.run(run, cfgOf(), { plant: 'twin', twin: twin(), record: ALL });
    assert.ok(!res.excluded, res.excluded);
    const tr = res.trace, n = tr.i.length;
    assert.equal(tr.stride, 1); assert.equal(n, run.n);
    for (let k = n - 3000; k < n; k++) assert.equal(tr.state[k], 4);
    near(mean(tr.hs, n - 3000, n), 4500, 0.003 * 4500, 'hs');
    near(mean(tr.target, n - 3000, n), 4500, 0.5, 'target');
    assert.ok(tr.state.includes(1) && tr.state.includes(2), 'IDLE and SPOOLUP');
    const m = res.metrics.profiles[1];
    assert.ok(m.eRms > 0 && m.satShare === 0 && m.spoolups.length === 1, JSON.stringify(m));
    assert.ok(res.compare && res.parity === null && res.forced === 0);
    // a 250-s flight (SPEC performance target: under 1.5 s in Node)
    const long = synth(250, hover), t0 = process.hrtime.bigint(), r2 = await GS.run(long, cfgOf(), { plant: 'twin', twin: twin(), record: false });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    t.diagnostic(`closed loop: 250 s at 1 kHz in ${ms.toFixed(0)} ms (${(ms * 1000 / long.n).toFixed(2)} us per loop)`);
    assert.ok(ms < 1500, `${ms} ms`); assert.equal(r2.trace, null);
    // 2 kHz PID (Gaui): two loops per logged sample, the inputs held
    const fast = synth(20, hover, { looptime: 250 }), r3 = await GS.run(fast, cfgOf(), { plant: 'twin', twin: twin(), record: false });
    assert.equal(r3.loopsPerFrame, 2); near(r3.metrics.profiles[1].eRms, m.eRms, 0.5 * m.eRms + 0.05, 'the same control at 2 kHz');
});

test('a forced fallback drops the throttle to (1 - drop) x I for the 0.2-s detection time; precomp ON adds F', async () => {
    const run = synth(20, hover);
    for (const precomp of [false, true]) {
        const res = await GS.run(run, cfgOf(), { plant: 'twin', twin: twin(), record: ALL, scenario: { forceFallback: [15], values: precomp ? { all: { gov_use_fallback_precomp: 'ON' } } : null } });
        const tr = res.trace, k6 = tr.state.indexOf(6);
        assert.equal(res.forced, 1); near(tr.t[k6], 15, 0.0011, 'entry');
        let k = k6; for (; tr.state[k] === 6; k++) {
            if (!precomp) near(tr.u[k], 0.9 * tr.I[k], 2e-4, `FALLBACK sample ${k}`);
            else assert.ok(tr.u[k] > 0.9 * tr.I[k] + 0.005, `precomp ON: ${tr.u[k]} ${tr.I[k]}`);
            assert.equal(tr.I[k], tr.I[k6]); // I holds in FALLBACK
        }
        const dur = (k - k6) / run.rate;
        assert.ok(dur >= 0.19 && dur <= 0.25, `FALLBACK ${dur} s`);
        assert.equal(tr.state[k], 3); // then RECOVERY
        assert.equal(res.metrics.events.length, 1);
        const e = res.metrics.events[0];
        assert.ok(e.minRatio < 1 && e.recoveryS > 0 && e.profile === 1, JSON.stringify(e));
    }
});

test('an injected RPM glitch (one PID loop above the firmware limit) gives FALLBACK; none without', async () => {
    const run = synth(20, hover), base = await GS.run(run, cfgOf(), { plant: 'twin', twin: twin(), record: ALL, scenario: { forceFallback: [] } });
    assert.ok(!base.trace.state.includes(6));
    const res = await GS.run(run, cfgOf(), { plant: 'twin', twin: twin(), record: ALL, scenario: { forceFallback: [], glitches: [15] } });
    const tr = res.trace, k6 = tr.state.indexOf(6);
    assert.equal(res.glitches, 1); assert.ok(k6 > 0 && tr.t[k6] >= 15 && tr.t[k6] <= 15.002, `entry ${tr.t[k6]}`);
    assert.equal(res.metrics.profiles[1].fallbacks, 1);
    const m = res.metrics.profiles[1];
    assert.ok(m.gDroop < 1 && m.recoveryS > 0.2 && m.recoveryS < 5, JSON.stringify({ g: m.gDroop, r: m.recoveryS }));
});

test('a PID profile change moves the target to the headspeed of the new PID profile', async () => {
    const run = synth(25, (t) => Object.assign(hover(t), { profile: t < 12 ? 1 : 2 }));
    const res = await GS.run(run, cfgOf(), { plant: 'twin', twin: twin(), record: ALL }), tr = res.trace, n = tr.i.length;
    assert.equal(res.changes, 1);
    near(tr.target[11900], 4500, 0.5, 'before'); near(tr.target[n - 1], 4000, 0.5, 'after');
    near(mean(tr.hs, n - 3000, n), 4000, 0.003 * 4000, 'hs');
    assert.equal(tr.profile[11999], 1); assert.equal(tr.profile[12000], 2);
    assert.deepEqual(Object.keys(res.metrics.profiles).sort(), ['1', '2']);
    // a scenario value of one PID profile
    const r2 = await GS.run(run, cfgOf(), { plant: 'twin', twin: twin(), record: ALL, scenario: { values: { profiles: { 2: { gov_headspeed: 3800 } } } } });
    near(r2.trace.target[n - 1], 3800, 0.5, 'override');
});

test('the start OCV changes the saturation (end of pack against full pack); a twin without voltage scales too', async () => {
    const p = twin(), load = { coll: 0.8, cyc: 0.1, yaw: 0.2 };
    assert.ok(GT.steady(p, Object.assign({ H: 4500, ocv: 25 }, load)).d < 0.9 && GT.steady(p, Object.assign({ H: 4500, ocv: 17 }, load)).d > 1, 'premise');
    const run = synth(25, (t) => ({ thr: t < 0.5 ? 0 : 1, coll: 0.8, roll: 0.1, yaw: 0.2 }));
    const full = await GS.run(run, cfgOf(), { plant: 'twin', twin: p, record: false }), end = await GS.run(run, cfgOf(), { plant: 'twin', twin: p, record: false, scenario: { ocv: 17 } });
    assert.ok(full.metrics.profiles[1].satShare < 0.01 && end.metrics.profiles[1].satShare > 0.5, `${full.metrics.profiles[1].satShare} ${end.metrics.profiles[1].satShare}`);
    // no voltage in the twin: kv in rpm per throttle unit (V0 1); the OCV scales the twin and the recorded Vbat into the governor
    const nv = GT.copy(GT.defaults({ kv: 290 * 25, Href: 4500 }), { tm: 0.3, te: 0.05, ass: 2000, sneg: 0.08, q0: 0.032, qc: 0.06, qx: 0.02, qy: 0.012, qf: 0.008, pc: 2 });
    const a = await GS.run(run, cfgOf(), { plant: 'twin', twin: nv, record: { points: 100 } }), b = await GS.run(run, cfgOf(), { plant: 'twin', twin: nv, record: { points: 100 }, scenario: { ocv: 17 } });
    assert.ok(a.metrics.profiles[1].satShare < 0.01 && b.metrics.profiles[1].satShare > 0.5);
    near(a.trace.vbat[50], 25, 1e-4); near(b.trace.vbat[50], 17, 1e-4);
    // twinStart: the rotor stopped at the rest voltage (the same here: the log starts with the rotor stopped)
    const c = await GS.run(run, cfgOf(), { plant: 'twin', twin: p, record: false, scenario: { twinStart: true } });
    assert.equal(c.metrics.profiles[1].satShare, full.metrics.profiles[1].satShare);
    // the rest offset vp of the twin: a start from rest puts the OCV at the rest voltage (or the scenario ocv) less vp
    const w = await GS.run(run, cfgOf(), { plant: 'twin', twin: twin({ vp: 0.4 }), record: ALL }), w0 = await GS.run(run, cfgOf(), { plant: 'twin', twin: p, record: ALL });
    near(w.trace.vbat[400], 24.6, 1e-3, 'before the motor start'); near(w0.trace.vbat[400], 25, 1e-3);
    const we = await GS.run(run, cfgOf(), { plant: 'twin', twin: twin({ vp: 0.4 }), record: ALL, scenario: { ocv: 17 } });
    near(we.trace.vbat[400], 16.6, 1e-3, 'end of pack less vp');
});

test('a log or a part of a log that starts later than IDLE is not simulated (the governor starts at OFF), unless twinStart', async () => {
    const run = synth(5, hover); run.state = new Uint8Array(run.n).fill(4); run.hs.fill(4500); run.u = new Float32Array(run.n).fill(0.6); run.segment = 1;
    const res = await GS.run(run, cfgOf(), { plant: 'twin', twin: twin(), record: false });
    assert.equal(res.excluded, GS.TEXT.midStart(run, 4)); assert.match(res.excluded, /^Part 2 of log 1 starts with the governor in ACTIVE\./);
    assert.ok(!(await GS.run(run, cfgOf(), { plant: 'twin', twin: twin(), record: false, scenario: { twinStart: true } })).excluded);
    run.state[0] = 1; assert.ok(!(await GS.run(run, cfgOf(), { plant: 'twin', twin: twin(), record: false })).excluded, 'IDLE at the start: the arm');
    // without governor states: the motor on at sample 0
    run.state = null; assert.equal((await GS.run(run, cfgOf(), { plant: 'recorded', record: false })).excluded, GS.TEXT.midStart(run, null));
});

test('decompose keeps the products of the gains; toSchema maps the CLI names', () => {
    const v = { gov_gain: 55, gov_p_gain: 18, gov_i_gain: 60, gov_f_gain: 32, gov_collective_ff_weight: 100, gov_cyclic_ff_weight: 35, gov_yaw_ff_weight: 5 };
    const prods = {}; for (const e of Object.keys(GS.PRODUCTS)) prods[e] = PRODUCTS(e, v);
    assert.deepEqual(GS.decompose({}, prods, { gov_gain: [40, 55], gov_f_gain: [10, 32] }).values, v); // 40 cannot keep K Ki (I 82.5)
    const any = GS.decompose({}, prods, {});
    assert.ok(any && any.err <= GS.RULES.decompTol);
    for (const e of Object.keys(GS.PRODUCTS)) near(PRODUCTS(e, any.values), prods[e], GS.RULES.decompTol * prods[e], e);
    // known factors stay; only the yaw weight is missing
    const k = Object.assign({}, v); delete k.gov_yaw_ff_weight;
    assert.equal(GS.decompose(k, { gov_yaw_ff_effective: 0.0264 }, {}).values.gov_yaw_ff_weight, 15);
    assert.equal(GS.decompose(v, prods, {}), null);
    const s = GS.toSchema({ gov_mode: 'ELECTRIC', gov_throttle_type: 'FUNCTION', battery_meter: 'ESC', gov_yaw_ff_weight: 5, gov_use_fallback_precomp: 'ON', gov_use_pid_spoolup: 'OFF',
        gov_bypass_throttle: [1, 2, 3, 4, 5, 6, 7, 8, 9], main_rotor_gear_ratio: [1, 1], gov_headspeed: '3500' }, { gov_flags: 16 });
    assert.deepEqual(s, { gov_mode: 3, gov_throttle_type: 2, voltage_meter: 2, gov_yaw_weight: 5, 'gov_bypass_throttle[0]': 1, 'gov_bypass_throttle[1]': 2, 'gov_bypass_throttle[2]': 3,
        'gov_bypass_throttle[3]': 4, 'gov_bypass_throttle[4]': 5, 'gov_bypass_throttle[5]': 6, 'gov_bypass_throttle[6]': 7, 'gov_bypass_throttle[7]': 8, 'gov_bypass_throttle[8]': 9,
        'main_rotor_gear_ratio[0]': 1, 'main_rotor_gear_ratio[1]': 1, gov_headspeed: 3500, gov_flags: 4 });
    assert.equal(GS.cliDefault('gov_use_voltage_comp'), 'OFF'); assert.equal(GS.cliDefault('gov_mode'), 'OFF'); assert.equal(GS.cliDefault('gov_yaw_ff_weight'), 10);
});
function PRODUCTS(e, v) { const f = GS.PRODUCTS[e]; return f.length === 2 ? v[f[0]] * v[f[1]] / 1000 : v.gov_gain * v.gov_f_gain * v[f[2]] / 1e6; }

test('configOf excludes a log with an STE reason: no throttle input, BYPASS, an unknown PID profile; run() returns the reason', async () => {
    const R = { profileMap: { byHeadspeed: {}, basis: {} }, items: [], epochs: [], flags: [], unknown: [] };
    const noThr = synth(2, hover); noThr.thr = null;
    assert.equal(GS.configOf([noThr], R)['0'].excluded, GS.TEXT.noThr);
    const bypass = synth(2, hover); bypass.state = new Uint8Array(bypass.n); bypass.state[100] = 9;
    assert.equal(GS.configOf([bypass], R)['0'].excluded, GS.TEXT.bypass(0));
    const unknown = synth(2, hover); unknown.profile = new Uint8Array(unknown.n); unknown.request = new Float32Array(unknown.n).fill(4500);
    const c = GS.configOf([unknown], R)['0'];
    assert.equal(c.excluded, GS.TEXT.profileUnknown(0)); assert.match(c.excluded, /^PID profile unknown\./);
    assert.deepEqual(await GS.run(unknown, c), { log: 0, plant: 'recorded', excluded: c.excluded });
    // without values: every name the governor reads is unknown, and the first one is the reason
    unknown.request.fill(4500); const R2 = Object.assign({}, R, { profileMap: { byHeadspeed: { 4500: 1 }, basis: {} } });
    const c2 = GS.configOf([unknown], R2)['0'];
    assert.equal(c2.excluded, GS.TEXT.unknownValue('gov_mode', 0, 0));
    assert.ok(c2.unknown.some(u => u.name === 'gov_tracking_time' && u.used) && c2.unknown.some(u => u.name === 'gov_bypass_throttle' && !u.used));
});

// ---- the real data: parity with analysis/governor-twin/parity.cjs (out/parity.json, 2026-10-14) ----

const DATA = path.join(ROOT, 'analysis/governor-20261014/data'), OUT = path.join(ROOT, 'analysis/governor-twin/out');
const CLI = '/Users/albertwu/My Drive (albert.mh.wu@gmail.com)/RC/SAB/Fireball - Havok/RTFL_cli_SAB_Fireball_20261013_184504.txt';
const hasData = (craft) => fs.existsSync(path.join(DATA, craft, 'meta.json')) && fs.existsSync(path.join(OUT, `disarm_${craft}.json`));
// the runs of a craft with the DISARM events of the flash dump (cached by parity.cjs) until gov_data gets the events from the worker
function real(craft) {
    const dir = path.join(DATA, craft), meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const d = JSON.parse(fs.readFileSync(path.join(OUT, `disarm_${craft}.json`), 'utf8')), events = {};
    for (const s of meta.segments) events[s.log] = (d.us[s.log] || []).map(us => ({ t: (us - s.timeStartUs) / 1e6 + (s.fromS || 0), name: 'DISARM' }));
    return GD.load(dir, { bench: true, events });
}
const PARITY = { fireball: { 10: { state: 0.99998, rms: 0.52, max: 2, n: 179642, changes: 3 } }, gaui: { 38: { state: 0.99998, rms: 0.64, max: 3, n: 208795, changes: 14 } } };
function checkParity(res, want, msg) {
    assert.ok(!res.excluded, res.excluded);
    const p = res.parity;
    assert.equal(p.stateAgreement, want.state, msg); assert.equal(p.throttle.rms, want.rms, msg); assert.equal(p.throttle.maxAbs, want.max, msg); assert.equal(p.throttle.n, want.n, msg);
    assert.equal(res.changes, want.changes, msg); assert.ok(p.gate.pass, msg);
    assert.equal(p.segments.length, want.changes + 1); assert.ok(p.segments.every(s => s.stateAgreement >= 0.99), msg);
}

test('Fireball log 10: the parity of parity.cjs, with the CLI dump and from the log alone (the same numbers)', { skip: !hasData('fireball') && 'no analysis data' }, async () => {
    const runs = real('fireball'), run = runs.find(r => r.log === 10), cli = fs.existsSync(CLI) ? fs.readFileSync(CLI, 'utf8') : null;
    const logOnly = GS.configOf(runs, GP.recover(runs))['10'];
    checkParity(await GS.run(run, logOnly, { record: false }), PARITY.fireball[10], 'log only');
    // PID profile 3 (5000 rpm) has no log header: its gains keep the products of the log; the D gain of PID profile 1 (same gov_gain)
    assert.deepEqual(pick(logOnly.profiles[3], ['gov_gain', 'gov_p_gain', 'gov_i_gain', 'gov_d_gain', 'gov_f_gain', 'gov_collective_weight', 'gov_cyclic_weight', 'gov_yaw_weight']),
        { gov_gain: 55, gov_p_gain: 18, gov_i_gain: 60, gov_d_gain: 2, gov_f_gain: 32, gov_collective_weight: 100, gov_cyclic_weight: 35, gov_yaw_weight: 5 });
    assert.ok(logOnly.assumptions.some(a => a.name === 'gov_gain' && a.profile === 3 && a.reason === GS.TEXT.decomposed(3, '"gov_gain" 55, "gov_p_gain" 18, "gov_i_gain" 60, "gov_f_gain" 32, "gov_collective_ff_weight" 100, "gov_cyclic_ff_weight" 35 and "gov_yaw_ff_weight" 5')));
    assert.equal(logOnly.profileSources[1].gov_p_gain, 'log header'); assert.match(logOnly.sources.gov_startup_time, /^calculated from the log: /);
    assert.equal(logOnly.excluded, null); assert.equal(logOnly.start, 1);
    if (!cli) return;
    const cfgs = GS.configOf(runs, GP.recover(runs, { cli }), { cli }), c10 = cfgs['10'];
    checkParity(await GS.run(run, c10, { record: false }), PARITY.fireball[10], 'CLI');
    assert.deepEqual(c10.assumptions, []); assert.equal(c10.voltageSource, 'ESC'); assert.deepEqual(c10.gear, [1, 1]);
    for (const n of GP.GLOBAL) assert.ok(['CLI dump', 'unknown'].includes(c10.sources[n]), `${n}: ${c10.sources[n]}`);
    // log 5: the timing of its own epoch (the CLI dump disagrees), the CLI value where the log cannot show it
    const c5 = cfgs['5'];
    assert.equal(c5.cli.global.gov_startup_time, 200); assert.match(c5.sources.gov_startup_time, /^calculated from the log/);
    assert.equal(c5.cli.global.gov_spooldown_time, 100); assert.equal(c5.cli.global.gov_recovery_time, 20); assert.equal(c5.sources.gov_recovery_time, 'CLI dump');
    assert.ok(c5.flags.some(f => f.name === 'gov_spooldown_time'), 'the flag of a value that changes with no record');
});

test('Gaui log 38: the parity of parity.cjs from the log alone (no CLI dump); the closed loop runs on the same configuration', { skip: !hasData('gaui') && 'no analysis data' }, async () => {
    const runs = real('gaui'), run = runs.find(r => r.log === 38), cfgs = GS.configOf(runs, GP.recover(runs)), c = cfgs['38'];
    checkParity(await GS.run(run, c, { record: false }), PARITY.gaui[38], 'Gaui');
    assert.equal(run.loopsPerFrame, 2);
    // the configuration of parity.cjs: header gains for all PID profiles, yaw weight 10 in log 38 and 80 in log 48 (critique C1), ELECTRIC
    for (const p of [1, 2, 3]) assert.deepEqual(pick(c.profiles[p], ['gov_gain', 'gov_p_gain', 'gov_i_gain', 'gov_d_gain', 'gov_f_gain', 'gov_collective_weight', 'gov_cyclic_weight', 'gov_yaw_weight', 'gov_collective_curve']),
        { gov_gain: 40, gov_p_gain: 40, gov_i_gain: 50, gov_d_gain: 0, gov_f_gain: 10, gov_collective_weight: 50, gov_cyclic_weight: 10, gov_yaw_weight: 10, gov_collective_curve: 20 }, `PID profile ${p}`);
    for (const p of [1, 2, 3]) assert.equal(cfgs['48'].profiles[p].gov_yaw_weight, 80);
    assert.equal(c.global.gov_mode, 3); assert.equal(c.global.gov_startup_time, 250); assert.equal(c.global.gov_spoolup_time, 200); assert.equal(cfgs['48'].global.gov_spoolup_time, 150);
    assert.equal(c.gear, null);
    // the assumptions in effect: FALLBACK values only when the simulation goes to FALLBACK
    const tw = GT.copy(GT.defaults({ kv: 157, Href: 2500, V0: 25, current: true }), { tm: 0.15, te: 0.05, ass: 300, asr: 0.45, as0: 130, u0: 0.116, sneg: 3, q0: 0.6, qc: 1.2, qx: 0.4, qy: 0.5, qf: 0.15, pc: 1.8, beta: 0.85, kappa: 0.025, rm: 0.018, i0: 1.2 });
    const a = await GS.run(run, c, { plant: 'twin', twin: tw, record: false }), b = await GS.run(run, c, { plant: 'twin', twin: tw, record: false, scenario: { glitches: [100] } });
    assert.ok(!a.assumedInEffect.some(x => x.name === 'gov_fallback_drop'));
    assert.ok(b.assumedInEffect.some(x => x.name === 'gov_fallback_drop') && b.assumedInEffect.some(x => x.name === 'gov_recovery_time'));
    assert.ok(a.compare.stateAgreement > 0.9 && a.compare.vbatRms !== null && a.ms < 1500, JSON.stringify(a.compare));
});

test('logMetrics: the spool-up overshoot of Fireball log 10 is 12.9 % (critique C6)', { skip: !hasData('fireball') && 'no analysis data' }, () => {
    const runs = real('fireball').filter(r => r.log === 10 || r.log === 13), cfgs = GS.configOf(runs, GP.recover(runs));
    const m = GS.logMetrics(runs[0], cfgs['10']);
    near(m.profiles[1].spoolOvershoot, 12.9, 0.05);
    assert.ok(m.profiles[2].satShare > 0 && m.profiles[2].eRms > 0);
});
