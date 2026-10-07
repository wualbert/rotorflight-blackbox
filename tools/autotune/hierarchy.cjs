'use strict';

/**
 * The Rotorflight tuning order (SPEC3 A, B, K1): a band of prerequisites (PREREQ) that the pilot completes before the maiden
 * flight, and the tuning blocks (BLOCKS), each a set of firmware parameters. The checks are the evidence of a prerequisite or
 * of a block, never a step. What links them (EDGES), the consequence rules K1-K27 (RULES) and the status of every item for a
 * set of findings and recommendations (status). One gate table: advice.cjs takes blockedBy from it and the Tuning view draws
 * the same graph (graph()), so the two never disagree.
 *
 *   homeOf(checkId, axis)        the prerequisite or block of a check (or of a recommendation id)
 *   isPrereq(id), isBlock(id)    the kind of an item id
 *   gateUpstream(nodeId)         the items that gate this one, along gate edges, transitive
 *   causesOf(target, findings)   the K rules that make a finding or a recommendation a possible result of upstream flags
 *   status(findings, recs, opts) { nodes: { id: { status, fids, recs, blockedBy, possible, reason, profiles, ... } }, startHere
 *                                (block ids only), prereqProblems (prerequisite ids with a problem), profile, bench, profiles,
 *                                byProfile }: all PID profiles together, and each one alone; opts.profile gives one PID
 *                                profile only. The results of a bench run (D7) do not count
 *   graph()                      { prereq, blocks, edges, rules, nodes }: the diagram (K1); nodes is every item in one list
 *   profileKey(x)                the PID profile of a finding or a recommendation: '1' to '6', '0' (unknown), null (none)
 *   LEGACY                       the item ids of round 1 (setup, servos, ..., result) -> the new id, for code that reads them
 *
 * Prerequisites (SPEC3 A): assumed correct. A prerequisite shows 'problem' only for a clearly measurable issue (a flag of one
 * of its checks that a recommendation gives as an action or a check, D2 and D4 never), else 'ok' ("No problem found", with
 * the checks that operated) or 'noData' (no check could operate: a log cannot show it). Never 'blocked', never "Start here".
 * Its problems gate the blocks that need them (gates), and the blocks show 'blocked'.
 *
 * Blocks (SPEC3 B): filters -> governor -> two lanes: cyclic -> cycomp, tail -> tailcomp. A block is a problem when one of its
 * checks flags and a recommendation on that flag is an action or a check; blocked when a problem lies upstream along gate
 * edges (a prerequisite or a block); possible result when a problem lies upstream along a cause edge or a K rule matches;
 * start here otherwise, numbered in the sequence. The measurements (D-term noise, tracking error, time delay) are evidence in
 * the blocks, never a block. The tail output limits are the tail authority (block tailcomp), never a calibration.
 *
 * Sources: rotorflight.org docs 2.3.0 (rotorflight/rotorflight-docs at 2be449a, read 2026-10-05), Configurator 2.3.0 help
 * texts (MSG), firmware release/4.6.0 settings.c (the parameter names), the Rotorflight 1 wiki (OLDWIKI, outdated). Source
 * codes: DOC, DOC-old, SRC, COM (community) and INF (our inference); page codes as in the research notes (TUNE
 * Tuning-description, FILT First-Flight-Filter-Tuning, GOVT Tune-Governor, MIXS setup-mixer, MIXT the mixer tab, RPMM
 * rpm-measurement, RPMF rpm-filters, PROF the profiles tab, BB the blackbox tab, PROC45 2.2.0 tuning process, ...).
 *
 * Edge kinds: gate (a problem upstream blocks the item), order (do first, shown only), cause (a problem downstream can be a
 * result of the problem upstream; a cause edge can go back in the sequence: the tail authority causes tail gain symptoms),
 * validity (results downstream are not accurate when the `when` check flags). All text that the app shows is ASD-STE100
 * (docs/STE_GLOSSARY.md). Gear ratios (CLAUDE.md): the configured gear ratios are correct. The prerequisite 'rpm' is the RPM
 * signal and the motor pole count (G12), and no text tells that a gear ratio, a pulley or a tooth count can be incorrect.
 */

const DOCS = 'https://rotorflight.org/docs/';
const doc = (title, page) => ({ title, url: DOCS + page });
const P = { configuration: doc('Configuration tab', 'configurator/tabs/configuration'), receiver: doc('Receiver tab', 'configurator/tabs/receiver'),
    example: doc('Example setup', 'examples/example-1'), servoSetup: doc('Servo setup', 'setup/setup-servos'), servos: doc('Servos tab', 'configurator/tabs/servos'),
    mixerSetup: doc('Mixer setup', 'setup/setup-mixer'), mixer: doc('Mixer tab', 'configurator/tabs/mixer'), filterTuning: doc('First flight and filter tuning', 'Tuning/First-Flight-Filter-Tuning'),
    rpmMeasure: doc('RPM measurement', 'setup/rpm-measurement'), motors: doc('Motors tab', 'configurator/tabs/motors'), power: doc('Power tab', 'configurator/tabs/power'),
    blackbox: doc('Blackbox tab', 'configurator/tabs/blackbox'), rpmFilters: doc('RPM filters', 'setup/rpm-filters'), profiles: doc('Profiles tab', 'configurator/tabs/profiles'),
    tuning: doc('Tuning your helicopter', 'Tuning/Tuning-description'), governor: doc('Governor tab', 'configurator/tabs/governor'),
    flyrotor: doc('FlyRotor governor setup', 'setup/governor/governor-flyrotor-setup'), tuneGovernor: doc('Tune the governor', 'Tuning/Tune-Governor'),
    feedforward: doc('Tune feedforward', 'Tuning/Tune-Feedforward'), hsi: doc('High speed integral', 'Tuning/High-Speed-Integral'),
    crossCoupling: doc('Cyclic cross coupling', 'Tuning/Cyclic-Cross-Coupling'), process22: doc('Tuning process (2.2.0)', '2.2.0/testing/tuning-process'),
    tta: doc('Tail torque assist', 'Tuning/Motorised-Tail-and-TTA'), rescue: doc('Rescue mode', 'Tuning/Rescue-mode-settings') };

const fam = (pattern, list) => list.map(v => pattern.replace('*', v)); // CLI name families: gyro_rpm_notch_q_* over the axes
const AX3 = ['roll', 'pitch', 'yaw'];

// The prerequisites (SPEC3 A): checks = their evidence (SETUP rules by their rule name, see homeOf), params = the 4.6 names
// (settings.c) that the pilot sets, gates = the blocks whose results need the item. step 0 and row: the sequence of the band
const PREREQ = [
    { id: 'logging', title: 'Blackbox log', about: 'The log must record the fields that the checks use, at a log rate of 1 kHz or more. Set the blackbox before the first flight.',
        checks: ['D1', 'D2', 'D3', 'D4', 'H'], gates: ['filters', 'governor', 'cyclic', 'tail'],
        params: ['blackbox_device', 'blackbox_rate_denom', 'blackbox_log_gyro_raw', 'blackbox_log_pid', 'blackbox_log_setpoint', 'blackbox_log_mixer', 'blackbox_log_servos', 'blackbox_log_rpm',
            'blackbox_log_governor', 'blackbox_log_battery', 'debug_mode'], docs: [P.blackbox] },
    { id: 'rpm', title: 'RPM signal and motor poles', about: 'The RPM notch filters and the governor use the RPM signal. The gear ratios in the configuration are correct.',
        note: 'The gear ratios in the configuration are correct.', checks: ['G1', 'G12', 'G20'], gates: ['filters', 'governor'],
        params: ['motor_poles', 'feature FREQ_SENSOR', 'dshot_bidir', 'motor_pwm_protocol', 'freq_input_minhz'], docs: [P.rpmMeasure, P.motors] },
    { id: 'power', title: 'Battery and power', about: 'The battery must supply the power of the flight with a small voltage decrease. A weak battery keeps the throttle at its limit.',
        checks: ['D5', 'G13', 'G11', 'P1', 'P2'], gates: ['governor'],
        params: ['battery_cell_count', 'vbat_min_cell_voltage', 'vbat_warning_cell_voltage', 'vbat_max_cell_voltage', 'battery_meter', 'current_meter'], docs: [P.power] },
    { id: 'mechanics', title: 'Mechanical parts', about: 'Balance the rotor, set the blade tracking, calibrate the servos and make sure that no part is loose. Gains cannot correct a mechanical problem.',
        checks: ['F7', 'C15', 'T4', 'SETUP:i_gain'], gates: ['cyclic', 'tail'],
        params: ['servo <n> <mid> <min> <max> <rneg> <rpos> <rate> <speed> <flags>', 'swash_type', 'main_rotor_dir', 'swash_roll_trim', 'swash_pitch_trim', 'swash_collective_trim',
            'swash_geo_correction', 'collective_tilt_correction_pos', 'collective_tilt_correction_neg', 'tail_rotor_mode', 'mixer input SR', 'mixer input SP', 'mixer input SC'],
        docs: [P.servoSetup, P.servos, P.mixerSetup, P.filterTuning] },
    { id: 'rescue', title: 'Rescue', about: 'Turn on the rescue in each PID profile that you fly. Make sure that the rescue switch does not change the PID profile.',
        checks: ['D9', 'D8', 'D6'], gates: [],
        params: fam('rescue_*', ['mode', 'flip', 'pull_up_collective', 'climb_collective', 'hover_collective', 'pull_up_time', 'climb_time', 'level_gain', 'flip_gain', 'max_sp_rate', 'max_sp_accel', 'flip_time', 'exit_time']),
        docs: [P.rescue] },
    { id: 'controller', title: 'Flight controller', about: 'Set the board alignment, the PID mode, the receiver and the rates before the first flight.',
        checks: ['SETUP:pid_mode', 'SETUP:rates_type', 'D7', 'R1', 'L7'], gates: ['cyclic', 'tail'],
        params: ['align_board_roll', 'align_board_pitch', 'align_board_yaw', 'acc_trim_roll', 'acc_trim_pitch', 'pid_mode', 'pid_process_denom', 'rc_center', 'rc_deflection', 'rates_type'],
        docs: [P.configuration, P.receiver, P.example] },
];
PREREQ.forEach((n, i) => Object.assign(n, { kind: 'prereq', step: 0, row: i, lane: 'prereq', order: 0 }));

