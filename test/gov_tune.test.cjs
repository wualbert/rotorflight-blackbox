'use strict';

// Tests of tools/autotune/gov_tune.cjs: the registry of the 42 governor CLI names, the CLI values, the values at this time and their
// flags, the rule rows (state census, BAILOUT, spool-up, voltage compensation and drift, cell count, tail torque assist, FALLBACK and
// the RPM signal, unlogged changes, floor, term limits, throttle at its maximum, headroom, values that the log does not record), the
// 'pending-model' rows of the model families and their extension point, the recommendations for advice.exportScript, and the STE
// lint of every text (lintText of test/ste_text.test.cjs).
//
//   node --test test/gov_tune.test.cjs
//   With analysis/governor-20261014/data (the extracted Fireball and Gaui logs, not in git), also the real-data checks, with the rows
//   table in the test output. GOV_CLI=<RTFL_cli_SAB_Fireball_20261013_184504.txt> adds that CLI dump to the Fireball run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const GD = require(path.join(ROOT, 'tools/autotune/gov_data.cjs'));
const GP = require(path.join(ROOT, 'tools/autotune/gov_params.cjs'));
const GT = require(path.join(ROOT, 'tools/autotune/gov_tune.cjs'));
const ADV = require(path.join(ROOT, 'tools/autotune/advice.cjs'));
const SCHEMA = require(path.join(ROOT, 'tools/autotune/firmware/schema.cjs'));

// ---------------------------------------------------------------------------------------------
// a synthetic run set: two flight logs (PID profiles 1 and 2, FUNCTION throttle, a FALLBACK at full throttle, a BAILOUT from a
// slow rotor on the ground, a battery from 25 V to 22 V with voltage compensation inactive) and one bench run with a FALLBACK
// ---------------------------------------------------------------------------------------------

const RATE = 1000;
const HEADER = { govPID: [40, 50, 0, 10, 40], yaw_tta: [0, 20], features: (1 << 26) | (1 << 27) | (1 << 28), vbatcellvoltage: [330, 350, 430], looptime: 500, pid_process_denom: 2 };
const FIELDS = ['time', 'hs', 'motor[0]', 'rcCommand[4]', 'mixer[0]', 'mixer[1]', 'mixer[2]', 'mixer[3]', 'Vbat', 'Ibat', 'govP', 'govI', 'govD', 'govF', 'govSum', 'govTarget', 'govRequest',
    'govStateAt', 'profileAt', 'airborneAt', 'rescueAt', 'flightModeFlags'];
// at(t) -> { state, stick, phase, u, hs, coll, fb (FALLBACK: the throttle is 0.9 x the frozen govI) }; the other columns follow.
// R: the headspeed target (rpm, or a function of t). o: { rate (Hz), omit: [fields that the log does not record], zero: [fields at 0], profileAt(t) }
function synthRun(log, T, R0, profile, cls, at, o = {}) {
    const rate = o.rate || RATE, n = Math.round(T * rate), C = {}; for (const k of FIELDS) C[k] = new Float32Array(n);
    const code = new Uint8Array(n), last = { I: 0, F: 0, P: 0, S: 0 }; let lastI = 0;
    for (let i = 0; i < n; i++) {
        const t = i / rate, s = at(t), V = t < 9 ? 25.2 : 25 - 3 * Math.min(1, (t - 9) / 40), coll = s.coll || 0, R = typeof R0 === 'function' ? R0(t) : R0;
        // the governor terms: ACTIVE P + I + F = the throttle (voltage compensation inactive); FALLBACK I frozen, F 0; the other states keep
        // the last values (flight_governor.c: govSum stale outside ACTIVE, the PID spool-up and FALLBACK)
        let u = s.u, I = last.I, F = last.F, P = last.P, S = last.S;
        if (s.state === 6) { I = lastI; u = 0.9 * I; S = I; F = 0; P = 0; }
        else if (s.state === 4) { F = 0.1 * coll * coll; P = 1.6 * (R - s.hs) / R; I = u - P - F; S = u; lastI = I; }
        Object.assign(last, { I, F, P, S });
        C.time[i] = t; C.hs[i] = s.hs; C['motor[0]'][i] = Math.round(1000 * u); C['rcCommand[4]'][i] = Math.round(1000 * s.stick);
        C['mixer[0]'][i] = 40; C['mixer[1]'][i] = 30; C['mixer[2]'][i] = 100; C['mixer[3]'][i] = Math.round(1000 * coll);
        C.Vbat[i] = Math.round(100 * V); C.Ibat[i] = 0;
        C.govP[i] = Math.trunc(1000 * P); C.govI[i] = Math.trunc(1000 * I); C.govF[i] = Math.trunc(1000 * F); C.govSum[i] = Math.trunc(1000 * S); C.govD[i] = 0;
        C.govTarget[i] = s.state === 4 ? R : Math.round(s.hs); C.govRequest[i] = R; C.govStateAt[i] = s.state; C.profileAt[i] = o.profileAt ? o.profileAt(t) : profile;
        C.airborneAt[i] = s.phase === 3 ? 1 : 0; C.rescueAt[i] = 0; C.flightModeFlags[i] = 1; code[i] = s.phase;
    }
    for (const k of o.omit || []) delete C[k];
    for (const k of o.zero || []) C[k].fill(0);
    return GD.fromColumns(C, { log, segment: 0, n, rate, actualRate: rate, fromS: 0, timeStartUs: 0, header: HEADER, name: `log${log}_0` },
        { class: cls, flights: cls === 'flight' ? [{ i0: 0, i1: n, t0: 0, t1: T }] : [], code });
}
// log 0: PID profile 1 at 2000 rpm; a spool-up with an overshoot of 6 %, the throttle at 100 % at 25 s, a FALLBACK at 30.3 s, AUTOROTATION
// with the switch at the middle position
function runA() {
    const R = 2000;
    return synthRun(0, 56, R, 1, 'flight', (t) => {
        if (t < 2) return { state: 0, stick: 0, phase: 0, u: 0, hs: 0 };
        if (t < 4) return { state: 1, stick: 1, phase: 0, u: 0.1 * (t - 2), hs: 250 * (t - 2) };            // gov_startup_time 100
        if (t < 9) return { state: 2, stick: 1, phase: 1, u: 0.2 + 0.1 * (t - 4), hs: 500 + 300 * (t - 4) }; // gov_spoolup_time 100
        if (t < 49) {
            const V = 25 - 3 * (t - 9) / 40, phase = t < 11 ? 2 : 3;
            if (t >= 30 && t < 30.3) return { state: 4, stick: 1, phase, u: 1, hs: R * 0.93, coll: 0.9 };
            if (t >= 30.3 && t < 30.5) return { state: 6, stick: 1, phase, hs: t < 30.305 ? R * 0.93 + 1500 : R * (0.93 - 0.5 * (t - 30.3)), coll: 0.9 };
            if (t >= 30.5 && t < 31) return { state: 3, stick: 1, phase, u: 0.55 + 0.5 * (t - 30.5), hs: R * (0.83 + 0.3 * (t - 30.5)), coll: 0.5 };
            const coll = t >= 25 && t < 25.5 ? 0.95 : 0.15 + 0.1 * Math.sin(2 * Math.PI * t / 7), dv = 14 + 8 * coll * coll, u = Math.min(1, dv / V);
            const hs = t < 10 ? R * (1 + 0.06 * Math.sin(Math.PI * (t - 9))) : u >= 1 ? R * 0.95 : R + 5 * Math.sin(2 * Math.PI * t * 3);
            return { state: 4, stick: 1, phase, u, hs, coll };
        }
        if (t < 52) { const u0 = 14.2 / 22; return { state: 7, stick: 0.509, phase: 4, u: Math.max(0, u0 - (t - 49) / 3), hs: R * Math.max(0.2, 1 - 0.3 * (t - 49)) }; } // gov_spooldown_time 30
        return { state: 0, stick: 0, phase: 4, u: 0, hs: Math.max(0, 400 - 200 * (t - 52)) };
    });
}
// log 1: PID profile 2 at 2200 rpm; gov_spoolup_time 80 (a change that the log does not record), AUTOROTATION on the ground to 300 rpm,
// then BAILOUT from the slow rotor with the throttle at 100 % in ACTIVE
function runB() {
    const R = 2200;
    return synthRun(1, 60, R, 2, 'flight', (t) => {
        if (t < 2) return { state: 0, stick: 0, phase: 0, u: 0, hs: 0 };
        if (t < 4) return { state: 1, stick: 1, phase: 0, u: 0.1 * (t - 2), hs: 250 * (t - 2) };
        if (t < 8.4) return { state: 2, stick: 1, phase: 1, u: 0.2 + 0.125 * (t - 4), hs: 500 + 386 * (t - 4) };
        if (t < 35) { const V = 25 - 3 * Math.max(0, t - 9) / 40, coll = 0.15 + 0.1 * Math.sin(2 * Math.PI * t / 7), u = (15 + 8 * coll * coll) / V;
            return { state: 4, stick: 1, phase: t < 11.5 ? 2 : t < 30 ? 3 : 2, u, hs: R + 4 * Math.sin(2 * Math.PI * t * 2), coll }; }
        if (t < 40) return { state: 7, stick: 0.509, phase: 2, u: Math.max(0, 0.65 - (t - 35) / 3), hs: Math.max(300, R - 380 * (t - 35)) };
        if (t < 40.3) return { state: 7, stick: 1, phase: 2, u: 0.5 * (t - 40), hs: 300 };
        if (t < 41.7) return { state: 8, stick: 1, phase: 2, u: 0.25 + 0.5 * (t - 40.3), hs: 300 + 300 * (t - 40.3) };
        if (t < 50) { const hs = t < 43.97 ? 720 + 650 * (t - 41.7) : R * (1 + 0.1 * Math.exp(-(t - 44.5) * (t - 44.5))); return { state: 4, stick: 1, phase: 2, u: hs < 0.97 * R ? 1 : 0.62, hs }; }
        if (t < 53) return { state: 7, stick: 0.509, phase: 4, u: Math.max(0, 0.62 - (t - 50) / 3), hs: R * Math.max(0.3, 1 - 0.3 * (t - 50)) };
        return { state: 0, stick: 0, phase: 4, u: 0, hs: 0 };
    });
}
// log 2: a bench run with a FALLBACK (configuration evidence for gov_params only: no row may use it), gov_spoolup_time 80 as log 2
function runC() {
    const R = 2000;
    return synthRun(2, 20, R, 1, 'bench', (t) => {
        if (t < 2) return { state: 0, stick: 0, phase: 0, u: 0, hs: 0 };
        if (t < 4) return { state: 1, stick: 1, phase: 0, u: 0.1 * (t - 2), hs: 250 * (t - 2) };
        if (t < 9) return { state: 2, stick: 1, phase: 1, u: Math.min(0.75, 0.2 + 0.125 * (t - 4)), hs: Math.min(R, 500 + 340 * (t - 4)) };
        if (t >= 12 && t < 12.2) return { state: 6, stick: 1, phase: 2, hs: R };
        if (t >= 12.2 && t < 12.6) return { state: 3, stick: 1, phase: 2, u: 0.5, hs: R };
        return { state: 4, stick: 1, phase: 2, u: 0.5, hs: R };
    });
}
let SYN = null;
const syn = () => SYN || (SYN = [runA(), runB(), runC()]);
const CLI_ESC = ['# dump all', 'set battery_meter = ESC', 'set tail_rotor_mode = VARIABLE', 'set gov_mode = ELECTRIC', 'profile 0', 'set gov_headspeed = 2000', 'set gov_max_throttle = 100',
    'profile 1', 'set gov_headspeed = 2200', 'set gov_max_throttle = 100'].join('\n');
const memo = new Map();
const tuneOf = (key, runs, o) => { if (!memo.has(key)) memo.set(key, GT.tune(runs, o)); return memo.get(key); };
const rowsOf = (res, name, o = {}) => res.rows.filter(r => r.name === name && (o.topic === undefined || (o.topic instanceof RegExp ? o.topic.test(r.topic) : r.topic === o.topic)) && (o.profile === undefined || r.profile === o.profile));

// ---------------------------------------------------------------------------------------------
// registry and CLI values
// ---------------------------------------------------------------------------------------------

