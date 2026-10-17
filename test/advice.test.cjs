'use strict';

// Advice (tools/autotune/advice.cjs): one test per generator and per guard on synthetic findings whose right answer is
// known in closed form, the contracts (names, coverage, purity, loading), the tuning sequence of hierarchy.cjs (nodes,
// order, causes, and the gates against the diagram status), no copied finding text, and a smoke test over the real Gaui
// X4 and Fireball results in analysis/ (skipped when those files are absent). The texts are ASD-STE100; the text
// assertions follow them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const advice = require('../tools/autotune/advice.cjs');
const setup = require('../tools/autotune/health_setup.cjs');
let H = null; try { H = require('../tools/autotune/hierarchy.cjs'); } catch (e) { /* optional: advice has a copy of its tables */ }

const ROOT = path.join(__dirname, '..');
const DYN = 1 << 29, RPMF = 1 << 30; // feature bits DYN_NOTCH, RPM_FILTER (health_setup FEATURE_BITS)
const pad = (a) => a.concat(Array(16 - a.length).fill(0));
// a 4.6 header the way the decoder returns it: PID profile values of the arming profile (log profile 1 below)
const HEADER = {
    looptime: 250, pid_process_denom: 2, frameIntervalPNum: 1, frameIntervalPDenom: 2, features: DYN | RPMF, rates_type: 6,
    rollPID: [50, 100, 0, 100, 0], pitchPID: [50, 100, 40, 100, 0], yawPID: [80, 120, 14, 20, 0], govPID: [40, 50, 0, 10, 40],
    yaw_stop_gain: [120, 80], yaw_precomp: [5, 10, 60], yaw_inertia_precomp: [0, 25], yaw_tta: [0, 20], pitch_compensation: 50,
    gyro_soft_type: 1, gyro_lowpass_hz: 100, gyro_soft2_type: 0, gyro_lowpass2_hz: 50, gyro_lowpass_dyn_hz: [0, 0],
    dyn_notch_count: 6, dyn_notch_q: 25, dyn_notch_min_hz: 20, dyn_notch_max_hz: 240, gyro_rpm_notch_preset: 1,
    gyro_rpm_notch_source_roll: pad([11, 12, 14, 21]), gyro_rpm_notch_q_roll: pad([80, 40, 60, 50]), gyro_rpm_notch_center_roll: pad([]),
    gyro_rpm_notch_source_pitch: pad([11, 12, 14, 21]), gyro_rpm_notch_q_pitch: pad([80, 40, 60, 50]), gyro_rpm_notch_center_pitch: pad([]),
    gyro_rpm_notch_source_yaw: pad([11, 12, 21]), gyro_rpm_notch_q_yaw: pad([80, 40, 50]), gyro_rpm_notch_center_yaw: pad([]),
};
const LOGS = [{ log: 5, start: '2026-10-04T10:00:00', flown: true, flyingS: 100, profileSeconds: { 1: 60, 2: 40 }, targetOf: { 1: 2300, 2: 2500 } },
    { log: 6, start: '2026-10-04T11:00:00', flown: true, flyingS: 90, profileSeconds: { 1: 90 }, targetOf: { 1: 2300 } }];
const GOV_RESPONSE = { unsaturated: { mean: 0.07, se: 0.005, n: 10 }, saturated: { mean: null, se: null, n: 0 }, feedforward: { mean: 0.3, se: 0.01, n: 10 } };
let FID = 0; // the worker gives every finding a fid before advice (SPEC2 D4)
const f = (o) => Object.assign({ fid: `t${++FID}`, module: 'loop', severity: 'flag', log: 5, profile: 1, value: null, se: null, n: 10, threshold: null, source: 'pipeline, unvalidated', text: '', times: [] }, o);
const run = (findings, o = {}) => advice.advise(Object.assign({ findings, decisions: null, header: HEADER, cli: null, logs: LOGS, fields: null, headerProfile: 1, headerLog: 5 }, o));
const recs = (out, prefix) => out.recommendations.filter(r => r.id.startsWith(prefix));
function only(out, prefix) {
    const l = recs(out, prefix);
    assert.equal(l.length, 1, `one ${prefix}, got ${out.recommendations.map(r => `${r.id} ${r.severity}`).join('; ')}`);
    return l[0];
}
const CLI_TEXT = 'diff all\n# version\n# Rotorflight / STM32F7X2 (S7X2) 4.6.0 Jun 30 2026 / 07:21:46 (118e912) MSP API: 12.9\n\n# master\nset motor_poles = 24,0,0,0\nset tail_rotor_gear_ratio = 19,76\nset gov_mode = ELECTRIC\n\nprofile 0\nset yaw_collective_ff_gain = 70\n\nprofile 1\nset gov_f_gain = 25\n';
const CLI = setup.parseCli(CLI_TEXT);
const D4_TEXT = 'header vs CLI (diff, CLI profile 0, chosen by log profile at start (1-based event value - 1)): 1 of 80 values differ: yaw_precomp[2] 60 vs yaw_collective_ff_gain 70. Trust the log header for header keys.';
// the health_setup SETUP finding of a log: its header facts, of which T14 reads the yaw setup
const SETUP_TEXT = (yaw, stop, inertia = '0,25') => `Rotorflight 4.6.0; log 1000 Hz (PID 2000, gyro 4000, decimation null Hz); LPF1 FIRST_ORDER 100, LPF2 NONE 50; dyn notch on; RPM preset 1 min 20 Hz, roll 11@1x/Q8, pitch 11@1x/Q8, yaw 11@1x/Q8; `
    + `PID R 50,100,0,100,0 P 50,100,40,100,0 Y ${yaw}; BW R 50,15,15 P 50,15,15 Y 100,20,20; gov 40,50,0,10,40 (P,I,D,F,gain); yaw stop ${stop}, precomp 5,10,60, inertia ${inertia}, TTA 0,20.`;
const setupOf = (log, yaw, stop) => f({ module: 'setup', id: 'SETUP', severity: 'note', log, profile: null, source: 'log header', text: SETUP_TEXT(yaw, stop) });
// a T14 finding as health_more judges it: value = the yaw_inertia_precomp_gain change, the peak yaw described
const T14F = (o = {}) => { const g = o.gain === undefined ? 60 : o.gain, se = o.se === undefined ? 10 : o.se;
    return f(Object.assign({ module: 'more', id: 'T14', profile: null, value: g, se, n: 6, unit: 'gain units', threshold: '>= 3 events, |gain change| - 2 SE > max(15, 0.15 x header gain) = 15, >= 80 % of the per-event fits of its sign',
        gainChange: g, gainChangeSe: se, toward: 30, towardSe: 3, events: Array.from({ length: 6 }, (_, i) => ({ t: 10 + i, value: g, toward: 30 })), text: `6 governor headspeed ramps in flight: yaw_inertia_precomp_gain change ${g} +- ${se}` }, o.f || {})); };

// ---------------------------------------------------------------------------------------------
// Data validity and setup
// ---------------------------------------------------------------------------------------------

test('D1: a slow log asks for blackbox_rate_denom; an older slow log is only information', () => {
    const flag = [f({ module: 'setup', id: 'D1', profile: null, value: 500, text: 'logging 500 Hz nominal' })];
    const slow = only(run(flag, { header: Object.assign({}, HEADER, { frameIntervalPDenom: 4 }) }), 'D1');   // PID 2 kHz / 4 = 500 Hz
    assert.equal(slow.severity, 'action');
    assert.deepEqual(slow.cli, ['set blackbox_rate_denom = 2']);                                              // 2 kHz / 2 = 1 kHz
    assert.equal(only(run(flag), 'D1').severity, 'info');                                                     // the analysed header logs at 1 kHz
});

test('D2: stalls, lost frames and parser failures are checks, never actions (guard 9)', () => {
    const out = run([f({ module: 'setup', id: 'D2', profile: null, value: 0, text: '0 logging gaps in the log; in this segment 0 time jumps (0 frames missing, by loopIteration), 2 loop stalls (time jumps over contiguous loopIteration: no frame lost), 0 non-increasing times, 0 loopIteration jumps over 9000 frames' }),
        f({ module: 'setup', id: 'D2', log: 6, profile: null, value: 3, text: '1 logging gaps in the log; in this segment 3 time jumps (40 frames missing, by loopIteration), 0 loop stalls' }),
        f({ module: 'health', id: 'D2', log: 6, profile: null, source: 'parser', text: 'log not analysed: parser: bad frame' })]);
    const r = only(out, 'D2');
    assert.equal(r.severity, 'check');
    assert.deepEqual(r.cli, []);
    assert.match(r.text, /Log 5 has 2 loop stalls and no missing frame\./);
    assert.match(r.text, /1 log has missing frames \(log 6\)/);
    assert.match(r.text, /The app cannot read 1 log \(log 6\)/);
});

test('D3: missing raw gyro or governor fields make a check', () => {
    const r = only(run([f({ module: 'setup', id: 'D3', severity: 'note', profile: null, value: 1, text: 'checks that cannot run: F5/F6/F7 (gyroRAW[0] absent, gyroRAW[1] absent, gyroRAW[2] absent)' })]), 'D3');
    assert.equal(r.severity, 'check');
    assert.match(r.text, /In 1 log, checks F5, F6 and F7 did not operate, because the log does not have `gyroRAW\[0\]`, `gyroRAW\[1\]` and `gyroRAW\[2\]`/);
});

test('D3: checks that no module implements (power/current from Ibat, G12 from EscRPM) are not asked for', () => {
    const d3 = (text) => f({ module: 'setup', id: 'D3', severity: 'note', profile: null, value: 2, text: `checks that cannot run: ${text}` });
    assert.equal(recs(run([d3('power/current (Ibat zero); G12 (independent rpm) (EscRPM absent)')]), 'D3').length, 0);
    const r = only(run([d3('F5/F6/F7 (gyroRAW[0] absent, gyroRAW[1] absent, gyroRAW[2] absent); power/current (Ibat zero)')]), 'D3');
    assert.doesNotMatch(r.text, /Ibat|power\/current/);
    assert.match(r.text, /checks F5, F6 and F7/);
});

test('D4: without a CLI dump no D4 recommendation (the dump is optional); a disagreement is a check and the contradicted CLI value is not used', () => {
    // user rule 2026-10-06: the log is the only necessary input, and no recommendation asks for a CLI dump
    assert.deepEqual(run([]).recommendations.filter(r => /^D4/.test(r.id) || /CLI dump|diff all/.test(r.title + ' ' + r.text)).map(r => r.id), []);
    assert.equal(recs(run([], { cli: CLI }), 'D4:cli').length, 0);
    const t7 = f({ id: 'T7', profile: 2, value: 0.8, se: 0.05, precompScale: 1.44, text: 'yaw I vs precomp in pumps: r 0.80 +- 0.05: precomp too small' });
    const out = run([f({ module: 'setup', id: 'D4', profile: 0, value: 1, text: D4_TEXT }), t7], { cli: Object.assign({}, CLI, { profiles: { 1: { yaw_collective_ff_gain: 70 } } }) });
    assert.equal(only(out, 'D4').severity, 'check');
    const r = only(out, 'T7');
    assert.deepEqual(r.cli, [], 'the CLI value 70 is stale and the header holds profile 1, not 2');
    assert.deepEqual([r.from, r.to], [null, null], 'no from-value from the header of PID profile 1 (SPEC2 D12)');
    assert.match(r.caveats.join(' '), /The CLI dump and the log header have different values of yaw_collective_ff_gain \(check D4\)\. The app does not use the CLI value\. Thus, there is no CLI text\./);
});

test('D5, D6: power and failsafe problems are checks; excluded spans are information', () => {
    assert.equal(only(run([f({ module: 'gov', id: 'D5', profile: null, value: 1.4, text: '3 Vbat steps above 1 V' })]), 'D5').severity, 'check');
    const out = run([f({ module: 'more', id: 'D6', value: 2.5, unit: 's', text: 'failsafe 2.5 s while airborne' }), f({ module: 'more', id: 'D6', severity: 'note', value: 10.6, unit: 's', text: 'rescue 10.6 s excluded' })]);
    assert.equal(only(out, 'D6:excluded').severity, 'info');
    const fs1 = out.recommendations.find(r => r.id === 'D6');
    assert.equal(fs1.severity, 'check');
    assert.match(fs1.text, /The failsafe was active for 2\.5 s in flight/);
});

test('H: the tuning history is summarised once', () => {
    const r = only(run([f({ module: 'setup', id: 'H', severity: 'note', log: 6, profile: 'start profile 1', value: '100,80', text: 'yaw_stop_gain: 120,80 -> 100,80 (since log 5, start profile 1)' })]), 'H');
    assert.equal(r.severity, 'info');
    assert.match(r.text, /`yaw_stop_gain` \(1\)/);
});

test('logBase: the logs named in advice texts count as the reader counts them; quoted finding texts stay as they are', () => {
    const fs1 = [f({ module: 'more', id: 'D6', profile: null, value: 2.5, unit: 's', text: 'failsafe 2.5 s while airborne at log 5' })];
    assert.match(only(run(fs1), 'D6').text, /in flight \(log 5\)/);
    assert.match(only(run(fs1, { logBase: 1 }), 'D6').text, /in flight \(log 6\)/);
    assert.equal(only(run(fs1, { logBase: 1 }), 'D6').evidence[0].log, 5, 'evidence keeps the toolkit log index');
});

test('SETUP: header rules for rates_type and the temporary I-gain trick', () => {
    const out = run([], { header: Object.assign({}, HEADER, { rates_type: 4, rollPID: [50, 200, 0, 100, 0] }) });
    assert.match(only(out, 'SETUP:rates_type').text, /ACTUAL/);
    assert.equal(only(out, 'SETUP:roll_i_gain').severity, 'check');
    assert.equal(recs(run([]), 'SETUP').length, 0);
});

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------

test("Filter setup guides and D-term fractions retain measurements without unvalidated parameter changes", () => {
    const cases=[['F1',0],['F2',40],['F3',1.5],['F4',40],['C11',0.97],['F10',0.97]];
    for(const [id,value] of cases){
        const finding=f({module:id==='C11'?'loop':'setup',id,axis:'yaw',value,se:.005});
        const r=only(run([finding],{header:{...HEADER,gyro_soft_type:0,gyro_lowpass_hz:0}}),id);
        assert.equal(r.severity,'info',id);assert.deepEqual(r.cli,[],id);
        assert.equal(r.parameter,null,id);assert.equal(r.evidence[0].value,value,id);
        assert.equal(advice.script([r]),'',id);
    }
});

test("A cutoff below the setup guide requires replay rather than an unconditional cutoff increase", () => {
    for(const value of [1,40,60,70,100]) {
        const r=only(run([f({id:'F2',module:'setup',value,profile:null})],{header:{...HEADER,gyro_lowpass_hz:value}}),'F2');
        assert.equal(r.severity,'info');assert.deepEqual(r.cli,[]);assert.equal(r.evidence[0].value,value);
    }
});

test("Narrow and broad notch choices require measured attenuation and delay", () => {
    for(const preset of [0,1]) {
        const h={...HEADER,gyro_rpm_notch_preset:preset,gyro_rpm_notch_q_roll:pad([15]),dyn_notch_q:15};
        const r=only(run([f({id:'F3',module:'setup',profile:null,value:1.5})],{header:h}),'F3');
        assert.equal(r.severity,'info');assert.deepEqual(r.cli,[]);assert.equal(r.to,null);
    }
});

test('F4: D cutoff away from 20 Hz is advisory information', () => {
    const r = only(run([f({ module: 'setup', id: 'F4', severity: 'note', profile: 'yaw', value: 40, text: 'yaw D cutoff 40 Hz, +20 Hz from the documented ~20 Hz; advisory only.' })]), 'F4');
    assert.equal(r.severity, 'info');
    assert.equal(r.parameter, null);
    assert.equal(r.evidence[0].value,40);
    assert.deepEqual(r.cli, []);
});

// the project rule (CLAUDE.md, SPEC2 section 6): the configured gear ratios are correct, and no text doubts a ratio, a pulley or
// a tooth count (the same pattern as the GEAR check of test/ste_text.test.cjs)
const GEAR_TERM = /\b(?:gear[\s-]*ratios?|gear\s+trains?|gearing|gears?|pulleys?|tooth|teeth|pinions?|(?:main|primary)\s+drive)\b/i;
const GEAR_DOUBT = /\b(?:incorrect|wrong|not\s+correct|errors?|mistakes?|examine|inspect|make\s+sure|measure|test|compare|verify|confirm|check(?!\s+[A-Z]{1,6}\d)|change|replace|mismatch\w*|do(?:es)?\s+not\s+agree|suspect\w*|possibl[ey])\b/i;
const ownTexts = (r) => [r.title, r.text, r.rule].concat(r.caveats, r.blockedBy);   // causes[].first are hierarchy.cjs texts (P2)
function noGearDoubt(out) {
    const texts = out.recommendations.flatMap(ownTexts).concat(out.notes, out.coverage.map(c => c.detail));
    for (const t of texts) for (const sen of String(t).replace(/`[^`]*`/g, 'X').split(/(?<=[.!?])\s+/)) assert.ok(!(GEAR_TERM.test(sen) && GEAR_DOUBT.test(sen)), `gear rule: ${sen}`);
}

test("F5: raw line and RPM placement information does not prescribe untested filter changes", () => {
    for(const order of [1,3,3.789,4.061,8,9,11.95])for(const cli of [null,CLI]) {
        const text=`line at ${order} x rotor (300 Hz, prominence 40, rotor-locked): nearest notch roll none, pitch none, yaw none`;
        const finding=f({module:'setup',id:'F5',value:order,text});
        const out=run([finding],{cli}),r=only(out,'F5');
        assert.equal(r.severity,'info');assert.deepEqual(r.cli,[]);assert.equal(r.evidence[0].text,text);
        assert.match(r.rule,/static notch filter or a dynamic notch filter/);noGearDoubt(out);
    }
});



test('notes: excluded spans are named for the pilot and zeros are left out', () => {
    const out = run([], { logs: [Object.assign({}, LOGS[0], { excluded: { rescueS: 10.6, levelModeS: 0, failsafeS: 0.02, groundS: 5, guardS: 2 } })] });
    assert.ok(out.notes.includes('The analysis did not use these parts of the logs: rescue 10.6 s, ground contact 5 s, the time around them 2 s.'), out.notes.join('\n'));
});

test('T13: a constant hover yaw I names the trim and the collective precomp, never the P/I/D gains', () => {
    const r = only(run([f({ module: 'more', id: 'T13', value: -0.24, se: 0.004, text: 'hover yaw I -303 +- 5 permille' })]), 'T13');
    assert.deepEqual(r.cli, []);
    assert.match(r.text, /tail center trim and mechanical center/);
    assert.match(r.text, /If the I-term changes with collective, use check T7/);
});





test('F6: attenuation below 10 dB is a check; one not below 10 dB by 2 SE is a watch', () => {
    assert.equal(only(run([f({ module: 'setup', id: 'F6', value: 6, se: 1, text: 'yaw notch 21 ...: 6 +- 1 dB' })]), 'F6').severity, 'check');
    assert.equal(only(run([f({ module: 'setup', id: 'F6', value: 9, se: 2, text: 'yaw notch 21 ...: 9 +- 2 dB' })]), 'F6').severity, 'watch'); // 9 + 4 > 10
});

test('F8, F9: the dynamic notch range is compared with the strongest uncovered line', () => {
    const out = run([f({ module: 'setup', id: 'F5', value: 3.789, text: 'line at 3.789 x rotor (284.1 Hz, prominence 400, rotor-locked): nearest notch roll none, pitch none, yaw none' }),
        f({ module: 'setup', id: 'F8', severity: 'note', profile: null, value: false, text: 'dynamic notch off (count 6), PID rate 2000 Hz; 3 strong line-profile pair(s) without RPM notch coverage (see F5).' }),
        f({ module: 'setup', id: 'F9', severity: 'note', profile: null, value: 0, text: '9 bank-profile pairs of unknown frequency (no gear ratios).' })], { cli: CLI });
    assert.match(only(out, 'F8').text, /The strongest line with no notch filter is at 284\.1 Hz, which is more than this maximum/);
    assert.equal(only(out, 'F9').severity, 'info');
});

test("A yaw D-term power fraction does not justify reducing D gain", () => {
    for(const value of [.49,.8,.97])for(const rms of [.001,1,100]) {
        const r=only(run([f({module:'more',id:'F10',axis:'yaw',value,se:.001,rms,unit:'fraction'})]),'F10');
        assert.equal(r.severity,'info');assert.deepEqual(r.cli,[]);assert.equal(r.to,null);
        assert.match(r.rule,/does not give the D-term RMS value/);
    }
});

test('F7, F11: a vibration level change and a large measured filter delay are checks', () => {
    assert.equal(only(run([f({ module: 'more', id: 'F11', axis: 'roll', value: 14, se: 1, threshold: 'delay - 2 SE > 10 ms', unit: 'ms', text: 'roll gyro filter delay 14 +- 1 ms' })]), 'F11').severity, 'check');
    assert.match(only(run([f({ module: 'spectra', id: 'F7', value: 2.4, text: 'gyroRAW above 30 Hz x2.4 between groups' })]), 'F7').text, /blade tracking and the balance/);
});

// ---------------------------------------------------------------------------------------------
// Governor
// ---------------------------------------------------------------------------------------------

test('G0, G1: DIRECT is information, FALLBACK a check, the glitch proxy a watch', () => {
    assert.equal(only(run([f({ module: 'gov', id: 'G0', severity: 'note', profile: null, value: 0, text: 'govSum and govI are 0 in flight: DIRECT or LIMIT, no PID governor.' })]), 'G0').severity, 'info');
    const fallback = only(run([f({ module: 'gov', id: 'G1', profile: null, value: 2, text: '2 FALLBACK entries at 30.1 s' })]), 'G1');
    assert.equal(fallback.severity, 'check');
    assert.equal(fallback.title, 'Examine the cause of FALLBACK');
    assert.match(fallback.text, /FALLBACK does not show that the RPM source is incorrect/);
    assert.match(fallback.text, /FALLBACK mode switch that is on/);
    assert.match(fallback.text, /Examine the FALLBACK mode switch, RPM signal, headspeed and throttle at each entry/);
    assert.match(fallback.text, /If you find an RPM source problem, repair it/);
    assert.doesNotMatch(fallback.text, /Repair the RPM source|signal was not available|signal is not available or not correct/);
    assert.equal(only(run([f({ module: 'gov', id: 'G1', severity: 'note', profile: null, value: 3, text: '3 glitch-proxy events in flight' })]), 'G1:proxy').severity, 'watch');
});

test('G2, G5, G6, G8, G10, G11, G13, G14: diagnostics are checks without CLI', () => {
    for (const id of ['G2', 'G5', 'G6', 'G8', 'G10', 'G11', 'G13', 'G14']) {
        const r = only(run([f({ module: 'gov', id, value: 1, text: `${id} finding` })]), id);
        assert.equal(r.severity, ['G5', 'G10'].includes(id) ? 'watch' : 'check', id);
        assert.deepEqual(r.cli, [], id);
    }
    const cells = only(run([f({ module: 'gov', id: 'G13', severity: 'note', profile: null, text: 'no finding: cell count ambiguous (inferred); Vbat in flight 22.1 -> 21.0 V. The log does not record the cell count' })]), 'G13:cells');
    assert.equal(cells.severity, 'info');
    // a description: no instruction to change the flight controller so that the analysis can operate (user rule 2026-10-06)
    assert.equal(cells.text, 'The battery voltage before the flight agrees with more than one cell count. The log does not record the cell count. Thus, checks D5, G8 and G13 did not examine each cell.');
});

test('G3: droop with F carrying less than half raises gov_f_gain by the documented 10; headroom is a check', () => {
    const r = only(run([f({ module: 'gov', id: 'G3', governorResponse: GOV_RESPONSE, log: [5, 6], value: 0.07, se: 0.005, text: 'droop 7.00 % +- 0.50 %; F carries 30 % of the added govSum. F carries less than half: F too low (GOVT)' })]), 'G3');
    assert.deepEqual([r.from, r.to], [10, 20]);                                  // header govPID F 10, step 10
    assert.deepEqual(r.cli, ['profile 0', 'set gov_f_gain = 20']);
    assert.match(r.caveats.join(' '), /The step of the documentation, 10, is 50 % or more of the value 10/);
    const h = only(run([f({ module: 'gov', id: 'G3', log: [5], value: 0.07, se: 0.005, text: 'droop 7 %. Most events saturate: headroom (G6), not F' })]), 'G3');
    assert.equal(h.severity, 'check');
});

test('G4: overshoot at load onset lowers gov_f_gain; against a G3 raise it becomes a check', () => {
    const g4 = f({ module: 'gov', id: 'G4', log: [5], value: 0.05, se: 0.004, text: 'headspeed overshoots 5.00 % +- 0.40 % on collective rises (load onset), F carries 40 % of the added govSum: F too high (GOVT)' });
    const r = only(run([g4], { cli: CLI }), 'G4');
    assert.deepEqual([r.from, r.to, r.direction], [10, 0, 'lower']);
    const both = only(run([g4, f({ module: 'gov', id: 'G3', governorResponse: GOV_RESPONSE, log: [5], value: 0.07, se: 0.005, severity: 'flag', text: 'droop 7 %: F too low (GOVT)' })]), 'G3');
    assert.equal(both.severity, 'check');
    assert.match(both.caveats.join(' '), /The checks do not agree on gov_f_gain: G3 increases it to 20 and G4 decreases it to 0/);
    assert.equal(only(run([f({ module: 'gov', id: 'G4', log: [5], value: 0.05, se: 0.004, text: 'overshoot after collective drops 5 %' })]), 'G4:drop').severity, 'check');
});

test('G9: a P-type oscillation cuts gov_p_gain by the GOVT 1/3, bounded to 20 %; a peak below 2 SE is a watch', () => {
    const p = f({ module: 'gov', id: 'G9', value: 9, se: 1, text: 'headspeed error peak at 4 Hz in 3-10 Hz (P-type): governor P or gain too high' });
    const r = only(run([p]), 'G9');
    assert.deepEqual(r.cli, ['profile 0', 'set gov_p_gain = 32']);                 // 40 x 2/3 = 26.7, bounded to 40 x 0.8 (guard 5)
    assert.match(r.caveats.join(' '), /The step is 20 % or less\. GOVT decreases the gain by 1\/3, to 26\.7\./);
    assert.match(r.rule, /reduce it with 1\/3/);
    const w = only(run([f({ module: 'gov', id: 'G9', severity: 'note', value: 5.01, se: 1.94, text: 'peak in 0.3-3 Hz (I-type), prominence 5.01 +- 1.94: above the threshold but not by 2 SE' })]), 'G9');
    assert.deepEqual([w.severity, w.parameter, w.to], ['watch', 'gov_i_gain', 40]);  // 50 x 2/3, bounded: 40 (the raise step 25 gave 25)
    assert.deepEqual(w.cli, []);
    // at GOVT's own starting values (P about 10, I about 20) a cut by the raise step took the gain to 0
    const low = Object.assign({}, HEADER, { govPID: [10, 20, 0, 10, 40] });
    assert.deepEqual(only(run([p], { header: low }), 'G9').cli, ['profile 0', 'set gov_p_gain = 8']);
    assert.deepEqual(only(run([f({ module: 'gov', id: 'G9', value: 9, se: 1, text: '(I-type)' })], { header: low }), 'G9').cli, ['profile 0', 'set gov_i_gain = 16']);
});

test('G12: a wrong headspeed factor is an action with the pole count that would fit; it names motor_poles and the RPM sensor, never the gear ratio', () => {
    const g12 = f({ module: 'gov', id: 'G12', profile: null, value: 1.2, se: 0.001, text: 'main rotor line at 1.2 x' });
    const out = run([g12, f({ module: 'setup', id: 'F6', value: 6, se: 1, text: 'f6' }), f({ module: 'gov', id: 'G6', value: 90, text: 'median throttle 90 %' })], { cli: CLI }), r = only(out, 'G12');
    assert.equal(r.severity, 'action');
    assert.equal(r.title, 'Incorrect headspeed: examine motor_poles and the RPM sensor');
    assert.match(r.text, /The gear ratios in the configuration are correct\. Examine motor_poles and the RPM sensor/);
    assert.match(r.text, /If motor_poles causes the error, 20 gives the correct headspeed, not 24/);   // 24 / 1.2
    assert.doesNotMatch(r.text + r.title, /main_rotor_gear_ratio|gear ratio is/);
    assert.match(only(out, 'F6').text, /The gear ratios in the configuration are correct\. If check G12 shows a problem, motor_poles or the RPM sensor can be the cause\./);
    assert.doesNotMatch(only(out, 'G6').text, /gear/);
    noGearDoubt(out);
});

// ---------------------------------------------------------------------------------------------
// Cyclic
// ---------------------------------------------------------------------------------------------

test('C1, C2, C6, C10, C11: diagnostics are checks; landed while moving is a watch (CYC-LANDED refuted it)', () => {
    for (const [id, axis] of [['C1', 'roll'], ['C2', null], ['C6', 'pitch'], ['C10', null], ['C11', 'pitch']]) {
        const r = only(run([f({ id, axis, value: id === 'C6' ? 12 : 0.9, se: 0.01, text: `${axis || ''} ${id} finding at an output limit (mixer[1])` })]), id);
        assert.equal(r.severity, id==='C11'?'info':'check', id);
        assert.deepEqual(r.cli, [], id);
    }
    const landed = only(run([f({ id: 'C10', profile: null, value: 1, text: '1.0 s spooled up and turning while the firmware says landed (ground decay active)' })]), 'C10');   // Fireball 09-28 #1
    assert.deepEqual([landed.id, landed.severity, landed.cli], ['C10:landed', 'info', []], 'SPEC3 F: information only');
    assert.match(landed.caveats.join(' '), /On a different helicopter \("SAB Fireball"\), a test showed that this test is not correct\. This result is not from your logs\./);
});

test('C3: F x (1 + I share), pooled over logs, bounded to 20 %', () => {
    const c3 = (share, se, log = 5) => f({ id: 'C3', axis: 'roll', log, value: share, se, gyroRatio: { mean: 1, se: 0.01 }, text: 'roll: I share: I carries the rate, FF too low (raise F)' });
    const r = only(run([c3(0.15, 0.02), c3(0.15, 0.02, 6)]), 'C3');
    assert.deepEqual([r.from, r.to, r.confidence], [100, 115, 'measured']);
    assert.deepEqual(r.cli, ['profile 0', 'set roll_f_gain = 115']);
    const big = only(run([c3(0.5, 0.05)]), 'C3');
    assert.equal(big.to, 120);
    assert.match(big.caveats.join(' '), /The step is 20 % or less\. The measurement gives 150\./);
    assert.equal(only(run([c3(-0.3, 0.05)]), 'C3').to, 80);
    const ratio = only(run([f({ id: 'C3', axis: 'roll', value: 0.02, se: 0.01, gyroRatio: { mean: 0.8, se: 0.02 }, text: 'roll: rate off the setpoint' })]), 'C3');
    assert.deepEqual([ratio.severity, ratio.parameter], ['check', null]);
});

test('C4: stop I direction gives a bounded F trial in either direction', () => {
    const low = only(run([f({ id: 'C4', axis: 'pitch', value: 25, se: 3, settleS: { mean: 0.2, se: 0.02 }, text: 'pitch stops: overshoot 25 %: I charged with the rotation at the stop: FF too low (raise F)' })]), 'C4');
    assert.deepEqual([low.from, low.to], [100, 110]);
    const high = only(run([f({ id: 'C4', axis: 'pitch', value: 25, se: 3, text: 'pitch stops: FF too high (lower F), or relax/B' })]), 'C4');
    assert.equal(high.severity, 'action');
    assert.deepEqual([high.from, high.to, high.cli], [100, 90, ['profile 0', 'set pitch_f_gain = 90']]);
    assert.match(high.text, /not a measured best value/);
    assert.match(high.caveats.join(' '), /relax and B gain/);
    const settle = only(run([f({ id: 'C4', axis: 'pitch', value: 5, se: 3, settleS: { mean: 0.6, se: 0.05 }, text: 'FF too low (raise F)' })]), 'C4');
    assert.equal(settle.severity, 'action', 'the settling time clears 0.3 s by 2 SE although the overshoot does not');
});

test('C5, T1: self-excited oscillation is a check, one burst or oscillation present a watch', () => {
    assert.equal(only(run([f({ module: 'track', id: 'C5', axis: 'roll', value: 2, unit: 'bursts', text: '2 self-excited bursts at 12 Hz' })]), 'C5:roll').severity, 'check');
    assert.equal(only(run([f({ module: 'track', id: 'C5', severity: 'note', axis: 'roll', value: 0.08, se: 0.01, text: 'oscillation present' })]), 'C5:roll:watch').severity, 'watch');
    // one burst, as Fireball #3 at 331.3 s, whose cause analysis/fireball-0928 could not pin on the gain margin (TAIL-EVENT3)
    const one = only(run([f({ module: 'track', id: 'T1', axis: 'yaw', value: 1, text: '1 self-excited burst' })]), 'T1:yaw');
    assert.deepEqual([one.area, one.severity], ['tail', 'watch']);
    assert.match(one.text, /1 period cannot show the difference between the loop gain, the load, a time delay and a low battery/);
    const two = only(run([f({ module: 'track', id: 'T1', axis: 'yaw', value: 1, text: '1 self-excited burst' }), f({ module: 'track', id: 'T1', axis: 'yaw', log: 6, value: 1, text: '1 self-excited burst' })]), 'T1:yaw');
    assert.equal(two.severity, 'check', 'one burst in each of two logs');
});

// findings in the shape health_track judges them: thresholds as text, a flag only past 2 SE (value - 2 SE > threshold)
const TRACK = (id, o) => f(Object.assign({ module: 'track', id, threshold: /^(C13|T12)$/.test(id) ? 'delay - 2 SE > 120 ms flag, else report only'
    : id === 'R1' ? 'delay - 2 SE > 40 ms flag, else report only' : 'value - 2 SE > 0.45 flag, value > 0.3 note' }, o));
test('C12, T11, C13, T12, R1: outcome and lag checks as health_track judges them (thresholds as text, flags past 2 SE)', () => {
    const c12 = only(run([TRACK('C12', { axis: 'roll', value: 0.6, se: 0.05, unit: 'fraction', text: 'roll tracking error 60 %' })]), 'C12');
    assert.equal(c12.severity, 'check');
    const T = require('../tools/autotune/health_track.cjs').RULE.track;
    assert.ok(c12.rule.includes(`It uses the gyro and the setpoint at less than ${T.lpHz} Hz, and the samples with \`|setpoint| > ${T.minAbsSetpoint} deg/s\`.`), `the rule names health_track's definition: ${c12.rule}`);
    assert.equal(only(run([TRACK('T11', { severity: 'note', axis: 'yaw', value: 0.35, se: 0.02, text: 'yaw tracking error 35 %: mild' })]), 'T11').severity, 'watch');
    // 130 +- 10 ms does not pass 120 ms by 2 SE: health_track writes a note, which is no lag recommendation
    assert.equal(recs(run([TRACK('C13', { severity: 'note', axis: 'pitch', value: 130, se: 10, unit: 'ms', text: 'pitch setpoint to gyro delay 130 +- 10 ms; report only' })]), 'C13').length, 0);
    assert.equal(only(run([TRACK('T12', { axis: 'yaw', value: 160, se: 10, unit: 'ms', text: 'yaw lag 160 ms' })]), 'T12').severity, 'check');
    const r1 = only(run([TRACK('R1', { axis: 'roll', profile: null, value: 80, se: 5, unit: 'ms', text: 'roll stick to setpoint 80 ms' })]), 'R1');
    assert.equal(r1.area, 'rates'); assert.equal(r1.node, 'controller', 'R1 is information of the flight controller (SPEC3 A)');
    assert.match(r1.rule, / more than 40 ms by 2 SE\. Sources?: /, 'the threshold comes from health_track DEFAULT_RULES');
    const mixed = only(run([TRACK('C13', { axis: 'pitch', profile: 1, value: 170, se: 10, text: 'pitch lag 170 ms' }),
        TRACK('C13', { severity: 'note', axis: 'pitch', profile: 2, value: 125, se: 20, text: 'pitch lag 125 ms; report only' })]), 'C13');
    assert.equal(mixed.severity, 'check', 'profile 1 clears 120 ms by 2 SE although profile 2 does not');
});

test('C12, T11: every measured pair of the PID profile is pooled, ok ones too; the title counts the pairs above the note level', () => {
    // as Gaui X4 file 50: one yaw pair at 40.5 +- 5.7 %, the others ok at 12-29 %. The gains are values of one PID profile:
    // the estimate pools the pairs of PID profile 1 only (SPEC2 D-LOW), and PID profiles 2 and 3 have no recommendation
    const ok = [[23, 1, 0.294, 0.042], [32, 1, 0.26, 0.027], [39, 1, 0.271, 0.016], [48, 2, 0.124, 0.028], [49, 2, 0.144, 0.006], [49, 3, 0.132, 0.026]]
        .map(([log, profile, value, se]) => TRACK('T11', { severity: 'ok', axis: 'yaw', log, profile, value, se, text: `yaw tracking error ${value}` }));
    const high = TRACK('T11', { severity: 'note', axis: 'yaw', log: 38, profile: 1, value: 0.405, se: 0.057, text: 'yaw tracking error 40.5 +- 5.7 %: mild' });
    const r = only(run([high, ...ok]), 'T11');
    assert.deepEqual([r.id, r.profile, r.title], ['T11:yaw:p1', 1, 'Yaw tracking error more than 30 % in 1 of 4 results (PID profile 1)']);
    assert.equal(r.severity, 'watch');
    assert.equal(r.evidence.length, 4);
    assert.ok(r.evidence.every(e => e.profile === 1), 'no pair of PID profile 2 or 3');
    const m = /All 4 together give ([\d.]+) ±/.exec(r.text);
    assert.ok(m && +m[1] < 30, r.text);                                           // the note pair alone read 40.5 %
    assert.match(r.text, /The largest is 40\.5 ± 5\.7 % \(log 38, PID profile 1\)/);
    // the note pair was measured before a later yawPID change on its start profile (H): a caveat, as parameter recs get
    const h = f({ module: 'setup', id: 'H', severity: 'note', log: 46, profile: 'start profile 1', value: '160,180,30,10,10', text: 'yawPID: 100,140,14,0,0 -> 160,180,30,10,10 (since log 39, start profile 1)' });
    const old = only(run([high, ...ok, h]), 'T11');
    assert.match(old.caveats.join(' '), /1 of the 1 results more than 30 % are from logs before a change of yawPID and yaw_stop_gain on their PID profile \(log 38, PID profile 1: yawPID changed from 100,140,14,0,0 to 160,180,30,10,10 in log 46\)\. Thus, they can be from different values\./);
    assert.equal(recs(run(ok), 'T11').length, 0, 'ok pairs alone give no recommendation');
});

