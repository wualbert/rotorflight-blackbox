'use strict';

// Tests of tools/autotune/datasets.cjs (SPEC3 J): the classification of every Rotorflight 4.6 setting and log header name,
// datasets (one PID profile and one exact set of the values that change the flight), the labels of each log stretch, the
// table of the parameters that are not the same, and the A/B comparisons and slopes with their uncertainty.
//
//   node --test test/datasets.test.cjs
//   AUTOTUNE_REAL_LOG=<Gaui X4 dump RTFL_BLACKBOX_LOG_20261004_113720.BBL> DATASETS_FB1005=<fb1005.bbl>
//   DATASETS_FB0929=<fireball_0929_3.bbl> DATASETS_FB0929_CLI=<fireball_cli_dump.txt> node --max-old-space-size=8000 --test test/datasets.test.cjs
//     also the real logs (read only): each variable that is not set skips its test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const REPO = path.resolve(__dirname, '..'), FILE = path.join(REPO, 'tools/autotune/datasets.cjs');
const DS = require(FILE);
const within = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} ± ${tol}`);

// ---- fixtures ----------------------------------------------------------------------------------------------------------

// A 4.6.0 log header as FlightLog.getSysConfig() gives it (own keys): the values of the Fireball fb1005 log 6 (index 5)
function header(over = {}) {
    const h = {
        Product: 'Blackbox flight data recorder by Nicholas Sherlock', firmwareType: 5, firmware: '4.6', firmwarePatch: 0, firmwareVersion: '4.6.0',
        'Firmware revision': 'Rotorflight 4.6.0 (118e912) STM32G47X', 'Firmware date': 'Jun 30 2026 07:21:46', 'Board information': 'MTKS MATEKG474HELI',
        'Log start datetime': '2026-10-04T18:22:19.488+00:00', 'Craft name': 'SAB Fireball', frameIntervalI: 32, frameIntervalPNum: 1, frameIntervalPDenom: 1,
        features: 1543504904, gyroScale: 1, acc_1G: 2048, vbatscale: 110, vbatmincellvoltage: 330, vbatwarningcellvoltage: 350, vbatmaxcellvoltage: 430, vbatref: 2520,
        currentMeterOffset: 0, currentMeterScale: 400, looptime: 500, gyro_sync_denom: 1, pid_process_denom: 2, filter_process_denom: 2, rates_type: 6,
        rc_rates: [50, 50, 80], rc_expo: [25, 25, 33], rates: [12, 12, 12], response_time: [0, 0, 0], accel_limit: [0, 0, 0],
        rollPID: [50, 100, 15, 100, 25], pitchPID: [90, 100, 38, 100, 70], yawPID: [65, 120, 12, 10, 10], levelPID: [40, 55, 40, 75], govPID: [18, 60, 2, 32, 55],
        rollBW: [80, 35, 35], pitchBW: [80, 35, 35], yawBW: [200, 40, 40], iterm_relax_type: 2, iterm_relax_cutoff: [18, 18, 14], error_limit: [45, 45, 50],
        error_decay: [150, 12], error_decay_ground: 25, cyclic_coupling: [60, 0, 30], yaw_stop_gain: [110, 80], yaw_precomp: [5, 10, 70], yaw_inertia_precomp: [0, 25],
        yaw_tta: [0, 20], hsi_gain: [32, 32], hsi_limit: [80, 80], pitch_compensation: 0, deadband: 5, yaw_deadband: 5, gyro_to_use: 0, gyro_lpf: 0, gyro_soft_type: 0,
        gyro_lowpass_hz: 0, gyro_lowpass_dyn_hz: [0, 0], gyro_soft2_type: 0, gyro_lowpass2_hz: 50, gyro_notch_hz: [0, 0], gyro_notch_cutoff: [0, 0],
        dyn_notch_count: 6, dyn_notch_q: 25, dyn_notch_min_hz: 20, dyn_notch_max_hz: 240, dshot_bidir: 0, gyro_rpm_notch_preset: 1, gyro_rpm_notch_min_hz: 20,
        gyro_rpm_notch_source_pitch: [11, 12, 14, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], gyro_rpm_notch_center_pitch: new Array(16).fill(0),
        gyro_rpm_notch_q_pitch: [80, 40, 60, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], gyro_rpm_notch_source_roll: [11, 12, 14, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        gyro_rpm_notch_center_roll: new Array(16).fill(0), gyro_rpm_notch_q_roll: [80, 40, 60, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        gyro_rpm_notch_source_yaw: [11, 12, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], gyro_rpm_notch_center_yaw: new Array(16).fill(0),
        gyro_rpm_notch_q_yaw: [80, 40, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], acc_lpf_hz: 1000, acc_hardware: 0, baro_hardware: 0, mag_hardware: 0,
        gyro_cal_on_first_arm: 0, serialrx_provider: 9, unsynced_fast_pwm: 1, fast_pwm_protocol: 0, motor_pwm_rate: 250, minthrottle: 1100, maxthrottle: 1940,
        collectiveRange: [-1250, 1250], debug_mode: 0, debug_axis: 0, fields_mask: 4714111, unknownHeaders: [{ name: 'gyro_decimation_hz', value: '500' }],
    };
    for (const [k, v] of Object.entries(over)) { if (v === undefined) delete h[k]; else h[k] = v; }
    return h;
}
// one log: runs as [[t0, t1, profile], ...], flights as [[t0, t1], ...]
const log = (i, h, { arming = 0, runs = [[0, 100, 0]], flights = [[10, 90]], rate = [], adj = [], estimate } = {}) => ({
    log: i, header: h, armingProfile: arming, armingEstimate: estimate, profileRuns: runs.map(([t0, t1, p]) => ({ t0, t1, profile: p })),
    flights: flights.map(([t0, t1]) => ({ t0, t1 })), rateChanges: rate.map(([t, p]) => ({ t, profile: p })), adjustments: adj.map(([t, func, value]) => ({ t, func, value })) });
const byId = (ds, id) => ds.datasets.find(d => d.id === id);
const labelsOf = (ds, l) => ds.labels.filter(x => x.log === l).map(x => `${x.t0}-${x.t1}:${x.dataset}`).join(' ');

// a CLI dump of 4.6.0 with the values of the fixture header in `profile 0` (PID profile 1) and `rateprofile 0`
function cliText({ kind = 'dump', craft = 'SAB Fireball', yaw = [65, 120, 12], p1 = null, extra = '' } = {}) {
    const prof = (ix, y) => `profile ${ix}\n\n# profile ${ix}\nset profile_name = -\nset pid_mode = 3\nset roll_p_gain = 50\nset roll_i_gain = 100\nset roll_d_gain = 15\nset roll_f_gain = 100\nset roll_b_gain = 25\n` +
        `set pitch_p_gain = 90\nset pitch_i_gain = 100\nset pitch_d_gain = 38\nset pitch_f_gain = 100\nset pitch_b_gain = 70\nset yaw_p_gain = ${y[0]}\nset yaw_i_gain = ${y[1]}\nset yaw_d_gain = ${y[2]}\n` +
        'set yaw_f_gain = 10\nset yaw_b_gain = 10\nset roll_o_gain = 32\nset pitch_o_gain = 32\nset roll_gyro_cutoff = 80\nset roll_d_cutoff = 35\nset roll_b_cutoff = 35\n' +
        'set pitch_gyro_cutoff = 80\nset pitch_d_cutoff = 35\nset pitch_b_cutoff = 35\nset yaw_gyro_cutoff = 200\nset yaw_d_cutoff = 40\nset yaw_b_cutoff = 40\n' +
        'set yaw_cw_stop_gain = 110\nset yaw_ccw_stop_gain = 80\nset yaw_precomp_cutoff = 5\nset yaw_cyclic_ff_gain = 10\nset yaw_collective_ff_gain = 70\n' +
        'set yaw_inertia_precomp_gain = 0\nset yaw_inertia_precomp_cutoff = 25\nset pitch_collective_ff_gain = 0\nset cyclic_cross_coupling_gain = 60\n' +
        'set cyclic_cross_coupling_ratio = 0\nset cyclic_cross_coupling_cutoff = 30\nset error_limit = 45,45,50\nset offset_limit = 80,80\nset error_decay_time_ground = 25\n' +
        'set error_decay_time_cyclic = 150\nset error_decay_limit_cyclic = 12\nset iterm_relax_type = RPY\nset iterm_relax_cutoff = 18,18,14\nset rescue_mode = CLIMB\n' +
        'set gov_headspeed = 1800\nset gov_gain = 55\nset gov_p_gain = 18\nset gov_i_gain = 60\nset gov_d_gain = 2\nset gov_f_gain = 32\nset gov_tta_gain = 0\nset gov_tta_limit = 20\n' +
        'set angle_level_strength = 40\nset angle_level_limit = 55\nset horizon_level_strength = 40\nset horizon_transition = 75\n';
    return `# ${kind}\n\n# version\n# Rotorflight / STM32G47X (SG47) 4.6.0 Jun 30 2026 / 07:21:46 (118e912) MSP API: 12.9\n\n# name: ${craft}\n\n` +
        'feature -RX_PPM\nfeature -ESC_SENSOR\nfeature RX_SERIAL\nfeature TELEMETRY\nfeature GOVERNOR\nfeature ESC_SENSOR\nfeature FREQ_SENSOR\nfeature RPM_FILTER\n' +
        'servo 1 1500 -700 700 500 500 333 0 2\nmixer input SC -1250 1250 1070\nmixer input SY -1833 1046 570\n\n# master\n' +
        'set gyro_hardware_lpf = NORMAL\nset gyro_lpf1_type = NONE\nset gyro_lpf1_static_hz = 0\nset gyro_lpf2_type = NONE\nset gyro_lpf2_static_hz = 50\n' +
        'set dyn_notch_count = 6\nset dyn_notch_q = 25\nset dyn_notch_min_hz = 20\nset dyn_notch_max_hz = 240\nset serialrx_provider = CRSF\nset motor_pwm_protocol = PWM\n' +
        'set use_unsynced_pwm = ON\nset motor_pwm_rate = 250\nset min_throttle = 1100\nset max_throttle = 1940\nset pid_process_denom = 2\nset filter_process_denom = 0\n' +
        'set gov_mode = DIRECT\nset swash_type = CP120\nset swash_phase = 0\nset vbat_scale = 110\nset deadband = 5\nset yaw_deadband = 5\n' + extra +
        prof(0, yaw) + (p1 ? prof(1, p1) : '') + `\nrateprofile 0\n\n# rateprofile 0\nset rates_type = ROTORFLIGHT\nset roll_rc_rate = 50\nset pitch_rc_rate = 50\nset yaw_rc_rate = 80\n` +
        'set roll_expo = 25\nset pitch_expo = 25\nset yaw_expo = 33\nset roll_srate = 12\nset pitch_srate = 12\nset yaw_srate = 12\nset setpoint_boost_gain = 30,30,60,0\n';
}

