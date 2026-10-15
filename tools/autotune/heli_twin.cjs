'use strict';

// Six-degree-of-freedom single-rotor helicopter digital twin. See docs/HELICOPTER_SYSID_MODEL.md.
//
// Frames: body FLU (x forward, y left, z up), the frame of the Rotorflight gyro. World NWU (x north, y west,
// z up). Attitude is the quaternion body -> world. The logged attitude is ZYX Euler: roll about +x, pitch about
// +y (nose down positive) and heading, with yaw about +z = -heading.
//
// State (Float64Array, STATE names below): position, velocity (world), quaternion, body rate, tip-path-plane
// tilt (two flap angles), main rotor speed, induced inflow, four lagged actuator positions, moment and force
// disturbances, and the two barometer filter states. Inputs per sample: mixer roll/pitch/yaw and collective
// (normalized, 1 = 1000 in the log), throttle (0..1) and battery voltage.
//
// Minimum-complexity model in the manner of Gavrilets (2001) and Mettler (2003): momentum-theory thrust with
// dynamic inflow, first-order coupled flapping with rate and speed feedback, hub stiffness, tail rotor with
// inflow damping, a DC motor and rotor inertia, quadratic drag and the motor reaction torque on the body.

const VERSION = 2;
const KIND = 'heli-6dof';
const G = 9.80665, RHO = 1.2, DEG = Math.PI / 180, RPM = Math.PI / 30;
const MAIN_PITCH = 12 * DEG, TAIL_PITCH = 24 * DEG; // Rotorflight 4.6: one normalized command unit
const STATE = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'qw', 'qx', 'qy', 'qz', 'p', 'q', 'r', 'bx', 'by', 'omega', 'lambda',
    'aLat', 'aLon', 'aTail', 'aColl', 'dMx', 'dMy', 'dMz', 'dFx', 'dFy', 'dFz', 'baroAlt', 'baroVario', 'esc', 'hsSensor', 'gyroP', 'gyroQ', 'gyroR'];
const NX = STATE.length, S = Object.fromEntries(STATE.map((k, i) => [k, i]));
const finite = x => typeof x === 'number' && Number.isFinite(x);

// name, default (or null: from the craft prior), lower, upper, log scale, description
const PARAMS = [
    ['sa', 0.4, 0.05, 2, true, 'main rotor solidity times lift slope'],
    ['th0', 0, -6 * DEG, 6 * DEG, false, 'collective of zero thrust, rad'],
    ['cq0', 1e-4, 1e-6, 2e-3, true, 'profile torque coefficient'],
    ['tauF', 0.05, 0.005, 0.3, true, 'flapping time constant at reference speed, s'],
    ['gLat', 1, 0.1, 5, true, 'lateral flap per rad cyclic'],
    ['gLon', 1, 0.1, 5, true, 'longitudinal flap per rad cyclic'],
    ['phiU', 0, -0.6, 0.6, false, 'cyclic input cross-coupling angle, rad'],
    ['phiW', 0, -0.6, 0.6, false, 'rate feedback cross-coupling angle, rad'],
    ['lb', 3000, 100, 50000, true, 'roll acceleration per rad lateral flap at reference speed, rad/s2'],
    ['mb', 1500, 100, 50000, true, 'pitch acceleration per rad longitudinal flap at reference speed, rad/s2'],
    ['kmu', 0.5, 0, 5, false, 'blowback flap per unit advance ratio'],
    ['nt', 150, 5, 5000, true, 'yaw acceleration per rad tail pitch at reference speed, rad/s2'],
    ['tht0', 0, -15 * DEG, 15 * DEG, false, 'tail pitch of zero yaw moment from the tail, rad'],
    ['nr', 2, 0, 30, false, 'tail inflow yaw damping at reference speed, 1/s'],
    ['nc', 0, -2000, 2000, false, 'yaw acceleration per collective command at reference speed (rotor torque through the governed drivetrain), rad/s2'],
    ['ncd', 0, -100, 100, false, 'yaw acceleration per collective command rate, rad/s2 per 1/s'],
    ['izz', null, 0.001, 1, true, 'yaw inertia, kg m2'],
    ['kmV', 0.02, 1e-4, 1, true, 'motor torque per volt of applied voltage, N m/V'],
    ['kmW', 1e-3, 1e-6, 0.1, true, 'motor torque per rad/s of rotor speed, N m s'],
    ['ir', null, 1e-4, 0.2, true, 'rotor and drivetrain inertia, kg m2'],
    ['sx', 0.01, 1e-4, 0.5, true, 'forward drag area, m2'],
    ['sy', 0.03, 1e-4, 0.5, true, 'side drag area, m2'],
    ['sz', 0.05, 1e-4, 0.5, true, 'vertical drag area, m2'],
    ['dCyc', 0.01, 0, 0.06, false, 'cyclic transport delay, s'],
    ['dTail', 0.01, 0, 0.06, false, 'tail transport delay, s'],
    ['dColl', 0.01, 0, 0.06, false, 'collective transport delay, s'],
    ['tauS', 0.01, 0.004, 0.08, true, 'actuator lag, s'],
    ['tauEsc', 0.02, 0.004, 1, true, 'ESC response to the throttle command, s'],
    ['tauHs', 0.02, 0.004, 1, true, 'headspeed measurement filter, s'],
    ['tauB', 0.1, 0.02, 2, true, 'barometer altitude filter, s'],
    ['tauV', 0.2, 0.02, 2, true, 'barometer vario filter after the altitude filter, s'],
];
const PI = Object.fromEntries(PARAMS.map((p, i) => [p[0], i]));

