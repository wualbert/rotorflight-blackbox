'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const model = require('../tools/autotune/helicopter_model.cjs');
const sysid = require('../tools/autotune/system_id.cjs');

function truth(rate = 125) {
    return { version: 1, kind: 'rotational-rotor-body', rate, output: 'gyroRAW', rpmExponent: 0,
        reference: { rpm: 3500, collective: 0.2, collectiveAbs: 0.2 },
        axes: [0, 1, 2].map(a => ({ frequencyHz: a === 2 ? 7 : 4, damping: 0.75, actuatorTauS: 0.008, delayS: 0.008,
            gain: [0, 1, 2].map(b => a === b ? 700 + 100 * a : 45 * (a - b)), collectiveGain: 0, collectiveAbsGain: 0, bias: 0 })) };
}
function data(count = 4, options = {}) {
    const m = options.model || truth(), rate = m.rate, n = rate * (options.seconds || 20), segments = [];
    for (let flight = 0; flight < count; flight++) {
        const u = [0, 1, 2].map(a => Float64Array.from({ length: n }, (_, i) => {
            const t = i / rate, p = 0.71 * flight;
            return 0.09 * Math.sin((a + 1) * 0.9 * t + p) + 0.05 * Math.sin((3 + a * 1.3) * t - p) +
                0.025 * Math.sin((17 + 3 * a) * t + p) + 0.025 * Math.sin(2 * Math.PI * t + 0.8 * a + p);
        }));
        const hs = new Float64Array(n).fill(3500), coll = new Float64Array(n).fill(0.2);
        const y = model.rollout(m, { n, rate, u, hs, coll, y: [new Float64Array(n), new Float64Array(n), new Float64Array(n)] });
        const w = { n, rate, fromS: 0, flight: { id: `flight-${flight}`, craft: 'SAB Fireball' }, u, sp: u.map(x => Float64Array.from(x, v => v * 500)), gyro: y, hs, coll,
            rescueAt: new Uint8Array(n), profileAt: new Uint8Array(n).fill(1), extra: { 'mixer[3]': coll.slice(), time: Float64Array.from({ length: n }, (_, i) => i / rate * 1e6) } };
        if (!options.filtered) for (let a = 0; a < 3; a++) w.extra[`gyroRAW[${a}]`] = y[a];
        segments.push({ w, mask: new Uint8Array(n).fill(1), configuration: 'A' });
    }
    return { segments, craft: 'SAB Fireball', options: { predictions: true, keepSegments: true,
        grid: { frequencyHz: [4, 7], damping: [0.35, 0.75], actuatorTauS: [0.008], delayS: [0.008, 0.02] } } };
}

test('free-running output-error fit recovers coupled model on independent reserved flights', () => {
    const result = sysid.fit(data());
    assert.equal(result.status, 'validated', JSON.stringify(result.reasons));
    assert.equal(result.controlEligible, true);
    assert.equal(result.validation.split.method, 'seeded-random-flights');
    assert.equal(result.model.fit.inertiaPriorUse, 'broad-torque-over-inertia-coefficient-regularization');
    assert.ok(result.validation.test.axes.every(a => a.normalizedRMSE < 0.035));
    assert.ok(Math.abs(result.model.axes[0].gain[1] + 45) < 6);
    assert.ok(Math.abs(result.model.axes[1].gain[0] - 45) < 6);
    const train = new Set(result.validation.split.train.map(s => s.flight));
    assert.ok(result.validation.split.test.every(s => !train.has(s.flight)));
    assert.equal(result.predictions[0].measured.length, 3);
    assert.equal(result.ensemble.length, 3);
});

test('rollout never uses measured outputs after initialization', () => {
    const prepared = sysid.prepareSegments(data()), s = prepared.segments[0], first = model.rollout(truth(), s);
    const replacement = Object.assign({}, s, { y: s.y.map(x => Float64Array.from(x, (v, i) => i ? v + 10000 : v)) });
    assert.deepEqual(model.rollout(truth(), replacement), first);
});

