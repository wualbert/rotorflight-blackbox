'use strict';

/**
 * One entry for each check id: the words the app uses for it (ASD-STE100, docs/STE_GLOSSARY.md), its display unit and
 * scale, its step in the tuning order (hierarchy.cjs), the Tuning view tab, the evidence spec (what part of the log shows
 * it and how to plot it against its limit) and a summary template.
 *
 *   summary(f)   1 to 3 STE sentences for a finding, from its fields only (value, se, n, profile, axis, threshold); the
 *                facts that evidence.cjs found in the metrics (f.evidence.facts: notch axis and frequency, ...) when present
 *   display(f)   what the views show of a finding (review V5, V6): { value: the quantity that the rule compares, with its
 *                SE, unit and meaning (never a bare count), or null; unit, scale; limit: the STE limit sentence; bound: the
 *                limit in the unit of value ("1 V in 10 ms", "±15 %"), or null; profile, phase }. The same in
 *                the scope of one log and of the file: it reads the finding and its evidence facts, never the curves
 *   status(f)    'problem' | 'monitor' | 'information' | 'insufficient' | 'satisfactory' | 'notMeasured' | 'error' (SPEC2 D9)
 *   unitOf(f), nodeOf(f), format(f), profileOf(f), profileLabel(p), benchOf(f) (a D7 finding of a bench run)
 *   LABELS       the STE status words of findings and of the steps of hierarchy.cjs
 *   CHECKS[id]   { id, noun, unit, scale, node (or node(axis, f)), tab, module, phases, evidence, template, ... }
 *
 * Check ids: section 10 of TUNING_KNOWLEDGE.md (D1-D6, H, SETUP, F1-F11, G0-G14, C1-C14, T1-T14, R1), the gain decisions
 * of report.cjs (C7) and health_phase.cjs (D7, G15-G18, C15: the unit of the finding chooses the sentence).
 *
 * Limits come from the finding's threshold (a RULES object or a number) over the modules' DEFAULT_RULES; a threshold
 * that is only a string is quoted as it is. Fractions show as % (scale 100). The modules' own text is not STE and is
 * not read here (SPEC2 D5, D6), except the key and values of an H finding, which name a header field.
 *
 * Profiles (SPEC2 D12): a finding's profile is the log profile, 1-based; 0 or 'arm' is the profile before the first
 * switch when the arming profile is not known ("PID profile unknown"). D4 (CLI index), F4 (an axis) and H (global or
 * the start profile) do not hold a log profile. phases: the flight phases that a check uses (SPEC2 D13 correction).
 * Gear ratios (SPEC2 section 6, GEAR RULE): the configured gear ratios are correct. No text here tells that a gear
 * ratio, a pulley or a tooth count can be incorrect; G12 names the motor pole count or the RPM sensor.
 */

const optional = (name) => { try { return require(name); } catch (err) { return null; } }; // a missing module costs its limits only
const H = optional('./hierarchy.cjs');  // without it, no home node (nodeOf null)
const MOD = { setup: optional('./health_setup.cjs'), gov: optional('./health_gov.cjs'), loop: optional('./health_loop.cjs'), track: optional('./health_track.cjs'), more: optional('./health_more.cjs'),
    phase: optional('./health_phase.cjs'), rescue: optional('./health_rescue.cjs'), limits: optional('./health_limits.cjs'), config: optional('./health_config.cjs'), power: optional('./health_power.cjs') };

const LABELS = { ok: 'No problem found', noData: 'No data', problem: 'Problem', blocked: 'Blocked', possible: 'Possible result', startHere: 'Start here', satisfactory: 'Satisfactory', monitor: 'Monitor',
    information: 'Information', insufficient: 'Not sufficient data', notMeasured: 'Not measured', notApplicable: 'Not applicable', notAccurate: 'Not accurate (log rate)', error: 'Analysis error' };
const TABS = ['curves', 'governor', 'filters', 'tail', 'checks'];
const AXES = ['roll', 'pitch', 'yaw'];

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

const num = (v) => typeof v === 'number' && isFinite(v) ? v : null;
const places = (v) => { const a = Math.abs(v); return a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : a >= 0.1 ? 3 : 4; };
function fmt(v, d) { if (num(v) === null) return null; const s = String(+v.toFixed(d === undefined ? places(v) : d)); return s === '-0' ? '0' : s.replace('-', '−'); }
const withUnit = (s, unit) => s === null ? null : unit ? `${s} ${unit}` : s;
// value ± se in one number token: the decimals of the value; a value of 0 takes those of the SE
function pair(v, se, unit, d) {
    if (num(v) === null) return null;
    const s = num(se) !== null ? Math.abs(se) : null, need = s && s < 1 ? Math.min(6, Math.ceil(-Math.log10(s))) : 0; // the SE keeps one significant digit
    const dd = d !== undefined ? d : Math.max(places(v !== 0 ? v : s || 0), need);
    return withUnit(num(se) !== null ? `${fmt(v, dd)} ± ${fmt(Math.abs(se), dd)}` : fmt(v, dd), unit);
}
const many = (k, word) => `${fmt(num(k) === null ? 0 : k)} ${word}${k === 1 ? '' : 's'}`;
const isThin = (f) => !!f && f.severity === 'note' && (f.thin === true || /^no finding/i.test(String(f.text || '')));
const logLabel = (l) => typeof l === 'number' ? `log ${l + 1}` : null;           // the viewer counts logs from 1
// the PID profile of a finding: the worker's pidProfile (1-6, its resolved profile) first, as hierarchy.cjs profileKey and
// js/tuning_dialog.js profileNo; else the log profile 1-6, 0 when it is not known (0, 'arm', 'unknown'), null when the
// finding has none
const NO_LOG_PROFILE = new Set(['D4', 'F4', 'H']);
function profileOf(f) {
    if (f && Number.isInteger(f.pidProfile) && f.pidProfile >= 1 && f.pidProfile <= 6) return f.pidProfile;
    if (!f || NO_LOG_PROFILE.has(f.id)) return null;
    const p = f.profile, q = typeof p === 'string' && /^\d+$/.test(p) ? +p : p;
    if (typeof q === 'number' && isFinite(q)) return q > 0 ? q : 0;
    return p === 'arm' || p === 'unknown' ? 0 : null;
}
const profileLabel = (q) => q === null ? null : q > 0 ? `PID profile ${q}` : 'PID profile unknown'; // as the Configurator counts them (SPEC2 D12)
const profileIn = (q) => q === null ? '' : q > 0 ? `In PID profile ${q}, ` : 'In an unknown PID profile, ';
const axisOf = (f) => f.axis || (f.id === 'F4' && AXES.includes(f.profile) ? f.profile : /^T\d/.test(String(f.id)) ? 'yaw' : null); // hierarchy.cjs axisOf

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

// the judge rule of check id: its module's DEFAULT_RULES entry, with the finding's threshold object over it
function rulesOf(f, c) {
    const M = c && MOD[c.module], base = M && M.DEFAULT_RULES && M.DEFAULT_RULES[f.id] ? M.DEFAULT_RULES[f.id] : {};
    return Object.assign({}, base, f.threshold && typeof f.threshold === 'object' ? f.threshold : {});
}
const pc = (x) => num(x) === null ? null : fmt(x * 100);
// a limit value: a number, or the string of fmt() (pc gives one); null, undefined and text are no value
const lim = (x) => typeof x === 'number' ? num(x) : typeof x === 'string' && /^[−-]?\d/.test(x) ? num(+x.replace('−', '-')) : null;
// the 2-SE rule in plain words (SPEC3 F): in display.limit (the details), not in the summary
const SE_NOTE = 'A result counts only when it is more than the limit by 2 standard errors (SE).';
const T = {
    sigma: (x, unit) => lim(x) === null ? null : `The limit is ${withUnit(fmt(lim(x)), unit)}. ${SE_NOTE}`,
    plain: (x, unit) => lim(x) === null ? null : `The limit is ${withUnit(fmt(lim(x)), unit)}.`,
    min: (x, unit) => lim(x) === null ? null : `The minimum is ${withUnit(fmt(lim(x)), unit)}.`,
    max: (x, unit) => lim(x) === null ? null : `The maximum is ${withUnit(fmt(lim(x)), unit)}.`,
    two: (flag, note, unit) => lim(flag) === null ? null : `The limit is ${withUnit(fmt(lim(flag)), unit)}.` + (lim(note) === null ? '' : ` At more than ${withUnit(fmt(lim(note)), unit)}, the result is "Monitor".`) + ` ${SE_NOTE}`,
    report: () => 'This check gives information only. It has no limit.',
};
// a threshold the catalog cannot read: quoted as it is (STE rule 8.6: quoted text)
const quoted = (f) => typeof f.threshold === 'string' && f.threshold.trim() ? `The limit is "${f.threshold.trim().replace(/"/g, "'")}".` : null;
// the limit in the unit of the value (display.bound, review V6), from the first sentence of an STE limit of T: "The limit is
// 1 V in 10 ms." -> "1 V in 10 ms". A limit of another form gives null (a check with its own bound gives it)
function boundOf(limit) {
    if (typeof limit !== 'string' || !limit) return null;
    const first = limit.split(/(?<=\.)\s+(?=[A-Z])/)[0]; let m;
    if ((m = /^The (?:limit|limits) (?:for the [\w-]+ )?(?:is|are) (.+?)\.$/.exec(first))) return /^"/.test(m[1]) ? null : m[1];
    if ((m = /^The minimum is (.+?)\.$/.exec(first))) return `${m[1]} or more`;
    if ((m = /^The maximum is (.+?)\.$/.exec(first))) return `${m[1]} or less`;
    if ((m = /^The (?:tolerance|firmware range) is (.+?)\.$/.exec(first))) return m[1];
    return null;
}

// ---------------------------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------------------------

const CHECKS = {};
const X = (id, o) => { CHECKS[id] = o; };
const ax = (v) => v.axis || 'the';
const G = { sp: 'setpoint[{a}]', gy: 'gyroADC[{a}]', raw: 'gyroRAW[{a}]', mix: 'mixer[{a}]', P: 'axisP[{a}]', I: 'axisI[{a}]', D: 'axisD[{a}]', F: 'axisF[{a}]', err: 'axisError[{a}]' };
const ev = (source, fields, plot, o) => Object.assign({ source, pads: [0, 0], fields, analyser: null, plot, expected: () => null }, o || {});

// --- data validity and setup (health_setup.cjs) ---
X('D1', { noun: 'log rate', unit: 'Hz', scale: 1, tab: 'checks', module: 'setup', report: false,
    say: (f, v) => `The log rate is ${v.value}.`,
    limit: (f, v, R) => T.min(R.minHz, 'Hz'),
    evidence: ev('header', [], { kind: 'table', keys: ['looptime', 'pid_process_denom', 'frameIntervalPNum', 'frameIntervalPDenom'] }, { expected: () => 'The log rate is 1000 Hz or more.' }) });
// D2: a clearly measurable issue of the log (SPEC3 A) is a loss of D2_LOSS of the frames or more (the frames that its time jumps
// lose, health_setup D2 events 'time jump' value). A loop stall loses no frame: information. A time jump with less loss: monitor
const D2_LOSS = 0.01, D2_SOURCE = 'toolkit rule, no flight test: with 1 % of the frames lost, the spectra and the times of the events are not accurate';
const lostOf = (f) => (Array.isArray(f.events) ? f.events : []).filter(e => e && /^time jump/.test(String(e.kind || '')) && num(e.value) !== null).reduce((s, e) => s + e.value, 0);
const lossShare = (f) => num(f.n) > 0 ? lostOf(f) / f.n : null;
X('D2', { noun: 'frame time errors', unit: '', scale: 1, tab: 'checks', module: 'setup', note: 'information', lossLimit: D2_LOSS, lossSource: D2_SOURCE,
    statusOf: (f) => f.severity !== 'flag' ? null : lossShare(f) !== null && lossShare(f) >= D2_LOSS ? 'problem' : lostOf(f) > 0 ? 'monitor' : 'information',
    after: (f) => f.severity === 'flag' && lossShare(f) !== null && lostOf(f) > 0 ? `At the time jumps, ${fmt(lostOf(f))} of ${fmt(f.n)} frames are missing (${fmt(100 * lossShare(f), 2)} %).` : null,
    say: (f, v, x) => { const c = x.counts || gapCounts(f.events); return c ? `The log has ${many(c.jumps, 'sudden time change')}, ${many(c.stalls, 'loop stall')} and ${many(c.back, 'frame')} with a time that does not increase.` : `The log has ${many(f.value, 'sudden time change')}.`; },
    limit: () => `The limit is ${fmt(D2_LOSS * 100)} % of the frames missing. A loop stall is information, and a smaller number of missing frames is a value to monitor.`, bound: () => `${fmt(D2_LOSS * 100)} % of the frames missing`,
    value: (f, v, x) => { const c = x.counts || gapCounts(f.events); if (!c) return num(f.value) === null ? null : many(f.value, 'sudden time change');
        const parts = [[c.jumps, 'sudden time change'], [c.stalls, 'loop stall'], [c.back, 'frame with a time that does not increase', 'frames with a time that does not increase'], [c.iterations, 'change of the loop count', 'changes of the loop count']].filter(q => q[0] > 0);
        return parts.length ? andList(parts.map(([k, one1, more]) => `${fmt(k)} ${k === 1 ? one1 : more || `${one1}s`}`)) : '0 frame time errors'; },
    evidence: ev('events', [['loopIteration'], ['gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]'], ['motor[0]']], { kind: 'events' }, { pads: [0.25, 0.25], expected: () => 'The frame interval stays at its usual value.' }) });
X('D3', { noun: 'recorded fields', unit: '', scale: 1, tab: 'checks', module: 'setup', note: 'information',
    say: (f, v) => f.severity === 'ok' ? 'The log records the fields of all checks.' : `The log does not record the fields of ${v.val} groups of checks. These checks did not operate.`,
    limit: () => null, value: (f, v) => v.val === null ? null : `${many(f.value, 'group')} of checks that did not operate`,
    evidence: ev('header', [], { kind: 'table' }, { expected: () => 'The log records all fields that the checks use.' }) });
X('D4', { noun: 'CLI dump values', unit: '', scale: 1, tab: 'checks', module: 'setup', report: false,
    say: (f, v) => f.severity === 'ok' ? `All ${v.n} values in the log header agree with the CLI dump.` : `${v.val} of ${v.n} values in the log header are different from the CLI dump.`,
    // health_setup gives no D4 result without a CLI dump (the dump is an optional input, user rule 2026-10-06)
    skipped: () => 'This check did not operate on this log. The toolkit text gives the cause.',
    limit: () => 'The limit is 0.', value: (f, v) => v.val === null ? null : `${v.val} of ${v.n === null ? 'the' : v.n} values are different`,
    evidence: ev('header', [], { kind: 'table' }, { expected: () => 'The log header and the CLI dump have the same values.' }) });
X('F1', { noun: 'gyro low-pass filter', unit: '', scale: 1, tab: 'filters', module: 'setup',
    say: (f, v) => f.severity === 'flag' ? 'The log header shows 0 gyro low-pass filters and 1 or more RPM notch filters.' : f.severity === 'note' ? 'The log header shows 0 gyro low-pass filters.' : `${v.val} gyro low-pass filter${f.value === 1 ? ' is' : 's are'} on.`,
    limit: () => 'One gyro low-pass filter is necessary with the RPM filters.', bound: () => '1 gyro low-pass filter or more with the RPM filters',
    value: (f, v) => v.val === null ? null : many(f.value, 'gyro low-pass filter'),
    evidence: ev('header', [], { kind: 'table', keys: ['gyro_soft_type', 'gyro_lowpass_hz', 'gyro_soft2_type', 'gyro_lowpass2_hz', 'gyro_lowpass_dyn_hz'] }, { expected: () => 'One gyro low-pass filter is on at approximately 100 Hz.' }) });
X('F2', { noun: 'low-pass cutoff', unit: 'Hz', scale: 1, tab: 'filters', module: 'setup',
    say: (f, v) => `The lowest gyro low-pass filter cutoff is ${v.value}.`,
    limit: (f, v, R) => num(R.flagHz) === null ? null : `The minimum is ${R.flagHz} Hz.` + (num(R.noteHz) !== null ? ` At less than ${R.noteHz} Hz, the result is "Monitor".` : ''),
    evidence: ev('header', [], { kind: 'table', keys: ['gyro_soft_type', 'gyro_lowpass_hz', 'gyro_soft2_type', 'gyro_lowpass2_hz', 'gyro_lowpass_dyn_hz'] }, { expected: () => 'The lowest gyro cutoff is 80 Hz or more.' }) });
X('F3', { noun: 'notch filter Q', unit: '', scale: 1, tab: 'filters', module: 'setup',
    say: (f, v) => f.severity === 'note' ? 'The log header has no RPM notch filter.' : `The lowest Q of the ${v.n} RPM notch filters is ${v.val}.`,
    limit: (f, v, R) => T.min(R.minQ, ''), value: (f, v) => v.val === null ? null : `Q ${v.val}`,
    evidence: ev('header', [], { kind: 'table', keys: ['gyro_rpm_notch_q_roll', 'gyro_rpm_notch_q_pitch', 'gyro_rpm_notch_q_yaw', 'dyn_notch_q'] }, { expected: () => 'The Q of each notch filter is 2 or more.' }) });
