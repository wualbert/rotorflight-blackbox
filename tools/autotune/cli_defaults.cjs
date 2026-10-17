'use strict';

/**
 * The default values of the CLI settings of a firmware build: the values that a `diff all` of that build leaves out
 * (cli/cli.c prints only the values that are not the default). D4 (health_setup.cjs) compares the parameter snapshot of a log
 * with a CLI dump: a name that a diff does not list has its default value there.
 *
 *   const CD = require('./cli_defaults.cjs');
 *   const t = CD.forRevision(dumpText);   // the whole dump: its "# Rotorflight ... (85d7049a9)" line and its "board_name" line
 *   // null for another build or another board, or without a "board_name" line; else { revision, version, board, global: { name:
 *   // text }, profile, rateprofile, features: { NAME: bool } }
 *
 * Each table comes from a `dump all` and a `diff all` of the same session: a name of the dump that the diff does not list has
 * its default value. Only the names of the parameter groups that the parameter snapshot records (param_semantics.cjs NAMES,
 * and the PID profile and rate profile names) are kept. Some defaults are of the board (the target of the build):
 * MATEKG474HELI for both tables. The 4.6.0 table is also the table of 874f369d5 and 118e912 (git diff of src/main/pg and
 * src/main/cli/settings.c: only the setting blackbox_params).
 *
 *   node tools/autotune/cli_defaults.cjs <dump all> <diff all> [<dump all> <diff all> ...]   # the table of one build (JavaScript)
 *
 * Worker-loadable (js/tuning_worker.js CommonJS shim): no Node API at module load.
 */