// ---- 1. The classification table ---------------------------------------------------------------------------------------

// settings.c of 4.6.0 in the repository's analysis copies (untracked: the part skips without one)
const SETTINGS_C = ['analysis/gaui-x4/20261004_233406/verify/PWR-CURRENT-TEMP/fw460/settings.c', 'analysis/gaui-x4/verify/SETUP-VBAT_confound/fw/settings.c']
    .map(p => path.join(REPO, p)).find(p => fs.existsSync(p));
const PARAM_NAME = { PARAM_NAME_GYRO_TO_USE: 'gyro_to_use', PARAM_NAME_GYRO_HARDWARE_LPF: 'gyro_hardware_lpf', PARAM_NAME_GYRO_DECIMATION_HZ: 'gyro_decimation_hz',
    PARAM_NAME_GYRO_LPF1_TYPE: 'gyro_lpf1_type', PARAM_NAME_GYRO_LPF1_STATIC_HZ: 'gyro_lpf1_static_hz', PARAM_NAME_GYRO_LPF2_TYPE: 'gyro_lpf2_type', PARAM_NAME_GYRO_LPF2_STATIC_HZ: 'gyro_lpf2_static_hz',
    PARAM_NAME_DYN_NOTCH_COUNT: 'dyn_notch_count', PARAM_NAME_DYN_NOTCH_Q: 'dyn_notch_q', PARAM_NAME_DYN_NOTCH_MIN_HZ: 'dyn_notch_min_hz', PARAM_NAME_DYN_NOTCH_MAX_HZ: 'dyn_notch_max_hz',
    PARAM_NAME_ACC_HARDWARE: 'acc_hardware', PARAM_NAME_ACC_LPF_HZ: 'acc_lpf_hz', PARAM_NAME_MAG_HARDWARE: 'mag_hardware', PARAM_NAME_BARO_HARDWARE: 'baro_hardware',
    PARAM_NAME_SERIAL_RX_PROVIDER: 'serialrx_provider', PARAM_NAME_DSHOT_BIDIR: 'dshot_bidir', PARAM_NAME_USE_UNSYNCED_PWM: 'use_unsynced_pwm', PARAM_NAME_MOTOR_PWM_PROTOCOL: 'motor_pwm_protocol',
    PARAM_NAME_MOTOR_PWM_RATE: 'motor_pwm_rate', PARAM_NAME_RATES_TYPE: 'rates_type', PARAM_NAME_PID_PROCESS_DENOM: 'pid_process_denom', PARAM_NAME_FILTER_PROCESS_DENOM: 'filter_process_denom',
    PARAM_NAME_DEBUG_MODE: 'debug_mode', PARAM_NAME_DEBUG_AXIS: 'debug_axis' };
function settingsOf(file) { // [{ name, mode: PROFILE | RATE | MASTER }] of valueTable
    const src = fs.readFileSync(file, 'utf8'), body = src.slice(src.indexOf('const clivalue_t valueTable[] = {')), out = [];
    for (const line of body.slice(0, body.indexOf('\n};')).split('\n')) {
        const m = /^\s*\{\s*(?:"([^"]+)"|(PARAM_NAME_\w+))\s*,\s*VAR_/.exec(line); if (!m) continue;
        out.push({ name: m[1] || PARAM_NAME[m[2]], mode: /PROFILE_RATE_VALUE/.test(line) ? 'RATE' : /PROFILE_VALUE/.test(line) ? 'PROFILE' : 'MASTER' });
    }
    return out;
}

test('1a every setting of 4.6.0 settings.c has one group and the scope of settings.c', { skip: !SETTINGS_C && 'no copy of settings.c in analysis/' }, () => {
    const all = settingsOf(SETTINGS_C);
    assert.equal(all.length, 727, 'valueTable of 4.6.0 has 727 settings');
    assert.ok(all.every(s => s.name), 'every PARAM_NAME macro is known to the test');
    const unknown = all.filter(s => !DS.classify(s.name).known).map(s => s.name);
    assert.deepEqual(unknown, [], 'every setting is in the table');
    for (const s of all) assert.equal(DS.scopeOf(s.name), s.mode === 'PROFILE' ? 'profile' : s.mode === 'RATE' ? 'rate' : 'global', `scope of ${s.name}`);
    // the table holds no name that 4.6.0 does not have, except the header-only names, the feature bits and the 4.4 names
    const names = new Set(all.map(s => s.name)), extra = DS.GROUPS.flatMap(g => g.names).filter(n => !names.has(n));
    const allowed = /^(feature |Firmware |Board |Craft |Product|Data version|Log start|firmware|gyroScale|acc_1G|vbatref|looptime|gyro_sync_denom|fields_mask|frameInterval|map$|yaw_precomp_impulse|piro_compensation|gyro_rpm_filter_bank_)/;
    assert.deepEqual(extra.filter(n => !allowed.test(n)), [], 'names out of settings.c');
});

test('1b the table: no name in two groups, the counts, examples of each class', () => {
    const seen = new Map(); for (const g of DS.GROUPS) for (const n of g.names) { assert.ok(!seen.has(n), `${n} in ${seen.get(n)} and ${g.id}`); seen.set(n, g.id); }
    const rows = DS.table();
    assert.equal(rows.filter(r => !r.pattern).length, seen.size);
    assert.ok(DS.GROUPS.every(g => typeof g.flight === 'boolean' && g.reason && g.title), 'each group has a class, a title and a reason');
    const want = { yaw_cw_stop_gain: ['stop', true], 'error_limit[2]': ['iterm', true], gov_tta_gain: ['tta', true], swash_tta_precomp: ['tta', true], gov_headspeed: ['governor', true],
        gov_mode: ['governor', true], gyro_lpf1_static_hz: ['filters', true], 'gyro_rpm_notch_q_yaw[3]': ['filters', true], roll_srate: ['rates', true], setpoint_boost_gain: ['rates', true],
        swash_phase: ['mixer', true], 'servo 3 rate': ['mixer', true], 'mixer input SC min': ['mixer', true], 'mixer rule 0': ['mixer', true], motor_poles: ['rpmSignal', true],
        main_rotor_gear_ratio: ['rpmSignal', true], 'feature GOVERNOR': ['governor', true], 'feature RPM_FILTER': ['filters', true], 'Firmware revision': ['firmware', true],
        looptime: ['loop', true], align_board_yaw: ['alignment', true], vbat_scale: ['batteryVoltage', true], rc_smoothness: ['rcInput', true],
        rescue_mode: ['rescue', false], gps_rescue_angle: ['rescue', false], angle_level_strength: ['levelModes', false], blackbox_rate_denom: ['blackbox', false],
        debug_mode: ['blackbox', false], osd_vbat_pos: ['display', false], 'feature OSD': ['display', false], 'feature LED_STRIP': ['display', false], beeper_frequency: ['display', false],
        tlm_inverted: ['telemetry', false], 'feature TELEMETRY': ['telemetry', false], failsafe_delay: ['failsafe', false], auto_disarm_delay: ['arming', false],
        vbat_warning_cell_voltage: ['battery', false], name: ['names', false], 'Craft name': ['names', false], vbatref: ['logFacts', false], acc_lpf_hz: ['attitude', false],
        gyro_1_spibus: ['hardware', false], box_user_1_name: ['modes', false], something_new: ['unknown', true], 'adjustment 30': ['unknown', true] };
    for (const [n, [g, f]] of Object.entries(want)) { const c = DS.classify(n); assert.equal(c.group, g, `group of ${n}`); assert.equal(c.flight, f, `class of ${n}`); }
    assert.equal(DS.classify('something_new').known, false);
    const counts = DS.groups(); assert.equal(counts.find(g => g.id === 'unknown').flight, true);
});

