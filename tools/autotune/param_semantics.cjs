'use strict';

/**
 * What is in force: the semantics table of the parameter journal for one firmware (RF-PARAM-1,
 * Blackbox_Params_Spec.md 4.3). The log gives the stored values, the stamped loader runs (A records), the boot values
 * (boot.* lines) and fingerprints. This table says which value a computation of the firmware uses:
 *
 *   by: 'live'    the consumer reads the stored value at each run (its tick in the PID cycle, or its task)
 *   by: 'loader'  the consumer uses the value that loader L read at its last run (A record) for the same slot; a later
 *                 change of the stored value is pending for it
 *   by: 'boot'    the consumer uses the value at boot (boot.* line, else the snapshot line) until the next boot
 *   no rule       the value is shown with the flag effect-unknown, never assumed
 *
 * An adjustment setter can also refresh runtime fields at once (adjustments). The fingerprint checks of param_log.cjs
 * (R and A records) find errors in this table, so it can be corrected without a new firmware and old logs read again.
 *
 *   const PS = require('./param_semantics.cjs');
 *   const table = PS.forFirmware(sysConfig['Firmware revision'], header.fixes);
 *
 * Firmware evidence: rotorflight-firmware release/4.6.0 (118e912), paths relative to src/main/. The PG numbers are from
 * pg/pg_ids.h, the CLI names and their PGs from the valueTable of cli/settings.c (generated, see NAMES).
 *
 * Worker-loadable (js/tuning_worker.js CommonJS shim): no Node API at module load.
 */

const RULES = {
    firmware: /^Rotorflight\s+4\.6\./,  // the revision line ("Rotorflight 4.6.0 (118e912) STM32G47X") of this table
};

// PG numbers of the tracked set (pg/pg_ids.h; spec 2.2)
const PG = {
    FAILSAFE_CONFIG: 1, BOARD_ALIGNMENT: 2, BLACKBOX_CONFIG: 5, MOTOR_CONFIG: 6, GYRO_CONFIG: 10, BATTERY_CONFIG: 11,
    CONTROL_RATE_PROFILES: 12, PID_PROFILE: 14, ARMING_CONFIG: 16, SYSTEM_CONFIG: 18, FEATURE_CONFIG: 19, IMU_CONFIG: 22,
    RX_CONFIG: 24, RC_CONTROLS_CONFIG: 25, ACCELEROMETER_CONFIG: 35, SERVO_PARAMS: 42, RX_FAILSAFE_CHANNEL_CONFIG: 43,
    POSITION: 56, CURRENT_SENSOR_ADC_CONFIG: 256, VOLTAGE_SENSOR_ADC_CONFIG: 258, PID_CONFIG: 504, ESC_SENSOR_CONFIG: 517,
    GYRO_DEVICE_CONFIG: 540, RPM_FILTER_CONFIG: 544, DYN_NOTCH_CONFIG: 554, FREQ_SENSOR_CONFIG: 1000, GOVERNOR_CONFIG: 1001,
    GENERIC_MIXER_CONFIG: 1002, GENERIC_MIXER_RULES: 1003, GENERIC_MIXER_INPUTS: 1004,
};