// The tuning blocks (SPEC3 B): params = the 4.6 names of the block, checks = its evidence, chips = groups of parameters with
// the checks that inform each. order 1..4 and the lane: the documented sequence (step = order, row = the lane)
const GAINS = (ax, list) => list.map(g => `${ax}_${g}_gain`);
const BLOCKS = [
    { id: 'filters', order: 1, lane: 'main', title: 'Filters', about: 'Set the gyro low-pass filters, the RPM notch filters, the dynamic notch filter and the D-term cutoffs. Then less vibration gets to the PID controller.',
        checks: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F8', 'F9', 'F10', 'F11', 'C11'],
        chips: [{ label: 'RPM notch filters', checks: ['F3', 'F5', 'F6', 'F9'] }, { label: 'Low-pass filters', checks: ['F1', 'F2', 'F11'] }, { label: 'Dynamic notch filter', checks: ['F8'] }, { label: 'D-term cutoffs', checks: ['F4', 'C11', 'F10'] }],
        params: ['gyro_lpf1_type', 'gyro_lpf1_static_hz', 'gyro_lpf1_dyn_min_hz', 'gyro_lpf1_dyn_max_hz', 'gyro_lpf2_type', 'gyro_lpf2_static_hz', 'feature RPM_FILTER', 'gyro_rpm_notch_preset', 'gyro_rpm_notch_min_hz']
            .concat(fam('gyro_rpm_notch_source_*', AX3), fam('gyro_rpm_notch_q_*', AX3), fam('gyro_rpm_notch_center_*', AX3),
                ['feature DYN_NOTCH', 'dyn_notch_count', 'dyn_notch_q', 'dyn_notch_min_hz', 'dyn_notch_max_hz', 'gyro_notch1_hz', 'gyro_notch1_cutoff', 'gyro_notch2_hz', 'gyro_notch2_cutoff'],
                fam('*_d_cutoff', AX3), fam('*_gyro_cutoff', AX3), fam('*_b_cutoff', AX3)), docs: [P.rpmFilters, P.filterTuning, P.profiles] },
    { id: 'governor', order: 2, lane: 'main', title: 'Governor', optional: 'Only for the governor modes ELECTRIC and NITRO.',
        about: 'Set the governor mode, the headspeed, the throttle limits and the governor gains. Then the headspeed stays at the target when the load changes.',
        checks: ['G0', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G14', 'G15', 'G16', 'G17', 'G18', 'G19', 'L1'],
        chips: [{ label: 'Mode and limits', checks: ['G0', 'G6', 'G7', 'G8', 'L1'] }, { label: 'Spool-up and changes', checks: ['G14', 'G15', 'G16', 'G17', 'G18', 'G19'] },
            { label: 'F', checks: ['G3', 'G4'] }, { label: 'I', checks: ['G9', 'G2'] }, { label: 'P', checks: ['G9', 'G5'] }, { label: 'D', checks: [] }, { label: 'Gain', checks: ['G10'] }],
        params: ['gov_mode', 'gov_throttle_type', 'gov_headspeed', 'gov_max_throttle', 'gov_min_throttle', 'gov_idle_throttle', 'gov_auto_throttle', 'gov_handover_throttle', 'gov_startup_time',
            'gov_spoolup_time', 'gov_spooldown_time', 'gov_tracking_time', 'gov_recovery_time', 'gov_autorotation_timeout', 'gov_throttle_hold_timeout', 'gov_use_voltage_comp', 'gov_use_pid_spoolup',
            'gov_use_fallback_precomp', 'gov_fallback_drop', 'gov_f_gain', 'gov_i_gain', 'gov_p_gain', 'gov_d_gain', 'gov_gain', 'gov_collective_ff_weight', 'gov_cyclic_ff_weight', 'gov_yaw_ff_weight',
            'gov_collective_curve', 'gov_p_limit', 'gov_i_limit', 'gov_d_limit', 'gov_f_limit', 'gov_rpm_filter', 'gov_pwr_filter', 'gov_ff_filter', 'gov_d_filter'], docs: [P.governor, P.flyrotor, P.tuneGovernor] },
    { id: 'cyclic', order: 3, lane: 'cyclic', title: 'Cyclic gains', about: 'Tune the roll and pitch gains in this sequence: D, P, I, F, B, then O. Do the pitch axis first.',
        axisOrder: ['pitch', 'roll'], checks: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C9', 'C12', 'C13', 'C7:cyclic', 'L2', 'L3', 'L5:cyclic', 'L6:cyclic'],
        chips: [{ label: 'D', checks: ['C5'] }, { label: 'P', checks: ['C5', 'C6'] }, { label: 'I', checks: ['C1', 'C6'] }, { label: 'F', checks: ['C3', 'C4', 'C12'] }, { label: 'B', checks: ['C13'] }, { label: 'O', checks: ['C9'] }],
        params: GAINS('pitch', ['d', 'p', 'i', 'f', 'b', 'o']).concat(GAINS('roll', ['d', 'p', 'i', 'f', 'b', 'o'])), docs: [P.tuning, P.feedforward, P.hsi] },
    { id: 'tail', order: 3, lane: 'tail', title: 'Tail gains', about: 'Tune the yaw gains in this sequence: D, P, I, F, then B.',
        checks: ['T1', 'T2', 'T3', 'T9', 'T10', 'T11', 'T12', 'C7:yaw', 'L6:yaw'],
        chips: [{ label: 'D', checks: ['T1'] }, { label: 'P', checks: ['T1', 'T2'] }, { label: 'I', checks: ['T2'] }, { label: 'F', checks: ['T9', 'T11'] }, { label: 'B', checks: ['T12'] }],
        params: GAINS('yaw', ['d', 'p', 'i', 'f', 'b']), docs: [P.tuning, P.feedforward] },
    { id: 'cycomp', order: 4, lane: 'cyclic', title: 'Cyclic compensation', about: 'Set the pitch collective feedforward, the cross-coupling compensation, the I-term relax and the swash phase.',
        checks: ['C8', 'C10', 'C14'],
        chips: [{ label: 'Pitch collective feedforward', checks: ['C14'] }, { label: 'Cross-coupling', checks: ['C8'] }, { label: 'I-term relax and decrease', checks: ['C10'] }],
        params: ['pitch_collective_ff_gain', 'cyclic_cross_coupling_gain', 'cyclic_cross_coupling_ratio', 'cyclic_cross_coupling_cutoff', 'iterm_relax_type', 'iterm_relax_cutoff', 'iterm_relax_level',
            'error_decay_time_cyclic', 'error_decay_limit_cyclic', 'error_decay_time_ground', 'offset_limit', 'swash_phase'], docs: [P.crossCoupling, P.profiles, P.process22] },
    { id: 'tailcomp', order: 4, lane: 'tail', title: 'Tail compensation and authority',
        about: 'Set the yaw precompensation, the stop gains, the tail output limits and the tail torque assist. A higher headspeed also gives the tail more authority.',
        checks: ['T5', 'T6', 'T7', 'T8', 'T13', 'T14', 'T15', 'L4', 'L5:yaw'],
        chips: [{ label: 'Precompensation', checks: ['T6', 'T7', 'T14', 'T15'] }, { label: 'Stop gains', checks: ['T5'] }, { label: 'Tail authority', checks: ['T8', 'L4', 'T13'] }, { label: 'Tail torque assist', checks: [] }],
        params: ['yaw_collective_ff_gain', 'yaw_cyclic_ff_gain', 'yaw_precomp_cutoff', 'yaw_inertia_precomp_gain', 'yaw_inertia_precomp_cutoff', 'yaw_cw_stop_gain', 'yaw_ccw_stop_gain',
            'mixer input SY', 'tail_center_trim', 'tail_motor_idle', 'gov_tta_gain', 'gov_tta_limit', 'gov_tta_filter', 'swash_tta_precomp'], docs: [P.profiles, P.mixerSetup, P.tta] },
];
const LANE_ROW = { main: 0, cyclic: 0, tail: 1 };
BLOCKS.forEach(n => Object.assign(n, { kind: 'block', step: n.order, row: LANE_ROW[n.lane] }));
const NODES = PREREQ.concat(BLOCKS);
// the parameters of each chip (the integrator draws the chips): a pattern of the chip label over the parameters of its block
const CHIP_PARAMS = { 'RPM notch filters': /rpm_notch|RPM_FILTER/, 'Low-pass filters': /lpf|gyro_notch/, 'Dynamic notch filter': /dyn_notch|DYN_NOTCH/, 'D-term cutoffs': /_(d|gyro|b)_cutoff$/,
    'Mode and limits': /gov_(mode|throttle_type|headspeed|max_throttle|min_throttle|use_voltage_comp|[pidf]_limit)$/, 'Spool-up and changes': /gov_(idle_throttle|auto_throttle|handover_throttle|startup_time|spoolup_time|spooldown_time|tracking_time|recovery_time|autorotation_timeout|throttle_hold_timeout|use_pid_spoolup|use_fallback_precomp|fallback_drop)$/,
    F: /^gov_f_gain$|_f_gain$/, I: /^gov_i_gain$|_i_gain$/, P: /^gov_p_gain$|_p_gain$/, D: /^gov_d_gain$|_d_gain$/, Gain: /^gov_gain$|gov_.*_ff_weight|gov_collective_curve|gov_.*_filter$/, B: /_b_gain$/, O: /_o_gain$/,
    'Pitch collective feedforward': /pitch_collective_ff_gain/, 'Cross-coupling': /cross_coupling|swash_phase/, 'I-term relax and decrease': /iterm_relax|error_decay|offset_limit/,
    Precompensation: /yaw_(collective_ff|cyclic_ff|precomp_cutoff|inertia_precomp)/, 'Stop gains': /stop_gain/, 'Tail authority': /mixer input SY|tail_center_trim|tail_motor_idle/, 'Tail torque assist': /tta/ };
for (const n of NODES) { n.chips = (n.chips || []).map(c => Object.assign({ params: CHIP_PARAMS[c.label] ? n.params.filter(p => CHIP_PARAMS[c.label].test(p)) : [] }, c)); n.gates = n.gates || []; n.parameters = n.params; } // parameters: the round 1 name of params

// the ids of round 1 -> the new ids (K1: for anything that still reads them)
const LEGACY = { setup: 'controller', servos: 'mechanics', mixer: 'mechanics', tailmech: 'tailcomp', rotor: 'mechanics', rpm: 'rpm', gears: 'rpm', log: 'logging', notches: 'filters',
    lowpass: 'filters', dnoise: 'filters', govset: 'governor', govgain: 'governor', cyclic: 'cyclic', cycomp: 'cycomp', tail: 'tail', tailcomp: 'tailcomp', tta: 'tailcomp', rates: 'controller',
    rescue: 'rescue', result: 'cyclic' };

// viaRules: a cause edge that makes a block a possible result only through a K rule with its time test (causesOf), not for
// every problem upstream: the tail authority causes the tail gain symptoms only when the output limit comes first
const e = (from, to, kind, why, source, when, viaRules) => Object.assign({ from, to, kind, why, text: why, source }, when ? { when } : {}, viaRules ? { viaRules: true } : {});
const EDGES = [
    // the prerequisites and the blocks that need them
    e('logging', 'filters', 'validity', 'If the log rate is less than 1 kHz, the spectrum shows the rotor and tail peaks at incorrect frequencies.', 'INF Nyquist, DOC BB', ['D1']),
    e('logging', 'governor', 'validity', 'The governor tuning procedure uses a log at 1 kHz with the debug mode GOVERNOR.', 'DOC GOVT preparation', ['D1']),
    e('logging', 'cyclic', 'validity', 'If the log rate is less than 1 kHz, the results of the oscillation and of the time delay are not accurate.', 'INF Nyquist', ['D1']),
    e('logging', 'tail', 'validity', 'If the log rate is less than 1 kHz, the results of the tail oscillation are not accurate.', 'INF Nyquist', ['D1']),
    Object.assign(e('rpm', 'filters', 'gate', 'The RPM notch filters operate correctly only with a fast RPM signal and the correct motor pole count.', 'DOC RPMM, RPMF, MOTORS'), { scope: ['F3', 'F5', 'F6', 'F9'] }),
    e('rpm', 'governor', 'gate', 'The governor modes ELECTRIC and NITRO use the RPM signal. The gear ratios in the configuration are correct.', 'DOC GOVTAB, GOVT note, MOTORS'),
    e('power', 'governor', 'gate', 'If the battery voltage is too low, the throttle stays at its limit. Governor gains cannot correct this.', 'DOC FLYR, GOVTAB, INF'),
    e('mechanics', 'filters', 'order', 'Correct the blade tracking and the balance before you set the notch filters.', 'DOC FILT'),
    // fromChecks: the gate holds only for a problem of these checks of the prerequisite (a ground resonance does not hold the tail gains)
    Object.assign(e('mechanics', 'cyclic', 'gate', 'Gains cannot correct a loose part, a ground resonance or a servo that is not calibrated.', 'DOC-old PROC45, DOC MIXS, DOC FILT'), { fromChecks: ['F7', 'C15', 'SETUP'] }),
    Object.assign(e('mechanics', 'tail', 'gate', 'Gains cannot correct a loose linkage or a tail slider that does not move freely.', 'DOC-old PROC45 yaw'), { fromChecks: ['F7', 'T4'] }),
    Object.assign(e('controller', 'cyclic', 'gate', 'Use PID mode 3, and align the gyro correctly before you tune the gains.', 'DOC MIXT note, NOTES'), { fromChecks: ['SETUP'] }),
    Object.assign(e('controller', 'tail', 'gate', 'This is also applicable to the tail gains.', 'DOC MIXT note, NOTES'), { fromChecks: ['SETUP'] }),
    // the blocks (Rotorflight 2.3 documentation): filters, governor, then the cyclic lane and the tail lane
    e('filters', 'governor', 'order', 'Set the filters first. Then tune the governor.', 'DOC TUNE, FILT'),
    e('filters', 'cyclic', 'gate', 'Make sure that the filters operate correctly before you increase the gains.', 'DOC TUNE caution, DOC PRESETS caution'),
    e('filters', 'tail', 'gate', 'Keep the yaw D gain low until the RPM filters operate correctly.', 'DOC TUNE step 1, COM RCG-71'),
    e('governor', 'cyclic', 'order', 'Tune the governor first. Then tune the cyclic gains again.', 'DOC-old OLDWIKI Tuning-Introduction'),
    e('governor', 'tail', 'order', 'Tune the governor first. The tail must hold the torque changes that the governor makes.', 'DOC GOVT, DOC-old OLDWIKI Tail-tuning'),
    e('governor', 'tailcomp', 'cause', 'The precompensation operates on the torque changes that the governor makes.', 'INF, DOC GOVT'),
    e('cyclic', 'cycomp', 'order', 'Set the I-term relax after the I gain. It removes the I-term oscillation at stops.', 'DOC TUNE guidelines, DOC PROF I-term relax'),
    e('tail', 'tailcomp', 'order', 'Set the precompensation and the stop gains after the tail D, P, I and F gains.', 'INF, COM-AI RCFP-JW'),
    e('tailcomp', 'tail', 'cause', 'If the tail does not have sufficient authority, the tail output stays at its limit. Then gain changes cannot correct the yaw error.', 'DOC MIXS, CLAUDE.md Control limits, INF', null, true),
];

// K1-K27 (rules.json, tested on five real results by evalrules.py): a symptom flag with an upstream flag in the same log,
// with a compatible profile and axis, is a possible result of it. first: the documented steps, in sequence.
// before: the rule applies only when a period of the upstream flag starts before the error of the symptom (startsBefore): a
// control output at its limit is the first cause of the errors that come after it (CLAUDE.md "Control limits")
const k = (id, name, symptoms, upstream, validity, first, source, confidence, before) => Object.assign({ id, name, symptoms, upstream, validity, first, source, confidence }, before ? { before: true } : {});
const RULES = [
    k('K1', 'D-term noise', ['C11', 'F10'], ['F5', 'F6', 'F1', 'F8', 'F4', 'G12', 'G1'], ['D1', 'F9'],
        ['Find the cause of the vibration: balance, blade tracking or bearings.', 'Add or move an RPM notch filter for each rotor harmonic (F5, F6).',
            'For a peak that is not a rotor harmonic, use the dynamic notch filter.', 'For a resonance at a constant frequency, use a static notch filter.',
            'Make sure that one gyro low-pass filter is on (F1).', 'Keep the D-term cutoff at approximately 20 Hz (F4).', 'Fly again and record a new log.', 'Then change the D gain.'],
        ['TUNE caution', 'MSG profilesDerivativeHelp', 'FILT', 'PROF D-term cutoff', 'MOTORS'], ['DOC']),
    k('K2', 'Fast oscillation', ['C5', 'T1'], ['C11', 'F10', 'F11', 'F2', 'G10', 'T4', 'C2', 'T8', 'G13', 'D5', 'G1'], ['D1'],
        ['Make sure that the D-term noise is less than its limit (C11, F10).', 'Make sure that the tail linkage is not loose (T4).', 'For the tail, examine the governor tail coherence (G10).',
            'Then decrease the gain that you increased last.'],
        ['PROF Derivative', 'FILT', 'OLDWIKI Tail-tuning', 'PROC45 yaw', 'TUNE'], ['DOC', 'DOC-old', 'INF']),
    k('K3', 'Slow oscillation', ['C6', 'T2'], ['T4', 'C9', 'G9', 'G10', 'C1'], ['D1'],
        ['For the tail, examine the linkage, the slider and the bearings first.', 'For the cyclic, examine the high speed integral (C9).', 'Then decrease the I gain or increase the P gain.',
            'Then try the I-term relax.'],
        ['TUNE', 'HSI', 'PROC45 yaw', 'OLDWIKI Tail-tuning'], ['DOC', 'COM RCG-140']),
    k('K4', 'Time delay from setpoint to gyro', ['C13', 'T12'], ['F11', 'F2', 'F3', 'F4', 'C2', 'T8'], [],
        ['Measure the time delay of the filters (F11).', 'Remove the filters that are not necessary.', 'Examine the servo speed.', 'Then increase the B gain, not the F gain.'],
        ['RPMF', 'FILT', 'MSG gyroDynamicNotchQHelp', 'MSG gyroRpmFilterPresetHelp', 'FF', 'SERVO speed'], ['DOC', 'INF']),
    k('K5', 'Tracking error', ['C12', 'T11'], ['C2', 'T8', 'C1', 'C5', 'T1', 'C6', 'T2', 'C13', 'T12', 'C3', 'T9', 'C8', 'C9', 'C14', 'G3'], ['D1', 'D2', 'D6'],
        ['Read the error in each frequency band first.', 'Examine the output limits first (C2, T8). At the limit, the axis does not have sufficient authority.', 'Then correct the I-term limit (C1).',
            'Then correct the fast oscillation (C5, T1).', 'Then examine the time delay (C13, T12).', 'Then adjust the F gain.'],
        ['TUNE step 4', 'RATES', 'FF', 'XC', 'HSI', 'advice.cjs'], ['INF']),
    k('K6', 'Overshoot at stops', ['C4', 'T5'], ['C3', 'T9', 'C1', 'C2', 'T8', 'R1', 'G10', 'T4'], [],
        ['Tune the D, P and I gains first.', 'Then adjust the F gain.', 'Then adjust the I-term relax.', 'For the tail, examine if the yaw stick moves back after a stop (yaw_deadband).'],
        ['FF', 'PROF I-term relax', 'TUNE B', 'HF-970331'], ['DOC', 'COM']),
    k('K7', 'Feedforward', ['C3', 'T9'], ['C2', 'T8', 'C1', 'C5', 'C6', 'T1', 'T2'], [],
        ['Examine the output limits first (C2, T8).', 'Tune the D, P and I gains.', 'Then adjust the F gain.'], ['FF', 'TUNE step 4'], ['DOC']),
    k('K8', 'Yaw error at collective changes', ['T6', 'T7', 'T14'], ['T8', 'T13', 'G3', 'G4', 'G9', 'G10'], [],
        ['Make sure that the tail has sufficient authority first (T8).', 'Examine the tail center trim (T13).', 'Tune the governor F gain (G3, G4).', 'Then adjust the precompensation.'],
        ['MIXS center trim', 'GOVT torque', 'PROF collective FF'], ['DOC', 'INF']),
    k('K9', 'Yaw I-term in hover', ['T13'], ['T8', 'T7'], [],
        ['Set the tail center trim to keep the yaw I-term near zero in hover.', 'Make sure that the tail is not near its output limit.'], ['MIXS', 'health_more DEFAULT_RULES.T13'], ['DOC']),
    k('K10', 'Cyclic I-term at its limit', ['C1'], ['C2', 'C10', 'C14', 'C9', 'SETUP'], [],
        ['Examine the output limits first (C2).', 'Then examine the swash trim, the mixer calibration and the center of gravity.'], ['MSG profilesIntegralHelp', 'MIXS', 'MIXT'], ['DOC', 'INF']),
    k('K11', 'Headspeed control', ['G2', 'G3', 'G4', 'G5', 'G9'], ['G1', 'G12', 'G6', 'G7', 'G11', 'G13', 'D5', 'G0', 'G14', 'G8', 'P1'], ['D1'],
        ['Repair the RPM signal first (G1).', 'Make sure that the motor pole count and the RPM sensor are correct (G12).', 'Make sure that the throttle has a reserve (G6).',
            'Make sure that the battery voltage is sufficient (G11, G13, D5, P1).', 'Then tune the governor F, I and P gains, in that sequence.'],
        ['GOVT', 'GOVTAB', 'FLYR', 'MOTORS', 'MSG govFlagHelp_VOLTAGE_COMP'], ['DOC']),
    k('K12', 'Throttle reserve', ['G6', 'G7'], ['G11', 'G13', 'D5', 'P1'], [],
        ['Examine the battery voltage during the flight (G13, D5, P1).', 'If the throttle reserve stays low, decrease the governor headspeed.', 'Gain changes cannot increase the throttle reserve.'],
        ['FLYR', 'GOVTAB'], ['DOC', 'advice.cjs REFUTED.G6']),
    k('K13', 'Tail oscillation from the governor', ['T1', 'T2'], ['G10', 'G9'], [],
        ['Decrease the governor gain (gov_gain) before you change the tail gains.'], ['OLDWIKI Tail-tuning', 'GOVT'], ['DOC-old', 'COM RCG-141', 'COM RCG-107']),
    k('K14', 'Tail authority', ['T8'], ['G3', 'G6'], [],
        ['At its output limit, the tail does not have sufficient authority.', 'Increase the tail pitch range if the mechanical parts let you.', 'Install larger tail blades or increase the headspeed.',
            'On a tail with a motor, use the tail torque assist.', 'Decrease the governor torque changes.'], ['MIXS', 'GOVT', 'TTA'], ['DOC', 'INF']),
    k('K15', 'Tail oscillation that stays with gain changes', ['T4'], [], [],
        ['Examine the tail linkage, the tail slider and the bearings. Gains cannot correct a loose part.'], ['PROC45 yaw'], ['DOC-old', 'advice.cjs REFUTED.T4']),
    k('K16', 'Pitch movement with the collective', ['C14'], ['C2', 'C9'], [],
        ['Adjust pitch_collective_ff_gain first, before you change the other gains.'], ['PROC45', 'PROF'], ['DOC-old']),
    k('K17', 'I-term decrease in flight', ['C10'], [], [], ['Examine the airborne condition of the firmware (rc_threshold).'], ['firmware pid.c:1170-1188'], ['SRC', 'advice.cjs REFUTED.C10']),
    k('K18', 'Time delay from stick to setpoint', ['R1'], [], [], ['Decrease the response time, the acceleration limit or rc_smoothness in the rate profile.'], ['RATES'], ['DOC']),
    k('K19', 'Log rate', ['F5', 'F6', 'F9', 'F10', 'F11', 'C11', 'C5', 'T1', 'C6', 'T2', 'G9', 'G10', 'C13', 'T12'], ['D1'], ['D1'],
        ['Record the log at 1 kHz or more.', 'At a lower log rate, the frequency results are not accurate.'], ['GOVT preparation', 'BB logging rate'], ['INF', 'DOC']),
    k('K20', 'Header values', ['C1', 'C3', 'C4', 'C6', 'C7', 'C12', 'T5', 'T9', 'T11'], ['SETUP'], ['H'],
        ['Set the cyclic I gain back after the mixer limit test (MIXT).', 'Make sure that pid_mode is 3.', 'Do not use results from logs with different header values together (H).'],
        ['MIXT', 'NOTES', 'CHG'], ['DOC']),
    k('K21', 'Gain decision of the model', ['C7'], ['F1', 'F2', 'F3', 'F5', 'F6', 'F10', 'C11', 'C2', 'T8', 'G12', 'C5', 'T1'], ['H', 'D4'],
        ['Do the filter, output limit and motor pole items first.', 'Then fly the same gains again before you change a gain.'], ['TUNE caution', 'advice.cjs guards 1-3'], ['DOC', 'INF']),
    // K22-K27: the rescue checks and the control limits (health_rescue.cjs, health_limits.cjs)
    k('K22', 'FALLBACK at a large load', ['G1'], ['G19', 'L1', 'G20'], [],
        ['Examine the headspeed decrease at full throttle before the FALLBACK (G19, G20, L1).', 'If the FALLBACK comes only at a decrease of this type, the RPM signal is possibly correct.', 'Decrease the load at that time first.'],
        ['firmware governor.c motorRPMGood', 'health_rescue G19 and G20 overload'], ['SRC', 'INF']),
    k('K23', 'Tail kick at a rescue', ['T15'], ['G19', 'T8', 'D8'], [],
        ['Examine the headspeed decrease at the rescue (G19): a torque change pushes the tail.', 'Examine the tail authority (T8, and L4 with rule K24).', 'Make sure that the PID profile does not change with the rescue (D8).', 'Then adjust the precompensation.'],
        ['GOVT torque', 'PROF collective FF', 'RESCUE'], ['DOC', 'INF']),
    k('K24', 'Tail output at its limit', ['T1', 'T6', 'T11', 'T15'], ['L4'], [],
        ['Examine the periods with the tail output at its limit first (L4).', 'At its limit, the tail does not have sufficient authority. Gains cannot correct this.'], ['MIXS', 'CLAUDE.md Control limits'], ['DOC', 'INF'], true),
    k('K25', 'Throttle at its limit', ['G2', 'G3', 'G5', 'G19'], ['L1'], [],
        ['Examine the periods with the throttle at its limit first (L1).', 'At the throttle limit, the governor cannot hold the headspeed. Gain changes cannot correct this.'], ['FLYR', 'GOVTAB', 'CLAUDE.md Control limits'], ['DOC', 'INF'], true),
    k('K26', 'Cyclic or collective at its limit', ['C2', 'C12'], ['L2', 'L3', 'L5', 'L7'], [],
        ['Examine the periods with the cyclic, the collective or a servo at its limit first (L2, L3, L5, L7).', 'Gains cannot correct an output at its limit.'], ['MIXT', 'CLAUDE.md Control limits'], ['DOC', 'INF'], true),
    k('K27', 'Load at a rescue', ['G19'], ['L7', 'D8'], [],
        ['Examine the collective command at the rescue (L7): a large collective is a large load.', 'Make sure that the PID profile does not change with the rescue (D8).'], ['RESCUE', 'CLAUDE.md Control limits'], ['DOC', 'INF'], true),
];

// ---------------------------------------------------------------------------------------------
// Homes and graph walks
// ---------------------------------------------------------------------------------------------

const BY_ID = new Map(NODES.map(n => [n.id, n]));
const isPrereq = (id) => !!BY_ID.get(id) && BY_ID.get(id).kind === 'prereq';
const isBlock = (id) => !!BY_ID.get(id) && BY_ID.get(id).kind === 'block';
const HOME = new Map();
for (const n of NODES) for (const c of n.checks) if (!/:/.test(c)) HOME.set(c, n.id);

// the item of a check id, or of a recommendation id ('T7:yaw_collective_ff_gain:p1', 'SETUP:roll_i_gain', 'C7:yaw:2500');
// SETUP: the cyclic I rule (the mixer limit test) -> mechanics, the others (pid_mode, rates_type) -> controller; C7, L5 and
// L6 by axis (the tail servo and the yaw I-term with the tail); null for an unknown id
function homeOf(checkId, axis) {
    const id = String(checkId || ''), parts = id.split(':'), base = parts[0].replace(/#\d+$/, ''), rest = parts.slice(1).join(':');
    if (base === 'SETUP') return /i_gain/.test(rest) ? 'mechanics' : 'controller';
    const yaw = (axis || (/(^|[:_])yaw/.test(rest) ? 'yaw' : null)) === 'yaw';
    if (base === 'C7') return yaw ? 'tail' : 'cyclic';
    if (base === 'L5') return yaw ? 'tailcomp' : 'cyclic';
    if (base === 'L6') return yaw ? 'tail' : 'cyclic';
    return HOME.get(base) || null;
}

const upstreamOf = (kinds, all) => { const m = new Map(NODES.map(n => [n.id, []])); for (const x of EDGES) if (kinds.includes(x.kind) && (all || !x.viaRules)) m.get(x.to).push(x.from); return m; };
const GATE_UP = upstreamOf(['gate']), CAUSE_UP = upstreamOf(['cause']), RULE_UP = upstreamOf(['cause'], true); // RULE_UP: also the cause edges of the K rules only
// the sequence: the prerequisites first (in the band order), then the blocks by order and lane
const seqOf = (id) => { const n = BY_ID.get(id); return n.kind === 'prereq' ? [0, n.row] : [n.order, n.row]; };
const bySequence = (a, b) => { const x = seqOf(a), y = seqOf(b); return x[0] - y[0] || x[1] - y[1]; };

// a gate edge with a scope (rpm > filters: the RPM notch filters) holds only the problems of these checks of the block: the RPM
// signal does not change a low-pass filter. Without a scope, every problem
const SCOPE = new Map(EDGES.filter(x => x.kind === 'gate' && Array.isArray(x.scope)).map(x => [`${x.from}>${x.to}`, x.scope]));
const scopeOf = (from, to) => SCOPE.get(`${from}>${to}`) || null;
const FROM_CHECKS = new Map(EDGES.filter(x => x.kind === 'gate' && Array.isArray(x.fromChecks)).map(x => [`${x.from}>${x.to}`, x.fromChecks]));
const fromChecksOf = (from, to) => FROM_CHECKS.get(`${from}>${to}`) || null;
// the blocks before each block along the order edges between blocks (filters -> governor -> the lanes), transitive
const BEFORE = new Map(BLOCKS.map(b => [b.id, []]));
{ const up = new Map(BLOCKS.map(b => [b.id, EDGES.filter(x => x.kind === 'order' && x.to === b.id && isBlock(x.from)).map(x => x.from)]));
    const walk = (id, seen) => { for (const u of up.get(id) || []) if (!seen.has(u)) { seen.add(u); walk(u, seen); } return seen; };
    for (const b of BLOCKS) BEFORE.set(b.id, [...walk(b.id, new Set())]); }
// every item that gates nodeId, directly or through other gates, in the documented sequence
function gateUpstream(nodeId) {
    const seen = new Set(), walk = (id) => { for (const u of GATE_UP.get(id) || []) if (!seen.has(u)) { seen.add(u); walk(u); } };
    walk(nodeId);
    return [...seen].sort(bySequence);
}

// the diagram for the views (K1)
const plain = (o) => JSON.parse(JSON.stringify(o));
function graph() {
    const pick = (n, keys) => Object.fromEntries(keys.filter(x => n[x] !== undefined).map(x => [x, n[x]]));
    return plain({
        prereq: PREREQ.map(n => pick(n, ['id', 'kind', 'title', 'about', 'checks', 'params', 'gates', 'note', 'docs', 'step', 'row'])),
        blocks: BLOCKS.map(n => pick(n, ['id', 'kind', 'title', 'about', 'lane', 'order', 'params', 'checks', 'chips', 'optional', 'axisOrder', 'docs', 'step', 'row'])),
        edges: EDGES, rules: RULES, nodes: NODES.map(n => pick(n, ['id', 'kind', 'title', 'about', 'lane', 'order', 'step', 'row', 'checks', 'params', 'parameters', 'gates', 'chips', 'docs', 'note', 'optional'])),
    });
}

// ---------------------------------------------------------------------------------------------
// Causes (K rules)
// ---------------------------------------------------------------------------------------------

const logsOf = (f) => Array.isArray(f.log) ? f.log : f.log === null || f.log === undefined ? [] : [f.log];
// the PID profile of a finding or an evidence row: the worker's pidProfile (1-6) first, else the toolkit label (SPEC2 D12)
const pidOk = (v) => Number.isInteger(v) && v >= 1 && v <= 6 ? v : null;
const profileOf = (f) => { const q = pidOk(f.pidProfile); if (q !== null) return q; const p = typeof f.profile === 'string' && /^\d+$/.test(f.profile) ? +f.profile : f.profile; return typeof p === 'number' && isFinite(p) && p > 0 ? p : null; };
// the axis of a finding: its field; F4 keeps it in profile; the T checks are yaw. Text is never read (SPEC2 D5)
const axisOf = (f) => f.axis || (f.id === 'F4' && AX3.includes(f.profile) ? f.profile : /^T\d/.test(String(f.id)) ? 'yaw' : null);
function compatible(s, u) {
    const a = logsOf(s), b = logsOf(u);
    if (a.length && b.length && !a.some(l => b.includes(l))) return false;
    const p = profileOf(s), q = profileOf(u); if (p !== null && q !== null && p !== q) return false;
    const x = axisOf(s), y = axisOf(u); return !(x && y && x !== y);
}

// The times of a finding for the time test (SPEC2 D-M1): the spans of its evidence (frame seconds) when it has them, else
// its events and times (index seconds). -> { base, list: [[log, t0, t1]] } or null
const finite = (v) => typeof v === 'number' && isFinite(v);
function timesOf(f) {
    const l0 = logsOf(f)[0], sp = f && f.evidence && Array.isArray(f.evidence.spans) ? f.evidence.spans.filter(x => x && finite(x.t0) && finite(x.t1)) : [];
    if (sp.length) return { base: 'frame', list: sp.map(x => [x.log === undefined ? l0 : x.log, x.t0, x.t1]) };
    const ev = (Array.isArray(f.events) ? f.events : []).filter(x => x && finite(x.t)).map(x => [l0, x.t, x.t + (finite(x.seconds) && x.seconds > 0 ? x.seconds : 0)]);
    const list = ev.length ? ev : (Array.isArray(f.times) ? f.times : []).filter(finite).map(t => [l0, t, t]);
    return list.length ? { base: 'index', list } : null;
}
// every time of u lies in a window of the symptom s, in the same log: s can cause u (an oscillation drives the tail to its
// output limit), and u is no cause of s (the Fireball: all T8 time in the T1 oscillation). Unknown times: false
const TIME_TOL = 0.05;
function insideOf(u, s) {
    const a = timesOf(u), b = s ? timesOf(s) : null; if (!a || !b || a.base !== b.base) return false;
    return a.list.every(([l, t0, t1]) => b.list.some(([m, w0, w1]) => m === l && t0 >= w0 - TIME_TOL && t1 <= w1 + TIME_TOL));
}

// The onsets of the error of a symptom: its own onsets (health_rescue G19 and T15: { t index s, tS frame s }), else the start
// of each of its times (timesOf). -> { base, list: [[log, t]] }
function onsetsOf(f) {
    const l0 = logsOf(f)[0], t = timesOf(f);
    if (Array.isArray(f.onsets) && f.onsets.length) { const frame = !t || t.base === 'frame';
        return { base: frame ? 'frame' : 'index', list: f.onsets.filter(Boolean).map(x => [x.log === undefined ? l0 : x.log, frame ? x.tS : x.t]).filter(x => finite(x[1])) }; }
    return t ? { base: t.base, list: t.list.map(([l, a]) => [l, a]) } : null;
}
// u starts before the error of s (a K rule with before): a time of u in the same log starts at or before an onset of s, and ends
// BEFORE_S or less before it. Unknown times: false
const BEFORE_S = 2;
function startsBefore(u, s) {
    const a = timesOf(u), o = s ? onsetsOf(s) : null; if (!a || !o || a.base !== o.base) return false;
    return a.list.some(([l, t0, t1]) => o.list.some(([m, t]) => m === l && t0 <= t + TIME_TOL && t1 >= t - BEFORE_S));
}

// The K rules that make target a possible result of other flags: target is a finding, or a recommendation through its
// evidence rows; a symptom of the rule, and an upstream flag of the rule in the same log with a compatible profile and
// axis, whose times do not all lie in the times of the symptoms (insideOf). only(u): an optional filter on the upstream
// findings. -> [{ rule, name, fids, ids, first }]; fids: the upstream findings' fid (when they have one), ids: their check ids
const REC_SEVERITY = new Set(['action', 'check', 'watch', 'info']);
function causesOf(target, findings, only) {
    if (!target) return [];
    const isRec = Array.isArray(target.evidence) && REC_SEVERITY.has(target.severity), byFid = new Map((findings || []).filter(f => f && f.fid).map(f => [f.fid, f]));
    const symptoms = isRec ? target.evidence.filter(Boolean).map(ev => Object.assign({ axis: target.axis || null, profile: target.profile === undefined ? null : target.profile }, ev)) : [target];
    const findingOf = (x) => isRec ? (x.fid && byFid.get(x.fid)) || x : x;   // an evidence row has no spans: its finding has
    const own = new Set(symptoms.map(x => x.fid).filter(Boolean)), out = [];
    for (const K of RULES) {
        const s = symptoms.filter(x => K.symptoms.includes(x.id)); if (!s.length || !K.upstream.length) continue;
        const ups = (findings || []).filter(u => u && u !== target && u.severity === 'flag' && K.upstream.includes(u.id) && !(u.fid && own.has(u.fid)) && (!only || only(u)) && s.some(x => compatible(x, u))
            // a rule with before (a control limit): the time order decides, a limit period inside the window of the error included
            && (K.before ? s.some(x => compatible(x, u) && startsBefore(u, findingOf(x))) : !s.filter(x => compatible(x, u)).every(x => insideOf(u, findingOf(x)))));
        if (ups.length) out.push({ rule: K.id, name: K.name, fids: ups.map(u => u.fid).filter(Boolean), ids: [...new Set(ups.map(u => u.id))], first: K.first.slice() });
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Status of every item
// ---------------------------------------------------------------------------------------------

let catalogCache;
function catalog() { // lazy: catalog.cjs requires this module
    if (catalogCache === undefined) { try { catalogCache = require('./catalog.cjs'); } catch (err) { catalogCache = null; } }
    return catalogCache;
}

const NO_PROBLEM = new Set(['D4']);           // D4 is a data check
// D2 flags in every real result (loop stalls after landing): a problem only when catalog.cjs calls it one (a loss of 1 % of the
// frames or more, a clearly measurable issue of the log, SPEC3 A); without the catalog, never
// a check with its own status rule in the catalog (D2 frame loss, L7 stick end, G11 pack sag) is a problem only when the catalog says so
const ownStatus = (id) => { const C = catalog(); return !!(C && C.CHECKS && C.CHECKS[id] && typeof C.CHECKS[id].statusOf === 'function'); };
const catalogProblem = (f) => { const C = catalog(); try { return !!C && C.status(f) === 'problem'; } catch (e) { return false; } };
const ACT = new Set(['action', 'check']);
const VALIDITY = new Set(EDGES.filter(x => x.kind === 'validity').map(x => x.to)); // blocks whose results D1 makes not accurate
const RATE_SYMPTOMS = new Set(RULES.find(r => r.id === 'K19').symptoms);
const key = (f) => `${f.module || null}|${f.id}|${JSON.stringify(f.log === undefined ? null : f.log)}|${f.profile === undefined ? null : f.profile}|${f.text}`; // the worker's explain() key
const fidKey = (x) => x.fid ? `fid:${x.fid}` : null;
const quote = (t) => `"${t}"`;
const titlesOf = (ids) => ids.map(id => quote(BY_ID.get(id).title)).join(', ');
const andList = (a) => a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a.join('');
const REASON = {
    startHere: () => 'This tuning block has a problem, and no item before it has a problem.',
    satisfactory: () => 'The results of this tuning block are satisfactory.',
    monitor: () => 'Some results of this tuning block are near or more than their limits. Examine them again after the next flight.',
    information: () => 'The results of this tuning block give information only.',
    insufficient: () => 'The logs do not have sufficient data for the checks of this tuning block.',
    notAccurate: () => 'All results of this tuning block come from logs that record at less than 1 kHz (D1). These results are not accurate.',
};
// the reasons of the advice coverage statuses. 'not-in-log': the log does not record the values (user rule 2026-10-06: the log
// is the only necessary input, and no text asks for a CLI dump)
const COVERAGE = { 'not-in-log': 'The log does not record these values. Thus, the analysis cannot examine them.', 'needs-fields': 'The log does not record the fields that these checks use.',
    'needs-flights': 'The logs do not have sufficient flight data for these checks.', 'no-check': 'No check of the app measures this item.', 'not-assessable': 'A log cannot show this item.' };

// The PID profile of a finding or a recommendation (SPEC2 D12): '1' to '6', '0' when the arming profile is not known
// (log profile 0 or 'arm', "PID profile unknown"), null when it has none (header checks, D4 with its CLI index, F4 with
// an axis, H with 'global' or the start profile): a finding with no profile counts in every profile
const NO_LOG_PROFILE = new Set(['D4', 'F4', 'H']);
function profileKey(x) {
    const id = String(x && x.id || '').split(':')[0].replace(/#\d+$/, '');
    if (x && Number.isInteger(x.pidProfile) && x.pidProfile >= 1 && x.pidProfile <= 6) return String(x.pidProfile); // the worker's resolved profile, as js/tuning_dialog.js profileNo
    if (!x || NO_LOG_PROFILE.has(id)) return null;
    const p = x.profile, q = typeof p === 'string' && /^\d+$/.test(p) ? +p : p;
    if (typeof q === 'number' && isFinite(q)) return String(q > 0 ? q : 0);
    return p === 'arm' || p === 'unknown' ? '0' : null;
}
const byProfileKey = (a, b) => (a === '0') - (b === '0') || +a - +b; // PID profile 1 to 6, then "PID profile unknown"
// the arming profile of a log row of the worker (logsInput) when it is confirmed: an in-flight event, the CLI sections, the
// CLI gov_headspeed, or 'headspeed' (the logged govRequest at the log start agrees with the gov_headspeed of exactly one PID
// profile at the logged PID profile changes of the same file, user decision 2026-10-06) (armingBasis), or armingConfirmed; else null
const CONFIRMED = new Set(['event', 'cli', 'cliTarget', 'headspeed']);
const armingOfLog = (l) => { const p = pidOk(l && l.armingProfile); return p !== null && (l.armingConfirmed === true || (Array.isArray(l.armingBasis) && l.armingBasis.some(b => CONFIRMED.has(b)))) ? p : null; };
// the profiles of a result: of its findings, its recommendations and the flight time of its logs (logs[].profileSeconds)
function profilesOf(F, R, logs) {
    const keys = new Set();
    for (const x of F.concat(R || [])) { const k = profileKey(x); if (k !== null) keys.add(k); }
    // the label 0 of a log (before its first PID profile change) is its arming profile when the worker confirmed it (SPEC2 D12)
    for (const l of logs || []) for (const [p, sec] of Object.entries((l && l.profileSeconds) || {})) { const a = +p === 0 ? armingOfLog(l) : null, k = profileKey({ profile: a !== null ? a : p }); if (k !== null && sec >= 0.05) keys.add(k); } // js/tuning_dialog.js profileList
    return [...keys].sort(byProfileKey);
}
// the logs that are bench runs (SPEC2 D13 correction): a D7 finding of the log says so, or the log row of the worker
function benchLogs(F, logs) {
    const C = catalog(), out = new Set();
    for (const f of F) if (f.id === 'D7' && C && typeof C.benchOf === 'function' && C.benchOf(f)) for (const l of logsOf(f)) out.add(l);
    for (const l of logs || []) if (l && (l.bench === true || l.class === 'bench' || l.logClass === 'bench')) out.add(l.log);
    return out;
}

/**
 * findings: worker findings (fid, id, severity, log, profile, axis, thin, explained; node if set). recs: advice
 * recommendations with evidence rows (fid), or null when advice is not available (then every flag counts).
 * opts: { logs, coverage (advice coverage rows), header, fields, cli (health_setup.parseCli), profile, byProfile }, all
 * optional. profile (1-6, 0 for "PID profile unknown"): the status of that PID profile only, from its findings and
 * recommendations and those with no profile. Without it, the status of all profiles together, with byProfile: { [key]:
 * the status of that profile } and profiles: [keys] (byProfile: false leaves them out), and each node gets
 * profiles: { [key]: status } for the chips of "All profiles". The findings of a bench run (D7) do not count.
 * A prerequisite gets 'ok', 'problem' or 'noData'; a block one of the block statuses (problem: startHere, blocked or possible).
 */
function status(findings, recs, opts) {
    const o = opts || {}, want = o.profile === undefined || o.profile === null || o.profile === 'all' ? null : profileKey({ profile: o.profile });
    const out = statusOne(findings, recs, o, want);
    if (want !== null || o.byProfile === false) return out;
    const all = (Array.isArray(findings) ? findings : []).filter(f => f && typeof f.id === 'string'), bench = new Set(out.bench);
    const F = all.filter(f => !logsOf(f).length || !logsOf(f).every(l => bench.has(l)));   // a bench run gives no PID profile
    out.profiles = profilesOf(F, Array.isArray(recs) ? recs.filter(Boolean) : null, (o.logs || []).filter(l => !(l && bench.has(l.log))));
    out.byProfile = {};
    for (const k of out.profiles) out.byProfile[k] = statusOne(findings, recs, o, k);
    for (const n of NODES) out.nodes[n.id].profiles = Object.fromEntries(out.profiles.map(k => [k, out.byProfile[k].nodes[n.id].status]));
    return out;
}

function statusOne(findings, recs, opts, want) {
    // recs null, or empty (js/tuning_worker.js gives [] when advice.cjs fails; advice gives a recommendation for each flag)
    const o = opts || {}, C = catalog(), F0 = (Array.isArray(findings) ? findings : []).filter(f => f && typeof f.id === 'string'), R = Array.isArray(recs) && recs.length ? recs : null;
    const inProfile = (x) => { if (want === null) return true; const k = profileKey(x); return k === null || k === want; };
    const bench = benchLogs(F0, o.logs), F = F0.filter(f => inProfile(f) && (f.id === 'D7' || !logsOf(f).length || !logsOf(f).every(l => bench.has(l))));
    const RP = (R || []).filter(r => r && inProfile({ id: r.id, profile: r.profile }));    // the recommendations of this profile (all of them cite)
    // which recommendation severities cite each finding (by fid, else by the worker's explain key)
    const cited = new Map(), cite = (k, sev) => { if (!k) return; if (!cited.has(k)) cited.set(k, []); cited.get(k).push(sev); };
    // advice.cjs cuts the evidence list of a recommendation to 20 rows; citedFids keeps the fid of every row (review 2, C2)
    for (const r of R || []) { for (const ev of r.evidence || []) if (ev) { cite(fidKey(ev), r.severity); if (!ev.fid) cite(key(ev), r.severity); }
        for (const fid of Array.isArray(r.citedFids) ? r.citedFids : []) if (!(r.evidence || []).some(ev => ev && ev.fid === fid)) cite(`fid:${fid}`, r.severity); }
    const sevOf = (f) => cited.get(fidKey(f)) || cited.get(key(f)) || [];
    const problemFinding = (f) => f.severity === 'flag' && !NO_PROBLEM.has(f.id) && (f.id !== 'D2' && !ownStatus(f.id) || catalogProblem(f)) && !f.explained && !(Array.isArray(f.resultOf) && f.resultOf.length) && (!R || sevOf(f).some(s => ACT.has(s)));
    const classOf = (f) => {
        if (problemFinding(f)) return 'problem';
        if (f.severity === 'flag') { const s = sevOf(f); return f.explained || (s.length && s.every(x => x === 'info')) ? 'information' : 'monitor'; }
        if (C) return C.status(f);
        return f.severity === 'ok' ? 'satisfactory' : f.severity === 'skipped' ? 'notMeasured' : f.severity === 'error' ? 'error' : /^no finding/i.test(String(f.text || '')) || f.thin ? 'insufficient' : 'monitor';
    };
    const d1 = new Set(); for (const f of F) if (f.id === 'D1' && f.severity === 'flag') for (const l of logsOf(f)) d1.add(l);
    const nodes = {};
    for (const n of NODES) nodes[n.id] = { kind: n.kind, status: null, problem: false, number: null, fids: [], recs: [], findings: 0, blockedBy: [], possible: [], reason: '' };
    const byNode = new Map(NODES.map(n => [n.id, []]));
    // the item of a finding: its node when the worker set a new id, else its home (an old id of round 1 goes through LEGACY)
    const nodeOf = (x) => { const n = BY_ID.has(x.node) ? x.node : LEGACY[x.node] && homeOf(x.id, axisOf(x)) === null ? LEGACY[x.node] : null; return n || homeOf(x.id, axisOf(x)); };
    for (const f of F) { const id = nodeOf(f); if (byNode.has(id)) byNode.get(id).push(f); }
    const recHome = (r) => BY_ID.has(r.node) ? r.node : homeOf(r.id, r.axis);
    for (const r of RP) { const id = recHome(r); if (nodes[id]) nodes[id].recs.push(r.id); }

    // problems: flags with an action or check recommendation; header rules (SETUP) and gain decisions (C7) by their recommendation
    const problemFids = new Map();
    for (const n of NODES) {
        const list = byNode.get(n.id), N = nodes[n.id];
        const invalid = (f) => n.kind === 'block' && (VALIDITY.has(n.id) || RATE_SYMPTOMS.has(f.id)) && logsOf(f).length > 0 && logsOf(f).every(l => d1.has(l));
        const valid = list.filter(f => !invalid(f));
        N.findings = list.length;
        N.fids = list.map(f => f.fid).filter(Boolean);
        const classes = valid.map(classOf), probs = valid.filter((f, i) => classes[i] === 'problem');
        const direct = RP.filter(r => ACT.has(r.severity) && /^(SETUP|C7)(:|$)/.test(r.id) && recHome(r) === n.id);
        if (n.kind === 'prereq') {   // assumed correct: a problem only for a clearly measurable issue (SPEC3 A)
            const ran = valid.filter((f, i) => !['notMeasured', 'error'].includes(classes[i]));
            N.checksRun = [...new Set(ran.map(f => f.id))];
            N.watch = valid.filter((f, i) => classes[i] === 'monitor').map(f => f.fid).filter(Boolean);
            if (probs.length || direct.length) { N.problem = true; N.status = 'problem'; problemFids.set(n.id, probs.map(f => f.fid).filter(Boolean)); N.problemFids = problemFids.get(n.id); N.problemRecs = direct.map(r => r.id); }
            else N.status = ran.length ? 'ok' : 'noData';
            continue;
        }
        if (probs.length || direct.length) { N.problem = true; problemFids.set(n.id, probs.map(f => f.fid).filter(Boolean)); N.problemFids = problemFids.get(n.id); N.problemRecs = direct.map(r => r.id); continue; }
        if (list.length && !valid.length) { N.status = 'notAccurate'; continue; }
        N.status = ['monitor', 'satisfactory', 'information', 'insufficient'].find(s => classes.includes(s)) || 'notMeasured';
    }

    // not applicable: the governor in DIRECT or LIMIT (G0)
    const g0 = F.filter(f => f.id === 'G0' && f.severity !== 'skipped' && f.severity !== 'error');
    if (g0.length && g0.every(f => f.severity === 'note' && f.value === 0) && !nodes.governor.problem) { nodes.governor.status = 'notApplicable'; nodes.governor.reason = 'The governor mode is DIRECT or LIMIT (G0). Thus, the governor gains are not applicable.'; }

    // blocks: blocked (gate), possible result (cause edge, K rule), start here
    const P = new Set(NODES.filter(n => nodes[n.id].problem).map(n => n.id));
    const problemSet = new Set([].concat(...problemFids.values()));
    // a K rule counts for a block only when an upstream flag sits in an item before it in the documented sequence, or in an
    // item with a cause edge to it (the tail authority): inside one item it orders the work, and a later item (K14: G6 for T8)
    // does not move the start of the work
    const upstreamOk = (x, id) => x && x !== id && (bySequence(x, id) < 0 || (RULE_UP.get(id) || []).includes(x));
    // the problems upstream that gate a block: a direct gate with a scope holds only the problems of its checks in the block, one
    // with fromChecks only the problems of those checks of the upstream item (its problem findings and SETUP or C7 recommendations)
    const idsOf = (u) => [...new Set(byNode.get(u).filter(problemFinding).map(f => f.id).concat((nodes[u].problemRecs || []).map(x => String(x).split(':')[0])))];
    const holds = (u, id) => { const q = scopeOf(u, id), fc = fromChecksOf(u, id);
        return (!q || byNode.get(id).some(f => problemFinding(f) && q.includes(f.id))) && (!fc || idsOf(u).some(x => fc.includes(x))); };
    const gatesOf = (id) => gateUpstream(id).filter(u => P.has(u) && holds(u, id));
    for (const id of [...P].filter(isBlock)) {
        const N = nodes[id], up = gatesOf(id);
        if (up.length) { N.status = 'blocked'; N.blockedBy = up.filter(u => !gateUpstream(u).some(v => up.includes(v) && v !== u)); }
        const causeNodes = (CAUSE_UP.get(id) || []).filter(u => P.has(u)), byRule = new Map();
        for (const f of byNode.get(id).filter(problemFinding)) for (const c of causesOf(f, F, (u) => problemFinding(u) && (!u.fid || problemSet.has(u.fid))))
            { const q = byRule.get(c.rule) || { rule: c.rule, name: c.name, fids: [], ids: [] }; byRule.set(c.rule, q); for (const x of c.fids) if (!q.fids.includes(x)) q.fids.push(x); for (const x of c.ids) if (!q.ids.includes(x)) q.ids.push(x); }
        const rules = [...byRule.values()].map(q => Object.assign({ from: [...new Set(q.ids.map(x => homeOf(x)).filter(x => upstreamOk(x, id)))].sort(bySequence) }, q)).filter(q => q.from.length);
        N.possible = causeNodes.map(u => ({ rule: 'cause', from: [u], fids: problemFids.get(u) || [], ids: [] })).concat(rules);
        if (N.status === 'blocked') continue;
        if (N.possible.length) N.status = 'possible';
    }
    // "Start here" (coordinator rule, round 2): a block with a problem, not blocked and not a possible result, whose blocks before
    // it in the sequence (BEFORE: filters, governor, then its lane) have no problem and no gate upstream with a problem. Never a
    // later block when an earlier one waits: that one gets 'problem' and after = the items to correct first
    const waiting = (u) => P.has(u) || gatesOf(u).length > 0;
    const startHere = [];
    for (const id of [...P].filter(x => isBlock(x) && nodes[x].status === null).sort(bySequence)) {
        const first = BEFORE.get(id).filter(waiting);
        if (!first.length) startHere.push(id);
        else { const N = nodes[id], gates = [...new Set(first.flatMap(gatesOf))], blocks = first.filter(u => P.has(u));
            N.status = 'problem'; N.after = [...new Set(gates.concat(blocks))].sort(bySequence); }
    }
    startHere.forEach((id, i) => { nodes[id].status = 'startHere'; nodes[id].number = i + 1; });
    const prereqProblems = PREREQ.map(n => n.id).filter(id => nodes[id].problem);

    // reasons
    const coverageWhy = (n) => { const rows = (o.coverage || []).filter(r => (r.checks || []).some(c => n.checks.some(x => x.split(':')[0] === c)));
        const st = ['needs-fields', 'needs-flights', 'not-in-log', 'no-check', 'not-assessable'].find(s => rows.some(r => r.status === s)); return st ? COVERAGE[st] : null; };
    for (const n of NODES) {
        const N = nodes[n.id]; if (N.reason) continue;
        if (n.kind === 'prereq') {
            const ids = N.checksRun || [], probIds = [...new Set(byNode.get(n.id).filter(f => (N.problemFids || []).includes(f.fid)).map(f => f.id))];
            N.reason = N.status === 'problem' ? `${probIds.length ? `${probIds.length > 1 ? 'Checks' : 'Check'} ${andList(probIds)} found a problem.` : 'A check of this item found a problem.'} Correct it before you tune the tuning blocks after it.`
                : N.status === 'ok' ? `No problem found. ${ids.length > 1 ? 'These checks operated' : 'This check operated'}: ${andList(ids)}.`
                : coverageWhy(n) || 'The logs cannot show this item. Examine it on the helicopter.';
            continue;
        }
        if (N.status === 'blocked') N.reason = `Correct ${N.blockedBy.length > 1 ? 'these items' : 'this item'} first: ${titlesOf(N.blockedBy)}.`;
        else if (N.status === 'problem') N.reason = `This tuning block has a problem. Correct ${N.after.length > 1 ? 'these items' : 'this item'} before it first: ${titlesOf(N.after)}.`;
        else if (N.status === 'possible') { const from = [...new Set([].concat(...N.possible.map(q => q.from)))].filter(id => BY_ID.has(id) && id !== n.id).sort(bySequence);
            N.reason = from.length ? `This problem can be a result of a problem in ${titlesOf(from)}.` : 'This problem can be a result of the problems before it.'; }
        else if (N.status === 'notMeasured') { const runs = n.checks.some(c => !(C && C.CHECKS[c.split(':')[0]] && C.CHECKS[c.split(':')[0]].run === false));
            N.reason = coverageWhy(n) || (!runs ? 'No check of the app measures this tuning block.' : byNode.get(n.id).length ? 'The checks of this tuning block did not operate on these logs.' : 'The checks of this tuning block have no result.'); }
        else N.reason = REASON[N.status] ? REASON[N.status]() : '';
    }
    return { nodes, startHere, prereqProblems, profile: want, bench: [...bench].sort((a, b) => a - b) };
}

module.exports = { PREREQ, BLOCKS, NODES, EDGES, RULES, LEGACY, scopeOf, fromChecksOf, homeOf, isPrereq, isBlock, graph, status, causesOf, gateUpstream, axisOf, compatible, profileKey, startsBefore, bySequence };