// The names that 4.6.0 writes in the log header (blackbox.c:1598-1779), as js/flightlog_parser.js stores them (translated)
const HEADER_KEYS_46 = ['Product', 'firmwareType', 'firmware', 'firmwarePatch', 'firmwareVersion', 'Firmware revision', 'Firmware date', 'Board information', 'Log start datetime',
    'Craft name', 'frameIntervalI', 'frameIntervalPNum', 'frameIntervalPDenom', 'features', 'gyroScale', 'acc_1G', 'vbatscale', 'vbatmincellvoltage', 'vbatwarningcellvoltage',
    'vbatmaxcellvoltage', 'vbatref', 'currentMeterOffset', 'currentMeterScale', 'looptime', 'gyro_sync_denom', 'pid_process_denom', 'filter_process_denom', 'rates_type', 'rc_rates',
    'rc_expo', 'rates', 'response_time', 'accel_limit', 'rollPID', 'pitchPID', 'yawPID', 'levelPID', 'govPID', 'rollBW', 'pitchBW', 'yawBW', 'iterm_relax_type', 'iterm_relax_cutoff',
    'error_limit', 'error_decay', 'error_decay_ground', 'cyclic_coupling', 'yaw_stop_gain', 'yaw_precomp', 'yaw_inertia_precomp', 'yaw_tta', 'hsi_gain', 'hsi_limit', 'pitch_compensation',
    'deadband', 'yaw_deadband', 'gyro_to_use', 'gyro_lpf', 'gyro_soft_type', 'gyro_lowpass_hz', 'gyro_lowpass_dyn_hz', 'gyro_soft2_type', 'gyro_lowpass2_hz', 'gyro_notch_hz',
    'gyro_notch_cutoff', 'dyn_notch_count', 'dyn_notch_q', 'dyn_notch_min_hz', 'dyn_notch_max_hz', 'dshot_bidir', 'gyro_rpm_notch_preset', 'gyro_rpm_notch_min_hz',
    'gyro_rpm_notch_source_pitch', 'gyro_rpm_notch_center_pitch', 'gyro_rpm_notch_q_pitch', 'gyro_rpm_notch_source_roll', 'gyro_rpm_notch_center_roll', 'gyro_rpm_notch_q_roll',
    'gyro_rpm_notch_source_yaw', 'gyro_rpm_notch_center_yaw', 'gyro_rpm_notch_q_yaw', 'acc_lpf_hz', 'acc_hardware', 'baro_hardware', 'mag_hardware', 'gyro_cal_on_first_arm',
    'serialrx_provider', 'unsynced_fast_pwm', 'fast_pwm_protocol', 'motor_pwm_rate', 'minthrottle', 'maxthrottle', 'collectiveRange', 'debug_mode', 'debug_axis', 'fields_mask'];

test('1c every header name of 4.6.0 maps to known parameters, and the values have the CLI names and units', () => {
    const h = header();
    assert.deepEqual(HEADER_KEYS_46.filter(k => !(k in h)), [], 'the fixture has every 4.6.0 header key');
    const { values: v, unknown } = DS.headerValues(h);
    assert.deepEqual(unknown, []);
    for (const n of Object.keys(v)) assert.ok(DS.classify(n).known, `${n} is in the table`);
    assert.deepEqual([v.roll_p_gain, v.roll_i_gain, v.roll_d_gain, v.roll_f_gain, v.roll_b_gain], [50, 100, 15, 100, 25]);
    assert.deepEqual([v.yaw_cw_stop_gain, v.yaw_ccw_stop_gain, v.gov_tta_gain, v.gov_tta_limit], [110, 80, 0, 20]);
    assert.deepEqual([v.roll_o_gain, v['offset_limit[1]'], v['error_limit[2]'], v['iterm_relax_cutoff[2]']], [32, 80, 50, 14]);
    assert.deepEqual([v.gyro_lpf1_type, v.gyro_lpf2_static_hz, v.gyro_hardware_lpf, v.gyro_decimation_hz], [0, 50, 0, 500]);
    assert.deepEqual([v['gyro_rpm_notch_source_yaw[2]'], v['gyro_rpm_notch_q_roll[1]'], v['mixer input SC min'], v['mixer input SC max']], [21, 40, -1250, 1250]);
    assert.deepEqual([v.pitch_collective_ff_gain, v.yaw_collective_ff_gain, v.yaw_expo, v.yaw_rc_rate, v.min_throttle, v.use_unsynced_pwm], [0, 70, 33, 80, 1100, 1]);
    assert.equal(v.acc_lpf_hz, 10, 'the header records acc_lpf_hz x 100 (blackbox.c:1759)');
    // features 1543504904: RX_SERIAL, TELEMETRY, GOVERNOR, ESC_SENSOR, FREQ_SENSOR, RPM_FILTER
    assert.deepEqual(['RX_SERIAL', 'TELEMETRY', 'GOVERNOR', 'ESC_SENSOR', 'FREQ_SENSOR', 'RPM_FILTER', 'OSD', 'DYN_NOTCH'].map(f => v[`feature ${f}`]), [true, true, true, true, true, true, false, false]);
    assert.equal(v['feature other bits'], 0);
    assert.equal(DS.scopeOf('roll_p_gain'), 'profile'); assert.equal(DS.scopeOf('yaw_expo'), 'rate'); assert.equal(DS.scopeOf('gyro_lpf2_static_hz'), 'global');
    // a key that the table does not know: listed, and a parameter that changes the flight
    const u = DS.headerValues(header({ new_thing: [1, 2], unknownHeaders: [{ name: 'gyro_decimation_hz', value: '500' }, { name: 'odd_value', value: '3' }] }));
    assert.deepEqual(u.unknown.sort(), ['new_thing', 'odd_value']);
    assert.equal(u.values['new_thing[1]'], 2); assert.equal(DS.isFlight('new_thing[1]'), true);
});

// ---- 2. The CLI dump ---------------------------------------------------------------------------------------------------

