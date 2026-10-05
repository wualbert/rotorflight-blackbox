'use strict';

// Advice (tools/autotune/advice.cjs): one test per generator and per guard on synthetic findings whose right answer is
// known in closed form, the contracts (names, coverage, purity, loading), and a smoke test over the real Gaui X4 and
// Fireball results in analysis/ (skipped when those files are absent).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const advice = require('../tools/autotune/advice.cjs');
const setup = require('../tools/autotune/health_setup.cjs');

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
const f = (o) => Object.assign({ module: 'loop', severity: 'flag', log: 5, profile: 1, value: null, se: null, n: 10, threshold: null, source: 'pipeline, unvalidated', text: '', times: [] }, o);
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
    assert.match(r.text, /1 log\(s\) have loop stalls only/);
    assert.match(r.text, /1 log\(s\) lost frames/);
    assert.match(r.text, /1 log\(s\) could not be decoded/);
});

test('D3: missing raw gyro or governor fields make a check', () => {
    const r = only(run([f({ module: 'setup', id: 'D3', severity: 'note', profile: null, value: 1, text: 'checks that cannot run: F5/F6/F7 (gyroRAW[0] absent, gyroRAW[1] absent, gyroRAW[2] absent)' })]), 'D3');
    assert.equal(r.severity, 'check');
    assert.match(r.text, /F5\/F6\/F7 .* in 1 log/);
});

test('D3: checks that no module implements (power/current from Ibat, G12 from EscRPM) are not asked for', () => {
    const d3 = (text) => f({ module: 'setup', id: 'D3', severity: 'note', profile: null, value: 2, text: `checks that cannot run: ${text}` });
    assert.equal(recs(run([d3('power/current (Ibat zero); G12 (independent rpm) (EscRPM absent)')]), 'D3').length, 0);
    const r = only(run([d3('F5/F6/F7 (gyroRAW[0] absent, gyroRAW[1] absent, gyroRAW[2] absent); power/current (Ibat zero)')]), 'D3');
    assert.doesNotMatch(r.text, /Ibat|power\/current/);
    assert.match(r.text, /F5\/F6\/F7/);
});

test('D4: without a CLI dump a load-CLI note; a disagreement is a check and the contradicted CLI value is not used', () => {
    assert.equal(only(run([]), 'D4:cli').severity, 'info');
    assert.equal(recs(run([], { cli: CLI }), 'D4:cli').length, 0);
    const t7 = f({ id: 'T7', profile: 2, value: 0.8, se: 0.05, precompScale: 1.44, text: 'yaw I vs precomp in pumps: r 0.80 +- 0.05: precomp too small' });
    const out = run([f({ module: 'setup', id: 'D4', profile: 0, value: 1, text: D4_TEXT }), t7], { cli: Object.assign({}, CLI, { profiles: { 1: { yaw_collective_ff_gain: 70 } } }) });
    assert.equal(only(out, 'D4').severity, 'check');
    const r = only(out, 'T7');
    assert.deepEqual(r.cli, [], 'the CLI value 70 is stale and the header holds profile 1, not 2');
    assert.match(r.caveats.join(' '), /may hold another value: the CLI capture disagrees with the log header on it \(D4\)/);
});

test('D5, D6: power and failsafe problems are checks; excluded spans are information', () => {
    assert.equal(only(run([f({ module: 'gov', id: 'D5', profile: null, value: 1.4, text: '3 Vbat steps above 1 V' })]), 'D5').severity, 'check');
    const out = run([f({ module: 'more', id: 'D6', value: 2.5, unit: 's', text: 'failsafe 2.5 s while airborne' }), f({ module: 'more', id: 'D6', severity: 'note', value: 10.6, unit: 's', text: 'rescue 10.6 s excluded' })]);
    assert.equal(only(out, 'D6:excluded').severity, 'info');
    const fs1 = out.recommendations.find(r => r.id === 'D6');
    assert.equal(fs1.severity, 'check');
    assert.match(fs1.text, /2\.5 s of failsafe/);
});

test('H: the tuning history is summarised once', () => {
    const r = only(run([f({ module: 'setup', id: 'H', severity: 'note', log: 6, profile: 'start profile 1', value: '100,80', text: 'yaw_stop_gain: 120,80 -> 100,80 (since log 5, start profile 1)' })]), 'H');
    assert.equal(r.severity, 'info');
    assert.match(r.text, /yaw_stop_gain 1x/);
});