const TABLES = {
    // analysis/fireball-pr-bench-20261013/postrestore-persistent and analysis/fireball-46-flash-20261015/preflash: dump-all.txt, diff-all.txt
    '85d7049a9': {
        revision: '85d7049a9', board: 'MATEKG474HELI', version: "# Rotorflight / STM32G47X (SG47) 4.7.0-bbp-pr Oct 14 2026 / 05:24:53 (85d7049a9) MSP API: 12.10",
        global: {
            gyro_hardware_lpf: "NORMAL", gyro_overflow_detect: "ALL", gyro_rate_sync: "ON", gyro_calib_duration: "125",
            gyro_calib_noise_limit: "48", gyro_decimation_hz: "500", gyro_lpf1_dyn_min_hz: "0", gyro_lpf1_dyn_max_hz: "0",
            gyro_lpf2_type: "NONE", gyro_lpf2_static_hz: "50", gyro_notch1_hz: "0", gyro_notch1_cutoff: "0", gyro_notch2_hz: "0",
            gyro_notch2_cutoff: "0", dyn_notch_count: "6", dyn_notch_q: "25", dyn_notch_min_hz: "20", dyn_notch_max_hz: "240",
            acc_hardware: "AUTO", acc_lpf_hz: "10", acc_trim_pitch: "0", acc_trim_roll: "0", rx_pulse_min: "885",
            rx_pulse_max: "2115", rssi_channel: "0", rssi_src_frame_errors: "OFF", rssi_scale: "100", rssi_offset: "0",
            rssi_invert: "OFF", rssi_src_frame_lpf_period: "30", serialrx_provider: "CRSF", serialrx_inverted: "OFF",
            serialrx_halfduplex: "OFF", serialrx_pinswap: "OFF", spektrum_sat_bind: "0", spektrum_sat_bind_autoreset: "ON",
            srxl2_unit_id: "1", srxl2_baud_fast: "ON", sbus_baud_fast: "OFF", crsf_use_rx_snr: "OFF", freq_input_pull: "PULLUP",
            freq_input_edge: "FALLING", freq_input_minhz: "25", blackbox_mode: "ARMED", blackbox_device: "SPIFLASH",
            blackbox_log_command: "ON", blackbox_log_setpoint: "ON", blackbox_log_mixer: "ON", blackbox_log_pid: "ON",
            blackbox_log_attitude: "ON", blackbox_log_gyro_raw: "ON", blackbox_log_gyro: "ON", blackbox_log_acc: "OFF",
            blackbox_log_mag: "OFF", blackbox_log_alt: "ON", blackbox_log_gps: "OFF", blackbox_log_battery: "ON",
            blackbox_log_motors: "ON", blackbox_log_servos: "ON", blackbox_log_rpm: "ON", blackbox_log_rssi: "ON",
            blackbox_log_vbec: "ON", blackbox_log_vbus: "ON", blackbox_log_temp: "ON", blackbox_log_esc: "OFF",
            blackbox_log_bec: "OFF", blackbox_log_esc2: "OFF", blackbox_log_governor: "ON", blackbox_initial_erase_kb: "0",
            blackbox_rolling_erase: "ON", blackbox_grace_period: "5", blackbox_params: "FULL", min_command: "1000",
            dshot_burst: "OFF", dshot_bidir: "OFF", dshot_bitbang: "OFF", dshot_bitbang_timer: "AUTO", motor_pwm_protocol: "PWM",
            motor_pwm_rate: "250", motor_control_mode: "0,0,0,0", motor_rpm_lpf: "100,100,100,100", motor_rpm_factor: "0,0,0,0",
            main_rotor_gear_ratio: "1,1", failsafe_delay: "15", failsafe_off_delay: "10", failsafe_throttle: "1000",
            failsafe_switch_mode: "STAGE1", failsafe_throttle_low_delay: "100", failsafe_procedure: "DROP",
            failsafe_recovery_delay: "10", failsafe_stick_threshold: "30", align_board_roll: "0", align_board_pitch: "0",
            bat_profile: "0", bat_capacity: "0,0,0,0,0,0", vbat_max_cell_voltage: "430,430,430,430,430,430",
            vbat_full_cell_voltage: "410,410,410,410,410,410", vbat_min_cell_voltage: "330,330,330,330,330,330",
            vbat_warning_cell_voltage: "350,350,350,350,350,350", vbat_hysteresis: "1", vbat_detect_cell_voltage: "300",
            use_vbat_alerts: "ON", use_cbat_alerts: "OFF", cbat_alert_percent: "35", vbat_cutoff_percent: "100",
            battery_cell_count: "0,0,0,0,0,0", vbat_lpf_hz: "10", ibat_lpf_hz: "10", vbat_duration_for_warning: "0",
            vbat_duration_for_critical: "0", vbat_update_hz: "100", ibat_update_hz: "100", smartfuel: "OFF",
            smartfuel_voltage_drop_rate: "10", smartfuel_charge_drop_rate: "50", smartfuel_sag_gain: "40", vbat_scale: "110",
            vbat_divider: "10", vbat_multiplier: "1", vbat_cutoff: "25", vbec_scale: "110", vbec_divider: "10",
            vbec_multiplier: "1", vbec_cutoff: "25", vbus_scale: "110", vbus_divider: "10", vbus_multiplier: "1", vbus_cutoff: "25",
            vext_scale: "110", vext_divider: "10", vext_multiplier: "1", vext_cutoff: "25", ibata_scale: "400", ibata_offset: "0",
            ibata_cutoff: "25", main_rotor_dir: "CW", tail_rotor_mode: "VARIABLE", tail_motor_idle: "0", swash_type: "CP120",
            swash_ring: "100", swash_phase: "0", swash_roll_trim: "0", swash_pitch_trim: "0", swash_tta_precomp: "0",
            gov_tracking_time: "50", gov_throttle_hold_timeout: "50", gov_autorotation_timeout: "15", gov_handover_throttle: "25",
            gov_idle_throttle: "0", gov_auto_throttle: "0", gov_bypass_throttle: "0,0,0,0,0,0,0,0,0", gov_pwr_filter: "5",
            gov_rpm_filter: "10", gov_tta_filter: "0", gov_ff_filter: "5", gov_d_filter: "50", imu_dcm_kp: "2500", imu_dcm_ki: "0",
            auto_disarm_delay: "5", gyro_cal_on_first_arm: "OFF", pwr_on_arm_grace: "3", enable_stick_arming: "OFF",
            enable_stick_commands: "OFF", wiggle_strength: "50", wiggle_frequency: "10", wiggle_enable_ready: "ON",
            wiggle_enable_armed: "OFF", wiggle_enable_error: "ON", wiggle_enable_fatal: "ON", rc_center: "1500",
            rc_deflection: "510", rc_min_throttle: "0", rc_max_throttle: "0", rc_smoothness: "50", rc_threshold: "25,25,25,100",
            airborne_mode: "CONSERVATIVE", airborne_gyro_threshold: "10", airborne_acc_threshold: "15", deadband: "5",
            yaw_deadband: "5", filter_process_denom: "0", system_hse_mhz: "8", task_statistics: "ON", debug_mode: "NONE",
            debug_axis: "0", cpu_overclock: "OFF", esc_sensor_halfduplex: "OFF", esc_sensor_pinswap: "OFF",
            esc_sensor_update_hz: "100", esc_sensor_current_offset: "0", esc_sensor_filter_cutoff: "0",
            esc_sensor_voltage_correction: "0", esc_sensor_current_correction: "0", esc_sensor_consumption_correction: "0",
            gyro_1_bustype: "SPI", gyro_1_spibus: "1", gyro_1_i2cBus: "0", gyro_1_i2c_address: "0",
            gyro_1_sensor_align: "CW180FLIP", gyro_1_align_roll: "0", gyro_rpm_notch_min_hz: "20",
            gyro_rpm_notch_center_pitch: "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0",
            gyro_rpm_notch_center_roll: "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0",
            gyro_rpm_notch_center_yaw: "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0", position_alt_source: "DEFAULT",
            position_baro_alt_lpf: "100", position_baro_offset_lpf: "5", position_gps_alt_lpf: "25", position_gps_offset_lpf: "5",
            position_gps_min_sats: "12", position_vario_lpf: "50",
        },
        profile: {
            profile_name: "-", pid_mode: "3", pitch_i_gain: "100", pitch_f_gain: "100", roll_p_gain: "50", roll_i_gain: "100",
            roll_f_gain: "100", yaw_i_gain: "120", yaw_ccw_stop_gain: "80", yaw_precomp_cutoff: "5", yaw_cyclic_ff_gain: "10",
            yaw_inertia_precomp_gain: "0", yaw_inertia_precomp_cutoff: "25", pitch_collective_ff_gain: "0",
            cyclic_cross_coupling_ratio: "0", error_decay_time_ground: "25", error_decay_time_yaw: "0",
            error_decay_limit_cyclic: "12", error_decay_limit_yaw: "0", offset_flood_relax_level: "40",
            offset_flood_relax_cutoff: "3", iterm_relax_type: "RPY", angle_level_strength: "40", angle_level_limit: "55",
            horizon_level_strength: "40", horizon_transition: "75", horizon_tilt_effect: "75", horizon_tilt_expert_mode: "OFF",
            acro_trainer_angle_limit: "20", acro_trainer_lookahead_ms: "50", acro_trainer_gain: "75", rescue_flip: "ON",
            rescue_flip_gain: "200", rescue_level_gain: "100", rescue_pull_up_time: "3", rescue_climb_time: "10",
            rescue_flip_time: "20", rescue_exit_time: "5", rescue_pull_up_collective: "650", rescue_climb_collective: "450",
            rescue_hover_collective: "350", rescue_hover_altitude: "500", rescue_alt_p_gain: "20", rescue_alt_i_gain: "20",
            rescue_alt_d_gain: "10", rescue_max_sp_rate: "300", rescue_max_sp_accel: "3000", rescue_max_collective: "500",
            gov_use_fallback_precomp: "OFF", gov_use_pid_spoolup: "OFF", gov_use_voltage_comp: "OFF",
            gov_use_dyn_min_throttle: "OFF", gov_i_limit: "95", gov_tta_gain: "0", gov_tta_limit: "20", gov_max_throttle: "100",
            gov_min_throttle: "10", gov_fallback_drop: "10", gov_collective_curve: "20", gov_dyn_min_throttle: "80",
            yaw_d_gain: "10", pitch_p_gain: "50", pitch_d_gain: "40", pitch_b_gain: "0", pitch_o_gain: "50", roll_d_gain: "0",
            roll_b_gain: "0", roll_o_gain: "50", yaw_p_gain: "80", yaw_b_gain: "0", yaw_f_gain: "0", pitch_d_cutoff: "15",
            pitch_b_cutoff: "15", pitch_gyro_cutoff: "50", roll_d_cutoff: "15", roll_b_cutoff: "15", roll_gyro_cutoff: "50",
            yaw_d_cutoff: "20", yaw_b_cutoff: "20", yaw_gyro_cutoff: "100", yaw_cw_stop_gain: "120", yaw_collective_ff_gain: "60",
            cyclic_cross_coupling_gain: "50", cyclic_cross_coupling_cutoff: "25", error_limit: "45,45,60", offset_limit: "90,90",
            error_decay_time_cyclic: "250", iterm_relax_level: "40,40,40", iterm_relax_cutoff: "10,10,10", rescue_mode: "OFF",
            gov_headspeed: "1000", gov_gain: "40", gov_p_gain: "40", gov_i_gain: "50", gov_d_gain: "0", gov_f_gain: "10",
            gov_p_limit: "20", gov_d_limit: "20", gov_f_limit: "100", gov_yaw_ff_weight: "10", gov_cyclic_ff_weight: "10",
            gov_collective_ff_weight: "50",
        },
        rateprofile: {
            rateprofile_name: "-", rates_type: "ROTORFLIGHT", roll_rc_rate: "50", pitch_rc_rate: "50", yaw_rc_rate: "80",
            collective_rc_rate: "100", collective_expo: "0", roll_srate: "12", pitch_srate: "12", yaw_srate: "12",
            collective_srate: "12", roll_accel_limit: "0", pitch_accel_limit: "0", yaw_accel_limit: "0",
            collective_accel_limit: "0", roll_level_expo: "0", pitch_level_expo: "0", roll_response: "0", pitch_response: "0",
            yaw_response: "0", collective_response: "0", cyclic_ring: "150", cyclic_polar: "OFF",
            setpoint_boost_cutoff: "15,15,90,15", yaw_dynamic_deadband_filter: "60", yaw_dynamic_deadband_cutoff: "50",
            roll_expo: "40", pitch_expo: "40", yaw_expo: "50", setpoint_boost_gain: "0,0,0,0", yaw_dynamic_ceiling_gain: "0",
            yaw_dynamic_deadband_gain: "10",
        },
        features: {
            RX_PPM: false, RX_SERIAL: true, SOFTSERIAL: false, GPS: false, RANGEFINDER: false, TELEMETRY: true,
            RX_PARALLEL_PWM: false, RX_MSP: false, RSSI_ADC: false, LED_STRIP: false, DASHBOARD: false, OSD: false, CMS: false,
            RX_SPI: false, GOVERNOR: false, ESC_SENSOR: false, FREQ_SENSOR: false, DYN_NOTCH: true, RPM_FILTER: false,
        },
    },
    // analysis/fireball-46-flash-20261015/postrestore (58a4bd5cc) and analysis/fireball-bench-20261013/candidate-off/after-run
    // (874f369d5): dump-all.txt, diff-all.txt
    '58a4bd5cc': {
        revision: '58a4bd5cc', board: 'MATEKG474HELI', version: "# Rotorflight / STM32G47X (SG47) 4.6.0-bbp Oct 15 2026 / 14:49:56 (58a4bd5cc) MSP API: 12.9",
        global: {
            gyro_hardware_lpf: "NORMAL", gyro_overflow_detect: "ALL", gyro_rate_sync: "ON", gyro_calib_duration: "125",
            gyro_calib_noise_limit: "48", gyro_decimation_hz: "500", gyro_lpf1_dyn_min_hz: "0", gyro_lpf1_dyn_max_hz: "0",
            gyro_lpf2_type: "NONE", gyro_lpf2_static_hz: "50", gyro_notch1_hz: "0", gyro_notch1_cutoff: "0", gyro_notch2_hz: "0",
            gyro_notch2_cutoff: "0", acc_hardware: "AUTO", acc_lpf_hz: "10", acc_trim_pitch: "0", acc_trim_roll: "0",
            rx_pulse_min: "885", rx_pulse_max: "2115", rssi_channel: "0", rssi_src_frame_errors: "OFF", rssi_scale: "100",
            rssi_offset: "0", rssi_invert: "OFF", rssi_src_frame_lpf_period: "30", serialrx_provider: "CRSF",
            serialrx_inverted: "OFF", serialrx_halfduplex: "OFF", serialrx_pinswap: "OFF", spektrum_sat_bind: "0",
            spektrum_sat_bind_autoreset: "ON", srxl2_unit_id: "1", srxl2_baud_fast: "ON", sbus_baud_fast: "OFF",
            crsf_use_rx_snr: "OFF", freq_input_pull: "PULLUP", freq_input_edge: "FALLING", freq_input_minhz: "25",
            blackbox_mode: "ARMED", blackbox_device: "SPIFLASH", blackbox_log_command: "ON", blackbox_log_setpoint: "ON",
            blackbox_log_mixer: "ON", blackbox_log_pid: "ON", blackbox_log_attitude: "ON", blackbox_log_gyro_raw: "ON",
            blackbox_log_gyro: "ON", blackbox_log_acc: "OFF", blackbox_log_mag: "OFF", blackbox_log_alt: "ON",
            blackbox_log_gps: "OFF", blackbox_log_battery: "ON", blackbox_log_motors: "ON", blackbox_log_servos: "ON",
            blackbox_log_rpm: "ON", blackbox_log_rssi: "ON", blackbox_log_vbec: "ON", blackbox_log_vbus: "ON",
            blackbox_log_temp: "ON", blackbox_log_bec: "OFF", blackbox_log_esc2: "OFF", blackbox_log_governor: "ON",
            blackbox_initial_erase_kb: "0", blackbox_rolling_erase: "ON", blackbox_grace_period: "5", blackbox_params: "FULL",
            min_command: "1000", dshot_burst: "OFF", dshot_bidir: "OFF", dshot_bitbang: "OFF", dshot_bitbang_timer: "AUTO",
            motor_pwm_protocol: "PWM", motor_pwm_rate: "250", motor_control_mode: "0,0,0,0", motor_rpm_lpf: "100,100,100,100",
            motor_rpm_factor: "0,0,0,0", main_rotor_gear_ratio: "1,1", failsafe_delay: "15", failsafe_off_delay: "10",
            failsafe_throttle: "1000", failsafe_switch_mode: "STAGE1", failsafe_throttle_low_delay: "100",
            failsafe_procedure: "DROP", failsafe_recovery_delay: "10", failsafe_stick_threshold: "30", align_board_roll: "0",
            align_board_pitch: "0", bat_profile: "0", bat_capacity: "0,0,0,0,0,0", vbat_max_cell_voltage: "430",
            vbat_full_cell_voltage: "410", vbat_min_cell_voltage: "330", vbat_warning_cell_voltage: "350", vbat_hysteresis: "1",
            vbat_detect_cell_voltage: "300", use_vbat_alerts: "ON", use_cbat_alerts: "OFF", cbat_alert_percent: "35",
            vbat_cutoff_percent: "100", battery_cell_count: "0", vbat_lpf_hz: "10", ibat_lpf_hz: "10",
            vbat_duration_for_warning: "0", vbat_duration_for_critical: "0", vbat_update_hz: "100", ibat_update_hz: "100",
            smartfuel: "OFF", smartfuel_voltage_drop_rate: "10", smartfuel_charge_drop_rate: "50", smartfuel_sag_gain: "40",
            vbat_scale: "110", vbat_divider: "10", vbat_multiplier: "1", vbat_cutoff: "25", vbec_scale: "110", vbec_divider: "10",
            vbec_multiplier: "1", vbec_cutoff: "25", vbus_scale: "110", vbus_divider: "10", vbus_multiplier: "1", vbus_cutoff: "25",
            vext_scale: "110", vext_divider: "10", vext_multiplier: "1", vext_cutoff: "25", ibata_scale: "400", ibata_offset: "0",
            ibata_cutoff: "25", main_rotor_dir: "CW", tail_rotor_mode: "VARIABLE", tail_motor_idle: "0", swash_type: "CP120",
            swash_ring: "100", swash_phase: "0", swash_roll_trim: "0", swash_pitch_trim: "0", swash_tta_precomp: "0",
            gov_tracking_time: "50", gov_throttle_hold_timeout: "50", gov_autorotation_timeout: "15", gov_handover_throttle: "25",
            gov_idle_throttle: "0", gov_auto_throttle: "0", gov_bypass_throttle: "0,0,0,0,0,0,0,0,0", gov_pwr_filter: "5",
            gov_rpm_filter: "10", gov_tta_filter: "0", gov_ff_filter: "5", gov_d_filter: "50", imu_dcm_kp: "2500", imu_dcm_ki: "0",
            auto_disarm_delay: "5", gyro_cal_on_first_arm: "OFF", pwr_on_arm_grace: "3", enable_stick_arming: "OFF",
            enable_stick_commands: "OFF", wiggle_strength: "50", wiggle_frequency: "10", wiggle_enable_ready: "ON",
            wiggle_enable_armed: "OFF", wiggle_enable_error: "ON", wiggle_enable_fatal: "ON", rc_center: "1500",
            rc_deflection: "510", rc_min_throttle: "0", rc_max_throttle: "0", rc_smoothness: "50", rc_threshold: "25,25,25,100",
            deadband: "5", yaw_deadband: "5", filter_process_denom: "0", system_hse_mhz: "8", task_statistics: "ON",
            debug_axis: "0", cpu_overclock: "OFF", esc_sensor_halfduplex: "OFF", esc_sensor_pinswap: "OFF",
            esc_sensor_update_hz: "100", esc_sensor_current_offset: "0", esc_sensor_filter_cutoff: "0",
            esc_sensor_voltage_correction: "0", esc_sensor_current_correction: "0", esc_sensor_consumption_correction: "0",
            gyro_1_bustype: "SPI", gyro_1_spibus: "1", gyro_1_i2cBus: "0", gyro_1_i2c_address: "0",
            gyro_1_sensor_align: "CW180FLIP", gyro_1_align_roll: "0", gyro_rpm_notch_min_hz: "20",
            gyro_rpm_notch_center_pitch: "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0",
            gyro_rpm_notch_center_roll: "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0",
            gyro_rpm_notch_center_yaw: "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0", position_alt_source: "DEFAULT",
            position_baro_alt_lpf: "100", position_baro_offset_lpf: "5", position_gps_alt_lpf: "25", position_gps_offset_lpf: "5",
            position_gps_min_sats: "12", position_vario_lpf: "50", dyn_notch_count: "6", dyn_notch_q: "25", dyn_notch_min_hz: "20",
            dyn_notch_max_hz: "240", blackbox_log_esc: "OFF", debug_mode: "NONE",
        },
        profile: {
            profile_name: "-", pid_mode: "3", pitch_i_gain: "100", pitch_f_gain: "100", roll_p_gain: "50", roll_i_gain: "100",
            roll_f_gain: "100", yaw_i_gain: "120", yaw_ccw_stop_gain: "80", yaw_precomp_cutoff: "5", yaw_cyclic_ff_gain: "10",
            yaw_inertia_precomp_gain: "0", yaw_inertia_precomp_cutoff: "25", pitch_collective_ff_gain: "0",
            cyclic_cross_coupling_ratio: "0", error_decay_time_ground: "25", error_decay_time_yaw: "0",
            error_decay_limit_cyclic: "12", error_decay_limit_yaw: "0", offset_flood_relax_level: "40",
            offset_flood_relax_cutoff: "3", iterm_relax_type: "RPY", angle_level_strength: "40", angle_level_limit: "55",
            horizon_level_strength: "40", horizon_transition: "75", horizon_tilt_effect: "75", horizon_tilt_expert_mode: "OFF",
            acro_trainer_angle_limit: "20", acro_trainer_lookahead_ms: "50", acro_trainer_gain: "75", rescue_flip: "ON",
            rescue_flip_gain: "200", rescue_level_gain: "100", rescue_pull_up_time: "3", rescue_climb_time: "10",
            rescue_flip_time: "20", rescue_exit_time: "5", rescue_pull_up_collective: "650", rescue_climb_collective: "450",
            rescue_hover_collective: "350", rescue_hover_altitude: "500", rescue_alt_p_gain: "20", rescue_alt_i_gain: "20",
            rescue_alt_d_gain: "10", rescue_max_sp_rate: "300", rescue_max_sp_accel: "3000", rescue_max_collective: "500",
            gov_use_fallback_precomp: "OFF", gov_use_pid_spoolup: "OFF", gov_use_voltage_comp: "OFF",
            gov_use_dyn_min_throttle: "OFF", gov_i_limit: "95", gov_tta_gain: "0", gov_tta_limit: "20", gov_max_throttle: "100",
            gov_min_throttle: "10", gov_fallback_drop: "10", gov_collective_curve: "20", gov_dyn_min_throttle: "80",
            yaw_d_gain: "10", pitch_p_gain: "50", pitch_d_gain: "40", pitch_b_gain: "0", pitch_o_gain: "50", roll_d_gain: "0",
            roll_b_gain: "0", roll_o_gain: "50", yaw_p_gain: "80", yaw_b_gain: "0", yaw_f_gain: "0", pitch_d_cutoff: "15",
            pitch_b_cutoff: "15", pitch_gyro_cutoff: "50", roll_d_cutoff: "15", roll_b_cutoff: "15", roll_gyro_cutoff: "50",
            yaw_d_cutoff: "20", yaw_b_cutoff: "20", yaw_gyro_cutoff: "100", yaw_cw_stop_gain: "120", yaw_collective_ff_gain: "60",
            cyclic_cross_coupling_gain: "50", cyclic_cross_coupling_cutoff: "25", error_limit: "45,45,60", offset_limit: "90,90",
            error_decay_time_cyclic: "250", iterm_relax_level: "40,40,40", iterm_relax_cutoff: "10,10,10", rescue_mode: "OFF",
            gov_headspeed: "1000", gov_gain: "40", gov_p_gain: "40", gov_i_gain: "50", gov_d_gain: "0", gov_f_gain: "10",
            gov_p_limit: "20", gov_d_limit: "20", gov_f_limit: "100", gov_yaw_ff_weight: "10", gov_cyclic_ff_weight: "10",
            gov_collective_ff_weight: "50",
        },
        rateprofile: {
            rateprofile_name: "-", collective_expo: "0", roll_accel_limit: "0", pitch_accel_limit: "0", yaw_accel_limit: "0",
            collective_accel_limit: "0", roll_level_expo: "0", pitch_level_expo: "0", yaw_response: "0", collective_response: "0",
            cyclic_ring: "150", cyclic_polar: "OFF", setpoint_boost_gain: "0,0,0,0", setpoint_boost_cutoff: "15,15,90,15",
            yaw_dynamic_ceiling_gain: "0", yaw_dynamic_deadband_filter: "60", yaw_dynamic_deadband_cutoff: "50",
            rates_type: "ROTORFLIGHT", roll_rc_rate: "50", pitch_rc_rate: "50", yaw_rc_rate: "80", collective_rc_rate: "100",
            roll_expo: "40", pitch_expo: "40", yaw_expo: "50", roll_srate: "12", pitch_srate: "12", yaw_srate: "12",
            collective_srate: "12", roll_response: "0", pitch_response: "0", yaw_dynamic_deadband_gain: "10",
        },
        features: {
            RX_PPM: false, RX_SERIAL: true, SOFTSERIAL: false, GPS: false, RANGEFINDER: false, TELEMETRY: true,
            RX_PARALLEL_PWM: false, RX_MSP: false, RSSI_ADC: false, LED_STRIP: false, DASHBOARD: false, OSD: false, CMS: false,
            RX_SPI: false, GOVERNOR: false, ESC_SENSOR: false, FREQ_SENSOR: false, DYN_NOTCH: true, RPM_FILTER: false,
        },
    },
};
const ALIASES = { '874f369d5': '58a4bd5cc', '118e912': '58a4bd5cc' };

