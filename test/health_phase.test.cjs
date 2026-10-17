// Ground-truth checks for tools/autotune/health_phase.cjs: simulated whole-log segments with a known liftoff and touchdown
// (the collective, the movement of the helicopter in the air, the sudden roll movement at touchdown, the airborne flag set
// early and dropped late, as on the Gaui X4 II), bench runs, logs without AIRBORNE_STATE, two flights in one log, and the
// ground checks with known injections: a yaw turn in the spool-up, a headspeed overshoot at the change to ACTIVE, motor
// kicks, an idle that is not stable, a ground resonance that increases. With AUTOTUNE_REAL_LOG (the Gaui X4 II dump
// RTFL_BLACKBOX_LOG_20261004_113720.BBL), the classes and times of all 59 logs against the peer analysis; with
// AUTOTUNE_REAL_LOG2 (RTFL_BLACKBOX_LOG_20261004_233406.BBL), the classes of its 50 logs. Both: the margins of the movement rule.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../tools/autotune/lib.cjs');
const P = require('../tools/autotune/health_phase.cjs');

const RATE = 1000, FLIGHT = { headspeed: 2000, rate: 10, minS: 5 };
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function gauss(rand) { return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand()); }
const at = (s) => Math.round(s * RATE);
const noise = (n, rand, lo, hi) => { const x = lib.bandpass(Float64Array.from({ length: n }, () => gauss(rand)), lo, hi, RATE); let s = 0; for (const v of x) s += v * v; const k = 1 / Math.sqrt(s / n); return x.map(v => v * k); }; // unit rms
const within = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);
const find = (F, id) => F.filter(f => f.id === id);

// A whole-log segment as lib.segments yields it (whole: true). Governor: OFF 0-1 s, IDLE to spoolAt, SPOOLUP (the throttle
// ramps at rampPct %/s, the rotor starts 0.5 s later and ramps at rpmRate to the target), ACTIVE, the throttle cut at land +
// cutAfter (AUTOROTATION 0.5 s, then OFF; the rotor slows at 300 rpm/s). Collective: cg on the ground; it passes 0.6 x ch at
// lift (0.5 s ramp), ch with noise in the air, 0.75 x ch from 1 s before the landing to collDown s after it, then cg. The movement
// in the air: roll and pitch at 0.2-1.5 Hz, sway deg/s rms each; at land a roll ring of jolt deg/s at 10 Hz (zeta 0.2). The
// airborne flag: flagEarly s before the liftoff to flagLate s after the touchdown (air false: no AIRBORNE_STATE events).
function sim(o = {}) {
    const c = Object.assign({ seconds: 80, spoolAt: 3, rampPct: 4, rpmRate: 250, target: 2300, lift: 25, land: 65, cg: -250, ch: 350, flagEarly: 2.5, flagLate: 1, cutAfter: 0.8,
        jolt: 150, sway: 10, air: true, gov: true, seed: 1, flights: null, overshoot: 0, tau: 0.3, idleMotor: 0, idleRpm: 0, hunt: 0, collDown: 0.5 }, o);
    const n = at(c.seconds), rand = rng(c.seed), col = () => new Float64Array(n), three = () => [col(), col(), col()];
    const w = { flight: { log: c.log || 0, id: 'sim', actualRate: RATE, rate: RATE, header: { firmwareVersion: '4.6.0' } }, whole: true, n, rate: RATE, fromS: 0, seconds: c.seconds,
        sp: three(), gyro: three(), u: three(), P: three(), I: three(), D: three(), F: three(), B: [null, null, null], hs: col(), coll: col(),
        profileAt: new Uint8Array(n), airborneAt: new Uint8Array(n), govStateAt: c.gov ? new Uint8Array(n) : null, rescueAt: new Uint8Array(n),
        extra: { 'mixer[3]': null, 'motor[0]': col(), govTarget: col(), altitude: null } };
    const flights = c.flights || [[c.lift, c.land]], startS = c.spoolAt + 0.5, act = startS + c.target / c.rpmRate, cut = flights[flights.length - 1][1] + c.cutAfter;
    const mot = w.extra['motor[0]'], tg = w.extra.govTarget, g = w.govStateAt, motAct = 10 * c.rampPct * (act - c.spoolAt);
    const fl = noise(n, rand, 0.1, 1), sw = [noise(n, rand, 0.2, 1.5), noise(n, rand, 0.2, 1.5)];
    const a0 = (L) => L - 0.5 * (0.6 * c.ch - c.cg) / (c.ch - c.cg); // the collective ramp that passes 0.6 x ch at L
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        // governor state, throttle, headspeed, target
        let st = 0, m = 0, h = 0;
        if (t < 1) { st = 0; }
        else if (t < c.spoolAt) { st = 1; m = c.idleMotor; h = c.idleRpm ? c.idleRpm * (1 + c.hunt * Math.sin(2 * Math.PI * 1.3 * t)) : 0; }
        else if (t < act) { st = 2; m = 10 * c.rampPct * (t - c.spoolAt); h = t < startS ? 0 : c.rpmRate * (t - startS); }
        else if (t < cut) { st = 4; m = motAct; h = c.target * (1 + c.overshoot * Math.exp(-(t - act) / c.tau)); }
        else { st = t < cut + 0.5 ? 7 : 0; m = 0; h = Math.max(0, c.target - 300 * (t - cut)); }
        if (g) g[i] = st; mot[i] = Math.round(m); w.hs[i] = Math.round(h + 2 * gauss(rand)) * (h > 0 ? 1 : 0); tg[i] = st === 2 ? Math.round(h) : st === 4 ? c.target : 0;
        // collective, movement, airborne flag
        let coll = c.cg, air = false, moving = false;
        for (const [L, T] of flights) {
            const A = a0(L);
            if (t >= A && t < T + c.collDown) { coll = t < A + 0.5 ? c.cg + (c.ch - c.cg) * (t - A) / 0.5 : t < T - 1 ? c.ch + 30 * fl[i] : 0.75 * c.ch; moving = t >= L && t < T; }
            else if (t >= T + c.collDown && t < T + c.collDown + 0.5) coll = 0.75 * c.ch + (c.cg - 0.75 * c.ch) * (t - T - c.collDown) / 0.5;
            if (t >= L - c.flagEarly && t < T + c.flagLate) air = true;
            if (t >= T && c.jolt) { const x = t - T, wn = 2 * Math.PI * 10; w.gyro[0][i] += c.jolt * Math.exp(-0.2 * wn * x) * Math.sin(wn * x); }
        }
        w.coll[i] = Math.round(coll);
        if (moving) for (let a = 0; a < 2; a++) w.gyro[a][i] += c.sway * sw[a][i];
        w.airborneAt[i] = c.air ? (air ? 1 : 0) : 1;
        for (let a = 0; a < 3; a++) w.gyro[a][i] = Math.round(w.gyro[a][i] + 0.3 * gauss(rand));
    }
    w.extra['mixer[3]'] = w.coll;
    return { w, c, act, cut, motAct };
}
const ctxOf = (w, over = {}) => Object.assign({ rate: RATE, govState: w.govStateAt || null, header: w.flight.header, flightRule: FLIGHT, profile: Uint8Array.from(w.profileAt) }, over);
function run(w, ctx = ctxOf(w)) {
    const ph = P.phases(w, ctx), metrics = P.analyse(w, Object.assign({}, ctx, { phases: ph })); JSON.stringify(metrics); // must serialise
    const findings = P.judge([{ log: w.flight.log, metrics }]);
    for (const f of findings) { // every finding: phase, unit, thin, source; thin data as a field; no semicolon, "+-" or ">=" in the text
        assert.ok('phase' in f && typeof f.unit === 'string' && typeof f.thin === 'boolean' && f.source && typeof f.text === 'string', JSON.stringify(f));
        assert.equal(f.thin, /^The data is not sufficient for a result\./.test(f.text), f.text);
        assert.doesNotMatch(f.text, /;|\+-|>=|<=|no finding|gear ratio|pulley|tooth/i, `${f.id}: ${f.text}`);
        for (const p of f.text.split('\n')) assert.ok(/^[A-Z]/.test(p) && /\.$/.test(p), `${f.id}: a paragraph that starts in upper case and ends with a period: ${p}`);
    }
    return { ph, metrics, findings };
}
const seconds = (mask) => mask.reduce((s, v) => s + v, 0) / RATE;