function prior(craftPrior = {}) {
    const inertia = craftPrior.inertia && craftPrior.inertia.diagonal || [0.01, 0.03, 0.03];
    const radius = craftPrior.dimensionsM && craftPrior.dimensionsM.rotorRadius || 0.35;
    const spin = craftPrior.mainRotor && craftPrior.mainRotor.spinInertiaKgM2 || 0.002;
    return { massKg: craftPrior.massKg || 1, radiusM: radius, ixx: inertia[0], iyy: inertia[1], izzPrior: inertia[2],
        irPrior: spin * 1.3, tailArmM: craftPrior.dimensionsM ? craftPrior.dimensionsM.length * 0.6 : 0.4,
        tailHeightM: 0.04, rotorDirection: 1, gyroLowpassHz: 0 };
}

// A model is { version, kind, constants, params: {name: value}, refRpm, observer }.
function createModel(craftPrior, options = {}) {
    const constants = prior(craftPrior), params = {};
    for (const [name, value] of PARAMS) params[name] = value !== null ? value : name === 'izz' ? constants.izzPrior : constants.irPrior;
    Object.assign(params, options.params || {});
    // inertias stay within a factor of the geometry prior: the log cannot separate them from torque gains
    const bounds = { izz: [constants.izzPrior * 0.3, constants.izzPrior * 3], ir: [constants.irPrior * 0.5, constants.irPrior * 3] };
    return { version: VERSION, kind: KIND, constants, params, bounds, refRpm: options.refRpm || 4000,
        observer: Object.assign({ gyroNoise: 12, rateNoise: 0.3, momentWalk: 50, accelNoise: 1, forceWalk: 0.3, altNoise: 0.3, varioNoise: 0.2 }, options.observer) };
}

function paramBounds(model, name, lo = PARAMS[PI[name]][2], hi = PARAMS[PI[name]][3]) {
    const b = model && model.bounds && model.bounds[name];
    return b ? [Math.max(lo, b[0]), Math.min(hi, b[1])] : [lo, hi];
}
function validateModel(model) {
    const reasons = [];
    if (!model || model.version !== VERSION || model.kind !== KIND) return ['The model format is unknown.'];
    for (const [name, , lo0, hi0] of PARAMS) {
        const [lo, hi] = paramBounds(model, name, lo0, hi0), v = model.params && model.params[name];
        if (!finite(v) || v < lo - 1e-12 || v > hi + 1e-12) reasons.push(`The model parameter ${name} is out of range.`);
    }
    const c = model.constants || {};
    if (!['massKg', 'radiusM', 'ixx', 'iyy', 'tailArmM', 'tailHeightM'].every(k => finite(c[k]) && c[k] > 0)) reasons.push('The model constants are invalid.');
    if (!finite(model.refRpm) || model.refRpm < 500) reasons.push('The reference rotor speed is invalid.');
    return reasons;
}

