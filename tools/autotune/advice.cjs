'use strict';

/**
 * Advice: health findings and report.cjs gain decisions -> recommendations for the pilot, in tuning order, with the
 * guards of docs/TUNING_KNOWLEDGE.md sections 8 and 9, and a coverage matrix of the Rotorflight 4.6 parameter groups.
 *
 *   const advice = require('./advice.cjs');
 *   const { recommendations, coverage, notes } = advice.advise(input);
 *   const text = advice.script(recommendations);      // CLI of the unblocked 'action' recommendations, then save
 *
 * input = { findings,       health_report findings (modules setup, gov, loop, health) and health_track / health_more
 *                           findings, each with module and times
 *           decisions,      report.cjs results.decisions, or null
 *           header,         own properties of the analysed log's sysConfig
 *           cli,            health_setup.parseCli of the pilot's CLI dump, or null
 *           logs,           [{ log, start, flown, flyingS, profileSeconds, targetOf, excluded }]; setup findings of
 *                           logs that were not flown (bench spool-ups) are left out; start is optional
 *           fields,         D3 field states of the analysed log, or null
 *           headerProfile,  log profile that was active when the analysed log was armed (setup metrics startProfile);
 *                           0 or absent when unknown
 *           headerLog,      label of the analysed log, whose header this is (optional; with logs[].start it lets a
 *                           measurement from another log keep its CLI when the tuning history shows no change since)
 *           logBase }       added to log numbers in the texts written here (optional: 0 counts as the toolkit does,
 *                           1 as the viewer's log picker); finding texts quoted from the modules keep their own
 *
 * A recommendation carries its evidence (value, SE, n, unit, threshold and source of each finding), the rule it passed,
 * the guards that block it and caveats. CLI text is written only for an unblocked 'action' whose present value is known
 * for its profile, and only with the names in PARAMS. Advice only: nothing here talks to a flight controller. advise is
 * pure: no I/O, no clock, no randomness, and the input is not modified.
 *
 * Profiles. A finding's profile is the log profile (1-based INFLIGHT_ADJUSTMENT value, 0 = arming profile unknown) for
 * gov, loop, F5, F6 and the new modules; the CLI index for D4; an axis name for F4; 'global' or 'start profile N' for H.
 * CLI `profile q` is log profile q + 1 (pid.c get/set ADJUSTMENT_PID_PROFILE). The header holds the values of the
 * profile that was active at arming only.
 *
 * Guards (docs/DEVELOPMENT.md section 13): 1 no loop-gain raise while a filter flag stands (F1-F3 still in the analysed header, F5, F6 that
 * clears its 2-SE test, F10 yaw; C11 of the axis for D), no D cut for noise while another filter flag stands, and no
 * cyclic or tail change at all while a filter change with CLI is pending; 2 G12 and G1 flags block governor and
 * RPM-notch changes, and a G12 factor error beyond the RPM-notch tolerance also holds cyclic and tail changes; 3 C2 / T8
 * on an axis: "authority, not gains", no raise CLI; no governor raise while T8 holds the tail at its limit on that
 * profile or G10 implicates the governor; 4 a flag below 2 SE is a watch without CLI; 5 relative steps within 20 % (the
 * GOVT cut by 1/3 included), documented absolute steps kept, every value within its firmware range (RANGE); 6 no LPF
 * below 60 Hz, no notch Q below 2.0; 7 profile 0 gets no CLI; 8 no governor gains where it does not regulate; 9 D2 and
 * unresolvable F5 flags are checks; 10 wag_report section 8 is ignored; 11 tuning order; 12 PARAMS names only, and no
 * RPM notch source the firmware rejects. Also: a measurement older than the latest header change of its parameter (H)
 * gets no CLI and no target (re-measure), and a report.cjs prediction gets CLI only when its recovered gain matches the
 * configured one. Checks whose claim analysis/fireball-0928/FINDINGS.md section 8 refuted on verification (REFUTED: C10
 * landed while moving, T4, T6, T9, the G6 wording) give watches or checks that cite the refutation, never CLI; so does a
 * single self-excited burst (C5, T1).
 *
 * Severity: action = change something (CLI when it is one known parameter); check = inspect, the cause is not one
 * parameter or lies outside the log; watch = borderline or below 2 SE, fly again; info = context.
 * Estimates over several logs treat the flight as the independent unit (pooled) and use every measured log of the
 * group, not only the flagged ones.
 *
 * The thresholds of the health_track and health_more checks are read from those modules' DEFAULT_RULES (their findings
 * give them as text); both modules are optional in the app, and without one its checks have no findings.
 */

const lib = require('./lib.cjs');
const setup = require('./health_setup.cjs');
const gov = require('./health_gov.cjs');
const loop = require('./health_loop.cjs');

const RULES = {
    sigmas: 2,              // a flag with an SE must clear its threshold by this many SE to keep its CLI (guard 4)
    maxStep: 0.20,          // relative step bound (guard 5)
    dirStep: 0.10,          // relative step when a check gives a direction but no size
    minLpfHz: 60,           // never propose a gyro LPF below this (guard 6)
    noteLpfHz: 80,
    lpfHz: 100,             // the one LPF to add with RPM or dynamic notches
    minNotchQ: 2.0,         // never propose a notch Q below this (guard 6)
    govSteps: { F: 10, I: 25, P: 10 }, // raises
    govCut: 1 / 3,          // governor I or P once it oscillates; guard 5 bounds the step to maxStep
    tailDStep: 10,
    ttaStep: 10,
    gainTolerance: 0.07,    // recovered gain against the configured one before a report.cjs prediction gets CLI
    minLogHz: 1000,
    mixtI: 200,             // cyclic I at or above this looks like the temporary mixer-limit trick
    maxEvidence: 20,        // findings listed per recommendation (the total is given in a caveat)
    minBursts: 2,           // C5 / T1: self-excited bursts, over all logs of an axis, before the cause is put on the loop
    maxMainHarmonic: 8,     // RPM notch sources 11-18 track main-rotor harmonics 1-8, and no higher one
    filteredPass: 0.05,     // F5: a line the gyro filters pass less of than this (measured, gyroRAW -> gyroADC) needs no notch
    pidProfiles: 6,         // PID profiles a `diff all` prints
    source: {
        sigmas: 'pipeline: value - 2 SE past the threshold (CLAUDE.md: number, uncertainty, rule)',
        maxStep: 'pipeline, unvalidated: report.cjs RULES.multipliers 0.8-1.2 (DEVELOPMENT.md section 10: bound each step to 20 %)',
        dirStep: 'pipeline, unvalidated: the smallest report.cjs multiplier step (x0.9, x1.1), for checks that give a direction but no size',
        minLpfHz: 'doc FILT: "not advised to lower it below 60hz"',
        noteLpfHz: 'doc FILT (health_setup F2.noteHz)',
        lpfHz: 'doc MSG gyroLowpassFilterHelp: "With RPM Filters or Dynamic Notch Filters, one extra filter is needed around 100Hz"',
        minNotchQ: 'doc FILT and MSG gyroDynamicNotchQHelp: Q below 2.0 "will greatly increase filter delay"',
        govSteps: 'doc GOVT: "increments of 10 for the F-gain, increments of 25 for the I-gain and increments of 10 for the P-gain" (raises; TUNING_KNOWLEDGE 9.2)',
        govCut: 'doc GOVT: I "until it starts playing up, then reduce it with 1/3", P "till there are slight oscillations, then reduce it with 1/3" (TUNING_KNOWLEDGE 6, 9.2)',
        tailDStep: 'community HF-970331: tail D in steps of 10',
        ttaStep: 'doc TTA: "in increments of 10"',
        gainTolerance: 'pipeline, unvalidated: report.cjs RULES.gainTolerance (gain-set membership)',
        minLogHz: 'pipeline, unvalidated: health_setup D1.minHz (Nyquist, TUNING_KNOWLEDGE 7.4)',
        mixtI: 'doc MIXT: the temporary "I-gain ~200" trick, "MAKE SURE TO TURN THEM BACK"',
        maxEvidence: 'display only',
        minBursts: 'pipeline, unvalidated: one burst does not separate loop gain from load, lag or battery (analysis/fireball-0928/FINDINGS.md section 8, TAIL-EVENT3, refuted: n = 1)',
        filteredPass: 'wag_report.cjs section 8.3: no filter change when the filters pass under 5 % of a line (pipeline, unvalidated); measured by health_more curves vib.pass',
        maxMainHarmonic: 'firmware flight/rpm_filter.c rpmFilterInit (release/4.6.0): source 10 is the main motor, 11-18 main-rotor harmonics 1-8, 20 the tail motor, 21-28 tail-rotor harmonics 1-8; any other code fails and disables arming (ARMING_DISABLED_RPMFILTER), and the CLI does not range-check the array',
        pidProfiles: 'firmware cli.c printConfig: `diff all` and `dump all` print all PID_PROFILE_COUNT profiles, a plain `diff` or `dump` the current one only; 6 in 4.6 (a diff all lists profile 0-5)',
    },
};

// Firmware ranges of the values written here (guard 5): the CLI refuses a value outside one with "INVALID VALUE" and keeps
// the old value (cli.c cliSet). From the clivalue table of settings.c, release/4.6.0 (lines of the copy in
// analysis/gaui-x4/verify/PITCH-GAINS-EQUAL_semantics/fw): blackbox_rate_denom 788, LPF cutoffs 663, 665, 670 (LPF_MAX_HZ
// and DYN_LPF_MAX_HZ 1000, sensors/gyro.h:40-41), dyn_notch_q 679, stop gains 1136-1137, collective FFs 1142, 1147,
// governor gains 1209-1212, gyro_rpm_notch_preset 1699, yaw_inertia_precomp_gain 1144 (a T14 target, never CLI); axis
// gains PID_GAIN_MAX (flight/pid.h:35). The notch arrays (MODE_ARRAY) have no range there.
const RANGE = { blackbox_rate_denom: [1, 8000], gyro_lpf1_static_hz: [0, 1000], gyro_lpf2_static_hz: [0, 1000], gyro_lpf1_dyn_min_hz: [0, 1000], dyn_notch_q: [10, 100],
    yaw_cw_stop_gain: [25, 250], yaw_ccw_stop_gain: [25, 250], yaw_collective_ff_gain: [0, 250], pitch_collective_ff_gain: [0, 250],
    gov_p_gain: [0, 250], gov_i_gain: [0, 250], gov_f_gain: [0, 250], gyro_rpm_notch_preset: [0, 3], yaw_inertia_precomp_gain: [0, 250] };
for (const ax of lib.AXES) for (const k of ['p', 'i', 'd', 'f', 'b']) RANGE[`${ax}_${k}_gain`] = [0, 1000];

// Thresholds for the 2-SE test of checks whose judge compares means only, or whose estimate advice pools over logs (F10,
// C14; T14 in its generator): [threshold, side], side 1 flags above, -1 below, 0 on |value|; null takes the finding's
// numeric threshold. From the modules' DEFAULT_RULES, which health_report RULES equals and the app judges with
// (js/tuning_worker.js); the governor judge applies its own 2-SE test. health_track and health_more write their
// thresholds as text, so their numbers come from their DEFAULT_RULES here; both are optional in the app
// (js/tuning_worker.js OPTIONAL): without one its checks have no findings, and its numbers here are null.
const LR = loop.DEFAULT_RULES, SR = setup.DEFAULT_RULES, GR = gov.DEFAULT_RULES;
const optional = (load) => { try { return load(); } catch (e) { return null; } };
const TRACK = optional(() => require('./health_track.cjs')), MORE = optional(() => require('./health_more.cjs'));
const TR = (TRACK && TRACK.DEFAULT_RULES) || {}, MR = (MORE && MORE.DEFAULT_RULES) || {};
const ruleNum = (R, id, k) => R[id] && typeof R[id][k] === 'number' ? R[id][k] : null;
const ruleSrc = (R, id) => (R[id] && R[id].source) || 'pipeline, unvalidated';
const OSC = (TRACK && TRACK.RULE && TRACK.RULE.osc) || {}, ONSET = OSC.onset || {};          // health_track RULE: the wag_report.cjs onset rule
const TTRACK = (TRACK && TRACK.RULE && TRACK.RULE.track) || {};                              // health_track RULE: the C12 / T11 low-pass and setpoint gate
const MRULE = (MORE && MORE.RULE) || {};                                                    // health_more RULE: the F10 and F11 bands
const SIGMA = { C3: [LR.C3.iShare, 0], T9: [LR.T9.iShare, 0], C11: [LR.C11.share, 1], T5: [LR.T5.ratio, 1], T6: [LR.T6.kick, 1], T7: [LR.T7.r, 0], F6: [SR.F6.minDb, -1],
    C12: [ruleNum(TR, 'C12', 'flag'), 1], T11: [ruleNum(TR, 'T11', 'flag'), 1], C13: [ruleNum(TR, 'C13', 'flag'), 1], T12: [ruleNum(TR, 'T12', 'flag'), 1], R1: [ruleNum(TR, 'R1', 'flag'), 1],
    F10: [ruleNum(MR, 'F10', 'share'), 1], C14: [ruleNum(MR, 'C14', 'flag'), 0] };

// Claims that analysis/fireball-0928/FINDINGS.md section 8 refuted on verification, by the check that makes them: advice
// from these checks cites the refutation and stays below 'action'
const FB8 = 'analysis/fireball-0928/FINDINGS.md section 8';
const REFUTED = {
    C10: `the landed-while-moving test runs on 1 s windows and its rate gate can pass on vibration alone (${FB8}, CYC-LANDED: refuted)`,
    T4: `a burst frequency in the 5-16 Hz band can follow the spectral tilt of the band rather than a mode, and the gain sets compared may fly other headspeeds (${FB8}, TAIL-FREQ: refuted)`,
    T6: `the kick can follow signed collective or the pilot's yaw rather than the torque change (${FB8}, TAIL-PRECOMP: refuted, 72 of 78 kicks followed signed collective): T7 measures the precomp`,
    T9: `the I share is taken against the level before the manoeuvre, which can be a spin-up ramp (${FB8}, TAIL-FF: against hover the share was -0.10 +- 0.12)`,
    G6: `droop can build before the throttle reaches its ceiling (${FB8}, PWR-CEIL: 56-71 % of each droop did): saturation alone does not explain it`,
};

// CLI names this module may write (guard 12): [scope, header key, element (null scalar, 'all' whole array), 4.6 default].
// Names and defaults are health_setup.cjs PAIRS_PROFILE / PAIRS_GLOBAL and TUNING_KNOWLEDGE.md 2.5, 2.10, 3.2, 7.1;
// test/advice.test.cjs checks each against those files. Anything else gets advice text only.
const PARAMS = { blackbox_rate_denom: ['global', null, null, 8] };
for (const [ax, def] of [['roll', [50, 100, 0, 100, 0]], ['pitch', [50, 100, 40, 100, 0]], ['yaw', [80, 120, 10, 0, 0]]])
    ['p', 'i', 'd', 'f', 'b'].forEach((k, i) => { PARAMS[`${ax}_${k}_gain`] = ['profile', `${ax}PID`, i, def[i]]; });
Object.assign(PARAMS, {
    gov_p_gain: ['profile', 'govPID', 0, 40], gov_i_gain: ['profile', 'govPID', 1, 50], gov_f_gain: ['profile', 'govPID', 3, 10],
    yaw_cw_stop_gain: ['profile', 'yaw_stop_gain', 0, 120], yaw_ccw_stop_gain: ['profile', 'yaw_stop_gain', 1, 80],
    yaw_collective_ff_gain: ['profile', 'yaw_precomp', 2, 60], pitch_collective_ff_gain: ['profile', 'pitch_compensation', null, 0],
    gyro_lpf1_type: ['global', 'gyro_soft_type', null, 'FIRST_ORDER'], gyro_lpf1_static_hz: ['global', 'gyro_lowpass_hz', null, 100],
    gyro_lpf2_static_hz: ['global', 'gyro_lowpass2_hz', null, 50], gyro_lpf1_dyn_min_hz: ['global', 'gyro_lowpass_dyn_hz', 0, 0],
    dyn_notch_q: ['global', 'dyn_notch_q', null, 25], gyro_rpm_notch_preset: ['global', 'gyro_rpm_notch_preset', null, 2],
});
for (const ax of lib.AXES) for (const k of ['source', 'q', 'center']) PARAMS[`gyro_rpm_notch_${k}_${ax}`] = ['global', `gyro_rpm_notch_${k}_${ax}`, 'all', null];

