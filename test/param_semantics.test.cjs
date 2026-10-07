'use strict';

// Tests of tools/autotune/param_semantics.cjs: the table of what is in force for Rotorflight 4.6.* (RF-PARAM-1,
// Blackbox_Params_Spec.md 4.3): the seed rows of the spec, the PG of each journal key, the loader regions (3.6), the
// adjustment refreshes (4.3, with the fixes c3 and c4 of 3.11), the classic keys (4.4) and the consistency of the tables.
//
//   node --test test/param_semantics.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PS = require(path.resolve(__dirname, '../tools/autotune/param_semantics.cjs'));
const T = PS.forFirmware('Rotorflight 4.6.0 (118e912) STM32G47X', []);
const uses = (key, t = T) => { const r = t.classify(key); return r ? r.use.map(u => [u.by, u.loader || null, u.consumer || null]) : null; };

test('forFirmware: the 4.6 table for each 4.6 revision; another firmware has no rule, so every key is effect-unknown', () => {
    assert.equal(T.known, true);
    assert.equal(T.firmware, 'Rotorflight 4.6.*');
    assert.equal(PS.forFirmware('Rotorflight 4.6.2 (abcdef0) STM32F7X2', '-').known, true);
    for (const rev of ['Rotorflight 4.5.1 (x) T', 'Betaflight 4.6.0 (x) T', '', null]) {
        const t = PS.forFirmware(rev, []);
        assert.equal(t.known, false, String(rev));
        assert.equal(t.classify('p0.roll_p_gain'), null);
        assert.equal(t.pgOf('p0.roll_p_gain'), 14, 'the PG names come from the log and stay');
    }
    assert.deepEqual(PS.forFirmware('Rotorflight 4.6.0', 'c1,c3').fixes, ['c1', 'c3']);
});

test('the CLI names of the tracked PGs: 102 PID profile and 32 rate profile entries (spec 2.2)', () => {
    assert.equal(PS.NAMES[PS.PG.PID_PROFILE].split(' ').length, 102);
    assert.equal(PS.NAMES[PS.PG.CONTROL_RATE_PROFILES].split(' ').length, 32);
    const tracked = Object.values(PS.PG);
    for (const pg of Object.keys(PS.NAMES)) assert.ok(tracked.includes(+pg), `PG ${pg} is tracked`);
    const all = Object.values(PS.NAMES).flatMap(s => s.split(' '));
    assert.equal(new Set(all).size, all.length, 'each name once');
});

test('pgOfKey: the PG of each kind of journal key (2.4)', () => {
    const cases = [['p3.roll_p_gain', 14], ['r5.roll_rc_rate', 12], ['p0.error_limit[1]', 14], ['gov_mode', 1001], ['motor_poles', 6], ['pid_process_denom', 504],
        ['el.servo.7', 42], ['el.mixin.4', 1004], ['el.mixrule.1', 1003], ['el.rxfail.0', 43], ['el.feature', 19], ['pg.544+12', 544], ['pid_profile', 18],
        ['rate_profile', 18], ['gyro_rpm_notch_q_yaw[3]', 544], ['no_such_name', null], ['el.unknown.1', null]];
    for (const [key, pg] of cases) assert.equal(PS.pgOfKey(key), pg, key);
    assert.deepEqual(PS.slotOfKey('p4.gov_gain'), { kind: 'pid', slot: 4 });
    assert.deepEqual(PS.slotOfKey('r2.cyclic_ring'), { kind: 'rate', slot: 2 });
    assert.equal(PS.slotOfKey('gov_mode'), null);
});