// ---- rotations ----
function eulerToQuat(roll, pitch, yaw, out = new Float64Array(4)) {
    const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2), cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
    out[0] = cy * cp * cr + sy * sp * sr; out[1] = cy * cp * sr - sy * sp * cr; out[2] = cy * sp * cr + sy * cp * sr; out[3] = sy * cp * cr - cy * sp * sr;
    return out;
}
function quatToEuler(w, x, y, z, out = new Float64Array(3)) {
    out[0] = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
    out[1] = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
    out[2] = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    return out;
}
// Logged attitude (decidegrees: roll, pitch, heading) to the quaternion.
function attitudeQuat(roll, pitch, heading, out) { return eulerToQuat(roll * 0.1 * DEG, pitch * 0.1 * DEG, -heading * 0.1 * DEG, out); }

// ---- dynamics ----
// Working memory of one simulator. Inputs arrive one sample at a time through push(); delays read the history.
function createSim(model, rate) {
    const errors = validateModel(model); if (errors.length) throw new Error(errors.join(' '));
    if (!finite(rate) || rate < 50 || rate > 32000) throw new Error('The simulation rate is out of range.');
    const p = model.params, c = model.constants, dt = 1 / rate;
    const maxDelay = Math.ceil(0.07 * rate) + 2, hist = new Float64Array(maxDelay * 6);
    const sim = { model, rate, dt, x: new Float64Array(NX), hist, maxDelay, head: 0, count: 0,
        k1: new Float64Array(NX), k2: new Float64Array(NX), k3: new Float64Array(NX), k4: new Float64Array(NX), tmp: new Float64Array(NX),
        u: new Float64Array(6), aux: { thrust: 0, tail: 0, qm: 0 },
        ref: model.refRpm * RPM, collRef: model.collRef || 0, mass: c.massKg, R: c.radiusM, area: Math.PI * c.radiusM ** 2,
        // per-sample delayed inputs: [lat, lon, tail, coll] after delay, throttle, vbat
        din: new Float64Array(6) };
    sim.delaySamples = [p.dCyc, p.dCyc, p.dTail, p.dColl].map(d => d * rate);
    return sim;
}

// input: { u: [roll, pitch, yaw], coll, thr, vbat } in normalized units, throttle 0..1, volts.
function push(sim, input) {
    const k = sim.head * 6, h = sim.hist;
    h[k] = input.u[0]; h[k + 1] = input.u[1]; h[k + 2] = input.u[2]; h[k + 3] = input.coll; h[k + 4] = input.thr; h[k + 5] = input.vbat;
    sim.head = (sim.head + 1) % sim.maxDelay; sim.count++;
    const newest = (sim.head - 1 + sim.maxDelay) % sim.maxDelay, available = Math.min(sim.count, sim.maxDelay) - 1;
    for (let ch = 0; ch < 4; ch++) {
        const d = Math.min(sim.delaySamples[ch], available), i0 = Math.floor(d), f = d - i0;
        const a = (newest - i0 + sim.maxDelay) % sim.maxDelay, b = (newest - Math.min(i0 + 1, available) + sim.maxDelay) % sim.maxDelay;
        sim.din[ch] = h[a * 6 + ch] * (1 - f) + h[b * 6 + ch] * f;
    }
    sim.din[4] = input.thr; sim.din[5] = input.vbat;
}

