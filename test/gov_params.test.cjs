'use strict';

// Tests of tools/autotune/gov_params.cjs: the governor configuration recovered from the log (ramps, plateaus, timeouts, the
// govP/govI/govF identities, FALLBACK, piles, PID spool-up, the throttle type and the governor mode), the epochs of unlogged
// changes and of in-flight adjustments with their flags, the products of the PID profiles that the header does not describe,
// missing fields and header values, the CLI comparison.
//
//   node --test test/gov_params.test.cjs
//   With analysis/governor-20261014/data (the extracted Fireball and Gaui logs, not in git), also the real-data checks: the
//   timing epochs of Fireball logs 5-9 (critique V4), the Fireball values of logs 10-15, the Gaui yaw weights (critique C1).
//   GOV_CLI=<RTFL_cli_SAB_Fireball_20261013_184504.txt> also compares the Fireball result with that CLI dump; without it, that test skips.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GD = require(path.resolve(__dirname, '../tools/autotune/gov_data.cjs'));
const GP = require(path.resolve(__dirname, '../tools/autotune/gov_params.cjs'));

const HEADER = { govPID: [30, 40, 0, 20, 50], yaw_tta: [0, 20], features: 1 << 26 }; // K Kp 1.5, K Ki 2, K Kf 0.1
const LAG = 0.0022; // s: the logged headspeed lags the raw RPM (motor_rpm_lpf)
const trunc = (v) => Math.trunc(v * 1000), clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const at = (res, name, log, profile = 0) => res.items.filter(i => i.name === name && (log === undefined || i.log === log) && (i.profile === profile || i.scope === 'global'));
const value = (res, name, log, profile) => { const l = at(res, name, log, profile).filter(i => i.value !== null); assert.ok(l.length, `${name} log ${log} profile ${profile}: no value`); return l[0]; };

// the firmware PT2 low-pass (common_filter.c: pt2FilterGain, pt1FilterGain, limitCutoff, pt2FilterApply), written again here
function pt2Filter(cutoff, rate) {
    const pt1Gain = (fc) => { if (!(fc > 0)) return 1; fc = Math.min(fc, 0.475 * rate); return Math.min(1, fc / (fc + rate / (2 * Math.PI))); };
    const k = pt1Gain(cutoff * 1.553773974); let y1 = null, y2 = null;
    return (x) => { if (y1 === null) y1 = y2 = x; y2 += (x - y2) * k; y1 += (y2 - y1) * k; return y1; };
}