// The CLI names of each tracked PG with names (cli/settings.c valueTable of 4.6.0, all targets; generated with a scan of
// the table: name, section flag, PG). PID_PROFILE names are the p<k>. keys, CONTROL_RATE_PROFILES names the r<k>. keys.
const NAMES = {
    [PG.PID_PROFILE]: 'profile_name pid_mode pitch_p_gain pitch_i_gain pitch_d_gain pitch_f_gain pitch_b_gain pitch_o_gain roll_p_gain roll_i_gain roll_d_gain roll_f_gain roll_b_gain roll_o_gain yaw_p_gain yaw_i_gain yaw_d_gain yaw_b_gain yaw_f_gain pitch_d_cutoff pitch_b_cutoff pitch_gyro_cutoff roll_d_cutoff roll_b_cutoff roll_gyro_cutoff yaw_d_cutoff yaw_b_cutoff yaw_gyro_cutoff yaw_cw_stop_gain yaw_ccw_stop_gain yaw_precomp_cutoff yaw_cyclic_ff_gain yaw_collective_ff_gain yaw_inertia_precomp_gain yaw_inertia_precomp_cutoff pitch_collective_ff_gain cyclic_cross_coupling_gain cyclic_cross_coupling_ratio cyclic_cross_coupling_cutoff error_limit offset_limit error_decay_time_ground error_decay_time_cyclic error_decay_time_yaw error_decay_limit_cyclic error_decay_limit_yaw offset_flood_relax_level offset_flood_relax_cutoff iterm_relax_type iterm_relax_level iterm_relax_cutoff angle_level_strength angle_level_limit horizon_level_strength horizon_transition horizon_tilt_effect horizon_tilt_expert_mode acro_trainer_angle_limit acro_trainer_lookahead_ms acro_trainer_gain rescue_mode rescue_flip rescue_flip_gain rescue_level_gain rescue_pull_up_time rescue_climb_time rescue_flip_time rescue_exit_time rescue_pull_up_collective rescue_climb_collective rescue_hover_collective rescue_hover_altitude rescue_alt_p_gain rescue_alt_i_gain rescue_alt_d_gain rescue_max_sp_rate rescue_max_sp_accel rescue_max_collective gov_use_fallback_precomp gov_use_pid_spoolup gov_use_voltage_comp gov_use_dyn_min_throttle gov_headspeed gov_gain gov_p_gain gov_i_gain gov_d_gain gov_f_gain gov_p_limit gov_i_limit gov_d_limit gov_f_limit gov_tta_gain gov_tta_limit gov_yaw_ff_weight gov_cyclic_ff_weight gov_collective_ff_weight gov_max_throttle gov_min_throttle gov_fallback_drop gov_collective_curve gov_dyn_min_throttle',
    [PG.CONTROL_RATE_PROFILES]: 'rateprofile_name rates_type roll_rc_rate pitch_rc_rate yaw_rc_rate collective_rc_rate roll_expo pitch_expo yaw_expo collective_expo roll_srate pitch_srate yaw_srate collective_srate roll_accel_limit pitch_accel_limit yaw_accel_limit collective_accel_limit roll_level_expo pitch_level_expo roll_response pitch_response yaw_response collective_response cyclic_ring cyclic_polar setpoint_boost_gain setpoint_boost_cutoff yaw_dynamic_ceiling_gain yaw_dynamic_deadband_gain yaw_dynamic_deadband_filter yaw_dynamic_deadband_cutoff',
    [PG.SYSTEM_CONFIG]: 'system_hse_mhz task_statistics debug_mode debug_axis cpu_overclock',
    [PG.PID_CONFIG]: 'pid_process_denom filter_process_denom',
    [PG.GYRO_CONFIG]: 'gyro_to_use gyro_hardware_lpf gyro_overflow_detect gyro_high_range gyro_rate_sync gyro_calib_duration gyro_calib_noise_limit gyro_decimation_hz gyro_lpf1_type gyro_lpf1_static_hz gyro_lpf1_dyn_min_hz gyro_lpf1_dyn_max_hz gyro_lpf2_type gyro_lpf2_static_hz gyro_notch1_hz gyro_notch1_cutoff gyro_notch2_hz gyro_notch2_cutoff',
    [PG.GYRO_DEVICE_CONFIG]: 'gyro_1_bustype gyro_1_spibus gyro_1_i2cBus gyro_1_i2c_address gyro_1_sensor_align gyro_1_align_roll gyro_1_align_pitch gyro_1_align_yaw gyro_2_bustype gyro_2_spibus gyro_2_i2cBus gyro_2_i2c_address gyro_2_sensor_align gyro_2_align_roll gyro_2_align_pitch gyro_2_align_yaw',
    [PG.ACCELEROMETER_CONFIG]: 'acc_hardware acc_high_range acc_lpf_hz acc_trim_pitch acc_trim_roll acc_calibration',
    [PG.BOARD_ALIGNMENT]: 'align_board_roll align_board_pitch align_board_yaw',
    [PG.IMU_CONFIG]: 'imu_dcm_kp imu_dcm_ki',
    [PG.DYN_NOTCH_CONFIG]: 'dyn_notch_count dyn_notch_q dyn_notch_min_hz dyn_notch_max_hz',
    [PG.RPM_FILTER_CONFIG]: 'gyro_rpm_notch_preset gyro_rpm_notch_min_hz gyro_rpm_notch_source_pitch gyro_rpm_notch_center_pitch gyro_rpm_notch_q_pitch gyro_rpm_notch_source_roll gyro_rpm_notch_center_roll gyro_rpm_notch_q_roll gyro_rpm_notch_source_yaw gyro_rpm_notch_center_yaw gyro_rpm_notch_q_yaw',
    [PG.GOVERNOR_CONFIG]: 'gov_mode gov_throttle_type gov_startup_time gov_spoolup_time gov_tracking_time gov_recovery_time gov_spooldown_time gov_throttle_hold_timeout gov_autorotation_timeout gov_handover_throttle gov_idle_throttle gov_auto_throttle gov_bypass_throttle gov_pwr_filter gov_rpm_filter gov_tta_filter gov_ff_filter gov_d_filter',
    [PG.MOTOR_CONFIG]: 'min_throttle max_throttle min_command dshot_burst dshot_bidir dshot_bitbang dshot_bitbang_timer use_unsynced_pwm motor_pwm_protocol motor_pwm_rate motor_control_mode motor_poles motor_rpm_lpf motor_rpm_factor main_rotor_gear_ratio tail_rotor_gear_ratio',
    [PG.ESC_SENSOR_CONFIG]: 'esc_sensor_protocol esc_sensor_halfduplex esc_sensor_pinswap esc_sensor_update_hz esc_sensor_current_offset esc_sensor_filter_cutoff esc_sensor_voltage_correction esc_sensor_current_correction esc_sensor_consumption_correction',
    [PG.FREQ_SENSOR_CONFIG]: 'freq_input_pull freq_input_edge freq_input_minhz',
    [PG.GENERIC_MIXER_CONFIG]: 'main_rotor_dir tail_rotor_mode tail_motor_idle tail_center_trim swash_type swash_ring swash_phase swash_roll_trim swash_pitch_trim swash_collective_trim swash_pitch_limit swash_tta_precomp swash_geo_correction collective_tilt_correction_pos collective_tilt_correction_neg',
    [PG.RC_CONTROLS_CONFIG]: 'rc_center rc_deflection rc_min_throttle rc_max_throttle rc_smoothness rc_threshold deadband yaw_deadband',
    [PG.RX_CONFIG]: 'rx_pulse_min rx_pulse_max rssi_channel rssi_src_frame_errors rssi_scale rssi_offset rssi_invert rssi_src_frame_lpf_period serialrx_provider serialrx_inverted serialrx_halfduplex serialrx_pinswap spektrum_sat_bind spektrum_sat_bind_autoreset srxl2_unit_id srxl2_baud_fast sbus_baud_fast crsf_use_rx_snr crsf_use_negotiated_baud',
    [PG.FAILSAFE_CONFIG]: 'failsafe_delay failsafe_off_delay failsafe_throttle failsafe_switch_mode failsafe_throttle_low_delay failsafe_procedure failsafe_recovery_delay failsafe_stick_threshold',
    [PG.ARMING_CONFIG]: 'auto_disarm_delay gyro_cal_on_first_arm pwr_on_arm_grace enable_stick_arming enable_stick_commands wiggle_strength wiggle_frequency wiggle_enable_ready wiggle_enable_armed wiggle_enable_error wiggle_enable_fatal',
    [PG.BATTERY_CONFIG]: 'bat_profile bat_capacity vbat_max_cell_voltage vbat_full_cell_voltage vbat_min_cell_voltage vbat_warning_cell_voltage vbat_hysteresis current_meter battery_meter vbat_detect_cell_voltage use_vbat_alerts use_cbat_alerts cbat_alert_percent vbat_cutoff_percent battery_cell_count vbat_lpf_hz ibat_lpf_hz vbat_duration_for_warning vbat_duration_for_critical vbat_update_hz ibat_update_hz smartfuel smartfuel_voltage_drop_rate smartfuel_charge_drop_rate smartfuel_sag_gain',
    [PG.VOLTAGE_SENSOR_ADC_CONFIG]: 'vbat_scale vbat_divider vbat_multiplier vbat_cutoff vbec_scale vbec_divider vbec_multiplier vbec_cutoff vbus_scale vbus_divider vbus_multiplier vbus_cutoff vext_scale vext_divider vext_multiplier vext_cutoff',
    [PG.CURRENT_SENSOR_ADC_CONFIG]: 'ibata_scale ibata_offset ibata_cutoff',
    [PG.BLACKBOX_CONFIG]: 'blackbox_mode blackbox_device blackbox_rate_denom blackbox_log_command blackbox_log_setpoint blackbox_log_mixer blackbox_log_pid blackbox_log_attitude blackbox_log_gyro_raw blackbox_log_gyro blackbox_log_acc blackbox_log_mag blackbox_log_alt blackbox_log_gps blackbox_log_battery blackbox_log_motors blackbox_log_servos blackbox_log_rpm blackbox_log_rssi blackbox_log_vbec blackbox_log_vbus blackbox_log_temp blackbox_log_esc blackbox_log_bec blackbox_log_esc2 blackbox_log_governor blackbox_initial_erase_kb blackbox_rolling_erase blackbox_grace_period blackbox_params',
    [PG.POSITION]: 'position_alt_source position_baro_alt_lpf position_baro_offset_lpf position_gps_alt_lpf position_gps_offset_lpf position_gps_min_sats position_vario_lpf',
};
const ELEMENT_PG = { servo: PG.SERVO_PARAMS, mixin: PG.GENERIC_MIXER_INPUTS, mixrule: PG.GENERIC_MIXER_RULES, rxfail: PG.RX_FAILSAFE_CHANNEL_CONFIG, feature: PG.FEATURE_CONFIG };
const PG_OF_NAME = new Map();
for (const [pgn, names] of Object.entries(NAMES)) for (const n of names.split(' ')) if (!PG_OF_NAME.has(n)) PG_OF_NAME.set(n, +pgn);