// One row per parameter group of TUNING_KNOWLEDGE.md sections 1-11 (the coverage matrix of the survey):
// 'section|area|group|parameters (comma separated)|checks|cli = settings outside the header|why, where no check decides|nolog'
// nolog marks the groups no log can inform (from docs/TUNING_KNOWLEDGE.md sections 2-9: settings that no logged field shows): with no check
// they are 'not-assessable'; a group without a check that a log could inform is 'no-check' (the app has none).
const COVERAGE = [
    '1|logging|PID mode|pid_mode||cli|modes other than 3 and 4 are passthrough; 3 against 4 cannot be told from a log; all advice assumes 3 (TUNING_KNOWLEDGE 2.1); the CLI capture gives the value',
    '1|logging|Loop rates|pid_process_denom,filter_process_denom|D1 F8||',
    '1|logging|Logging rate|blackbox_rate_denom|D1 F9||',
    '1|logging|Logged fields|blackbox_log_*|D3||',
    '1|logging|Debug mode|debug_mode,debug_axis|||header only; GOVERNOR debug at 1 kHz for governor work (GOVT)',
    '2|cyclic|Cyclic P|roll_p_gain,pitch_p_gain|C5 C6 C7 C12||',
    '2|cyclic|Cyclic I|roll_i_gain,pitch_i_gain|C1 C3 C6||',
    '2|cyclic|Cyclic D|roll_d_gain,pitch_d_gain|C11 C5 F4||',
    '2|cyclic|Cyclic F|roll_f_gain,pitch_f_gain|C3 C4 C7||',
    '2|cyclic|Cyclic B|roll_b_gain,pitch_b_gain|C4 C13||too low shows as lag (C13), too high as oscillation at stops (C4)',
    '2|cyclic|HSI offset gain|roll_o_gain,pitch_o_gain|C9||report only',
    '2|cyclic|HSI offset limit|offset_limit|||no check: data would be axisO pinned against the limit',
    '3|cyclic|Error limit|error_limit|C1||',
    '3|cyclic|I-term relax|iterm_relax_type,iterm_relax_cutoff|C4 C6||',
    '3|cyclic|I-term relax level|iterm_relax_level||cli|CLI only; no check|nolog',
    '3|cyclic|Cyclic error decay|error_decay_time_cyclic,error_decay_limit_cyclic|C10||',
    '3|cyclic|Ground error decay|error_decay_time_ground|C10||',
    '3|tail|Yaw error decay|error_decay_time_yaw,error_decay_limit_yaw||cli|no documented symptom|nolog',
    '3|precondition|Airborne detection|rc_threshold|C10|cli|',
    '3|cyclic|Offset flood|offset_flood_relax_level,offset_flood_relax_cutoff||cli|looks nearly inactive (TUNING_KNOWLEDGE question 13)|nolog',
    '4|cyclic|Cyclic cross-coupling|cyclic_cross_coupling_gain,cyclic_cross_coupling_ratio,cyclic_cross_coupling_cutoff|C8||report only, no threshold',
    '4|cyclic|Pitch collective FF|pitch_collective_ff_gain|C14||',
    '5|rates|Rates type|rates_type|SETUP||header rule: 6 = ROTORFLIGHT is the 4.6 default',
    '5|rates|Rates and expo|roll_rc_rate,pitch_rc_rate,yaw_rc_rate,roll_expo,pitch_expo,yaw_expo,roll_srate,pitch_srate,yaw_srate|C2 T8||rates beyond the authority show as flat tops',
    '5|rates|Response time|roll_response,pitch_response,yaw_response,collective_response|R1||',
    '5|rates|Acceleration limit|roll_accel_limit,pitch_accel_limit,yaw_accel_limit,collective_accel_limit|R1||',
    '5|rates|Cyclic ring|cyclic_ring,cyclic_polar||cli|clips the setpoint; not assessable|nolog',
    '5|rates|Setpoint boost|setpoint_boost_gain,setpoint_boost_cutoff||cli|inside setpoint; no check',
    '5|rates|Stick smoothing|rc_smoothness|R1|cli|',
    '5|rates|Deadband|deadband,yaw_deadband|||no check (data would be yaw rcCommand rebound at stops)',
    '5|rates|Yaw dynamic deadband|yaw_dynamic_ceiling_gain,yaw_dynamic_deadband_gain,yaw_dynamic_deadband_filter,yaw_dynamic_deadband_cutoff||cli|not in the doc; not assessable|nolog',
    '6|tail|Yaw P|yaw_p_gain|T1 T4 C7 T11||',
    '6|tail|Yaw I|yaw_i_gain|T2||',
    '6|tail|Yaw D|yaw_d_gain|T1 F10||',
    '6|tail|Yaw F|yaw_f_gain|T9||',
    '6|tail|Yaw B|yaw_b_gain|||no guidance in the doc',
    '6|tail|Stop gains|yaw_cw_stop_gain,yaw_ccw_stop_gain|T5||',
    '6|tail|Collective precomp|yaw_collective_ff_gain|T6 T7||',
    '6|tail|Precomp cutoff|yaw_precomp_cutoff|||no check measures the kick lag (TUNING_KNOWLEDGE kick-lag row, [INF]); T6 measures the kick size and sign only',
    '6|tail|Cyclic precomp|yaw_cyclic_ff_gain|||no check (data would be yaw error at cyclic onset)',
    '6|tail|Inertia precomp|yaw_inertia_precomp_gain,yaw_inertia_precomp_cutoff|T14||no documented procedure (TUNING_KNOWLEDGE question 5)',
    '6|mechanical|Tail mechanics and limit|tail_rotor_mode,tail_motor_idle,tail_center_trim,mixer input SY,main_rotor_dir|T8 T13|cli|',
    '6|tail|TTA|gov_tta_gain,gov_tta_limit,gov_tta_filter,swash_tta_precomp|||motorised tails only; no check (data would be mixer[2] at idle while the error is with the torque)',
    '7|governor|Governor mode|gov_mode|G0 D4||',
    '7|governor|Governor F|gov_f_gain|G3 G4||',
    '7|governor|Governor I|gov_i_gain|G9 G2||',
    '7|governor|Governor P|gov_p_gain|G9 G5||',
    '7|governor|Governor D|gov_d_gain|||"Unless you\'re flying a 500+ heli you probably won\'t need D" (GOVT)',
    '7|governor|Governor gain|gov_gain|G9 G10||',
    '7|governor|Governor FF weights|gov_collective_ff_weight,gov_cyclic_ff_weight,gov_yaw_ff_weight,gov_collective_curve|G3 G4|cli|',
    '7|governor|Governor limits|gov_p_limit,gov_i_limit,gov_d_limit,gov_f_limit|G3 G7|cli|',
    '7|governor|Headspeed request|gov_headspeed|G1 G2|cli|',
    '7|governor|Throttle limits|gov_max_throttle,gov_min_throttle|G6 G7|cli|',
    '7|governor|Voltage compensation|gov_use_voltage_comp|G8 G11 G13 D5|cli|',
    '7|governor|Governor filters|gov_rpm_filter,gov_pwr_filter,gov_ff_filter,gov_d_filter|G1 G10|cli|',
    '7|governor|Ramp times|gov_startup_time,gov_spoolup_time,gov_tracking_time,gov_recovery_time,gov_spooldown_time|G14|cli|',
    '7|governor|Handover and autorotation|gov_handover_throttle,gov_autorotation_timeout,gov_auto_throttle,gov_idle_throttle,gov_throttle_hold_timeout,gov_bypass_throttle|G14|cli|',
    '7|governor|Throttle channel type|gov_throttle_type||cli|no check (data would be the quantisation of govRequest)',
    '7|governor|Fallback|gov_fallback_drop,gov_use_fallback_precomp|G1|cli|',
    '7|governor|PID spool-up and dynamic minimum|gov_use_pid_spoolup,gov_use_dyn_min_throttle,gov_dyn_min_throttle||cli|not assessable (motor[0] floor only)|nolog',
    '8|precondition|Motor poles and gear ratios|motor_poles,main_rotor_gear_ratio,tail_rotor_gear_ratio|G12 F5 F6|cli|',
    '8|precondition|Motor RPM filter|motor_rpm_lpf,motor_rpm_factor||cli|not assessable|nolog',
    '8|precondition|RPM source and motor protocol|dshot_bidir,motor_pwm_protocol,motor_pwm_rate,use_unsynced_pwm,feature FREQ_SENSOR,freq_input_*|G1||ESC serial telemetry is too slow to be an RPM source (RPMM)',
    '8|precondition|ESC endpoints|min_throttle,max_throttle|||not assessable|nolog',
    '8|precondition|ESC telemetry|esc_sensor_*,blackbox_log_esc|||no check reads ESC telemetry (Tesc, EscV, EscI, EscRPM, EscThr; Ibat and Vbat when the ESC is the meter source): D3 only lists which fields are logged (Logged fields), G12 uses gyroRAW lines, not EscRPM',
    '9|filters|Gyro LPF1|gyro_lpf1_type,gyro_lpf1_static_hz|F1 F2 F11||',
    '9|filters|Gyro LPF2|gyro_lpf2_type,gyro_lpf2_static_hz|F1 F2||',
    '9|filters|Dynamic LPF1|gyro_lpf1_dyn_min_hz,gyro_lpf1_dyn_max_hz|F1 F2||',
    '9|filters|Hardware LPF and decimation|gyro_hardware_lpf,gyro_decimation_hz|||report only (SETUP)',
    '9|filters|Static notches|gyro_notch1_hz,gyro_notch1_cutoff,gyro_notch2_hz,gyro_notch2_cutoff|||F7 (lines that do not scale with rpm) does not run in the app',
    '9|filters|Dynamic notch|feature DYN_NOTCH,dyn_notch_count,dyn_notch_q,dyn_notch_min_hz,dyn_notch_max_hz|F3 F8||',
    '9|filters|RPM notches|feature RPM_FILTER,gyro_rpm_notch_preset,gyro_rpm_notch_min_hz,gyro_rpm_notch_source_*,gyro_rpm_notch_q_*,gyro_rpm_notch_center_*|F3 F5 F6 F9||',
    '9|filters|PID bandwidth filters|roll_gyro_cutoff,pitch_gyro_cutoff,yaw_gyro_cutoff,roll_d_cutoff,pitch_d_cutoff,yaw_d_cutoff,roll_b_cutoff,pitch_b_cutoff,yaw_b_cutoff|F4 C13 T12 F10||',
    '9|filters|Vibration level|(no parameter)|F10 F11 C11||no official number exists (FILT); F7 does not run in the app',
    '10|mechanical|Cyclic mixer limits|mixer input SR,mixer input SP|C2|cli|',
    '10|mechanical|Collective range|mixer input SC|C2||',
    '10|mechanical|Swash ring and pitch limit|swash_ring,swash_pitch_limit|C2|cli|',
    '10|mechanical|Swash phase|swash_phase|C8|cli|',
    '10|mechanical|Swash geometry and trims|swash_type,swash_*_trim,swash_geo_correction,collective_tilt_correction_pos,collective_tilt_correction_neg||cli|not assessable (a constant axisI offset hints at it)|nolog',
    '10|mechanical|Servos|servo n mid min max rneg rpos rate speed flags||cli|min/max are binding limits, never for range (SERVO); speed equalisation has no check|nolog',
    '11|precondition|Rescue|rescue_*|D6|cli|assessable only when rescue ran; its spans are excluded from the analysis',
    '11|precondition|Level modes|angle and horizon settings (header levelPID)|D6||not assessable; their spans are excluded',
    '11|precondition|Battery and cells|battery_meter,battery_cell_count,vbat_min_cell_voltage,vbat_warning_cell_voltage,vbat_max_cell_voltage|D5 G13 G8|cli|',
    '11|precondition|Gyro overflow|gyro_overflow_detect|||an overflow resets all PID state (pid.c:1739); no check',
];

// fields a check needs (health_setup D3), for the needs-fields status of the coverage rows
const RAW = ['gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]'], GOVF = ['govTarget', 'govSum'];
const FIELDS = { F5: RAW, F6: RAW, F11: RAW, G0: GOVF, G2: GOVF, G3: GOVF.concat('setpoint[3]'), G4: GOVF.concat('setpoint[3]'), G5: GOVF, G9: GOVF,
    G6: ['motor[0]'], G7: ['motor[0]'], G8: ['motor[0]', 'Vbat'], G11: ['motor[0]', 'Vbat'], D5: ['Vbat'], G13: ['Vbat'], C9: ['axisO[0]', 'axisO[1]'], T6: ['setpoint[3]'] };