test('the seed rows of spec 4.3', () => {
    assert.deepEqual(uses('p0.roll_p_gain'), [['loader', 'pid', 'pid']]);
    assert.deepEqual(uses('p5.yaw_b_cutoff'), [['loader', 'pid', 'pid']]);
    assert.deepEqual(uses('p1.offset_limit'), [['loader', 'pid', 'pid']]);
    assert.deepEqual(uses('p1.iterm_relax_cutoff'), [['loader', 'pid', 'pid']]);
    assert.deepEqual(uses('p1.yaw_inertia_precomp_cutoff'), [['loader', 'pid', 'pid']]);
    assert.deepEqual(uses('p1.cyclic_cross_coupling_ratio'), [['loader', 'pid', 'pid']]);
    assert.deepEqual(uses('p2.gov_headspeed'), [['loader', 'gov', 'pid']]);
    assert.deepEqual(T.classify('p2.gov_headspeed').use[0].also, ['pid']);
    assert.deepEqual(uses('p2.rescue_climb_collective'), [['loader', 'rsc', 'pid']]);
    assert.deepEqual(uses('p2.angle_level_strength'), [['loader', 'pid', 'pid']]);
    assert.deepEqual(uses('p2.acro_trainer_gain'), [['loader', 'pid', 'pid']]);
    assert.deepEqual(uses('r0.roll_rc_rate'), [['live', null, 'sp'], ['loader', 'sp', 'sp-ring']]);
    assert.deepEqual(uses('r0.rates_type'), [['live', null, 'sp'], ['loader', 'sp', 'sp-ring']]);
    for (const k of ['r0.roll_response', 'r0.yaw_accel_limit', 'r0.setpoint_boost_gain', 'r0.yaw_dynamic_deadband_filter', 'r0.cyclic_ring', 'r0.cyclic_polar'])
        assert.deepEqual(uses(k), [['loader', 'sp', 'sp']], k);
    assert.deepEqual(uses('gov_mode'), [['boot', null, 'pid']]);
    assert.deepEqual(uses('gov_spoolup_time'), [['boot', null, 'pid']]);
    assert.deepEqual(uses('debug_mode'), [['boot', null, null]]);
    assert.deepEqual(uses('pid_process_denom'), [['boot', null, null]]);
    assert.deepEqual(uses('filter_process_denom'), [['boot', null, null]]);
    assert.deepEqual(uses('el.servo.3'), [['live', null, 'mot']]);
    assert.deepEqual(T.classify('el.servo.3').fields, { 5: { by: 'boot' } }, 'the servo rate (field 5) is boot');
    for (const k of ['motor_poles', 'main_rotor_gear_ratio', 'tail_rotor_gear_ratio']) assert.deepEqual(uses(k), [['boot', null, null]], k);
    assert.deepEqual(uses('gyro_lpf1_static_hz'), [['loader', 'gyrof', 'filter']]);
    assert.deepEqual(uses('gyro_notch2_cutoff'), [['loader', 'gyrof', 'filter']]);
    assert.deepEqual(uses('gyro_hardware_lpf'), [['boot', null, null]]);
    assert.deepEqual(uses('gyro_rpm_notch_center_roll'), [['loader', 'rpmf', 'filter']]);
    assert.deepEqual(uses('swash_ring'), [['loader', 'mix', 'mix']]);
    assert.deepEqual(uses('rc_center'), [['live', null, 'rx']]);
    for (const k of ['deadband', 'yaw_deadband', 'rc_deflection', 'rc_min_throttle', 'rc_max_throttle']) assert.deepEqual(uses(k), [['loader', 'act', 'rx']], k);
    assert.deepEqual(uses('acc_trim_roll'), [['live', null, 'acc']]);
    assert.deepEqual(uses('el.feature'), [['loader', 'feat', 'mask'], ['boot', null, 'subsystems']]);
    // anything else is effect-unknown
    for (const k of ['failsafe_delay', 'pg.18+0', 'blackbox_mode', 'el.rxfail.2', 'swash_type', 'p0.profile_name']) assert.equal(T.classify(k), null, k);
});

