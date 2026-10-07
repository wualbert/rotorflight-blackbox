'use strict';

/**
 * Datasets (SPEC3 J): the configurations that the pilot flew. A dataset is one PID profile and one exact set of the
 * parameter values that change the flight ("flight values"). Every time a flight value is not the same, the time is a
 * new dataset; a difference in a value that does not change the flight (rescue, blackbox, OSD, telemetry, ...) never
 * splits a dataset, and it is listed as information.
 *
 *   const DS = require('./datasets.cjs');
 *   const ds = DS.datasets(logs, cli, { logBase: 1 });         // datasets, labels, diff, pairs, info, notes
 *   const ix = DS.labelArray(ds, log, frameSeconds);             // dataset index of every sample (-1: none)
 *   const cmp = DS.compare({ A: { mean, se, n }, B: [samples] }, ds);   // A/B differences and slopes, 2 SE
 *   DS.predict(cmp, 'yaw_cw_stop_gain', 120, 140);              // the measured slope applied to a change
 *
 * The table (GROUPS, HEADER, FEATURES): every setting of rotorflight-firmware release/4.6.0 src/main/cli/settings.c
 * (727 names, valueTable; copies in analysis/gaui-x4/.../fw460/settings.c), every name that 4.6.0 writes in the log
 * header (src/main/blackbox/blackbox.c blackboxWriteSysinfo, lines 1587-1781) as js/flightlog_parser.js stores it in
 * sysConfig, the 4.4 header names of the Gaui X4 dump (log 0), the feature bits (src/main/config/feature.h) and the CLI
 * commands of a dump that hold values (feature, mixer input, mixer rule, servo: src/main/cli/cli.c printServo,
 * printMixerInputs, printMixerRules). A name that the table does not know changes the flight (the safe side), and the
 * result lists it (unknownNames).
 *
 * logs[] (one entry for each log of the file that the caller decoded):
 *   { log            index of the log in the file (0-based, as the worker's records)
 *     header         the log header as FlightLog.getSysConfig() gives it: own keys, unknownHeaders [{ name, value }]
 *     armingProfile  the PID profile at arming when it is confirmed (1-6), else 0 or null
 *     armingEstimate the arming profile that the governor target shows, not confirmed (worker armingOf estimate; optional)
 *     profileRuns    [{ t0, t1, profile }] frame seconds; profile 1-6, 0 = before the first switch (the arming profile)
 *     rateChanges    [{ t, profile }] rate profile switches (adjustment function 1), profile 1-6 (optional)
 *     adjustments    [{ t, func, value }] INFLIGHT_ADJUSTMENT events as js/flightlog_parser.js decodes them (optional;
 *                    func 1 and 2 are the rate and PID profile switches)
 *     flights        [{ t0, t1 }] frame seconds; [] = a bench run (no dataset, no label); null = not known
 *     durationS }    the length of the log in frame seconds (only when profileRuns is missing)
 * cli: the CLI dump text, parseCli(text) of this module, health_setup.parseCli(text), or null.
 *
 * The values of a stretch of a log (rules of SPEC3 J):
 *   - global and rate values: the header of the log (the rate values are those of the rate profile at the start of the
 *     log; after a rate profile switch: the CLI rateprofile section, else unknown);
 *   - PID profile values: the header of the log when the stretch is in the arming profile (label 0, or the confirmed
 *     arming profile); else the CLI section of that PID profile when the CLI dump agrees with this log's header; else
 *     the header of the nearest log armed (confirmed) in that PID profile, marked assumed; else the CLI section, marked
 *     assumed; else unknown (null), marked assumed: stretches with unknown values of one PID profile and the same other
 *     values form one dataset;
 *   - values that only the CLI dump shows (gov_mode, mixer, servos, ...): the CLI dump, for every log. One dump cannot
 *     show a change between two logs, so these values never split a dataset of one PID profile;
 *   - in-flight adjustments (ADJUST) change the value of their parameter from the event to the end of the log;
 *   - a CLI dump whose craft name is not the craft name of the log header is not used for that log (CLAUDE.md).
 *
 * Texts that the app shows (notes, labels, reasons, titles) are ASD-STE100 (docs/STE_GLOSSARY.md); parameter names are
 * quoted in backticks. Code reads the fields, never the texts. No Node API call at module load: the worker loads this
 * file through its CommonJS shim (js/tuning_worker.js). inputsOfFile (Node only) requires lib.cjs and health_phase.cjs
 * when it is called.
 */

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

const RULES = {
    ab: { k: 2, maxNames: 3, source: 'CLAUDE.md 2-SE test; SPEC3 J: an A/B comparison of datasets that differ in a few parameters (3 or less: pipeline choice)' },
    slope: { minDatasets: 3, minDistinct: 2, k: 2, tolerance: 1e-9, source: 'SPEC3 J: the slope (result change per parameter change) from 3 or more datasets that differ in one parameter, or in parameters that change together; 2 SE' },
    join: { tie: 'earlier', source: 'SPEC3 J: a stretch whose values the log does not show joins the dataset of the same PID profile from the nearest log armed in it; at equal distance the earlier log (pipeline choice)' },
};

// ---------------------------------------------------------------------------------------------
// The classification table
// ---------------------------------------------------------------------------------------------

// The PID profile and rate profile names of 4.6.0 settings.c (PROFILE_VALUE, PROFILE_RATE_VALUE); every other name is global
const PROFILE_NAMES = [
    'profile_name', 'pid_mode', 'pitch_p_gain', 'pitch_i_gain', 'pitch_d_gain', 'pitch_f_gain', 'pitch_b_gain',
    'pitch_o_gain', 'roll_p_gain', 'roll_i_gain', 'roll_d_gain', 'roll_f_gain', 'roll_b_gain', 'roll_o_gain', 'yaw_p_gain',
    'yaw_i_gain', 'yaw_d_gain', 'yaw_b_gain', 'yaw_f_gain', 'pitch_d_cutoff', 'pitch_b_cutoff', 'pitch_gyro_cutoff',
    'roll_d_cutoff', 'roll_b_cutoff', 'roll_gyro_cutoff', 'yaw_d_cutoff', 'yaw_b_cutoff', 'yaw_gyro_cutoff',
    'yaw_cw_stop_gain', 'yaw_ccw_stop_gain', 'yaw_precomp_cutoff', 'yaw_cyclic_ff_gain', 'yaw_collective_ff_gain',
    'yaw_inertia_precomp_gain', 'yaw_inertia_precomp_cutoff', 'pitch_collective_ff_gain', 'cyclic_cross_coupling_gain',
    'cyclic_cross_coupling_ratio', 'cyclic_cross_coupling_cutoff', 'error_limit', 'offset_limit', 'error_decay_time_ground',
    'error_decay_time_cyclic', 'error_decay_time_yaw', 'error_decay_limit_cyclic', 'error_decay_limit_yaw',
    'offset_flood_relax_level', 'offset_flood_relax_cutoff', 'iterm_relax_type', 'iterm_relax_level', 'iterm_relax_cutoff',
    'angle_level_strength', 'angle_level_limit', 'horizon_level_strength', 'horizon_transition', 'horizon_tilt_effect',
    'horizon_tilt_expert_mode', 'acro_trainer_angle_limit', 'acro_trainer_lookahead_ms', 'acro_trainer_gain', 'rescue_mode',
    'rescue_flip', 'rescue_flip_gain', 'rescue_level_gain', 'rescue_pull_up_time', 'rescue_climb_time', 'rescue_flip_time',
    'rescue_exit_time', 'rescue_pull_up_collective', 'rescue_climb_collective', 'rescue_hover_collective',
    'rescue_hover_altitude', 'rescue_alt_p_gain', 'rescue_alt_i_gain', 'rescue_alt_d_gain', 'rescue_max_sp_rate',
    'rescue_max_sp_accel', 'rescue_max_collective', 'gov_use_fallback_precomp', 'gov_use_pid_spoolup',
    'gov_use_voltage_comp', 'gov_use_dyn_min_throttle', 'gov_headspeed', 'gov_gain', 'gov_p_gain', 'gov_i_gain',
    'gov_d_gain', 'gov_f_gain', 'gov_p_limit', 'gov_i_limit', 'gov_d_limit', 'gov_f_limit', 'gov_tta_gain', 'gov_tta_limit',
    'gov_yaw_ff_weight', 'gov_cyclic_ff_weight', 'gov_collective_ff_weight', 'gov_max_throttle', 'gov_min_throttle',
    'gov_fallback_drop', 'gov_collective_curve', 'gov_dyn_min_throttle',
    // 4.4.0 header names (Gaui X4 dump, log 0) that are PID profile values
    'yaw_precomp_impulse', 'piro_compensation',
];
const RATE_NAMES = [
    'rateprofile_name', 'rates_type', 'roll_rc_rate', 'pitch_rc_rate', 'yaw_rc_rate', 'collective_rc_rate', 'roll_expo',
    'pitch_expo', 'yaw_expo', 'collective_expo', 'roll_srate', 'pitch_srate', 'yaw_srate', 'collective_srate',
    'roll_accel_limit', 'pitch_accel_limit', 'yaw_accel_limit', 'collective_accel_limit', 'roll_level_expo',
    'pitch_level_expo', 'roll_response', 'pitch_response', 'yaw_response', 'collective_response', 'cyclic_ring',
    'cyclic_polar', 'setpoint_boost_gain', 'setpoint_boost_cutoff', 'yaw_dynamic_ceiling_gain', 'yaw_dynamic_deadband_gain',
    'yaw_dynamic_deadband_filter', 'yaw_dynamic_deadband_cutoff',
];