// A synthetic flight with the governor laws of flight_governor.c, at the PID rate pidHz, logged every L-th PID loop: OFF, IDLE
// ramp to the handover clamp, SPOOLUP ramp (open loop, or PID after the handover with pidSpool), ACTIVE with the PID and
// feedforward terms, optional FALLBACK and RECOVERY, AUTOROTATION ramp down to the auto throttle, OFF. The governor sees the raw RPM
// of the last PID loop through PT2(rpmHz); the log has the raw RPM LAG s before. Options (tau: s from the start of ACTIVE):
// R (gov_headspeed), Rof(tau), sw (SWITCH: govRequest = stick x gov_headspeed), stickOf(tau) (counts), wOf(tau), kkfOf(tau),
// profileAt(i) (logged frames), direct (govSum 0 in ACTIVE), pidSpool, fallback, autoStick (AUTOROTATION), events, header, cls
const BASE = { log: 1, R: 3500, startup: 150, spoolup: 120, spooldown: 60, handover: 25, activeS: 60, rpmHz: 8, kkp: 1.5, kki: 2, kkf: 0.1, w: [70, 20, 15], curve: 18, ffHz: 4, i0: 0.7, pidHz: 1000, L: 1 };
function flight(opt) {
    const o = Object.assign({}, BASE, opt), hz = o.pidHz, dt = 1 / hz;
    const Hf = (tau) => o.Rof ? o.Rof(tau) : o.R, stick = (tau) => o.stickOf ? o.stickOf(tau) : 1000, req = (tau) => o.sw ? stick(tau) / 1000 * Hf(tau) : Hf(tau);
    const mix = (tau) => [0.15 * Math.sin(2 * Math.PI * 0.9 * tau), 0.12 * Math.sin(2 * Math.PI * 1.3 * tau + 2), 0.3 * Math.sin(2 * Math.PI * 0.45 * tau + 1),
        0.35 + 0.3 * Math.sin(2 * Math.PI * 0.21 * tau) + (o.load && tau > o.load[0] && tau < o.load[1] ? 0.6 : 0)];
    const dist = (tau) => 40 * Math.sin(2 * Math.PI * 0.7 * tau) + 25 * Math.sin(2 * Math.PI * 3.1 * tau + 1) + 12 * Math.sin(2 * Math.PI * 9.3 * tau) - (o.load && tau > o.load[0] && tau < o.load[1] ? 250 : 0);
    // the plan: { st (state), sec, thr (stick), raw (rpm at tau, s from the start of the step), sp (spool-up time), hold (ACTIVE without the PID) }
    const plan = [{ st: 0, sec: 0.5, thr: 0, raw: () => 0 }];
    for (const sp of o.spoolups || [o.spoolup]) plan.push({ st: 1, sec: 4, thr: 1000, raw: (tau) => tau * 300 }, { st: 2, sec: 4, thr: 1000, raw: (tau) => 1200 + tau * 600, sp });
    plan.push({ st: 4, sec: o.activeS, raw: (tau) => req(tau) + dist(tau) });
    if (o.fallback) plan.push({ st: 6, sec: 0.2, thr: 1000, raw: (tau) => o.R - tau * 3000 }, { st: 3, sec: 0.6, thr: 1000, raw: (tau) => o.R - 600 + tau * 1000 }, { st: 4, sec: 1, thr: 1000, raw: () => o.R, hold: true });
    plan.push({ st: 7, sec: 6, thr: o.autoStick || 509, raw: (tau) => Math.max(0, o.R - tau * 1000) }, { st: 0, sec: 0.5, thr: 0, raw: () => 0 });
    let t0 = 0; for (const p of plan) { p.t0 = t0; t0 += p.sec; }
    const rawAt = (t) => { if (t < 0) return 0; const p = plan.find(q => t < q.t0 + q.sec) || plan[plan.length - 1]; return p.raw(t - p.t0); };
    const names = ['profileAt', 'govStateAt', 'hs', 'time', 'govP', 'govI', 'govD', 'govF', 'govSum', 'govTarget', 'govRequest', 'motor[0]', 'rcCommand[4]', 'mixer[0]', 'mixer[1]', 'mixer[2]', 'mixer[3]', 'Vbat', 'flightModeFlags'];
    const c = {}; for (const k of names) c[k] = [];
    const H = pt2Filter(o.rpmHz, hz), FF = pt2Filter(o.ffHz, hz);
    let k = 0, u = 0, I = o.i0, Q = req(0);
    const log = (st, thr, x) => {
        const t = k * dt; c.time.push(t); c.govStateAt.push(st); c['rcCommand[4]'].push(thr); c['motor[0]'].push(Math.round(u * 1000)); c.hs.push(Math.round(rawAt(t - LAG)));
        c.profileAt.push(o.profileAt ? o.profileAt(c.time.length - 1) : 0); c.govRequest.push(Math.round(Q)); c.Vbat.push(2450); c.flightModeFlags.push(1);
        for (const n of ['govP', 'govI', 'govD', 'govF', 'govSum']) c[n].push(x[n] || 0);
        c.govTarget.push(x.T === undefined ? Math.round(rawAt(t - LAG)) : Math.round(x.T)); (x.mix || [0, 0, 0, 0]).forEach((v, j) => c[`mixer[${j}]`].push(Math.round(v * 1000)));
    };
    for (const p of plan) {
        const n = Math.round(p.sec * hz);
        if (p.st === 1) u = 0;
        for (let j = 0; j < n; j++, k++) {
            const t = k * dt, tau = t - p.t0, h = H(rawAt(t - dt)); let x = {}, thr = p.thr;
            if (p.st === 1) u = Math.min(o.handover / 100, u + 10 / (o.startup * hz));
            else if (p.st === 2) { const pid = o.pidSpool && u > o.handover / 100 + 0.01; u = Math.min(0.62, u + 10 / (p.sp * hz) * (pid ? 0.5 + 0.3 * Math.sin(t) : 1)); if (pid) x.govSum = trunc(u); }
            else if (p.st === 4 && !p.hold) { // ACTIVE with the PID and the feedforward
                const m = mix(tau), T = req(tau), e = (T - h) / Hf(tau), P = o.kkp * e, C = o.kki * e * dt, w = o.wOf ? o.wOf(tau) : o.w, kkf = o.kkfOf ? o.kkfOf(tau) : o.kkf;
                const F = FF(kkf * (w[0] / 100 * Math.pow(Math.abs(m[3]), o.curve / 10) + w[1] / 100 * Math.hypot(m[0], m[1]) + w[2] / 100 * Math.abs(m[2]))), S = P + I + C + F;
                if ((S > 0.1 || C > 0) && (S < 1 || C < 0)) I += C;
                u = clamp(S, 0.1, 1); Q = T; thr = stick(tau);
                x = { T, govP: trunc(P), govI: trunc(I), govF: trunc(F), govSum: o.direct ? 0 : trunc(S), mix: m };
            }
            else if (p.st === 6) { u = I * (1 - o.drop / 100); x = { govI: trunc(I), govSum: trunc(I) }; }
            else if (p.st === 3) u = j === 0 ? 0.55 : Math.min(1, u + 10 / (o.recovery * hz));
            else if (p.st === 4) x = { T: o.R, govI: trunc(I), govSum: trunc(u) };
            else if (p.st === 7) u = Math.max(0, u - 10 / (o.spooldown * hz));
            else u = 0;
            if (k % o.L === 0) log(p.st, thr, x);
        }
    }
    const N = c.time.length, cols = {}; for (const n in c) cols[n] = Float64Array.from(c[n]);
    for (const n of o.drop_ || []) delete cols[n];
    return GD.fromColumns(cols, { log: o.log, segment: 0, n: N, rate: hz / o.L, actualRate: hz / o.L, fromS: 0, events: o.events,
        header: Object.assign({ looptime: 1e6 / hz / 2, pid_process_denom: 2 }, o.header || HEADER) }, { class: o.cls || 'flight', flights: [], code: new Uint8Array(N) });
}