X('F4', { noun: 'D-term cutoff', unit: 'Hz', scale: 1, tab: 'filters', module: 'setup',
    say: (f, v) => `The ${ax(v)} D-term cutoff is ${v.value}.`,
    limit: (f, v, R) => num(R.targetHz) === null ? null : `The documentation recommends approximately ${R.targetHz} Hz (±${R.toleranceHz} Hz).`,
    bound: (f, v, R) => num(R.targetHz) === null ? null : `approximately ${R.targetHz} Hz (±${R.toleranceHz} Hz)`,
    evidence: ev('header', [], { kind: 'table', keys: ['rollBW', 'pitchBW', 'yawBW'] }, { expected: () => 'The D-term cutoff is approximately 20 Hz.' }) });
X('F5', { noun: 'notch filter position', unit: 'x', scale: 1, tab: 'filters', module: 'setup', nOf: 'periods of 256 rotor turns', min: (R) => R.minWindows,
    say: (f, v, x) => f.severity === 'flag' ? `${v.In}the raw gyro has a peak at ${v.value} the rotor frequency${x.hz ? ` (${fmt(x.hz)} Hz)` : ''}${num(x.prominence) !== null ? `, ${fmt(x.prominence)} x the median level` : ''}. ${notchAxes(x)}` : `${v.In}each strong peak of the raw gyro has a notch filter near it.`,
    // review V5: a description of the rule, not an instruction (an Information row is no problem), and the rule's quantities
    limit: (f, v, R) => num(R.minProminence) === null ? null : `A peak of ${R.minProminence} x the median level or more with no notch filter in ±${fmt(R.maxDistance * 100)} % of its frequency is a problem.`,
    bound: (f, v, R) => num(R.minProminence) === null ? null : `${R.minProminence} x the median level or more, with no notch filter in ±${fmt(R.maxDistance * 100)} %`,
    value: (f, v, x) => { if (f.severity !== 'flag') return null; const far = Array.isArray(x.axes) ? x.axes.filter(q => q && !q.near && num(q.distance) !== null).sort((a, b) => a.distance - b.distance)[0] : null;
        const at = v.value === null ? '' : ` at ${v.value} the rotor frequency`;
        return num(x.prominence) !== null ? `${fmt(x.prominence)} x the median level${at}${far ? `, ${fmt(far.distance * 100)} % from the nearest ${far.axis} notch filter` : ''}` : v.value === null ? null : `peak${at}`; },
    after: (f, v, x) => f.explained ? passText(f, x) : null,
    evidence: ev('windows', [['gyroRAW[{a}]', 'gyroADC[{a}]'], ['headspeed']], { kind: 'spectrum', curve: 'more.vib' }, { analyser: 'gyroRAW[{a}]', expected: () => 'A notch filter decreases each strong rotor peak of the raw gyro by 10 dB or more.' }) });
X('F6', { noun: 'notch filter effect', unit: 'dB', scale: 1, tab: 'filters', module: 'setup', nOf: 'periods for this notch filter', min: (R) => R.minWindows,
    say: (f, v, x) => `${v.In}${x.axis ? `the ${x.axis} notch filter${x.hz ? ` at ${fmt(x.hz)} Hz` : ''}` : 'an RPM notch filter'} decreases its peak by ${v.value}.`,
    limit: (f, v, R) => T.min(R.minDb, 'dB'),
    evidence: ev('windows', [['gyroRAW[{a}]', 'gyroADC[{a}]'], ['headspeed']], { kind: 'events', curve: 'more.vib' }, { analyser: 'gyroRAW[{a}]', expected: () => 'The notch filter decreases its peak by 10 dB or more.' }) });
X('F7', { noun: 'vibration level', unit: '', scale: 1, tab: 'filters', module: null, run: false, say: () => 'This check does not operate in the app.', limit: () => null, value: () => null,
    evidence: ev('flight', [['gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]']], { kind: 'spectrum', curve: 'more.vib' }, { analyser: 'gyroRAW[0]', expected: () => 'The raw gyro has no strong vibration.' }) });
X('F8', { noun: 'dynamic notch filter', unit: '', scale: 1, tab: 'filters', module: 'setup',
    say: (f) => f.severity === 'note' && f.value === true ? 'The PID loop rate is less than 1000 Hz. Thus, the firmware disables the dynamic notch filter.'
        : f.severity === 'note' ? 'The dynamic notch filter is off, and some strong peaks have no RPM notch filter (F5).' : `The dynamic notch filter is ${f.value === true ? 'on' : 'off'}.`,
    limit: () => null, value: (f) => f.value === true ? 'on' : f.value === false ? 'off' : null,
    evidence: ev('header', [], { kind: 'table', keys: ['features', 'dyn_notch_count', 'dyn_notch_q', 'dyn_notch_min_hz', 'dyn_notch_max_hz'] }, { expected: () => 'Each strong peak has an RPM notch filter or a dynamic notch filter.' }) });
X('F9', { noun: 'notch filter frequency', unit: '', scale: 1, tab: 'filters', module: 'setup',
    say: (f, v) => num(f.value) > 0 ? `${v.val} of ${v.n} notch filter frequencies are more than the Nyquist frequency or the firmware limit.`
        : f.severity === 'note' ? 'The log header does not give the gear ratios. Thus, the frequency of some notch filters is unknown.' : `All ${v.n} notch filter frequencies are less than the Nyquist frequency and the firmware limit.`,
    limit: () => null, value: (f, v) => v.val === null ? null : `${v.val} of ${v.n === null ? 'the' : v.n} notch filters`,
    evidence: ev('header', [], { kind: 'table', keys: ['looptime', 'gyro_rpm_notch_source_roll', 'gyro_rpm_notch_source_pitch', 'gyro_rpm_notch_source_yaw'] }, { expected: () => 'All notch filter frequencies are less than the Nyquist frequency.' }) });
X('H', { noun: 'header changes', unit: '', scale: 1, tab: 'checks', module: 'setup', note: 'information',
    say: (f, v, x) => { const h = headerChange(f); return h ? `The header value \`${h.key}\` changes from \`${h.from}\` to \`${h.to}\`${h.since !== null ? ` after log ${h.since + 1}` : ''}.` : 'A header value changes between two logs.'; },
    limit: () => null, value: (f) => { const h = headerChange(f); return h ? `\`${h.key}\` = \`${h.to}\`` : null; },
    evidence: ev('header', [], { kind: 'table' }, { expected: () => 'The logs that the analysis uses together have the same header values.' }) });
X('SETUP', { noun: 'header values', unit: '', scale: 1, tab: 'checks', module: 'setup', note: 'information',
    say: () => 'The log header gives the filter, notch filter, gain and governor values of this log.', limit: () => null, value: () => null,
    evidence: ev('header', [], { kind: 'table', keys: ['rollPID', 'pitchPID', 'yawPID', 'rollBW', 'pitchBW', 'yawBW', 'govPID', 'gyro_lowpass_hz', 'rates_type'] }, { expected: () => null }) });

// F5: which axes have a notch filter near the peak (evidence.cjs facts.axes: { axis, near }, near = in ±maxDistance of
// its frequency); without the facts, a sentence that is true for each flag (one axis or more has no notch filter near it)
const andList = (a) => a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a.join('');
function notchAxes(x) {
    const a = Array.isArray(x.axes) ? x.axes.filter(q => q && AXES.includes(q.axis)) : [], far = a.filter(q => !q.near).map(q => q.axis), near = a.filter(q => q.near).map(q => q.axis);
    const has = (l) => `${andList(l)} ${l.length > 1 ? 'axes have' : 'axis has'}`;
    if (!a.length || !far.length) return 'One or more axes have no notch filter near this peak.';
    return near.length ? `The ${has(far)} no notch filter near this peak, but the ${has(near)} one.` : 'No axis has a notch filter near this peak.';
}

// F5 (review V5): what the gyro filters let through of an F5 peak that a recommendation explains (the worker's filterPass at
// the frequency of the peak: gyroRAW to gyroADC)
function passText(f, x) {
    const list = Array.isArray(f.filterPass) ? f.filterPass : [], q = list.find(p => p && num(x.hz) !== null && Math.abs(p.hz - x.hz) < 0.5) || (num(x.hz) === null ? list[0] : null);
    if (!q || !AXES.every(a => num(q[a]) !== null)) return null;
    return `The gyro filters let only ${andList(AXES.map(a => `${fmt(q[a] * 100, 1)} %`))} of this peak through (roll, pitch and yaw). Thus, the analysis gives no notch filter for it.`;
}
// D5: the result is the time at a low cell voltage (evidence.cjs facts kind 'low'), else the largest voltage step
const d5Low = (f, x) => x && x.kind ? x.kind === 'low' : f.severity === 'flag' && /V\/cell/.test(String(f.text || '')) && /\bbelow\b/.test(String(f.text || ''));

// --- governor and power (health_gov.cjs) ---
X('D5', { noun: 'battery voltage', unit: 'V', scale: 1, tab: 'governor', module: 'gov', note: 'information',
    say: (f, v, x) => { const low = d5Low(f, x);
        if (low) return `The battery voltage is less than ${fmt(rulesOf(f, CHECKS.D5).minCell) || 'the minimum'} V for each cell during ${pair(f.value, null, 's')} of flight.`;
        return `The largest step of the battery voltage is ${pair(Math.abs(num(f.value) || 0), null, 'V')} in 10 ms.` + (f.severity === 'note' ? ' The check does not examine the voltage for each cell, because the cell count is not clear.' : ''); },
    limit: (f, v, R, x) => d5Low(f, x) ? T.plain(R.minS, 's') : T.plain(R.step, 'V in 10 ms'),
    unitOf: (f) => d5Low(f, f.evidence && f.evidence.facts) ? 's' : 'V',
    value: (f, v, x) => num(f.value) === null ? null : d5Low(f, x) ? pair(f.value, null, 's') : `${pair(Math.abs(f.value), null, 'V')} in 10 ms`,
    evidence: ev('events', [['Vbat'], ['motor[0]'], ['headspeed']], { kind: 'time', snippet: { fields: ['Vbat'] } }, { pads: [1, 1], expected: () => 'The battery voltage decreases slowly, with no sudden steps.' }) });
X('G13', { noun: 'cell voltage', unit: 'V', scale: 1, tab: 'governor', module: 'gov', thinSay: () => 'The cell count is not clear. Thus, the check does not examine the voltage for each cell.',
    say: (f, v) => `In flight, 1 % of the battery voltage samples are less than ${v.value} for each cell.`,
    limit: (f, v, R) => T.min(num(f.threshold) !== null ? f.threshold : R.minCell, 'V'),
    evidence: ev('flight', [['Vbat'], ['motor[0]']], { kind: 'time', snippet: { fields: ['Vbat'] } }, { expected: () => 'The voltage for each cell stays at 3.3 V or more in flight.' }) });
X('G0', { noun: 'governor mode', unit: '', scale: 1, tab: 'governor', module: 'gov', note: 'information',
    say: (f, v) => f.severity === 'note' ? 'The governor output is zero in all flight samples. Thus, the governor mode is DIRECT or LIMIT.' : `The governor output is not zero in ${v.val} of ${v.n} flight samples. Thus, a PID governor operates.`,
    limit: () => null, value: (f, v) => v.val === null ? null : `${v.val} of ${v.n === null ? 'the' : v.n} flight samples with a governor output`,
    evidence: ev('flight', [['govSum', 'govI'], ['headspeed', 'govTarget'], ['motor[0]']], { kind: 'governor', curve: 'more.gov' }, { expected: () => null }) });
X('G1', { noun: 'RPM signal', unit: '', scale: 1, tab: 'governor', module: 'gov',
    say: (f, v) => f.severity === 'flag' ? `The governor changes to FALLBACK ${v.val} ${f.value === 1 ? 'time' : 'times'}.` : num(f.value) > 0 ? `The headspeed signal shows ${many(f.value, 'possible error')} in flight.`
        : f.severity === 'note' ? 'The headspeed signal shows no errors in flight. The log has no log events for the governor. Thus, the check cannot find a FALLBACK.' : 'The governor does not change to FALLBACK, and the headspeed signal shows no errors in flight.',
    limit: (f) => f.severity === 'flag' ? 'The limit is 0.' : null,
    value: (f, v) => v.val === null ? null : f.severity === 'flag' ? `${v.val} ${f.value === 1 ? 'change' : 'changes'} to FALLBACK` : many(f.value, 'possible error'),
    evidence: ev('events', [['headspeed', 'govTarget'], ['motor[0]']], { kind: 'governor', curve: 'more.gov' }, { pads: [1, 2], expected: () => 'The headspeed signal is smooth, and the governor stays in ACTIVE.' }) });
X('G2', { noun: 'headspeed error', unit: '%', scale: 100, tab: 'governor', module: 'gov', nOf: 'samples of stable governor flight', minText: (R) => num(R.minS) === null ? null : `A minimum of ${R.minS} s is necessary.`,
    say: (f, v) => `${v.In}the median headspeed error in stable flight is ${v.value} of the target.`,
    limit: (f, v, R) => num(R.median) === null ? null : `The limit is ${pc(R.median)} %. Also, 90 % of the samples must be in ±${pc(R.band)} % of the target. ${SE_NOTE}`,
    evidence: ev('blocks', [['headspeed', 'govTarget'], ['setpoint[3]']], { kind: 'governor', curve: 'more.gov' }, { expected: () => 'The headspeed stays at the target in stable flight.' }) });
X('G3', { noun: 'headspeed decrease', unit: '%', scale: 100, tab: 'governor', module: 'gov', nOf: 'large collective increases', min: (R) => R.minEvents,
    say: (f, v) => `${v.In}the headspeed decreases by ${v.value} when the collective increases.`, // health_gov G3: value is the decrease (droop), positive
    limit: (f, v, R) => T.two(pc(R.flag), pc(R.good), '%'),
    evidence: ev('events', [['headspeed', 'govTarget'], ['setpoint[3]'], ['govF', 'govSum', 'motor[0]']], { kind: 'governor', curve: 'more.gov' }, { pads: [0.3, 1], expected: () => 'The headspeed stays near the target when the collective increases.' }) });
X('G4', { noun: 'headspeed overshoot', unit: '%', scale: 100, tab: 'governor', module: 'gov', nOf: 'large collective decreases', min: (R) => R.minEvents,
    say: (f, v) => `${v.In}the headspeed is ${v.value} more than the target after a collective change.`,
    limit: (f, v, R) => T.sigma(pc(R.flag), '%'),
    evidence: ev('events', [['headspeed', 'govTarget'], ['setpoint[3]'], ['govF', 'govSum', 'motor[0]']], { kind: 'governor', curve: 'more.gov' }, { pads: [0.3, 1.3], expected: () => 'The headspeed does not go more than the target after a collective change.' }) });
X('G5', { noun: 'time to target', unit: 's', scale: 1, tab: 'governor', module: 'gov',
    say: (f, v) => `${v.In}after a collective increase, the headspeed error decreases to 1 % or less in ${v.value}.`,
    limit: (f, v, R) => T.sigma(num(f.threshold) !== null ? f.threshold : R.flag, 's'),
    evidence: ev('events', [['headspeed', 'govTarget'], ['setpoint[3]'], ['govSum', 'motor[0]']], { kind: 'governor', curve: 'more.gov' }, { pads: [0.3, 0.5], expected: () => 'The headspeed is at the target again in 0.5 s or less.' }) });
X('G6', { noun: 'throttle reserve', unit: '%', scale: 1, tab: 'governor', module: 'gov',
    say: (f, v, x) => `${v.In}the median throttle is ${v.value}` + (x.runs ? `, and the throttle stays at its limit in ${many(x.runs, 'period')} of ${fmt(rulesOf(f, CHECKS.G6).runS) || 0.1} s or more.` : '.'),
    limit: (f, v, R) => num(R.median) === null ? null : `The limit is ${R.median} %. A period of ${R.runS} s or more at the throttle limit, with the headspeed ${pc(R.deficit)} % less than the target, is also a problem.`,
    evidence: ev('runs', [['motor[0]', 'govSum'], ['headspeed', 'govTarget'], ['setpoint[3]']], { kind: 'governor', curve: 'more.gov' }, { pads: [0.5, 0.5], expected: () => 'The throttle stays at 85 % or less and does not stay at its limit.' }) });
X('G7', { noun: 'governor output', unit: '%', scale: 100, tab: 'governor', module: 'gov', note: 'information',
    say: (f, v) => `${v.In}at the throttle limit, the governor output is ${v.value} more than the motor output.`, limit: () => T.report(),
    evidence: ev('runs', [['motor[0]', 'govSum'], ['headspeed', 'govTarget']], { kind: 'governor', curve: 'more.gov' }, { pads: [0.5, 0.5], expected: () => null }) });
X('G8', { noun: 'voltage compensation', unit: '', scale: 1, tab: 'governor', module: 'gov', note: 'information', nOf: 'samples with no throttle limit', min: (R) => R.minN,
    say: (f, v) => `The ratio of the motor output to the governor output is ${v.val}.` + (f.severity === 'flag' ? '' : num(f.value) !== null && Math.abs(f.value - 1) <= 0.002 ? ' Thus, the voltage compensation is off.' : ' Thus, the voltage compensation is on.'),
    limit: (f, v, R) => Array.isArray(R.bounds) ? `The firmware range is ${R.bounds[0]} to ${R.bounds[1]}.` : null, value: (f, v) => v.value === null ? null : `ratio ${v.value}`,
    after: (f) => f.severity === 'flag' ? 'The ratio is not in this range.' : null,
    evidence: ev('flight', [['motor[0]', 'govSum'], ['Vbat']], { kind: 'scatter', snippet: { fields: ['motor[0]', 'govSum', 'Vbat'] } }, { expected: () => 'The ratio stays in the range 0.8 to 1.2.' }) });
