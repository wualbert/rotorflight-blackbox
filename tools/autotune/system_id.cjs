'use strict';

const plant = require('./helicopter_model.cjs');
const AXES = plant.AXES;
const FEATURE_COUNT = plant.FEATURE_COUNT;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const RULES = Object.freeze({ minWindowS: 8, windowS: 16, settlingS: 1, warmupS: 1,
    minInputStd: 0.004, minOutputStd: 3, minPilotStd: 5, minInstrumentPredictability: 0.05, maxInputCondition: 1000,
    maxNormalizedRMSE: 0.35, maxBiasDegS: 3, maxResidualInputCorrelation: 0.7,
    maxResidualAutocorrelation: 0.98, residualCorrelationFloorDegS: 0.5, maxSampleJitter: 0.15,
    minIndependentFlights: 3, maxWindowsPerFlight: 4, fitSampleHz: 125, controlBandHz: 20,
    minSpectralBlocks: 3, minPilotInputCoherence: 0.2, minPilotOutputCoherence: 0.6,
    maxSpectralRelativeUncertainty: 0.5, maxSpectralPredictionError: 0.35,
    source: 'Model check limits. These limits do not show that flight is safe.' });
const EXTRA = ['gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]', 'mixer[3]', 'time'];
const mean = x => x.reduce((a, b) => a + b, 0) / x.length;
function stats(x) { const m = mean(x); return { mean: m, std: Math.sqrt(mean(x.map(v => (v - m) ** 2))), min: Math.min(...x), max: Math.max(...x) }; }
function sampledStats(x) { const samples = []; for (let i = 0; i < x.length; i += Math.max(1, Math.floor(x.length / 2000))) samples.push(x[i]); return stats(samples); }
function slice(x, start, end) { return x.subarray ? x.subarray(start, end) : x.slice(start, end); }
function captureId(w, index) { return String(w.flight && (w.flight.id || `${w.flight.file || ''}:${w.flight.log}`) || `flight-${index}`); }
function flightIdentity(w, index) {
    const flight = w.flight || {}, capture = captureId(w, index), recordedStart = flight.start || capture.split('|')[0];
    // An unset flight-controller clock is logged as year zero. Date.parse
    // accepts it, but it is not evidence of a physical flight's identity.
    const start = typeof recordedStart === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}T/.test(recordedStart) ? Date.parse(recordedStart) : NaN;
    if (finite(start)) return { id: `flight:${new Date(start).toISOString()}:${String(flight.craft || '').trim().toLowerCase()}`,
        basis: 'recorded-start-and-craft', capture };
    if (capture.includes('|')) return { id: `unconfirmed-flight:${String(flight.craft || '').trim().toLowerCase()}`,
        basis: 'unconfirmed-start-conservative-group', capture };
    return { id: capture, basis: 'capture-id-without-confirmed-start', capture };
}
function flightId(w, index) { return flightIdentity(w, index).id; }
function itemConfiguration(item) { return item.configuration || item.dataset || item.ctx && item.ctx.configuration || null; }

function sameObservation(a, b) {
    if (a.n !== b.n || a.output !== b.output) return false;
    const first = a.u.concat(a.y, a.sp, [a.hs, a.coll, a.pilotColl]), second = b.u.concat(b.y, b.sp, [b.hs, b.coll, b.pilotColl]);
    for (let column = 0; column < first.length; column++) for (let i = 0; i < a.n; i++) if (first[column][i] !== second[column][i]) return false;
    return true;
}

function deduplicateWindows(segments) {
    const kept = [], excluded = [], limitations = [], byFlight = new Map();
    for (const s of segments) {
        const identity = s.source.flightIdentity, previous = byFlight.get(s.flight) || [];
        let duplicate = null, reason = null;
        for (const p of previous) {
            const clocksKnown = s.source.clockBasis === 'logged-time' && p.source.clockBasis === 'logged-time';
            const sameCapture = identity.capture === p.source.flightIdentity.capture;
            if (!clocksKnown && !sameCapture) {
                // Relative capture time cannot align two partial captures.
                // Retain one capture of this physical flight conservatively.
                reason = 'unresolved-capture-overlap'; duplicate = p; break;
            }
            const start = clocksKnown ? s.source.clockStartUs : s.fromS * 1e6,
                end = clocksKnown ? s.source.clockLastUs : (s.fromS + (s.n - 1) / s.rate) * 1e6,
                priorStart = clocksKnown ? p.source.clockStartUs : p.fromS * 1e6,
                priorEnd = clocksKnown ? p.source.clockLastUs : (p.fromS + (p.n - 1) / p.rate) * 1e6;
            if (end < priorStart || start > priorEnd) continue;
            duplicate = p;
            if (start === priorStart && end === priorEnd) reason = sameObservation(s, p) ? 'duplicate-capture-window' : 'conflicting-capture-window';
            else reason = 'overlapping-capture-window';
            break;
        }
        if (reason) {
            excluded.push({ flight: s.flight, configuration: s.configuration, fromS: s.fromS, toS: s.fromS + s.n / s.rate,
                samples: s.n, reason, source: s.source, retainedSource: duplicate.source });
            continue;
        }
        kept.push(s); previous.push(s); byFlight.set(s.flight, previous);
    }
    if (segments.some(s => s.source.flightIdentity.basis !== 'recorded-start-and-craft'))
        limitations.push('Some logs have no recorded start time. These logs cannot show which samples came from the same flight.');
    if (excluded.some(s => s.reason === 'unresolved-capture-overlap'))
        limitations.push('Some logs have no sample times. The app keeps one log for each flight.');
    if (excluded.some(s => s.reason === 'overlapping-capture-window'))
        limitations.push('Some logs contain the same flight periods. The app keeps the first period and removes periods that include those sample times.');
    if (excluded.some(s => s.reason === 'conflicting-capture-window'))
        limitations.push('Some copies of a flight period have different data. The app keeps the first copy.');
    return { segments: kept, excluded, limitations, duplicates: excluded.filter(s => s.reason === 'duplicate-capture-window').length,
        overlaps: excluded.filter(s => s.reason !== 'duplicate-capture-window').length };
}