// One row for each group: flight (true: the values change the flight), the reason, and its names. The names are 4.6.0
// settings.c names, the header-only names of the log header (as sysConfig keys), `feature NAME` for the feature bits
// and the CLI command values (patterns). Titles and reasons are STE.
const GROUPS = [
    { id: 'pid', flight: true, title: 'PID gains', reason: 'They set the gains of the PID controller of each axis.', names: [
        'pid_mode', 'pitch_p_gain', 'pitch_i_gain', 'pitch_d_gain', 'pitch_f_gain', 'pitch_b_gain', 'pitch_o_gain',
        'roll_p_gain', 'roll_i_gain', 'roll_d_gain', 'roll_f_gain', 'roll_b_gain', 'roll_o_gain', 'yaw_p_gain', 'yaw_i_gain',
        'yaw_d_gain', 'yaw_b_gain', 'yaw_f_gain'] },
    { id: 'pidCutoffs', flight: true, title: 'PID cutoffs', reason: 'They set the cutoff frequency of each low-pass filter in the PID controller.', names: [
        'pitch_d_cutoff', 'pitch_b_cutoff', 'pitch_gyro_cutoff', 'roll_d_cutoff', 'roll_b_cutoff', 'roll_gyro_cutoff',
        'yaw_d_cutoff', 'yaw_b_cutoff', 'yaw_gyro_cutoff'] },
    { id: 'iterm', flight: true, title: 'I-term and offset limits', reason: 'They set the limits of the I-term and of the offset, and the I-term relax.', names: [
        'error_limit', 'offset_limit', 'error_decay_time_ground', 'error_decay_time_cyclic', 'error_decay_time_yaw',
        'error_decay_limit_cyclic', 'error_decay_limit_yaw', 'offset_flood_relax_level', 'offset_flood_relax_cutoff',
        'iterm_relax_type', 'iterm_relax_level', 'iterm_relax_cutoff'] },
    { id: 'precomp', flight: true, title: 'Precompensation and cross-coupling', reason: 'They add feedforward from the collective and the cyclic to the tail and to the pitch axis.', names: [
        'yaw_precomp_cutoff', 'yaw_cyclic_ff_gain', 'yaw_collective_ff_gain', 'yaw_inertia_precomp_gain',
        'yaw_inertia_precomp_cutoff', 'pitch_collective_ff_gain', 'cyclic_cross_coupling_gain', 'cyclic_cross_coupling_ratio',
        'cyclic_cross_coupling_cutoff', 'yaw_precomp_impulse', 'piro_compensation'] },
    { id: 'stop', flight: true, title: 'Yaw stop gains', reason: 'They set the yaw gain in each direction of the tail.', names: ['yaw_cw_stop_gain', 'yaw_ccw_stop_gain'] },
    { id: 'tta', flight: true, title: 'Tail torque assist', reason: 'They let the governor increase the headspeed when the tail is near its limit.', names: [
        'swash_tta_precomp', 'gov_tta_filter', 'gov_tta_gain', 'gov_tta_limit'] },
    { id: 'governor', flight: true, title: 'Governor', reason: 'They set the governor and the throttle that the governor gives to the motor.', names: [
        'gov_mode', 'gov_throttle_type', 'gov_startup_time', 'gov_spoolup_time', 'gov_tracking_time', 'gov_recovery_time',
        'gov_spooldown_time', 'gov_throttle_hold_timeout', 'gov_autorotation_timeout', 'gov_handover_throttle',
        'gov_idle_throttle', 'gov_auto_throttle', 'gov_bypass_throttle', 'gov_pwr_filter', 'gov_rpm_filter', 'gov_ff_filter',
        'gov_d_filter', 'gov_use_fallback_precomp', 'gov_use_pid_spoolup', 'gov_use_voltage_comp', 'gov_use_dyn_min_throttle',
        'gov_headspeed', 'gov_gain', 'gov_p_gain', 'gov_i_gain', 'gov_d_gain', 'gov_f_gain', 'gov_p_limit', 'gov_i_limit',
        'gov_d_limit', 'gov_f_limit', 'gov_yaw_ff_weight', 'gov_cyclic_ff_weight', 'gov_collective_ff_weight',
        'gov_max_throttle', 'gov_min_throttle', 'gov_fallback_drop', 'gov_collective_curve', 'gov_dyn_min_throttle',
        'feature GOVERNOR'] },
    { id: 'rpmSignal', flight: true, title: 'RPM signal', reason: 'They set the RPM signal that the governor and the RPM filter use.', names: [
        'freq_input_pull', 'freq_input_edge', 'freq_input_minhz', 'dshot_bidir', 'motor_poles', 'motor_rpm_lpf',
        'motor_rpm_factor', 'main_rotor_gear_ratio', 'tail_rotor_gear_ratio', 'esc_sensor_protocol', 'esc_sensor_halfduplex',
        'esc_sensor_pinswap', 'esc_sensor_update_hz', 'esc_sensor_filter_cutoff', 'feature ESC_SENSOR', 'feature FREQ_SENSOR'] },
    { id: 'motor', flight: true, title: 'Motor output', reason: 'They set the throttle signal from the flight controller to the ESC.', names: [
        'min_throttle', 'max_throttle', 'min_command', 'dshot_burst', 'dshot_bitbang', 'dshot_bitbang_timer', 'use_unsynced_pwm',
        'motor_pwm_protocol', 'motor_pwm_rate', 'motor_control_mode'] },
    { id: 'filters', flight: true, title: 'Gyro filters', reason: 'They filter the gyro signal before the PID controller uses it.', names: [
        'gyro_hardware_lpf', 'gyro_decimation_hz', 'gyro_lpf1_type', 'gyro_lpf1_static_hz', 'gyro_lpf1_dyn_min_hz',
        'gyro_lpf1_dyn_max_hz', 'gyro_lpf2_type', 'gyro_lpf2_static_hz', 'gyro_notch1_hz', 'gyro_notch1_cutoff',
        'gyro_notch2_hz', 'gyro_notch2_cutoff', 'dyn_notch_count', 'dyn_notch_q', 'dyn_notch_min_hz', 'dyn_notch_max_hz',
        'gyro_rpm_notch_preset', 'gyro_rpm_notch_min_hz', 'gyro_rpm_notch_source_pitch', 'gyro_rpm_notch_center_pitch',
        'gyro_rpm_notch_q_pitch', 'gyro_rpm_notch_source_roll', 'gyro_rpm_notch_center_roll', 'gyro_rpm_notch_q_roll',
        'gyro_rpm_notch_source_yaw', 'gyro_rpm_notch_center_yaw', 'gyro_rpm_notch_q_yaw', 'feature DYN_NOTCH', 'feature RPM_FILTER',
        // 4.4.0 header names (Gaui X4 dump, log 0)
        'gyro_rpm_filter_bank_rpm_source', 'gyro_rpm_filter_bank_rpm_limit', 'gyro_rpm_filter_bank_notch_q', 'gyro_rpm_filter_bank_rpm_ratio'] },
    { id: 'unusedFeatures', flight: true, title: 'Other features', reason: 'Rotorflight 4.6 does not use these features. Thus, the app uses them as parameters that change the flight.', names: ['feature other bits'] },
    { id: 'loop', flight: true, title: 'Gyro and loop rate', reason: 'They set the gyro and the rate of the PID loop.', names: [
        'gyro_to_use', 'gyro_overflow_detect', 'gyro_high_range', 'gyro_rate_sync', 'pid_process_denom', 'filter_process_denom',
        'cpu_overclock', 'scheduler_relax_rx', 'scheduler_relax_osd', 'looptime', 'gyro_sync_denom'] },
    { id: 'firmware', flight: true, title: 'Firmware and flight controller', reason: 'They identify the firmware and the flight controller. A different firmware or flight controller can change the flight.', names: [
        'Firmware revision', 'Board information'] },
    { id: 'alignment', flight: true, title: 'Gyro alignment', reason: 'They set the gyro alignment and the board alignment.', names: [
        'align_board_roll', 'align_board_pitch', 'align_board_yaw', 'gyro_1_sensor_align', 'gyro_1_align_roll',
        'gyro_1_align_pitch', 'gyro_1_align_yaw', 'gyro_2_sensor_align', 'gyro_2_align_roll', 'gyro_2_align_pitch',
        'gyro_2_align_yaw'] },
    { id: 'mixer', flight: true, title: 'Mixer and servos', reason: 'They set the mixer, the swash plate geometry and the servo outputs.', names: [
        'main_rotor_dir', 'tail_rotor_mode', 'tail_motor_idle', 'tail_center_trim', 'swash_type', 'swash_ring', 'swash_phase',
        'swash_roll_trim', 'swash_pitch_trim', 'swash_collective_trim', 'swash_pitch_limit', 'swash_geo_correction',
        'collective_tilt_correction_pos', 'collective_tilt_correction_neg', 'bus_servo_source_type', 'sbus_out_frame_rate',
        'sbus_out_pinswap', 'sbus_out_inverted', 'fbus_master_frame_rate', 'fbus_master_pinswap', 'fbus_master_inverted'],
      patterns: [/^mixer input \w+ (?:min|max|rate)$/, /^mixer rule \d+$/, /^servo \d+ (?:mid|min|max|rneg|rpos|rate|speed|flags)$/] },
    { id: 'rates', flight: true, title: 'Rates', reason: 'They change the setpoint that the sticks give.', names: [
        'rates_type', 'roll_rc_rate', 'pitch_rc_rate', 'yaw_rc_rate', 'collective_rc_rate', 'roll_expo', 'pitch_expo',
        'yaw_expo', 'collective_expo', 'roll_srate', 'pitch_srate', 'yaw_srate', 'collective_srate', 'roll_accel_limit',
        'pitch_accel_limit', 'yaw_accel_limit', 'collective_accel_limit', 'roll_level_expo', 'pitch_level_expo', 'roll_response',
        'pitch_response', 'yaw_response', 'collective_response', 'cyclic_ring', 'cyclic_polar', 'setpoint_boost_gain',
        'setpoint_boost_cutoff', 'yaw_dynamic_ceiling_gain', 'yaw_dynamic_deadband_gain', 'yaw_dynamic_deadband_filter',
        'yaw_dynamic_deadband_cutoff'] },
    { id: 'rcInput', flight: true, title: 'Stick input', reason: 'They set the stick signals that the flight controller reads from the receiver.', names: [
        'rx_pulse_min', 'rx_pulse_max', 'serialrx_provider', 'rx_spi_protocol', 'input_filtering_mode', 'rc_center',
        'rc_deflection', 'rc_min_throttle', 'rc_max_throttle', 'rc_smoothness', 'rc_threshold', 'deadband', 'yaw_deadband',
        'feature RX_PPM', 'feature RX_SERIAL', 'feature RX_PARALLEL_PWM', 'feature RX_MSP', 'feature RX_SPI', 'map'] },
    { id: 'batteryVoltage', flight: true, title: 'Battery voltage', reason: 'The voltage compensation of the governor uses the battery voltage that they measure.', names: [
        'adc_vrefint_calibration', 'battery_meter', 'vbat_lpf_hz', 'vbat_update_hz', 'vbat_scale', 'vbat_divider',
        'vbat_multiplier', 'vbat_cutoff'] },
    { id: 'rescue', flight: false, title: 'Rescue', reason: 'They operate only in a rescue. The analysis does not use the rescue periods.', names: [
        'rescue_mode', 'rescue_flip', 'rescue_flip_gain', 'rescue_level_gain', 'rescue_pull_up_time', 'rescue_climb_time',
        'rescue_flip_time', 'rescue_exit_time', 'rescue_pull_up_collective', 'rescue_climb_collective',
        'rescue_hover_collective', 'rescue_hover_altitude', 'rescue_alt_p_gain', 'rescue_alt_i_gain', 'rescue_alt_d_gain',
        'rescue_max_sp_rate', 'rescue_max_sp_accel', 'rescue_max_collective', 'gps_rescue_angle', 'gps_rescue_alt_buffer',
        'gps_rescue_initial_alt', 'gps_rescue_descent_dist', 'gps_rescue_landing_alt', 'gps_rescue_landing_dist',
        'gps_rescue_ground_speed', 'gps_rescue_throttle_p', 'gps_rescue_throttle_i', 'gps_rescue_throttle_d',
        'gps_rescue_velocity_p', 'gps_rescue_velocity_i', 'gps_rescue_velocity_d', 'gps_rescue_yaw_p', 'gps_rescue_throttle_min',
        'gps_rescue_throttle_max', 'gps_rescue_ascend_rate', 'gps_rescue_descend_rate', 'gps_rescue_throttle_hover',
        'gps_rescue_sanity_checks', 'gps_rescue_min_sats', 'gps_rescue_min_dth', 'gps_rescue_allow_arming_without_fix',
        'gps_rescue_alt_mode', 'gps_rescue_use_mag'] },
    { id: 'levelModes', flight: false, title: 'Level modes', reason: 'They operate only in angle mode, horizon mode and trainer mode. The analysis does not use these periods.', names: [
        'angle_level_strength', 'angle_level_limit', 'horizon_level_strength', 'horizon_transition', 'horizon_tilt_effect',
        'horizon_tilt_expert_mode', 'acro_trainer_angle_limit', 'acro_trainer_lookahead_ms', 'acro_trainer_gain'] },
    { id: 'attitude', flight: false, title: 'Attitude and altitude', reason: 'They give the attitude and the altitude to the level modes and to the rescue. The PID loop does not use them.', names: [
        'acc_hardware', 'acc_high_range', 'acc_lpf_hz', 'acc_trim_pitch', 'acc_trim_roll', 'acc_calibration', 'align_mag',
        'mag_align_roll', 'mag_align_pitch', 'mag_align_yaw', 'mag_hardware', 'mag_calibration', 'baro_hardware', 'imu_dcm_kp',
        'imu_dcm_ki', 'gps_provider', 'gps_sbas_mode', 'gps_sbas_integrity', 'gps_auto_config', 'gps_auto_baud',
        'gps_ublox_use_galileo', 'gps_ublox_mode', 'gps_set_home_point_once', 'gps_use_3d_speed', 'rangefinder_hardware',
        'position_alt_source', 'position_baro_alt_lpf', 'position_baro_offset_lpf', 'position_gps_alt_lpf',
        'position_gps_offset_lpf', 'position_gps_min_sats', 'position_vario_lpf', 'feature GPS', 'feature RANGEFINDER'] },
    { id: 'blackbox', flight: false, title: 'Blackbox', reason: 'They set the data that the blackbox records. They do not change the flight.', names: [
        'blackbox_mode', 'blackbox_device', 'blackbox_rate_denom', 'blackbox_log_command', 'blackbox_log_setpoint',
        'blackbox_log_mixer', 'blackbox_log_pid', 'blackbox_log_attitude', 'blackbox_log_gyro_raw', 'blackbox_log_gyro',
        'blackbox_log_acc', 'blackbox_log_mag', 'blackbox_log_alt', 'blackbox_log_gps', 'blackbox_log_battery',
        'blackbox_log_motors', 'blackbox_log_servos', 'blackbox_log_rpm', 'blackbox_log_rssi', 'blackbox_log_vbec',
        'blackbox_log_vbus', 'blackbox_log_temp', 'blackbox_log_esc', 'blackbox_log_bec', 'blackbox_log_esc2',
        'blackbox_log_governor', 'blackbox_initial_erase_kb', 'blackbox_rolling_erase', 'blackbox_grace_period', 'debug_mode',
        'debug_axis', 'fields_mask', 'frameIntervalI', 'frameIntervalPNum', 'frameIntervalPDenom'] },
    { id: 'failsafe', flight: false, title: 'Failsafe', reason: 'They operate only when the flight controller gets no signal from the receiver.', names: [
        'failsafe_delay', 'failsafe_off_delay', 'failsafe_throttle', 'failsafe_switch_mode', 'failsafe_throttle_low_delay',
        'failsafe_procedure', 'failsafe_recovery_delay', 'failsafe_stick_threshold'] },
    { id: 'arming', flight: false, title: 'Procedure to arm', reason: 'They operate before the pilot arms the helicopter or when the pilot disarms it.', names: [
        'gyro_calib_duration', 'gyro_calib_noise_limit', 'auto_disarm_delay', 'gyro_cal_on_first_arm', 'pwr_on_arm_grace',
        'enable_stick_arming', 'enable_stick_commands', 'wiggle_strength', 'wiggle_frequency', 'wiggle_enable_ready',
        'wiggle_enable_armed', 'wiggle_enable_error', 'wiggle_enable_fatal'] },
    { id: 'battery', flight: false, title: 'Battery warnings', reason: 'They set the battery warnings and the battery data of the telemetry.', names: [
        'bat_profile', 'bat_capacity', 'vbat_max_cell_voltage', 'vbat_full_cell_voltage', 'vbat_min_cell_voltage',
        'vbat_warning_cell_voltage', 'vbat_hysteresis', 'current_meter', 'vbat_detect_cell_voltage', 'use_vbat_alerts',
        'use_cbat_alerts', 'cbat_alert_percent', 'vbat_cutoff_percent', 'battery_cell_count', 'ibat_lpf_hz',
        'vbat_duration_for_warning', 'vbat_duration_for_critical', 'ibat_update_hz', 'smartfuel', 'smartfuel_voltage_drop_rate',
        'smartfuel_charge_drop_rate', 'smartfuel_sag_gain', 'vbec_scale', 'vbec_divider', 'vbec_multiplier', 'vbec_cutoff',
        'vbus_scale', 'vbus_divider', 'vbus_multiplier', 'vbus_cutoff', 'vext_scale', 'vext_divider', 'vext_multiplier',
        'vext_cutoff', 'ibata_scale', 'ibata_offset', 'ibata_cutoff'] },
    { id: 'telemetry', flight: false, title: 'Telemetry', reason: 'They set the data that the flight controller sends to the transmitter.', names: [
        'rssi_channel', 'rssi_src_frame_errors', 'rssi_scale', 'rssi_offset', 'rssi_invert', 'rssi_src_frame_lpf_period',
        'crsf_use_rx_snr', 'tlm_inverted', 'tlm_halfduplex', 'tlm_pinswap', 'frsky_default_lat', 'frsky_default_long',
        'frsky_gps_format', 'frsky_unit', 'frsky_vfas_precision', 'hott_alarm_int', 'report_cell_voltage', 'ibus_sensor',
        'mavlink_mah_as_heading_divisor', 'crsf_telemetry_mode', 'crsf_telemetry_link_rate', 'crsf_telemetry_link_ratio',
        'telemetry_sensors', 'telemetry_interval', 'esc_sensor_current_offset', 'esc_sensor_voltage_correction',
        'esc_sensor_current_correction', 'esc_sensor_consumption_correction', 'fbus_master_telemetry_rate',
        'fbus_master_discovery_ms', 'fbus_master_forwarded_sensors', 'sport_master_pinswap', 'sport_master_inverted',
        'feature TELEMETRY', 'feature RSSI_ADC'] },
    { id: 'display', flight: false, title: 'Display devices', reason: 'They set the devices that show data to the pilot. They do not change the flight.', names: [
        'beeper_inversion', 'beeper_od', 'beeper_frequency', 'beeper_dshot_beacon_tone', 'ledstrip_visual_beeper',
        'ledstrip_visual_beeper_color', 'ledstrip_grb_rgb', 'ledstrip_profile', 'ledstrip_race_color', 'ledstrip_beacon_color',
        'ledstrip_beacon_period_ms', 'ledstrip_beacon_percent', 'ledstrip_beacon_armed_only', 'ledstrip_brightness',
        'ledstrip_blink_period_ms', 'ledstrip_flicker_rate', 'ledstrip_fade_rate', 'ledstrip_inverted_format', 'osd_units',
        'osd_warn_arming_disable', 'osd_warn_batt_not_full', 'osd_warn_batt_warning', 'osd_warn_batt_critical',
        'osd_warn_visual_beeper', 'osd_warn_esc_fail', 'osd_warn_core_temp', 'osd_warn_fail_safe', 'osd_warn_no_gps_rescue',
        'osd_warn_gps_rescue_disabled', 'osd_warn_rssi', 'osd_warn_link_quality', 'osd_warn_rssi_dbm', 'osd_warn_over_cap',
        'osd_rssi_alarm', 'osd_link_quality_alarm', 'osd_rssi_dbm_alarm', 'osd_cap_alarm', 'osd_alt_alarm', 'osd_distance_alarm',
        'osd_esc_temp_alarm', 'osd_esc_rpm_alarm', 'osd_esc_current_alarm', 'osd_core_temp_alarm', 'osd_ah_max_pit',
        'osd_ah_max_rol', 'osd_ah_invert', 'osd_logo_on_arming', 'osd_logo_on_arming_duration', 'osd_tim1', 'osd_tim2',
        'osd_vbat_pos', 'osd_rssi_pos', 'osd_link_quality_pos', 'osd_link_tx_power_pos', 'osd_rssi_dbm_pos', 'osd_tim_1_pos',
        'osd_tim_2_pos', 'osd_remaining_time_estimate_pos', 'osd_flymode_pos', 'osd_g_force_pos', 'osd_throttle_pos',
        'osd_vtx_channel_pos', 'osd_crosshairs_pos', 'osd_ah_sbar_pos', 'osd_ah_pos', 'osd_current_pos', 'osd_mah_drawn_pos',
        'osd_motor_diag_pos', 'osd_craft_name_pos', 'osd_display_name_pos', 'osd_gps_speed_pos', 'osd_gps_lon_pos',
        'osd_gps_lat_pos', 'osd_gps_sats_pos', 'osd_home_dir_pos', 'osd_home_dist_pos', 'osd_flight_dist_pos',
        'osd_compass_bar_pos', 'osd_altitude_pos', 'osd_pid_roll_pos', 'osd_pid_pitch_pos', 'osd_pid_yaw_pos', 'osd_debug_pos',
        'osd_power_pos', 'osd_pidrate_profile_pos', 'osd_warnings_pos', 'osd_avg_cell_voltage_pos', 'osd_pit_ang_pos',
        'osd_rol_ang_pos', 'osd_battery_usage_pos', 'osd_disarmed_pos', 'osd_nheading_pos', 'osd_up_down_reference_pos',
        'osd_nvario_pos', 'osd_esc_tmp_pos', 'osd_esc_rpm_pos', 'osd_esc_rpm_freq_pos', 'osd_rtc_date_time_pos',
        'osd_adjustment_range_pos', 'osd_flip_arrow_pos', 'osd_core_temp_pos', 'osd_log_status_pos',
        'osd_stick_overlay_left_pos', 'osd_stick_overlay_right_pos', 'osd_stick_overlay_radio_mode', 'osd_rate_profile_name_pos',
        'osd_pid_profile_name_pos', 'osd_profile_name_pos', 'osd_rcchannels_pos', 'osd_camera_frame_pos', 'osd_efficiency_pos',
        'osd_total_flights_pos', 'osd_stat_rtc_date_time', 'osd_stat_tim_1', 'osd_stat_tim_2', 'osd_stat_max_spd',
        'osd_stat_max_dist', 'osd_stat_min_batt', 'osd_stat_endbatt', 'osd_stat_battery', 'osd_stat_min_rssi',
        'osd_stat_max_curr', 'osd_stat_used_mah', 'osd_stat_max_alt', 'osd_stat_bbox', 'osd_stat_bb_no', 'osd_stat_max_g_force',
        'osd_stat_max_esc_temp', 'osd_stat_max_esc_rpm', 'osd_stat_min_link_quality', 'osd_stat_flight_dist', 'osd_stat_max_fft',
        'osd_stat_total_flights', 'osd_stat_total_time', 'osd_stat_total_dist', 'osd_stat_min_rssi_dbm', 'osd_profile',
        'osd_profile_1_name', 'osd_profile_2_name', 'osd_profile_3_name', 'osd_gps_sats_show_hdop', 'osd_displayport_device',
        'osd_rcchannels', 'osd_camera_frame_width', 'osd_camera_frame_height', 'osd_stat_avg_cell_value', 'osd_framerate_hz',
        'osd_menu_background', 'vtx_band', 'vtx_channel', 'vtx_power', 'vtx_low_power_disarm', 'vtx_softserial_alt', 'vtx_freq',
        'vtx_pit_mode_freq', 'vtx_halfduplex', 'vtx_pinswap', 'vtx_spi_bus', 'vcd_video_system', 'vcd_h_offset', 'vcd_v_offset',
        'max7456_clock', 'max7456_spi_bus', 'max7456_preinit_opu', 'displayport_msp_col_adjust', 'displayport_msp_row_adjust',
        'displayport_msp_serial', 'displayport_msp_attrs', 'displayport_msp_use_device_blink', 'displayport_max7456_col_adjust',
        'displayport_max7456_row_adjust', 'displayport_max7456_inv', 'displayport_max7456_blk', 'displayport_max7456_wht',
        'led_inversion', 'dashboard_i2c_bus', 'dashboard_i2c_addr', 'camera_control_mode', 'camera_control_ref_voltage',
        'camera_control_key_delay', 'camera_control_internal_resistance', 'camera_control_button_resistance',
        'camera_control_inverted', 'pinio_config', 'pinio_box', 'rcdevice_init_dev_attempts',
        'rcdevice_init_dev_attempt_interval', 'rcdevice_protocol_version', 'rcdevice_feature',
        'feature LED_STRIP', 'feature DASHBOARD', 'feature OSD', 'feature CMS'] },
    { id: 'hardware', flight: false, title: 'Devices of the flight controller', reason: 'They connect the firmware to the devices of the flight controller. They do not change the control.', names: [
        'mag_bustype', 'mag_i2c_device', 'mag_i2c_address', 'mag_spi_device', 'baro_bustype', 'baro_spi_device',
        'baro_i2c_device', 'baro_i2c_address', 'serialrx_inverted', 'serialrx_halfduplex', 'serialrx_pinswap',
        'spektrum_sat_bind', 'spektrum_sat_bind_autoreset', 'srxl2_unit_id', 'srxl2_baud_fast', 'sbus_baud_fast',
        'crsf_use_negotiated_baud', 'rx_spi_bus', 'rx_spi_led_inversion', 'adc_device', 'adc_tempsensor_calibration30',
        'adc_tempsensor_calibration110', 'reboot_character', 'serial_update_rate_hz', 'sdcard_detect_inverted', 'sdcard_mode',
        'sdcard_spi_bus', 'sdio_clk_bypass', 'sdio_use_cache', 'sdio_use_4bit_width', 'sdio_device', 'system_hse_mhz',
        'task_statistics', 'frsky_spi_autobind', 'frsky_spi_tx_id', 'frsky_spi_offset', 'frsky_spi_bind_hop_data',
        'frsky_x_rx_num', 'frsky_spi_a1_source', 'cc2500_spi_chip_detect', 'usb_hid_cdc', 'usb_msc_pin_pullup', 'flash_spi_bus',
        'gyro_1_bustype', 'gyro_1_spibus', 'gyro_1_i2cBus', 'gyro_1_i2c_address', 'gyro_2_bustype', 'gyro_2_spibus',
        'gyro_2_i2cBus', 'gyro_2_i2c_address', 'i2c1_pullup', 'i2c1_clockspeed_khz', 'i2c2_pullup', 'i2c2_clockspeed_khz',
        'i2c3_pullup', 'i2c3_clockspeed_khz', 'i2c4_pullup', 'i2c4_clockspeed_khz', 'mco_on_pa8', 'mco_source', 'mco_divider',
        'mco2_on_pc9', 'spektrum_spi_protocol', 'spektrum_spi_mfg_id', 'spektrum_spi_num_channels', 'expresslrs_uid',
        'expresslrs_domain', 'expresslrs_rate_index', 'expresslrs_switch_mode', 'expresslrs_model_id', 'flysky_spi_tx_id',
        'flysky_spi_rf_channels', 'feature SOFTSERIAL'] },
    { id: 'modes', flight: false, title: 'Switches and adjustments', reason: 'They set the switches that select the flight modes and the adjustments.', names: [
        'box_user_1_name', 'box_user_2_name', 'box_user_3_name', 'box_user_4_name'] },
    { id: 'names', flight: false, title: 'Names and information', reason: 'They are names and other information. They do not change the flight.', names: [
        'rateprofile_name', 'profile_name', 'timezone_offset_minutes', 'stats_min_armed_time_s', 'stats_total_flights',
        'stats_total_time_s', 'stats_total_dist_m', 'name', 'display_name', 'model_id', 'model_param1_type',
        'model_param1_value', 'model_param2_type', 'model_param2_value', 'model_param3_type', 'model_param3_value',
        'model_set_name', 'model_tell_capacity', 'Craft name'] },
    { id: 'logFacts', flight: false, title: 'Log header information', reason: 'The log header records them as information. They are not parameters.', names: [
        'Product', 'Data version', 'Firmware type', 'firmwareType', 'firmware', 'firmwarePatch', 'firmwareVersion', 'Firmware date',
        'Log start datetime', 'gyroScale', 'acc_1G', 'vbatref'] },
];
const UNKNOWN = { id: 'unknown', flight: true, title: 'Unknown parameters', reason: 'The app does not know these names. Thus, the app uses them as parameters that change the flight.', names: [] };