// ---------------------------------------------------------------------------------------------
// phases, flights and the log class
// ---------------------------------------------------------------------------------------------

test('a simulated flight: liftoff and touchdown within 20 ms of the truth; the airborne flag bounds them only', () => {
    const { w, c, act, cut } = sim(), { ph, findings } = run(w);
    assert.equal(ph.class, 'flight'); assert.equal(ph.flights.length, 1);
    const f = ph.flights[0];
    within(f.i0 / RATE, c.lift, 0.02, 'liftoff'); within(f.i1 / RATE, c.land, 0.02, 'touchdown');
    assert.deepEqual([f.liftoffBy, f.touchdownBy, f.confidence, f.method], ['collective', 'jolt', 'high', 'airborne+collective+touchdown movement']);
    assert.ok(f.jolt && f.jolt.value > 40 && f.bodyRms > 5, JSON.stringify(f));
    assert.deepEqual([ph.liftoffs, ph.touchdowns], [[f.i0], [f.i1]]);
    // the phases in their order, with the seconds of the simulation
    assert.deepEqual(ph.spans.map(s => s.phase), ['idle', 'spoolup', 'ground', 'flight', 'ground', 'spooldown', 'idle']);
    within(ph.seconds.idle, c.spoolAt + (c.seconds - cut - 2000 / 300), 0.02, 'idle: OFF and IDLE, then the rotor stopped');
    within(ph.seconds.spoolup, act - c.spoolAt, 0.002, 'spool-up: SPOOLUP'); within(ph.seconds.ground, (c.lift - act) + (cut - c.land), 0.03, 'ground: ACTIVE before liftoff and after touchdown');
    within(ph.seconds.flight, c.land - c.lift, 0.03, 'flight'); within(ph.seconds.spooldown, 2000 / 300, 0.02, 'spool-down: the throttle cut until the rotor is under 300 rpm');
    within(seconds(P.flightMask(w, ctxOf(w))), c.land - c.lift, 0.03, 'flightMask'); assert.deepEqual(P.flightMask(w, ctxOf(w), ph), P.flightMask(w, ctxOf(w)));
    assert.ok(!Object.keys(ph).includes('code') && ph.code.length === w.n && !JSON.stringify(ph).includes('"code"'), 'code is not in JSON');
    const d = find(findings, 'D7')[0];
    assert.deepEqual([d.severity, d.class, d.bench, d.n, d.unit, d.phase], ['note', 'flight', false, 1, 's', null]); within(d.value, c.land - c.lift, 0.03, 'D7 flight seconds');
    assert.match(d.text, /^This log is a flight log\. It has 1 flight, with a total of 40\.0 s in the air\.\nFlight 1 is from 25\.0 s to 65\.0 s \(40\.0 s\)\. For this flight, 3 signals agree: AIRBORNE_STATE, the collective and the sudden movement at the landing\.\n/);
    const cv = P.curves(w, ctxOf(w)); assert.equal(cv.t.length, 800); assert.equal(cv.names[cv.phase[45]], 'spoolup');
    assert.equal(cv.names[cv.phase[300]], 'flight'); assert.equal(cv.names[cv.phase[200]], 'ground'); assert.deepEqual(cv.flights.length, 1);
});

test('the airborne flag set 1-4 s early and dropped 0.5-2 s late, and no flag at all: the same liftoff and touchdown', () => {
    for (const [flagEarly, flagLate] of [[1.2, 0.5], [4.3, 1.9]]) {
        const { w, c } = sim({ flagEarly, flagLate, seed: 2 }), f = run(w).ph.flights[0];
        within(f.i0 / RATE, c.lift, 0.02, `liftoff, flag ${flagEarly} s early`); within(f.i1 / RATE, c.land, 0.02, `touchdown, flag ${flagLate} s late`);
    }
    // no AIRBORNE_STATE events (lib sets every frame airborne): the data-only path
    const { w, c } = sim({ air: false, seed: 3 }), { ph, findings } = run(w), f = ph.flights[0];
    assert.equal(ph.hasAirborne, false); within(f.i0 / RATE, c.lift, 0.02, 'liftoff, no flag'); within(f.i1 / RATE, c.land, 0.02, 'touchdown, no flag');
    assert.deepEqual([f.method, f.confidence], ['collective+touchdown movement', 'medium']);
    assert.match(find(findings, 'D7')[0].text, /\nThe log does not record AIRBORNE_STATE\. Thus, the analysis finds the flights from the headspeed, the collective and the movement of the helicopter\.$/);
    // the worker can tell that the log has the events (ctx.airborneEvents), as for a segment after a logging gap
    assert.equal(P.phases(w, ctxOf(w, { airborneEvents: false })).hasAirborne, false);
});

test('a bench run: the collective at the hover value with the airborne flag set, but no movement, is not a flight', () => {
    const { w } = sim({ sway: 0, jolt: 0, seed: 4 }), { ph, metrics, findings } = run(w);
    assert.equal(ph.class, 'bench'); assert.equal(ph.flights.length, 0); assert.deepEqual(P.flightMask(w, ctxOf(w)).reduce((s, v) => s + v, 0), 0);
    assert.equal(ph.rejected.length, 1); assert.equal(ph.rejected[0].reason, 'movement'); assert.ok(ph.rejected[0].bodyRms < 1, JSON.stringify(ph.rejected[0]));
    assert.ok(!('G15' in metrics) && !('C15' in metrics), 'a bench run gets no other check');
    assert.deepEqual(findings.map(f => f.id), ['D7']);
    const d = findings[0]; assert.deepEqual([d.class, d.bench, d.n, d.value], ['bench', true, 0, 0]);
    assert.match(d.text, /^This log is a bench run\. It has no flight\. Thus, the analysis does not use this log\.\nThe analysis finds 1 period with the collective at the hover value\. In this period, the roll and pitch rates are 0\.\d\d deg\/s rms\. A flight has a minimum of 3 deg\/s rms\. With the sudden movement at the landing or an altitude increase, a flight has a minimum of 1 deg\/s rms\. Thus, this period is not a flight\.\n/);
    assert.deepEqual([d.rejectedBy, d.threshold], [{ movement: 1, short: 0, headspeed: 0 }, { minRms: 3, calmRms: 1 }]);
    // the airborne flag is set, but it is not a signal of a flight: the sticks set it (Gaui: 10 of 10 bench candidates)
    assert.ok(ph.rejected[0].airShare > 0.9 && ph.rejected[0].agree.length === 0, JSON.stringify(ph.rejected[0]));
    // the checks anyway (validation only)
    assert.ok('G15' in P.analyse(w, ctxOf(w, { includeBench: true })));
    // a short hop (1 s in the air) is not a flight either
    const hop = run(sim({ lift: 25, land: 26, seed: 5 }).w); assert.equal(hop.ph.rejected[0].reason, 'short');
    assert.match(find(hop.findings, 'D7')[0].text, /\nThe analysis finds 1 period with the collective at the hover value that is shorter than 2 s\. Thus, this period is not a flight\.\n/);
});