test('2a parseCli and cliValues: sections, lookup values, arrays, features, mixer, servos, craft name', () => {
    const c = DS.parseCli(cliText({ p1: [70, 140, 12] }));
    assert.equal(c.kind, 'dump'); assert.equal(c.craft, 'SAB Fireball'); assert.equal(c.version, '4.6.0');
    assert.deepEqual(Object.keys(c.profiles), ['0', '1']); assert.deepEqual(c.servos['1'], [1500, -700, 700, 500, 500, 333, 0, 2]);
    const V = DS.cliValues(c);
    assert.deepEqual(Object.keys(V.profiles), ['1', '2'], 'CLI profile 0 is PID profile 1');
    assert.equal(V.global.gyro_lpf1_type, 0); assert.equal(V.global.serialrx_provider, 9); assert.equal(V.global.motor_pwm_protocol, 0); assert.equal(V.global.use_unsynced_pwm, 1);
    assert.equal(V.global.gyro_hardware_lpf, 0); assert.equal(V.profiles[1].iterm_relax_type, 2, 'RPY is 2');
    assert.equal(V.global.filter_process_denom, 2, 'filter_process_denom 0 is the PID loop divider (sensors/gyro_init.c:630)');
    assert.equal(V.global.gov_mode, 'DIRECT');
    assert.deepEqual([V.profiles[1]['error_limit[2]'], V.profiles[1]['offset_limit[0]'], V.rates[1]['setpoint_boost_gain[2]']], [50, 80, 60]);
    assert.equal(V.global['feature ESC_SENSOR'], true, 'the last feature line wins'); assert.equal(V.global['feature RX_PPM'], false);
    assert.deepEqual([V.global['mixer input SC min'], V.global['mixer input SC max'], V.global['mixer input SC rate'], V.global['servo 1 mid'], V.global['servo 1 flags']], [-1250, 1250, 1070, 1500, 2]);
    // the header of the fixture agrees with the global part and with profile 0
    const f = DS.fitOf(DS.headerValues(header()).values, V, 1);
    assert.deepEqual(f.mismatches, []); assert.ok(f.fits); assert.ok(f.compared > 60, `compared ${f.compared}`); assert.ok(f.profileCompared);
    const g = DS.fitOf(DS.headerValues(header({ yawPID: [70, 140, 12, 10, 10] })).values, V, 1);
    assert.deepEqual(g.mismatches.map(m => m.name), ['yaw_p_gain', 'yaw_i_gain']);
    // health_setup.parseCli's shape works too
    const hs = { kind: 'dump', global: { gyro_lpf1_type: 'PT1', error_limit: [1, 2, 3] }, profiles: { 2: { yaw_p_gain: 5 } }, rateprofiles: {}, features: { OSD: true }, mixerInputs: { SC: [-1, 1, 3] } };
    const W = DS.cliValues(hs);
    assert.deepEqual([W.global.gyro_lpf1_type, W.global['error_limit[1]'], W.profiles[3].yaw_p_gain, W.global['feature OSD'], W.global['mixer input SC rate']], [3, 2, 5, true, 3]);
});

test('2b a CLI dump of diff all: a value that a section leaves out is the default', () => {
    const t = '# diff all\n\n# name: X\nfeature GOVERNOR\n\n# master\nset gov_mode = ELECTRIC\nprofile 0\n\nset yaw_p_gain = 70\nset gov_headspeed = 2300\n\nprofile 1\n\nprofile 2\n\nset yaw_cw_stop_gain = 140\n\n# restore original profile selection\nprofile 0\n';
    const V = DS.cliValues(DS.parseCli(t));
    assert.equal(V.kind, 'diff');
    assert.deepEqual(Object.keys(V.profiles), ['1', '2', '3']);
    assert.equal(V.profiles[1].yaw_p_gain, 70); assert.equal(V.profiles[2].yaw_p_gain, 80, '4.6.0 default (health_setup PAIRS, FW pg/pid.c)');
    assert.equal(V.profiles[3].yaw_cw_stop_gain, 140); assert.equal(V.profiles[1].yaw_cw_stop_gain, 120);
    assert.equal(V.profiles[2].gov_headspeed, 'default', 'a value without a known default');
    assert.equal(V.global.gyro_lpf1_static_hz, 100, 'global default');
    // round 3: the header names that a diff leaves out (pg/pid.c): iterm_relax_type RPY, iterm_relax_level 40, error_limit 45, 45, 60
    assert.deepEqual([V.profiles[2].iterm_relax_type, V.profiles[2]['iterm_relax_level[1]'], V.profiles[2]['error_limit[2]']], [2, 40, 60]);
});

// ---- 3. Datasets -------------------------------------------------------------------------------------------------------

test('3a values that do not change the flight never split a dataset, and they are listed as information', () => {
    const logs = [log(0, header(), { arming: 1 }),
        log(1, header({ levelPID: [60, 55, 40, 75], vbatcellvoltage: undefined, vbatwarningcellvoltage: 340, debug_mode: 6, vbatref: 2400, 'Craft name': 'Other name', fields_mask: 1, 'Log start datetime': 'x' }), { arming: 1 })];
    const ds = DS.datasets(logs, null);
    assert.equal(ds.datasets.length, 1);
    const d = ds.datasets[0];
    assert.deepEqual([d.id, d.pidProfile, d.logs, d.assumed, d.seconds, d.flightSeconds], ['A', 1, [0, 1], false, 200, 160]);
    assert.deepEqual(d.flights, [{ log: 0, flight: 0, t0: 10, t1: 90, seconds: 80 }, { log: 1, flight: 0, t0: 10, t1: 90, seconds: 80 }]);
    assert.deepEqual(ds.diff, []);
    assert.deepEqual(ds.info.map(r => r.name).sort(), ['Craft name', 'angle_level_strength', 'debug_mode', 'fields_mask', 'vbat_warning_cell_voltage'].sort());
    assert.ok(!ds.info.some(r => r.name === 'vbatref' || r.name === 'Log start datetime'), 'header facts are not information rows');
    assert.deepEqual(ds.info.find(r => r.name === 'angle_level_strength').values, [{ value: 40, logs: [0], datasets: ['A'] }, { value: 60, logs: [1], datasets: ['A'] }]);
    assert.equal(d.values.rescue_mode, undefined); assert.equal(d.values.angle_level_strength, undefined, 'values hold the flight values only');
    assert.equal(ds.newest, 'A'); assert.deepEqual(ds.newestByProfile, { 1: 'A' });
});

test('3b a value that changes the flight makes a new dataset, with the table of the parameters that are not the same', () => {
    const logs = [log(0, header(), { arming: 2 }), log(1, header({ yaw_stop_gain: [130, 90] }), { arming: 2 }), log(2, header({ yaw_stop_gain: [130, 90], gyro_lowpass2_hz: 60 }), { arming: 2 }),
        log(3, header({ unknownHeaders: [{ name: 'gyro_decimation_hz', value: '500' }, { name: 'brand_new', value: '7' }] }), { arming: 2 })];
    const ds = DS.datasets(logs, null);
    assert.deepEqual(ds.datasets.map(d => `${d.id}:${d.logs.join('+')}`), ['A:0', 'B:1', 'C:2', 'D:3']);
    assert.deepEqual(ds.diff.map(r => r.name), ['yaw_cw_stop_gain', 'yaw_ccw_stop_gain', 'gyro_lpf2_static_hz', 'brand_new'], 'in the order of the table');
    const stop = ds.diff.find(r => r.name === 'yaw_cw_stop_gain');
    assert.deepEqual(stop.values, { A: 110, B: 130, C: 130, D: 110 }); assert.equal(stop.samePidProfile, true); assert.equal(stop.group, 'stop');
    assert.deepEqual(stop.logs, { A: [0], B: [1], C: [2], D: [3] });
    assert.deepEqual(ds.diff.find(r => r.name === 'brand_new').values, { A: null, B: null, C: null, D: 7 }); assert.deepEqual(ds.diff.find(r => r.name === 'brand_new').missingIn, ['A', 'B', 'C']);
    const pair = (a, b) => ds.pairs.find(p => p.a === a && p.b === b);
    assert.deepEqual(pair('A', 'B').names, ['yaw_cw_stop_gain', 'yaw_ccw_stop_gain']);
    assert.deepEqual(pair('B', 'C').names, ['gyro_lpf2_static_hz']);
    assert.deepEqual(pair('A', 'D').unknown, ['brand_new']);
    assert.deepEqual(ds.unknownNames, [{ name: 'brand_new', logs: [3] }]);
    assert.ok(ds.notes.some(n => n.includes('`brand_new`')));
    assert.equal(ds.newest, 'D');
});

test('3c a PID profile that the log header does not show takes the values of the nearest log armed in it, marked assumed', () => {
    const p2a = { yawPID: [70, 130, 12, 10, 10] }, p2b = { yawPID: [75, 135, 12, 10, 10] };
    const logs = [log(0, header(), { arming: 1, runs: [[0, 50, 1], [50, 100, 2]] }), // profile 2 from log 1 (distance 1)
        log(1, header(p2a), { arming: 2 }),
        log(2, header(), { arming: 1, runs: [[0, 40, 1], [40, 100, 2]] }),             // logs 1 and 3 at distance 1: the earlier one (RULES.join)
        log(3, header(p2b), { arming: 2 }),
        log(4, header(), { arming: 1, runs: [[0, 30, 1], [30, 100, 2]] })];            // log 3 (distance 1)
    const ds = DS.datasets(logs, null);
    assert.deepEqual(ds.datasets.map(d => `${d.id}:${d.pidProfile}:${d.logs.join('+')}${d.assumed ? ':assumed' : ''}`), ['A:1:0+2+4', 'B:2:0+1+2', 'C:2:3+4']);
    assert.equal(labelsOf(ds, 0), '0-50:A 50-100:B'); assert.equal(labelsOf(ds, 4), '0-30:A 30-100:C');
    const B = byId(ds, 'B');
    assert.equal(B.assumed, false, 'log 1 knows the values'); assert.equal(B.assumedSeconds, 110);
    assert.deepEqual(B.assumedFrom.map(a => [a.log, a.from, a.bracketed]), [[0, 1, false], [2, 1, false]]);
    assert.equal(B.sources.yaw_p_gain, 'header'); assert.equal(B.values.yaw_p_gain, 70);
    const l0 = ds.labels.find(x => x.log === 0 && x.dataset === 'B');
    assert.deepEqual([l0.assumed, l0.source.profile, l0.flightSeconds], [true, 'log 1', 40]);
    assert.ok(ds.notes.includes('The log header of log 1 does not show the values of PID profile 2. Thus, configuration B uses the values of log 2 for this part of log 1.'));
    // bracketed: the logs before and after agree
    const ds2 = DS.datasets([log(0, header(p2a), { arming: 2 }), log(1, header(), { arming: 1, runs: [[0, 50, 1], [50, 100, 2]] }), log(2, header(p2a), { arming: 2 })], null);
    assert.equal(ds2.datasets.find(d => d.pidProfile === 2).assumedFrom[0].bracketed, true);
});