const ELSEWHERE = ['T3', 'T10', 'F7'];  // section-10 checks that no module of the app runs
// D3 skip names of checks that exist in no module: battery current (Ibat) and G12 from the ESC rpm (EscRPM); no check
// reads Ibat, Tesc or any ESC telemetry field (coverage row 'ESC telemetry')
const NO_CHECK = /^(power\/current|G12 \(independent rpm\)) \(/;
const NEW = { 'health_track.cjs': ['C5', 'T1', 'C12', 'T11', 'C13', 'T12', 'R1'], 'health_more.cjs': ['D6', 'F10', 'F11', 'T13', 'C14', 'T14', 'G14'] }; // the checks added for the Tuning dialog (docs/DEVELOPMENT.md section 13)

const UNITS = { D1: 'Hz', D2: 'frames', D3: 'checks', D4: 'values', D5: 'V', G0: 'samples', G1: 'entries', G2: 'fraction', G3: 'fraction', G4: 'fraction', G5: 's', G6: '%',
    G7: 'fraction', G8: 'ratio', G9: 'prominence', G10: 'coherence', G11: '% points per pack', G12: 'x headspeed/60', G13: 'V/cell', C1: 's', C2: 's', C3: 'fraction', C4: '%',
    C6: 'prominence', C8: 'deg/s per deg/s^2', C9: 'deg/s', C10: 's', C11: 'fraction', T2: 'prominence', T4: 'fraction', T5: 'ratio', T6: 'deg/s', T7: 'r', T8: 's',
    T9: 'fraction', F1: 'stages', F2: 'Hz', F3: 'Q', F4: 'Hz', F5: 'x rotor', F6: 'dB', F8: 'on/off', F9: 'notches' };
const RATES_TYPES = ['NONE', 'BETAFLIGHT', 'RACEFLIGHT', 'KISS', 'ACTUAL', 'QUICK', 'ROTORFLIGHT']; // TUNING_KNOWLEDGE 2.12

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const num = (v) => typeof v === 'number' && isFinite(v) ? v : null;
const fmt = (v, d = 2) => num(v) === null ? 'n/a' : String(+v.toFixed(d));
const pct = (v, d = 0) => num(v) === null ? 'n/a' : (100 * v).toFixed(d) + ' %';
const arr = (v) => Array.isArray(v) ? v : v === null || v === undefined ? null : [v];
const pick = (v, i) => v === undefined || v === null ? null : i === null || i === 'all' ? v : (arr(v)[i] === undefined ? null : arr(v)[i]);
const sum = (list) => list.reduce((s, f) => s + (num(f.value) || 0), 0);
const isFlag = (f) => f.severity === 'flag';
const thin = (f) => /^no finding/.test(String(f.text || ''));
const measured = (f) => (f.severity === 'flag' || f.severity === 'ok' || f.severity === 'note') && !thin(f);
const logsOf = (f) => Array.isArray(f.log) ? f.log : f.log === null || f.log === undefined ? [] : [f.log];
const lab = (l, c) => typeof l === 'number' && c ? l + c.logBase : l; // a log as the reader counts them (input.logBase)
const logList = (list, c) => [...new Set(list.flatMap(logsOf))].map(l => lab(l, c)).join(', ');
const profileOf = (f) => { const p = typeof f.profile === 'string' && /^\d+$/.test(f.profile) ? +f.profile : num(f.profile); return f.id === 'D4' && p !== null ? p + 1 : p; };
const axisOf = (f) => f.axis || (f.id === 'F4' ? f.profile : (/^(roll|pitch|yaw)\b/.exec(String(f.text || '')) || [])[1]) || null;
const matchNum = (re, s) => { const m = re.exec(String(s || '')); return m ? +m[1] : null; };
const textOf = (list) => list.length ? String(list[0].text) : '';
function group(list, key) { const m = new Map(); for (const x of list) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }

function evidence(f) {
    const times = Array.isArray(f.times) ? f.times : (f.events || []).map(e => e.t).filter(t => typeof t === 'number');
    return { module: f.module || null, id: f.id, log: f.log === undefined ? null : f.log, profile: f.profile === undefined ? null : f.profile, axis: axisOf(f),
        value: f.value === undefined ? null : f.value, se: num(f.se), n: f.n === undefined ? null : f.n, unit: f.unit || UNITS[f.id] || null,
        threshold: f.threshold === undefined ? null : f.threshold, source: f.source || null, text: String(f.text || ''), times: times.slice(0, 200),
        ...(Array.isArray(f.filterPass) ? { filterPass: f.filterPass } : {}) };
}

// scope of a parameter named without CLI (PARAMS has the rest): axis settings are per PID profile, rates_type per rate profile
const scopeOf = (k) => PARAMS[k] ? PARAMS[k][0] : k === 'rates_type' ? 'rateprofile' : /^(roll|pitch|yaw)_/.test(k) ? 'profile' : 'global';
function rec(o) {
    if (o.parameter && o.scope === undefined) o = Object.assign({}, o, { scope: scopeOf(o.parameter) });
    return Object.assign({ id: '', area: 'precondition', order: 0, severity: 'check', title: '', text: '', parameter: null, scope: null, cliProfile: null, profile: null, axis: null,
        from: null, to: null, direction: 'check', cli: [], evidence: [], rule: '', confidence: 'advisory', blockedBy: [], caveats: [] }, o,
        { evidence: (o.evidence || []).slice(), caveats: (o.caveats || []).slice(), blockedBy: (o.blockedBy || []).slice() });
}
// one recommendation from the findings `sel`, none when it is empty
const one = (sel, o) => sel.length ? [rec(Object.assign({ evidence: sel.map(evidence) }, o))] : [];

// Estimate over logs, the flight being the independent unit: the inverse-variance mean when every log has an SE, with
// SE the larger of the inverse-variance SE and the between-log SE (sd / sqrt(n)); a single log keeps its own SE.
function pooled(items) {
    const v = items.filter(x => num(x[0]) !== null);
    if (!v.length) return null;
    if (v.length === 1) return { value: v[0][0], se: num(v[0][1]), n: 1 };
    const m = v.reduce((s, x) => s + x[0], 0) / v.length, seB = Math.sqrt(v.reduce((s, x) => s + (x[0] - m) ** 2, 0) / (v.length - 1) / v.length);
    if (!v.every(x => num(x[1]) > 0)) return { value: m, se: seB, n: v.length };
    const w = v.map(x => 1 / x[1] ** 2), W = w.reduce((s, x) => s + x, 0);
    return { value: v.reduce((s, x, i) => s + w[i] * x[0], 0) / W, se: Math.max(1 / Math.sqrt(W), seB), n: v.length };
}

// guard 4: does estimate e clear threshold thr by RULES.sigmas SE (side 1 above, -1 below, 0 on |value|)? null when it
// cannot be tested (no SE or no threshold)
function clears(e, thr, side) {
    if (!e || num(e.value) === null || num(e.se) === null || num(thr) === null) return null;
    const k = RULES.sigmas * e.se;
    return side < 0 ? e.value + k < thr : side === 0 ? Math.abs(e.value) - k > thr : e.value - k > thr;
}
const fails = (e, thr, side, what) => clears(e, thr, side) === false ? `${what} ${fmt(e.value, 3)} +- ${fmt(e.se, 3)} (${e.n} log(s)) does not clear ${side < 0 ? '<' : '>'} ${thr} by ${RULES.sigmas} SE` : null;
function sig(r, e, id) {
    const [t, side] = SIGMA[id] || [null, 1], thr = t === null ? num(r.evidence.length ? r.evidence[0].threshold : null) : t;
    r.sig = fails(e, thr, side, id);
    return r;
}
// a diagnostic over several log-profile pairs stands when any flagged pair clears its 2-SE test (pairs are not pooled:
// one profile may oscillate while the others do not)
function sigAny(r, list, id) {
    const fl = list.filter(isFlag), tests = fl.map(f => { const t = SIGMA[id] || [null, 1], thr = t[0] === null ? num(f.threshold) : t[0]; return fails({ value: f.value, se: num(f.se), n: 1 }, thr, t[1], id); });
    r.sig = fl.length && tests.every(Boolean) ? `${tests[0]}, nor does any other flagged pair` : null;
    return r;
}

// Findings of one check grouped by key (default axis and log profile): the groups with at least one flag, each holding
// every measured finding of the group (flags, ok and real notes), so that estimates are not taken from the flags alone.
function flagged(L, key) {
    return [...group(L.filter(measured), key || ((f) => `${axisOf(f) || ''}|${f.profile}`)).values()].filter(list => list.some(isFlag));
}

// The present value of a parameter on log profile p: the log header when it holds that profile (global settings
// always), else the CLI capture when it has that profile's section (a diff leaves the 4.6 defaults out of a section it
// prints), else the header marked unsure. A section the capture lacks is unknown, not default: a plain `diff` or `dump`
// prints the current profile only (RULES.source.pidProfiles).
function current(c, param, p) {
    const [scope, key, idx, def] = PARAMS[param], hv = key ? pick(c.header[key], idx) : null;
    const own = scope === 'global' || (p > 0 && p === c.headerProfile);
    if (hv !== null && own) return { value: hv, source: scope === 'global' ? 'log header' : `log header, profile ${p} at arming` };
    const sc = !c.cli ? null : scope === 'global' ? c.cli.global : p > 0 ? c.cli.profiles[String(p - 1)] || null : null;
    if (sc && !c.staleCli.has(param)) {
        const cv = sc[param];
        if (cv !== undefined && cv !== null) return { value: cv, source: `CLI ${c.cli.kind}${scope === 'global' ? '' : `, profile ${p - 1}`}` };
        if (c.cli.kind === 'diff' && def !== null) return { value: def, source: `CLI diff${scope === 'global' ? '' : `, profile ${p - 1}`}: absent, so the 4.6 default` };
    }
    return hv === null ? null : { value: hv, source: `log header of arming profile ${c.headerProfile || 'unknown'}`, unsure: true, noSection: !!c.cli && scope !== 'global' && p > 0 && !sc, staleCli: !!sc && c.staleCli.has(param) };
}

// A change of one parameter on log profile o.profile: o.mult (relative) or o.delta (measured absolute change), both
// bounded to RULES.maxStep of the present value (o.asks names what asks for more than the bound; default the
// measurement); o.add, a documented absolute step; o.to, a documented value. Every value stays within its firmware
// range (RANGE). The CLI is written at the end, after the guards (finish).
function change(c, o) {
    const P = PARAMS[o.parameter], r = rec(Object.assign({ severity: 'action', scope: P[0] }, o)), b = current(c, o.parameter, o.profile), lim = RANGE[o.parameter];
    if (!b || typeof b.value !== 'number') { r.severity = 'check'; r.caveats.push(`present ${o.parameter} unknown: it is not in the log header or a CLI dump`); return r; }
    let to;
    if (o.to !== undefined) to = o.to;
    else if (o.add !== undefined) { to = lim ? b.value + o.add : Math.max(0, b.value + o.add); if (Math.abs(o.add) >= 0.5 * b.value) r.caveats.push(`the documented step ${Math.abs(o.add)} is at least half the present ${b.value}: consider half a step`); }
    else { const want = o.mult !== undefined ? b.value * o.mult : b.value + o.delta, step = RULES.maxStep * Math.abs(b.value), lo = b.value - step, hi = b.value + step;
        to = Math.round(Math.min(hi, Math.max(lo, want)));
        if (to > hi) to = Math.floor(hi); else if (to < lo) to = Math.ceil(lo);   // rounding never takes a bounded step past the bound
        if (b.value !== 0 && Math.abs(want - to) > 0.5) r.caveats.push(`step bounded to ${RULES.maxStep * 100} % (guard 5): ${o.asks || 'the measurement'} asks for ${fmt(want, 1)}`); }
    const asked = to;
    if (lim && typeof to === 'number' && (to < lim[0] || to > lim[1])) { to = Math.min(lim[1], Math.max(lim[0], to));
        r.caveats.push(`${o.parameter} is limited to ${lim[0]}-${lim[1]} by the firmware (settings.c; the CLI refuses a value outside it): ${asked} becomes ${to}`); }
    Object.assign(r, { from: b.value, to, base: b, sets: [[o.parameter, to]] });
    r.text += ` ${o.parameter} ${b.value} (${b.source}) -> ${to}.`;
    if (to === b.value) { r.sets = null;
        if (to !== asked) { r.severity = 'watch'; r.caveats.push(`${o.parameter} is at its firmware limit ${to}: no further step this way` + (/_stop_gain$/.test(o.parameter) ? '; the ratio of the two stop gains matters more [COM]: move the other one' : '')); }
        else { r.severity = b.value === 0 ? 'check' : 'watch';
            r.caveats.push(b.value === 0 ? `${o.parameter} is 0: a step bounded to ${RULES.maxStep * 100} % cannot start from 0 (report.cjs never changes a gain at 0); start low and fly again` : 'the bounded step rounds to no change'); } }
    if (b.unsure) r.caveats.push(`present value ${b.value} is from the ${b.source}; profile ${o.profile} may hold another value: ` + (b.noSection
        ? `the CLI capture has no profile ${o.profile - 1} section (a plain diff or dump prints the current profile only): load \`diff all\``
        : b.staleCli ? 'the CLI capture disagrees with the log header on it (D4), so its value is not used: confirm it or load a current `diff all`' : 'confirm it or load a CLI dump'));
    return r;
}

// per-profile recommendations from the flags of one check: o.size(flags, estimate, axis, profile, group) returns the
// change (with parameter) or a plain recommendation; o.test(group, estimate) replaces the default 2-SE test
function perProfile(L, c, id, o) {
    return flagged(L, o.key).map(list => {
        const fl = list.filter(isFlag), p = profileOf(fl[0]), ax = o.axis || axisOf(fl[0]), e = pooled(list.map(o.estimate || ((f) => [f.value, f.se]))) || { value: null, se: null, n: 0 };
        const s = o.size(fl, e, ax, p, list); if (!s) return null;
        const base = { id: `${id}:${s.parameter || ax || 'all'}:p${p}`, area: o.area, axis: ax, profile: p, evidence: list.map(evidence), rule: o.rule };
        const r = s.parameter ? change(c, Object.assign(base, s)) : rec(Object.assign(base, s));
        if (o.test) r.sig = o.test(list, e); else sig(r, e, id);
        return r;
    }).filter(Boolean);
}
const flagLogs = (list) => `flag in ${list.filter(isFlag).length} of ${list.length} measured log(s)`;
// C3, T9: the I share when it decided, else the gyro/setpoint ratio outside its band
const shareTest = (id, R) => (list, e) => Math.abs(e.value) > R.iShare ? fails(e, R.iShare, 0, `${id} I share`)
    : fails(pooled(list.map(f => f.gyroRatio ? [f.gyroRatio.mean - 1, f.gyroRatio.se] : [null])), (R.gyroRatio[1] - R.gyroRatio[0]) / 2, 0, `${id} gyro/setpoint - 1`);

const lpfStages = (h) => [h.gyro_soft_type > 0 && h.gyro_lowpass_hz > 0 && { name: 'LPF1', param: 'gyro_lpf1_static_hz', hz: h.gyro_lowpass_hz },
    h.gyro_soft2_type > 0 && h.gyro_lowpass2_hz > 0 && { name: 'LPF2', param: 'gyro_lpf2_static_hz', hz: h.gyro_lowpass2_hz },
    h.gyro_soft_type > 0 && pick(h.gyro_lowpass_dyn_hz, 0) > 0 && { name: 'dynamic LPF1 minimum', param: 'gyro_lpf1_dyn_min_hz', hz: pick(h.gyro_lowpass_dyn_hz, 0) }].filter(Boolean);
const feature = (h, name) => num(h.features) === null ? null : ((h.features >>> setup.FEATURE_BITS[name]) & 1) === 1;
const notchArrays = (h, ax) => ({ source: arr(h[`gyro_rpm_notch_source_${ax}`]), q: arr(h[`gyro_rpm_notch_q_${ax}`]), center: arr(h[`gyro_rpm_notch_center_${ax}`]) });
// The gear of a CLI capture as health_setup.cjs gearOf builds it (that one takes a ctx and is not exported): every
// tail_rotor_mode but VARIABLE drives the tail with its own motor (mixer.h:142-145); a diff leaves the 1,1 defaults out
function gearOf(cli) {
    if (!cli) return null;
    const g = cli.global, d = cli.kind === 'diff' ? [1, 1] : null, mode = g.tail_rotor_mode === undefined || g.tail_rotor_mode === null ? 'VARIABLE' : String(g.tail_rotor_mode).trim().toUpperCase();
    return { main: arr(g.main_rotor_gear_ratio) || d, tail: arr(g.tail_rotor_gear_ratio) || d, motorisedTail: mode !== 'VARIABLE' && mode !== '0', mode };
}
// tail-rotor harmonics 1-4 as multiples of the headspeed (health_setup decodeNotchSource: k x tail[1]/tail[0] on a belt
// or shaft tail); none on a motorised tail, whose rotor is not locked to the main rotor, nor without the tail ratio
const tailOrders = (gear) => gear ? [1, 2, 3, 4].map(k => ({ k, o: setup.decodeNotchSource(20 + k, gear).order })).filter(x => x.o !== null) : null;
// pid_mode of each profile section of the CLI capture (not in the log header, TUNING_KNOWLEDGE 2.1); a diff leaves the default 3 out
const pidModes = (c) => c.cli ? Object.keys(c.cli.profiles).sort((a, b) => a - b).map(p => { const v = c.cli.profiles[p].pid_mode, absent = v === undefined || v === null;
    return { profile: +p, value: !absent ? v : c.cli.kind === 'diff' ? 3 : null, absent }; }) : null;

// ---------------------------------------------------------------------------------------------
// Generators: one per check id, (findings with that id, context) -> recommendations
// ---------------------------------------------------------------------------------------------

// header checks without the analysed log's header: report the flags, change nothing
const noHeader = (id, area, bad, c) => one(bad, { id, area, title: `${id} flagged; the analysed header is not available`, rule: `${id}: header rule`, text: `${textOf(bad)} (log(s) ${logList(bad, c)}). Without the analysed log's header the present setting is unknown.` });
// a diagnostic: the flags of a check -> one 'check' with the first finding's text and the advice (o overrides)
const diag = (id, area, title, rule, advice, o) => (L, c) => { const bad = L.filter(isFlag), t = textOf(bad).replace(/[.\s]+$/, '');
    return one(bad, Object.assign({ id, area, title, rule, text: `${bad.length > 1 ? `${bad.length} log-profile pairs, e.g. log ${logList(bad.slice(0, 1), c)}: ` : ''}${t}. ${advice}` }, o)); };
// the same per axis; advice may read the axis' findings
const perAxis = (id, area, title, rule, advice) => (L) => [...group(L.filter(isFlag), axisOf)].map(([ax, list]) => rec({ id: `${id}:${ax}`, area, axis: ax, title: `${ax} ${title}`, evidence: list.map(evidence), rule,
    text: `${String(list[0].text).replace(/[.\s]+$/, '')}${list.length > 1 ? ` (${list.length} log-profile pairs)` : ''}. ${typeof advice === 'function' ? advice(list) : advice}` }));

const GEN = {
    D1(L, c) {
        const bad = L.filter(isFlag); if (!bad.length) return [];
        const h = c.header, pid = h.looptime ? 1e6 / h.looptime / (h.pid_process_denom || 1) : null; if (pid === null) return noHeader('D1', 'logging', bad, c);
        const denomNow = h.frameIntervalPNum ? Math.round((h.frameIntervalPDenom || 1) / h.frameIntervalPNum) : null, logHz = pid && denomNow ? pid / denomNow : null;
        const base = { id: 'D1', area: 'logging', rule: `D1: nominal log rate >= ${RULES.minLogHz} Hz (${RULES.source.minLogHz})` };
        if (logHz !== null && logHz >= RULES.minLogHz) return one(bad, Object.assign(base, { severity: 'info', title: 'Some logs are below 1 kHz',
            text: `Log(s) ${logList(bad, c)} ran at ${bad.map(f => fmt(f.value, 0)).join(', ')} Hz: their vibration, D-noise and frequency results alias and are not trusted. The analysed log runs at ${fmt(logHz, 0)} Hz.` }));
        const to = pid ? Math.floor(pid / RULES.minLogHz) : 0;
        if (to < 1) return one(bad, Object.assign(base, { title: 'PID loop below 1 kHz', text: `The PID loop runs at ${fmt(pid, 0)} Hz, so no blackbox_rate_denom logs at ${RULES.minLogHz} Hz; vibration and D-noise results alias.` }));
        return one(bad, Object.assign(base, { severity: 'action', title: `Log at ${fmt(pid / to, 0)} Hz`, parameter: 'blackbox_rate_denom', scope: 'global', from: denomNow, to, direction: 'set', sets: [['blackbox_rate_denom', to]],
            text: `The log runs at ${fmt(logHz, 0)} Hz with the PID loop at ${fmt(pid, 0)} Hz: rotor and tail harmonics alias. Log rate = PID rate / blackbox_rate_denom (TUNING_KNOWLEDGE 7.4), so ${to} logs at ${fmt(pid / to, 0)} Hz.` }));
    },
    D2(L, c) {
        const bad = L.filter(isFlag), n = (f, re) => matchNum(re, f.text) || 0;
        const parser = bad.filter(f => f.source === 'parser'), lost = bad.filter(f => f.source !== 'parser' && (n(f, /^(\d+) logging gaps/) || n(f, /(\d+) time jumps/) || n(f, /(\d+) non-increasing/) || n(f, /(\d+) loopIteration jumps/)));
        const stalls = bad.filter(f => !parser.includes(f) && !lost.includes(f)), parts = [];
        if (stalls.length) parts.push(`${stalls.length} log(s) have loop stalls only (time jumps over contiguous loopIteration: no frame lost, the data are intact); a stall after disarm is harmless, one in flight delays the loop`);
        if (lost.length) parts.push(`${lost.length} log(s) lost frames or have logging gaps (logs ${logList(lost, c)}): results near those times are less reliable; check the logging device`);
        if (parser.length) parts.push(`${parser.length} log(s) could not be decoded (logs ${logList(parser, c)})`);
        return one(bad, { id: 'D2', area: 'logging', title: 'Logging gaps and loop stalls', rule: `D2: gaps <= ${SR.D2.maxGaps}, jumps <= ${SR.D2.maxJumps} (${SR.D2.source}); a diagnostic, never an action (guard 9)`, text: parts.join('. ') + '.' });
    },
    D3(L) {  // the parts naming checks that no module implements (NO_CHECK) are left out: logging those fields enables nothing
        const sk = L.filter(f => f.severity === 'note' && /^checks that cannot run: /.test(String(f.text))), count = new Map();
        for (const f of sk) for (const part of f.text.replace(/^checks that cannot run: /, '').split('; ')) if (!NO_CHECK.test(part)) count.set(part, (count.get(part) || 0) + 1);
        const items = [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k} in ${v} log(s)`); if (!items.length) return [];
        return one(sk, { id: 'D3', area: 'logging', severity: items.some(s => /gyroRAW|govTarget|govSum/.test(s)) ? 'check' : 'info', title: 'Log the fields some checks need',
            rule: `D3: checks whose fields are missing are skipped and named (${SR.D3.source}; CLAUDE.md "Handle missing fields")`,
            text: `Checks that could not run: ${items.join('; ')}. Enable the matching fields in the Blackbox tab (BB: "Command Setpoint Mixer PID Raw Gyro Gyro Battery RSSI RPM Motors Servos"); an all-zero Vbat means no sensor.` });
    },
    D4(L, c) {
        const out = c.cli ? [] : [rec({ id: 'D4:cli', severity: 'info', title: 'Load a CLI dump (diff all)', rule: 'settings outside the log header are CLI only (TUNING_KNOWLEDGE 2.4)',
            text: 'Without a CLI dump: D4 is skipped; tail notch orders are unknown, so F5 may flag lines a tail notch covers and F6 cannot measure tail notches; the governor headspeed and throttle ceiling are guessed and the cell count inferred; profile values come from the log header only, which holds the arming profile. Load the output of `diff all`.' })];
        const bad = L.filter(isFlag);
        return out.concat(one(bad, { id: 'D4', title: 'CLI dump and log header disagree', rule: `D4: any header value that differs from the CLI dump (${SR.D4.source}); trust the log header for header keys, the data for the governor mode`,
            text: `${bad.length} log(s) differ from the dump, e.g. log ${logList(bad.slice(0, 1), c)}: ${textOf(bad)} The dump is probably older or newer than the logs: get a current diff all. Values the dump contradicts are not used.` }));
    },
    D5: diag('D5', 'precondition', 'Battery voltage glitch or deep sag', `D5: Vbat step > ${GR.D5.step} V in 10 ms, or >= ${GR.D5.minS} s below ${GR.D5.minCell} V/cell (${GR.D5.source})`,
        'Check the battery, its connector and the voltage telemetry; power results (G8, G11, G13) are not interpreted there.'),
    D6(L, c) {
        const bad = L.filter(isFlag), ex = L.filter(f => f.severity === 'note' && !thin(f));
        return one(bad, { id: 'D6', title: 'Failsafe while airborne', rule: 'D6: failsafe active while airborne (pipeline, unvalidated)', text: `${fmt(sum(bad), 1)} s of failsafe while airborne in log(s) ${logList(bad, c)}: check the receiver link and the failsafe setup before tuning.` })
            .concat(one(ex, { id: 'D6:excluded', severity: 'info', title: 'Spans left out of the analysis', rule: 'D6: rescue, level modes, failsafe and ground contact are excluded (setpoint is logged before their overrides, pid.c:813-839)',
                text: ex.slice(0, 6).map(f => `log ${logList([f], c)}: ${f.text}`).join('; ') + (ex.length > 6 ? `; ${ex.length - 6} more` : '') }));
    },
    H(L) {
        const ch = L.filter(f => f.severity === 'note'), keys = new Map(); for (const f of ch) { const k = String(f.text).split(':')[0]; keys.set(k, (keys.get(k) || 0) + 1); }
        return one(ch, { id: 'H', area: 'logging', severity: 'info', title: 'Tuning history in these logs', rule: 'H: header changes between consecutive logs (log header)',
            text: `${ch.length} header changes: ${[...keys].slice(0, 12).map(([k, v]) => `${k} ${v}x`).join(', ')}${keys.size > 12 ? `, ${keys.size - 12} more keys` : ''}. Findings pooled over logs can mix setups; a change measured before the latest change of its parameter gets no CLI.` });
    },
    SETUP(L, c) {  // header rules of TUNING_KNOWLEDGE section 8, on the analysed log's header
        const h = c.header, out = [];
        if (num(h.rates_type) !== null && h.rates_type !== 6) out.push(rec({ id: 'SETUP:rates_type', area: 'rates', title: 'Rates type is not ROTORFLIGHT', parameter: 'rates_type', rule: 'header rule: rates_type 6 (ROTORFLIGHT) is the 4.6 default; another value is likely a restored 4.5 diff (TUNING_KNOWLEDGE 2.12, 8; NOTES)',
            text: `rates_type is ${h.rates_type} (${RATES_TYPES[h.rates_type] || 'unknown'}): check that the rate curves are the ones intended; a diff restored from 4.5 may keep ACTUAL.` }));
        for (const ax of ['roll', 'pitch']) { const i = pick(h[`${ax}PID`], 1);
            if (num(i) !== null && i >= RULES.mixtI) out.push(rec({ id: `SETUP:${ax}_i_gain`, area: 'cyclic', axis: ax, title: `${ax} I gain ${i}: the temporary mixer-limit trick?`, parameter: `${ax}_i_gain`, rule: `header rule: cyclic I >= ${RULES.mixtI} (${RULES.source.mixtI})`,
                text: `${ax} I is ${i}. If it was raised to find the mixer limits (MIXT), set it back before tuning.` })); }
        const pm = (pidModes(c) || []).filter(m => m.value !== null && Number(m.value) !== 3);  // CLI rule: pid_mode is not in the header
        if (pm.length) out.push(rec({ id: 'SETUP:pid_mode', area: 'logging', title: `PID mode ${[...new Set(pm.map(m => m.value))].join(', ')}: the advice assumes 3`, parameter: 'pid_mode', scope: 'profile',
            rule: 'CLI rule: pid_mode 3 is the 4.6 default; the firmware implements 3 and 4, anything else is passthrough, F only (TUNING_KNOWLEDGE 2.1, pid.c:1699-1741)',
            text: `pid_mode is ${pm.map(m => `${m.value} on CLI profile ${m.profile}`).join(', ')}: every gain recommendation here assumes 3. Mode 4 changes the units of the axis error, pitch B, roll B and D and the yaw precomp cutoff (CHG); other modes are passthrough. Check the mode before applying a gain change on those profiles.` }));
        return out;
    },
    F1(L, c) {
        const bad = L.filter(isFlag), none = L.filter(f => f.severity === 'note'); if (!bad.length && !none.length) return [];
        const h = c.header, act = lpfStages(h), base = { id: 'F1', area: 'filters', rule: 'F1: a gyro LPF when RPM filters are on (doc MSG gyroLowpassFilterHelp)' };
        if (h.gyro_soft_type === undefined) return noHeader('F1', 'filters', bad.concat(none), c);
        if (act.length) return one(bad.concat(none), Object.assign(base, { severity: 'info', title: 'Gyro LPF missing in older logs', text: `Log(s) ${logList(bad.concat(none), c)} had no gyro LPF; the analysed log has ${act.map(s => `${s.name} ${s.hz} Hz`).join(', ')}.` }));
        c.filterIssues.add('F1');
        if (!bad.length) return one(none, Object.assign(base, { title: 'No gyro LPF', text: `No gyro LPF and no RPM filter: "Without them, two second order filters are required"; with a dynamic notch, one filter around ${RULES.lpfHz} Hz (MSG gyroLowpassFilterHelp).` }));
        const sets = (h.gyro_soft_type > 0 ? [] : [['gyro_lpf1_type', 'FIRST_ORDER']]).concat([['gyro_lpf1_static_hz', RULES.lpfHz]]);
        return one(bad, Object.assign(base, { severity: 'action', title: `Add a ${RULES.lpfHz} Hz gyro LPF`, parameter: 'gyro_lpf1_static_hz', scope: 'global', from: num(h.gyro_lowpass_hz), to: RULES.lpfHz, direction: 'set', sets,
            rule: base.rule + `; cutoff ${RULES.lpfHz} Hz (${RULES.source.lpfHz})`, text: `No gyro LPF is active while the RPM filters are on; only the PID bandwidth filter smooths the gyro before P. Add a first-order LPF at ${RULES.lpfHz} Hz (the 4.6 default).`,
            caveats: ['a first-order 100 Hz LPF adds about 1.6 ms of delay (TUNING_KNOWLEDGE 7.3): re-check D noise (C11, F10) and the tracking checks after the change'] }));
    },
    F2(L, c) {
        const bad = L.filter(isFlag), mild = L.filter(f => f.severity === 'note'); if (!bad.length && !mild.length) return [];
        if (c.header.gyro_soft_type === undefined) return noHeader('F2', 'filters', bad.concat(mild), c);
        const st = lpfStages(c.header).sort((a, b) => a.hz - b.hz)[0], rule = `F2: lowest gyro LPF < ${RULES.minLpfHz} Hz flag, < ${RULES.noteLpfHz} Hz note (${RULES.source.minLpfHz})`;
        if (st && st.hz < RULES.minLpfHz) { c.filterIssues.add('F2');
            return one(bad.concat(mild), { id: `F2:${st.param}`, area: 'filters', severity: 'action', title: `Raise the ${st.name} cutoff to ${RULES.minLpfHz} Hz`, parameter: st.param, scope: 'global', from: st.hz, to: RULES.minLpfHz, direction: 'raise',
                sets: [[st.param, RULES.minLpfHz]], rule: rule + '; to the documented floor, not a relative step', text: `The ${st.name} cutoff is ${st.hz} Hz, below the documented floor of ${RULES.minLpfHz} Hz: more delay and lower achievable gains (FILT).`,
                caveats: ['a higher cutoff passes more vibration: re-check F5, F6 and the D noise checks after the change'] }); }
        if (st && st.hz < RULES.noteLpfHz) return one(bad.concat(mild), { id: 'F2', area: 'filters', severity: 'watch', title: `Gyro LPF at ${st.hz} Hz`, rule,
            text: `The lowest gyro LPF cutoff (${st.name} ${st.hz} Hz) is between ${RULES.minLpfHz} and ${RULES.noteLpfHz} Hz: allowed, but "better if this cutoff is high" (FILT).` });
        return one(bad.concat(mild), { id: 'F2', area: 'filters', severity: 'info', title: 'Low gyro LPF in older logs', rule, text: `Log(s) ${logList(bad.concat(mild), c)} had a gyro LPF below ${RULES.noteLpfHz} Hz; the analysed log has ${st ? `${st.name} ${st.hz} Hz` : 'none active (see F1)'}.` });
    },
    F3(L, c) {
        const bad = L.filter(isFlag); if (!bad.length) return [];
        if (c.header.dyn_notch_q === undefined && !lib.AXES.some(ax => c.header[`gyro_rpm_notch_q_${ax}`])) return noHeader('F3', 'filters', bad, c);
        const h = c.header, q = Math.round(RULES.minNotchQ * 10), out = [], base = { area: 'filters', evidence: bad.map(evidence), rule: `F3: notch Q >= ${RULES.minNotchQ} (${RULES.source.minNotchQ})` };
        if (feature(h, 'DYN_NOTCH') && num(h.dyn_notch_q) !== null && h.dyn_notch_q < q)
            out.push(rec(Object.assign({ id: 'F3:dyn_notch_q', severity: 'action', title: `Dynamic notch Q to ${RULES.minNotchQ}`, parameter: 'dyn_notch_q', scope: 'global', from: h.dyn_notch_q, to: q, direction: 'raise', sets: [['dyn_notch_q', q]],
                text: `dyn_notch_q is ${h.dyn_notch_q} (Q ${h.dyn_notch_q / 10}; x10 units): below ${RULES.minNotchQ} it "will greatly increase filter delay".` }, base)));
        for (const ax of lib.AXES) { const n = notchArrays(h, ax); if (!n.source || !n.q) continue;
            const low = n.q.map((v, i) => n.source[i] > 0 && v > 0 && v < q); if (!low.some(Boolean)) continue;
            const custom = h.gyro_rpm_notch_preset === 0, to = n.q.map((v, i) => low[i] ? q : v).join(',');
            out.push(rec(Object.assign({ id: `F3:gyro_rpm_notch_q_${ax}`, severity: custom ? 'action' : 'check', title: `${ax} RPM notch Q to ${RULES.minNotchQ}`, parameter: `gyro_rpm_notch_q_${ax}`, scope: 'global', from: n.q.join(','), to, direction: 'raise',
                sets: custom ? [[`gyro_rpm_notch_q_${ax}`, to]] : null, text: `${ax} RPM notch banks ${low.map((v, i) => v ? i : -1).filter(i => i >= 0).join(', ')} have Q below ${RULES.minNotchQ} (x10 values ${n.q.filter((v, i) => low[i]).join(', ')}).`
                    + (custom ? '' : ' A preset overwrites the custom banks at boot (rpm_filter.c validateAndFixRPMFilterConfig): set gyro_rpm_notch_preset = 0 first.') }, base)));
        }
        if (out.length) c.filterIssues.add('F3');
        return out.length ? out : one(bad, { id: 'F3', area: 'filters', severity: 'info', title: 'Notch Q below 2.0 in older logs', rule: base.rule, text: `Log(s) ${logList(bad, c)} had a notch Q below ${RULES.minNotchQ}; the analysed log has none.` });
    },
    F4(L) {
        return [...group(L.filter(f => f.severity === 'note'), f => f.profile)].map(([ax, list]) => rec({ id: `F4:${ax}_d_cutoff`, area: 'filters', severity: 'info', axis: ax, title: `${ax} D cutoff ${list[list.length - 1].value} Hz`,
            parameter: `${ax}_d_cutoff`, evidence: list.map(evidence), rule: `F4: D cutoff ${SR.F4.targetHz} +- ${SR.F4.toleranceHz} Hz (doc PROF "around 20Hz"; the tolerance is pipeline), advisory only`,
            text: `${list[list.length - 1].text} The logs imply no change.` + (ax === 'yaw' ? ' A decaying CCW-stop ring is a reason to go lower on yaw (20 -> 15 Hz, [COM] HF-965481).' : '') }));
    },
    F5(L, c) {
        const bad = L.filter(isFlag); if (!bad.length) return [];
        const h = c.header, tailUnknown = !c.cli && lib.AXES.some(ax => (notchArrays(h, ax).source || []).some(s => s >= 21 && s <= 28)), gear = gearOf(c.cli), tail = tailOrders(gear);
        const lines = bad.map(f => { const m = /line at ([\d.]+) x rotor \(([\d.]+) Hz, prominence ([\d.]+)/.exec(String(f.text)); return m ? { f, order: +m[1], hz: +m[2], prominence: +m[3] } : null; }).filter(Boolean);
        const top = lines.sort((a, b) => b.prominence - a.prominence)[0], k = top ? Math.max(1, Math.round(top.order)) : null;
        // the worker measures what the filters pass at each line of a log with curves (filterPass): a line they already
        // remove on every axis is no filter problem, whatever the notch arithmetic says
        const maxPass = (q) => q && lib.AXES.every(ax => num(q[ax]) !== null) ? Math.max(...lib.AXES.map(ax => q[ax])) : null;
        const passes = top && Array.isArray(top.f.filterPass) ? top.f.filterPass : [], pass = passes.find(q => Math.abs(q.hz - top.hz) < 0.5) || null, passMax = maxPass(pass);
        if (passMax !== null && passMax < RULES.filteredPass) {
            // weaker lines of the same finding that the filters pass more of: the low-pass attenuates them; whether that is
            // enough shows in the D-term and control noise (C11, F10), which raise their own filter items when it is not
            const through = passes.filter(q => q !== pass && maxPass(q) !== null && maxPass(q) >= RULES.filteredPass).sort((a, b) => maxPass(b) - maxPass(a));
            return [rec({ id: 'F5', area: 'filters', severity: 'info', title: through.length ? 'Strongest vibration line already filtered out' : 'Vibration line already filtered out', evidence: bad.map(evidence),
                rule: `F5 flag, but the gyro filters pass under ${RULES.filteredPass * 100} % of its strongest line (${RULES.source.filteredPass})`,
                text: `The strongest line, ${top.order} x rotor (${top.hz} Hz, prominence ${top.prominence}, log ${logList([top.f], c)} profile ${top.f.profile}), has no notch within ${SR.F5.maxDistance * 100} % by the notch arithmetic, `
                    + `but the measured gyroRAW -> gyroADC transmission there is ${lib.AXES.map(ax => `${ax} ${fmt(pass[ax] * 100, 1)} %`).join(', ')}: the filters already remove it, so no notch is needed. `
                    + (through.length ? `${through.length} weaker line(s) pass more (${through.slice(0, 4).map(q => `${q.hz} Hz up to ${fmt(maxPass(q) * 100, 0)} %`).join(', ')}${through.length > 4 ? ', ...' : ''}), attenuated by the low-pass only; `
                        + 'no notch is proposed for them unless the D-term or control noise checks (C11, F10) flag, because every notch adds filter delay (RPMF: minimize the filters used). ' : '')
                    + 'A line this strong is still worth a mechanical look (balance, blade tracking, bearings).' })];
        }
        c.filterIssues.add('F5');
        // an RPM notch tracks main-rotor harmonics 1-8 only (sources 11-18); 10 + k past that is a tail code or disables arming
        const harmonic = top && Math.abs(top.order / k - 1) <= GR.G12.tolerance, main = harmonic && k <= RULES.maxMainHarmonic;
        const near = top && tail && tail.length ? tail.map(({ k: j, o }) => ({ k: j, o, d: Math.abs(top.order / o - 1) })).sort((a, b) => a.d - b.d)[0] : null;
        c.topLine = top || null;
        const r = rec({ id: 'F5', area: 'filters', title: 'Vibration line without a notch', evidence: bad.map(evidence), rule: `F5: a gyroRAW line of prominence >= ${SR.F5.minProminence} with no notch within ${SR.F5.maxDistance * 100} % (${SR.F5.source}); guard 9`,
            text: `${bad.length} log-profile pair(s) show a strong rotor-order line that no notch covers within ${SR.F5.maxDistance * 100} %` + (top ? `; the strongest at ${top.order} x rotor (${top.hz} Hz, prominence ${top.prominence}, log ${logList([top.f], c)} profile ${top.f.profile}).` : '.') });
        if (tailUnknown) { r.caveats.push('no CLI dump: a tail-rotor notch (source 21-28) is configured but its order is unknown without tail_rotor_gear_ratio, so it may sit on this line (guard 9)');
            r.text += ' Load a CLI dump before changing filters.'; return [r]; }
        if (main) {  // a main-rotor harmonic: add the RPM notch the firmware names 10 + k (rpm_filter.c), Q 4.0 (FILT)
            const seg = String(top.f.text).split('; ').find(s => s.indexOf(`line at ${top.order} x`) === 0) || '';
            const uncovered = lib.AXES.filter(ax => { const m = new RegExp(`${ax} (?:\\d+ at [\\d.]+ \\(([\\d.]+) %\\)|none)`).exec(seg); return m && (m[1] === undefined || +m[1] > SR.F5.maxDistance * 100); });
            let sets = h.gyro_rpm_notch_preset === 0 ? [] : [['gyro_rpm_notch_preset', 0]];
            for (const ax of uncovered) { const n = notchArrays(h, ax), i = n.source && n.q && n.center ? n.source.indexOf(0) : -1; if (i < 0) { sets = null; break; }
                const put = (a, v) => a.map((x, j) => j === i ? v : x).join(',');
                sets.push([`gyro_rpm_notch_source_${ax}`, put(n.source, 10 + k)], [`gyro_rpm_notch_q_${ax}`, put(n.q, 40)], [`gyro_rpm_notch_center_${ax}`, put(n.center, 0)]); }
            Object.assign(r, { severity: 'action', title: `RPM notch at main harmonic ${k}`, parameter: uncovered.length ? `gyro_rpm_notch_source_${uncovered[0]}` : null, scope: 'global', direction: 'set', sets: uncovered.length ? sets : null });
            r.text += ` It is main-rotor harmonic ${k}: add an RPM notch with source ${10 + k}, Q 4.0 (FILT), on ${uncovered.join(', ') || 'the axes that lack it'}; custom banks need gyro_rpm_notch_preset = 0, and the header arrays hold the preset's banks, which are kept.`;
            return [r]; }
        if (harmonic) {  // main-rotor harmonic k > 8: no RPM notch source exists for it; the dynamic notch or a static notch
            const lo = num(h.dyn_notch_min_hz), hi = num(h.dyn_notch_max_hz), dyn = feature(h, 'DYN_NOTCH'), inside = dyn === true && lo !== null && hi !== null && top.hz >= lo && top.hz <= hi;
            Object.assign(r, { title: `Vibration at main harmonic ${k}, beyond the RPM notches`, rule: r.rule + `; RPM notches track main harmonics 1-${RULES.maxMainHarmonic} only (${RULES.source.maxMainHarmonic})` });
            r.text += ` It is main-rotor harmonic ${k}, beyond the ${RULES.maxMainHarmonic} an RPM notch can track (sources 11-18; another code but 10 and 20-28 disables arming), so no RPM notch is proposed. `
                + (inside ? `The dynamic notch is on and its range ${lo}-${hi} Hz holds the line at ${top.hz} Hz: check that dyn_notch_count leaves a notch for it.`
                    : top.hz > 500 ? `${top.hz} Hz is above the highest dyn_notch_max_hz (500 Hz, settings.c:681): the dynamic notch cannot reach it.`
                    : dyn === true ? `The dynamic notch is on, but its range ${lo}-${hi} Hz misses the line at ${top.hz} Hz: widen it to hold ${top.hz} Hz (dyn_notch_min_hz, dyn_notch_max_hz; CLI range of the maximum 100-500).`
                    : `Cover it with the dynamic notch: \`feature DYN_NOTCH\`, with a range that holds ${top.hz} Hz (dyn_notch_max_hz, CLI range 100-500); the firmware forces it off below 1 kHz PID rate (F8).`)
                + ' A static notch (gyro_notch1_hz, gyro_notch1_cutoff) sits at one frequency and suits one headspeed only. Check blade tracking and balance first (FILT).';
            return [r]; }
        r.text += near ? ` It is not a main-rotor harmonic; nearest at the configured tail_rotor_gear_ratio, tail harmonic ${near.k} sits at ${fmt(near.o, 4)} x rotor (${pct(near.d, 1)} away): check tail_rotor_gear_ratio against the parts, or inspect belt, pulley and bearings (line.cjs finds tooth ratios).`
            : gear && gear.motorisedTail ? ` It is not a main-rotor harmonic, and on a motorised tail (tail_rotor_mode ${gear.mode}) the tail rotor is not locked to the main rotor, so no tail harmonic sits at a fixed rotor order: compare the line with the tail motor speed, or inspect the main drive and its bearings (line.cjs finds tooth ratios).`
            : ' It is not a main-rotor harmonic: compare it with the tail ratio, or inspect belt, pulley and bearings (line.cjs finds tooth ratios).';
        return [r];
    },
    F6(L, c) {
        const bad = L.filter(isFlag); if (!bad.length) return [];
        const r = rec({ id: 'F6', area: 'filters', title: 'RPM notch attenuates too little', evidence: bad.map(evidence), rule: `F6: notch attenuation >= ${SR.F6.minDb} dB (${SR.F6.source})`,
            text: `${bad.length} notch-profile pair(s) attenuate less than ${SR.F6.minDb} dB, e.g. ${textOf(bad)} Mis-centred (check the gear ratios) or too narrow: re-centre (gyro_rpm_notch_center_*) or lower Q, never below ${RULES.minNotchQ}.` });
        if (bad.every(f => clears({ value: f.value, se: f.se }, SR.F6.minDb, -1) === false)) r.sig = `F6: no flagged notch is below ${SR.F6.minDb} dB by ${RULES.sigmas} SE`;
        if (!r.sig) c.filterIssues.add('F6');   // guard 1: a flag that stands (clears 2 SE, or has no SE) holds the gain raises
        return [r];
    },
    F8(L, c) {
        const sel = L.filter(f => f.severity === 'note'), unc = sel.filter(f => /without RPM notch coverage/.test(String(f.text))), forced = sel.filter(f => /forced off/.test(String(f.text)));
        return one(unc, { id: 'F8', area: 'filters', title: 'Dynamic notch off while lines lack a notch', rule: 'F8: dynamic notch state against the uncovered F5 lines (firmware: off below 1 kHz PID rate)',
            text: `The dynamic notch is off while strong lines lack an RPM notch (F5) in log(s) ${logList(unc, c)}: \`feature DYN_NOTCH\` turns it on, up to dyn_notch_max_hz ${fmt(c.header.dyn_notch_max_hz, 0)} Hz`
                + (c.topLine && num(c.header.dyn_notch_max_hz) !== null && c.topLine.hz > c.header.dyn_notch_max_hz ? `, below the strongest uncovered line at ${c.topLine.hz} Hz, which it cannot reach` : '') + '. Keep it on if autorotation is possible (RPMF).' })
            .concat(one(forced, { id: 'F8:pid', area: 'filters', severity: 'info', title: 'Dynamic notch forced off', rule: 'F8: the firmware forces the dynamic notch off below 1 kHz PID rate (dyn_notch_filter.c:89,164)', text: textOf(forced) }));
    },
    F9(L) {
        const sel = L.filter(f => f.severity === 'note');
        return one(sel, { id: 'F9', area: 'filters', severity: 'info', title: 'Notches above Nyquist or of unknown frequency', rule: 'F9: configured harmonics against the log Nyquist and the 0.45 x filter-rate ceiling (arithmetic)', text: `${sel.length} log(s): ${textOf(sel)}` });
    },
    F10(L, c) {
        const yaw = L.filter(f => axisOf(f) === 'yaw'), bad = yaw.filter(isFlag); if (bad.length) c.filterIssues.add('F10 yaw');
        const hz = MRULE.noise ? MRULE.noise.hz : null, rule = `F10: share of yaw axisD power above ${fmt(hz, 0)} Hz - ${RULES.sigmas} SE > ${fmt(SIGMA.F10[0])} (${ruleSrc(MR, 'F10')})`;
        return one(bad, { id: 'F10', area: 'filters', axis: 'yaw', title: 'Yaw D driven by noise', rule,
            text: `Yaw D is driven by noise above ${fmt(hz, 0)} Hz in log(s) ${logList(bad, c)}: check the tail notches (F5, F6) first; "keep D at 0 until RPM filters work" ([COM] RCG-71).` })
            .concat(perProfile(yaw, c, 'F10', { area: 'tail', axis: 'yaw', rule: `${rule}, pooled over the measured logs of the profile; one tail D step of ${RULES.tailDStep} (${RULES.source.tailDStep})`,
                size: () => ({ parameter: 'yaw_d_gain', add: -RULES.tailDStep, direction: 'lower', title: 'Lower yaw D', text: 'Yaw D amplifies vibration more than it damps the tail.', caveats: ['fixing the filters is the better cure; lowering D gives up some damping'] }) }));
    },
    F7: diag('F7', 'filters', 'Vibration level changed', 'F7: gyroRAW vibration level changes >= 2x between flight groups (pipeline; no official number exists, FILT)',
        'Check blade tracking and balance first ("Check them first", FILT); then the notches.'),
    F11: diag('F11', 'filters', 'Gyro filter delay is large', `F11: measured gyroRAW -> gyroADC delay at ${MRULE.delay ? MRULE.delay.band.join('-') : 'n/a'} Hz - ${RULES.sigmas} SE > ${fmt(ruleNum(MR, 'F11', 'flagMs'))} ms (${ruleSrc(MR, 'F11')})`,
        'Over-filtering costs phase: "a filter too strong ... may lower the maximum gains later" (FILT); "minimize the filters used" (RPMF). Review the LPF cutoffs and the notch count.'),
    G0(L, c) {
        const sel = L.filter(f => f.severity === 'note' && /DIRECT or LIMIT/.test(String(f.text)));
        return one(sel, { id: 'G0', area: 'governor', severity: 'info', title: 'Governor not regulating (DIRECT or LIMIT)', rule: `G0: govSum and govI are 0 in flight (${GR.G0.source}, governor.c:887-988)`,
            text: `In log(s) ${logList(sel, c)} the governor does not regulate: governor gains are not assessed there and never read from govP/D/F/Target (TUNING_KNOWLEDGE 8).` });
    },
    G1(L, c) {
        const bad = L.filter(isFlag), proxy = L.filter(f => f.severity === 'note' && !thin(f) && /glitch-proxy/.test(String(f.text)));
        return one(bad, { id: 'G1', title: 'RPM signal lost or glitching', rule: `G1: any FALLBACK entry (${GR.G1.source}: rpmGlitch / rpmError, governor.c:50-60,574-606)`,
            text: `${sum(bad)} FALLBACK entr(ies) in log(s) ${logList(bad, c)}, e.g. ${textOf(bad)}. Fix the RPM source (wiring, sensor, ESC telemetry setup) before any governor or RPM-filter change.` })
            .concat(one(bad.length ? [] : proxy, { id: 'G1:proxy', severity: 'watch', title: 'RPM glitch proxy events', rule: 'G1: glitch proxy in flight (a proxy: the logged headspeed is filtered differently)', text: textOf(proxy) }));
    },
    G2: diag('G2', 'governor', 'Headspeed not held steady', `G2: |median| > ${GR.G2.median * 100} % by 2 SE or p5..p95 outside +-${GR.G2.band * 100} % (${GR.G2.source})`,
        'Look at G6 (headroom) and G9 (oscillation) for the cause.'),
    G3(L, c) {
        const rule = `G3: droop after collective rises > ${GR.G3.flag * 100} % by ${GR.sig} SE (${GR.G3.source}); F share < 0.5 means F too low (GOVT)`;
        return L.filter(f => (isFlag(f) || f.severity === 'note') && !thin(f)).map(f => { const p = profileOf(f), low = /F too low/.test(String(f.text));
            const r = low ? change(c, { id: `G3:gov_f_gain:p${p}`, area: 'governor', profile: p, parameter: 'gov_f_gain', add: RULES.govSteps.F, direction: 'raise', title: 'Raise governor F', evidence: [evidence(f)],
                rule: rule + `; step ${RULES.govSteps.F} (${RULES.source.govSteps})`, text: `Headspeed droops ${pct(f.value, 2)} +- ${pct(f.se, 2)} on collective rises and F carries less than half of the added throttle.`,
                caveats: c.flags('G6').some(g => g.profile === p) ? [`G6 flags throttle headroom on profile ${p}: more F cannot help where the throttle saturates`] : [] })
                : rec({ id: `G3:p${p}`, area: 'governor', profile: p, title: 'Headspeed droops on collective rises', evidence: [evidence(f)], rule,
                    text: `${f.text}. ${/headroom/.test(String(f.text)) ? 'Throttle headroom (G6), not F.' : 'F already carries most of the added throttle: check recovery (G5) and headroom (G6).'}` });
            if (!isFlag(f)) r.sig = `G3 droop ${pct(f.value, 2)} +- ${pct(f.se, 2)} does not clear ${GR.G3.flag * 100} % by ${GR.sig} SE`;
            return r; });
    },
    G4(L, c) {
        const rule = `G4: overshoot > ${GR.G4.flag * 100} % by 2 SE (${GR.G4.source}); on rises (load onset) F too high (GOVT)`;
        return L.filter(isFlag).map(f => { const p = profileOf(f);
            if (/load onset/.test(String(f.text))) return change(c, { id: `G4:gov_f_gain:p${p}`, area: 'governor', profile: p, parameter: 'gov_f_gain', add: -RULES.govSteps.F, direction: 'lower', title: 'Lower governor F', evidence: [evidence(f)],
                rule: rule + `; step ${RULES.govSteps.F} (${RULES.source.govSteps})`, text: `Headspeed overshoots ${pct(f.value, 2)} +- ${pct(f.se, 2)} at load onset: "headspeed temporarily too high" (GOVT).` });
            return rec({ id: `G4:drop:p${p}`, area: 'governor', profile: p, title: 'Headspeed overshoots after collective drops', evidence: [evidence(f)], rule, text: `${f.text}. A diagnostic: the governor brakes late on unload.` }); });
    },
    G5: diag('G5', 'governor', 'Slow headspeed recovery', `G5: recovery > ${GR.G5.flag} s by 2 SE (${GR.G5.source})`,
        `If G6 shows no saturation, "bog or droop under load" (FLYR) points at governor P: raise it in steps of ${RULES.govSteps.P} (GOVT).`),
    G6(L, c) {
        const bad = L.filter(isFlag), byP = [...group(bad, f => f.profile)].map(([p, l]) => `profile ${p}: median ${l.map(f => fmt(f.value, 1)).join('/')} % in log(s) ${logList(l, c)}`);
        return one(bad, { id: 'G6', area: 'governor', title: 'Throttle headroom', rule: `G6: median throttle > ${GR.G6.median} % or runs >= ${GR.G6.runS * 1000} ms at the ceiling with headspeed > ${GR.G6.deficit * 100} % low (${GR.G6.source} FLYR 75-85 %)`,
            text: `${byP.join('; ')}. Little throttle reserve: lower the headspeed target or change gearing or cells; FLYR recommends 75-85 % throttle with 15-25 % reserve.`, caveats: [REFUTED.G6] });
    },
    G8: diag('G8', 'governor', 'Throttle output does not match govSum', `G8: motor[0]/govSum outside the firmware vcomp bounds ${GR.G8.bounds.join('-')}`,
        'The ratio is not voltage compensation alone (a custom mixer rule, or gov_mode OFF?).'),
    G9(L, c) {
        const rule = `G9: headspeed error peak prominence >= ${GR.G9.prominence} by ${GR.sig} SE, amplitude >= ${GR.G9.minAmplitude * 100} %, collective coherence < ${GR.G9.maxCollectiveCoherence} (${GR.G9.source})`;
        // GOVT cuts I or P by 1/3 once it plays up (its steps of 25 and 10 are for raising), bounded to 20 % a step (guard 5)
        return L.filter(f => isFlag(f) || (f.severity === 'note' && /not by \d SE/.test(String(f.text)))).map(f => { const p = profileOf(f), P = /P-type/.test(String(f.text)), k = P ? 'P' : 'I';
            const r = change(c, { id: `G9:gov_${k.toLowerCase()}_gain:p${p}`, area: 'governor', profile: p, parameter: `gov_${k.toLowerCase()}_gain`, mult: 1 - RULES.govCut, asks: "GOVT's cut by 1/3", direction: 'lower', title: `Lower governor ${k}`, evidence: [evidence(f)],
                rule: rule + `; cut by 1/3 (${RULES.source.govCut}), bounded to ${RULES.maxStep * 100} % a step (guard 5)`,
                text: `Headspeed oscillates in the ${P ? '3-10 Hz (P-type)' : '0.3-3 Hz (I-type)'} band: ${P ? '"head speed will oscillate or surge" (FLYR); GOVT: after slight oscillation reduce P by 1/3; gov_gain is the other knob' : 'GOVT: raise I until it plays up, then reduce it by 1/3'}.` });
            if (!isFlag(f)) r.sig = `G9 prominence ${fmt(f.value)} +- ${fmt(f.se)} does not clear ${GR.G9.prominence} by ${GR.sig} SE`;
            return r; });
    },
    G10: diag('G10', 'governor', 'Tail wag coherent with headspeed', `G10: coherence of headspeed and yaw gyro at the wag peak >= ${GR.G10.implicated} by 2 SE (${GR.G10.source}; OLDWIKI Tail-tuning)`,
        `The governor is implicated: detune it (gov_gain, at most ${RULES.maxStep * 100} % a step) or check gov_rpm_filter; a "governor so strong the tail cannot hold torque" (GOVT).`),
    G11: diag('G11', 'governor', 'Throttle rises over the pack', `G11: steady throttle trend > ${GR.G11.perPack} % points per pack by 2 SE (${GR.G11.source})`,
        'Battery sag: gov_use_voltage_comp = ON compensates it with an ADC battery voltage source (governor.c:1556).'),
    G12(L, c) {
        const bad = L.filter(isFlag), o = bad.length ? num(bad[0].value) : null, poles = c.cli ? pick(c.cli.global.motor_poles, 0) : null;
        return one(bad, { id: 'G12', severity: 'action', title: 'Headspeed reads a wrong factor', rule: `G12: main rotor line within ${GR.G12.tolerance * 100} % of 1 x headspeed/60 by 2 SE (${GR.G12.source})`,
            text: `The main rotor line sits at ${fmt(o, 4)} x the logged headspeed/60: headspeed, notches and governor thresholds all scale with the error. Check motor_poles and main_rotor_gear_ratio` + (num(poles) > 0 && o ? `; if the poles are the error, ${fmt(poles / o, 1)} instead of ${poles} would read right` : '') + '.' });
    },
    G13(L) {
        const bad = L.filter(isFlag), amb = L.filter(f => f.severity === 'note' && /cell count ambiguous/.test(String(f.text)) && !/Vbat in flight 0 -> 0/.test(String(f.text)));
        return one(bad, { id: 'G13', title: 'Low cell voltage under load', rule: `G13: p1 of in-flight Vbat per cell < ${GR.G13.minCell} V (${GR.G13.source})`, text: `${textOf(bad)}. Do not interpret power results there.` })
            .concat(one(bad.length ? [] : amb, { id: 'G13:cells', severity: 'info', title: 'Give the cell count', rule: 'G13: per-cell checks need the cell count', text: 'The cell count is ambiguous from the resting voltage: set battery_cell_count (0 = auto) so that D5, G8 and G13 can judge per cell.' }));
    },
    G14: diag('G14', 'governor', 'Governor left ACTIVE in flight', `G14: airborne BAILOUT, or AUTOROTATION while airborne at collective >= ${fmt(ruleNum(MR, 'G14', 'hover'), 0)} for > ${fmt(ruleNum(MR, 'G14', 'autoS'))} s (${ruleSrc(MR, 'G14')})`,
        'With the 4.6 defaults (gov_autorotation_timeout 15, gov_auto_throttle 0) a throttle drop below handover enters AUTOROTATION (governor.c:389-392); set the timeout to 0 if bailout is not wanted [INF].'),
    C1: perAxis('C1', 'cyclic', 'I pinned at its limit', `C1: |I| >= ${LR.C1.level} x Ki x error_limit for > ${LR.C1.minS} s (${LR.C1.note})`,
        'Check saturation (C2) first, then trim, CG and mixer calibration; raise error_limit only where the I is pinned without saturation [INF].'),
    C2: diag('C2', 'mechanical', 'Cyclic at an output limit', `C2: >= ${LR.C2.minEpisodes} episode at a mixer, ring, servo or collective limit (${LR.C2.note})`,
        'Mixer limits, swash ring and servo travel set the authority; gains cannot add it. Never use servo min/max for range (SERVO).'),
    C3(L, c) {
        return perProfile(L, c, 'C3', { area: 'cyclic', test: shareTest('C3', LR.C3), rule: `C3: |I share| <= ${LR.C3.iShare} and gyro/setpoint ${LR.C3.gyroRatio.join('-')} in steady full-stick manoeuvres (${LR.C3.source}; TUNE: FF so that "I remains near 0")`,
            size: (fl, e, ax, p, list) => Math.abs(e.value) > LR.C3.iShare
                ? { parameter: `${ax}_f_gain`, mult: 1 + e.value, direction: e.value > 0 ? 'raise' : 'lower', confidence: 'measured', title: `${e.value > 0 ? 'Raise' : 'Lower'} ${ax} F`,
                    text: `In steady full-stick ${ax} manoeuvres I carries ${fmt(e.value, 2)} +- ${fmt(e.se, 2)} of the F term (${flagLogs(list)}): F x (1 + share) takes it over.` }
                : { title: `${ax} rate off the setpoint`, text: `${fl[0].text}. With I near 0 the rate still misses the setpoint: check saturation (C2) and rates beyond the authority.` } });
    },
    C4(L, c) {
        const test = (list) => { const eo = pooled(list.map(f => [f.value, f.se])), es = pooled(list.map(f => f.settleS ? [f.settleS.mean, f.settleS.se] : [null])), a = clears(eo, LR.C4.overshootPct, 1), b = clears(es, LR.C4.settleS, 1);
            return a !== true && b !== true && (a === false || b === false) ? `C4 overshoot ${fmt(eo && eo.value, 1)} +- ${fmt(eo && eo.se, 1)} % and settling ${fmt(es && es.value)} +- ${fmt(es && es.se)} s do not clear ${LR.C4.overshootPct} % / ${LR.C4.settleS} s by ${RULES.sigmas} SE` : null; };
        return perProfile(L, c, 'C4', { area: 'cyclic', test, rule: `C4: stop overshoot <= ${LR.C4.overshootPct} % and settling <= ${LR.C4.settleS} s (${LR.C4.source}); I charged with the rotation means FF too low`,
            size: (fl, e, ax) => /FF too low/.test(String(fl[0].text))
                ? { parameter: `${ax}_f_gain`, mult: 1 + RULES.dirStep, direction: 'raise', title: `Raise ${ax} F`, text: `${ax} stops overshoot ${fmt(e.value, 1)} +- ${fmt(e.se, 1)} % with I charged with the rotation: FF too low (FF page); one step of ${RULES.dirStep * 100} %.` }
                : { title: `${ax} stops bounce back`, text: `${fl[0].text}. FF too high (FF page: "stops and bounces back -> decrease the FF gain"), relax too weak (PROF: start high, decrease until it disappears) or B too high (TUNE).` } });
    },
    C5: (L) => oscillation(L, 'C5', 'cyclic'),
    T1: (L) => oscillation(L, 'T1', 'tail'),
    C6: perAxis('C6', 'cyclic', 'slow oscillation', `C6: 0.5-3 Hz error peak prominence >= ${LR.C6.prominence} (${LR.C6.source}; ${LR.C6.note})`,
        (l) => `${/driven by I/.test(l[0].text) ? '"Lower the I-gain or raise the P-gain" (TUNE); try I-term relax.' : 'Not driven by I: check mechanics and the governor.'} The sources disagree on the bands, so the frequency alone does not name the term.`),
    C10(L, c) {  // the landed-while-moving part is a watch: its test is the one CYC-LANDED refuted
        const rule = `C10: I decays at the ground rate (tau ${LR.C10.tau.join('-')} s) without AIRBORNE events, or landed while moving > 0 s (${LR.C10.note})`;
        const bad = L.filter(isFlag), moving = bad.filter(f => /while the firmware says landed/.test(String(f.text)));
        return diag('C10', 'precondition', 'Ground decay in flight', rule, 'The firmware thinks it is landed and bleeds I. Airborne detection uses rc_threshold (lower it if this persists [INF]).')(bad.filter(f => !moving.includes(f)), c)
            .concat(one(moving, { id: 'C10:landed', severity: 'watch', title: 'Spooled up while the firmware says landed', rule, caveats: [REFUTED.C10],
                text: `${fmt(sum(moving), 1)} s spooled up and turning while the firmware says landed, in log(s) ${logList(moving, c)}. If real, ground decay bleeds I in flight; airborne detection uses rc_threshold [INF].` }));
    },
    C11: (L) => perAxis('C11', 'filters', 'D driven by noise', `C11: share of axisD power above 30 Hz > ${LR.C11.share} (${LR.C11.source})`,
        'Filters before D: "If you do not have filters enabled ... do not use Derivative" (TUNE); D "magnifies by 10x to 100x" high-frequency vibration (MSG).')(L)
        .map(r => sigAny(r, L.filter(f => axisOf(f) === r.axis), 'C11')),
    C12: (L, c) => tracking(L, 'C12', 'cyclic', c),
    T11: (L, c) => tracking(L, 'T11', 'tail', c),
    C13: (L) => lag(L, 'C13', 'cyclic'),
    T12: (L) => lag(L, 'T12', 'tail'),
    C14(L, c) {  // health_more gives the pitch_collective_ff_gain change that would supply the pitch I+O (gainChange +- gainChangeSe)
        return perProfile(L, c, 'C14', { area: 'cyclic', axis: 'pitch', rule: `C14: pitch I+O against collective, |slope| - ${RULES.sigmas} SE > ${fmt(SIGMA.C14[0])} per 1000 collective, pooled over the measured logs of the profile, and a gain change >= ${fmt(ruleNum(MR, 'C14', 'minGainChange'))} (${ruleSrc(MR, 'C14')}; firmware pitch FF = collective x gain/500, pid.c:937-942)`,
            size: (fl, e, ax, p, list) => { const d = pooled(list.map(f => [f.gainChange, f.gainChangeSe]));
                if (!d) return { title: 'Pitch moves with collective', text: `${fl[0].text} The finding gives no gain change: no number to set.` };
                return { parameter: 'pitch_collective_ff_gain', delta: d.value, direction: d.value > 0 ? 'raise' : 'lower', confidence: 'measured', title: `${d.value > 0 ? 'Raise' : 'Lower'} pitch collective FF`,
                    text: `Collective moves the pitch I+O by ${fmt(e.value, 2)} +- ${fmt(e.se, 2)} per 1000 (${flagLogs(list)}); a pitch_collective_ff_gain change of ${fmt(d.value, 0)} +- ${fmt(d.se, 0)} would supply it; "relatively low value to be conservative" (PROF).` }; } });
    },
    R1: (L) => perAxis('R1', 'rates', 'setpoint lags the stick', `R1: rcCommand -> setpoint lag - ${RULES.sigmas} SE > ${fmt(SIGMA.R1[0], 0)} ms (${ruleSrc(TR, 'R1')})`,
        'Response time (a PT1 at 500/response Hz), accel limit and rc_smoothness shape the setpoint (setpoint.c:177-353): lower whichever is set (rate profile).')(L)
        .map(r => sigAny(r, L.filter(f => axisOf(f) === r.axis), 'R1')),
    T2: diag('T2', 'tail', 'Slow tail wag', `T2: 0.5-3 Hz yaw error peak prominence >= ${LR.T2.prominence} (${LR.T2.source})`,
        '"Slow wags are almost always mechanical" ([COM] RCG-140): check for binding first; if driven by I, "lower I or raise P" (TUNE).', { axis: 'yaw' }),
    T3: diag('T3', 'tail', 'Tail wag changes with headspeed', 'T3: wag amplitude ratio >= 2 between profiles at equal gains (pipeline; rationale OLDWIKI Tuning-Introduction)',
        'A belt tail gains loop gain with headspeed and "might need lower PIDs for higher headspeeds" (OLDWIKI, RF1 era).', { axis: 'yaw' }),
    T4(L) {
        const sel = L.filter(f => f.severity === 'note' && /suspect mechanics/.test(String(f.text)));
        return one(sel, { id: 'T4', area: 'mechanical', axis: 'yaw', severity: 'watch', title: 'Tail wag survives gain changes', rule: `T4: wag frequency changes < ${LR.T4.hzChange * 100} % while gains change > ${LR.T4.gainChange * 100} % (${LR.T4.source}, ${LR.T4.note})`,
            text: `${textOf(sel)}. A mechanical cause (slop, sticky slider, bearings, tail centre) "cannot be tuned out" (PROC45).`, caveats: [REFUTED.T4] });
    },
    T5(L, c) {
        return perProfile(L, c, 'T5', { area: 'tail', axis: 'yaw', key: (f) => `${f.profile}|${f.larger}`, rule: `T5: stop overshoot ratio >= ${LR.T5.ratio} (${LR.T5.source}; ${LR.T5.note}); one step of ${RULES.dirStep * 100} % on the larger side`,
            size: (fl, e, ax, p, list) => ({ parameter: `yaw_${fl[0].larger}_stop_gain`, mult: 1 - RULES.dirStep, direction: 'lower', title: `Lower the yaw ${String(fl[0].larger).toUpperCase()} stop gain`,
                text: `Yaw stops overshoot ${fmt(e.value)} +- ${fmt(e.se)} times more on the ${String(fl[0].larger).toUpperCase()}-gain side (${flagLogs(list)}): lower that stop gain (or raise the other; the ratio matters more [COM]).`,
                caveats: ['which physical stop uses yaw_cw_stop_gain is not documented (TUNING_KNOWLEDGE question 6); T5 regresses P on each side to check the split'] }) });
    },
    T6(L, c) {
        return perProfile(L, c, 'T6', { area: 'tail', axis: 'yaw', rule: `T6: yaw kick after collective steps >= ${LR.T6.kick} deg/s (${LR.T6.source}; ${LR.T6.note}); direction: the kick toward the torque change by 2 SE`,
            size: (fl, e, ax, p, list) => { const t = pooled(list.map(f => f.towardTorque ? [f.towardTorque.mean, f.towardTorque.se] : [null]));
                // no direction: T6 measures the kick's size and sign, not its timing, so it says nothing about yaw_precomp_cutoff
                if (!t || t.se === null || Math.abs(t.value) <= RULES.sigmas * t.se) return { title: 'Yaw kick on collective steps', caveats: [REFUTED.T6],
                    text: `The tail kicks ${fmt(e.value, 1)} +- ${fmt(e.se, 1)} deg/s after collective steps (${flagLogs(list)}), but its direction relative to the torque change ${t && t.se !== null ? `is ${fmt(t.value, 1)} +- ${fmt(t.se, 1)} deg/s, which does not clear ${RULES.sigmas} SE` : 'is not measured'}: no precomp direction (on steps through zero collective the torque sign is undefined). T6 measures the kick's size and sign, not its timing, so it says nothing about yaw_precomp_cutoff; T7 (yaw I against the precomp in pumps) measures the precomp. Check the pilot's yaw input, and fly collective steps with the yaw stick centred, not through zero collective.` };
                const up = t.value > 0;
                return { parameter: 'yaw_collective_ff_gain', mult: 1 + (up ? 1 : -1) * RULES.dirStep, direction: up ? 'raise' : 'lower', severity: 'check', caveats: [REFUTED.T6], title: `${up ? 'Raise' : 'Lower'} yaw collective precomp`,
                    text: `The tail kicks ${fmt(e.value, 1)} +- ${fmt(e.se, 1)} deg/s after collective steps, ${fmt(t.value, 1)} +- ${fmt(t.se, 1)} deg/s toward the torque change (${flagLogs(list)}): precomp too ${up ? 'small' : 'large'}; one step of ${RULES.dirStep * 100} % ("higher gain results in CW response" on a CW rotor, PROF).` }; } });
    },
    T7(L, c) {
        return perProfile(L, c, 'T7', { area: 'tail', axis: 'yaw', rule: `T7: |r(yaw I, precomp)| >= ${LR.T7.r} in collective pumps (${LR.T7.source}; ${LR.T7.note}); collective FF x sqrt(scale), because the precomp is LPF((|collective| x gain)^2) (pid.c dragCoef, TUNING_KNOWLEDGE 2.10)`,
            size: (fl, e, ax, p, list) => { const s = list.map(f => num(f.precompScale)).filter(v => v !== null).sort((a, b) => a - b), scale = s.length ? s[s.length >> 1] : null;
                if (scale === null || scale <= 0) return { title: 'Yaw precomp has the wrong sign', text: `${fl[0].text}. Check main_rotor_dir and the precomp direction before any gain change.` };
                return { parameter: 'yaw_collective_ff_gain', mult: Math.sqrt(scale), direction: scale > 1 ? 'raise' : 'lower', confidence: 'measured', title: `${scale > 1 ? 'Raise' : 'Lower'} yaw collective precomp`,
                    text: `In collective pumps the yaw I follows the precomp: the tail needs ${fmt(scale, 2)} x the present precomp (median over ${s.length} measured log(s), ${flagLogs(list)}), so the collective FF needs x${fmt(Math.sqrt(scale), 3)}.`,
                    caveats: ['assumes the cyclic part of the precomp is small in pumps'] }; } });
    },
    T8(L, c) {
        const bad = L.filter(isFlag), mot = !!(gearOf(c.cli) || {}).motorisedTail;
        return one(bad, { id: 'T8', area: 'mechanical', axis: 'yaw', title: 'Tail at its output limit', rule: `T8: >= ${LR.T8.minEpisodes} episode with mixer[2] or servo[3] at a limit (${LR.T8.source} limit; detection pipeline)`,
            text: `${fmt(sum(bad), 2)} s at the limit over ${bad.length} log-profile pair(s) (${[...group(bad, f => f.profile)].map(([p, l]) => `profile ${p} ${fmt(sum(l), 2)} s`).join(', ')}). Gain changes cannot add authority: check the tail pitch limits and calibration (MIXS), blade size and tail speed, or detune the governor (GOVT).`
                + (mot ? ` Motorised tail: if it runs out flying backwards, raise gov_tta_gain in steps of ${RULES.ttaStep} (TTA).` : '') });
    },
    T9(L, c) {
        return perProfile(L, c, 'T9', { area: 'tail', axis: 'yaw', test: shareTest('T9', LR.T9), rule: `T9: |I share| <= ${LR.T9.iShare} in steady piros (${LR.T9.source}); one step of ${RULES.dirStep * 100} % (the share is of the control change, not of F)`,
            size: (fl, e, ax, p, list) => Math.abs(e.value) > LR.T9.iShare
                ? { parameter: 'yaw_f_gain', mult: 1 + Math.sign(e.value) * RULES.dirStep, direction: e.value > 0 ? 'raise' : 'lower', severity: 'check', caveats: [REFUTED.T9], title: `${e.value > 0 ? 'Raise' : 'Lower'} yaw F`,
                    text: `In steady piros I carries ${fmt(e.value, 2)} +- ${fmt(e.se, 2)} of the control change (${flagLogs(list)}): ${e.value > 0 ? 'stops creep, raise yaw FF' : 'I works against FF, lower it'}. Start at 0 on the tail (FF page).` }
                : { title: 'Yaw rate off the setpoint in piros', text: `${fl[0].text}. Check saturation (T8).` } });
    },
    T10: diag('T10', 'tail', 'Little yaw phase margin', 'T10: yaw phase margin >= 35 deg after any change (pipeline, RULES.phaseMargin)', 'Do not raise yaw P or the stop gains.', { axis: 'yaw' }),
    T13: diag('T13', 'mechanical', 'Constant yaw I in hover', `T13: hover |axisI[2]| share of the yaw authority - ${RULES.sigmas} SE > ${fmt(ruleNum(MR, 'T13', 'share'))} (${ruleSrc(MR, 'T13')})`,
        'The P/I/D gains do not fix a trim: tail_center_trim and the yaw calibration do (MIXS: centre calibration "helps the feedforwards to work correctly"), or, when I follows the collective (T7), more yaw_collective_ff_gain.', { axis: 'yaw' }),
    T14: (L, c) => inertia(L, c),
};
GEN.SETUP.always = GEN.D4.always = true; // run once even without findings of the id