test('a calm flight (review A4): a 40 s hover at 2.66 deg/s rms is a flight with and without AIRBORNE_STATE; the touchdown movement or the altitude must agree; the floor is 1 deg/s', () => {
    for (const air of [true, false]) {
        const { w, c } = sim({ sway: 3, air, seed: 4 }), { ph, findings } = run(w), f = ph.flights[0];
        assert.equal(ph.class, 'flight', `AIRBORNE_STATE ${air}`); within(f.bodyRms, 2.66, 0.05, 'roll and pitch, deg/s rms'); assert.ok(f.calm && f.bodyRms < P.RULE.body.minRms);
        assert.deepEqual(f.agree, ['touchdown movement']); within(f.i0 / RATE, c.lift, 0.02, 'liftoff'); within(f.i1 / RATE, c.land, 0.02, 'touchdown');
        const d = find(findings, 'D7')[0]; assert.deepEqual([d.class, d.flights[0].calm, d.flights[0].agree], ['flight', true, ['touchdown movement']]);
        assert.match(d.text, /\(40\.0 s\)\. [^\n]* In this flight, the roll and pitch rates are only 2\.\d\d deg\/s rms\. The sudden movement at the landing shows that the helicopter was airborne\.\n/);
        assert.equal(find(findings, 'G15').length, 1, 'a flight log gets the ground checks');
    }
    // the same hover with a soft landing (no touchdown movement) and no altitude: AIRBORNE_STATE is set, but the sticks set it, so it is not evidence
    const soft = run(sim({ sway: 3, jolt: 0, seed: 4 }).w), q = soft.ph.rejected[0];
    assert.equal(soft.ph.class, 'bench'); assert.deepEqual([q.reason, q.calm, q.agree, q.airShare > 0.9], ['movement', true, [], true]);
    assert.match(find(soft.findings, 'D7')[0].text, /\nThe analysis finds 1 period with the collective at the hover value\. In this period, the roll and pitch rates are 2\.\d\d deg\/s rms\. A flight has a minimum of 3 deg\/s rms\. [^\n]* The log has no sudden movement at the landing and no altitude increase in this period\. Thus, this period is not a flight\.\n/);
    // the altitude increases by 1.5 m in 2 s after the liftoff: a flight from the altitude
    const a = sim({ sway: 3, jolt: 0, seed: 4 }); a.w.extra.altitude = Float64Array.from({ length: a.w.n }, (_, i) => { const t = i / RATE; return t >= a.c.lift && t < a.c.land ? 150 * Math.min(1, (t - a.c.lift) / 2) : 0; });
    const g = run(a.w).ph; assert.equal(g.class, 'flight'); assert.deepEqual(g.flights[0].agree, ['altitude']); within(g.flights[0].baroRise, 1.5, 0.01, 'altitude increase, m');
    // under the floor (0.97 deg/s rms), the touchdown movement alone does not make a flight
    const low = run(sim({ sway: 1, seed: 4 }).w).ph; assert.equal(low.class, 'bench');
    assert.ok(low.rejected[0].bodyRms < P.RULE.body.calmRms && low.rejected[0].agree.includes('touchdown movement'), JSON.stringify(low.rejected[0]));
});

test('a landing with no sudden movement: the collective decrease, the airborne flag or the throttle cut gives the touchdown', () => {
    // no flag and the throttle cut 5 s after the landing: the collective, 0.75 x 350 until 0.5 s after the landing, passes 0.6 x 350 0.5 x 52.5 / 512.5 s later
    const a = sim({ jolt: 0, air: false, cutAfter: 5, seed: 6 }), f = run(a.w).ph.flights[0];
    within(f.i0 / RATE, a.c.lift, 0.02, 'liftoff'); assert.deepEqual([f.touchdownBy, f.confidence], ['collective', 'low']);
    within(f.i1 / RATE, a.c.land + 0.5 + 0.5 * (0.75 * 350 - 0.6 * 350) / (0.75 * 350 + 250), 0.002, 'touchdown from the collective');
    // the flag drops 1.5 s after the landing: 1 s before that (RULE.td.flagLateS)
    const b = sim({ jolt: 0, flagLate: 1.5, cutAfter: 5, seed: 7 }), g = run(b.w).ph.flights[0];
    assert.deepEqual([g.touchdownBy, g.confidence], ['airborne flag', 'medium']); within(g.i1 / RATE, b.c.land + 1.5 - P.RULE.td.flagLateS, 0.002, 'touchdown from the flag');
    // the collective stays up until 2 s after the landing, the cut 0.8 s after it: 0.7 s before the cut (RULE.td.cutLateS)
    const c = sim({ jolt: 0, flagLate: 3, collDown: 2, seed: 8 }), h = run(c.w).ph.flights[0];
    assert.equal(h.touchdownBy, 'throttle cut'); within(h.i1 / RATE, c.cut - P.RULE.td.cutLateS, 0.002, 'touchdown from the throttle cut');
});

test('two flights in one airborne run: 5 s on the ground with the body still splits them; a descent with the collective low does not', () => {
    const { w } = sim({ seconds: 110, flights: [[25, 50], [60, 95]], flagEarly: 2.5, flagLate: 12, seed: 9 }), { ph, findings } = run(w);
    // the flag drops 12 s after the first landing, after the second liftoff: one airborne run holds the two flights
    assert.equal(ph.flights.length, 2, JSON.stringify(ph.flights.map(f => [f.t0, f.t1])));
    for (const [k, [L, T]] of [[25, 50], [60, 95]].entries()) { within(ph.flights[k].i0 / RATE, L, 0.02, `liftoff ${k + 1}`); within(ph.flights[k].i1 / RATE, T, 0.02, `touchdown ${k + 1}`); }
    assert.deepEqual(ph.spans.map(s => s.phase).slice(2, 6), ['ground', 'flight', 'ground', 'flight']);
    assert.equal(find(findings, 'D7')[0].n, 2);
    // a 4 s descent with the collective at -300 and the helicopter in movement: one flight
    const d = sim({ seed: 32 }); for (let i = at(40); i < at(44); i++) d.w.coll[i] = -300;
    const one = run(d.w).ph.flights; assert.equal(one.length, 1); within(one[0].i1 / RATE, d.c.land, 0.02, 'touchdown after the descent');
});

test('a segment that starts in flight (after a logging gap): the flight starts at the first sample and is not a liftoff', () => {
    const { w, c } = sim({ seed: 10 }), k = at(40), cut = (v) => v && v.subarray ? v.subarray(k) : v;
    const s = Object.assign({}, w, { n: w.n - k, fromS: 40, sp: w.sp.map(cut), gyro: w.gyro.map(cut), u: w.u.map(cut), P: w.P.map(cut), I: w.I.map(cut), D: w.D.map(cut), F: w.F.map(cut),
        hs: cut(w.hs), coll: cut(w.coll), profileAt: cut(w.profileAt), airborneAt: cut(w.airborneAt), govStateAt: cut(w.govStateAt), rescueAt: cut(w.rescueAt),
        extra: Object.fromEntries(Object.entries(w.extra).map(([key, v]) => [key, cut(v)])) });
    const ph = run(s).ph, f = ph.flights[0];
    assert.ok(f.atStart && f.i0 === 0 && f.t0 === 40, JSON.stringify(f)); assert.deepEqual(ph.liftoffs, []); within(f.t1, c.land, 0.02, 'touchdown, index time from fromS');
});

test('durations on the frame clock: with the time field, the flight and phase seconds are frame seconds (the worker\'s), the times stay index times', () => {
    // the frame clock runs 1.28 % slower than the index rate (as the Gaui X4 #58: about 0.6 ms for each second), with a 26 ms stall in the flight
    const { w, c } = sim({ seed: 35 }); w.extra.time = Float64Array.from({ length: w.n }, (_, i) => 5e6 + i * 1012.8 + (i >= at(40) ? 26000 : 0));
    const { ph, findings } = run(w), f = ph.flights[0], frame = (i) => (w.extra.time[i] - w.extra.time[0]) / 1e6;
    within(f.i0 / RATE, c.lift, 0.02, 'liftoff index'); assert.equal(f.t0, +(f.i0 / RATE).toFixed(3), 'index time');
    within(f.seconds, frame(f.i1) - frame(f.i0), 0.011, 'frame seconds'); assert.ok(f.seconds > (f.i1 - f.i0) / RATE + 0.5, `${f.seconds} s: not the index seconds`);
    within(ph.seconds.flight, f.seconds, 0.011, 'the flight phase'); within(find(findings, 'D7')[0].value, f.seconds, 0.011, 'D7');
    within(Object.values(ph.seconds).reduce((a, b) => a + b, 0), frame(w.n - 1), 0.01, 'all phases: the frame length of the segment');
});

