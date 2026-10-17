'use strict';
// The flights that can show a calculated change (IMP-07, tools/autotune/validation_power.cjs).
//   node --test test/validation_power.test.cjs
//   AUTOTUNE_RESCUE_LOG=<fireball 2026-10-05 dump.bbl> node --test test/validation_power.test.cjs   # also the input-matched null of the real logs
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const P = require('../tools/autotune/validation_power.cjs');
const ROOT = path.join(__dirname, '..');

test('RULES: z is z(1 - alpha / 2) + z(power), and each threshold has its source', () => {
    assert.equal(P.RULES.alpha, 0.05); assert.equal(P.RULES.power, 0.8);
    assert.ok(Math.abs(P.RULES.z - (1.95996 + 0.84162)) < 0.01, `z ${P.RULES.z}`);
    for (const k of ['alpha', 'power', 'z', 'maxFlights', 'minFlights', 'minCoherence', 'windowS', 'lowpassHz', 'nullNeighbours', 'seed', 'band', 'uncommandedBand', 'activityLowHz', 'binTolerance', 'minNullSets'])
        assert.ok(typeof P.RULES.sources[k] === 'string' && P.RULES.sources[k], `source of ${k}`);
    assert.match(P.RULES.sources.maxFlights, /IMP-07/); assert.match(P.RULES.sources.windowS, /stats_w6_lp20_start\.txt/); assert.match(P.RULES.sources.nullNeighbours, /matched\.py/);
    // chi-square quantiles of the SD interval
    for (const [p, df, q] of [[0.025, 2, 0.0506], [0.975, 2, 7.3778], [0.025, 13, 5.0088], [0.975, 13, 24.7356]]) assert.ok(Math.abs(P.chiSquareQuantile(p, df) - q) < 1e-3, `${p} ${df}`);
});

test('n = 2 (2.8 SD / change)^2 flights for each set of values: 3.04 deg/s against 0.57 deg/s cannot be shown', () => {
    const n = P.flightsPerArm(3.04, -0.57);
    assert.ok(Math.abs(n - 446) <= 1, `n ${n}`);
    const plan = P.plan([{ id: 'tracking', axes: ['roll', 'pitch'], unit: 'deg/s', delta: -0.57, sd: 3.04, flights: 14, lowerBound: false }]);
    assert.equal(plan.available, true); assert.equal(plan.confirmable, false); assert.equal(plan.flightsPerArm, n);
    assert.match(plan.text[0], /^Flights cannot show this change in the roll and pitch tracking error\. The app calculates a change of -0\.57 deg\/s\./);
    assert.match(plan.text[1], new RegExp(`${n} flights with each set of values are necessary\\. The limit is ${P.RULES.maxFlights} flights\\.`));
    // the smallest change that 10 flights with each set of values can show: 2.8 x 3.04 x sqrt(2 / 10)
    assert.ok(Math.abs(plan.metrics[0].detectable - 2.8 * 3.04 * Math.sqrt(0.2)) < 1e-9);
    assert.match(plan.text[1], /can show a change of 3\.81 deg\/s or more\./);
    assert.match(plan.rule, /2 × \(2\.8 × standard deviation \/ change\)²/);
    assert.equal(plan.flightsRange, null, 'no SE and no degrees of freedom: no range');
});

test('the range of n: -0.57 ± 0.10 deg/s with an SD of 3.04 deg/s in 14 flights (13 degrees of freedom)', () => {
    const plan = P.plan([{ id: 'tracking', axes: ['roll', 'pitch'], unit: 'deg/s', delta: -0.57, deltaSe: 0.10, sd: 3.04, flights: 14, configurations: 1, df: 13, lowerBound: false }]);
    const r = plan.metrics[0].range;
    assert.equal(plan.flightsPerArm, 447);
    // the SE of the change alone: n at 0.67 and at 0.47 deg/s
    assert.deepEqual(r.change, [P.flightsPerArm(3.04, 0.67), P.flightsPerArm(3.04, 0.47)]); assert.deepEqual(r.change, [323, 656]);
    // the 95 % interval of the SD with 13 degrees of freedom: 3.04 x sqrt(13 / 24.736) to 3.04 x sqrt(13 / 5.009)
    assert.ok(Math.abs(r.sd[0] - 3.04 * Math.sqrt(13 / 24.7356)) < 1e-3 && Math.abs(r.sd[1] - 3.04 * Math.sqrt(13 / 5.0088)) < 1e-3, JSON.stringify(r));
    assert.deepEqual(r.spread, [P.flightsPerArm(r.sd[0], 0.57), P.flightsPerArm(r.sd[1], 0.57)]);
    assert.deepEqual(plan.flightsRange, { low: P.flightsPerArm(r.sd[0], 0.67), high: P.flightsPerArm(r.sd[1], 0.47) });
    assert.equal(plan.confirmable, false);
    assert.match(plan.text[2], /^With the standard error of the change \(0\.1 deg\/s\), the number of flights is from 323 to 656\. With the 95 % interval of the standard deviation \(2\.2 to 4\.9 deg\/s\), the number of flights is from 235 to 1158\.$/);
});