test('every rule is valid: known loaders and use kinds, evidence text, and a match for at least one key of the tables', () => {
    const keys = [...PS.NAMES[PS.PG.PID_PROFILE].split(' ').map(n => `p0.${n}`), ...PS.NAMES[PS.PG.CONTROL_RATE_PROFILES].split(' ').map(n => `r0.${n}`),
        ...Object.entries(PS.NAMES).filter(([pg]) => +pg !== PS.PG.PID_PROFILE && +pg !== PS.PG.CONTROL_RATE_PROFILES).flatMap(([, s]) => s.split(' ')),
        'el.servo.0', 'el.mixin.0', 'el.mixrule.0', 'el.feature', 'pid_profile', 'rate_profile'];
    for (const r of PS.KEYS_46) {
        assert.ok(typeof r.src === 'string' && r.src.length > 5, String(r.match));
        for (const u of r.use.concat(Object.values(r.fields || {}))) {
            assert.ok(['live', 'loader', 'boot'].includes(u.by), String(r.match));
            if (u.by === 'loader') { assert.ok(PS.LOADERS[u.loader], u.loader); for (const a of u.also || []) assert.ok(PS.LOADERS[a], a); }
        }
        assert.ok(keys.some(k => r.match.test(k)), `${r.match} matches no key`);
    }
    // the profile keys of the PID rules are PID profile names, the rate rules rate profile names
    for (const k of keys) { const r = T.classify(k); if (r && /^p0\./.test(k)) assert.ok(r.use.every(u => u.by !== 'loader' || PS.LOADERS[u.loader].slot !== 'rate'), k); }
});

test('adjustments (4.3): refreshed fields per function, with the fixes c3 and c4', () => {
    const A = T.adjustments;
    assert.deepEqual(A[76].refresh, ['gov_idle_throttle', 'gov_auto_throttle']);
    assert.deepEqual(A[77].refresh, ['gov_idle_throttle', 'gov_auto_throttle']);
    for (const f of [68, 69, 70, 71]) assert.deepEqual(A[f].refresh, [], `${f}: setpoint boost refreshes nothing`);
    assert.deepEqual([A[72].refresh, A[73].refresh, A[74].refresh], [['yaw_dynamic_ceiling_gain'], ['yaw_dynamic_deadband_gain'], ['yaw_dynamic_deadband_filter']]);
    for (let f = 5; f <= 13; f++) { assert.deepEqual(A[f].refresh, [], `${f}: rates refresh nothing`); assert.equal(A[f].applies, undefined); }
    assert.deepEqual([A[1].refresh, A[2].refresh], [[], []], 'profile changes bring their own A records');
    const fixed = PS.forFirmware('Rotorflight 4.6.0', ['c3', 'c4']);
    for (const f of [68, 69, 70, 71]) assert.deepEqual(fixed.adjustments[f].refresh, ['setpoint_boost_gain']);
    for (let f = 5; f <= 13; f++) assert.equal(fixed.adjustments[f].applies, 'sp');
    assert.deepEqual(T.adjustments[68].refresh, [], 'the fixes do not change the table without them');
    // the slot of the record: the setter writes the current profile
    assert.equal(T.adjustmentRefreshes(18, 'p2.roll_p_gain', 'p2.roll_p_gain'), true);
    assert.equal(T.adjustmentRefreshes(18, 'p1.roll_p_gain', 'p2.roll_p_gain'), false);
    assert.equal(T.adjustmentRefreshes(18, 'p2.roll_i_gain', 'p2.roll_p_gain'), false);
    assert.equal(T.adjustmentRefreshes(76, 'gov_auto_throttle', 'gov_idle_throttle'), true);
    assert.equal(T.adjustmentRefreshes(61, 'p0.cyclic_cross_coupling_ratio', 'p0.cyclic_cross_coupling_gain'), true);
    assert.equal(fixed.adjustmentRefreshes(69, 'r3.setpoint_boost_gain', 'r3.setpoint_boost_gain[0]'), true);
    // every refreshed name is a CLI name of its scope
    const pidNames = PS.NAMES[PS.PG.PID_PROFILE].split(' '), rateNames = PS.NAMES[PS.PG.CONTROL_RATE_PROFILES].split(' ');
    for (const [f, a] of Object.entries(fixed.adjustments)) for (const n of a.refresh)
        assert.ok(a.scope === 'p' ? pidNames.includes(n) : a.scope === 'r' ? rateNames.includes(n) : PS.pgOfKey(n) !== null, `${f}: ${n}`);
});