// The PG of a journal key (spec 2.4 keys): '<name>', 'p<k>.<name>', 'r<k>.<name>', '<key>[<i>]', 'el.<kind>.<i>',
// 'pg.<pgn>+<off>', 'pid_profile', 'rate_profile'. null when the name is not in the table.
function pgOfKey(key) {
    const k = String(key).replace(/\[\d+\]$/, '');
    let m;
    if (/^p[0-5]\./.test(k)) return PG.PID_PROFILE;
    if (/^r[0-5]\./.test(k)) return PG.CONTROL_RATE_PROFILES;
    if (k === 'pid_profile' || k === 'rate_profile') return PG.SYSTEM_CONFIG;   // walkElements: pidProfileIndex, activeRateProfile
    if ((m = /^pg\.(\d+)\+\d+$/.exec(k))) return +m[1];
    if ((m = /^el\.([a-z]+)(?:\.\d+)?$/.exec(k))) return ELEMENT_PG[m[1]] === undefined ? null : ELEMENT_PG[m[1]];
    return PG_OF_NAME.has(k) ? PG_OF_NAME.get(k) : null;
}

// The profile slot of a key: { kind: 'pid'|'rate', slot } or null (a master key)
function slotOfKey(key) {
    const m = /^([pr])([0-5])\./.exec(String(key));
    return m ? { kind: m[1] === 'p' ? 'pid' : 'rate', slot: +m[2] } : null;
}

// Loaders (A records) and the PGs that each one reads (spec 3.6 regions; the slot PG only for its own slot)
const ALL_TRACKED = Object.values(PG);
const LOADERS = {
    pid: { reads: [PG.PID_PROFILE, PG.PID_CONFIG, PG.SYSTEM_CONFIG, PG.GOVERNOR_CONFIG, PG.MOTOR_CONFIG], slot: 'pid', src: 'flight/pid.c:583-717 pidLoadProfile' },
    gov: { reads: [PG.PID_PROFILE, PG.GOVERNOR_CONFIG, PG.MOTOR_CONFIG], slot: 'pid', src: 'flight/governor.c:1543-1601 governorInitProfile' },
    rsc: { reads: [PG.PID_PROFILE], slot: 'pid', src: 'flight/rescue.c:525-551 rescueInitProfile' },
    sp: { reads: [PG.CONTROL_RATE_PROFILES, PG.SYSTEM_CONFIG], slot: 'rate', src: 'flight/setpoint.c:207-246 setpointInitProfile' },
    gyrof: { reads: [PG.GYRO_CONFIG, PG.DYN_NOTCH_CONFIG, PG.PID_CONFIG], slot: null, src: 'sensors/gyro_init.c:133-182 gyroInitFilters' },
    rpmf: { reads: [PG.RPM_FILTER_CONFIG, PG.MOTOR_CONFIG, PG.FREQ_SENSOR_CONFIG], slot: null, src: 'flight/rpm_filter.c:177-274' },
    mix: { reads: [PG.GENERIC_MIXER_CONFIG, PG.GENERIC_MIXER_INPUTS, PG.GENERIC_MIXER_RULES, PG.SERVO_PARAMS], slot: null, src: 'flight/mixer.c:613-642 mixerInitConfig' },
    rcctl: { reads: [PG.RC_CONTROLS_CONFIG, PG.RX_CONFIG], slot: null, src: 'fc/rc_controls.c:376' },
    act: { reads: ALL_TRACKED, slot: null, src: 'config/config.c:149-173 activateConfig' },
    feat: { reads: [PG.FEATURE_CONFIG], slot: null, src: 'config/feature.c:34-37 featureInit' },
};
// The fingerprints of the R and A records (spec 3.7) and their loaders
const FINGERPRINT_LOADER = { pid: 'pid', gov: 'gov', sp: 'sp' };

