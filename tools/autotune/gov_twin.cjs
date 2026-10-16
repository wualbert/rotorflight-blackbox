'use strict';

// Governor digital twin: the averaged plant between the governor throttle and the logged headspeed, Vbat and Ibat.
// Specification: docs/GOVERNOR_AUTOTUNE.md section 3. H is rotor rpm, d is ESC duty, V is volts.
//
// Voltage-domain form: the slip voltage s = d·V − H/kv equals R_m·I_m, so every quantity that the governor sees can be
// identified without a current sensor. Current only adds the absolute scale (physical()).
//
//   ESC      d* = clamp(u, 0, 1). d follows d* with lag te. Below dOff the motor coasts: no current, no brake torque.
//            Soft start (armed from a stopped motor): the ESC starts the motor when d* >= u0 (start throttle), then it limits
//            the rotor speed to a ramp lim, whatever the command and the load: lim starts at max(rotor speed, as0) and rises at
//            min(ass, as1 + asr·lim) rpm/s (exponential with an offset, then linear: ramp()). Under the ramp the duty follows d*
//            (lag te); at the ramp the duty is the one that holds the rotor on it. Gaui logs 38-49 (10 spool-ups, ages 2-7 s): the
//            rate is 112 + 0.187·H rpm/s (RMS 23 rpm/s) up to 1800 rpm at the 150 ramp; Fireball logs 5-15: 300 rpm/s at 500 rpm,
//            then 550-730 rpm/s (the cap ass).
//            The soft start ends when the rotor reaches softEnd of the no-load speed kv·d*·OCV from under it, or when lim passes kv·OCV. It
//            is armed again (also inside a soft start: the motor waits for u0) when d* stays under dOff for softOffS, or when
//            d* < dOff with the rotor under softHs·Href. Fireball logs 5-15: every start from rest (RF ramps of 0.100/s and
//            0.125/s, and the log 10 bailout at 0.5/s) gives the same speed against time (300 rpm/s up to 1.5 s, then 550-730),
//            a speed limit, not a duty ramp: after a collective pull inside the soft start (log 15, 7.6 s) the rotor speeds up at
//            1200-1900 rpm/s, back to the ramp. Gaui logs 38-49: 145 rpm/s for 2 s, then up to 440 at 2100 rpm.
//   Motor    s = d·V − H/kv, s >= −sneg (regenerative limit). Rotor: dH/dt = (kv/tm)·(s − sL).
//   Battery  V = OCV − beta·d·s, solved in closed form: s = (d·OCV − e)/(1 + beta·d²). OCV = V0 − kappa·Q, dQ/dt = d·s.
//   Load     sL = n²·(q0 + qc·|coll − c0|^pc + qx·cyc + qy·|yaw|) + qf·n + qs (H > 0), n = H/Href. coll is the signed mixer collective;
//            c0 is the collective of the smallest load (Fireball logs: the load at a negative collective is smaller than at the same
//            positive collective, and |coll|^pc leaves 0.52 V RMS of steady slip against 0.33 V with c0 = −0.25). qs: a constant load
//            while the rotor turns (the no-load current of the motor and the ESC, R_m·i0): in the Gaui ground spool-ups the slip is
//            0.1-0.45 V above the n², n terms (fit: Gaui 0.19 V, Fireball 0.11 V; closed-loop HS RMS 0.57 -> 0.48 %).
//   Sensors  first order: hsLog (th), vLog (tv), iLog (ti) on I = d·s/rm + i0.
//   Rest     vp: the rest voltage less the OCV of the model at the same charge. The battery has no polarization (RC) element, and
//            in the logs the voltage falls 0.26-0.36 V more than R0 explains in the first 20-60 s of a flight. A start from rest
//            (initState rest: true; gov_sim at the log start) starts the OCV at the rest voltage less vp. Held in the fit (gov_fit:
//            the rest voltage before each flight less the OCV of the regression at its start).
//
// Without voltage, V is the constant V0 (defaults: 1, so kv is in rpm per throttle unit) and beta = kappa = 0. The current
// is then not used either: with V0 = 1 the slip is in throttle units and only R_m/V (not R_m in ohms) is identifiable.
// Without current, rm, i0 and ti have no effect and ibat is null.
//
// Integration (one step, any dt): the ESC lag is an exact first-order update. The rotor speed uses the mid-step duty and
// a linearly implicit step whose implicitness goes from 1/2 (trapezoid, second order) on smooth steps to 1 (implicit
// Euler) on stiff ones: no oscillation and no instability for any tm >= minTau, and the 100-Hz fit rate agrees with the
// PID rate (0.01 % of the speed on smooth inputs, against 0.2 % for explicit or implicit Euler). The sensors are exact
// first-order responses to an input that moves linearly over the step. The state holds s, V, sL and I of its own end.