X('G9', { noun: 'governor oscillation', unit: 'x', scale: 1, tab: 'governor', module: 'gov', nOf: 'periods of 8 s of stable governor flight', min: (R) => R.minWindows,
    say: (f, v, x) => `${v.In}the spectrum of the headspeed error has a peak${x.hz ? ` at ${fmt(x.hz)} Hz` : ''}. The peak is ${v.value} the median level of its band.`,
    limit: (f, v, R) => T.sigma(num(f.threshold) !== null ? f.threshold : R.prominence, 'x'),
    evidence: ev('windows', [['headspeed', 'govTarget'], ['gyroADC[2]'], ['setpoint[3]']], { kind: 'spectrum', snippet: { fields: ['headspeed', 'govTarget', 'gyroADC[2]'], derive: { kind: 'spectrum' } } }, { expected: () => 'The headspeed error has no peak of more than 5 x the median level of its band.' }) });
X('G10', { noun: 'governor tail coherence', unit: '', scale: 1, tab: 'governor', module: 'gov', nOf: 'periods of 2 s of stable governor flight', min: (R) => R.minWindows,
    say: (f, v) => `${v.In}at the tail oscillation peak, the coherence of the headspeed and the yaw rate is ${v.value} (0: not the same oscillation, 1: the same oscillation).`,
    limit: (f, v, R) => num(R.implicated) === null ? null : `The limit is ${R.implicated}. At ${R.implicated} or more, the governor is a possible cause. At ${R.ruledOut} or less, the governor is not the cause. ${SE_NOTE}`,
    bound: (f, v, R) => num(R.implicated) === null ? null : `${R.implicated} or more`, value: (f, v) => v.value === null ? null : `coherence ${v.value}`,
    evidence: ev('events', [['headspeed', 'govTarget'], ['gyroADC[2]', 'setpoint[2]'], ['mixer[2]']], { kind: 'spectrum', snippet: { fields: ['headspeed', 'gyroADC[2]'], derive: { kind: 'spectrum' } } }, { pads: [0.5, 0.5], expected: () => 'The headspeed and the yaw rate do not have the same oscillation.' }) });
X('G11', { noun: 'throttle change', unit: '%', scale: 1, tab: 'governor', module: 'gov', nOf: 'stable periods of 2 s', min: (R) => R.minBlocks,
    say: (f, v) => `At equal collective, the throttle increases by ${v.value} from the start to the end of the flight.`,
    limit: (f, v, R) => T.sigma(num(f.threshold) !== null ? f.threshold : R.perPack, '%'),
    evidence: ev('blocks', [['motor[0]'], ['Vbat'], ['setpoint[3]']], { kind: 'scatter', curve: 'more.gov' }, { expected: () => 'At equal collective, the throttle stays almost constant during the flight.' }) });
// G12 (GEAR RULE): the configured gear ratios are correct, so a main rotor peak away from 1 x is the motor pole count or the RPM sensor
const GEARS_OK = 'The gear ratios in the configuration are correct.';
X('G12', { noun: 'headspeed scale', unit: 'x', scale: 1, tab: 'governor', module: 'gov', thinSay: () => `The main rotor peak is not clear in the spectrum of the raw gyro. ${GEARS_OK}`,
    say: (f, v) => `The main rotor peak is at ${v.value} the rotor frequency that the log records.`,
    limit: (f, v, R) => { const t = num(f.threshold) !== null ? f.threshold : R.tolerance; return num(t) === null ? null : `The tolerance is ±${pc(t)} %. ${SE_NOTE}`; },
    bound: (f, v, R) => { const t = num(f.threshold) !== null ? f.threshold : R.tolerance; return num(t) === null ? null : `${fmt(1 - t, 4)} x to ${fmt(1 + t, 4)} x`; },
    after: (f) => f.severity === 'flag' ? 'Because the gear ratios in the configuration are correct, the cause is the motor pole count or the RPM sensor.' : GEARS_OK,
    evidence: ev('flight', [['gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]'], ['headspeed']], { kind: 'spectrum', curve: 'more.vib' }, { analyser: 'gyroRAW[0]', expected: () => 'The main rotor peak is at 1 x the rotor frequency from the headspeed.' }) });

// --- loops (health_loop.cjs) ---
X('C1', { noun: 'I-term limit', unit: 's', scale: 1, tab: 'checks', module: 'loop',
    say: (f, v) => `${v.In}the ${ax(v)} I-term stays at ${pc(rulesOf(f, CHECKS.C1).level) || 95} % or more of its limit for ${v.value}.`,
    limit: (f, v, R) => T.plain(R.minS, 's'),
    evidence: ev('events', [[G.I], [G.sp, G.gy], [G.mix]], { kind: 'time', snippet: { fields: [G.I] } }, { pads: [0.5, 0.5], expected: () => 'The I-term stays less than 95 % of its limit.' }) });
X('C2', { noun: 'cyclic output limit', unit: 's', scale: 1, tab: 'checks', module: 'loop',
    say: (f, v) => num(f.value) > 0 ? `${v.In}the cyclic output is at a limit for ${v.value} in ${v.n} periods.` : 'The cyclic output does not stay at a limit.',
    limit: () => 'Each period at a limit counts as a problem.', bound: () => '0 s at a limit', value: (f, v) => v.value === null ? null : `${v.value} at a limit`,
    evidence: ev('events', [['mixer[0]', 'mixer[1]'], ['mixer[3]'], ['servo[0]', 'servo[1]', 'servo[2]']], { kind: 'time', snippet: { fields: ['mixer[0]', 'mixer[1]', 'mixer[3]'] } }, { pads: [0.5, 0.5], expected: () => 'The cyclic output does not touch its limits.' }) });
X('C3', { noun: 'cyclic feedforward', unit: '%', scale: 100, tab: 'checks', module: 'loop', nOf: 'stable turns at full stick', min: (R) => R.minEvents,
    say: (f, v) => `${v.In}during stable ${ax(v)} turns at full stick, the I-term is ${v.value} of the feedforward.`,
    limit: (f, v, R) => num(R.iShare) === null ? null : `The limit is ±${pc(R.iShare)} %. Also, the gyro rate must be ${pc(R.gyroRatio[0])} to ${pc(R.gyroRatio[1])} % of the setpoint.`,
    evidence: ev('events', [[G.sp, G.gy], [G.I, G.F], [G.mix]], { kind: 'time', snippet: { fields: [G.sp, G.gy, G.I, G.F] } }, { pads: [0.5, 0.3], expected: () => 'The I-term stays near zero during the turn, and the gyro follows the setpoint.' }) });
X('C4', { noun: 'cyclic stops', unit: '%', scale: 1, tab: 'checks', module: 'loop', nOf: 'stops', min: (R) => R.minEvents,
    say: (f, v) => `${v.In}after ${ax(v)} stops, the overshoot is ${v.value} of the rate before the stop.`,
    limit: (f, v, R) => num(R.overshootPct) === null ? null : `The limits are ${R.overshootPct} % for the overshoot and ${R.settleS} s for the time to become stable.`,
    evidence: ev('events', [[G.sp, G.gy], [G.P, G.I, G.F]], { kind: 'time', snippet: { fields: [G.sp, G.gy] } }, { pads: [0.3, 0.6], expected: () => 'After a stop, the rate goes to zero with an overshoot of less than 10 %.' }) });
X('C6', { noun: 'slow oscillation', unit: 'x', scale: 1, tab: 'curves', module: 'loop', nOf: 'stable periods of 4 s', min: (R) => R.minWindows,
    say: (f, v) => `${v.In}when the sticks do not move, the ${ax(v)} rate has a peak${num(f.hz) !== null ? ` at ${fmt(f.hz)} Hz` : ''}. The peak is ${v.value} the median level of the band.`,
    limit: (f, v, R) => T.plain(R.prominence, 'x'),
    evidence: ev('events', [[G.sp, G.gy], [G.I], [G.mix]], { kind: 'spectrum', curve: 'track.{axis}.spectrum' }, { pads: [0, 4], expected: () => 'At 0.5 to 3 Hz, the rate has no peak of more than 5 x the median level.' }) });
X('C8', { noun: 'cross-coupling', unit: '', scale: 1, tab: 'checks', module: 'loop', note: 'information', nOf: 'periods of 2 s with pitch stick movement', min: (R) => R.minWindows,
    say: (f, v) => `${v.In}when the pitch stick moves, the roll rate changes by ${v.val} deg/s for each deg/s² of pitch stick rate.`, limit: () => T.report(),
    value: (f, v) => v.value === null ? null : `${v.value} deg/s for each deg/s²`,
    evidence: ev('windows', [['setpoint[1]', 'setpoint[0]'], ['gyroADC[0]']], { kind: 'table' }, { expected: () => 'The roll rate does not change when the pitch stick moves.' }) });
X('C9', { noun: 'high speed integral', unit: 'deg/s', scale: 1, tab: 'checks', module: 'loop', note: 'information', nOf: 'periods of 0.5 s on one side of the collective', min: (R) => R.minBlocks,
    say: (f, v) => `${v.In}the pitch error at positive collective is ${v.value} different from the pitch error at negative collective.`, limit: () => T.report(),
    evidence: ev('events', [['setpoint[1]', 'gyroADC[1]'], ['mixer[3]'], ['axisO[1]', 'axisI[1]']], { kind: 'events' }, { pads: [0, 0.5], expected: () => 'The pitch error is the same at positive and at negative collective.' }) });
X('C10', { noun: 'I-term decrease', unit: 's', scale: 1, tab: 'checks', module: 'loop', nOf: 'stable periods of 0.1 s in this collective range', min: (R) => R.minSpans,
    statusOf: (f) => !f.axis && (f.severity === 'flag' || f.severity === 'note') && !isThin(f) ? 'information' : null, // landed at flight speed: slow to become airborne, never a problem (SPEC3 F)
    say: (f, v, x) => !f.axis ? `The rotor turns at flight speed for ${pair(f.value, null, 's')} while the firmware shows that the helicopter is on the ground.`
        : `${v.In}${x.bin ? `at ${x.bin} deg of collective, ` : ''}the ${ax(v)} I-term decreases with a time constant of ${v.value}.`,
    after: (f) => !f.axis && f.severity !== 'ok' ? 'This is not a problem. The helicopter only becomes airborne slowly after the spool-up.' : null,
    limit: (f, v, R) => !f.axis ? null : Array.isArray(R.tau) ? `A time constant of ${R.tau[0]} to ${R.tau[1]} s in flight shows that the firmware possibly does not know that the helicopter is airborne.` : null,
    evidence: ev('runs', [[G.I], [G.sp], ['mixer[3]'], ['headspeed']], { kind: 'time', snippet: { fields: [G.I, 'mixer[3]'] } }, { expected: () => 'In flight, the I-term decreases slowly, with the airborne time constant.' }) });
X('C11', { noun: 'D-term noise', unit: '%', scale: 100, tab: 'filters', module: 'loop', nOf: 'periods of 1 s', min: (R) => R.minWindows,
    say: (f, v) => `${v.In}${v.value} of the ${ax(v)} D-term power is at more than 30 Hz.`,
    limit: (f, v, R) => T.plain(pc(R.share), '%'),
    evidence: ev('windows', [[G.D], [G.gy, G.raw]], { kind: 'spectrum', curve: 'more.dterm.{axis}' }, { analyser: 'axisD[{a}]', expected: () => 'Less than 50 % of the D-term power is at more than 30 Hz.' }) });
X('T2', { noun: 'slow tail oscillation', unit: 'x', scale: 1, tab: 'curves', module: 'loop', nOf: 'stable periods of 4 s', min: (R) => R.minWindows,
    say: (f, v) => `${v.In}when the sticks do not move, the yaw rate has a peak${num(f.hz) !== null ? ` at ${fmt(f.hz)} Hz` : ''}. The peak is ${v.value} the median level of the band.`,
    limit: (f, v, R) => T.plain(R.prominence, 'x'),
    evidence: ev('events', [['setpoint[2]', 'gyroADC[2]'], ['axisI[2]'], ['mixer[2]']], { kind: 'spectrum', curve: 'track.yaw.spectrum' }, { pads: [0, 4], expected: () => 'At 0.5 to 3 Hz, the yaw rate has no peak of more than 5 x the median level.' }) });
X('T4', { noun: 'oscillation and gains', unit: '%', scale: 100, tab: 'tail', module: 'loop', note: 'monitor',
    thinSay: (f, v, R) => `The logs do not have two sets of gains with ${R.minBursts || 5} or more tail oscillations each.`,
    say: (f, v) => `The tail oscillation frequency changes by ${v.value}${f.other ? ` from ${logLabel(f.log) || 'one log'} to ${logLabel(f.other.log) || 'another log'}` : ''}, while the gains change.`,
    limit: (f, v, R) => num(R.hzChange) === null ? null : `If the gains change by more than ${pc(R.gainChange)} %, a frequency change of less than ${pc(R.hzChange)} % shows a possible mechanical cause.`,
    evidence: ev('events', [['gyroADC[2]', 'setpoint[2]'], ['mixer[2]']], { kind: 'events' }, { pads: [0.5, 0.5], expected: () => 'The tail oscillation frequency changes when the gains change.' }) });
X('T5', { noun: 'tail stops', unit: 'x', scale: 1, tab: 'tail', module: 'loop', nOf: 'yaw stops on one side', min: (R) => R.minEvents,
    say: (f, v) => `${v.In}the yaw overshoot on the ${f.larger === 'cw' ? 'CW' : f.larger === 'ccw' ? 'CCW' : 'larger'} stop side is ${v.value} the overshoot on the other side.`,
    limit: (f, v, R) => T.plain(R.ratio, 'x'),
    evidence: ev('events', [['setpoint[2]', 'gyroADC[2]'], ['axisP[2]', 'axisI[2]', 'axisF[2]']], { kind: 'time', snippet: { fields: ['setpoint[2]', 'gyroADC[2]'] } }, { pads: [0.3, 0.6], expected: () => 'The yaw stops have the same overshoot on the two sides.' }) });
X('T6', { noun: 'collective yaw error', unit: 'deg/s', scale: 1, tab: 'tail', module: 'loop', nOf: 'collective steps with the yaw stick stable', min: (R) => R.minEvents,
    say: (f, v) => `${v.In}after collective steps, the yaw rate changes by ${v.value}.`,
    limit: (f, v, R) => T.plain(R.kick, 'deg/s'),
    evidence: ev('events', [['mixer[3]'], ['gyroADC[2]', 'setpoint[2]'], ['mixer[2]', 'axisF[2]']], { kind: 'time', snippet: { fields: ['gyroADC[2]', 'setpoint[2]', 'mixer[3]'] } }, { pads: [0.1, 0.5], expected: () => 'The yaw rate stays stable when the collective changes.' }) });
X('T7', { noun: 'collective precompensation', unit: '', scale: 1, tab: 'tail', module: 'loop', nOf: 'periods of 2 s with collective movement', min: (R) => R.minWindows,
    say: (f, v) => `${v.In}during collective movements, the yaw I-term follows the precompensation with a correlation of ${v.value}.`,
    limit: (f, v, R) => num(R.r) === null ? null : `The limit for the correlation is ±${R.r}.`, value: (f, v) => v.value === null ? null : `correlation ${v.value}`,
    evidence: ev('events', [['axisI[2]', 'axisF[2]'], ['setpoint[2]'], ['mixer[3]']], { kind: 'scatter', snippet: { fields: ['axisI[2]', 'axisF[2]', 'setpoint[2]'] } }, { pads: [0, 2], expected: () => 'The yaw I-term stays stable when the collective moves.' }) });
X('T8', { noun: 'tail output limit', unit: 's', scale: 1, tab: 'tail', module: 'loop',
    say: (f, v) => num(f.value) > 0 ? `${v.In}the tail output is at a limit for ${v.value} in ${v.n} periods.` : 'The tail output does not stay at a limit.',
    limit: () => 'Each period at a limit counts as a problem.',
    bound: () => '0 s at a limit', value: (f, v) => v.value === null ? null : `${v.value} at a limit`,
    evidence: ev('events', [['mixer[2]'], ['servo[3]'], ['setpoint[2]', 'gyroADC[2]'], ['axisI[2]']], { kind: 'time', curve: 'more.tail' }, { pads: [0.5, 0.5], expected: () => 'The tail output does not touch its limits.' }) });
X('T9', { noun: 'tail feedforward', unit: '%', scale: 100, tab: 'tail', module: 'loop', nOf: 'stable pirouettes at full stick', min: (R) => R.minEvents,
    say: (f, v) => `${v.In}during stable pirouettes at full stick, the yaw I-term is ${v.value} of the tail control change.`,
    limit: (f, v, R) => num(R.iShare) === null ? null : `The limit is ±${pc(R.iShare)} %. Also, the gyro rate must be ${pc(R.gyroRatio[0])} to ${pc(R.gyroRatio[1])} % of the setpoint.`,
    evidence: ev('events', [['setpoint[2]', 'gyroADC[2]'], ['axisI[2]', 'axisF[2]'], ['mixer[2]']], { kind: 'time', snippet: { fields: ['setpoint[2]', 'gyroADC[2]', 'axisI[2]', 'axisF[2]'] } }, { pads: [0.5, 0.3], expected: () => 'The yaw I-term stays near zero during the pirouette.' }) });