test('logBase: the logs named in advice texts count as the reader counts them; quoted finding texts stay as they are', () => {
    const fs1 = [f({ module: 'more', id: 'D6', profile: null, value: 2.5, unit: 's', text: 'failsafe 2.5 s while airborne at log 5' })];
    assert.match(only(run(fs1), 'D6').text, /in log\(s\) 5: /);
    assert.match(only(run(fs1, { logBase: 1 }), 'D6').text, /in log\(s\) 6: /);
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

test('F1: no gyro LPF with RPM filters on adds a 100 Hz first-order LPF', () => {
    const flag = [f({ module: 'setup', id: 'F1', profile: null, value: 0, text: 'no gyro LPF active' })];
    const r = only(run(flag, { header: Object.assign({}, HEADER, { gyro_soft_type: 0, gyro_lowpass_hz: 0 }) }), 'F1');
    assert.equal(r.severity, 'action');
    assert.deepEqual(r.cli, ['set gyro_lpf1_type = FIRST_ORDER', 'set gyro_lpf1_static_hz = 100']);
    assert.equal(only(run(flag), 'F1').severity, 'info');                    // the analysed header has LPF1 100 Hz
    assert.equal(only(run(flag, { header: {} }), 'F1').severity, 'check');   // no header: nothing to change
});

test('F2: an LPF below 60 Hz is raised to the documented floor, never lowered (guard 6)', () => {
    const r = only(run([f({ module: 'setup', id: 'F2', profile: null, value: 40, text: 'lowest gyro LPF cutoff 40 Hz.' })], { header: Object.assign({}, HEADER, { gyro_lowpass_hz: 40 }) }), 'F2');
    assert.equal(r.to, 60);
    assert.deepEqual(r.cli, ['set gyro_lpf1_static_hz = 60']);
    const w = only(run([f({ module: 'setup', id: 'F2', severity: 'note', profile: null, value: 70 })], { header: Object.assign({}, HEADER, { gyro_lowpass_hz: 70 }) }), 'F2');
    assert.equal(w.severity, 'watch');
    assert.deepEqual(w.cli, []);
});

test('F3: notch Q below 2.0 goes to 2.0 (custom banks and the dynamic notch)', () => {
    const h = Object.assign({}, HEADER, { gyro_rpm_notch_preset: 0, gyro_rpm_notch_q_roll: pad([80, 15, 60, 50]), dyn_notch_q: 15 });
    const out = run([f({ module: 'setup', id: 'F3', profile: null, value: 1.5, text: 'RPM notch Q 1.5..8' })], { header: h });
    assert.deepEqual(only(out, 'F3:gyro_rpm_notch_q_roll').cli, [`set gyro_rpm_notch_q_roll = ${pad([80, 20, 60, 50]).join(',')}`]);
    assert.deepEqual(only(out, 'F3:dyn_notch_q').cli, ['set dyn_notch_q = 20']);
});

test('F4: D cutoff away from 20 Hz is advisory information', () => {
    const r = only(run([f({ module: 'setup', id: 'F4', severity: 'note', profile: 'yaw', value: 40, text: 'yaw D cutoff 40 Hz, +20 Hz from the documented ~20 Hz; advisory only.' })]), 'F4');
    assert.equal(r.severity, 'info');
    assert.equal(r.parameter, 'yaw_d_cutoff');
    assert.deepEqual(r.cli, []);
});

test('F5: no CLI and a tail notch of unknown order is a check (guard 9); a main harmonic gets a notch; a tail-ratio line points at the gear ratio', () => {
    const text = (order) => `line at ${order} x rotor (155.7 Hz, prominence 300, rotor-locked): nearest notch roll 14 at 4 (1.5 %), pitch 14 at 4 (1.5 %), yaw 12 at 2 (103.0 %)`;
    const unk = only(run([f({ module: 'setup', id: 'F5', value: 4.061, text: text(4.061) })]), 'F5');
    assert.equal(unk.severity, 'check');
    assert.deepEqual(unk.cli, []);
    assert.match(unk.caveats.join(' '), /guard 9/);
    const main = only(run([f({ module: 'setup', id: 'F5', value: 3, text: 'line at 3 x rotor (115 Hz, prominence 40, rotor-locked): nearest notch roll none, pitch none, yaw 12 at 2 (50.0 %)' })], { cli: CLI }), 'F5');
    assert.equal(main.severity, 'action');
    assert.deepEqual(main.cli.slice(0, 2), ['set gyro_rpm_notch_preset = 0', `set gyro_rpm_notch_source_roll = ${pad([11, 12, 14, 21, 13]).join(',')}`]);
    assert.ok(main.cli.includes(`set gyro_rpm_notch_q_yaw = ${pad([80, 40, 50, 40]).join(',')}`), main.cli.join('\n'));
    const tail = only(run([f({ module: 'setup', id: 'F5', value: 3.789, text: text(3.789) })], { cli: CLI }), 'F5');
    assert.equal(tail.severity, 'check');
    assert.match(tail.text, /tail harmonic 1 sits at 4 x rotor \(5\.3 % away\)/);   // tail 76/19 = 4.000; 3.789 / 4 - 1 = -5.3 %
});

test('F5: a line the gyro filters already remove (measured filterPass < 5 % on every axis) is information and blocks nothing', () => {
    const text = 'line at 4.061 x rotor (155.7 Hz, prominence 300, rotor-locked): nearest notch roll 14 at 4 (1.5 %), pitch 14 at 4 (1.5 %), yaw 12 at 2 (103.0 %)';
    const F5 = (pass) => f({ module: 'setup', id: 'F5', value: 4.061, text, filterPass: [{ hz: 155.7, roll: 0.002, pitch: 0.001, yaw: pass }] });
    const out = run([C3UP, F5(0.004)], { cli: CLI }), r = only(out, 'F5');
    assert.deepEqual([r.severity, r.title, r.cli], ['info', 'Vibration line already filtered out', []]);
    assert.match(r.text, /yaw 0\.4 %: the filters already remove it/);
    assert.deepEqual(r.evidence[0].filterPass, [{ hz: 155.7, roll: 0.002, pitch: 0.001, yaw: 0.004 }]);
    assert.deepEqual(only(out, 'C3').blockedBy, [], 'a filtered-out line does not hold gain raises (guard 1)');
    // one axis at or above the 5 % rule, or an axis not measured: the notch arithmetic decides, as before
    for (const pass of [0.05, null]) assert.notEqual(only(run([F5(pass)], { cli: CLI }), 'F5').title, 'Vibration line already filtered out', String(pass));
    // weaker lines of the finding that pass more are named, with no notch for them (C11 and F10 decide)
    const weak = f({ module: 'setup', id: 'F5', value: 4.061, text: text + '; line at 8.12 x rotor (311.3 Hz, prominence 16.6): nearest notch roll none, pitch none, yaw none',
        filterPass: [{ hz: 155.7, roll: 0.002, pitch: 0.001, yaw: 0.004 }, { hz: 311.3, roll: 0.25, pitch: 0.24, yaw: 0.23 }] });
    const w = only(run([weak], { cli: CLI }), 'F5');
    assert.deepEqual([w.severity, w.title, w.cli], ['info', 'Strongest vibration line already filtered out', []]);
    assert.match(w.text, /1 weaker line\(s\) pass more \(311\.3 Hz up to 25 %\), attenuated by the low-pass only; no notch is proposed for them unless .*C11, F10/);
});

test('notes: excluded spans are named for the pilot and zeros are left out', () => {
    const out = run([], { logs: [Object.assign({}, LOGS[0], { excluded: { rescueS: 10.6, levelModeS: 0, failsafeS: 0.02, groundS: 5, guardS: 2 } })] });
    assert.ok(out.notes.includes('excluded from the analysis: rescue 10.6 s, ground contact 5 s, guard time around them 2 s.'), out.notes.join('\n'));
});

test('T13: a constant hover yaw I names the trim and the collective precomp, never the P/I/D gains', () => {
    const r = only(run([f({ module: 'more', id: 'T13', value: -0.24, se: 0.004, text: 'hover yaw I -303 +- 5 permille' })]), 'T13');
    assert.deepEqual(r.cli, []);
    assert.match(r.text, /tail_center_trim .*yaw_collective_ff_gain/);
});

test('F5: an RPM notch only for main harmonics 1-8 (sources 11-18); higher lines point at the dynamic or a static notch', () => {
    const line = (order, hz) => f({ module: 'setup', id: 'F5', value: order, text: `line at ${order} x rotor (${hz} Hz, prominence 40, rotor-locked): nearest notch roll none, pitch none, yaw none` });
    const k8 = only(run([line(8, 300)], { cli: CLI }), 'F5');
    assert.equal(k8.severity, 'action');
    assert.ok(k8.cli.includes(`set gyro_rpm_notch_source_roll = ${pad([11, 12, 14, 21, 18]).join(',')}`), k8.cli.join('\n'));
    // 19 fails rpmFilterInit and disables arming; 20 is the tail motor; 21 and 22 are tail-rotor harmonics 1 and 2
    for (const [order, hz] of [[9, 340], [10, 380], [11, 420], [11.95, 455]]) {
        const r = only(run([line(order, hz)], { cli: CLI }), 'F5'), k = Math.round(order);
        assert.deepEqual([r.severity, r.cli, r.parameter], ['check', [], null], String(order));
        assert.match(r.title, new RegExp(`main harmonic ${k}, beyond the RPM notches`));
        assert.doesNotMatch(r.text, /add an RPM notch with source/);
        assert.doesNotMatch(r.text, /not a main-rotor harmonic/, 'it is one');
        assert.match(r.text, new RegExp(`dynamic notch is on, but its range 20-240 Hz misses the line at ${hz} Hz: widen it to hold ${hz} Hz`), r.text);
        assert.equal(advice.script(run([line(order, hz)], { cli: CLI }).recommendations), '', 'nothing to apply');
    }
    // inside the dynamic notch range: say so
    assert.match(only(run([line(9, 200)], { cli: CLI }), 'F5').text, /dynamic notch is on and its range 20-240 Hz holds the line at 200 Hz/);
    assert.match(only(run([line(9, 340)], { cli: CLI, header: Object.assign({}, HEADER, { features: RPMF }) }), 'F5').text, /Cover it with the dynamic notch: `feature DYN_NOTCH`, with a range that holds 340 Hz/);
});

test('F5: on a motorised tail no tail harmonic sits at a fixed rotor order', () => {
    const mot = setup.parseCli(CLI_TEXT.replace('# master\n', '# master\nset tail_rotor_mode = MOTORIZED\n'));
    const r = only(run([f({ module: 'setup', id: 'F5', value: 7.9, text: 'line at 7.9 x rotor (300.2 Hz, prominence 9.1): nearest notch roll none, pitch none, yaw none' })], { cli: mot }), 'F5');
    assert.doesNotMatch(r.text, /tail harmonic \d+ sits at/);
    assert.match(r.text, /on a motorised tail \(tail_rotor_mode MOTORIZED\) the tail rotor is not locked to the main rotor/);
    assert.match(only(run([f({ id: 'T8', value: 2, text: '20 episodes' })], { cli: mot }), 'T8').text, /Motorised tail/);
});

test('F6: attenuation below 10 dB is a check; one not below 10 dB by 2 SE is a watch', () => {
    assert.equal(only(run([f({ module: 'setup', id: 'F6', value: 6, se: 1, text: 'yaw notch 21 ...: 6 +- 1 dB' })]), 'F6').severity, 'check');
    assert.equal(only(run([f({ module: 'setup', id: 'F6', value: 9, se: 2, text: 'yaw notch 21 ...: 9 +- 2 dB' })]), 'F6').severity, 'watch'); // 9 + 4 > 10
});

test('F8, F9: the dynamic notch range is compared with the strongest uncovered line', () => {
    const out = run([f({ module: 'setup', id: 'F5', value: 3.789, text: 'line at 3.789 x rotor (284.1 Hz, prominence 400, rotor-locked): nearest notch roll none, pitch none, yaw none' }),
        f({ module: 'setup', id: 'F8', severity: 'note', profile: null, value: false, text: 'dynamic notch off (count 6), PID rate 2000 Hz; 3 strong line-profile pair(s) without RPM notch coverage (see F5).' }),
        f({ module: 'setup', id: 'F9', severity: 'note', profile: null, value: 0, text: '9 bank-profile pairs of unknown frequency (no gear ratios).' })], { cli: CLI });
    assert.match(only(out, 'F8').text, /cannot reach/);
    assert.equal(only(out, 'F9').severity, 'info');
});

test('F10: yaw D driven by noise is a filters check and one tail D step of 10', () => {
    const out = run([f({ module: 'more', id: 'F10', axis: 'yaw', value: 0.8, se: 0.05, threshold: 'D share - 2 SE > 0.5 (yaw; roll and pitch are judged by C11)', unit: 'fraction', text: 'yaw axisD power above 30 Hz 80 %' })]);
    assert.equal(out.recommendations.find(r => r.id === 'F10').severity, 'check');
    const d = only(out, 'F10:yaw_d_gain');
    assert.deepEqual([d.from, d.to], [14, 4]);
    assert.deepEqual(d.cli, ['profile 0', 'set yaw_d_gain = 4']);
    // with another filter flag standing (a line no notch covers, as on the Fireball) the D cut waits for the filter work
    const f5 = f({ module: 'setup', id: 'F5', value: 3.79, text: 'line at 3.79 x rotor (284 Hz, prominence 142, rotor-locked): nearest notch roll 14 at 4 (5.3 %)' });
    const held = only(run([f5, f({ module: 'more', id: 'F10', axis: 'yaw', value: 0.97, se: 0.005, threshold: 'D share - 2 SE > 0.5 (yaw; roll and pitch are judged by C11)', text: 'yaw axisD power above 30 Hz 97 %' })], { cli: CLI }), 'F10:yaw_d_gain');
    assert.deepEqual(held.cli, []);
    assert.match(held.blockedBy.join(' '), /filters first: F5 flag; lower yaw_d_gain only if/);
});

test('F7, F11: a vibration level change and a large measured filter delay are checks', () => {
    assert.equal(only(run([f({ module: 'more', id: 'F11', axis: 'roll', value: 14, se: 1, threshold: 'delay - 2 SE > 10 ms', unit: 'ms', text: 'roll gyro filter delay 14 +- 1 ms' })]), 'F11').severity, 'check');
    assert.match(only(run([f({ module: 'spectra', id: 'F7', value: 2.4, text: 'gyroRAW above 30 Hz x2.4 between groups' })]), 'F7').text, /blade tracking and balance/);
});

// ---------------------------------------------------------------------------------------------
// Governor
// ---------------------------------------------------------------------------------------------

test('G0, G1: DIRECT is information, FALLBACK a check, the glitch proxy a watch', () => {
    assert.equal(only(run([f({ module: 'gov', id: 'G0', severity: 'note', profile: null, value: 0, text: 'govSum and govI are 0 in flight: DIRECT or LIMIT, no PID governor.' })]), 'G0').severity, 'info');
    assert.equal(only(run([f({ module: 'gov', id: 'G1', profile: null, value: 2, text: '2 FALLBACK entries at 30.1 s' })]), 'G1').severity, 'check');
    assert.equal(only(run([f({ module: 'gov', id: 'G1', severity: 'note', profile: null, value: 3, text: '3 glitch-proxy events in flight' })]), 'G1:proxy').severity, 'watch');
});

test('G2, G5, G6, G8, G10, G11, G13, G14: diagnostics are checks without CLI', () => {
    for (const id of ['G2', 'G5', 'G6', 'G8', 'G10', 'G11', 'G13', 'G14']) {
        const r = only(run([f({ module: 'gov', id, value: 1, text: `${id} finding` })]), id);
        assert.equal(r.severity, 'check', id);
        assert.deepEqual(r.cli, [], id);
    }
    assert.equal(only(run([f({ module: 'gov', id: 'G13', severity: 'note', profile: null, text: 'no finding: cell count ambiguous (inferred); Vbat in flight 22.1 -> 21.0 V. Give the cell count' })]), 'G13:cells').severity, 'info');
});

test('G3: droop with F carrying less than half raises gov_f_gain by the documented 10; headroom is a check', () => {
    const r = only(run([f({ module: 'gov', id: 'G3', log: [5, 6], value: 0.07, se: 0.005, text: 'droop 7.00 % +- 0.50 %; F carries 30 % of the added govSum. F carries less than half: F too low (GOVT)' })]), 'G3');
    assert.deepEqual([r.from, r.to], [10, 20]);                                  // header govPID F 10, step 10
    assert.deepEqual(r.cli, ['profile 0', 'set gov_f_gain = 20']);
    assert.match(r.caveats.join(' '), /at least half/);
    const h = only(run([f({ module: 'gov', id: 'G3', log: [5], value: 0.07, se: 0.005, text: 'droop 7 %. Most events saturate: headroom (G6), not F' })]), 'G3');
    assert.equal(h.severity, 'check');
});

test('G4: overshoot at load onset lowers gov_f_gain; against a G3 raise it becomes a check', () => {
    const g4 = f({ module: 'gov', id: 'G4', log: [5], value: 0.05, se: 0.004, text: 'headspeed overshoots 5.00 % +- 0.40 % on collective rises (load onset), F carries 40 % of the added govSum: F too high (GOVT)' });
    const r = only(run([g4], { cli: CLI }), 'G4');
    assert.deepEqual([r.from, r.to, r.direction], [10, 0, 'lower']);
    const both = only(run([g4, f({ module: 'gov', id: 'G3', log: [5], value: 0.06, se: 0.01, severity: 'note', text: 'droop 6 %: F too low (GOVT)' })]), 'G4');
    assert.equal(both.severity, 'check');
    assert.match(both.caveats.join(' '), /conflicting evidence/);
    assert.equal(only(run([f({ module: 'gov', id: 'G4', log: [5], value: 0.05, se: 0.004, text: 'overshoot after collective drops 5 %' })]), 'G4:drop').severity, 'check');
});

test('G9: a P-type oscillation cuts gov_p_gain by the GOVT 1/3, bounded to 20 %; a peak below 2 SE is a watch', () => {
    const p = f({ module: 'gov', id: 'G9', value: 9, se: 1, text: 'headspeed error peak at 4 Hz in 3-10 Hz (P-type): governor P or gain too high' });
    const r = only(run([p]), 'G9');
    assert.deepEqual(r.cli, ['profile 0', 'set gov_p_gain = 32']);                 // 40 x 2/3 = 26.7, bounded to 40 x 0.8 (guard 5)
    assert.match(r.caveats.join(' '), /bounded to 20 % \(guard 5\): GOVT's cut by 1\/3 asks for 26\.7/);
    assert.match(r.rule, /reduce it with 1\/3/);
    const w = only(run([f({ module: 'gov', id: 'G9', severity: 'note', value: 5.01, se: 1.94, text: 'peak in 0.3-3 Hz (I-type), prominence 5.01 +- 1.94: above the threshold but not by 2 SE' })]), 'G9');
    assert.deepEqual([w.severity, w.parameter, w.to], ['watch', 'gov_i_gain', 40]);  // 50 x 2/3, bounded: 40 (the raise step 25 gave 25)
    assert.deepEqual(w.cli, []);
    // at GOVT's own starting values (P about 10, I about 20) a cut by the raise step took the gain to 0
    const low = Object.assign({}, HEADER, { govPID: [10, 20, 0, 10, 40] });
    assert.deepEqual(only(run([p], { header: low }), 'G9').cli, ['profile 0', 'set gov_p_gain = 8']);
    assert.deepEqual(only(run([f({ module: 'gov', id: 'G9', value: 9, se: 1, text: '(I-type)' })], { header: low }), 'G9').cli, ['profile 0', 'set gov_i_gain = 16']);
});

test('G12: a wrong headspeed factor is an action with the pole count that would fit', () => {
    const r = only(run([f({ module: 'gov', id: 'G12', profile: null, value: 1.2, se: 0.001, text: 'main rotor line at 1.2 x' })], { cli: CLI }), 'G12');
    assert.equal(r.severity, 'action');
    assert.match(r.text, /20 instead of 24/);                                    // 24 / 1.2
});

// ---------------------------------------------------------------------------------------------
// Cyclic
// ---------------------------------------------------------------------------------------------

test('C1, C2, C6, C10, C11: diagnostics are checks; landed while moving is a watch (CYC-LANDED refuted it)', () => {
    for (const [id, axis] of [['C1', 'roll'], ['C2', null], ['C6', 'pitch'], ['C10', null], ['C11', 'pitch']]) {
        const r = only(run([f({ id, axis, value: 0.9, se: 0.01, text: `${axis || ''} ${id} finding at an output limit (mixer[1])` })]), id);
        assert.equal(r.severity, 'check', id);
        assert.deepEqual(r.cli, [], id);
    }
    const landed = only(run([f({ id: 'C10', profile: null, value: 1, text: '1.0 s spooled up and turning while the firmware says landed (ground decay active)' })]), 'C10');   // Fireball 09-28 #1
    assert.deepEqual([landed.id, landed.severity, landed.cli], ['C10:landed', 'watch', []]);
    assert.match(landed.caveats.join(' '), /CYC-LANDED/);
});

test('C3: F x (1 + I share), pooled over logs, bounded to 20 %', () => {
    const c3 = (share, se, log = 5) => f({ id: 'C3', axis: 'roll', log, value: share, se, gyroRatio: { mean: 1, se: 0.01 }, text: 'roll: I share: I carries the rate, FF too low (raise F)' });
    const r = only(run([c3(0.15, 0.02), c3(0.15, 0.02, 6)]), 'C3');
    assert.deepEqual([r.from, r.to, r.confidence], [100, 115, 'measured']);
    assert.deepEqual(r.cli, ['profile 0', 'set roll_f_gain = 115']);
    const big = only(run([c3(0.5, 0.05)]), 'C3');
    assert.equal(big.to, 120);
    assert.match(big.caveats.join(' '), /bounded to 20 %/);
    assert.equal(only(run([c3(-0.3, 0.05)]), 'C3').to, 80);
    const ratio = only(run([f({ id: 'C3', axis: 'roll', value: 0.02, se: 0.01, gyroRatio: { mean: 0.8, se: 0.02 }, text: 'roll: rate off the setpoint' })]), 'C3');
    assert.deepEqual([ratio.severity, ratio.parameter], ['check', null]);
});

test('C4: FF too low raises F one 10 % step; FF too high is a check (F, relax or B)', () => {
    const low = only(run([f({ id: 'C4', axis: 'pitch', value: 25, se: 3, settleS: { mean: 0.2, se: 0.02 }, text: 'pitch stops: overshoot 25 %: I charged with the rotation at the stop: FF too low (raise F)' })]), 'C4');
    assert.deepEqual([low.from, low.to], [100, 110]);
    const high = only(run([f({ id: 'C4', axis: 'pitch', value: 25, se: 3, text: 'pitch stops: FF too high (lower F), or relax/B' })]), 'C4');
    assert.equal(high.severity, 'check');
    const settle = only(run([f({ id: 'C4', axis: 'pitch', value: 5, se: 3, settleS: { mean: 0.6, se: 0.05 }, text: 'FF too low (raise F)' })]), 'C4');
    assert.equal(settle.severity, 'action', 'the settling time clears 0.3 s by 2 SE although the overshoot does not');
});

test('C5, T1: self-excited oscillation is a check, one burst or oscillation present a watch', () => {
    assert.equal(only(run([f({ module: 'track', id: 'C5', axis: 'roll', value: 2, unit: 'bursts', text: '2 self-excited bursts at 12 Hz' })]), 'C5:roll').severity, 'check');
    assert.equal(only(run([f({ module: 'track', id: 'C5', severity: 'note', axis: 'roll', value: 0.08, se: 0.01, text: 'oscillation present' })]), 'C5:roll:watch').severity, 'watch');
    // one burst, as Fireball #3 at 331.3 s, whose cause analysis/fireball-0928 could not pin on the gain margin (TAIL-EVENT3)
    const one = only(run([f({ module: 'track', id: 'T1', axis: 'yaw', value: 1, text: '1 self-excited burst' })]), 'T1:yaw');
    assert.deepEqual([one.area, one.severity], ['tail', 'watch']);
    assert.match(one.text, /single burst/);
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
    assert.ok(c12.rule.includes(`(gyro and setpoint below ${T.lpHz} Hz, samples with |setpoint| > ${T.minAbsSetpoint} deg/s)`), `the rule names health_track's definition: ${c12.rule}`);
    assert.equal(only(run([TRACK('T11', { severity: 'note', axis: 'yaw', value: 0.35, se: 0.02, text: 'yaw tracking error 35 %: mild' })]), 'T11').severity, 'watch');
    // 130 +- 10 ms does not pass 120 ms by 2 SE: health_track writes a note, which is no lag recommendation
    assert.equal(recs(run([TRACK('C13', { severity: 'note', axis: 'pitch', value: 130, se: 10, unit: 'ms', text: 'pitch setpoint to gyro delay 130 +- 10 ms; report only' })]), 'C13').length, 0);
    assert.equal(only(run([TRACK('T12', { axis: 'yaw', value: 160, se: 10, unit: 'ms', text: 'yaw lag 160 ms' })]), 'T12').severity, 'check');
    const r1 = only(run([TRACK('R1', { axis: 'roll', profile: null, value: 80, se: 5, unit: 'ms', text: 'roll stick to setpoint 80 ms' })]), 'R1');
    assert.equal(r1.area, 'rates');
    assert.match(r1.rule, / > 40 ms /, 'the threshold comes from health_track DEFAULT_RULES');
    const mixed = only(run([TRACK('C13', { axis: 'pitch', profile: 1, value: 170, se: 10, text: 'pitch lag 170 ms' }),
        TRACK('C13', { severity: 'note', axis: 'pitch', profile: 2, value: 125, se: 20, text: 'pitch lag 125 ms; report only' })]), 'C13');
    assert.equal(mixed.severity, 'check', 'profile 1 clears 120 ms by 2 SE although profile 2 does not');
});

test('C12, T11: every measured pair is pooled, ok ones too; the title counts the pairs above the note level', () => {
    // as Gaui X4 file 50: one yaw pair at 40.5 +- 5.7 %, the others ok at 12-29 %
    const ok = [[23, 1, 0.294, 0.042], [32, 1, 0.26, 0.027], [39, 1, 0.271, 0.016], [48, 2, 0.124, 0.028], [49, 2, 0.144, 0.006], [49, 3, 0.132, 0.026]]
        .map(([log, profile, value, se]) => TRACK('T11', { severity: 'ok', axis: 'yaw', log, profile, value, se, text: `yaw tracking error ${value}` }));
    const high = TRACK('T11', { severity: 'note', axis: 'yaw', log: 38, profile: 1, value: 0.405, se: 0.057, text: 'yaw tracking error 40.5 +- 5.7 %: mild' });
    const r = only(run([high, ...ok]), 'T11');
    assert.equal(r.title, 'yaw tracking error above 30 % in 1 of 7 log-profile pair(s)');
    assert.equal(r.severity, 'watch');
    assert.equal(r.evidence.length, 7);
    const m = /all 7 pooled ([\d.]+) %/.exec(r.text);
    assert.ok(m && +m[1] < 20, r.text);                                           // the note pair alone read 40.5 %
    assert.match(r.text, /the largest, log 38 profile 1: yaw tracking error 40\.5/);
    // the note pair was measured before a later yawPID change on its start profile (H): a caveat, as parameter recs get
    const h = f({ module: 'setup', id: 'H', severity: 'note', log: 46, profile: 'start profile 1', value: '160,180,30,10,10', text: 'yawPID: 100,140,14,0,0 -> 160,180,30,10,10 (since log 39, start profile 1)' });
    const old = only(run([high, ...ok, h]), 'T11');
    assert.match(old.caveats.join(' '), /1 of the 1 pair\(s\) above 30 % were measured before a later change of yawPID or yaw_stop_gain on their start profile \(log 38 profile 1: log 46 yawPID: 100,140,14,0,0 -> 160,180,30,10,10\)/);
    assert.equal(recs(run(ok), 'T11').length, 0, 'ok pairs alone give no recommendation');
});

test('C14: the measured pitch_collective_ff_gain change, bounded to 20 %; from 0 no relative step', () => {
    const c14 = f({ module: 'more', id: 'C14', axis: 'pitch', value: 30, se: 4, threshold: '|slope| - 2 SE > 20, a gain change >= 10, the fast coupling not of the other sign by 2 SE', gainChange: 30, gainChangeSe: 8, from: 50, to: 80, unit: 'per 1000 collective', text: 'pitch I + O 30.0 +- 4.0 per 1000 collective: raise pitch_collective_ff_gain 50 -> 80' });
    const r = only(run([c14]), 'C14');
    assert.deepEqual([r.from, r.to], [50, 60]);                                  // 50 + 30 bounded to 50 x 1.2
    assert.deepEqual(r.cli, ['profile 0', 'set pitch_collective_ff_gain = 60']);
    const zero = only(run([c14], { header: Object.assign({}, HEADER, { pitch_compensation: 0 }) }), 'C14');
    assert.deepEqual([zero.severity, zero.cli], ['check', []]);
});

test('F10, C14: the estimate pooled over the logs of a profile must pass the module threshold by 2 SE (their findings give it as text)', () => {
    const more = require('../tools/autotune/health_more.cjs'), share = more.DEFAULT_RULES.F10.share, slope = more.DEFAULT_RULES.C14.flag;
    const f10 = (log, sev, value, se) => f({ module: 'more', id: 'F10', severity: sev, axis: 'yaw', log, value, se, unit: 'fraction', threshold: `D share - 2 SE > ${share} (yaw; roll and pitch are judged by C11)`, text: `yaw axisD power above 30 Hz ${value * 100} %` });
    // one flight flags (0.75 +- 0.10), the other does not (0.30 +- 0.05): pooled 0.39 +- 0.23, below 0.5 by 2 SE
    const w = only(run([f10(5, 'flag', 0.75, 0.10), f10(6, 'ok', 0.30, 0.05)]), 'F10:yaw_d_gain');
    assert.deepEqual([w.severity, w.cli], ['watch', []]);
    assert.match(w.caveats.join(' '), new RegExp(`F10 0\\.39 \\+- 0\\.225 \\(2 log\\(s\\)\\) does not clear > ${share} by 2 SE`));
    assert.deepEqual(only(run([f10(5, 'flag', 0.75, 0.05), f10(6, 'flag', 0.8, 0.05)]), 'F10:yaw_d_gain').cli, ['profile 0', 'set yaw_d_gain = 4'], 'both flights flag: the pooled share clears');
    const c14 = (log, sev, value) => f({ module: 'more', id: 'C14', severity: sev, axis: 'pitch', log, value, se: 4, gainChange: value, gainChangeSe: 4, unit: 'per 1000 collective',
        threshold: `|slope| - 2 SE > ${slope}, a gain change >= 10, the fast coupling not of the other sign by 2 SE`, text: `pitch I + O ${value} +- 4 per 1000 collective` });
    const cw = only(run([c14(5, 'flag', 30), c14(6, 'note', 5)]), 'C14');            // pooled 17.5 +- 12.5 against 20
    assert.deepEqual([cw.severity, cw.cli], ['watch', []]);
    assert.match(cw.rule, new RegExp(`\\|slope\\| - 2 SE > ${slope} per 1000 collective`), 'the rule prints the numbers, not RULES.C14.flag');
});

// ---------------------------------------------------------------------------------------------
// Tail
// ---------------------------------------------------------------------------------------------

test('T2, T4, T8, T13, T14: tail diagnostics are checks; a motorised tail mentions TTA in steps of 10', () => {
    for (const [id, sev] of [['T2', 'flag'], ['T3', 'flag'], ['T4', 'note'], ['T8', 'flag'], ['T10', 'flag'], ['T13', 'flag'], ['T14', 'flag']]) {
        const r = only(run([id === 'T14' ? T14F() : f({ id, severity: sev, value: 1, se: 0.1, threshold: 0.15, text: `${id} finding: suspect mechanics` })]), id);
        assert.equal(r.severity, id === 'T4' ? 'watch' : 'check', id);   // T4: its frequency test is the one TAIL-FREQ refuted
        assert.deepEqual(r.cli, [], id);
    }
    const mot = only(run([f({ id: 'T8', value: 2, text: '20 episodes' })], { cli: setup.parseCli(CLI_TEXT.replace('# master\n', '# master\nset tail_rotor_mode = MOTORIZED\n')) }), 'T8');
    assert.match(mot.text, /gov_tta_gain in steps of 10/);
});

test('T14: the present yaw setup leads; flags measured on other yaw gains are context, never the target', () => {
    // HEADER yaw 80,120,14,20,0 / stop 120,80 / inertia 0,25. Log 5 flew older gains and flagged; log 6 flies the present ones
    const setups = [setupOf(5, '80,120,10,0,0', '120,80'), setupOf(6, '80,120,14,20,0', '120,80')], oldFlag = T14F({ gain: 300, se: 40, f: { log: 5 } });
    const quiet = T14F({ gain: 10, se: 20, f: { log: 6, severity: 'note', events: [1, 2, 3, 4, -5, 6].map((v, i) => ({ t: i, value: v * 5, toward: 8 })) } });
    const w = only(run([...setups, oldFlag, quiet]), 'T14');
    assert.deepEqual([w.severity, w.cli, w.to], ['watch', [], null]);
    assert.match(w.title, /below the T14 line on the present yaw setup/);
    assert.match(w.text, /present yaw setup \(yaw PID 80,120,14,20,0, stop 120,80, inertia 0,25\), log\(s\) 6: 6 ramp events/);
    assert.doesNotMatch(w.text, /raise/, 'no raise from the old flag');
    assert.match(w.caveats.join(' '), /flagged on other yaw setups, so measured on other gains \(context, not a target\): log 5 \(yaw PID 80,120,10,0,0, stop 120,80, inertia 0,25\): gain change 300 \+- 40/);
    // no measured log on the present gains: re-measure
    const none = only(run([...setups, oldFlag]), 'T14');
    assert.deepEqual([none.severity, none.title], ['watch', 'Yaw at headspeed ramps: re-measure on the present yaw setup']);
    // the present gains flag, pooled: a check with the target, the old flag still context only
    const now = only(run([...setups, oldFlag, T14F({ gain: 60, se: 10, f: { log: 6 } })]), 'T14');
    assert.deepEqual([now.severity, now.from, now.to, now.direction, now.cli], ['check', 0, 60, 'raise', []]);
    assert.match(now.caveats.join(' '), /60 is the regression's whole estimate, and in simulated loops the regression read -1 to \+14 % off .*: step toward it, not to it at once/);
    const big = only(run([...setups, oldFlag, T14F({ gain: 300, se: 40, f: { log: 6 } })]), 'T14');
    assert.deepEqual([big.severity, big.to], ['check', 250]);
    assert.match(big.caveats.join(' '), /250 is the end of the firmware range; the regression's whole estimate is 300 \+- 40, and in simulated loops/, 'a clamped target says what was asked');
    assert.match(now.text, /raise yaw_inertia_precomp_gain 0 -> 60/);
    const noGain = only(run([T14F()], { header: Object.assign({}, HEADER, { yaw_inertia_precomp: undefined }) }), 'T14');
    assert.deepEqual([noGain.severity, noGain.to], ['check', null]);
    assert.match(noGain.text, /raise yaw_inertia_precomp_gain \(yaw_inertia_precomp is not in the header, so no target value\)/);
    // without the setups of the logs every measured log is pooled
    const all = only(run([oldFlag, quiet]), 'T14');
    assert.equal(all.severity, 'watch', 'the two flights disagree: pooled 68 +- 145 (the between-flight SE)');
    assert.match(all.text, /2 measured log\(s\) pooled \(5, 6\)/);
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
    assert.match(r.caveats.join(' '), /TAIL-PRECOMP/);
    assert.equal(only(run([t6({ mean: -30, se: 5, n: 6 })]), 'T6').to, 54);
    const mixed = only(run([t6({ mean: 5, se: 20, n: 6 })]), 'T6');
    assert.deepEqual([mixed.severity, mixed.parameter], ['check', null]);
    assert.match(mixed.caveats.join(' '), /TAIL-PRECOMP/, 'the direction-less case cites the refutation too');
    assert.doesNotMatch(mixed.text, /Check yaw_precomp_cutoff/, 'T6 measures the kick size and sign, not its timing');
    assert.match(mixed.text, /does not clear 2 SE.*T7/);
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
    assert.match(up.caveats.join(' '), /TAIL-FF/);
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
    gates: { V1: { value: 0.016, limit: 0.05, pass: true } } }, o);

test('C7: a report.cjs change becomes the CLI of its profile when the recovered gain matches the configured one', () => {
    const r = only(run([], { decisions: [decision()] }), 'C7');
    assert.deepEqual([r.profile, r.from, r.to, r.confidence], [1, 100, 80, 'predicted']);           // 2300 rpm target -> bin 2250 -> profile 1
    assert.deepEqual(r.cli, ['profile 0', 'set pitch_f_gain = 80']);
    // at the end of report.cjs's multiplier grid nothing further was evaluated: no claim that a larger step is better
    assert.match(r.caveats.join(' '), /x0\.8 is the largest step report\.cjs tries .*nothing beyond it was evaluated/);
    assert.match(r.caveats.join(' '), /1-3 Hz gain crosses 1 within this step \(1\.12 -> 0\.98\)/);
    assert.doesNotMatch(r.caveats.join(' '), /may lie further/);
    assert.deepEqual(only(run([], { decisions: [decision({ changes: [Object.assign({}, decision().changes[0], { from: 140 })] })] }), 'C7').cli, []); // the model ran with F 140
    const p2 = only(run([], { decisions: [decision({ bin: 2500 })], headerProfile: 1 }), 'C7');
    assert.deepEqual(p2.cli, ['profile 1', 'set pitch_f_gain = 80'], 'profile 2 differs from the header profile, but the recovered gain confirms the value');
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
    assert.deepEqual(r.cli, [], 'P 70 with stops 130/100 gives the same product');
    assert.match(r.caveats.join(' '), /the stop gains of profile 2 are not known either: the recovered P x mean stop gain 80\.5 matches their product/);
    assert.match(r.caveats.join(' '), /may hold another value/);
    // with the profile in a CLI capture the stop gains are known: P 70, stops 130/100 = 80.5 confirms P 70
    const cli = setup.parseCli(CLI_TEXT + 'set yaw_p_gain = 70\nset yaw_cw_stop_gain = 130\nset yaw_ccw_stop_gain = 100\n');
    assert.deepEqual(only(run([], { decisions: [d], cli }), 'C7').cli, ['profile 1', 'set yaw_p_gain = 63']);
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

test('guard 1: filters first blocks loop gain raises, not lowers; a D raise also waits for the C11 flag of its axis', () => {
    const r = only(run([C3UP, f({ module: 'setup', id: 'F5', value: 3.789, text: 'line at 3.789 x rotor (284 Hz, prominence 400): nearest notch roll none, pitch none, yaw none' })], { cli: CLI }), 'C3');
    assert.deepEqual(r.blockedBy, ['filters first: F5 flag']);
    assert.deepEqual(r.cli, []);
    const low = only(run([f({ id: 'C3', axis: 'roll', value: -0.3, se: 0.05, gyroRatio: { mean: 1, se: 0.01 }, text: 'FF too high' }), f({ module: 'setup', id: 'F5', value: 3.789, text: 'line at 3.789 x rotor (1 Hz, prominence 9): x' })], { cli: CLI }), 'C3');
    assert.equal(low.cli.length, 2);
    const d = only(run([f({ id: 'C11', axis: 'roll', value: 0.8, se: 0.02, text: 'roll D noise' })], { decisions: [decision({ axis: 'roll', changes: [{ gain: 'D', multiplier: 1.2, from: 10, to: 12 }] })], header: Object.assign({}, HEADER, { rollPID: [50, 100, 10, 100, 0] }) }), 'C7');
    assert.deepEqual(d.blockedBy, ['filters first: C11 roll flag']);
});

test('guard 1: an F6 flag that stands (below 10 dB by 2 SE) holds loop-gain raises and D cuts for noise; one that does not, nothing', () => {
    const f6 = (value, se) => f({ module: 'setup', id: 'F6', value, se, threshold: '>= 10 dB', text: `roll notch 12 (main rotor 2, 2 x rotor, 77 Hz, Q 4) at 2300 rpm: ${value} +- ${se} dB over 9 windows: mis-centred or too narrow.` });
    const r = only(run([C3UP, f6(4, 0.5)]), 'C3');
    assert.deepEqual([r.blockedBy, r.cli], [['filters first: F6 flag'], []]);
    assert.equal(only(run([C3UP, f6(9, 2)]), 'C3').cli.length, 2, '9 +- 2 dB is not below 10 dB by 2 SE: a watch, which holds nothing');
    const d = only(run([f6(4, 0.5)], { decisions: [decision({ axis: 'roll', changes: [{ gain: 'D', multiplier: 1.2, from: 10, to: 12 }] })], header: Object.assign({}, HEADER, { rollPID: [50, 100, 10, 100, 0] }) }), 'C7');
    assert.deepEqual([d.blockedBy, d.cli], [['filters first: F6 flag'], []]);
    const yawD = only(run([f6(4, 0.5), f({ module: 'more', id: 'F10', axis: 'yaw', value: 0.97, se: 0.005, threshold: 'D share - 2 SE > 0.5 (yaw; roll and pitch are judged by C11)', text: 'yaw axisD power above 30 Hz 97 %' })]), 'F10:yaw_d_gain');
    assert.deepEqual(yawD.cli, []);
    assert.match(yawD.blockedBy.join(' '), /filters first: F6 flag; lower yaw_d_gain only if/);
});

test('guard 2: a G12 or G1 flag blocks governor and RPM-notch changes', () => {
    const g3 = f({ module: 'gov', id: 'G3', log: [5], value: 0.07, se: 0.005, text: 'droop 7 %: F too low (GOVT)' });
    assert.deepEqual(only(run([g3, f({ module: 'gov', id: 'G12', profile: null, value: 1.1, se: 0.001, text: 'line at 1.1' })]), 'G3:').blockedBy, ['fix motor_poles / gear first: G12 flag']);
    assert.deepEqual(only(run([g3, f({ module: 'gov', id: 'G1', profile: null, value: 1, text: '1 FALLBACK entry' })]), 'G3:').cli, []);
});

test('guard 2: a G12 factor error beyond the 2 % notch tolerance also holds cyclic and tail changes; a small one and G1 do not', () => {
    const t5 = f({ id: 'T5', value: 2, se: 0.2, larger: 'ccw', text: 'stops' }), g12 = (value) => f({ module: 'gov', id: 'G12', profile: null, value, se: 0.001, text: `main rotor line at ${value} x` });
    const held = only(run([t5, g12(1.2)]), 'T5');
    assert.deepEqual(held.cli, []);
    assert.match(held.blockedBy.join(' '), /fix motor_poles \/ gear first: G12 flag, main rotor line at 1\.2 x the logged headspeed, beyond the 2 % RPM-notch tolerance/);
    assert.equal(only(run([C3UP, g12(1.006)]), 'C3').cli.length, 2, '0.6 %: the notches still cover the lines');
    assert.equal(only(run([C3UP, f({ module: 'gov', id: 'G1', profile: null, value: 1, text: '1 FALLBACK entry' })]), 'C3').cli.length, 2, 'FALLBACK spans are out of the loop analysis');
});

test('guard 3: an axis at its output limit gets "authority, not gains" and no raise CLI; a lower keeps its CLI', () => {
    const t8 = f({ id: 'T8', value: 4, text: '60 episodes, 4.07 s at an output limit (mixer[2], servo[3])' });
    const up = only(run([t8, f({ id: 'T6', value: 50, se: 5, towardTorque: { mean: 30, se: 5 }, text: 'kick' })]), 'T6');
    assert.deepEqual(up.cli, []);
    assert.match(up.blockedBy.join(' '), /authority, not gains/);
    const down = only(run([t8, f({ id: 'T5', value: 2, se: 0.2, larger: 'ccw', text: 'stops' })]), 'T5');
    assert.equal(down.cli.length, 2);
    assert.match(down.caveats.join(' '), /authority, not gains/);
    const roll = only(run([f({ id: 'C2', value: 1, text: '3 episodes, 1.00 s at an output limit (mixer[1]), longest 0.1 s' }), C3UP]), 'C3');
    assert.equal(roll.cli.length, 2, 'a pitch-only limit leaves roll alone');
});

test('guard 3: no governor raise while the tail is at its limit (T8) or G10 implicates the governor on that profile; lowering stays', () => {
    const g3 = f({ module: 'gov', id: 'G3', log: [5], value: 0.07, se: 0.005, text: 'droop 7 %: F carries less than half: F too low (GOVT)' });
    const t8 = (profile) => f({ id: 'T8', profile, value: 3.8, text: '73 episodes, 3.8 s at an output limit (mixer[2], servo[3])' });
    const held = only(run([g3, t8(1)]), 'G3');
    assert.deepEqual(held.cli, []);
    assert.match(held.blockedBy.join(' '), /tail authority first: T8 flag/);
    assert.match(held.caveats.join(' '), /stiffer governor adds motor torque faster.*\(hypothesis\).*more thrust \(prediction\)/);
    assert.deepEqual(only(run([g3, t8(2)]), 'G3').cli, ['profile 0', 'set gov_f_gain = 20'], 'the tail limit of another profile');
    const g10 = only(run([g3, f({ module: 'gov', id: 'G10', value: 0.7, se: 0.05, text: 'coherence 0.7 at the wag peak' })]), 'G3');
    assert.deepEqual(g10.cli, []);
    assert.match(g10.blockedBy.join(' '), /governor implicated in the tail wag: G10 flag in 1 log-profile pair\(s\), coherence 0\.7 \+- 0\.05/);
    const g4 = f({ module: 'gov', id: 'G4', log: [5], value: 0.05, se: 0.004, text: 'headspeed overshoots 5.00 % on collective rises (load onset): F too high (GOVT)' });
    assert.deepEqual(only(run([g4, t8(1)], { cli: CLI }), 'G4').cli, ['profile 0', 'set gov_f_gain = 0'], 'detuning is the remedy GOVT gives');
});

test('guard 4: a flag below 2 SE becomes a watch without CLI (T5 1.54 +- 0.38, T6 41.1 +- 11.5 as on the Gaui)', () => {
    const t5 = only(run([f({ id: 'T5', value: 1.54, se: 0.38, larger: 'ccw', text: 'stops' })]), 'T5');
    const t6 = only(run([f({ id: 'T6', value: 41.1, se: 11.46, towardTorque: { mean: 25.9, se: 25.3 }, text: 'kick' })]), 'T6');
    for (const r of [t5, t6]) { assert.equal(r.severity, 'watch'); assert.deepEqual(r.cli, []); assert.match(r.caveats.join(' '), /guard 4/); }
});

test('guard 5: relative steps are bounded to 20 %, also after rounding; documented absolute steps are kept', () => {
    assert.equal(only(run([f({ id: 'T7', value: 0.9, se: 0.02, precompScale: 4, text: 'x' })]), 'T7').to, 72);          // x2 asked, x1.2 given
    const g9 = only(run([f({ module: 'gov', id: 'G9', value: 9, se: 1, text: '(I-type): governor I too high' })]), 'G9');
    assert.deepEqual([g9.from, g9.to], [50, 40]);                                                                      // GOVT cut by 1/3, bounded to 20 %
    const g18 = only(run([f({ module: 'gov', id: 'G9', value: 9, se: 1, text: '(P-type)' })], { header: Object.assign({}, HEADER, { govPID: [18, 50, 0, 10, 40] }) }), 'G9');
    assert.equal(g18.to, 15, '18 x 0.8 = 14.4 must not round to 14 (-22 %)');
    assert.deepEqual(only(run([f({ module: 'gov', id: 'G3', log: [5], value: 0.07, se: 0.005, text: 'droop 7 %: F too low (GOVT)' })]), 'G3').to, 20); // the documented F step 10
});

test('guard 5: every value stays within its firmware range (settings.c); at a limit the step is a watch', () => {
    assert.deepEqual([advice.RANGE.yaw_cw_stop_gain, advice.RANGE.yaw_collective_ff_gain, advice.RANGE.pitch_collective_ff_gain, advice.RANGE.gov_f_gain, advice.RANGE.roll_p_gain, advice.RANGE.dyn_notch_q, advice.RANGE.blackbox_rate_denom],
        [[25, 250], [0, 250], [0, 250], [0, 250], [0, 1000], [10, 100], [1, 8000]]);
    for (const k of Object.keys(advice.PARAMS)) if (!/^gyro_rpm_notch_(source|q|center)_/.test(k) && k !== 'gyro_lpf1_type') assert.ok(advice.RANGE[k], `${k} has no firmware range`);
    const h = (o) => ({ header: Object.assign({}, HEADER, o) }), t5 = f({ id: 'T5', value: 2, se: 0.2, larger: 'ccw', text: 'stops' });
    const stop = only(run([t5], h({ yaw_stop_gain: [120, 26] })), 'T5');                     // 26 x 0.9 = 23, below 25
    assert.deepEqual(stop.cli, ['profile 0', 'set yaw_ccw_stop_gain = 25']);
    assert.match(stop.caveats.join(' '), /limited to 25-250 by the firmware .*: 23 becomes 25/);
    assert.equal(only(run([f({ id: 'T7', value: 0.8, se: 0.05, precompScale: 1.44, text: 'x' })], h({ yaw_precomp: [5, 10, 230] })), 'T7').to, 250);   // 230 x 1.2 = 276
    assert.equal(only(run([f({ module: 'gov', id: 'G3', log: [5], value: 0.07, se: 0.005, text: 'droop 7 %: F too low (GOVT)' })], h({ govPID: [40, 50, 0, 245, 40] })), 'G3').to, 250);
    assert.equal(only(run([f({ module: 'more', id: 'C14', axis: 'pitch', value: 60, se: 5, gainChange: 100, gainChangeSe: 10, text: 'c14' })], h({ pitch_compensation: 240 })), 'C14').to, 250); // 240 + 48 bounded
    const floor = only(run([t5], h({ yaw_stop_gain: [120, 25] })), 'T5');
    assert.deepEqual([floor.severity, floor.cli], ['watch', []]);
    assert.match(floor.caveats.join(' '), /yaw_ccw_stop_gain is at its firmware limit 25: no further step this way; .*move the other one/);
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
    assert.match(zero.caveats.join(' '), /confirm the active profile/);
    const two = only(run([t5(2)], { cli: CLI }), 'T5');                       // the CLI diff has no stop gain for profile 1: the 4.6 default 80
    assert.deepEqual(two.cli, ['profile 1', 'set yaw_ccw_stop_gain = 72']);
});

test('guard 7: a profile the CLI capture lacks (a plain diff prints the current one only) is unknown, not the 4.6 default', () => {
    const plain = setup.parseCli('diff\n# version\n# Rotorflight / STM32F7X2 (S7X2) 4.6.0\n\n# master\nset motor_poles = 24,0,0,0\n\nprofile 0\nset yaw_ccw_stop_gain = 100\n\nrateprofile 0\n');
    assert.equal(plain.kind, 'diff');
    const out = run([f({ id: 'T5', profile: 3, value: 2, se: 0.2, larger: 'ccw', text: 'stops' })], { cli: plain });
    const r = only(out, 'T5');
    assert.deepEqual(r.cli, [], 'the default 80 was an assumption: profile 2 is not in the capture');
    assert.match(r.caveats.join(' '), /the CLI capture has no profile 2 section \(a plain diff or dump prints the current profile only\): load `diff all`/);
    assert.match(out.notes.join(' '), /the CLI capture holds profile section\(s\) 0 of 6 \(CLI index\): a plain `diff` prints the current profile only/);
    assert.deepEqual(only(run([f({ id: 'T5', profile: 1, value: 2, se: 0.2, larger: 'ccw', text: 'stops' })], { cli: plain, headerProfile: 2 }), 'T5').cli, ['profile 0', 'set yaw_ccw_stop_gain = 90'], 'the section it has');
    const all = setup.parseCli('diff all\n' + [0, 1, 2, 3, 4, 5].map(p => `profile ${p}\n`).join(''));
    assert.ok(!run([], { cli: all }).notes.some(n => /holds profile section/.test(n)), 'a diff all prints every profile');
});

test('guard 8: no governor gain change where G0 says DIRECT/LIMIT, or the CLI says so and no log shows a PID governor', () => {
    const g3 = f({ module: 'gov', id: 'G3', log: [5], value: 0.07, se: 0.005, text: 'droop 7 %: F too low (GOVT)' });
    const direct = run([g3, f({ module: 'gov', id: 'G0', severity: 'note', profile: null, value: 0, text: 'govSum and govI are 0 in flight: DIRECT or LIMIT' })]);
    assert.equal(recs(direct, 'G3').length, 0);
    assert.match(direct.notes.join(' '), /guard 8/);
    const cliDirect = setup.parseCli(CLI_TEXT.replace('gov_mode = ELECTRIC', 'gov_mode = DIRECT'));
    assert.equal(recs(run([g3], { cli: cliDirect }), 'G3').length, 0);
    assert.equal(recs(run([g3, f({ module: 'gov', id: 'G0', severity: 'ok', profile: null, value: 100, text: 'PID governor running' })], { cli: cliDirect }), 'G3').length, 1, 'the data show a PID governor: trust the data');
});

test('guard 9: D2 stalls and F5 lines that a tail notch of unknown order may cover are never actions', () => {
    const out = run([f({ module: 'setup', id: 'D2', profile: null, value: 0, text: '0 logging gaps in the log; in this segment 0 time jumps (0 frames missing, by loopIteration), 1 loop stalls' }),
        f({ module: 'setup', id: 'F5', value: 4.061, text: 'line at 4.061 x rotor (155.7 Hz, prominence 394.5): nearest notch roll 14 at 4 (1.5 %), pitch 14 at 4 (1.5 %), yaw 12 at 2 (103.0 %)' })]);
    for (const id of ['D2', 'F5']) assert.equal(only(out, id).severity, 'check', id);
});

test('guard 10: wag_report section 8 is never used', () => {
    const out = run([f({ module: 'wag_report', id: 'T10', value: 2, text: 'yaw P 71.5 -> 54.7 for gain margin 2.1' })], { decisions: [Object.assign(decision(), { module: 'wag_report' })] });
    assert.equal(out.recommendations.filter(r => /^(T10|C7)/.test(r.id)).length, 0);
    assert.match(out.notes.join(' '), /2 item\(s\) from wag_report\.cjs section 8 ignored/);
});

test('guard 11: tuning order preconditions, filters, governor, cyclic, tail, rates; pitch before roll; GOVT F before I before P', () => {
    const out = run([TRACK('R1', { axis: 'roll', value: 80, se: 5, text: 'r' }), f({ id: 'T5', value: 2, se: 0.2, larger: 'ccw', text: 's' }),
        f({ id: 'C3', axis: 'roll', value: -0.3, se: 0.05, gyroRatio: { mean: 1, se: 0.01 }, text: 'FF too high' }), f({ id: 'C3', axis: 'pitch', value: -0.3, se: 0.05, gyroRatio: { mean: 1, se: 0.01 }, text: 'FF too high' }),
        f({ module: 'gov', id: 'G9', value: 9, se: 1, text: '(P-type)' }), f({ module: 'gov', id: 'G9', profile: 1, value: 9, se: 1, text: '(I-type)' }), f({ module: 'gov', id: 'G4', log: [5], value: 0.05, se: 0.004, text: '(load onset)' }),
        f({ module: 'setup', id: 'F6', value: 6, se: 1, text: 'f6' }), f({ module: 'gov', id: 'G1', profile: null, value: 1, text: 'g1' })]);
    const ids = out.recommendations.map(r => r.id);
    const at = (p) => ids.findIndex(i => i.startsWith(p));
    assert.ok(at('G1') < at('F6') && at('F6') < at('G4') && at('G4') < at('G9:gov_i') && at('G9:gov_i') < at('G9:gov_p'), ids.join(' '));
    assert.ok(at('G9:gov_p') < at('C3:pitch') && at('C3:pitch') < at('C3:roll') && at('C3:roll') < at('T5') && at('T5') < at('R1'), ids.join(' '));
    assert.deepEqual(out.recommendations.map(r => r.order), ids.map((_, i) => i + 1));
});

test('guard 12: every CLI name is a Rotorflight 4.6 name from health_setup PAIRS or TUNING_KNOWLEDGE', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tools/autotune/health_setup.cjs'), 'utf8');
    const pairs = new Function('require', 'module', 'exports', src + '\nreturn { PAIRS_PROFILE, PAIRS_GLOBAL };')((m) => require(path.join(ROOT, 'tools/autotune', m)), { exports: {} }, {});
    const known = new Map(pairs.PAIRS_PROFILE.concat(pairs.PAIRS_GLOBAL).map(p => [p[2].replace(/\[\d\]$/, ''), p[3]]));
    const doc = fs.readFileSync(path.join(ROOT, 'docs/TUNING_KNOWLEDGE.md'), 'utf8');
    for (const [name, [scope, , , def]] of Object.entries(advice.PARAMS)) {
        assert.ok(known.has(name) || doc.includes('`' + name + '`'), `${name} is neither in health_setup PAIRS nor in TUNING_KNOWLEDGE.md`);
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
    assert.match(old.caveats.join(' '), /yaw_stop_gain changed between logs/);
    // its step was sized on the old setting: no target, the present value only (Gaui #49 at 120/80 against 140/100 later)
    assert.deepEqual([old.title, old.from, old.to, old.direction], ['Re-measure yaw_ccw_stop_gain on the present setup', 80, null, 'check']);
    assert.match(old.text, /yaw_ccw_stop_gain is now 80 \(log header/);
    assert.doesNotMatch(old.text, /-> 72/);
    assert.equal(only(run([Object.assign({}, t5, { log: 6 }), h], { headerLog: 6 }), 'T5').cli.length, 2, 'measured after the change, on the analysed log');
});

test('merge: two checks on one parameter make one recommendation; opposite directions make a check', () => {
    const c4 = f({ id: 'C4', axis: 'roll', value: 25, se: 3, settleS: { mean: 0.2, se: 0.02 }, text: 'FF too low (raise F)' });
    const same = only(run([C3UP, c4]), 'C');
    assert.equal(same.id, 'C3:roll_f_gain:p1');
    assert.match(same.caveats.join(' '), /also: C4 says raise to 110/);
    assert.equal(same.evidence.length, 2);
    const opposite = only(run([f({ id: 'C3', axis: 'roll', value: -0.3, se: 0.05, gyroRatio: { mean: 1, se: 0.01 }, text: 'FF too high' }), c4]), 'C');
    assert.equal(opposite.severity, 'check');
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
    for (const r of out.coverage) assert.ok(['finding', 'checked', 'no-check', 'not-assessable', 'needs-cli', 'needs-fields', 'needs-flights'].includes(r.status), r.group);
    const row = (g) => out.coverage.find(r => r.group === g);
    assert.equal(row('Stop gains').status, 'finding');
    assert.equal(row('Governor F').status, 'needs-flights');
    // no check of the app: no-check where a log could tell (the data are logged), not-assessable where no log can
    assert.equal(row('Yaw B').status, 'no-check');
    assert.equal(row('Static notches').status, 'no-check');
    assert.equal(row('I-term relax level').status, 'not-assessable');
    assert.match(row('I-term relax level').detail, /CLI only: load a CLI dump/);
    assert.equal(row('ESC endpoints').status, 'not-assessable');
    assert.equal(run([], { cli: CLI }).coverage.find(r => r.group === 'Cyclic ring').status, 'not-assessable');
    assert.equal(run([]).coverage.find(r => r.group === 'Motor poles and gear ratios').status, 'needs-cli');
    const raw = run([], { fields: { 'gyroRAW[0]': 'absent' } }).coverage.find(r => r.group === 'Motor poles and gear ratios');
    assert.equal(raw.status, 'needs-fields', 'without raw gyro F5/F6 cannot run even with a dump');
    assert.match(raw.detail, /fields not logged: gyroRAW\[0\].*load a CLI dump/);
});

test('coverage: a row counts the findings about its own parameters', () => {
    const row = (out, g) => out.coverage.find(r => r.group === g);
    // T13 says tail trim, not the gains: it marks the tail mechanics, not yaw I
    const t13 = run([f({ module: 'more', id: 'T13', value: 0.3, se: 0.02, text: 'hover yaw I: the integrator carries a constant hover trim; check the tail centre and zero-pitch calibration (tail_center_trim, MIXS), not the gains' })]);
    assert.notEqual(row(t13, 'Yaw I').status, 'finding');
    assert.equal(row(t13, 'Tail mechanics and limit').status, 'finding');
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
    assert.equal(row(run([f({ id: 'T6', value: 50, se: 5, towardTorque: { mean: 30, se: 5 }, text: 'kick' })]), 'Precomp cutoff').status, 'no-check');
});

test('coverage: no check reads ESC telemetry; the PID mode is judged on the CLI capture', () => {
    const row = (out, g) => out.coverage.find(r => r.group === g);
    const esc = run([f({ module: 'gov', id: 'G12', profile: null, value: 1.2, se: 0.001, text: 'main rotor line at 1.2 x' })], { fields: { Tesc: 'present', Ibat: 'present', EscRPM: 'absent' } });
    assert.equal(row(esc, 'ESC telemetry').status, 'no-check', 'a G12 flag is about poles and gear');
    assert.match(row(esc, 'ESC telemetry').detail, /none read by a check: EscRPM absent, .*Tesc present, Ibat present/);
    assert.equal(row(esc, 'Motor poles and gear ratios').status, 'finding');
    assert.equal(row(run([]), 'PID mode').status, 'needs-cli');
    assert.equal(row(run([], { cli: CLI }), 'PID mode').status, 'checked', 'a diff leaves the default 3 out');
    assert.match(row(run([], { cli: CLI }), 'PID mode').detail, /CLI pid_mode: 3 \(absent from the diff: the default\) on profile\(s\) 0, 1/);
    const four = run([], { cli: setup.parseCli(CLI_TEXT + 'set pid_mode = 4\n') });
    assert.equal(row(four, 'PID mode').status, 'finding');
    const r = only(four, 'SETUP:pid_mode');
    assert.deepEqual([r.severity, r.cli], ['check', []]);
    assert.match(r.text, /pid_mode is 4 on CLI profile 1: every gain recommendation here assumes 3/);
});

test('advise is pure and deterministic', () => {
    const input = { findings: [C3UP, f({ id: 'T8', value: 4, text: '4 s at an output limit (mixer[2])' }), f({ module: 'setup', id: 'D2', profile: null, value: 0, text: '1 loop stalls' })], decisions: [decision()], header: HEADER, cli: CLI, logs: LOGS, fields: { 'gyroRAW[0]': 'present' }, headerProfile: 1, headerLog: 5 };
    const before = JSON.stringify(input), a = JSON.stringify(advice.advise(input)), b = JSON.stringify(advice.advise(JSON.parse(before)));
    assert.equal(JSON.stringify(input), before, 'input changed');
    assert.equal(a, b);
});

test('script: global settings first, then per profile, then save; nothing without actions', () => {
    const out = run([C3UP, f({ module: 'setup', id: 'F1', profile: null, value: 0, text: 'no LPF' })], { header: Object.assign({}, HEADER, { gyro_soft_type: 0, gyro_lowpass_hz: 0 }) });
    const lines = advice.script(out.recommendations).split('\n').filter(l => !l.startsWith('#'));
    assert.deepEqual(lines, ['set gyro_lpf1_type = FIRST_ORDER', 'set gyro_lpf1_static_hz = 100', 'save'], 'the F raise waits for the filter change');
    const two = advice.script(run([f({ id: 'T5', value: 2, se: 0.2, larger: 'ccw', text: 's' }), f({ id: 'T5', profile: 2, value: 2, se: 0.2, larger: 'ccw', text: 's' })], { cli: CLI }).recommendations).split('\n').filter(l => !l.startsWith('#'));
    assert.deepEqual(two, ['profile 0', 'set yaw_ccw_stop_gain = 72', 'profile 1', 'set yaw_ccw_stop_gain = 72', 'save']);
    assert.equal(advice.script(run([]).recommendations), '');
    // a title is one comment line whatever it holds: no line of a title reaches the CLI
    const odd = [{ severity: 'action', scope: 'global', title: 'Lower LPF\nset motor_poles = 2', cli: ['set gyro_lpf1_static_hz = 100'] },
        { severity: 'action', scope: 'profile', title: 'Raise yaw P\r\nsave\n', cli: ['profile 0', 'set yaw_p_gain = 63'] }];
    const text = advice.script(odd), commands = text.split('\n').filter(l => !l.startsWith('#'));
    assert.deepEqual(commands, ['set gyro_lpf1_static_hz = 100', 'profile 0', 'set yaw_p_gain = 63', 'save']);
    assert.ok(text.includes('# Lower LPF set motor_poles = 2\n') && text.includes('# Raise yaw P save\n'), text);
});

test('loading: siblings only, no Node API at load, Chromium-99 safe, runs through a CommonJS shim', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tools/autotune/advice.cjs'), 'utf8'), code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.deepEqual([...code.matchAll(/require\(([^)]*)\)/g)].map(m => m[1]), ["'./lib.cjs'", "'./health_setup.cjs'", "'./health_gov.cjs'", "'./health_loop.cjs'", "'./health_track.cjs'", "'./health_more.cjs'"]);
    assert.ok(!/\bprocess\.|\bBuffer\b|__dirname|node:/.test(code));
    assert.ok(!/\.toSorted\(|\.toReversed\(|\.toSpliced\(|Object\.groupBy|Map\.groupBy|Array\.fromAsync|\.with\(/.test(code));
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', src)((m) => require(path.join(ROOT, 'tools/autotune', m)), mod, mod.exports);
    assert.equal(typeof mod.exports.advise, 'function');
    assert.equal(mod.exports.advise({}).recommendations[0].id, 'D4:cli');
    // health_track and health_more are optional in the app (js/tuning_worker.js OPTIONAL): advice loads and runs without them
    const bare = { exports: {} };
    new Function('require', 'module', 'exports', src)((m) => { if (/health_(track|more)/.test(m)) throw new Error(`Cannot find module '${m}'`); return require(path.join(ROOT, 'tools/autotune', m)); }, bare, bare.exports);
    const out = bare.exports.advise({ findings: [C3UP], header: HEADER, logs: LOGS, headerProfile: 1 });
    assert.deepEqual(out.recommendations.find(r => r.id.startsWith('C3')).cli, ['profile 0', 'set roll_f_gain = 115']);
    assert.deepEqual(Object.keys(advice).sort(), ['CHECKS', 'COVERAGE', 'PARAMS', 'RANGE', 'RULES', 'advise', 'floorsOk', 'script'], 'no unused exports');
});

let esbuild = null; try { esbuild = require('esbuild'); } catch (e) { /* optional */ }
test('Chromium 99: esbuild lowers nothing for target chrome99', { skip: !esbuild }, () => {
    const src = fs.readFileSync(path.join(ROOT, 'tools/autotune/advice.cjs'), 'utf8'), t = (target) => esbuild.transformSync(src, { target, format: 'cjs', loader: 'js' }).code;
    assert.equal(t('chrome99'), t('esnext'));
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
    assert.equal(by('F5').length, 1); assert.equal(by('F5')[0].severity, 'check'); assert.equal(by('F5')[0].evidence.length, 8);
    for (const id of ['T5', 'T6']) { assert.equal(by(id).length, 1, id); assert.equal(by(id)[0].severity, 'watch', id); }
    assert.equal(out.recommendations.filter(r => r.cli.length).length, 0, out.recommendations.filter(r => r.cli.length).map(r => r.id).join(', '));
    assert.equal(by('T8')[0].severity, 'check');
    assert.equal(by('C7').length, 3);
    assert.ok(by('C7').every(r => r.severity === 'info'));
});

test('real data, Fireball 2026-09-28: the LPF first; the report.cjs pitch F change waits for it; governor and tail raises get no CLI', { skip: !fs.existsSync(path.join(ROOT, FIRE, 'health.json')) }, () => {
    const out = advice.advise(realInput(FIRE, 'analysis/fireball-0928/tune/results.json', 18, null));
    for (const r of out.recommendations.filter(x => x.cli.length)) {
        assert.equal(r.severity, 'action', r.id); assert.deepEqual(r.blockedBy, [], r.id);
        assert.ok(r.cli.every(l => /^(profile \d|set \w+ = [\w,]+)$/.test(l)), r.cli.join('; '));
    }
    assert.deepEqual(advice.script(out.recommendations).split('\n').filter(l => !l.startsWith('#')), ['set gyro_lpf1_type = FIRST_ORDER', 'set gyro_lpf1_static_hz = 100', 'save']);
    const c7 = out.recommendations.find(r => r.id === 'C7:pitch_f_gain:p2');   // 4500 rpm = profile 2; recovered F 100 = header F 100
    if (c7) { assert.deepEqual([c7.severity, c7.from, c7.to, c7.cli], ['action', 100, 80, []]); assert.match(c7.blockedBy.join(' '), /filters first: make the filter change/); }
    assert.ok(out.recommendations.filter(r => r.area === 'governor').every(r => !r.cli.length), 'G1 FALLBACK flags block governor changes');
    assert.ok(out.recommendations.filter(r => r.area === 'tail' && r.direction === 'raise').every(r => !r.cli.length), 'T8 tail-limit flags block tail raises');
});