function prepareSegments(input = {}) {
    const options = input.options || {}, rules = Object.assign({}, RULES, options.rules), items = input.segments || [];
    const segments = [], excluded = [], reasons = [], count = new Map(); let inputSamples = 0;
    const addExcluded = (w, index, start, end, reason) => {
        const rate = items[index].ctx && items[index].ctx.rate || w.flight && w.flight.actualRate || w.rate;
        excluded.push({ flight: flightId(w, index), configuration: itemConfiguration(items[index]),
            fromS: (w.fromS || 0) + start / rate, toS: (w.fromS || 0) + end / rate, samples: end - start, reason });
    };
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        const item = items[itemIndex], w = item.w || item, ctx = item.ctx || {}, n = w.n || 0,
            rate = ctx.rate || w.flight && w.flight.actualRate || w.rate;
        inputSamples += n;
        if (!finite(rate) || rate < 25 || rate > 32000 || n < 2) { reasons.push('The log sample rate is not correct.'); continue; }
        const raw = [0, 1, 2].map(a => w.extra && w.extra[`gyroRAW[${a}]`]);
        const output = raw.every(x => x && x.length === n) ? 'gyroRAW' : 'gyroADC', y = output === 'gyroRAW' ? raw : w.gyro;
        const actualCollective = w.extra && w.extra['mixer[3]'], collectiveField = actualCollective && actualCollective.length === n ? 'mixer[3]' : 'setpoint[3]';
        const collective = collectiveField === 'mixer[3]' ? actualCollective : w.coll;
        if (!w.u || w.u.length !== 3 || !w.u.every(x => x && x.length === n) || !y || !y.every(x => x && x.length === n) ||
            !w.sp || w.sp.length !== 3 || !w.sp.every(x => x && x.length === n) || !w.hs || w.hs.length !== n || !collective || collective.length !== n || !w.coll || w.coll.length !== n) {
            addExcluded(w, itemIndex, 0, n, 'missing-input'); continue;
        }
        const mask = item.mask || ctx.eligible || ctx.flying;
        if (!mask || mask.length !== n) { addExcluded(w, itemIndex, 0, n, 'missing-flight-mask'); continue; }
        const normal = item.normal || ctx.normal, timestamps = w.extra && w.extra.time, reasonAt = new Array(n);
        for (let i = 0; i < n; i++) {
            let reason = !mask[i] ? 'outside-eligible-flight' : normal && !normal[i] ? 'abnormal-mode' :
                w.rescueAt && w.rescueAt[i] ? 'rescue' : null;
            if (!reason && (!finite(w.hs[i]) || w.hs[i] <= 0 || !finite(w.coll[i]) || !finite(collective[i]) || !w.u.every(x => finite(x[i])) || !w.sp.every(x => finite(x[i])) || !y.every(x => finite(x[i])))) reason = 'nonfinite-input';
            if (!reason && item.inputBounds && w.u.some((x, a) => {
                const bounds = item.inputBounds[a];
                return bounds && bounds.length === 2 && bounds.every(finite) && (x[i] <= bounds[0] || x[i] >= bounds[1]);
            })) reason = 'mixer-limit';
            if (!reason && item.saturation && item.saturation[i]) reason = 'control-limit';
            if (!reason && timestamps && (!finite(timestamps[i]) || i > 0 && (timestamps[i] <= timestamps[i - 1] ||
                Math.abs((timestamps[i] - timestamps[i - 1]) * rate / 1e6 - 1) > rules.maxSampleJitter))) reason = 'sample-clock-gap';
            if (!reason && i > 0 && w.profileAt && w.profileAt[i] !== w.profileAt[i - 1]) reason = 'profile-transition';
            if (!reason && i > 0 && item.configurationAt && item.configurationAt[i] !== item.configurationAt[i - 1]) reason = 'configuration-transition';
            reasonAt[i] = reason;
        }
        let at = 0;
        while (at < n) {
            const start = at, reason = reasonAt[at]; while (at < n && reasonAt[at] === reason) at++;
            if (reason) { addExcluded(w, itemIndex, start, at, reason); continue; }
            const warm = Math.min(at, start + Math.ceil(rules.settlingS * rate));
            if (warm > start) addExcluded(w, itemIndex, start, warm, 'boundary-settling');
            const window = Math.floor(rules.windowS * rate);
            for (let begin = warm; begin < at; begin += window) {
                const end = Math.min(at, begin + window), id = flightId(w, itemIndex), previous = count.get(id) || 0;
                if (end - begin < rules.minWindowS * rate) { addExcluded(w, itemIndex, begin, end, 'short-interval'); continue; }
                const cut = x => slice(x, begin, end), inputStd = w.u.map(x => sampledStats(cut(x)).std);
                if (inputStd.every(x => x < rules.minInputStd)) { addExcluded(w, itemIndex, begin, end, 'insufficient-axis-excitation'); continue; }
                const pilotStd = w.sp.map(x => sampledStats(cut(x)).std);
                if (pilotStd.every(x => x < rules.minPilotStd)) { addExcluded(w, itemIndex, begin, end, 'insufficient-pilot-excitation'); continue; }
                const identity = flightIdentity(w, itemIndex), clockKnown = timestamps && finite(timestamps[begin]) && finite(timestamps[end - 1]);
                const part = { id: `${id}:${itemConfiguration(item) || ''}:${clockKnown ? timestamps[begin] : (w.fromS || 0) + begin / rate}`, flight: id,
                    craft: w.flight && w.flight.craft || '', fromS: (w.fromS || 0) + begin / rate, rate, n: end - begin,
                    configuration: itemConfiguration(item), profile: w.profileAt ? w.profileAt[begin] : w.profile || null, collectiveField,
                    recordedGains: item.gainEvidence || null,
                    source: { item: itemIndex, start: begin, end, flightIdentity: identity,
                        clockBasis: clockKnown ? 'logged-time' : 'capture-relative', clockStartUs: clockKnown ? timestamps[begin] : null,
                        clockLastUs: clockKnown ? timestamps[end - 1] : null, limitCoverage: item.limitCoverage || {
                        suppliedSaturationMask: !!item.saturation, suppliedInputBounds: !!item.inputBounds, physicalServoLimitsKnown: false } }, output, u: w.u.map(cut), y: y.map(cut),
                    hs: cut(w.hs), coll: cut(collective), pilotColl: cut(w.coll), sp: w.sp.map(cut), inputStd, pilotStd };
                if (y.every(x => sampledStats(cut(x)).std < rules.minOutputStd)) { addExcluded(w, itemIndex, begin, end, 'insufficient-rate-excitation'); continue; }
                segments.push(part); count.set(id, previous + 1);
            }
        }
    }
    const deduplicated = deduplicateWindows(segments);
    segments.splice(0, segments.length, ...deduplicated.segments);
    excluded.push(...deduplicated.excluded);
    if (deduplicated.excluded.some(s => s.reason === 'conflicting-capture-window')) reasons.push('Copies of the same flight samples have different data.');
    // Scan the complete flight before allocating the fitting budget. A
    // setpoint-only greedy score favours excitation of axes not yet covered.
    // It never sees gyro fitting errors or held-out model performance.
    const selected = new Set();
    for (const flight of new Set(segments.map(s => s.flight))) {
        const candidates = segments.filter(s => s.flight === flight), energy = [1, 1, 1];
        for (let k = 0; k < Math.min(rules.maxWindowsPerFlight, candidates.length); k++) {
            let best = null, score = -Infinity;
            for (const s of candidates) if (!selected.has(s)) {
                const value = s.pilotStd.reduce((sum, v, a) => sum + Math.log1p(v * v / energy[a]), 0);
                if (value > score) { best = s; score = value; }
            }
            selected.add(best); best.pilotStd.forEach((v, a) => { energy[a] += v * v; });
        }
    }
    for (const s of segments) if (!selected.has(s)) {
        const item = items[s.source.item], w = item.w || item;
        addExcluded(w, s.source.item, s.source.start, s.source.end, 'fit-budget-lower-pilot-excitation');
    }
    segments.splice(0, segments.length, ...segments.filter(s => selected.has(s)));
    const craftNames = [...new Set(segments.map(s => s.craft.toLowerCase().trim()).filter(Boolean))];
    if (craftNames.length > 1) reasons.push('The logs have different helicopter names. Fit one helicopter at a time.');
    const configurations = [...new Set(segments.map(s => s.configuration).filter(x => x !== null))];
    if (configurations.length > 1 && segments.some(s => s.output !== 'gyroRAW')) reasons.push('The filtered gyro output must use one recorded configuration.');
    if (segments.some(s => Math.abs(s.rate / segments[0].rate - 1) > 0.01)) reasons.push('The logs have different sample rates.');
    if (segments.some(s => s.output !== segments[0].output)) reasons.push('The logs have different gyro output fields.');
    if (segments.some(s => s.collectiveField !== segments[0].collectiveField)) reasons.push('The logs have different collective input fields.');
    return { segments, reasons, coverage: { inputSamples, usedSamples: segments.reduce((a, s) => a + s.n, 0),
        intervals: segments.map(metadata), excluded, craftNames, configurations,
        deduplication: { duplicateWindows: deduplicated.duplicates, overlappingWindows: deduplicated.overlaps,
            limitations: deduplicated.limitations, identityRule: 'recorded-start-and-craft-with-raw-sample-time-overlap-check' } } };
}

function metadata(s) { return { id: s.id, flight: s.flight, configuration: s.configuration, profile: s.profile,
    source: s.source, recordedGains: s.recordedGains || null, fromS: s.fromS, toS: s.fromS + s.n / s.rate,
    n: s.n, rate: s.rate, output: s.output, collectiveField: s.collectiveField }; }