// --- tracking (health_track.cjs) ---
const trackSay = (f, v) => `${v.In}the ${ax(v)} tracking error is ${v.value} of the setpoint.`;
const lagSay = (f, v) => `${v.In}the ${ax(v)} gyro follows the setpoint with a time delay of ${v.value}.`;
const blocks10 = (f) => `periods of 10 s with sufficient ${f.axis || 'stick'} stick movement`;
for (const [id, yaw] of [['C12', false], ['T11', true]]) X(id, { noun: yaw ? 'yaw tracking error' : 'tracking error', unit: '%', scale: 100, tab: 'curves', module: 'track', note: 'monitor', nOf: blocks10, min: (R) => R.minBlocks,
    say: trackSay, limit: (f, v, R) => T.two(pc(R.flag), pc(R.note), '%'),
    evidence: ev('blocks', [[G.sp, G.gy], [G.P, G.I, G.F], [G.mix]], { kind: 'time', curve: 'track.{axis}.time' }, { expected: () => 'The gyro follows the setpoint. The tracking error stays less than 30 % of the setpoint.' }) });
for (const [id, yaw] of [['C13', false], ['T12', true]]) X(id, { noun: yaw ? 'yaw time delay' : 'time delay', unit: 'ms', scale: 1, tab: 'curves', module: 'track', note: 'information', nOf: blocks10, min: (R) => R.minBlocks,
    say: lagSay, limit: (f, v, R) => T.sigma(R.flag, 'ms'),
    evidence: ev('blocks', [[G.sp, G.gy]], { kind: 'phase', curve: 'track.{axis}.spectrum' }, { expected: () => 'The gyro follows the setpoint with a short time delay.' }) });
X('R1', { noun: 'stick time delay', unit: 'ms', scale: 1, tab: 'curves', module: 'track', note: 'information', nOf: (f) => `periods with ${f.axis || 'stick'} stick movement`, min: (R) => R.minBlocks,
    say: (f, v) => `The ${ax(v)} setpoint follows the stick with a time delay of ${v.value}.`, limit: (f, v, R) => T.sigma(R.flag, 'ms'),
    evidence: ev('blocks', [['rcCommand[{a}]', G.sp]], { kind: 'time', snippet: { fields: ['rcCommand[{a}]', G.sp] } }, { expected: () => 'The setpoint follows the stick with a short time delay.' }) });
for (const [id, yaw] of [['C5', false], ['T1', true]]) X(id, { noun: yaw ? 'fast tail oscillation' : 'fast oscillation', unit: '%', scale: 100, tab: 'curves', module: 'track', note: 'monitor', nOf: 'periods of 0.5 s with no stick input', min: (R) => R.minWindows,
    say: (f, v) => f.severity === 'flag' ? `${v.In}the ${ax(v)} rate has ${f.value === 1 ? '1 oscillation that increases' : `${fmt(f.value)} oscillations that increase`} with no stick input.`
        : `${v.In}the ${ax(v)} oscillation is ${fmt(rulesOf(f, CHECKS[id]).level) || 20} deg/s or more for ${v.value} of the time with no stick input.`,
    limit: (f, v, R) => f.severity === 'flag' ? 'Each oscillation of this type is a problem.' : num(R.share) === null ? null : `At more than ${pc(R.share)} %, the result is "Monitor". ${SE_NOTE}`,
    bound: (f, v, R) => f.severity === 'flag' ? '0 oscillations that increase' : num(R.share) === null ? null : `${pc(R.share)} % of the time`,
    value: (f, v) => f.severity !== 'flag' || num(f.value) === null ? (v.value === null ? null : `${v.value} of the time`) : f.value === 1 ? '1 oscillation that increases' : `${fmt(f.value)} oscillations that increase`,
    unitOf: (f) => f.severity === 'flag' ? '' : '%', scaleOf: (f) => f.severity === 'flag' ? 1 : 100,
    evidence: ev('events', [[G.sp, G.gy], [G.P, G.D], [G.mix]], { kind: 'time', curve: 'track.{axis}.time' }, { pads: [0.3, 0.5], analyser: 'gyroRAW[{a}]', expected: () => 'The error has no oscillation that increases with no stick input.' }) });

// --- health_more.cjs ---
X('D6', { noun: 'time not used', unit: 's', scale: 1, tab: 'checks', module: 'more', note: 'information',
    say: (f, v) => f.severity === 'flag' ? `Failsafe is on for ${v.value} while the helicopter is airborne.` : `The analysis does not use ${v.value} of flight with rescue, a level mode, failsafe or ground contact.`,
    limit: (f) => f.severity === 'flag' ? 'The limit is 0 s.' : null,
    evidence: ev('events', [['flightModeFlags', 'failsafePhase'], ['headspeed'], ['mixer[3]']], { kind: 'events' }, { pads: [1, 1], expected: () => 'Failsafe does not occur in flight.' }) });
X('F10', { noun: 'D-term noise', unit: '%', scale: 100, tab: 'filters', module: 'more', nOf: 'periods of 1 s', min: (R) => R.minWindows,
    noteStatus: (f) => f.axis === 'yaw' && !isThin(f) && num(f.se) !== null ? 'monitor' : 'information',
    say: (f, v) => f.axis !== 'yaw' && f.unit === 'permille' ? `${v.In}at more than 30 Hz, the ${ax(v)} mixer output has an RMS value of ${pair(f.value, f.se, '‰')}.`
        : `${v.In}${v.value} of the yaw D-term power is at more than 30 Hz.`,
    limit: (f, v, R) => f.axis !== 'yaw' && f.unit === 'permille' ? T.report() : T.sigma(pc(R.share), '%'),
    unitOf: (f) => f.axis !== 'yaw' && f.unit === 'permille' ? '‰' : '%', scaleOf: (f) => f.axis !== 'yaw' && f.unit === 'permille' ? 1 : 100,
    evidence: ev('windows', [[G.D], [G.mix], [G.gy, G.raw]], { kind: 'spectrum', curve: 'more.dterm.{axis}' }, { analyser: 'axisD[{a}]', expected: () => 'Less than 50 % of the D-term power is at more than 30 Hz.' }) });
X('F11', { noun: 'filter time delay', unit: 'ms', scale: 1, tab: 'filters', module: 'more', note: 'information', nOf: 'periods of 1 s of flight', min: (R) => R.minWindows,
    say: (f, v) => `The gyro filters cause a time delay of ${v.value} in the ${ax(v)} gyro at 8 to 16 Hz.`, limit: (f, v, R) => T.sigma(R.flagMs, 'ms'),
    after: (f) => num(f.logOffsetMs) > 0 ? `The analysis decreases the measured time delay by ${pair(f.logOffsetMs, null, 'ms')}, because the log records gyroRAW 1 gyro sample after the filter input.` : null, // firmware 4.6.0 core.c (filter_tune.cjs parity)
    evidence: ev('flight', [[G.raw, G.gy]], { kind: 'phase', curve: 'more.vib.{axis}' }, { analyser: 'gyroRAW[{a}]', expected: () => 'The gyro filters cause a time delay of less than 10 ms.' }) });
X('T13', { noun: 'hover tail trim', unit: '%', scale: 100, tab: 'tail', module: 'more', note: 'information', nOf: 'periods of 10 s of hover', min: (R) => R.minBlocks,
    say: (f, v) => `${v.In}the yaw I-term in hover is ${v.value} of the tail output range.`, limit: (f, v, R) => num(R.share) === null ? null : `The limit is ±${pc(R.share)} %. ${SE_NOTE}`,
    evidence: ev('blocks', [['axisI[2]'], ['mixer[2]'], ['setpoint[2]'], ['mixer[3]']], { kind: 'time', curve: 'more.tail' }, { expected: () => 'In hover, the yaw I-term stays near zero.' }) });
// C14: the pitch I-term (with axisO) against the collective, both in mixer units (1000 = 12 deg, TUNING_KNOWLEDGE 2.1): the value
// per 1000 units / 1000 is the degrees of cyclic pitch for each degree of collective (SPEC3 F: no I-term units in the text)
const perDeg = (f) => num(f.value) === null ? null : `${pair(f.value / 1000, num(f.se) === null ? null : f.se / 1000)} deg of cyclic pitch for each 1 deg of collective`;
X('C14', { noun: 'pitch collective feedforward', unit: '', scale: 1, tab: 'checks', module: 'more', note: 'information', nOf: 'periods of 30 s', min: (R) => R.minBlocks,
    say: (f, v) => `${v.In}the pitch I-term adds ${perDeg(f)}.` + (num(f.gainChange) !== null ? ` A change of ${fmt(f.gainChange)} in pitch_collective_ff_gain supplies this.` : ''),
    limit: (f, v, R) => num(R.flag) === null ? null : `The limit is ${fmt(R.flag / 1000)} deg for each 1 deg of collective, with a gain change of ${R.minGainChange} or more. ${SE_NOTE}`,
    bound: (f, v, R) => num(R.flag) === null ? null : `${fmt(R.flag / 1000)} deg for each 1 deg of collective`,
    value: (f) => perDeg(f),
    evidence: ev('events', [['axisI[1]', 'axisO[1]'], ['mixer[3]'], ['setpoint[1]', 'gyroADC[1]']], { kind: 'scatter', snippet: { fields: ['axisI[1]', 'axisO[1]', 'mixer[3]'], derive: { kind: 'bandpass' } } }, { pads: [0.3, 1.3], expected: () => 'The pitch I-term does not change with the collective.' }) });
X('T14', { noun: 'inertia precompensation', unit: '', scale: 1, tab: 'tail', module: 'more', note: 'information', nOf: 'headspeed changes that the check can use', min: (R) => R.minEvents,
    say: (f, v) => `At headspeed changes, the tail feedback follows the rotor acceleration. A change of ${v.value} in yaw_inertia_precomp_gain supplies this feedback.`,
    limit: (f, v, R) => num(R.minGainChange) === null ? null : `The limit is a gain change of ±${fmt(Math.max(R.minGainChange, (R.relGainChange || 0) * (num(f.from) || 0)))}. ${SE_NOTE}`,
    value: (f, v) => v.value === null ? null : `gain change ${v.value}`,
    evidence: ev('events', [['headspeed', 'govTarget'], ['gyroADC[2]', 'setpoint[2]'], ['mixer[2]', 'axisF[2]']], { kind: 'time', snippet: { fields: ['mixer[2]', 'axisF[2]', 'headspeed'], derive: { kind: 'lowpass' } } }, { pads: [1, 1.3], expected: () => 'The yaw rate stays stable when the headspeed changes.' }) });
X('G14', { noun: 'governor changes', unit: '', scale: 1, tab: 'governor', module: 'more', note: 'information',
    say: (f, v) => num(f.value) > 0 ? `In flight, the governor changes ${v.val} times to AUTOROTATION or BAILOUT, not at a landing.` : `The governor does not change to AUTOROTATION or BAILOUT in flight, other than at a landing.`,
    limit: (f) => f.severity === 'flag' ? 'Each change of this type is a problem.' : null, bound: (f) => f.severity === 'flag' ? '0 changes' : null,
    value: (f, v) => v.val === null ? null : many(f.value, 'change'),
    evidence: ev('events', [['headspeed', 'govTarget'], ['motor[0]'], ['mixer[3]']], { kind: 'governor', curve: 'more.gov' }, { pads: [1, 1], expected: () => 'The governor stays in ACTIVE in flight.' }) });

// --- flight phases and ground checks (health_phase.cjs, SPEC2 D13 and section 6) ---
// The display unit of these checks follows the unit of the finding (P3 writes `unit` on every finding): the template of
// each unit says what the value is. A unit that a template does not know gives the general sentence of PHASE_SAY.
const UNIT_OF = { fraction: ['%', 100], percent: ['%', 1], '%': ['%', 1], permille: ['‰', 1], 'deg/s': ['deg/s', 1], s: ['s', 1], ms: ['ms', 1], rpm: ['rpm', 1], Hz: ['Hz', 1],
    '%/s': ['%/s', 1], '/s': ['/s', 1], 'per s': ['/s', 1], count: ['', 1], events: ['', 1], '': ['', 1] };
const unitKey = (f) => typeof f.unit === 'string' && UNIT_OF[f.unit] ? UNIT_OF[f.unit][0] : null;
const PHASE_AT = { idle: 'at IDLE', spoolup: 'during the spool-up', ground: 'on the ground', flight: 'in flight', spooldown: 'during the spool-down' };
const firstNum = (R, keys) => { for (const k of keys) if (num(R[k]) !== null) return R[k]; return null; };
const benchOf = (f) => f.bench === true || f.logClass === 'bench' || f.class === 'bench' || f.flight === false || (f.flights !== undefined && flightsOf(f) === 0);
const flightsOf = (f) => Array.isArray(f.flights) ? f.flights.length : num(f.flights);
const secondsOf = (f) => { const p = f.phaseSeconds || (f.phases && !Array.isArray(f.phases) ? f.phases : null) || {};
    return num(f.flightS) !== null ? f.flightS : num(p.flight) !== null ? p.flight : f.unit === 's' ? num(f.value) : null; };