test('replay step is causal and model is reusable at the controller sample rate', () => {
    const m = truth(), higher = model.atRate(m, 1000);
    assert.equal(higher.identifiedSampleRate, 125);
    assert.equal(higher.rate, 1000);
    assert.equal(m.rate, 125);
    const decoded = model.deserialize(model.serialize(higher)), state = model.createState(decoded);
    for (let i = 0; i < 2000; i++) model.step(decoded, state, { u: [0.1, 0, 0], hs: 3500, coll: 0.2 });
    assert.ok(Math.abs(state.rate[0] - 70) < 1e-6);
    assert.ok(Math.abs(state.rate[1] - 4.5) < 1e-6);
    assert.throws(() => model.step(decoded, state, { u: [0, 0, 0], hs: 3500, coll: 0.2 }, 1 / 125), /sample rate/);
});

test('flight, rescue, saturation, sample clock, profiles and nonfinite boundaries cannot be crossed', () => {
    const input = data(1), item = input.segments[0], w = item.w;
    item.inputBounds = [[-0.98, 0.98], [-0.98, 0.98], [-0.98, 0.98]];
    item.mask[30] = 0; w.rescueAt[100] = 1; w.u[1][200] = 1; w.extra.time[300] += 100000;
    w.profileAt.fill(2, 400); w.u[0][500] = NaN;
    const result = sysid.prepareSegments(input), reasons = new Set(result.coverage.excluded.map(s => s.reason));
    for (const reason of ['outside-eligible-flight', 'rescue', 'mixer-limit', 'sample-clock-gap', 'profile-transition', 'nonfinite-input', 'boundary-settling']) assert.ok(reasons.has(reason), reason);
    assert.ok(result.segments.every(s => s.source.start > 500));
});

test('missing signals and flight masks refuse a plant fit', () => {
    const noMask = data(); delete noMask.segments[0].mask;
    assert.ok(sysid.prepareSegments(noMask).coverage.excluded.some(x => x.reason === 'missing-flight-mask'));
    const missing = data(); missing.segments.forEach(s => { s.w.coll = null; });
    assert.equal(sysid.fit(missing).status, 'rejected');
    assert.ok(sysid.prepareSegments(missing).coverage.excluded.every(x => x.reason === 'missing-input'));
});

test('cross-axis rank deficiency refuses independent-axis claims', () => {
    const input = data(); input.segments.forEach(s => { s.w.u[1] = s.w.u[0]; });
    const result = sysid.fit(input);
    assert.equal(result.status, 'rejected');
    assert.match(result.reasons.join(' '), /different axes/);
});

test('filtered gyro is an explicit identification-only output', () => {
    const result = sysid.fit(data(4, { filtered: true }));
    assert.equal(result.status, 'validated');
    assert.equal(result.model.output, 'gyroADC');
    assert.equal(result.controlEligible, false);
    assert.match(result.controlReasons.join(' '), /raw gyro/);
});

test('test-output corruption rejects model without changing fitted coefficients', () => {
    const normal = data(), corrupt = data(), initial = sysid.fit(normal);
    const testFlight = initial.validation.split.test[0].flight, target = corrupt.segments.find(s => s.w.flight.id === testFlight);
    for (const axis of target.w.gyro) for (let i = 20; i < axis.length; i++) axis[i] += 80;
    const result = sysid.fit(corrupt);
    assert.equal(result.status, 'rejected');
    assert.deepEqual(result.model.axes, initial.model.axes);
});

test('craft identity cannot be silently pooled and invalid artifacts are rejected', () => {
    const input = data(); input.segments[1].w.flight.craft = 'GAUI X4 II';
    assert.equal(sysid.fit(input).model, null);
    const m = truth(); m.axes[1].damping = -1;
    assert.throws(() => model.deserialize(m), /invalid/);
    assert.equal(model.craftPrior('SAB Fireball').inertia.identified, undefined);
    assert.equal(model.craftPrior('GAUI X4 II').identified, false);
});