test('3d the CLI dump: its section when it agrees with the log, not for another craft, assumed when it does not agree', () => {
    const runs = [[0, 50, 1], [50, 100, 2]];
    const ok = DS.datasets([log(0, header(), { arming: 1, runs })], cliText({ p1: [70, 140, 12] }));
    const B = byId(ok, 'B');
    assert.deepEqual([B.pidProfile, B.assumed, B.values.yaw_p_gain, B.sources.yaw_p_gain, B.values.gov_headspeed], [2, false, 70, 'cli', 1800]);
    assert.equal(byId(ok, 'A').values.gov_headspeed, 1800, 'a value that only the CLI dump shows');
    assert.equal(byId(ok, 'A').values.gov_mode, 'DIRECT'); assert.equal(byId(ok, 'A').values['servo 1 rate'], 333);
    assert.deepEqual(ok.logs[0].cli, { used: true, fits: true, compared: ok.logs[0].cli.compared, profileCompared: true, mismatches: [] });
    assert.deepEqual(ok.diff.map(r => r.name), ['yaw_p_gain', 'yaw_i_gain'], 'PID profile 1 and PID profile 2 of the dump');
    // another craft name: the dump is not used
    const other = DS.datasets([log(0, header(), { arming: 1, runs })], cliText({ craft: 'Other', p1: [70, 140, 12] }));
    assert.equal(other.logs[0].cli.used, false); assert.equal(byId(other, 'B').assumed, true); assert.equal(byId(other, 'B').values.yaw_p_gain, null);
    assert.ok(other.notes.includes('The craft name of the CLI dump is not the craft name of log 1. Thus, the app does not use the CLI dump for log 1.'));
    // a dump that does not agree with the header (a different time): its section, marked assumed
    const stale = DS.datasets([log(0, header({ yaw_precomp: [5, 10, 60] }), { arming: 1, runs })], cliText({ p1: [70, 140, 12] }));
    assert.equal(stale.logs[0].cli.fits, false); assert.deepEqual(stale.logs[0].cli.mismatches.map(m => m.name), ['yaw_collective_ff_gain']);
    assert.deepEqual([byId(stale, 'B').assumed, byId(stale, 'B').values.yaw_p_gain, stale.labels[1].source.profile], [true, 70, 'cli']);
    assert.ok(stale.notes.some(n => n.startsWith('The CLI dump does not agree with the log header of log 1.')));
});

test('3e a PID profile with no source: unknown values, one dataset for the logs with the same other values, and the arming profile unknown', () => {
    const logs = [log(0, header(), { runs: [[0, 20, 0], [20, 100, 3]] }), log(1, header(), { runs: [[0, 25, 0], [25, 100, 3]] }),
        log(2, header({ yawPID: [45, 105, 10, 10, 10] }), { runs: [[0, 30, 0], [30, 100, 3]] })];
    const ds = DS.datasets(logs, null);
    assert.deepEqual(ds.datasets.map(d => `${d.id}:${d.pidProfile}:${d.logs.join('+')}`), ['A:null:0+1', 'B:3:0+1+2', 'C:null:2']);
    const B = byId(ds, 'B');
    assert.equal(B.assumed, true); assert.equal(B.values.yaw_p_gain, null); assert.ok(B.unknown.includes('yaw_cw_stop_gain'));
    assert.equal(B.unknown.length, 56, 'every PID profile value of the header that changes the flight');
    assert.equal(B.values.gyro_lpf2_static_hz, 50, 'global values from the header');
    assert.deepEqual(byId(ds, 'A').sameValuesAs, [], 'B has no known PID profile value to agree with');
    // no CLI dump (an optional input, user rule 2026-10-06): the notes say what the log records, and no note asks for a dump
    assert.ok(ds.notes.includes('No log header shows the values of PID profile 3. Thus, the configurations of PID profile 3 have only the global values of the log header.'), JSON.stringify(ds.notes));
    assert.ok(ds.notes.includes('The log header records the values of PID profile 3 only when the pilot arms the helicopter in PID profile 3.'));
    assert.ok(!ds.notes.some(n => /CLI dump|diff all/.test(n)), JSON.stringify(ds.notes));
    assert.deepEqual(ds.diff.map(r => [r.name, r.values]), [['yaw_p_gain', { A: 65, B: null, C: 45 }], ['yaw_i_gain', { A: 120, B: null, C: 105 }], ['yaw_d_gain', { A: 12, B: null, C: 10 }]], 'pitch, roll, yaw: the settings.c order');
    const AB = ds.pairs.find(p => p.a === 'A' && p.b === 'B');
    assert.equal(AB.unknown.length, 56); assert.deepEqual(AB.unknownBoth, []);
    assert.deepEqual(ds.newestByProfile, { unknown: 'C', 3: 'B' });
    // the same values as a dataset with a known PID profile: sameValuesAs (the PID profile stays unknown)
    const s = DS.datasets([log(0, header(), { runs: [[0, 20, 0], [20, 100, 1]] }), log(1, header(), { arming: 1 })], null);
    assert.deepEqual(s.datasets.map(d => `${d.id}:${d.pidProfile}`), ['A:null', 'B:1']); assert.deepEqual(byId(s, 'A').sameValuesAs, ['B']);
});

test('3f rate profile switches and in-flight adjustments', () => {
    const cli = cliText() + '\nrateprofile 1\n\nset rates_type = ROTORFLIGHT\nset roll_rc_rate = 50\nset pitch_rc_rate = 50\nset yaw_rc_rate = 80\nset roll_expo = 20\nset pitch_expo = 20\nset yaw_expo = 20\nset roll_srate = 12\nset pitch_srate = 12\nset yaw_srate = 12\nset setpoint_boost_gain = 30,30,60,0\n';
    const ds = DS.datasets([log(0, header(), { arming: 1, rate: [[40, 2]], runs: [[0, 100, 1]] })], cli);
    assert.equal(labelsOf(ds, 0), '0-40:A 40-100:B');
    assert.deepEqual(ds.diff.map(r => r.name), ['roll_expo', 'pitch_expo', 'yaw_expo'], 'rates from rateprofile 1 of the dump');
    assert.equal(byId(ds, 'B').assumed, false);
    const nocli = DS.datasets([log(0, header(), { arming: 1, rate: [[40, 2]] })], null);
    assert.equal(byId(nocli, 'B').assumed, true); assert.equal(byId(nocli, 'B').values.yaw_expo, null);
    assert.ok(nocli.notes.includes('The log header of log 1 does not show the values of rate profile 2. Thus, the rates after the switch to rate profile 2 are unknown.'));
    // adjustments: the yaw P gain at 30 s (a new configuration until the end of the log, also after a switch back), the
    // yaw expo (the decoder gives 0.4 for 40), and the rescue climb collective (no new configuration)
    const adj = DS.datasets([log(0, header(), { arming: 1, runs: [[0, 50, 1], [50, 60, 2], [60, 100, 1]], adj: [[30, 22, 70], [35, 13, 0.4], [70, 39, 500]] })], null);
    assert.equal(labelsOf(adj, 0), '0-30:A 30-35:B 35-50:C 50-60:D 60-100:C');
    assert.deepEqual([byId(adj, 'B').values.yaw_p_gain, byId(adj, 'B').sources.yaw_p_gain, byId(adj, 'C').values.yaw_expo, byId(adj, 'D').values.yaw_p_gain], [70, 'adjustment', 40, null]);
    assert.ok(adj.notes.includes('In log 1, the pilot changed `yaw_p_gain` in flight at 30 s. Thus, the time after this change is a different configuration.'));
    assert.ok(!adj.notes.some(n => n.includes('rescue_climb_collective')));
    assert.ok(adj.info.some(r => r.name === 'rescue_climb_collective'), 'an adjustment of a value that does not change the flight is information');
    // an adjustment function without a 4.6.0 parameter: unknown, it changes the flight
    const odd = DS.datasets([log(0, header(), { arming: 1, adj: [[50, 30, 3]] })], null);
    assert.equal(odd.datasets.length, 2); assert.deepEqual(odd.unknownNames, [{ name: 'adjustment 30', logs: [0] }]);
});