test('the range of n at the limit: a low end in the limit, and a change that is not larger than its SE', () => {
    const near = P.plan([{ id: 'tracking', axes: ['roll', 'pitch'], unit: 'deg/s', delta: -0.57, deltaSe: 0.1, sd: 0.6, flights: 14, configurations: 1, df: 13, lowerBound: false }]);
    assert.equal(near.confirmable, false); assert.ok(near.flightsPerArm > 10 && near.flightsRange.low <= 10, JSON.stringify(near.flightsRange));
    assert.match(near.text[2], /Thus, a maximum of 10 flights with each set of values can be sufficient\.$/);
    const zero = P.plan([{ id: 'tracking', axes: ['yaw'], unit: 'deg/s', delta: -0.1, deltaSe: 0.2, sd: 0.05, flights: 14, configurations: 1, df: 13, lowerBound: false }]);
    assert.equal(zero.confirmable, true); assert.equal(zero.flightsRange.high, null);
    assert.match(zero.text[2], /^The change is not larger than its standard error of 0\.2 deg\/s\. Thus, the app cannot calculate a maximum number of flights\./);
    assert.match(zero.text[2], /Thus, more than 10 flights with each set of values can be necessary\.$/);
});

test('a flight-to-flight SD of 0.3 deg/s gives a flight plan that can show the change, flown in the same period', () => {
    const plan = P.plan([{ id: 'tracking', axes: ['roll', 'pitch'], unit: 'deg/s', delta: -0.57, sd: 0.3, flights: 14, lowerBound: false,
        activity: [{ axis: 'roll', band: [1, 10], minCoherence: 0.5, flights: 14, coherent: 9, setpointRms: 22.5 }, { axis: 'pitch', band: [1, 10], minCoherence: 0.5, flights: 14, coherent: 7, setpointRms: 18.1 }] }],
        P.RULES, { selection: { periodsPerFlight: 4, periodS: 16 } });
    assert.equal(plan.confirmable, true); assert.equal(plan.flightsPerArm, 5);
    assert.match(plan.text[0], /^Flights can show this change in the roll and pitch tracking error\./);
    assert.match(plan.text[1], /^Fly 5 flights with the previous values and 5 flights with the new values\. Fly all of these flights in the same period\./);
    assert.match(plan.text[1], /Do not compare them with flights of a different period or a different firmware\./);
    // the periods that the app uses, and the stick activity of each axis
    assert.match(plan.text[2], /^The app uses the 4 periods of 16 s with the most stick input in each flight\./);
    assert.match(plan.text[2], /Your flights with a roll coherence of 0\.5 or more at 1 Hz to 10 Hz have a median roll setpoint of 22\.5 deg\/s rms\./);
    assert.match(plan.text[2], /Your flights with a pitch coherence of 0\.5 or more at 1 Hz to 10 Hz have a median pitch setpoint of 18\.1 deg\/s rms\./);
    assert.match(plan.text[2], /In each flight, make roll and pitch stick inputs of these amplitudes or larger\./);
    assert.ok(P.flightsPerArm(0.3, 0.57) <= P.RULES.maxFlights);
    // with the SE of the change and the SD interval, more than 10 flights are possible: the plan says it
    const wide = P.plan([{ id: 'tracking', axes: ['roll', 'pitch'], unit: 'deg/s', delta: -0.57, deltaSe: 0.1, sd: 0.3, flights: 14, configurations: 2, df: 12, lowerBound: false }]);
    assert.equal(wide.confirmable, true); assert.ok(wide.flightsRange.high > P.RULES.maxFlights, JSON.stringify(wide.flightsRange));
    assert.match(wide.text[2], /Thus, more than 10 flights with each set of values can be necessary\.$/);
});