function oscillation(L, id, area) {
    const ax0 = area === 'tail' ? 'yaw' : null, bad = L.filter(isFlag), mild = L.filter(f => f.severity === 'note' && !thin(f));
    return [...group(bad, f => axisOf(f) || ax0)].map(([ax, list]) => { const n = sum(list), few = n < RULES.minBursts;
        return rec({ id: `${id}:${ax}`, area, axis: ax, severity: few ? 'watch' : 'check', title: `${ax} self-excited oscillation${few ? ': one burst' : ''}`, evidence: list.map(evidence),
            rule: `${id}: a burst that grows from < ${fmt(ONSET.small, 0)} to >= ${fmt(ONSET.high, 0)} deg/s over >= ${fmt(ONSET.minHalfCycles, 0)} half cycles with the stick quiet (wag_report.cjs RULES.onset, stickDriven ${fmt(OSC.stickDriven)}); fewer than ${RULES.minBursts} bursts are a watch (${RULES.source.minBursts})`,
            text: `${list[0].text} (${list.length} log-profile pair(s), ${n} burst${n === 1 ? '' : 's'}). ` + (few ? 'A single burst does not tell loop gain from load, lag or a low battery: fly again and see whether it repeats before changing a gain.'
                : `${area === 'tail' ? 'Yaw P, a stop gain or D too high, or D driven by noise ([COM] HF-970331, PROF)' : 'P or D too high, or D driven by noise'}: back off the gain raised last (TUNE). The frequency alone does not name the term.`) }); })
        .concat([...group(mild, f => axisOf(f) || ax0)].map(([ax, list]) => rec({ id: `${id}:${ax}:watch`, area, axis: ax, severity: 'watch', title: `${ax} oscillation present`, evidence: list.map(evidence),
            rule: `${id}: share of stick-free time >= ${fmt(ruleNum(TR, id, 'level'), 0)} deg/s - ${RULES.sigmas} SE > ${fmt(ruleNum(TR, id, 'share'))} (${ruleSrc(TR, id)})`, text: `${list[0].text} Driven, not self-excited: watch it after any gain raise.` })));
}
// C12 / T11 per axis, over every measured log-profile pair (ok ones too: pooling only the pairs above the note level
// would read above it by construction); a recommendation where a pair is above the note level. An elevated pair
// measured before a later header change of the axis gains on its start profile (H; ordered by log index, the flash
// order, which undated logs keep) describes another setup.
function tracking(L, id, area, c) {
    const note = ruleNum(TR, id, 'note'), flag = ruleNum(TR, id, 'flag');
    return [...group(L.filter(measured), axisOf)].filter(([, l]) => l.some(f => isFlag(f) || f.severity === 'note')).map(([ax, list]) => {
        const fl = list.filter(isFlag), up = list.filter(f => isFlag(f) || f.severity === 'note'), e = pooled(list.map(f => [f.value, f.se])), vals = list.map(f => num(f.value)).filter(v => v !== null);
        const worst = (fl.length ? fl : up).slice().sort((a, b) => (num(b.value) || 0) - (num(a.value) || 0))[0];
        const r = rec({ id: `${id}:${ax}`, area, axis: ax, severity: fl.length ? 'check' : 'watch', title: `${ax} tracking error above ${pct(note)} in ${up.length} of ${list.length} log-profile pair(s)`, evidence: list.map(evidence),
            rule: `${id}: delay-compensated tracking error / setpoint rms${num(TTRACK.lpHz) !== null ? ` (gyro and setpoint below ${fmt(TTRACK.lpHz, 0)} Hz, samples with |setpoint| > ${fmt(TTRACK.minAbsSetpoint, 0)} deg/s)` : ''}, flag above ${pct(flag)} by ${RULES.sigmas} SE, note above ${pct(note)} (${ruleSrc(TR, id)}); every measured log-profile pair pooled`,
            text: `${up.length} of ${list.length} measured log-profile pair(s) above ${pct(note)}` + (list.length > 1 && e ? `; all ${list.length} pooled ${pct(e.value, 1)} +- ${pct(e.se, 1)} (range ${pct(Math.min(...vals), 1)} to ${pct(Math.max(...vals), 1)})` : '')
                + `; the largest, log ${logList([worst], c)} profile ${worst.profile}: ${worst.text} This is an outcome, not a cause: the cause checks (stops, FF, oscillation) and the report.cjs gain decisions say what to change.` });
        const keys = [`${ax}PID`].concat(ax === 'yaw' ? ['yaw_stop_gain'] : []), old = up.map(f => ({ f, ch: laterChanges(c, keys, f) })).filter(x => x.ch.length);
        if (old.length) r.caveats.push(`${old.length} of the ${up.length} pair(s) above ${pct(note)} were measured before a later change of ${keys.join(' or ')} on their start profile (`
            + old.slice(0, 3).map(x => `log ${lab(logsOf(x.f)[0], c)} profile ${x.f.profile}: ${x.ch.slice(-2).map(h => `log ${lab(logsOf(h)[0], c)} ${String(h.text).split(' (since')[0]}`).join('; ')}`).join('; ')
            + `): they may describe another setup; fly the present one and analyse again`);
        return sigAny(r, list, id); });
}
// H findings of the keys in the start-profile scope of finding f that come after f's log (either log of the change)
const laterChanges = (c, keys, f) => { const l = logsOf(f)[0]; return typeof l !== 'number' ? [] : c.F.filter(h => h.id === 'H' && h.profile === `start profile ${f.profile}` && keys.includes(String(h.text).split(':')[0])
    && Math.max(...logsOf(h).concat(matchNum(/since log (\d+)/, h.text) === null ? [] : [matchNum(/since log (\d+)/, h.text)])) > l); };