// a sentence for the unit of the finding, from a table { unit: (f, v) => 'clause' }; the clause has no period
const PHASE_SAY = (table) => (f, v) => { const k = unitKey(f), u = k !== null ? k : CHECKS[f.id].unit, fn = k === null && typeof f.unit === 'string' && f.unit ? null : table[u];
    return fn ? `${v.In}${fn(f, v)}.` : `${v.In}the value of this check is ${pair(num(f.value), num(f.se), typeof f.unit === 'string' && f.unit && k === null ? `\`${f.unit}\`` : v.unit)}.`; };
// a number threshold of the finding; else the flag of the rules, which are in the unit of the catalog entry only
const phaseLimit = (f, v, R) => { const t = num(f.threshold) !== null ? f.threshold : v.unit === CHECKS[f.id].unit ? firstNum(R, ['flag', 'limit', 'max']) : null; return t === null ? null : T.plain(fmt(t * v.scale), v.unit); };
const phaseUnit = (f) => { const k = unitKey(f); return k !== null ? k : typeof f.unit === 'string' && f.unit ? f.unit : CHECKS[f.id].unit; };
const phaseScale = (f) => typeof f.unit === 'string' && UNIT_OF[f.unit] ? UNIT_OF[f.unit][1] : typeof f.unit === 'string' && f.unit ? 1 : CHECKS[f.id].scale; // an unknown unit: the value as it is
const PH = (o) => Object.assign({ module: 'phase', unitOf: phaseUnit, scaleOf: phaseScale, limit: phaseLimit, min: (R) => firstNum(R, ['minEvents', 'minWindows', 'minBlocks', 'min']) }, o);
const morePct = (f, v) => num(f.value) !== null && f.value < 0 ? `${pair(Math.abs(f.value) * v.scale, num(f.se) === null ? null : f.se * v.scale, v.unit)} less than` : `${v.value} more than`;

X('D7', PH({ noun: 'flight phases', unit: 's', scale: 1, tab: 'checks', note: 'information', limit: () => null,
    say: (f) => { if (benchOf(f)) return 'The log has no flight. Thus, the analysis does not use this log.';
        const k = flightsOf(f), s = secondsOf(f), S = s === null ? null : pair(s, null, 's');
        const first = k === 1 && S ? `The log has 1 flight of ${S}.` : k !== null ? `The log has ${many(k, 'flight')}.${S ? ` They have a total of ${S} in the air.` : ''}` : S ? `The log has ${S} of flight.` : 'The log has a flight.';
        return `${first} The attitude checks use only the flight time.`; },
    evidence: ev('flight', [['headspeed', 'govTarget'], ['mixer[3]'], ['gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]']], { kind: 'table' }, { expected: (f) => benchOf(f) ? null : 'The log has a flight from the time that the helicopter becomes airborne to the landing.' }) }));
// health_phase.cjs: G15 the largest yaw rate on the ground in a spool-up (deg/s, yawFlag and yawNote); G16 the largest
// headspeed error after SPOOLUP to ACTIVE (fraction, signed: more than the reference when positive; flag, settleS); G17
// the number of kicks (count, flag); G18 the RMS headspeed change at IDLE (fraction, 2 SE); C15 the RMS of the largest
// ground oscillation (deg/s; growth, growthSe /s; peak). Other units give the sentence of their unit, or the general one
X('G15', PH({ noun: 'spool-up', unit: 'deg/s', scale: 1, tab: 'governor', nOf: 'spool-ups',
    say: PHASE_SAY({ 'deg/s': (f, v) => `during the spool-up, the largest yaw rate on the ground is ${v.value}`, '%/s': (f, v) => `during the spool-up, the throttle increases at ${v.value}`,
        '/s': (f, v) => `during the spool-up, the throttle increases at ${v.value}`, s: (f, v) => `the spool-up time is ${v.value}` }),
    limit: (f, v, R) => phaseUnit(f) === 'deg/s' && num(R.yawFlag) !== null ? `The limit is ${fmt(R.yawFlag)} deg/s.` + (num(R.yawNote) !== null ? ` At more than ${fmt(R.yawNote)} deg/s, the result is "Monitor".` : '') : phaseLimit(f, v, R),
    evidence: ev('events', [['headspeed', 'govTarget'], ['motor[0]', 'govSum'], ['gyroADC[2]', 'setpoint[2]'], ['mixer[2]']], { kind: 'governor', snippet: { fields: ['headspeed', 'govTarget', 'motor[0]', 'gyroADC[2]'] } },
        { pads: [1, 1], expected: () => 'The headspeed increases to the target with no sudden step, and the helicopter does not turn on the ground.' }) }));
const refOf = (f) => f.reference && f.reference !== 'govTarget' ? 'the stable headspeed' : 'the target';
X('G16', PH({ noun: 'change to ACTIVE', unit: '%', scale: 100, tab: 'governor', nOf: 'changes from SPOOLUP to ACTIVE',
    say: PHASE_SAY({ '%': (f, v) => `at the change from SPOOLUP to ACTIVE, the headspeed is ${morePct(f, v)} ${refOf(f)}`, s: (f, v) => `after the change from SPOOLUP to ACTIVE, the headspeed becomes stable in ${v.value}`,
        rpm: (f, v) => `at the change from SPOOLUP to ACTIVE, the headspeed is ${morePct(f, v)} ${refOf(f)}` }),
    limit: (f, v, R) => phaseUnit(f) === '%' && num(R.flag) !== null ? `The limits are ${pc(R.flag)} %${num(R.settleS) !== null ? ` and ${fmt(R.settleS)} s to become stable` : ''}.`
        : phaseUnit(f) === 's' && num(f.threshold) === null && num(R.settleS) !== null ? T.plain(R.settleS, 's') : phaseLimit(f, v, R),
    after: (f) => f.afterLiftoff === true ? `A longer spool-up time does not correct this error, because the change comes ${num(f.afterLiftoffS) !== null ? `${pair(f.afterLiftoffS, null, 's')} after the liftoff` : 'in flight'}.`
        : phaseUnit(f) !== '%' ? null : f.censored || (f.severity === 'flag' && f.settleS === null) ? 'The headspeed does not become stable.' : num(f.settleS) > 0 ? `The headspeed becomes stable in ${pair(f.settleS, null, 's')}.`
        : num(f.settleS) === 0 ? 'The headspeed stays stable after the change.' : null,
    evidence: ev('events', [['headspeed', 'govTarget'], ['motor[0]', 'govSum'], ['mixer[3]']], { kind: 'governor', snippet: { fields: ['headspeed', 'govTarget', 'motor[0]'] } },
        { pads: [1, 2], expected: (f) => f && f.afterLiftoff === true ? 'The governor is ACTIVE before the liftoff. Then the headspeed goes to the target with no overshoot.'
            : 'At the change to ACTIVE, the headspeed goes to the target with no overshoot and no step of the throttle.' }) }));
X('G17', PH({ noun: 'sudden motor steps', unit: '', scale: 1, tab: 'governor', nOf: 'periods with a constant throttle',
    say: PHASE_SAY({ '': (f, v) => !(num(f.value) > 0) ? 'the motor output and the headspeed have no sudden step that the throttle does not command'
            : `${PHASE_AT[f.phase] ? `${PHASE_AT[f.phase]}, ` : ''}the motor output or the headspeed has ${many(f.value, 'sudden step')} that the throttle does not command`,
        '%': (f, v) => `the largest sudden step of the headspeed ${PHASE_AT[f.phase] || 'at a constant throttle'} is ${v.value}`, rpm: (f, v) => `the largest sudden step of the headspeed ${PHASE_AT[f.phase] || 'at a constant throttle'} is ${v.value}` }),
    limit: (f, v, R) => phaseUnit(f) === '' ? 'Each sudden step of this type is a problem.' : phaseLimit(f, v, R),
    bound: (f, v, R) => phaseUnit(f) === '' ? '0 sudden steps' : boundOf(phaseLimit(f, v, R)), value: (f, v) => phaseUnit(f) === '' && v.val !== null ? many(f.value, 'sudden step') : v.value,
    evidence: ev('events', [['motor[0]', 'govSum'], ['headspeed', 'govTarget']], { kind: 'time', snippet: { fields: ['motor[0]', 'headspeed'] } },
        { pads: [0.5, 0.5], expected: () => 'The motor output and the headspeed change only when the throttle changes.' }) }));
X('G18', PH({ noun: 'headspeed at IDLE', unit: '%', scale: 100, tab: 'governor', nOf: 'periods of 0.5 s at IDLE with a constant motor output',
    say: PHASE_SAY({ '%': (f, v) => `at IDLE, the RMS change of the headspeed is ${v.value}`, rpm: (f, v) => `at IDLE, the RMS change of the headspeed is ${v.value}`,
        '‰': (f, v) => `at IDLE, the RMS change of the motor output is ${v.value}` }),
    limit: (f, v, R) => phaseUnit(f) === '%' && num(R.flag) !== null ? T.sigma(pc(R.flag), '%') : phaseLimit(f, v, R),
    evidence: ev('windows', [['headspeed'], ['motor[0]']], { kind: 'time', snippet: { fields: ['headspeed', 'motor[0]'] } }, { expected: () => 'At IDLE, the headspeed and the motor output are stable.' }) }));
const grows = (f) => num(f.growth) !== null && num(f.growthSe) !== null && f.growth - 2 * f.growthSe > 0;
X('C15', PH({ noun: 'ground resonance', unit: 'deg/s', scale: 1, tab: 'curves',
    thinSay: (f, v, R) => `Before the helicopter becomes airborne, the log has less than ${fmt(num(R.minS) !== null ? R.minS : 1)} s on the ground with the rotor at the flight headspeed. This is not sufficient for a result.`,
    say: PHASE_SAY({ 'deg/s': (f, v) => !f.axis || !(num(f.value) > 0) ? 'before the helicopter becomes airborne, the roll and pitch rates have no oscillation on the landing gear'
            : `before the helicopter becomes airborne, the ${ax(v)} rate has an oscillation of ${v.value} RMS${num(f.hz) !== null ? ` at ${fmt(f.hz)} Hz` : ''} on the landing gear` +
              (num(f.growth) !== null ? `. The oscillation ${grows(f) ? `increases at ${pair(f.growth, f.growthSe, '/s')}` : 'does not increase'}` : ''),
        '/s': (f, v) => `before the helicopter becomes airborne, the ${ax(v)} oscillation on the landing gear increases at ${v.value}`,
        Hz: (f, v) => `before the helicopter becomes airborne, the ${ax(v)} rate has an oscillation at ${v.value} on the landing gear`,
        '': (f, v) => `the log has ${many(f.value, `${ax(v)} oscillation`)} on the landing gear before the helicopter becomes airborne` }),
    limit: (f, v, R) => phaseUnit(f) === 'deg/s' && num(R.peak) !== null ? `The limit is ${fmt(R.peak)} deg/s RMS. An oscillation at the limit or more that increases is a problem. ${SE_NOTE}` : phaseLimit(f, v, R),
    bound: (f, v, R) => phaseUnit(f) === 'deg/s' && num(R.peak) !== null ? `${fmt(R.peak)} deg/s RMS or more, and an increase` : boundOf(phaseLimit(f, v, R)),
    evidence: ev('events', [[G.gy, G.sp], ['mixer[3]'], ['headspeed', 'govTarget']], { kind: 'time', snippet: { fields: [G.gy, 'mixer[3]', 'headspeed'] } },
        { pads: [1, 1], analyser: 'gyroADC[{a}]', expected: () => 'On the ground, the roll and pitch rates have no oscillation that increases.' }) }));

// --- rescue (health_rescue.cjs): G19 headspeed (signed fraction, negative: under the target), T15 yaw error increase (deg/s),
// D8 PID profile changes at a rescue (count). One event has no SE: the finding gives the rescues (n), noise (G19: the median
// absolute change of the headspeed signal around its median, a fraction) and mean, meanSe when n >= 3
const relS = (dt) => num(dt) === null ? '' : dt < 0 ? `${fmt(-dt)} s before the start` : `${fmt(dt)} s after the start`;
X('G19', { noun: 'rescue headspeed', unit: '%', scale: 100, tab: 'governor', module: 'rescue', nOf: 'rescues',
    say: (f, v) => `${v.In}at the rescue, the headspeed decreases to ${pair(Math.abs(num(f.value) || 0) * 100, null, '%')} less than the target.`
        + (f.leave ? ` The governor changes from ACTIVE to ${f.leave}.` : '') + (f.overload ? ' The headspeed decreases while the throttle is at its high value.' : ''),
    limit: (f, v, R) => num(R.flag) === null ? null : `The limit is ${pc(R.flag)} % (check G3). A governor change from ACTIVE to FALLBACK, RECOVERY or BAILOUT is also a problem.`,
    bound: (f, v, R) => num(R.flag) === null ? null : `${pc(R.flag)} % less than the target`,
    value: (f) => num(f.value) === null ? null : `${pair(Math.abs(f.value) * 100, null, '%')} less than the target` + (num(f.noise) !== null ? ` (signal change ±${fmt(f.noise * 100, 2)} %)` : ''),
    skipped: (f) => num(f.n) === 0 ? 'The log has no rescue. Thus, this check did not operate.' : 'This check did not operate on this log. The toolkit text gives the cause.',
    evidence: ev('events', [['headspeed', 'govTarget', 'govRequest'], ['motor[0]'], ['mixer[3]']], { kind: 'governor', curve: 'more.gov', snippet: { fields: ['headspeed', 'govTarget', 'motor[0]', 'mixer[3]'] } },
        { pads: [0, 0.5], expected: () => 'At the rescue, the headspeed stays near the target, and the governor stays in ACTIVE.' }) });
// G20: the cause of each FALLBACK (health_rescue fallbacksOf): value the overloads, n the FALLBACK entries, events kind overload |
// signal | none. Information: an overload is a possible result of the throttle limit (rule K22), the others are check G1
X('G20', { noun: 'FALLBACK cause', unit: '', scale: 1, tab: 'governor', module: 'rescue', note: 'information', statusOf: (f) => (f.severity === 'note' || f.severity === 'flag') && !isThin(f) ? 'information' : null,
    info: 'This check finds the cause of each change of the governor to FALLBACK.',
    why: (f) => num(f.value) > 0 && f.value === f.n ? 'At the throttle limit, the motor cannot hold the headspeed. Then the governor changes to FALLBACK, and the RPM signal is possibly correct.' : 'A FALLBACK at a usual load is possibly an error of the RPM signal (check G1).',
    say: (f) => `${cap(many(f.value, 'FALLBACK'))} of ${fmt(f.n)} ${num(f.value) === 1 ? 'comes' : 'come'} at a headspeed decrease with the throttle at 95 % or more.`
        + (num(f.signals) > 0 ? ` ${cap(many(f.signals, 'FALLBACK'))} ${f.signals === 1 ? 'comes' : 'come'} at an error of the headspeed signal.` : ''),
    limit: () => 'This check gives information only. It has no limit.', value: (f) => num(f.value) === null ? null : `${fmt(f.value)} of ${fmt(f.n)} at the throttle limit`,
    evidence: ev('events', [['headspeed', 'govTarget'], ['motor[0]'], ['mixer[3]']], { kind: 'governor', curve: 'more.gov', snippet: { fields: ['headspeed', 'govTarget', 'motor[0]'] } },
        { pads: [0.5, 0.5], expected: () => 'The governor stays in ACTIVE. At a large load, the throttle does not stay at its limit.' }) });
X('T15', { noun: 'rescue yaw error', unit: 'deg/s', scale: 1, tab: 'tail', module: 'rescue', nOf: 'rescues',
    say: (f, v) => (num(f.value) > 0 ? `${v.In}at the rescue, the largest yaw error is ${v.value} more than the largest yaw error before the rescue.` : `${v.In}at the rescue, the largest yaw error is not more than the largest yaw error before the rescue.`)
        + (num(f.atLimitS) > 0 ? ` The tail output is at its limit for ${pair(f.atLimitS, null, 's')}.` : ''),
    limit: (f, v, R) => num(R.kick) === null ? null : `The limit is ${fmt(R.kick)} deg/s (check T6). A tail output at its limit is also a problem.`,
    bound: (f, v, R) => num(R.kick) === null ? null : `${fmt(R.kick)} deg/s more than before the rescue`,
    value: (f) => num(f.value) === null ? null : `${pair(f.value, null, 'deg/s')} (${pair(f.peak, null, 'deg/s')} at the rescue, ${pair(f.base, null, 'deg/s')} before)`,
    skipped: (f) => num(f.n) === 0 ? 'The log has no rescue. Thus, this check did not operate.' : 'This check did not operate on this log. The toolkit text gives the cause.',
    evidence: ev('events', [['gyroADC[2]', 'setpoint[2]'], ['mixer[2]'], ['headspeed', 'govTarget']], { kind: 'time', curve: 'more.tail', snippet: { fields: ['gyroADC[2]', 'setpoint[2]', 'mixer[2]'] } },
        { pads: [0.5, 0.5], expected: () => 'At the rescue, the yaw rate follows the setpoint, and the tail output does not get to its limits.' }) });
X('D8', { noun: 'rescue PID profile', unit: '', scale: 1, tab: 'checks', module: 'rescue', nOf: 'rescues',
    say: (f, v) => num(f.value) > 0 ? `At ${many(f.value, 'rescue')}, the PID profile changes` + (num(f.fromProfile) !== null && num(f.toProfile) !== null ? ` from ${profileLabel(f.fromProfile)} to ${profileLabel(f.toProfile)}` : '') + '.'
        + (num(f.fromTarget) !== null && num(f.toTarget) !== null ? ` The governor headspeed changes from ${fmt(f.fromTarget)} rpm to ${fmt(f.toTarget)} rpm.` : '') : 'The PID profile does not change at the rescue.',
    limit: () => 'Each PID profile change at a rescue is a problem.', bound: () => '0 changes',
    value: (f) => num(f.value) === null ? null : many(f.value, 'PID profile change'),
    skipped: (f) => num(f.n) === 0 ? 'The log has no rescue. Thus, this check did not operate.' : 'This check did not operate on this log. The toolkit text gives the cause.',
    evidence: ev('events', [['headspeed', 'govTarget', 'govRequest'], ['gyroADC[2]', 'setpoint[2]'], ['mixer[2]']], { kind: 'events' }, { pads: [0.5, 1], expected: () => 'The PID profile stays the same during the rescue.' }) });

// --- rescue configuration (health_config.cjs, SPEC3 A): D9 rescue_mode of each PID profile, from the CLI dump (basis 'cli'), a
// rescue state in the log (basis 'log': the firmware runs the rescue only when rescue_mode is not OFF) or a header value
// ('header'). value 1 on, 0 off, null unknown; mode; unknownProfiles on the note that lists the PID profiles that are not known
const profList = (l) => l.length > 1 ? `PID profiles ${andList(l.map(String))}` : `PID profile ${l[0]}`; // "PID profiles 4, 5 and 6"
X('D9', { noun: 'rescue mode', unit: '', scale: 1, tab: 'checks', module: 'config',
    sym: (f) => f.severity === 'flag' ? 'In this PID profile, the rescue switch does not start a rescue.' : null,
    why: (f) => f.severity === 'flag' ? 'If you fly in this PID profile, the rescue cannot move the helicopter back to a level attitude.' : null,
    good: 'In this PID profile, the rescue switch starts a rescue.',
    say: (f, v) => f.severity === 'flag' ? `${v.In}\`rescue_mode\` is OFF${f.basis === 'cli' ? ' in the CLI dump' : f.basis === 'header' ? ' in the log header' : ''}.`
        : `${v.In}the rescue is on${f.mode ? ` (\`rescue_mode\` is ${f.mode})` : ''}.` + (f.basis === 'log' && num(f.n) > 0 ? ` The log shows ${many(f.n, 'rescue')} in this PID profile.` : f.basis === 'cli' ? ' The CLI dump shows this.' : ''),
    thinSay: (f) => Array.isArray(f.unknownProfiles) && f.unknownProfiles.length ? `The analysis cannot find if the rescue is on in ${profList(f.unknownProfiles)}. The log header does not record \`rescue_mode\`. `
            + `The log records a rescue only when it occurs, and the logs show no rescue in ${f.unknownProfiles.length > 1 ? 'these PID profiles' : 'this PID profile'}.`
        : `${profileIn(profileOf(f)) || 'In this PID profile, '}the analysis cannot find if the rescue is on. The log shows no rescue, and the log header does not record \`rescue_mode\`.`,
    limit: () => 'A PID profile with `rescue_mode` OFF is a problem.', bound: () => '`rescue_mode` not OFF',
    value: (f) => f.value === 0 ? 'rescue OFF' : f.value === 1 ? `rescue on${f.mode ? ` (${f.mode})` : ''}` : null,
    skipped: () => 'The analysis has no flight log. Thus, this check did not operate.',
    evidence: ev('header', [], { kind: 'table', keys: [] }, { expected: () => 'The rescue is on in each PID profile that you fly.' }) });

// --- battery at load steps (health_power.cjs, SPEC3 I): P1 for each flight log, value the mean voltage decrease for each cell at
// the load steps (V), minCell / beforeCell the lowest voltage at a step and the voltage before it, severe the steps from the
// warning level or more to less than the minimum, limits { min, warning, source } (V for each cell); P2 for each battery, value
// the voltage decrease for each 1 A in milliohm (perCell), higher when it is more than the other batteries
const levels = (f, R) => { const L = f.limits || {}, D = (R && R.defaults) || {}; return { min: num(L.min) !== null ? L.min : num(R && R.min) !== null ? R.min : num(D.min), warning: num(L.warning) !== null ? L.warning : num(R && R.warning) !== null ? R.warning : num(D.warning) }; };
const noVolt = (f) => f.noVoltage === 'zero' ? 'The battery voltage (`Vbat`) is 0 in all samples. Thus, the log has no voltage sensor, and this check did not operate.'
    : f.noVoltage === 'absent' ? 'The log does not record the battery voltage (`Vbat`). Thus, this check did not operate.' : 'This check did not operate on this log. The cell count or the throttle is not known.';