// the build of a CLI dump (its "# Rotorflight ... (hash)" line) or of a log ("Rotorflight 4.7.0-bbp-pr (85d7049a9) STM32G47X")
function revisionOf(text) {
    const line = String(text || '').split(/\r?\n/).find(l => /Rotorflight/.test(l)) || '', m = /\(([0-9a-f]{7,40})\)/.exec(line);
    return m ? m[1] : null;
}
// the board of a CLI dump: its "board_name" line (cli.c printBoardName), else its "# board: " line; null without one
function boardOf(text) {
    const m = /^\s*board_name\s+(\S+)/m.exec(String(text || '')) || /^\s*#\s*board:\s*(\S+)/m.exec(String(text || ''));
    return m ? m[1].trim().toUpperCase() : null;
}
// The table of the build and the board of a CLI dump (the whole text). Some defaults are of the board (the target): a dump of
// another board, or with no board line, gets no table, and D4 then compares only the values that the dump shows
function forRevision(text) {
    const rev = revisionOf(text), board = boardOf(text);
    if (!rev || !board) return null;
    const ok = (t) => t && String(t.board || '').toUpperCase() === board ? t : null;
    for (const key of Object.keys(TABLES)) if (TABLES[key] && (rev.startsWith(key) || key.startsWith(rev))) return ok(TABLES[key]);
    for (const [alias, key] of Object.entries(ALIASES)) if (TABLES[key] && (rev.startsWith(alias) || alias.startsWith(rev))) return ok(TABLES[key]);
    return null;
}

