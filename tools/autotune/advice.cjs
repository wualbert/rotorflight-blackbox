'use strict';

/**
 * Advice: health findings and report.cjs gain decisions -> recommendations for the pilot, in the Rotorflight tuning
 * sequence (hierarchy.cjs), with the guards of docs/TUNING_KNOWLEDGE.md sections 8 and 9, and a coverage matrix of the
 * Rotorflight 4.6 parameter groups.
 *
 *   const advice = require('./advice.cjs');
 *   const { recommendations, coverage, notes } = advice.advise(input);
 *   const text = advice.exportScript(recommendations, picks, meta);  // the CLI file of the export panel (SPEC2 D11)
 *   const text = advice.script(recommendations);      // the same with the default picks and no meta
 *   const ids = advice.defaultPicks(recommendations);  // the ids that the export panel ticks first: actions with CLI text
 *
 * input = { findings,       health_report findings (modules setup, gov, loop, health) and health_track / health_more
 *                           findings, each with module, times and (from the worker) fid
 *           decisions,      report.cjs results.decisions, or null
 *           header,         own properties of the analysed log's sysConfig
 *           cli,            health_setup.parseCli of the pilot's CLI dump, or null
 *           cliName,        the file name of that CLI dump (optional: the from-values that it gives name it, review V11)
 *           logs,           [{ log, start, flown, flyingS, profileSeconds, targetOf, excluded }]; setup findings of
 *                           logs that were not flown (bench spool-ups) are left out; start is optional
 *           fields,         D3 field states of the analysed log, or null
 *           headerProfile,  log profile that was active when the analysed log was armed (setup metrics startProfile):
 *                           the confirmed arming profile, 1-6; 0 or absent when unknown
 *           headerProfileInferred  true when headerProfile is only inferred (js/tuning_worker.js reconciles 'arm', 0
 *                           and inferred): then the header is the confirmed profile of no PID profile (SPEC2 D12)
 *           headerLog,      label of the analysed log, whose header this is (optional; with logs[].start it lets a
 *                           measurement from another log keep its CLI when the tuning history shows no change since)
 *           logBase }       added to log numbers in the texts written here (optional: 0 counts as the toolkit does,
 *                           1 as the viewer's log picker)
 *
 * A recommendation: { id, node, area, order, severity, title, text, parameter, scope, cliProfile, profile, rateProfile,
 * axis, from, fromSource, fromSets, to, direction, cli, evidence, rule, confidence, blockedBy, gate, causes, caveats, group,
 * groupSize, citedFids? }. profile is the PID profile (1-6, 0 = PID profile unknown, null for a global value), cliProfile its
 * CLI index; rateProfile the rate profile (1-6) of a rate result when the log shows it, else null. from is null when the
 * present value of that profile is unknown; fromSource says where from comes from (SPEC2 D12); fromSets { name: the value
 * at this time } for each name that the change sets, when it is known (the export comments). group 'C7:<axis>:<bin>' and
 * groupSize: the gains that report.cjs changes together, which have CLI text together or none, and which the export takes
 * together or refuses (null for any other). citedFids: the fid of every evidence row when the list is cut to maxEvidence.
 *   evidence  one row for each finding: { fid, module, id, log, profile, pidProfile, profileLabel?, axis, value, se, n,
 *             unit, threshold, source, text, times, summary, display, phase? } (display: catalog.cjs display { value,
 *             bound, limit }: what the views and the CLI file show, review V5) (text and source are the module's own, for the dialog
 *             to show as quoted toolkit text; summary is the STE summary of the finding: the worker's f.summary, else
 *             catalog.cjs). profile is the PID profile of the finding (the worker's pidProfile when it has one, see
 *             "Profiles"), profileLabel the toolkit label when it is different, pidProfile 1-6 or null
 *   node      the step of the tuning sequence (hierarchy.cjs homeOf); the list is sorted by step and row, then by the
 *             documented sequence inside the step (D, P, I, then FF on each axis: K7), the axis and the severity
 *   gate      null, or { by, held, profileBy } when hierarchy.cjs status (all PID profiles) calls the node Blocked:
 *             by = the steps before it that have a problem, profileBy = those that block the node in the status of the
 *             PID profile of the recommendation (SPEC2 D12; all profiles for one with no PID profile), held = those
 *             that hold this recommendation (a blockedBy entry each, no CLI). A step in by but not in held lets the
 *             change through, with a caveat: a decrease under a filter or output-range gate (the documentation holds
 *             increases), a problem on another axis or PID profile (not in profileBy), or a step that gates this one
 *             only through steps with no problem. Thus gate !== null if and only if the diagram of all profiles shows
 *             the node Blocked, and held is in profileBy (test/advice.test.cjs, test/hierarchy.test.cjs).
 *   causes    [{ rule, name, fids, ids, first, holds }]: the K rules of hierarchy.cjs whose upstream flags make this
 *             recommendation a possible result of them. A cause holds the CLI when an action or a check
 *             recommendation cites one of its upstream findings; a cause that is only a watch or information does not.
 * Every text here is written for the pilot in ASD-STE100 (docs/STE_GLOSSARY.md); no text of a finding is copied into
 * a recommendation (the evidence rows keep them, and the worker's catalog summary describes each finding).
 *
 * CLI text is written only for an 'action' with no blockedBy entry and no cause that holds, whose present value is known
 * for its profile, and only with the names in PARAMS. Advice only: nothing here talks to a flight controller. advise is
 * pure: no I/O, no clock, no randomness, and the input is not modified.
 *
 * Profiles (SPEC2 D12). A finding's profile is the log profile (1-based INFLIGHT_ADJUSTMENT value, 0 = arming profile
 * unknown) for gov, loop, F5, F6 and the new modules; the CLI index for D4; an axis name for F4; 'global' or 'start
 * profile N' for H. The worker's pidProfile (1-6, set only when the PID profile is known) comes first: advise reads every
 * finding with it in place of the label (resolved). logs[].armingProfile with armingConfirmed or a confirmed armingBasis
 * gives the label 0 of targetOf (C7). D4 shows a stale CLI value of a PID profile only when its cliSection.usable is true. CLI `profile q` is log profile q + 1 (pid.c get/set ADJUSTMENT_PID_PROFILE); the texts say "PID
 * profile 1-6" as the Configurator does, and only CLI text says `profile 0-5`. The header holds the values of the
 * profile that was active at arming only. A from-value of PID profile p comes only from the CLI section `profile p-1`,
 * from the header when p is the confirmed arming profile, or (C7, an estimate that gets no CLI) from the gain that
 * report.cjs recovered from the flights of p: never from the header of another profile. PID profile 0 is "PID profile
 * unknown": no CLI text and no export.
 *
 * Gear ratios (CLAUDE.md, SPEC2 section 6). The gear ratios in the configuration are correct. No text here doubts a gear ratio, a
 * pulley or a tooth count: a vibration line that is not a rotor harmonic is a resonance, a filter target (dynamic notch,
 * or a static notch for a fixed frequency) and a mechanical vibration to examine. G12 names motor_poles and the RPM
 * sensor only.
 *
 * Export (SPEC2 D11): exportScript(recs, picks, meta) writes the CLI file for the Configurator CLI tab ("Load from
 * file", or paste) and the Presets tab ("Load Backup"): comment lines first (provenance, the backup step, each change
 * with its from and to values, evidence and rule), then `batch start`, the `profile N` sets, the `rateprofile N` sets,
 * the global sets, the restore of the profile selection, and `save`. It writes only names in PARAMS, values in RANGE and
 * the filter floors, and only for action recommendations with CLI text. It writes a file only: nothing goes to a flight
 * controller.
 *
 * Guards (docs/DEVELOPMENT.md section 13): 1 no loop-gain raise while a filter flag stands (F1-F3 still in the analysed
 * header, F5, F6 that clears its 2-SE test, F10 yaw; C11 of the axis for D), no D cut for noise while another filter
 * flag stands, and no cyclic or tail change at all while a filter change with CLI is pending; 2 G12 and G1 flags block
 * governor and RPM-notch changes, and a G12 factor error beyond the RPM-notch tolerance also holds cyclic and tail
 * changes; 3 C2 / T8 on an axis: "authority, not gains", no raise CLI; no governor raise while T8 holds the tail at its
 * limit on that profile or G10 implicates the governor; 4 a flag below 2 SE is a watch without CLI; 5 relative steps
 * within 20 % (the GOVT cut by 1/3 included), documented absolute steps kept, every value within its firmware range
 * (RANGE); 6 no LPF below 60 Hz, no notch Q below 2.0; 7 profile 0 gets no CLI; 8 no governor gains where it does not
 * regulate; 9 D2 and unresolvable F5 flags are checks; 10 wag_report section 8 is ignored; 11 tuning sequence
 * (hierarchy.cjs); 12 PARAMS names only, and no RPM notch source the firmware rejects. Also: a measurement older than
 * the latest header change of its parameter (H) gets no CLI and no target (re-measure), a report.cjs prediction gets CLI
 * only when its recovered gain matches the configured one, and the gates and causes of hierarchy.cjs (above). Checks
 * whose claim analysis/fireball-0928/FINDINGS.md section 8 refuted on verification (REFUTED: C10 landed while moving,
 * T4, T6, T9, the G6 wording) give watches or checks that cite the refutation, never CLI; so does a single self-excited
 * burst (C5, T1). The texts give no guard number and no file name (review V3): a recommendation lists its sources in
 * r.sources, and its rule ends with one "Source: ..." sentence of quoted text (sourceSentences). A source that is a result
 * of a different helicopter says so; the numbers of the texts come from the logs of the analysis.
 *
 * Confidence (review V4): 'measured' when a measured result of the flights gives the recommendation, 'predicted' for a
 * gain decision of the gain model (C7), else 'advisory' (a value of the configuration, or no result).
 * From-values (review V11): fromSource names the loaded CLI dump when it gives the same value as the log header;
 * fromSources { name: source } when the names of one change have different sources.
 *
 * Severity: action = change something (CLI when it is one known parameter); check = inspect, the cause is not one
 * parameter or lies outside the log; watch = borderline or below 2 SE, fly again; info = context.
 * Estimates over several logs treat the flight as the independent unit (pooled) and use every measured log of the
 * group, not only the flagged ones.
 *
 * The thresholds of the health_track and health_more checks are read from those modules' DEFAULT_RULES (their findings
 * give them as text); both modules are optional in the app, and without one its checks have no findings. hierarchy.cjs
 * is optional too: without it a copy of its node, gate and K-rule tables here keeps the sequence, the gates and the
 * causes (K-rule steps and node titles then come from this copy). catalog.cjs is optional: it gives the STE summary of
 * an evidence row when the worker did not put one on the finding.
 *
 * The phase checks of health_phase.cjs (SPEC2 D13, section 6) give findings with phase, unit and thin, and these fields
 * (health_phase judge): D7 bench, class ('flight' | 'bench'), flights [{ t0, t1, ... }], phaseSeconds { idle, spoolup,
 * ground, flight, spooldown }; G15 value (the largest yaw rate on the ground in a spool-up, deg/s), throttlePctPerS
 * { mean, se }, impliedSpoolupTime, seconds { mean, se }; G16 value (the largest headspeed error, a signed fraction),
 * reference, throttleStepPct, settleS; G17 value (kicks), byKind, events [{ t, kind, phase }]; G18 value (rms headspeed
 * change / headspeed), se, headspeed; C15 axis, value (deg/s rms), hz, hzSe, growth, growthSe (/s). Their limits come from
 * health_phase DEFAULT_RULES (optional, as health_track and health_more). The texts use the fields that a finding has.
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
    harmonicTol: 0.01,      // F5: a line within this part of an integer order k of the rotor is main rotor harmonic k
    weakPass: 0.5,          // F5: a main rotor harmonic weaker than the strongest line of its log and PID profile gets an RPM
                            // notch filter on an axis where the gyro filters let this part of it or more through (measured)
    pidProfiles: 6,         // PID profiles a `diff all` prints
    rateProfiles: 6,        // rate profiles of 4.6 (CONTROL_RATE_PROFILE_COUNT on a target with more than 256 kB flash)
    commentWidth: 100,      // characters of an export comment line (the firmware CLI buffer holds 256)
    // the sources of the rules (review V3): the "Source:" sentences after a rule (sourceSentences), in the words of the
    // pilot. No file name, line or section: the developer references are in the comments of this file only. A result
    // from a different helicopter says so, and it is never a value of the logs of the analysis. The text outside the
    // quotation marks is STE; quoted documentation text stays as written
    source: {
        sigmas: 'toolkit rule: a value with an SE must be more than its limit by 2 SE',
        maxStep: 'toolkit rule, no flight test: the gain model tests steps of 0.8 to 1.2 of a gain',      // DEVELOPMENT.md section 10
        dirStep: 'toolkit rule, no flight test: the smallest step of the gain model, for a check that gives only a direction',
        minLpfHz: 'Rotorflight documentation, "First flight and filter tuning": "not advised to lower it below 60hz"',
        noteLpfHz: 'Rotorflight documentation, "First flight and filter tuning", and the limit of check F2',
        lpfHz: 'Configurator help text: "With RPM Filters or Dynamic Notch Filters, one extra filter is needed around 100Hz"',  // MSG gyroLowpassFilterHelp
        minNotchQ: 'Rotorflight documentation and Configurator help text: a Q of less than 2.0 "will greatly increase filter delay"',  // FILT, MSG gyroDynamicNotchQHelp
        govSteps: 'Rotorflight documentation, "Tune the governor": "increments of 10 for the F-gain, increments of 25 for the I-gain and increments of 10 for the P-gain", for an increase',  // TUNING_KNOWLEDGE 9.2
        govCut: 'Rotorflight documentation, "Tune the governor": I "until it starts playing up, then reduce it with 1/3", P "till there are slight oscillations, then reduce it with 1/3"',  // TUNING_KNOWLEDGE 6, 9.2
        tailDStep: 'a recommendation from other pilots ("HeliFreak"): steps of 10 for the tail D gain',     // [COM] HF-970331
        ttaStep: 'Rotorflight documentation, "Tail torque assist": "in increments of 10"',
        tta: 'Rotorflight documentation, "Tail torque assist": the main motor helps the tail when the tail is at its limit',
        gainTolerance: 'toolkit rule, no flight test: the tolerance of the gain model',                   // report.cjs RULES.gainTolerance
        minLogHz: 'toolkit rule, no flight test: the Nyquist frequency of the rotor and tail harmonics',   // health_setup.cjs D1 minHz, TUNING_KNOWLEDGE 7.4
        mixtI: 'Rotorflight documentation, "Mixer tab": the temporary "I-gain ~200" procedure, "MAKE SURE TO TURN THEM BACK"',
        maxEvidence: 'a limit of the display',
        // analysis/fireball-0928/FINDINGS.md section 8, TAIL-EVENT3
        minBursts: 'toolkit rule, no flight test: 1 oscillation cannot show the difference between the loop gain, the load, a time delay and the battery, from a result on a different helicopter ("SAB Fireball"), not from the logs of this analysis',
        filteredPass: 'toolkit rule, no flight test: no filter change if the gyro filters let less than 5 % of a line through',  // wag_report.cjs section 8.3, health_more.cjs vib.pass
        harmonicTol: 'toolkit rule, no flight test: a line in 1 % of an integer order of the rotor is a main rotor harmonic',
        weakPass: 'toolkit rule, no flight test: a weaker main rotor harmonic gets an RPM notch filter if the gyro filters let 50 % or more of it through',
        maxMainHarmonic: 'firmware 4.6.0: the RPM notch filter sources 11 to 18 are the main rotor harmonics 1 to 8, and with a different source the helicopter does not arm',  // rpm_filter.c rpmFilterInit
        pidProfiles: 'firmware 4.6.0: `diff all` and `dump all` show all 6 PID profiles, and `diff` or `dump` without `all` shows only the active PID profile',  // cli.c printConfig
        rateProfiles: 'firmware 4.6.0: 6 PID profiles and 6 rate profiles on a target with more than 256 kB flash, and less on smaller targets',  // target/common_pre.h
        // analysis/gaui-x4/FINDINGS.md section 10 (BENCH-YAWSPIN)
        spoolup: 'a result on a different helicopter ("Gaui X4 II", 2026-10-04), not from the logs of this analysis: with a throttle ramp of 10.1 %/s, the helicopter turned in 5 of 5 bench runs, and with 3.4 %/s to 4.1 %/s, in 0 of 7 flights',
        handover: 'firmware 4.6.0: SPOOLUP stops at 0.99 of the target, and the I-term starts with the throttle at that time',  // TUNING_KNOWLEDGE.md 3.3, governor.c:932-977
        // analysis/gaui-x4/FINDINGS.md 1.1 (GROUND-LIFTOFF-OSC)
        liftoff: 'a result on a different helicopter ("Gaui X4 II", 2026-10-04), not from the logs of this analysis: in 3 of 3 flights with the collective up before ACTIVE, a roll oscillation at 8.3 Hz to 8.7 Hz occurred on the skids, and in the 1 flight without, it did not occur',
        batch: 'firmware 4.6.0: in a command batch, `save` does not save after a command error, and `profile N` changes the PID profile that `save` keeps',  // cli.c cliBatch, prepareSave, changePidProfile
        firmware: 'firmware 4.6.0',
        fallback: 'firmware 4.6.0, governor.c: in FALLBACK the throttle is the governor I + F x (100 - gov_fallback_drop) / 100, and RECOVERY starts from the present headspeed and increases the throttle at the rate of gov_recovery_time',
        community: 'a recommendation from other pilots',
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
    gov_p_gain: [0, 250], gov_i_gain: [0, 250], gov_f_gain: [0, 250], gyro_rpm_notch_preset: [0, 3], yaw_inertia_precomp_gain: [0, 250], gov_spoolup_time: [0, 600],  // settings.c:959
    // round 3 M2, the filter search (filter_tune.cjs FW_RANGE): settings.c:672-681 (LPF_MAX_HZ 1000, DYN_NOTCH_COUNT_MAX 8), 1124-1134
    dyn_notch_count: [0, 8], dyn_notch_min_hz: [10, 200], dyn_notch_max_hz: [100, 500], gyro_notch1_hz: [0, 1000], gyro_notch1_cutoff: [0, 1000],
    gyro_notch2_hz: [0, 1000], gyro_notch2_cutoff: [0, 1000], gyro_rpm_notch_min_hz: [1, 100] };
for (const ax of lib.AXES) for (const k of ['p', 'i', 'd', 'f', 'b']) RANGE[`${ax}_${k}_gain`] = [0, 1000];
for (const ax of lib.AXES) for (const k of ['d', 'gyro']) RANGE[`${ax}_${k}_cutoff`] = [0, 250];   // settings.c:1124-1134 (VAR_UINT8, PID profile)

// Thresholds for the 2-SE test of checks whose judge compares means only, or whose estimate advice pools over logs (F10,
// C14; T14 in its generator): [threshold, side], side 1 flags above, -1 below, 0 on |value|; null takes the finding's
// numeric threshold. From the modules' DEFAULT_RULES, which health_report RULES equals and the app judges with
// (js/tuning_worker.js); the governor judge applies its own 2-SE test. health_track and health_more write their
// thresholds as text, so their numbers come from their DEFAULT_RULES here; both are optional in the app
// (js/tuning_worker.js OPTIONAL): without one its checks have no findings, and its numbers here are null.
const LR = loop.DEFAULT_RULES, SR = setup.DEFAULT_RULES, GR = gov.DEFAULT_RULES;
const optional = (load) => { try { return load(); } catch (e) { return null; } };
const TRACK = optional(() => require('./health_track.cjs')), MORE = optional(() => require('./health_more.cjs'));
const HIER = optional(() => require('./hierarchy.cjs'));
const CAT = optional(() => require('./catalog.cjs'));
const PHASE = optional(() => require('./health_phase.cjs'));
const RESC = optional(() => require('./health_rescue.cjs')), LIMS = optional(() => require('./health_limits.cjs'));
const CFGM = optional(() => require('./health_config.cjs')), POW = optional(() => require('./health_power.cjs'));
const DSM = optional(() => require('./datasets.cjs'));   // the configurations (round 3 M1): A/B and slopes
const TR = (TRACK && TRACK.DEFAULT_RULES) || {}, MR = (MORE && MORE.DEFAULT_RULES) || {}, PR = (PHASE && PHASE.DEFAULT_RULES) || {};
const RR = (RESC && RESC.DEFAULT_RULES) || {}, LR2 = (LIMS && LIMS.DEFAULT_RULES) || {}, RRULE = (RESC && RESC.RULE) || {};
const CR = (CFGM && CFGM.DEFAULT_RULES) || {}, PWR = (POW && POW.DEFAULT_RULES) || {};
const ruleNum = (R, id, k) => R[id] && typeof R[id][k] === 'number' ? R[id][k] : null;
const OSC = (TRACK && TRACK.RULE && TRACK.RULE.osc) || {}, ONSET = OSC.onset || {};          // health_track RULE: the wag_report.cjs onset rule
const TTRACK = (TRACK && TRACK.RULE && TRACK.RULE.track) || {};                              // health_track RULE: the C12 / T11 low-pass and setpoint gate
const MRULE = (MORE && MORE.RULE) || {};                                                    // health_more RULE: the F10 and F11 bands
const SIGMA = { C3: [LR.C3.iShare, 0], T9: [LR.T9.iShare, 0], C11: [LR.C11.share, 1], T5: [LR.T5.ratio, 1], T6: [LR.T6.kick, 1], T7: [LR.T7.r, 0], F6: [SR.F6.minDb, -1],
    C12: [ruleNum(TR, 'C12', 'flag'), 1], T11: [ruleNum(TR, 'T11', 'flag'), 1], C13: [ruleNum(TR, 'C13', 'flag'), 1], T12: [ruleNum(TR, 'T12', 'flag'), 1], R1: [ruleNum(TR, 'R1', 'flag'), 1],
    F10: [ruleNum(MR, 'F10', 'share'), 1], C14: [ruleNum(MR, 'C14', 'flag'), 0] };

// The source of a module's rule in STE words: the modules write "pipeline, unvalidated", "doc", "firmware" or "log header"
// first; the rest of their text is quoted as it is (not ours to rewrite)
function src(s, file) {
    const t = String(s || ''), head = /^pipeline, unvalidated/.test(t) ? 'toolkit, no flight test' : /^pipeline/.test(t) ? 'toolkit' : /^firmware/.test(t) ? 'firmware'
        : /^doc\b/.test(t) ? 'Rotorflight documentation' : /^log header/.test(t) ? 'log header' : null, rest = head ? t.replace(/^(pipeline, unvalidated|pipeline|firmware|doc|log header)[;:,]?\s*/, '') : t;
    return [head, rest ? `"${rest.replace(/"/g, "'")}"` : null].filter(Boolean).join(', ') + (file ? `, ${file}` : '');
}
const ruleSrc = (R, id, file) => src(R[id] && R[id].source || 'pipeline, unvalidated', file);
// the "Source:" sentence of a rule (review V3): one sentence after the rule, the same form in each rule and in the CLI file.
// Each source is quoted text (Rule 8.6: a reference, not an instruction), with no period in it (the CLI file has one sentence
// on each comment line)
const quoteSource = (s) => `"${String(s).trim().replace(/\.+$/, '').replace(/\.\s+(?=\S)/g, ', ').replace(/"/g, "'")}"`;
const sourceSentences = (list) => { const l = [...new Set((list || []).map(s => String(s || '').trim()).filter(Boolean))];
    return l.length ? `${l.length === 1 ? 'Source' : 'Sources'}: ${and(l.map(quoteSource))}.` : ''; };

// Claims that analysis/fireball-0928/FINDINGS.md section 8 refuted on verification, by the check that makes them: advice
// from these checks cites the refutation and stays below 'action'
// (FB8 = analysis/fireball-0928/FINDINGS.md section 8: CYC-LANDED, TAIL-FREQ, TAIL-PRECOMP, TAIL-FF, PWR-CEIL). The
// numbers of that helicopter are labelled as its results, never as values of the logs of the analysis (review V3)
const FB = 'On a different helicopter ("SAB Fireball"), a test showed', NOT_YOURS = 'This result is not from your logs.';
const REFUTED = {
    C10: `The test for "landed" with the rotor at speed uses periods of 1 s, and vibration can cause its rate condition. ${FB} that this test is not correct. ${NOT_YOURS}`,
    T4: `A frequency in the band of 5 Hz to 16 Hz can follow the slope of the spectrum, not a mode. The gain sets can also be at different headspeeds. ${FB} these two errors. ${NOT_YOURS}`,
    T6: `The kick can follow the collective or the yaw stick of the pilot, not the torque change. ${FB} that 72 of 78 kicks followed the collective. ${NOT_YOURS} Check T7 measures the precompensation.`,
    T9: `The I-term part comes from the level before the maneuver, which can be a speed change. ${FB} a part of -0.10 ± 0.12 in hover. ${NOT_YOURS}`,
    G6: `The headspeed can decrease before the throttle gets to its maximum. ${FB} that 56 % to 71 % of each decrease started before the maximum. ${NOT_YOURS} Thus, the throttle limit is not the only cause.`,
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
    yaw_inertia_precomp_gain: ['profile', 'yaw_inertia_precomp', 0, 0],   // the T14 target: its value of each PID profile; T14 is a check, never CLI
    gyro_lpf1_type: ['global', 'gyro_soft_type', null, 'FIRST_ORDER'], gyro_lpf1_static_hz: ['global', 'gyro_lowpass_hz', null, 100],
    gyro_lpf2_static_hz: ['global', 'gyro_lowpass2_hz', null, 50], gyro_lpf1_dyn_min_hz: ['global', 'gyro_lowpass_dyn_hz', 0, 0],
    dyn_notch_q: ['global', 'dyn_notch_q', null, 25], gyro_rpm_notch_preset: ['global', 'gyro_rpm_notch_preset', null, 2],
    gov_spoolup_time: ['global', null, null, 100],   // not in the log header: the CLI dump only (TUNING_KNOWLEDGE 3.2, settings.c:959)
    // round 3 M2: the names that the filter search writes (filter_tune.cjs movesOf), with the defaults of health_setup PAIRS_GLOBAL
    // and the 4.6 defaults of pg/gyro.c (static notches 0: off)
    gyro_lpf2_type: ['global', 'gyro_soft2_type', null, 'NONE'], dyn_notch_count: ['global', 'dyn_notch_count', null, 6], dyn_notch_min_hz: ['global', 'dyn_notch_min_hz', null, 20],
    dyn_notch_max_hz: ['global', 'dyn_notch_max_hz', null, 240], gyro_rpm_notch_min_hz: ['global', 'gyro_rpm_notch_min_hz', null, 20],
    gyro_notch1_hz: ['global', 'gyro_notch_hz', 0, 0], gyro_notch2_hz: ['global', 'gyro_notch_hz', 1, 0], gyro_notch1_cutoff: ['global', 'gyro_notch_cutoff', 0, 0], gyro_notch2_cutoff: ['global', 'gyro_notch_cutoff', 1, 0],
});
for (const [ax, bw] of [['roll', [50, 15]], ['pitch', [50, 15]], ['yaw', [100, 20]]]) { PARAMS[`${ax}_gyro_cutoff`] = ['profile', `${ax}BW`, 0, bw[0]]; PARAMS[`${ax}_d_cutoff`] = ['profile', `${ax}BW`, 1, bw[1]]; }
// the feature names of 4.6 (cli.c featureNames: `feature NAME` turns it on, `feature -NAME` off): the export writes no other name
const FEATURE_NAMES = ['RX_PPM', 'RX_SERIAL', 'SOFTSERIAL', 'GPS', 'RANGEFINDER', 'TELEMETRY', 'RX_PARALLEL_PWM', 'RX_MSP', 'RSSI_ADC', 'LED_STRIP', 'DASHBOARD', 'OSD', 'CMS', 'RX_SPI',
    'GOVERNOR', 'ESC_SENSOR', 'FREQ_SENSOR', 'DYN_NOTCH', 'RPM_FILTER'];
for (const ax of lib.AXES) for (const k of ['source', 'q', 'center']) PARAMS[`gyro_rpm_notch_${k}_${ax}`] = ['global', `gyro_rpm_notch_${k}_${ax}`, 'all', null];

// One row per parameter group of TUNING_KNOWLEDGE.md sections 1-11 (the coverage matrix of the survey):
// 'section|area|group|parameters (comma separated)|checks|cli = settings outside the header|why, where no check decides|nolog'
// nolog marks the groups no log can inform (from docs/TUNING_KNOWLEDGE.md sections 2-9: settings that no logged field shows): with no check
// they are 'not-assessable'; a group without a check that a log could inform is 'no-check' (the app has none).
const COVERAGE = [
    '1|logging|PID mode|pid_mode||cli|The log does not record pid_mode. Modes other than 3 and 4 use only the F-term. A log cannot show the difference between mode 3 and mode 4. All recommendations are for mode 3.',
    '1|logging|Loop rates|pid_process_denom,filter_process_denom|D1 F8||',
    '1|logging|Log rate|blackbox_rate_denom|D1 F9||',
    '1|logging|Recorded fields|blackbox_log_*|D3||',
    '1|logging|Flights and bench runs|(no parameter)|D7||The analysis uses only the logs that have a flight. A bench run gets no flight check.',
    '1|logging|Debug mode|debug_mode,debug_axis|||The log header gives the value. GOVT uses the debug mode GOVERNOR at 1 kHz to tune the governor.',
    '2|cyclic|Cyclic P|roll_p_gain,pitch_p_gain|C5 C6 C7 C12||',
    '2|cyclic|Cyclic I|roll_i_gain,pitch_i_gain|C1 C3 C6||',
    '2|cyclic|Cyclic D|roll_d_gain,pitch_d_gain|C11 C5 F4||',
    '2|cyclic|Cyclic F|roll_f_gain,pitch_f_gain|C3 C4 C7||',
    '2|cyclic|Cyclic B|roll_b_gain,pitch_b_gain|C4 C13||A B gain that is too low gives a time delay (check C13). A B gain that is too high gives an oscillation at the stops (check C4).',
    '2|cyclic|HSI offset gain|roll_o_gain,pitch_o_gain|C9||This check gives information only.',
    '2|cyclic|HSI offset limit|offset_limit|||No check. A check can use axisO at its limit.',
    '3|cyclic|Error limit|error_limit|C1 L6||',
    '3|cyclic|I-term relax|iterm_relax_type,iterm_relax_cutoff|C4 C6||',
    '3|cyclic|I-term relax level|iterm_relax_level||cli|The log does not record this value, and no check examines it.|nolog',
    '3|cyclic|Cyclic I-term decrease|error_decay_time_cyclic,error_decay_limit_cyclic|C10||',
    '3|cyclic|Ground I-term decrease|error_decay_time_ground|C10||',
    '3|tail|Yaw I-term decrease|error_decay_time_yaw,error_decay_limit_yaw||cli|The documentation gives no symptom.|nolog',
    '3|precondition|Airborne condition|rc_threshold|C10|cli|',
    '3|cyclic|offset_flood_relax_level and cutoff|offset_flood_relax_level,offset_flood_relax_cutoff||cli|Its effect is very small.|nolog',
    '4|cyclic|Cyclic cross-coupling|cyclic_cross_coupling_gain,cyclic_cross_coupling_ratio,cyclic_cross_coupling_cutoff|C8||This check gives information only, with no limit.',
    '4|cyclic|Pitch collective FF|pitch_collective_ff_gain|C14||',
    '5|rates|Rates type|rates_type|SETUP||Log header: 6 (ROTORFLIGHT) is the default of 4.6.',
    '5|rates|Rates and expo|roll_rc_rate,pitch_rc_rate,yaw_rc_rate,roll_expo,pitch_expo,yaw_expo,roll_srate,pitch_srate,yaw_srate|C2 T8||A rate that is more than the output range gives a flat top on the gyro rate.',
    '5|rates|Response time|roll_response,pitch_response,yaw_response,collective_response|R1||',
    '5|rates|Acceleration limit|roll_accel_limit,pitch_accel_limit,yaw_accel_limit,collective_accel_limit|R1||',
    '5|rates|Cyclic rate limit|cyclic_ring,cyclic_polar||cli|It sets a limit on the setpoint. A log cannot show it.|nolog',
    '5|rates|Setpoint boost|setpoint_boost_gain,setpoint_boost_cutoff||cli|It is part of the setpoint, and no check examines it.',
    '5|rates|rc_smoothness|rc_smoothness|R1|cli|',
    '5|rates|Deadband|deadband,yaw_deadband|||No check. A check can use the yaw rcCommand at the stops.',
    '5|rates|Yaw deadband gains and filter|yaw_dynamic_ceiling_gain,yaw_dynamic_deadband_gain,yaw_dynamic_deadband_filter,yaw_dynamic_deadband_cutoff||cli|The documentation does not give it, and a log cannot show it.|nolog',
    '6|tail|Yaw P|yaw_p_gain|T1 T4 C7 T11||',
    '6|tail|Yaw I|yaw_i_gain|T2||',
    '6|tail|Yaw D|yaw_d_gain|T1 F10||',
    '6|tail|Yaw F|yaw_f_gain|T9||',
    '6|tail|Yaw B|yaw_b_gain|||The documentation gives no procedure.',
    '6|tail|Stop gains|yaw_cw_stop_gain,yaw_ccw_stop_gain|T5||',
    '6|tail|Collective precompensation|yaw_collective_ff_gain|T6 T7 T15||',
    '6|tail|Precompensation cutoff|yaw_precomp_cutoff|||No check measures the time delay of the kick. Check T6 measures only the amplitude and the sign of the kick.',
    '6|tail|Cyclic precompensation|yaw_cyclic_ff_gain|||No check. A check can use the yaw error when the cyclic starts to move.',
    '6|tail|Inertia precompensation|yaw_inertia_precomp_gain,yaw_inertia_precomp_cutoff|T14||The documentation gives no procedure.',
    '6|mechanical|Tail mechanical parts and limit|tail_rotor_mode,tail_motor_idle,tail_center_trim,mixer input SY,main_rotor_dir|T8 T13 L4|cli|',
    '6|tail|TTA|gov_tta_gain,gov_tta_limit,gov_tta_filter,swash_tta_precomp|||Only for a tail motor, and no check examines it. A check can use mixer[2] at tail_motor_idle when the error follows the torque.',
    '7|governor|Governor mode|gov_mode|G0 D4||',
    '7|governor|Governor F|gov_f_gain|G3 G4||',
    '7|governor|Governor I|gov_i_gain|G9 G2||',
    '7|governor|Governor P|gov_p_gain|G9 G5||',
    '7|governor|Governor D|gov_d_gain|||GOVT: "Unless you\'re flying a 500+ heli you probably won\'t need D".',
    '7|governor|Governor gain|gov_gain|G9 G10||',
    '7|governor|Governor FF weights|gov_collective_ff_weight,gov_cyclic_ff_weight,gov_yaw_ff_weight,gov_collective_curve|G3 G4|cli|',
    '7|governor|Governor limits|gov_p_limit,gov_i_limit,gov_d_limit,gov_f_limit|G3 G7|cli|',
    '7|governor|Governor headspeed|gov_headspeed|G1 G2|cli|',
    '7|governor|Throttle limits|gov_max_throttle,gov_min_throttle|G6 G7 L1|cli|',
    '7|governor|Voltage compensation|gov_use_voltage_comp|G8 G11 G13 D5|cli|',
    '7|governor|Governor filters|gov_rpm_filter,gov_pwr_filter,gov_ff_filter,gov_d_filter|G1 G10|cli|',
    '7|governor|Ramp times|gov_startup_time,gov_spoolup_time,gov_tracking_time,gov_recovery_time,gov_spooldown_time|G14 G15 G16 G19|cli|',
    '7|governor|Autorotation values|gov_handover_throttle,gov_autorotation_timeout,gov_auto_throttle,gov_idle_throttle,gov_throttle_hold_timeout,gov_bypass_throttle|G14 G16 G18|cli|',
    '7|governor|Throttle channel type|gov_throttle_type||cli|No check. A check can use the steps of govRequest.',
    '7|governor|Governor FALLBACK|gov_fallback_drop,gov_use_fallback_precomp|G1 G19|cli|',
    '7|governor|PID spool-up and minimum throttle|gov_use_pid_spoolup,gov_use_dyn_min_throttle,gov_dyn_min_throttle||cli|A log cannot show it: motor[0] shows only the minimum.|nolog',
    '8|precondition|Motor poles and gear ratios|motor_poles,main_rotor_gear_ratio,tail_rotor_gear_ratio|G12 F5 F6|cli|The gear ratios in the configuration are correct. Check G12 examines motor_poles and the RPM sensor.',
    '8|precondition|Motor RPM filter|motor_rpm_lpf,motor_rpm_factor||cli|A log cannot show it.|nolog',
    '8|precondition|RPM source and ESC signal|dshot_bidir,motor_pwm_protocol,motor_pwm_rate,use_unsynced_pwm,feature FREQ_SENSOR,freq_input_*|G1||The ESC telemetry is too slow for an RPM source (RPMM).',
    '8|precondition|ESC throttle range|min_throttle,max_throttle|||The log header records them (`minthrottle`, `maxthrottle`). No check examines them.',
    '8|precondition|ESC and motor start|(no parameter)|G17||Check G17 finds motor steps that the throttle does not cause. The ESC adjustments are not in the CLI.',
    '8|precondition|ESC telemetry|esc_sensor_*,blackbox_log_esc|||No check uses the ESC telemetry: `Tesc`, `EscV`, `EscI`, `EscThr`, and `Ibat` and `Vbat` when the ESC is the battery sensor. Check D3 shows only the fields that the log has, and G12 uses gyroRAW lines, not `EscRPM`.',
    '9|filters|Gyro LPF1|gyro_lpf1_type,gyro_lpf1_static_hz|F1 F2 F11||',
    '9|filters|Gyro LPF2|gyro_lpf2_type,gyro_lpf2_static_hz|F1 F2||',
    '9|filters|Gyro LPF1 minimum and maximum|gyro_lpf1_dyn_min_hz,gyro_lpf1_dyn_max_hz|F1 F2||',
    '9|filters|Gyro sensor LPF and decimation|gyro_hardware_lpf,gyro_decimation_hz|||The log header gives them as information only (SETUP).',
    '9|filters|Notch filters at one frequency|gyro_notch1_hz,gyro_notch1_cutoff,gyro_notch2_hz,gyro_notch2_cutoff|||Check F7, for lines that do not move with the rpm, does not operate in the app.',
    '9|filters|Dynamic notch filter|feature DYN_NOTCH,dyn_notch_count,dyn_notch_q,dyn_notch_min_hz,dyn_notch_max_hz|F3 F8||',
    '9|filters|RPM notch filters|feature RPM_FILTER,gyro_rpm_notch_preset,gyro_rpm_notch_min_hz,gyro_rpm_notch_source_*,gyro_rpm_notch_q_*,gyro_rpm_notch_center_*|F3 F5 F6 F9||',
    '9|filters|PID bandwidth filters|roll_gyro_cutoff,pitch_gyro_cutoff,yaw_gyro_cutoff,roll_d_cutoff,pitch_d_cutoff,yaw_d_cutoff,roll_b_cutoff,pitch_b_cutoff,yaw_b_cutoff|F4 C13 T12 F10||',
    '9|filters|Vibration level|(no parameter)|F10 F11 C11||The documentation gives no number (FILT), and check F7 does not operate in the app.',
    '10|mechanical|Cyclic mixer limits|mixer input SR,mixer input SP|C2 L3|cli|',
    '10|mechanical|Collective range|mixer input SC|C2 L2 L7||',
    '10|mechanical|Swash plate limits|swash_ring,swash_pitch_limit|C2|cli|',
    '10|mechanical|Swash plate phase|swash_phase|C8|cli|',
    '10|mechanical|Swash plate geometry and trims|swash_type,swash_*_trim,swash_geo_correction,collective_tilt_correction_pos,collective_tilt_correction_neg||cli|A log cannot show it. A constant offset of axisI can be a sign of it.|nolog',
    '10|mechanical|Ground resonance|(no parameter)|C15||Check C15 finds an oscillation on the skids before liftoff. The blade grips and the dampers can change it.',
    '10|mechanical|Servos|servo n mid min max rneg rpos rate speed flags|L5|cli|The servo minimum and maximum are limits for the mechanical parts, not for the range (SERVO). Check L5 finds the periods with a servo at its limit. No check examines the servo speeds.',
    '11|precondition|Rescue|rescue_*|D9 D6 D8 G19 T15|cli|The log header does not record rescue_mode. The log records a rescue only when it occurs. Checks G19, T15 and D8 examine each rescue.',
    '11|precondition|Level modes|angle and horizon values (header levelPID)|D6||A log cannot show them, and the analysis does not use these parts of the log.',
    '11|precondition|Battery and cells|battery_meter,battery_cell_count,vbat_min_cell_voltage,vbat_warning_cell_voltage,vbat_max_cell_voltage|D5 G13 G8 P1 P2||The log header records the cell voltage levels (`vbatcellvoltage`). The analysis finds the cell count from the battery voltage.',
    '11|precondition|Gyro range limit|gyro_overflow_detect|||If the gyro gets to the end of its range, the firmware sets the P-term, I-term, D-term and F-term to 0. No check examines it.',
];

// fields a check needs (health_setup D3), for the needs-fields status of the coverage rows
const RAW = ['gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]'], GOVF = ['govTarget', 'govSum'];
const FIELDS = { F5: RAW, F6: RAW, F11: RAW, G0: GOVF, G2: GOVF, G3: GOVF.concat('setpoint[3]'), G4: GOVF.concat('setpoint[3]'), G5: GOVF, G9: GOVF,
    G6: ['motor[0]'], G7: ['motor[0]'], G8: ['motor[0]', 'Vbat'], G11: ['motor[0]', 'Vbat'], D5: ['Vbat'], G13: ['Vbat'], P1: ['Vbat', 'motor[0]'], P2: ['Vbat', 'Ibat'], C9: ['axisO[0]', 'axisO[1]'], T6: ['setpoint[3]'] };
const ELSEWHERE = ['T3', 'T10', 'F7'];  // section-10 checks that no module of the app runs
// D3 skip names of checks that exist in no module: battery current (Ibat) and G12 from the ESC rpm (EscRPM); no check
// reads Ibat, Tesc or any ESC telemetry field (coverage row 'ESC telemetry')
const NO_CHECK = /^(power\/current|G12 \(independent rpm\)) \(/;
const NEW = { 'health_config.cjs': ['D9'], 'health_power.cjs': ['P1', 'P2'], 'health_track.cjs': ['C5', 'T1', 'C12', 'T11', 'C13', 'T12', 'R1'], 'health_more.cjs': ['D6', 'F10', 'F11', 'T13', 'C14', 'T14', 'G14'],
    'health_phase.cjs': ['D7', 'G15', 'G16', 'G17', 'G18', 'C15'], 'health_rescue.cjs': ['G19', 'T15', 'D8'], 'health_limits.cjs': ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'] }; // the checks added for the Tuning dialog (docs/DEVELOPMENT.md section 13)

const UNITS = { D1: 'Hz', D2: 'frames', D3: 'checks', D4: 'values', D5: 'V', G0: 'samples', G1: 'entries', G2: 'fraction', G3: 'fraction', G4: 'fraction', G5: 's', G6: '%',
    G7: 'fraction', G8: 'ratio', G9: 'prominence', G10: 'coherence', G11: '% points per pack', G12: 'x headspeed/60', G13: 'V/cell', C1: 's', C2: 's', C3: 'fraction', C4: '%',
    C6: 'prominence', C8: 'deg/s per deg/s^2', C9: 'deg/s', C10: 's', C11: 'fraction', T2: 'prominence', T4: 'fraction', T5: 'ratio', T6: 'deg/s', T7: 'r', T8: 's',
    T9: 'fraction', F1: 'stages', F2: 'Hz', F3: 'Q', F4: 'Hz', F5: 'x rotor', F6: 'dB', F8: 'on/off', F9: 'notches' };
const RATES_TYPES = ['NONE', 'BETAFLIGHT', 'RACEFLIGHT', 'KISS', 'ACTUAL', 'QUICK', 'ROTORFLIGHT']; // TUNING_KNOWLEDGE 2.12

// ---------------------------------------------------------------------------------------------
// The tuning sequence: hierarchy.cjs, or this copy of its tables when it does not load
// ---------------------------------------------------------------------------------------------

// id kind step row lane title | home checks (SETUP rules, C7, L5 and L6 by axis as hierarchy.cjs homeOf): the prerequisites
// (step 0) and the tuning blocks (SPEC3 A, B)
const NODES0 = ['logging prereq 0 0 prereq Blackbox log|D1 D2 D3 D4 H', 'rpm prereq 0 1 prereq RPM signal and motor poles|G1 G12 G20', 'power prereq 0 2 prereq Battery and power|D5 G13 G11 P1 P2',
    'mechanics prereq 0 3 prereq Mechanical parts|F7 C15 T4 SETUP:i_gain', 'rescue prereq 0 4 prereq Rescue|D9 D8 D6', 'controller prereq 0 5 prereq Flight controller|SETUP:pid_mode SETUP:rates_type D7 R1 L7',
    'filters block 1 0 main Filters|F1 F2 F3 F4 F5 F6 F8 F9 F10 F11 C11', 'governor block 2 0 main Governor|G0 G2 G3 G4 G5 G6 G7 G8 G9 G10 G14 G15 G16 G17 G18 G19 L1',
    'cyclic block 3 0 cyclic Cyclic gains|C1 C2 C3 C4 C5 C6 C9 C12 C13 C7:cyclic L2 L3', 'tail block 3 1 tail Tail gains|T1 T2 T3 T9 T10 T11 T12 C7:yaw',
    'cycomp block 4 0 cyclic Cyclic compensation|C8 C10 C14', 'tailcomp block 4 1 tail Tail compensation and authority|T5 T6 T7 T8 T13 T14 T15 L4'].map(s => { const [head, checks] = s.split('|'), [id, kind, step, row, lane, ...title] = head.split(' ');
    return { id, kind, step: +step, row: +row, lane, order: kind === 'prereq' ? 0 : +step, title: title.join(' '), checks: checks ? checks.split(' ') : [] }; });
const GATES0 = 'rpm>filters rpm>governor power>governor mechanics>cyclic mechanics>tail controller>cyclic controller>tail filters>cyclic filters>tail'
    .split(' ').map(s => { const [from, to] = s.split('>'); return { from, to, kind: 'gate' }; });
// K rules: id|name|symptoms|upstream (rules.json of the research; the steps of each rule are in hierarchy.cjs only)
const RULES0 = ['K1|D-term noise|C11 F10|F5 F6 F1 F8 F4 G12 G1', 'K2|Fast oscillation|C5 T1|C11 F10 F11 F2 G10 T4 C2 T8 G13 D5 G1', 'K3|Slow oscillation|C6 T2|T4 C9 G9 G10 C1',
    'K4|Time delay from setpoint to gyro|C13 T12|F11 F2 F3 F4 C2 T8', 'K5|Tracking error|C12 T11|C2 T8 C1 C5 T1 C6 T2 C13 T12 C3 T9 C8 C9 C14 G3', 'K6|Overshoot at stops|C4 T5|C3 T9 C1 C2 T8 R1 G10 T4',
    'K7|Feedforward|C3 T9|C2 T8 C1 C5 C6 T1 T2', 'K8|Yaw error at collective changes|T6 T7 T14|T8 T13 G3 G4 G9 G10', 'K9|Yaw I-term in hover|T13|T8 T7', 'K10|Cyclic I-term at its limit|C1|C2 C10 C14 C9 SETUP',
    'K11|Headspeed control|G2 G3 G4 G5 G9|G1 G12 G6 G7 G11 G13 D5 G0 G14 G8 P1', 'K12|Throttle reserve|G6 G7|G11 G13 D5 P1', 'K13|Tail oscillation from the governor|T1 T2|G10 G9', 'K14|Tail authority|T8|G3 G6',
    'K16|Pitch movement with the collective|C14|C2 C9', 'K19|Log rate|F5 F6 F9 F10 F11 C11 C5 T1 C6 T2 G9 G10 C13 T12|D1', 'K20|Header values|C1 C3 C4 C6 C7 C12 T5 T9 T11|SETUP',
    'K21|Gain decision of the model|C7|F1 F2 F3 F5 F6 F10 C11 C2 T8 G12 C5 T1', 'K22|FALLBACK at a large load|G1|G19 L1 G20', 'K23|Tail kick at a rescue|T15|G19 T8 D8',
    'K24|Tail output at its limit|T1 T6 T11 T15|L4', 'K25|Throttle at its limit|G2 G3 G5 G19|L1', 'K26|Cyclic or collective at its limit|C2 C12|L2 L3 L5 L7', 'K27|Load at a rescue|G19|L7 D8'].map(s => { const [id, name, sy, up] = s.split('|'); return { id, name, symptoms: sy.split(' '), upstream: up.split(' '), first: [] }; });

const Q = (() => {
    const ok = !!HIER && Array.isArray(HIER.NODES) && Array.isArray(HIER.EDGES) && Array.isArray(HIER.RULES) && typeof HIER.homeOf === 'function';
    // the homes of the copy first (it has the phase checks of SPEC2 section 6), then those of hierarchy.cjs
    const nodes = ok ? HIER.NODES : NODES0, byId = new Map(nodes.map(n => [n.id, n])), home = new Map();
    for (const n of NODES0.concat(nodes)) for (const c of n.checks || []) if (!/:/.test(c) && byId.has(n.id)) home.set(c, n.id);
    const gates = (ok ? HIER.EDGES : GATES0).filter(e => e.kind === 'gate'), pred = new Map(nodes.map(n => [n.id, []]));
    for (const e of gates) if (pred.has(e.to)) pred.get(e.to).push(e.from);
    const localHome = (id0, axis) => { const parts = String(id0 || '').split(':'), base = parts[0].replace(/#\d+$/, ''), rest = parts.slice(1).join(':');
        if (base === 'SETUP') return /i_gain/.test(rest) ? 'mechanics' : 'controller';
        const yaw = (axis || (/(^|[:_])yaw/.test(rest) ? 'yaw' : null)) === 'yaw';
        if (base === 'C7') return yaw ? 'tail' : 'cyclic';
        if (base === 'L5') return yaw ? 'tailcomp' : 'cyclic';
        if (base === 'L6') return yaw ? 'tail' : 'cyclic';
        return home.get(base) || null; };
    const homeOf = (id0, axis) => { if (ok) { try { const n = HIER.homeOf(id0, axis); if (byId.has(n)) return n; } catch (e) { /* the copy below */ } } return localHome(id0, axis); };
    const up = (id, seen = new Set()) => { for (const u of pred.get(id) || []) if (!seen.has(u)) { seen.add(u); up(u, seen); } return seen; };
    const gateUpstream = ok && typeof HIER.gateUpstream === 'function' ? (id) => HIER.gateUpstream(id) : (id) => [...up(id)];
    const pOf = (f) => { if (Number.isInteger(f.pidProfile) && f.pidProfile >= 1 && f.pidProfile <= 6) return f.pidProfile;
        const p = typeof f.profile === 'string' && /^\d+$/.test(f.profile) ? +f.profile : f.profile; return typeof p === 'number' && isFinite(p) && p > 0 ? p : null; };
    const aOf = (f) => f.axis || (f.id === 'F4' && lib.AXES.includes(f.profile) ? f.profile : /^T\d/.test(String(f.id)) ? 'yaw' : null);
    const lOf = (f) => Array.isArray(f.log) ? f.log : f.log === null || f.log === undefined ? [] : [f.log];
    const compatible = ok && typeof HIER.compatible === 'function' ? HIER.compatible : (s, u) => { const a = lOf(s), b = lOf(u);
        if (a.length && b.length && !a.some(l => b.includes(l))) return false;
        const p = pOf(s), q = pOf(u), x = aOf(s), y = aOf(u); return !(p !== null && q !== null && p !== q) && !(x && y && x !== y); };
    const scope = new Map(gates.filter(e => Array.isArray(e.scope)).map(e => [`${e.from}>${e.to}`, e.scope]));
    if (!ok) scope.set('rpm>filters', ['F3', 'F5', 'F6', 'F9']);   // hierarchy.cjs EDGES: the RPM signal gates the RPM notch filters only
    return { ok, nodes, byId, pred, scope, homeOf, gateUpstream, compatible, rules: ok ? HIER.RULES : RULES0, status: ok && typeof HIER.status === 'function' ? HIER.status : null };
})();

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const num = (v) => typeof v === 'number' && isFinite(v) ? v : null;
const fmt = (v, d = 2) => num(v) === null ? 'unknown' : String(+v.toFixed(d));
const pct = (v, d = 0) => num(v) === null ? 'unknown' : (100 * v).toFixed(d) + ' %';
const pm = (v, se, d = 2, unit = '') => `${fmt(v, d)}${num(se) !== null ? ` ± ${fmt(se, d)}` : ''}${unit}`;
const pmPct = (v, se, d = 1) => num(v) === null ? 'unknown' : `${(100 * v).toFixed(d)}${num(se) !== null ? ` ± ${(100 * se).toFixed(d)}` : ''} %`;
const arr = (v) => Array.isArray(v) ? v : v === null || v === undefined ? null : [v];
const pick = (v, i) => v === undefined || v === null ? null : i === null || i === 'all' ? v : (arr(v)[i] === undefined ? null : arr(v)[i]);
const sum = (list) => list.reduce((s, f) => s + (num(f.value) || 0), 0);
const isFlag = (f) => f.severity === 'flag';
const thin = (f) => !!f.thin || /^no finding/i.test(String(f.text || ''));   // SPEC2 D5: our modules mark thin data, the others still write "no finding"
const measured = (f) => (f.severity === 'flag' || f.severity === 'ok' || f.severity === 'note') && !thin(f);
const logsOf = (f) => Array.isArray(f.log) ? f.log : f.log === null || f.log === undefined ? [] : [f.log];
const lab = (l, c) => typeof l === 'number' && c ? l + c.logBase : l; // a log as the reader counts them (input.logBase)
// The PID profile of a finding (SPEC2 D12): the worker's pidProfile (an integer 1-6, set only when the profile is known)
// first, else the toolkit label (D4: the CLI index + 1). A label 0 with no pidProfile is "PID profile unknown"
const pidOk = (v) => Number.isInteger(v) && v >= 1 && v <= RULES.pidProfiles ? v : null;
const profileOf = (f) => { const q = pidOk(f.pidProfile); if (q !== null) return q; const p = typeof f.profile === 'string' && /^\d+$/.test(f.profile) ? +f.profile : num(f.profile); return f.id === 'D4' && p !== null ? p + 1 : p; };
// the checks whose profile field is not a log profile: D4 (CLI index), F4 (an axis), H ('global' or 'start profile N')
const LABEL_IDS = new Set(['D4', 'F4', 'H']);
// a finding with its log profile replaced by the worker's pidProfile (the input is not changed): every generator then
// groups, compares and writes the PID profile that the worker found; profileLabel keeps the toolkit label
function resolved(f) {
    const q = pidOk(f.pidProfile), p = f.profile;
    if (q === null || LABEL_IDS.has(f.id) || p === q || !(typeof p === 'number' || (typeof p === 'string' && /^(\d+|arm|unknown)$/.test(p)))) return f;
    return Object.assign({}, f, { profile: q, profileLabel: p });
}
// the PID profile of an H finding (its scope 'start profile N'), or null for 'global'
const hProfile = (h) => { const q = pidOk(h.pidProfile); if (q !== null) return q; const m = /^start profile (\d+)$/.exec(String(h.profile)); return m && +m[1] > 0 ? +m[1] : null; };
// the arming profile of a log of input.logs when the worker confirmed it (an in-flight event, the CLI sections, the CLI
// gov_headspeed, or 'headspeed': the logged govRequest at the log start agrees with the gov_headspeed of exactly one PID
// profile at the logged PID profile changes of the same file, user decision 2026-10-06), else null: then its profile 0 is
// "PID profile unknown"
const CONFIRMED = new Set(['event', 'cli', 'cliTarget', 'headspeed']);
const armingOfLog = (l) => { const p = pidOk(l && l.armingProfile); return p !== null && (l.armingConfirmed === true || (Array.isArray(l.armingBasis) && l.armingBasis.some(b => CONFIRMED.has(b)))) ? p : null; };
const axisOf = (f) => f.axis || (f.id === 'F4' ? f.profile : (/^(roll|pitch|yaw)\b/.exec(String(f.text || '')) || [])[1]) || null;
const matchNum = (re, s) => { const m = re.exec(String(s || '')); return m ? +m[1] : null; };
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const many = (n, one, more) => `${n} ${n === 1 ? one : more || one + 's'}`;
const and = (list) => list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
const checks = (ids) => `${ids.length === 1 ? 'check' : 'checks'} ${and(ids)}`;
function group(list, key) { const m = new Map(); for (const x of list) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }
// "log 5", "logs 5 and 6", "8 logs (5, 6, 7, 8, 9 and 3 more)", as the reader counts them
function logsText(list, c) {
    const l = [...new Set(list.flatMap(logsOf))].sort((a, b) => a - b).map(x => lab(x, c));
    return !l.length ? 'the logs' : l.length === 1 ? `log ${l[0]}` : l.length <= 6 ? `logs ${and(l)}` : `${l.length} logs (${l.slice(0, 5).join(', ')} and ${l.length - 5} more)`;
}
// a PID profile in the words of the Configurator: "PID profile 2", and "PID profile unknown" for log profile 0 (SPEC2 D12)
const prof = (p) => num(p) > 0 ? `PID profile ${p}` : 'PID profile unknown';
// where one finding is: "log 5, PID profile 1"
const whereOf = (f, c) => [logsOf(f).length ? `log ${logsOf(f).map(l => lab(l, c)).join(', ')}` : null, num(profileOf(f)) !== null ? prof(profileOf(f)) : null].filter(Boolean).join(', ');
// the F5 caveat "In the logs, the line at `X × rotor` is at ...": a text format, not a threshold. A description has 25 words
// or less (STE Rule 6.3). The words are 9 before the list and "and", 2 for each line ("311 Hz (log 5, PID profile 1)": a
// number with its unit is one word, and a parenthesis is one word) and 2 or 4 for the range of a PID profile ("311 Hz to 312 Hz (...)")
const EACH_LIST = { words: 25, fixed: 10 };
// the flags of a check in the reader's words: "Check G6 has a problem in log 5 (PID profile 1)." or "... in 3 results (logs 5, 6 and 7)."
const problems = (id, list, c) => list.length === 1 ? `Check ${id} has a problem${whereOf(list[0], c) ? ` (${whereOf(list[0], c)})` : ''}.` : `Check ${id} has a problem in ${list.length} results (${logsText(list, c)}).`;
// a value with its unit: fractions as %, the other units after the number
function valueOf(f, unit) {
    const u = unit || f.unit || UNITS[f.id] || '';
    return u === 'fraction' ? pmPct(f.value, f.se) : /^(Hz|ms|s|V|V\/cell|deg\/s|%|dB|rpm)$/.test(u) ? pm(f.value, f.se, 2, ` ${u}`) : pm(f.value, f.se);
}
// the range of the values of the findings: "The headspeed error is 3.1 ± 0.2 %." or "... is 3.1 % to 4.5 %."
function range(noun, list, unit) {
    const v = list.filter(f => num(f.value) !== null).sort((a, b) => a.value - b.value);
    if (!v.length) return '';
    return v.length === 1 ? `The ${noun} is ${valueOf(v[0], unit)}.` : `The ${noun} is ${valueOf({ id: v[0].id, value: v[0].value, unit: v[0].unit }, unit)} to ${valueOf({ id: v[0].id, value: v[v.length - 1].value, unit: v[0].unit }, unit)}.`;
}

// the finding of an evidence row (rows are made here only): its fid when it has one, else the object
const SOURCE = new WeakMap();
// D2 is a problem only for a loss of frames (catalog.cjs D2 statusOf, SPEC3 A); without the catalog, never
const d2Problem = (f) => { try { return !!CAT && typeof CAT.status === 'function' && CAT.status(f) === 'problem'; } catch (e) { return false; } };
// the STE summary of a finding: the worker's (SPEC2 3.6), else catalog.cjs, else none
const summaryOf = (f) => { if (typeof f.summary === 'string') return f.summary; if (!CAT || typeof CAT.summary !== 'function') return null; try { const s = CAT.summary(f); return typeof s === 'string' && s ? s : null; } catch (e) { return null; } };
// what the views and the CLI file show of a finding (catalog.cjs display, review V5): the value that its rule compares,
// and the limit in that unit. null without catalog.cjs: then the toolkit value and threshold, quoted
const displayOf = (f) => { if (!CAT || typeof CAT.display !== 'function') return null; try { const d = CAT.display(f); return d ? { value: d.value || null, bound: d.bound || null, limit: d.limit || null } : null; } catch (e) { return null; } };
function evidence(f) {
    const times = Array.isArray(f.times) ? f.times : (f.events || []).map(e => e.t).filter(t => typeof t === 'number');
    const pp = LABEL_IDS.has(f.id) ? pidOk(f.pidProfile) : pidOk(profileOf(f));
    const row = { fid: f.fid === undefined ? null : f.fid, module: f.module || null, id: f.id, log: f.log === undefined ? null : f.log, profile: f.profile === undefined ? null : f.profile, pidProfile: pp, axis: axisOf(f),
        value: f.value === undefined ? null : f.value, se: num(f.se), n: f.n === undefined ? null : f.n, unit: f.unit || UNITS[f.id] || null,
        threshold: f.threshold === undefined ? null : f.threshold, source: f.source || null, text: String(f.text || ''), times: times.slice(0, 200), summary: summaryOf(f), display: displayOf(f),
        ...(f.profileLabel !== undefined ? { profileLabel: f.profileLabel } : {}), ...(typeof f.phase === 'string' ? { phase: f.phase } : {}), ...(Array.isArray(f.filterPass) ? { filterPass: f.filterPass } : {}),
        ...(typeof f.dataset === 'string' ? { dataset: f.dataset } : {}) };
    SOURCE.set(row, f);
    return row;
}

// scope of a parameter named without CLI (PARAMS has the rest): axis settings are per PID profile, rates_type per rate profile
const scopeOf = (k) => PARAMS[k] ? PARAMS[k][0] : k === 'rates_type' ? 'rateprofile' : /^(roll|pitch|yaw)_/.test(k) ? 'profile' : 'global';
function rec(o) {
    if (o.parameter && o.scope === undefined) o = Object.assign({}, o, { scope: scopeOf(o.parameter) });
    return Object.assign({ id: '', node: null, area: 'precondition', order: 0, severity: 'check', title: '', text: '', parameter: null, scope: null, cliProfile: null, profile: null, axis: null,
        rateProfile: null, from: null, fromSource: null, fromSets: null, to: null, direction: 'check', cli: [], evidence: [], rule: '', sources: [], confidence: 'advisory', blockedBy: [], gate: null, causes: [], caveats: [], group: null, groupSize: null,
        dataset: null, supportedBy: [], ab: [], slope: null }, o,
        { evidence: (o.evidence || []).slice(), caveats: (o.caveats || []).slice(), blockedBy: (o.blockedBy || []).slice(), sources: (o.sources || []).slice(), holds: [] });
}
// one recommendation from the findings `sel`, none when it is empty
const one = (sel, o) => sel.length ? [rec(Object.assign({ evidence: sel.map(evidence) }, o))] : [];
// a guard holds r: its text for the pilot, and the checks that cause it (their steps: the gates do not repeat them)
function hold(r, text, ids) { r.blockedBy.push(text); for (const id of ids || []) { const n = Q.homeOf(id); if (n && !r.holds.includes(n)) r.holds.push(n); } }

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
// the failed 2-SE test in words, or null
const fails = (e, thr, side, what) => clears(e, thr, side) === false ? `${what} gives ${pm(e.value, e.se, 3)} (${many(e.n, 'log')}). `
    + (side === 0 ? `Without its sign, this is not more than ${thr} by ${RULES.sigmas} SE.` : `This is not ${side < 0 ? 'less' : 'more'} than ${thr} by ${RULES.sigmas} SE.`) : null;
function sig(r, e, id) {
    const [t, side] = SIGMA[id] || [null, 1], thr = t === null ? num(r.evidence.length ? r.evidence[0].threshold : null) : t;
    r.sig = fails(e, thr, side, `Check ${id}`);
    return r;
}
// a diagnostic over several log-profile pairs stands when any flagged pair clears its 2-SE test (pairs are not pooled:
// one profile may oscillate while the others do not)
function sigAny(r, list, id) {
    const fl = list.filter(isFlag), tests = fl.map(f => { const t = SIGMA[id] || [null, 1], thr = t[0] === null ? num(f.threshold) : t[0]; return fails({ value: f.value, se: num(f.se), n: 1 }, thr, t[1], `Check ${id}`); });
    r.sig = fl.length && tests.every(Boolean) ? `${tests[0]}${fl.length > 1 ? ` The other ${many(fl.length - 1, 'result')} with a problem also ${fl.length > 2 ? 'are' : 'is'} not more than the limit by ${RULES.sigmas} SE.` : ''}` : null;
    return r;
}

// Findings of one check grouped by key (default axis and log profile): the groups with at least one flag, each holding
// every measured finding of the group (flags, ok and real notes), so that estimates are not taken from the flags alone.
function flagged(L, key) {
    return [...group(L.filter(measured), key || ((f) => `${axisOf(f) || ''}|${profileOf(f)}`)).values()].filter(list => list.some(isFlag));
}

// The present value of a parameter on log profile p (SPEC2 D12): a global setting from the log header, else from the CLI
// dump; a PID profile setting from the log header only when p is the confirmed arming profile, else from the CLI section
// `profile p-1` (a diff leaves the 4.6 defaults out of a section it prints). Never from the header of another PID
// profile, and a section the capture lacks is unknown, not default: a plain `diff` or `dump` prints the current profile
// only (RULES.source.pidProfiles). -> { value, source } or { value: null, unknown: why }
function current(c, param, p) {
    const fromDs = dsValue(c, param, p); if (fromDs) return fromDs;
    const [scope, key, idx, def] = PARAMS[param], hv = key ? pick(c.header[key], idx) : null;
    const own = scope === 'global' || (p > 0 && p === c.headerProfile && c.headerConfirmed);
    const sc = !c.cli ? null : scope === 'global' ? c.cli.global : p > 0 ? c.cli.profiles[String(p - 1)] || null : null;
    if (hv !== null && own) {
        // review V11: a CLI dump with the same value is a source too
        const same = sc && !c.staleCli.has(param) && sc[param] !== undefined && sc[param] !== null && String(sc[param]).replace(/\s+/g, '').toUpperCase() === String(hv).replace(/\s+/g, '').toUpperCase();
        const out = { value: hv, source: same ? bothSource(c, scope === 'global' ? null : `profile ${p - 1}`) : scope === 'global' ? 'log header' : `log header, ${prof(p)} at the start of the log`, log: c.headerLog };
        // the CLI dump gives another value (check D4): the value at this time is not known, thus no CLI text (SPEC2 C4)
        const cv = sc && c.staleCli.has(param) ? (sc[param] !== undefined && sc[param] !== null ? sc[param] : c.cli.kind === 'diff' && def !== null ? def : null) : null;
        if (cv !== null && String(cv) !== String(hv)) Object.assign(out, { unconfirmed: true, conflict: { header: hv, cli: cv } });
        return out;
    }
    if (sc && !c.staleCli.has(param)) {
        const cv = sc[param], where = `CLI dump${scope === 'global' ? '' : `, section \`profile ${p - 1}\``}`;
        if (cv !== undefined && cv !== null) return { value: cv, source: where };
        if (c.cli.kind === 'diff' && def !== null) return { value: def, source: `${where}, the default of 4.6, because \`diff\` does not show a default value` };
    }
    const why = scope !== 'global' && !(p > 0) ? 'profile' : sc && c.staleCli.has(param) ? 'staleCli' : c.cli && scope !== 'global' && !sc ? 'noSection'
        : scope !== 'global' && hv !== null ? 'otherProfile' : 'missing';
    return { value: null, unknown: why };
}
// what records the values of a PID profile: the log header of a log that starts in it (the header is written once, when the
// pilot arms the helicopter). A description (a caveat or a note): never an instruction, and never a CLI dump (user rule
// 2026-10-06: the log is the only necessary input)
const armedText = (p) => num(p) > 0 ? `The log header records the values of ${prof(p)} only when the pilot arms the helicopter in ${prof(p)}.` : 'The log header records the values of a PID profile only when the pilot arms the helicopter in that PID profile.';
// why the value of param on log profile p is unknown, for the pilot: the cause, then `then` (a sentence), then what records it
function unknownText(c, param, p, why, then) {
    const t = then ? ` ${then}` : '';
    if (why === 'profile') return `The PID profile of this result is unknown (PID profile unknown), and the value of ${param} is also unknown.${t}`;
    if (why === 'dsNone') return `${c.cli ? 'No log header and no CLI dump give' : 'No log header gives'} the value of ${param} in the newest configuration of ${prof(p)}.${t} ${armedText(p)}`;
    if (why === 'dsEstimate') return `The value of ${param} comes from the log header of a log. The PID profile of that log when the pilot armed the helicopter is only an estimate.${t}`;
    if (why === 'dsAdjustment') return `An in-flight adjustment changed ${param} in the newest configuration, and the value at this time is not known.${t}`;
    if (why === 'dsAssumed') return `The log header of ${prof(p)} is the header of a different log, and the logs before and after it do not agree.${t}`;
    if (why === 'noSection') return `The CLI dump has no section \`profile ${p - 1}\`, because \`diff\` or \`dump\` without \`all\` shows only the active PID profile.${t} ${armedText(p)}`;
    if (why === 'staleCli') return `The CLI dump and the log header have different values of ${param} (check D4). The app does not use the CLI value.${t}`;
    if (why === 'otherProfile') return (c.headerProfile > 0 && c.headerConfirmed ? `The log header gives the values of ${prof(c.headerProfile)} only, the PID profile at the start of the log.`
        : 'The PID profile at the start of the log is only an estimate. Thus, the log header gives the values of no known PID profile.') + ` The value of ${param} on ${prof(p)} is unknown.${t} ${armedText(p)}`;
    return `${c.cli ? 'The log header and the CLI dump do not have' : 'The log header does not record'} ${param}.${t}`;
}

// A change of one parameter on log profile o.profile: o.mult (relative) or o.delta (measured absolute change), both
// bounded to RULES.maxStep of the present value (o.asks(want) tells what asks for more than the bound; default the
// measurement); o.add, a documented absolute step; o.to, a documented value. Every value stays within its firmware
// range (RANGE). The CLI is written at the end, after the guards (finish). When the present value is unknown, the
// change is relative (r.relative, no from or to, no CLI); a report.cjs decision then uses the gain that it recovered
// from the flights of that profile (o.recovered: an estimate, r.base.approx, no CLI).
// The change in words: setText, the instruction of an action; setNote, the same change as a description, for a
// recommendation that is not an action (a check or a watch never has an instruction to change a value): finish uses one
const STEPVERB = { raise: 'Increase', lower: 'Decrease' }, STEPNOUN = { raise: 'an increase', lower: 'a decrease' };
// round 3 M5: the full measured change ("The full change is an increase of 62.": STE has no "correction")
const fullText = (d) => `The full change is ${d >= 0 ? 'an increase' : 'a decrease'} of ${fmt(Math.abs(d), Math.abs(d) >= 10 ? 0 : 1)}.`;
function change(c, o) {
    const P = PARAMS[o.parameter], r = rec(Object.assign({ severity: 'action', scope: P[0] }, o)), lim = RANGE[o.parameter];
    let b = current(c, o.parameter, o.profile);
    if (b.unknown && num(o.recovered) !== null) b = { value: Math.round(o.recovered), source: o.recoveredFrom || `the gain that the gain model calculated from the flights${num(o.profile) > 0 ? ` of ${prof(o.profile)}` : ' (PID profile unknown)'}`, approx: true, why: b.unknown };
    if (b.conflict) r.caveats.push(`The log header gives ${o.parameter} ${b.conflict.header}, but the CLI dump gives ${b.conflict.cli} (check D4). The app cannot find which value is correct at this time. Thus, there is no CLI text.`);
    if (b.unknown) {
        const verb = STEPVERB[o.direction] || 'Change', on = P[0] === 'global' || !(num(o.profile) > 0) ? '' : ` on ${prof(o.profile)}`, end = P[0] !== 'global' && !(num(o.profile) > 0) ? ' (PID profile unknown)' : '';
        const by = o.to !== undefined ? null : o.add !== undefined ? `by ${Math.abs(o.add)}` : o.mult !== undefined ? `by ${fmt(Math.min(RULES.maxStep, Math.abs(o.mult - 1)) * 100, 0)} %` : null;
        Object.assign(r, { from: null, to: null, base: b, sets: null, relative: true,
            setText: o.to !== undefined ? `Set ${o.parameter}${on} to ${o.to}${end}.` : by ? `${verb} ${o.parameter}${on} ${by}${end}.` : `${verb} ${o.parameter}${on} by ${RULES.maxStep * 100} % or less${end}.`,
            setNote: o.to !== undefined ? `The analysis gives a change of ${o.parameter}${on} to ${o.to}${end}.` : `The analysis gives ${STEPNOUN[o.direction] || 'a change'} of ${o.parameter}${on} ${by || `by ${RULES.maxStep * 100} % or less`}${end}.` });
        if (o.mult !== undefined && Math.abs(o.mult - 1) > RULES.maxStep) r.caveats.push(`The step is ${RULES.maxStep * 100} % or less. ${o.asks ? o.asks('a larger value') : `The measurement gives a step of ${fmt(Math.abs(o.mult - 1) * 100, 0)} %.`}`);
        if (o.delta !== undefined) { r.caveats.push(`The measurement gives a change of ${fmt(o.delta, 0)}. Without the value at this time, the app cannot limit the step to ${RULES.maxStep * 100} %.`);
            r.full = { change: Math.round(o.delta), step: null }; const t = fullText(o.delta); r.setText = `${t} ${r.setText}`; r.setNote = `${t} ${r.setNote}`; }
        r.caveats.push(unknownText(c, o.parameter, o.profile, b.unknown, 'Thus, there is no CLI text.'));
        return r;
    }
    if (typeof b.value !== 'number') { r.severity = 'check'; r.caveats.push(`The value of ${o.parameter} is not a number (${b.source}). Thus, the app does not calculate a step.`); return r; }
    let to, want = null;
    if (o.to !== undefined) to = o.to;
    else if (o.add !== undefined) { to = lim ? b.value + o.add : Math.max(0, b.value + o.add); if (Math.abs(o.add) >= 0.5 * b.value) r.caveats.push(`The step of the documentation, ${Math.abs(o.add)}, is 50 % or more of the value ${b.value}. A smaller step is possibly better.`); }
    else { want = o.mult !== undefined ? b.value * o.mult : b.value + o.delta; const step = RULES.maxStep * Math.abs(b.value), lo = b.value - step, hi = b.value + step;
        to = Math.round(Math.min(hi, Math.max(lo, want)));
        if (to > hi) to = Math.floor(hi); else if (to < lo) to = Math.ceil(lo);   // rounding never takes a bounded step past the bound
        if (b.value !== 0 && Math.abs(want - to) > 0.5) r.caveats.push(`The step is ${RULES.maxStep * 100} % or less. ${o.asks ? o.asks(fmt(want, 1)) : `The measurement gives ${fmt(want, 1)}.`}`); }
    const asked = to;
    if (lim && typeof to === 'number' && (to < lim[0] || to > lim[1])) { to = Math.min(lim[1], Math.max(lim[0], to));
        r.caveats.push(`The firmware range of ${o.parameter} is ${lim[0]} to ${lim[1]}, and the CLI does not accept a value out of it. Thus, ${asked} becomes ${to}.`); }
    const on = P[0] === 'global' ? '' : ` on ${prof(o.profile)}`, fromTo = `${o.parameter}${on} from ${b.approx ? 'approximately ' : ''}${b.value} to ${to} (${b.source})`;
    Object.assign(r, { from: b.value, to, base: b, sets: [[o.parameter, to]], fromSets: { [o.parameter]: b.value }, setText: `Set ${fromTo}.`, setNote: `The analysis gives a change of ${fromTo}.` });
    // round 3 M5: a step that the limit makes smaller than the measured correction gives the full correction and the step
    if (want !== null && b.value !== 0 && to !== b.value && Math.abs(want - to) > 0.5) {
        const t = fullText(want - b.value); r.full = { change: Math.round(want - b.value), step: to - b.value };
        r.setText = `${t} Make the change in steps. Set ${fromTo}. After the flight, do the analysis again.`;
        r.setNote = `${t} The analysis gives a step of ${fromTo}.`; }
    if (b.approx) r.caveats.push(unknownText(c, o.parameter, o.profile, b.why, `The value ${b.value} is an estimate from the log. Thus, there is no CLI text.`));
    if (to === b.value) { r.sets = null; r.setText = r.setNote = '';
        if (to !== asked) { r.severity = 'watch'; r.caveats.push(`${o.parameter} is at its firmware limit, ${to}. A step in this direction is not possible.` + (/_stop_gain$/.test(o.parameter) ? ' The ratio of the two stop gains is more important (a recommendation from other pilots). Thus, a change of the other stop gain is possible.' : '')); }
        else { r.severity = b.value === 0 ? 'check' : 'watch';
            r.caveats.push(b.value === 0 ? `${o.parameter} is 0. A step of ${RULES.maxStep * 100} % or less cannot start from 0${o.confidence === 'predicted' ? ', and the gain model does not change a gain that is 0' : ''}.` : 'The limited step is less than 1 unit.');
            if (b.value === 0) r.setText = r.setNote = `${o.parameter} is 0 (${b.source}). The app cannot calculate a step from 0, but a flight with a small value gives a new measurement.`; } }
    return r;
}

// A recommendation whose values come from the analysed log header (D1, F1, F2, F3, F5, SETUP; SPEC2 C1): base 'log header'
// of input.headerLog, the header keys that the H staleness test reads besides those of its sets (keys: [[header key,
// 'global' | 'profile']]), headerOnly when only the header decides it (the evidence logs do not size it), and no CLI
// text when the CLI dump gives another value of a name that it sets (check D4, SPEC2 C4)
function fromHeader(r, c, keys, headerOnly) {
    r.base = { source: 'log header', log: c.headerLog, headerOnly: !!headerOnly };
    r.headerKeys = (keys || []).slice();
    const conflict = (r.sets || []).map(([k]) => k).filter(k => c.staleCli.has(k));
    if (conflict.length) { r.base.unconfirmed = true; r.caveats.push(`The CLI dump and the log header have different values of ${and(conflict)} (check D4). The app cannot find which value is correct at this time. Thus, there is no CLI text.`); }
    // review V11: the source of each previous value. A global value that the loaded CLI dump gives with the same value names
    // the CLI dump too; the from-values that differ keep "log header" (and D4 holds their CLI text, above)
    const names = Object.keys(r.fromSets || {}), each = {};
    for (const k of names) each[k] = PARAMS[k] && PARAMS[k][0] === 'global' && cliSame(c, k, r.fromSets[k]) ? bothSource(c) : 'log header';
    const kinds = [...new Set(Object.values(each))];
    if (kinds.length === 1) r.base.source = kinds[0]; else if (kinds.length > 1) r.fromSources = each;
    return r;
}
// review V11: does the loaded CLI dump give name k the value v (a `diff` leaves a 4.6 default out)? A value of check D4 is
// never the same
function cliSame(c, k, v) {
    if (!c.cli || v === null || v === undefined || c.staleCli.has(k)) return false;
    const P = PARAMS[k], g = c.cli.global || {}; let cv = g[k];
    if ((cv === undefined || cv === null) && c.cli.kind === 'diff' && P && P[3] !== null) cv = P[3];
    if (cv === undefined || cv === null) return false;
    const norm = (x) => (Array.isArray(x) ? x.join(',') : String(x)).replace(/\s+/g, '').toUpperCase();
    return norm(cv) === norm(v);
}
const cliWords = (c) => `CLI dump${c.cliName ? ` "${String(c.cliName).replace(/["`]/g, "'")}"` : ''}`;
const bothSource = (c, section) => `${cliWords(c)}${section ? `, section \`${section}\`` : ''}, the same as the log header`;

// per-profile recommendations from the flags of one check: o.size(flags, estimate, axis, profile, group) returns the
// change (with parameter) or a plain recommendation; o.test(group, estimate) replaces the default 2-SE test
function perProfile(L, c, id, o) {
    return flagged(L, o.key).map(list => {
        const fl = list.filter(isFlag), p = profileOf(fl[0]), ax = o.axis || axisOf(fl[0]), e = pooled(list.map(o.estimate || ((f) => [f.value, f.se]))) || { value: null, se: null, n: 0 };
        const s = o.size(fl, e, ax, p, list); if (!s) return null;
        const base = { id: `${id}:${s.parameter || ax || 'all'}:p${p}`, area: o.area, axis: ax, profile: p, evidence: list.map(evidence), rule: o.rule, sources: o.sources || [] };
        const r = s.parameter ? change(c, Object.assign(base, s)) : rec(Object.assign(base, s));
        if (o.test) r.sig = o.test(list, e); else sig(r, e, id);
        return r;
    }).filter(Boolean);
}
const flagLogs = (list) => `a problem in ${list.filter(isFlag).length} of ${many(list.length, 'measured log')}`;
// C3, T9: the I share when it decided, else the gyro/setpoint ratio outside its band
const shareTest = (id, R) => (list, e) => Math.abs(e.value) > R.iShare ? fails(e, R.iShare, 0, `Check ${id} (I-term to F-term)`)
    : fails(pooled(list.map(f => f.gyroRatio ? [f.gyroRatio.mean - 1, f.gyroRatio.se] : [null])), (R.gyroRatio[1] - R.gyroRatio[0]) / 2, 0, `Check ${id} (gyro rate to setpoint, minus 1)`);

const lpfStages = (h) => [h.gyro_soft_type > 0 && h.gyro_lowpass_hz > 0 && { name: 'LPF1', param: 'gyro_lpf1_static_hz', hz: h.gyro_lowpass_hz },
    h.gyro_soft2_type > 0 && h.gyro_lowpass2_hz > 0 && { name: 'LPF2', param: 'gyro_lpf2_static_hz', hz: h.gyro_lowpass2_hz },
    h.gyro_soft_type > 0 && pick(h.gyro_lowpass_dyn_hz, 0) > 0 && { name: 'dynamic LPF1 minimum', param: 'gyro_lpf1_dyn_min_hz', hz: pick(h.gyro_lowpass_dyn_hz, 0) }].filter(Boolean);
const feature = (h, name) => num(h.features) === null ? null : ((h.features >>> setup.FEATURE_BITS[name]) & 1) === 1;
// the RPM notch banks of one axis (RPM_FILTER_BANK_COUNT, rpm_filter.h): `set gyro_rpm_notch_*_<axis>` takes exactly this
// many values, and a shorter list leaves the other values undefined (cli.c:4845, SPEC2 C10)
const BANKS = 16;
const BANK_TEXT = (k, n) => `The log header gives ${n} values of ${k}, but the CLI must set ${BANKS} values. Thus, there is no CLI text.`;
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
// a rotor order in the reader's words: `4.061 × rotor` (code font: a formula)
const order = (o) => `\`${o} × rotor\``;

// ---------------------------------------------------------------------------------------------
// Generators: one per check id, (findings with that id, context) -> recommendations
// ---------------------------------------------------------------------------------------------

// header checks without the analysed log's header: report the flags, change nothing
const noHeader = (id, area, bad, c) => one(bad, { id, area, title: `Check ${id}: the log header is not available`, rule: `Check ${id} examines the values in the log header.`,
    text: `${problems(id, bad, c)} The header of the selected log is not available. Thus, the value at this time is unknown.` });
// a diagnostic: the flags of a check -> one 'check': where they are, the range of their values (o.noun, o.unit), the advice
const diag = (id, area, title, rule, advice, o = {}) => (L, c) => { const bad = L.filter(isFlag);
    return one(bad, Object.assign({ id, area, title, rule, sources: o.sources || [], text: [problems(id, bad, c), o.noun ? range(o.noun, bad, o.unit) : '', advice].filter(Boolean).join(' ') }, o.rec)); };
// the same per axis; advice may read the axis' findings
const perAxis = (id, area, title, rule, advice, o = {}) => (L, c) => [...group(L.filter(isFlag), axisOf)].map(([ax, list]) => rec({ id: `${id}:${ax}`, area, axis: ax, title: ax ? `${cap(ax)} ${title}` : cap(title), evidence: list.map(evidence), rule, sources: o.sources || [],
    text: [problems(id, list, c), o.noun ? range(o.noun, list, o.unit) : '', typeof advice === 'function' ? advice(list) : advice].filter(Boolean).join(' ') }));

// D4: the CLI names of the global values (health_setup PAIRS_GLOBAL, the features and the mixer inputs); the others are values of a PID profile
const D4_GLOBAL = /^(gyro_|dyn_notch_|pid_process_denom$|mixer$|feature$)/;
const GEN = {
    D1(L, c) {
        const bad = L.filter(isFlag); if (!bad.length) return [];
        const h = c.header, pid = h.looptime ? 1e6 / h.looptime / (h.pid_process_denom || 1) : null; if (pid === null) return noHeader('D1', 'logging', bad, c);
        const denomNow = h.frameIntervalPNum ? Math.round((h.frameIntervalPDenom || 1) / h.frameIntervalPNum) : null, logHz = pid && denomNow ? pid / denomNow : null;
        const base = { id: 'D1', area: 'logging', rule: `Check D1 has a problem if the log rate is less than ${RULES.minLogHz} Hz.`, sources: [RULES.source.minLogHz] };
        if (logHz !== null && logHz >= RULES.minLogHz) return one(bad, Object.assign(base, { severity: 'info', title: 'Some logs have a log rate of less than 1 kHz',
            text: `The log rate of ${logsText(bad, c)} is ${and(bad.map(f => fmt(f.value, 0)))} Hz. Thus, their vibration, D-term and frequency results are not accurate (aliasing). The log rate of the selected log is ${fmt(logHz, 0)} Hz.` }));
        const to = pid ? Math.floor(pid / RULES.minLogHz) : 0;
        if (to < 1) return one(bad, Object.assign(base, { title: 'PID loop rate of less than 1 kHz', text: `The PID loop rate is ${fmt(pid, 0)} Hz. Thus, no value of blackbox_rate_denom gives a log rate of ${RULES.minLogHz} Hz, and the vibration and D-term results are not accurate (aliasing).` }));
        return one(bad, Object.assign(base, { severity: 'action', title: `Record the log at ${fmt(pid / to, 0)} Hz`, parameter: 'blackbox_rate_denom', scope: 'global', from: denomNow, to, direction: 'set', sets: [['blackbox_rate_denom', to]],
            fromSets: { blackbox_rate_denom: denomNow },
            text: `The log rate is ${fmt(logHz, 0)} Hz, and the PID loop rate is ${fmt(pid, 0)} Hz. At this log rate, aliasing changes the rotor and tail harmonics. The log rate is \`PID rate / blackbox_rate_denom\`.`,
            setText: `Set blackbox_rate_denom to ${to} for a log rate of ${fmt(pid / to, 0)} Hz.`, setNote: `A blackbox_rate_denom of ${to} gives a log rate of ${fmt(pid / to, 0)} Hz.` }))
            .map(r => fromHeader(r, c, [['looptime', 'global'], ['pid_process_denom', 'global'], ['frameIntervalPDenom', 'global']], true));
    },
    D2(L, c) {
        const bad = L.filter(isFlag), n = (f, re) => matchNum(re, f.text) || 0;
        const parser = bad.filter(f => f.source === 'parser'), lost = bad.filter(f => f.source !== 'parser' && (n(f, /^(\d+) logging gaps/) || n(f, /(\d+) time jumps/) || n(f, /(\d+) non-increasing/) || n(f, /(\d+) loopIteration jumps/)));
        const stalls = bad.filter(f => !parser.includes(f) && !lost.includes(f)), parts = [];
        // the loop stalls of the flags (health_setup D2 events, in ms): their number and the longest, the cause of the flag
        // when no frame is missing (review V5: the value of check D2 does not count them)
        const stallsOf = (f) => (Array.isArray(f.events) ? f.events : []).filter(e => e && /^loop stall/.test(String(e.kind || '')));
        const WHEN = { idle: 'at IDLE', spoolup: 'during the spool-up', ground: 'on the ground', flight: 'in flight', spooldown: 'during the spool-down' };
        const whenOf = (f, e) => { const s = f.evidence && Array.isArray(f.evidence.spans) ? f.evidence.spans.find(q => q && q.value === e.value) || f.evidence.spans[0] : null; return s && WHEN[s.phase] ? `, ${WHEN[s.phase]}` : ''; };
        if (stalls.length) { const all = stalls.flatMap(f => stallsOf(f).map(e => ({ f, e }))), top = all.filter(x => num(x.e.value) !== null).sort((a, b) => b.e.value - a.e.value)[0];
            const k = stalls.reduce((s, f) => s + (stallsOf(f).length || n(f, /(\d+) loop stalls/)), 0);
            parts.push(`${cap(logsText(stalls, c))} ${stalls.length === 1 ? 'has' : 'have'} ${k ? many(k, 'loop stall') : 'loop stalls'} and no missing frame. Some intervals between frames are long.`
                + (top ? ` The longest loop stall is ${fmt(top.e.value, 1)} ms (${whereOf(top.f, c)}${whenOf(top.f, top.e)}).` : '')
                + ' A loop stall after disarm has no effect, but a loop stall in flight gives a time delay to the PID loop.'); }
        if (lost.length) parts.push(`${many(lost.length, 'log has', 'logs have')} missing frames (${logsText(lost, c)}), and the results near these times are less accurate. Examine the device that records the log.`);
        if (parser.length) parts.push(`The app cannot read ${many(parser.length, 'log')} (${logsText(parser, c)}).`);
        return one(bad, { id: 'D2', area: 'logging', title: 'Missing frames and loop stalls', rule: `Check D2 has a problem if the log has more than ${SR.D2.maxGaps} parts with no data or more than ${SR.D2.maxJumps} frame time errors. `
                + 'The frame time errors are the sudden time changes, the loop stalls and the times that do not increase, together. This check gives no change.',
            sources: [src(SR.D2.source)], text: parts.join(' ') });
    },
    D3(L, c) {  // the parts naming checks that no module implements (NO_CHECK) are left out: logging those fields enables nothing
        const sk = L.filter(f => f.severity === 'note' && /^checks that cannot run: /.test(String(f.text))), count = new Map();
        for (const f of sk) for (const part of f.text.replace(/^checks that cannot run: /, '').split('; ')) if (!NO_CHECK.test(part)) { const m = /^([^(]+?) \(([^)]*)\)/.exec(part); if (!m) continue;
            const k = `${m[1]}|${and([...m[2].matchAll(/([\w]+(?:\[\d\])?) (absent|zero)/g)].map(x => `\`${x[1]}\`${x[2] === 'zero' ? ' (always 0)' : ''}`))}`; count.set(k, (count.get(k) || 0) + 1); }
        const items = [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)); if (!items.length) return [];
        const say = ([k, v]) => { const [ids, fields] = k.split('|'); return `In ${many(v, 'log')}, ${checks(ids.split('/'))} did not operate${fields ? `, because the log does not have ${fields}` : ''}.`; };
        return one(sk, { id: 'D3', area: 'logging', severity: items.some(([k]) => /gyroRAW|govTarget|govSum/.test(k)) ? 'check' : 'info', title: 'Record the fields that some checks use',
            rule: 'Check D3 gives the name of each check that cannot operate, because its fields are missing.', sources: [src(SR.D3.source)],
            text: items.slice(0, 3).map(say).join(' ') + (items.length > 3 ? ` ${many(items.length - 3, 'more group')} of checks did not operate.` : '')
                + ' The Blackbox tab enables these fields (BB: "Command Setpoint Mixer PID Raw Gyro Gyro Battery RSSI RPM Motors Servos"). If `Vbat` is always 0, there is no voltage sensor.' });
    },
    D4(L, c) {
        // the CLI dump is an optional input (user rule 2026-10-06): without one there is no D4 result and no recommendation
        if (!c.cli) return [];
        const bad = L.filter(isFlag), keys = [...c.staleCli];
        return one(bad, { id: 'D4', title: 'The CLI dump and the log header do not agree', rule: 'Check D4 has a problem if a value in the log header is different from the CLI dump. The app uses the log header for these values, and the data for the governor mode.', sources: [src(SR.D4.source)],
            text: `In ${logsText(bad, c)}, the CLI dump and the log header have different values${keys.length ? ` (${and(keys.slice(0, 6))}${keys.length > 6 ? ` and ${keys.length - 6} more` : ''})` : ''}. Possibly, the CLI dump is not from the time of the logs. The app does not use the CLI values that do not agree.` });
    },
    // D9 (health_config.cjs): rescue_mode OFF in a PID profile is a prerequisite problem (SPEC3 A); a PID profile that a loaded
    // CLI dump does not have is information. Without a dump, no recommendation for the PID profiles that the logs cannot show:
    // the log header does not record rescue_mode, and the log records a rescue only when it occurs (the D9 result says so)
    D9(L, c) {
        const bad = L.filter(isFlag), unk = L.filter(f => f.severity === 'note' && thin(f)), list = new Set(unk.flatMap(f => Array.isArray(f.unknownProfiles) ? f.unknownProfiles : num(profileOf(f)) > 0 ? [profileOf(f)] : []));
        const rule = 'Check D9 has a problem if `rescue_mode` is OFF in a PID profile. The log header of Rotorflight 4.6 does not record `rescue_mode`. The log records a rescue only when it occurs.'
            + (c.cli ? ' The CLI dump gives the value of each PID profile that it has.' : ''), sources = [ruleSrc(CR, 'D9')];
        return [...group(bad, profileOf)].map(([p, l]) => { const f = l[0];
            return rec({ id: `D9:p${p}`, area: 'precondition', profile: p, severity: 'action', parameter: 'rescue_mode', scope: 'profile', direction: 'set', title: `Turn on the rescue in PID profile ${p}`, evidence: l.map(evidence), rule, sources,   // no CLI text: the pilot selects the mode and the switch
                text: `In PID profile ${p}, \`rescue_mode\` is OFF (${f.basis === 'cli' ? (c.cliName ? `CLI dump "${c.cliName.replace(/"/g, "'")}"` : 'CLI dump') : 'log header'}). `
                    + (f.flown ? `The logs have ${fmt(f.flightS, 0)} s of flight in this PID profile.` : 'The logs have no flight in this PID profile.')
                    + '\nIn the Configurator, set the rescue mode of this PID profile to CLIMB or ALT_HOLD. Then do a test of the rescue switch on the ground, with the motor off.' }); })
            .concat(list.size && c.cli ? one(unk, { id: 'D9:unknown', area: 'precondition', severity: 'info', title: 'The rescue mode of some PID profiles is unknown', rule, sources,
                text: `The analysis cannot find if the rescue is on in ${list.size > 1 ? `PID profiles ${and([...list].sort((a, b) => a - b).map(String))}` : prof([...list][0])}. The CLI dump does not have ${list.size === 1 ? 'this PID profile' : 'these PID profiles'}. `
                    + `The log header does not record \`rescue_mode\`, and the logs show no rescue in ${list.size === 1 ? 'this PID profile' : 'these PID profiles'}.` }) : []);
    },
    // P1, P2 (health_power.cjs, SPEC3 I): the battery at the load steps. Hardware: items to examine, never CLI text
    P1(L, c) {
        const R = PWR.P1 || {}, bad = L.filter(isFlag), low = L.filter(f => f.severity === 'note' && !thin(f)), sources = [ruleSrc(PWR, 'P1')];
        const rule = 'Check P1 finds each fast throttle increase of 10 % or more in 0.5 s with the governor ACTIVE. It has a problem if a step decreases the voltage from the warning level or more to less than the minimum level for each cell. '
            + 'The levels are vbat_warning_cell_voltage and vbat_min_cell_voltage of the log header.';
        const lv = (f) => { const q = f.limits || {}; return { min: num(q.min), warning: num(q.warning) }; };
        return bad.map(f => rec({ id: `P1:${logsOf(f).join('+')}`, area: 'precondition', severity: 'check', title: `Possibly a weak battery (${logsText([f], c)})`, evidence: [evidence(f)], rule, sources,
                text: `In ${logsText([f], c)}, ${many(f.severe, 'load step')} ${f.severe === 1 ? 'decreases' : 'decrease'} the voltage from ${fmt(lv(f).warning)} V or more for each cell to less than ${fmt(lv(f).min)} V. `
                    + `The lowest voltage is ${fmt(f.minCell, 2)} V for each cell, from ${fmt(f.beforeCell, 2)} V before the step.`
                    + '\nCharge the battery, and measure the voltage of each cell. Then fly with a different battery, and compare the result of check P1.' }))
            .concat(low.map(f => rec({ id: `P1:${logsOf(f).join('+')}:low`, area: 'precondition', severity: 'watch', title: `Low battery voltage at the load steps (${logsText([f], c)})`, evidence: [evidence(f)], rule, sources,
                text: `In ${logsText([f], c)}, the lowest voltage at a load step is ${fmt(f.minCell, 2)} V for each cell. This is less than the warning level of ${fmt(lv(f).warning)} V for each cell.\nLand at a higher battery voltage, or examine the battery.` })));
    },
    P2(L, c) {
        const hi = L.filter(f => f.severity === 'note' && f.higher === true && !thin(f));
        return hi.map(f => rec({ id: `P2:${logsOf(f).join('+')}`, area: 'precondition', severity: 'watch', title: 'A battery with a larger voltage decrease for each 1 A', evidence: [evidence(f)], sources: [ruleSrc(PWR, 'P2')],
            rule: `Check P2 compares the voltage decrease for each 1 A of the batteries. A battery with more than ${fmt(num((PWR.P2 || {}).relHigh), 2)} x the median of the other batteries, by ${RULES.sigmas} SE, is a value to monitor.`,
            text: `In ${logsText([f], c)}, the voltage decreases by ${pm(f.value, f.se, 1)} mΩ, and the median of the other batteries is ${fmt(f.othersMedian, 1)} mΩ.\nExamine this battery, for example with the charger.` }));
    },
    D5: diag('D5', 'precondition', 'Battery voltage steps or low voltage', `Check D5 has a problem if \`Vbat\` changes by more than ${GR.D5.step} V in 10 ms. It also has a problem if \`Vbat\` stays less than ${GR.D5.minCell} V for each cell for ${GR.D5.minS} s or more.`,
        'Examine the battery, its connector and the voltage sensor. The app does not use the power results (G8, G11 and G13) at these times.', { noun: 'value', sources: [src(GR.D5.source)] }),
    D6(L, c) {
        const bad = L.filter(isFlag), ex = L.filter(f => f.severity === 'note' && !thin(f));
        const reasons = (f) => { const s = new Map(); for (const e of f.events || []) if (e && e.reason && num(e.value) !== null) s.set(e.reason, (s.get(e.reason) || 0) + e.value); return s; };
        const WHY = { rescue: 'rescue', levelMode: 'a level mode', failsafe: 'failsafe', ground: 'ground contact' };
        // the rest of the time is the guard of health_more normalMask: RULE.spanGuardS before and after each period
        const guardS = num(MRULE.spanGuardS);
        const lines = ex.slice(0, 2).map(f => { const s = reasons(f), parts = [...s].filter(([, v]) => v > 0).map(([k, v]) => `${fmt(v, 1)} s of ${WHY[k] || k}`), rest = num(f.value) !== null ? f.value - [...s.values()].reduce((a, v) => a + v, 0) : null;
            return `In ${whereOf(f, c) || 'the log'}, the analysis did not use ${fmt(f.value, 1)} s${parts.length ? `: ${and(parts)}` : ''}.`
                + (parts.length && rest !== null && Math.round(rest * 10) > 0 ? ` The other ${fmt(rest, 1)} s is the time ${guardS !== null ? `of ${fmt(guardS, 1)} s ` : ''}before and after each of these periods.` : ''); });
        return one(bad, { id: 'D6', title: 'Failsafe in flight', rule: 'Check D6 has a problem if the failsafe is active in flight.', sources: [ruleSrc(MR, 'D6')],
            text: `The failsafe was active for ${fmt(sum(bad), 1)} s in flight (${logsText(bad, c)}). Examine the receiver, its antennas and the failsafe adjustments before you tune.` })
            .concat(one(ex, { id: 'D6:excluded', severity: 'info', title: 'Parts of the logs that the analysis did not use', rule: 'Check D6: the analysis does not use rescue, level modes, failsafe and ground contact. The log records the setpoint before these modes change it.', sources: [ruleSrc(MR, 'D6'), RULES.source.firmware],
                text: lines.join(' ') + (ex.length > 2 ? ` ${cap(many(ex.length - 2, 'more log'))} also ${ex.length - 2 === 1 ? 'has' : 'have'} parts of this type.` : '') }));
    },
    H(L) {
        const ch = L.filter(f => f.severity === 'note'), keys = new Map(); for (const f of ch) { const k = String(f.text).split(':')[0]; keys.set(k, (keys.get(k) || 0) + 1); }
        return one(ch, { id: 'H', area: 'logging', severity: 'info', title: 'Changes of the log header between logs', rule: 'Check H compares the log header of each log with the log header of the log before it.',
            text: `The log header has ${many(ch.length, 'change')} between logs: ${and([...keys].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `\`${k}\` (${v})`).concat(keys.size > 6 ? [`${keys.size - 6} more values`] : []))}. `
                + 'A result from some logs together can mix different values. The app gives no CLI text for a change that it measured before the last change of its parameter.' });
    },
    SETUP(L, c) {  // header rules of TUNING_KNOWLEDGE section 8, on the analysed log's header
        // the evidence: the SETUP finding (the header values) of the analysed log, else of every log (SPEC2 D-LOW)
        const h = c.header, out = [], own = L.filter(f => c.headerLog !== null && logsOf(f).includes(c.headerLog)), ev = (own.length ? own : L).map(evidence);
        if (num(h.rates_type) !== null && h.rates_type !== 6) out.push(fromHeader(rec({ id: 'SETUP:rates_type', area: 'rates', title: 'The rates type is not ROTORFLIGHT', parameter: 'rates_type', evidence: ev,
            rule: 'Log header: rates_type 6 (ROTORFLIGHT) is the default of 4.6. A different value possibly comes from a configuration of Rotorflight 4.5.', sources: ['Rotorflight 4.6 documentation, "release notes"'],
            text: `In the log header${c.headerLog !== null ? ` of log ${lab(c.headerLog, c)}` : ''}, rates_type is ${h.rates_type} (${RATES_TYPES[h.rates_type] || 'unknown'}). Make sure that the rate curves are correct. A configuration from Rotorflight 4.5 can keep ACTUAL.` }), c, [['rates_type', 'global']], true));
        for (const ax of ['roll', 'pitch']) { const i = pick(h[`${ax}PID`], 1);
            if (num(i) !== null && i >= RULES.mixtI) out.push(fromHeader(rec({ id: `SETUP:${ax}_i_gain`, area: 'cyclic', axis: ax, title: `${cap(ax)} I gain ${i}: possibly the temporary value of the mixer procedure`, parameter: `${ax}_i_gain`, evidence: ev,
                profile: c.headerProfile > 0 && c.headerConfirmed ? c.headerProfile : null,
                rule: `Log header: a cyclic I gain of ${RULES.mixtI} or more.`, sources: [RULES.source.mixtI],
                text: `The ${ax} I gain is ${i} (${c.headerProfile > 0 && c.headerConfirmed ? prof(c.headerProfile) : 'the PID profile at the start of the log'}). If you increased it to find the mixer limits (MIXT), the tuning must start from the value before that procedure.` }), c, [[`${ax}PID`, 'profile']], true)); }
        const pm3 = (pidModes(c) || []).filter(m => m.value !== null && Number(m.value) !== 3);  // CLI rule: pid_mode is not in the header
        if (pm3.length) out.push(rec({ id: 'SETUP:pid_mode', area: 'logging', title: `PID mode ${[...new Set(pm3.map(m => m.value))].join(', ')}: the recommendations are for mode 3`, parameter: 'pid_mode', scope: 'profile',
            rule: 'CLI: pid_mode 3 is the default of 4.6. The firmware has modes 3 and 4, and all other modes use only the F-term.', sources: [RULES.source.firmware],
            text: `pid_mode is ${and(pm3.map(m => `${m.value} in PID profile ${m.profile + 1} (section \`profile ${m.profile}\`)`))}. All gain recommendations here are for pid_mode 3. `
                + 'Mode 4 changes the units of the axis error, of the roll and pitch B and D gains, and of the yaw precompensation cutoff. The other modes use only the F-term. Make sure that the mode is correct before you change a gain on these PID profiles.' }));
        return out;
    },
    F1(L, c) {
        const bad = L.filter(isFlag), none = L.filter(f => f.severity === 'note'); if (!bad.length && !none.length) return [];
        const h = c.header, act = lpfStages(h), base = { id: 'F1', area: 'filters', rule: 'Check F1 has a problem if no gyro low-pass filter is on when the RPM filters are on.', sources: ['Configurator help text of the gyro low-pass filter'] };
        if (h.gyro_soft_type === undefined) return noHeader('F1', 'filters', bad.concat(none), c);
        if (act.length) return one(bad.concat(none), Object.assign(base, { severity: 'info', title: 'No gyro low-pass filter in previous logs', text: `In ${logsText(bad.concat(none), c)}, no gyro low-pass filter was on. The selected log has ${and(act.map(s => `${s.name} at ${s.hz} Hz`))}.` }));
        c.filterIssues.add('F1');
        if (!bad.length) return one(none, Object.assign(base, { title: 'No gyro low-pass filter', text: `There is no gyro low-pass filter and no RPM filter. The Configurator help text gives: "Without them, two second order filters are required". With a dynamic notch filter, one filter at approximately ${RULES.lpfHz} Hz is sufficient.` }));
        const sets = (h.gyro_soft_type > 0 ? [] : [['gyro_lpf1_type', 'FIRST_ORDER']]).concat([['gyro_lpf1_static_hz', RULES.lpfHz]]);
        const typeName = num(h.gyro_soft_type) !== null ? setup.LPF_TYPES[h.gyro_soft_type] || String(h.gyro_soft_type) : null;
        return one(bad, Object.assign(base, { severity: 'action', title: `Add a gyro low-pass filter at ${RULES.lpfHz} Hz`, parameter: 'gyro_lpf1_static_hz', scope: 'global', from: num(h.gyro_lowpass_hz), to: RULES.lpfHz, direction: 'set', sets,
            fromSets: { gyro_lpf1_type: typeName, gyro_lpf1_static_hz: num(h.gyro_lowpass_hz) },
            rule: `${base.rule} The cutoff is ${RULES.lpfHz} Hz.`, sources: base.sources.concat(RULES.source.lpfHz), text: `No gyro low-pass filter is on, but the RPM filters are on. Only the PID bandwidth filter changes the gyro signal before the P-term.`,
            setText: `Add a FIRST_ORDER low-pass filter at ${RULES.lpfHz} Hz, the default of 4.6.`, setNote: `A FIRST_ORDER low-pass filter at ${RULES.lpfHz} Hz is the default of 4.6.`,
            caveats: [`A FIRST_ORDER low-pass filter at ${RULES.lpfHz} Hz adds a time delay of approximately 1.6 ms (calculated). After the change, checks C11 and F10 and the checks of the tracking error give new values.`] }))
            .map(r => fromHeader(r, c, [['gyro_soft2_type', 'global'], ['gyro_lowpass2_hz', 'global'], ['gyro_lowpass_dyn_hz', 'global'], ['features', 'global']], true));
    },
    F2(L, c) {
        const bad = L.filter(isFlag), mild = L.filter(f => f.severity === 'note'); if (!bad.length && !mild.length) return [];
        if (c.header.gyro_soft_type === undefined) return noHeader('F2', 'filters', bad.concat(mild), c);
        const st = lpfStages(c.header).sort((a, b) => a.hz - b.hz)[0], rule = `Check F2 has a problem if the lowest cutoff of the gyro low-pass filters is less than ${RULES.minLpfHz} Hz. It gives a value to monitor if the cutoff is less than ${RULES.noteLpfHz} Hz.`, sources = [RULES.source.minLpfHz, RULES.source.noteLpfHz];
        if (st && st.hz < RULES.minLpfHz) { c.filterIssues.add('F2');
            return one(bad.concat(mild), { id: `F2:${st.param}`, area: 'filters', severity: 'action', title: `Increase the ${st.name} cutoff to ${RULES.minLpfHz} Hz`, parameter: st.param, scope: 'global', from: st.hz, to: RULES.minLpfHz, direction: 'raise',
                sets: [[st.param, RULES.minLpfHz]], rule: rule + ' The new value is the minimum of the documentation, not a percentage step.', sources, text: `The ${st.name} cutoff is ${st.hz} Hz, which is less than the minimum of the documentation, ${RULES.minLpfHz} Hz. A low cutoff gives more time delay and lower gains (FILT).`,
                fromSets: { [st.param]: st.hz }, caveats: ['A higher cutoff lets more vibration through. After the change, checks F5, F6 and the D-term checks give new values.'] })
                .map(r => fromHeader(r, c, [['gyro_soft_type', 'global'], ['gyro_lowpass_hz', 'global'], ['gyro_soft2_type', 'global'], ['gyro_lowpass2_hz', 'global'], ['gyro_lowpass_dyn_hz', 'global']], true)); }
        if (st && st.hz < RULES.noteLpfHz) return one(bad.concat(mild), { id: 'F2', area: 'filters', severity: 'watch', title: `Gyro low-pass filter at ${st.hz} Hz`, rule, sources,
            text: `The lowest cutoff of the gyro low-pass filters is ${st.hz} Hz (${st.name}), which is between ${RULES.minLpfHz} Hz and ${RULES.noteLpfHz} Hz. This value is correct, but FILT: "better if this cutoff is high".` });
        return one(bad.concat(mild), { id: 'F2', area: 'filters', severity: 'info', title: 'Low gyro low-pass filter in previous logs', rule, sources,
            text: `In ${logsText(bad.concat(mild), c)}, a gyro low-pass filter had a cutoff of less than ${RULES.noteLpfHz} Hz. The selected log has ${st ? `${st.name} at ${st.hz} Hz` : 'no gyro low-pass filter (refer to check F1)'}.` });
    },
    F3(L, c) {
        const bad = L.filter(isFlag); if (!bad.length) return [];
        if (c.header.dyn_notch_q === undefined && !lib.AXES.some(ax => c.header[`gyro_rpm_notch_q_${ax}`])) return noHeader('F3', 'filters', bad, c);
        const h = c.header, q = Math.round(RULES.minNotchQ * 10), out = [], base = { area: 'filters', evidence: bad.map(evidence), rule: `Check F3 has a problem if the Q of a notch filter is less than ${RULES.minNotchQ.toFixed(1)}.`, sources: [RULES.source.minNotchQ] };
        if (feature(h, 'DYN_NOTCH') && num(h.dyn_notch_q) !== null && h.dyn_notch_q < q)
            out.push(fromHeader(rec(Object.assign({ id: 'F3:dyn_notch_q', severity: 'action', title: `Set the Q of the dynamic notch filter to ${RULES.minNotchQ.toFixed(1)}`, parameter: 'dyn_notch_q', scope: 'global', from: h.dyn_notch_q, to: q, direction: 'raise', sets: [['dyn_notch_q', q]],
                fromSets: { dyn_notch_q: h.dyn_notch_q },
                text: `dyn_notch_q is ${h.dyn_notch_q}, which is a Q of ${h.dyn_notch_q / 10} (dyn_notch_q is the Q multiplied by 10). The Configurator help text gives: a Q of less than ${RULES.minNotchQ.toFixed(1)} "will greatly increase filter delay".` }, base)), c, [['features', 'global']], true));
        for (const ax of lib.AXES) { const n = notchArrays(h, ax); if (!n.source || !n.q) continue;
            const low = n.q.map((v, i) => n.source[i] > 0 && v > 0 && v < q); if (!low.some(Boolean)) continue;
            // the CLI sets a whole bank array of RPM_FILTER_BANK_COUNT values (cli.c): a header array of another length gives no CLI text
            const custom = h.gyro_rpm_notch_preset === 0, whole = n.q.length === BANKS && n.source.length === BANKS, to = n.q.map((v, i) => low[i] ? q : v).join(',');
            const r = fromHeader(rec(Object.assign({ id: `F3:gyro_rpm_notch_q_${ax}`, severity: custom ? 'action' : 'check', parameter: `gyro_rpm_notch_q_${ax}`, scope: 'global', from: n.q.join(','), to, direction: 'raise',
                title: custom ? `Set the Q of the ${ax} RPM notch filters to ${RULES.minNotchQ.toFixed(1)}` : `Q of less than ${RULES.minNotchQ.toFixed(1)} in the ${ax} RPM notch filters of a preset`,
                sets: custom && whole ? [[`gyro_rpm_notch_q_${ax}`, to]] : null, fromSets: { [`gyro_rpm_notch_q_${ax}`]: n.q.join(',') },
                text: `The ${ax} RPM notch filters in bank ${and(low.map((v, i) => v ? String(i) : null).filter(Boolean))} have a Q of less than ${RULES.minNotchQ.toFixed(1)} (values ${and(n.q.filter((v, i) => low[i]).map(String))}, the Q multiplied by 10).`
                    + (custom ? '' : ' At the start, the firmware replaces the banks that you set with the banks of the preset. Thus, a change of these banks is possible only with gyro_rpm_notch_preset 0.') }, base)),
                c, [['gyro_rpm_notch_preset', 'global'], [`gyro_rpm_notch_source_${ax}`, 'global']], true);
            if (custom && !whole) r.caveats.push(BANK_TEXT(`gyro_rpm_notch_q_${ax}`, n.q.length));
            out.push(r);
        }
        if (out.length) c.filterIssues.add('F3');
        return out.length ? out : one(bad, { id: 'F3', area: 'filters', severity: 'info', title: `Notch filter Q of less than ${RULES.minNotchQ.toFixed(1)} in previous logs`, rule: base.rule, sources: base.sources,
            text: `In ${logsText(bad, c)}, a notch filter had a Q of less than ${RULES.minNotchQ.toFixed(1)}. The selected log has no such notch filter.` });
    },
    F4(L) {
        return [...group(L.filter(f => f.severity === 'note'), f => f.profile)].map(([ax, list]) => { const v = list[list.length - 1].value;
            return rec({ id: `F4:${ax}_d_cutoff`, area: 'filters', severity: 'info', axis: ax, title: `${cap(ax)} D-term cutoff at ${v} Hz`, parameter: `${ax}_d_cutoff`, evidence: list.map(evidence),
                rule: `Check F4 compares the D-term cutoff with ${SR.F4.targetHz} ± ${SR.F4.toleranceHz} Hz. It gives information only.`, sources: ['Rotorflight documentation, "Profiles tab": "around 20Hz"', 'toolkit rule: the tolerance of check F4'],
                text: `The ${ax} D-term cutoff is ${v} Hz, and PROF gives approximately ${SR.F4.targetHz} Hz. The logs do not show that a change is necessary.` + (ax === 'yaw' ? ' If the yaw has an oscillation that decreases after a CCW stop, a lower value is possible (20 Hz to 15 Hz, a recommendation from other pilots).' : '') }); });
    },
    F5(L, c) {
        const bad = L.filter(isFlag); if (!bad.length) return [];
        // the tail rotor harmonics: from the CLI dump, else from the notch orders that the log shows (c.gear, basis 'log notch')
        const h = c.header, gear = gearOf(c.cli) || c.gear || null, tail = tailOrders(gear), tol = SR.F5.maxDistance;
        const tailUnknown = !c.cli && !(tail && tail.length) && lib.AXES.some(ax => (notchArrays(h, ax).source || []).some(s => s >= 21 && s <= 28));
        // every line of every flag (health_setup F5: the lines of one log and PID profile, strongest first), with the axes
        // that have no notch filter at 2 % or less from it, and what the gyro filters pass of it (the worker's filterPass:
        // gyroRAW to gyroADC at the line, in a log with curves)
        const maxPass = (q) => q && lib.AXES.every(ax => num(q[ax]) !== null) ? Math.max(...lib.AXES.map(ax => q[ax])) : null;
        const lines = bad.flatMap(f => String(f.text).split('; ').map((seg, i) => {
            const m = /^line at ([\d.]+) x rotor \(([\d.]+) Hz, prominence ([\d.]+)/.exec(seg); if (!m) return null;
            const uncovered = lib.AXES.filter(ax => { const a = new RegExp(`\\b${ax} (?:\\d+ at [\\d.]+ \\(([\\d.]+) %\\)|none)`).exec(seg); return a && (a[1] === undefined || +a[1] > tol * 100); });
            const pass = Array.isArray(f.filterPass) ? f.filterPass.find(q => Math.abs(q.hz - +m[2]) < 0.5) || null : null;
            const axes = [...seg.matchAll(/\b(roll|pitch|yaw) (?:(\d+) at [\d.]+ \(([\d.]+) %\)|none)/g)].map(a => ({ axis: a[1], code: a[2] === undefined ? null : +a[2], distance: a[3] === undefined ? null : +a[3] / 100 }));
            const locked = /\brotor-locked\)/.test(seg) && !/not rotor-locked/.test(seg);   // health_setup: the same order at another headspeed
            return { f, seg, first: i === 0, order: +m[1], hz: +m[2], prominence: +m[3], locked, uncovered, axes, pass, passMax: maxPass(pass) };
        })).filter(Boolean);
        for (const f of bad) { const own = lines.filter(l => l.f === f); own.forEach(l => { l.first = false; }); if (!own.length) continue;
            const top = own.reduce((a, l) => l.prominence > a.prominence ? l : a); top.first = true;
            // the evidence of the worker (evidence.cjs facts.axes, review D-M5a) gives the axes of the strongest line that have a peak
            const fx = f.evidence && f.evidence.facts && Array.isArray(f.evidence.facts.axes) ? f.evidence.facts.axes.filter(a => a && lib.AXES.includes(a.axis)) : null;
            if (fx && fx.length && num(f.value) !== null && Math.abs(f.value / top.order - 1) < 1e-3) { top.axes = fx.map(a => ({ axis: a.axis, code: num(a.code), distance: num(a.distance) })); top.uncovered = fx.filter(a => !a.near).map(a => a.axis); } }
        // each axis of a line (review D-M5a): its nearest notch filter and the distance
        const axisNote = (l) => l.axes.length ? `At ${l.hz} Hz, the nearest notch filters are ${and(l.axes.map(a => `${a.code !== null ? `source ${a.code}` : 'none'} (${a.axis}${a.distance !== null ? `, ${pct(a.distance, 1)} from the line` : ''})`))}.` : null;
        const cite = (qs) => bad.filter(f => qs.some(q => q.lines.some(l => l.f === f))).map(evidence);   // the flags that hold the lines of qs
        // one line in each PID profile: the same rotor order within the harmonic tolerance of check G12 (a rotor-locked line
        // keeps its order when the headspeed changes). A line that is the strongest of a flag is handled; a weaker line is
        // left to the low-pass filter (RPMF: each notch filter adds a time delay), unless checks C11 and F10 show a problem
        const clusters = [];
        for (const l of lines.slice().sort((a, b) => b.prominence - a.prominence)) { const q = clusters.find(x => Math.abs(l.order / x.order - 1) <= GR.G12.tolerance); if (q) q.lines.push(l); else clusters.push({ order: l.order, lines: [l] }); }
        for (const q of clusters) { const k = Math.max(1, Math.round(q.order)), passes = q.lines.map(l => l.passMax);
            Object.assign(q, { k, top: q.lines[0], handled: q.lines.some(l => l.first), harmonic: Math.abs(q.order / k - 1) <= RULES.harmonicTol, measured: passes.every(v => v !== null),
                removed: passes.every(v => v !== null) && Math.max(...passes) < RULES.filteredPass, uncovered: lib.AXES.filter(ax => q.lines.some(l => l.uncovered.includes(ax))) });
            q.main = q.harmonic && k <= RULES.maxMainHarmonic;
            // a tail rotor harmonic j (in RULES.harmonicTol of j x the tail rotor order: the CLI dump, else the notch orders that the
            // log shows) is a rotor harmonic, not a resonance: an RPM notch filter with source 20 + j follows it (rpm_filter.c)
            const th = !q.harmonic && tail && tail.length ? tail.map(({ k: j, o }) => ({ j, d: Math.abs(q.order / o - 1) })).sort((a, b) => a.d - b.d)[0] : null;
            q.tailK = th && th.d <= RULES.harmonicTol ? th.j : null; }
        const topC = clusters[0] || null, top = topC ? topC.top : null; c.topLine = top;
        if (!top) return [rec({ id: 'F5', area: 'filters', title: 'Vibration line with no notch filter', evidence: bad.map(evidence), rule: `Check F5 examines the gyroRAW lines with a prominence of ${SR.F5.minProminence} or more.`, sources: [src(SR.F5.source)],
            text: `${bad.length === 1 ? '1 result shows' : `${bad.length} results show`} a strong vibration line with no notch filter at ${tol * 100} % or less from it.` })];
        const at = (l) => `(${l.hz} Hz, prominence ${l.prominence}, ${whereOf(l.f, c)})`, axesText = (ax) => `the ${and(ax)} ${ax.length === 1 ? 'axis' : 'axes'}`;
        // where one line is in each PID profile, and the reason that its prominence has no SE. A caveat is a description of 25
        // words or less (STE Rule 6.3): each line of a short list, else the range of each PID profile, else one range of all
        const each = (q) => {
            if (q.lines.length < 2) return '';
            const ls = q.lines.slice().sort((a, b) => a.hz - b.hz), head = `In the logs, the line at ${order(q.top.order)} is at`;
            if (EACH_LIST.fixed + 2 * ls.length <= EACH_LIST.words) return `${head} ${and(ls.map(l => `${l.hz} Hz (${whereOf(l.f, c)})`))}.`;
            const one = (xs) => xs[0].hz === xs[xs.length - 1].hz, range = (xs) => one(xs) ? `${xs[0].hz} Hz` : `${xs[0].hz} Hz to ${xs[xs.length - 1].hz} Hz`, by = new Map();
            for (const l of ls) { const p = num(profileOf(l.f)) > 0 ? num(profileOf(l.f)) : 0; (by.get(p) || by.set(p, []).get(p)).push(l); }
            const groups = [...by].sort((a, b) => (a[0] || 7) - (b[0] || 7));
            if (EACH_LIST.fixed + groups.reduce((s, [, xs]) => s + (one(xs) ? 2 : 4), 0) > EACH_LIST.words) return `${head} ${range(ls)} (${many(ls.length, 'result')} in ${many(groups.length, 'PID profile')}).`;
            return `${head} ${and(groups.map(([p, xs]) => `${range(xs)} (${prof(p)}, ${many(xs.length, 'result')})`))}.`;
        };
        const wins = [...new Set(bad.map(f => num(f.n)).filter(v => v !== null))].sort((x, y) => x - y);
        const noSe = `Check F5 gives no SE for a prominence, because it calculates one spectrum for each log and PID profile${wins.length ? ` (${wins.length === 1 ? wins[0] : `${wins[0]} to ${wins[wins.length - 1]}`} windows)` : ''}.`;
        const rule = `Check F5 examines the gyroRAW lines with a prominence of ${SR.F5.minProminence} or more. It has a problem if the nearest notch filter is more than ${tol * 100} % from a line on 1 or more axes.`, sources = [src(SR.F5.source)];
        const out = [], handled = clusters.filter(q => q.handled), open = handled.filter(q => !q.removed);
        // a main rotor harmonic that is weaker than the strongest line of its log and PID profile (review: Fireball 2026-10-05
        // log 16, harmonic 3 at 224.9 Hz under the 3.79 x resonance) gets an RPM notch filter too, on each axis where it is
        // rotor-locked, has a prominence of minProminence or more, has no notch filter at 2 % or less, and the gyro filters let
        // RULES.weakPass or more of it through (measured). A line at 1 x rotor from a resonance is a part of that resonance (the
        // 2.79 x and 4.79 x lines beside 3.79 x), not a harmonic: it never gets an RPM notch filter
        const resonances = handled.filter(q => !q.harmonic && !q.tailK).map(q => q.order);
        const besideOf = (o, ro) => [ro - 1, ro + 1].some(s => s > 0 && Math.abs(o / s - 1) <= RULES.harmonicTol);
        const weakAxes = (l) => l.locked && l.prominence >= SR.F5.minProminence && !resonances.some(ro => besideOf(l.order, ro))
            ? l.uncovered.filter(ax => l.pass && num(l.pass[ax]) !== null && l.pass[ax] >= RULES.weakPass) : [];
        const weak = clusters.filter(q => !q.handled && q.main).map(q => { const ok = q.lines.filter(l => weakAxes(l).length);
            return ok.length ? Object.assign(q, { lines: ok, top: ok[0], weak: true, measured: true, uncovered: lib.AXES.filter(ax => ok.some(l => weakAxes(l).includes(ax))) }) : null; }).filter(Boolean);
        if (open.length || weak.length) c.filterIssues.add('F5');
        // the strongest line, when the gyro filters remove it in every log where it is (measured): no filter problem
        if (topC.removed) {
            const pass = top.pass, passes = Array.isArray(top.f.filterPass) ? top.f.filterPass : [];
            const through = passes.filter(q => q !== pass && maxPass(q) !== null && maxPass(q) >= RULES.filteredPass).sort((a, b) => maxPass(b) - maxPass(a));
            out.push(rec({ id: 'F5', area: 'filters', severity: 'info', title: through.length ? 'The filters remove the strongest vibration line' : 'The filters remove the vibration line', evidence: cite([topC]),
                rule: `Check F5 has a problem, but the gyro filters let less than ${RULES.filteredPass * 100} % of its strongest line through.`, sources: sources.concat(RULES.source.filteredPass),
                text: `The strongest vibration line is at ${order(top.order)} ${at(top)}.${topC.uncovered.length ? ` It has no notch filter at ${tol * 100} % or less on ${axesText(topC.uncovered)}.` : ''} `
                    + `But the gyro filters let only ${and(lib.AXES.map(ax => `${fmt(pass[ax] * 100, 1)} %`))} of it through (roll, pitch and yaw, from gyroRAW to gyroADC). Thus, a notch filter is not necessary. `
                    + (through.length ? `Only the low-pass filter decreases ${many(through.length, 'weaker line')} (${through.slice(0, 4).map(q => `${q.hz} Hz, up to ${fmt(maxPass(q) * 100, 0)} %`).join(', ')}${through.length > 4 ? ' and more' : ''}). ` : '')
                    + 'A line this strong is a cause to examine the balance, the blade tracking and the bearings.',
                caveats: (through.length ? ['Each notch filter adds a time delay (RPMF). Thus, the app adds no notch filter for the weaker lines if checks C11 and F10 show no problem.'] : []).concat([axisNote(top), noSe].filter(Boolean)) }));
        }
        // a line that the filters do not remove, with a tail rotor notch filter whose frequency the log does not record (no CLI
        // dump): possibly that notch filter is on the line (guard 9): a check, before any filter change
        if ((open.length || weak.length) && tailUnknown) { const q = open[0] || weak[0];
            const r = rec({ id: q === topC ? 'F5' : 'F5:tail', area: 'filters', title: 'Vibration line with no notch filter', evidence: cite(open.concat(weak)), rule, sources, caveats: [noSe],
                text: `${bad.length === 1 ? '1 result shows' : `${bad.length} results show`} a strong vibration line with no notch filter at ${tol * 100} % or less from it. The strongest of these lines is at ${order(q.top.order)} ${at(q.top)}. `
                    + 'The log does not record the frequency of the tail rotor notch filters. Thus, the analysis cannot find if a tail rotor notch filter is on this line.'
                    + (q.measured || !(q.top && q.top.f) ? '' : `\nTo measure the filters at this line, do the analysis of ${logsText([q.top.f], c)} with "This log" in "Logs".`) });
            r.caveats.unshift('A tail rotor notch filter (source 21 to 28) is in the configuration. The log does not record its frequency. Possibly, it is on this line.');
            return out.concat(r); }
        // main rotor harmonics 1-8 that the filters do not remove: RPM notch filters, source 10 + k (rpm_filter.c), Q 4.0
        // (FILT), in the first free bank of each axis with no notch filter for the line; one recommendation, because each
        // CLI line sets a whole bank array. A tail rotor harmonic j: source 20 + j, the same way
        const mains = open.filter(q => q.main || q.tailK).concat(weak);
        const hname = (q) => q.tailK ? `tail rotor harmonic ${q.tailK}` : `main rotor harmonic ${q.k}`, hsrc = (q) => q.tailK ? 20 + q.tailK : 10 + q.k, hshort = (q) => q.tailK ? hname(q) : `harmonic ${q.k}`;
        if (mains.length) {
            const arrays = {}; let why = null;
            for (const ax of lib.AXES) { const n = notchArrays(h, ax); arrays[ax] = n.source && n.q && n.center ? { n, source: n.source.slice(), q: n.q.slice(), center: n.center.slice() } : null; }
            for (const q of mains) for (const ax of q.uncovered) { const a = arrays[ax];
                if (!a) { why = why || `The log header does not have the RPM notch banks of the ${ax} axis. Thus, there is no CLI text.`; continue; }
                if (a.source.length !== BANKS || a.q.length !== BANKS || a.center.length !== BANKS) { why = why || BANK_TEXT(`gyro_rpm_notch_source_${ax}`, a.source.length); continue; }
                const i = a.source.indexOf(0); if (i < 0) { why = why || `All ${BANKS} RPM notch banks of the ${ax} axis are in use. Thus, there is no CLI text.`; continue; }
                a.source[i] = hsrc(q); a.q[i] = 40; a.center[i] = 0; }
            const axes = lib.AXES.filter(ax => mains.some(q => q.uncovered.includes(ax))), fromSets = {};
            let sets = h.gyro_rpm_notch_preset === 0 ? [] : [['gyro_rpm_notch_preset', 0]]; if (h.gyro_rpm_notch_preset !== 0) fromSets.gyro_rpm_notch_preset = num(h.gyro_rpm_notch_preset);
            for (const ax of axes) { const a = arrays[ax]; if (!a) continue;
                for (const k of ['source', 'q', 'center']) { sets.push([`gyro_rpm_notch_${k}_${ax}`, a[k].join(',')]); fromSets[`gyro_rpm_notch_${k}_${ax}`] = a.n[k].join(','); } }
            if (why) sets = null;
            const ks = mains.map(q => q.k), one1 = mains.length === 1, q0 = mains[0], tails = mains.filter(q => q.tailK), passText = (q) => q.measured ? `The gyro filters let ${fmt(Math.min(...q.lines.map(l => l.passMax)) * 100, 0)} % to ${fmt(Math.max(...q.lines.map(l => l.passMax)) * 100, 0)} % of ${hshort(q)} through.` : '';
            const r = rec({ id: mains.includes(topC) ? 'F5' : 'F5:rpm', area: 'filters', severity: 'action', title: one1 ? `RPM notch filter at ${hname(q0)}` : tails.length ? `RPM notch filters at ${and(mains.map(hname))}` : `RPM notch filters at main rotor harmonics ${and(ks.map(String))}`,
                parameter: axes.length ? `gyro_rpm_notch_source_${axes[0]}` : null, scope: 'global', direction: 'set', sets: axes.length ? sets : null, fromSets, evidence: cite(mains),
                rule: `${rule} The gear ratios in the configuration are correct. RPM notch filters follow the main rotor harmonics 1 to ${RULES.maxMainHarmonic}${tails.length ? ' and the tail rotor harmonics 1 to 8' : ''}.`
                    + (weak.length ? ` A weaker harmonic gets an RPM notch filter if the gyro filters let ${RULES.weakPass * 100} % or more of it through.` : ''),
                sources: sources.concat(RULES.source.maxMainHarmonic, weak.length || tails.length ? [RULES.source.harmonicTol] : [], weak.length ? [RULES.source.weakPass] : []),
                text: mains.map(q => `${q === topC ? 'The strongest vibration line' : 'A vibration line'} with no notch filter on ${axesText(q.uncovered)} is at ${order(q.top.order)} ${at(q.top)}, ${hname(q)}.`).join(' ')
                    + ' The gear ratios in the configuration are correct.',
                setText: `${mains.map(q => `Add an RPM notch filter with source ${hsrc(q)} and Q 4.0 (FILT) on ${axesText(q.uncovered)}.`).join(' ')}`,
                setNote: `${mains.map(q => `An RPM notch filter with source ${hsrc(q)} and Q 4.0 (FILT) on ${axesText(q.uncovered)} can remove ${hshort(q)}.`).join(' ')}`,
                caveats: [noSe, 'Each notch filter adds a time delay (RPMF). After the change, checks F11, C13 and T12 give new values.', 'Banks that you set are possible only with gyro_rpm_notch_preset 0, and the CLI text keeps the banks of the preset from the log header.']
                    .concat(mains.map(each).filter(Boolean), mains.map(passText).filter(Boolean), mains.map(q => axisNote(q.top)).filter(Boolean)).concat(why ? [why] : []) });
            out.push(fromHeader(r, c, [['gyro_rpm_notch_preset', 'global']].concat(axes.map(ax => [`gyro_rpm_notch_q_${ax}`, 'global'])), false));
        }
        // the other lines that the filters do not remove: no RPM notch source follows them. The dynamic notch filter, or a static
        // notch filter at one frequency, with the range of the strongest of them in each PID profile
        const rest = open.filter(q => !q.main && !q.tailK);
        if (rest.length) {
            const q = rest[0], hzs = q.lines.map(l => l.hz), lo0 = Math.min(...hzs), hi0 = Math.max(...hzs), span = lo0 === hi0 ? `${lo0} Hz` : `${lo0} Hz to ${hi0} Hz`;
            const the = lo0 === hi0 ? `the line at ${span}` : `the line in each log and PID profile (${span})`;
            const lo = num(h.dyn_notch_min_hz), hi = num(h.dyn_notch_max_hz), dyn = feature(h, 'DYN_NOTCH'), inside = dyn === true && lo !== null && hi !== null && lo0 >= lo && hi0 <= hi;
            const ways = inside ? `The dynamic notch filter is on, and its range (${lo} Hz to ${hi} Hz) contains ${the}. Make sure that dyn_notch_count gives a notch filter for it.`
                : hi0 > 500 ? `${hi0} Hz is more than the maximum dyn_notch_max_hz (500 Hz in the firmware). Thus, the dynamic notch filter cannot remove ${lo0 === hi0 ? 'it' : 'all of it'}.`
                : dyn === true ? `The dynamic notch filter is on, but its range (${lo} Hz to ${hi} Hz) does not contain ${the}. A range that contains ${span} can remove it (dyn_notch_min_hz and dyn_notch_max_hz, the CLI range of the maximum is 100 to 500).`
                : dyn === false ? `The dynamic notch filter is off (the bit of \`feature DYN_NOTCH\` in the log header is 0). If you turn it on with a range that contains ${span} (dyn_notch_min_hz, dyn_notch_max_hz), it can remove this line.`
                : `The log header does not show if the dynamic notch filter is on (\`feature DYN_NOTCH\`). With a range that contains ${span}, it can remove this line. The firmware turns it off when the PID loop rate is less than 1 kHz (F8).`;
            const STATIC = 'A static notch filter (gyro_notch1_hz, gyro_notch1_cutoff) has one frequency, and it is correct for one headspeed only.';
            const head = `${q === topC ? 'The strongest vibration line' : 'A strong vibration line'} with no notch filter on ${axesText(q.uncovered)} is at ${order(q.top.order)} ${at(q.top)}.`;
            const more = rest.length > 1 ? [`${cap(many(rest.length - 1, 'other line'))} with no notch filter ${rest.length > 2 ? 'are' : 'is'} the strongest line of a log and PID profile: ${rest.slice(1, 4).map(x => `${order(x.top.order)} at ${x.top.hz} Hz`).join(', ')}.`] : [];
            const id = q === topC ? 'F5' : 'F5:resonance';
            // the lines at 1 x rotor from the resonance: a part of it, not rotor harmonics, with no RPM notch filter
            // (a line at a tail rotor harmonic is not a part of the resonance: it gets its RPM notch filter above)
            const tailHarmonic = (o) => !!(tail && tail.some(t => Math.abs(o / t.o - 1) <= RULES.harmonicTol));
            const beside = [...new Map(lines.filter(l => !q.harmonic && besideOf(l.order, q.order) && !tailHarmonic(l.order)).map(l => [fmt(l.order, 2), l.order])).values()].sort((x, y) => x - y);
            const besideText = beside.length ? [`The ${beside.length === 1 ? 'line' : 'lines'} at ${and(beside.map(o => order(fmt(o, 2))))} ${beside.length === 1 ? 'is' : 'are'} 1 × rotor from this resonance. `
                + `${beside.length === 1 ? 'It is' : 'They are'} a part of the resonance, not rotor harmonics. Thus, the app gives no RPM notch filter for ${beside.length === 1 ? 'it' : 'them'}.`] : [];
            const r = rec({ id, area: 'filters', title: `Vibration line at ${q.top.hz} Hz with no notch filter`, evidence: cite(rest), rule, sources, caveats: [noSe].concat(each(q) ? [each(q)] : [], axisNote(q.top) ? [axisNote(q.top)] : [], more, besideText) });
            const tailKnown = !!gear && (gear.motorisedTail || !!(tail && tail.length));
            if (q.harmonic) {  // main-rotor harmonic k > 8: no RPM notch source exists for it
                Object.assign(r, { title: `Vibration at main rotor harmonic ${q.k}: an RPM notch filter is not possible`, rule: r.rule + ` The gear ratios in the configuration are correct. RPM notch filters follow only the main rotor harmonics 1 to ${RULES.maxMainHarmonic}.`, sources: sources.concat(RULES.source.maxMainHarmonic) });
                r.text = `${head} It is main rotor harmonic ${q.k}, but an RPM notch filter can follow only harmonics 1 to ${RULES.maxMainHarmonic} (sources 11 to 18). The gear ratios in the configuration are correct. ${ways} Examine the blade tracking and the balance first (FILT).`;
                r.caveats.push(STATIC);
            } else if (!q.measured && !tailKnown) {
                // D-H2: the filters were not measured at this line and the tail rotor harmonics are unknown: no claim that it is a
                // resonance, a check that asks for the measurement
                Object.assign(r, { title: `Vibration line at ${q.top.hz} Hz: measure the filters at this line` });
                r.text = `${head} The analysis did not measure the part of this line that the gyro filters let through, because the results of ${logsText(q.lines.map(l => l.f), c)} have no spectra. `
                    + `The log does not record the frequencies of the tail rotor harmonics. Thus, the app cannot find the cause of this line. `
                    + `To measure the filters at this line, do the analysis of ${logsText([q.top.f], c)} with "This log" in "Logs".`;
            } else {
                // not a rotor harmonic. The gear ratios in the configuration are correct (CLAUDE.md, SPEC2 section 6): the line is a
                // resonance, a filter target and a mechanical vibration to examine, never a sign of an incorrect ratio
                const near = tail && tail.length ? tail.map(({ k: j, o }) => ({ k: j, o, d: Math.abs(q.top.order / o - 1) })).sort((a, b) => a.d - b.d)[0] : null;
                Object.assign(r, { title: `Resonance at ${q.top.hz} Hz with no notch filter`, rule: r.rule + ' The gear ratios in the configuration are correct. Thus, a line that is not a rotor harmonic is a resonance.' });
                r.text = head + (near ? ` It is not a main rotor harmonic or a tail rotor harmonic (the nearest tail rotor harmonic is harmonic ${near.k}, at ${order(fmt(near.o, 4))}, ${pct(near.d, 1)} from the line).`
                        : gear && gear.motorisedTail ? ` It is not a main rotor harmonic, and on a motorized tail (tail_rotor_mode ${gear.mode}) the tail rotor speed does not follow the main rotor.` : ' It is not a main rotor harmonic.')
                    + ' Because the gear ratios in the configuration are correct, this line is a resonance of a part of the helicopter. ' + ways
                    + ' Also examine the bearings, the frame, the tail boom and the blade grips for the cause of the vibration.';
                if (!q.measured) r.caveats.push('The analysis did not measure the part of this line that the gyro filters let through. The analysis of one log ("This log" in "Logs") measures it.');
                r.caveats.push(`${bad.length === 1 ? '1 result shows' : `${bad.length} results show`} a strong vibration line with no notch filter at ${tol * 100} % or less from it.`, STATIC);
            }
            out.push(r);
        }
        return out;
    },
    F6(L, c) {
        const bad = L.filter(isFlag); if (!bad.length) return [];
        const r = rec({ id: 'F6', area: 'filters', title: `RPM notch filter that decreases its line by less than ${SR.F6.minDb} dB`, evidence: bad.map(evidence), rule: `Check F6 has a problem if an RPM notch filter decreases its line by less than ${SR.F6.minDb} dB.`, sources: [src(SR.F6.source)],
            text: [`${bad.length === 1 ? '1 result shows' : `${bad.length} results show`} that an RPM notch filter decreases its line by less than ${SR.F6.minDb} dB.`, range('decrease', bad, 'dB')].filter(Boolean).join(' ') + ' '
                + `Possibly, the line is not at the frequency of the notch filter, or the Q of the notch filter is too high. The gear ratios in the configuration are correct. If check G12 shows a problem, motor_poles or the RPM sensor can be the cause. `
                + `If not, a different center (gyro_rpm_notch_center_*) or a lower Q, but not less than ${RULES.minNotchQ.toFixed(1)}, can correct it.` });
        if (bad.every(f => clears({ value: f.value, se: f.se }, SR.F6.minDb, -1) === false)) r.sig = `No result of check F6 is less than ${SR.F6.minDb} dB by ${RULES.sigmas} SE.`;
        if (!r.sig) c.filterIssues.add('F6');   // guard 1: a flag that stands (clears 2 SE, or has no SE) holds the gain raises
        return [r];
    },
    F8(L, c) {
        const sel = L.filter(f => f.severity === 'note'), unc = sel.filter(f => /without RPM notch coverage/.test(String(f.text))), forced = sel.filter(f => /forced off/.test(String(f.text)));
        return one(unc, { id: 'F8', area: 'filters', title: 'Dynamic notch filter off, but some lines have no notch filter', rule: 'Check F8 compares the dynamic notch filter with the F5 lines that have no notch filter. The firmware turns it off when the PID loop rate is less than 1 kHz.',
            text: `The dynamic notch filter is off, but strong lines have no RPM notch filter (check F5, ${logsText(unc, c)}). \`feature DYN_NOTCH\` turns it on, up to dyn_notch_max_hz (${fmt(c.header.dyn_notch_max_hz, 0)} Hz).`
                + (c.topLine && num(c.header.dyn_notch_max_hz) !== null && c.topLine.hz > c.header.dyn_notch_max_hz ? ` The strongest line with no notch filter is at ${c.topLine.hz} Hz, which is more than this maximum.` : '') + ' RPMF: keep it on if an autorotation is possible.' })
            .concat(one(forced, { id: 'F8:pid', area: 'filters', severity: 'info', title: 'The firmware turns off the dynamic notch filter', rule: 'Check F8: the firmware turns off the dynamic notch filter when the PID loop rate is less than 1 kHz.', sources: [RULES.source.firmware],
                text: `In ${logsText(forced, c)}, the PID loop rate is less than 1 kHz. Thus, the firmware turns off the dynamic notch filter.` }));
    },
    F9(L, c) {
        const sel = L.filter(f => f.severity === 'note');
        return one(sel, { id: 'F9', area: 'filters', severity: 'info', title: 'Notch filters with a frequency that is too high or unknown', rule: 'Check F9 compares the frequency of each notch filter with the Nyquist frequency of the log and with `0.45 × filter rate` (the app calculates them).',
            text: `Some notch filters have a frequency that is unknown or more than the Nyquist frequency of the log (${logsText(sel, c)}).${c.cli ? '' : ' The log does not record the frequency of a tail rotor notch filter.'}` });
    },
    F10(L, c) {
        const yaw = L.filter(f => axisOf(f) === 'yaw'), bad = yaw.filter(isFlag); if (bad.length) c.filterIssues.add('F10 yaw');
        const hz = MRULE.noise ? MRULE.noise.hz : null, rule = `Check F10 has a problem if more than ${pct(SIGMA.F10[0])} of the yaw D-term power is at more than ${fmt(hz, 0)} Hz, by ${RULES.sigmas} SE.`, sources = [ruleSrc(MR, 'F10')];
        return one(bad, { id: 'F10', area: 'filters', axis: 'yaw', title: 'Gyro noise in the yaw D-term', rule, sources: sources.concat(RULES.source.community),
            text: `Most of the yaw D-term power is at more than ${fmt(hz, 0)} Hz (${logsText(bad, c)}). Examine the tail notch filters first (checks F5 and F6). A recommendation from other pilots is: "keep D at 0 until RPM filters work".` })
            .concat(perProfile(yaw, c, 'F10', { area: 'tail', axis: 'yaw', rule: `${rule} The estimate uses all measured logs of the PID profile. The step is ${RULES.tailDStep}.`, sources: sources.concat(RULES.source.tailDStep),
                size: () => ({ parameter: 'yaw_d_gain', add: -RULES.tailDStep, direction: 'lower', title: 'Decrease the yaw D gain', text: 'The yaw D gain makes the vibration larger, and it adds only a small quantity of damping to the tail.',
                    caveats: ['It is better to correct the filters first. A lower D gain gives less damping to the tail.'] }) }));
    },
    F7: diag('F7', 'filters', 'The vibration level changed', 'Check F7 has a problem if the ratio of the gyroRAW vibration levels of 2 groups of flights is 2 or more.',
        'Examine the blade tracking and the balance first (FILT: "Check them first"). Then examine the notch filters.', { sources: ['toolkit rule. The documentation gives no number'] }),
    F11: diag('F11', 'filters', 'Large time delay in the gyro filters', `Check F11 has a problem if the measured time delay from gyroRAW to gyroADC at ${MRULE.delay ? MRULE.delay.band.join(' Hz to ') : 'unknown'} Hz is more than ${fmt(ruleNum(MR, 'F11', 'flagMs'))} ms by ${RULES.sigmas} SE.`,
        'Too many filters give a time delay. FILT: "a filter too strong ... may lower the maximum gains later". RPMF: "minimize the filters used". Examine the low-pass filter cutoffs and the number of notch filters.', { noun: 'time delay', unit: 'ms', sources: [ruleSrc(MR, 'F11')] }),
    G0(L, c) {
        const sel = L.filter(f => f.severity === 'note' && /DIRECT or LIMIT/.test(String(f.text)));
        return one(sel, { id: 'G0', area: 'governor', severity: 'info', title: 'The governor does not control the headspeed (DIRECT or LIMIT)', rule: 'Check G0: govSum and govI are 0 in flight.', sources: [src(GR.G0.source)],
            text: `In ${logsText(sel, c)}, the governor does not control the headspeed. Thus, the app does not examine the governor gains, and it does not use govP, govD, govF or govTarget.` });
    },
    G1(L, c) {
        const bad0 = L.filter(isFlag), proxy = L.filter(f => f.severity === 'note' && !thin(f) && /glitch-proxy/.test(String(f.text)));
        // K22: a FALLBACK that comes at an overload of check G19 (the headspeed decreases with the throttle at its high value before
        // the governor changes) is a possible result of that overload: a watch with the cause, not a repair of the RPM source
        const ex = bad0.filter(f => c.g1Overload.has(f)), bad = bad0.filter(f => !c.g1Overload.has(f)), g20 = (c.F || []).filter(f => f.id === 'G20' && ex.some(g => logsOf(g).some(l => logsOf(f).includes(l))));
        return one(bad, { id: 'G1', title: 'The RPM signal is not available or not correct', rule: 'Check G1 has a problem if the governor goes to FALLBACK.', sources: [src(GR.G1.source)],
            text: `There ${sum(bad) === 1 ? 'is 1 FALLBACK entry' : `are ${fmt(sum(bad), 0)} FALLBACK entries`} (${logsText(bad, c)}). Repair the RPM source (its electrical parts, the sensor or the ESC telemetry) before you change the governor or the RPM filters.` })
            .concat(one(ex.concat(g20), { id: 'G1:overload', severity: 'watch', title: 'FALLBACK at a headspeed decrease at full throttle', sources: [src(GR.G1.source), ruleSrc(RR, 'G19'), ruleSrc(RR, 'G20')],
                rule: 'Check G1 has a problem if the governor goes to FALLBACK. Rule K22: a FALLBACK at a large load of check G19 or G20 is a possible result of that load.',
                text: `There ${sum(ex) === 1 ? 'is 1 FALLBACK entry' : `are ${fmt(sum(ex), 0)} FALLBACK entries`} (${logsText(ex, c)}). Each one comes while the headspeed decreases with the throttle at its limit (checks G19 and G20). `
                    + 'Thus, the FALLBACK is possibly a result of this large load, and the RPM signal is possibly correct. Decrease the load first (check G19). If FALLBACK also occurs at a constant load, repair the RPM source.' }))
            .concat(one(bad0.length ? [] : proxy, { id: 'G1:proxy', severity: 'watch', title: 'Possible errors of the RPM signal', rule: 'Check G1: possible errors of the RPM signal in flight. This is an indication only, because the log records the headspeed after a different filter.',
                text: `The recorded headspeed shows ${proxy.length === 1 && num(proxy[0].value) !== null ? many(proxy[0].value, 'possible error') : 'possible errors'} of the RPM signal (${logsText(proxy, c)}). Monitor the RPM signal in the next flights.` }));
    },
    G2: diag('G2', 'governor', 'The governor does not keep the headspeed stable', `Check G2 has a problem if the median headspeed error is more than ${GR.G2.median * 100} % by 2 SE. It also has a problem if the range from 5 % to 95 % of the error is more than ±${GR.G2.band * 100} %.`,
        'Checks G6 (throttle headroom) and G9 (oscillation) can show the cause.', { noun: 'headspeed error', sources: [src(GR.G2.source)] }),
    G3(L, c) {
        const rule = `Check G3 has a problem if the headspeed decreases by more than ${GR.G3.flag * 100} % by ${GR.sig} SE when the collective increases. If the F-term gives less than 50 % of the added throttle, F is too low (GOVT).`, sources = [src(GR.G3.source)];
        return L.filter(f => (isFlag(f) || f.severity === 'note') && !thin(f)).map(f => { const p = profileOf(f), low = /F too low/.test(String(f.text));
            const r = low ? change(c, { id: `G3:gov_f_gain:p${p}`, area: 'governor', profile: p, parameter: 'gov_f_gain', add: RULES.govSteps.F, direction: 'raise', title: 'Increase the governor F gain', evidence: [evidence(f)],
                rule: `${rule} The step is ${RULES.govSteps.F}.`, sources: sources.concat(RULES.source.govSteps), text: `When the collective increases, the headspeed decreases by ${pmPct(f.value, f.se, 2)}. The governor F-term gives less than 50 % of the added throttle.`,
                caveats: c.flags('G6').some(g => profileOf(g) === p) ? [`Check G6 shows a problem with the throttle headroom (${prof(p)}). When the throttle is at its maximum, more F cannot help.`] : [] })
                : rec({ id: `G3:p${p}`, area: 'governor', profile: p, title: 'The headspeed decreases when the collective increases', evidence: [evidence(f)], rule, sources,
                    text: `When the collective increases, the headspeed decreases by ${pmPct(f.value, f.se, 2)} (${whereOf(f, c)}). ${/headroom/.test(String(f.text)) ? 'The cause is the throttle headroom (check G6), not the F gain.' : 'The F-term gives most of the added throttle. Examine the time to the target again (check G5) and the throttle headroom (check G6).'}` });
            if (!isFlag(f)) r.sig = `Check G3 gives ${pmPct(f.value, f.se, 2)}. This is not more than ${GR.G3.flag * 100} % by ${GR.sig} SE.`;
            return r; });
    },
    G4(L, c) {
        const rule = `Check G4 has a problem if the headspeed overshoot is more than ${GR.G4.flag * 100} % by 2 SE. An overshoot when the collective increases shows that F is too high (GOVT).`, sources = [src(GR.G4.source)];
        return L.filter(isFlag).map(f => { const p = profileOf(f);
            if (/load onset/.test(String(f.text))) return change(c, { id: `G4:gov_f_gain:p${p}`, area: 'governor', profile: p, parameter: 'gov_f_gain', add: -RULES.govSteps.F, direction: 'lower', title: 'Decrease the governor F gain', evidence: [evidence(f)],
                rule: `${rule} The step is ${RULES.govSteps.F}.`, sources: sources.concat(RULES.source.govSteps), text: `When the collective increases, the headspeed overshoot is ${pmPct(f.value, f.se, 2)}. GOVT: "headspeed temporarily too high".` });
            return rec({ id: `G4:drop:p${p}`, area: 'governor', profile: p, title: 'Headspeed overshoot when the collective decreases', evidence: [evidence(f)], rule, sources,
                text: `When the collective decreases, the headspeed overshoot is ${pmPct(f.value, f.se, 2)} (${whereOf(f, c)}). The governor decreases the throttle too slowly when the load decreases.` }); });
    },
    G5: diag('G5', 'governor', 'The headspeed increases to the target slowly', `Check G5 has a problem if, after a collective increase, the headspeed gets to the target again after more than ${GR.G5.flag} s by 2 SE.`,
        `If check G6 shows no throttle saturation, FLYR "bog or droop under load" shows that the governor P gain is too low. GOVT increases it in steps of ${RULES.govSteps.P}.`, { noun: 'time to the target again', unit: 's', sources: [src(GR.G5.source), RULES.source.govSteps] }),
    G6(L, c) {
        // the two rules of health_gov G6, from its finding: the median throttle (value) and the periods at the throttle maximum
        // with the headspeed low (its text lists them: "N runs >= 100 ms at the ceiling ... at <t> s (<s> s, <deficit> %)")
        const bad = L.filter(isFlag), runsOf = (f) => { const m = /(\d+) runs >= [\d.]+ ms at the ceiling[^;.]*? below target(?: at ((?:[\d.]+ s \([\d.]+ s, [\d.]+ %\)(?:, )?)+))?/.exec(String(f.text || ''));
            return { n: m ? +m[1] : 0, items: m && m[2] ? [...m[2].matchAll(/([\d.]+) s \(([\d.]+) s, ([\d.]+) %\)/g)].map(x => ({ f, t: +x[1], s: +x[2], deficit: +x[3] })) : [] }; };
        const high = bad.filter(f => num(f.value) !== null && f.value > GR.G6.median), sat = bad.filter(f => runsOf(f).n > 0), runs = sat.reduce((n, f) => n + runsOf(f).n, 0);
        const longest = bad.flatMap(f => runsOf(f).items).sort((a, b) => b.s - a.s), ps = [...new Set(bad.map(profileOf))].sort((a, b) => (a > 0 ? a : 9) - (b > 0 ? b : 9));
        const med = bad.length === 1 ? `The median throttle is ${fmt(bad[0].value, 1)} % (${whereOf(bad[0], c)}).` : `${range('median throttle', bad, '%')} (${many(bad.length, 'result')}, ${and(ps.map(prof))})`.replace(/\.\s\(/, ' (') + '.';
        const run = sat.length ? `In ${many(sat.length, 'result')}, the throttle stayed at its maximum for ${GR.G6.runS * 1000} ms or more with the headspeed more than ${GR.G6.deficit * 100} % low (${many(runs, 'period')}).` : '';
        const top = longest.length ? `The longest period is ${fmt(longest[0].s, 3)} s at ${fmt(longest[0].t, 3)} s, with the headspeed ${fmt(longest[0].deficit, 1)} % low (${whereOf(longest[0].f, c)}).` : '';
        const why = high.length ? `The median throttle is more than ${GR.G6.median} %${high.length < bad.length ? ` in ${many(high.length, 'result')}` : ''}. Thus, the throttle headroom is too small.`
            : sat.length ? 'Thus, the throttle headroom was not sufficient at these times, and the governor did not keep the headspeed.' : '';
        return one(bad, { id: 'G6', area: 'governor', title: 'Throttle headroom', rule: `Check G6 has a problem if the median throttle is more than ${GR.G6.median} %. It also has a problem if the throttle stays at its maximum for ${GR.G6.runS * 1000} ms or more with the headspeed more than ${GR.G6.deficit * 100} % low.`,
            sources: [src(GR.G6.source), 'Rotorflight documentation, "FlyRotor governor setup": a throttle of 75 % to 85 %'],
            text: [med, run, top, why, 'A lower target headspeed or a battery with more cells gives more headroom.'].filter(Boolean).join(' '),
            caveats: [REFUTED.G6, 'FLYR recommends a throttle of 75 % to 85 %, with a reserve of 15 % to 25 %.', 'Check G6 gives no SE, because the median throttle and the number of periods at the maximum come from all samples, not from a mean.']
                .concat(longest.length > 1 ? [`The ${Math.min(3, longest.length)} longest periods are ${and(longest.slice(0, 3).map(x => `${fmt(x.s, 3)} s at ${fmt(x.t, 3)} s (${fmt(x.deficit, 1)} % low, ${whereOf(x.f, c)})`))}.`] : []) });
    },
    G8: diag('G8', 'governor', 'The throttle output does not agree with govSum', `Check G8 has a problem if \`motor[0] / govSum\` is not in the firmware range of the voltage compensation, ${GR.G8.bounds.join(' to ')}.`,
        'The voltage compensation does not fully cause this ratio. Possibly, a mixer rule that you set or gov_mode OFF causes it.'),
    G9(L, c) {
        const rule = `Check G9 examines the peak of the headspeed error. It has a problem if the prominence is ${GR.G9.prominence} or more by ${GR.sig} SE and the amplitude is ${GR.G9.minAmplitude * 100} % or more. `
            + `Also, the coherence with the collective must be less than ${GR.G9.maxCollectiveCoherence}.`, sources = [src(GR.G9.source)];
        // GOVT cuts I or P by 1/3 once it plays up (its steps of 25 and 10 are for raising), bounded to 20 % a step (guard 5)
        return L.filter(f => isFlag(f) || (f.severity === 'note' && /not by \d SE/.test(String(f.text)))).map(f => { const p = profileOf(f), P = /P-type/.test(String(f.text)), k = P ? 'P' : 'I';
            const r = change(c, { id: `G9:gov_${k.toLowerCase()}_gain:p${p}`, area: 'governor', profile: p, parameter: `gov_${k.toLowerCase()}_gain`, mult: 1 - RULES.govCut, asks: (w) => `GOVT decreases the gain by 1/3, to ${w}.`, direction: 'lower', title: `Decrease the governor ${k} gain`, evidence: [evidence(f)],
                rule: `${rule} GOVT decreases the gain by 1/3, and the app limits each step to ${RULES.maxStep * 100} %.`, sources: sources.concat(RULES.source.govCut, RULES.source.maxStep),
                text: (isFlag(f) ? `The headspeed has an oscillation in the band of ${P ? '3 Hz to 10 Hz (P type)' : '0.3 Hz to 3 Hz (I type)'}, with a prominence of ${pm(f.value, f.se)}.`
                    : `The headspeed error has a peak in the band of ${P ? '3 Hz to 10 Hz (P type)' : '0.3 Hz to 3 Hz (I type)'}, with a prominence of ${pm(f.value, f.se)}. This is not more than the limit by ${GR.sig} SE. Thus, it is not sure that the headspeed has an oscillation.`)
                    + (P ? ' FLYR: "head speed will oscillate or surge". GOVT decreases P by 1/3 after a small oscillation, and gov_gain is a different gain that can also change it.'
                        : ' GOVT increases I until an oscillation starts, and then decreases it by 1/3.') });
            if (!isFlag(f)) r.sig = `Check G9 gives a prominence of ${pm(f.value, f.se)}. This is not more than ${GR.G9.prominence} by ${GR.sig} SE.`;
            return r; });
    },
    G10: diag('G10', 'governor', 'Tail oscillation that follows the headspeed', `Check G10 measures the coherence of the headspeed and the yaw gyro at the frequency of the tail oscillation. It has a problem if the coherence is ${GR.G10.implicated} or more by 2 SE.`,
        `Possibly, the governor causes the tail oscillation. A decrease of gov_gain, ${RULES.maxStep * 100} % or less for each step, can stop it. You can also examine gov_rpm_filter. GOVT: a "governor so strong the tail cannot hold torque".`, { noun: 'coherence', sources: [src(GR.G10.source), 'Rotorflight 1 documentation, "Tail tuning"'] }),
    G11: diag('G11', 'governor', 'The throttle increases during each battery', `Check G11 has a problem if the stable throttle increases by more than ${GR.G11.perPack} % during a battery, by 2 SE.`,
        'The battery voltage decreases. gov_use_voltage_comp ON corrects this, with an ADC battery voltage source.', { sources: [src(GR.G11.source), RULES.source.firmware] }),
    G12(L, c) {
        const bad = L.filter(isFlag), o = bad.length ? num(bad[0].value) : null, poles = c.cli ? pick(c.cli.global.motor_poles, 0) : null;
        // the configured gear ratios are correct (CLAUDE.md): G12 names motor_poles and the RPM sensor only
        return one(bad, { id: 'G12', severity: 'action', title: 'Incorrect headspeed: examine motor_poles and the RPM sensor', rule: `Check G12 has a problem if the main rotor line is more than ${GR.G12.tolerance * 100} % from \`headspeed / 60\` by 2 SE.`, sources: [src(GR.G12.source)],
            text: `The main rotor line is at \`${fmt(o, 4)} × headspeed / 60\`. The headspeed, the RPM notch filters and the governor limits have the same error. The gear ratios in the configuration are correct. `
                + 'Examine motor_poles and the RPM sensor: its signal and the source that the Motors tab selects.'
                + (num(poles) > 0 && o ? ` If motor_poles causes the error, ${fmt(poles / o, 1)} gives the correct headspeed, not ${poles}.` : '') });
    },
    G13(L, c) {
        const bad = L.filter(isFlag), amb = L.filter(f => f.severity === 'note' && /cell count ambiguous/.test(String(f.text)) && !/Vbat in flight 0 -> 0/.test(String(f.text)));
        return one(bad, { id: 'G13', title: 'Low cell voltage when the load is high', rule: `Check G13 has a problem if, in flight, 1 % of the \`Vbat\` samples for each cell are less than ${GR.G13.minCell} V.`, sources: [src(GR.G13.source)],
            text: [`In flight, \`Vbat\` for each cell is less than ${GR.G13.minCell} V (${logsText(bad, c)}).`, range('lowest cell voltage', bad, 'V'), 'The app does not use the power results at these times.'].filter(Boolean).join(' ') })
            .concat(one(bad.length ? [] : amb, { id: 'G13:cells', severity: 'info', title: 'The cell count is not clear', rule: 'Check G13: the checks for each cell use the cell count.',
                text: 'The battery voltage before the flight agrees with more than one cell count. The log does not record the cell count. Thus, checks D5, G8 and G13 did not examine each cell.' }));
    },
    G14: diag('G14', 'governor', 'The governor is not ACTIVE in flight', `Check G14 has a problem if there is a BAILOUT in flight. It also has a problem if an AUTOROTATION in flight is longer than ${fmt(ruleNum(MR, 'G14', 'autoS'))} s with a collective of ${fmt(ruleNum(MR, 'G14', 'hover'), 0)} or more.`,
        'With the defaults of 4.6 (gov_autorotation_timeout 15, gov_auto_throttle 0), a throttle that falls to less than the handover value causes AUTOROTATION. With gov_autorotation_timeout 0, the governor possibly does no bailout (no flight test).', { sources: [ruleSrc(MR, 'G14'), RULES.source.firmware] }),
    C1: perAxis('C1', 'cyclic', 'I-term at its limit', `Check C1 has a problem if the I-term is at ${LR.C1.level * 100} % or more of its limit (\`Ki × error_limit\`) for more than ${LR.C1.minS} s.`,
        'Examine the output saturation first (check C2). Then examine the trim, the center of gravity and the mixer calibration. A larger error_limit is possibly correct only if the I-term is at its limit with no saturation (no flight test).', { sources: [src(LR.C1.note)] }),
    C2: diag('C2', 'mechanical', 'Cyclic output at its limit', `Check C2 has a problem if the output is at a mixer, swash ring, servo or collective limit for ${LR.C2.minEpisodes} period or more.`,
        'The mixer limits, the swash plate limits and the servo travel set the output range. Gains cannot increase it. Do not use the servo minimum and maximum to set the range (SERVO).', { noun: 'time at the limit', unit: 's', sources: [src(LR.C2.note)] }),
    C3(L, c) {
        return perProfile(L, c, 'C3', { area: 'cyclic', test: shareTest('C3', LR.C3), sources: [src(LR.C3.source), 'Rotorflight documentation, "Tuning your helicopter": "I remains near 0"'], rule: `Check C3 examines stable full-stick turns. It has a problem if the I-term is more than ${pct(LR.C3.iShare)} of the F-term. It also has a problem if the gyro rate is not ${LR.C3.gyroRatio.join(' to ')} of the setpoint.`,
            size: (fl, e, ax, p, list) => Math.abs(e.value) > LR.C3.iShare
                ? { parameter: `${ax}_f_gain`, mult: 1 + e.value, direction: e.value > 0 ? 'raise' : 'lower', confidence: 'measured', title: `${e.value > 0 ? 'Increase' : 'Decrease'} the ${ax} F gain`,
                    text: `In stable full-stick ${ax} turns, the I-term is ${pmPct(e.value, e.se, 0)} of the F-term (${flagLogs(list)}). A new F of \`F × (1 + part)\` supplies this part.` }
                : { title: `${cap(ax)} rate not equal to the setpoint`, text: `In stable full-stick ${ax} turns, the gyro rate is ${fl[0].gyroRatio ? pm(fl[0].gyroRatio.mean, fl[0].gyroRatio.se) : 'not equal to'}${fl[0].gyroRatio ? ' of' : ''} the setpoint, with the I-term near 0. Examine the output saturation (check C2) and rates that are more than the output range.` } });
    },
    C4(L, c) {
        const test = (list) => { const eo = pooled(list.map(f => [f.value, f.se])), es = pooled(list.map(f => f.settleS ? [f.settleS.mean, f.settleS.se] : [null])), a = clears(eo, LR.C4.overshootPct, 1), b = clears(es, LR.C4.settleS, 1);
            return a !== true && b !== true && (a === false || b === false) ? `Check C4 gives an overshoot of ${pm(eo && eo.value, eo && eo.se, 1)} %, and the rate becomes stable after ${pm(es && es.value, es && es.se)} s. These are not more than ${LR.C4.overshootPct} % and ${LR.C4.settleS} s by ${RULES.sigmas} SE.` : null; };
        return perProfile(L, c, 'C4', { area: 'cyclic', test, sources: [src(LR.C4.source)], rule: `Check C4 has a problem if the overshoot at the stops is more than ${LR.C4.overshootPct} %. It also has a problem if the rate becomes stable after more than ${LR.C4.settleS} s. If the I-term has the sign of the turn at the stop, FF is too low.`,
            size: (fl, e, ax) => /FF too low/.test(String(fl[0].text))
                ? { parameter: `${ax}_f_gain`, mult: 1 + RULES.dirStep, direction: 'raise', title: `Increase the ${ax} F gain`, text: `At the ${ax} stops, the overshoot is ${pm(e.value, e.se, 1)} %, and the I-term has the sign of the turn. FF is too low (FF). The step is ${RULES.dirStep * 100} %.` }
                : { title: `Overshoot at the ${ax} stops`, text: `At the ${ax} stops, the overshoot is ${pm(e.value, e.se, 1)} %. Possible causes: FF is too high (FF: "stops and bounces back"), the I-term relax is too weak (PROF), or B is too high (TUNE).` } });
    },
    C5: (L, c) => oscillation(L, 'C5', 'cyclic', c),
    T1: (L, c) => oscillation(L, 'T1', 'tail', c),
    C6: perAxis('C6', 'cyclic', 'slow oscillation', `Check C6 has a problem if the prominence of the error peak at 0.5 Hz to 3 Hz is ${LR.C6.prominence} or more (the band is from the documentation).`,
        (l) => `${/driven by I/.test(l[0].text) ? 'TUNE: "Lower the I-gain or raise the P-gain". You can also try the I-term relax.' : 'The I-term does not cause it. Examine the mechanical parts and the governor.'} The documentation does not agree on the frequency bands. Thus, the frequency does not show which term causes it.`, { noun: 'prominence', sources: [src(LR.C6.source)] }),
    C10(L, c) {  // the landed-while-moving part is a watch: its test is the one CYC-LANDED refuted
        const rule = `Check C10 has a problem if, in flight, the I-term decreases at the ground rate (in ${LR.C10.tau.join(' s to ')} s). It also has a problem if the firmware shows "landed" while the rotor turns at speed.`, sources = [src(LR.C10.note)];
        const bad = L.filter(isFlag), moving = bad.filter(f => /while the firmware says landed/.test(String(f.text)));
        return diag('C10', 'precondition', 'I-term decrease in flight', rule, 'The firmware thinks that the helicopter is on the ground, and it decreases the I-term. The firmware finds the airborne condition from rc_threshold. If this condition continues, a lower rc_threshold can possibly correct it (no flight test).', { sources })(bad.filter(f => !moving.includes(f)), c)
            .concat(one(moving, { id: 'C10:landed', severity: 'info', title: 'Slow liftoff after the spool-up', rule, sources, caveats: [REFUTED.C10],   // SPEC3 F: information only
                text: `For ${fmt(sum(moving), 1)} s, the rotor turned at flight speed while the firmware showed "landed" (${logsText(moving, c)}). This is not a problem. The helicopter only becomes airborne slowly after the spool-up.` }));
    },
    C11: (L, c) => perAxis('C11', 'filters', 'gyro noise in the D-term', `Check C11 has a problem if more than ${pct(LR.C11.share)} of the D-term power is at more than 30 Hz.`,
        'The filters come before the D gain. TUNE: "If you do not have filters enabled ... do not use Derivative". The Configurator help text gives: D "magnifies by 10x to 100x" the high-frequency vibration.', { noun: 'D-term power at more than 30 Hz', unit: 'fraction', sources: [src(LR.C11.source)] })(L, c)
        .map(r => sigAny(r, L.filter(f => axisOf(f) === r.axis), 'C11')),
    C12: (L, c) => tracking(L, 'C12', 'cyclic', c),
    T11: (L, c) => tracking(L, 'T11', 'tail', c),
    C13: (L, c) => lag(L, 'C13', 'cyclic', c),
    T12: (L, c) => lag(L, 'T12', 'tail', c),
    C14(L, c) {  // health_more gives the pitch_collective_ff_gain change that would supply the pitch I+O (gainChange +- gainChangeSe)
        return perProfile(L, c, 'C14', { area: 'cyclic', axis: 'pitch', rule: `Check C14 measures the cyclic pitch that the pitch I-term and O-term add for each 1 deg of collective (mixer units: 1000 is 12 deg). It has a problem if this value, without its sign, is more than ${fmt(SIGMA.C14[0] / 1000, 3)} deg by ${RULES.sigmas} SE. `
            + `The estimate uses all measured logs of the PID profile, and the gain change must be ${fmt(ruleNum(MR, 'C14', 'minGainChange'))} or more. The firmware pitch FF is \`collective × gain / 500\`.`, sources: [ruleSrc(MR, 'C14'), RULES.source.firmware],
            size: (fl, e, ax, p, list) => { const d = pooled(list.map(f => [f.gainChange, f.gainChangeSe]));
                if (!d) return { title: 'Pitch movement with the collective', text: `For each 1 deg of collective, the pitch I-term and O-term add ${pm(e.value / 1000, num(e.se) === null ? null : e.se / 1000, 3)} deg of cyclic pitch. The result gives no gain change. Thus, there is no value to set.` };
                return { parameter: 'pitch_collective_ff_gain', delta: d.value, direction: d.value > 0 ? 'raise' : 'lower', confidence: 'measured', title: `${d.value > 0 ? 'Increase' : 'Decrease'} the pitch collective FF`,
                    text: `For each 1 deg of collective, the pitch I-term and O-term add ${pm(e.value / 1000, num(e.se) === null ? null : e.se / 1000, 3)} deg of cyclic pitch (${flagLogs(list)}). A change of ${pm(d.value, d.se, 0)} in pitch_collective_ff_gain supplies this. PROF: "relatively low value to be conservative".` }; } });
    },
    R1: (L, c) => perAxis('R1', 'rates', 'time delay from the stick to the setpoint', `Check R1 has a problem if the time delay from rcCommand to the setpoint is more than ${fmt(SIGMA.R1[0], 0)} ms by ${RULES.sigmas} SE.`,
        'The response time (a PT1 filter at `500 / response` Hz), the acceleration limit and rc_smoothness change the setpoint. A lower value of the one that you set, in the rate profile, decreases the time delay.', { noun: 'time delay', unit: 'ms', sources: [ruleSrc(TR, 'R1'), RULES.source.firmware] })(L, c)
        .map(r => { // the rate values are values of each rate profile (SPEC2 D12): the rate profile of the findings, or the assumption in a caveat
            // the worker counts the rate profile changes in the logs of a result (rateChanges, SPEC2 A9): then the result can
            // mix rate profiles, and the rate profile of the change is unknown
            const own = r.evidence.map(e => SOURCE.get(e)).filter(Boolean), rp = [...new Set(own.map(f => num(f.rateProfile)))], changes = own.reduce((n, f) => n + (num(f.rateChanges) > 0 ? f.rateChanges : 0), 0);
            if (changes > 0) r.caveats.push(`The logs of these results have ${many(changes, 'rate profile change')}. Thus, the results can come from more than one rate profile, and the values of each rate profile are important.`);
            else if (rp.length === 1 && rp[0] > 0) { r.rateProfile = rp[0]; r.text += ` The logs used rate profile ${rp[0]}.`; }
            else r.caveats.push(rp.some(q => q > 0) ? 'The results come from more than one rate profile. Thus, the values of each rate profile are important.'
                : 'The log does not show the rate profile. Thus, the result is for the rate profile that was active in the logs.');
            return sigAny(r, L.filter(f => axisOf(f) === r.axis), 'R1'); }),
    T2: diag('T2', 'tail', 'Slow tail oscillation', `Check T2 has a problem if the prominence of the yaw error peak at 0.5 Hz to 3 Hz is ${LR.T2.prominence} or more.`,
        'A recommendation from other pilots is: "Slow wags are almost always mechanical". Make sure that the tail linkage moves freely. If the I-term causes it, TUNE: "lower I or raise P".', { noun: 'prominence', rec: { axis: 'yaw' }, sources: [src(LR.T2.source), RULES.source.community] }),
    T3: diag('T3', 'tail', 'Tail oscillation that changes with the headspeed', 'Check T3 compares the tail oscillation of 2 PID profiles with the same gains. It has a problem if the ratio of the amplitudes is 2 or more.',
        'On a belt tail, the loop gain increases with the headspeed. OLDWIKI, Rotorflight 1: "might need lower PIDs for higher headspeeds".', { rec: { axis: 'yaw' }, sources: ['toolkit rule', 'Rotorflight 1 documentation, "Tuning introduction"'] }),
    T4(L, c) {
        const sel = L.filter(f => f.severity === 'note' && /suspect mechanics/.test(String(f.text)));
        return one(sel, { id: 'T4', area: 'mechanical', axis: 'yaw', severity: 'watch', title: 'Tail oscillation that stays after gain changes', rule: `Check T4 has a problem if a gain change of more than ${LR.T4.gainChange * 100} % changes the frequency of the tail oscillation by less than ${LR.T4.hzChange * 100} %.`, sources: [src(LR.T4.source), 'Rotorflight 2.2.0 tuning process'],
            text: `The frequency of the tail oscillation stays almost the same after a gain change (${logsText(sel, c)}). A mechanical cause "cannot be tuned out" (PROC45): play, a slider that does not move freely, the bearings or the tail center.`, caveats: [REFUTED.T4] });
    },
    T5(L, c) {
        return perProfile(L, c, 'T5', { area: 'tail', axis: 'yaw', key: (f) => `${profileOf(f)}|${f.larger}`, sources: [src(LR.T5.source)], rule: `Check T5 has a problem if the ratio of the stop overshoots of the 2 sides is ${LR.T5.ratio} or more. The step is ${RULES.dirStep * 100} % on the side with the larger overshoot.`,
            size: (fl, e, ax, p, list) => ({ parameter: `yaw_${fl[0].larger}_stop_gain`, mult: 1 - RULES.dirStep, direction: 'lower', title: `Decrease the yaw ${String(fl[0].larger).toUpperCase()} stop gain`,
                text: `The ratio of the yaw stop overshoots, ${String(fl[0].larger).toUpperCase()} side to the other side, is ${pm(e.value, e.se)} (${flagLogs(list)}). The ${String(fl[0].larger).toUpperCase()} stop gain is too large for the other side. The ratio of the two stop gains is more important than their values (a recommendation from other pilots). Thus, a larger gain on the other side is also possible.`,
                caveats: ['The documentation does not tell which stop uses yaw_cw_stop_gain. Check T5 calculates P for each side to find it.'] }) });
    },
    T6(L, c) {
        return perProfile(L, c, 'T6', { area: 'tail', axis: 'yaw', sources: [src(LR.T6.source)], rule: `Check T6 has a problem if the yaw kick after a collective step is ${LR.T6.kick} deg/s or more. The direction is the sign of the kick to the torque change, by 2 SE.`,
            size: (fl, e, ax, p, list) => { const t = pooled(list.map(f => f.towardTorque ? [f.towardTorque.mean, f.towardTorque.se] : [null]));
                // no direction: T6 measures the kick's size and sign, not its timing, so it says nothing about yaw_precomp_cutoff
                if (!t || t.se === null || Math.abs(t.value) <= RULES.sigmas * t.se) return { title: 'Yaw kick after collective steps', caveats: [REFUTED.T6],
                    text: `After collective steps, the yaw kick is ${pm(e.value, e.se, 1)} deg/s (${flagLogs(list)}). Its part in the direction of the torque change ${t && t.se !== null ? `is ${pm(t.value, t.se, 1)} deg/s, which is not more than 0 by ${RULES.sigmas} SE` : 'is not measured'}. Thus, the direction of the precompensation is unknown. `
                        + 'Check T6 measures the amplitude and the sign of the kick, not its time, and check T7 measures the precompensation. Do collective steps with the yaw stick at its center, not through zero collective.' };
                const up = t.value > 0;
                return { parameter: 'yaw_collective_ff_gain', mult: 1 + (up ? 1 : -1) * RULES.dirStep, direction: up ? 'raise' : 'lower', severity: 'check', caveats: [REFUTED.T6], title: `${up ? 'Increase' : 'Decrease'} the yaw collective precompensation`,
                    text: `After collective steps, the yaw kick is ${pm(e.value, e.se, 1)} deg/s, and its part in the direction of the torque change is ${pm(t.value, t.se, 1)} deg/s (${flagLogs(list)}). The precompensation is too ${up ? 'small' : 'large'}. The step is ${RULES.dirStep * 100} % (PROF: "higher gain results in CW response" on a CW rotor).` }; } });
    },
    T7(L, c) {
        return perProfile(L, c, 'T7', { area: 'tail', axis: 'yaw', sources: [src(LR.T7.source), RULES.source.firmware], rule: `Check T7 measures the correlation of the yaw I-term and the precompensation in collective movements. It has a problem if the correlation, without its sign, is ${LR.T7.r} or more. `
            + 'The new collective FF is `FF × sqrt(scale)`, because the precompensation is `LPF((|collective| × gain)^2)` in the firmware.',
            size: (fl, e, ax, p, list) => { const s = list.map(f => num(f.precompScale)).filter(v => v !== null).sort((a, b) => a - b), scale = s.length ? s[s.length >> 1] : null;
                if (scale === null || scale <= 0) return { title: 'Yaw precompensation with the incorrect sign', text: `In collective movements, the yaw I-term moves opposite to the precompensation (${flagLogs(list)}). Examine main_rotor_dir and the direction of the precompensation before you change a gain.` };
                return { parameter: 'yaw_collective_ff_gain', mult: Math.sqrt(scale), direction: scale > 1 ? 'raise' : 'lower', confidence: 'measured', title: `${scale > 1 ? 'Increase' : 'Decrease'} the yaw collective precompensation`,
                    text: `In collective movements, the yaw I-term follows the precompensation. The tail must have ${fmt(scale, 2)} multiplied by the precompensation at this time (median of ${many(s.length, 'measured log')}, ${flagLogs(list)}). Thus, the correct collective FF is ${fmt(Math.sqrt(scale), 3)} multiplied by the value at this time.`,
                    caveats: ['This value is correct only if the cyclic part of the precompensation is small in these movements.'] }; } });
    },
    T8(L, c) {
        const bad = L.filter(isFlag), mot = !!(gearOf(c.cli) || {}).motorisedTail;
        return one(bad, { id: 'T8', area: 'tail', axis: 'yaw', title: 'The tail does not have sufficient authority', rule: `Check T8 has a problem if mixer[2] or servo[3] is at a limit for ${LR.T8.minEpisodes} period or more. The toolkit finds the limit in the data.`, sources: [src(LR.T8.source), RULES.source.tta],
            text: `The tail was at its output limit for ${fmt(sum(bad), 2)} s in ${many(bad.length, 'result')} (${[...group(bad, profileOf)].map(([p, l]) => `${prof(p)}: ${fmt(sum(l), 2)} s`).join(', ')}). At its limit, the tail does not have sufficient authority. Gain changes cannot correct this.`
                + `\nA larger tail pitch range (if the mechanical parts let it), larger tail blades${mot ? ', a higher tail motor speed' : ''} or a higher headspeed (gov_headspeed) give the tail more authority.`
                + ` On a tail with a motor, the tail torque assist (gov_tta_gain, steps of ${RULES.ttaStep}) helps the tail. A lower governor gain decreases the torque changes (GOVT).` });
    },
    T9(L, c) {
        return perProfile(L, c, 'T9', { area: 'tail', axis: 'yaw', test: shareTest('T9', LR.T9), sources: [src(LR.T9.source)], rule: `Check T9 has a problem if the I-term is more than ${pct(LR.T9.iShare)} of the control change in stable pirouettes. The step is ${RULES.dirStep * 100} %, because the part is of the control change, not of F.`,
            size: (fl, e, ax, p, list) => Math.abs(e.value) > LR.T9.iShare
                ? { parameter: 'yaw_f_gain', mult: 1 + Math.sign(e.value) * RULES.dirStep, direction: e.value > 0 ? 'raise' : 'lower', severity: 'check', caveats: [REFUTED.T9], title: `${e.value > 0 ? 'Increase' : 'Decrease'} the yaw F gain`,
                    text: `In stable pirouettes, the I-term is ${pmPct(e.value, e.se, 0)} of the control change (${flagLogs(list)}). ${e.value > 0 ? 'The stops are slow, and the yaw FF is possibly too small.' : 'The I-term operates against FF, and the yaw FF is possibly too large.'} FF: start at 0 on the tail.` }
                : { title: 'Yaw rate not equal to the setpoint in pirouettes', text: `In stable pirouettes, the yaw rate is ${fl[0].gyroRatio ? `${pm(fl[0].gyroRatio.mean, fl[0].gyroRatio.se)} of` : 'not equal to'} the setpoint, with the I-term near 0. Examine the tail output saturation (check T8).` } });
    },
    T10: diag('T10', 'tail', 'Small yaw phase margin', 'Check T10 has a problem if the yaw phase margin is less than 35 deg after a change.', 'Do not increase the yaw P gain or the stop gains.', { rec: { axis: 'yaw' }, sources: ['toolkit rule'] }),
    T13: diag('T13', 'tail', 'Constant yaw I-term in hover', `Check T13 has a problem if the hover axisI[2], without its sign, is more than ${pct(ruleNum(MR, 'T13', 'share'))} of the yaw output range by ${RULES.sigmas} SE.`,
        'The P, I and D gains cannot correct a constant offset. A tail_center_trim that keeps the yaw I-term near zero in hover corrects it (MIXS: the center trim "helps the feedforwards to work correctly"). If the I-term follows the collective (check T7), a larger yaw_collective_ff_gain can correct it.', { rec: { axis: 'yaw' }, sources: [ruleSrc(MR, 'T13')] }),
    T14: (L, c) => inertia(L, c),
    // the phase checks of health_phase.cjs (SPEC2 D13 and section 6): their fields, see the head of this file
    D7(L, c) {
        const bench = L.filter(f => f.bench === true || f.class === 'bench'), fl = L.filter(f => !bench.includes(f) && (f.bench === false || f.class === 'flight'));
        const n = fl.reduce((a, f) => a + (Array.isArray(f.flights) ? f.flights.length : num(f.n) || 0), 0), ph = {};
        for (const f of fl) for (const [k, v] of Object.entries(f.phaseSeconds || {})) if (num(v) !== null) ph[k] = (ph[k] || 0) + v;
        const NAME = { idle: 'idle', spoolup: 'spool-up', ground: 'ground', flight: 'flight', spooldown: 'spool-down' }, parts = Object.keys(NAME).filter(k => num(ph[k]) > 0).map(k => `${NAME[k]} ${fmt(ph[k], 1)} s`);
        const rule = 'Check D7 finds the flights of each log, from liftoff to touchdown. A log with one or more flights is a flight log, and a log with no flight is a bench run.', sources = [ruleSrc(PR, 'D7')];
        return one(bench, { id: 'D7:bench', area: 'logging', severity: 'info', title: 'Bench runs (not in the analysis)', rule, sources,
            text: `${cap(logsText(bench, c))} ${bench.length === 1 ? 'has' : 'have'} no flight. Thus, the analysis does not use ${bench.length === 1 ? 'this bench run' : 'these bench runs'}.` })
            .concat(one(fl, { id: 'D7', area: 'logging', severity: 'info', title: 'Flights and phases', rule, sources,
                text: `The analysis found ${many(n, 'flight')} in ${logsText(fl, c)}.${parts.length ? ` The phases are: ${and(parts)}.` : ''} `
                    + 'The attitude and filter checks use only the flight phase. The governor, motor and power checks use all phases.' }));
    },
    G15(L, c) {  // spool-up: the largest yaw rate on the ground during the ramp (value, deg/s), the throttle ramp and its time
        const bad = L.filter(isFlag), mild = L.filter(f => f.severity === 'note' && !thin(f)), top = (l) => l.slice().sort((a, b) => (num(b.value) || 0) - (num(a.value) || 0))[0];
        const say = (f) => !f ? '' : [num(f.value) !== null ? `The largest yaw rate on the ground during a spool-up is ${fmt(f.value, 0)} deg/s (${whereOf(f, c)}).` : '',
            f.throttlePctPerS && num(f.throttlePctPerS.mean) !== null ? `The throttle increases at ${pm(f.throttlePctPerS.mean, num(f.throttlePctPerS.se))} %/s.` : '',
            f.seconds && num(f.seconds.mean) !== null ? `The spool-up to ACTIVE is ${pm(f.seconds.mean, num(f.seconds.se), 1)} s long.` : ''].filter(Boolean).join(' ');
        const yf = ruleNum(PR, 'G15', 'yawFlag'), yn = ruleNum(PR, 'G15', 'yawNote');
        const sources = [ruleSrc(PR, 'G15')], rule = `Check G15 measures the largest yaw rate on the ground during a spool-up. It has a problem at ${fmt(yf, 0)} deg/s or more, and it gives a value to monitor at ${fmt(yn, 0)} deg/s or more.`;
        const w = top(bad), implied = w ? num(w.impliedSpoolupTime) : null;
        const out = bad.length ? [change(c, { id: 'G15:gov_spoolup_time', area: 'governor', parameter: 'gov_spoolup_time', mult: 1 + RULES.maxStep, direction: 'raise', severity: 'check', evidence: bad.map(evidence), rule, sources: sources.concat(RULES.source.spoolup),
            recovered: implied, recoveredFrom: 'the throttle ramp of the spool-ups in the log', title: 'The spool-up turns the helicopter on the ground',
            text: `${problems('G15', bad, c)} ${say(w)} The torque of the motor turns the helicopter on the ground, and the tail can get to its output limit before the headspeed is stable.`,
            caveats: ['gov_spoolup_time is the time of a throttle ramp from 0 % to 100 %, in units of 0.1 s. A larger value gives a slower ramp.',
                'A result on a different helicopter (refer to the source of the rule) gives this procedure. The app gives no CLI text for this check, because no flight test shows that it is correct.'] })] : [];
        return out.concat(one(bad.length ? [] : mild, { id: 'G15:watch', area: 'governor', severity: 'watch', title: 'Spool-up to monitor', rule, sources, text: `${say(top(mild))} Monitor the spool-ups of the next flights.`.trim() }));
    },
    G16(L, c) {  // the change from SPOOLUP to ACTIVE: value = the largest headspeed error (fraction, + over, - under the reference)
        const bad = L.filter(isFlag), f0 = bad.slice().sort((a, b) => Math.abs(num(b.value) || 0) - Math.abs(num(a.value) || 0))[0];
        const ref = f0 && f0.reference && f0.reference !== 'govTarget' ? 'the stable headspeed after the change' : 'the target';
        const say = !f0 ? '' : [num(f0.value) !== null ? `The largest headspeed error is ${pmPct(Math.abs(f0.value), num(f0.se), 2)} ${f0.value >= 0 ? 'more' : 'less'} than ${ref} (${whereOf(f0, c)}).` : '',
            [num(f0.throttleStepPct) !== null ? `At the change, the throttle changes by ${fmt(f0.throttleStepPct, 1)} %` : '', num(f0.settleS) !== null ? `the headspeed becomes stable after ${fmt(f0.settleS, 2)} s` : ''].filter(Boolean).join(', and ').replace(/^the/, 'The').replace(/(.)$/, '$1.')].filter(Boolean).join(' ');
        // the change to ACTIVE after the liftoff (SPEC2 D-M5c): health_phase gives afterLiftoff (afterLiftoffS, liftoffT); without
        // them, the flights of D7 of the same log (health_phase index time, as the events of G16) hold the time of the change.
        // Then the load of the rotor causes a part of the error, and the procedure is the one of C15, not a slower spool-up
        const flightsOf = (f) => c.F.filter(d => d.id === 'D7' && logsOf(d).some(l => logsOf(f).includes(l))).flatMap(d => Array.isArray(d.flights) ? d.flights : []);
        const changeAt = (f) => (Array.isArray(f.events) ? f.events : []).map(e => num(e && e.t)).filter(t => t !== null);
        const liftoffOf = (f) => { if (f.afterLiftoff === false) return null;
            const t = changeAt(f)[0], at = num(f.liftoffT) !== null ? { t: num(t) !== null ? t : num(f.liftoffT) + (num(f.afterLiftoffS) || 0), t0: f.liftoffT } : null;
            if (f.afterLiftoff === true) return at || { t: null, t0: null, dt: num(f.afterLiftoffS) };
            for (const x of changeAt(f)) { const fl = flightsOf(f).find(q => num(q.t0) !== null && num(q.t1) !== null && x > q.t0 && x <= q.t1); if (fl) return { t: x, t0: fl.t0 }; }
            return null; };
        const airborne = bad.map(f => ({ f, at: liftoffOf(f) })).filter(x => x.at);
        const when = (x) => x.at.t !== null && x.at.t0 !== null ? `${fmt(x.at.t - x.at.t0, 2)} s after the liftoff at ${fmt(x.at.t0, 2)} s (${whereOf(x.f, c)})`
            : `${num(x.at.dt) !== null ? `${fmt(x.at.dt, 2)} s ` : ''}after the liftoff (${whereOf(x.f, c)})`;
        const air = airborne.length ? `${airborne.length === 1 ? 'The change to ACTIVE came' : `In ${airborne.length} results, the change to ACTIVE came after the liftoff. The first came`} ${when(airborne[0])}, and the rotor load causes a part of the error. `
            + 'Keep the collective low until the governor is ACTIVE. Then do the liftoff in one movement.' : '';
        const slower = f0 && num(f0.value) > 0 && airborne.length < bad.length ? 'A slower spool-up can possibly give a smaller overshoot (no flight test), and a larger gov_spoolup_time gives a slower spool-up.' : '';
        const rule = `Check G16 examines the change from SPOOLUP to ACTIVE. It has a problem if the headspeed error is ${pct(ruleNum(PR, 'G16', 'flag'))} or more, or if the headspeed becomes stable after more than ${fmt(ruleNum(PR, 'G16', 'settleS'))} s.`;
        const n1 = bad.filter(f => !(num(f.se) > 0));
        // the procedure after the liftoff comes from a result on a different helicopter: a source of the rule, never a note
        // that reads as a result of the logs of the analysis (review V3)
        return one(bad, { id: 'G16', area: 'governor', title: 'Change from SPOOLUP to ACTIVE', rule, sources: [ruleSrc(PR, 'G16'), RULES.source.handover].concat(airborne.length ? [RULES.source.liftoff] : []),
            // the change after the liftoff is a second paragraph: with it, 1 paragraph has 7 or 8 sentences (STE: 6 or less)
            text: [`${problems('G16', bad, c)} ${say}`, `${air} ${slower}`].map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(air ? '\n' : ' '),
            caveats: ['With gov_use_pid_spoolup ON, the governor PID controls the headspeed during the spool-up.', 'The documentation gives no procedure for this change. The app gives no CLI text for this check.']
                .concat(n1.length ? [`Check G16 gives no SE for ${n1.length === bad.length ? 'these results' : many(n1.length, 'result')}, because each log has 1 change from SPOOLUP to ACTIVE.`] : []) });
    },
    G17(L, c) {  // motor kicks: value = the number of kicks of a log; byKind and events give their kind and phase
        const bad = L.filter(isFlag), kinds = (f) => f.byKind || {}, evs = (f) => Array.isArray(f.events) ? f.events : [];
        const drop = bad.filter(f => kinds(f)['headspeed decrease'] > 0 || evs(f).some(e => e.kind === 'headspeed decrease'));
        const kick = bad.filter(f => (kinds(f)['motor step'] || 0) + (kinds(f)['rotor turns with no motor output'] || 0) > 0 || evs(f).some(e => e.kind !== 'headspeed decrease') || (!f.byKind && !evs(f).length));
        const WHEN = { idle: 'at IDLE', spoolup: 'during the spool-up', ground: 'on the ground', flight: 'in flight', spooldown: 'during the spool-down' };
        const phasesOf = (l, k) => [...new Set(l.flatMap(f => evs(f).filter(k).map(e => e.phase).concat(evs(f).length ? [] : [f.phase])).map(p => WHEN[p]).filter(Boolean))];
        const rule = 'Check G17 finds a step of motor[0] or of the headspeed that the throttle does not command. It also finds a headspeed decrease at a throttle that does not decrease.', sources = [ruleSrc(PR, 'G17')];
        const kw = phasesOf(kick, e => e.kind !== 'headspeed decrease'), dw = phasesOf(drop, e => e.kind === 'headspeed decrease');
        return one(kick, { id: 'G17', area: 'governor', title: 'Motor kick', rule, sources,
            text: `${problems('G17', kick, c)} The motor output or the headspeed changes with no throttle change${kw.length ? ` ${and(kw)}` : ''}. `
                + 'Examine the ESC adjustments for the motor start, the motor connectors and the motor wires. Then do a ground spool-up and record a log.' })
            .concat(one(drop, { id: 'G17:drop', area: 'governor', title: 'Headspeed decrease at a constant throttle', rule, sources,
                text: `${problems('G17', drop, c)} The headspeed decreases while the throttle does not decrease${dw.length ? ` (${and(dw)})` : ''}. This can be a sync loss of the ESC. Examine the ESC adjustments, the motor connectors and the motor wires before the next flight. `
                    + 'If the RPM sensor gives the headspeed, examine its signal too (check G1).' }));
    },
    G18(L, c) {  // headspeed at IDLE: value = the rms headspeed change / the mean headspeed (fraction), by 2 SE
        const bad = L.filter(isFlag), f0 = bad[0];
        return one(bad, { id: 'G18', area: 'governor', title: 'Headspeed at IDLE is not stable', sources: [ruleSrc(PR, 'G18')], rule: `Check G18 measures the rms change of the headspeed at IDLE with a constant motor output. It has a problem if this change is more than ${pct(ruleNum(PR, 'G18', 'flag'))} of the headspeed by ${RULES.sigmas} SE.`,
            text: `${problems('G18', bad, c)}${f0 && num(f0.value) !== null ? ` At IDLE, the rms change of the headspeed is ${pmPct(f0.value, num(f0.se), 1)}${num(f0.headspeed) !== null ? ` of ${fmt(f0.headspeed, 0)} rpm` : ''}.` : ''} `
                + 'Examine gov_idle_throttle and the ESC adjustments. A motor that is not stable at IDLE can possibly give a motor kick at the start of the spool-up (check G17, no flight test).' });
    },
    // health_rescue.cjs (CLAUDE.md "Control limits", the rescue checks): checks, never CLI. A value change needs a measured size and a
    // confirmed from-value, and these checks give neither (one event for each rescue, no parameter that the logs size)
    G19(L, c) {  // the headspeed at a rescue: value = the largest decrease under the target (a negative fraction); overload, leave
        const bad = L.filter(isFlag), hi = num(RRULE.throttleHigh) !== null ? RRULE.throttleHigh / 10 : 95;
        return [...group(bad, profileOf)].map(([p, list]) => {
            const worst = list.slice().sort((a, b) => a.value - b.value)[0], ov = list.filter(f => f.overload), lv = list.filter(f => f.leave);
            const text = [`At the rescue, the headspeed decreases to ${pct(Math.abs(worst.value), 1)} less than the target (${whereOf(worst, c)}). ${list.length > 1 ? `${many(list.length, 'result')} have this problem.` : ''}`.trim(),
                ov.length ? `In ${many(ov.length, 'result')}, the headspeed decreases while the throttle is at ${hi} % or more. At the throttle limit, the governor cannot hold the headspeed, and gain changes cannot correct this.`
                    : `The throttle is not at ${hi} % or more before the largest decrease. A larger gov_collective_ff_weight adds the throttle earlier when the collective increases.`,
                ov.length && list.some(f => num(f.throttleMax) !== null && f.throttleMax >= 995) ? 'The throttle gets to 100 %. Thus, a larger gov_max_throttle cannot give more throttle.'
                    : ov.length ? `The throttle gets to only ${fmt(Math.max(...list.map(f => num(f.throttleMax) || 0)) / 10, 1)} %. Examine gov_max_throttle: a larger value gives more throttle.` : '',
                lv.length ? `\nIn ${many(lv.length, 'result')}, the governor changes from ACTIVE to ${and([...new Set(lv.map(f => f.leave))])}. In FALLBACK, the firmware decreases the throttle by gov_fallback_drop. In RECOVERY, the throttle increases at the rate of gov_recovery_time.` : '',
                '\nDecrease the load at the rescue. For example, decrease rescue_pull_up_collective, or start the rescue with less collective.',
                'A smaller rescue_pull_up_collective with a longer rescue_pull_up_time gives a smaller load for a longer time (no flight test).',
                'If the throttle is also at its limit out of the rescue (check L1), decrease gov_headspeed to get a throttle reserve.'];
            return rec({ id: `G19:p${p}`, area: 'governor', profile: p, title: 'Headspeed decrease at a rescue', evidence: list.map(evidence), sources: [ruleSrc(RR, 'G19'), RULES.source.fallback],
                rule: `Check G19 has a problem if the headspeed at a rescue decreases to more than ${pct(ruleNum(RR, 'G19', 'flag'))} less than the target. A governor change from ACTIVE to FALLBACK, RECOVERY or BAILOUT is also a problem.`,
                text: text.filter(Boolean).join(' ').replace(/ \n/g, '\n') }); });
    },
    T15(L, c) {  // the tail at a rescue: value = the increase of the largest yaw error over the error before the rescue (deg/s)
        const bad = L.filter(isFlag), mot = !!(gearOf(c.cli) || {}).motorisedTail;
        return [...group(bad, profileOf)].map(([p, list]) => {
            const worst = list.slice().sort((a, b) => b.value - a.value)[0], lim = list.filter(f => num(f.atLimitS) > 0);
            // the same rescue: a G19 or D8 flag of the same log whose event starts at the same time as a T15 event with a problem
            const at = new Set(list.flatMap(f => (f.events || []).filter(e => e.bad).map(e => `${logsOf(f)[0]}|${fmt(e.tS, 2)}`)));
            const same = (id, bad) => c.flags(id).some(g => (g.events || []).some(e => bad(e) && at.has(`${logsOf(g)[0]}|${fmt(e.tS, 2)}`)));
            const g19 = same('G19', (e) => e.bad), d8 = same('D8', (e) => num(e.value) > 0);
            const text = [`At the rescue, the largest yaw error is ${fmt(worst.value, 0)} deg/s more than the largest yaw error before the rescue (${whereOf(worst, c)}).`,
                lim.length ? `The tail output is at its limit for ${fmt(Math.max(...lim.map(f => f.atLimitS)), 3)} s in the first ${num(RRULE.tail && RRULE.tail.afterS) || 1.5} s. At its limit, the tail does not have sufficient authority.` : '',
                g19 ? '\nAt this rescue, the headspeed also decreases (check G19). A torque change of the main rotor pushes the tail.' : '',
                d8 ? 'At this rescue, the PID profile also changes (check D8). This changes the tail gains and the precompensation.' : '',
                '\nExamine yaw_collective_ff_gain, because the pull-up of the rescue is a large collective step.',
                lim.length ? 'A larger tail pitch range or a higher headspeed gives the tail more authority.' : '',
                mot ? 'On a tail with a motor, examine the tail torque assist (gov_tta_gain).' : ''];
            return rec({ id: `T15:p${p}`, area: 'tail', axis: 'yaw', profile: p, title: 'Tail kick at a rescue', evidence: list.map(evidence), sources: [ruleSrc(RR, 'T15')],
                rule: `Check T15 has a problem if the yaw error at a rescue increases by more than ${fmt(ruleNum(RR, 'T15', 'kick'), 0)} deg/s from the largest error before the rescue. A tail output at its limit is also a problem.`,
                text: text.filter(Boolean).join(' ').replace(/ \n/g, '\n') }); });
    },
    D8(L, c) {  // a PID profile change at a rescue: a setup of the radio and the Configurator, no parameter of the log
        // one sentence for each change (at most 4), then the procedure as a second paragraph: a list of 2 or more changes in one
        // sentence has more than 25 words (STE Rule 6.3; the Fireball dump of 2026-10-05 has 2), and 7 sentences are 1 paragraph too many
        const bad = L.filter(isFlag), items = bad.slice(0, 4).map(f => { const w = whereOf(f, c).replace(/, PID profile \d+$/, '');
            return `${w ? `In ${w}, ` : ''}${prof(f.fromProfile)} changes to ${prof(f.toProfile)}.`; });
        return one(bad, { id: 'D8', area: 'precondition', title: 'PID profile change at a rescue', sources: [ruleSrc(RR, 'D8')],
            rule: 'Check D8 has a problem if the PID profile changes from 1 s before to 0.1 s after a rescue starts.',
            text: [`At ${many(bad.length, 'rescue')}, the PID profile changes when the rescue starts.`].concat(items).join(' ') + '\n' +
                ['The rescue then flies with the gains, the governor headspeed and the precompensation of a different PID profile.',
                'Put the rescue on a switch that does not change the PID profile.',
                'Make sure that the transmitter and the Adjustments tab do not change the PID profile with the rescue switch.'].join(' ') });
    },
    L1: (L, c) => limits(L, c, 'L1'), L2: (L, c) => limits(L, c, 'L2'), L3: (L, c) => limits(L, c, 'L3'), L4: (L, c) => limits(L, c, 'L4'), L5: (L, c) => limits(L, c, 'L5'), L6: (L, c) => limits(L, c, 'L6'), L7: (L, c) => limits(L, c, 'L7'),
    C15(L, c) {  // ground resonance before liftoff: a procedure for the pilot, never a gain change (analysis/gaui-x4/FINDINGS.md 1.1: a source, RULES.source.liftoff)
        // the largest of the results first; with more than one, the range of the others (SPEC2 D-LOW: one result is not all)
        const bad = L.filter(isFlag).slice().sort((a, b) => (num(b.value) || 0) - (num(a.value) || 0)), f0 = bad[0];
        const say = !f0 ? '' : `${bad.length > 1 ? `The largest is in ${whereOf(f0, c)}: the` : 'The'} ${f0.axis || 'roll or pitch'} rate has an oscillation on the skids${num(f0.hz) !== null ? ` at ${pm(f0.hz, num(f0.hzSe), 2)} Hz` : ''}${num(f0.value) !== null ? ` of ${fmt(f0.value, 1)} deg/s rms` : ''}.`
            + (num(f0.growth) !== null ? ` Its rms increases at ${pm(f0.growth, num(f0.growthSe), 2)} /s (the slope of \`ln(rms)\`).` : '');
        const all = bad.length > 1 ? [`${range('rms rate', bad, 'deg/s').replace(/^The rms rate is/, `In the ${bad.length} results, the rms rate is`)}`
            + (bad.some(f => num(f.hz) !== null) ? ` The frequency is ${and([...new Set(bad.map(f => num(f.hz)).filter(v => v !== null).map(v => `${fmt(v, 2)} Hz`))])}.` : '')] : [];
        return one(bad, { id: 'C15', area: 'cyclic', axis: f0 && f0.axis || null, title: 'Oscillation on the skids before liftoff', rule: `Check C15 examines the roll and pitch rates on the skids before liftoff. It has a problem if an oscillation gets to ${fmt(ruleNum(PR, 'C15', 'peak'), 0)} deg/s rms and increases by ${RULES.sigmas} SE.`, sources: [ruleSrc(PR, 'C15'), RULES.source.liftoff],
            text: `${problems('C15', bad, c)} ${say} Keep the collective low until the governor is ACTIVE. Then do the liftoff in one movement. If the oscillation continues, examine the blade grips and the dampers (ground resonance).`.replace(/\s+/g, ' '),
            caveats: all.concat(['This is a procedure for the pilot, not a gain change.', 'The logs cannot show if the cause is mechanical or the roll loop on the skids. Thus, the app gives no gain change for this check.']) });
    },
};
GEN.SETUP.always = true; // run once even without findings of the id

// health_limits.cjs (CLAUDE.md "Control limits"): one item to examine for each output and PID profile, with its periods (each
// evidence row links to its periods). A check when a period is a problem, else a watch. Never CLI: no limit check sizes a value
const LIMIT_TITLE = { throttle: 'Throttle at its limit', collective: 'Collective output at its limit', collectiveCommand: 'Collective stick at its end', roll: 'Roll output at its limit', pitch: 'Pitch output at its limit',
    ring: 'Swash ring at its limit', tail: 'Tail output at its limit' };
const LIMIT_DO = {
    L1: ['Decrease the load at these times. For example, decrease the collective or rescue_pull_up_collective.', 'If the throttle is frequently at its limit, decrease gov_headspeed to get a throttle reserve.', 'Gain changes cannot correct this.'],
    L2: ['Decrease the collective command that moves the output to its limit.', 'Examine the collective range of the mixer (the mixer input SC).'],
    L3: ['Decrease the cyclic command that moves the output to its limit.', 'Examine the cyclic limits of the mixer and the swash ring.', 'Gains cannot correct an output at its limit.'],
    L4: ['At its limit, the tail does not have sufficient authority.', 'A larger tail pitch range (if the mechanical parts let it), larger tail blades or a higher headspeed (gov_headspeed) give the tail more authority.',
        'On a tail with a motor, the tail torque assist (gov_tta_gain) helps the tail.', 'Gains cannot correct an output at its limit.'],
    L5: ['Examine the servo limits and the linkage.', 'If it is safe, increase the servo travel.', 'Decrease the command that moves the servo to its limit.'],
    L6: ['Examine the trim of this axis, the center of gravity and the mixer calibration (check C1).', 'Gains cannot correct a trim.'],
    L7: ['A large collective is a large load. Examine the headspeed at these times (checks G19 and L1).', 'If the collective rate is more than necessary, decrease it.'],
};
function limits(L, c, id) {
    const sel = L.filter(f => f.severity === 'flag' || (f.severity === 'note' && !thin(f)));
    return [...group(sel, f => `${f.channel}|${profileOf(f)}`)].map(([k, list]) => {
        const f0 = list[0], p = profileOf(f0), ch = f0.channel, flag = list.some(isFlag), periods = list.flatMap(f => (f.events || []).map(e => Object.assign({ log: logsOf(f)[0] }, e))).sort((a, b) => b.seconds - a.seconds);
        const total = list.reduce((s0, f) => s0 + (num(f.value) || 0), 0), n = list.reduce((s0, f) => s0 + (num(f.n) || 0), 0), with2 = [...new Set(list.flatMap(f => f.with || []))];
        const title = LIMIT_TITLE[ch] || (/^servo/.test(ch) ? `Servo \`${ch}\` at its limit` : /^iterm/.test(ch) ? `${cap(f0.axis || 'axis')} I-term at its limit` : 'Output at its limit');
        const PW = { idle: 'at IDLE', spoolup: 'during the spool-up', ground: 'on the ground', flight: 'in flight', spooldown: 'during the spool-down' };
        const lines = periods.slice(0, 3).map(e => `In log ${lab(e.log, c)}, the period from ${fmt(e.tS, 2)} s to ${fmt(e.t1S, 2)} s is ${fmt(e.seconds, 3)} s long${[PW[e.phase], e.rescue ? (e.rescue === 'rescue' ? 'in a rescue' : 'before a rescue') : null].filter(Boolean).map(x => `, ${x}`).join('')}.`);
        const subject = title.replace(/ at its (limit|maximum|end)$/, '');
        const text = [`${subject.charAt(0) === '`' ? subject : `The ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`} is at its limit in ${many(n, 'period')}, for a total of ${fmt(total, 3)} s (${logsText(list, c)}, ${prof(p)}).`, ...lines,
            `\n${with2.length ? `Other outputs are at their limits at the same time: ${and(with2.map(q => LIMIT_TITLE[q] ? LIMIT_TITLE[q].replace(/ at its (limit|maximum|end)$/, '').toLowerCase() : `\`${q}\``))}. ` : ''}`
                + (flag ? 'This is a problem. An output at its limit is the possible first cause of the errors that come after it.' : 'Examine these periods. They are short, and they come with no large error.'), `\n${(LIMIT_DO[id] || []).join(' ')}`];
        return rec({ id: `${id}:${ch}:p${p}`, area: id === 'L1' ? 'governor' : id === 'L7' ? 'precondition' : id === 'L4' || f0.axis === 'yaw' ? 'tail' : 'cyclic', axis: f0.axis || null, profile: p, severity: flag && id !== 'L7' ? 'check' : 'watch',   // L7: a command of the pilot, never a problem of the flight controller
            title, evidence: list.map(evidence), sources: [ruleSrc(LR2, id)],
            rule: `Check ${id} finds each period with the output at 0.5 % of its limit or nearer, in all flight phases and in the rescue. A period of ${fmt(num(LR2.longS) || 0.1)} s or more is a problem. `
                + 'An error more than the limit of the related check is also a problem. Two outputs at their limits at the same time are also a problem.',
            text: text.filter(Boolean).join(' ').replace(/ \n/g, '\n').trim() }); });
}

function oscillation(L, id, area, c) {
    const ax0 = area === 'tail' ? 'yaw' : null, bad = L.filter(isFlag), mild = L.filter(f => f.severity === 'note' && !thin(f));
    const grows = `It has a problem if the oscillation increases from less than ${fmt(ONSET.small, 0)} deg/s to ${fmt(ONSET.high, 0)} deg/s or more in ${fmt(ONSET.minHalfCycles, 0)} half-cycles or more`;
    return [...group(bad, f => axisOf(f) || ax0)].map(([ax, list]) => { const n = sum(list), few = n < RULES.minBursts;
        return rec({ id: `${id}:${ax}`, area, axis: ax, severity: few ? 'watch' : 'check', title: `${cap(ax)} oscillation that increases with no stick input${few ? ': 1 period' : ''}`, evidence: list.map(evidence),
            rule: `Check ${id} examines the oscillation with no stick input, in the band of its axis. ${grows}.${num(OSC.stickDriven) !== null ? ` A period has no stick input if the setpoint oscillation is ${pct(OSC.stickDriven)} or less of the gyro oscillation.` : ''} Less than ${RULES.minBursts} of these periods give a recommendation to monitor.`,
            sources: [ruleSrc(TR, id), RULES.source.minBursts],
            text: `There ${n === 1 ? 'is 1 period' : `are ${n} periods`} of ${ax} oscillation that ${n === 1 ? 'increases' : 'increase'} with no stick input (${many(list.length, 'log-profile pair')}, ${logsText(list, c)}). ` + (few ? '1 period cannot show the difference between the loop gain, the load, a time delay and a low battery. Do one more flight and look for a second period before you change a gain.'
                : `Possible causes: ${area === 'tail' ? 'the yaw P gain, a stop gain or the D gain is too high, or gyro noise in the D-term (PROF and a recommendation from other pilots)' : 'the P or D gain is too high, or gyro noise in the D-term'}. TUNE gives a decrease of the gain that you increased last. The frequency does not show which term causes it.`) }); })
        .concat([...group(mild, f => axisOf(f) || ax0)].map(([ax, list]) => { const e = pooled(list.map(f => [f.value, f.se]));
            return rec({ id: `${id}:${ax}:watch`, area, axis: ax, severity: 'watch', title: `${cap(ax)} oscillation`, evidence: list.map(evidence),
                rule: `Check ${id} gives a value to monitor if, with no stick input, the oscillation is ${fmt(ruleNum(TR, id, 'level'), 0)} deg/s or more for more than ${pct(ruleNum(TR, id, 'share'))} of the time. `
                    + `The value must be more than this limit by ${RULES.sigmas} SE.`, sources: [ruleSrc(TR, id)],
                text: `With no stick input, the ${ax} oscillation is ${fmt(ruleNum(TR, id, 'level'), 0)} deg/s or more for ${e ? pmPct(e.value, e.se) : 'some'} of the time (${logsText(list, c)}). The stick or the load causes it, not the loop. Monitor it after you increase a gain.` }); }));
}
// C12 / T11 per axis, over every measured log-profile pair (ok ones too: pooling only the pairs above the note level
// would read above it by construction); a recommendation where a pair is above the note level. An elevated pair
// measured before a later header change of the axis gains on its start profile (H; ordered by log index, the flash
// order, which undated logs keep) describes another setup.
function tracking(L, id, area, c) {
    const note = ruleNum(TR, id, 'note'), flag = ruleNum(TR, id, 'flag');
    // one estimate for each axis and PID profile: the gains, and thus the tracking error, are values of one PID profile (SPEC2 D-LOW)
    return [...group(L.filter(measured), f => `${axisOf(f)}|${profileOf(f)}`)].filter(([, l]) => l.some(f => isFlag(f) || f.severity === 'note')).map(([key, list]) => {
        const ax = axisOf(list[0]), p = profileOf(list[0]);
        const fl = list.filter(isFlag), up = list.filter(f => isFlag(f) || f.severity === 'note'), e = pooled(list.map(f => [f.value, f.se])), vals = list.map(f => num(f.value)).filter(v => v !== null);
        const worst = (fl.length ? fl : up).slice().sort((a, b) => (num(b.value) || 0) - (num(a.value) || 0))[0];
        const r = rec({ id: `${id}:${ax}:p${p}`, area, axis: ax, profile: p, severity: fl.length ? 'check' : 'watch', title: `${cap(ax)} tracking error more than ${pct(note)} in ${up.length} of ${many(list.length, 'result')} (${prof(p)})`, evidence: list.map(evidence),
            rule: `Check ${id} measures the tracking error after the analysis removes the time delay, divided by the setpoint rms.${num(TTRACK.lpHz) !== null ? ` It uses the gyro and the setpoint at less than ${fmt(TTRACK.lpHz, 0)} Hz, and the samples with \`|setpoint| > ${fmt(TTRACK.minAbsSetpoint, 0)} deg/s\`.` : ''} `
                + `It has a problem if the value is more than ${pct(flag)} by ${RULES.sigmas} SE, and a value to monitor if it is more than ${pct(note)}. The estimate uses all measured results of the PID profile.`, sources: [ruleSrc(TR, id)],
            text: `${up.length} of ${many(list.length, 'measured result')} ${up.length === 1 ? 'is' : 'are'} more than ${pct(note)}.` + (list.length > 1 && e ? ` All ${list.length} together give ${pmPct(e.value, e.se)} (${pct(Math.min(...vals), 1)} to ${pct(Math.max(...vals), 1)}).` : '')
                + ` The largest is ${pmPct(worst.value, worst.se)} (${whereOf(worst, c)}). This is a result of the tuning, not a cause. The checks of the causes (stops, FF, oscillation) and the gain changes of the gain model (check C7) tell which change is necessary.` });
        const keys = [`${ax}PID`].concat(ax === 'yaw' ? ['yaw_stop_gain'] : []), old = up.map(f => ({ f, ch: laterChanges(c, keys, f) })).filter(x => x.ch.length);
        if (old.length) r.caveats.push(`${old.length} of the ${up.length} results more than ${pct(note)} are from logs before a change of ${and(keys)} on their PID profile (`
            + old.slice(0, 3).map(x => `log ${lab(logsOf(x.f)[0], c)}, ${prof(profileOf(x.f))}: ${x.ch.slice(-2).map(h => changeText(h, c)).join(', ')}`).join('. ')
            + '). Thus, they can be from different values.');
        return sigAny(r, list, id); });
}
// H findings of the keys in the start-profile scope of finding f that come after f's log (either log of the change)
const laterChanges = (c, keys, f) => { const l = logsOf(f)[0], p = profileOf(f); return typeof l !== 'number' ? [] : c.F.filter(h => h.id === 'H' && hProfile(h) !== null && hProfile(h) === p && keys.includes(String(h.text).split(':')[0])
    && Math.max(...logsOf(h).concat(matchNum(/since log (\d+)/, h.text) === null ? [] : [matchNum(/since log (\d+)/, h.text)])) > l); };
// an H finding ("key: old -> new (since log N, ...)", health_setup) in the reader's words
const changeText = (h, c, bare) => { const m = /^([\w\[\]]+): (.*?) -> (.*?)(?: \(since|$)/.exec(String(h.text)), key = String(h.text).split(':')[0];
    return `${bare ? '' : `${key} changed `}${m ? `from ${m[2]} to ${m[3]} ` : ''}in log ${lab(logsOf(h)[0], c)}`.trim(); };

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
    const on = split ? `The logs with the yaw values of the selected log (${now}: ${logsText(present, c)})` : present.length === 1 ? `The measured log (${logsText(present, c)})` : `The ${many(present.length, 'measured log')} together (${logsText(present, c)})`;
    // the PID profile of the change (SPEC2 D12): of the findings when they have one, else the confirmed arming profile of the
    // analysed log header (whose yaw values select the logs above), else PID profile unknown
    const fp = [...new Set(present.map(profileOf).filter(v => num(v) > 0))], p = fp.length === 1 ? fp[0] : c.headerProfile > 0 && c.headerConfirmed ? c.headerProfile : 0;
    const gain = G ? `A yaw_inertia_precomp_gain change of ${pm(G.value, G.se, 0)} supplies the tail feedback that moves with the rotor acceleration (range ${lo} to ${hi}).` : 'The analysis has no estimate of the gain change.';
    const peak = Y ? `The peak yaw rate is ${pm(Y.value, Y.se, 1)} deg/s in the direction of the reaction torque.` : 'The analysis has no estimate of the peak yaw rate.';
    const judged = `${!split && present.length === 1 ? 'has' : 'have'} ${many(n, 'headspeed ramp')}${share === null ? '' : `, and ${pct(share)} of them have the sign of the estimate`}.`;
    const other = byGain ? `${peak} This value is information only, because a precompensation with a time delay gives a kick of this type also at the correct gain.` : gain;
    const rule = `Check T14 examines the logs with ${R.minEvents} or more headspeed ramps, when ${pct(R.consistent)} or more of the ramps have the same sign. `
        + (byGain ? `It has a problem if the gain change, without its sign, is more than \`max(${R.minGainChange}, ${R.relGainChange} × header gain)\` (${fmt(thr, 0)}) by ${RULES.sigmas} SE` : `It has a problem if the peak yaw rate, without its sign, is more than ${fmt(thr)} deg/s by ${RULES.sigmas} SE`)
        + '. It uses the logs with the yaw values of the selected log. The step is ' + `${RULES.maxStep * 100} % or less of the value at this time.`;
    const base = { id: 'T14', area: 'tail', axis: 'yaw', parameter: 'yaw_inertia_precomp_gain', profile: p, title: 'Yaw at headspeed ramps', evidence: present.concat(old).map(evidence), rule, sources: [ruleSrc(MR, 'T14'), RULES.source.maxStep] };
    let r = rec(base);
    if (present.length && stands) { const up = e.value > 0;
        // the from-value only from a confirmed source (the CLI section of the PID profile, or the header of the confirmed
        // arming profile: current), and the step rule (change: 20 % or less of it, never from 0); a check, never CLI
        if (byGain) { r = change(c, Object.assign({}, base, { delta: G.value, direction: up ? 'raise' : 'lower', severity: 'check', asks: (w) => `The regression gives ${w}.` }));
            if (!r.sets && r.to === r.from) r.to = null; }
        else Object.assign(r, { direction: up ? 'raise' : 'lower' });
        const from = num(r.from), beyond = G && from !== null && num(G.se) !== null && from + G.value - RULES.sigmas * G.se > hi;
        r.text = `${on} ${judged} ${byGain ? gain : peak}${byGain ? '' : ` ${up ? 'An increase' : 'A decrease'} of yaw_inertia_precomp_gain can correct it.`}`
            + ' This gain changes the tail output when the rotor speed changes, and the documentation gives no tuning procedure.';
        if (beyond) r.caveats.push(`The necessary value, ${pm(from + G.value, G.se, 0)}, is more than the firmware maximum, ${hi}. Slower headspeed changes (gov_tracking_time) also decrease the yaw.`);
        r.caveats.push('A small step, and then PID profile changes in flight, give the next measurement.', other);
        if (byGain && from !== null && num(r.to) !== null && r.to !== from) { const want = Math.round(from + G.value), sim = 'In the tests of the toolkit with a model of the tail, the regression was -1 % to +14 % incorrect at gain 0. At the correct gain, it was 5 to 13 units too high. Thus, a step in its direction is better than the full change.';
            r.caveats.push(`The full estimate of the regression is ${pm(want, G.se, 0)}. ${sim}`); }
        if (!fp.length && p > 0) r.caveats.push(`Check T14 uses the headspeed ramps of all PID profiles of a log. Thus, the estimate is correct for ${prof(p)} only if all PID profiles have the same yaw_inertia_precomp_gain. The log header records this value only for the PID profile at the start of the log.`); }
    else if (present.length) Object.assign(r, { severity: 'watch', title: `Yaw at headspeed ramps: less than the T14 limit${split ? ' with the yaw values of the selected log' : ''}`,
        text: `${old.length ? 'Other yaw values show a problem (refer to the notes). ' : ''}${on} ${judged} ${byGain ? gain : peak} This is not more than the limit of check T14. Do more PID profile changes in flight, and then do the analysis again.` });
    else Object.assign(r, { severity: 'watch', title: 'Yaw at headspeed ramps: measure again with the yaw values of the selected log',
        text: `Only other yaw values show a problem (refer to the notes). No log with the yaw values of the selected log (${now}) has ${R.minEvents} or more headspeed ramps. Do PID profile changes in flight with these values, and then do the analysis again.` });
    if (present.length && !stands) r.caveats.push(other);
    if (split) r.caveats.push('The yaw values of a log are in its log header, for the PID profile at the start of the log. Check T14 uses the ramps of all PID profiles of a log, and most of them are PID profile changes.');
    if (old.length) r.caveats.push(`Other yaw values show a problem, but the analysis measured them with different gains. They are information, not a target: ${old.slice(0, 4).map(f => `log ${lab(logsOf(f)[0], c)} (${setOf(f) || 'values unknown'}), gain change ${pm(num(f.gainChange), num(f.gainChangeSe), 0)}${byGain ? '' : `, peak yaw rate ${pm(f.value, f.se, 1)} deg/s`}`).join('. ')}${old.length > 4 ? `. There are ${old.length - 4} more` : ''}.`);
    return [r];
}
const lag = (L, id, area, c) => perAxis(id, area, 'time delay is large', `Check ${id} has a problem if the time delay from the setpoint to the gyro is more than ${fmt(SIGMA[id][0], 0)} ms by ${RULES.sigmas} SE.`,
    'Possible causes: too many filters (check F11), a B gain that is too low (FF: "raise B, not FF"), or the time delay from the stick to the setpoint (check R1).', { noun: 'time delay', unit: 'ms', sources: [ruleSrc(TR, id)] })(L, c).map(r => sigAny(r, L.filter(f => axisOf(f) === r.axis), id));

// ---------------------------------------------------------------------------------------------
// report.cjs decisions (C7)
// ---------------------------------------------------------------------------------------------

// the log profile that flies a 250 rpm headspeed bin: the profiles whose governor target falls in it (logs[].targetOf);
// the label 0 (before the first PID profile change) is the arming profile of its log when the worker confirmed it
function profileOfBin(c, bin) {
    const cand = new Set(); for (const l of c.logs) for (const [p0, t] of Object.entries(l.targetOf || {})) { const p = +p0 > 0 ? +p0 : armingOfLog(l);
        if (p > 0 && num(t) !== null && lib.headspeedClass(t) === bin) cand.add(p); }
    return { p: cand.size === 1 ? [...cand][0] : 0, cand: [...cand].sort((a, b) => a - b) };
}

function decisionRecs(D, c) {
    const out = [], rule = 'Check C7 (condition 7 of the gain model): in the model, the tracking error or the disturbance error decreases by 10 % or more, and by 2 SE or more. '
        + 'The other error increases by 1 % or less, and the total decreases by 2 % or more. The gain set has 3 flights or more, the conditions V1 to V3 are satisfactory, and the model shows no limit. The steps are 0.8 to 1.2 of the gain.';
    for (const d of D) {
        const ax = d.axis, area = ax === 'yaw' ? 'tail' : 'cyclic', { p, cand } = profileOfBin(c, d.bin), g = d.gates || {}, two = (x, k = 2) => x ? `from ${fmt(x[0], k)} to ${fmt(x[1], k)}` : 'unknown';
        const gates = Object.entries(g).map(([k, v]) => `${k} ${fmt(v.value, 3)} (limit ${fmt(v.limit, 3)}, ${v.pass ? 'satisfactory' : 'problem'})`).join(', ');
        const counts = `${many(d.flights, 'flight')}, ${many(d.windows, 'window')} at ${d.bin} rpm`;
        const e = { fid: d.fid === undefined ? null : d.fid, module: 'report', id: 'C7', log: null, profile: p, axis: ax, bin: d.bin, value: num(d.dTrack), se: num(d.seTrack), n: d.flights === undefined ? null : d.flights, unit: 'deg/s', threshold: 'rule 7',
            source: 'toolkit, no flight test: only simulated flights examined the limits of the gain model', times: [],
            summary: d.change ? `In the gain model, the ${ax} tracking error goes ${two(d.tracking)} deg/s (${pm(d.dTrack, d.seTrack)} deg/s, ${counts}).` : `The gain model gives no ${ax} gain change at ${d.bin} rpm (${counts}).`,
            text: d.change ? `Tracking error ${two(d.tracking)} deg/s (${pm(d.dTrack, d.seTrack)}, ${fmt(d.dTrack / d.seTrack, 1)} SE). Disturbance error ${two(d.disturbance)}, total ${two(d.total)}, gain at 1 Hz to 3 Hz ${two(d.lowFreqGain, 3)}.${gates ? ` Conditions: ${gates}.` : ''} Band ${(d.validBand || []).join(' Hz to ')} Hz, ${counts}.`
                : `The gain model gives no change: "${d.reason}".${gates ? ` Conditions: ${gates}.` : ''} ${cap(counts)}.` };
        const where = p ? [] : [cand.length ? `${d.bin} rpm agrees with the governor target of PID profiles ${and(cand.map(String))}. Thus, the PID profile is not clear.` : `No PID profile has a governor target in the ${d.bin} rpm range. Thus, the PID profile is unknown.`];
        if (!d.change) { out.push(rec({ id: `C7:${ax}:${d.bin}`, area, severity: 'info', axis: ax, profile: p, title: `No ${ax} gain change at ${d.bin} rpm`, evidence: [e], rule, sources: [RULES.source.maxStep], confidence: 'predicted', text: `The gain model gives no change: "${d.reason}".` })); continue; }
        // the gains that the model changes together are one change (SPEC2 C3): group C7:<axis>:<bin>, and finish gives
        // CLI text to all of them or to none
        const joint = (d.changes || []).filter(s => PARAMS[`${ax}_${String(s.gain).toLowerCase()}_gain`]), group = joint.length > 1 ? `C7:${ax}:${d.bin}` : null;
        for (const s of d.changes || []) {
            const param = `${ax}_${String(s.gain).toLowerCase()}_gain`; if (!PARAMS[param]) continue;
            // yaw P is recovered as P x the mean stop gain (below): that product is not a from-value of yaw_p_gain
            const yawP = ax === 'yaw' && s.gain === 'P';
            const r = change(c, { id: `C7:${param}:p${p}`, area, axis: ax, profile: p, parameter: param, mult: s.multiplier, direction: s.multiplier > 1 ? 'raise' : 'lower', confidence: 'predicted', evidence: [e], rule, sources: [RULES.source.maxStep, RULES.source.gainTolerance], caveats: where,
                recovered: yawP ? undefined : s.from, title: `${s.multiplier > 1 ? 'Increase' : 'Decrease'} the ${ax} ${s.gain} gain to ${s.multiplier} of its value`,
                text: `In the gain model, this change makes the ${s.improves ? `${s.improves} ` : ''}error smaller. The tracking error goes ${two(d.tracking)} deg/s, and the disturbance error goes ${two(d.disturbance)}.` });
            r.profileNote = !p;
            if (group) Object.assign(r, { group, groupSize: joint.length });
            if (d.changes.length > 1) r.caveats.push(`The model changes ${d.changes.length} gains together (${and(d.changes.map(x => `${ax} ${x.gain} to ${x.multiplier} of its value`))}). Thus, the CLI text of the ${d.changes.length} changes goes together, or there is none.`);
            // report.cjs evaluates the multipliers x0.8-x1.2 only: at the end of that grid nothing further was evaluated
            if (s.atBound) { r.caveats.push(`${s.multiplier} is the largest step of the gain model (${1 - RULES.maxStep} to ${1 + RULES.maxStep}, ${RULES.maxStep * 100} % for each step), and the model did not calculate a larger step. Thus, a larger change is possibly not better.`
                + (Array.isArray(d.lowFreqGain) && num(d.lowFreqGain[0]) !== null && num(d.lowFreqGain[1]) !== null && (d.lowFreqGain[0] - 1) * (d.lowFreqGain[1] - 1) < 0 ? ` In the model, the gain at 1 Hz to 3 Hz goes through 1 in this step (${two(d.lowFreqGain, 3)}).` : ''));
                r.text += ' Do a flight with this value, and then do the analysis again.'; }
            // the model ran with the recovered gain; the CLI is written only when it agrees with the configured value of the
            // same PID profile (its CLI section, or the header of the confirmed arming profile: current). Yaw P is recovered
            // as P x the mean stop gain: an agreement shows yaw_p_gain only when the two stop gains of the profile are known
            const exact = !!r.base && !r.base.unknown && !r.base.approx && num(r.from) !== null;
            let want = exact ? r.from : null;
            if (yawP) { r.caveats.push('In the model, yaw P is `P × mean stop gain`. The CLI text changes yaw_p_gain only, and the stop gains stay the same.');
                if (exact) { const cw = current(c, 'yaw_cw_stop_gain', p), ccw = current(c, 'yaw_ccw_stop_gain', p), known = num(cw.value) !== null && num(ccw.value) !== null;
                    want = known ? r.from * (cw.value + ccw.value) / 200 : null;
                    if (!known) { r.base.unconfirmed = true; r.caveats.push(`The stop gains of ${prof(p)} are unknown. Thus, the model value, ${fmt(s.from, 1)}, cannot show yaw_p_gain, and there is no CLI text. ${armedText(p)}`); } } }
            if (num(want) !== null && num(s.from) !== null) {
                const ok = Math.abs(s.from - want) <= Math.max(1, RULES.gainTolerance * Math.abs(want));
                r.text += ` The model found ${s.gain} ${fmt(s.from, 1)}, and ${prof(p)} has ${fmt(want, 1)}${yawP ? ' (`P × mean stop gain`)' : ''}.`;
                if (!ok) { r.base.unconfirmed = true; r.caveats.push(`The model used ${s.gain} ${fmt(s.from, 1)}, but ${prof(p)} has ${fmt(want, 1)}. Thus, the result of the model is not applicable to the value at this time.`); }
            }
            out.push(r);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Merging, guards, gates, causes, order, CLI
// ---------------------------------------------------------------------------------------------

// recommendations that move the same parameter on the same profile become one: the best-confidence one that passed its
// 2-SE test leads, the others add their evidence and one line each; opposite directions turn it into a check
const CONF = { predicted: 0, measured: 1, advisory: 2 };
const VERB = { raise: 'increases', lower: 'decreases', set: 'sets' };
function merge(recs) {
    const out = [], by = new Map();
    for (const r of recs) { if (!r.sets && !r.relative) { out.push(r); continue; } const k = `${r.parameter}|${r.profile}`; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
    for (const list of by.values()) {
        list.sort((a, b) => (a.sig ? 1 : 0) - (b.sig ? 1 : 0) || CONF[a.confidence] - CONF[b.confidence]);
        const m = list[0], dirs = new Set(list.map(r => r.direction)), say = (r) => `${r.id.split(':')[0]} ${VERB[r.direction] || 'changes'} it${num(r.to) !== null ? ` to ${r.to}` : ''}${r.sig ? ' (less than 2 SE)' : ''}`;
        for (const r of list.slice(1)) m.evidence.push(...r.evidence);
        if (dirs.size > 1) { m.severity = 'check'; m.sig = null; m.caveats.push(`The checks do not agree on ${m.parameter}: ${and(list.map(say))}.`); }
        else if (list.length > 1) m.caveats.push(`Other checks agree on ${m.parameter}: ${and(list.slice(1).map(say))}.`);
        out.push(m);
    }
    return out;
}

// H: a measurement from a log before the latest header change of its parameter (in the rec's profile scope) describes
// another setup. Without start times and the analysed log's label nothing can be ordered, so any change counts. The keys:
// the header key of every name that the recommendation sets (r.sets) and of its parameter, and the header keys that its
// generator names (r.headerKeys). The logs: those of its evidence, and the analysed log when its values come from the log
// header (only that log, when only the header decides the change: base.headerOnly). -> { text, keys } or null
function staleKeys(r) {
    const keys = new Map(), add = (k) => { const P = PARAMS[k]; if (P && P[1]) keys.set(P[1], P[0]); };
    for (const [k] of r.sets || []) add(k);
    if (r.parameter) add(r.parameter);
    for (const [k, scope] of r.headerKeys || []) keys.set(k, scope);
    return keys;
}
function stale(c, r) {
    const keys = staleKeys(r); if (!keys.size) return null;
    const fromHeader = !!(r.base && /log header/.test(String(r.base.source || ''))), only = !!(r.base && r.base.headerOnly);
    const ev = only ? [] : [...new Set(r.evidence.flatMap(logsOf))], mine = ev.concat(fromHeader && c.headerLog !== null ? [c.headerLog] : []);
    if (!mine.length && !(fromHeader && c.headerLog === null)) return null;
    // the analysed header is of a bench run, and the file has flight logs: its values are not those of the flights
    const bench = (l) => c.logs.some(x => x.log === l && (x.logClass === 'bench' || x.bench === true));
    if (fromHeader && c.headerLog !== null && bench(c.headerLog) && c.logs.some(x => x.log !== c.headerLog && (x.logClass === 'flight' || (!x.logClass && x.flown))))
        return { keys: [...keys.keys()], text: `The values come from the log header of log ${lab(c.headerLog, c)}, a bench run with no flight. The flight logs can have different values. Thus, these values can be different from the values in flight.` };
    const p = num(r.profile) > 0 ? r.profile : null;
    const ch = c.F.filter(f => f.id === 'H' && keys.has(String(f.text).split(':')[0]) && (keys.get(String(f.text).split(':')[0]) === 'global' ? f.profile === 'global' : f.profile !== 'global' && (p === null || hProfile(f) === p)));
    if (!ch.length) return null;
    const t = (l) => c.start.has(l) ? String(c.start.get(l)) : null, last = ch.map(f => t(logsOf(f)[0])).sort().pop();
    if (ch.every(f => t(logsOf(f)[0]) !== null) && (c.headerLog !== null || !fromHeader) && mine.every(l => t(l) !== null && t(l) >= last)) return null;
    const names = [...new Set(ch.map(h => String(h.text).split(':')[0]))], changed = and(ch.slice(-3).map(h => changeText(h, c, true)));
    return { keys: names, text: only ? `The values come from the log header${c.headerLog !== null ? ` of log ${lab(c.headerLog, c)}` : ''}. The value of ${and(names)} changed between logs (${changed}). Thus, the log header can have values that are different from the values at this time.`
        : `The value of ${and(names)} changed between logs (${changed}). Thus, the results from ${logsText(r.evidence, c)} can be from different values.` };
}

const LOOP_GAIN = /^(roll|pitch|yaw)_[pidfbo]_gain$|^yaw_c?cw_stop_gain$/, GOV_GAIN = /^gov_(\w_)?gain$/;
// the filter issues of c.filterIssues ('F10 yaw' included) as check ids, and in words
const issueIds = (list) => list.map(x => x.split(' ')[0]);
const issueText = (list) => list.map(x => x.replace(/^(\w+) (\w+)$/, '$1 ($2)'));
function guard(r, c) {
    if (r.sig && r.severity !== 'info') { r.severity = 'watch'; r.caveats.push(`${r.sig} Thus, the recommendation is to monitor, with no change.`); r.sources.push(RULES.source.sigmas); }
    // a change: a value to set (r.sets), or a relative step on a value that is unknown (r.relative, no CLI): the guards
    // hold both, because the pilot can make the second one by hand
    const param = r.parameter || '', chg = !!r.sets || !!r.relative, old = chg || (r.headerKeys || []).length ? stale(c, r) : null;
    // a stale measurement gives no target: its step was sized on another setting (SPEC2 C1: every name that it sets, the
    // relative steps and the values of the log header too). A stale header value with no change is information
    if (old && !chg) { r.stale = true; r.caveats.push(old.text); if (r.severity !== 'info') r.severity = 'info'; }
    else if (old) { r.stale = true; r.caveats.push(old.text); if (r.severity === 'action') r.severity = 'check';
        const at = r.from !== null && r.from !== undefined && r.base && r.base.source ? `${param} is ${r.from} at this time (${r.base.source}). ` : '';
        r.setText = r.setNote = `${at}Record a new log with the values at this time, and then do the analysis again.`;
        Object.assign(r, { title: `Measure ${param || 'the values'} again`, to: null, direction: 'check' }); }
    // a cyclic or tail change waits while a filter change is to be made: one area at a time, in the order of TUNING_KNOWLEDGE
    // 9.1, and its numbers were measured with the filters that are about to change
    const waits = chg && (r.area === 'cyclic' || r.area === 'tail') && c.filterAction.length > 0;
    if (waits) hold(r, 'The filter change with CLI text comes first in the tuning sequence. The analysis measured this value with the filters that this change replaces.', c.filterAction);
    // guard 1: no loop gain raise before the filters are verified (TUNE; TUNING_KNOWLEDGE 8); a D raise also waits for the C11 flag of its axis
    if (chg && !waits && r.direction === 'raise' && LOOP_GAIN.test(param)) {
        const why = [...c.filterIssues].concat(/_d_gain$/.test(param) && c.flags('C11').some(f => axisOf(f) === r.axis) ? [`C11 ${r.axis}`] : []);
        if (why.length) hold(r, `${cap(checks(issueText(why)))} ${why.length === 1 ? 'shows a filter problem' : 'show filter problems'}. TUNE puts correct filters before you increase the gains.`, issueIds(why));
    }
    // a D cut for noise waits for the other filter work as well: the filters are the cure, and they change the noise
    if (chg && !waits && r.direction === 'lower' && /_d_gain$/.test(param) && r.evidence.some(e => e.id === 'F10' || e.id === 'C11')) {
        const other = [...c.filterIssues].filter(x => x !== 'F10 yaw');
        if (other.length) hold(r, `${cap(checks(issueText(other)))} ${other.length === 1 ? 'shows a filter problem' : 'show filter problems'}. The filter change comes first, because it changes the D-term noise. Decrease ${param} only if more than 50 % of its power stays at more than 30 Hz after the filter change.`, issueIds(other));
    }
    // guard 2: governor and RPM-notch changes wait for poles / gear and for the RPM signal (TUNING_KNOWLEDGE 9.1 step 0)
    if (chg && (r.area === 'governor' || /^gyro_rpm_notch/.test(param))) {
        if (c.flags('G12').length) hold(r, 'Check G12 shows an incorrect headspeed. The governor and the RPM notch filters use this headspeed. Correct motor_poles or the RPM sensor first.', ['G12']);
        if (c.flags('G1').some(f => !c.g1Overload.has(f))) hold(r, 'Check G1 shows FALLBACK entries: the RPM signal was not available. The governor and the RPM notch filters use this signal.', ['G1']);
    }
    // guard 2, cyclic and tail: a headspeed factor error beyond the RPM-notch tolerance moves every RPM notch off its line
    // and, under a governor, the flown headspeed; what was measured before the poles / gear fix waits (TUNING_KNOWLEDGE 9.1
    // step 0). G1 stays with governor and RPM-notch changes: FALLBACK spans are out of the loop analysis (health_loop)
    const g12 = c.flags('G12').filter(f => num(f.value) > 0 && Math.abs(f.value - 1) > SR.F5.maxDistance);
    if (chg && (r.area === 'cyclic' || r.area === 'tail') && g12.length)
        hold(r, `Check G12 shows the main rotor line at \`${fmt(g12[0].value, 4)} × headspeed / 60\`. This error is more than the ${SR.F5.maxDistance * 100} % tolerance of the RPM notch filters. Thus, the notch filters were not on the rotor lines when the log was recorded, and a governor held a different headspeed.`, ['G12']);
    // guard 11, FF last (K7): an F change waits while a D, P or I change of the same axis and PID profile is open (FF: "check
    // for the feed forward tune after adjusting other parameters"; TUNE step 4)
    if (chg && /^(roll|pitch|yaw)_f_gain$/.test(param)) { const open = c.dpi.filter(x => x !== r && x.axis === r.axis && (!(num(x.profile) > 0) || !(num(r.profile) > 0) || x.profile === r.profile));
        if (open.length) hold(r, `A change of the ${and([...new Set(open.map(x => /_([dpi])_gain$/.exec(x.parameter)[1].toUpperCase()))].sort((a, b) => 'DPI'.indexOf(a) - 'DPI'.indexOf(b)))} gain of the ${r.axis} axis comes first. The FF page puts the FF gain after the other gains (rule K7).`, []); }
    // guard 3: an axis at its output limit needs authority, not gains
    if (r.axis && /_gain$/.test(param) && r.area !== 'governor') { const a = c.authority(r.axis, r.profile);
        if (a) { r.caveats.push(`The ${r.axis} output was at its limit for ${fmt(a.s, 2)} s in ${many(a.n, 'result')} (check ${a.id}). Gains cannot increase the output range.`);
            if (chg && r.direction === 'raise') hold(r, `The ${r.axis} output is at its limit (check ${a.id}), and gains cannot give more output range.`, [a.id]); } }
    // guard 3, governor: no stiffer governor while the tail is at its limit (T8) or the governor is implicated in the wag
    // (G10) on that profile: "a well tuned governor might generate too much torque for the tail to counteract" (GOVT;
    // TUNING_KNOWLEDGE 8; analysis/gaui-x4/FINDINGS.md 1.7: stiffen only after the tail change passes). Lowering stays.
    if (chg && r.area === 'governor' && r.direction === 'raise' && GOV_GAIN.test(param)) {
        const same = (f) => !(num(r.profile) > 0) || !(num(profileOf(f)) > 0) || profileOf(f) === r.profile, tail = c.authority('yaw', r.profile), g10 = c.flags('G10').filter(same);
        if (tail) { hold(r, 'The tail is at its output limit (check T8). GOVT: "a well tuned governor might generate too much torque for the tail to counteract".', ['T8']);
            r.caveats.push('A governor with higher gains adds the motor torque more quickly when the collective increases. This torque goes to a tail at its limit (possible, not measured). '
                + 'On a tail that the main rotor turns, a smaller headspeed decrease also gives more tail speed (calculated). After the tail change, an increase is correct only if the tail does not go to its limit more than before.'); }
        if (g10.length) hold(r, `Check G10 shows that the governor causes the tail oscillation (coherence ${pm(g10[0].value, g10[0].se)}, ${many(g10.length, 'log-profile pair')}). For this condition, GOVT gives a smaller governor gain, not a larger one.`, ['G10']);
    }
    // TTA on while tuning the governor confounds it (GOVT)
    if (chg && r.area === 'governor' && GOV_GAIN.test(param) && pick(c.header.yaw_tta, 0) > 0) r.caveats.push(`gov_tta_gain is ${pick(c.header.yaw_tta, 0)}. GOVT tunes the governor with the TTA off (gov_tta_gain 0).`);
}

// K22: the G1 flags whose FALLBACK entries all come at an overload of a G19 finding of the same log (its events: overload with
// untilT, the index time of the governor change, as health_gov G1 times its entries). G1 times: its times, else "at N s" of its text
// the G1 flags whose FALLBACK entries all come at an overload: of check G19 (at a rescue) or of check G20 (every FALLBACK, with or
// without a rescue: coordinator, round 2). The times of a G1 flag: its times and every FALLBACK entry of its text ("<t> s (<s> s long")
function g1Overload(F, flags) {
    const out = new Set(), tol = 0.05, over = flags('G19').flatMap(g => (g.events || []).filter(e => e && e.overload && num(e.overload.untilT) !== null).map(e => ({ log: logsOf(g)[0], t: e.overload.untilT })))
        .concat(F.filter(g => g.id === 'G20').flatMap(g => (g.events || []).filter(e => e && e.kind === 'overload' && num(e.start) !== null).map(e => ({ log: logsOf(g)[0], t: e.start }))));
    if (!over.length) return out;
    for (const f of flags('G1')) { const own = [...String(f.text || '').matchAll(/(\d+(?:\.\d+)?) s \([\d.]+ s long/g)].map(m => +m[1]);
        const times = [...new Set((Array.isArray(f.times) ? f.times : []).concat(own, [...String(f.text || '').matchAll(/\bat (\d+(?:\.\d+)?) s\b/g)].map(m => +m[1])))].filter(t => num(t) !== null);
        if (times.length && times.every(t => over.some(o => logsOf(f).includes(o.log) && Math.abs(o.t - t) <= tol))) out.add(f); }
    return out;
}

// The causes of r: the K rules (hierarchy.cjs RULES) whose symptoms are among its flagged evidence findings (a gain
// decision is a C7 symptom of its axis and profile), with upstream flags in a compatible log, profile and axis; C2 by the
// axes of its mixer limits. A cause holds the CLI when a recommendation that is an action or a check cites one of its
// upstream findings ("unless the cause is only a watch", SPEC2 3.5); the steps to do first are the rule's.
// The times of a finding for the time test of the K rules (SPEC2 D-M1): the spans of its evidence (frame seconds, js/tuning_worker.js
// evidence.cjs) when it has them, else its events and times (index seconds). -> { base, list: [[log, t0, t1]] } or null
function timesOf(f) {
    const l0 = logsOf(f)[0], sp = f.evidence && Array.isArray(f.evidence.spans) ? f.evidence.spans.filter(x => x && num(x.t0) !== null && num(x.t1) !== null) : [];
    if (sp.length) return { base: 'frame', list: sp.map(x => [x.log === undefined ? l0 : x.log, x.t0, x.t1]) };
    const ev = (Array.isArray(f.events) ? f.events : []).filter(x => x && num(x.t) !== null).map(x => [l0, x.t, x.t + (num(x.seconds) > 0 ? x.seconds : 0)]);
    const list = ev.length ? ev : (Array.isArray(f.times) ? f.times : []).filter(t => num(t) !== null).map(t => [l0, t, t]);
    return list.length ? { base: 'index', list } : null;
}
// every time of u lies in a window of s, in the same log: then s can cause u (an oscillation drives the tail to its limit),
// and u is no cause of s. Unknown times give false: the rule stays
const TIME_TOL = 0.05;   // s: the rounding of the span times (evidence.cjs r3)
function insideOf(u, s) {
    const a = timesOf(u), b = timesOf(s); if (!a || !b || a.base !== b.base) return false;
    return a.list.every(([l, t0, t1]) => b.list.some(([m, w0, w1]) => m === l && t0 >= w0 - TIME_TOL && t1 <= w1 + TIME_TOL));
}
const spanText = (f, c) => { const t = timesOf(f); return t ? and(t.list.slice(0, 3).map(([l, a, b]) => `${fmt(a, 1)} s to ${fmt(b, 1)} s${typeof l === 'number' ? ` in log ${lab(l, c)}` : ''}`)) : ''; };
function causes(r, c) {
    const own = new Set(r.evidence.map(e => SOURCE.get(e)).filter(Boolean)), syms = [...own].filter(isFlag);
    if (/^C7:/.test(r.id) && r.severity !== 'info') syms.push({ id: 'C7', severity: 'flag', axis: r.axis, profile: num(r.profile) > 0 ? r.profile : null, log: null });
    const out = [];
    for (const K of Q.rules) {
        const s = syms.filter(x => K.symptoms.includes(x.id)); if (!s.length || !(K.upstream || []).length) continue;
        const ups0 = c.F.filter(u => isFlag(u) && K.upstream.includes(u.id) && !own.has(u) && s.some(x => Q.compatible(x, u)) && (u.id !== 'C2' || !lib.AXES.includes(r.axis) || c.c2Axes(u).includes(r.axis)));
        // an upstream flag whose times all lie in the windows of the symptoms it is compatible with is a result of them
        const within = K.before ? [] : ups0.filter(u => s.filter(x => Q.compatible(x, u)).every(x => insideOf(u, x))); // a rule with before: the time order decides (below)
        for (const u of within) r.caveats.push(`The times of check ${u.id} (${spanText(u, c)}) are all in the times of this result. Thus, rule ${K.id} does not apply to check ${u.id}: this result can cause it.`);
        // a rule with before (K24-K27): the upstream period starts before the error of the symptom (hierarchy.cjs startsBefore)
        const ups = ups0.filter(u => !within.includes(u) && (!K.before || !HIER || typeof HIER.startsBefore !== 'function' || s.some(x => Q.compatible(x, u) && HIER.startsBefore(u, x))));
        if (!ups.length) continue;
        out.push({ rule: K.id, name: K.name, fids: ups.map(u => u.fid).filter(Boolean), ids: [...new Set(ups.map(u => u.id))], first: (K.first || []).slice(), holds: ups.some(u => (c.cited.get(u) || []).some(x => x === 'action' || x === 'check')) });
    }
    return out;
}

// The node status of hierarchy.cjs (or the copy of its rules for Problem and Blocked when it does not load): a node is a
// problem when a home check flags and a recommendation on that flag is an action or a check (D2, D4 never), or when a
// SETUP or C7 recommendation on it is one; Blocked when a problem lies upstream along gate edges (blockedBy: the nearest)
// opts.profile (SPEC2 D12): the status of one PID profile, from its recommendations and those with no PID profile
const pkey = (r) => num(r.profile) === null ? null : String(r.profile > 0 ? r.profile : 0);
function statusOf(F, recs, opts) {
    if (Q.status) { try { const s = Q.status(F, recs, opts); if (s && s.nodes) return s; } catch (e) { /* the copy below */ } }
    const ACT = new Set(['action', 'check']), prob = new Set(), want = opts && opts.profile !== undefined && opts.profile !== null ? String(opts.profile) : null;
    for (const r of recs) if ((want === null || pkey(r) === null || pkey(r) === want) && ACT.has(r.severity) && r.node && (/^(SETUP|C7)(:|$)/.test(r.id) || r.evidence.some(e => { const f = SOURCE.get(e); return f && isFlag(f) && (f.id !== 'D2' || d2Problem(f)) && f.id !== 'D4' && Q.homeOf(f.id, axisOf(f)) === r.node; }))) prob.add(r.node);
    const nodes = {};
    for (const n of Q.nodes) { const up = Q.gateUpstream(n.id).filter(u => prob.has(u)), near = up.filter(u => !Q.gateUpstream(u).some(v => up.includes(v) && v !== u));
        nodes[n.id] = { status: prob.has(n.id) ? (near.length ? 'blocked' : 'problem') : null, blockedBy: prob.has(n.id) ? near : [] }; }
    return { nodes, startHere: [] };
}

// The gates of the tuning sequence: a recommendation on a node that the hierarchy status calls Blocked gets r.gate, and
// a blockedBy entry for each step before it that holds it. A step lets it through (a caveat says why) when it gates the
// node only through steps with no problem, when its problems are on another axis or PID profile, or when the change is a
// decrease under a filter or output-range gate (TUNE: correct filters before you increase the gains; "authority, not
// gains" for C2 and T8): the guards that hold those already did (guards 1 to 3)
const FILTERS_FIRST = 'This change is a decrease. The TUNE page puts correct filters before an increase of the gains, not before a decrease.';
const DECREASE_GATES = new Map([['filters', FILTERS_FIRST]]);
function gate(r, S, SP, c) {
    const N = r.node && S.nodes[r.node], by = N && Array.isArray(N.blockedBy) ? N.blockedBy.filter(u => Q.byId.has(u)) : [];
    if (!by.length) { r.gate = null; return; }
    // the steps that block the node in the diagram of the PID profile of the recommendation (SPEC2 D12)
    const NP = SP && SP !== S && r.node ? SP.nodes[r.node] : N, profileBy = NP && NP.status === 'blocked' && Array.isArray(NP.blockedBy) ? NP.blockedBy.filter(u => Q.byId.has(u)) : [];
    const held = [];
    for (const u of by) {
        if (r.holds.includes(u)) { held.push(u); continue; }   // a guard holds it for this step already, with its own words
        const node = Q.byId.get(u), items = c.problemsOf(u), ids = [...new Set(items.map(x => x.id))], what = node.kind === 'prereq' ? `The prerequisite "${node.title}"` : `Step ${node.step}, "${node.title}",`;
        const step = `${what} has a problem${ids.length ? ` (${checks(ids)})` : ''}.`;
        const direct = (Q.pred.get(r.node) || []).includes(u);
        const other = (items.length > 0 && items.every(x => !c.applies(x, r))) || (NP !== N && !profileBy.includes(u));
        const sc = direct ? Q.scope.get(`${u}>${r.node}`) : null, ids0 = [String(r.id).split(':')[0]].concat(r.evidence.map(e => e.id)), outOf = !!sc && !ids0.some(x => sc.includes(x));
        const why = !direct ? 'It comes before this step only through steps that have no problem.' : outOf ? `It holds only the changes of ${checks(sc)}.` : other ? 'Its problem is on a different axis or PID profile.'
            : r.direction === 'lower' && DECREASE_GATES.has(u) ? DECREASE_GATES.get(u) : null;
        if (why) { r.caveats.push(`${step} ${why} Thus, it does not hold this change.`); continue; }
        held.push(u);
        r.blockedBy.push(`${step} ${node.kind === 'prereq' ? 'Correct it before you tune this tuning block.' : 'This step comes first in the tuning sequence.'}`);
    }
    r.gate = { by, held, profileBy };
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
    if (/^gyro_rpm_notch_(source|q|center)_/.test(k) && String(v).split(',').length !== BANKS) return false;   // SPEC2 C10: a whole bank array
    if (/^gyro_rpm_notch_source_/.test(k)) return String(v).split(',').map(Number).every(s => Number.isInteger(s) && setup.decodeNotchSource(s, null).kind !== 'invalid');
    const lim = RANGE[k];
    return !lim || typeof v !== 'number' || (v >= lim[0] && v <= lim[1]);
}

const NO_PROFILE = 'The PID profile of this result is unknown (PID profile unknown). The log does not show the PID profile before the first PID profile change. Thus, there is no CLI text.';
// a recommendation that is not an action has no instruction to change a value (SPEC2 D-M5e): its title says the change as a
// noun ("The yaw CCW stop gain: a decrease (to monitor)"), and its text the change as a description (setNote)
const TITLE_VERB = /^(Increase|Raise|Decrease|Lower|Reduce|Set|Add|Use|Make)\s+(.+)$/;   // not "Change": the titles use it as a noun
const TITLE_NOUN = { Increase: 'an increase', Raise: 'an increase', Decrease: 'a decrease', Lower: 'a decrease', Reduce: 'a decrease', Add: 'a change', Use: 'a possible change', Make: 'a possible change' };
function nounTitle(r) {
    const m = TITLE_VERB.exec(String(r.title || '')); if (!m || (r.severity !== 'check' && r.severity !== 'watch')) return;
    const to = /^(.*?) (to .+)$/.exec(m[2]), obj = to ? to[1] : m[2], noun = TITLE_NOUN[m[1]] || 'a change';
    r.title = `${cap(obj)}: ${noun}${to ? ` ${to[2]}` : ''} (${r.severity === 'watch' ? 'to monitor' : r.severity === 'check' ? 'to examine' : 'information'})`;
}
// the checks that read the configuration (the log header or the CLI dump), not a measurement of the flights
const HEADER_IDS = new Set(['D1', 'D3', 'D4', 'F1', 'F2', 'F3', 'F4', 'F8', 'F9', 'H', 'SETUP']);
const headerCheck = (id) => { const k = CAT && CAT.CHECKS && CAT.CHECKS[id]; return k && k.evidence && k.evidence.source ? k.evidence.source === 'header' : HEADER_IDS.has(id); };
// review V4: a recommendation that rests on a measured result of the flights (not thin, not a value of the configuration)
// is 'measured'; a gain decision stays 'predicted' (the gain model); the others stay 'advisory' (not measured)
function confidenceOf(r) {
    if (r.confidence !== 'advisory') return r.confidence;
    return r.evidence.some(e => { const f = SOURCE.get(e) || e; return measured(f) && !headerCheck(f.id) && f.module !== 'report'; }) ? 'measured' : 'advisory';
}
// SPEC3 F: a recommendation text is, in this sequence, what the helicopter does (the symptom), why it matters, the numbers
// against the limit (the generator's text), then what to change and the expected effect. The symptom and its reason come from
// catalog.cjs lead for the first flagged finding of the recommendation; a sentence that the text has already is not repeated
const LEAD_STATUS = { action: 'problem', check: 'problem', watch: 'monitor', info: 'information' };
function leadOfRec(r) {
    if (!CAT || typeof CAT.lead !== 'function') return [];
    const rows = r.evidence.map(e => SOURCE.get(e) || e).filter(Boolean), f = rows.find(isFlag) || rows[0];
    if (!f || !CAT.CHECKS || !CAT.CHECKS[f.id]) return [];
    return CAT.lead(f, LEAD_STATUS[r.severity] || 'monitor').filter(t => typeof t === 'string' && t && !String(r.text).includes(t));
}
// the expected effect of a change (an action), by its check and direction: the documented purpose of the parameter
const EFFECT = {
    D1: () => 'Then the frequency results of the next log are accurate.',
    F1: () => 'Then less vibration gets to the PID controller and the servos.', F5: () => 'Then the filtered gyro has less vibration at this line.', F6: () => 'Then the filtered gyro has less vibration at this line.',
    F2: () => 'Then the filter time delay decreases, but more vibration gets through.', F3: () => 'Then the notch filter has a smaller bandwidth and a smaller time delay.',
    C11: () => 'Then less vibration goes to the servos.', F10: () => 'Then less vibration goes to the tail.',
    C1: () => 'Then the I-term has more range to correct a constant error.',
    C3: (r) => r.direction === 'raise' ? 'Then the stick response is faster, and the I-term must help less.' : 'Then the I-term operates less against the feedforward.',
    C4: (r) => r.direction === 'raise' ? 'Then the overshoot at the stops decreases, because the I-term must help less.' : 'Then the overshoot at the stops decreases.',
    C5: () => 'Then the oscillation decreases.', T1: () => 'Then the tail oscillation decreases.', C6: () => 'Then the slow oscillation decreases.', T2: () => 'Then the slow tail oscillation decreases.',
    C12: () => 'Then the gyro follows the sticks more accurately.', T11: () => 'Then the tail follows the yaw stick more accurately.', C13: () => 'Then the response to the stick is faster.', T12: () => 'Then the tail response to the stick is faster.',
    C14: () => 'Then the helicopter pitches less when the collective changes, and the pitch I-term stays nearer to zero.',
    T5: () => 'Then the yaw stops on the two sides are more equal.', T6: () => 'Then the tail moves less when the collective changes.', T7: () => 'Then the tail moves less when the collective changes.',
    T9: (r) => r.direction === 'raise' ? 'Then the pirouette response is faster, and the yaw I-term must help less.' : 'Then the yaw I-term operates less against the feedforward.',
    T14: () => 'Then the tail moves less when the headspeed changes.',
    G2: () => 'Then the headspeed stays nearer to the target in stable flight.', G3: () => 'Then the headspeed decreases less when the collective increases.', G4: () => 'Then the headspeed overshoot after a collective change decreases.',
    G5: () => 'Then the headspeed comes back to the target faster.', G9: () => 'Then the headspeed oscillation decreases.', G10: () => 'Then the governor causes less tail oscillation.',
    G15: () => 'Then the spool-up gives less torque, and the helicopter does not turn on the ground.',
    C7: () => 'The model calculates that the tracking error decreases after this change.',
};
const effectOf = (r) => { const id = String(r.id).split(':')[0].replace(/#\d+$/, ''), e = EFFECT[id]; try { return e ? e(r) : null; } catch (err) { return null; } };
function finish(r) {
    if (r.scope === 'profile' && num(r.profile) > 0) r.cliProfile = r.profile - 1;
    r.confidence = confidenceOf(r);
    // the sources after the rule, in one form (review V3): "Source: ...". The list stays in r.sources for the views
    r.sources = [...new Set(r.sources.filter(Boolean))];
    r.rule = [r.rule, sourceSentences(r.sources)].filter(Boolean).join(' ');
    // where the from-value comes from (the export comments): the present value of change(), else the analysed log header
    r.fromSource = r.base && r.base.source ? r.base.source : r.from !== null && r.from !== undefined && r.scope === 'global' ? 'log header' : null;
    const st = r.severity === 'action' ? r.setText : r.setNote !== undefined ? r.setNote : null;
    // symptom and why, then the numbers (the generator's text), then the change and its expected effect (SPEC3 F): one paragraph each
    const lead = leadOfRec(r).join(' '), eff = r.severity === 'action' && (r.sets || r.relative) ? effectOf(r) : null, change = [st, eff].filter(Boolean).join(' ');
    r.text = [lead, String(r.text || '').trim()].concat(r.dsText || [], [change]).filter(Boolean).join('\n').replace(/ *\n+ */g, '\n'); // the configurations after the numbers (round 3 M1)
    nounTitle(r);
    // a cause that holds: "Possible result of" (SPEC2 3.5), no CLI until it is corrected
    const held = r.causes.filter(x => x.holds);
    if (held.length && (r.sets || r.relative) && r.severity === 'action')
        r.caveats.push(`This can be a result of the problems of ${checks([...new Set([].concat(...held.map(x => x.ids)))])} (${and(held.map(x => `rule ${x.rule}, "${x.name}"`))}). The app gives no CLI text for it until you correct them.`);
    if (r.severity !== 'action' || !r.sets || !r.sets.length || r.blockedBy.length || r.stale || held.length) return;
    if (r.scope === 'profile' && !(num(r.profile) > 0)) { if (!r.profileNote && !(r.base && r.base.unknown === 'profile')) r.caveats.push(NO_PROFILE); return; }
    if (r.base && (r.base.unknown || r.base.approx || r.base.unconfirmed)) return;
    if (!r.sets.every(([k, v]) => PARAMS[k] && PARAMS[k][0] === r.scope && floorsOk(k, v) && legal(k, v))) { r.caveats.push('The app does not write a value that is less than a filter limit, not in its firmware range, an RPM notch source that the firmware does not accept, or not a Rotorflight 4.6 name.'); return; }
    r.cli = (r.scope === 'profile' ? [`profile ${r.cliProfile}`] : []).concat(r.sets.map(([k, v]) => `set ${k} = ${v}`));
}

// guard 11: the tuning sequence of hierarchy.cjs: step and row of the node (the documented sequence: preconditions,
// measurement, filters, governor, cyclic then tail gains, rates and the result), then inside a node the documented
// sequence: GOVT F -> I -> P; TUNE D -> P -> I -> FF on each axis, pitch before roll; tail D -> P -> I -> FF, then the
// collective FF, then the stop gains; then the severity
const SEV = { action: 0, check: 1, watch: 2, info: 3 };
const STEP = ['G1', 'G12', 'D4', 'D9', 'D6', 'P1', 'P2', 'T8', 'C2', 'T13', 'T4', 'C10', 'D5', 'G13', 'D1', 'D2', 'D3', 'H', 'F1', 'F2', 'F3', 'F5', 'F6', 'F8', 'F10', 'C11', 'F11', 'F4', 'F9',
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
const sortKey = (r) => { const n = r.node ? Q.byId.get(r.node) : null;
    return [r.id === 'ERROR' ? 0 : n ? n.step : 9, n ? n.row : 0, rank(r), AXR[r.axis] === undefined ? 3 : AXR[r.axis], SEV[r.severity], num(r.profile) === null ? -1 : r.profile]; };
function compare(a, b) { const x = sortKey(a), y = sortKey(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

const OUT_KEYS = ['id', 'node', 'area', 'order', 'severity', 'title', 'text', 'parameter', 'scope', 'cliProfile', 'profile', 'rateProfile', 'axis', 'from', 'fromSource', 'fromSources', 'fromSets', 'to', 'direction', 'cli', 'evidence', 'rule', 'sources', 'confidence', 'blockedBy', 'gate', 'causes', 'caveats', 'group', 'groupSize',
    'dataset', 'supportedBy', 'ab', 'slope'];   // round 3 M1: null and [] without configurations

// ---------------------------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------------------------

// Status of a row: finding (a flag, or a recommendation on one of its parameters), checked (a measured result), the
// needs-* that would let its checks run, not-in-log (the log does not record the values that its checks use: every result
// of the row was not done for that cause, the limit of an L check is unknown, or the PID mode row without a CLI dump), no-check
// (no check of the app informs it: none exists, or it does not run in the app) or not-assessable (no log can inform it:
// COVERAGE nolog). A row whose checks operated on the data with too little of it is needs-flights, also when its values are
// not in the log header (the column cli). With a CLI dump, the PID mode row is judged on the CLI capture. The CLI dump is an
// optional input (user rule 2026-10-06): no status asks for it
const NOT_IN_LOG = /CLI|gear ratio|log header does not record/i;   // the text of a result that was not done because the log does not record a value
const STATE = { flag: 'problem', note: 'monitor', ok: 'satisfactory', skipped: 'not measured', error: 'analysis error', thin: 'not sufficient data' };
const FIELD_STATE = { present: 'recorded', zero: 'always 0', absent: 'missing' };
function coverage(c, decisions, recommendations) {
    const counts = (sel) => { const k = ['flag', 'note', 'thin', 'ok', 'skipped', 'error'].map(s => [s, sel.filter(f => (s === 'thin' ? f.severity === 'note' && thin(f) : s === 'note' ? f.severity === 'note' && !thin(f) : f.severity === s)).length]).filter(x => x[1]);
        return k.length === 1 && k[0][0] === 'ok' ? '' : and(k.map(x => `${x[1]} ${STATE[x[0]]}`)); };
    // a gain decision counts on the rows of its axis; as a flag on the rows of the gains it changes, as checked on the others
    const C7 = decisions.map(d => ({ id: 'C7', axis: d.axis, params: d.change ? (d.changes || []).map(s => `${d.axis}_${String(s.gain).toLowerCase()}_gain`) : [], severity: d.change ? 'flag' : 'ok', text: d.reason || 'change' }));
    const all = c.F.concat(C7), silent = Object.entries(NEW).filter(([, ids]) => !all.some(f => ids.includes(f.id)));   // a new module that gave no finding did not run
    const prof = c.cli && c.cli.selectedProfile !== null ? c.cli.profiles[c.cli.selectedProfile] : null, pmodes = pidModes(c);
    return COVERAGE.map(line => {
        const [section, area, groupName, params, ids0, cliOnly, why, nolog] = line.split('|'), ids = ids0 ? ids0.split(' ') : [], parameters = params.split(',');
        const axes = new Set(parameters.map(k => (/^(roll|pitch|yaw)_/.exec(k) || [])[1]).filter(Boolean)), modes = parameters.includes('pid_mode');
        // a finding counts on the rows it is about: C7 by axis and gain (above), D4 where its text names a parameter of the row
        const sel = all.filter(f => ids.includes(f.id)).map(f => f.id !== 'C7' ? f : !axes.has(f.axis) ? null : !isFlag(f) || f.params.some(k => parameters.includes(k)) ? f : Object.assign({}, f, { severity: 'ok' }))
            .filter(f => f && (f.id !== 'D4' || parameters.some(k => String(f.text).includes(k))));
        const real = sel.filter(f => !thin(f) && f.severity !== 'skipped' && f.severity !== 'error');
        const missing = c.fields ? [...new Set(ids.flatMap(id => FIELDS[id] || []))].filter(k => c.fields[k] && c.fields[k] !== 'present') : [];
        const skip = sel.filter(f => f.severity === 'skipped').map(f => String(f.text)), notRun = silent.filter(([, l]) => ids.some(id => l.includes(id))).map(([m]) => m);
        const advised = recommendations.some(r => r.severity !== 'info' && r.parameter && parameters.includes(r.parameter));
        const status = sel.some(isFlag) || advised ? 'finding' : real.length ? 'checked'
            : !ids.length ? (modes ? (!c.cli ? 'not-in-log' : pmodes.some(m => m.value !== null) ? 'checked' : 'not-assessable') : nolog === 'nolog' ? 'not-assessable' : 'no-check')
            : missing.length ? 'needs-fields'
            : ids.every(id => ELSEWHERE.includes(id) || notRun.some(m => NEW[m].includes(id))) ? 'no-check'
            : !sel.some(thin) && sel.some(f => f.severity === 'skipped' && (f.limitUnknown === true || NOT_IN_LOG.test(String(f.text)))) ? 'not-in-log'
            : skip.some(t => /lacks|not logged|absent|missing|field/i.test(t)) ? 'needs-fields' : 'needs-flights';
        const perCheck = ids.length ? `The checks have these numbers of results: ${and(ids.map(id => { const s = sel.filter(f => f.id === id), k = counts(s); return `${id} ${s.length}${k ? ` (${k})` : ''}`; }))}.` : '';
        const cliVals = c.cli ? parameters.filter(k => !modes || k !== 'pid_mode').map(k => { const v = c.cli.global[k] !== undefined ? c.cli.global[k] : prof ? prof[k] : undefined; return v === undefined ? null : `\`${k} = ${v}\``; }).filter(Boolean) : [];
        const esc = parameters.includes('blackbox_log_esc') && c.fields ? and(['EscRPM', 'EscV', 'EscI', 'EscThr', 'Tesc', 'Ibat'].map(k => `\`${k}\` ${FIELD_STATE[c.fields[k]] || 'unknown'}`)) : '';
        const modeText = modes && pmodes ? [...group(pmodes, m => m.value === null ? 'unknown' : `${m.value}${m.absent ? ' (not in the CLI dump, thus the default)' : ''}`)].map(([v, l]) => `${v} in ${l.length === 1 ? 'the section' : 'the sections'} ${and(l.map(m => `\`profile ${m.profile}\``))}`).join(', ') : '';
        const detail = [perCheck, notRun.length ? `The ${notRun.length === 1 ? 'module' : 'modules'} ${and(notRun.map(m => `"${m}"`))} gave no result, because ${notRun.length === 1 ? 'it' : 'they'} did not operate.` : '', missing.length ? `The log does not have these fields: ${and(missing.map(k => `\`${k}\``))}.` : '',
            status === 'not-in-log' && ids.length ? 'The log does not record the values that these checks use.' : '', modes && pmodes ? `CLI pid_mode: ${modeText || 'the CLI dump has no PID profile section'}.` : '',
            cliVals.length ? `CLI values: ${cliVals.join(', ')}.` : '', esc ? `ESC fields of the selected log: ${esc}. No check uses them.` : '', why || ''].filter(Boolean).join(' ');
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
    // every finding with the PID profile of the worker (pidProfile) in its profile field (resolved: the input is not changed)
    const all = (Array.isArray(inp.findings) ? inp.findings : []).filter(f => f && typeof f.id === 'string').map(resolved), decisions = rawDecisions.filter(d => d && !withdrawn(d));
    const header = inp.header || {}, cli = inp.cli && inp.cli.profiles && inp.cli.global ? inp.cli : null, logs = Array.isArray(inp.logs) ? inp.logs : [];
    // bench logs are not flights: setup findings of logs that were not flown stay out (the tuning history H stays)
    const flown = logs.length ? new Set(logs.filter(l => l.flown).map(l => l.log)) : null;
    const F = all.filter(f => !withdrawn(f) && !(flown && f.module === 'setup' && f.id !== 'H' && logsOf(f).length && !logsOf(f).some(l => flown.has(l))));
    const ignored = all.filter(withdrawn).length + rawDecisions.length - decisions.length;
    if (ignored) notes.push(`The app ignores ${many(ignored, 'item')} from section 8 of the tail oscillation report, because its author does not use that section at this time.`);
    const flags = (id) => F.filter(f => f.id === id && isFlag(f));
    const c = { F, header, cli, logs, fields: inp.fields || null, flags, filterIssues: new Set(), staleCli: new Set(), topLine: null, filterAction: [],
        start: new Map(logs.filter(l => l.start !== undefined && l.start !== null).map(l => [l.log, l.start])), headerLog: inp.headerLog === undefined ? null : inp.headerLog, logBase: num(inp.logBase) || 0,
        headerProfile: num(inp.headerProfile) !== null ? inp.headerProfile : logs.length === 1 && num(logs[0].startProfile) !== null ? logs[0].startProfile : null,
        headerConfirmed: inp.headerProfileInferred !== true, cliName: typeof inp.cliName === 'string' && inp.cliName ? inp.cliName : null,   // an inferred arming profile is the profile of no header value (SPEC2 D12)
        dsc: dsContext(inp),     // the configurations of the worker (round 3 M1), or null
        gear: !cli && inp.gear && typeof inp.gear === 'object' ? inp.gear : null };   // without a CLI dump, the notch orders of the log (worker gearFit: filter_tune tailOrder().gear)
    // D4: the CLI names that the CLI dump gives with another value ("<header key> <value> vs <cli name> <value>"; the CLI names
    // are lower case, and the head "header vs CLI (" is not one). The header holds the values of the arming profile: the values
    // of a PID profile show a stale CLI dump only when D4 compared the CLI section of the confirmed arming profile. The worker
    // tells it (cliSection.usable: true; false for the section of another profile, null when the arming profile is not
    // confirmed, js/tuning_worker.js sectionOf). Without cliSection, every value counts. The global values always count
    for (const f of flags('D4')) { const guessed = !!f.cliSection && typeof f.cliSection === 'object' && f.cliSection.usable !== true;
        for (const m of String(f.text).matchAll(/ vs ([a-z][a-z0-9_]*)(?:\[\d\])? /g)) if (!guessed || D4_GLOBAL.test(m[1])) c.staleCli.add(m[1]); }
    c.c2Axes = (f) => { const w = (/output limit \(([^)]*)\)/.exec(String(f.text)) || [])[1] || '', only = (a, b) => new RegExp(`mixer\\[${a}\\]`).test(w) && !new RegExp(`mixer\\[${b}\\]|ring|servo|collective`).test(w);
        return only(0, 1) ? ['roll'] : only(1, 0) ? ['pitch'] : ['roll', 'pitch']; };
    c.authority = (axis, p) => { const id = axis === 'yaw' ? 'T8' : 'C2', same = (f) => !(num(p) > 0) || !(num(profileOf(f)) > 0) || profileOf(f) === p, fl = flags(id).filter(f => (id === 'T8' || c.c2Axes(f).includes(axis)) && same(f));
        if (fl.length) return { id, s: sum(fl), n: fl.length };
        // the control limits (health_limits L3, L4): the same guard, for the periods in all phases and in the rescue
        const lid = axis === 'yaw' ? 'L4' : 'L3', lf = flags(lid).filter(f => same(f) && (lid === 'L4' ? f.channel === 'tail' : f.channel === axis || f.channel === 'ring'));
        return lf.length ? { id: lid, s: sum(lf), n: lf.length } : null; };
    c.g1Overload = g1Overload(F, flags);

    // generators in GEN order (filters before the guards read c.filterIssues), then the report.cjs decisions
    const byId = group(F.filter(f => f.severity !== 'error'), f => f.id), known = new Set(Object.keys(GEN).concat(['C7', 'C8', 'C9', 'G7', 'G20'])); // C7: decisions; C8, C9 report only; G7 a diagnostic note
    let recs = [];
    for (const [id, gen] of Object.entries(GEN)) if (byId.has(id) || gen.always) recs.push(...gen(byId.get(id) || [], c));
    recs.push(...decisionRecs(decisions, c));
    const errors = F.filter(f => f.severity === 'error');
    recs.push(...one(errors, { id: 'ERROR', area: 'logging', title: 'Some checks did not operate', rule: 'An error in the analysis stops its checks, and they give no result.',
        text: [...group(errors, f => f.module || f.id)].map(([m, l]) => `Module ${m}: "${String(l[0].text).replace(/"/g, "'")}"${l.length > 1 ? ` (${many(l.length, 'error')})` : ''}.`).join(' ') }));
    const unknown = [...byId.keys()].filter(id => !known.has(id));
    if (unknown.length) notes.push(`${cap(checks(unknown))} ${unknown.length === 1 ? 'has' : 'have'} no recommendation. ${unknown.length === 1 ? 'It is' : 'They are'} only in the results.`);

    // guard 8: no governor gain change from logs where G0 says DIRECT / LIMIT, nor when the CLI says so and no log shows a PID governor
    const direct = new Set(F.filter(f => f.id === 'G0' && f.severity === 'note' && /DIRECT or LIMIT/.test(String(f.text))).flatMap(logsOf)), pidGov = F.some(f => f.id === 'G0' && f.severity === 'ok');
    const cliDirect = !!cli && /^(DIRECT|LIMIT|OFF)$/i.test(String(cli.global.gov_mode || '').trim()) && !pidGov;
    const dropped = recs.filter(r => GOV_GAIN.test(r.parameter || '') && (cliDirect || (r.evidence.length && r.evidence.every(e => logsOf(e).length && logsOf(e).every(l => direct.has(l))))));
    if (dropped.length) notes.push(`The app removed ${many(dropped.length, 'governor gain change')}, because the governor does not control the headspeed (check G0 DIRECT or LIMIT${cliDirect ? `, CLI gov_mode ${cli.global.gov_mode}` : ''}).`);
    recs = merge(recs.filter(r => !dropped.includes(r)));
    c.filterAction = [...new Set(recs.filter(r => r.area === 'filters' && r.severity === 'action' && r.sets).map(r => r.id.split(':')[0]))];
    c.dpi = recs.filter(r => (r.sets || r.relative) && r.severity === 'action' && !r.sig && /^(roll|pitch|yaw)_[dpi]_gain$/.test(r.parameter || '') && (r.area === 'cyclic' || r.area === 'tail'));
    // the causes, gates and CLI read every evidence row: the list is cut to RULES.maxEvidence only in the output (SPEC2 C2)
    for (const r of recs) guard(r, c);

    // the tuning sequence (hierarchy.cjs): node, causes, gates
    c.cited = new Map(); for (const r of recs) { r.node = Q.homeOf(r.id, r.axis); for (const e of r.evidence) { const f = SOURCE.get(e); if (f) { if (!c.cited.has(f)) c.cited.set(f, []); c.cited.get(f).push(r.severity); } } }
    for (const r of recs) r.causes = causes(r, c);
    // K22 for a FALLBACK at an overload (G1:overload): its G20 rows are the upstream results, also when no upstream flag matches
    for (const r of recs.filter(x => /^G1:overload/.test(x.id) && !x.causes.some(q => q.rule === 'K22'))) { const up = r.evidence.filter(e => e.id === 'G20' || e.id === 'G19'), K = Q.rules.find(q => q.id === 'K22');
        if (up.length && K) r.causes.push({ rule: 'K22', name: K.name, fids: up.map(e => e.fid).filter(Boolean), ids: [...new Set(up.map(e => e.id))], first: (K.first || []).slice(), holds: false }); }
    // the problem items of a node (flags with an action or check recommendation, and SETUP or C7 recommendations), and
    // whether one applies to a recommendation (a compatible axis and PID profile; C2 by the axes of its mixer limits)
    c.problemsOf = (u) => F.filter(f => isFlag(f) && (f.id !== 'D2' || d2Problem(f)) && f.id !== 'D4' && Q.homeOf(f.id, axisOf(f)) === u && (c.cited.get(f) || []).some(x => x === 'action' || x === 'check'))
        .concat(recs.filter(r => r.node === u && /^(SETUP|C7)(:|$)/.test(r.id) && (r.severity === 'action' || r.severity === 'check')).map(r => ({ id: r.id.split(':')[0], axis: r.axis, profile: r.profile, rec: true })));
    c.applies = (x, r) => { const p = num(profileOf(x)), q = num(r.profile); if (p > 0 && q > 0 && p !== q) return false;
        const a = x.id === 'C2' && !x.rec ? c.c2Axes(x) : [x.rec ? x.axis : axisOf(x) || (/^T\d/.test(x.id) ? 'yaw' : null)].filter(Boolean);
        return !a.length || !r.axis || a.includes(r.axis); };
    // the gates of the diagram: of the PID profile of the recommendation (the diagram has a status for each PID profile,
    // SPEC2 D12), or of all profiles together for a recommendation with no PID profile
    const clones = recs.map(r => Object.assign({}, r)), sopts = { logs, header, fields: inp.fields || null, cli }, S = statusOf(F, clones, sopts), byP = new Map();
    const statusFor = (r) => { const k = r.scope === 'global' ? null : pkey(r); if (k === null) return S; if (!byP.has(k)) byP.set(k, statusOf(F, clones, Object.assign({ profile: +k }, sopts))); return byP.get(k); };
    for (const r of recs) { gate(r, S, statusFor(r), c); dsStep(r, c); finish(r); }
    // SPEC2 C3: the gains that report.cjs changes together have CLI text together. A member with no CLI text, or one that a
    // merge took into another recommendation, takes the CLI text of all of them
    for (const [g, list] of group(recs.filter(r => r.group), r => r.group)) {
        const size = Math.max(...list.map(r => r.groupSize || 0)), without = list.filter(r => !r.cli.length);
        if (list.length >= size && !without.length) continue;
        for (const r of list) { if (r.cli.length) { r.cli = []; r.caveats.push(`The model changes ${size} gains together (\`${g}\`), and ${without.length ? `the change of ${and([...new Set(without.map(x => x.parameter))])} has no CLI text` : 'one of them is in another recommendation'}. Thus, no change of this group has CLI text.`); } }
    }
    recs.sort(compare);
    const seen = new Map();
    const recommendations = recs.map((r, i) => { const o = {}; for (const k of OUT_KEYS) o[k] = r[k]; o.order = i + 1; const n = seen.get(o.id) || 0; seen.set(o.id, n + 1); if (n) o.id += `#${n + 1}`;
        // citedFids: the fid of every evidence row before the cut, for the diagram of the worker (hierarchy.cjs status cites them)
        if (o.evidence.length > RULES.maxEvidence) { o.citedFids = o.evidence.map(e => e.fid).filter(Boolean); o.caveats = o.caveats.concat(`There are ${o.evidence.length} results, and the list shows the first ${RULES.maxEvidence}.`); o.evidence = o.evidence.slice(0, RULES.maxEvidence); }
        return o; });

    if (!cli) notes.push('The log header of each log gives only the values of the PID profile that was active at the start of that log.');
    const sections = cli ? Object.keys(cli.profiles).sort((a, b) => a - b) : [];
    if (cli && sections.length < RULES.pidProfiles) notes.push(`The CLI dump has ${sections.length ? `only the ${sections.length === 1 ? 'section' : 'sections'} ${and(sections.map(x => `\`profile ${x}\``))}` : 'no PID profile section'}, of ${RULES.pidProfiles}. Possibly, \`${cli.kind}\` without \`all\` shows only the active PID profile, or the dump is not complete (${RULES.source.pidProfiles}). `
        + 'The values of the other PID profiles come from the log header, and they get no CLI text.');
    if (!cli && !(c.headerProfile > 0)) notes.push('The PID profile of the selected log at the start of the log is unknown. Thus, the values from the log header get no CLI text, but a model value that agrees with them gives CLI text.');
    const ex = {}; for (const l of logs) for (const [k, v] of Object.entries(l.excluded || {})) if (num(v) !== null) ex[k] = (ex[k] || 0) + v;
    const EXCLUDED = { rescueS: 'rescue', levelModeS: 'angle, horizon or trainer mode', failsafeS: 'failsafe', groundS: 'ground contact', guardS: 'the time around them' }; // health_more normalMask
    const shown = Object.entries(ex).filter(([, v]) => Math.round(v * 10) > 0); // what rounds to 0.0 s is not shown
    if (shown.length) notes.push(`The analysis did not use these parts of the logs: ${shown.map(([k, v]) => `${EXCLUDED[k] || k} ${fmt(v, 1)} s`).join(', ')}.`);
    const cnt = (s) => recommendations.filter(r => r.severity === s).length;
    notes.unshift(`There ${recommendations.length === 1 ? 'is 1 recommendation' : `are ${recommendations.length} recommendations`} from ${many(F.length, 'result')}${decisions.length ? ` and ${many(decisions.length, 'gain decision')} of the gain model` : ''}. `
        + `Of these, ${cnt('action')} ${cnt('action') === 1 ? 'is a change' : 'are changes'} (${recommendations.filter(r => r.cli.length).length} with CLI text), ${cnt('check')} to examine, ${cnt('watch')} to monitor and ${cnt('info')} for information.`);
    return { recommendations, coverage: coverage(c, decisions, recommendations), notes };
}

// ---------------------------------------------------------------------------------------------
// Configurations (round 3 M1, SPEC3 J): datasets.cjs datasets(), from the worker (input.datasets)
// ---------------------------------------------------------------------------------------------

// A configuration is one PID profile with one exact set of the values that change the flight. The worker gives each finding
// its configuration (f.dataset). A recommendation starts from the newest configuration of its PID profile (ds.newestByProfile:
// the configuration that the pilot flew last), says which configurations support it, compares the results of its check in the
// configurations that differ in a few parameters (A/B, 2 SE), and uses the measured slope of the result against its parameter
// when the data give one at 2 SE and the change stays inside the measured range.
const DS_RULES = {
    maxAb: 3,   // A/B pairs in a recommendation (pipeline choice: the text stays short)
    source: 'toolkit rule, no flight test: an A/B difference counts when it is 2 SE or more, and a slope only inside the range of the measured configurations',
};
function dsContext(inp) {
    const ds = inp && inp.datasets && Array.isArray(inp.datasets.datasets) ? inp.datasets : null;
    return ds ? { ds, byId: new Map(ds.datasets.map(d => [d.id, d])) } : null;
}
const dsList = (ids) => ids.length > 1 ? `configurations ${and(ids)}` : `configuration ${ids[0]}`;
// The present value of a parameter from the newest configuration of PID profile p (the newest of the file for a global value):
// { value, source, dataset } (header, CLI dump, or the header of the nearest log armed in p when the logs before and after it
// agree); an estimate, an in-flight adjustment or an assumed header: approx (no CLI); no value: unknown (no CLI). null when the
// result has no configurations, the name is an array or a type, or the configuration does not have the name (the rules before)
function dsValue(c, param, p) {
    const P = PARAMS[param]; if (!c.dsc || !P || P[2] === 'all' || /_type$/.test(param)) return null;
    const ds = c.dsc.ds, id = P[0] === 'global' ? ds.newest : ds.newestByProfile ? ds.newestByProfile[num(p) > 0 ? p : 'unknown'] : null;
    const d = id ? c.dsc.byId.get(id) : null; if (!d || !d.values || !(param in d.values)) return null;
    const v = d.values[param], s = d.sources ? d.sources[param] : null, lb = c.logBase;
    if (v === null || s === 'none' || s === undefined || s === null) return { value: null, unknown: 'dsNone', dataset: id };
    if (typeof v !== 'number') return null;
    const logs = (d.logs || []).map(l => l + lb), where = `configuration ${id}, the newest of ${P[0] === 'global' ? 'the file' : prof(p)}`;
    if (s === 'estimate') return { value: v, source: `${where}, log header`, approx: true, why: 'dsEstimate', dataset: id };
    if (s === 'adjustment') return { value: v, source: `${where}, in-flight adjustment`, approx: true, why: 'dsAdjustment', dataset: id };
    if (s === 'cli') return c.staleCli.has(param) ? { value: null, unknown: 'staleCli', dataset: id } : { value: v, source: `${where}, ${cliWords(c)}${P[0] === 'global' ? '' : `, section \`profile ${p - 1}\``}`, dataset: id };
    const m = /^log (\d+)/.exec(String(s));
    if (m) { const from = +m[1], ok = (d.assumedFrom || []).filter(a => a.from === from).every(a => a.bracketed === true);
        return Object.assign({ value: v, source: `${where}, log header of log ${from + lb}`, dataset: id }, ok ? {} : { approx: true, why: 'dsAssumed' }); }
    return { value: v, source: `${where}, log header of ${logs.length > 1 ? `logs ${and(logs)}` : `log ${logs[0]}`}`, dataset: id };
}
// the configuration of an evidence row (its finding's f.dataset)
const dsOf = (e) => { const f = SOURCE.get(e) || e; return f && typeof f.dataset === 'string' ? f.dataset : null; };
// the display unit and scale of a check (catalog.cjs), for the A/B numbers
function unitScale(f) { try { if (CAT && typeof CAT.format === 'function') { const v = CAT.format(f); return { unit: v.unit || '', scale: num(v.scale) !== null ? v.scale : 1 }; } } catch (e) { /* below */ }
    return f.unit === 'fraction' ? { unit: '%', scale: 100 } : { unit: f.unit || '', scale: 1 }; }
// value ± SE in the display unit (catalog.cjs pair: the SE keeps one significant digit)
const numText = (v, se, u) => { const x = u.scale || 1, unit = u.unit === 'fraction' ? '%' : u.unit || '';
    if (CAT && typeof CAT.pair === 'function') { const t = CAT.pair(v * x, num(se) === null ? null : se * x, unit || null); if (t) return t.replace(/−/g, '-'); }
    const d = Math.abs(v * x) >= 100 ? 0 : Math.abs(v * x) >= 10 ? 1 : 2; return `${fmt(v * x, d)}${num(se) !== null ? ` ± ${fmt(se * x, d)}` : ''}${unit ? ` ${unit}` : ''}`; };
// the checks that the parameters of a configuration change (hierarchy.cjs blocks: every block with one of the names, and the
// other block of its lane: the tail gains with the tail compensation, the cyclic gains with the cyclic compensation)
function relevantChecks(names) {
    const B = HIER && Array.isArray(HIER.BLOCKS) ? HIER.BLOCKS : [], hit = B.filter(b => (b.params || []).some(n => names.includes(n))), lanes = new Set(hit.map(b => b.lane).filter(l => l && l !== 'main'));
    const use = B.filter(b => hit.includes(b) || lanes.has(b.lane)), out = new Set();
    for (const b of use) for (const c of b.checks || []) out.add(String(c).split(':')[0]);
    return out;
}
// The results of check id on axis by configuration, and datasets.cjs compare() of them: { results, cmp, unit } or null
// with o.thin also the results with not sufficient data (no SE: the A/B is not testable). The checks of an output at its limit
// (RATE_CHECKS) compare the periods at the limit for each minute of the configuration (flight: its flight time; all: all its
// time in the analysed logs), with the SE of a count (sqrt of the count, 1 for no period): the time at the limit has no SE
const RATE_CHECKS = { T8: 'flight', C2: 'flight', L1: 'all', L2: 'all', L3: 'all', L4: 'all', L5: 'all', L6: 'all', L7: 'all' };
function rateResults(L, c, kind) {
    const n = {}, out = {};
    for (const f of L) if (num(f.n) !== null) n[f.dataset] = (n[f.dataset] || 0) + f.n;
    for (const [id, k] of Object.entries(n)) { const d = c.dsc.byId.get(id), sec = d ? (kind === 'flight' ? d.analysedFlightSeconds : d.analysedSeconds) : null;
        if (num(sec) > 0) out[id] = { mean: k / (sec / 60), se: Math.sqrt(Math.max(k, 1)) / (sec / 60), n: k }; }
    return out;
}
function dsCompare(c, id, axis, o = {}) {
    if (!c.dsc || !DSM) return null;
    const rate = RATE_CHECKS[id], L = c.F.filter(f => f.id === id && (axisOf(f) || null) === (axis || null) && f.dataset && (rate ? num(f.n) !== null && (measured(f) || f.severity === 'ok') : num(f.value) !== null && (measured(f) || (o.thin && thin(f)))));
    if (new Set(L.map(f => f.dataset)).size < 2) return null;
    const results = rate ? rateResults(L, c, rate) : DSM.resultsOf(L, {}); let cmp = null;
    if (Object.keys(results).length < 2) return null;
    try { cmp = DSM.compare(results, c.dsc.ds); } catch (e) { return null; }
    // each pair in the order of the configuration ids (A before B): the difference is b - a
    cmp.pairs = cmp.pairs.map(q => q.a < q.b ? q : Object.assign({}, q, { a: q.b, b: q.a, delta: num(q.delta) === null ? q.delta : -q.delta, z: num(q.z) === null ? q.z : -q.z }));
    return { results, cmp, unit: rate ? { unit: rate === 'flight' ? 'periods for each minute of flight' : 'periods for each minute', scale: 1 } : unitScale(L[0]), list: L, rate: !!rate, thin: L.some(thin) };
}
// one A/B pair in words: what differs (abHead), the result in each configuration, the difference and its 2-SE test (abBody)
function abHead(pair, byId) {
    const a = byId.get(pair.a), b = byId.get(pair.b), v = (d, n) => d && d.values && d.values[n] !== undefined && d.values[n] !== null ? d.values[n] : 'unknown';
    return `Configurations ${pair.a} and ${pair.b} are different only in ${and(pair.names.map(n => `\`${n}\` ${v(a, n)} against ${v(b, n)}`))}.`;
}
function abBody(id, pair, R, u) {
    const A = R[pair.a], B = R[pair.b], d = Math.abs(pair.delta) < 5e-7 ? 0 : pair.delta;
    return [`Check ${id} gives ${numText(A.mean, A.se, u)} in configuration ${pair.a} and ${numText(B.mean, B.se, u)} in configuration ${pair.b}.`,
        !pair.testable ? 'These results have no SE. Thus, the app cannot do the 2-SE test, and the logs do not show an effect.'
            : pair.significant ? `The difference is ${numText(d, pair.se, u)}, more than 2 SE. Thus, the logs show an effect of these parameters on this result.`
                : `The difference is ${numText(d, pair.se, u)}, not more than 2 SE. Thus, the logs show no effect of these parameters on this result.`].join(' ');
}
const AB_NOTE = 'Other conditions of the flights can also change a result, for example the maneuvers and the battery.';
// The configurations of a recommendation (before finish): r.dataset (the newest configuration of its PID profile), r.supportedBy
// (the configurations of its results with a problem, else of all its results), r.ab (A/B pairs of its check), r.slope (the
// measured slope of its check against its parameter, 2 SE, only inside the measured range), the text of the configurations
// (r.dsText) and the guard of the newest configuration: an action whose problem is only in older configurations of its PID
// profile, while the newest configuration has a result with no problem, becomes a watch (the pilot changed the values since)
function dsStep(r, c) {
    if (!c.dsc) return;
    const ds = c.dsc.ds, p = num(r.profile), lb = c.logBase, rows = r.evidence.map(e => SOURCE.get(e) || e).filter(Boolean);
    r.dataset = r.scope === 'global' || p === null ? ds.newest || null : ds.newestByProfile ? ds.newestByProfile[p > 0 ? p : 'unknown'] || null : null;
    const ids = (sel) => [...new Set(sel.map(f => f.dataset).filter(x => typeof x === 'string'))].sort();
    const flagged = ids(rows.filter(isFlag)), all = ids(rows);
    r.supportedBy = flagged.length ? flagged : all;
    const text = [], paras = [];
    if (r.supportedBy.length) text.push(`The results of ${dsList(r.supportedBy)} give this recommendation.`);
    // the newest configuration of the PID profile: no problem there while older configurations have one
    const own = rows.filter(f => f.dataset === r.dataset), newestOk = r.dataset && own.length && !own.some(isFlag) && own.some(measured);
    if (r.dataset && flagged.length && !flagged.includes(r.dataset)) {
        if (newestOk) { text.push(`The newest configuration ${r.dataset} has a result with no problem.`);
            r.caveats.push(`The problem is only in ${dsList(flagged)}, and the newest configuration ${r.dataset} has a satisfactory result. Thus, there is no CLI text. A new flight with the newest configuration gives a new result.`);
            if (r.severity === 'action') r.severity = 'watch'; }
        else if (!own.length) text.push(`The newest configuration ${r.dataset} has no result of this check.`);
    }
    // A/B and slope of the first check of the recommendation (the check of its id), on its axis
    const id = String(r.id).split(':')[0].replace(/#\d+$/, ''), first = rows.find(f => f.id === id) || rows[0];
    const cmp = first ? dsCompare(c, first.id, axisOf(first)) : null;
    r.ab = []; r.slope = null;
    if (cmp) {
        const inProfile = (x) => { const d = c.dsc.byId.get(x); return !d || p === null || r.scope === 'global' || (num(d.pidProfile) || 0) === (p > 0 ? p : 0); };
        const pairs = cmp.cmp.pairs.filter(q => q.few && q.testable && (inProfile(q.a) || inProfile(q.b)) && (relevantChecks(q.names).has(first.id) || (r.parameter && q.names.includes(r.parameter)))).slice(0, DS_RULES.maxAb);
        r.ab = pairs.map(q => ({ a: q.a, b: q.b, check: first.id, axis: axisOf(first), names: q.names.slice(), delta: q.delta, se: q.se, significant: !!q.significant, unit: cmp.unit.unit || null, scale: cmp.unit.scale || 1,
            text: `${abHead(q, c.dsc.byId)} ${abBody(first.id, q, cmp.results, cmp.unit)}${q.significant ? ` ${AB_NOTE}` : ''}` }));
        for (const q of r.ab) paras.push(q.text);
        if (r.parameter && num(r.from) !== null && num(r.to) !== null) {
            const pr = DSM.predict(cmp.cmp, r.parameter, r.from, r.to);
            if (pr && pr.slope && pr.significant && pr.inRange) {
                r.slope = { name: r.parameter, perUnit: pr.slope.slope, se: pr.slope.se, datasets: pr.slope.datasets.slice(), change: pr.change, changeSe: pr.se, together: pr.together.slice(), range: pr.slope.range.slice(),
                    check: first.id, unit: cmp.unit.unit || null, scale: cmp.unit.scale || 1 };
                r.slope.text = `In ${dsList(pr.slope.datasets)}, check ${first.id} changes by ${numText(pr.slope.slope, pr.slope.se, cmp.unit)} for each 1 of \`${r.parameter}\`${pr.together.length ? ` (with ${and(pr.together.map(n => `\`${n}\``))})` : ''}. `
                    + `Thus, the change from ${r.from} to ${r.to} gives ${numText(pr.change, pr.se, cmp.unit)}.`;
                paras.push(r.slope.text);
            } else if (pr && pr.slope && pr.significant && !pr.inRange) paras.push(`The measured slope of check ${first.id} is for \`${r.parameter}\` from ${pr.slope.range[0]} to ${pr.slope.range[1]}. The change goes out of this range, thus the app does not use the slope.`);
        }
    }
    if (r.ab.some(q => q.significant) || r.slope) r.sources.push(DS_RULES.source);
    r.dsText = [text.join(' ')].concat(paras).filter(Boolean); // paragraphs (STE: 6 sentences or fewer in each)
}
/**
 * comparisons(findings, datasets) -> [{ a, b, names, values { name: [value in a, value in b] }, results: [{ check, axis, a { mean,
 * se, n }, b, delta, se, significant, text }], text }]: for each pair of configurations that are different in a few parameters
 * (datasets.cjs compare: 3 or less, none unknown), every result that both have with an SE, in the words of the views (STE).
 * The pairs in the order of datasets.cjs pairs; the results by the size of the difference in SE
 */
function comparisons(findings, datasets) {
    const c = { F: (Array.isArray(findings) ? findings : []).filter(f => f && typeof f.id === 'string').map(resolved), dsc: dsContext({ datasets }), logBase: 1 };
    if (!c.dsc || !DSM) return [];
    const keys = new Map(); for (const f of c.F) if (f.dataset && (measured(f) || thin(f)) && (num(f.value) !== null || RATE_CHECKS[f.id])) keys.set(`${f.id}|${axisOf(f) || ''}`, [f.id, axisOf(f) || null]);
    const out = new Map();
    for (const [id, axis] of keys.values()) {
        const cmp = dsCompare(c, id, axis, { thin: true }); if (!cmp) continue;
        for (const q of cmp.cmp.pairs) { if (!q.few) continue;
            const k = `${q.a}|${q.b}`, A = c.dsc.byId.get(q.a), B = c.dsc.byId.get(q.b), rel = relevantChecks(q.names).has(id);
            if (!q.testable && !rel) continue; // a result with no SE only for the checks that these parameters change
            if (!out.has(k)) out.set(k, { a: q.a, b: q.b, names: q.names.slice(), values: Object.fromEntries(q.names.map(n => [n, [A && A.values ? A.values[n] : null, B && B.values ? B.values[n] : null]])), relevant: [...relevantChecks(q.names)].sort(), results: [] });
            out.get(k).results.push({ check: id, axis, relevant: rel, testable: !!q.testable, thin: cmp.thin, rate: cmp.rate, a: cmp.results[q.a], b: cmp.results[q.b], delta: q.delta, se: q.se, z: q.z, significant: !!q.significant, unit: cmp.unit.unit, scale: cmp.unit.scale,
                text: abBody(id, q, cmp.results, cmp.unit) }); }
    }
    const order = new Map((c.dsc.ds.pairs || []).map((q, i) => [`${q.a}|${q.b}`, i]));
    return [...out.values()].sort((x, y) => (order.get(`${x.a}|${x.b}`) ?? 1e9) - (order.get(`${y.a}|${y.b}`) ?? 1e9)).map(o => {
        // the results of the checks that these parameters change first (relevantChecks), then by the size of the difference in SE
        o.results.sort((x, y) => (y.relevant - x.relevant) || Math.abs(y.z || 0) - Math.abs(x.z || 0));
        const rel = o.results.filter(x => x.relevant), test = rel.filter(x => x.testable), sig = test.filter(x => x.significant), say = (l) => and(l.slice(0, 4).map(x => `check ${x.check}${x.axis ? ` (${x.axis})` : ''}`));
        o.text = [abHead(o, c.dsc.byId),
            !rel.length ? 'The logs have no result of a check that these parameters change in the two configurations.'
                : !test.length ? `The two configurations have ${many(rel.length, 'result')} of the checks that these parameters change, but no result has an SE. Thus, the logs do not show an effect.`
                    : `${many(test.length, 'result')} of the checks that these parameters change ${test.length === 1 ? 'has' : 'have'} an SE. ` + (sig.length
                        ? `Of these, ${sig.length} ${sig.length === 1 ? 'is' : 'are'} different by 2 SE or more: ${say(sig)}. ${AB_NOTE}`
                        : 'No result is different by 2 SE or more. Thus, the logs show no effect of these parameters.')].join(' ');
        return o; });
}

// ---------------------------------------------------------------------------------------------
// The filter search (round 3 M2): filter_tune.cjs tune() of the worker command filterTune -> recommendations
// ---------------------------------------------------------------------------------------------

const FILTER_RULE = 'The app recommends a set of filter values only if the filter model agrees with the recorded gyroADC (1 dB, 0.3 ms). '
    + 'The vibration at the PID controller must decrease by 3 dB or more by 2 SE, with 0.5 ms of time delay or less at 10 Hz to 30 Hz. '
    + 'The set must also be correct in 80 % of the tests without one flight log.';
// short sources: the "Sources:" sentence must stay on one comment line of the CLI file (240 characters), so that its quoted text stays quoted
const FILTER_SOURCES = ['toolkit rule, no flight test: a model of the Rotorflight 4.6 gyro filters (firmware 4.6.0, sensors/gyro_filter_impl.c)', 'Rotorflight documentation, "First flight and filter tuning"'];
// the Q of a static notch from its center and its cutoff (firmware filter.c notchFilterGetQ)
const notchQOf = (hz, cutoff) => hz > 0 && cutoff > 0 && hz > cutoff ? hz * cutoff / (hz * hz - cutoff * cutoff) : null;
/**
 * filterRecommendations(res, meta) -> [recommendation]: the filter search in the form of advise() (one global recommendation with the
 * features and the global values, and one for each PID profile with cutoff changes: group 'F:filters', the export takes all of them or
 * none). An action only when tune() recommends the set (recommended.status) and the filter model agrees with every flight log
 * (model.passed). Else one check that gives the reasons: the model does not agree, a decrease of less than 3 dB, ...
 * Every value is a PARAMS name of its scope in RANGE and over the filter floors, and a feature is a 4.6 feature name. The set must
 * keep a gyro low-pass filter (the Configurator help text with the RPM filters) and a static notch Q of 2.0 or more.
 * meta: { texts (filter_tune.cjs texts(res)), logBase, cli (true: a CLI dump was loaded), blockedBy: [STE texts] (the gates of the
 * filters block in the diagram), dataset (the newest configuration) }
 */
function filterRecommendations(res, meta = {}) {
    const R = (res && res.recommended) || {}, M = (res && res.model) || {}, T = meta.texts || {}, rows = Array.isArray(R.rows) ? R.rows : [];
    const action = R.status === 'recommended' && M.passed === true && rows.length > 0, why = (T.why || []).slice(), blocked = Array.isArray(meta.blockedBy) ? meta.blockedBy.filter(Boolean) : [];
    const base = { node: 'filters', area: 'filters', rule: FILTER_RULE, sources: FILTER_SOURCES.slice(), confidence: 'predicted', dataset: meta.dataset || null };
    const paras = [T.summary, T.recommendation, T.delay, T.validation, T.parity].filter(Boolean);
    const check = (caveats) => [finishFilter(rec(Object.assign({}, base, { id: 'F:filters', severity: 'check', scope: 'global', title: 'Filter values from the flight logs: no change (to examine)',
        text: paras.join('\n'), caveats })))];
    if (!action) return check(why.length ? [] : ['The analysis of the filter values gives no set of changes.']);
    // the values of the set, as the CLI accepts them
    const bad = [], glob = { features: [], sets: [] }, byProf = new Map(), from = {}, srcOf = {};
    const SRC = { header: 'log header', cli: cliWords({ cliName: meta.cliName || null }) };
    for (const row of rows) {
        const nm = String(row.name), f = /^feature (\w+)$/.exec(nm);
        if (f) { if (!FEATURE_NAMES.includes(f[1])) bad.push(`\`${f[1]}\` is not a feature of Rotorflight 4.6.`); else { glob.features.push([f[1], row.to === true || row.to === 'true']); from[nm] = row.from === null || row.from === undefined ? null : !!row.from; } continue; }
        const P = PARAMS[nm], v = row.to === null || row.to === undefined ? '' : String(row.to);
        if (!P) { bad.push(`\`${nm}\` is not a name that the app writes.`); continue; }
        // a value at this time from the log header or the CLI dump only (CLAUDE.md "PID profiles"): a default of the model is not one
        if (!SRC[row.source] || row.from === null || row.from === undefined) { bad.push(`The value of \`${nm}\` at this time is unknown, because ${meta.cli ? 'the log header and the CLI dump do not give it' : 'the log header does not record it'}.`); continue; }
        if (P[0] !== (row.scope === 'profile' ? 'profile' : 'global')) { bad.push(`\`${nm}\` is not a ${row.scope === 'profile' ? 'PID profile' : 'global'} value.`); continue; }
        if (!cliValueOk(nm, v)) { bad.push(`The value ${v} of \`${nm}\` is not in its firmware range, or it is less than a filter limit.`); continue; }
        if (row.scope === 'profile') { const p = num(row.profile); if (!(p > 0)) { bad.push(`The PID profile of \`${nm}\` is unknown (PID profile unknown).`); continue; }
            if (!byProf.has(p)) byProf.set(p, []); byProf.get(p).push([nm, v]); }
        else glob.sets.push([nm, v]);
        const key = `${row.scope === 'profile' ? `p${row.profile}:` : ''}${nm}`; from[key] = row.from; srcOf[key] = SRC[row.source];
    }
    // the set keeps a gyro low-pass filter, and every static notch has a Q of 2.0 or more
    const s = Object.assign({}, (res.current && res.current.settings) || {}); for (const [k, v] of glob.sets) s[k] = /_type$/.test(k) ? setup.LPF_TYPES.indexOf(v) : +v;
    const lpfOn = (t, hz) => num(t) !== null && t > 0 && num(hz) > 0;
    if ((glob.sets.some(([k]) => /^gyro_lpf\d_/.test(k))) && !lpfOn(s.gyro_lpf1_type, s.gyro_lpf1_static_hz) && !lpfOn(s.gyro_lpf2_type, s.gyro_lpf2_static_hz))
        bad.push('The set has no gyro low-pass filter. With the RPM filters, one low-pass filter of about 100 Hz is necessary (Configurator help text).');
    for (const k of [1, 2]) { const hz = s[`gyro_notch${k}_hz`], co = s[`gyro_notch${k}_cutoff`], q = notchQOf(hz, co);
        if (glob.sets.some(([n]) => n === `gyro_notch${k}_hz` || n === `gyro_notch${k}_cutoff`) && hz > 0 && (q === null || q < RULES.minNotchQ)) bad.push(`The static notch filter ${k} has a Q of ${q === null ? 'unknown' : fmt(q, 2)}, less than ${RULES.minNotchQ}.`); }
    if (bad.length) return check(bad.concat(['Thus, there is no CLI text.']));
    const n = (glob.features.length || glob.sets.length ? 1 : 0) + byProf.size, group = n > 1 ? 'F:filters' : null, out = [];
    const pick = (keep, strip) => Object.fromEntries(Object.entries(keep).filter(([k]) => strip(k) !== null).map(([k, v]) => [strip(k), v]));
    const rowText = (sel) => sel.map(x => x.text).filter(Boolean), chunks = (list) => { const o = []; for (let i = 0; i < list.length; i += 5) o.push(list.slice(i, i + 5).join(' ')); return o; };
    const effect = 'Then less vibration gets to the PID controller and the servos.';
    if (glob.features.length || glob.sets.length) {
        const gr = (T.rows || []).filter(x => x.scope !== 'profile');
        out.push(rec(Object.assign({}, base, { id: 'F:filters', severity: 'action', scope: 'global', title: 'Set the gyro filter values that the app found', group, groupSize: group ? n : null,
            text: paras.concat(chunks(rowText(gr)), [effect]).join('\n'), cli: glob.features.map(([f, on]) => `feature ${on ? '' : '-'}${f}`).concat(glob.sets.map(([k, v]) => `set ${k} = ${v}`)),
            sets: glob.sets.slice(), fromSets: pick(from, (k) => /^p\d+:/.test(k) ? null : k), fromSources: pick(srcOf, (k) => /^p\d+:/.test(k) ? null : k) })));
    }
    for (const [p, sets] of [...byProf].sort((a, b) => a[0] - b[0])) {
        const pr = (T.rows || []).filter(x => x.scope === 'profile' && x.profile === p);
        out.push(rec(Object.assign({}, base, { id: `F:filters:p${p}`, severity: 'action', scope: 'profile', profile: p, cliProfile: p - 1, title: `Set the PID cutoffs that the app found on ${prof(p)}`, group, groupSize: group ? n : null,
            text: (out.length ? [] : paras).concat(chunks(rowText(pr)), [effect]).join('\n'), cli: [`profile ${p - 1}`].concat(sets.map(([k, v]) => `set ${k} = ${v}`)), sets: sets.slice(),
            fromSets: pick(from, (k) => k.startsWith(`p${p}:`) ? k.replace(/^p\d+:/, '') : null), fromSources: pick(srcOf, (k) => k.startsWith(`p${p}:`) ? k.replace(/^p\d+:/, '') : null) })));
    }
    for (const r of out) { if (blocked.length) { r.blockedBy = blocked.slice(); r.cli = []; r.caveats.push('A step before the filters in the tuning sequence has a problem. Thus, there is no CLI text until you correct it.'); } finishFilter(r); }
    return out;
}
// the end of a filter recommendation (as finish, without the generators' fields): the sources after the rule, the output keys
function finishFilter(r) {
    r.sources = [...new Set(r.sources.filter(Boolean))];
    r.rule = [r.rule, sourceSentences(r.sources)].filter(Boolean).join(' ');
    const kinds = [...new Set(Object.values(r.fromSources || {}))];
    r.fromSource = kinds.length === 1 ? kinds[0] : null; if (kinds.length < 2) r.fromSources = null;
    const o = {}; for (const k of OUT_KEYS) o[k] = r[k] === undefined ? null : r[k];
    o.order = 0; return o;
}

// ---------------------------------------------------------------------------------------------
// Export (SPEC2 D11): the CLI file for the Configurator
// ---------------------------------------------------------------------------------------------

// Configurator 2.3.0 (rotorflight-configurator, tag release/2.3.0): the CLI tab has "Load from file" (.txt or .config,
// src/js/tabs/cli.js): it shows the commands for review, makes a comment of a line that starts with dump, diff or exit,
// and "Execute" sends each line. The Presets tab takes presets only from a source with an index.json (a URL,
// src/js/presets/source/retriever.js); its "Load Backup" sends a .txt or .config file as CLI lines. The firmware CLI
// ignores the text after # (cli.c processCharacter). Thus, the export is one CLI file, and there is no preset file.

// the recommendations that the export panel ticks first: every action with CLI text; checks, watches and information never
const exportable = (r) => !!r && r.severity === 'action' && Array.isArray(r.cli) && r.cli.length > 0 && !(r.blockedBy || []).length && !(r.causes || []).some(x => x && x.holds);
function defaultPicks(recommendations) { return (Array.isArray(recommendations) ? recommendations : []).filter(exportable).map(r => r.id); }

// one value that the CLI accepts for name k (guards 5, 6 and 12): a number in RANGE, a filter type name, or a list of
// exactly 16 integers for the RPM notch arrays (SPEC2 C10); the filter floors and the RPM notch sources that the firmware knows
function cliValueOk(k, v) {
    const P = PARAMS[k]; if (!P || typeof v !== 'string' || !v.length) return false;
    if (P[2] === 'all') return /^-?\d+(,-?\d+)*$/.test(v) && v.split(',').length === BANKS && floorsOk(k, v) && legal(k, v);
    if (/_type$/.test(k)) return setup.LPF_TYPES.includes(v);
    if (!/^-?\d+$/.test(v)) return false;
    return floorsOk(k, +v) && legal(k, +v);
}
// why a picked recommendation does not go into the file, or null; and its commands: { scope, index, sets: [[k, v]] }
function exportPlan(r) {
    if (r.severity !== 'action') return { why: 'It is not a change. Only a change with CLI text goes into the file.' };
    if ((r.blockedBy || []).length) return { why: 'A step before it in the tuning sequence has a problem. Correct that step first.' };
    if ((r.causes || []).some(x => x && x.holds)) return { why: 'It can be a result of a problem before it (refer to "Possible result of"). Correct that problem first.' };
    const cli = Array.isArray(r.cli) ? r.cli.map(String) : [];
    if (!cli.length) return { why: 'It has no CLI text.' };
    let scope = 'global', index = null, lines = cli;
    const pm = /^profile (\d+)$/.exec(cli[0]), rm = /^rateprofile (\d+)$/.exec(cli[0]);
    if (r.scope === 'profile' || pm) {
        const p = num(r.profile);
        if (!(p > 0) || !Number.isInteger(p)) return { why: 'The PID profile is unknown (PID profile unknown). Thus, the file has no CLI text for it.' };
        if (!pm || +pm[1] !== p - 1 || (r.cliProfile !== undefined && r.cliProfile !== null && r.cliProfile !== p - 1) || p > RULES.pidProfiles) return { why: `The CLI text does not agree with ${prof(p)} (\`profile ${p - 1}\`).` };
        scope = 'profile'; index = p - 1; lines = cli.slice(1);
    } else if (r.scope === 'rateprofile' || rm) {
        const q = num(r.rateProfile);
        if (!(q > 0) || !Number.isInteger(q) || !rm || +rm[1] !== q - 1 || q > RULES.rateProfiles) return { why: 'The rate profile is unknown, or the CLI text does not agree with it.' };
        scope = 'rateprofile'; index = q - 1; lines = cli.slice(1);
    } else if (r.scope !== 'global') return { why: 'The scope of the change is unknown.' };
    const sets = [], features = [];
    for (const l of lines) {
        const fm = /^feature (-?)([A-Z0-9_]+)$/.exec(l);   // round 3 M2: a feature line (global), a 4.6 feature name only
        if (fm) { if (scope !== 'global') return { why: 'A `feature` line is a global value, not a value of a profile.' };
            if (!FEATURE_NAMES.includes(fm[2])) return { why: `\`${fm[2]}\` is not a feature of Rotorflight 4.6.` };
            features.push([fm[2], fm[1] !== '-']); continue; }
        const m = /^set ([a-z0-9_]+) = (\S+)$/.exec(l);
        if (!m) return { why: `The CLI text has a line that is not a \`set\` command: \`${l.replace(/[`\r\n]/g, ' ').slice(0, 60)}\`.` };
        if (!PARAMS[m[1]]) return { why: `\`${m[1]}\` is not a name that the app writes.` };
        if (PARAMS[m[1]][0] !== scope) return { why: `\`${m[1]}\` is not a ${scope === 'profile' ? 'PID profile' : scope === 'rateprofile' ? 'rate profile' : 'global'} value.` };
        if (PARAMS[m[1]][2] === 'all' && m[2].split(',').length !== BANKS) return { why: `The value of \`${m[1]}\` must have ${BANKS} numbers, one for each bank.` };
        if (!cliValueOk(m[1], m[2])) return { why: `The value of \`${m[1]}\` is not in its firmware range, or it is less than a filter limit.` };
        sets.push([m[1], m[2]]);
    }
    return sets.length || features.length ? { scope, index, sets, features } : { why: 'It has no `set` command.' };
}

// one comment text in lines of the file: one sentence on each line (a line of the firmware CLI holds 256 characters).
// SPEC2 C8: the Configurator CLI tab sends the low 8 bits of each character (cli_engine.js), and a character such as U+4E0A
// becomes a line feed, which ends the comment and makes the rest a command. Thus, a comment has only printable ASCII and
// the symbols ± × ° µ of the texts (Latin-1: their low 8 bits are the character, never a control character). Dashes and
// quotation marks get their ASCII form, and each other character becomes '_'
const ASCII = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...' };
const clean = (t) => String(t === null || t === undefined ? '' : t).replace(/[\r\n\t]+/g, ' ').replace(/[–—‘’“”…]/g, (ch) => ASCII[ch]).replace(/[^\x20-\x7e±×°µ]/g, '_').replace(/\s+/g, ' ').trim();
// Where a sentence of more than max characters breaks: after the last comma in the second half of the line, else at the last
// space, both outside "quotes" and `code`, else at the last space (else at max). A break in a quote, or between "notch" and
// "filter", puts words on a line without their context (test/ste_text.test.cjs reads each comment line as one text)
function cutAt(s, max) {
    let quote = false, code = false, comma = -1, space = -1;
    for (let i = 0; i <= Math.min(s.length - 1, max); i++) {
        const ch = s[i];
        if (ch === '"' && !code) quote = !quote; else if (ch === '`' && !quote) code = !code;
        else if (ch === ' ' && !quote && !code && i > 40) { space = i; if (s[i - 1] === ',' && i > max / 2) comma = i; }
    }
    if (comma > 0) return comma;
    if (space > 0) return space;
    const cut = s.lastIndexOf(' ', max); return cut > 40 ? cut : max;
}
function commentLines(text, indent) {
    const pre = `#${indent ? '   ' : ' '}`, out = [];
    for (const sen of clean(text).split(/(?<=[.!?])\s+(?=[A-Z0-9"`(])/)) {
        let rest = sen;
        while (rest.length > 240) { const at = cutAt(rest, 240); out.push(pre + rest.slice(0, at)); rest = rest.slice(at).trim(); }
        if (rest) out.push(pre + rest);
    }
    return out;
}
// an evidence row in the words of the file: where, value ± SE and limit, then its STE summary
function evidenceLines(e, base) {
    const where = [e.log === null || e.log === undefined ? null : `log ${[].concat(e.log).map(l => typeof l === 'number' ? l + base : l).join(', ')}`,
        num(profileOf(e)) !== null ? prof(profileOf(e)) : null, e.axis || null].filter(Boolean).join(', ');
    // the value that the rule compares and the limit in its unit (catalog.cjs display, review V5), else the toolkit value and
    // threshold (quoted); with display and no limit in that unit, the summary gives the limit
    const d = e.display && typeof e.display === 'object' ? e.display : null;
    const v = d && d.value ? d.value : num(e.value) !== null ? valueOf(e, e.unit) : null;
    const lim = d ? d.bound || null : typeof e.threshold === 'number' ? String(e.threshold) : typeof e.threshold === 'string' && e.threshold ? `"${clean(e.threshold).replace(/"/g, "'")}"` : null;
    // the limit is a second sentence: with a long limit (F1: "1 gyro low-pass filter or more with the RPM filters"), 1 sentence
    // has more than 25 words (STE Rule 6.3)
    const head = `Result of check ${e.id}${where ? ` (${where})` : ''}${e.fid ? `, \`${clean(e.fid).replace(/`/g, "'")}\`` : ''}: ${v !== null ? `the value is ${v}` : 'the value is not a number'}.${lim ? ` The limit is ${lim}.` : ''}`;
    return commentLines(head, true).concat(e.summary ? commentLines(e.summary, true) : []);
}
// The flag of a recommendation whose results use values that are possibly not current: r.stale of js/tuning_worker.js
// ({ reasons, text, findings }), else null. The boolean r.stale of the H staleness test (stale()) is not this flag: such a
// recommendation has no CLI text
const staleOf = (r) => r && r.stale && typeof r.stale === 'object' && typeof r.stale.text === 'string' && r.stale.text.trim() ? r.stale : null;

/**
 * exportScript(recs, picks, meta) -> string: the CLI file of the export panel.
 *   recs   advise().recommendations (or a part of them)
 *   picks  the ids that the pilot ticked: an array or a Set; null or undefined = defaultPicks(recs)
 *   meta   { craft, file, logs: [labels], flights, firmware, profiles: [PID profiles 1-6 in the analysis], date: 'YYYY-MM-DD',
 *            logBase (added to the log numbers of the evidence, default 0), activeProfile, activeRateProfile (CLI index of
 *            the selection to restore after the changes, for example parseCli(text).selectedProfile) }, all optional
 * Order: the warning and the procedure (its first step saves `diff all`), the other comments, `batch start`, the `profile N` sets, the `rateprofile N` sets, the global sets, the restore of the
 * selection, `save`. In a command batch, `save` does not save after a command error (RULES.source.batch).
 * Pure: the caller gives the date.
 */
function exportScript(recommendations, picks, meta) {
    const m = meta || {}, list = (Array.isArray(recommendations) ? recommendations : []).filter(r => r && typeof r === 'object' && typeof r.id === 'string');
    const ids = new Set(picks === undefined || picks === null ? defaultPicks(list) : picks instanceof Set ? [...picks] : [].concat(picks));
    const base = num(m.logBase) || 0, chosen = list.filter(r => ids.has(r.id)), plans = chosen.map(r => ({ r, plan: exportPlan(r) }));
    // two picks that set one name on one profile to different values: neither goes into the file
    const value = new Map();
    for (const { plan } of plans) if (plan.sets) for (const [k, v] of plan.sets.concat((plan.features || []).map(([n, on]) => [`feature ${n}`, on]))) { const key = `${plan.scope}|${plan.index}|${k}`; if (!value.has(key)) value.set(key, new Set()); value.get(key).add(v); }
    for (const x of plans) if (x.plan.sets && x.plan.sets.concat((x.plan.features || []).map(([n]) => [`feature ${n}`])).some(([k]) => value.get(`${x.plan.scope}|${x.plan.index}|${k}`).size > 1))
        x.plan = { why: 'Two selected changes set the same value to different numbers. Select one of them.' };
    // a group of changes that the model made together (SPEC2 C3): all of its changes, or none
    for (const [g, xs] of group(plans.filter(x => x.r.group && x.plan.sets), x => x.r.group)) {
        const size = Math.max(...list.filter(r => r.group === g).map(r => r.groupSize || 0), list.filter(r => r.group === g).length);
        if (xs.length < size) for (const x of xs) x.plan = { why: `It is 1 of ${size} changes that the model makes together (\`${clean(g).replace(/`/g, "'")}\`). Select all ${size} changes, or none of them.` };
    }
    const ok = plans.filter(x => x.plan.sets), bad = plans.filter(x => !x.plan.sets);
    const profiles = Array.isArray(m.profiles) && m.profiles.length ? m.profiles : [...new Set(list.map(r => num(r.profile)).filter(p => p > 0))].sort((a, b) => a - b);
    const out = ['# Rotorflight CLI file from Rotorflight Blackbox (Tuning view, Export).',
        '# WARNING: Examine each change before you use it. After each change, do a hover test in a safe area. Incorrect gains or filters can cause oscillations that you cannot control.',
        '# NOTE: This file gives recommendations only. The app does not send data to the flight controller.', '#',
        // the backup step first (CLAUDE.md "Export": the script starts with this step), before the flights of a file with many logs
        '# Procedure:', '# 1. Save `diff all` before you paste this. In the Presets tab, click "Save Differential Backup (diff all)". Keep the file.',
        '# 2. Read each change below. Remove the commands of a change that you do not want.',
        '# 3. In the CLI tab, click "Load from file" and select this file. Examine the commands, then click "Execute". You can also paste the commands.',
        '# 4. If the CLI shows an error, `save` does not save the changes (`batch start`). Correct the error, then do step 3 again.',
        '# 5. After `save`, the flight controller starts again. If possible, fly the changes one at a time.', '#'];
    const meta1 = [['Craft name', m.craft], ['Log file', m.file], ['Logs', Array.isArray(m.logs) ? and(m.logs.map(String)) : m.logs], ['Flights', m.flights], ['Firmware', m.firmware],
        ['PID profiles in the analysis', profiles.length ? and(profiles.map(p => num(p) > 0 ? `PID profile ${p}` : 'PID profile unknown')) : null], ['Date', m.date]];
    // log-derived names (craft, file, firmware) are quoted text: the pilot or the log wrote them
    const quoted = new Set(['Craft name', 'Log file', 'Firmware']);
    // a value of more than 6 sentences (STE Rule 6.6: a paragraph) or 240 characters, as the flights of a file with many logs
    // ("Log 1: Bench run (no analysis). Log 2: ..."), gets lines of its own under its name: one sentence on each line
    for (const [k, v] of meta1) if (v !== undefined && v !== null && String(v) !== '') {
        const val = quoted.has(k) ? `"${clean(v).replace(/"/g, "'")}"` : clean(v), lines = commentLines(val, true);
        if (`# ${k}: ${val}`.length <= 240 && lines.length <= 6) out.push(`# ${k}: ${val}`); else out.push(`# ${k}:`, ...lines);
    }
    out.push('#');
    ok.forEach(({ r, plan }, i) => {
        out.push(...commentLines(`Change ${i + 1} of ${ok.length}: ${r.title}`), `#   Recommendation \`${clean(r.id).replace(/`/g, "'")}\`.`);
        if (plan.scope === 'profile') out.push(`#   ${prof(plan.index + 1)}, CLI \`profile ${plan.index}\`.`);
        else if (plan.scope === 'rateprofile') out.push(`#   Rate profile ${plan.index + 1}, CLI \`rateprofile ${plan.index}\`.`);
        else out.push('#   Global value (all PID profiles).');
        // values that are possibly not current (CLAUDE.md, user 2026-10-06): the change stays selected, and the file gives the flag
        // (js/tuning_worker.js r.stale) here and in a comment line before its commands
        if (staleOf(r)) out.push('#   Values possibly different.', ...commentLines(staleOf(r).text, true));
        // the previous value of each name (SPEC2 C6): fromSets of the recommendation, else its from-value for its parameter
        const prevOf = (k) => r.fromSets && r.fromSets[k] !== undefined && r.fromSets[k] !== null ? r.fromSets[k] : r.parameter === k && r.from !== null && r.from !== undefined ? r.from : null;
        for (const [n, on] of plan.features || []) { const prev = prevOf(`feature ${n}`); out.push(`#   \`feature ${n}\`: ${on ? 'on' : 'off'}${prev === null ? '. The previous value is unknown.' : ` (it is ${prev === true || prev === 'on' ? 'on' : 'off'} at this time).`}`); }
        for (const [k, v] of plan.sets) { const prev = prevOf(k), from = r.fromSources && r.fromSources[k] ? r.fromSources[k] : r.fromSource;
            out.push(prev !== null ? `#   \`${k}\`: from ${clean(prev)} to ${v}${from ? ` (the value at this time is from the ${clean(from).replace(/^the /, '')})` : ''}.` : `#   \`${k}\`: set to ${v}. The previous value is unknown.`); }
        const ev = Array.isArray(r.evidence) ? r.evidence : [];
        for (const e of ev.slice(0, 3)) out.push(...evidenceLines(e, base));
        if (ev.length > 3) out.push(`#   The recommendation has ${ev.length - 3} more results.`);
        if (r.rule) out.push(...commentLines(`Rule: ${r.rule}`, true));
        out.push('#');
    });
    for (const { r, plan } of bad) out.push(...commentLines(`Not in the file: ${r.title} (\`${clean(r.id).replace(/`/g, "'")}\`). ${plan.why}`));
    if (!ok.length) { out.push('# This file has no commands. No change that you selected has CLI text that the app can write.'); return out.join('\n'); }
    if (bad.length) out.push('#');
    out.push('batch start');
    const numberOf = new Map(ok.map((x, i) => [x, i + 1]));
    for (const scope of ['profile', 'rateprofile', 'global']) {
        const sel = ok.filter(x => x.plan.scope === scope), idx = [...new Set(sel.map(x => x.plan.index))].sort((a, b) => a - b);
        for (const n of idx) {
            out.push(scope === 'profile' ? `# ${prof(n + 1)}` : scope === 'rateprofile' ? `# Rate profile ${n + 1}` : '# Global values');
            if (scope !== 'global') out.push(`${scope} ${n}`);
            // lineOf: the line of each command; first: the first command line of each change (its own, or the same command of an
            // earlier change), where the flag of a change with values that are possibly not current goes
            const done = new Set(), lineOf = new Map(), first = new Map(), mine = sel.filter(y => y.plan.index === n);
            const put = (x, key, line) => { if (!done.has(key)) { done.add(key); lineOf.set(key, out.length); out.push(line); }
                first.set(x, Math.min(first.has(x) ? first.get(x) : Infinity, lineOf.get(key))); };
            for (const x of mine) for (const [f, on] of x.plan.features || []) put(x, `feature ${f}`, `feature ${on ? '' : '-'}${f}`);
            for (const x of mine) for (const [k, v] of x.plan.sets) put(x, k, `set ${k} = ${v}`);
            // from the last line up, so that each index stays correct; a later change first on the same line
            const withFlag = mine.filter(x => staleOf(x.r) && first.has(x)).sort((a, b) => first.get(b) - first.get(a) || numberOf.get(b) - numberOf.get(a));
            for (const x of withFlag) out.splice(first.get(x), 0, ...commentLines(`Change ${numberOf.get(x)} uses values that are possibly not the values of the log header. ` +
                `Before you use these commands, read change ${numberOf.get(x)} above.`));
        }
    }
    // `profile N` and `rateprofile N` change the selection that `save` keeps (cli.c changePidProfile): put it back
    const usedP = ok.some(x => x.plan.scope === 'profile'), usedR = ok.some(x => x.plan.scope === 'rateprofile');
    const ap = num(m.activeProfile), ar = num(m.activeRateProfile);
    if (usedP) { if (ap !== null && Number.isInteger(ap) && ap >= 0 && ap < RULES.pidProfiles) out.push(`# Select ${prof(ap + 1)} again, as before the changes.`, `profile ${ap}`);
        else out.push(...commentLines(`After \`save\`, the flight controller uses ${prof(ok.filter(x => x.plan.scope === 'profile').map(x => x.plan.index).sort((a, b) => a - b).pop() + 1)}. If you use a different PID profile, select it again.`)); }
    if (usedR) { if (ar !== null && Number.isInteger(ar) && ar >= 0 && ar < RULES.rateProfiles) out.push(`# Select rate profile ${ar + 1} again, as before the changes.`, `rateprofile ${ar}`);
        else out.push('# After `save`, the flight controller uses the last rate profile of this file. If you use a different rate profile, select it again.'); }
    return out.concat('save').join('\n');
}
// the CLI file with the default picks and no meta, or '' when no recommendation has CLI text (TuningResult advice.script)
function script(recommendations) { return defaultPicks(recommendations).length ? exportScript(recommendations, null, {}) : ''; }

module.exports = { RULES, PARAMS, RANGE, COVERAGE, CHECKS: Object.keys(GEN), DS_RULES, FEATURE_NAMES, advise, comparisons, filterRecommendations, script, exportScript, defaultPicks, floorsOk };
