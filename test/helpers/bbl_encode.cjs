'use strict';

/**
 * Test helper: write simulated logs as a Rotorflight blackbox file (.bbl) that the app's own decoder reads back.
 *
 *   encode([log, ...]) -> { bytes: Uint8Array, names: [[main field names of each log]] }
 *   simulateFlight(options) -> log        one simulated 4.6 flight at 1 kHz with every field the toolkit reads
 *
 * log = { w, header, start, govState, airborne, rescueState, profile, slow, gapAt, gapFrames, rate } or { broken: true }
 *   w          columns as tools/autotune/lib.cjs segments() returns them: sp/gyro deg/s, u/P/I/D/F/B fraction of authority
 *              (written x 1000), hs rpm, coll raw, extra { name: raw column }; integers are written rounded
 *   govState, airborne, rescueState, profile   Uint8Array per frame or null: GOVERNOR_STATE (50), AIRBORNE_STATE (52),
 *              RESCUE_STATE (51) and INFLIGHT_ADJUSTMENT func 2 (13) events where the value changes. The decoder starts
 *              governor, airborne and rescue state at 0, so a non-zero start is written at frame 1 (an event before the
 *              first frame is attached to no chunk); the profile at frame 0 is not written, as a flight controller does not log it
 *   slow       { name: column } slow fields (flightModeFlags, ...): an S-frame before frame 0 and wherever one changes
 *   gapAt      frame index (a multiple of 32: an I-frame) where gapFrames frames are lost: LOGGING_RESUME (14)
 *   broken     a header without field definitions: the decoder reports a parse error for this log
 *
 * Every main field uses predictor 0 and signed variable-byte encoding, so P-frames carry raw values too: an I-frame
 * every 32 frames, P interval 1/1, looptime 500 us, pid_process_denom 2 (1 kHz logging).
 */

const EV = { INFLIGHT_ADJUSTMENT: 13, LOGGING_RESUME: 14, GOVERNOR_STATE: 50, RESCUE_STATE: 51, AIRBORNE_STATE: 52, LOG_END: 255 };
const PRODUCT = 'Blackbox flight data recorder by Nicholas Sherlock';

function vbU(out, v) { v = v >>> 0; while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; } out.push(v); }
function vbS(out, v) { v = Math.round(v) | 0; vbU(out, ((v << 1) ^ (v >> 31)) >>> 0); }
const ascii = (out, s) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff); };

