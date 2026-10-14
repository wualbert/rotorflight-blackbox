'use strict';

// Replay a saved aircraft model from real actuator inputs, with no refitting.
// Without an input file, use the reserved scenarios embedded in the artifact.
const pipeline = require('./control_pipeline.cjs');
const ID = require('./system_id.cjs');

function scenarios(twin) {
    return (twin.predictions || []).map(p => Object.assign({}, p, p.inputs, {
        n: p.measured[0].length, y: p.measured
    }));
}
function replay(twin, segments = scenarios(twin)) {
    if (!segments.length) throw new Error('The model has no saved test input. Supply a segment file.');
    for (const s of segments) {
        if (!(s.rate > 0) || !Number.isInteger(s.n) || s.n < 2 ||
            ![...(s.u || []), ...(s.y || []), s.hs, s.coll].every(x => x && x.length === s.n) ||
            !s.u || s.u.length !== 3 || !s.y || s.y.length !== 3)
            throw new Error('A replay segment needs three input and output columns, headspeed, collective, rate and sample count.');
    }
    const predictions = pipeline.replayTwin(twin, segments);
    return { schema: 'rotorflight-digital-twin-replay', version: 1, modelId: twin.id,
        modelStatus: twin.status, controlEligible:twin.controlEligible===true,controlReasons:twin.controlReasons||[],
        requireKnownGains:!(twin.source&&twin.source.requireKnownGains===false),refitted: false, measuredStateInjection: 'first-sample-only',
        validation: ID.evaluate(twin.model, segments), predictions };
}

module.exports = { scenarios, replay };
if (require.main !== module) return;
const fs = require('node:fs');
const [modelFile, outputFile, segmentFile] = process.argv.slice(2);
if (!modelFile || !outputFile || modelFile === '--help') {
    process.stdout.write('Usage: node tools/autotune/twin_replay.cjs <model.json> <replay.json> [segments.json]\n');
    process.exitCode = modelFile === '--help' ? 0 : 2;
} else {
    try {
        const twin = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
        const segments = segmentFile ? JSON.parse(fs.readFileSync(segmentFile, 'utf8')) : undefined;
        fs.writeFileSync(outputFile, JSON.stringify(replay(twin, segments), (key, value) =>
            ArrayBuffer.isView(value) ? Array.from(value) : value, 2) + '\n');
        process.stdout.write('Saved frozen-model replay: ' + outputFile + '\n');
    } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