test('a yaw |T(10 Hz)| change of +0.16 with a per-flight SD of 0.12 needs about 9 flights for each set of values', () => {
    assert.equal(P.flightsPerArm(0.12, 0.16), 9);
    // the measurement with the smallest number of flights is the one to fly
    const plan = P.plan([{ id: 'tracking', axes: ['yaw'], unit: 'deg/s', delta: -1.16, sd: 1.3, flights: 6 },
        { id: 'transfer', axes: ['yaw'], unit: '%', hz: 10, delta: 16, sd: 12, flights: 6, windowS: 2, pooled: 24, null: { windows: 16, mean: 31, sd: 8 } }]);
    assert.equal(plan.chosen, 1); assert.equal(plan.flightsPerArm, 9); assert.equal(plan.confirmable, true);
    assert.equal(plan.metrics[0].n, P.flightsPerArm(1.3, 1.16));
    assert.match(plan.text[0], /the yaw tracking error at 10 Hz, as a percentage of the setpoint/);
    assert.match(plan.text.at(-1), /^With no change, one flight with 16 windows of 2 s gives 31 ± 8 %\. All flights together give 24 %\./);
    // a band: its edges in the label; a null with no spread gives no paragraph
    assert.equal(P.label({ id: 'transfer', axes: ['roll'], hz: 4, band: [3, 5] }), 'the roll tracking error at 3 Hz to 5 Hz, as a percentage of the setpoint');
    const flat = P.plan([{ id: 'transfer', axes: ['yaw'], unit: '%', hz: 10, delta: 16, sd: 12, flights: 6, windowS: 2, pooled: 24, null: { windows: 8, mean: 216.1443, sd: 0 } }]);
    assert.ok(!flat.text.some(t => /^With no change/.test(t)), flat.text.join(' | '));
});

test('a lower-bound SD never gives a plan that flights can show; a measured SD wins over a lower bound', () => {
    for (const sd of [0.2, 0.3]) {
        const low = P.plan([{ id: 'uncommanded', axes: ['roll', 'pitch'], unit: 'deg/s', band: [0.5, 8], delta: -1.25, sd, flights: 2, configurations: 1, df: 1, lowerBound: true }]);
        assert.equal(low.confirmable, false); assert.equal(low.lowerBound, true); assert.ok(low.flightsPerArm <= P.RULES.maxFlights);
        const all = low.text.join(' ');
        assert.doesNotMatch(all, /Flights can show/); assert.doesNotMatch(all, /\bFly \d/);
        assert.match(low.text[0], /^The app cannot calculate the flight-to-flight standard deviation\. The measurement is the roll and pitch gyro movement that the stick inputs do not cause, at 0\.5 Hz to 8 Hz\. Your logs have 2 flights with this PID profile in 1 configuration\. The windows of your flights give a minimum standard deviation of /);
        assert.match(low.text[1], /a minimum of \d+ flights with each set of values is necessary\. More flights can be necessary\./);
        assert.match(low.text[2], /^For a flight-to-flight standard deviation, the number of flights must be a minimum of 2 more than the number of configurations\./);
        assert.equal(low.flightsRange, null);
    }
    // a lower bound above the limit: flights cannot show the change
    const big = P.plan([{ id: 'tracking', axes: ['yaw'], unit: 'deg/s', delta: -0.2, sd: 1, flights: 2, configurations: 2, df: 0, lowerBound: true }]);
    assert.equal(big.confirmable, false); assert.match(big.text[1], /^Flights cannot show this change\. .* The limit is 10 flights\.$/);
    // the measured SD is chosen although the lower bound gives a smaller n
    const both = P.plan([{ id: 'tracking', axes: ['roll'], unit: 'deg/s', delta: -1, sd: 0.1, flights: 2, df: 1, lowerBound: true },
        { id: 'transfer', axes: ['roll'], unit: '%', hz: 4, delta: 10, sd: 8, flights: 6, df: 5, lowerBound: false }]);
    assert.equal(both.chosen, 1); assert.equal(both.lowerBound, false); assert.equal(both.flightsPerArm, P.flightsPerArm(8, 10));
});