function encodeLog(log) {
    const out = [], H = (k, v) => ascii(out, `H ${k}:${Array.isArray(v) ? v.join(',') : v}\n`);
    H('Product', PRODUCT); H('Data version', 2);
    if (log.broken) { H('Firmware type', 'Rotorflight'); H('Firmware revision', 'Rotorflight 4.6.0 (sim)'); ascii(out, 'garbage'); return { bytes: Uint8Array.from(out), names: [] }; }
    const { w } = log, n = w.n, rate = log.rate || w.rate || 1000, cols = [], names = [];
    const add = (name, col, k = 1) => { if (col) { names.push(name); cols.push(k === 1 ? col : Float64Array.from(col, v => v * k)); } };
    const time = new Float64Array(n), iter = new Float64Array(n); let us = 1e6, it = 0;
    for (let i = 0; i < n; i++) { if (log.gapAt !== null && log.gapAt !== undefined && i === log.gapAt) { us += log.gapFrames * 1e6 / rate; it += log.gapFrames; } time[i] = Math.round(us); iter[i] = it; us += 1e6 / rate; it++; }
    add('loopIteration', iter); add('time', time);
    const zero = new Float64Array(n); // the decoder needs setpoint, gyro, mixer, P, I, D, F and headspeed: a fixture without them logs zeros
    for (const [k, base] of [['P', 'axisP'], ['I', 'axisI'], ['D', 'axisD'], ['F', 'axisF'], ['B', 'axisB']]) for (let a = 0; a < 3; a++) add(`${base}[${a}]`, w[k] ? w[k][a] : k === 'B' ? null : zero, 1000);
    for (let a = 0; a < 3; a++) add(`setpoint[${a}]`, w.sp[a]);
    add('setpoint[3]', w.coll);
    for (let a = 0; a < 3; a++) add(`gyroADC[${a}]`, w.gyro[a]);
    for (let a = 0; a < 3; a++) add(`mixer[${a}]`, w.u[a], 1000);
    add('headspeed', w.hs);
    for (const [k, v] of Object.entries(w.extra || {})) if (v && !names.includes(k) && k !== 'time' && k !== 'loopIteration') add(k, v);
    const slow = Object.entries(log.slow || {});
    H('I interval', 32); H('P interval', '1/1'); H('P ratio', 32);
    H('Field I name', names); H('Field I signed', names.map((s, j) => j < 2 ? 0 : 1)); H('Field I predictor', names.map(() => 0)); H('Field I encoding', names.map(() => 0));
    H('Field P predictor', names.map(() => 0)); H('Field P encoding', names.map(() => 0));
    if (slow.length) { H('Field S name', slow.map(s => s[0])); for (const k of ['signed', 'predictor']) H(`Field S ${k}`, slow.map(() => 0)); H('Field S encoding', slow.map(() => 1)); }
    const fixed = { 'Firmware type': 'Rotorflight', 'Firmware revision': 'Rotorflight 4.6.0 (sim) STM32F7X2', 'Log start datetime': log.start || '2026-10-04T12:00:00.000+00:00', 'Craft name': 'sim', looptime: 500, pid_process_denom: 2 };
    for (const [k, v] of Object.entries(Object.assign(fixed, log.header || {}))) if (v !== null && v !== undefined) H(k, v);
    const E = (type, write) => { out.push('E'.charCodeAt(0), type); write(); };
    const prev = { gov: 0, air: 0, rescue: 0, prof: log.profile ? log.profile[0] : 0 };
    for (let i = 0; i < n; i++) {
        if (i >= 1) {
            if (log.govState && log.govState[i] !== prev.gov) { prev.gov = log.govState[i]; E(EV.GOVERNOR_STATE, () => vbU(out, prev.gov)); }
            if (log.airborne && log.airborne[i] !== prev.air) { prev.air = log.airborne[i]; E(EV.AIRBORNE_STATE, () => vbU(out, prev.air)); }
            if (log.rescueState && log.rescueState[i] !== prev.rescue) { prev.rescue = log.rescueState[i]; E(EV.RESCUE_STATE, () => vbU(out, prev.rescue)); } // unsigned VB, flightlog_parser.js:1543
            if (log.profile && log.profile[i] !== prev.prof) { prev.prof = log.profile[i]; E(EV.INFLIGHT_ADJUSTMENT, () => { out.push(2); vbS(out, prev.prof); }); }
        }
        if (log.gapAt === i) E(EV.LOGGING_RESUME, () => { vbU(out, iter[i]); vbU(out, time[i]); });
        if (slow.length && (i === 0 || slow.some(([, c]) => c[i] !== c[i - 1]))) { out.push('S'.charCodeAt(0)); for (const [, c] of slow) vbU(out, c[i]); }
        out.push((i % 32 === 0 ? 'I' : 'P').charCodeAt(0));
        for (let j = 0; j < cols.length; j++) vbS(out, cols[j][i]);
    }
    E(EV.LOG_END, () => ascii(out, 'End of log\0'));
    return { bytes: Uint8Array.from(out), names };
}

function encode(logs) {
    const parts = logs.map(encodeLog), bytes = new Uint8Array(parts.reduce((s, p) => s + p.bytes.length, 0)); let o = 0;
    for (const p of parts) { bytes.set(p.bytes, o); o += p.bytes.length; }
    return { bytes, names: parts.map(p => p.names) };
}

// ---------------------------------------------------------------------------------------------
// A simulated flight
// ---------------------------------------------------------------------------------------------