test('the registry has the 42 CLI names of gov_params with scope, firmware range, default, schema field and family', () => {
    assert.equal(GT.REGISTRY.length, 42);
    assert.deepEqual(GT.REGISTRY.map(R => R.name), GP.NAMES);
    assert.equal(GT.REGISTRY.filter(R => R.scope === 'global').length, 18);
    assert.equal(GT.REGISTRY.filter(R => R.scope === 'profile').length, 24);
    const field = Object.fromEntries(SCHEMA.fields.map(f => [f.name, f]));
    for (const R of GT.REGISTRY) {
        assert.ok(GT.FAMILIES[R.family], `${R.name}: family ${R.family}`);
        assert.ok(R.range[0] <= R.range[1], R.name);
        if (R.type === 'flag') { assert.equal(R.field, 'gov_flags'); assert.ok([2, 3, 4, 6].includes(R.bit), R.name); assert.ok(field.gov_flags, 'schema gov_flags'); continue; }
        if (R.type === 'list') { assert.equal(R.name, 'gov_bypass_throttle'); for (let i = 0; i < 9; i++) assert.deepEqual([field[`gov_bypass_throttle[${i}]`].min, field[`gov_bypass_throttle[${i}]`].max], R.range); continue; }
        const f = field[R.field]; assert.ok(f, `${R.name}: schema field ${R.field}`);
        if (R.type === 'int') { assert.deepEqual([f.min, f.max], R.range, `${R.name}: range against firmware/schema.cjs`); assert.equal(f.default, R.default, `${R.name}: default`); }
    }
    assert.equal(GT.REG.gov_collective_ff_weight.field, 'gov_collective_weight');
    assert.deepEqual(GT.RELATED.map(R => R.name), ['battery_meter', 'battery_cell_count', 'feature GOVERNOR', 'freq_input_pull', 'freq_input_edge', 'freq_input_minhz', 'blackbox_log_esc', 'blackbox_log_battery', 'debug_mode']);
    for (const [k, R] of Object.entries(GT.RULES)) if (R && typeof R === 'object') assert.ok(R.id && R.text && R.source, `RULES.${k}: id, text and source`);
});

test('cliValue: ON and OFF, enum names, the 9 values of gov_bypass_throttle and the firmware range', () => {
    assert.equal(GT.cliValue('gov_use_fallback_precomp', true), 'ON');
    assert.equal(GT.cliValue('gov_use_fallback_precomp', 'off'), 'OFF');
    assert.equal(GT.cliValue('gov_use_fallback_precomp', 2), null);
    assert.equal(GT.cliValue('gov_mode', 3), 'ELECTRIC');
    assert.equal(GT.cliValue('gov_throttle_type', 'function'), 'FUNCTION');
    assert.equal(GT.cliValue('gov_mode', 'STANDARD'), null);
    assert.equal(GT.cliValue('gov_bypass_throttle', [0, 20, 40, 60, 80, 100, 120, 140, 160]), '0,20,40,60,80,100,120,140,160');
    assert.equal(GT.cliValue('gov_bypass_throttle', [0, 0, 0]), null);
    assert.equal(GT.cliValue('gov_bypass_throttle', [0, 0, 0, 0, 0, 0, 0, 0, 201]), null);
    assert.equal(GT.cliValue('gov_collective_curve', 4), null);
    assert.equal(GT.cliValue('gov_collective_curve', 40), '40');
    assert.equal(GT.cliValue('gov_headspeed', 50000), '50000');
    assert.equal(GT.cliValue('gov_fallback_drop', 51), null);
    assert.equal(GT.cliValue('gov_spoolup_time', 12.5), null);
    assert.equal(GT.cliValue('battery_meter', 'ESC'), null, 'a related name is not a governor parameter');
});

// ---------------------------------------------------------------------------------------------
// synthetic flights
// ---------------------------------------------------------------------------------------------

test('coverage: each of the 42 names has a row, a profile name a row for each PID profile of the flight logs', () => {
    const res = tuneOf('esc', syn(), { cli: CLI_ESC });
    assert.equal(res.status, 'ok');
    assert.deepEqual(res.profiles, [1, 2]);
    assert.deepEqual(res.coverage.missing, []);
    assert.equal(res.coverage.covered, 42);
    assert.equal(res.coverage.related, 9);
    for (const R of GT.REGISTRY) for (const p of R.scope === 'global' ? [null] : [1, 2]) assert.ok(res.rows.some(r => r.name === R.name && r.profile === p), `${R.name} ${p}`);
    const ids = res.rows.map(r => r.id); assert.equal(new Set(ids).size, ids.length, 'row ids are unique');
    for (const r of res.rows) {
        assert.ok(GT.STATUS_ORDER.includes(r.status), `${r.id}: status ${r.status}`);
        assert.ok(GT.RULES[r.rule], `${r.id}: rule ${r.rule}`);
        assert.ok(r.text, `${r.id}: text`);
        assert.ok(r.current && typeof r.current.source === 'string', `${r.id}: current source`);
        for (const e of r.evidence) assert.ok(typeof e.text === 'string' && e.text.length, `${r.id}: evidence text`);
    }
    // one entry for each name and PID profile, with the most important status of its rows
    assert.equal(res.parameters.length, 18 + 24 * 2 + 9);
    const sat = res.parameters.find(q => q.name === 'gov_max_throttle' && q.profile === 1); assert.equal(sat.status, 'check', 'the throttle at its maximum is never satisfactory');
});