test('loader regions (3.6): the PGs that each loader reads, with the slot of the A record', () => {
    assert.equal(T.readsRegion('pid', 'p0.roll_p_gain', 0), true);
    assert.equal(T.readsRegion('pid', 'p1.roll_p_gain', 0), false);
    for (const k of ['gov_mode', 'motor_poles', 'pid_process_denom', 'debug_mode']) assert.equal(T.readsRegion('pid', k, 0), true, k);
    assert.equal(T.readsRegion('pid', 'r0.roll_rc_rate', 0), false);
    assert.equal(T.readsRegion('sp', 'r1.roll_rc_rate', 1), true);
    assert.equal(T.readsRegion('sp', 'r1.roll_rc_rate', 2), false);
    assert.equal(T.readsRegion('act', 'p3.roll_p_gain', null), true);
    assert.equal(T.readsRegion('act', 'pg.18+0', null), true, 'act reads all tracked PGs');
    assert.equal(T.readsRegion('act', 'pg.9999+0', null), false, 'not a tracked PG');
    assert.equal(T.readsRegion('feat', 'el.feature', null), true);
    assert.equal(T.readsRegion('feat', 'deadband', null), false);
    assert.equal(T.readsRegion('nope', 'deadband', null), false);
    assert.equal(T.appliedBy('pid', 'p0.gov_headspeed'), true);
    assert.equal(T.appliedBy('gov', 'p0.yaw_p_gain'), false);
    assert.equal(T.appliedBy('sp', 'r0.roll_rc_rate'), true);
});

test('classic keys (4.4): every source is a CLI name of its section, and each lookup table exists', () => {
    const pidNames = PS.NAMES[PS.PG.PID_PROFILE].split(' '), rateNames = PS.NAMES[PS.PG.CONTROL_RATE_PROFILES].split(' ');
    const rt = ['looptime', 'pid_denom', 'filter_denom', 'debug_mode'];
    for (const [key, sources] of T.classic) for (const s of sources) {
        if (s.p) assert.ok(pidNames.includes(s.p), `${key}: ${s.p}`);
        else if (s.r) assert.ok(rateNames.includes(s.r), `${key}: ${s.r}`);
        else if (s.m || s.boot) assert.notEqual(PS.pgOfKey(s.m || s.boot), null, `${key}: ${s.m || s.boot}`);
        else if (s.rt) { assert.ok(rt.includes(s.rt), `${key}: ${s.rt}`); if (s.div) assert.ok(rt.includes(s.div), `${key}: ${s.div}`); }
        else assert.ok(s.el || s.feature, key);
        if (s.lookup) assert.ok(Array.isArray(PS.LOOKUPS[s.lookup]), s.lookup);
    }
    const names = T.classic.map(c => c[0]);
    for (const k of ['rollPID', 'pitchPID', 'yawPID', 'govPID', 'rc_rates', 'rc_expo', 'rates', 'response_time', 'accel_limit', 'collectiveRange', 'debug_mode'])
        assert.ok(names.includes(k), k);
    assert.deepEqual(T.classic.find(c => c[0] === 'rollPID')[1], ['p', 'i', 'd', 'f', 'b'].map(x => ({ p: `roll_${x}_gain` })));
    assert.deepEqual(T.classic.find(c => c[0] === 'govPID')[1].map(s => s.p), ['gov_p_gain', 'gov_i_gain', 'gov_d_gain', 'gov_f_gain', 'gov_gain']);
    assert.equal(PS.LOOKUPS.RATES_TYPE.indexOf('ROTORFLIGHT'), 6);
    // the classic looptime is gyro.sampleLooptime (blackbox.c:1695); param_rt looptime is gyro.targetLooptime = pid_denom times it
    assert.deepEqual(T.classic.find(c => c[0] === 'looptime')[1], [{ rt: 'looptime', div: 'pid_denom' }]);
});