const RULES = Object.freeze({
    dOff: 0.02,      // ESC duty under which the motor coasts
    softHs: 0.05,    // rotor speed (fraction of Href) under which the ESC starts again with the soft start (initState default)
    // s of throttle command under dOff after which the ESC starts again with the soft start, whatever the rotor speed. Fireball
    // logs 8 and 10: cuts of 1.83 s (rotor at 1183 rpm, 26 % of Href) and 2.04 s both gave a soft start; no shorter cut is
    // recorded, so the value is an assumption under 1.83 s
    softOffS: 1,
    // the soft start ends when the rotor reaches this share of the no-load speed kv·d*·OCV of the command (models 5.1, ε = 0.25).
    // Gaui logs 38-49 (closed loop with the native governor): the spool-up overshoot is within 1 point of the log at 0.70-0.75, and
    // 4.3 % against 1.2 % (log 47) at 0.8; without the end the twin rotor is 1 s late at the spool-up exit (log 48: 9.2 % against
    // 1.2 %). Fireball spool-ups: no change (the command stays far above the rotor)
    softEnd: 0.75,
    accelS: 0.25,    // s, half width of the least-squares hs slope that simulate() uses for a start inside a soft start
    minTau: 0.004,   // s, smallest time constant used for te, tm, th, tv and ti (smaller values make the integration unstable)
    dExtend: 4,      // steady(): largest virtual duty searched for the required duty of a point above the power limit
});

// name, unit, lo, hi, scale (fit space), needs (null: always)
const PARAMS = [
    ['kv', 'rpm/V', 10, 50000, 'log', null],       // rotor rpm per motor volt (no voltage: per throttle unit)
    ['tm', 's', 0.004, 5, 'log', null],            // electromechanical time constant J·R_m/(Ke·Kt)
    ['te', 's', 0.004, 1, 'log', null],            // ESC throttle-to-duty lag
    ['ass', 'rpm/s', 1, 50000, 'log', null],       // ESC soft start: largest rate of the rotor speed ramp from a stopped motor
    ['asr', '1/s', 0.01, 20, 'log', null],         // ESC soft start: relative rate of the ramp under ass/asr (exponential part)
    ['as0', 'rpm', 0, 5000, 'lin', null],          // ESC soft start: the ramp start from rest
    ['as1', 'rpm/s', 0, 5000, 'lin', null],        // ESC soft start: the rate of the ramp at 0 rpm (the offset of the exponential part)
    ['u0', '-', 0, 0.3, 'lin', null],              // ESC soft start: the throttle at which the ESC starts a stopped motor
    ['sneg', 'V', 0, 50, 'lin', null],             // regenerative limit of the slip voltage (0: diode freewheel)
    ['q0', 'V', 0, 50, 'lin', null],               // load at Href: profile
    ['qc', 'V', 0, 50, 'lin', null],               // collective
    ['qx', 'V', 0, 50, 'lin', null],               // cyclic
    ['qy', 'V', 0, 50, 'lin', null],               // yaw
    ['qf', 'V', 0, 50, 'lin', null],               // friction (linear in speed)
    ['qs', 'V', 0, 50, 'lin', null],               // constant load with the rotor turning (the no-load current of the motor and the ESC: R_m·i0)
    ['pc', '-', 1, 3, 'lin', null],                // collective exponent
    ['c0', '-', -0.5, 0.5, 'lin', null],           // collective of the smallest load
    ['th', 's', 0.004, 0.5, 'log', null],          // headspeed sensor lag
    ['beta', '-', 0, 5, 'lin', 'voltage'],         // R0/R_m
    ['kappa', '1/s', 0, 1, 'lin', 'voltage'],      // OCV slope per slip charge Q (V·s)
    ['tv', 's', 0.004, 2, 'log', 'voltage'],       // Vbat sensor lag
    ['vp', 'V', 0, 3, 'lin', 'voltage'],           // rest offset: the rest voltage less the OCV in flight at the same charge (initState rest)
    ['rm', 'Ohm', 0.001, 1, 'log', 'current'],     // R_m: winding, ESC and wires
    ['i0', 'A', -5, 30, 'lin', 'current'],         // current that the motor does not use (BEC, servos, sensor offset)
    ['ti', 's', 0.004, 2, 'log', 'current'],       // Ibat sensor lag
].map(([name, unit, lo, hi, scale, needs]) => ({ name, unit, lo, hi, scale, needs }));
const PARAM = Object.fromEntries(PARAMS.map(q => [q.name, q]));