test('3g bench runs, labels of every sample, flights and the newest dataset', () => {
    const logs = [log(0, header(), { arming: 1, flights: [] }), log(1, header(), { arming: 1, runs: [[0, 10, 1], [10, 60, 2], [60, 120, 1]], flights: [[5, 50], [70, 110]] }),
        log(2, header({ yaw_stop_gain: [120, 90] }), { arming: 1, runs: [[0, 30, 1], [30, 80, 2]], flights: [[20, 75]] })];
    const ds = DS.datasets(logs, null);
    assert.deepEqual(ds.benchRuns, [0]); assert.ok(!ds.labels.some(l => l.log === 0));
    // log 2 has other PID profile 1 values. PID profile 2 is not known in either log: one dataset for the two (assumed)
    assert.deepEqual(ds.datasets.map(d => `${d.id}:${d.pidProfile}:${d.flightSeconds}:${d.logs.join('+')}`), ['A:1:45:1', 'B:2:85:1+2', 'C:1:10:2']);
    assert.deepEqual(byId(ds, 'A').flights, [{ log: 1, flight: 0, t0: 5, t1: 50, seconds: 5 }, { log: 1, flight: 1, t0: 70, t1: 110, seconds: 40 }]);
    assert.deepEqual(byId(ds, 'B').flights, [{ log: 1, flight: 0, t0: 5, t1: 50, seconds: 40 }, { log: 2, flight: 0, t0: 20, t1: 75, seconds: 45 }]);
    assert.equal(ds.newest, 'B', 'the last stretch with flight time'); assert.deepEqual(ds.newestByProfile, { 1: 'C', 2: 'B' });
    assert.deepEqual(ds.datasets.map(d => d.newest), [false, true, false]);
    const ix = DS.labelArray(ds, 1, [0, 9.99, 10, 59.9, 60, 120, 130]);
    assert.deepEqual(Array.from(ix), [0, 0, 1, 1, 0, 0, -1]);
    assert.equal(DS.datasetAt(ds, 2, 31), 'B'); assert.equal(DS.datasetAt(ds, 2, 29), 'C'); assert.equal(DS.datasetAt(ds, 0, 31), null);
    assert.equal(byId(ds, 'B').summary, 'Configuration B has PID profile 2. It has 85 s of flight in logs 2 and 3.');
    assert.deepEqual(DS.profileMap(ds, 1), { 1: [0], 2: [1] }); assert.deepEqual(DS.profileMap(ds, 2), { 1: [2], 2: [1] }); assert.deepEqual(DS.profileMap(ds, 0), {});
    const split = DS.datasets([log(0, header(), { runs: [[0, 30, 0], [30, 100, 2]], adj: [[60, 22, 90]] })], null);
    assert.deepEqual(DS.profileMap(split, 0), { 0: [0], 2: [1, 2] }, 'an adjustment splits PID profile 2 of this log');
});

test('3h options.useEstimates: the arming profile that the governor target shows gives assumed values', () => {
    const logs = [log(0, header(), { runs: [[0, 20, 0], [20, 100, 1]], estimate: 1 }), log(1, header({ yaw_stop_gain: [140, 100] }), { runs: [[0, 20, 0], [20, 100, 1]], estimate: 1 }),
        log(2, header(), { runs: [[0, 20, 0], [20, 100, 1]] })];
    const off = DS.datasets(logs, null);
    assert.equal(off.datasets.filter(d => d.pidProfile === 1).length, 1, 'without the option: one dataset with unknown values');
    const on = DS.datasets(logs, null, { useEstimates: true });
    assert.deepEqual(on.datasets.map(d => `${d.id}:${d.pidProfile}:${d.logs.join('+')}`), ['A:null:0+2', 'B:1:0', 'C:null:1', 'D:1:1+2']);
    assert.deepEqual(byId(on, 'B').assumedFrom.map(a => a.from), ['estimate']);
    assert.deepEqual(byId(on, 'D').assumedFrom.map(a => [a.log, a.from, a.viaEstimate]), [[1, 'estimate', false], [2, 1, true]]);
    assert.equal(on.labels.find(l => l.log === 2 && l.pidProfile === 1).source.profile, 'log 1 (estimate)');
    assert.deepEqual(byId(on, 'A').pidProfile, null, 'the arming stretch stays "PID profile unknown"');
    assert.ok(on.notes.includes('The governor target shows that log 2 possibly started in PID profile 1. Thus, configuration D uses the values of log 2 for this part of log 3.'));
});

// ---- 4. Comparisons ----------------------------------------------------------------------------------------------------

test('4a A/B: the difference of the means with its SE and the 2-SE test', () => {
    const logs = [log(0, header(), { arming: 1 }), log(1, header({ yaw_stop_gain: [140, 100] }), { arming: 1 }), log(2, header({ yaw_stop_gain: [140, 100], rollPID: [60, 100, 15, 100, 25], pitchPID: [100, 100, 38, 100, 70], yawPID: [70, 120, 12, 10, 10], rollBW: [90, 35, 35] }), { arming: 1 })];
    const ds = DS.datasets(logs, null);
    const cmp = DS.compare({ A: { mean: 41.1, se: 3.0, n: 6 }, B: { mean: 30.2, se: 4.0, n: 5 }, C: [1, 2, 3] }, ds);
    const ab = cmp.pairs.find(p => p.a === 'A' && p.b === 'B');
    assert.deepEqual(ab.names, ['yaw_cw_stop_gain', 'yaw_ccw_stop_gain']); assert.equal(ab.few, true);
    within(ab.delta, -10.9, 1e-9, 'delta'); within(ab.se, 5, 1e-9, 'SE = sqrt(3^2 + 4^2)'); within(ab.z, -2.18, 1e-9, 'z'); assert.equal(ab.significant, true);
    const bc = cmp.pairs.find(p => p.a === 'B' && p.b === 'C');
    assert.equal(bc.names.length, 4); assert.equal(bc.few, false, 'more than RULES.ab.maxNames parameters');
    within(cmp.results.find(r => r.id === 'C').se, 1 / Math.sqrt(3), 1e-3, 'SE of samples');
    assert.equal(cmp.pairs[0].a + cmp.pairs[0].b, 'AB', 'the cleanest pair first');
    // the same means with a larger SE: not significant
    const weak = DS.compare({ A: { mean: 41.1, se: 6 }, B: { mean: 30.2, se: 6 } }, ds).pairs[0];
    assert.equal(weak.significant, false);
    // a result with no SE cannot be tested
    assert.equal(DS.compare({ A: 5, B: 6 }, ds).pairs[0].testable, false);
});