function deriv(sim, x, dx) {
    const p = sim.model.params, c = sim.model.constants, din = sim.din, aux = sim.aux;
    const qw = x[6], qx = x[7], qy = x[8], qz = x[9];
    // rotation matrix body -> world
    const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qw * qz), r02 = 2 * (qx * qz + qw * qy);
    const r10 = 2 * (qx * qy + qw * qz), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qw * qx);
    const r20 = 2 * (qx * qz - qw * qy), r21 = 2 * (qy * qz + qw * qx), r22 = 1 - 2 * (qx * qx + qy * qy);
    const vwx = x[3], vwy = x[4], vwz = x[5];
    const ub = r00 * vwx + r10 * vwy + r20 * vwz, vb = r01 * vwx + r11 * vwy + r21 * vwz, wb = r02 * vwx + r12 * vwy + r22 * vwz;
    const P = x[10], Q = x[11], Rr = x[12], bx = x[13], by = x[14];
    const omega = Math.max(x[15], 0.05 * sim.ref), n = omega / sim.ref, tipSpeed = omega * sim.R;
    const mu = Math.sqrt(ub * ub + vb * vb) / tipSpeed, lambdaC = wb / tipSpeed, lambda = lambdaC + x[16];
    // thrust from blade element theory with uniform inflow
    const thColl = MAIN_PITCH * x[20] - p.th0;
    const ct = p.sa / 2 * (thColl / 3 * (1 + 1.5 * mu * mu) - lambda / 2);
    const dyn = RHO * sim.area * tipSpeed * tipSpeed, thrust = dyn * ct;
    const lambdaSS = ct / (2 * Math.sqrt(mu * mu + lambda * lambda + 1e-4));
    // flapping: tip-path-plane tilt about body x and y
    const tau = p.tauF / n, cu = Math.cos(p.phiU), su = Math.sin(p.phiU), cw = Math.cos(p.phiW), sw = Math.sin(p.phiW);
    const iLat = p.gLat * MAIN_PITCH * x[17], iLon = p.gLon * MAIN_PITCH * x[18];
    const fx = cu * iLat - su * iLon - tau * (cw * P - sw * Q) + p.kmu * vb / tipSpeed;
    const fy = su * iLat + cu * iLon - tau * (sw * P + cw * Q) - p.kmu * ub / tipSpeed;
    dx[13] = (fx - bx) / tau; dx[14] = (fy - by) / tau;
    // forces in body axes
    const nd = 1 / Math.sqrt(1 + bx * bx + by * by);
    const tailAcc = p.nt * n * n * (TAIL_PITCH * x[19] - p.tht0) + p.nr * n * (vb / c.tailArmM - Rr);
    const tailForce = -p.izz * tailAcc / c.tailArmM;
    const half = 0.5 * RHO;
    const fbx = thrust * by * nd - half * p.sx * Math.abs(ub) * ub;
    const fby = -thrust * bx * nd + tailForce - half * p.sy * Math.abs(vb) * vb;
    const fbz = thrust * nd - half * p.sz * Math.abs(wb) * wb;
    const m = sim.mass;
    dx[0] = vwx; dx[1] = vwy; dx[2] = vwz;
    dx[3] = (r00 * fbx + r01 * fby + r02 * fbz) / m + x[24];
    dx[4] = (r10 * fbx + r11 * fby + r12 * fbz) / m + x[25];
    dx[5] = (r20 * fbx + r21 * fby + r22 * fbz) / m - G + x[26];
    // quaternion kinematics
    dx[6] = 0.5 * (-qx * P - qy * Q - qz * Rr); dx[7] = 0.5 * (qw * P + qy * Rr - qz * Q);
    dx[8] = 0.5 * (qw * Q - qx * Rr + qz * P); dx[9] = 0.5 * (qw * Rr + qx * Q - qy * P);
    // rotor speed: DC motor against aerodynamic torque
    const qa = dyn * sim.R * (p.cq0 * (1 + 4.6 * mu * mu) + ct * lambda);
    const qm = Math.max(0, p.kmV * x[29] * din[5] - p.kmW * omega);
    dx[15] = (qm - qa) / p.ir;
    dx[16] = (lambdaSS - x[16]) / 0.05;
    // body rate: hub moments from flapping, tail rotor, motor reaction and gyroscopic terms
    const ixx = c.ixx, iyy = c.iyy, izz = p.izz;
    dx[10] = p.lb * n * n * bx - c.tailHeightM * tailForce / ixx + (iyy - izz) / ixx * Q * Rr + x[21];
    dx[11] = p.mb * n * n * by + (izz - ixx) / iyy * P * Rr + x[22];
    const collRate = (din[3] - x[20]) / p.tauS;
    dx[12] = tailAcc + c.rotorDirection * qm / izz + p.nc * n * n * (x[20] - (sim.collRef || 0)) + p.ncd * collRate + (ixx - iyy) / izz * P * Q + x[23];
    // actuators and barometer filters
    const ts = p.tauS;
    dx[17] = (din[0] - x[17]) / ts; dx[18] = (din[1] - x[18]) / ts; dx[19] = (din[2] - x[19]) / ts; dx[20] = (din[3] - x[20]) / ts;
    dx[21] = dx[22] = dx[23] = dx[24] = dx[25] = dx[26] = 0;
    // the logged vario is a filtered derivative of the filtered altitude: two lags in series
    dx[27] = (x[2] - x[27]) / p.tauB; dx[28] = (dx[27] - x[28]) / p.tauV;
    dx[29] = (din[4] - x[29]) / p.tauEsc; dx[30] = (x[15] - x[30]) / p.tauHs;
    // the firmware gyro low-pass filter (first order at constants.gyroLowpassHz): x[10..12] is the true body rate,
    // x[31..33] the filtered rate that the log records as gyroADC. Without a filter the two are the same.
    const wl = 2 * Math.PI * (c.gyroLowpassHz || 0);
    for (let a = 0; a < 3; a++) dx[31 + a] = wl > 0 ? (x[10 + a] - x[31 + a]) * wl : dx[10 + a];
    aux.thrust = thrust; aux.tail = tailForce; aux.qm = qm;
}