// Feature bits of 4.6.0 src/main/config/feature.h. The bits that 4.6.0 does not use are one value, `feature other bits`
const FEATURES = { 0: 'RX_PPM', 3: 'RX_SERIAL', 6: 'SOFTSERIAL', 7: 'GPS', 9: 'RANGEFINDER', 10: 'TELEMETRY', 13: 'RX_PARALLEL_PWM', 14: 'RX_MSP',
    15: 'RSSI_ADC', 16: 'LED_STRIP', 17: 'DASHBOARD', 18: 'OSD', 19: 'CMS', 25: 'RX_SPI', 26: 'GOVERNOR', 27: 'ESC_SENSOR', 28: 'FREQ_SENSOR',
    29: 'DYN_NOTCH', 30: 'RPM_FILTER' };

// Header keys (sysConfig, after the translation of js/flightlog_parser.js) to parameter names: one name for each element
// (blackbox.c:1642-1779), a base name for name[i], or { names, scale } (header value x scale = the CLI unit)
const AX = ['roll', 'pitch', 'yaw'];
const HEADER = {
    rates_type: 'rates_type', rc_rates: AX.map(a => `${a}_rc_rate`), rc_expo: AX.map(a => `${a}_expo`), rates: AX.map(a => `${a}_srate`),
    response_time: AX.map(a => `${a}_response`), accel_limit: AX.map(a => `${a}_accel_limit`),
    rollPID: ['p', 'i', 'd', 'f', 'b'].map(g => `roll_${g}_gain`), pitchPID: ['p', 'i', 'd', 'f', 'b'].map(g => `pitch_${g}_gain`), yawPID: ['p', 'i', 'd', 'f', 'b'].map(g => `yaw_${g}_gain`),
    levelPID: ['angle_level_strength', 'angle_level_limit', 'horizon_level_strength', 'horizon_transition'],
    govPID: ['gov_p_gain', 'gov_i_gain', 'gov_d_gain', 'gov_f_gain', 'gov_gain'],
    rollBW: ['roll_gyro_cutoff', 'roll_d_cutoff', 'roll_b_cutoff'], pitchBW: ['pitch_gyro_cutoff', 'pitch_d_cutoff', 'pitch_b_cutoff'], yawBW: ['yaw_gyro_cutoff', 'yaw_d_cutoff', 'yaw_b_cutoff'],
    iterm_relax_type: 'iterm_relax_type', iterm_relax_cutoff: { base: 'iterm_relax_cutoff' }, error_limit: { base: 'error_limit' },
    error_decay: ['error_decay_time_cyclic', 'error_decay_limit_cyclic'], error_decay_ground: 'error_decay_time_ground',
    cyclic_coupling: ['cyclic_cross_coupling_gain', 'cyclic_cross_coupling_ratio', 'cyclic_cross_coupling_cutoff'],
    yaw_stop_gain: ['yaw_cw_stop_gain', 'yaw_ccw_stop_gain'], yaw_precomp: ['yaw_precomp_cutoff', 'yaw_cyclic_ff_gain', 'yaw_collective_ff_gain'],
    yaw_inertia_precomp: ['yaw_inertia_precomp_gain', 'yaw_inertia_precomp_cutoff'], yaw_tta: ['gov_tta_gain', 'gov_tta_limit'],
    hsi_gain: ['roll_o_gain', 'pitch_o_gain'], hsi_limit: { base: 'offset_limit' }, pitch_compensation: 'pitch_collective_ff_gain',
    deadband: 'deadband', yaw_deadband: 'yaw_deadband', gyro_to_use: 'gyro_to_use', gyro_lpf: 'gyro_hardware_lpf',
    gyro_soft_type: 'gyro_lpf1_type', gyro_lowpass_hz: 'gyro_lpf1_static_hz', gyro_lowpass_dyn_hz: ['gyro_lpf1_dyn_min_hz', 'gyro_lpf1_dyn_max_hz'],
    gyro_soft2_type: 'gyro_lpf2_type', gyro_lowpass2_hz: 'gyro_lpf2_static_hz', gyro_notch_hz: ['gyro_notch1_hz', 'gyro_notch2_hz'],
    gyro_notch_cutoff: ['gyro_notch1_cutoff', 'gyro_notch2_cutoff'], dyn_notch_count: 'dyn_notch_count', dyn_notch_q: 'dyn_notch_q',
    dyn_notch_min_hz: 'dyn_notch_min_hz', dyn_notch_max_hz: 'dyn_notch_max_hz', dshot_bidir: 'dshot_bidir',
    gyro_rpm_notch_preset: 'gyro_rpm_notch_preset', gyro_rpm_notch_min_hz: 'gyro_rpm_notch_min_hz',
    acc_lpf_hz: { names: ['acc_lpf_hz'], scale: 0.01 }, acc_hardware: 'acc_hardware', baro_hardware: 'baro_hardware', mag_hardware: 'mag_hardware',
    gyro_cal_on_first_arm: 'gyro_cal_on_first_arm', serialrx_provider: 'serialrx_provider', unsynced_fast_pwm: 'use_unsynced_pwm',
    fast_pwm_protocol: 'motor_pwm_protocol', motor_pwm_rate: 'motor_pwm_rate', minthrottle: 'min_throttle', maxthrottle: 'max_throttle',
    collectiveRange: ['mixer input SC min', 'mixer input SC max'], debug_mode: 'debug_mode', debug_axis: 'debug_axis',
    vbatscale: 'vbat_scale', vbatmincellvoltage: 'vbat_min_cell_voltage', vbatwarningcellvoltage: 'vbat_warning_cell_voltage',
    vbatmaxcellvoltage: 'vbat_max_cell_voltage', currentMeterOffset: 'ibata_offset', currentMeterScale: 'ibata_scale',
};
for (const ax of AX) for (const k of ['source', 'center', 'q']) HEADER[`gyro_rpm_notch_${k}_${ax}`] = { base: `gyro_rpm_notch_${k}_${ax}` };
const SKIP_KEYS = new Set(['frameDefs', 'unknownHeaders', 'features']); // containers; features: the bits (FEATURES)