// IMP-03: a motor cut in flight. The governor changes to HOLD at cutS while the helicopter is in the air (the collective at the hover
// value, the altitude baroM over the level before the liftoff), the firmware clears AIRBORNE 1 ms later (airborne.c), the rotor slows, and
// the helicopter touches the ground at contactS: a gyroRAW roll step of 10 x the largest step of the flight. The disarm (OFF) at offS.
// rx: a receiver signal loss from rx[0] to rx[1] (lib.segments w.rxLoss, cause signal: the last RC frame 0.1 s before rx[0])
// state: the governor state of the cut (5 HOLD; 7 AUTOROTATION, the pilot's option B: rxfail 1500; 4 ACTIVE: no motor cut); flagS: the flag
// drop (default 1 ms after the cut); stepX: the contact step against the largest step of the flight; jolt: the touchdown ring of sim at the
// contact (deg/s); spikeS: a 1-frame step of 50 deg/s in the flight at this time; restartS: SPOOLUP from this time, ACTIVE 2 s later
function cutSim(o = {}) {
    const c = Object.assign({ seed: 40, cutS: 50, contactS: 51.8, offS: 55, baroM: 4, rx: null, state: 5, flagS: null, stepX: 10, jolt: 0, spikeS: null, restartS: null }, o);
    const flagS = c.flagS === null ? c.cutS + 0.001 : c.flagS;
    const { w } = sim({ seed: c.seed, land: c.contactS, cutAfter: c.cutS - c.contactS, flagLate: flagS - c.contactS, jolt: c.jolt }), n = w.n;
    for (let i = at(c.cutS); i < n; i++) w.govStateAt[i] = c.restartS !== null && i >= at(c.restartS) ? (i < at(c.restartS + 2) ? 2 : 4) : i < at(c.offS) ? c.state : 0;
    if (c.spikeS !== null) for (let i = at(c.spikeS); i < at(c.spikeS) + 1; i++) w.gyro[0][i] += 50;
    const raw = [0, 1, 2].map(a => Float64Array.from(w.gyro[a])); let big = 0;
    for (let i = at(25) + 1; i < at(c.cutS); i++) big = Math.max(big, Math.abs(raw[0][i] - raw[0][i - 1]), Math.abs(raw[1][i] - raw[1][i - 1]));
    for (let i = at(c.contactS); i < n; i++) raw[0][i] += c.stepX * big;
    [0, 1, 2].forEach(a => { w.extra[`gyroRAW[${a}]`] = raw[a]; });
    w.extra.altitude = c.baroM === null ? null : Float64Array.from({ length: n }, (_, i) => i >= at(26) && i < at(c.contactS) ? 100 * c.baroM : 0);
    if (c.rx) w.rxLoss = [{ i0: at(c.rx[0]), i1: at(c.rx[1]), signal: true, cause: 'signal', returned: true, lastFrameUs: null, cut0: at(c.rx[0] - 0.11), cut1: at(c.rx[1] + 1) }];
    return { w, c, big };
}

test('IMP-03: a HOLD in flight is not a landing: the flight ends at the cut, the fall to the ground contact, the time after it, check D11', () => {
    // the cut of the pilot (HOLD with the collective at the hover value and the altitude 4 m up): flight [25, 50.0], contact 51.8 s
    const a = cutSim(), { ph, findings } = run(a.w), f = ph.flights[0];
    assert.equal(ph.flights.length, 1); within(f.i0 / RATE, 25, 0.02, 'liftoff'); within(f.i1 / RATE, 50.0, 0.01, 'the end of the flight at the cut');
    assert.deepEqual([f.touchdownBy, f.cut.by, f.cut.state], ['in-flight cut', 'pilot', 'HOLD']);
    within(f.cut.contact.i / RATE, 51.8, 0.01, 'the ground contact'); assert.equal(f.cut.contact.by, 'step'); assert.ok(f.cut.contact.ratio >= 8, `the contact step: ${f.cut.contact.ratio} x the largest step of the flight (10 x and the noise)`);
    const span = (p) => ph.spans.filter(s => s.phase === p).map(s => [s.i0 / RATE, s.i1 / RATE]);
    assert.equal(span('fall').length, 1); within(span('fall')[0][0], 50.0, 0.01, 'fall start'); within(span('fall')[0][1], 51.8, 0.01, 'fall end');
    assert.equal(span('aftercontact').length, 1); within(span('aftercontact')[0][1], 55, 0.01, 'after the contact: to the disarm (OFF)');
    assert.ok(!ph.spans.some(s => (s.phase === 'spoolup' || s.phase === 'ground') && s.i0 >= at(50) && s.i0 < at(55)), 'no spool-up and no ground phase between the cut and the disarm');
    const d11 = find(findings, 'D11')[0];
    assert.equal(d11.severity, 'flag'); assert.equal(d11.value, 1); within(d11.contactS, 51.8, 0.01, 'D11 contact'); within(d11.fallS, 1.8, 0.01, 'D11 seconds from the cut');
    assert.match(d11.text, /the governor changes to HOLD from the throttle switch or the throttle stick, while the helicopter is in the air/);
    // without the altitude, a cut by the pilot is not shown as a cut in flight (the sanity rule needs both): the old rule, the flag drop less 1 s
    const b = run(cutSim({ baroM: null }).w).ph.flights[0];
    assert.equal(b.touchdownBy, 'airborne flag'); within(b.i1 / RATE, 50.001 - P.RULE.td.flagLateS, 0.002, 'the touchdown before the fix: 49.0 s');
    // a receiver signal loss from 49.7 s (the last RC frame at 49.6 s), HOLD from the rxfail values at 49.9 s: the flight ends at the last RC frame
    const c = cutSim({ cutS: 49.9, rx: [49.7, 52.5], baroM: null }), r = run(c.w), g = r.ph.flights[0], e = find(r.findings, 'D11')[0];
    assert.deepEqual([g.touchdownBy, g.cut.by], ['in-flight cut', 'receiver loss']); within(g.i1 / RATE, 49.6, 0.002, 'the end of the flight at the last RC frame');
    within(g.cut.contact.i / RATE, 51.8, 0.01, 'contact'); assert.equal(e.severity, 'flag'); within(e.events[0].afterReturnS, 51.8 - 52.5, 0.01, 'the contact before the RX return');
    assert.match(e.text, /The last RC frame comes at approximately 49\.60 s \(check D10\)\. Thus, the flight ends at 49\.60 s\./);
    // a normal flight: D11 has no cut
    const ok = find(run(sim({ seed: 41 }).w).findings, 'D11')[0]; assert.deepEqual([ok.severity, ok.value, ok.n], ['ok', 0, 0]);
});

// review IMP-03: the pilot's option B (rxfail 1500, the AUTOROTATION band: isSpooledUp() stays true, so AIRBORNE drops late or not at all),
// and an rxfail throttle that keeps the governor ACTIVE (no motor cut). The cut is the stage-1 change after the last RC frame, not the flag drop
test('IMP-03 review: a receiver signal loss with AUTOROTATION or ACTIVE: the cut at the stage-1 change, the flag drop late, no motor cut', () => {
    // AUTOROTATION at 49.9 s (the last RC frame 49.6 s), AIRBORNE drops 1.5 s later in the loss, the ground contact 2 s after the cut
    const a = cutSim({ cutS: 49.9, contactS: 51.9, rx: [49.7, 52.5], baroM: null, state: 7, flagS: 51.4 }), A = run(a.w), fa = A.ph.flights[0], ea = find(A.findings, 'D11')[0];
    assert.deepEqual([fa.touchdownBy, fa.cut.by, fa.cut.state, fa.cut.motorCut], ['in-flight cut', 'receiver loss', 'AUTOROTATION', true]);
    within(fa.i1 / RATE, 49.6, 0.002, 'the end of the flight: the last RC frame'); within(fa.cut.i / RATE, 49.9, 0.002, 'the cut: the stage-1 change, not the flag drop at 51.4 s');
    within(ea.events[0].cutS, 49.9, 0.002, 'D11 cut'); within(ea.fallS, 2.0, 0.01, 'D11 fall'); assert.equal(ea.severity, 'flag');
    assert.match(ea.text, /At 49\.90 s, the governor changes to AUTOROTATION after the receiver signal stops, while the helicopter is in the air\./);
    within(ea.events[0].headspeedAtCut, a.w.hs[at(49.9)], 1, 'the headspeed at the stage-1 change');
    // the flag drops after the RX return (51.0 s), RX_LOSS.settleS or less after it: the same cut
    const b = run(cutSim({ cutS: 49.9, contactS: 51.9, rx: [49.7, 51.0], baroM: null, state: 7, flagS: 51.5 }).w), fb = b.ph.flights[0];
    assert.deepEqual([fb.touchdownBy, fb.cut.state], ['in-flight cut', 'AUTOROTATION']); within(fb.i1 / RATE, 49.6, 0.002, 'flight end'); within(fb.cut.contact.i / RATE, 51.9, 0.01, 'contact');
    // the flag never drops in the bound, but a contact step comes in the loss: a cut
    const c = run(cutSim({ cutS: 49.9, contactS: 51.9, rx: [49.7, 52.5], baroM: null, state: 7, flagS: 60 }).w), fc = c.ph.flights[0];
    assert.deepEqual([fc.touchdownBy, fc.cut.state], ['in-flight cut', 'AUTOROTATION']); within(fc.cut.contact.i / RATE, 51.9, 0.01, 'contact');
    // the governor stays ACTIVE: no motor cut. The flight ends at the last RC frame, the event has no state, and the text has no motor cut
    const d = run(cutSim({ cutS: 49.9, contactS: 51.9, rx: [49.7, 52.5], baroM: null, state: 4, flagS: 51.95 }).w), fd = d.ph.flights[0], ed = find(d.findings, 'D11')[0];
    assert.deepEqual([fd.touchdownBy, fd.cut.motorCut, fd.cut.state], ['in-flight cut', false, null]); within(fd.i1 / RATE, 49.6, 0.002, 'flight end');
    assert.deepEqual([ed.severity, ed.motorCut, ed.events[0].state], ['flag', false, null]); within(ed.events[0].cutS, 49.6, 0.002, 'no motor cut: the last RC frame');
    assert.match(ed.text, /At approximately 49\.60 s, the last RC frame comes while the helicopter is in the air \(check D10\)\. After it, the pilot has no RC control\. The governor does not stop the motor\./);
    assert.doesNotMatch(ed.text, /changes to ACTIVE|the motor stops/i);
    // a short loss in flight with no flag drop and no contact (the pilot keeps the control): no cut
    const e = run(cutSim({ cutS: 49.9, contactS: 65, offS: 70, rx: [40, 40.5], baroM: null, state: 7, stepX: 0 }).w).ph.flights[0];
    assert.notEqual(e.touchdownBy, 'in-flight cut', 'the loss at 40 s with the flag set and no contact is not the end of the flight');
});

