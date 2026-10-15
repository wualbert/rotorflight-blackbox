'use strict';

// Data selection and identification of the six-degree-of-freedom digital twin (heli_twin.cjs, twin_fit.cjs).
// prepareSegments selects the usable flight periods, splitSegments reserves whole flights for the test, and fit()
// identifies the twin on the fit and selection flights and tests the frozen twin on the reserved flights.
const T = require('./heli_twin.cjs');
const F = require('./twin_fit.cjs');
const { craftPrior } = require('./helicopter_model.cjs');
const AXES = ['roll', 'pitch', 'yaw'];
const finite = x => typeof x === 'number' && Number.isFinite(x);
// Data selection limits, then the twin limits. twin: rules for twin_fit (prediction origins every originEveryS,
// which sets the compute time of each model evaluation). stageIterations: the maximum iterations of each fit stage
// (the app runs in one worker thread, see DEVELOPMENT.md). minFrequencyGroupS: the minimum flight time of one PID
// profile for its frequency response (minTestFrequencyGroupS: the same on the test flights). minConfidenceGroups: test flights (or log groups) for high confidence.
const RULES = Object.freeze({ minWindowS: 8, windowS: 16, settlingS: 1,
    minInputStd: 0.004, minOutputStd: 3, minPilotStd: 5, maxInputCondition: 1000, maxSampleJitter: 0.15,
    maxWindowsPerFlight: 4, controlBandHz: 20,
    twin: Object.freeze({ originEveryS: 1 }),
    // one entry for each stage of twin_fit.STAGES (test/system_id.test.cjs), and a default for a new stage. With these limits
    // the fit of 9 Fireball logs (analysis/twin6dof/data/fireball) takes about 4 min in one thread.
    stageIterations: Object.freeze({ 'rotor speed': 15, vertical: 15, frequency: 60, 'short-horizon joint': 20, 'rotor speed again': 10, 'yaw trim': 25, default: 4 }),
    minFrequencyGroupS: 40, minTestFrequencyGroupS: 30, minConfidenceGroups: 3,
    source: 'Model check limits. These limits do not show that flight is safe.' });
// Log fields of the twin: the gyro (gyroADC is always in the log), the inputs and the slow sensors.
const EXTRA = ['gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]', 'mixer[3]', 'time', 'attitude[0]', 'attitude[1]', 'attitude[2]',
    'altitude', 'vario', 'Vbat', 'motor[0]'];
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
function itemConfiguration(item) { return item.configuration || item.dataset || item.ctx && item.ctx.configuration || null; }

// Source bytes and the source-local log number identify a capture, not an
// independently armed flight. Calendar values never override verified bytes.
function verifiedCapture(item) {
    const source = item.source || {}, file = source.file, w = item.w || item;
    if (!file || file.verifiedBytes !== true) return null;
    const indexes = [source.logIndex, w.flight && w.flight.log,
        w.recordedConfiguration && w.recordedConfiguration.interval && w.recordedConfiguration.interval.log].filter(v => v !== undefined && v !== null);
    if (!/^[a-f0-9]{64}$/i.test(file.sha256 || '') || !Number.isInteger(file.logOffset) || file.logOffset < 0 ||
        !Number.isInteger(file.logs) || file.logs < 1 || indexes.some(v => !Number.isInteger(v)) || new Set(indexes).size > 1)
        return { error: 'The source file information does not agree with the log numbers.' };
    const localLogIndex = source.localLogIndex === undefined || source.localLogIndex === null ?
        (indexes.length ? indexes[0] - file.logOffset : null) : source.localLogIndex;
    if (!Number.isInteger(localLogIndex) || localLogIndex < 0 || localLogIndex >= file.logs ||
        indexes.some(v => v !== file.logOffset + localLogIndex))
        return { error: 'The source file information does not agree with the log numbers.' };
    const sha256 = file.sha256.toLowerCase();
    return { id: `source:${sha256}:log:${localLogIndex}`, sourceSha256: sha256, localLogIndex,
        basis: 'verified-source-sha256-and-local-log-index', calendarTrusted: false,
        evidence: 'capture-group-only', physicalFlightIndependenceProven: false };
}