test('the values at this time: the log header for the PID profile at the start of the log, the analysis, the CLI dump, else unknown', () => {
    const res = tuneOf('esc', syn(), { cli: CLI_ESC }), cur = res.current.byName;
    assert.equal(cur.gov_p_gain[1].value, 40); assert.match(cur.gov_p_gain[1].source, /log header/);
    assert.equal(cur.gov_mode[0].value, 'ELECTRIC'); assert.equal(cur.gov_mode[0].cli, 'same');
    assert.equal(cur.gov_headspeed[2].value, 2200);
    assert.equal(cur.gov_max_throttle[1].value, 100); assert.match(cur.gov_max_throttle[1].source, /CLI dump|calculated from the log/);
    assert.equal(cur.gov_startup_time[0].value, 100); assert.match(cur.gov_startup_time[0].source, /^calculated from the log: /);
    assert.equal(cur.gov_spooldown_time[0].value, 30);
    assert.equal(res.current.related.battery_meter.value, 'ESC');
    assert.equal(cur.gov_pwr_filter[0].value, null); assert.equal(cur.gov_pwr_filter[0].source, 'unknown'); assert.ok(cur.gov_pwr_filter[0].reason);
    // gov_spoolup_time changes between the two flight logs (100 -> 80) without a record: a flag on the value and a check row
    const sp = cur.gov_spoolup_time[0];
    assert.equal(sp.value, 80); assert.ok(sp.stale && sp.stale.reasons.includes('unlogged'), 'stale flag');
    assert.match(sp.stale.text, /possibly not the same in all logs/); assert.match(sp.stale.text, /The source of the value is "calculated from the log/);
    const u = rowsOf(res, 'gov_spoolup_time', { topic: 'unlogged' }); assert.equal(u.length, 1); assert.equal(u[0].status, 'check'); assert.match(u[0].text, /100 in log 1 and 80 in log 2/);
});

test('FUNCTION throttle: the middle switch position is AUTOROTATION, and a BAILOUT from a slow rotor is a check', () => {
    const res = tuneOf('esc', syn(), { cli: CLI_ESC }), C = res.measures.census;
    assert.equal(res.current.byName.gov_throttle_type[0].value, 'FUNCTION');
    assert.ok(C.autorotations.filter(a => a.from === 'ACTIVE' && a.pos === 'middle').length >= 2);
    const a = rowsOf(res, 'gov_autorotation_timeout', { topic: 'value' })[0];
    assert.match(a.text, /the middle switch position gives AUTOROTATION/);
    assert.match(a.text, /In \d+ of \d+ times, the switch goes from the top position to the middle position in ACTIVE/);
    // gov_auto_throttle: the middle position; gov_idle_throttle: the low position and the lower limit of IDLE, HOLD, SPOOLUP, RECOVERY, BAILOUT, BYPASS
    assert.match(rowsOf(res, 'gov_auto_throttle')[0].text, /does not stop AUTOROTATION/);
    assert.match(rowsOf(res, 'gov_idle_throttle')[0].text, /low switch position sets the throttle to this value/);
    assert.match(rowsOf(res, 'gov_idle_throttle')[0].text, /lower limit in IDLE, HOLD, SPOOLUP, RECOVERY, BAILOUT and BYPASS/);
    assert.doesNotMatch(rowsOf(res, 'gov_idle_throttle')[0].text, /AUTOROTATION\./);
    const other = GT.tune(syn(), { cli: CLI_ESC.replace('set gov_mode = ELECTRIC', 'set gov_mode = ELECTRIC\nset gov_throttle_type = NORMAL') });
    if (other.current.byName.gov_throttle_type[0].value === 'NORMAL') assert.match(rowsOf(other, 'gov_auto_throttle')[0].text, /only if "gov_autorotation_timeout" is more than 0 and the throttle is at this value or more/);
    const b = rowsOf(res, 'gov_autorotation_timeout', { topic: /^bailout:/ });
    assert.equal(b.length, 1); assert.equal(b[0].status, 'check');
    const ev = res.measures.bailouts[0]; assert.ok(ev.low && ev.share < 0.2, `share ${ev.share}`); assert.ok(ev.satS > 1, `satS ${ev.satS}`); assert.ok(ev.overshoot > 0.05);
    assert.match(b[0].text, /set the throttle switch to the low position/);
    // the throttle at 100 % after the BAILOUT is an ESC acceleration period, not a power limit (critique C9)
    const per = res.measures.periods.filter(p => p.log === 1 && p.profile === 2); assert.ok(per.some(p => p.cause === 'acceleration'));
    assert.match(rowsOf(res, 'gov_max_throttle', { topic: 'value', profile: 2 })[0].text, /ESC acceleration causes/);
});

test('spool-up: the overshoot of the spool-ups at the value of this time, against the limit of 2 %', () => {
    const res = tuneOf('esc', syn(), { cli: CLI_ESC }), r = rowsOf(res, 'gov_spoolup_time', { topic: 'value' })[0];
    // the value at this time (80) comes from log 2 only: its spool-up has no overshoot. Log 1 (100) has 6 % and shows as evidence
    assert.equal(r.status, 'keep');
    assert.ok(r.evidence.some(e => /with "gov_spoolup_time" 100 in that log/.test(e.text) && e.value > 0.05), 'the other epoch is evidence');
    const res2 = GT.tune([runA()], {}), r2 = rowsOf(res2, 'gov_spoolup_time', { topic: 'value' })[0];
    assert.equal(r2.status, 'check'); assert.match(r2.text, /more than the target by 6 %/);
});

test('voltage compensation: no effect with the ESC voltage source, the measured throttle drift, and a conditional text without a CLI dump', () => {
    const res = tuneOf('esc', syn(), { cli: CLI_ESC });
    for (const p of [1, 2]) { const r = rowsOf(res, 'gov_use_voltage_comp', { profile: p })[0]; assert.equal(r.status, 'not-applicable'); assert.match(r.reason, /voltage source is ESC/); }
    assert.equal(rowsOf(res, 'gov_pwr_filter', { topic: 'value' })[0].status, 'not-applicable');
    const m = rowsOf(res, 'battery_meter')[0]; assert.equal(m.inform, true);
    const d = res.measures.drift.find(x => x.log === 0 && x.profile === 1);
    assert.ok(d, 'drift of log 1'); assert.ok(d.points > 3 && d.points < 8, `drift ${d.points} points`); assert.ok(Math.abs(d.points - d.oneOverV) < 1.5, `1/V check ${d.oneOverV}`);
    assert.match(m.text, /the throttle increases by [\d.]+ ± [\d.]+ points for each 1 V decrease of the battery voltage \(\d+ logs?\)/);
    assert.match(m.text, /For the median voltage decrease in a flight \([\d.]+ V\), this is [\d.]+/);
    // the evidence also gives the loop gain and the F-term at the end of the flight (GOVERNOR_AUTOTUNE.md 5, critique C10)
    assert.ok(m.evidence.some(e => /loop gain of the governor decreases by/.test(e.text) && e.value > 0.05 && e.value < 0.2), 'loop gain');
    assert.ok(m.evidence.some(e => /F-term is less than necessary/.test(e.text)), 'F-term');
    const rec = res.recommendations.find(x => x.parameter === 'battery_meter'); assert.equal(rec.severity, 'info'); assert.deepEqual(rec.cli, []);
    // without a CLI dump: the source is unknown and the log shows that compensation is not active (critique M10)
    const res2 = tuneOf('nocli', syn(), {}), m2 = rowsOf(res2, 'battery_meter')[0];
    assert.equal(m2.status, 'check'); assert.match(m2.text, /If the voltage source \("battery_meter"\) is ADC/); assert.match(m2.record, /"blackbox_log_esc" to ON/);
    assert.equal(res2.recommendations.find(x => x.parameter === 'battery_meter').procedure.title, m2.record);
    // with the ADC source, the model family compares the flights with and without compensation (pending-model rows). The logs show
    // that compensation does not operate (the motor output is "govSum"): the power filter has no effect in these logs
    const res3 = GT.tune(syn(), { cli: '# dump all\nset battery_meter = ADC\nprofile 0\nset gov_use_voltage_comp = ON\nprofile 1\nset gov_use_voltage_comp = ON' });
    const vm3 = rowsOf(res3, 'gov_use_voltage_comp', { topic: 'model' }); assert.equal(vm3.length, 2); assert.ok(vm3.every(r => r.status === 'pending-model'));
    assert.equal(rowsOf(res3, 'gov_pwr_filter', { topic: 'model' }).length, 1);
    assert.equal(rowsOf(res3, 'gov_pwr_filter', { topic: 'value' })[0].status, 'not-applicable');
    assert.match(rowsOf(res3, 'battery_meter')[0].text, /voltage source is ADC/);
});

test('battery_cell_count: 0 is the firmware rule on the battery voltage before the motor starts', () => {
    const res = GT.tune(syn(), { cli: '# dump all\nset battery_cell_count = 0' }), r = rowsOf(res, 'battery_cell_count')[0];
    assert.equal(r.cells, 6); assert.match(r.text, /The value 0 of "battery_cell_count" tells the firmware to find the cell count/);
    const r2 = rowsOf(tuneOf('nocli', syn(), {}), 'battery_cell_count')[0]; assert.equal(r2.cells, 6); assert.match(r2.text, /does not record "battery_cell_count"/);
});

test('tail torque assist: off with gov_tta_gain 0 in each tail rotor mode, a check when it is on with tail_rotor_mode VARIABLE (govInitTTA)', () => {
    // the header gives gov_tta_gain 0: the assist is off, with or without a tail motor
    for (const key of ['esc', 'nocli']) for (const r of tuneOf(key, syn(), key === 'esc' ? { cli: CLI_ESC } : {}).rows.filter(x => /^gov_tta_/.test(x.name))) {
        assert.equal(r.status, 'not-applicable', r.id); assert.match(r.reason, /"gov_tta_gain" or "gov_tta_limit" is 0/); }
    // gov_tta_gain 50 and gov_tta_limit 20: the firmware uses the assist also with a tail rotor that has no tail motor
    const rec0 = GP.recover(syn(), {}), on = Object.assign({}, rec0, { epochs: rec0.epochs.map(e => e.name === 'gov_tta_gain' ? Object.assign({}, e, { value: 50, estimate: 50 }) : e) });
    const variable = GT.tune(syn(), { recovered: on, cli: CLI_ESC }), g = variable.rows.filter(x => x.name === 'gov_tta_gain' && x.topic === 'value');
    assert.ok(g.length && g.every(r => r.status === 'check'), g.map(r => r.status).join());
    assert.match(g[0].text, /The tail rotor mode is VARIABLE \("tail_rotor_mode"\), and the tail torque assist is on\. With yaw, the governor increases the headspeed by a maximum of 20 %\. If this is not necessary, set "gov_tta_gain" to 0\./);
    assert.ok(variable.rows.filter(x => x.name === 'gov_tta_limit').every(r => r.status === 'keep'), 'one check: the limit follows the gain');
    assert.ok(variable.recommendations.some(r => r.parameter === 'gov_tta_gain' && r.severity === 'check'));
    const motor = GT.tune(syn(), { recovered: on, cli: '# dump all\nset tail_rotor_mode = MOTORIZED' });
    assert.ok(motor.rows.filter(x => x.name === 'gov_tta_gain' && x.topic === 'value').every(r => r.status === 'keep'));
    const unknown = GT.tune(syn(), { recovered: on }).rows.filter(x => x.name === 'gov_tta_gain' && x.topic === 'value');
    assert.ok(unknown.every(r => r.status === 'check' && /does not record "tail_rotor_mode"/.test(r.text)));
});

test('FALLBACK: one check row for each event of a flight log, with 0.9 x govI, the RECOVERY start and the headspeed decrease', () => {
    const res = tuneOf('esc', syn(), { cli: CLI_ESC });
    assert.equal(res.measures.fallbacks.length, 1, 'the FALLBACK of the bench run is not used');
    const f = res.measures.fallbacks[0];
    assert.equal(f.log, 0); assert.equal(f.profile, 1); assert.ok(f.atMax); assert.ok(f.satS > 0.25);
    assert.equal(f.drop, 10); assert.equal(f.precomp, 'OFF');
    assert.ok(Math.abs(f.throttle - 0.9 * f.govI) < 0.002, `${f.throttle} against 0.9 x ${f.govI}`); assert.ok(Math.abs(f.calc - f.throttle) < 0.002);
    assert.ok(f.calcOn > f.throttle, 'precomp ON keeps the F-term');
    assert.equal(f.recovery, 0.55); assert.ok(f.kmot > 2000, `Kmot ${f.kmot}`); assert.ok(f.recoveryCalc > 0.3 && f.recoveryCalc < 0.7);
    assert.ok(f.minShare < 0.85 && f.minShare > 0.7, `min ${f.minShare}`); assert.ok(f.jump > 1000);
    const r = rowsOf(res, 'gov_fallback_drop', { topic: /^fallback:/ });
    assert.equal(r.length, 1); assert.equal(r[0].status, 'check'); assert.equal(r[0].profile, 1);
    assert.match(r[0].text, /An error of the RPM signal starts FALLBACK, not the load/);
    assert.ok(r[0].evidence.some(e => /"gov_use_fallback_precomp" ON/.test(e.text)));
    // the RPM signal: the FALLBACK at the maximum throttle, the levers and the raw RPM
    const sig = rowsOf(res, 'freq_input_pull')[0]; assert.equal(sig.status, 'check'); assert.match(sig.text, /1 of 1 FALLBACK start/);
    const dbg = rowsOf(res, 'debug_mode')[0]; assert.equal(dbg.status, 'not-recorded'); assert.ok(dbg.inform); assert.match(dbg.record, /RPM_SOURCE/);
    assert.ok(rowsOf(res, 'gov_max_throttle', { topic: 'model' }).every(x => x.evidence.length > 0), 'the association is evidence of the max throttle model rows');
});

test('limits: the throttle at its maximum is a check in each PID profile, the floor and the terms are measured in ACTIVE', () => {
    const res = tuneOf('esc', syn(), { cli: CLI_ESC });
    for (const p of [1, 2]) assert.equal(rowsOf(res, 'gov_max_throttle', { topic: 'value', profile: p })[0].status, 'check');
    for (const name of ['gov_min_throttle', 'gov_use_dyn_min_throttle']) for (const p of [1, 2]) assert.equal(rowsOf(res, name, { topic: 'value', profile: p })[0].status, 'keep', `${name} ${p}`);
    const d = rowsOf(res, 'gov_d_limit', { topic: 'value', profile: 1 })[0]; assert.match(d.text, /D-term is 0/);
    const h = rowsOf(res, 'gov_headspeed', { topic: 'value', profile: 1 })[0]; assert.ok(['keep', 'check'].includes(h.status)); assert.ok(h.evidence.length >= 2);
    assert.equal(rowsOf(res, 'gov_d_filter', { topic: 'value' })[0].status, 'not-applicable', 'gov_d_gain 0');
    assert.equal(rowsOf(res, 'blackbox_log_battery')[0].status, 'not-recorded', 'Ibat is 0');
});

test('the model families give pending-model rows, and a family function of a later phase replaces them', () => {
    const res = tuneOf('esc', syn(), { cli: CLI_ESC });
    for (const [f, I] of Object.entries(GT.MODEL_INFO)) for (const name of I.names) assert.ok(rowsOf(res, name, { topic: 'model' }).length, `${f}: ${name}`);
    assert.ok(res.rows.filter(r => r.topic === 'model').every(r => r.status === 'pending-model'));
    assert.ok(res.notes.some(n => /governor model is not available/.test(n)));
    const gains = (ctx) => [GT.row(ctx, 'gov_p_gain', 1, { topic: 'model', rule: 'model', method: 'simulation', status: 'change', to: 45, text: 'The governor model gives a larger P-gain.' })];
    const res2 = GT.tune(syn(), { cli: CLI_ESC, families: { gains } });
    assert.equal(rowsOf(res2, 'gov_gain', { topic: 'model' }).length, 0, 'the family function replaces the pending rows');
    const rec = res2.recommendations.find(r => r.parameter === 'gov_p_gain');
    assert.equal(rec.severity, 'action'); assert.deepEqual(rec.cli, ['profile 0', 'set gov_p_gain = 45']); assert.equal(rec.from, 40); assert.equal(rec.to, 45);
    assert.equal(rec.confidence, 'predicted');
    // a governor mode that the model does not cover: the model rows are not applicable, with the reason
    const rec0 = GP.recover(syn(), {}), nitro = Object.assign({}, rec0, { epochs: rec0.epochs.map(e => e.name === 'gov_mode' ? Object.assign({}, e, { value: 'NITRO' }) : e) });
    const res3 = GT.tune(syn(), { recovered: nitro, families: { gains } });
    const m = res3.rows.filter(r => r.topic === 'model'); assert.ok(m.length && m.every(r => r.status === 'not-applicable' && /NITRO/.test(r.reason)));
});

test('recommendations: no CLI text for PID profile unknown, an unknown value or a CLI dump that does not agree', () => {
    const res = tuneOf('esc', syn(), { cli: CLI_ESC }), base = rowsOf(res, 'gov_fallback_drop', { topic: 'model', profile: 1 })[0];
    const make = (o) => GT.toRecommendation(Object.assign({}, base, { status: 'change', to: 5 }, o));
    assert.deepEqual(make({}).cli, ['profile 0', 'set gov_fallback_drop = 5']);
    const unknownP = make({ profile: 0 }); assert.deepEqual(unknownP.cli, []); assert.ok(unknownP.caveats.some(c => /PID profile unknown/.test(c)));
    const unknownV = make({ current: { value: null, source: 'unknown' } }); assert.deepEqual(unknownV.cli, []); assert.ok(unknownV.caveats.some(c => /at this time is unknown/.test(c)));
    const conflict = make({ current: Object.assign({}, base.current, { conflict: { log: 10, cli: 20 } }) }); assert.deepEqual(conflict.cli, []);
    const range = make({ to: 60 }); assert.deepEqual(range.cli, []); assert.ok(range.caveats.some(c => /firmware range/.test(c)));
    for (const r of res.recommendations) {
        assert.ok(['action', 'check', 'watch', 'info'].includes(r.severity), r.id);
        assert.equal(r.node, 'governor'); assert.equal(r.area, 'governor');
        if (r.severity !== 'action') assert.deepEqual(r.cli, [], `${r.id}: no CLI text`);
        for (const k of ['id', 'title', 'severity', 'scope', 'profile', 'cli', 'parameter', 'from', 'fromSource', 'evidence', 'rule', 'blockedBy', 'causes', 'caveats']) assert.ok(k in r, `${r.id}: ${k}`);
    }
    assert.deepEqual(ADV.defaultPicks(res.recommendations), [], 'the checks and the information are not selected by default');
});

test('recommendations: fromSets has the known values of the firmware rules (advice.govLinks), and the CLI file does not call them unknown', () => {
    const res = tuneOf('esc', syn(), { cli: CLI_ESC }), base = rowsOf(res, 'gov_fallback_drop', { topic: 'model', profile: 1 })[0];
    const ctx = { current: res.current, profiles: res.profiles, num: (n, p) => { const c = res.current.byName[n][GT.REG[n].scope === 'global' ? 0 : p]; return c && typeof c.value === 'number' ? c.value : null; } };
    const row = Object.assign({}, base, { name: 'gov_use_fallback_precomp', status: 'change', to: 'ON', current: { value: 'OFF', source: 'CLI dump' } });
    const rec = GT.toRecommendation(row, ctx), plain = GT.toRecommendation(row);
    assert.deepEqual(rec.cli, ['profile 0', 'set gov_use_fallback_precomp = ON']);
    assert.equal(rec.fromSets.gov_mode, 'ELECTRIC'); assert.equal(rec.fromSets.gov_max_throttle, 100); assert.equal(rec.fromSets.gov_use_fallback_precomp, 'OFF');
    for (const [k, v] of Object.entries(GT.linkedOf(ctx, 1))) assert.equal(rec.fromSets[k], v, k);
    assert.ok(!/`gov_mode` is unknown/.test(ADV.exportScript([rec], [rec.id], {})), 'gov_mode is known');
    assert.match(ADV.exportScript([plain], [plain.id], {}), /`gov_mode` is unknown/, 'without the values of the analysis');
});

test('simStale: the flags of the values of the simulated logs, with the cause and the source; a second arm and a pause for all values', () => {
    const src = 'calculated from the log: the F-term of ACTIVE flight';
    const ctx = { rec: { flags: [{ name: 'gov_yaw_ff_weight', profile: 1, value: 10, reasons: ['recovered'], logs: [3, 4], source: src, text: 'a' }, { name: 'gov_yaw_ff_weight', profile: 1, value: 30, reasons: ['recovered'], logs: [5], source: src, text: 'b' },
        { name: 'gov_spoolup_time', profile: 0, value: 80, reasons: ['adjusted'], logs: [3], source: 'CLI dump', text: 'c' }] },
        info: [{ log: 3, flight: true, rearm: true, pause: false }, { log: 4, flight: true, rearm: false, pause: true }, { log: 9, flight: true, rearm: true, pause: false }] };
    const a = GT.simStale(ctx, ['gov_yaw_ff_weight', 'gov_gain'], 1, [3, 4, 5]);
    assert.deepEqual(a.reasons, ['unlogged', 'rearm', 'resume']);
    assert.match(a.text, /"gov_yaw_ff_weight" \(PID profile 1\) changes between logs, and the log does not record the change/);
    assert.match(a.text, /The values are 10 in logs 4 and 5 and 30 in log 6\./); assert.match(a.text, /The source of these values is "analysis of the log"\./);
    assert.match(a.text, /armed the helicopter again in log 4/); assert.match(a.text, /Log 5 has a period with no data/);
    // the summary of each name (logs []): js/tuning_worker.js govJoin shows it in place of the text of each log
    const sums = a.flags.filter(f => f.name && !f.logs.length);
    assert.deepEqual(sums.map(f => [f.reason, f.name, f.profile]), [['unlogged', 'gov_yaw_ff_weight', 1]]);
    assert.ok(a.text.includes(sums[0].text) && /^"gov_yaw_ff_weight" \(PID profile 1\) changes between logs.* The source of these values is "analysis of the log"\.$/.test(sums[0].text), sums[0].text);
    assert.deepEqual(GT.simStale(ctx, ['gov_yaw_ff_weight'], 2, [3, 4]).reasons, ['rearm', 'resume'], 'a flag of another PID profile does not apply');
    assert.match(GT.simStale(ctx, ['gov_spoolup_time'], null, [3]).text, /An in-flight adjustment changes "gov_spoolup_time"\. .*The source of these values is "CLI dump"\./);
    assert.equal(GT.simStale(ctx, ['gov_headspeed'], 1, [5]), null, 'no flag of a used name, no arm, no pause');
    assert.equal(GT.simStale(ctx, ['gov_yaw_ff_weight'], 1, []), null);
    const m = GT.mergeStale({ reasons: ['rearm'], flags: [{ reason: 'rearm' }], source: 'CLI dump', text: 'One.' }, GT.simStale(ctx, ['gov_headspeed'], 1, [9]));
    assert.deepEqual(m.reasons, ['rearm']); assert.match(m.text, /^One\. The governor model uses values/);
    assert.equal(GT.mergeStale(null, null), null);
    // review 2026-10-15: each flag of one log has the PID profile of its summary (govJoin keys them on the name and the PID profile); a name with
    // one value in the simulated logs (log 6 only: 30) does not change there, so it has no flag
    assert.ok(a.flags.filter(f => f.name === 'gov_yaw_ff_weight').every(f => f.profile === 1), JSON.stringify(a.flags));
    assert.equal(GT.simStale(ctx, ['gov_yaw_ff_weight'], 1, [5]), null, 'one value in the simulated logs: no change');
    assert.equal(GT.simStale(Object.assign({}, ctx, { info: [] }), ['gov_yaw_ff_weight'], 1, [3, 4]), null, 'logs 4 and 5 have the value 10 only');
    // mergeStale: a name of the rule flag (staleOf) with a summary of the simulation is left out of the rule part (one text for each value)
    const rule = { reasons: ['unlogged'], source: src, text: 'Rule text.', flags: [{ reason: 'unlogged', name: 'gov_yaw_ff_weight', profile: 1, logs: [3], text: 'p' }, { reason: 'unlogged', name: 'gov_yaw_ff_weight', profile: 1, logs: [], text: 'sum' }] };
    assert.equal(GT.mergeStale(rule, a), a, 'only the simulated flags stay');
    const mixed = GT.mergeStale(Object.assign({}, rule, { reasons: ['unlogged', 'cli'], flags: rule.flags.concat([{ reason: 'cli', logs: [], text: 'The CLI dump gives 5.' }]) }), a);
    assert.deepEqual([mixed.flags.filter(f => f.text === 'sum' || f.text === 'p').length, mixed.flags.some(f => f.reason === 'cli')], [0, true]);
    assert.match(mixed.text, /^This value is possibly not the same in all logs\. The cause is a different value in the CLI dump\./);
});

test('staleOf of a row of the model: the values of the logs of the model only (modelLogs); a value with one value there does not change (review 2026-10-15)', () => {
    // gov_spoolup_time: 250 in logs 0-1 (no voltage: not in the model), 200 in logs 2-3, 150 in log 4; gov_startup_time: 300 in log 0, 250 in logs 1-4
    const runs = [0, 1, 2, 3, 4].map(l => synthRun(l, 20, 2000, 1, 'flight', (t) => t < 2 ? { state: 0, stick: 0, phase: 0, u: 0, hs: 0 }
        : t < 4 ? { state: 2, stick: 1, phase: 1, u: 0.3, hs: 1000 } : { state: 4, stick: 1, phase: 3, u: 0.6, hs: 2000, coll: 0.2 }));
    const rec = GP.recover(runs, {});
    rec.flags = [{ name: 'gov_spoolup_time', profile: 0, value: 250, reasons: ['recovered'], logs: [0, 1], source: 'log header', text: 'a' }, { name: 'gov_spoolup_time', profile: 0, value: 200, reasons: ['recovered'], logs: [2, 3], source: 'log header', text: 'b' },
        { name: 'gov_spoolup_time', profile: 0, value: 150, reasons: ['recovered'], logs: [4], source: 'log header', text: 'c' },
        { name: 'gov_startup_time', profile: 0, value: 300, reasons: ['recovered'], logs: [0], source: 'log header', text: 'd' }, { name: 'gov_startup_time', profile: 0, value: 250, reasons: ['recovered'], logs: [1, 2, 3, 4], source: 'log header', text: 'e' }];
    const all = GT.tune(runs, { recovered: rec }), model = GT.tune(runs, { recovered: rec, modelLogs: [2, 3, 4] });
    const J = (x) => JSON.stringify(x), flagOf = (res, name, method) => { const r = res.rows.find(x => x.name === name && x.method === method); return r ? r.stale : undefined; };
    // a rule row: every flight log (250 is a value of logs 1 and 2)
    const ruleS = flagOf(all, 'gov_spoolup_time', 'rule') || flagOf(all, 'gov_spoolup_time', 'data');
    assert.ok(ruleS && ruleS.flags.some(f => !f.logs.length && /The first value is 250 in logs 1 and 2, and the last value is 150 in log 5\./.test(f.text)), J(ruleS));
    // a row of the model: logs 3-5 only (200 and 150), with the PID profile on each flag; gov_startup_time has one value there: no flag
    const pend = model.rows.filter(x => x.method === 'model' || x.method === 'simulation');
    assert.ok(pend.length > 0, 'rows of the model');
    for (const r of pend) for (const f of (r.stale && r.stale.flags) || []) {
        assert.ok(!f.name || f.profile !== undefined, `a flag with no PID profile: ${J(f)}`);
        if (f.name === 'gov_spoolup_time') assert.ok(f.logs.every(l => [2, 3, 4].includes(l)), J(f));
        assert.notEqual(f.name, 'gov_startup_time', 'one value in the logs of the model');
    }
    const sp = pend.find(r => r.name === 'gov_spoolup_time'), spS = sp && sp.stale;
    assert.ok(spS && spS.flags.some(f => !f.logs.length && /The values are 200 in logs 3 and 4 and 150 in log 5\./.test(f.text)), J(sp));
});

// exportPlan of advice.cjs when it exports it, else the same decision read from exportScript
function planOf(rec) {
    if (typeof ADV.exportPlan === 'function') return ADV.exportPlan(rec);
    const text = ADV.exportScript([rec], [rec.id], {}), not = /^# Not in the file: .*?\(`[^`]*`\)\. (.*)$/m.exec(text);
    return not ? { why: not[1] } : { sets: text.split('\n').filter(l => /^set /.test(l)).map(l => l.slice(4).split(' = ')) };
}
// a change of each of the 42 names, at a valid value, through advice.exportPlan. A name that advice.PARAMS does not have yet (the
// advice agent adds the governor names, the ON/OFF flags and the bypass list to cliValueOk) is a todo
const SAMPLE = { gov_mode: 'ELECTRIC', gov_throttle_type: 'FUNCTION', gov_bypass_throttle: [0, 20, 40, 60, 80, 100, 120, 140, 160], gov_use_fallback_precomp: 'ON', gov_use_voltage_comp: 'OFF',
    gov_use_pid_spoolup: 'ON', gov_use_dyn_min_throttle: 'OFF', gov_headspeed: 2100, gov_collective_curve: 25, gov_min_throttle: 15, gov_max_throttle: 98, gov_handover_throttle: 30 };
for (const R of GT.REGISTRY) {
    test(`the CLI text of a change of "${R.name}" passes advice.exportPlan`, (t) => {
        if (!ADV.PARAMS[R.name]) t.todo(`advice.PARAMS has no "${R.name}" yet (the advice agent adds the governor names, ON/OFF and the bypass list)`);
        const res = tuneOf('esc', syn(), { cli: CLI_ESC }), p = R.scope === 'global' ? null : 1;
        const base = res.rows.find(r => r.name === R.name && r.profile === p);
        const to = SAMPLE[R.name] !== undefined ? SAMPLE[R.name] : Math.min(R.range[1], Math.max(R.range[0], (typeof R.default === 'number' ? R.default : R.range[0]) + 1));
        const rec = GT.toRecommendation(Object.assign({}, base, { status: 'change', to, current: { value: R.default, source: 'calculated from the log: a test' } }));
        assert.ok(rec.cli.length, `${R.name}: CLI text (${rec.caveats.join(' ')})`);
        assert.equal(rec.cli[rec.cli.length - 1], `set ${R.name} = ${GT.cliValue(R.name, to)}`);
        if (p) assert.equal(rec.cli[0], 'profile 0');
        const plan = planOf(rec);
        assert.ok(!plan.why, `${R.name}: ${plan.why}`);
        assert.deepEqual(plan.sets, [[R.name, GT.cliValue(R.name, to)]]);
    });
}

test('a log set without flight: every row says so, and no row uses a bench run', () => {
    const res = GT.tune([runC()], {});
    assert.equal(res.status, 'no-flights'); assert.deepEqual(res.coverage.missing, []);
    assert.equal(res.measures.fallbacks.length, 0);
    assert.ok(res.rows.filter(r => r.name !== 'gov_mode' && r.name !== 'feature GOVERNOR' && GT.REG[r.name]).every(r => r.status === 'not-applicable' && /no flight/.test(r.reason)));
    assert.ok(res.notes.some(n => /no flight/.test(n)));
});

// ---------------------------------------------------------------------------------------------
// the review findings: control limits, modes, rates, values and texts
// ---------------------------------------------------------------------------------------------

// a flight of PID profile 1 at 2000 rpm in ACTIVE from 4 s to 30 s, with a throttle limit of max (fraction): the throttle stays at the limit
// from 20 s to 23 s. spikes: times of a one-sample step of the headspeed signal (+300 rpm)
const clamp01 = (x) => Math.min(1, Math.max(0, x));
function limitRun(log, max, o = {}) {
    const R = 2000, spikes = new Set((o.spikes || []).map(t => Math.round(t * (o.rate || RATE))));
    const run = synthRun(log, 34, R, 1, 'flight', (t) => {
        if (t < 2) return { state: 0, stick: 0, phase: 0, u: 0, hs: 0 };
        if (t < 4) return { state: 2, stick: 1, phase: 1, u: 0.3 + 0.1 * (t - 2), hs: 1000 + 500 * (t - 2) };
        // the headspeed decreases by 3 % in 0.5 s at the limit, and increases again in 0.5 s after it (no step in one sample)
        if (t < 30) { const top = t >= 20 && t < 23, drop = 0.03 * clamp01(Math.min((t - 20) / 0.5, (23.5 - t) / 0.5));
            return { state: 4, stick: 1, phase: t < 5 ? 2 : 3, u: top ? max : 0.55 + 0.05 * Math.sin(t), hs: R * (1 - drop) + 3 * Math.sin(2 * Math.PI * 2 * t), coll: 0.2 }; }
        return { state: 0, stick: 0, phase: 4, u: 0, hs: Math.max(0, R - 500 * (t - 30)) };
    }, o);
    for (const i of spikes) run.hs[i] += 300;
    return run;
}

test('gov_max_throttle 95: the sudden changes of check G21 and the periods are relative to the maximum throttle', () => {
    const cli = '# dump all\nset gov_mode = ELECTRIC\nprofile 0\nset gov_max_throttle = 95\nset gov_headspeed = 2000';
    const spikes = [20.5, 21, 21.5, 22, 22.5, 22.9];
    const res = GT.tune([limitRun(0, 0.95, { spikes }), limitRun(1, 0.95, { spikes })], { cli });
    assert.equal(res.current.byName.gov_max_throttle[1].value, 95);
    // one sample +300 rpm (15 % of the target): one sudden change of check G21 (the step up and the step down 3 ms later are one change)
    const G = res.measures.glitch; assert.equal(G.rule, 'G21'); assert.deepEqual([G.all.k, G.all.N], [12, 12]);
    assert.equal(G.byProfile['1'].severity, 'flag', 'check G21: all the sudden changes at the maximum throttle'); assert.ok(G.all.p < 1e-6, `p ${G.all.p}`);
    const sig = rowsOf(res, 'freq_input_pull')[0]; assert.equal(sig.status, 'check');
    assert.match(sig.text, /With the throttle at its maximum, the headspeed signal has 12 sudden changes in 6 s\./);
    assert.match(sig.text, /Check G21 of the analysis gives a lower "gov_max_throttle"/);
    assert.ok(sig.evidence.some(e => /The test value of check G21 is `P\(X >= 12\) = [\d.e-]+` for `X ~ Binomial\(12, [\d.]+\)`\./.test(e.text)), JSON.stringify(sig.evidence.map(e => e.text)));
    assert.deepEqual(GT.g21Change(G, 1, 0.95).to, 92, 'the change of check G21: 95 - 3');
    assert.ok(rowsOf(res, 'gov_max_throttle', { topic: 'value', profile: 1 })[0].status === 'check');
    // the same flights with a limit of 100 % and a throttle of 95 %: not at the maximum, and G21 cannot show a relation
    const res100 = GT.tune([limitRun(0, 0.95, { spikes }), limitRun(1, 0.95, { spikes })], { cli: cli.replace('gov_max_throttle = 95', 'gov_max_throttle = 100') });
    assert.deepEqual([res100.measures.glitch.all.k, res100.measures.glitch.all.N], [0, 12]); assert.equal(res100.measures.periodCount, 0);
    assert.equal(res100.measures.glitch.byProfile['1'].severity, 'note'); assert.equal(GT.g21Change(res100.measures.glitch, 1, 1), null);
});

test('the sudden change of check G21 is a rate: a real headspeed decrease at a low log rate is not a sudden change', () => {
    // 50 Hz: a decrease of 1000 rpm in 0.3 s and an increase in 0.3 s are 3.3 rpm/ms, less than the 40 rpm/ms of check G21 (health_gov RULE.g21)
    const run = limitRun(0, 1, { rate: 50 }); for (let i = Math.round(20 * 50); i < Math.round(20.6 * 50); i++) run.hs[i] = 2000 - 1000 * (1 - Math.abs(i / 50 - 20.3) / 0.3);
    const res = GT.tune([run], {}); assert.equal(res.measures.glitch.all.N, 0, JSON.stringify(res.measures.glitch.all));
});

test('gov_mode LIMIT: the throttle limits apply and are examined, the other names have no effect', () => {
    // no governor condition and no governor terms with the motor on (gov_params: OFF or LIMIT)
    const o = { omit: ['govI', 'govD', 'govF', 'govTarget', 'govRequest', 'govStateAt'], zero: ['govP', 'govSum'] };
    const runs = [limitRun(0, 0.9, o), limitRun(1, 0.9, o)];
    const res = GT.tune(runs, { cli: '# dump all\nset gov_mode = LIMIT\nset gov_idle_throttle = 0\nprofile 0\nset gov_max_throttle = 90\nset gov_min_throttle = 10' });
    assert.equal(res.status, 'governor-limit'); assert.deepEqual(res.coverage.missing, []);
    const mx = rowsOf(res, 'gov_max_throttle'); assert.ok(mx.length >= 1); assert.ok(mx.every(r => r.topic === 'value'), 'no model row that says "no effect"');
    assert.equal(mx[0].status, 'check'); assert.match(mx[0].text, /The throttle is at its maximum \(90 %\) for [\d.]+ s in 2 periods/);
    assert.ok(mx[0].evidence.filter(e => /^Log \d+ at [\d.]+ s: [\d.]+ s at the maximum throttle/.test(e.text)).length === 2, 'each period is evidence');
    for (const name of ['gov_min_throttle', 'gov_idle_throttle', 'gov_handover_throttle']) assert.ok(rowsOf(res, name).every(r => r.status !== 'not-applicable'), name);
    assert.match(rowsOf(res, 'gov_idle_throttle')[0].text, /In LIMIT, the lowest throttle is the larger value/);
    const p = rowsOf(res, 'gov_p_gain'); assert.ok(p.length && p.every(r => r.status === 'not-applicable' && /mode is LIMIT/.test(r.reason)));
    assert.match(rowsOf(res, 'gov_mode')[0].text, /The governor mode is LIMIT\..*The source of this value is "CLI dump"/);
    // without the CLI dump: OFF or LIMIT. The three limits say that they apply if the mode is LIMIT
    const res2 = GT.tune(runs, {});
    assert.equal(res2.status, 'governor-off');
    assert.match(rowsOf(res2, 'gov_mode')[0].text, /OFF or LIMIT/);
    for (const name of ['gov_max_throttle', 'gov_min_throttle', 'gov_idle_throttle', 'gov_handover_throttle']) assert.match(rowsOf(res2, name)[0].text, /If the governor mode is LIMIT, this value applies/, name);
    // OFF from the CLI dump: everything has no effect, and the text gives the source
    const off = GT.tune(runs, { cli: '# dump all\nset gov_mode = OFF' });
    assert.ok(off.rows.filter(r => GT.REG[r.name] && r.name !== 'gov_mode').every(r => r.status === 'not-applicable'));
    assert.match(rowsOf(off, 'gov_mode')[0].text, /^The governor mode is OFF\..*CLI dump/);
});

test('control limits: a period in a PID profile with less than 2 s of ACTIVE has its own row, and each period is evidence', () => {
    // log 1: PID profile 2 at 2400 rpm for 1.5 s of ACTIVE, with 1 s at the maximum throttle
    const short = synthRun(2, 12, 2400, 2, 'flight', (t) => {
        if (t < 2) return { state: 0, stick: 0, phase: 0, u: 0, hs: 0 };
        if (t < 4) return { state: 2, stick: 1, phase: 1, u: 0.3 + 0.1 * (t - 2), hs: 1200 + 600 * (t - 2) };
        if (t < 5.5) return { state: 4, stick: 1, phase: 3, u: t >= 4.3 && t < 5.3 ? 1 : 0.6, hs: 2400, coll: 0.2 };
        return { state: 0, stick: 0, phase: 4, u: 0, hs: 0 };
    });
    const res = GT.tune([limitRun(0, 0.6), limitRun(1, 0.6), short], { cli: '# dump all\nset gov_mode = ELECTRIC\nprofile 0\nset gov_max_throttle = 100\nprofile 1\nset gov_max_throttle = 100' });
    const lab = res.measures.periods.filter(x => x.s >= 0.9).map(x => x.profile); assert.equal(lab.length, 1, JSON.stringify(res.measures.periods));
    assert.ok(!res.profiles.includes(lab[0]), `the label ${lab[0]} has less than 2 s of ACTIVE`);
    const r = rowsOf(res, 'gov_max_throttle', { topic: 'value', profile: lab[0] }); assert.equal(r.length, 1); assert.equal(r[0].status, 'check');
    assert.ok(r[0].evidence.some(e => /^Log 3 at [\d.]+ s: 1 s at the maximum throttle/.test(e.text)));
    // the other PID profile: the text is for that PID profile only
    for (const q of res.profiles) assert.match(rowsOf(res, 'gov_max_throttle', { topic: 'value', profile: q })[0].text, new RegExp(`^In PID profile ${q}, the throttle is not at its maximum`));
});

test('control limits: the I-term periods in seconds with logs at different rates, with the other outputs and the error', () => {
    const cli = '# dump all\nset gov_mode = ELECTRIC\nprofile 0\nset gov_i_limit = 95\nset gov_max_throttle = 100';
    const a = limitRun(0, 1), b = limitRun(1, 1, { rate: 500 });
    for (const [run, rate] of [[a, RATE], [b, 500]]) for (let i = Math.round(10 * rate); i < Math.round(11 * rate); i++) run.govI[i] = 0.95;
    // 1 s at 1000 Hz and 1 s at 500 Hz with the throttle not at a limit: 2 s (the I-term is also at its limit with the throttle at 100 %)
    const res = GT.tune([a, b], { cli }), T = res.measures.prof[1].terms.govI;
    assert.ok(Math.abs(T.outSatS - 2) < 0.02, `outSatS ${T.outSatS}`); assert.ok(T.inSatS > 0, `inSatS ${T.inSatS}`); assert.ok(Math.abs(T.atS - T.inSatS - T.outSatS) < 1e-6);
    const TP = res.measures.termPeriods.filter(x => x.term === 'govI' && x.t >= 9.9 && x.t <= 10.1); assert.equal(TP.length, 2); assert.ok(TP.every(x => Math.abs(x.s - 1) < 0.01));
    const r = rowsOf(res, 'gov_i_limit', { topic: 'value', profile: 1 })[0]; assert.equal(r.status, 'check');
    assert.match(r.text, /The I-term is at its limit for [\d.]+ s in \d+ periods\. Of this time, 2 s are with the throttle not at a limit\./);
    assert.ok(r.evidence.filter(e => /^Log [12] at 10 s: the I-term is at its limit for 1 s \(ACTIVE\)/.test(e.text) && e.log !== null && isFinite(e.t0) && isFinite(e.t1)).length === 2);
    // the throttle at its maximum from 20 s to 23 s: the I-term (I = u - P - F) is at its limit in the same period
    const per = res.measures.periods.find(x => x.log === 0 && x.s > 2); assert.ok(per, 'period'); assert.ok(per.minError < -0.02); assert.ok(per.others.includes('govI') && per.iLimit);
    // the seconds of the period with the I-term also at its limit (review 2026-10-15: not "at the same time" for any overlap)
    assert.ok(per.overlap && per.overlap.govI > 0 && per.overlap.govI <= per.s + 1e-6, `overlap ${JSON.stringify(per.overlap)} of ${per.s} s`);
    assert.ok(rowsOf(res, 'gov_max_throttle', { topic: 'value', profile: 1 })[0].evidence.some(e => /For [\d.]+ s of this period, the I-term is also at its limit\. The headspeed is less than the target by a maximum of [\d.]+ %\./.test(e.text)));
});

test('the floor: voltage compensation that operates is not a minimum throttle, a floor at the minimum is', () => {
    const cli = '# dump all\nset gov_mode = ELECTRIC\nset battery_meter = ADC\nprofile 0\nset gov_use_voltage_comp = ON\nset gov_min_throttle = 10\nset gov_max_throttle = 100';
    const vc = limitRun(0, 0.6), vc2 = limitRun(1, 0.6);
    for (const run of [vc, vc2]) for (let i = 0; i < run.n; i++) if (run.state[i] === 4) run.govSum[i] = Math.trunc(1000 * run.u[i] / 1.03) / 1000;
    const res = GT.tune([vc, vc2], { cli });
    assert.equal(res.measures.prof[1].floorS, 0); assert.equal(res.measures.floorCount, 0);
    assert.notEqual(rowsOf(res, 'gov_min_throttle', { topic: 'value', profile: 1 })[0].status, 'check');
    // no voltage compensation: govSum under the output at 10 % is the floor
    const fl = limitRun(0, 0.6), fl2 = limitRun(1, 0.6);
    for (let i = Math.round(12 * RATE); i < Math.round(12.5 * RATE); i++) { fl.u[i] = 0.1; fl.govSum[i] = 0.05; }
    const res2 = GT.tune([fl, fl2], { cli: cli.replace('ADC', 'ESC') }), r = rowsOf(res2, 'gov_min_throttle', { topic: 'value', profile: 1 })[0];
    assert.equal(r.status, 'check'); assert.ok(Math.abs(res2.measures.prof[1].floorS - 0.5) < 0.01);
    assert.ok(r.evidence.some(e => /^Log 1 at 12 s: 0.5 s at the minimum throttle \(ACTIVE\)/.test(e.text)));
});

test('a throttle stick sample that is not a number does not stop the analysis', () => {
    const a = runA(); a.thr[20000] = NaN; a.thr[20001] = Infinity;
    assert.doesNotThrow(() => GT.tune([a, runB()], {}));
});

test('a product of gains that changes: a check row for the weight, and no flag on gov_gain and gov_f_gain', () => {
    const rec0 = GP.recover(syn(), {}), src = 'calculated from the log: a fit of "govF" to the mixer inputs';
    const flag = (value, logs) => ({ name: 'gov_yaw_ff_effective', profile: 2, value, logs, reasons: ['recovered'], cause: 'a change', source: src, text: 'The value changes.' });
    const rec = Object.assign({}, rec0, { flags: rec0.flags.concat([flag(0.004, [0]), flag(0.032, [1])]),
        epochs: rec0.epochs.concat([{ name: 'gov_collective_ff_effective', profile: 2, value: 0.02, estimate: 0.02, logs: [0, 1], source: src, effective: true }]) });
    const res = GT.tune(syn(), { recovered: rec, cli: CLI_ESC });
    const r = rowsOf(res, 'gov_yaw_ff_weight', { topic: 'unlogged:gov_yaw_ff_effective', profile: 2 });
    assert.equal(r.length, 1); assert.equal(r[0].status, 'check');
    assert.match(r[0].text, /The other governor values show that "gov_yaw_ff_weight" changes\./);
    assert.match(r[0].title, /"gov_yaw_ff_weight" changes between logs \(PID profile 2\)/);
    const cur = res.current.byName;
    for (const name of ['gov_gain', 'gov_f_gain']) assert.ok(!(cur[name][2].stale && cur[name][2].stale.flags.some(f => f.name === 'gov_yaw_ff_effective')), `${name}: no product flag`);
    assert.ok(cur.gov_yaw_ff_weight[2].stale.flags.some(f => f.name === 'gov_yaw_ff_effective'));
});

test('stale flags for a value from the CLI dump or unknown: a PID profile that is not at the start of the log', () => {
    // log 3 starts in PID profile 1 and changes to PID profile 2 at 20 s
    const d = synthRun(3, 40, (t) => t < 20 ? 2000 : 2200, 1, 'flight', (t) => {
        if (t < 2) return { state: 0, stick: 0, phase: 0, u: 0, hs: 0 };
        if (t < 4) return { state: 2, stick: 1, phase: 1, u: 0.3 + 0.1 * (t - 2), hs: 1000 + 500 * (t - 2) };
        if (t < 36) return { state: 4, stick: 1, phase: 3, u: 0.6, hs: t < 20 ? 2000 : 2200, coll: 0.2 };
        return { state: 0, stick: 0, phase: 4, u: 0, hs: 0 };
    }, { profileAt: (t) => t < 20 ? 1 : 2 });
    const res = GT.tune(syn().concat([d]), { cli: CLI_ESC }), byName = res.current.byName;
    const vals = Object.entries(byName).filter(([n]) => GT.REG[n].scope === 'profile').map(([n, by]) => [n, by[2]]).filter(([, v]) => v && (v.from === 'cli' || v.from === null));
    assert.ok(vals.length > 0);
    for (const [n, v] of vals) { assert.ok(v.stale && v.stale.reasons.includes('switched'), `${n}: ${v.source}`); assert.deepEqual(v.stale.flags.find(f => f.reason === 'switched').logs, [3], n); }
    const cliVal = vals.find(([, v]) => v.from === 'cli'); if (cliVal) assert.match(cliVal[1].stale.text, /The source of the value is "CLI dump/);
});

// review IMP-05: a log with a parameter snapshot (blackbox_params FULL) records the values of every PID profile at its start, and its
// journal records each change. A switch to PID profile 2 in that log is no cause, and a re-arm or a pause is not either
test('a log with a parameter snapshot: the values of PID profile 2 come from the snapshot with no stale flag', () => {
    const PL = require(path.join(ROOT, 'tools/autotune/param_log.cjs')), text = (v) => Array.isArray(v) ? v.join(',') : String(v);
    const body = [['Param log', '1'], ['param_mode', 'FULL'], ['param_loop', '2,1,1,128'], ['param_phase', 'pos=0,sp=0,pid=0,mix=0,mot=0,fupd=0,bb=0,flush=0'],
        ['param_pgs', '14.0/936'], ['param_fixes', '-'], ['param_rt', 'gov_mode=3,features=0,pid_denom=2,filter_denom=1,looptime=500,debug_mode=0,motors=1,servos=4'],
        ['param_pid_profile', '0'], ['param_rate_profile', '0'], ['set.gov_mode', 'ELECTRIC'], ['set.bat_profile', '1'], ['set.battery_cell_count', '6,12,6,6,6,6']];
    for (const n of GP.GLOBAL) if (n !== 'gov_mode') body.push([`set.${n}`, text(GT.REG[n].default)]);
    for (const n of GP.PROFILE) body.push([`set@p.${n}`, [0, 1, 2, 3, 4, 5].map(k => n === 'gov_headspeed' ? [2000, 2200, 2400, 1000, 1000, 1000][k] : text(GT.REG[n].default)).join('|')]);
    let hash = 2166136261; for (const [k, v] of body) hash = PL.fnv1(`H ${k}:${v}\n`, hash);
    body.push(['param_end', `${body.length},${(hash >>> 0).toString(16)}`]);
    // log 3 starts in PID profile 1 and changes to PID profile 2 at 20 s, with a second arm at 37 s
    const d = synthRun(3, 40, (t) => t < 20 ? 2000 : 2200, 1, 'flight', (t) => {
        if (t < 2) return { state: 0, stick: 0, phase: 0, u: 0, hs: 0 };
        if (t < 4) return { state: 2, stick: 1, phase: 1, u: 0.3 + 0.1 * (t - 2), hs: 1000 + 500 * (t - 2) };
        if (t < 36) return { state: 4, stick: 1, phase: 3, u: 0.6, hs: t < 20 ? 2000 : 2200, coll: 0.2 };
        return { state: 0, stick: 0, phase: 4, u: 0, hs: 0 };
    }, { profileAt: (t) => t < 20 ? 1 : 2 });
    d.header = Object.assign({}, HEADER, { paramHeader: body });
    assert.ok(PL.snapshotOf(d.header), 'a complete snapshot');
    const res = GT.tune(syn().concat([d]), { cli: CLI_ESC }), byName = res.current.byName;
    const rows = Object.entries(byName).filter(([n]) => GT.REG[n].scope === 'profile').map(([n, by]) => [n, by[2]]).filter(([, v]) => v && v.snapshot);
    assert.ok(rows.length > 20, `${rows.length} rows of PID profile 2 from the snapshot`);
    for (const [n, v] of rows) { assert.equal(v.stale, null, `${n}: ${JSON.stringify(v.stale)}`); assert.match(v.source, /^log header \(the parameter values of PID profile 2 in log 4\)$/, n); }
    assert.equal(byName.gov_headspeed[2].value, 2200);
    // 4.7: battery_cell_count is the element of bat_profile
    assert.deepEqual([res.current.related.battery_cell_count.value, res.current.related.battery_cell_count.from], [12, 'header']);
    // a newer flight log with no snapshot (stock firmware again): the older snapshot does not hide the newer header values
    const e = synthRun(4, 40, 2000, 1, 'flight', (t) => t < 2 ? { state: 0, stick: 0, phase: 0, u: 0, hs: 0 } : t < 4 ? { state: 2, stick: 1, phase: 1, u: 0.3, hs: 1500 }
        : t < 36 ? { state: 4, stick: 1, phase: 3, u: 0.6, hs: 2000, coll: 0.2 } : { state: 0, stick: 0, phase: 4, u: 0, hs: 0 });
    const newer = GT.tune(syn().concat([d, e]), { cli: CLI_ESC });
    assert.equal(newer.current.snapshot, null);
    assert.ok(!Object.values(newer.current.byName).some(by => Object.values(by).some(v => v && v.snapshot)), 'no value of the older snapshot');
});

test('texts follow RULES: a change of a threshold changes the text', () => {
    const HG = require('../tools/autotune/health_gov.cjs');
    const keep = JSON.parse(JSON.stringify({ q: GT.RULES.headroom.q, sag: GT.RULES.fallback.sag, within: GT.RULES.fallback.within, minRate: HG.RULE.g21.minRate, low: GT.RULES.saturation.lowShare, reserve: GT.RULES.headroom.reserve, over: GT.RULES.spool.overshoot }));
    try {
        Object.assign(GT.RULES.headroom, { q: 0.9, reserve: 0.2 }); Object.assign(GT.RULES.fallback, { sag: 0.8, within: 0.02 }); HG.RULE.g21.minRate = 50; GT.RULES.saturation.lowShare = 0.4; GT.RULES.spool.overshoot = 0.03;
        const res = GT.tune(syn(), { cli: CLI_ESC }), all = res.rows.map(r => [r.text].concat(r.evidence.map(e => e.text)).join(' ')).join('\n');
        assert.match(all, /or less for 90 % of the time/); assert.match(all, /The limit is 80 %\. This gives a reserve of 20 %\./);
        assert.match(all, /stays at less than 80 % for/); assert.match(GT.RULES.glitch.text, /at more than 50000 rpm\/s\. This is not a movement of the rotor \(check G21\)/);
        assert.match(GT.RULES.headroom.text, /80 % or less for 90 %/); assert.match(GT.RULES.spool.text, /by more than 3 %/); assert.match(GT.MODEL_INFO.power.text, /reserve of 20 %/);
        assert.match(GT.MODEL_INFO.spoolup.text, /at 3 % or less/);
    } finally {
        Object.assign(GT.RULES.headroom, { q: keep.q, reserve: keep.reserve }); Object.assign(GT.RULES.fallback, { sag: keep.sag, within: keep.within }); HG.RULE.g21.minRate = keep.minRate;
        GT.RULES.saturation.lowShare = keep.low; GT.RULES.spool.overshoot = keep.over;
    }
});

test('recommendations: the firmware validation of the throttle values, the source words, and no instruction without CLI text', () => {
    const res = tuneOf('esc', syn(), { cli: CLI_ESC }), base = rowsOf(res, 'gov_max_throttle', { topic: 'value', profile: 1 })[0];
    const ctx = { num: (n) => n === 'gov_handover_throttle' ? 25 : n === 'gov_max_throttle' ? 90 : null, profiles: [1, 2] };
    const low = GT.toRecommendation(Object.assign({}, base, { status: 'change', to: 20 }), ctx);
    assert.deepEqual(low.cli, []); assert.equal(low.severity, 'check'); assert.ok(low.caveats.some(c => /must be equal to or more than "gov_handover_throttle" \(25\)/.test(c) && /changes the value 20 to 25/.test(c)));
    assert.ok(!/^Set /.test(low.title), low.title); assert.doesNotMatch(low.text, /Set "gov_max_throttle"/);
    const ok = GT.toRecommendation(Object.assign({}, base, { status: 'change', to: 98 }), ctx); assert.deepEqual(ok.cli, ['profile 0', 'set gov_max_throttle = 98']); assert.equal(ok.severity, 'action');
    const minRow = rowsOf(res, 'gov_min_throttle', { topic: 'value', profile: 1 })[0];
    assert.deepEqual(GT.toRecommendation(Object.assign({}, minRow, { status: 'change', to: 95 }), ctx).cli, [], 'min > max');
    const unknownP = GT.toRecommendation(Object.assign({}, base, { status: 'change', to: 98, profile: 0 }), ctx);
    assert.deepEqual(unknownP.cli, []); assert.equal(unknownP.severity, 'check'); assert.ok(!/^Set /.test(unknownP.title)); assert.doesNotMatch(unknownP.text, /Set "/);
    // a value that the analysis calculates: the CLI file comment says "the value at this time is from the analysis of the log" (its method is in the row)
    const sp = rowsOf(res, 'gov_spoolup_time', { topic: 'value' })[0]; assert.match(sp.current.source, /^calculated from the log: /);
    const rec = GT.toRecommendation(Object.assign({}, sp, { status: 'change', to: 120 }), ctx);
    assert.equal(rec.fromSource, 'analysis of the log'); assert.match(rec.text, /The value at this time is from the analysis of the log\./);
    const script = ADV.exportScript([rec], [rec.id], {});
    assert.match(script, /from 80 to 120 \(the value at this time is from the analysis of the log\)/); assert.doesNotMatch(script, /from the calculated/);
});

// ---------------------------------------------------------------------------------------------
// real data (analysis/governor-20261014/data, not in git)
// ---------------------------------------------------------------------------------------------

const DATA = path.join(ROOT, 'analysis/governor-20261014/data');
const hasFireball = fs.existsSync(path.join(DATA, 'fireball', 'meta.json')), hasGaui = fs.existsSync(path.join(DATA, 'gaui', 'meta.json'));
const REAL = {};
const real = (craft) => REAL[craft] || (REAL[craft] = GT.tune(GD.load(path.join(DATA, craft), { bench: true }),
    { cli: craft === 'fireball' && process.env.GOV_CLI && fs.existsSync(process.env.GOV_CLI) ? fs.readFileSync(process.env.GOV_CLI, 'utf8') : null }));

test('Fireball: the rows of every governor parameter, the 3 FALLBACK times (critique V3), the BAILOUT of log 11, the drift', { skip: !hasFireball && 'no analysis/governor-20261014/data/fireball' }, (t) => {
    const res = real('fireball');
    t.diagnostic(`\n${GT.table(res.rows)}`);
    assert.deepEqual(res.coverage.missing, []); assert.equal(res.coverage.covered, 42);
    assert.deepEqual(res.profiles, [1, 2, 3]);
    const F = res.measures.fallbacks;
    assert.equal(F.length, 3);
    assert.deepEqual(F.map(f => Math.round(1000 * f.throttle)), [688, 672, 719]);
    for (const f of F) { assert.ok(Math.abs(f.throttle - 0.9 * f.govI) < 0.0015, `${f.t}: 0.9 x govI`); assert.ok(f.atMax); assert.equal(f.profile, 2); assert.ok(Math.abs(f.recovery - f.recoveryCalc) <= 0.003, `${f.t}: RECOVERY ${f.recovery} against ${f.recoveryCalc}`); }
    assert.deepEqual(F.map(f => Math.round(1000 * f.recovery)), [649, 555, 521]);
    assert.deepEqual(F.map(f => f.jump), [1051, 1276, 1316]);
    assert.equal(rowsOf(res, 'gov_fallback_drop', { topic: /^fallback:/ }).length, 3);
    // check G21 (health_gov, the same detector and test as the analysis): 5 of 6 sudden changes at 100 % throttle, all in PID profile 2
    // (one sudden change is one episode, review 2026-10-15: the burst of log 14 at 205.81 s to 205.97 s counts once)
    const G = res.measures.glitch; assert.deepEqual([G.all.k, G.all.N], [5, 6], JSON.stringify(G.all)); assert.ok(G.all.p < 1e-8, `p ${G.all.p}`);
    // PID profile 3: no sudden change in less than 12 s at the maximum is not measured (review 2026-10-15), not satisfactory
    assert.equal(G.byProfile['2'].severity, 'flag'); assert.deepEqual(['1', '3'].map(p => G.byProfile[p].severity), ['note', 'skipped']);
    assert.ok(G.byProfile['3'].atMaxS > 0 && G.byProfile['3'].atMaxS < 12, JSON.stringify(G.byProfile['3']));
    assert.equal(GT.g21Change(G, 2, 1).to, 97);
    const b = res.measures.bailouts.filter(x => x.low); assert.equal(b.length, 1); assert.equal(b[0].log, 10);
    const d = res.measures.drift.filter(x => x.profile === 2).map(x => x.points), mean = d.reduce((s, x) => s + x, 0) / d.length;
    assert.ok(d.length >= 5 && mean > 4 && mean < 9, `drift at 4500 rpm ${d}`);
    const h = (p) => rowsOf(res, 'gov_headspeed', { topic: 'value', profile: p })[0].status;
    assert.equal(h(1), 'keep'); assert.equal(h(2), 'check'); assert.equal(h(3), 'check');
    const sp = rowsOf(res, 'gov_spoolup_time', { topic: 'value' })[0]; assert.equal(sp.status, 'check');
    assert.equal(rowsOf(res, 'gov_spoolup_time', { topic: 'unlogged' }).length, 1);
    assert.equal(rowsOf(res, 'gov_i_limit', { topic: 'value', profile: 1 })[0].status, 'check', 'the I-term at its limit after the BAILOUT of log 11');
    // the I-term period with its time, the throttle at its limit at the same time and the error (CLAUDE.md "Control limits")
    // with the seconds of the overlap: the throttle is at its maximum for 0.03 s of the 0.27 s I-term period (review 2026-10-15)
    const ip = rowsOf(res, 'gov_i_limit', { topic: 'value', profile: 1 })[0].evidence.find(e => e.log === 10 && isFinite(e.t0) && isFinite(e.t1) && /For ([\d.]+) s of this period, the throttle is also at its limit/.test(e.text));
    assert.ok(ip, 'the I-term period of log 11 with the throttle');
    const ov = +/For ([\d.]+) s of this period/.exec(ip.text)[1]; assert.ok(ov > 0 && ov < 0.1, `overlap ${ov} s`);
    // each period at the maximum throttle is evidence (40 in PID profile 2, 2 of them in a rescue)
    for (const p of [1, 2, 3]) { const n = res.measures.periods.filter(x => x.profile === p).length;
        assert.equal(rowsOf(res, 'gov_max_throttle', { topic: 'value', profile: p })[0].evidence.filter(e => /^Log \d+ at [\d.]+ s: /.test(e.text) && isFinite(e.t0)).length, n, `PID profile ${p}`); }
    // the throttle steps at the start of RECOVERY and BAILOUT: 2 in log 12 and 1 in log 15
    const m = rowsOf(res, 'gov_mode')[0]; assert.equal(m.evidence[0].value, 3); assert.match(m.evidence[0].text, /^In logs 12 and 15, the throttle changes in one step 3 times/);
    assert.ok(sp.evidence.filter(e => /in the air \(not in the rule\)/.test(e.text)).map(e => e.log).sort().join() === '13,14', 'the spool-ups in the air of the value at this time');
    // the drift: one value for each log, the loop gain and the F-term (critique C10)
    const bm = rowsOf(res, 'battery_meter')[0]; assert.match(bm.text, /for each 1 V decrease of the battery voltage \(6 logs\)/);
    assert.ok(bm.evidence.some(e => /loop gain of the governor decreases by/.test(e.text) && e.value > 0.07 && e.value < 0.12));
    // the values of PID profile 3 (never at the start of a log) from the CLI dump or unknown: flagged with the source
    for (const [n, by] of Object.entries(res.current.byName)) { const v = by[3]; if (v && (v.from === 'cli' || v.from === null)) assert.ok(v.stale && v.stale.reasons.includes('switched') && /The source of the value is/.test(v.stale.text), n); }
});

test('Gaui X4 II: no FALLBACK, a spool-up overshoot of less than 2 %, the yaw feedforward changes (critique C1)', { skip: !hasGaui && 'no analysis/governor-20261014/data/gaui' }, (t) => {
    const res = real('gaui');
    t.diagnostic(`\n${GT.table(res.rows)}`);
    assert.deepEqual(res.coverage.missing, []);
    assert.deepEqual(res.profiles, [1, 2, 3]);
    assert.equal(res.measures.fallbacks.length, 0);
    assert.equal(rowsOf(res, 'gov_spoolup_time', { topic: 'value' })[0].status, 'keep');
    assert.equal(rowsOf(res, 'freq_input_pull')[0].status, 'keep');
    assert.ok(rowsOf(res, 'gov_yaw_ff_weight', { topic: 'unlogged' }).length >= 1);
    // PID profiles 2 and 3: only the product changes (the weight is unknown there), and the other products show that the weight changes
    for (const p of [2, 3]) { const r = rowsOf(res, 'gov_yaw_ff_weight', { topic: 'unlogged:gov_yaw_ff_effective', profile: p });
        assert.equal(r.length, 1, `PID profile ${p}`); assert.match(r[0].text, /The other governor values show that "gov_yaw_ff_weight" changes/);
        assert.ok(res.recommendations.some(x => x.row === r[0].id && x.severity === 'check')); }
    // gov_gain and gov_f_gain come from the log header and do not change: no flag of the yaw product on them
    for (const name of ['gov_gain', 'gov_f_gain']) for (const p of [1, 2]) { const v = res.current.byName[name][p];
        assert.ok(!(v.stale && v.stale.flags.some(f => f.name === 'gov_yaw_ff_effective')), `${name} ${p}`); }
    assert.ok([1, 2, 3].every(p => rowsOf(res, 'gov_max_throttle', { topic: 'value', profile: p })[0].status === 'keep'), 'the Gaui never reaches its maximum throttle (critique C8)');
    assert.equal(rowsOf(res, 'battery_meter')[0].status, 'check', 'the voltage source is unknown (critique M10)');
});

// ---------------------------------------------------------------------------------------------
// STE: every text through lintText of test/ste_text.test.cjs (loaded in a vm context, without its tests)
// ---------------------------------------------------------------------------------------------

function steLinter() {
    const file = path.join(ROOT, 'test/ste_text.test.cjs'), src = fs.readFileSync(file, 'utf8');
    const stubs = { 'node:test': { test() {} }, 'node:worker_threads': { isMainThread: true, workerData: null } };
    const ctx = { require: (n) => stubs[n] || require(n), __dirname: path.dirname(file), __filename: file, module: { exports: {} }, process, console, Buffer, setTimeout, clearTimeout };
    vm.runInNewContext(`${src}\n;this.__ste = { lintText, loadVocabulary, FAILING };`, ctx, { filename: file });
    const S = ctx.__ste, L = S.loadVocabulary(JSON.parse(fs.readFileSync(path.join(ROOT, 'test/ste/vocabulary.json'), 'utf8')));
    return (text, kind) => S.lintText(text, kind, L).filter(h => S.FAILING.includes(h.check));
}
function textsOf(res, add) {
    for (const r of res.rows) {
        add(r.title, 'label', `${r.id} title`); add(r.text, 'message', r.id); add(r.reason, 'message', `${r.id} reason`); add(r.record, 'instruction', `${r.id} record`);
        for (const e of r.evidence) add(e.text, 'message', `${r.id} evidence`);
        if (r.stale) { add(r.stale.text, 'message', `${r.id} stale`); for (const f of r.stale.flags) add(f.text, 'message', `${r.id} flag`); }
        if (r.current && r.current.reason) add(r.current.reason, 'message', `${r.id} reason of the value`);
    }
    for (const x of res.recommendations) {
        add(x.title, 'label', x.id); add(x.text, 'message', x.id); add(x.rule, 'message', `${x.id} rule`);
        for (const c of x.caveats) add(c, 'note', `${x.id} caveat`);
        if (x.procedure) add(x.procedure.title, 'instruction', `${x.id} procedure`);
    }
    for (const n of res.notes) add(n, 'note', 'note');
    scriptTexts(res.recommendations, add);
}
// the comment lines of the CLI file of advice.exportScript
function scriptTexts(recs, add) {
    const script = ADV.exportScript(recs, recs.map(x => x.id), {});
    for (const line of script.split('\n')) { const m = /^\s*#+\s?(.*)$/.exec(line); if (m && /[A-Za-z]{2}/.test(m[1])) add(m[1], 'block', 'CLI file comment'); }
}
// every template of TEXT with sample arguments from the names of its parameters: each function must give one text. A title is a label;
// the parts of a sentence (TEXT.ramp, TEXT.terms.name) are linted in the sentences that use them
const TSAMPLE = { log: 11, t: 54.61, t1: 56.2, profile: 2, throttle: 0.688, calc: 0.689, ratio: 0.9, govI: 0.764, govF: 0.05, drop: 10, precomp: 'OFF', calcOn: 0.734, recovery: 0.649,
    recoveryCalc: 0.65, kmot: 5500, minShare: 0.77, belowS: 0.8, activeS: 1.2, withinS: 2.3, jump: 1051, jumpLimit: 1125, vbat: 22.1, throttleBefore: 1, satS: 0.3, coll: 0.6, atMax: true,
    share: 0.07, overshoot: 0.13, s: 1.2, state: 'ACTIVE', cause: 'load', rescue: true, others: ['govI', 'max'], minError: -0.05, maxError: 0.01, steps: [3, 0, 0, 0, 65], runsWith: 5, runs100: 49,
    med: 0.13, lo: 0.12, hi: 0.14, n: 2, slope: 3, se: 0.1, dv: 2.4, points: 7, pointsSe: 0.2, mean: 0.09, v0: 24.4, v1: 22.1, oneOverV: 7.9, byThrottle: true, airborne: true };
const ARGS = { f: [TSAMPLE, Object.assign({}, TSAMPLE, { atMax: false, precomp: 'ON', state: null, cause: null, rescue: false, others: [], minError: 0.02 })], b: [TSAMPLE], x: [TSAMPLE, 0.12], o: [TSAMPLE, ', in the air'],
    d: [TSAMPLE], g: [TSAMPLE], G: [TSAMPLE], k: [1, 3], m: [3, 'ESC'], n: [1, 3], j: [0, 2], s: [1.5, 'calculated from the log: a test', TSAMPLE], v: [22.4], u: [0.1], a: [2400], rate: [1200], R: [4500],
    A: [{ k: 6, N: 7, atMaxS: 23.4, belowS: 1473, share: 0.0156, p: 1.2e-10 }], L: [0.95, 20], mx: [0.95, 1], sh: [0.012], se: [0.004], lo: [10], hi: [25], h: [25], t: ['I-term'], tn: ['I-term'], name: ['gov_spoolup_time'], p: [2, null], vals: [['100 in log 6', '80 in logs 11 to 16'], ['10 in log 39', '30 in log 40', '80 in log 50']],
    logs: [[11, 14], [3]], l: [3], list: [['10 % (3 s)', '50 % (100 s)']], names: [['gov_gain', 'gov_f_gain', 'gov_yaw_ff_weight']], changed: [['gov_yaw_ff_weight'], []], c: [{ cli: 10, log: 20 }] };
function templates(obj, where, add) {
    for (const [k, v] of Object.entries(obj)) {
        const at = `${where}.${k}`, kind = /title$/i.test(k) ? 'label' : 'message';
        if (k === 'ramp' || k === 'name') continue;
        if (typeof v === 'string') add(v, kind, at);
        else if (typeof v === 'function') {
            const params = (/^\(?([^)=]*)\)?\s*=>/.exec(v.toString()) || [, ''])[1].split(',').map(q => q.trim().replace(/=.*$/, '').trim()).filter(Boolean);
            let combos = [[]]; for (const q of params) combos = combos.flatMap(c => (ARGS[q] || [TSAMPLE]).map(a => c.concat([a]))).slice(0, 24);
            let ok = 0;
            for (const c of combos) { let out; try { out = v(...c); } catch (e) { continue; } if (typeof out === 'string' && !/undefined|NaN|\[object/.test(out)) { ok++; add(out, kind, at); } }
            assert.ok(ok > 0, `${at}: no text from the sample arguments (${params.join(', ')})`);
        } else if (v && typeof v === 'object' && !Array.isArray(v)) templates(v, at, add);
    }
}
test('modelRunsOf: with the battery voltage in some flight logs only, the model uses the logs with the voltage (RUN.minVoltageLogs), the rules every log', () => {
    const run = (log, v, cls = 'flight', segment = 0) => ({ log, segment, class: cls, vbat: v ? Float32Array.of(24) : null });
    const all = [run(0, false, 'bench'), run(1, false), run(2, true), run(3, true), run(3, false, 'flight', 1), run(4, true)];
    const M = GT.modelRunsOf(all);
    assert.deepEqual([M.runs.map(r => [r.log, r.segment]), M.flights.map(r => r.log), M.left], [[[0, 0], [2, 0], [4, 0]], [2, 4], [1, 3]], 'a log with a part without the voltage is left out; the bench run stays');
    assert.equal(GT.AUTO.limits.noVoltageLogs(M.left), 'Logs 2 and 4 do not record the battery voltage. Thus, the governor model does not use these logs. The rules use all flight logs.');
    assert.equal(GT.AUTO.limits.noVoltageLogs([23]), 'Log 24 does not record the battery voltage. Thus, the governor model does not use this log. The rules use all flight logs.');
    // fewer logs with the voltage than RUN.minVoltageLogs, no log without it, or no voltage at all: every run (gov_fit leaves out the voltage: TEXT.mixedV)
    for (const runs of [[run(1, false), run(2, true)], [run(2, true), run(4, true)], [run(1, false), run(2, false)]]) {
        const X = GT.modelRunsOf(runs); assert.deepEqual([X.runs, X.left], [runs, []]);
    }
    assert.equal(GT.RUN.minVoltageLogs, 2);
});

test('twinPlots: the time plots of a test flight are in frame seconds with its log, and the logged governor states are bands with the state', () => {
    const run = { log: 4, segment: 1, time: [100.5, 101, 101.5], hs: [2000, 2010, 2005], hsClosed: [2001, 2008, 2004], hsOpen: [2002, 2007, 2006], target: [2000, 2000, 2000],
        u: [0.5, 0.52, 0.51], uClosed: [0.5, 0.51, 0.5], vbat: [24, 23.9, 23.8], vbatClosed: [24, 23.9, 23.8], vbatOpen: [24, 23.9, 23.7],
        bands: [{ x0: 100.5, x1: 100.9, state: 'SPOOLUP' }, { x0: 101.2, x1: 101.3, state: 'FALLBACK' }] };
    const P = GT.twinPlots({ runs: [run, Object.assign({}, run, { segment: 2, bands: [] })] });
    assert.deepEqual(P.map(q => q.id), ['twin-hs-4-1', 'twin-u-4-1', 'twin-v-4-1', 'twin-hs-4-2', 'twin-u-4-2', 'twin-v-4-2']);
    const hs = P[0];
    assert.deepEqual([hs.kind, hs.log, hs.series[0].x], ['time', 4, [100.5, 101, 101.5]], 'x is the time of plotData (frame seconds), the log for the seek');
    assert.deepEqual(hs.bands, [{ x0: 100.5, x1: 100.9, label: 'SPOOLUP', state: 'SPOOLUP' }, { x0: 101.2, x1: 101.3, label: 'FALLBACK', state: 'FALLBACK' }]);
    assert.ok(P.slice(0, 3).every(q => q.bands === hs.bands && q.note === `${GT.AUTO.plot.twinNote} ${GT.AUTO.plot.bandNote}`), 'the bands on each plot of the flight, and the note says what they are');
    assert.ok(P.slice(3).every(q => !('bands' in q) && q.note === GT.AUTO.plot.twinNote), 'no bands: no band note');
});

test('STE: every text of the rows, the recommendations, the CLI file comments, RULES and the model families', (t) => {
    let lint;
    try { lint = steLinter(); } catch (e) { t.skip(`lintText of test/ste_text.test.cjs is not available: ${e.message}`); return; }
    const seen = new Map(), add = (text, kind, where) => { if (typeof text === 'string' && text.trim() && !seen.has(`${kind}|${text}`)) seen.set(`${kind}|${text}`, { text, kind, where }); };
    for (const res of [tuneOf('esc', syn(), { cli: CLI_ESC }), tuneOf('nocli', syn(), {}), GT.tune([runC()], {})]) textsOf(res, add);
    // the modes NITRO, LIMIT, OFF or LIMIT and OFF, the voltage source ADC, a tail torque assist that is on, a product of gains that changes
    const rec0 = GP.recover(syn(), {}), set = (name, value) => Object.assign({}, rec0, { epochs: rec0.epochs.map(e => e.name === name ? Object.assign({}, e, { value, estimate: value }) : e) });
    textsOf(GT.tune(syn(), { recovered: set('gov_mode', 'NITRO') }), add);
    textsOf(GT.tune(syn(), { recovered: set('gov_tta_gain', 50), cli: CLI_ESC }), add);
    textsOf(GT.tune(syn(), { recovered: set('gov_tta_gain', 50) }), add);
    textsOf(GT.tune(syn(), { cli: '# dump all\nset battery_meter = ADC\nprofile 0\nset gov_use_voltage_comp = ON\nprofile 1\nset gov_use_voltage_comp = ON' }), add);
    const o = { omit: ['govI', 'govD', 'govF', 'govTarget', 'govRequest', 'govStateAt'], zero: ['govP', 'govSum'] }, lim = [limitRun(0, 0.9, o), limitRun(1, 0.9, o)];
    for (const cli of [null, '# dump all\nset gov_mode = LIMIT\nprofile 0\nset gov_max_throttle = 90', '# dump all\nset gov_mode = OFF']) textsOf(GT.tune(lim, { cli }), add);
    // the changes of the model rows: their recommendations and their CLI file comments
    const res = tuneOf('esc', syn(), { cli: CLI_ESC }), ctx = { num: (n) => n === 'gov_handover_throttle' ? 25 : null, profiles: [1, 2] }, changes = [];
    for (const [name, to] of [['gov_spoolup_time', 120], ['gov_p_gain', 45], ['gov_max_throttle', 20], ['gov_fallback_drop', 5]]) {
        const base = res.rows.find(r => r.name === name && (r.profile === null || r.profile === 1) && (r.topic === 'value' || r.topic === 'model'));
        for (const o2 of [{}, { profile: 0 }, { current: { value: null, source: 'unknown' } }]) changes.push(GT.toRecommendation(Object.assign({}, base, { status: 'change', to }, o2), ctx));
    }
    textsOf({ rows: [], recommendations: changes, notes: [] }, add);
    for (const craft of ['fireball', 'gaui']) if (fs.existsSync(path.join(DATA, craft, 'meta.json'))) textsOf(real(craft), add);
    for (const R of Object.values(GT.RULES)) if (R && R.text) add(R.text, 'message', 'RULES');
    for (const I of Object.values(GT.MODEL_INFO)) { add(I.text, 'message', 'MODEL_INFO'); for (const x of Object.values(I.textOf || {})) add(x, 'message', 'MODEL_INFO'); }
    templates(GT.TEXT, 'TEXT', add);
    for (const v of Object.values(GT.FAMILIES)) add(v, 'label', 'family');
    for (const v of Object.values(GT.NOTES)) add(v, 'note', 'NOTES');
    const bad = [];
    for (const { text, kind, where } of seen.values()) { const h = lint(text, kind); if (h.length) bad.push(`${where}: ${h.map(x => `${x.check} ${x.detail}`).join(', ')} | "${text.slice(0, 160)}"`); }
    t.diagnostic(`${seen.size} texts`);
    assert.deepEqual(bad, []);
});
