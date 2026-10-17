'use strict';
/**
 * Audited source equivalence of other firmware builds with the pinned controller and sensor source (manifest.json,
 * Rotorflight 4.6.0 118e912). The native replay (controller.wasm, sensor.wasm) executes the 118e912 files. A build in
 * REVISIONS executes the same algorithm when each condition of its hunks holds: then compatibility() of
 * firmware_controller.cjs and prepare() of filter_autotune.cjs accept it, and each log must also pass the parity of RULES.
 * An unknown build stays refused.
 *
 *   const EQ = require('./firmware/equivalence.cjs');
 *   EQ.match('Rotorflight 4.7.0-bbp-pr (85d7049a9) STM32G47X')   // { base: false, id: '85d7049a9', entry } | { base: true } | null
 *   EQ.check(entry, 'controller', { values, servos, modes })     // { supported, conditions: [{ id, holds, text }], reasons }
 *
 * Source (2026-10-15): git diff 118e912 <build> -- src/main/<each file of manifest.json> in rotorflight-firmware. files: the
 * manifest files that differ, with their sha256 at that build (test/firmware_controller.test.cjs checks every hash against the
 * repository when it is present), the scopes that execute them and each hunk with the condition that makes it inactive (null:
 * no effect on the replay in any configuration).
 *   58a4bd5cc  4.6.0-bbp, the flight build of the Fireball: release 4.6.0 + the blackbox parameter journal
 *   874f369d5  4.6.0-bbp-bench: the same replayed files as 58a4bd5cc (the builds differ in rx/spektrum.c only)
 *   a88bec8f8  the 4.7 snapshot (upstream) that 85d7049a9 starts from
 *   85d7049a9  4.7.0-bbp-pr: a88bec8f8 + the blackbox parameter journal
 * Files outside the manifest that differ (the replay takes their result from the log): sensors/gyro_init.c (journal hook),
 * drivers/accgyro/gyro_sync.c (ICM42605 sample rate: the replay uses the logged loop time), flight/airborne.c and
 * flight/motors.c (the airborne state and the RPM source: the replay uses the logged state and headspeed), fc/core.c,
 * flight/setpoint.c, fc/rc_rates.c, flight/rescue.c (journal hooks and rate shaping: the replay uses the logged setpoint).
 * sensors/battery.c (85d7049a9 and a88bec8f8, a large diff: 6 battery profiles, bat_profile selects one): the replay does not execute
 * it. The governor voltage compensation takes the logged voltage and the cell count of the configuration, which is the element of
 * bat_profile of the battery lists (firmware_controller.cjs getValue): with gov_use_voltage_comp ON, the per-log governor parity
 * (RULES) tests this value.
 * The filter parity (filter_autotune.cjs) uses RULES.filterBandDb and RULES.filterDelayMs for a build of REVISIONS.
 *
 * Worker-loadable (js/tuning_worker.js CommonJS shim): no Node API at module load.
 */