// The header of a Rotorflight 4.6.0 log as the firmware writes it (Gaui X4 II, 2026-10-04), without the field
// definitions and the loop timing, which encodeLog writes
const HEADER_46 = {
    'Firmware date': 'Jun 30 2026 07:20:47', 'Board information': 'RDMS NEXUS_F7', features: 1946158088, gyro_scale: '0x3f800000', acc_1G: 2048,
    vbat_scale: 110, vbatcellvoltage: [330, 350, 430], vbatref: 0, currentSensor: [0, 400], gyro_sync_denom: 1, filter_process_denom: 2,
    rates_type: 6, rc_rates: [50, 50, 80], rc_expo: [40, 40, 50], rates: [12, 12, 12], response_time: [0, 0, 0], accel_limit: [0, 0, 0],
    rollPID: [50, 100, 0, 100, 0], pitchPID: [50, 100, 40, 100, 0], yawPID: [100, 140, 14, 0, 0], levelPID: [40, 55, 40, 75], govPID: [40, 50, 0, 10, 40],
    rollBW: [50, 15, 15], pitchBW: [50, 15, 15], yawBW: [100, 20, 20], iterm_relax_type: 2, iterm_relax_cutoff: [10, 10, 10], error_limit: [45, 45, 60],
    error_decay: [250, 12], error_decay_ground: 25, cyclic_coupling: [50, 0, 25], yaw_stop_gain: [120, 80], yaw_precomp: [5, 10, 60],
    yaw_inertia_precomp: [0, 25], yaw_tta: [0, 20], hsi_gain: [50, 50], hsi_limit: [90, 90], pitch_compensation: 0, deadband: 5, yaw_deadband: 5,
    gyro_to_use: 0, gyro_hardware_lpf: 0, gyro_decimation_hz: 500, gyro_lpf1_type: 1, gyro_lpf1_static_hz: 100, gyro_lpf1_dyn_hz: [0, 0],
    gyro_lpf2_type: 0, gyro_lpf2_static_hz: 50, gyro_notch_hz: [0, 0], gyro_notch_cutoff: [0, 0], dyn_notch_count: 6, dyn_notch_q: 25,
    dyn_notch_min_hz: 20, dyn_notch_max_hz: 240, dshot_bidir: 0, gyro_rpm_notch_preset: 1, gyro_rpm_notch_min_hz: 20,
    gyro_rpm_notch_source_pitch: [11, 12, 14, 21], gyro_rpm_notch_center_pitch: [0, 0, 0, 0], gyro_rpm_notch_q_pitch: [80, 40, 60, 50],
    gyro_rpm_notch_source_roll: [11, 12, 14, 21], gyro_rpm_notch_center_roll: [0, 0, 0, 0], gyro_rpm_notch_q_roll: [80, 40, 60, 50],
    gyro_rpm_notch_source_yaw: [11, 12, 21], gyro_rpm_notch_center_yaw: [0, 0, 0], gyro_rpm_notch_q_yaw: [80, 40, 50],
    acc_lpf_hz: 1000, acc_hardware: 0, baro_hardware: 0, mag_hardware: 1, gyro_cal_on_first_arm: 0, serialrx_provider: 9, use_unsynced_pwm: 1,
    motor_pwm_protocol: 0, motor_pwm_rate: 250, minthrottle: 1070, maxthrottle: 2000, collectiveRange: [-1250, 1250], debug_mode: 0, debug_axis: 0, fields_mask: 4714111,
};
const { SCALE } = require('../../tools/autotune/lib.cjs'); // gain scaling of pid.h
const GOV = { OFF: 0, SPOOLUP: 2, ACTIVE: 4 };
const RESCUE = { OFF: 0, PULLUP: 1, CLIMB: 3, EXIT: 5, pullupS: 0.3, exitS: 0.5 }; // FLIGHT_LOG_RESCUE_STATES; rescue_exit_time default 0.5 s (pg/pid.c:95)
const RESCUE_BIT = 5, ANGLE_BIT = 1; // FLIGHT_LOG_FLIGHT_MODE_NAME_RF_4_6 (js/flightlog_fielddefs.js): ARM 0, ANGLE 1, HORIZON 2, TRAINER 3, ALTHOLD 4, RESCUE 5

function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function gauss(rand) { return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand()); }

/**
 * One flight at 1 kHz: governor OFF, SPOOLUP from 1 s, ACTIVE from 4 s to 2 s before the end; airborne over
 * `airborne` [from, to] s (null: a bench run that never leaves the ground or spools up); PID profiles from `profiles`
 * [{ from s, profile, target rpm }] (the first is the arming profile, which the log does not name); stick steps on
 * three axes through a PID mode 3 loop with the header gains around first-order airframes; collective pumps; rotor
 * lines at 1x, 2x and 4.061x in gyroRAW, 10 % of them in gyroADC; flightModeFlags with RESCUE over `rescue` [from, to] s
 * and ANGLE over `level` [from, to] s. RESCUE_STATE as the firmware logs a rescue: PULLUP at the switch, CLIMB after 0.3 s,
 * EXIT from the switch drop for rescue_exit_time 0.5 s, then OFF, so the state outlasts the switch (Gaui #58: EXIT to OFF
 * 0.50 s each time). Truth for the tests: `truth.rescueFrames` (switch on), `truth.rescueStateFrames` (state not OFF),
 * `truth.levelFrames`, the targets per profile, the frame count.
 */
