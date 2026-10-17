// Ground-truth checks for tools/autotune/health_setup.cjs: synthetic headers, CLI dumps and raw/filtered gyro with
// known lines and known notch attenuation; the module must recover them, and a clean setup must raise no flag.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../tools/autotune/lib.cjs');
const hs = require('../tools/autotune/health_setup.cjs');

const app = lib.loadApp();
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function gauss(rand) { return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand()); }
const within = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);

// a 4.6 header as the decoder returns it; features: GOVERNOR, FREQ_SENSOR, RPM_FILTER
const FEATURES = (1 << 26) | (1 << 28) | (1 << 30);
function header(over = {}) {
    return Object.assign({ 'Firmware revision': 'Rotorflight 4.6.0 (sim)', firmwareVersion: '4.6.0', looptime: 500, pid_process_denom: 2, filter_process_denom: 2, frameIntervalPNum: 1, frameIntervalPDenom: 1,
        features: FEATURES, gyro_soft_type: 1, gyro_lowpass_hz: 100, gyro_soft2_type: 0, gyro_lowpass2_hz: 50, gyro_lowpass_dyn_hz: [0, 0], gyro_notch_hz: [0, 0], gyro_notch_cutoff: [0, 0],
        dyn_notch_count: 6, dyn_notch_q: 25, dyn_notch_min_hz: 20, dyn_notch_max_hz: 240, gyro_rpm_notch_preset: 0, gyro_rpm_notch_min_hz: 20,
        gyro_rpm_notch_source_roll: [11, 12, 21], gyro_rpm_notch_q_roll: [80, 40, 50], gyro_rpm_notch_center_roll: [0, 0, 0],
        gyro_rpm_notch_source_pitch: [11, 12, 21], gyro_rpm_notch_q_pitch: [80, 40, 50], gyro_rpm_notch_center_pitch: [0, 0, 0],
        gyro_rpm_notch_source_yaw: [11, 12, 21], gyro_rpm_notch_q_yaw: [80, 40, 50], gyro_rpm_notch_center_yaw: [0, 0, 0],
        rollPID: [50, 100, 0, 100, 0], pitchPID: [50, 100, 40, 100, 0], yawPID: [80, 120, 10, 0, 0], rollBW: [50, 20, 15], pitchBW: [50, 20, 15], yawBW: [100, 20, 20],
        govPID: [40, 50, 0, 10, 40], yaw_stop_gain: [120, 80], yaw_precomp: [5, 10, 60], yaw_inertia_precomp: [0, 25], yaw_tta: [0, 20], collectiveRange: [-1250, 1250] }, over);
}

/**
 * A whole-log segment: two profiles (3500 and 4500 rpm, headspeed wandering +-50 rpm), lines at rotor orders with a known
 * amplitude and a known pass gain through the filters, optional fixed-frequency lines, white noise shared by raw and
 * filtered gyro. gyroADC = raw - (1 - gain) x line, so the attenuation at a line is -20 log10(gain) exactly.
 */
function makeW({ seconds = 120, rate = 1000, lines = [], fixed = [], hdr = header(), raw = true, jumpAt = null, lost = true, seed = 1, wander = 50 } = {}) {
    const n = seconds * rate, rand = rng(seed), col = () => new Float64Array(n);
    const w = { flight: { header: hdr, log: 0, id: 'sim', rate, actualRate: rate, gaps: 0, frames: n, durationS: n / rate, start: '2026-09-28T00:00:00' },
        n, rate, fromS: 0, sp: [col(), col(), col()], gyro: [col(), col(), col()], u: [col(), col(), col()], P: [col(), col(), col()], I: [col(), col(), col()], D: [col(), col(), col()],
        F: [col(), col(), col()], B: [null, null, null], hs: col(), coll: col(), profileAt: new Uint8Array(n), airborneAt: new Uint8Array(n).fill(1), extra: {} };
    for (const k of hs.EXTRA) w.extra[k] = null;
    const rawG = [col(), col(), col()], time = col(), iter = col(); let rev = 0, us = 0, it = 0;
    for (let i = 0; i < n; i++) {
        const t = i / rate, p = t < seconds / 2 ? 1 : 2, h = (p === 1 ? 3500 : 4500) + wander * Math.sin(2 * Math.PI * 0.05 * t);
        w.hs[i] = h; w.profileAt[i] = p; if (i) rev += h / 60 / rate;
        // a jump of 70 frame times: 70 frames lost (loopIteration jumps too) or, with lost false, a stalled loop (iteration contiguous)
        us += 1e6 / rate; it++; if (jumpAt !== null && i === Math.round(jumpAt * rate)) { us += 70 * 1e6 / rate; if (lost) it += 70; } time[i] = us; iter[i] = it;
        for (let a = 0; a < 3; a++) {
            let r = gauss(rand), f = r;
            for (const l of lines) { const v = l.amp * Math.sin(2 * Math.PI * l.order * rev + a); r += v; f += l.gain * v; }
            for (const l of fixed) { const v = l.amp * Math.sin(2 * Math.PI * l.hz * t + a); r += v; f += l.gain * v; }
            rawG[a][i] = r; w.gyro[a][i] = f;
        }
    }
    if (raw) for (let a = 0; a < 3; a++) w.extra[`gyroRAW[${a}]`] = rawG[a];
    w.extra.time = time; w.extra.loopIteration = iter; w.extra.govSum = col().fill(600); w.extra.govI = col().fill(100); w.extra.govTarget = w.hs; w.extra.Vbat = col().fill(2400); w.extra.Ibat = col();
    for (let s = 0; s < 4; s++) w.extra[`servo[${s}]`] = col().fill(1500 + s); w.extra['motor[0]'] = col().fill(600);
    return w;
}
const ctxOf = (w, extra = {}) => Object.assign({ flying: new Uint8Array(w.n).fill(1), profile: Uint8Array.from(w.profileAt), govState: null, app, gear: { main: [1, 1], tail: [19, 76], motorisedTail: false } }, extra);
const flag = (F, id) => F.filter(f => f.id === id && f.severity === 'flag');