test('C14: measured compensation has a bounded first step from zero', () => {
    const c14 = f({ module: 'more', id: 'C14', axis: 'pitch', value: 30, se: 4, threshold: '|slope| - 2 SE > 20, a gain change >= 10, the fast coupling not of the other sign by 2 SE', gainChange: 30, gainChangeSe: 8, from: 50, to: 80, unit: 'per 1000 collective', text: 'pitch I + O 30.0 +- 4.0 per 1000 collective: raise pitch_collective_ff_gain 50 -> 80' });
    const r = only(run([c14]), 'C14');
    assert.deepEqual([r.from, r.to], [50, 60]);                                  // 50 + 30 bounded to 50 x 1.2
    assert.deepEqual(r.cli, ['profile 0', 'set pitch_collective_ff_gain = 60']);
    const zero = only(run([c14], { header: Object.assign({}, HEADER, { pitch_compensation: 0 }) }), 'C14');
    assert.deepEqual([zero.severity, zero.from, zero.to, zero.cli], ['action', 0, 10, ['profile 0', 'set pitch_collective_ff_gain = 10']]);
    assert.match(zero.rule, /measured change minus 2 SE/);
});

test('control trials retain uncertainty, profile scope, source and prerequisite checks', () => {
    const stop = over => f({id:'C4',axis:'pitch',value:25.7,se:2.9,settleS:{mean:0.2,se:0.02},text:'FF too high (lower F)',...over});
    const target = only(run([stop()]),'C4');
    assert.deepEqual([target.parameter,target.from,target.to],['pitch_f_gain',100,90]);
    assert.equal(target.evidence[0].value,25.7);
    assert.equal(target.evidence[0].se,2.9);
    assert.match(target.rule,/more than 10 %/);
    assert.equal(only(run([stop({value:13,se:3})]),'C4').cli.length,0,'below 2 SE');
    assert.equal(recs(run([stop({thin:true})]),'C4').length,0,'thin data produces no trial');
    const mixed = only(run([stop(),stop({log:6,text:'FF too low (raise F)'})]),'C4');
    assert.equal(mixed.parameter,null,'contradictory stop directions do not pick a gain');
    const other = only(run([stop({profile:2})]),'C4');
    assert.equal(other.from,null,'no borrowing the arming-profile value');
    assert.deepEqual(other.cli,[]);
    const held = only(run([stop({text:'FF too low (raise F)'}),f({module:'setup',id:'F6',profile:null,value:4,se:.5})],
        {header:{...HEADER,gyro_soft_type:0,gyro_lowpass_hz:0}}),'C4');
    assert.equal(held.to,110,'prerequisite does not erase a quantitative proposal');
    assert.ok(held.blockedBy.length);
    assert.ok(held.holds.includes('filters'),'guard prerequisites remain available to control autotune');
    assert.deepEqual(held.cli,[]);
});

test('C14: zero start cannot exceed the positive measured change minus 2 SE', () => {
    const base=f({module:'more',id:'C14',axis:'pitch',value:50,se:2,gainChange:11,gainChangeSe:4,unit:'per 1000 collective'});
    const opts={header:{...HEADER,pitch_compensation:0}};
    assert.deepEqual(only(run([base],opts),'C14').cli,[],'a lower confidence bound of 3 does not pass the minimum gain-change rule');
    assert.equal(only(run([{...base,gainChange:19}],opts),'C14').to,10,'a justified start remains bounded to 10');
    for(const gainChangeSe of [null,6]) {
        const r=only(run([{...base,gainChangeSe}],opts),'C14');
        assert.deepEqual(r.cli,[],'unknown uncertainty or unresolved direction cannot start a gain');
    }
});

test('G5 and G10 generate quantified governor trials with saturation and uncertainty gates', () => {
    const slow=f({module:'gov',id:'G5',value:2,se:0.1});
    const p=only(run([slow]),'G5');
    assert.deepEqual([p.from,p.to,p.cli],[40,50,['profile 0','set gov_p_gain = 50']]);
    assert.equal(only(run([{...slow,value:0.4,se:0.2}]),'G5').cli.length,0);
    for(const id of ['G6','L1']) {
        const r=only(run([slow,f({module:'gov',id,value:90,channel:'throttle',text:'median throttle 90 %'})]),'G5');
        assert.deepEqual(r.cli,[]);assert.match(r.blockedBy.join(' '),/throttle/);
    }
    const coherent=f({module:'gov',id:'G10',value:0.9,se:0.03});
    const g=only(run([coherent]),'G10');
    assert.deepEqual([g.from,g.to,g.cli],[40,36,['profile 0','set gov_gain = 36']]);
    assert.equal(only(run([{...coherent,value:0.61,se:0.1}]),'G10').cli.length,0);
});

test('C6 and T2 lower I only with measured I dominance, retaining unknown spectral uncertainty', () => {
    for(const [id,axis,from] of [['C6','pitch',100],['T2','yaw',120]]) {
        const peak=f({id,axis,value:12,n:9,text:'slow oscillation driven by I: I too high or P too low'});
        const r=only(run([peak]),id);
        assert.deepEqual([r.from,r.to],[from,from*0.9]);
        assert.match(r.text,/no SE/);assert.match(r.text,/50 %/);
        const other=only(run([{...peak,text:'slow oscillation not driven by I'}]),id);
        assert.equal(other.parameter,null);assert.equal(other.cli.length,0);
    }
});

test('F10, C14: the estimate pooled over the logs of a profile must pass the module threshold by 2 SE (their findings give it as text)', () => {
    const more = require('../tools/autotune/health_more.cjs'), share = more.DEFAULT_RULES.F10.share, slope = more.DEFAULT_RULES.C14.flag;
    const f10 = (log, sev, value, se) => f({ module: 'more', id: 'F10', severity: sev, axis: 'yaw', log, value, se, unit: 'fraction', threshold: `D share - 2 SE > ${share} (yaw; roll and pitch are judged by C11)`, text: `yaw axisD power above 30 Hz ${value * 100} %` });
    // one flight flags (0.75 +- 0.10), the other does not (0.30 +- 0.05): pooled 0.39 +- 0.23, below 0.5 by 2 SE
    const w = only(run([f10(5, 'flag', 0.75, 0.10), f10(6, 'ok', 0.30, 0.05)]), 'F10');
    assert.deepEqual([w.severity, w.cli], ['info', []]);
    assert.deepEqual(only(run([f10(5,'flag',.75,.05),f10(6,'flag',.8,.05)]),'F10').cli,[]);
    const c14 = (log, sev, value) => f({ module: 'more', id: 'C14', severity: sev, axis: 'pitch', log, value, se: 4, gainChange: value, gainChangeSe: 4, unit: 'per 1000 collective',
        threshold: `|slope| - 2 SE > ${slope}, a gain change >= 10, the fast coupling not of the other sign by 2 SE`, text: `pitch I + O ${value} +- 4 per 1000 collective` });
    const cw = only(run([c14(5, 'flag', 30), c14(6, 'note', 5)]), 'C14');            // pooled 17.5 +- 12.5 against 20
    assert.deepEqual([cw.severity, cw.cli], ['watch', []]);
    assert.match(cw.rule, new RegExp(`for each 1 deg of collective \\(mixer units: 1000 is 12 deg\\)\\. It has a problem if this value, without its sign, is more than ${String(+(slope / 1000).toFixed(3))} deg by 2 SE`), 'the rule prints the numbers, not RULES.C14.flag');
});

// ---------------------------------------------------------------------------------------------
// Tail
// ---------------------------------------------------------------------------------------------

test('T2, T4, T8, T13, T14: tail diagnostics are checks; a motorised tail needs a diagnosis before a hardware or TTA change', () => {
    for (const [id, sev] of [['T2', 'flag'], ['T3', 'flag'], ['T4', 'note'], ['T8', 'flag'], ['T10', 'flag'], ['T13', 'flag'], ['T14', 'flag']]) {
        const r = only(run([id === 'T14' ? T14F() : f({ id, severity: sev, value: id === 'T2' ? 12 : 1, se: 0.1, threshold: 0.15, text: `${id} finding: suspect mechanics` })]), id);
        assert.equal(r.severity, id === 'T4' ? 'watch' : 'check', id);   // T4: its frequency test is the one TAIL-FREQ refuted
        assert.deepEqual(r.cli, [], id);
    }
    const mot = only(run([f({ id: 'T8', value: 2, text: '20 episodes' })], { cli: setup.parseCli(CLI_TEXT.replace('# master\n', '# master\nset tail_rotor_mode = MOTORIZED\n')) }), 'T8');
    assert.match(mot.text, /the log does not show a correct mechanical change/);
});

test('T14: the present yaw setup leads; flags measured on other yaw gains are context, never the target', () => {
    // HEADER yaw 80,120,14,20,0 / stop 120,80 / inertia 0,25. Log 5 flew older gains and flagged; log 6 flies the present ones
    const setups = [setupOf(5, '80,120,10,0,0', '120,80'), setupOf(6, '80,120,14,20,0', '120,80')], oldFlag = T14F({ gain: 300, se: 40, f: { log: 5 } });
    const quiet = T14F({ gain: 10, se: 20, f: { log: 6, severity: 'note', events: [1, 2, 3, 4, -5, 6].map((v, i) => ({ t: i, value: v * 5, toward: 8 })) } });
    const w = only(run([...setups, oldFlag, quiet]), 'T14');
    assert.deepEqual([w.severity, w.cli, w.to], ['watch', [], null]);
    assert.match(w.title, /less than the T14 limit with the yaw values of the selected log/);
    assert.match(w.text, /The logs with the yaw values of the selected log \(yaw PID 80,120,14,20,0, stop 120,80, inertia 0,25: log 6\) have 6 headspeed ramps/);
    assert.doesNotMatch(w.text, /Increase yaw_inertia/, 'no increase from the old flag');
    assert.match(w.caveats.join(' '), /Other yaw values show a problem, but the analysis measured them with different gains\. They are information, not a target: log 5 \(yaw PID 80,120,10,0,0, stop 120,80, inertia 0,25\), gain change 300 ± 40/);
    // no measured log on the present gains: re-measure
    const none = only(run([...setups, oldFlag]), 'T14');
    assert.deepEqual([none.severity, none.title], ['watch', 'Yaw at headspeed ramps: measure again with the yaw values of the selected log']);
    // the present gains flag, pooled: a check, the old flag still context only. From 0 the step rule gives no target (SPEC2
    // D-M4: 20 % or less of the value at this time), and the estimate stays information
    const now = only(run([...setups, oldFlag, T14F({ gain: 60, se: 10, f: { log: 6 } })]), 'T14');
    assert.deepEqual([now.severity, now.profile, now.from, now.to, now.direction, now.cli], ['check', 1, 0, null, 'raise', []]);
    assert.match(now.text, /The fit estimates a yaw_inertia_precomp_gain change of 60 ± 10/);
    assert.match(now.text, /yaw_inertia_precomp_gain is 0 \(log header, PID profile 1 at the start of the log\)\. The app cannot calculate a step from 0, but a flight with a small value gives a new measurement\./);
    assert.doesNotMatch(now.text, /Increase yaw_inertia|from 0 to/, 'a check has no instruction to change a value');
    // a gain that is not 0: the step is 20 % or less of it, and the caveats give the full estimate
    const h50 = { header: Object.assign({}, HEADER, { yaw_inertia_precomp: [50, 25] }) };
    const step = only(run([T14F({ gain: 60, se: 10, f: { log: 6 } })], h50), 'T14');
    assert.deepEqual([step.severity, step.profile, step.from, step.to, step.cli], ['check', 1, 50, 60, []]);
    assert.match(step.text, /The full change is an increase of 60\. The analysis gives a step of yaw_inertia_precomp_gain on PID profile 1 from 50 to 60 \(log header, PID profile 1 at the start of the log\)\./, 'round 3 M5: the full correction and the step');
    assert.deepEqual(step.full, undefined, 'r.full stays inside advice (not an output key)');
    assert.match(step.caveats.join(' '), /The step is 20 % or less\. The regression gives 110\..*The full estimate of the regression is 110 ± 10\. In the tests of the toolkit with a model of the tail, .* Thus, a step in its direction is better than the full change\./);
    assert.match(step.caveats.join(' '), /Check T14 uses the headspeed ramps of all PID profiles of a log\. Thus, the estimate is correct for PID profile 1 only if all PID profiles have the same yaw_inertia_precomp_gain/);
    const big = only(run([T14F({ gain: 300, se: 40, f: { log: 6 } })], { header: Object.assign({}, HEADER, { yaw_inertia_precomp: [200, 25] }) }), 'T14');
    assert.deepEqual([big.severity, big.from, big.to], ['check', 200, 240]);
    assert.match(big.caveats.join(' '), /The estimate, 500 ± 40, is more than the firmware maximum, 250\./);
    assert.match(big.text.split('\n')[1], /^The measured log \(log 6\) has 6 headspeed ramps, and 100 % of them have the sign of the estimate\./);
    // an inferred arming profile is no confirmed source: PID profile unknown, no from-value (the Fireball "from 0 to 94")
    const inf = only(run([T14F()], { headerProfileInferred: true }), 'T14');
    assert.deepEqual([inf.severity, inf.profile, inf.from, inf.to, inf.cli], ['check', 0, null, null, []]);
    assert.match(inf.text, /The analysis gives an increase of yaw_inertia_precomp_gain by 20 % or less \(PID profile unknown\)\./);
    // a T14 result of PID profile 2 (the worker's pidProfile): never the header value of PID profile 1; its CLI section gives it
    const p2 = T14F({ f: { pidProfile: 2 } });
    assert.deepEqual([only(run([p2], h50), 'T14').profile, only(run([p2], h50), 'T14').from], [2, null]);
    const cli2 = setup.parseCli(CLI_TEXT + 'set yaw_inertia_precomp_gain = 40\n');
    assert.deepEqual([only(run([p2], { cli: cli2 }), 'T14').from, only(run([p2], { cli: cli2 }), 'T14').to, only(run([p2], { cli: cli2 }), 'T14').fromSource], [40, 48, 'CLI dump, section `profile 1`']);
    const noGain = only(run([T14F()], { header: Object.assign({}, HEADER, { yaw_inertia_precomp: undefined }) }), 'T14');
    assert.deepEqual([noGain.severity, noGain.to], ['check', null]);
    assert.match(noGain.text, /do not give all yaw PID, stop and inertia values/);
    assert.match(noGain.text, /Start a new log with PID profile 1 selected to record its values/);
    assert.doesNotMatch(noGain.text, /analysis gives an increase|with these values/);
    // without the setups of the logs every measured log is pooled
    const all = only(run([oldFlag, quiet]), 'T14');
    assert.equal(all.severity, 'watch', 'the two flights disagree: pooled 68 +- 145 (the between-flight SE)');
    assert.match(all.text, /The 2 measured logs together \(logs 5 and 6\)/);
});

test('T14: unknown or partial selected yaw values give a measurement plan, not a comparison or target', () => {
    const observed = T14F({ gain: 60, se: 10, f: { log: 15, pidProfile: 3 } });
    const knownElsewhere = setupOf(15, '80,120,14,20,0', '120,80');
    const incomplete = [
        { yawPID: Array(6).fill(null), yaw_stop_gain: [null, null], yaw_inertia_precomp: [null, null] },
        { yawPID: undefined }, { yawPID: [80, 120, 14, 20] }, { yawPID: [80, 120, null, 20, 0] },
        { yaw_stop_gain: [120] }, { yaw_stop_gain: [120, NaN] },
        { yaw_inertia_precomp: undefined }, { yaw_inertia_precomp: [50, null] },
    ];
    for (const partial of incomplete) {
        const r = only(run([knownElsewhere, observed], { header: Object.assign({}, HEADER, partial), headerProfile: 3, headerLog: 15 }), 'T14');
        assert.deepEqual([r.severity, r.profile, r.from, r.to, r.cli], ['check', 3, null, null, []]);
        assert.match(r.title, /selected yaw values unknown/);
        assert.match(r.text, /cannot compare these results with the selected yaw values/);
        assert.match(r.text, /Start a new log with PID profile 3 selected to record its values/);
        assert.match(r.text, /Then record 3 headspeed ramps or more in flight/);
        assert.doesNotMatch(r.text, /Only other yaw values|with these values|yaw PID ,|stop ,|inertia ,|analysis gives an increase|Arm the helicopter.*record/);
        assert.ok(r.evidence.some(e => e.fid === observed.fid), 'The measured result stays accessible.');
    }
    const unidentified = only(run([T14F({ f: { log: 15, profile: 0, pidProfile: 0 } })], { header: {}, headerProfile: 0 }), 'T14');
    assert.deepEqual([unidentified.profile, unidentified.from, unidentified.to, unidentified.cli], [0, null, null, []]);
    assert.match(unidentified.text, /Start a new log with the PID profile that you will test selected to record its values/);
});

test('T14: equal complete yaw setups pool their evidence, and partial source setups do not match', () => {
    const header = Object.assign({}, HEADER, { yaw_inertia_precomp: [50, 25] });
    const complete = (log) => f({ module: 'setup', id: 'SETUP', severity: 'note', log, profile: null,
        setup: { pid: { yaw: [80, 120, 14, 20, 0] }, yaw: { stopGain: [120, 80], inertia: [50, 25] } } });
    const a = T14F({ gain: 60, se: 10, f: { log: 5 } }), b = T14F({ gain: 60, se: 10, f: { log: 6 } });
    const equal = only(run([complete(5), complete(6), a, b], { header }), 'T14');
    assert.deepEqual([equal.severity, equal.from, equal.to, equal.cli], ['check', 50, 60, []]);
    assert.match(equal.text, /logs 5 and 6\) have 12 headspeed ramps/);
    assert.doesNotMatch(equal.text, /selected yaw values unknown|Only other yaw values/);
    for (const partial of [
        f({ module: 'setup', id: 'SETUP', severity: 'note', log: 5, profile: null,
            setup: { pid: { yaw: [80, 120, null, 20, 0] }, yaw: { stopGain: [120, 80], inertia: [50, 25] } } }),
        f({ module: 'setup', id: 'SETUP', severity: 'note', log: 5, profile: null,
            text: SETUP_TEXT('80,120,,20,0', '120,80', '50,25') }),
    ]) {
        const r = only(run([partial, complete(6), a, b], { header }), 'T14');
        assert.deepEqual([r.from, r.to, r.cli], [50, 60, []]);
        assert.match(r.text, /log 6\) have 6 headspeed ramps/);
        assert.match(r.caveats.join(' '), /log 5 \(values unknown\)/);
        assert.match(r.caveats.join(' '), /their yaw values are different or unknown/);
        assert.doesNotMatch(r.caveats.join(' '), /measured them with different gains/);
        const onlyPartial = only(run([partial, a], { header }), 'T14');
        assert.deepEqual([onlyPartial.severity, onlyPartial.from, onlyPartial.to, onlyPartial.cli], ['watch', null, null, []]);
        assert.match(onlyPartial.text, /measured results have different or unknown yaw values/);
        assert.doesNotMatch(onlyPartial.text, /The measured log .* has 6|fit estimates/);
    }
});

test('T5: the larger side loses one 10 % step when the ratio clears 1.5 by 2 SE', () => {
    const r = only(run([f({ id: 'T5', value: 2, se: 0.2, larger: 'ccw', text: 'yaw stop overshoot ...: lower yaw_ccw_stop_gain' })]), 'T5');
    assert.deepEqual([r.parameter, r.from, r.to], ['yaw_ccw_stop_gain', 80, 72]);
    assert.deepEqual(r.cli, ['profile 0', 'set yaw_ccw_stop_gain = 72']);
});

test('T6: the kick direction comes from the pooled toward-torque sign; no consistent sign is a check', () => {
    const t6 = (toward) => f({ id: 'T6', value: 50, se: 5, towardTorque: toward, text: 'yaw kick after collective steps' });
    const r = only(run([t6({ mean: 30, se: 5, n: 6 })]), 'T6');
    assert.deepEqual([r.from, r.to, r.direction], [60, 66, 'raise']);
    assert.deepEqual([r.severity, r.cli], ['check', []], 'T6 gives the direction only: TAIL-PRECOMP refuted it as a precomp measure; T7 sets the value');
    assert.match(r.caveats.join(' '), /On a different helicopter \("SAB Fireball"\), a test showed that 72 of 78 kicks followed the collective\. This result is not from your logs\./);
    assert.equal(only(run([t6({ mean: -30, se: 5, n: 6 })]), 'T6').to, 54);
    const mixed = only(run([t6({ mean: 5, se: 20, n: 6 })]), 'T6');
    assert.deepEqual([mixed.severity, mixed.parameter], ['check', null]);
    assert.match(mixed.caveats.join(' '), /On a different helicopter \("SAB Fireball"\), a test showed that 72 of 78 kicks/, 'the direction-less case cites the refutation too');
    assert.doesNotMatch(mixed.text, /Check yaw_precomp_cutoff/, 'T6 measures the kick size and sign, not its timing');
    assert.match(mixed.text, /not more than 0 by 2 SE.*check T7 measures the precompensation/);
});

test('T7: collective FF x sqrt(precompScale), because the precomp is (|collective| x gain)^2', () => {
    const t7 = (scale, r = 0.8) => f({ id: 'T7', value: r, se: 0.05, precompScale: scale, text: 'yaw I vs precomp in pumps' });
    assert.equal(only(run([t7(1.44)]), 'T7').to, 72);                           // 60 x sqrt(1.44) = 72, at the 20 % bound
    assert.equal(only(run([t7(1.21)]), 'T7').to, 66);                           // 60 x 1.1
    assert.equal(only(run([t7(0.81, -0.8)]), 'T7').to, 54);                     // 60 x 0.9
    const wrong = only(run([t7(-0.5, -0.8)]), 'T7');
    assert.deepEqual([wrong.severity, wrong.parameter], ['check', null]);
});

test('T9: yaw F one 10 % step in the direction of the I share; a zero F gets no relative step', () => {
    const t9 = f({ id: 'T9', axis: 'yaw', value: 0.3, se: 0.05, gyroRatio: { mean: 1, se: 0.01 }, text: 'yaw: I carries the rate, FF too low (raise F)' });
    const up = only(run([t9]), 'T9');
    assert.deepEqual([up.from, up.to, up.severity, up.cli], [20, 22, 'check', []], 'a check: TAIL-FF refuted the I-share baseline');
    assert.match(up.caveats.join(' '), /On a different helicopter \("SAB Fireball"\), a test showed a part of -0\.10 ± 0\.12 in hover\. This result is not from your logs\./);
    const zero = only(run([t9], { header: Object.assign({}, HEADER, { yawPID: [80, 120, 14, 0, 0] }) }), 'T9');
    assert.deepEqual([zero.severity, zero.cli], ['check', []]);
    assert.match(zero.caveats.join(' '), /is 0/);
});

// ---------------------------------------------------------------------------------------------
// report.cjs decisions
// ---------------------------------------------------------------------------------------------

const decision = (o) => Object.assign({ axis: 'pitch', bin: 2250, flights: 5, windows: 400, change: true, reason: undefined, validBand: [1, 15],
    changes: [{ gain: 'F', multiplier: 0.8, from: 100.01, to: 80.01, improves: 'tracking', dTrack: 1.4, seTrack: 0.5, atBound: true }],
    tracking: [2.9, 1.5], dTrack: 1.4, seTrack: 0.5, disturbance: [9.9, 9.9], total: [10.4, 10.1], lowFreqGain: [1.12, 0.98],
    gates: { V1: { value: 0.016, limit: 0.05, pass: true }, V2a: { pass: true }, V2b: { pass: true }, V3: { pass: true } } }, o);

test('C7: a report.cjs change becomes the CLI of its profile when the recovered gain matches the configured one', () => {
    const r = only(run([], { decisions: [decision()] }), 'C7');
    assert.deepEqual([r.profile, r.from, r.to, r.confidence], [1, 100, 80, 'predicted']);           // 2300 rpm target -> bin 2250 -> profile 1
    assert.deepEqual(r.cli, ['profile 0', 'set pitch_f_gain = 80']);
    // at the end of report.cjs's multiplier grid nothing further was evaluated: no claim that a larger step is better
    assert.match(r.caveats.join(' '), /0\.8 is the largest step of the gain model .*the model did not calculate a larger step/);
    assert.match(r.caveats.join(' '), /the gain at 1 Hz to 3 Hz goes through 1 in this step \(from 1\.12 to 0\.98\)/);
    assert.doesNotMatch(r.caveats.join(' '), /may lie further/);
    assert.deepEqual(only(run([], { decisions: [decision({ changes: [Object.assign({}, decision().changes[0], { from: 140 })] })] }), 'C7').cli, []); // the model ran with F 140
    // PID profile 2 is not the arming profile of the header (SPEC2 D12): the from-value is the gain that report.cjs recovered
    // from the flights of PID profile 2, an estimate, and there is no CLI text; never the header value of PID profile 1
    const p2 = only(run([], { decisions: [decision({ bin: 2500 })], headerProfile: 1 }), 'C7');
    assert.deepEqual([p2.profile, p2.from, p2.to, p2.cli], [2, 100, 80, []]);
    assert.match(p2.text, /This change must wait|conditional proposal/i);
    assert.match(p2.text, /analysis gives a change of pitch_f_gain.*approximately 100.*80/i);
    assert.doesNotMatch(p2.text, /Set pitch_f_gain/);
    assert.match(p2.caveats.join(' '), /The log header gives the values of PID profile 1 only, the PID profile at the start of the log\. The value of pitch_f_gain on PID profile 2 is unknown\. The value 100 is an estimate from the log\. Thus, there is no CLI text\./);
    const p2b = only(run([], { decisions: [decision({ bin: 2500, changes: [Object.assign({}, decision().changes[0], { from: 120.4 })] })], headerProfile: 1 }), 'C7');
    assert.deepEqual([p2b.from, p2b.to], [120, 96], 'the recovered gain of PID profile 2, not the header F 100 of PID profile 1');
    // the section of PID profile 2 in a CLI capture gives the exact value: then the agreement gives CLI text
    const cli2 = setup.parseCli(CLI_TEXT + 'set pitch_f_gain = 100\n');
    assert.deepEqual(only(run([], { decisions: [decision({ bin: 2500 })], headerProfile: 1, cli: cli2 }), 'C7').cli, ['profile 1', 'set pitch_f_gain = 80']);
    assert.deepEqual(only(run([], { decisions: [decision({ bin: 3000 })] }), 'C7').cli, []);       // no profile flies 3000 rpm
    assert.equal(only(run([], { decisions: [{ axis: 'roll', bin: 2250, flights: 4, windows: 300, change: false, reason: 'gate V2b failed' }] }), 'C7').severity, 'info');
});

test('C7: yaw P scales yaw_p_gain only; the model P is P x the mean stop gain', () => {
    const d = decision({ axis: 'yaw', changes: [{ gain: 'P', multiplier: 0.9, from: 80, to: 72, improves: 'disturbance' }] });  // 80 x (120 + 80) / 200 = 80
    const r = only(run([], { decisions: [d] }), 'C7');
    assert.deepEqual(r.cli, ['profile 0', 'set yaw_p_gain = 72']);
    assert.match(r.caveats.join(' '), /stop gains stay/);
});

test('C7: yaw P on another profile than the header: a match of P x mean stop gain confirms yaw_p_gain only when the stop gains are known', () => {
    // profile 2 (bin 2500) is not the header profile 1; header P 80 with stops 120/80 is 80, and the model ran with 80.5
    const d = decision({ axis: 'yaw', bin: 2500, changes: [{ gain: 'P', multiplier: 0.9, from: 80.5, to: 72.5, improves: 'disturbance' }] });
    const r = only(run([], { decisions: [d] }), 'C7');
    assert.deepEqual([r.cli, r.from, r.to], [[], null, null], 'P 70 with stops 130/100 gives the same product, and the header is PID profile 1');
    assert.match(r.text, /analysis gives a decrease of yaw_p_gain on PID profile 2 by 10 %\./i);
    assert.match(r.caveats.join(' '), /The value of yaw_p_gain on PID profile 2 is unknown\. Thus, there is no CLI text\./);
    // the header of the arming profile PID profile 2 gives P and the two stop gains of PID profile 2: they agree with the model
    const own = only(run([], { decisions: [decision({ axis: 'yaw', bin: 2500, changes: d.changes })], headerProfile: 2 }), 'C7');
    assert.deepEqual(own.cli, ['profile 1', 'set yaw_p_gain = 72'], 'header PID profile 2: P 80, stops 120/80 give 80, and the model ran with 80.5');
    // with the profile in a CLI capture the stop gains are known: P 70, stops 130/100 = 80.5 confirms P 70
    const cli = setup.parseCli(CLI_TEXT + 'set yaw_p_gain = 70\nset yaw_cw_stop_gain = 130\nset yaw_ccw_stop_gain = 100\n');
    assert.deepEqual(only(run([], { decisions: [d], cli }), 'C7').cli, ['profile 1', 'set yaw_p_gain = 63']);
});

