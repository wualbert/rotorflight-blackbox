'use strict';

// Rotational rotor/body surrogate. Parameters describe angular rates, not a
// six-degree-of-freedom trajectory simulator. See docs/HELICOPTER_SYSID_MODEL.md.
const VERSION = 1;
const FEATURE_COUNT = 9;
const AXES = ['roll', 'pitch', 'yaw'];
const finite = x => typeof x === 'number' && Number.isFinite(x);
const clone = x => JSON.parse(JSON.stringify(x));

function craftPrior(craft = '') {
    const name = typeof craft === 'string' ? craft : craft.name || '';
    let source, mass, length, width, height, radius, canonical;
    if (/fireball|havok/i.test(name)) {
        canonical = 'SAB Goblin Fireball 280'; mass = 0.95; length = 0.58; width = 0.12; height = 0.19; radius = 0.313;
        source = 'https://sabusa.com/pdf/GOBLIN_FIREBALL_280_MANUAL_RELEASE_1.0L.pdf';
    } else if (/gaui.*x4|x4.*gaui|x4\s*ii/i.test(name)) {
        canonical = 'GAUI X4 II'; mass = 2.3; length = 0.90; width = 0.165; height = 0.32; radius = 0.505;
        source = 'https://nexrc.com/image/data/Brand/Gaui/X4%20II/GAUI%20X4%20II%20Instruction%20Manual.pdf';
    } else return { craft: name || 'unknown', knownGeometry: false, inertia: null,
        kind: 'unavailable', identified: false, reason: 'The craft dimensions are unknown.' };
    // Uniform-box inertia is an order-of-magnitude prior. Length includes a
    // light tail boom, so deliberately wide intervals cover mass distribution.
    const inertia = [mass * (width * width + height * height) / 12,
        mass * (length * length + height * height) / 12, mass * (length * length + width * width) / 12];
    return { craft: canonical, knownGeometry: true, source, kind: 'geometry-assumption', identified: false,
        massKg: mass, massRangeKg: [mass * 0.7, mass * 1.4], dimensionsM: { length, width, height, rotorRadius: radius },
        inertia: { unit: 'kg m2', diagonal: inertia, range: inertia.map(x => [x * 0.2, x * 3]) },
        assumptions: ['The flight mass includes an assumed battery mass.',
            'The body is a uniform box for this estimate.', 'The log does not identify inertia separately from control torque.'] };
}

function validateModel(model) {
    const reasons = [];
    if (!model || model.version !== VERSION || model.kind !== 'rotational-rotor-body') return ['The model format is unknown.'];
    if (!finite(model.rate) || model.rate < 25 || model.rate > 32000) reasons.push('The model sample rate is out of range.');
    if (!['gyroRAW', 'gyroADC'].includes(model.output)) reasons.push('The model sensor output is unknown.');
    if (model.collectiveField !== undefined && !['mixer[3]', 'setpoint[3]'].includes(model.collectiveField)) reasons.push('The model collective input is unknown.');
    if (![0, 2].includes(model.rpmExponent)) reasons.push('The model RPM power is unknown.');
    if (model.rotorCoupling !== undefined && (!finite(model.rotorCoupling) || Math.abs(model.rotorCoupling) > 1000)) reasons.push('The rotor coupling is invalid.');
    if (!model.reference || !finite(model.reference.rpm) || model.reference.rpm <= 0 || !finite(model.reference.collective) ||
        !finite(model.reference.collectiveAbs)) reasons.push('The model reference input is invalid.');
    if (model.reference && [model.reference.collectiveSquared, model.reference.rpmSquared].some(x => x !== undefined && !finite(x))) reasons.push('A reference load is invalid.');
    if (model.reference && model.reference.collectiveScale !== undefined && (!finite(model.reference.collectiveScale) || model.reference.collectiveScale <= 0)) reasons.push('The collective scale is invalid.');
    if (!Array.isArray(model.axes) || model.axes.length !== 3) reasons.push('The model must have three axes.');
    else for (const a of model.axes) {
        if (!a || !finite(a.frequencyHz) || a.frequencyHz < 0.2 || a.frequencyHz > 100 ||
            !finite(a.damping) || a.damping < 0.05 || a.damping > 10 || !finite(a.actuatorTauS) || a.actuatorTauS < 0 ||
            a.actuatorTauS > 0.3 || !finite(a.delayS) || a.delayS < 0 || a.delayS > 0.3 ||
            !Array.isArray(a.gain) || a.gain.length !== 3 || !a.gain.every(x => finite(x) && Math.abs(x) <= 1e6) ||
            ![a.collectiveGain, a.collectiveAbsGain, a.bias].every(x => finite(x) && Math.abs(x) <= 1e6))
            reasons.push('An axis parameter is invalid.');
        if (a && a.type === 'torque-rate' && (!finite(a.decayRate) || a.decayRate < 0 || a.decayRate > 100)) reasons.push('The rate damping is invalid.');
        if (a && a.type !== undefined && !['torque-rate', 'oscillator'].includes(a.type)) reasons.push('The axis model is unknown.');
        if (a && [a.collectiveSquaredGain, a.rpmGain, a.rpmDerivativeGain].some(x => x !== undefined && (!finite(x) || Math.abs(x) > 1e6))) reasons.push('A load parameter is invalid.');
    }
    return reasons;
}