const RULES = Object.freeze({
    // per-log parity of a build of REVISIONS (control_pipeline.cjs controllerReplay, governorReplay; filter_autotune.cjs parity).
    // controllerMixerRelative: the relative RMS error of mixer[0..2] (errorsOf.relative) in each window, or controllerMixerFloor
    // (the logging step of the mixer fields, normalized) when the window has almost no movement
    controllerMixerRelative: 0.05, controllerMixerFloor: 0.001,
    governorStateAgreement: 0.995, governorThrottleRms: 0.002,   // share of samples with the logged governor state; throttle 0..1
    filterBandDb: 1, filterDelayMs: 0.3,                          // the band error and the delay error of the filter replay
    source: 'IMP-05/IMP-06 (analysis/fireball-crash-20261015): engineering limits above the measured agreement of the 4.7 log (controller 1.5/3.9/1.3 %, governor 0.99997 and 0.70 permille, filter 0.14 dB)',
});
const SCOPES = ['controller', 'governor', 'servo', 'sensor'];
const SCOPE_OF = {
    'pg/pid.h': ['controller', 'governor'], 'pg/pid.c': ['controller', 'governor'], 'flight/pid.h': ['controller'], 'flight/pid.c': ['controller'],
    'flight/mixer.h': ['controller'], 'flight/mixer.c': ['controller'], 'flight/servos.c': ['servo'], 'flight/governor.h': ['governor'],
    'flight/governor.c': ['governor'], 'flight/rpm_filter.c': ['sensor'],
};
// conditions: id -> { values (configuration values that it reads), holds(config) -> true | false | null (unknown), text }
const CONDITIONS = {
    errorDecayGain: { values: ['error_decay_gain_cyclic'], scope: 'controller',
        holds: (c) => { const v = c.values && c.values.error_decay_gain_cyclic; return typeof v === 'number' && Number.isFinite(v) ? v === 0 : null; },
        text: { failed: 'The app can use this firmware only when "error_decay_gain_cyclic" is 0. At other values, the firmware decreases the cyclic error more.',
            unknown: 'The configuration does not give "error_decay_gain_cyclic". If this value is not 0, the firmware decreases the cyclic error more.' } },
    levelModes: { values: [], scope: 'controller',
        // the flight periods of the pipeline have no rescue and no level mode (the attitude mask); config.modes lists other modes
        holds: (c) => (c.modes || []).every(m => m === 'acro' || m === 'rate'),
        text: { failed: 'The app can use this firmware only in flight periods with no angle mode, no horizon mode, no trainer mode and no rescue.', unknown: '' } },
    servoSpeed: { values: [], scope: 'servo',
        // the servo path (config.servos): every servo speed (field 6 of a servo row) 0; no servo path: not executed
        holds: (c) => { const s = c.servos; if (!s) return true; const rows = Array.isArray(s.parameters) ? s.parameters : []; return rows.length ? rows.every(r => Array.isArray(r) && r[6] === 0) : null; },
        text: { failed: 'The app can use this firmware with the servo outputs only when the speed of each servo is 0.', unknown: 'The servo speeds are unknown.' } },
};
const HOOKS = 'blackbox parameter journal: blackboxParamsApplied() after the loader, a read-only fingerprint or getter; no effect on the replay';
const JOURNAL = {
    'flight/pid.h': { hunks: [{ what: 'pidParamFingerprint() declaration', condition: null }] },
    'flight/pid.c': { hunks: [{ what: HOOKS + ' (pidLoadProfile, pidParamFingerprint)', condition: null }] },
    'flight/mixer.c': { hunks: [{ what: HOOKS + ' (mixerInitConfig)', condition: null }] },
    'flight/governor.h': { hunks: [{ what: 'getGovernorMode(), governorParamFingerprint() declarations', condition: null }] },
    'flight/governor.c': { hunks: [{ what: HOOKS + ' (governorInitProfile, governorParamFingerprint, getGovernorMode)', condition: null }] },
    'flight/rpm_filter.c': { hunks: [{ what: HOOKS + ' (rpmFilterInit)', condition: null }] },
};
const BBP46 = { 'flight/pid.h': 'f96fad4bc1fe8f2945028c7ebb1852ee016b155e9ea3091a47ee3d93ab8c59e3', 'flight/pid.c': '57e23f2cad95b6182571cb368d12572442bc84a733f119fcc4dc79ad4fa24552',
    'flight/mixer.c': 'f76174f16feb48b611f24d78f6b27c8834833e087acec7aaec6eaf345876a5e6', 'flight/governor.c': 'b802398ccd66c850fb75423722022d854a18d3ea8e55756411b89c6296972c7b',
    'flight/governor.h': '7ddff4c4b14049649cb158e7e5cb7d7c744aa924d555261b66db8f299eb3373a', 'flight/rpm_filter.c': '2825ffaedab2f144f3a5317cc761c97908a5fd85c8e69b07a9bbac944e54f813' };