test('no number without a flight-to-flight SD or a change; too few degrees of freedom give a lower bound or no SD', () => {
    assert.equal(P.flightsPerArm(null, 1), null); assert.equal(P.flightsPerArm(1, 0), null);
    const none = P.plan([]);
    assert.equal(none.available, false); assert.match(none.text[0], /^The app cannot calculate the number of flights/);
    const few = P.plan([{ id: 'tracking', axes: ['yaw'], unit: 'deg/s', delta: -0.5, sd: null, flights: 3, configurations: 2, df: 1, lowerBound: false }]);
    assert.match(few.text[0], /Your logs have 3 flights with this PID profile in 2 configurations\. For a flight-to-flight standard deviation, the number of flights must be a minimum of 2 more than the number of configurations\./);
    const unknown = P.plan([{ id: 'tracking', axes: ['yaw'], unit: 'deg/s', delta: 0, sd: 1, flights: 9, df: 8, lowerBound: false }]);
    assert.match(unknown.text[0], /The app cannot find the flight-to-flight standard deviation or the change\./);
    // spread(): with fewer degrees of freedom than RULES.minFlights - 1 the windows give SD / sqrt(windows of a flight)
    assert.deepEqual(P.spread([1, 2], [1, 3, 1, 3], 4), { sd: Math.sqrt(4 / 3) / 2, flights: 2, configurations: 1, df: 1, lowerBound: true });
    // the spectral measurements have no window values: no SD
    assert.deepEqual(P.spread([1, 2], [], 4), { sd: null, flights: 2, configurations: 1, df: 1, lowerBound: false });
    assert.deepEqual(P.spread([1, 2, 3], [], 4), { sd: 1, flights: 3, configurations: 1, df: 2, lowerBound: false });
    // the SD is pooled inside each configuration: a gain difference between configurations is not flight-to-flight spread
    const two = P.spread([{ value: 1, group: 'A' }, { value: 2, group: 'A' }, { value: 3, group: 'A' }, { value: 11, group: 'B' }, { value: 13, group: 'B' }], [], 4);
    assert.deepEqual(two, { sd: Math.sqrt(4 / 3), flights: 5, configurations: 2, df: 3, lowerBound: false });
    // 3 flights in 3 configurations: no degrees of freedom
    assert.equal(P.spread([{ value: 1, group: 'A' }, { value: 2, group: 'B' }, { value: 3, group: 'C' }], [], 4).sd, null);
    // one flight has no spread: a minimum of RULES.minFlights flights with each set of values
    assert.equal(P.flightsPerArm(0.01, 1), P.RULES.minFlights);
});

test('a gain-model decision (C7): the measured SE over flights times the square root of the flights, its own measurement', () => {
    const plan = P.forDecision({ axis: 'pitch', dTrack: 1.4, seTrack: 0.5, flights: 5, measured: { trackRmsSE: 0.4 } });
    const sd = 0.4 * Math.sqrt(5);
    assert.ok(Math.abs(plan.metrics[0].sd - sd) < 1e-12); assert.equal(plan.flightsPerArm, P.flightsPerArm(sd, 1.4));
    assert.equal(plan.metrics[0].delta, -1.4); assert.equal(plan.confirmable, true);
    assert.equal(plan.metrics[0].id, 'decision'); assert.equal(plan.metrics[0].df, 4);
    assert.equal(plan.metrics[0].label, 'the pitch tracking error in the band of the gain model');
    assert.equal(P.forDecision({ axis: 'pitch', dTrack: 1.4, flights: 5, measured: {} }).available, false);
});

test('the input-matched null: one window for each target from its nearest unused windows, repeatable, no window twice', () => {
    const pool = Array.from({ length: 200 }, (_, i) => ({ power: 1 + i, flight: 'f' + (i % 5), id: i }));
    const sum = set => set.reduce((s, w) => s + w.power, 0), a = P.matchedNull(pool, [10, 50, 150], sum), b = P.matchedNull(pool, [10, 50, 150], sum);
    assert.deepEqual(a, b, 'the same seed gives the same sets');
    assert.equal(a.windows, 3); assert.equal(a.sets, P.RULES.nullSets); assert.equal(a.flights, 5);
    // each target picks from its 20 nearest windows in log power: the sum stays near 10 + 50 + 150
    assert.ok(Math.abs(a.mean - 210) < 12, JSON.stringify(a)); assert.ok(a.sd > 0);
    let twice = 0; P.matchedNull(pool, [10, 10, 10, 10, 10, 10], set => { if (new Set(set.map(w => w.id)).size < set.length) twice++; return 1; });
    assert.equal(twice, 0, 'no window twice in a set');
    assert.equal(P.matchedNull(pool.slice(0, 5), [1, 2, 3], () => 1), null, 'fewer than 2 windows for each target');
    assert.equal(P.matchedNull(pool.map(w => Object.assign({}, w, { flight: 'one' })), [10, 50], sum), null, 'windows of one flight');
    assert.deepEqual(P.usualTargets([{ power: 1 }, { power: 2 }, { power: 3 }, { power: 4 }], 2), [2, 4]);
});