const CLEAN_LINES = [{ order: 1, amp: 30, gain: 0.1 }, { order: 2, amp: 10, gain: 0.1 }, { order: 4, amp: 8, gain: 0.1 }];

test('notch source codes decode as rpm_filter.c and motors.c say', () => {
    const gear = { main: [1, 1], tail: [19, 76], motorisedTail: false };
    assert.deepEqual([11, 12, 14, 18].map(c => hs.decodeNotchSource(c, gear).order), [1, 2, 4, 8]);
    assert.equal(hs.decodeNotchSource(21, gear).order, 4);           // tail: headspeed x tail[1]/tail[0]
    assert.equal(hs.decodeNotchSource(22, gear).order, 8);
    assert.equal(hs.decodeNotchSource(10, gear).enabled, false);     // main motor notch off for direct drive
    const geared = { main: [10, 100], tail: [20, 60], motorisedTail: false };
    assert.equal(hs.decodeNotchSource(10, geared).order, 10);         // motor turns 10 x rotor
    assert.equal(hs.decodeNotchSource(21, geared).order, 3);
    assert.equal(hs.decodeNotchSource(21, null).order, null);         // no gear ratios: tail unknown
    assert.equal(hs.decodeNotchSource(31, gear).kind, 'invalid');
});

test('clean setup: attenuation recovered, no flag', () => {
    const w = makeW({ lines: CLEAN_LINES }), m = hs.analyse(w, ctxOf(w));
    for (const row of m.F6.rows) {
        assert.ok(row.n >= 10, `${row.axis} ${row.code} windows ${row.n}`);
        within(row.db, 20, 1, `${row.axis} ${row.code} profile ${row.profile} attenuation`);
        assert.ok(row.se < 0.5, `standard error ${row.se}`);
    }
    const F = hs.judge([{ log: 0, start: w.flight.start, header: w.flight.header, metrics: m }], hs.DEFAULT_RULES);
    assert.deepEqual(F.filter(f => f.severity === 'flag').map(f => f.id + ': ' + f.text), []);
    assert.ok(F.some(f => f.id === 'F5' && f.severity === 'ok'));
    assert.equal(m.D2.timeJumps, 0);
});