// review IMP-03: a cut by the pilot needs an altitude decrease to the ground contact (not the level before the liftoff, which drifts), and a
// contact RULE.td.landingS or less after the cut is a landing; after an autorotation landing (no contact step), the motor start ends the phase
// after the ground contact; D11 does not operate without AIRBORNE_STATE
test('IMP-03 review: a HOLD 0.2 s before the ground contact is a landing; an autorotation landing and a motor start; D11 skipped without AIRBORNE_STATE', () => {
    const a = run(cutSim({ cutS: 51.6, contactS: 51.8, baroM: 0.6 }).w), fa = a.ph.flights[0];
    assert.ok(['ground contact', 'jolt'].includes(fa.touchdownBy), fa.touchdownBy); within(fa.i1 / RATE, 51.8, 0.05, 'the touchdown at the ground contact');
    assert.ok(!fa.cut && !a.ph.spans.some(q => q.phase === 'fall' || q.phase === 'aftercontact'), 'no in-flight cut');
    const d = find(a.findings, 'D11')[0]; assert.deepEqual([d.severity, d.n], ['ok', 0]); assert.match(d.text, /^The analysis finds no motor cut while the helicopter is in the air\./);
    // the altitude does not decrease to the ground contact (0.3 m): not a cut in flight
    assert.notEqual(run(cutSim({ baroM: 0.3 }).w).ph.flights[0].touchdownBy, 'in-flight cut');
    // an autorotation landing: HOLD at 50 s, the touchdown ring at 51.8 s (no contact step: a spike of 50 deg/s in the flight), SPOOLUP at 53 s
    const b = cutSim({ stepX: 0, jolt: 150, spikeS: 30, restartS: 53, offS: 70 }), B = run(b.w), fb = B.ph.flights[0];
    assert.deepEqual([fb.touchdownBy, fb.cut.by, fb.cut.contact.by], ['in-flight cut', 'pilot', 'jolt']);
    const after = B.ph.spans.filter(q => q.phase === 'aftercontact'); assert.equal(after.length, 1); within(after[0].i1 / RATE, 53, 0.01, 'the phase after the ground contact ends at the motor start');
    assert.ok(B.ph.spans.some(q => q.phase === 'spoolup' && Math.abs(q.i0 / RATE - 53) < 0.01), 'the spool-up after the landing');
    assert.equal(find(B.findings, 'D11')[0].severity, 'note', 'a cut by the pilot with no strong ground contact');
    // no AIRBORNE_STATE: check D11 does not operate (not "Satisfactory")
    const c = find(run(sim({ seed: 41, air: false }).w).findings, 'D11')[0]; assert.equal(c.severity, 'skipped'); assert.match(c.text, /does not record AIRBORNE_STATE\. Thus, check D11 did not operate\./);
    // the phases of D11 are the phases of the catalog
    assert.deepEqual(d.phases, require('../tools/autotune/catalog.cjs').CHECKS.D11.phases);
});

// ---------------------------------------------------------------------------------------------
// G15 spool-up, G16 change to ACTIVE
// ---------------------------------------------------------------------------------------------

test('G15 measures the throttle ramp and flags a yaw turn on the ground in the spool-up', () => {
    const { w, c } = sim({ seed: 11 }), { metrics, findings } = run(w), m = metrics.G15, f = find(findings, 'G15')[0];
    within(m.throttlePctPerS.mean, c.rampPct, 0.01, 'throttle ramp, %/s'); assert.equal(m.impliedSpoolupTime, 250);
    within(m.seconds.mean, 0.5 + c.target / c.rpmRate, 0.002, 'spool-up to ACTIVE, s'); within(m.rpmPerS.mean, c.rpmRate, 40, 'headspeed ramp, rpm/s (the 0.5 s before the rotor turns in it)');
    assert.deepEqual([f.severity, f.phase, f.unit, f.n], ['ok', 'spoolup', 'deg/s', 1]); assert.ok(f.value < 5, f.text);
    assert.match(f.text, /^During the spool-up, the largest yaw rate on the ground is \d+ deg\/s at [\d.]+ s\. The heading changes by \d+ deg\. This is less than 50 deg\/s\.\nThe throttle increases at 4\.0\d %\/s\. This agrees with a gov_spoolup_time of approximately 250\. The spool-up to ACTIVE is 9\.7 s long/);
    // the torque of a fast ramp turns the helicopter: a yaw turn of 300 deg/s peak, 0.4 s wide, 6 s into the spool-up
    const s = sim({ rampPct: 10, seed: 12 }), y = s.w.gyro[2]; for (let i = 0; i < s.w.n; i++) { const x = (i / RATE - (s.c.spoolAt + 6)) / 0.15; y[i] += Math.round(300 * Math.exp(-x * x / 2)); }
    const r = run(s.w), F = find(r.findings, 'G15')[0];
    assert.equal(F.severity, 'flag', F.text); within(F.value, 300, 3, 'peak yaw rate'); within(F.headingDeg, 300 * 0.15 * Math.sqrt(2 * Math.PI), 3, 'heading change, deg');
    within(r.metrics.G15.throttlePctPerS.mean, 10, 0.02, 'fast ramp'); assert.equal(r.metrics.G15.impliedSpoolupTime, 100);
    assert.match(F.text, /This is more than the limit of 150 deg\/s\. The torque of the rotor turns the helicopter on the ground\. Increase gov_spoolup_time to make the spool-up slower\./);
    // a yaw rate in flight does not count
    const a = sim({ seed: 13 }); for (let i = at(30); i < at(31); i++) a.w.gyro[2][i] += 400;
    assert.equal(find(run(a.w).findings, 'G15')[0].severity, 'ok');
    // without GOVSTATE: the spool-up phase from the headspeed
    const ng = sim({ gov: false, seed: 14 }), g = run(ng.w).metrics.G15; assert.equal(g.source, 'headspeed'); assert.ok(g.n >= 1);
});

test('G16 measures the headspeed overshoot at the change from SPOOLUP to ACTIVE and the time until it is stable', () => {
    const ok = find(run(sim({ overshoot: 0.01, seed: 15 }).w).findings, 'G16')[0];
    assert.deepEqual([ok.severity, ok.unit, ok.phase, ok.reference], ['ok', 'fraction', 'spoolup', 'govTarget']); within(ok.value, 0.01, 0.002, 'overshoot 1 %'); within(ok.settleS, 0, 0.05, 'in the band in the first 50 ms (the noise)'); assert.equal(ok.censored, false);
    const { w } = sim({ overshoot: 0.05, tau: 0.3, seed: 16 }), f = find(run(w).findings, 'G16')[0];
    assert.equal(f.severity, 'flag', f.text); within(f.value, 0.05, 0.002, 'overshoot 5 %'); within(f.settleS, 0.3 * Math.log(0.05 / 0.01), 0.06, 'stable: 5 % decays to 1 % (tau 0.3 s), with the noise of 2 rpm');
    assert.match(f.text, /^At the change from SPOOLUP to ACTIVE at [\d.]+ s, the largest headspeed error is 5\.\d\d % more than the target\. The headspeed becomes stable in a band of 1 % around the target after 0\.[45]\d s\. This is more than the limit of 3 % or 1 s\./);
    // no GOVSTATE: not measured
    assert.equal(find(run(sim({ gov: false, seed: 17 }).w).findings, 'G16')[0].severity, 'skipped');
});