function seededRandom(seed) {
    let state = 2166136261;
    for (const c of String(seed)) state = Math.imul(state ^ c.charCodeAt(0), 16777619) >>> 0;
    if (!state) state = 1;
    return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
function splitSegments(segments, options = {}) {
    const flights = [...new Set(segments.map(s => s.flight))].sort(), independentFlights = flights.length >= 3;
    const seed = String(options.seed === undefined ? `helicopter-sysid-v1:${flights.join('|')}` : options.seed), random = seededRandom(seed);
    const units = independentFlights ? flights.slice() : segments.slice().sort((a, b) => a.id.localeCompare(b.id));
    for (let i = units.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [units[i], units[j]] = [units[j], units[i]]; }
    const testCount = Math.max(1, Math.round(units.length * 0.2)), selectionCount = Math.max(1, Math.round(units.length * 0.2));
    const testUnits = new Set(units.slice(0, testCount)), selectionUnits = new Set(units.slice(testCount, testCount + selectionCount));
    const raw = { train: [], selection: [], test: [] };
    for (const s of segments) { const unit = independentFlights ? s.flight : s;
        raw[testUnits.has(unit) ? 'test' : selectionUnits.has(unit) ? 'selection' : 'train'].push(s); }
    const trim = s => {
        // Same-flight partitions retain a temporal embargo at BOTH sides of
        // each block. The remaining statistical dependence is still reported.
        const guard = Math.ceil(s.rate), end = s.n - guard;
        if (end - guard < RULES.minWindowS * s.rate) return null;
        const cut = x => slice(x, guard, end);
        return Object.assign({}, s, { fromS: s.fromS + guard / s.rate, n: end - guard,
            source: Object.assign({}, s.source, { start: s.source.start + guard, end: s.source.start + end }),
            u: s.u.map(cut), y: s.y.map(cut), sp: s.sp.map(cut), hs: cut(s.hs), coll: cut(s.coll), pilotColl: cut(s.pilotColl) });
    };
    const result = { method: independentFlights ? 'seeded-random-flights' : 'seeded-random-guarded-intervals', independentFlights, seed,
        requestedTestFraction: 0.2, actualTestFraction: units.length ? testUnits.size / units.length : 0,
        embargoS: independentFlights ? 0 : 1, assignment: [] };
    for (const role of ['train', 'selection', 'test']) {
        result[role] = independentFlights ? raw[role] : raw[role].map(trim).filter(Boolean);
        result.assignment.push(...result[role].map(s => ({ id: s.id, flight: s.flight, role, fromS: s.fromS, toS: s.fromS + s.n / s.rate })));
    }
    const total = ['train', 'selection', 'test'].flatMap(k => result[k]).reduce((sum, s) => sum + s.n, 0);
    result.actualTestSampleFraction = total ? result.test.reduce((sum, s) => sum + s.n, 0) / total : 0;
    return result;
}

function solve(matrix, rhs, ridge = 1e-6) {
    const n = rhs.length, scale = matrix.map((row, i) => Math.sqrt(Math.max(row[i], 1e-20)));
    const a = matrix.map((row, i) => row.map((x, j) => x / scale[i] / scale[j]).concat(rhs[i] / scale[i]));
    for (let i = 0; i < n; i++) a[i][i] += ridge;
    let minPivot = Infinity, maxPivot = 0;
    for (let j = 0; j < n; j++) {
        let p = j; for (let i = j + 1; i < n; i++) if (Math.abs(a[i][j]) > Math.abs(a[p][j])) p = i;
        [a[j], a[p]] = [a[p], a[j]];
        const pivot = a[j][j]; if (Math.abs(pivot) < 1e-12) return null;
        minPivot = Math.min(minPivot, Math.abs(pivot)); maxPivot = Math.max(maxPivot, Math.abs(pivot));
        for (let k = j; k <= n; k++) a[j][k] /= pivot;
        for (let i = 0; i < n; i++) if (i !== j) { const f = a[i][j]; for (let k = j; k <= n; k++) a[i][k] -= f * a[j][k]; }
    }
    return { coefficients: a.map((row, i) => row[n] / scale[i]), pivotRatio: maxPivot / minPivot };
}

function inputCondition(segments) {
    const sum = [0, 0, 0], products = Array.from({ length: 3 }, () => [0, 0, 0]); let n = 0;
    for (const s of segments) for (let i = 0; i < s.n; i += Math.max(1, Math.floor(s.rate / 125))) {
        n++; for (let a = 0; a < 3; a++) { sum[a] += s.u[a][i]; for (let b = 0; b < 3; b++) products[a][b] += s.u[a][i] * s.u[b][i]; }
    }
    if (!n) return Infinity;
    const covariance = products.map((row, a) => row.map((x, b) => x - sum[a] * sum[b] / n));
    const result = solve(covariance, [1, 1, 1], 0);
    return result ? result.pivotRatio : Infinity;
}

function featuresAt(s, reference, rpmExponent, index) {
    const i = Math.max(0, index), scale = rpmExponent === 2 ? (s.hs[i] / reference.rpm) ** 2 : 1;
    return [s.u[0][i] * scale, s.u[1][i] * scale, s.u[2][i] * scale, s.coll[i] - reference.collective,
        Math.abs(s.coll[i]) - reference.collectiveAbs, 1,
        (s.coll[i] / (reference.collectiveScale || 1)) ** 2 - (reference.collectiveSquared || 0),
        (s.hs[i] / reference.rpm) ** 2 - (reference.rpmSquared || 1),
        (s.hs[i] - s.hs[Math.max(0, i - 1)]) * s.rate / reference.rpm];
}
function activeFeatures(reference, useCollective) {
    const columns = useCollective === 'signed-and-absolute' ? [0, 1, 2, 3, 4, 5, 6] : useCollective ? [0, 1, 2, 3, 5, 6] : [0, 1, 2, 5];
    if (reference.variableRPM) columns.push(7, 8);
    return columns;
}
function instrumentFeatures(s, reference, rpmExponent, index) {
    const features = featuresAt(s, reference, rpmExponent, index), collective = s.pilotColl[index];
    features[3] = collective - reference.collective;
    features[4] = Math.abs(collective) - reference.collectiveAbs;
    features[6] = (collective / (reference.collectiveScale || 1)) ** 2 - (reference.collectiveSquared || 0);
    return features;
}

// Fixed fourth-order Butterworth conditioning. Both compared channels and
// every simulated unit-response basis use these same causal sections.
function analysisFilter(rate, cutoff, initial) {
    const frequency = Math.min(cutoff, rate * 0.4), angle = 2 * Math.PI * frequency / rate;
    const sections = [0.541196100146197, 1.306562964876377].map(q => {
        const alpha = Math.sin(angle) / (2 * q), a0 = 1 + alpha;
        const b0 = (1 - Math.cos(angle)) / (2 * a0), b1 = 2 * b0, b2 = b0, a1 = -2 * Math.cos(angle) / a0, a2 = (1 - alpha) / a0;
        return { b0, b1, b2, a1, a2, z1: initial.map(x => x * (1 - b0)), z2: initial.map(x => x * (b2 - a2)) };
    });
    return (channel, input) => {
        let x = input;
        for (let section = 0; section < 2; section++) {
            const c = sections[section], y = c.b0 * x + c.z1[channel];
            c.z1[channel] = c.b1 * x - c.a1 * y + c.z2[channel]; c.z2[channel] = c.b2 * x - c.a2 * y; x = y;
        }
        return x;
    };
}

// Simulated unit-input bases make coefficients linear parameters of the
// free-running prediction itself. There is no derivative regression and no
// measured-rate feedback inside the estimator's plant rollout.
function bases(segment, reference, dynamics, rpmExponent, stride, warmup, visit, bandHz = RULES.controlBandHz) {
    const c = plant.axisTransition(dynamics, 1 / segment.rate),
        alpha = dynamics.actuatorTauS > 0 ? 1 - Math.exp(-1 / segment.rate / dynamics.actuatorTauS) : 1,
        delay = dynamics.delayS * segment.rate, delayWhole = Math.floor(delay), fraction = delay - delayWhole;
    const featureAt = index => featuresAt(segment, reference, rpmExponent, index);
    const actuator = featureAt(0), response = Array(FEATURE_COUNT).fill(0), flap = response.slice();
    const filteredResponse = response.slice(), filteredMeasured = segment.y.map(x => x[0]),
        filter = analysisFilter(segment.rate, bandHz, response.concat([1], filteredMeasured));
    let filteredHomogeneous = 1;
    let homogeneous = 1, homogeneousFlap = 0;
    for (let i = 1; i < segment.n; i++) {
        const hi = featureAt(i - 1 - delayWhole), lo = featureAt(i - 2 - delayWhole);
        for (let j = 0; j < FEATURE_COUNT; j++) {
            actuator[j] += alpha * (hi[j] * (1 - fraction) + lo[j] * fraction - actuator[j]);
            const previous = response[j];
            response[j] = c.m00 * previous + c.m01 * flap[j] + c.b0 * actuator[j];
            flap[j] = c.m10 * previous + c.m11 * flap[j] + c.b1 * actuator[j];
        }
        const previous = homogeneous;
        homogeneous = c.m00 * previous + c.m01 * homogeneousFlap;
        homogeneousFlap = c.m10 * previous + c.m11 * homogeneousFlap;
        filteredHomogeneous = filter(FEATURE_COUNT, homogeneous);
        for (let j = 0; j < FEATURE_COUNT; j++) filteredResponse[j] = filter(j, response[j]);
        for (let a = 0; a < 3; a++) filteredMeasured[a] = filter(FEATURE_COUNT + 1 + a, segment.y[a][i]);
        if (i >= warmup && i % stride === 0) visit(filteredResponse, filteredHomogeneous, i, filteredMeasured);
    }
}

function fitCandidate(train, reference, dynamics, rpmExponent, rules, useCollective, prior) {
    const featureIndices = activeFeatures(reference, useCollective), dimension = featureIndices.length, constantColumn = featureIndices.indexOf(5);
    const gram = Array.from({ length: dimension }, () => Array(dimension).fill(0)), rhs = AXES.map(() => Array(dimension).fill(0));
    const sumSquares = [0, 0, 0]; let count = 0;
    const instrumentCount = 9 + featureIndices.filter(j => j >= 3).length;
    const zz = Array.from({ length: instrumentCount }, () => Array(instrumentCount).fill(0));
    const zx = Array.from({ length: instrumentCount }, () => Array(dimension).fill(0));
    const zy = Array.from({ length: instrumentCount }, () => [0, 0, 0]);
    for (const s of train) bases(s, reference, dynamics, rpmExponent, Math.max(1, Math.floor(s.rate / rules.fitSampleHz)), Math.ceil(rules.warmupS * s.rate), (x, h, i, measured) => {
        count++;
        const instrument = [];
        for (const delay of [0, 0.08, 0.24]) for (let axis = 0; axis < 3; axis++) instrument.push(s.sp[axis][Math.max(0, i - Math.round(delay * s.rate))]);
        const forcing = instrumentFeatures(s, reference, rpmExponent, i);
        for (const feature of featureIndices) if (feature >= 3) instrument.push(forcing[feature]);
        for (let j = 0; j < instrumentCount; j++) {
            for (let k = 0; k < instrumentCount; k++) zz[j][k] += instrument[j] * instrument[k];
            for (let k = 0; k < dimension; k++) zx[j][k] += instrument[j] * x[featureIndices[k]];
            for (let axis = 0; axis < 3; axis++) zy[j][axis] += instrument[j] * (measured[axis] - h * s.y[axis][0]);
        }
        for (let a = 0; a < 3; a++) {
            const target = measured[a] - h * s.y[a][0]; sumSquares[a] += target * target;
            for (let j = 0; j < dimension; j++) rhs[a][j] += x[featureIndices[j]] * target;
        }
        for (let j = 0; j < dimension; j++) for (let k = 0; k < dimension; k++) gram[j][k] += x[featureIndices[j]] * x[featureIndices[k]];
    }, rules.controlBandHz);
    if (count < dimension * 20) return null;
    const projected = Array.from({ length: dimension }, (_, j) => solve(zz, zx.map(row => row[j])));
    if (projected.some(x => !x)) return null;
    const ivGram = Array.from({ length: dimension }, (_, j) => Array.from({ length: dimension }, (_, k) => zx.reduce((sum, row, z) => sum + row[j] * projected[k].coefficients[z], 0)));
    const ivRhs = [0, 1, 2].map(axis => Array.from({ length: dimension }, (_, j) => zy.reduce((sum, row, z) => sum + row[axis] * projected[j].coefficients[z], 0)));
    // Broad geometry prior on control torque / inertia. For a guessed disk
    // moment of 0.3 * mass * gravity * radius per normalized command, divide
    // by body inertia and modal damping to obtain a static rate-gain prior.
    // The unknown hub/servo conversion dominates: factor-20 spread and one
    // equivalent sample keep informative flight data dominant.
    const fitted = ivRhs.map((r, axis) => {
        const matrix = ivGram.map(row => row.slice()), target = r.slice();
        if (prior && prior.inertia) {
            const torque = 0.3 * prior.massKg * 9.80665 * prior.dimensionsM.rotorRadius;
            const centre = torque / prior.inertia.diagonal[axis] * 180 / Math.PI /
                (dynamics.type === 'torque-rate' ? 1 : 2 * dynamics.damping * 2 * Math.PI * dynamics.frequencyHz);
            for (let j = 0; j < 3; j++) {
                const precision = (ivGram[j][j] / count) / 400;
                matrix[j][j] += precision;
                if (axis === j) target[j] += precision * centre;
            }
        }
        return solve(matrix, target);
    }); if (fitted.some(r => !r)) return null;
    const axes = fitted.map((r, a) => {
        const all = Array(FEATURE_COUNT).fill(0); featureIndices.forEach((j, k) => { all[j] = r.coefficients[k]; });
        let residual = sumSquares[a];
        for (let j = 0; j < dimension; j++) { residual -= 2 * r.coefficients[j] * rhs[a][j];
            for (let k = 0; k < dimension; k++) residual += r.coefficients[j] * gram[j][k] * r.coefficients[k]; }
        return Object.assign({}, dynamics, { gain: all.slice(0, 3), collectiveGain: all[3], collectiveAbsGain: all[4], bias: all[5],
            collectiveSquaredGain: all[6], rpmGain: all[7], rpmDerivativeGain: all[8],
            trainingRMSE: Math.sqrt(Math.max(0, residual) / count), regressionPivotRatio: r.pivotRatio,
            instrumentPredictability: Math.max(0, Math.min(1,
                (ivGram[a][a] - ivGram[a][constantColumn] ** 2 / Math.max(ivGram[constantColumn][constantColumn], 1e-20)) /
                Math.max(gram[a][a] - gram[a][constantColumn] ** 2 / Math.max(gram[constantColumn][constantColumn], 1e-20), 1e-20))) });
    });
    return axes;
}

function fitCoupled(template, train, rotorCoupling, rules, useCollective) {
    const features = activeFeatures(template.reference, useCollective);
    const countPerAxis = features.length, dimension = 3 * countPerAxis, model = Object.assign({}, template, { rotorCoupling });
    const gram = Array.from({ length: dimension }, () => Array(dimension).fill(0)), rhs = Array(dimension).fill(0); let samples = 0;
    const instrumentCount = 9 + features.filter(j => j >= 3).length;
    const zz = Array.from({ length: instrumentCount }, () => Array(instrumentCount).fill(0));
    const zx = [0, 1, 2].map(() => Array.from({ length: instrumentCount }, () => Array(dimension).fill(0)));
    const zy = [0, 1, 2].map(() => Array(instrumentCount).fill(0));
    for (const s of train) {
        const transition = plant.coupledTransition(model, 1 / s.rate), stride = Math.max(1, Math.floor(s.rate / rules.fitSampleHz)), warmup = Math.ceil(rules.warmupS * s.rate);
        const measured = s.y.map(x => x[0]);
        const featureAt = index => featuresAt(s, model.reference, model.rpmExponent, index);
        const actuator = model.axes.map(() => featureAt(0)), states = Array.from({ length: dimension }, () => Array(6).fill(0));
        const filtered = Array.from({ length: 3 }, () => Array(dimension).fill(0));
        let homogeneous = s.y.map(x => x[0]).concat([0, 0, 0]); const filteredHomogeneous = homogeneous.slice(0, 3);
        const filter = analysisFilter(s.rate, rules.controlBandHz, Array(dimension * 3).fill(0).concat(measured, measured));
        for (let i = 1; i < s.n; i++) {
            for (let axis = 0; axis < 3; axis++) {
                const a = model.axes[axis], delay = a.delayS * s.rate, whole = Math.floor(delay), fraction = delay - whole;
                const hi = featureAt(i - 1 - whole), lo = featureAt(i - 2 - whole), alpha = a.actuatorTauS ? 1 - Math.exp(-1 / s.rate / a.actuatorTauS) : 1;
                for (let j = 0; j < FEATURE_COUNT; j++) actuator[axis][j] += alpha * (hi[j] * (1 - fraction) + lo[j] * fraction - actuator[axis][j]);
            }
            homogeneous = transition.state.map(row => row.reduce((sum, x, j) => sum + x * homogeneous[j], 0));
            for (let axis = 0; axis < 3; axis++) {
                measured[axis] = filter(dimension * 3 + axis, s.y[axis][i]);
                filteredHomogeneous[axis] = filter(dimension * 3 + 3 + axis, homogeneous[axis]);
            }
            for (let column = 0; column < dimension; column++) {
                const destination = Math.floor(column / countPerAxis), feature = features[column % countPerAxis], before = states[column];
                const after = transition.state.map((row, k) => row.reduce((sum, x, j) => sum + x * before[j], 0) + transition.drive[k][destination] * actuator[destination][feature]);
                states[column] = after;
                for (let axis = 0; axis < 3; axis++) filtered[axis][column] = filter(axis * dimension + column, after[axis]);
            }
            if (i < warmup || i % stride) continue;
            samples++;
            const instrument = [];
            for (const delay of [0, 0.08, 0.24]) for (let axis = 0; axis < 3; axis++) instrument.push(s.sp[axis][Math.max(0, i - Math.round(delay * s.rate))]);
            const forcing = instrumentFeatures(s, model.reference, model.rpmExponent, i); for (const feature of features) if (feature >= 3) instrument.push(forcing[feature]);
            for (let j = 0; j < instrumentCount; j++) for (let k = 0; k < instrumentCount; k++) zz[j][k] += instrument[j] * instrument[k];
            for (let axis = 0; axis < 3; axis++) {
                const target = measured[axis] - filteredHomogeneous[axis], row = filtered[axis];
                for (let j = 0; j < instrumentCount; j++) {
                    zy[axis][j] += instrument[j] * target;
                    for (let k = 0; k < dimension; k++) zx[axis][j][k] += instrument[j] * row[k];
                }
                for (let j = 0; j < dimension; j++) {
                    rhs[j] += row[j] * target;
                    for (let k = 0; k < dimension; k++) gram[j][k] += row[j] * row[k];
                }
            }
        }
    }
    if (!samples) return null;
    const ivGram = Array.from({ length: dimension }, () => Array(dimension).fill(0)), ivRhs = Array(dimension).fill(0);
    for (let axis = 0; axis < 3; axis++) {
        const projected = Array.from({ length: dimension }, (_, j) => solve(zz, zx[axis].map(row => row[j])));
        if (projected.some(x => !x)) return null;
        for (let j = 0; j < dimension; j++) {
            ivRhs[j] += zy[axis].reduce((sum, value, z) => sum + value * projected[j].coefficients[z], 0);
            for (let k = 0; k < dimension; k++) ivGram[j][k] += zx[axis].reduce((sum, row, z) => sum + row[j] * projected[k].coefficients[z], 0);
        }
    }
    // Weak regularization is centred on the already identified torque/inertia
    // coefficients. Coupled candidates retain that physical prior.
    for (let j = 0; j < dimension; j++) {
        const axis = Math.floor(j / countPerAxis), a = model.axes[axis], old = plant.gains(a);
        const precision = ivGram[j][j] / samples / 400; ivGram[j][j] += precision; ivRhs[j] += precision * old[features[j % countPerAxis]];
    }
    const solution = solve(ivGram, ivRhs); if (!solution) return null;
    model.axes = model.axes.map((a, axis) => {
        const all = Array(FEATURE_COUNT).fill(0); features.forEach((feature, j) => { all[feature] = solution.coefficients[axis * countPerAxis + j]; });
        return Object.assign({}, a, { gain: all.slice(0, 3), collectiveGain: all[3], collectiveAbsGain: all[4], bias: all[5],
            collectiveSquaredGain: all[6], rpmGain: all[7], rpmDerivativeGain: all[8] });
    });
    return plant.validateModel(model).length || model.axes.some((a, i) => a.gain[i] <= 0) ? null : model;
}

function evaluate(model, segments, options = {}) {
    const rules = Object.assign({}, RULES, options.rules), perSegment = [], predictions = [], sums = AXES.map(() => ({ n: 0, error: 0, error2: 0, target: 0, target2: 0,
        corr: [0, 0, 0], input: [0, 0, 0], input2: [0, 0, 0], lag: 0, lag2: 0, product: 0, lagN: 0 }));
    for (const s of segments) {
        const prediction = s._prediction || plant.rollout(model, s), start = Math.ceil(rules.warmupS * s.rate), local = [0, 0, 0];
        const lag = Math.max(1, Math.round(s.rate * 0.1));
        for (let a = 0; a < 3; a++) for (let i = start; i < s.n; i++) {
            const r = sums[a], error = prediction[a][i] - s.y[a][i];
            r.n++; r.error += error; r.error2 += error * error; r.target += s.y[a][i]; r.target2 += s.y[a][i] ** 2; local[a] += error * error;
            for (let b = 0; b < 3; b++) { r.corr[b] += error * s.u[b][i]; r.input[b] += s.u[b][i]; r.input2[b] += s.u[b][i] ** 2; }
            if (i >= start + lag) { const old = prediction[a][i - lag] - s.y[a][i - lag]; r.lagN++; r.product += error * old; r.lag += old; r.lag2 += old * old; }
        }
        perSegment.push(Object.assign(metadata(s), { rmse: local.map(x => Math.sqrt(x / Math.max(1, s.n - start))), initialStateSamples: 1, warmupS: rules.warmupS }));
        if (options.predictions) predictions.push(Object.assign(metadata(s), { measured: s.y.map(x => Array.from(x)), predicted: prediction.map(x => Array.from(x)),
            inputs: { u: s.u.map(x => Array.from(x)), hs: Array.from(s.hs), coll: Array.from(s.coll),
                pilotColl: s.pilotColl ? Array.from(s.pilotColl) : null } }));
    }
    const axes = sums.map((r, a) => {
        const variance = Math.max(0, r.target2 / Math.max(1, r.n) - (r.target / Math.max(1, r.n)) ** 2), rmse = Math.sqrt(r.error2 / Math.max(1, r.n)), bias = r.error / Math.max(1, r.n);
        const errorVariance = Math.max(0, r.error2 - r.error * r.error / Math.max(1, r.n));
        const correlation = r.corr.map((x, b) => (x - r.error * r.input[b] / Math.max(1, r.n)) /
            Math.sqrt(Math.max(1e-20, errorVariance * (r.input2[b] - r.input[b] ** 2 / Math.max(1, r.n)))));
        const autocorrelation = r.lagN ? (r.product / r.lagN - bias * r.lag / r.lagN) /
            Math.sqrt(Math.max(1e-20, errorVariance / Math.max(1, r.n) * (r.lag2 / r.lagN - (r.lag / r.lagN) ** 2))) : null;
        return { axis: AXES[a], n: r.n, rmse, bias, normalizedRMSE: variance > 0 ? rmse / Math.sqrt(variance) : null,
            outputStd: Math.sqrt(variance), residualInputCorrelation: correlation, residualAutocorrelation100ms: autocorrelation };
    });
    const result = { axes, intervals: perSegment, predictions, freeRunning: true, measuredStateInjection: 'first-sample-only' };
    if (!options._bandPass) {
        // Apply the same causal analysis filter to both signals. It is never
        // part of the exported physical plant or firmware sensor chain.
        const filtered = segments.map(s => {
            const lowpass = data => {
                const out = new Float64Array(data.length), filter = analysisFilter(s.rate, rules.controlBandHz, [data[0]]);
                out[0] = data[0]; for (let i = 1; i < data.length; i++) out[i] = filter(0, data[i]); return out;
            };
            return Object.assign({}, s, { y: s.y.map(lowpass), _prediction: plant.rollout(model, s).map(lowpass) });
        });
        const band = evaluate(model, filtered, { rules, _bandPass: true });
        result.controlledAxes = band.axes; result.controlledIntervals = band.intervals; result.controlBandHz = rules.controlBandHz;
    }
    return result;
}

function frequencyValidation(model, segments, options = {}) {
    const rules = Object.assign({}, RULES, options.rules), frequencies = [0.5, 1, 2, 3, 5, 8, 12, 16, 20].filter(f => f <= rules.controlBandHz && segments.every(s => f < s.rate * 0.4));
    const bins = [0, 1, 2].map(() => frequencies.map(frequencyHz => ({ frequencyHz, n: 0, rr: 0, uu: 0, yy: 0, ru: [0, 0], ry: [0, 0], rp: [0, 0] })));
    for (const s of segments) {
        const prediction = plant.rollout(model, s), block = Math.round(4 * s.rate), first = Math.ceil(rules.warmupS * s.rate);
        const weights = Float64Array.from({ length: block }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (block - 1)));
        for (let start = first; start + block <= s.n; start += block) for (let axis = 0; axis < 3; axis++) {
            const columns = [s.sp[axis], s.u[axis], s.y[axis], prediction[axis]], means = columns.map(x => {
                let total = 0; for (let i = 0; i < block; i++) total += x[start + i]; return total / block;
            });
            for (let f = 0; f < frequencies.length; f++) {
                const angle = 2 * Math.PI * frequencies[f] / s.rate, cs = Math.cos(angle), sn = Math.sin(angle), real = [0, 0, 0, 0], imaginary = [0, 0, 0, 0];
                let c = 1, v = 0;
                for (let i = 0; i < block; i++) {
                    for (let j = 0; j < 4; j++) { const value = (columns[j][start + i] - means[j]) * weights[i]; real[j] += value * c; imaginary[j] -= value * v; }
                    const previous = c; c = c * cs - v * sn; v = v * cs + previous * sn;
                }
                const b = bins[axis][f]; b.n++; b.rr += real[0] ** 2 + imaginary[0] ** 2; b.uu += real[1] ** 2 + imaginary[1] ** 2; b.yy += real[2] ** 2 + imaginary[2] ** 2;
                for (let j = 1; j < 4; j++) { const cross = j === 1 ? b.ru : j === 2 ? b.ry : b.rp;
                    cross[0] += real[j] * real[0] + imaginary[j] * imaginary[0]; cross[1] += imaginary[j] * real[0] - real[j] * imaginary[0]; }
            }
        }
    }
    const magnitude2 = x => x[0] ** 2 + x[1] ** 2;
    const axes = bins.map((list, axis) => {
        const peakPilotPower = Math.max(...list.map(b => b.rr));
        const values = list.map(b => {
            const pilotInputCoherence = Math.min(1, magnitude2(b.ru) / Math.max(1e-30, b.rr * b.uu));
            const pilotOutputCoherence = Math.min(1, magnitude2(b.ry) / Math.max(1e-30, b.rr * b.yy));
            const relativeUncertainty = pilotInputCoherence > 0 && b.n ? Math.sqrt((1 - pilotInputCoherence) / (2 * b.n * pilotInputCoherence)) : null;
            const relativePredictionError = magnitude2(b.ry) > 0 ? Math.sqrt(magnitude2([b.rp[0] - b.ry[0], b.rp[1] - b.ry[1]]) / magnitude2(b.ry)) : null;
            return { frequencyHz: b.frequencyHz, blocks: b.n, pilotInputCoherence, pilotOutputCoherence, relativeUncertainty, relativePredictionError,
                pilotPowerFraction: peakPilotPower > 0 ? b.rr / peakPilotPower : 0,
                pass: b.n >= rules.minSpectralBlocks && peakPilotPower > 0 && b.rr / peakPilotPower >= 0.005 &&
                    pilotInputCoherence >= rules.minPilotInputCoherence && pilotOutputCoherence >= rules.minPilotOutputCoherence &&
                    relativeUncertainty !== null && relativeUncertainty <= rules.maxSpectralRelativeUncertainty &&
                    relativePredictionError !== null && relativePredictionError <= rules.maxSpectralPredictionError };
        });
        return { axis: AXES[axis], bins: values, supportedFrequenciesHz: values.filter(b => b.pass).map(b => b.frequencyHz) };
    });
    const common = frequencies.filter(f => axes.every(a => a.supportedFrequenciesHz.includes(f)));
    return { method: 'nonoverlapping-Hann-pilot-cross-spectrum', blockS: 4, axes, commonSupportedFrequenciesHz: common,
        limitation: 'Only the shown frequencies agree with the model. The checks give no result at other frequencies.' };
}