test('ramps, plateaus and the PID identities of a synthetic flight give the configuration', () => {
    const res = GP.recover([flight({ load: [40, 42], i0: 0.85 })]);
    for (const [name, v] of [['gov_startup_time', 150], ['gov_spoolup_time', 120], ['gov_spooldown_time', 60], ['gov_handover_throttle', 25], ['gov_auto_throttle', 0], ['gov_idle_throttle', 0],
        ['gov_throttle_type', 'FUNCTION'], ['gov_rpm_filter', 8], ['gov_ff_filter', 4]]) assert.equal(value(res, name, 1).value, v, name);
    const p = (name) => value(res, name, 1, 0);
    // the samples before a logged change of the PID profile have no label (0), and their key is the headspeed
    assert.equal(p('gov_headspeed').value, 3500); assert.equal(p('gov_headspeed').headspeed, 3500);
    assert.equal(p('gov_collective_curve').value, 18);
    assert.ok(Math.abs(p('gov_kp_effective').estimate - 1.5) < 0.01, `K Kp ${p('gov_kp_effective').estimate}`);
    assert.ok(Math.abs(p('gov_ki_effective').estimate - 2) < 0.04, `K Ki ${p('gov_ki_effective').estimate}`);
    // the start of the log: the log header gives K Kf = 0.5 x 0.2, so the weights; the products K Kf w always
    for (const [name, w] of [['gov_collective_ff_weight', 70], ['gov_cyclic_ff_weight', 20], ['gov_yaw_ff_weight', 15]]) assert.ok(Math.abs(p(name).estimate - w) < 1, `${name} ${p(name).estimate}`);
    for (const [name, w] of [['gov_collective_ff_effective', 0.07], ['gov_cyclic_ff_effective', 0.02], ['gov_yaw_ff_effective', 0.015]]) assert.ok(Math.abs(p(name).estimate / w - 1) < 0.02, `${name} ${p(name).estimate}`);
    assert.equal(p('gov_use_voltage_comp').value, 'inactive');
    assert.equal(p('gov_max_throttle').value, 100); // govSum beyond the output at 1000 (C8)
    assert.equal(p('gov_use_pid_spoolup').value, 'OFF'); // the open loop to 62 %, above the handover of 25 %
    for (const [name, v] of [['gov_gain', 50], ['gov_p_gain', 30], ['gov_i_gain', 40], ['gov_f_gain', 20], ['gov_tta_limit', 20]]) { const it = p(name); assert.equal(it.value, v, name); assert.equal(it.source, 'log header'); }
    // AUTOROTATION ended with the throttle switch at 0 before the timeout: a lower bound
    const ar = at(res, 'gov_autorotation_timeout', 1)[0]; assert.equal(ar.kind, 'lower'); assert.equal(ar.lo, 6);
    const st = value(res, 'gov_spoolup_time', 1);
    assert.equal(st.source, `calculated from the log: ${GP.METHOD.gov_spoolup_time}`); assert.deepEqual(st.logs, [1]); assert.ok(st.se < 0.5);
    assert.ok(res.unknown.some(u => u.name === 'gov_bypass_throttle' && /BYPASS/.test(u.reason)));
    assert.equal(res.unknown.find(u => u.name === 'gov_pwr_filter').reason, GP.NOT_SHOWN.gov_pwr_filter); // voltage compensation not active
    assert.equal(res.changes.length, 0); assert.equal(res.flags.length, 0);
});

test('two PID loops per logged frame (2 kHz, logged at 1 kHz): the filters, the gains and the weights', () => {
    const run = flight({ pidHz: 2000, L: 2, activeS: 40, rpmHz: 12, ffHz: 6 });
    assert.equal(run.pidHz, 2000); assert.equal(run.loopsPerFrame, 2); assert.equal(run.rate, 1000);
    const res = GP.recover([run]), p = (name) => value(res, name, 1, 0);
    assert.ok(Math.abs(p('gov_rpm_filter').value - 12) <= 1, `rpm filter ${p('gov_rpm_filter').value}`);
    assert.ok(Math.abs(p('gov_ff_filter').value - 6) <= 1, `ff filter ${p('gov_ff_filter').value}`);
    assert.ok(Math.abs(p('gov_kp_effective').estimate / 1.5 - 1) < 0.02, `K Kp ${p('gov_kp_effective').estimate}`);
    assert.ok(Math.abs(p('gov_ki_effective').estimate / 2 - 1) < 0.03, `K Ki ${p('gov_ki_effective').estimate}`);
    for (const [name, w] of [['gov_collective_ff_weight', 70], ['gov_cyclic_ff_weight', 20], ['gov_yaw_ff_weight', 15]]) assert.ok(Math.abs(p(name).estimate - w) < 1.5, `${name} ${p(name).estimate}`);
    for (const [name, v] of [['gov_startup_time', 150], ['gov_spoolup_time', 120], ['gov_spooldown_time', 60]]) assert.equal(p(name).value, v, name);
});

test('a cutoff of 0 (no filter) is a value; a cutoff above the range is not', () => {
    const res = GP.recover([flight({ activeS: 40, rpmHz: 0, ffHz: 0 })]);
    assert.deepEqual([value(res, 'gov_rpm_filter', 1).value, value(res, 'gov_ff_filter', 1).value], [0, 0]);
    for (const it of res.items.filter(i => /_filter$/.test(i.name))) assert.ok((it.value === null || it.value <= GP.RULES.maxHz) && (it.lo === null || it.lo <= GP.RULES.maxHz), JSON.stringify(it));
});

test('FALLBACK gives the drop and the precompensation, RECOVERY the recovery time and the electric mode', () => {
    const res = GP.recover([flight({ activeS: 20, fallback: true, drop: 15, recovery: 25 })]);
    assert.ok(Math.abs(value(res, 'gov_fallback_drop', 1).estimate - 15) < 0.3);
    assert.equal(value(res, 'gov_fallback_drop', 1).value, 15);
    assert.equal(value(res, 'gov_use_fallback_precomp', 1).value, 'OFF');
    assert.equal(value(res, 'gov_recovery_time', 1).value, 25);
    assert.equal(value(res, 'gov_mode', 1).value, 'ELECTRIC');
});