// One step of the classic Runge-Kutta method with the inputs of the last push() held over the step.
function step(sim) {
    const x = sim.x, dt = sim.dt, { k1, k2, k3, k4, tmp } = sim;
    deriv(sim, x, k1);
    for (let i = 0; i < NX; i++) tmp[i] = x[i] + 0.5 * dt * k1[i];
    deriv(sim, tmp, k2);
    for (let i = 0; i < NX; i++) tmp[i] = x[i] + 0.5 * dt * k2[i];
    deriv(sim, tmp, k3);
    for (let i = 0; i < NX; i++) tmp[i] = x[i] + dt * k3[i];
    deriv(sim, tmp, k4);
    for (let i = 0; i < NX; i++) x[i] += dt / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    const nq = 1 / Math.hypot(x[6], x[7], x[8], x[9]);
    x[6] *= nq; x[7] *= nq; x[8] *= nq; x[9] *= nq;
    for (let i = 0; i < NX; i++) if (!Number.isFinite(x[i])) throw new Error('The model state is not finite.');
}

// Measured outputs in log units: gyro deg/s (after the firmware gyro filter), roll/pitch/heading deg, altitude m, vario m/s, headspeed RPM.
function outputs(x, out = new Float64Array(9)) {
    const e = quatToEuler(x[6], x[7], x[8], x[9]);
    out[0] = x[31] / DEG; out[1] = x[32] / DEG; out[2] = x[33] / DEG;
    out[3] = e[0] / DEG; out[4] = e[1] / DEG; out[5] = -e[2] / DEG;
    out[6] = x[27]; out[7] = x[28]; out[8] = x[30] / RPM;
    return out;
}
const OUTPUTS = ['p', 'q', 'r', 'roll', 'pitch', 'heading', 'altitude', 'vario', 'headspeed'];