function accuracyConfidence(validation, status, rules, seed) {
    const intervals = validation.test.controlledIntervals || [], flights = [...new Set(intervals.map(s => s.flight))];
    const independentFlights = flights.length, useFlights = independentFlights >= 3, units = [];
    if (useFlights) for (const flight of flights) {
        const rows = intervals.filter(s => s.flight === flight), n = rows.reduce((sum, s) => sum + Math.max(1, s.n - Math.ceil(s.rate * rules.warmupS)), 0);
        units.push({ n, mse: [0, 1, 2].map(a => rows.reduce((sum, s) => sum + s.rmse[a] ** 2 * Math.max(1, s.n - Math.ceil(s.rate * rules.warmupS)), 0) / n) });
    } else for (const s of intervals) units.push({ n: Math.max(1, s.n - Math.ceil(s.rate * rules.warmupS)), mse: s.rmse.map(x => x * x) });
    const draws = [[], [], []], random = seededRandom(`${seed}:accuracy-bootstrap`);
    if (units.length >= 2) for (let draw = 0; draw < 1000; draw++) {
        const totals = [0, 0, 0]; let samples = 0;
        for (let j = 0; j < units.length; j++) { const u = units[Math.floor(random() * units.length)]; samples += u.n;
            for (let a = 0; a < 3; a++) totals[a] += u.mse[a] * u.n; }
        for (let a = 0; a < 3; a++) draws[a].push(Math.sqrt(totals[a] / samples));
    }
    const axes = validation.test.controlledAxes.map((a, index) => {
        const ordered = draws[index].sort((x, y) => x - y), interval = ordered.length ? [ordered[25], ordered[974]] : null;
        return { axis: a.axis, rmse: a.rmse, normalizedRMSE: a.normalizedRMSE, rmseInterval95: interval,
            normalizedRMSEInterval95: interval && a.outputStd > 0 ? interval.map(x => x / a.outputStd) : null,
            rawRMSE: validation.test.axes[index].rmse, bias: a.bias };
    });
    const upperErrorsPass = axes.every(a => a.normalizedRMSEInterval95 && a.normalizedRMSEInterval95[1] <= rules.maxNormalizedRMSE);
    const frequencyCoverage = validation.frequency.axes.every(a => a.supportedFrequenciesHz.length >= 3);
    const level = status !== 'validated' ? 'low' : useFlights && intervals.length >= 6 && upperErrorsPass && frequencyCoverage ? 'high' :
        validation.split.independentFlights && units.length >= 3 && upperErrorsPass ? 'moderate' : 'low';
    const reasons = [];
    if (status !== 'validated') reasons.push('The calculated response did not agree with the model check limits.');
    if (!useFlights) reasons.push('The error interval uses flight periods. Errors from the same flight can be related.');
    if (units.length < 2) reasons.push('More flight periods are necessary to calculate an error interval.');
    if (!frequencyCoverage) reasons.push('The pilot inputs do not measure the response at three frequencies on each axis.');
    if (!upperErrorsPass && units.length >= 2) reasons.push('The maximum error of the interval is more than the model check limit.');
    if (level === 'high') reasons.push('The model agrees with the error limits in three or more different test flights.');
    else if (level === 'moderate') reasons.push('The model agrees with the error limits, but more different test flights are necessary.');
    return { level, reasons, axes, method: useFlights ? 'whole-flight-bootstrap-1000-percentile' : 'interval-bootstrap-1000-percentile-dependent',
        independentFlights, validationSamples: validation.test.axes[0].n, validationIntervals: intervals.length,
        bootstrapUnits: units.length, analysisFilterHz: rules.controlBandHz, confidenceMeaning: 'empirical-reserved-data-error-not-probability-of-model-correctness' };
}