// Names of the parameters that the recorded channels can identify: has = {voltage, current}. Current needs voltage too.
const paramNames = (has = {}) => PARAMS.filter(q => !q.needs || has.voltage && (q.needs === 'voltage' || has.current)).map(q => q.name);
// Fit space: log for the log-scale parameters.
const encode = (p, names) => Float64Array.from(names, k => PARAM[k].scale === 'log' ? Math.log(p[k]) : p[k]);
function decode(z, names, base) {
    const p = copy(base);
    for (let i = 0; i < names.length; i++) p[names[i]] = PARAM[names[i]].scale === 'log' ? Math.exp(z[i]) : z[i];
    return p;
}
// A parameter set with changes c. Make parameter sets with copy(), decode() or defaults() only: step() is 2-3 times
// slower when it sees parameter objects of different shapes (Object.assign({}, p) gives a new shape).
function copy(p, c = {}) {
    const g = k => c[k] !== undefined ? c[k] : p[k];
    return { kv: g('kv'), tm: g('tm'), te: g('te'), ass: g('ass'), asr: g('asr') || 20, as0: g('as0') || 0, as1: g('as1') || 0, u0: g('u0') || 0, sneg: g('sneg'), q0: g('q0'), qc: g('qc'), qx: g('qx'), qy: g('qy'),
        qf: g('qf'), qs: g('qs') || 0, pc: g('pc'), c0: g('c0') || 0, th: g('th'), beta: g('beta'), kappa: g('kappa'), tv: g('tv'), vp: g('vp') || 0, rm: g('rm'), i0: g('i0'), ti: g('ti'),
        Href: g('Href'), V0: g('V0'), voltage: !!g('voltage'), current: !!g('voltage') && !!g('current') };
}

// Start values. V0 > 0 gives the voltage mode (kv in rpm/V); without V0 the voltage is the constant 1 and current is off.
function defaults(o = {}) {
    if (!(o.kv > 0) || !(o.Href > 0)) throw new Error('The values "kv" and "Href" must be more than 0.');
    const voltage = o.V0 > 0, V0 = voltage ? o.V0 : 1;
    return copy({ kv: o.kv, tm: 0.4, te: 0.1, ass: 0.1 * o.kv * V0, asr: 20, as0: 0, as1: 0, u0: 0.1, sneg: 0.1 * V0, q0: 0.03 * V0, qc: 0.05 * V0, qx: 0.02 * V0, qy: 0.01 * V0, qf: 0.01 * V0, qs: 0,
        pc: 2, c0: 0, th: 0.01, beta: voltage ? 0.1 : 0, kappa: voltage ? 0.02 : 0, tv: 0.06, vp: 0, rm: 0.02, i0: 1, ti: 0.09,
        Href: o.Href, V0, voltage, current: !!o.current });
}