// Initial state at rest in the measured attitude with the given rotor speed.
function initState(sim, m) {
    // a field that the log does not record (NaN) starts at zero; the observer then skips it
    const x = sim.x, v = (value, other = 0) => finite(value) ? value : other; x.fill(0);
    const att = m.att || [];
    attitudeQuat(v(att[0]), v(att[1]), v(att[2]), sim.tmp); for (let i = 0; i < 4; i++) x[6 + i] = sim.tmp[i];
    for (let a = 0; a < 3; a++) x[10 + a] = x[31 + a] = v(m.gyro && m.gyro[a]) * DEG;
    x[15] = x[30] = Math.max(v(m.hs, sim.model.refRpm), 1) * RPM; x[16] = 0.05; x[29] = v(m.thr);
    x[2] = x[27] = v(m.alt); x[5] = x[28] = v(m.vario);
    return x;
}

// ---- linear frequency response ----
// Rate response to each actuator command at a hover operating point, from a central-difference linearization of
// deriv() over the fast states (velocity, rate, flapping, inflow, actuators). Rotor speed is held: the governor keeps
// it. Returns complex [re, im] per axis and frequency, in rad/s per normalized command, including the transport
// delay and the gyro low-pass filter of the log (constants.gyroLowpassHz, 0 = none).
const LIN = [3, 4, 5, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20];
function frequencyResponseMatrix(model, freqs, op = {}) {
    const sim = createSim(model, 500), x = sim.x, n = LIN.length, p = model.params;
    x.fill(0); x[6] = 1; x[15] = (op.rpm || model.refRpm) * RPM; x[16] = 0.05;
    const u0 = [0, 0, op.tail || 0, op.coll || 0.1];
    for (let k = 0; k < 4; k++) { sim.din[k] = u0[k]; x[17 + k] = u0[k]; }
    sim.din[4] = op.thr || 0.7; sim.din[5] = op.vbat || 22;
    // inflow at its equilibrium for the operating collective
    const d = new Float64Array(NX); for (let it = 0; it < 200; it++) { deriv(sim, x, d); x[16] += d[16] * 0.01; }
    const A = mat(n, n), B = mat(n, 4), dp = new Float64Array(NX), dm = new Float64Array(NX);
    for (let j = 0; j < n; j++) {
        const i = LIN[j], h = 1e-5 * Math.max(1, Math.abs(x[i])), keep = x[i];
        x[i] = keep + h; deriv(sim, x, dp); x[i] = keep - h; deriv(sim, x, dm); x[i] = keep;
        for (let r = 0; r < n; r++) A[r][j] = (dp[LIN[r]] - dm[LIN[r]]) / (2 * h);
    }
    for (let k = 0; k < 4; k++) {
        const keep = sim.din[k], h = 1e-5;
        sim.din[k] = keep + h; deriv(sim, x, dp); sim.din[k] = keep - h; deriv(sim, x, dm); sim.din[k] = keep;
        for (let r = 0; r < n; r++) B[r][k] = (dp[LIN[r]] - dm[LIN[r]]) / (2 * h);
    }
    const delays = [p.dCyc, p.dCyc, p.dTail], lp = model.constants.gyroLowpassHz || 0;
    // per frequency: 3 x 3 [rate axis][actuator axis] complex responses
    return freqs.map(f => {
        const w = 2 * Math.PI * f;
        // solve (jwI - A) Z = B[:,0..2] in real form [[-A, -wI],[wI, -A]] [zr; zi] = [b; 0]
        const M = mat(2 * n, 2 * n + 3, (r, c) => {
            if (c >= 2 * n) return r < n ? B[r][c - 2 * n] : 0;
            const rr = r % n, cc = c % n, top = r < n, left = c < n;
            if (top === left) return -A[rr][cc];
            return rr === cc ? (top ? -w : w) : 0;
        });
        for (let c = 0; c < 2 * n; c++) {
            let q = c; for (let r = c + 1; r < 2 * n; r++) if (Math.abs(M[r][c]) > Math.abs(M[q][c])) q = r;
            [M[c], M[q]] = [M[q], M[c]]; const piv = M[c][c];
            for (let k = c; k < 2 * n + 3; k++) M[c][k] /= piv;
            for (let r = 0; r < 2 * n; r++) if (r !== c && M[r][c]) { const fct = M[r][c]; for (let k = c; k < 2 * n + 3; k++) M[r][k] -= fct * M[c][k]; }
        }
        return [0, 1, 2].map(axis => [0, 1, 2].map(j => {
            let re = M[3 + axis][2 * n + j], im = M[3 + axis + n][2 * n + j];
            const ph = -w * delays[j], c = Math.cos(ph), s = Math.sin(ph); [re, im] = [re * c - im * s, re * s + im * c];
            if (lp > 0) { const a = w / (2 * Math.PI * lp), den = 1 + a * a; [re, im] = [(re + im * a) / den, (im - re * a) / den]; }
            return [re, im];
        }));
    });
}
// On-axis responses: [axis][frequency] = [re, im].
function frequencyResponse(model, freqs, op) { const m = frequencyResponseMatrix(model, freqs, op); return [0, 1, 2].map(a => m.map(h => h[a][a])); }