function fit(input = {}) {
    const options = input.options || {}, rules = Object.assign({}, RULES, options.rules), prepared = prepareSegments(input), split = splitSegments(prepared.segments, options);
    const result = { version: 1, status: 'rejected', controlEligible: false, model: null, ensemble: [], coverage: prepared.coverage,
        confidence: { level: 'unavailable', axes: [], reasons: ['The model has no test-log error result.'] },
        reasons: prepared.reasons.slice(), rules, validation: { split: { method: split.method, independentFlights: split.independentFlights, seed: split.seed,
            requestedTestFraction: split.requestedTestFraction, actualTestFraction: split.actualTestFraction, actualTestSampleFraction: split.actualTestSampleFraction,
            embargoS: split.embargoS, assignment: split.assignment,
            train: split.train.map(metadata), selection: split.selection.map(metadata), test: split.test.map(metadata) } }, predictions: [] };
    if (options.keepSegments) result.segments = split;
    if (result.reasons.length) return result;
    if (!split.train.length || !split.selection.length || !split.test.length) { result.reasons.push('Different fit, selection and test intervals are necessary.'); return result; }
    const condition = inputCondition(split.train); result.validation.inputCondition = condition;
    if (!finite(condition) || condition > rules.maxInputCondition) { result.reasons.push('The control inputs do not identify three different axes.'); return result; }
    const pilotCondition = inputCondition(split.train.map(s => Object.assign({}, s, { u: s.sp })));
    result.validation.pilotCondition = pilotCondition;
    if (!finite(pilotCondition) || pilotCondition > rules.maxInputCondition) { result.reasons.push('The pilot inputs do not identify three different axes.'); return result; }
    const sample = key => split.train.flatMap(s => { const x = []; for (let i = 0; i < s.n; i += Math.max(1, Math.floor(s.rate / 50))) x.push(key(s, i)); return x; });
    const rpm = sample((s, i) => s.hs[i]), collective = sample((s, i) => s.coll[i]), rpmStats = stats(rpm), collectiveStats = stats(collective);
    const collectiveScale = Math.max(Math.abs(collectiveStats.min), Math.abs(collectiveStats.max)) > 2 ? 1000 : 1;
    const reference = { rpm: rpmStats.mean, collective: collectiveStats.mean, collectiveAbs: mean(collective.map(Math.abs)), collectiveScale,
        collectiveSquared: mean(collective.map(x => (x / collectiveScale) ** 2)), rpmSquared: mean(rpm.map(x => (x / rpmStats.mean) ** 2)),
        variableRPM: rpmStats.std / rpmStats.mean > 0.005 };
    const base = { version: 1, kind: 'rotational-rotor-body', rate: split.train[0].rate, output: split.train[0].output, collectiveField: split.train[0].collectiveField,
        reference, rpmExponent: 2, axes: [], prior: plant.craftPrior(input.craft || split.train[0].craft),
        envelope: { rpm: [rpmStats.min, rpmStats.max], collective: [collectiveStats.min, collectiveStats.max],
            input: [0, 1, 2].map(a => { const s = stats(sample((w, i) => w.u[a][i])); return [s.min, s.max]; }),
            bodyRate: [0, 1, 2].map(a => { const s = stats(sample((w, i) => w.y[a][i])); return [s.min, s.max]; }) },
        identity: { craft: input.craft || split.train[0].craft, trainingFlights: [...new Set(split.train.map(s => s.flight))],
            configuration: input.targetConfiguration || split.train[0].configuration, configurations: prepared.coverage.configurations, sourceIntervals: prepared.segments.map(metadata) },
        capabilities: { sensorOutputs: [split.train[0].output], exogenous: ['mixer', 'headspeed', 'collective'],
            governor: false, position: false, attitude: false, accelerometer: false, physicalInertiaIdentified: false,
            rawGyroPlant: split.train[0].output === 'gyroRAW', measuredMixerCollective: split.train[0].collectiveField === 'mixer[3]', observedEnvelopeOnly: true } };
    const grid = Object.assign({ frequencyHz: [0.25, 0.5, 1, 2, 4, 7, 12, 20, 30], damping: [0.35, 0.75, 1.5, 3, 6], actuatorTauS: [0, 0.008, 0.025], delayS: [0, 0.008, 0.02, 0.04] }, options.grid);
    const rankings = [[], [], []], useCollective = collectiveStats.std > 0.02 ?
        (collectiveStats.min < -0.02 && collectiveStats.max > 0.02 ? 'signed-and-absolute' : 'signed') : false;
    // Fixed squared-RPM scaling is a physical prior, not an identified exponent.
    // A constant-RPM alternative lets validation reject inappropriate scaling.
    const exponents = rpmStats.std / reference.rpm > 0.03 ? [0, 2] : [0];
    let candidateCount = 0;
    for (const rpmExponent of exponents) for (const frequencyHz of grid.frequencyHz) for (const damping of grid.damping)
        for (const actuatorTauS of grid.actuatorTauS) for (const delayS of grid.delayS) {
            const dynamics = { frequencyHz, damping, actuatorTauS, delayS }, fitted = fitCandidate(split.train, reference, dynamics, rpmExponent, rules, useCollective, base.prior);
            if (!fitted) continue; candidateCount++;
            for (let a = 0; a < 3; a++) if (fitted[a].gain[a] > 0 && fitted[a].instrumentPredictability >= rules.minInstrumentPredictability &&
                fitted[a].gain.every(x => finite(x) && Math.abs(x) < 1e6)) rankings[a].push({ axis: fitted[a], rpmExponent, train: fitted[a].trainingRMSE });
        }
    // The tail is a torque balance, not necessarily a rotor/body spring.
    // Include exact rate integration and lightly damped rate dynamics with
    // actuator lag, rather than forcing a nonzero yaw stiffness.
    for (const rpmExponent of exponents) for (const decayRate of options.yawDecayGrid || [0, 0.1, 0.3, 1, 3, 10])
        for (const actuatorTauS of grid.actuatorTauS) for (const delayS of grid.delayS) {
            const dynamics = { type: 'torque-rate', decayRate, frequencyHz: 1, damping: 1, actuatorTauS, delayS };
            const fitted = fitCandidate(split.train, reference, dynamics, rpmExponent, rules, useCollective, base.prior);
            if (!fitted) continue; candidateCount++;
            const a = fitted[2];
            if (a.gain[2] > 0 && a.instrumentPredictability >= rules.minInstrumentPredictability && a.gain.every(x => finite(x) && Math.abs(x) < 1e6))
                rankings[2].push({ axis: a, rpmExponent, train: a.trainingRMSE });
        }
    result.validation.candidateCount = candidateCount;
    if (rankings.some(x => !x.length)) { result.reasons.push('The model fit did not give parameters in range.'); return result; }
    result.validation.candidateFamilies = rankings.map((list, axis) => ({ axis: AXES[axis], families: ['oscillator', 'torque-rate'].map(type => {
        const candidates = list.filter(x => (x.axis.type || 'oscillator') === type).sort((a, b) => a.train - b.train);
        return { type, eligibleCandidates: candidates.length, bestTrainingRMSE: candidates.length ? candidates[0].train : null };
    }) }));
    // Select only with the reserved selection flights. Test data remains unused
    // until coefficients, pole choices and uncertainty ensemble are frozen.
    const chosenByExponent = [];
    for (const rpmExponent of exponents) {
        const ranked = rankings.map(list => ['oscillator', 'torque-rate'].flatMap(type => list.filter(x =>
            x.rpmExponent === rpmExponent && (x.axis.type || 'oscillator') === type).sort((a, b) => a.train - b.train).slice(0, 12)));
        if (ranked.some(x => !x.length)) continue;
        for (let rank = 0; rank < Math.max(...ranked.map(x => x.length)); rank++) {
            const axes = ranked.map(list => list[Math.min(rank, list.length - 1)].axis), model = Object.assign({}, base, { rpmExponent, axes });
            const measured = evaluate(model, split.selection, { rules });
            for (let a = 0; a < 3; a++) if (rank < ranked[a].length) ranked[a][rank].selection = measured.controlledAxes[a].rmse;
        }
        ranked.forEach(list => list.sort((a, b) => a.selection - b.selection));
        for (let axis = 0; axis < 3; axis++) for (const family of result.validation.candidateFamilies[axis].families) {
            const candidates = ranked[axis].filter(x => (x.axis.type || 'oscillator') === family.type);
            if (candidates.length) family.bestSelectionRMSE = Math.min(family.bestSelectionRMSE === undefined ? Infinity : family.bestSelectionRMSE,
                ...candidates.map(x => x.selection));
        }
        const model = Object.assign({}, base, { rpmExponent, axes: ranked.map(x => x[0].axis) });
        chosenByExponent.push({ model, ranked, score: ranked.reduce((sum, x) => sum + x[0].selection, 0) });
    }
    chosenByExponent.sort((a, b) => a.score - b.score);
    let best = chosenByExponent[0];
    const coupledCandidates = [{ model: best.model, score: best.score }];
    // Candidate dynamic coupling is selected without opening the final test
    // flights. A zero coefficient is an explicit nested model, not an implied
    // claim that the helicopter has no cyclic coupling.
    for (const coupling of options.rotorCouplingGrid || [-60, -20, 20, 60]) {
        const model = fitCoupled(best.model, split.train, coupling, rules, useCollective); if (!model) continue;
        const validation = evaluate(model, split.selection, { rules });
        coupledCandidates.push({ model, score: validation.controlledAxes.reduce((sum, a) => sum + a.rmse, 0) });
    }
    coupledCandidates.sort((a, b) => a.score - b.score);
    best = Object.assign({}, best, { model: coupledCandidates[0].model }); result.model = best.model;
    result.model.fit = { method: 'pilot-instrumented-unit-response', candidateCount, collectiveTermsFitted: useCollective,
        inertiaPriorUse: base.prior.inertia ? 'broad-torque-over-inertia-coefficient-regularization' : 'no-geometry-prior',
        initialFlapState: 'zero-with-excluded-warmup', closedLoopIdentificationBias: 'possible-with-correlated-disturbances',
        uncertaintyKind: 'plausible-model-spread-not-confidence-interval', rules };
    result.model.units = { rate: 'deg/s', rotorState: 'deg/s2', mixer: 'firmware-mixer-command-divided-by-1000', headspeed: 'RPM',
        collective: `native-logged-${result.model.collectiveField}-permille`, gain: result.model.axes.map(a => a.type === 'torque-rate' ? 'deg/s2 per input feature' : 'deg/s per input feature') };
    result.ensemble = coupledCandidates.length >= 3 ? coupledCandidates.slice(0, 3).map(x => x.model) :
        [0, 1, 2].map(rank => Object.assign({}, best.model, { axes: best.ranked.map(list => list[Math.min(rank, list.length - 1)].axis) }));
    result.model.parameterUncertainty = AXES.map((axis, a) => {
        const family = best.model.axes[a].type || 'oscillator', compatible = result.ensemble.filter(m => (m.axes[a].type || 'oscillator') === family);
        const names = family === 'torque-rate' ? ['decayRate', 'actuatorTauS', 'delayS'] : ['frequencyHz', 'damping', 'actuatorTauS', 'delayS'];
        return { axis, family, source: 'selection-ranked models of the same parameter family', models: compatible.length,
            parameters: Object.fromEntries(names.map(key => [key, [Math.min(...compatible.map(m => m.axes[a][key])), Math.max(...compatible.map(m => m.axes[a][key]))]])),
            gain: [0, 1, 2].map(b => [Math.min(...compatible.map(m => m.axes[a].gain[b])), Math.max(...compatible.map(m => m.axes[a].gain[b]))]) };
    });
    result.model.rotorCouplingUncertainty = [Math.min(...result.ensemble.map(m => m.rotorCoupling || 0)), Math.max(...result.ensemble.map(m => m.rotorCoupling || 0))];
    result.validation.training = evaluate(best.model, split.train, { rules });
    result.validation.selection = evaluate(best.model, split.selection, { rules });
    result.validation.test = evaluate(best.model, split.test, { rules, predictions: !!options.predictions });
    result.predictions = result.validation.test.predictions; delete result.validation.test.predictions;
    result.validation.frequency = frequencyValidation(best.model, split.test, { rules });
    result.model.analysisFilterHz = rules.controlBandHz;
    for (const axis of result.validation.test.controlledAxes) {
        if (axis.normalizedRMSE === null || axis.normalizedRMSE > rules.maxNormalizedRMSE) result.reasons.push(`${axis.axis}: The reserved-log model error is above the limit.`);
        if (Math.abs(axis.bias) > rules.maxBiasDegS) result.reasons.push(`${axis.axis}: The reserved-log bias is above the limit.`);
        if (axis.rmse > rules.residualCorrelationFloorDegS && axis.residualInputCorrelation.some(x => Math.abs(x) > rules.maxResidualInputCorrelation)) result.reasons.push(`${axis.axis}: The model error follows a control input.`);
        if (axis.rmse > rules.residualCorrelationFloorDegS && axis.residualAutocorrelation100ms !== null && Math.abs(axis.residualAutocorrelation100ms) > rules.maxResidualAutocorrelation) result.reasons.push(`${axis.axis}: The model error has a persistent time pattern.`);
    }
    result.status = result.reasons.length ? 'rejected' : 'validated';
    result.confidence = accuracyConfidence(result.validation, result.status, rules, split.seed);
    result.model.confidence = result.confidence;
    const supported = result.validation.frequency.commonSupportedFrequenciesHz;
    result.model.validatedFrequenciesHz = result.status === 'validated' ? supported : [];
    result.model.validatedBandHz = result.status === 'validated' && supported.length >= 2 ? [supported[0], supported[supported.length - 1]] : null;
    result.controlEligible = result.status === 'validated' && split.independentFlights && best.model.output === 'gyroRAW' &&
        best.model.collectiveField === 'mixer[3]' && supported.length >= 2;
    result.controlReasons = [];
    if (!split.independentFlights) result.controlReasons.push('Three different flight logs are necessary for control tuning.');
    if (best.model.output !== 'gyroRAW') result.controlReasons.push('The raw gyro output is necessary for control tuning.');
    if (best.model.collectiveField !== 'mixer[3]') result.controlReasons.push('The measured collective mixer output is necessary for control tuning.');
    if (supported.length < 2) result.controlReasons.push('The pilot input does not give model checks at two frequencies on all axes.');
    if (result.status !== 'validated') result.controlReasons.push('The helicopter model did not agree with the test-log checks.');
    result.model.validation = { status: result.status, controlEligible: result.controlEligible, split: result.validation.split,
        axes: result.validation.test.axes, controlledAxes: result.validation.test.controlledAxes, controlBandHz: rules.controlBandHz,
        frequency: result.validation.frequency, reasons: result.reasons, controlReasons: result.controlReasons, externalAircraft: false };
    return result;
}

module.exports = { RULES, EXTRA, prepareSegments, splitSegments, inputCondition, analysisFilter, fit, evaluate, frequencyValidation, accuracyConfidence, metadata };