test('PID spool-up: ON from govSum, the spool-up time from the open loop only; OFF needs the handover throttle', () => {
    // the IDLE ramp ends below the handover of 40 % (as on the Gaui): an open-loop ramp in SPOOLUP up to 41 %, then the PID
    const pid = GP.recover([flight({ activeS: 12, pidSpool: true, handover: 40 })]);
    assert.equal(value(pid, 'gov_use_pid_spoolup', 1).value, 'ON');
    assert.deepEqual(pid.epochs.filter(e => e.name === 'gov_spoolup_time').map(e => e.value), [120]);
    assert.equal(pid.changes.length, 0);
    // the IDLE ramp does not reach the handover of 40 %: the handover is not known, so the open loop to 60 % does not prove OFF
    const open = GP.recover([flight({ activeS: 12, handover: 40 })]), it = at(open, 'gov_use_pid_spoolup', 1)[0];
    assert.equal(it.kind, 'candidates'); assert.deepEqual(it.candidates, ['OFF', 'ON']); assert.match(it.reason, /increases to 60 %/);
    assert.ok(!open.unknown.some(u => u.name === 'gov_use_pid_spoolup'));
});

test('the governor mode: DIRECT from govSum 0 in ACTIVE, candidates without the RECOVERY step, no mode from the battery current', () => {
    const direct = GP.recover([flight({ activeS: 12, direct: true })]);
    assert.equal(value(direct, 'gov_mode', 1).value, 'DIRECT');
    assert.equal(at(direct, 'gov_use_pid_spoolup', 1).length, 0); // DIRECT has no PID
    const gov = GP.recover([flight({ activeS: 12 })]), mode = gov.items.find(i => i.name === 'gov_mode');
    assert.equal(mode.kind, 'candidates'); assert.deepEqual(mode.candidates, ['ELECTRIC', 'NITRO']); assert.equal(mode.reason, GP.TEXT.modeCand);
    // no GOVERNOR_STATE event and no PID terms while the motor runs: OFF or LIMIT
    const n = 3000, zero = new Float64Array(n), cols = { hs: new Float64Array(n).fill(3000), 'motor[0]': new Float64Array(n).fill(500) };
    for (const k of ['govP', 'govI', 'govF', 'govSum', 'govTarget', 'govRequest']) cols[k] = zero;
    const limit = GP.recover([GD.fromColumns(cols, { log: 1, n, rate: 1000, header: {} }, null)]).items.find(i => i.name === 'gov_mode');
    assert.deepEqual([limit.kind, limit.candidates], ['candidates', ['OFF', 'LIMIT']]);
});

test('SWITCH: govRequest = stick x gov_headspeed; the error uses gov_headspeed, and the headspeed rule of the PID profiles does not apply', () => {
    // two stick positions in ACTIVE of PID profile 1 (logged at the start): 1000 and 800 counts
    const run = flight({ R: 4500, sw: true, activeS: 40, stickOf: (tau) => tau < 20 ? 1000 : 800, profileAt: () => 1 });
    const res = GP.recover([run]), p = (name) => value(res, name, 1, 1);
    assert.equal(value(res, 'gov_throttle_type', 1).value, 'SWITCH');
    assert.deepEqual(res.profileMap.byHeadspeed, {}); assert.ok(res.notes.includes(GP.TEXT.switchNote([1])));
    assert.equal(p('gov_headspeed').value, 4500);
    assert.ok(Math.abs(p('gov_kp_effective').estimate / 1.5 - 1) < 0.02, `K Kp ${p('gov_kp_effective').estimate}`);
    assert.ok(Math.abs(p('gov_ki_effective').estimate / 2 - 1) < 0.04, `K Ki ${p('gov_ki_effective').estimate}`);
    assert.equal(GP.throttleRequest(run).hf.get(1), 4500);
});

test('NORMAL from two stick positions with one govRequest; one stick position and a PID profile change give candidates, no change', () => {
    const A0 = 500 + 8000; // the first ACTIVE frame
    const normal = GP.recover([flight({ activeS: 30, stickOf: (tau) => tau < 15 ? 500 : 600, profileAt: () => 1, autoStick: 200 })]);
    assert.equal(value(normal, 'gov_throttle_type', 1).value, 'NORMAL');
    const bank = (log, sw) => flight({ log, activeS: 30, stickOf: () => 500, autoStick: 200, profileAt: (i) => sw && i >= A0 + 15000 ? 2 : 1, Rof: sw ? (tau) => tau >= 15 ? 4500 : 3500 : undefined });
    const res = GP.recover([bank(1, false), bank(2, true)]);
    assert.ok(at(res, 'gov_throttle_type').every(i => i.kind === 'candidates' && i.reason === GP.TEXT.typeCand));
    assert.equal(res.changes.filter(c => c.name === 'gov_throttle_type').length, 0);
    assert.equal(res.flags.filter(f => f.name === 'gov_throttle_type').length, 0);
});