X('P1', { noun: 'voltage at load', unit: 'V', scale: 1, tab: 'governor', module: 'power', nOf: 'load steps', min: (R) => R.minSteps,
    sym: (f) => f.severity === 'flag' ? 'At a fast throttle increase, the battery voltage decreases to less than the minimum level of the firmware.' : 'At a fast throttle increase, the battery voltage decreases to less than the warning level of the firmware.',
    why: (f) => f.severity === 'flag' ? 'The battery was not low before the step, but it cannot supply the power. Possibly, the battery is weak.' : 'Then the motor has less power at the load steps. The battery is almost empty, or it is weak.',
    good: 'At each fast throttle increase, the battery voltage stays more than the warning level.',
    say: (f, v) => `At ${many(f.n, 'load step')}, the battery voltage decreases by ${pair(f.value, f.se, 'V')} for each cell.` + (num(f.minCell) !== null ? ` The lowest voltage at a step is ${pair(f.minCell, null, 'V')} for each cell, from ${pair(f.beforeCell, null, 'V')} before the step.` : ''),
    after: (f) => [num(f.severe) > 0 ? `In ${many(f.severe, 'load step')}, the voltage goes from the warning level or more to less than the minimum level.` : null,
        f.severity !== 'ok' ? 'Check G13 gives the low cell voltage for the full flight.' : null].filter(Boolean).join(' ') || null,
    limit: (f, v, R) => { const q = levels(f, R); return q.min === null ? null : `The limit is ${fmt(q.min)} V for each cell at a load step, from ${fmt(q.warning)} V or more before the step. At less than ${fmt(q.warning)} V for each cell, the result is "Monitor".`; },
    bound: (f, v, R) => { const q = levels(f, R); return q.min === null ? null : `${fmt(q.min)} V for each cell at a load step`; },
    value: (f) => num(f.value) === null ? null : `${pair(f.value, f.se, 'V')} for each cell at a load step` + (num(f.minCell) !== null ? ` (lowest ${pair(f.minCell, null, 'V')})` : ''),
    skipped: noVolt,
    evidence: ev('events', [['Vbat'], ['Ibat'], ['motor[0]'], ['headspeed', 'govTarget']], { kind: 'time', snippet: { fields: ['Vbat', 'Ibat', 'motor[0]'] } },
        { pads: [0.5, 0.5], maxSpans: 10, expected: () => 'At each load step, the battery voltage decreases by a small quantity and stays more than the warning level.' }) });
X('P2', { noun: 'battery voltage decrease', unit: 'mΩ', scale: 1, tab: 'governor', module: 'power', note: 'information', nOf: 'load steps with a large output increase', min: (R) => R.minSteps,
    noteStatus: (f) => f.higher ? 'monitor' : 'information',
    info: 'This check measures the battery voltage decrease for each 1 A of battery output.', sym: 'The battery voltage decreases more for each 1 A than with the other batteries.',
    why: (f) => f.higher ? 'A battery with a larger decrease is possibly weak. It gives less power at the load steps.' : null,
    say: (f) => `For each 1 A of battery output, the voltage decreases by ${pair(f.value, f.se, 'mΩ')} (V for each 1000 A)` + (num(f.perCell) !== null ? `, or ${pair(f.perCell, f.perCellSe, 'mΩ')} for each cell` : '') + '.'
        + (f.higher && num(f.othersMedian) !== null ? ` The median of the other batteries is ${pair(f.othersMedian, null, 'mΩ')}.` : ''),
    limit: (f, v, R) => num(R.relHigh) === null ? T.report() : `A battery with more than ${fmt(R.relHigh)} x the median of the other batteries is a value to monitor. ${SE_NOTE}`,
    bound: (f, v, R) => num(R.relHigh) === null ? null : `${fmt(R.relHigh)} x the median of the other batteries`,
    value: (f) => num(f.value) === null ? null : `${pair(f.value, f.se, 'mΩ')} for the battery` + (num(f.perCell) !== null ? `, ${pair(f.perCell, f.perCellSe, 'mΩ')} for each cell` : ''),
    skipped: (f) => /Ibat/.test(String(f.text || '')) || f.hasCurrent === false ? 'The log does not record the battery output (`Ibat`), or it is 0. Thus, this check did not operate.' : noVolt(f),
    evidence: ev('events', [['Vbat', 'Ibat'], ['motor[0]']], { kind: 'scatter', snippet: { fields: ['Vbat', 'Ibat', 'motor[0]'] } }, { pads: [0.5, 0.5], expected: () => 'The voltage decrease for each 1 A is the same as with the other batteries.' }) });

// --- control limits (health_limits.cjs, CLAUDE.md "Control limits"): value = the seconds at the limit (one channel, one PID
// profile), n = the periods, longestS, worstError { kind: headspeed | yaw | tracking, value, limit, over }, combined (other
// outputs at their limits at the same time), limits { lo, hi, source, byProfile }. Counts and times of events have no SE
const LIMIT_LABEL = { throttle: 'the throttle', collective: 'the collective output', collectiveCommand: 'the collective stick', roll: 'the roll output', pitch: 'the pitch output', ring: 'the swash ring', tail: 'the tail output' };
const chanOf = (f) => LIMIT_LABEL[f.channel] || (/^servo/.test(String(f.channel)) ? `\`${f.channel}\`` : /^iterm/.test(String(f.channel)) ? `the ${f.axis || ''} I-term`.replace('  ', ' ') : 'the output');
const errSay = (x) => !x || num(x.value) === null ? '' : x.kind === 'headspeed' ? ` During a period, the headspeed is ${fmt(Math.abs(x.value) * 100, 1)} % ${x.value <= 0 ? 'less' : 'more'} than the target.`
    : x.kind === 'yaw' ? ` During a period, the largest yaw error is ${fmt(x.value, 0)} deg/s.` : ` During a period, the tracking error is ${fmt(x.value * 100, 0)} % of the setpoint.`;
const RELATED = { L1: 'G3', L2: 'G3', L7: 'G3', L3: 'C12', L4: 'T6', L5: 'C12', L6: 'C12' }, relatedOf = (f, id) => f.axis === 'yaw' ? (id === 'L5' ? 'T6' : id === 'L6' ? 'T11' : RELATED[id]) : RELATED[id]; // the tail servo and the yaw I-term: the tail checks
const LIMIT_PLOT = (fields) => ({ kind: 'time', snippet: { fields } });
for (const [id, noun, tab, graphs] of [['L1', 'throttle limit', 'governor', [['{field}'], ['headspeed', 'govTarget'], ['mixer[3]']]], ['L2', 'collective limit', 'checks', [['{field}'], ['headspeed', 'govTarget'], ['motor[0]']]],
    ['L3', 'cyclic limit', 'checks', [['{field}'], ['mixer[0]', 'mixer[1]'], [G.sp, G.gy]]], ['L4', 'tail limit', 'tail', [['{field}'], ['gyroADC[2]', 'setpoint[2]'], ['servo[3]']]],
    ['L5', 'servo limit', 'checks', [['{field}'], ['mixer[0]', 'mixer[1]', 'mixer[2]']]], ['L6', 'I-term limit', 'checks', [[G.I], [G.sp, G.gy]]], ['L7', 'collective stick end', 'governor', [['{field}'], ['mixer[3]'], ['headspeed', 'govTarget'], ['motor[0]']]]])
    X(id, { noun, unit: 's', scale: 1, tab, module: 'limits', note: 'monitor', nOf: 'periods at the limit',
        say: (f, v) => num(f.n) > 0 ? `${v.In}${chanOf(f)} is at its limit in ${many(f.n, 'period')}, for a total of ${v.value}. The longest period is ${pair(f.longestS, null, 's')}.`
            + (f.combined ? ' Other outputs are at their limits at the same time.' : '') + errSay(f.worstError) : `${cap(chanOf(f))} does not get to its limit.`,
        limit: (f, v, R) => num(R.longS) === null ? null : `Each period at the limit is a value to monitor. A problem is a period of ${fmt(R.longS)} s or more, an error more than the limit of check ${relatedOf(f, id)}, or two outputs at their limits.`,
        bound: (f, v, R) => num(R.longS) === null ? null : `less than ${fmt(R.longS)} s for each period`,
        value: (f, v) => num(f.value) === null ? null : num(f.n) > 0 ? `${v.value} at the limit in ${many(f.n, 'period')} (longest ${pair(f.longestS, null, 's')})` : '0 s at the limit',
        skipped: (f) => f.limitUnknown ? `The limit of ${chanOf(f)} is unknown. Thus, this check did not operate. The toolkit text gives the cause.` : 'This check did not operate on this log. The toolkit text gives the cause.',
        evidence: ev('events', graphs, LIMIT_PLOT([graphs[0][0]]), { pads: [0.5, 0.5], maxSpans: 10, expected: () => 'The output does not get to its limits.' }) });

// --- gain decisions (report.cjs) and the checks that no module of the app does ---
X('C7', { noun: 'gain decision', unit: 'deg/s', scale: 1, tab: 'checks', module: null, report: false,
    say: (f, v) => { const c = Array.isArray(f.changes) && f.changes[0];
        return f.change && c ? `At ${fmt(f.bin)} rpm, the model calculates that ${ax(v)}_${String(c.gain).toLowerCase().replace(/_c?cw$/, '')}_gain ${fmt(c.to)} decreases the tracking error by ${pair(f.dTrack, f.seTrack, 'deg/s')}.`
            : `At ${num(f.bin) !== null ? `${fmt(f.bin)} rpm` : 'this headspeed'}, the model does not recommend a ${ax(v)} gain change.`; },
    limit: () => 'A change must decrease the tracking error by 10 % or more, and by 2 standard errors (SE) or more.', bound: () => null,   // a relative decrease, not a value in deg/s
    evidence: ev('runs', [[G.sp, G.gy], [G.mix]], { kind: 'transmission' }, { expected: () => null }) });
X('T3', { noun: 'oscillation and headspeed', unit: '', scale: 1, tab: 'tail', module: null, run: false, say: () => 'This check does not operate in the app.', limit: () => null, value: () => null, evidence: ev('flight', [['gyroADC[2]', 'setpoint[2]'], ['headspeed']], { kind: 'table' }) });
X('T10', { noun: 'tail phase margin', unit: '', scale: 1, tab: 'tail', module: null, run: false, say: () => 'This check does not operate in the app.', limit: () => null, value: () => null, evidence: ev('flight', [['gyroADC[2]', 'setpoint[2]']], { kind: 'table' }) });

// ---------------------------------------------------------------------------------------------
// What the pilot reads first (SPEC3 F): sym, what the helicopter does when the result is a problem or a value to monitor;
// why, why it matters; good, what the helicopter does when the result is satisfactory; info, the lead of a result that gives
// information only. summary() puts them before the number and its limit: symptom, why, number against the limit. Each is a
// string or (f, v, x) -> string. They describe the behaviour, never an internal quantity without its meaning
// ---------------------------------------------------------------------------------------------

const axIs = (v) => v.axis || 'this';
const LEAD = {
    D1: { sym: 'The log rate is too low for the frequency checks.', why: 'At a lower log rate, the results of the vibration and of the oscillation are not accurate.', good: 'The log rate is sufficient for the frequency checks.' },
    D2: { sym: (f) => lostOf(f) > 0 ? 'The log has parts with no data.' : 'The log has a loop stall: a long time between two frames, but no frame is missing.', why: (f) => lostOf(f) > 0 ? 'The checks use the time of each frame. A part with no data can move a result in time.' : 'A loop stall after disarm has no effect.', good: 'The log has no frame time errors.' },
    D3: { sym: 'The log does not record some fields that the checks use.', why: 'Thus, some checks did not operate. The blackbox tab of the Configurator turns on these fields.', good: null },
    D4: { sym: 'The CLI dump and the log header have different values.', why: 'The analysis uses the CLI dump for the values that the header does not have. A dump from a different time can give incorrect values.', good: null },
    H: { info: 'A value of the configuration changes between two logs.', why: 'The analysis does not use the results of different values together.' },
    F1: { sym: (f) => f.severity === 'flag' ? 'No gyro low-pass filter is on, but the RPM filters are on.' : 'No gyro low-pass filter is on.', why: 'The RPM filters remove only the rotor lines. One low-pass filter at approximately 100 Hz removes the other vibration.' },
    F2: { sym: 'A gyro low-pass filter has a low cutoff.', why: 'A low cutoff adds a time delay. Then the gains must be lower, and the response of the helicopter is slower.' },
    F3: { sym: (f) => f.severity === 'note' && !(num(f.value) > 0) ? null : 'An RPM notch filter has a low Q.', why: (f) => f.severity === 'note' && !(num(f.value) > 0) ? null : 'A notch filter with a low Q has a large bandwidth. Then it adds a large time delay.' },
    F4: { sym: (f, v) => `The ${axIs(v)} D-term cutoff is not near the recommended value.`, why: 'A high cutoff lets vibration into the D-term. A low cutoff adds a time delay to the D-term.', good: (f, v) => `The ${axIs(v)} D-term cutoff is near the recommended value.` },
    F5: { sym: 'The raw gyro has a strong vibration line with no notch filter near it.', why: 'Vibration that the filters do not remove gets into the PID controller, the servos and the motor.' },
    F6: { sym: 'The vibration line stays large after its RPM notch filter.', why: 'The vibration that stays gets into the PID controller and the servos.' },
    F9: { sym: (f) => num(f.value) > 0 ? 'Some notch filter frequencies are more than the Nyquist frequency or the firmware limit.' : null, why: (f) => num(f.value) > 0 ? 'A notch filter at this frequency does not operate.' : null },
    C1: { sym: (f, v) => `The ${axIs(v)} I-term stays at its limit.`, why: 'At its limit, the I-term cannot correct a constant error. Then the helicopter moves slowly away from the attitude that the pilot sets.' },
    C2: { sym: 'The cyclic output stays at its limit.', why: 'At the limit, the swash plate cannot move more. Gain changes cannot correct the errors at that time.' },
    C3: { sym: (f, v) => `During fast ${axIs(v)} turns, the I-term must supply a part of the command.`, why: 'The F gain sets the stick response. If the I-term must help, the response is slow, and it changes after the stop.' },
    C4: { sym: (f, v) => `After ${axIs(v)} stops, the helicopter turns more than the stop position and then turns back.`, why: 'An overshoot at the stops shows a gain or a feedforward that is too high.' },
    C5: { sym: (f, v) => f.severity === 'flag' ? `The ${axIs(v)} axis has an oscillation that increases when the sticks do not move.` : `The ${axIs(v)} axis has a small fast oscillation when the sticks do not move.`,
        why: (f) => f.severity === 'flag' ? 'An oscillation of this type shows a gain that is too high. It can increase until the helicopter is not stable.' : 'A fast oscillation can show a gain near its limit, or vibration in the gyro signal.' },
    C6: { sym: (f, v) => `When the sticks do not move, the ${axIs(v)} axis has a slow oscillation.`, why: 'A slow oscillation shows an I gain that is too high or a P gain that is too low.' },
    C8: { info: 'This check measures the roll movement when the pitch stick moves.', why: 'The cross-coupling compensation decreases this roll movement.' },
    C9: { info: 'This check compares the pitch error at positive and at negative collective.', why: 'The high speed integral (O gain) corrects this difference in fast flight.' },
    C10: { sym: (f, v) => !f.axis ? null : `In flight, the ${axIs(v)} I-term decreases fast, as on the ground.`, why: (f) => !f.axis ? null : 'Then the firmware possibly does not know that the helicopter is airborne.' },
    C11: { sym: (f, v) => `Much of the ${axIs(v)} D-term signal is vibration, not movement of the helicopter.`, why: 'This vibration goes to the servos. It can cause damage to the servos, and it limits the D gain.' },
    T2: { sym: 'When the sticks do not move, the tail moves slowly from side to side.', why: 'A slow oscillation shows an I gain that is too high or a P gain that is too low.' },
    T4: { sym: 'The tail oscillation stays at the same frequency when the gains change.', why: 'A frequency that does not change with the gains shows a possible mechanical cause, for example a loose linkage.' },
    T5: { sym: 'The tail stops are not the same on the two sides.', why: 'The stop gains set the yaw stop on each side. A larger overshoot on one side shows a stop gain to adjust.' },
    T6: { sym: 'The tail moves when the collective changes.', why: 'The collective changes the torque of the main rotor. The yaw precompensation must supply the tail thrust for this torque.' },
    T7: { sym: 'During collective movements, the yaw I-term must correct the torque change.', why: 'Then the precompensation does not supply all of the tail thrust for the torque change.' },
    T8: { sym: 'The tail output stays at its limit.', why: 'At its limit, the tail does not have sufficient authority. Gain changes cannot correct this.' },
    T9: { sym: 'During fast pirouettes, the yaw I-term must supply a part of the tail command.', why: 'The yaw F gain sets the pirouette response. If the I-term must help, the response is slow.' },
    C12: { sym: (f, v) => `The gyro does not follow the ${axIs(v)} stick command accurately.`, why: 'The tracking error is the difference between the stick command and the gyro rate. A large error shows that the gains or the feedforward are not sufficient.' },
    T11: { sym: 'The gyro does not follow the yaw stick command accurately.', why: 'The tracking error is the difference between the stick command and the gyro rate. A large error shows that the gains or the feedforward are not sufficient.' },
    C13: { info: (f, v) => `This check measures the time delay from the stick to the ${axIs(v)} rate.`, sym: (f, v) => `The ${axIs(v)} axis has a slow response to the stick.`, why: 'A long time delay makes the response slow. The filters, the servos and the B gain change it.' },
    T12: { info: 'This check measures the time delay from the stick to the yaw rate.', sym: 'The tail has a slow response to the stick.', why: 'A long time delay makes the response slow. The filters, the servo and the B gain change it.' },
    R1: { info: (f, v) => `This check measures the time delay from the stick to the ${axIs(v)} setpoint.`, sym: (f, v) => `The ${axIs(v)} setpoint follows the stick with a long time delay.`, why: 'The response time and the acceleration limit of the rates set this time delay.' },
    D6: { sym: (f) => f.severity === 'flag' ? 'Failsafe is on while the helicopter is airborne.' : null, why: (f) => f.severity === 'flag' ? 'Failsafe in flight shows that the receiver did not get the signal of the transmitter.' : null },
    F10: { sym: (f, v) => f.axis !== 'yaw' && f.unit === 'permille' ? null : 'Much of the yaw D-term signal is vibration, not movement of the helicopter.', why: (f) => f.axis !== 'yaw' && f.unit === 'permille' ? null : 'This vibration goes to the tail servo or the tail motor, and it limits the yaw D gain.' },
    F11: { sym: 'The gyro filters cause a long time delay in the gyro signal.', why: 'A long filter time delay makes the loop less stable. Then the gains must be lower.' },
    T13: { sym: 'In hover, the yaw I-term must hold a large tail offset.', why: 'Then the I-term has less range to correct other errors. The tail center trim can supply this offset.' },
    C14: { sym: 'When the collective changes, the helicopter pitches, and the pitch I-term must correct it.', why: 'The I-term corrects slowly. Thus, the helicopter pitches for a short time after each collective change.',
        info: 'This check measures the pitch movement when the collective changes.' },
    T14: { info: 'This check measures the tail movement when the headspeed changes.', why: 'A headspeed change changes the torque of the main rotor. The inertia precompensation supplies the tail thrust for this change.' },
    G14: { sym: 'In flight, the governor changes to AUTOROTATION or BAILOUT.', why: 'A change of this type removes or decreases the headspeed in flight.', good: 'The governor stays in ACTIVE in flight.' },
    G15: { sym: (f) => phaseUnit(f) === 'deg/s' ? 'During the spool-up, the helicopter turns on the ground.' : 'The throttle increases fast during the spool-up.', why: 'A fast spool-up gives a large torque, and the tail cannot hold the helicopter at a low headspeed.' },
    G16: { sym: 'At the change from SPOOLUP to ACTIVE, the headspeed goes more than the target or less than it.', why: 'A step of the headspeed at this time changes the torque, and it can turn the helicopter.' },
    G17: { sym: 'The motor or the headspeed changes suddenly while the throttle does not change.', why: 'A sudden step can show a motor sync loss or a problem of the ESC.' },
    G18: { sym: 'At IDLE, the headspeed is not stable.', why: 'An idle that is not stable can show a problem of the ESC or of the motor timing.' },
    C15: { sym: 'Before the liftoff, the helicopter has an oscillation on its skids.', why: 'A ground resonance can increase fast and cause damage. Keep the collective low until the governor is ACTIVE.' },
    G19: { sym: 'At the rescue, the headspeed decreases.', why: 'The rescue pulls up with a large collective. A low headspeed decreases the lift and the tail authority.' },
    T15: { sym: 'At the rescue, the tail moves more than before the rescue.', why: 'The rescue changes the collective fast, and the tail must hold the torque change.' },
    D8: { sym: 'The PID profile changes when the rescue starts.', why: 'Then the rescue pulls up with different gains and a different headspeed.' },
    D5: { sym: (f, v, x) => d5Low(f, x) ? 'The battery voltage becomes very low in flight.' : 'The battery voltage changes suddenly.',
        why: (f, v, x) => d5Low(f, x) ? 'A low voltage decreases the motor power. Then the governor cannot hold the headspeed.' : 'A sudden step can show a loose connector or a problem of the voltage sensor.' },
    G13: { sym: 'In flight, the cell voltage becomes low.', why: 'At a low cell voltage, the motor has less power, and the battery can become damaged.', good: 'The cell voltage stays sufficient in flight.' },
    G1: { sym: (f) => f.severity === 'flag' ? 'The governor changes to FALLBACK.' : 'The headspeed signal shows errors.',
        why: (f) => f.severity === 'flag' ? 'In FALLBACK, the governor does not use the RPM signal. Then it does not control the headspeed.' : 'The governor and the RPM notch filters use this signal.' },
    G2: { sym: 'In stable flight, the headspeed is not at the target.', why: 'A headspeed error changes the lift and the tail authority. The governor I gain corrects a constant error.' },
    G3: { sym: 'When the collective increases, the headspeed decreases.', why: 'The governor F gain supplies throttle before the headspeed decreases. A large decrease changes the torque and moves the tail.' },
    G4: { sym: 'After a collective change, the headspeed goes more than the target.', why: 'An overshoot shows a governor F gain or P gain that is too high.' },
    G5: { sym: 'After a collective increase, the headspeed comes back to the target slowly.', why: 'The governor P and I gains set this time.' },
    G6: { sym: 'The throttle is near its limit in flight.', why: 'Without a reserve, the governor cannot hold the headspeed when the load increases. Gain changes cannot increase the reserve.' },
    G7: { info: 'At the throttle limit, the governor commands more throttle than the motor can get.' },
    G9: { sym: 'The headspeed has an oscillation in stable flight.', why: 'An oscillation shows a governor P gain or I gain that is too high.' },
    G10: { sym: 'The headspeed and the yaw rate have the same oscillation.', why: 'The governor can cause the tail oscillation. Then decrease the governor gain before you change the tail gains.' },
    G11: { sym: 'At equal collective, the throttle increases during the flight.', why: 'The battery voltage decreases during the flight. The governor then must supply more throttle, and the reserve becomes smaller.' },
    G12: { sym: 'The main rotor vibration line is not at the rotor frequency that the log records.', why: 'The RPM notch filters and the governor use this headspeed.' },
};
const LIMIT_WHY = { L1: 'At the throttle limit, the governor cannot hold the headspeed.', L2: 'At the collective limit, the pilot or the rescue cannot get more collective.', L3: 'At the cyclic limit, the swash plate cannot move more.',
    L4: 'At its limit, the tail does not have sufficient authority. Gain changes cannot correct this.', L5: 'At its limit, the servo cannot move more.', L6: 'At its limit, the I-term cannot correct a constant error.',
    L7: 'At the end of the stick, the pilot cannot command more collective.' };