// CLI lookup values of the names that the header records as numbers (settings.c lookup tables, 4.6.0)
const OFF_ON = ['OFF', 'ON'], LPF = ['NONE', 'FIRST_ORDER', 'SECOND_ORDER', 'PT1', 'PT2', 'PT3', 'ORDER1', 'BUTTER', 'BESSEL', 'DAMPED'];
const ENUMS = {
    gyro_lpf1_type: LPF, gyro_lpf2_type: LPF, gyro_hardware_lpf: ['NORMAL', 'OPTION_1', 'OPTION_2', 'EXPERIMENTAL'], gyro_to_use: ['FIRST', 'SECOND', 'BOTH'],
    iterm_relax_type: ['OFF', 'RP', 'RPY'], rates_type: ['NONE', 'BETAFLIGHT', 'RACEFLIGHT', 'KISS', 'ACTUAL', 'QUICK', 'ROTORFLIGHT'],
    serialrx_provider: ['SPEK1024', 'SPEK2048', 'SBUS', 'SUMD', 'SUMH', 'XB-B', 'XB-B-RJ01', 'IBUS', 'JETIEXBUS', 'CRSF', 'SRXL', 'CUSTOM', 'FPORT', 'SRXL2', 'GHST', 'SBUS2', 'FPORT2', 'FBUS', 'XB-A', 'IBUS2'],
    motor_pwm_protocol: ['PWM', 'ONESHOT125', 'ONESHOT42', 'MULTISHOT', 'RESERVED', 'DSHOT150', 'DSHOT300', 'DSHOT600', 'PROSHOT1000', 'CASTLE', 'DISABLED'],
    dshot_bidir: OFF_ON, use_unsynced_pwm: OFF_ON, gyro_cal_on_first_arm: OFF_ON,
};

// 4.6.0 defaults of the header names, for a CLI dump of `diff all`, which leaves a default value out. Source: the PAIRS of
// health_setup.cjs (FW src/main/pg/pid.c:43-126, pg/gyro.c, pg/rpm_filter.c). A name without a default is not compared
const DEFAULTS = {
    roll_p_gain: 50, roll_i_gain: 100, roll_d_gain: 0, roll_f_gain: 100, roll_b_gain: 0, pitch_p_gain: 50, pitch_i_gain: 100, pitch_d_gain: 40, pitch_f_gain: 100, pitch_b_gain: 0,
    yaw_p_gain: 80, yaw_i_gain: 120, yaw_d_gain: 10, yaw_f_gain: 0, yaw_b_gain: 0, roll_gyro_cutoff: 50, roll_d_cutoff: 15, roll_b_cutoff: 15, pitch_gyro_cutoff: 50,
    pitch_d_cutoff: 15, pitch_b_cutoff: 15, yaw_gyro_cutoff: 100, yaw_d_cutoff: 20, yaw_b_cutoff: 20, gov_p_gain: 40, gov_i_gain: 50, gov_d_gain: 0, gov_f_gain: 10, gov_gain: 40,
    yaw_cw_stop_gain: 120, yaw_ccw_stop_gain: 80, yaw_precomp_cutoff: 5, yaw_cyclic_ff_gain: 10, yaw_collective_ff_gain: 60, yaw_inertia_precomp_gain: 0,
    yaw_inertia_precomp_cutoff: 25, gov_tta_gain: 0, gov_tta_limit: 20, roll_o_gain: 50, pitch_o_gain: 50, 'offset_limit[0]': 90, 'offset_limit[1]': 90,
    error_decay_time_cyclic: 250, error_decay_limit_cyclic: 12, error_decay_time_ground: 25, 'iterm_relax_cutoff[0]': 10, 'iterm_relax_cutoff[1]': 10,
    'iterm_relax_cutoff[2]': 10, cyclic_cross_coupling_gain: 50, cyclic_cross_coupling_ratio: 0, cyclic_cross_coupling_cutoff: 25, pitch_collective_ff_gain: 0,
    gyro_lpf1_type: 1, gyro_lpf1_static_hz: 100, gyro_lpf2_type: 0, gyro_lpf2_static_hz: 50, gyro_lpf1_dyn_min_hz: 0, gyro_lpf1_dyn_max_hz: 0,
    dyn_notch_count: 6, dyn_notch_q: 25, dyn_notch_min_hz: 20, dyn_notch_max_hz: 240, gyro_rpm_notch_preset: 2, gyro_rpm_notch_min_hz: 20,
    'mixer input SC min': -1250, 'mixer input SC max': 1250,
    // pg/pid.c resetPidProfile (4.6.0, lines 43-125): the names of the header that a `diff all` leaves out at their default
    iterm_relax_type: 2, 'iterm_relax_level[0]': 40, 'iterm_relax_level[1]': 40, 'iterm_relax_level[2]': 40, 'error_limit[0]': 45, 'error_limit[1]': 45, 'error_limit[2]': 60,
    error_decay_time_yaw: 0, error_decay_limit_yaw: 0, offset_flood_relax_level: 40, offset_flood_relax_cutoff: 3,
};

// In-flight adjustment functions of 4.6.0 (src/main/fc/rc_adjustments.h adjustmentFunc_e) to [parameter, decoder scale]:
// js/flightlog_parser.js multiplies some values (expo 0.01, ...), so value / scale is the CLI value. Functions 30 and 31
// have no 4.6.0 parameter: unknown. 1 and 2 are the rate and PID profile switches
const ADJUST = {
    3: ['ledstrip_profile', 1], 4: ['osd_profile', 1], 5: ['pitch_srate', 1], 6: ['roll_srate', 1], 7: ['yaw_srate', 1], 8: ['pitch_rc_rate', 1], 9: ['roll_rc_rate', 1],
    10: ['yaw_rc_rate', 1], 11: ['pitch_expo', 0.01], 12: ['roll_expo', 0.01], 13: ['yaw_expo', 0.01], 14: ['pitch_p_gain', 1], 15: ['pitch_i_gain', 1],
    16: ['pitch_d_gain', 1], 17: ['pitch_f_gain', 1], 18: ['roll_p_gain', 1], 19: ['roll_i_gain', 1], 20: ['roll_d_gain', 1], 21: ['roll_f_gain', 1],
    22: ['yaw_p_gain', 1], 23: ['yaw_i_gain', 1], 24: ['yaw_d_gain', 1], 25: ['yaw_f_gain', 1], 26: ['yaw_cw_stop_gain', 1], 27: ['yaw_ccw_stop_gain', 1],
    28: ['yaw_cyclic_ff_gain', 1], 29: ['yaw_collective_ff_gain', 1], 32: ['pitch_collective_ff_gain', 1], 33: ['pitch_gyro_cutoff', 1], 34: ['roll_gyro_cutoff', 1],
    35: ['yaw_gyro_cutoff', 1], 36: ['pitch_d_cutoff', 1], 37: ['roll_d_cutoff', 1], 38: ['yaw_d_cutoff', 1], 39: ['rescue_climb_collective', 1],
    40: ['rescue_hover_collective', 1], 41: ['rescue_hover_altitude', 1], 42: ['rescue_alt_p_gain', 1], 43: ['rescue_alt_i_gain', 1], 44: ['rescue_alt_d_gain', 1],
    45: ['angle_level_strength', 1], 46: ['horizon_level_strength', 1], 47: ['acro_trainer_gain', 1], 48: ['gov_gain', 1], 49: ['gov_p_gain', 1], 50: ['gov_i_gain', 1],
    51: ['gov_d_gain', 1], 52: ['gov_f_gain', 1], 53: ['gov_tta_gain', 1], 54: ['gov_cyclic_ff_weight', 1], 55: ['gov_collective_ff_weight', 1],
    56: ['pitch_b_gain', 1], 57: ['roll_b_gain', 1], 58: ['yaw_b_gain', 1], 59: ['pitch_o_gain', 1], 60: ['roll_o_gain', 1], 61: ['cyclic_cross_coupling_gain', 1],
    62: ['cyclic_cross_coupling_ratio', 1], 63: ['cyclic_cross_coupling_cutoff', 1], 64: ['acc_trim_pitch', 1], 65: ['acc_trim_roll', 1],
    66: ['yaw_inertia_precomp_gain', 1], 67: ['yaw_inertia_precomp_cutoff', 0.1], 68: ['setpoint_boost_gain[1]', 1], 69: ['setpoint_boost_gain[0]', 1],
    70: ['setpoint_boost_gain[2]', 1], 71: ['setpoint_boost_gain[3]', 1], 72: ['yaw_dynamic_ceiling_gain', 1], 73: ['yaw_dynamic_deadband_gain', 1],
    74: ['yaw_dynamic_deadband_filter', 0.1], 75: ['yaw_precomp_cutoff', 1], 76: ['gov_idle_throttle', 0.1], 77: ['gov_auto_throttle', 0.1],
    78: ['gov_max_throttle', 1], 79: ['gov_min_throttle', 1], 80: ['gov_headspeed', 1], 81: ['gov_yaw_ff_weight', 1], 82: ['bat_profile', 1],
};

// the 4.4.0 header names of the table: not counted as missing in the coverage of a 4.6 dataset
const LEGACY = new Set(['yaw_precomp_impulse', 'piro_compensation', 'gyro_rpm_filter_bank_rpm_source', 'gyro_rpm_filter_bank_rpm_limit', 'gyro_rpm_filter_bank_notch_q', 'gyro_rpm_filter_bank_rpm_ratio']);
const NAME_GROUP = new Map(), NAME_INDEX = new Map(), ORDER = new Map(), PROFILE_SET = new Set(PROFILE_NAMES), RATE_SET = new Set(RATE_NAMES);
GROUPS.forEach((g, i) => { ORDER.set(g.id, i); g.names.forEach((n, k) => { NAME_GROUP.set(n, g); NAME_INDEX.set(n, k); }); });
ORDER.set(UNKNOWN.id, GROUPS.length);
const GROUP_BY_ID = new Map(GROUPS.concat([UNKNOWN]).map(g => [g.id, g]));

const baseOf = (name) => String(name).replace(/\[\d+\]$/, '');
// the order of the table: group, the place of the name in its group (settings.c order), the element, then the name
function nameOrder(a, b) {
    const ga = ORDER.get(groupOf(a).id), gb = ORDER.get(groupOf(b).id); if (ga !== gb) return ga - gb;
    const ia = NAME_INDEX.has(baseOf(a)) ? NAME_INDEX.get(baseOf(a)) : 1e9, ib = NAME_INDEX.has(baseOf(b)) ? NAME_INDEX.get(baseOf(b)) : 1e9; if (ia !== ib) return ia - ib;
    const ea = /\[(\d+)\]$/.exec(a), eb = /\[(\d+)\]$/.exec(b); if (ea && eb && baseOf(a) === baseOf(b)) return +ea[1] - +eb[1];
    return a.localeCompare(b, 'en', { numeric: true });
}
function groupOf(name) {
    const base = baseOf(name), g = NAME_GROUP.get(base);
    if (g) return g;
    for (const G of GROUPS) if (G.patterns && G.patterns.some(p => p.test(base))) return G;
    return UNKNOWN;
}
// { name, group, flight, scope, title, reason, known }
function classify(name) {
    const g = groupOf(name), base = baseOf(name);
    return { name, group: g.id, flight: g.flight, scope: scopeOf(name), title: g.title, reason: g.reason, known: g !== UNKNOWN };
}
function scopeOf(name) {
    const base = baseOf(name);
    if (PROFILE_SET.has(base) || /^adjustment \d+$/.test(base)) return 'profile';
    if (RATE_SET.has(base)) return 'rate';
    return 'global';
}
const isFlight = (name) => groupOf(name).flight;

// The full table: one row for each name, by group (UI "Parameter groups", the tests)
function table() {
    const rows = [];
    for (const g of GROUPS) for (const n of g.names) rows.push({ name: n, group: g.id, flight: g.flight, scope: scopeOf(n), title: g.title, reason: g.reason });
    for (const g of GROUPS) for (const p of g.patterns || []) rows.push({ name: String(p), pattern: true, group: g.id, flight: g.flight, scope: 'global', title: g.title, reason: g.reason });
    rows.push({ name: '(any other name)', pattern: true, group: UNKNOWN.id, flight: true, scope: 'global', title: UNKNOWN.title, reason: UNKNOWN.reason });
    return rows;
}
function groups() { return GROUPS.concat([UNKNOWN]).map(g => ({ id: g.id, flight: g.flight, title: g.title, reason: g.reason, count: g.names.length + (g.patterns ? g.patterns.length : 0) })); }

// ---------------------------------------------------------------------------------------------
// Values of a log header and of a CLI dump
// ---------------------------------------------------------------------------------------------