// Slip voltage at duty d, open-circuit voltage ocv and back-EMF e (closed-form battery, regenerative limit, coast).
function slip(d, ocv, e, beta, sneg) {
    if (d < RULES.dOff) return 0;
    const s = (d * ocv - e) / (1 + beta * d * d);
    return s > -sneg ? s : -sneg;
}
// Duty of the largest slip at back-EMF e: the slip (d·ocv − e)/(1 + beta·d²) decreases above it (beta > 0).
const dPeak = (ocv, e, beta) => beta > 0 && ocv > 0 ? e / ocv + Math.sqrt(e * e / (ocv * ocv) + 1 / beta) : Infinity;
// c^pc for c >= 0 as exp(pc·ln c): Math.pow with a fractional exponent costs about half of a step.
const powc = (c, pc) => c > 0 ? Math.exp(pc * Math.log(c)) : 0;
// Load slip voltage sL at rotor speed H (coll: the signed collective).
function load(p, H, coll, cyc, yaw) {
    const n = H / p.Href, c = Math.abs((coll || 0) - p.c0) || 0, x = cyc > 0 ? cyc : 0, y = Math.abs(yaw) || 0;
    return n * n * (p.q0 + p.qc * powc(c, p.pc) + p.qx * x + p.qy * y) + p.qf * n + (H > 0 && p.qs > 0 ? p.qs : 0);
}

// The soft-start ramp (rpm) age s after the motor start from rotor speed h: max(h, as0), then the rate min(ass, as1 + asr·lim):
// exponential with the offset c = as1/asr up to lk = (ass − as1)/asr, then linear at ass (linear at ass only, with as0 = as1 = 0).
// step() follows the same path (rampOf).
function rampOf(p) {
    const a = p.ass > 0 ? p.ass : 0, r = p.asr > 0 ? p.asr : 0, b = p.as1 > 0 ? p.as1 : 0, expo = (p.as0 > 0 || b > 0) && r > 0 && b < a;
    return { a: expo || r > 0 || !(b > 0) ? a : Math.min(a, b), r, expo, c: expo ? b / r : 0, lk: expo ? (a - b) / r : 0 };
}
function ramp(p, age, h) {
    const l0 = Math.max(h > 0 ? h : 0, p.as0 > 0 ? p.as0 : 0), q = rampOf(p);
    if (!(age > 0)) return l0;
    if (!q.expo || l0 >= q.lk) return l0 + q.a * age;
    const t1 = Math.log((q.lk + q.c) / (l0 + q.c)) / q.r;
    return age <= t1 ? (l0 + q.c) * Math.exp(q.r * age) - q.c : q.lk + q.a * (age - t1);
}

// o: {hs, u, vbat, ibat, stopped, below, lim, d, accel, coll, cyc, yaw, rest}. stopped (default hs < softHs·Href) arms the soft start
// (below: the rotor was under the end speed since the motor start, soft 2, see step()). rest: vbat is a rest voltage (the battery
// rested before the flight), the OCV starts at vbat − vp. lim:
// the soft-start ramp (rpm), default hs, or −1 (the motor waits for u0) with the rotor at rest. d is the ESC duty. Default: u
// (the steady state), or with the soft start armed the duty that gives the rotor acceleration accel (rpm/s, default 0) at hs and
// load {coll, cyc, yaw}: d·V = H/kv + sL + tm·accel/kv, at most u. From rest that duty is 0. V0 is set so that V(t0) = vbat(t0)
// at that duty.
function initState(p, o = {}) {
    const H = o.hs > 0 ? o.hs : 0, e = H / p.kv, beta = p.voltage && p.beta > 0 ? p.beta : 0, vb = p.voltage && o.vbat > 0 ? o.vbat : 0;
    const soft = (o.stopped != null ? o.stopped : H < RULES.softHs * p.Href) ? (o.below ? 2 : 1) : 0, cl = v => v > 0 ? (v < 1 ? v : 1) : 0;
    let d = cl(o.d != null ? o.d : o.u);
    if (o.d == null && soft) d = Math.min(d, cl((e + load(p, H, o.coll, o.cyc, o.yaw) + tau(p.tm) * (o.accel || 0) / p.kv) / (vb || p.V0)));
    const V0 = vb ? vb + beta * d * (d < RULES.dOff ? 0 : Math.max(d * vb - e, -p.sneg)) - (o.rest && p.vp > 0 ? p.vp : 0) : p.V0;
    const s = slip(d, V0, e, beta, p.sneg), V = V0 - beta * d * s, I = p.current ? d * s / p.rm + p.i0 : 0;
    const lim = !soft ? -1 : o.lim != null ? (o.lim < 0 ? -1 : Math.max(o.lim, H)) : H > 0 ? H : -1;
    return clone({ H, d, soft, lim, off: 0, Q: 0, V0, hsLog: H, vLog: vb || V, iLog: p.current && Number.isFinite(o.ibat) ? o.ibat : I, s, V, sL: s, I });
}
// A copy of a state, with the one object shape that step() expects. off: s of throttle command under dOff. lim: the soft-start
// ramp (rpm; −1: not started).
const clone = x => ({ H: x.H, d: x.d, soft: x.soft, lim: x.lim != null ? x.lim : -1, off: x.off || 0, Q: x.Q, V0: x.V0, hsLog: x.hsLog, vLog: x.vLog, iLog: x.iLog, s: x.s, V: x.V,
    sL: x.sL, I: x.I, k: x.k ? Float64Array.from(x.k) : new Float64Array(12).fill(NaN) });