// Keys (spec 4.3 seed for 4.6.0), first match wins. use[0] is the default consumer. fields: a use for one field of an
// element key (el.servo: field 5 is the rate). Ticks of the consumers come from param_phase (pid, sp, mix, mot, fupd, ...),
// 'filter' is the gyro-filter task, 'rx' and 'acc' are tasks outside the PID loop (transition frames, spec 2.5).
const PROFILE_PID = /^p[0-5]\.(?:pid_mode|(?:roll|pitch|yaw)_[pidfbo]_gain|(?:roll|pitch|yaw)_(?:gyro|d|b)_cutoff|offset_limit|offset_flood_relax_(?:level|cutoff)|iterm_relax_(?:type|level|cutoff)|error_limit|error_decay_(?:time_(?:ground|cyclic|yaw)|limit_(?:cyclic|yaw))|yaw_(?:cw|ccw)_stop_gain|yaw_precomp_cutoff|yaw_(?:cyclic|collective)_ff_gain|yaw_inertia_precomp_(?:gain|cutoff)|pitch_collective_ff_gain|cyclic_cross_coupling_(?:gain|ratio|cutoff))$/;
const KEYS_46 = [
    { match: /^pid_profile$/, use: [{ by: 'live', consumer: 'pid' }],
        src: 'config/config.c:839-851 changePidProfile sets the index and the pointer, then loads the profile (A pid)' },
    { match: /^rate_profile$/, use: [{ by: 'live', consumer: 'sp' }],
        src: 'fc/rc_rates.c:435-442 changeControlRateProfile sets the index, then loads the profile (A sp)' },
    { match: PROFILE_PID, use: [{ by: 'loader', loader: 'pid', consumer: 'pid' }],
        src: 'gains, filter cutoffs, offsets, relax, precomp, cross-coupling: flight/pid.c:583-717 pidLoadProfile' },
    { match: /^p[0-5]\.gov_/, use: [{ by: 'loader', loader: 'gov', also: ['pid'], consumer: 'pid' }],
        src: 'governor profile: flight/governor.c:1543-1601 governorInitProfile, called by pidLoadProfile (pid.c:709)' },
    { match: /^p[0-5]\.rescue_/, use: [{ by: 'loader', loader: 'rsc', also: ['pid'], consumer: 'pid' }],
        src: 'rescue profile: flight/rescue.c:525-551 rescueInitProfile, called by pidLoadProfile (pid.c:716)' },
    { match: /^p[0-5]\.(?:angle_|horizon_|acro_trainer_)/, use: [{ by: 'loader', loader: 'pid', consumer: 'pid' }],
        src: 'leveling and trainer: pid.c:711, :714' },
    { match: /^r[0-5]\.(?:rates_type|(?:roll|pitch|yaw|collective)_(?:rc_rate|srate|expo))$/,
        use: [{ by: 'live', consumer: 'sp' }, { by: 'loader', loader: 'sp', consumer: 'sp-ring' }],
        src: 'rate curve: live in the setpoint (fc/rc_rates.c:71-163 read at each run), cyclic ring limit cached at setpoint.c:237-240' },
    { match: /^r[0-5]\.(?:(?:roll|pitch|yaw|collective)_(?:response|accel_limit)|setpoint_boost_(?:gain|cutoff)|yaw_dynamic_(?:ceiling_gain|deadband_gain|deadband_filter|deadband_cutoff)|cyclic_ring|cyclic_polar)$/,
        use: [{ by: 'loader', loader: 'sp', consumer: 'sp' }], src: 'flight/setpoint.c:207-246 setpointInitProfile' },
    { match: /^gov_/, use: [{ by: 'boot', consumer: 'pid' }], src: 'GOVERNOR_CONFIG: flight/governor.c:1611-1672 governorInit, only from fc/init.c:799' },
    { match: /^debug_(?:mode|axis)$/, use: [{ by: 'boot' }], src: 'fc/init.c:411-412' },
    { match: /^(?:pid|filter)_process_denom$/, use: [{ by: 'boot' }], src: 'fc/init.c:685-691, sensors/gyro_init.c:629-630' },
    { match: /^(?:motor_poles|main_rotor_gear_ratio|tail_rotor_gear_ratio)$/, use: [{ by: 'boot' }],
        src: 'flight/motors.c:251 rpmSourceInit (fc/init.c:784)' },
    { match: /^gyro_hardware_lpf$/, use: [{ by: 'boot' }], src: 'gyro device init at boot' },
    { match: /^(?:gyro_decimation_hz|gyro_lpf1_type|gyro_lpf1_static_hz|gyro_lpf1_dyn_min_hz|gyro_lpf1_dyn_max_hz|gyro_lpf2_type|gyro_lpf2_static_hz|gyro_notch[12]_(?:hz|cutoff))$/,
        use: [{ by: 'loader', loader: 'gyrof', consumer: 'filter' }], src: 'sensors/gyro_init.c:133-182 gyroInitFilters' },
    { match: /^dyn_notch_/, use: [{ by: 'boot', consumer: 'filter' }], src: 'flight/dyn_notch_filter.c:147-160 dynNotchInit, only from fc/init.c:794' },
    { match: /^gyro_rpm_notch_/, use: [{ by: 'loader', loader: 'rpmf', consumer: 'filter' }], src: 'flight/rpm_filter.c:177-274' },
    { match: /^(?:swash_pitch_limit|swash_ring|swash_phase|swash_(?:roll|pitch|collective)_trim|swash_tta_precomp|swash_geo_correction|tail_motor_idle|tail_center_trim)$/,
        use: [{ by: 'loader', loader: 'mix', consumer: 'mix' }], src: 'flight/mixer.c:613-642 mixerInitConfig' },
    { match: /^el\.mixin\.\d+$/, use: [{ by: 'live', consumer: 'mix' }], src: 'flight/mixer.c:184-238, :421, :495 (mixerInputs read at each run)' },
    { match: /^el\.mixrule\.\d+$/, use: [{ by: 'live', consumer: 'mix' }], src: 'flight/mixer.c:492-498 (mixerRules read at each run)' },
    { match: /^el\.servo\.\d+$/, use: [{ by: 'live', consumer: 'mot' }], fields: { 5: { by: 'boot' } },
        src: 'flight/servos.c:286-330 servoUpdate reads servoParams at each run; the rate (field 5) only at boot, servos.c:139-190' },
    { match: /^rc_center$/, use: [{ by: 'live', consumer: 'rx' }], src: 'fc/rc.c:222 (RX task, fc/tasks.c:211)' },
    { match: /^(?:rc_deflection|rc_min_throttle|rc_max_throttle|deadband|yaw_deadband)$/, use: [{ by: 'loader', loader: 'act', consumer: 'rx' }],
        src: 'fc/rc.c:226-246 initRcProcessing (activateConfig)' },
    { match: /^acc_trim_(?:pitch|roll)$/, use: [{ by: 'live', consumer: 'acc' }], src: 'fc/tasks.c:164 (the ACC task passes the trims by pointer)' },
    { match: /^acc_lpf_hz$/, use: [{ by: 'loader', loader: 'act', consumer: 'acc' }], src: 'sensors/acceleration_init.c:337-341 accInitFilters (activateConfig)' },
    { match: /^imu_dcm_k[pi]$/, use: [{ by: 'loader', loader: 'act', consumer: 'acc' }], src: 'flight/imu.c:151-154 imuConfigure (config/config.c:167)' },
    { match: /^el\.feature$/, use: [{ by: 'loader', loader: 'feat', consumer: 'mask' }, { by: 'boot', consumer: 'subsystems' }],
        src: 'config/feature.c:34-37 runtime mask; the subsystems start at boot' },
];