test('the flight budget selects excited later intervals rather than the first hover', () => {
    const input = data(1, { seconds: 84 }), w = input.segments[0].w;
    for (const sp of w.sp) sp.fill(0, 0, 32 * w.rate);
    input.options.rules = { maxWindowsPerFlight: 1 };
    const result = sysid.prepareSegments(input);
    assert.equal(result.segments.length, 1);
    assert.ok(result.segments[0].fromS >= 32);
    assert.ok(result.coverage.excluded.some(x => x.reason === 'insufficient-pilot-excitation'));
});

test('independent feedback variation without pilot excitation does not identify a plant', () => {
    const input = data(); for (const item of input.segments) for (const sp of item.w.sp) sp.fill(0);
    const result = sysid.fit(input);
    assert.equal(result.status, 'rejected');
    assert.equal(result.model, null);
    assert.ok(result.coverage.excluded.every(x => ['boundary-settling', 'insufficient-pilot-excitation', 'short-interval'].includes(x.reason)));
});

test('cyclic rotor-state coupling creates cross-axis dynamics without cross-input gains', () => {
    const m = truth(); m.rotorCoupling = 20;
    m.axes.forEach((a, i) => { a.gain = [0, 1, 2].map(j => i === j ? 700 : 0); });
    const state = model.createState(m, [1, 0, 0]);
    for (let i = 0; i < 10; i++) model.step(m, state, { u: [0, 0, 0], hs: 3500, coll: 0.2 });
    assert.ok(Math.abs(state.rate[1]) > 0.01);
    for (let i = 0; i < 2000; i++) model.step(m, state, { u: [0, 0, 0], hs: 3500, coll: 0.2 });
    assert.ok(state.rate.every(x => Math.abs(x) < 1e-6));
});

test('coupled unit-response IV estimation recovers rotor cross-state dynamics', () => {
    const m = truth(); m.rotorCoupling = 20;
    const input = data(4, { model: m });
    input.options.grid = { frequencyHz: [4, 7], damping: [0.75], actuatorTauS: [0.008], delayS: [0.008] };
    input.options.rotorCouplingGrid = [-20, 20];
    const result = sysid.fit(input);
    assert.equal(result.model.rotorCoupling, 20);
    assert.ok(result.validation.test.controlledAxes.every(a => a.normalizedRMSE < 0.08));
});

test('frequency support is measured and is empty after a failed final test', () => {
    const input = data(), split = sysid.splitSegments(sysid.prepareSegments(input).segments, input.options);
    const target = input.segments.find(s => s.w.flight.id === split.test[0].flight);
    for (const axis of target.w.gyro) for (let i = 20; i < axis.length; i++) axis[i] += 100;
    const result = sysid.fit(input);
    assert.equal(result.model.validatedBandHz, null);
    assert.deepEqual(result.model.validatedFrequenciesHz, []);
    assert.ok(result.validation.frequency.axes.every(a => a.bins.every(b => Number.isFinite(b.pilotInputCoherence))));
});

test('seeded random flight holdout is reproducible, small and disjoint', () => {
    const prepared = sysid.prepareSegments(data(10)).segments;
    const a = sysid.splitSegments(prepared, { seed: 'seed-A' }), b = sysid.splitSegments(prepared, { seed: 'seed-A' });
    assert.deepEqual(a.assignment, b.assignment);
    assert.equal(a.actualTestFraction, 0.2);
    assert.equal(a.test.length, 2);
    assert.notDeepEqual(a.assignment, sysid.splitSegments(prepared, { seed: 'seed-B' }).assignment);
    const train = new Set(a.train.map(s => s.flight)), select = new Set(a.selection.map(s => s.flight));
    assert.ok(a.test.every(s => !train.has(s.flight) && !select.has(s.flight)));
});