test('an unnotched rotor-locked line and a weak notch are found; a fixed-frequency line is not rotor-locked', () => {
    const lines = [{ order: 1, amp: 30, gain: 0.1 }, { order: 2, amp: 10, gain: 0.5 }, { order: 4, amp: 8, gain: 0.1 }, { order: 3.79, amp: 6, gain: 1 }];
    const w = makeW({ lines, fixed: [{ hz: 250, amp: 5, gain: 1 }], seed: 2, wander: 5 }), m = hs.analyse(w, ctxOf(w)); // steady, governed headspeed: a fixed line stays sharp within a profile
    const F = hs.judge([{ log: 0, start: w.flight.start, header: w.flight.header, metrics: m }], hs.DEFAULT_RULES);
    // F6: 2x rotor notch passes half the line: 6.02 dB
    for (const row of m.F6.rows.filter(r => r.code === 12)) within(row.db, 20 * Math.log10(2), 0.5, `${row.axis} notch 12 profile ${row.profile}`);
    const f6 = flag(F, 'F6'); assert.equal(f6.length, 6);
    for(const f of f6){assert.match(f.text,/Examine the notch filter center and bandwidth/);assert.doesNotMatch(f.text,/mis-centred or too narrow/);} assert.ok(f6.every(f => /notch filter source 12/.test(f.text)));
    // F5: the 3.79 line, in both profiles, rotor-locked, 5.3 % from the tail notch
    const f5 = flag(F, 'F5'); assert.equal(f5.length, 2);
    for (const p of [1, 2]) {
        const l = m.F5.lines.find(v => v.profile === p && Math.abs(v.order - 3.79) < 0.01);
        assert.ok(l, `profile ${p}: line near 3.79 found`); within(l.order, 3.79, 0.003, 'order'); assert.equal(l.rotorLocked, true);
        for (const a of l.axes) within(a.amplitude, 6, 0.5, `${a.axis} amplitude`);
        const fx = m.F5.lines.find(v => v.profile === p && Math.abs(v.hz - 250) < 2);
        assert.ok(fx, `profile ${p}: fixed 250 Hz line found`); assert.equal(fx.rotorLocked, false);
    }
});

test('header checks: rate, LPF, Q, D cutoff, dynamic notch, aliasing', () => {
    const w = makeW({ seconds: 10, rate: 500, raw: false, hdr: header({ looptime: 1000, gyro_soft_type: 0, gyro_lowpass_hz: 0, gyro_rpm_notch_q_yaw: [15, 40, 50], yawBW: [100, 40, 20] }) });
    const m = hs.analyse(w, ctxOf(w)), F = hs.judge([{ log: 0, start: w.flight.start, header: w.flight.header, metrics: m }], hs.DEFAULT_RULES);
    assert.equal(flag(F, 'D1').length, 1);
    assert.equal(flag(F, 'F1').length, 1);
    assert.equal(F.find(f => f.id === 'F2').severity, 'ok', 'no gyro LPF: no cutoff adds a delay, not "Not measured"');
    const f3 = flag(F, 'F3'); assert.equal(f3.length, 1); assert.equal(f3[0].value, 1.5);
    assert.equal(F.find(f => f.id === 'F4' && f.profile === 'yaw').severity, 'note');
    assert.equal(F.find(f => f.id === 'F4' && f.profile === 'roll').severity, 'ok');
    assert.equal(m.F8.pidHz, 500); assert.equal(m.F8.forcedOff, true); assert.equal(F.find(f => f.id === 'F8').severity, 'note');
    // tail 1st at 4 x 4500/60 = 300 Hz, logged at 500 Hz: alias at 200 Hz; also above the notch ceiling 0.45 x 500
    const row = m.F9.rows.find(v => v.profile === 2 && v.axis === 'roll' && v.code === 21);
    within(row.hz, 300, 5, 'tail notch Hz'); within(row.aliasHz, 200, 5, 'alias'); assert.equal(row.aboveCeiling, true);
    assert.equal(m.F5.skipped, 'The log does not have gyroRAW.');
    assert.ok(m.D3.skips.some(s => s.checks.includes('F5')));
    assert.ok(m.D3.skips.some(s => s.checks.includes('power')));   // Ibat all zero

    const low = makeW({ seconds: 2, raw: false, hdr: header({ gyro_lowpass_hz: 55 }) }), m2 = hs.analyse(low, ctxOf(low));
    const f2 = hs.judge([{ log: 1, start: 'x', header: low.flight.header, metrics: m2 }], hs.DEFAULT_RULES).find(f => f.id === 'F2');
    assert.equal(f2.severity, 'flag'); assert.equal(f2.value, 55);
    const mid = makeW({ seconds: 2, raw: false, hdr: header({ gyro_lowpass_hz: 70 }) });
    assert.equal(hs.judge([{ log: 2, start: 'x', header: mid.flight.header, metrics: hs.analyse(mid, ctxOf(mid)) }], hs.DEFAULT_RULES).find(f => f.id === 'F2').severity, 'note');
});

test('a missing stretch of frames is reported where it happens', () => {
    const w = makeW({ seconds: 5, raw: false, jumpAt: 2.5 }), m = hs.analyse(w, ctxOf(w));
    assert.equal(m.D2.timeJumps, 1); assert.equal(m.D2.missingFrames, 70); assert.equal(m.D2.loopStalls, 0); assert.equal(m.D2.missingFramesFrom, 'loopIteration');
    within(m.D2.events[0].t, 2.5, 0.01, 'event time');
    assert.equal(flag(hs.judge([{ log: 0, start: 'x', header: w.flight.header, metrics: m }], hs.DEFAULT_RULES), 'D2').length, 1);
});

