'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const T = require('../tools/autotune/heli_twin.cjs'), F = require('../tools/autotune/twin_fit.cjs');
const { craftPrior } = require('../tools/autotune/helicopter_model.cjs');
const sysid = require('../tools/autotune/system_id.cjs');
const X = require('./twin_fixture.cjs');

// Synthetic flights: the twin with its prior parameters (or the given parameters), flown by a rate controller with
// band-limited pilot inputs at 500 Hz (test/twin_fixture.cjs). Each test gets its own copy of the cached flights.
const flights = new Map();
function flight(seconds, seed, params) {
    const key = JSON.stringify([seconds, seed, params || null]);
    if (!flights.has(key)) flights.set(key, X.fly({ seconds, seed, model: params ? X.truthModel(params) : undefined }));
    return flights.get(key);
}
function data(count = 5, options = {}) {
    const segments = [];
    for (let k = 0; k < count; k++) {
        const f = flight(options.seconds || 40, k + 1, options.params), w = structuredClone(X.segment(f, { flight: `flight-${k}` }));
        w.flight.craft = 'SAB Fireball';
        if (options.raw) for (let a = 0; a < 3; a++) w.extra[`gyroRAW[${a}]`] = w.gyro[a].slice();
        segments.push({ w, mask: new Uint8Array(w.n).fill(1), configuration: 'A' });
    }
    // no fit stages: the twin is the prior model, which is the model of the synthetic flights
    return { segments, craft: 'SAB Fireball', options: { predictions: true, keepSegments: true, stages: options.stages || [], rules: { minFrequencyGroupS: 30 } } };
}

test('fit gives a validated six-degree-of-freedom twin with the contract fields', async () => {
    const input = data(), result = await sysid.fit(input);
    assert.equal(result.status, 'validated', JSON.stringify(result.reasons));
    assert.equal(result.version, 2); assert.equal(result.model.kind, T.KIND); assert.deepEqual(T.validateModel(result.model), []);
    assert.deepEqual(result.ensemble, [result.model]);
    assert.equal(result.validation.split.method, 'seeded-random-flights');
    const p = result.validation.prediction;
    assert.deepEqual(p.channels, T.OUTPUTS); assert.equal(p.rmse.length, 9); assert.equal(p.persistence.length, 9);
    assert.ok(p.origins > 0 && p.points.includes(0.1));
    assert.ok([0, 1, 2].every(a => p.rmse[a][p.points.indexOf(0.1)] < 0.2 * p.persistence[a][p.points.indexOf(0.1)]), JSON.stringify(p.rmse));
    assert.ok(result.validation.frequency.length >= 1 && result.validation.frequency[0].bins.length > 0);
    assert.equal(result.validation.assessment.status, 'validated');
    assert.deepEqual(result.eligibleSteps, ['cyclic', 'cycomp', 'tail', 'tailcomp']);
    assert.deepEqual(result.axes.map(a => [a.axis, a.pass, a.reasons.length]), [['roll', true, 0], ['pitch', true, 0], ['yaw', true, 0]]);
    assert.deepEqual(result.confidence.assessment.axes, result.axes);
    // frequency groups keep their key and give the PID profile number
    assert.ok(result.validation.frequency.every(g => g.key === 'profile 1' && g.profile === 1), JSON.stringify(result.validation.frequency.map(g => g.key)));
    assert.ok(result.validation.frequencyTrain.every(g => g.key === 'profile 1' && g.profile === 1));
    assert.ok(result.predictions.every(q => q.profile === 1));
    // the reserved-flight check uses the twin rules of the fit (the same origins as control_pipeline.replayTwin)
    assert.equal(result.model.fit.rules.originEveryS, sysid.RULES.twin.originEveryS);
    assert.equal(result.validation.prediction.origins, F.predictionErrors(result.model, result.segments.test.map(s => F.prepareRun(sysid.twinRun(input, s), result.model.fit.rules)), { rules: result.model.fit.rules }).origins);
    assert.equal(result.model.vbatRecorded, true); assert.deepEqual(result.limitations, []);
    assert.ok(result.validation.training.prediction.rmse.length === 9);
    assert.ok(Array.isArray(result.validation.history));
    assert.equal(result.confidence.level, 'moderate'); assert.equal(result.confidence.testGroups, 1);
    assert.equal(result.controlEligible, true); assert.deepEqual(result.controlReasons, []);
    assert.equal(result.model.validation.status, 'validated'); assert.equal(result.model.collectiveField, 'mixer[3]');
    // the predictions are the reserved test periods, at about 100 Hz, with the inputs of each period
    const test = new Set(result.validation.split.test.map(s => s.flight));
    assert.equal(result.predictions.length, result.validation.split.test.length);
    for (const q of result.predictions) {
        assert.ok(test.has(q.flight)); assert.ok(Number.isFinite(q.fromS)); assert.equal(q.measured.length, 9); assert.equal(q.predicted.length, 9);
        assert.ok(Math.abs(q.rate - 100) < 1); assert.equal(q.inputs.vbat.length, q.measured[0].length); assert.equal(q.inputs.sp.length, 3);
    }
    assert.ok(result.model.identity.trainingFlights.every(id => !test.has(id)));
    assert.ok(result.validation.split.test.every(s => !result.validation.split.train.some(t => t.flight === s.flight)));
});