const r3 = (v) => typeof v === 'number' && isFinite(v) ? Math.round(v * 1000) / 1000 : v;
function norm(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'number') return isFinite(v) ? r3(v) : null;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim();
    return s !== '' && isFinite(+s) ? +s : s;
}
function parseList(s) { const parts = String(s).split(',').map(p => p.trim()); return parts.length > 1 ? parts.map(norm) : norm(parts[0]); }
function expand(base, v, put) {
    if (Array.isArray(v)) v.forEach((x, i) => put(`${base}[${i}]`, x));
    else if (v !== null && typeof v === 'object') put(base, JSON.stringify(v));
    else put(base, v);
}

// { values: { name: value }, unknown: [header names that the table does not know] }
function headerValues(h) {
    const values = {}, unknown = [], put = (n, v) => { values[n] = norm(v); };
    if (!h) return { values, unknown };
    for (const key of Object.keys(h)) {
        if (SKIP_KEYS.has(key)) continue;
        const v = h[key], spec = HEADER[key];
        if (spec === undefined) { expand(key, v, put); if (groupOf(key) === UNKNOWN) unknown.push(key); continue; }
        if (typeof spec === 'string') { if (Array.isArray(v)) expand(spec, v, put); else put(spec, v); continue; }
        if (Array.isArray(spec)) { const a = Array.isArray(v) ? v : [v]; spec.forEach((n, i) => put(n, a[i])); continue; }
        if (spec.base) { expand(spec.base, Array.isArray(v) ? v : [v], put); continue; }
        if (spec.names) { const a = Array.isArray(v) ? v : [v]; spec.names.forEach((n, i) => put(n, typeof a[i] === 'number' ? a[i] * (spec.scale || 1) : a[i])); }
    }
    if (typeof h.features === 'number') {
        let other = 0;
        for (let bit = 0; bit < 32; bit++) { const on = ((h.features >>> bit) & 1) === 1; if (FEATURES[bit]) values[`feature ${FEATURES[bit]}`] = on; else if (on) other |= (1 << bit) >>> 0; }
        values['feature other bits'] = other >>> 0;
        if (other && !unknown.includes('feature other bits')) unknown.push('feature other bits');
    }
    for (const u of h.unknownHeaders || []) {
        if (!u || !u.name) continue;
        expand(u.name, parseList(u.value), put);
        if (groupOf(u.name) === UNKNOWN) unknown.push(u.name);
    }
    return { values, unknown };
}