test('the input-matched null of a planned flight of 50 windows from a pool of 5 flights: all sets, not rejected', () => {
    const r = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
    for (const flights of [4, 5, 6]) {
        const pool = []; for (let f = 0; f < flights; f++) for (let i = 0; i < 60; i++) pool.push({ power: Math.exp(3 * r()), flight: 'f' + f, value: r() });
        const targets = P.usualTargets(pool, 50), nl = P.matchedNull(pool, targets, set => set.reduce((s, w) => s + w.value, 0) / set.length);
        assert.ok(nl && nl.sets >= P.RULES.minNullSets, `${flights} flights: ${JSON.stringify(nl)}`);
        assert.equal(nl.sets, P.RULES.nullSets); assert.equal(nl.windows, 50); assert.ok(nl.sd > 0);
    }
    // one flight (the pool is the targets): no null
    const one = Array.from({ length: 50 }, (_, i) => ({ power: 1 + i, flight: 'f0' }));
    assert.equal(P.matchedNull(one, P.usualTargets(one, 50), () => 1), null);
});

// Synthetic flights: the gyro follows the setpoint through a first-order lag with noise; each flight has its own noise level.
// The model predicts a faster lag after the change.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 - 0.5; }; }
function flight(id, seed, seconds, rate, noise, tauS) {
    const n = Math.round(seconds * rate), r = rng(seed), sp = [0, 1, 2].map(() => new Float64Array(n)), y = [0, 1, 2].map(() => new Float64Array(n));
    for (let a = 0; a < 3; a++) {
        const parts = [0.7, 1.5, 2.6, 4.1, 6.3, 8.9].map(f => [f, 2 * Math.PI * (r() + 0.5), 12 / f]);
        let g = 0, d = 0;
        for (let i = 0; i < n; i++) {
            const t = i / rate; sp[a][i] = parts.reduce((s, [f, ph, amp]) => s + amp * Math.sin(2 * Math.PI * f * t + ph), 0);
            d += 0.05 * (r() * 40 - d); g += (sp[a][i] - g) / (tauS * rate); y[a][i] = g + noise * d;
        }
    }
    return { flight: id, rate, n, sp, y };
}
test('a model change: tracking error, band |1 - T| at the largest change and the uncommanded movement, flight as the unit', () => {
    const rate = 250, recorded = [0, 1, 2, 3, 4].map(k => flight('f' + k, 11 + k, 30, rate, 0.5 + 0.15 * k, 0.04));
    const predicted = [0, 1].map(k => { const before = flight('t' + k, 50 + k, 20, rate, 0.5, 0.04), after = flight('t' + k, 50 + k, 20, rate, 0.5, 0.025);
        return { flight: before.flight, rate, n: before.n, sp: before.sp, before: before.y, after: after.y, from: rate }; });
    const plan = P.forModel({ recorded, predicted, axes: [0, 1], change: { mean: 0.5, se: 0.1 }, selection: { periodsPerFlight: 4, periodS: 16 } });
    const by = Object.fromEntries(plan.metrics.map(m => [m.id, m]));
    assert.deepEqual(Object.keys(by).sort(), ['tracking', 'transfer', 'uncommanded']);
    assert.equal(by.tracking.flights, 5); assert.equal(by.tracking.df, 4); assert.equal(by.tracking.lowerBound, false); assert.ok(by.tracking.sd > 0);
    // the change of the tracking error: the same 6 s windows on the model gyro of the test flights (a faster lag: smaller)
    const paired = P.pairedTracking(predicted, [0, 1]);
    assert.equal(by.tracking.deltaSource, 'windows'); assert.equal(by.tracking.delta, paired.mean); assert.equal(by.tracking.deltaSe, paired.se);
    assert.ok(paired.mean < 0 && paired.flights === 2 && paired.se > 0, JSON.stringify(paired));
    assert.equal(by.tracking.windowsPerFlight, 5); assert.ok(by.tracking.null && by.tracking.null.windows === 5);
    // the stick activity of each step axis
    assert.deepEqual(by.tracking.activity.map(a => [a.axis, a.flights, a.band]), [['roll', 5, [1, 10]], ['pitch', 5, [1, 10]]]);
    // a faster lag: |1 - T| decreases, the most at a higher frequency. The change, the flight values, the pooled value and the
    // null are the band value of bandOneMinusT with the recorded setpoint spectrum as the weights
    assert.ok(by.transfer.delta < 0 && by.transfer.hz >= 1 && by.transfer.hz <= 10, JSON.stringify(by.transfer));
    assert.equal(by.transfer.statistic, 'bandOneMinusT'); assert.deepEqual(by.transfer.band, [Math.max(0.5, by.transfer.hz - 1), by.transfer.hz + 1]);
    const a = ['roll', 'pitch'].indexOf(by.transfer.axes[0]), rec = P.spectralWindows(recorded, [0, 1]), S = P.sumOf(rec, a), W = Float64Array.from(S.rr, v => v / S.count);
    const bins = P.binsOf(rec[0], by.transfer.band[0], by.transfer.band[1]);
    assert.ok(Math.abs(by.transfer.pooled - 100 * P.bandOneMinusT(S, bins, W)) < 1e-9, 'the pooled value is the band statistic');
    assert.equal(by.transfer.unit, '%'); assert.ok(by.transfer.sd > 0 && by.transfer.null && by.transfer.pooled > 0);
    assert.deepEqual(by.transfer.activity.map(x => x.axis), [by.transfer.axes[0]]);
    assert.ok(Number.isFinite(by.uncommanded.relative) && by.uncommanded.sd > 0 && by.uncommanded.lowerBound === false);
    assert.deepEqual(by.uncommanded.activity.map(x => [x.axis, x.band]), [['roll', [0.5, 8]], ['pitch', [0.5, 8]]]);
    for (const m of plan.metrics) assert.equal(m.n, P.flightsPerArm(m.sd, m.delta));
    const best = Math.min(...plan.metrics.map(m => m.n));
    assert.equal(plan.metrics[plan.chosen].n, best); assert.equal(plan.flightsPerArm, best); assert.equal(plan.confirmable, best <= P.RULES.maxFlights);
    assert.ok(!plan.text.join(' ').includes('Stick inputs are not necessary'));
    if (plan.confirmable) assert.ok(plan.text.some(t => /^The app uses the 4 periods of 16 s with the most stick input in each flight\./.test(t)), plan.text.join(' | '));
    assert.deepEqual(P.forModel({ recorded, predicted, axes: [0, 1], change: { mean: 0.5, se: 0.1 }, selection: { periodsPerFlight: 4, periodS: 16 } }), plan, 'repeatable');
    // no test flights: only the tracking error, from the calculated change of the frozen test
    const only = P.forModel({ recorded, predicted: [], axes: [0, 1], change: { mean: 0.5 } });
    assert.deepEqual(only.metrics.map(m => [m.id, m.delta, m.deltaSource]), [['tracking', -0.5, 'frozen test']]);
    // two flights of the PID profile: the spectral measurements have no SD, the tracking error a lower bound only
    const two = P.forModel({ recorded: recorded.slice(0, 2), predicted, axes: [0, 1], change: { mean: 0.5, se: 0.1 } });
    const t2 = Object.fromEntries(two.metrics.map(m => [m.id, m]));
    assert.equal(t2.tracking.lowerBound, true); assert.equal(t2.transfer.sd, null); assert.equal(t2.uncommanded.sd, null);
    assert.equal(t2.transfer.null, null, 'windows of 2 flights: no null');
    assert.equal(two.confirmable, false); assert.ok(!two.text.join(' ').includes('Flights can show'));
});