// T14 by the yaw setup each log flew: the yaw PID, stop and inertia gains of its header (health_setup SETUP finding),
// against the analysed header. The present setup leads and must pass the T14 rule again with its logs pooled (the
// events of all of them for the sign); flags on other setups are context, never a target (their size was measured on
// other gains). Without the setups of the logs every measured log is pooled. The rule is health_more's
// DEFAULT_RULES.T14: on the gain change that would supply the tail feedback moving with the rotor acceleration
// (minGainChange, relGainChange), or in its earlier form on the peak yaw toward the reaction torque (peak).
const YAW_PID = /\bPID R [-\d.,]+ P [-\d.,]+ Y ([-\d.,]+);/, YAW_REST = /\byaw stop ([-\d.,]+), precomp [-\d.,]+, inertia ([-\d.,]+), TTA\b/;
const yawSet = (pid, stop, inertia) => `yaw PID ${pid}, stop ${stop}, inertia ${inertia}`;
const headerYawSet = (h) => [h.yawPID, h.yaw_stop_gain, h.yaw_inertia_precomp].some(v => v === undefined || v === null) ? null : yawSet(arr(h.yawPID).join(','), arr(h.yaw_stop_gain).join(','), arr(h.yaw_inertia_precomp).join(','));
function logYawSets(c) {
    const m = new Map();
    for (const f of c.F) if (f.id === 'SETUP') { const a = YAW_PID.exec(String(f.text)), b = YAW_REST.exec(String(f.text)); if (a && b) for (const l of logsOf(f)) m.set(l, yawSet(a[1], b[1], b[2])); }
    return m;
}
function inertia(L, c) {
    const bad = L.filter(isFlag); if (!bad.length) return [];
    const R = MR.T14 || {}, byGain = typeof R.minGainChange === 'number', [lo, hi] = RANGE.yaw_inertia_precomp_gain, g0 = num(pick(c.header.yaw_inertia_precomp, 0));
    const now = headerYawSet(c.header), sets = logYawSets(c), setOf = (f) => sets.get(logsOf(f)[0]) || null, M = L.filter(measured);
    const byLog = (a, b) => (logsOf(a)[0] || 0) - (logsOf(b)[0] || 0), split = now !== null && M.some(f => setOf(f) !== null);
    const present = (split ? M.filter(f => setOf(f) === now) : M).sort(byLog), old = split ? M.filter(f => setOf(f) !== now && isFlag(f)).sort(byLog) : [];
    const G = pooled(present.map(f => [num(f.gainChange), num(f.gainChangeSe)])), Y = pooled(present.map(f => byGain ? [num(f.toward), num(f.towardSe)] : [num(f.value), num(f.se)]));
    const e = byGain ? G : Y, thr = byGain ? Math.max(R.minGainChange, (num(R.relGainChange) || 0) * (g0 || 0)) : num(R.peak), n = present.reduce((s, f) => s + (num(f.n) || 0), 0);
    const x = present.flatMap(f => Array.isArray(f.events) ? f.events.map(q => num(q.value)).filter(v => v !== null) : []), sign = e && num(e.value) !== null ? Math.sign(e.value) : 0;
    const share = x.length ? x.filter(v => Math.sign(v) === sign).length / x.length : null, to = G && g0 !== null ? Math.max(lo, Math.min(hi, Math.round(g0 + G.value))) : null;
    // as health_more: the change after the 0-250 clamp must still pass the size threshold; without the header gain, no target
    const stands = !!e && n >= R.minEvents && (share === null || share >= R.consistent) && clears(e, thr, 0) === true && (!byGain || to === null || Math.abs(to - g0) >= thr);
    const on = split ? `the present yaw setup (${now}), log(s) ${logList(present, c)}` : `${present.length} measured log(s) pooled (${logList(present, c)})`;
    const gain = G ? `a yaw_inertia_precomp_gain change of ${fmt(G.value, 0)} +- ${fmt(G.se, 0)} would supply the tail feedback that moves with the rotor acceleration (header ${fmt(g0, 0)}, range ${lo}-${hi}, settings.c:1144)` : 'no gain change estimated';
    const peak = Y ? `peak yaw ${fmt(Y.value, 1)} +- ${fmt(Y.se, 1)} deg/s toward the reaction torque` : 'no peak yaw estimate';
    const judged = `${n} ramp events${share === null ? '' : `, ${pct(share)} of them of its sign`}: ${byGain ? gain : peak}`, other = byGain ? `${peak} (described, not judged: a lagging precomp leaves such a kick at the matching gain)` : gain;
    const r = rec({ id: 'T14', area: 'tail', axis: 'yaw', parameter: 'yaw_inertia_precomp_gain', title: 'Yaw at headspeed ramps', evidence: present.concat(old).map(evidence),
        rule: `T14: >= ${R.minEvents} ramp events, >= ${pct(R.consistent)} of the events of its sign, ` + (byGain ? `|gain change| - ${RULES.sigmas} SE > max(${R.minGainChange}, ${R.relGainChange} x header gain) = ${fmt(thr, 0)}` : `|peak yaw| - ${RULES.sigmas} SE > ${fmt(thr)} deg/s`)
            + ` (${ruleSrc(MR, 'T14')}); on the yaw setup of the analysed header, its logs pooled` });
    if (present.length && stands) { const up = e.value > 0;
        Object.assign(r, { from: g0, to: byGain ? to : null, direction: up ? 'raise' : 'lower' });
        const beyond = G && g0 !== null && num(G.se) !== null && g0 + G.value - RULES.sigmas * G.se > hi;
        r.text = `On ${on}: ${judged}: ${up ? 'raise' : 'lower'} yaw_inertia_precomp_gain${byGain && to !== null ? ` ${g0} -> ${to}` : g0 === null ? ' (yaw_inertia_precomp is not in the header, so no target value)' : ''}${beyond ? `; the need ${fmt(g0 + G.value, 0)} +- ${fmt(G.se, 0)} is beyond the firmware maximum ${hi}, so slow the headspeed changes too (gov_tracking_time)` : ''}; ${other}. It compensates rotor acceleration and no tuning procedure exists (TUNING_KNOWLEDGE question 5): change it in small steps and fly profile switches again.`;
        if (byGain && to !== null && to !== g0) { const want = Math.round(g0 + G.value), sim = 'in simulated loops the regression read -1 to +14 % off at gain 0 and 5-13 units high at the matching gain (health_more DEFAULT_RULES.T14 note)';
            r.caveats.push(`${want === to ? `${to} is the regression's whole estimate` : `${to} is the end of the firmware range; the regression's whole estimate is ${want} +- ${fmt(G.se, 0)}`}, and ${sim}: step toward it, not to it at once`); } }
    else if (present.length) Object.assign(r, { severity: 'watch', title: `Yaw at headspeed ramps: below the T14 line${split ? ' on the present yaw setup' : ''}`,
        text: `${old.length ? 'Flagged on other yaw setups (caveats), but on' : 'On'} ${on}: ${judged}, which does not pass the T14 rule; ${other}. No change: fly more profile switches and analyse again.` });
    else Object.assign(r, { severity: 'watch', title: 'Yaw at headspeed ramps: re-measure on the present yaw setup',
        text: `Flagged on other yaw setups only (caveats): no log of the present one (${now}) has ${R.minEvents} or more ramp events. Fly profile switches on it and analyse again.` });
    if (split) r.caveats.push('the setup of a log is its header, the yaw gains of the arming profile; T14 pools the ramps of every profile of a log, most of them profile switches');
    if (old.length) r.caveats.push(`flagged on other yaw setups, so measured on other gains (context, not a target): ${old.slice(0, 4).map(f => `log ${lab(logsOf(f)[0], c)} (${setOf(f) || 'setup unknown'}): `
        + `gain change ${fmt(num(f.gainChange), 0)} +- ${fmt(num(f.gainChangeSe), 0)}${byGain ? '' : `, peak yaw ${fmt(f.value, 1)} +- ${fmt(f.se, 1)} deg/s`}`).join('; ')}${old.length > 4 ? `; ${old.length - 4} more` : ''}`);
    return [r];
}
const lag = (L, id, area) => perAxis(id, area, 'lag is large', `${id}: setpoint -> gyro delay - ${RULES.sigmas} SE > ${fmt(SIGMA[id][0], 0)} ms (${ruleSrc(TR, id)})`,
    'Look at over-filtering (F11), B too low (FF page: "raise B, not FF") and stick shaping (R1).')(L).map(r => sigAny(r, L.filter(f => axisOf(f) === r.axis), id));