test('4b slopes from 3 or more datasets that differ in one parameter, or in parameters that change together', () => {
    // ground truth: kick = 70 - 0.25 x yaw_cw_stop_gain (yaw_ccw_stop_gain = yaw_cw_stop_gain - 40), SE 1.5
    const gains = [100, 120, 140, 160], logs = gains.map((g, i) => log(i, header({ yaw_stop_gain: [g, g - 40] }), { arming: 1 }));
    const ds = DS.datasets(logs, null), truth = (g) => 70 - 0.25 * g, noise = [0.8, -1.1, 0.4, 0.6];
    const res = Object.fromEntries(ds.datasets.map((d, i) => [d.id, { mean: truth(gains[i]) + noise[i], se: 1.5, n: 4 }]));
    const cmp = DS.compare(res, ds);
    assert.equal(cmp.slopes.length, 1);
    const s = cmp.slopes[0];
    assert.equal(s.name, 'yaw_cw_stop_gain'); assert.deepEqual(s.with, [{ name: 'yaw_ccw_stop_gain', ratio: 1, intercept: -40 }]);
    assert.deepEqual(s.datasets, ['A', 'B', 'C', 'D']); assert.equal(s.method, 'wls'); assert.equal(s.dof, 2); assert.equal(s.distinct, 4);
    within(s.se, 1.5 / Math.sqrt(2000), 1e-3, 'SE = 1.5 / sqrt(sum (x - mean)^2) with the Birge ratio < 1');
    assert.ok(Math.abs(s.slope - -0.25) <= 2 * s.se, `slope ${s.slope} ± ${s.se} against -0.25`);
    assert.equal(s.significant, true);
    // the prediction for a change of 20: about -5, inside the measured range; also by the other parameter of the pair
    const p = DS.predict(cmp, 'yaw_cw_stop_gain', 120, 140);
    within(p.change, s.slope * 20, 1e-9, 'change'); within(p.se, s.se * 20, 1e-6, 'SE'); assert.equal(p.inRange, true); assert.deepEqual(p.together, ['yaw_ccw_stop_gain']);
    const q = DS.predict(cmp, 'yaw_ccw_stop_gain', 80, 100);
    within(q.change, p.change, 1e-9, 'the same change by the other name'); assert.deepEqual(q.together, ['yaw_cw_stop_gain']);
    assert.equal(DS.predict(cmp, 'yaw_cw_stop_gain', 160, 200).inRange, false, 'out of the measured range');
    assert.equal(DS.predict(cmp, 'roll_p_gain', 1, 2), null);
    // a large scatter: the Birge ratio increases the SE
    const scatter = DS.compare(Object.fromEntries(ds.datasets.map((d, i) => [d.id, { mean: truth(gains[i]) + [8, -9, 7, -6][i], se: 1.5 }])), ds).slopes[0];
    assert.ok(scatter.birge > 1); within(scatter.se, 1.5 / Math.sqrt(2000) * scatter.birge, 1e-3, 'SE x Birge');
    // without an SE: ordinary least squares with the residual scatter
    assert.equal(DS.compare(Object.fromEntries(ds.datasets.map((d, i) => [d.id, truth(gains[i]) + noise[i]])), ds).slopes[0].method, 'ols');
});

test('4c no slope: two values only for 3 datasets is a slope, independent changes are confounded, unknown values block', () => {
    const two = [100, 100, 140].map((g, i) => log(i, header({ yaw_stop_gain: [g, 80], 'Log start datetime': String(i), levelPID: [40 + i, 55, 40, 75] }), { arming: 1 }));
    const ds2 = DS.datasets(two, null);
    assert.equal(ds2.datasets.length, 2, 'logs 0 and 1 are one dataset');
    // independent: A -> B the cw stop gain, A -> C the yaw P gain, B -> D both
    const ind = [log(0, header(), { arming: 1 }), log(1, header({ yaw_stop_gain: [130, 80] }), { arming: 1 }), log(2, header({ yawPID: [80, 120, 12, 10, 10] }), { arming: 1 }),
        log(3, header({ yaw_stop_gain: [130, 80], yawPID: [80, 120, 12, 10, 10] }), { arming: 1 })];
    const ds = DS.datasets(ind, null), res = { A: { mean: 1, se: 0.1 }, B: { mean: 2, se: 0.1 }, C: { mean: 3, se: 0.1 }, D: { mean: 4, se: 0.1 } };
    const cmp = DS.compare(res, ds);
    assert.equal(cmp.slopes.length, 0);
    assert.ok(cmp.confounded.some(c => c.datasets.length === 4 && c.why === 'independent changes'), JSON.stringify(cmp.confounded));
    // unknown values in the two datasets: no clean A/B, unless options.unknownEqual (then marked assumed)
    const unk = DS.datasets([log(0, header(), { runs: [[0, 100, 2]] }), log(1, header({ rc_expo: [20, 20, 20] }), { runs: [[0, 100, 2]] })], null);
    assert.equal(unk.datasets.length, 2);
    const u = DS.compare({ A: { mean: 1, se: 0.1 }, B: { mean: 2, se: 0.1 } }, unk).pairs[0];
    assert.deepEqual([u.few, u.assumed, u.names.length], [false, true, 3]);
    const ue = DS.compare({ A: { mean: 1, se: 0.1 }, B: { mean: 2, se: 0.1 } }, unk, { unknownEqual: true }).pairs[0];
    assert.deepEqual([ue.few, ue.assumed, ue.significant], [true, true, true]);
    // the diff rows alone are enough
    assert.deepEqual(DS.compare(res, ds.diff).pairs.find(p => p.a === 'A' && p.b === 'B').names, ['yaw_cw_stop_gain']);
});

test('4d resultsOf: the results of one check by dataset from findings', () => {
    const f = [{ id: 'T6', dataset: 'A', value: 40, se: 4, n: 3 }, { id: 'T6', dataset: 'A', value: 44, se: 4, n: 2 }, { id: 'T6', dataset: 'B', value: 30, se: 2, n: 5 },
        { id: 'T6', dataset: 'C', value: null }, { id: 'C12', dataset: 'A', axis: 'roll', value: 0.3 }, { id: 'T6', value: 99 }];
    const r = DS.resultsOf(f, { id: 'T6' });
    assert.deepEqual(Object.keys(r), ['A', 'B']);
    within(r.A.mean, 42, 1e-9, 'inverse-variance mean'); within(r.A.se, 4 / Math.sqrt(2), 1e-9, 'its SE'); assert.equal(r.A.n, 5);
    assert.deepEqual(DS.resultsOf(f, { id: 'C12', axis: 'roll' }), { A: { mean: 0.3, se: null, n: null } });
});

// ---- 5. The worker shim and Chromium 99 --------------------------------------------------------------------------------

test('5 the module loads with no require and no Node API, and runs on the builtins of Chromium 99', () => {
    const src = fs.readFileSync(FILE, 'utf8');
    // module.exports, then if (require.main !== module) return (CLAUDE.md, js/tuning_worker.js shim)
    assert.match(src, /module\.exports = \{[\s\S]*?\};\nif \(require\.main !== module\) return;/);
    const ctx = vm.createContext({ console });
    vm.runInContext(`(function () { const del = (o, keys) => { if (o) for (const k of keys) delete o[k]; };
        del(Array.prototype, ['toSorted', 'toReversed', 'toSpliced', 'with', 'findLast', 'findLastIndex', 'at']); del(Object, ['groupBy', 'hasOwn']); del(Map, ['groupBy']);
        del(String.prototype, ['at', 'replaceAll', 'isWellFormed', 'toWellFormed']); del(Set.prototype, ['union', 'intersection', 'difference']);
        del(Object.getPrototypeOf(Int8Array.prototype), ['toSorted', 'toReversed', 'with', 'at', 'findLast']); })();`, ctx);
    const required = [], mod = { exports: {} };
    const fn = vm.runInContext(`(function (require, module, exports, process, __dirname, __filename) {${src}\n})`, ctx, { filename: FILE });
    fn((n) => { required.push(n); throw new Error(`require at load: ${n}`); }, mod, mod.exports, { env: {} }, '/v', '/v/datasets.cjs');
    assert.deepEqual(required, []);
    const D = mod.exports, ds = D.datasets([log(0, header(), { arming: 1, runs: [[0, 50, 1], [50, 100, 2]] }), log(1, header({ yawPID: [70, 130, 12, 10, 10] }), { arming: 2 })], cliText());
    assert.equal(JSON.stringify(ds.datasets.map(d => d.id)), '["A","B"]');
    assert.equal(D.compare({ A: [1, 2, 3], B: [4, 5, 6] }, ds).pairs[0].significant, true);
});

// ---- 6. STE: every text of the module ----------------------------------------------------------------------------------

// The lint functions of test/ste_text.test.cjs (its vocabulary and checks), read from that file: the part skips when the
// file changes its layout
function steLint() {
    const f = path.join(__dirname, 'ste_text.test.cjs'); if (!fs.existsSync(f)) return null;
    const src = fs.readFileSync(f, 'utf8'), a = src.indexOf('// ---- vocabulary'), b = src.indexOf('// ---- rendered HTML to texts');
    if (a < 0 || b < a) return null;
    const make = new Function('require', `${src.slice(a, b)}\nreturn { loadVocabulary, lintText };`);
    const L = make(require), V = L.loadVocabulary(JSON.parse(fs.readFileSync(path.join(__dirname, 'ste', 'vocabulary.json'), 'utf8')));
    return (text, kind) => L.lintText(text, kind, V);
}
const FAILING = ['LEN', 'SEMI', 'CONTR', 'LATIN', 'DENY', 'ING', 'LIMIT', 'GB', 'TENSE', 'THAT', 'NOTEIMP', 'MATH', 'PARA', 'CASE', 'SAFE', 'VOCAB', 'GEAR'];
const lint = steLint();