// Adjustment functions (fc/rc_adjustments.h) and the stored keys that their setters refresh at once in the runtime
// (scratchpad adj_setters.txt, from the set_ADJUSTMENT_* setters of 4.6.0). scope: p = the current PID profile slot,
// r = the current rate profile slot, m = master. module: the fingerprint that the refresh changes.
const ADJ = (scope, module, refresh, src) => ({ scope, module, refresh, src });
const ADJUSTMENTS_46 = {
    1: ADJ('r', null, [], 'rate profile change: own A records'), 2: ADJ('p', null, [], 'PID profile change: own A records'),
    5: ADJ('r', 'sp', [], 'pitch srate: curve live, ring limit cached (rc_rates.c:71-163)'), 6: ADJ('r', 'sp', [], 'roll srate'), 7: ADJ('r', 'sp', [], 'yaw srate'),
    8: ADJ('r', 'sp', [], 'pitch rc rate'), 9: ADJ('r', 'sp', [], 'roll rc rate'), 10: ADJ('r', 'sp', [], 'yaw rc rate'),
    11: ADJ('r', 'sp', [], 'pitch expo'), 12: ADJ('r', 'sp', [], 'roll expo'), 13: ADJ('r', 'sp', [], 'yaw expo'),
    14: ADJ('p', 'pid', ['pitch_p_gain'], 'pid.c'), 15: ADJ('p', 'pid', ['pitch_i_gain'], 'pid.c'), 16: ADJ('p', 'pid', ['pitch_d_gain'], 'pid.c'), 17: ADJ('p', 'pid', ['pitch_f_gain'], 'pid.c'),
    18: ADJ('p', 'pid', ['roll_p_gain'], 'pid.c'), 19: ADJ('p', 'pid', ['roll_i_gain'], 'pid.c'), 20: ADJ('p', 'pid', ['roll_d_gain'], 'pid.c'), 21: ADJ('p', 'pid', ['roll_f_gain'], 'pid.c'),
    22: ADJ('p', 'pid', ['yaw_p_gain'], 'pid.c'), 23: ADJ('p', 'pid', ['yaw_i_gain'], 'pid.c'), 24: ADJ('p', 'pid', ['yaw_d_gain'], 'pid.c'), 25: ADJ('p', 'pid', ['yaw_f_gain'], 'pid.c'),
    26: ADJ('p', 'pid', ['yaw_cw_stop_gain'], 'pid.c'), 27: ADJ('p', 'pid', ['yaw_ccw_stop_gain'], 'pid.c'),
    28: ADJ('p', 'pid', ['yaw_cyclic_ff_gain'], 'pid.c'), 29: ADJ('p', 'pid', ['yaw_collective_ff_gain'], 'pid.c'),
    32: ADJ('p', 'pid', ['pitch_collective_ff_gain'], 'pid.c'),
    33: ADJ('p', 'pid', ['pitch_gyro_cutoff'], 'pid.c filterUpdate'), 34: ADJ('p', 'pid', ['roll_gyro_cutoff'], 'pid.c'), 35: ADJ('p', 'pid', ['yaw_gyro_cutoff'], 'pid.c'),
    36: ADJ('p', 'pid', ['pitch_d_cutoff'], 'pid.c difFilterUpdate'), 37: ADJ('p', 'pid', ['roll_d_cutoff'], 'pid.c'), 38: ADJ('p', 'pid', ['yaw_d_cutoff'], 'pid.c'),
    39: ADJ('p', 'rsc', ['rescue_climb_collective'], 'rescue.c'), 40: ADJ('p', 'rsc', ['rescue_hover_collective'], 'rescue.c'), 41: ADJ('p', 'rsc', ['rescue_hover_altitude'], 'rescue.c'),
    42: ADJ('p', 'rsc', ['rescue_alt_p_gain'], 'rescue.c'), 43: ADJ('p', 'rsc', ['rescue_alt_i_gain'], 'rescue.c'), 44: ADJ('p', 'rsc', ['rescue_alt_d_gain'], 'rescue.c'),
    45: ADJ('p', 'pid', ['angle_level_strength'], 'leveling.c'), 46: ADJ('p', 'pid', ['horizon_level_strength'], 'leveling.c'), 47: ADJ('p', 'pid', ['acro_trainer_gain'], 'trainer.c'),
    48: ADJ('p', 'gov', ['gov_gain'], 'governor.c'), 49: ADJ('p', 'gov', ['gov_p_gain'], 'governor.c'), 50: ADJ('p', 'gov', ['gov_i_gain'], 'governor.c'),
    51: ADJ('p', 'gov', ['gov_d_gain'], 'governor.c'), 52: ADJ('p', 'gov', ['gov_f_gain'], 'governor.c'),
    53: ADJ('p', 'gov', ['gov_tta_gain', 'gov_tta_limit'], 'governor.c govInitTTA reads both'),
    54: ADJ('p', 'gov', ['gov_cyclic_ff_weight'], 'governor.c'), 55: ADJ('p', 'gov', ['gov_collective_ff_weight'], 'governor.c'),
    56: ADJ('p', 'pid', ['pitch_b_gain'], 'pid.c'), 57: ADJ('p', 'pid', ['roll_b_gain'], 'pid.c'), 58: ADJ('p', 'pid', ['yaw_b_gain'], 'pid.c'),
    59: ADJ('p', 'pid', ['pitch_o_gain'], 'pid.c'), 60: ADJ('p', 'pid', ['roll_o_gain'], 'pid.c'),
    61: ADJ('p', 'pid', ['cyclic_cross_coupling_gain', 'cyclic_cross_coupling_ratio'], 'pid.c: both setters use gain and ratio'),
    62: ADJ('p', 'pid', ['cyclic_cross_coupling_gain', 'cyclic_cross_coupling_ratio'], 'pid.c'), 63: ADJ('p', 'pid', ['cyclic_cross_coupling_cutoff'], 'pid.c'),
    64: ADJ('m', null, ['acc_trim_pitch'], 'acceleration_init.c (live anyway)'), 65: ADJ('m', null, ['acc_trim_roll'], 'acceleration_init.c'),
    66: ADJ('p', 'pid', ['yaw_inertia_precomp_gain'], 'pid.c'), 67: ADJ('p', 'pid', ['yaw_inertia_precomp_cutoff'], 'pid.c'),
    68: ADJ('r', 'sp', [], 'setpoint boost: profile only, setpoint.c:96-129'), 69: ADJ('r', 'sp', [], 'setpoint boost'), 70: ADJ('r', 'sp', [], 'setpoint boost'), 71: ADJ('r', 'sp', [], 'setpoint boost'),
    72: ADJ('r', 'sp', ['yaw_dynamic_ceiling_gain'], 'setpoint.c:136-160'), 73: ADJ('r', 'sp', ['yaw_dynamic_deadband_gain'], 'setpoint.c'), 74: ADJ('r', 'sp', ['yaw_dynamic_deadband_filter'], 'setpoint.c'),
    75: ADJ('p', 'pid', ['yaw_precomp_cutoff'], 'pid.c'),
    76: ADJ('m', 'gov', ['gov_idle_throttle', 'gov_auto_throttle'], 'governor.c:1359-1377'), 77: ADJ('m', 'gov', ['gov_idle_throttle', 'gov_auto_throttle'], 'governor.c:1359-1377'),
    78: ADJ('p', 'gov', ['gov_max_throttle', 'gov_min_throttle'], 'governor.c validateAndSetMinMaxThrottle'), 79: ADJ('p', 'gov', ['gov_min_throttle'], 'governor.c'),
    80: ADJ('p', 'gov', ['gov_headspeed'], 'governor.c'), 81: ADJ('p', 'gov', ['gov_yaw_ff_weight'], 'governor.c'),
};