// The CLI dump: 'set', 'profile', 'rateprofile', 'feature', 'mixer input', 'mixer rule', 'servo' and the craft name. The
// other commands (aux, adjfunc, rxfail, serial, resource, led, ...) do not change the flight or are hardware, and one dump
// cannot show a change of them between logs. The shape agrees with health_setup.parseCli, with more fields
function parseCli(text) {
    const s = String(text || ''), head = s.split(/^\s*profile\s+\d/m)[0], masterSets = (head.match(/^\s*set\s/gm) || []).length;
    const kind = /^\s*(#\s*)?diff\b/m.test(s) ? 'diff' : /^\s*(#\s*)?dump\b/m.test(s) || /^\s*#\s*master\b/m.test(s) || masterSets > 300 ? 'dump' : 'diff';
    const out = { kind, version: null, craft: null, features: {}, global: {}, profiles: {}, rateprofiles: {}, mixerInputs: {}, mixerRules: {}, servos: {}, selectedProfile: null, selectedRateProfile: null };
    let cur = out.global, m;
    for (const raw of s.split(/\r?\n/)) {
        const line = raw.trim();
        if ((m = /^# Rotorflight .*? (\d+\.\d+\.\d+)/.exec(line))) out.version = m[1];
        if ((m = /^#\s*name:\s*(.*)$/.exec(line))) { out.craft = m[1].trim() || null; continue; }
        if (!line || line.startsWith('#')) continue;
        if ((m = /^profile (\d+)$/.exec(line))) { cur = out.profiles[m[1]] = out.profiles[m[1]] || {}; out.selectedProfile = +m[1]; continue; }
        if ((m = /^rateprofile (\d+)$/.exec(line))) { cur = out.rateprofiles[m[1]] = out.rateprofiles[m[1]] || {}; out.selectedRateProfile = +m[1]; continue; }
        if ((m = /^feature (-?)(\w+)$/.exec(line))) { out.features[m[2]] = m[1] !== '-'; continue; }
        if ((m = /^mixer input (\w+) (-?\d+) (-?\d+) (-?\d+)$/.exec(line))) { out.mixerInputs[m[1]] = [+m[2], +m[3], +m[4]]; continue; }
        if ((m = /^mixer rule (\d+) (.*)$/.exec(line))) { out.mixerRules[m[1]] = m[2].trim(); continue; }
        if ((m = /^servo (\d+) ((?:-?\d+\s*){8})$/.exec(line))) { out.servos[m[1]] = m[2].trim().split(/\s+/).map(Number); continue; }
        if ((m = /^set (\w+)\s*=\s*(.*)$/.exec(line))) { cur[m[1]] = parseList(m[2]); if (m[1] === 'name' && cur === out.global) out.craft = String(m[2]).trim() || out.craft; }
    }
    return out;
}

const SERVO_FIELDS = ['mid', 'min', 'max', 'rneg', 'rpos', 'rate', 'speed', 'flags'];
function enumValue(name, v) { const t = ENUMS[baseOf(name)]; if (!t || typeof v !== 'string') return v; const i = t.indexOf(v.toUpperCase()); return i >= 0 ? i : v; }
function sectionValues(sec) {
    const out = {};
    for (const [k, v] of Object.entries(sec || {})) expand(k, v, (n, x) => { out[n] = enumValue(n, norm(x)); });
    return out;
}
// { kind, craft, global: { name: value }, profiles: { 1-6: { name: value } }, rates: { 1-6: {...} } } (PID profile = CLI index + 1)
function cliValues(c) {
    if (!c) return null;
    const global = sectionValues(c.global);
    for (const [k, v] of Object.entries(c.features || {})) global[`feature ${k}`] = !!v;
    for (const [k, v] of Object.entries(c.mixerInputs || {})) ['min', 'max', 'rate'].forEach((f, i) => { global[`mixer input ${k} ${f}`] = norm(v[i]); });
    for (const [k, v] of Object.entries(c.mixerRules || {})) global[`mixer rule ${k}`] = String(v);
    for (const [k, v] of Object.entries(c.servos || {})) SERVO_FIELDS.forEach((f, i) => { global[`servo ${k} ${f}`] = norm(v[i]); });
    const profiles = {}, rates = {};
    for (const [k, sec] of Object.entries(c.profiles || {})) profiles[+k + 1] = sectionValues(sec);
    for (const [k, sec] of Object.entries(c.rateprofiles || {})) rates[+k + 1] = sectionValues(sec);
    // the header records the active filter loop divider: filter_process_denom 0 is the PID loop divider (sensors/gyro_init.c:630)
    if (global.filter_process_denom === 0 && typeof global.pid_process_denom === 'number') global.filter_process_denom = global.pid_process_denom;
    const out = { kind: c.kind || 'dump', craft: c.craft || (c.global && typeof c.global.name === 'string' ? c.global.name : null), global, profiles, rates };
    if (out.kind === 'diff') { fillDefaults(out.profiles); fillDefaults(out.rates); fillDefaults({ g: out.global }, true); }
    return out;
}
// a diff leaves a default value out: a name that one section has and another section does not gets its default there
function fillDefaults(sections, globalOnly) {
    const all = new Set(); for (const s of Object.values(sections)) for (const n of Object.keys(s)) all.add(n);
    if (globalOnly) { for (const s of Object.values(sections)) for (const [n, v] of Object.entries(DEFAULTS)) if (scopeOf(n) === 'global' && s[n] === undefined) s[n] = v; return; }
    for (const s of Object.values(sections)) {
        for (const [n, v] of Object.entries(DEFAULTS)) if (s[n] === undefined && scopeOf(n) !== 'global') s[n] = v;
        for (const n of all) if (s[n] === undefined) s[n] = 'default';
    }
}

// The CLI dump against the header of one log: the header names that the CLI has, global, and the PID profile at arming
// when it is known (rate values are not compared: the log does not tell its rate profile)
function fitOf(hv, CV, arming) {
    const rows = [], sec = arming > 0 ? CV.profiles[arming] : null;
    let compared = 0;
    for (const [n, v] of Object.entries(hv)) {
        if (!isFlight(n) || v === null) continue;
        const sc = scopeOf(n), c = sc === 'global' ? CV.global[n] : sc === 'profile' && sec ? sec[n] : undefined;
        if (c === undefined || c === 'default') continue;
        compared++;
        if (String(c) !== String(v)) rows.push({ name: n, header: v, cli: c });
    }
    return { compared, profileCompared: !!sec, mismatches: rows, fits: compared > 0 && rows.length === 0 };
}

// ---------------------------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------------------------

function idOf(k) { let s = ''; k += 1; while (k > 0) { const m = (k - 1) % 26; s = String.fromCharCode(65 + m) + s; k = Math.floor((k - 1) / 26); } return s; }
const t3 = (v) => Math.round(v * 1000) / 1000;
const listText = (items) => items.length <= 1 ? String(items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const profileText = (p) => p ? `PID profile ${p}` : 'PID profile unknown';
const stable = (obj) => JSON.stringify(Object.keys(obj).sort().map(k => [k, obj[k]]));

function runsOf(l) {
    const src = Array.isArray(l.profileRuns) && l.profileRuns.length ? l.profileRuns : null;
    const arming = l.armingProfile > 0 ? +l.armingProfile : 0; // the label 0 (before the first switch) is the arming profile when it is confirmed
    if (src) return src.map(q => ({ t0: +q.t0, t1: +q.t1, profile: q.profile > 0 ? +q.profile : arming })).filter(q => q.t1 > q.t0).sort((a, b) => a.t0 - b.t0);
    const end = isFinite(l.durationS) ? +l.durationS : Array.isArray(l.flights) && l.flights.length ? Math.max(...l.flights.map(f => +f.t1)) : 0;
    return end > 0 ? [{ t0: 0, t1: end, profile: arming }] : [];
}
const armingOfLog = (l, runs) => l.armingProfile > 0 ? +l.armingProfile : 0;
function splitScopes(values) {
    const out = { global: {}, profile: {}, rate: {} };
    for (const [n, v] of Object.entries(values)) out[scopeOf(n)][n] = v;
    return out;
}
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
// two value maps: names (known in the two and not the same), unknown (known in one only: null or missing in the other) and
// unknownBoth (null in the two: the logs cannot tell if they are the same)
function differ(va, vb) {
    const names = [], unknown = [], unknownBoth = [], seen = new Set([...Object.keys(va || {}), ...Object.keys(vb || {})]);
    for (const n of seen) {
        const x = va[n] === undefined ? null : va[n], y = vb[n] === undefined ? null : vb[n];
        if (x === null && y === null) { unknownBoth.push(n); continue; }
        if (x === null || y === null) unknown.push(n); else if (String(x) !== String(y)) names.push(n);
    }
    return { names: names.sort(nameOrder), unknown: unknown.sort(nameOrder), unknownBoth: unknownBoth.sort(nameOrder) };
}

/**
 * datasets(logs, cli, options) -> {
 *   datasets: [{ id: 'A', pidProfile (1-6 | null: unknown), values { name: value | null (unknown) } (flight values only),
 *     sources { name: 'header' | 'cli' | 'log N' (the header of log N, 0-based) | 'adjustment' | 'none' }, logs [log], flights
 *     [{ log, flight (0-based in its log), t0, t1, seconds (of this dataset) }], seconds, flightSeconds, assumed (every stretch is
 *     assumed), assumedSeconds, assumedFrom [{ log, t0, t1, from: log | 'cli' | null, bracketed }], unknown [names with no value],
 *     sameValuesAs [ids: datasets whose values agree where both are known], coverage [{ group, known, unknown, missing }] (the groups
 *     that change the flight: names with a value, with no value, not in the values), first { log, t }, last { log, t }, label, summary }],
 *   labels: [{ log, t0, t1, dataset, index, pidProfile, assumed, flightSeconds, source: { profile, rate } }] (frame seconds),
 *   diff: [{ name, group, scope, title, values { id: value | null }, logs { id: [log] }, samePidProfile, unknownIn [ids: no source shows
 *     the value], missingIn [ids: the name is not in their values] }],
 *   pairs: [{ a, b, names [flight names known in the two and not the same], unknown [names known in one only], samePidProfile }],
 *   info: [{ name, group, title, values [{ value, logs, datasets }] }] (values that do not change the flight and are not the same),
 *   logs: [{ log, bench, armingProfile, cli: { used, fits, compared, mismatches } | null, unknownNames }],
 *   unknownNames: [{ name, logs }], benchRuns: [log], newest: id, newestByProfile { 1-6 | 'unknown': id }, notes: [STE text], rules }
 * options: { logBase: 1 (log numbers in the texts: index + logBase), useEstimates: false (true: logs[].armingEstimate, the arming
 *   profile that the governor target shows and nothing confirms, gives the header values to the stretches of that PID profile,
 *   in that log and, as the nearest log, in other logs; every such stretch is assumed and says so. The arming stretch itself
 *   stays "PID profile unknown") }
 */
function datasets(logs, cli, options = {}) {
    const o = Object.assign({ logBase: 1 }, options), N = (log) => log + o.logBase, notes = [], noteSet = new Set();
    const note = (t) => { if (!noteSet.has(t)) { noteSet.add(t); notes.push(t); } };
    const parsed = cli ? (typeof cli === 'string' ? parseCli(cli) : cli) : null, CV = parsed ? cliValues(parsed) : null;
    const items = (logs || []).filter(l => l && l.header && Number.isFinite(+l.log)).slice().sort((a, b) => a.log - b.log).map((l, order) => {
        const H = headerValues(l.header), runs = runsOf(l), arming = armingOfLog(l, runs), craft = l.header['Craft name'] ? String(l.header['Craft name']).trim() : null;
        const cliUsed = !!CV && !(CV.craft && craft && CV.craft !== craft);
        if (CV && !cliUsed) note(`The craft name of the CLI dump is not the craft name of log ${N(l.log)}. Thus, the app does not use the CLI dump for log ${N(l.log)}.`);
        const fit = cliUsed ? fitOf(H.values, CV, arming) : null, bench = Array.isArray(l.flights) && l.flights.length === 0;
        const estimate = !arming && l.armingEstimate > 0 ? +l.armingEstimate : 0;
        return { l, log: +l.log, order, H, S: splitScopes(H.values), runs, arming, estimate, cliUsed, fit, bench };
    });
    const unknownNames = new Map(); for (const it of items) for (const n of it.H.unknown) (unknownNames.get(n) || unknownNames.set(n, new Set()).get(n)).add(it.log);
    // the header profile values of the logs armed (confirmed) in each PID profile, bench runs included (a header is a fact)
    const armed = new Map(), estimated = new Map();
    for (const it of items) { if (it.arming > 0) (armed.get(it.arming) || armed.set(it.arming, []).get(it.arming)).push(it); else if (it.estimate > 0) (estimated.get(it.estimate) || estimated.set(it.estimate, []).get(it.estimate)).push(it); }
    const flightOf = (vals) => Object.fromEntries(Object.entries(vals).filter(([n]) => isFlight(n)));

    // the PID profile values of a stretch of log it in PID profile p (0: the arming profile, whose number is not known)
    const profCache = new Map();
    function resolveProfile(it, p) {
        const k = `${it.log}|${p}`; if (profCache.has(k)) return profCache.get(k);
        const cliSec = it.cliUsed && p > 0 ? CV.profiles[p] : null, src = {}, vals = {};
        const addCli = (onlyMissing) => { if (!cliSec) return; for (const [n, v] of Object.entries(cliSec)) if (!onlyMissing || vals[n] === undefined) { vals[n] = v; src[n] = 'cli'; } };
        let res;
        if (p === 0 || p === it.arming) {
            Object.assign(vals, it.S.profile); for (const n of Object.keys(vals)) src[n] = 'header'; addCli(true);
            res = { vals, src, assumed: false, from: 'header' };
        } else if (o.useEstimates && p === it.estimate) {
            // options.useEstimates: the arming profile that the governor target shows (not confirmed) gives the header values
            Object.assign(vals, it.S.profile); for (const n of Object.keys(vals)) src[n] = 'estimate'; addCli(true);
            res = { vals, src, assumed: true, from: 'estimate' };
        } else if (cliSec && it.fit && it.fit.fits) {
            addCli(false); for (const n of Object.keys(it.S.profile)) if (vals[n] === undefined) { vals[n] = null; src[n] = 'none'; }
            res = { vals, src, assumed: false, from: 'cli' };
        } else {
            let cands = (armed.get(p) || []).filter(m => m.log !== it.log), viaEstimate = false;
            if (!cands.length && o.useEstimates && !(cliSec && it.fit && it.fit.fits)) { cands = (estimated.get(p) || []).filter(m => m.log !== it.log); viaEstimate = cands.length > 0; }
            if (cands.length) {
                cands.sort((a, b) => Math.abs(a.order - it.order) - Math.abs(b.order - it.order) || a.order - b.order);
                const m = cands[0], before = cands.filter(c => c.order < it.order), after = cands.filter(c => c.order > it.order);
                const key = (x) => stable(flightOf(x.S.profile)), bracketed = before.length > 0 && after.length > 0 && key(before.sort((a, b) => b.order - a.order)[0]) === key(after.sort((a, b) => a.order - b.order)[0]);
                Object.assign(vals, m.S.profile); for (const n of Object.keys(vals)) src[n] = `log ${m.log}`; addCli(true);
                res = { vals, src, assumed: true, from: m.log, bracketed, viaEstimate };
            } else if (cliSec) {
                addCli(false); for (const n of Object.keys(it.S.profile)) if (vals[n] === undefined) { vals[n] = null; src[n] = 'none'; }
                res = { vals, src, assumed: true, from: 'cli' };
            } else {
                for (const n of Object.keys(it.S.profile)) { vals[n] = null; src[n] = 'none'; }
                res = { vals, src, assumed: true, from: null };
            }
        }
        profCache.set(k, res); return res;
    }
    // the rate values after a switch to rate profile q (null: the rate profile at the start of the log, in the header)
    function resolveRate(it, q) {
        const vals = {}, src = {};
        if (q === null) { Object.assign(vals, it.S.rate); for (const n of Object.keys(vals)) src[n] = 'header'; return { vals, src, assumed: false, from: 'header' }; }
        const sec = it.cliUsed ? CV.rates[q] : null;
        if (sec) { for (const [n, v] of Object.entries(sec)) { vals[n] = v; src[n] = 'cli'; } for (const n of Object.keys(it.S.rate)) if (vals[n] === undefined) { vals[n] = null; src[n] = 'none'; } return { vals, src, assumed: !(it.fit && it.fit.fits), from: 'cli' }; }
        for (const n of Object.keys(it.S.rate)) { vals[n] = null; src[n] = 'none'; }
        return { vals, src, assumed: true, from: null };
    }

    // the stretches of each flight log
    const stretches = [], benchRuns = [], infoItems = [];
    for (const it of items) {
        if (it.bench) { benchRuns.push(it.log); continue; }
        if (!it.runs.length) continue;
        const l = it.l, runAt = (t) => { let q = null; for (const x of it.runs) if (x.t0 <= t) q = x; else break; return q && t < q.t1 ? q : null; };
        const events = [];
        for (const e of l.rateChanges || []) if (isFinite(e.t) && e.profile > 0) events.push({ t: +e.t, rate: +e.profile });
        for (const e of l.adjustments || []) if (e && isFinite(e.t)) {
            if (e.func === 1 && e.value > 0) events.push({ t: +e.t, rate: +e.value });
            else if (e.func !== 2 && e.func !== 0 && e.func !== undefined) events.push({ t: +e.t, adj: e });
        }
        events.sort((a, b) => a.t - b.t);
        const cuts = new Set([it.runs[0].t0, it.runs[it.runs.length - 1].t1]);
        for (const q of it.runs) { cuts.add(q.t0); cuts.add(q.t1); }
        for (const e of events) if (e.t > it.runs[0].t0 && e.t < it.runs[it.runs.length - 1].t1) cuts.add(e.t);
        const T = [...cuts].sort((a, b) => a - b), over = { profile: new Map(), rate: new Map(), global: {} };
        let rateNow = null, ei = 0;
        for (let k = 0; k + 1 < T.length; k++) {
            const a = T[k], b = T[k + 1]; if (!(b > a)) continue;
            for (; ei < events.length && events[ei].t <= a; ei++) {
                const e = events[ei];
                if (e.rate !== undefined) { rateNow = e.rate; continue; }
                const spec = ADJUST[e.adj.func], name = spec ? spec[0] : `adjustment ${e.adj.func}`, value = spec ? norm(Math.round(e.adj.value / spec[1] * 1000) / 1000) : norm(e.adj.value);
                const sc = scopeOf(name), at = runAt(e.t), pk = at ? at.profile : 0, rk = rateNow === null ? 'start' : rateNow;
                if (sc === 'profile') { const m = over.profile.get(pk) || over.profile.set(pk, {}).get(pk); m[name] = value; }
                else if (sc === 'rate') { const m = over.rate.get(rk) || over.rate.set(rk, {}).get(rk); m[name] = value; }
                else over.global[name] = value;
                if (isFlight(name)) note(`In log ${N(it.log)}, the pilot changed \`${name}\` in flight at ${t3(e.t)} s. Thus, the time after this change is a different configuration.`);
                if (!spec) (unknownNames.get(name) || unknownNames.set(name, new Set()).get(name)).add(it.log);
            }
            const run = runAt(a); if (!run) continue; // a logging gap between two segments
            const p = run.profile, P = resolveProfile(it, p), R = resolveRate(it, rateNow), values = {}, sources = {};
            const set = (vals, src) => { for (const [n, v] of Object.entries(vals)) { values[n] = v; sources[n] = src[n] || src; } };
            if (it.cliUsed) { const g = {}; for (const [n, v] of Object.entries(CV.global)) if (it.S.global[n] === undefined) g[n] = v; set(g, 'cli'); }
            set(it.S.global, 'header'); set(P.vals, P.src); set(R.vals, R.src);
            set(over.global, 'adjustment'); set(over.profile.get(p) || {}, 'adjustment'); set(over.rate.get(rateNow === null ? 'start' : rateNow) || {}, 'adjustment');
            const pid = p > 0 ? p : null, flight = flightOf(values), key = `${pid}|${stable(flight)}`;
            let fs = 0; for (const f of l.flights || []) fs += overlap(a, b, +f.t0, +f.t1);
            const s = { log: it.log, order: it.order, t0: a, t1: b, pidProfile: pid, key, values, sources, assumed: P.assumed || R.assumed, profileFrom: P.from, rateFrom: R.from, bracketed: !!P.bracketed, viaEstimate: !!P.viaEstimate, flightSeconds: fs };
            const prev = stretches[stretches.length - 1];
            if (prev && prev.log === s.log && prev.key === s.key && prev.t1 === s.t0 && prev.assumed === s.assumed && prev.profileFrom === s.profileFrom) { prev.t1 = s.t1; prev.flightSeconds += fs; infoItems.push({ stretch: prev, values, sources }); }
            else { stretches.push(s); infoItems.push({ stretch: s, values, sources }); } // info: every interval, also one that a merge joins
            if (P.assumed && p > 0) {
                if (P.from === null) { note(`${it.cliUsed ? 'No log header and no CLI dump show' : 'No log header shows'} the values of PID profile ${p}. Thus, the configurations of PID profile ${p} have only the global values of the log header.`);
                    note(`The log header records the values of PID profile ${p} only when the pilot arms the helicopter in PID profile ${p}.`); }
                else if (P.from === 'cli') note(`The CLI dump does not agree with the log header of log ${N(it.log)}. Thus, the values of PID profile ${p} in log ${N(it.log)} come from a CLI dump of a different time.`);
            }
            if (R.assumed && rateNow !== null && R.from === null) note(`The log header of log ${N(it.log)} does not show the values of rate profile ${rateNow}. Thus, the rates after the switch to rate profile ${rateNow} are unknown.`);
        }
    }

    // datasets: one for each key, in the order of their first stretch
    const byKey = new Map(), list = [];
    for (const s of stretches) {
        let d = byKey.get(s.key);
        if (!d) { d = { id: idOf(list.length), index: list.length, pidProfile: s.pidProfile, values: {}, sources: {}, stretches: [] }; byKey.set(s.key, d); list.push(d); }
        d.stretches.push(s);
        for (const [n, v] of Object.entries(s.values)) if (isFlight(n)) { const src = s.sources[n]; if (d.sources[n] === undefined || (d.sources[n] !== 'header' && src === 'header')) { d.values[n] = v; d.sources[n] = src; } }
        s.dataset = d.id; s.index = d.index;
    }
    const flightsOf = new Map(items.map(it => [it.log, (it.l.flights || []).map((f, i) => ({ i, t0: +f.t0, t1: +f.t1 }))]));
    for (const d of list) {
        const fl = new Map(); let sec = 0, fsec = 0, asec = 0;
        d.assumedFrom = [];
        for (const s of d.stretches) {
            sec += s.t1 - s.t0; fsec += s.flightSeconds; if (s.assumed) { asec += s.t1 - s.t0; d.assumedFrom.push({ log: s.log, t0: t3(s.t0), t1: t3(s.t1), from: s.profileFrom === 'header' ? null : s.profileFrom, rateFrom: s.rateFrom, bracketed: s.bracketed, viaEstimate: s.viaEstimate }); }
            for (const f of flightsOf.get(s.log) || []) { const ov = overlap(s.t0, s.t1, f.t0, f.t1); if (ov > 0) { const k = `${s.log}|${f.i}`, e = fl.get(k) || fl.set(k, { log: s.log, flight: f.i, t0: t3(f.t0), t1: t3(f.t1), seconds: 0 }).get(k); e.seconds += ov; } }
        }
        Object.assign(d, { logs: [...new Set(d.stretches.map(s => s.log))], flights: [...fl.values()].map(f => Object.assign(f, { seconds: t3(f.seconds) })), seconds: t3(sec), flightSeconds: t3(fsec),
            assumed: d.stretches.every(s => s.assumed), assumedSeconds: t3(asec), unknown: Object.keys(d.values).filter(n => d.values[n] === null),
            first: { log: d.stretches[0].log, t: t3(d.stretches[0].t0) }, last: { log: d.stretches[d.stretches.length - 1].log, t: t3(d.stretches[d.stretches.length - 1].t1) } });
        // coverage: for each group that changes the flight, the names (base names, as the table has them) with a known value,
        // with no value (null: no source shows it), and not in the values at all (the header does not record them, no CLI dump)
        d.coverage = GROUPS.filter(g => g.flight).map(g => {
            const known = new Set(), unknown = new Set(); for (const [n, v] of Object.entries(d.values)) if (groupOf(n) === g) (v === null ? unknown : known).add(baseOf(n));
            for (const n of known) unknown.delete(n);
            return { group: g.id, known: known.size, unknown: unknown.size, missing: g.names.filter(n => !known.has(n) && !unknown.has(n) && !LEGACY.has(n)).length };
        });
        d.label = `Configuration ${d.id}`;
        d.summary = `Configuration ${d.id} has ${profileText(d.pidProfile)}. It has ${Math.round(d.flightSeconds * 10) / 10} s of flight in ${d.logs.length === 1 ? 'log' : 'logs'} ${listText(d.logs.map(N))}.`; // the text: 0.1 s
        for (const a of d.assumedFrom) {
            if (typeof a.from === 'number' && !a.viaEstimate) note(`The log header of log ${N(a.log)} does not show the values of ${profileText(d.pidProfile)}. Thus, configuration ${d.id} uses the values of log ${N(a.from)} for this part of log ${N(a.log)}.`);
            else if (typeof a.from === 'number') note(`The governor target shows that log ${N(a.from)} possibly started in ${profileText(d.pidProfile)}. Thus, configuration ${d.id} uses the values of log ${N(a.from)} for this part of log ${N(a.log)}.`);
            else if (a.from === 'estimate') note(`The governor target shows that log ${N(a.log)} possibly started in ${profileText(d.pidProfile)}. Thus, configuration ${d.id} uses the values of the log header of log ${N(a.log)}.`);
        }
    }
    // datasets whose values agree where both are known (a PID profile unknown that can be the same configuration)
    for (const d of list) {
        d.sameValuesAs = [];
        for (const e of list) {
            if (e === d) continue;
            let common = 0, profileCommon = 0, bad = false;
            for (const [n, v] of Object.entries(d.values)) { const w = e.values[n]; if (v === null || w === null || w === undefined) continue; common++; if (scopeOf(n) === 'profile') profileCommon++; if (String(v) !== String(w)) { bad = true; break; } }
            if (!bad && common > 0 && profileCommon > 0) d.sameValuesAs.push(e.id);
        }
    }

    // the parameters that are not the same in all datasets: two known values or more, or a name that the header of some logs
    // has and the header of others does not (another firmware, a name that the table does not know). A value that no source
    // shows (null) is not a difference
    const names = new Set(); for (const d of list) for (const n of Object.keys(d.values)) names.add(n);
    const fromHeader = (src) => src !== undefined && src !== 'cli' && src !== 'none';
    const diff = [];
    for (const n of names) {
        const vals = {}, known = new Set(), unknownIn = [], missingIn = [];
        for (const d of list) { const v = d.values[n] === undefined ? null : d.values[n]; vals[d.id] = v; if (d.values[n] === undefined) missingIn.push(d.id); else if (v === null) unknownIn.push(d.id); else known.add(String(v)); }
        if (known.size < 2 && !(known.size === 1 && missingIn.length && list.some(d => fromHeader(d.sources[n])))) continue;
        const c = classify(n);
        let samePid = false; for (const d of list) for (const e of list) if (d !== e && d.pidProfile && d.pidProfile === e.pidProfile && vals[d.id] !== null && vals[e.id] !== null && String(vals[d.id]) !== String(vals[e.id])) samePid = true;
        diff.push({ name: n, group: c.group, scope: c.scope, title: c.title, values: vals, logs: Object.fromEntries(list.map(d => [d.id, d.logs])), samePidProfile: samePid, unknownIn, missingIn });
    }
    diff.sort((a, b) => nameOrder(a.name, b.name));
    const pairs = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j], d = differ(a.values, b.values);
        pairs.push({ a: a.id, b: b.id, names: d.names, unknown: d.unknown, unknownBoth: d.unknownBoth, samePidProfile: !!a.pidProfile && a.pidProfile === b.pidProfile });
    }

    // the values that do not change the flight and are not the same in all flight logs (information)
    const infoMap = new Map(), adjusted = new Set(); // adjusted: the values that an in-flight adjustment changed
    for (const { stretch: s, values, sources } of infoItems) for (const [n, v] of Object.entries(values)) {
        if (isFlight(n) || v === null) continue; const g = groupOf(n); if (g.id === 'logFacts') continue; // null: unknown, not a different value
        const m = infoMap.get(n) || infoMap.set(n, new Map()).get(n), k = JSON.stringify(v), e = m.get(k) || m.set(k, { value: v, logs: new Set(), datasets: new Set() }).get(k);
        e.logs.add(s.log); e.datasets.add(s.dataset); if (sources[n] === 'adjustment') adjusted.add(n);
    }
    const info = [];
    for (const [n, m] of infoMap) if (m.size > 1 || adjusted.has(n)) { const g = groupOf(n); info.push({ name: n, group: g.id, title: g.title, values: [...m.values()].map(e => ({ value: e.value, logs: [...e.logs], datasets: [...e.datasets] })) }); }
    info.sort((a, b) => nameOrder(a.name, b.name));

    const labels = stretches.map(s => ({ log: s.log, t0: t3(s.t0), t1: t3(s.t1), dataset: s.dataset, index: s.index, pidProfile: s.pidProfile, assumed: s.assumed, flightSeconds: t3(s.flightSeconds),
        source: { profile: s.profileFrom === 'header' ? 'header' : s.profileFrom === 'cli' ? 'cli' : s.profileFrom === 'estimate' ? 'estimate' : typeof s.profileFrom === 'number' ? `log ${s.profileFrom}${s.viaEstimate ? ' (estimate)' : ''}` : 'none', rate: s.rateFrom === 'header' ? 'header' : s.rateFrom === 'cli' ? 'cli' : 'none' } }));
    const flown = stretches.filter(s => s.flightSeconds > 0), lastOf = (arr) => arr.length ? arr.reduce((x, y) => (y.order > x.order || (y.order === x.order && y.t0 >= x.t0)) ? y : x) : null;
    const newestS = lastOf(flown) || lastOf(stretches), newestByProfile = {};
    for (const p of new Set(stretches.map(s => s.pidProfile))) { const s = lastOf(flown.filter(x => x.pidProfile === p)) || lastOf(stretches.filter(x => x.pidProfile === p)); newestByProfile[p === null ? 'unknown' : p] = s.dataset; }
    if (!CV && list.length) note('The log header does not record the values of the mixer, the servos and most governor parameters.');
    if (unknownNames.size) note(`The app does not know these parameters: ${[...unknownNames.keys()].map(n => `\`${n}\``).join(', ')}. Thus, the app uses them as parameters that change the flight.`);

    const out = {
        version: 1,
        datasets: list.map(d => { const c = Object.assign({}, d); delete c.stretches; delete c.index; c.newest = !!newestS && newestS.dataset === d.id; return c; }),
        labels, diff, pairs, info,
        logs: items.map(it => ({ log: it.log, bench: it.bench, armingProfile: it.arming || null, armingEstimate: it.estimate || null, cli: it.fit ? { used: true, fits: it.fit.fits, compared: it.fit.compared, profileCompared: it.fit.profileCompared, mismatches: it.fit.mismatches } : { used: false }, unknownNames: it.H.unknown })),
        unknownNames: [...unknownNames].map(([name, logs]) => ({ name, logs: [...logs] })),
        benchRuns, newest: newestS ? newestS.dataset : null, newestByProfile, cli: CV ? { kind: CV.kind, craft: CV.craft, profiles: Object.keys(CV.profiles).map(Number), rateProfiles: Object.keys(CV.rates).map(Number) } : null,
        notes, rules: RULES,
    };
    return out;
}

// The dataset index (into ds.datasets) of every sample of one log, from the sample times in frame seconds (sorted); -1 for
// a sample out of every label (a bench run, or time out of the profile runs)
function labelArray(ds, log, times) {
    const L = ds.labels.filter(x => x.log === log).sort((a, b) => a.t0 - b.t0), out = new Int16Array(times.length).fill(-1);
    let k = 0;
    for (let i = 0; i < times.length; i++) {
        const t = times[i];
        while (k < L.length && L[k].t1 <= t) k++;
        if (k < L.length && L[k].t0 <= t) out[i] = L[k].index;
        else if (k > 0 && L[k - 1].t1 === t) out[i] = L[k - 1].index; // the last sample at the end of the last label
    }
    return out;
}
function datasetAt(ds, log, t) { const x = ds.labels.find(q => q.log === log && q.t0 <= t && t < q.t1); return x ? x.dataset : null; }
// The PID profile labels of one log (0: the arming profile when it is not confirmed, else 1-6, as the worker's records label
// them) to the dataset indexes of their stretches: { label: [index, ...] }. One index: the worker can rename the label of every
// result of that log to the dataset. More than one: a rate profile switch or an in-flight adjustment splits that PID profile
// in this log, and the samples need labelArray
function profileMap(ds, log) {
    const out = {};
    for (const l of ds.labels) if (l.log === log) { const k = l.pidProfile || 0, a = out[k] || (out[k] = []); if (!a.includes(l.index)) a.push(l.index); }
    return out;
}

// ---------------------------------------------------------------------------------------------
// A/B comparisons and slopes
// ---------------------------------------------------------------------------------------------

function summaryOf(v) {
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        const a = Array.from(v).filter(x => typeof x === 'number' && isFinite(x)), n = a.length; if (!n) return null;
        const m = a.reduce((s, x) => s + x, 0) / n, sd = n > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)) : null;
        return { mean: m, se: sd === null ? null : sd / Math.sqrt(n), n };
    }
    if (typeof v === 'number') return isFinite(v) ? { mean: v, se: null, n: 1 } : null;
    if (!v || typeof v !== 'object') return null;
    const m = v.mean !== undefined ? v.mean : v.value;
    if (typeof m !== 'number' || !isFinite(m)) return null;
    return { mean: m, se: typeof v.se === 'number' && isFinite(v.se) && v.se >= 0 ? v.se : null, n: typeof v.n === 'number' ? v.n : null };
}
const numeric = (v) => typeof v === 'number' && isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : null;

// Results of one check by dataset from findings that carry f.dataset (after the integration): { id: { mean, se, n } }.
// Several findings of one dataset (logs, segments) give their inverse-variance mean when each has an SE, else their mean
function resultsOf(findings, select = {}) {
    const by = new Map();
    for (const f of findings || []) {
        if (!f || !f.dataset || (select.id && f.id !== select.id) || (select.axis !== undefined && (f.axis || null) !== select.axis)) continue;
        const v = select.field ? f[select.field] : f.value; if (typeof v !== 'number' || !isFinite(v)) continue;
        (by.get(f.dataset) || by.set(f.dataset, []).get(f.dataset)).push({ v, se: typeof f.se === 'number' && f.se > 0 ? f.se : null, n: f.n || null });
    }
    const out = {};
    for (const [id, a] of by) {
        if (a.length === 1) { out[id] = { mean: a[0].v, se: a[0].se, n: a[0].n }; continue; }
        if (a.every(x => x.se)) { const w = a.map(x => 1 / x.se ** 2), W = w.reduce((s, x) => s + x, 0); out[id] = { mean: a.reduce((s, x, i) => s + w[i] * x.v, 0) / W, se: 1 / Math.sqrt(W), n: a.reduce((s, x) => s + (x.n || 1), 0) }; }
        else out[id] = summaryOf(a.map(x => x.v));
    }
    return out;
}

/**
 * compare(results, ds, options) -> { results: [{ id, mean, se, n, pidProfile }], pairs, slopes, confounded, rule }
 *   results  { datasetId: { mean | value, se, n } | number[] (samples) | number }
 *   ds       the result of datasets() (or its diff rows; the datasets that no row names have the same values)
 *   pairs    [{ a, b, names, unknown, few (1-maxNames names, none unknown), delta (b - a), se, z, significant (|delta| >= k SE), testable }]
 *   slopes   [{ name, with [{ name, ratio }] (parameters that change together with it: value = intercept + ratio x name), datasets,
 *              points [{ id, x, y, se, n }], slope, se, z, significant, intercept, method 'wls' | 'ols', chi2, dof, birge, distinct, range }]
 *            for 3 or more datasets that are the same except in these parameters (WLS with the SEs, the SE of the slope multiplied
 *            by the Birge ratio when chi2 / dof > 1; OLS when an SE is missing)
 *   confounded  [{ datasets, names }]: datasets that differ in parameters that do not change together, so no slope
 */
function compare(results, ds, options = {}) {
    const R = Object.assign({}, RULES.ab, options.ab || {}), S = Object.assign({}, RULES.slope, options.slope || {});
    const meta = new Map((ds && ds.datasets || []).map(d => [d.id, d])), values = new Map();
    if (meta.size) for (const d of meta.values()) values.set(d.id, d.values || {});
    else for (const row of Array.isArray(ds) ? ds : ds && ds.diff || []) for (const [id, v] of Object.entries(row.values || {})) (values.get(id) || values.set(id, {}).get(id))[row.name] = v;
    const res = Object.entries(results || {}).map(([id, v]) => { const s = summaryOf(v); return s ? Object.assign({ id, pidProfile: meta.has(id) ? meta.get(id).pidProfile : null }, s) : null; }).filter(Boolean);
    const valueOf = (id, name) => { const v = (values.get(id) || {})[name]; return v === undefined ? null : v; };
    const differIds = (a, b) => differ(values.get(a) || {}, values.get(b) || {});
    const pairs = [];
    for (let i = 0; i < res.length; i++) for (let j = i + 1; j < res.length; j++) {
        const A = res[i], B = res[j], d = differIds(A.id, B.id), delta = B.mean - A.mean, se = A.se !== null && B.se !== null ? Math.sqrt(A.se ** 2 + B.se ** 2) : null;
        const testable = se !== null && se > 0, clean = !d.unknown.length && (!d.unknownBoth.length || !!options.unknownEqual);
        pairs.push({ a: A.id, b: B.id, names: d.names, unknown: d.unknown, unknownBoth: d.unknownBoth, assumed: d.unknownBoth.length > 0, few: d.names.length >= 1 && d.names.length <= R.maxNames && clean, same: !d.names.length && clean,
            delta: r3(delta), se: se === null ? null : r3(se), z: testable ? r3(delta / se) : null, significant: testable ? Math.abs(delta) >= R.k * se : null, testable });
    }
    pairs.sort((p, q) => (q.few - p.few) || p.names.length - q.names.length || Math.abs(q.z || 0) - Math.abs(p.z || 0));

    // families: the datasets that are the same as an anchor except in the parameters of a set (from the A/B pairs)
    const sets = new Map();
    for (const p of pairs) if (p.few) sets.set(p.names.slice().sort().join('\u0000'), p.names.slice().sort());
    const fams = new Map(), slopes = [], confounded = [];
    for (const names of sets.values()) for (const anchor of res) {
        const members = res.filter(x => { if (x === anchor) return true; const d = differIds(anchor.id, x.id); return !d.unknown.length && (!d.unknownBoth.length || !!options.unknownEqual) && d.names.every(n => names.includes(n)); });
        if (members.length < S.minDatasets) continue;
        const key = members.map(m => m.id).sort().join(','); if (fams.has(key)) continue;
        const varying = names.filter(n => new Set(members.map(m => String(valueOf(m.id, n)))).size > 1);
        fams.set(key, { members, varying });
    }
    for (const { members, varying } of fams.values()) {
        if (!varying.length) continue;
        const xs = varying.map(n => members.map(m => numeric(valueOf(m.id, n))));
        if (xs.some(col => col.some(v => v === null))) { confounded.push({ datasets: members.map(m => m.id), names: varying, why: 'not numeric' }); continue; }
        // the primary parameter: the one with the most distinct values (then the table order); the others must be affine in it
        const order = varying.map((n, i) => ({ n, i, k: new Set(xs[i]).size })).sort((a, b) => b.k - a.k || nameOrder(a.n, b.n));
        const pi = order[0].i, x = xs[pi], withs = [];
        let ok = new Set(x).size >= S.minDistinct;
        for (const { n, i } of order.slice(1)) {
            const fit = affine(x, xs[i]); if (!fit || fit.maxResidual > S.tolerance * Math.max(1, ...xs[i].map(Math.abs))) { ok = false; break; }
            withs.push({ name: n, ratio: r3(fit.b), intercept: r3(fit.a) });
        }
        if (!ok) { confounded.push({ datasets: members.map(m => m.id), names: varying, why: new Set(x).size < S.minDistinct ? 'one value' : 'independent changes' }); continue; }
        const fit = slopeFit(x, members.map(m => m.mean), members.map(m => m.se));
        if (!fit) continue;
        const assumed = members.some(m => members.some(q => q !== m && differIds(m.id, q.id).unknownBoth.length > 0));
        slopes.push(Object.assign({ name: varying[pi], with: withs, datasets: members.map(m => m.id), assumed, points: members.map((m, k) => ({ id: m.id, x: x[k], y: r3(m.mean), se: m.se === null ? null : r3(m.se), n: m.n })),
            distinct: new Set(x).size, range: [Math.min(...x), Math.max(...x)] }, fit, { significant: fit.se > 0 ? Math.abs(fit.slope) >= S.k * fit.se : null }));
    }
    slopes.sort((a, b) => Math.abs(b.z || 0) - Math.abs(a.z || 0));
    return { results: res.map(x => Object.assign({}, x, { mean: r3(x.mean), se: x.se === null ? null : r3(x.se) })), pairs, slopes, confounded, rule: { ab: R, slope: S } };
}
function affine(x, y) { // y = a + b x by least squares, with its largest residual
    const n = x.length, mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
    let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
    if (!(sxx > 0)) return null;
    const b = sxy / sxx, a = my - b * mx; let maxResidual = 0; for (let i = 0; i < n; i++) maxResidual = Math.max(maxResidual, Math.abs(y[i] - a - b * x[i]));
    return { a, b, maxResidual };
}
function slopeFit(x, y, se) {
    const n = x.length; if (n < 2) return null;
    const wls = se.every(s => s !== null && s > 0), w = wls ? se.map(s => 1 / s ** 2) : x.map(() => 1), W = w.reduce((s, v) => s + v, 0);
    const mx = w.reduce((s, v, i) => s + v * x[i], 0) / W, my = w.reduce((s, v, i) => s + v * y[i], 0) / W;
    let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += w[i] * (x[i] - mx) ** 2; sxy += w[i] * (x[i] - mx) * (y[i] - my); }
    if (!(sxx > 0)) return null;
    const b = sxy / sxx, a = my - b * mx, dof = n - 2; let chi2 = 0; for (let i = 0; i < n; i++) chi2 += w[i] * (y[i] - a - b * x[i]) ** 2;
    let seB, birge = null;
    if (wls) { seB = Math.sqrt(1 / sxx); if (dof > 0) { birge = Math.sqrt(chi2 / dof); if (birge > 1) seB *= birge; } }
    else { if (dof < 1) return { slope: r3(b), intercept: r3(a), se: null, z: null, method: 'ols', chi2: null, dof, birge: null }; seB = Math.sqrt(chi2 / dof / sxx); }
    return { slope: r3(b), intercept: r3(a), se: r3(seB), z: seB > 0 ? r3(b / seB) : null, method: wls ? 'wls' : 'ols', chi2: wls ? r3(chi2) : null, dof, birge: birge === null ? null : r3(birge) };
}

// The measured slope applied to a change of one parameter: { change, se, significant, inRange, together, slope } or null.
// A parameter that changed together with another one in the data (slope.with) uses the slope of the set: the data cannot
// tell the two parameters apart, and the result says so (together: the names)
function predict(cmp, name, from, to) {
    if (!cmp || !cmp.slopes) return null;
    for (const s of cmp.slopes) {
        if (s.se === null) continue;
        // the value of the primary parameter that a value of `name` stands for (name = intercept + ratio x primary)
        let toPrimary = null, together = s.with.map(w => w.name);
        if (s.name === name) toPrimary = (v) => v;
        else { const w = s.with.find(q => q.name === name); if (w && w.ratio) { toPrimary = (v) => (v - w.intercept) / w.ratio; together = [s.name].concat(together.filter(n => n !== name)); } }
        if (!toPrimary) continue;
        const x0 = toPrimary(from), x1 = toPrimary(to), dx = x1 - x0, eps = 1e-9 * Math.max(1, Math.abs(s.range[0]), Math.abs(s.range[1]));
        return { change: r3(s.slope * dx), se: r3(Math.abs(s.se * dx)), significant: s.significant, inRange: Math.min(x0, x1) >= s.range[0] - eps && Math.max(x0, x1) <= s.range[1] + eps, together, slope: s };
    }
    return null;
}

// ---------------------------------------------------------------------------------------------
// Node: the inputs of datasets() from a log file (headers, PID profile runs, events, flights)
// ---------------------------------------------------------------------------------------------

/**
 * inputsOfFile(file, { app, flightRpm, cli }) -> logs[] for datasets(): decodes every log with lib.segments (whole), finds the
 * flights with health_phase.phases (frame seconds from the time field), the PID profile runs from profileAt, and the
 * INFLIGHT_ADJUSTMENT events. The arming profile is confirmed only by an event at the first frame or by the CLI dump: the
 * header agrees with the CLI section of exactly one candidate (the profile of the first switch is not a candidate) while
 * other sections do not agree (the 'cli' basis of the worker's armingOf). Node only (fs through lib.cjs).
 */
function inputsOfFile(file, opts = {}) {
    const lib = require('./lib.cjs'), phase = require('./health_phase.cjs'), app = opts.app || lib.loadApp();
    const rpm = opts.flightRpm || lib.FLIGHT_RPM, CV = opts.cli ? cliValues(typeof opts.cli === 'string' ? parseCli(opts.cli) : opts.cli) : null;
    const ADJ = app.FlightLogEvent ? app.FlightLogEvent.INFLIGHT_ADJUSTMENT : 13, Log = app.FlightLog, events = new Map();
    let current = null;
    app.FlightLog = function (data) {
        const log = new Log(data), get = log.getChunksInTimeRange, open = log.openLog;
        log.openLog = function (i) { current = i; return open.apply(this, arguments); };
        log.getChunksInTimeRange = function () {
            const chunks = get.apply(this, arguments), t0 = this.getMinTime(), list = events.get(current) || events.set(current, new Map()).get(current);
            for (const c of chunks || []) for (const e of c.events || []) if (e.event === ADJ && e.data && typeof e.time === 'number') list.set(`${e.time}|${e.data.func}|${e.data.value}`, { t: (e.time - t0) / 1e6, func: e.data.func, value: e.data.value });
            return chunks; };
        return log; };
    const logs = new Map();
    try {
        for (const w of lib.segments(app, file, { whole: true, extra: [...new Set(['time'].concat(phase.EXTRA || []))] })) {
            if (w.skipped) continue;
            const li = w.flight.log, L = logs.get(li) || logs.set(li, { log: li, header: w.flight.header, profileRuns: [], flights: [], phased: true, durationS: w.flight.durationS, rawStart: null }).get(li);
            const T = w.extra && w.extra.time, at = (i) => T ? w.fromS + (T[Math.min(w.n - 1, i)] - T[0]) / 1e6 + (i >= w.n ? 1 / w.rate : 0) : w.fromS + i / w.rate;
            if (L.rawStart === null) { L.rawStart = w.profileAt[0];
                const target = w.extra && w.extra.govTarget; // the toolkit's guess for the stretch before the first switch (lib.profilesOf): an estimate only
                if (!L.rawStart && target) try { const g = lib.profilesOf(w, target, rpm).p[0]; L.estimate = g > 0 ? g : 0; } catch (e) { L.estimate = 0; } }
            for (let i = 0; i < w.n;) { let j = i + 1; while (j < w.n && w.profileAt[j] === w.profileAt[i]) j++; L.profileRuns.push({ t0: t3(at(i)), t1: t3(at(j)), profile: w.profileAt[i] }); i = j; }
            try {
                const P = phase.phases(w, { rate: w.flight.actualRate || w.rate, govState: w.govStateAt || null, flightRule: { headspeed: rpm }, airborneEvents: w.airborneAt.some(v => !v) });
                for (const f of P.flights || []) L.flights.push({ t0: t3(at(f.i0)), t1: t3(at(f.i1)), seconds: f.seconds });
            } catch (e) { L.phased = false; L.flights = null; }
        }
    } finally { app.FlightLog = Log; }
    const out = [];
    for (const L of logs.values()) {
        const ev = [...(events.get(L.log) || new Map()).values()].sort((a, b) => a.t - b.t);
        const pidEv = ev.filter(e => e.func === 2);
        let arming = L.rawStart > 0 ? L.rawStart : 0, basis = arming ? 'event' : null;
        if (!arming && CV && Object.keys(CV.profiles).length) {
            const hv = headerValues(L.header).values, agree = Object.keys(CV.profiles).map(Number).filter(p => fitOf(hv, CV, p).mismatches.filter(m => scopeOf(m.name) === 'profile').length === 0);
            const cands = [1, 2, 3, 4, 5, 6].filter(p => !pidEv.length || p !== pidEv[0].value).filter(p => agree.includes(p));
            if (agree.length < Object.keys(CV.profiles).length && cands.length === 1) { arming = cands[0]; basis = 'cli'; }
        }
        // a bench run gets no arming estimate (the worker's armingOf does not run for bench runs)
        const bench = Array.isArray(L.flights) && L.flights.length === 0;
        out.push({ log: L.log, header: L.header, armingProfile: arming, armingBasis: basis, armingEstimate: arming || bench ? 0 : (L.estimate || 0), profileRuns: L.profileRuns.map(q => ({ t0: q.t0, t1: q.t1, profile: q.profile > 0 ? q.profile : arming })),
            rateChanges: ev.filter(e => e.func === 1).map(e => ({ t: t3(e.t), profile: e.value })), adjustments: ev.filter(e => e.func !== 1 && e.func !== 2).map(e => ({ t: t3(e.t), func: e.func, value: e.value })),
            flights: L.flights, durationS: L.durationS });
    }
    return out.sort((a, b) => a.log - b.log);
}

// A text report of datasets() for the command line (not app text)
function reportText(ds, logBase = 1) {
    const N = (l) => l + logBase, lines = [];
    lines.push(`Datasets: ${ds.datasets.length}; bench runs: ${ds.benchRuns.length ? ds.benchRuns.map(N).join(', ') : 'none'}; newest: ${ds.newest}`);
    lines.push(`Flight logs: ${ds.logs.filter(l => !l.bench).map(l => `${N(l.log)} (arming ${l.armingProfile || 'unknown'}${l.armingEstimate ? ', estimate ' + l.armingEstimate : ''}${l.cli.used ? `, CLI ${l.cli.fits ? 'agrees' : `does not agree (${l.cli.mismatches.map(m => `${m.name} ${m.header}/${m.cli}`).join(', ')})`}` : ''})`).join('; ')}`);
    for (const d of ds.datasets) lines.push(`  ${d.id}: ${d.pidProfile ? 'PID profile ' + d.pidProfile : 'PID profile unknown'}, logs ${d.logs.map(N).join(', ')}, ${d.seconds} s (${d.flightSeconds} s of flight), flights ${d.flights.map(f => `${N(f.log)}#${f.flight + 1} ${f.seconds} s`).join(', ') || 'none'}${d.assumed ? ', ASSUMED' : d.assumedSeconds ? `, ${d.assumedSeconds} s assumed` : ''}${d.unknown.length ? `, ${d.unknown.length} values unknown` : ''}${d.sameValuesAs.length ? `, same known values as ${d.sameValuesAs.join(', ')}` : ''}`);
    lines.push('Labels:');
    for (const l of ds.labels) lines.push(`  log ${N(l.log)} ${l.t0}-${l.t1} s: ${l.dataset} (${l.pidProfile ? 'PID profile ' + l.pidProfile : 'unknown'}${l.assumed ? ', assumed, profile values from ' + l.source.profile : ''}) ${l.flightSeconds} s of flight`);
    lines.push(`Parameters that are not the same (${ds.diff.length}):`);
    for (const r of ds.diff) lines.push(`  ${r.name} [${r.group}]: ${ds.datasets.map(d => `${d.id}=${r.values[d.id] === null ? '?' : r.values[d.id]}`).join(' ')}${r.samePidProfile ? '  (same PID profile)' : ''}`);
    lines.push(`Information (values that do not change the flight, ${ds.info.length}):`);
    for (const r of ds.info) lines.push(`  ${r.name} [${r.group}]: ${r.values.map(v => `${JSON.stringify(v.value)} in logs ${v.logs.map(N).join(',')}`).join(' | ')}`);
    if (ds.unknownNames.length) lines.push(`Unknown names: ${ds.unknownNames.map(u => `${u.name} (logs ${u.logs.map(N).join(',')})`).join(', ')}`);
    lines.push('Notes:'); for (const n of ds.notes) lines.push(`  ${n}`);
    return lines.join('\n');
}

module.exports = { RULES, GROUPS, UNKNOWN, FEATURES, HEADER, ENUMS, DEFAULTS, ADJUST, PROFILE_NAMES, RATE_NAMES, classify, groupOf, scopeOf, isFlight, nameOrder, differ, table, groups,
    headerValues, parseCli, cliValues, fitOf, datasets, labelArray, datasetAt, profileMap, compare, resultsOf, predict, idOf, inputsOfFile, reportText };
if (require.main !== module) return;

// node tools/autotune/datasets.cjs <log file> [--cli <dump>] [--rpm <flight rpm>] [--json <out.json>] [--base 0|1] [--estimates]
const fs = require('node:fs'), args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
const estimates = args.includes('--estimates'); if (estimates) args.splice(args.indexOf('--estimates'), 1);
const cliFile = opt('--cli'), rpm = opt('--rpm'), json = opt('--json'), base = opt('--base'), file = args[0];
if (!file) { console.error('usage: node datasets.cjs <log file> [--cli <dump>] [--rpm <flight rpm>] [--json <out.json>] [--base 0|1] [--estimates]'); process.exit(2); }
const cliText = cliFile ? fs.readFileSync(cliFile, 'utf8') : null, t0 = Date.now();
const logs = inputsOfFile(file, { cli: cliText, flightRpm: rpm ? +rpm : null });
const ds = datasets(logs, cliText, { logBase: base === null ? 1 : +base, useEstimates: estimates });
if (json) fs.writeFileSync(json, JSON.stringify({ file, logs: logs.map(l => Object.assign({}, l, { header: undefined })), ds }, null, 1));
console.log(reportText(ds, base === null ? 1 : +base));
console.error(`${((Date.now() - t0) / 1000).toFixed(1)} s`);