function inputIdentities(items) {
    const captures = items.map(verifiedCapture), active = items.map(item => {
        const w = item.w || item, ctx = item.ctx || {}, mask = item.mask || ctx.eligible || ctx.flying;
        return !!(w.n && mask && mask.some(v => !!v));
    }), hashes = [...new Set(captures.filter((capture, i) => active[i] && capture && !capture.error).map(capture => capture.sourceSha256))],
        unresolved = hashes.length > 1 || hashes.length > 0 && captures.some((capture, i) => active[i] && !capture);
    return { unresolved, hashes, identities: items.map((item, index) => {
        const w = item.w || item, legacy = flightIdentity(w, index), capture = captures[index];
        if (!capture || capture.error) return { ...legacy, calendarTrusted: false, evidence: 'legacy-unverified-identity',
            sourceGroupingUnresolved: unresolved, error: capture && capture.error };
        return { ...capture, id: unresolved ? legacy.id : capture.id, capture: capture.id,
            recordedStart: w.flight && w.flight.start || null, sourceGroupingUnresolved: unresolved,
            ...(unresolved ? { basis: 'unresolved-source-cohort-legacy-deduplication', legacyIdentity: legacy } : {}) };
    }) };
}

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
    if (segments.some(s => ['unconfirmed-start-conservative-group', 'capture-id-without-confirmed-start'].includes(s.source.flightIdentity.basis)))
        limitations.push('Some logs have no recorded start time. These logs cannot show which samples came from the same flight.');
    if (segments.some(s => s.source.flightIdentity.evidence === 'capture-group-only'))
        limitations.push('Source file data identifies log groups. These groups do not show that the helicopter was armed for different flights.');
    if (segments.some(s => s.source.flightIdentity.sourceGroupingUnresolved))
        limitations.push('The app cannot make sure that these source files contain different flights.');
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
    const identityContext = inputIdentities(items), segments = [], excluded = [], reasons = [], count = new Map(); let inputSamples = 0;
    if (identityContext.unresolved) reasons.push('The app cannot make sure that these source files contain different flights.');
    const addExcluded = (w, index, start, end, reason) => {
        const rate = items[index].ctx && items[index].ctx.rate || w.flight && w.flight.actualRate || w.rate;
        excluded.push({ flight: identityContext.identities[index].id, configuration: itemConfiguration(items[index]),
            fromS: (w.fromS || 0) + start / rate, toS: (w.fromS || 0) + end / rate, samples: end - start, reason });
    };
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        const item = items[itemIndex], w = item.w || item, ctx = item.ctx || {}, n = w.n || 0,
            rate = ctx.rate || w.flight && w.flight.actualRate || w.rate;
        inputSamples += n;
        if (identityContext.identities[itemIndex].error) {
            reasons.push(identityContext.identities[itemIndex].error); addExcluded(w, itemIndex, 0, n, 'source-capture-identity-conflict'); continue;
        }
        if (!finite(rate) || rate < 25 || rate > 32000 || n < 2) { reasons.push('The log sample rate is not correct.'); continue; }
        // the twin fits the filtered gyro (gyroADC): the selection checks the same signal
        const output = 'gyroADC', y = w.gyro;
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
                const end = Math.min(at, begin + window), id = identityContext.identities[itemIndex].id, previous = count.get(id) || 0;
                if (end - begin < rules.minWindowS * rate) { addExcluded(w, itemIndex, begin, end, 'short-interval'); continue; }
                const cut = x => slice(x, begin, end), inputStd = w.u.map(x => sampledStats(cut(x)).std);
                if (inputStd.every(x => x < rules.minInputStd)) { addExcluded(w, itemIndex, begin, end, 'insufficient-axis-excitation'); continue; }
                const pilotStd = w.sp.map(x => sampledStats(cut(x)).std);
                if (pilotStd.every(x => x < rules.minPilotStd)) { addExcluded(w, itemIndex, begin, end, 'insufficient-pilot-excitation'); continue; }
                const identity = identityContext.identities[itemIndex], clockKnown = timestamps && finite(timestamps[begin]) && finite(timestamps[end - 1]);
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
    // the twin includes the gyro filter of the log: all periods must have the same gyro filter values
    const filterKeys = new Set(segments.map(s => gyroFilterKey(headerOf(input, s))));
    if (filterKeys.size > 1) reasons.push('The logs have different gyro filter values. The model must use one gyro filter configuration.');
    if (segments.some(s => Math.abs(s.rate / segments[0].rate - 1) > 0.01)) reasons.push('The logs have different sample rates.');
    if (segments.some(s => s.collectiveField !== segments[0].collectiveField)) reasons.push('The logs have different collective input fields.');
    return { segments, reasons, coverage: { inputSamples, usedSamples: segments.reduce((a, s) => a + s.n, 0),
        intervals: segments.map(metadata), excluded, craftNames, configurations,
        deduplication: { duplicateWindows: deduplicated.duplicates, overlappingWindows: deduplicated.overlaps,
            limitations: deduplicated.limitations, identityRule: 'verified-single-source-captures-with-conservative-legacy-fallback',
            sourceHashes: identityContext.hashes, sourceGroupingUnresolved: identityContext.unresolved } } };
}