// CLI lookup tables of the classic header keys that the firmware writes as numbers (cli/settings.c of 4.6.0)
const LOOKUPS = {
    OFF_ON: ['OFF', 'ON'],
    RATES_TYPE: ['NONE', 'BETAFLIGHT', 'RACEFLIGHT', 'KISS', 'ACTUAL', 'QUICK', 'ROTORFLIGHT'],
    ERROR_RELAX_TYPE: ['OFF', 'RP', 'RPY'],
    GYRO: ['FIRST', 'SECOND', 'BOTH'],
    GYRO_HARDWARE_LPF: ['NORMAL', 'OPTION_1', 'OPTION_2', 'EXPERIMENTAL'],
    LPF_TYPE: ['NONE', 'FIRST_ORDER', 'SECOND_ORDER', 'PT1', 'PT2', 'PT3', 'ORDER1', 'BUTTER', 'BESSEL', 'DAMPED'],
    ACC_HARDWARE: ['AUTO', 'NONE', 'ADXL345', 'MPU6050', 'MMA8452', 'BMA280', 'LSM303DLHC', 'MPU6000', 'MPU6500', 'MPU9250', 'ICM20601', 'ICM20602',
        'ICM20608G', 'ICM20649', 'ICM20689', 'ICM42605', 'ICM42688P', 'BMI160', 'BMI270', 'LSM6DSO', 'BMI088', 'BMI323', 'FAKE'],
    SERIAL_RX: ['SPEK1024', 'SPEK2048', 'SBUS', 'SUMD', 'SUMH', 'XB-B', 'XB-B-RJ01', 'IBUS', 'JETIEXBUS', 'CRSF', 'SRXL', 'CUSTOM', 'FPORT', 'SRXL2',
        'GHST', 'SBUS2', 'FPORT2', 'FBUS', 'XB-A', 'IBUS2'],
    PWM_PROTOCOL: ['PWM', 'ONESHOT125', 'ONESHOT42', 'MULTISHOT', 'RESERVED', 'DSHOT150', 'DSHOT300', 'DSHOT600', 'PROSHOT1000', 'CASTLE', 'DISABLED'],
};