// the sections of a CLI capture: { global: Map, profile: [Map x6], rateprofile: [Map x6], features: Map(NAME -> bool), version }
function sectionsOf(text) {
    const out = { global: new Map(), profile: [], rateprofile: [], features: new Map(), version: null };
    for (let k = 0; k < 6; k++) { out.profile.push(new Map()); out.rateprofile.push(new Map()); }
    let cur = out.global, m;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!out.version && /^# Rotorflight/.test(line)) out.version = line;
        if ((m = /^profile (\d)$/.exec(line))) { cur = out.profile[+m[1]]; continue; }
        if ((m = /^rateprofile (\d)$/.exec(line))) { cur = out.rateprofile[+m[1]]; continue; }
        if ((m = /^feature (-?)(\w+)$/.exec(line))) { out.features.set(m[2], m[1] !== '-'); continue; }
        // the last section line of a dump selects the PID profile again: a set line comes only after a section line
        if ((m = /^set (\w+)\s*=\s*(.*)$/.exec(line)) && !cur.has(m[1])) cur.set(m[1], m[2].trim());
    }
    return out;
}

/**
 * The defaults of one build from pairs [[dump all, diff all], ...] of the same build and board, each pair of one session.
 * names: the names to keep (null: all). A name gets the value of the dumps (and of the sections of a PID profile or rate
 * profile) whose diff does not list it; a name whose values do not agree is left out.
 */