test('a time jump over contiguous loopIteration is a loop stall, not lost frames (Fireball log 17 at 226.789 s)', () => {
    const w = makeW({ seconds: 5, raw: false, jumpAt: 2.5, lost: false }), m = hs.analyse(w, ctxOf(w));
    assert.equal(m.D2.missingFrames, 0); assert.equal(m.D2.timeJumps, 0); assert.equal(m.D2.loopStalls, 1); assert.equal(m.D2.iterationJumps, 0);
    within(m.D2.events[0].t, 2.5, 0.01, 'event time'); assert.match(m.D2.events[0].kind, /loop stall/);
    const d2 = hs.judge([{ log: 0, start: 'x', header: w.flight.header, metrics: m }], hs.DEFAULT_RULES).find(f => f.id === 'D2');
    assert.match(d2.text, /0 missing frames/); assert.match(d2.text, /number of loop stalls is 1/); assert.equal(d2.counts.loopStalls, 1); assert.equal(d2.counts.missingFrames, 0);
});

const CLI = `diff all
# Rotorflight / STM32G47X (SG47) 4.6.0 Jun 30 2026
feature -DYN_NOTCH
feature RPM_FILTER
mixer input SC -1250 1250 1070
set gyro_lpf1_type = FIRST_ORDER
set tail_rotor_gear_ratio = 19,76
set gov_mode = DIRECT
set pid_process_denom = 2
set gyro_rpm_notch_preset = 0
set gyro_rpm_notch_source_roll = 11,12,21,0,0
set gyro_rpm_notch_q_roll = 80,40,50,0,0
set gyro_rpm_notch_source_pitch = 11,12,21
set gyro_rpm_notch_q_pitch = 80,40,50
set gyro_rpm_notch_source_yaw = 11,12,21
set gyro_rpm_notch_q_yaw = 80,40,50
set gyro_rpm_notch_center_roll = 0
set gyro_rpm_notch_center_pitch = 0
set gyro_rpm_notch_center_yaw = 0
profile 0
set yaw_p_gain = 70
set roll_d_cutoff = 20
set pitch_d_cutoff = 20
set roll_gyro_cutoff = 50
set gov_headspeed = 1800
profile 1
set yaw_p_gain = 60
set roll_d_cutoff = 20
set pitch_d_cutoff = 20
profile 0
rateprofile 0
set roll_rc_rate = 50
`;