const filesOf = (hashes, hunks) => Object.fromEntries(Object.entries(hashes).map(([f, sha256]) => [f, { sha256, scopes: SCOPE_OF[f], hunks: hunks[f].hunks }]));
const UPSTREAM47 = {
    'pg/pid.h': { hunks: [{ what: 'pidProfile_t: error_decay_gain_cyclic, horizon.angle_limit (configuration fields, set from the configuration values)', condition: null }] },
    'pg/pid.c': { hunks: [{ what: 'resetPidProfile defaults of the two new fields', condition: null }] },
    'flight/pid.h': { hunks: [{ what: 'pid.errorDecayGainCyclic', condition: 'errorDecayGain' }] },
    'flight/pid.c': { hunks: [{ what: 'pidApplyCyclicMode3: error decay x (1 + |setpoint| x error_decay_gain_cyclic / 50)', condition: 'errorDecayGain' },
        { what: 'pidController: levelingUpdate() resets the horizon activation timer when HORIZON is off', condition: 'levelModes' }] },
    'flight/mixer.h': { hunks: [{ what: 'mixerTakeStabilizedSaturation() declaration', condition: null }] },
    'flight/mixer.c': { hunks: [{ what: 'stabilizedSaturationLatch: set in mixerUpdate, read only by telemetry/status.c', condition: null }] },
    'flight/servos.c': { hunks: [{ what: 'servoUpdate: no speed limit before the first input of a servo (servoInputSet)', condition: 'servoSpeed' }] },
};
const BBP47 = Object.assign({}, UPSTREAM47, {
    'flight/pid.h': { hunks: UPSTREAM47['flight/pid.h'].hunks.concat(JOURNAL['flight/pid.h'].hunks) },
    'flight/pid.c': { hunks: UPSTREAM47['flight/pid.c'].hunks.concat(JOURNAL['flight/pid.c'].hunks) },
    'flight/mixer.c': { hunks: UPSTREAM47['flight/mixer.c'].hunks.concat(JOURNAL['flight/mixer.c'].hunks) },
    'flight/governor.h': JOURNAL['flight/governor.h'], 'flight/governor.c': JOURNAL['flight/governor.c'], 'flight/rpm_filter.c': JOURNAL['flight/rpm_filter.c'],
});
const REVISIONS = Object.freeze({
    '58a4bd5cc': { commit: '58a4bd5cc518608e40627cae2c489aa8b3d980cd', version: '4.6.0', build: '4.6.0-bbp', files: filesOf(BBP46, JOURNAL) },
    '874f369d5': { commit: '874f369d5274270a74a87d439921bfbfaa53df44', version: '4.6.0', build: '4.6.0-bbp-bench', files: filesOf(BBP46, JOURNAL) },
    'a88bec8f8': { commit: 'a88bec8f803a87b9824302afedb7e90c8d6fee9d', version: '4.7.0', build: '4.7 snapshot', files: filesOf({
        'pg/pid.h': 'cb904957d34fc9c6118e79795b2019c9794cf1e6fb13faca59d00a49c30ffd64', 'pg/pid.c': '9a11da4f699bc56d931551f4c168cc27cc8b94208ffb70b6262c5f6b999dc4ef',
        'flight/pid.h': 'f4257a7cc089b67873098e8d16bf4cb317527a3abd46c3b885f151c5ea1c92b7', 'flight/pid.c': '41262ab850e5d2c7c1659c8b52959672bd7f665e6c505e9c647dbcc549449029',
        'flight/mixer.h': '53e54517befe40d4cac4f64c25dea81ebb6d4bd77f26f8c6e4d0433b3bab8cd0', 'flight/mixer.c': 'd3fa2a125f7540a75000bee3ea6e1eeefca842a187cfca0031c535c8bf002cfd',
        'flight/servos.c': '6ac01999a1fdbe7f3345a27eb59d260c29147a280026400a90b34a632a855b1d' }, UPSTREAM47) },
    '85d7049a9': { commit: '85d7049a9377af53b1ce9564248139d9ceb854c1', version: '4.7.0', build: '4.7.0-bbp-pr', files: filesOf({
        'pg/pid.h': 'cb904957d34fc9c6118e79795b2019c9794cf1e6fb13faca59d00a49c30ffd64', 'pg/pid.c': '9a11da4f699bc56d931551f4c168cc27cc8b94208ffb70b6262c5f6b999dc4ef',
        'flight/pid.h': '647edcb711ea1250071ee9c1968844f5e21130a731253bb6fea3583b6ef42467', 'flight/pid.c': 'f7cd700cd436c8d2e40d16716165dafe1f118812738fe73bf2b5642404efcf9c',
        'flight/mixer.h': '53e54517befe40d4cac4f64c25dea81ebb6d4bd77f26f8c6e4d0433b3bab8cd0', 'flight/mixer.c': '01428e2ccb4f797fc0e2237a49b285cf190dc5faa4b8be8eabd6b244a2e71f99',
        'flight/governor.c': 'b802398ccd66c850fb75423722022d854a18d3ea8e55756411b89c6296972c7b', 'flight/governor.h': '7ddff4c4b14049649cb158e7e5cb7d7c744aa924d555261b66db8f299eb3373a',
        'flight/servos.c': '6ac01999a1fdbe7f3345a27eb59d260c29147a280026400a90b34a632a855b1d', 'flight/rpm_filter.c': '2825ffaedab2f144f3a5317cc761c97908a5fd85c8e69b07a9bbac944e54f813' }, BBP47) },
});
const BASE = Object.freeze({ commit: '118e9120260bb33f46df4f92052fb0e9fd4e9ebc', version: '4.6.0' });
// configuration values that a condition reads (firmware_controller.fromHeader keeps them next to the schema values)
const CONDITION_VALUES = [...new Set(Object.values(CONDITIONS).flatMap(c => c.values))];