function metadata(s) { return { id: s.id, flight: s.flight, configuration: s.configuration, profile: s.profile,
    source: s.source, recordedGains: s.recordedGains || null, fromS: s.fromS, toS: s.fromS + s.n / s.rate,
    n: s.n, rate: s.rate, output: s.output, collectiveField: s.collectiveField }; }

// The gyro filter values of a log header (the gyro filter and the sample rates). A log without a header gives {}.
function gyroFilterKey(header) {
    const keys = Object.keys(header || {}).filter(k => /^(gyro_|dyn_notch|rpm_filter|looptime$|pid_process_denom$|filter_process_denom$)/i.test(k)).sort();
    return JSON.stringify(keys.map(k => [k, header[k]]));
}

function seededRandom(seed) {
    let state = 2166136261;
    for (const c of String(seed)) state = Math.imul(state ^ c.charCodeAt(0), 16777619) >>> 0;
    if (!state) state = 1;
    return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
function splitSegments(segments, options = {}) {
    const flights = [...new Set(segments.map(s => s.flight))].sort(), unresolved = segments.some(s => s.source && s.source.flightIdentity && s.source.flightIdentity.sourceGroupingUnresolved),
        captureGroups = segments.some(s => s.source && s.source.flightIdentity && s.source.flightIdentity.evidence === 'capture-group-only'),
        groupingBasis = unresolved ? 'unresolved-source-files' : captureGroups ? 'source-capture-groups' : 'legacy-flight-identities',
        independentFlights = !unresolved && flights.length >= 3;
    const seed = String(options.seed === undefined ? `helicopter-sysid-v1:${flights.join('|')}` : options.seed), random = seededRandom(seed);
    if (unresolved) return { method: 'unresolved-source-grouping-no-holdout', independentFlights: false, seed,
        groupingBasis, physicalFlightIndependenceProven: false,
        requestedTestFraction: 0.2, actualTestFraction: 0, actualTestSampleFraction: 0, embargoS: 0,
        train: segments.slice(), selection: [], test: [], assignment: segments.map(s => ({ id: s.id, flight: s.flight, role: 'train', fromS: s.fromS, toS: s.fromS + s.n / s.rate })) };
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
    const result = { method: independentFlights ? captureGroups ? 'seeded-random-source-captures' : 'seeded-random-flights' : 'seeded-random-guarded-intervals', independentFlights, seed,
        groupingBasis, physicalFlightIndependenceProven: false,
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

// ---- twin runs ----
// Log fields that the twin must have, with the text for a log that does not record them.
const REQUIRED = [
    { fields: ['attitude[0]', 'attitude[1]', 'attitude[2]'], reason: 'The log does not record the attitude ("attitude[0]" to "attitude[2]"). The helicopter model must have it.' },
    { fields: ['motor[0]'], reason: 'The log does not record the throttle ("motor[0]"). The helicopter model must have it.' }];
// Optional fields: the barometer (altitude, vario) and the battery voltage (twin_fit.prepareRun uses a constant 1 without it).
const VBAT_LIMITATION = 'The log does not record the battery voltage. The motor torque uses the throttle only.';
function itemOf(input, s) { const item = (input.segments || [])[s.source.item]; return item && (item.w || item); }
function missingFields(input, segments) {
    const reasons = new Set();
    for (const s of segments) {
        const w = itemOf(input, s), end = s.source.start + s.n;
        for (const r of REQUIRED) if (r.fields.some(name => { const c = w && w.extra && w.extra[name]; return !c || c.length < end; })) reasons.add(r.reason);
        if (!w || !w.gyro || w.gyro.length !== 3 || w.gyro.some(c => !c || c.length < end)) reasons.add('The log does not record the gyro ("gyroADC"). The helicopter model must have it.');
    }
    return [...reasons];
}
// A log column of one period. scale converts the log unit. Measurements keep NaN (the observer skips them).
// Inputs hold the last finite value: a model input must be finite at each sample.
function column(w, name, start, n, scale, hold) {
    const c = w.extra && w.extra[name], out = new Float64Array(n).fill(NaN);
    if (!c || c.length < start + n) return out;
    let last = NaN;
    if (hold) for (let i = 0; i < n && !finite(last); i++) if (finite(c[start + i])) last = c[start + i] * scale;
    for (let i = 0; i < n; i++) { const v = c[start + i]; if (finite(v)) last = out[i] = v * scale; else if (hold) out[i] = last; }
    return out;
}
const copy = (x, n, k = 1) => { const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = x[i] * k; return o; };
// A twin run (twin_fit.cjs) of a selected period: mixer/1000, collective mixer/1000, motor[0]/1000, Vbat/100 (V),
// gyroADC (deg/s), attitude (decidegrees), altitude/100 (m), vario/100 (m/s), headspeed (RPM) and the setpoints.
function twinRun(input, s) {
    const w = itemOf(input, s), a = s.source.start, n = s.n;
    return { id: s.id, flight: s.flight, profile: s.profile, configuration: s.configuration, fromS: s.fromS, rate: s.rate, n,
        u: s.u.map(x => copy(x, n)), coll: copy(s.coll, n, 0.001), thr: column(w, 'motor[0]', a, n, 0.001, true), vbat: column(w, 'Vbat', a, n, 0.01, true),
        gyro: w.gyro.map(c => copy(c.subarray ? c.subarray(a, a + n) : c.slice(a, a + n), n)),
        att: [0, 1, 2].map(k => column(w, `attitude[${k}]`, a, n, 1)), alt: column(w, 'altitude', a, n, 0.01), vario: column(w, 'vario', a, n, 0.01),
        hs: copy(s.hs, n), sp: s.sp.map(x => copy(x, n)) };
}
// The PID profile number (1 to 6) of a period, else null (unknown).
const profileNumber = p => Number.isInteger(p) && p >= 1 && p <= 6 ? p : null;
function groupsOf(runs) {
    const groups = new Map();
    for (const r of runs) { const profile = profileNumber(r.profile), key = `profile ${profile === null ? 'unknown' : profile}`;
        if (!groups.has(key)) groups.set(key, { key, profile, runs: [] }); groups.get(key).runs.push(r); }
    return [...groups.values()];
}
// A frequency group of twin_fit (key 'profile N') with its PID profile number (null when unknown).
const withProfile = g => { const m = /^profile (\d)$/.exec(g.key); return Object.assign({}, g, { profile: m ? +m[1] : null }); };
function range(runs, get) {
    let lo = Infinity, hi = -Infinity;
    for (const r of runs) { const c = get(r); for (let i = 0; i < r.n; i++) if (finite(c[i])) { lo = Math.min(lo, c[i]); hi = Math.max(hi, c[i]); } }
    return lo <= hi ? [lo, hi] : null;
}
function envelope(runs) {
    return { rpm: range(runs, r => r.hs), collective: range(runs, r => r.coll), throttle: range(runs, r => r.thr), vbat: range(runs, r => r.vbat),
        input: [0, 1, 2].map(a => range(runs, r => r.u[a])), bodyRate: [0, 1, 2].map(a => range(runs, r => r.gyro[a])),
        units: { rpm: 'RPM', collective: 'mixer[3]/1000', throttle: 'motor[0]/1000', vbat: 'V', input: 'mixer/1000', bodyRate: 'deg/s' } };
}
function median(x) { const s = Float64Array.from(x).sort(); return s.length ? s[s.length >> 1] : NaN; }
function headerOf(input, s) { const item = (input.segments || [])[s.source.item] || {}, w = item.w || item; return item.ctx && item.ctx.header || w.originalHeader || w.flight && w.flight.header || {}; }
const plainPrediction = p => p && { points: p.points, channels: p.channels, units: p.units, rmse: p.rmse, persistence: p.persistence, samples: p.samples, origins: p.origins };

// STE reasons of the reserved-flight assessment, one policy with twin_fit.assess: the checks of each axis that does not
// pass (assess.axes). A check with gating false (the open-loop yaw rate) is shown, but it is not a reason.
// prediction: validation.prediction (for the attitude errors). Returns [{ axis, text }].
function assessmentReasons(a, prediction) {
    const out = [], name = axis => axis[0].toUpperCase() + axis.slice(1), ka = a.check.attitudePoint;
    const k = prediction && prediction.points ? prediction.points.indexOf(ka) : -1;
    (a.axes || []).forEach(({ axis, pass }, i) => {
        if (pass) return;
        const p = a.prediction[i], f = a.frequency[i], add = text => out.push({ axis, text: `${name(axis)}: ${text}` });
        if (p && !p.pass && p.gating !== false) add(`the model rate error after ${p.horizonS} s is not less than ${Math.round(a.check.rateSkill * 100)}% of the error of the last measured rate.`);
        if (i < 2 && k >= 0 && !(prediction.rmse[3 + i][k] <= prediction.persistence[3 + i][k]))
            add(`the model attitude error after ${ka} s is more than the error of the last measured attitude.`);
        if (f && !f.measured) add(`the pilot inputs do not measure the frequency response at ${a.check.minBins} frequencies.`);
        else if (f && !f.pass) add('the model frequency response does not agree with the test flights.');
    });
    return out;
}

// Identification of the twin. Returns a Promise of the result (see DEVELOPMENT.md section 13 for the twin contract).
// options: { rules, seed, stages (twin_fit stages, else twin_fit.STAGES with rules.stageIterations), progress(stage, k, n), log }.
// heli_twin.observerGains keeps the observer gains of each model and sample interval (no cache here).
async function fit(input = {}) {
    const started = Date.now(), options = input.options || {}, rules = Object.assign({}, RULES, options.rules), prepared = prepareSegments(input),
        split = splitSegments(prepared.segments, options), twinRules = Object.assign({}, F.RULES, rules.twin);
    const result = { version: 2, kind: T.KIND, status: 'rejected', eligibleSteps: [], axes: [], controlEligible: false, controlReasons: [], model: null, ensemble: [], coverage: prepared.coverage,
        confidence: { level: 'unavailable', reasons: ['The model has no test flight result.'] },
        reasons: prepared.reasons.slice(), limitations: [], rules: JSON.parse(JSON.stringify(rules)), validation: { split: { method: split.method, independentFlights: split.independentFlights, seed: split.seed,
            groupingBasis: split.groupingBasis, physicalFlightIndependenceProven: split.physicalFlightIndependenceProven,
            requestedTestFraction: split.requestedTestFraction, actualTestFraction: split.actualTestFraction, actualTestSampleFraction: split.actualTestSampleFraction,
            embargoS: split.embargoS, assignment: split.assignment,
            train: split.train.map(metadata), selection: split.selection.map(metadata), test: split.test.map(metadata) } }, predictions: [] };
    if (options.keepSegments) result.segments = split;
    const refuse = reason => { if (reason) result.reasons.push(reason); result.controlReasons.push('The helicopter model did not agree with the test-log checks.'); return result; };
    if (result.reasons.length) return refuse();
    if (!split.train.length || !split.selection.length || !split.test.length) return refuse('Different fit, selection and test intervals are necessary.');
    const condition = inputCondition(split.train); result.validation.inputCondition = condition;
    if (!finite(condition) || condition > rules.maxInputCondition) return refuse('The control inputs do not identify three different axes.');
    const pilotCondition = inputCondition(split.train.map(s => Object.assign({}, s, { u: s.sp })));
    result.validation.pilotCondition = pilotCondition;
    if (!finite(pilotCondition) || pilotCondition > rules.maxInputCondition) return refuse('The pilot inputs do not identify three different axes.');
    const design = split.train.concat(split.selection), missing = missingFields(input, design.concat(split.test));
    if (missing.length) { result.reasons.push(...missing); return refuse(); }
    // The selection flights are fit data here: twin_fit selects no model structure. The test flights stay reserved.
    const trainRuns = design.map(s => F.prepareRun(twinRun(input, s), twinRules)), testRuns = split.test.map(s => F.prepareRun(twinRun(input, s), twinRules));
    // The battery voltage is optional. If a period does not record it, all periods use the constant 1 of
    // twin_fit.prepareRun, so that the motor torque gain has one unit (per throttle unit, not per volt).
    const vbatRecorded = trainRuns.concat(testRuns).every(r => r.vbatRecorded !== false);
    if (!vbatRecorded) { for (const r of trainRuns.concat(testRuns)) { r.vbat = new Float64Array(r.n).fill(1); r.vbatRecorded = false; } result.limitations.push(VBAT_LIMITATION); }
    const craft = input.craft || design[0].craft, prior = craftPrior(craft), refRpm = median(trainRuns.flatMap(r => Array.from(r.hs.filter(finite))));
    const header = headerOf(input, design[0]), gyroLowpassHz = header.gyro_lowpass2_hz || header.gyro_lowpass_hz || 0;
    const collectiveField = design[0].collectiveField;
    const baseStages = options.stages || F.STAGES, stages = options.stages ? baseStages :
        baseStages.map(st => { const limits = rules.stageIterations || {}, limit = finite(limits[st.name]) ? limits[st.name] : finite(limits.default) ? limits.default : st.iterations;
            return Object.assign({}, st, { iterations: Math.min(st.iterations, limit) }); });
    let identified, validation;
    try {
        identified = await F.identify({ train: trainRuns, groupsTrain: groupsOf(trainRuns), craftPrior: prior, refRpm: finite(refRpm) && refRpm >= 500 ? refRpm : undefined,
            constants: { gyroLowpassHz: finite(gyroLowpassHz) ? gyroLowpassHz : 0 }, rules: rules.twin, stages, minGroupS: rules.minFrequencyGroupS,
            progress: options.progress, log: options.log });
    } catch (error) {
        result.validation.error = String(error && error.message || error);
        return refuse(/frequency responses/.test(result.validation.error) ?
            `Each PID profile has less than ${rules.minFrequencyGroupS} s of fit flight data with pilot inputs. The frequency response must have more data.` :
            'The model does not stay stable on the fit flights.');
    }
    const model = identified.model;
    Object.assign(model, { output: 'gyroADC', collectiveField, vbatRecorded, rate: trainRuns[0].rate, analysisFilterHz: rules.controlBandHz, envelope: envelope(trainRuns),
        identity: { craft: prior.craft || craft, trainingFlights: [...new Set(design.map(s => s.flight))], configuration: input.targetConfiguration || design[0].configuration,
            configurations: prepared.coverage.configurations, sourceIntervals: design.map(metadata) },
        fit: { method: 'prediction-error method with setpoint-instrumented frequency responses (twin_fit.identify)', stages: identified.history,
            rules: JSON.parse(JSON.stringify(twinRules)), initialState: 'steady-state observer with the recorded measurements before each origin',
            inertiaPrior: prior.inertia ? prior.kind : 'no-geometry-prior' } });
    if (!prior.inertia) result.limitations.push('The helicopter dimensions are unknown. The model uses the inertia of a small helicopter.');
    result.model = model; result.ensemble = [model];
    // the instrumented responses of the fit data: control_pipeline uses them again in the closed-loop refinement
    result.frdTrain = identified.frdTrain;
    if (options.progress) options.progress('test', stages.length, stages.length);
    result.dataReasons = result.reasons.slice();
    return judge(result, model, { trainRuns, testRuns, split, rules, twinRules, collectiveField, history: identified.history, frdTrain: identified.frdTrain, started });
}

// The reserved-flight checks of a frozen model (fit, and retest after a later refinement). It sets the validation, the
// predictions, the status, the eligible steps, the confidence and the control reasons of result.
function judge(result, model, ctx) {
    const { trainRuns, testRuns, split, rules, twinRules, collectiveField } = ctx;
    let validation;
    const fitProfiles = new Set(trainRuns.map(r => r.profile)), newProfiles = [...new Set(testRuns.map(r => r.profile).filter(p => !fitProfiles.has(p)))];
    if (newProfiles.length && newProfiles.every(p => p > 0)) result.limitations.push(`The test flights use PID profile ${newProfiles.join(', ')}. The fit flights do not use this PID profile.`);
    result.limitations = [...new Set(result.limitations)];
    const refuse = reason => { if (reason) result.reasons.push(reason); result.status = 'rejected'; result.eligibleSteps = []; result.controlEligible = false;
        result.controlReasons.push('The helicopter model did not agree with the test-log checks.'); return result; };
    // the same origins as the fit (twinRules) and as control_pipeline.replayTwin (model.fit.rules)
    try { validation = F.validate(model, testRuns, groupsOf(testRuns), { rules: twinRules, traces: { horizonS: 1, decimateTo: 100 }, minGroupS: rules.minTestFrequencyGroupS }); }
    catch (error) { result.validation.error = String(error && error.message || error); return refuse('The model is not stable on the test flights.'); }
    const assessment = F.assess(validation);
    let training = null;
    try { training = plainPrediction(F.predictionErrors(model, trainRuns, { rules: twinRules })); } catch (error) { training = { error: String(error.message) }; }
    Object.assign(result.validation, { prediction: plainPrediction(validation.prediction), frequency: validation.frequency.map(withProfile), assessment,
        training: { prediction: training }, history: ctx.history,
        frequencyTrain: ctx.frdTrain.map(g => withProfile({ key: g.key, seconds: g.seconds, op: g.op })),
        runs: { train: trainRuns.length, test: testRuns.length, trainS: trainRuns.reduce((s, r) => s + r.n / r.rate, 0), testS: testRuns.reduce((s, r) => s + r.n / r.rate, 0) } });
    result.predictions = (validation.prediction.traces || []).map((t, k) => {
        const run = testRuns[k], stride = Math.max(1, Math.round(run.rate / 100)), pick = a => { const o = []; for (let i = 0; i < run.n; i += stride) o.push(finite(a[i]) ? +a[i].toFixed(4) : null); return o; };
        return Object.assign({}, t, { fromS: run.fromS, configuration: run.configuration, profile: profileNumber(run.profile),
            inputs: Object.assign({}, t.inputs, { vbat: pick(run.vbat), sp: run.sp.map(pick) }) });
    });
    // One policy with twin_fit.assess: the status of assess ('validated', 'partial' or 'rejected') and the reasons of
    // the axes that do not pass. A data reason (found before the assessment) rejects the model.
    // 'partial': some axes agree. Control changes are available only for the steps of those axes (eligibleSteps).
    const dataReasons = (result.dataReasons || result.reasons).slice(), axisReasons = assessmentReasons(assessment, validation.prediction);
    result.reasons.push(...axisReasons.map(r => r.text).filter(r => !result.reasons.includes(r)));
    result.status = dataReasons.length ? 'rejected' : assessment.status;
    result.eligibleSteps = result.status === 'rejected' ? [] : assessment.eligibleSteps.slice();
    result.axes = assessment.axes.map(a => ({ axis: a.axis, pass: a.pass, reasons: axisReasons.filter(r => r.axis === a.axis).map(r => r.text) }));
    const testGroups = split.independentFlights ? new Set(split.test.map(s => s.flight)).size : 0;
    const captureGroups = split.groupingBasis === 'source-capture-groups';
    const level = result.status === 'rejected' ? 'low' : result.status === 'partial' ? 'moderate' : testGroups >= rules.minConfidenceGroups ? 'high' : 'moderate', reasons = [];
    if (captureGroups) reasons.push('The checks use source log groups. These groups do not show that the helicopter was armed for different flights.');
    if (level === 'high') reasons.push(captureGroups ? `The model agrees with the checks in ${testGroups} different test log groups.` : `The model agrees with the checks in ${testGroups} different test flights.`);
    else if (result.status === 'partial') reasons.push(`The model agrees with the checks for these axes only: ${result.axes.filter(a => a.pass).map(a => a.axis).join(', ')}.`);
    else if (level === 'moderate') reasons.push(split.independentFlights ? `The model agrees with the checks. For a high level, ${rules.minConfidenceGroups} different test ${captureGroups ? 'log groups' : 'flights'} are necessary.` :
        'The model agrees with the checks, but the test periods are from the fit flights.');
    else reasons.push('The model does not agree with the checks on the test flights.');
    result.confidence = { level, reasons, testGroups, groupingBasis: split.groupingBasis || 'legacy-flight-identities', physicalFlightIndependenceProven: false,
        assessment: { status: assessment.status, axes: result.axes, eligibleSteps: assessment.eligibleSteps, prediction: assessment.prediction,
            frequency: assessment.frequency.map(f => Object.assign({}, f, { rows: undefined })) },
        confidenceMeaning: 'reserved-flight prediction and frequency checks, not the probability that the model is correct' };
    result.controlEligible = result.status !== 'rejected' && split.independentFlights && collectiveField === 'mixer[3]';
    if (!split.independentFlights) result.controlReasons.push('Three different flight logs are necessary for control tuning.');
    if (collectiveField !== 'mixer[3]') result.controlReasons.push('The measured collective mixer output is necessary for control tuning.');
    if (result.status === 'rejected') result.controlReasons.push('The helicopter model did not agree with the test-log checks.');
    model.confidence = { level, reasons };
    model.validation = { status: result.status, eligibleSteps: result.eligibleSteps, controlEligible: result.controlEligible, split: result.validation.split, prediction: result.validation.prediction,
        assessment: { status: assessment.status, axes: result.axes, eligibleSteps: assessment.eligibleSteps, prediction: assessment.prediction, frequency: result.confidence.assessment.frequency, check: assessment.check },
        reasons: result.reasons.slice(), controlReasons: result.controlReasons.slice(), externalAircraft: false };
    if (ctx.started) result.validation.runtimeS = (Date.now() - ctx.started) / 1000;
    return result;
}

// The reserved-flight checks again for a refined model (control_pipeline: the closed-loop refinement on the fit flights).
// input: the fit input; fitted: the fit result of the same input (options.keepSegments). The data selection, the split
// and the fit data stay the same. Returns a new result object with the checks of model (the fit result does not change).
function retest(input, fitted, model) {
    if (!fitted || !fitted.segments || !fitted.model) throw new Error('The model fit has no saved periods.');
    const split = fitted.segments, rules = Object.assign({}, RULES, fitted.rules), twinRules = Object.assign({}, F.RULES, rules.twin);
    const design = split.train.concat(split.selection), constant = model.vbatRecorded === false;
    const runs = list => list.map(s => { const r = F.prepareRun(twinRun(input, s), twinRules); if (constant) { r.vbat = new Float64Array(r.n).fill(1); r.vbatRecorded = false; } return r; });
    const result = Object.assign({}, fitted, { model, ensemble: [model], reasons: (fitted.dataReasons || []).slice(), dataReasons: (fitted.dataReasons || []).slice(),
        limitations: fitted.limitations.filter(t => !/^The test flights use PID profile/.test(t)), controlReasons: [],
        validation: Object.assign({}, fitted.validation), predictions: [] });
    return judge(result, model, { trainRuns: runs(design), testRuns: runs(split.test), split, rules, twinRules, collectiveField: design[0].collectiveField,
        history: (fitted.validation.history || []).concat(model.fit && model.fit.closedLoop ? model.fit.closedLoop.stages || [] : []), frdTrain: fitted.frdTrain || [] });
}

module.exports = { RULES, EXTRA, REQUIRED, VBAT_LIMITATION, prepareSegments, splitSegments, inputCondition, analysisFilter, fit, retest, judge, twinRun, missingFields, groupsOf, envelope, metadata, assessmentReasons, profileNumber, gyroFilterKey };
if (require.main !== module) return;