test('CLI: parsed, compared with the header, gear ratios used, governor mode checked against the data', () => {
    const cli = hs.parseCli(CLI);
    assert.equal(cli.kind, 'diff'); assert.equal(cli.version, '4.6.0');
    assert.deepEqual(cli.global.tail_rotor_gear_ratio, [19, 76]); assert.equal(cli.profiles[1].yaw_p_gain, 60); assert.equal(cli.features.DYN_NOTCH, false);
    assert.deepEqual(cli.mixerInputs.SC, [-1250, 1250, 1070]); assert.equal(cli.rateprofiles[0].roll_rc_rate, 50);
    // header yaw P 65, log starts on profile 1 -> CLI profile 0 (yaw P 70): one mismatch; header dyn notch off agrees
    const w = makeW({ seconds: 4, raw: false, hdr: header({ yawPID: [65, 120, 10, 0, 0] }) }), ctx = ctxOf(w, { cli: CLI }); delete ctx.gear;
    const m = hs.analyse(w, ctx);
    assert.equal(m.D4.profileCompared, 0);
    assert.deepEqual(m.D4.mismatches.map(v => v.header), ['yawPID[0]']);
    assert.equal(m.setup.rpm.banks.roll.find(b => b.code === 21).order, 4);   // gear from the CLI
    const d4 = hs.judge([{ log: 0, start: 'x', header: w.flight.header, metrics: m }], hs.DEFAULT_RULES).find(f => f.id === 'D4');
    assert.equal(d4.severity, 'flag'); assert.match(d4.text, /`yawPID\[0\]` is `65`/); assert.match(d4.text, /`yaw_p_gain` is `70`/); assert.match(d4.text, /gov_mode is `DIRECT`, but the data shows `PID governor/); assert.deepEqual(d4.mismatches, m.D4.mismatches);
    // agreeing header: the only flag left is the governor mode
    const w2 = makeW({ seconds: 4, raw: false, hdr: header({ yawPID: [70, 120, 10, 0, 0] }) }), c2 = ctxOf(w2, { cli: CLI }); delete c2.gear;
    const m2 = hs.analyse(w2, c2); assert.equal(m2.D4.mismatches.length, 0); assert.ok(m2.D4.compared > 40);
    // no CLI dump (an optional input, user rule 2026-10-06): no D4 metric and no D4 result, not a result that was not done
    const m3 = hs.analyse(w2, ctxOf(w2));
    assert.equal(m3.D4, undefined);
    assert.deepEqual(hs.judge([{ log: 0, start: 'x', header: w2.flight.header, metrics: m3 }], hs.DEFAULT_RULES).filter(f => f.id === 'D4'), []);
});

test('header change table: gains that changed between logs on the same starting profile', () => {
    const mk = (log, start, over, sp) => ({ log, start, header: header(over), metrics: { startProfile: sp } });
    const rows = hs.headerChanges([mk(2, '2026-09-28T12', { yawPID: [60, 120, 10, 0, 0] }, 1), mk(0, '2026-09-28T10', {}, 1), mk(1, '2026-09-28T11', { yawPID: [70, 120, 10, 0, 0] }, 2)]);
    assert.deepEqual(rows.map(r => [r.log, r.since, r.key, r.from, r.to]), [[2, 0, 'yawPID', '80,120,10,0,0', '60,120,10,0,0']]);
    const rows2 = hs.headerChanges([mk(0, 'a', {}, 1), mk(1, 'b', { gyro_lowpass_hz: 80 }, 2)]);
    assert.deepEqual(rows2.map(r => [r.key, r.scope]), [['gyro_lowpass_hz', 'global']]);
});

test('header history follows recorded log order when the clock is unset or moves backwards', () => {
    const mk = (log, start, p) => ({ log, start, header: header({ yawPID: [p, 120, 10, 0, 0] }), metrics: { startProfile: 1 } });
    const rows = hs.headerChanges([
        mk(49, '2026-10-04T17:54:08.312+00:00', 80),
        mk(58, '0000-01-01T00:00:00.000+00:00', 100),
        mk(59, '2026-10-03T12:00:00.000+00:00', 120)
    ]);
    assert.deepEqual(rows.map(r => [r.log, r.since, r.from, r.to]), [
        [58, 49, '80,120,10,0,0', '100,120,10,0,0'],
        [59, 58, '100,120,10,0,0', '120,120,10,0,0']
    ]);
    const files = hs.headerChanges([
        mk('10:0', '0000-01-01T00:00:00.000+00:00', 120),
        mk('2:11', '2026-10-04T17:54:08.312+00:00', 100),
        mk('2:9', '2026-10-04T18:54:08.312+00:00', 80)
    ]);
    assert.deepEqual(files.map(r => [r.log, r.since]), [['2:11', '2:9'], ['10:0', '2:11']]);
});

test('a real capture: the prompt echo "# diff all" is a diff, with the 4.6 defaults filled in', () => {
    const real = '\r\n# diff all\r\n\r\n# version\r\n# Rotorflight / STM32G47X (SAB1) 4.6.0 Jun 30 2026\r\n' + CLI.split('\n').slice(2).join('\r\n');
    const cli = hs.parseCli(real);
    assert.equal(cli.kind, 'diff');
    assert.equal(hs.parseCli('# dump\n# version\nset gyro_lpf1_type = PT1\n').kind, 'dump');
    const w = makeW({ seconds: 4, raw: false, hdr: header({ yawPID: [70, 120, 10, 0, 0] }) }), c = ctxOf(w, { cli: real }); delete c.gear;
    const m = hs.analyse(w, c);
    assert.equal(m.D4.cliKind, 'diff'); assert.ok(m.D4.compared > 40, `compared ${m.D4.compared}`);
    assert.deepEqual(m.setup.rpm.gear.main, [1, 1], 'absent main gear ratio taken as the default 1,1');
    // pid_mode is a profile setting (cli/settings.c PROFILE_VALUE): per profile, default for a diff
    assert.deepEqual(m.D4.cliOnly.pid_mode, { 0: '3 (default, absent from diff)', 1: '3 (default, absent from diff)' });
    const m2 = hs.analyse(w, Object.assign(ctxOf(w, { cli: real.replace('profile 1\r\n', 'profile 1\r\nset pid_mode = 2\r\n') }), { gear: undefined }));
    assert.equal(m2.D4.cliOnly.pid_mode[1], 2);
});

test('every tail mode but VARIABLE is motorised: tail harmonics follow the tail motor, not the headspeed', () => {
    for (const [mode, motorised] of [['VARIABLE', false], ['MOTORIZED', true], ['BIDIRECTIONAL', true], ['2', true], ['0', false]]) {
        const cli = CLI.replace('set tail_rotor_gear_ratio = 19,76', `set tail_rotor_gear_ratio = 19,76\nset tail_rotor_mode = ${mode}`);
        const w = makeW({ seconds: 4, raw: false }), c = ctxOf(w, { cli }); delete c.gear;
        const g = hs.analyse(w, c).setup.rpm.gear;
        assert.equal(g.motorisedTail, motorised, mode);
        assert.equal(hs.decodeNotchSource(21, g).order, motorised ? null : 4, `${mode}: source 21 order`);
    }
    assert.equal(hs.decodeNotchSource(20, { main: [1, 1], tail: [1, 2], motorisedTail: true }).enabled, true);
});

test('no dynamic LPF without an LPF1 type, and no phantom notch for a disabled source', () => {
    const w = makeW({ seconds: 4, raw: false, hdr: header({ gyro_soft_type: 0, gyro_lowpass_dyn_hz: [30, 200] }) }), m = hs.analyse(w, ctxOf(w));
    assert.equal(m.setup.lpf1Dynamic.active, false); assert.deepEqual(m.F1.active, []); assert.equal(m.F2.lowestHz, null);
    const F = hs.judge([{ log: 0, start: 'x', header: w.flight.header, metrics: m }], hs.DEFAULT_RULES);
    assert.equal(F.find(f => f.id === 'F1').severity, 'flag', 'no gyro LPF with RPM filters on');
    // source 10 on a direct drive: the firmware creates no filter (rpm_filter.c enable10 = mainGearRatio != 1)
    const w2 = makeW({ seconds: 4, raw: false, hdr: header({ gyro_rpm_notch_source_roll: [10, 11], gyro_rpm_notch_q_roll: [80, 80], gyro_rpm_notch_center_roll: [0, 0] }) }), m2 = hs.analyse(w2, ctxOf(w2));
    assert.deepEqual(m2.setup.rpm.banks.roll.map(b => b.code), [11]);
    assert.ok(!m2.F9.rows.some(r => r.code === 10));
});

// ---- D4 with a parameter snapshot (IMP-05) --------------------------------------------------------------------------------

test('D4 with a parameter snapshot: every snapshot value against the dump, defaults of the dump build for a diff, the PID profile of each difference', () => {
    const snap = { global: { dyn_notch_count: 2, gov_mode: 'ELECTRIC', debug_mode: 'NONE' }, profiles: { 0: { pitch_p_gain: 50 }, 1: { pitch_p_gain: 99, yaw_i_gain: 116 } },
        rateprofiles: { 0: { roll_expo: 40 } }, features: { DYN_NOTCH: true, GOVERNOR: true }, mixerInputs: { SC: [-1250, 1250, 1070] } };
    const head = '# diff all\n# Rotorflight / STM32G47X (SG47) 4.7.0-bbp-pr Oct 14 2026 / 05:24:53 (85d7049a9) MSP API: 12.10\n', body =
        'feature -DYN_NOTCH\nfeature GOVERNOR\nmixer input SC -1250 1250 1070\nset gov_mode = ELECTRIC\nprofile 0\nprofile 1\nset pitch_p_gain = 90\nrateprofile 0\n';
    const text = head + 'board_name MATEKG474HELI\nmanufacturer_id MTKS\n' + body, diff = hs.parseCli(text);
    const CD = require('../tools/autotune/cli_defaults.cjs'), defaults = CD.forRevision(text);
    assert.equal(defaults.revision, '85d7049a9'); assert.equal(diff.board, 'MATEKG474HELI');
    // the defaults are of the board too: a dump of another board, or with no board line, gets none
    assert.equal(CD.forRevision(head + 'board_name OTHERBOARD\n' + body), null);
    assert.equal(CD.forRevision(head + body), null);
    assert.equal(CD.forRevision(text.replace('(85d7049a9)', '(deadbeef1)')), null);
    const rows = hs.compareSnapshot(snap, diff, defaults), bad = rows.filter(r => !r.match).map(r => [r.name, r.pidProfile, r.from]);
    // dyn_notch_count 2 against the default 6, pitch_p_gain of PID profile 2, DYN_NOTCH off in the diff; yaw_i_gain 116 against the default 120
    assert.deepEqual(bad, [['dyn_notch_count', null, 'default'], ['pitch_p_gain', 2, 'cli'], ['yaw_i_gain', 2, 'default'], ['feature DYN_NOTCH', null, 'cli']]);
    assert.ok(rows.some(r => r.name === 'gov_mode' && r.match) && rows.some(r => r.name === 'debug_mode' && r.from === 'default' && r.match));
    assert.ok(rows.some(r => r.name === 'mixer input SC' && r.match));
    // a dump of another build: only the values that the dump shows
    const other = hs.compareSnapshot(snap, diff, null);
    assert.deepEqual(other.filter(r => !r.match).map(r => r.name), ['pitch_p_gain', 'feature DYN_NOTCH']);
    // the D4 text of a snapshot (the STE harvest reads it here, with no real log): each difference with its PID profile, and the log wins
    const w = makeW({ seconds: 20, lines: CLEAN_LINES }), m = hs.analyse(w, ctxOf(w)), mm = rows.filter(r => !r.match);
    m.D4 = { basis: 'snapshot', defaults: defaults.revision, compared: rows.length, mismatches: mm, matches: rows.length - mm.length, cliKind: 'diff', cliOnly: {} };
    const f = hs.judge([{ log: 0, start: 0, header: w.flight.header, metrics: m }], hs.DEFAULT_RULES).find(x => x.id === 'D4');
    assert.deepEqual([f.severity, f.basis, f.value, f.n], ['flag', 'snapshot', 4, rows.length]);
    assert.match(f.text, /^The log header has the values of all PID profiles and rate profiles\. These values and the CLI dump have 4 different values out of \d+\./);
    assert.match(f.text, /`pitch_p_gain` of PID profile 2 is `99` in the log header\. It is `90` in the CLI dump\./);
    assert.match(f.text, /`yaw_i_gain` of PID profile 2 is `116` in the log header\. It is `120` in the CLI dump \(default value\)\./);
    assert.match(f.text, /For a value that the CLI dump does not show, the check uses the default value of the firmware `85d7049a9`\./);
    assert.match(f.text, /Thus, the CLI dump is not of the time of this log\. The analysis uses the values of the log header\.$/);
    const ok = hs.judge([{ log: 0, start: 0, header: w.flight.header, metrics: Object.assign({}, m, { D4: Object.assign({}, m.D4, { mismatches: [], defaults: null, cliKind: 'diff' }) }) }], hs.DEFAULT_RULES).find(x => x.id === 'D4');
    assert.equal(ok.severity, 'ok'); assert.match(ok.text, /Thus, it compares only the values that the CLI dump shows\./);
});

// review IMP-05: the gear ratios and the tail mode of the parameter snapshot of the log header rank above a CLI dump (health_setup and
// health_more gearOf); without a snapshot, the CLI dump as before
test('gearOf: the parameter snapshot of the log header gives the gear ratios, above a CLI dump', () => {
    const PL = require('../tools/autotune/param_log.cjs'), more = require('../tools/autotune/health_more.cjs');
    const body = [['Param log', '1'], ['param_mode', 'FULL'], ['param_loop', '1,1,1,128'], ['param_phase', 'pos=0,sp=0,pid=0,mix=0,mot=0,fupd=0,bb=0,flush=0'], ['param_pgs', '14.0/936'],
        ['param_fixes', '-'], ['param_rt', 'gov_mode=3,features=0,pid_denom=1,filter_denom=1,looptime=250,debug_mode=0,motors=1,servos=4'], ['param_pid_profile', '0'], ['param_rate_profile', '0'],
        ['set.main_rotor_gear_ratio', '1,1'], ['set.tail_rotor_gear_ratio', '19,76'], ['set.tail_rotor_mode', 'VARIABLE']];
    let hash = 2166136261; for (const [k, v] of body) hash = PL.fnv1(`H ${k}:${v}\n`, hash);
    body.push(['param_end', `${body.length},${(hash >>> 0).toString(16)}`]);
    const H = { paramHeader: body }, cliParsed = hs.parseCli('# diff all\nset tail_rotor_gear_ratio = 10,50\nset tail_rotor_mode = MOTORIZED\n');
    assert.deepEqual(hs.gearOf({ cliParsed }, H), { main: [1, 1], tail: [19, 76], motorisedTail: false, source: 'log snapshot' });
    assert.deepEqual(more.gearOf({ cli: '# diff all\nset tail_rotor_gear_ratio = 10,50\n' }, H), { main: [1, 1], tail: [19, 76], motorisedTail: false });
    assert.deepEqual(hs.gearOf({ cliParsed }, {}).tail, [10, 50], 'no snapshot: the CLI dump');
    assert.equal(hs.gearOf({ gear: { main: [1, 1], tail: [1, 4] } }, H).source, 'ctx.gear', 'a gear of the worker (the fit) first');
});

// review IMP-05: the 4.6.0 table is the table of 58a4bd5cc, 874f369d5 and 118e912 (the same pg and settings.c but blackbox_params),
// and fromDumps takes a name of a dump that its diff does not list, when the dumps agree
test('cli_defaults: the aliases of the 4.6.0 builds, and fromDumps from a dump and a diff of one session', () => {
    const CD = require('../tools/autotune/cli_defaults.cjs'), board = 'board_name MATEKG474HELI\n';
    for (const h of ['874f369d5', '118e912', '58a4bd5cc']) assert.equal(CD.forRevision(`# Rotorflight / STM32G47X (SG47) 4.6.0 Oct 13 2026 / 12:00:00 (${h}) MSP API: 12.9\n${board}`).revision, '58a4bd5cc', h);
    assert.equal(CD.revisionOf('Rotorflight 4.7.0-bbp-pr (85d7049a9) STM32G47X'), '85d7049a9');
    const head = '# Rotorflight / STM32G47X (SG47) 4.7.0-bbp-pr Oct 14 2026 / 05:24:53 (85d7049a9) MSP API: 12.10\n' + board;
    const dump = head + 'feature -GPS\nfeature RX_SERIAL\nset gyro_lpf1_static_hz = 100\nset debug_mode = NONE\nprofile 0\nset roll_p_gain = 50\nprofile 1\nset roll_p_gain = 50\nrateprofile 0\nset roll_rc_rate = 50\n';
    const diff = head + 'feature RX_SERIAL\nset gyro_lpf1_static_hz = 250\nprofile 1\nset roll_p_gain = 60\n';
    const t = CD.fromDumps([[dump, diff]], null);
    assert.deepEqual([t.revision, t.board], ['85d7049a9', 'MATEKG474HELI']);
    assert.deepEqual(t.global, { debug_mode: 'NONE' }, 'gyro_lpf1_static_hz is in the diff: not a default');
    assert.deepEqual(t.profile, { roll_p_gain: '50' }, 'profile 0 has the default, profile 1 is in the diff');
    assert.deepEqual(t.rateprofile, { roll_rc_rate: '50' });
    assert.deepEqual(t.features, { GPS: false, RX_SERIAL: false }, 'a feature of the diff has the other value');
    // two sessions that do not agree on a name: no default for it
    assert.equal(CD.fromDumps([[dump, diff], [dump.replace('debug_mode = NONE', 'debug_mode = GYRO'), diff]], null).global.debug_mode, undefined);
});

test('D4 on the crash log with the 16:53 dump: exactly the 12 differences', { skip: !process.env.PARAM_EPOCHS_LOG && 'PARAM_EPOCHS_LOG not set' }, (t) => {
    const fs = require('node:fs'), path = require('node:path');
    const cliFile = process.env.PARAM_EPOCHS_CLI || path.resolve(__dirname, '../analysis/fireball-rates-20261015/RTFL_cli_SAB_Fireball_20261015_165335.txt');
    if (!fs.existsSync(cliFile)) return t.skip('no CLI dump (PARAM_EPOCHS_CLI)');
    const cli = fs.readFileSync(cliFile, 'utf8');
    for (const w of lib.segments(app, process.env.PARAM_EPOCHS_LOG, { whole: true, extra: hs.EXTRA })) {
        if (w.skipped) continue;
        if (!hs.snapshotOfHeader(w.flight.header)) return t.skip('PARAM_EPOCHS_LOG is not a param log');
        const m = hs.analyse(w, { cli, rate: w.flight.actualRate || w.rate });
        assert.equal(m.D4.basis, 'snapshot'); assert.equal(m.D4.defaults, '85d7049a9');
        const names = m.D4.mismatches.map(v => (v.pidProfile ? `PID profile ${v.pidProfile} ` : '') + v.name).sort();
        assert.deepEqual(names, ['PID profile 2 pitch_i_gain', 'PID profile 2 pitch_p_gain', 'PID profile 2 roll_i_gain', 'PID profile 2 yaw_i_gain', 'PID profile 2 yaw_p_gain',
            'blackbox_log_esc', 'debug_mode', 'dyn_notch_count', 'dyn_notch_max_hz', 'dyn_notch_min_hz', 'dyn_notch_q', 'feature DYN_NOTCH']);
        const f = hs.judge([{ log: w.flight.log, start: 0, header: w.flight.header, metrics: m }]).find(x => x.id === 'D4');
        assert.equal(f.value, 12); assert.equal(f.severity, 'flag'); assert.equal(f.basis, 'snapshot');
        // each difference with its PID profile, and the log wins
        assert.match(f.text, /`pitch_p_gain` of PID profile 2 is `99` in the log header\. It is `90` in the CLI dump\./);
        assert.match(f.text, /`dyn_notch_count` is `2` in the log header\. It is `6` in the CLI dump \(default value\)\./);
        assert.match(f.text, /Thus, the CLI dump is not of the time of this log\. The analysis uses the values of the log header\./);
    }
});