// Acceptance (improvements.json IMP-07): on the 2026-10-05 data, the input-matched null of PID profile 2 roll |1 - T| for the
// windows of the crash flight (16 windows of 2 s in 8 blocks, 37.637 s to 68.265 s) is 0.36 ± 0.08, and the pooled value 0.19
// (analysis/fireball-crash-20261015/verify/tuning-content-F4-0/matched.txt; 10-05 flights only: 0.373 ± 0.082, pooled 0.184).
const DUMP = process.env.AUTOTUNE_RESCUE_LOG, CRASH = path.join(ROOT, 'analysis/fireball-crash-20261015/crash.bbl'),
    SPEC = path.join(ROOT, 'analysis/fireball-crash-20261015/verify/tuning-content-F4-0/spec.json');
test('the input-matched null of the 2026-10-05 flights for the windows of the crash flight', { skip: !(DUMP && fs.existsSync(DUMP) && fs.existsSync(CRASH) && fs.existsSync(SPEC)) && 'set AUTOTUNE_RESCUE_LOG (the Fireball 2026-10-05 dump)' }, () => {
    const lib = require('../tools/autotune/lib.cjs'), app = lib.loadApp(ROOT);
    function periods(file, list) {
        const log = new app.FlightLog(fs.readFileSync(file)), out = [];
        for (const s of list) {
            assert.ok(log.openLog(s.log), `log ${s.log}`);
            const ix = Object.fromEntries(log.getMainFieldNames().map((n, k) => [n, k])), t0 = log.getMinTime(), T = [], sp = [[], [], []], y = [[], [], []];
            for (const ch of log.getChunksInTimeRange(t0 + s.fromS * 1e6, t0 + s.toS * 1e6)) for (const f of ch.frames) {
                const t = (f[ix.time] - t0) / 1e6; if (t < s.fromS || t > s.toS) continue;
                T.push(t); for (let a = 0; a < 3; a++) { sp[a].push(f[ix[`setpoint[${a}]`]]); y[a].push(f[ix[`gyroADC[${a}]`]]); }
            }
            out.push({ flight: s.flight, rate: (T.length - 1) / (T[T.length - 1] - T[0]), n: T.length, sp: sp.map(c => Float64Array.from(c)), y: y.map(c => Float64Array.from(c)) });
        }
        return out;
    }
    const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8')).filter(s => /20261005_204823/.test(s.file) && s.invProfile === 2);
    const pool46 = periods(DUMP, spec.map(s => ({ log: s.log, fromS: s.fromS, toS: s.toS, flight: 'log' + s.log })));
    const crash = periods(CRASH, [{ log: 0, fromS: 37.637, toS: 68.265, flight: 'crash' }])[0];
    const nb = Math.floor((crash.n - 1) / crash.rate / 3.5), L = Math.floor(crash.n / nb);
    const blocks = Array.from({ length: nb }, (_, b) => { const j0 = b * L, j1 = b === nb - 1 ? crash.n : j0 + L;
        return { flight: 'crash', rate: crash.rate, n: j1 - j0, sp: crash.sp.map(c => c.subarray(j0, j1)), y: crash.y.map(c => c.subarray(j0, j1)) }; });
    const w47 = P.spectralWindows(blocks, [0]), w46 = P.spectralWindows(pool46, [0]), bins = P.binsOf(w47[0], 1, 10);
    const S47 = P.sumOf(w47, 0), W = Float64Array.from(S47.rr, v => v / S47.count), power = w => bins.reduce((s, k) => s + w.axis[0].rr[k], 0);
    const pool = w46.map(w => Object.assign({ power: power(w) }, w));
    const nl = P.matchedNull(pool, w47.map(power), set => P.bandOneMinusT(P.sumOf(set, 0), bins, W), Object.assign({}, P.RULES, { nullSets: 4000 }));
    const pooled = P.bandOneMinusT(P.sumOf(w46, 0), bins, W), flown = P.bandOneMinusT(S47, bins, W);
    assert.equal(nb, 8); assert.equal(w47.length, 16); assert.deepEqual([bins[0], bins.at(-1)], [2, 20]);
    assert.ok(Math.abs(flown - 0.51) < 0.01, `crash flight ${flown}`);
    assert.ok(Math.abs(pooled - 0.19) < 0.015, `pooled ${pooled}`);
    assert.ok(Math.abs(nl.mean - 0.36) < 0.03 && Math.abs(nl.sd - 0.08) < 0.02, JSON.stringify(nl));
    assert.equal(nl.sets, 4000, 'the constructive draw accepts every set'); assert.equal(nl.flights, 6);
});