const tau = t => t > RULES.minTau ? t : RULES.minTau;
// First-order coefficients, cached in x.k for (dt, te, th, tv, ti): [dt, te, th, tv, ti, aE, E, c (hs), E, c (V), E, c (I)].
// A sensor update y' = y·E + b·(1 − c) + a·(c − E) is the exact lag response to an input that moves linearly from a to b.
function coefs(x, p, dt) {
    const k = x.k || (x.k = new Float64Array(12).fill(NaN));
    if (k[0] === dt && k[1] === p.te && k[2] === p.th && k[3] === p.tv && k[4] === p.ti) return k;
    k[0] = dt; k[1] = p.te; k[2] = p.th; k[3] = p.tv; k[4] = p.ti; k[5] = 1 - Math.exp(-dt / tau(p.te));
    for (let j = 0; j < 3; j++) { const t = tau(k[2 + j]), E = Math.exp(-dt / t); k[6 + 2 * j] = E; k[7 + 2 * j] = dt > 0 ? t * (1 - E) / dt : 1; }
    return k;
}

// One step of dt seconds with inp = {u, coll (signed), cyc, yaw}. Mutates and returns x. No allocation, no throw.
function step(x, inp, p, dt) {
    const R = RULES, u = inp.u, ds = u > 0 ? (u < 1 ? u : 1) : 0;
    const kv = p.kv > 1e-6 ? p.kv : 1e-6, Href = p.Href > 0 ? p.Href : 1, beta = p.voltage && p.beta > 0 ? p.beta : 0;
    const kappa = p.voltage ? p.kappa : 0, smin = p.sneg > 0 ? -p.sneg : 0;
    // ESC duty and the soft start
    const K = coefs(x, p, dt), aE = K[5], d0 = x.d, H = x.H, ocv0 = x.V0 - kappa * x.Q, ocv = ocv0 > 0 ? ocv0 : 0;
    let d = d0 + (ds - d0) * aE, cap = false;
    x.off = ds < R.dOff ? x.off + dt : 0;
    if (x.soft) {
        // armed again inside a soft start: as from ACTIVE (soft 1), so a restart with the rotor above the end speed keeps the ramp
        if (ds < R.dOff && (x.off >= R.softOffS || H < R.softHs * Href)) { x.lim = -1; x.soft = 1; }
        if (x.lim < 0) { if (ds >= (p.u0 > R.dOff ? p.u0 : R.dOff)) x.lim = H > p.as0 ? H : p.as0 > 0 ? p.as0 : 0; else d = 0; }
        if (x.lim >= 0) {
            const a = p.ass > 0 ? p.ass : 0, r = p.asr > 0 ? p.asr : 0, b = p.as1 > 0 ? p.as1 : 0, expo = (p.as0 > 0 || b > 0) && r > 0 && b < a;
            if (expo && x.lim < (a - b) / r) {
                const c = b / r, lk = (a - b) / r, l = (x.lim + c) * Math.exp(r * dt) - c;
                x.lim = l <= lk ? l : lk + a * (dt - Math.log((lk + c) / (x.lim + c)) / r);
            } else x.lim += (expo || r > 0 || !(b > 0) ? a : Math.min(a, b)) * dt;
            // the end: the rotor reaches softEnd of the no-load speed of the command (x.soft 2: it was under it since the start; a
            // restart with the rotor above it keeps the ramp, Fireball log 8: from 1183 rpm), or the ramp passes kv·OCV
            const vk = kv * (p.voltage ? ocv : p.V0), at = ds >= R.dOff && H >= R.softEnd * vk * ds;
            if (x.lim >= vk || at && x.soft === 2) { x.soft = 0; x.lim = -1; } else { if (!at) x.soft = 2; cap = ds >= R.dOff; }
        }
    } else if (ds < R.dOff && (x.off >= R.softOffS || H < R.softHs * Href)) { x.soft = 1; x.lim = -1; x.off = 0; }
    if (!(d > 0)) d = 0; else if (d > 1) d = 1;
    // motor, battery and rotor at the mid-step duty
    let dm = 0.5 * (d0 + d), s = 0, dsdH = 0;
    if (dm >= R.dOff || cap && dm > 0) {
        const den = 1 + beta * dm * dm;
        s = (dm * ocv - H / kv) / den; dsdH = -1 / (kv * den);
        if (s < smin || dm < R.dOff && s < 0) { s = dm < R.dOff ? 0 : smin; dsdH = 0; }   // no brake torque under dOff (soft start)
    }
    const c = Math.abs((inp.coll || 0) - p.c0) || 0, cy = inp.cyc > 0 ? inp.cyc : 0, y = Math.abs(inp.yaw) || 0, qf = p.qf;
    const L = p.q0 + p.qc * powc(c, p.pc) + p.qx * cy + p.qy * y, n = H / Href;
    // z = -dt·df/dH >= 0. Implicitness theta = 1 - 1/(z + 2): trapezoid when z is small, implicit Euler when z is large.
    const w = kv / tau(p.tm), z = dt * w * ((2 * n * L + qf) / Href - dsdH);
    const qs = H > 0 && p.qs > 0 ? p.qs : 0, den = z > 0 ? 1 + z - z / (z + 2) : 1, sl = n * n * L + qf * n + qs;
    let Hn = H + dt * w * (s - sl) / den;
    // soft start at its ramp: the slip that puts the rotor on lim, and the duty of that slip (s(d) = sr), held over the step
    if (cap && Hn > x.lim) {
        const sr = sl + (x.lim - H) * den / (dt * w), a = beta * sr, b = H / kv + sr, disc = ocv * ocv - 4 * a * b;
        const dc = sr <= 0 ? 0 : a > 1e-12 ? (disc >= 0 ? 2 * b / (ocv + Math.sqrt(disc)) : dm) : ocv > 0 ? b / ocv : dm;
        if (dc < dm) { d = dm = dc; s = sr > 0 ? sr : 0; Hn = sr > 0 ? x.lim : H - dt * w * sl / (1 + dt * w * (2 * n * L + qf) / Href); }
    }
    x.H = Hn > 0 ? Hn : 0; x.d = d; x.Q += dt * dm * s;
    // algebraic values at the end of the step (outputs), then the sensors
    const ocv1 = x.V0 - kappa * x.Q > 0 ? x.V0 - kappa * x.Q : 0, n1 = x.H / Href;
    let s1 = 0;
    if (d >= R.dOff || cap && d > 0) { s1 = (d * ocv1 - x.H / kv) / (1 + beta * d * d); if (s1 < smin) s1 = smin; if (d < R.dOff && s1 < 0) s1 = 0; }
    const V1 = ocv1 - beta * d * s1, I1 = p.current ? d * s1 / (p.rm > 1e-6 ? p.rm : 1e-6) + p.i0 : 0;
    x.hsLog = x.hsLog * K[6] + x.H * (1 - K[7]) + H * (K[7] - K[6]);
    if (p.voltage) x.vLog = x.vLog * K[8] + V1 * (1 - K[9]) + x.V * (K[9] - K[8]);
    if (p.current) x.iLog = x.iLog * K[10] + I1 * (1 - K[11]) + x.I * (K[11] - K[10]);
    x.s = s1; x.V = V1; x.sL = n1 * n1 * L + qf * n1 + (x.H > 0 && p.qs > 0 ? p.qs : 0); x.I = I1;
    return x;
}