test('small-data interval holdout has guards and lower confidence', () => {
    const input = data(1, { seconds: 84 }), prepared = sysid.prepareSegments(input).segments, split = sysid.splitSegments(prepared, { seed: 17 });
    assert.equal(split.independentFlights, false);
    assert.equal(split.method, 'seeded-random-guarded-intervals');
    assert.equal(split.embargoS, 1);
    for (const testSegment of split.test) for (const training of split.train) assert.ok(
        Math.abs(testSegment.fromS - training.fromS) >= testSegment.n / testSegment.rate + 2);
    const result = sysid.fit(input);
    assert.equal(result.controlEligible, false);
    assert.notEqual(result.confidence.level, 'high');
});

test('torque-rate yaw includes an exact integrator without artificial stiffness', () => {
    const m = truth(); Object.assign(m.axes[2], { type: 'torque-rate', decayRate: 0, gain: [0, 0, 100], actuatorTauS: 0, delayS: 0 });
    const state = model.createState(m);
    for (let i = 0; i < m.rate * 10; i++) model.step(m, state, { u: [0, 0, 0.2], hs: 3500, coll: 0.2 });
    assert.ok(Math.abs(state.rate[2] - 200) < 1e-8);
});

test('fixed analysis filter suppresses rotor vibration before fit decimation', () => {
    const rate = 1000, f = sysid.analysisFilter(rate, 20, [0]); let power = 0, count = 0;
    for (let i = 0; i < 5000; i++) { const y = f(0, Math.sin(2 * Math.PI * 75 * i / rate)); if (i > 1000) { power += y * y; count++; } }
    assert.ok(Math.sqrt(power / count / 0.5) < 0.006);
});

test('mixer magnitude one is not assumed to be a physical command limit', () => {
    const input = data(1), w = input.segments[0].w;
    w.u.forEach(axis => { for (let i = 0; i < axis.length; i++) axis[i] += 1.3; });
    const result = sysid.prepareSegments(input);
    assert.ok(result.segments.length > 0);
    assert.ok(result.coverage.excluded.every(x => x.reason !== 'mixer-limit'));
    assert.equal(result.segments[0].source.limitCoverage.physicalServoLimitsKnown, false);
});

test('duplicate flash captures do not change selected observations, fit or confidence', () => {
    const original = data();
    original.segments.forEach((item, i) => {
        item.w.flight.start = `2026-10-${String(i + 1).padStart(2, '0')}T12:00:00Z`;
        item.w.flight.id = `${item.w.flight.start}|0|20000000`;
    });
    const repeated = structuredClone(original), copies = structuredClone(original.segments);
    copies.forEach(item => { item.w.flight.file = 'another-flash-dump'; item.w.flight.id += '|copy'; });
    repeated.segments.push(...copies);
    const first = sysid.fit(original), second = sysid.fit(repeated);
    assert.equal(second.coverage.deduplication.duplicateWindows, 4);
    assert.equal(second.coverage.usedSamples, first.coverage.usedSamples);
    assert.deepEqual(second.model.axes, first.model.axes);
    assert.deepEqual(second.confidence, first.confidence);
    assert.deepEqual(second.validation.split.assignment, first.validation.split.assignment);
    assert.ok(second.coverage.excluded.filter(x => x.reason === 'duplicate-capture-window').every(x =>
        x.source.item >= 4 && x.retainedSource.item < 4));
});