test('a missing attitude or throttle field gives a reason and no fit', async () => {
    for (const [field, pattern] of [['attitude[1]', /attitude/], ['motor[0]', /throttle/]]) {
        const input = data(); input.segments.forEach(s => { delete s.w.extra[field]; });
        const result = await sysid.fit(input);
        assert.equal(result.status, 'rejected'); assert.equal(result.model, null); assert.equal(result.controlEligible, false);
        assert.ok(result.reasons.some(r => pattern.test(r)), JSON.stringify(result.reasons));
        assert.deepEqual(result.predictions, []);
    }
});

test('the observer gains come from heli_twin (no gain cache in system_id), and two fits give the same result', async () => {
    const m = X.truthModel(), dt = 1 / 497.4;
    assert.equal(sysid.cachedGains, undefined); assert.equal(sysid.withCachedGains, undefined);
    assert.equal(T.observerGains(m, dt), T.observerGains(JSON.parse(JSON.stringify(m)), dt), 'heli_twin keeps the gains of each model and interval');
    assert.equal(typeof T.createSim(m, 500).gains, 'undefined', 'createSim does not change');
    const input = data(1), runs = sysid.prepareSegments(input).segments.slice(0, 1).map(s => F.prepareRun(sysid.twinRun(input, s)));
    assert.deepEqual(F.predictionErrors(m, runs), F.predictionErrors(m, runs));
});

test('a log without the barometer (altitude, vario) fits: these fields are optional', async () => {
    for (const fields of [['altitude'], ['vario'], ['altitude', 'vario']]) {
        const input = data(); input.segments.forEach(s => fields.forEach(f => { delete s.w.extra[f]; }));
        const result = await sysid.fit(input);
        assert.equal(result.status, 'validated', `${fields}: ${JSON.stringify(result.reasons)}`);
        assert.ok(result.model); assert.equal(result.controlEligible, true);
        const p = result.validation.prediction;
        for (const [ch, name] of [[6, 'altitude'], [7, 'vario']]) if (fields.includes(name)) assert.ok(p.samples[ch].every(v => v === 0), name);
    }
});