test('G16: a change to ACTIVE after the liftoff has the phase flight and afterLiftoff; the text does not ask for a longer spool-up (review D-M5c)', () => {
    // the rotor reaches 2000 rpm at 11.5 s; the liftoff at 12 s comes before ACTIVE at 12.7 s (as the Fireball 0929 #3: 1.27 s)
    const { w, act } = sim({ lift: 12, overshoot: 0.05, seed: 34 }), { ph, findings } = run(w), f = find(findings, 'G16')[0];
    within(ph.flights[0].i0 / RATE, 12, 0.02, 'liftoff');
    assert.deepEqual([f.severity, f.phase, f.afterLiftoff, f.afterLiftoffN], ['flag', 'flight', true, 1], f.text);
    within(f.afterLiftoffS, act - 12, 0.03, 's from the liftoff to the change'); within(f.liftoffT, 12, 0.02, 'liftoff time');
    assert.match(f.text, /\nThe change comes 0\.\d\d s after the liftoff at 12\.0 s\. A change in rotor load can cause part of the error\. The time of this change does not identify a governor parameter change\. Compare collective, throttle and headspeed around the change to ACTIVE\./);
    assert.doesNotMatch(f.text, /Examine the spool-up/);
    // the usual order: the phase spoolup, afterLiftoff false
    const g = find(run(sim({ overshoot: 0.05, seed: 16 }).w).findings, 'G16')[0]; assert.deepEqual([g.phase, g.afterLiftoff, g.liftoffT, g.afterLiftoffN], ['spoolup', false, null, 0]);
});

// ---------------------------------------------------------------------------------------------
// G17 motor kicks, G18 idle
// ---------------------------------------------------------------------------------------------

test('G17 finds a motor step at IDLE, the rotor that turns with no motor output, and a headspeed decrease at a constant throttle', () => {
    const clean = run(sim({ seed: 18 }).w), f0 = find(clean.findings, 'G17')[0];
    assert.deepEqual([f0.severity, f0.value, f0.unit], ['ok', 0, 'count'], f0.text);
    // a step of 8 % for 50 ms at IDLE (5 % idle throttle): one kick, the step up
    const s = sim({ idleMotor: 50, seed: 19 }), mot = s.w.extra['motor[0]']; for (let i = at(1.8); i < at(1.85); i++) mot[i] += 80;
    const f = find(run(s.w).findings, 'G17')[0];
    assert.equal(f.severity, 'flag', f.text); assert.deepEqual(f.events.map(e => [e.kind, e.phase]), [['motor step', 'idle']]); within(f.events[0].t, 1.78, 0.03, 'the step up'); within(f.events[0].value, 8, 0.1, 'step, %');
    assert.equal(f.phase, 'idle'); assert.match(f.text, /^The log has 1 motor kick that the throttle does not command\. /);
    // the rotor turns for 0.2 s with no motor output at IDLE; a 25 % decrease in 0.1 s on the ground at a constant throttle
    const k = sim({ seed: 20 }); for (let i = at(2.3); i < at(2.5); i++) k.w.hs[i] = 450;
    for (let i = at(20); i < at(21); i++) { const x = (i - at(20)) / RATE; k.w.hs[i] = Math.round(k.c.target * (1 - 0.25 * Math.min(1, x / 0.1) * Math.exp(-Math.max(0, x - 0.1) / 0.4))); }
    const g = find(run(k.w).findings, 'G17')[0];
    assert.deepEqual(g.events.map(e => [e.kind, e.phase]), [['rotor turns with no motor output', 'idle'], ['headspeed decrease', 'ground']]);
    within(g.events[0].value, 450, 5, 'rpm'); within(g.events[1].t, 20, 0.05, 'the decrease'); assert.ok(g.events[1].value < -10, JSON.stringify(g.events[1]));
    assert.match(g.text, /\nKick 2 is at 20\.0 s \(on the ground\), a sudden decrease of the headspeed of 2\d\.\d %\.$/);
    // the same decrease from a collective punch: not a kick; no GOVSTATE: not measured
    const p = sim({ seed: 21 }); for (let i = at(20); i < at(21); i++) { p.w.hs[i] = Math.round(p.c.target * 0.75); p.w.coll[i] = 900; }
    assert.equal(find(run(p.w).findings, 'G17')[0].value, 0, 'a collective punch');
    assert.equal(find(run(sim({ gov: false, seed: 33 }).w).findings, 'G17')[0].severity, 'skipped');
});

test('G18 measures the headspeed at IDLE with a constant motor output; an idle that hunts is flagged', () => {
    const st = find(run(sim({ idleMotor: 150, idleRpm: 800, spoolAt: 6, seed: 22 }).w).findings, 'G18')[0];
    assert.deepEqual([st.severity, st.unit, st.phase], ['ok', 'fraction', 'idle'], st.text); assert.ok(st.value < 0.005 && st.n === 10, JSON.stringify(st));
    const h = find(run(sim({ idleMotor: 150, idleRpm: 800, hunt: 0.15, spoolAt: 6, seed: 23 }).w).findings, 'G18')[0];
    assert.equal(h.severity, 'flag', h.text); within(h.value, 0.15 / Math.SQRT2, 0.02, 'rms of a 15 % oscillation at 1.3 Hz in windows of 0.5 s'); assert.ok(h.se > 0 && h.se < 0.01);
    const thin = find(run(sim({ idleMotor: 150, idleRpm: 800, spoolAt: 2, seed: 24 }).w).findings, 'G18')[0];
    assert.ok(thin.severity === 'note' && thin.thin === true && thin.n === 2, JSON.stringify(thin));
    const none = find(run(sim({ seed: 25 }).w).findings, 'G18')[0];
    assert.equal(none.severity, 'skipped'); assert.match(none.text, /^At IDLE, the motor output is 0\./);
});

// ---------------------------------------------------------------------------------------------
// C15 ground resonance
// ---------------------------------------------------------------------------------------------

test('C15 flags a roll oscillation on the skids before liftoff that increases, with its frequency and growth', () => {
    const { w, c } = sim({ seed: 26 }), t0 = c.lift - 3;
    for (let i = at(t0); i < at(c.lift); i++) { const t = i / RATE; w.gyro[0][i] += Math.round(Math.SQRT2 * Math.exp(1.0 * (t - t0)) * Math.sin(2 * Math.PI * 8.5 * t)); }
    const { findings } = run(w), f = find(findings, 'C15')[0];
    assert.deepEqual([f.severity, f.axis, f.unit, f.phase], ['flag', 'roll', 'deg/s', 'ground'], f.text);
    within(f.hz, 8.5, 0.2, 'frequency'); assert.ok(Math.abs(f.growth - 1.0) <= 2 * f.growthSe + 0.15, `growth ${f.growth} +- ${f.growthSe}, truth 1.0 /s`); within(f.value, Math.exp(2.9) * 0.81, 2, 'peak rms, deg/s: the last window, 0.81 = the gain of the 5-15 Hz band-pass at 8.5 Hz');
    assert.match(f.text, /\nAt [\d.]+ s, the roll rate has an oscillation at 8\.\d ± 0\.\d Hz of [\d.]+ deg\/s rms on the skids\. The oscillation increases \([\d.]+ ± [\d.]+ \/s\)\. The collective is -2\d\d and the headspeed is 2\d\d\d rpm, with the governor in ACTIVE\.\nGround resonance is a possible cause\. This check does not identify a gain change\./);
    // the same peak that decreases (a knock on the skids): a note; nothing: ok
    const d = sim({ seed: 27 }); for (let i = at(20); i < at(23); i++) { const t = i / RATE; d.w.gyro[1][i] += Math.round(20 * Math.SQRT2 * Math.exp(-2 * (t - 20)) * Math.sin(2 * Math.PI * 9 * t)); }
    const g = find(run(d.w).findings, 'C15')[0]; assert.deepEqual([g.severity, g.axis], ['note', 'pitch'], g.text); assert.match(g.text, /The measured oscillation does not increase by more than 2 SE\. This check does not identify its cause\.$/);
    assert.equal(find(run(sim({ seed: 28 }).w).findings, 'C15')[0].severity, 'ok');
    // less than 1 s of ground running before the liftoff: not sufficient data
    const q = find(run(sim({ lift: 10.4, seed: 29 }).w).findings, 'C15')[0]; assert.ok(q.severity === 'note' && q.thin, JSON.stringify(q)); // 9.5-10.4 s at 1500 rpm or more
});