function fromDumps(pairs, names) {
    const keep = (n) => !names || names.has(n), seen = { global: new Map(), profile: new Map(), rateprofile: new Map(), features: new Map() };
    const add = (kind, n, v) => (seen[kind].get(n) || seen[kind].set(n, new Set()).get(n)).add(v);
    let version = null, board = null;
    for (const [dumpText, diffText] of pairs) {
        const dump = sectionsOf(dumpText), diff = sectionsOf(diffText);
        version = version || dump.version; board = board || boardOf(dumpText);
        for (const [n, v] of dump.global) if (!diff.global.has(n) && keep(n)) add('global', n, v);
        for (const kind of ['profile', 'rateprofile']) dump[kind].forEach((sec, k) => { for (const [n, v] of sec) if (!diff[kind][k].has(n) && keep(n)) add(kind, n, v); });
        // a feature of the dump that the diff does not list is at its default; a feature that the diff lists has the other value
        for (const [n, on] of dump.features) add('features', n, diff.features.has(n) ? !diff.features.get(n) : on);
    }
    const t = { revision: revisionOf(version), board, version, global: {}, profile: {}, rateprofile: {}, features: {} };
    for (const kind of Object.keys(seen)) for (const [n, vals] of seen[kind]) if (vals.size === 1) t[kind][n] = [...vals][0];
    return t;
}