test('a missing or zero battery voltage does not block the fit and gives the limitation', async () => {
    for (const change of [w => { delete w.extra.Vbat; }, w => { w.extra.Vbat.fill(0); }]) {
        const input = data(); input.segments.forEach(s => change(s.w));
        const result = await sysid.fit(input);
        assert.equal(result.status, 'validated', JSON.stringify(result.reasons));
        assert.ok(result.limitations.includes(sysid.VBAT_LIMITATION), JSON.stringify(result.limitations));
        assert.equal(sysid.VBAT_LIMITATION, 'The log does not record the battery voltage. The motor torque uses the throttle only.');
        assert.equal(result.model.vbatRecorded, false);
        assert.ok(sysid.REQUIRED.every(r => !r.fields.includes('Vbat')));
        assert.ok(result.predictions.every(q => q.inputs.vbat.every(v => v === 1)));
    }
    // one period without the voltage: all periods use the constant (one unit for the motor torque gain)
    const mixed = data(); mixed.segments[0].w.extra.Vbat.fill(0);
    const result = await sysid.fit(mixed);
    assert.equal(result.model.vbatRecorded, false); assert.ok(result.limitations.includes(sysid.VBAT_LIMITATION));
    assert.deepEqual(result.model.envelope.vbat, [1, 1]);
});