// ---------------------------------------------------------------------------------------------
// report.cjs decisions (C7)
// ---------------------------------------------------------------------------------------------

// the log profile that flies a 250 rpm headspeed bin: the profiles whose governor target falls in it (logs[].targetOf)
function profileOfBin(c, bin) {
    const cand = new Set(); for (const l of c.logs) for (const [p, t] of Object.entries(l.targetOf || {})) if (+p > 0 && num(t) !== null && lib.headspeedClass(t) === bin) cand.add(+p);
    return { p: cand.size === 1 ? [...cand][0] : 0, cand: [...cand].sort((a, b) => a - b) };
}

function decisionRecs(D, c) {
    const out = [], rule = 'C7 (report.cjs rule 7): the predicted tracking or disturbance improves >= 10 % and >= 2 SE, the other worsens <= 1 %, the total drops >= 2 %, >= 3 flights on the gain set, gates V1-V3 pass, no constraint broken; steps x0.8-x1.2';
    for (const d of D) {
        const ax = d.axis, area = ax === 'yaw' ? 'tail' : 'cyclic', { p, cand } = profileOfBin(c, d.bin), g = d.gates || {}, two = (x, k = 2) => x ? `${fmt(x[0], k)} -> ${fmt(x[1], k)}` : 'n/a';
        const gates = Object.entries(g).map(([k, v]) => `${k} ${fmt(v.value, 3)} vs ${fmt(v.limit, 3)} ${v.pass ? 'pass' : 'FAIL'}`).join(', ');
        const e = { module: 'report', id: 'C7', log: null, profile: p, axis: ax, value: num(d.dTrack), se: num(d.seTrack), n: d.flights === undefined ? null : d.flights, unit: 'deg/s', threshold: 'rule 7',
            source: 'pipeline, unvalidated (report.cjs RULES; floors validated on simulated flights only)', times: [],
            text: d.change ? `tracking ${two(d.tracking)} deg/s (${fmt(d.dTrack)} +- ${fmt(d.seTrack)}, ${fmt(d.dTrack / d.seTrack, 1)} SE), disturbance ${two(d.disturbance)}, total ${two(d.total)}, 1-3 Hz gain ${two(d.lowFreqGain, 3)}; gates ${gates}; band ${(d.validBand || []).join('-')} Hz; ${d.flights} flights, ${d.windows} windows at ${d.bin} rpm`
                : `${d.reason}${gates ? `; gates ${gates}` : ''}; ${d.flights} flights, ${d.windows} windows at ${d.bin} rpm` };
        const where = p ? [] : [cand.length ? `${d.bin} rpm matches profiles ${cand.join(', ')}: confirm the active profile` : `no profile's governor target falls in the ${d.bin} rpm bin: confirm the active profile`];
        if (!d.change) { out.push(rec({ id: `C7:${ax}:${d.bin}`, area, severity: 'info', axis: ax, profile: p, title: `No ${ax} gain change at ${d.bin} rpm`, evidence: [e], rule, confidence: 'predicted', text: `report.cjs: ${d.reason}.` })); continue; }
        for (const s of d.changes || []) {
            const param = `${ax}_${String(s.gain).toLowerCase()}_gain`; if (!PARAMS[param]) continue;
            const r = change(c, { id: `C7:${param}:p${p}`, area, axis: ax, profile: p, parameter: param, mult: s.multiplier, direction: s.multiplier > 1 ? 'raise' : 'lower', confidence: 'predicted', evidence: [e], rule, caveats: where,
                title: `${s.multiplier > 1 ? 'Raise' : 'Lower'} ${ax} ${s.gain} x${s.multiplier}`, text: `report.cjs predicts the ${s.improves} improves: ${e.text}.` });
            if (d.changes.length > 1) r.caveats.push(`one of ${d.changes.length} gains predicted together: apply them together`);
            // report.cjs evaluates the multipliers x0.8-x1.2 only: at the end of that grid nothing further was evaluated
            if (s.atBound) r.caveats.push(`x${s.multiplier} is the largest step report.cjs tries (multipliers x${1 - RULES.maxStep}-x${1 + RULES.maxStep}, ${RULES.maxStep * 100} % per iteration); nothing beyond it was evaluated, so this is no evidence that a larger change is better: fly this value and analyse again`
                + (Array.isArray(d.lowFreqGain) && num(d.lowFreqGain[0]) !== null && num(d.lowFreqGain[1]) !== null && (d.lowFreqGain[0] - 1) * (d.lowFreqGain[1] - 1) < 0 ? `; the predicted 1-3 Hz gain crosses 1 within this step (${two(d.lowFreqGain, 3)})` : ''));
            // the model ran with the recovered gain; the CLI is written only when it matches the configured one. Yaw P is
            // recovered as P x the mean stop gain: a match confirms yaw_p_gain only when both stop gains of the profile are known
            let want = r.from, stopsKnown = true;
            if (ax === 'yaw' && s.gain === 'P' && num(r.from) !== null) { const cw = current(c, 'yaw_cw_stop_gain', p), ccw = current(c, 'yaw_ccw_stop_gain', p);
                want = cw && ccw && num(cw.value) !== null && num(ccw.value) !== null ? r.from * (cw.value + ccw.value) / 200 : null;
                stopsKnown = !!(cw && ccw && !cw.unsure && !ccw.unsure);
                r.caveats.push('yaw P is P x the mean stop gain in the model: yaw_p_gain is scaled, the stop gains stay'); }
            if (num(want) !== null && num(s.from) !== null) {
                const ok = Math.abs(s.from - want) <= Math.max(1, RULES.gainTolerance * Math.abs(want));
                r.text += ` Recovered ${s.gain} ${fmt(s.from, 1)} against ${fmt(want, 1)} configured.`;
                if (ok && r.base && r.base.unsure && !stopsKnown) r.caveats.push(`the stop gains of profile ${p} are not known either: the recovered P x mean stop gain ${fmt(s.from, 1)} matches their product, which confirms neither yaw_p_gain nor the stop gains; load a CLI dump (diff all)`);
                if (ok && r.base && r.base.unsure && stopsKnown) { r.base.unsure = false; r.caveats = r.caveats.filter(x => !/^present value/.test(x)).concat(`present value confirmed by the recovered gain ${fmt(s.from, 1)}`); }
                if (!ok) { if (r.base) r.base.unsure = true; r.caveats.push(`the model ran with ${s.gain} ${fmt(s.from, 1)} but profile ${p} has ${fmt(want, 1)}: the prediction does not apply to the configured value`); }
            }
            out.push(r);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Merging, guards, order, CLI
// ---------------------------------------------------------------------------------------------

// recommendations that move the same parameter on the same profile become one: the best-confidence one that passed its
// 2-SE test leads, the others add their evidence and one line each; opposite directions turn it into a check
const CONF = { predicted: 0, measured: 1, advisory: 2 };
function merge(recs) {
    const out = [], by = new Map();
    for (const r of recs) { if (!r.sets) { out.push(r); continue; } const k = `${r.parameter}|${r.profile}`; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
    for (const list of by.values()) {
        list.sort((a, b) => (a.sig ? 1 : 0) - (b.sig ? 1 : 0) || CONF[a.confidence] - CONF[b.confidence]);
        const m = list[0], dirs = new Set(list.map(r => r.direction)), say = (r) => `${r.id.split(':')[0]} says ${r.direction} to ${r.to}${r.sig ? ' (below 2 SE)' : ''}`;
        for (const r of list.slice(1)) m.evidence.push(...r.evidence);
        if (dirs.size > 1) { m.severity = 'check'; m.sig = null; m.caveats.push(`conflicting evidence: ${list.map(say).join('; ')}`); }
        else if (list.length > 1) m.caveats.push(`also: ${list.slice(1).map(say).join('; ')}`);
        out.push(m);
    }
    return out;
}

// H: a measurement from a log before the latest header change of its parameter (in the rec's profile scope) describes
// another setup. Without start times and the analysed log's label nothing can be ordered, so any change counts.
function stale(c, r) {
    const key = PARAMS[r.parameter] ? PARAMS[r.parameter][1] : null, ev = [...new Set(r.evidence.flatMap(logsOf))]; if (!key || !ev.length) return null;
    const scope = r.scope === 'global' ? 'global' : `start profile ${r.profile}`, ch = c.F.filter(f => f.id === 'H' && f.profile === scope && String(f.text).split(':')[0] === key); if (!ch.length) return null;
    const t = (l) => c.start.has(l) ? String(c.start.get(l)) : null, last = ch.map(f => t(f.log)).sort().pop(), mine = ev.concat(/log header/.test(r.base.source) && c.headerLog !== null ? [c.headerLog] : []);
    if (ch.every(f => t(f.log) !== null) && (c.headerLog !== null || !/log header/.test(r.base.source)) && mine.every(l => t(l) !== null && t(l) >= last)) return null;
    return `${key} changed between logs (${ch.slice(-3).map(f => `log ${lab(f.log, c)}: ${String(f.text).split(' (since')[0]}`).join('; ')}): the evidence from log(s) ${ev.map(l => lab(l, c)).join(', ')} may describe another setup; fly the present one and analyse again`;
}

const LOOP_GAIN = /^(roll|pitch|yaw)_[pidfbo]_gain$|^yaw_c?cw_stop_gain$/;
function guard(r, c) {
    if (r.sig && r.severity !== 'info') { r.severity = 'watch'; r.caveats.push(`${r.sig}: watch, no change (guard 4)`); }
    const param = r.parameter || '', old = r.sets && r.base ? stale(c, r) : null;
    // a stale measurement gives no target: its step was sized on another setting
    if (old) { r.stale = true; r.caveats.push(old); if (r.severity === 'action') r.severity = 'check';
        r.text = r.text.replace(` ${param} ${r.from} (${r.base.source}) -> ${r.to}.`, ` ${param} is now ${r.from} (${r.base.source}).`);
        Object.assign(r, { title: `Re-measure ${param} on the present setup`, to: null, direction: 'check' }); }
    // a cyclic or tail change waits while a filter change is to be made: one area at a time, in the order of TUNING_KNOWLEDGE
    // 9.1, and its numbers were measured with the filters that are about to change
    const waits = !!r.sets && (r.area === 'cyclic' || r.area === 'tail') && c.filterAction;
    if (waits) r.blockedBy.push('filters first: make the filter change, fly and analyse again (TUNING_KNOWLEDGE 9.1); this was measured with the present filters');
    // guard 1: no loop gain raise before the filters are verified (TUNE; TUNING_KNOWLEDGE 8); a D raise also waits for the C11 flag of its axis
    if (r.sets && !waits && r.direction === 'raise' && LOOP_GAIN.test(param)) {
        const why = [...c.filterIssues].concat(/_d_gain$/.test(param) && c.flags('C11').some(f => axisOf(f) === r.axis) ? [`C11 ${r.axis}`] : []);
        if (why.length) r.blockedBy.push(`filters first: ${why.join(', ')} flag`);
    }
    // a D cut for noise waits for the other filter work as well: the filters are the cure, and they change the noise
    if (r.sets && !waits && r.direction === 'lower' && /_d_gain$/.test(param) && r.evidence.some(e => e.id === 'F10' || e.id === 'C11')) {
        const other = [...c.filterIssues].filter(x => x !== 'F10 yaw');
        if (other.length) r.blockedBy.push(`filters first: ${other.join(', ')} flag; lower ${param} only if its noise share stays above 0.5 after the filter change`);
    }
    // guard 2: governor and RPM-notch changes wait for poles / gear and for the RPM signal (TUNING_KNOWLEDGE 9.1 step 0)
    if (r.sets && (r.area === 'governor' || /^gyro_rpm_notch/.test(param))) {
        if (c.flags('G12').length) r.blockedBy.push('fix motor_poles / gear first: G12 flag');
        if (c.flags('G1').length) r.blockedBy.push('fix the RPM signal first: G1 flag');
    }
    // guard 2, cyclic and tail: a headspeed factor error beyond the RPM-notch tolerance moves every RPM notch off its line
    // and, under a governor, the flown headspeed; what was measured before the poles / gear fix waits (TUNING_KNOWLEDGE 9.1
    // step 0). G1 stays with governor and RPM-notch changes: FALLBACK spans are out of the loop analysis (health_loop)
    const g12 = c.flags('G12').filter(f => num(f.value) > 0 && Math.abs(f.value - 1) > SR.F5.maxDistance);
    if (r.sets && (r.area === 'cyclic' || r.area === 'tail') && g12.length)
        r.blockedBy.push(`fix motor_poles / gear first: G12 flag, main rotor line at ${fmt(g12[0].value, 4)} x the logged headspeed, beyond the ${SR.F5.maxDistance * 100} % RPM-notch tolerance: this was measured with the RPM notches off the rotor lines and, under a governor, at another headspeed`);
    // guard 3: an axis at its output limit needs authority, not gains
    if (r.axis && /_gain$/.test(param) && r.area !== 'governor') { const a = c.authority(r.axis, r.profile);
        if (a) { r.caveats.push(`authority, not gains: ${a}`); if (r.sets && r.direction === 'raise') r.blockedBy.push(`authority, not gains: ${a.split(',')[0]}`); } }
    // guard 3, governor: no stiffer governor while the tail is at its limit (T8) or the governor is implicated in the wag
    // (G10) on that profile: "a well tuned governor might generate too much torque for the tail to counteract" (GOVT;
    // TUNING_KNOWLEDGE 8; analysis/gaui-x4/FINDINGS.md 1.7: stiffen only after the tail change passes). Lowering stays.
    if (r.sets && r.area === 'governor' && r.direction === 'raise') {
        const same = (f) => !(num(r.profile) > 0) || !(num(f.profile) > 0) || f.profile === r.profile, tail = c.authority('yaw', r.profile), g10 = c.flags('G10').filter(same);
        if (tail) { r.blockedBy.push(`tail authority first: ${tail.split(',')[0]} (GOVT: a well tuned governor "might generate too much torque for the tail to counteract"; TUNING_KNOWLEDGE 8)`);
            r.caveats.push(`${tail}: a stiffer governor adds motor torque faster on collective rises, which lands on a tail at its limit (hypothesis); less droop also gives a geared tail more thrust (prediction). After the tail change, raise it only if the share of rises that reach the yaw limit does not grow`); }
        if (g10.length) r.blockedBy.push(`governor implicated in the tail wag: G10 flag in ${g10.length} log-profile pair(s), coherence ${fmt(g10[0].value)}${num(g10[0].se) !== null ? ` +- ${fmt(g10[0].se)}` : ''}; its advice is to detune the governor, not to stiffen it (GOVT)`);
    }
    // TTA on while tuning the governor confounds it (GOVT)
    if (r.sets && r.area === 'governor' && pick(c.header.yaw_tta, 0) > 0) r.caveats.push(`gov_tta_gain is ${pick(c.header.yaw_tta, 0)}: TTA on confounds governor tuning (GOVT); set it to 0 while tuning`);
}

// guard 6: never a gyro LPF below RULES.minLpfHz or a notch Q below RULES.minNotchQ
function floorsOk(k, v) {
    if (/^gyro_lpf\d_(static|dyn_min)_hz$/.test(k)) return num(+v) !== null && +v >= RULES.minLpfHz;
    if (k === 'dyn_notch_q' || /^gyro_rpm_notch_q_/.test(k)) return String(v).split(',').map(Number).every(q => q === 0 || q >= RULES.minNotchQ * 10);
    return true;
}

// guards 5 and 12: a value the firmware accepts: within RANGE, and RPM notch sources the firmware knows (0, 10-18, 20-28;
// any other code fails rpmFilterInit and disables arming, RULES.source.maxMainHarmonic)
function legal(k, v) {
    if (/^gyro_rpm_notch_source_/.test(k)) return String(v).split(',').map(Number).every(s => Number.isInteger(s) && setup.decodeNotchSource(s, null).kind !== 'invalid');
    const lim = RANGE[k];
    return !lim || typeof v !== 'number' || (v >= lim[0] && v <= lim[1]);
}

function finish(r) {
    if (r.scope === 'profile' && num(r.profile) > 0) r.cliProfile = r.profile - 1;
    if (r.severity !== 'action' || !r.sets || !r.sets.length || r.blockedBy.length || r.stale) return;
    if (r.scope === 'profile' && !(num(r.profile) > 0)) { if (!r.caveats.some(x => /confirm the active profile/.test(x))) r.caveats.push('confirm the active profile: the log profile is 0 (arming profile unknown), so no CLI (guard 7)'); return; }
    if (r.base && r.base.unsure) return;
    if (!r.sets.every(([k, v]) => PARAMS[k] && floorsOk(k, v) && legal(k, v))) { r.caveats.push('a value below the documented filter floors, outside its firmware range, an RPM notch source the firmware rejects, or an unknown name is never written (guards 5, 6, 12)'); return; }
    r.cli = (r.scope === 'profile' ? [`profile ${r.cliProfile}`] : []).concat(r.sets.map(([k, v]) => `set ${k} = ${v}`));
}

// guard 11: preconditions (mechanics, RPM source, poles / gear, logging) -> filters -> governor -> cyclic -> tail -> rates
// (TUNING_KNOWLEDGE 9.1); within an area by severity, then the documented sequence: GOVT F -> I -> P; TUNE pitch before
// roll and D -> P -> I -> FF; tail D -> P -> I -> FF, then collective FF, then the stop gains
const AREA = { precondition: 0, mechanical: 0, logging: 0, filters: 1, governor: 2, cyclic: 3, tail: 4, rates: 5 };
const SEV = { action: 0, check: 1, watch: 2, info: 3 };
const STEP = ['G1', 'G12', 'D4', 'D6', 'T8', 'C2', 'T13', 'T4', 'C10', 'D5', 'G13', 'D1', 'D2', 'D3', 'H', 'F1', 'F2', 'F3', 'F5', 'F6', 'F8', 'F10', 'C11', 'F11', 'F4', 'F9',
    'G14', 'G6', 'G3', 'G4', 'G9', 'G5', 'G2', 'G10', 'G11', 'G8', 'G0', 'R1', 'SETUP'];
const ITEM = { C5: 11, C6: 12, C1: 12, C3: 13, C4: 13, C14: 20, C12: 30, C13: 31, T1: 11, T2: 12, T9: 13, T6: 20, T7: 20, T14: 21, T5: 22, T11: 30, T12: 31 };
const KIND = { d: 0, p: 1, i: 2, f: 3, o: 4, b: 5 };
const AXR = { pitch: 0, roll: 1, yaw: 2 };
function rank(r) {
    const id = r.id.split(':')[0], param = r.parameter || '', m = /^(roll|pitch|yaw)_([pidfbo])_gain$/.exec(param), g = /^gov_([fip])_gain$/.exec(param);
    if (g) return STEP.indexOf('G3') + 'fip'.indexOf(g[1]) / 10;
    if (m && (r.area === 'cyclic' || r.area === 'tail')) return 10 + KIND[m[2]];
    if (/collective_ff|precomp/.test(param)) return 20;
    if (/stop_gain/.test(param)) return 22;
    return ITEM[id] !== undefined ? ITEM[id] : STEP.indexOf(id) < 0 ? 99 : STEP.indexOf(id);
}
const sortKey = (r) => [AREA[r.area] === undefined ? 9 : AREA[r.area], SEV[r.severity], rank(r), AXR[r.axis] === undefined ? 3 : AXR[r.axis], num(r.profile) === null ? -1 : r.profile];
function compare(a, b) { const x = sortKey(a), y = sortKey(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

const OUT_KEYS = ['id', 'area', 'order', 'severity', 'title', 'text', 'parameter', 'scope', 'cliProfile', 'profile', 'axis', 'from', 'to', 'direction', 'cli', 'evidence', 'rule', 'confidence', 'blockedBy', 'caveats'];

// ---------------------------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------------------------

// Status of a row: finding (a flag, or a recommendation on one of its parameters), checked (a measured result), the
// needs-* that would let its checks run, no-check (no check of the app informs it: none exists, or it does not run in
// the app) or not-assessable (no log can inform it: COVERAGE nolog). The PID mode row is judged on the CLI capture.
function coverage(c, decisions, recommendations) {
    const counts = (sel) => ['flag', 'note', 'ok', 'skipped', 'error'].map(s => [s, sel.filter(f => f.severity === s).length]).filter(x => x[1]).map(x => `${x[1]} ${x[0]}`).join(', ');
    // a gain decision counts on the rows of its axis; as a flag on the rows of the gains it changes, as checked on the others
    const C7 = decisions.map(d => ({ id: 'C7', axis: d.axis, params: d.change ? (d.changes || []).map(s => `${d.axis}_${String(s.gain).toLowerCase()}_gain`) : [], severity: d.change ? 'flag' : 'ok', text: d.reason || 'change' }));
    const all = c.F.concat(C7), silent = Object.entries(NEW).filter(([, ids]) => !all.some(f => ids.includes(f.id)));   // a new module that gave no finding did not run
    const prof = c.cli && c.cli.selectedProfile !== null ? c.cli.profiles[c.cli.selectedProfile] : null, pm = pidModes(c);
    return COVERAGE.map(line => {
        const [section, area, groupName, params, checks, cliOnly, why, nolog] = line.split('|'), ids = checks ? checks.split(' ') : [], parameters = params.split(',');
        const axes = new Set(parameters.map(k => (/^(roll|pitch|yaw)_/.exec(k) || [])[1]).filter(Boolean)), modes = parameters.includes('pid_mode');
        // a finding counts on the rows it is about: C7 by axis and gain (above), D4 where its text names a parameter of the row
        const sel = all.filter(f => ids.includes(f.id)).map(f => f.id !== 'C7' ? f : !axes.has(f.axis) ? null : !isFlag(f) || f.params.some(k => parameters.includes(k)) ? f : Object.assign({}, f, { severity: 'ok' }))
            .filter(f => f && (f.id !== 'D4' || parameters.some(k => String(f.text).includes(k))));
        const real = sel.filter(f => !thin(f) && f.severity !== 'skipped' && f.severity !== 'error');
        const missing = c.fields ? [...new Set(ids.flatMap(id => FIELDS[id] || []))].filter(k => c.fields[k] && c.fields[k] !== 'present') : [];
        const skip = sel.filter(f => f.severity === 'skipped').map(f => String(f.text)), notRun = silent.filter(([, l]) => ids.some(id => l.includes(id))).map(([m]) => m);
        const advised = recommendations.some(r => r.severity !== 'info' && r.parameter && parameters.includes(r.parameter));
        const status = sel.some(isFlag) || advised ? 'finding' : real.length ? 'checked'
            : !ids.length ? (modes ? (!c.cli ? 'needs-cli' : pm.some(m => m.value !== null) ? 'checked' : 'not-assessable') : nolog === 'nolog' ? 'not-assessable' : 'no-check')
            : missing.length ? 'needs-fields' : cliOnly && !c.cli ? 'needs-cli'
            : ids.every(id => ELSEWHERE.includes(id) || notRun.some(m => NEW[m].includes(id))) ? 'no-check' : skip.some(t => /CLI|gear ratio/i.test(t)) ? 'needs-cli'
            : skip.some(t => /lacks|not logged|absent|missing|field/i.test(t)) ? 'needs-fields' : 'needs-flights';
        const perCheck = ids.map(id => { const s = sel.filter(f => f.id === id); return `${id} ${s.length ? counts(s) : 'no result'}`; }).join('; ');
        const cliVals = c.cli ? parameters.filter(k => !modes || k !== 'pid_mode').map(k => { const v = c.cli.global[k] !== undefined ? c.cli.global[k] : prof ? prof[k] : undefined; return v === undefined ? null : `${k} = ${v}`; }).filter(Boolean) : [];
        const esc = parameters.includes('blackbox_log_esc') && c.fields ? ['EscRPM', 'EscV', 'EscI', 'EscThr', 'Tesc', 'Ibat'].map(k => `${k} ${c.fields[k] || 'unknown'}`).join(', ') : '';
        const detail = [perCheck, notRun.length ? `${notRun.join(', ')} gave no finding (not run)` : '', missing.length ? `fields not logged: ${missing.join(', ')}` : '', cliOnly && !c.cli ? 'CLI only: load a CLI dump' : '',
            modes && pm ? `CLI pid_mode: ${[...group(pm, m => m.value === null ? 'unknown' : `${m.value}${m.absent ? ' (absent from the diff: the default)' : ''}`)].map(([v, l]) => `${v} on profile(s) ${l.map(m => m.profile).join(', ')}`).join('; ') || 'no profile section'}` : '',
            cliVals.length ? `CLI: ${cliVals.join(', ')}` : '', esc ? `ESC fields of the analysed log, none read by a check: ${esc}` : '', why || ''].filter(Boolean).join('. ');
        return { section: +section, area, group: groupName, parameters, checks: ids, status, detail };
    });
}

// ---------------------------------------------------------------------------------------------
// advise
// ---------------------------------------------------------------------------------------------

// wag_report.cjs section 8 is withdrawn by its author (analysis/fireball-wag/critique.md items 5 and 7): never used (guard 10)
const withdrawn = (x) => /wag_report/.test(String(x.module || '')) || /wag_report\.cjs\s*(section|§)\s*8/.test(String(x.source || ''));

function advise(input) {
    const inp = input || {}, notes = [], rawDecisions = Array.isArray(inp.decisions) ? inp.decisions : [];
    const all = (Array.isArray(inp.findings) ? inp.findings : []).filter(f => f && typeof f.id === 'string'), decisions = rawDecisions.filter(d => d && !withdrawn(d));
    const header = inp.header || {}, cli = inp.cli && inp.cli.profiles && inp.cli.global ? inp.cli : null, logs = Array.isArray(inp.logs) ? inp.logs : [];
    // bench logs are not flights: setup findings of logs that were not flown stay out (the tuning history H stays)
    const flown = logs.length ? new Set(logs.filter(l => l.flown).map(l => l.log)) : null;
    const F = all.filter(f => !withdrawn(f) && !(flown && f.module === 'setup' && f.id !== 'H' && logsOf(f).length && !logsOf(f).some(l => flown.has(l))));
    const ignored = all.filter(withdrawn).length + rawDecisions.length - decisions.length;
    if (ignored) notes.push(`${ignored} item(s) from wag_report.cjs section 8 ignored: withdrawn by its author (analysis/fireball-wag/critique.md).`);
    const flags = (id) => F.filter(f => f.id === id && isFlag(f));
    const c = { F, header, cli, logs, fields: inp.fields || null, flags, filterIssues: new Set(), staleCli: new Set(), topLine: null, filterAction: false,
        start: new Map(logs.filter(l => l.start !== undefined && l.start !== null).map(l => [l.log, l.start])), headerLog: inp.headerLog === undefined ? null : inp.headerLog, logBase: num(inp.logBase) || 0,
        headerProfile: num(inp.headerProfile) !== null ? inp.headerProfile : logs.length === 1 && num(logs[0].startProfile) !== null ? logs[0].startProfile : null };
    for (const f of flags('D4')) for (const m of String(f.text).matchAll(/ vs (\w+) /g)) c.staleCli.add(m[1]);
    const c2Axes = (f) => { const w = (/output limit \(([^)]*)\)/.exec(String(f.text)) || [])[1] || '', only = (a, b) => new RegExp(`mixer\\[${a}\\]`).test(w) && !new RegExp(`mixer\\[${b}\\]|ring|servo|collective`).test(w);
        return only(0, 1) ? ['roll'] : only(1, 0) ? ['pitch'] : ['roll', 'pitch']; };
    c.authority = (axis, p) => { const id = axis === 'yaw' ? 'T8' : 'C2', fl = flags(id).filter(f => (id === 'T8' || c2Axes(f).includes(axis)) && (!(num(p) > 0) || !(num(f.profile) > 0) || f.profile === p));
        return fl.length ? `${id} flag, ${fmt(sum(fl), 2)} s at an output limit in ${fl.length} log-profile pair(s)` : null; };

    // generators in GEN order (filters before the guards read c.filterIssues), then the report.cjs decisions
    const byId = group(F.filter(f => f.severity !== 'error'), f => f.id), known = new Set(Object.keys(GEN).concat(['C7', 'C8', 'C9', 'G7'])); // C7: decisions; C8, C9 report only; G7 a diagnostic note
    let recs = [];
    for (const [id, gen] of Object.entries(GEN)) if (byId.has(id) || gen.always) recs.push(...gen(byId.get(id) || [], c));
    recs.push(...decisionRecs(decisions, c));
    const errors = F.filter(f => f.severity === 'error');
    recs.push(...one(errors, { id: 'ERROR', area: 'logging', title: 'Some checks failed to run', rule: 'an analysis or judge error leaves its checks without results',
        text: [...group(errors, f => f.module || f.id)].map(([m, l]) => `${m}: ${l[0].text}${l.length > 1 ? ` (${l.length}x)` : ''}`).join('; ') }));
    const unknown = [...byId.keys()].filter(id => !known.has(id));
    if (unknown.length) notes.push(`no advice generator for check id(s) ${unknown.join(', ')}: they appear in the findings only.`);

    // guard 8: no governor gain change from logs where G0 says DIRECT / LIMIT, nor when the CLI says so and no log shows a PID governor
    const direct = new Set(F.filter(f => f.id === 'G0' && f.severity === 'note' && /DIRECT or LIMIT/.test(String(f.text))).flatMap(logsOf)), pidGov = F.some(f => f.id === 'G0' && f.severity === 'ok');
    const cliDirect = !!cli && /^(DIRECT|LIMIT|OFF)$/i.test(String(cli.global.gov_mode || '').trim()) && !pidGov;
    const dropped = recs.filter(r => /^gov_/.test(r.parameter || '') && (cliDirect || (r.evidence.length && r.evidence.every(e => logsOf(e).length && logsOf(e).every(l => direct.has(l))))));
    if (dropped.length) notes.push(`${dropped.length} governor gain change(s) dropped: the governor does not regulate (G0 DIRECT/LIMIT${cliDirect ? `, CLI gov_mode ${cli.global.gov_mode}` : ''}; guard 8).`);
    recs = merge(recs.filter(r => !dropped.includes(r)));
    c.filterAction = recs.some(r => r.area === 'filters' && r.severity === 'action' && r.sets);
    for (const r of recs) { guard(r, c); finish(r); if (r.evidence.length > RULES.maxEvidence) { r.caveats.push(`${r.evidence.length} findings; the first ${RULES.maxEvidence} are listed`); r.evidence = r.evidence.slice(0, RULES.maxEvidence); } }
    recs.sort(compare);
    const seen = new Map();
    const recommendations = recs.map((r, i) => { const o = {}; for (const k of OUT_KEYS) o[k] = r[k]; o.order = i + 1; const n = seen.get(o.id) || 0; seen.set(o.id, n + 1); if (n) o.id += `#${n + 1}`; return o; });

    if (!cli) notes.push('no CLI dump: CLI-only settings are unknown and profile values come from the log header, which holds only the arming profile.');
    const sections = cli ? Object.keys(cli.profiles).sort((a, b) => a - b) : [];
    if (cli && sections.length < RULES.pidProfiles) notes.push(`the CLI capture holds profile section(s) ${sections.join(', ') || 'none'} of ${RULES.pidProfiles} (CLI index): a plain \`${cli.kind}\` prints the current profile only, or the capture is cut short (${RULES.source.pidProfiles}); the values of the other profiles come from the log header and get no CLI: load \`diff all\`.`);
    if (!cli && !(c.headerProfile > 0)) notes.push('the arming profile of the analysed log is unknown: profile values from the log header get no CLI unless a recovered gain confirms them.');
    const ex = {}; for (const l of logs) for (const [k, v] of Object.entries(l.excluded || {})) if (num(v) !== null) ex[k] = (ex[k] || 0) + v;
    const EXCLUDED = { rescueS: 'rescue', levelModeS: 'angle, horizon or trainer mode', failsafeS: 'failsafe', groundS: 'ground contact', guardS: 'guard time around them' }; // health_more normalMask
    const shown = Object.entries(ex).filter(([, v]) => Math.round(v * 10) > 0); // what rounds to 0.0 s is not shown
    if (shown.length) notes.push(`excluded from the analysis: ${shown.map(([k, v]) => `${EXCLUDED[k] || k} ${fmt(v, 1)} s`).join(', ')}.`);
    const cnt = (s) => recommendations.filter(r => r.severity === s).length;
    notes.unshift(`${recommendations.length} recommendations: ${cnt('action')} action (${recommendations.filter(r => r.cli.length).length} with CLI), ${cnt('check')} check, ${cnt('watch')} watch, ${cnt('info')} info; from ${F.length} findings${decisions.length ? ` and ${decisions.length} gain decisions` : ''}.`);
    return { recommendations, coverage: coverage(c, decisions, recommendations), notes };
}

// One CLI script of the unblocked 'action' recommendations: global settings first, then per profile; ends with save. A
// title is one comment line whatever it holds, so only profile, set and save lines are commands.
function script(recommendations) {
    const title = (r) => `# ${String(r.title).replace(/\s+/g, ' ').trim()}`;
    const act = (recommendations || []).filter(r => r.severity === 'action' && r.cli && r.cli.length);
    if (!act.length) return '';
    const out = ['# Advice only: review every line before applying; nothing is sent to the flight controller.'], byP = new Map();
    for (const r of act) if (r.scope !== 'profile') out.push(title(r), ...r.cli);
    for (const r of act) if (r.scope === 'profile') { if (!byP.has(r.cli[0])) byP.set(r.cli[0], []); byP.get(r.cli[0]).push(title(r), ...r.cli.slice(1)); }
    for (const k of [...byP.keys()].sort()) out.push(k, ...byP.get(k));
    return out.concat('save').join('\n');
}

module.exports = { RULES, PARAMS, RANGE, COVERAGE, CHECKS: Object.keys(GEN), advise, script, floorsOk };