test('IMP-07: a C7 change and a model change carry the flights that can show them; the export gives them once and the commands stay', () => {
    const P = require('../tools/autotune/validation_power.cjs');
    const r = only(run([], { decisions: [decision({ measured: { trackRmsSE: 0.4 } })] }), 'C7');
    assert.deepEqual(r.cli, ['profile 0', 'set pitch_f_gain = 80']);
    assert.equal(r.validationPower.flightsPerArm, P.flightsPerArm(0.4 * Math.sqrt(5), 1.4));
    assert.equal(r.validationPower.metrics[0].delta, -1.4); assert.equal(r.validationPower.confirmable, true);
    assert.equal(r.validationPower.metrics[0].id, 'decision'); assert.equal(r.validationPower.profileLabel, 'PID profile 1');
    assert.equal(only(run([], { decisions: [decision()] }), 'C7').validationPower.available, false, 'no measured SE: no number of flights');
    // a change group of the model (control_pipeline.tune): two changes with one plan
    const plan = P.plan([{ id: 'tracking', axes: ['roll', 'pitch'], unit: 'deg/s', delta: -0.57, sd: 3.04, flights: 14, lowerBound: false }]);
    const rec = (name, to) => ({ id: 'twin:x:cyclic:' + name, group: 'twin:x:cyclic', groupSize: 2, node: 'cyclic', area: 'cyclic', dataset: 'A', profile: 1, cliProfile: 0,
        scope: 'profile', severity: 'action', parameter: name, from: 100, to, fromSource: 'log header', title: 'Test the model values', text: 'The control tests agree with the selected values.',
        rule: 'The calculated error decrease is 0.570 deg/s.', evidence: [], cli: ['profile 0', `set ${name} = ${to}`], blockedBy: [], causes: [], caveats: [], controlTune: true, validationPower: plan });
    const recs = [rec('roll_i_gain', 110), rec('pitch_i_gain', 110)], ids = recs.map(x => x.id);
    const text = advice.exportScript(recs, ids, {}), without = advice.exportScript(recs.map(x => Object.assign({}, x, { validationPower: undefined })), ids, {});
    assert.deepEqual(commands(text), commands(without), 'the commands do not change');
    assert.deepEqual(commands(text), ['batch start', 'profile 0', 'set roll_i_gain = 110', 'set pitch_i_gain = 110', 'save']);
    assert.match(text, /\n#   Flights to compare the values:\n#   Flights cannot show this change in the roll and pitch tracking error\.\n#   The app calculates a change of -0\.57 deg\/s\.\n/);
    assert.match(flat(text), /Thus, 447 flights with each set of values are necessary\. The limit is 10 flights\./);
    // a neutral back-reference: the plan of change 1 says that flights cannot show the change
    assert.match(text, /#   Change 1 has the same text about the flights\./); assert.doesNotMatch(text, /also show this change/);
    assert.equal(text.split('Flights cannot show this change').length, 2, 'once for the changes with the same plan');
});

test('every check id of the catalogue has a generator (C7 comes from the decisions; C8, C9, G7 are report only)', () => {
    const ids = [...Array.from({ length: 14 }, (_, i) => `C${i + 1}`), ...Array.from({ length: 14 }, (_, i) => `T${i + 1}`), ...Array.from({ length: 15 }, (_, i) => `G${i}`),
        ...Array.from({ length: 11 }, (_, i) => `F${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `D${i + 1}`), 'R1', 'H', 'SETUP'];
    const missing = ids.filter(id => !advice.CHECKS.includes(id) && !['C7', 'C8', 'C9', 'G7'].includes(id));
    assert.deepEqual(missing, []);
    assert.equal(only(run([], { header: Object.assign({}, HEADER, { rates_type: 4 }) }), 'SETUP:rates_type').scope, 'rateprofile');
    assert.equal(only(run([T14F()]), 'T14').scope, 'profile');
});

test('analysis errors become one check', () => {
    assert.equal(only(run([{ module: 'loop', id: 'LOOP', severity: 'error', log: null, text: 'judge failed: x' }]), 'ERROR').severity, 'check');
});

// ---------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------

const C3UP = f({ id: 'C3', axis: 'roll', value: 0.15, se: 0.02, gyroRatio: { mean: 1, se: 0.01 }, text: 'FF too low (raise F)' });

test("Measured attenuation faults block gain increases; filter guidance alone does not", () => {
    const bad=f({module:'setup',id:'F6',value:4,se:.5});
    assert.deepEqual(only(run([C3UP,bad]),'C3').cli,[]);
    const low=only(run([f({id:'C3',axis:'roll',value:-.3,se:.05,gyroRatio:{mean:1,se:.01},text:'FF too high'}),bad]),'C3');
    assert.equal(low.cli.length,2);
    for(const id of ['F1','F5','C11','F10']) {
        const out=run([C3UP,f({id,value:.97,se:.005,axis:'roll'})]);
        assert.deepEqual(only(out,'C3').blockedBy,[],id);
    }
});

test('guard 1: an F6 flag that stands (below 10 dB by 2 SE) holds loop-gain raises and D cuts for noise; one that does not, nothing', () => {
    const f6 = (value, se) => f({ module: 'setup', id: 'F6', value, se, threshold: '>= 10 dB', text: `roll notch 12 (main rotor 2, 2 x rotor, 77 Hz, Q 4) at 2300 rpm: ${value} +- ${se} dB over 9 windows: mis-centred or too narrow.` });
    const r = only(run([C3UP, f6(4, 0.5)]), 'C3');
    assert.deepEqual([r.blockedBy, r.cli], [['Check F6 shows a filter problem. TUNE puts correct filters before you increase the gains.'], []]);
    assert.equal(only(run([C3UP, f6(9, 2)]), 'C3').cli.length, 2, '9 +- 2 dB is not below 10 dB by 2 SE: a watch, which holds nothing');
    const d = only(run([f6(4, 0.5)], { decisions: [decision({ axis: 'roll', changes: [{ gain: 'D', multiplier: 1.2, from: 10, to: 12 }] })], header: Object.assign({}, HEADER, { rollPID: [50, 100, 10, 100, 0] }) }), 'C7');
    assert.deepEqual([d.blockedBy, d.cli], [['Check F6 shows a filter problem. TUNE puts correct filters before you increase the gains.'], []]);
    const yawD = only(run([f6(4, 0.5), f({ module: 'more', id: 'F10', axis: 'yaw', value: 0.97, se: 0.005, threshold: 'D share - 2 SE > 0.5 (yaw; roll and pitch are judged by C11)', text: 'yaw axisD power above 30 Hz 97 %' })]), 'F10');
    assert.deepEqual(yawD.cli, []);
    assert.equal(yawD.severity,'info');
    assert.equal(yawD.to,null);
});

test('guard 2: a G12 or G1 flag blocks governor and RPM-notch changes', () => {
    const g3 = f({ module: 'gov', id: 'G3', governorResponse: GOV_RESPONSE, log: [5], value: 0.07, se: 0.005, text: 'droop 7 %: F too low (GOVT)' });
    assert.deepEqual(only(run([g3, f({ module: 'gov', id: 'G12', profile: null, value: 1.1, se: 0.001, text: 'line at 1.1' })]), 'G3:').blockedBy, ['Check G12 shows an incorrect headspeed. The governor and the RPM notch filters use this headspeed. Correct motor_poles or the RPM sensor first.']);
    const held = only(run([g3, f({ module: 'gov', id: 'G1', profile: null, value: 1, text: '1 FALLBACK entry' })]), 'G3:');
    assert.deepEqual(held.cli, []);
    assert.match(held.blockedBy.join(' '), /cause and the RPM signal must be examined/);
    assert.doesNotMatch(held.blockedBy.join(' '), /RPM signal was not available/);
});

test('guard 2: a G12 factor error beyond the 2 % notch tolerance also holds cyclic and tail changes; a small one and G1 do not', () => {
    const t5 = f({ id: 'T5', value: 2, se: 0.2, larger: 'ccw', text: 'stops' }), g12 = (value) => f({ module: 'gov', id: 'G12', profile: null, value, se: 0.001, text: `main rotor line at ${value} x` });
    const held = only(run([t5, g12(1.2)]), 'T5');
    assert.deepEqual(held.cli, []);
    assert.match(held.blockedBy.join(' '), /Check G12 shows the main rotor line at `1\.2 × headspeed \/ 60`\. This error is more than the 2 % tolerance of the RPM notch filters/);
    assert.equal(only(run([C3UP, g12(1.006)]), 'C3').cli.length, 2, '0.6 %: the notches still cover the lines');
    assert.equal(only(run([C3UP, f({ module: 'gov', id: 'G1', profile: null, value: 1, text: '1 FALLBACK entry' })]), 'C3').cli.length, 2, 'FALLBACK spans are out of the loop analysis');
});

test('guard 3: an axis at its output limit gets "authority, not gains" and no raise CLI; a lower keeps its CLI', () => {
    const t8 = f({ id: 'T8', value: 4, text: '60 episodes, 4.07 s at an output limit (mixer[2], servo[3])' });
    const up = only(run([t8, f({ id: 'T6', value: 50, se: 5, towardTorque: { mean: 30, se: 5 }, text: 'kick' })]), 'T6');
    assert.deepEqual(up.cli, []);
    assert.match(up.blockedBy.join(' '), /The yaw output is at its limit \(check T8\), and gains cannot give more output range/);
    // guard 3 holds no decrease: the lower stop gain gets no authority entry, only the caveat. Its CLI waits for T8 all the
    // same, because the tail limit is an upstream cause of the stop overshoot (rule K6, SPEC2 3.5: "Possible result")
    const down = only(run([t8, f({ id: 'T5', value: 2, se: 0.2, larger: 'ccw', text: 'stops' })]), 'T5');
    assert.deepEqual([down.severity, down.blockedBy, down.cli], ['action', [], []]);
    assert.match(down.caveats.join(' '), /Gains cannot increase the output range/);
    assert.deepEqual(down.causes.map(c => [c.rule, c.ids, c.holds]), [['K6', ['T8'], true]]);
    // An output limit also invalidates a fitted model decrease (K21).
    const yawD=only(run([t8],{decisions:[decision({axis:'yaw',bin:2250,changes:[{gain:'D',multiplier:.8,from:14,to:11.2}]})]}),'C7');
    assert.deepEqual(yawD.cli,[]);
    assert.ok(yawD.causes.some(c=>c.rule==='K21'&&c.holds));
    assert.match(yawD.caveats.join(' '),/Gains cannot increase the output range/);
    const roll = only(run([f({ id: 'C2', value: 1, text: '3 episodes, 1.00 s at an output limit (mixer[1]), longest 0.1 s' }), C3UP]), 'C3');
    assert.equal(roll.cli.length, 2, 'a pitch-only limit leaves roll alone');
});

test('guard 3: no governor raise while the tail is at its limit (T8) or G10 implicates the governor on that profile; lowering stays', () => {
    const g3 = f({ module: 'gov', id: 'G3', governorResponse: GOV_RESPONSE, log: [5], value: 0.07, se: 0.005, text: 'droop 7 %: F carries less than half: F too low (GOVT)' });
    const t8 = (profile) => f({ id: 'T8', profile, value: 3.8, text: '73 episodes, 3.8 s at an output limit (mixer[2], servo[3])' });
    const held = only(run([g3, t8(1)]), 'G3');
    assert.deepEqual(held.cli, []);
    assert.match(held.blockedBy.join(' '), /The tail is at its output limit \(check T8\)/);
    assert.match(held.caveats.join(' '), /A governor with higher gains adds the motor torque more quickly.*\(possible, not measured\).*On a tail that the main rotor turns, a smaller headspeed decrease also gives more tail speed \(calculated\)/);
    assert.deepEqual(only(run([g3, t8(2)]), 'G3').cli, ['profile 0', 'set gov_f_gain = 20'], 'the tail limit of another profile');
    const g10 = only(run([g3, f({ module: 'gov', id: 'G10', value: 0.7, se: 0.05, text: 'coherence 0.7 at the wag peak' })]), 'G3');
    assert.deepEqual(g10.cli, []);
    assert.match(g10.blockedBy.join(' '), /Check G10 shows related headspeed and tail oscillations \(coherence 0\.7 ± 0\.05, 1 log-profile pair\)\. This does not (?:show|prove) which loop causes the oscillation/);
    const g4 = f({ module: 'gov', id: 'G4', log: [5], value: 0.05, se: 0.004, text: 'headspeed overshoots 5.00 % on collective rises (load onset): F too high (GOVT)' });
    assert.deepEqual(only(run([g4, t8(1)], { cli: CLI }), 'G4').cli, ['profile 0', 'set gov_f_gain = 0'], 'detuning is the remedy GOVT gives');
});

test('guard 4: a flag below 2 SE becomes a watch without CLI (T5 1.54 +- 0.38, T6 41.1 +- 11.5 as on the Gaui)', () => {
    const t5 = only(run([f({ id: 'T5', value: 1.54, se: 0.38, larger: 'ccw', text: 'stops' })]), 'T5');
    const t6 = only(run([f({ id: 'T6', value: 41.1, se: 11.46, towardTorque: { mean: 25.9, se: 25.3 }, text: 'kick' })]), 'T6');
    for (const r of [t5, t6]) { assert.equal(r.severity, 'watch'); assert.deepEqual(r.cli, []); assert.match(r.caveats.join(' '), /Thus, the recommendation is to monitor, with no change\./); assert.match(r.rule, /Sources?: .*"toolkit rule: a value with an SE must be more than its limit by 2 SE"/); }
});

test('guard 5: relative steps are bounded to 20 %, also after rounding; documented absolute steps are kept', () => {
    assert.equal(only(run([f({ id: 'T7', value: 0.9, se: 0.02, precompScale: 4, text: 'x' })]), 'T7').to, 72);          // x2 asked, x1.2 given
    const g9 = only(run([f({ module: 'gov', id: 'G9', value: 9, se: 1, text: '(I-type): governor I too high' })]), 'G9');
    assert.deepEqual([g9.from, g9.to], [50, 40]);                                                                      // GOVT cut by 1/3, bounded to 20 %
    const g18 = only(run([f({ module: 'gov', id: 'G9', value: 9, se: 1, text: '(P-type)' })], { header: Object.assign({}, HEADER, { govPID: [18, 50, 0, 10, 40] }) }), 'G9');
    assert.equal(g18.to, 15, '18 x 0.8 = 14.4 must not round to 14 (-22 %)');
    assert.deepEqual(only(run([f({ module: 'gov', id: 'G3', governorResponse: GOV_RESPONSE, log: [5], value: 0.07, se: 0.005, text: 'droop 7 %: F too low (GOVT)' })]), 'G3').to, 20); // the documented F step 10
});

test('guard 5: every value stays within its firmware range (settings.c); at a limit the step is a watch', () => {
    assert.deepEqual([advice.RANGE.yaw_cw_stop_gain, advice.RANGE.yaw_collective_ff_gain, advice.RANGE.pitch_collective_ff_gain, advice.RANGE.gov_f_gain, advice.RANGE.roll_p_gain, advice.RANGE.dyn_notch_q, advice.RANGE.blackbox_rate_denom],
        [[25, 250], [0, 250], [0, 250], [0, 250], [0, 1000], [10, 100], [1, 8000]]);
    // no range: the RPM notch arrays, the filter types, and the governor names with CLI words (MODE_LOOKUP, MODE_BITSET)
    const WORDS = /^gov_(mode|throttle_type|use_(fallback_precomp|pid_spoolup|voltage_comp|dyn_min_throttle))$/;
    for (const k of Object.keys(advice.PARAMS)) if (!/^gyro_rpm_notch_(source|q|center)_/.test(k) && !/^gyro_lpf\d_type$/.test(k) && !WORDS.test(k)) assert.ok(advice.RANGE[k], `${k} has no firmware range`);
    for (const k of Object.keys(advice.PARAMS)) if (WORDS.test(k)) assert.equal(advice.RANGE[k], undefined, `${k} is a word, not a number`);
    const h = (o) => ({ header: Object.assign({}, HEADER, o) }), t5 = f({ id: 'T5', value: 2, se: 0.2, larger: 'ccw', text: 'stops' });
    const stop = only(run([t5], h({ yaw_stop_gain: [120, 26] })), 'T5');                     // 26 x 0.9 = 23, below 25
    assert.deepEqual(stop.cli, ['profile 0', 'set yaw_ccw_stop_gain = 25']);
    assert.match(stop.caveats.join(' '), /The firmware range of yaw_ccw_stop_gain is 25 to 250, and the CLI does not accept a value out of it\. Thus, 23 becomes 25\./);
    assert.equal(only(run([f({ id: 'T7', value: 0.8, se: 0.05, precompScale: 1.44, text: 'x' })], h({ yaw_precomp: [5, 10, 230] })), 'T7').to, 250);   // 230 x 1.2 = 276
    assert.equal(only(run([f({ module: 'gov', id: 'G3', governorResponse: GOV_RESPONSE, log: [5], value: 0.07, se: 0.005, text: 'droop 7 %: F too low (GOVT)' })], h({ govPID: [40, 50, 0, 245, 40] })), 'G3').to, 250);
    assert.equal(only(run([f({ module: 'more', id: 'C14', axis: 'pitch', value: 60, se: 5, gainChange: 100, gainChangeSe: 10, text: 'c14' })], h({ pitch_compensation: 240 })), 'C14').to, 250); // 240 + 48 bounded
    const floor = only(run([t5], h({ yaw_stop_gain: [120, 25] })), 'T5');
    assert.deepEqual([floor.severity, floor.cli], ['watch', []]);
    assert.match(floor.caveats.join(' '), /yaw_ccw_stop_gain is at its firmware limit, 25\. A step in this direction is not possible\..*a change of the other stop gain is possible/);
});

test('guard 6: never an LPF below 60 Hz or a notch Q below 2.0', () => {
    assert.equal(advice.floorsOk('gyro_lpf1_static_hz', 50), false);
    assert.equal(advice.floorsOk('gyro_lpf2_static_hz', 60), true);
    assert.equal(advice.floorsOk('gyro_lpf1_dyn_min_hz', 59), false);
    assert.equal(advice.floorsOk('dyn_notch_q', 19), false);
    assert.equal(advice.floorsOk('gyro_rpm_notch_q_yaw', '80,15,0'), false);
    assert.equal(advice.floorsOk('gyro_rpm_notch_q_yaw', '80,20,0'), true);
});

test('guard 7: log profile p is CLI profile p-1; profile 0 gets no CLI and asks to confirm the profile', () => {
    const t5 = (p) => f({ id: 'T5', profile: p, value: 2, se: 0.2, larger: 'ccw', text: 'stops' });
    assert.equal(only(run([t5(1)]), 'T5').cliProfile, 0);
    const zero = only(run([t5(0)]), 'T5');
    assert.deepEqual(zero.cli, []);
    assert.deepEqual([zero.from, zero.to], [null, null], 'no from-value: the header is PID profile 1');
    assert.match(zero.text, /analysis gives a decrease of yaw_ccw_stop_gain by 10 % \(PID profile unknown\)\./i);
    assert.match(zero.caveats.join(' '), /The PID profile of this result is unknown \(PID profile unknown\), and the value of yaw_ccw_stop_gain is also unknown\. Thus, there is no CLI text\./);
    // a change with sets on PID profile unknown (a report.cjs decision whose bin no profile flies) gets the rule 7 caveat
    const two = only(run([t5(2)], { cli: CLI }), 'T5');                       // the CLI diff has no stop gain for profile 1: the 4.6 default 80
    assert.deepEqual(two.cli, ['profile 1', 'set yaw_ccw_stop_gain = 72']);
});

test('guard 7: a profile the CLI capture lacks (a plain diff prints the current one only) is unknown, not the 4.6 default', () => {
    const plain = setup.parseCli('diff\n# version\n# Rotorflight / STM32F7X2 (S7X2) 4.6.0\n\n# master\nset motor_poles = 24,0,0,0\n\nprofile 0\nset yaw_ccw_stop_gain = 100\n\nrateprofile 0\n');
    assert.equal(plain.kind, 'diff');
    const out = run([f({ id: 'T5', profile: 3, value: 2, se: 0.2, larger: 'ccw', text: 'stops' })], { cli: plain });
    const r = only(out, 'T5');
    assert.deepEqual(r.cli, [], 'the default 80 was an assumption: profile 2 is not in the capture');
    assert.match(r.caveats.join(' '), /The CLI dump has no section `profile 2`, because `diff` or `dump` without `all` shows only the active PID profile\. Thus, there is no CLI text\. The log header records the values of PID profile 3 only when a new log starts in PID profile 3\./);
    assert.doesNotMatch(r.caveats.join(' '), /diff all/, 'no text asks for a new CLI dump (user rule 2026-10-06)');
    assert.deepEqual([r.from, r.to], [null, null], 'not the header value of PID profile 1, not the default');
    assert.match(out.notes.join(' '), /The CLI dump has only the section `profile 0`, of 6\. Possibly, `diff` without `all` shows only the active PID profile/);
    assert.deepEqual(only(run([f({ id: 'T5', profile: 1, value: 2, se: 0.2, larger: 'ccw', text: 'stops' })], { cli: plain, headerProfile: 2 }), 'T5').cli, ['profile 0', 'set yaw_ccw_stop_gain = 90'], 'the section it has');
    const all = setup.parseCli('diff all\n' + [0, 1, 2, 3, 4, 5].map(p => `profile ${p}\n`).join(''));
    assert.ok(!run([], { cli: all }).notes.some(n => /The CLI dump has only/.test(n)), 'a diff all prints every profile');
});

test('guard 8: no governor gain change where G0 says DIRECT/LIMIT, or the CLI says so and no log shows a PID governor', () => {
    const g3 = f({ module: 'gov', id: 'G3', governorResponse: GOV_RESPONSE, log: [5], value: 0.07, se: 0.005, text: 'droop 7 %: F too low (GOVT)' });
    const direct = run([g3, f({ module: 'gov', id: 'G0', severity: 'note', profile: null, value: 0, text: 'govSum and govI are 0 in flight: DIRECT or LIMIT' })]);
    assert.equal(recs(direct, 'G3').length, 0);
    assert.match(direct.notes.join(' '), /because the governor does not control the headspeed \(check G0 DIRECT or LIMIT\)/);
    const cliDirect = setup.parseCli(CLI_TEXT.replace('gov_mode = ELECTRIC', 'gov_mode = DIRECT'));
    assert.equal(recs(run([g3], { cli: cliDirect }), 'G3').length, 0);
    assert.equal(recs(run([g3, f({ module: 'gov', id: 'G0', severity: 'ok', profile: null, value: 100, text: 'PID governor running' })], { cli: cliDirect }), 'G3').length, 1, 'the data show a PID governor: trust the data');
});

test('guard 9: D2 stalls and F5 lines that a tail notch of unknown order may cover are never actions', () => {
    const out = run([f({ module: 'setup', id: 'D2', profile: null, value: 0, text: '0 logging gaps in the log; in this segment 0 time jumps (0 frames missing, by loopIteration), 1 loop stalls' }),
        f({ module: 'setup', id: 'F5', value: 4.061, text: 'line at 4.061 x rotor (155.7 Hz, prominence 394.5): nearest notch roll 14 at 4 (1.5 %), pitch 14 at 4 (1.5 %), yaw 12 at 2 (103.0 %)' })]);
    for (const id of ['D2', 'F5']) assert.equal(only(out, id).severity, id==='F5'?'info':'check', id);
});

test('guard 10: wag_report section 8 is never used', () => {
    const out = run([f({ module: 'wag_report', id: 'T10', value: 2, text: 'yaw P 71.5 -> 54.7 for gain margin 2.1' })], { decisions: [Object.assign(decision(), { module: 'wag_report' })] });
    assert.equal(out.recommendations.filter(r => /^(T10|C7)/.test(r.id)).length, 0);
    assert.match(out.notes.join(' '), /The app ignores 2 items from section 8 of the tail oscillation report/);
});

test('guard 11: tuning order prerequisites, filters, governor, cyclic, tail; pitch before roll; GOVT F before I before P', () => {
    const out = run([TRACK('R1', { axis: 'roll', value: 80, se: 5, text: 'r' }), f({ id: 'T5', value: 2, se: 0.2, larger: 'ccw', text: 's' }),
        f({ id: 'C3', axis: 'roll', value: -0.3, se: 0.05, gyroRatio: { mean: 1, se: 0.01 }, text: 'FF too high' }), f({ id: 'C3', axis: 'pitch', value: -0.3, se: 0.05, gyroRatio: { mean: 1, se: 0.01 }, text: 'FF too high' }),
        f({ module: 'gov', id: 'G9', value: 9, se: 1, text: '(P-type)' }), f({ module: 'gov', id: 'G9', profile: 1, value: 9, se: 1, text: '(I-type)' }), f({ module: 'gov', id: 'G4', log: [5], value: 0.05, se: 0.004, text: '(load onset)' }),
        f({ module: 'setup', id: 'F6', value: 6, se: 1, text: 'f6' }), f({ module: 'gov', id: 'G1', profile: null, value: 1, text: 'g1' })]);
    const ids = out.recommendations.map(r => r.id);
    const at = (p) => ids.findIndex(i => i.startsWith(p));
    assert.ok(at('G1') < at('F6') && at('F6') < at('G4') && at('G4') < at('G9:gov_i') && at('G9:gov_i') < at('G9:gov_p'), ids.join(' '));
    assert.ok(at('G9:gov_p') < at('C3:pitch') && at('C3:pitch') < at('C3:roll') && at('C3:roll') < at('T5'), ids.join(' '));
    assert.ok(at('G1') < at('R1') && at('R1') < at('F6'), `the prerequisites first (R1 is information of the flight controller): ${ids.join(' ')}`);
    assert.deepEqual(out.recommendations.map(r => r.order), ids.map((_, i) => i + 1));
});

// Unmodified clivalue table from official firmware 118e9120260bb33f46df4f92052fb0e9fd4e9ebc.
// SHA-256: 2d011d02fc3e5cace3ff2e22001e2bb9ebe589263af4c0820711b4928c8ba173.
// The macros below are from pid.h and sensors/gyro.h.
const SETTINGS_FILE = path.join(__dirname, 'fixtures/rotorflight-4.6.0-settings.c');
const SETTINGS = fs.readFileSync(SETTINGS_FILE, 'utf8');
assert.equal(require('node:crypto').createHash('sha256').update(SETTINGS).digest('hex'),
    '2d011d02fc3e5cace3ff2e22001e2bb9ebe589263af4c0820711b4928c8ba173', 'Pinned official firmware settings source');
const MACRO = { PID_GAIN_MAX: 1000, LPF_MAX_HZ: 1000, DYN_LPF_MAX_HZ: 1000, DYN_NOTCH_COUNT_MAX: 8 };   // flight/dyn_notch_filter.h:29
function settingRange(name) {
    const line = SETTINGS.split('\n').find(l => l.includes(`"${name}"`) || l.includes(`PARAM_NAME_${name.toUpperCase()},`)); if (!line) return null;
    if (/MODE_ARRAY/.test(line) && /VAR_UINT8/.test(line)) return [0, 255]; // each array element uses its declared storage type
    const m = /minmaxUnsigned = \{\s*(\w+)\s*,\s*(\w+)\s*\}/.exec(line); if (!m) return [];
    return [m[1], m[2]].map(x => /^\d+$/.test(x) ? +x : MACRO[x]);
}

// gov_bypass_throttle is a MODE_ARRAY: settings.c gives no range (the storage, VAR_UINT8, holds 0-255), and governor.c
// divides each point by 200 (1.0 = 100 % throttle). The vendor copy is the file of release/4.6.0 (tools/autotune/firmware)
const GOVERNOR_C = fs.readFileSync(path.join(ROOT, 'tools/autotune/firmware/vendor/flight_governor.c'), 'utf8');
const ARRAY_RANGE = { gov_bypass_throttle: () => /gov\.throttleCurve\[i\] = governorConfig\(\)->gov_bypass_throttle\[i\] \/ 200\.0f;/.test(GOVERNOR_C) ? [0, 200] : null };

test('guard 5: every RANGE is the firmware range of settings.c (release/4.6.0)', () => {
    for (const [name, lim] of Object.entries(advice.RANGE)) assert.deepEqual(ARRAY_RANGE[name] ? ARRAY_RANGE[name]() : settingRange(name), lim, name);
    assert.deepEqual(settingRange('gov_bypass_throttle'), [0, 255], 'each point of the curve fits in its storage');
});

test('guard 12: every CLI name is a Rotorflight 4.6 name from health_setup PAIRS or TUNING_KNOWLEDGE', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tools/autotune/health_setup.cjs'), 'utf8');
    const pairs = new Function('require', 'module', 'exports', src + '\nreturn { PAIRS_PROFILE, PAIRS_GLOBAL };')((m) => require(path.join(ROOT, 'tools/autotune', m)), { exports: {} }, {});
    const known = new Map(pairs.PAIRS_PROFILE.concat(pairs.PAIRS_GLOBAL).map(p => [p[2].replace(/\[\d\]$/, ''), p[3]]));
    const doc = fs.readFileSync(path.join(ROOT, 'docs/TUNING_KNOWLEDGE.md'), 'utf8');
    for (const [name, [scope, , , def]] of Object.entries(advice.PARAMS)) {
        assert.ok(known.has(name) || doc.includes('`' + name + '`') || (SETTINGS && settingRange(name)), `${name} is neither in health_setup PAIRS, in TUNING_KNOWLEDGE.md nor in settings.c`);
        if (known.has(name) && known.get(name) !== null && def !== null) assert.equal(def, known.get(name), `${name} default`);
        assert.ok(scope === 'profile' || scope === 'global');
    }
    for (const bad of ['offset_bleed', 'offset_charge_curve', 'error_rotation', 'collective_impulse', 'dterm_lowpass']) assert.ok(!Object.keys(advice.PARAMS).some(k => k.includes(bad)), bad);
    // every parameter any recommendation names, CLI or not, over a run that exercises most generators
    const sink = run([f({ module: 'setup', id: 'F4', severity: 'note', profile: 'roll', value: 35, text: 'roll D cutoff 35 Hz' }), T14F(),
        f({ module: 'setup', id: 'F5', value: 3, text: 'line at 3 x rotor (115 Hz, prominence 40): nearest notch roll none, pitch none, yaw none' }), C3UP, f({ id: 'T7', value: 0.8, se: 0.05, precompScale: 1.44, text: 't7' }),
        f({ module: 'gov', id: 'G9', value: 9, se: 1, text: '(P-type)' }), f({ module: 'more', id: 'C14', value: 30, se: 4, gainChange: 30, gainChangeSe: 8, text: 'c14' }), f({ module: 'more', id: 'F10', axis: 'yaw', value: 0.8, se: 0.05, threshold: 'D share - 2 SE > 0.5 (yaw; roll and pitch are judged by C11)', text: 'f10' })],
        { cli: CLI, header: Object.assign({}, HEADER, { rates_type: 4, rollPID: [50, 200, 0, 100, 0] }), decisions: [decision()] });
    const named = [...new Set(sink.recommendations.map(r => r.parameter).filter(Boolean))];
    assert.ok(named.length >= 8, named.join(', '));
    for (const k of named) assert.ok(known.has(k) || advice.PARAMS[k] || doc.includes('`' + k + '`'), `${k} is not a known 4.6 name`);
    for (const r of sink.recommendations) for (const l of r.cli) assert.ok(/^profile \d$/.test(l) || advice.PARAMS[/^set (\w+) = /.exec(l)[1]], l);
});

test('H staleness: a change measured before the latest change of its parameter gets no CLI', () => {
    const t5 = f({ id: 'T5', log: 5, value: 2, se: 0.2, larger: 'ccw', text: 'stops' });
    const h = f({ module: 'setup', id: 'H', severity: 'note', log: 6, profile: 'start profile 1', value: '120,80', text: 'yaw_stop_gain: 120,100 -> 120,80 (since log 5, start profile 1)' });
    const old = only(run([t5, h], { headerLog: 6 }), 'T5');
    assert.deepEqual([old.severity, old.cli], ['check', []]);
    assert.match(old.caveats.join(' '), /The value of yaw_stop_gain changed between logs \(from 120,100 to 120,80 in log 6\)\. Thus, the results from log 5 can be from different values\./);
    // its step was sized on the old setting: no target, the present value only (Gaui #49 at 120/80 against 140/100 later)
    assert.deepEqual([old.title, old.from, old.to, old.direction], ['Measure yaw_ccw_stop_gain again', 80, null, 'check']);
    assert.match(old.text, /yaw_ccw_stop_gain is 80 at this time \(log header/);
    assert.doesNotMatch(old.text, /to 72/);
    const structured = only(run([t5, Object.assign({}, h, { headerKey: 'yaw_stop_gain', from: '120,100', since: 5, text: 'The diagnostic wording can change.' })], { headerLog: 6 }), 'T5');
    for (const key of ['severity','cli','title','from','to','direction','text','caveats']) assert.deepEqual(structured[key], old[key], key);
    assert.equal(only(run([Object.assign({}, t5, { log: 6 }), h], { headerLog: 6 }), 'T5').cli.length, 2, 'measured after the change, on the analysed log');
});

test('merge: two checks on one parameter make one recommendation; opposite directions make a check', () => {
    const c4 = f({ id: 'C4', axis: 'roll', value: 25, se: 3, settleS: { mean: 0.2, se: 0.02 }, text: 'FF too low (raise F)' });
    const same = only(run([C3UP, c4]), 'C');
    assert.equal(same.id, 'C3:roll_f_gain:p1');
    assert.match(same.caveats.join(' '), /Other checks agree on roll_f_gain: C4 increases it to 110\./);
    assert.equal(same.evidence.length, 2);
    const opposite = only(run([f({ id: 'C3', axis: 'roll', value: -0.3, se: 0.05, gyroRatio: { mean: 1, se: 0.01 }, text: 'FF too high' }), c4]), 'C');
    assert.equal(opposite.severity, 'check');
});

// ---------------------------------------------------------------------------------------------
// PID profiles (SPEC2 D12): from-values only from that profile, and the profiles never mix
// ---------------------------------------------------------------------------------------------

test('profiles: a from-value comes only from that PID profile (its CLI section or the header of the confirmed arming profile), never from another', () => {
    const out = run([T5F(), T5F({ profile: 2 })]), p1 = only(out, 'T5:yaw_ccw_stop_gain:p1'), p2 = only(out, 'T5:yaw_ccw_stop_gain:p2');
    assert.deepEqual([p1.from, p1.to, p1.fromSource, p1.cli], [80, 72, 'log header, PID profile 1 at the start of the log', ['profile 0', 'set yaw_ccw_stop_gain = 72']]);
    assert.deepEqual([p2.from, p2.to, p2.fromSource, p2.cli], [null, null, null, []], 'the header of PID profile 1 is not a value of PID profile 2');
    assert.match(p2.text, /analysis gives a decrease of yaw_ccw_stop_gain on PID profile 2 by 10 %\./i);
    assert.doesNotMatch(p2.text + p2.caveats.join(' '), /from 80|to 72/);
    for (const [r, p] of [[p1, 1], [p2, 2]]) { assert.ok(r.evidence.every(e => e.profile === p), r.id); assert.equal(r.profile, p); }
    // an inferred arming profile is not confirmed: the header then gives no PID profile value at all
    const inf = only(run([T5F()], { headerProfileInferred: true }), 'T5');
    assert.deepEqual([inf.from, inf.cli], [null, []]);
    assert.match(inf.caveats.join(' '), /The PID profile at the start of the log is only an estimate\. Thus, the log header gives the values of no known PID profile\./);
    // the CLI section of PID profile 2 (`profile 1`) gives its value, and the CLI text selects `profile 1`
    const cli = setup.parseCli(CLI_TEXT + 'set yaw_ccw_stop_gain = 100\n'), withCli = only(run([T5F({ profile: 2 })], { cli }), 'T5');
    assert.deepEqual([withCli.from, withCli.to, withCli.fromSource, withCli.cli], [100, 90, 'CLI dump, section `profile 1`', ['profile 1', 'set yaw_ccw_stop_gain = 90']]);
    // a governor F step on PID profile 2: not from the header F 10 of PID profile 1, and from the CLI section when it has one
    const g3 = f({ module: 'gov', id: 'G3', governorResponse: GOV_RESPONSE, profile: 2, log: [5], value: 0.07, se: 0.005, text: 'droop 7 %: F too low (GOVT)' });
    const noCli = only(run([g3]), 'G3');
    assert.deepEqual([noCli.from, noCli.to, noCli.cli], [null, null, []]);
    assert.match(noCli.text, /analysis gives an increase of gov_f_gain on PID profile 2 by 10\./i);
    assert.deepEqual([only(run([g3], { cli: CLI }), 'G3').from, only(run([g3], { cli: CLI }), 'G3').to], [25, 35], 'CLI `profile 1` has gov_f_gain 25');
});

test('profiles: causes, merges and the export keep each PID profile apart', () => {
    const t8 = f({ id: 'T8', profile: 2, value: 4, text: '60 episodes, 4.07 s at an output limit (mixer[2], servo[3])' });
    const out = run([T5F(), T5F({ profile: 2 }), t8], { cli: CLI });
    const p1 = only(out, 'T5:yaw_ccw_stop_gain:p1'), p2 = only(out, 'T5:yaw_ccw_stop_gain:p2');
    assert.deepEqual(p1.causes, [], 'the tail limit of PID profile 2 is no cause on PID profile 1');
    assert.deepEqual(p1.cli, ['profile 0', 'set yaw_ccw_stop_gain = 72']);
    assert.deepEqual(p2.causes.map(c => [c.rule, c.ids, c.holds]), [['K6', ['T8'], true]]);
    assert.deepEqual(p2.cli, []);
    assert.match(p2.caveats.join(' '), /This can be a result of the problems of check T8 \(rule K6, "[^"]+"\)\. The app gives no CLI text for it until you correct them\./);
    // two checks on one parameter merge only on one PID profile
    const c4 = (p) => f({ id: 'C4', axis: 'roll', profile: p, value: 25, se: 3, settleS: { mean: 0.2, se: 0.02 }, text: 'FF too low (raise F)' });
    const m = run([C3UP, c4(2)], { cli: setup.parseCli(CLI_TEXT + 'set roll_f_gain = 100\n') });
    assert.deepEqual(recs(m, 'C').map(r => [r.id, r.profile]).sort(), [['C3:roll_f_gain:p1', 1], ['C4:roll_f_gain:p2', 2]]);
    // the export: each change under its own `profile N`, and the comment of each change names its PID profile
    const text = advice.exportScript(out.recommendations, [p1.id, p2.id], {});
    assert.deepEqual(commands(text), ['batch start', 'profile 0', 'set yaw_ccw_stop_gain = 72', 'save']);
    assert.match(text, /# Change 1 of 1: Decrease the yaw CCW stop gain\n#   Recommendation `T5:yaw_ccw_stop_gain:p1`\.\n#   PID profile 1, CLI `profile 0`\./);
    assert.match(flat(text), /Not in the file: The yaw CCW stop gain: a decrease \(to examine\) \(`T5:yaw_ccw_stop_gain:p2`\)\./, 'a forced pick of the held change is refused');
});

// ---------------------------------------------------------------------------------------------
// The tuning sequence (hierarchy.cjs): node, order, gates, causes (SPEC2 3.5)
// ---------------------------------------------------------------------------------------------

const SEQUENCE = () => [C3UP, T5F(), f({ id: 'T8', value: 4, text: '60 episodes, 4.07 s at an output limit (mixer[2], servo[3])' }),
    f({ module: 'setup', id: 'F5', value: 3.789, text: 'line at 3.789 x rotor (284 Hz, prominence 400): nearest notch roll none, pitch none, yaw none' }),
    f({ module: 'gov', id: 'G3', governorResponse: GOV_RESPONSE, log: [5], value: 0.07, se: 0.005, text: 'droop 7 %: F too low (GOVT)' }), f({ module: 'gov', id: 'G12', profile: null, value: 1.006, se: 0.001, text: 'main rotor line at 1.006 x' }),
    f({ module: 'track', id: 'C5', axis: 'pitch', value: 2, unit: 'bursts', text: '2 self-excited bursts at 12 Hz' }), f({ module: 'setup', id: 'D2', profile: null, value: 0, text: '0 logging gaps in the log; in this segment 0 time jumps (0 frames missing, by loopIteration), 1 loop stalls' })];

test('sequence: every recommendation has its node; the list follows the step and row of the node; fid and summary in every evidence row', () => {
    const findings = SEQUENCE(), out = run(findings, { cli: CLI }), NODE = { C3: 'cyclic', T5: 'tailcomp', T8: 'tailcomp', F5: 'filters', G3: 'governor', G12: 'rpm', C5: 'cyclic', D2: 'logging', D4: 'logging' };
    for (const r of out.recommendations) { const id = r.id.split(':')[0]; if (NODE[id]) assert.equal(r.node, NODE[id], r.id); }
    const step = (r) => { const n = (H ? H.NODES : []).find(x => x.id === r.node); return n ? n.step * 10 + n.row : 99; };
    if (H) out.recommendations.forEach((r, i, a) => { if (i) assert.ok(step(a[i - 1]) <= step(r), `${a[i - 1].id} before ${r.id}`); });
    const fids = new Set(findings.map(x => x.fid));
    for (const r of out.recommendations) for (const e of r.evidence) { assert.ok(fids.has(e.fid), `${r.id}: ${e.fid}`); assert.ok(e.summary === null || typeof e.summary === 'string'); }
    // the worker's summary goes into the row as it is; without one, catalog.cjs gives it (when it loads)
    const own = only(run([Object.assign({}, T5F(), { summary: 'The summary of the result.' })]), 'T5');
    assert.equal(own.evidence[0].summary, 'The summary of the result.');
});

test('sequence: a gate holds a recommendation if and only if the diagram (hierarchy.cjs status) shows its node Blocked', { skip: !H }, () => {
    for (const findings of [SEQUENCE(), SEQUENCE().slice(0, 4), [C3UP, f({ module: 'setup', id: 'F5', value: 3.789, text: 'line at 3.789 x rotor (284 Hz, prominence 400): nearest notch roll none, pitch none, yaw none' })], [T5F(), C3UP]]) {
        const out = run(findings, { cli: CLI }), opts = { logs: LOGS, header: HEADER, cli: CLI }, all = H.status(findings, out.recommendations, opts);
        // the status of the PID profile of the recommendation (SPEC2 D12), or of all profiles for one with no PID profile
        const statusOf = (r) => r.scope === 'global' || typeof r.profile !== 'number' ? all : H.status(findings, out.recommendations, Object.assign({ profile: r.profile }, opts));
        for (const r of out.recommendations) {
            const blocked = !!r.node && all.nodes[r.node].status === 'blocked', P = statusOf(r).nodes[r.node];
            assert.equal(r.gate !== null, blocked, `${r.id} on ${r.node}: gate ${JSON.stringify(r.gate)}, status ${r.node && all.nodes[r.node].status}`);
            if (!r.gate) continue;
            assert.deepEqual(r.gate.by.slice().sort(), all.nodes[r.node].blockedBy.slice().sort(), r.id);
            assert.deepEqual(r.gate.profileBy.slice().sort(), (P.status === 'blocked' ? P.blockedBy : []).slice().sort(), `${r.id}: the steps of its PID profile`);
            assert.ok(r.gate.held.every(u => r.gate.profileBy.includes(u)), `${r.id}: only a step of its own PID profile holds it`);
        }
    }
    // per PID profile: the ground resonance of PID profile 2 (a mechanics problem) blocks the cyclic changes of PID profile 2, not those of PID profile 1
    const c15 = f({ module: 'phase', id: 'C15', profile: 2, axis: 'roll', value: 9, unit: 'deg/s', growth: 3, growthSe: 0.5, text: 'x' }), c3 = (p) => Object.assign({}, C3UP, { fid: `c3p${p}`, profile: p });
    const two = run([c3(1), c3(2), c15], { cli: CLI }), g1 = only(two, 'C3:roll_f_gain:p1'), g2 = only(two, 'C3:roll_f_gain:p2');
    assert.deepEqual([g1.gate.by, g1.gate.profileBy, g1.gate.held, g1.blockedBy], [['mechanics'], [], [], []], 'Blocked in "All profiles", not in PID profile 1');
    assert.match(g1.caveats.join(' '), /Its problem is on a different axis or PID profile\. Thus, it does not hold this change\./);
    assert.ok(g1.cli.length > 0, 'PID profile 1 keeps its CLI text');
    assert.deepEqual([g2.gate.by, g2.gate.profileBy, g2.gate.held, g2.cli], [['mechanics'], ['mechanics'], ['mechanics'], []]);
    assert.match(g2.blockedBy.join(' '), /^The prerequisite "Mechanical parts" has a problem \(check C15\)\. Correct it before you tune this tuning block\.$/);
    assert.equal(H.status([c3(1), c3(2), c15], two.recommendations, { profile: 1 }).nodes.cyclic.status === 'blocked', false);
    // the RPM signal gates only the RPM notch filters (scope of the gate): a low-pass filter change keeps its CLI text
    const g1f = f({ module: 'gov', id: 'G1', profile: null, value: 2, text: 'g1' }), f1 = f({ module: 'setup', id: 'F1', profile: null, value: 0, text: 'f1' }), f5 = f({ module: 'setup', id: 'F6', value: 4, se: .5 });
    const hdr = Object.assign({}, HEADER, { gyro_soft_type: 0, gyro_lowpass_hz: 0, gyro_soft2_type: 0, gyro_lowpass2_hz: 0, gyro_lowpass_dyn_hz: [0, 0], features: RPMF });
    const lone = run([g1f, f1], { cli: CLI, header: hdr }), lpf = only(lone, 'F1');
    assert.deepEqual([lpf.gate, lpf.cli.length > 0], [null, false], 'F1 is reference information, with no CLI');
    assert.notEqual(H.status([g1f, f1], lone.recommendations, {}).nodes.filters.status, 'blocked');
    const both = run([g1f, f1, f5], { cli: CLI, header: hdr }), lpf2 = only(both, 'F1'), st2 = H.status([g1f, f1, f5], both.recommendations, {});
    assert.deepEqual([st2.nodes.filters.status, st2.nodes.filters.blockedBy], ['blocked', ['rpm']], 'an RPM notch problem: blocked by the RPM signal');
    assert.deepEqual([lpf2.gate.by, lpf2.gate.held, lpf2.cli.length > 0], [['rpm'], [], false]); assert.match(lpf2.caveats.join(' '), /It holds only the changes of checks F3, F5, F6 and F9\./);
    // the copy of the gate table in advice gives the same gates when hierarchy.cjs does not load
    const src = fs.readFileSync(path.join(ROOT, 'tools/autotune/advice.cjs'), 'utf8'), bare = { exports: {} };
    new Function('require', 'module', 'exports', src)((m) => { if (/hierarchy|catalog/.test(m)) throw new Error(`Cannot find module '${m}'`); return require(path.join(ROOT, 'tools/autotune', m)); }, bare, bare.exports);
    const gated = (A) => A.advise({ findings: SEQUENCE(), decisions: null, header: HEADER, cli: CLI, logs: LOGS, fields: null, headerProfile: 1, headerLog: 5 }).recommendations.filter(r => r.gate).map(r => r.id).sort();
    assert.deepEqual(gated(bare.exports), gated(advice));
});

test('sequence: FF after D, P and I on the same axis and PID profile (K7); a cause that is only a watch does not hold the CLI', () => {
    const rollP = decision({ axis: 'roll', changes: [{ gain: 'P', multiplier: 0.9, from: 50, to: 45, improves: 'tracking' }] });
    const out = run([C3UP], { decisions: [rollP] }), c3 = only(out, 'C3'), p = only(out, 'C7');
    assert.deepEqual(p.cli, ['profile 0', 'set roll_p_gain = 45']);
    assert.deepEqual(c3.cli, []);
    assert.match(c3.blockedBy.join(' '), /A change of the P gain of the roll axis comes first\. The FF page puts the FF gain after the other gains \(rule K7\)\./);
    assert.ok(out.recommendations.indexOf(p) < out.recommendations.indexOf(c3), 'D, P and I before FF');
    // a change on another axis, or on another PID profile, does not hold the FF
    assert.deepEqual(only(run([C3UP], { decisions: [decision({ axis: 'pitch', changes: rollP.changes.map(x => Object.assign({}, x, { from: 50 })) })] }), 'C3').cli, ['profile 0', 'set roll_f_gain = 115']);
    assert.deepEqual(only(run([C3UP], { decisions: [Object.assign({}, rollP, { bin: 2500 })] }), 'C3').cli, ['profile 0', 'set roll_f_gain = 115']);
    // K7: one burst of roll oscillation is a watch, and it does not hold the FF; two bursts are a check, and they do
    const burst = (v) => f({ module: 'track', id: 'C5', axis: 'roll', value: v, unit: 'bursts', text: 'bursts' });
    const watchOnly = only(run([C3UP, burst(1)]), 'C3');
    assert.deepEqual(watchOnly.causes.map(c => [c.rule, c.holds]), [['K7', false]]);
    assert.deepEqual(watchOnly.cli, ['profile 0', 'set roll_f_gain = 115']);
    const real = only(run([C3UP, burst(2)]), 'C3');
    assert.deepEqual(real.causes.map(c => [c.rule, c.ids, c.holds]), [['K7', ['C5'], true]]);
    assert.ok(real.causes[0].fids.length === 1 && /^t\d+$/.test(real.causes[0].fids[0]) && real.causes[0].first.length > 0, JSON.stringify(real.causes));
    assert.deepEqual(real.cli, []);
});

test('no copied finding text: the recommendations, notes and coverage use their own words, not the text of a finding', () => {
    const mark = (x) => Object.assign({}, x, { text: `${x.text} zqxj marker` });
    const findings = SEQUENCE().concat([T14F(), f({ id: 'T6', value: 50, se: 5, towardTorque: { mean: 30, se: 5 }, text: 'kick' }), f({ id: 'T7', value: 0.8, se: 0.05, precompScale: 1.44, text: 't7' }),
        f({ id: 'C4', axis: 'roll', value: 25, se: 3, settleS: { mean: 0.2, se: 0.02 }, text: 'FF too high' }), f({ id: 'C1', axis: 'roll', value: 3, text: 'I at limit' }), f({ id: 'C6', axis: 'pitch', value: 9, text: 'driven by I' }),
        f({ module: 'more', id: 'T13', value: -0.24, se: 0.004, text: 'hover yaw I' }), f({ module: 'more', id: 'F10', axis: 'yaw', value: 0.8, se: 0.05, text: 'f10' }),
        f({ module: 'gov', id: 'G6', value: 90, text: 'median throttle 90 %' }), f({ module: 'gov', id: 'G9', value: 9, se: 1, text: '(P-type)' }), f({ module: 'gov', id: 'G10', value: 0.7, se: 0.05, text: 'coherence' }),
        f({ module: 'more', id: 'D6', profile: null, value: 2.5, unit: 's', text: 'failsafe 2.5 s' }), f({ module: 'setup', id: 'F6', value: 6, se: 1, text: 'f6' }),
        TRACK('C12', { axis: 'roll', value: 0.6, se: 0.02, text: 'c12' }), TRACK('R1', { axis: 'roll', value: 80, se: 5, text: 'r' }),
        f({ module: 'phase', id: 'G15', rampRate: 10, yawRate: 300, text: 'g15' }), f({ module: 'phase', id: 'C15', axis: 'roll', hz: 8.4, text: 'c15' })]).map(mark);
    const out = run(findings, { cli: CLI });
    const texts = out.recommendations.flatMap(r => [r.title, r.text, r.rule].concat(r.caveats, r.blockedBy)).concat(out.notes, out.coverage.map(c => c.detail));
    assert.ok(out.recommendations.length >= 20, String(out.recommendations.length));
    for (const t of texts) assert.doesNotMatch(String(t), /zqxj/, t);
    noGearDoubt(out);
});

// ---------------------------------------------------------------------------------------------
// The phase checks of health_phase.cjs (SPEC2 D13, section 6): D7, G15-G18, C15
// ---------------------------------------------------------------------------------------------

// findings in the shape that health_phase.cjs judge gives them (its fields, not its text)
const PH = (id, o) => f(Object.assign({ module: 'phase', id, phase: { D7: null, G15: 'spoolup', G16: 'spoolup', G17: null, G18: 'idle', C15: 'ground' }[id],
    unit: { D7: 's', G15: 'deg/s', G16: 'fraction', G17: 'count', G18: 'fraction', C15: 'deg/s' }[id], thin: false }, o));
const D7F = (log, bench, o = {}) => PH('D7', Object.assign({ severity: 'note', log, profile: null, bench, class: bench ? 'bench' : 'flight', flights: bench ? [] : [{ t0: 14, t1: 190 }, { t0: 200, t1: 260 }], n: bench ? 0 : 2,
    phaseSeconds: bench ? { idle: 3, spoolup: 9.5, ground: 20, flight: 0, spooldown: 6 } : { idle: 3, spoolup: 9.5, ground: 4, flight: 236, spooldown: 6 }, threshold: 'report only' }, o));

test('D7: bench runs are listed and not analysed; flight logs give their flights and phases (information)', () => {
    const out = run([D7F(3, true), D7F(4, true), D7F(5, false)]);
    const bench = only(out, 'D7:bench'), fl = out.recommendations.find(r => r.id === 'D7');
    assert.deepEqual([bench.severity, bench.title, bench.node, bench.cli], ['info', 'Bench runs (not in the analysis)', 'controller', []]);
    assert.match(bench.text, /^Logs 3 and 4 have no flight\. Thus, the analysis does not use these bench runs\.$/);
    assert.doesNotMatch(only(run(Array.from({ length: 9 }, (_, i) => D7F(10 + i, true))), 'D7:bench').text, /\)\)/, 'no double parenthesis');
    assert.match(fl.text, /The analysis found 2 flights in log 5\. The phases are: idle 3 s, spool-up 9\.5 s, ground 4 s, flight 236 s and spool-down 6 s\./);
    assert.equal(fl.severity, 'info');
});

test('G15-G18: spool-up, the change to ACTIVE, motor kicks and IDLE are checks on "Set the governor", never CLI', () => {
    const cli = setup.parseCli(CLI_TEXT.replace('# master\n', '# master\nset gov_spoolup_time = 100\n'));
    const g15 = PH('G15', { value: 300, n: 2, threshold: { yawFlag: 150, yawNote: 50, limit: 150 }, throttlePctPerS: { mean: 10.1, se: 0.1 }, impliedSpoolupTime: 99, seconds: { mean: 9.8, se: 0.2 } });
    const out = run([g15, PH('G16', { value: 0.034, se: null, n: 1, overshoot: 0.034, undershoot: -0.002, throttleStepPct: 4, settleS: 1.2, reference: 'govTarget' }),
        PH('G17', { value: 2, n: 2, byKind: { 'motor step': 1, 'rotor turns with no motor output': 0, 'headspeed decrease': 1 }, events: [{ t: 3, kind: 'motor step', phase: 'idle' }, { t: 90, kind: 'headspeed decrease', phase: 'flight' }] }),
        PH('G18', { profile: null, value: 0.08, se: 0.01, n: 5, headspeed: 450 })], { cli });
    for (const r of out.recommendations.filter(x => /^G1[5-8]/.test(x.id))) { assert.deepEqual([r.node, r.cli, r.severity], ['governor', [], 'check'], r.id); }
    const r15 = only(out, 'G15');
    assert.deepEqual([r15.parameter, r15.from, r15.to, r15.direction, r15.fromSource], ['gov_spoolup_time', 100, 120, 'raise', 'CLI dump']);
    assert.match(r15.text, /The largest yaw rate on the ground during a spool-up is 300 deg\/s \(log 5, PID profile 1\)\. The throttle increases at 10\.1 ± 0\.1 %\/s\. [\s\S]*The analysis gives a change of gov_spoolup_time from 100 to 120 \(CLI dump\)\./);
    assert.doesNotMatch(r15.text + r15.title, /Set gov_spoolup_time|Make the spool-up/, 'a check has no instruction to change a value');
    assert.match(r15.rule, /It has a problem at 150 deg\/s or more, and it gives a value to monitor at 50 deg\/s or more\./);
    assert.match(r15.caveats.join(' '), /in units of 0\.1 s/);
    // without the CLI dump: the value that the throttle ramp shows, an estimate with no CLI text
    const est = only(run([g15]), 'G15');
    assert.deepEqual([est.from, est.to, est.cli], [99, 118, []], '99 x 1.2 = 118.8: the bounded step stays at the bound');
    assert.match(est.text, /The full change is an increase of 20\. The analysis gives a step of gov_spoolup_time from approximately 99 to 118 \(the throttle ramp of the spool-ups in the log\)\./);
    assert.match(only(out, 'G16').text, /The largest headspeed error is 3\.40 % more than the target \(log 5, PID profile 1\)\. At the change, the throttle changes by 4 %, and the headspeed becomes stable after 1\.2 s\. A slower spool-up can possibly give a smaller overshoot \(no flight test\), and a larger gov_spoolup_time gives a slower spool-up\.$/);
    assert.match(only(out, 'G16').caveats.join(' '), /With gov_use_pid_spoolup ON, the governor PID controls the headspeed during the spool-up/);
    assert.match(only(out, 'G16').caveats.join(' '), /Check G16 gives no SE for these results, because each log has 1 change from SPOOLUP to ACTIVE\./, 'D-LOW: the reason for no SE');
    assert.match(out.recommendations.find(r => r.id === 'G17').text, /changes with no throttle change at IDLE\./);
    assert.match(only(out, 'G17:drop').text, /The headspeed decreases while the throttle does not decrease \(in flight\)\. This can be a sync loss of the ESC/);
    assert.match(only(out, 'G18').text, /At IDLE, the rms change of the headspeed is 8\.0 ± 1\.0 % of 450 rpm\./);
    // a note is a watch, thin data gives nothing; a governor in DIRECT keeps the spool-up check (guard 8 is for the gains)
    assert.equal(only(run([PH('G15', { severity: 'note', value: 80 })]), 'G15').severity, 'watch');
    assert.equal(recs(run([PH('G18', { severity: 'note', thin: true, value: 0.02 })]), 'G18').length, 0);
    assert.equal(recs(run([g15, f({ module: 'gov', id: 'G0', severity: 'note', profile: null, value: 0, text: 'DIRECT or LIMIT' })]), 'G15').length, 1);
    // the tail limit holds governor gain increases, not a slower spool-up
    assert.deepEqual(only(run([g15, f({ id: 'T8', value: 4, text: '60 episodes' })], { cli }), 'G15').blockedBy.filter(b => /T8/.test(b)), []);
    noGearDoubt(out);
});

test('C15: an oscillation on the skids before liftoff is a check for the pilot procedure, never a gain change', () => {
    const r = only(run([PH('C15', { axis: 'roll', value: 7.2, hz: 8.46, hzSe: 0.11, growth: 3.34, growthSe: 0.74, collective: -120, headspeed: 2100 })]), 'C15');
    assert.deepEqual([r.node, r.severity, r.cli, r.parameter, r.axis], ['mechanics', 'check', [], null, 'roll']);
    assert.match(r.text, /The roll rate has an oscillation on the skids at 8\.46 ± 0\.11 Hz of 7\.2 deg\/s rms\. Its rms increases at 3\.34 ± 0\.74 \/s \(the slope of `ln\(rms\)`\)\. Keep the collective low until the governor is ACTIVE\. Then do the liftoff in one movement\./);
    assert.match(r.rule, /Sources: .*"a result on a different helicopter \('Gaui X4 II', 2026-10-04\), not from the logs of this analysis: in 3 of 3 flights/, 'review V3: the Gaui result is a source, labelled as a different helicopter');
    assert.doesNotMatch(r.caveats.join(' ') + r.text, /GROUND-LIFTOFF-OSC|FINDINGS|analysis\/|8\.3 Hz to 8\.7 Hz/, 'review V3: no result of a different helicopter as a note or in the text');
});

// ---------------------------------------------------------------------------------------------
// Coverage, purity, script, loading
// ---------------------------------------------------------------------------------------------

test('coverage: a row per group, every PAIRS parameter covered, statuses from the findings', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tools/autotune/health_setup.cjs'), 'utf8');
    const pairs = new Function('require', 'module', 'exports', src + '\nreturn { PAIRS_PROFILE, PAIRS_GLOBAL };')((m) => require(path.join(ROOT, 'tools/autotune', m)), { exports: {} }, {});
    const out = run([f({ id: 'T5', value: 2, se: 0.2, larger: 'ccw', text: 's' }), f({ module: 'setup', id: 'F5', severity: 'skipped', text: 'log lacks gyroRAW' }),
        f({ module: 'gov', id: 'G3', severity: 'note', text: 'no finding: 0 collective rises' })]);
    assert.equal(out.coverage.length, advice.COVERAGE.length);
    const glob = (p) => new RegExp('^' + p.replace(/[.[\]]/g, '\\$&').replace(/\*/g, '.*') + '$');
    for (const p of pairs.PAIRS_PROFILE.concat(pairs.PAIRS_GLOBAL).map(q => q[2].replace(/\[\d\]$/, '')))
        assert.ok(out.coverage.some(r => r.parameters.some(x => glob(x).test(p))), `${p} has no coverage row`);
    for (const r of out.coverage) assert.ok(['finding', 'checked', 'no-check', 'not-assessable', 'not-in-log', 'needs-fields', 'needs-flights'].includes(r.status), r.group);
    // the CLI dump is an optional input (user rule 2026-10-06): no row asks for it
    for (const r of out.coverage) assert.doesNotMatch(r.detail, /CLI dump|diff all|you did not load/i, r.group);
    const row = (g) => out.coverage.find(r => r.group === g);
    assert.equal(row('Stop gains').status, 'finding');
    assert.equal(row('Governor F').status, 'needs-flights');
    // no check of the app: no-check where a log could tell (the data are logged), not-assessable where no log can
    assert.equal(row('Yaw B').status, 'no-check');
    assert.equal(row('Notch filters at one frequency').status, 'no-check');
    assert.equal(row('I-term relax level').status, 'not-assessable');
    assert.match(row('I-term relax level').detail, /The log does not record this value, and no check examines it\./);
    // the log header records min_throttle and max_throttle (`minthrottle`, `maxthrottle`): no check, not "no log can show it"
    assert.equal(row('ESC throttle range').status, 'no-check');
    assert.match(row('ESC throttle range').detail, /The log header records them \(`minthrottle`, `maxthrottle`\)\./);
    assert.equal(run([], { cli: CLI }).coverage.find(r => r.group === 'Cyclic rate limit').status, 'not-assessable');
    // no result at all: more flights, not a CLI dump
    assert.equal(run([]).coverage.find(r => r.group === 'Motor poles and gear ratios').status, 'needs-flights');
    // a row whose checks were not done only because the log does not record a value: not-in-log, with no request for a dump
    const gear = run([f({ module: 'setup', id: 'F6', severity: 'skipped', text: 'yaw source 21 (tail rotor): order unknown without gear ratios' })]).coverage.find(r => r.group === 'Motor poles and gear ratios');
    assert.deepEqual([gear.status, /The log does not record the values that these checks use\./.test(gear.detail)], ['not-in-log', true]);
    const servo = run([f({ module: 'limits', id: 'L5', severity: 'skipped', limitUnknown: true, text: 'servo[0]: the limit is unknown. The log header does not record the servo limits.' })]).coverage.find(r => r.group === 'Servos');
    assert.equal(servo.status, 'not-in-log');
    const recorded = run([f({ module: 'setup', id: 'F6', severity: 'skipped', text: 'The rotor order is unknown. The log does not record its rotor frequency.' })]).coverage.find(r => r.group === 'Motor poles and gear ratios');
    assert.equal(recorded.status, 'not-in-log');
    const raw = run([], { fields: { 'gyroRAW[0]': 'absent' } }).coverage.find(r => r.group === 'Motor poles and gear ratios');
    assert.equal(raw.status, 'needs-fields', 'without raw gyro F5/F6 cannot run even with a dump');
    assert.match(raw.detail, /The log does not have these fields: `gyroRAW\[0\]`\./);
    assert.doesNotMatch(raw.detail, /CLI dump/);
});

// user rule 2026-10-06: the log is the only necessary input. A row whose checks ran on the data is judged on the data, also
// when the log header does not record its values (the coverage order bug: "CLI dump necessary" in place of more flights)
test('coverage: a row whose checks ran on the data is needs-flights or checked without a CLI dump, never a request for a dump', () => {
    const row = (out, g) => out.coverage.find(r => r.group === g);
    const thinOf = (id, module) => f({ module, id, severity: 'note', thin: true, value: null, text: 'no finding: too little data' });
    const out = run([thinOf('C10', 'loop'), thinOf('R1', 'track'), thinOf('C2', 'loop'), thinOf('C8', 'loop'), thinOf('G1', 'gov'), thinOf('G2', 'gov'), thinOf('G6', 'gov'), thinOf('G7', 'gov'), thinOf('L1', 'limits')]);
    assert.deepEqual(['Airborne condition', 'rc_smoothness', 'Swash plate limits', 'Swash plate phase', 'Governor headspeed', 'Throttle limits'].map(g => row(out, g).status),
        ['needs-flights', 'needs-flights', 'needs-flights', 'needs-flights', 'needs-flights', 'needs-flights']);
    // the log header records the battery levels (vbatcellvoltage): the row follows its checks
    const bat = run([f({ module: 'power', id: 'P1', severity: 'ok', value: 0.1, se: 0.01, text: 'ok' })]);
    assert.equal(row(bat, 'Battery and cells').status, 'checked');
    assert.match(row(bat, 'Battery and cells').detail, /The log header records the cell voltage levels \(`vbatcellvoltage`\)\./);
    // with a CLI dump the rows are assessed as before
    assert.equal(row(run([thinOf('C10', 'loop')], { cli: CLI }), 'Airborne condition').status, 'needs-flights');
    for (const r of out.coverage.concat(bat.coverage)) assert.doesNotMatch(r.detail, /CLI dump|you did not load/i, r.group);
});

test('coverage: a row counts the findings about its own parameters', () => {
    const row = (out, g) => out.coverage.find(r => r.group === g);
    // T13 says tail trim, not the gains: it marks the tail mechanics, not yaw I
    const t13 = run([f({ module: 'more', id: 'T13', value: 0.3, se: 0.02, text: 'hover yaw I: the integrator carries a constant hover trim; check the tail centre and zero-pitch calibration (tail_center_trim, MIXS), not the gains' })]);
    assert.notEqual(row(t13, 'Yaw I').status, 'finding');
    assert.equal(row(t13, 'Tail mechanical parts and limit').status, 'finding');
    // a report.cjs decision counts on the rows of its axis and gain
    const c7 = run([], { decisions: [decision()] });                                   // pitch F x0.8
    assert.deepEqual(['Cyclic F', 'Cyclic P', 'Yaw P'].map(g => row(c7, g).status), ['finding', 'checked', 'needs-flights']);
    // D4 marks the governor mode only when it names gov_mode (the mode clash)
    const d4 = (text) => run([f({ module: 'setup', id: 'D4', profile: 0, value: 1, text })], { cli: CLI });
    assert.notEqual(row(d4(D4_TEXT), 'Governor mode').status, 'finding');
    assert.equal(row(d4(D4_TEXT + ' CLI gov_mode ELECTRIC but the data shows no PID governor output (DIRECT/LIMIT/OFF): trust the data for the mode.'), 'Governor mode').status, 'finding');
    // the battery row names the CLI settings (vbatcellvoltage is the header key)
    assert.ok(['vbat_min_cell_voltage', 'vbat_warning_cell_voltage', 'vbat_max_cell_voltage'].every(k => row(t13, 'Battery and cells').parameters.includes(k)));
    assert.ok(!row(t13, 'Battery and cells').parameters.includes('vbatcellvoltage'));
    // T6 measures the kick size and sign, not the lag: the precomp cutoff has no check
    assert.equal(row(run([f({ id: 'T6', value: 50, se: 5, towardTorque: { mean: 30, se: 5 }, text: 'kick' })]), 'Precompensation cutoff').status, 'no-check');
});

test('coverage: no check reads ESC telemetry; the PID mode is judged on the CLI capture', () => {
    const row = (out, g) => out.coverage.find(r => r.group === g);
    const esc = run([f({ module: 'gov', id: 'G12', profile: null, value: 1.2, se: 0.001, text: 'main rotor line at 1.2 x' })], { fields: { Tesc: 'present', Ibat: 'present', EscRPM: 'absent' } });
    assert.equal(row(esc, 'ESC telemetry').status, 'no-check', 'a G12 flag is about poles and gear');
    assert.match(row(esc, 'ESC telemetry').detail, /ESC fields of the selected log: `EscRPM` missing, .*`Tesc` recorded and `Ibat` recorded\. No check uses them\./);
    assert.equal(row(esc, 'Motor poles and gear ratios').status, 'finding');
    // without a CLI dump: the log does not record pid_mode (no request for a dump, user rule 2026-10-06)
    assert.equal(row(run([]), 'PID mode').status, 'not-in-log');
    assert.match(row(run([]), 'PID mode').detail, /^The log does not record pid_mode\./);
    assert.doesNotMatch(row(run([]), 'PID mode').detail, /CLI dump/);
    assert.equal(row(run([], { cli: CLI }), 'PID mode').status, 'checked', 'a diff leaves the default 3 out');
    assert.match(row(run([], { cli: CLI }), 'PID mode').detail, /CLI pid_mode: 3 \(not in the CLI dump, thus the default\) in the sections `profile 0` and `profile 1`\./);
    const four = run([], { cli: setup.parseCli(CLI_TEXT + 'set pid_mode = 4\n') });
    assert.equal(row(four, 'PID mode').status, 'finding');
    const r = only(four, 'SETUP:pid_mode');
    assert.deepEqual([r.severity, r.cli], ['check', []]);
    assert.match(r.text, /pid_mode is 4 in PID profile 2 \(section `profile 1`\)\. All gain recommendations here are for pid_mode 3\./);
});

test('advise is pure and deterministic', () => {
    const input = { findings: [C3UP, f({ id: 'T8', value: 4, text: '4 s at an output limit (mixer[2])' }), f({ module: 'setup', id: 'D2', profile: null, value: 0, text: '1 loop stalls' })], decisions: [decision()], header: HEADER, cli: CLI, logs: LOGS, fields: { 'gyroRAW[0]': 'present' }, headerProfile: 1, headerLog: 5 };
    const before = JSON.stringify(input), a = JSON.stringify(advice.advise(input)), b = JSON.stringify(advice.advise(JSON.parse(before)));
    assert.equal(JSON.stringify(input), before, 'input changed');
    assert.equal(a, b);
});

// the commands of a CLI file: every line that is not a comment
const commands = (text) => text.split('\n').filter(l => l && !l.startsWith('#'));
// the comment text of a CLI file with the sentences of one comment together again (commentLines puts each on a line)
const flat = (text) => text.replace(/\n#(?:   | )(?=[^\n])/g, ' ');
const T5F = (o = {}) => f(Object.assign({ id: 'T5', value: 2, se: 0.2, larger: 'ccw', text: 's' }, o));

test('script: the CLI file with the default picks: batch start, profile sets, global sets, save; nothing without actions', () => {
    const out=run([f({module:'setup',id:'D1',profile:null,value:500})],{header:{...HEADER,frameIntervalPDenom:4}});
    assert.deepEqual(commands(advice.script(out.recommendations)),['batch start','set blackbox_rate_denom = 2','save']);
    const two = commands(advice.script(run([T5F(), T5F({ profile: 2 })], { cli: CLI }).recommendations));
    assert.deepEqual(two, ['batch start', 'profile 0', 'set yaw_ccw_stop_gain = 72', 'profile 1', 'set yaw_ccw_stop_gain = 72', 'save']);
    assert.equal(advice.script(run([]).recommendations), '');
    // a title is one comment line whatever it holds: no line of a title reaches the CLI
    const odd = [{ id: 'a', severity: 'action', scope: 'global', title: 'Increase the LPF cutoff\nsave', cli: ['set gyro_lpf1_static_hz = 100'] },
        { id: 'b', severity: 'action', scope: 'profile', profile: 1, cliProfile: 0, title: 'Decrease the yaw P gain\r\nsave\n', cli: ['profile 0', 'set yaw_p_gain = 63'] }];
    const text = advice.script(odd);
    assert.deepEqual(commands(text), ['batch start', 'profile 0', 'set yaw_p_gain = 63', 'set gyro_lpf1_static_hz = 100', 'save']);
    assert.ok(text.includes('# Change 1 of 2: Increase the LPF cutoff save\n') && text.includes('# Change 2 of 2: Decrease the yaw P gain save\n'), text);
});

test('exportScript (SPEC2 D11): provenance, the backup step, from and to with evidence and rule, grouped profile, rate profile, global, then save', () => {
    // a global change that holds no tail change: the log rate (D1, PID loop 2 kHz / 4 = 500 Hz)
    const out = run([T5F(), T5F({ profile: 2 }), f({ module: 'setup', id: 'D1', profile: null, value: 500, text: 'logging 500 Hz nominal' })], { cli: CLI, header: Object.assign({}, HEADER, { frameIntervalPDenom: 4 }) });
    const ids = advice.defaultPicks(out.recommendations);
    assert.deepEqual(ids.slice().sort(), ['D1', 'T5:yaw_ccw_stop_gain:p1', 'T5:yaw_ccw_stop_gain:p2'], 'the actions with CLI text');
    // the meta of the Export tab (js/tuning_dialog.js): logs as the viewer counts them, flights as one text line
    const meta = { craft: 'Gaui X4 "II"', file: 'x4.bbl', logs: [50, 51], flights: '2 flights in 2 logs', firmware: 'Rotorflight 4.6.0', profiles: [1, 2], date: '2026-10-05', logBase: 1, activeProfile: 0, activeRateProfile: null };
    // the rate profile group: a synthetic rate change (no generator writes one at this time)
    const rate = { id: 'R:x', severity: 'action', scope: 'rateprofile', rateProfile: 2, profile: null, title: 'Rate test', cli: ['rateprofile 1', 'set blackbox_rate_denom = 2'], evidence: [], blockedBy: [], causes: [] };
    assert.match(flat(advice.exportScript([rate], ['R:x'], {})), /`blackbox_rate_denom` is not a rate profile value\./, 'a global name under a rate profile');
    const rateOk = Object.assign({}, rate, { cli: ['rateprofile 1', 'set roll_rc_rate = 2'] });   // no PARAMS name has the rate profile scope at this time
    assert.match(advice.exportScript([rateOk], ['R:x'], {}), /`roll_rc_rate` is not a name that the app writes/);
    const text = advice.exportScript(out.recommendations, null, meta), lines = text.split('\n');
    assert.deepEqual(commands(text), ['batch start', 'profile 0', 'set yaw_ccw_stop_gain = 72', 'profile 1', 'set yaw_ccw_stop_gain = 72', 'set blackbox_rate_denom = 2', 'profile 0', 'save']);
    assert.ok(lines.includes('# Craft name: "Gaui X4 \'II\'"') && lines.includes('# Log file: "x4.bbl"') && lines.includes('# Logs: 50 and 51') && lines.includes('# Flights: 2 flights in 2 logs'), text);
    assert.ok(lines.includes('# Firmware: "Rotorflight 4.6.0"') && lines.includes('# PID profiles in the analysis: PID profile 1 and PID profile 2') && lines.includes('# Date: 2026-10-05'));
    assert.match(text, /^# 1\. Save `diff all` before you paste this\./m);
    assert.ok(text.indexOf('Save `diff all`') < text.indexOf('batch start'), 'the backup step comes first');
    assert.ok(text.indexOf('Save `diff all`') < text.indexOf('# Craft name:'), 'the backup step comes before the flights of a file with many logs (CLAUDE.md "Export")');
    assert.match(text, /# Change 2 of 3: Decrease the yaw CCW stop gain\n#   Recommendation `T5:yaw_ccw_stop_gain:p1`\.\n#   PID profile 1, CLI `profile 0`\.\n#   `yaw_ccw_stop_gain`: from 80 to 72 \(the value at this time is from the log header, PID profile 1 at the start of the log\)\./);
    assert.match(text, /#   PID profile 2, CLI `profile 1`\.\n#   `yaw_ccw_stop_gain`: from 80 to 72 \(the value at this time is from the CLI dump, section `profile 1`, the default of 4\.6, because `diff` does not show a default value\)\./);
    assert.match(text, /#   Result of check T5 \(log 6, PID profile 1\), `t\d+`: the value is 2 ± 0\.2 x\.\n#   The limit is 1\.5 x\./, 'SPEC2 C8: ± stays (Latin-1, never a control character); review V5: the value and the limit in the unit of the rule');
    assert.match(text, /#   Rule: Check T5 has a problem if the ratio of the stop overshoots of the 2 sides is 1\.5 or more/);
    assert.match(text, /# Select PID profile 1 again, as before the changes\.\nprofile 0\nsave$/);
    // every command is batch, a profile selection, a set of a PARAMS name, or save; a comment line holds 256 characters or less
    for (const l of commands(text)) assert.ok(/^(batch start|profile [0-5]|rateprofile [0-5]|save)$/.test(l) || advice.PARAMS[(/^set (\w+) = \S+$/.exec(l) || [])[1]], l);
    assert.ok(lines.every(l => l.length <= 256), 'firmware CLI buffer');
    assert.equal(advice.exportScript(out.recommendations, ids, meta), text, 'pure: the same input gives the same file');
});

test('exportScript: the picks decide; checks, watches and blocked changes never go into the file; the pilot can untick a change', () => {
    const out = run([T5F(), T5F({ profile: 2 }), f({ module: 'gov', id: 'G6', value: 90, text: 'median throttle 90 %' })], { cli: CLI });
    const g6 = only(out, 'G6');
    const text = advice.exportScript(out.recommendations, ['T5:yaw_ccw_stop_gain:p2', g6.id], {});
    assert.deepEqual(commands(text), ['batch start', 'profile 1', 'set yaw_ccw_stop_gain = 72', 'save'], 'PID profile 1 is not ticked');
    assert.match(flat(text), /# Not in the file: Throttle headroom \(`G6`\)\. It is not a change\. Only a change with CLI text goes into the file\./);
    assert.match(flat(text), /After `save`, the flight controller uses PID profile 2\. If you use a different PID profile, select it again\./, 'no active profile in the meta');
    assert.ok(!advice.defaultPicks(out.recommendations).includes(g6.id));
    const none = advice.exportScript(out.recommendations, [], { date: '2026-10-05' });
    assert.deepEqual(commands(none), [], 'no pick: comments only, no batch and no save');
    assert.match(none, /# This file has no commands\./);
    // a change that a gate holds (blockedBy) has no CLI text, and a forced pick of it is refused with the reason
    const held = run([C3UP, f({ module: 'setup', id: 'F6', value: 4, se: .5, text: 'line at 3.789 x rotor (284 Hz, prominence 400): nearest notch roll none, pitch none, yaw none' })], { cli: CLI });
    const c3 = only(held, 'C3'), forced = Object.assign({}, c3, { cli: ['profile 0', 'set roll_f_gain = 115'] });
    assert.match(flat(advice.exportScript([forced], [c3.id], {})), /# Not in the file: .*A step before it in the tuning sequence has a problem\. Correct that step first\./);
});

test('exportScript: range checks (RANGE, filter floors, RPM notch sources), unknown names, profile agreement and conflicts are refused', () => {
    const base = { severity: 'action', scope: 'profile', profile: 2, cliProfile: 1, title: 'X', evidence: [], blockedBy: [], causes: [] };
    const one = (o) => advice.exportScript([Object.assign({ id: 'x' }, base, o)], ['x'], {});
    const refused = (o, re) => { const t = one(o); assert.deepEqual(commands(t), [], t); assert.match(flat(t), re); };
    assert.deepEqual(commands(one({ cli: ['profile 1', 'set yaw_ccw_stop_gain = 72'] })), ['batch start', 'profile 1', 'set yaw_ccw_stop_gain = 72', 'save']);
    refused({ cli: ['profile 1', 'set yaw_ccw_stop_gain = 300'] }, /not in its firmware range/);          // settings.c 25..250
    refused({ cli: ['profile 1', 'set yaw_ccw_stop_gain = 24'] }, /not in its firmware range/);
    refused({ cli: ['profile 1', 'set yaw_ccw_stop_gain = 72.5'] }, /not in its firmware range/);
    refused({ cli: ['profile 1', 'set motor_poles = 2'] }, /`motor_poles` is not a name that the app writes\./);
    refused({ cli: ['profile 1', 'set yaw_ccw_stop_gain = 72', 'save'] }, /a line that is not a `set` command/);
    refused({ cli: ['profile 1', 'set yaw_ccw_stop_gain = 72; defaults'] }, /a line that is not a `set` command/);
    refused({ cli: ['profile 0', 'set yaw_ccw_stop_gain = 72'] }, /The CLI text does not agree with PID profile 2 \(`profile 1`\)/);   // profiles never mix
    refused({ profile: 0, cliProfile: null, cli: ['profile 0', 'set yaw_ccw_stop_gain = 72'] }, /PID profile unknown/);
    refused({ profile: 7, cliProfile: 6, cli: ['profile 6', 'set yaw_ccw_stop_gain = 72'] }, /does not agree/);
    refused({ cli: ['profile 1', 'set gyro_lpf1_static_hz = 100'] }, /is not a PID profile value\./);
    const g = { scope: 'global', profile: null, cliProfile: null };
    refused(Object.assign({}, g, { cli: ['set gyro_lpf1_static_hz = 50'] }), /less than a filter limit/);           // guard 6
    refused(Object.assign({}, g, { cli: [`set gyro_rpm_notch_source_roll = ${pad([11, 19]).join(',')}`] }), /firmware range/);   // 19 disables arming
    refused(Object.assign({}, g, { cli: [`set gyro_rpm_notch_q_roll = ${pad([80, 15]).join(',')}`] }), /filter limit/);
    refused(Object.assign({}, g, { cli: ['set gyro_lpf1_type = SIXTH_ORDER'] }), /firmware range/);
    // two picks that set one value of one profile to different numbers: neither
    const a = Object.assign({ id: 'a' }, base, { cli: ['profile 1', 'set yaw_ccw_stop_gain = 72'] }), b = Object.assign({ id: 'b' }, base, { cli: ['profile 1', 'set yaw_ccw_stop_gain = 70'] });
    const t = advice.exportScript([a, b], ['a', 'b'], {});
    assert.deepEqual(commands(t), []);
    assert.equal((flat(t).match(/Two selected changes set the same value to different numbers/g) || []).length, 2);
});

// The 42 governor CLI names of Rotorflight 4.6.0 (docs/GOVERNOR_AUTOTUNE.md section 5): the clivalue rows of settings.c
// (956-973 global, 1202-1226 PID profile), with their mode and the CLI words of their lookup tables (cli.c cliSet: MODE_BITSET
// takes lookupTableOffOn)
const GOV_NAMES = [...SETTINGS.matchAll(/\{ "(gov_\w+)",\s+VAR_\w+\s*\|\s*(MASTER|PROFILE)_VALUE\s*(?:\|\s*(MODE_\w+))?/g)]
    .map(m => ({ name: m[1], scope: m[2] === 'MASTER' ? 'global' : 'profile', mode: m[3] || 'MODE_DIRECT' }));
const lookupWords = (table) => JSON.parse(`[${new RegExp(`${table}\\[\\] = \\{([^}]*)\\}`).exec(SETTINGS)[1].trim().replace(/,$/, '')}]`);
const GOV_WORDS = { gov_mode: lookupWords('lookupTableGovernorMode'), gov_throttle_type: lookupWords('lookupTableGovernorThrottleType') };
for (const g of GOV_NAMES) if (g.mode === 'MODE_BITSET') GOV_WORDS[g.name] = lookupWords('lookupTableOffOn');

test('governor names (docs/GOVERNOR_AUTOTUNE.md section 7): all 42 in PARAMS with the scope, default and range of the firmware', () => {
    assert.equal(GOV_NAMES.length, 42, GOV_NAMES.map(g => g.name).join(' '));
    assert.deepEqual(GOV_WORDS.gov_mode, ['OFF', 'LIMIT', 'DIRECT', 'ELECTRIC', 'NITRO']);
    assert.deepEqual(GOV_WORDS.gov_throttle_type, ['NORMAL', 'SWITCH', 'FUNCTION']);
    assert.deepEqual(Object.keys(GOV_WORDS).filter(k => /^gov_use_/.test(k)).sort(), ['gov_use_dyn_min_throttle', 'gov_use_fallback_precomp', 'gov_use_pid_spoolup', 'gov_use_voltage_comp']);
    // tools/autotune/firmware/schema.cjs: the defaults of pg/governor.c and pg/pid.c, gov_flags 0 (all flags OFF), and the ranges
    const schema = new Map(require('../tools/autotune/firmware/schema.cjs').fields.map(x => [x.name, x]));
    const field = (name) => schema.get(name.replace(/_ff_weight$/, '_weight'));
    for (const { name, scope, mode } of GOV_NAMES) {
        const P = advice.PARAMS[name];
        assert.ok(P, `${name} is not in PARAMS`);
        assert.equal(P[0], scope, `${name} scope`);
        if (mode === 'MODE_BITSET') { assert.equal(P[3], 'OFF', name); assert.equal(schema.get('gov_flags').default, 0); continue; }
        if (mode === 'MODE_LOOKUP') { assert.equal(P[3], GOV_WORDS[name][field(name).default], name); continue; }
        if (mode === 'MODE_ARRAY') {
            assert.equal(P[3], Array.from({ length: 9 }, (_, i) => schema.get(`${name}[${i}]`).default).join(','), name);
            for (let i = 0; i < 9; i++) assert.deepEqual([schema.get(`${name}[${i}]`).min, schema.get(`${name}[${i}]`).max], advice.RANGE[name], `${name}[${i}]`);
            continue;
        }
        assert.equal(P[3], field(name).default, `${name} default`);
        assert.deepEqual(advice.RANGE[name], [field(name).min, field(name).max], `${name} range`);
    }
    // the log header has govPID (P, I, D, F, gain) and yaw_tta (gain, limit) only (blackbox.c:1668-1699)
    for (const [name, key, i] of [['gov_p_gain', 'govPID', 0], ['gov_i_gain', 'govPID', 1], ['gov_d_gain', 'govPID', 2], ['gov_f_gain', 'govPID', 3], ['gov_gain', 'govPID', 4], ['gov_tta_gain', 'yaw_tta', 0], ['gov_tta_limit', 'yaw_tta', 1]])
        assert.deepEqual(advice.PARAMS[name].slice(1, 3), [key, i], name);
    assert.ok(GOV_NAMES.every(g => advice.PARAMS[g.name][1] === null || /^gov_(gain|[pidf]_gain|tta_gain|tta_limit)$/.test(g.name)), 'no other header key');
});

test('exportScript: governor changes of a PID profile and global governor changes, with their comment lines', () => {
    const GOV_I = { id: 'GT:gov_i_gain:p2', severity: 'action', scope: 'profile', profile: 2, cliProfile: 1, title: 'Decrease the governor I gain', parameter: 'gov_i_gain', from: 50, to: 40,
        cli: ['profile 1', 'set gov_i_gain = 40', 'set gov_use_fallback_precomp = ON', 'set gov_headspeed = 2400'], fromSets: { gov_i_gain: 50, gov_use_fallback_precomp: 'OFF', gov_headspeed: 2300 },
        fromSources: { gov_i_gain: 'log header, PID profile 2 at the start of the log', gov_use_fallback_precomp: 'CLI dump, section `profile 1`', gov_headspeed: 'CLI dump, section `profile 1`' },
        evidence: [{ id: 'G9', fid: 'g9a', log: 3, profile: 2, value: 0.031, se: 0.004, display: { value: '3.1 ± 0.4 %', bound: '2 %' } }],
        rule: 'The headspeed error in the model must decrease by more than 2 SE.', blockedBy: [], causes: [], caveats: [] };
    const GLOBAL = { id: 'GT:global', severity: 'action', scope: 'global', profile: null, title: 'Set the governor mode and the throttle curve', parameter: 'gov_mode', from: 'DIRECT', to: 'ELECTRIC',
        cli: ['set gov_mode = ELECTRIC', 'set gov_throttle_type = FUNCTION', 'set gov_bypass_throttle = 0,25,50,75,100,125,150,175,200', 'set gov_recovery_time = 20'],
        fromSets: { gov_mode: 'DIRECT', gov_throttle_type: 'NORMAL', gov_bypass_throttle: '0,0,0,0,0,0,0,0,0' }, fromSource: 'CLI dump',
        evidence: [], rule: 'The headspeed error in the model must decrease by more than 2 SE.', blockedBy: [], causes: [], caveats: [] };
    // GOV_I also sets gov_headspeed: a headspeed change is never selected first (the decision of the pilot, user 2026-10-15)
    assert.deepEqual(advice.defaultPicks([GOV_I, GLOBAL]), [GLOBAL.id], 'the changes with CLI text are selected, but not a headspeed change');
    const text = advice.exportScript([GOV_I, GLOBAL], [GOV_I.id, GLOBAL.id], { activeProfile: 0, date: '2026-10-14' });
    assert.deepEqual(commands(text), ['batch start', 'profile 1', 'set gov_i_gain = 40', 'set gov_use_fallback_precomp = ON', 'set gov_headspeed = 2400',
        'set gov_mode = ELECTRIC', 'set gov_throttle_type = FUNCTION', 'set gov_bypass_throttle = 0,25,50,75,100,125,150,175,200', 'set gov_recovery_time = 20', 'profile 0', 'save']);
    assert.match(text, /# Change 1 of 2: Decrease the governor I gain\n#   Recommendation `GT:gov_i_gain:p2`\.\n#   PID profile 2, CLI `profile 1`\.\n/);
    assert.match(text, /#   `gov_i_gain`: from 50 to 40 \(the value at this time is from the log header, PID profile 2 at the start of the log\)\.\n/);
    assert.match(text, /#   `gov_use_fallback_precomp`: from OFF to ON \(the value at this time is from the CLI dump, section `profile 1`\)\.\n/);
    assert.match(text, /#   `gov_headspeed`: from 2300 to 2400 \(the value at this time is from the CLI dump, section `profile 1`\)\.\n/);
    assert.match(text, /#   Result of check G9 \(log 3, PID profile 2\), `g9a`: the value is 3\.1 ± 0\.4 %\.\n#   The limit is 2 %\.\n#   Rule: The headspeed error in the model must decrease by more than 2 SE\.\n/);
    assert.match(text, /# Change 2 of 2: Set the governor mode and the throttle curve\n#   Recommendation `GT:global`\.\n#   Global value \(all PID profiles\)\.\n/);
    assert.match(text, /#   `gov_mode`: from DIRECT to ELECTRIC \(the value at this time is from the CLI dump\)\.\n#   `gov_throttle_type`: from NORMAL to FUNCTION \(the value at this time is from the CLI dump\)\.\n/);
    assert.match(text, /#   `gov_bypass_throttle`: from 0,0,0,0,0,0,0,0,0 to 0,25,50,75,100,125,150,175,200 \(the value at this time is from the CLI dump\)\.\n#   `gov_recovery_time`: set to 20\. The previous value is unknown\.\n/);
    assert.match(text, /# PID profile 2\nprofile 1\n[\s\S]*# Global values\nset gov_mode = ELECTRIC\n/);
    assert.match(text, /# Select PID profile 1 again, as before the changes\.\nprofile 0\nsave$/);
    // the scopes of settings.c: a global name under `profile N` and a PID profile name without it are refused
    assert.match(flat(advice.exportScript([Object.assign({}, GOV_I, { cli: ['profile 1', 'set gov_rpm_filter = 15'] })], [GOV_I.id], {})), /`gov_rpm_filter` is not a PID profile value\./);
    assert.match(flat(advice.exportScript([Object.assign({}, GLOBAL, { cli: ['set gov_use_voltage_comp = ON'] })], [GLOBAL.id], {})), /`gov_use_voltage_comp` is not a global value\./);
});

test('exportScript: governor values: the CLI words of settings.c, the 9 points of gov_bypass_throttle, and the firmware ranges', () => {
    const base = { title: 'X', severity: 'action', evidence: [], blockedBy: [], causes: [] };
    const one = (name, v) => { const g = GOV_NAMES.find(x => x.name === name), cli = `set ${name} = ${v}`;
        return advice.exportScript([Object.assign({ id: 'x' }, base, g.scope === 'profile' ? { scope: 'profile', profile: 3, cliProfile: 2, cli: ['profile 2', cli] } : { scope: 'global', profile: null, cli: [cli] })], ['x'], {}); };
    const ok = (name, v) => { const t = one(name, v); assert.ok(commands(t).includes(`set ${name} = ${v}`), `${name} = ${v}: ${flat(t)}`); };
    // the reason of each refusal is its own (review of 2026-10-14): the words, the 9 points, the range. A governor name has no filter limit
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reason = (name) => GOV_WORDS[name] ? new RegExp(esc(`The value of \`${name}\` must be one of these words: ${GOV_WORDS[name].map(w => `\`${w}\``).join(', ')}.`))
        : name === 'gov_bypass_throttle' ? /Each of the 9 numbers of `gov_bypass_throttle` must be from 0 to 200, in steps of 1\./
        : new RegExp(esc(`The value of \`${name}\` must be from ${name === 'gov_headspeed' ? advice.RULES.govHeadspeedMin : advice.RANGE[name][0]} to ${advice.RANGE[name][1]}, in steps of 1.`));
    const refused = (name, v, re) => { const t = one(name, v); assert.deepEqual(commands(t), [], `${name} = ${v}`); assert.match(flat(t), re || reason(name), `${name} = ${v}`);
        assert.doesNotMatch(flat(t), /filter limit/, `${name} = ${v}`); };
    // the words: each word of its table, and no other (a number, lower case, the NONE of other tools, a word of another table)
    for (const [name, words] of Object.entries(GOV_WORDS)) {
        for (const w of words) ok(name, w);
        for (const w of ['0', '1', '3', words[words.length - 1].toLowerCase(), 'NONE', 'TRUE', 'AUTO', `${words[0]},${words[0]}`]) refused(name, w);
    }
    refused('gov_mode', 'ON'); refused('gov_use_pid_spoolup', 'ELECTRIC'); refused('gov_throttle_type', 'OFF');
    // gov_bypass_throttle: exactly 9 integers, each 0-200 (0.5 % of throttle)
    ok('gov_bypass_throttle', '0,0,0,0,0,0,0,0,0'); ok('gov_bypass_throttle', '200,200,200,200,200,200,200,200,200'); ok('gov_bypass_throttle', '0,20,40,70,100,130,160,180,200');
    refused('gov_bypass_throttle', '0,20,40,70,100,130,160,180', /The value of `gov_bypass_throttle` must have 9 numbers, one for each point of the throttle curve\./);
    refused('gov_bypass_throttle', '0,20,40,70,100,130,160,180,200,200', /must have 9 numbers, one for each point of the throttle curve/);
    refused('gov_bypass_throttle', '0,20,40,70,100,130,160,180,201'); refused('gov_bypass_throttle', '-1,20,40,70,100,130,160,180,200'); refused('gov_bypass_throttle', '0,20,40,70,100.5,130,160,180,200');
    // the numbers: both limits of RANGE, and nothing out of them or not an integer
    const numeric = GOV_NAMES.filter(g => g.mode === 'MODE_DIRECT');
    assert.equal(numeric.length, 35);
    // gov_headspeed: the governor uses RULES.govHeadspeedMin for a smaller value (flight_governor.c:1412, 1592), thus that is its first value
    const HS = /If `gov_headspeed` is less than 100, the governor uses 100 rpm\. Thus, the value must be from 100 to 50000\./;
    for (const { name } of numeric) {
        const [lo0, hi] = advice.RANGE[name], lo = name === 'gov_headspeed' ? advice.RULES.govHeadspeedMin : lo0;
        ok(name, lo); ok(name, hi);
        refused(name, lo - 1, name === 'gov_headspeed' ? HS : null); refused(name, hi + 1); refused(name, `${lo}.5`); refused(name, 'ON');
    }
    assert.equal(advice.RULES.govHeadspeedMin, 100);
    refused('gov_headspeed', 0, HS); refused('gov_headspeed', 1, HS); ok('gov_headspeed', 100);
    // a value out of RANGE gives the range that the export takes: from RULES.govHeadspeedMin, not from the 0 of settings.c
    refused('gov_headspeed', 50001, /The value of `gov_headspeed` must be from 100 to 50000, in steps of 1\./); refused('gov_headspeed', -5, /must be from 100 to 50000/);
    assert.deepEqual(['gov_headspeed', 'gov_handover_throttle', 'gov_idle_throttle', 'gov_collective_curve', 'gov_fallback_drop', 'gov_max_throttle', 'gov_startup_time'].map(k => advice.RANGE[k]),
        [[0, 50000], [10, 100], [0, 250], [5, 40], [0, 50], [10, 100], [0, 600]]);
});