test('a change between logs with the same headers is a recovered change: epochs, changes, and the flags of the epochs with a flight', () => {
    const runs = [flight({ log: 3, activeS: 12 }), flight({ log: 4, activeS: 12, spoolup: 80 }), flight({ log: 5, activeS: 12, spoolup: 80, cls: 'bench' }), flight({ log: 6, activeS: 12, spoolup: 100, cls: 'bench' })];
    const res = GP.recover(runs);
    const eps = res.epochs.filter(e => e.name === 'gov_spoolup_time');
    assert.deepEqual(eps.map(e => [e.value, e.logs, e.bench]), [[120, [3], false], [80, [4, 5], false], [100, [6], true]]);
    const ch = res.changes.find(c => c.name === 'gov_spoolup_time');
    assert.deepEqual([ch.from, ch.to, ch.after.log, ch.before.log, ch.inLog, ch.headersEqual, ch.reason], [120, 80, 3, 4, false, true, 'recovered']);
    // no flag for the bench-only epoch; the flight logs only; the texts give log + 1
    const fl = res.flags.filter(f => f.name === 'gov_spoolup_time');
    assert.deepEqual(fl.map(f => f.logs), [[3], [4]]);
    for (const f of fl) { assert.deepEqual(f.reasons, ['recovered']); assert.equal(f.cause, GP.TEXT.cause('gov_spoolup_time')); assert.ok(f.source.startsWith('calculated from the log: ')); assert.match(f.text, /between log 4 and log 5/); }
    assert.match(fl[1].text, /between log 6 and log 7/); assert.match(fl[1].text, /In log 5, the value is 80/);
    assert.ok(res.notes.includes(GP.TEXT.benchNote));
    assert.ok(at(res, 'gov_spoolup_time', 5)[0].bench);
    // other headers: the change is still recovered, with headersEqual false
    const other = GP.recover([runs[0], flight({ log: 4, activeS: 12, spoolup: 80, header: Object.assign({}, HEADER, { govPID: [30, 40, 0, 25, 50] }) })]);
    assert.equal(other.changes.find(c => c.name === 'gov_spoolup_time').headersEqual, false);
});

test('in-flight adjustments inside one PID profile split the values: the yaw weight and the headspeed, reason adjusted', () => {
    const res = GP.recover([flight({ log: 6, activeS: 12, spoolups: [100, 80] })]);
    const ch = res.changes.find(c => c.name === 'gov_spoolup_time');
    assert.deepEqual([ch.from, ch.to, ch.inLog], [100, 80, true]);
    assert.equal(at(res, 'gov_spoolup_time', 6).filter(i => i.kind === 'value').length, 2);
    assert.match(res.flags.find(f => f.name === 'gov_spoolup_time').text, /in log 7/);
    // "Gov Yaw FF" 15 -> 40 at 30 s of ACTIVE (frame time 38.5 s), PID profile 1 for the whole log
    const A = 8.5, yaw = GP.recover([flight({ log: 7, activeS: 60, profileAt: () => 1, wOf: (tau) => tau < 30 ? [70, 20, 15] : [70, 20, 40], events: [{ t: A + 30, name: 'Gov Yaw FF', value: 40 }] })]);
    assert.deepEqual(yaw.epochs.filter(e => e.name === 'gov_yaw_ff_weight').map(e => e.value), [15, 40]);
    assert.deepEqual(yaw.epochs.filter(e => e.name === 'gov_collective_ff_weight').map(e => e.value), [70]);
    const c2 = yaw.changes.find(c => c.name === 'gov_yaw_ff_weight');
    assert.deepEqual([c2.from, c2.to, c2.inLog, c2.reason], [15, 40, true, 'adjusted']);
    assert.ok(yaw.flags.filter(f => f.name === 'gov_yaw_ff_weight').every(f => f.reasons.includes('adjusted') && f.text === GP.TEXT.adjusted('gov_yaw_ff_weight', 7)));
    // "Gov Headspeed" 3500 -> 3000 inside PID profile 1
    const hs = GP.recover([flight({ log: 8, activeS: 30, profileAt: () => 1, Rof: (tau) => tau < 15 ? 3500 : 3000, events: [{ t: A + 15, name: 'Gov Headspeed', value: 3000 }] })]);
    assert.deepEqual(hs.epochs.filter(e => e.name === 'gov_headspeed').map(e => e.value), [3500, 3000]);
    assert.equal(hs.changes.find(c => c.name === 'gov_headspeed').reason, 'adjusted');
    // the yaw weight changes between two logs with a "Gov Yaw FF" adjustment in the second
    const a = flight({ log: 7, activeS: 30 }), b = flight({ log: 8, activeS: 30, w: [70, 20, 40], events: [{ t: 0.2, name: 'Gov Yaw FF', value: 40 }] });
    const c3 = GP.recover([a, b]).changes.find(c => c.name === 'gov_yaw_ff_weight');
    assert.deepEqual([c3.from, c3.to, c3.reason], [15, 40, 'adjusted']);
});

test('a PID profile that is not at the start of the log: the products only, no header gains or weights for it', () => {
    const A0 = 500 + 8000, sw = A0 + 20000;
    // PID profile 1 at the start has no feedforward (gov_f_gain 0 in the header); PID profile 2 has it
    const run = flight({ activeS: 40, header: Object.assign({}, HEADER, { govPID: [30, 40, 0, 0, 50] }), profileAt: (i) => i >= sw ? 2 : 1, Rof: (tau) => tau >= 20 ? 4500 : 3500,
        kkfOf: (tau) => tau >= 20 ? 0.1 : 0 });
    const res = GP.recover([run]);
    for (const [name, w] of [['gov_collective_ff_effective', 0.07], ['gov_cyclic_ff_effective', 0.02], ['gov_yaw_ff_effective', 0.015]])
        assert.ok(Math.abs(value(res, name, 1, 2).estimate / w - 1) < 0.03, `${name} ${value(res, name, 1, 2).estimate}`);
    assert.ok(Math.abs(value(res, 'gov_kp_effective', 1, 2).estimate / 1.5 - 1) < 0.02);
    for (const name of [...GP.WEIGHTS, 'gov_gain', 'gov_p_gain', 'gov_i_gain']) assert.equal(at(res, name, 1, 2).length, 0, name);
    for (const name of GP.WEIGHTS) assert.equal(res.unknown.find(u => u.name === name && u.profile === 2).reason, GP.NOT_SHOWN.weight);
    assert.equal(res.unknown.find(u => u.name === 'gov_gain' && u.profile === 2).reason, GP.NOT_SHOWN.gov_gain);
    assert.equal(value(res, 'gov_gain', 1, 1).value, 50);
});