function simulateFlight(o = {}) {
    o = Object.assign({ seconds: 60, seed: 1, profiles: [{ from: 0, profile: 1, target: 2500 }], airborne: [6, 54], rescue: null, level: null, gapAt: null, gapFrames: 300, header: {}, start: '2026-10-04T12:00:00.000+00:00' }, o);
    const RATE = 1000, dt = 1 / RATE, n = Math.round(o.seconds * RATE), rand = rng(o.seed), col = () => new Float64Array(n), u8 = () => new Uint8Array(n);
    const hdr = Object.assign({}, HEADER_46, o.header), G = [hdr.rollPID, hdr.pitchPID, hdr.yawPID];
    const w = { n, rate: RATE, sp: [col(), col(), col()], gyro: [col(), col(), col()], u: [col(), col(), col()], P: [col(), col(), col()], I: [col(), col(), col()], D: [col(), col(), col()], F: [col(), col(), col()], hs: col(), coll: col(), extra: {} };
    const X = {}; for (const k of ['gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]', 'rcCommand[0]', 'rcCommand[1]', 'rcCommand[2]', 'rcCommand[3]', 'mixer[3]', 'govTarget', 'govRequest', 'govSum', 'govP', 'govI', 'govD', 'govF', 'motor[0]', 'Vbat', 'Ibat', 'servo[0]', 'servo[1]', 'servo[2]', 'servo[3]']) X[k] = col();
    w.extra = X;
    const govState = u8(), airborne = u8(), rescueState = u8(), profile = u8(), flags = col(), zeros = col(), ones = col().fill(1);
    const plant = [{ K: 400, tau: 0.06, delay: 10, A: 250 }, { K: 400, tau: 0.08, delay: 20, A: 200 }, { K: 500, tau: 0.06, delay: 8, A: 300 }];
    const pt1 = (fc) => 1 / (RATE / (2 * Math.PI * fc) + 1);
    const ax = plant.map(() => ({ goal: 0, next: 0, rc: 0, sp: 0, y: 0, gyro: 0, gyro1: 0, dF: 0, Ii: 0, gust: 0, hist: new Float64Array(64) }));
    let hs = 0, theta = 0, coll = 0, collGoal = 0, nextPump = 8, pumpEnd = 0, rescued = 0, rescueStates = 0, levelled = 0;
    const flying = (t) => o.airborne && t >= o.airborne[0] && t < o.airborne[1];
    for (let i = 0; i < n; i++) {
        const t = i * dt, p = o.profiles.filter(q => q.from <= t).pop(), air = flying(t);
        const state = !o.airborne ? GOV.OFF : t < 1 ? GOV.OFF : t < 4 ? GOV.SPOOLUP : t < o.seconds - 2 ? GOV.ACTIVE : GOV.OFF;
        govState[i] = state; airborne[i] = air ? 1 : 0; profile[i] = p.profile;
        // collective: hover with a pump every 2.5 to 4 s while airborne
        if (air && t >= nextPump) { collGoal = (rand() < 0.25 ? -500 : 650 + 300 * rand()); pumpEnd = t + 0.6 + 0.4 * rand(); nextPump = t + 2.5 + 1.5 * rand(); }
        if (t >= pumpEnd) collGoal = air ? 200 : 0;
        coll += (collGoal - coll) * pt1(6); const cAbs = Math.abs(coll) / 1000;
        // rotor and governor
        const target = p.target, full = state === GOV.ACTIVE || state === GOV.SPOOLUP;
        if (state === GOV.SPOOLUP) hs = target * (t - 1) / 3; else if (state === GOV.ACTIVE) hs += (target - 60 * cAbs - hs) * pt1(0.5) + gauss(rand) * 3; else hs -= hs * dt;
        hs = Math.max(0, hs); theta += hs / 60 * dt;
        const thr = state === GOV.ACTIVE ? Math.min(1, Math.max(0, 0.35 + 0.35 * cAbs + 2 * (target - hs) / target)) : state === GOV.SPOOLUP ? 0.4 * (t - 1) / 3 : 0;
        const gP = state === GOV.ACTIVE ? 2 * (target - hs) / target : 0, gF = state === GOV.ACTIVE ? 0.35 * cAbs : 0;
        X.govTarget[i] = full ? target : 0; X.govRequest[i] = full ? target : 0; X.govSum[i] = Math.round(thr * 1000);
        X.govP[i] = Math.round(gP * 1000); X.govF[i] = Math.round(gF * 1000); X.govI[i] = X.govSum[i] - X.govP[i] - X.govF[i]; X.govD[i] = 0; X['motor[0]'][i] = X.govSum[i];
        X.Ibat[i] = Math.round(200 + 4000 * thr); X.Vbat[i] = Math.round(2520 - 1.5 * t - 150 * thr + gauss(rand) * 2);
        // three rate loops: stick steps -> rcCommand -> setpoint; PID mode 3 with the header gains; first-order airframe with a delay
        const lines = [0, 1, 2].map(a => 20 * Math.sin(2 * Math.PI * theta + a) + 6 * Math.sin(4 * Math.PI * theta + 1 + a) + 8 * Math.sin(2 * Math.PI * 4.061 * theta + 2 * a));
        for (let a = 0; a < 3; a++) {
            const s = ax[a], pl = plant[a], g = G[a];
            if (t >= s.next) { s.goal = rand() < 0.4 ? 0 : (2 * rand() - 1) * pl.A * (air ? 1 : 0.05); s.next = t + 0.3 + 1.2 * rand(); }
            s.rc += (s.goal - s.rc) * pt1(8); s.sp += (s.rc - s.sp) * pt1(12);
            const e = s.sp - s.gyro, dG = (s.gyro - s.gyro1) / dt; s.dF += (dG - s.dF) * pt1(50);
            const P = SCALE.P[a] * g[0] * e, D = -SCALE.D[a] * g[2] * s.dF, F = SCALE.F[a] * g[3] * s.sp;
            if (air) s.Ii += e * dt; else s.Ii *= 0.99;
            const I = Math.max(-0.5, Math.min(0.5, SCALE.I[a] * g[1] * s.Ii)), u = Math.max(-1, Math.min(1, P + I + D + F));
            s.hist.copyWithin(1, 0); s.hist[0] = u;
            s.gust += (gauss(rand) * 40 - s.gust) * pt1(1);
            const torque = a === 2 ? 0.35 * coll : 0;
            if (air) s.y += (pl.K * s.hist[pl.delay] - s.y + s.gust + torque) * dt / pl.tau; else s.y = 0;
            s.gyro1 = s.gyro; s.gyro = s.y + 0.1 * lines[a] + gauss(rand) * 0.5;
            w.sp[a][i] = Math.round(s.sp); w.gyro[a][i] = Math.round(s.gyro); X[`gyroRAW[${a}]`][i] = Math.round(s.y + lines[a] + gauss(rand) * 2);
            w.u[a][i] = Math.round(u * 1000) / 1000; w.P[a][i] = Math.round(P * 1000) / 1000; w.I[a][i] = Math.round(I * 1000) / 1000;
            w.D[a][i] = Math.round(D * 1000) / 1000; w.F[a][i] = Math.round(F * 1000) / 1000; X[`rcCommand[${a}]`][i] = Math.round(s.rc * 500 / pl.A);
        }
        w.hs[i] = Math.round(hs); w.coll[i] = Math.round(coll); X['mixer[3]'][i] = w.coll[i]; X['rcCommand[3]'][i] = Math.round(coll * 0.4);
        const ur = w.u[0][i], up = w.u[1][i];
        X['servo[0]'][i] = Math.round(1500 + 300 * (ur + up) + 0.4 * coll); X['servo[1]'][i] = Math.round(1500 + 300 * (-ur + up) + 0.4 * coll);
        X['servo[2]'][i] = Math.round(1500 - 300 * up + 0.4 * coll); X['servo[3]'][i] = Math.round(1500 + 500 * w.u[2][i]);
        const inRescue = !!o.rescue && t >= o.rescue[0] && t < o.rescue[1], inLevel = !!o.level && t >= o.level[0] && t < o.level[1];
        rescueState[i] = inRescue ? (t < o.rescue[0] + RESCUE.pullupS ? RESCUE.PULLUP : RESCUE.CLIMB) : o.rescue && t >= o.rescue[1] && t < o.rescue[1] + RESCUE.exitS ? RESCUE.EXIT : RESCUE.OFF;
        rescued += inRescue ? 1 : 0; rescueStates += rescueState[i] ? 1 : 0; levelled += inLevel ? 1 : 0;
        flags[i] = 1 | (inRescue ? 1 << RESCUE_BIT : 0) | (inLevel ? 1 << ANGLE_BIT : 0);
    }
    return { w, header: hdr, start: o.start, govState, airborne: o.airborne ? airborne : null, rescueState: o.rescue ? rescueState : null, profile,
        gapAt: o.gapAt === null ? null : Math.round(o.gapAt * RATE / 32) * 32, gapFrames: o.gapFrames,
        slow: { flightModeFlags: flags, stateFlags: zeros, failsafePhase: zeros, rxSignalReceived: ones, rxFlightChannelsValid: ones },
        truth: { frames: n, rescueFrames: rescued, rescueStateFrames: rescueStates, levelFrames: levelled, targets: Object.fromEntries(o.profiles.map(q => [q.profile, q.target])) } };
}

module.exports = { encode, encodeLog, simulateFlight, HEADER_46, EV };