// The classic header keys (blackbox/blackbox.c:1597-1779 of 4.6.0) from the journal state (spec 4.4). A source is
// { p: name } (the PID slot of the frame), { r: name } (the rate slot), { m: name } (master), { rt: field } (param_rt),
// { boot: name } (boot value: boot.* line, else the snapshot), { el: key, field: i }, { feature: true } (el.feature hex
// as decimal); lookup: the name table, scale: a factor, div: a param_rt field to divide by (whole result). Keys of PGs that are not tracked (baro, mag), runtime values
// (vbatref, acc_1G, gyro_scale) and fields_mask (bitset names) are not built.
const ax = (kind, fmt) => ['roll', 'pitch', 'yaw'].map(a => ({ [kind]: fmt.replace('%', a) }));
const CLASSIC_46 = [
    ['features', [{ feature: true }]],
    ['vbat_scale', [{ m: 'vbat_scale' }]],
    ['vbatcellvoltage', [{ m: 'vbat_min_cell_voltage' }, { m: 'vbat_warning_cell_voltage' }, { m: 'vbat_max_cell_voltage' }]],
    ['currentSensor', [{ m: 'ibata_offset' }, { m: 'ibata_scale' }]],
    // the classic line is gyro.sampleLooptime (blackbox.c:1695), param_rt looptime is gyro.targetLooptime
    // (blackbox_params_format.c HDR_RUNTIME) = pid_denom * sampleLooptime (sensors/gyro_init.c:633-635)
    ['looptime', [{ rt: 'looptime', div: 'pid_denom' }]],
    ['pid_process_denom', [{ rt: 'pid_denom' }]],
    ['filter_process_denom', [{ rt: 'filter_denom' }]],
    ['rates_type', [{ r: 'rates_type', lookup: 'RATES_TYPE' }]],
    ['rc_rates', ax('r', '%_rc_rate')],
    ['rc_expo', ax('r', '%_expo')],
    ['rates', ax('r', '%_srate')],
    ['response_time', ax('r', '%_response')],
    ['accel_limit', ax('r', '%_accel_limit')],
    ...['roll', 'pitch', 'yaw'].map(a => [`${a}PID`, ['p', 'i', 'd', 'f', 'b'].map(t => ({ p: `${a}_${t}_gain` }))]),
    ['levelPID', [{ p: 'angle_level_strength' }, { p: 'angle_level_limit' }, { p: 'horizon_level_strength' }, { p: 'horizon_transition' }]],
    ['govPID', [{ p: 'gov_p_gain' }, { p: 'gov_i_gain' }, { p: 'gov_d_gain' }, { p: 'gov_f_gain' }, { p: 'gov_gain' }]],
    ...['roll', 'pitch', 'yaw'].map(a => [`${a}BW`, [{ p: `${a}_gyro_cutoff` }, { p: `${a}_d_cutoff` }, { p: `${a}_b_cutoff` }]]),
    ['iterm_relax_type', [{ p: 'iterm_relax_type', lookup: 'ERROR_RELAX_TYPE' }]],
    ['iterm_relax_cutoff', [{ p: 'iterm_relax_cutoff' }]],
    ['error_limit', [{ p: 'error_limit' }]],
    ['error_decay', [{ p: 'error_decay_time_cyclic' }, { p: 'error_decay_limit_cyclic' }]],
    ['error_decay_ground', [{ p: 'error_decay_time_ground' }]],
    ['cyclic_coupling', [{ p: 'cyclic_cross_coupling_gain' }, { p: 'cyclic_cross_coupling_ratio' }, { p: 'cyclic_cross_coupling_cutoff' }]],
    ['yaw_stop_gain', [{ p: 'yaw_cw_stop_gain' }, { p: 'yaw_ccw_stop_gain' }]],
    ['yaw_precomp', [{ p: 'yaw_precomp_cutoff' }, { p: 'yaw_cyclic_ff_gain' }, { p: 'yaw_collective_ff_gain' }]],
    ['yaw_inertia_precomp', [{ p: 'yaw_inertia_precomp_gain' }, { p: 'yaw_inertia_precomp_cutoff' }]],
    ['yaw_tta', [{ p: 'gov_tta_gain' }, { p: 'gov_tta_limit' }]],
    ['hsi_gain', [{ p: 'roll_o_gain' }, { p: 'pitch_o_gain' }]],
    ['hsi_limit', [{ p: 'offset_limit' }]],
    ['pitch_compensation', [{ p: 'pitch_collective_ff_gain' }]],
    ['deadband', [{ m: 'deadband' }]],
    ['yaw_deadband', [{ m: 'yaw_deadband' }]],
    ['gyro_to_use', [{ m: 'gyro_to_use', lookup: 'GYRO' }]],
    ['gyro_hardware_lpf', [{ m: 'gyro_hardware_lpf', lookup: 'GYRO_HARDWARE_LPF' }]],
    ['gyro_decimation_hz', [{ m: 'gyro_decimation_hz' }]],
    ['gyro_lpf1_type', [{ m: 'gyro_lpf1_type', lookup: 'LPF_TYPE' }]],
    ['gyro_lpf1_static_hz', [{ m: 'gyro_lpf1_static_hz' }]],
    ['gyro_lpf1_dyn_hz', [{ m: 'gyro_lpf1_dyn_min_hz' }, { m: 'gyro_lpf1_dyn_max_hz' }]],
    ['gyro_lpf2_type', [{ m: 'gyro_lpf2_type', lookup: 'LPF_TYPE' }]],
    ['gyro_lpf2_static_hz', [{ m: 'gyro_lpf2_static_hz' }]],
    ['gyro_notch_hz', [{ m: 'gyro_notch1_hz' }, { m: 'gyro_notch2_hz' }]],
    ['gyro_notch_cutoff', [{ m: 'gyro_notch1_cutoff' }, { m: 'gyro_notch2_cutoff' }]],
    ['dyn_notch_count', [{ m: 'dyn_notch_count' }]],
    ['dyn_notch_q', [{ m: 'dyn_notch_q' }]],
    ['dyn_notch_min_hz', [{ m: 'dyn_notch_min_hz' }]],
    ['dyn_notch_max_hz', [{ m: 'dyn_notch_max_hz' }]],
    ['dshot_bidir', [{ m: 'dshot_bidir', lookup: 'OFF_ON' }]],
    ['gyro_rpm_notch_preset', [{ m: 'gyro_rpm_notch_preset' }]],
    ['gyro_rpm_notch_min_hz', [{ m: 'gyro_rpm_notch_min_hz' }]],
    ...['pitch', 'roll', 'yaw'].flatMap(a => ['source', 'center', 'q'].map(f => [`gyro_rpm_notch_${f}_${a}`, [{ m: `gyro_rpm_notch_${f}_${a}` }]])),
    ['acc_lpf_hz', [{ m: 'acc_lpf_hz', scale: 100 }]],
    ['acc_hardware', [{ m: 'acc_hardware', lookup: 'ACC_HARDWARE' }]],
    ['gyro_cal_on_first_arm', [{ m: 'gyro_cal_on_first_arm', lookup: 'OFF_ON' }]],
    ['serialrx_provider', [{ m: 'serialrx_provider', lookup: 'SERIAL_RX' }]],
    ['use_unsynced_pwm', [{ m: 'use_unsynced_pwm', lookup: 'OFF_ON' }]],
    ['motor_pwm_protocol', [{ m: 'motor_pwm_protocol', lookup: 'PWM_PROTOCOL' }]],
    ['motor_pwm_rate', [{ m: 'motor_pwm_rate' }]],
    ['minthrottle', [{ m: 'min_throttle' }]],
    ['maxthrottle', [{ m: 'max_throttle' }]],
    ['collectiveRange', [{ el: 'el.mixin.4', field: 1 }, { el: 'el.mixin.4', field: 2 }]],   // MIXER_IN_STABILIZED_COLLECTIVE = 4 (pg/mixer.h:41-46)
    ['debug_mode', [{ rt: 'debug_mode' }]],
    ['debug_axis', [{ boot: 'debug_axis' }]],
];