test('missing header values and missing fields give no exception, and the reasons say how to record them', () => {
    const nulls = GP.recover([flight({ activeS: 20, header: { govPID: [null, null, null, null, null, null] } })]);
    assert.equal(nulls.items.filter(i => i.source === 'log header').length, 0);
    assert.ok(nulls.unknown.some(u => u.name === 'gov_gain')); assert.ok(nulls.items.some(i => i.name === 'gov_yaw_ff_effective'));
    assert.equal(nulls.items.filter(i => GP.WEIGHTS.includes(i.name)).length, 0);
    GP.recover([flight({ activeS: 20, header: {} })]);
    for (const drop of [['hs'], ['govRequest'], ['govTarget'], ['govSum'], ['govStateAt'], ['motor[0]'], ['rcCommand[4]'], ['mixer[0]', 'mixer[1]', 'mixer[2]', 'mixer[3]'], ['govP', 'govI', 'govD', 'govF', 'govSum', 'govTarget', 'govRequest']]) {
        const res = GP.recover([flight({ activeS: 12, drop_: drop })]);
        assert.ok(Array.isArray(res.unknown), drop.join());
    }
    // no governor fields: the names of the identities say to set blackbox_log_governor; the ramps of IDLE stay
    const noGov = GP.recover([flight({ activeS: 12, drop_: ['govP', 'govI', 'govD', 'govF', 'govSum', 'govTarget', 'govRequest'] })]);
    for (const name of ['gov_rpm_filter', 'gov_pwr_filter', 'gov_d_filter', 'gov_use_voltage_comp', 'gov_spoolup_time']) assert.equal(noGov.unknown.find(u => u.name === name).reason, GP.NOT_SHOWN.noGov, name);
    assert.equal(value(noGov, 'gov_startup_time', 1).value, 150);
    assert.deepEqual(GP.recover([]).items, []);
});

test('the governor headspeed gives the PID profile when each logged change to it has that headspeed and no other profile has it', () => {
    const runs = [flight({ log: 1, activeS: 15, profileAt: (i) => i >= 20000 ? 2 : 0 })];
    runs.push(flight({ log: 2, R: 4500, activeS: 15, profileAt: (i) => i >= 9000 ? 2 : 0 }));
    runs.push(flight({ log: 3, activeS: 15, profileAt: (i) => i >= 100 ? 1 : 0 }));
    // in run 1 profile 2 has 3500, in run 2 profile 2 has 4500: profile 2 does not qualify, 3500 is profile 1 only if 2 does not have it
    const map = GP.profileMap(runs);
    assert.deepEqual(map.byHeadspeed, {});
    const m2 = GP.profileMap([runs[1], runs[2]]);
    assert.deepEqual(m2.byHeadspeed, { 3500: 1, 4500: 2 }); assert.match(m2.basis[1], /PID profile 1/);
    const lab = GP.labels(runs[1], m2); assert.equal(lab[0], 2); assert.equal(lab[lab.length - 1], 2);
    const res = GP.recover([runs[1], runs[2]]);
    assert.equal(value(res, 'gov_headspeed', 2, 2).value, 4500); assert.equal(value(res, 'gov_headspeed', 3, 1).value, 3500);
    assert.equal(value(res, 'gov_gain', 3, 1).source, 'log header'); // the header of log 3: its first samples have 3500 rpm, PID profile 1
    // a PID profile that gov_data fills from the arming profile is not a logged change
    const n = 3000, filled = GD.fromColumns({ profileAt: new Uint8Array(n), govRequest: new Float64Array(n).fill(3500), hs: new Float64Array(n).fill(3500), govStateAt: new Uint8Array(n).fill(4) },
        { log: 1, n, rate: 1000, header: {}, armingProfile: 2 }, null);
    assert.equal(filled.profile[0], 2); assert.deepEqual(GP.profileMap([filled]).byHeadspeed, {});
});

test('the CLI comparison: agreement for each epoch and product, bounds against the CLI value, voltage compensation with an ESC voltage source', () => {
    const one = (i) => i >= 100 ? 1 : 0; // a logged change to PID profile 1 (3500 rpm) at the start: CLI section "profile 0"
    const runs = [flight({ log: 3, activeS: 12, profileAt: one }), flight({ log: 4, activeS: 12, spoolup: 80, profileAt: one })];
    const cli = ['set battery_meter = ESC', 'set gov_spoolup_time = 80', 'set gov_startup_time = 150', 'set gov_autorotation_timeout = 15', 'profile 0', 'set gov_use_voltage_comp = ON',
        'set gov_headspeed = 3500', 'set gov_p_limit = 20', 'set gov_gain = 50', 'set gov_p_gain = 30', 'set gov_i_gain = 40', 'set gov_f_gain = 20', 'set gov_yaw_ff_weight = 15'].join('\n');
    const res = GP.recover(runs, { cli });
    const row = (name, logs) => res.cli.find(c => c.name === name && (!logs || String(c.logs) === String(logs)));
    assert.equal(row('gov_spoolup_time', [3]).agree, false); assert.equal(row('gov_spoolup_time', [4]).agree, true);
    assert.equal(row('gov_startup_time').agree, true);
    assert.equal(row('gov_autorotation_timeout').bound, true); assert.equal(row('gov_autorotation_timeout').agree, true);
    // ON in the CLI, but the ESC voltage source makes it inactive (flight_governor.c:1556): agree
    assert.equal(row('gov_use_voltage_comp').agree, true);
    assert.equal(row('gov_headspeed').agree, true); assert.equal(row('gov_headspeed').profile, 1);
    for (const [name, v] of [['gov_kp_effective', 1.5], ['gov_ki_effective', 2], ['gov_yaw_ff_effective', 0.015]]) { assert.equal(row(name).cli, v, name); assert.equal(row(name).agree, true, name); }
    // without a PID profile (no logged change, no headspeed rule) a profile value has no CLI section
    assert.equal(GP.recover([flight({ log: 3, activeS: 12 })], { cli }).cli.some(c => c.name === 'gov_headspeed'), false);
});