// ---------------------------------------------------------------------------------------------
// contract, cost
// ---------------------------------------------------------------------------------------------

test('metrics are JSON-safe, inputs are not changed, missing fields do not throw, and the cost is under 0.3 s for each 100 s', () => {
    const { w } = sim({ seconds: 300, land: 280, seed: 30 }), sumOf = (o) => { let s = 0; const walk = (v) => { if (ArrayBuffer.isView(v)) { for (const x of v) s += x; } else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); }; walk(o); return s; };
    const before = sumOf(w), ctx = ctxOf(w), times = [];
    for (let k = 0; k < 3; k++) { const t = process.hrtime.bigint(); const ph = P.phases(w, ctx); P.analyse(w, Object.assign({}, ctx, { phases: ph })); P.flightMask(w, ctx, ph); times.push(Number(process.hrtime.bigint() - t) / 1e9); }
    times.sort((a, b) => a - b); assert.ok(times[1] < 0.9, `phases + analyse of 300 s: ${times[1].toFixed(3)} s`);
    assert.equal(sumOf(w), before, 'w unchanged');
    // no collective, no motor, no target, no GOVSTATE
    const m = sim({ seed: 31 }).w; m.coll = null; m.extra = { 'mixer[3]': null, 'motor[0]': null, govTarget: null, altitude: null }; m.govStateAt = null;
    const r = run(m, ctxOf(m)); assert.equal(r.ph.collective, null); assert.ok(r.ph.notes.some(s => /^The log does not have the collective\./.test(s)));
    assert.deepEqual(find(r.findings, 'G16').map(f => f.severity), ['skipped']); assert.deepEqual(find(r.findings, 'G18').map(f => f.severity), ['skipped']);
    // a log the module never saw (no metrics) gives nothing
    assert.deepEqual(P.judge([{ log: 1, metrics: null }]), []);
});

// ---------------------------------------------------------------------------------------------
// The real Gaui X4 II dump (AUTOTUNE_REAL_LOG): 59 logs, of which 49, 50, 51 and 58 are flights (analysis/gaui-x4 census)
// ---------------------------------------------------------------------------------------------

// The margins of the movement rule (review A4, RULE.body): every flight moves at 3 x minRms or more and has both signals that
// the sticks do not set; every rejected bench candidate moves at less than calmRms / 5 and has neither, with AIRBORNE_STATE
// set for most of its time (thus the flag is not a signal of a flight)
function margins(list) {
    const fl = list.flatMap(p => p.flights), rj = list.flatMap(p => p.rejected.filter(q => q.reason === 'movement'));
    assert.ok(fl.length && rj.length, `${fl.length} flights, ${rj.length} bench candidates`);
    for (const f of fl) { assert.ok(f.bodyRms >= 3 * P.RULE.body.minRms, JSON.stringify(f)); assert.deepEqual(f.agree, ['touchdown movement', 'altitude']); }
    for (const q of rj) { assert.ok(q.bodyRms < P.RULE.body.calmRms / 5, JSON.stringify(q)); assert.deepEqual(q.agree, []); if (q.airShare !== null) assert.ok(q.airShare > 0.8, JSON.stringify(q)); }
}

// the peer analysis in frame seconds: liftoff by its collective rule, checked with the baro (analysis/gaui-x4/spoolup
// census.txt), and the first touchdown transient of each landing (landing.txt)
const PEER = { 49: [31.36, 188.615], 50: [15.46, 74.227], 51: [15.65, 92.159], 58: [15.41, 320.585] };
test('the Gaui X4 II dump: logs 49, 50, 51 and 58 are the flight logs; liftoff and touchdown within 50 ms of the peer analysis', { skip: !process.env.AUTOTUNE_REAL_LOG && 'AUTOTUNE_REAL_LOG is not set' }, () => {
    const app = lib.loadApp(), out = new Map();
    for (const w of lib.segments(app, process.env.AUTOTUNE_REAL_LOG, { whole: true, extra: P.EXTRA.concat(['time']) })) {
        if (w.skipped) continue;
        const fl = w.flight, ctx = { rate: fl.actualRate, govState: w.govStateAt || null, header: fl.header, flightRule: { headspeed: 2000 }, profile: w.profileAt };
        const ph = P.phases(w, ctx), m = P.analyse(w, Object.assign({}, ctx, { phases: ph })), frame = (i) => w.fromS + (w.extra.time[Math.min(w.n - 1, i)] - w.extra.time[0]) / 1e6;
        out.set(fl.log, { ph, m, frames: ph.flights.map(f => [frame(f.i0), frame(f.i1)]) });
    }
    assert.equal(out.size, 59);
    assert.deepEqual([...out].filter(([, v]) => v.ph.class === 'flight').map(([k]) => k), [49, 50, 51, 58]);
    for (const [log, [L, T]] of Object.entries(PEER)) {
        const v = out.get(+log); assert.equal(v.frames.length, 1, `log ${log}`);
        within(v.frames[0][0], L, 0.05, `log ${log} liftoff`); within(v.frames[0][1], T, 0.05, `log ${log} touchdown`);
        assert.equal(v.ph.flights[0].confidence, 'high');
    }
    // the ground resonance before liftoff in 3 of 4 flights (GROUND-LIFTOFF-OSC: 8.46 +- 0.11 Hz), none in log 49
    const F = P.judge([...out].map(([log, v]) => ({ log, metrics: v.m }))), c15 = find(F, 'C15');
    assert.deepEqual(c15.map(f => [f.log, f.severity]), [[49, 'ok'], [50, 'flag'], [51, 'flag'], [58, 'flag']]);
    for (const f of c15.filter(f => f.severity === 'flag')) { assert.equal(f.axis, 'roll'); within(f.hz, 8.46, 0.4, `log ${f.log} frequency`); }
    // the bench runs get D7 only; the spool-ups of the flights: 3.4-4.1 %/s, no yaw turn
    assert.equal(find(F, 'D7').filter(f => f.bench).length, 55);
    margins([...out.values()].map(v => v.ph));
    for (const f of find(F, 'G15')) { assert.equal(f.severity, 'ok'); assert.ok(f.throttlePctPerS.mean > 3.3 && f.throttlePctPerS.mean < 4.1, JSON.stringify(f.throttlePctPerS)); }
});

// The second Gaui X4 II dump (AUTOTUNE_REAL_LOG2: RTFL_BLACKBOX_LOG_20261004_233406.BBL, 50 logs; #0-#32 repeat #26-#58 of the first):
// its 14 flight logs (analysis/gaui-x4/20261004_233406 spoolup census: load.py flown rule) and 36 bench runs
test('the second Gaui X4 II dump: exactly its 14 flight logs; the movement margins hold', { skip: !process.env.AUTOTUNE_REAL_LOG2 && 'AUTOTUNE_REAL_LOG2 is not set' }, () => {
    const app = lib.loadApp(), out = new Map();
    for (const w of lib.segments(app, process.env.AUTOTUNE_REAL_LOG2, { whole: true, extra: P.EXTRA })) {
        if (w.skipped) continue;
        const fl = w.flight; out.set(fl.log, P.phases(w, { rate: fl.actualRate, govState: w.govStateAt || null, header: fl.header, flightRule: { headspeed: 2000 }, profile: w.profileAt }));
    }
    assert.equal(out.size, 50);
    assert.deepEqual([...out].filter(([, p]) => p.class === 'flight').map(([k]) => k), [23, 24, 25, 32, 38, 39, 40, 41, 43, 45, 46, 47, 48, 49]);
    for (const [log, p] of out) if (p.class === 'flight') { assert.equal(p.flights.length, 1, `log ${log}`); assert.equal(p.flights[0].confidence, 'high'); }
    margins([...out.values()]);
});