test('a frequency stage identifies a changed rotor moment, and the test flights do not change the fit', async () => {
    const params = { lb: 4500, mb: 2200 }, stages = [{ name: 'frequency', free: ['lb', 'mb'], frequencyOnly: true, frequencyWeight: 1, iterations: 20 }];
    const normal = data(5, { params, stages }), initial = await sysid.fit(normal);
    assert.ok(Math.abs(initial.model.params.lb / 4500 - 1) < 0.15, `lb ${initial.model.params.lb}`);
    assert.ok(Math.abs(initial.model.params.mb / 2200 - 1) < 0.15, `mb ${initial.model.params.mb}`);
    assert.equal(initial.validation.history[0].stage, 'frequency');
    const corrupt = data(5, { params, stages }), testFlight = initial.validation.split.test[0].flight;
    const target = corrupt.segments.find(s => s.w.flight.id === testFlight);
    for (const axis of target.w.gyro) for (let i = 20; i < axis.length; i++) axis[i] += 80 * Math.sin(i / 7);
    const result = await sysid.fit(corrupt);
    // per axis (twin_fit.assess): the roll and pitch checks fail, so no cyclic step is available
    assert.notEqual(result.status, 'validated');
    assert.ok(result.axes.filter(a => a.axis !== 'yaw').some(a => !a.pass), JSON.stringify(result.axes));
    assert.ok(result.axes.every(a => a.pass === (a.reasons.length === 0)), 'each axis that fails has its reasons, and only those');
    assert.ok(result.axes.flatMap(a => a.reasons).every(r => result.reasons.includes(r)));
    assert.ok(!result.eligibleSteps.includes('cyclic') && !result.eligibleSteps.includes('cycomp'));
    assert.notEqual(result.confidence.level, 'high');
    assert.deepEqual(result.model.params, initial.model.params);
    // a partial model gives its steps in eligibleSteps: the UI shows their titles, the reasons have no raw step keys
    if (result.status === 'rejected') assert.match(result.controlReasons.join(' '), /did not agree/);
    else assert.doesNotMatch(result.controlReasons.join(' '), /cyclic|cycomp|tail|only for these control steps/);
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

test('missing signals and flight masks refuse a plant fit', async () => {
    const noMask = data(); delete noMask.segments[0].mask;
    assert.ok(sysid.prepareSegments(noMask).coverage.excluded.some(x => x.reason === 'missing-flight-mask'));
    const missing = data(); missing.segments.forEach(s => { s.w.coll = null; });
    assert.equal((await sysid.fit(missing)).status, 'rejected');
    assert.ok(sysid.prepareSegments(missing).coverage.excluded.every(x => x.reason === 'missing-input'));
});

test('cross-axis rank deficiency refuses independent-axis claims', async () => {
    const input = data(); input.segments.forEach(s => { s.w.u[1] = s.w.u[0]; });
    const result = await sysid.fit(input);
    assert.equal(result.status, 'rejected');
    assert.match(result.reasons.join(' '), /different axes/);
});

test('the twin uses the filtered gyro: the raw gyro does not change the fit or the reserved-flight check', async () => {
    const plain = await sysid.fit(data()), raw = data(5, { raw: true });
    raw.segments.forEach(s => { for (let a = 0; a < 3; a++) s.w.extra[`gyroRAW[${a}]`] = s.w.extra[`gyroRAW[${a}]`].map(v => 2 * v + 5); });
    const result = await sysid.fit(raw);
    assert.equal(plain.status, 'validated'); assert.equal(result.status, 'validated');
    assert.equal(result.model.output, 'gyroADC'); assert.equal(result.controlEligible, true);
    assert.deepEqual(result.model.params, plain.model.params); assert.deepEqual(result.validation.prediction, plain.validation.prediction);
});

test('craft identity cannot be silently pooled and invalid artifacts are rejected', async () => {
    const input = data(); input.segments[1].w.flight.craft = 'GAUI X4 II';
    assert.equal((await sysid.fit(input)).model, null);
    const m = X.truthModel(); m.params.lb = -1;
    assert.throws(() => T.deserialize(m), /out of range/);
    assert.equal(craftPrior('SAB Fireball').inertia.identified, undefined);
    assert.equal(craftPrior('GAUI X4 II').identified, false);
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

test('independent feedback variation without pilot excitation does not identify a plant', async () => {
    const input = data(); for (const item of input.segments) for (const sp of item.w.sp) sp.fill(0);
    const result = await sysid.fit(input);
    assert.equal(result.status, 'rejected');
    assert.equal(result.model, null);
    assert.ok(result.coverage.excluded.every(x => ['boundary-settling', 'insufficient-pilot-excitation', 'short-interval'].includes(x.reason)));
});

test('seeded random flight holdout is reproducible, small and disjoint', () => {
    const prepared = sysid.prepareSegments(data(10, { seconds: 20 })).segments;
    const a = sysid.splitSegments(prepared, { seed: 'seed-A' }), b = sysid.splitSegments(prepared, { seed: 'seed-A' });
    assert.deepEqual(a.assignment, b.assignment);
    assert.equal(a.actualTestFraction, 0.2);
    assert.equal(a.test.length, 2);
    assert.notDeepEqual(a.assignment, sysid.splitSegments(prepared, { seed: 'seed-B' }).assignment);
    const train = new Set(a.train.map(s => s.flight)), select = new Set(a.selection.map(s => s.flight));
    assert.ok(a.test.every(s => !train.has(s.flight) && !select.has(s.flight)));
});

test('small-data interval holdout has guards and lower confidence', async () => {
    const input = data(1, { seconds: 84 }), prepared = sysid.prepareSegments(input).segments, split = sysid.splitSegments(prepared, { seed: 17 });
    assert.equal(split.independentFlights, false);
    assert.equal(split.method, 'seeded-random-guarded-intervals');
    assert.equal(split.embargoS, 1);
    for (const testSegment of split.test) for (const training of split.train) assert.ok(
        Math.abs(testSegment.fromS - training.fromS) >= testSegment.n / testSegment.rate + 2);
    const result = await sysid.fit(input);
    assert.equal(result.controlEligible, false);
    assert.notEqual(result.confidence.level, 'high');
    assert.match(result.controlReasons.join(' '), /Three different flight logs/);
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

test('duplicate flash captures do not change selected observations, fit or confidence', async () => {
    const original = data();
    original.segments.forEach((item, i) => {
        item.w.flight.start = `2026-10-${String(i + 1).padStart(2, '0')}T12:00:00Z`;
        item.w.flight.id = `${item.w.flight.start}|0|20000000`;
    });
    const repeated = structuredClone(original), copies = structuredClone(original.segments);
    copies.forEach(item => { item.w.flight.file = 'another-flash-dump'; item.w.flight.id += '|copy'; });
    repeated.segments.push(...copies);
    const first = await sysid.fit(original), second = await sysid.fit(repeated), count = original.segments.length;
    assert.equal(second.coverage.deduplication.duplicateWindows, first.coverage.intervals.length);
    assert.equal(second.coverage.usedSamples, first.coverage.usedSamples);
    assert.deepEqual(second.model.params, first.model.params);
    assert.deepEqual(second.predictions, first.predictions);
    assert.deepEqual(second.confidence, first.confidence);
    assert.deepEqual(second.validation.split.assignment, first.validation.split.assignment);
    assert.ok(second.coverage.excluded.filter(x => x.reason === 'duplicate-capture-window').every(x =>
        x.source.item >= count && x.retainedSource.item < count));
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

test('conflicting copies fail identification and unresolved capture clocks exclude duplicates', async () => {
    const input = data(3, { seconds: 20, raw: true });
    input.segments[0].w.flight.start = '2026-10-01T12:00:00Z';
    const copy = structuredClone(input.segments[0]); copy.w.flight.id = 'another-capture';
    copy.w.gyro[0][1000] += 1; input.segments.push(copy);
    assert.equal((await sysid.fit(input)).model, null);
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

function verifiedSource(input, sha256 = 'a'.repeat(64), logOffset = 0) {
    const file = { fileName: 'source.bbl', sha256, verifiedBytes: true, logOffset, logs: input.segments.length };
    input.segments.forEach((item, localLogIndex) => {
        item.source = { file, localLogIndex, logIndex: logOffset + localLogIndex };
        item.w.flight.log = item.source.logIndex;
    });
    return file;
}

test('verified source captures remain distinct when the FBL calendar repeats or changes', () => {
    const input = data(3, { seconds: 20 }), file = verifiedSource(input, 'a'.repeat(64), 10);
    input.segments.forEach(item => { item.w.flight.start = '2026-10-05T00:00:00Z'; item.w.flight.id = 'same-wrong-date|0|20000000'; });
    const before = sysid.prepareSegments(input), assignment = sysid.splitSegments(before.segments, { seed: 71 }).assignment;
    assert.equal(before.segments.length, 3); assert.deepEqual(before.reasons, []);
    assert.deepEqual(before.segments.map(s => s.flight), [0, 1, 2].map(i => `source:${file.sha256}:log:${i}`));
    const split = sysid.splitSegments(before.segments, { seed: 71 });
    assert.equal(split.method, 'seeded-random-source-captures'); assert.equal(split.groupingBasis, 'source-capture-groups');
    assert.equal(split.physicalFlightIndependenceProven, false);
    assert.ok(before.segments.every(s => s.source.flightIdentity.calendarTrusted === false && s.source.flightIdentity.evidence === 'capture-group-only'));
    assert.ok(before.coverage.deduplication.limitations.some(s => /do not show/.test(s)));
    input.segments.forEach((item, i) => { item.w.flight.start = i ? '0000-01-01T00:00:00Z' : '2030-01-01T00:00:00Z'; item.w.flight.id += `|${i}`; });
    const after = sysid.prepareSegments(input);
    assert.deepEqual(after.segments.map(s => s.flight), before.segments.map(s => s.flight));
    assert.deepEqual(sysid.splitSegments(after.segments, { seed: 71 }).assignment, assignment, 'dates cannot change the source-based partition');
});

test('source capture confidence describes log groups without claiming separate armed flights', async () => {
    const input = data(4); verifiedSource(input);
    const result = await sysid.fit(input);
    assert.equal(result.validation.split.groupingBasis, 'source-capture-groups');
    assert.equal(result.confidence.groupingBasis, 'source-capture-groups');
    assert.equal(result.confidence.physicalFlightIndependenceProven, false);
    assert.ok(result.confidence.reasons.some(s => /source log groups/.test(s)));
    assert.ok(result.confidence.reasons.every(s => !/different test flights/.test(s)));
});

test('date-only copies of one verified capture cannot create independent groups', () => {
    const input = data(1, { seconds: 20 }); verifiedSource(input);
    input.segments = [input.segments[0], structuredClone(input.segments[0]), structuredClone(input.segments[0])];
    input.segments.forEach((item, i) => { item.w.flight.start = `2026-10-0${i + 1}T00:00:00Z`; item.w.flight.id += `|${i}`; });
    const prepared = sysid.prepareSegments(input);
    assert.equal(prepared.segments.length, 1); assert.equal(prepared.coverage.deduplication.duplicateWindows, 2);
    assert.equal(sysid.splitSegments(prepared.segments).independentFlights, false);
});

test('contradictory verified source indexes reject identification', async () => {
    const changes = [item => { item.source.localLogIndex = 1; }, item => { item.source.logIndex = 1; },
        item => { item.w.flight.log = 1; }, item => { item.w.recordedConfiguration = { interval: { log: 1 } }; },
        item => { item.source.localLogIndex = -1; }, item => { item.source.file.sha256 = 'invalid'; }];
    for (const change of changes) {
        const input = data(1); verifiedSource(input); change(input.segments[0]);
        const result = await sysid.fit(input);
        assert.equal(result.model, null); assert.equal(result.controlEligible, false);
        assert.ok(result.reasons.some(s => /source file information/.test(s)));
        assert.ok(result.coverage.excluded.some(s => s.reason === 'source-capture-identity-conflict'));
    }
});

test('unresolved source files preserve duplicate protection and cannot create a holdout', async () => {
    const input = data(3, { seconds: 20 }); verifiedSource(input);
    input.segments.forEach((item, i) => { item.w.flight.start = `2026-10-0${i + 1}T00:00:00Z`; item.w.flight.id = `${item.w.flight.start}|0|20000000`; });
    const copies = structuredClone(input.segments), copyInput = { segments: copies }; verifiedSource(copyInput, 'b'.repeat(64), 3);
    input.segments.push(...copies);
    const result = await sysid.fit(input);
    assert.equal(result.coverage.deduplication.duplicateWindows, 3);
    assert.equal(result.coverage.deduplication.sourceGroupingUnresolved, true);
    assert.equal(result.validation.split.method, 'unresolved-source-grouping-no-holdout');
    assert.equal(result.validation.split.independentFlights, false); assert.equal(result.model, null);
    assert.equal(result.validation.split.selection.length, 0); assert.equal(result.validation.split.test.length, 0);
    assert.ok(result.validation.split.assignment.every(s => s.role === 'train'));
    copies.forEach((item, i) => { item.w.flight.start = `2030-10-0${i + 1}T00:00:00Z`; });
    const changedDates = await sysid.fit(input);
    assert.equal(changedDates.model, null); assert.equal(changedDates.validation.split.test.length, 0, 'unresolved copies cannot gain a holdout by changing calendar dates');
});

test('partial copies across unresolved source files retain overlap checks', () => {
    const input = data(1, { seconds: 68 }); verifiedSource(input);
    const first = input.segments[0]; first.w.flight.start = '2026-10-01T00:00:00Z';
    const copy = structuredClone(first), w = copy.w, start = 8 * w.rate, crop = x => x.slice(start);
    w.fromS = 8; w.n -= start; w.u = w.u.map(crop); w.sp = w.sp.map(crop); w.gyro = w.gyro.map(crop);
    for (const key of Object.keys(w.extra)) w.extra[key] = crop(w.extra[key]);
    for (const key of ['hs', 'coll', 'rescueAt', 'profileAt']) w[key] = crop(w[key]); copy.mask = crop(copy.mask);
    verifiedSource({ segments: [copy] }, 'b'.repeat(64), 1); input.segments.push(copy);
    const result = sysid.prepareSegments(input);
    assert.ok(result.coverage.excluded.some(s => s.reason === 'overlapping-capture-window'));
    assert.ok(result.segments.every(s => s.source.item === 0));
    assert.equal(sysid.splitSegments(result.segments).test.length, 0);
});

test('mixed legacy and verified copies cannot restore a holdout after deduplication', async () => {
    const input = data(3, { seconds: 20 });
    input.segments.forEach((item, i) => { item.w.flight.start = `2026-10-0${i + 1}T00:00:00Z`; });
    const copies = structuredClone(input.segments); verifiedSource({ segments: copies }); input.segments.push(...copies);
    const result = await sysid.fit(input);
    assert.equal(result.coverage.deduplication.duplicateWindows, 3);
    assert.ok(result.coverage.intervals.every(s => s.source.item < 3), 'the legacy copies were retained first');
    assert.equal(result.validation.split.method, 'unresolved-source-grouping-no-holdout');
    assert.equal(result.validation.split.independentFlights, false); assert.equal(result.validation.split.test.length, 0);
});

test('collective plant input uses measured mixer output and keeps the pilot instrument', async () => {
    const input = data();
    input.segments.forEach(item => item.w.extra['mixer[3]'].fill(-250));
    const prepared = sysid.prepareSegments(input), first = prepared.segments[0];
    assert.ok(prepared.segments.every(s => s.collectiveField === 'mixer[3]' && s.coll[0] === -250));
    assert.equal(first.pilotColl[0], input.segments[first.source.item].w.coll[first.source.start]);
    const measured = await sysid.fit(input);
    assert.equal(measured.model.collectiveField, 'mixer[3]');
    assert.ok(measured.model.envelope.collective.every(v => Math.abs(v + 0.25) < 1e-12), JSON.stringify(measured.model.envelope.collective));
    input.segments.forEach(item => { delete item.w.extra['mixer[3]']; });
    // the fixture controller passes the pilot collective to the mixer, so the pilot collective is the same input here
    const fallback = await sysid.fit(input);
    assert.equal(fallback.status, 'validated', JSON.stringify(fallback.reasons));
    assert.equal(fallback.model.collectiveField, 'setpoint[3]');
    assert.equal(fallback.controlEligible, false);
    assert.match(fallback.controlReasons.join(' '), /measured collective mixer/);
});

test('the assessment reasons follow twin_fit.assess: per axis, and a check with gating false is not a reason', () => {
    const points = F.RULES.points, np = points.length, row = v => new Array(np).fill(v);
    const prediction = { points, rmse: Array.from({ length: 9 }, () => row(1)), persistence: Array.from({ length: 9 }, () => row(2)) };
    const good = { f: 2, measured: [[[1, 0], [0, 0], [0, 0]], [[0, 0], [1, 0], [0, 0]], [[0, 0], [0, 0], [1, 0]]], cohU: [0.9, 0.9, 0.9], cohY: [0.9, 0.9, 0.9], averages: 4 };
    good.model = good.measured;
    const validation = { prediction, frequency: [{ key: 'profile 1', bins: [1, 2, 3].map(f => Object.assign({}, good, { f })) }] };
    // the yaw rate prediction is worse than the hold of the last value: shown (gating false), not a reason
    prediction.rmse[2] = row(3);
    let a = F.assess(validation);
    assert.equal(a.status, 'validated'); assert.equal(a.prediction[2].gating, false);
    assert.deepEqual(sysid.assessmentReasons(a, prediction), []);
    // a roll attitude error: roll fails, so the cyclic steps are not available; the reasons name roll only
    prediction.rmse[3] = row(5);
    a = F.assess(validation);
    assert.equal(a.status, 'partial'); assert.deepEqual(a.eligibleSteps, ['tail', 'tailcomp']);
    const reasons = sysid.assessmentReasons(a, prediction);
    assert.deepEqual(reasons.map(r => r.axis), ['roll']); assert.match(reasons[0].text, /^Roll: the model attitude error/);
});

test('data selection uses the fitted signal (gyroADC), not the raw gyro', () => {
    const input = data(1, { raw: true }), w = input.segments[0].w;
    for (let a = 0; a < 3; a++) { w.extra[`gyroRAW[${a}]`].fill(NaN); }
    const noRaw = sysid.prepareSegments(input);
    assert.ok(noRaw.segments.length > 0); assert.ok(noRaw.segments.every(s => s.output === 'gyroADC'));
    assert.ok(noRaw.coverage.excluded.every(x => x.reason !== 'nonfinite-input'));
    const bad = data(1, { raw: true }); bad.segments[0].w.gyro[1][600] = NaN;
    assert.ok(sysid.prepareSegments(bad).coverage.excluded.some(x => x.reason === 'nonfinite-input'), 'a nonfinite gyroADC sample stops a period');
    // no rate excitation in gyroADC: the raw gyro cannot qualify the period
    const flat = data(1, { raw: true }); flat.segments[0].w.gyro.forEach(c => c.fill(0));
    const flatResult = sysid.prepareSegments(flat);
    assert.equal(flatResult.segments.length, 0); assert.ok(flatResult.coverage.excluded.some(x => x.reason === 'insufficient-rate-excitation'));
});

test('the selected periods must have one gyro filter configuration', () => {
    const input = data(2);
    input.segments.forEach((s, k) => { s.w.flight.header = { gyro_lowpass_hz: 100, gyro_soft_type: 1, looptime: 2000 }; s.configuration = k ? 'B' : 'A'; });
    assert.deepEqual(sysid.prepareSegments(input).reasons, [], 'two configurations with the same gyro filter');
    input.segments[1].w.flight.header.gyro_lowpass_hz = 150;
    assert.ok(sysid.prepareSegments(input).reasons.some(r => /different gyro filter values/.test(r)));
});

test('the iteration limits cover each stage of twin_fit.STAGES', () => {
    for (const st of F.STAGES) assert.ok(Number.isInteger(sysid.RULES.stageIterations[st.name]) && sysid.RULES.stageIterations[st.name] > 0, st.name);
    assert.ok(Number.isInteger(sysid.RULES.stageIterations.default));
    // the in-app budget (about 95 s for the 9 Fireball logs in one thread: the stages stop at their convergence)
    assert.equal(sysid.RULES.stageIterations.frequency, 60);
    assert.ok(sysid.RULES.stageIterations['short-horizon joint'] >= 12); assert.ok(sysid.RULES.stageIterations['yaw trim'] >= 15);
});

test('retest gives the checks of the fit for the same model, and new checks with the same split for a changed model', async () => {
    const input = data(), fitted = await sysid.fit(input), saved = JSON.stringify(fitted.validation.prediction);
    assert.ok(Array.isArray(fitted.frdTrain) && fitted.frdTrain.length > 0, 'the fit keeps the instrumented responses of its fit data');
    const same = sysid.retest(input, fitted, fitted.model);
    assert.equal(same.status, fitted.status); assert.deepEqual(same.eligibleSteps, fitted.eligibleSteps);
    assert.deepEqual(same.validation.prediction, fitted.validation.prediction); assert.deepEqual(same.reasons, fitted.reasons);
    assert.deepEqual(same.limitations, fitted.limitations); assert.equal(same.predictions.length, fitted.predictions.length);
    const changed = JSON.parse(JSON.stringify(fitted.model)); changed.params.lb *= 0.4; changed.params.mb *= 0.4;
    const other = sysid.retest(input, fitted, changed);
    assert.deepEqual(other.validation.split, fitted.validation.split, 'the same reserved test flights');
    assert.notDeepEqual(other.validation.prediction.rmse, fitted.validation.prediction.rmse);
    assert.equal(other.model, changed); assert.deepEqual(other.ensemble, [changed]);
    assert.equal(JSON.stringify(fitted.validation.prediction), saved, 'retest does not change the fit result');
    assert.notEqual(other.status, 'validated', JSON.stringify(other.axes));
});