// ---- observer ----
// Steady-state Kalman gains of two linear subsystems of the model:
//  - each body axis: rate and moment disturbance (random walk), measured by the gyro;
//  - the vertical channel: height, vertical speed, force disturbance and the two barometer filter states,
//    measured by the logged altitude and vario.
// Small dense helpers; the matrices have at most five rows.
const mat = (r, c, f = () => 0) => Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => f(i, j)));
const mul = (a, b) => mat(a.length, b[0].length, (i, j) => a[i].reduce((s, v, k) => s + v * b[k][j], 0));
const tr = a => mat(a[0].length, a.length, (i, j) => a[j][i]);
const add = (a, b) => a.map((r, i) => r.map((v, j) => v + b[i][j]));
function inv(a) {
    const n = a.length, m = a.map((r, i) => r.concat(mat(1, n, (_, j) => i === j ? 1 : 0)[0]));
    for (let c = 0; c < n; c++) {
        let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
        [m[c], m[p]] = [m[p], m[c]]; const d = m[c][c];
        for (let j = 0; j < 2 * n; j++) m[c][j] /= d;
        for (let r = 0; r < n; r++) if (r !== c) { const f = m[r][c]; for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[c][j]; }
    }
    return m.map(r => r.slice(n));
}
function steadyGain(A, C, Q, R) {
    let P = mat(A.length, A.length, (i, j) => i === j ? Q[i][i] * 100 + 1e-6 : 0), K = null;
    for (let it = 0; it < 4000; it++) {
        P = add(mul(mul(A, P), tr(A)), Q);
        K = mul(mul(P, tr(C)), inv(add(mul(mul(C, P), tr(C)), R)));
        const next = mul(add(mat(A.length, A.length, (i, j) => i === j ? 1 : 0), mul(K, C).map(r => r.map(v => -v))), P);
        const change = next.reduce((s, r, i) => s + Math.abs(r[i] - P[i][i]), 0); P = next;
        if (it > 50 && change < 1e-12 * P.reduce((s, r, i) => s + Math.abs(r[i]), 0)) break;
    }
    return K;
}
const gainMemo = new Map();
function observerGains(model, dt) {
    const key = JSON.stringify([model.observer, model.params.tauB, model.params.tauV, dt]);
    let g = gainMemo.get(key);
    if (!g) { if (gainMemo.size > 512) gainMemo.clear(); g = computeGains(model, dt); gainMemo.set(key, g); }
    return g;
}
function computeGains(model, dt) {
    const o = model.observer, p = model.params;
    const rate = steadyGain([[1, dt], [0, 1]], [[1, 0]], [[o.rateNoise ** 2 * dt, 0], [0, o.momentWalk ** 2 * dt]], [[(o.gyroNoise * DEG) ** 2]]);
    const A = [[1, dt, 0, 0, 0], [0, 1, dt, 0, 0], [0, 0, 1, 0, 0], [dt / p.tauB, 0, 0, 1 - dt / p.tauB, 0], [dt / p.tauB / p.tauV, 0, 0, -dt / p.tauB / p.tauV, 1 - dt / p.tauV]];
    const Q = mat(5, 5, (i, j) => i !== j ? 0 : i === 1 ? o.accelNoise ** 2 * dt : i === 2 ? o.forceWalk ** 2 * dt : 1e-10);
    const vertical = steadyGain(A, [[0, 0, 0, 1, 0], [0, 0, 0, 0, 1]], Q, [[o.altNoise ** 2, 0], [0, o.varioNoise ** 2]]);
    return { rate: [rate[0][0], rate[1][0]], vertical };
}