function axisTransition(axis, dt) {
    if (axis.type !== 'torque-rate') return transition(axis.frequencyHz, axis.damping, dt);
    const decay = Math.exp(-axis.decayRate * dt);
    return { m00: decay, m01: 0, m10: 0, m11: 0, b0: axis.decayRate > 1e-10 ? -Math.expm1(-axis.decayRate * dt) / axis.decayRate : dt, b1: 0 };
}
function gains(axis) { return [...axis.gain, axis.collectiveGain, axis.collectiveAbsGain, axis.bias,
    axis.collectiveSquaredGain || 0, axis.rpmGain || 0, axis.rpmDerivativeGain || 0]; }

// Exact zero-order-hold discretization of a damped rotor/body mode. The
// second state is the effective flap/torque contribution to rate derivative.
function transition(frequencyHz, damping, dt) {
    const w = 2 * Math.PI * frequencyHz, d = damping * w, discriminant = d * d - w * w;
    let co, si;
    if (Math.abs(discriminant) < 1e-10) { co = 1; si = dt; }
    else if (discriminant < 0) { const k = Math.sqrt(-discriminant); co = Math.cos(k * dt); si = Math.sin(k * dt) / k; }
    else {
        const k = Math.sqrt(discriminant), positive = Math.exp((-d + k) * dt), negative = Math.exp((-d - k) * dt);
        co = (positive + negative) / 2; si = (positive - negative) / (2 * k);
        const m00 = co + d * si, m01 = si, m10 = -w * w * si, m11 = co - d * si;
        return { m00, m01, m10, m11, b0: 1 - m00, b1: -m10 };
    }
    const e = Math.exp(-d * dt), m00 = e * (co + d * si), m01 = e * si;
    const m10 = -w * w * m01, m11 = e * (co - d * si);
    return { m00, m01, m10, m11, b0: 1 - m00, b1: -m10 };
}

function multiply(a, b) {
    const n = a.length, out = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) out[i][j] += a[i][k] * b[k][j];
    return out;
}
function coupledTransition(model, dt) {
    const n = 9, a = Array.from({ length: n }, () => Array(n).fill(0));
    for (let axis = 0; axis < 3; axis++) {
        if (model.axes[axis].type === 'torque-rate') {
            a[axis][axis] = -model.axes[axis].decayRate; a[axis + 3][axis + 3] = -1;
            a[axis][axis + 6] = 1; continue;
        }
        const w = 2 * Math.PI * model.axes[axis].frequencyHz;
        a[axis][axis + 3] = 1;
        a[axis + 3][axis] = -w * w;
        a[axis + 3][axis + 3] = -2 * model.axes[axis].damping * w;
        a[axis + 3][axis + 6] = w * w;
    }
    // Skew coupling moves energy between the cyclic rotor states without
    // adding negative damping. It cannot be replaced by static input mixing.
    a[3][4] = model.rotorCoupling || 0; a[4][3] = -(model.rotorCoupling || 0);
    const norm = Math.max(...a.map(row => row.reduce((sum, x) => sum + Math.abs(x * dt), 0)));
    const squarings = Math.max(0, Math.ceil(Math.log2(Math.max(norm, 1)))), scale = dt / 2 ** squarings;
    const scaled = a.map(row => row.map(x => x * scale));
    let term = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 1 : 0)), e = term.map(row => row.slice());
    for (let k = 1; k <= 24; k++) {
        term = multiply(term, scaled).map(row => row.map(x => x / k));
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) e[i][j] += term[i][j];
    }
    for (let k = 0; k < squarings; k++) e = multiply(e, e);
    return { state: e.slice(0, 6).map(row => row.slice(0, 6)), drive: e.slice(0, 6).map(row => row.slice(6)) };
}

function features(model, input, previousHeadspeed = input && input.hs, dt = 1 / model.rate) {
    if (!input || !Array.isArray(input.u) || input.u.length !== 3 || !input.u.every(finite) ||
        !finite(input.hs) || input.hs <= 0 || !finite(input.coll)) throw new Error('The model input is invalid.');
    const scale = model.rpmExponent === 2 ? (input.hs / model.reference.rpm) ** 2 : 1;
    return [input.u[0] * scale, input.u[1] * scale, input.u[2] * scale,
        input.coll - model.reference.collective, Math.abs(input.coll) - model.reference.collectiveAbs, 1,
        (input.coll / (model.reference.collectiveScale || 1)) ** 2 - (model.reference.collectiveSquared || 0),
        (input.hs / model.reference.rpm) ** 2 - (model.reference.rpmSquared || 1),
        (input.hs - previousHeadspeed) / dt / model.reference.rpm];
}