test('6 the titles, reasons, labels, summaries and notes are STE', { skip: !lint && 'test/ste_text.test.cjs has no lint functions to read' }, () => {
    const texts = [];
    for (const g of DS.groups()) { texts.push([g.title, 'label', `title ${g.id}`], [g.reason, 'message', `reason ${g.id}`]); }
    // the notes of every rule: the fixtures of the tests above
    const runs = [[0, 50, 1], [50, 100, 2]], all = [
        DS.datasets([log(0, header(), { arming: 1, runs }), log(1, header({ yawPID: [70, 130, 12, 10, 10] }), { arming: 2 })], null),
        DS.datasets([log(0, header(), { arming: 1, runs })], cliText({ craft: 'Other' })),
        DS.datasets([log(0, header({ yaw_precomp: [5, 10, 60] }), { arming: 1, runs })], cliText({ p1: [70, 140, 12] })),
        DS.datasets([log(0, header(), { runs: [[0, 20, 0], [20, 100, 3]] })], null),
        DS.datasets([log(0, header(), { arming: 1, rate: [[40, 2]], adj: [[30, 22, 70], [35, 30, 2]] })], null),
        DS.datasets([log(0, header({ new_thing: 1 }), { runs: [[0, 20, 0], [20, 100, 1]], estimate: 1 }), log(1, header(), { runs: [[0, 20, 0], [20, 100, 1]] })], null, { useEstimates: true }),
    ];
    for (const ds of all) { for (const n of ds.notes) texts.push([n, 'message', 'note']); for (const d of ds.datasets) texts.push([d.label, 'label', 'label'], [d.summary, 'message', 'summary']); }
    assert.ok(texts.length > 80, `${texts.length} texts`);
    const hits = [];
    for (const [t, kind, where] of texts) for (const h of lint(t, kind)) if (FAILING.includes(h.check)) hits.push(`${where}: ${h.check} ${h.detail} | ${t}`);
    assert.deepEqual(hits, []);
});

// ---- 7. Real logs (read only) ------------------------------------------------------------------------------------------

const GAUI = process.env.AUTOTUNE_REAL_LOG, FB1005 = process.env.DATASETS_FB1005, FB0929 = process.env.DATASETS_FB0929, FB0929_CLI = process.env.DATASETS_FB0929_CLI;
const exists = (p) => p && fs.existsSync(p);

test('7a Fireball fb1005: 6 flight logs, the rates change between flights 14 and 15, the arming profile values of log 12', { skip: !exists(FB1005) && 'DATASETS_FB1005 not set' }, () => {
    const logs = DS.inputsOfFile(FB1005, { flightRpm: 2900 }), ds = DS.datasets(logs, null);
    assert.deepEqual(ds.logs.filter(l => !l.bench).map(l => l.log + 1), [6, 11, 12, 14, 15, 16], 'the flight logs (log numbers)');
    assert.deepEqual(ds.datasets.map(d => `${d.id}:${d.pidProfile}:${d.logs.map(l => l + 1).join('+')}`),
        ['A:null:6+11+14', 'B:2:6+11+12+14', 'C:3:11+14', 'D:null:12', 'E:1:12+14', 'F:null:15+16', 'G:2:15+16', 'H:3:16']);
    within(byId(ds, 'B').flightSeconds, 926.8, 1, 'PID profile 2 before the change of the rates');
    within(byId(ds, 'G').flightSeconds, 294.7, 1, 'PID profile 2 after the change of the rates');
    assert.deepEqual(ds.diff.map(r => r.name).sort(), ['pitch_expo', 'roll_expo', 'yaw_d_gain', 'yaw_expo', 'yaw_i_gain', 'yaw_p_gain'].sort());
    assert.deepEqual(['roll_expo', 'pitch_expo', 'yaw_expo'].map(n => ds.diff.find(r => r.name === n).values.B), [25, 25, 33]);
    assert.deepEqual(['roll_expo', 'pitch_expo', 'yaw_expo'].map(n => ds.diff.find(r => r.name === n).values.G), [20, 20, 20]);
    assert.deepEqual(['yaw_p_gain', 'yaw_i_gain', 'yaw_d_gain'].map(n => [ds.diff.find(r => r.name === n).values.A, ds.diff.find(r => r.name === n).values.D]), [[65, 45], [120, 105], [12, 10]]);
    assert.ok(byId(ds, 'B').assumed && byId(ds, 'B').unknown.length === 56, 'no log header and no CLI dump show PID profile 2');
    assert.deepEqual(ds.unknownNames, []);
});

test('7b Fireball 0929 #3 with its CLI dump: the dump does not agree with the log header', { skip: !(exists(FB0929) && exists(FB0929_CLI)) && 'DATASETS_FB0929 or DATASETS_FB0929_CLI not set' }, () => {
    const cli = fs.readFileSync(FB0929_CLI, 'utf8'), logs = DS.inputsOfFile(FB0929, { flightRpm: 2900, cli }), ds = DS.datasets(logs, cli);
    assert.deepEqual(ds.cli.profiles, [1], 'the dump holds profile 0 only');
    assert.deepEqual(ds.logs[0].cli.mismatches.map(m => m.name), ['feature ESC_SENSOR']);
    assert.deepEqual(ds.datasets.map(d => `${d.id}:${d.pidProfile}${d.assumed ? ':assumed' : ''}`), ['A:null', 'B:2:assumed', 'C:3:assumed', 'D:1:assumed']);
    within(byId(ds, 'B').flightSeconds, 305.9, 1, 'PID profile 2');
    assert.deepEqual(Object.fromEntries(ds.diff.map(r => [r.name, [r.values.A, r.values.D]])), { yaw_p_gain: [65, 70], yaw_i_gain: [120, 140], yaw_collective_ff_gain: [70, 60] });
    assert.equal(byId(ds, 'D').values.gov_mode, 'DIRECT', 'a value of the dump only');
});

test('7c Gaui X4 dump: flights 49, 50, 51, 58, the yaw gains and the stop gains of the arming profile', { skip: !exists(GAUI) && 'AUTOTUNE_REAL_LOG not set' }, () => {
    const logs = DS.inputsOfFile(GAUI, { flightRpm: 2000 }), ds = DS.datasets(logs, null);
    assert.deepEqual(ds.logs.filter(l => !l.bench).map(l => l.log), [49, 50, 51, 58], 'the flight logs (index in the file)');
    assert.deepEqual(ds.datasets.map(d => `${d.id}:${d.pidProfile}:${d.logs.join('+')}`), ['A:null:49+51', 'B:2:49+50+58', 'C:3:49+58', 'D:1:49+50+51+58', 'E:null:50', 'F:null:58']);
    const v = (n, id) => ds.diff.find(r => r.name === n).values[id];
    assert.deepEqual(['yaw_p_gain', 'yaw_i_gain', 'yaw_d_gain', 'yaw_cw_stop_gain', 'yaw_ccw_stop_gain'].map(n => [v(n, 'A'), v(n, 'E'), v(n, 'F')]),
        [[80, 100, 100], [120, 140, 140], [10, 14, 14], [120, 120, 140], [80, 80, 100]]);
    const EF = ds.pairs.find(p => p.a === 'E' && p.b === 'F');
    assert.deepEqual(EF.names, ['yaw_cw_stop_gain', 'yaw_ccw_stop_gain'], 'E and F differ in the stop gains only (120/80 against 140/100)');
    within(byId(ds, 'D').flightSeconds, 310.9, 1, 'PID profile 1');
    const est = DS.datasets(logs, null, { useEstimates: true });
    assert.deepEqual(est.datasets.filter(d => d.pidProfile === 1).map(d => d.logs.join('+')), ['49', '50+51', '58']);
});

test('configuration header replays logged LUA gains and cutoffs without inheriting another profile', () => {
    const D=require('../tools/autotune/datasets.cjs'), FT=require('../tools/autotune/filter_tune.cjs');
    const h={rollPID:[60,90,20,10],rollBW:[80,40,20],pitchPID:[50,80,10],pitchBW:[70,25,20],gyro_soft_type:1,features:0};
    const values={roll_p_gain:75,roll_i_gain:90,roll_d_gain:30,roll_gyro_cutoff:120,roll_d_cutoff:50,'feature DYN_NOTCH':true,gyro_lpf1_type:7};
    const out=D.configurationHeader(h,{pidProfile:2,values}), cfg=FT.config(out);
    assert.deepEqual(out.rollPID.slice(0,3),[75,90,30]);assert.deepEqual(out.rollBW.slice(0,2),[120,50]);
    assert.equal(cfg.pid.header.roll.P,75);assert.equal(cfg.pid.header.roll.gyro_cutoff,120);assert.equal(cfg.pid.header.pitch.P,null);assert.equal(cfg.pid.header.pitch.gyro_cutoff,null);
    assert.equal(cfg.s.gyro_lpf1_type,7);assert.equal(cfg.s.DYN_NOTCH,true);
    assert.deepEqual(h.rollPID,[60,90,20,10]);assert.equal(h.features,0,'original header stays unchanged');
});