// Observer update after a model step. m: measured { gyro deg/s, att decideg, hs RPM, alt m, vario m/s }.
// The measured attitude and rotor speed replace the predicted ones (both sensors are precise at these time
// scales). Rate, moment disturbance and the vertical channel use the steady-state Kalman gains. Flapping,
// inflow, horizontal velocity and actuators evolve with the model: no sensor measures them.
function observe(sim, m) {
    const x = sim.x, g = sim.gains || (sim.gains = observerGains(sim.model, sim.dt));
    for (let a = 0; a < 3; a++) {
        if (!finite(m.gyro[a])) continue;
        const e = m.gyro[a] * DEG - x[31 + a], c = g.rate[0] * e;
        x[10 + a] += c; x[31 + a] += c; x[21 + a] += g.rate[1] * e;
    }
    if (m.att && m.att.every(finite)) {
        attitudeQuat(m.att[0], m.att[1], m.att[2], sim.tmp);
        const sign = sim.tmp[0] * x[6] + sim.tmp[1] * x[7] + sim.tmp[2] * x[8] + sim.tmp[3] * x[9] < 0 ? -1 : 1;
        for (let i = 0; i < 4; i++) x[6 + i] = sign * sim.tmp[i];
    }
    // headspeed: the measurement is the sensor state; move the rotor speed by the same correction
    if (finite(m.hs) && m.hs > 0) { const e = m.hs * RPM - x[30]; x[30] += e; x[15] += e; }
    // each barometer channel is used when the log records it (a missing one gives no correction)
    const ea = finite(m.alt) ? m.alt - x[27] : 0, ev = finite(m.vario) ? m.vario - x[28] : 0;
    if (ea || ev) { const K = g.vertical, idx = [2, 5, 26, 27, 28]; for (let k = 0; k < 5; k++) x[idx[k]] += K[k][0] * ea + K[k][1] * ev; }
    // horizontal disturbance forces are unobservable without a position or airspeed sensor
    x[24] = x[25] = 0;
}

function clone(sim, into) {
    const c = into || Object.assign({}, sim, { x: new Float64Array(NX), hist: new Float64Array(sim.hist.length), din: new Float64Array(6),
        k1: new Float64Array(NX), k2: new Float64Array(NX), k3: new Float64Array(NX), k4: new Float64Array(NX), tmp: new Float64Array(NX), aux: {} });
    c.gains = sim.gains; c.x.set(sim.x); c.hist.set(sim.hist); c.din.set(sim.din); c.head = sim.head; c.count = sim.count;
    return c;
}

function serialize(model) { const r = validateModel(model); if (r.length) throw new Error(r.join(' ')); return JSON.stringify(model); }
function deserialize(text) {
    const model = typeof text === 'string' ? JSON.parse(text) : JSON.parse(JSON.stringify(text));
    const r = validateModel(model); if (r.length) throw new Error(r.join(' ')); return model;
}

module.exports = { VERSION, KIND, STATE, NX, S, PARAMS, PI, OUTPUTS, DEG, RPM, MAIN_PITCH, TAIL_PITCH, prior, createModel, paramBounds, validateModel,
    eulerToQuat, quatToEuler, attitudeQuat, createSim, clone, push, deriv, step, outputs, initState, observe, observerGains, frequencyResponse, frequencyResponseMatrix, steadyGain, serialize, deserialize };
if (require.main !== module) return;