// ---- the real extracted logs (analysis/governor-20261014/data) ---------------------------------------------------------

const DATA = path.resolve(__dirname, '../analysis/governor-20261014/data');
const hasFireball = fs.existsSync(path.join(DATA, 'fireball', 'meta.json')), hasGaui = fs.existsSync(path.join(DATA, 'gaui', 'meta.json'));
let fireball = null; const fireballRes = () => fireball || (fireball = GP.recover(GD.load(path.join(DATA, 'fireball'), { bench: true })));
const LATER = [10, 11, 13, 14, 15]; // the logs that match the CLI dump of 2026-10-13
const near = (a, b, rel) => Math.abs(a / b - 1) <= rel;

test('Fireball: logs 10-15 give the configured values, logs 5-9 the epochs of critique V4', { skip: !hasFireball && 'no analysis/governor-20261014/data/fireball' }, () => {
    const res = fireballRes();
    const want = { gov_spoolup_time: 80, gov_recovery_time: 20, gov_spooldown_time: 80, gov_startup_time: 100, gov_rpm_filter: 10, gov_ff_filter: 5, gov_tracking_time: 50,
        gov_handover_throttle: 25, gov_auto_throttle: 0, gov_idle_throttle: 0, gov_throttle_type: 'FUNCTION', gov_mode: 'ELECTRIC' };
    for (const [name, v] of Object.entries(want)) {
        const eps = res.epochs.filter(e => e.name === name && e.logs.some(l => LATER.includes(l)));
        assert.ok(eps.length, name); for (const e of eps) assert.equal(e.value, v, `${name} logs ${e.logs}`);
    }
    // the products K Kp = 0.55 x 1.8, K Ki = 0.55 x 6, K Kf w = 0.55 x 0.32 x w for each PID profile; the weights only where the
    // PID profile is at the start of a log (profile 1: logs 5, 10; profile 2: log 11)
    for (const [p, coll] of [[1, 100], [2, 150], [3, 100]]) {
        for (const [name, v] of [['gov_collective_curve', 20], ['gov_headspeed', [3500, 4500, 5000][p - 1]]]) {
            const eps = res.epochs.filter(e => e.name === name && e.profile === p && e.logs.some(l => LATER.includes(l)));
            assert.ok(eps.length, `${name} profile ${p}`); for (const e of eps) assert.equal(e.value, v, `${name} profile ${p} logs ${e.logs}`);
        }
        for (const [name, v, rel] of [['gov_kp_effective', 0.99, 0.01], ['gov_ki_effective', 3.3, 0.015], ['gov_collective_ff_effective', 0.176 * coll / 100, 0.01],
            ['gov_cyclic_ff_effective', 0.176 * 0.35, 0.01], ['gov_yaw_ff_effective', 0.176 * 0.05, 0.03]]) {
            const eps = res.epochs.filter(e => e.name === name && e.profile === p); assert.ok(eps.length, `${name} profile ${p}`);
            for (const e of eps) assert.ok(near(e.estimate, v, rel), `${name} profile ${p}: ${e.estimate}`);
        }
    }
    for (const [p, coll, logs] of [[1, 100, [5, 10]], [2, 150, [11]]]) for (const [name, v] of [['gov_collective_ff_weight', coll], ['gov_cyclic_ff_weight', 35], ['gov_yaw_ff_weight', 5]])
        assert.deepEqual(res.epochs.filter(e => e.name === name && e.profile === p).map(e => [e.value, e.logs]), [[v, logs]], `${name} profile ${p}`);
    assert.equal(res.items.filter(i => GP.WEIGHTS.includes(i.name) && i.profile === 3).length, 0);
    for (const name of ['gov_fallback_drop', 'gov_use_fallback_precomp']) assert.deepEqual([11, 14].map(l => res.epochs.find(e => e.name === name && e.profile === 2 && e.logs.includes(l)).value), name === 'gov_fallback_drop' ? [10, 10] : ['OFF', 'OFF']);
    assert.equal(res.epochs.find(e => e.name === 'gov_max_throttle' && e.profile === 2 && e.logs.includes(11)).value, 100);
    assert.equal(res.epochs.find(e => e.name === 'gov_use_voltage_comp' && e.profile === 2 && e.logs.includes(11)).value, 'inactive');
    assert.deepEqual(res.epochs.filter(e => e.name === 'gov_use_pid_spoolup').map(e => e.value), ['OFF', 'OFF']); // open loop above the handover of 25 %
    // V4: the timing changed with the same governor header values; only logs 10-15 match the CLI dump
    const v4 = { gov_startup_time: [[200, [5, 6, 8]], [100, [9, 10, 11, 13, 14, 15]]], gov_spoolup_time: [[100, [5, 6, 8]], [80, [9, 10, 11, 13, 14, 15]]],
        gov_spooldown_time: [[100, [5]], [75, [6, 8]], [50, [9]], [80, [10, 11, 15]]] };
    for (const [name, list] of Object.entries(v4)) assert.deepEqual(res.epochs.filter(e => e.name === name).map(e => [e.value, e.logs]), list, name);
    for (const c of res.changes.filter(c => c.name in v4)) { assert.equal(c.reason, 'recovered'); assert.equal(c.headersEqual, true); }
    // the flags of the epochs with a flight log (6, 8 and 9 are bench runs): startup 2, spool-up 2, spool-down 2 (logs 5 and 10-15)
    assert.deepEqual(res.flags.filter(f => f.name in v4).map(f => `${f.name} ${f.logs}`).sort(), ['gov_spooldown_time 10,11,15', 'gov_spooldown_time 5', 'gov_spoolup_time 10,11,13,14,15',
        'gov_spoolup_time 5', 'gov_startup_time 10,11,13,14,15', 'gov_startup_time 5']);
    // no other change in these logs: the term limits, the products and the rest stay the same
    assert.deepEqual([...new Set(res.changes.map(c => c.name))].sort(), Object.keys(v4).sort());
});