// Values at the current state. sL uses the load inputs of the last step.
const outputs = (x, p) => ({ hs: x.hsLog, vbat: p.voltage ? x.vLog : null, ibat: p.current ? x.iLog : null,
    H: x.H, d: x.d, s: x.s, sL: x.sL, V: x.V, I: p.current ? x.I : null });

// Least-squares slope of a (per s) over the samples i ± h·rate.
function slope(a, i, rate, h) {
    const j0 = Math.max(0, i - Math.round(h * rate)), j1 = Math.min(a.length - 1, i + Math.round(h * rate)), m = j1 - j0 + 1, c = (j0 + j1) / 2;
    let sxy = 0, sxx = 0;
    for (let j = j0; j <= j1; j++) { sxy += (j - c) * a[j]; sxx += (j - c) * (j - c); }
    return m > 1 ? sxy / sxx * rate : 0;
}

// Open loop on the recorded throttle. run: {n, rate, hs, u, coll, roll, pitch, yaw, vbat, ibat} (missing channels null).
// Output k is the state at sample from + k·stride, before the step; x is the state at `to` (a partial last block steps
// its own length). Inputs are block means over the stride (the signed collective, the cyclic magnitude and |yaw|). x0 (copied) or the
// measured state at `from` (initState with o.stopped, o.d, o.accel) starts the run. With the soft start armed and no d or
// accel, accel is the hs slope at `from` (RULES.accelS).
// The default start is an estimate from the one sample at `from` (d = u, V0 = vbat + beta·d·s, the soft start only with the rotor
// under softHs·Href). The acceptance numbers of gov_fit use its own start estimate (gov_fit.stateAt: the soft start from the motor
// start, the duty through te over 1 s, the OCV from the 0.5 s before `from`): pass that state as x0 for the same results. With the
// one-sample start, the 5-s test windows (2026-10-15 twins) have an HS RMS of 2.89 % against 1.80 % (Fireball: the windows that start
// on the ESC ramp) and a Vbat RMS of 0.20 V against 0.11 V (Gaui).
function simulate(p, run, o = {}) {
    const from = o.from || 0, to = Math.min(o.to != null ? o.to : run.n, run.n), stride = Math.max(1, o.stride | 0);
    const n = to > from ? Math.ceil((to - from) / stride) : 0, dt = stride / run.rate;
    const hs = new Float64Array(n), d = new Float64Array(n), vbat = p.voltage ? new Float64Array(n) : null, ibat = p.current ? new Float64Array(n) : null;
    const U = run.u, C = run.coll, Rr = run.roll, Pp = run.pitch, Y = run.yaw, inp = { u: 0, coll: 0, cyc: 0, yaw: 0 };
    let x = o.x0 && clone(o.x0);
    if (!x) {
        const H = run.hs[from], soft = o.stopped != null ? o.stopped : H < RULES.softHs * p.Href;
        x = initState(p, { hs: H, u: U[from], vbat: run.vbat ? run.vbat[from] : null, ibat: run.ibat ? run.ibat[from] : null, stopped: soft, d: o.d,
            accel: o.accel != null ? o.accel : soft && o.d == null ? slope(run.hs, from, run.rate, RULES.accelS) : 0,
            coll: C ? C[from] : 0, cyc: Rr || Pp ? Math.hypot(Rr ? Rr[from] : 0, Pp ? Pp[from] : 0) : 0, yaw: Y ? Y[from] : 0 });
    }
    for (let k = 0, i = from; k < n; k++, i += stride) {
        hs[k] = x.hsLog; d[k] = x.d;
        if (vbat) vbat[k] = x.vLog;
        if (ibat) ibat[k] = x.iLog;
        const j1 = i + stride < to ? i + stride : to;
        let su = 0, sc = 0, sx = 0, sy = 0;
        for (let j = i; j < j1; j++) {
            su += U[j];
            if (C) sc += C[j];
            if (Rr || Pp) { const a = Rr ? Rr[j] : 0, b = Pp ? Pp[j] : 0; sx += Math.sqrt(a * a + b * b); }
            if (Y) sy += Math.abs(Y[j]);
        }
        const m = j1 - i;
        inp.u = su / m; inp.coll = sc / m; inp.cyc = sx / m; inp.yaw = sy / m;
        step(x, inp, p, m === stride ? dt : m / run.rate);
    }
    return { hs, vbat, ibat, d, x };
}