// The sysConfig names of the classic keys that js/flightlog_parser.js renames (translationValues) or splits
const CLASSIC_SYSCONFIG = {
    gyro_hardware_lpf: 'gyro_lpf', gyro_lpf1_type: 'gyro_soft_type', gyro_lpf1_static_hz: 'gyro_lowpass_hz', gyro_lpf1_dyn_hz: 'gyro_lowpass_dyn_hz',
    gyro_lpf2_type: 'gyro_soft2_type', gyro_lpf2_static_hz: 'gyro_lowpass2_hz', motor_pwm_protocol: 'fast_pwm_protocol', use_unsynced_pwm: 'unsynced_fast_pwm',
    vbat_scale: 'vbatscale', vbatcellvoltage: ['vbatmincellvoltage', 'vbatwarningcellvoltage', 'vbatmaxcellvoltage'], currentSensor: ['currentMeterOffset', 'currentMeterScale'],
};

function matchRule(keys, key) {
    for (const r of keys) if (r.match.test(key)) return r;
    return null;
}

/**
 * The table for a firmware revision and its behaviour fixes (param_fixes, spec 3.11).
 *   revision  the "Firmware revision" header line; fixes ['c1', ...]
 * Returns { known, firmware, fixes, loaders, keys, adjustments, lookups, classic, classify(key), pgOf(key), slotOf(key),
 *   readsRegion(loader, key, slot), appliedBy(loader, key), adjustmentRefreshes(fn, key, itemKey) }.
 * known is false for another firmware: every key is then effect-unknown (the PG names stay, they come from the log).
 */
function forFirmware(revision, fixes) {
    const fx = new Set((Array.isArray(fixes) ? fixes : String(fixes || '').split(',')).map(s => String(s).trim()).filter(s => s && s !== '-'));
    const known = RULES.firmware.test(String(revision || ''));
    const keys = known ? KEYS_46.slice() : [];
    const adjustments = known ? Object.assign({}, ADJUSTMENTS_46) : {};
    if (known && fx.has('c3')) // c3: the setpoint-boost setters also set sp.boostGain (spec 3.11)
        for (const f of [68, 69, 70, 71]) adjustments[f] = ADJ('r', 'sp', ['setpoint_boost_gain'], 'c3: setpoint.c:96-129 with sp.boostGain');
    if (known && fx.has('c4')) // c4: the rate setters call setpointInitProfile, which writes its own A(sp) record
        for (let f = 5; f <= 13; f++) adjustments[f] = Object.assign({}, adjustments[f], { applies: 'sp', src: 'c4: setpointInitProfile after the write' });
    const table = {
        known, firmware: known ? 'Rotorflight 4.6.*' : null, revision: revision || null, fixes: [...fx],
        loaders: LOADERS, keys, adjustments, lookups: LOOKUPS, classic: known ? CLASSIC_46 : [], classicSysConfig: CLASSIC_SYSCONFIG,
        classify: (key) => matchRule(keys, String(key).replace(/\[\d+\]$/, '')),
        pgOf: pgOfKey,
        slotOf: slotOfKey,
        // the key is in the region that loader L reads (spec 3.6), for the slot of the A record
        readsRegion(loader, key, slot) {
            const L = LOADERS[loader], pg = pgOfKey(key), s = slotOfKey(key);
            if (!L) return false;
            if (pg === null) return loader === 'act';
            if (!L.reads.includes(pg)) return false;
            if (s && L.slot && s.kind === L.slot && slot !== undefined && slot !== null && s.slot !== slot) return false;
            if (s && L.slot && s.kind !== L.slot) return false;
            return true;
        },
        // a rule of the table applies the key with loader L (also: a loader that calls L)
        appliedBy(loader, key) {
            const r = table.classify(key);
            return !!r && r.use.some(u => u.by === 'loader' && (u.loader === loader || (u.also || []).includes(loader)));
        },
        // the adjustment fn refreshes key at once; itemKey is a key of the adjustment record (gives the slot)
        adjustmentRefreshes(fn, key, itemKey) {
            const a = adjustments[fn];
            if (!a || !a.refresh.length) return false;
            const base = String(key).replace(/\[\d+\]$/, ''), s = slotOfKey(base), si = itemKey ? slotOfKey(itemKey) : null;
            const name = s ? base.slice(3) : base;
            if (!a.refresh.includes(name)) return false;
            if (a.scope === 'm') return !s;
            if (!s || (a.scope === 'p') !== (s.kind === 'pid')) return false;
            return !si || si.slot === s.slot;
        },
    };
    return table;
}

module.exports = { RULES, PG, NAMES, ELEMENT_PG, LOADERS, FINGERPRINT_LOADER, KEYS_46, ADJUSTMENTS_46, LOOKUPS, CLASSIC_46, CLASSIC_SYSCONFIG, pgOfKey, slotOfKey, forFirmware };
if (require.main !== module) return;

// node tools/autotune/param_semantics.cjs [key ...]: the rule of each key for 4.6
const t = forFirmware('Rotorflight 4.6.0', []);
for (const k of process.argv.slice(2)) {
    const r = t.classify(k);
    console.log(`${k}: PG ${t.pgOf(k)} ${r ? r.use.map(u => u.by + (u.loader ? ' ' + u.loader : '') + (u.consumer ? ' (' + u.consumer + ')' : '')).join(', ') + ' - ' + r.src : 'effect-unknown'}`);
}