// L7, the collective stick at its end, is a command of the pilot: a value to monitor at most, never a problem of the flight controller
CHECKS.L7.statusOf = (f) => f.severity === 'flag' && !f.explained ? 'monitor' : null;
// G11, the throttle increase during a battery at equal collective, is the governor that supplies the normal pack sag: a value to
// monitor at most, never a problem of the power prerequisite (user rule: a prerequisite is a problem only for a clearly measurable
// issue). A weak battery is P1: a load step that takes a cell from the warning level to less than the minimum voltage
CHECKS.G11.statusOf = (f) => f.severity === 'flag' && !f.explained ? 'monitor' : null;
for (const id of Object.keys(LIMIT_WHY)) LEAD[id] = { sym: (f) => num(f.n) > 0 ? `${cap(chanOf(f))} gets to its limit.` : null, why: (f) => num(f.n) > 0 ? LIMIT_WHY[id] : null };

// the reference lines and bands of the plot against the limit: (f, R the rules, x the facts) -> [{ kind, value | from, to, label, unit }]
const pctOf = (x) => num(x) === null ? null : x * 100;
const hl = (value, unit, label) => num(value) === null ? null : { kind: 'hline', value, label: label || `Limit ${fmt(value)}${unit ? ` ${unit}` : ''}`, unit };
const vl = (value, unit, label) => num(value) === null ? null : { kind: 'vline', value, label: label || `${fmt(value)} ${unit}`, unit };
// C5, T1 (review D-M5g): a flag is an oscillation that increases from less than onset.small to onset.high or more in
// minHalfCycles half cycles or more (health_track RULE.osc.onset); a note is the time at the level or more (DEFAULT_RULES level, share)
const ONSET = (MOD.track && MOD.track.RULE && MOD.track.RULE.osc && MOD.track.RULE.osc.onset) || { small: 30, high: 150, minHalfCycles: 6 };
const oscRef = (f, R) => f.severity === 'flag'
    ? [hl(ONSET.small, 'deg/s', `Start: less than ${fmt(ONSET.small)} deg/s`), hl(ONSET.high, 'deg/s', `Problem: ${fmt(ONSET.high)} deg/s or more after ${fmt(ONSET.minHalfCycles)} half cycles`)]
    : [hl(R.level, 'deg/s', `Limit ${fmt(R.level)} deg/s` + (num(R.share) !== null ? ` for ${fmt(R.share * 100)} % of the time` : ''))];
const notchRef = (x) => (Array.isArray(x.axes) ? x.axes : []).filter(q => q && num(q.hz) !== null).map(q => vl(q.hz, 'Hz', `${cap(q.axis)} notch filter ${fmt(q.hz)} Hz`));
const REF = {
    C12: (f, R) => [hl(pctOf(R.flag), '%'), hl(pctOf(R.note), '%')], T11: (f, R) => REF.C12(f, R),
    C13: (f, R) => [hl(R.flag, 'ms')], T12: (f, R) => [hl(R.flag, 'ms')], R1: (f, R) => [hl(R.flag, 'ms')], F11: (f, R) => [hl(R.flagMs, 'ms')],
    C5: oscRef, T1: oscRef,
    C11: () => [vl(30, 'Hz')], F10: () => [vl(30, 'Hz')], F2: (f) => [vl(f.value, 'Hz'), vl(60, 'Hz')], F4: (f, R) => [vl(f.value, 'Hz'), vl(R.targetHz, 'Hz')],
    F5: (f, R, x) => [vl(x.hz, 'Hz', num(x.hz) === null ? null : `Peak ${fmt(x.hz)} Hz`)].concat(notchRef(x)), F6: (f, R, x) => [vl(x.hz, 'Hz'), hl(R.minDb, 'dB')], G9: (f, R, x) => [vl(x.hz, 'Hz'), hl(R.prominence, 'x')],
    C6: (f) => [vl(f.hz, 'Hz')], T2: (f) => [vl(f.hz, 'Hz')],
    G2: (f, R) => [hl(pctOf(R.median), '%'), hl(-pctOf(R.median), '%'), hl(pctOf(R.band), '%'), hl(-pctOf(R.band), '%')],
    G3: (f, R) => [hl(-pctOf(R.flag), '%'), hl(-pctOf(R.good), '%')], G4: (f, R) => [hl(pctOf(R.flag), '%')], G5: () => [{ kind: 'band', from: -1, to: 1, label: 'Target ±1 %', unit: '%' }],
    G6: (f, R) => [hl(R.median, '%')], G13: (f, R) => [hl(num(f.threshold) !== null ? f.threshold : R.minCell, 'V')], D5: () => [],  // review V5: the limits of D5 (a step in 10 ms, V for each cell) are not lines on the Vbat of the pack
    T6: (f, R) => [hl(R.kick, 'deg/s'), hl(-R.kick, 'deg/s')],
    T8: (f, R, x) => x.tailLimits ? [x.tailLimits.lo, x.tailLimits.hi].map(v => hl(v, '‰', num(v) === null ? null : `Tail output limit ${fmt(v)} ‰`)) : [], // evidence.cjs facts: health_loop T8 limits of mixer[2]
    T13: (f, R) => [hl(pctOf(R.share), '%'), hl(-pctOf(R.share), '%')], G12: () => [vl(1, 'x')],
    P1: (f, R) => { const q = levels(f, R), c = num(f.cells); if (c === null) return []; // the Vbat field is in 0.01 V
        return [q.warning === null ? null : { kind: 'hline', value: +(q.warning * c * 100).toFixed(0), label: `Warning ${fmt(q.warning * c)} V (${fmt(q.warning)} V for each cell)`, unit: '' },
            q.min === null ? null : { kind: 'hline', value: +(q.min * c * 100).toFixed(0), label: `Minimum ${fmt(q.min * c)} V (${fmt(q.min)} V for each cell)`, unit: '' }]; },
    G19: (f, R) => [hl(-pctOf(R.flag), '%', `Limit −${fmt(pctOf(R.flag))} % (check G3)`)],
    T15: (f, R, x) => (x.tailLimits ? [x.tailLimits.lo, x.tailLimits.hi].map(v => hl(v, '‰', num(v) === null ? null : `Tail output limit ${fmt(v)} ‰`)) : []).concat([hl(R.kick, 'deg/s', `Limit ${fmt(R.kick)} deg/s more than before the rescue`)]),
};
// the limits of a control-limit finding in the units of its field (health_limits.cjs limits: lo, hi, or byProfile for the PID profile)
const limitLines = (f) => { if (f.channel === 'ring') return []; // the swash ring limit is of |mixer[0], mixer[1]|, not of the field that the plot shows
    const L = f.limits || {}, p = f.profile, bp = L.byProfile && num(L.byProfile[p]) !== null ? L.byProfile[p] : null;
    const hi = num(L.hi) !== null ? L.hi : bp, lo = num(L.lo) !== null ? L.lo : bp !== null && f.id === 'L6' ? -bp : null;
    return [lo, hi].map(v => hl(v, '', num(v) === null ? null : `Limit ${fmt(v)}`)); };
for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']) REF[id] = (f) => limitLines(f);
// the flight phases of each check (SPEC2 D13 correction): attitude-loop, filter and vibration checks use the flight only;
// governor, motor, ESC and power checks use all phases of a flight log; header checks no phase (null)
const ALL_PHASES = ['idle', 'spoolup', 'ground', 'flight', 'spooldown'];
const PHASES = { G20: ALL_PHASES, P1: ALL_PHASES, P2: ALL_PHASES, D9: null, D5: ALL_PHASES, D7: ALL_PHASES, G14: ALL_PHASES, G19: ALL_PHASES, T15: ALL_PHASES, D8: ALL_PHASES, L1: ALL_PHASES, L2: ALL_PHASES, L3: ALL_PHASES, L4: ALL_PHASES, L5: ALL_PHASES, L6: ALL_PHASES, L7: ALL_PHASES, G15: ['spoolup'], G16: ['spoolup', 'ground', 'flight'], G17: ['idle', 'spoolup', 'ground'], G18: ['idle'], C15: ['ground'] }; // G16: a change after the liftoff is in flight
const homeOf = (id, axis) => H ? H.homeOf(id, axis) : null;
// The subsystem of each check for the Analysis overview (SPEC3 I, K3): power, motor, governor, rpm, vibration, limits, tail,
// cyclic, radio, logging. C7 by its axis
const AREAS = ['power', 'motor', 'governor', 'rpm', 'vibration', 'limits', 'tail', 'cyclic', 'radio', 'logging'];
const AREA_OF = {};
for (const [area, ids] of Object.entries({ logging: 'D1 D2 D3 D4 H SETUP D7', rpm: 'G1 G12 G20', power: 'D5 G13 G11 P1 P2', motor: 'G17 G18',
    governor: 'G0 G2 G3 G4 G5 G6 G7 G8 G9 G10 G14 G15 G16 G19', vibration: 'F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 C11 C15 T4', limits: 'L1 L2 L3 L4 L5 L6 L7 C2 T8',
    tail: 'T1 T2 T3 T5 T6 T7 T9 T10 T11 T12 T13 T14 T15', cyclic: 'C1 C3 C4 C5 C6 C8 C9 C10 C12 C13 C14', radio: 'R1 D6 D8 D9' })) for (const id of ids.split(' ')) AREA_OF[id] = area;
for (const [id, c] of Object.entries(CHECKS)) {
    c.id = id; if (REF[id]) c.evidence.plot.reference = REF[id]; c.template = c.say;
    c.node = id === 'C7' || id === 'L5' || id === 'L6' ? (axis) => homeOf(id, axis) : id === 'SETUP' ? (axis, f) => homeOf(f && f.rule ? `SETUP:${f.rule}` : 'SETUP', axis) : homeOf(id);
    c.area = id === 'C7' ? (axis) => axis === 'yaw' ? 'tail' : 'cyclic' : AREA_OF[id] || null;
    c.phases = PHASES[id] || (c.evidence.source === 'header' ? null : /^G\d/.test(id) ? ALL_PHASES : ['flight']);
    for (const k of ['sym', 'why', 'good', 'info']) if (LEAD[id] && LEAD[id][k] !== undefined && c[k] === undefined) c[k] = LEAD[id][k];
}

// ---------------------------------------------------------------------------------------------
// Formatting, status, summary
// ---------------------------------------------------------------------------------------------