// Steady state at rotor speed H and load {coll, cyc, yaw}, at open-circuit voltage ocv (default and no-voltage mode: V0):
// the required duty d, the smallest duty whose slip meets the load (bisection on [0, min(dPeak, dExtend)], where the slip
// increases). Above the power limit, d is the virtual duty > 1 that the load needs, feasible is false and s, V are at
// d = 1. d = Infinity (headroom −Infinity) when no duty up to dExtend meets the load. headroom = 1 − d.
function steady(p, o = {}) {
    const ocv = p.voltage && o.ocv > 0 ? o.ocv : p.V0, H = o.H > 0 ? o.H : 0, e = H / p.kv, beta = p.voltage && p.beta > 0 ? p.beta : 0;
    const sL = load(p, H, o.coll, o.cyc, o.yaw), f = d => slip(d, ocv, e, beta, p.sneg) - sL, top = Math.min(dPeak(ocv, e, beta), RULES.dExtend);
    let lo = 0, hi = top;
    if (f(0) >= 0) hi = 0;
    else if (f(top) < 0) hi = Infinity;
    else for (let k = 0; k < 64 && hi - lo > 1e-13; k++) { const m = (lo + hi) / 2; if (f(m) >= 0) hi = m; else lo = m; }
    const d1 = hi < 1 ? hi : 1, s = slip(d1, ocv, e, beta, p.sneg);
    return { d: hi, s, V: ocv - beta * d1 * s, sL, feasible: hi <= 1, headroom: 1 - hi };
}