// the build of a revision line: { base: true } for 118e912, { base: false, id, entry } for a build of REVISIONS, else null.
// The short hash is the hash in parentheses ("Rotorflight 4.7.0-bbp-pr (85d7049a9) STM32G47X"), or a full or short hash
function match(revision) {
    const text = String(revision || ''), m = /\(([0-9a-f]{7,40})\)/.exec(text), hash = m ? m[1] : /^[0-9a-f]{7,40}$/.test(text.trim()) ? text.trim() : null;
    if (!hash) return null;
    if (BASE.commit.startsWith(hash)) return { base: true };
    for (const [id, entry] of Object.entries(REVISIONS)) if (entry.commit.startsWith(hash)) return { base: false, id, entry };
    return null;
}
// The conditions of the hunks that the scopes execute: { supported, conditions: [{ id, holds, file, what, text }], reasons, files }
function check(entry, scopes, config = {}) {
    const use = new Set(Array.isArray(scopes) ? scopes : [scopes]), conditions = [], reasons = [], files = [];
    for (const [file, f] of Object.entries(entry.files)) {
        if (!f.scopes.some(s => use.has(s))) continue;
        files.push(file);
        for (const h of f.hunks) {
            if (!h.condition) continue;
            const C = CONDITIONS[h.condition], holds = C.holds(config);
            conditions.push({ id: h.condition, holds, file, what: h.what });
            if (holds !== true) { const t = holds === false ? C.text.failed : C.text.unknown || C.text.failed; if (!reasons.includes(t)) reasons.push(t); }
        }
    }
    return { supported: reasons.length === 0, conditions, reasons, files };
}
module.exports = { RULES, SCOPES, CONDITIONS, CONDITION_VALUES, REVISIONS, BASE, match, check };
if (require.main !== module) return;