// the gap events of a D2 finding counted by kind (health_setup D2 events.kind)
function gapCounts(events) {
    if (!Array.isArray(events) || !events.length) return null;
    const n = (re) => events.filter(e => re.test(String(e.kind || ''))).length;
    return { jumps: n(/^time jump/), stalls: n(/^loop stall/), back: n(/^time not increasing/), iterations: n(/^loopIteration jump/) };
}
// the key and values of an H finding (health_setup: "key: from -> to (since log n, scope)"); value is the new value
function headerChange(f) {
    const m = /^([^:]+): (.*) -> (.*?) \(since log (\d+)/.exec(String(f.text || ''));
    return m ? { key: m[1].trim(), from: m[2].trim(), to: m[3].trim(), since: +m[4] } : null;
}

const unitOf = (f) => { const c = f && CHECKS[f.id]; return c ? (c.unitOf ? c.unitOf(f) : c.unit) : (f && f.unit) || ''; };
const scaleOf = (f) => { const c = f && CHECKS[f.id]; return c ? (c.scaleOf ? c.scaleOf(f) : c.scale) : 1; };
const nodeOf = (f) => { const c = f && CHECKS[f.id]; if (!c) return f ? homeOf(f.id, f.axis) : null; return typeof c.node === 'function' ? c.node(axisOf(f), f) : c.node; };
// K2, K3: the subsystem of a finding, and if its home is a tuning block (a "poorly tuned parameters" item that the Analysis view
// links to the Tuning view) or a prerequisite (hardware or setup: no tuner link)
const areaOf = (f) => { const c = f && CHECKS[f.id]; if (!c) return null; return typeof c.area === 'function' ? c.area(axisOf(f), f) : c.area || null; };
const tunerOf = (f) => { const n = nodeOf(f); return !!(n && H && typeof H.isBlock === 'function' && H.isBlock(n)); };

// the values of a finding as the templates write them
function format(f) {
    const unit = unitOf(f), scale = scaleOf(f), val = num(f.value) === null ? null : f.value * scale, se = num(f.se) === null ? null : f.se * scale;
    const q = profileOf(f), profile = profileLabel(q), axis = axisOf(f);
    return { value: pair(val, se, unit), val: fmt(val), se: fmt(se), unit, scale, n: num(f.n) === null ? null : String(f.n), profile, In: profileIn(q), phase: PHASE_AT[f.phase] || null,
        axis, log: logLabel(Array.isArray(f.log) ? f.log[0] : f.log), logs: (Array.isArray(f.log) ? f.log : [f.log]).map(logLabel).filter(Boolean).join(', ') };
}

function status(f) {
    if (!f) return 'notMeasured';
    if (f.severity === 'error') return 'error';
    if (f.severity === 'skipped') return 'notMeasured';
    const c = CHECKS[f.id], own = c && typeof c.statusOf === 'function' ? c.statusOf(f) : null;
    if (own) return own;
    if (f.severity === 'flag') return f.explained ? 'information' : Array.isArray(f.resultOf) && f.resultOf.length ? 'monitor' : 'problem';
    if (f.severity === 'ok') return 'satisfactory';
    if (f.severity !== 'note') return 'information';
    if (isThin(f)) return 'insufficient';
    if (!c) return 'monitor';
    return c.noteStatus ? c.noteStatus(f) : c.note || 'monitor';
}

const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
// "periods of 10 s" for 1: "period of 10 s" (the last plural word before the first preposition)
const one = (what) => { const w = what.split(' '), stop = w.findIndex(x => /^(of|with|at|on|from|that|in|for|to)$/.test(x)), end = stop < 0 ? w.length : stop;
    for (let i = end - 1; i >= 0; i--) if (/[a-z]s$/.test(w[i]) && !/ss$/.test(w[i])) { w[i] = w[i].slice(0, -1); break; } return w.join(' '); };
function summary(f) {
    if (!f || typeof f.id !== 'string') return '';
    const c = CHECKS[f.id];
    if (f.severity === 'error') return 'This check did not operate because of an analysis error. The toolkit text gives the cause.';
    if (!c) return 'The toolkit text gives the result of this check.';
    if (f.severity === 'skipped') return c.skipped ? c.skipped(f) : 'This check did not operate on this log. The toolkit text gives the cause.';
    const v = format(f), x = (f.evidence && f.evidence.facts) || {}, R = rulesOf(f, c);
    if (isThin(f)) {
        if (c.thinSay) return c.thinSay(f, v, R);
        const what = typeof c.nOf === 'function' ? c.nOf(f) : c.nOf, min = c.min ? c.min(R) : null, more = c.minText ? c.minText(R) : num(min) !== null ? `A minimum of ${min} is necessary.` : null;
        if (v.n === null || !what) return `${v.In ? `${v.In}the log does` : 'The log does'} not have sufficient data for this check.`;
        return `${v.In ? `${v.In}the log has` : 'The log has'} ${v.n} ${v.n === '1' ? one(what) : what}. ${more || 'This is not sufficient for a result.'}`;
    }
    let say = cap(c.say(f, v, x)); const lim = c.limit ? c.limit(f, v, R, x) : null, after = c.after ? c.after(f, v, x) : null;
    if (/\b(null|undefined|NaN)\b|\[object/i.test(say)) say = 'The result has no value. The toolkit text gives the result.'; // a value of a type that the template does not know
    const own = MOD[c.module] && MOD[c.module].DEFAULT_RULES && MOD[c.module].DEFAULT_RULES[f.id]; // without the module's rules, its threshold text is quoted
    // SPEC3 F: what the helicopter does, why it matters, then the number against its limit (the 2-SE rule is in the details)
    const st = status(f), [lead, why] = leadOf(c, f, v, x, st), short = typeof lim === 'string' ? lim.replace(` ${SE_NOTE}`, '').replace(SE_NOTE, '').trim() : lim;
    const first = [lead, why].filter(Boolean).join(' '), second = [say, short || (c.limit && c.module && !own ? quoted(f) : null), after, resultSay(f)].filter(Boolean).join(' ');
    return [first, second].filter(Boolean).join('\n');
}
// the lead sentences of a summary for the status st: [symptom or what the result shows, why it matters] (SPEC3 F)
function leadOf(c, f, v, x, st) {
    const get = (k) => { const t = c[k]; try { return typeof t === 'function' ? t(f, v, x) : t || null; } catch (e) { return null; } };
    const ok = (t) => typeof t === 'string' && t && !/\b(null|undefined|NaN)\b|\[object/.test(t) ? cap(t) : null;
    if (st === 'problem') return [ok(get('sym')) || ok(get('info')), ok(get('why'))];
    if (st === 'monitor') { const t = ok(get('sym')); return [t && f.severity === 'note' ? `Possibly, ${t.charAt(0).toLowerCase()}${t.slice(1)}` : t || ok(get('info')), ok(get('why'))]; } // a note to monitor: no claim
    if (st === 'information') return f.severity === 'flag' ? [ok(get('sym')) || ok(get('info')), ok(get('why'))] : [ok(get('info')), ok(get('info')) ? ok(get('why')) : null];
    if (st === 'satisfactory') { const exp = c.evidence && typeof c.evidence.expected === 'function' ? (() => { try { return c.evidence.expected(f); } catch (e) { return null; } })() : null;
        return [ok(get('good')) || (c.good === null ? null : ok(exp)), null]; } // else the expected behaviour of the evidence spec
    return [null, null];
}
// the symptom and why it matters for a finding, as advice.cjs puts them first in a recommendation (SPEC3 F): st is the status
// that the recommendation gives ('problem', 'monitor', 'information'), else the status of the finding. -> [sentences]
function lead(f, st) {
    const c = f && CHECKS[f.id]; if (!c || f.severity === 'skipped' || f.severity === 'error') return [];
    try { return leadOf(c, f, format(f), (f.evidence && f.evidence.facts) || {}, st || status(f)).filter(Boolean); } catch (e) { return []; }
}
// a flag that the worker marks as a possible result of other checks (f.resultOf, K rules of hierarchy.cjs)
function resultSay(f) {
    if (!Array.isArray(f.resultOf) || !f.resultOf.length) return null;
    const ids = [...new Set(f.resultOf.flatMap(q => q.ids || []))], rules = [...new Set(f.resultOf.map(q => q.rule))];
    return ids.length ? `This is possibly a result of the problem of ${ids.length > 1 ? 'checks' : 'check'} ${andList(ids)} (rule ${andList(rules)}).` : null;
}

// What the views show of a finding (review V5, V6; js/tuning_worker.js present): the value that the rule compares, with its
// SE, unit and meaning (c.value, else format().value; a result with not sufficient data gives the data that it has), the
// STE limit sentence (as summary), and the limit in the unit of that value (c.bound, else boundOf the limit). Never a bare
// count, and never a toolkit threshold (that is in the toolkit text)
function display(f) {
    const c = f && CHECKS[f.id], v = f ? format(f) : null, x = (f && f.evidence && f.evidence.facts) || {}, out = { value: v ? v.value : null, unit: v ? v.unit : null, scale: v ? v.scale : null, limit: null, bound: null,
        profile: v ? v.profile : null, phase: v ? v.phase : null };
    if (!c || !v || f.severity === 'skipped' || f.severity === 'error') return Object.assign(out, f && (f.severity === 'skipped' || f.severity === 'error') ? { value: null } : {});
    const R = rulesOf(f, c), own = MOD[c.module] && MOD[c.module].DEFAULT_RULES && MOD[c.module].DEFAULT_RULES[f.id];
    try { out.limit = c.limit ? c.limit(f, v, R, x) : null; } catch (e) { out.limit = null; }
    if (!out.limit && c.limit && c.module && !own) out.limit = quoted(f);
    try { out.bound = c.bound ? c.bound(f, v, R, x) : boundOf(out.limit); } catch (e) { out.bound = null; }
    try { if (c.value) out.value = c.value(f, v, x, R); } catch (e) { out.value = null; }
    if (isThin(f) && out.value !== null) { const what = typeof c.nOf === 'function' ? c.nOf(f) : c.nOf;
        out.value = v.n !== null && what ? `${out.value} from ${v.n} ${v.n === '1' ? one(what) : what}` : out.value; }
    if (typeof out.value === 'string' && (/\b(null|undefined|NaN)\b|\[object/.test(out.value) || !out.value)) out.value = null;
    if (typeof out.bound !== 'string' || !out.bound || /\b(null|undefined|NaN)\b/.test(out.bound)) out.bound = null;
    return out;
}

// ---------------------------------------------------------------------------------------------
// Issues (round 3 M3): the Analysis overview counts issues, not findings
// ---------------------------------------------------------------------------------------------

// An issue is one check and axis over all logs, PID profiles and configurations: its results with the status problem or monitor.
// size: how far the result is from its limit, as value / limit (limit / value for a check whose limit is a minimum), the largest of
// the issue; null when the limit is 0 or unknown (a count of events against a limit of 0). Rank: the status (problem first), then
// the size (a size of null ranks as ISSUE_RULES.zeroSize). A card whose issues are all small (size less than ISSUE_RULES.small) is
// "Monitor", not "Problem" (SPEC3 L3).
const ISSUE_RULES = { small: 1.2, zeroSize: 2, maxSize: 1000, top: 3,
    source: 'pipeline, unvalidated: a result less than 1.2 times its limit is small (SPEC3 L3, the coordinator); a result over a limit of 0 (a count of events) ranks as 2 times its limit' };
const MIN_IDS = new Set(['D1', 'F2', 'F3', 'F6', 'G13']);  // checks whose limit is a minimum (the value must be more than it)
const numIn = (t) => { const m = /[−-]?\d+(?:\.\d+)?/.exec(String(t || '').replace(/(\d)\s*±\s*[\d.]+/g, '$1')); return m ? +m[0].replace('−', '-') : null; }; // the first number of a text (not its SE)
// the size of one result, by check: the output limits (L1-L7) by their longest period against longS and their largest error against
// its limit; P1 by the lowest cell voltage against the minimum; the others from the value and the limit that the views show (display:
// the same unit), with the direction of the limit
const SIZE = {
    L: (f) => { const R = f.threshold && typeof f.threshold === 'object' ? f.threshold : {}, a = num(f.longestS) !== null && num(R.longS) > 0 ? f.longestS / R.longS : null;
        const e = f.worstError && num(f.worstError.value) !== null && num(f.worstError.limit) > 0 ? Math.abs(f.worstError.value) / f.worstError.limit : null;
        const v = [a, e].filter(x => x !== null); return v.length ? Math.max(...v) : null; },
    P1: (f) => { const L = f.limits || {}; return num(f.minCell) > 0 && num(L.min) > 0 ? L.min / f.minCell : null; },
};
function sizeOf(f, st) {
    const own = /^L\d$/.test(f.id) ? SIZE.L : SIZE[f.id];
    if (own) { const v = own(f); return v === null ? null : Math.min(ISSUE_RULES.maxSize, v); }
    const d = f.display || display(f), v = numIn(d && d.value), b = numIn(d && d.bound);
    if (v === null || b === null || b === 0) return null;
    if (v === 0) return MIN_IDS.has(f.id) || st === 'problem' ? null : 0;
    const up = Math.abs(v) / Math.abs(b);
    return Math.min(ISSUE_RULES.maxSize, st === 'problem' ? Math.max(up, 1 / up) : MIN_IDS.has(f.id) ? 1 / up : up);
}
const ISSUE_STATUS = { problem: 0, monitor: 1 };
const listOf = (a) => a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a.join('');
const logsWords = (logs) => { const l = logs.map(x => x + 1); return !l.length ? null : l.length === 1 ? `log ${l[0]}` : l.length <= 5 ? `logs ${listOf(l)}` : `${l.length} logs`; };
const profWords = (ps) => { const k = ps.filter(p => p > 0), u = ps.some(p => !(p > 0)), a = k.length ? (k.length > 1 ? `PID profiles ${listOf(k.map(String))}` : `PID profile ${k[0]}`) : null;
    return a && u ? `${a}, and PID profile unknown` : a || (u ? 'PID profile unknown' : null); };
/**
 * issues(findings) -> { issues: [{ key, id, axis, area, node, tuner, status, rank, size, small, count, logs, profiles, datasets, range
 * { min, max, unit, text }, fids, title, summary }], top: [3 keys], areas: { [area]: { status, issues: [keys], problems, monitors } } }.
 * The findings with their status (the worker's f.status, else status(f)); title and summary are STE (docs/STE_GLOSSARY.md)
 */
function issues(findings) {
    const by = new Map();
    for (const f of Array.isArray(findings) ? findings : []) {
        if (!f || typeof f.id !== 'string' || !CHECKS[f.id]) continue;
        const st = typeof f.status === 'string' ? f.status : status(f); if (!(st in ISSUE_STATUS)) continue;
        const ax = axisOf(f), key = `${f.id}|${ax || ''}`;
        if (!by.has(key)) by.set(key, { key, id: f.id, axis: ax || null, list: [] });
        by.get(key).list.push({ f, st, size: sizeOf(f, st) });
    }
    const out = [];
    for (const g of by.values()) {
        const c = CHECKS[g.id], L = g.list, status0 = L.some(x => x.st === 'problem') ? 'problem' : 'monitor';
        const main = L.filter(x => x.st === status0), sized = main.filter(x => x.size !== null), worst = sized.length ? sized.reduce((a, b) => b.size > a.size ? b : a) : main[0];
        const size = sized.length ? Math.round(worst.size * 100) / 100 : null, f0 = worst.f, logs = [...new Set(L.flatMap(x => Array.isArray(x.f.log) ? x.f.log : typeof x.f.log === 'number' ? [x.f.log] : []))].sort((a, b) => a - b);
        const profiles = [...new Set(L.map(x => profileOf(x.f)).filter(p => p !== null))].sort((a, b) => a - b), datasets = [...new Set(L.map(x => x.f.dataset).filter(x => typeof x === 'string'))].sort();
        const v = format(f0), vals = L.map(x => num(x.f.value) === null ? null : x.f.value * (format(x.f).scale || 1)).filter(x => x !== null);
        const range = vals.length ? { min: Math.min(...vals), max: Math.max(...vals), unit: v.unit || '', text: null } : { min: null, max: null, unit: v.unit || '', text: null };
        const one = (x) => `${fmt(x)}${range.unit ? ` ${range.unit}` : ''}`; // one value when the two are the same as the views show them
        if (vals.length) range.text = one(range.min) === one(range.max) ? one(range.min) : `${one(range.min)} to ${one(range.max)}`;
        // the axis before the noun, when the noun does not name it (a tail noun is of the yaw axis)
        const noun = String(c.noun || g.id), named = new RegExp(`\\b${g.axis}\\b`).test(noun) || (g.axis === 'yaw' && /\b(tail|yaw)\b/.test(noun)), title = cap(g.axis && !named ? `${g.axis} ${noun}` : noun);
        // the summary: what happens (the lead of the worst result), how large, where
        const sym = lead(f0, status0)[0] || `Check ${g.id} has a ${status0 === 'problem' ? 'problem' : 'value to monitor'}.`, d = f0.display || display(f0);
        const where = [logsWords(logs), profWords(profiles)].filter(Boolean).join(', ');
        // the largest result as the views show it (display.value: a noun phrase, or a sentence when it has its own verb) and its limit
        const big = d && d.value ? [/\b(is|are)\b/.test(d.value) ? `${cap(d.value)}.` : `The largest result is ${d.value}.`, d.bound ? `The limit is ${d.bound}.` : null].filter(Boolean).join(' ') : null;
        const count = L.length, more = `${count === 1 ? 'There is 1 result' : `There are ${count} results`}${where ? ` (${where})` : ''}.`;
        out.push({ key: g.key, id: g.id, axis: g.axis, area: areaOf(f0), node: nodeOf(f0), tuner: tunerOf(f0), status: status0, rank: 0, size, small: size !== null && size < ISSUE_RULES.small, count, logs, profiles, datasets,
            range, fids: L.map(x => x.f.fid).filter(Boolean), title, summary: [sym, big, more].filter(Boolean).join(' ') });
    }
    const rs = (x) => x.size === null ? ISSUE_RULES.zeroSize : x.size;
    out.sort((a, b) => ISSUE_STATUS[a.status] - ISSUE_STATUS[b.status] || (a.small - b.small) || rs(b) - rs(a) || b.count - a.count || a.key.localeCompare(b.key));
    out.forEach((x, i) => { x.rank = i + 1; });
    const areas = {};
    for (const x of out) { const a = x.area || 'other', A = areas[a] || (areas[a] = { status: 'monitor', issues: [], problems: 0, monitors: 0 });
        A.issues.push(x.key); if (x.status === 'problem') A.problems++; else A.monitors++;
        if (x.status === 'problem' && !x.small) A.status = 'problem'; }
    return { issues: out, top: out.slice(0, ISSUE_RULES.top).map(x => x.key), areas, rules: ISSUE_RULES };
}

module.exports = { CHECKS, LABELS, TABS, AREAS, PHASE_AT, SE_NOTE, summary, lead, display, boundOf, status, unitOf, nodeOf, areaOf, tunerOf, format, rulesOf, isThin, fmt, pair, gapCounts, headerChange, profileOf, profileLabel, axisOf, benchOf, issues, sizeOf, ISSUE_RULES };