// Highest rotor speed whose steady duty is <= 1 − headroom, for load {coll, cyc, yaw} and open-circuit voltage ocv
// (default and no-voltage mode: V0).
function maxHeadspeed(p, ld = {}, ocv, headroom = 0) {
    const dm = 1 - (headroom || 0), V = p.voltage && ocv > 0 ? ocv : p.V0, beta = p.voltage && p.beta > 0 ? p.beta : 0;
    if (!(dm >= RULES.dOff)) return 0;
    let lo = 0, hi = p.kv * dm * V;
    for (let k = 0; k < 64 && hi - lo > 1e-9 * hi; k++) {
        const H = (lo + hi) / 2;
        if (slip(Math.min(dm, dPeak(V, H / p.kv, beta)), V, H / p.kv, beta, p.sneg) >= load(p, H, ld.coll, ld.cyc, ld.yaw)) lo = H; else hi = H;
    }
    return lo;
}

// Physical values (voltage and current recorded only, else null). N = 1: Ke, Kt and J at the rotor shaft;
// N = gear ratio (motor turns per rotor turn): at the motor shaft. tm = J·R_m/(Ke·Kt).
function physical(p, N = 1) {
    if (!p.voltage || !p.current) return null;
    const Ke = 60 / (2 * Math.PI * p.kv * N);
    return { Rm: p.rm, R0: p.beta * p.rm, dOcvPerAh: p.kappa * p.rm * 3600, Ke, Kt: Ke, J: p.tm * Ke * Ke / p.rm, i0: p.i0 };
}

module.exports = { RULES, PARAMS, PARAM, paramNames, encode, decode, copy, defaults, slip, load, ramp, initState, clone, step, outputs, simulate, steady, maxHeadspeed, physical };
if (require.main !== module) return;