// The governor values that depend on other values (review of 2026-10-14). The firmware changes them with no CLI error when it
// starts (validateAndFixGovernorConfig) and when it selects a PID profile with gov_mode not OFF (validateAndFixGovernorProfile):
// a selected set of changes that gives such a value is not in the file; a rule with an unknown value gives a comment line.
// GOVERNOR_C: the vendor copy of release/4.6.0 (above), the same as test/fixtures/rotorflight-4.6/flight_governor.c
test('exportScript: governor values that depend on other values: the firmware rules of flight_governor.c, over all selected changes', () => {
    // the rules that the export copies, as the pinned firmware has them
    for (const re of [/const int maxIdle = constrain\(governorConfig\(\)->gov_handover_throttle \* 10 - 1, 0, 250\);/, /autoThrottle = constrain\(autoThrottle, idleThrottle, maxIdle\);/,
        /maxThrottle = constrain\(maxThrottle, governorConfig\(\)->gov_handover_throttle, 100\);/, /minThrottle = constrain\(minThrottle, 10, maxThrottle\);/,
        /if \(governorConfig\(\)->gov_mode < GOV_MODE_ELECTRIC\) \{\s*if \(governorConfig\(\)->gov_throttle_type == GOV_THROTTLE_SWITCH\)/,
        /if \(governorConfig\(\)->gov_mode < GOV_MODE_ELECTRIC\) \{\s*CLEAR_BIT\(pidProfile->governor\.flags,/, /if \(gov\.govMode\)\s*\{\s*validateAndFixGovernorProfile\(\);/])
        assert.match(GOVERNOR_C, re);
    assert.equal(advice.RULES.govIdleScale, 10); assert.deepEqual(advice.RULES.govFullModes, ['ELECTRIC', 'NITRO']);
    const base = { evidence: [], blockedBy: [], causes: [], caveats: [] };
    const g = (id, cli, extra) => Object.assign({ id, title: `Change ${id}`, severity: 'action', scope: 'global', profile: null, cli }, base, extra || {});
    const p = (id, prof, cli, extra) => Object.assign({ id, title: `Change ${id}`, severity: 'action', scope: 'profile', profile: prof, cliProfile: prof - 1, cli: [`profile ${prof - 1}`].concat(cli) }, base, extra || {});
    // the present values: rows that are not selected (their fromSets), as gov_tune.cjs gives them
    const now = (sets, prof) => Object.assign({ id: `now${prof || ''}`, title: 'Present values', severity: 'info', scope: prof ? 'profile' : 'global', profile: prof || null, cli: [], fromSets: sets }, base);
    const all = (sets) => [1, 2, 3, 4, 5, 6].map(q => now(sets, q));
    const PRESENT = [now({ gov_mode: 'ELECTRIC', gov_throttle_type: 'NORMAL', gov_handover_throttle: 25, gov_idle_throttle: 0, gov_auto_throttle: 0 })]
        .concat(all({ gov_max_throttle: 100, gov_min_throttle: 10, gov_use_fallback_precomp: 'OFF', gov_use_voltage_comp: 'OFF', gov_use_pid_spoolup: 'OFF', gov_use_dyn_min_throttle: 'OFF' }));
    const run = (recs, picks, present = PRESENT) => advice.exportScript(present.concat(recs), picks || recs.map(r => r.id), {});
    const notIn = (t, id) => { const m = new RegExp(`Not in the file: Change ${id} \\(\`${id}\`\\)\\. (.*?)(?= Not in the file: | This file has no commands\\.|\\n|$)`).exec(flat(t)); return m ? m[1] : ''; };

    // the probe of the review: three changes, each of them gives a value that the firmware changes. None goes into the file
    let t = run([g('G1', ['set gov_handover_throttle = 20', 'set gov_idle_throttle = 250', 'set gov_auto_throttle = 100']),
        p('P1', 1, ['set gov_max_throttle = 15', 'set gov_min_throttle = 50', 'set gov_use_voltage_comp = ON']), g('G2', ['set gov_mode = LIMIT', 'set gov_throttle_type = SWITCH'])], null, []);
    assert.deepEqual(commands(t), []);
    assert.match(notIn(t, 'G1'), /^The flight controller keeps `gov_idle_throttle` at `10 × gov_handover_throttle - 1` or less\. With the selected changes, `gov_idle_throttle` is 250 and `gov_handover_throttle` is 20\. Thus, the flight controller changes `gov_idle_throttle` to 199 when it starts\. The CLI does not show an error\./);
    assert.match(notIn(t, 'P1'), /`gov_max_throttle` \(PID profile 1\) is 15 and `gov_handover_throttle` is 20\. Thus, the flight controller changes `gov_max_throttle` \(PID profile 1\) to 20 when it selects this PID profile\./);
    assert.match(notIn(t, 'G2'), /^If `gov_mode` is `OFF`, `LIMIT` or `DIRECT`, the flight controller changes `gov_throttle_type` from `SWITCH` to `NORMAL`\. With the selected changes, `gov_throttle_type` is `SWITCH` and `gov_mode` is `LIMIT`\./);

    // gov_idle_throttle and gov_auto_throttle: 10 x gov_handover_throttle - 1 or less (and 250)
    for (const k of ['gov_idle_throttle', 'gov_auto_throttle']) {
        const at = (h, v) => run([g('X', [`set ${k} = ${v}`])], null, [now({ gov_mode: 'ELECTRIC', gov_handover_throttle: h, gov_idle_throttle: 0, gov_auto_throttle: 250 })]);
        t = at(25, 250); assert.deepEqual(commands(t), [], k); assert.match(notIn(t, 'X'), new RegExp(`changes \`${k}\` to 249 when it starts`));
        assert.deepEqual(commands(at(25, 249)), ['batch start', `set ${k} = 249`, 'save'], k);
        assert.deepEqual(commands(at(26, 250)), ['batch start', `set ${k} = 250`, 'save'], k);
        assert.deepEqual(commands(at(10, 100)), [], k); assert.deepEqual(commands(at(10, 99)), ['batch start', `set ${k} = 99`, 'save'], k);
    }
    // gov_auto_throttle: gov_idle_throttle or more
    t = run([g('A', ['set gov_auto_throttle = 40'])], null, [now({ gov_mode: 'ELECTRIC', gov_handover_throttle: 25, gov_idle_throttle: 50, gov_auto_throttle: 60 })]);
    assert.deepEqual(commands(t), []); assert.match(notIn(t, 'A'), /keeps `gov_auto_throttle` at `gov_idle_throttle` or more\..*changes `gov_auto_throttle` to 50 when it starts\./);
    assert.deepEqual(commands(run([g('A', ['set gov_auto_throttle = 50'])], null, [now({ gov_mode: 'ELECTRIC', gov_handover_throttle: 25, gov_idle_throttle: 50, gov_auto_throttle: 60 })])),
        ['batch start', 'set gov_auto_throttle = 50', 'save']);

    // gov_max_throttle: gov_handover_throttle or more, in each PID profile; gov_min_throttle: gov_max_throttle or less
    t = run([p('M', 3, ['set gov_max_throttle = 24'])]); assert.deepEqual(commands(t), []);
    assert.match(notIn(t, 'M'), /`gov_max_throttle` \(PID profile 3\) is 24 and `gov_handover_throttle` is 25\. Thus, the flight controller changes `gov_max_throttle` \(PID profile 3\) to 25 when it selects this PID profile\./);
    assert.deepEqual(commands(run([p('M', 3, ['set gov_max_throttle = 25'])])), ['batch start', 'profile 2', 'set gov_max_throttle = 25', 'save']);
    const with2 = (sets) => PRESENT.map(r => r.profile === 2 ? Object.assign({}, r, { fromSets: Object.assign({}, r.fromSets, sets) }) : r);
    t = run([p('N', 2, ['set gov_min_throttle = 60'])], null, with2({ gov_max_throttle: 50 }));
    assert.deepEqual(commands(t), []); assert.match(notIn(t, 'N'), /keeps `gov_min_throttle` at `gov_max_throttle` or less\..*changes `gov_min_throttle` \(PID profile 2\) to 50 when it selects this PID profile\./);
    assert.deepEqual(commands(run([p('N', 2, ['set gov_min_throttle = 60']), p('O', 2, ['set gov_max_throttle = 60'])], null, with2({ gov_max_throttle: 50 }))),
        ['batch start', 'profile 1', 'set gov_min_throttle = 60', 'set gov_max_throttle = 60', 'save'], 'the two changes together');
    // a handover change applies to gov_max_throttle of each PID profile
    t = run([g('H', ['set gov_handover_throttle = 40'])], null, PRESENT.map(r => r.profile === 5 ? Object.assign({}, r, { fromSets: Object.assign({}, r.fromSets, { gov_max_throttle: 35 }) }) : r));
    assert.deepEqual(commands(t), []); assert.match(notIn(t, 'H'), /`gov_max_throttle` \(PID profile 5\) is 35 and `gov_handover_throttle` is 40\./);

    // the four gov_use_* flags: OFF with gov_mode LIMIT or DIRECT. With gov_mode OFF, the firmware does not change the PID profile values
    t = run([p('F', 2, ['set gov_use_voltage_comp = ON']), g('D', ['set gov_mode = DIRECT'])]);
    assert.deepEqual(commands(t), []);
    for (const id of ['F', 'D']) assert.match(notIn(t, id), /^If `gov_mode` is `LIMIT` or `DIRECT`, the flight controller sets `gov_use_voltage_comp` to `OFF`\. With the selected changes, `gov_use_voltage_comp` \(PID profile 2\) is `ON` and `gov_mode` is `DIRECT`\. Thus, the flight controller changes `gov_use_voltage_comp` \(PID profile 2\) to `OFF` when it selects this PID profile\./, id);
    assert.deepEqual(commands(run([p('F', 2, ['set gov_use_voltage_comp = ON'])])), ['batch start', 'profile 1', 'set gov_use_voltage_comp = ON', 'save'], 'ELECTRIC');
    assert.deepEqual(commands(run([p('F', 2, ['set gov_use_voltage_comp = ON']), g('O', ['set gov_mode = OFF'])])),
        ['batch start', 'profile 1', 'set gov_use_voltage_comp = ON', 'set gov_mode = OFF', 'save'], 'gov_mode OFF keeps the flags');
    assert.deepEqual(commands(run([g('D', ['set gov_mode = DIRECT'])])), ['batch start', 'set gov_mode = DIRECT', 'save'], 'all flags OFF, NORMAL: nothing changes');
    // gov_throttle_type SWITCH: ELECTRIC or NITRO only
    for (const [mode, n] of [['LIMIT', 0], ['OFF', 0], ['DIRECT', 0], ['ELECTRIC', 3], ['NITRO', 3]])
        assert.equal(commands(run([g('S', ['set gov_throttle_type = SWITCH'])], null, [now({ gov_mode: mode })])).length, n, mode);

    // a refused change gives back the present value, and a different rule can then fail: until no rule fails
    t = run([g('H', ['set gov_handover_throttle = 20']), g('I', ['set gov_idle_throttle = 220']), p('M', 2, ['set gov_max_throttle = 22'])]);
    assert.deepEqual(commands(t), []);
    assert.match(notIn(t, 'H'), /`gov_idle_throttle` is 220 and `gov_handover_throttle` is 20\./); assert.match(notIn(t, 'I'), /`gov_idle_throttle` is 220 and `gov_handover_throttle` is 20\./);
    assert.match(notIn(t, 'M'), /`gov_max_throttle` \(PID profile 2\) is 22 and `gov_handover_throttle` is 25\./, 'without the change of H, the handover is 25');

    // an unknown value: the change stays, and its comment lines give the rule and the condition
    t = run([p('M', 3, ['set gov_max_throttle = 97'])], null, []);
    assert.deepEqual(commands(t), ['batch start', 'profile 2', 'set gov_max_throttle = 97', 'save']);
    assert.match(t, /#   `gov_max_throttle`: set to 97\. The previous value is unknown\.\n#   The flight controller keeps `gov_max_throttle` at `gov_handover_throttle` or more\.\n#   The value of `gov_handover_throttle` is unknown\.\n#   Before you use this change, make sure that `gov_handover_throttle` is 97 or less\.\n/);
    assert.match(t, /#   The value of `gov_min_throttle` \(PID profile 3\) is unknown\.\n#   Before you use this change, make sure that `gov_min_throttle` \(PID profile 3\) is 97 or less\.\n/);
    assert.doesNotMatch(run([p('M', 3, ['set gov_max_throttle = 97'])]), /is unknown\.\n#   Before you use/, 'the present values are known');
    t = run([g('H', ['set gov_handover_throttle = 30'])], null, [now({ gov_mode: 'ELECTRIC', gov_handover_throttle: 25, gov_idle_throttle: 0, gov_auto_throttle: 0 }), now({ gov_max_throttle: 100 }, 1)]);
    assert.match(flat(t), /The value of `gov_max_throttle` \(PID profiles 2, 3, 4, 5 and 6\) is unknown\. Before you use this change, make sure that `gov_max_throttle` \(PID profiles 2, 3, 4, 5 and 6\) is 30 or more\./);
    assert.deepEqual(commands(t), ['batch start', 'set gov_handover_throttle = 30', 'save']);
    // a lower handover keeps gov_max_throttle (the firmware kept it at the present handover or more), but not gov_idle_throttle
    t = run([g('H', ['set gov_handover_throttle = 20'])], null, [now({ gov_mode: 'ELECTRIC', gov_handover_throttle: 25 })]);
    assert.doesNotMatch(flat(t), /gov_max_throttle/); assert.match(flat(t), /make sure that `gov_idle_throttle` is 199 or less\./);
    // a present value from a row (parameter and from) counts; two different present values are unknown
    const row = (k, v, prof) => Object.assign({ id: `row:${k}:${v}`, title: k, severity: 'info', scope: prof ? 'profile' : 'global', profile: prof || null, parameter: k, from: v, cli: [] }, base);
    assert.deepEqual(commands(run([g('I', ['set gov_idle_throttle = 250'])], null, [row('gov_handover_throttle', 25), row('gov_auto_throttle', 250)])), []);
    t = run([g('I', ['set gov_idle_throttle = 250'])], null, [row('gov_handover_throttle', 25), row('gov_handover_throttle', 30), row('gov_auto_throttle', 250)]);
    assert.deepEqual(commands(t), ['batch start', 'set gov_idle_throttle = 250', 'save']); assert.match(flat(t), /make sure that `gov_handover_throttle` is 26 or more\./);
    // a word as its index (the schema and the log header give numbers), a flag as a boolean
    assert.deepEqual(commands(run([p('F', 2, ['set gov_use_pid_spoolup = ON'])], null, [row('gov_mode', 2)])), []);
    assert.deepEqual(commands(run([g('D', ['set gov_mode = LIMIT'])], null, [row('gov_throttle_type', 1)].concat([1, 2, 3, 4, 5, 6].map(q => now({ gov_use_fallback_precomp: false, gov_use_voltage_comp: 0, gov_use_pid_spoolup: 'off', gov_use_dyn_min_throttle: 'OFF' }, q))))), []);
});

test('exportScript: a governor check with CLI text and optIn goes into the file only when the pilot selects it (gov_bypass_throttle, docs/GOVERNOR_AUTOTUNE.md section 5)', () => {
    const B = { id: 'gov:bypass', title: 'Throttle curve for BYPASS', severity: 'check', optIn: true, scope: 'global', profile: null, parameter: 'gov_bypass_throttle', from: '0,0,0,0,0,0,0,0,0',
        fromSets: { gov_bypass_throttle: '0,0,0,0,0,0,0,0,0' }, fromSource: 'CLI dump', cli: ['set gov_bypass_throttle = 0,25,50,75,100,125,150,175,200'], evidence: [], blockedBy: [], causes: [], caveats: [] };
    assert.deepEqual(advice.defaultPicks([B]), [], 'not selected by default');
    assert.equal(advice.script([B]), '', 'the report has no CLI file of it');
    const t = advice.exportScript([B], [B.id], {});
    assert.deepEqual(commands(t), ['batch start', 'set gov_bypass_throttle = 0,25,50,75,100,125,150,175,200', 'save']);
    assert.match(t, /# Change 1 of 1: Throttle curve for BYPASS\n#   Recommendation `gov:bypass`\.\n#   Global value \(all PID profiles\)\.\n#   `gov_bypass_throttle`: from 0,0,0,0,0,0,0,0,0 to 0,25,50,75,100,125,150,175,200 \(the value at this time is from the CLI dump\)\.\n/);
    // without optIn, a check stays out of the file; a watch or information with optIn too
    for (const r of [Object.assign({}, B, { optIn: undefined }), Object.assign({}, B, { severity: 'watch' }), Object.assign({}, B, { severity: 'info' })])
        assert.match(flat(advice.exportScript([r], [r.id], {})), /Not in the file: Throttle curve for BYPASS \(`gov:bypass`\)\. It is not a change\./);
    assert.match(flat(advice.exportScript([Object.assign({}, B, { blockedBy: ['rpm'] })], [B.id], {})), /A step before it in the tuning sequence has a problem\./);
});

test('exportScript: a change with values that are possibly not current (r.stale) stays selected, and a comment line before its commands gives the flag (CLAUDE.md)', () => {
    const base = { severity: 'action', scope: 'profile', profile: 2, cliProfile: 1, evidence: [], blockedBy: [], causes: [] };
    const STALE = { reasons: ['rearm'], findings: 1, source: 'The app uses the values of the log header of log 2.',
        text: '1 result of this recommendation uses a part of the log in which the values are possibly not the values of the log header. The cause is a second arm in the same log.' };
    const a = Object.assign({ id: 'a', title: 'A' }, base, { cli: ['profile 1', 'set yaw_ccw_stop_gain = 72'] });
    const b = Object.assign({ id: 'b', title: 'B' }, base, { cli: ['profile 1', 'set yaw_cw_stop_gain = 70'], stale: STALE });
    const g = Object.assign({ id: 'g', title: 'G' }, base, { scope: 'global', profile: null, cliProfile: null, cli: ['set gyro_lpf1_static_hz = 100'], stale: STALE });
    // a change that sets the same value as an earlier change: the flag goes before that command
    const d = Object.assign({ id: 'd', title: 'D' }, base, { cli: ['profile 1', 'set yaw_ccw_stop_gain = 72'], stale: STALE });
    assert.deepEqual(advice.defaultPicks([a, b, g, d]), ['a', 'b', 'g', 'd'], 'the flagged changes stay selected');
    const text = advice.exportScript([a, b, g, d], null, {}), lines = text.split('\n');
    assert.deepEqual(commands(text), ['batch start', 'profile 1', 'set yaw_ccw_stop_gain = 72', 'set yaw_cw_stop_gain = 70', 'set gyro_lpf1_static_hz = 100', 'save'], 'the same commands');
    const block = lines.indexOf('# Change 2 of 4: B');
    assert.deepEqual(lines.slice(block + 3, block + 6), ['#   Values possibly different.', '#   1 result of this recommendation uses a part of the log in which the values are possibly not the values of the log header.',
        '#   The cause is a second arm in the same log.'], 'the comments of the change');
    const flag = (n) => [`# Change ${n} uses values that are possibly not the values of the log header.`, `# Before you use these commands, read change ${n} above.`];
    const at = (cmd) => lines.indexOf(cmd);
    assert.deepEqual(lines.slice(at('set yaw_ccw_stop_gain = 72') - 2, at('set yaw_ccw_stop_gain = 72')), flag(4), 'change 4: before the command that change 1 also has');
    assert.deepEqual(lines.slice(at('set yaw_cw_stop_gain = 70') - 2, at('set yaw_cw_stop_gain = 70')), flag(2));
    assert.deepEqual(lines.slice(at('set gyro_lpf1_static_hz = 100') - 3, at('set gyro_lpf1_static_hz = 100')), ['# Global values', ...flag(3)]);
    assert.ok(!lines.some((l) => /^# Change 1 uses/.test(l)) && !/#   Values possibly different\.\n#   Recommendation `a`/.test(text), 'change 1: no flag');
    // the boolean stale of the H staleness test is not the flag; without r.stale the file is as before
    assert.equal(advice.exportScript([Object.assign({}, b, { stale: true })], ['b'], {}), advice.exportScript([Object.assign({}, b, { stale: null })], ['b'], {}));
    assert.ok(!/possibly/.test(advice.exportScript([a], ['a'], {})));
});

test('loading: siblings only, no Node API at load, Chromium-99 safe, runs through a CommonJS shim', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tools/autotune/advice.cjs'), 'utf8'), code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.deepEqual([...code.matchAll(/require\(([^)]*)\)/g)].map(m => m[1]), ["'./lib.cjs'", "'./health_setup.cjs'", "'./health_gov.cjs'", "'./health_loop.cjs'", "'./health_track.cjs'", "'./health_more.cjs'", "'./hierarchy.cjs'", "'./catalog.cjs'", "'./health_phase.cjs'", "'./health_rescue.cjs'", "'./health_limits.cjs'", "'./health_config.cjs'", "'./health_power.cjs'", "'./datasets.cjs'", "'./validation_power.cjs'", "'./filter_checklist.cjs'", "'./control_tune.cjs'"]);
    assert.ok(!/\bprocess\.|\bBuffer\b|__dirname|['"]node:/.test(code));
    assert.ok(!/\.toSorted\(|\.toReversed\(|\.toSpliced\(|Object\.groupBy|Map\.groupBy|Array\.fromAsync|\.with\(/.test(code));
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', src)((m) => require(path.join(ROOT, 'tools/autotune', m)), mod, mod.exports);
    assert.equal(typeof mod.exports.advise, 'function');
    const empty = mod.exports.advise({});
    assert.ok(Array.isArray(empty.recommendations) && Array.isArray(empty.coverage) && empty.coverage.length > 0);
    assert.ok(!empty.recommendations.some(r => /^D4/.test(r.id)), 'no CLI dump: no D4 recommendation (user rule 2026-10-06)');
    // health_track, health_more and hierarchy are optional in the app (js/tuning_worker.js OPTIONAL): advice loads and runs without them
    const bare = { exports: {} };
    new Function('require', 'module', 'exports', src)((m) => { if (/health_(track|more|phase)|hierarchy|catalog|validation_power/.test(m)) throw new Error(`Cannot find module '${m}'`); return require(path.join(ROOT, 'tools/autotune', m)); }, bare, bare.exports);
    const out = bare.exports.advise({ findings: [C3UP], header: HEADER, logs: LOGS, headerProfile: 1 });
    assert.deepEqual(out.recommendations.find(r => r.id.startsWith('C3')).cli, ['profile 0', 'set roll_f_gain = 115']);
    assert.deepEqual(Object.keys(advice).sort(), ['CHECKS', 'COVERAGE', 'DS_RULES', 'FEATURE_NAMES', 'PARAMS', 'RANGE', 'RULES', 'advise', 'comparisons', 'configurationBases', 'defaultPicks', 'exportScript', 'filterRecommendations', 'floorsOk', 'script'], 'no unused exports');
});

let esbuild = null; try { esbuild = require('esbuild'); } catch (e) { /* optional */ }
test('Chromium 99: esbuild lowers nothing for target chrome99', { skip: !esbuild }, () => {
    const src = fs.readFileSync(path.join(ROOT, 'tools/autotune/advice.cjs'), 'utf8'), t = (target) => esbuild.transformSync(src, { target, format: 'cjs', loader: 'js' }).code;
    assert.equal(t('chrome99'), t('esnext'));
});

// ---------------------------------------------------------------------------------------------
// Review 2 (SPEC2 fixes): PID profiles from the worker, header values, evidence, groups, export, F5, causes, texts
// ---------------------------------------------------------------------------------------------

test('A1: the PID profile of a finding is the worker\'s pidProfile (1-6) first, then the toolkit label', () => {
    // a log with no PID profile change: every finding has label 0, and the worker confirmed the arming profile 1 (cliTarget)
    const t5 = T5F({ profile: 0, pidProfile: 1 }), out = run([t5]), r = only(out, 'T5');
    assert.deepEqual([r.id, r.profile, r.from, r.to, r.cli], ['T5:yaw_ccw_stop_gain:p1', 1, 80, 72, ['profile 0', 'set yaw_ccw_stop_gain = 72']]);
    assert.deepEqual([r.evidence[0].profile, r.evidence[0].pidProfile, r.evidence[0].profileLabel], [1, 1, 0], 'the row keeps the toolkit label');
    assert.equal(t5.profile, 0, 'the input is not changed');
    // no pidProfile (not confirmed): label 0 stays "PID profile unknown"
    assert.deepEqual([only(run([T5F({ profile: 0 })]), 'T5').profile, only(run([T5F({ profile: 0, pidProfile: null })]), 'T5').cli], [0, []]);
    // a G6 flag of PID profile 1 by pidProfile is the headroom caveat of a G3 change of PID profile 1
    const g3 = f({ module: 'gov', id: 'G3', governorResponse: GOV_RESPONSE, profile: 0, pidProfile: 1, log: [5], value: 0.07, se: 0.005, text: 'droop 7 %: F too low (GOVT)' });
    assert.match(only(run([g3, f({ module: 'gov', id: 'G6', profile: 0, pidProfile: 1, value: 90, text: 'median throttle 90 %' })]), 'G3').caveats.join(' '), /Check G6 shows a problem with the throttle headroom \(PID profile 1\)/);
    // C7: the governor target of the stretch before the first change (targetOf '0') is the confirmed arming profile's
    const logs = (basis, confirmed) => [{ log: 5, start: '2026-10-04T10:00:00', flown: true, flyingS: 100, profileSeconds: { 0: 100 }, targetOf: { 0: 2300 }, armingProfile: 1, armingBasis: basis, armingConfirmed: confirmed }];
    const c7 = (basis, confirmed) => only(run([], { decisions: [decision()], logs: logs(basis, confirmed) }), 'C7');
    assert.deepEqual([c7(['cliTarget'], undefined).profile, c7(['govTarget'], true).profile], [1, 1]);
    // user decision 2026-10-06: the logged govRequest at the log start that agrees with the headspeed of exactly one PID profile
    // at the logged PID profile changes of the file confirms the arming profile (basis 'headspeed', set by the worker)
    assert.equal(c7(['headspeed'], undefined).profile, 1);
    const unk = c7(['govTarget'], false);
    assert.deepEqual([unk.profile, unk.cli], [0, []]);
    assert.match(unk.caveats.join(' '), /No PID profile has a governor target in the 2250 rpm range/);
});

test('A1: D4 shows a stale CLI value of a PID profile only for the section of the confirmed arming profile (cliSection, js/tuning_worker.js)', () => {
    const d4 = (cliSection) => f({ module: 'setup', id: 'D4', profile: 0, value: 2, cliSection, text: 'header vs CLI (diff, CLI profile 0, chosen by log profile at start (1-based event value - 1)): 2 of 80 values differ: yaw_stop_gain[1] 80 vs yaw_ccw_stop_gain 100; gyro_lowpass_hz 100 vs gyro_lpf1_static_hz 150. Trust the log header for header keys.' });
    const cli = setup.parseCli(CLI_TEXT + 'set yaw_ccw_stop_gain = 100\n'), t5 = T5F({ profile: 2 });
    const keys = (o) => only(run([d4(o), t5], { cli }), 'D4').text;
    assert.match(keys({ section: 0, chosenBy: 'event', arming: 1, usable: true }), /different values \(yaw_ccw_stop_gain and gyro_lpf1_static_hz\)/);
    // a guessed section: its PID profile values say nothing about the dump; the global value still does
    for (const usable of [false, null]) assert.match(keys({ section: 0, chosenBy: 'guess', arming: null, usable }), /different values \(gyro_lpf1_static_hz\)\./, String(usable));
    // the head "header vs CLI (" is no CLI name (SPEC2 D-LOW)
    assert.doesNotMatch(keys(undefined), /\bCLI and|, CLI\b|\(CLI/);
    assert.deepEqual(only(run([d4({ section: 0, chosenBy: 'guess', arming: null, usable: null }), t5], { cli }), 'T5').cli, ['profile 1', 'set yaw_ccw_stop_gain = 90'], 'the CLI value of PID profile 2 is used');
});

test('A9: R1 in a log with rate profile changes (rateChanges of the worker) says that the result can mix rate profiles', () => {
    const r1 = (o) => TRACK('R1', Object.assign({ axis: 'roll', profile: null, value: 80, se: 5, unit: 'ms', text: 'roll stick to setpoint 80 ms' }, o));
    const mixed = only(run([r1({ rateChanges: 2, rateProfile: 1 })]), 'R1');
    assert.equal(mixed.rateProfile, null);
    assert.match(mixed.caveats.join(' '), /The logs of these results have 2 rate profile changes\. Thus, the results can come from more than one rate profile, and the values of each rate profile are important\./);
    assert.equal(only(run([r1({ rateProfile: 1 })]), 'R1').rateProfile, 1);
});

test('C1: a change from the log header has base "log header", and the H staleness test reads every name that it sets', () => {
    const d1=f({module:'setup',id:'D1',profile:null,value:500}),slow={...HEADER,frameIntervalPDenom:4};
    const fresh=only(run([d1],{header:slow,headerLog:6}),'D1');
    assert.deepEqual([fresh.severity,fresh.fromSource,fresh.cli.length],['action','log header',1]);
    const h=f({module:'setup',id:'H',severity:'note',log:6,profile:'global',value:'2',text:'frameIntervalPDenom: 4 -> 2 (since log 5, global)'});
    const old=only(run([d1,h],{header:slow,headerLog:5}),'D1');
    assert.deepEqual([old.severity,old.cli,old.to],['check',[],null]);
    assert.match(old.caveats.join(' '),/frameIntervalPDenom changed between logs/);
    const benchLogs=[{log:4,flown:false,logClass:'bench'}].concat(LOGS);
    const bench=run([d1],{header:{...slow,rates_type:4},logs:benchLogs,headerLog:4,logBase:1});
    assert.equal(only(bench,'D1').cli.length,0);
    assert.equal(only(bench,'SETUP:rates_type').severity,'info');
    // a relative change (no value at this time) measured before a change of its parameter: measure again (SPEC2 D-LOW)
    const hy = f({ module: 'setup', id: 'H', severity: 'note', log: 6, profile: 'start profile 2', value: '120,90', text: 'yaw_stop_gain: 120,80 -> 120,90 (since log 5, start profile 2)' });
    const rel = only(run([T5F({ profile: 2 }), hy]), 'T5');
    assert.deepEqual([rel.severity, rel.title, rel.direction], ['check', 'Measure yaw_ccw_stop_gain again', 'check']);
    assert.match(rel.text, /Record a new log with the values at this time, and then do the analysis again\./);

});

test('C2: causes, gates and the CLI read every evidence row; the list is cut to 20 only in the output (s3.cjs: 25 logs)', () => {
    const logs = Array.from({ length: 25 }, (_, i) => ({ log: i + 1, start: `2026-10-04T${String(10 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00`, flown: true, flyingS: 100, profileSeconds: { 1: 100 }, targetOf: { 1: 2300 } }));
    const d1 = logs.map(l => f({ module: 'setup', id: 'D1', log: l.log, profile: null, value: 500, text: 'logging 500 Hz nominal' }));
    const f10 = f({ module: 'more', id: 'F11', axis: 'yaw', log: 23, profile: 1, value: 6, se: .1, threshold: 'D share - 2 SE > 0.5', unit: 'fraction', text: 'yaw axisD power above 30 Hz 80 %' });
    const out = run(d1.concat([f10]), { logs, header: Object.assign({}, HEADER, { frameIntervalPDenom: 4 }), headerLog: 25 });
    const d = only(out, 'D1'), yaw = only(out, 'F11');
    assert.equal(d.evidence.length, 20);
    assert.match(d.caveats.join(' '), /There are 25 results, and the list shows the first 20\./);
    assert.deepEqual(yaw.causes.map(c => [c.rule, c.holds]), [['K19', true]], 'the D1 flag of log 23 is the 23rd row of D1');
    assert.deepEqual(yaw.cli, []);
    assert.deepEqual(commands(advice.script(out.recommendations)), ['batch start', 'set blackbox_rate_denom = 2', 'save']);
    // the diagram of the worker reads the output: citedFids keeps every fid, and the D1 flag of log 23 is a problem there too
    assert.equal(d.citedFids.length, 25);
    if (H) { const st = H.status(d1.concat([f10]), out.recommendations, { logs });
        assert.ok(st.nodes.logging.problemFids.includes(d1[22].fid), 'the 23rd D1 row, after the cut');
        const w = H.status(d1.concat([f10]), out.recommendations.map(r => Object.assign({}, r, { citedFids: undefined })), { logs }).nodes.logging; assert.equal((w.problemFids || []).includes(d1[22].fid), false, 'without citedFids'); }
});

test('C3: the gains that report.cjs changes together have CLI text together or none; the export refuses a part of the group', () => {
    // s1.cjs: pitch P x1.1 and F x0.9: K7 holds F (D, P and I first), so P loses its CLI text too
    const pf = only(run([], { decisions: [decision({ changes: [{ gain: 'P', multiplier: 1.1, from: 50, to: 55, improves: 'tracking' }, { gain: 'F', multiplier: 0.9, from: 100, to: 90, improves: 'tracking' }] })] }), 'C7:pitch_p');
    assert.deepEqual([pf.group, pf.groupSize, pf.cli], ['C7:pitch:2250', 2, []]);
    assert.match(pf.caveats.join(' '), /The model changes 2 gains together \(`C7:pitch:2250`\), and the change of pitch_f_gain has no CLI text\. Thus, no change of this group has CLI text\./);
    // P and D: both have CLI text; the default picks take both, and a pick of one of them is refused
    const out = run([], { decisions: [decision({ changes: [{ gain: 'P', multiplier: 1.1, from: 50, to: 55 }, { gain: 'D', multiplier: 0.9, from: 40, to: 36 }] })] });
    const p = only(out, 'C7:pitch_p'), d = only(out, 'C7:pitch_d');
    assert.deepEqual([p.cli, d.cli], [['profile 0', 'set pitch_p_gain = 55'], ['profile 0', 'set pitch_d_gain = 36']]);
    assert.deepEqual(advice.defaultPicks(out.recommendations).sort(), [d.id, p.id].sort());
    const part = advice.exportScript(out.recommendations, [p.id], {});
    assert.deepEqual(commands(part), []);
    assert.match(flat(part), /Not in the file: .*It is 1 of 2 changes that the model makes together \(`C7:pitch:2250`\)\. Select all 2 changes, or none of them\./);
    assert.deepEqual(commands(advice.exportScript(out.recommendations, [p.id, d.id], {})), ['batch start', 'profile 0', 'set pitch_d_gain = 36', 'set pitch_p_gain = 55', 'save']);
});

test('C4: the header is no from-value when the CLI dump gives another value (s4.cjs): no CLI text, and both values', () => {
    const cli = setup.parseCli('dump all\n# master\nset gov_mode = ELECTRIC\nprofile 0\nset yaw_cw_stop_gain = 120\nset yaw_ccw_stop_gain = 120\nprofile 1\nset yaw_ccw_stop_gain = 80\nprofile 0\n');
    const d4 = f({ module: 'setup', id: 'D4', profile: 0, value: null, text: 'header vs CLI (dump, CLI profile 0, chosen by log profile at start (1-based event value - 1)): 1 of 80 values differ: yaw_stop_gain[1] 80 vs yaw_ccw_stop_gain 120. Trust the log header for header keys.' });
    const r = only(run([d4, T5F()], { cli }), 'T5');
    assert.deepEqual([r.from, r.cli], [80, []]);
    assert.match(r.caveats.join(' '), /The log header gives yaw_ccw_stop_gain 80, but the CLI dump gives 120 \(check D4\)\. The app cannot find which value is correct at this time\. Thus, there is no CLI text\./);
    const d1=f({module:'setup',id:'D1',profile:null,value:500});
    const d4g={...d4,fid:'d4g',text:'header vs CLI: frameIntervalPDenom 4 vs blackbox_rate_denom 2. Trust the log header for header keys.'};
    const r1=only(run([d4g,d1],{cli,header:{...HEADER,frameIntervalPDenom:4}}),'D1');
    assert.deepEqual(r1.cli,[]);assert.match(r1.caveats.join(' '),/different values of blackbox_rate_denom/);
});

test('C6: the CLI file gives the previous value of every name that a change sets, else "The previous value is unknown"', () => {
    const rows=[{scope:'global',name:'gyro_lpf1_type',from:'NONE',to:'FIRST_ORDER',source:'header'},
        {scope:'global',name:'gyro_lpf1_static_hz',from:0,to:100,source:'header'}];
    const recs=advice.filterRecommendations({version:2,model:{passed:true},recommended:{status:'recommended',fullRows:rows,rows}},{});
    const r=recs[0];assert.deepEqual(r.fromSets,{gyro_lpf1_type:'NONE',gyro_lpf1_static_hz:0});
    const text=advice.exportScript(recs,null,{});
    assert.match(text,/from NONE to FIRST_ORDER/);assert.match(text,/from 0 to 100/);
    assert.match(text,/the value at this time is from the log header/);
    const bare={id:'x',severity:'action',scope:'global',title:'X',cli:['set dyn_notch_q = 20'],evidence:[],blockedBy:[],causes:[]};
    assert.match(advice.exportScript([bare],['x'],{}),/The previous value is unknown/);

});

test('C8: a comment of the CLI file has printable ASCII and ± × ° µ only (the CLI tab sends the low 8 bits of a character): the others become "_"', () => {
    const r = { id: 'x', severity: 'action', scope: 'global', title: 'Change 上č ± × —', cli: ['set dyn_notch_q = 20'], evidence: [], blockedBy: [], causes: [], rule: 'Rule 1 ± 2 °, 5 µs' };
    const text = advice.exportScript([r], ['x'], { file: 'log上save.bbl', craft: 'Gaui čX4' });
    // every character sends a byte that is printable or a Latin-1 symbol: no line feed or carriage return in a comment
    assert.ok([...text].every(ch => ch === '\n' || (ch >= ' ' && ch <= '~') || '±×°µ'.includes(ch)), 'ASCII and ± × ° µ only');
    assert.ok([...text].every(ch => ch === '\n' || ![0x0a, 0x0d].includes(ch.charCodeAt(0) & 0xff)), 'no character whose low 8 bits are LF or CR');
    assert.equal(text.split('\n').filter(l => l === 'save').length, 1, 'U+4E0A (low byte LF) cannot start a line "save"');
    assert.match(text, /# Change 1 of 1: Change __ ± × -/);
    assert.match(text, /# Log file: "log_save\.bbl"/);
    assert.match(text, /#   Rule: Rule 1 ± 2 °, 5 µs/);
});





test('D-M1: an upstream flag whose times all lie in the times of the symptom is no cause (T8 in the T1 burst of the Fireball); K9 keeps T8 outside the hover windows', () => {
    const span = (t0, t1) => ({ spans: [{ log: 5, t0, t1 }] });
    const t1 = f({ module: 'track', id: 'T1', axis: 'yaw', profile: 2, value: 2, unit: 'count', text: 't1', evidence: span(330.927, 335.651) });
    const t8 = (spans) => f({ id: 'T8', profile: 2, value: 0.48, text: 't8', evidence: { spans: spans.map(([t0, t1]) => ({ log: 5, t0, t1 })) } });
    const inside = only(run([t1, t8([[333.031, 334.071], [332.093, 333.129], [333.682, 334.712]])]), 'T1:yaw');
    assert.deepEqual(inside.causes, []);
    assert.match(inside.caveats.join(' '), /The times of check T8 \(333 s to 334\.1 s in log 5, .*\) are all in the times of this result\. Thus, rule K2 does not apply to check T8: this result can cause it\./);
    const outside = only(run([t1, t8([[333.031, 334.071], [120.5, 121.5]])]), 'T1:yaw');
    assert.deepEqual(outside.causes.map(c => [c.rule, c.ids]), [['K2', ['T8']]]);
    // the diagram (hierarchy.cjs causesOf) does the same test
    if (H) {
        const T8in = t8([[333.031, 334.071]]), T1f = Object.assign({}, t1);
        assert.deepEqual(H.causesOf(T1f, [T1f, T8in]).map(c => c.rule), []);
        assert.deepEqual(H.causesOf(T1f, [T1f, t8([[120.5, 121.5]])]).map(c => c.rule), ['K2']);
    }
    // K9 (T13 <- T8), as on the Gaui: the hover windows of T13 and the T8 periods do not overlap, and the rule stays
    const t13 = f({ module: 'more', id: 'T13', profile: 1, value: -0.21, se: 0.016, text: 't13', evidence: { spans: [{ log: 5, t0: 174.8, t1: 185.8 }, { log: 5, t0: 169.8, t1: 172.8 }] } });
    const gaui = only(run([t13, f({ id: 'T8', profile: 1, value: 0.4, text: 't8', evidence: { spans: [{ log: 5, t0: 144.7, t1: 145.8 }, { log: 5, t0: 140.3, t1: 141.4 }] } })]), 'T13');
    assert.deepEqual(gaui.causes.map(c => [c.rule, c.ids]), [['K9', ['T8']]]);
});



test("Many raw-line references retain complete evidence identifiers without CLI proposals", () => {
    const findings=Array.from({length:25},(_,i)=>f({module:'setup',id:'F5',log:i+1,profile:i%3+1,value:3,n:10,text:`line at 3 x rotor (${100+i} Hz, prominence 40): nearest notch yaw none`}));
    const out=run(findings,{logs:findings.map(f=>({log:f.log,flown:true})),cli:CLI}),r=only(out,'F5');
    assert.equal(r.severity,'info');assert.equal(r.evidence.length,20);assert.equal(r.citedFids.length,25);
    assert.deepEqual(r.cli,[]);assert.equal(advice.script(out.recommendations),'');
    assert.match(r.caveats.join(' '),/25 results/);
});

test('D-M5: G6 states the rule that flagged; D6 explains the guard time; RANGE_FIRST does not claim a sufficient range; G9 below 2 SE claims no oscillation', () => {
    const g6 = f({ module: 'gov', id: 'G6', value: 67.8, n: 33502, threshold: { median: 85, runS: 0.1, deficit: 0.02 }, text: 'median throttle 67.8 % (p95 82.5 %), 1.86 % of ACTIVE time at the ceiling 1000 (guessed); 1 runs >= 100 ms at the ceiling with headspeed > 2 % below target at 374.774 s (0.625 s, 13.5 %). Saturation, not a gain problem' });
    const r = only(run([g6]), 'G6');
    assert.match(r.text, /The median throttle is 67\.8 % \(log 5, PID profile 1\)/);
    assert.match(r.text, /The longest period is 0\.625 s at 374\.774 s, with the headspeed 13\.5 % low/);
    assert.match(r.procedure.steps.join(' '), /If headspeed falls before full throttle, examine the governor response/);
    assert.match(r.procedure.steps.join(' '), /At full throttle, examine battery voltage, battery current and ESC temperature/);
    assert.match(r.procedure.title, /before you increase governor gains/);
    assert.match(r.procedure.steps.join(' '), /If voltage is less than the battery limit or the ESC limits power, correct that problem/);
    assert.match(r.procedure.after, /After these checks/);
    assert.match(r.procedure.after, /can decrease tail authority/);
    assert.deepEqual(r.cli, [], 'a diagnostic procedure does not select a gain or headspeed');
    const inferred = only(run([{ ...g6, throttleLimit: { value: 904, estimated: true } }]), 'G6');
    assert.match(inferred.procedure.title, /^Examine the throttle limit/);
    assert.match(inferred.procedure.steps[0], /governor maximum throttle value/);
    assert.match(inferred.text, /does not show the available throttle reserve/);
    assert.doesNotMatch(inferred.text, /stayed at its maximum|headroom was not sufficient/);
    assert.deepEqual(inferred.cli, []);
    assert.doesNotMatch(r.text, /battery with more cells/);
    assert.doesNotMatch(r.text, /The median throttle is more than 85|Decrease the target headspeed/);
    assert.match(r.caveats.join(' '), /Check G6 gives no SE, because the median throttle and the number of periods at the maximum come from all samples/);
    assert.match(only(run([f({ module: 'gov', id: 'G6', value: 90, text: 'median throttle 90 %' })]), 'G6').text, /The median throttle is more than 85 %\. Thus, the throttle headroom is too small\./);
    const d6 = f({ module: 'more', id: 'D6', severity: 'note', profile: null, value: 3.11, unit: 's', events: [{ t: 39.8, seconds: 1.08, value: 0.833, reason: 'rescue' }], text: 'd6' });
    assert.match(only(run([d6]), 'D6:excluded').text, /In log 5, the analysis did not use 3\.1 s: 0\.8 s of rescue\. The other 2\.3 s is the time of 1 s before and after each of these periods\./);
    const t5 = only(run([f({ id: 'T8', value: 4, text: '60 episodes' }), T5F()]), 'T5');
    assert.doesNotMatch(t5.caveats.join(' '), /output range is sufficient/);
    const g9 = only(run([f({ module: 'gov', id: 'G9', severity: 'note', value: 5.01, se: 1.94, text: '(P-type): not by 2 SE' })]), 'G9');
    assert.equal(g9.severity, 'watch');
    assert.doesNotMatch(g9.text, /The headspeed has an oscillation/);
    assert.match(g9.text, /This is not more than the limit by 2 SE\. Thus, it is not sure that the headspeed has an oscillation\./);
});

test('D-M5c: a change from SPOOLUP to ACTIVE after the liftoff gives the procedure of C15, not a slower spool-up', () => {
    const g16 = PH('G16', { log: 0, value: 0.0711, se: null, n: 1, overshoot: 0.0711, throttleStepPct: -0.02, settleS: 1, reference: 'govTarget', events: [{ t: 8.553, value: 0.0711 }] });
    const d7 = D7F(0, false, { flights: [{ t0: 7.279, t1: 376.8 }] });
    const r = only(run([g16, d7], { logBase: 1 }), 'G16');
    assert.match(r.text, /The change to ACTIVE came 1\.27 s after the liftoff at 7\.28 s \(log 1, PID profile 1\)\./);
    assert.match(r.text, /A change in rotor load can cause part of the error\. Compare collective, throttle and headspeed around this change before you adjust the governor\./);
    assert.match(r.text, /Keep the collective low until the governor is ACTIVE\. Then do the liftoff in one movement\.$/);
    assert.doesNotMatch(r.text, /rotor load causes a part of the error/);
    // the fields of health_phase (afterLiftoff, afterLiftoffS, liftoffT) give the same, without D7
    const own = only(run([PH('G16', { log: 0, value: 0.0711, n: 1, events: [{ t: 8.553, value: 0.0711 }], afterLiftoff: true, afterLiftoffS: 1.274, liftoffT: 7.279 })], { logBase: 1 }), 'G16');
    assert.match(own.text, /The change to ACTIVE came 1\.27 s after the liftoff at 7\.28 s/);
    assert.match(only(run([PH('G16', { value: 0.0711, n: 1, afterLiftoff: true, afterLiftoffS: 1.3 })]), 'G16').text, /came 1\.3 s after the liftoff \(log 5, PID profile 1\)/);
    assert.match(only(run([Object.assign({}, g16, { fid: 'g16b', afterLiftoff: false }), d7], { logBase: 1 }), 'G16').text, /a larger gov_spoolup_time gives a slower spool-up/, 'afterLiftoff false: on the ground');
    assert.doesNotMatch(r.text, /gov_spoolup_time/);
    assert.equal(r.title, 'Change from SPOOLUP to ACTIVE');
    assert.match(only(run([g16]), 'G16').text, /a larger gov_spoolup_time gives a slower spool-up/, 'on the ground: the slower spool-up');
});

test('D-M5e: a check or a watch has no instruction to change a value (titles and texts)', () => {
    const findings = SEQUENCE().concat([T14F(), f({ id: 'T6', value: 50, se: 5, towardTorque: { mean: 30, se: 5 }, text: 'kick' }), f({ id: 'T7', value: 0.8, se: 0.05, precompScale: 1.44, text: 't7' }),
        f({ id: 'C4', axis: 'roll', value: 25, se: 3, settleS: { mean: 0.2, se: 0.02 }, text: 'FF too high' }), f({ id: 'C1', axis: 'roll', value: 3, text: 'I at limit' }), f({ id: 'C6', axis: 'pitch', value: 9, text: 'driven by I' }),
        f({ module: 'more', id: 'T13', value: -0.24, se: 0.004, text: 'hover yaw I' }), f({ module: 'more', id: 'F10', axis: 'yaw', value: 0.8, se: 0.05, text: 'f10' }), f({ id: 'C11', axis: 'roll', value: 0.8, se: 0.02, text: 'roll D noise' }),
        f({ module: 'gov', id: 'G6', value: 90, text: 'median throttle 90 %' }), f({ module: 'gov', id: 'G9', value: 9, se: 1, text: '(P-type)' }), f({ module: 'gov', id: 'G9', severity: 'note', value: 5, se: 2, text: '(I-type) not by 2 SE' }),
        f({ module: 'gov', id: 'G10', value: 0.7, se: 0.05, text: 'coherence' }), f({ module: 'gov', id: 'G5', value: 2, se: 0.1, text: 'g5' }), f({ module: 'more', id: 'G14', value: 1, text: 'g14' }),
        f({ id: 'C10', axis: 'roll', value: 2, text: 'c10' }), f({ module: 'setup', id: 'F6', value: 6, se: 1, text: 'f6' }), T5F({ value: 1.54, se: 0.38, fid: 'w5' }), T5F({ profile: 3, fid: 'p3' }),
        f({ id: 'T9', axis: 'yaw', value: 0.3, se: 0.05, gyroRatio: { mean: 1, se: 0.01 }, text: 't9' }), TRACK('R1', { axis: 'roll', value: 80, se: 5, text: 'r' }),
        f({ module: 'setup', id: 'D3', severity: 'note', profile: null, value: 1, text: 'checks that cannot run: F5/F6/F7 (gyroRAW[0] absent, gyroRAW[1] absent, gyroRAW[2] absent)' }),
        f({ module: 'setup', id: 'F3', profile: null, value: 1.5, text: 'q' }), PH('G16', { value: 0.034, settleS: 1.2 }), PH('G15', { value: 300, impliedSpoolupTime: 99 }),
        f({ module: 'setup', id: 'F5', log: 6, value: 9, text: 'line at 9 x rotor (340 Hz, prominence 40): nearest notch roll none, pitch none, yaw none' })]);
    const out = run(findings, { cli: CLI, header: Object.assign({}, HEADER, { rollPID: [50, 200, 0, 100, 0], gyro_rpm_notch_q_roll: pad([80, 15, 60, 50]) }) });
    const soft = out.recommendations.filter(r => r.severity === 'check' || r.severity === 'watch');
    assert.ok(soft.length >= 20, String(soft.length)); // numeric trial recommendations are actions now
    const VERB = /^(Increase|Decrease|Raise|Lower|Reduce|Set|Change|Add|Use|Make the|Adjust|Multiply|Enable|Turn)\b/, TITLE = /^(Increase|Decrease|Raise|Lower|Reduce|Set|Add|Use|Make the|Adjust|Enable)\b/; // "Change from ..." is a noun
    for (const r of soft) {
        assert.ok(!TITLE.test(r.title), `${r.id} ${r.severity} title: ${r.title}`);
        for (const sen of String(r.text).replace(/"[^"]*"/g, 'Q').split(/(?<=[.!?])\s+/)) assert.ok(!VERB.test(sen.replace(/^(If|When|After|Before|Then|With)\b[^,]*,\s*/, '')), `${r.id} ${r.severity}: ${sen}`);
    }
});

test('D-LOW: SETUP has an evidence row; C15 with more than one result gives the largest and the range of all', () => {
    const s = setupOf(5, '80,120,14,20,0', '120,80'), out = run([s, setupOf(6, '80,120,14,20,0', '120,80')], { header: Object.assign({}, HEADER, { rates_type: 4 }), headerLog: 5 });
    assert.deepEqual(only(out, 'SETUP:rates_type').evidence.map(e => [e.id, e.log]), [['SETUP', 5]]);
    const c15 = (log, value, hz) => PH('C15', { log, axis: 'roll', value, hz, hzSe: 0.1, growth: 3, growthSe: 0.7 });
    const r = only(run([c15(5, 7.2, 8.46), c15(6, 9.5, 8.6), c15(7, 6.1, 8.3)]), 'C15');
    assert.match(r.text, /Check C15 has a problem in 3 results \(logs 5, 6 and 7\)\. The largest is in log 6, PID profile 1: the roll rate has an oscillation on the skids at 8\.6 ± 0\.1 Hz of 9\.5 deg\/s rms\./);
    assert.ok(r.caveats.includes('In the 3 results, the rms rate is 6.1 deg/s to 9.5 deg/s. The frequency is 8.6 Hz, 8.46 Hz and 8.3 Hz.'), r.caveats.join('\n'));
});

// ---------------------------------------------------------------------------------------------
// Real data (analysis/ outputs of the peer session; skipped when absent)
// ---------------------------------------------------------------------------------------------

function realInput(dir, tune, selected, cli) {
    const R = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'results.json'), 'utf8')), H = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'health.json'), 'utf8'));
    const T = fs.existsSync(path.join(ROOT, tune)) ? JSON.parse(fs.readFileSync(path.join(ROOT, tune), 'utf8')) : null, rec = H.logs.find(l => l.log === selected);
    return { findings: R.findings, decisions: T ? T.decisions : null, header: rec.header, cli, fields: rec.metrics.setup.D3.fields, headerProfile: rec.metrics.setup.startProfile, headerLog: selected,
        logs: H.logs.filter(l => !l.skipped).map(l => ({ log: l.log, start: l.start, flown: l.flown, flyingS: l.flyingS, profileSeconds: l.profileSeconds, targetOf: l.targetOf })) };
}
const GAUI = 'analysis/gaui-x4/health', FIRE = 'analysis/fireball-0928';

test('real data, Gaui X4 (no CLI dump): no CLI for the D2 stalls, the F5 flags, or T5/T6 below 2 SE', { skip: !fs.existsSync(path.join(ROOT, GAUI, 'health.json')) }, () => {
    const out = advice.advise(realInput(GAUI, 'analysis/gaui-x4/tune/results.json', 58, null));
    const by = (id) => out.recommendations.filter(r => r.id.split(':')[0] === id);
    assert.equal(by('D2').length, 1); assert.equal(by('D2')[0].severity, 'check');
    assert.equal(by('F5').length, 1); assert.equal(by('F5')[0].severity, 'info'); assert.equal(by('F5')[0].evidence.length, 8);
    for (const id of ['T5', 'T6']) { assert.equal(by(id).length, 1, id); assert.equal(by(id)[0].severity, 'watch', id); }
    assert.equal(out.recommendations.filter(r => r.cli.length).length, 0, out.recommendations.filter(r => r.cli.length).map(r => r.id).join(', '));
    assert.equal(by('T8')[0].severity, 'check');
    assert.equal(by('C7').length, 3);
    assert.ok(by('C7').every(r => r.severity === 'info'));
});

test('real data, Fireball 2026-09-28: filter references do not block; profile, RPM and output-limit checks remain', { skip: !fs.existsSync(path.join(ROOT, FIRE, 'health.json')) }, () => {
    const out = advice.advise(realInput(FIRE, 'analysis/fireball-0928/tune/results.json', 18, null));
    for (const r of out.recommendations.filter(x => x.cli.length)) {
        assert.equal(r.severity, 'action', r.id); assert.deepEqual(r.blockedBy, [], r.id);
        assert.ok(r.cli.every(l => /^(profile \d|set \w+ = [\w,]+)$/.test(l)), r.cli.join('; '));
    }
    assert.deepEqual(commands(advice.script(out.recommendations)), []);
    assert.equal(only(out,'F1').severity,'info');
    const c7 = out.recommendations.find(r => r.id === 'C7:pitch_f_gain:p2');   // 4500 rpm = PID profile 2; the header holds PID profile 1: from the calculated F 100 (D12)
    if (c7) { assert.deepEqual([c7.severity, c7.from, c7.to, c7.cli], ['action', 100, 80, []]); assert.deepEqual(c7.blockedBy,[]);assert.match(c7.caveats.join(' '),/PID profile 2 is unknown/); }
    assert.ok(out.recommendations.filter(r => r.area === 'governor').every(r => !r.cli.length), 'G1 FALLBACK flags block governor changes');
    assert.ok(out.recommendations.filter(r => r.area === 'tail' && r.direction === 'raise').every(r => !r.cli.length), 'T8 tail-limit flags block tail raises');
});

// review (Fireball 2026-10-05, log 16): the F5 text lists every line, and a main rotor harmonic that is weaker than the
// 3.79 x resonance of its log and PID profile still gets the RPM notch filter (rotor-locked, prominence 5 or more, no notch
// filter at 2 % or less on an axis, the gyro filters pass 50 % or more there). The lines at 1 x rotor from the resonance
// (2.79 x, 4.79 x) are a part of it: no RPM notch filter
test('F5: Fireball 2026-10-05 log 16 retains both profiles and measured line attenuation without untested notch proposals', () => {
    const P2 = 'line at 3.7879 x rotor (284.1 Hz, prominence 136.8, rotor-locked): nearest notch roll 14 at 4 (5.3 %), pitch 14 at 4 (5.3 %), yaw 12 at 2 (89.4 %); line at 2.7884 x rotor (209.1 Hz, prominence 24, rotor-locked): nearest notch roll 14 at 4 (30.3 %), pitch 14 at 4 (30.3 %), yaw 12 at 2 (39.4 %); line at 2.9988 x rotor (224.9 Hz, prominence 21.3, rotor-locked): nearest notch roll 14 at 4 (25.0 %), pitch 14 at 4 (25.0 %), yaw 12 at 2 (49.9 %); line at 4.7876 x rotor (359.1 Hz, prominence 16.6, rotor-locked): nearest notch roll 14 at 4 (19.7 %), pitch 14 at 4 (19.7 %), yaw 12 at 2 (139.4 %); line at 3.9992 x rotor (300 Hz, prominence 10.3, rotor-locked): nearest notch roll 14 at 4 (0.0 %), pitch 14 at 4 (0.0 %), yaw 12 at 2 (100.0 %); line at 5.7872 x rotor (434.1 Hz, prominence 9.3): nearest notch roll 14 at 4 (44.7 %), pitch 14 at 4 (44.7 %), yaw 12 at 2 (189.4 %); line at 4.5772 x rotor (343.3 Hz, prominence 7.5, rotor-locked): nearest notch roll 14 at 4 (14.4 %), pitch 14 at 4 (14.4 %), yaw 12 at 2 (128.9 %); line at 4.923 x rotor (369.2 Hz, prominence 7.4, rotor-locked): nearest notch roll 14 at 4 (23.1 %), pitch 14 at 4 (23.1 %), yaw 12 at 2 (146.2 %); line at 4.9982 x rotor (374.9 Hz, prominence 5.5, rotor-locked): nearest notch roll 14 at 4 (25.0 %), pitch 14 at 4 (25.0 %), yaw 12 at 2 (149.9 %)';
    const PASS2 = [{ hz: 284.1, roll: 0.5584, pitch: 0.5584, yaw: 0.7157 }, { hz: 209.1, roll: 0.9397, pitch: 0.9402, yaw: 0.9471 }, { hz: 224.9, roll: 0.942, pitch: 0.9433, yaw: 0.9537 }, { hz: 359.1, roll: 0.9533, pitch: 0.9475, yaw: 0.9646 },
        { hz: 300, roll: 0.1591, pitch: 0.1064, yaw: 0.2106 }, { hz: 434.1, roll: 0.8806, pitch: 0.91, yaw: 0.8821 }, { hz: 343.3, roll: 0.8976, pitch: 0.915, yaw: 0.935 }, { hz: 369.2, roll: 0.9763, pitch: 0.9568, yaw: 0.9772 }, { hz: 374.9, roll: 0.9678, pitch: 0.9717, yaw: 0.9735 }];
    const P3 = 'line at 3.7879 x rotor (315.6 Hz, prominence 227.6, rotor-locked): nearest notch roll 14 at 4 (5.3 %), pitch 14 at 4 (5.3 %), yaw 12 at 2 (89.4 %); line at 4.7876 x rotor (398.9 Hz, prominence 33.4, rotor-locked): nearest notch roll 14 at 4 (19.7 %), pitch 14 at 4 (19.7 %), yaw 12 at 2 (139.4 %); line at 2.7883 x rotor (232.3 Hz, prominence 30.8, rotor-locked): nearest notch roll 14 at 4 (30.3 %), pitch 14 at 4 (30.3 %), yaw 12 at 2 (39.4 %); line at 2.9988 x rotor (249.9 Hz, prominence 19.9, rotor-locked): nearest notch roll 14 at 4 (25.0 %), pitch 14 at 4 (25.0 %), yaw 12 at 2 (49.9 %); line at 3.9983 x rotor (333.1 Hz, prominence 14.1, rotor-locked): nearest notch roll 14 at 4 (0.0 %), pitch 14 at 4 (0.0 %), yaw 12 at 2 (99.9 %); line at 3.5777 x rotor (298.1 Hz, prominence 6.7, rotor-locked): nearest notch roll 14 at 4 (10.6 %), pitch 14 at 4 (10.6 %), yaw 12 at 2 (78.9 %); line at 0.8406 x rotor (70 Hz, prominence 5.9, absent at the same order at another headspeed: not rotor-locked): nearest notch roll 11 at 1 (15.9 %), pitch 11 at 1 (15.9 %), yaw 11 at 1 (15.9 %); line at 4.9978 x rotor (416.4 Hz, prominence 5.6, rotor-locked): nearest notch roll 14 at 4 (24.9 %), pitch 14 at 4 (24.9 %), yaw 12 at 2 (149.9 %)';
    const PASS3 = [{ hz: 315.6, roll: 0.6489, pitch: 0.6488, yaw: 0.7785 }, { hz: 398.9, roll: 0.9746, pitch: 0.9677, yaw: 0.9822 }, { hz: 232.3, roll: 0.9494, pitch: 0.9498, yaw: 0.9571 }, { hz: 249.9, roll: 0.9531, pitch: 0.9529, yaw: 0.9626 },
        { hz: 333.1, roll: 0.0037, pitch: 0.0056, yaw: 0.0203 }, { hz: 298.1, roll: 0.6932, pitch: 0.7859, yaw: 0.854 }, { hz: 70, roll: 0.8226, pitch: 0.9245, yaw: 0.9416 }, { hz: 416.4, roll: 0.9734, pitch: 0.9387, yaw: 0.988 }];
    const F = [f({ module: 'setup', id: 'F5', log: 15, profile: 2, pidProfile: 2, value: 3.7879, n: 36, text: P2, filterPass: PASS2 }), f({ module: 'setup', id: 'F5', log: 15, profile: 3, pidProfile: 3, value: 3.7879, n: 89, text: P3, filterPass: PASS3 })];
    const out = run(F, { cli: CLI, logs: [{ log: 15, flown: true, flyingS: 300, profileSeconds: { 2: 150, 3: 150 }, targetOf: { 2: 4500, 3: 5000 } }], headerLog: 15, logBase: 1 });
    const r=only(out,'F5');
    assert.equal(r.severity,'info');assert.deepEqual(r.cli,[]);assert.equal(r.evidence.length,2);
    assert.deepEqual(r.evidence.map(e=>e.filterPass),[PASS2,PASS3]);
    assert.deepEqual(r.evidence.map(e=>e.profile),[2,3]);noGearDoubt(out);
});

// review V3: no developer reference (file, line, section, rule number of the app, community thread) in the text that the pilot
// reads as the finding; a rule names its sources in one "Source:" sentence of quoted text, which r.sources also lists
const DEV_REF = /\.cjs\b|\.md\b|\.py\b|\b\w+\.c\b|\.c:\d|TUNING_KNOWLEDGE|CLAUDE|DEVELOPMENT|\[COM\]|\[INF\]|\bHF-\d|\bRCG-\d|analysis\/|FINDINGS|report\.cjs|SPEC2|sp_common|GROUND-LIFTOFF|BENCH-YAWSPIN|TAIL-\w|PWR-CEIL|CYC-LANDED|\b(?:advice\.cjs )?rules? \d+\b/;
test('review V3: no developer reference in the texts; the sources are one quoted "Source:" sentence after the rule', () => {
    const findings = [
        f({ module: 'setup', id: 'D2', profile: null, value: 0, text: '0 logging gaps in the log; in this segment 0 time jumps (0 frames missing, by loopIteration), 1 loop stalls (time jumps over contiguous loopIteration: no frame lost), 0 non-increasing times, 0 loopIteration jumps over 9000 frames', events: [{ t: 300, value: 71.7, kind: 'loop stall (time jump, iteration contiguous: no frame lost)', unit: 'ms' }] }),
        f({ module: 'setup', id: 'D3', severity: 'note', profile: null, value: 1, text: 'checks that cannot run: F5/F6/F7 (gyroRAW[0] absent, gyroRAW[1] absent, gyroRAW[2] absent)' }),
        f({ module: 'setup', id: 'F4', severity: 'note', profile: 'yaw', value: 40 }), f({ module: 'setup', id: 'F1', profile: null, value: 0 }),
        f({ module: 'setup', id: 'F5', value: 3.789, text: 'line at 3.789 x rotor (155.7 Hz, prominence 300, rotor-locked): nearest notch roll 14 at 4 (5.3 %), pitch 14 at 4 (5.3 %), yaw 12 at 2 (103.0 %)' }),
        f({ module: 'gov', id: 'G0', severity: 'note', profile: null, value: 0, text: 'govSum zero in flight: DIRECT or LIMIT' }), f({ module: 'gov', id: 'G11', value: 7, se: 1 }),
        f({ module: 'gov', id: 'G6', value: 88, text: 'median throttle 88 %; 1 runs >= 100 ms at the ceiling with headspeed 2 % below target at 300 s (0.5 s, 13.5 %)' }),
        f({ module: 'more', id: 'G14', value: 1, text: 'BAILOUT in flight' }), f({ module: 'loop', id: 'C1', axis: 'roll', value: 0.5 }),
        f({ module: 'loop', id: 'C10', profile: null, value: 1, text: '1.0 s spooled up and turning while the firmware says landed (ground decay active)' }),
        f({ module: 'loop', id: 'T2', value: 6, text: 'yaw slow oscillation' }), f({ module: 'track', id: 'T1', axis: 'yaw', value: 2, unit: 'count' }),
        f({ module: 'phase', id: 'G16', profile: null, value: 0.071, unit: 'fraction', throttleStepPct: 0, settleS: 1, afterLiftoff: true, afterLiftoffS: 1.27, liftoffT: 7.28, events: [{ t: 8.55 }] }),
        f({ module: 'phase', id: 'C15', profile: null, axis: 'roll', value: 15.4, unit: 'deg/s', hz: 8.31, hzSe: 0.12, growth: 3.87, growthSe: 0.38 }),
        f({ module: 'phase', id: 'G15', profile: null, value: 180, unit: 'deg/s', throttlePctPerS: { mean: 10, se: 1 }, impliedSpoolupTime: 100 }),
    ];
    const out = run(findings, { cli: CLI });
    const strip = (t) => String(t).replace(/`[^`]*`|"[^"\n]*"/g, 'Q');
    for (const r of out.recommendations) {
        for (const t of [r.title, r.text].concat(r.caveats, r.blockedBy)) assert.doesNotMatch(String(t), DEV_REF, `${r.id}: ${t}`);
        assert.doesNotMatch(strip(r.rule), DEV_REF, `${r.id} rule: ${r.rule}`);
        assert.ok(Array.isArray(r.sources), r.id);
        if (r.sources.length) assert.match(r.rule, /(?:^|\. )Sources?: "[^"]+"(?:, "[^"]+")*(?: and "[^"]+")?\.$/, `${r.id}: one Source sentence at the end: ${r.rule}`);
        // the quoted text of the other modules (health_setup, health_gov, health_loop) is theirs, and quoted: not read here
        for (const s of r.sources) assert.doesNotMatch(strip(s), DEV_REF, `${r.id} source: ${s}`);
    }
    for (const t of out.notes.concat(out.coverage.map(c => c.detail))) assert.doesNotMatch(strip(t), DEV_REF, t);
    // the result of a different helicopter is a source that says so, never a note or a text of this analysis
    const g16 = only(out, 'G16');
    assert.ok(g16.sources.some(s => /^a result on a different helicopter \("Gaui X4 II", 2026-10-04\), not from the logs of this analysis: in 3 of 3 flights/.test(s)), g16.sources.join(' | '));
    assert.doesNotMatch(g16.caveats.join(' ') + g16.text, /8\.3 Hz to 8\.7 Hz|3 of 3 flights/);
    assert.match(g16.text, /The change to ACTIVE came 1\.27 s after the liftoff at 7\.28 s/, 'the numbers of the text come from the log');
    const g6 = only(out, 'G6');
    assert.match(g6.caveats.join(' '), /The output limit does not show the cause of the headspeed decrease before the throttle got to that limit\./);
});

// review V4: a recommendation from a measured result of the flights is 'measured'; one from the configuration only, or with
// no result, stays 'advisory'; a gain decision of the model stays 'predicted'
test('review V4: the confidence of a recommendation is "measured" when a measured result of the flights gives it', () => {
    const t8 = f({ module: 'loop', id: 'T8', value: 0.4, n: 18 }), f5 = f({ module: 'setup', id: 'F5', value: 3, text: 'line at 3 x rotor (115 Hz, prominence 40, rotor-locked): nearest notch roll none, pitch none, yaw 12 at 2 (50.0 %)' });
    const out = run([t8, f5, f({ module: 'setup', id: 'F1', profile: null, value: 0 })]);
    assert.equal(only(out, 'T8').confidence, 'measured');
    assert.equal(only(out, 'F5').confidence, 'measured', 'the RPM notch filter change rests on the measured gyroRAW line');
    assert.equal(only(out, 'F1').confidence, 'advisory', 'a value of the log header is no measurement of the flights');
    assert.equal(only(run([f({ module: 'setup', id: 'D4', profile: 0, value: 1, text: D4_TEXT })], { cli: CLI }), 'D4').confidence, 'advisory', 'a CLI dump against the log header is no measurement of the flights');
    assert.equal(only(run([f({ module: 'setup', id: 'D2', profile: null, value: 0, text: '1 loop stalls (time jumps over contiguous loopIteration: no frame lost)' })]), 'D2').confidence, 'measured');
});

// review V11: the previous value of a global setting names the CLI dump when the loaded dump gives the same value; a value
// that the dump does not have, or a different value (D4), stays "log header"
test('review V11: the CLI file says that a previous value comes from the CLI dump when the loaded dump agrees with the log header', () => {
    const findings=[f({module:'setup',id:'D1',profile:null,value:500})],head={...HEADER,frameIntervalPDenom:4};
    const same=setup.parseCli('dump\n# master\nset blackbox_rate_denom = 4\n');
    const a=only(run(findings,{header:head,cli:same,cliName:'fireball_cli_dump.txt'}),'D1');
    assert.equal(a.fromSource,'CLI dump "fireball_cli_dump.txt", the same as the log header');
    assert.match(advice.exportScript([a],[a.id],{}),/from 4 to 2/);
    assert.equal(only(run(findings,{header:head}),'D1').fromSource,'log header');
    // a PID profile value of the confirmed arming profile that the CLI section gives with the same value
    const t5 = only(run([f({ id: 'T5', value: 2, se: 0.1, larger: 'ccw' })], { cli: setup.parseCli('dump\n# master\nset gov_mode = ELECTRIC\nprofile 0\nset yaw_ccw_stop_gain = 80\n'), cliName: 'c.txt' }), 'T5');
    assert.equal(t5.fromSource, 'CLI dump "c.txt", section `profile 0`, the same as the log header');

});

// review V5: D2 gives the number of loop stalls and the longest, when the loop stalls are the cause of the flag
test('review V5: D2 names the loop stalls that cause the flag, with the longest and its phase', () => {
    const d2 = f({ module: 'setup', id: 'D2', profile: null, value: 0, text: '0 logging gaps in the log; in this segment 0 time jumps (0 frames missing, by loopIteration), 2 loop stalls (time jumps over contiguous loopIteration: no frame lost), 0 non-increasing times, 0 loopIteration jumps over 9000 frames',
        events: [{ t: 300.1, value: 26.2, kind: 'loop stall (time jump, iteration contiguous: no frame lost)', unit: 'ms' }, { t: 379.8, value: 71.65, kind: 'loop stall (time jump, iteration contiguous: no frame lost)', unit: 'ms' }],
        evidence: { spans: [{ log: 5, t0: 379.6, t1: 380.1, value: 71.65, phase: 'spooldown' }, { log: 5, t0: 299.9, t1: 300.4, value: 26.2, phase: 'flight' }] } });
    const r = only(run([d2], { logBase: 1 }), 'D2');
    assert.match(r.text.split('\n')[1], /^Log 6 has 2 loop stalls and no missing frame\. Some intervals between frames are long\. The longest loop stall is 71\.7 ms \(log 6, during the spool-down\)\./);
    assert.match(r.rule, /^Check D2 has a problem if the log has more than 0 parts with no data or more than 0 frame time errors\. The frame time errors are the sudden time changes, the loop stalls and the times that do not increase, together\./);
    assert.equal(r.evidence[0].display && r.evidence[0].display.value, '2 loop stalls', 'the evidence row shows the cause, not the value 0 of the check');
});

// ---------------------------------------------------------------------------------------------
// The rescue checks (health_rescue.cjs: G19, T15, D8) and the control limits (health_limits.cjs: L1-L7)
// ---------------------------------------------------------------------------------------------

// findings in the shape that health_rescue.cjs judge gives them
const RS = (id, o) => f(Object.assign({ module: 'rescue', id, phase: 'flight', unit: { G19: 'fraction', T15: 'deg/s', D8: 'count' }[id], thin: false, n: 1, se: null, log: 14, profile: 2 }, o));
const G19F = (o) => RS('G19', Object.assign({ value: -0.415, noise: 0.0007, leave: 'FALLBACK', overload: true, minThrottleAfter: 521, throttleMax: 1000, threshold: { flag: 0.05, sig: 2 },
    events: [{ t: 192.0, t1: 196.4, start: 194.06, tS: 193.952, value: -0.415, leave: 'FALLBACK', leaveT: 193.686, overload: { t: 193.38, untilT: 193.686, fall: 0.19 }, bad: true }] }, o));

test('G19, T15, D8: checks of the rescue, never CLI; G19 on "Set the governor", T15 on the tail precompensation, D8 on the rescue', () => {
    const out = run([G19F(), RS('T15', { value: 138, peak: 231, base: 93, atLimitS: 0.02, axis: 'yaw', profile: 1, log: 13, threshold: { kick: 30 } }),
        RS('D8', { value: 1, profile: 1, log: 13, fromProfile: 2, toProfile: 1, fromTarget: 4500, toTarget: 3500 })]);
    const g = only(out, 'G19'), t = only(out, 'T15'), d = only(out, 'D8');
    assert.deepEqual([g.node, g.severity, g.cli], ['governor', 'check', []]);
    assert.match(g.text.split('\n')[1], /^At the rescue, the headspeed decreases to 41\.5 % less than the target \(log 14, PID profile 2\)\./);
    assert.match(g.text, /This shows a small throttle reserve\./);
    assert.match(g.text, /In FALLBACK, the firmware decreases the throttle by gov_fallback_drop\. In RECOVERY, the throttle increases at the rate of gov_recovery_time\./);
    assert.doesNotMatch(g.text, /decrease rescue_pull_up_collective/); assert.match(g.text, /This log does not measure the effect of that change/); assert.doesNotMatch(g.text, /gear|pulley|teeth/i, 'gear rule');
    assert.match(g.text, /The throttle gets to 100 %\. Thus, a larger gov_max_throttle cannot give more throttle\./);
    assert.match(only(run([G19F({ throttleMax: 900 })]), 'G19').text, /The throttle gets to 90 %\. Compare this with gov_max_throttle and the ESC output range\./);
    assert.deepEqual([t.node, t.severity, t.axis, t.cli], ['tailcomp', 'check', 'yaw', []]);
    assert.match(t.text.split('\n')[1], /^At the rescue, the largest yaw error is 138 deg\/s more than the largest yaw error before the rescue/);
    assert.match(t.text, /The tail output is at its limit for 0\.02 s in the first 1\.5 s\./);
    assert.match(t.text, /Examine yaw_collective_ff_gain, because the pull-up of the rescue is a large collective step\./);
    assert.deepEqual([d.node, d.severity, d.cli], ['rescue', 'check', []]);
    assert.match(d.text, /^At 1 rescue, the PID profile changes near the rescue start\. In log 13, PID profile 2 changes to PID profile 1\.$/m);
    assert.match(d.text, /The time of a PID profile change does not identify its source/);
    assert.match(d.text, /Examine the transmitter, Modes tab and Adjustments tab/);
    assert.match(d.text, /If the rescue switch changes the PID profile incorrectly, put the PID profile change on a different switch/);
    assert.match(d.text, /test the rescue switch on the ground with the motor off/);
    assert.doesNotMatch(d.text, /Put the rescue on a switch|then flies with the gains/);
    // T15 in a log where the PID profile changes at the rescue (D8): the cause is named, and rule K23 makes it a possible result
    assert.doesNotMatch(t.text, /check D8/, 'the D8 flag is of another rescue');
    const tAt = RS('T15', { value: 138, peak: 231, base: 93, atLimitS: 0.02, axis: 'yaw', profile: 1, log: 13, events: [{ t: 105.5, t1: 107, tS: 105.543, value: 138, bad: true }] });
    const dAt = RS('D8', { value: 1, profile: 1, log: 13, fromProfile: 2, toProfile: 1, events: [{ t: 104.5, t1: 105.6, tS: 105.543, value: 1 }] });
    assert.match(only(run([tAt, dAt]), 'T15').text, /At this rescue, the PID profile also changes \(check D8\)\./);
    assert.deepEqual(t.causes.map(c => c.rule), ['K23']);
});

test('T15: a rescue profile change cannot establish changed tail gains when the settings are unknown or equal', () => {
    const tAt = RS('T15', { value: 138, peak: 231, base: 93, atLimitS: 0.02, axis: 'yaw', profile: 2, log: 15,
        events: [{ t: 151.3, t1: 152.8, tS: 151.372, value: 138, bad: true }] });
    const dAt = RS('D8', { value: 1, profile: 2, log: 15, fromProfile: 3, toProfile: 2,
        events: [{ t: 150.3, t1: 151.4, tS: 151.372, value: 1 }] });
    const values = 'set yaw_p_gain = 80\nset yaw_i_gain = 120\nset yaw_d_gain = 14\nset yaw_f_gain = 20\nset yaw_b_gain = 0\n'
        + 'set yaw_base_thrust = 5\nset yaw_cyclic_ff_gain = 10\nset yaw_collective_ff_gain = 60\nset yaw_inertia_precomp_gain = 0\n';
    const equal = setup.parseCli(`dump all\nprofile 1\n${values}profile 2\n${values}`);
    assert.deepEqual(equal.profiles['1'], equal.profiles['2'], 'The two PID profiles have equal recorded tail settings.');
    for (const cli of [null, equal]) {
        const r = only(run([tAt, dAt], { cli, headerProfile: 2, headerLog: 15 }), 'T15');
        assert.match(r.text, /At this rescue, the PID profile also changes \(check D8\)\. This can change the tail gains and the precompensation\./);
        assert.doesNotMatch(r.text, /This changes the tail gains|gains (?:are|become) different/);
        assert.deepEqual([r.severity, r.cli], ['check', []]);
        assert.ok(r.causes.some(c => c.rule === 'K23' && c.ids.includes('D8')), 'The observed profile change remains a related check.');
    }
});

test('G1 at an overload of G19 (rule K22): overload context cannot clear the RPM prerequisite', () => {
    const g1 = f({ module: 'gov', id: 'G1', profile: null, value: 1, log: 14, times: [193.686], text: '1 FALLBACK entry at 193.686 s (0.213 s long). RPM signal lost or glitching' });
    const out = run([g1, G19F()]), g1s = (o) => o.recommendations.filter(x => /^G1(:|$)/.test(x.id)), r = g1s(out).find(x => x.id === 'G1:overload');
    assert.deepEqual(g1s(out).map(x => [x.id,x.severity]), [['G1','check'],['G1:overload','watch']]);
    assert.equal(r.title, 'FALLBACK at a headspeed decrease at full throttle');
    assert.match(r.text, /same time does not show that the RPM signal is correct/);
    assert.match(r.text, /RPM prerequisite stays open/);
    assert.deepEqual(r.causes.map(c => [c.rule, c.ids]), [['K22', ['G19']]]);
    for (const item of g1s(out)) {
        const context = item.causes.find(c => c.rule === 'K22');
        assert.ok(context, item.id);
        assert.equal(context.holds, false, 'The overload context cannot delay the RPM check that governor tuning requires.');
    }
    // a FALLBACK at another time stays a problem of the RPM signal
    const other = run([Object.assign({}, g1, { fid: 'g1b', times: [54.622] }), G19F()]);
    assert.deepEqual(g1s(other).map(x => [x.id, x.severity]), [['G1', 'check']]);
});

// G21 (health_gov judge, analysis/rpm-spikes): the sudden changes of the headspeed signal at the throttle maximum of PID profile 2 of the
// Fireball dump 2026-10-05: 6 of 7 at 100 %, in 1.56 % of the time. demand: the governor command in ACTIVE, 0.5 % bins from 85 %
const G21_DEMAND = { from: 85, step: 0.5, s: Array.from({ length: 51 }, (_, j) => j >= 24 && j < 31 ? 1 : j < 24 ? 10 : 0) };   // 7 s at 97 % or more
const G21F = (o = {}) => f(Object.assign({ module: 'gov', id: 'G21', log: [11, 13, 14], profile: 2, value: 6, se: null, n: 7, unit: 'count', threshold: { minSpikes: 3, maxP: 0.001, rateRatio: 10, margin: 3, source: 'pipeline, unvalidated' },
    atMax: 6, spikes: 7, atMaxS: 23.4, belowS: 1472.6, governedS: 1496, share: 0.01564, p: 1.2e-10, rateAtMax: 15.38, rateBelow: 0.0407, basis: 'profile',
    pooled: { k: 6, N: 7, atMaxS: 23.4, governedS: 1496, share: 0.01564, p: 1.2e-10, pass: true }, flights: 3, activeS: 1400,
    ceilings: [11, 13, 14].map(log => ({ log, value: 100, kind: 'pile', source: 'calculated from the log: motor[0] stays at 100 % in 1608 of 1608 samples while the governor command is more.' })),
    fallbacks: { n: 3, atMax: 3, afterSpike: 3 }, demand: G21_DEMAND, events: [{ log: 11, t: 54.621, kind: 'spike', atMax: true, rate: 293.1 }, { log: 11, t: 54.622, kind: 'FALLBACK', atMax: true }],
    text: 'At the throttle maximum (100 %), the headspeed signal has 6 sudden changes in 23.4 s.' }, o));

test('G21: sudden changes at the throttle maximum give gov_max_throttle = the maximum - 3 with CLI text, and a check of the RPM signal', () => {
    // the present value from the maximum that the analysis calculates from the logs (the pile of motor[0]), no CLI dump
    const out = run([G21F()]), r = only(out, 'G21:gov_max_throttle'), sig = only(out, 'G21:signal');
    assert.deepEqual([r.id, r.node, r.area, r.severity, r.profile, r.from, r.to, r.direction], ['G21:gov_max_throttle:p2', 'rpm', 'governor', 'action', 2, 100, 97, 'lower']);
    assert.deepEqual(r.cli, ['profile 1', 'set gov_max_throttle = 97']); assert.deepEqual([r.blockedBy, r.gate], [[], null]);
    assert.match(r.fromSource, /^the throttle maximum that the analysis calculates from the logs: motor\[0\] stays at 100 % while the governor command is more$/);
    assert.match(r.text, /At the throttle maximum of 100 %, the headspeed signal has 6 sudden changes in 23\.4 s \(logs 11, 13 and 14, PID profile 2\)\. With the throttle less than the maximum, it has 1 sudden change in 1472\.6 s\./);
    assert.match(r.text, /The test value is `P\(X >= 6\) = [\d.e-]+` for `X ~ Binomial\(7, 0\.0156\d*\)`\. In each minute, the rate is 15\.38 at the maximum and 0\.041 at less than the maximum\./);
    // the FALLBACK entries in the words of checks G20 and G21 (review 2026-10-15: "30 ms or less after" against "50 ms before")
    assert.match(r.text, /Of the 3 FALLBACK entries, 3 start at the throttle maximum and 3 start during a sudden change or 30 ms or less after its end\./);
    // the time at the new maximum and at the maximum now, each with its value (review 2026-10-15: "At this time" read as the 2.33 s)
    assert.match(r.text, /With a maximum of 97 %, the throttle stays less than the governor command for 2\.33 s in each flight of these logs\. With the maximum of 100 %, the throttle is at its maximum for 7\.8 s in each flight\./);
    assert.doesNotMatch(r.text, /At this time, the throttle/);
    assert.match(r.text, /Set gov_max_throttle on PID profile 2 from 100 to 97 \(the throttle maximum that the analysis calculates from the logs/);
    assert.match(r.rule, /^Check G21 has a problem if 3 or more sudden changes of the headspeed signal come at the throttle maximum\. Their test value `p` must be less than `0\.001`\./);
    assert.match(r.rule, /A lower throttle limit keeps the throttle out of the band where the RPM signal has errors\. The step is 3 %\./);
    assert.ok(r.sources.some(x => /0 sudden changes in 54 s at 95 % to 99\.5 % throttle/.test(x)), 'the evidence of the margin');
    assert.equal(r.evidence[0].id, 'G21');
    assert.deepEqual([sig.severity, sig.cli, sig.node], ['check', [], 'rpm']);
    assert.match(sig.text, /Make sure that the RPM sensor wire is not near the motor wires or the battery wires\./);
    assert.match(sig.text, /If the RPM signal comes from a frequency sensor input, examine `freq_input_pull`, `freq_input_edge` and `freq_input_minhz`\./);
    // the raw RPM (review 2026-10-15): debug[0] of RPM_SOURCE is the motor speed before its filter (motors.c:310), so the times of the
    // sudden changes, never the values; the log header tells if the log records it (debug_mode 47 is RPM_SOURCE in 4.6)
    assert.match(sig.text, /If `debug_mode` is not `RPM_SOURCE`, set it to `RPM_SOURCE` for one flight\. Then, in the log viewer, compare the times of the sudden changes of `debug\[0\]` and of the headspeed\./);
    assert.match(sig.text, /`debug\[0\]` is the motor speed before its filter\. Thus, compare only the times, not the values\./);
    assert.doesNotMatch(sig.text, /compare the `debug` values with the headspeed/);
    const sigOf = (mode) => only(run([G21F()], { header: Object.assign({}, HEADER, { debug_mode: mode }) }), 'G21:signal').text;
    assert.match(sigOf(0), /The log does not record the raw RPM, because `debug_mode` is not `RPM_SOURCE`\. To record the raw RPM, set `debug_mode` to `RPM_SOURCE` for one flight\. Then, in the log viewer, compare/);
    assert.match(sigOf(47), /The log records the raw RPM in `debug\[0\]`, because `debug_mode` is `RPM_SOURCE`\. In the log viewer, compare the times/);
    assert.doesNotMatch(sigOf(47), /set `debug_mode`/);
    assert.doesNotMatch(sig.text, /do the analysis again/, 'no module reads the debug fields (review 2026-10-15)');
    assert.match(sig.text, /The gear ratios in the configuration are correct\./); assert.doesNotMatch(sig.text + r.text, /pulley|tooth|gear ratio is|change the gear/i);
    // the CLI section of PID profile 2 gives the present value; a CLI value under the recorded throttle is not used
    const cli = (v) => setup.parseCli(`${CLI_TEXT}\nprofile 1\nset gov_max_throttle = ${v}\n`);
    const c = only(run([G21F({ ceilings: [{ log: 11, value: 98, kind: 'cli', source: 'CLI gov_max_throttle' }] })], { cli: cli(98) }), 'G21:gov_max_throttle');
    assert.deepEqual([c.from, c.to, c.cli], [98, 95, ['profile 1', 'set gov_max_throttle = 95']]); assert.match(c.fromSource, /CLI dump/);
    // a CLI value that the log contradicts: the value of the log is the present value (review 2026-10-15), with no CLI text
    const old = only(run([G21F()], { cli: cli(90) }), 'G21:gov_max_throttle');
    assert.deepEqual(old.cli, []); assert.match(old.caveats.join(' '), /The CLI value of gov_max_throttle is 90, but the log shows the throttle at 100 %\. Thus, there is no CLI text\./);
    assert.deepEqual([old.from, old.to], [100, 97]); assert.match(old.text, /\nAt the throttle maximum of 100 %, the headspeed signal has 6 sudden changes/);
    assert.match(old.text, /The analysis gives a change of gov_max_throttle on PID profile 2 from 100 to 97 \(the throttle maximum that the analysis calculates from the logs/);
    assert.match(old.fromSource, /^the throttle maximum that the analysis calculates from the logs/); assert.doesNotMatch(old.text, /from 90 to 87|maximum of 87 %/);
    // the maximum from motor[0] at 99.5 % or more (kind 'top'): an STE text (review 2026-10-15: no "whole percent")
    const top = only(run([G21F({ ceilings: [11, 13, 14].map(log => ({ log, value: 100, kind: 'top', source: 'calculated from the log' })) })]), 'G21:gov_max_throttle');
    assert.deepEqual([top.from, top.to, top.cli], [100, 97, ['profile 1', 'set gov_max_throttle = 97']]);
    assert.equal(top.fromSource, 'the throttle maximum that the analysis calculates from the logs: motor[0] gets to 99.5 % or more');
    assert.doesNotMatch(top.text + advice.exportScript([top], [top.id], { date: '2026-10-15' }), /whole/, 'STE: no "whole percent"');
    // no govSum: the step that records it
    const noSum = only(run([G21F({ demand: null })]), 'G21:gov_max_throttle');
    assert.match(noSum.text, /The log does not record govSum\. Thus, the analysis cannot calculate the time with the governor command at 97 % or more\. To record govSum, set `blackbox_log_governor` to ON\./);
    // different maximums in the logs, PID profile unknown, a value to monitor (no association), not measured: no CLI text or no recommendation
    const two = only(run([G21F({ ceilings: [{ log: 11, value: 95, kind: 'pile' }, { log: 13, value: 100, kind: 'pile' }] })]), 'G21:gov_max_throttle');
    assert.deepEqual(two.cli, []); assert.match(two.caveats.join(' '), /The logs show different throttle maximums of 95 % and 100 %\./);
    assert.deepEqual(only(run([G21F({ profile: 0 })]), 'G21:gov_max_throttle').cli, [], 'PID profile unknown');
    // two configurations of PID profile 2 (the worker pools by configuration): one recommendation with the sums; the second has 1 change
    // at its maximum (basis pooled), but the sums pass the test alone: no text of the test of all PID profiles
    const cfg = only(run([G21F({ fid: 'b', log: [11, 13], value: 5, n: 5, atMaxS: 13.1, belowS: 907.2, governedS: 920.3 }),
        G21F({ fid: 'e', log: [14], value: 1, n: 1, atMaxS: 3.8, belowS: 290.2, governedS: 294, basis: 'pooled', p: 0.0127 })]), 'G21:gov_max_throttle');
    assert.deepEqual([cfg.to, cfg.cli], [97, ['profile 1', 'set gov_max_throttle = 97']]);
    assert.match(cfg.text, /the headspeed signal has 6 sudden changes in 16\.9 s/); assert.doesNotMatch(cfg.text, /This PID profile has only/);
    const one = only(run([G21F({ value: 1, n: 1, atMaxS: 3.8, belowS: 290.2, governedS: 294, basis: 'pooled', p: 0.0127 })]), 'G21:gov_max_throttle');
    assert.match(one.text, /This PID profile has only 1 sudden change at its maximum\. Thus, the test uses all PID profiles together: `P\(X >= 6\) = 1\.2e-10`/);
    // a PID profile whose results together break the rate rule (the rate under the maximum more than 10 % of the rate at it): no change,
    // because a lower maximum does not remove most of its errors (review 2026-10-15); the check of the RPM signal stays
    const mostly = run([G21F({ value: 1, n: 7, atMaxS: 5, belowS: 100, governedS: 105, basis: 'pooled', p: 0.289 })]);
    assert.deepEqual(recs(mostly, 'G21:gov_max_throttle'), []); assert.equal(only(mostly, 'G21:signal').severity, 'check');
    assert.deepEqual(recs(run([G21F({ severity: 'note', value: 4, n: 12, basis: null })]), 'G21'), [], 'sudden changes everywhere: a value to monitor, no recommendation');
    assert.deepEqual(recs(run([G21F({ severity: 'skipped', value: 0, n: 0, atMaxS: 0 })]), 'G21'), []);
});

// review 2026-10-15: every FALLBACK of PID profile 2 follows 0.17 s to 0.33 s of overload (check G20): the recommendation gives the
// measured decrease; the linked governor values of the CLI dump (gov_handover_throttle, gov_min_throttle) are known in the CLI file
test('G21: the overload before the FALLBACK entries (check G20); the linked values of the CLI dump in the CLI file', () => {
    const fb = (t) => ({ log: 11, t, kind: 'FALLBACK', atMax: true, spike: { t: t - 0.001, dtS: 0.001 } });
    const g21 = G21F({ events: [{ log: 11, t: 54.621, kind: 'spike', atMax: true, rate: 293.1 }, fb(54.622), fb(159.549), Object.assign(fb(193.686), { log: 14 })] });
    const ev = (start, seconds, fall) => ({ kind: 'signal', start, causes: ['signal', 'overload'], seconds, value: fall });
    const g20 = [f({ module: 'rescue', id: 'G20', severity: 'note', profile: null, log: 11, value: 2, n: 2, threshold: { throttleHigh: 950 }, events: [ev(54.622, 0.203, 0.054), ev(159.549, 0.26, 0.102)] }),
        f({ module: 'rescue', id: 'G20', severity: 'note', profile: null, log: 14, value: 1, n: 1, threshold: { throttleHigh: 950 }, events: [ev(193.686, 0.33, 0.191)] })];
    const r = only(run([g21].concat(g20)), 'G21:gov_max_throttle');
    assert.match(r.text, /\nBefore each of the 3 FALLBACK entries, the throttle is at 95 % or more for 0\.2 s to 0\.33 s\. During this period, the headspeed decreases by 5\.4 % to 19\.1 % \(check G20\)\. A lower maximum throttle can make this decrease larger\.\n/);
    assert.match(only(run([g21, g20[0]]), 'G21:gov_max_throttle').text, /\nBefore 2 of the 3 FALLBACK entries, the throttle is at 95 % or more for 0\.2 s to 0\.26 s\./);
    assert.doesNotMatch(only(run([g21]), 'G21:gov_max_throttle').text, /During this period/, 'no check G20: no sentence');
    // the CLI dump (a diff: the defaults 25 and 10 of 4.6) gives the linked values: no "is unknown" in the CLI file, the value and its source
    const cliOf = (extra) => setup.parseCli(`${CLI_TEXT}${extra || ''}\nprofile 1\nset gov_max_throttle = 100\n`);
    const out = run([G21F({ ceilings: [{ log: 11, value: 100, kind: 'cli', source: 'CLI gov_max_throttle' }] })], { cli: cliOf() }), c = only(out, 'G21:gov_max_throttle');
    assert.deepEqual([c.from, c.to, c.linked.gov_handover_throttle.value, c.linked.gov_min_throttle.value], [100, 97, 25, 10], JSON.stringify(c.linked));
    const text = flat(advice.exportScript(out.recommendations, [c.id], { date: '2026-10-15' }));
    assert.doesNotMatch(text, /is unknown/);
    assert.match(text, /The flight controller keeps `gov_max_throttle` at `gov_handover_throttle` or more\. The value of `gov_handover_throttle` is 25 \(the value at this time is from the CLI dump/);
    assert.match(text, /The flight controller keeps `gov_min_throttle` at `gov_max_throttle` or less\. The value of `gov_min_throttle` \(PID profile 2\) is 10 \(the value at this time is from the CLI dump/);
    assert.deepEqual(commands(advice.exportScript(out.recommendations, [c.id], { date: '2026-10-15' })), ['batch start', 'profile 1', 'set gov_max_throttle = 97', 'save']);
    // a linked value of the CLI dump that the change breaks: the firmware changes the value, the change is not in the file
    const bad = run([G21F({ ceilings: [{ log: 11, value: 100, kind: 'cli', source: 'CLI gov_max_throttle' }] })], { cli: setup.parseCli(`${CLI_TEXT}\nprofile 1\nset gov_max_throttle = 100\nset gov_min_throttle = 99\n`) });
    const bt = advice.exportScript(bad.recommendations, ['G21:gov_max_throttle:p2'], { date: '2026-10-15' });
    assert.deepEqual(commands(bt), []); assert.match(flat(bt), /Not in the file: Decrease the maximum throttle .*`gov_min_throttle` \(PID profile 2\) is 99/);
    // without a CLI dump: unknown, as before
    assert.match(flat(advice.exportScript(run([G21F()]).recommendations, ['G21:gov_max_throttle:p2'], { date: '2026-10-15' })), /The value of `gov_handover_throttle` is unknown\./);
});

test('G21: the remedy of the RPM prerequisite: no gate holds it, the other governor changes stay held; the CLI file', () => {
    const g1 = f({ module: 'gov', id: 'G1', profile: null, value: 3, log: 11, times: [54.622], text: '3 FALLBACK entries' });
    const g3 = f({ module: 'gov', id: 'G3', governorResponse: GOV_RESPONSE, log: [5], profile: 2, value: 0.07, se: 0.005, text: 'droop 7 %: F too low (GOVT)' });
    const g21 = G21F(), out = run([g21, g1, g3]), r = only(out, 'G21:gov_max_throttle'), held = only(out, 'G3:');
    assert.deepEqual([r.cli, r.blockedBy, r.gate, r.holds], [['profile 1', 'set gov_max_throttle = 97'], [], null, []], 'guard 2 and the gates do not hold the remedy of check G21');
    assert.deepEqual(held.cli, []); assert.match(held.blockedBy.join(' '), /Check G1 shows FALLBACK entries/);
    assert.ok(held.gate && held.gate.held.includes('rpm'), JSON.stringify(held.gate));
    if (H) { const st = H.status([g21, g1, g3], out.recommendations);
        assert.equal(st.nodes.rpm.status, 'problem'); assert.ok(st.nodes.rpm.recs.includes('G21:gov_max_throttle:p2') && st.nodes.rpm.problemFids.includes(g21.fid), JSON.stringify(st.nodes.rpm));
        assert.deepEqual([st.nodes.governor.status, st.nodes.governor.blockedBy], ['blocked', ['rpm']]); }
    assert.deepEqual(advice.defaultPicks(out.recommendations), ['G21:gov_max_throttle:p2'], 'the change with CLI text is selected first');
    const text = advice.exportScript(out.recommendations, null, { date: '2026-10-15' });
    assert.deepEqual(commands(text), ['batch start', 'profile 1', 'set gov_max_throttle = 97', 'save']);
    assert.match(flat(text), /Recommendation `G21:gov_max_throttle:p2`\./); assert.match(flat(text), /from 100 to 97/);
});

test('G1 at an overload of G19 and a sudden change of check G21 (G20 signal): the FALLBACK is an error of the RPM signal, not a result of the load', () => {
    const g1 = f({ module: 'gov', id: 'G1', profile: null, value: 1, log: 14, times: [193.686], text: '1 FALLBACK entry at 193.686 s (0.213 s long). RPM signal lost or glitching' });
    const g20 = (kind) => f({ module: 'rescue', id: 'G20', severity: 'note', profile: null, log: 14, value: kind === 'overload' ? 1 : 0, n: 1, events: [{ kind, start: 193.686, causes: kind === 'overload' ? ['overload'] : ['signal', 'overload'] }] });
    const g1s = (o) => o.recommendations.filter(x => /^G1(:|$)/.test(x.id)).map(x => [x.id, x.severity]);
    assert.deepEqual(g1s(run([g1, g20('overload')])), [['G1', 'check'], ['G1:overload', 'watch']]);
    assert.deepEqual(g1s(run([g1, g20('signal')])), [['G1', 'check']], 'a sudden change before the FALLBACK: no overload context');
});

// findings in the shape that health_limits.cjs judge gives them
const LM = (id, ch, o) => f(Object.assign({ module: 'limits', id, channel: ch, unit: 's', phase: 'flight', thin: false, se: null, log: 14, profile: 2, limits: { lo: null, hi: 1000, source: 'firmware' } }, o));
test('L1-L7: one item for each output and PID profile with its periods; a problem is a check, a short period alone a watch; never CLI', () => {
    const ev = (tS, t1S, o) => Object.assign({ t: tS, t1: t1S, tS, t1S, seconds: +(t1S - tS).toFixed(3), phase: 'flight', rescue: null, with: [] }, o);
    const thr = LM('L1', 'throttle', { value: 2.486, n: 3, longestS: 1.419, combined: true, with: ['collectiveCommand'],
        events: [ev(149.61, 151.03), ev(135.04, 135.85, { with: ['collectiveCommand'] }), ev(193.32, 193.58, { rescue: 'before rescue', with: ['collectiveCommand', 'tail'] })] });
    const tail = LM('L4', 'tail', { axis: 'yaw', severity: 'note', value: 0.03, n: 1, longestS: 0.03, limits: { lo: -1517, hi: 1021, source: 'T8' }, events: [ev(105.7, 105.73, { rescue: 'rescue' })] });
    const sv = LM('L5', 'servo[3]', { axis: 'yaw', value: 0.4, n: 1, longestS: 0.4, events: [ev(9.93, 10.33)] }), cyc = LM('L5', 'servo[0]', { value: 0.4, n: 1, longestS: 0.4, events: [ev(9.93, 10.33)] });
    const out = run([thr, tail, sv, cyc, LM('L7', 'collectiveCommand', { value: 0.737, n: 2, longestS: 0.369, events: [ev(135.04, 135.41)] }), LM('L6', 'iterm roll', { axis: 'roll', value: 0.2, n: 1, longestS: 0.2, events: [ev(15, 15.2)] })]);
    const r1 = only(out, 'L1:throttle'), r4 = only(out, 'L4:tail'), r5 = only(out, 'L5:servo[3]'), r5c = only(out, 'L5:servo[0]'), r7 = only(out, 'L7'), r6 = only(out, 'L6');
    assert.deepEqual([r1.node, r1.severity, r1.cli], ['governor', 'check', []]);
    assert.match(r1.text.split('\n')[1], /^The throttle is at its limit in 3 periods, for a total of 2\.486 s \(log 14, PID profile 2\)\. In log 14, the period from 149\.61 s to 151\.03 s is 1\.42 s long, in flight\./);
    assert.match(r1.text, /from 193\.32 s to 193\.58 s is 0\.26 s long, in flight, before a rescue\./);
    assert.match(r1.text, /Other outputs are at their limits at the same time: collective stick\./);
    assert.match(r1.procedure.steps.join(' '), /If headspeed falls before full throttle, examine the governor response/);
    assert.deepEqual([r4.node, r4.severity, r4.axis], ['tailcomp', 'watch', 'yaw']);
    assert.match(r4.text, /If the output stays at its limit with a yaw error, examine the tail pitch range and linkage/);
    assert.deepEqual([r5.node, r5c.node, r7.node, r6.node], ['tailcomp', 'cyclic', 'controller', 'cyclic'], 'the tail servo with the tail authority; a cyclic servo and the roll I-term with the cyclic gains; the collective command with the flight controller (the radio)');
    for (const r of [r1, r4, r5, r5c, r7, r6]) { assert.deepEqual(r.cli, [], r.id); assert.doesNotMatch(r.text, /gear|pulley|teeth/i, `${r.id}: gear rule`); }
    // the tail at its limit is the possible first cause of a tail kick at the rescue that comes after it (K24)
    const kick = RS('T15', { value: 138, peak: 231, base: 93, atLimitS: 0.02, axis: 'yaw', log: 14, profile: 2, onsets: [{ t: 105.69, tS: 105.69 }],
        evidence: { spans: [{ log: 14, t0: 105.04, t1: 107.04 }] } });
    const lim = Object.assign(LM('L4', 'tail', { axis: 'yaw', value: 0.2, n: 1, longestS: 0.2, events: [ev(105.6, 105.8)] }), { evidence: { spans: [{ log: 14, t0: 105.1, t1: 106.3 }] } });
    assert.deepEqual(only(run([kick, lim]), 'T15').causes.map(c => c.rule), ['K24'], 'K24: the limit starts before the error, inside the window of the rescue');
    const late = Object.assign(LM('L4', 'tail', { axis: 'yaw', value: 0.2, n: 1, longestS: 0.2, events: [ev(106.5, 106.7)] }), { evidence: { spans: [{ log: 14, t0: 106.0, t1: 107.2 }] } });
    assert.deepEqual(only(run([kick, late]), 'T15').causes.map(c => c.rule), [], 'K24 needs the limit before the error');
});

// user, 2026-10-16: a rate that the helicopter cannot get to with the output at its limit (health_limits stuck.unreached): the full-stick
// rate of the rate profile to that rate or less, as text (the rate curve depends on rates_type)
test('L4 stuck at a setpoint that the helicopter cannot get to: decrease the maximum rate of the rate profile, no CLI', () => {
    const ev = { t: 45, t1: 45.3, tS: 45, t1S: 45.3, seconds: 0.3, phase: 'flight', rescue: null, with: [] };
    const stuck = { kind: 'rate', axis: 'yaw', start: 100, end: 100, sp: 300, gyro: 200, limit: 30, stuck: true, tS: 45, t1S: 45.3, seconds: 0.3, unreached: true };
    // 3 periods at +300 deg/s (the gyro 200, 250 and 260 at the end) and 1 at -300 deg/s (280): the median of the lower direction, 250 deg/s
    const at = (sp, gyro, t) => Object.assign({}, ev, { tS: t, t1S: t + 0.3, trend: Object.assign({}, stuck, { sp, gyro }) });
    const events = [at(300, 200, 45), at(300, 260, 50), at(300, 250, 55), at(-300, -280, 60), Object.assign(at(300, 50, 65), { seconds: 0.05 })];
    const r = only(run([LM('L4', 'tail', { axis: 'yaw', severity: 'flag', value: 1.25, n: 5, longestS: 0.3, events, stuck })]), 'L4:tail');
    assert.equal(r.severity, 'check'); assert.deepEqual(r.cli, []);
    assert.match(r.text, /In 4 periods at the limit, the gyro rate does not move to the setpoint, and the setpoint is up to 300 deg\/s\. The helicopter cannot get to this yaw rate\./);
    assert.match(r.text, /For a positive setpoint, the gyro rate at the end is 200 to 260 deg\/s \(median 250 deg\/s, 3 periods\)\. Decrease the maximum yaw rate of the rate profile to 250 deg\/s or less\./);
    assert.match(r.rule, /is a problem if the gyro rate does not move to the setpoint, or the headspeed to the target/);
    const calm = Object.assign({}, stuck, { sp: 0, gyro: 150, unreached: false }), kick = only(run([LM('L4', 'tail', { axis: 'yaw', severity: 'flag', value: 0.3, n: 1, longestS: 0.3, events: [Object.assign({}, ev, { trend: calm })], stuck: calm })]), 'L4:tail');
    assert.doesNotMatch(kick.text, /maximum yaw rate/, 'a yaw rate at a setpoint of 0: no rate change');
});

// coordinator, round 2: a FALLBACK with no rescue can also be an overload (check G20 of health_rescue.cjs, Fireball 2026-10-05 log 12)
test('L1 distinguishes an inferred throttle plateau from a confirmed maximum', () => {
    const plateau = LM('L1', 'throttle', { value: 0.33, n: 1,
        limits: { lo: null, hi: 932, source: 'data' },
        throttleLimit: { value: 932, source: 'data', estimated: true },
        events: [{ t: 154.24, t1: 154.57, tS: 154.24, t1S: 154.57, seconds: 0.33, limit: 932 }] });
    const rec = only(run([plateau]), 'L1:throttle');
    assert.equal(rec.title, 'Examine the throttle limit');
    assert.match(rec.text, /These periods do not show full throttle/);
    assert.equal(rec.procedure.title, 'Examine the throttle limit before you increase governor gains.');
    assert.match(rec.procedure.steps[0], /Compare the governor maximum throttle/);
    assert.deepEqual(rec.cli, []);
});

test('G1 at an overload of G20 with no rescue (rule K22): all FALLBACKs retain RPM validation', () => {
    const g1 = f({ module: 'gov', id: 'G1', profile: null, value: 2, log: 11, times: [54.622], text: '2 FALLBACK entries at 54.622 s (0.203 s long, headspeed 4529, max 5015, 0 glitch-proxy samples within 0.5 s); 159.549 s (0.204 s long, headspeed 5029). RPM signal lost or glitching' });
    const ev = (start, kind) => ({ t: start - 0.2, t1: start + 0.05, start, tS: start - 0.014, kind, value: kind === 'overload' ? 0.05 : null, bad: kind !== 'overload' });
    const g20 = (kinds) => f({ module: 'rescue', id: 'G20', severity: 'note', profile: null, log: 11, value: kinds.filter(k => k === 'overload').length, n: kinds.length, unit: 'count', events: [ev(54.622, kinds[0]), ev(159.549, kinds[1])] });
    const both = run([g1, g20(['overload', 'overload'])]), r = both.recommendations.filter(x => /^G1(:|$)/.test(x.id));
    assert.deepEqual(r.map(x => [x.id, x.severity]), [['G1','check'],['G1:overload','watch']]);
    const context = r.find(x => x.id === 'G1:overload');
    assert.deepEqual(context.causes.map(c => [c.rule, c.ids, c.holds]), [['K22', ['G20'], false]]);
    assert.ok(context.evidence.some(e => e.id === 'G20'), 'the G20 rows are evidence');
    if (H) assert.equal(H.status([g1, g20(['overload', 'overload'])], both.recommendations, {}).nodes.rpm.status, 'problem', 'coincident overload cannot verify the RPM signal');
    // one of the two FALLBACKs with no overload sign: a problem of the RPM signal (the times of the text count, not only the first)
    const one = run([g1, g20(['overload', 'signal'])]);
    assert.deepEqual(one.recommendations.filter(x => /^G1(:|$)/.test(x.id)).map(x => [x.id, x.severity]), [['G1', 'check']]);
    if (H) assert.equal(H.status([g1, g20(['overload', 'signal'])], one.recommendations, {}).nodes.rpm.status, 'problem');
});

// SPEC3 F: a recommendation says what the helicopter does, why it matters, the number against its limit, then the change and
// its expected effect (one paragraph each); C10 "landed" is information only
test('SPEC3 F: the text of a change is symptom, why, number, change and effect; the user example C14 in degrees', () => {
    const c14 = f({ module: 'more', id: 'C14', axis: 'pitch', profile: 1, value: 124, se: 26, n: 12, gainChange: 62, gainChangeSe: 13, unit: 'per 1000 collective', text: 'c14' });
    const r = run([c14], { header: Object.assign({}, HEADER, { pitch_compensation: 10 }) }).recommendations.find(x => /^C14:pitch_collective_ff_gain/.test(x.id)), p = r.text.split('\n');
    assert.equal(p.length, 3, r.text);
    assert.equal(p[0], 'When the collective changes, the helicopter pitches, and the pitch I-term must correct it. The I-term corrects slowly. Thus, the helicopter pitches for a short time after each collective change.');
    assert.match(p[1], /^For each 1 deg of collective, the pitch I-term and O-term add 0\.124 ± 0\.026 deg of cyclic pitch/);
    assert.doesNotMatch(r.text, /1000 units|2 SE test/, 'no internal quantity without its meaning');
    // round 3 M5: the full measured correction and the step
    assert.match(p[2], /^The full change is an increase of 62\. Make the change in steps\. Set pitch_collective_ff_gain on PID profile 1 from 10 to 12 \(.*\)\. After the flight, do the analysis again\. This change can decrease the pitch movement after a collective change\. The next flight must measure this effect\.$/);
    // a check: symptom and why first, no effect sentence
    const t8 = only(run([f({ id: 'T8', value: 4, text: '60 episodes, 4.07 s at an output limit (mixer[2], servo[3])' })]), 'T8');
    assert.match(t8.text, /^The tail output stays at its limit\./); assert.doesNotMatch(t8.text, /calibrat/i);
    // C10 landed while at flight speed: information, never a problem or a watch ("not a bug, just slow to take off")
    const landed = only(run([f({ id: 'C10', value: 2, text: '2 s with the rotor at speed while the firmware says landed' })]), 'C10:landed');
    assert.equal(landed.severity, 'info'); assert.match(landed.text, /This is not a problem\. The helicopter only becomes airborne slowly after the spool-up\./);
});

// ---------------------------------------------------------------------------------------------
// Round 3 M1: the configurations of the worker (datasets.cjs datasets(), input.datasets, f.dataset)
// ---------------------------------------------------------------------------------------------

const J = (v) => JSON.stringify(v);
const within = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);
// a configuration of datasets.cjs as the worker gives it (result.datasets: dsResult)
const DSC = (id, pidProfile, values, sources = {}, o = {}) => Object.assign({ id, pidProfile, values, sources: Object.assign(Object.fromEntries(Object.keys(values).map(k => [k, 'header'])), sources),
    logs: [5], assumedFrom: [], analysedSeconds: 120, analysedFlightSeconds: 100, label: `Configuration ${id}` }, o);
const DSET = (list, newestByProfile, o = {}) => Object.assign({ datasets: list, newest: list[list.length - 1].id, newestByProfile, labels: [], diff: [], pairs: [], info: [], notes: [] }, o);

test('round 3 M1: the from-value comes from the newest configuration of the PID profile, with its source; estimate, none and an assumed header give no CLI', () => {
    const at = (values, sources, o) => advice.advise({ findings: [Object.assign({}, C3UP, { dataset: 'B' })], decisions: null, header: HEADER, cli: null, logs: LOGS, fields: null, headerProfile: 1, headerLog: 5, logBase: 1,
        datasets: DSET([DSC('A', 1, { roll_f_gain: 100 }), DSC('B', 1, values, sources, o)], { 1: 'B' }) }).recommendations.find(r => r.id.startsWith('C3'));
    // the newest configuration B has roll_f_gain 110 from a log header: the step starts there, with CLI text
    const r = at({ roll_f_gain: 110 });
    assert.deepEqual([r.from, r.dataset, r.cli[0]], [110, 'B', 'profile 0']);
    assert.ok(r.to > 110 && r.to <= 132 && r.cli[1] === `set roll_f_gain = ${r.to}`, J(r.cli));
    assert.match(r.fromSource, /^configuration B, the newest of PID profile 1, log header of log 6$/);
    // no source shows the value: unknown, no CLI
    const none = at({ roll_f_gain: null }, { roll_f_gain: 'none' });
    assert.deepEqual([none.from, none.cli], [null, []]);
    assert.ok(none.caveats.some(c => /No log header gives the value of roll_f_gain in the newest configuration of PID profile 1\. Thus, there is no CLI text\. The log header records the values of PID profile 1 only when a new log starts in PID profile 1\./.test(c)), J(none.caveats));
    assert.ok(!none.caveats.some(c => /CLI dump|diff all/.test(c)), 'no CLI dump: no text asks for one (user rule 2026-10-06)');
    // a header of a log whose PID profile at arming is only an estimate: the value as an estimate, no CLI
    const est = at({ roll_f_gain: 110 }, { roll_f_gain: 'estimate' });
    assert.deepEqual([est.from, est.cli], [110, []]);
    assert.ok(est.caveats.some(c => /is only an estimate/.test(c)), J(est.caveats));
    // the header of the nearest log armed in the PID profile: CLI text only when the logs before and after it agree (bracketed)
    const far = at({ roll_f_gain: 110 }, { roll_f_gain: 'log 3' }, { assumedFrom: [{ log: 5, from: 3, bracketed: false }] });
    assert.deepEqual([far.from, far.cli], [110, []]);
    const near = at({ roll_f_gain: 110 }, { roll_f_gain: 'log 3' }, { assumedFrom: [{ log: 5, from: 3, bracketed: true }] });
    assert.deepEqual([near.from, near.cli.length], [110, 2]); assert.match(near.fromSource, /log header of log 4$/);
    // without configurations: the rules before (the analysed log header)
    assert.equal(run([C3UP]).recommendations.find(x => x.id.startsWith('C3')).from, 100);
    assert.deepEqual([run([C3UP]).recommendations.find(x => x.id.startsWith('C3')).dataset, run([C3UP]).recommendations.find(x => x.id.startsWith('C3')).ab], [null, []]);
});

// review IMP-05: a value of the parameter snapshot (datasets source 'log snapshot') or of a recorded journal change ('log journal') is a
// recorded value with CLI text. A D4 difference of a snapshot row of PID profile 2 makes the CLI value stale for PID profile 2 only
test('a value of the parameter snapshot or of the journal: a from-value with CLI text; a D4 snapshot row is stale for its PID profile only', () => {
    const at = (values, sources, extra = {}) => advice.advise(Object.assign({ findings: [Object.assign({}, C3UP, { dataset: 'B' })], decisions: null, header: HEADER, cli: null, logs: LOGS, fields: null, headerProfile: 1, headerLog: 5, logBase: 1,
        datasets: DSET([DSC('A', 1, { roll_f_gain: 100 }), DSC('B', 1, values, sources)], { 1: 'B' }) }, extra)).recommendations.find(r => r.id.startsWith('C3'));
    const snap = at({ roll_f_gain: 110 }, { roll_f_gain: 'log snapshot' });
    assert.deepEqual([snap.from, snap.cli[0]], [110, 'profile 0']); assert.match(snap.fromSource, /^configuration B, the newest of PID profile 1, the parameter values of the log header of log 6$/);
    const jr = at({ roll_f_gain: 120 }, { roll_f_gain: 'log journal' });
    assert.deepEqual([jr.from, jr.cli[0]], [120, 'profile 0']); assert.match(jr.fromSource, /a parameter change that the log records$/);
    // a CLI value of PID profile 1 and a D4 snapshot difference of the same name in PID profile 2: the value of PID profile 1 stays usable
    const d4 = f({ module: 'setup', id: 'D4', profile: null, value: 1, basis: 'snapshot', mismatches: [{ where: 'profile 1', name: 'roll_f_gain', pidProfile: 2, rateProfile: null, logValue: 90, cliValue: 80, from: 'cli', match: false }], text: 'd4' });
    const cli = setup.parseCli(CLI_TEXT.replace('profile 0\n', 'profile 0\nset roll_f_gain = 105\n'));
    const viaCli = at({ roll_f_gain: 105 }, { roll_f_gain: 'cli' }, { cli, findings: [Object.assign({}, C3UP, { dataset: 'B' }), d4] });
    assert.equal(viaCli.from, 105, J(viaCli.caveats));
    const d4p1 = f(Object.assign({}, d4, { fid: 'd4p1', mismatches: [Object.assign({}, d4.mismatches[0], { pidProfile: 1, where: 'profile 0' })] }));
    const stale = at({ roll_f_gain: 105 }, { roll_f_gain: 'cli' }, { cli, findings: [Object.assign({}, C3UP, { dataset: 'B' }), d4p1] });
    assert.deepEqual([stale.from, stale.cli], [null, []], 'the D4 row of PID profile 1: the CLI value of PID profile 1 is not used');
});

test('configuration-specific advice can tune an absolute recorded LUA adjustment without treating it as an estimate', () => {
    const input={configurationId:'B',findings:[{...C3UP,dataset:'B'}],header:HEADER,headerProfile:1,headerLog:5,logs:LOGS,logBase:1,
        datasets:DSET([DSC('B',1,{roll_f_gain:110},{roll_f_gain:'adjustment'})],{1:'B'})};
    const scoped=advice.advise(input).recommendations.find(r=>r.id.startsWith('C3'));
    assert.equal(scoped.from,110);assert.ok(scoped.cli.includes('set roll_f_gain = '+scoped.to));
    assert.equal(scoped.fromSource,'recorded configuration B, in-flight adjustment');
    const unscoped=advice.advise({...input,configurationId:null}).recommendations.find(r=>r.id.startsWith('C3'));
    assert.deepEqual(unscoped.cli,[],'an old adjustment does not establish the current value outside its recorded configuration');
});

// C14 in three configurations that differ only in pitch_collective_ff_gain (10, 20, 30): the result decreases by 4 for each 1
const C14DS = (ds, value, o = {}) => f(Object.assign({ module: 'more', id: 'C14', axis: 'pitch', profile: 1, pidProfile: 1, value, se: 10, n: 12, gainChange: value / 2, gainChangeSe: 5, unit: 'per 1000 collective', text: 'c14', dataset: ds }, o));
const C14SET = (newest) => DSET([DSC('A', 1, { pitch_collective_ff_gain: 10 }), DSC('B', 1, { pitch_collective_ff_gain: 20 }), DSC('C', 1, { pitch_collective_ff_gain: 30 })], { 1: newest });
test('round 3 M1: A/B pairs of the configurations that differ in a few parameters, and the measured slope inside its range (2 SE)', () => {
    const go = (newest, list) => run(list || [C14DS('A', 124), C14DS('B', 84), C14DS('C', 44)], { datasets: C14SET(newest), logBase: 1 }).recommendations.find(r => /^C14:pitch_collective_ff_gain/.test(r.id));
    const r = go('B');
    assert.deepEqual([r.dataset, r.supportedBy, r.from], ['B', ['A', 'B', 'C'], 20]);
    assert.deepEqual(r.ab.map(q => [q.a, q.b, q.names, q.significant]).sort(), [['A', 'B', ['pitch_collective_ff_gain'], true], ['A', 'C', ['pitch_collective_ff_gain'], true], ['B', 'C', ['pitch_collective_ff_gain'], true]]);
    assert.ok(r.ab.every(q => q.check === 'C14' && Math.abs(q.delta) >= 2 * q.se), J(r.ab));
    const ab = r.ab.find(q => q.a === 'A' && q.b === 'B');
    within(ab.delta, -40, 1e-9, 'B - A'); within(ab.se, Math.sqrt(200), 1e-3, 'the SE of a difference');
    assert.match(ab.text, /^Configurations A and B are different only in `pitch_collective_ff_gain` 10 against 20\. Check C14 gives .* in configuration A and .* in configuration B\. The difference is .*, more than 2 SE\./);
    // the slope: -4 for each 1 of the gain, from 3 configurations; the change 20 -> 24 is inside 10 to 30
    assert.ok(r.slope && r.slope.name === 'pitch_collective_ff_gain', J(r.slope));
    within(r.slope.perUnit, -4, 1e-6, 'slope'); assert.deepEqual([r.slope.datasets, r.slope.range], [['A', 'B', 'C'], [10, 30]]);
    within(r.slope.change, -4 * (r.to - r.from), 1e-6, 'the predicted change of the result');
    assert.match(r.text, /In configurations A, B and C, check C14 changes by .* for each 1 of `pitch_collective_ff_gain`\. The slope gives an estimate of .* for a step from 20 to 24\. This is not a measured response to that step\./);
    assert.ok(r.sources.some(s => /2 SE or more, and a slope only inside the range/.test(s)), J(r.sources));
    // the newest configuration C at the end of the range: 30 -> 36 is out of it, so no slope, and the text says why
    const out = go('C');
    assert.equal(out.slope, null); assert.match(out.text, /The measured slope of check C14 is for `pitch_collective_ff_gain` from 10 to 30\. The change goes out of this range, thus the app does not use the slope\./);
    // two configurations with no difference by 2 SE
    const flat = go('B', [C14DS('A', 84), C14DS('B', 80), C14DS('C', 82)]);
    assert.ok(flat.ab.length && flat.ab.every(q => !q.significant) && /not more than 2 SE\. These logs cannot identify an effect of these parameters on this result\./.test(flat.text), flat.text);
});

test('round 3 M1: a problem only in older configurations while the newest one is satisfactory is a watch with no CLI text', () => {
    const list = [C14DS('A', 124), C14DS('B', 120), C14DS('C', 30, { severity: 'ok' })];   // the pooled estimate 91 ± 31 clears 20 by 2 SE
    const r = run(list, { datasets: C14SET('C'), logBase: 1 }).recommendations.find(x => /^C14:pitch_collective_ff_gain/.test(x.id));
    assert.deepEqual([r.severity, r.cli, r.dataset, r.supportedBy], ['watch', [], 'C', ['A', 'B']]);
    assert.ok(r.caveats.some(c => c === 'The problem is only in configurations A and B, and the newest configuration C has a satisfactory result. Thus, there is no CLI text. A new flight with the newest configuration gives a new result.'), J(r.caveats));
    assert.match(r.text, /The newest configuration C has a result with no problem\./);
    // the newest configuration with no result of the check: an action, and the text says so
    const n = run([C14DS('A', 124), C14DS('B', 84)], { datasets: C14SET('C'), logBase: 1 }).recommendations.find(x => /^C14:pitch_collective_ff_gain/.test(x.id));
    assert.equal(n.severity, 'action'); assert.match(n.text, /The newest configuration C has no result of this check\./);
});

test('round 3 M1: comparisons: the results of the checks that the parameters change, the periods at an output limit for each minute, no SE gives no test', () => {
    const ds = DSET([DSC('E', null, { yaw_cw_stop_gain: 120, yaw_ccw_stop_gain: 80, yaw_p_gain: 100 }, {}, { analysedFlightSeconds: 30, analysedSeconds: 60 }),
        DSC('F', null, { yaw_cw_stop_gain: 140, yaw_ccw_stop_gain: 100, yaw_p_gain: 100 }, {}, { analysedFlightSeconds: 30, analysedSeconds: 60 })], { unknown: 'F' });
    const F = [f({ id: 'T8', profile: 0, value: 1.2, n: 40, dataset: 'E' }), f({ id: 'T8', profile: 0, value: 0.6, n: 10, dataset: 'F' }),
        f({ module: 'limits', id: 'L4', axis: 'yaw', profile: 0, value: 1, n: 20, dataset: 'E' }), f({ module: 'limits', id: 'L4', axis: 'yaw', profile: 0, value: 1.1, n: 22, dataset: 'F' }),
        f({ module: 'track', id: 'T11', axis: 'yaw', severity: 'note', thin: true, profile: 0, value: 0.29, n: 2, dataset: 'E' }), f({ module: 'track', id: 'T11', axis: 'yaw', severity: 'note', thin: true, profile: 0, value: 0.2, n: 2, dataset: 'F' }),
        f({ module: 'setup', id: 'F6', profile: 0, value: 14, se: 0.3, dataset: 'E' }), f({ module: 'setup', id: 'F6', profile: 0, value: 23, se: 1.2, dataset: 'F' })];
    const [c] = advice.comparisons(F, ds);
    assert.deepEqual([c.a, c.b, c.names, c.values], ['E', 'F', ['yaw_cw_stop_gain', 'yaw_ccw_stop_gain'], { yaw_cw_stop_gain: [120, 140], yaw_ccw_stop_gain: [80, 100] }]);
    const by = Object.fromEntries(c.results.map(x => [`${x.check}|${x.axis || ''}`, x]));
    // T8: 40 periods in 0.5 min of flight = 80 ± sqrt(40) / 0.5, against 10 periods = 20 ± sqrt(10) / 0.5: different by 2 SE
    within(by['T8|'].a.mean, 80, 1e-9, 'T8 E'); within(by['T8|'].a.se, Math.sqrt(40) / 0.5, 1e-9, 'T8 E SE'); within(by['T8|'].b.mean, 20, 1e-9, 'T8 F');
    assert.deepEqual([by['T8|'].relevant, by['T8|'].rate, by['T8|'].testable, by['T8|'].significant, by['T8|'].unit], [true, true, true, true, 'periods for each minute of flight']);
    // L4 over all the time (1 min): 20 against 22 periods for each minute, not different
    assert.deepEqual([by['L4|yaw'].significant, by['L4|yaw'].unit], [false, 'periods for each minute']);
    // T11 with not sufficient data: no SE, no test, and the text says so; F6 is not a check of the stop gains: in the results, not in the text
    assert.deepEqual([by['T11|yaw'].testable, by['T11|yaw'].thin], [false, true]); assert.match(by['T11|yaw'].text, /These results have no SE\. Thus, the app cannot do the 2-SE test/);
    assert.equal(by['F6|'].relevant, false);
    assert.equal(c.text, 'Configurations E and F are different only in `yaw_cw_stop_gain` 120 against 140 and `yaw_ccw_stop_gain` 80 against 100. 2 results of the checks that these parameters change have an SE. Of these, 1 is different by 2 SE or more: check T8. Other conditions of the flights can also change a result, for example the maneuvers and the battery.');
    assert.deepEqual(advice.comparisons(F, null), [], 'no configurations: no comparison');
});

// ---------------------------------------------------------------------------------------------
// Round 3 M2: the filter search (filter_tune.cjs tune() of the worker command filterTune)
// ---------------------------------------------------------------------------------------------

const FT_RES = (o = {}) => Object.assign({ recommended: Object.assign({ status: 'recommended', reasons: [], rows: [
    { name: 'feature DYN_NOTCH', from: false, to: true, source: 'header', scope: 'global' }, { name: 'dyn_notch_count', from: '6', to: '2', source: 'header', scope: 'global' },
    { name: 'dyn_notch_q', from: '25', to: '40', source: 'header', scope: 'global' }, { name: 'roll_d_cutoff', from: 15, to: 12, source: 'cli', scope: 'profile', profile: 1 }],
    predicted: { totalDb: -7, se: 0.5 }, delay: { maxAddMs: 0.3 } }, o.recommended || {}), model: Object.assign({ passed: true, parity: [{ log: 0, passed: true, axes: {} }] }, o.model || {}),
    current: { settings: Object.assign({ gyro_lpf1_type: 1, gyro_lpf1_static_hz: 100, gyro_lpf2_type: 0, gyro_lpf2_static_hz: 0, gyro_notch1_hz: 0, gyro_notch1_cutoff: 0 }, o.settings || {}) } }, o.extra || {});
const FT_TEXTS = { status: 'recommended', summary: 'The summary.', recommendation: 'The set.', delay: 'The time delay.', validation: 'The test.', parity: 'The model agrees.', why: [],
    rows: [{ name: 'feature DYN_NOTCH', scope: 'global', text: 'Set `feature DYN_NOTCH` on.' }, { name: 'dyn_notch_count', scope: 'global', text: 'Set `dyn_notch_count` from 6 to 2.' },
        { name: 'dyn_notch_q', scope: 'global', text: 'Set `dyn_notch_q` from 25 to 40.' }, { name: 'roll_d_cutoff', scope: 'profile', profile: 1, text: 'Set `roll_d_cutoff` in PID profile 1 from 15 to 12.' }] };
test('filter replay export reports the chosen delay limit and the actual manual or autotune acceptance rule', () => {
    for(const mode of ['simulation','autotune']){
        const res=FT_RES({extra:{version:2,mode,limits:{maxAddMs:2}}});
        const recs=advice.filterRecommendations(res,{texts:FT_TEXTS});
        assert.ok(recs.every(r=>r.severity==='action'));
        const script=advice.exportScript(recs,advice.defaultPicks(recs));
        assert.match(script,/maximum added time delay is 2 ms/);
        if(mode==='simulation')assert.doesNotMatch(script,/decrease by 3 dB|80 %/);
        else assert.match(script,/decrease by 3 dB/);
    }
});
test('round 3 M2: the filter search gives an action only when it recommends the set and the model agrees; the global and PID profile parts export together', () => {
    const recs = advice.filterRecommendations(FT_RES(), { texts: FT_TEXTS, cli: true, cliName: 'dump.txt' });
    assert.deepEqual(recs.map(r => [r.id, r.severity, r.scope, r.profile, r.group, r.groupSize, r.node, r.area, r.confidence]),
        [['F:filters', 'action', 'global', null, 'F:filters', 2, 'filters', 'filters', 'predicted'], ['F:filters:p1', 'action', 'profile', 1, 'F:filters', 2, 'filters', 'filters', 'predicted']]);
    assert.deepEqual(recs[0].cli, ['feature DYN_NOTCH', 'set dyn_notch_count = 2', 'set dyn_notch_q = 40']);
    assert.deepEqual(recs[1].cli, ['profile 0', 'set roll_d_cutoff = 12']);
    assert.deepEqual(recs[0].fromSets, { 'feature DYN_NOTCH': false, dyn_notch_count: '6', dyn_notch_q: '25' });
    assert.deepEqual([recs[0].fromSource, recs[1].fromSource], ['log header', 'CLI dump "dump.txt"']);
    assert.match(recs[0].text, /^The summary\.\nThe set\.\nThe time delay\.\nThe test\.\nThe model agrees\.\nSet `feature DYN_NOTCH` on\. Set `dyn_notch_count` from 6 to 2\. Set `dyn_notch_q` from 25 to 40\.\nThe replay estimates the change of vibration with these values\. A new flight must measure the response\.$/);
    assert.match(recs[0].rule, /^The app recommends a set of filter values only if the filter model agrees with the recorded gyroADC \(1 dB, 0\.3 ms\)\. .* Sources: "/);
    // the export: the feature line first in the global values, the PID profile part as `profile 0`; the group goes in together or not at all
    const text = advice.exportScript(recs, null, { logBase: 1 }), cmd = text.split('\n').filter(l => l && !l.startsWith('#'));
    assert.deepEqual(cmd, ['batch start', 'profile 0', 'set roll_d_cutoff = 12', 'feature DYN_NOTCH', 'set dyn_notch_count = 2', 'set dyn_notch_q = 40', 'save']);
    assert.match(text, /#   `feature DYN_NOTCH`: on \(it is off at this time\)\./);
    assert.match(advice.exportScript(recs, ['F:filters'], {}), /It is 1 of 2 changes that the model makes together/);
    assert.deepEqual(advice.defaultPicks(recs), ['F:filters', 'F:filters:p1']);
    // a feature that 4.6 does not have, or a feature line in a PID profile part, is not written
    const bad = Object.assign({}, recs[0], { id: 'X', group: null, groupSize: null, cli: ['feature FOO'] });
    assert.match(advice.exportScript([bad], ['X'], {}), /`FOO` is not a feature of Rotorflight 4\.6\./);
    assert.ok(advice.FEATURE_NAMES.includes('DYN_NOTCH') && advice.FEATURE_NAMES.includes('RPM_FILTER') && advice.FEATURE_NAMES.length === 19);
    // blocked by a gate of the diagram: the actions keep their values, with no CLI text
    const held = advice.filterRecommendations(FT_RES(), { texts: FT_TEXTS, cli: true, blockedBy: ['The RPM signal has a problem.'] });
    assert.ok(held.every(r => r.severity === 'action' && !r.cli.length && r.blockedBy.length === 1), J(held.map(r => r.cli)));
});

test('round 3 M2: no action when the search does not recommend, when the model does not agree, or when a value fails a guard (each says why)', () => {
    const one = (res, meta = {}) => { const l = advice.filterRecommendations(res, Object.assign({ texts: FT_TEXTS, cli: true }, meta)); assert.equal(l.length, 1, J(l.map(r => r.id))); return l[0]; };
    const notRec = one(FT_RES({ recommended: { status: 'not recommended' } }), { texts: Object.assign({}, FT_TEXTS, { why: ['The best set decreases the vibration by only 0.6 dB. A decrease of 3 dB or more is necessary.'] }) });
    assert.deepEqual([notRec.id, notRec.severity, notRec.cli, notRec.title], ['F:filters', 'check', [], 'Filter values from the flight logs: no change (to examine)']);
    const noModel = one(FT_RES({ model: { passed: false } }), { cli: false });
    assert.equal(noModel.severity, 'check');
    assert.ok(!noModel.caveats.some(c => /CLI dump|diff all/.test(c)), 'without a CLI dump no caveat asks for one (user rule 2026-10-06): ' + J(noModel.caveats));
    const lpfOff = one(FT_RES({ recommended: { rows: [{ name: 'gyro_lpf1_type', from: 'FIRST_ORDER', to: 'NONE', source: 'header', scope: 'global' }] } }));
    assert.ok(lpfOff.severity === 'check' && lpfOff.caveats.some(c => /The set has no gyro low-pass filter\./.test(c)), J(lpfOff.caveats));
    const lowQ = one(FT_RES({ recommended: { rows: [{ name: 'gyro_notch1_hz', from: '0', to: '200', source: 'header', scope: 'global' }, { name: 'gyro_notch1_cutoff', from: '0', to: '100', source: 'header', scope: 'global' }] } }));
    assert.ok(lowQ.caveats.some(c => /The static notch filter 1 has a Q of 0\.67, less than 2\./.test(c)), J(lowQ.caveats));   // 200 x 100 / (200² - 100²)
    const range = one(FT_RES({ recommended: { rows: [{ name: 'dyn_notch_count', from: '6', to: '9', source: 'header', scope: 'global' }] } }));
    assert.ok(range.caveats.some(c => /The value 9 of `dyn_notch_count` is not in its firmware range/.test(c)), J(range.caveats));
    const unknown = one(FT_RES({ recommended: { rows: [{ name: 'dyn_notch_q', from: '25', to: '40', source: 'default', scope: 'global' }] } }));
    assert.ok(unknown.caveats.some(c => /The value of `dyn_notch_q` at this time is unknown/.test(c)), J(unknown.caveats));
    const noProfile = one(FT_RES({ recommended: { rows: [{ name: 'yaw_d_cutoff', from: 20, to: 15, source: 'cli', scope: 'profile', profile: null }] } }));
    assert.ok(noProfile.caveats.some(c => /PID profile unknown/.test(c)), J(noProfile.caveats));
    // the new names: in PARAMS with the scope of settings.c and a firmware range
    for (const [k, sc, lim] of [['dyn_notch_count', 'global', [0, 8]], ['dyn_notch_min_hz', 'global', [10, 200]], ['dyn_notch_max_hz', 'global', [100, 500]], ['gyro_notch1_hz', 'global', [0, 1000]],
        ['gyro_notch2_cutoff', 'global', [0, 1000]], ['roll_d_cutoff', 'profile', [0, 250]], ['yaw_gyro_cutoff', 'profile', [0, 250]], ['gyro_lpf2_type', 'global', undefined]])
        assert.deepEqual([advice.PARAMS[k][0], advice.RANGE[k]], [sc, lim], k);
});

test('configuration export restores the selected LUA variant and rejects mixed alternatives for a PID profile', () => {
    const ds={datasets:[{id:'A',pidProfile:1,values:{roll_p_gain:50}},{id:'B',pidProfile:1,values:{roll_p_gain:70}}],newestByProfile:{1:'B'},diff:[{name:'roll_p_gain'}]};
    advice.configurationBases(ds);
    assert.equal(ds.datasets[0].exportBase.records[0].to,50);assert.equal(ds.datasets[1].exportBase.records.length,0);
    const base=ds.datasets[0].exportBase.records[0];
    assert.match(advice.exportScript([base],[base.id]),/profile 0\n[\s\S]*set roll_p_gain = 50/);
    assert.throws(()=>advice.exportScript([base,{...base,id:'B:edit',dataset:'B'}],[base.id,'B:edit']),/one final configuration/);
    ds.datasets[0].values.roll_p_gain=null;advice.configurationBases(ds);assert.equal(ds.datasets[0].exportBase.unsupported.length,1);
    const a={gov_headspeed:2300,roll_d_cutoff:15,iterm_relax_type:1,'iterm_relax_cutoff[0]':8,'iterm_relax_cutoff[1]':9,'iterm_relax_cutoff[2]':10};
    const b={gov_headspeed:2500,roll_d_cutoff:30,iterm_relax_type:2,'iterm_relax_cutoff[0]':10,'iterm_relax_cutoff[1]':10,'iterm_relax_cutoff[2]':10};
    ds.datasets[0].values=a;ds.datasets[1].values=b;ds.diff=Object.keys(a).map(name=>({name}));advice.configurationBases(ds);
    const restore=ds.datasets[0].exportBase;assert.deepEqual(restore.unsupported,[]);
    // a headspeed is not selected first (the decision of the pilot, user 2026-10-15): the pilot selects every record here
    assert.ok(!advice.exportScript(restore.records).includes('set gov_headspeed'),'a recorded headspeed is not restored unless the pilot selects it');
    const script=advice.exportScript(restore.records,restore.records.map(r=>r.id));
    assert.match(script,/set iterm_relax_cutoff = 8,9,10/);assert.match(script,/set iterm_relax_type = RP\n/);
    assert.match(script,/set roll_d_cutoff = 15/,'a recorded value can be restored within the firmware range');
    assert.match(script,/set gov_headspeed = 2300/);
    a['iterm_relax_cutoff[1]']=999;advice.configurationBases(ds);
    assert.ok(ds.datasets[0].exportBase.unsupported.some(q=>q.name==='iterm_relax_cutoff'));
});

test('structured setup measurements preserve recommendations when diagnostic wording changes', () => {
    const pairs = [
        ['lost frames', { id: 'D2', profile: null, value: 3, text: '1 logging gaps in the log; in this segment 3 time jumps (40 frames missing, by loopIteration), 0 loop stalls' },
            { counts: { logGaps: 1, timeJumps: 3, timeBackwards: 0, iterationJumps: 0, loopStalls: 0, missingFrames: 40 } }],
        ['loop stalls', { id: 'D2', profile: null, value: 0, text: '0 logging gaps in the log; in this segment 0 time jumps (0 frames missing, by loopIteration), 2 loop stalls' },
            { counts: { logGaps: 0, timeJumps: 0, timeBackwards: 0, iterationJumps: 0, loopStalls: 2, missingFrames: 0 } }],
        ['missing fields', { id: 'D3', severity: 'note', profile: null, value: 1, text: 'checks that cannot run: F5/F6/F7 (gyroRAW[0] absent, gyroRAW[1] absent, gyroRAW[2] absent)' },
            { skips: [{ checks: ['F5','F6','F7'], missing: ['gyroRAW[0] absent','gyroRAW[1] absent','gyroRAW[2] absent'] }] }],
        ['dynamic notch', { id: 'F8', severity: 'note', profile: null, text: 'dynamic notch off; 2 lines without RPM notch coverage; forced off below 1000 Hz' }, { uncoveredLines: 2, forcedOff: true }],
        ['notch line', { id: 'F5', value: 3, text: 'line at 3 x rotor (150 Hz, prominence 90, rotor-locked): nearest notch roll none, pitch none, yaw none', filterPass: [{ hz: 150, roll: 0.01, pitch: 0.01, yaw: 0.01 }] },
            { lines: [{ order: 3, hz: 150, prominence: 90, rotorLocked: true, axes: ['roll','pitch','yaw'].map(axis => ({ axis, amplitude: 5, nearestNotch: null })) }] }],
        ['header change', { id: 'H', severity: 'note', profile: 'start profile 1', value: '100', text: 'yawPID: 80 -> 100 (since log 4, start profile 1)' }, { headerKey: 'yawPID', from: '80', since: 4 }],
        ['CLI mismatch', { id: 'D4', profile: 0, text: D4_TEXT }, { mismatches: [{ cli: 'yaw_collective_ff_gain', header: 'yaw_precomp[2]', headerValue: 60, cliValue: 70 }] }],
    ];
    const decisions = out => out.recommendations.map(({ id, severity, title, text, parameter, from, to, cli, blockedBy, caveats }) => ({ id, severity, title, text, parameter, from, to, cli, blockedBy, caveats }));
    for (const [name, row, data] of pairs) {
        const old = f(Object.assign({ module: 'setup' }, row));
        const next = Object.assign({}, old, data, { text: 'The diagnostic wording can change.' });
        const a = decisions(run([old], { cli: CLI })), b = decisions(run([next], { cli: CLI }));
        assert.ok(a.length > 0, name);
        assert.deepEqual(b, a, name);
    }
});

test('structured yaw setup and header changes keep stale gain proposals blocked', () => {
    const legacy = [setupOf(5, '80,120,10,0,0', '120,80'), setupOf(6, '80,120,14,20,0', '120,80')];
    const typed = legacy.map((row, i) => Object.assign({}, row, { text: 'The diagnostic wording can change.', setup: {
        pid: { yaw: i ? HEADER.yawPID : [80,120,10,0,0] }, yaw: { stopGain: [120,80], inertia: [0,25] }
    } }));
    const oldFlag = T14F({ gain: 300, se: 40, f: { log: 5 } });
    const quiet = T14F({ gain: 10, se: 20, f: { log: 6, severity: 'note', events: [1,2,3,4,-5,6].map((v,i) => ({t:i,value:v*5,toward:8})) } });
    const a = only(run([...legacy,oldFlag,quiet]),'T14'), b = only(run([...typed,oldFlag,quiet]),'T14');
    for (const key of ['severity','title','text','to','cli','caveats']) assert.deepEqual(b[key],a[key],key);
    assert.equal(b.severity,'watch'); assert.deepEqual(b.cli,[]);
    const catalog = require('../tools/autotune/catalog.cjs');
    assert.deepEqual(catalog.headerChange({headerKey:'yawPID',from:'80',value:'100',since:4,text:'Changed wording.'}), {key:'yawPID',from:'80',to:'100',since:4});
});

// review IMP-12 and IMP-03: a control limit with a cause (a receiver signal loss, the fall) or out of flight gets no limit recommendation; a G14
// change after the receiver signal stopped gets no governor recommendation; a D11 flag is one recommendation of the Rescue item, with no CLI text
test('IMP-12 review: no limit recommendation for caused or out-of-flight periods, no G14 governor item for a receiver signal loss, D11 in the Rescue item', () => {
    const L4 = (o) => f(Object.assign({ module: 'limits', id: 'L4', axis: 'yaw', channel: 'tail', field: 'mixer[2]', severity: 'flag', value: 0.4, n: 2, longestS: 0.3, limits: { lo: -1250, hi: 1250, source: 'snapshot' },
        events: [{ tS: 30, t1S: 30.3, seconds: 0.3, side: 'lo', limit: -1250, phase: 'flight', profile: 1, rescue: null, with: [], same: [], errors: {} }] }, o));
    const caused = L4({ severity: 'note', cause: 'receiver loss / fall', causes: ['receiver loss', 'fall'], causeChecks: ['D10', 'D11'] }), still = L4({ severity: 'note', outOfFlight: true }), normal = L4({});
    const lim = (list) => recs(run(list), 'L4:').map(r => r.id);
    assert.deepEqual(lim([caused]), [], 'a cause: no L4 recommendation'); assert.deepEqual(lim([still]), [], 'out of flight: no L4 recommendation');
    assert.deepEqual(lim([normal]), ['L4:tail:p1'], 'the period in flight: the L4 recommendation');
    const G14 = (o) => f(Object.assign({ module: 'more', id: 'G14', severity: 'flag', value: 1, n: 1, profile: null, events: [{ t: 68.6, tS: 68.645, value: 1.9, kind: 'throttle hold in flight', state: 'HOLD', rx: 'lost', rxLoss: true }] }, o));
    assert.deepEqual(recs(run([G14({ cause: 'receiver loss' })]), 'G14').map(r => r.id), [], 'a HOLD from the rxfail values: no governor recommendation');
    assert.deepEqual(recs(run([G14({})]), 'G14').map(r => [r.id, r.area]), [['G14', 'governor']], 'a HOLD by the pilot in flight: the governor recommendation');
    const D11 = f({ module: 'phase', id: 'D11', severity: 'flag', value: 1, n: 1, profile: 2, by: 'receiver loss', motorCut: true, cutS: 68.6453, contactS: 70.4435, fallS: 1.798, threshold: { crashFactor: 2, limit: 0 } });
    const out = run([D11]), d = recs(out, 'D11'); assert.equal(d.length, 1);
    assert.deepEqual([d[0].id, d[0].node, d[0].cli, d[0].area], ['D11', 'rescue', [], 'precondition']);
    assert.match(d[0].rule, /^Check D11 has a problem if the helicopter touches the ground in failsafe or with no receiver signal\. At the ground contact, a rate step of 2 times the largest step of the flight or more is also a problem\. Source: /);
    assert.match(d[0].text, /The motor stops while the helicopter is in the air in .*at 68\.65 s \(the ground contact at 70\.44 s\)/);
    const none = recs(run([Object.assign({}, D11, { motorCut: false })]), 'D11')[0]; assert.match(none.text, /\nThe flight ends in the air with no RC control in /);
});