// IMP-03, the Fireball crash log 2026-10-15 (analysis/fireball-crash-20261015/crash.bbl, 4.7.0-bbp-pr 85d7049a9): the receiver signal stops at
// 68.4444 s (the last RC frame 68.3444 s), the rxfail values give HOLD at 68.6453 s, AIRBORNE drops 1 ms later at about 5 m, the ground
// contact 70.4435 s, the RX return 70.5409 s, the disarm 72.8414 s. Before IMP-03 the flight ended at 67.6468 s ("airborne flag")
const CRASH = require('node:path').join(__dirname, '../analysis/fireball-crash-20261015/crash.bbl');
test('real: the crash log 2026-10-15: the flight ends at the last RC frame, the fall to the ground contact, check D11', { skip: !require('node:fs').existsSync(CRASH) ? 'analysis/fireball-crash-20261015/crash.bbl is not here' : false }, () => {
    const app = lib.loadApp(), [w] = [...lib.segments(app, CRASH, { whole: true, extra: P.EXTRA })].filter(q => !q.skipped), fl = w.flight;
    const ctx = { rate: fl.actualRate, govState: w.govStateAt || null, header: fl.header, flightRule: { headspeed: 2900 }, airborneEvents: true, profile: w.profileAt };
    const ph = P.phases(w, ctx), m = P.analyse(w, Object.assign({}, ctx, { phases: ph })), F = P.judge([{ log: 0, metrics: JSON.parse(JSON.stringify(m)) }]);
    const T = w.extra.time, frame = (i) => w.fromS + (T[Math.min(w.n - 1, i)] - T[0]) / 1e6, f = ph.flights[0];
    assert.equal(ph.flights.length, 1); within(frame(f.i0), 22.489, 0.003, 'liftoff'); within(frame(f.i1), 68.344, 0.003, 'the end of the flight: the last RC frame');
    assert.deepEqual([f.touchdownBy, f.cut.by, f.cut.state], ['in-flight cut', 'receiver loss', 'HOLD']);
    const span = (p) => ph.spans.filter(s => s.phase === p).map(s => [frame(s.i0), frame(s.i1)]);
    assert.equal(span('fall').length, 1); within(span('fall')[0][0], 68.344, 0.003, 'fall start (the end of the flight)'); within(span('fall')[0][1], 70.4435, 0.003, 'fall end (the ground contact)');
    assert.equal(span('aftercontact').length, 1); within(span('aftercontact')[0][1], 72.8414, 0.003, 'after the contact: to the disarm');
    assert.ok(!ph.spans.some(s => ['spoolup', 'ground'].includes(s.phase) && frame(s.i0) > 60), 'no spool-up (RECOVERY) and no ground (ACTIVE) after the cut');
    const d = F.find(q => q.id === 'D11'), e = d.events[0];
    assert.equal(d.severity, 'flag'); assert.equal(d.profile, 2); assert.equal(d.n, 1);
    within(e.cutS, 68.645, 0.002, 'the cut'); within(e.contactS, 70.4435, 0.002, 'the ground contact'); within(e.fallS, 1.798, 0.003, 'seconds from the cut');
    within(e.afterReturnS, 70.4435 - 70.5409, 0.003, 'the contact comes before the RX return'); assert.equal(e.contactBy, 'step'); assert.equal(e.field, 'gyroRAW');
    assert.ok(e.peak.roll > 1500 && e.baroRise > 3.5 && e.baroDrop > 3.5, JSON.stringify(e)); assert.ok(e.ratio >= 4.3, `the contact step ratio ${e.ratio}`);
    // review IMP-03: the same log with the pilot's option B (rxfail 1500: AUTOROTATION at the stage-1 change, AIRBORNE set until flagS) and with an
    // rxfail throttle in the ACTIVE band (no motor cut). The flight ends at the last RC frame, and the cut is the stage-1 change at 68.645 s
    const idx = (sec) => { let i = 0; while (i < w.n && frame(i) < sec) i++; return i; };
    for (const [state, flagS] of [[7, 70.6], [7, 69.8], [4, 69.8]]) {
        const g = Uint8Array.from(w.govStateAt), air = Uint8Array.from(w.airborneAt); for (let i = idx(68.645); i < w.n && g[i] === 5; i++) g[i] = state; air.fill(1, idx(68.646), idx(flagS));
        const v = Object.assign({}, w, { govStateAt: g, airborneAt: air }), c2 = Object.assign({}, ctx, { govState: g }), p2 = P.phases(v, c2), f2 = p2.flights[0];
        const F2 = P.judge([{ log: 0, metrics: JSON.parse(JSON.stringify(P.analyse(v, Object.assign({}, c2, { phases: p2 })))) }]), d2 = F2.find(q => q.id === 'D11'), e2 = d2.events[0], what = `state ${state}, flag drop ${flagS} s`;
        assert.equal(p2.flights.length, 1, what); within(frame(f2.i1), 68.344, 0.003, `${what}: the end of the flight`); assert.deepEqual([f2.touchdownBy, f2.cut.by], ['in-flight cut', 'receiver loss'], what);
        const sp = (ph) => p2.spans.filter(q => q.phase === ph).map(q => [frame(q.i0), frame(q.i1)]);
        within(sp('fall')[0][1], 70.4435, 0.003, `${what}: the ground contact`); assert.ok(!p2.spans.some(q => ['spoolup', 'ground'].includes(q.phase) && frame(q.i0) > 60), what);
        assert.equal(d2.severity, 'flag', what); within(e2.contactS, 70.4435, 0.002, what);
        if (state === 7) { assert.equal(e2.state, 'AUTOROTATION', what); within(e2.cutS, 68.645, 0.002, `${what}: the cut`); within(e2.fallS, 1.798, 0.003, what); assert.ok(e2.headspeedAtCut > 4400, `${what}: ${e2.headspeedAtCut} rpm at the cut`); }
        else { assert.deepEqual([e2.motorCut, e2.state], [false, null], what); assert.match(d2.text, /the pilot has no RC control\. The governor does not stop the motor\./); assert.doesNotMatch(d2.text, /changes to ACTIVE/); }
    }
});

// IMP-03: the normal landings of the Fireball dump 2026-10-05 (AUTOTUNE_RESCUE_LOG, 4.6.0) keep their flight ends within 0.05 s (frame
// seconds before IMP-03, flight rpm 2900 as the worker): no landing there is an in-flight cut (the flag drops before the AUTOROTATION)
const LANDINGS = { 5: [10.197, 252.4335], 10: [25.9455, 196.2541], 11: [21.9612, 309.7812], 13: [7.4215, 299.0465], 14: [9.6615, 221.4822], 15: [6.9121, 246.5578] };
test('real: the Fireball dump 2026-10-05: every normal landing keeps its flight end within 0.05 s (IMP-03)', { skip: !process.env.AUTOTUNE_RESCUE_LOG && 'AUTOTUNE_RESCUE_LOG is not set' }, () => {
    const app = lib.loadApp(), got = {};
    for (const w of lib.segments(app, process.env.AUTOTUNE_RESCUE_LOG, { whole: true, extra: P.EXTRA })) {
        if (w.skipped) continue;
        const fl = w.flight, T = w.extra.time, frame = (i) => w.fromS + (T[Math.min(w.n - 1, i)] - T[0]) / 1e6;
        const ph = P.phases(w, { rate: fl.actualRate, govState: w.govStateAt || null, header: fl.header, flightRule: { headspeed: 2900 }, airborneEvents: true, profile: w.profileAt });
        if (ph.flights.length) got[fl.log] = ph.flights.map(f => [frame(f.i0), frame(f.i1), f.touchdownBy]);
        assert.ok(!ph.spans.some(s => s.phase === 'fall' || s.phase === 'aftercontact'), `log ${fl.log + 1}: no in-flight cut`);
    }
    assert.deepEqual(Object.keys(got).map(Number), Object.keys(LANDINGS).map(Number));
    for (const [log, [L, T]] of Object.entries(LANDINGS)) { assert.equal(got[log].length, 1); within(got[log][0][0], L, 0.05, `log ${+log + 1} liftoff`); within(got[log][0][1], T, 0.05, `log ${+log + 1} touchdown`); }
});