module.exports = { TABLES, ALIASES, revisionOf, boardOf, forRevision, sectionsOf, fromDumps };
if (require.main !== module) return;

const fs = require('node:fs'), PS = require('./param_semantics.cjs');
const files = process.argv.slice(2);
if (!files.length || files.length % 2) { console.error('usage: node tools/autotune/cli_defaults.cjs <dump all> <diff all> [<dump all> <diff all> ...]'); process.exit(1); }
const names = new Set(Object.values(PS.NAMES).flatMap(s => s.split(' ')));
const pairs = []; for (let i = 0; i < files.length; i += 2) pairs.push([fs.readFileSync(files[i], 'utf8'), fs.readFileSync(files[i + 1], 'utf8')]);
const t = fromDumps(pairs, names);
const obj = (o) => { const parts = Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), lines = []; let line = '';
    for (const p of parts) { if (line.length + p.length > 118) { lines.push(line); line = ''; } line += (line ? ' ' : '') + p + ','; }
    if (line) lines.push(line); return '{\n' + lines.map(l => '            ' + l).join('\n') + '\n        }'; };
console.log(`    '${t.revision}': {\n        revision: '${t.revision}', board: '${t.board}', version: ${JSON.stringify(t.version)},\n        global: ${obj(t.global)},\n        profile: ${obj(t.profile)},\n        rateprofile: ${obj(t.rateprofile)},\n        features: ${obj(t.features)},\n    },`);
