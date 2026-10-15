'use strict';

// Replay a saved six-degree-of-freedom twin (control_pipeline.makeTwin, version 2) against recorded periods, with no
// refitting. The observer uses the measurements up to each prediction origin. No measurement after an origin enters
// its prediction. Without an input file, use the reserved test periods saved in the twin (about 100 Hz). The replay then
// holds each recorded input to the next recorded sample, uses the measurements and the scores only at the recorded
// samples and puts each origin on a recorded sample (control_pipeline.replayRun and replayRules). Its result is near,
// but not equal to, the saved predictions. The origins and the score points are the fit rules of the twin.
const pipeline = require('./control_pipeline.cjs');

// The saved reserved periods (twin.predictions, from twin_fit.trace) as replay runs (twin_fit.cjs run format).
function scenarios(twin) {
    return (twin.predictions || []).filter(p => p && p.measured && p.inputs && p.raw).map(p => ({ id: p.id, flight: p.flight, fromS: p.fromS, rate: p.rate,
        n: p.measured[0].length, u: p.inputs.u, coll: p.inputs.coll, thr: p.inputs.thr, vbat: p.inputs.vbat, sp: p.inputs.sp, gyro: p.raw.gyro,
        att: [3, 4, 5].map(ch => p.measured[ch].map(v => v === null ? null : v * 10)), alt: p.measured[6], vario: p.measured[7], hs: p.measured[8] }));
}
function replay(twin, runs = scenarios(twin)) {
    if (!runs.length) throw new Error('The model has no saved test input. Supply a segment file.');
    const predictions = pipeline.replayTwin(twin, runs);
    return { schema: 'rotorflight-digital-twin-replay', version: 2, modelId: twin.id, modelKind: twin.model && twin.model.kind,
        modelStatus: twin.status, controlEligible: twin.controlEligible === true, controlReasons: twin.controlReasons || [],
        requireKnownGains: !(twin.source && twin.source.requireKnownGains === false), refitted: false,
        // the saved model includes the closed-loop refinement of control_pipeline.tune when it was applied
        closedLoopRefined: !!(twin.validation && twin.validation.closedLoopFit && twin.validation.closedLoopFit.applied),
        measuredStateInjection: 'observer with the measurements up to each prediction origin; no measurement after the origin',
        predictions };
}

module.exports = { scenarios, replay };
if (require.main !== module) return;
const fs = require('node:fs');
const [modelFile, outputFile, segmentFile] = process.argv.slice(2);
if (!modelFile || !outputFile || modelFile === '--help') {
    process.stdout.write('Usage: node tools/autotune/twin_replay.cjs <model.json> <replay.json> [runs.json]\n' +
        'runs.json: [{ id, rate, n, u[3], coll, thr, vbat, gyro[3], att[3], alt, vario, hs }] (twin_fit.cjs run format, log units of the twin;\n' +
        '  alt and vario are optional, vbat is optional for a model without the battery voltage)\n');
    process.exitCode = modelFile === '--help' ? 0 : 2;
} else {
    try {
        const twin = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
        const runs = segmentFile ? JSON.parse(fs.readFileSync(segmentFile, 'utf8')) : undefined;
        fs.writeFileSync(outputFile, JSON.stringify(replay(twin, runs), (key, value) =>
            ArrayBuffer.isView(value) ? Array.from(value) : value, 2) + '\n');
        process.stdout.write('Saved frozen-model replay: ' + outputFile + '\n');
    } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