test('partial captures use recorded start and sample times before flight split and budget', () => {
    const input = data(3, { seconds: 68 });
    input.segments.forEach((item, i) => {
        item.w.flight.start = `2026-10-${String(i + 1).padStart(2, '0')}T12:00:00Z`;
        item.w.flight.id = `${item.w.flight.start}|0|68000000`;
    });
    const copy = structuredClone(input.segments[0]), w = copy.w, start = 8 * w.rate, crop = x => x.slice(start);
    w.flight.id = `${w.flight.start}|8000000|68000000`; w.fromS = 8; w.n -= start;
    w.u = w.u.map(crop); w.sp = w.sp.map(crop); w.gyro = w.gyro.map(crop);
    for (const key of Object.keys(w.extra)) w.extra[key] = crop(w.extra[key]);
    for (const key of ['hs', 'coll', 'rescueAt', 'profileAt']) w[key] = crop(w[key]);
    copy.mask = crop(copy.mask); input.segments.push(copy);
    const result = sysid.prepareSegments(input), split = sysid.splitSegments(result.segments, { seed: 71 });
    assert.equal(new Set(result.segments.map(s => s.flight)).size, 3);
    assert.ok(result.coverage.deduplication.overlappingWindows >= 3);
    assert.ok(result.coverage.excluded.some(x => x.reason === 'overlapping-capture-window'));
    assert.equal(new Set(split.assignment.map(s => s.flight)).size, 3);
    for (const flight of new Set(split.assignment.map(s => s.flight)))
        assert.equal(new Set(split.assignment.filter(s => s.flight === flight).map(s => s.role)).size, 1);
});

test('conflicting copies fail identification and unresolved capture clocks exclude duplicates', () => {
    const input = data(3);
    input.segments[0].w.flight.start = '2026-10-01T12:00:00Z';
    const copy = structuredClone(input.segments[0]); copy.w.flight.id = 'another-capture';
    copy.w.extra['gyroRAW[0]'][200] += 1; input.segments.push(copy);
    assert.equal(sysid.fit(input).model, null);
    assert.ok(sysid.prepareSegments(input).coverage.excluded.some(x => x.reason === 'conflicting-capture-window'));
    delete copy.w.extra.time;
    const withoutClock = sysid.prepareSegments(input);
    assert.ok(withoutClock.coverage.excluded.some(x => x.reason === 'unresolved-capture-overlap'));
    assert.equal(withoutClock.segments.length, 3);
});

test('an unset year-zero controller clock cannot certify independent physical flights', () => {
    const input = data(3);
    input.segments.forEach((item, index) => {
        item.w.flight.start = '0000-01-01T00:00:00.000Z';
        item.w.flight.id = `${item.w.flight.start}|${index}|20000000`;
    });
    const prepared = sysid.prepareSegments(input);
    assert.ok(prepared.segments.length > 0);
    assert.ok(prepared.segments.every(s => s.source.flightIdentity.basis === 'unconfirmed-start-conservative-group'));
    assert.equal(new Set(prepared.segments.map(s => s.flight)).size, 1);
    assert.equal(sysid.splitSegments(prepared.segments).independentFlights, false);
    assert.ok(prepared.coverage.deduplication.limitations.some(s => s.includes('no recorded start time')));
});

test('collective plant input uses measured mixer output and keeps the pilot instrument', () => {
    const input = data();
    input.segments.forEach(item => item.w.extra['mixer[3]'].fill(-250));
    const prepared = sysid.prepareSegments(input);
    assert.ok(prepared.segments.every(s => s.collectiveField === 'mixer[3]' && s.coll[0] === -250 && s.pilotColl[0] === 0.2));
    const measured = sysid.fit(input);
    assert.equal(measured.model.collectiveField, 'mixer[3]');
    assert.equal(measured.model.units.collective, 'native-logged-mixer[3]-permille');
    assert.deepEqual(measured.model.envelope.collective, [-250, -250]);
    input.segments.forEach(item => { delete item.w.extra['mixer[3]']; });
    const fallback = sysid.fit(input);
    assert.equal(fallback.status, 'validated');
    assert.equal(fallback.model.collectiveField, 'setpoint[3]');
    assert.equal(fallback.model.units.collective, 'native-logged-setpoint[3]-permille');
    assert.equal(fallback.controlEligible, false);
    assert.match(fallback.controlReasons.join(' '), /measured collective mixer/);
});