test('Fireball against the CLI dump of 2026-10-13 (GOV_CLI)', { skip: !(hasFireball && process.env.GOV_CLI && fs.existsSync(process.env.GOV_CLI)) && 'set GOV_CLI to the Fireball CLI dump of 2026-10-13' }, () => {
    const res = fireballRes(), cmp = GP.compareCli(res, fs.readFileSync(process.env.GOV_CLI, 'utf8'));
    assert.deepEqual(cmp.filter(c => !c.agree && c.logs.some(l => LATER.includes(l))), []);
    assert.deepEqual(cmp.filter(c => !c.agree).map(c => c.name).sort(), ['gov_spooldown_time', 'gov_spooldown_time', 'gov_spooldown_time', 'gov_spoolup_time', 'gov_startup_time']);
    for (const name of ['gov_kp_effective', 'gov_ki_effective', 'gov_yaw_ff_effective']) assert.equal(cmp.filter(c => c.name === name && c.agree).length, 3, name); // each PID profile
    assert.ok(cmp.length >= 150, `${cmp.length} rows`);
});

test('Gaui X4 II: the yaw feedforward of each log and PID profile (critique C1), the spool-up change at log 46', { skip: !hasGaui && 'no analysis/governor-20261014/data/gaui' }, () => {
    const res = GP.recover(GD.load(path.join(DATA, 'gaui'), { bench: true }));
    // PID profile 1 is at the start of every log except 45: weights; profiles 2 and 3: K Kf w only (0.4 x 0.1 x w with the header gains)
    const yaw = (p) => res.epochs.filter(e => e.name === 'gov_yaw_ff_weight' && e.profile === p).map(e => [e.value, e.logs]);
    assert.deepEqual(yaw(1), [[10, [38]], [30, [39]], [40, [40, 41, 43]], [60, [46]], [80, [47, 48, 49]]]);
    const yawW = (p) => res.epochs.filter(e => e.name === 'gov_yaw_ff_effective' && e.profile === p).map(e => [Math.round(e.estimate / 0.0004), e.logs]);
    assert.deepEqual(yawW(1), [[10, [38]], [30, [39]], [40, [40, 41, 43, 45]], [60, [46]], [80, [47, 48, 49]]]);
    assert.deepEqual(yawW(2), [[10, [38, 40, 46]], [80, [48, 49]]]);
    assert.deepEqual(yawW(3), [[10, [38]], [80, [48, 49]]]);
    for (const p of [1, 2, 3]) {
        assert.deepEqual(res.epochs.filter(e => e.name === 'gov_collective_curve' && e.profile === p).map(e => e.value), [20], `curve profile ${p}`);
        for (const [name, v] of [['gov_collective_ff_effective', 0.02], ['gov_cyclic_ff_effective', 0.004]])
            assert.ok(res.epochs.filter(e => e.name === name && e.profile === p).every(e => near(e.estimate, v, 0.01)), `${name} profile ${p}`);
    }
    for (const [name, v] of [['gov_collective_ff_weight', 50], ['gov_cyclic_ff_weight', 10]]) assert.deepEqual(res.epochs.filter(e => e.name === name).map(e => [e.profile, e.value]), [[1, v]], name);
    assert.deepEqual(res.epochs.filter(e => e.name === 'gov_spoolup_time').map(e => [e.value, e.logs]), [[200, [38, 39, 40, 41, 43, 45]], [150, [46, 47, 48, 49]]]);
    for (const [name, v] of [['gov_startup_time', 250], ['gov_spooldown_time', 30], ['gov_rpm_filter', 10], ['gov_ff_filter', 5], ['gov_throttle_hold_timeout', 50]])
        assert.deepEqual(res.epochs.filter(e => e.name === name).map(e => e.value), [v], name);
    // no RECOVERY or BAILOUT step and no DIRECT: the mode is ELECTRIC or NITRO (the battery current shows the motor, not the mode)
    assert.deepEqual(res.items.find(i => i.name === 'gov_mode').candidates, ['ELECTRIC', 'NITRO']);
    // the handover is never reached: a lower bound from the IDLE ramp (critique C5); so PID spool-up OFF is not proven
    assert.ok(at(res, 'gov_handover_throttle').every(i => i.kind === 'lower' && i.lo >= 14));
    assert.ok(res.items.filter(i => i.name === 'gov_use_pid_spoolup').every(i => i.kind === 'candidates'));
    assert.ok(res.items.every(i => i.name !== 'gov_max_throttle' || i.kind === 'lower')); // no false pile (critique C8)
    for (const e of res.epochs.filter(e => e.name === 'gov_kp_effective')) assert.ok(Math.abs(e.estimate - 1.6) < 0.01, `K Kp ${e.estimate}`); // 40 / 100 x 40 / 10
});