function createState(model, initialRates = [0, 0, 0], initialInput) {
    const errors = validateModel(model); if (errors.length) throw new Error(errors.join(' '));
    if (!Array.isArray(initialRates) || initialRates.length !== 3 || !initialRates.every(finite)) throw new Error('The initial rate is invalid.');
    const input = initialInput || { u: [0, 0, 0], hs: model.reference.rpm, coll: model.reference.collective };
    const x = features(model, input), dt = 1 / model.rate;
    return { rate: initialRates.slice(), flap: [0, 0, 0], actuator: model.axes.map(() => x.slice()),
        history: [x.slice()], time: 0, dt, previousHeadspeed: input.hs, coefficients: model.axes.map(a => axisTransition(a, dt)),
        coupled: model.rotorCoupling ? coupledTransition(model, dt) : null };
}

function step(model, state, input, dt = 1 / model.rate) {
    if (!finite(dt) || dt <= 0 || Math.abs(dt * model.rate - 1) > 1e-6)
        throw new Error('The model step must use its recorded sample rate.');
    const x = features(model, input, state.previousHeadspeed, dt), queue = state.history;
    state.previousHeadspeed = input.hs;
    queue.push(x);
    let maximumDelay = 0; const drives = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
        const a = model.axes[axis], c = state.coefficients[axis], delay = a.delayS / dt;
        maximumDelay = Math.max(maximumDelay, Math.ceil(delay));
        const at = queue.length - 1 - Math.floor(delay), fraction = delay - Math.floor(delay);
        const hi = queue[Math.max(0, at)], lo = queue[Math.max(0, at - 1)];
        const alpha = a.actuatorTauS > 0 ? 1 - Math.exp(-dt / a.actuatorTauS) : 1;
        const filtered = state.actuator[axis], gain = gains(a);
        let drive = 0;
        for (let j = 0; j < FEATURE_COUNT; j++) {
            filtered[j] += alpha * (hi[j] * (1 - fraction) + lo[j] * fraction - filtered[j]);
            drive += gain[j] * filtered[j];
        }
        drives[axis] = drive;
        if (!state.coupled) {
            const rate = state.rate[axis], flap = state.flap[axis];
            state.rate[axis] = c.m00 * rate + c.m01 * flap + c.b0 * drive;
            state.flap[axis] = c.m10 * rate + c.m11 * flap + c.b1 * drive;
        }
        if (!finite(state.rate[axis]) || !finite(state.flap[axis])) throw new Error('The model state is not finite.');
    }
    if (state.coupled) {
        const before = state.rate.concat(state.flap), c = state.coupled;
        const after = c.state.map((row, i) => row.reduce((sum, x, j) => sum + x * before[j], 0) + c.drive[i].reduce((sum, x, j) => sum + x * drives[j], 0));
        state.rate = after.slice(0, 3); state.flap = after.slice(3);
        if (!after.every(finite)) throw new Error('The model state is not finite.');
    }
    if (queue.length > maximumDelay + 3) queue.shift();
    state.time += dt;
    return state.rate;
}

function rollout(model, segment, options = {}) {
    if (Math.abs(segment.rate / model.rate - 1) > 0.01) throw new Error('The replay sample rate does not agree.');
    if (segment.rate !== model.rate) model = atRate(model, segment.rate);
    const n = segment.n, y = segment.y || segment.gyro;
    const input = i => ({ u: segment.u.map(v => v[i]), hs: segment.hs[i], coll: segment.coll[i] });
    const state = createState(model, options.initialRates || y.map(v => v[0]), input(0));
    const output = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    for (let a = 0; a < 3; a++) output[a][0] = state.rate[a];
    for (let i = 1; i < n; i++) {
        // u[i-1] acts over [i-1,i]. Future inputs and measured rates never
        // enter this state transition.
        step(model, state, input(i - 1));
        for (let a = 0; a < 3; a++) output[a][i] = state.rate[a];
    }
    return output;
}

function serialize(model) {
    const errors = validateModel(model); if (errors.length) throw new Error(errors.join(' '));
    return JSON.stringify(model);
}
function deserialize(text) {
    const model = typeof text === 'string' ? JSON.parse(text) : clone(text);
    const errors = validateModel(model); if (errors.length) throw new Error(errors.join(' '));
    return model;
}

function atRate(model, rate) {
    const copy = deserialize(model);
    copy.identifiedSampleRate = model.identifiedSampleRate || model.rate;
    copy.rate = rate;
    const errors = validateModel(copy); if (errors.length) throw new Error(errors.join(' '));
    return copy;
}

module.exports = { VERSION, FEATURE_COUNT, AXES, craftPrior, validateModel, transition, axisTransition, coupledTransition, features, gains, createState, step, rollout, serialize, deserialize, atRate };
